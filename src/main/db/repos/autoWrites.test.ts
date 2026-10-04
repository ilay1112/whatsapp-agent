// T2 5 row `db/*`: auto_writes (B10) - insert only behind an 'auto' decision of the same action, append-only except the bookkeeping
// columns (revision_id, post_*, undo_state, undo_action_id), create <=> no pre snapshot, undo window <= 72 h, budgets and breaker reads.
import { afterEach, describe, expect, it } from 'vitest';
import type * as T from '../../../shared/types';
import type { Repos } from '../index';
import { RepoContractError, RowNotFoundError } from '../errors';
import {
  cleanup,
  EVT_A,
  EVT_B,
  memRepos,
  seedCreatedEvent,
  seedDecision,
  seedPendingCreate,
  seedPendingUpdate,
  seedPolicy,
  T0,
} from '../__fixtures__/testDb';

afterEach(cleanup);

const HOUR = 3600_000;
const PRE: T.EventSnapshot = {
  title: 'Synthetic meeting',
  startLocal: '2026-10-01T10:00:00',
  endLocal: '2026-10-01T11:00:00',
  timeZone: 'Asia/Jerusalem',
  location: '',
  status: 'confirmed',
  etag: '"e1"',
  updated: '2026-09-21T09:00:00.000Z',
  sequence: 0,
};

/** A pending create + its auto decision (policy on). */
function autoCreate(repos: Repos, n = 1): { action: T.ApprovalAction; decision: T.AutoDecisionRecord } {
  const policy = repos.autoPolicies.live() ?? seedPolicy(repos);
  const { action } = seedPendingCreate(repos, T0 + n, `9725500000${20 + n}@s.whatsapp.net`);
  return { action, decision: seedDecision(repos, { policyId: policy.id, action }) };
}
const writeFor = (
  a: { action: T.ApprovalAction; decision: T.AutoDecisionRecord },
  over: Partial<Parameters<Repos['autoWrites']['insert']>[0]> = {},
): Parameters<Repos['autoWrites']['insert']>[0] => ({
  id: `w-${a.action.id}`,
  decisionId: a.decision.id,
  actionId: a.action.id,
  itemId: a.action.itemId,
  eventId: EVT_A,
  kind: 'create',
  pre: null,
  undoUntil: T0 + 72 * HOUR,
  writtenAt: T0,
  ...over,
});

describe('repos.autoWrites - insert', () => {
  it('is born available with no readback; byId round-trips', () => {
    const { repos } = memRepos();
    const a = autoCreate(repos);
    const w = repos.autoWrites.insert(writeFor(a));
    expect(w).toEqual({
      ...writeFor(a),
      revisionId: null,
      postEtag: null,
      postUpdated: null,
      postSequence: null,
      undoState: 'available',
      undoActionId: null,
    });
    expect(repos.autoWrites.byId(w.id)).toEqual(w);
    expect(repos.autoWrites.byId('nope')).toBeNull();
  });

  it('needs an AUTO decision of the SAME action (trg_auto_writes_insert)', () => {
    const { repos } = memRepos();
    const a = autoCreate(repos, 1);
    const b = autoCreate(repos, 2);
    expect(() => repos.autoWrites.insert(writeFor(a, { decisionId: b.decision.id }))).toThrow(/without auto decision/);
    const policy = repos.autoPolicies.live()!;
    const { action } = seedPendingCreate(repos, T0 + 9, '972550000039@s.whatsapp.net');
    const shadow = seedDecision(repos, { policyId: policy.id, action, verdict: 'shadow' });
    expect(() => repos.autoWrites.insert(writeFor({ action, decision: shadow }))).toThrow(/without auto decision/);
    expect(() => repos.autoWrites.insert(writeFor(a, { kind: 'delete' as T.AutoWriteKind }))).toThrow(
      RepoContractError,
    );
  });

  it('DDL: create <=> no pre snapshot, update/cancel need one; undo_until within 72 h after written_at', () => {
    const { repos } = memRepos();
    const a = autoCreate(repos);
    expect(() => repos.autoWrites.insert(writeFor(a, { pre: PRE }))).toThrow(/CHECK/);
    expect(() => repos.autoWrites.insert(writeFor(a, { kind: 'update' }))).toThrow(/CHECK/);
    expect(() => repos.autoWrites.insert(writeFor(a, { undoUntil: T0 + 72 * HOUR + 1 }))).toThrow(/CHECK/);
    expect(() => repos.autoWrites.insert(writeFor(a, { undoUntil: T0 }))).toThrow(/CHECK/);
    expect(repos.autoWrites.insert(writeFor(a, { kind: 'update', pre: PRE })).pre).toEqual(PRE);
  });

  it('only the bookkeeping columns change (append-only)', () => {
    const { db, repos } = memRepos();
    const w = repos.autoWrites.insert(writeFor(autoCreate(repos)));
    for (const set of [
      `event_id = 'x'`,
      `kind = 'update'`,
      `pre_json = '{}'`,
      `undo_until = undo_until - 1`,
      `written_at = 1`,
      `item_id = item_id`,
      `decision_id = decision_id`,
      `action_id = action_id`,
      `id = 'w9'`,
    ])
      expect(() => db.prepare(`UPDATE auto_writes SET ${set} WHERE id = ?`).run(w.id), set).toThrow(/append-only/);
  });
});

