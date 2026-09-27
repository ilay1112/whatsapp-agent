// src/renderer/src/components/UndoDismissDrawer.tsx - "Undo dismiss" side panel (UX 6.10, 14.2; owner W1-15).
//
// Opened from the footer button in App.tsx. Lists the LAST 20 items the USER dismissed (`dashboard:getIgnored` returns
// `closed_reason='dismissed'` only - no other closed item is browsable in v1) and offers exactly one action: Restore.
// It never shows a draft, an event or an approval control: undoing a dismissal is not an approval.
//
// `useDialogChrome` lives here rather than in a helper file because UX 14.2 freezes the component inventory ("no new
// component files"). Dashboard.tsx imports it for the approval sheet; the dependency runs Dashboard -> drawer, which is
// the direction that already exists, so there is no import cycle.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ItemCard as ItemVM } from '@shared/types';
import type { ErrorCode } from '@shared/errors';
import { DEFAULT_TIME_ZONE, formatDayLabel, formatTime, makeFormatters } from '@shared/i18n/format';
import { api } from '../api';
import { useDashboardStore } from '../store/dashboard';
import { useSettingsStore } from '../store/settings';

export interface UndoDismissDrawerProps {
  open: boolean;
  onClose(): void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogChrome {
  /** Put on the dialog element. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Put on the element that must receive focus when the dialog opens - always the close button (UX 7 `[R2]`). */
  initialRef: React.RefObject<HTMLButtonElement | null>;
  /** Put on the dialog element's `onKeyDown`. */
  onKeyDown(e: React.KeyboardEvent<HTMLElement>): void;
}

/**
 * Escape-to-close, a Tab focus trap, initial focus on the close button and focus restoration to the opener.
 *
 * `requestClose` may veto (the sheet asks "Discard your edits?" first), so Escape delegates to it instead of closing.
 */
export function useDialogChrome(open: boolean, requestClose: () => void): DialogChrome {
  const containerRef = useRef<HTMLDivElement>(null);
  const initialRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    // The close button exists from the first paint even while the detail is still loading, so one pass is enough.
    initialRef.current?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        requestClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = containerRef.current;
      if (!root) return;
      // The selector already excludes disabled controls and tabindex="-1". Deliberately NOT filtered by `offsetParent`:
      // that is null for every descendant of a `position: fixed` panel in some engines and for everything in jsdom,
      // which would silently collapse the trap to a single node and let Tab escape the dialog.
      const nodes = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => !n.hasAttribute('hidden'));
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const active = document.activeElement;
      if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      }
    },
    [requestClose],
  );

  return { containerRef, initialRef, onKeyDown };
}

/** Close "[x]" glyph, shared by the drawer and the sheet. */
export function CloseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The drawer is mounted only while it is open, so "fetch on open" is just "fetch on mount" and the panel never has to
 * clear stale rows in an effect - closing unmounts them.
 */
export function UndoDismissDrawer(props: UndoDismissDrawerProps) {
  if (!props.open) return null;
  return <UndoDismissPanel onClose={props.onClose} />;
}

