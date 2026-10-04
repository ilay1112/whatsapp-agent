// src/main/media/fetch.ts   ADD - the ONLY importer of BridgeReadClient.getMedia (B5, I6')
// Owner V2-W1-07-media-voice. At most TWO requests per message per call (one retry after LIMITS.mediaRetryDelayMs on 404 / 5xx /
// timeout), never more (fake-bridge violation media_retry_storm). Bytes are sniffed by magic, never by Content-Type; they are never
// logged and never written here (the caller's temp / cache rules decide).
import {
  BridgeAuthError,
  BridgeMediaIdError,
  BridgeMediaTooLargeError,
  BridgeUnreachableError,
  type BridgeReadClientV2,
} from '../bridge/readClient';
import { LIMITS } from '../../shared/types';

export type MediaKind = 'audio' | 'image';
export const MEDIA_MAX_BYTES: Record<MediaKind, number> = { audio: 64 * 1024 * 1024, image: 10 * 1024 * 1024 }; // = LIMITS.voiceMaxBytes / imageMaxBytes
export type MediaFetchResult =
  | { ok: true; bytes: Uint8Array; sniffed: 'ogg' | 'jpeg' | 'png' } // magic bytes: 'OggS' / FF D8 FF / 89 50 4E 47 - Content-Type is never trusted
  | { ok: false; reason: 'missing' | 'too_large' | 'bad_type' | 'unreachable' | 'auth' | 'bad_id' | 'aborted' };
export interface MediaFetcher {
  /** getMedia with the kind's cap; 404 / 5xx => ONE retry after LIMITS.mediaRetryDelayMs, then 'missing' / 'unreachable'
   *  (voice: VOICE_AUDIO_MISSING ; image: badge image_unread + MEDIA_UNAVAILABLE inline). Bytes are never logged, never written except by the
   *  caller's own temp/cache rules. */
  fetch(kind: MediaKind, chatJid: string, waMsgId: string, signal: AbortSignal): Promise<MediaFetchResult>;
}

/** Requests per message per fetch() call (= per triage): the first try plus one retry. */
export const MEDIA_MAX_REQUESTS = 2;

/** Magic-byte sniff. Only Ogg (voice) and JPEG / PNG (pictures) are ever accepted. */
export function sniffMedia(bytes: Uint8Array): 'ogg' | 'jpeg' | 'png' | null {
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53)
    return 'ogg';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return 'png';
  return null;
}

type Retryable = { ok: false; reason: 'retry_missing' | 'retry_unreachable' };
type Attempt = MediaFetchResult | Retryable;
const isRetryable = (a: Attempt): a is Retryable =>
  !a.ok && (a.reason === 'retry_missing' || a.reason === 'retry_unreachable');

export function createMediaFetcher(deps: {
  read: BridgeReadClientV2;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}): MediaFetcher {
  const once = async (kind: MediaKind, chatJid: string, waMsgId: string, signal: AbortSignal): Promise<Attempt> => {
    try {
      const media = await deps.read.getMedia(chatJid, waMsgId, { maxBytes: MEDIA_MAX_BYTES[kind], signal });
      if (media === null) return { ok: false, reason: 'retry_missing' };
      const sniffed = sniffMedia(media.bytes);
      const fits = kind === 'audio' ? sniffed === 'ogg' : sniffed === 'jpeg' || sniffed === 'png';
      if (sniffed === null || !fits) return { ok: false, reason: 'bad_type' };
      return { ok: true, bytes: media.bytes, sniffed };
    } catch (e) {
      if (signal.aborted) return { ok: false, reason: 'aborted' };
      if (e instanceof BridgeMediaIdError) return { ok: false, reason: 'bad_id' };
      if (e instanceof BridgeMediaTooLargeError) return { ok: false, reason: 'too_large' };
      if (e instanceof BridgeAuthError) return { ok: false, reason: 'auth' };
      if (e instanceof BridgeUnreachableError) return { ok: false, reason: 'retry_unreachable' };
      return { ok: false, reason: 'unreachable' }; // anything unexpected: fail closed, no retry
    }
  };

  return {
    async fetch(kind, chatJid, waMsgId, signal): Promise<MediaFetchResult> {
      let lastWasMissing = false;
      for (let attempt = 1; attempt <= MEDIA_MAX_REQUESTS; attempt += 1) {
        if (signal.aborted) return { ok: false, reason: 'aborted' };
        if (attempt > 1) {
          try {
            await deps.sleep(LIMITS.mediaRetryDelayMs, signal);
          } catch {
            return { ok: false, reason: 'aborted' };
          }
          if (signal.aborted) return { ok: false, reason: 'aborted' };
        }
        const r = await once(kind, chatJid, waMsgId, signal);
        if (!isRetryable(r)) return r;
        lastWasMissing = r.reason === 'retry_missing';
      }
      return { ok: false, reason: lastWasMissing ? 'missing' : 'unreachable' };
    },
  };
}
