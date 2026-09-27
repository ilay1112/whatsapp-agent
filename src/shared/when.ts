// src/shared/when.ts
// Signatures verbatim from CONTRACTS section 7 (frozen); bodies implemented by W1-08-shared-utils.
// Pure: no I/O, no `Date` parsing of free text, no dependence on the machine time zone - every conversion goes through
// Intl.DateTimeFormat with an explicit IANA `timeZone` (ARCHITECTURE 6.3, 12.3; PIPELINE section 5).
import {
  LIMITS,
  MISSING_FIELDS,
  type EpochMs,
  type IsoDate,
  type LocalDateTime,
  type Assumption,
  type MissingField,
} from './types';
import type { Extraction } from './schemas';

export interface WhenContext {
  nowMs: EpochMs;
  timeZone: string;
  defaultDurationMin: number;
  ambiguousHour: 'assume' | 'ask';
}
export const WHEN_PROBLEMS = ['in_past', 'too_far', 'bad_duration', 'weekday_mismatch', 'incoherent_date'] as const;
export type WhenProblem = (typeof WHEN_PROBLEMS)[number];
export interface ResolvedWhen {
  date: IsoDate | '';
  startLocal: LocalDateTime | '';
  endLocal: LocalDateTime | '';
  timeZone: string;
  assumptions: Assumption[];
  missing: MissingField[]; // extraction.missing plus what resolution found missing ; deduplicated, order of MISSING_FIELDS
  problems: WhenProblem[]; // any problem => the slot is NOT complete (missing += 'date' or 'time')
}

// ======================= internal helpers (all pure) =======================

const MS_DAY = 86_400_000;
const MS_MINUTE = 60_000;
/** Used when `ctx.defaultDurationMin` is not a usable number at all. */
const HARD_DEFAULT_DURATION_MIN = 60;
/** `YYYY-MM-DDTHH:mm` with optional `:ss` - the only shape localToEpochMs / addMinutes accept. */
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (f === undefined) {
    // 'en-US' + hourCycle h23 gives purely numeric, zero-padded parts in a fixed set; the locale never reaches the output.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallPartsOf(ms: EpochMs, timeZone: string): WallParts {
  const found: Record<string, string> = {};
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(ms))) found[part.type] = part.value;
  const get = (type: string): number => Number(found[type]);
  // ICU renders midnight as hour 24 under some hour cycles; h23 does not, but normalise anyway.
  const hour = get('hour') % 24;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

