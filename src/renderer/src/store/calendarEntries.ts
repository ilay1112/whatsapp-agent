// src/renderer/src/store/calendarEntries.ts - [V3] T-904 (handover §2.2 / §2.3): pure selectors over the dashboard lists.
//
// - The schedule-only filter: `isScheduleRelated` hides ONLY a finished analysis whose intent is question / smalltalk /
//   other and that carries nothing event-like. Analysing, held, failed, raw and manipulation-flagged cards always stay
//   visible.
// - The week calendar: `selectCalendarEntries` turns the cards the dashboard already holds into timed entries; a card
//   without a complete slot is "undated" and goes to the side list.
// - [V4] T-908 §2.4: the events of every calendar of the account (`calendar:listEvents`, a main-side read the model never
//   sees) join them as `state: 'foreign'` entries (`mergeForeignEntries`); an app-owned event that a card already shows is
//   dropped (de-dup by the opaque eventKey).
//
// Nothing here formats text or touches the DOM; titles are carried as-is (UNTRUSTED) for the component to isolate.
import type { EpochMs, EventState, ForeignEventView, Intent, ItemCard, ItemId, LocalDateTime } from '@shared/types';
import { epochMsToLocal, localToEpochMs } from '@shared/when';
import { startMsOf } from '../components/ChangeLine.format';
import type { DashboardStore } from './dashboard';
import { LIST_KEYS } from './dashboard';

// [V4] the pure week helpers live in @shared/week (main computes the same week for calendar:listEvents); re-exported
// here so every existing import keeps working.
export { firstDayFor, shiftWeek, weekOf } from '@shared/week';

export const SCHEDULE_INTENTS: ReadonlySet<Intent> = new Set<Intent>([
  'schedule_request',
  'reschedule',
  'cancel',
  'confirmation',
]);

/**
 * §2.2: true unless the card is a finished, non-scheduling analysis with nothing event-like on it. A card flagged
 * `manipulation` always stays visible: it is a security signal the user should see.
 */
export function isScheduleRelated(card: ItemCard): boolean {
  return (
    card.analysis !== 'done' ||
    card.intent === null ||
    SCHEDULE_INTENTS.has(card.intent) ||
    card.event !== null ||
    card.change !== null ||
    card.eventState !== 'none' ||
    card.badges.includes('manipulation')
  );
}

/** The cards of one list that the filter keeps, in their original order. */
export function visibleItems(items: ItemCard[], scheduleOnly: boolean): ItemCard[] {
  return scheduleOnly ? items.filter(isScheduleRelated) : items;
}

/**
 * Cards the filter hides across the three lists ("Show all (N hidden)"); 0 while the filter is off. A card is counted
 * once even when it sits in two lists (a dirty card pinned in its old list while the server moved it).
 */
export function hiddenCount(lists: DashboardStore['lists'], scheduleOnly: boolean): number {
  if (!scheduleOnly) return 0;
  const hidden = new Set<ItemId>();
  for (const key of LIST_KEYS)
    for (const card of lists[key].items) if (!isScheduleRelated(card)) hidden.add(card.itemId);
  return hidden.size;
}

// ---------------------------------------------------------------------------------------------------------------------
// Week calendar (handover §2.3)
// ---------------------------------------------------------------------------------------------------------------------

/** Height of one hour row of the week grid; a day column is 24 x HOUR_PX tall. */
export const HOUR_PX = 48;
export const DAY_PX = 24 * HOUR_PX;
/** A block is never thinner than a quarter hour, so a 5-minute entry stays visible and clickable. */
export const MIN_BLOCK_PX = HOUR_PX / 4;
const DAY_MINUTES = 24 * 60;

export type CalendarEntryState = 'proposed' | 'change_proposed' | 'in_calendar' | 'cancelled';

/** An entry drawn from one of the dashboard's cards (v3). */
export interface ItemCalendarEntry {
  itemId: ItemId;
  startMs: EpochMs;
  endMs: EpochMs;
  /** UNTRUSTED (model or contact text): render it only inside `<bdi className="msg-text" dir="auto">`. */
  title: string;
  state: CalendarEntryState;
  /** `card.calendar.eventKey` for a card that has a Google event, else null. */
  eventKey: string | null;
  card: ItemCard;
}

/**
 * [V4] T-908 §2.4: an event of any calendar of the account (ForeignEventView from `calendar:listEvents`). It has no card:
 * a click opens the read-only EventPopover (group D adds the manual actions there). `writable` = the calendar's role is
 * owner|writer; attendees / recurring are the I9' refusal reasons.
 */
