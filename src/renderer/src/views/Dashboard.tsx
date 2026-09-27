// src/renderer/src/views/Dashboard.tsx - three columns + approval sheet + undo-dismiss drawer (UX 6, 7, 13.2; owner W1-15).
//
// Owns:
//   - the three ItemLists in the fixed order Needs reply / In calendar / Information missing;
//   - the one-column mode under 900 px (collapsible sections, "In calendar" closed by default);
//   - the "Analysing N chats..." line, read from `AppHealth.queue` (UX 6.3) with `DashboardData.analysing` as the
//     fallback until health is hydrated;
//   - the expanded-card sheet. `[R2]` INITIAL FOCUS IS ALWAYS THE CLOSE BUTTON, however the sheet was opened - card
//     click, Enter, "Show more", EventChip, a badge, or `ui:navigate` from a notification toast. The close button is
//     rendered HERE, by the dialog chrome, not by `ItemCard mode="expanded"`, because `item:get` is a round trip: the
//     dialog (and its close button) exist before the card does, so focus lands correctly on the very first paint and
//     never has to be moved again when the detail arrives.
//   - F6 / Shift+F6 region cycling and Up/Down/Left/Right roving between cards. `[R2]` No Alt+P, Ctrl+, or Ctrl+L.
//
// Does NOT own: `SetupStrip` (App.tsx already renders it above every non-onboarding view - rendering it again would
// duplicate the strip), the toast, the live regions or the footer.
//
// No approval logic lives here. Approving is ItemCard's business; this view only decides what is on screen.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useDashboardStore, LIST_KEYS, type ListKey } from '../store/dashboard';
import { useHealthStore } from '../store/health';
import { ItemList } from '../components/ItemList';
import { ItemCard } from '../components/ItemCard';
import { CloseIcon, UndoDismissDrawer, useDialogChrome } from '../components/UndoDismissDrawer';
import './dashboard.css';

/** UX 6.1 / 6.2: three columns from 900 px, one column below it. 900 px = 56.25rem at the default root size. */
const WIDE_QUERY = '(min-width: 56.25rem)';

function subscribeWide(onChange: () => void): () => void {
  const mql = window.matchMedia?.(WIDE_QUERY);
  if (!mql) return () => {};
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}
/** jsdom does not implement matchMedia; the dashboard then behaves as the wide layout (the tests stub it when needed). */
function wideSnapshot(): boolean {
  return window.matchMedia?.(WIDE_QUERY).matches ?? true;
}
function useWideLayout(): boolean {
  return useSyncExternalStore(subscribeWide, wideSnapshot, wideSnapshot);
}

/** Two static skeleton cards per column until `dashboard:get` resolves (UX 11.1). No shimmer, by design. */
function Skeletons() {
  const { t } = useTranslation();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div data-testid="list-skeletons" aria-hidden="true" className="flex flex-col gap-3">
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-2 rounded-md border border-line bg-surface p-3">
          <div className="h-4 w-1/2 rounded-xs bg-quote" />
          <div className="h-10 w-full rounded-xs bg-quote" />
          <div className="h-8 w-24 rounded-xs bg-quote" />
        </div>
      ))}
      {slow ? <p className="m-0 text-xs text-text-muted">{t('list.stillLoading')}</p> : null}
    </div>
  );
}

