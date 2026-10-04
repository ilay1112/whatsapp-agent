// tests/security/auto-mode.toggle.test.ts - T2 8.2 group 16 (I10): automatic mode exists ONLY as a policy row that a user gesture in a
// focused window confirmed in a MAIN-owned native dialog, after a track record of >= 3 user-approved creates; no settings:set path.
// The chain under test is real: auto:* handler -> AutoPolicyService -> app/autoDialog.ts -> the electron mock's showMessageBox.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPC_REQUEST_SCHEMAS } from '../../src/shared/ipc.ts';
import { DEFAULT_AUTO_SCOPE } from '../../src/shared/schemas.ts';
import { SettingsPatchSchema } from '../../src/shared/settings.ts';
import { LIMITS } from '../../src/shared/types.ts';
import { dialog, resetElectronMock } from '../mocks/electron.ts';
import { CTX, RIG_NOW, stopRigsChecked } from '../helpers/ledger.execRig.ts';
import { makePolicyWorld, snapshotShaOf, SNAPSHOT_INPUT } from '../helpers/ledger.policyWorld.ts';
import type { Rig } from '../helpers/ledger.execRig.ts';
import type { PolicyWorld } from '../helpers/ledger.policyWorld.ts';
import type { EpochMs } from '../../src/shared/types.ts';

const rigs: Rig[] = [];
beforeEach(() => resetElectronMock());
afterEach(() => stopRigsChecked(rigs));
async function world(trackRecord = 3): Promise<PolicyWorld> {
  const w = await makePolicyWorld({ trackRecord });
  rigs.push(w.rig);
  return w;
}
const REQ = (trial = true) => ({ scope: { ...DEFAULT_AUTO_SCOPE }, trial });
const DAY = 24 * 3_600_000;

describe('no settings:set path (B7)', () => {
  it('settings:set with an `auto` key or llm.provider does not even parse (strict schema => BAD_REQUEST at register.ts)', () => {
    expect(IPC_REQUEST_SCHEMAS['settings:set'].safeParse({ auto: { enabled: true } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ auto: { state: 'on' } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ llm: { provider: 'claude' } }).success).toBe(false);
  });
});

