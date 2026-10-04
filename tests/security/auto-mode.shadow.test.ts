// tests/security/auto-mode.shadow.test.ts - T2 8.2 group 16 (I10, B7): shadow records decisions and writes NOTHING, never becomes `on` by
// itself (at or after shadow_until), auto:endShadow needs >= 3 decisions and a focused window; every automatic pause trigger of B7
// (snapshot change, calendar disconnect, budget hit, 2 undos / 24 h, unknown_outcome, 7 d unattended) pauses with the right reason, and
// manual approvals keep working in every paused state.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_AUTO_SCOPE } from '../../src/shared/schemas.ts';
import { LIMITS } from '../../src/shared/types.ts';
import { dialog, resetElectronMock } from '../mocks/electron.ts';
import { CTX, stopRigsChecked } from '../helpers/ledger.execRig.ts';
import { makePolicyWorld } from '../helpers/ledger.policyWorld.ts';
import type { Rig } from '../helpers/ledger.execRig.ts';
import type { PolicyWorld } from '../helpers/ledger.policyWorld.ts';
import type { AutoPausedReason, EpochMs } from '../../src/shared/types.ts';

const rigs: Rig[] = [];
beforeEach(() => resetElectronMock());
afterEach(() => stopRigsChecked(rigs));
const MIN = 60_000;
const HOUR = 60 * MIN;

async function enabled(trial: boolean, rig: Parameters<typeof makePolicyWorld>[0] = {}): Promise<PolicyWorld> {
  const w = await makePolicyWorld(rig);
  rigs.push(w.rig);
  dialog.__script([{ response: 1, checkboxChecked: true }]);
  const res = await w.handlers['auto:requestEnable']({ scope: { ...DEFAULT_AUTO_SCOPE, cancels: true }, trial }, CTX);
  if (!res.ok) throw new Error(JSON.stringify(res));
  w.rig.attachLedger();
  return w;
}
let n = 0;
const slot = (day: number, hour = 10) => ({
  startLocal: `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00`,
  endLocal: `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:30:00`,
});
async function eligible(w: PolicyWorld, day: number) {
  const c = w.rig.seedCreate({ chatN: 30 + n++, slot: slot(day) });
  return { c, out: await w.rig.exec.tryAuto(c.action.id) };
}

describe('shadow', () => {
  it('records shadow decisions, writes nothing, keeps every card pending; never `on` by itself after shadow_until', async () => {
    const w = await enabled(true);
    const creates = w.rig.cal.calls.filter((c) => c.tool === 'create-event').length;
    for (const day of [7, 8, 9]) {
      const { c, out } = await eligible(w, day);
      expect(out).toMatchObject({ verdict: 'shadow', reason: 'ok' });
      expect(w.rig.repos.actions.byId(c.action.id)!.state).toBe('pending');
    }
    expect(w.rig.cal.calls.filter((c) => c.tool === 'create-event').length).toBe(creates);
    expect(w.rig.repos.autoWrites.since(0 as EpochMs)).toEqual([]);
    await w.rig.clock.advance(LIMITS.autoShadowMs + HOUR);
    w.env.lastFocus = w.rig.clock.now() as EpochMs;
    w.svc.tick(w.rig.clock.now() as EpochMs);
    expect(w.rig.repos.autoPolicies.live()!.state).toBe('shadow');
    const { out } = await eligible(w, 10);
    expect(out.verdict).toBe('shadow');
  });
  it('auto:endShadow: refused with 2 decisions, refused unfocused, accepted with 3 and focus => on', async () => {
    const w = await enabled(true);
    await eligible(w, 7);
    await eligible(w, 8);
    expect(await w.handlers['auto:endShadow']({ confirm: true }, CTX)).toEqual({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    });
    await eligible(w, 9);
    expect(await w.handlers['auto:endShadow']({ confirm: true }, { ...CTX, windowFocused: false })).toEqual({
      ok: false,
      error: { code: 'WINDOW_NOT_FOCUSED' },
    });
    expect(await w.handlers['auto:endShadow']({ confirm: true }, CTX)).toMatchObject({
      ok: true,
      value: { policy: { state: 'on' } },
    });
    const { out } = await eligible(w, 10);
    expect(out).toMatchObject({ verdict: 'auto', result: 'done' });
  });
  it('the shadow tally sees approved-unchanged / edited / dismissed cards', async () => {
    const w = await enabled(true);
    const a = await eligible(w, 7);
    const b = await eligible(w, 8);
    const c = await eligible(w, 9);
    await w.rig.click(a.c.action.id);
    await w.rig.click(b.c.action.id, {
      edit: {
        title: 'Dentist (moved)',
        startLocal: '2026-10-08T11:00:00',
        endLocal: '2026-10-08T11:30:00',
        location: '',
      },
    });
    await w.rig.exec.reject(c.c.action.id as never);
    expect(w.svc.getState().shadowTally).toMatchObject({
      decisions: 3,
      wouldAuto: 3,
      approvedUnchanged: 1,
      edited: 1,
      dismissed: 1,
    });
  });
});

