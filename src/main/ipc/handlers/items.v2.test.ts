// T2 5 `ipc/handlers/items`: the four v2 item channels (C2 8). They carry an itemId (+ revisionId) only; main resolves the event
// from items.calendar_event_id, refuses a stale card before the executor is involved, and delegates to V2-W1-04's Undo with
// approved_by 'user'. The focus gate is register.ts's (register.test.ts). getImage is ItemService's (agent/items.v2.test.ts).
import { describe, expect, it, vi } from 'vitest';
import type { ApproveOutcome } from '../../../shared/ipc';
import type { EventRevisionRecord, ItemDetail } from '../../../shared/types';
import { fixtureItem, makeFixture, NOW_0 } from '../register.fixtures';
import type { ItemsHandlersV2 } from '../register';
import { createItemsHandlers } from './items';

const CTX = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };
const EVENT_ID = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6';
const OUTCOME: ApproveOutcome = { outcome: 'done', item: { itemId: 1 } as unknown as ItemDetail };

function rev(over: Partial<EventRevisionRecord> = {}): EventRevisionRecord {
  return {
    id: 7,
    calendarEventId: EVENT_ID,
    itemId: 1,
    revision: 2,
    kind: 'reschedule',
    prev: null,
    next: null,
    actionId: '22222222-2222-4222-8222-222222222222',
    appliedAt: NOW_0,
    revertedBy: null,
    postEtag: null,
    postUpdated: null,
    ...over,
  };
}

function setup(
  opts: { candidate?: EventRevisionRecord | null; autoSpan?: EventRevisionRecord[]; wired?: boolean } = {},
) {
  const f = makeFixture();
  f.state.items.set(1, fixtureItem({ id: 1, calendarEventId: EVENT_ID, eventState: 'updated' }));
  const undoCandidate = vi.fn(() => (opts.candidate === undefined ? rev() : opts.candidate));
  const unrevertedAutoSpan = vi.fn(() => opts.autoSpan ?? [rev({ id: 5 }), rev({ id: 7 })]);
  (f.deps.repos as unknown as Record<string, unknown>).eventRevisions = { undoCandidate, unrevertedAutoSpan };
  const undo = {
    undoChange: vi.fn(async () => ({ ok: true as const, value: OUTCOME })),
    restoreOriginal: vi.fn(async () => ({ ok: true as const, value: OUTCOME })),
    cancelEvent: vi.fn(async () => ({ ok: true as const, value: OUTCOME })),
  };
  const v2: ItemsHandlersV2 | undefined = opts.wired === false ? undefined : { undo };
  return { f, h: createItemsHandlers(f.deps, v2), undo, undoCandidate, unrevertedAutoSpan };
}

describe('item:undoChange', () => {
  it('delegates the event undo candidate to Undo.undoChange(itemId, revisionId, "user") and returns its outcome', async () => {
    const { h, undo, undoCandidate } = setup();
    expect(await h['item:undoChange']({ itemId: 1, revisionId: 7 }, CTX)).toEqual({ ok: true, value: OUTCOME });
    expect(undoCandidate).toHaveBeenCalledWith(EVENT_ID);
    expect(undo.undoChange).toHaveBeenCalledWith(1, 7, 'user');
  });

  it('a revision that is not the event undo candidate is ACTION_STALE with no undo call', async () => {
    for (const candidate of [null, rev({ id: 8 })]) {
      const { f, h, undo } = setup({ candidate });
      expect(await h['item:undoChange']({ itemId: 1, revisionId: 7 }, CTX)).toEqual({
        ok: false,
        error: { code: 'ACTION_STALE' },
      });
      expect(undo.undoChange).not.toHaveBeenCalled();
      expect(f.rec.audits).toEqual([
        { kind: 'ipc_rejected', ref: 'item:undoChange', detail: { itemId: 1, reason: 'ACTION_STALE' }, now: NOW_0 },
      ]);
    }
  });

  it('W1-04: after a change chain the candidate may belong to an OLDER card of the event - the carrying card is still a door', async () => {
    const { f, h, undo, undoCandidate } = setup({ candidate: rev({ itemId: 2 }) });
    expect(await h['item:undoChange']({ itemId: 1, revisionId: 7 }, CTX)).toEqual({ ok: true, value: OUTCOME });
    expect(undoCandidate).toHaveBeenCalledWith(EVENT_ID); // looked up by the door's OWN event: it carries this event
    expect(undo.undoChange).toHaveBeenCalledWith(1, 7, 'user'); // the executor resolves the current holder itself
    expect(f.rec.audits).toEqual([]);
  });

  it('an unknown item is NOT_FOUND; an item without an event is ACTION_STALE', async () => {
    const { f, h, undo } = setup();
    expect(await h['item:undoChange']({ itemId: 9, revisionId: 7 }, CTX)).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    f.state.items.set(1, fixtureItem({ id: 1, calendarEventId: null }));
    expect(await h['item:undoChange']({ itemId: 1, revisionId: 7 }, CTX)).toEqual({
      ok: false,
      error: { code: 'ACTION_STALE' },
    });
    expect(undo.undoChange).not.toHaveBeenCalled();
  });

  it('without the Undo collaborator it fails closed (INTERNAL), never pretends', async () => {
    const { f, h } = setup({ wired: false });
    expect(await h['item:undoChange']({ itemId: 1, revisionId: 7 }, CTX)).toEqual({
      ok: false,
      error: { code: 'INTERNAL' },
    });
    expect(f.rec.logs).toContainEqual({
      level: 'error',
      event: 'ipc_v2_unwired',
      meta: { channel: 'item:undoChange' },
    });
  });

  it('an Undo refusal travels back unchanged', async () => {
    const { h, undo } = setup();
    undo.undoChange.mockResolvedValueOnce({ ok: false, error: { code: 'ACTION_EXPIRED' } } as never);
    expect(await h['item:undoChange']({ itemId: 1, revisionId: 7 }, CTX)).toEqual({
      ok: false,
      error: { code: 'ACTION_EXPIRED' },
    });
  });
});