export interface ForeignCalendarEntry {
  state: 'foreign';
  itemId: null;
  card: null;
  startMs: EpochMs;
  endMs: EpochMs;
  /** UNTRUSTED (other people's event text): render it only inside `<bdi className="msg-text" dir="auto">`. */
  title: string;
  /** The opaque per-event key (same function as ItemCard.calendar.eventKey). [v4 T6] The ONLY event name the renderer has (no
   *  Google event id crosses IPC, ARCH-v2 10): calendar:proposeEdit / proposeDelete take (calendarId, eventKey). */
  eventKey: string;
  calendarId: string;
  writable: boolean;
  attendees: number;
  recurring: boolean;
  allDay: boolean;
  ownedByApp: boolean;
  /** [v4 T6] a chat card's event (managed from its card) */
  fromChat: boolean;
  /** [v4 review fix] UNTRUSTED: the event's current location (the edit form pre-fills it), '' = none */
  location: string;
  /** [v4 T6] the manual action "Undo last change" reverts (action:undo), or null */
  undoActionId: string | null;
}

/** One block of the week calendar: a card's event / proposal, or [V4] an event of any calendar. */
export type CalendarEntry = ItemCalendarEntry | ForeignCalendarEntry;

export const isForeignEntry = (e: CalendarEntry): e is ForeignCalendarEntry => e.state === 'foreign';

/** Entry state of a card's own event; null = no block (the card is undated). */
const STATE_OF: Record<EventState, CalendarEntryState | null> = {
  none: null,
  incomplete: null,
  proposed: 'proposed',
  change_proposed: 'change_proposed',
  created: 'in_calendar',
  updated: 'in_calendar',
  cancelled: 'cancelled',
  declined: 'cancelled',
};

interface Slot {
  startLocal: LocalDateTime | '';
  endLocal: LocalDateTime | '';
  timeZone: string;
  title: string;
}

/** Start / end instants of a complete slot, or null when a side is empty or the end is not after the start. */
function instantsOf(slot: Slot, fallbackZone: string): { startMs: EpochMs; endMs: EpochMs } | null {
  if (slot.startLocal === '' || slot.endLocal === '') return null;
  // The event carries its own zone (settings.general.timeZone at proposal time); the argument only fills a blank one.
  const timeZone = slot.timeZone === '' ? fallbackZone : slot.timeZone;
  const startMs = startMsOf({ startLocal: slot.startLocal, timeZone });
  const endMs = localToEpochMs(slot.endLocal, timeZone);
  return endMs > startMs ? { startMs, endMs } : null;
}

function entryOf(card: ItemCard, timeZone: string): ItemCalendarEntry | null {
  let slot: Slot | null = null;
  let state: CalendarEntryState | null = null;
  if (card.change !== null) {
    slot = card.change.to;
    state = 'change_proposed';
  } else if (card.event !== null) {
    slot = card.event;
    state = STATE_OF[card.eventState];
  }
  if (slot === null || state === null) return null;
  const when = instantsOf(slot, timeZone);
  if (when === null) return null;
  const key = card.calendar?.eventKey ?? '';
  return { itemId: card.itemId, ...when, title: slot.title, state, eventKey: key === '' ? null : key, card };
}

const isLiveEvent = (e: ItemCalendarEntry): boolean => e.state === 'in_calendar' || e.state === 'cancelled';

/**
 * The week calendar's data: one timed entry per card that has a complete slot, and the undated rest (side list), both
 * after the schedule filter. Like `ItemList.dedupeByEvent`, a Google event shown by several in-calendar cards is drawn
 * once - here the newest `updatedAt` wins. Proposals (proposed / change_proposed) are never merged away: each is a
 * pending decision of its own card. `timeZone` fills an event whose own zone is blank.
 */
