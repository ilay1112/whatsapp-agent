// tests/fakes/ogg-fixtures.ts - [V2] synthetic Ogg Opus generator (T2 3.6; complete in Wave 0 by V2-W0-scaffold, owner
// V2-W1-07-media-voice). RFC 3533 pages with the correct CRC, RFC 7845 `OpusHead` / `OpusTags`, and 20 ms DTX-silence
// packets. Everything is synthetic (T5/T12): no recording, no speech. Node built-ins only.
//
// The audio packet is a CELT fullband 20 ms mono frame with code 0 (TOC 0xF8) whose payload 0xFF 0xFE decodes to
// digital silence (the same packet the U-V1 opus-decoder probe decoded: 320 samples at 16 kHz, 0 errors). Ogg Opus
// granule positions always count 48 kHz samples: 960 per packet; the last granule = preSkip + total samples.
import { Readable } from 'node:stream';

export const OPUS_SILENCE_20MS: Uint8Array = Uint8Array.of(0xf8, 0xff, 0xfe);
export const SAMPLES_PER_PACKET_48K = 960;
export const PACKETS_PER_SECOND = 50;
const DEFAULT_SERIAL = 0x57434131; // 'WCA1'
const DEFAULT_PRE_SKIP = 312;
const PACKETS_PER_PAGE = 50; // 1 s per page; well under the 255-segment limit (1 lacing value per 3-byte packet)

// ---------------------------------------------------------------------------------------------------------------------
// CRC-32 of RFC 3533: polynomial 0x04C11DB7, initial 0, no reflection, no final XOR, CRC field zeroed while computing.
// ---------------------------------------------------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let b = 0; b < 8; b += 1) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();
export function oggCrc32(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]!) >>> 0;
  return crc >>> 0;
}

export interface OggPageInput {
  headerType: number; // 0x01 continued, 0x02 BOS, 0x04 EOS
  granule: bigint;
  serial: number;
  sequence: number;
  packets: Uint8Array[]; // each < 255 bytes here (one lacing value), or split with 255-runs
}
/** One Ogg page with a correct CRC. Packets >= 255 bytes get 255-lacing runs terminated by the remainder. */
export function oggPage(p: OggPageInput): Uint8Array {
  const lacing: number[] = [];
  for (const pkt of p.packets) {
    let n = pkt.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  if (lacing.length > 255) throw new Error('oggPage: more than 255 lacing values');
  const body = concat(p.packets);
  const out = new Uint8Array(27 + lacing.length + body.length);
  const dv = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53], 0); // 'OggS'
  out[4] = 0; // version
  out[5] = p.headerType;
  dv.setBigUint64(6, BigInt.asUintN(64, p.granule), true);
  dv.setUint32(14, p.serial >>> 0, true);
  dv.setUint32(18, p.sequence >>> 0, true);
  dv.setUint32(22, 0, true); // CRC placeholder
  out[26] = lacing.length;
  out.set(lacing, 27);
  out.set(body, 27 + lacing.length);
  dv.setUint32(22, oggCrc32(out), true);
  return out;
}

export interface OpusHeadInput {
  channels?: number;
  preSkip?: number;
  inputSampleRate?: number;
}
export function opusHead(h: OpusHeadInput = {}): Uint8Array {
  const out = new Uint8Array(19);
  const dv = new DataView(out.buffer);
  out.set(ascii('OpusHead'), 0);
  out[8] = 1; // version
  out[9] = h.channels ?? 1;
  dv.setUint16(10, h.preSkip ?? DEFAULT_PRE_SKIP, true);
  dv.setUint32(12, h.inputSampleRate ?? 16000, true);
  dv.setInt16(16, 0, true); // output gain
  out[18] = 0; // mapping family 0 (mono/stereo)
  return out;
}
export function opusTags(vendor = 'wca-synthetic'): Uint8Array {
  const v = ascii(vendor);
  const out = new Uint8Array(8 + 4 + v.length + 4);
  const dv = new DataView(out.buffer);
  out.set(ascii('OpusTags'), 0);
  dv.setUint32(8, v.length, true);
  out.set(v, 12);
  dv.setUint32(12 + v.length, 0, true); // no user comments
  return out;
}

