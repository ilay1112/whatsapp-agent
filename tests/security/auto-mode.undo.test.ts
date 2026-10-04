// tests/security/auto-mode.undo.test.ts - T2 8.2 group 17, automatic half (I8 "undo restores", B10, F1, F2, F10): the chain of two
// automatic edits undone twice returns to the first write's `from` with exactly 2 undo PATCHes (the second pre-check against the first
// undo's post_*), Restore original, taint, blocked_changed / blocked_started, windows +/- 1 min, double-click / toast + strip races,
// the 2-undos breaker, and the I8 timing proof: the fake calendar's onBeforeCall probe sees auto_writes.pre_json ALREADY COMMITTED and
// the action `executing` at the moment the update-event / create-event call arrives. The T2 8.1 ledger runs after every test.
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../../src/shared/types.ts';
import { CTX, RIG_NOW, at, makeExecRig, stopRigsChecked } from '../helpers/ledger.execRig.ts';
import type { Rig } from '../helpers/ledger.execRig.ts';
import type { EpochMs, Item } from '../../src/shared/types.ts';

const rigs: Rig[] = [];
afterEach(() => stopRigsChecked(rigs));
const MIN = 60_000;
const WED = { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' };
const THU = { startLocal: '2026-10-08T17:00:00', endLocal: '2026-10-08T18:00:00' };
const FRI = { startLocal: '2026-10-09T10:00:00', endLocal: '2026-10-09T11:00:00' };

async function onRig(): Promise<Rig> {
  const r = await makeExecRig();
  rigs.push(r);
  await r.trackRecord();
  r.policy('on');
  r.attachLedger();
  return r;
}
const itemOf = (r: Rig, id: number): Item => r.repos.items.byId(id as never)!;
const updates = (r: Rig) => r.cal.calls.filter((c) => c.tool === 'update-event');

/** An event created by a click, then automatically edited twice (WED -> THU -> FRI). */
async function twoAutoEdits(r: Rig) {
  const source = await r.createByClick({ slot: WED });
  const d1 = r.seedDelta({ source, change: 'reschedule', to: THU });
  const o1 = await r.exec.tryAuto(d1.action.id);
  await r.clock.advance(31 * MIN);
  const d2 = r.seedDelta({ source: itemOf(r, d1.item.id), change: 'reschedule', to: FRI });
  const o2 = await r.exec.tryAuto(d2.action.id);
  if (o1.verdict !== 'auto' || o2.verdict !== 'auto' || o1.result !== 'done' || o2.result !== 'done')
    throw new Error('not auto');
  return { source, eventId: source.calendarEventId!, w1: o1.autoWriteId!, w2: o2.autoWriteId!, holder: d2.item.id };
}

describe('F1: the undo chain', () => {
  it('auto-edit, auto-edit, undo, undo => back at the first write’s from; exactly 2 undo PATCHes; policy paused', async () => {
    const r = await onRig();
    const { eventId, w1, w2 } = await twoAutoEdits(r);
    expect(await r.exec.undoAuto(w2, 'user_toast', null)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const firstUndo = r.repos.eventRevisions.newestFor(eventId)!;
    expect(await r.exec.undoAuto(w1, 'user_toast', null)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(updates(r)).toHaveLength(4);
    expect(updates(r)[3]!.args.ifMatch).toBe(firstUndo.postEtag);
    expect(r.stored(eventId)).toMatchObject({ start: WED.startLocal, end: WED.endLocal, status: 'confirmed' });
    expect(r.repos.autoPolicies.live()).toMatchObject({ state: 'paused', pausedReason: 'circuit_breaker_undo' });
  });
  it('Restore original after two automatic edits => ONE PATCH to the oldest pre_json; both revisions reverted by the new row', async () => {
    const r = await onRig();
    const { eventId, w1, w2, holder } = await twoAutoEdits(r);
    const span = r.repos.eventRevisions.unrevertedAutoSpan(eventId);
    expect(await r.exec.restoreOriginal(holder as never, CTX)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(updates(r)).toHaveLength(3);
    const restore = r.repos.eventRevisions.newestFor(eventId)!;
    expect(span.map((s) => r.repos.eventRevisions.byId(s.id)!.revertedBy)).toEqual([restore.id, restore.id]);
    expect(r.repos.autoWrites.byId(w1)!.undoState).toBe('undone');
    expect(r.repos.autoWrites.byId(w2)!.undoState).toBe('undone');
    expect(r.stored(eventId)).toMatchObject({ start: WED.startLocal });
  });
});

describe('F10 taint, create -> undo, windows (F2)', () => {
  it('create -> undo = exactly one update-event {status:cancelled, sendUpdates:none, ifMatch}; the chat is tainted', async () => {
    const r = await onRig();
    const c = r.seedCreate({ chatN: 1, slot: WED });
    const out = await r.exec.tryAuto(c.action.id);
    if (out.verdict !== 'auto') throw new Error('not auto');
    expect(await r.exec.undoAuto(out.autoWriteId!, 'user_toast', null)).toMatchObject({ ok: true });
    expect(updates(r)).toHaveLength(1);
    expect(updates(r)[0]!.args).toMatchObject({ status: 'cancelled', sendUpdates: 'none' });
    expect(typeof updates(r)[0]!.args.ifMatch).toBe('string');
    await r.clock.advance(31 * MIN);
    const next = r.seedCreate({ chatN: 1, slot: THU });
    expect(await r.exec.tryAuto(next.action.id)).toMatchObject({ verdict: 'fallback', reason: 'chat_tainted' });
  });
  it('windows: automatic min(written_at + 72 h, start) - one minute inside passes, one minute outside => expired', async () => {
    const far = { startLocal: '2026-10-19T10:00:00', endLocal: '2026-10-19T11:00:00' };
    const r = await onRig();
    const c = r.seedCreate({ chatN: 1, slot: far });
    const out = await r.exec.tryAuto(c.action.id);
    if (out.verdict !== 'auto') throw new Error('not auto');
    const until = r.repos.autoWrites.byId(out.autoWriteId!)!.undoUntil;
    expect(until).toBe(RIG_NOW + LIMITS.autoUndoWindowMs);
    await r.clock.advanceTo(until - MIN);
    expect(await r.exec.undoAuto(out.autoWriteId!, 'user', CTX)).toMatchObject({
      ok: true,
      value: { outcome: 'done' },
    });
    const r2 = await onRig();
    const c2 = r2.seedCreate({ chatN: 1, slot: far });
    const o2 = await r2.exec.tryAuto(c2.action.id);
    if (o2.verdict !== 'auto') throw new Error('not auto');
    await r2.clock.advanceTo(r2.repos.autoWrites.byId(o2.autoWriteId!)!.undoUntil + MIN);
    expect(await r2.exec.undoAuto(o2.autoWriteId!, 'user', CTX)).toEqual({
      ok: false,
      error: { code: 'ACTION_EXPIRED' },
    });
  });
  it('the window of an update is measured to the RESTORE TARGET (pre_json start), never the attacker-chosen new start', async () => {
    const r = await onRig();
    const source = await r.createByClick({ slot: FRI });
    const d = r.seedDelta({
      source,
      change: 'reschedule',
      to: { startLocal: '2026-10-12T10:00:00', endLocal: '2026-10-12T11:00:00' },
    });
    const out = await r.exec.tryAuto(d.action.id);
    if (out.verdict !== 'auto') throw new Error('not auto');
    const w = r.repos.autoWrites.byId(out.autoWriteId!)!;
    expect(w.undoUntil).toBe(Math.min(RIG_NOW + LIMITS.autoUndoWindowMs, at(FRI.startLocal)));
    expect(w.pre).toMatchObject({ startLocal: FRI.startLocal });
  });
});

describe('blocked_changed / blocked_started, races, idempotency', () => {
  it('a Google edit after the write => blocked_changed, ZERO calls', async () => {
    const r = await onRig();
    const c = r.seedCreate({ chatN: 1, slot: WED });
    const out = await r.exec.tryAuto(c.action.id);
    if (out.verdict !== 'auto') throw new Error('not auto');
    r.cal.userEditsInGoogle(r.repos.autoWrites.byId(out.autoWriteId!)!.eventId, { location: 'Changed' });
    expect(await r.exec.undoAuto(out.autoWriteId!, 'user', CTX)).toEqual({
      ok: false,
      error: { code: 'ACTION_STALE' },
    });
    expect(updates(r)).toHaveLength(0);
    expect(r.repos.autoWrites.byId(out.autoWriteId!)!.undoState).toBe('blocked_changed');
  });
  it('restore target started => blocked_started; the explicit "Cancel event" click then cancels (one PATCH, approved_by user)', async () => {
    const r = await onRig();
    const soon = { startLocal: '2026-10-05T12:00:00', endLocal: '2026-10-05T13:00:00' };
    const c = r.seedCreate({ chatN: 1, slot: soon });
    const out = await r.exec.tryAuto(c.action.id);
    if (out.verdict !== 'auto') throw new Error('not auto');
    await r.clock.advanceTo(at('2026-10-05T12:05:00'));
    expect(await r.exec.undoAuto(out.autoWriteId!, 'user', CTX)).toEqual({
      ok: false,
      error: { code: 'ACTION_STALE' },
    });
    expect(r.repos.autoWrites.byId(out.autoWriteId!)!.undoState).toBe('blocked_started');
    expect(await r.exec.cancelEvent(c.item.id, CTX)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(updates(r)).toHaveLength(1);
    expect(updates(r)[0]!.args.status).toBe('cancelled');
  });
  it('double click / toast + strip race => exactly one undo call', async () => {
    const r = await onRig();
    const c = r.seedCreate({ chatN: 1, slot: WED });
    const out = await r.exec.tryAuto(c.action.id);
    if (out.verdict !== 'auto') throw new Error('not auto');
    const [a, b] = await Promise.all([
      r.exec.undoAuto(out.autoWriteId!, 'user_toast', null),
      r.exec.undoAuto(out.autoWriteId!, 'user', CTX),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(updates(r)).toHaveLength(1);
    expect(await r.exec.undoAuto(out.autoWriteId!, 'user', CTX)).toMatchObject({ ok: false });
    expect(updates(r)).toHaveLength(1);
  });
});

describe('I8 timing: the pre-write state is committed BEFORE the write arrives', () => {
  it('automatic create: at create-event the action is executing, approved_by = the decision, the auto_writes row exists', async () => {
    const r = await onRig();
    const seen: Array<{ state: string | undefined; writes: number; approvedBy: string | null | undefined }> = [];
    const c = r.seedCreate({ chatN: 1, slot: WED });
    const off = r.cal.onBeforeCall((tool) => {
      if (tool !== 'create-event') return;
      const a = r.repos.actions.byId(c.action.id);
      const n = r.db
        .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM auto_writes WHERE action_id = ?`)
        .get(c.action.id)!.n;
      seen.push({ state: a?.state, writes: n, approvedBy: a?.approvedBy });
    });
    const out = await r.exec.tryAuto(c.action.id);
    off();
    if (out.verdict !== 'auto') throw new Error('not auto');
    expect(seen).toEqual([{ state: 'executing', writes: 1, approvedBy: out.decisionId }]);
  });
  it('automatic update: at update-event the auto_writes.pre_json snapshot is already committed', async () => {
    const r = await onRig();
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    const seen: unknown[] = [];
    const off = r.cal.onBeforeCall((tool) => {
      if (tool !== 'update-event') return;
      const row = r.db
        .prepare<{ pre_json: string | null; state: string }>(
          `SELECT w.pre_json, a.state FROM auto_writes w JOIN actions a ON a.id = w.action_id WHERE w.action_id = ?`,
        )
        .get(d.action.id);
      seen.push(row === undefined ? null : { state: row.state, pre: JSON.parse(row.pre_json ?? 'null') as unknown });
    });
    await r.exec.tryAuto(d.action.id);
    off();
    expect(seen).toEqual([
      { state: 'executing', pre: expect.objectContaining({ startLocal: WED.startLocal, status: 'confirmed' }) },
    ]);
  });
  void (0 as unknown as EpochMs);
});
