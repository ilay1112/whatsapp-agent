// src/renderer/src/components/EventEditor.tsx - event block + EventChip (UX 6.4, 7.2, 7.3; owner W1-15).
// Every piece of chrome (weekday, day, month, time range) is produced by the APP from structured fields through Intl -
// never by the model - so the date tab is trusted; only the title and the location are untrusted and get `msg-text`.
//
// [V2] (owner V2-W1-11) `mode: 'change'` edits the Change card's `to` only (I3'): the target event is pinned, so there
// is no calendar line, and the title is read-only - title changes are not applied in v2.0 (B20, F40). EventChip gains
// the states `updated` ("Updated · rev N") and `cancelled` (struck title + the word, never colour alone) (UX2 3.4).
import { useEffect, useId, useRef, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { LIMITS, type Badge, type EventState, type MissingField, type ProposedEvent } from '@shared/types';
import { EventEditSchema, type EventEdit } from '@shared/schemas';
import { makeFormatters, formatTimeRange } from '@shared/i18n/format';
import { localToEpochMs } from '@shared/when';
import { Badges } from './Badges';

/** Renderer event view model (UX 14): the persisted ProposedEvent plus its state and whether a calendar link exists. */
export interface EventVM extends ProposedEvent {
  state: Exclude<EventState, 'none'>;
  hasCalendarLink: boolean;
  /** [V2] Calendar revision of a created / updated event ("Updated · rev N"). */
  revision?: number;
}
export interface EventEditorProps {
  value: EventVM;
  missing: MissingField[];
  mode: 'edit' | 'fill' | 'readonly' | 'change';
  calendarName: string;
  onChange(v: EventEdit): void;
  onValidityChange(ok: boolean, message?: string): void;
  focusField?: 'title' | 'date' | 'start' | 'end' | 'location';
  /** [V2] App-text hint under the Date field, linked by aria-describedby ("Check against the picture", UX2 3.6). */
  dateNote?: string;
}

const MONTH_AHEAD_MS = LIMITS.eventHorizonMonths * 31 * 24 * 3600_000;
type FieldKey = 'title' | 'date' | 'start' | 'end' | 'location';
interface Fields {
  title: string;
  date: string;
  start: string;
  end: string;
  location: string;
}

export function fieldsOf(e: ProposedEvent): Fields {
  return {
    title: e.title,
    date: e.startLocal !== '' ? e.startLocal.slice(0, 10) : e.dateHint,
    start: e.startLocal !== '' ? e.startLocal.slice(11, 16) : '',
    end: e.endLocal !== '' ? e.endLocal.slice(11, 16) : '',
    location: e.location,
  };
}

function editOf(f: Fields): EventEdit {
  return {
    title: f.title.trim(),
    startLocal: f.date !== '' && f.start !== '' ? `${f.date}T${f.start}:00` : '',
    endLocal: f.date !== '' && f.end !== '' ? `${f.date}T${f.end}:00` : '',
    location: f.location.trim(),
  } as EventEdit;
}

/** UX 7.2: the sanity rules of S2, mirrored inline so the user never sends an event main would reject. */
export function validateFields(f: Fields, timeZone: string, nowMs: number): { ok: true } | { ok: false; key?: string } {
  const candidate = editOf(f);
  if (!EventEditSchema.safeParse(candidate).success) {
    if (candidate.startLocal !== '' && candidate.endLocal !== '' && candidate.endLocal <= candidate.startLocal) {
      return { ok: false, key: 'event.error.endBeforeStart' };
    }
    return { ok: false };
  }
  const start = localToEpochMs(candidate.startLocal, timeZone);
  const end = localToEpochMs(candidate.endLocal, timeZone);
  if (start < nowMs) return { ok: false, key: 'event.error.past' };
  const minutes = Math.round((end - start) / 60_000);
  if (minutes < LIMITS.eventMinMin || minutes > LIMITS.eventMaxMin) return { ok: false, key: 'event.error.duration' };
  if (start - nowMs > MONTH_AHEAD_MS) return { ok: false, key: 'event.error.tooFar' };
  return { ok: true };
}

export function EventEditor(props: EventEditorProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'he' ? 'he' : 'en';
  const [fields, setFields] = useState<Fields>(() => fieldsOf(props.value));
  const [unlocked, setUnlocked] = useState<FieldKey[]>([]);
  const errorId = useId();
  const dateNoteId = useId();
  // Held as separate consts, not as a `refs` object: `react-hooks/refs` forbids reading `refs.date` during render.
  const titleRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const startRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLInputElement>(null);
  const locationRef = useRef<HTMLInputElement>(null);

  // Snapshotted once per mount: "that time has already passed" must not flip mid-edit because the component re-rendered.
  const [nowMs] = useState(() => Date.now());
  const verdict = validateFields(fields, props.value.timeZone, nowMs);
  const message = verdict.ok ? undefined : verdict.key ? t(verdict.key) : undefined;

  const reported = useRef<string>('');
  useEffect(() => {
    const signature = `${verdict.ok ? '1' : '0'}|${message ?? ''}`;
    if (reported.current === signature) return;
    reported.current = signature;
    props.onValidityChange(verdict.ok, message);
  });

  const focusField = props.focusField;
  useEffect(() => {
    if (!focusField) return;
    const target = { title: titleRef, date: dateRef, start: startRef, end: endRef, location: locationRef }[focusField];
    target.current?.focus();
  }, [focusField]);

  const set = (key: FieldKey, v: string): void => {
    const next = { ...fields, [key]: v };
    setFields(next);
    props.onChange(editOf(next));
  };

  const readonly = props.mode === 'readonly';
  /** "fill" only opens the fields listed in `missing[]`; the known ones are read-only text with a quiet "Change". */
  const editable = (key: FieldKey): boolean => {
    if (readonly) return false;
    if (props.mode === 'change') return key !== 'title'; // F40: a delta never takes a new title
    if (props.mode === 'edit') return true;
    if (unlocked.includes(key)) return true;
    switch (key) {
      case 'date':
        return props.missing.includes('date') || fields.date === '';
      case 'start':
      case 'end':
        return (
          props.missing.includes('time') ||
          props.missing.includes('duration') ||
          fields.start === '' ||
          fields.end === ''
        );
      case 'location':
        return props.missing.includes('location') || fields.location === '';
      default:
        return fields.title === '';
    }
  };

  const row = (key: FieldKey, label: string, input: JSX.Element, text: string): JSX.Element => (
    <div className="flex flex-wrap items-center gap-2" key={key}>
      <span className="min-w-16 text-xs text-text-muted">{label}</span>
      {editable(key) ? (
        <>
          {input}
          {props.mode === 'fill' && !unlocked.includes(key) ? (
            <span className="chip" data-testid={`event-needed-${key}`}>
              {t('event.needed')}
            </span>
          ) : null}
        </>
      ) : (
        <>
          <span className="msg-text grow" dir="auto" data-testid={`event-readonly-${key}`}>
            {text}
          </span>
          {readonly || (props.mode === 'change' && key === 'title') ? null : (
            <button
              type="button"
              className="btn btn-quiet"
              data-testid={`event-change-${key}`}
              onClick={() => setUnlocked([...unlocked, key])}
            >
              {t('event.change')}
            </button>
          )}
        </>
      )}
    </div>
  );

  return (
    <div data-testid="event-editor" data-mode={props.mode} className="flex flex-col gap-2">
      {props.missing.length > 0 ? (
        <p className="m-0 text-xs text-text-muted" data-testid="event-missing">
          {t('event.missing', {
            fields: makeFormatters(lang).list.format(props.missing.map((m) => t(`missing.${m}`))),
          })}
        </p>
      ) : null}

      {row(
        'title',
        t('event.field.title'),
        <input
          ref={titleRef}
          className="field msg-text grow"
          dir="auto"
          type="text"
          maxLength={LIMITS.titleChars}
          value={fields.title}
          aria-label={t('event.field.title')}
          aria-invalid={!verdict.ok && fields.title.trim() === ''}
          data-testid="event-title"
          onChange={(e) => set('title', e.target.value)}
        />,
        fields.title,
      )}
      {row(
        'date',
        t('event.field.date'),
        <input
          ref={dateRef}
          className="field tnum grow"
          type="date"
          value={fields.date}
          aria-label={t('event.field.date')}
          aria-describedby={props.dateNote !== undefined ? dateNoteId : undefined}
          data-testid="event-date"
          onChange={(e) => set('date', e.target.value)}
        />,
        fields.date,
      )}
      {props.dateNote !== undefined ? (
        <p id={dateNoteId} className="note-amber m-0 text-xs" data-testid="event-date-note">
          {props.dateNote}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {row(
          'start',
          t('event.field.from'),
          <input
            ref={startRef}
            className="field tnum w-28"
            type="time"
            value={fields.start}
            aria-label={t('event.field.from')}
            data-testid="event-start"
            onChange={(e) => set('start', e.target.value)}
          />,
          fields.start,
        )}
        {row(
          'end',
          t('event.field.to'),
          <input
            ref={endRef}
            className="field tnum w-28"
            type="time"
            value={fields.end}
            aria-label={t('event.field.to')}
            data-testid="event-end"
            onChange={(e) => set('end', e.target.value)}
          />,
          fields.end,
        )}
      </div>
      {row(
        'location',
        t('event.field.where'),
        <input
          ref={locationRef}
          className="field msg-text grow"
          dir="auto"
          type="text"
          maxLength={LIMITS.locationChars}
          value={fields.location}
          aria-label={t('event.field.where')}
          data-testid="event-location"
          onChange={(e) => set('location', e.target.value)}
        />,
        fields.location,
      )}

      {props.mode === 'change' ? (
        <p className="m-0 text-xs text-text-muted" data-testid="event-title-not-applied">
          {t('change.titleNotApplied')}
        </p>
      ) : null}

      {message !== undefined ? (
        <p id={errorId} role="alert" className="m-0 text-xs text-danger" data-testid="event-error">
          {message}
        </p>
      ) : null}
      {/* UX 7.2: the target calendar name, read-only here. The name is UNTRUSTED (CONTRACTS `CalendarInfo.name`) and
          may be a Latin id when Google could not be reached, so it is isolated in its own <bdi> - otherwise it
          reorders the Hebrew sentence around it (UX 2.5 item 3, the same rule Settings already follows). */}
      {props.mode === 'change' ? null : (
        <p className="m-0 text-xs text-text-muted" data-testid="event-calendar">
          {t('event.calendarLabel')} <bdi>{props.calendarName}</bdi> - {t('event.noInvites')}
        </p>
      )}
    </div>
  );
}

export interface EventChipProps {
  event: EventVM;
  badges: Badge[];
  onOpen(): void;
}

/** The signature date tab (UX 6.4). Not an approval: it opens the sheet with the EventEditor focused. */
export function EventChip(props: EventChipProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'he' ? 'he' : 'en';
  const e = props.event;
  if (e.state === 'declined') return null;

  const dateSource = e.startLocal !== '' ? e.startLocal : e.dateHint !== '' ? `${e.dateHint}T12:00:00` : '';
  const parts =
    dateSource === ''
      ? null
      : makeFormatters(lang, e.timeZone).dayShort.formatToParts(new Date(localToEpochMs(dateSource, e.timeZone)));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts?.find((p) => p.type === type)?.value ?? '--';

  const complete = e.startLocal !== '' && e.endLocal !== '';
  const range = complete
    ? formatTimeRange(
        localToEpochMs(e.startLocal, e.timeZone),
        localToEpochMs(e.endLocal, e.timeZone),
        lang,
        e.timeZone,
      )
    : t('event.timeUnknown');

  const headerTone =
    e.state === 'created' || e.state === 'updated'
      ? 'bg-ok text-surface'
      : e.state === 'proposed' || e.state === 'change_proposed'
        ? 'bg-accent text-on-accent'
        : 'bg-line-strong text-surface';
  const cancelled = e.state === 'cancelled';

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        data-testid="event-chip"
        data-state={e.state}
        aria-label={t('event.editDetails')}
        className={`focus-ring flex w-full items-start gap-2 rounded-sm border bg-surface p-1 text-start ${
          e.state === 'incomplete' ? 'border-dashed border-line-strong' : 'border-line'
        }`}
        onClick={props.onOpen}
      >
        <span className="flex w-12 shrink-0 flex-col items-center overflow-hidden rounded-xs border border-line-strong">
          <span className={`w-full text-center text-xs font-semibold ${headerTone}`} data-testid="event-chip-weekday">
            {part('weekday')}
          </span>
          <span className="tnum text-lg font-semibold" data-testid="event-chip-day">
            {part('day')}
          </span>
          <span className="text-xs text-text-muted" data-testid="event-chip-month">
            {part('month')}
          </span>
        </span>
        <span className="min-w-0 grow">
          <span
            className={`msg-text block truncate font-semibold${cancelled ? ' event-cancelled' : ''}`}
            dir="auto"
            data-testid="event-chip-title"
          >
            {e.title}
          </span>
          <span className="tnum block text-sm text-text-muted" data-testid="event-chip-range">
            {range}
          </span>
          {e.location !== '' ? (
            <span className="msg-text block text-sm text-text-muted" dir="auto" data-testid="event-chip-location">
              {e.location}
            </span>
          ) : null}
          {e.state === 'created' ? (
            <span className="block text-sm text-ok" data-testid="event-chip-created">
              {t('event.inCalendar')}
            </span>
          ) : null}
          {e.state === 'updated' ? (
            <span className="block text-sm text-ok" data-testid="event-chip-updated">
              <span data-testid="event-chip-rev">{t('event.updatedRev', { n: e.revision ?? 1 })}</span>
            </span>
          ) : null}
          {cancelled ? (
            <span className="block text-sm text-text-muted" data-testid="event-chip-cancelled">
              {t('event.cancelled')}
            </span>
          ) : null}
        </span>
      </button>
      <Badges codes={props.badges} scope="event" />
    </div>
  );
}