function UndoDismissPanel(props: { onClose(): void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'he' ? 'he' : 'en';
  const timeZone = useSettingsStore((s) => s.settings?.general.timeZone) ?? DEFAULT_TIME_ZONE;
  const refresh = useDashboardStore((s) => s.refresh);
  const [items, setItems] = useState<ItemVM[] | null>(null);
  const [error, setError] = useState<ErrorCode | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  // Snapshotted once: a relative time label must not change under the user between two unrelated re-renders.
  const [now] = useState(() => Date.now());
  const titleId = 'undo-drawer-title';
  // Destructured on purpose: the react-hooks/refs rule forbids reading `chrome.someRef` during render.
  const { containerRef, initialRef, onKeyDown } = useDialogChrome(true, props.onClose);

  // The two state writes live in a `.then` callback rather than in the effect body, so no render cascades on mount.
  const load = useCallback((): Promise<void> => {
    return api.getIgnored().then((r) => {
      setItems(r.ok ? r.value.items : []);
      setError(r.ok ? null : r.error.code);
    });
  }, []);

  // UX 14.2: "fetches on open" - and this panel exists only while the drawer is open, so on mount.
  useEffect(() => {
    let alive = true;
    void api.getIgnored().then((r) => {
      if (!alive) return;
      setItems(r.ok ? r.value.items : []);
      setError(r.ok ? null : r.error.code);
    });
    return () => {
      alive = false;
    };
  }, []);

  const restore = (itemId: number): void => {
    setRestoring(itemId);
    void api.restore(itemId).then(() => {
      setRestoring(null);
      void load(); // the restored row must leave the list
      void refresh();
    });
  };

  const f = makeFormatters(lang, timeZone);
  const when = (ts: number): string => {
    const sameDay = f.dayShort.format(new Date(ts)) === f.dayShort.format(new Date(now));
    return sameDay ? formatTime(ts, lang, timeZone) : formatDayLabel(ts, now, lang, timeZone);
  };

  return (
    <>
      <div
        className="fixed inset-0 z-20 bg-scrim"
        data-testid="undo-dismiss-scrim"
        onClick={props.onClose}
        aria-hidden="true"
      />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="undo-dismiss-drawer"
        className="wca-panel fixed inset-y-0 end-0 z-20 flex w-[min(28rem,100%)] flex-col border-s border-line bg-surface"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-line p-3">
          <button
            ref={initialRef}
            type="button"
            className="icon-btn focus-ring"
            data-testid="undo-dismiss-close"
            aria-label={t('app.close')}
            onClick={props.onClose}
          >
            <CloseIcon />
          </button>
          <h2 id={titleId} className="m-0 grow text-base font-semibold">
            {t('ignored.title')}
          </h2>
        </div>

        <div className="min-h-0 grow overflow-y-auto p-3">
          {items === null ? (
            <p className="m-0 text-sm text-text-muted" data-testid="undo-dismiss-loading">
              {t('app.loading')}
            </p>
          ) : error !== null ? (
            <div className="text-sm" data-testid="undo-dismiss-error" role="alert">
              <p className="m-0">{t(`errors.${error}.title`)}</p>
              <button
                type="button"
                className="btn btn-outline mt-2"
                data-testid="undo-dismiss-retry"
                onClick={() => void load()}
              >
                {t('app.tryAgain')}
              </button>
            </div>
          ) : items.length === 0 ? (
            <p className="m-0 text-sm text-text-muted" data-testid="undo-dismiss-empty">
              {t('ignored.empty')}
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="undo-dismiss-list">
              {items.map((item) => (
                <li
                  key={item.itemId}
                  className="flex items-start gap-2 rounded-sm border border-line p-2"
                  data-testid={`dismissed-${item.itemId}`}
                >
                  <div className="min-w-0 grow">
                    <bdi className="msg-text block truncate text-sm font-semibold">
                      {item.chat.displayName !== '' ? item.chat.displayName : item.chat.phoneDisplay}
                    </bdi>
                    {/* Untrusted excerpt: a plain text node inside a truncating block, never markup (UX 16.5). */}
                    <p
                      className="msg-text m-0 truncate text-xs text-text-muted"
                      dir="auto"
                      data-testid={`dismissed-excerpt-${item.itemId}`}
                    >
                      {item.trigger.text ?? t('card.messageRemoved')}
                    </p>
                  </div>
                  <span className="tnum shrink-0 text-xs text-text-muted">{when(item.trigger.ts)}</span>
                  <button
                    type="button"
                    className="btn btn-outline shrink-0"
                    data-testid={`restore-${item.itemId}`}
                    disabled={restoring === item.itemId}
                    onClick={() => restore(item.itemId)}
                  >
                    {t('action.restore')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
