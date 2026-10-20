// src/renderer/src/components/CalendarWeek.tsx - [V3] T-904 (handover §2.3): the dashboard's week calendar.
//
// Draws the entries of the dashboard's cards (`selectCalendarEntries`) and - [V4] T-908 §2.4 - the events of every calendar of
// the Google account for the visible week (`useCalendarView`: `calendar:listEvents`, a main-side read the model never sees).
// It never writes anything: a card block opens the existing sheet through `onOpenItem` (every calendar write still needs its
// own approval click); a foreign block opens the read-only `EventPopover` (group D adds the manual actions through
// `renderEventActions`).
//
// Layout: toolbar (prev / today / next + range; [V4] calendar picker, Refresh events), [V4] the legend, the one-time scope
// note, a sticky day-header row, [V4] an all-day row (only when the week has all-day events; one element per event spanning
// its days), and a vertically scrolling grid of 24 hour rows x 7 day columns (48 px per hour), first opened at 07:00. Blocks
// are placed with LOGICAL inline styles (`inset-block-start` / `block-size`); an entry is drawn on its start day only and
// clipped at 24:00. Overlapping blocks of one day share the column width (`layoutLanes`).
// Block text: line 1 = the start time (`formatTime`, h23 two-digit), line 2 = the UNTRUSTED title inside
// <bdi className="msg-text" dir="auto">; both one line with an ellipsis. The full range (`formatTimeRange`, trusted)
// is the block's `title` attribute. The chat name / [V4] calendar name (UNTRUSTED) never goes into an attribute (ux.md
// 16.5): it is a visually hidden <bdi className="msg-text sr-only"> inside the block, for screen readers only.
// [V4] Foreign blocks: `cal-block-f-<eventKey[0:8]>` ([v4 T6]: the renderer never sees a Google event id), data-state="foreign", data-cal-hue 0..7 (hash8(calendarId) mod 8): a
// 3 px inline-start edge in the calendar's hue over a 16 % tint of it. A calendar that could not be read is named once
// (`cal-failed`, t('cal.failedFor')); `cal-loading` while a read is in flight.
// Day headers: weekday over day number. A CSS container query on `.cal-day` (dashboard.css) swaps the short weekday
// for the narrow one when the column is under 72 px wide.
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { EpochMs, ItemId, Lang } from '@shared/types';
import { formatTime, formatTimeRange } from '@shared/i18n/format';
import { localeFor } from '@shared/i18n/languages';
import { epochMsToLocal, todayIn } from '@shared/when';
import {
  DAY_PX,
  HOUR_PX,
  calendarHueOf,
  clipToDay,
  firstDayFor,
  hash8,
  layoutLanes,
  mergeForeignEntries,
  shiftWeek,
  weekOf,
  type CalendarEntry,
  type CalendarEntryState,
  type ForeignCalendarEntry,
} from '../store/calendarEntries';
import { useCalendarView } from '../store/calendarView';
import { renderBdiTemplate, SENTINEL } from './ItemCard.bdi';
import { CalendarLegend, CalendarPicker, hueVar } from './CalendarPicker';
import { EventPopover } from './EventPopover';
import { useManualEvents } from './ManualEventActions';

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
  /** [V4] EXTENSION POINT: the manual-management buttons of an open foreign event's popover. [v4 T7] Absent = the built-in
   *  manual management (ManualEventActions: Edit / Move / Delete / Undo last change through calendar:propose* + action:approve). */
  renderEventActions?(entry: ForeignCalendarEntry): ReactNode;
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
/** [V4] A foreign block: the calendar's hue as a 3 px inline-start edge over a 16 % tint of it. */
const FOREIGN_CLASS = 'border border-solid border-line text-text';
const foreignStyle = (hue: number): CSSProperties => ({
  borderInlineStartWidth: 3,
  borderInlineStartColor: hueVar(hue),
  background: `color-mix(in oklab, ${hueVar(hue)} 16%, var(--color-surface))`,
});

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
const foreignKeyOf = (e: ForeignCalendarEntry): string => `f|${e.calendarId}|${e.eventKey}`;
const blockKeyOf = (e: CalendarEntry): string => (e.state === 'foreign' ? foreignKeyOf(e) : `i|${e.itemId}`);

