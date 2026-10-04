// T2 5 row `db/*`: auto_policies (B7). Single live row (ux_auto_policies_live), born shadow|on, grant immutable, closed rows final,
// scope + confirm re-validated on every read (a bad live row => none + one db_recovery audit row), never purged.
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AUTO_SCOPE } from '../../../shared/schemas';
import type * as T from '../../../shared/types';
import { RepoContractError, RowNotFoundError } from '../errors';
import { createAutoPoliciesRepo } from './autoPolicies';
import { cleanup, memRepos, seedPolicy, T0, TEST_CONFIRM } from '../__fixtures__/testDb';

afterEach(cleanup);

const DAY = 24 * 3600_000;
const grant = (over: Partial<Parameters<ReturnType<typeof createAutoPoliciesRepo>['insert']>[0]> = {}) => ({
  id: 'p1',
  state: 'shadow' as const,
  enabledAt: T0,
  expiresAt: T0 + 30 * DAY,
  shadowUntil: T0 + DAY,
  confirmedBy: 'native_dialog' as const,
  confirm: TEST_CONFIRM,
  scope: DEFAULT_AUTO_SCOPE,
  snapshotSha: 'a'.repeat(64),
  ...over,
});

describe('repos.autoPolicies - insert and the grant', () => {
  it('stores and reads back a validated grant; newest() and live() see it', () => {
    const { repos } = memRepos();
    const p = repos.autoPolicies.insert(grant());
    expect(p).toEqual({ ...grant(), pausedReason: null, disabledAt: null, disabledReason: null });
    expect(repos.autoPolicies.live()).toEqual(p);
    expect(repos.autoPolicies.newest()).toEqual(p);
  });

  it('validates scope and confirm on write (the zod ceilings are the hard cage)', () => {
    const { repos } = memRepos();
    expect(() => repos.autoPolicies.insert(grant({ scope: { ...DEFAULT_AUTO_SCOPE, globalPerDay: 99 } }))).toThrow();
    expect(() =>
      repos.autoPolicies.insert(grant({ scope: { ...DEFAULT_AUTO_SCOPE, knownContactsOnly: false as true } })),
    ).toThrow();
    expect(() =>
      repos.autoPolicies.insert(grant({ confirm: { ...TEST_CONFIRM, checkboxChecked: false as true } })),
    ).toThrow();
    expect(repos.autoPolicies.newest()).toBeNull();
  });

  it('is born shadow or on only; the DDL bounds validity to 90 days and the shadow window to the grant', () => {
    const { repos } = memRepos();
    for (const state of ['paused', 'disabled', 'expired'] as const)
      expect(() => repos.autoPolicies.insert(grant({ id: state, state: state as 'on' }))).toThrow(/born shadow or on/);
    expect(() => repos.autoPolicies.insert(grant({ expiresAt: T0 + 91 * DAY }))).toThrow(/CHECK/);
    expect(() => repos.autoPolicies.insert(grant({ shadowUntil: T0 - 1 }))).toThrow(/CHECK/);
    expect(() => repos.autoPolicies.insert(grant({ snapshotSha: 'short' }))).toThrow(/CHECK/);
  });

  it('ux_auto_policies_live: a second live row is refused while one is shadow|on|paused, allowed once it is closed', () => {
    const { repos } = memRepos();
    repos.autoPolicies.insert(grant({ id: 'p1', state: 'on', shadowUntil: T0 }));
    expect(() => repos.autoPolicies.insert(grant({ id: 'p2' }))).toThrow(/UNIQUE/);
    repos.autoPolicies.setState('p1', { state: 'paused', reason: 'user' });
    expect(() => repos.autoPolicies.insert(grant({ id: 'p2' }))).toThrow(/UNIQUE/);
    repos.autoPolicies.setState('p1', { state: 'disabled', reason: 'user', at: T0 + 5 });
    const p2 = repos.autoPolicies.insert(grant({ id: 'p2', enabledAt: T0 + 10, shadowUntil: T0 + 10 + DAY }));
    expect(repos.autoPolicies.live()!.id).toBe('p2');
    expect(repos.autoPolicies.newest()!.id).toBe(p2.id);
  });

  it('the grant columns are immutable', () => {
    const { db, repos } = memRepos();
    repos.autoPolicies.insert(grant());
    for (const set of [
      `scope_json = '{}'`,
      `confirm_json = '{}'`,
      `expires_at = expires_at + 1`,
      `enabled_at = 1`,
      `shadow_until = shadow_until + 1`,
      `snapshot_sha = '${'b'.repeat(64)}'`,
      `confirmed_by = 'native_dialog'`,
      `id = 'p9'`,
    ])
      expect(() => db.prepare(`UPDATE auto_policies SET ${set} WHERE id = 'p1'`).run(), set).toThrow(/immutable/);
  });
});

