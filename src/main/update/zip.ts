// src/main/update/zip.ts - minimal, refusing ZIP extractor for the v5 update zip (owner v5 W2). No zip library exists in the
// tree and none may be added: central-directory parse + zlib.inflateRawSync, methods 0 (stored) and 8 (deflate) only.
// Every entry is checked BEFORE a byte is written (paths, symlinks, sizes, limits); data is checked as it is written (CRC-32,
// exact size). Any refusal removes the destination it created, so a caller never sees a half-extracted tree.
// The archive is the sha256-verified asset of a release, so these checks are defence in depth, not the trust root.
// Small entries are inflated in memory (inflateRawSync with maxOutputLength); entries above `streamAboveBytes` (8 MiB; the
// ~190 MB exe, app.asar, the vendor binaries) are streamed file -> inflate -> size/CRC check -> file in 64 KiB chunks, so the
// main process never holds a whole large entry and never blocks on one inflate call.
// All file access goes through fsReal (Electron's `original-fs`): the asar patch turns `open('...\resources\app.asar', 'wx')`
// into "open the archive" and fails (found by the v5 e2e).
import path from 'node:path';
import { realFs, realFsp as fsp, type FileHandle } from './fsReal';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 as zlibCrc32, createInflateRaw, inflateRawSync } from 'node:zlib';

export type ZipErrorReason =
  | 'not_a_zip'
  | 'corrupt'
  | 'empty'
  | 'dest_exists'
  | 'unsafe_path'
  | 'symlink'
  | 'encrypted'
  | 'unsupported_method'
  | 'duplicate_entry'
  | 'header_mismatch'
  | 'bad_directory_entry'
  | 'too_many_entries'
  | 'too_large'
  | 'size_mismatch'
  | 'crc_mismatch';

export class ZipError extends Error {
  readonly reason: ZipErrorReason;
  constructor(reason: ZipErrorReason) {
    super(`zip_${reason}`);
    this.name = 'ZipError';
    this.reason = reason;
  }
}

export interface ZipLimits {
  maxEntries: number;
  /** Sum of the declared uncompressed sizes. */
  maxTotalBytes: number;
  maxEntryBytes: number;
  /** Entries whose declared size is above this are streamed to disk instead of inflated in memory (default 8 MiB). */
  streamAboveBytes?: number;
}
export const ZIP_STREAM_ABOVE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 20_000,
  maxTotalBytes: 3 * 1024 * 1024 * 1024,
  maxEntryBytes: 1024 * 1024 * 1024,
};

export interface ZipExtractResult {
  files: number;
  dirs: number;
  bytes: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// CRC-32 (IEEE 802.3, the ZIP polynomial)
// ---------------------------------------------------------------------------------------------------------------------
const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// entry names
// ---------------------------------------------------------------------------------------------------------------------
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(\..*)?$/i;
const BAD_CHARS = /[\u0000-\u001f<>:"|?*]/;

/**
 * The safe relative path segments of an entry name, or null. Both `/` and `\` separate (Windows PowerShell 5.1's
 * Compress-Archive writes backslashes). Refused: empty names, absolute / drive / UNC paths, `.` and `..` segments, empty
 * segments, `:` (drive letters and NTFS alternate data streams), control and Windows-invalid characters, segments ending in
 * a dot or a space (Windows strips those - `.. ` would become `..`), and reserved device names (CON, NUL, COM1 ...).
 * A single trailing separator (a directory entry) is allowed and dropped.
 */
export function safeEntrySegments(name: string): string[] | null {
  if (name.length === 0 || name.length > 1024) return null;
  let s = name.replace(/\\/g, '/');
  if (s.startsWith('/')) return null;
  if (s.endsWith('/')) s = s.slice(0, -1);
  if (s.length === 0) return null;
  const segs = s.split('/');
  for (const seg of segs) {
    if (seg === '' || seg === '.' || seg === '..') return null;
    if (BAD_CHARS.test(seg)) return null;
    if (seg.endsWith('.') || seg.endsWith(' ')) return null;
    if (RESERVED_DEVICE.test(seg)) return null;
  }
  return segs;
}

// ---------------------------------------------------------------------------------------------------------------------
// central directory
// ---------------------------------------------------------------------------------------------------------------------
interface CentralEntry {
  rawName: Buffer;
  segments: string[];
  isDir: boolean;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done);
    if (bytesRead === 0) throw new ZipError('corrupt');
    done += bytesRead;
  }
  return buf;
}

