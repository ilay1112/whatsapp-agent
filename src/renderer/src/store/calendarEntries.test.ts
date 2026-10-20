// v3 dashboard (T-904, handover §2.2 / §2.3; Tasks 2-3): the schedule-only filter predicate and the week-calendar selectors.
import { describe, expect, it } from 'vitest';
import type { ChangeView, EventContentView, ForeignEventView, ItemCard } from '@shared/types';
import type { DashboardStore } from './dashboard';
import { localToEpochMs } from '@shared/when';
import {
  CAL_HUES,
  SCHEDULE_INTENTS,
  calendarHueOf,
  foreignEntryOf,
  hash8,
  isForeignEntry,
  manageRefusals,
  mergeForeignEntries,
  clipToDay,
  hiddenCount,
  isScheduleRelated,
  layoutLanes,
  selectCalendarEntries,
  visibleItems,
  type CalendarEntry,
} from './calendarEntries';
import { defaultCard } from '../../../../tests/setup-renderer';
import * as week from '@shared/week';
import * as store from './calendarEntries';

const TZ = 'Asia/Jerusalem';

const card = (patch: Partial<ItemCard>): ItemCard => ({ ...structuredClone(defaultCard), ...patch });

/** A finished analysis with no event-like content: the only shape the filter hides. */
const chatter = (patch: Partial<ItemCard> = {}): ItemCard =>
  card({ intent: 'smalltalk', event: null, change: null, eventState: 'none', ...patch });

/** A Change card's view (`from` = the event as it is, `to` = the proposed slot). */
const changeTo = (startLocal: string, endLocal: string, title = 'Coffee'): ChangeView => {
  const base: EventContentView = {
    title,
    startLocal: '2026-10-20T09:00:00',
    endLocal: '2026-10-20T10:00:00',
    timeZone: TZ,
    location: '',
    status: 'confirmed',
  };
  return { kind: 'reschedule', from: base, to: { ...base, startLocal, endLocal }, confidence: 'high', baseRevision: 1 };
};

const lists = (needs: ItemCard[], cal: ItemCard[] = [], missing: ItemCard[] = []): DashboardStore['lists'] => ({
  needs_reply: { items: needs, count: needs.length },
  in_calendar: { items: cal, count: cal.length },
  info_missing: { items: missing, count: missing.length },
});

describe('SCHEDULE_INTENTS', () => {
  it('holds exactly the four scheduling intents', () => {
    expect([...SCHEDULE_INTENTS].sort()).toEqual(['cancel', 'confirmation', 'reschedule', 'schedule_request']);
  });
});

describe('isScheduleRelated (§2.2 predicate)', () => {
  it.each(['queued', 'running', 'held', 'failed'] as const)('keeps a card whose analysis is %s', (analysis) => {
    expect(isScheduleRelated(chatter({ analysis }))).toBe(true);
  });

  it('keeps a card with no intent yet', () => {
    expect(isScheduleRelated(chatter({ intent: null }))).toBe(true);
  });

  it('hides a finished smalltalk card with nothing event-like', () => {
    expect(isScheduleRelated(chatter())).toBe(false);
  });

  it.each(['question', 'other'] as const)('hides a finished %s card with nothing event-like', (intent) => {
    expect(isScheduleRelated(chatter({ intent }))).toBe(false);
  });

  it('keeps smalltalk when an event is set', () => {
    expect(isScheduleRelated(chatter({ event: defaultCard.event }))).toBe(true);
  });

  it('keeps a question when a change is set', () => {
    const change = changeTo('2026-10-21T17:00:00', '2026-10-21T18:00:00');
    expect(isScheduleRelated(chatter({ intent: 'question', change }))).toBe(true);
  });

  it('keeps smalltalk whose eventState is not none', () => {
    expect(isScheduleRelated(chatter({ eventState: 'incomplete' }))).toBe(true);
  });

  it.each(['schedule_request', 'reschedule', 'cancel', 'confirmation'] as const)('keeps %s', (intent) => {
    expect(isScheduleRelated(chatter({ intent }))).toBe(true);
  });

  // Fix pass: a manipulation flag is a security signal the user must see (e2e pictures.spec injection picture).
  it.each(['smalltalk', 'other', 'question'] as const)('keeps a finished %s card flagged manipulation', (intent) => {
    expect(isScheduleRelated(chatter({ intent, badges: ['manipulation'] }))).toBe(true);
  });

  it('still hides chatter whose badges carry no manipulation flag', () => {
    expect(isScheduleRelated(chatter({ badges: ['time_assumed'] }))).toBe(false);
  });
});