export function selectCalendarEntries(
  lists: DashboardStore['lists'],
  scheduleOnly: boolean,
  timeZone: string,
): { entries: ItemCalendarEntry[]; undated: ItemCard[] };
/** [V4] ... plus the events of every calendar (`mergeForeignEntries`). */
export function selectCalendarEntries(
  lists: DashboardStore['lists'],
  scheduleOnly: boolean,
  timeZone: string,
  foreign: readonly ForeignEventView[],
): { entries: CalendarEntry[]; undated: ItemCard[] };
export function selectCalendarEntries(
  lists: DashboardStore['lists'],
  scheduleOnly: boolean,
  timeZone: string,
  foreign?: readonly ForeignEventView[],
): { entries: CalendarEntry[]; undated: ItemCard[] } {
  const seen = new Set<ItemId>();
  const timed: ItemCalendarEntry[] = [];
  const undated: ItemCard[] = [];
  for (const key of LIST_KEYS) {
    for (const card of visibleItems(lists[key].items, scheduleOnly)) {
      if (seen.has(card.itemId)) continue;
      seen.add(card.itemId);
      const entry = entryOf(card, timeZone);
      if (entry === null) undated.push(card);
      else timed.push(entry);
    }
  }
  const newestOfEvent = new Map<string, ItemCalendarEntry>();
  for (const e of timed) {
    if (e.eventKey === null || !isLiveEvent(e)) continue;
    const kept = newestOfEvent.get(e.eventKey);
    if (kept === undefined || e.card.updatedAt > kept.card.updatedAt) newestOfEvent.set(e.eventKey, e);
  }
  const entries = timed.filter((e) => e.eventKey === null || !isLiveEvent(e) || newestOfEvent.get(e.eventKey) === e);
  entries.sort((a, b) => a.startMs - b.startMs || a.itemId - b.itemId);
  return { entries: foreign === undefined ? entries : mergeForeignEntries(entries, foreign, timeZone), undated };
}

/** [V4] ForeignEventView -> entry; times are wall clock in `timeZone` (settings.general.timeZone, as main projected them). */
export function foreignEntryOf(e: ForeignEventView, timeZone: string): ForeignCalendarEntry | null {
  const startMs = localToEpochMs(e.startLocal, timeZone);
  const endMs = localToEpochMs(e.endLocal, timeZone);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return {
    state: 'foreign',
    itemId: null,
    card: null,
    startMs,
    // a zero-length event still gets a (minimum-height) block
    endMs: endMs === startMs ? startMs + 60_000 : endMs,
    title: e.title,
    eventKey: e.eventKey,
    calendarId: e.calendarId,
    writable: e.writable,
    attendees: e.attendees,
    recurring: e.recurring,
    allDay: e.allDay,
    ownedByApp: e.ownedByApp,
    fromChat: e.fromChat,
    location: e.location,
    undoActionId: e.undoActionId,
  };
}

/**
 * [V4] The card entries plus the foreign events, sorted by start. An app-owned event whose eventKey a card entry already
 * carries is dropped (the card is the richer view of the same event); every other foreign event is kept - an event shared
 * into two visible calendars appears once per calendar, like in Google Calendar.
 */
export function mergeForeignEntries(
  entries: readonly CalendarEntry[],
  foreign: readonly ForeignEventView[],
  timeZone: string,
): CalendarEntry[] {
  const carded = new Set<string>();
  for (const e of entries) if (e.state !== 'foreign' && e.eventKey !== null) carded.add(e.eventKey);
  const out: CalendarEntry[] = [...entries];
  for (const f of foreign) {
    if (f.ownedByApp && carded.has(f.eventKey)) continue;
    const entry = foreignEntryOf(f, timeZone);
    if (entry !== null) out.push(entry);
  }
  // stable: item entries keep their own order (start, then itemId) ahead of a foreign entry with the same start
  return out
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.startMs - b.e.startMs || a.i - b.i)
    .map((x) => x.e);
}

/** [V4] Stable 32-bit FNV-1a hash of a string as 8 hex digits (block test ids, calendar hues). Not a security hash. */
export function hash8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** [V4] Number of calendar hue tokens (styles.css --color-cal-0..7). */
export const CAL_HUES = 8;
/** [V4] The hue (0..7) of a calendar: hash8(calendarId) mod 8, so a calendar keeps its colour across runs. [v4 T7] Once the
 *  account's calendar list is known (assignCalendarHues), calendars that would share a hue are spread to the next free one in
 *  list order (three calendars all hashing to one hue drew the whole week in one colour). */
export function calendarHueOf(calendarId: string): number {
  return assignedHues.get(calendarId) ?? preferredHue(calendarId);
}
const preferredHue = (calendarId: string): number => Number.parseInt(hash8(calendarId), 16) % CAL_HUES;
const assignedHues = new Map<string, number>();
/** [v4 T7] Distinct hues for the first 8 calendars of the account (list order = google:listCalendars); stable for a stable list. */
export function assignCalendarHues(calendarIds: readonly string[]): void {
  assignedHues.clear();
  const taken = new Set<number>();
  for (const id of calendarIds) {
    let hue = preferredHue(id);
    for (let i = 0; i < CAL_HUES && taken.has(hue); i += 1) hue = (hue + 1) % CAL_HUES;
    taken.add(hue);
    assignedHues.set(id, hue);
  }
}

