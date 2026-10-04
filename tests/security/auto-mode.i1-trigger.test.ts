// tests/security/auto-mode.i1-trigger.test.ts - security gate group 13 of T2 8.2 (I1' at the DB). Owner: V2-W1-01-db.
//
// I1' (ARCHITECTURE-v2 2, B6): a calendar write is approved either by a click ('user'), by the toast Undo button ('user_toast',
// undo payloads only - F4 (1)) or by the id of an auto_decisions row that trg_actions_state JOINs to a LIVE 'on' policy decision for
// THIS action (F4 (2)-(3)). Everything here is direct SQL against the REAL migration-v4 schema (no repo, no executor): the trigger
// alone must refuse every forged approver. The repo-level CAS (markApprovedExecuting -> 'stale', never a throw) is asserted too.
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanup,
  EVT_A,
  JID_B,
  memRepos,
  seedCreatedEvent,
  seedDecision,
  seedPendingAction,
  seedPendingCreate,
  seedPendingUpdate,
  seedPolicy,
  T0,
} from '../../src/main/db/__fixtures__/testDb.ts';
import type { Db, Repos } from '../../src/main/db/index.ts';
import type { ApprovalAction } from '../../src/shared/types.ts';

afterEach(cleanup);

const APPROVE = `UPDATE actions SET state = 'approved', approved_at = ?, approved_final_json = ?, approved_by = ? WHERE id = ?`;

/** The first CAS statement of markApprovedExecuting, run raw. `final` defaults to the canonical payload (tryAuto never edits). */
function approveRaw(db: Db, a: ApprovalAction, by: string | null, final: string = a.canonicalJson): void {
  db.prepare(APPROVE).run(T0, final, by, a.id);
}
const stateOf = (repos: Repos, a: ApprovalAction): string => repos.actions.byId(a.id)!.state;

describe("I1' - forged approvers abort (create_event)", () => {
  it.each([
    ['NULL', null, /bad approve/],
    ["'auto'", 'auto', /auto approve without live policy decision/],
    ["'bogus'", 'bogus', /auto approve without live policy decision/],
    ["'' (empty)", '', /auto approve without live policy decision/],
    ["'user_toast' on create_event (C2 tightening)", 'user_toast', /toast approves undo only/],
  ])('approved_by %s => RAISE(ABORT)', (_label, by, message) => {
    const { db, repos } = memRepos();
    seedPolicy(repos);
    const { action } = seedPendingCreate(repos);
    expect(() => approveRaw(db, action, by)).toThrow(message);
    expect(stateOf(repos, action)).toBe('pending');
    // the repo maps the same abort to 'stale' - never a throw, never a side effect
    expect(repos.actions.markApprovedExecuting(action.id, action.canonicalJson, T0, by as string)).toBe('stale');
    expect(repos.actions.byId(action.id)).toMatchObject({ state: 'pending', approvedBy: null, approvedAt: null });
  });

  it('a decision of ANOTHER action does not approve this one', () => {
    const { db, repos } = memRepos();
    const policy = seedPolicy(repos);
    const mine = seedPendingCreate(repos, T0).action;
    const other = seedPendingCreate(repos, T0, JID_B).action;
    const foreign = seedDecision(repos, { policyId: policy.id, action: other });
    expect(() => approveRaw(db, mine, foreign.id)).toThrow(/auto approve without live policy decision/);
    expect(stateOf(repos, mine)).toBe('pending');
  });

  it.each(['shadow', 'fallback'] as const)('a decision with verdict %s does not approve', (verdict) => {
    const { db, repos } = memRepos();
    const policy = seedPolicy(repos);
    const { action } = seedPendingCreate(repos);
    const d = seedDecision(repos, { policyId: policy.id, action, verdict });
    expect(() => approveRaw(db, action, d.id)).toThrow(/auto approve without live policy decision/);
  });

  it.each(['shadow', 'paused', 'expired', 'disabled'] as const)(
    'a decision whose policy is %s does not approve',
    (state) => {
      const { db, repos } = memRepos();
      const policy = seedPolicy(repos, { state: state === 'shadow' ? 'shadow' : 'on' });
      const { action } = seedPendingCreate(repos);
      const d = seedDecision(repos, { policyId: policy.id, action });
      if (state === 'paused') repos.autoPolicies.setState(policy.id, { state: 'paused', reason: 'user' });
      if (state === 'expired') repos.autoPolicies.setState(policy.id, { state: 'expired' });
      if (state === 'disabled')
        repos.autoPolicies.setState(policy.id, { state: 'disabled', reason: 'user', at: Date.now() });
      expect(repos.autoPolicies.newest()!.state).toBe(state);
      expect(() => approveRaw(db, action, d.id)).toThrow(/auto approve without live policy decision/);
      expect(repos.actions.markApprovedExecuting(action.id, action.canonicalJson, T0, d.id)).toBe('stale');
    },
  );

  it("F4 (3): an 'on' policy whose expires_at has passed (not yet swept to 'expired') does not approve", () => {
    const { db, repos } = memRepos();
    const enabledAt = Date.now() - 31 * 24 * 3600_000;
    const policy = seedPolicy(repos, { enabledAt, validityMs: 30 * 24 * 3600_000 });
    expect(policy.state).toBe('on');
    expect(policy.expiresAt).toBeLessThan(Date.now());
    const { action } = seedPendingCreate(repos);
    const d = seedDecision(repos, { policyId: policy.id, action });
    expect(() => approveRaw(db, action, d.id)).toThrow(/auto approve without live policy decision/);
  });

  it('F4 (2): an auto approval whose final payload differs from canonical_json by ONE byte aborts', () => {
    const { db, repos } = memRepos();
    const policy = seedPolicy(repos);
    const { action } = seedPendingCreate(repos);
    const d = seedDecision(repos, { policyId: policy.id, action });
    const edited = action.canonicalJson.replace('Synthetic meeting', 'Synthetic meetinG');
    expect(edited).not.toBe(action.canonicalJson);
    expect(edited.length).toBe(action.canonicalJson.length);
    expect(() => approveRaw(db, action, d.id, edited)).toThrow(/auto approve without live policy decision/);
  });

  it("F4: a decision of kind 'update' does not approve a create_event", () => {
    const { db, repos } = memRepos();
    const policy = seedPolicy(repos);
    const { action } = seedPendingCreate(repos);
    const d = seedDecision(repos, { policyId: policy.id, action, kind: 'update' });
    expect(() => approveRaw(db, action, d.id)).toThrow(/auto approve without live policy decision/);
  });
});

