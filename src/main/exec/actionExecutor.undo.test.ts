// src/main/exec/actionExecutor.undo.test.ts - T2 5 row exec/undo + exec/reconcile v2 (unit level of 8.2 group 17 and recovery-v2):
// the ONE undo path of B10 over the revision chain (F1), the restore-target windows (F2), taint (F10), Restore original, Cancel event
// (F32), "Add it back" (U-E1), the draft carry-over (C2 concern 19), the 2-undos breaker, and the read-only reconcile of updates / B24.
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../../shared/types';
import { reconcileUnknown, reconcileUpdate } from './reconcile';
import { CTX, DAYS, HOURS, RIG_NOW, at, makeExecRig } from '../../../tests/helpers/ledger.execRig';
import type { Rig, RigOptions } from '../../../tests/helpers/ledger.execRig';
import type { ApprovalAction, EpochMs, Item } from '../../shared/types';
import type { UpdateEventPayload } from '../../shared/schemas';
import type { McpWriteClient } from '../mcp/writeClient';

const rigs: Rig[] = [];
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.stop();
});
async function rig(opts: RigOptions = {}): Promise<Rig> {
  const r = await makeExecRig(opts);
  rigs.push(r);
  return r;
}
const MIN = 60_000;
const WED = { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' };
const THU = { startLocal: '2026-10-08T17:00:00', endLocal: '2026-10-08T18:00:00' };
const FRI = { startLocal: '2026-10-09T10:00:00', endLocal: '2026-10-09T11:00:00' };
const actionOf = (r: Rig, id: string): ApprovalAction => r.repos.actions.byId(id as never)!;
const itemOf = (r: Rig, id: number): Item => r.repos.items.byId(id as never)!;
const candidateOf = (r: Rig, eventId: string) => r.repos.eventRevisions.undoCandidate(eventId)!;
const undoOf = (r: Rig) => r.cal.calls.filter((c) => c.tool === 'update-event');

async function clickedChange(r: Rig, change: 'reschedule' | 'cancel' = 'reschedule') {
  const source = await r.createByClick({ slot: WED });
  const d = r.seedDelta({ source, change, to: change === 'cancel' ? {} : THU });
  const res = await r.click(d.action.id);
  if (!res.ok || res.value.outcome !== 'done') throw new Error(JSON.stringify(res));
  return { source, acting: itemOf(r, d.item.id), eventId: source.calendarEventId! };
}

/** track record + live `on` policy + an AUTOMATIC create of `slot` in chat 1. */
async function autoCreate(r: Rig, slot = WED) {
  await r.trackRecord();
  r.policy('on');
  const { item, action } = r.seedCreate({ chatN: 1, slot });
  const out = await r.exec.tryAuto(action.id);
  if (out.verdict !== 'auto' || out.result !== 'done') throw new Error(JSON.stringify(out));
  return { item: itemOf(r, item.id), autoWriteId: out.autoWriteId!, eventId: itemOf(r, item.id).calendarEventId! };
}

// ---------------------------------------------------------------------------------------------------------------------
describe('manual undo (item:undoChange with approved_by user)', () => {
  it('reschedule -> undo: one PATCH back to the pre-write content, an undo revision linked by reverted_by', async () => {
    const r = await rig();
    const { acting, eventId } = await clickedChange(r);
    const cand = candidateOf(r, eventId);
    expect(cand.kind).toBe('reschedule');
    const res = await r.exec.undoChange(acting.id, cand.id, 'user', CTX);
    expect(res).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(undoOf(r)).toHaveLength(2);
    expect(undoOf(r)[1]!.args).toMatchObject({ start: WED.startLocal, end: WED.endLocal, status: 'confirmed' });
    const newest = r.repos.eventRevisions.newestFor(eventId)!;
    expect(newest).toMatchObject({ kind: 'undo', revision: 3 });
    expect(r.repos.eventRevisions.byId(cand.id)!.revertedBy).toBe(newest.id);
    const undoAction = actionOf(r, newest.actionId);
    expect(undoAction.approvedBy).toBe('user');
    expect(JSON.parse(undoAction.canonicalJson)).toMatchObject({
      change: 'undo',
      revertOf: cand.id,
      from: THU,
      to: WED,
    });
    expect(r.stored(eventId)).toMatchObject({ start: WED.startLocal, end: WED.endLocal, status: 'confirmed' });
    // the private map stays complete and keeps the chain's identity
    expect((undoOf(r)[1]!.args.extendedProperties as { private: Record<string, string> }).private).toMatchObject({
      waAgent: '1',
    });
  });

  it('idempotent: the same revision again => ACTION_STALE, zero calls', async () => {
    const r = await rig();
    const { acting, eventId } = await clickedChange(r);
    const cand = candidateOf(r, eventId);
    await r.exec.undoChange(acting.id, cand.id, 'user', CTX);
    expect(await r.exec.undoChange(acting.id, cand.id, 'user', CTX)).toEqual({
      ok: false,
      error: { code: 'ACTION_STALE' },
    });
    expect(undoOf(r)).toHaveLength(2);
  });

  it('create -> undo = exactly one update-event {status:cancelled, sendUpdates:none, ifMatch}', async () => {
    const r = await rig();
    const item = await r.createByClick({ slot: WED });
    const cand = candidateOf(r, item.calendarEventId!);
    expect(await r.exec.undoChange(item.id, cand.id, 'user', CTX)).toMatchObject({
      ok: true,
      value: { outcome: 'done' },
    });
    expect(undoOf(r)).toHaveLength(1);
    expect(undoOf(r)[0]!.args).toMatchObject({ status: 'cancelled', sendUpdates: 'none' });
    expect(typeof undoOf(r)[0]!.args.ifMatch).toBe('string');
    expect(itemOf(r, item.id).eventState).toBe('cancelled');
  });

  it('cancel -> undo = status confirmed + the previous fields', async () => {
    const r = await rig();
    const { acting, eventId } = await clickedChange(r, 'cancel');
    expect(r.stored(eventId)!.status).toBe('cancelled');
    const res = await r.exec.undoChange(acting.id, candidateOf(r, eventId).id, 'user', CTX);
    expect(res).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(r.stored(eventId)).toMatchObject({ status: 'confirmed', start: WED.startLocal });
    expect(itemOf(r, acting.id).eventState).toBe('updated');
  });

  it('manual window = min(restore-target start, applied + 7 d): one minute inside passes, one minute outside => ACTION_EXPIRED', async () => {
    const r = await rig();
    const { acting, eventId } = await clickedChange(r);
    const cand = candidateOf(r, eventId);
    await r.clock.advanceTo(at(WED.startLocal) + MIN);
    expect(await r.exec.undoChange(acting.id, cand.id, 'user', CTX)).toEqual({
      ok: false,
      error: { code: 'ACTION_EXPIRED' },
    });
    const r2 = await rig();
    const c2 = await clickedChange(r2);
    await r2.clock.advanceTo(at(WED.startLocal) - 61 * MIN);
    expect(await r2.exec.undoChange(c2.acting.id, candidateOf(r2, c2.eventId).id, 'user', CTX)).toMatchObject({
      ok: true,
    });
  });

  it('a stale revision id, an item without an event and an unknown item are refused', async () => {
    const r = await rig();
    const { acting, source, eventId } = await clickedChange(r);
    expect(await r.exec.undoChange(acting.id, 999, 'user', CTX)).toEqual({
      ok: false,
      error: { code: 'ACTION_STALE' },
    });
    expect(await r.exec.undoChange(9999 as never, 1, 'user', CTX)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
    const open = r.seedCreate({ chatN: 4, slot: FRI });
    expect(await r.exec.undoChange(open.item.id, 1, 'user', CTX)).toEqual({
      ok: false,
      error: { code: 'ACTION_STALE' },
    });
    // the OLD card of the event is a valid door: the undo acts on the current holder
    expect(await r.exec.undoChange(source.id, candidateOf(r, eventId).id, 'user', CTX)).toMatchObject({ ok: true });
  });

  it("'user_toast' never approves the undo of a MANUAL change", async () => {
    const r = await rig();
    const { acting, eventId } = await clickedChange(r);
    expect(await r.exec.undoChange(acting.id, candidateOf(r, eventId).id, 'user_toast', null)).toEqual({
      ok: false,
      error: { code: 'ACTION_STALE' },
    });
  });

  it('the draft of the in-calendar card is carried over to the new proposal version (C2 concern 19)', async () => {
    const r = await rig();
    const item = await r.createByClick({ slot: WED });
    const proposal = r.repos.proposals.current(item.id)!;
    r.repos.actions.insertPending({
      itemId: item.id,
      proposalId: proposal.id,
      chatId: item.chatId,
      payload: {
        v: 1,
        kind: 'send_reply',
        itemId: item.id,
        chatRef: item.chatId,
        proposalVersion: proposal.version,
        text: 'See you Wednesday',
      },
      now: r.clock.now() as EpochMs,
    });
    await r.exec.undoChange(item.id, candidateOf(r, item.calendarEventId!).id, 'user', CTX);
    const next = r.repos.proposals.current(item.id)!;
    expect(next.version).toBe(proposal.version + 1);
    expect(next.provider).toBe('user');
    expect(next.draftText).toBe(proposal.draftText);
    const drafts = r.repos.actions.forItem(item.id).filter((a) => a.kind === 'send_reply');
    expect(drafts.map((d) => d.state).sort()).toEqual(['pending', 'superseded']);
    const live = drafts.find((d) => d.state === 'pending')!;
    expect(JSON.parse(live.canonicalJson)).toMatchObject({ text: 'See you Wednesday', proposalVersion: next.version });
  });

  it('restore refused by Google (U-E1) => unknown + a pending create_event "Add it back" that only a click approves', async () => {
    const r = await rig();
    const { acting, eventId } = await clickedChange(r, 'cancel');
    r.cal.scenario('restore_refused');
    const res = await r.exec.undoChange(acting.id, candidateOf(r, eventId).id, 'user', CTX);
    expect(res).toMatchObject({ ok: true, value: { outcome: 'failed' } });
    const offer = r.repos.actions.forItem(acting.id).find((a) => a.kind === 'create_event' && a.state === 'pending')!;
    expect(JSON.parse(offer.canonicalJson)).toMatchObject({ ...WED, title: 'Dentist' });
    expect(offer.approvedBy).toBeNull();
    expect(r.repos.autoDecisions.forAction(offer.id)).toBeNull();
    expect(await r.click(offer.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(actionOf(r, offer.id).approvedBy).toBe('user');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('undo of automatic writes (auto:undo / the toast)', () => {
  it('toast undo of an automatic create: approved_by user_toast, cancelled, auto_writes undone, chat tainted 7 d, notice', async () => {
    const r = await rig();
    const { item, autoWriteId, eventId } = await autoCreate(r);
    const res = await r.exec.undoAuto(autoWriteId, 'user_toast', null);
    expect(res).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(r.stored(eventId)!.status).toBe('cancelled');
    const w = r.repos.autoWrites.byId(autoWriteId)!;
    expect(w.undoState).toBe('undone');
    expect(actionOf(r, w.undoActionId!).approvedBy).toBe('user_toast');
    expect(r.repos.chats.byId(item.chatId)!.autoTaintedUntil).toBe(RIG_NOW + LIMITS.autoTaintMs);
    expect(r.notices).toContainEqual({ kind: 'undo', autoWriteId });
    expect(r.repos.autoPolicies.live()!.state).toBe('on'); // one undo only
  });

  it('after the undo, the next eligible proposal of that chat falls back chat_tainted (F10)', async () => {
    const r = await rig();
    const { autoWriteId } = await autoCreate(r);
    await r.exec.undoAuto(autoWriteId, 'user', CTX);
    await r.clock.advance(31 * MIN);
    const next = r.seedCreate({ chatN: 1, slot: FRI });
    // the chat's previous open item is closed by now? seedCreate made a new open item only if none is open
    expect(await r.exec.tryAuto(next.action.id)).toMatchObject({ verdict: 'fallback', reason: 'chat_tainted' });
  });

  it('blocked_changed: the user edited the event in Google after the write => zero calls, undo_state blocked_changed', async () => {
    const r = await rig();
    const { autoWriteId, eventId } = await autoCreate(r);
    r.cal.userEditsInGoogle(eventId, { location: 'Changed in Google' });
    expect(await r.exec.undoAuto(autoWriteId, 'user_toast', null)).toEqual({
      ok: false,
      error: { code: 'ACTION_STALE' },
    });
    expect(undoOf(r)).toHaveLength(0);
    expect(r.repos.autoWrites.byId(autoWriteId)!.undoState).toBe('blocked_changed');
  });

  it('blocked_started: the restore target already started => refused, and "Cancel event" (F32) is the explicit door', async () => {
    const r = await rig();
    const { item, autoWriteId, eventId } = await autoCreate(r, {
      startLocal: '2026-10-05T12:00:00',
      endLocal: '2026-10-05T13:00:00',
    });
    await r.clock.advanceTo(at('2026-10-05T12:01:00'));
    expect(await r.exec.undoAuto(autoWriteId, 'user', CTX)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    expect(r.repos.autoWrites.byId(autoWriteId)!.undoState).toBe('blocked_started');
    const res = await r.exec.cancelEvent(item.id, CTX);
    expect(res).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(undoOf(r)).toHaveLength(1);
    expect(undoOf(r)[0]!.args).toMatchObject({ status: 'cancelled' });
    expect(r.stored(eventId)!.status).toBe('cancelled');
    const cancelAction = r.repos.actions.forItem(item.id).find((a) => a.kind === 'update_event')!;
    expect(cancelAction.approvedBy).toBe('user');
  });

  it('automatic window min(written_at + 72 h, S): one minute inside passes, one minute outside => expired', async () => {
    const far = { startLocal: '2026-10-19T10:00:00', endLocal: '2026-10-19T11:00:00' };
    const r = await rig();
    const a = await autoCreate(r, far);
    const w = r.repos.autoWrites.byId(a.autoWriteId)!;
    expect(w.undoUntil).toBe(RIG_NOW + LIMITS.autoUndoWindowMs);
    await r.clock.advanceTo(w.undoUntil + MIN);
    expect(await r.exec.undoAuto(a.autoWriteId, 'user', CTX)).toEqual({ ok: false, error: { code: 'ACTION_EXPIRED' } });
    expect(r.repos.autoWrites.byId(a.autoWriteId)!.undoState).toBe('expired');
    const r2 = await rig();
    const b = await autoCreate(r2, far);
    await r2.clock.advanceTo(r2.repos.autoWrites.byId(b.autoWriteId)!.undoUntil - MIN);
    expect(await r2.exec.undoAuto(b.autoWriteId, 'user', CTX)).toMatchObject({ ok: true, value: { outcome: 'done' } });
  });

  it('F2: an automatic move to now + 2 h 01 min undone at now + 3 h succeeds (window tied to the restore target)', async () => {
    const r = await rig();
    await r.trackRecord();
    const source = await r.createByClick({ slot: FRI });
    r.policy('on', { quietHours: null });
    const soon = { startLocal: '2026-10-05T12:01:00', endLocal: '2026-10-05T13:01:00' };
    // an EARLIER automatic move needs >= 24 h notice (F2), so this move is later-in-the-day-of-Friday-to-sooner: allowed only as a click
    const d = r.seedDelta({ source, change: 'reschedule', to: soon });
    expect(await r.exec.tryAuto(d.action.id)).toMatchObject({ verdict: 'fallback', reason: 'too_soon' });
    // the undo window rule itself: a click-approved change is undone later, measured to the restore target (Friday)
    expect(await r.click(d.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    await r.clock.advanceTo(RIG_NOW + 3 * HOURS);
    expect(await r.exec.undoChange(d.item.id, candidateOf(r, source.calendarEventId!).id, 'user', CTX)).toMatchObject({
      ok: true,
    });
    expect(r.stored(source.calendarEventId!)).toMatchObject({ start: FRI.startLocal });
  });

  it('F1 chain: auto-edit, auto-edit, undo, undo => back at the first write’s from, exactly 2 undo PATCHes, policy paused', async () => {
    const r = await rig();
    await r.trackRecord();
    const source = await r.createByClick({ slot: WED });
    r.policy('on');
    const d1 = r.seedDelta({ source, change: 'reschedule', to: THU });
    const o1 = await r.exec.tryAuto(d1.action.id);
    expect(o1).toMatchObject({ verdict: 'auto', result: 'done' });
    await r.clock.advance(31 * MIN);
    const d2 = r.seedDelta({ source: itemOf(r, d1.item.id), change: 'reschedule', to: FRI });
    const o2 = await r.exec.tryAuto(d2.action.id);
    expect(o2).toMatchObject({ verdict: 'auto', result: 'done' });
    if (o1.verdict === 'none' || o2.verdict === 'none') throw new Error('unreachable');
    const eventId = source.calendarEventId!;
    expect(await r.exec.undoAuto(o2.autoWriteId!, 'user', CTX)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(r.stored(eventId)).toMatchObject({ start: THU.startLocal });
    const afterFirstUndo = r.repos.eventRevisions.newestFor(eventId)!;
    expect(await r.exec.undoAuto(o1.autoWriteId!, 'user_toast', null)).toMatchObject({
      ok: true,
      value: { outcome: 'done' },
    });
    expect(r.stored(eventId)).toMatchObject({ start: WED.startLocal, end: WED.endLocal });
    expect(undoOf(r)).toHaveLength(4); // 2 automatic edits + exactly 2 undo PATCHes
    // the second undo's If-Match is the FIRST UNDO's post_etag (the newest revision), never auto-edit #1's own post_*
    expect(undoOf(r)[3]!.args.ifMatch).toBe(afterFirstUndo.postEtag);
    expect(r.repos.autoPolicies.live()).toMatchObject({ state: 'paused', pausedReason: 'circuit_breaker_undo' });
  });

  it('Restore original after two automatic edits => ONE PATCH to the oldest pre_json, both revisions reverted by the new row', async () => {
    const r = await rig();
    await r.trackRecord();
    const source = await r.createByClick({ slot: WED });
    r.policy('on');
    const d1 = r.seedDelta({ source, change: 'reschedule', to: THU });
    const o1 = await r.exec.tryAuto(d1.action.id);
    await r.clock.advance(31 * MIN);
    const d2 = r.seedDelta({ source: itemOf(r, d1.item.id), change: 'reschedule', to: FRI });
    const o2 = await r.exec.tryAuto(d2.action.id);
    if (o1.verdict === 'none' || o2.verdict === 'none') throw new Error('unreachable');
    const eventId = source.calendarEventId!;
    const span = r.repos.eventRevisions.unrevertedAutoSpan(eventId);
    expect(span).toHaveLength(2);
    const res = await r.exec.restoreOriginal(d2.item.id, CTX);
    expect(res).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(undoOf(r)).toHaveLength(3);
    expect(r.stored(eventId)).toMatchObject({ start: WED.startLocal });
    const restoreRow = r.repos.eventRevisions.newestFor(eventId)!;
    for (const s of span) expect(r.repos.eventRevisions.byId(s.id)!.revertedBy).toBe(restoreRow.id);
    expect(r.repos.autoWrites.byId(o1.autoWriteId!)!.undoState).toBe('undone');
    expect(r.repos.autoWrites.byId(o2.autoWriteId!)!.undoState).toBe('undone');
    expect(r.repos.autoPolicies.live()!.state).toBe('on'); // counts as ONE undo
    expect(await r.exec.restoreOriginal(d2.item.id, CTX)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
  });

  it('undoAuto: unknown write => NOT_FOUND; a write without a revision (failed) => ACTION_STALE; a newer change first => ACTION_STALE', async () => {
    const r = await rig();
    expect(await r.exec.undoAuto('00000000-0000-4000-8000-00000000000f', 'user', CTX)).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    const { item, autoWriteId, eventId } = await autoCreate(r);
    const d = r.seedDelta({ source: item, change: 'move', to: { location: 'Room 9' } });
    expect(await r.click(d.action.id)).toMatchObject({ ok: true });
    expect(await r.exec.undoAuto(autoWriteId, 'user', CTX)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    expect(candidateOf(r, eventId).kind).toBe('move');
  });

  it('cancelEvent / restoreOriginal refuse items without a live event', async () => {
    const r = await rig();
    const open = r.seedCreate({ chatN: 7, slot: WED });
    expect(await r.exec.cancelEvent(open.item.id, CTX)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    expect(await r.exec.restoreOriginal(open.item.id, CTX)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    expect(await r.exec.cancelEvent(9999 as never, CTX)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await r.exec.restoreOriginal(9999 as never, CTX)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
    const created = await r.createByClick({ chatN: 2, slot: THU });
    expect(await r.exec.restoreOriginal(created.id, CTX)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    const { acting } = await clickedChange(r, 'cancel');
    expect(await r.exec.cancelEvent(acting.id, CTX)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('reconcile v2 (I7′): get-event only, never list-events for updates, never a re-patch', () => {
  it('a PATCH that landed but did not answer => unknown; startup reconcile by get-event => done, exactly one PATCH', async () => {
    const r = await rig({
      wrapWrite: (real): McpWriteClient => ({
        ...real,
        updateEvent: async (args) => {
          await real.updateEvent(args);
          return { ok: false, error: 'timeout' };
        },
      }),
    });
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    await r.click(d.action.id);
    expect(actionOf(r, d.action.id).state).toBe('unknown_outcome');
    const listBefore = r.cal.calls.filter((c) => c.tool === 'list-events').length;
    await r.exec.recoverOnStartup();
    expect(actionOf(r, d.action.id).state).toBe('done');
    expect(itemOf(r, d.item.id)).toMatchObject({ eventState: 'updated', eventRevision: 2 });
    expect(undoOf(r)).toHaveLength(1);
    expect(r.cal.calls.filter((c) => c.tool === 'list-events').length).toBe(listBefore);
  });

  it('a crash between the write-ahead and the PATCH => unknown_outcome, reconcile keeps it unknown, "Apply again" offered', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    const a = actionOf(r, d.action.id);
    r.repos.actions.markApprovedExecuting(a.id, a.canonicalJson, r.clock.now() as EpochMs, 'user');
    await r.exec.recoverOnStartup();
    expect(actionOf(r, d.action.id).state).toBe('unknown_outcome');
    expect(r.exec.offerRetryForUnknown()).toBe(1);
    expect(undoOf(r)).toHaveLength(0);
  });

  it('another change landed meanwhile => superseded; without deps the frozen form stays unknown', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    const a = actionOf(r, d.action.id);
    r.repos.actions.markApprovedExecuting(a.id, a.canonicalJson, r.clock.now() as EpochMs, 'user');
    r.repos.actions.markUnknownOutcome(a.id, r.clock.now() as EpochMs);
    expect(await reconcileUpdate(a.id)).toBe('unknown_outcome');
    r.repos.items.update(source.id, { eventRevision: 2 }, r.clock.now() as EpochMs);
    const deps = {
      repos: r.repos,
      bridgeDb: null,
      read: r.read,
      now: () => r.clock.now() as EpochMs,
      timeZone: () => 'Asia/Jerusalem',
    };
    expect(await reconcileUpdate(a.id, deps)).toBe('superseded');
    expect(actionOf(r, a.id).state).toBe('superseded');
    expect(await reconcileUpdate('nope' as never, deps)).toBe('unknown_outcome');
  });

  it('an automatic write interrupted by a crash pauses the policy (circuit_breaker_unknown) on startup', async () => {
    let release: () => void = () => undefined;
    const r = await rig({
      wrapWrite: (real): McpWriteClient => ({
        ...real,
        createEvent: (args) =>
          args.summary.startsWith('Track')
            ? real.createEvent(args)
            : new Promise((res) => (release = () => res({ ok: false, error: 'timeout' }))),
      }),
    });
    await r.trackRecord();
    r.policy('on');
    const { action } = r.seedCreate({ chatN: 1, slot: WED });
    const pending = r.exec.tryAuto(action.id);
    await new Promise((res) => setImmediate(res));
    await r.exec.recoverOnStartup();
    expect(r.repos.autoPolicies.live()).toMatchObject({ state: 'paused', pausedReason: 'circuit_breaker_unknown' });
    release();
    await pending.catch(() => undefined);
  });

  it('B24 (T-401): a create found but EDITED in Google => done + exactly one pending update_event, zero writes without a click', async () => {
    const r = await rig({
      wrapWrite: (real): McpWriteClient => ({
        ...real,
        createEvent: async (args) => {
          await real.createEvent(args);
          return { ok: false, error: 'timeout' };
        },
      }),
    });
    const { item, action } = r.seedCreate({ slot: WED });
    await r.click(action.id);
    expect(actionOf(r, action.id).state).toBe('unknown_outcome');
    const eventId = r.cal.storedEvents[0]!.eventId;
    r.cal.userEditsInGoogle(eventId, { start: '2026-10-07T16:00:00', end: '2026-10-07T17:00:00' });
    const res = await reconcileUnknown({
      repos: r.repos,
      bridgeDb: null,
      read: r.read,
      now: () => r.clock.now() as EpochMs,
      timeZone: () => 'Asia/Jerusalem',
    });
    expect(res.resolvedDone).toBe(1);
    expect(actionOf(r, action.id).state).toBe('done');
    const updates = r.repos.actions.forItem(item.id).filter((a) => a.kind === 'update_event');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.state).toBe('pending');
    const p = JSON.parse(updates[0]!.canonicalJson) as UpdateEventPayload;
    expect(p).toMatchObject({ from: { startLocal: '2026-10-07T16:00:00' }, to: { ...WED }, baseRevision: 1 });
    expect(undoOf(r)).toHaveLength(0);
  });

  it('B24: a found and UNEDITED create => done, no update offered', async () => {
    const r = await rig({
      wrapWrite: (real): McpWriteClient => ({
        ...real,
        createEvent: async (args) => {
          await real.createEvent(args);
          return { ok: false, error: 'timeout' };
        },
      }),
    });
    const { item, action } = r.seedCreate({ slot: WED });
    await r.click(action.id);
    await r.exec.recoverOnStartup();
    expect(actionOf(r, action.id).state).toBe('done');
    expect(r.repos.actions.forItem(item.id).filter((a) => a.kind === 'update_event')).toEqual([]);
    expect(itemOf(r, item.id).eventRevision).toBe(1);
  });
});

describe('the rig itself', () => {
  it('uses one virtual clock (no real time leaks into the windows)', async () => {
    const r = await rig();
    expect(r.clock.now()).toBe(RIG_NOW);
    await r.clock.advance(DAYS);
    expect(r.clock.now()).toBe(RIG_NOW + DAYS);
  });
});
