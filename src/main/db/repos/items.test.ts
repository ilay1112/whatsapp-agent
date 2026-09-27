// TESTS 5.3 row `db/*`: items.update is the only writer of items.state (always = deriveState()), `ux_items_open` allows exactly
// one open item per chat, and the list / counts / hold / expiry queries of ARCHITECTURE 6.1 and 7.
import { afterEach, describe, expect, it } from 'vitest';
import { RowNotFoundError } from '../index';
import { cleanup, JID_A, JID_B, memRepos, seedChat, seedOpenItem, T0 } from '../__fixtures__/testDb';
import { PAST_EVENT_GRACE_MS } from './items';
import { deriveState } from '../../../shared/state';
import { LIMITS } from '../../../shared/types';
import type * as T from '../../../shared/types';

afterEach(cleanup);

describe('items repo - state derivation', () => {
  it('createOpen stores the derived state and defaults', () => {
    const { repos } = memRepos();
    const chat = seedChat(repos);
    const item = repos.items.createOpen({
      chatId: chat.id,
      triggerMsgId: 'm1',
      triggerTs: T0,
      analysis: 'held',
      holdReason: 'unknown_sender',
      now: T0,
    });
    expect(item.state).toBe('needs_reply');
    expect(item).toMatchObject({
      analysis: 'held',
      holdReason: 'unknown_sender',
      replyState: 'none',
      eventState: 'none',
      missing: [],
      badges: [],
      editingUntil: 0,
      closedReason: null,
      closedAt: null,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(repos.items.openForChat(chat.id)!.id).toBe(item.id);
  });

  it.each([
    [{ analysis: 'done', replyState: 'draft' }, 'needs_reply'],
    [{ analysis: 'done', eventState: 'incomplete' }, 'info_missing'],
    [{ analysis: 'done', eventState: 'proposed' }, 'needs_reply'],
    [{ analysis: 'done', eventState: 'created' }, 'in_calendar'],
    [{ analysis: 'done' }, 'ignored'],
    [{ analysis: 'failed' }, 'needs_reply'],
    [{ analysis: 'done', replyState: 'draft', closedReason: 'dismissed' }, 'ignored'],
  ] as Array<[Partial<T.Item>, T.ItemState]>)('update(%o) recomputes state = %s', (patch, expected) => {
    const { repos } = memRepos();
    const chat = seedChat(repos);
    const item = seedOpenItem(repos, chat.id);
    const updated = repos.items.update(item.id, patch, T0 + 1);
    expect(updated.state).toBe(expected);
    expect(updated.state).toBe(deriveState(updated));
    expect(repos.items.byId(item.id)!.state).toBe(expected);
    expect(updated.updatedAt).toBe(T0 + 1);
  });

  it('closing stamps closed_at once and re-opening clears it', () => {
    const { repos } = memRepos();
    const item = seedOpenItem(repos, seedChat(repos).id);
    const closed = repos.items.update(item.id, { closedReason: 'dismissed' }, T0 + 5);
    expect(closed).toMatchObject({ state: 'ignored', closedReason: 'dismissed', closedAt: T0 + 5 });
    const again = repos.items.update(item.id, { analysis: 'done' }, T0 + 6);
    expect(again.closedAt).toBe(T0 + 5); // unchanged while the item stays closed
    const restored = repos.items.update(item.id, { closedReason: null }, T0 + 7);
    expect(restored.closedAt).toBeNull();
    expect(restored.state).toBe('ignored'); // analysis done, nothing proposed
    const explicit = repos.items.update(item.id, { closedReason: 'expired', closedAt: T0 + 99 }, T0 + 8);
    expect(explicit.closedAt).toBe(T0 + 99);
  });

  it('ignores undefined patch keys and refuses an unknown item', () => {
    const { repos } = memRepos();
    const item = seedOpenItem(repos, seedChat(repos).id);
    const patched = repos.items.update(
      item.id,
      { analysis: undefined, badges: ['conflict'], missing: ['time'] },
      T0 + 1,
    );
    expect(patched.analysis).toBe('queued');
    expect(patched.badges).toEqual(['conflict']);
    expect(patched.missing).toEqual(['time']);
    expect(() => repos.items.update(item.id + 999, { analysis: 'done' }, T0)).toThrow(RowNotFoundError);
    expect(repos.items.byId(item.id + 999)).toBeNull();
  });

  it('ux_items_open rejects a second open item per chat and allows one after in_calendar', () => {
    const { repos } = memRepos();
    const chat = seedChat(repos);
    const first = seedOpenItem(repos, chat.id);
    expect(() => seedOpenItem(repos, chat.id, T0 + 1, 'm2')).toThrow(/UNIQUE/);
    repos.items.update(
      first.id,
      { analysis: 'done', eventState: 'created', calendarEventId: 'evt', eventStartTs: T0 },
      T0 + 1,
    );
    expect(repos.items.byId(first.id)!.state).toBe('in_calendar');
    const second = seedOpenItem(repos, chat.id, T0 + 2, 'm2');
    expect(repos.items.openForChat(chat.id)!.id).toBe(second.id);
  });
});

describe('items repo - queries', () => {
  const build = (): ReturnType<typeof memRepos> => {
    const ctx = memRepos();
    const a = seedChat(ctx.repos, JID_A);
    const b = seedChat(ctx.repos, JID_B, T0);
    const listed = seedOpenItem(ctx.repos, a.id, T0, 'm1');
    ctx.repos.items.update(listed.id, { analysis: 'done', replyState: 'draft' }, T0 + 2);
    seedOpenItem(ctx.repos, b.id, T0 + 1, 'm2'); // analysis 'queued' => counted, never listed
    return ctx;
  };

  it('list() shows only analysis in (done, held, failed), newest first', () => {
    const { repos } = build();
    const rows = repos.items.list('needs_reply', 20);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.analysis).toBe('done');
    expect(repos.items.list('needs_reply', 0)).toEqual([]);
  });

  it('counts() splits the lists from the analysing bucket', () => {
    const { repos } = build();
    expect(repos.items.counts()).toEqual({ needsReply: 1, inCalendar: 0, infoMissing: 0, ignored: 0, analysing: 1 });
  });

  it('counts() sees every bucket', () => {
    const { repos } = memRepos();
    const chats = [JID_A, JID_B, '972550000003@s.whatsapp.net', '972550000004@s.whatsapp.net'].map((j) =>
      seedChat(repos, j),
    );
    const items = chats.map((c, i) => seedOpenItem(repos, c.id, T0 + i, `m${i}`));
    repos.items.update(items[0]!.id, { analysis: 'done', replyState: 'draft' }, T0);
    repos.items.update(items[1]!.id, { analysis: 'done', eventState: 'incomplete' }, T0);
    repos.items.update(items[2]!.id, { analysis: 'done', eventState: 'created' }, T0);
    repos.items.update(items[3]!.id, { analysis: 'done', closedReason: 'not_needed' }, T0);
    expect(repos.items.counts()).toEqual({ needsReply: 1, inCalendar: 1, infoMissing: 1, ignored: 1, analysing: 0 });
  });

  /**
   * Regression, data-integrity-3 (test D): `analysing` is the header's "Analysing N chats..." - live work, not history. A row
   * that closes while it is still queued (superseded by an @lid merge, expired by expireOld, dismissed) keeps `analysis='queued'`
   * forever, and expireOld() skips closed rows, so the counter used to stick at a number the user could never clear.
   */
  it('counts() ignores a closed item that never finished its analysis', () => {
    const { repos } = memRepos();
    const chat = seedChat(repos, JID_A);
    const item = seedOpenItem(repos, chat.id, T0, 'm1');
    expect(repos.items.counts().analysing).toBe(1);
    repos.items.update(item.id, { closedReason: 'superseded' }, T0 + 1);
    expect(repos.items.byId(item.id)).toMatchObject({ analysis: 'queued', state: 'ignored' });
    expect(repos.items.counts().analysing).toBe(0);
    // expireOld() closes a still-queued item the same way, and that must not leak either
    const other = seedOpenItem(repos, seedChat(repos, JID_B).id, T0 - LIMITS.openItemTtlMs - 1, 'm2');
    expect(repos.items.counts().analysing).toBe(1);
    expect(repos.items.expireOld(T0)).toBe(1);
    expect(repos.items.byId(other.id)!.closedReason).toBe('expired');
    expect(repos.items.counts().analysing).toBe(0);
  });

  it('heldWith() is oldest first and honours the release window', () => {
    const { repos } = memRepos();
    const old = seedOpenItem(repos, seedChat(repos, JID_A).id, T0 - LIMITS.heldReleaseWindowMs - 1, 'm-old');
    const fresh = seedOpenItem(repos, seedChat(repos, JID_B).id, T0 - 1_000, 'm-new');
    repos.items.update(old.id, { analysis: 'held', holdReason: 'waiting_llm' }, T0);
    repos.items.update(fresh.id, { analysis: 'held', holdReason: 'waiting_llm' }, T0);
    expect(repos.items.heldWith('waiting_llm').map((i) => i.id)).toEqual([old.id, fresh.id]);
    expect(
      repos.items.heldWith('waiting_llm', { triggerTsSince: T0 - LIMITS.heldReleaseWindowMs }).map((i) => i.id),
    ).toEqual([fresh.id]);
    expect(repos.items.heldWith('paused')).toEqual([]);
  });

  it('recoverRunning() turns running back into queued at startup', () => {
    const { repos } = memRepos();
    const item = seedOpenItem(repos, seedChat(repos).id);
    repos.items.update(item.id, { analysis: 'running' }, T0);
    expect(repos.items.recoverRunning(T0 + 1)).toBe(1);
    expect(repos.items.byId(item.id)).toMatchObject({ analysis: 'queued', state: 'needs_reply', updatedAt: T0 + 1 });
    expect(repos.items.recoverRunning(T0 + 2)).toBe(0);
  });

  it('expireOld() closes stale open items and past calendar items', () => {
    const { repos } = memRepos();
    const stale = seedOpenItem(repos, seedChat(repos, JID_A).id, T0 - LIMITS.openItemTtlMs - 1, 'm-stale');
    const freshChat = seedChat(repos, JID_B);
    const fresh = seedOpenItem(repos, freshChat.id, T0 - 1_000, 'm-fresh');
    const pastChat = seedChat(repos, '972550000003@s.whatsapp.net');
    const past = seedOpenItem(repos, pastChat.id, T0, 'm-past');
    repos.items.update(
      past.id,
      { analysis: 'done', eventState: 'created', eventStartTs: T0 - PAST_EVENT_GRACE_MS - 1 },
      T0,
    );
    expect(repos.items.expireOld(T0)).toBe(2);
    expect(repos.items.byId(stale.id)).toMatchObject({ state: 'ignored', closedReason: 'expired' });
    expect(repos.items.byId(past.id)).toMatchObject({ state: 'ignored', closedReason: 'past' });
    expect(repos.items.byId(fresh.id)!.state).toBe('needs_reply');
    expect(repos.items.expireOld(T0)).toBe(0);
  });
});

describe('items repo - message snapshot', () => {
  const rows = (itemId: T.ItemId): T.ItemMessage[] => [
    { itemId, waMsgId: 'b', fromMe: true, ts: T0 + 10, text: 'second', textSha256: 'b'.repeat(64) },
    { itemId, waMsgId: 'a', fromMe: false, ts: T0, text: 'first', textSha256: 'a'.repeat(64) },
  ];

  it('snapshotMessages replaces the window and messages() is oldest first', () => {
    const { repos } = memRepos();
    const item = seedOpenItem(repos, seedChat(repos).id);
    repos.items.snapshotMessages(item.id, rows(item.id));
    expect(repos.items.messages(item.id).map((m) => m.waMsgId)).toEqual(['a', 'b']);
    expect(repos.items.messages(item.id)[0]).toEqual({
      itemId: item.id,
      waMsgId: 'a',
      fromMe: false,
      ts: T0,
      text: 'first',
      textSha256: 'a'.repeat(64),
    });
    repos.items.snapshotMessages(item.id, [
      { itemId: item.id, waMsgId: 'c', fromMe: false, ts: T0 + 20, text: null, textSha256: 'c'.repeat(64) },
    ]);
    expect(repos.items.messages(item.id).map((m) => m.waMsgId)).toEqual(['c']);
  });

  it('a *_json column that no longer parses reads as empty instead of crashing the dashboard', () => {
    const { db, repos } = memRepos();
    const item = seedOpenItem(repos, seedChat(repos).id);
    db.prepare(`UPDATE items SET missing_json = ?, badges_json = ? WHERE id = ?`).run('{not json', '', item.id);
    expect(repos.items.byId(item.id)).toMatchObject({ missing: [], badges: [] });
  });

  it('deleting an item cascades its snapshot away', () => {
    const { db, repos } = memRepos();
    const item = seedOpenItem(repos, seedChat(repos).id);
    repos.items.snapshotMessages(item.id, rows(item.id));
    db.prepare(`DELETE FROM items WHERE id = ?`).run(item.id);
    expect(repos.items.messages(item.id)).toEqual([]);
  });
});
