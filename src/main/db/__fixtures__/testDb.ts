// src/main/db/__fixtures__/testDb.ts - shared fixtures for the colocated db tests (owner W1-04).
// T5: every JID is synthetic (9725500000NN@s.whatsapp.net) and no fixture carries real message text.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRepos, openDb, type Db, type Repos } from '../index';
import type * as T from '../../../shared/types';
import { DEFAULT_AUTO_SCOPE } from '../../../shared/schemas';
import type { ActionPayload, AutoPolicyConfirm, EventContentWithStatus } from '../../../shared/schemas';

const opened: Db[] = [];
const dirs: string[] = [];

export const T0 = 1_760_000_000_000; // a fixed EpochMs so every test reads like a clock, never like "now"
export const JID_A = '972550000001@s.whatsapp.net';
export const JID_B = '972550000002@s.whatsapp.net';
export const LID_JID = '10000000000001@lid';

export function track(db: Db): Db {
  opened.push(db);
  return db;
}
export function memDb(): Db {
  return track(openDb(':memory:'));
}
export function memRepos(): { db: Db; repos: Repos } {
  const db = memDb();
  return { db, repos: createRepos(db) };
}
export function fileRepos(dir: string): { db: Db; repos: Repos; dbPath: string } {
  const dbPath = path.join(dir, 'app.db');
  const db = track(openDb(dbPath));
  return { db, repos: createRepos(db), dbPath };
}
export function tempDir(prefix = 'wca-db-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
/** afterEach hook: closes every tracked handle (TESTS T7 leak guard) and removes every temp directory. */
export function cleanup(): void {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed by the test itself */
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may still hold a handle; the OS cleans the temp dir later */
    }
  }
}

export function seedChat(repos: Repos, jid = JID_A, now: T.EpochMs = T0): T.Chat {
  return repos.chats.upsertFromBridge(jid, null, true, now);
}
export function seedOpenItem(repos: Repos, chatId: T.ChatRef, now: T.EpochMs = T0, msgId = 'm1'): T.Item {
  return repos.items.createOpen({
    chatId,
    triggerMsgId: msgId,
    triggerTs: now,
    analysis: 'queued',
    holdReason: null,
    now,
  });
}
export function seedProposal(repos: Repos, itemId: T.ItemId, now: T.EpochMs = T0): T.Proposal {
  return repos.proposals.insertNext({
    itemId,
    provider: 'local',
    model: 'test-model',
    extraction: null,
    draftText: 'draft',
    replyLang: 'en',
    event: null,
    freeBusy: null,
    suspicious: false,
    createdAt: now,
  });
}
/** A complete chat + item + proposal + pending send_reply action. */
export function seedPendingAction(
  repos: Repos,
  now: T.EpochMs = T0,
  text = 'ok',
): { chat: T.Chat; item: T.Item; proposal: T.Proposal; action: T.ApprovalAction } {
  const chat = seedChat(repos, JID_A, now);
  const item = seedOpenItem(repos, chat.id, now);
  const proposal = seedProposal(repos, item.id, now);
  const action = repos.actions.insertPending({
    itemId: item.id,
    proposalId: proposal.id,
    chatId: chat.id,
    payload: { v: 1, kind: 'send_reply', itemId: item.id, chatRef: chat.id, proposalVersion: proposal.version, text },
    now,
  });
  return { chat, item, proposal, action };
}

/**
 * The shape `exec/actionExecutor.cloneForRetry` leaves behind after a bridge `rejected`/`unreachable`: a TERMINAL `failed`
 * parent plus a `pending` clone whose `retry_of` points at it. Both rows sit on the same item and the same chat.
 */
export function seedRetryChain(
  repos: Repos,
  now: T.EpochMs = T0,
  jid = JID_A,
): { chat: T.Chat; item: T.Item; proposal: T.Proposal; parent: T.ApprovalAction; clone: T.ApprovalAction } {
  const chat = seedChat(repos, jid, now);
  const item = seedOpenItem(repos, chat.id, now);
  const proposal = seedProposal(repos, item.id, now);
  const payload = {
    v: 1,
    kind: 'send_reply',
    itemId: item.id,
    chatRef: chat.id,
    proposalVersion: proposal.version,
    text: 'ok',
  } as const;
  const parent = repos.actions.insertPending({
    itemId: item.id,
    proposalId: proposal.id,
    chatId: chat.id,
    payload,
    now,
  });
  repos.actions.markApprovedExecuting(parent.id, '{"final":1}', now, 'user');
  repos.actions.markFailed(parent.id, 'SEND_FAILED', now);
  const clone = repos.actions.insertPending({
    itemId: item.id,
    proposalId: proposal.id,
    chatId: chat.id,
    payload,
    now,
    retryOf: parent.id,
  });
  return { chat, item, proposal, parent: repos.actions.byId(parent.id)!, clone };
}