describe('auto:requestEnable - the gesture, the dialog, the preconditions', () => {
  it('happy path (trial): exactly one row, confirmed_by native_dialog, strict scope, snapshot sha of length 64, 30-day expiry', async () => {
    const w = await world();
    dialog.__script([{ response: 1, checkboxChecked: true }]);
    const res = await w.handlers['auto:requestEnable'](REQ(true), CTX);
    expect(res).toMatchObject({ ok: true, value: { policy: { state: 'shadow' } } });
    const rows = w.rig.db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM auto_policies`).get()!.n;
    expect(rows).toBe(1);
    const live = w.rig.repos.autoPolicies.live()!;
    expect(live).toMatchObject({
      confirmedBy: 'native_dialog',
      scope: DEFAULT_AUTO_SCOPE,
      expiresAt: RIG_NOW + 30 * DAY,
    });
    expect(live.snapshotSha).toBe(snapshotShaOf(SNAPSHOT_INPUT));
    expect(live.snapshotSha).toHaveLength(64);
    expect(live.confirm).toMatchObject({ dialogResponse: 1, checkboxChecked: true, windowFocused: true, trial: true });
    expect(dialog.messageBoxes).toHaveLength(1);
    expect(dialog.messageBoxes[0]!.parentWindowId).toBe(w.win.id);
    expect(dialog.messageBoxes[0]!.opts).toMatchObject({ type: 'warning', noLink: true, defaultId: 0, cancelId: 0 });
    expect(
      w.rig.db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE kind = 'auto_policy_enabled'`).get()!
        .n,
    ).toBe(1);
  });
  it('"Turn on now" (F34) => on with shadow_until = enabled_at; 90 days is the maximum validity', async () => {
    const w = await world();
    dialog.__script([{ response: 1, checkboxChecked: true }]);
    await w.handlers['auto:requestEnable']({ scope: { ...DEFAULT_AUTO_SCOPE, validityDays: 90 }, trial: false }, CTX);
    const live = w.rig.repos.autoPolicies.live()!;
    expect(live).toMatchObject({ state: 'on', shadowUntil: live.enabledAt, expiresAt: RIG_NOW + 90 * DAY });
    expect(
      IPC_REQUEST_SCHEMAS['auto:requestEnable'].safeParse({
        scope: { ...DEFAULT_AUTO_SCOPE, validityDays: 120 },
        trial: true,
      }).success,
    ).toBe(false);
  });
  it('unfocused / hidden / inside the focus-steal guard => no dialog, no row', async () => {
    const w = await world();
    for (const ctx of [
      { ...CTX, windowFocused: false },
      { ...CTX, windowVisible: false },
      { ...CTX, shownByNotificationAt: w.rig.clock.now() },
    ]) {
      expect(await w.handlers['auto:requestEnable'](REQ(), ctx)).toEqual({
        ok: false,
        error: { code: 'WINDOW_NOT_FOCUSED' },
      });
    }
    expect(dialog.messageBoxes).toEqual([]);
    expect(w.rig.repos.autoPolicies.newest()).toBeNull();
  });
  it('dialog Cancel, and response 1 WITHOUT the checkbox => AUTO_NOT_CONFIRMED, no row', async () => {
    const w = await world();
    dialog.__script([
      { response: 0, checkboxChecked: true },
      { response: 1, checkboxChecked: false },
    ]);
    expect(await w.handlers['auto:requestEnable'](REQ(), CTX)).toEqual({
      ok: false,
      error: { code: 'AUTO_NOT_CONFIRMED' },
    });
    expect(await w.handlers['auto:requestEnable'](REQ(), CTX)).toEqual({
      ok: false,
      error: { code: 'AUTO_NOT_CONFIRMED' },
    });
    expect(w.rig.repos.autoPolicies.newest()).toBeNull();
  });
  it('accessRole writer / reader / absent => AUTO_CALENDAR_NOT_OWNED, no dialog', async () => {
    for (const roles of [{ primary: 'writer' as const }, { primary: 'reader' as const }, null]) {
      const w = await world();
      w.env.roles = roles;
      expect(await w.handlers['auto:requestEnable'](REQ(), CTX)).toEqual({
        ok: false,
        error: { code: 'AUTO_CALENDAR_NOT_OWNED' },
      });
      expect(dialog.messageBoxes).toEqual([]);
    }
  });
  it('0 / 1 / 2 user-approved creates => AUTO_NO_TRACK_RECORD; 3 where one was a FAILED create still is', async () => {
    for (const n of [0, 1, 2]) {
      const w = await world(n);
      expect(await w.handlers['auto:requestEnable'](REQ(), CTX)).toEqual({
        ok: false,
        error: { code: 'AUTO_NO_TRACK_RECORD' },
      });
    }
    const w = await world(2);
    // a third create that ended FAILED does not count
    const c = w.rig.seedCreate({
      chatN: 70,
      slot: { startLocal: '2026-10-12T10:00:00', endLocal: '2026-10-12T11:00:00' },
    });
    w.rig.cal.failNext('create-event', 'auth');
    await w.rig.click(c.action.id);
    expect(w.rig.repos.actions.byId(c.action.id)!.state).toBe('failed');
    expect(await w.handlers['auto:requestEnable'](REQ(), CTX)).toEqual({
      ok: false,
      error: { code: 'AUTO_NO_TRACK_RECORD' },
    });
    expect(dialog.messageBoxes).toEqual([]);
  });
  it('3 done creates where one was approved by an AUTOMATIC decision => AUTO_NO_TRACK_RECORD', async () => {
    const w = await world(3);
    dialog.__script([{ response: 1, checkboxChecked: true }]);
    await w.handlers['auto:requestEnable'](REQ(false), CTX);
    const c = w.rig.seedCreate({
      chatN: 1,
      slot: { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' },
    });
    expect(await w.rig.exec.tryAuto(c.action.id)).toMatchObject({ verdict: 'auto', result: 'done' });
    await w.handlers['auto:disable']({ reason: 'user' }, CTX);
    // one user-approved create disappears (retention of a closed item): 2 by a click + 1 by a decision remain
    const oneUser = w.rig.db
      .prepare<{ item_id: number }>(
        `SELECT item_id FROM actions WHERE kind='create_event' AND state='done' AND approved_by='user' LIMIT 1`,
      )
      .get()!.item_id;
    w.rig.db.prepare(`DELETE FROM event_revisions WHERE item_id = ?`).run(oneUser);
    w.rig.db.prepare(`DELETE FROM items WHERE id = ?`).run(oneUser);
    const doneCreates = w.rig.db
      .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM actions WHERE kind='create_event' AND state='done'`)
      .get()!.n;
    expect(doneCreates).toBe(3);
    expect(await w.handlers['auto:requestEnable'](REQ(), CTX)).toEqual({
      ok: false,
      error: { code: 'AUTO_NO_TRACK_RECORD' },
    });
    expect(dialog.messageBoxes).toHaveLength(1);
  });
  it('the 4th request in an hour => rate-limited (BAD_REQUEST), no dialog', async () => {
    const w = await world();
    dialog.__script([
      { response: 0, checkboxChecked: false },
      { response: 0, checkboxChecked: false },
      { response: 0, checkboxChecked: false },
    ]);
    for (let i = 0; i < LIMITS.autoDialogPerHour; i++) await w.handlers['auto:requestEnable'](REQ(), CTX);
    expect(dialog.messageBoxes).toHaveLength(3);
    expect(await w.handlers['auto:requestEnable'](REQ(), CTX)).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(dialog.messageBoxes).toHaveLength(3);
  });
  it('a live policy exists => refused (single live row), no second dialog', async () => {
    const w = await world();
    dialog.__script([{ response: 1, checkboxChecked: true }]);
    await w.handlers['auto:requestEnable'](REQ(), CTX);
    expect(await w.handlers['auto:requestEnable'](REQ(), CTX)).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(dialog.messageBoxes).toHaveLength(1);
  });
  it('the Antigravity provider (B14) and a disabled update surface (concern 7) refuse the dialog', async () => {
    const w = await world();
    w.env.surface = false;
    expect(await w.handlers['auto:requestEnable'](REQ(), CTX)).toEqual({
      ok: false,
      error: { code: 'CAL_UPDATE_UNAVAILABLE' },
    });
    w.env.surface = true;
    w.rig.repos.settings.setInternal((s) => void (s.llm.provider = 'antigravity_cli'));
    expect(await w.handlers['auto:requestEnable'](REQ(), CTX)).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(dialog.messageBoxes).toEqual([]);
  });
});

describe('disable / pause from anywhere, in one call', () => {
  it('an unfocused window disables and pauses; the tray action does the same without a window', async () => {
    const w = await world();
    dialog.__script([{ response: 1, checkboxChecked: true }]);
    await w.handlers['auto:requestEnable'](REQ(false), CTX);
    const unfocused = { ...CTX, windowFocused: false, windowVisible: false };
    expect(await w.handlers['auto:pause']({ reason: 'user' }, unfocused)).toMatchObject({
      ok: true,
      value: { policy: { state: 'paused' } },
    });
    expect(await w.handlers['auto:disable']({ reason: 'user' }, unfocused)).toMatchObject({
      ok: true,
      value: { policy: { state: 'disabled' } },
    });
    expect(w.rig.repos.autoPolicies.live()).toBeNull();
    void (w.rig.clock.now() as EpochMs);
  });
});
