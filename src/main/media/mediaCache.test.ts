// src/main/media/mediaCache.test.ts - owner V2-W1-07-media-voice. T2 5: cache file name = sha256 only (no contact-derived text); row upsert;
// thumb / dataUrl (item:getImage cap); deletion on Dismiss / "Never analyse" removes both files.
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatRef, EpochMs, ItemId, MediaCacheRecord, Sha256Hex } from '../../shared/types';
import { LIMITS } from '../../shared/types';
import { cleanup, JID_B, LID_JID, memRepos, seedChat, seedOpenItem, T0 } from '../db/__fixtures__/testDb';
import type { Repos } from '../db/index';
import { createMediaCache, type MediaCacheFs } from './mediaCache';
import type { NormalizedImage } from './normalizeImage';

const sha = (t: string | Uint8Array): Sha256Hex => createHash('sha256').update(t).digest('hex') as Sha256Hex;

function memRepo(): Pick<Repos, 'mediaCache'> & { rows: MediaCacheRecord[] } {
  const rows: MediaCacheRecord[] = [];
  return {
    rows,
    mediaCache: {
      get: (c, w) => rows.find((r) => r.chatId === c && r.waMsgId === w) ?? null,
      upsert: (r) => {
        const i = rows.findIndex((x) => x.chatId === r.chatId && x.waMsgId === r.waMsgId);
        if (i === -1) rows.push({ ...r });
        else rows[i] = { ...r };
      },
      forItem: (id) => rows.filter((r) => r.itemId === id),
      deleteForItem: (id) => {
        const out = rows.filter((r) => r.itemId === id);
        for (const r of out) rows.splice(rows.indexOf(r), 1);
        return out;
      },
    },
  };
}
const realFs: MediaCacheFs = {
  writeFileSync: (p, d) => nodeFs.writeFileSync(p, d),
  readFileSync: (p) => nodeFs.readFileSync(p),
  rmSync: (p, o) => nodeFs.rmSync(p, o),
  mkdirSync: (p, o) => {
    nodeFs.mkdirSync(p, o);
  },
};
const img = (n: number, thumb = Uint8Array.of(0xff, 0xd8, 7, 0xff, 0xd9)): NormalizedImage => {
  const jpeg = new Uint8Array(n).fill(0x42);
  return {
    jpeg,
    width: 10,
    height: 20,
    sha256: sha(jpeg),
    thumbDataUrl: `data:image/jpeg;base64,${Buffer.from(thumb).toString('base64')}`,
    sourceMime: 'image/png',
  };
};

describe('createMediaCache', () => {
  let root: string;
  let dir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wca-mcache-'));
    dir = join(root, 'media-cache');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('put writes <sha256>.jpg + <sha256>.thumb.jpg and a row; names carry no contact-derived text', () => {
    const repo = memRepo();
    const cache = createMediaCache({ dir, repos: repo, fs: realFs, hash: sha });
    const rec = cache.put(7 as ChatRef, '3EB0FAKE000123', img(100));
    expect(rec).toMatchObject({
      itemId: null,
      chatId: 7,
      waMsgId: '3EB0FAKE000123',
      width: 10,
      height: 20,
      bytes: 100,
    });
    const files = readdirSync(dir).sort();
    // [fix data-integrity-v4-2] keyed on (waMsgId, content sha256) - never the chatRef, which an @lid merge re-keys
    const h = sha(`3EB0FAKE000123|${rec.sha256}`);
    expect(files).toEqual([`${h}.jpg`, `${h}.thumb.jpg`]);
    for (const f of files) {
      expect(f).toMatch(/^[0-9a-f]{64}(\.thumb)?\.jpg$/);
      expect(f).not.toContain('3EB0FAKE');
    }
    expect(repo.rows).toHaveLength(1);
  });

  it('thumb / dataUrl by item (newest row), the item:getImage cap, and null for unknown items or missing files', () => {
    const repo = memRepo();
    const cache = createMediaCache({ dir, repos: repo, fs: realFs, hash: sha });
    expect(cache.thumb(1 as ItemId)).toBeNull();
    expect(cache.dataUrl(1 as ItemId)).toBeNull();
    const a = cache.put(7 as ChatRef, 'A1', img(50));
    repo.mediaCache.upsert({ ...a, itemId: 1 as ItemId });
    const b = cache.put(7 as ChatRef, 'B2', img(60, Uint8Array.of(9, 9)));
    repo.mediaCache.upsert({ ...b, itemId: 1 as ItemId });
    expect(cache.thumb(1 as ItemId)).toBe(`data:image/jpeg;base64,${Buffer.from([9, 9]).toString('base64')}`);
    expect(cache.dataUrl(1 as ItemId)).toBe(
      `data:image/jpeg;base64,${Buffer.from(new Uint8Array(60).fill(0x42)).toString('base64')}`,
    );
    // a re-put keeps the item link and the original createdAt
    const again = cache.put(7 as ChatRef, 'B2', img(61));
    expect(again.itemId).toBe(1);
    expect(again.createdAt).toBe(b.createdAt);
    // above the cap => null
    const big = cache.put(8 as ChatRef, 'C3', img(LIMITS.imageDataUrlMaxBytes + 1));
    repo.mediaCache.upsert({ ...big, itemId: 2 as ItemId });
    expect(cache.dataUrl(2 as ItemId)).toBeNull();
    expect(cache.thumb(2 as ItemId)).not.toBeNull();
    // files removed underneath (retention / purge) => null, never a throw
    rmSync(dir, { recursive: true, force: true });
    expect(cache.thumb(1 as ItemId)).toBeNull();
    expect(cache.dataUrl(1 as ItemId)).toBeNull();
  });

  it('an empty thumbnail file or JPEG file => null', () => {
    const repo = memRepo();
    const emptyFs: MediaCacheFs = { ...realFs, readFileSync: () => new Uint8Array(0) };
    const cache = createMediaCache({ dir, repos: repo, fs: emptyFs, hash: sha });
    const r = cache.put(7 as ChatRef, 'A1', img(5));
    repo.mediaCache.upsert({ ...r, itemId: 3 as ItemId });
    expect(cache.thumb(3 as ItemId)).toBeNull();
    expect(cache.dataUrl(3 as ItemId)).toBeNull();
  });

  it('deleteForItem (Dismiss / "Never analyse") removes rows and both files at once', () => {
    const repo = memRepo();
    const cache = createMediaCache({ dir, repos: repo, fs: realFs, hash: sha });
    const a = cache.put(7 as ChatRef, 'A1', img(5));
    repo.mediaCache.upsert({ ...a, itemId: 4 as ItemId });
    const keep = cache.put(7 as ChatRef, 'K9', img(5));
    repo.mediaCache.upsert({ ...keep, itemId: 5 as ItemId });
    expect(cache.deleteForItem(4 as ItemId)).toBe(1);
    const h = sha(`K9|${keep.sha256}`);
    expect(readdirSync(dir).sort()).toEqual([`${h}.jpg`, `${h}.thumb.jpg`]);
    expect(cache.deleteForItem(4 as ItemId)).toBe(0);
  });

  it('a thumbnail that is not a JPEG data URL is refused before anything is written', () => {
    const repo = memRepo();
    const cache = createMediaCache({ dir, repos: repo, fs: realFs, hash: sha });
    expect(() => cache.put(7 as ChatRef, 'A1', { ...img(5), thumbDataUrl: 'data:text/html,<b>x</b>' })).toThrow(
      TypeError,
    );
    expect(repo.rows).toHaveLength(0);
  });
});

