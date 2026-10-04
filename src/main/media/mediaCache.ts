// src/main/media/mediaCache.ts   ADD (v2-build-plan section 3 seam) - owner V2-W1-07-media-voice.
// File = <userData>\media-cache\<hash(waMsgId|sha256)>.jpg (+ .thumb.jpg) ; row = repos.mediaCache (C2 1.4 MediaCacheRecord).
// The file name is a hash only: no contact name, JID, message id or bridge filename ever appears in a path (B27).
// [fix data-integrity-v4-2] The name is derived ONLY from row columns nothing ever re-keys: the message id and the picture's own
// content hash. It used to hash `<chatRef>|<waMsgId>`, but chats.mergeLidInto() moves media_cache rows to the surviving chat
// (`UPDATE OR IGNORE media_cache SET chat_id = <target>`, V2-W1-01) without touching the files, so after an @lid merge thumb() and
// dataUrl() looked under a name that never existed and deleteForItem() (Dismiss) unlinked it, leaving both real files on disk with no
// row naming them. A merge-dropped duplicate row (same wa_msg_id already on the target) names the SAME files as its survivor.
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

/** The row columns a cache file name is derived from - neither is ever re-keyed (an @lid merge moves only chat_id). */
export type MediaFileKey = Pick<MediaCacheRecord, 'waMsgId' | 'sha256'>;
/**
 * The bare file names (`[jpg, thumb]`) the cache keeps for one media_cache row. Exported so any other code that has to unlink a
 * row's files (e.g. the retention job's caller) uses this one naming function instead of re-deriving it.
 */
export function mediaCacheFileNames(hash: (text: string) => Sha256Hex, r: MediaFileKey): [string, string] {
  const base = hash(`${r.waMsgId}|${r.sha256}`);
  return [`${base}.jpg`, `${base}.thumb.jpg`];
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

export function createMediaCache(deps: {
  dir: string;
  repos: Pick<Repos, 'mediaCache'>;
  fs: MediaCacheFs;
  hash: (text: string) => Sha256Hex;
}): MediaCache {
  const jpgOf = (r: MediaFileKey): string => join(deps.dir, mediaCacheFileNames(deps.hash, r)[0]);
  const thumbOf = (r: MediaFileKey): string => join(deps.dir, mediaCacheFileNames(deps.hash, r)[1]);
  const unlink = (r: MediaFileKey): void => {
    deps.fs.rmSync(jpgOf(r), { force: true });
    deps.fs.rmSync(thumbOf(r), { force: true });
  };
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
      const key: MediaFileKey = { waMsgId, sha256: img.sha256 };
      deps.fs.mkdirSync(deps.dir, { recursive: true });
      deps.fs.writeFileSync(jpgOf(key), img.jpeg);
      deps.fs.writeFileSync(thumbOf(key), thumb);
      const existing = deps.repos.mediaCache.get(chatId, waMsgId);
      // the name follows the content: a re-put with different bytes (the upsert below overwrites sha256) retires the old files
      if (existing !== null && existing.sha256 !== img.sha256) unlink(existing);
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
      const bytes = readOrNull(thumbOf(row));
      return bytes === null || bytes.length === 0 ? null : `${DATA_URL_PREFIX}${toBase64(bytes)}`;
    },
    dataUrl(itemId) {
      const row = newest(itemId);
      if (row === null) return null;
      const bytes = readOrNull(jpgOf(row));
      if (bytes === null || bytes.length === 0 || bytes.length > LIMITS.imageDataUrlMaxBytes) return null; // item:getImage refuses above the cap
      return `${DATA_URL_PREFIX}${toBase64(bytes)}`;
    },
    deleteForItem(itemId) {
      const rows = deps.repos.mediaCache.deleteForItem(itemId);
      for (const r of rows) unlink(r);
      return rows.length;
    },
  };
}
