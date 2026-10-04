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
//
// [V2] (owner V2-W1-11-renderer-dashboard; UX2 3.2-3.7, 8, 11, 13; B10, B11, B19, B20, F1, F28, F31, F32):
//   - the Change card: ChangeLine between the bubble and the EventChip (which shows the NEW slot), "Approve change" /
//     "Keep 15:00" (cancel variant "Cancel event" / "Keep it"); `change_unclear` has no change buttons; the sheet edits
//     `to` only; drift ("Apply anyway" / "Keep Google's"), CAL_EVENT_GONE ("Add as new event"), CAL_EVENT_FOREIGN (info)
//     and the other `update_event` results as inline rows. Every one of those buttons that writes goes through the SAME
//     controller (single flight, shownHash echo, focus-steal guard) as v1's approvals;
//   - after a change: "Updated · rev N" / "Cancelled" + the Undo door (UndoControl) + "Open in calendar", "Restore
//     original" after automatic edits (F1), "Add it back" when Google refused a restore (U-E1);
//   - automatic mode: the `automatic` / `auto_shadow` chip, the muted "Not automatic: {reason}" line (policy live only,
//     aria-describedby of the calendar approval button), "Never automatic for this contact" in the overflow menu;
//   - the source card's "Change proposed - see Needs reply" chip; voice / picture bubbles; the sheet's picture section.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ActionKind,
  ActionView,
  AutoReason,
  Badge,
  ItemCard as ItemVM,
  ItemDetail as ItemDetailVM,
  ImageReadView,
  MessageView,
} from '@shared/types';
import type { ErrorCode } from '@shared/errors';
import type { EventEdit } from '@shared/schemas';
import { DEFAULT_TIME_ZONE, formatDayLabel, formatTime, makeFormatters } from '@shared/i18n/format';
import { localToEpochMs } from '@shared/when';
import { api } from '../api';
import { isActivationBlocked } from '../store/health';
import { calendarNameOf, useSettingsStore } from '../store/settings';
import { useDashboardStore } from '../store/dashboard';
import { policyLive, useAutoStore } from '../store/auto';
import { Badges } from './Badges';
import { DraftBox } from './DraftBox';
import { EventChip, EventEditor, fieldsOf, validateFields, type EventVM } from './EventEditor';
import { QuotedBubble } from './QuotedBubble';
import { SENTINEL, renderBdiTemplate } from './ItemCard.bdi';
import { ChangeLine } from './ChangeLine';
import { formatWhenWithDay, keepTimeLabel, startMsOf } from './ChangeLine.format';
import { GuardedButton, UndoControl } from './UndoControl';
import { VoiceBubble } from './VoiceBubble';
import { MediaActions } from './RawCard.media';
import { ImageBubble, InertPicture, safeImageSrc } from './ImageBubble';

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
  /** [V2] 'info' = a neutral fact with no action (CAL_EVENT_FOREIGN); 'warn' = the drift question (amber). */
  tone: 'ok' | 'error' | 'info' | 'warn';
  text: ReactNode;
  actions: ResultAction[];
  /** [V2] Test id of the row itself (UX2 13 `drift-row-<itemId>`); default `result-<itemId>`. */
  testId?: string;
}

/** [V2] Extra flags a calendar approval may carry (C2 8 ApproveReqSchema). */
export interface ApproveExtra {
  confirmConflict?: true;
  confirmDuplicate?: true;
  confirmDrift?: true;
}
/** Only the flags the schema allows for this kind: create_event -> conflict/duplicate, update_event -> conflict/drift. */
export function extraFor(kind: ActionKind, extra?: ApproveExtra): ApproveExtra {
  if (!extra) return {};
  if (kind === 'create_event')
    return {
      ...(extra.confirmConflict ? { confirmConflict: true as const } : {}),
      ...(extra.confirmDuplicate ? { confirmDuplicate: true as const } : {}),
    };
  if (kind === 'update_event')
    return {
      ...(extra.confirmConflict ? { confirmConflict: true as const } : {}),
      ...(extra.confirmDrift ? { confirmDrift: true as const } : {}),
    };
  return {};
}

// ---------------------------------------------------------------------------------------------------------------------
// locale templates with <bdi> markup
// ---------------------------------------------------------------------------------------------------------------------
export { SENTINEL, renderBdiTemplate };

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

/**
 * The event the card draws. A delta item draws the NEW slot (`change.to`, UX2 3.3); a declined (rejected) change draws
 * nothing - the card is a plain reply card again (F32 / C15).
 */
