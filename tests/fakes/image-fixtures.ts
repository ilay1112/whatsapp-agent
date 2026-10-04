// tests/fakes/image-fixtures.ts - [V2] pure-TS picture builders (T2 3.6; complete in Wave 0 by V2-W0-scaffold, owner
// V2-W1-08-vision). Synthetic bytes only (T5/T12): flat grey pixels, no face, logo, name or text. Node built-ins only
// (node:zlib for the PNG IDAT). The hostile builders drive the "bombs are rejected before nativeImage" tests.
import { deflateSync } from 'node:zlib';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // LIMITS.imageMaxBytes (S-IMAGE); tooBig() is one byte over

// ---------------------------------------------------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------------------------------------------------
const PNG_SIG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC32_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(ascii(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function ihdr(width: number, height: number): Uint8Array {
  const d = new Uint8Array(13);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  d[8] = 8; // bit depth
  d[9] = 2; // colour type RGB
  d[10] = 0;
  d[11] = 0;
  d[12] = 0;
  return d;
}
/** A valid RGB PNG of `width` x `height` flat grey pixels. */
export function png(width: number, height: number, grey = 0x80): Uint8Array {
  const row = 1 + width * 3;
  const raw = new Uint8Array(row * height).fill(grey);
  for (let y = 0; y < height; y += 1) raw[y * row] = 0; // filter type None
  return concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr(width, height)),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

// ---------------------------------------------------------------------------------------------------------------------
// JPEG (baseline, 1 grey component, every coefficient zero; one-symbol Huffman tables: DC cat 0 = '0', AC EOB = '0')
// ---------------------------------------------------------------------------------------------------------------------
function segment(marker: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  out[0] = 0xff;
  out[1] = marker;
  new DataView(out.buffer).setUint16(2, payload.length + 2);
  out.set(payload, 4);
  return out;
}
function sof0(width: number, height: number): Uint8Array {
  const p = new Uint8Array(9);
  const dv = new DataView(p.buffer);
  p[0] = 8; // precision
  dv.setUint16(1, height);
  dv.setUint16(3, width);
  p[5] = 1; // components
  p[6] = 1; // id
  p[7] = 0x11; // sampling 1x1
  p[8] = 0; // quant table 0
  return segment(0xc0, p);
}
const APP0 = segment(0xe0, Uint8Array.of(0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0)); // 'JFIF\0' v1.1
const DQT = segment(0xdb, Uint8Array.of(0x00, ...new Array<number>(64).fill(1)));
const huff = (tableClassId: number, symbol: number): Uint8Array =>
  segment(0xc4, Uint8Array.of(tableClassId, 1, ...new Array<number>(15).fill(0), symbol)); // one code of length 1 ('0')
const DHT_DC = huff(0x00, 0x00);
const DHT_AC = huff(0x10, 0x00);
const SOS = segment(0xda, Uint8Array.of(1, 1, 0x00, 0, 63, 0));
/** A valid baseline JPEG of `width` x `height` mid-grey pixels (decodable by libjpeg-turbo / Chromium). */
export function jpeg(width: number, height: number): Uint8Array {
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  const bits = blocks * 2; // '0' (DC diff category 0) + '0' (EOB) per block
  const scan = new Uint8Array(Math.ceil(bits / 8)).fill(0);
  const rem = bits % 8;
  if (rem !== 0) scan[scan.length - 1] = (1 << (8 - rem)) - 1; // pad the last byte with 1-bits
  return concat([
    Uint8Array.of(0xff, 0xd8),
    APP0,
    DQT,
    sof0(width, height),
    DHT_DC,
    DHT_AC,
    SOS,
    scan,
    Uint8Array.of(0xff, 0xd9),
  ]);
}

// ---------------------------------------------------------------------------------------------------------------------
// hostile builders
// ---------------------------------------------------------------------------------------------------------------------
/** SOF header 6000 x 4400 = 26.4 MP with a tiny body: must be refused from the header, before any decode. */
export function jpegBomb(): Uint8Array {
  return concat([Uint8Array.of(0xff, 0xd8), APP0, DQT, sof0(6000, 4400), Uint8Array.of(0xff, 0xd9)]);
}
/** IHDR 10000 x 10000 with a one-row IDAT. */
export function pngBomb(): Uint8Array {
  return concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr(10_000, 10_000)),
    pngChunk('IDAT', deflateSync(new Uint8Array(1 + 10_000 * 3))),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}
/** A valid 64 x 64 JPEG cut after its scan started (no EOI). */
export function truncatedJpeg(): Uint8Array {
  const full = jpeg(64, 64);
  return full.slice(0, full.length - 8);
}
/** PNG bytes delivered under a `.jpg` name / `image/jpeg` claim: the magic bytes decide, never the name. */
export function pngNamedJpg(): { name: string; mime: 'image/jpeg'; bytes: Uint8Array } {
  return { name: 'photo.jpg', mime: 'image/jpeg', bytes: png(32, 32) };
}
/** GIF89a 1 x 1 (not an accepted format). */
export function gif(): Uint8Array {
  return Uint8Array.of(
    0x47,
    0x49,
    0x46,
    0x38,
    0x39,
    0x61,
    1,
    0,
    1,
    0,
    0x80,
    0,
    0,
    0,
    0,
    0,
    0xff,
    0xff,
    0xff,
    0x21,
    0xf9,
    4,
    0,
    0,
    0,
    0,
    0,
    0x2c,
    0,
    0,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    2,
    2,
    0x44,
    1,
    0,
    0x3b,
  );
}
/** RIFF/WEBP with a VP8L header for 1 x 1 (not an accepted format). */
export function webp(): Uint8Array {
  const vp8l = Uint8Array.of(0x2f, 0, 0, 0, 0, 0x88, 0x88, 0x08, 0x00);
  const out = new Uint8Array(20 + vp8l.length + (vp8l.length % 2));
  const dv = new DataView(out.buffer);
  out.set(ascii('RIFF'), 0);
  dv.setUint32(4, out.length - 8, true);
  out.set(ascii('WEBPVP8L'), 8);
  dv.setUint32(16, vp8l.length, true);
  out.set(vp8l, 20);
  return out;
}
/** A JPEG-magic buffer of MAX_IMAGE_BYTES + 1 bytes (refused by size before any parse). */
export function tooBig(): Uint8Array {
  const out = new Uint8Array(MAX_IMAGE_BYTES + 1);
  out.set(jpeg(8, 8), 0);
  return out;
}
/** A valid JPEG followed by a ZIP local-file header and central directory (a polyglot). */
export function polyglot(): Uint8Array {
  const zip = concat([
    Uint8Array.of(
      0x50,
      0x4b,
      0x03,
      0x04,
      20,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      5,
      0,
      0,
      0,
    ),
    ascii('a.txt'),
    Uint8Array.of(0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)),
  ]);
  return concat([jpeg(16, 16), zip]);
}

// ---------------------------------------------------------------------------------------------------------------------
// header readers for the fixture self-test (NOT the production imageDims)
// ---------------------------------------------------------------------------------------------------------------------
export function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24 || !PNG_SIG.every((v, i) => b[i] === v)) return null;
  const dv = new DataView(b.buffer, b.byteOffset);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}
export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let off = 2;
  const dv = new DataView(b.buffer, b.byteOffset);
  while (off + 4 <= b.length && b[off] === 0xff) {
    const marker = b[off + 1]!;
    const len = dv.getUint16(off + 2);
    if (marker === 0xc0) return { height: dv.getUint16(off + 5), width: dv.getUint16(off + 7) };
    off += 2 + len;
  }
  return null;
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
