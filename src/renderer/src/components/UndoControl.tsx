// src/renderer/src/components/UndoControl.tsx - one Undo door (UX2 3.4, 8, 11.4, 11.5, 14.1; B10, F32; owner V2-W1-11).
//
// Undo is the fail-safe direction, but it still WRITES to the calendar, so it is an approval-class control:
//   - exactly one IPC per activation: a ref is set before the first await, the button turns aria-disabled synchronously
//     (it stays focusable, UX2 11.4), `event.detail > 1` is ignored;
//   - the 500 ms focus-steal guard is read at CLICK time (mouse and Enter/Space), never at render time;
//   - it is never called from an effect, a timer, a toast or a shortcut: `onUndo` runs only inside the click handler.
// "Cancel event" after `blocked_started` (F32, `item:cancelEvent`) goes through the same gate.
// No confirm dialog: undo is itself undoable while the window lasts (UX2 3.4).
// "Open in calendar" next to the blocked lines is the card's own button (ItemCard renders it for every in-calendar card),
// so this control never draws a second one.
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AutoUndoState, ItemId, Result, UndoView } from '@shared/types';
import { DEFAULT_TIME_ZONE } from '@shared/i18n/format';
import { api } from '../api';
import { isActivationBlocked } from '../store/health';
import { useSettingsStore } from '../store/settings';
import { useDashboardStore } from '../store/dashboard';
import { SENTINEL, renderBdiTemplate } from './ItemCard.bdi';
import { formatWhen } from './ChangeLine.format';

export interface UndoControlProps {
  undo: UndoView;
  itemId: ItemId;
  door: 'card' | 'strip' | 'activity';
  onUndo(): Promise<Result<unknown>>;
}

type Phase = 'undoing' | 'undone' | 'failed';
/** What the control shows: the view model's state, or the in-window flow that overlays it until the next refresh. */
export type UndoDisplayState = AutoUndoState | 'undoing';

/** An undo IPC answered `outcome: 'done'` (ApproveOutcome) - anything else is a failure of THIS click. */
export function undoSucceeded(r: Result<unknown>): boolean {
  if (!r.ok) return false;
  const v = r.value as { outcome?: unknown } | null;
  return v !== null && typeof v === 'object' && v.outcome === 'done';
}

/** Mouse half of the activation gate (dblclick + [R2] focus-steal guard). */
export function activationRefused(e: React.MouseEvent<HTMLElement>): boolean {
  return e.detail > 1 || isActivationBlocked();
}
/** Keyboard half: Enter / Space never activate an approval-class control while the guard is armed. */
export function refuseBlockedKey(e: React.KeyboardEvent<HTMLElement>): void {
  if ((e.key === 'Enter' || e.key === ' ') && isActivationBlocked()) e.preventDefault();
}

export function UndoIcon() {
  return <span className="icon icon-undo" aria-hidden="true" />;
}
function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d="m3 8.5 3.2 3L13 4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * An approval-class button that is not an `action:approve` ("Cancel event" F32, "Restore original" F1): one IPC per
 * activation (ref set before the first await, disabled synchronously), `event.detail > 1` ignored, the focus-steal guard
 * read at CLICK time. The dashboard is refreshed once the answer is in; the answer itself is main's verdict.
 */
