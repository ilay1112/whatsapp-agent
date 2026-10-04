// TESTS 5.3 row `db/*`: the frozen action triggers of CONTRACTS 15.2 (every legal and illegal transition) and the repo's
// compare-and-set contract (`markApprovedExecuting` -> 'stale', the three `markX` -> ActionStateError).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionStateError, RepoContractError, RowNotFoundError, type Db } from '../index';
import { chainKeyOf, sha256Hex, stripRetrySuffix } from './actions';
import {
  cleanup,
  JID_A,
  memRepos,
  seedChat,
  seedOpenItem,
  seedPendingAction,
  seedProposal,
  T0,
} from '../__fixtures__/testDb';
import { canonicalJson } from '../../../shared/schemas';
import { LIMITS } from '../../../shared/types';

afterEach(cleanup);

const FINAL = `{"v":1}`;
/** Drives a row into `state` with plain SQL (the repo refuses most of these on purpose). */
function force(db: Db, id: string, state: string): void {
  if (state === 'pending') return;
  if (state === 'rejected' || state === 'expired' || state === 'superseded') {
    db.prepare(`UPDATE actions SET state=? WHERE id=?`).run(state, id);
    return;
  }
  db.prepare(
    `UPDATE actions SET state='approved', approved_at=?, approved_final_json=?, approved_by='user' WHERE id=?`,
  ).run(T0, FINAL, id);
  if (state === 'approved') return;
  db.prepare(`UPDATE actions SET state='executing' WHERE id=?`).run(id);
  if (state === 'executing') return;
  db.prepare(`UPDATE actions SET state=? WHERE id=?`).run(state, id);
}

