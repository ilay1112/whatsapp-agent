// T2 5 row `db/*`: event_revisions is the only previous-version store (B10). Append-only (only reverted_by / post_* change; retention
// NULLs prev/next), ux_event_rev, revision 1 <=> 'create', and the F1 chain semantics of undoCandidate / unrevertedAutoSpan.
import { afterEach, describe, expect, it } from 'vitest';
import type * as T from '../../../shared/types';
import type { Db, Repos } from '../index';
import { RepoContractError, RowNotFoundError } from '../errors';
import {
  cleanup,
  content,
  EVT_A,
  EVT_B,
  memRepos,
  seedCreatedEvent,
  seedDecision,
  seedPendingUpdate,
  seedPolicy,
  T0,
} from '../__fixtures__/testDb';

afterEach(cleanup);

const MIN = 60_000;

interface Chain {
  db: Db;
  repos: Repos;
  created: ReturnType<typeof seedCreatedEvent>;
  policy: T.AutoPolicyRecord;
  rev(kind: T.RevisionKind, by: 'user' | 'user_toast' | 'auto', opts?: { revertOf?: number }): T.EventRevisionRecord;
}

/** A created event (revision 1 = the user's create) plus a helper that applies one more revision through a real approved action. */
function chain(): Chain {
  const { db, repos } = memRepos();
  const created = seedCreatedEvent(repos);
  const policy = seedPolicy(repos);
  let revision = 1;
  const first = repos.eventRevisions.insert({
    calendarEventId: EVT_A,
    itemId: created.item.id,
    revision: 1,
    kind: 'create',
    prev: null,
    next: content(),
    actionId: created.action.id,
    appliedAt: T0,
    postEtag: '"etag-1"',
    postUpdated: '2026-09-21T09:00:00.000Z',
  });
  expect(first.revision).toBe(1);
  const rev: Chain['rev'] = (kind, by, opts = {}) => {
    revision += 1;
    const now = T0 + revision * MIN;
    const change = kind === 'undo' ? 'undo' : kind === 'create' ? 'reschedule' : kind;
    const { action } = seedPendingUpdate(repos, created, {
      now,
      change,
      baseRevision: revision - 1,
      ...(opts.revertOf !== undefined ? { revertOf: opts.revertOf } : {}),
    });
    if (by === 'auto') {
      const d = seedDecision(repos, { policyId: policy.id, action, kind: kind === 'cancel' ? 'cancel' : 'update' });
      expect(repos.actions.markApprovedExecuting(action.id, action.canonicalJson, now, d.id)).toBe('ok');
      repos.autoWrites.insert({
        id: `w-${revision}`,
        decisionId: d.id,
        actionId: action.id,
        itemId: created.item.id,
        eventId: EVT_A,
        kind: kind === 'cancel' ? 'cancel' : 'update',
        pre: {
          title: 'Synthetic meeting',
          startLocal: '2026-10-01T10:00:00',
          endLocal: '2026-10-01T11:00:00',
          timeZone: 'Asia/Jerusalem',
          location: '',
          status: 'confirmed',
          etag: null,
          updated: null,
          sequence: null,
        },
        undoUntil: now + 3600_000,
        writtenAt: now,
      });
    } else {
      expect(repos.actions.markApprovedExecuting(action.id, action.canonicalJson, now, by)).toBe('ok');
    }
    return repos.eventRevisions.insert({
      calendarEventId: EVT_A,
      itemId: created.item.id,
      revision,
      kind,
      prev: content(),
      next: content({ startLocal: `2026-10-0${revision}T10:00:00`, endLocal: `2026-10-0${revision}T11:00:00` }),
      actionId: action.id,
      appliedAt: now,
      postEtag: `"etag-${revision}"`,
      postUpdated: null,
    });
  };
  return { db, repos, created, policy, rev };
}

