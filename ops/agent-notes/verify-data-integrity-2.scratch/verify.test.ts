// SCRATCH - skeptic verification of review finding data-integrity-2. No product file is touched.
// Run: npx vitest run --config ops/agent-notes/verify-data-integrity-2.scratch/vitest.scratch.config.ts
import { describe, it, expect, afterEach } from 'vitest';
import { createRepos, openDb, type Db, type Repos } from '../../../src/main/db/index';
import type { ActionPayload } from '../../../src/shared/schemas';

const T0 = 1_760_000_000_000;
const opened: Db[] = [];
afterEach(() => {
  for (const d of opened.splice(0)) {
    try {
      d.close();
    } catch {
      /* */
    }
  }
});
function mem(): { db: Db; repos: Repos } {
  const db = openDb(':memory:');
  opened.push(db);
  return { db, repos: createRepos(db) };
}

/** @lid chat + item + proposal + a create_event action that FAILED and got the executor's retry clone. */
function seedLidWithRetryChain(repos: Repos, jid: string, now = T0) {
  const chat = repos.chats.upsertFromBridge(jid, null, true, now);
  const item = repos.items.createOpen({
    chatId: chat.id,
    triggerMsgId: 'm1',
    triggerTs: now,
    analysis: 'queued',
    holdReason: null,
    now,
  });
  const proposal = repos.proposals.insertNext({
    itemId: item.id,
    provider: 'local',
    model: 'm',
    extraction: null,
    draftText: null,
    replyLang: null,
    event: null,
    freeBusy: null,
    suspicious: false,
    createdAt: now,
  });
  const payload: ActionPayload = {
    v: 1,
    kind: 'create_event',
    itemId: item.id,
    chatRef: chat.id,
    proposalVersion: proposal.version,
    title: 'x',
    startLocal: '2026-01-02T10:00:00',
    endLocal: '2026-01-02T11:00:00',
    timeZone: 'UTC',
    location: '',
  };
  const a1 = repos.actions.insertPending({
    itemId: item.id,
    proposalId: proposal.id,
    chatId: chat.id,
    payload,
    now,
  });
  expect(repos.actions.markApprovedExecuting(a1.id, JSON.stringify(payload), now)).toBe('ok');
  repos.actions.markFailed(a1.id, 'CAL_UNAVAILABLE', now); // executor markFailure()
  const a2 = repos.actions.insertPending({
    itemId: item.id,
    proposalId: proposal.id,
    chatId: chat.id,
    payload,
    now,
    retryOf: a1.id,
  }); // executor cloneForRetry()
  return { chat, item, proposal, a1, a2 };
}

describe('data-integrity-2 verification', () => {
  it('A. does mergeLidInto throw when the @lid chat holds failed+pending retry chain?', () => {
    const { repos } = mem();
    repos.chats.upsertFromBridge('972550000009@s.whatsapp.net', null, true, T0);
    const { chat: lid, a1, a2 } = seedLidWithRetryChain(repos, '10000000000001@lid');
    expect(repos.actions.byId(a1.id)!.state).toBe('failed');
    expect(repos.actions.byId(a2.id)!.state).toBe('pending');
    expect(repos.actions.byId(a2.id)!.retryOf).toBe(a1.id);
    let thrown: unknown = null;
    try {
      repos.chats.mergeLidInto(lid.id, '972550000009@s.whatsapp.net', T0);
    } catch (e) {
      thrown = e;
    }
    // eslint-disable-next-line no-console
    console.log('A thrown =', thrown === null ? 'NOTHING' : String(thrown));
    expect(thrown).toBe(null);
  });

  it('B. control: no retry chain (single failed action) merges fine', () => {
    const { repos } = mem();
    repos.chats.upsertFromBridge('972550000008@s.whatsapp.net', null, true, T0);
    const chat = repos.chats.upsertFromBridge('10000000000002@lid', null, true, T0);
    const item = repos.items.createOpen({
      chatId: chat.id,
      triggerMsgId: 'm1',
      triggerTs: T0,
      analysis: 'queued',
      holdReason: null,
      now: T0,
    });
    const proposal = repos.proposals.insertNext({
      itemId: item.id,
      provider: 'local',
      model: 'm',
      extraction: null,
      draftText: null,
      replyLang: null,
      event: null,
      freeBusy: null,
      suspicious: false,
      createdAt: T0,
    });
    const payload: ActionPayload = {
      v: 1,
      kind: 'create_event',
      itemId: item.id,
      chatRef: chat.id,
      proposalVersion: proposal.version,
      title: 'x',
      startLocal: '2026-01-02T10:00:00',
      endLocal: '2026-01-02T11:00:00',
      timeZone: 'UTC',
      location: '',
    };
    repos.actions.insertPending({ itemId: item.id, proposalId: proposal.id, chatId: chat.id, payload, now: T0 });
    let thrown: unknown = null;
    try {
      repos.chats.mergeLidInto(chat.id, '972550000008@s.whatsapp.net', T0);
    } catch (e) {
      thrown = e;
    }
    // eslint-disable-next-line no-console
    console.log('B thrown =', thrown === null ? 'NOTHING' : String(thrown));
    expect(thrown).toBe(null);
  });

  it('C. raw SQLite: does ON DELETE SET NULL fire the BEFORE UPDATE OF retry_of trigger?', () => {
    const { db, repos } = mem();
    repos.chats.upsertFromBridge('972550000007@s.whatsapp.net', null, true, T0);
    const { chat: lid, a1, a2 } = seedLidWithRetryChain(repos, '10000000000003@lid');
    let thrownParentFirst: unknown = null;
    try {
      db.prepare(`DELETE FROM actions WHERE id = ?`).run(a1.id);
    } catch (e) {
      thrownParentFirst = e;
    }
    // eslint-disable-next-line no-console
    console.log('C parent-first delete =', thrownParentFirst === null ? 'NOTHING' : String(thrownParentFirst));
    // child-first order would be safe; prove the bulk statement's scan order picks the parent first
    const order = db.prepare<{ id: string; rid: number }>(`SELECT id, rowid AS rid FROM actions ORDER BY rowid`).all();
    // eslint-disable-next-line no-console
    console.log('C rowid order =', JSON.stringify(order), 'a1=', a1.id, 'a2=', a2.id, 'lid=', lid.id);
    expect(thrownParentFirst).toBe(null);
  });
});