/** Zip64 extended-information extra field (0x0001): replaces the 32-bit fields that are 0xFFFFFFFF, in order. */
function applyZip64(extra: Buffer, e: { size: number; compressedSize: number; localOffset: number }): void {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    if (p + 4 + len > extra.length) throw new ZipError('corrupt');
    if (id === 0x0001) {
      let q = p + 4;
      const next = (): number => {
        if (q + 8 > p + 4 + len) throw new ZipError('corrupt');
        const v = Number(extra.readBigUInt64LE(q));
        q += 8;
        return v;
      };
      if (e.size === U32_MAX) e.size = next();
      if (e.compressedSize === U32_MAX) e.compressedSize = next();
      if (e.localOffset === U32_MAX) e.localOffset = next();
      return;
    }
    p += 4 + len;
  }
}

async function readCentralDirectory(fh: FileHandle, fileSize: number, limits: ZipLimits): Promise<CentralEntry[]> {
  if (fileSize < 22) throw new ZipError('not_a_zip');
  const tailLen = Math.min(fileSize, 22 + U16_MAX);
  const tail = await readAt(fh, fileSize - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === SIG_EOCD && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new ZipError('not_a_zip');
  const eocdPos = fileSize - tailLen + eocd;
  if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) throw new ZipError('corrupt'); // multi-disk
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  let cdEnd = eocdPos;
  if (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
    // Zip64 end-of-central-directory locator sits right before the EOCD
    if (eocdPos < 20) throw new ZipError('corrupt');
    const loc = await readAt(fh, eocdPos - 20, 20);
    if (loc.readUInt32LE(0) !== SIG_EOCD64_LOCATOR) throw new ZipError('corrupt');
    const rec64Pos = Number(loc.readBigUInt64LE(8));
    if (rec64Pos + 56 > eocdPos - 20) throw new ZipError('corrupt');
    const rec = await readAt(fh, rec64Pos, 56);
    if (rec.readUInt32LE(0) !== SIG_EOCD64) throw new ZipError('corrupt');
    count = Number(rec.readBigUInt64LE(32));
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOffset = Number(rec.readBigUInt64LE(48));
    cdEnd = rec64Pos;
  }
  if (count === 0) throw new ZipError('empty');
  if (count > limits.maxEntries) throw new ZipError('too_many_entries');
  if (cdOffset + cdSize > cdEnd) throw new ZipError('corrupt');
  const cd = await readAt(fh, cdOffset, cdSize);

  const entries: CentralEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let p = 0;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError('corrupt');
    const madeBy = cd.readUInt16LE(p + 4);
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const extAttr = cd.readUInt32LE(p + 38);
    const sizes = {
      compressedSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      localOffset: cd.readUInt32LE(p + 42),
    };
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > cd.length) throw new ZipError('corrupt');
    const rawName = cd.subarray(p + 46, p + 46 + nameLen);
    applyZip64(cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), sizes);
    p = end;

    // bit 11 = UTF-8 name; otherwise CP437, which is ASCII-compatible for every name a release contains
    const name = flags & 0x0800 ? rawName.toString('utf8') : rawName.toString('latin1');
    const segments = safeEntrySegments(name);
    if (segments === null) throw new ZipError('unsafe_path');
    const unixMode = madeBy >> 8 === 3 ? (extAttr >>> 16) & 0o170000 : 0;
    if (unixMode === 0o120000 || (extAttr & 0x400) !== 0) throw new ZipError('symlink'); // S_IFLNK / FILE_ATTRIBUTE_REPARSE_POINT
    if (flags & 0x0001 || flags & 0x0040) throw new ZipError('encrypted');
    if (method !== 0 && method !== 8) throw new ZipError('unsupported_method');
    const isDir = /[\\/]$/.test(name) || unixMode === 0o040000;
    if (isDir && (sizes.size !== 0 || sizes.compressedSize > 2)) throw new ZipError('bad_directory_entry');
    if (method === 0 && sizes.compressedSize !== sizes.size) throw new ZipError('size_mismatch');
    if (sizes.size > limits.maxEntryBytes) throw new ZipError('too_large');
    total += sizes.size;
    if (total > limits.maxTotalBytes) throw new ZipError('too_large');
    // a local header + its data must lie before the central directory
    if (sizes.localOffset + 30 + sizes.compressedSize > cdOffset) throw new ZipError('corrupt');
    const key = segments.join('/').toLowerCase(); // NTFS is case-insensitive
    if (seen.has(key)) throw new ZipError('duplicate_entry');
    seen.add(key);
    entries.push({ rawName: Buffer.from(rawName), segments, isDir, flags, method, crc, ...sizes });
  }
  return entries;
}

