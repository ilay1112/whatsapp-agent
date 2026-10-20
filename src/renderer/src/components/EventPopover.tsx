// src/renderer/src/components/EventPopover.tsx - [V4] T-908 (handover §2.4 / §2.5): the details of one event of any calendar,
// opened by clicking its block in the week calendar (`cal-event-popover`).
//
// Group C (this file, read-only part): title, calendar (swatch + name), time, and the reasons the event cannot be managed from
// here - read-only calendar (`cal-reason-readonly`), other attendees (`cal-reason-attendees`), repeating (`cal-reason-recurring`)
// - from `manageRefusals` (store/calendarEntries.ts). The attendee count and the recurring flag are also on the dialog as
// data-attendees / data-recurring.
// EXTENSION POINT for group D (T7): `actions` is rendered in the footer (`cal-popover-actions`). Edit / Move / Delete / Undo
// buttons go there; use `manageRefusals(entry)` to disable them (I9' is ALSO enforced in main - the UI is not the guard).
// Untrusted text (title, calendar name) only inside <bdi className="msg-text" dir="auto">, never in an attribute.
// Non-modal dialog: focus moves to the close button on open; Escape or the close button closes; the caller returns focus.
import { useEffect, useId, useRef, type JSX, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Lang } from '@shared/types';
import { formatTimeRange } from '@shared/i18n/format';
import { localeFor } from '@shared/i18n/languages';
import { manageRefusals, type ForeignCalendarEntry } from '../store/calendarEntries';
import { CloseIcon } from './UndoDismissDrawer';
import { hueVar } from './CalendarPicker';

export interface EventPopoverProps {
  entry: ForeignCalendarEntry;
  /** UNTRUSTED calendar name ('' when the calendar list does not know it). */
  calendarName: string;
  /** 0..7 (calendarHueOf(entry.calendarId)). */
  hue: number;
  lang: Lang;
  timeZone: string;
  onClose(): void;
  /** Group D: the manual-management buttons (footer). Absent = read-only popover. */
  actions?: ReactNode;
}

/** All-day: the date (range) of the event; its end is exclusive, so the last day is end - 1 ms. */
function allDayRange(entry: ForeignCalendarEntry, lang: Lang, timeZone: string): string {
  const f = new Intl.DateTimeFormat(localeFor(lang), { timeZone, weekday: 'short', day: 'numeric', month: 'short' });
  const last = Math.max(entry.startMs, entry.endMs - 1);
  return f.formatRange(new Date(entry.startMs), new Date(last));
}

export function EventPopover(props: EventPopoverProps): JSX.Element {
  const { t } = useTranslation();
  const { entry, onClose } = props;
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, [entry.eventKey, entry.calendarId]);

  const refusals = manageRefusals(entry);
  const when = entry.allDay
    ? allDayRange(entry, props.lang, props.timeZone)
    : formatTimeRange(entry.startMs, entry.endMs, props.lang, props.timeZone);

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-testid="cal-event-popover"
      data-attendees={entry.attendees}
      data-recurring={entry.recurring ? 'true' : 'false'}
      data-writable={entry.writable ? 'true' : 'false'}
      className="flex min-w-0 flex-col gap-2 rounded-md border border-line bg-surface p-3 shadow-pop"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex min-w-0 items-start gap-2">
        <h3 id={titleId} className="m-0 min-w-0 grow text-base font-semibold">
          <bdi className="msg-text block truncate" dir="auto">
            {entry.title}
          </bdi>
        </h3>
        <button
          ref={closeRef}
          type="button"
          className="icon-btn focus-ring shrink-0"
          aria-label={t('app.close')}
          data-testid="cal-popover-close"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      <p className="m-0 flex min-w-0 items-center gap-2 text-sm" data-testid="cal-popover-calendar">
        <span
          aria-hidden="true"
          data-cal-hue={props.hue}
          className="inline-block shrink-0 rounded-xs"
          style={{ inlineSize: 10, blockSize: 10, background: hueVar(props.hue) }}
        />
        <bdi className="msg-text min-w-0 truncate" dir="auto">
          {props.calendarName}
        </bdi>
      </p>
      <p className="m-0 text-sm tnum" data-testid="cal-popover-time">
        {when}
      </p>
      {refusals.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm text-text-muted" data-testid="cal-popover-reasons">
          {refusals.includes('readonly') ? (
            <li data-testid="cal-reason-readonly">{t('cal.readOnlyCalendar')}</li>
          ) : null}
          {refusals.includes('attendees') ? (
            <li data-testid="cal-reason-attendees">{t('cal.refusedAttendees')}</li>
          ) : null}
          {refusals.includes('recurring') ? (
            <li data-testid="cal-reason-recurring">{t('cal.refusedRecurring')}</li>
          ) : null}
          {refusals.includes('fromChat') ? <li data-testid="cal-reason-fromchat">{t('cal.refusedFromChat')}</li> : null}
          {refusals.includes('allDay') ? <li data-testid="cal-reason-allday">{t('cal.refusedAllDay')}</li> : null}
        </ul>
      ) : null}
      {props.actions !== undefined ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="cal-popover-actions">
          {props.actions}
        </div>
      ) : null}
    </div>
  );
}
