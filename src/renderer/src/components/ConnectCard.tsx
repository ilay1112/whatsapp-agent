// src/renderer/src/components/ConnectCard.tsx - [V2] provider setup for the two vendor CLIs (UX2 7; B12-B14, B32; IPC cli:*).
// Owner: V2-W1-12-renderer-settings.
//
// What this card may and may not do (structural, B32 / B27):
//   - the app NEVER installs, updates or signs in itself: it shows the vendor's own command as copyable text (an app
//     constant from the locale files, never fetched), opens the vendor's page through an enum target, and asks MAIN to
//     open a visible console for the vendor's own sign-in (`cli:signIn`). It never reads the console;
//   - it never shows a token, a path, an account e-mail or any CLI output beyond the parsed `version` (CliStatus carries
//     nothing else);
//   - "Use {{provider}}" only REPORTS the wish (`onUse`): consent and `llm:setProvider` are the parent's, and main refuses
//     a CLI provider that is not ready + consented + smoke-tested (B12). Never a silent fallback (A20).
//   - "Use" and "Allow the app's folder..." are behind the renderer focus-steal guard (UX2 11.5); main gates them again.
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  ANTIGRAVITY_TERMS_READ_ON,
  CONSENT_KIND_FOR,
  type CliProviderId,
  type CliStatus,
  type ConsentState,
  type ModelOption,
} from '@shared/types';
import { ERROR_ACTION, type ErrorCode } from '@shared/errors';
import { CLAUDE_CLI_MODEL_PRESETS, ClaudeCliModelSchema } from '@shared/settings';
import { formatDate, formatElapsed, formatResetTime } from '@shared/i18n/format';
import { api } from '../api';
import { useCliStore } from '../store/cli';
import { isActivationBlocked, useHealthStore } from '../store/health';
import { useSettingsStore } from '../store/settings';

export interface ConnectCardProps {
  provider: CliProviderId;
  size: 'full' | 'compact';
  status: CliStatus;
  selected: boolean;
  onUse(): void;
}

/** UI-only states on top of CliStatus.state (UX2 7.1). */
export type ConnectUiState = CliStatus['state'] | 'checking' | 'waiting_sign_in';

/** Sign-in polling (UX2 7.1): every 10 s for 5 minutes; main answers from its 60 s cache (B13). */
export const SIGN_IN_POLL_MS = 10_000;
export const SIGN_IN_WAIT_MS = 5 * 60_000;
const COPIED_MS = 2_000;

/** ErrorCodes the card shows as its own row while THIS provider is the active one (UX2 7.1 last rule). */
const CARD_CODES: readonly ErrorCode[] = [
  'CLI_TOOLSET_MISMATCH',
  'CLI_UNSTABLE',
  'CLOUD_AUTH',
  'CLOUD_QUOTA',
  'CLOUD_OVERAGE',
  'CLI_UNSAFE_CONFIG',
];

/** The vendor command for a state (app constants, UX2 14.6). antigravity has no separate update command. */
export function commandKeyOf(provider: CliProviderId, state: CliStatus['state']): string | null {
  if (state === 'not_installed')
    return provider === 'claude_cli' ? 'cli.command.claudeInstall' : 'cli.command.agyInstall';
  if (state === 'too_old') return provider === 'claude_cli' ? 'cli.command.claudeUpdate' : 'cli.command.agyInstall';
  return null;
}

/** Ignore a double click's second activation and anything inside the focus-steal window (UX2 15.1). */
function guarded(e: MouseEvent): boolean {
  return e.detail > 1 || isActivationBlocked();
}

