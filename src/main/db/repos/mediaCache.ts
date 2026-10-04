// src/main/db/repos/mediaCache.ts - Repos['mediaCache'] (C2 16.1, [V2 ADD]; owner V2-W1-01-db).
// media_cache (B19): one row per normalised picture, keyed (chat_id, wa_msg_id). The FILE lives under <userData>\media-cache\ and
// belongs to media/mediaCache.ts; this repo only keeps the row. Deleting rows returns them so the caller can unlink the files.
import type { Db, Repos } from '../index';
import { MEDIA_CACHE_COLUMNS, type MediaCacheRow, toMediaCache } from './rows';

export type MediaCacheRepo = Repos['mediaCache'];

export function createMediaCacheRepo(db: Db): MediaCacheRepo {
  const forItem = (itemId: number): ReturnType<MediaCacheRepo['forItem']> =>
    db
      .prepare<MediaCacheRow>(
        `SELECT ${MEDIA_CACHE_COLUMNS} FROM media_cache WHERE item_id = ? ORDER BY created_at ASC, wa_msg_id ASC`,
      )
      .all(itemId)
      .map(toMediaCache);
  return {
    get(chatId, waMsgId) {
      const row = db
        .prepare<MediaCacheRow>(`SELECT ${MEDIA_CACHE_COLUMNS} FROM media_cache WHERE chat_id = ? AND wa_msg_id = ?`)
        .get(chatId, waMsgId);
      return row ? toMediaCache(row) : null;
    },
    upsert(r) {
      db.prepare(
        `INSERT INTO media_cache(item_id, chat_id, wa_msg_id, sha256, width, height, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, wa_msg_id) DO UPDATE SET item_id = excluded.item_id, sha256 = excluded.sha256, width = excluded.width,
                                                      height = excluded.height, bytes = excluded.bytes, created_at = excluded.created_at`,
      ).run(r.itemId, r.chatId, r.waMsgId, r.sha256, r.width, r.height, r.bytes, r.createdAt);
    },
    forItem,
    /** Dismiss / "Never analyse" / delete: the rows are removed in one transaction and returned - the caller unlinks their files. */
    deleteForItem(itemId) {
      return db.transaction(() => {
        const rows = forItem(itemId);
        db.prepare(`DELETE FROM media_cache WHERE item_id = ?`).run(itemId);
        return rows;
      });
    },
  };
}
