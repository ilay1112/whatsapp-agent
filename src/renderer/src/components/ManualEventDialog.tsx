// src/renderer/src/components/ManualEventDialog.tsx - [v4 T7] T-908 handover §2.5: the form of a user-authored calendar event
// (`cal-dialog`): New event (any WRITABLE calendar), Edit (title / time / place) and Move (time first) of an event of the view.
// It writes NOTHING: Continue hands the fields to the caller, which asks main for a pending action (calendar:propose*) and then
// shows the confirm step (`cal-confirm`). The fields are the user's own text; main re-validates everything (5 min .. 12 h, title).
// Non-modal dialog like EventPopover: focus goes to the first field (the time for Move), Escape / Cancel closes.
import { useEffect, useId, useRef, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import type { CalendarInfo } from '@shared/types';
import { LIMITS } from '@shared/types';
import { localToEpochMs } from '@shared/when';
import type { ErrorCode } from '@shared/errors';

export interface ManualEventFields {
  calendarId: string;
  title: string;
  startLocal: string; // YYYY-MM-DDTHH:mm:ss, wall clock in the app's zone
  endLocal: string;
  location: string;
}
export interface ManualEventDialogProps {
  mode: 'create' | 'edit' | 'move';
  /** create: the writable calendars to choose from (read-only ones are never offered); edit / move: the event's own. */
  calendars: CalendarInfo[];
  initial: ManualEventFields;
  timeZone: string;
  /** pending propose in flight */
  busy: boolean;
  /** the last refusal of main for this form (t('errors.<code>.title')) */
  error: ErrorCode | null;
  onSubmit(fields: ManualEventFields): void;
  onCancel(): void;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The form's own check (main checks again): a title, a real date, end after start, 5 minutes .. 12 hours. */
export function validateManualFields(
  f: { title: string; date: string; start: string; end: string },
  timeZone: string,
): 'title' | 'time' | null {
  if (f.title.trim().length === 0) return 'title';
  if (!DATE_RE.test(f.date) || !TIME_RE.test(f.start) || !TIME_RE.test(f.end)) return 'time';
  const s = localToEpochMs(`${f.date}T${f.start}:00`, timeZone);
  const e = localToEpochMs(`${f.date}T${f.end}:00`, timeZone);
  const minutes = (e - s) / 60_000;
  if (!Number.isFinite(minutes) || minutes < LIMITS.eventMinMin || minutes > LIMITS.eventMaxMin) return 'time';
  return null;
}

export function ManualEventDialog(props: ManualEventDialogProps): JSX.Element {
  const { t } = useTranslation();
  const titleId = useId();
  const [calendarId, setCalendarId] = useState(props.initial.calendarId);
  const [title, setTitle] = useState(props.initial.title);
  const [date, setDate] = useState(props.initial.startLocal.slice(0, 10));
  const [start, setStart] = useState(props.initial.startLocal.slice(11, 16));
  const [end, setEnd] = useState(props.initial.endLocal.slice(11, 16));
  const [location, setLocation] = useState(props.initial.location);
  const [invalid, setInvalid] = useState<'title' | 'time' | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    (props.mode === 'move' ? timeRef.current : firstRef.current)?.focus();
  }, [props.mode]);

  const submit = (): void => {
    const bad = validateManualFields({ title, date, start, end }, props.timeZone);
    setInvalid(bad);
    if (bad !== null) return;
    props.onSubmit({
      calendarId,
      title: title.trim(),
      startLocal: `${date}T${start}:00`,
      endLocal: `${date}T${end}:00`,
      location: location.trim(),
    });
  };

  const heading = props.mode === 'create' ? t('cal.newEvent') : props.mode === 'move' ? t('cal.move') : t('cal.edit');
  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-testid="cal-dialog"
      data-mode={props.mode}
      className="flex min-w-0 flex-col gap-2 rounded-md border border-line bg-surface p-3 shadow-pop"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          props.onCancel();
        }
      }}
    >
      <h3 id={titleId} className="m-0 text-base font-semibold">
        {heading}
      </h3>
      <form
        className="flex min-w-0 flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {props.mode === 'create' ? (
          <label className="flex flex-col gap-1 text-sm">
            <span>{t('cal.fieldCalendar')}</span>
            <select
              className="field"
              data-testid="cal-dialog-calendar"
              value={calendarId}
              onChange={(e) => setCalendarId(e.target.value)}
            >
              {props.calendars.map((c) => (
                // the calendar name is UNTRUSTED text: an <option> renders it as text only (never markup, never an attribute)
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex flex-col gap-1 text-sm">
          <span>{t('cal.fieldTitle')}</span>
          <input
            ref={firstRef}
            className="field msg-text"
            dir="auto"
            data-testid="cal-dialog-title"
            maxLength={LIMITS.titleChars}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <label className="flex flex-col gap-1 text-sm">
            <span>{t('cal.fieldDate')}</span>
            <input
              type="date"
              className="field tnum"
              data-testid="cal-dialog-date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t('cal.fieldStart')}</span>
            <input
              ref={timeRef}
              type="time"
              className="field tnum"
              data-testid="cal-dialog-start"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t('cal.fieldEnd')}</span>
            <input
              type="time"
              className="field tnum"
              data-testid="cal-dialog-end"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span>{t('cal.fieldLocation')}</span>
          <input
            className="field msg-text"
            dir="auto"
            data-testid="cal-dialog-location"
            maxLength={LIMITS.locationChars}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
        </label>
        {invalid !== null || props.error !== null ? (
          <p className="m-0 text-sm text-danger" role="alert" data-testid="cal-dialog-error">
            {invalid === 'title'
              ? t('cal.invalidTitle')
              : invalid === 'time'
                ? t('cal.invalidTime')
                : t(`errors.${props.error!}.title`)}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary" data-testid="cal-dialog-submit" disabled={props.busy}>
            {t('cal.save')}
          </button>
          <button type="button" className="btn btn-quiet" data-testid="cal-dialog-cancel" onClick={props.onCancel}>
            {t('app.cancel')}
          </button>
        </div>
      </form>
    </div>
  );
}
