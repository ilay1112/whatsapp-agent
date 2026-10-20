// src/shared/week.ts - [V4] T-908 group C (handover §2.4): the pure week helpers, shared by main (CalendarEventsService
// computes the visible week of `calendar:listEvents`) and the renderer (CalendarWeek draws it). Moved verbatim from
// src/renderer/src/store/calendarEntries.ts, which re-exports them so existing imports keep working.
// No I/O, no machine time zone: every conversion goes through `when.ts` with an explicit IANA zone.
import type { EpochMs, Lang, LocalDateTime } from './types';
import { localeFor } from './i18n/languages';
import { addMinutes, epochMsToLocal, localToEpochMs } from './when';

const DAY_MINUTES = 24 * 60;

/** Day of week (0 = Sunday) of an ISO date, computed on the calendar date itself (no zone involved). */
function weekdayOf(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** `isoDate` + n calendar days, as an ISO date. */
export function addDays(isoDate: string, n: number): string {
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

/**
 * [V4] The wall-clock window of the week of `anchorMs`: first local midnight .. the local midnight after the 7th day
 * (exclusive). 7 days, well inside the read facade's 14-day PinnedWindow cap.
 */
export function weekWindowOf(
  anchorMs: EpochMs,
  firstDay: 0 | 1,
  timeZone: string,
): { startMs: EpochMs; timeMinLocal: LocalDateTime; timeMaxLocal: LocalDateTime } {
  const { startMs } = weekOf(anchorMs, firstDay, timeZone);
  const firstDate = epochMsToLocal(startMs, timeZone).slice(0, 10);
  return { startMs, timeMinLocal: `${firstDate}T00:00:00`, timeMaxLocal: `${addDays(firstDate, 7)}T00:00:00` };
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
