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

// ---------------------------------------------------------------------------------------------------------------------
// [V2] V2-W1-12 (UX2 3.1, 3.3, 7.1-7.2, 9, 14; T2 9): the Change arrow line, relative ages of AutoStrip / activity rows,
// "usage resets HH:MM", voice durations and model sizes. Pure; every clock value takes an explicit zone (never the machine's).
// ---------------------------------------------------------------------------------------------------------------------

/** The ChangeLine arrow is a TEXT glyph (UX2 1.3): U+2192 in en, U+2190 in he - it points in reading direction. */
export function changeArrow(lng: UiLang): '→' | '←' {
  return lng === 'he' ? '←' : '→';
}

/** "Wed 15:00" (en, short weekday) / "יום רביעי 15:00" (he, long weekday - the short he form is "יום ד׳"). */
export function formatWeekdayTime(ms: number, lng: UiLang, timeZone: string): string {
  const weekday = new Intl.DateTimeFormat(localeFor(lng), {
    timeZone,
    weekday: lng === 'he' ? 'long' : 'short',
  }).format(new Date(ms));
  return `${weekday} ${formatTime(ms, lng, timeZone)}`;
}

/**
 * The two sides of "Change: Wed 15:00 -> 17:00" (UX2 3.3, 14.1). `to` drops the weekday when it falls on the same local
 * day as `from`. Each side is rendered by the caller inside its own `<bdi>`; the arrow comes from `changeArrow`.
 */
export function formatChangeSides(
  fromMs: number,
  toMs: number,
  lng: UiLang,
  timeZone: string,
): { from: string; to: string } {
  const from = formatWeekdayTime(fromMs, lng, timeZone);
  const to =
    dayDelta(toMs, fromMs, timeZone) === 0 ? formatTime(toMs, lng, timeZone) : formatWeekdayTime(toMs, lng, timeZone);
  return { from, to };
}

type AgeUnit = 'second' | 'minute' | 'hour' | 'day';
/** Whole-unit age of an instant: < 1 min => seconds, < 1 h => minutes, < 1 d => hours, else days. Future => 0 s. */
export function ageParts(ms: number, nowMs: number): { value: number; unit: AgeUnit } {
  const s = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (s < 60) return { value: s, unit: 'second' };
  if (s < 3600) return { value: Math.floor(s / 60), unit: 'minute' };
  if (s < 86_400) return { value: Math.floor(s / 3600), unit: 'hour' };
  return { value: Math.floor(s / 86_400), unit: 'day' };
}

/** CLDR 48 appends the grammatical number in parentheses to some Hebrew forms ("לפני שעה (1)", "לפני שעתיים (2)"). */
const HE_CLDR_COUNT_RE = /\s*\(\d+\)/g;

/**
 * "12 min. ago" / "לפני 12 דקות" for AutoStrip and activity rows (UX2 3.1, T2 9). Under a minute => "now" / "עכשיו".
 * Hebrew uses the long style (the short one abbreviates to "דק׳") and drops the CLDR "(n)" artefact.
 */
export function formatRelativeAge(ms: number, nowMs: number, lng: UiLang): string {
  const { value, unit } = ageParts(ms, nowMs);
  if (unit === 'second') return new Intl.RelativeTimeFormat(lng, { numeric: 'auto' }).format(0, 'second');
  const rtf = new Intl.RelativeTimeFormat(lng, { numeric: 'always', style: lng === 'he' ? 'long' : 'short' });
  return rtf.format(-value, unit).replace(HE_CLDR_COUNT_RE, '');
}

/** "40 sec" / "3 min" for "Checked {{value}} ago" (Connect card, UX2 7.1). Unit style short, whole units. */
export function formatElapsed(ms: number, lng: UiLang): string {
  const { value, unit } = ageParts(0, Math.max(0, ms));
  return new Intl.NumberFormat(localeFor(lng), { style: 'unit', unit, unitDisplay: 'short' }).format(value);
}

/**
 * "usage resets 15:40" (UX2 2.2, 7.2): HH:mm with h23 in the explicit zone; when the reset is not on today's local date
 * the short day is prepended ("Thu, 24 Sept 15:40"). Never the machine zone.
 */
export function formatResetTime(resetMs: number, nowMs: number, lng: UiLang, timeZone: string): string {
  const time = formatTime(resetMs, lng, timeZone);
  if (dayDelta(resetMs, nowMs, timeZone) === 0) return time;
  return `${makeFormatters(lng, timeZone).dayShort.format(new Date(resetMs))} ${time}`;
}

/** "0:42" / "12:05" - m:ss of a voice note (UX2 2.5, 3.5); negative / NaN => "0:00". Digits are Latin in both languages. */
export function formatClockDuration(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Model file sizes in the UI (UX2 C1, ux.md 8.1): pinned bytes / 2^30 with ONE decimal, "1.5 GB" - never a copy literal.
 * Used for the voice tiers and the picture-reading projector (F24: the size of the CURRENT tier's projector).
 */
export function formatModelSize(bytes: number, lng: UiLang): string {
  const gib = Math.max(0, bytes) / 2 ** 30;
  const n = new Intl.NumberFormat(localeFor(lng), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(gib);
  return `${n} GB`;
}

/** "28 Sept 2026" / "28 בספט׳ 2026" - consent dates, "Ended on", "Terms read on" (dateStyle medium, explicit zone). */
export function formatDate(ms: number, lng: UiLang, timeZone: string): string {
  return new Intl.DateTimeFormat(localeFor(lng), { timeZone, dateStyle: 'medium' }).format(new Date(ms));
}