export function eventVmOf(item: ItemVM): EventVM | null {
  if (item.eventState === 'none' || item.eventState === 'declined') return null;
  const revision = item.calendar?.revision;
  if (item.change && item.eventState === 'change_proposed') {
    const to = item.change.to;
    return {
      title: to.title,
      startLocal: to.startLocal,
      endLocal: to.endLocal,
      timeZone: to.timeZone,
      location: to.location,
      assumptions: item.event?.assumptions ?? [],
      dateHint: '',
      state: item.eventState,
      hasCalendarLink: item.calendar !== null,
      ...(revision !== undefined ? { revision } : {}),
    };
  }
  if (!item.event) return null;
  return {
    ...item.event,
    state: item.eventState,
    hasCalendarLink: item.calendar !== null,
    ...(revision !== undefined ? { revision } : {}),
  };
}

/** The newest failed `update_event` of the card and its code (GONE / FOREIGN end without a retry clone, C2 8). */
function failedUpdateCode(item: ItemVM): ErrorCode | null {
  const failed = item.actions.filter((a) => a.kind === 'update_event' && a.state === 'failed');
  return failed.length > 0 ? (failed[failed.length - 1]!.errorCode ?? null) : null;
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
    extra?: ApproveExtra,
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
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'he' ? 'he' : 'en';
  const changeKind = item.change?.kind ?? null;
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

  // [V2] UX2 12: the dirty-card rule extends to delta cards - an edited `to` is never overwritten by a refresh.
  const dirty = focusedInputs || draft !== suggestion || (eventEdit !== null && item.change !== null);
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
    setEventEditState(null);
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
  const runApproveRef = useRef<((action: ActionView, extra?: ApproveExtra) => Promise<void>) | null>(null);

  /**
   * The single-flight lock and the busy chrome that EVERY approval shares, whether it starts at an ApproveButton or at
   * a recovery button of the result row. The [R2] activation gate is NOT here: it has to be read at activation time by
   * the control itself (`approveHandlers`, `ResultRowView`).
   */
  const startApprove = useCallback((action: ActionView, extra?: ApproveExtra): void => {
    if (busyRef.current) return; // a second synchronous click sends nothing
    busyRef.current = true;
    setBusyKind(action.kind);
    setStillSending(false);
    setResult(null);
    void runApproveRef.current?.(action, extra);
  }, []);

  /**
   * Maps a failed approval to the one-sentence inline row of UX 6.8. `retry` is the pending clone main created for the
   * next attempt (`outcome: 'failed'` only) - the rows that offer another attempt approve THAT action, never the one
   * that already failed.
   */
  const rowForError = useCallback(
    (code: ErrorCode, kind: ActionKind, retry: ActionView | null, fresh?: ItemVM): ResultRow => {
      const refresh: ResultAction = { label: t('card.refresh'), testId: 'result-refresh', run: refreshCard };
      switch (code) {
        // ---- [V2] update_event results (UX2 3.3.4) ----
        case 'CAL_EVENT_GONE': {
          // The executor inserted a pending create_event with `to`: "Add as new event" is a NEW approval (outline).
          const create = fresh ? pendingAction(fresh, 'create_event') : null;
          return {
            tone: 'error',
            text: t('errors.CAL_EVENT_GONE.title'),
            actions: create
              ? [
                  {
                    label: t('errors.CAL_EVENT_GONE.action'),
                    testId: `add-new-event-${item.itemId}`,
                    approving: true as const,
                    run: () => startApprove(create),
                  },
                ]
              : [],
          };
        }
        case 'CAL_EVENT_FOREIGN':
          return {
            tone: 'info',
            text: `${t('errors.CAL_EVENT_FOREIGN.title')} - ${t('errors.CAL_EVENT_FOREIGN.body')}`,
            actions: [],
          };
        case 'CAL_UPDATE_FAILED':
          return {
            tone: 'error',
            text: `${t('errors.CAL_UPDATE_FAILED.title')}. ${t('errors.CAL_UPDATE_FAILED.body')}`,
            actions: retry
              ? [
                  {
                    label: t('app.tryAgain'),
                    testId: 'result-try-again',
                    approving: true as const,
                    run: () => startApprove(retry),
                  },
                ]
              : [refresh],
          };
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
    [dismiss, item.itemId, refreshCard, startApprove, t],
  );

  const runApprove = useCallback(
    async (action: ActionView, extra?: ApproveExtra): Promise<void> => {
      const edit =
        action.kind === 'send_reply' ? (draft.length > 0 ? { text: draft } : undefined) : (eventEdit ?? undefined);
      const r = await api.approve({
        actionId: action.actionId,
        kind: action.kind,
        shownHash: action.shownHash,
        ...(edit ? { edit } : {}),
        ...extraFor(action.kind, extra),
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
        const doneKey =
          action.kind === 'send_reply'
            ? 'action.sent'
            : action.kind === 'update_event'
              ? changeKind === 'cancel'
                ? 'change.cancelled'
                : 'change.approved'
              : 'action.added';
        setResult({ tone: 'ok', text: t(doneKey), actions: [] });
        if (action.kind !== 'send_reply') setEventEditState(null);
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
      if (out.outcome === 'needs_confirm_drift') {
        // [V2] Google's copy differs from `from`. Pre-flight drift keeps THIS action pending; an HTTP 412 failed it and
        // main created a pending clone - "Apply anyway" approves whichever is pending now (never the failed one).
        useDashboardStore.getState().applyItem(out.item);
        const pending = out.item.actions.find((a) => a.kind === 'update_event' && a.state === 'pending') ?? action;
        const cur = out.current;
        const when = formatWhenWithDay(localToEpochMs(cur.startLocal, cur.timeZone), lang, cur.timeZone);
        focusResultRef.current = true;
        setResult({
          tone: 'warn',
          testId: `drift-row-${item.itemId}`,
          text: renderBdiTemplate(t('change.drift', { when: SENTINEL(0) }), [when]),
          actions: [
            {
              label: t('change.applyAnyway'),
              testId: `apply-anyway-${item.itemId}`,
              approving: true,
              run: () => startApprove(pending, { confirmDrift: true }),
            },
            {
              // The fail-safe direction: no focus guard (UX2 11.5).
              label: t('change.keepGoogle'),
              testId: `keep-google-${item.itemId}`,
              run: () => {
                setResult(null);
                void api.reject(pending.actionId).then(() => void useDashboardStore.getState().refresh());
              },
            },
          ],
        });
        return;
      }
      // outcome === 'failed': main already created the retry clone; its lastError is the sentence to show.
      useDashboardStore.getState().applyItem(out.item);
      const fresh = out.item.actions.find((a) => a.kind === action.kind && a.state === 'pending');
      const ownCode = out.item.actions.find((a) => a.actionId === action.actionId)?.errorCode ?? null;
      const code = fresh?.lastError ?? ownCode ?? out.item.errorCode ?? 'SEND_FAILED';
      const unknown = out.item.actions.some((a) => a.kind === action.kind && a.state === 'unknown_outcome');
      focusResultRef.current = true;
      setResult(
        unknown
          ? {
              tone: 'error',
              text: t(action.kind === 'send_reply' ? 'card.unknownOutcome' : 'card.unknownOutcomeCalendar'),
              // [V2] "Apply again" for an update (UX2 3.3.4) - still a new action and a new click.
              actions: [
                // UX 6.8: "Send again" / "Add again" is a NEW action with a new click - never an automatic retry.
                ...(fresh
                  ? [
                      {
                        label: t(
                          action.kind === 'send_reply'
                            ? 'action.sendAgain'
                            : action.kind === 'update_event'
                              ? 'change.applyAgain'
                              : 'action.addAgain',
                        ),
                        testId: 'result-send-again',
                        approving: true as const,
                        run: () => startApprove(fresh),
                      },
                    ]
                  : []),
                { label: t('card.refresh'), testId: 'result-refresh', run: refreshCard },
              ],
            }
          : rowForError(code, action.kind, fresh ?? null, out.item),
      );
      void useDashboardStore.getState().refresh();
    },
    [changeKind, draft, eventEdit, item.itemId, lang, onChangeTime, refreshCard, rowForError, startApprove, t],
  );

  useEffect(() => {
    runApproveRef.current = runApprove;
  }, [runApprove]);

  const approveHandlers = useCallback(
    (action: ActionView, extra?: ApproveExtra) => ({
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
  const autoPolicyExists = useAutoStore((s) => s.state?.policy != null);
  const neverAuto = props.item.chat.autoPolicy === 'never';
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
          {/* [V2] UX2 3.2 / B28: shown only while a policy is live or has existed (AutoState.policy is the live row or
              the newest closed one). The fail-safe direction: no dialog, no guard. */}
          {autoPolicyExists ? (
            <button
              type="button"
              role="menuitem"
              className="btn btn-quiet justify-start"
              data-testid={`never-auto-${props.item.itemId}`}
              data-policy={neverAuto ? 'never' : 'inherit'}
              onClick={() => {
                setOpen(false);
                const chatRef = props.item.chat.chatRef;
                const next = neverAuto ? 'inherit' : 'never';
                void api.setChatPolicy({ chatRef, autoPolicy: next }).then(() => {
                  if (next === 'never')
                    setToast({
                      key: 'auto.neverToast',
                      onUndo: () =>
                        void api
                          .setChatPolicy({ chatRef, autoPolicy: 'inherit' })
                          .then(() => void useDashboardStore.getState().refresh()),
                    });
                  void useDashboardStore.getState().refresh();
                });
              }}
            >
              {neverAuto ? `${t('card.autoNeverState')} - ${t('auto.allowAgain')}` : t('auto.neverForContact')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const RESULT_TONE: Record<ResultRow['tone'], string> = {
  ok: 'bg-ok-soft text-ok',
  error: 'bg-danger-soft text-danger',
  info: 'bg-quote text-text',
  warn: 'bg-warn-soft text-warn',
};

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
      role={row.tone === 'error' || row.tone === 'warn' ? 'alert' : 'status'}
      data-testid={row.testId ?? `result-${itemId}`}
      data-tone={row.tone}
      className={`mt-2 rounded-sm p-2 text-sm ${RESULT_TONE[row.tone]}`}
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
  extra?: ApproveExtra;
  /** [V2] "Cancel event": danger TEXT colour on the outline button, never a danger fill (UX2 3.3). */
  danger?: boolean;
  /** [V2] Extra element id for aria-describedby (the "Not automatic: {reason}" line, UX2 11.3). */
  describedBy?: string;
}) {
  const handlers = props.controller.approveHandlers(props.action, props.extra);
  const busy = props.controller.busyKind === props.action.kind;
  const reasonId = `${props.testId}-reason`;
  // The action succeeded and the 1.2 s confirmation row is on screen. A compact card's props still say `pending`
  // (`applyItem` only replaces the OPEN item), so without this the button would invite a second click that main can
  // only answer with ACTION_STALE - turning a successful send into "This card changed - review again" (UX 6.8).
  const confirmed = props.controller.result?.tone === 'ok';
  const describedBy = [props.disabledReason ? reasonId : null, props.describedBy ?? null].filter(Boolean).join(' ');
  return (
    <div className="flex min-w-0 grow flex-col">
      <button
        type="button"
        data-testid={props.testId}
        {...(props.primary ? { 'data-primary-approve': 'true' } : {})}
        className={`btn ${props.primary ? 'btn-primary' : 'btn-outline'}${props.danger ? ' text-danger' : ''}`}
        disabled={props.disabled === true || props.controller.busyKind !== null || confirmed}
        aria-describedby={describedBy !== '' ? describedBy : undefined}
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
// ---------------------------------------------------------------------------------------------------------------------
// [V2] card pieces (UX2 3.2-3.7)
// ---------------------------------------------------------------------------------------------------------------------
/** The reasons that never render as the "Not automatic" line: `ok` wrote automatically, `policy_shadow` has the chip. */
const SILENT_REASONS: readonly AutoReason[] = ['ok', 'policy_shadow'];

/**
 * UX2 3.2 / 11.3: the muted "Not automatic: {reason}" line is shown only while a policy is live and only on a card that
 * still has a pending calendar approval. The reason is an enum -> locale key: never model text, never fed to a model.
 */
export function visibleAutoReason(item: ItemVM, live: boolean, hasCalendarApproval: boolean): AutoReason | null {
  const reason = item.auto?.notAutomaticReason ?? null;
  if (!live || !hasCalendarApproval || reason === null || SILENT_REASONS.includes(reason)) return null;
  return reason;
}

/** The chip the card wears: from the auto view model, or (old rows without one) from the result badge. */
export function autoChipOf(item: ItemVM): 'automatic' | 'auto_shadow' | null {
  if (item.auto?.chip) return item.auto.chip;
  if (item.badges.includes('automatic')) return 'automatic';
  if (item.badges.includes('auto_shadow')) return 'auto_shadow';
  return null;
}

/** The write the `automatic` chip names ("Added / Moved / Cancelled automatically"), read from the event state. */
function writeKindOf(item: ItemVM): 'create' | 'update' | 'cancel' {
  if (item.eventState === 'cancelled') return 'cancel';
  if (item.eventState === 'updated') return 'update';
  return 'create';
}

/**
 * F28: the run was triggered by the user's own message. C2 carries `triggerAuthor` on the proposal record but not (yet)
 * on the ItemCard view model - read defensively, so the line appears as soon as main sends the field (REQUESTS in notes).
 */
export function selfTriggered(item: ItemVM): boolean {
  return (item as ItemVM & { triggerAuthor?: unknown }).triggerAuthor === 'self';
}

/**
 * F1: "Restore original" after two automatic edits of one event. The view model has no explicit flag; an automatic undo
 * door on an event at revision >= 3 (create + two edits) is the renderer's reading. Main re-checks the chain and refuses
 * anything else (C2 8 `item:restoreOriginal`).
 */
export function canRestoreOriginal(item: ItemVM): boolean {
  const undo = item.undo;
  return undo !== null && undo.automatic && undo.state !== 'undone' && (item.calendar?.revision ?? 0) >= 3;
}

function AutoChip({ item, chip }: { item: ItemVM; chip: 'automatic' | 'auto_shadow' }) {
  const { t } = useTranslation();
  const text = chip === 'automatic' ? t(`badge.automatic.long.${writeKindOf(item)}`) : t('badge.auto_shadow.long');
  return (
    <span
      className={`chip ${chip === 'automatic' ? 'chip-info' : 'chip-shadow'} self-start`}
      data-testid={`auto-chip-${item.itemId}`}
      data-chip={chip}
    >
      <span className="icon icon-auto" aria-hidden="true" />
      {text}
    </span>
  );
}

/** UX2 3.3.3: "Change proposed - see Needs reply" moves focus to the delta card of the same chat. */
function focusDeltaCard(item: ItemVM, onClose?: () => void): void {
  const st = useDashboardStore.getState();
  const delta = st.lists.needs_reply.items.find(
    (c) => c.itemId !== item.itemId && c.chat.chatRef === item.chat.chatRef && c.change !== null,
  );
  if (!delta) return;
  if (!st.sectionOpen.needs_reply) st.toggleSection('needs_reply');
  onClose?.();
  const move = (): boolean => {
    const node = document.querySelector<HTMLElement>(`[data-testid="card-${delta.itemId}"]`);
    if (!node) return false;
    node.scrollIntoView?.({ block: 'nearest' });
    node.focus();
    return true;
  };
  // A collapsed section or a closing sheet renders the card on the next commit.
  if (!move()) setTimeout(move, 0);
}

/** The "Keep ..." quiet button of a Change card: `action:reject` of the pending update_event (fail-safe, no guard). */
function KeepButton(props: { itemId: number; actionId: string; testId: string; label: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-quiet"
      data-testid={props.testId}
      disabled={busy}
      onClick={() => {
        if (busy) return;
        setBusy(true);
        void api
          .reject(props.actionId)
          .catch(() => undefined)
          .finally(() => {
            setBusy(false);
            void useDashboardStore.getState().refresh();
            void useDashboardStore.getState().reloadOpenItem();
          });
      }}
    >
      {props.label}
    </button>
  );
}

/** UX2 3.6 sheet: "The picture" (lazy `item:getImage`, inert) + "What the AI read from the picture". */
function SheetPicture({
  item,
  image,
  contactName,
}: {
  item: ItemVM;
  image: ImageReadView | null;
  contactName: string;
}) {
  const { t } = useTranslation();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void api.getImage(item.itemId).then((r) => {
      if (alive && r.ok) setDataUrl(r.value.dataUrl);
    });
    return () => {
      alive = false;
    };
  }, [item.itemId]);
  const src = safeImageSrc(dataUrl);
  return (
    <section className="mt-2 flex flex-col gap-2" aria-label={t('image.sheetTitle')} data-testid="sheet-picture">
      <h3 className="m-0 text-xs font-semibold text-text-muted">{t('image.sheetTitle')}</h3>
      {src !== null ? (
        <InertPicture
          src={src}
          alt={t('image.alt', { name: contactName })}
          className="sheet-picture rounded-sm"
          testId="sheet-picture-img"
        />
      ) : null}
      {image !== null ? (
        <details open={item.badges.includes('image_unclear')} data-testid="sheet-picture-read">
          <summary className="cursor-pointer text-sm">{t('image.whatRead')}</summary>
          <ImageBubble image={{ ...image, thumbDataUrl: null }} contactName={contactName} mode="sheet" />
        </details>
      ) : null}
    </section>
  );
}

/** UX2 3.7: one row of the sheet's conversation - text, a voice row (full transcript) or a compact picture row. */
function ConversationRow({ m, item, contactName }: { m: MessageView; item: ItemVM; contactName: string }) {
  if (m.voice) {
    return (
      <div className={`flex ${m.fromMe ? 'justify-end' : 'justify-start'}`} data-testid={`voice-row-${m.seq}`}>
        <VoiceBubble voice={m.voice} full />
      </div>
    );
  }
  if (m.image) {
    return (
      <div className={`flex ${m.fromMe ? 'justify-end' : 'justify-start'}`} data-testid={`image-row-${m.seq}`}>
        <ImageBubble
          image={{
            thumbDataUrl: null,
            readText: m.image.readText ?? '',
            dateText: '',
            timeText: '',
            location: '',
            confidence: 'high',
            kind: 'none',
          }}
          contactName={contactName}
          mode="card"
        />
      </div>
    );
  }
  return (
    <QuotedBubble
      text={m.text}
      from={m.fromMe ? 'me' : 'contact'}
      lang={item.draft?.lang ?? null}
      isTrigger={!m.fromMe && m.text === item.trigger.text}
    />
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// ItemCard
// ---------------------------------------------------------------------------------------------------------------------
export function ItemCard(props: ItemCardProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'he' ? 'he' : 'en';
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
  const { timeShort, timeFull, timeZone, now: nowSnapshot } = useCardStrings(item);
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
  // [V2] automatic mode: whether a policy is live (reason line gating) and the strip rows (the sheet's "Automatic" block).
  const live = useAutoStore((s) => policyLive(s.state));
  const autoRows = useAutoStore((s) => s.rows);
  const requestNavigation = useDashboardStore((s) => s.requestNavigation);

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
  const updateAction = pendingAction(item, 'update_event');
  const raw = item.card === 'raw';
  const sendable = item.chat.sendable;
  const infoMissing = item.status === 'info_missing';
  const inCalendar = item.status === 'in_calendar';
  const contactName = item.chat.displayName !== '' ? item.chat.displayName : item.chat.phoneDisplay;

  // [V2] the Change card (UX2 3.3): a delta item whose change is still proposed. A rejected change ("Keep 15:00",
  // `declined`) or a `change_unclear` run draws no ChangeLine and no change buttons (F32 / C15, UX2 3.3.2).
  const change = item.eventState === 'change_proposed' ? item.change : null;
  const changeUnclear = item.badges.includes('change_unclear');
  const showChange = change !== null && !changeUnclear;
  const changeButtons = showChange && updateAction !== null ? updateAction : null;
  // UX2 3.4 / U-E1: Google refused to restore a cancelled event; the executor inserted a pending create_event.
  const addBack = inCalendar && eventAction !== null && item.calendar?.status === 'cancelled';
  const chip = autoChipOf(item);
  const chipBadges: readonly Badge[] = ['automatic', 'auto_shadow'];
  const eventBadges = item.badges.filter((b) => !chipBadges.includes(b));
  const reason = visibleAutoReason(item, live, eventAction !== null || changeButtons !== null);
  const reasonId = `auto-reason-${item.itemId}`;
  const imageUnclear = item.badges.includes('image_unclear');
  // REQUEST 8: a badge row that is not drawn must not take its badges with it (S3 aborted for `manipulation` leaves no
  // draft, so the draft-scope row is gone; a card without an event has no EventChip). The card row adopts them.
  const draftRowShown = item.draft !== null || raw;
  const eventRowShown = expanded || eventVm !== null;
  const adoptScopes: Array<'draft' | 'event'> = [
    ...(draftRowShown ? [] : ['draft' as const]),
    ...(eventRowShown ? [] : ['event' as const]),
  ];
  // UX2 3.3.4 after a refresh: a change that ended GONE / FOREIGN has no retry clone; the card keeps saying so.
  const endedUpdate = controller.result === null ? failedUpdateCode(item) : null;
  const gone = endedUpdate === 'CAL_EVENT_GONE' && eventAction !== null;

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
  // A change edits `to` only; its approval is blocked by an invalid edit or by a calendar that cannot update (B4).
  const changeDisabledReason = ((): string | undefined => {
    if (!changeButtons) return undefined;
    if (changeButtons.disabledReason === 'calendar_updates_unavailable')
      return t('errors.CAL_UPDATE_UNAVAILABLE.title');
    if (changeButtons.disabledReason !== null) return t('card.calendarUnavailable');
    if (controller.eventEdit && !controller.eventValid) return controller.eventMessage;
    return undefined;
  })();

  const primaryKind: ActionKind | null =
    sendAction && sendable
      ? 'send_reply'
      : eventAction && !addBack
        ? 'create_event'
        : changeButtons && change?.kind !== 'cancel'
          ? 'update_event'
          : null;

  const sendLabel = raw ? t('action.send') : infoMissing ? t('action.askDetails') : t('action.approveSend');
  const keepLabel =
    change === null
      ? ''
      : change.kind === 'move'
        ? t('change.keepPlace')
        : change.kind === 'cancel'
          ? t('change.keepIt')
          : t('change.keepTime', { time: keepTimeLabel(change.from, change.to, lang) });
  const hasTriggerText =
    (item.trigger.text !== null && item.trigger.text.length > 0) ||
    (item.voice?.transcript ?? '') !== '' ||
    (item.image?.readText ?? '') !== '';

  const autoWrittenAt =
    item.auto?.autoWriteId != null
      ? (autoRows.find((r) => r.autoWriteId === item.auto?.autoWriteId)?.writtenAt ?? null)
      : null;

  const editorMode: 'edit' | 'fill' | 'readonly' | 'change' =
    change !== null
      ? 'change'
      : eventVm?.state === 'created' || eventVm?.state === 'updated' || eventVm?.state === 'cancelled'
        ? 'readonly'
        : eventVm?.state === 'incomplete'
          ? 'fill'
          : 'edit';

  return (
    <article
      data-card-root
      data-testid={expanded ? `sheet-card-${item.itemId}` : `card-${item.itemId}`}
      data-list={item.status}
      data-trigger-kind={item.triggerKind}
      tabIndex={expanded ? undefined : 0}
      aria-labelledby={showChange ? `${titleId} ${titleId}-change` : titleId}
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
      {showChange ? (
        <span id={`${titleId}-change`} className="sr-only">
          {t('card.changeProposedA11y')}
        </span>
      ) : null}

      {/* UX2 3.2 / 3.7: an automatic item's sheet opens with the "Automatic" block. */}
      {expanded && chip === 'automatic' ? (
        <section className="mt-2 flex flex-col gap-1 rounded-sm bg-accent-soft p-2" data-testid="sheet-auto-block">
          <p className="m-0 flex items-center gap-2 text-sm">
            <span className="icon icon-auto text-accent" aria-hidden="true" />
            {autoWrittenAt !== null
              ? renderBdiTemplate(t('card.autoBlock.addedOn', { when: SENTINEL(0) }), [
                  formatWhenWithDay(autoWrittenAt, lang, timeZone),
                ])
              : t(`badge.automatic.long.${writeKindOf(item)}`)}
          </p>
          <button
            type="button"
            className="btn btn-quiet self-start"
            data-testid="sheet-auto-activity"
            onClick={() => {
              requestNavigation({ view: 'activity' });
              props.onClose?.();
            }}
          >
            {t('card.autoBlock.seeAll')}
          </button>
        </section>
      ) : null}

      {expanded && item.triggerKind === 'image' ? (
        <SheetPicture item={item} image={item.image} contactName={contactName} />
      ) : null}

      {expanded && messages ? (
        <section
          className="mt-2 flex flex-col gap-2"
          aria-label={t('sheet.conversation')}
          data-testid="sheet-conversation"
        >
          <h3 className="m-0 text-xs font-semibold text-text-muted">{t('sheet.whatAiRead')}</h3>
          {messages.map((m) => (
            <ConversationRow key={m.seq} m={m} item={item} contactName={contactName} />
          ))}
        </section>
      ) : (
        <QuotedBubble
          text={item.trigger.text}
          from="contact"
          lang={item.draft?.lang ?? null}
          clampLines={3}
          isTrigger
          mediaKind={item.trigger.text === '' && item.triggerKind === 'text' ? 'other' : undefined}
          triggerKind={item.triggerKind}
          voice={item.voice}
          image={item.image}
          contactName={contactName}
          itemId={item.itemId}
        />
      )}

      {!expanded && hasTriggerText && props.onOpen ? (
        <button
          type="button"
          className="btn btn-quiet self-start"
          data-testid={`show-more-${item.itemId}`}
          onClick={props.onOpen}
        >
          {t('card.showMore')}
        </button>
      ) : null}

      {/* UX2 3.3: the ChangeLine sits between the bubble and the EventChip; it is app text built from delta_json. */}
      {showChange && change ? (
        <div data-testid={`change-line-${item.itemId}`} data-kind={change.kind === 'undo' ? 'reschedule' : change.kind}>
          <ChangeLine change={change} lang={lang} />
        </div>
      ) : null}

      <Badges
        codes={eventBadges /* the card row never carries automatic / auto_shadow: AutoChip draws them */}
        adoptScopes={adoptScopes}
        holdReason={item.holdReason ?? undefined}
        errorCode={item.errorCode ?? undefined}
        scope="card"
        selfTriggered={selfTriggered(item)}
        onBadgeAction={(code) => {
          // UX2 3.6: "Hard to read" opens the sheet with the Date field focused (like `time_assumed`).
          if (code !== 'image_unclear') return;
          setFocusField('date');
          if (!expanded) props.onOpen?.();
        }}
      />

      {eventVm && !expanded ? (
        <EventChip
          event={eventVm}
          badges={eventBadges}
          onOpen={() => {
            props.onOpen?.();
          }}
        />
      ) : null}

      {chip !== null ? <AutoChip item={item} chip={chip} /> : null}

      {/* UX2 3.3.3: the source card of a pending change. */}
      {item.changePending ? (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            className="chip chip-info focus-ring cursor-pointer self-start"
            data-testid={`change-pending-chip-${item.itemId}`}
            onClick={() => focusDeltaCard(item, expanded ? props.onClose : undefined)}
          >
            {t('change.pendingChip')}
          </button>
          {expanded ? (
            <p className="m-0 text-xs text-text-muted" data-testid="change-latest-only">
              {t('change.latestOnly')}
            </p>
          ) : null}
        </div>
      ) : null}

      {eventVm && expanded ? (
        <section className="mt-3 border-t border-line pt-3" aria-label={t('sheet.event')} data-testid="sheet-event">
          <h3 className="mt-0 text-xs font-semibold text-text-muted">{t('sheet.event')}</h3>
          {/* UX2 3.7: a delta item shows the event as it is now (app-rendered `from`) above the editable `to`. */}
          {change !== null ? (
            <p className="m-0 mb-2 text-sm" data-testid="sheet-now-in-calendar">
              <span className="text-text-muted">{t('change.nowInCalendar')}: </span>
              <bdi className="tnum">{formatWhenWithDay(startMsOf(change.from), lang, change.from.timeZone)}</bdi>
              {change.from.location !== '' ? (
                <>
                  {' · '}
                  <bdi className="msg-text" dir="auto">
                    {change.from.location}
                  </bdi>
                </>
              ) : null}
            </p>
          ) : null}
          <EventEditor
            key={`${item.itemId}-${item.updatedAt}`}
            value={eventVm}
            missing={item.missing}
            mode={editorMode}
            calendarName={calendarName}
            onChange={controller.setEventEdit}
            onValidityChange={controller.setEventValidity}
            focusField={focusField}
            dateNote={imageUnclear ? t('image.checkAgainst') : undefined}
          />
        </section>
      ) : null}

      {draftRowShown ? (
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

        {eventAction && !addBack ? (
          <ApproveButton
            action={eventAction}
            controller={controller}
            label={gone ? t('errors.CAL_EVENT_GONE.action') : t('action.addToCalendar')}
            busyLabel={t('action.adding')}
            testId={gone ? `add-new-event-${item.itemId}` : `approve-event-${item.itemId}`}
            primary={primaryKind === 'create_event' && !gone}
            disabled={!eventComplete || eventAction.disabledReason !== null}
            disabledReason={eventDisabledReason}
            describedBy={reason !== null ? reasonId : undefined}
          />
        ) : null}

        {/* UX2 3.3: "Approve change" (accent only when it is the card's only approval) / "Cancel event" (outline,
            danger TEXT, never a danger fill). Both are ordinary approvals of the pending update_event. */}
        {changeButtons && change ? (
          change.kind === 'cancel' ? (
            <ApproveButton
              action={changeButtons}
              controller={controller}
              label={t('change.cancelEvent')}
              busyLabel={t('change.cancelling')}
              testId={`cancel-event-${item.itemId}`}
              primary={false}
              danger
              disabled={changeButtons.disabledReason !== null}
              disabledReason={changeDisabledReason}
              describedBy={reason !== null ? reasonId : undefined}
            />
          ) : (
            <ApproveButton
              action={changeButtons}
              controller={controller}
              label={t('change.approve')}
              busyLabel={t('change.approving')}
              testId={`approve-change-${item.itemId}`}
              primary={primaryKind === 'update_event'}
              disabled={changeDisabledReason !== undefined}
              disabledReason={changeDisabledReason}
              describedBy={reason !== null ? reasonId : undefined}
            />
          )
        ) : null}

        {changeButtons && change ? (
          <KeepButton
            itemId={item.itemId}
            actionId={changeButtons.actionId}
            testId={change.kind === 'cancel' ? `keep-event-${item.itemId}` : `keep-change-${item.itemId}`}
            label={keepLabel}
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

        <MediaActions item={item} />

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

      {endedUpdate === 'CAL_EVENT_GONE' || endedUpdate === 'CAL_EVENT_FOREIGN' ? (
        <p
          className={`m-0 rounded-sm p-2 text-sm ${endedUpdate === 'CAL_EVENT_GONE' ? 'bg-danger-soft text-danger' : 'bg-quote text-text'}`}
          data-testid={`update-ended-${item.itemId}`}
          data-code={endedUpdate}
        >
          {endedUpdate === 'CAL_EVENT_GONE'
            ? t('errors.CAL_EVENT_GONE.title')
            : `${t('errors.CAL_EVENT_FOREIGN.title')} - ${t('errors.CAL_EVENT_FOREIGN.body')}`}
        </p>
      ) : null}

      {/* UX2 3.2 / 11.3: app text, referenced by the calendar approval button's aria-describedby. */}
      {reason !== null ? (
        <p id={reasonId} className="m-0 text-xs text-text-muted" data-testid={reasonId} data-reason={reason}>
          {t('auto.notAutomatic', { reason: t(`auto.reason.${reason}`) })}
        </p>
      ) : null}

      {/* UX2 3.4 / U-E1: Google did not restore the cancelled event - "Add it back" is a normal user approval. */}
      {addBack && eventAction ? (
        <div className="mt-2 flex flex-col gap-1" data-testid={`restore-refused-${item.itemId}`}>
          <p className="note-amber m-0 text-sm">{t('undo.restoreRefused')}</p>
          <ApproveButton
            action={eventAction}
            controller={controller}
            label={t('undo.addBack')}
            busyLabel={t('action.adding')}
            testId={`add-back-${item.itemId}`}
            primary={false}
            disabled={eventAction.disabledReason !== null}
            disabledReason={eventDisabledReason}
          />
        </div>
      ) : null}

      {/* UX2 3.4: the Undo door of a change that landed (manual or automatic), then "Restore original" (F1). */}
      {item.undo !== null ? (
        <div className="mt-2 flex flex-col gap-2">
          <UndoControl
            undo={item.undo}
            itemId={item.itemId}
            door="card"
            onUndo={async () => {
              const undo = item.undo;
              if (undo === null) return { ok: false, error: { code: 'BAD_REQUEST' } } as const;
              const r = await api.undoChange(item.itemId, undo.revisionId);
              void useDashboardStore.getState().refresh();
              void useDashboardStore.getState().reloadOpenItem();
              return r;
            }}
          />
          {canRestoreOriginal(item) ? (
            <GuardedButton
              testId={`restore-original-${item.itemId}`}
              label={t('undo.restoreOriginal')}
              busyLabel={t('undo.restoringOriginal')}
              run={() => api.restoreOriginal(item.itemId)}
            />
          ) : null}
        </div>
      ) : null}

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
          codes={eventBadges}
          scope="event"
          onBadgeAction={(code) => {
            if (code === 'time_assumed') setFocusField('start');
          }}
        />
      ) : null}
    </article>
  );
}
