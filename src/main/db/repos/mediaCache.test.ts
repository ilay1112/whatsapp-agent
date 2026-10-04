// T2 5 row `db/*`: media_cache (B19) - keyed (chat_id, wa_msg_id); deleteForItem returns the rows so the caller can unlink the files;
// ON DELETE: item -> SET NULL (the row outlives a deleted item until retention), chat -> CASCADE.
import { afterEach, describe, expect, it } from 'vitest';
import type * as T from '../../../shared/types';
import { cleanup, JID_B, memRepos, seedChat, seedOpenItem, T0 } from '../__fixtures__/testDb';

afterEach(cleanup);

const rec = (chatId: number, itemId: number | null, n: number): T.MediaCacheRecord => ({
  itemId,
  chatId,
  waMsgId: `SYN-IMG-${n}`,
  sha256: String(n).repeat(64).slice(0, 64),
  width: 800,
  height: 600,
  bytes: 50_000 + n,
  createdAt: T0 + n,
});

describe('repos.mediaCache', () => {
  it('get / upsert / forItem; upsert replaces on the same (chat, message)', () => {
    const { repos } = memRepos();
    const chat = seedChat(repos);
    const item = seedOpenItem(repos, chat.id);
    repos.mediaCache.upsert(rec(chat.id, item.id, 1));
    repos.mediaCache.upsert(rec(chat.id, item.id, 2));
    repos.mediaCache.upsert(rec(chat.id, null, 3));
    expect(repos.mediaCache.get(chat.id, 'SYN-IMG-1')).toEqual(rec(chat.id, item.id, 1));
    expect(repos.mediaCache.get(chat.id, 'nope')).toBeNull();
    expect(repos.mediaCache.forItem(item.id)).toEqual([rec(chat.id, item.id, 1), rec(chat.id, item.id, 2)]);
    repos.mediaCache.upsert({ ...rec(chat.id, item.id, 1), width: 10 });
    expect(repos.mediaCache.get(chat.id, 'SYN-IMG-1')!.width).toBe(10);
  });

  it("deleteForItem removes and returns exactly that item's rows", () => {
    const { repos } = memRepos();
    const chat = seedChat(repos);
    const item = seedOpenItem(repos, chat.id);
    repos.mediaCache.upsert(rec(chat.id, item.id, 1));
    repos.mediaCache.upsert(rec(chat.id, null, 2));
    expect(repos.mediaCache.deleteForItem(item.id)).toEqual([rec(chat.id, item.id, 1)]);
    expect(repos.mediaCache.forItem(item.id)).toEqual([]);
    expect(repos.mediaCache.get(chat.id, 'SYN-IMG-2')).not.toBeNull();
    expect(repos.mediaCache.deleteForItem(item.id)).toEqual([]);
  });

  it('the DDL refuses a hash that is not 64 hex chars long', () => {
    const { repos } = memRepos();
    const chat = seedChat(repos);
    expect(() => repos.mediaCache.upsert({ ...rec(chat.id, null, 1), sha256: 'abc' })).toThrow(/CHECK/);
  });

  it('ON DELETE: a deleted item leaves the row (item_id NULL); a deleted chat takes its rows along', () => {
    const { db, repos } = memRepos();
    const chat = seedChat(repos);
    const item = seedOpenItem(repos, chat.id);
    repos.mediaCache.upsert(rec(chat.id, item.id, 1));
    db.prepare(`DELETE FROM items WHERE id = ?`).run(item.id);
    expect(repos.mediaCache.get(chat.id, 'SYN-IMG-1')!.itemId).toBeNull();
    const other = seedChat(repos, JID_B);
    repos.mediaCache.upsert(rec(other.id, null, 2));
    db.prepare(`DELETE FROM chats WHERE id = ?`).run(other.id);
    expect(repos.mediaCache.get(other.id, 'SYN-IMG-2')).toBeNull();
  });
});