describe("I1' - send_reply needs a click", () => {
  it.each([
    ["'user_toast'", 'user_toast'],
    ["'auto'", 'auto'],
  ])('send_reply approved by %s => abort', (_label, by) => {
    const { db, repos } = memRepos();
    const { action } = seedPendingAction(repos);
    expect(() => approveRaw(db, action, by)).toThrow(/send needs a click/);
  });

  it('send_reply approved by a (legal-looking) auto decision id => abort', () => {
    const { db, repos } = memRepos();
    const policy = seedPolicy(repos);
    const { action } = seedPendingAction(repos);
    // No decision kind matches a send; even a raw row naming this action cannot make the send automatic.
    const d = seedDecision(repos, { policyId: policy.id, action, kind: 'create' });
    expect(() => approveRaw(db, action, d.id)).toThrow(/send needs a click/);
    expect(repos.actions.markApprovedExecuting(action.id, action.canonicalJson, T0, d.id)).toBe('stale');
  });

  it("'user' still approves a send (the v1 click path is unchanged)", () => {
    const { repos } = memRepos();
    const { action } = seedPendingAction(repos);
    expect(repos.actions.markApprovedExecuting(action.id, action.canonicalJson, T0, 'user')).toBe('ok');
    expect(repos.actions.byId(action.id)).toMatchObject({ state: 'executing', approvedBy: 'user' });
  });
});

describe("I1' - update_event: the toast approves undo only, auto never approves an undo", () => {
  function eventWithUpdate(repos: Repos, change: 'reschedule' | 'cancel' | 'undo'): { action: ApprovalAction } {
    const created = seedCreatedEvent(repos);
    return seedPendingUpdate(repos, created, { change, now: T0 + 1000 });
  }

  it.each(['reschedule', 'cancel'] as const)("'user_toast' on a %s => abort (F4 (1))", (change) => {
    const { db, repos } = memRepos();
    const { action } = eventWithUpdate(repos, change);
    expect(() => approveRaw(db, action, 'user_toast')).toThrow(/toast approves undo only/);
  });

  it("'user_toast' on an undo payload with revertOf passes", () => {
    const { repos } = memRepos();
    const { action } = eventWithUpdate(repos, 'undo');
    expect(repos.actions.markApprovedExecuting(action.id, action.canonicalJson, T0, 'user_toast')).toBe('ok');
    expect(repos.actions.byId(action.id)).toMatchObject({ state: 'executing', approvedBy: 'user_toast' });
  });

  it('an auto decision on an undo payload => abort (undo is always a click or the toast)', () => {
    const { db, repos } = memRepos();
    const policy = seedPolicy(repos);
    const { action } = eventWithUpdate(repos, 'undo');
    const d = seedDecision(repos, { policyId: policy.id, action, kind: 'update' });
    expect(() => approveRaw(db, action, d.id)).toThrow(/auto approve without live policy decision/);
  });

  it("F4: a decision of kind 'create' does not approve an update_event", () => {
    const { db, repos } = memRepos();
    const policy = seedPolicy(repos);
    const { action } = eventWithUpdate(repos, 'reschedule');
    const d = seedDecision(repos, { policyId: policy.id, action, kind: 'create' });
    expect(() => approveRaw(db, action, d.id)).toThrow(/auto approve without live policy decision/);
  });

  it.each([
    ['update', 'reschedule'],
    ['cancel', 'cancel'],
  ] as const)("a live 'on' decision of kind %s approves a %s", (kind, change) => {
    const { repos } = memRepos();
    const policy = seedPolicy(repos);
    const { action } = eventWithUpdate(repos, change);
    const d = seedDecision(repos, { policyId: policy.id, action, kind });
    expect(repos.actions.markApprovedExecuting(action.id, action.canonicalJson, T0, d.id)).toBe('ok');
  });
});

