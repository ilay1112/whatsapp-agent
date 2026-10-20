// src/main/mcp/calendarEvents.test.ts - [V4] T-908 group C (handover §2.4): CalendarEventsService.
// The visible week (Sunday-first for he), one list-events per calendar, cache (calendarId, weekStartMs) for 5 min, invalidate(),
// partial failure (review focus 5: a 403 calendar leaves the others visible and is named once in `failed`), `writable` from the
// stored roles, unknown calendar ids never reach the wire, transport-level failures map to a Result error.
import { describe, expect, it, vi } from 'vitest';
import { localToEpochMs } from '../../shared/when';
import type { CalendarAccessRole, Lang } from '../../shared/types';
import type { ListWindow, ListedEventProjection, McpCalendarListClient, McpResult } from './readClient';
import { CALENDAR_EVENTS_TTL_MS, createCalendarEventsService, foreignEventKeyOf } from './calendarEvents';
import { eventKeyOf } from '../agent/items';

const TZ = 'Asia/Jerusalem';
const at = (local: string): number => localToEpochMs(local, TZ);
/** Wednesday 2026-10-14 noon: he week = Sun 11 .. Sat 17 Oct. */
const ANCHOR = at('2026-10-14T12:00:00');

const ev = (eventId: string, over: Partial<ListedEventProjection> = {}): ListedEventProjection => ({
  eventId,
  startLocal: '2026-10-13T10:00:00',
  endLocal: '2026-10-13T11:00:00',
  allDay: false,
  title: `title ${eventId}`,
  attendees: 0,
  recurring: false,
  ownedByApp: false,
  fromChat: false,
  location: '',
  ...over,
});