describe('item:restoreOriginal (F1)', () => {
  it('delegates when the event has an un-reverted automatic span', async () => {
    const { h, undo, unrevertedAutoSpan } = setup();
    expect(await h['item:restoreOriginal']({ itemId: 1 }, CTX)).toEqual({ ok: true, value: OUTCOME });
    expect(unrevertedAutoSpan).toHaveBeenCalledWith(EVENT_ID);
    expect(undo.restoreOriginal).toHaveBeenCalledWith(1);
  });

  it('no automatic span / no event / unknown item / not wired => refused before Undo', async () => {
    const empty = setup({ autoSpan: [] });
    expect(await empty.h['item:restoreOriginal']({ itemId: 1 }, CTX)).toEqual({
      ok: false,
      error: { code: 'ACTION_STALE' },
    });
    expect(empty.undo.restoreOriginal).not.toHaveBeenCalled();
    const s = setup();
    expect(await s.h['item:restoreOriginal']({ itemId: 3 }, CTX)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
    s.f.state.items.set(1, fixtureItem({ id: 1, calendarEventId: null }));
    expect(await s.h['item:restoreOriginal']({ itemId: 1 }, CTX)).toEqual({
      ok: false,
      error: { code: 'ACTION_STALE' },
    });
    const unwired = setup({ wired: false });
    expect(await unwired.h['item:restoreOriginal']({ itemId: 1 }, CTX)).toEqual({
      ok: false,
      error: { code: 'INTERNAL' },
    });
  });
});

describe('item:cancelEvent (F32)', () => {
  it('delegates for a live editable event (created / updated)', async () => {
    for (const eventState of ['created', 'updated'] as const) {
      const { f, h, undo } = setup();
      f.state.items.set(1, fixtureItem({ id: 1, calendarEventId: EVENT_ID, eventState }));
      expect(await h['item:cancelEvent']({ itemId: 1 }, CTX)).toEqual({ ok: true, value: OUTCOME });
      expect(undo.cancelEvent).toHaveBeenCalledWith(1);
    }
  });

  it('a cancelled / proposed / closed / event-less item is ACTION_STALE; unknown is NOT_FOUND; unwired is INTERNAL', async () => {
    for (const over of [
      { eventState: 'cancelled' as const },
      { eventState: 'proposed' as const },
      { closedReason: 'superseded' as const },
      { calendarEventId: null },
    ]) {
      const { f, h, undo } = setup();
      f.state.items.set(1, fixtureItem({ id: 1, calendarEventId: EVENT_ID, eventState: 'updated', ...over }));
      expect(await h['item:cancelEvent']({ itemId: 1 }, CTX), JSON.stringify(over)).toEqual({
        ok: false,
        error: { code: 'ACTION_STALE' },
      });
      expect(undo.cancelEvent).not.toHaveBeenCalled();
    }
    const s = setup();
    expect(await s.h['item:cancelEvent']({ itemId: 5 }, CTX)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
    const unwired = setup({ wired: false });
    expect(await unwired.h['item:cancelEvent']({ itemId: 1 }, CTX)).toEqual({ ok: false, error: { code: 'INTERNAL' } });
  });
});

describe('item:getImage', () => {
  it('delegates to ItemService.getImage with the item id only', async () => {
    const f = makeFixture();
    const getImage = vi.fn(() => ({ ok: true as const, value: { dataUrl: 'data:image/jpeg;base64,AA' } }));
    f.deps.items.getImage = getImage;
    expect(await createItemsHandlers(f.deps)['item:getImage']({ itemId: 3 }, CTX)).toEqual({
      ok: true,
      value: { dataUrl: 'data:image/jpeg;base64,AA' },
    });
    expect(getImage).toHaveBeenCalledWith(3);
  });
});

describe('chat:setPolicy {autoPolicy}', () => {
  it('passes the autoPolicy member to ItemService unchanged', async () => {
    const f = makeFixture();
    const setChatPolicy = vi.fn(() => ({ ok: true as const, value: { chatRef: 2 } as never }));
    f.deps.items.setChatPolicy = setChatPolicy;
    await createItemsHandlers(f.deps)['chat:setPolicy']({ chatRef: 2, autoPolicy: 'never' }, CTX);
    expect(setChatPolicy).toHaveBeenCalledWith({ chatRef: 2, autoPolicy: 'never' });
  });
});
