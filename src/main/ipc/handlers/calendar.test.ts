// src/main/ipc/handlers/calendar.test.ts - [V4] T-908 group C: calendar:listEvents / calendar:invalidate.
import { describe, expect, it, vi } from 'vitest';
import { IPC_REQUEST_SCHEMAS } from '../../../shared/ipc';
import type { CalendarEventsService } from '../../mcp/calendarEvents';
import { createCalendarHandlers } from './calendar';

const CTX = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };
const RES = { weekStartMs: 1, events: [], fetchedAt: 2, failed: ['x'] };

function setup(
  listEvents: CalendarEventsService['listEvents'] = vi.fn(async () => ({ ok: true as const, value: RES })),
) {
  const svc = { listEvents: vi.fn(listEvents), invalidate: vi.fn(), resolve: vi.fn(() => null) };
  return { svc, h: createCalendarHandlers({ calendarEvents: svc }) };
}

describe('calendar:listEvents', () => {
  it('passes anchor + ids to the service and returns its answer', async () => {
    const { svc, h } = setup();
    expect(await h['calendar:listEvents']({ anchorMs: 5, calendarIds: ['primary'] }, CTX)).toEqual({
      ok: true,
      value: RES,
    });
    expect(svc.listEvents).toHaveBeenCalledWith({ anchorMs: 5, calendarIds: ['primary'] });
  });

  it('a thrown service is CAL_UNAVAILABLE, never a thrown IPC', async () => {
    const { h } = setup(async () => {
      throw new Error('boom');
    });
    expect(await h['calendar:listEvents']({ anchorMs: 5, calendarIds: ['primary'] }, CTX)).toEqual({
      ok: false,
      error: { code: 'CAL_UNAVAILABLE' },
    });
  });

  it('the request schema: 1..10 ids, non-negative integer anchor, nothing else', () => {
    const s = IPC_REQUEST_SCHEMAS['calendar:listEvents'];
    expect(s.safeParse({ anchorMs: 0, calendarIds: ['primary'] }).success).toBe(true);
    expect(s.safeParse({ anchorMs: 0, calendarIds: [] }).success).toBe(false);
    expect(s.safeParse({ anchorMs: 0, calendarIds: Array.from({ length: 11 }, (_, i) => `c${i}`) }).success).toBe(
      false,
    );
    expect(s.safeParse({ anchorMs: -1, calendarIds: ['primary'] }).success).toBe(false);
    expect(s.safeParse({ anchorMs: 1.5, calendarIds: ['primary'] }).success).toBe(false);
    expect(s.safeParse({ anchorMs: 0, calendarIds: [''] }).success).toBe(false);
    expect(s.safeParse({ anchorMs: 0, calendarIds: ['primary'], extra: 1 }).success).toBe(false);
    expect(IPC_REQUEST_SCHEMAS['calendar:invalidate'].safeParse(undefined).success).toBe(true);
  });
});

describe('without a service', () => {
  it('listEvents fails closed, invalidate is a no-op', async () => {
    const h = createCalendarHandlers({});
    expect(await h['calendar:listEvents']({ anchorMs: 5, calendarIds: ['primary'] }, CTX)).toEqual({
      ok: false,
      error: { code: 'CAL_UNAVAILABLE' },
    });
    expect(await h['calendar:invalidate'](undefined, CTX)).toEqual({ ok: true, value: null });
  });
});