function partsToLocal(p: WallParts): LocalDateTime {
  return `${pad4(p.year)}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
}

/** UTC-epoch of the same wall-clock fields, i.e. "this local time pretended to be UTC".
 *  `setUTCFullYear` is used instead of `Date.UTC`, which silently maps years 0..99 to 1900+y. */
function partsAsUtc(p: WallParts): number {
  const d = new Date(0);
  d.setUTCFullYear(p.year, p.month - 1, p.day);
  d.setUTCHours(p.hour, p.minute, p.second, 0);
  return d.getTime();
}

/** Offset of `timeZone` at instant `ms`, in ms east of UTC. */
function zoneOffsetMs(ms: EpochMs, timeZone: string): number {
  return partsAsUtc(wallPartsOf(ms, timeZone)) - ms;
}

function parseLocal(local: string): WallParts {
  const m = LOCAL_RE.exec(local);
  if (m === null) throw new RangeError(`when: not a LocalDateTime: ${JSON.stringify(local)}`);
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: m[6] === undefined ? 0 : Number(m[6]),
  };
}

/** Smallest minute-aligned instant in (lo, hi] that already has `hi`'s UTC offset - i.e. the DST transition instant. */
function transitionInstant(lo: number, hi: number, timeZone: string): number {
  const target = zoneOffsetMs(hi, timeZone);
  let low = lo,
    high = hi;
  while (high - low > MS_MINUTE) {
    // At least one whole minute of progress, so `low` always moves and the loop always terminates.
    const mid = low + Math.max(1, Math.floor((high - low) / 2 / MS_MINUTE)) * MS_MINUTE;
    if (zoneOffsetMs(mid, timeZone) === target) high = mid;
    else low = mid;
  }
  return high;
}

/** The only place a date string is checked; everything downstream works on values that already passed here or were
 *  produced by this module (`todayIn`, `isoAddDays`), so the internal helpers below parse by position without a guard. */
function isValidIsoDate(date: string): boolean {
  if (!ISO_DATE_RE.test(date)) return false;
  const { year, month, day } = isoParts(date);
  const probe = new Date(dateAsUtc(year, month, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function isoParts(date: IsoDate): { year: number; month: number; day: number } {
  return { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)) };
}

function dateAsUtc(year: number, month: number, day: number): number {
  return partsAsUtc({ year, month, day, hour: 0, minute: 0, second: 0 });
}

function isoToUtcMs(date: IsoDate): number {
  const { year, month, day } = isoParts(date);
  return dateAsUtc(year, month, day);
}

function utcMsToIso(ms: number): IsoDate {
  const d = new Date(ms);
  return `${pad4(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Calendar-day arithmetic on a date string; no time zone involved (both ends are wall-clock dates). */
function isoAddDays(date: IsoDate, days: number): IsoDate {
  return utcMsToIso(isoToUtcMs(date) + days * MS_DAY);
}

/** 0 = Sunday .. 6 = Saturday. `getUTCDay()` can only return these seven values, so the narrowing is total. */
type WeekdayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;
function isoWeekday(date: IsoDate): WeekdayIndex {
  return new Date(isoToUtcMs(date)).getUTCDay() as WeekdayIndex;
}

/** Calendar-month arithmetic, clamping to the last day of the target month (31 Jan + 1 month = 28/29 Feb). */
function isoAddMonths(date: IsoDate, months: number): IsoDate {
  const { year: y, month: mo, day: d } = isoParts(date);
  const total = y * 12 + (mo - 1) + months;
  const ty = Math.floor(total / 12);
  const tm = total - ty * 12;
  const lastDay = new Date(dateAsUtc(ty, tm + 2, 0)).getUTCDate(); // day 0 of the next month = last day of this one
  return `${pad4(ty)}-${pad2(tm + 1)}-${pad2(Math.min(d, lastDay))}`;
}

/** Does this wall time actually happen in `timeZone`? False inside a DST spring-forward gap, where `localToEpochMs`
 *  deliberately collapses the whole missing hour onto the transition instant (see its tail comment). */
function existsInZone(local: LocalDateTime, timeZone: string): boolean {
  return epochMsToLocal(localToEpochMs(local, timeZone), timeZone) === local;
}

function clampDuration(minutes: number): number {
  if (!Number.isFinite(minutes)) return HARD_DEFAULT_DURATION_MIN;
  return Math.min(Math.max(Math.trunc(minutes), LIMITS.eventMinMin), LIMITS.eventMaxMin);
}

// ======================= frozen API =======================

/** S2: the model never does date arithmetic. Hours 1-7 + timeAmbiguous => PM, 8-11 => AM when ambiguousHour='assume'; 'ask' => missing += 'time'. */
export function resolveWhen(x: Extraction, ctx: WhenContext): ResolvedWhen {
  const timeZone = ctx.timeZone;
  const anchorDate = todayIn(timeZone, ctx.nowMs);
  const problems = new Set<WhenProblem>();
  const assumptions: Assumption[] = [];
  const missing = new Set<MissingField>(x.missing);

  // ---------- date (PIPELINE 5.2) ----------
  let date: IsoDate | '' = '';
  if (x.dateKind === 'absolute') {
    if (isValidIsoDate(x.isoDate)) date = x.isoDate;
    else problems.add('incoherent_date');
  } else if (x.dateKind === 'weekday') {
    // next occurrence of the weekday on/after the anchor day (today counts), then + weekOffset weeks
    const delta = (((x.weekday - isoWeekday(anchorDate)) % 7) + 7) % 7;
    date = isoAddDays(anchorDate, delta + x.weekOffset * 7);
  } else if (x.dateKind === 'relative_days') {
    date = isoAddDays(anchorDate, x.daysFromToday);
  } // 'none' => no date

  // Defensive cross-check: an explicit calendar date whose weekday contradicts the weekday the model also reported.
  // `weekday` defaults to 0 for non-weekday dateKinds ("Use 0 unless dateKind is weekday"), so 0 cannot be distinguished
  // from "not filled" and is skipped. The prose variant (regex over the trigger text) is not available at this seam -
  // resolveWhen receives no text by contract.
  if (date !== '' && x.dateKind === 'absolute' && x.weekday !== 0 && isoWeekday(date) !== x.weekday) {
    problems.add('weekday_mismatch');
  }

  // ---------- time (PIPELINE 5.3) ----------
  // `timeAmbiguous` means "an hour was given with no am/pm cue". The model has already normalised to 24 h and may have
  // applied PM itself (golden he-01 / en-02 report 17:00 AND timeAmbiguous), so the assumption is recorded from the
  // RESOLVED hour, not from whether this function shifted it - otherwise the amber `time_assumed` badge would be lost.
  let time = '';
  if (x.time24h !== '') {
    if (x.timeAmbiguous && ctx.ambiguousHour === 'ask') {
      missing.add('time'); // the item goes to "Information missing" instead of guessing
    } else {
      const hour = Number(x.time24h.slice(0, 2));
      const minutes = x.time24h.slice(3, 5);
      const resolvedHour = x.timeAmbiguous && hour >= 1 && hour <= 7 ? hour + 12 : hour; // 1-7 => PM ; 8-11 stay AM
      time = `${pad2(resolvedHour)}:${minutes}`;
      if (x.timeAmbiguous) assumptions.push(resolvedHour >= 12 ? 'hour_assumed_pm' : 'hour_assumed_am');
    }
  }
  if (date === '') missing.add('date');
  if (time === '') missing.add('time');

  // ---------- duration (PIPELINE 5.4) ----------
  const fallbackDuration = clampDuration(ctx.defaultDurationMin);
  const defaulted = x.durationMin === 0;
  let durationMin = defaulted ? fallbackDuration : x.durationMin;
  if (durationMin < LIMITS.eventMinMin || durationMin > LIMITS.eventMaxMin) {
    problems.add('bad_duration');
    missing.add('duration');
    durationMin = fallbackDuration;
  }
  if (defaulted) assumptions.push('default_duration');

  // ---------- start / end ----------
  let startLocal: LocalDateTime | '' = '';
  let endLocal: LocalDateTime | '' = '';
  if (date !== '' && time !== '') {
    startLocal = `${date}T${time}:00`;
    endLocal = addMinutes(startLocal, durationMin);
    // A DST spring-forward gap swallows a whole wall-clock hour (Asia/Jerusalem 2026-03-27: 02:00 -> 03:00). Such a slot
    // would be proposed as complete and then be impossible to approve: both ends collapse onto the transition instant, so
    // eventSanity (exec/actionExecutor) sees a zero- or under-length event and refuses it. The hour the model picked does
    // not exist, and guessing 01:xx vs 03:xx for the user would be worse than asking - so the slot degrades to
    // "time missing" (same route as ambiguousHour: 'ask') and the user picks a real time in the mini-form.
    if (!existsInZone(startLocal, timeZone) || !existsInZone(endLocal, timeZone)) {
      startLocal = '';
      endLocal = '';
      missing.add('time');
    }
  }

  // ---------- sanity (PIPELINE 5.5) ----------
  if (date !== '') {
    const inPast = startLocal !== '' ? localToEpochMs(startLocal, timeZone) < ctx.nowMs : date < anchorDate;
    if (inPast) problems.add('in_past');
    if (date > isoAddMonths(anchorDate, LIMITS.eventHorizonMonths)) problems.add('too_far');
  }
  if (
    problems.has('in_past') ||
    problems.has('too_far') ||
    problems.has('weekday_mismatch') ||
    problems.has('incoherent_date')
  ) {
    missing.add('date');
  }

  return {
    date,
    startLocal,
    endLocal,
    timeZone,
    assumptions,
    missing: MISSING_FIELDS.filter((f) => missing.has(f)),
    problems: WHEN_PROBLEMS.filter((p) => problems.has(p)),
  };
}

export interface DayRow {
  date: IsoDate;
  weekdayIndex: number;
  weekdayEn: string;
  weekdayHe: string;
} // weekdayIndex 0 = Sunday
/** The 14-day table injected into the S1 user message (week starts Sunday). */
export function buildDayTable(nowMs: EpochMs, timeZone: string, days = 14): DayRow[] {
  const count = Number.isFinite(days) ? Math.max(0, Math.trunc(days)) : 0;
  const start = isoToUtcMs(todayIn(timeZone, nowMs));
  const rows: DayRow[] = [];
  for (let i = 0; i < count; i++) {
    const date = utcMsToIso(start + i * MS_DAY);
    const weekdayIndex = isoWeekday(date);
    rows.push({ date, weekdayIndex, weekdayEn: WEEKDAYS_EN[weekdayIndex], weekdayHe: WEEKDAYS_HE[weekdayIndex] });
  }
  return rows;
}

/** 0 = Sunday. Fixed names: the S1 table is a prompt constant, never an Intl output (that would drift with ICU). */
export const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export const WEEKDAYS_HE = ['יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי', 'יום שישי', 'שבת'] as const;

export function localToEpochMs(local: LocalDateTime, timeZone: string): EpochMs {
  const parts = parseLocal(local);
  const wanted = partsToLocal(parts);
  const asUtc = partsAsUtc(parts);
  // Two candidates: the offset one day before and one day after cover every real transition.
  const before = zoneOffsetMs(asUtc - MS_DAY, timeZone);
  const after = zoneOffsetMs(asUtc + MS_DAY, timeZone);
  const candidates = before === after ? [asUtc - before] : [asUtc - before, asUtc - after];
  const valid = candidates.filter((ms) => partsToLocal(wallPartsOf(ms, timeZone)) === wanted);
  // Ambiguous wall time (autumn fall-back): the FIRST occurrence wins. Unique: that one.
  if (valid.length > 0) return Math.min(...valid);
  // Non-existent wall time (spring gap): the first valid instant AFTER the gap = the transition instant itself.
  return transitionInstant(asUtc - MS_DAY, asUtc + MS_DAY, timeZone);
} // DST gaps: first valid instant after the gap

export function epochMsToLocal(ms: EpochMs, timeZone: string): LocalDateTime {
  return partsToLocal(wallPartsOf(ms, timeZone));
}
export function todayIn(timeZone: string, nowMs: EpochMs): IsoDate {
  return epochMsToLocal(nowMs, timeZone).slice(0, 10);
}
export function addMinutes(local: LocalDateTime, minutes: number): LocalDateTime {
  if (!Number.isFinite(minutes)) throw new RangeError(`when: addMinutes needs a finite number, got ${String(minutes)}`);
  // Wall-clock arithmetic: no zone, no DST - the caller resolves the result to an instant when it needs one.
  const shifted = new Date(partsAsUtc(parseLocal(local)) + Math.trunc(minutes) * MS_MINUTE);
  return partsToLocal({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  });
}