export interface OggSilenceOptions {
  serial?: number;
  preSkip?: number;
  inputSampleRate?: number;
  /** omit the OpusTags page (hostile: missingOpusTags) */
  omitTags?: boolean;
  /** override the granule written on the LAST page (hostile: hugeGranule) */
  lastGranule?: bigint;
}
/** Pages of a mono DTX-silence note of `seconds` (rounded to 20 ms; 0 s = header pages only). */
export function oggSilencePages(seconds: number, o: OggSilenceOptions = {}): Uint8Array[] {
  const serial = o.serial ?? DEFAULT_SERIAL;
  const preSkip = o.preSkip ?? DEFAULT_PRE_SKIP;
  const total = Math.max(0, Math.round(seconds * PACKETS_PER_SECOND));
  const pages: Uint8Array[] = [];
  let seq = 0;
  pages.push(
    oggPage({
      headerType: 0x02,
      granule: 0n,
      serial,
      sequence: seq++,
      packets: [opusHead({ preSkip, inputSampleRate: o.inputSampleRate })],
    }),
  );
  if (!o.omitTags) pages.push(oggPage({ headerType: 0, granule: 0n, serial, sequence: seq++, packets: [opusTags()] }));
  let done = 0;
  while (done < total) {
    const n = Math.min(PACKETS_PER_PAGE, total - done);
    done += n;
    const last = done === total;
    const granule =
      last && o.lastGranule !== undefined ? o.lastGranule : BigInt(preSkip + done * SAMPLES_PER_PACKET_48K);
    pages.push(
      oggPage({
        headerType: last ? 0x04 : 0,
        granule,
        serial,
        sequence: seq++,
        packets: Array.from({ length: n }, () => OPUS_SILENCE_20MS),
      }),
    );
  }
  return pages;
}
/** A well-formed Ogg Opus voice note of `seconds` of DTX silence (the fake whisper maps its duration to a transcript). */
export function oggSilence(seconds: number, o: OggSilenceOptions = {}): Uint8Array {
  return concat(oggSilencePages(seconds, o));
}

