// SCRATCH - adversarial review, lens "data-integrity". NOT part of the product suite; no product file is touched.
// Run: npx vitest run --config ops/agent-notes/review-data-integrity.scratch/vitest.scratch.config.ts
import { describe, it, expect, afterEach } from 'vitest';
import { createRepos, openDb, type Db, type Repos } from '../../../src/main/db/index';
import { runRetention } from '../../../src/main/db/retention';
import type { Settings } from '../../../src/shared/settings';
import type { ActionPayload } from '../../../src/shared/schemas';

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

/** chat + item + proposal + a send_reply action that FAILED and got the executor's retry clone (exec/actionExecutor.ts cloneForRetry). */
function seedRetryChain(repos: Repos, jid = '972550000001@s.whatsapp.net', now = T0) {
  const chat = repos.chats.upsertFromBridge(jid, null, true, now);
  const item = repos.items.createOpen({ chatId: chat.id, triggerMsgId: 'm1', triggerTs: now, analysis: 'queued', holdReason: null, now });
  const proposal = repos.proposals.insertNext({
    itemId: item.id, provider: 'local', model: 'm', extraction: null, draftText: 'd',
    replyLang: 'en', event: null, freeBusy: null, suspicious: false, createdAt: now,
  });
  const payload: ActionPayload = {
    v: 1, kind: 'send_reply', itemId: item.id, chatRef: chat.id, proposalVersion: proposal.version, text: 'ok',
  };
  const a1 = repos.actions.insertPending({ itemId: item.id, proposalId: proposal.id, chatId: chat.id, payload, now });
  expect(repos.actions.markApprovedExecuting(a1.id, JSON.stringify(payload), now)).toBe('ok');
  repos.actions.markFailed(a1.id, 'SEND_FAILED', now);
  const a2 = repos.actions.insertPending({ itemId: item.id, proposalId: proposal.id, chatId: chat.id, payload, now, retryOf: a1.id });
  return { chat, item, proposal, a1, a2 };
}

describe('data-integrity-1 | retention can never delete a closed item that has a retry chain', () => {
  it('repos.retention.purge() aborts (ON DELETE SET NULL on actions.retry_of trips trg_actions_frozen)', () => {
    const { repos } = mem();
    const { item } = seedRetryChain(repos);
    repos.items.update(item.id, { closedReason: 'dismissed', closedAt: T0 }, T0);
    expect(() => repos.retention.purge({ before: T0 + 1, closedBefore: T0 + 1 })).not.toThrow();
  });

  it('the daily runRetention() job therefore throws and purges NOTHING', () => {
    const { repos } = mem();
    const { item } = seedRetryChain(repos);
    repos.items.update(item.id, { closedReason: 'dismissed', closedAt: T0 }, T0);
    const settings = (): Settings => ({ privacy: { retentionDays: 0 } } as unknown as Settings);
    expect(() => runRetention({ repos, settings, now: () => T0 + 200 * 24 * 3600_000 })).not.toThrow();
  });

  it('control: the same purge succeeds when no action has a retry_of parent', () => {
    const { repos } = mem();
    const chat = repos.chats.upsertFromBridge('972550000002@s.whatsapp.net', null, true, T0);
    const item = repos.items.createOpen({ chatId: chat.id, triggerMsgId: 'm1', triggerTs: T0, analysis: 'queued', holdReason: null, now: T0 });
    repos.items.update(item.id, { closedReason: 'dismissed', closedAt: T0 }, T0);
    expect(() => repos.retention.purge({ before: T0 + 1, closedBefore: T0 + 1 })).not.toThrow();
  });
});

describe('data-integrity-2 | chats.mergeLidInto aborts on the same trigger', () => {
  it('LID merge throws when the @lid chat holds a retry chain', () => {
    const { repos } = mem();
    const phone = repos.chats.upsertFromBridge('972550000009@s.whatsapp.net', null, true, T0);
    const { chat: lid } = seedRetryChain(repos, '10000000000001@lid');
    expect(() => repos.chats.mergeLidInto(lid.id, phone.jid, T0)).not.toThrow();
  });
});

