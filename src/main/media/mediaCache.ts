// src/main/media/mediaCache.ts   ADD (v2-build-plan section 3 seam) - owner V2-W1-07-media-voice.
// File = <userData>\media-cache\<sha256(chatRef|waMsgId)>.jpg (+ .thumb.jpg) ; row = repos.mediaCache (C2 1.4 MediaCacheRecord).
// The file name is a hash only: no contact name, JID, message id or bridge filename ever appears in a path (B27).
// [V2-W1-07 note] the seam's put() receives the app ChatRef, not the JID, so the key hashed is `<chatRef>|<waMsgId>` - stable for the
// row's lifetime (an @lid merge deletes the row by FK cascade, and the retention job / Dismiss unlink the files through deleteForItem).
import { join } from 'node:path';
import type { ChatRef, ItemId, MediaCacheRecord, Sha256Hex } from '../../shared/types';
import { LIMITS } from '../../shared/types';
import type { Repos } from '../db/index';
import type { NormalizedImage } from './normalizeImage';

export interface MediaCache {
  put(chatId: ChatRef, waMsgId: string, img: NormalizedImage): MediaCacheRecord;
  thumb(itemId: ItemId): string | null;
  dataUrl(itemId: ItemId): string | null;
  deleteForItem(itemId: ItemId): number;
}
/** The fs slice the cache needs (tests: a mkdtemp dir). */
export interface MediaCacheFs {
  writeFileSync(path: string, data: Uint8Array): void;
  readFileSync(path: string): Uint8Array;
  rmSync(path: string, opts: { force: true }): void;
  mkdirSync(path: string, opts: { recursive: true }): void;
}

const DATA_URL_PREFIX = 'data:image/jpeg;base64,';

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

export function createMediaCache(deps: {
  dir: string;
  repos: Pick<Repos, 'mediaCache'>;
  fs: MediaCacheFs;
  hash: (text: string) => Sha256Hex;
}): MediaCache {
  const baseOf = (chatId: ChatRef, waMsgId: string): string => join(deps.dir, deps.hash(`${chatId}|${waMsgId}`));
  const jpgOf = (chatId: ChatRef, waMsgId: string): string => `${baseOf(chatId, waMsgId)}.jpg`;
  const thumbOf = (chatId: ChatRef, waMsgId: string): string => `${baseOf(chatId, waMsgId)}.thumb.jpg`;
  /** The newest picture of an item (one picture per run, B19; a re-triage may add a newer one). */
  const newest = (itemId: ItemId): MediaCacheRecord | null => {
    const rows = deps.repos.mediaCache.forItem(itemId);
    return rows.length === 0 ? null : (rows[rows.length - 1] as MediaCacheRecord);
  };
  const readOrNull = (path: string): Uint8Array | null => {
    try {
      return deps.fs.readFileSync(path);
    } catch {
      return null; // a file removed by retention / purge while the row was still being read
    }
  };

  return {
    put(chatId, waMsgId, img) {
      if (!img.thumbDataUrl.startsWith(DATA_URL_PREFIX)) throw new TypeError('thumbnail is not a JPEG data URL');
      const thumb = new Uint8Array(Buffer.from(img.thumbDataUrl.slice(DATA_URL_PREFIX.length), 'base64'));
      deps.fs.mkdirSync(deps.dir, { recursive: true });
      deps.fs.writeFileSync(jpgOf(chatId, waMsgId), img.jpeg);
      deps.fs.writeFileSync(thumbOf(chatId, waMsgId), thumb);
      const existing = deps.repos.mediaCache.get(chatId, waMsgId);
      // item_id is linked by the caller once the item is known (repos.mediaCache.upsert({...record, itemId})); a re-put keeps the link
      const record: MediaCacheRecord = {
        itemId: existing?.itemId ?? null,
        chatId,
        waMsgId,
        sha256: img.sha256,
        width: img.width,
        height: img.height,
        bytes: img.jpeg.length,
        createdAt: existing?.createdAt ?? Date.now(),
      };
      deps.repos.mediaCache.upsert(record);
      return record;
    },
    thumb(itemId) {
      const row = newest(itemId);
      if (row === null) return null;
      const bytes = readOrNull(thumbOf(row.chatId, row.waMsgId));
      return bytes === null || bytes.length === 0 ? null : `${DATA_URL_PREFIX}${toBase64(bytes)}`;
    },
    dataUrl(itemId) {
      const row = newest(itemId);
      if (row === null) return null;
      const bytes = readOrNull(jpgOf(row.chatId, row.waMsgId));
      if (bytes === null || bytes.length === 0 || bytes.length > LIMITS.imageDataUrlMaxBytes) return null; // item:getImage refuses above the cap
      return `${DATA_URL_PREFIX}${toBase64(bytes)}`;
    },
    deleteForItem(itemId) {
      const rows = deps.repos.mediaCache.deleteForItem(itemId);
      for (const r of rows) {
        deps.fs.rmSync(jpgOf(r.chatId, r.waMsgId), { force: true });
        deps.fs.rmSync(thumbOf(r.chatId, r.waMsgId), { force: true });
      }
      return rows.length;
    },
  };
}
