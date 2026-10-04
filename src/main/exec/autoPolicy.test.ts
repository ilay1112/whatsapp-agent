// src/main/exec/autoPolicy.test.ts - T2 5 row exec/autoPolicy.ts (unit level of 8.2 group 16, I10): the enable preconditions in C2 8
// order, the auto_dialog bucket, the main-owned dialog (response 1 AND the checkbox), shadow first unless "Turn on now" (F34), endShadow
// with >= 3 decisions, pause / resume / disable, expiry + reminder, unattended and calendar-disconnect pauses. Real repos + triggers.
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AUTO_SCOPE } from '../../shared/schemas';
import { LIMITS } from '../../shared/types';
import { createAutoPolicyService } from './autoPolicy';
import { DAYS, HOURS, RIG_NOW, RIG_SNAPSHOT, makeExecRig } from '../../../tests/helpers/ledger.execRig';
import type { AutoPolicyService, AutoPolicyServiceDeps } from './autoPolicy';
import type { Rig } from '../../../tests/helpers/ledger.execRig';
import type { AutoDialog } from '../app/autoDialog';
import type { AutoPausedReason, AutoState, EpochMs } from '../../shared/types';

const rigs: Rig[] = [];
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.stop();
});

interface PolicyHarness {
  r: Rig;
  svc: AutoPolicyService;
  dialogCalls: Array<{ win: unknown; p: Parameters<AutoDialog['confirmEnable']>[1] }>;
  answer: { value: boolean; during?: () => void };
  env: { connected: boolean; surface: boolean; snapshot: string; lastFocus: EpochMs | null };
  notified: AutoState[];
  appPauses: AutoPausedReason[];
  expiring: number;
  audits: Array<{ kind: string; detail: Record<string, unknown> }>;
}

async function harness(opts: { trackRecord?: number; withOptional?: boolean } = {}): Promise<PolicyHarness> {
  const r = await makeExecRig();
  rigs.push(r);
  if ((opts.trackRecord ?? 3) > 0) await r.trackRecord(opts.trackRecord ?? 3);
  const h = {
    r,
    dialogCalls: [] as PolicyHarness['dialogCalls'],
    answer: { value: true } as PolicyHarness['answer'],
    env: { connected: true, surface: true, snapshot: RIG_SNAPSHOT, lastFocus: null as EpochMs | null },
    notified: [] as AutoState[],
    appPauses: [] as AutoPausedReason[],
    expiring: 0,
    audits: [] as PolicyHarness['audits'],
  } as PolicyHarness;
  const dialog: AutoDialog = {
    confirmEnable: (win, p) => {
      h.dialogCalls.push({ win, p });
      h.answer.during?.();
      return Promise.resolve(h.answer.value);
    },
    confirmWorkspaceTrust: () => Promise.resolve(false),
    confirmSetting: () => Promise.resolve(false),
    recorded: () => [],
  };
  const deps: AutoPolicyServiceDeps = {
    repos: r.repos,
    clock: r.clock,
    random: { bytes: (n) => new Uint8Array(n).fill(7), int: () => 0, float: () => 0.5 },
    dialog,
    rate: {
      record: (b, k, now) => r.repos.rate.record(b, k, now),
      countSince: (b, k, since) => r.repos.rate.countSince(b, k, since),
    },
    calendarRoles: () => ({ primary: 'owner' }),
    updateSurfaceAvailable: () => h.env.surface,
    snapshotSha: () => h.env.snapshot,
    audit: (kind, _ref, detail) => void h.audits.push({ kind, detail }),
    notify: (s) => void h.notified.push(s),
    ...(opts.withOptional === false
      ? {}
      : {
          calendarConnected: () => h.env.connected,
          calendarName: () => 'Personal',
          versions: () => ({ app: '2.0.0', electron: '44.4.3' }),
          lastFocusAt: () => h.env.lastFocus,
          onAppPause: (reason: AutoPausedReason) => void h.appPauses.push(reason),
          onExpiring: () => void (h.expiring += 1),
        }),
  };
  h.svc = createAutoPolicyService(deps);
  return h;
}

