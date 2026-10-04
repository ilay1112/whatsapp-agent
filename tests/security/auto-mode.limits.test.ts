// tests/security/auto-mode.limits.test.ts - T2 8.2 group 14 (limits half): the cage of B9 through the REAL executor (tryAuto) with a
// live `on` policy, the real repos + triggers and the fake calendar v2, virtual clock, zone Asia/Jerusalem. Boundary pairs on both
// sides of every bound (incl. the 2026-10-25 DST night), the content screen (F9), multiple_events (F31), the missing baseline of a
// v1-created event (F5), the edit / cancel rules, and the budgets: each budget hit falls back AND pauses (circuit_breaker_rate), and a
// click approval still works right after.
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../../src/shared/types.ts';
import { epochMsToLocal } from '../../src/shared/when.ts';
import { RIG_NOW, RIG_TZ, at, makeExecRig, stopRigsChecked } from '../helpers/ledger.execRig.ts';
import type { Rig, Slot } from '../helpers/ledger.execRig.ts';
import type { AutoScope } from '../../src/shared/schemas.ts';
import type { AutoReason, EpochMs } from '../../src/shared/types.ts';

const rigs: Rig[] = [];
afterEach(() => stopRigsChecked(rigs));
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const local = (ms: number): string => epochMsToLocal(ms as EpochMs, RIG_TZ);
const slotAt = (startMs: number, minutes = 60): Slot => ({
  startLocal: local(startMs),
  endLocal: local(startMs + minutes * MIN),
});

/** A rig with the track record, a live `on` policy and the ledger attached. */
async function onRig(scope: Partial<AutoScope> = {}, advanceTo?: number): Promise<Rig> {
  const r = await makeExecRig();
  rigs.push(r);
  await r.trackRecord();
  if (advanceTo !== undefined) await r.clock.advanceTo(advanceTo);
  r.policy('on', scope);
  r.attachLedger();
  return r;
}
let chatN = 1;
async function autoCreate(
  r: Rig,
  slot: Slot,
  extra: { title?: string; location?: string } = {},
): Promise<AutoReason | 'none'> {
  const { action } = r.seedCreate({ chatN: chatN++, slot, ...extra });
  const out = await r.exec.tryAuto(action.id);
  return out.reason;
}

describe('creates: horizon, duration, lead, quiet hours (both sides of every bound)', () => {
  it('horizon: now + 30 d passes, + 30 d 1 min falls back', async () => {
    const r = await onRig();
    expect(await autoCreate(r, slotAt(RIG_NOW + 30 * DAY))).toBe('ok');
    await r.clock.advance(31 * MIN);
    expect(await autoCreate(r, slotAt(RIG_NOW + 30 * DAY + 32 * MIN))).toBe('beyond_horizon');
  });
  it('duration: 240 min passes, 241 falls back; 5 passes, 4 falls back', async () => {
    const r = await onRig();
    const start = at('2026-10-07T09:00:00');
    expect(await autoCreate(r, slotAt(start, 241))).toBe('too_long');
    expect(await autoCreate(r, slotAt(start, 4))).toBe('too_long');
    expect(await autoCreate(r, slotAt(start, 240))).toBe('ok');
    await r.clock.advance(31 * MIN);
    expect(await autoCreate(r, slotAt(at('2026-10-08T09:00:00'), 5))).toBe('ok');
  });
  it('lead: a start in 14 min falls back (too_soon), in 15 min passes', async () => {
    const r = await onRig();
    expect(await autoCreate(r, slotAt(RIG_NOW + 14 * MIN))).toBe('too_soon');
    expect(await autoCreate(r, slotAt(RIG_NOW + 15 * MIN, 30))).toBe('ok');
  });
  it('quiet hours: 21:59 passes, 22:00 falls back; 06:59 falls back, 07:00 passes', async () => {
    const r = await onRig();
    expect(await autoCreate(r, slotAt(at('2026-10-07T22:00:00'), 30))).toBe('quiet_hours');
    expect(await autoCreate(r, slotAt(at('2026-10-08T06:59:00'), 30))).toBe('quiet_hours');
    expect(await autoCreate(r, slotAt(at('2026-10-07T21:59:00'), 30))).toBe('ok');
    await r.clock.advance(31 * MIN);
    expect(await autoCreate(r, slotAt(at('2026-10-08T07:00:00'), 30))).toBe('ok');
  });
  it('quiet hours on the 2026-10-25 DST night (Israel falls back 02:00 -> 01:00)', async () => {
    const r = await onRig({}, at('2026-10-22T10:00:00'));
    expect(await autoCreate(r, slotAt(at('2026-10-25T06:59:00'), 30))).toBe('quiet_hours');
    expect(await autoCreate(r, slotAt(at('2026-10-24T22:00:00'), 30))).toBe('quiet_hours');
    expect(await autoCreate(r, slotAt(at('2026-10-25T07:00:00'), 30))).toBe('ok');
    await r.clock.advance(31 * MIN);
    expect(await autoCreate(r, slotAt(at('2026-10-24T21:59:00'), 30))).toBe('ok');
  });
});

