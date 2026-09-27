// src/renderer/src/views/Onboarding/GoogleWizard.tsx - step 3 (UX 8.3, ARCH 12.1, docs/research/calendar-mcp.md 6.3;
// owner W1-16). Intro + the five sub-steps that walk the user through creating their own free Google OAuth client.
//
// Rules this screen exists to honour:
//   - the renderer NEVER sees a URL: every "Open ..." button sends an ENUM target through `external:open`, and main
//     resolves it from resources/links.json (CONTRACTS EXTERNAL_TARGETS).
//   - the renderer NEVER sees a path: the drop zone reads the file's CONTENT and sends `google:importCredentials
//     {jsonText}`; "Browse" opens the native dialog IN MAIN.
//   - [R2] no screenshots and no illustrations: each sub-step is a numbered text list naming the exact button labels.
//   - the "Google hasn't verified this app" explainer and the Windows-firewall sentence are shown BEFORE the browser
//     opens, never after.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LIMITS, type CalendarInfo, type CredentialsProblem, type GoogleWizardState } from '@shared/types';
import type { ExternalTarget } from '@shared/ipc';
import type { ErrorCode } from '@shared/errors';
import { api, on } from '../../api';
import { CheckIcon, PrivacyNote, StepFrame } from './frame';

export interface GoogleWizardProps {
  onDone(): void;
  onSkip(): void;
  onBack(): void;
  startAt?: 0 | 1 | 2 | 3 | 4 | 5;
}

export type SubStep = 0 | 1 | 2 | 3 | 4 | 5;
export const SUB_STEP_COUNT = 5;

/**
 * The OAuth client name we ask the user to type into Google's form. It is an identifier the two sides must spell the
 * same way, not UI copy, so it is a constant and not a locale key - it must not be translated.
 */
export const OAUTH_CLIENT_NAME = 'WhatsApp Calendar Agent';

/** The deep links of each sub-step, in the order UX 8.3 lists them. Values are ENUM targets, never URLs. */
export const SUB_STEP_LINKS: Record<1 | 2 | 3, readonly ExternalTarget[]> = {
  1: ['gcp_new_project', 'gcp_enable_calendar_api'],
  2: ['gcp_oauth_consent', 'gcp_publish_app'],
  3: ['gcp_create_credentials'],
};
const SUB_STEP_INSTRUCTIONS: Record<1 | 2 | 3, readonly string[]> = {
  1: ['i1', 'i2'],
  2: ['i1', 'i2', 'i3'],
  3: ['i1', 'i2', 'i3', 'i4'],
};

/** "Failure rows map" of UX 8.3: which sub-step fixes which error. `null` = nothing to jump to. */
export function repairStepOf(code: ErrorCode | null, problem: CredentialsProblem | null): SubStep | null {
  if (problem === 'not_installed_type') return 3;
  if (problem) return 4;
  switch (code) {
    case 'GOOGLE_CREDENTIALS_INVALID':
      return 4;
    case 'CAL_RECONNECT':
    case 'GOOGLE_SIGNIN_TIMEOUT':
      return 5;
    case 'CAL_UNAVAILABLE':
      return 1;
    default:
      return null;
  }
}

