/**
 * Positive control for data-integrity-6 (scratch; NOT part of the suite).
 *
 * Purpose: prove that the assertion the new regression tests rely on
 * (`actions.byId(id).state === 'executing'` after a throwing item consequence)
 * genuinely DISCRIMINATES between the old three-statement shape and the new
 * single-transaction shape. No product file is touched or mutated.
 *
 * Case A replays the OLD code shape (markDone, then a throwing consequence, ungrouped).
 * Case B replays the NEW code shape (both inside repos.db.transaction).
 */
import { describe, expect, it, afterEach } from 'vitest';
import { MEMORY_DB, createRepos, openDb } from '../../../src/main/db/index';
import type { Db } from '../../../src/main/db/index';
import type { EpochMs, ItemId } from '../../../src/shared/types';

const NOW = Date.UTC(2026, 8, 21, 9, 0, 0) as EpochMs;
const JID = '972550000001@s.whatsapp.net'; // synthetic, never a real number

const openDbs: Db[] = [];
afterEach(() => {
  while (openDbs.length) openDbs.pop()?.close();
});

function seed() {
  const db = openDb(MEMORY_DB);
  openDbs.push(db);
  const repos = createRepos(db);
  const chat = repos.chats.upsertFromBridge(JID, 'Contact', true, NOW);
  const item = repos.items.createOpen({
    chatId: chat.id,
    triggerMsgId: 'm1',
    triggerTs: NOW,
    analysis: 'done',
    holdReason: null,
    now: NOW,
  });
  const proposal = repos.proposals.insertNext({
    itemId: item.id,
    provider: 'user',
    model: 'test',
    extraction: null,
    draftText: 'hi',
    replyLang: 'en',
    event: null,
    freeBusy: null,
    suspicious: false,
    createdAt: NOW,
  });
  const payload = {
    v: 1 as const,
    kind: 'send_reply' as const,
    itemId: item.id as ItemId,
    chatRef: chat.id,
    proposalVersion: 1,
    text: 'See you at five.',
  };
  const action = repos.actions.insertPending({
    itemId: item.id,
    proposalId: proposal.id,
    chatId: chat.id,
    payload: payload as never,
    now: NOW,
  });
  expect(repos.actions.markApprovedExecuting(action.id, action.canonicalJson, NOW)).toBe('ok');
  expect(repos.actions.byId(action.id)?.state).toBe('executing');
  return { db, repos, action, itemId: item.id as ItemId };
}

const RESULT = { kind: 'send_reply' as const, waMsgId: null };
const boom = (): never => {
  throw new Error('items.update exploded');
};

describe('data-integrity-6 positive control', () => {
  it('CASE A - old shape (ungrouped): markDone COMMITS, leaving the torn, unrecoverable `done` row', () => {
    const { repos, action, itemId } = seed();

    expect(() => {
      repos.actions.markDone(action.id, RESULT, NOW); // statement 1 - auto-committed on its own
      boom(); // statement 2 - the item consequence dies here
    }).toThrow('items.update exploded');

    // This is the defect: terminal action, untouched item, invisible to every recovery pass.
    expect(repos.actions.byId(action.id)?.state).toBe('done');
    expect(repos.actions.executing()).toEqual([]);
    expect(repos.items.byId(itemId)?.replyState).toBe('none');
  });

  it('CASE B - new shape (one transaction): markDone ROLLS BACK, so recovery still sees the action', () => {
    const { repos, action, itemId } = seed();

    expect(() =>
      repos.db.transaction(() => {
        repos.actions.markDone(action.id, RESULT, NOW);
        boom();
      }),
    ).toThrow('items.update exploded');

    expect(repos.actions.byId(action.id)?.state).toBe('executing');
    expect(repos.actions.executing().map((a) => a.id)).toEqual([action.id]);
    expect(repos.items.byId(itemId)?.replyState).toBe('none');
  });
});