describe('calendar:invalidate', () => {
  it('empties the service cache', async () => {
    const { svc, h } = setup();
    expect(await h['calendar:invalidate'](undefined, CTX)).toEqual({ ok: true, value: null });
    expect(svc.invalidate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [v4 T6] propose* (pending only) and action:undo
// ---------------------------------------------------------------------------------------------------------------------
describe('[v4 T6] calendar:propose* and action:undo', () => {
  const PROPOSAL = {
    actionId: '11111111-1111-4111-8111-111111111111',
    kind: 'delete_event' as const,
    shownHash: 'a'.repeat(64),
    summary: { op: 'delete' as const, calendarId: 'primary', before: null, after: null },
  };
  const proposals = () => ({
    proposeCreate: vi.fn(async () => ({ ok: true as const, value: { ...PROPOSAL, kind: 'create_event' as const } })),
    proposeEdit: vi.fn(async () => ({ ok: true as const, value: { ...PROPOSAL, kind: 'update_event' as const } })),
    proposeDelete: vi.fn(async () => ({ ok: true as const, value: PROPOSAL })),
  });

  it('the request schemas take an opaque 16-hex eventKey (never an event id) and a non-empty patch', () => {
    const del = IPC_REQUEST_SCHEMAS['calendar:proposeDelete'];
    expect(del.safeParse({ calendarId: 'primary', eventKey: '0123456789abcdef' }).success).toBe(true);
    expect(del.safeParse({ calendarId: 'primary', eventId: 'v4plain001' }).success).toBe(false);
    expect(del.safeParse({ calendarId: 'primary', eventKey: 'v4plain001' }).success).toBe(false);
    const edit = IPC_REQUEST_SCHEMAS['calendar:proposeEdit'];
    expect(edit.safeParse({ calendarId: 'primary', eventKey: '0123456789abcdef', patch: {} }).success).toBe(false);
    expect(
      edit.safeParse({
        calendarId: 'primary',
        eventKey: '0123456789abcdef',
        patch: { title: 'x', status: 'cancelled' },
      }).success,
    ).toBe(false);
  });

  it('propose* delegate to the proposal service only (pending actions; this module has no write capability)', async () => {
    const p = proposals();
    const h = createCalendarHandlers({ proposals: p });
    expect(await h['calendar:proposeDelete']({ calendarId: 'primary', eventKey: '0123456789abcdef' }, CTX)).toEqual({
      ok: true,
      value: PROPOSAL,
    });
    await h['calendar:proposeEdit'](
      { calendarId: 'primary', eventKey: '0123456789abcdef', patch: { title: 'N' } },
      CTX,
    );
    await h['calendar:proposeCreate'](
      {
        calendarId: 'primary',
        title: 'T',
        startLocal: '2026-10-07T10:00:00',
        endLocal: '2026-10-07T11:00:00',
        location: '',
      },
      CTX,
    );
    expect(p.proposeDelete).toHaveBeenCalledWith({ calendarId: 'primary', eventKey: '0123456789abcdef' });
    expect(p.proposeEdit).toHaveBeenCalledWith({
      calendarId: 'primary',
      eventKey: '0123456789abcdef',
      patch: { title: 'N' },
    });
    expect(p.proposeCreate).toHaveBeenCalledTimes(1);
  });

  it('fail closed: no service => CAL_UNAVAILABLE; a throwing service => CAL_UNAVAILABLE', async () => {
    const h = createCalendarHandlers({});
    expect(await h['calendar:proposeDelete']({ calendarId: 'primary', eventKey: '0123456789abcdef' }, CTX)).toEqual({
      ok: false,
      error: { code: 'CAL_UNAVAILABLE' },
    });
    const t = createCalendarHandlers({
      proposals: { ...proposals(), proposeDelete: vi.fn(async () => Promise.reject(new Error('boom'))) },
    });
    expect(await t['calendar:proposeDelete']({ calendarId: 'primary', eventKey: '0123456789abcdef' }, CTX)).toEqual({
      ok: false,
      error: { code: 'CAL_UNAVAILABLE' },
    });
  });

  it('action:undo: only from a focused visible window; delegates to undoManual; absent => INTERNAL', async () => {
    const undoManual = vi.fn(async () => ({
      ok: true as const,
      value: {
        outcome: 'done' as const,
        item: null,
        manual: {
          actionId: PROPOSAL.actionId,
          op: 'undo' as const,
          calendarId: 'primary',
          undoable: false,
          errorCode: null,
        },
      },
    }));
    const audit = vi.fn();
    const h = createCalendarHandlers({ undoManual, audit });
    const req = { actionId: PROPOSAL.actionId };
    expect(await h['action:undo'](req, { ...CTX, windowFocused: false })).toEqual({
      ok: false,
      error: { code: 'WINDOW_NOT_FOCUSED' },
    });
    expect(audit).toHaveBeenCalledWith('action:undo');
    expect(undoManual).not.toHaveBeenCalled();
    expect(await h['action:undo'](req, CTX)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(undoManual).toHaveBeenCalledWith(PROPOSAL.actionId, CTX);
    expect(await createCalendarHandlers({})['action:undo'](req, CTX)).toEqual({
      ok: false,
      error: { code: 'INTERNAL' },
    });
  });
});