export function GoogleWizard({ onDone, onSkip, onBack, startAt = 0 }: GoogleWizardProps) {
  const { t, i18n } = useTranslation();
  const [step, setStep] = useState<SubStep>(startAt);
  const [state, setState] = useState<GoogleWizardState | null>(null);
  const [localProblem, setLocalProblem] = useState<CredentialsProblem | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [calendars, setCalendars] = useState<CalendarInfo[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.getGoogleWizard().then((r) => {
      if (!cancelled && r.ok) setState(r.value);
    });
    const off = on('google:changed', (next) => setState(next));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const connected = state?.status === 'connected';

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void api.listCalendars().then((r) => {
      if (!cancelled && r.ok) setCalendars(r.value.calendars);
    });
    return () => {
      cancelled = true;
    };
  }, [connected]);

  const importJson = useCallback(async (jsonText: string) => {
    setLocalProblem(null);
    const r = await api.importCredentials(jsonText);
    if (r.ok) setState(r.value);
  }, []);

  const onDrop = useCallback(
    async (file: File | undefined) => {
      setDragOver(false);
      if (!file) return;
      if (file.size > LIMITS.credentialsJsonBytes) {
        setLocalProblem('too_large');
        return;
      }
      await importJson(await file.text());
    },
    [importJson],
  );

  const browse = useCallback(async () => {
    setLocalProblem(null);
    const r = await api.pickCredentialsFile();
    if (r.ok) setState(r.value);
  }, []);

  const signIn = useCallback(async () => {
    setSigningIn(true);
    const r = await api.startGoogleSignIn();
    if (r.ok) setState(r.value);
    setSigningIn(false);
  }, []);

  const copyName = useCallback(async () => {
    const r = await api.copyText(OAUTH_CLIENT_NAME);
    if (r.ok) setCopied(true);
  }, []);

  const chooseCalendar = useCallback((id: string) => {
    setState((s) => (s ? { ...s, targetCalendarId: id } : s));
    void api.setSettings({ calendar: { targetCalendarId: id } });
  }, []);

  const problem = localProblem ?? state?.credentialsProblem ?? null;
  const code = state?.code ?? null;
  const repairStep = repairStepOf(code, problem);

  const errorRow =
    code || problem ? (
      <div
        role="alert"
        data-testid="google-error"
        className="flex flex-wrap items-center gap-2 rounded-sm bg-danger-soft p-2"
      >
        {/* CONTRACTS 18.2 already gives every CredentialsProblem a label - the wizard reuses it instead of a second copy. */}
        <span className="grow">
          {problem ? t(`label.credentialsProblem.${problem}`) : t(`errors.${code as ErrorCode}.body`)}
        </span>
        {repairStep !== null && repairStep !== step ? (
          <button
            type="button"
            className="btn btn-outline"
            data-testid="google-goto-step"
            onClick={() => setStep(repairStep)}
          >
            {t('google.goToStep', { number: repairStep })}
          </button>
        ) : null}
      </div>
    ) : null;

  const hebrewNote =
    i18n.language === 'he' ? <p className="m-0 text-sm text-text-muted">{t('google.hebrewNote')}</p> : null;

  // ---- the six screens ------------------------------------------------------------------------------------------------

  if (step === 0) {
    return (
      <StepFrame
        index={3}
        testId="onboarding-google"
        title={t('google.title')}
        onBack={onBack}
        footerStart={
          <button type="button" className="btn btn-quiet" data-testid="google-later" onClick={onSkip}>
            {t('google.intro.later')}
          </button>
        }
        primary={
          <button type="button" className="btn btn-primary" data-testid="google-start" onClick={() => setStep(1)}>
            {t('google.intro.start')}
          </button>
        }
      >
        <p className="m-0">{t('google.intro.body1')}</p>
        <p className="m-0">{t('google.intro.body2')}</p>
        <PrivacyNote>{t('google.intro.privacy')}</PrivacyNote>
        {hebrewNote}
        {errorRow}
      </StepFrame>
    );
  }

  const frame = (children: ReactNode, primary: ReactNode) => (
    <StepFrame
      index={3}
      testId="onboarding-google"
      title={`${t('google.substep', { current: step, total: SUB_STEP_COUNT })} - ${t(`google.step${step}.title`)}`}
      onBack={() => setStep((step - 1) as SubStep)}
      primary={primary}
    >
      <p className="tnum m-0 text-sm text-text-muted" data-testid="google-substep">
        {t('google.substep', { current: step, total: SUB_STEP_COUNT })}
      </p>
      {children}
      {hebrewNote}
      {errorRow}
    </StepFrame>
  );

  const nextButton = (disabled = false) => (
    <button
      type="button"
      className="btn btn-primary"
      data-testid="google-next"
      disabled={disabled}
      onClick={() => setStep((step + 1) as SubStep)}
    >
      {t('google.next')}
    </button>
  );

  if (step === 1 || step === 2 || step === 3) {
    const n = step;
    return frame(
      <>
        <ol className="m-0 flex list-decimal flex-col gap-2 ps-5">
          {SUB_STEP_INSTRUCTIONS[n].map((key) => (
            <li key={key}>{t(`google.step${n}.${key}`)}</li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-2">
          {SUB_STEP_LINKS[n].map((target, i) => (
            <button
              key={target}
              type="button"
              className="btn btn-outline"
              data-testid={`google-open-${target}`}
              onClick={() => void api.openExternal({ target })}
            >
              {t(`google.step${n}.btn${i + 1}`)}
            </button>
          ))}
        </div>
        {n === 1 ? <p className="m-0 rounded-sm bg-accent-soft p-2 text-sm">{t('google.step1.tip')}</p> : null}
        {n === 2 ? (
          <details data-testid="google-testing-note">
            <summary>{t('google.step2.testingTitle')}</summary>
            <p className="m-0 text-text-muted">{t('google.step2.testingBody')}</p>
          </details>
        ) : null}
        {n === 3 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="chip" data-testid="google-name-chip">
              {OAUTH_CLIENT_NAME}
            </span>
            <button
              type="button"
              className="btn btn-quiet"
              data-testid="google-copy-name"
              onClick={() => void copyName()}
            >
              {copied ? t('action.copied') : t('google.step3.copyName')}
            </button>
          </div>
        ) : null}
      </>,
      nextButton(),
    );
  }

  if (step === 4) {
    return frame(
      <>
        <button
          type="button"
          className="drop-zone"
          data-testid="google-drop-zone"
          data-dragover={dragOver ? '1' : '0'}
          onClick={() => void browse()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            void onDrop(e.dataTransfer?.files?.[0]);
          }}
        >
          <span>{t('google.step4.drop')}</span>
          <span className="btn btn-outline">{t('google.step4.browse')}</span>
          <span className="text-sm text-text-muted">{t('google.step4.hint')}</span>
        </button>
        {state?.hasCredentials ? (
          <p className="m-0 flex items-center gap-2 text-ok" data-testid="google-credentials-ok">
            <CheckIcon />
            {t('google.step4.accepted')}
          </p>
        ) : null}
      </>,
      nextButton(!state?.hasCredentials),
    );
  }

  // step 5
  return frame(
    connected ? (
      <>
        <p className="m-0 flex items-center gap-2 text-ok" data-testid="google-connected">
          <CheckIcon />
          {t('google.connected')}
        </p>
        {state?.accountEmail ? (
          <p className="m-0 text-text-muted">
            <bdi>{state.accountEmail}</bdi>
          </p>
        ) : null}
        <label htmlFor="google-calendar-select">{t('google.calendarLabel')}</label>
        <select
          id="google-calendar-select"
          className="field"
          data-testid="google-calendar-select"
          value={state?.targetCalendarId ?? 'primary'}
          onChange={(e) => chooseCalendar(e.target.value)}
        >
          {calendars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </>
    ) : (
      <>
        {/* [R2] text only, and shown BEFORE the browser opens */}
        <p className="m-0" data-testid="google-unverified">
          {t('google.step5.unverified')}
        </p>
        <p className="m-0" data-testid="google-firewall">
          {t('google.step5.firewall')}
        </p>
        <button
          type="button"
          className="btn btn-quiet self-start"
          data-testid="google-unverified-help"
          onClick={() => void api.openExternal({ target: 'google_unverified_app_help' })}
        >
          {t('google.step5.helpUnverified')}
        </button>
        {state?.status === 'signing_in' || signingIn ? (
          <div className="flex flex-wrap items-center gap-2" data-testid="google-waiting">
            <span className="grow">{t('google.step5.waiting')}</span>
            <button
              type="button"
              className="btn btn-outline"
              data-testid="google-open-again"
              onClick={() => void signIn()}
            >
              {t('google.step5.openAgain')}
            </button>
          </div>
        ) : null}
      </>
    ),
    connected ? (
      <button type="button" className="btn btn-primary" data-testid="google-continue" onClick={onDone}>
        {t('onboarding.continue')}
      </button>
    ) : (
      <button
        type="button"
        className="btn btn-primary"
        data-testid="google-signin"
        disabled={signingIn}
        onClick={() => void signIn()}
      >
        {t('google.step5.signIn')}
      </button>
    ),
  );
}
