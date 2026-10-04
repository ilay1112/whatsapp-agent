// src/renderer/src/components/ChangeLine.format.ts - app-side formatting of event slots for the Change line, the drift
// row, the AutoStrip verb phrase and the Undo deadline (UX2 3.1, 3.3, 3.4; owner V2-W1-11-renderer-dashboard).
//
// Every string built here is TRUSTED app text: it is produced from structured LocalDateTime fields through Intl, never
// from model or contact text. The only untrusted values of an event (title, location) are NOT formatted here - the
// components place them in their own `<bdi dir="auto">` slots.
import type { EventContentView, Lang } from '@shared/types';
import { formatTime, makeFormatters } from '@shared/i18n/format';
import { localeFor } from '@shared/i18n/languages';
import { localToEpochMs } from '@shared/when';

/** Day part of a slot: en "Wed 23 Sept", he "יום רביעי 23 בספט׳" (UX2 3.3 ChangeLine forms). */
export function formatDay(ms: number, lang: Lang, timeZone: string): string {
  const parts = new Intl.DateTimeFormat(localeFor(lang), {
    timeZone,
    weekday: lang === 'he' ? 'long' : 'short',
    day: 'numeric',
    month: 'short',
  }).formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return lang === 'he'
    ? `${part('weekday')} ${part('day')} ב${part('month')}`
    : `${part('weekday')} ${part('day')} ${part('month')}`;
}

/** Weekday only: en "Wed", he "יום רביעי" (the same-day ChangeLine form). */
export function formatWeekday(ms: number, lang: Lang, timeZone: string, long = lang === 'he'): string {
  return new Intl.DateTimeFormat(localeFor(lang), { timeZone, weekday: long ? 'long' : 'short' }).format(new Date(ms));
}

function sameDay(a: number, b: number, timeZone: string): boolean {
  const f = makeFormatters('en', timeZone).dayShort;
  return f.format(new Date(a)) === f.format(new Date(b));
}

/** Start instant of an event view in its own zone. */
export function startMsOf(e: Pick<EventContentView, 'startLocal' | 'timeZone'>): number {
  return localToEpochMs(e.startLocal, e.timeZone);
}

/** "Wed 15:00" (short weekday) - the AutoStrip "moved from ..." and the "Keep 15:00" / drift forms use parts of it. */
export function formatWhen(ms: number, lang: Lang, timeZone: string): string {
  return `${formatWeekday(ms, lang, timeZone)} ${formatTime(ms, lang, timeZone)}`;
}

/** "Wed 23 Sept 15:00" - a slot whose day must be spelled out. */
export function formatWhenWithDay(ms: number, lang: Lang, timeZone: string): string {
  return `${formatDay(ms, lang, timeZone)} ${formatTime(ms, lang, timeZone)}`;
}

export interface ChangeSides {
  /** Visible sides (each rendered in its own <bdi>). */
  from: string;
  to: string;
  /** Sentence sides for the visually hidden accessible text (weekday always long). */
  fromA11y: string;
  toA11y: string;
}

/**
 * The two sides of a reschedule: "Wed 15:00 -> 17:00" when the day stays, "Wed 23 Sept 15:00 -> Thu 24 Sept 17:00"
 * otherwise (UX2 3.3 table). The zone is the `to` zone (both sides share it: the editor never changes it).
 */
export function rescheduleSides(from: EventContentView, to: EventContentView, lang: Lang): ChangeSides {
  const tz = to.timeZone;
  const a = startMsOf(from);
  const b = startMsOf(to);
  const long = (ms: number): string => `${formatWeekday(ms, lang, tz, true)} ${formatTime(ms, lang, tz)}`;
  if (sameDay(a, b, tz)) {
    return {
      from: formatWhen(a, lang, tz),
      to: formatTime(b, lang, tz),
      fromA11y: long(a),
      toA11y: formatTime(b, lang, tz),
    };
  }
  return {
    from: formatWhenWithDay(a, lang, tz),
    to: formatWhenWithDay(b, lang, tz),
    fromA11y: formatWhenWithDay(a, lang, tz),
    toA11y: formatWhenWithDay(b, lang, tz),
  };
}

/**
 * The old value of the "Keep ..." button of a Change card (UX2 3.3): "Keep 15:00" when the new slot is on the same day,
 * "Keep Wed 15:00" otherwise (a bare time would be ambiguous across days).
 */
export function keepTimeLabel(from: EventContentView, to: EventContentView, lang: Lang): string {
  const tz = to.timeZone;
  const a = startMsOf(from);
  return sameDay(a, startMsOf(to), tz) ? formatTime(a, lang, tz) : formatWhen(a, lang, tz);
}
