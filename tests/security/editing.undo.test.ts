// tests/security/editing.undo.test.ts - T2 8.2 group 17, manual half (I8 "undo restores", B10): reschedule -> undo restores the
// PRE-WRITE state exactly (the fake event deep-equals its snapshot taken just before the original write on summary / start / end /
// location / description / status) with the complete private map; cancel -> undo; "Add it back" after a refused restore is a click
// (approved_by user, no decision row, never AutoGate); manual windows +/- 1 min; after "Apply anyway" the undo restores the pre-flight
// (drifted) state, not the proposal's `from` (T2 concern 7); and the I8 timing probe for a click. The T2 8.1 ledger runs after each test.
import { afterEach, describe, expect, it } from 'vitest';
import { CTX, at, makeExecRig, stopRigsChecked } from '../helpers/ledger.execRig.ts';
import type { Rig } from '../helpers/ledger.execRig.ts';
import type { UpdateEventPayload } from '../../src/shared/schemas.ts';

const rigs: Rig[] = [];
afterEach(() => stopRigsChecked(rigs));
const MIN = 60_000;
const WED = { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' };
const THU = { startLocal: '2026-10-08T17:00:00', endLocal: '2026-10-08T18:00:00' };

async function rig(opts: Parameters<typeof makeExecRig>[0] = {}): Promise<Rig> {
  const r = await makeExecRig(opts);
  rigs.push(r);
  r.attachLedger();
  return r;
}
const updates = (r: Rig) => r.cal.calls.filter((c) => c.tool === 'update-event');
const snapshotOf = (r: Rig, eventId: string) => {
  const e = r.cal.fake.events.find((x) => x.id === eventId)!;
  return {
    summary: e.summary,
    start: e.start,
    end: e.end,
    location: e.location ?? '',
    description: e.description,
    status: e.status,
  };
};

describe('reschedule -> undo', () => {
  it('ONE PATCH whose five content fields equal the pre-write state; the fake event deep-equals its pre-write snapshot', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED, location: 'Clinic 3' });
    const eventId = source.calendarEventId!;
    const before = snapshotOf(r, eventId);
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    expect(await r.click(d.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(snapshotOf(r, eventId)).not.toEqual(before);
    const cand = r.repos.eventRevisions.undoCandidate(eventId)!;
    expect(await r.exec.undoChange(d.item.id, cand.id, 'user', CTX)).toMatchObject({
      ok: true,
      value: { outcome: 'done' },
    });
    expect(updates(r)).toHaveLength(2);
    const undo = updates(r)[1]!.args;
    expect(undo).toMatchObject({
      summary: 'Dentist',
      start: WED.startLocal,
      end: WED.endLocal,
      location: 'Clinic 3',
      status: 'confirmed',
    });
    expect(Object.keys((undo.extendedProperties as { private: object }).private).sort()).toEqual([
      'waAction',
      'waAgent',
      'waItem',
      'waRev',
      'waUpdate',
    ]);
    expect(snapshotOf(r, eventId)).toEqual(before); // incl. the description the user may have written: never touched (F5)
    // the chain is linked
    const newest = r.repos.eventRevisions.newestFor(eventId)!;
    expect(newest.kind).toBe('undo');
    expect(r.repos.eventRevisions.byId(cand.id)!.revertedBy).toBe(newest.id);
  });
  it('cancel -> undo => status confirmed + the previous fields', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'cancel' });
    await r.click(d.action.id);
    const eventId = source.calendarEventId!;
    expect(r.stored(eventId)!.status).toBe('cancelled');
    const res = await r.exec.undoChange(d.item.id, r.repos.eventRevisions.undoCandidate(eventId)!.id, 'user', CTX);
    expect(res).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(r.stored(eventId)).toMatchObject({ status: 'confirmed', start: WED.startLocal, end: WED.endLocal });
  });
  it('restore refused (U-E1) => a pending create_event "Add it back" approved only by a click, approved_by user, no decision row', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'cancel' });
    await r.click(d.action.id);
    r.cal.scenario('restore_refused');
    const eventId = source.calendarEventId!;
    await r.exec.undoChange(d.item.id, r.repos.eventRevisions.undoCandidate(eventId)!.id, 'user', CTX);
    const offer = r.repos.actions.forItem(d.item.id).find((a) => a.kind === 'create_event' && a.state === 'pending')!;
    expect(offer).toBeDefined();
    // a live policy changes nothing: the offer is never evaluated by AutoGate automatically, and tryAuto refuses it as a non-proposal
    expect(r.repos.autoDecisions.forAction(offer.id)).toBeNull();
    expect(await r.click(offer.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(r.repos.actions.byId(offer.id)).toMatchObject({ approvedBy: 'user', state: 'done' });
    expect(r.repos.autoDecisions.forAction(offer.id)).toBeNull();
  });
});

