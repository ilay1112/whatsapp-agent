// src/renderer/src/components/UpdateBanner.tsx - [v5] T-909 W3: the in-app update row (spec v5-updates-handover 2.3).
// Rendered by App.tsx in the shell's non-scrolling top block, next to SetupStrip (both views, never during onboarding).
// It is NOT a SetupStrip row: SetupStrip's "Hide" is renderer memory, while this banner's X in the `available` state is the
// persisted, main-side `update:ignore {version}` (that one version only - a newer release brings the banner back). During a
// download / once ready the X only hides the banner until the next launch (`bannerHidden`, no IPC).
// Every value shown is an app fact from main (a plain version string, a percent) - never message text.
import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { isActivationBlocked } from '../store/health';
import { bannerModeOf, downloadPercent, useUpdateStore } from '../store/update';
import { CloseIcon } from './UndoDismissDrawer';

function UpdateIcon() {
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
      <path d="M8 2.5v7.5M4.8 6.8 8 10l3.2-3.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 12.8h10" strokeLinecap="round" />
    </svg>
  );
}

export function UpdateBanner() {
  const { t } = useTranslation();
  const state = useUpdateStore((s) => s.state);
  const hidden = useUpdateStore((s) => s.bannerHidden);
  const busy = useUpdateStore((s) => s.busy);
  const mode = bannerModeOf(state, hidden);
  if (mode === null || state === null) return null;

  const version = state.latest ?? '';
  const pct = downloadPercent(state);
  const store = useUpdateStore.getState;

  const onRestart = (e: MouseEvent<HTMLButtonElement>): void => {
    // Read at CLICK time: a click that lands right after the window was activated (or a double click) is swallowed.
    if (e.detail > 1 || isActivationBlocked()) return;
    void store().install();
  };

  return (
    <section
      aria-label={t('update.bannerLabel')}
      data-testid="update-banner"
      data-state={mode}
      className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-line bg-accent-soft px-4 py-1 text-text"
    >
      <UpdateIcon />
      {mode === 'available' ? (
        <>
          <span className="grow text-sm">{t('update.available', { version })}</span>
          {!state.canInstall ? (
            // a dev / unpackaged copy (or a folder that is not the app's own) could download but never install: say so up front
            <span className="text-xs text-text-muted" data-testid="update-banner-devonly">
              {t('settings.update.devOnly')}
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn-outline"
            data-testid="update-banner-install"
            disabled={busy !== null || !state.canInstall}
            onClick={() => void store().download()}
          >
            {t('update.install')}
          </button>
          <button
            type="button"
            className="icon-btn"
            data-testid="update-banner-ignore"
            aria-label={t('update.ignore')}
            title={t('update.ignore')}
            disabled={busy !== null}
            onClick={() => void store().ignore(version)}
          >
            <CloseIcon />
          </button>
        </>
      ) : (
        <>
          {mode === 'downloading' ? (
            <span className="flex min-w-40 grow flex-col gap-1 text-sm">
              <span className="tnum">{t('update.downloading', { pct })}</span>
              <span className="block h-1 w-full max-w-60 overflow-hidden rounded-full bg-surface">
                <span
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pct}
                  aria-label={t('update.downloading', { pct })}
                  data-testid="update-banner-progress"
                  className="block h-full bg-accent"
                  style={{ inlineSize: `${pct}%` }}
                />
              </span>
            </span>
          ) : (
            <>
              <span className="grow text-sm">{t('update.ready')}</span>
              {!state.canInstall ? (
                <span className="text-xs text-text-muted" data-testid="update-banner-devonly">
                  {t('settings.update.devOnly')}
                </span>
              ) : null}
              <button
                type="button"
                className="btn btn-primary"
                data-testid="update-banner-restart"
                disabled={!state.canInstall || busy !== null}
                onClick={onRestart}
              >
                {t('update.restart')}
              </button>
            </>
          )}
          <button
            type="button"
            className="icon-btn"
            data-testid="update-banner-hide"
            aria-label={t('update.hide')}
            title={t('update.hide')}
            onClick={() => store().hideBanner()}
          >
            <CloseIcon />
          </button>
        </>
      )}
    </section>
  );
}
