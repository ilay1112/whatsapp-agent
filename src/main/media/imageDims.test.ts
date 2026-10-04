// src/main/media/imageDims.test.ts - owner V2-W1-07-media-voice. T2 5 row `media/imageDims.ts`: sniff JPEG/PNG only (GIF/WebP/text
// rejected); SOF/IHDR parse on every image-fixtures.ts builder.
import { describe, expect, it } from 'vitest';
import { endsCleanly, readImageDims, sniffImage } from './imageDims';
import {
  gif,
  jpeg,
  jpegBomb,
  jpegSize,
  png,
  pngBomb,
  pngNamedJpg,
  pngSize,
  polyglot,
  tooBig,
  truncatedJpeg,
  webp,
} from '../../../tests/fakes/image-fixtures';

const seg = (marker: number, payload: number[]): number[] => [
  0xff,
  marker,
  ((payload.length + 2) >> 8) & 0xff,
  (payload.length + 2) & 0xff,
  ...payload,
];
const sof = (marker: number, w: number, h: number): number[] =>
  seg(marker, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0]);

describe('readImageDims on every fixture builder', () => {
  it.each([
    [1, 1],
    [8, 8],
    [640, 480],
    [1536, 2048],
  ])('jpeg(%i, %i) and png(%i, %i)', (w, h) => {
    expect(readImageDims(jpeg(w, h))).toEqual({ kind: 'jpeg', width: w, height: h });
    expect(readImageDims(png(w, h))).toEqual({ kind: 'png', width: w, height: h });
    expect(jpegSize(jpeg(w, h))).toEqual({ width: w, height: h });
    expect(pngSize(png(w, h))).toEqual({ width: w, height: h });
  });

  it('bombs report their (huge) header size so the caller can refuse them', () => {
    expect(readImageDims(jpegBomb())).toEqual({ kind: 'jpeg', width: 6000, height: 4400 });
    expect(readImageDims(pngBomb())).toEqual({ kind: 'png', width: 10_000, height: 10_000 });
  });

  it('GIF, WebP, text, empty => null (only JPEG and PNG are sniffed)', () => {
    expect(readImageDims(gif())).toBeNull();
    expect(readImageDims(webp())).toBeNull();
    expect(readImageDims(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
    expect(readImageDims(new Uint8Array(0))).toBeNull();
    expect(sniffImage(gif())).toBeNull();
  });

  it('the magic decides, never the name: pngNamedJpg is a PNG', () => {
    expect(readImageDims(pngNamedJpg().bytes)?.kind).toBe('png');
  });

  it('truncated / polyglot / tooBig still have readable headers (the other guards reject them)', () => {
    expect(readImageDims(truncatedJpeg())).toEqual({ kind: 'jpeg', width: 64, height: 64 });
    expect(readImageDims(polyglot())).toEqual({ kind: 'jpeg', width: 16, height: 16 });
    expect(readImageDims(tooBig())).toEqual({ kind: 'jpeg', width: 8, height: 8 });
  });
});

describe('JPEG marker walk', () => {
  const SOI = [0xff, 0xd8];
  it('every SOF variant is read; DHT (C4), JPG (C8) and DAC (CC) are skipped', () => {
    for (const m of [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]) {
      expect(readImageDims(Uint8Array.from([...SOI, ...sof(m, 3, 2)]))).toEqual({ kind: 'jpeg', width: 3, height: 2 });
    }
    const skipped = Uint8Array.from([
      ...SOI,
      ...seg(0xc4, [0, 1]),
      ...seg(0xc8, [1]),
      ...seg(0xcc, [1, 2]),
      ...sof(0xc0, 5, 7),
    ]);
    expect(readImageDims(skipped)).toEqual({ kind: 'jpeg', width: 5, height: 7 });
  });
  it('fill bytes and stand-alone markers are skipped', () => {
    const b = Uint8Array.from([...SOI, 0xff, 0xff, 0xff, 0x01, 0xff, 0xd3, ...sof(0xc0, 9, 4)]);
    expect(readImageDims(b)).toEqual({ kind: 'jpeg', width: 9, height: 4 });
  });
  it('malformed walks => null', () => {
    const APP0 = seg(0xe0, [0, 0]);
    const cases: number[][] = [
      [0xff], // too short
      [0x00, 0xc0, 0, 11, 0, 0], // not a marker
      [0xff, 0xd9, 0, 0], // EOI before a frame
      [0xff, 0xda, 0, 2], // SOS before a frame
      [0xff, 0xd8, 0, 2], // SOI again
      [0xff, 0xe0, 0, 1, 0], // length < 2
      [0xff, 0xe0, 0, 40, 0, 0], // segment beyond the buffer
      [0xff, 0xc0, 0, 4, 8, 0], // SOF too short
      sof(0xc0, 0, 5), // zero width
      sof(0xc0, 5, 0), // zero height
      seg(0xe1, [1, 2, 3]), // runs out without a SOF
    ];
    for (const c of cases) expect(readImageDims(Uint8Array.from([...SOI, ...APP0, ...c]))).toBeNull();
  });
});

describe('PNG IHDR', () => {
  it('malformed IHDR => null', () => {
    const good = png(4, 4);
    const edit = (off: number, bytes: number[]): Uint8Array => {
      const b = good.slice();
      b.set(bytes, off);
      return b;
    };
    expect(readImageDims(good.subarray(0, 32))).toBeNull(); // too short
    expect(readImageDims(edit(8, [0, 0, 0, 12]))).toBeNull(); // IHDR length != 13
    expect(readImageDims(edit(12, [0x49, 0x44, 0x41, 0x54]))).toBeNull(); // first chunk IDAT
    expect(readImageDims(edit(16, [0, 0, 0, 0]))).toBeNull(); // width 0
    expect(readImageDims(edit(20, [0, 0, 0, 0]))).toBeNull(); // height 0
    expect(readImageDims(edit(16, [0x80, 0, 0, 0]))).toBeNull(); // width >= 2^31
    expect(readImageDims(edit(20, [0x80, 0, 0, 1]))).toBeNull(); // height >= 2^31
    expect(readImageDims(edit(13, [0x49]))).toBeNull();
    expect(readImageDims(edit(14, [0x49]))).toBeNull();
    expect(readImageDims(edit(15, [0x49]))).toBeNull();
  });
});

describe('endsCleanly', () => {
  it('JPEG must end at EOI, PNG at IEND; truncation and polyglots fail', () => {
    expect(endsCleanly('jpeg', jpeg(16, 16))).toBe(true);
    expect(endsCleanly('png', png(16, 16))).toBe(true);
    expect(endsCleanly('jpeg', truncatedJpeg())).toBe(false);
    expect(endsCleanly('jpeg', polyglot())).toBe(false);
    expect(endsCleanly('jpeg', Uint8Array.of(0xff, 0xd9))).toBe(false);
    const p = png(16, 16);
    expect(endsCleanly('png', p.subarray(0, p.length - 1))).toBe(false);
    expect(endsCleanly('png', p.subarray(p.length - 12))).toBe(false); // too short to be a PNG at all
  });
});