const REQ = (trial: boolean, over: Partial<typeof DEFAULT_AUTO_SCOPE> = {}) => ({
  scope: { ...DEFAULT_AUTO_SCOPE, ...over },
  trial,
});
const WIN = { id: 1 };

describe('getState', () => {
  it('no policy: preconditions only, no tally, zero usage', async () => {
    const h = await harness();
    expect(h.svc.getState()).toEqual({
      policy: null,
      preconditions: {
        calendarConnected: true,
        calendarOwned: true,
        approvedCreates: 3,
        approvedCreatesNeeded: LIMITS.autoTrackRecordCreates,
        providerAllowsAuto: true,
        updatesAvailable: true,
      },
      shadowTally: null,
      usedToday: { writes: 0, limit: 0 },
      undoableCount: 0,
    });
  });
  it('an ended policy is shown (newest closed row) without a tally', async () => {
    const h = await harness();
    const p = h.r.policy('on');
    h.svc.disable('user');
    expect(h.svc.getState().policy).toMatchObject({ id: p.id, state: 'disabled' });
    expect(h.svc.getState().shadowTally).toBeNull();
  });
});

describe('requestEnable (C2 8 order, I10)', () => {
  it('trial => a shadow row after the dialog (response 1 + checkbox), confirm_json, snapshot, audit, auto:changed', async () => {
    const h = await harness();
    const res = await h.svc.requestEnable(REQ(true), WIN);
    expect(res.ok).toBe(true);
    expect(h.dialogCalls).toEqual([
      {
        win: WIN,
        p: { calendarName: 'Personal', trial: true, validityDays: 30, endsOn: '2026-11-04', scope: DEFAULT_AUTO_SCOPE },
      },
    ]);
    const live = h.r.repos.autoPolicies.live()!;
    expect(live).toMatchObject({
      state: 'shadow',
      enabledAt: RIG_NOW,
      shadowUntil: RIG_NOW + LIMITS.autoShadowMs,
      expiresAt: RIG_NOW + 30 * DAYS,
      confirmedBy: 'native_dialog',
      snapshotSha: RIG_SNAPSHOT,
      confirm: {
        dialogResponse: 1,
        checkboxChecked: true,
        windowFocused: true,
        trial: true,
        approvedCreates: 3,
        appVersion: '2.0.0',
      },
    });
    expect(live.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(h.audits.map((a) => a.kind)).toContain('auto_policy_enabled');
    expect(h.notified.at(-1)!.policy!.state).toBe('shadow');
  });
  it('auto-mode-7: the scope that becomes the grant is exactly the scope the dialog was shown (cancels / quiet hours)', async () => {
    const h = await harness();
    const wide = { cancels: true, quietHours: null, validityDays: 90 as const };
    expect((await h.svc.requestEnable(REQ(true, wide), WIN)).ok).toBe(true);
    expect(h.dialogCalls[0]!.p.scope).toEqual({ ...DEFAULT_AUTO_SCOPE, ...wide });
    expect(h.r.repos.autoPolicies.live()!.scope).toEqual(h.dialogCalls[0]!.p.scope);
  });
  it('an unusable time zone in settings still shows an end date (UTC fallback)', async () => {
    const h = await harness();
    h.r.repos.settings.setInternal((st) => void (st.general.timeZone = 'Mars/Olympus_Mons'));
    await h.svc.requestEnable(REQ(true), WIN);
    expect(h.dialogCalls[0]!.p.endsOn).toBe('2026-11-04');
  });
  it('"Turn on now" (F34) => an on row with shadow_until = enabled_at; 90 days is the other validity', async () => {
    const h = await harness();
    expect((await h.svc.requestEnable(REQ(false, { validityDays: 90 }), WIN)).ok).toBe(true);
    const live = h.r.repos.autoPolicies.live()!;
    expect(live).toMatchObject({ state: 'on', shadowUntil: live.enabledAt, expiresAt: RIG_NOW + 90 * DAYS });
  });
  it('preconditions refuse in order, each WITHOUT a dialog', async () => {
    const cases: Array<[(h: PolicyHarness) => void, string]> = [
      [(h) => (h.env.connected = false), 'CAL_UNAVAILABLE'],
      [(h) => (h.env.surface = false), 'CAL_UPDATE_UNAVAILABLE'],
      [(h) => h.r.repos.meta.set('calendar_roles_json', '{}'), 'AUTO_CALENDAR_NOT_OWNED'],
      [(h) => void h.r.policy('shadow'), 'BAD_REQUEST'],
      [(h) => h.r.repos.settings.setInternal((s) => void (s.llm.provider = 'antigravity_cli')), 'BAD_REQUEST'],
      [(h) => (h.env.snapshot = ''), 'AUTO_CALENDAR_NOT_OWNED'],
    ];
    for (const [arrange, code] of cases) {
      const h = await harness();
      arrange(h);
      if (code === 'AUTO_CALENDAR_NOT_OWNED' && h.env.snapshot !== '') {
        // roles come from the deps in this harness: emulate "absent" through a fresh service with no role
        const svc = createAutoPolicyService({
          repos: h.r.repos,
          clock: h.r.clock,
          random: { bytes: (n) => new Uint8Array(n), int: () => 0, float: () => 0 },
          dialog: {
            confirmEnable: () => Promise.resolve(true),
            confirmWorkspaceTrust: () => Promise.resolve(false),
            confirmSetting: () => Promise.resolve(false),
            recorded: () => [],
          },
          rate: { record: () => undefined, countSince: () => 0 },
          calendarRoles: () => ({ primary: 'writer' }),
          updateSurfaceAvailable: () => true,
          snapshotSha: () => RIG_SNAPSHOT,
          audit: () => undefined,
          notify: () => undefined,
          calendarConnected: () => true,
        });
        expect(await svc.requestEnable(REQ(true), WIN)).toEqual({ ok: false, error: { code } });
        continue;
      }
      expect(await h.svc.requestEnable(REQ(true), WIN)).toEqual({ ok: false, error: { code } });
      expect(h.dialogCalls).toEqual([]);
    }
  });
  it('0/1/2 user-approved creates => AUTO_NO_TRACK_RECORD, no dialog, no row', async () => {
    for (const n of [0, 1, 2]) {
      const h = await harness({ trackRecord: n });
      expect(await h.svc.requestEnable(REQ(true), WIN)).toEqual({ ok: false, error: { code: 'AUTO_NO_TRACK_RECORD' } });
      expect(h.dialogCalls).toEqual([]);
      expect(h.r.repos.autoPolicies.newest()).toBeNull();
    }
  });
  it('dialog cancel / no checkbox => AUTO_NOT_CONFIRMED, no row', async () => {
    const h = await harness();
    h.answer.value = false;
    expect(await h.svc.requestEnable(REQ(true), WIN)).toEqual({ ok: false, error: { code: 'AUTO_NOT_CONFIRMED' } });
    expect(h.r.repos.autoPolicies.newest()).toBeNull();
  });
  it('the world changed while the dialog was open (calendar disconnected) => refused, no row', async () => {
    const h = await harness();
    h.answer.during = () => void (h.env.connected = false);
    expect(await h.svc.requestEnable(REQ(true), WIN)).toEqual({ ok: false, error: { code: 'CAL_UNAVAILABLE' } });
    expect(h.r.repos.autoPolicies.newest()).toBeNull();
  });
  it('the 4th request in an hour is rate-limited (auto_dialog 3/h), with no dialog', async () => {
    const h = await harness();
    h.answer.value = false;
    for (let i = 0; i < LIMITS.autoDialogPerHour; i++) await h.svc.requestEnable(REQ(true), WIN);
    expect(h.dialogCalls).toHaveLength(3);
    expect(await h.svc.requestEnable(REQ(true), WIN)).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(h.dialogCalls).toHaveLength(3);
    await h.r.clock.advance(HOURS + 1);
    await h.svc.requestEnable(REQ(true), WIN);
    expect(h.dialogCalls).toHaveLength(4);
  });
  it('a scope outside the ceilings is BAD_REQUEST (the IPC schema already refuses it; the service re-checks)', async () => {
    const h = await harness();
    expect(await h.svc.requestEnable({ scope: { ...DEFAULT_AUTO_SCOPE, horizonDays: 31 }, trial: true }, WIN)).toEqual({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    });
  });
  it('without the optional deps it fails closed (calendar not connected)', async () => {
    const h = await harness({ withOptional: false });
    expect(await h.svc.requestEnable(REQ(true), WIN)).toEqual({ ok: false, error: { code: 'CAL_UNAVAILABLE' } });
  });
});

describe('endShadow / pause / resume / disable', () => {
  async function shadowWithDecisions(n: number): Promise<PolicyHarness> {
    const h = await harness();
    await h.svc.requestEnable(REQ(true), WIN);
    for (let i = 0; i < n; i++) {
      const c = h.r.seedCreate({
        chatN: 20 + i,
        slot: { startLocal: `2026-10-1${String(i)}T10:00:00`, endLocal: `2026-10-1${String(i)}T11:00:00` },
      });
      expect((await h.r.exec.tryAuto(c.action.id)).verdict).toBe('shadow');
    }
    return h;
  }
  it('endShadow is refused with 2 decisions and accepted with 3; never on a non-shadow policy', async () => {
    const h2 = await shadowWithDecisions(2);
    expect(h2.svc.endShadow()).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    const h3 = await shadowWithDecisions(3);
    const res = h3.svc.endShadow();
    expect(res).toMatchObject({ ok: true, value: { policy: { state: 'on' } } });
    expect(h3.audits.map((a) => a.kind)).toContain('auto_policy_shadow_ended');
    expect(h3.svc.endShadow()).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
  });
  it('endShadow after a snapshot change is refused', async () => {
    const h = await shadowWithDecisions(3);
    h.env.snapshot = 'c'.repeat(64);
    expect(h.svc.endShadow()).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
  });
  it('a shadow policy never becomes on by itself, at or after shadow_until', async () => {
    const h = await shadowWithDecisions(3);
    await h.r.clock.advance(LIMITS.autoShadowMs + HOURS);
    h.svc.tick(h.r.clock.now() as EpochMs);
    expect(h.r.repos.autoPolicies.live()!.state).toBe('shadow');
  });
  it('pause: no policy => BAD_REQUEST; user pause => paused without a toast; an app pause toasts; idempotent', async () => {
    const h = await harness();
    expect(h.svc.pause('user')).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    h.r.policy('on');
    expect(h.svc.pause('user')).toMatchObject({
      ok: true,
      value: { policy: { state: 'paused', pausedReason: 'user' } },
    });
    expect(h.appPauses).toEqual([]);
    expect(h.svc.pause('circuit_breaker_rate')).toMatchObject({
      ok: true,
      value: { policy: { pausedReason: 'user' } },
    });
    const h2 = await harness();
    h2.r.policy('on');
    h2.svc.pause('circuit_breaker_rate');
    expect(h2.appPauses).toEqual(['circuit_breaker_rate']);
  });
  it('resume: needs a paused policy, re-checks the preconditions and the snapshot, then turns it on', async () => {
    const h = await harness();
    expect(await h.svc.resume(WIN)).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    h.r.policy('paused');
    h.env.surface = false;
    expect(await h.svc.resume(WIN)).toEqual({ ok: false, error: { code: 'CAL_UPDATE_UNAVAILABLE' } });
    h.env.surface = true;
    h.env.snapshot = 'd'.repeat(64);
    expect(await h.svc.resume(WIN)).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    h.env.snapshot = RIG_SNAPSHOT;
    expect(await h.svc.resume(WIN)).toMatchObject({ ok: true, value: { policy: { state: 'on', pausedReason: null } } });
    expect(h.audits.map((a) => a.kind)).toContain('auto_policy_resumed');
  });
  it('resume of an expired paused policy => expired + BAD_REQUEST', async () => {
    const h = await harness();
    h.r.policy('paused', {}, { expiresAt: (RIG_NOW + HOURS) as EpochMs });
    await h.r.clock.advance(2 * HOURS);
    expect(await h.svc.resume(WIN)).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(h.r.repos.autoPolicies.newest()!.state).toBe('expired');
  });
  it('a paused TRIAL resumes only when it could have been ended anyway (>= 3 decisions)', async () => {
    const h = await shadowWithDecisions(2);
    h.svc.pause('user');
    expect(await h.svc.resume(WIN)).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    const h3 = await shadowWithDecisions(3);
    h3.svc.pause('user');
    expect(await h3.svc.resume(WIN)).toMatchObject({ ok: true, value: { policy: { state: 'on' } } });
  });
  it('a trial whose shadow was ended by the user resumes normally', async () => {
    const h = await shadowWithDecisions(3);
    h.svc.endShadow();
    h.svc.pause('user');
    expect(await h.svc.resume(WIN)).toMatchObject({ ok: true, value: { policy: { state: 'on' } } });
  });
  it('disable works with and without a live row (fail-safe direction)', async () => {
    const h = await harness();
    expect(h.svc.disable('user')).toMatchObject({ ok: true, value: { policy: null } });
    h.r.policy('shadow');
    expect(h.svc.disable('purge')).toMatchObject({ ok: true, value: { policy: { state: 'disabled' } } });
    expect(h.r.repos.autoPolicies.live()).toBeNull();
    expect(h.audits.find((a) => a.kind === 'auto_policy_disabled')!.detail).toEqual({ reason: 'purge' });
  });
});

describe('tick: expiry, reminder, unattended, calendar disconnect', () => {
  it('expiry at expires_at; the reminder toast fires once, 3 days before', async () => {
    const h = await harness();
    h.r.policy('on');
    h.env.lastFocus = h.r.clock.now() as EpochMs;
    await h.r.clock.advance(27 * DAYS - HOURS);
    h.env.lastFocus = h.r.clock.now() as EpochMs;
    h.svc.tick(h.r.clock.now() as EpochMs);
    expect(h.expiring).toBe(0);
    await h.r.clock.advance(2 * HOURS);
    h.env.lastFocus = h.r.clock.now() as EpochMs;
    h.svc.tick(h.r.clock.now() as EpochMs);
    h.svc.tick(h.r.clock.now() as EpochMs);
    expect(h.expiring).toBe(1);
    await h.r.clock.advance(3 * DAYS);
    h.svc.tick(h.r.clock.now() as EpochMs);
    expect(h.r.repos.autoPolicies.live()).toBeNull();
    expect(h.r.repos.autoPolicies.newest()!.state).toBe('expired');
    h.svc.tick(h.r.clock.now() as EpochMs); // nothing live: a no-op
  });
  it('7 days without window focus => paused/unattended (+ toast); a paused policy is left alone', async () => {
    const h = await harness();
    h.r.policy('on');
    h.env.lastFocus = RIG_NOW;
    await h.r.clock.advance(LIMITS.autoUnattendedMs - 1);
    h.svc.tick(h.r.clock.now() as EpochMs);
    expect(h.r.repos.autoPolicies.live()!.state).toBe('on');
    await h.r.clock.advance(1);
    h.svc.tick(h.r.clock.now() as EpochMs);
    expect(h.r.repos.autoPolicies.live()).toMatchObject({ state: 'paused', pausedReason: 'unattended' });
    expect(h.appPauses).toEqual(['unattended']);
    h.svc.tick(h.r.clock.now() as EpochMs);
    expect(h.appPauses).toEqual(['unattended']);
  });
  it('a disconnected calendar pauses the policy (calendar_disconnected); without the dep the tick cannot tell and does nothing', async () => {
    const h = await harness();
    h.r.policy('on');
    h.env.lastFocus = RIG_NOW;
    h.env.connected = false;
    h.svc.tick(h.r.clock.now() as EpochMs);
    expect(h.r.repos.autoPolicies.live()).toMatchObject({ state: 'paused', pausedReason: 'calendar_disconnected' });
    const h2 = await harness({ withOptional: false });
    h2.r.policy('on');
    h2.svc.tick(h2.r.clock.now() as EpochMs);
    expect(h2.r.repos.autoPolicies.live()!.state).toBe('on');
  });
});
