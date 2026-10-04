// T2 5 row `db/*`: auto_decisions are immutable (C2 concern 18), one per action, metadata-only checks, and the shadow tally reads
// each decision's ACTION end state (approved unchanged / edited / dismissed).
import { afterEach, describe, expect, it } from 'vitest';
import type * as T from '../../../shared/types';
import { RepoContractError } from '../errors';
import { cleanup, memRepos, seedDecision, seedPendingCreate, seedPolicy, T0 } from '../__fixtures__/testDb';

afterEach(cleanup);

describe('repos.autoDecisions - insert / forAction', () => {
  it('round-trips a decision; one per action (UNIQUE action_id)', () => {
    const { repos } = memRepos();
    const policy = seedPolicy(repos);
    const { action } = seedPendingCreate(repos);
    const d = seedDecision(repos, { policyId: policy.id, action, verdict: 'fallback', reason: 'quiet_hours' });
    expect(repos.autoDecisions.forAction(action.id)).toEqual(d);
    expect(repos.autoDecisions.forAction('none')).toBeNull();
    expect(() => seedDecision(repos, { id: 'second', policyId: policy.id, action })).toThrow(/UNIQUE/);
  });

  it('refuses unknown enums, and the DDL ties verdict auto|shadow to reason ok', () => {
    const { repos } = memRepos();
    const policy = seedPolicy(repos);
    const { action } = seedPendingCreate(repos);
    const base = { policyId: policy.id, action };
    expect(() => seedDecision(repos, { ...base, kind: 'delete' as T.AutoWriteKind })).toThrow(RepoContractError);
    expect(() => seedDecision(repos, { ...base, verdict: 'maybe' as T.AutoVerdict })).toThrow(RepoContractError);
    expect(() => seedDecision(repos, { ...base, verdict: 'fallback', reason: 'because' as T.AutoReason })).toThrow(
      RepoContractError,
    );
    expect(() => seedDecision(repos, { ...base, verdict: 'auto', reason: 'quiet_hours' })).toThrow(/CHECK/);
    expect(() => seedDecision(repos, { ...base, verdict: 'fallback', reason: 'ok' })).toThrow(/CHECK/);
    expect(() => seedDecision(repos, { ...base, policyId: 'no-such-policy' })).toThrow(/FOREIGN KEY/);
  });

  it('checks_json is metadata only: flat, enum/id/number-shaped values; prose is refused', () => {
    const { repos } = memRepos();
    const policy = seedPolicy(repos);
    const { action } = seedPendingCreate(repos);
    const insert = (checks: unknown): void =>
      repos.autoDecisions.insert({
        id: 'd1',
        policyId: policy.id,
        actionId: action.id,
        itemId: action.itemId,
        chatId: action.chatId,
        kind: 'create',
        verdict: 'fallback',
        reason: 'badge_amber',
        checks: checks as T.AutoDecisionRecord['checks'],
        decidedAt: T0,
      });
    for (const bad of [
      { note: 'please add this meeting' },
      { nested: { a: 1 } },
      { list: [1, 2] },
      { 'bad key': 1 },
      { n: Number.NaN },
      { s: 'a‮b' },
      [],
      null,
      Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 1])),
    ])
      expect(() => insert(bad), JSON.stringify(bad)).toThrow(RepoContractError);
    insert({ tz: 'Asia/Jerusalem', startIso: '2026-10-01T10:00:00+03:00', minutes: 60, ok: true, none: null });
    expect(repos.autoDecisions.forAction(action.id)!.checks).toEqual({
      tz: 'Asia/Jerusalem',
      startIso: '2026-10-01T10:00:00+03:00',
      minutes: 60,
      ok: true,
      none: null,
    });
  });

  it('is immutable: no column of a decision can be updated', () => {
    const { db, repos } = memRepos();
    const policy = seedPolicy(repos);
    const { action } = seedPendingCreate(repos);
    const d = seedDecision(repos, { policyId: policy.id, action, verdict: 'shadow' });
    for (const set of [`verdict = 'auto'`, `reason = 'ok'`, `checks_json = '{}'`, `decided_at = 1`, `action_id = 'x'`])
      expect(() => db.prepare(`UPDATE auto_decisions SET ${set} WHERE id = ?`).run(d.id), set).toThrow(/append-only/);
  });
});

describe('repos.autoDecisions - shadowTally', () => {
  it('counts every decision, the would-be-automatic ones, and their action outcomes', () => {
    const { repos } = memRepos();
    const policy = seedPolicy(repos, { state: 'shadow' });
    const other = 'other-policy';
    let n = 0;
    const next = (): T.ApprovalAction => {
      n += 1;
      return seedPendingCreate(repos, T0 + n, `9725500000${10 + n}@s.whatsapp.net`).action; // one chat each (ux_items_open)
    };
    // 1: shadow, approved unchanged
    const a1 = next();
    seedDecision(repos, { policyId: policy.id, action: a1, verdict: 'shadow' });
    repos.actions.markApprovedExecuting(a1.id, a1.canonicalJson, T0, 'user');
    // 2: shadow, approved with an edit
    const a2 = next();
    seedDecision(repos, { policyId: policy.id, action: a2, verdict: 'shadow' });
    repos.actions.markApprovedExecuting(a2.id, a2.canonicalJson.replace('Synthetic', 'Edited'), T0, 'user');
    // 3, 4, 5: shadow, dismissed (rejected / expired / superseded)
    const a3 = next();
    seedDecision(repos, { policyId: policy.id, action: a3, verdict: 'shadow' });
    repos.actions.markRejected(a3.id);
    const a4 = next();
    seedDecision(repos, { policyId: policy.id, action: a4, verdict: 'shadow' });
    repos.actions.expireOverdue(a4.expiresAt);
    const a5 = next();
    seedDecision(repos, { policyId: policy.id, action: a5, verdict: 'shadow' });
    // (a5 may already be expired by the sweep above - supersede only if it is still pending)
    repos.actions.supersedePending(a5.itemId, T0);
    // 6: shadow, still pending - counts in none of the outcomes
    const a6 = next();
    seedDecision(repos, { policyId: policy.id, action: a6, verdict: 'shadow', decidedAt: T0 + 100 });
    // 7: fallback - seen, but not "would auto"
    const a7 = next();
    seedDecision(repos, { policyId: policy.id, action: a7, verdict: 'fallback', reason: 'quiet_hours' });
    repos.actions.markRejected(a7.id);

    expect(repos.autoDecisions.shadowTally(policy.id)).toEqual({
      decisions: 7,
      wouldAuto: 6,
      approvedUnchanged: 1,
      edited: 1,
      dismissed: 3,
    });
    expect(repos.autoDecisions.shadowTally(other)).toEqual({
      decisions: 0,
      wouldAuto: 0,
      approvedUnchanged: 0,
      edited: 0,
      dismissed: 0,
    });
  });
});