describe('manual windows: min(restore-target start, applied + 7 d)', () => {
  it('one minute inside passes; one minute outside => ACTION_EXPIRED with zero calls', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    await r.click(d.action.id);
    const eventId = source.calendarEventId!;
    const cand = r.repos.eventRevisions.undoCandidate(eventId)!;
    await r.clock.advanceTo(at(WED.startLocal) + MIN);
    expect(await r.exec.undoChange(d.item.id, cand.id, 'user', CTX)).toEqual({
      ok: false,
      error: { code: 'ACTION_EXPIRED' },
    });
    expect(updates(r)).toHaveLength(1);
    const r2 = await rig();
    const s2 = await r2.createByClick({ slot: WED });
    const d2 = r2.seedDelta({ source: s2, change: 'reschedule', to: THU });
    await r2.click(d2.action.id);
    await r2.clock.advanceTo(at(WED.startLocal) - 2 * MIN);
    const c2 = r2.repos.eventRevisions.undoCandidate(s2.calendarEventId!)!;
    expect(await r2.exec.undoChange(d2.item.id, c2.id, 'user', CTX)).toMatchObject({
      ok: true,
      value: { outcome: 'done' },
    });
  });
});

describe('T2 concern 7: after "Apply anyway" the undo restores the PRE-FLIGHT (drifted) state', () => {
  it('prev_json is the pre-flight readback; the undo PATCH puts back what Google had, not the proposal’s from', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const eventId = source.calendarEventId!;
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    r.cal.userEditsInGoogle(eventId, { start: '2026-10-07T16:30:00', end: '2026-10-07T17:30:00' });
    expect(await r.click(d.action.id)).toMatchObject({ ok: true, value: { outcome: 'needs_confirm_drift' } });
    expect(await r.click(d.action.id, { confirmDrift: true })).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const final = JSON.parse(r.repos.actions.byId(d.action.id)!.approvedFinalJson!) as UpdateEventPayload;
    expect(final.from.startLocal).toBe('2026-10-07T16:30:00');
    const cand = r.repos.eventRevisions.undoCandidate(eventId)!;
    await r.exec.undoChange(d.item.id, cand.id, 'user', CTX);
    expect(r.stored(eventId)).toMatchObject({ start: '2026-10-07T16:30:00', end: '2026-10-07T17:30:00' });
  });
});

describe('I8 timing (manual): at update-event the action is executing with approved_final_json.from committed', () => {
  it('the onBeforeCall probe reads the pre-write state from the DB at the moment the call arrives', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    const seen: unknown[] = [];
    const off = r.cal.onBeforeCall((tool) => {
      if (tool !== 'update-event') return;
      const a = r.repos.actions.byId(d.action.id)!;
      seen.push({
        state: a.state,
        approvedBy: a.approvedBy,
        from: (JSON.parse(a.approvedFinalJson!) as UpdateEventPayload).from.startLocal,
      });
    });
    await r.click(d.action.id);
    off();
    expect(seen).toEqual([{ state: 'executing', approvedBy: 'user', from: WED.startLocal }]);
  });
});