// ---------------------------------------------------------------------------------------------------------------------
// hostile builders (T2 3.6) - each must end in a precise VOICE_* code with zero spawns
// ---------------------------------------------------------------------------------------------------------------------
/** The last audio page's CRC is off by one. */
export function badCrc(seconds = 1): Uint8Array {
  const pages = oggSilencePages(seconds);
  const last = pages[pages.length - 1]!.slice();
  last[22] = (last[22]! ^ 0x01) & 0xff;
  pages[pages.length - 1] = last;
  return concat(pages);
}
/** An audio page carries a different serial number than the BOS page (CRC recomputed, so only the serial is wrong). */
export function wrongSerial(seconds = 2): Uint8Array {
  const pages = oggSilencePages(seconds);
  pages[2] = reSerial(pages[2]!, DEFAULT_SERIAL + 1);
  return concat(pages);
}
/** Two logical streams (two BOS pages) multiplexed in one file. */
export function twoStreams(seconds = 1): Uint8Array {
  const a = oggSilencePages(seconds, { serial: DEFAULT_SERIAL });
  const b = oggSilencePages(seconds, { serial: DEFAULT_SERIAL + 7 });
  const out: Uint8Array[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i]) out.push(a[i]!);
    if (b[i]) out.push(b[i]!);
  }
  return concat(out);
}
/** The last page is cut in the middle of its body. */
export function truncatedPage(seconds = 1): Uint8Array {
  const full = oggSilence(seconds);
  return full.slice(0, full.length - 40);
}
/** OpusHead page followed directly by audio (RFC 7845 requires OpusTags as the second packet). */
export function missingOpusTags(seconds = 1): Uint8Array {
  return oggSilence(seconds, { omitTags: true });
}
/** A few pages whose last granule declares `minutes` of audio (> 15 min => VOICE_TOO_LONG before any decode). */
export function hugeGranule(minutes: number): Uint8Array {
  return oggSilence(1, { lastGranule: BigInt(DEFAULT_PRE_SKIP + Math.round(minutes * 60 * 48_000)) });
}
/** A page whose header declares 255 lacing values but the file ends inside the segment table. */
export function segmentTableOverflow(): Uint8Array {
  const head = oggSilencePages(0);
  const bogus = new Uint8Array(27 + 10);
  bogus.set([0x4f, 0x67, 0x67, 0x53], 0);
  bogus[26] = 255; // 255 segments declared, only 10 bytes follow
  bogus.fill(255, 27);
  return concat([...head, bogus]);
}
/** OpusHead pre-skip of 65535 samples (> the whole 1 s note). */
export function absurdPreSkip(): Uint8Array {
  return oggSilence(1, { preSkip: 65_535 });
}
export function zeroLength(): Uint8Array {
  return new Uint8Array(0);
}
/** An ID3v2 tag in front of an otherwise valid Ogg file (the first 4 bytes are not 'OggS'). */
export function id3Prefixed(seconds = 1): Uint8Array {
  const id3 = Uint8Array.of(0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 10, ...new Array<number>(10).fill(0));
  return concat([id3, oggSilence(seconds)]);
}
/** A RIFF/WAVE file (PCM 16 kHz mono, 0.1 s of zeros) served where an Ogg voice note was expected. */
export function riffWav(): Uint8Array {
  const data = 3200;
  const out = new Uint8Array(44 + data);
  const dv = new DataView(out.buffer);
  out.set(ascii('RIFF'), 0);
  dv.setUint32(4, 36 + data, true);
  out.set(ascii('WAVEfmt '), 8);
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, 16000, true);
  dv.setUint32(28, 32000, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  out.set(ascii('data'), 36);
  dv.setUint32(40, data, true);
  return out;
}
export const SPARSE_BYTES = 65 * 1024 * 1024 + 1;
/** 65 MiB + 1 byte: a valid 1 s note followed by zero padding, generated lazily as a stream (never materialised). */
export function sparse65MiB(chunkBytes = 64 * 1024): Readable {
  const head = oggSilence(1);
  let sent = 0;
  return Readable.from(
    (function* chunks() {
      yield Buffer.from(head);
      sent = head.length;
      const zero = Buffer.alloc(chunkBytes);
      while (sent < SPARSE_BYTES) {
        const n = Math.min(chunkBytes, SPARSE_BYTES - sent);
        sent += n;
        yield n === chunkBytes ? zero : zero.subarray(0, n);
      }
    })(),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// helpers (exported for the fixture self-test)
// ---------------------------------------------------------------------------------------------------------------------
export interface ParsedOggPage {
  headerType: number;
  granule: bigint;
  serial: number;
  sequence: number;
  crcOk: boolean;
  packets: number;
}
/** Minimal page walker for the self-test (not the production demuxer). Stops at the first malformed page. */
export function parseOggPages(bytes: Uint8Array): ParsedOggPage[] {
  const out: ParsedOggPage[] = [];
  let off = 0;
  while (off + 27 <= bytes.length) {
    if (bytes[off] !== 0x4f || bytes[off + 1] !== 0x67 || bytes[off + 2] !== 0x67 || bytes[off + 3] !== 0x53) break;
    const dv = new DataView(bytes.buffer, bytes.byteOffset + off);
    const nseg = bytes[off + 26]!;
    if (off + 27 + nseg > bytes.length) break;
    const lacing = bytes.subarray(off + 27, off + 27 + nseg);
    const bodyLen = lacing.reduce((a, b) => a + b, 0);
    const end = off + 27 + nseg + bodyLen;
    if (end > bytes.length) break;
    const page = bytes.slice(off, end);
    const stored = new DataView(page.buffer).getUint32(22, true);
    page.fill(0, 22, 26);
    out.push({
      headerType: bytes[off + 5]!,
      granule: dv.getBigUint64(6, true),
      serial: dv.getUint32(14, true),
      sequence: dv.getUint32(18, true),
      crcOk: oggCrc32(page) === stored,
      packets: Array.from(lacing).filter((l) => l < 255).length,
    });
    off = end;
  }
  return out;
}
function reSerial(page: Uint8Array, serial: number): Uint8Array {
  const p = page.slice();
  const dv = new DataView(p.buffer);
  dv.setUint32(14, serial >>> 0, true);
  dv.setUint32(22, 0, true);
  dv.setUint32(22, oggCrc32(p), true);
  return p;
}
function ascii(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