export function ConnectCard({ provider, size, status, selected, onUse }: ConnectCardProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'he' ? 'he' : 'en';
  const settings = useSettingsStore((s) => s.settings);
  const health = useHealthStore((s) => s.health);
  const checkedAt = useCliStore((s) => s.checkedAt[provider] ?? null);
  const setStatus = useCliStore((s) => s.setStatus);

  const [checking, setChecking] = useState(false);
  const [waiting, setWaiting] = useState(false);
  /** ux-i18n-v2-11: main's refusal of the last Sign in click (CLI_NOT_INSTALLED, CLI_VERSION, ...), shown inline. */
  const [signInError, setSignInError] = useState<ErrorCode | null>(null);
  const [copied, setCopied] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: true; ms: number } | { ok: false; code: ErrorCode } | null>(null);
  const [consent, setConsent] = useState<ConsentState | null>(null);
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<{ diffLine: string; agyRunning: boolean } | null>(null);
  const [workspaceResult, setWorkspaceResult] = useState<'done' | 'busy' | ErrorCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cli = t(`cli.name.${provider}`);
  const vendor = t(`cli.vendor.${provider}`);
  const timeZone = settings?.general.timeZone ?? 'Asia/Jerusalem';
  const ready = status.state === 'ready';
  const uiState: ConnectUiState = checking ? 'checking' : waiting && !ready ? 'waiting_sign_in' : status.state;

  // ---- sign-in wait: poll every 10 s, give up after 5 min (falls back to whatever state main reports) --------------
  useEffect(() => {
    if (!waiting || ready) return;
    const poll = setInterval(() => void useCliStore.getState().refresh(provider), SIGN_IN_POLL_MS);
    const stop = setTimeout(() => setWaiting(false), SIGN_IN_WAIT_MS);
    return () => {
      clearInterval(poll);
      clearTimeout(stop);
    };
  }, [waiting, ready, provider]);

  // "Checked 40 s ago" ticks while the card is on screen.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(tick);
  }, []);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  // Full size + ready: the consent date line and (agy) the model list; the workspace preview for agy.
  useEffect(() => {
    if (size !== 'full' || !ready) return;
    let cancelled = false;
    void api.getConsent(CONSENT_KIND_FOR[provider]).then((r) => {
      if (!cancelled && r.ok) setConsent(r.value);
    });
    if (provider === 'antigravity_cli') {
      void api.listModels('antigravity_cli').then((r) => {
        if (!cancelled) setModels(r.ok ? r.value.models : []);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [size, ready, provider]);

  const needsWorkspace = provider === 'antigravity_cli' && ready && status.workspaceTrusted !== true;
  useEffect(() => {
    if (!needsWorkspace) return;
    let cancelled = false;
    void api.previewAgyWorkspace().then((r) => {
      if (!cancelled && r.ok) setWorkspace({ diffLine: r.value.diffLine, agyRunning: r.value.agyRunning });
    });
    return () => {
      cancelled = true;
    };
  }, [needsWorkspace]);

  // ---- actions -------------------------------------------------------------------------------------------------------
  const checkAgain = useCallback(async () => {
    setChecking(true);
    setWaiting(false);
    await useCliStore.getState().refresh(provider);
    setChecking(false);
    setNow(Date.now());
  }, [provider]);

  const copyCommand = useCallback(async () => {
    const key = commandKeyOf(provider, status.state);
    if (!key) return;
    const r = await api.copyText(t(key));
    if (!r.ok) return;
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }, [provider, status.state, t]);

  const signIn = useCallback(async () => {
    setSignInError(null);
    const r = await api.cliSignIn(provider);
    if (r.ok) {
      setWaiting(true);
      return;
    }
    // The cached status was out of date (the CLI was removed or downgraded) or main refused: say so, and re-read it so
    // the state line and its action follow (ux-i18n-v2-11).
    setSignInError(r.error.code);
    await useCliStore.getState().refresh(provider);
    setNow(Date.now());
  }, [provider]);

  const runTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    const r = await api.testCli(provider);
    setTesting(false);
    setTestResult(r.ok ? { ok: true, ms: r.value.ms } : { ok: false, code: r.error.code });
    void useCliStore.getState().refresh(provider);
  }, [provider]);

  const saveClaudeModel = useCallback(
    (value: string) => {
      const next = value.trim();
      setModelDraft(null);
      if (!ClaudeCliModelSchema.safeParse(next).success || next === settings?.llm.cli.claudeModel) return;
      void useSettingsStore.getState().set({ llm: { cli: { claudeModel: next } } });
    },
    [settings?.llm.cli.claudeModel],
  );

  const allowWorkspace = useCallback(
    async (e: MouseEvent) => {
      if (guarded(e)) return;
      const r = await api.allowAgyWorkspace();
      if (r.ok) {
        setStatus(r.value);
        setWorkspaceResult('done');
        return;
      }
      setWorkspaceResult(workspace?.agyRunning || r.error.code === 'BAD_REQUEST' ? 'busy' : r.error.code);
    },
    [setStatus, workspace?.agyRunning],
  );

  const onErrorAction = useCallback(
    (code: ErrorCode) => {
      if (code === 'CLI_TOOLSET_MISMATCH') void api.exportDiagnostics();
      else if (code === 'CLI_UNSTABLE') void runTest();
      else if (code === 'CLOUD_AUTH') void signIn();
      else if (code === 'CLOUD_QUOTA' && provider === 'claude_cli') void api.openExternal({ target: 'claude_usage' });
      else document.querySelector<HTMLElement>('[data-testid="settings-cli-overage"]')?.focus();
    },
    [provider, runTest, signIn],
  );

  // ---- pieces --------------------------------------------------------------------------------------------------------
  const activeCode = health?.llm.provider === provider ? health.llm.code : undefined;
  const cardCode = activeCode && CARD_CODES.includes(activeCode) ? activeCode : null;
  const overage = status.quota?.usingOverage === true && settings?.llm.cli.allowOverage !== true;
  const busy = health?.llm.provider === provider && (health.queue.running ?? 0) > 0;
  const version = status.version ?? '?';
  const commandKey = commandKeyOf(provider, status.state);

  const errorRow = (code: ErrorCode) => (
    <div
      role="alert"
      data-testid={`connect-error-${provider}`}
      data-code={code}
      className="rounded-sm bg-danger-soft p-2"
    >
      <p className="m-0 font-semibold">{t(`errors.${code}.title`, { cli, vendor })}</p>
      <p className="m-0 text-sm">
        {code === 'CLOUD_QUOTA' && status.quota?.resetsAt != null
          ? t('errors.CLOUD_QUOTA.bodyReset', {
              vendor,
              time: formatResetTime(status.quota.resetsAt, now, lang, timeZone),
            })
          : t(`errors.${code}.body`, { cli, vendor })}
      </p>
      {ERROR_ACTION[code] !== 'none' ? (
        <button type="button" className="btn btn-outline mt-1" onClick={() => onErrorAction(code)}>
          {code === 'CLOUD_QUOTA' && provider === 'antigravity_cli'
            ? t('label.errorAction.open_ai_settings')
            : code === 'CLOUD_QUOTA'
              ? t('label.errorAction.open_usage_page')
              : t(`errors.${code}.action`, { cli, vendor })}
        </button>
      ) : null}
    </div>
  );

  const signInErrorRow =
    signInError !== null ? (
      <p
        role="alert"
        className="m-0 note-amber text-sm"
        data-testid={`connect-signin-error-${provider}`}
        data-code={signInError}
      >
        {t(`errors.${signInError}.title`, { cli, vendor })}
      </p>
    ) : null;

  const commandField = commandKey ? (
    <div className="flex flex-wrap items-center gap-2">
      <input
        readOnly
        dir="ltr"
        className="field command-field min-w-0 grow basis-60"
        aria-label={t('cli.commandLabel')}
        data-testid={`connect-command-${provider}`}
        value={t(commandKey)}
        onFocus={(e) => e.currentTarget.select()}
      />
      <button
        type="button"
        className="btn btn-primary"
        data-testid={`connect-copy-${provider}`}
        onClick={() => void copyCommand()}
      >
        {copied ? t('action.copied') : t('cli.copyCommand')}
      </button>
    </div>
  ) : null;

  const checkedLine =
    checkedAt !== null ? (
      <span className="text-xs text-text-muted" data-testid={`connect-checked-${provider}`}>
        {now - checkedAt < 5_000
          ? t('cli.checkedJustNow')
          : t('cli.checkedAgo', { value: formatElapsed(now - checkedAt, lang) })}
      </span>
    ) : null;

  const checkButton = (primary: boolean) => (
    <button
      type="button"
      className={`btn ${primary ? 'btn-primary' : 'btn-quiet'}`}
      data-testid={`connect-check-${provider}`}
      onClick={() => void checkAgain()}
    >
      {t('cli.checkAgain')}
    </button>
  );

  const signInButton = (
    <button
      type="button"
      className="btn btn-primary"
      data-testid={`connect-signin-${provider}`}
      onClick={() => void signIn()}
    >
      {t('cli.signIn')}
    </button>
  );

  // ---- the one state line (role=status: "Ready" is announced after sign-in detection, UX2 11.7) -----------------------
  const stateLine = (() => {
    switch (uiState) {
      case 'checking':
        return t('cli.checking', { cli });
      case 'not_installed':
        return t('cli.notInstalled', { cli });
      case 'too_old':
        return t('cli.tooOld', { cli, version, min: status.minVersion });
      case 'not_signed_in':
        return t('cli.notSignedIn', { cli, version });
      case 'waiting_sign_in':
        return t('cli.waitingSignIn');
      case 'unknown':
        return t('cli.unknown');
      case 'ready':
        return t('cli.ready', { cli, version });
    }
  })();
  const stateIcon =
    uiState === 'ready' ? null : uiState === 'not_installed' || uiState === 'too_old' ? 'icon-terminal' : 'icon-alert';

  // ---- compact (onboarding, UX2 7.3): one state line + ONE action --------------------------------------------------
  if (size === 'compact') {
    const action =
      uiState === 'not_installed' || uiState === 'too_old' ? (
        <button
          type="button"
          className="btn btn-outline"
          data-testid={`connect-copy-${provider}`}
          onClick={() => void copyCommand()}
        >
          {copied
            ? t('action.copied')
            : uiState === 'not_installed'
              ? t('label.errorAction.copy_install_command')
              : t('label.errorAction.copy_update_command')}
        </button>
      ) : uiState === 'not_signed_in' || uiState === 'unknown' ? (
        <button
          type="button"
          className="btn btn-outline"
          data-testid={`connect-signin-${provider}`}
          onClick={() => void signIn()}
        >
          {t('cli.signIn')}
        </button>
      ) : uiState === 'waiting_sign_in' ? (
        checkButton(false)
      ) : null;
    return (
      <section
        data-testid={`connect-${provider}`}
        data-state={uiState}
        data-size="compact"
        data-selected={selected}
        className="flex flex-wrap items-center gap-2"
      >
        {stateIcon ? <span className={`icon ${stateIcon} text-warn`} aria-hidden="true" /> : null}
        <span role="status" className="grow text-sm">
          {stateLine}
        </span>
        {action}
        {signInErrorRow}
        {cardCode ? errorRow(cardCode) : null}
      </section>
    );
  }

  // ---- full (Settings) -----------------------------------------------------------------------------------------------
  const resetsAt = status.quota?.resetsAt ?? null;
  const useDisabled = !ready || overage || needsWorkspace || cardCode !== null;

  return (
    <section
      data-testid={`connect-${provider}`}
      data-state={uiState}
      data-size="full"
      data-selected={selected}
      className="flex flex-col gap-2"
    >
      {provider === 'antigravity_cli' ? (
        <>
          <div data-testid="agy-disclosure" className="disclosure-warn flex items-start gap-2 text-sm">
            <span className="icon icon-alert mt-0.5 text-warn" aria-hidden="true" />
            <p className="m-0">
              <span className="font-semibold">{t('cli.agy.disclosureTitle')} </span>
              <Trans
                i18nKey="cli.agy.disclosure"
                values={{ termsDate: agyTermsDate(lang) }}
                components={{ bdi: <bdi /> }}
              />
            </p>
          </div>
          <ul
            className="m-0 flex list-none flex-col gap-0.5 p-0 text-sm text-text-muted"
            data-testid="agy-capabilities"
          >
            <li>{t('cli.agy.noTools', { days: settings?.whatsapp.readTools.windowDays ?? 30 })}</li>
            <li>{t('cli.agy.picturesLocal')}</li>
            <li>{t('cli.agy.noAuto')}</li>
          </ul>
        </>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {stateIcon ? <span className={`icon ${stateIcon} text-warn`} aria-hidden="true" /> : null}
        <span role="status" className="grow" data-testid={`connect-state-${provider}`}>
          {overage ? t('errors.CLOUD_OVERAGE.title') : stateLine}
          {uiState === 'ready' && resetsAt !== null && !overage ? (
            <span className="ms-2 text-sm text-text-muted" data-testid={`connect-resets-${provider}`}>
              <Trans
                i18nKey="cli.usageResets"
                values={{ time: formatResetTime(resetsAt, now, lang, timeZone) }}
                components={{ bdi: <bdi /> }}
              />
            </span>
          ) : null}
        </span>
        {uiState === 'not_signed_in' || uiState === 'unknown' ? signInButton : null}
        {uiState === 'waiting_sign_in' ? checkButton(true) : null}
      </div>

      {uiState === 'not_installed' ? <p className="m-0 text-sm">{t('cli.runThis')}</p> : null}
      {uiState === 'not_installed' || uiState === 'too_old' ? commandField : null}
      {uiState === 'too_old' && provider === 'claude_cli' ? (
        <p className="m-0 text-sm text-text-muted">
          <Trans i18nKey="cli.wingetHint" components={{ bdi: <bdi dir="ltr" /> }} />
        </p>
      ) : null}
      {uiState === 'not_signed_in' ? (
        <p className="m-0 text-sm text-text-muted">{t(`cli.signInNote.${provider}`)}</p>
      ) : null}

      {uiState === 'not_installed' || uiState === 'too_old' || uiState === 'unknown' ? (
        <div className="flex flex-wrap items-center gap-2">
          {uiState === 'not_installed' ? (
            <>
              <span className="grow text-sm text-text-muted">{t('cli.neverInstalls')}</span>
              <button
                type="button"
                className="btn btn-quiet"
                data-testid={`connect-open-install-${provider}`}
                onClick={() =>
                  void api.openExternal({
                    target: provider === 'claude_cli' ? 'claude_install' : 'antigravity_install',
                  })
                }
              >
                {t('cli.openInstallPage')}
              </button>
            </>
          ) : null}
          {checkButton(false)}
          {checkedLine}
        </div>
      ) : uiState === 'waiting_sign_in' ? (
        checkedLine
      ) : null}

      {signInErrorRow}
      {overage ? errorRow('CLOUD_OVERAGE') : cardCode ? errorRow(cardCode) : null}

      {uiState === 'ready' ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={`connect-model-${provider}`} className="font-semibold">
              {t('cli.model')}
            </label>
            {provider === 'claude_cli' ? (
              <>
                <input
                  id={`connect-model-${provider}`}
                  data-testid={`connect-model-${provider}`}
                  className="field w-52"
                  dir="ltr"
                  list="connect-claude-presets"
                  spellCheck={false}
                  value={modelDraft ?? settings?.llm.cli.claudeModel ?? ''}
                  aria-invalid={modelDraft !== null && !ClaudeCliModelSchema.safeParse(modelDraft.trim()).success}
                  onChange={(e) => setModelDraft(e.target.value)}
                  onBlur={(e) => saveClaudeModel(e.target.value)}
                />
                <datalist id="connect-claude-presets">
                  {CLAUDE_CLI_MODEL_PRESETS.map((id) => (
                    <option key={id} value={id}>
                      {id === 'sonnet' ? `${id} (${t('cli.recommended')})` : id}
                    </option>
                  ))}
                </datalist>
                <span className="text-sm text-text-muted">{t('cli.modelHintClaude')}</span>
              </>
            ) : (
              <>
                <select
                  id={`connect-model-${provider}`}
                  data-testid={`connect-model-${provider}`}
                  className="field w-60"
                  dir="ltr"
                  value={settings?.llm.cli.agyModel ?? ''}
                  onChange={(e) => void useSettingsStore.getState().set({ llm: { cli: { agyModel: e.target.value } } })}
                >
                  {agyOptions(models, settings?.llm.cli.agyModel).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
                <span className="text-sm text-text-muted">{t('cli.modelHintAgy')}</span>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-outline"
              data-testid={`connect-test-${provider}`}
              disabled={testing || busy}
              onClick={() => void runTest()}
            >
              {testing ? t('cli.testing') : t('cli.test')}
            </button>
            <span className="text-sm text-text-muted">{busy ? t('cli.testBusy') : t('cli.testNote')}</span>
            {testResult ? (
              <span
                data-testid={`connect-test-result-${provider}`}
                data-ok={testResult.ok ? '1' : '0'}
                className={testResult.ok ? 'text-ok' : 'text-danger'}
                role={testResult.ok ? undefined : 'alert'}
              >
                {testResult.ok
                  ? t('cli.testOk', { seconds: Math.max(1, Math.round(testResult.ms / 1000)) })
                  : t(`errors.${testResult.code}.title`, { cli, vendor })}
              </span>
            ) : null}
          </div>

          {consent?.acceptedAt != null && consent.acceptedVersion === consent.currentVersion ? (
            <p className="m-0 text-sm text-text-muted" data-testid={`connect-consent-${provider}`}>
              <Trans
                i18nKey="cli.consentDate"
                values={{ date: formatDate(consent.acceptedAt, lang, timeZone) }}
                components={{ bdi: <bdi /> }}
              />
            </p>
          ) : null}

          {needsWorkspace ? (
            <div className="flex flex-col gap-1 rounded-sm border border-line p-2" data-testid="agy-workspace">
              <p className="m-0 flex items-center gap-2">
                <span className="icon icon-terminal" aria-hidden="true" />
                {t('cli.agy.workspaceTitle')}
              </p>
              <p className="m-0 text-sm">{t('cli.agy.workspaceBody')}</p>
              {workspace ? (
                <p dir="ltr" className="command-field m-0 text-sm break-all" data-testid="agy-workspace-diff">
                  {workspace.diffLine}
                </p>
              ) : null}
              <p className="m-0 text-sm text-text-muted">{t('cli.agy.workspaceBackup')}</p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn btn-outline"
                  data-testid="agy-workspace-allow"
                  disabled={!workspace || workspace.agyRunning}
                  onClick={(e) => void allowWorkspace(e)}
                >
                  {t('cli.agy.workspaceAllow')}
                </button>
                {workspace?.agyRunning || workspaceResult === 'busy' ? (
                  <span className="note-amber text-sm" data-testid="agy-workspace-busy">
                    {t('cli.agy.workspaceBusy')}
                  </span>
                ) : workspaceResult && workspaceResult !== 'done' ? (
                  <span role="alert" className="text-sm text-danger" data-testid="agy-workspace-error">
                    {t(`errors.${workspaceResult}.title`, { cli, vendor })}
                  </span>
                ) : null}
              </div>
            </div>
          ) : workspaceResult === 'done' ? (
            <p className="m-0 text-sm text-ok" data-testid="agy-workspace-done">
              {t('cli.agy.workspaceDone')}
            </p>
          ) : null}
        </>
      ) : null}

      {!selected ? (
        <div className="flex flex-col items-start gap-1">
          <button
            type="button"
            className="btn btn-outline"
            data-testid={`ai-use-${provider}`}
            disabled={useDisabled}
            aria-describedby={useDisabled ? `ai-use-why-${provider}` : undefined}
            onClick={(e) => {
              if (guarded(e)) return;
              onUse();
            }}
          >
            {t('ai.use', { provider: t(`ai.provider.${provider}`) })}
          </button>
          {useDisabled ? (
            <span id={`ai-use-why-${provider}`} className="text-xs text-text-muted">
              {t('ai.finishSteps')}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** The Terms read date as a display date (UX2 7.4; the ISO constant lives in shared/types). */
function agyTermsDate(lang: 'en' | 'he'): string {
  return formatDate(Date.parse(`${ANTIGRAVITY_TERMS_READ_ON}T12:00:00Z`), lang, 'UTC');
}

/** "as reported by the CLI": the live list, plus the current id so the select never shows an empty value. */
export function agyOptions(models: ModelOption[] | null, current: string | undefined): ModelOption[] {
  const list = [...(models ?? [])];
  if (current && !list.some((m) => m.id === current)) list.unshift({ id: current, displayName: current });
  return list;
}
