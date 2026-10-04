// src/main/agent/resolve.ts - S2 RESOLVE sub-states over shared/when.ts (build-plan section 3; owner W1-08).
// [V2] + the image_absolute branch of P2 7.4 (owner V2-W1-08-vision): resolveExtractionWithImage / resolveImageDate.
import { buildDayTable, resolveWhen, todayIn, type WhenContext, type ResolvedWhen } from '../../shared/when';
import {
  LIMITS,
  MISSING_FIELDS,
  type Assumption,
  type ClosedReason,
  type IsoDate,
  type MissingField,
  type ProposedEvent,
} from '../../shared/types';
import type { Extraction, ImageRead } from '../../shared/schemas';

export type SlotState = 'none' | 'incomplete' | 'complete';
export interface ResolvedSlot {
  state: SlotState; // -> eventState 'none' | 'incomplete' | 'proposed'
  when: ResolvedWhen;
  event: ProposedEvent | null; // complete or incomplete (dateHint filled) ; null when state === 'none'
  missing: MissingField[];
  assumptions: Assumption[];
}

/** Intents that may end in a `create_event` action. `reschedule`/`cancel` are handled separately (no write in v1, ARCHITECTURE A10). */
const EVENT_INTENTS: ReadonlySet<Extraction['intent']> = new Set(['schedule_request', 'confirmation']);
/** Only these two make a slot unusable. `duration`/`location`/`who`/`confirmation` stay in `missing` for the draft to ask about
 *  while the event is still proposable (PIPELINE 5.4 and golden rows he-01 / en-02, which are `needs_reply`, not `info_missing`). */
const BLOCKING_MISSING: readonly MissingField[] = ['date', 'time'];

// LF, CR, LINE SEPARATOR, PARAGRAPH SEPARATOR - built from code points because the last two are line terminators in source.
const LINE_BREAKS = String.fromCharCode(0x0a, 0x0d, 0x2028, 0x2029);
const NEWLINES_RE = new RegExp(`[${LINE_BREAKS}]+`, 'g');

/** ProposedEventSchema requires single-line, length-capped values; model output is only length-capped. */
function singleLine(value: string, cap: number): string {
  return value.replace(NEWLINES_RE, ' ').trim().slice(0, cap);
}

/** Sanity checks of ARCHITECTURE 6.3 (past, > 12 months, duration bounds, weekday mismatch) -> downgrade, never crash. Pure. */
export function resolveExtraction(x: Extraction, ctx: WhenContext): ResolvedSlot {
  const when = resolveWhen(x, ctx);
  const complete =
    when.startLocal !== '' &&
    when.endLocal !== '' &&
    when.problems.length === 0 &&
    !BLOCKING_MISSING.some((f) => when.missing.includes(f));

  let state: SlotState;
  if (x.intent === 'cancel') {
    state = 'none'; // nothing to propose; the card carries `change_in_google`
  } else if (x.intent === 'reschedule') {
    state = when.date === '' ? 'none' : 'incomplete'; // a new day is on the table but v1 never writes the move itself
  } else if (EVENT_INTENTS.has(x.intent)) {
    state = complete ? 'complete' : 'incomplete';
  } else {
    state = 'none'; // question / smalltalk / other: no scheduling intent (ARCHITECTURE 6.3)
  }

  const event: ProposedEvent | null =
    state === 'none'
      ? null
      : {
          title: singleLine(x.title, LIMITS.titleChars),
          startLocal: state === 'complete' ? when.startLocal : '',
          endLocal: state === 'complete' ? when.endLocal : '',
          timeZone: when.timeZone, // from settings, never from the model
          location: singleLine(x.location, LIMITS.locationChars),
          assumptions: when.assumptions,
          dateHint: state === 'complete' ? '' : when.date, // pre-fills the info-missing mini-form
        };

  return { state, when, event, missing: when.missing, assumptions: when.assumptions };
}