// ---------------------------------------------------------------------------------------------------------------------
// [V2, V2-W1-01] fixtures for the v2 repos, the I1' trigger table and retention (T5: synthetic ids and text only)
// ---------------------------------------------------------------------------------------------------------------------
/** Google-alphabet event ids ([a-v0-9]{5,}). */
export const EVT_A = 'evt0000000000000000000000000000a';
export const EVT_B = 'evt0000000000000000000000000000b';

export function content(over: Partial<EventContentWithStatus> = {}): EventContentWithStatus {
  return {
    title: 'Synthetic meeting',
    startLocal: '2026-10-01T10:00:00',
    endLocal: '2026-10-01T11:00:00',
    timeZone: 'Asia/Jerusalem',
    location: '',
    status: 'confirmed',
    ...over,
  };
}

export function createPayload(item: T.Item, proposal: T.Proposal, chat: T.Chat): ActionPayload {
  return {
    v: 1,
    kind: 'create_event',
    itemId: item.id,
    chatRef: chat.id,
    proposalVersion: proposal.version,
    title: 'Synthetic meeting',
    startLocal: '2026-10-01T10:00:00',
    endLocal: '2026-10-01T11:00:00',
    timeZone: 'Asia/Jerusalem',
    location: '',
  };
}

/** chat + open item + proposal + PENDING create_event action. */
export function seedPendingCreate(
  repos: Repos,
  now: T.EpochMs = T0,
  jid = JID_A,
): { chat: T.Chat; item: T.Item; proposal: T.Proposal; action: T.ApprovalAction } {
  const chat = seedChat(repos, jid, now);
  const item = seedOpenItem(repos, chat.id, now, `m-create-${jid}-${now}`);
  const proposal = seedProposal(repos, item.id, now);
  const action = repos.actions.insertPending({
    itemId: item.id,
    proposalId: proposal.id,
    chatId: chat.id,
    payload: createPayload(item, proposal, chat),
    now,
  });
  return { chat, item, proposal, action };
}

/**
 * A created event as the v2 executor leaves it: a DONE create_event (approved by a click unless `approvedBy` says otherwise - only
 * 'user' passes the trigger without a decision) and the item in_calendar with event_state 'created', revision 1, origin = itself.
 */
export function seedCreatedEvent(
  repos: Repos,
  opts: { now?: T.EpochMs; jid?: string; eventId?: string; startTs?: T.EpochMs } = {},
): { chat: T.Chat; item: T.Item; proposal: T.Proposal; action: T.ApprovalAction } {
  const now = opts.now ?? T0;
  const eventId = opts.eventId ?? EVT_A;
  const seeded = seedPendingCreate(repos, now, opts.jid ?? JID_A);
  repos.actions.markApprovedExecuting(seeded.action.id, seeded.action.canonicalJson, now, 'user');
  repos.actions.markDone(seeded.action.id, { kind: 'create_event', eventId, htmlLink: null }, now);
  const item = repos.items.update(
    seeded.item.id,
    {
      analysis: 'done',
      eventState: 'created',
      calendarEventId: eventId,
      eventStartTs: opts.startTs ?? now + 24 * 3600_000,
      eventRevision: 1,
      eventOriginItemId: seeded.item.id,
    },
    now,
  );
  return { ...seeded, item, action: repos.actions.byId(seeded.action.id)! };
}