describe('repos.eventRevisions - insert / read', () => {
  it('round-trips a row and validates the content on the way in', () => {
    const { repos, rev } = chain();
    const r2 = rev('reschedule', 'user');
    expect(repos.eventRevisions.byId(r2.id)).toEqual(r2);
    expect(r2).toMatchObject({
      calendarEventId: EVT_A,
      revision: 2,
      kind: 'reschedule',
      revertedBy: null,
      postEtag: '"etag-2"',
    });
    expect(r2.next).toEqual(content({ startLocal: '2026-10-02T10:00:00', endLocal: '2026-10-02T11:00:00' }));
    expect(repos.eventRevisions.newestFor(EVT_A)!.id).toBe(r2.id);
    expect(repos.eventRevisions.newestFor(EVT_B)).toBeNull();
    expect(repos.eventRevisions.byId(99_999)).toBeNull();
  });

  it('refuses an unknown kind and a content that does not parse', () => {
    const { repos, created } = chain();
    const base = {
      calendarEventId: EVT_A,
      itemId: created.item.id,
      revision: 7,
      prev: null,
      next: null,
      actionId: created.action.id,
      appliedAt: T0,
      postEtag: null,
      postUpdated: null,
    };
    expect(() => repos.eventRevisions.insert({ ...base, kind: 'delete' as T.RevisionKind })).toThrow(RepoContractError);
    expect(() =>
      repos.eventRevisions.insert({ ...base, kind: 'move', next: { ...content(), title: 'two\nlines' } }),
    ).toThrow();
  });

  it('ux_event_rev: one row per (event, revision); the DDL ties revision 1 to kind create', () => {
    const { repos, created, rev } = chain();
    rev('move', 'user');
    const dup = {
      calendarEventId: EVT_A,
      itemId: created.item.id,
      prev: null,
      next: null,
      actionId: created.action.id,
      appliedAt: T0,
      postEtag: null,
      postUpdated: null,
    };
    expect(() => repos.eventRevisions.insert({ ...dup, revision: 2, kind: 'move' })).toThrow(/UNIQUE/);
    expect(() => repos.eventRevisions.insert({ ...dup, revision: 1, kind: 'move' })).toThrow(/CHECK|UNIQUE/);
    expect(() => repos.eventRevisions.insert({ ...dup, revision: 5, kind: 'create' })).toThrow(/CHECK/);
    // the same revision number of ANOTHER event is fine
    expect(repos.eventRevisions.insert({ ...dup, calendarEventId: EVT_B, revision: 1, kind: 'create' }).revision).toBe(
      1,
    );
  });

  it('is append-only: identity columns are frozen, only reverted_by / post_* / retention NULLing may change', () => {
    const { db, rev } = chain();
    const r = rev('reschedule', 'user');
    for (const set of [
      `calendar_event_id = 'evtother'`,
      `item_id = item_id + 1`,
      `revision = 9`,
      `kind = 'move'`,
      `action_id = 'x'`,
      `applied_at = 1`,
      `id = 999`,
    ])
      expect(() => db.prepare(`UPDATE event_revisions SET ${set} WHERE id = ?`).run(r.id), set).toThrow(/append-only/);
    db.prepare(`UPDATE event_revisions SET post_etag = '"e2"', post_updated = 'u' WHERE id = ?`).run(r.id);
    db.prepare(`UPDATE event_revisions SET prev_json = NULL, next_json = NULL WHERE id = ?`).run(r.id);
    db.prepare(`UPDATE event_revisions SET reverted_by = 1 WHERE id = ?`).run(r.id);
  });
});

