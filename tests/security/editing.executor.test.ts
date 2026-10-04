// tests/security/editing.executor.test.ts - T2 8.2 group 22 (I3', I7'): the update executor against the fake calendar v2 with the
// ledger on: drift, gone, stale baseRevision, readback_mismatch => unknown_outcome; reconcile by get-event only (never list-events,
// never a re-patch); forged targetEventId / targetItemId / baseRevision in an `edit` never parse (BAD_REQUEST at the IPC schema);
// the F27 chains (click and automatic) each produce exactly one PATCH per step and no CAL_EVENT_FOREIGN / wrong_item; and
// status_field_absent => CAL_UPDATE_UNAVAILABLE for updates while a create-event in the same test still succeeds.
import { afterEach, describe, expect, it } from 'vitest';
import { IPC_REQUEST_SCHEMAS } from '../../src/shared/ipc.ts';
import { CTX, makeExecRig, stopRigsChecked } from '../helpers/ledger.execRig.ts';
import type { Rig } from '../helpers/ledger.execRig.ts';
import type { McpWriteClient } from '../../src/main/mcp/writeClient.ts';

const rigs: Rig[] = [];
afterEach(() => stopRigsChecked(rigs));
const MIN = 60_000;
const WED = { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' };
const THU = { startLocal: '2026-10-08T17:00:00', endLocal: '2026-10-08T18:00:00' };
const FRI = { startLocal: '2026-10-09T10:00:00', endLocal: '2026-10-09T11:00:00' };
async function rig(opts: Parameters<typeof makeExecRig>[0] = {}): Promise<Rig> {
  const r = await makeExecRig(opts);
  rigs.push(r);
  r.attachLedger();
  return r;
}
const updates = (r: Rig) => r.cal.calls.filter((c) => c.tool === 'update-event');

describe('the gate order refusals', () => {
  it('drift => needs_confirm_drift (pending); gone => CAL_EVENT_GONE; stale baseRevision => ACTION_STALE; zero PATCHes', async () => {
    const r = await rig();
    const a = await r.createByClick({ slot: WED });
    const da = r.seedDelta({ source: a, change: 'reschedule', to: THU });
    r.cal.userEditsInGoogle(a.calendarEventId!, { summary: 'Dentist (Google)' });
    expect(await r.click(da.action.id)).toMatchObject({ ok: true, value: { outcome: 'needs_confirm_drift' } });
    expect(r.repos.actions.byId(da.action.id)!.state).toBe('pending');
    const b = await r.createByClick({ chatN: 2, slot: FRI });
    const db = r.seedDelta({
      source: b,
      change: 'reschedule',
      to: { startLocal: '2026-10-10T10:00:00', endLocal: '2026-10-10T11:00:00' },
    });
    r.repos.items.update(b.id, { eventRevision: 3 }, r.clock.now() as never);
    expect(await r.click(db.action.id)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    r.repos.items.update(b.id, { eventRevision: 1 }, r.clock.now() as never);
    r.cal.scenario('gone_410');
    expect(await r.click(db.action.id)).toMatchObject({ ok: true, value: { outcome: 'failed' } });
    expect(r.repos.actions.byId(db.action.id)!.errorCode).toBe('CAL_EVENT_GONE');
    expect(updates(r)).toHaveLength(0);
  });
  it('readback_mismatch => unknown_outcome; startup reconcile reads get-event only (never list-events) and never re-patches', async () => {
    const r = await rig();
    const a = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source: a, change: 'reschedule', to: THU });
    r.cal.scenario('readback_mismatch');
    await r.click(d.action.id);
    expect(r.repos.actions.byId(d.action.id)!.state).toBe('unknown_outcome');
    const lists = r.cal.calls.filter((c) => c.tool === 'list-events').length;
    const gets = r.cal.calls.filter((c) => c.tool === 'get-event').length;
    await r.exec.recoverOnStartup();
    expect(r.cal.calls.filter((c) => c.tool === 'list-events').length).toBe(lists);
    expect(r.cal.calls.filter((c) => c.tool === 'get-event').length).toBeGreaterThan(gets);
    expect(updates(r)).toHaveLength(1);
    expect(r.repos.actions.byId(d.action.id)!.state).toBe('unknown_outcome');
  });
  it('crash after the patch => reconcile done, exactly one applied version', async () => {
    const r = await rig({
      wrapWrite: (real): McpWriteClient => ({
        ...real,
        updateEvent: async (args) => {
          await real.updateEvent(args);
          return { ok: false, error: 'timeout' };
        },
      }),
    });
    const a = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source: a, change: 'reschedule', to: THU });
    await r.click(d.action.id);
    await r.exec.recoverOnStartup();
    expect(r.repos.actions.byId(d.action.id)!.state).toBe('done');
    expect(updates(r)).toHaveLength(1);
    expect(r.stored(a.calendarEventId!)).toMatchObject({ start: THU.startLocal });
  });
  it('forged targetEventId / targetItemId / baseRevision / from inside `edit` never parse (strict to-only edit => BAD_REQUEST)', () => {
    const base = { actionId: '11111111-2222-4333-8444-555555555555', kind: 'update_event', shownHash: 'a'.repeat(64) };
    const edit = { title: 'x', startLocal: THU.startLocal, endLocal: THU.endLocal, location: '' };
    for (const forged of [
      { targetEventId: 'b'.repeat(32) },
      { targetItemId: 9 },
      { baseRevision: 7 },
      { from: WED },
      { status: 'cancelled' },
    ]) {
      expect(IPC_REQUEST_SCHEMAS['action:approve'].safeParse({ ...base, edit: { ...edit, ...forged } }).success).toBe(
        false,
      );
    }
    expect(IPC_REQUEST_SCHEMAS['action:approve'].safeParse({ ...base, edit }).success).toBe(true);
  });
});