describe('actions repo - insertPending', () => {
  it('computes canonical_json, content_sha256, the idempotency key and a 24 h TTL', () => {
    const { repos } = memRepos();
    const { action, item, chat, proposal } = seedPendingAction(repos);
    const payload = {
      v: 1,
      kind: 'send_reply',
      itemId: item.id,
      chatRef: chat.id,
      proposalVersion: proposal.version,
      text: 'ok',
    };
    expect(action.canonicalJson).toBe(canonicalJson(payload));
    expect(action.contentSha256).toBe(sha256Hex(action.canonicalJson));
    expect(action.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(action.idempotencyKey).toBe(`${item.id}:send_reply:1`);
    expect(action.attempt).toBe(1);
    expect(action.retryOf).toBeNull();
    expect(action.state).toBe('pending');
    expect(action.expiresAt).toBe(T0 + LIMITS.actionTtlMs);
    expect(action.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('rejects a payload that does not match the row it is filed under', () => {
    const { repos } = memRepos();
    const chat = seedChat(repos);
    const item = seedOpenItem(repos, chat.id);
    const proposal = seedProposal(repos, item.id);
    const base = { itemId: item.id, proposalId: proposal.id, chatId: chat.id, now: T0 };
    expect(() =>
      repos.actions.insertPending({
        ...base,
        payload: { v: 1, kind: 'send_reply', itemId: item.id + 1, chatRef: chat.id, proposalVersion: 1, text: 'x' },
      }),
    ).toThrow(RepoContractError);
    expect(() =>
      repos.actions.insertPending({
        ...base,
        payload: { v: 1, kind: 'send_reply', itemId: item.id, chatRef: chat.id + 1, proposalVersion: 1, text: 'x' },
      }),
    ).toThrow(RepoContractError);
    // zod rejects an unknown key / a wrong kind before anything is written
    expect(() =>
      repos.actions.insertPending({
        ...base,
        payload: {
          v: 1,
          kind: 'send_reply',
          itemId: item.id,
          chatRef: chat.id,
          proposalVersion: 1,
          text: 'x',
          extra: 1,
        } as never,
      }),
    ).toThrow();
    expect(repos.actions.forItem(item.id)).toHaveLength(0);
  });

  it('a retry clone keeps the chain key and counts attempts; chainRoot walks back to attempt 1', () => {
    const { repos } = memRepos();
    const { action, item, chat, proposal } = seedPendingAction(repos);
    const payload = {
      v: 1 as const,
      kind: 'send_reply' as const,
      itemId: item.id,
      chatRef: chat.id,
      proposalVersion: proposal.version,
      text: 'ok',
    };
    const clone = repos.actions.insertPending({
      itemId: item.id,
      proposalId: proposal.id,
      chatId: chat.id,
      payload,
      now: T0 + 1,
      retryOf: action.id,
    });
    const clone2 = repos.actions.insertPending({
      itemId: item.id,
      proposalId: proposal.id,
      chatId: chat.id,
      payload,
      now: T0 + 2,
      retryOf: clone.id,
    });
    expect(clone.idempotencyKey).toBe(`${action.idempotencyKey}:r2`);
    expect(clone2.idempotencyKey).toBe(`${action.idempotencyKey}:r3`);
    expect([clone.attempt, clone2.attempt]).toEqual([2, 3]);
    expect(stripRetrySuffix(clone2.idempotencyKey)).toBe(chainKeyOf(payload));
    expect(repos.actions.chainRoot(clone2.id).id).toBe(action.id);
    expect(repos.actions.chainRoot(action.id).id).toBe(action.id);
    expect(() =>
      repos.actions.insertPending({
        itemId: item.id,
        proposalId: proposal.id,
        chatId: chat.id,
        payload,
        now: T0,
        retryOf: 'nope',
      }),
    ).toThrow(RowNotFoundError);
    expect(() => repos.actions.chainRoot('nope')).toThrow(RowNotFoundError);
    // the idempotency key is UNIQUE: a second first-attempt action for the same proposal version cannot exist
    expect(() =>
      repos.actions.insertPending({ itemId: item.id, proposalId: proposal.id, chatId: chat.id, payload, now: T0 }),
    ).toThrow();
  });

  it('chainRoot survives a corrupted retry_of cycle', () => {
    const { db, repos } = memRepos();
    const { action, item, chat, proposal } = seedPendingAction(repos);
    const payload = {
      v: 1 as const,
      kind: 'send_reply' as const,
      itemId: item.id,
      chatRef: chat.id,
      proposalVersion: proposal.version,
      text: 'ok',
    };
    const clone = repos.actions.insertPending({
      itemId: item.id,
      proposalId: proposal.id,
      chatId: chat.id,
      payload,
      now: T0 + 1,
      retryOf: action.id,
    });
    // retry_of is frozen too, so a cycle cannot be created through the app at all
    expect(() => db.prepare(`UPDATE actions SET retry_of = ? WHERE id = ?`).run(clone.id, action.id)).toThrow(
      /immutable/,
    );
    // ... only a corrupted file could hold one, and chainRoot still terminates on it
    db.exec(`DROP TRIGGER trg_actions_frozen`);
    db.prepare(`UPDATE actions SET retry_of = ? WHERE id = ?`).run(clone.id, action.id);
    expect(repos.actions.chainRoot(clone.id).id).toBe(action.id);
  });
});

describe('actions triggers - trg_actions_insert / trg_actions_state', () => {
  it('a row is born pending, with content', () => {
    const { db, repos } = memRepos();
    const { item, chat, proposal } = seedPendingAction(repos);
    const insert = (state: string, canonical: string | null): void => {
      db.prepare(
        `INSERT INTO actions(id, item_id, proposal_id, chat_id, kind, canonical_json, content_sha256, idempotency_key, created_at, expires_at, state)
         VALUES ('x', ?, ?, ?, 'send_reply', ?, ?, 'k-x', ?, ?, ?)`,
      ).run(item.id, proposal.id, chat.id, canonical, 'a'.repeat(64), T0, T0 + 1, state);
    };
    expect(() => insert('approved', '{}')).toThrow(/born pending/);
    expect(() => insert('pending', null)).toThrow(/born pending/);
  });

  it.each([
    ['pending', 'executing', /execute without approval/],
    ['pending', 'done', /bad done/],
    ['pending', 'failed', /bad outcome/],
    ['pending', 'unknown_outcome', /bad outcome/],
    ['approved', 'done', /bad done/],
    ['approved', 'rejected', /bad reject/],
    ['approved', 'expired', /bad close/],
    ['executing', 'pending', /cannot return to pending/],
    ['executing', 'approved', /bad approve/],
    ['executing', 'rejected', /bad reject/],
    ['executing', 'expired', /bad close/],
    ['executing', 'superseded', /bad close/],
    ['done', 'failed', /terminal state/],
    ['done', 'pending', /terminal state/],
    ['failed', 'pending', /terminal state/],
    ['failed', 'done', /terminal state/],
    ['rejected', 'pending', /terminal state/],
    ['expired', 'approved', /terminal state/],
    ['superseded', 'executing', /terminal state/],
    ['unknown_outcome', 'pending', /cannot return to pending/],
    ['unknown_outcome', 'failed', /bad outcome/],
  ])('%s -> %s aborts', (from, to, message) => {
    const { db, repos } = memRepos();
    const { action } = seedPendingAction(repos);
    force(db, action.id, from);
    expect(() => db.prepare(`UPDATE actions SET state=? WHERE id=?`).run(to, action.id)).toThrow(message);
    expect(db.prepare<{ state: string }>(`SELECT state FROM actions WHERE id=?`).get(action.id)!.state).toBe(from);
  });

  it.each([
    ['pending', 'rejected'],
    ['pending', 'expired'],
    ['pending', 'superseded'],
    ['approved', 'executing'],
    ['executing', 'done'],
    ['executing', 'failed'],
    ['executing', 'unknown_outcome'],
    ['unknown_outcome', 'done'],
    ['unknown_outcome', 'expired'],
    ['unknown_outcome', 'superseded'],
  ])('%s -> %s is allowed', (from, to) => {
    const { db, repos } = memRepos();
    const { action } = seedPendingAction(repos);
    force(db, action.id, from);
    expect(db.prepare(`UPDATE actions SET state=? WHERE id=?`).run(to, action.id).changes).toBe(1);
  });

  it('approve needs both approved_at and approved_final_json, and executing needs a final payload', () => {
    const { db, repos } = memRepos();
    const { action } = seedPendingAction(repos);
    expect(() =>
      db.prepare(`UPDATE actions SET state='approved', approved_final_json=? WHERE id=?`).run(FINAL, action.id),
    ).toThrow(/bad approve/);
    expect(() =>
      db.prepare(`UPDATE actions SET state='approved', approved_at=? WHERE id=?`).run(T0, action.id),
    ).toThrow(/bad approve/);
    force(db, action.id, 'approved');
    // approved is not yet frozen, so the final payload can still be cleared - and then the row may not start executing
    db.prepare(`UPDATE actions SET approved_final_json=NULL WHERE id=?`).run(action.id);
    expect(() => db.prepare(`UPDATE actions SET state='executing' WHERE id=?`).run(action.id)).toThrow(
      /execute without approval/,
    );
  });
});

describe('actions triggers - trg_actions_frozen / trg_actions_final_frozen', () => {
  it('content columns are immutable; retention may NULL canonical_json on a terminal row only', () => {
    const { db, repos } = memRepos();
    const { action } = seedPendingAction(repos);
    expect(() => db.prepare(`UPDATE actions SET canonical_json=NULL WHERE id=?`).run(action.id)).toThrow(/immutable/);
    expect(() => db.prepare(`UPDATE actions SET chat_id=99 WHERE id=?`).run(action.id)).toThrow(/immutable/);
    force(db, action.id, 'done');
    expect(() => db.prepare(`UPDATE actions SET canonical_json='{"x":1}' WHERE id=?`).run(action.id)).toThrow(
      /immutable/,
    );
    // any other column changed in the SAME statement aborts the NULLing
    expect(() => db.prepare(`UPDATE actions SET canonical_json=NULL, attempt=7 WHERE id=?`).run(action.id)).toThrow(
      /immutable/,
    );
    expect(db.prepare(`UPDATE actions SET canonical_json=NULL WHERE id=?`).run(action.id).changes).toBe(1);
    // a second pass over an already-nulled row is refused (OLD.canonical_json IS NULL) - retention must filter on IS NOT NULL
    expect(() => db.prepare(`UPDATE actions SET canonical_json=NULL WHERE id=?`).run(action.id)).toThrow(/immutable/);
    expect(repos.actions.byId(action.id)!.canonicalJson).toBe('');
  });

  /**
   * Migration v2. `retry_of ... ON DELETE SET NULL` is an implicit UPDATE, so deleting a retry PARENT used to abort on this very
   * trigger and take the surrounding transaction (retention's purge, mergeLidInto inside ingest's scan) with it. The guard now
   * permits a lone NULLing of a real back-pointer - and nothing else.
   */
  it('permits only the FK NULLing of retry_of, on a row that really has a parent', () => {
    const { db, repos } = memRepos();
    const { item, chat, proposal, action } = seedPendingAction(repos);
    const payload = {
      v: 1 as const,
      kind: 'send_reply' as const,
      itemId: item.id,
      chatRef: chat.id,
      proposalVersion: proposal.version,
      text: 'ok',
    };
    const clone = repos.actions.insertPending({
      itemId: item.id,
      proposalId: proposal.id,
      chatId: chat.id,
      payload,
      now: T0 + 1,
      retryOf: action.id,
    });
    // a retry_of pointed at another row is still frozen, and so is every other pinned column in the same statement
    expect(() => db.prepare(`UPDATE actions SET retry_of=? WHERE id=?`).run(clone.id, action.id)).toThrow(/immutable/);
    expect(() => db.prepare(`UPDATE actions SET retry_of=NULL, chat_id=99 WHERE id=?`).run(clone.id)).toThrow(
      /immutable/,
    );
    // the FK's own shape goes through even though the clone is live and still carries its payload
    expect(db.prepare(`UPDATE actions SET retry_of=NULL WHERE id=?`).run(clone.id).changes).toBe(1);
    expect(repos.actions.byId(clone.id)).toMatchObject({ retryOf: null, state: 'pending' });
    expect(repos.actions.byId(clone.id)!.canonicalJson).not.toBe('');
    // and it cannot be replayed as a no-op to smuggle a second canonical_json purge past the terminal-row guard
    force(db, clone.id, 'rejected');
    expect(db.prepare(`UPDATE actions SET canonical_json=NULL WHERE id=?`).run(clone.id).changes).toBe(1);
    expect(() => db.prepare(`UPDATE actions SET canonical_json=NULL WHERE id=?`).run(clone.id)).toThrow(/immutable/);
  });

  it('approved_final_json is frozen once the row is executing, and NULLable again on a terminal row', () => {
    const { db, repos } = memRepos();
    const { action } = seedPendingAction(repos);
    force(db, action.id, 'executing');
    expect(() => db.prepare(`UPDATE actions SET approved_final_json='{"v":2}' WHERE id=?`).run(action.id)).toThrow(
      /final payload is immutable/,
    );
    expect(() => db.prepare(`UPDATE actions SET approved_final_json=NULL WHERE id=?`).run(action.id)).toThrow(
      /final payload is immutable/,
    );
    db.prepare(`UPDATE actions SET state='done' WHERE id=?`).run(action.id);
    expect(db.prepare(`UPDATE actions SET approved_final_json=NULL WHERE id=?`).run(action.id).changes).toBe(1);
  });
});

describe('actions repo - compare-and-set', () => {
  it('markApprovedExecuting is one hop from pending to executing', () => {
    const { repos } = memRepos();
    const { action } = seedPendingAction(repos);
    expect(repos.actions.markApprovedExecuting(action.id, FINAL, T0 + 5, 'user')).toBe('ok');
    const row = repos.actions.byId(action.id)!;
    expect(row.state).toBe('executing');
    expect(row.approvedAt).toBe(T0 + 5);
    expect(row.approvedFinalJson).toBe(FINAL);
  });

  it('returns stale - never throws - on a row that is no longer pending or does not exist', () => {
    const { repos } = memRepos();
    const { action } = seedPendingAction(repos);
    expect(repos.actions.markApprovedExecuting(action.id, FINAL, T0, 'user')).toBe('ok');
    expect(repos.actions.markApprovedExecuting(action.id, FINAL, T0, 'user')).toBe('stale');
    expect(repos.actions.markApprovedExecuting('missing-id', FINAL, T0, 'user')).toBe('stale');
    expect(repos.actions.byId(action.id)!.state).toBe('executing');
  });

  it('a trigger ABORT during the approval is reported as stale and leaves the row pending', () => {
    const { db, repos } = memRepos();
    const { action } = seedPendingAction(repos);
    db.exec(
      `CREATE TRIGGER t_block BEFORE UPDATE OF state ON actions WHEN NEW.state='approved' BEGIN SELECT RAISE(ABORT,'blocked'); END`,
    );
    expect(repos.actions.markApprovedExecuting(action.id, FINAL, T0, 'user')).toBe('stale');
    expect(repos.actions.byId(action.id)!.state).toBe('pending');
    expect(repos.actions.byId(action.id)!.approvedFinalJson).toBeNull();
    db.exec(`DROP TRIGGER t_block`);
  });

  it('a real defect is never swallowed as stale', () => {
    const { db, repos } = memRepos();
    const { action } = seedPendingAction(repos);
    const boom = new TypeError('a programming error, not a lost race');
    vi.spyOn(db, 'transaction').mockImplementation(() => {
      throw boom;
    });
    expect(() => repos.actions.markApprovedExecuting(action.id, FINAL, T0, 'user')).toThrow(boom);
    vi.restoreAllMocks();
  });

  it('markDone / markFailed / markUnknownOutcome are WHERE state=executing and throw otherwise', () => {
    const { repos } = memRepos();
    const { action } = seedPendingAction(repos);
    expect(() => repos.actions.markDone(action.id, { kind: 'send_reply', waMsgId: null }, T0)).toThrow(
      ActionStateError,
    );
    expect(() => repos.actions.markFailed(action.id, 'SEND_FAILED', T0)).toThrow(ActionStateError);
    expect(() => repos.actions.markUnknownOutcome(action.id, T0)).toThrow(ActionStateError);
    repos.actions.markApprovedExecuting(action.id, FINAL, T0, 'user');
    repos.actions.markDone(action.id, { kind: 'send_reply', waMsgId: 'wa-1' }, T0 + 9);
    const row = repos.actions.byId(action.id)!;
    expect(row.state).toBe('done');
    expect(row.result).toEqual({ kind: 'send_reply', waMsgId: 'wa-1' });
    expect(row.executedAt).toBe(T0 + 9);
    expect(() => repos.actions.markFailed(action.id, 'SEND_FAILED', T0)).toThrow(ActionStateError);
  });

  it('markDone is also allowed from unknown_outcome (reconcile found the message)', () => {
    const { repos } = memRepos();
    const { action } = seedPendingAction(repos);
    repos.actions.markApprovedExecuting(action.id, FINAL, T0, 'user');
    repos.actions.markUnknownOutcome(action.id, T0 + 1);
    expect(repos.actions.byId(action.id)!.state).toBe('unknown_outcome');
    repos.actions.markDone(action.id, { kind: 'send_reply', waMsgId: 'wa-2' }, T0 + 2);
    expect(repos.actions.byId(action.id)!.state).toBe('done');
  });

  it('markFailed records the ErrorCode; the row stays terminal', () => {
    const { repos } = memRepos();
    const { action } = seedPendingAction(repos);
    repos.actions.markApprovedExecuting(action.id, FINAL, T0, 'user');
    repos.actions.markFailed(action.id, 'SEND_FAILED', T0 + 3);
    expect(repos.actions.byId(action.id)!.errorCode).toBe('SEND_FAILED');
  });

  it('markRejected is idempotent and only ever touches a pending row', () => {
    const { repos } = memRepos();
    const { action } = seedPendingAction(repos);
    repos.actions.markRejected(action.id);
    expect(repos.actions.byId(action.id)!.state).toBe('rejected');
    expect(() => repos.actions.markRejected(action.id)).not.toThrow();
    expect(repos.actions.byId(action.id)!.state).toBe('rejected');
  });
});

describe('actions repo - queries and bulk closes', () => {
  it('expireOverdue closes pending rows past their TTL only', () => {
    const { repos } = memRepos();
    const { action } = seedPendingAction(repos);
    expect(repos.actions.expireOverdue(action.expiresAt - 1)).toBe(0);
    expect(repos.actions.expireOverdue(action.expiresAt)).toBe(1);
    expect(repos.actions.byId(action.id)!.state).toBe('expired');
    expect(repos.actions.expireOverdue(action.expiresAt + 1)).toBe(0);
  });

  it("supersedePending closes the item's pending rows; executing() lists the in-flight ones", () => {
    const { repos } = memRepos();
    const { action, item } = seedPendingAction(repos);
    expect(repos.actions.forItem(item.id)).toHaveLength(1);
    expect(repos.actions.supersedePending(item.id, T0)).toBe(1);
    expect(repos.actions.byId(action.id)!.state).toBe('superseded');
    expect(repos.actions.supersedePending(item.id, T0)).toBe(0);
    expect(repos.actions.executing()).toEqual([]);
  });

  it('[repair] supersedePendingOfKind supersedes ONE kind of this item and spares the other', () => {
    const { repos } = memRepos();
    const { action, chat, item } = seedPendingAction(repos);
    const event = repos.actions.insertPending({
      itemId: item.id,
      proposalId: action.proposalId,
      chatId: chat.id,
      payload: {
        v: 1,
        kind: 'create_event',
        itemId: item.id,
        chatRef: chat.id,
        proposalVersion: 1,
        title: 't',
        startLocal: '2026-09-22T10:00:00',
        endLocal: '2026-09-22T11:00:00',
        timeZone: 'Asia/Jerusalem',
        location: '',
      },
      now: T0,
    });
    expect(repos.actions.supersedePendingOfKind(item.id, 'send_reply', T0)).toBe(1);
    expect(repos.actions.byId(action.id)!.state).toBe('superseded');
    expect(repos.actions.byId(event.id)!.state).toBe('pending');
    expect(repos.actions.supersedePendingOfKind(item.id, 'send_reply', T0)).toBe(0);
    expect(repos.actions.supersedePendingOfKind(item.id, 'create_event', T0)).toBe(1);
    expect(repos.actions.byId(event.id)!.state).toBe('superseded');
  });

  it('[R2] supersedePendingRepliesOfChat spares the new open item and other kinds', () => {
    const { repos } = memRepos();
    const { action, chat, item } = seedPendingAction(repos);
    // a second item of the same chat (the older one is closed first, ux_items_open allows one open item)
    repos.items.update(item.id, { closedReason: 'superseded' }, T0);
    const newer = repos.items.createOpen({
      chatId: chat.id,
      triggerMsgId: 'm2',
      triggerTs: T0 + 1,
      analysis: 'queued',
      holdReason: null,
      now: T0 + 1,
    });
    const proposal = seedProposal(repos, newer.id, T0 + 1);
    const keep = repos.actions.insertPending({
      itemId: newer.id,
      proposalId: proposal.id,
      chatId: chat.id,
      payload: {
        v: 1,
        kind: 'send_reply',
        itemId: newer.id,
        chatRef: chat.id,
        proposalVersion: proposal.version,
        text: 'hi',
      },
      now: T0 + 1,
    });
    const event = repos.actions.insertPending({
      itemId: item.id,
      proposalId: proposal.id,
      chatId: chat.id,
      payload: {
        v: 1,
        kind: 'create_event',
        itemId: item.id,
        chatRef: chat.id,
        proposalVersion: 1,
        title: 't',
        startLocal: '2026-09-22T10:00:00',
        endLocal: '2026-09-22T11:00:00',
        timeZone: 'Asia/Jerusalem',
        location: '',
      },
      now: T0 + 1,
    });
    expect(repos.actions.supersedePendingRepliesOfChat(chat.id, newer.id, T0 + 2)).toBe(1);
    expect(repos.actions.byId(action.id)!.state).toBe('superseded');
    expect(repos.actions.byId(keep.id)!.state).toBe('pending');
    expect(repos.actions.byId(event.id)!.state).toBe('pending');
  });

  it('byId returns null for an unknown id and forItem is ordered oldest first', () => {
    const { repos } = memRepos();
    const { action, item, chat, proposal } = seedPendingAction(repos);
    const clone = repos.actions.insertPending({
      itemId: item.id,
      proposalId: proposal.id,
      chatId: chat.id,
      payload: {
        v: 1,
        kind: 'send_reply',
        itemId: item.id,
        chatRef: chat.id,
        proposalVersion: proposal.version,
        text: 'ok',
      },
      now: T0 + 10,
      retryOf: action.id,
    });
    expect(repos.actions.byId('unknown')).toBeNull();
    expect(repos.actions.forItem(item.id).map((a) => a.id)).toEqual([action.id, clone.id]);
  });

  it('the pinned recipient survives a chat rename (safety I3: chat_id is frozen)', () => {
    const { db, repos } = memRepos();
    const { action, chat } = seedPendingAction(repos);
    repos.chats.upsertFromBridge(JID_A, 'new name', true, T0 + 1);
    expect(repos.actions.byId(action.id)!.chatId).toBe(chat.id);
    expect(() => db.prepare(`UPDATE actions SET chat_id=? WHERE id=?`).run(chat.id + 1, action.id)).toThrow(
      /immutable/,
    );
  });
});
