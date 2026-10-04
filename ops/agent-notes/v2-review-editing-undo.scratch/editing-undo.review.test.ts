// Adversarial review "editing-undo" - failing tests that prove findings (scratch, NOT part of npm test).
// Each `it` asserts the CORRECT behaviour; a red result is the finding.
import { afterEach, describe, expect, it } from 'vitest';
import { CTX, makeExecRig } from '../../../tests/helpers/ledger.execRig';
import type { Rig, RigOptions } from '../../../tests/helpers/ledger.execRig';
import { reconcileUnknown } from '../../../src/main/exec/reconcile';
import type { McpWriteClient } from '../../../src/main/mcp/writeClient';
import type { ApprovalAction, Item } from '../../../src/shared/types';

const rigs: Rig[] = [];
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.stop();
});
async function rig(opts: RigOptions = {}): Promise<Rig> {
  const r = await makeExecRig(opts);
  rigs.push(r);
  return r;
}
const WED = { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' };
const THU = { startLocal: '2026-10-08T17:00:00', endLocal: '2026-10-08T18:00:00' };
const FRI = { startLocal: '2026-10-09T10:00:00', endLocal: '2026-10-09T11:00:00' };
const itemOf = (r: Rig, id: number): Item => r.repos.items.byId(id as never)!;
const pendingOf = (r: Rig, itemId: number, kind: ApprovalAction['kind']): ApprovalAction | undefined =>
  r.repos.actions.forItem(itemId as never).find((a) => a.kind === kind && a.state === 'pending');

/** the n-th call of `tool` reaches the fake (the side effect HAPPENS) but the app is told `timeout` */
function landsThenTimesOut(tool: 'createEvent' | 'updateEvent', nth = 1): (w: McpWriteClient) => McpWriteClient {
  let n = 0;
  return (w) =>
    new Proxy(w, {
      get(target, prop, recv) {
        const orig = Reflect.get(target, prop, recv) as unknown;
        if (prop !== tool || typeof orig !== 'function') return orig;
        return async (args: unknown) => {
          const res = await (orig as (a: unknown) => Promise<unknown>).call(target, args);
          n += 1;
          return n === nth ? { ok: false, error: 'timeout' } : res;
        };
      },
    });
}
/** the n-th call of `tool` never reaches the fake (nothing happens) and the app is told `timeout` */
function dropsThenTimesOut(tool: 'createEvent' | 'updateEvent', nth = 1): (w: McpWriteClient) => McpWriteClient {
  let n = 0;
  return (w) =>
    new Proxy(w, {
      get(target, prop, recv) {
        const orig = Reflect.get(target, prop, recv) as unknown;
        if (prop !== tool || typeof orig !== 'function') return orig;
        return async (args: unknown) => {
          n += 1;
          if (n === nth) return { ok: false, error: 'timeout' };
          return (orig as (a: unknown) => Promise<unknown>).call(target, args);
        };
      },
    });
}

describe('editing-undo-1 (T-401): an EDITED retry of a create whose first attempt landed', () => {
  it('must not leave two events in the calendar', async () => {
    const r = await rig({ wrapWrite: landsThenTimesOut('createEvent') });
    const { item, action } = r.seedCreate({ slot: WED });
    const first = await r.click(action.id);
    expect(first).toMatchObject({ ok: true, value: { outcome: 'failed' } }); // unknown_outcome, the event DID land
    expect(r.repos.actions.byId(action.id)!.state).toBe('unknown_outcome');
    const clone = pendingOf(r, item.id, 'create_event')!;
    expect(clone).toBeDefined();
    // the user edits the time on the card and clicks "Add again" (same session, no restart, no reconcile in between)
    const again = await r.click(clone.id, {
      edit: { title: 'Dentist', startLocal: FRI.startLocal, endLocal: FRI.endLocal, location: '' },
    });
    expect(again).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const live = r.cal.storedEvents.filter((e) => e.status === 'confirmed' && e.priv.waAgent === '1');
    // T-401 / research 4.4: the edited retry of a found create must become an update_event of THAT event
    expect(live).toHaveLength(1);
  });
});

describe('editing-undo-2: an unedited "Apply again" after an update that landed but timed out', () => {
  it('asks a drift question about the app’s own write and then records a revision whose prev == next, so Undo never restores the original', async () => {
    const r = await rig({ wrapWrite: landsThenTimesOut('updateEvent') });
    const source = await r.createByClick({ slot: WED });
    const eventId = source.calendarEventId!;
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    const first = await r.click(d.action.id);
    expect(first).toMatchObject({ ok: true, value: { outcome: 'failed' } });
    expect(r.stored(eventId)).toMatchObject({ start: THU.startLocal }); // Google already holds the change
    const clone = pendingOf(r, d.item.id, 'update_event')!;
    const retry = await r.click(clone.id);
    // observed: needs_confirm_drift showing THU - the app's own landed write is presented as "changed in Google"
    expect(retry.ok && retry.value.outcome).toBe('needs_confirm_drift');
    const anyway = await r.click(clone.id, { confirmDrift: true });
    expect(anyway).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const rev = r.repos.eventRevisions.newestFor(eventId)!;
    // the revision that records the user's reschedule must remember WHAT it replaced (WED), or undo is impossible
    expect.soft(rev.prev?.startLocal).toBe(WED.startLocal);
    const undo = await r.exec.undoChange(d.item.id, rev.id, 'user', CTX);
    expect.soft(undo).toMatchObject({ ok: true, value: { outcome: "done" } });
    expect(r.stored(eventId)).toMatchObject({ start: WED.startLocal });
  });
});

describe('editing-undo-3: an undo whose PATCH timed out without landing', () => {
  it('can be retried (in-session and after the startup reconcile leaves it unknown)', async () => {
    const r = await rig({ wrapWrite: dropsThenTimesOut('updateEvent', 2) }); // call 1 = the reschedule, call 2 = the undo
    const source = await r.createByClick({ slot: WED });
    const eventId = source.calendarEventId!;
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    expect(await r.click(d.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const cand = r.repos.eventRevisions.undoCandidate(eventId)!;
    const u1 = await r.exec.undoChange(d.item.id, cand.id, 'user', CTX);
    expect(u1).toMatchObject({ ok: true, value: { outcome: 'failed' } });
    expect(r.stored(eventId)).toMatchObject({ start: THU.startLocal }); // nothing happened in Google
    // reconcile (startup) cannot find the undo applied: it stays unknown_outcome
    await reconcileUnknown({ repos: r.repos, bridgeDb: null, read: r.read, now: () => r.clock.now() as never, timeZone: () => 'Asia/Jerusalem' });
    // the Undo door is still shown for the same candidate (undoCandidate unchanged) ...
    expect(r.repos.eventRevisions.undoCandidate(eventId)!.id).toBe(cand.id);
    // ... and clicking it again must be possible
    const u2 = await r.exec.undoChange(d.item.id, cand.id, 'user', CTX);
    expect(u2).toEqual({ ok: true, value: expect.objectContaining({ outcome: "done" }) });
  });
});

describe('editing-undo-4: a refused undo leaves the card showing the restore target', () => {
  it('the holder card keeps the content Google actually has when the undo did not run', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const eventId = source.calendarEventId!;
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    expect(await r.click(d.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const cand = r.repos.eventRevisions.undoCandidate(eventId)!;
    r.flags.calendarConnected = false; // any click-time gate refusal (CAL_UNAVAILABLE, rate limit, conflict, drift ...)
    const u = await r.exec.undoChange(d.item.id, cand.id, 'user', CTX);
    expect(u).toEqual({ ok: false, error: { code: 'CAL_UNAVAILABLE' } });
    expect(r.stored(eventId)).toMatchObject({ start: THU.startLocal });
    // items.ts draws `event: proposal.event` of the CURRENT proposal on an in_calendar card
    const shown = r.repos.proposals.current(itemOf(r, d.item.id).id)!.event!;
    expect(shown.startLocal).toBe(THU.startLocal);
  });
});

describe('editing-undo-5 (B24 / F38): the found-but-edited create offers a correction the user can act on', () => {
  it('the pending update_event is exposed as a change (ChangeView) on the card', async () => {
    const { createItemService } = await import('../../../src/main/agent/items');
    const r = await rig({ wrapWrite: landsThenTimesOut('createEvent') });
    const { item, action } = r.seedCreate({ slot: WED });
    expect(await r.click(action.id)).toMatchObject({ ok: true, value: { outcome: 'failed' } });
    // the user edits the event in Google meanwhile (moves it one hour later)
    r.cal.userEditsInGoogle(r.cal.storedEvents[0]!.eventId, { start: '2026-10-07T16:00:00', end: '2026-10-07T17:00:00' });
    await reconcileUnknown({ repos: r.repos, bridgeDb: null, read: r.read, now: () => r.clock.now() as never, timeZone: () => 'Asia/Jerusalem' });
    const offer = pendingOf(r, item.id, 'update_event');
    expect(offer).toBeDefined(); // B24 did insert exactly the correction
    const noop = (): void => undefined;
    const svc = createItemService({
      repos: r.repos,
      settings: () => r.settings,
      clock: { now: () => r.clock.now() as never, setTimeout: () => 0, clearTimeout: noop },
      log: { info: noop, warn: noop, error: noop, debug: noop } as never,
      bridgeOnline: () => true,
      bridgeOutdated: () => false,
      calendarConnected: () => true,
      notifyChanged: noop,
      enqueueRetriage: noop,
      updatesAvailable: () => true,
    });
    const d = svc.detail(item.id as never);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.value.actions.some((a) => a.kind === 'update_event' && a.state === 'pending')).toBe(true);
    // ItemCard.tsx draws the Approve / Keep buttons of an update_event ONLY when eventState === 'change_proposed' && change !== null
    // side observation: the timeout's create retry clone is still pending => the in_calendar card also shows "Add to calendar"
    expect.soft(d.value.actions.filter((a) => a.kind === 'create_event' && a.state === 'pending')).toEqual([]);
    expect.soft(d.value.eventState).toBe('change_proposed');
    expect(d.value.change).not.toBeNull();
  });
});

describe('editing-undo-8: reconcile of an unknown update whose "Apply again" clone already landed', () => {
  it('does not throw and does not leave the original unknown_outcome', async () => {
    const r = await rig({ wrapWrite: dropsThenTimesOut('updateEvent', 1) }); // the first PATCH never reaches Google
    const source = await r.createByClick({ slot: WED });
    const eventId = source.calendarEventId!;
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    expect(await r.click(d.action.id)).toMatchObject({ ok: true, value: { outcome: 'failed' } });
    expect(r.repos.actions.byId(d.action.id)!.state).toBe('unknown_outcome');
    const clone = pendingOf(r, d.item.id, 'update_event')!;
    expect(await r.click(clone.id)).toMatchObject({ ok: true, value: { outcome: 'done' } }); // "Apply again" lands: rev 2
    expect(r.repos.eventRevisions.newestFor(eventId)!.revision).toBe(2);
    // next startup: the calendar-connected reconcile pass
    let thrown: unknown = null;
    try {
      await reconcileUnknown({ repos: r.repos, bridgeDb: null, read: r.read, now: () => r.clock.now() as never, timeZone: () => 'Asia/Jerusalem' });
    } catch (e) {
      thrown = e;
    }
    expect.soft(thrown).toBeNull(); // observed: UNIQUE constraint failed: event_revisions.calendar_event_id, event_revisions.revision
    expect(r.repos.actions.byId(d.action.id)!.state).not.toBe('unknown_outcome');
  });
});

describe('editing-undo-9: an event card whose reply was ALSO sent (create first, then send)', () => {
  it('stays an editable event of its chat', async () => {
    const { findExistingEvent } = await import('../../../src/main/agent/existingEvent');
    const r = await rig();
    const { item, action } = r.seedCreate({ slot: WED });
    const send = r.repos.actions.insertPending({
      itemId: item.id,
      proposalId: action.proposalId,
      chatId: item.chatId,
      payload: { v: 1, kind: 'send_reply', itemId: item.id, chatRef: item.chatId, proposalVersion: 1, text: 'See you then' },
      now: r.clock.now() as never,
    });
    expect(await r.click(action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(await r.click(send.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const it2 = itemOf(r, item.id);
    expect.soft({ state: it2.state, closedReason: it2.closedReason }).toEqual({ state: 'in_calendar', closedReason: null });
    expect(findExistingEvent(r.repos, item.chatId, r.clock.now() as never)).not.toBeNull();
  });
});