describe('data-integrity-3 | mergeLidInto drops the pending triage of the merged chat', () => {
  it('the @lid queue row is deleted and never re-created on the surviving chat', () => {
    const { repos } = mem();
    const now = T0;
    const phone = repos.chats.upsertFromBridge('972550000009@s.whatsapp.net', null, true, now);
    const lid = repos.chats.upsertFromBridge('10000000000001@lid', null, true, now);
    const item = repos.items.createOpen({ chatId: lid.id, triggerMsgId: 'm1', triggerTs: now, analysis: 'queued', holdReason: null, now });
    repos.queue.enqueue(lid.id, now);
    expect(repos.queue.size()).toBe(1);
    repos.chats.mergeLidInto(lid.id, phone.jid, now);
    const moved = repos.items.byId(item.id)!;
    expect(moved.chatId).toBe(phone.id);
    expect(moved.analysis).toBe('queued'); // still waiting for the LLM
    expect(repos.queue.size()).toBe(1); // ...but nothing is queued any more
  });
});

describe('data-integrity-4 | re-opening an item can violate ux_items_open', () => {
  it('items.update(closedReason:null) on an "ignored" item throws when the chat already has an open item', () => {
    const { repos } = mem();
    const chat = repos.chats.upsertFromBridge('972550000003@s.whatsapp.net', null, true, T0);
    // A: analysed, nothing to do -> state 'ignored' WITH closed_reason NULL (agent/resolve.ts closureFor returns null
    // whenever needsCalendarChangeBadge() is true, or when needsReply is true but the draft was scrubbed away).
    const a = repos.items.createOpen({ chatId: chat.id, triggerMsgId: 'm1', triggerTs: T0, analysis: 'queued', holdReason: null, now: T0 });
    const closedA = repos.items.update(a.id, { analysis: 'done', replyState: 'none', eventState: 'none' }, T0);
    expect(closedA.state).toBe('ignored');
    expect(closedA.closedReason).toBeNull();
    // B: the next message opens a second item for the same chat (allowed: A is not open)
    const b = repos.items.createOpen({ chatId: chat.id, triggerMsgId: 'm2', triggerTs: T0 + 1, analysis: 'queued', holdReason: null, now: T0 + 1 });
    expect(repos.items.openForChat(chat.id)!.id).toBe(b.id);
    // agent/items.ts retriage() guards with `item.closedReason !== null && open !== null` - which is FALSE here, so it
    // proceeds straight to this update:
    expect(() =>
      repos.items.update(a.id, { analysis: 'queued', holdReason: null, errorCode: null, closedReason: null, closedAt: null }, T0 + 2),
    ).not.toThrow();
  });
});

describe('data-integrity-7 | retention strips the text of a LIVE older_message card', () => {
  it('item_messages.text is nulled by the WhatsApp timestamp, not by capture time', () => {
    const { repos } = mem();
    const now = T0;
    const chat = repos.chats.upsertFromBridge('972550000004@s.whatsapp.net', null, true, now);
    // ingest marks a row older than LIMITS.ingestMaxAgeMs (7 d) as "older" -> raw card the user must still act on
    const oldTs = now - 8 * 24 * 3600_000;
    const item = repos.items.createOpen({ chatId: chat.id, triggerMsgId: 'm1', triggerTs: oldTs, analysis: 'held', holdReason: null, now });
    repos.items.snapshotMessages(item.id, [
      { itemId: item.id, waMsgId: 'm1', fromMe: false, ts: oldTs, text: 'trigger', textSha256: 'b'.repeat(64) },
    ]);
    // the daily job with the MINIMUM allowed retention (7 days)
    repos.retention.purge({ before: now - 7 * 24 * 3600_000, closedBefore: now - 90 * 24 * 3600_000 });
    expect(repos.items.byId(item.id)!.state).toBe('needs_reply'); // card still open and actionable
    expect(repos.items.messages(item.id)[0]!.text).not.toBeNull(); // ...but its text is gone
  });
});

describe('data-integrity-6 | a done send whose item consequence was lost is never repaired', () => {
  it('no startup pass looks at done actions whose item still says reply_state=draft', () => {
    const { repos } = mem();
    const { item, a2 } = seedRetryChain(repos, '972550000005@s.whatsapp.net');
    repos.items.update(item.id, { analysis: 'done', replyState: 'draft' }, T0);
    const payload = JSON.parse(a2.canonicalJson) as unknown;
    expect(repos.actions.markApprovedExecuting(a2.id, JSON.stringify(payload), T0)).toBe('ok');
    repos.actions.markDone(a2.id, { kind: 'send_reply', waMsgId: null }, T0); // crash before outcome.applySendSuccess
    // recoverOnStartup() only scans state='executing'
    expect(repos.actions.executing()).toHaveLength(0);
    const after = repos.items.byId(item.id)!;
    expect(after.replyState).toBe('sent'); // still 'draft' -> the next triage drafts and offers to send AGAIN
  });
});
