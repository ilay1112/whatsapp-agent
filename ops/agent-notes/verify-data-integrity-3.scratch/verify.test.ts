// SCRATCH - skeptic verification of review finding data-integrity-3. No product file is touched.
import { describe, it, expect, afterEach } from 'vitest';
import { createRepos, openDb, type Db, type Repos } from '../../../src/main/db/index';
import { isListed } from '../../../src/shared/state';

const T0 = 1_760_000_000_000;
const opened: Db[] = [];
afterEach(() => {
  for (const d of opened.splice(0)) try { d.close(); } catch { /* */ }
});
function mem(): { db: Db; repos: Repos } {
  const db = openDb(':memory:');
  opened.push(db);
  return { db, repos: createRepos(db) };
}

describe('data-integrity-3 verification', () => {
  it('A: lid queue row is destroyed, moved item stays queued, nothing re-queues it', () => {
    const { repos } = mem();
    const phone = repos.chats.upsertFromBridge('972550000009@s.whatsapp.net', null, true, T0);
    const lid = repos.chats.upsertFromBridge('10000000000001@lid', null, true, T0);
    const item = repos.items.createOpen({
      chatId: lid.id, triggerMsgId: 'm1', triggerTs: T0, analysis: 'queued', holdReason: null, now: T0,
    });
    repos.queue.enqueue(lid.id, T0);
    expect(repos.queue.size()).toBe(1);

    repos.chats.mergeLidInto(lid.id, phone.jid, T0 + 1);

    const moved = repos.items.byId(item.id)!;
    expect(moved.chatId).toBe(phone.id);
    expect(moved.analysis).toBe('queued');
    // the queue row is gone everywhere
    expect(repos.queue.size()).toBe(0);
    expect(repos.queue.nextDue(T0 + 10_000_000)).toBeNull();
    // phantom counter: counted as analysing, listed nowhere
    expect(repos.items.counts().analysing).toBe(1);
    expect(repos.items.list('needs_reply', 50)).toEqual([]);
    expect(isListed(moved.analysis)).toBe(false);
    // recoverRunning (startup rescue) does NOT pick it up
    expect(repos.items.recoverRunning(T0 + 2)).toBe(0);
    expect(repos.queue.size()).toBe(0);
    // ...and 7 days later it is silently expired
    repos.items.expireOld(T0 + 8 * 24 * 3600_000);
    expect(repos.items.byId(item.id)!.closedReason).toBe('expired');
  });

  it('B: same loss when the target chat had its OWN pending queue row? (target row survives)', () => {
    const { repos } = mem();
    const phone = repos.chats.upsertFromBridge('972550000009@s.whatsapp.net', null, true, T0);
    const lid = repos.chats.upsertFromBridge('10000000000001@lid', null, true, T0);
    repos.queue.enqueue(phone.id, T0);
    repos.items.createOpen({ chatId: lid.id, triggerMsgId: 'm1', triggerTs: T0, analysis: 'queued', holdReason: null, now: T0 });
    repos.queue.enqueue(lid.id, T0 - 10_000);
    repos.chats.mergeLidInto(lid.id, phone.jid, T0 + 1);
    expect(repos.queue.size()).toBe(1);
    const due = repos.queue.nextDue(T0 + 10_000_000)!;
    expect(due.chatId).toBe(phone.id);
  });

  // C (corrected): an analysis='done' item with no draft/event derives state 'ignored', so it is NOT an open item and
  // there is no supersede race at all - the @lid item simply moves across and strands. The real supersede case is in
  // verify2.test.ts test D, which needs a genuinely OPEN item (analysis='held') on the phone side.
  it('C: no open item on the phone side => the queued @lid item moves across and strands', () => {
    const { repos } = mem();
    const phone = repos.chats.upsertFromBridge('972550000009@s.whatsapp.net', null, true, T0);
    const lid = repos.chats.upsertFromBridge('10000000000001@lid', null, true, T0);
    repos.items.createOpen({ chatId: phone.id, triggerMsgId: 'm-new', triggerTs: T0 + 100, analysis: 'done', holdReason: null, now: T0 });
    expect(repos.items.openForChat(phone.id)).toBeNull();
    const lidItem = repos.items.createOpen({ chatId: lid.id, triggerMsgId: 'm-old', triggerTs: T0, analysis: 'queued', holdReason: null, now: T0 });
    repos.queue.enqueue(lid.id, T0);
    repos.chats.mergeLidInto(lid.id, phone.jid, T0 + 200);
    expect(repos.items.byId(lidItem.id)!.closedReason).toBeNull();
    expect(repos.items.byId(lidItem.id)!.analysis).toBe('queued');
    expect(repos.queue.size()).toBe(0);
    expect(repos.items.counts().analysing).toBe(1);
  });
});
