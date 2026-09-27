// src/renderer/src/components/ItemCard.tsx - card anatomy 6.5 / approval sheet 7 (UX 14.2; owner W1-15).
//
// APPROVAL-FIRST RULES ENFORCED HERE (ARCH 6.6, UX 6.8):
//   - two buttons = two approvals; each click sends exactly ONE `action:approve` with the `shownHash` of the view model
//     that was rendered and the textarea / event-editor content at click time;
//   - NO optimistic UI for send/create: the card spins until main answers;
//   - a second synchronous click sends nothing (`busyRef` is set before the first await, `event.detail > 1` is ignored);
//   - [R2] every approval control ignores click / Enter / Space while the focus guard is armed (500 ms after the window
//     gained focus or became visible) - read at CLICK time, never at render time;
//   - `approve` is never called from an effect, a timer, a toast or a shortcut. Ctrl+Enter only moves focus.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ActionKind, ActionView, ItemCard as ItemVM, ItemDetail as ItemDetailVM } from '@shared/types';
import type { ErrorCode } from '@shared/errors';
import type { EventEdit } from '@shared/schemas';
import { DEFAULT_TIME_ZONE, formatDayLabel, formatTime, makeFormatters } from '@shared/i18n/format';
import { api } from '../api';
import { isActivationBlocked } from '../store/health';
import { calendarNameOf, useSettingsStore } from '../store/settings';
import { useDashboardStore } from '../store/dashboard';
import { Badges } from './Badges';
import { DraftBox } from './DraftBox';
import { EventChip, EventEditor, fieldsOf, validateFields, type EventVM } from './EventEditor';
import { QuotedBubble } from './QuotedBubble';

export interface ItemCardProps {
  item: ItemVM | ItemDetailVM;
  mode: 'compact' | 'expanded';
  onOpen?(): void;
  onClose?(): void;
}

/** After 10 s of "Sending..." a muted explanation appears (the send queue spaces sends out by 3-8 s). */
const STILL_SENDING_MS = 10_000;
/** The confirmation row is shown for 1.2 s before the list refresh takes the card away (UX 6.8). */
const CONFIRM_MS = 1_200;
const COPIED_MS = 2_000;

export interface ResultAction {
  label: string;
  testId: string;
  /**
   * True for a row action that issues `action:approve` ("Add anyway", "Create anyway", "Send again", "Add again").
   * [R2] those are approval controls by name (UX 6.8), so ResultRowView puts them behind the same activation gate as
   * ApproveButton. "Refresh card" / "Change time" are not approvals and must stay clickable while the guard is armed.
   */
  approving?: true;
  run(): void;
}
export interface ResultRow {
  tone: 'ok' | 'error';
  text: string;
  actions: ResultAction[];
}

// ---------------------------------------------------------------------------------------------------------------------
// locale templates with <bdi> markup
// ---------------------------------------------------------------------------------------------------------------------
/** Private-use delimiters: an interpolated value can never collide with them, and they are invisible if one leaks. */
export const SENTINEL = (index: number): string => `${index}`;
const SENTINEL_RE = /(<bdi(?: dir="(?:ltr|rtl)")?>)?(\d)(<\/bdi>)?/g;

/**
 * Renders a locale value whose ONLY markup is `<bdi>` / `<bdi dir="ltr">` around interpolated values.
 * `<Trans>` is deliberately not used: it interpolates first and parses the RESULT as HTML, so an untrusted contact name
 * containing `<img src=x onerror=...>` would be parsed into nodes. Here the untrusted values never touch the template -
 * they are handed to React as children (UX 16.5).
 */
export function renderBdiTemplate(raw: string, values: readonly ReactNode[]): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  SENTINEL_RE.lastIndex = 0;
  for (let m = SENTINEL_RE.exec(raw); m !== null; m = SENTINEL_RE.exec(raw)) {
    if (m.index > last) out.push(raw.slice(last, m.index));
    const node = values[Number(m[2])] ?? null;
    const dir = m[1] !== undefined && m[1].includes('dir="ltr"') ? 'ltr' : undefined;
    out.push(
      <bdi key={key++} dir={dir}>
        {node}
      </bdi>,
    );
    last = SENTINEL_RE.lastIndex;
  }
  if (last < raw.length) out.push(raw.slice(last));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// [R2] the ONE activation gate every approval control shares (ARCH 13, UX 6.8)
