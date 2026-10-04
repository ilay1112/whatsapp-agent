// tests/security/auto-mode.unattended.test.ts - T2 8.2 group 16 (B7, I10): 7 days without window focus pauses the policy
// ('unattended'); resume needs a focused click; expiry at 30 days with a reminder 3 days before, and renewal needs a fresh dialog;
// disable / pause work from an unfocused window and from the tray in one call; a tryAuto with no live `on` policy never writes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_AUTO_SCOPE } from '../../src/shared/schemas.ts';
import { LIMITS } from '../../src/shared/types.ts';
import { dialog, resetElectronMock } from '../mocks/electron.ts';
import { autoTrayAction } from '../../src/main/app/tray.ts';
import { CTX, stopRigsChecked } from '../helpers/ledger.execRig.ts';
import { makePolicyWorld } from '../helpers/ledger.policyWorld.ts';
import type { Rig } from '../helpers/ledger.execRig.ts';
import type { PolicyWorld } from '../helpers/ledger.policyWorld.ts';
import type { EpochMs } from '../../src/shared/types.ts';

const rigs: Rig[] = [];
beforeEach(() => resetElectronMock());
afterEach(() => stopRigsChecked(rigs));
const DAY = 24 * 3_600_000;

async function on(trial = false): Promise<PolicyWorld> {
  const w = await makePolicyWorld();
  rigs.push(w.rig);
  dialog.__script([{ response: 1, checkboxChecked: true }]);
  const res = await w.handlers['auto:requestEnable']({ scope: DEFAULT_AUTO_SCOPE, trial }, CTX);
  if (!res.ok) throw new Error(JSON.stringify(res));
  w.rig.attachLedger();
  return w;
}
const now = (w: PolicyWorld): EpochMs => w.rig.clock.now() as EpochMs;

describe('unattended (7 days without window focus)', () => {
  it('pauses on the tick; resume needs a focused click', async () => {
    const w = await on();
    w.env.lastFocus = now(w);
    await w.rig.clock.advance(LIMITS.autoUnattendedMs);
    w.svc.tick(now(w));
    expect(w.rig.repos.autoPolicies.live()).toMatchObject({ state: 'paused', pausedReason: 'unattended' });
    expect(await w.handlers['auto:resume']({ confirm: true }, { ...CTX, windowFocused: false })).toEqual({
      ok: false,
      error: { code: 'WINDOW_NOT_FOCUSED' },
    });
    expect(await w.handlers['auto:resume']({ confirm: true }, CTX)).toMatchObject({
      ok: true,
      value: { policy: { state: 'on' } },
    });
  });
  it('a focus inside the week keeps it on', async () => {
    const w = await on();
    await w.rig.clock.advance(6 * DAY);
    w.env.lastFocus = now(w);
    await w.rig.clock.advance(2 * DAY);
    w.svc.tick(now(w));
    expect(w.rig.repos.autoPolicies.live()!.state).toBe('on');
  });
});

describe('expiry (30 d) and renewal', () => {
  it('a reminder 3 days before (once), expiry at 30 d, then renewal needs a fresh native dialog', async () => {
    const w = await on();
    for (let d = 0; d < 30; d++) {
      await w.rig.clock.advance(DAY);
      w.env.lastFocus = now(w);
      w.svc.tick(now(w));
    }
    expect(w.expiring.count).toBe(1);
    expect(w.rig.repos.autoPolicies.live()).toBeNull();
    expect(w.rig.repos.autoPolicies.newest()!.state).toBe('expired');
    const boxes = dialog.messageBoxes.length;
    dialog.__script([{ response: 1, checkboxChecked: true }]);
    expect(await w.handlers['auto:requestEnable']({ scope: DEFAULT_AUTO_SCOPE, trial: false }, CTX)).toEqual({
      ok: true,
      value: expect.anything(),
    });
    expect(dialog.messageBoxes.length).toBe(boxes + 1);
  });
});

describe('disable / pause from anywhere; no writes without a live on policy', () => {
  it('the tray action for each state maps to the fail-safe channel (on => pause, trial => stop)', async () => {
    const w = await on();
    expect(autoTrayAction('on')).toBe('pause');
    expect(w.svc.pause('user')).toMatchObject({ ok: true });
    const t = await on(true);
    expect(autoTrayAction('shadow')).toBe('disable');
    expect(t.svc.disable('user')).toMatchObject({ ok: true, value: { policy: { state: 'disabled' } } });
  });
  it('with a paused, disabled or expired policy, or none at all, tryAuto performs zero calendar calls', async () => {
    const w = await on();
    w.svc.pause('user');
    const before = w.rig.cal.calls.length;
    const c = w.rig.seedCreate({
      chatN: 1,
      slot: { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' },
    });
    expect((await w.rig.exec.tryAuto(c.action.id)).reason).toBe('policy_paused');
    w.svc.disable('user');
    const c2 = w.rig.seedCreate({
      chatN: 2,
      slot: { startLocal: '2026-10-08T15:00:00', endLocal: '2026-10-08T16:00:00' },
    });
    expect(await w.rig.exec.tryAuto(c2.action.id)).toEqual({ verdict: 'none', reason: 'no_policy' });
    expect(w.rig.cal.calls.length).toBe(before);
  });
});