describe('every automatic pause trigger of B7 (and manual approvals keep working)', () => {
  async function pausedBy(w: PolicyWorld, reason: AutoPausedReason): Promise<void> {
    expect(w.rig.repos.autoPolicies.live()).toMatchObject({ state: 'paused', pausedReason: reason });
    // a click approval still works while paused
    const manual = w.rig.seedCreate({ chatN: 90 + n++, slot: slot(20, 12) });
    expect(await w.rig.click(manual.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    // and nothing is automatic any more
    const { out } = await eligible(w, 21);
    expect(out).toMatchObject({ verdict: 'fallback', reason: 'policy_paused' });
  }
  it('snapshot change', async () => {
    const w = await enabled(false);
    w.snapshot.input = { ...w.snapshot.input, provider: 'claude' };
    expect((await eligible(w, 7)).out.reason).toBe('snapshot_changed');
    w.snapshot.input = { ...w.snapshot.input, provider: 'local' };
    await pausedBy(w, 'snapshot_changed');
  });
  it('calendar disconnect (at decision time and on the tick)', async () => {
    const w = await enabled(false);
    w.env.connected = false;
    expect((await eligible(w, 7)).out.reason).toBe('calendar_disconnected');
    w.env.connected = true;
    await pausedBy(w, 'calendar_disconnected');
    const w2 = await enabled(false);
    w2.env.connected = false;
    w2.env.lastFocus = w2.rig.clock.now() as EpochMs;
    w2.svc.tick(w2.rig.clock.now() as EpochMs);
    expect(w2.rig.repos.autoPolicies.live()!.pausedReason).toBe('calendar_disconnected');
  });
  it('a budget hit', async () => {
    const w = await enabled(false);
    const first = w.rig.seedCreate({ chatN: 5, slot: slot(7) });
    expect((await w.rig.exec.tryAuto(first.action.id)).reason).toBe('ok');
    await w.rig.clock.advance(5 * MIN);
    const second = w.rig.seedCreate({ chatN: 5, slot: slot(8) });
    expect((await w.rig.exec.tryAuto(second.action.id)).reason).toBe('auto_budget');
    await pausedBy(w, 'circuit_breaker_rate');
  });
  it('2 undos within 24 h', async () => {
    const w = await enabled(false);
    const writes: string[] = [];
    for (const day of [7, 8]) {
      const { out } = await eligible(w, day);
      if (out.verdict === 'none') throw new Error('none');
      writes.push(out.autoWriteId!);
      await w.rig.clock.advance(31 * MIN);
    }
    expect(await w.handlers['auto:undo']({ autoWriteId: writes[0]! }, CTX)).toMatchObject({ ok: true });
    expect(w.rig.repos.autoPolicies.live()!.state).toBe('on');
    expect(await w.handlers['auto:undo']({ autoWriteId: writes[1]! }, CTX)).toMatchObject({ ok: true });
    await pausedBy(w, 'circuit_breaker_undo');
  });
  it('an unknown_outcome', async () => {
    // an automatic create that is never answered (timeout) is an UNKNOWN outcome, not a failure (one such answer only)
    let unanswered = 1;
    const w = await enabled(false, {
      rig: {
        wrapWrite: (real) => ({
          ...real,
          createEvent: (args) =>
            args.summary.startsWith('Track') || unanswered-- <= 0
              ? real.createEvent(args)
              : Promise.resolve({ ok: false as const, error: 'timeout' as const }),
        }),
      },
    });
    const c = w.rig.seedCreate({ chatN: 6, slot: slot(7) });
    expect(await w.rig.exec.tryAuto(c.action.id)).toMatchObject({ verdict: 'auto', result: 'unknown_outcome' });
    await pausedBy(w, 'circuit_breaker_unknown');
  });
  it('7 days without window focus', async () => {
    const w = await enabled(false);
    w.env.lastFocus = w.rig.clock.now() as EpochMs;
    await w.rig.clock.advance(LIMITS.autoUnattendedMs);
    w.svc.tick(w.rig.clock.now() as EpochMs);
    expect(w.appPauses).toEqual(['unattended']);
    expect(w.rig.repos.autoPolicies.live()).toMatchObject({ state: 'paused', pausedReason: 'unattended' });
  });
});

// [v2-closeout auto-mode-8] "Resume" on a trial the APP paused (unattended / calendar disconnect / snapshot change) used to set the policy
// straight to `on` once 3 shadow decisions existed - real automatic writes without the user's explicit "Turn on for real". Through the
// real auto:resume handler, the real policy service, the real repo and the v5 trigger: a paused trial resumes as `shadow`, writes nothing,
// and only auto:endShadow (a focused click) ever turns it on.
describe('auto-mode-8: Resume returns to the state the user last confirmed', () => {
  async function trialWithDecisions(): Promise<PolicyWorld> {
    const w = await enabled(true);
    for (const day of [7, 8, 9]) expect((await eligible(w, day)).out.verdict).toBe('shadow');
    return w;
  }
  it('a trial paused by the unattended tick resumes as shadow: zero automatic writes until auto:endShadow', async () => {
    const w = await trialWithDecisions();
    w.env.lastFocus = w.rig.clock.now() as EpochMs;
    await w.rig.clock.advance(LIMITS.autoUnattendedMs);
    w.svc.tick(w.rig.clock.now() as EpochMs);
    expect(w.rig.repos.autoPolicies.live()).toMatchObject({ state: 'paused', pausedReason: 'unattended' });
    w.env.lastFocus = w.rig.clock.now() as EpochMs;
    expect(await w.handlers['auto:resume']({ confirm: true }, CTX)).toMatchObject({
      ok: true,
      value: { policy: { state: 'shadow', pausedReason: null } },
    });
    const creates = w.rig.cal.calls.filter((c) => c.tool === 'create-event').length;
    const { c, out } = await eligible(w, 22); // the clock moved 7 days: a slot well after the 15-min lead
    expect(out).toMatchObject({ verdict: 'shadow', reason: 'ok' });
    expect(w.rig.repos.actions.byId(c.action.id)!.state).toBe('pending');
    expect(w.rig.cal.calls.filter((x) => x.tool === 'create-event').length).toBe(creates);
    expect(w.rig.repos.autoWrites.since(0 as EpochMs)).toEqual([]);
    // the explicit step still works afterwards
    expect(await w.handlers['auto:endShadow']({ confirm: true }, CTX)).toMatchObject({
      ok: true,
      value: { policy: { state: 'on' } },
    });
  });
  it('a trial paused by a calendar disconnect resumes as shadow; a raw promotion is refused by the database', async () => {
    const w = await trialWithDecisions();
    w.env.connected = false;
    expect((await eligible(w, 10)).out.reason).toBe('calendar_disconnected');
    expect(w.rig.repos.autoPolicies.live()).toMatchObject({ state: 'paused', pausedReason: 'calendar_disconnected' });
    const id = w.rig.repos.autoPolicies.live()!.id;
    expect(() => w.rig.repos.autoPolicies.setState(id, { state: 'on' })).toThrow(/paused trial resumes as shadow/);
    w.env.connected = true;
    expect(await w.handlers['auto:resume']({ confirm: true }, CTX)).toMatchObject({
      ok: true,
      value: { policy: { state: 'shadow' } },
    });
  });
});