describe('F27 chains: one PATCH per step, never CAL_EVENT_FOREIGN / wrong_item', () => {
  it('create -> reschedule -> reschedule (click)', async () => {
    const r = await rig();
    const a = await r.createByClick({ slot: WED });
    const d1 = r.seedDelta({ source: a, change: 'reschedule', to: THU });
    expect(await r.click(d1.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const d2 = r.seedDelta({ source: r.repos.items.byId(d1.item.id)!, change: 'reschedule', to: FRI });
    expect(await r.click(d2.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(updates(r)).toHaveLength(2);
  });
  it('create -> reschedule -> reschedule (automatic)', async () => {
    const r = await rig();
    await r.trackRecord();
    r.policy('on');
    const a = await r.createByClick({ slot: WED });
    const d1 = r.seedDelta({ source: a, change: 'reschedule', to: THU });
    expect(await r.exec.tryAuto(d1.action.id)).toMatchObject({ verdict: 'auto', result: 'done' });
    await r.clock.advance(31 * MIN);
    const d2 = r.seedDelta({ source: r.repos.items.byId(d1.item.id)!, change: 'reschedule', to: FRI });
    expect(await r.exec.tryAuto(d2.action.id)).toMatchObject({ verdict: 'auto', result: 'done' });
    expect(updates(r)).toHaveLength(2);
  });
  it('create -> reschedule -> undo, and create -> reschedule -> cancel -> undo', async () => {
    const r = await rig();
    const a = await r.createByClick({ slot: WED });
    const d1 = r.seedDelta({ source: a, change: 'reschedule', to: THU });
    await r.click(d1.action.id);
    const cand = r.repos.eventRevisions.undoCandidate(a.calendarEventId!)!;
    expect(await r.exec.undoChange(d1.item.id, cand.id, 'user', CTX)).toMatchObject({
      ok: true,
      value: { outcome: 'done' },
    });
    expect(updates(r)).toHaveLength(2);
    const b = await r.createByClick({ chatN: 2, slot: FRI });
    const e1 = r.seedDelta({
      source: b,
      change: 'reschedule',
      to: { startLocal: '2026-10-10T10:00:00', endLocal: '2026-10-10T11:00:00' },
    });
    await r.click(e1.action.id);
    const e2 = r.seedDelta({ source: r.repos.items.byId(e1.item.id)!, change: 'cancel' });
    expect(await r.click(e2.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const c2 = r.repos.eventRevisions.undoCandidate(b.calendarEventId!)!;
    expect(await r.exec.undoChange(e2.item.id, c2.id, 'user', CTX)).toMatchObject({
      ok: true,
      value: { outcome: 'done' },
    });
    expect(updates(r)).toHaveLength(5);
    expect(r.stored(b.calendarEventId!)).toMatchObject({ status: 'confirmed', start: '2026-10-10T10:00:00' });
    for (const x of r.repos.actions.forItem(e2.item.id)) expect(x.errorCode).not.toBe('CAL_EVENT_FOREIGN');
  });
});

describe('status_field_absent (F12/F21 update surface) - creates keep working', () => {
  it('update => CAL_UPDATE_UNAVAILABLE with zero update-event calls; a create-event in the same test succeeds', async () => {
    const r = await rig({ scenarios: ['status_field_absent'] });
    const a = await r.createByClick({ slot: WED });
    r.flags.updateSurface = false; // what McpHost.updateSurface() reports for this tools/list (W1-02)
    const d = r.seedDelta({ source: a, change: 'reschedule', to: THU });
    expect(await r.click(d.action.id)).toEqual({ ok: false, error: { code: 'CAL_UPDATE_UNAVAILABLE' } });
    expect(updates(r)).toHaveLength(0);
    const b = await r.createByClick({ chatN: 2, slot: FRI });
    expect(b.eventState).toBe('created');
    // and automatic mode cannot write while undo is impossible (concern 7)
    await r.trackRecord();
    r.policy('on');
    const c = r.seedCreate({ chatN: 3, slot: { startLocal: '2026-10-11T10:00:00', endLocal: '2026-10-11T11:00:00' } });
    expect(await r.exec.tryAuto(c.action.id)).toMatchObject({ verdict: 'fallback', reason: 'undo_unavailable' });
  });
});