describe('the content screen (F9) - automatic path only', () => {
  it('a URL, an e-mail, a phone number, an RLO character in the title, an 81-character location => content_rejected', async () => {
    const r = await onRig();
    const s = slotAt(at('2026-10-07T12:00:00'));
    expect(await autoCreate(r, s, { title: 'Dentist https://x.example' })).toBe('content_rejected');
    expect(await autoCreate(r, s, { title: 'Dentist mail a@b.co' })).toBe('content_rejected');
    expect(await autoCreate(r, s, { title: 'Call 050-000-0000' })).toBe('content_rejected');
    expect(await autoCreate(r, s, { title: 'Dentist \u202Eevil' })).toBe('content_rejected');
    expect(await autoCreate(r, s, { location: 'L'.repeat(81) })).toBe('content_rejected');
    expect(await autoCreate(r, s, { location: 'L'.repeat(80) })).toBe('ok');
    expect(r.cal.calls.filter((c) => c.tool === 'create-event')).toHaveLength(4); // 3 track record + the one ok
  });
});

describe('edits: F2 earlier move, move distance, F31, F5, edit budget, cancels', () => {
  async function eventAt(r: Rig, slot: Slot, n = 1) {
    return r.createByClick({ chatN: n, slot });
  }
  it('an automatic move EARLIER to now + 23 h 59 falls back, to now + 26 h passes', async () => {
    const r = await onRig();
    const src = await eventAt(r, slotAt(at('2026-10-09T10:00:00')));
    const d1 = r.seedDelta({ source: src, change: 'reschedule', to: slotAt(RIG_NOW + 24 * HOUR - MIN) });
    expect((await r.exec.tryAuto(d1.action.id)).reason).toBe('too_soon');
    const src2 = await eventAt(r, slotAt(at('2026-10-09T13:00:00')), 2);
    const d2 = r.seedDelta({ source: src2, change: 'reschedule', to: slotAt(RIG_NOW + 24 * HOUR + MIN) });
    expect((await r.exec.tryAuto(d2.action.id)).reason).toBe('ok');
  });
  it('move distance: 15 days falls back, 14 days passes', async () => {
    const r = await onRig();
    const src = await eventAt(r, slotAt(at('2026-10-07T15:00:00')));
    const far = r.seedDelta({ source: src, change: 'reschedule', to: slotAt(at('2026-10-22T15:00:00')) });
    expect((await r.exec.tryAuto(far.action.id)).reason).toBe('move_too_far');
    const src2 = await eventAt(r, slotAt(at('2026-10-07T12:00:00')), 2);
    const near = r.seedDelta({ source: src2, change: 'reschedule', to: slotAt(at('2026-10-21T12:00:00')) });
    expect((await r.exec.tryAuto(near.action.id)).reason).toBe('ok');
  });
  it('F31: a delta in a chat with two editable events => multiple_events', async () => {
    const r = await onRig();
    const a = await eventAt(r, slotAt(at('2026-10-07T15:00:00')));
    await eventAt(r, slotAt(at('2026-10-08T15:00:00')));
    const d = r.seedDelta({ source: a, change: 'reschedule', to: slotAt(at('2026-10-09T15:00:00')) });
    expect((await r.exec.tryAuto(d.action.id)).reason).toBe('multiple_events');
  });
  it('F5: an event without a recorded baseline (created in v1) => modified_in_google, zero update calls', async () => {
    const r = await onRig();
    const src = await eventAt(r, slotAt(at('2026-10-07T15:00:00')));
    r.db.prepare(`UPDATE event_revisions SET post_etag = NULL, post_updated = NULL`).run();
    r.db.prepare(`UPDATE items SET calendar_updated = NULL WHERE id = ?`).run(src.id);
    const d = r.seedDelta({ source: src, change: 'reschedule', to: slotAt(at('2026-10-08T15:00:00')) });
    expect((await r.exec.tryAuto(d.action.id)).reason).toBe('modified_in_google');
    expect(r.updateCalls()).toHaveLength(0);
  });
  it('the third automatic edit of one event => edit_budget', async () => {
    const r = await onRig();
    let src = await eventAt(r, slotAt(at('2026-10-07T15:00:00')));
    for (const [i, day] of ['08', '09'].entries()) {
      const d = r.seedDelta({ source: src, change: 'reschedule', to: slotAt(at(`2026-10-${day}T15:00:00`)) });
      expect((await r.exec.tryAuto(d.action.id)).reason, `edit ${String(i + 1)}`).toBe('ok');
      src = r.repos.items.byId(d.item.id)!;
      await r.clock.advance(61 * MIN);
    }
    const third = r.seedDelta({ source: src, change: 'reschedule', to: slotAt(at('2026-10-10T15:00:00')) });
    expect((await r.exec.tryAuto(third.action.id)).reason).toBe('edit_budget');
    expect(r.updateCalls()).toHaveLength(LIMITS.autoEditsPerEvent);
  });
  it('cancel with scope.cancels = false => cancel_not_in_scope; 23 h 59 before the start => cancel_too_soon; 24 h 01 passes', async () => {
    const r = await onRig({ cancels: false });
    const src = await eventAt(r, slotAt(at('2026-10-08T15:00:00')));
    const d = r.seedDelta({ source: src, change: 'cancel' });
    expect((await r.exec.tryAuto(d.action.id)).reason).toBe('cancel_not_in_scope');
    const r2 = await onRig({ cancels: true });
    const soon = await eventAt(r2, slotAt(RIG_NOW + 24 * HOUR - MIN));
    const d2 = r2.seedDelta({ source: soon, change: 'cancel' });
    expect((await r2.exec.tryAuto(d2.action.id)).reason).toBe('cancel_too_soon');
    const later = await eventAt(r2, slotAt(RIG_NOW + 26 * HOUR), 2);
    const d3 = r2.seedDelta({ source: later, change: 'cancel' });
    expect((await r2.exec.tryAuto(d3.action.id)).reason).toBe('ok');
    expect(r2.updateCalls()[0]).toMatchObject({ status: 'cancelled', sendUpdates: 'none' });
  });
});