type Answer = McpResult<ListedEventProjection[]>;
function setup(
  opts: {
    answers?: Record<string, Answer | (() => Promise<Answer>)>;
    roles?: Record<string, CalendarAccessRole>;
    lang?: Lang;
    connected?: boolean;
  } = {},
) {
  let now = at('2026-10-14T09:00:00');
  const calls: Array<{ calendarId: string; w: ListWindow }> = [];
  const answers = opts.answers ?? {};
  const list: McpCalendarListClient = {
    listEventsInWindow: vi.fn(async (calendarId: string, w: ListWindow) => {
      calls.push({ calendarId, w });
      const a = answers[calendarId] ?? { ok: true, value: [] };
      return typeof a === 'function' ? a() : a;
    }),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  const svc = createCalendarEventsService({
    list,
    roles: () => opts.roles ?? { primary: 'owner', 'work@x.test': 'writer', 'shared@x.test': 'reader' },
    timeZone: () => TZ,
    lang: () => opts.lang ?? 'he',
    connected: () => opts.connected ?? true,
    clock: { now: () => now },
    log,
  });
  return { svc, calls, log, advance: (ms: number) => (now += ms), nowMs: () => now };
}

describe('CalendarEventsService.listEvents', () => {
  it('reads the visible week (he: Sunday first) of each calendar and projects ForeignEventView with roles', async () => {
    const { svc, calls, nowMs } = setup({
      answers: {
        primary: { ok: true, value: [ev('aaa111', { ownedByApp: true })] },
        'work@x.test': { ok: true, value: [ev('bbb222', { attendees: 2, recurring: true })] },
        'shared@x.test': { ok: true, value: [ev('ccc333', { allDay: true })] },
      },
    });
    const res = await svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary', 'work@x.test', 'shared@x.test'] });
    expect(calls.map((c) => c.calendarId)).toEqual(['primary', 'work@x.test', 'shared@x.test']);
    expect(calls[0]!.w).toEqual({
      timeMinLocal: '2026-10-11T00:00:00',
      timeMaxLocal: '2026-10-18T00:00:00',
      timeZone: TZ,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.weekStartMs).toBe(at('2026-10-11T00:00:00'));
    expect(res.value.fetchedAt).toBe(nowMs());
    expect(res.value.failed).toEqual([]);
    expect(res.value.events).toEqual([
      {
        calendarId: 'primary',
        title: 'title aaa111',
        startLocal: '2026-10-13T10:00:00',
        endLocal: '2026-10-13T11:00:00',
        allDay: false,
        attendees: 0,
        recurring: false,
        ownedByApp: true,
        fromChat: false,
        location: '',
        writable: true,
        eventKey: eventKeyOf('aaa111'),
        undoActionId: null,
      },
      expect.objectContaining({
        eventKey: eventKeyOf('bbb222'),
        calendarId: 'work@x.test',
        attendees: 2,
        recurring: true,
        writable: true,
      }),
      expect.objectContaining({
        eventKey: eventKeyOf('ccc333'),
        calendarId: 'shared@x.test',
        allDay: true,
        writable: false,
      }),
    ]);
  });

  it('en follows the locale week (Monday when weekInfo says so) - same rule as the renderer', async () => {
    const { svc, calls } = setup({ lang: 'en' });
    await svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary'] });
    const { firstDayFor } = await import('../../shared/week');
    expect(calls[0]!.w.timeMinLocal).toBe(firstDayFor('en') === 1 ? '2026-10-12T00:00:00' : '2026-10-11T00:00:00');
  });

  it('review focus 5: a calendar that errors (403) is named once in failed; the others still return', async () => {
    const { svc, log } = setup({
      answers: {
        primary: { ok: true, value: [ev('aaa111')] },
        'shared@x.test': { ok: false, error: 'bad_response' },
      },
    });
    const res = await svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary', 'shared@x.test'] });
    expect(res.ok && res.value.failed).toEqual(['shared@x.test']);
    expect(res.ok && res.value.events.map((e) => e.eventKey)).toEqual(['aaa111'].map(eventKeyOf));
    // logs carry a hash of the calendar id, never the id or a title
    const meta = JSON.stringify(log.warn.mock.calls);
    expect(meta).not.toContain('shared@x.test');
    expect(meta).toMatch(/calendarSha8/);
  });

  it('a failed calendar is not cached: the next read asks again', async () => {
    let n = 0;
    const { svc, calls } = setup({
      answers: {
        'shared@x.test': async () =>
          ++n === 1 ? { ok: false, error: 'bad_response' } : { ok: true, value: [ev('ddd444')] },
      },
    });
    await svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['shared@x.test'] });
    const res = await svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['shared@x.test'] });
    expect(calls).toHaveLength(2);
    expect(res.ok && res.value.failed).toEqual([]);
  });

  it('caches per (calendarId, weekStartMs) for 5 min; another week or an expired entry reads again', async () => {
    const { svc, calls, advance } = setup({ answers: { primary: { ok: true, value: [ev('aaa111')] } } });
    await svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary'] });
    await svc.listEvents({ anchorMs: at('2026-10-17T23:00:00'), calendarIds: ['primary', 'work@x.test'] });
    expect(calls.map((c) => c.calendarId)).toEqual(['primary', 'work@x.test']);
    await svc.listEvents({ anchorMs: at('2026-10-21T12:00:00'), calendarIds: ['primary'] });
    expect(calls).toHaveLength(3);
    advance(CALENDAR_EVENTS_TTL_MS - 1);
    await svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary'] });
    expect(calls).toHaveLength(3);
    advance(2);
    await svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary'] });
    expect(calls).toHaveLength(4);
    expect(CALENDAR_EVENTS_TTL_MS).toBe(5 * 60_000);
  });

  it('invalidate() clears the cache; a read in flight during invalidate() is not cached', async () => {
    let release: (a: Answer) => void = () => undefined;
    let first = true;
    const { svc, calls } = setup({
      answers: {
        primary: () =>
          first
            ? ((first = false), new Promise<Answer>((r) => (release = r)))
            : Promise.resolve({ ok: true, value: [ev('new111')] } as Answer),
      },
    });
    const pending = svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary'] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    svc.invalidate();
    release({ ok: true, value: [ev('old111')] });
    expect((await pending).ok).toBe(true);
    const res = await svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary'] });
    expect(calls).toHaveLength(2);
    expect(res.ok && res.value.events.map((e) => e.eventKey)).toEqual(['new111'].map(eventKeyOf));
    svc.invalidate();
    await svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary'] });
    expect(calls).toHaveLength(3);
  });

  it('two concurrent reads of the same calendar + week share one list-events', async () => {
    const { svc, calls } = setup({ answers: { primary: { ok: true, value: [ev('aaa111')] } } });
    const [a, b] = await Promise.all([
      svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary'] }),
      svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary'] }),
    ]);
    expect(calls).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it('an id that is not in the last list-calendars answer (nor primary) never reaches the wire and is reported failed', async () => {
    const { svc, calls } = setup({ roles: { 'work@x.test': 'owner' } });
    const res = await svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary', 'evil@x.test', 'work@x.test'] });
    expect(calls.map((c) => c.calendarId)).toEqual(['primary', 'work@x.test']);
    expect(res.ok && res.value.failed).toEqual(['evil@x.test']);
    // 'primary' without a stored role is read but never writable (fail closed)
    const { svc: svc2 } = setup({ roles: {}, answers: { primary: { ok: true, value: [ev('aaa111')] } } });
    const r2 = await svc2.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary'] });
    expect(r2.ok && r2.value.events[0]!.writable).toBe(false);
  });

  it('duplicate ids are read once', async () => {
    const { svc, calls } = setup();
    await svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary', 'primary'] });
    expect(calls).toHaveLength(1);
  });

  it('calendar not connected -> CAL_UNAVAILABLE without a call', async () => {
    const { svc, calls } = setup({ connected: false });
    expect(await svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary'] })).toEqual({
      ok: false,
      error: { code: 'CAL_UNAVAILABLE' },
    });
    expect(calls).toEqual([]);
  });

  it('an auth failure on any calendar -> CAL_RECONNECT; every calendar unreachable -> CAL_UNAVAILABLE', async () => {
    const auth = setup({
      answers: { primary: { ok: true, value: [] }, 'work@x.test': { ok: false, error: 'auth' } },
    });
    expect(await auth.svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary', 'work@x.test'] })).toEqual({
      ok: false,
      error: { code: 'CAL_RECONNECT' },
    });
    const down = setup({
      answers: { primary: { ok: false, error: 'unavailable' }, 'work@x.test': { ok: false, error: 'timeout' } },
    });
    expect(await down.svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary', 'work@x.test'] })).toEqual({
      ok: false,
      error: { code: 'CAL_UNAVAILABLE' },
    });
    // one unreachable among working ones is a partial failure, not an error
    const partial = setup({ answers: { primary: { ok: false, error: 'timeout' } } });
    const p = await partial.svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary', 'work@x.test'] });
    expect(p.ok && p.value.failed).toEqual(['primary']);
  });

  it('a thrown read is a failed calendar, never a thrown IPC', async () => {
    const { svc } = setup({ answers: { primary: () => Promise.reject(new Error('boom')) } });
    const res = await svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary', 'work@x.test'] });
    expect(res.ok && res.value.failed).toEqual(['primary']);
    // a synchronous throw too, and it does not stick: the next read asks again
    let calls = 0;
    const sync = createCalendarEventsService({
      list: {
        listEventsInWindow: (() => {
          calls += 1;
          throw new Error('sync');
        }) as McpCalendarListClient['listEventsInWindow'],
      },
      roles: () => ({ primary: 'owner' }),
      timeZone: () => TZ,
      lang: () => 'he',
      connected: () => true,
      clock: { now: () => 0 },
      log: { warn: () => undefined },
    });
    const r1 = await sync.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary', 'x'] });
    await sync.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary'] });
    expect(r1.ok && r1.value.failed).toEqual(['x', 'primary']);
    expect(calls).toBe(2);
  });

  it('events are sorted by start, then calendar order', async () => {
    const { svc } = setup({
      answers: {
        primary: {
          ok: true,
          value: [ev('late01', { startLocal: '2026-10-15T09:00:00', endLocal: '2026-10-15T10:00:00' })],
        },
        'work@x.test': {
          ok: true,
          value: [ev('early1', { startLocal: '2026-10-12T09:00:00', endLocal: '2026-10-12T10:00:00' })],
        },
      },
    });
    const res = await svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary', 'work@x.test'] });
    expect(res.ok && res.value.events.map((e) => e.eventKey)).toEqual(['early1', 'late01'].map(eventKeyOf));
  });
});

