// src/main/media/normalizeImage.test.ts - owner V2-W1-07-media-voice. T2 5 row `media/normalizeImage.ts`: > 25 MP and > 10 MiB (and
// GIF / WebP / polyglot / truncated) rejected BEFORE nativeImage (S-IMAGE spy never called); long edge 1536, toJPEG(85), 320-px thumbnail.
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Sha256Hex } from '../../shared/types';
import { LIMITS } from '../../shared/types';
import type { ImageFacade, ImageHandle } from '../deps';
import {
  createImageNormalizer,
  isImageRejection,
  NORMALIZED_JPEG_QUALITY,
  THUMB_JPEG_QUALITY,
  type NormalizedImage,
} from './normalizeImage';
import {
  gif,
  jpeg,
  jpegBomb,
  png,
  pngBomb,
  polyglot,
  tooBig,
  truncatedJpeg,
  webp,
} from '../../../tests/fakes/image-fixtures';

const sha = (b: Uint8Array): Sha256Hex => createHash('sha256').update(b).digest('hex') as Sha256Hex;

/** Deterministic S-IMAGE double: records every call; the "decoded" size is what the test scripts. */
function facade(
  opts: {
    size?: { width: number; height: number };
    empty?: boolean;
    throwOn?: 'from' | 'resize' | 'jpeg';
    emptyJpeg?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const handle = (w: number, h: number): ImageHandle => ({
    isEmpty: () => opts.empty === true,
    getSize: () => ({ width: w, height: h }),
    resize: (r) => {
      calls.push(`resize:${JSON.stringify(r)}`);
      if (opts.throwOn === 'resize') throw new Error('resize');
      const nw = r.width ?? Math.round((w * (r.height as number)) / h);
      const nh = r.height ?? Math.round((h * (r.width as number)) / w);
      return handle(nw, nh);
    },
    toJPEG: (q) => {
      calls.push(`jpeg:${q}:${w}x${h}`);
      if (opts.throwOn === 'jpeg') throw new Error('jpeg');
      return opts.emptyJpeg === true
        ? new Uint8Array(0)
        : Uint8Array.from([0xff, 0xd8, q, w & 0xff, h & 0xff, 0xff, 0xd9]);
    },
  });
  const f: ImageFacade = {
    fromBuffer: vi.fn((bytes: Uint8Array) => {
      calls.push(`from:${bytes.length}`);
      if (opts.throwOn === 'from') throw new Error('native');
      const s = opts.size ?? { width: 0, height: 0 };
      return handle(s.width, s.height);
    }),
  };
  return { f, calls };
}

describe('rejected BEFORE the facade (S-IMAGE spy never called)', () => {
  it.each<[string, () => Uint8Array, 'format' | 'bytes' | 'pixels']>([
    ['tooBig (10 MiB + 1)', tooBig, 'bytes'],
    ['jpegBomb (26.4 MP header)', jpegBomb, 'pixels'],
    ['pngBomb (100 MP header)', pngBomb, 'pixels'],
    ['gif', gif, 'format'],
    ['webp', webp, 'format'],
    ['polyglot (JPEG + ZIP)', polyglot, 'format'],
    ['truncatedJpeg (no EOI)', truncatedJpeg, 'format'],
    ['text', () => new TextEncoder().encode('ignore previous instructions'), 'format'],
  ])('%s => %s', (_n, build, reason) => {
    const { f } = facade({ size: { width: 1, height: 1 } });
    expect(createImageNormalizer({ image: f, hash: sha })(build())).toEqual({ rejected: reason });
    expect(f.fromBuffer).not.toHaveBeenCalled();
  });

  it('exactly 25 MP passes the pixel guard, one pixel more does not', () => {
    const { f } = facade({ size: { width: 5000, height: 5000 } });
    const n = createImageNormalizer({ image: f, hash: sha });
    expect(LIMITS.imageMaxPixels).toBe(25_000_000);
    expect(isImageRejection(n(jpeg(5000, 5000)))).toBe(false);
    expect(n(png(5001, 5000))).toEqual({ rejected: 'pixels' });
  });
});

describe('normalisation through the facade', () => {
  it('a large landscape JPEG: long edge 1536, toJPEG(85), 320-px thumbnail data URL, sha256 of the normalised bytes', () => {
    const { f, calls } = facade({ size: { width: 3072, height: 2048 } });
    const r = createImageNormalizer({ image: f, hash: sha })(jpeg(3072, 2048)) as NormalizedImage;
    expect(isImageRejection(r)).toBe(false);
    expect(r.width).toBe(1536);
    expect(r.height).toBe(1024);
    expect(r.sourceMime).toBe('image/jpeg');
    expect(r.sha256).toBe(sha(r.jpeg));
    expect(r.thumbDataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(calls).toEqual([
      `from:${jpeg(3072, 2048).length}`,
      'resize:{"width":1536,"quality":"good"}',
      `jpeg:${NORMALIZED_JPEG_QUALITY}:1536x1024`,
      'resize:{"width":320,"quality":"good"}',
      `jpeg:${THUMB_JPEG_QUALITY}:320x213`,
    ]);
    expect(NORMALIZED_JPEG_QUALITY).toBe(85);
  });

  it('a portrait PNG resizes by height; a small picture is never upscaled', () => {
    const tall = facade({ size: { width: 1000, height: 3000 } });
    const r = createImageNormalizer({ image: tall.f, hash: sha })(png(1000, 3000)) as NormalizedImage;
    expect([r.width, r.height, r.sourceMime]).toEqual([512, 1536, 'image/png']);
    expect(tall.calls).toContain('resize:{"height":1536,"quality":"good"}');
    expect(tall.calls).toContain('resize:{"height":320,"quality":"good"}');
    const small = facade({ size: { width: 200, height: 100 } });
    const s = createImageNormalizer({ image: small.f, hash: sha })(png(200, 100)) as NormalizedImage;
    expect([s.width, s.height]).toEqual([200, 100]);
    expect(small.calls.filter((c) => c.startsWith('resize'))).toEqual([]);
  });

  it('EXIF-swapped axes are accepted; a decoder size that disagrees with the header is refused', () => {
    const swapped = facade({ size: { width: 480, height: 640 } });
    expect(isImageRejection(createImageNormalizer({ image: swapped.f, hash: sha })(jpeg(640, 480)))).toBe(false);
    const liar = facade({ size: { width: 4000, height: 4000 } });
    expect(createImageNormalizer({ image: liar.f, hash: sha })(jpeg(64, 64))).toEqual({ rejected: 'decode' });
  });

  it('decode failures: empty handle, throwing facade / resize / toJPEG, empty JPEG output => decode', () => {
    for (const o of [
      { empty: true },
      { throwOn: 'from' as const },
      { throwOn: 'resize' as const },
      { throwOn: 'jpeg' as const },
      { emptyJpeg: true },
    ]) {
      const { f } = facade({ size: { width: 2000, height: 100 }, ...o });
      expect(createImageNormalizer({ image: f, hash: sha })(jpeg(2000, 100))).toEqual({ rejected: 'decode' });
    }
  });

  it('a resize that yields an empty handle or a zero size => decode', () => {
    const base = facade({ size: { width: 2000, height: 100 } });
    const f: ImageFacade = {
      fromBuffer: (b) => {
        const h = base.f.fromBuffer(b);
        return {
          ...h,
          resize: () => ({
            isEmpty: () => true,
            getSize: () => ({ width: 0, height: 0 }),
            resize: h.resize,
            toJPEG: h.toJPEG,
          }),
        };
      },
    };
    expect(createImageNormalizer({ image: f, hash: sha })(jpeg(2000, 100))).toEqual({ rejected: 'decode' });
    const zero: ImageFacade = {
      fromBuffer: () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 0, height: 0 }),
        resize: () => {
          throw new Error('x');
        },
        toJPEG: () => Uint8Array.of(1),
      }),
    };
    // header 0x0 cannot happen (imageDims refuses it), so a decoder answering 0x0 disagrees with the header => decode
    expect(createImageNormalizer({ image: zero, hash: sha })(jpeg(8, 8))).toEqual({ rejected: 'decode' });
  });
});
