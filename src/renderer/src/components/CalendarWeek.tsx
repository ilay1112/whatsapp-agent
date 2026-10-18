// src/renderer/src/components/CalendarWeek.tsx - [V3] T-904 (handover §2.3): the dashboard's week calendar.
//
// Draws ONLY what the dashboard already knows (entries from `selectCalendarEntries`); it never reads Google events
// (I2'/I9) and never writes anything - a block opens the existing sheet through `onOpenItem`, where every calendar write
// still needs its own approval click.
//
// Layout: toolbar (prev / today / next + range), the one-time scope note, a sticky day-header row and a vertically
// scrolling grid of 24 hour rows x 7 day columns (48 px per hour), first opened at 07:00. Blocks are placed with LOGICAL
// inline styles (`inset-block-start` / `block-size`); an entry is drawn on its start day only and clipped at 24:00.
// Overlapping blocks of one day share the column width (`layoutLanes`: lane index x 1/lanes, logical inline styles).
// Block text: line 1 = the start time (`formatTime`, h23 two-digit), line 2 = the UNTRUSTED title inside
// <bdi className="msg-text" dir="auto">; both one line with an ellipsis. The full range (`formatTimeRange`, trusted)
// is the block's `title` attribute. The chat name (UNTRUSTED) never goes into an attribute (ux.md 16.5): it is a
// visually hidden <bdi className="msg-text sr-only"> inside the block, for screen readers only.
// Day headers: weekday over day number. A CSS container query on `.cal-day` (dashboard.css) swaps the short weekday
// for the narrow one when the column is under 72 px wide.
import { useLayoutEffect, useMemo, useRef, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import type { EpochMs, ItemId, Lang } from '@shared/types';
import { formatTime, formatTimeRange } from '@shared/i18n/format';
import { localeFor } from '@shared/i18n/languages';
import { epochMsToLocal, todayIn } from '@shared/when';
import {
  DAY_PX,
  HOUR_PX,
  clipToDay,
  firstDayFor,
  layoutLanes,
  shiftWeek,
  weekOf,
  type CalendarEntry,
  type CalendarEntryState,
} from '../store/calendarEntries';

export interface CalendarWeekProps {
  entries: CalendarEntry[];
  anchorMs: EpochMs;
  onAnchorChange(ms: EpochMs): void;
  nowMs: EpochMs;
  lang: Lang;
  timeZone: string;
  onOpenItem(itemId: ItemId): void;
  noteSeen: boolean;
  onNoteSeen(): void;
}

/** The grid opens scrolled to this hour (handover §2.3). */
const FIRST_VISIBLE_HOUR = 7;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

type BlockStyle = 'proposed' | 'in_calendar' | 'cancelled';
const BLOCK_STYLE: Record<CalendarEntryState, BlockStyle> = {
  proposed: 'proposed',
  change_proposed: 'proposed',
  in_calendar: 'in_calendar',
  cancelled: 'cancelled',
};
/** Existing token classes only (no new colours): amber dashed = proposal, accent solid = in calendar, muted = cancelled. */
const BLOCK_CLASS: Record<BlockStyle, string> = {
  proposed: 'border border-dashed border-warn bg-warn-soft text-warn',
  in_calendar: 'border border-solid border-accent bg-accent-soft text-text',
  cancelled: 'border border-solid border-line bg-quote text-text-muted line-through',
};

/** Back / forward chevron (16 px, 1.5 px stroke); `icon-dir` mirrors it in RTL, so it always points in reading order. */
function Chevron({ forward }: { forward: boolean }): JSX.Element {
  return (
    <svg
      className="icon-dir"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d={forward ? 'M6 3l5 5-5 5' : 'M10 3 5 8l5 5'} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const dayKeyOf = (ms: EpochMs, timeZone: string): string => epochMsToLocal(ms, timeZone).slice(0, 10);
const chatNameOf = (e: CalendarEntry): string =>
  e.card.chat.displayName !== '' ? e.card.chat.displayName : e.card.chat.phoneDisplay;

export function CalendarWeek(props: CalendarWeekProps): JSX.Element {
  const { t } = useTranslation();
  const { lang, timeZone } = props;
  const locale = localeFor(lang);
  const week = useMemo(() => weekOf(props.anchorMs, firstDayFor(lang), timeZone), [props.anchorMs, lang, timeZone]);
  const today = todayIn(timeZone, props.nowMs);

  const range = useMemo(() => {
    const f = new Intl.DateTimeFormat(locale, { timeZone, day: 'numeric', month: 'short', year: 'numeric' });
    return f.formatRange(new Date(week.days[0]!), new Date(week.days[6]!));
  }, [locale, timeZone, week]);
  const dayFormats = useMemo(
    () => ({
      short: new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short' }),
      narrow: new Intl.DateTimeFormat(locale, { timeZone, weekday: 'narrow' }),
      day: new Intl.DateTimeFormat(locale, { timeZone, day: 'numeric' }),
    }),
    [locale, timeZone],
  );

  const columns = useMemo(
    () =>
      week.days.map((dayMs) => ({
        dayMs,
        key: dayKeyOf(dayMs, timeZone),
        blocks: ((): Array<{ entry: CalendarEntry; topPx: number; heightPx: number; lane: number; lanes: number }> => {
          const boxes = props.entries.flatMap((entry) => {
            const box = clipToDay(entry, dayMs, timeZone);
            return box === null ? [] : [{ entry, ...box }];
          });
          const lanes = layoutLanes(boxes);
          return boxes.map((b, i) => ({ ...b, ...lanes[i]! }));
        })(),
      })),
    [week, props.entries, timeZone],
  );
  const empty = columns.every((c) => c.blocks.length === 0);

  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = FIRST_VISIBLE_HOUR * HOUR_PX;
  }, []);

  const gridColumns = { gridTemplateColumns: '3rem repeat(7, minmax(0, 1fr))' };

  return (
    <section
      aria-label={t('view.calendar')}
      data-testid="calendar-week"
      className="flex min-h-0 min-w-0 flex-col gap-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="icon-btn focus-ring"
          aria-label={t('cal.prev')}
          data-testid="cal-prev"
          onClick={() => props.onAnchorChange(shiftWeek(props.anchorMs, -1, timeZone))}
        >
          <Chevron forward={false} />
        </button>
        <button
          type="button"
          className="btn btn-outline"
          data-testid="cal-today"
          onClick={() => props.onAnchorChange(props.nowMs)}
        >
          {t('cal.today')}
        </button>
        <button
          type="button"
          className="icon-btn focus-ring"
          aria-label={t('cal.next')}
          data-testid="cal-next"
          onClick={() => props.onAnchorChange(shiftWeek(props.anchorMs, 1, timeZone))}
        >
          <Chevron forward />
        </button>
        <h2 className="m-0 text-base font-semibold tnum" aria-live="polite" data-testid="cal-range">
          {range}
        </h2>
      </div>

      {props.noteSeen ? null : (
        <p className="m-0 flex flex-wrap items-center gap-2 text-sm text-text-muted" data-testid="cal-note">
          <span>{t('cal.scopeNote')}</span>
          <button type="button" className="btn btn-quiet" data-testid="cal-note-dismiss" onClick={props.onNoteSeen}>
            {t('cal.gotIt')}
          </button>
        </p>
      )}

      {empty ? (
        <p className="m-0 text-sm text-text-muted" data-testid="cal-empty">
          {t('cal.empty')}
        </p>
      ) : null}

      <div className="min-w-0 rounded-sm border border-line bg-surface">
        <div className="grid border-b border-line" style={gridColumns}>
          <div aria-hidden="true" />
          {columns.map((c) => (
            <div
              key={c.key}
              data-testid={`cal-day-${c.key}`}
              data-today={c.key === today ? 'true' : undefined}
              aria-current={c.key === today ? 'date' : undefined}
              className={`cal-day flex min-w-0 flex-col items-center py-1 text-center text-sm leading-tight ${
                c.key === today ? 'font-semibold text-accent' : 'text-text-muted'
              }`}
            >
              <span className="max-w-full truncate px-1">
                <span className="cal-wd-short">{dayFormats.short.format(new Date(c.dayMs))}</span>
                <span className="cal-wd-narrow">{dayFormats.narrow.format(new Date(c.dayMs))}</span>
              </span>
              <span className="cal-daynum tnum">{dayFormats.day.format(new Date(c.dayMs))}</span>
            </div>
          ))}
        </div>

        <div ref={scroller} className="overflow-y-auto" style={{ maxBlockSize: '70vh' }} data-testid="cal-grid">
          <div className="grid" style={{ ...gridColumns, blockSize: DAY_PX }}>
            <div aria-hidden="true">
              {HOURS.map((h) => (
                <div
                  key={h}
                  data-testid={`cal-hour-${h}`}
                  className="px-1 text-xs text-text-muted tnum"
                  style={{ blockSize: HOUR_PX }}
                >
                  {`${String(h).padStart(2, '0')}:00`}
                </div>
              ))}
            </div>
            {columns.map((c) => (
              <div
                key={c.key}
                data-testid={`cal-col-${c.key}`}
                className="relative min-w-0 border-s border-line"
                style={{
                  backgroundImage: 'linear-gradient(var(--color-line) 1px, transparent 1px)',
                  backgroundSize: `100% ${HOUR_PX}px`,
                }}
              >
                {c.blocks.map(({ entry, topPx, heightPx, lane, lanes }) => {
                  const look = BLOCK_STYLE[entry.state];
                  const share = 100 / lanes;
                  return (
                    <button
                      key={entry.itemId}
                      type="button"
                      data-testid={`cal-block-${entry.itemId}`}
                      data-state={look}
                      data-lane={lane}
                      title={formatTimeRange(entry.startMs, entry.endMs, lang, timeZone)}
                      className={`cal-block focus-ring absolute flex flex-col items-stretch overflow-hidden rounded-sm px-0.5 text-start text-xs leading-4 ${BLOCK_CLASS[look]}`}
                      style={{
                        insetBlockStart: topPx,
                        blockSize: heightPx,
                        insetInlineStart: `calc(${lane * share}% + 1px)`,
                        inlineSize: `calc(${share}% - 2px)`,
                      }}
                      onClick={() => props.onOpenItem(entry.itemId)}
                    >
                      <span className="cal-line block truncate tnum" data-testid={`cal-block-time-${entry.itemId}`}>
                        {formatTime(entry.startMs, lang, timeZone)}
                      </span>
                      <bdi className="cal-line msg-text block truncate" dir="auto">
                        {entry.title}
                      </bdi>
                      <bdi className="msg-text sr-only" dir="auto">
                        {chatNameOf(entry)}
                      </bdi>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
