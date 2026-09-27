// src/renderer/src/views/Onboarding/Welcome.tsx - step 0 (UX 8.0, ARCH 12.1; owner W1-16).
// Language choice + the explicit, versioned WhatsApp ToS / ban-risk acceptance. Without that consent record main never
// spawns the bridge (ARCH 4.3 `not_started`), so this screen is the first structural gate of the approval-first design:
// "Get started" is disabled until the box is ticked, and it does nothing but record the consent and move on.
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CONSENT_VERSIONS, type Lang } from '@shared/types';
import type { ErrorCode } from '@shared/errors';
import { api } from '../../api';
import { applyDocumentLanguage, dirOf } from '../../i18n';
import { useSettingsStore } from '../../store/settings';
import { StepFrame } from './frame';

export interface WelcomeProps {
  onDone(): void;
}

const LANGS: readonly Lang[] = ['he', 'en'];

export function Welcome({ onDone }: WelcomeProps) {
  const { t, i18n } = useTranslation();
  const setSettings = useSettingsStore((s) => s.set);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);

  const language: Lang = i18n.language === 'he' ? 'he' : 'en';

  const onLanguage = useCallback(
    (lang: Lang) => {
      // Same protocol as the header toggle (App.tsx): main owns the setting, the local switch only keeps the UI honest
      // until `ui:languageChanged` arrives.
      void setSettings({ general: { language: lang } });
      void i18n.changeLanguage(lang);
      applyDocumentLanguage(lang, dirOf(lang));
    },
    [setSettings, i18n],
  );

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    const r = await api.acceptConsent('whatsapp_tos', CONSENT_VERSIONS.whatsapp_tos);
    setBusy(false);
    if (!r.ok) {
      setError(r.error.code);
      return;
    }
    onDone();
  }, [onDone]);

  return (
    <StepFrame
      index={0}
      testId="onboarding-welcome"
      title={t('onboarding.welcome.title')}
      primary={
        <button
          type="button"
          className="btn btn-primary"
          data-testid="welcome-start"
          disabled={!accepted || busy}
          onClick={() => void start()}
        >
          {t('welcome.start')}
        </button>
      }
    >
      <p className="m-0">{t('onboarding.welcome.body1')}</p>
      <p className="m-0">{t('onboarding.welcome.body2')}</p>
      <p className="m-0 font-semibold">{t('welcome.promise')}</p>

      <fieldset className="m-0 flex flex-wrap items-center gap-4 border-0 p-0">
        <legend className="p-0 font-semibold">{t('onboarding.welcome.languageLabel')}</legend>
        {LANGS.map((lang) => (
          <label key={lang} className="flex items-center gap-2" lang={lang}>
            <input
              type="radio"
              name="welcome-language"
              value={lang}
              data-testid={`welcome-language-${lang}`}
              checked={language === lang}
              onChange={() => onLanguage(lang)}
            />
            {/* Endonyms: the seeded `language.<lang>` keys, never translated (i18n-rtl.md 4.3). */}
            <span>{t(`language.${lang}`)}</span>
          </label>
        ))}
      </fieldset>

      <section aria-labelledby="welcome-before" className="rounded-md bg-warn-soft p-3">
        <h2 id="welcome-before" className="mt-0 mb-2 text-md">
          {t('onboarding.welcome.beforeTitle')}
        </h2>
        <ul className="m-0 flex list-disc flex-col gap-1 ps-5">
          <li>{t('onboarding.welcome.risk1')}</li>
          <li>{t('onboarding.welcome.risk2')}</li>
        </ul>
        <label className="mt-3 flex items-start gap-2">
          <input
            type="checkbox"
            data-testid="welcome-accept"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />
          <span>{t('onboarding.welcome.accept')}</span>
        </label>
      </section>

      {error ? (
        <p role="alert" data-testid="welcome-error" className="m-0 rounded-sm bg-danger-soft p-2">
          {t(`errors.${error}.title`)}
        </p>
      ) : null}
    </StepFrame>
  );
}
