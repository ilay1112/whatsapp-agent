// src/main/media/imageDims.ts   ADD (C2 15 "media/imageDims.ts + media/normalizeImage.ts signatures included here") - owner V2-W1-07-media-voice.
// Pure TS JPEG SOF / PNG IHDR reader; sniffs ONLY JPEG and PNG (GIF, WebP, text, anything else => null). Runs on attacker-supplied bytes
// BEFORE any native decoder (I12): every read is bounds-checked, nothing is allocated, nothing throws.

/** JPEG start-of-frame markers that carry the frame size (C0-C3, C5-C7, C9-CB, CD-CF; C4 DHT, C8 JPG, CC DAC are not frames). */
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function u16be(b: Uint8Array, off: number): number {
  return ((b[off] as number) << 8) | (b[off + 1] as number);
}
function u32be(b: Uint8Array, off: number): number {
  return (
    (((b[off] as number) << 24) >>> 0) +
    ((b[off + 1] as number) << 16) +
    ((b[off + 2] as number) << 8) +
    (b[off + 3] as number)
  );
}

function jpegDims(b: Uint8Array): { width: number; height: number } | null {
  let off = 2; // after SOI
  while (off + 4 <= b.length) {
    if (b[off] !== 0xff) return null;
    const marker = b[off + 1] as number;
    if (marker === 0xff) {
      off += 1; // fill byte
      continue;
    }
    // stand-alone markers without a length (TEM, RSTn) - never valid before the frame header, but skip them defensively
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0xda) return null; // SOI again, EOI or SOS before any SOF
    const len = u16be(b, off + 2);
    if (len < 2 || off + 2 + len > b.length) return null;
    if (JPEG_SOF.has(marker)) {
      if (len < 7) return null;
      const height = u16be(b, off + 5);
      const width = u16be(b, off + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    off += 2 + len;
  }
  return null;
}

function pngDims(b: Uint8Array): { width: number; height: number } | null {
  // signature (8) + IHDR length (4) + 'IHDR' (4) + 13 data bytes + CRC (4) = 33
  if (b.length < 33) return null;
  if (u32be(b, 8) !== 13 || b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  // PNG 11.2.2: 1 .. 2^31-1
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) return null;
  return { width, height };
}

/** Sniff by magic only: JPEG = FF D8 FF, PNG = the 8-byte signature. */
export function sniffImage(bytes: Uint8Array): 'jpeg' | 'png' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && PNG_SIGNATURE.every((v, i) => bytes[i] === v)) return 'png';
  return null;
}

/** media/imageDims.ts (pure TS JPEG SOF / PNG IHDR) + media/normalizeImage.ts (nativeImage: long edge 1536, toJPEG(85), 320-px thumbnail):
 *  > LIMITS.imageMaxBytes or > LIMITS.imageMaxPixels => rejected BEFORE nativeImage (audit media_rejected). */
export function readImageDims(bytes: Uint8Array): { kind: 'jpeg' | 'png'; width: number; height: number } | null {
  const kind = sniffImage(bytes);
  if (kind === null) return null;
  const dims = kind === 'jpeg' ? jpegDims(bytes) : pngDims(bytes);
  return dims === null ? null : { kind, ...dims };
}

/** A complete file ends exactly at its terminator: JPEG EOI (FF D9) / PNG IEND chunk. Truncated files and polyglots (a JPEG with a ZIP
 *  appended, T2 3.6) fail this BEFORE any native decoder sees them. */
export function endsCleanly(kind: 'jpeg' | 'png', bytes: Uint8Array): boolean {
  const n = bytes.length;
  if (kind === 'jpeg') return n >= 4 && bytes[n - 2] === 0xff && bytes[n - 1] === 0xd9;
  // IEND: length 0, type 'IEND', CRC AE 42 60 82
  const iend = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  return n >= 8 + 12 && iend.every((v, i) => bytes[n - 12 + i] === v);
}
