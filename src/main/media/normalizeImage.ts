// src/main/media/normalizeImage.ts   ADD (C2 15 + v2-build-plan section 3 seam) - owner V2-W1-07-media-voice.
// Gets `nativeImage` ONLY through the S-IMAGE facade (never an import of electron, build-plan rule 12).
// Order (I12, B19): size cap -> magic sniff -> header dimensions (pure TS) -> pixel cap -> terminator check -> ONLY THEN the facade.
// A decompression bomb, a GIF / WebP / text, a polyglot or a 10 MiB + 1 buffer never reaches native code.
import type { Sha256Hex } from '../../shared/types';
import { LIMITS } from '../../shared/types';
import type { ImageFacade, ImageHandle } from '../deps';
import { endsCleanly, readImageDims } from './imageDims';

/** C2 15 (declared in the agent/readImage.ts block; it lives here with its producer and is re-exported by agent/readImage.ts). */
export interface NormalizedImage {
  jpeg: Uint8Array;
  width: number;
  height: number;
  sha256: Sha256Hex;
  thumbDataUrl: string;
  sourceMime: 'image/jpeg' | 'image/png';
}
export type ImageRejection = { rejected: 'format' | 'bytes' | 'pixels' | 'decode' };

/** B19: JPEG quality of the normalised picture. */
export const NORMALIZED_JPEG_QUALITY = 85;
/** Quality of the 320-px thumbnail (a card preview, never sent to a model). */
export const THUMB_JPEG_QUALITY = 80;

export function isImageRejection(r: NormalizedImage | ImageRejection): r is ImageRejection {
  return 'rejected' in r;
}

/** Resize so the long edge is at most `edge` px (never upscales). */
function fitLongEdge(h: ImageHandle, width: number, height: number, edge: number): ImageHandle {
  if (Math.max(width, height) <= edge) return h;
  return width >= height ? h.resize({ width: edge, quality: 'good' }) : h.resize({ height: edge, quality: 'good' });
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** v2-build-plan 3: createImageNormalizer({image (S-IMAGE), hash}) - rejects > 10 MiB / > 25 MP BEFORE the facade; long edge 1536,
 *  toJPEG(85), 320-px thumbnail data URL. */
export function createImageNormalizer(deps: {
  image: ImageFacade /* S-IMAGE */;
  hash: (bytes: Uint8Array) => Sha256Hex;
}): (bytes: Uint8Array) => NormalizedImage | ImageRejection {
  return (bytes) => {
    if (bytes.length > LIMITS.imageMaxBytes) return { rejected: 'bytes' };
    const dims = readImageDims(bytes);
    if (dims === null) return { rejected: 'format' };
    if (dims.width * dims.height > LIMITS.imageMaxPixels) return { rejected: 'pixels' };
    if (!endsCleanly(dims.kind, bytes)) return { rejected: 'format' };

    let jpeg: Uint8Array;
    let thumb: Uint8Array;
    let width: number;
    let height: number;
    try {
      const src = deps.image.fromBuffer(bytes);
      if (src.isEmpty()) return { rejected: 'decode' };
      const size = src.getSize();
      // the decoder must agree with the header we checked (EXIF orientation may swap the axes): a header that lies about its size is
      // not processed any further
      const same = size.width === dims.width && size.height === dims.height;
      const swapped = size.width === dims.height && size.height === dims.width;
      if (!same && !swapped) return { rejected: 'decode' };
      const normal = fitLongEdge(src, size.width, size.height, LIMITS.imageLongEdgePx);
      if (normal.isEmpty()) return { rejected: 'decode' };
      ({ width, height } = normal.getSize());
      jpeg = normal.toJPEG(NORMALIZED_JPEG_QUALITY);
      const small = fitLongEdge(src, size.width, size.height, LIMITS.imageThumbPx);
      thumb = small.toJPEG(THUMB_JPEG_QUALITY);
    } catch {
      return { rejected: 'decode' };
    }
    if (jpeg.length === 0 || thumb.length === 0 || width <= 0 || height <= 0) return { rejected: 'decode' };
    return {
      jpeg,
      width,
      height,
      sha256: deps.hash(jpeg),
      thumbDataUrl: `data:image/jpeg;base64,${toBase64(thumb)}`,
      sourceMime: dims.kind === 'jpeg' ? 'image/jpeg' : 'image/png',
    };
  };
}