export function updatePayload(p: {
  item: T.Item;
  chat: T.Chat;
  proposal: T.Proposal;
  targetItemId: T.ItemId;
  eventId?: string;
  baseRevision?: number;
  change?: 'reschedule' | 'move' | 'cancel' | 'undo';
  from?: EventContentWithStatus;
  to?: EventContentWithStatus;
  revertOf?: number;
}): ActionPayload {
  const change = p.change ?? 'reschedule';
  return {
    v: 1,
    kind: 'update_event',
    itemId: p.item.id,
    chatRef: p.chat.id,
    proposalVersion: p.proposal.version,
    targetEventId: p.eventId ?? EVT_A,
    targetItemId: p.targetItemId,
    baseRevision: p.baseRevision ?? 1,
    change,
    from: p.from ?? content(),
    to:
      p.to ??
      (change === 'cancel'
        ? content({ status: 'cancelled' })
        : content({ startLocal: '2026-10-01T15:00:00', endLocal: '2026-10-01T16:00:00' })),
    ...(change === 'undo' ? { revertOf: p.revertOf ?? 1 } : {}),
  };
}

/** A PENDING update_event on a new proposal version of `item` (the acting item may be the source item itself). */
export function seedPendingUpdate(
  repos: Repos,
  base: { chat: T.Chat; item: T.Item },
  opts: Omit<Parameters<typeof updatePayload>[0], 'item' | 'chat' | 'proposal' | 'targetItemId'> & {
    now?: T.EpochMs;
    targetItemId?: T.ItemId;
  } = {},
): { proposal: T.Proposal; action: T.ApprovalAction } {
  const now = opts.now ?? T0;
  const proposal = seedProposal(repos, base.item.id, now);
  const action = repos.actions.insertPending({
    itemId: base.item.id,
    proposalId: proposal.id,
    chatId: base.chat.id,
    payload: updatePayload({
      ...opts,
      item: base.item,
      chat: base.chat,
      proposal,
      targetItemId: opts.targetItemId ?? base.item.id,
    }),
    now,
  });
  return { proposal, action };
}

export const TEST_CONFIRM: AutoPolicyConfirm = {
  dialogResponse: 1,
  checkboxChecked: true,
  windowFocused: true,
  trial: false,
  appVersion: '2.0.0',
  electronVersion: '0.0.0-test',
  approvedCreates: 3,
};

/**
 * A policy row. `trg_actions_state` compares expires_at with the WALL clock (unixepoch('subsec'), F4 (3)), so a policy that must be
 * live for the trigger is anchored at the real `Date.now()`, never at T0.
 */
export function seedPolicy(
  repos: Repos,
  opts: { id?: string; state?: 'shadow' | 'on'; enabledAt?: T.EpochMs; validityMs?: number } = {},
): T.AutoPolicyRecord {
  const enabledAt = opts.enabledAt ?? Date.now() - 60_000;
  const expiresAt = enabledAt + (opts.validityMs ?? 30 * 24 * 3600_000);
  const state = opts.state ?? 'on';
  return repos.autoPolicies.insert({
    id: opts.id ?? `policy-${state}-${enabledAt}`,
    state,
    enabledAt,
    expiresAt,
    shadowUntil: state === 'shadow' ? Math.min(enabledAt + 24 * 3600_000, expiresAt) : enabledAt,
    confirmedBy: 'native_dialog',
    confirm: TEST_CONFIRM,
    scope: DEFAULT_AUTO_SCOPE,
    snapshotSha: 'c'.repeat(64),
  });
}

/** One immutable decision row for `action` (verdict auto => reason ok, unless given). */
export function seedDecision(
  repos: Repos,
  p: {
    id?: string;
    policyId: string;
    action: T.ApprovalAction;
    kind?: T.AutoWriteKind;
    verdict?: T.AutoVerdict;
    reason?: T.AutoReason;
    decidedAt?: T.EpochMs;
  },
): T.AutoDecisionRecord {
  const verdict = p.verdict ?? 'auto';
  const rec: T.AutoDecisionRecord = {
    id: p.id ?? `decision-${p.action.id}`,
    policyId: p.policyId,
    actionId: p.action.id,
    itemId: p.action.itemId,
    chatId: p.action.chatId,
    kind: p.kind ?? (p.action.kind === 'create_event' ? 'create' : 'update'),
    verdict,
    reason: p.reason ?? (verdict === 'fallback' ? 'badge_amber' : 'ok'),
    checks: { horizonDays: 30, perChatToday: 0 },
    decidedAt: p.decidedAt ?? T0,
  };
  repos.autoDecisions.insert(rec);
  return rec;
}
