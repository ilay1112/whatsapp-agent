// src/main/db/__fixtures__/testDb.ts - shared fixtures for the colocated db tests (owner W1-04).
// T5: every JID is synthetic (9725500000NN@s.whatsapp.net) and no fixture carries real message text.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRepos, openDb, type Db, type Repos } from '../index';
import type * as T from '../../../shared/types';

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
  repos.actions.markApprovedExecuting(parent.id, '{"final":1}', now);
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