describe('visibleItems / hiddenCount', () => {
  const a = card({ itemId: 1 });
  const b = chatter({ itemId: 2 });
  const c = card({ itemId: 3, intent: 'confirmation' });

  it('keeps the order of the kept cards', () => {
    expect(visibleItems([c, b, a], true).map((x) => x.itemId)).toEqual([3, 1]);
  });

  it('returns every card when the filter is off', () => {
    expect(visibleItems([c, b, a], false).map((x) => x.itemId)).toEqual([3, 2, 1]);
  });

  it('counts the hidden cards across the three lists', () => {
    expect(hiddenCount(lists([a, b], [chatter({ itemId: 4 })], [chatter({ itemId: 5 }), c]), true)).toBe(3);
  });

  it('is 0 with the filter off', () => {
    expect(hiddenCount(lists([a, b], [chatter({ itemId: 4 })]), false)).toBe(0);
  });

  // fix pass (review nit): a card pinned in two lists (a dirty card that moved) is ONE hidden card.
  it('counts a card once even when it appears in two lists', () => {
    expect(hiddenCount(lists([b], [chatter({ itemId: 2 })]), true)).toBe(1);
  });
});

// fix pass (review should-fix 2): overlapping blocks in one day column share its width.
describe('layoutLanes', () => {
  const box = (topPx: number, heightPx: number) => ({ topPx, heightPx });

  it('a lone block takes the whole column', () => {
    expect(layoutLanes([box(0, 48)])).toEqual([{ lane: 0, lanes: 1 }]);
  });

  it('two overlapping blocks get two lanes; a later block that starts after both ends is alone again', () => {
    // 15:00-16:00, 15:30-16:30, 17:00-18:00
    expect(layoutLanes([box(720, 48), box(744, 48), box(816, 48)])).toEqual([
      { lane: 0, lanes: 2 },
      { lane: 1, lanes: 2 },
      { lane: 0, lanes: 1 },
    ]);
  });

  it('back-to-back blocks (end == start) do not overlap', () => {
    expect(layoutLanes([box(0, 48), box(48, 48)])).toEqual([
      { lane: 0, lanes: 1 },
      { lane: 0, lanes: 1 },
    ]);
  });

  it('reuses the first free lane inside one cluster and keeps the input order', () => {
    // A 10-13, B 10:30-11, C 11:30-12 -> B and C share lane 1; the cluster has 2 lanes. Input order is C, A, B.
    const a = box(480, 144);
    const b = box(504, 24);
    const c = box(552, 24);
    expect(layoutLanes([c, a, b])).toEqual([
      { lane: 1, lanes: 2 },
      { lane: 0, lanes: 2 },
      { lane: 1, lanes: 2 },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Task 3: calendar entries, the week and the block geometry (handover §2.3, review focus 1 and 2)
// ---------------------------------------------------------------------------------------------------------------------
const at = (local: string): number => localToEpochMs(local, TZ);
const timed = (startLocal: string, endLocal: string, patch: Partial<ItemCard> = {}): ItemCard =>
  card({ event: { ...defaultCard.event!, startLocal, endLocal }, ...patch });
const inCal = (itemId: number, eventKey: string, updatedAt: number, patch: Partial<ItemCard> = {}): ItemCard =>
  timed('2026-10-20T09:00:00', '2026-10-20T10:00:00', {
    itemId,
    status: 'in_calendar',
    eventState: 'created',
    updatedAt,
    calendar: { eventStartTs: at('2026-10-20T09:00:00'), eventKey, revision: 1, status: 'confirmed' },
    ...patch,
  });
const entryOf = (startLocal: string, endLocal: string): CalendarEntry => ({
  itemId: 9,
  startMs: at(startLocal),
  endMs: at(endLocal),
  title: 'Late',
  state: 'proposed',
  eventKey: null,
  card: defaultCard,
});

describe('selectCalendarEntries', () => {
  it('a proposed card gives one proposed entry from its event', () => {
    const c = timed('2026-10-20T17:00:00', '2026-10-20T18:00:00', { itemId: 1 });
    const { entries, undated } = selectCalendarEntries(lists([c]), true, TZ);
    expect(undated).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      itemId: 1,
      startMs: at('2026-10-20T17:00:00'),
      endMs: at('2026-10-20T18:00:00'),
      title: 'Coffee',
      state: 'proposed',
      eventKey: null,
    });
    expect(entries[0]!.card).toBe(c);
  });

  it('a change card gives one entry at change.to, state change_proposed', () => {
    const c = card({
      itemId: 2,
      eventState: 'change_proposed',
      change: changeTo('2026-10-21T15:00:00', '2026-10-21T16:30:00', 'Moved'),
    });
    const { entries } = selectCalendarEntries(lists([c]), true, TZ);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      itemId: 2,
      startMs: at('2026-10-21T15:00:00'),
      endMs: at('2026-10-21T16:30:00'),
      title: 'Moved',
      state: 'change_proposed',
    });
  });

  it.each([
    ['created', 'in_calendar'],
    ['updated', 'in_calendar'],
    ['cancelled', 'cancelled'],
    ['declined', 'cancelled'],
    ['change_proposed', 'change_proposed'],
  ] as const)('eventState %s maps to entry state %s', (eventState, state) => {
    const c = inCal(3, 'k3', 100, { eventState });
    expect(selectCalendarEntries(lists([], [c]), true, TZ).entries.map((e) => e.state)).toEqual([state]);
  });

  it('carries the calendar event key', () => {
    const { entries } = selectCalendarEntries(lists([], [inCal(3, 'k3', 100)]), true, TZ);
    expect(entries[0]!.eventKey).toBe('k3');
  });

  it('a card whose endLocal is empty is undated, never a zero-height entry (review focus 1)', () => {
    const c = timed('2026-10-20T17:00:00', '', { itemId: 4 });
    const { entries, undated } = selectCalendarEntries(lists([c]), true, TZ);
    expect(entries).toEqual([]);
    expect(undated.map((x) => x.itemId)).toEqual([4]);
  });

  it('an end that is not after the start is undated', () => {
    const c = timed('2026-10-20T17:00:00', '2026-10-20T17:00:00', { itemId: 5 });
    expect(selectCalendarEntries(lists([c]), true, TZ).undated.map((x) => x.itemId)).toEqual([5]);
  });

  it.each(['none', 'incomplete'] as const)('eventState %s is undated even with a full slot', (eventState) => {
    const c = timed('2026-10-20T17:00:00', '2026-10-20T18:00:00', { itemId: 6, eventState });
    const { entries, undated } = selectCalendarEntries(lists([], [], [c]), true, TZ);
    expect(entries).toEqual([]);
    expect(undated.map((x) => x.itemId)).toEqual([6]);
  });

  it('cards without an event (analysing, info missing) are undated, in list order', () => {
    const a = card({ itemId: 7, analysis: 'queued', intent: null, event: null, eventState: 'none' });
    const b = card({ itemId: 8, eventState: 'incomplete', event: null, missing: ['date'] });
    expect(selectCalendarEntries(lists([a], [], [b]), true, TZ).undated.map((x) => x.itemId)).toEqual([7, 8]);
  });

  it('the schedule filter drops smalltalk entirely; with the filter off it is undated', () => {
    const s = chatter({ itemId: 9 });
    expect(selectCalendarEntries(lists([s]), true, TZ)).toEqual({ entries: [], undated: [] });
    expect(selectCalendarEntries(lists([s]), false, TZ).undated.map((x) => x.itemId)).toEqual([9]);
  });

  it('two in-calendar cards of one event give one entry, the newest updatedAt (ItemList.dedupeByEvent)', () => {
    const older = inCal(10, 'same', 100);
    const newer = inCal(11, 'same', 200);
    const other = inCal(12, 'other', 50);
    const { entries } = selectCalendarEntries(lists([], [older, newer, other]), true, TZ);
    expect(entries.map((e) => e.itemId).sort()).toEqual([11, 12]);
  });

  it('a card listed twice (pinned dirty card) yields one entry', () => {
    const c = timed('2026-10-20T17:00:00', '2026-10-20T18:00:00', { itemId: 13 });
    expect(selectCalendarEntries(lists([c], [], [c]), true, TZ).entries).toHaveLength(1);
  });

  it('sorts entries by start', () => {
    const late = timed('2026-10-22T17:00:00', '2026-10-22T18:00:00', { itemId: 14 });
    const early = timed('2026-10-20T08:00:00', '2026-10-20T09:00:00', { itemId: 15 });
    expect(selectCalendarEntries(lists([late, early]), true, TZ).entries.map((e) => e.itemId)).toEqual([15, 14]);
  });
});

describe('clipToDay (48 px per hour)', () => {
  const day = (date: string): number => at(`${date}T00:00:00`);

  it('places a morning entry by its wall-clock start and length', () => {
    expect(clipToDay(entryOf('2026-10-20T09:00:00', '2026-10-20T10:30:00'), day('2026-10-20'), TZ)).toEqual({
      topPx: 9 * 48,
      heightPx: 1.5 * 48,
    });
  });

  it('22:30-01:00 is clipped at 24:00 on its start day and absent from the next day (review focus 2)', () => {
    const e = entryOf('2026-10-20T22:30:00', '2026-10-21T01:00:00');
    expect(clipToDay(e, day('2026-10-20'), TZ)).toEqual({ topPx: 22.5 * 48, heightPx: 1.5 * 48 });
    expect(clipToDay(e, day('2026-10-21'), TZ)).toBeNull();
  });

  it('is null on any other day', () => {
    expect(clipToDay(entryOf('2026-10-20T09:00:00', '2026-10-20T10:00:00'), day('2026-10-19'), TZ)).toBeNull();
  });

  it('an entry ending exactly at midnight fills to the bottom of its day', () => {
    expect(clipToDay(entryOf('2026-10-20T23:00:00', '2026-10-21T00:00:00'), day('2026-10-20'), TZ)).toEqual({
      topPx: 23 * 48,
      heightPx: 48,
    });
  });

  it('uses the wall clock on the DST day (10:00 on 2026-10-25 sits at the 10:00 row)', () => {
    expect(clipToDay(entryOf('2026-10-25T10:00:00', '2026-10-25T11:00:00'), day('2026-10-25'), TZ)).toEqual({
      topPx: 10 * 48,
      heightPx: 48,
    });
  });

  it('a very short entry still gets a visible block inside the day', () => {
    const r = clipToDay(entryOf('2026-10-20T23:55:00', '2026-10-20T23:59:00'), day('2026-10-20'), TZ)!;
    expect(r.heightPx).toBeGreaterThanOrEqual(12);
    expect(r.topPx + r.heightPx).toBeLessThanOrEqual(24 * 48);
  });
});

describe('[V4] week helpers re-export', () => {
  it('the store re-exports the @shared/week functions (weekOf / shiftWeek / firstDayFor tests live in src/shared/week.test.ts)', () => {
    expect(store.weekOf).toBe(week.weekOf);
    expect(store.shiftWeek).toBe(week.shiftWeek);
    expect(store.firstDayFor).toBe(week.firstDayFor);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [V4] T-908 group C (handover §2.4): foreign events of every calendar join the card entries
// ---------------------------------------------------------------------------------------------------------------------
describe('[V4] foreign entries', () => {
  const view = (over: Partial<ForeignEventView> = {}): ForeignEventView => ({
    calendarId: 'work@x.test',
    title: 'Team sync',
    startLocal: '2026-10-20T10:00:00',
    endLocal: '2026-10-20T11:00:00',
    allDay: false,
    attendees: 0,
    recurring: false,
    ownedByApp: false,
    fromChat: false,
    location: '',
    writable: true,
    eventKey: 'aaaaaaaaaaaaaaaa',
    undoActionId: null,
    ...over,
  });
  const inCalendar = (itemId: number, eventKey: string, startLocal = '2026-10-20T15:00:00'): ItemCard =>
    card({
      itemId,
      eventState: 'created',
      event: {
        title: 'Coffee',
        startLocal,
        endLocal: startLocal.replace('T15', 'T16'),
        timeZone: TZ,
        location: '',
      } as ItemCard['event'],
      calendar: { eventStartTs: localToEpochMs(startLocal, TZ), eventKey, revision: 1, status: 'confirmed' },
    });

  it('foreignEntryOf: wall-clock times in the zone, state foreign, no card', () => {
    const e = foreignEntryOf(view({ attendees: 2, recurring: true, writable: false }), TZ)!;
    expect(e).toMatchObject({
      state: 'foreign',
      itemId: null,
      card: null,
      startMs: localToEpochMs('2026-10-20T10:00:00', TZ),
      endMs: localToEpochMs('2026-10-20T11:00:00', TZ),
      calendarId: 'work@x.test',
      eventKey: 'aaaaaaaaaaaaaaaa',
      attendees: 2,
      recurring: true,
      writable: false,
    });
    expect(isForeignEntry(e)).toBe(true);
    // a zero-length event still gets a block; an inverted one is dropped
    const zero = foreignEntryOf(view({ endLocal: '2026-10-20T10:00:00' }), TZ)!;
    expect(zero.endMs - zero.startMs).toBe(60_000);
    expect(foreignEntryOf(view({ endLocal: '2026-10-20T09:00:00' }), TZ)).toBeNull();
  });

  it('mergeForeignEntries: sorted by start; an app-owned event a card already shows is dropped (eventKey)', () => {
    const { entries } = selectCalendarEntries(lists([], [inCalendar(7, 'key-of-card')]), false, TZ);
    const merged = mergeForeignEntries(
      entries,
      [
        view({
          title: 'owned001',
          ownedByApp: true,
          eventKey: 'key-of-card',
          startLocal: '2026-10-20T15:00:00',
          endLocal: '2026-10-20T16:00:00',
        }),
        view({ title: 'owned002', ownedByApp: true, eventKey: 'no-card-key' }),
        view({
          title: 'foreign1',
          eventKey: 'key-of-card',
          startLocal: '2026-10-20T08:00:00',
          endLocal: '2026-10-20T09:00:00',
        }),
      ],
      TZ,
    );
    expect(merged.map((e) => (e.state === 'foreign' ? e.title : `item-${e.itemId}`))).toEqual([
      'foreign1', // not app-owned: never merged away, even with a colliding key
      'owned002',
      'item-7',
    ]);
  });

  it('selectCalendarEntries with foreign events merges them; without, the v3 result is unchanged', () => {
    const l = lists([], [inCalendar(7, 'k1')]);
    expect(selectCalendarEntries(l, false, TZ).entries.map((e) => e.itemId)).toEqual([7]);
    const both = selectCalendarEntries(l, false, TZ, [view()]);
    expect(both.entries.map((e) => e.state)).toEqual(['foreign', 'in_calendar']);
  });

  it('manageRefusals: read-only calendar, attendees, recurring - in that order; none for a plain writable event', () => {
    expect(manageRefusals(foreignEntryOf(view(), TZ)!)).toEqual([]);
    expect(manageRefusals(foreignEntryOf(view({ writable: false, attendees: 1, recurring: true }), TZ)!)).toEqual([
      'readonly',
      'attendees',
      'recurring',
    ]);
  });

  it('hash8 is a stable 8-hex hash; calendarHueOf is 0..7 and stable per calendar', () => {
    expect(hash8('primary')).toMatch(/^[0-9a-f]{8}$/);
    expect(hash8('primary')).toBe(hash8('primary'));
    expect(hash8('primary')).not.toBe(hash8('primarz'));
    const hues = ['primary', 'work@x.test', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(calendarHueOf);
    for (const h of hues) expect(h).toBeGreaterThanOrEqual(0);
    for (const h of hues) expect(h).toBeLessThan(CAL_HUES);
    expect(calendarHueOf('work@x.test')).toBe(calendarHueOf('work@x.test'));
    expect(new Set(hues).size).toBeGreaterThan(1);
  });
});

describe('[v4 T7] assignCalendarHues', () => {
  it('spreads calendars that hash to one hue over the next free hues, in list order; unknown ids keep the hash hue', async () => {
    const { assignCalendarHues, calendarHueOf, hash8 } = await import('./calendarEntries');
    const ids = ['primary', 'work@group.calendar.google.com', 'holidays@group.v.calendar.google.com'];
    assignCalendarHues(ids);
    const hues = ids.map(calendarHueOf);
    expect(new Set(hues).size).toBe(3);
    expect(hues[0]).toBe(Number.parseInt(hash8('primary'), 16) % 8);
    expect(calendarHueOf('other@x.test')).toBe(Number.parseInt(hash8('other@x.test'), 16) % 8);
    assignCalendarHues([]);
  });
});
