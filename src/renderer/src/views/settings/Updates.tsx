// src/renderer/src/views/settings/Updates.tsx - [v5] T-909 W3: Settings > Updates (spec v5-updates-handover 2.3).
// Current version, latest + when it was last checked, Check now, Download and install / Restart to finish, "Show version X
// again" when one is ignored, the error line (Settings only - errors never reach the banner) and the privacy sentence. A copy
// that cannot install (dev / unpackaged / e2e, or an install folder that is not the app's own) says so and keeps Download
// and Install disabled; main refuses `update:install` there anyway. The page never sees a URL or a path: every channel here carries none.
import { useEffect, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ErrorCode } from '@shared/errors';
import { formatRelativeAge } from '@shared/i18n/format';
import { isActivationBlocked } from '../../store/health';
import { downloadPercent, installLabelOf, useUpdateStore } from '../../store/update';
import { Group, Row } from './parts';

/** The Settings error line of a failed check / download (the model downloader's copy is about the model, so not reused). */
function errorLineKeys(code: ErrorCode): { title: string; body?: string } {
  switch (code) {
    case 'DOWNLOAD_FAILED':
      return { title: 'settings.update.downloadFailed' };
    case 'DISK_FULL':
      return { title: 'settings.update.diskFull' };
    case 'UPDATE_CHECK_FAILED':
    case 'UPDATE_VERIFY_FAILED':
      return { title: `errors.${code}.title`, body: `errors.${code}.body` };
    default:
      return { title: 'settings.update.actionFailed' };
  }
}

export function Updates() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'he' ? 'he' : 'en';
  const state = useUpdateStore((s) => s.state);
  const busy = useUpdateStore((s) => s.busy);
  const actionError = useUpdateStore((s) => s.actionError);
  // The clock "Checked 5 min. ago" is measured with; sampled, never read during render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    void useUpdateStore.getState().hydrate(); // opening Settings re-reads the state (read only)
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, []);
  // A check newer than the sampled clock reads as "Checked now", never as the future (max below).
  const lastCheckAt = state?.lastCheckAt ?? null;

  const store = useUpdateStore.getState;
  const label = installLabelOf(state);
  const status = state?.status ?? 'idle';
  const checkedLine =
    status === 'checking'
      ? t('settings.update.checking')
      : lastCheckAt !== null
        ? t('settings.update.lastChecked', { when: formatRelativeAge(lastCheckAt, Math.max(now, lastCheckAt), lang) })
        : t('settings.update.notChecked');

  const onInstall = (e: MouseEvent<HTMLButtonElement>): void => {
    if (label === 'download') {
      void store().download();
      return;
    }
    // Restart: read the focus-steal guard at CLICK time; main focus-gates update:install again.
    if (e.detail > 1 || isActivationBlocked()) return;
    void store().install();
  };

  const err = status === 'error' && state?.errorCode ? errorLineKeys(state.errorCode) : null;

  return (
    <Group group="updates" title={t('settings.group.updates')}>
      <Row label={t('settings.update.current')} testId="settings-update-current">
        <span className="tnum">{state?.current ?? '-'}</span>
      </Row>

      <Row label={t('settings.update.latest')} desc={checkedLine} testId="settings-update-latest">
        <span className="tnum">{state?.latest ?? '-'}</span>
        {status === 'up_to_date' ? (
          <span className="chip" data-testid="settings-update-uptodate">
            {t('settings.update.upToDate')}
          </span>
        ) : null}
      </Row>

      <div className="flex flex-col gap-2 py-3" data-testid="settings-row-update-actions">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-outline"
            data-testid="settings-update-check"
            disabled={busy !== null || ['checking', 'downloading', 'installing'].includes(status)}
            onClick={() => void store().check()}
          >
            {t('settings.update.check')}
          </button>
          {label !== null ? (
            <button
              type="button"
              className="btn btn-primary"
              data-testid="settings-update-install"
              disabled={
                busy !== null ||
                label === 'downloading' ||
                status === 'installing' ||
                // a copy that cannot install never downloads either (it would fetch ~230 MB it can never use)
                ((label === 'restart' || label === 'download') && !state?.canInstall)
              }
              onClick={onInstall}
            >
              {label === 'download'
                ? t('settings.update.installAction')
                : label === 'downloading'
                  ? t('update.downloading', { pct: downloadPercent(state) })
                  : t('settings.update.restartAction')}
            </button>
          ) : null}
          {state?.ignoredVersion ? (
            <button
              type="button"
              className="btn btn-quiet"
              data-testid="settings-update-unignore"
              disabled={busy !== null}
              onClick={() => void store().unignore()}
            >
              {t('settings.update.unignore', { version: state.ignoredVersion })}
            </button>
          ) : null}
        </div>

        {err ? (
          <p role="alert" className="m-0 text-sm" data-testid="settings-update-error">
            <span className="font-semibold">{t(err.title)}</span>
            {err.body ? <span className="text-text-muted"> {t(err.body)}</span> : null}
          </p>
        ) : null}
        {actionError ? (
          <p role="alert" className="m-0 text-sm" data-testid="settings-update-action-error">
            {t('settings.update.actionFailed')}
          </p>
        ) : null}
        {state && !state.canInstall ? (
          <p className="m-0 text-sm text-text-muted" data-testid="settings-update-devonly">
            {t('settings.update.devOnly')}
          </p>
        ) : null}
        <p className="m-0 text-sm text-text-muted" data-testid="settings-update-privacy">
          {t('settings.update.privacy')}
        </p>
      </div>
    </Group>
  );
}