/** Wall-clock minutes since local midnight. */
function minutesOfDay(ms: EpochMs, timeZone: string): number {
  const local = epochMsToLocal(ms, timeZone);
  return Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
}

/**
 * Block geometry of `entry` in the day column that starts at `dayStartMs` (a local midnight), by the WALL CLOCK (so the
 * 25 h DST day still draws 10:00 on the 10:00 row). An entry is drawn only on its start day; one that runs past 24:00 is
 * clipped there - no second block on the next day. Returns null on any other day.
 */
export function clipToDay(
  entry: CalendarEntry,
  dayStartMs: EpochMs,
  timeZone: string,
): { topPx: number; heightPx: number } | null {
  const day = epochMsToLocal(dayStartMs, timeZone).slice(0, 10);
  if (epochMsToLocal(entry.startMs, timeZone).slice(0, 10) !== day) return null;
  const pxPerMinute = HOUR_PX / 60;
  const startMin = minutesOfDay(entry.startMs, timeZone);
  const endsLater = epochMsToLocal(entry.endMs, timeZone).slice(0, 10) !== day;
  const endMin = endsLater ? DAY_MINUTES : minutesOfDay(entry.endMs, timeZone);
  const heightPx = Math.max((endMin - startMin) * pxPerMinute, MIN_BLOCK_PX);
  const topPx = Math.min(startMin * pxPerMinute, DAY_PX - heightPx);
  return { topPx, heightPx };
}

/** Lane of one block inside its overlap cluster: it is drawn `1/lanes` of the column wide, at `lane/lanes`. */
export interface BlockLane {
  lane: number;
  lanes: number;
}

/**
 * Side-by-side layout of the blocks of ONE day column (review should-fix 2: two proposals at 15:00 must both stay
 * visible and clickable). Blocks are taken by start (longer first on a tie); each goes into the first lane whose last
 * block ended at or before its start, else a new lane. A cluster is a run of blocks chained by overlap; every block of
 * it gets the cluster's lane count. Geometry is the drawn box (px), so the 12 px minimum height counts as overlap too.
 * Returns one lane per input block, in input order.
 */
export function layoutLanes(blocks: ReadonlyArray<{ topPx: number; heightPx: number }>): BlockLane[] {
  const order = blocks
    .map((b, i) => ({ i, start: b.topPx, end: b.topPx + b.heightPx }))
    .sort((a, b) => a.start - b.start || b.end - a.end || a.i - b.i);
  const out: BlockLane[] = blocks.map(() => ({ lane: 0, lanes: 1 }));
  let laneEnds: number[] = [];
  let cluster: number[] = [];
  let clusterEnd = -Infinity;
  const closeCluster = (): void => {
    for (const i of cluster) out[i]!.lanes = laneEnds.length;
    laneEnds = [];
    cluster = [];
  };
  for (const b of order) {
    if (b.start >= clusterEnd) closeCluster();
    let lane = laneEnds.findIndex((end) => end <= b.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(b.end);
    } else laneEnds[lane] = b.end;
    out[b.i]!.lane = lane;
    cluster.push(b.i);
    clusterEnd = cluster.length === 1 ? b.end : Math.max(clusterEnd, b.end);
  }
  closeCluster();
  return out;
}

/** [V4] Why a foreign event cannot be managed from the calendar view (I9'): read-only calendar, other attendees, repeating;
 *  [v4 T6] a chat card's event (change it from the card), an all-day event (change it in Google Calendar). */
export type ManageRefusal = 'readonly' | 'attendees' | 'recurring' | 'fromChat' | 'allDay';
/**
 * [V4] The refusal reasons of one foreign entry, in display order; [] = group D may offer edit / move / delete. A UI hint only:
 * main refuses the same cases in code (CAL_EVENT_FOREIGN_PROTECTED), whatever the renderer shows.
 */
export function manageRefusals(e: ForeignCalendarEntry): ManageRefusal[] {
  const out: ManageRefusal[] = [];
  if (!e.writable) out.push('readonly');
  if (e.attendees > 0) out.push('attendees');
  if (e.recurring) out.push('recurring');
  if (e.fromChat) out.push('fromChat');
  if (e.allDay) out.push('allDay');
  return out;
}