describe('repos.autoPolicies - setState', () => {
  it('shadow -> on -> paused(reason) -> on (clears the reason) -> disabled(reason, at)', () => {
    const { repos } = memRepos();
    repos.autoPolicies.insert(grant());
    expect(repos.autoPolicies.setState('p1', { state: 'on' }).state).toBe('on');
    expect(repos.autoPolicies.setState('p1', { state: 'paused', reason: 'circuit_breaker_undo' })).toMatchObject({
      state: 'paused',
      pausedReason: 'circuit_breaker_undo',
    });
    expect(repos.autoPolicies.setState('p1', { state: 'on' })).toMatchObject({ state: 'on', pausedReason: null });
    expect(repos.autoPolicies.setState('p1', { state: 'disabled', reason: 'purge', at: T0 + 7 })).toMatchObject({
      state: 'disabled',
      disabledAt: T0 + 7,
      disabledReason: 'purge',
    });
    expect(repos.autoPolicies.live()).toBeNull();
    expect(repos.autoPolicies.newest()!.state).toBe('disabled');
  });

  it('a closed policy is final and nothing returns to shadow', () => {
    const { repos } = memRepos();
    repos.autoPolicies.insert(grant());
    repos.autoPolicies.setState('p1', { state: 'on' });
    expect(() => repos.autoPolicies.setState('p1', { state: 'on' } as never)).not.toThrow(); // same state: no transition
    expect(() => repos.autoPolicies.setState('p1', { state: 'shadow' } as never)).toThrow(RepoContractError);
    repos.autoPolicies.setState('p1', { state: 'expired' });
    expect(() => repos.autoPolicies.setState('p1', { state: 'on' })).toThrow(/policy closed/);
    expect(() => repos.autoPolicies.setState('p1', { state: 'paused', reason: 'user' })).toThrow(/policy closed/);
  });

  it('the trigger refuses a raw return to shadow and a pause / disable without its reason', () => {
    const { db, repos } = memRepos();
    repos.autoPolicies.insert(grant({ state: 'on', shadowUntil: T0 }));
    expect(() => db.prepare(`UPDATE auto_policies SET state = 'shadow'`).run()).toThrow(/cannot return to shadow/);
    expect(() => db.prepare(`UPDATE auto_policies SET state = 'paused'`).run()).toThrow(/pause needs a reason/);
    expect(() => db.prepare(`UPDATE auto_policies SET state = 'disabled'`).run()).toThrow(
      /disable needs time and reason/,
    );
  });

  it('an unknown id throws RowNotFoundError', () => {
    const { repos } = memRepos();
    expect(() => repos.autoPolicies.setState('nope', { state: 'expired' })).toThrow(RowNotFoundError);
  });
});

describe('repos.autoPolicies - fail-closed reads', () => {
  it('a live row whose scope no longer parses is treated as none: closed (expired) + one db_recovery audit row', () => {
    const { db } = memRepos();
    const repo = createAutoPoliciesRepo(db, () => T0 + 99);
    repo.insert(grant({ state: 'on', shadowUntil: T0 }));
    // simulate a restored / hand-edited file: the grant is immutable to the app, so bypass the trigger for the corruption
    db.exec('DROP TRIGGER trg_auto_policies_frozen');
    db.prepare(`UPDATE auto_policies SET scope_json = ? WHERE id = 'p1'`).run(
      JSON.stringify({ ...DEFAULT_AUTO_SCOPE, globalPerDay: 500 }),
    );
    expect(repo.live()).toBeNull();
    expect(repo.live()).toBeNull(); // idempotent: the row is closed, so no second audit row
    const audits = db
      .prepare<{ ts: number; kind: string; ref: string; detail_json: string }>(
        `SELECT ts, kind, ref, detail_json FROM audit_log`,
      )
      .all();
    expect(audits).toEqual([
      {
        ts: T0 + 99,
        kind: 'db_recovery',
        ref: 'p1',
        detail_json: JSON.stringify({ table: 'auto_policies', reason: 'bad_scope', policyId: 'p1' }),
      },
    ]);
    expect(db.prepare<{ state: string }>(`SELECT state FROM auto_policies WHERE id = 'p1'`).get()!.state).toBe(
      'expired',
    );
    expect(repo.newest()).toBeNull(); // still unparseable
    expect(() => repo.setState('p1', { state: 'expired' })).toThrow(RepoContractError);
  });

  it('bad JSON in confirm_json is a bad row too', () => {
    const { db } = memRepos();
    const repo = createAutoPoliciesRepo(db);
    repo.insert(grant());
    db.exec('DROP TRIGGER trg_auto_policies_frozen');
    db.prepare(`UPDATE auto_policies SET confirm_json = '{broken' WHERE id = 'p1'`).run();
    expect(repo.live()).toBeNull();
  });

  it('seedPolicy (the fixture every trigger test uses) is anchored at the wall clock', () => {
    const { repos } = memRepos();
    const p: T.AutoPolicyRecord = seedPolicy(repos);
    expect(p.expiresAt).toBeGreaterThan(Date.now());
    expect(p.state).toBe('on');
  });
});
