// src/renderer/src/store/calendarEntries.ts - [V3] T-904 (handover §2.2 / §2.3): pure selectors over the dashboard lists.
//
// - The schedule-only filter: `isScheduleRelated` hides ONLY a finished analysis whose intent is question / smalltalk /
//   other and that carries nothing event-like. Analysing, held, failed, raw and manipulation-flagged cards always stay
//   visible.
// - The week calendar: `selectCalendarEntries` turns the cards the dashboard already holds into timed entries (no Google
//   event is ever read, I2'/I9); a card without a complete slot is "undated" and goes to the side list.
//
// Nothing here formats text or touches the DOM; titles are carried as-is (UNTRUSTED) for the component to isolate.
import type { EpochMs, EventState, Intent, ItemCard, ItemId, Lang, LocalDateTime } from '@shared/types';
import { localeFor } from '@shared/i18n/languages';
import { addMinutes, epochMsToLocal, localToEpochMs } from '@shared/when';
import { startMsOf } from '../components/ChangeLine.format';
import type { DashboardStore } from './dashboard';
import { LIST_KEYS } from './dashboard';

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

export interface CalendarEntry {
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

function entryOf(card: ItemCard, timeZone: string): CalendarEntry | null {
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

const isLiveEvent = (e: CalendarEntry): boolean => e.state === 'in_calendar' || e.state === 'cancelled';

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
): { entries: CalendarEntry[]; undated: ItemCard[] } {
  const seen = new Set<ItemId>();
  const timed: CalendarEntry[] = [];
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
  const newestOfEvent = new Map<string, CalendarEntry>();
  for (const e of timed) {
    if (e.eventKey === null || !isLiveEvent(e)) continue;
    const kept = newestOfEvent.get(e.eventKey);
    if (kept === undefined || e.card.updatedAt > kept.card.updatedAt) newestOfEvent.set(e.eventKey, e);
  }
  const entries = timed.filter((e) => e.eventKey === null || !isLiveEvent(e) || newestOfEvent.get(e.eventKey) === e);
  entries.sort((a, b) => a.startMs - b.startMs || a.itemId - b.itemId);
  return { entries, undated };
}

/** Day of week (0 = Sunday) of an ISO date, computed on the calendar date itself (no zone involved). */
function weekdayOf(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** `isoDate` + n calendar days, as an ISO date. */
function addDays(isoDate: string, n: number): string {
  return addMinutes(`${isoDate}T00:00:00`, n * DAY_MINUTES).slice(0, 10);
}

/**
 * The week that contains `anchorMs` in `timeZone`: `days` are the 7 LOCAL midnights (a DST day is 23 or 25 h long, so
 * they are not 24 h apart), `startMs` = `days[0]`. `firstDay` 0 = Sunday, 1 = Monday.
 */
export function weekOf(anchorMs: EpochMs, firstDay: 0 | 1, timeZone: string): { startMs: EpochMs; days: EpochMs[] } {
  const date = epochMsToLocal(anchorMs, timeZone).slice(0, 10);
  const first = addDays(date, -((weekdayOf(date) - firstDay + 7) % 7));
  const days = Array.from({ length: 7 }, (_, i) => localToEpochMs(`${addDays(first, i)}T00:00:00`, timeZone));
  return { startMs: days[0]!, days };
}

/** `anchorMs` moved by whole weeks on the wall clock (so a DST change never slips the anchor into a neighbour day). */
export function shiftWeek(anchorMs: EpochMs, weeks: number, timeZone: string): EpochMs {
  return localToEpochMs(addMinutes(epochMsToLocal(anchorMs, timeZone), weeks * 7 * DAY_MINUTES), timeZone);
}

type LocaleWithWeekInfo = Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };

/** First column of the week: Sunday for Hebrew; otherwise the locale's `weekInfo.firstDay` (Monday = 1), else Sunday. */
export function firstDayFor(lang: Lang): 0 | 1 {
  if (lang === 'he') return 0;
  try {
    const l = new Intl.Locale(localeFor(lang)) as LocaleWithWeekInfo;
    const info = l.getWeekInfo?.() ?? l.weekInfo;
    return info?.firstDay === 1 ? 1 : 0;
  } catch {
    return 0;
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