// ---------------------------------------------------------------------------------------------------------------------
/** Mouse half: the second click of a dblclick never approves, and neither does a click that woke the window. */
function activationRefused(e: React.MouseEvent<HTMLButtonElement>): boolean {
  return e.detail > 1 || isActivationBlocked(); // read at CLICK time, never at render time
}
/** Keyboard half: Enter / Space must not activate an approval control while the guard is armed. */
function refuseBlockedKey(e: React.KeyboardEvent<HTMLButtonElement>): void {
  if ((e.key === 'Enter' || e.key === ' ') && isActivationBlocked()) e.preventDefault();
}

// ---------------------------------------------------------------------------------------------------------------------
// controller - shared by ItemCard and RawCard
// ---------------------------------------------------------------------------------------------------------------------
export function pendingAction(item: ItemVM, kind: ActionKind): ActionView | null {
  return item.actions.find((a) => a.kind === kind && a.state === 'pending') ?? null;
}

function eventVmOf(item: ItemVM): EventVM | null {
  if (!item.event || item.eventState === 'none' || item.eventState === 'declined') return null;
  return { ...item.event, state: item.eventState, hasCalendarLink: item.calendar !== null };
}

export interface CardController {
  draft: string;
  setDraft(v: string): void;
  eventEdit: EventEdit | null;
  setEventEdit(e: EventEdit): void;
  eventValid: boolean;
  eventMessage: string | undefined;
  setEventValidity(ok: boolean, message?: string): void;
  busyKind: ActionKind | null;
  stillSending: boolean;
  result: ResultRow | null;
  setResult(r: ResultRow | null): void;
  resultRef: React.RefObject<HTMLDivElement | null>;
  copied: boolean;
  stale: boolean;
  focusedInputs: boolean;
  onInputFocus(focused: boolean): void;
  approveHandlers(
    action: ActionView,
    extra?: { confirmConflict?: true; confirmDuplicate?: true },
  ): {
    onClick(e: React.MouseEvent<HTMLButtonElement>): void;
    onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>): void;
  };
  copy(): void;
  dismiss(): void;
  retriage(): void;
  refreshCard(): void;
}

/**
 * All card behaviour that RawCard and ItemCard share. Lives in this file because UX 14.2 forbids new component files.
 * `onChangeTime` is the card's own "take me to the event fields" move; the conflict row of UX 6.8 offers it next to
 * "Add anyway". A card with no event block (RawCard) leaves it out and the row simply has one action fewer.
 */