describe('budgets: every hit falls back AND pauses; a click approval still works right after', () => {
  it('per chat: a second write within 30 min => auto_budget + paused(circuit_breaker_rate); the click then approves it', async () => {
    const r = await onRig();
    const first = r.seedCreate({ chatN: 50, slot: slotAt(at('2026-10-07T10:00:00')) });
    expect((await r.exec.tryAuto(first.action.id)).reason).toBe('ok');
    await r.clock.advance(10 * MIN);
    const second = r.seedCreate({ chatN: 50, slot: slotAt(at('2026-10-08T10:00:00')) });
    expect((await r.exec.tryAuto(second.action.id)).reason).toBe('auto_budget');
    expect(r.repos.autoPolicies.live()).toMatchObject({ state: 'paused', pausedReason: 'circuit_breaker_rate' });
    expect(await r.click(second.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(r.repos.actions.byId(second.action.id)!.approvedBy).toBe('user');
  });
  it(`global: the ${String(LIMITS.autoGlobalPerHour + 1)}th automatic write in an hour => auto_budget + paused`, async () => {
    const r = await onRig();
    for (let i = 0; i < LIMITS.autoGlobalPerHour; i++) {
      expect(await autoCreate(r, slotAt(at('2026-10-07T09:00:00') + i * 2 * HOUR, 30))).toBe('ok');
    }
    expect(await autoCreate(r, slotAt(at('2026-10-09T09:00:00'), 30))).toBe('auto_budget');
    expect(r.repos.autoPolicies.live()!.pausedReason).toBe('circuit_breaker_rate');
    const manual = r.seedCreate({ chatN: 99, slot: slotAt(at('2026-10-10T09:00:00'), 30) });
    expect(await r.click(manual.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
  });
  it('per chat per day: the scope ceiling (perChatPerDay) is enforced', async () => {
    const r = await onRig({ perChatPerDay: 1 });
    const a = r.seedCreate({ chatN: 60, slot: slotAt(at('2026-10-07T10:00:00')) });
    expect((await r.exec.tryAuto(a.action.id)).reason).toBe('ok');
    await r.clock.advance(2 * HOUR);
    const b = r.seedCreate({ chatN: 60, slot: slotAt(at('2026-10-08T10:00:00')) });
    expect((await r.exec.tryAuto(b.action.id)).reason).toBe('auto_budget');
  });
});