export function GuardedButton(props: {
  testId: string;
  label: string;
  busyLabel: string;
  run(): Promise<unknown>;
  danger?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  return (
    <button
      type="button"
      className={`btn btn-outline${props.danger ? ' text-danger' : ''}`}
      data-testid={props.testId}
      disabled={busy}
      onClick={(e) => {
        if (activationRefused(e)) return;
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        void props
          .run()
          .catch(() => undefined)
          .finally(() => {
            busyRef.current = false;
            setBusy(false);
            void useDashboardStore.getState().refresh();
          });
      }}
      onKeyDown={refuseBlockedKey}
    >
      {busy ? props.busyLabel : props.label}
    </button>
  );
}

export function UndoControl({ undo, itemId, door, onUndo }: UndoControlProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'he' ? 'he' : 'en';
  const timeZone = useSettingsStore((s) => s.settings?.general.timeZone) ?? DEFAULT_TIME_ZONE;
  // The overlay is bound to the view model it was started from: a refresh that brings a new state or a new revision
  // (blocked_changed, undone, a newer write) replaces it, so a stale "Could not undo" never hides main's verdict.
  const vmKey = `${undo.revisionId}|${undo.state}`;
  const [overlay, setOverlay] = useState<{ phase: Phase; forKey: string } | null>(null);
  const busyRef = useRef(false);
  const phase = overlay !== null && overlay.forKey === vmKey ? overlay.phase : null;
  const shown: UndoDisplayState = phase ?? undo.state;
  const compact = door !== 'card';
  const untilId = `undo-until-${itemId}-${door}`;

  const run = (e: React.MouseEvent<HTMLButtonElement>): void => {
    if (activationRefused(e)) return;
    if (busyRef.current) return; // a second synchronous click sends nothing
    busyRef.current = true;
    setOverlay({ phase: 'undoing', forKey: vmKey });
    void onUndo().then(
      (r) => {
        busyRef.current = false;
        setOverlay({ phase: undoSucceeded(r) ? 'undone' : 'failed', forKey: vmKey });
      },
      () => {
        busyRef.current = false;
        setOverlay({ phase: 'failed', forKey: vmKey });
      },
    );
  };

  let body: React.ReactNode;
  switch (shown) {
    case 'available':
    case 'undoing': {
      const busy = shown === 'undoing';
      body = (
        <>
          <button
            type="button"
            className="btn btn-outline min-h-8 min-w-8"
            data-testid={door === 'card' ? `undo-${itemId}` : `undo-${door}-${itemId}`}
            aria-disabled={busy ? 'true' : undefined}
            aria-describedby={untilId}
            onClick={(e) => {
              if (busy) return;
              run(e);
            }}
            onKeyDown={refuseBlockedKey}
          >
            <UndoIcon />
            {busy ? t('undo.undoing') : t('undo.button')}
          </button>
          <span
            id={untilId}
            className={compact ? 'sr-only' : 'text-xs text-text-muted'}
            data-testid={door === 'card' ? `undo-until-${itemId}` : `undo-until-${door}-${itemId}`}
          >
            {renderBdiTemplate(t('undo.until', { when: SENTINEL(0) }), [formatWhen(undo.until, lang, timeZone)])}
          </span>
        </>
      );
      break;
    }
    case 'undone':
      body = (
        <span className="chip chip-ok" role="status" data-testid={`undo-done-${itemId}`}>
          <CheckIcon />
          {t('undo.undone')}
        </span>
      );
      break;
    case 'expired':
      body = <span className="text-xs text-text-muted">{t('undo.expired')}</span>;
      break;
    case 'blocked_changed':
      body = (
        <>
          <span className="note-amber text-sm">
            {compact ? t('undo.blockedChangedShort') : t('undo.blockedChanged')}
          </span>
        </>
      );
      break;
    case 'blocked_started':
      body = (
        <>
          <span className="note-amber text-sm">
            {compact ? t('undo.blockedStartedShort') : t('undo.blockedStarted')}
          </span>
          {door === 'card' ? (
            // F32 (UX2 C9 resolved): an explicit, guarded click that mints and approves a user cancel.
            <GuardedButton
              testId={`undo-cancel-event-${itemId}`}
              label={t('change.cancelEvent')}
              busyLabel={t('change.cancelling')}
              danger
              run={() => api.cancelEvent(itemId)}
            />
          ) : null}
        </>
      );
      break;
    default:
      // 'failed' - main's verdict or this click's.
      body = (
        <>
          <span className="text-sm text-danger" role={phase === 'failed' ? 'alert' : undefined}>
            {t('undo.failed')}
          </span>
          <button
            type="button"
            className="btn btn-outline"
            data-testid={door === 'card' ? `undo-retry-${itemId}` : `undo-retry-${door}-${itemId}`}
            onClick={run}
            onKeyDown={refuseBlockedKey}
          >
            {t('app.tryAgain')}
          </button>
        </>
      );
  }

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid={door === 'card' ? `undo-state-${itemId}` : `undo-state-${door}-${itemId}`}
      data-state={shown}
      data-door={door}
    >
      {body}
    </div>
  );
}