describe('repos.eventRevisions - the undo chain (F1)', () => {
  it('undoCandidate walks newest-first past undo rows and reverted rows', () => {
    const { repos, rev } = chain();
    expect(repos.eventRevisions.undoCandidate(EVT_A)!.revision).toBe(1); // the create itself (undo of a create = cancel)
    const r2 = rev('reschedule', 'auto');
    const r3 = rev('move', 'auto');
    expect(repos.eventRevisions.undoCandidate(EVT_A)!.id).toBe(r3.id);
    const u4 = rev('undo', 'user_toast', { revertOf: r3.id });
    repos.eventRevisions.markReverted(r3.id, u4.id);
    // after "undo #3" the next candidate is #2 (#4 is an undo row, #3 is reverted)
    expect(repos.eventRevisions.undoCandidate(EVT_A)!.id).toBe(r2.id);
    const u5 = rev('undo', 'user', { revertOf: r2.id });
    repos.eventRevisions.markReverted(r2.id, u5.id);
    expect(repos.eventRevisions.undoCandidate(EVT_A)!.revision).toBe(1);
    expect(repos.eventRevisions.undoCandidate(EVT_B)).toBeNull();
  });

  it('undoCandidate is null once every non-undo row is reverted', () => {
    const { repos, rev } = chain();
    const first = repos.eventRevisions.newestFor(EVT_A)!;
    const u = rev('undo', 'user', { revertOf: first.id });
    repos.eventRevisions.markReverted(first.id, u.id);
    expect(repos.eventRevisions.undoCandidate(EVT_A)).toBeNull();
  });

  it('unrevertedAutoSpan = the un-reverted automatic writes newer than the newest user-approved revision, oldest first', () => {
    const { repos, rev } = chain();
    expect(repos.eventRevisions.unrevertedAutoSpan(EVT_A)).toEqual([]); // only the user's create
    const r2 = rev('reschedule', 'auto');
    const r3 = rev('move', 'auto');
    expect(repos.eventRevisions.unrevertedAutoSpan(EVT_A).map((r) => r.id)).toEqual([r2.id, r3.id]);
    // a toast undo of #3 is a user revision: the span above it is empty, and #3 is reverted anyway
    const u4 = rev('undo', 'user_toast', { revertOf: r3.id });
    repos.eventRevisions.markReverted(r3.id, u4.id);
    expect(repos.eventRevisions.unrevertedAutoSpan(EVT_A)).toEqual([]);
    // a new automatic change after the user's undo starts a new span
    const r5 = rev('reschedule', 'auto');
    expect(repos.eventRevisions.unrevertedAutoSpan(EVT_A).map((r) => r.id)).toEqual([r5.id]);
    // a user click on top closes it again
    rev('reschedule', 'user');
    expect(repos.eventRevisions.unrevertedAutoSpan(EVT_A)).toEqual([]);
  });

  it('markReverted: the first undo wins, a repeat is a no-op, an unknown row throws', () => {
    const { repos, rev } = chain();
    const r2 = rev('reschedule', 'user');
    const u3 = rev('undo', 'user', { revertOf: r2.id });
    const u4 = rev('undo', 'user', { revertOf: r2.id });
    repos.eventRevisions.markReverted(r2.id, u3.id);
    repos.eventRevisions.markReverted(r2.id, u4.id);
    expect(repos.eventRevisions.byId(r2.id)!.revertedBy).toBe(u3.id);
    expect(() => repos.eventRevisions.markReverted(424_242, u3.id)).toThrow(RowNotFoundError);
  });

  it('ON DELETE: removing the undo row sets reverted_by back to NULL; deleting the action removes its revision', () => {
    const { db, repos, rev } = chain();
    const r2 = rev('reschedule', 'user');
    const u3 = rev('undo', 'user', { revertOf: r2.id });
    repos.eventRevisions.markReverted(r2.id, u3.id);
    db.prepare(`DELETE FROM event_revisions WHERE id = ?`).run(u3.id);
    expect(repos.eventRevisions.byId(r2.id)!.revertedBy).toBeNull();
    // FK action_id ON DELETE CASCADE (actions only disappear with their item / chat)
    db.exec('PRAGMA foreign_keys=ON');
    const actionId = r2.actionId;
    db.prepare(`DELETE FROM actions WHERE id = ?`).run(actionId);
    expect(repos.eventRevisions.byId(r2.id)).toBeNull();
  });
});
