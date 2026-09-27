// src/renderer/src/App.tsx - the app shell (UX 3, 5, 10, 11.1, 12.2, 13, 14.1; owner W1-14).
// Responsibilities: one bootstrap round trip, <html lang dir>, routing onboarding | dashboard | settings, the header
// (wordmark, HealthPill, DownloadPill, pause, language, gear), the setup strip, the footer, the two live regions, the
// toast, the first-open coach mark and the DB_RECOVERY dialog. It owns NO business logic: every side effect goes through
// api.ts, and approvals live on the cards (W1-15).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Bootstrap, ChatView, DownloadProgress, ItemDetail, Lang, OnboardingStep } from '@shared/types';
import { localToEpochMs } from '@shared/when';
import type { AppHealth } from '@shared/health';
import type { ErrorCode } from '@shared/errors';
import type { View } from '@shared/ipc';
import { api, on, onApprovalSuccess } from './api';
import { applyDocumentLanguage, dirOf } from './i18n';
import { installFocusGuard, useHealthStore, type SetupTask } from './store/health';
import { useSettingsStore } from './store/settings';
import { useDashboardStore } from './store/dashboard';
import { HealthPill, type HealthPart } from './components/HealthPill';
import { DownloadPill, type DownloadPillProgress } from './components/DownloadPill';
import { SetupStrip } from './components/SetupStrip';
import { LanguageToggle } from './components/LanguageToggle';
import { Dashboard } from './views/Dashboard';
import { Settings } from './views/Settings';
import { Welcome } from './views/Onboarding/Welcome';
import { ChooseAi } from './views/Onboarding/ChooseAi';
import { LinkWhatsApp } from './views/Onboarding/LinkWhatsApp';
import { GoogleWizard } from './views/Onboarding/GoogleWizard';
import { Ready } from './views/Onboarding/Ready';

/** UX 13.4: the polite region is throttled to one announcement per 10 s per event kind. */
const ANNOUNCE_THROTTLE_MS = 10_000;
const TOAST_MS = 6_000;

const DOWNLOAD_PILL_STATUSES = ['downloading', 'paused', 'verifying', 'failed'] as const;

/** DownloadProgress carries every ModelFileStatus; the pill is shown for four of them (UX 5.3). */
export function toPillProgress(p: DownloadProgress | null): DownloadPillProgress | null {
  if (!p) return null;
  const status = DOWNLOAD_PILL_STATUSES.find((s) => s === p.status);
  if (!status) return null;
  return {
    tier: p.tier,
    status,
    bytesDone: p.bytesDone,
    bytesTotal: p.bytesTotal,
    bytesPerSec: p.bytesPerSec,
    etaSec: p.etaSec ?? undefined,
    errorCode: p.errorCode ?? undefined,
  };
}

/**
 * UX 13.4 / 15.1 item 5: the only untrusted string an announcement may carry is the chat name, and it goes through the
 * `bdi` plain-string formatter. '' display names fall back to the phone text main formatted.
 */
export function announceNameOf(chat: ChatView): string {
  return chat.displayName !== '' ? chat.displayName : chat.phoneDisplay;
}

/** UX 13.4 "Added to calendar: <weekday date time>." - trusted fields only; '' when no start time is known. */
export function announceWhenOf(item: ItemDetail, lang: Lang): string {
  const timeZone = item.event?.timeZone ?? '';
  const startMs =
    item.calendar?.eventStartTs ??
    (item.event && item.event.startLocal !== '' && timeZone !== ''
      ? localToEpochMs(item.event.startLocal, timeZone)
      : null);
  if (startMs === null) return '';
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  };
  try {
    return new Intl.DateTimeFormat(lang, timeZone !== '' ? { ...opts, timeZone } : opts).format(startMs);
  } catch {
    // An unknown IANA zone must not take the shell down; the local zone still says the right thing to the user.
    return new Intl.DateTimeFormat(lang, opts).format(startMs);
  }
}

/** UX 5.4 conditions, most blocking first. */
export function setupTasksOf(health: AppHealth | null, hidden: readonly SetupTask[]): SetupTask[] {
  if (!health) return [];
  const tasks: SetupTask[] = [];
  if (['needs_pairing', 'not_started', 'logged_out'].includes(health.whatsapp.state)) tasks.push('whatsapp');
  if (['model_missing', 'key_missing', 'consent_missing', 'failed'].includes(health.llm.state)) tasks.push('ai');
  if (health.calendar.state === 'not_configured') tasks.push('calendar');
  return tasks.filter((task) => !hidden.includes(task));
}