export function CalendarWeek(props: CalendarWeekProps): JSX.Element {
  const { t } = useTranslation();
  const { lang, timeZone } = props;
  const locale = localeFor(lang);
  const week = useMemo(() => weekOf(props.anchorMs, firstDayFor(lang), timeZone), [props.anchorMs, lang, timeZone]);
  const today = todayIn(timeZone, props.nowMs);

  // [V4] every calendar of the account, for the visible week
  const view = useCalendarView(props.anchorMs);
  const calendarName = useMemo(() => new Map(view.calendars.map((c) => [c.id, c.name])), [view.calendars]);
  const allEntries = useMemo(
    () =>
      mergeForeignEntries(
        props.entries,
        view.events.filter((e) => view.visible.has(e.calendarId)),
        timeZone,
      ),
    [props.entries, view.events, view.visible, timeZone],
  );
  const timedEntries = useMemo(() => allEntries.filter((e) => e.state !== 'foreign' || !e.allDay), [allEntries]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const openEntry = useMemo(
    () =>
      openKey === null
        ? null
        : (allEntries.find((e): e is ForeignCalendarEntry => e.state === 'foreign' && foreignKeyOf(e) === openKey) ??
          null),
    [allEntries, openKey],
  );
  const blockRefs = useRef(new Map<string, HTMLButtonElement>());
  const closePopover = (): void => {
    const key = openKey;
    setOpenKey(null);
    if (key !== null) blockRefs.current.get(key)?.focus();
  };
  // [v4 T7] manual management (handover §2.5): New event, popover actions, the form and the confirm step
  const manual = useManualEvents({
    calendars: view.calendars,
    lang,
    timeZone,
    weekStartMs: week.startMs,
    nowMs: props.nowMs,
    refresh: view.refresh,
    closePopover: () => setOpenKey(null),
  });

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
          const boxes = timedEntries.flatMap((entry) => {
            const box = clipToDay(entry, dayMs, timeZone);
            return box === null ? [] : [{ entry, ...box }];
          });
          const lanes = layoutLanes(boxes);
          return boxes.map((b, i) => ({ ...b, ...lanes[i]! }));
        })(),
      })),
    [week, timedEntries, timeZone],
  );

  /** [V4] All-day events of the week: one element each, spanning the columns of the days it covers (end exclusive). */
  const allDay = useMemo(() => {
    const weekEnd = shiftWeek(week.startMs, 1, timeZone);
    return allEntries.flatMap((e) => {
      if (e.state !== 'foreign' || !e.allDay || e.endMs <= week.startMs || e.startMs >= weekEnd) return [];
      const first = week.days.findIndex((d, i) => (week.days[i + 1] ?? weekEnd) > e.startMs && d < e.endMs);
      let last = first;
      while (last + 1 < 7 && week.days[last + 1]! < e.endMs) last += 1;
      return first < 0 ? [] : [{ entry: e, first, span: last - first + 1 }];
    });
  }, [allEntries, week, timeZone]);

  const empty = columns.every((c) => c.blocks.length === 0) && allDay.length === 0;
  const failedNames = useMemo(() => [...new Set(view.failed)], [view.failed]);

  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = FIRST_VISIBLE_HOUR * HOUR_PX;
  }, []);

  const gridColumns = { gridTemplateColumns: '3rem repeat(7, minmax(0, 1fr))' };

  /** [V4] A foreign block (timed or all-day): opens the popover; the calendar name is for screen readers only. */
  const foreignBlock = (
    entry: ForeignCalendarEntry,
    className: string,
    style: CSSProperties,
    lane?: number,
  ): JSX.Element => {
    const hue = calendarHueOf(entry.calendarId);
    const key = foreignKeyOf(entry);
    return (
      <button
        key={key}
        ref={(el) => {
          if (el) blockRefs.current.set(key, el);
          else blockRefs.current.delete(key);
        }}
        type="button"
        data-testid={`cal-block-f-${entry.eventKey.slice(0, 8)}`}
        data-state="foreign"
        data-cal-hue={hue}
        data-lane={lane}
        aria-expanded={openKey === key}
        title={entry.allDay ? undefined : formatTimeRange(entry.startMs, entry.endMs, lang, timeZone)}
        className={`cal-block focus-ring flex flex-col items-stretch overflow-hidden rounded-sm px-0.5 text-start text-xs leading-4 ${FOREIGN_CLASS} ${className}`}
        style={{ ...style, ...foreignStyle(hue) }}
        onClick={() => setOpenKey(openKey === key ? null : key)}
      >
        {entry.allDay ? null : (
          <span className="cal-line block truncate tnum">{formatTime(entry.startMs, lang, timeZone)}</span>
        )}
        <bdi className="cal-line msg-text block truncate" dir="auto">
          {entry.title}
        </bdi>
        <bdi className="msg-text sr-only" dir="auto">
          {calendarName.get(entry.calendarId) ?? ''}
        </bdi>
      </button>
    );
  };

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
        {view.calendars.length > 0 ? (
          <div className="ms-auto flex flex-wrap items-center gap-2">
            <CalendarPicker calendars={view.calendars} visible={view.visible} onChange={view.setVisible} />
            {manual.newEventButton}
            <button
              type="button"
              className="btn btn-outline"
              data-testid="cal-refresh"
              disabled={view.loading}
              onClick={view.refresh}
            >
              {t('cal.refresh')}
            </button>
          </div>
        ) : null}
      </div>

      <CalendarLegend calendars={view.calendars} visible={view.visible} />

      {failedNames.length > 0 ? (
        <div className="flex flex-col gap-0.5 text-sm text-danger" data-testid="cal-failed" role="status">
          {failedNames.map((id) => (
            <p key={id} className="m-0" data-testid={`cal-failed-${hash8(id)}`}>
              {renderBdiTemplate(t('cal.failedFor', { name: SENTINEL(0) }), [
                <bdi key="n" className="msg-text" dir="auto">
                  {calendarName.get(id) ?? ''}
                </bdi>,
              ])}
            </p>
          ))}
        </div>
      ) : null}

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

      {openEntry !== null ? (
        <EventPopover
          entry={openEntry}
          calendarName={calendarName.get(openEntry.calendarId) ?? ''}
          hue={calendarHueOf(openEntry.calendarId)}
          lang={lang}
          timeZone={timeZone}
          onClose={closePopover}
          actions={(props.renderEventActions ?? manual.actionsFor)(openEntry)}
        />
      ) : null}
      {manual.panel}

      <div className="relative min-w-0 rounded-sm border border-line bg-surface">
        {view.loading ? (
          <div
            aria-hidden="true"
            data-testid="cal-loading"
            className="pointer-events-none absolute z-10 flex flex-col gap-1 p-1"
            style={{ insetInline: 0, insetBlockStart: 0 }}
          >
            <div className="h-1 w-1/3 animate-pulse rounded-xs bg-accent-soft" />
          </div>
        ) : null}
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

        {allDay.length > 0 ? (
          <div className="grid gap-0.5 border-b border-line py-0.5" style={gridColumns} data-testid="cal-allday">
            {allDay.map(({ entry, first, span }) =>
              foreignBlock(entry, 'min-w-0', { gridColumn: `${first + 2} / span ${span}` }),
            )}
          </div>
        ) : null}

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
                  const share = 100 / lanes;
                  const place: CSSProperties = {
                    insetBlockStart: topPx,
                    blockSize: heightPx,
                    insetInlineStart: `calc(${lane * share}% + 1px)`,
                    inlineSize: `calc(${share}% - 2px)`,
                  };
                  if (entry.state === 'foreign') return foreignBlock(entry, 'absolute', place, lane);
                  const look = BLOCK_STYLE[entry.state];
                  return (
                    <button
                      key={blockKeyOf(entry)}
                      type="button"
                      data-testid={`cal-block-${entry.itemId}`}
                      data-state={look}
                      data-lane={lane}
                      title={formatTimeRange(entry.startMs, entry.endMs, lang, timeZone)}
                      className={`cal-block focus-ring absolute flex flex-col items-stretch overflow-hidden rounded-sm px-0.5 text-start text-xs leading-4 ${BLOCK_CLASS[look]}`}
                      style={place}
                      onClick={() => props.onOpenItem(entry.itemId)}
                    >
                      <span className="cal-line block truncate tnum" data-testid={`cal-block-time-${entry.itemId}`}>
                        {formatTime(entry.startMs, lang, timeZone)}
                      </span>
                      <bdi className="cal-line msg-text block truncate" dir="auto">
                        {entry.title}
                      </bdi>
                      <bdi className="msg-text sr-only" dir="auto">
                        {entry.card.chat.displayName !== ''
                          ? entry.card.chat.displayName
                          : entry.card.chat.phoneDisplay}
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