describe('repos.autoWrites - bookkeeping', () => {
  it('recordReadback / setUndo update exactly the row and keep an omitted undo action', () => {
    const { repos } = memRepos();
    const created = seedCreatedEvent(repos, { jid: '972550000040@s.whatsapp.net' });
    const rev = repos.eventRevisions.insert({
      calendarEventId: EVT_A,
      itemId: created.item.id,
      revision: 1,
      kind: 'create',
      prev: null,
      next: null,
      actionId: created.action.id,
      appliedAt: T0,
      postEtag: null,
      postUpdated: null,
    });
    const a = autoCreate(repos);
    const w = repos.autoWrites.insert(writeFor(a));
    repos.autoWrites.recordReadback(w.id, { revisionId: rev.id, postEtag: '"e2"', postUpdated: 'u2', postSequence: 3 });
    const { action: undo } = seedPendingUpdate(repos, created, { change: 'undo', revertOf: rev.id, now: T0 + 5 });
    repos.autoWrites.setUndo(w.id, { undoState: 'undone', undoActionId: undo.id });
    repos.autoWrites.setUndo(w.id, { undoState: 'failed' });
    expect(repos.autoWrites.byId(w.id)).toMatchObject({
      revisionId: rev.id,
      postEtag: '"e2"',
      postUpdated: 'u2',
      postSequence: 3,
      undoState: 'failed',
      undoActionId: undo.id,
    });
    expect(() => repos.autoWrites.setUndo(w.id, { undoState: 'gone' as T.AutoUndoState })).toThrow(RepoContractError);
    expect(() => repos.autoWrites.setUndo('nope', { undoState: 'expired' })).toThrow(RowNotFoundError);
    expect(() =>
      repos.autoWrites.recordReadback('nope', {
        revisionId: rev.id,
        postEtag: null,
        postUpdated: null,
        postSequence: null,
      }),
    ).toThrow(RowNotFoundError);
    // ON DELETE SET NULL: the revision row going away (retention / item delete) clears revision_id, the ledger row stays
    repos.db.prepare(`DELETE FROM event_revisions WHERE id = ?`).run(rev.id);
    expect(repos.autoWrites.byId(w.id)!.revisionId).toBeNull();
  });

  it('since() is newest first; countEditsOfEvent counts update + cancel of that event only', () => {
    const { repos } = memRepos();
    const w1 = repos.autoWrites.insert(writeFor(autoCreate(repos, 1), { writtenAt: T0, undoUntil: T0 + HOUR }));
    const w2 = repos.autoWrites.insert(
      writeFor(autoCreate(repos, 2), { kind: 'update', pre: PRE, writtenAt: T0 + 10, undoUntil: T0 + HOUR }),
    );
    const w3 = repos.autoWrites.insert(
      writeFor(autoCreate(repos, 3), { kind: 'cancel', pre: PRE, writtenAt: T0 + 20, undoUntil: T0 + HOUR }),
    );
    const w4 = repos.autoWrites.insert(
      writeFor(autoCreate(repos, 4), {
        eventId: EVT_B,
        kind: 'update',
        pre: PRE,
        writtenAt: T0 + 30,
        undoUntil: T0 + HOUR,
      }),
    );
    expect(repos.autoWrites.since(T0 + 5).map((w) => w.id)).toEqual([w4.id, w3.id, w2.id]);
    expect(repos.autoWrites.since(T0).map((w) => w.id)).toEqual([w4.id, w3.id, w2.id, w1.id]);
    expect(repos.autoWrites.countEditsOfEvent(EVT_A)).toBe(2);
    expect(repos.autoWrites.countEditsOfEvent(EVT_B)).toBe(1);
    expect(repos.autoWrites.countEditsOfEvent('evtnone0')).toBe(0);
  });

  it('undosSince counts undone writes by the time of their undo action (fallback: written_at)', () => {
    const { repos } = memRepos();
    const created = seedCreatedEvent(repos, { jid: '972550000041@s.whatsapp.net' });
    const w1 = repos.autoWrites.insert(writeFor(autoCreate(repos, 1), { writtenAt: T0, undoUntil: T0 + HOUR }));
    const w2 = repos.autoWrites.insert(writeFor(autoCreate(repos, 2), { writtenAt: T0, undoUntil: T0 + HOUR }));
    const w3 = repos.autoWrites.insert(writeFor(autoCreate(repos, 3), { writtenAt: T0, undoUntil: T0 + HOUR }));
    // w1: undone by an action created at T0 + 10 h and executed at T0 + 11 h
    const { action: u1 } = seedPendingUpdate(repos, created, { change: 'undo', now: T0 + 10 * HOUR });
    repos.actions.markApprovedExecuting(u1.id, u1.canonicalJson, T0 + 10 * HOUR, 'user_toast');
    repos.actions.markDone(
      u1.id,
      { kind: 'update_event', eventId: EVT_A, revision: 2, status: 'cancelled' },
      T0 + 11 * HOUR,
    );
    repos.autoWrites.setUndo(w1.id, { undoState: 'undone', undoActionId: u1.id });
    // w2: undone, no undo action recorded => written_at (T0)
    repos.autoWrites.setUndo(w2.id, { undoState: 'undone' });
    // w3: blocked, not undone
    repos.autoWrites.setUndo(w3.id, { undoState: 'blocked_changed' });
    expect(repos.autoWrites.undosSince(T0)).toBe(2);
    expect(repos.autoWrites.undosSince(T0 + 1)).toBe(1);
    expect(repos.autoWrites.undosSince(T0 + 11 * HOUR)).toBe(1);
    expect(repos.autoWrites.undosSince(T0 + 11 * HOUR + 1)).toBe(0);
  });
});