export function useCardController(item: ItemVM, onClose?: () => void, onChangeTime?: () => void): CardController {
  const { t } = useTranslation();
  const markDirty = useDashboardStore((s) => s.markDirty);
  const markStale = useDashboardStore((s) => s.markStale);
  const setToast = useDashboardStore((s) => s.setToast);
  const stale = useDashboardStore((s) => s.staleItemIds.has(item.itemId));

  const suggestion = item.draft?.text ?? '';
  const [draft, setDraftState] = useState(suggestion);
  const [eventEdit, setEventEditState] = useState<EventEdit | null>(null);
  const [eventValid, setEventValid] = useState(true);
  const [eventMessage, setEventMessage] = useState<string | undefined>(undefined);
  const [busyKind, setBusyKind] = useState<ActionKind | null>(null);
  const [stillSending, setStillSending] = useState(false);
  const [result, setResult] = useState<ResultRow | null>(null);
  const [copied, setCopied] = useState(false);
  const [focusedInputs, setFocusedInputs] = useState(false);
  const resultRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  const focusResultRef = useRef(false);

  const dirty = focusedInputs || draft !== suggestion;
  useEffect(() => {
    markDirty(item.itemId, dirty);
  }, [dirty, item.itemId, markDirty]);

  // The flag is only ever RAISED here; it is lowered in the click handler that starts the next approval, because a
  // synchronous setState inside an effect would cost a cascading render on every busy -> idle transition.
  useEffect(() => {
    if (busyKind === null) return;
    const timer = setTimeout(() => setStillSending(true), STILL_SENDING_MS);
    return () => clearTimeout(timer);
  }, [busyKind]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  // UX 13.3: after a failure focus moves to the inline result row (tabindex="-1", role="alert").
  useEffect(() => {
    if (result?.tone === 'error' && focusResultRef.current) {
      focusResultRef.current = false;
      resultRef.current?.focus();
    }
  }, [result]);

  const setDraft = useCallback((v: string) => setDraftState(v), []);
  const setEventEdit = useCallback((e: EventEdit) => setEventEditState(e), []);
  const setEventValidity = useCallback((ok: boolean, message?: string) => {
    setEventValid(ok);
    setEventMessage(message);
  }, []);

  const onInputFocus = useCallback(
    (focused: boolean) => {
      setFocusedInputs(focused);
      void api.setEditing(item.itemId, focused);
    },
    [item.itemId],
  );

  const refreshCard = useCallback(() => {
    markStale(item.itemId, false);
    markDirty(item.itemId, false);
    setDraftState(item.draft?.text ?? '');
    setResult(null);
    void useDashboardStore.getState().refresh();
    void useDashboardStore.getState().reloadOpenItem();
  }, [item.draft?.text, item.itemId, markDirty, markStale]);

  const dismiss = useCallback(() => {
    // Not a send or a create, so the optimistic removal of UX 6.8 is allowed.
    void api.dismiss(item.itemId).then(() => void useDashboardStore.getState().refresh());
    setToast({ key: 'action.dismissed', itemId: item.itemId });
    onClose?.();
  }, [item.itemId, onClose, setToast]);

  /** The recovery rows re-enter the same flow with `confirmConflict` / `confirmDuplicate`; the ref breaks the cycle. */
  const runApproveRef = useRef<
    ((action: ActionView, extra?: { confirmConflict?: true; confirmDuplicate?: true }) => Promise<void>) | null
  >(null);

  /**
   * The single-flight lock and the busy chrome that EVERY approval shares, whether it starts at an ApproveButton or at
   * a recovery button of the result row. The [R2] activation gate is NOT here: it has to be read at activation time by
   * the control itself (`approveHandlers`, `ResultRowView`).
   */
  const startApprove = useCallback(
    (action: ActionView, extra?: { confirmConflict?: true; confirmDuplicate?: true }): void => {
      if (busyRef.current) return; // a second synchronous click sends nothing
      busyRef.current = true;
      setBusyKind(action.kind);
      setStillSending(false);
      setResult(null);
      void runApproveRef.current?.(action, extra);
    },
    [],
  );

  /**
   * Maps a failed approval to the one-sentence inline row of UX 6.8. `retry` is the pending clone main created for the
   * next attempt (`outcome: 'failed'` only) - the rows that offer another attempt approve THAT action, never the one
   * that already failed.
   */
  const rowForError = useCallback(
    (code: ErrorCode, kind: ActionKind, retry: ActionView | null): ResultRow => {
      const refresh: ResultAction = { label: t('card.refresh'), testId: 'result-refresh', run: refreshCard };
      switch (code) {
        case 'ACTION_STALE':
        case 'EVENT_INVALID':
          return { tone: 'error', text: t('card.changed'), actions: [refresh] };
        case 'ACTION_EXPIRED':
          return { tone: 'error', text: t('card.expired'), actions: [refresh] };
        case 'RATE_LIMIT_SEND':
        case 'RATE_LIMIT_CREATE':
          return { tone: 'error', text: t('card.rateLimited'), actions: [] };
        case 'WINDOW_NOT_FOCUSED':
          return { tone: 'error', text: t('card.clickAgain'), actions: [] };
        case 'SEND_NOT_CONNECTED':
        case 'SEND_FAILED':
          return { tone: 'error', text: t('card.sendFailed'), actions: [refresh] };
        case 'CAL_DUPLICATE':
          // UX 6.8: "Create anyway" overrides the calendar's similarity heuristic - a fresh explicit approval that
          // carries `confirmDuplicate`; "Dismiss" is the other half of the row.
          return {
            tone: 'error',
            text: t('card.duplicateEvent'),
            actions: [
              ...(retry
                ? [
                    {
                      label: t('action.createAnyway'),
                      testId: 'result-create-anyway',
                      approving: true as const,
                      run: () => startApprove(retry, { confirmDuplicate: true }),
                    },
                  ]
                : []),
              { label: t('action.dismiss'), testId: 'result-dismiss', run: dismiss },
            ],
          };
        default:
          return { tone: 'error', text: t(`errors.${code}.title`), actions: [refresh] };
      }
    },
    [dismiss, refreshCard, startApprove, t],
  );

  const runApprove = useCallback(
    async (action: ActionView, extra?: { confirmConflict?: true; confirmDuplicate?: true }): Promise<void> => {
      const edit =
        action.kind === 'send_reply' ? (draft.length > 0 ? { text: draft } : undefined) : (eventEdit ?? undefined);
      const r = await api.approve({
        actionId: action.actionId,
        kind: action.kind,
        shownHash: action.shownHash,
        ...(edit ? { edit } : {}),
        ...(action.kind === 'create_event' ? extra : {}),
      });
      busyRef.current = false;
      setBusyKind(null);
      if (!r.ok) {
        focusResultRef.current = true;
        // A gate failure happens before any write, so the action the user clicked is still the one to retry.
        setResult(rowForError(r.error.code, action.kind, null));
        return;
      }
      const out = r.value;
      if (out.outcome === 'done') {
        setResult({ tone: 'ok', text: t(action.kind === 'send_reply' ? 'action.sent' : 'action.added'), actions: [] });
        useDashboardStore.getState().applyItem(out.item);
        setTimeout(() => {
          setResult(null);
          void useDashboardStore.getState().refresh();
        }, CONFIRM_MS);
        return;
      }
      if (out.outcome === 'needs_confirm_conflict') {
        focusResultRef.current = true;
        setResult({
          tone: 'error',
          text: t('card.busyAtThatTime'),
          actions: [
            {
              label: t('action.addAnyway'),
              testId: 'result-add-anyway',
              approving: true,
              // The action stays `pending` on this outcome, so the same one is approved again with confirmConflict.
              run: () => startApprove(action, { confirmConflict: true }),
            },
            // The second half of the row (UX 6.8): back to the fields instead of writing over the clash.
            ...(onChangeTime ? [{ label: t('card.changeTime'), testId: 'result-change-time', run: onChangeTime }] : []),
          ],
        });
        return;
      }
      // outcome === 'failed': main already created the retry clone; its lastError is the sentence to show.
      useDashboardStore.getState().applyItem(out.item);
      const fresh = out.item.actions.find((a) => a.kind === action.kind && a.state === 'pending');
      const code = fresh?.lastError ?? out.item.errorCode ?? 'SEND_FAILED';
      const unknown = out.item.actions.some((a) => a.kind === action.kind && a.state === 'unknown_outcome');
      focusResultRef.current = true;
      setResult(
        unknown
          ? {
              tone: 'error',
              text: t(action.kind === 'send_reply' ? 'card.unknownOutcome' : 'card.unknownOutcomeCalendar'),
              actions: [
                // UX 6.8: "Send again" / "Add again" is a NEW action with a new click - never an automatic retry.
                ...(fresh
                  ? [
                      {
                        label: t(action.kind === 'send_reply' ? 'action.sendAgain' : 'action.addAgain'),
                        testId: 'result-send-again',
                        approving: true as const,
                        run: () => startApprove(fresh),
                      },
                    ]
                  : []),
                { label: t('card.refresh'), testId: 'result-refresh', run: refreshCard },
              ],
            }
          : rowForError(code, action.kind, fresh ?? null),
      );
      void useDashboardStore.getState().refresh();
    },
    [draft, eventEdit, onChangeTime, refreshCard, rowForError, startApprove, t],
  );

  useEffect(() => {
    runApproveRef.current = runApprove;
  }, [runApprove]);

  const approveHandlers = useCallback(
    (action: ActionView, extra?: { confirmConflict?: true; confirmDuplicate?: true }) => ({
      onClick: (e: React.MouseEvent<HTMLButtonElement>): void => {
        if (activationRefused(e)) return; // double activation + [R2] focus-steal guard
        startApprove(action, extra);
      },
      onKeyDown: refuseBlockedKey,
    }),
    [startApprove],
  );

  const copy = useCallback(() => {
    if (draft.length === 0) return;
    void api.copyText(draft);
    setCopied(true);
  }, [draft]);

  const retriage = useCallback(() => {
    void api.retriage(item.itemId).then(() => void useDashboardStore.getState().refresh());
  }, [item.itemId]);

  return {
    draft,
    setDraft,
    eventEdit,
    setEventEdit,
    eventValid,
    eventMessage,
    setEventValidity,
    busyKind,
    stillSending: busyKind !== null && stillSending,
    result,
    setResult,
    resultRef,
    copied,
    stale,
    focusedInputs,
    onInputFocus,
    approveHandlers,
    copy,
    dismiss,
    retriage,
    refreshCard,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// shared pieces
// ---------------------------------------------------------------------------------------------------------------------
export function useCardStrings(item: ItemVM): {
  now: number;
  timeShort: string;
  timeFull: string;
  timeZone: string;
  lang: 'en' | 'he';
} {
  const { i18n } = useTranslation();
  const lang = i18n.language === 'he' ? 'he' : 'en';
  const timeZone = useSettingsStore((s) => s.settings?.general.timeZone) ?? DEFAULT_TIME_ZONE;
  // Snapshotted once per mount: "14:02" must not silently become "Yesterday" because an unrelated state change
  // re-rendered the card (and `Date.now()` in a render body is an impure read).
  const [now] = useState(() => Date.now());
  const f = makeFormatters(lang, timeZone);
  const sameDay = f.dayShort.format(new Date(item.trigger.ts)) === f.dayShort.format(new Date(now));
  return {
    now,
    timeShort: sameDay
      ? formatTime(item.trigger.ts, lang, timeZone)
      : formatDayLabel(item.trigger.ts, now, lang, timeZone),
    timeFull: f.full.format(new Date(item.trigger.ts)),
    timeZone,
    lang,
  };
}

/** Card header: contact name, phone (or the `@lid` chip) and the trigger time. */
export function CardHeader(props: {
  item: ItemVM;
  titleId: string;
  timeShort: string;
  timeFull: string;
  menu?: ReactNode;
}) {
  const { t } = useTranslation();
  const { chat } = props.item;
  const name = chat.displayName !== '' ? chat.displayName : chat.phoneDisplay;
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 grow">
        <bdi id={props.titleId} className="msg-text block truncate font-semibold" data-testid="card-name">
          {name}
        </bdi>
        {chat.phoneDisplay !== '' ? (
          <bdi dir="ltr" className="tnum block text-xs text-text-muted" data-testid="card-phone">
            {chat.phoneDisplay}
          </bdi>
        ) : (
          <span className="chip" data-testid="card-lid">
            {t('card.lidCopyOnly')}
          </span>
        )}
      </div>
      <span
        className="tnum shrink-0 text-xs text-text-muted"
        title={props.timeFull}
        aria-label={props.timeFull}
        data-testid="card-time"
      >
        {props.timeShort}
      </span>
      {props.menu}
    </div>
  );
}

/** The `[...]` overflow menu of UX 6.5. */
export function OverflowMenu(props: { item: ItemVM; onOpen?(): void; onDismiss(): void; onRetriage(): void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const setToast = useDashboardStore((s) => s.setToast);
  return (
    <div className="relative">
      <button
        type="button"
        className="icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('card.overflow')}
        data-testid={`overflow-${props.item.itemId}`}
        onClick={() => setOpen(!open)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="8" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="13" cy="8" r="1.4" />
        </svg>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute end-0 z-20 mt-1 flex w-60 flex-col rounded-sm bg-surface p-1 shadow-pop"
          data-testid={`overflow-menu-${props.item.itemId}`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
          }}
        >
          {props.onOpen ? (
            <button
              type="button"
              role="menuitem"
              className="btn btn-quiet justify-start"
              onClick={() => {
                setOpen(false);
                props.onOpen?.();
              }}
            >
              {t('card.openDetails')}
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="btn btn-quiet justify-start"
            data-testid={`dismiss-${props.item.itemId}`}
            onClick={() => {
              setOpen(false);
              props.onDismiss();
            }}
          >
            {t('action.dismiss')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="btn btn-quiet justify-start"
            data-testid={`retriage-${props.item.itemId}`}
            onClick={() => {
              setOpen(false);
              props.onRetriage();
            }}
          >
            {t('action.analyseAgain')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="btn btn-quiet justify-start"
            data-testid={`never-${props.item.itemId}`}
            onClick={() => {
              setOpen(false);
              void api.setChatPolicy({ chatRef: props.item.chat.chatRef, policy: 'never' }).then(() => {
                setToast({ key: 'card.neverAnalyse' });
                void useDashboardStore.getState().refresh();
              });
            }}
          >
            {t('card.neverAnalyse')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// Props are destructured in the signature: `react-hooks/refs` forbids reading `props.controller.resultRef` during
// render, and one such read taints every other `props.*` access in the component.
export function ResultRowView({
  row,
  controller,
  itemId,
}: {
  row: ResultRow;
  controller: CardController;
  itemId: number;
}) {
  const { resultRef } = controller;
  return (
    <div
      ref={resultRef}
      tabIndex={-1}
      role={row.tone === 'error' ? 'alert' : 'status'}
      data-testid={`result-${itemId}`}
      data-tone={row.tone}
      className={`mt-2 rounded-sm p-2 text-sm ${row.tone === 'ok' ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}
    >
      {row.text}
      {row.actions.map((a) => (
        <button
          key={a.testId}
          type="button"
          className="btn btn-outline ms-2"
          data-testid={a.testId}
          // [R2] a row action that approves goes through the same gate as ApproveButton; a benign one (Refresh card,
          // Change time) must NOT be dead for 500 ms after every activation.
          onClick={(e) => {
            if (a.approving === true && activationRefused(e)) return;
            a.run();
          }}
          onKeyDown={a.approving === true ? refuseBlockedKey : undefined}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

/** One approval button. Every one of them goes through the controller's guarded handlers. */
export function ApproveButton(props: {
  action: ActionView;
  controller: CardController;
  label: string;
  busyLabel: string;
  testId: string;
  primary: boolean;
  disabled?: boolean;
  disabledReason?: string;
  extra?: { confirmConflict?: true; confirmDuplicate?: true };
}) {
  const handlers = props.controller.approveHandlers(props.action, props.extra);
  const busy = props.controller.busyKind === props.action.kind;
  const reasonId = `${props.testId}-reason`;
  // The action succeeded and the 1.2 s confirmation row is on screen. A compact card's props still say `pending`
  // (`applyItem` only replaces the OPEN item), so without this the button would invite a second click that main can
  // only answer with ACTION_STALE - turning a successful send into "This card changed - review again" (UX 6.8).
  const confirmed = props.controller.result?.tone === 'ok';
  return (
    <div className="flex min-w-0 grow flex-col">
      <button
        type="button"
        data-testid={props.testId}
        {...(props.primary ? { 'data-primary-approve': 'true' } : {})}
        className={`btn ${props.primary ? 'btn-primary' : 'btn-outline'}`}
        disabled={props.disabled === true || props.controller.busyKind !== null || confirmed}
        aria-describedby={props.disabledReason ? reasonId : undefined}
        onClick={handlers.onClick}
        onKeyDown={handlers.onKeyDown}
      >
        {busy ? props.busyLabel : props.label}
      </button>
      {props.disabledReason ? (
        <span id={reasonId} className="text-xs text-text-muted" data-testid={`${props.testId}-reason`}>
          {props.disabledReason}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// ItemCard
// ---------------------------------------------------------------------------------------------------------------------
export function ItemCard(props: ItemCardProps) {
  const { t } = useTranslation();
  const item = props.item;
  const expanded = props.mode === 'expanded';
  const [focusField, setFocusField] = useState<'title' | 'date' | 'start' | 'end' | 'location' | undefined>(undefined);
  const onOpen = props.onOpen;
  // "Change time" on the conflict row: the fields are in the sheet, so a compact card opens it first (UX 6.8 / 6.6).
  const changeTime = useCallback(() => {
    setFocusField('start');
    if (!expanded) onOpen?.();
  }, [expanded, onOpen]);
  const controller = useCardController(item, props.onClose, changeTime);
  const { timeShort, timeFull, now: nowSnapshot } = useCardStrings(item);
  const titleId = `card-title-${item.itemId}`;
  // UX 7.2 asks for the target calendar NAME under the fields. `targetCalendarId` is an opaque Google id - 'primary'
  // by default, `<random>@group.calendar.google.com` for a secondary one - so it is resolved against the cached
  // `google:listCalendars` answer rather than printed raw on the screen where the user approves a calendar write.
  const targetCalendarId = useSettingsStore((s) => s.settings?.calendar.targetCalendarId) ?? 'primary';
  const calendars = useSettingsStore((s) => s.calendars);
  const calendarName = calendarNameOf(targetCalendarId, calendars, t('calendar.primaryName'));
  const [showPendingSend, setShowPendingSend] = useState(false);
  const draftWrapRef = useRef<HTMLDivElement>(null);
  // UX 2.4: the one exception to "no entrance animation" - a card that arrived or changed while the window was
  // visible wears a 3 px inline-start edge that fades over 1.6 s. It is a cue for the COLUMN, so the sheet never
  // shows it: the sheet is what the user just opened on purpose.
  const arrived = useDashboardStore((s) => s.arrivedItemIds.has(item.itemId)) && !expanded;

  // UX 16.6 wants the e2e handle ON the textarea, and DraftBoxProps is frozen (UX 14.2), so the attribute is set here.
  useEffect(() => {
    draftWrapRef.current?.querySelector('textarea')?.setAttribute('data-testid', `draft-${item.itemId}`);
  });

  // Only a card that can write to the calendar needs the calendar names, and the store makes this at most one IPC per
  // window however many cards ask. A failure is fine: `calendarNameOf` still has a fallback for every id.
  const hasEvent = item.event !== null;
  useEffect(() => {
    if (hasEvent) void useSettingsStore.getState().loadCalendars();
  }, [hasEvent]);

  const eventVm = eventVmOf(item);
  const sendAction = pendingAction(item, 'send_reply');
  const eventAction = pendingAction(item, 'create_event');
  const raw = item.card === 'raw';
  const sendable = item.chat.sendable;
  const infoMissing = item.status === 'info_missing';
  const inCalendar = item.status === 'in_calendar';

  const messages = 'messages' in item ? item.messages : null;

  // `nowSnapshot` comes from useCardStrings, so the "already passed" verdict is stable for this card's lifetime.
  const eventComplete = useMemo(() => {
    if (!eventVm) return false;
    if (controller.eventEdit) return controller.eventValid;
    return validateFields(fieldsOf(eventVm), eventVm.timeZone, nowSnapshot).ok;
  }, [controller.eventEdit, controller.eventValid, eventVm, nowSnapshot]);

  const sendDisabledReason = ((): string | undefined => {
    if (!sendAction) return undefined;
    if (controller.draft.length === 0) return t('card.writeReplyFirst');
    if (sendAction.disabledReason === 'wa_offline' || sendAction.disabledReason === 'bridge_outdated')
      return t('card.waOffline');
    return undefined;
  })();
  const eventDisabledReason = ((): string | undefined => {
    if (!eventAction) return undefined;
    if (eventAction.disabledReason === 'calendar_unavailable') return t('card.calendarUnavailable');
    if (!eventComplete) return controller.eventMessage;
    return undefined;
  })();

  const primaryKind: ActionKind | null = sendAction && sendable ? 'send_reply' : eventAction ? 'create_event' : null;

  const sendLabel = raw ? t('action.send') : infoMissing ? t('action.askDetails') : t('action.approveSend');

  return (
    <article
      data-card-root
      data-testid={expanded ? `sheet-card-${item.itemId}` : `card-${item.itemId}`}
      data-list={item.status}
      tabIndex={expanded ? undefined : 0}
      aria-labelledby={titleId}
      className={`focus-ring flex flex-col rounded-md border border-line bg-surface p-3 ${expanded ? '' : 'gap-1'}${arrived ? ' card-arrival' : ''}`}
      onFocus={(e) => {
        if (e.target instanceof HTMLInputElement) controller.onInputFocus(true);
      }}
      onBlur={(e) => {
        if (e.target instanceof HTMLInputElement) controller.onInputFocus(false);
      }}
      onKeyDown={(e) => {
        if (expanded || e.key !== 'Enter' || e.target !== e.currentTarget) return;
        props.onOpen?.();
      }}
    >
      <CardHeader
        item={item}
        titleId={titleId}
        timeShort={timeShort}
        timeFull={timeFull}
        menu={
          <OverflowMenu
            item={item}
            onOpen={expanded ? undefined : props.onOpen}
            onDismiss={controller.dismiss}
            onRetriage={controller.retriage}
          />
        }
      />

      {expanded && messages ? (
        <section
          className="mt-2 flex flex-col gap-2"
          aria-label={t('sheet.conversation')}
          data-testid="sheet-conversation"
        >
          <h3 className="m-0 text-xs font-semibold text-text-muted">{t('sheet.whatAiRead')}</h3>
          {messages.map((m) => (
            <QuotedBubble
              key={m.seq}
              text={m.text}
              from={m.fromMe ? 'me' : 'contact'}
              lang={item.draft?.lang ?? null}
              isTrigger={!m.fromMe && m.text === item.trigger.text}
            />
          ))}
        </section>
      ) : (
        <QuotedBubble
          text={item.trigger.text}
          from="contact"
          lang={item.draft?.lang ?? null}
          clampLines={3}
          isTrigger
          mediaKind={item.trigger.text === '' ? 'other' : undefined}
        />
      )}

      {!expanded && item.trigger.text !== null && item.trigger.text.length > 0 && props.onOpen ? (
        <button
          type="button"
          className="btn btn-quiet self-start"
          data-testid={`show-more-${item.itemId}`}
          onClick={props.onOpen}
        >
          {t('card.showMore')}
        </button>
      ) : null}

      <Badges
        codes={item.badges}
        holdReason={item.holdReason ?? undefined}
        errorCode={item.errorCode ?? undefined}
        scope="card"
      />

      {eventVm && !expanded ? (
        <EventChip
          event={eventVm}
          badges={item.badges}
          onOpen={() => {
            props.onOpen?.();
          }}
        />
      ) : null}

      {eventVm && expanded ? (
        <section className="mt-3 border-t border-line pt-3" aria-label={t('sheet.event')} data-testid="sheet-event">
          <h3 className="mt-0 text-xs font-semibold text-text-muted">{t('sheet.event')}</h3>
          <EventEditor
            key={`${item.itemId}-${item.updatedAt}`}
            value={eventVm}
            missing={item.missing}
            mode={eventVm.state === 'created' ? 'readonly' : eventVm.state === 'incomplete' ? 'fill' : 'edit'}
            calendarName={calendarName}
            onChange={controller.setEventEdit}
            onValidityChange={controller.setEventValidity}
            focusField={focusField}
          />
        </section>
      ) : null}

      {item.draft !== null || raw ? (
        <div ref={draftWrapRef}>
          <DraftBox
            value={controller.draft}
            suggestion={item.draft?.text ?? null}
            onChange={controller.setDraft}
            onEditingChange={controller.onInputFocus}
            label={raw ? 'own' : 'draft'}
            collapsedReason={item.badges.includes('manipulation') ? 'manipulation' : undefined}
          />
          <Badges codes={item.badges} scope="draft" />
        </div>
      ) : null}

      {expanded && item.chat.phoneDisplay !== '' ? (
        <p className="m-0 text-xs text-text-muted" data-testid="sends-to">
          {renderBdiTemplate(t('card.sendsTo', { name: SENTINEL(0), phone: SENTINEL(1) }), [
            item.chat.displayName !== '' ? item.chat.displayName : item.chat.phoneDisplay,
            item.chat.phoneDisplay,
          ])}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-start gap-2">
        {sendAction && sendable && (!inCalendar || showPendingSend) ? (
          <ApproveButton
            action={sendAction}
            controller={controller}
            label={sendLabel}
            busyLabel={t('action.sending')}
            testId={`approve-send-${item.itemId}`}
            primary={primaryKind === 'send_reply'}
            disabled={controller.draft.length === 0 || sendAction.disabledReason !== null}
            disabledReason={sendDisabledReason}
          />
        ) : null}

        {sendAction && inCalendar && !showPendingSend ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted">{t('card.replyNotSent')}</span>
            <button
              type="button"
              className="btn btn-quiet"
              data-testid={`show-send-${item.itemId}`}
              onClick={() => setShowPendingSend(true)}
            >
              {t('card.show')}
            </button>
          </div>
        ) : null}

        {eventAction ? (
          <ApproveButton
            action={eventAction}
            controller={controller}
            label={t('action.addToCalendar')}
            busyLabel={t('action.adding')}
            testId={`approve-event-${item.itemId}`}
            primary={primaryKind === 'create_event'}
            disabled={!eventComplete || eventAction.disabledReason !== null}
            disabledReason={eventDisabledReason}
          />
        ) : null}

        {inCalendar ? (
          <button
            type="button"
            className="btn btn-outline"
            data-testid={`open-calendar-${item.itemId}`}
            onClick={() => void api.openExternal({ itemId: item.itemId, target: 'calendarEvent' })}
          >
            {t('action.openInCalendar')}
          </button>
        ) : null}

        {/* UX 6.5: no edit mode - the box is always editable - but the sheet carries a visible way in (keyboard, SR). */}
        {expanded && (item.draft !== null || raw) ? (
          <button
            type="button"
            className="btn btn-quiet"
            data-testid={`sheet-edit-${item.itemId}`}
            onClick={() => draftWrapRef.current?.querySelector('textarea')?.focus()}
          >
            {t('action.edit')}
          </button>
        ) : null}

        <button
          type="button"
          className="btn btn-quiet"
          data-testid={`copy-${item.itemId}`}
          disabled={controller.draft.length === 0}
          onClick={controller.copy}
          aria-live="polite"
        >
          {controller.copied ? t('action.copied') : sendable ? t('action.copy') : t('action.copyReply')}
        </button>

        {expanded ? (
          <button
            type="button"
            className="btn btn-quiet"
            data-testid={`sheet-dismiss-${item.itemId}`}
            onClick={controller.dismiss}
          >
            {t('action.dismiss')}
          </button>
        ) : null}
      </div>

      {!sendable && (sendAction || raw) ? (
        <p className="m-0 text-xs text-text-muted" data-testid="copy-only-reason">
          {t('card.lidCopyOnly')}
        </p>
      ) : null}

      {controller.busyKind !== null && controller.stillSending ? (
        <p className="m-0 text-xs text-text-muted" data-testid={`still-sending-${item.itemId}`}>
          {t('card.stillSending')}
        </p>
      ) : null}

      {controller.result ? (
        <ResultRowView row={controller.result} controller={controller} itemId={item.itemId} />
      ) : null}

      {controller.stale && !controller.focusedInputs ? (
        <div className="mt-2 rounded-sm bg-warn-soft p-2 text-sm text-warn" data-testid={`stale-${item.itemId}`}>
          {t('card.changed')}
          <button
            type="button"
            className="btn btn-outline ms-2"
            data-testid={`refresh-${item.itemId}`}
            onClick={controller.refreshCard}
          >
            {t('card.refresh')}
          </button>
        </div>
      ) : null}

      {/* `time_assumed` opens the sheet with the time field focused (UX 6.6). */}
      {expanded ? (
        <Badges
          codes={item.badges}
          scope="event"
          onBadgeAction={(code) => {
            if (code === 'time_assumed') setFocusField('start');
          }}
        />
      ) : null}
    </article>
  );
}
