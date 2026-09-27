// SCRATCH - skeptic verification of data-integrity-3, part 2. No product file is touched.
import { describe, it, expect, afterEach } from 'vitest';
import { createRepos, openDb, type Db, type Repos } from '../../../src/main/db/index';

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
const PHONE = '972550000009@s.whatsapp.net';
const LID = '10000000000001@lid';

describe('data-integrity-3 part 2', () => {
  it('D: superseded @lid item keeps analysis=queued forever -> permanent phantom analysing count', () => {
    const { repos } = mem();
    const phone = repos.chats.upsertFromBridge(PHONE, null, true, T0);
    const lid = repos.chats.upsertFromBridge(LID, null, true, T0);
    // phone side: an open raw card (held) so it really is an open item
    const phoneItem = repos.items.createOpen({ chatId: phone.id, triggerMsgId: 'm-new', triggerTs: T0 + 100, analysis: 'held', holdReason: 'paused', now: T0 });
    expect(repos.items.openForChat(phone.id)!.id).toBe(phoneItem.id);
    const lidItem = repos.items.createOpen({ chatId: lid.id, triggerMsgId: 'm-old', triggerTs: T0, analysis: 'queued', holdReason: null, now: T0 });
    repos.queue.enqueue(lid.id, T0);
    repos.chats.mergeLidInto(lid.id, PHONE, T0 + 200);
    const moved = repos.items.byId(lidItem.id)!;
    expect(moved.closedReason).toBe('superseded');
    expect(moved.analysis).toBe('queued');
    expect(repos.queue.size()).toBe(0);
    // expireOld never touches a closed item, so the counter never clears
    repos.items.expireOld(T0 + 400 * 24 * 3600_000);
    expect(repos.items.counts().analysing).toBe(1);
  });

  it('E: the SCAN path (handleChat) re-enqueues after its merge - only resolveLidChats() strands the item', () => {
    // documents the asymmetry: ingest.handleChat calls mergeLidInto then handleInbound -> queue.enqueue(target)
    const { repos } = mem();
    const phone = repos.chats.upsertFromBridge(PHONE, null, true, T0);
    const lid = repos.chats.upsertFromBridge(LID, null, true, T0);
    repos.items.createOpen({ chatId: lid.id, triggerMsgId: 'm1', triggerTs: T0, analysis: 'queued', holdReason: null, now: T0 });
    repos.queue.enqueue(lid.id, T0);
    repos.chats.mergeLidInto(lid.id, PHONE, T0 + 1);
    expect(repos.queue.size()).toBe(0);
    repos.queue.enqueue(phone.id, T0 + 1); // what handleInbound would do
    expect(repos.queue.size()).toBe(1);
  });
});