describe("I1' - the legal automatic transaction", () => {
  it('decision + approve + execute inside ONE transaction passes, and the approver is recorded', () => {
    const { db, repos } = memRepos();
    const policy = seedPolicy(repos);
    const { action } = seedPendingCreate(repos);
    const outcome = db.transaction(() => {
      const d = seedDecision(repos, { policyId: policy.id, action });
      return { d, r: repos.actions.markApprovedExecuting(action.id, action.canonicalJson, T0, d.id) };
    });
    expect(outcome.r).toBe('ok');
    expect(repos.actions.byId(action.id)).toMatchObject({
      state: 'executing',
      approvedBy: outcome.d.id,
      approvedFinalJson: action.canonicalJson,
    });
  });

  it('the same statement run OUTSIDE the decision transaction after the policy was paused => abort', () => {
    const { db, repos } = memRepos();
    const policy = seedPolicy(repos);
    const { action } = seedPendingCreate(repos);
    const d = seedDecision(repos, { policyId: policy.id, action });
    repos.autoPolicies.setState(policy.id, { state: 'paused', reason: 'circuit_breaker_rate' });
    expect(() => approveRaw(db, action, d.id)).toThrow(/auto approve without live policy decision/);
    // and resuming makes the very same decision valid again (the trigger reads the policy state at approve time)
    repos.autoPolicies.setState(policy.id, { state: 'on' });
    expect(repos.actions.markApprovedExecuting(action.id, action.canonicalJson, T0, d.id)).toBe('ok');
  });
});

describe("I1' - the approver is frozen once set (trg_actions_approver_frozen)", () => {
  function approvedByUser(repos: Repos): ApprovalAction {
    const { action } = seedPendingCreate(repos);
    expect(repos.actions.markApprovedExecuting(action.id, action.canonicalJson, T0, 'user')).toBe('ok');
    return repos.actions.byId(action.id)!;
  }

  it.each(['executing', 'done', 'failed', 'unknown_outcome'] as const)(
    're-writing approved_by on a %s row aborts',
    (state) => {
      const { db, repos } = memRepos();
      const a = approvedByUser(repos);
      if (state === 'done') repos.actions.markDone(a.id, { kind: 'create_event', eventId: EVT_A, htmlLink: null }, T0);
      if (state === 'failed') repos.actions.markFailed(a.id, 'CAL_CREATE_FAILED', T0);
      if (state === 'unknown_outcome') repos.actions.markUnknownOutcome(a.id, T0);
      expect(repos.actions.byId(a.id)!.state).toBe(state);
      for (const forged of ['auto', 'user_toast', null])
        expect(() => db.prepare(`UPDATE actions SET approved_by = ? WHERE id = ?`).run(forged, a.id)).toThrow(
          /approver is immutable/,
        );
      expect(repos.actions.byId(a.id)!.approvedBy).toBe('user');
    },
  );

  it("an 'approved' row (between the two CAS statements) cannot change its approver either", () => {
    const { db, repos } = memRepos();
    const { action } = seedPendingCreate(repos);
    approveRaw(db, action, 'user');
    expect(stateOf(repos, action)).toBe('approved');
    expect(() => db.prepare(`UPDATE actions SET approved_by = 'someone' WHERE id = ?`).run(action.id)).toThrow(
      /approver is immutable/,
    );
  });

  it('a pending row cannot be given an approver without the approve transition', () => {
    const { db, repos } = memRepos();
    const { action } = seedPendingCreate(repos);
    expect(() => db.prepare(`UPDATE actions SET approved_by = 'user' WHERE id = ?`).run(action.id)).toThrow(
      /approver is immutable/,
    );
  });

  it('an action cannot be born approved or with an approver', () => {
    const { db, repos } = memRepos();
    const { action } = seedPendingCreate(repos);
    expect(() =>
      db
        .prepare(
          `INSERT INTO actions(id, item_id, proposal_id, chat_id, kind, canonical_json, content_sha256, idempotency_key, state,
                               created_at, expires_at, approved_by)
           VALUES ('forged', ?, ?, ?, 'create_event', ?, ?, 'forged-key', 'pending', ?, ?, 'user')`,
        )
        .run(action.itemId, action.proposalId, action.chatId, action.canonicalJson, action.contentSha256, T0, T0 + 1),
    ).toThrow(/born pending/);
  });

  it('the decision row itself is immutable (it cannot be re-pointed at another action or turned into auto)', () => {
    const { db, repos } = memRepos();
    const policy = seedPolicy(repos);
    const { action } = seedPendingCreate(repos);
    const d = seedDecision(repos, { policyId: policy.id, action, verdict: 'fallback' });
    expect(() =>
      db.prepare(`UPDATE auto_decisions SET verdict = 'auto', reason = 'ok' WHERE id = ?`).run(d.id),
    ).toThrow(/append-only/);
  });
});
