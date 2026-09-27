// src/shared/i18n/format.ts
// Signatures from docs/research/i18n-rtl.md 8.2 (owner W1-08). Always pass timeZone explicitly - never the machine zone.
import { isolate } from './bidi';
import { localeFor, type UiLang } from './languages';

export interface Formatters {
  time: Intl.DateTimeFormat; // HH:mm, hourCycle h23
  dayShort: Intl.DateTimeFormat; // weekday short + day + month short
  full: Intl.DateTimeFormat; // dateStyle full + timeStyle short
  relative: Intl.RelativeTimeFormat; // numeric 'auto'
  list: Intl.ListFormat; // conjunction
  firstDay: number; // 7 = Sunday (Intl weekInfo; fallback {firstDay: 7})
}

/** The app's fallback zone; every public helper takes an explicit `timeZone` and only `makeFormatters` defaults. */
export const DEFAULT_TIME_ZONE = 'Asia/Jerusalem';
const MS_DAY = 86_400_000;
/** Beyond this many days a weekday name stops being useful and the short date is shown instead. */
const WEEKDAY_LABEL_HORIZON_DAYS = 6;

interface WeekInfo {
  firstDay: number;
}
type LocaleWithWeekInfo = Intl.Locale & { getWeekInfo?: () => WeekInfo; weekInfo?: WeekInfo };

function weekInfo(locale: string): WeekInfo {
  const l = new Intl.Locale(locale) as LocaleWithWeekInfo;
  return l.getWeekInfo?.() ?? l.weekInfo ?? { firstDay: 7 };
}

const cache = new Map<string, Formatters>();

/** Memoise per lng + timeZone in the caller; recreate on languageChanged. */
export function makeFormatters(lng: UiLang, timeZone: string = DEFAULT_TIME_ZONE): Formatters {
  const key = `${lng}|${timeZone}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const locale = localeFor(lng);
  const base = { timeZone, hourCycle: 'h23' as const };
  const made: Formatters = {
    time: new Intl.DateTimeFormat(locale, { ...base, hour: '2-digit', minute: '2-digit' }),
    dayShort: new Intl.DateTimeFormat(locale, { ...base, weekday: 'short', day: 'numeric', month: 'short' }),
    full: new Intl.DateTimeFormat(locale, { ...base, dateStyle: 'full', timeStyle: 'short' }),
    relative: new Intl.RelativeTimeFormat(lng, { numeric: 'auto' }),
    list: new Intl.ListFormat(lng, { type: 'conjunction' }),
    firstDay: weekInfo(locale).firstDay,
  };
  cache.set(key, made);
  return made;
}

/** 'HH:mm' of an instant in the given zone (h23). */
export function formatTime(ms: number, lng: UiLang, timeZone: string): string {
  return makeFormatters(lng, timeZone).time.format(new Date(ms));
}

/** Calendar days between the two instants as seen in `timeZone` (not a 24 h division). */
function dayDelta(ms: number, nowMs: number, timeZone: string): number {
  const dayOf = (t: number): number => {
    const found: Record<string, string> = {};
    for (const part of new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(t)))
      found[part.type] = part.value;
    return Date.UTC(Number(found.year), Number(found.month) - 1, Number(found.day));
  };
  return Math.round((dayOf(ms) - dayOf(nowMs)) / MS_DAY);
}

/** Day-granularity relative label (today / tomorrow / weekday / dayShort) - never "(2)"-style ICU outputs. */
export function formatDayLabel(ms: number, nowMs: number, lng: UiLang, timeZone: string): string {
  const f = makeFormatters(lng, timeZone);
  const delta = dayDelta(ms, nowMs, timeZone);
  // Only -1..+1 go through RelativeTimeFormat: CLDR 48 appends a dual "(2)" to Hebrew values of 2 (i18n-rtl.md 8.1).
  if (delta >= -1 && delta <= 1) return f.relative.format(delta, 'day');
  if (delta > 1 && delta <= WEEKDAY_LABEL_HORIZON_DAYS) {
    return new Intl.DateTimeFormat(localeFor(lng), { timeZone, weekday: 'long' }).format(new Date(ms));
  }
  return f.dayShort.format(new Date(ms));
}

/** 'HH:mm-HH:mm' range with a plain hyphen, isolated for RTL contexts. */
export function formatTimeRange(startMs: number, endMs: number, lng: UiLang, timeZone: string): string {
  const f = makeFormatters(lng, timeZone);
  // Built by hand rather than with formatRange: the ICU en dash is a neutral that reorders inside an RTL paragraph
  // (i18n-rtl.md 6.4). FSI...PDI keeps the whole range LTR wherever it is pasted.
  return isolate(`${f.time.format(new Date(startMs))}-${f.time.format(new Date(endMs))}`);
}