// [fix data-integrity-v4-2] mergeLidInto (db/repos/chats.ts) re-keys media_cache.chat_id to the surviving chat. A file name derived
// from the chatRef at put() time is then looked up (thumb/dataUrl) and unlinked (deleteForItem) under the WRONG name: the card loses its
// thumbnail and "View picture", and Dismiss leaves both files on disk with no row naming them. The name must survive the merge.
describe('createMediaCache across an @lid merge (data-integrity-v4-2)', () => {
  let root: string;
  let dir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wca-mcache-merge-'));
    dir = join(root, 'media-cache');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  });

  it('a row re-keyed to another chat keeps its thumbnail / picture, and deleteForItem still removes both files', () => {
    const repo = memRepo();
    const cache = createMediaCache({ dir, repos: repo, fs: realFs, hash: sha });
    const rec = cache.put(7 as ChatRef, 'IMGMSG0002', img(64));
    repo.mediaCache.upsert({ ...rec, itemId: 11 as ItemId });
    const before = { thumb: cache.thumb(11 as ItemId), full: cache.dataUrl(11 as ItemId) };
    expect(before.thumb).not.toBeNull();
    // what chats.ts mergeLidInto does: UPDATE OR IGNORE media_cache SET chat_id = <target> WHERE chat_id = <lid>
    repo.rows[0] = { ...repo.rows[0]!, chatId: 9 as ChatRef };
    expect({ thumb: cache.thumb(11 as ItemId), full: cache.dataUrl(11 as ItemId) }).toEqual(before);
    expect(cache.deleteForItem(11 as ItemId)).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('end to end over the real repos: an @lid chat with a picture card merges into an existing phone-JID chat', () => {
    const { repos } = memRepos();
    const lid = repos.chats.upsertFromBridge(LID_JID, null, true, T0 as EpochMs);
    seedChat(repos, JID_B);
    const item = seedOpenItem(repos, lid.id);
    const cache = createMediaCache({ dir, repos, fs: realFs, hash: sha });
    const rec = cache.put(lid.id, 'IMGMSG0002', img(64));
    repos.mediaCache.upsert({ ...rec, itemId: item.id }); // compose.pickImage's link
    expect(cache.thumb(item.id)).not.toBeNull();

    repos.chats.mergeLidInto(lid.id, JID_B, (T0 + 100_000) as EpochMs);

    expect(repos.mediaCache.forItem(item.id)[0]?.chatId).not.toBe(lid.id); // the row really was re-keyed
    const thumbAfterMerge = cache.thumb(item.id) !== null;
    const pictureAfterMerge = cache.dataUrl(item.id) !== null;
    const deleted = cache.deleteForItem(item.id); // Dismiss
    expect({ thumbAfterMerge, pictureAfterMerge, deleted, filesLeft: readdirSync(dir).length }).toEqual({
      thumbAfterMerge: true,
      pictureAfterMerge: true,
      deleted: 1,
      filesLeft: 0,
    });
  });

  it('a re-put of the same message with different bytes leaves no superseded files behind', () => {
    const repo = memRepo();
    const cache = createMediaCache({ dir, repos: repo, fs: realFs, hash: sha });
    const a = cache.put(7 as ChatRef, 'IMGMSG0003', img(64));
    repo.mediaCache.upsert({ ...a, itemId: 12 as ItemId });
    cache.put(7 as ChatRef, 'IMGMSG0003', img(65)); // e.g. a re-triage after the normaliser changed its output
    expect(readdirSync(dir)).toHaveLength(2);
    expect(cache.dataUrl(12 as ItemId)).toBe(
      `data:image/jpeg;base64,${Buffer.from(new Uint8Array(65).fill(0x42)).toString('base64')}`,
    );
    expect(cache.deleteForItem(12 as ItemId)).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });
});
