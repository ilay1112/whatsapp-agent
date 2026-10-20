// src/main/update/zip.fixtures.ts - test-support (build-plan naming rule): a tiny ZIP WRITER whose every header field can be
// forged, for the extractor's refusal tests and the fake release server. Never imported by production code.
import { deflateRawSync } from 'node:zlib';
import { crc32 } from './zip';

export interface ForgedEntry {
  name: string | Buffer;
  data?: Buffer;
  method?: number;
  crc?: number;
  /** declared uncompressed size (default = data length) */
  size?: number;
  flags?: number;
  madeBy?: number;
  extAttr?: number;
  /** name written into the LOCAL header (default = name) */
  localName?: string;
}
export function buildZip(entries: ForgedEntry[], opts: { eocdEntries?: number } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, 'utf8');
    const localName = e.localName === undefined ? name : Buffer.from(e.localName, 'utf8');
    const data = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = e.crc ?? crc32(data);
    const size = e.size ?? data.length;
    const flags = e.flags ?? 0x0800;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc >>> 0, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(localName.length, 26);
    locals.push(lh, localName, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(e.madeBy ?? 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc >>> 0, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE((e.extAttr ?? 0) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + localName.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.eocdEntries ?? entries.length, 8);
  eocd.writeUInt16LE(opts.eocdEntries ?? entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
