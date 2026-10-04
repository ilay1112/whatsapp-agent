// src/renderer/src/views/Onboarding/Ready.tsx - step 4 (UX 8.4, ARCH 12.1; owner W1-16).
// A LIVE checklist (it re-reads `onboarding:getState` whenever health or the download progress changes), the two tray
// sentences with the inline tray glyph ([R2] no flyout picture in v1), the autostart toggle (default OFF) and the two
// storage notes.
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { OnboardingState } from '@shared/types';
import { api } from '../../api';
import { useHealthStore } from '../../store/health';
import { useSettingsStore } from '../../store/settings';
import { CheckIcon, StepFrame, num } from './frame';

export interface ReadyProps {
  onDone(): void;
}

/**
 * The tray glyph of UX 8.4 / 12.2: the same diary-leaf signature object as the header's coach mark, inline as SVG.
 * [R2] It is the ONLY graphic in onboarding.
 */
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
      className="shrink-0"
    >
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 9.5h17" />
      <path d="M8 3.5v3M16 3.5v3" strokeLinecap="round" />
    </svg>
  );
}

function PendingIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      className="shrink-0"
    >
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.6V8l2.2 1.6" strokeLinecap="round" />
    </svg>
  );
}

export function Ready({ onDone }: ReadyProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [state, setState] = useState<OnboardingState | null>(null);
  const health = useHealthStore((s) => s.health);
  const progress = useHealthStore((s) => s.progress);
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.set);

  const refresh = useCallback(async () => {
    const r = await api.getOnboarding();
    if (r.ok) setState(r.value);
  }, []);

  // The checklist is live: health:changed and model:progress land in the health store, and each landing re-reads the
  // authoritative checklist from main rather than guessing it here.
  useEffect(() => {
    // Started from the promise chain, never called straight from the effect body: nothing may set state synchronously
    // while this effect runs.
    void Promise.resolve().then(() => refresh());
  }, [refresh, health, progress]);

  const checklist = state?.checklist;
  const autostart = settings?.general.autostart ?? false;

  // [V2] V2-W1-12 (UX2 6 step 4): + the "Voice notes" row (`ready-voice`). Automatic mode is never offered here.
  const rows: { key: 'ai' | 'whatsapp' | 'calendar' | 'voice'; ready: boolean; text: string }[] = [
    {
      key: 'ai',
      ready: checklist?.ai === 'ready',
      text:
        checklist?.ai === 'ready'
          ? t('onboarding.ready.aiReady')
          : checklist?.ai === 'downloading'
            ? t('onboarding.ready.aiDownloading', { percent: num(checklist.aiPercent ?? 0, lang) })
            : t('onboarding.ready.aiPending'),
    },
    {
      key: 'whatsapp',
      ready: checklist?.whatsapp === 'ready',
      text:
        checklist?.whatsapp === 'ready' ? t('onboarding.ready.whatsappReady') : t('onboarding.ready.whatsappPending'),
    },
    {
      key: 'calendar',
      ready: checklist?.calendar === 'ready',
      text:
        checklist?.calendar === 'ready'
          ? t('onboarding.ready.calendarReady')
          : checklist?.calendar === 'skipped'
            ? t('onboarding.ready.calendarSkipped')
            : t('onboarding.ready.calendarPending'),
    },
    {
      key: 'voice',
      ready: checklist?.voice === 'ready',
      text:
        checklist?.voice === 'ready'
          ? t('onboarding.ready.voiceReady')
          : checklist?.voice === 'downloading'
            ? t('onboarding.ready.voiceDownloading', { percent: num(checklist.voicePercent ?? 0, lang) })
            : t('onboarding.ready.voiceOff'),
    },
  ];

  return (
    <StepFrame
      index={4}
      testId="onboarding-ready"
      title={t('onboarding.ready.title')}
      primary={
        <button type="button" className="btn btn-primary" data-testid="ready-open" onClick={onDone}>
          {t('onboarding.ready.open')}
        </button>
      }
    >
      <ul aria-label={t('onboarding.ready.checklistLabel')} className="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map((row) => (
          <li
            key={row.key}
            data-testid={`ready-${row.key}`}
            data-ready={row.ready ? '1' : '0'}
            className="flex items-center gap-2"
          >
            <span className={row.ready ? 'text-ok' : 'text-text-muted'}>
              {row.ready ? <CheckIcon /> : <PendingIcon />}
            </span>
            <span className="font-semibold">{t(`onboarding.ready.${row.key}`)}</span>
            <span className="text-text-muted">{row.text}</span>
          </li>
        ))}
      </ul>

      <section className="flex items-start gap-3 rounded-md bg-surface p-3" aria-labelledby="ready-tray">
        <TrayGlyph />
        <div className="flex flex-col gap-2">
          <h2 id="ready-tray" className="sr-only">
            {t('trayHint.title')}
          </h2>
          <p className="m-0">{t('onboarding.ready.tray1')}</p>
          <p className="m-0">{t('onboarding.ready.tray2')}</p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              data-testid="ready-autostart"
              checked={autostart}
              onChange={(e) => void setSettings({ general: { autostart: e.target.checked } })}
            />
            <span>{t('onboarding.ready.autostart')}</span>
          </label>
        </div>
      </section>

      <p className="m-0 flex flex-wrap items-center gap-2 text-sm text-text-muted" data-testid="ready-bitlocker">
        <span className="grow">{t('onboarding.ready.bitlocker')}</span>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => void api.openExternal({ target: 'bitlocker_help' })}
        >
          {t('onboarding.ready.whatToDo')}
        </button>
      </p>

      {state?.userDataCloudSynced ? (
        <p
          className="m-0 flex flex-wrap items-center gap-2 rounded-sm bg-warn-soft p-2"
          data-testid="ready-cloud-synced"
        >
          <span className="grow">{t('onboarding.ready.cloudSynced')}</span>
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => void api.openExternal({ target: 'project_readme' })}
          >
            {t('onboarding.ready.whatToDo')}
          </button>
        </p>
      ) : null}
    </StepFrame>
  );
}
