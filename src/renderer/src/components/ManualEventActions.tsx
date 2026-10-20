// src/renderer/src/components/ManualEventActions.tsx - [v4 T7] T-908 handover §2.5 (I1', I9'): the calendar view's manual
// management - "New event", the popover buttons (Edit / Move / Delete / Undo last change), the form (ManualEventDialog) and the
// confirm step (`cal-confirm`).
//
// Flow, every time: form -> calendar:propose* (main creates ONE pending source:'manual' action and writes NOTHING) -> the confirm
// step shows main's app-built summary (old -> new) -> Confirm = action:approve {actionId, kind, shownHash} (the click IS the
// approval; nothing executes on propose). Done -> the global toast with Undo (action:undo {actionId}) and a re-read of the week.
// Events are named by (calendarId, opaque eventKey) only - the renderer never has a Google event id (ARCH-v2 10); a key main no
// longer holds answers CAL_EVENT_GONE, and the view re-reads the week so the user can try again.
// I9' in the UI is a hint only: an entry with refusal reasons gets its buttons disabled with the reason (`manageRefusals`); main
// refuses the same cases in code (CAL_EVENT_FOREIGN_PROTECTED).
// Untrusted text (titles, calendar names) only inside <bdi className="msg-text" dir="auto">, never in an attribute.
import { useCallback, useMemo, useState, type JSX, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { CalendarInfo, EpochMs, EventContentView, Lang, ManualProposal } from '@shared/types';
import type { ErrorCode } from '@shared/errors';
import { epochMsToLocal, localToEpochMs, todayIn } from '@shared/when';
import { formatTimeRange } from '@shared/i18n/format';
import { api } from '../api';
import { useDashboardStore } from '../store/dashboard';
import { manageRefusals, type ForeignCalendarEntry } from '../store/calendarEntries';
import { renderBdiTemplate, SENTINEL } from './ItemCard.bdi';
import { ManualEventDialog, type ManualEventFields } from './ManualEventDialog';

const DONE_KEY = {
  create: 'cal.doneCreate',
  edit: 'cal.doneEdit',
  delete: 'cal.doneDelete',
  undo: 'cal.doneUndo',
} as const;

interface Form {
  mode: 'create' | 'edit' | 'move';
  entry: ForeignCalendarEntry | null;
  initial: ManualEventFields;
}

export interface ManualEvents {
  /** "New event" (`cal-new-event`), or null when no calendar of the account is writable. */
  newEventButton: ReactNode;
  /** The popover footer of one foreign event. */
  actionsFor(entry: ForeignCalendarEntry): ReactNode;
  /** The form / confirm panel (rendered by the view above the grid), or null. */
  panel: ReactNode;
}

/** The confirm step (`cal-confirm`): main's summary of the pending action, Confirm approves it. */
function ConfirmPanel(props: {
  proposal: ManualProposal;
  calendarName: string;
  lang: Lang;
  busy: boolean;
  error: ErrorCode | null;
  onConfirm(): void;
  onCancel(): void;
}): JSX.Element {
  const { t } = useTranslation();
  const { summary } = props.proposal;
  const line = (label: string, v: EventContentView, testId: string): JSX.Element => (
    <p className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm" data-testid={testId}>
      <span className="text-text-muted">{label}</span>
      <bdi className="msg-text min-w-0 truncate font-semibold" dir="auto">
        {v.title}
      </bdi>
      <span className="tnum">
        {formatTimeRange(
          localToEpochMs(v.startLocal, v.timeZone),
          localToEpochMs(v.endLocal, v.timeZone),
          props.lang,
          v.timeZone,
        )}
      </span>
      {v.location !== '' ? (
        <bdi className="msg-text min-w-0 truncate" dir="auto">
          {v.location}
        </bdi>
      ) : null}
    </p>
  );
  const question =
    summary.op === 'create'
      ? renderBdiTemplate(t('cal.confirmCreate', { calendar: SENTINEL(0) }), [
          <bdi key="c" className="msg-text" dir="auto">
            {props.calendarName}
          </bdi>,
        ])
      : summary.op === 'delete'
        ? t('cal.confirmDelete')
        : t('cal.confirmEdit');
  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label={t('cal.confirm')}
      data-testid="cal-confirm"
      data-op={summary.op}
      className="flex min-w-0 flex-col gap-2 rounded-md border border-line bg-surface p-3 shadow-pop"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          props.onCancel();
        }
      }}
    >
      <h3 className="m-0 text-base font-semibold" data-testid="cal-confirm-question">
        {question}
      </h3>
      {summary.before !== null ? line(t('cal.before'), summary.before, 'cal-confirm-before') : null}
      {summary.after !== null
        ? line(summary.before !== null ? t('cal.after') : '', summary.after, 'cal-confirm-after')
        : null}
      {props.error !== null ? (
        <p className="m-0 text-sm text-danger" role="alert" data-testid="cal-confirm-error">
          {t(`errors.${props.error}.title`)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-primary"
          data-testid="cal-confirm-ok"
          disabled={props.busy}
          autoFocus
          onClick={props.onConfirm}
        >
          {summary.op === 'delete' ? t('cal.delete') : t('cal.confirm')}
        </button>
        <button type="button" className="btn btn-quiet" data-testid="cal-confirm-cancel" onClick={props.onCancel}>
          {t('app.cancel')}
        </button>
      </div>
    </div>
  );
}

export function useManualEvents(p: {
  calendars: CalendarInfo[];
  lang: Lang;
  timeZone: string;
  /** a day inside the visible week (the default date of a new event) */
  weekStartMs: EpochMs;
  nowMs: EpochMs;
  /** calendar:invalidate + re-read of the week */
  refresh(): void;
  /** closes the event popover (the form / confirm replace it) */
  closePopover(): void;
}): ManualEvents {
  const { t } = useTranslation();
  const setToast = useDashboardStore((s) => s.setToast);
  const [form, setForm] = useState<Form | null>(null);
  const [proposal, setProposal] = useState<ManualProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const writable = useMemo(() => p.calendars.filter((c) => c.writable), [p.calendars]);
  const nameOf = useCallback((id: string) => p.calendars.find((c) => c.id === id)?.name ?? '', [p.calendars]);

  const close = useCallback((): void => {
    setForm(null);
    setProposal(null);
    setError(null);
    setBusy(false);
  }, []);

  /** [v4 review fix] Cancel on the confirm step: the pending proposal is rejected (action:reject, the same door a card's
   *  "Keep" uses) instead of waiting for the next propose or the 24 h expiry. Best effort: a failure leaves it pending, which
   *  still needs a click and the shownHash. */
  const cancelProposal = useCallback((): void => {
    if (proposal !== null) void api.reject(proposal.actionId).catch(() => undefined);
    close();
  }, [proposal, close]);

  /** The outcome of an executed manual action / undo: toast (+ Undo while main offers it), re-read the week. */
  const announce = useCallback(
    (op: keyof typeof DONE_KEY, actionId: string, undoable: boolean): void => {
      p.refresh();
      setToast({
        key: DONE_KEY[op],
        ...(undoable
          ? {
              onUndo: () => {
                void api.undoManual(actionId).then((r) => {
                  p.refresh();
                  setToast({ key: r.ok && r.value.outcome === 'done' ? DONE_KEY.undo : 'cal.undoUnavailable' });
                });
              },
            }
          : {}),
      });
    },
    [p, setToast],
  );

  const failedProposal = useCallback(
    (code: ErrorCode): void => {
      setError(code);
      setBusy(false);
      if (code === 'CAL_EVENT_GONE') p.refresh(); // the week cache moved on: read again, the user retries
    },
    [p],
  );

  const submit = useCallback(
    (fields: ManualEventFields): void => {
      if (form === null) return;
      setBusy(true);
      setError(null);
      const entry = form.entry;
      let req: Promise<Awaited<ReturnType<typeof api.proposeCreate>>>;
      if (entry === null) {
        req = api.proposeCreate(fields);
      } else {
        const before = form.initial;
        const patch: { title?: string; startLocal?: string; endLocal?: string; location?: string } = {};
        if (fields.title !== before.title) patch.title = fields.title;
        if (fields.location !== before.location) patch.location = fields.location;
        if (fields.startLocal !== before.startLocal || fields.endLocal !== before.endLocal) {
          patch.startLocal = fields.startLocal;
          patch.endLocal = fields.endLocal;
        }
        if (Object.keys(patch).length === 0) {
          close();
          return;
        }
        req = api.proposeEdit({ calendarId: entry.calendarId, eventKey: entry.eventKey, patch });
      }
      void req.then((r) => {
        if (!r.ok) return failedProposal(r.error.code);
        setBusy(false);
        setForm(null);
        setProposal(r.value);
      });
    },
    [form, close, failedProposal],
  );

  const proposeDelete = useCallback(
    (entry: ForeignCalendarEntry): void => {
      p.closePopover();
      setForm(null);
      setError(null);
      setBusy(true);
      setProposal(null);
      void api.proposeDelete({ calendarId: entry.calendarId, eventKey: entry.eventKey }).then((r) => {
        setBusy(false);
        if (!r.ok) {
          // no form to show the refusal in: the confirm panel is not opened, the toast says why
          if (r.error.code === 'CAL_EVENT_GONE') p.refresh();
          setToast({ key: `errors.${r.error.code}.title` });
          return;
        }
        setProposal(r.value);
      });
    },
    [p, setToast],
  );

  const confirm = useCallback((): void => {
    if (proposal === null) return;
    setBusy(true);
    setError(null);
    void api
      .approveManual({ actionId: proposal.actionId, kind: proposal.kind, shownHash: proposal.shownHash })
      .then((r) => {
        if (!r.ok) {
          setBusy(false);
          setError(r.error.code);
          if (r.error.code === 'ACTION_STALE' || r.error.code === 'CAL_EVENT_GONE') p.refresh();
          return;
        }
        if (r.value.outcome !== 'done') {
          setBusy(false);
          setError(r.value.manual.errorCode ?? 'CAL_UPDATE_FAILED');
          p.refresh();
          return;
        }
        const { op, actionId, undoable } = r.value.manual;
        close();
        announce(op, actionId, undoable);
      });
  }, [proposal, p, close, announce]);

  const openForm = useCallback(
    (mode: Form['mode'], entry: ForeignCalendarEntry | null): void => {
      p.closePopover();
      setProposal(null);
      setError(null);
      if (entry === null) {
        const today = todayIn(p.timeZone, p.nowMs);
        const weekDay = epochMsToLocal(p.weekStartMs, p.timeZone).slice(0, 10);
        const day = p.nowMs >= p.weekStartMs && p.nowMs < p.weekStartMs + 7 * 86_400_000 ? today : weekDay;
        setForm({
          mode,
          entry: null,
          initial: {
            calendarId: writable[0]?.id ?? '',
            title: '',
            startLocal: `${day}T09:00:00`,
            endLocal: `${day}T10:00:00`,
            location: '',
          },
        });
        return;
      }
      setForm({
        mode,
        entry,
        initial: {
          calendarId: entry.calendarId,
          title: entry.title,
          startLocal: epochMsToLocal(entry.startMs, p.timeZone),
          endLocal: epochMsToLocal(entry.endMs, p.timeZone),
          location: entry.location, // [v4 review fix] visible and clearable (UNTRUSTED, only ever an input value)
        },
      });
    },
    [p, writable],
  );

  const undoLast = useCallback(
    (entry: ForeignCalendarEntry): void => {
      if (entry.undoActionId === null) return;
      p.closePopover();
      void api.undoManual(entry.undoActionId).then((r) => {
        p.refresh();
        setToast({ key: r.ok && r.value.outcome === 'done' ? DONE_KEY.undo : 'cal.undoUnavailable' });
      });
    },
    [p, setToast],
  );

  const actionsFor = useCallback(
    (entry: ForeignCalendarEntry): ReactNode => {
      const blocked = manageRefusals(entry).length > 0;
      return (
        <>
          <button
            type="button"
            className="btn btn-outline"
            data-testid="cal-action-edit"
            disabled={blocked}
            onClick={() => openForm('edit', entry)}
          >
            {t('cal.edit')}
          </button>
          <button
            type="button"
            className="btn btn-outline"
            data-testid="cal-action-move"
            disabled={blocked}
            onClick={() => openForm('move', entry)}
          >
            {t('cal.move')}
          </button>
          <button
            type="button"
            className="btn btn-outline"
            data-testid="cal-action-delete"
            disabled={blocked}
            onClick={() => proposeDelete(entry)}
          >
            {t('cal.delete')}
          </button>
          {entry.undoActionId !== null ? (
            <button
              type="button"
              className="btn btn-quiet"
              data-testid="cal-action-undo"
              onClick={() => undoLast(entry)}
            >
              {t('cal.undoLast')}
            </button>
          ) : null}
        </>
      );
    },
    [openForm, proposeDelete, undoLast, t],
  );

  const newEventButton =
    writable.length === 0 ? null : (
      <button
        type="button"
        className="btn btn-outline"
        data-testid="cal-new-event"
        onClick={() => openForm('create', null)}
      >
        {t('cal.newEvent')}
      </button>
    );

  const panel =
    form !== null ? (
      <ManualEventDialog
        key={`${form.mode}|${form.entry?.eventKey ?? 'new'}`}
        mode={form.mode}
        calendars={form.entry === null ? writable : p.calendars.filter((c) => c.id === form.entry!.calendarId)}
        initial={form.initial}
        timeZone={p.timeZone}
        busy={busy}
        error={error}
        onSubmit={submit}
        onCancel={close}
      />
    ) : proposal !== null ? (
      <ConfirmPanel
        proposal={proposal}
        calendarName={nameOf(proposal.summary.calendarId)}
        lang={p.lang}
        busy={busy}
        error={error}
        onConfirm={confirm}
        onCancel={cancelProposal}
      />
    ) : null;

  return { newEventButton, actionsFor, panel };
}