/** `[+]` ARCHITECTURE 6.3 / PIPELINE 5.6: reschedule and cancel never call update-event / delete-event in v1 - the card shows
 *  the info badge `change_in_google` instead. Pure; the caller (W1-10 validate.ts) turns `true` into the badge. */
export function needsCalendarChangeBadge(x: Extraction): boolean {
  return x.intent === 'reschedule' || x.intent === 'cancel';
}

/** `[+]` PIPELINE 5.6: no reply wanted, nothing to schedule and no calendar change to announce => the item closes itself. */
export function closureFor(x: Extraction, slot: ResolvedSlot): ClosedReason | null {
  return !x.needsReply && slot.state === 'none' && !needsCalendarChangeBadge(x) ? 'not_needed' : null;
}

// =====================================================================================================================
// [V2 ADD, V2-W1-08] P2 7.4 / B19 - the `image_absolute` branch. Pure; the model never does date arithmetic (A8): the V1
// read reports only the digits that are WRITTEN in the picture, and this code turns them into an ISO date in the run zone.
// `resolveWhen()` is unchanged: the branch only decides what S2 feeds it.
// =====================================================================================================================

/** The digits of a V1 read (sentinels: day/month/year 0 = not written, weekday 7, hour/endHour 24). */
export type ImageDigits = Pick<
  ImageRead,
  'readable' | 'day' | 'month' | 'year' | 'weekday' | 'hour' | 'minute' | 'timeAmbiguous' | 'endHour' | 'endMinute'
>;
/** P2 7.4 output: `used` = the branch ran; `conflict` = S1 and the picture disagree (amber `conflict`); `unclear` = an impossible
 *  date or a weekday word that contradicts the digits (amber `image_unclear`). */
export interface ImageMerge {
  used: boolean;
  conflict: boolean;
  unclear: boolean;
}
export interface ImageDateResolution {
  date: IsoDate | ''; // '' = no usable calendar date (invalid day/month, e.g. 31.2)
  weekdayMismatch: boolean; // a written weekday that is not the weekday of `date` (the date is kept)
  invalid: boolean; // the written day/month (+ year) is not a calendar date
}

/** How far ahead a year-less date may roll to find a real day (29.2 needs up to 4 years; 8 covers the 2100 gap too). */
const NEXT_OCCURRENCE_YEARS = 8;