export function Dashboard() {
  const { t } = useTranslation();
  const lists = useDashboardStore((s) => s.lists);
  const analysingFallback = useDashboardStore((s) => s.analysing);
  const hydrated = useDashboardStore((s) => s.hydrated);
  const loadError = useDashboardStore((s) => s.loadError);
  const sectionOpen = useDashboardStore((s) => s.sectionOpen);
  const toggleSection = useDashboardStore((s) => s.toggleSection);
  const openItemId = useDashboardStore((s) => s.openItemId);
  const openItem = useDashboardStore((s) => s.openItem);
  const openItemById = useDashboardStore((s) => s.openItemById);
  const dirtyItemIds = useDashboardStore((s) => s.dirtyItemIds);
  const undoDrawerOpen = useDashboardStore((s) => s.undoDrawerOpen);
  const setUndoDrawerOpen = useDashboardStore((s) => s.setUndoDrawerOpen);
  const health = useHealthStore((s) => s.health);

  const wide = useWideLayout();
  const mainRef = useRef<HTMLElement>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const sheetTitleId = 'sheet-title';

  const analysing = health ? health.queue.pending + health.queue.running : analysingFallback;
  const sheetOpen = openItemId !== null;

  // -------------------------------------------------------------------------------------------------------------------
  // sheet
  // -------------------------------------------------------------------------------------------------------------------
  const closeSheet = useCallback((): void => {
    setConfirmDiscard(false);
    void openItemById(null);
  }, [openItemById]);

  /** UX 7: Escape / [x] ask "Discard your edits?" only when the card actually has unsaved edits. */
  const requestCloseSheet = useCallback((): void => {
    if (openItemId !== null && dirtyItemIds.has(openItemId)) {
      setConfirmDiscard(true);
      return;
    }
    closeSheet();
  }, [closeSheet, dirtyItemIds, openItemId]);

  // Destructured on purpose: the react-hooks/refs rule forbids reading `chrome.someRef` during render.
  const {
    containerRef: sheetRef,
    initialRef: sheetCloseRef,
    onKeyDown: onSheetKeyDown,
  } = useDialogChrome(sheetOpen, requestCloseSheet);

  // -------------------------------------------------------------------------------------------------------------------
  // keyboard: F6 regions + roving arrows over the card roots (UX 13.2)
  // -------------------------------------------------------------------------------------------------------------------
  const visibleLists = useMemo(() => LIST_KEYS.filter((k) => wide || sectionOpen[k]), [wide, sectionOpen]);

  const cardRoots = useCallback((list?: ListKey): HTMLElement[] => {
    const scope = list ? mainRef.current?.querySelector(`[data-testid="list-${list}"]`) : mainRef.current;
    return [...(scope?.querySelectorAll<HTMLElement>('[data-card-root]') ?? [])];
  }, []);

  /**
   * Roving tabindex (UX 13.2): exactly one card per column is in the tab order. `tabIndex` is not a prop of ItemCard -
   * UX 14.2 freezes its props - so the attribute is set here, on the rendered card roots.
   */
  useEffect(() => {
    for (const list of LIST_KEYS) {
      const roots = cardRoots(list);
      const active = roots.find((n) => n === document.activeElement) ?? roots[0];
      for (const node of roots) node.setAttribute('tabindex', node === active ? '0' : '-1');
    }
  });

  const focusCard = (list: ListKey, index: number): void => {
    const roots = cardRoots(list);
    if (roots.length === 0) return;
    const node = roots[Math.max(0, Math.min(index, roots.length - 1))];
    node?.setAttribute('tabindex', '0');
    node?.focus();
  };

  const onMainKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'F6') {
      // UX 13.2 regions: header, column 1..3, footer. Header and footer belong to App.tsx, so they are found by testid.
      e.preventDefault();
      const regions = [
        document.querySelector<HTMLElement>('[data-testid="pause-toggle"]'),
        ...visibleLists.map(
          (k) => mainRef.current?.querySelector<HTMLElement>(`[data-testid="list-${k}"] h2 > *`) ?? null,
        ),
        document.querySelector<HTMLElement>('[data-testid="undo-dismiss"]') ??
          document.querySelector<HTMLElement>('[data-testid="app-version"]'),
      ].filter((n): n is HTMLElement => n !== null);
      if (regions.length === 0) return;
      const active = document.activeElement;
      const current = regions.findIndex((n) => n === active || n.contains(active));
      const step = e.shiftKey ? -1 : 1;
      const from = current === -1 ? (e.shiftKey ? 0 : -1) : current;
      const next = regions[(((from + step) % regions.length) + regions.length) % regions.length]!;
      // A column heading in three-column mode is a plain <span>; make it programmatically focusable for this hop only.
      if (!next.hasAttribute('tabindex') && next.tagName !== 'BUTTON') next.setAttribute('tabindex', '-1');
      next.focus();
      return;
    }

    const root = (e.target as HTMLElement).closest?.('[data-card-root]');
    if (!root || e.target !== root) return;
    const list = (root.closest('[data-list]')?.getAttribute('data-list') ?? null) as ListKey | null;
    const column = visibleLists.find((k) => cardRoots(k).includes(root as HTMLElement)) ?? list;
    if (!column) return;
    const roots = cardRoots(column);
    const index = roots.indexOf(root as HTMLElement);

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusCard(column, index + (e.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      // "Right moves to the visually right column in both LTR and RTL" (UX 13.2).
      const rtl = document.documentElement.dir === 'rtl';
      const forward = e.key === 'ArrowRight' ? !rtl : rtl;
      const at = visibleLists.indexOf(column);
      const target = visibleLists[at + (forward ? 1 : -1)];
      if (target) focusCard(target, index);
    }
  };

  // -------------------------------------------------------------------------------------------------------------------
  // empty states (UX 11.2) - plain text, at most one call to action, never an illustration
  // -------------------------------------------------------------------------------------------------------------------
  const emptyFor = (list: ListKey): ReactNode => {
    if (!hydrated) return <Skeletons />;
    if (loadError !== null) return null; // the column-spanning error row above already says it
    if (list === 'needs_reply') {
      if (health?.paused === true) return t('list.empty.needsReplyPaused');
      if (health && health.whatsapp.state !== 'online') return t('list.empty.needsReplyNotLinked');
      if (analysing > 0) return t('list.empty.needsReplyQueue', { count: analysing });
      return t('list.empty.needsReply');
    }
    if (list === 'in_calendar') {
      if (health && health.calendar.state !== 'connected') return t('list.empty.inCalendarNotConnected');
      return t('list.empty.inCalendar');
    }
    return t('list.empty.infoMissing');
  };

  return (
    <main
      ref={mainRef}
      aria-label={t('app.mainRegion')}
      data-testid="dashboard"
      data-layout={wide ? 'wide' : 'narrow'}
      className="flex min-h-0 grow flex-col gap-2 p-4"
      onKeyDown={onMainKeyDown}
    >
      <h1 className="sr-only">{t('app.dashboard')}</h1>

      {loadError !== null ? (
        <div
          className="rounded-sm bg-danger-soft p-3 text-sm text-danger"
          role="alert"
          data-testid="dashboard-load-error"
        >
          {t('list.loadFailed')}
          <button
            type="button"
            className="btn btn-outline ms-2"
            data-testid="dashboard-retry"
            onClick={() => void useDashboardStore.getState().refresh()}
          >
            {t('app.tryAgain')}
          </button>
        </div>
      ) : null}

      <div
        className={wide ? 'dash-columns grid min-h-0 grow gap-4' : 'flex min-h-0 grow flex-col gap-3 overflow-y-auto'}
      >
        {LIST_KEYS.map((key) => (
          <ItemList
            key={key}
            list={key}
            title={t(`list.${key}`)}
            count={lists[key].count}
            items={lists[key].items}
            queueCount={key === 'needs_reply' ? analysing : undefined}
            collapsible={!wide}
            open={wide || sectionOpen[key]}
            onToggle={() => toggleSection(key)}
            emptyState={emptyFor(key)}
            onOpenItem={(id) => void openItemById(id)}
          />
        ))}
      </div>

      {/* ---- approval sheet (UX 7) ------------------------------------------------------------------------------- */}
      {sheetOpen ? (
        <>
          <div
            className="fixed inset-0 z-20 bg-scrim"
            data-testid="sheet-scrim"
            aria-hidden="true"
            onClick={requestCloseSheet}
          />
          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={sheetTitleId}
            data-testid="item-sheet"
            className="wca-panel fixed inset-y-0 end-0 z-20 flex w-[min(35rem,100%)] flex-col border-s border-line bg-surface"
            onKeyDown={onSheetKeyDown}
          >
            <div className="flex items-center gap-2 border-b border-line p-3">
              <button
                ref={sheetCloseRef}
                type="button"
                className="icon-btn focus-ring"
                data-testid="sheet-close"
                aria-label={t('app.close')}
                onClick={requestCloseSheet}
              >
                <CloseIcon />
              </button>
              <h2 id={sheetTitleId} className="m-0 grow truncate text-base font-semibold">
                {/* Trusted text only: the untrusted contact name lives inside the card's own <bdi> header (UX 16.5). */}
                {openItem && (LIST_KEYS as readonly string[]).includes(openItem.status)
                  ? t(`list.${openItem.status}`)
                  : t('sheet.title')}
              </h2>
            </div>

            <div className="min-h-0 grow overflow-y-auto p-3">
              {openItem ? (
                <ItemCard key={openItem.itemId} item={openItem} mode="expanded" onClose={closeSheet} />
              ) : (
                <p className="m-0 text-sm text-text-muted" data-testid="sheet-loading">
                  {t('sheet.loading')}
                </p>
              )}
            </div>

            {confirmDiscard ? (
              <div
                className="border-t border-line p-3"
                role="alertdialog"
                aria-label={t('sheet.discardTitle')}
                data-testid="discard-confirm"
              >
                <p className="m-0 text-sm font-semibold">{t('sheet.discardTitle')}</p>
                <p className="m-0 text-sm text-text-muted">{t('sheet.discardBody')}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn btn-danger"
                    data-testid="discard-confirm-yes"
                    onClick={closeSheet}
                  >
                    {t('sheet.discardConfirm')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    data-testid="discard-confirm-no"
                    onClick={() => setConfirmDiscard(false)}
                  >
                    {t('sheet.discardCancel')}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      <UndoDismissDrawer open={undoDrawerOpen} onClose={() => setUndoDrawerOpen(false)} />
    </main>
  );
}