describe('foreignEventKeyOf', () => {
  it('is the same opaque key as ItemCard.calendar.eventKey (agent/items eventKeyOf)', () => {
    for (const id of ['abc123def', 'x'.repeat(200)]) expect(foreignEventKeyOf(id)).toBe(eventKeyOf(id));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [v4 T6] ARCH-v2 10: no Google event id crosses IPC - the view carries the opaque eventKey, main resolves it from the cache
// ---------------------------------------------------------------------------------------------------------------------
describe('[v4 T6] opaque keys + resolve', () => {
  it('a ForeignEventView has no eventId field; resolve(calendarId, eventKey) maps back from the live week cache only', async () => {
    const { svc, advance } = setup({
      answers: {
        primary: { ok: true, value: [ev('aaa111', { allDay: false })] },
        'work@x.test': { ok: true, value: [ev('bbb222', { allDay: true })] },
      },
    });
    expect(svc.resolve('primary', eventKeyOf('aaa111'))).toBeNull(); // nothing read yet
    const res = await svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary', 'work@x.test'] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const e of res.value.events) expect(e).not.toHaveProperty('eventId');
    // (the helper's title happens to repeat the id; the id itself is in no field)
    expect(res.value.events.map((e) => Object.keys(e)).flat()).not.toContain('eventId');
    expect(svc.resolve('primary', eventKeyOf('aaa111'))).toEqual({ eventId: 'aaa111', allDay: false });
    expect(svc.resolve('work@x.test', eventKeyOf('bbb222'))).toEqual({ eventId: 'bbb222', allDay: true });
    // the key is per calendar: the same key under another calendar does not resolve
    expect(svc.resolve('work@x.test', eventKeyOf('aaa111'))).toBeNull();
    // expired / invalidated => gone (the propose answers CAL_EVENT_GONE and the view re-reads)
    advance(5 * 60_000);
    expect(svc.resolve('primary', eventKeyOf('aaa111'))).toBeNull();
    await svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary'] });
    expect(svc.resolve('primary', eventKeyOf('aaa111'))).not.toBeNull();
    svc.invalidate();
    expect(svc.resolve('primary', eventKeyOf('aaa111'))).toBeNull();
  });

  it('undoActionId comes from the injected main-side lookup (never cached), fromChat from the projection', async () => {
    const lookups: string[] = [];
    const svc = createCalendarEventsService({
      list: { listEventsInWindow: async () => ({ ok: true, value: [ev('aaa111', { fromChat: true }), ev('bbb222')] }) },
      roles: () => ({ primary: 'owner' }),
      timeZone: () => TZ,
      lang: () => 'he',
      connected: () => true,
      clock: { now: () => ANCHOR },
      log: { warn: () => undefined },
      undoableFor: (id) => {
        lookups.push(id);
        return id === 'bbb222' ? '11111111-1111-4111-8111-111111111111' : null;
      },
    });
    const res = await svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary'] });
    expect(res.ok && res.value.events.map((e) => [e.fromChat, e.undoActionId])).toEqual([
      [true, null],
      [false, '11111111-1111-4111-8111-111111111111'],
    ]);
    await svc.listEvents({ anchorMs: ANCHOR, calendarIds: ['primary'] });
    expect(lookups).toEqual(['aaa111', 'bbb222', 'aaa111', 'bbb222']);
  });
});