/**
 * One large entry, streamed: the compressed bytes are read in chunks, inflated (method 8) or passed through (method 0), counted
 * against the declared size (more output than declared = a bomb -> size_mismatch at once) and CRC-checked, then written with
 * `wx`. A refusal leaves a partial file that the caller removes with the whole destination.
 */
async function streamEntry(zipPath: string, dataStart: number, e: CentralEntry, target: string): Promise<void> {
  if (e.compressedSize === 0) throw new ZipError('corrupt'); // a non-empty entry needs data
  let out = 0;
  let crc = 0;
  const check = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      out += chunk.length;
      if (out > e.size) {
        cb(new ZipError('size_mismatch'));
        return;
      }
      crc = zlibCrc32(chunk, crc);
      cb(null, chunk);
    },
  });
  const src = realFs.createReadStream(zipPath, { start: dataStart, end: dataStart + e.compressedSize - 1 });
  const dest = realFs.createWriteStream(target, { flags: 'wx' }); // never overwrite, never follow something already there
  try {
    if (e.method === 8) await pipeline(src, createInflateRaw(), check, dest);
    else await pipeline(src, check, dest);
  } catch (err) {
    if (err instanceof ZipError) throw err;
    if (typeof (err as { code?: unknown }).code === 'string' && (err as { code: string }).code.startsWith('Z_'))
      throw new ZipError('corrupt');
    throw err;
  }
  if (out !== e.size) throw new ZipError('size_mismatch');
  if (crc >>> 0 !== e.crc) throw new ZipError('crc_mismatch');
}

/**
 * Extracts `zipPath` into `destDir`, which must not exist yet (it is created, and removed again on any refusal).
 * Resolves with counts; rejects with a ZipError (or an fs error) and leaves nothing behind.
 */
export async function extractZip(
  zipPath: string,
  destDir: string,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Promise<ZipExtractResult> {
  const dest = path.resolve(destDir);
  const exists = await fsp
    .stat(dest)
    .then(() => true)
    .catch(() => false);
  if (exists) throw new ZipError('dest_exists');

  const fh = await fsp.open(zipPath, 'r');
  let created = false;
  try {
    const { size: fileSize } = await fh.stat();
    const entries = await readCentralDirectory(fh, fileSize, limits);
    await fsp.mkdir(dest, { recursive: true });
    created = true;
    const result: ZipExtractResult = { files: 0, dirs: 0, bytes: 0 };
    for (const e of entries) {
      const target = path.join(dest, ...e.segments);
      if (!target.startsWith(dest + path.sep)) throw new ZipError('unsafe_path'); // belt and braces after safeEntrySegments
      if (e.isDir) {
        await fsp.mkdir(target, { recursive: true });
        result.dirs += 1;
        continue;
      }
      const lh = await readAt(fh, e.localOffset, 30);
      if (lh.readUInt32LE(0) !== SIG_LOCAL) throw new ZipError('corrupt');
      const lNameLen = lh.readUInt16LE(26);
      const lExtraLen = lh.readUInt16LE(28);
      const lName = await readAt(fh, e.localOffset + 30, lNameLen);
      if (!lName.equals(e.rawName)) throw new ZipError('header_mismatch');
      const dataStart = e.localOffset + 30 + lNameLen + lExtraLen;
      if (dataStart + e.compressedSize > fileSize) throw new ZipError('corrupt');
      if (e.size > (limits.streamAboveBytes ?? ZIP_STREAM_ABOVE_BYTES)) {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await streamEntry(zipPath, dataStart, e, target);
        result.files += 1;
        result.bytes += e.size;
        continue;
      }
      const raw = await readAt(fh, dataStart, e.compressedSize);
      let data: Buffer;
      if (e.method === 0) data = raw;
      else {
        try {
          // maxOutputLength turns a deflate bomb (more output than declared) into a throw instead of an allocation
          data = inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) });
        } catch (err) {
          throw new ZipError(
            err instanceof RangeError || (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE'
              ? 'size_mismatch'
              : 'corrupt',
          );
        }
      }
      if (data.length !== e.size) throw new ZipError('size_mismatch');
      if (crc32(data) !== e.crc) throw new ZipError('crc_mismatch');
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, data, { flag: 'wx' }); // never overwrite, never follow something already there
      result.files += 1;
      result.bytes += data.length;
      await new Promise<void>((resolve) => setImmediate(resolve)); // let main breathe between entries
    }
    return result;
  } catch (err) {
    if (created) await fsp.rm(dest, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  } finally {
    await fh.close();
  }
}
