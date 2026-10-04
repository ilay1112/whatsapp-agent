// src/main/exec/actionExecutor.v2fix.test.ts - v2 phase 3 repairs of src/main/exec (ops/agent-notes/v2-fix-src-main-exec.md).
// One describe per confirmed finding; each reproduces the reviewer's scenario through the real executor, the real in-memory DB with
// the production triggers and the fake calendar (tests/helpers/ledger.execRig). Synthetic data only.
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../../shared/types';
import { reconcileUnknown } from './reconcile';
import { CTX, RIG_TZ, makeExecRig } from '../../../tests/helpers/ledger.execRig';
import type { Rig, RigOptions } from '../../../tests/helpers/ledger.execRig';
import type { ApprovalAction, EpochMs, Item } from '../../shared/types';
import type { McpReadClient } from '../mcp/readClient';
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
const itemOf = (r: Rig, id: number): Item => r.repos.items.byId(id as never)!;
const actionOf = (r: Rig, id: string): ApprovalAction => r.repos.actions.byId(id as never)!;
const pendingOf = (r: Rig, itemId: number, kind: ApprovalAction['kind']): ApprovalAction | undefined =>
  r.repos.actions.forItem(itemId as never).find((a) => a.kind === kind && a.state === 'pending');
const updates = (r: Rig): number => r.cal.calls.filter((c) => c.tool === 'update-event').length;
const reconcile = (r: Rig): ReturnType<typeof reconcileUnknown> =>
  reconcileUnknown({
    repos: r.repos,
    bridgeDb: null,
    read: r.read,
    now: () => r.clock.now() as EpochMs,
    timeZone: () => RIG_TZ,
  });
const liveAppEvents = (r: Rig) => r.cal.storedEvents.filter((e) => e.status === 'confirmed' && e.priv.waAgent === '1');