function pad2(n: number): string {
  return n < 10 ? `0${String(n)}` : String(n);
}
function isoOf(year: number, month: number, day: number): IsoDate | '' {
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return '';
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}
function weekdayOf(date: IsoDate): number {
  const probe = new Date(0);
  probe.setUTCFullYear(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return probe.getUTCDay();
}

/** P2 7.4 steps 2/3: digits -> ISO date. `year = 0` = the next occurrence of day/month on or after `today` (today counts); a written
 *  year is taken literally (a past one is left to the sanity rules of resolveWhen: `in_past` => missing date). */
export function resolveImageDate(
  d: Pick<ImageRead, 'day' | 'month' | 'year' | 'weekday'>,
  today: IsoDate,
): ImageDateResolution {
  let date: IsoDate | '' = '';
  if (d.year !== 0) {
    date = isoOf(d.year, d.month, d.day);
  } else {
    const thisYear = Number(today.slice(0, 4));
    for (let y = thisYear; y <= thisYear + NEXT_OCCURRENCE_YEARS && date === ''; y += 1) {
      const candidate = isoOf(y, d.month, d.day);
      if (candidate !== '' && candidate >= today) date = candidate;
    }
  }
  if (date === '') return { date: '', weekdayMismatch: false, invalid: true };
  const weekdayMismatch = d.weekday <= 6 && weekdayOf(date) !== d.weekday;
  return { date, weekdayMismatch, invalid: false };
}

/** Does the V1 read carry a calendar date the branch can use (P2 7.4 entry condition)? */
export function imageBranchApplies(read: ImageDigits | null): read is ImageDigits {
  return read !== null && read.readable && read.day > 0 && read.month > 0;
}

/** `HH:MM` of a read's start, or '' when no clock time is written (hour 24 = the sentinel). */
function imageTime(read: ImageDigits): string {
  return read.hour >= 24 ? '' : `${pad2(read.hour)}:${pad2(read.minute)}`;
}
/** Minutes from the written start to the written end, when a range is written and the end is after the start. */
function imageDurationMin(read: ImageDigits): number {
  if (read.endHour >= 24) return 0;
  const start = read.hour * 60 + read.minute;
  const end = read.endHour * 60 + read.endMinute;
  return end > start ? end - start : 0;
}
/** S1 said `hh:mm`, the picture says another clock time: a conflict - unless the picture's bare hour was ambiguous (`ב-7`) and S1
 *  read the afternoon half of it (19:00). */
function sameClock(s1: string, read: ImageDigits, picture: string): boolean {
  if (s1 === picture) return true;
  return (
    read.timeAmbiguous && read.hour >= 1 && read.hour <= 11 && s1 === `${pad2(read.hour + 12)}:${pad2(read.minute)}`
  );
}

/**
 * P2 7.4: merges a V1 read into the S1 extraction BEFORE resolveWhen() runs, then resolves exactly as v1 does.
 * 1. S1's own date wins when S1 named one that lies inside the 14-day table; a different picture date => `conflict`.
 * 2. Otherwise the picture's digits give the date (`resolveImageDate`); an impossible date => no date + `unclear`.
 * 3. A written weekday that is not the date's weekday => `unclear` (the digits are kept).
 * 4. S1's `time24h` wins when present (a different picture time => `conflict`); else the picture's hour/minute with its own
 *    `timeAmbiguous` (the v1 PM rule + `time_assumed` apply); a written end after the start sets the duration.
 * 5. Title and location stay S1's (S1 saw `imageText`); 6. the sanity rules of resolveWhen apply unchanged.
 * `read === null` or no usable date => exactly `resolveExtraction(x, ctx)` with `imageMerge: null`.
 */
export function resolveExtractionWithImage(
  x: Extraction,
  read: ImageDigits | null,
  ctx: WhenContext,
): ResolvedSlot & { imageMerge: ImageMerge | null } {
  if (!imageBranchApplies(read)) return { ...resolveExtraction(x, ctx), imageMerge: null };
  const today = todayIn(ctx.timeZone, ctx.nowMs);
  const image = resolveImageDate(read, today);
  let conflict = false;
  const unclear = image.invalid || image.weekdayMismatch;
  const missing = new Set<MissingField>(x.missing);
  let merged: Extraction = x;

  // ---- date (steps 1-3) ----
  const s1Date = x.dateKind === 'none' ? '' : resolveWhen(x, ctx).date;
  const table = buildDayTable(ctx.nowMs, ctx.timeZone);
  const tableEnd = table[table.length - 1]?.date ?? today;
  const s1Wins = s1Date !== '' && s1Date >= today && s1Date <= tableEnd;
  if (s1Wins) {
    if (image.date !== '' && image.date !== s1Date) conflict = true;
  } else if (image.date !== '') {
    if (s1Date !== '' && s1Date !== image.date) conflict = true; // S1 named a date outside the table and the picture another one
    merged = { ...merged, dateKind: 'absolute', isoDate: image.date, weekday: 0, weekOffset: 0, daysFromToday: 0 };
    missing.delete('date');
  }

  // ---- time (step 4) ----
  const pictureTime = imageTime(read);
  if (x.time24h !== '') {
    if (pictureTime !== '' && !sameClock(x.time24h, read, pictureTime)) conflict = true;
  } else if (pictureTime !== '') {
    merged = { ...merged, time24h: pictureTime, timeAmbiguous: read.timeAmbiguous };
    missing.delete('time');
    const duration = imageDurationMin(read);
    if (duration > 0 && x.durationMin === 0) {
      merged = { ...merged, durationMin: duration };
      missing.delete('duration');
    }
  }

  merged = { ...merged, missing: MISSING_FIELDS.filter((f) => missing.has(f)) };
  return { ...resolveExtraction(merged, ctx), imageMerge: { used: true, conflict, unclear } };
}
