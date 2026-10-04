// tests/security/auto-mode.snapshot.test.ts - T2 8.2 group 16 (B7): the policy is bound to the snapshot sha256(canonicalJson({
// targetCalendarId, googleAccountEmailSha8, provider, appMajorMinor})). A change of ANY of the four (calendar id, account, provider, app
// major.minor) makes the next tryAuto fall back `snapshot_changed` and pauses the policy in the same transaction - with zero calendar
// writes; resume cannot undo it (a snapshot change needs a fresh requestEnable with its dialog).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_AUTO_SCOPE } from '../../src/shared/schemas.ts';
import { dialog, resetElectronMock } from '../mocks/electron.ts';
import { CTX, stopRigsChecked } from '../helpers/ledger.execRig.ts';
import { makePolicyWorld, snapshotShaOf, SNAPSHOT_INPUT } from '../helpers/ledger.policyWorld.ts';
import type { Rig } from '../helpers/ledger.execRig.ts';
import type { PolicyWorld } from '../helpers/ledger.policyWorld.ts';
import type { AutoSnapshotInput } from '../../src/shared/schemas.ts';

const rigs: Rig[] = [];
beforeEach(() => resetElectronMock());
afterEach(() => stopRigsChecked(rigs));

async function on(): Promise<PolicyWorld> {
  const w = await makePolicyWorld();
  rigs.push(w.rig);
  dialog.__script([{ response: 1, checkboxChecked: true }]);
  const res = await w.handlers['auto:requestEnable']({ scope: DEFAULT_AUTO_SCOPE, trial: false }, CTX);
  if (!res.ok) throw new Error(JSON.stringify(res));
  w.rig.attachLedger();
  return w;
}

describe('the snapshot sha', () => {
  it('is deterministic, 64 hex, and differs for each of the four fields', () => {
    const base = snapshotShaOf(SNAPSHOT_INPUT);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshotShaOf({ ...SNAPSHOT_INPUT })).toBe(base);
    const variants: AutoSnapshotInput[] = [
      { ...SNAPSHOT_INPUT, targetCalendarId: 'work@group.calendar.google.com' },
      { ...SNAPSHOT_INPUT, googleAccountEmailSha8: 'ffffffff' },
      { ...SNAPSHOT_INPUT, provider: 'claude_cli' },
      { ...SNAPSHOT_INPUT, appMajorMinor: '2.1' },
    ];
    const shas = variants.map(snapshotShaOf);
    expect(new Set([base, ...shas]).size).toBe(5);
  });
});

describe('a snapshot change pauses the policy at the next tryAuto', () => {
  const changes: Array<[string, Partial<AutoSnapshotInput>]> = [
    ['calendar id', { targetCalendarId: 'work@group.calendar.google.com' }],
    ['account', { googleAccountEmailSha8: 'ffffffff' }],
    ['provider', { provider: 'gemini' }],
    ['app major.minor', { appMajorMinor: '2.1' }],
  ];
  for (const [what, change] of changes) {
    it(`${what} => fallback snapshot_changed + paused(snapshot_changed), zero writes`, async () => {
      const w = await on();
      const writes = w.rig.cal.calls.filter((c) => c.tool === 'create-event' || c.tool === 'update-event').length;
      w.snapshot.input = { ...w.snapshot.input, ...change };
      const c = w.rig.seedCreate({
        chatN: 1,
        slot: { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' },
      });
      expect(await w.rig.exec.tryAuto(c.action.id)).toMatchObject({ verdict: 'fallback', reason: 'snapshot_changed' });
      expect(w.rig.repos.autoPolicies.live()).toMatchObject({ state: 'paused', pausedReason: 'snapshot_changed' });
      expect(w.rig.cal.calls.filter((x) => x.tool === 'create-event' || x.tool === 'update-event').length).toBe(writes);
      // resume is refused: the grant was for the OLD snapshot
      expect(await w.handlers['auto:resume']({ confirm: true }, CTX)).toEqual({
        ok: false,
        error: { code: 'BAD_REQUEST' },
      });
    });
  }
  it('restoring the snapshot allows the resume (same grant, same snapshot)', async () => {
    const w = await on();
    const before = w.snapshot.input;
    w.snapshot.input = { ...before, provider: 'claude' };
    const c = w.rig.seedCreate({
      chatN: 1,
      slot: { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' },
    });
    await w.rig.exec.tryAuto(c.action.id);
    w.snapshot.input = before;
    expect(await w.handlers['auto:resume']({ confirm: true }, CTX)).toMatchObject({
      ok: true,
      value: { policy: { state: 'on' } },
    });
  });
});