/** The n-th call of `tool` reaches the fake (the side effect HAPPENS) but the app is told `timeout`. */
function landsThenTimesOut(tool: 'createEvent' | 'updateEvent', nth = 1): (w: McpWriteClient) => McpWriteClient {
  let n = 0;
  return (w) => ({
    ...w,
    [tool]: async (args: never) => {
      const res = await (w[tool] as (a: never) => Promise<unknown>)(args);
      n += 1;
      return n === nth ? { ok: false, error: 'timeout' } : res;
    },
  });
}
/** The n-th call of `tool` never reaches the fake (nothing happens) and the app is told `timeout`. */
function dropsThenTimesOut(tool: 'createEvent' | 'updateEvent', nth = 1): (w: McpWriteClient) => McpWriteClient {
  let n = 0;
  return (w) => ({
    ...w,
    [tool]: async (args: never) => {
      n += 1;
      if (n === nth) return { ok: false, error: 'timeout' };
      return (w[tool] as (a: never) => Promise<unknown>)(args);
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
describe('auto-mode-2: an automatic create whose readback failed stays undoable', () => {
  const failingReadback = async () => {
    let failNextGet = false;
    const r = await rig({
      wrapRead: (real): McpReadClient => ({
        ...real,
        getEvent: (cal, id) => {
          if (failNextGet) {
            failNextGet = false;
            return Promise.resolve({ ok: false, error: 'unavailable' });
          }
          return real.getEvent(cal, id);
        },
      }),
    });
    await r.trackRecord();
    r.policy('on');
    const { item, action } = r.seedCreate({ chatN: 1, slot: WED });
    failNextGet = true; // the readback inside runCreate
    const o = await r.exec.tryAuto(action.id);
    expect(o).toMatchObject({ verdict: 'auto', result: 'done' });
    if (o.verdict === 'none') throw new Error('unreachable');
    const eventId = itemOf(r, item.id).calendarEventId!;
    expect(r.repos.eventRevisions.newestFor(eventId)).toMatchObject({ postEtag: null, postUpdated: null });
    return { r, autoWriteId: o.autoWriteId!, eventId };
  };

  it('the event is untouched since the app wrote it => Undo cancels it', async () => {
    const { r, autoWriteId, eventId } = await failingReadback();
    const res = await r.exec.undoAuto(autoWriteId, 'user', CTX);
    expect(res).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(r.stored(eventId)!.status).toBe('cancelled');
    expect(r.repos.autoWrites.byId(autoWriteId)!.undoState).toBe('undone');
  });

  it('the event WAS changed in Google meanwhile => still blocked_changed with zero writes (fail closed)', async () => {
    const { r, autoWriteId, eventId } = await failingReadback();
    r.cal.userEditsInGoogle(eventId, { start: '2026-10-07T16:00:00', end: '2026-10-07T17:00:00' });
    expect(await r.exec.undoAuto(autoWriteId, 'user', CTX)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    expect(r.repos.autoWrites.byId(autoWriteId)!.undoState).toBe('blocked_changed');
    expect(updates(r)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('auto-mode-3: a chat opt-out / taint that lands while tryAuto awaits its Google reads stops the write', () => {
  const run = async (mutate: (r: Rig, chatId: number) => void) => {
    let hook: (() => void) | null = null;
    const r = await rig({
      wrapRead: (real): McpReadClient => ({
        ...real,
        getFreeBusy: async (w) => {
          const h = hook;
          hook = null;
          h?.();
          return real.getFreeBusy(w);
        },
      }),
    });
    await r.trackRecord();
    r.policy('on');
    const { action } = r.seedCreate({ chatN: 1, slot: WED });
    const chatId = r.chat(1).id;
    hook = () => mutate(r, chatId); // fires inside Phase B's fresh free/busy read (after Phase A passed)
    const o = await r.exec.tryAuto(action.id);
    return { o, creates: r.cal.calls.filter((c) => c.tool === 'create-event').length };
  };

  it('"Never automatic for this contact" during the read => fallback chat_opted_out, no write', async () => {
    const { o, creates } = await run((r, chatId) => void r.repos.chats.setAutoPolicy(chatId as never, 'never'));
    expect(o).toMatchObject({ verdict: 'fallback', reason: 'chat_opted_out' });
    expect(creates).toBe(3); // the three track-record clicks only
  });

  it('the chat is tainted during the read => fallback chat_tainted, no write', async () => {
    const { o, creates } = await run(
      (r, chatId) => void r.repos.chats.taint(chatId as never, (r.clock.now() + LIMITS.autoTaintMs) as EpochMs),
    );
    expect(o).toMatchObject({ verdict: 'fallback', reason: 'chat_tainted' });
    expect(creates).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('auto-mode-4: the undo of an automatic write counts in auto_chat / auto_global (B9)', () => {
  it('automatic create + its undo => 2 in each bucket', async () => {
    const r = await rig();
    await r.trackRecord();
    r.policy('on');
    const { action } = r.seedCreate({ chatN: 1, slot: WED });
    const o = await r.exec.tryAuto(action.id);
    if (o.verdict === 'none') throw new Error('unreachable');
    await r.clock.advance(5 * MIN);
    expect(await r.exec.undoAuto(o.autoWriteId!, 'user', CTX)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const since = (r.clock.now() - 24 * 3_600_000) as EpochMs;
    expect(r.repos.rate.countSince('auto_global', 'global', since)).toBe(2);
    expect(r.repos.rate.countSince('auto_chat', String(r.chat(1).id), since)).toBe(2);
  });

  it('the undo of a click-approved change is not an automatic write: the auto buckets stay empty', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    expect(await r.click(d.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const cand = r.repos.eventRevisions.undoCandidate(source.calendarEventId!)!;
    expect(await r.exec.undoChange(d.item.id, cand.id, 'user', CTX)).toMatchObject({ ok: true });
    const since = (r.clock.now() - 24 * 3_600_000) as EpochMs;
    expect(r.repos.rate.countSince('auto_global', 'global', since)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('editing-undo-1 (T-401): the retry of a create whose first attempt landed never creates a second event', () => {
  it('an EDITED "Add again" becomes an update_event of the landed event (same click)', async () => {
    const r = await rig({ wrapWrite: landsThenTimesOut('createEvent') });
    const { item, action } = r.seedCreate({ slot: WED });
    expect(await r.click(action.id)).toMatchObject({ ok: true, value: { outcome: 'failed' } });
    expect(actionOf(r, action.id).state).toBe('unknown_outcome');
    const clone = pendingOf(r, item.id, 'create_event')!;
    const again = await r.click(clone.id, {
      edit: { title: 'Dentist', startLocal: FRI.startLocal, endLocal: FRI.endLocal, location: '' },
    });
    expect(again).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const live = liveAppEvents(r);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ start: FRI.startLocal, end: FRI.endLocal });
    expect(actionOf(r, action.id).state).toBe('done'); // the landed first attempt is recorded (rev 1)
    expect(actionOf(r, clone.id).state).toBe('superseded'); // the create clone never wrote
    const eventId = itemOf(r, item.id).calendarEventId!;
    const newest = r.repos.eventRevisions.newestFor(eventId)!;
    expect(newest).toMatchObject({ revision: 2, kind: 'reschedule' });
    expect(newest.prev).toMatchObject(WED);
    expect(actionOf(r, newest.actionId).approvedBy).toBe('user');
  });

  it('an UNEDITED "Add again" is done without a write and without a conflict prompt about its own event', async () => {
    const r = await rig({ wrapWrite: landsThenTimesOut('createEvent') });
    const { item, action } = r.seedCreate({ slot: WED });
    await r.click(action.id);
    const clone = pendingOf(r, item.id, 'create_event')!;
    expect(await r.click(clone.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(liveAppEvents(r)).toHaveLength(1);
    expect(r.cal.calls.filter((c) => c.tool === 'create-event')).toHaveLength(1);
    expect(itemOf(r, item.id)).toMatchObject({ state: 'in_calendar', eventState: 'created', eventRevision: 1 });
  });

  it('a create whose first attempt really did NOT land is still created by "Add again" (v1)', async () => {
    const r = await rig({ wrapWrite: dropsThenTimesOut('createEvent') });
    const { item, action } = r.seedCreate({ slot: WED });
    await r.click(action.id);
    const clone = pendingOf(r, item.id, 'create_event')!;
    expect(await r.click(clone.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(liveAppEvents(r)).toHaveLength(1);
    expect(actionOf(r, clone.id).state).toBe('done');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('editing-undo-2: "Apply again" after an update that landed but timed out', () => {
  it('recognises the app’s own landed write: no drift prompt, no second PATCH, and Undo restores the original', async () => {
    const r = await rig({ wrapWrite: landsThenTimesOut('updateEvent') });
    const source = await r.createByClick({ slot: WED });
    const eventId = source.calendarEventId!;
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    expect(await r.click(d.action.id)).toMatchObject({ ok: true, value: { outcome: 'failed' } });
    expect(r.stored(eventId)).toMatchObject({ start: THU.startLocal });
    const clone = pendingOf(r, d.item.id, 'update_event')!;
    expect(await r.click(clone.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(updates(r)).toBe(1);
    expect(actionOf(r, d.action.id).state).toBe('done');
    const rev = r.repos.eventRevisions.newestFor(eventId)!;
    expect(rev).toMatchObject({ revision: 2 });
    expect(rev.prev).toMatchObject(WED);
    expect(await r.exec.undoChange(d.item.id, rev.id, 'user', CTX)).toMatchObject({
      ok: true,
      value: { outcome: 'done' },
    });
    expect(r.stored(eventId)).toMatchObject({ start: WED.startLocal });
  });

  it('an EDITED "Apply again" records the landed change first, then the edit as its own revision', async () => {
    const r = await rig({ wrapWrite: landsThenTimesOut('updateEvent') });
    const source = await r.createByClick({ slot: WED });
    const eventId = source.calendarEventId!;
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    await r.click(d.action.id);
    const clone = pendingOf(r, d.item.id, 'update_event')!;
    const res = await r.click(clone.id, {
      edit: { title: 'Dentist', startLocal: FRI.startLocal, endLocal: FRI.endLocal, location: '' },
    });
    expect(res).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(r.stored(eventId)).toMatchObject({ start: FRI.startLocal });
    const newest = r.repos.eventRevisions.newestFor(eventId)!;
    expect(newest.revision).toBe(3);
    expect(newest.prev).toMatchObject(THU);
    expect(r.repos.eventRevisions.byId(newest.id - 1)!.prev).toMatchObject(WED);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('editing-undo-3: an undo whose PATCH timed out without landing can be retried', () => {
  it('in-session and after the startup reconcile left it unknown', async () => {
    const r = await rig({ wrapWrite: dropsThenTimesOut('updateEvent', 2) }); // call 1 = the reschedule, call 2 = the undo
    const source = await r.createByClick({ slot: WED });
    const eventId = source.calendarEventId!;
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    expect(await r.click(d.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const cand = r.repos.eventRevisions.undoCandidate(eventId)!;
    expect(await r.exec.undoChange(d.item.id, cand.id, 'user', CTX)).toMatchObject({
      ok: true,
      value: { outcome: 'failed' },
    });
    expect(r.stored(eventId)).toMatchObject({ start: THU.startLocal });
    await reconcile(r);
    expect(r.repos.eventRevisions.undoCandidate(eventId)!.id).toBe(cand.id);
    expect(await r.exec.undoChange(d.item.id, cand.id, 'user', CTX)).toMatchObject({
      ok: true,
      value: { outcome: 'done' },
    });
    expect(r.stored(eventId)).toMatchObject({ start: WED.startLocal });
    // idempotency still holds once the retry is done
    expect(await r.exec.undoChange(d.item.id, cand.id, 'user', CTX)).toEqual({
      ok: false,
      error: { code: 'ACTION_STALE' },
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('editing-undo-4: a refused undo does not leave the card showing the restore target', () => {
  it('CAL_UNAVAILABLE keeps the content Google holds; the retry then shows the restored slot', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const eventId = source.calendarEventId!;
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    expect(await r.click(d.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const cand = r.repos.eventRevisions.undoCandidate(eventId)!;
    const shownBefore = r.repos.proposals.current(d.item.id)!.event; // items.ts draws the card's event from the current proposal
    r.flags.calendarConnected = false;
    expect(await r.exec.undoChange(d.item.id, cand.id, 'user', CTX)).toEqual({
      ok: false,
      error: { code: 'CAL_UNAVAILABLE' },
    });
    expect(r.stored(eventId)).toMatchObject({ start: THU.startLocal });
    expect(r.repos.proposals.current(d.item.id)!.event).toEqual(shownBefore); // never the WED restore target
    expect(pendingOf(r, d.item.id, 'update_event')).toBeUndefined();
    r.flags.calendarConnected = true;
    expect(await r.exec.undoChange(d.item.id, cand.id, 'user', CTX)).toMatchObject({
      ok: true,
      value: { outcome: 'done' },
    });
    expect(r.repos.proposals.current(d.item.id)!.event!.startLocal).toBe(WED.startLocal);
  });

  it('a pending draft survives the refused undo and stays approvable', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    expect(await r.click(d.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const proposal = r.repos.proposals.current(d.item.id)!;
    r.repos.actions.insertPending({
      itemId: d.item.id,
      proposalId: proposal.id,
      chatId: d.item.chatId,
      payload: {
        v: 1,
        kind: 'send_reply',
        itemId: d.item.id,
        chatRef: d.item.chatId,
        proposalVersion: proposal.version,
        text: 'See you then',
      },
      now: r.clock.now() as EpochMs,
    });
    r.flags.calendarConnected = false;
    const cand = r.repos.eventRevisions.undoCandidate(source.calendarEventId!)!;
    await r.exec.undoChange(d.item.id, cand.id, 'user', CTX);
    const draft = pendingOf(r, d.item.id, 'send_reply')!;
    expect(draft.proposalId).toBe(r.repos.proposals.current(d.item.id)!.id);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('editing-undo-8 / data-integrity-v4-4: the revision of an event is read from its revision chain', () => {
  it('reconcile of an unknown update whose "Apply again" clone already landed neither throws nor stays unknown', async () => {
    const r = await rig({ wrapWrite: dropsThenTimesOut('updateEvent', 1) });
    const source = await r.createByClick({ slot: WED });
    const eventId = source.calendarEventId!;
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    await r.click(d.action.id);
    const clone = pendingOf(r, d.item.id, 'update_event')!;
    expect(await r.click(clone.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(r.repos.eventRevisions.newestFor(eventId)!.revision).toBe(2);
    await expect(reconcile(r)).resolves.toMatchObject({ checked: 1 });
    expect(actionOf(r, d.action.id).state).toBe('superseded');
    expect(r.repos.eventRevisions.newestFor(eventId)!.revision).toBe(2);
  });

  it('after the startup reconcile marked the landed original done, its retry clone writes nothing', async () => {
    const r = await rig({ wrapWrite: landsThenTimesOut('updateEvent') });
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    await r.click(d.action.id);
    const clone = pendingOf(r, d.item.id, 'update_event')!;
    await r.exec.recoverOnStartup();
    expect(actionOf(r, d.action.id).state).toBe('done');
    expect(actionOf(r, clone.id).state).toBe('superseded'); // the chain resolved: its clone is no longer offered
    expect(await r.click(clone.id)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    expect(updates(r)).toBe(1);
  });

  it('approveUpdate refuses a pending change whose base revision the chain has moved past (ACTION_STALE, zero calls)', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const d1 = r.seedDelta({ source, change: 'reschedule', to: THU });
    expect(await r.click(d1.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    // a stale card still pinned to the SOURCE at base revision 1 (its from = Google's current copy, so no drift hides it)
    const d2 = r.seedDelta({ source: itemOf(r, source.id), change: 'reschedule', to: FRI });
    expect(d2.payload.baseRevision).toBe(1);
    expect(await r.click(d2.action.id)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    expect(updates(r)).toBe(1);
  });

  it('one row that throws does not abort the reconcile pass: the later unknown actions are still resolved', async () => {
    const lands = landsThenTimesOut('createEvent', 1);
    const r = await rig({ wrapWrite: (w) => landsThenTimesOut('createEvent', 2)(lands(w)) });
    const first = r.seedCreate({ chatN: 1, slot: WED });
    await r.click(first.action.id); // lands, answers timeout
    await r.clock.advance(MIN);
    const second = r.seedCreate({ chatN: 2, slot: THU });
    await r.click(second.action.id); // lands, answers timeout
    expect([actionOf(r, first.action.id).state, actionOf(r, second.action.id).state]).toEqual([
      'unknown_outcome',
      'unknown_outcome',
    ]);
    // the OLDER unknown row's resolution throws (any repo-layer error, e.g. a constraint)
    const original = r.repos.actions.chainRoot.bind(r.repos.actions);
    r.repos.actions.chainRoot = ((id: never) => {
      if (id === first.action.id) throw new Error('boom');
      return original(id);
    }) as typeof original;
    const res = await reconcile(r);
    r.repos.actions.chainRoot = original;
    expect(res).toMatchObject({ checked: 2, resolvedDone: 1, stillUnknown: 1 });
    expect(actionOf(r, first.action.id).state).toBe('unknown_outcome');
    expect(actionOf(r, second.action.id).state).toBe('done');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('editing-undo-9: an event card whose reply is ALSO sent stays an editable in-calendar event', () => {
  it('create, then send => in_calendar, not closed; still the editable event of its chat (findExistingEvent source)', async () => {
    const r = await rig();
    const { item, action } = r.seedCreate({ slot: WED });
    const send = r.repos.actions.insertPending({
      itemId: item.id,
      proposalId: action.proposalId,
      chatId: item.chatId,
      payload: {
        v: 1,
        kind: 'send_reply',
        itemId: item.id,
        chatRef: item.chatId,
        proposalVersion: 1,
        text: 'See you then',
      },
      now: r.clock.now() as EpochMs,
    });
    expect(await r.click(action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(await r.click(send.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const after = itemOf(r, item.id);
    expect({ state: after.state, closedReason: after.closedReason, replyState: after.replyState }).toEqual({
      state: 'in_calendar',
      closedReason: null,
      replyState: 'sent',
    });
    // findExistingEvent (agent/**, not importable from exec/**) starts from exactly this repo query (EDITABLE_EVENT_FILTER)
    const since = (r.clock.now() - LIMITS.eventEditGraceMs) as EpochMs;
    expect(r.repos.items.newestEditableEvent(item.chatId, since)?.id).toBe(item.id);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('editing-undo-10: a reconciled create no longer offers its "Add again" clone', () => {
  it('reconcileCreate supersedes the pending create clone of its chain in the same transaction', async () => {
    const r = await rig({ wrapWrite: landsThenTimesOut('createEvent') });
    const { item, action } = r.seedCreate({ slot: WED });
    await r.click(action.id);
    expect(pendingOf(r, item.id, 'create_event')).toBeDefined();
    await reconcile(r);
    expect(actionOf(r, action.id).state).toBe('done');
    expect(pendingOf(r, item.id, 'create_event')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('data-integrity-v4-5: Restore original reverts its whole span also when it is resolved by reconcile', () => {
  it('a Restore original whose PATCH landed but timed out, reconciled on startup, reverts BOTH automatic writes', async () => {
    // update-event calls: #1 auto edit 1, #2 auto edit 2, #3 the restore PATCH (lands, answers timeout)
    const r = await rig({ wrapWrite: landsThenTimesOut('updateEvent', 3) });
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
    await r.exec.restoreOriginal(d2.item.id, CTX); // unknown_outcome (Google already holds WED again)
    expect(r.stored(eventId)).toMatchObject({ start: WED.startLocal });
    await r.exec.recoverOnStartup();
    const states = [o1.autoWriteId!, o2.autoWriteId!].map((id) => r.repos.autoWrites.byId(id)!.undoState);
    const reverted = span.map((s) => r.repos.eventRevisions.byId(s.id)!.revertedBy !== null);
    expect({ states, reverted, span: r.repos.eventRevisions.unrevertedAutoSpan(eventId).length }).toEqual({
      states: ['undone', 'undone'],
      reverted: [true, true],
      span: 0,
    });
  });

  it('a plain undo of the newest automatic edit (not a restore) reverts only that edit', async () => {
    const r = await rig({ wrapWrite: landsThenTimesOut('updateEvent', 3) });
    await r.trackRecord();
    const source = await r.createByClick({ slot: WED });
    r.policy('on');
    const d1 = r.seedDelta({ source, change: 'reschedule', to: THU });
    const o1 = await r.exec.tryAuto(d1.action.id);
    await r.clock.advance(31 * MIN);
    const d2 = r.seedDelta({ source: itemOf(r, d1.item.id), change: 'reschedule', to: FRI });
    const o2 = await r.exec.tryAuto(d2.action.id);
    if (o1.verdict === 'none' || o2.verdict === 'none') throw new Error('unreachable');
    await r.exec.undoAuto(o2.autoWriteId!, 'user', CTX); // lands (THU), answers timeout
    await r.exec.recoverOnStartup();
    const states = [o1.autoWriteId!, o2.autoWriteId!].map((id) => r.repos.autoWrites.byId(id)!.undoState);
    expect(states).toEqual(['available', 'undone']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('editing-undo-5 (exec side): rejecting the B24 correction keeps the in-calendar card', () => {
  it('reconcile offers the correction (pending update_event on the holder); "Keep" leaves the item in_calendar / created', async () => {
    const r = await rig({ wrapWrite: landsThenTimesOut('createEvent') });
    const { item, action } = r.seedCreate({ slot: WED });
    await r.click(action.id);
    r.cal.userEditsInGoogle(r.cal.storedEvents[0]!.eventId, {
      start: '2026-10-07T16:00:00',
      end: '2026-10-07T17:00:00',
    });
    await reconcile(r);
    const offer = pendingOf(r, item.id, 'update_event')!;
    expect(JSON.parse(offer.canonicalJson)).toMatchObject({ targetItemId: item.id, to: WED });
    expect(await r.exec.reject(offer.id)).toEqual({ ok: true, value: null });
    expect(itemOf(r, item.id)).toMatchObject({ state: 'in_calendar', eventState: 'created' });
  });

  it('rejecting a change CARD still declines the card itself (F32, unchanged)', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    expect(await r.exec.reject(d.action.id)).toEqual({ ok: true, value: null });
    expect(itemOf(r, d.item.id).eventState).toBe('declined');
    expect(itemOf(r, source.id)).toMatchObject({ state: 'in_calendar', eventState: 'created' });
  });
});