/** The diary-leaf tray glyph (UX 12.2 shows it inline in the coach mark; the same signature object as the date tab). */
function TrayGlyph() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 9.5h17" />
      <path d="M8 3.5v3M16 3.5v3" strokeLinecap="round" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="2.4" />
      <path
        d="M8 1.6v1.8M8 12.6v1.8M14.4 8h-1.8M3.4 8H1.6M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3M12.5 12.5l-1.3-1.3M4.8 4.8 3.5 3.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChevronBackIcon() {
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
      <path d="M10 3 5 8l5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function App() {
  const { t, i18n } = useTranslation();

  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState<ErrorCode | null>(null);
  const [view, setView] = useState<View>('dashboard');
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const [coachMark, setCoachMark] = useState(false);
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');

  const health = useHealthStore((s) => s.health);
  const progress = useHealthStore((s) => s.progress);
  const hiddenSetupTasks = useHealthStore((s) => s.hiddenSetupTasks);
  const hideSetupTask = useHealthStore((s) => s.hideSetupTask);
  const settings = useSettingsStore((s) => s.settings);
  const savedAt = useSettingsStore((s) => s.savedAt);
  const setSettings = useSettingsStore((s) => s.set);
  const ignoredCount = useDashboardStore((s) => s.ignoredCount);
  const toast = useDashboardStore((s) => s.toast);
  const setToast = useDashboardStore((s) => s.setToast);

  const lastAnnounceRef = useRef<Record<string, number>>({});
  const coachButtonRef = useRef<HTMLButtonElement>(null);
  // `t` is a new function on every language change and react-i18next hands out a fresh `i18n` binding with it; the
  // subscription effect must NOT re-run because of that (it would bootstrap the app a second time).
  const tRef = useRef(t);
  const i18nRef = useRef(i18n);
  useEffect(() => {
    tRef.current = t;
    i18nRef.current = i18n;
  }, [t, i18n]);

  /**
   * Polite announcements are coalesced per kind (UX 13.4). Assertive ones are never throttled, and neither are the
   * ones the table does not mark "throttled"/"coalesced" - approval success must be heard every single time.
   */
  const announce = useCallback(
    (kind: string, text: string, region: 'polite' | 'assertive' = 'polite', throttle = true) => {
      if (region === 'assertive') {
        setAssertive(text);
        return;
      }
      const now = Date.now();
      if (throttle && now - (lastAnnounceRef.current[kind] ?? 0) < ANNOUNCE_THROTTLE_MS) return;
      lastAnnounceRef.current[kind] = now;
      // A repeat of the same sentence must still be spoken: the zero-width joiner changes the node's text without
      // changing what a screen reader reads out.
      setPolite((prev) => (prev === text ? `${text}‍` : text));
    },
    [],
  );

  // ---- one bootstrap round trip + every subscription ----------------------------------------------------------------
  /**
   * UX 11 makes DB_RECOVERY the only full-window blocking state, so every OTHER bootstrap failure has to be
   * recoverable in place (UX 11.4: title + body + one action). `cancelledRef` rather than a local flag because the
   * "Try again" button calls this again, long after the mounting effect's closure is gone.
   */
  const cancelledRef = useRef(false);
  // No synchronous setState here: the mounting effect below calls this directly, and clearing the previous error is
  // the RETRY's job (an event handler), not the fetch's.
  const loadBootstrap = useCallback(() => {
    api
      .getBootstrap()
      .then((r) => {
        if (cancelledRef.current) return;
        if (!r.ok) {
          setBootError(r.error.code);
          return;
        }
        setBootstrap(r.value);
        applyDocumentLanguage(r.value.lang, r.value.dir);
        useHealthStore.getState().setHealth(r.value.health);
        useSettingsStore.getState().hydrate(r.value.settingsPublic);
        setView(r.value.onboardingStep === 'done' ? 'dashboard' : 'onboarding');
        setStep(r.value.onboardingStep);
        void useDashboardStore.getState().refresh();
      })
      .catch(() => {
        // A REJECTED invoke (preload gone, channel torn down) used to leave the window on "Loading..." for ever with
        // no text and nothing to click - the same dead end, minus the sentence.
        if (!cancelledRef.current) setBootError('INTERNAL');
      });
  }, []);

  /** UX 11.4's "one action" for a failed bootstrap: back to the loading frame, then the same round trip again. */
  const retryBootstrap = useCallback(() => {
    setBootError(null);
    loadBootstrap();
  }, [loadBootstrap]);

  useEffect(() => {
    cancelledRef.current = false;
    const store = useHealthStore.getState();

    loadBootstrap();

    const offs = [
      on('health:changed', (h) => store.setHealth(h)),
      on('model:progress', (p) => store.setProgress(p)),
      on('ui:languageChanged', ({ lang, dir }) => {
        void i18nRef.current.changeLanguage(lang);
        applyDocumentLanguage(lang, dir);
      }),
      on('ui:navigate', ({ view: next, itemId }) => {
        if (next === 'tray_hint') {
          setCoachMark(true);
          return;
        }
        setView(next);
        if (itemId != null) void useDashboardStore.getState().openItemById(itemId);
      }),
      on('dashboard:changed', ({ itemIds }) => {
        void useDashboardStore.getState().refresh();
        // UX 2.4 says "while the window is VISIBLE", which is weaker than the focus the announcement asks for: a
        // visible but unfocused window still shows the edge, it just does not speak.
        if (document.visibilityState === 'visible') useDashboardStore.getState().noteArrived(itemIds);
        if (document.hasFocus() && itemIds.length > 0) {
          announce('newCards', tRef.current('app.announce.newCards', { count: itemIds.length }));
        }
      }),
    ];
    const disposeGuard = installFocusGuard();
    return () => {
      cancelledRef.current = true;
      for (const off of offs) off();
      disposeGuard();
    };
  }, [announce, loadBootstrap]);

  // ---- live-region announcements driven by state changes --------------------------------------------------------------
  const overall = health ? (health.paused ? 'paused' : health.overall) : null;
  useEffect(() => {
    if (!overall) return;
    announce('overall', tRef.current(`health.${overall}`));
  }, [overall, announce]);

  const downloadDone = progress?.status === 'ready';
  useEffect(() => {
    if (downloadDone) announce('download', tRef.current('download.finished'));
  }, [downloadDone, announce]);

  useEffect(() => {
    if (savedAt > 0) announce('saved', tRef.current('app.announce.saved'));
  }, [savedAt, announce]);

  // UX 13.4 row 1: approval success is announced app-level, never throttled. The card keeps its own inline
  // confirmation row for sighted users; this is the screen-reader half of the same event.
  useEffect(
    () =>
      onApprovalSuccess(({ kind, item }) => {
        const lang: Lang = i18nRef.current.language === 'he' ? 'he' : 'en';
        if (kind === 'send_reply') {
          announce('approval', tRef.current('app.announce.sent', { name: announceNameOf(item.chat) }), 'polite', false);
          return;
        }
        const when = announceWhenOf(item, lang);
        if (when !== '') announce('approval', tRef.current('app.announce.added', { when }), 'polite', false);
      }),
    [announce],
  );

  // ---- toast: one at a time, 6 s, pauses on hover/focus ---------------------------------------------------------------
  const [toastPaused, setToastPaused] = useState(false);
  useEffect(() => {
    if (!toast || toastPaused) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast, toastPaused, setToast]);

  const dismissCoachMark = useCallback(() => {
    setCoachMark(false);
    void api.ackTrayHint();
  }, []);

  useEffect(() => {
    if (!coachMark) return;
    coachButtonRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismissCoachMark();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [coachMark, dismissCoachMark]);

  const language: Lang = bootstrap ? (i18n.language === 'he' ? 'he' : 'en') : 'en';

  const onLanguage = useCallback(
    (lang: Lang) => {
      // main is the source of truth: settings:set -> ui:languageChanged. The optimistic local switch keeps the toggle
      // responsive if the push is slow; main's answer overwrites it either way.
      void setSettings({ general: { language: lang } });
      void i18n.changeLanguage(lang);
      applyDocumentLanguage(lang, dirOf(lang));
    },
    [setSettings, i18n],
  );

  const onPause = useCallback(async () => {
    const next = !(health?.paused ?? false);
    const r = await api.setPaused(next);
    if (r.ok) useHealthStore.getState().setHealth(r.value);
  }, [health?.paused]);

  const onHealthAction = useCallback((part: HealthPart, code?: ErrorCode) => {
    if (part === 'whatsapp' && (code === 'WA_LOGGED_OUT' || !code)) {
      setView('onboarding');
      setStep('link_whatsapp');
      return;
    }
    if (part === 'calendar' && !code) {
      setView('onboarding');
      setStep('google');
      return;
    }
    if (
      code === 'INTERNAL' ||
      code === 'BRIDGE_SPAWN_REFUSED' ||
      code === 'BRIDGE_TS_FORMAT' ||
      code === 'CAL_TOOLSET_MISMATCH'
    ) {
      void api.exportDiagnostics();
      return;
    }
    setView('settings');
  }, []);

  const onSetupAction = useCallback((task: SetupTask) => {
    setView('onboarding');
    setStep(task === 'whatsapp' ? 'link_whatsapp' : task === 'ai' ? 'choose_ai' : 'google');
  }, []);

  const goToStep = useCallback((next: OnboardingStep) => {
    setStep(next);
    void api.setOnboardingStep(next);
    if (next === 'done') setView('dashboard');
  }, []);

  const openUndoDrawer = useCallback(() => {
    // The drawer itself lives in Dashboard.tsx (W1-15); the footer only asks for it.
    useDashboardStore.getState().setUndoDrawerOpen(true);
  }, []);

  // ---- render ---------------------------------------------------------------------------------------------------------
  // DB_RECOVERY (UX 10 / ARCH 10): recovery itself is AUTOMATIC and already finished in main before this window
  // existed - `openDbWithRecovery()` (src/main/db/backup.ts) restores the newest backup, or moves the unreadable file
  // aside and starts empty, and only then reports the outcome. So there is nothing left for the renderer to restore:
  // both buttons of UX 10 re-run that same start-up path by reloading the window. No `data:restoreBackup` /
  // `data:startFresh` channel exists, and adding one is a CONTRACTS change that only W2-01 may make - see REQUESTS.
  if (bootError === 'DB_RECOVERY') {
    return (
      <div className="grid min-h-full place-items-center bg-canvas p-4">
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="dbr-title"
          data-testid="db-recovery"
          className="w-120 max-w-full rounded-lg bg-surface p-5 shadow-sheet"
        >
          <h1 id="dbr-title" className="mt-0 text-lg">
            {t('dialog.dbRecovery.title')}
          </h1>
          <p className="text-text-muted">{t('dialog.dbRecovery.body')}</p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn btn-outline"
              data-testid="db-recovery-fresh"
              onClick={() => window.location.reload()}
            >
              {t('dialog.dbRecovery.startFresh')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="db-recovery-restore"
              onClick={() => window.location.reload()}
            >
              {t('dialog.dbRecovery.restore')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!bootstrap) {
    return (
      <div data-testid="app-loading" className="grid min-h-full place-items-center bg-canvas p-4 text-text-muted">
        {bootError ? (
          // UX 11.4: title + body + the one action. Without the action this frame was a dead end - the effect above
          // never re-runs on its own, and the window has no menu, no Ctrl+R and no DevTools when packaged.
          <div role="alert" className="flex max-w-100 flex-col items-center gap-2 text-center">
            <p className="m-0 font-semibold text-text">{t(`errors.${bootError}.title`)}</p>
            <p className="m-0">{t(`errors.${bootError}.body`)}</p>
            <button type="button" className="btn btn-primary" data-testid="boot-retry" onClick={retryBootstrap}>
              {t('app.tryAgain')}
            </button>
          </div>
        ) : (
          t('app.loading')
        )}
      </div>
    );
  }

  const onboarding = view === 'onboarding';
  const pillProgress = toPillProgress(progress);
  const tasks = onboarding ? [] : setupTasksOf(health, hiddenSetupTasks);
  const paused = health?.paused ?? settings?.agent.paused ?? false;

  return (
    <div data-testid="app" data-view={view} className="flex min-h-full flex-col bg-canvas text-text">
      <header
        role="banner"
        className={`flex h-12 shrink-0 items-center gap-2 px-4 ${paused ? 'border-b-2 border-warn' : 'border-b border-line'} bg-surface`}
      >
        <span className="text-md font-semibold whitespace-nowrap max-roomy:sr-only">{t('app.wordmark')}</span>
        {!onboarding && health ? <HealthPill health={health} onAction={onHealthAction} /> : null}
        <DownloadPill
          progress={pillProgress}
          onPause={() => void api.pauseDownload()}
          onResume={() => void api.resumeDownload()}
          onCancel={() => void api.cancelDownload()}
          onRetry={() => void api.startDownload()}
        />
        <span className="grow" />
        {!onboarding ? (
          <button
            type="button"
            data-testid="pause-toggle"
            aria-pressed={paused}
            className="btn btn-quiet"
            onClick={() => void onPause()}
          >
            {paused ? t('header.resume') : t('header.pause')}
          </button>
        ) : null}
        <LanguageToggle value={language} onChange={onLanguage} compact />
        {!onboarding ? (
          <button
            type="button"
            data-testid="settings-toggle"
            className="icon-btn"
            aria-label={view === 'settings' ? t('header.backToDashboard') : t('app.settings')}
            onClick={() => setView(view === 'settings' ? 'dashboard' : 'settings')}
          >
            {view === 'settings' ? <ChevronBackIcon /> : <GearIcon />}
          </button>
        ) : null}
      </header>

      {tasks.length > 0 ? <SetupStrip tasks={tasks} onAction={onSetupAction} onHide={hideSetupTask} /> : null}

      <div className="min-h-0 grow">
        {onboarding ? (
          <main aria-label={t('app.mainRegion')} data-testid="onboarding">
            {step === 'welcome' ? <Welcome onDone={() => goToStep('choose_ai')} /> : null}
            {step === 'choose_ai' ? (
              <ChooseAi onDone={() => goToStep('link_whatsapp')} onBack={() => goToStep('welcome')} />
            ) : null}
            {step === 'link_whatsapp' ? (
              <LinkWhatsApp onDone={() => goToStep('google')} onBack={() => goToStep('choose_ai')} />
            ) : null}
            {step === 'google' ? (
              <GoogleWizard
                onDone={() => goToStep('ready')}
                onSkip={() => goToStep('ready')}
                onBack={() => goToStep('link_whatsapp')}
              />
            ) : null}
            {step === 'ready' || step === 'done' ? <Ready onDone={() => goToStep('done')} /> : null}
          </main>
        ) : view === 'settings' ? (
          <Settings />
        ) : (
          <Dashboard />
        )}
      </div>

      {!onboarding ? (
        <footer
          role="contentinfo"
          className="flex h-8 shrink-0 items-center gap-2 border-t border-line bg-surface px-4 text-xs text-text-muted"
        >
          {ignoredCount > 0 ? (
            <button type="button" className="btn btn-quiet" data-testid="undo-dismiss" onClick={openUndoDrawer}>
              {t('footer.undoDismiss')}
            </button>
          ) : null}
          <span className="grow" />
          <span className="tnum" data-testid="app-version">
            {t('app.version', { version: bootstrap.version })}
          </span>
        </footer>
      ) : null}

      {/* UX 13.4: two visually hidden live regions; untrusted text never reaches them. */}
      <div className="sr-only" role="status" aria-live="polite" data-testid="live-polite">
        {polite}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" data-testid="live-assertive">
        {assertive}
      </div>

      {toast ? (
        <div
          role="status"
          data-testid="toast"
          className="fixed end-4 bottom-10 z-30 w-80 max-w-full rounded-sm bg-surface p-3 shadow-pop"
          onMouseEnter={() => setToastPaused(true)}
          onMouseLeave={() => setToastPaused(false)}
          onFocus={() => setToastPaused(true)}
          onBlur={() => setToastPaused(false)}
        >
          <span>{t(toast.key)}</span>
          {toast.itemId != null ? (
            <button
              type="button"
              className="btn btn-quiet ms-2"
              data-testid="toast-undo"
              onClick={() => {
                const itemId = toast.itemId;
                if (itemId != null) void api.restore(itemId);
                setToast(null);
              }}
            >
              {t('action.undo')}
            </button>
          ) : null}
        </div>
      ) : null}

      {coachMark ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-scrim p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="coach-title"
            data-testid="coach-mark"
            className="w-120 max-w-full rounded-lg bg-surface p-5 shadow-sheet"
          >
            <h2 id="coach-title" className="mt-0 text-lg">
              {t('trayHint.title')}
            </h2>
            <div className="flex items-start gap-3">
              <TrayGlyph />
              <p className="m-0 max-w-[68ch]">{t('trayHint.body')}</p>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                ref={coachButtonRef}
                type="button"
                className="btn btn-primary"
                data-testid="coach-mark-ack"
                onClick={dismissCoachMark}
              >
                {t('trayHint.gotIt')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
