// src/renderer/src/views/Onboarding/ChooseAi.tsx - step 1 (UX 8.1, ARCH 12.1, A20; owner W1-16).
// Also rendered INSIDE Settings > AI with `embedded` (same cards, no wizard chrome) - UX 9 says the settings group is
// "three radio cards as in onboarding 8.1", so there is exactly one implementation of them.
//
// Approval-first / privacy rules that are structural here:
//   - a cloud provider is never selected without a CURRENT-version consent record: the radio opens the blocking
//     ConsentDialog and main's `llm:setProvider` refuses anyway (ARCH A20, llm/consent.ts). Declining leaves Local.
//   - the key is written straight to main (`secrets:set`) and NEVER read back: after saving, the only thing this view
//     can show is `KeyStatus.last4`. There is no code path that renders the key again.
//   - "never silently falls back": a failed `llm:setProvider` shows its ErrorCode inline and changes nothing.
//
// [V2] V2-W1-12 (UX2 4.1, 6 step 1, 7; B12-B14): cards in the B12 order - On this computer / Claude - your subscription /
// ("Show experimental") Gemini - your subscription / ("Advanced: use an API key") Claude + Gemini with an API key. The two
// disclosures are collapsed by default and open by themselves when the ACTIVE provider is inside them. The subscription
// cards carry the Connect card (compact in onboarding, full in Settings). Selecting a card NEVER switches the provider by
// itself for a subscription: "Use ..." (Settings) or "Continue" (onboarding) runs consent (exact version) -> `llm:setProvider`
// ("Checking Claude..." meanwhile); main refuses a CLI that is not ready + consented + smoke-tested (B12). A failure keeps
// the previous provider and says so ("Still using: ..."). Onboarding adds the voice-notes opt-in and the pictures sentence;
// automatic mode is never offered here.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CLI_PROVIDER_IDS,
  CONSENT_KIND_FOR,
  CONSENT_VERSIONS,
  MODEL_TIERS,
  type ApiKeyProviderId,
  type CliProviderId,
  type CloudProviderId,
  type ConsentKind,
  type HardwareInfo,
  type LlmConfig,
  type ModelOption,
  type ModelPlan,
  type ModelTier,
  type ProviderId,
  type SecretName,
  type TierSetting,
  type VoiceState,
} from '@shared/types';
import type { ErrorCode } from '@shared/errors';
import { formatModelSize } from '@shared/i18n/format';
import { api } from '../../api';
import { ConsentDialog, cloudConsentKindOf } from '../../components/ConsentDialog';
import { ConnectCard } from '../../components/ConnectCard';
import { useCliStore } from '../../store/cli';
import { isActivationBlocked } from '../../store/health';
import { useSettingsStore } from '../../store/settings';
import { Disclosure } from '../settings/parts';
import { PrivacyNote, StepFrame, gib, num } from './frame';

export interface ChooseAiProps {
  onDone(): void;
  onBack(): void;
  embedded?: boolean;
}

// [V2 W0] the v1 onboarding cloud choices are exactly the two API-key providers (C2 1.1); the CLI providers are V2-W1-12's ConnectCard.
const CLOUD: readonly ApiKeyProviderId[] = ['claude', 'gemini'];
/** [V2 W0] true for the two API-key providers this v1 wizard configures (the CLI ids never reach the key/model paths). */
function isApiKeyProvider(p: ProviderId): p is ApiKeyProviderId {
  return p === 'claude' || p === 'gemini';
}
/** [V2] the two subscription (vendor CLI) providers. */
export function isCliProvider(p: ProviderId): p is CliProviderId {
  return (CLI_PROVIDER_IDS as readonly string[]).includes(p);
}
/** [V2] UX2 6: the voice opt-in is checked by default only with >= 4 GiB free disk and >= 8 GiB of memory. */
export const VOICE_OPTIN_MIN_DISK_GIB = 4;
export const VOICE_OPTIN_MIN_RAM_GIB = 8;
export function voiceOptInBlocker(hardware: HardwareInfo | null): 'disk' | 'ram' | null {
  if (!hardware) return null;
  if (hardware.freeDiskGiB < VOICE_OPTIN_MIN_DISK_GIB) return 'disk';
  if (hardware.ramGiB < VOICE_OPTIN_MIN_RAM_GIB) return 'ram';
  return null;
}
/** The one voice tier the onboarding opt-in names ("1.5 GB, Hebrew-optimised"). */
const OPTIN_TIER = 'voice-hebrew' as const;
const TIER_SETTINGS: readonly TierSetting[] = ['auto', ...MODEL_TIERS];

/** The consent kind a cloud provider needs. Narrower than `ConsentKind`: `whatsapp_tos` is not reachable from here. */
export type CloudConsentKind = Extract<ConsentKind, 'cloud_claude' | 'cloud_gemini'>;

export function consentKindOf(provider: ApiKeyProviderId): CloudConsentKind {
  return provider === 'claude' ? 'cloud_claude' : 'cloud_gemini';
}
export function secretNameOf(provider: ApiKeyProviderId): SecretName {
  return provider === 'claude' ? 'anthropic_api_key' : 'gemini_api_key';
}
export function keyHelpTargetOf(provider: ApiKeyProviderId): 'anthropic_api_keys' | 'gemini_api_keys' {
  return provider === 'claude' ? 'anthropic_api_keys' : 'gemini_api_keys';
}
/** `secrets:set` accepts printable ASCII only (CONTRACTS section 8); checked here so a paste mistake is explained. */
export const KEY_RE = /^[!-~]{8,512}$/;

/** The specific result rows of UX 8.1 step 3. */
export function keyErrorKeyOf(code: ErrorCode): 'auth' | 'billing' | 'network' | 'model_not_found' | 'other' {
  switch (code) {
    case 'KEY_INVALID':
      return 'auth';
    case 'CLOUD_QUOTA':
      return 'billing';
    case 'CLOUD_UNAVAILABLE':
      return 'network';
    case 'MODEL_NOT_FOUND':
      return 'model_not_found';
    default:
      return 'other';
  }
}

export function ChooseAi({ onDone, onBack, embedded = false }: ChooseAiProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;

  const [config, setConfig] = useState<LlmConfig | null>(null);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [plan, setPlan] = useState<ModelPlan | null>(null);
  const [selected, setSelected] = useState<ProviderId>('local');
  const [tier, setTier] = useState<TierSetting>('auto');
  const [sizeOpen, setSizeOpen] = useState(false);
  const [downloadStarted, setDownloadStarted] = useState(false);
  const [consentFor, setConsentFor] = useState<CloudProviderId | null>(null);
  // [V2]
  const cliStatus = useCliStore((s) => s.status);
  const windowDays = useSettingsStore((s) => s.settings?.whatsapp.readTools.windowDays ?? 30);
  const [experimentalOpen, setExperimentalOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /** The CLI provider whose `llm:setProvider` smoke run is in flight ("Checking Claude..."). */
  const [switching, setSwitching] = useState<CliProviderId | null>(null);
  /** The CLI provider whose last switch failed (the ErrorCode row + "Still using: ..." sit under its card). */
  const [cliError, setCliError] = useState<{ provider: CliProviderId; code: ErrorCode } | null>(null);
  /** Onboarding: after the consent for a CLI provider, the wizard continues by itself only if Continue started it. */
  const [continueAfter, setContinueAfter] = useState(false);
  const [voiceOptIn, setVoiceOptIn] = useState<boolean | null>(null);
  const [voice, setVoice] = useState<VoiceState | null>(null);
  const [providerError, setProviderError] = useState<ErrorCode | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [editingKey, setEditingKey] = useState(false);
  const [checking, setChecking] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyOk, setKeyOk] = useState(false);
  const [models, setModels] = useState<{ models: ModelOption[]; presets: string[] } | null>(null);

  const loadPlan = useCallback(async () => {
    const [h, p] = await Promise.all([api.getHardware(), api.getModelPlan()]);
    if (h.ok) setHardware(h.value);
    if (p.ok) setPlan(p.value);
  }, []);

  const loadModels = useCallback(async (provider: ApiKeyProviderId) => {
    const r = await api.listModels(provider);
    setModels(r.ok ? r.value : null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api.getLlmConfig().then((r) => {
      if (cancelled || !r.ok) return;
      setConfig(r.value);
      setSelected(r.value.provider);
      setTier(r.value.local.tier);
      const current = r.value.provider;
      // [V2] UX2 4.1: a disclosure opens by itself when the active provider is inside it.
      if (current === 'antigravity_cli') setExperimentalOpen(true);
      if (isApiKeyProvider(current)) {
        setAdvancedOpen(true);
        setKeyOk(r.value.keys[secretNameOf(current)].present);
        void loadModels(current);
      }
    });
    // The plan/hardware probe is started from the promise chain (not called straight from the effect body) so that no
    // state update can ever happen synchronously while the effect runs.
    void Promise.resolve().then(() => loadPlan());
    // [V2] UX2 6: detection of the vendor CLIs runs silently on entry (main caches cli:getStatus 60 s).
    void Promise.resolve().then(() => useCliStore.getState().refresh());
    if (!embedded) {
      void api.getVoiceState().then((r) => {
        if (!cancelled && r.ok) setVoice(r.value);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [loadPlan, loadModels, embedded]);

  const effectiveTier: ModelTier = tier === 'auto' ? (plan?.recommendedTier ?? 'small') : tier;
  const tierInfo = useMemo(() => plan?.tiers.find((row) => row.tier === effectiveTier) ?? null, [plan, effectiveTier]);

  const commitProvider = useCallback(async (provider: ProviderId) => {
    const r = await api.setProvider(provider);
    if (r.ok) {
      setConfig(r.value);
      setProviderError(null);
      return true;
    }
    setProviderError(r.error.code);
    return false;
  }, []);

  const onSelect = useCallback(
    (provider: ProviderId) => {
      setSelected(provider);
      setProviderError(null);
      setKeyError(null);
      if (provider === 'local') {
        void commitProvider('local');
        return;
      }
      // [V2] a subscription card only EXPANDS on selection: switching is "Use ..." / "Continue" (B12).
      if (!isApiKeyProvider(provider)) return;
      setKeyOk(config?.keys[secretNameOf(provider)].present ?? false);
      void loadModels(provider);
      if (!config?.consents[consentKindOf(provider)]) {
        setConsentFor(provider);
        return;
      }
      void commitProvider(provider);
    },
    [commitProvider, config, loadModels],
  );

  // [V2] UX2 4.5.1 / onboarding: "Also understand voice notes" - queued only when the wizard moves on (never on a mere
  // checkbox change), behind the AI model in the same downloader queue. `voice.enabled=true` is refused by main until
  // the model is ready (C2 4) - then only the tier is stored (UX2 C11, see the notes file).
  const blocker = voiceOptInBlocker(hardware);
  const optIn = !embedded && (voiceOptIn ?? blocker === null);
  const finish = useCallback(async () => {
    if (optIn) {
      const enabled = await api.setSettings({ voice: { enabled: true, tier: OPTIN_TIER } });
      if (!enabled.ok) await api.setSettings({ voice: { tier: OPTIN_TIER } });
      await api.startDownload(OPTIN_TIER);
    }
    onDone();
  }, [optIn, onDone]);

  /** [V2] consent (exact version) -> llm:setProvider for a subscription card; "Checking Claude..." meanwhile. */
  const switchToCli = useCallback(
    async (provider: CliProviderId, thenContinue: boolean) => {
      setCliError(null);
      setProviderError(null);
      setSwitching(provider);
      const r = await api.setProvider(provider);
      setSwitching(null);
      if (!r.ok) {
        setCliError({ provider, code: r.error.code });
        return;
      }
      setConfig(r.value);
      setSelected(provider);
      if (thenContinue) void finish();
    },
    [finish],
  );

  const startCli = useCallback(
    (provider: CliProviderId, thenContinue: boolean) => {
      if (!config?.consents[CONSENT_KIND_FOR[provider]]) {
        setContinueAfter(thenContinue);
        setConsentFor(provider);
        return;
      }
      void switchToCli(provider, thenContinue);
    },
    [config, switchToCli],
  );

  const onConsentAccept = useCallback(async () => {
    const provider = consentFor;
    setConsentFor(null);
    if (!provider) return;
    const kind = CONSENT_KIND_FOR[provider];
    const r = await api.acceptConsent(kind, CONSENT_VERSIONS[kind]);
    if (!r.ok) {
      setProviderError(r.error.code);
      if (!isCliProvider(provider)) setSelected('local');
      return;
    }
    setConfig((c) => (c ? { ...c, consents: { ...c.consents, [kind]: true } } : c));
    if (isCliProvider(provider)) {
      await switchToCli(provider, continueAfter);
      return;
    }
    await commitProvider(provider);
  }, [consentFor, commitProvider, switchToCli, continueAfter]);

  const onConsentCancel = useCallback(() => {
    // UX 8.1 / acceptance: declining leaves Local selected and nothing was changed in main. [V2] A declined
    // subscription consent changes nothing either: the card stays expanded, the active provider stays active.
    const provider = consentFor;
    setConsentFor(null);
    if (!provider || !isCliProvider(provider)) setSelected('local');
  }, [consentFor]);

  const startDownload = useCallback(async () => {
    const r = await api.startDownload(effectiveTier);
    if (!r.ok) {
      setProviderError(r.error.code);
      return;
    }
    setDownloadStarted(true);
    if (tier !== 'auto') void api.setSettings({ llm: { local: { tier } } });
    if (!embedded) void finish(); // UX 8.1: the download continues in the background, the wizard moves on at once
  }, [effectiveTier, tier, embedded, finish]);

  const checkKey = useCallback(async () => {
    if (!isApiKeyProvider(selected)) return;
    const provider = selected;
    const value = keyInput.trim();
    if (!KEY_RE.test(value)) {
      setKeyError('format');
      return;
    }
    setChecking(true);
    setKeyError(null);
    const saved = await api.setSecret({ name: secretNameOf(provider), value });
    if (!saved.ok) {
      setChecking(false);
      setKeyError(keyErrorKeyOf(saved.error.code));
      return;
    }
    const validated = await api.validateKey(provider);
    setChecking(false);
    setConfig((c) => (c ? { ...c, keys: { ...c.keys, [secretNameOf(provider)]: saved.value } } : c));
    if (!validated.ok) {
      setKeyError(keyErrorKeyOf(validated.error.code));
      return;
    }
    setKeyInput('');
    setShowKey(false);
    setEditingKey(false);
    setKeyOk(true);
    void loadModels(provider);
    await commitProvider(provider);
  }, [selected, keyInput, loadModels, commitProvider]);

  const removeKey = useCallback(async () => {
    if (!isApiKeyProvider(selected)) return;
    const name = secretNameOf(selected);
    const r = await api.clearSecret(name);
    if (!r.ok) return;
    setConfig((c) => (c ? { ...c, keys: { ...c.keys, [name]: r.value } } : c));
    setKeyOk(false);
    setEditingKey(true);
  }, [selected]);

  const pasteKey = useCallback(async () => {
    try {
      const text = await navigator.clipboard?.readText();
      if (typeof text === 'string') setKeyInput(text.trim());
    } catch {
      // No clipboard permission: the user can still type or use Ctrl+V in the field.
    }
  }, []);

  const onModel = useCallback((provider: ApiKeyProviderId, id: string) => {
    setConfig((c) => (c ? { ...c, [provider === 'claude' ? 'claudeModel' : 'geminiModel']: id } : c));
    void api.setSettings(provider === 'claude' ? { llm: { claudeModel: id } } : { llm: { geminiModel: id } });
  }, []);

  const canContinue =
    selected === 'local'
      ? downloadStarted || tierInfo?.status === 'ready'
      : isCliProvider(selected)
        ? // [V2] UX2 6: Ready + (consent + a passed llm:setProvider, which Continue itself runs when still missing)
          cliStatus[selected]?.state === 'ready' && switching === null
        : isApiKeyProvider(selected) &&
          Boolean(config?.consents[consentKindOf(selected)] && config.keys[secretNameOf(selected)].present && keyOk);

  /** [V2] Continue on a subscription card: consent + llm:setProvider first when this provider is not active yet. */
  const onContinue = (e: React.MouseEvent) => {
    if (isCliProvider(selected) && config?.provider !== selected) {
      if (e.detail > 1 || isActivationBlocked()) return;
      startCli(selected, true);
      return;
    }
    void finish();
  };

  // ---- card bodies ---------------------------------------------------------------------------------------------------

  const localBody = (
    <div className="flex flex-col gap-2 border-t border-line pt-2" data-testid="ai-local-body">
      {hardware ? (
        <p className="m-0">
          {t('onboarding.ai.local.hardware', {
            ram: num(hardware.ramGiB, lang),
            graphics: hardware.gpus.some((g) => g.dedicated)
              ? t('onboarding.ai.local.graphicsCard')
              : t('onboarding.ai.local.graphicsNone'),
            disk: num(hardware.freeDiskGiB, lang),
          })}
        </p>
      ) : null}
      {tierInfo ? (
        <p className="m-0">{t('onboarding.ai.local.bestFit', { model: t(`onboarding.ai.tier.${effectiveTier}`) })}</p>
      ) : null}

      {tierInfo && !tierInfo.fitsDisk ? (
        <div
          role="alert"
          data-testid="ai-disk-warning"
          className="flex flex-wrap items-center gap-2 rounded-sm bg-danger-soft p-2"
        >
          <span className="grow">
            {t('onboarding.ai.local.noSpace', {
              needed: gib(tierInfo.sizeBytes, lang),
              available: num(hardware?.freeDiskGiB ?? 0, lang, 1),
            })}
          </span>
          <button
            type="button"
            className="btn btn-outline"
            data-testid="ai-check-again"
            onClick={() => void loadPlan()}
          >
            {t('onboarding.ai.local.checkAgain')}
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {tierInfo?.status === 'ready' ? (
          <p className="m-0 text-ok" data-testid="ai-local-ready">
            {t('onboarding.ai.local.ready')}
          </p>
        ) : downloadStarted ? (
          <p className="m-0" data-testid="ai-local-downloading">
            {t('onboarding.ai.local.downloading')}
          </p>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            data-testid="ai-download"
            disabled={tierInfo ? !tierInfo.fitsDisk : true}
            onClick={() => void startDownload()}
          >
            {t('onboarding.ai.local.download')}
          </button>
        )}
        <button
          type="button"
          className="btn btn-quiet"
          data-testid="ai-size-toggle"
          aria-expanded={sizeOpen}
          onClick={() => setSizeOpen((v) => !v)}
        >
          {t('onboarding.ai.local.chooseSize')}
        </button>
      </div>

      {sizeOpen ? (
        <div className="flex flex-col gap-1">
          <label htmlFor="ai-size-select">{t('onboarding.ai.local.sizeLabel')}</label>
          <select
            id="ai-size-select"
            className="field"
            data-testid="ai-size-select"
            value={tier}
            onChange={(e) => setTier(e.target.value as TierSetting)}
          >
            {TIER_SETTINGS.map((value) => {
              const row = value === 'auto' ? null : plan?.tiers.find((x) => x.tier === value);
              return (
                <option key={value} value={value}>
                  {value === 'auto'
                    ? t('settings.ai.tier.auto')
                    : t('onboarding.ai.tierWithSize', {
                        name: t(`onboarding.ai.tier.${value}`),
                        size: row ? gib(row.sizeBytes, lang) : '?',
                      })}
                </option>
              );
            })}
          </select>
          <p className="m-0 text-sm text-text-muted" data-testid="ai-size-note">
            {t(`onboarding.ai.tierNote.${effectiveTier}`)}
          </p>
        </div>
      ) : null}
    </div>
  );

  const cloudBody = (provider: ApiKeyProviderId) => {
    const name = secretNameOf(provider);
    const status = config?.keys[name];
    const hasConsent = Boolean(config?.consents[consentKindOf(provider)]);
    const vendor = t(`onboarding.ai.vendor.${provider}`);
    return (
      <div className="flex flex-col gap-2 border-t border-line pt-2" data-testid={`ai-${provider}-body`}>
        {!hasConsent ? (
          <button
            type="button"
            className="btn btn-outline self-start"
            data-testid="ai-open-consent"
            onClick={() => setConsentFor(provider)}
          >
            {t('onboarding.ai.reviewConsent')}
          </button>
        ) : status?.present && !editingKey ? (
          <div className="flex flex-wrap items-center gap-2">
            <span data-testid="ai-key-saved">{t('onboarding.ai.key.saved', { last4: status.last4 })}</span>
            <button
              type="button"
              className="btn btn-outline"
              data-testid="ai-key-replace"
              onClick={() => setEditingKey(true)}
            >
              {t('onboarding.ai.key.replace')}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              data-testid="ai-key-remove"
              onClick={() => void removeKey()}
            >
              {t('onboarding.ai.key.remove')}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <label htmlFor="ai-key-input">{t('onboarding.ai.key.label')}</label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id="ai-key-input"
                data-testid="ai-key-input"
                className="field grow"
                type={showKey ? 'text' : 'password'}
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                value={keyInput}
                aria-invalid={keyError ? 'true' : undefined}
                aria-describedby={keyError ? 'ai-key-error' : undefined}
                onChange={(e) => setKeyInput(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-quiet"
                data-testid="ai-key-show"
                aria-pressed={showKey}
                onClick={() => setShowKey((v) => !v)}
              >
                {showKey ? t('onboarding.ai.key.hide') : t('onboarding.ai.key.show')}
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                data-testid="ai-key-paste"
                onClick={() => void pasteKey()}
              >
                {t('onboarding.ai.key.paste')}
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn btn-outline"
                data-testid="ai-key-help"
                onClick={() => void api.openExternal({ target: keyHelpTargetOf(provider) })}
              >
                {t('onboarding.ai.key.help')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                data-testid="ai-key-check"
                disabled={checking}
                onClick={() => void checkKey()}
              >
                {checking ? t('onboarding.ai.key.checking') : t('onboarding.ai.key.check')}
              </button>
            </div>
          </div>
        )}

        {keyError ? (
          <p
            id="ai-key-error"
            role="alert"
            tabIndex={-1}
            data-testid="ai-key-error"
            className="m-0 rounded-sm bg-danger-soft p-2"
          >
            {t(`onboarding.ai.err.${keyError}`, { vendor })}
          </p>
        ) : null}

        {hasConsent && status?.present && keyOk ? (
          <div className="flex flex-col gap-1">
            <p className="m-0 flex items-center gap-2 text-ok" data-testid="ai-key-ok">
              {t('onboarding.ai.key.ok')}
            </p>
            <label htmlFor="ai-model-select">{t('onboarding.ai.model.label')}</label>
            <select
              id="ai-model-select"
              className="field"
              data-testid="ai-model-select"
              value={provider === 'claude' ? (config?.claudeModel ?? '') : (config?.geminiModel ?? '')}
              onChange={(e) => onModel(provider, e.target.value)}
            >
              {orderedModels(models, provider === 'claude' ? config?.claudeModel : config?.geminiModel).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
            {provider === 'gemini' ? (
              <>
                <label htmlFor="ai-model-id">{t('onboarding.ai.model.customLabel')}</label>
                <input
                  id="ai-model-id"
                  data-testid="ai-model-id"
                  className="field"
                  type="text"
                  dir="ltr"
                  spellCheck={false}
                  defaultValue={config?.geminiModel ?? ''}
                  onBlur={(e) => {
                    const id = e.target.value.trim();
                    if (id && id !== config?.geminiModel) onModel('gemini', id);
                  }}
                />
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const cardName = (provider: ProviderId): string =>
    provider === 'local' ? t('ai.local.name') : t(`ai.provider.${provider}`);

  /** [V2] A subscription card: name, description, privacy note and the Connect card (UX2 4.1, 6, 7). */
  const cliCard = (provider: CliProviderId) => {
    const isSelected = selected === provider;
    const status = cliStatus[provider];
    const vendor = t(`cli.vendor.${provider}`);
    const active = config?.provider === provider;
    return (
      <div
        key={provider}
        data-testid={`ai-card-${provider}`}
        data-selected={isSelected ? '1' : '0'}
        data-active={active ? '1' : '0'}
        className={`flex flex-col gap-2 rounded-md p-3 ${isSelected ? 'border-2 border-accent bg-accent-soft' : 'border border-line bg-surface'}`}
      >
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="ai-provider"
            value={provider}
            data-testid={`choose-ai-${provider}`}
            checked={isSelected}
            onChange={() => onSelect(provider)}
          />
          <span className="grow font-semibold">{cardName(provider)}</span>
          {provider === 'antigravity_cli' ? (
            <span className="chip chip-experimental">{t('ai.experimental')}</span>
          ) : null}
        </label>
        <p className="m-0 text-text-muted">{t(`ai.provider.${provider}Desc`)}</p>
        <PrivacyNote>{t('ai.cli.privacy', { vendor })}</PrivacyNote>
        {status ? (
          <ConnectCard
            provider={provider}
            size={embedded ? 'full' : 'compact'}
            status={status}
            selected={active}
            onUse={() => startCli(provider, false)}
          />
        ) : (
          <p className="m-0 text-sm" role="status" data-testid={`connect-${provider}-loading`}>
            {t('cli.checking', { cli: t(`cli.name.${provider}`) })}
          </p>
        )}
        {switching === provider ? (
          <p className="m-0 text-sm" role="status" data-testid={`ai-switching-${provider}`}>
            {t('ai.useChecking', { vendor: t(`cli.name.${provider}`) })}
          </p>
        ) : null}
        {cliError?.provider === provider ? (
          <div role="alert" className="rounded-sm bg-danger-soft p-2" data-testid={`ai-use-error-${provider}`}>
            <p className="m-0 font-semibold">
              {t(`errors.${cliError.code}.title`, { cli: t(`cli.name.${provider}`), vendor })}
            </p>
            <p className="m-0 text-sm" data-testid={`ai-still-using-${provider}`}>
              {t('ai.stillUsing', { provider: cardName(config?.provider ?? 'local') })}
            </p>
          </div>
        ) : null}
        {provider === 'antigravity_cli' ? (
          <p className="m-0 text-sm text-text-muted" data-testid="gemini-cli-note">
            {t('cli.geminiCliNote')}
          </p>
        ) : null}
      </div>
    );
  };

  const card = (provider: ProviderId) => {
    if (isCliProvider(provider)) return cliCard(provider);
    const isSelected = selected === provider;
    const cloud = provider !== 'local';
    return (
      <div
        key={provider}
        data-testid={`ai-card-${provider}`}
        data-selected={isSelected ? '1' : '0'}
        className={`flex flex-col gap-2 rounded-md p-3 ${isSelected ? 'border-2 border-accent bg-accent-soft' : 'border border-line bg-surface'}`}
      >
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="ai-provider"
            value={provider}
            data-testid={`choose-ai-${provider}`}
            checked={isSelected}
            onChange={() => onSelect(provider)}
          />
          <span className="grow font-semibold">{cardName(provider)}</span>
          {provider === 'local' ? <span className="chip">{t('onboarding.ai.recommended')}</span> : null}
        </label>
        <p className="m-0 text-text-muted">
          {provider === 'local'
            ? t('onboarding.ai.local.desc', { size: tierInfo ? gib(tierInfo.sizeBytes, lang) : '?' })
            : t(`onboarding.ai.${provider}.desc`)}
        </p>
        <PrivacyNote>
          {provider === 'local'
            ? t('ai.local.privacy')
            : t('ai.cloud.privacy', { vendor: t(`onboarding.ai.vendor.${provider}`) })}
          {provider === 'gemini' ? ` ${t('onboarding.ai.gemini.freeTier')}` : ''}
        </PrivacyNote>
        {isSelected ? (cloud && isApiKeyProvider(provider) ? cloudBody(provider) : localBody) : null}
        {provider === 'gemini' ? (
          <p className="m-0 text-sm text-text-muted" data-testid="gemini-cli-note-key">
            {t('cli.geminiCliNote')}
          </p>
        ) : null}
      </div>
    );
  };

  const voiceSize =
    voice?.model && voice.model.id === OPTIN_TIER && voice.model.sizeBytes > 0
      ? formatModelSize(voice.model.sizeBytes, lang === 'he' ? 'he' : 'en')
      : null;
  const mmprojSize = plan?.mmproj ? formatModelSize(plan.mmproj.sizeBytes, lang === 'he' ? 'he' : 'en') : null;

  /** [V2] UX2 6 step 1: the voice-notes opt-in and the pictures sentence (onboarding only). */
  const mediaBlock = embedded ? null : (
    <div className="flex flex-col gap-1">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          data-testid="onboarding-voice-optin"
          checked={optIn}
          onChange={(e) => setVoiceOptIn(e.target.checked)}
        />
        <span className="flex flex-col">
          <span>
            {voiceSize ? t('onboarding.ai.voiceOptIn', { size: voiceSize }) : t('onboarding.ai.voiceOptInNoSize')}
          </span>
          {blocker ? (
            <span className="text-sm text-text-muted" data-testid="onboarding-voice-blocker" data-reason={blocker}>
              {blocker === 'disk'
                ? t('onboarding.ai.voiceNoDisk', {
                    size: voiceSize ?? formatModelSize(VOICE_OPTIN_MIN_DISK_GIB * 2 ** 30, lang === 'he' ? 'he' : 'en'),
                  })
                : t('onboarding.ai.voiceNoRam')}
            </span>
          ) : null}
        </span>
      </label>
      <p className="m-0 text-sm text-text-muted" data-testid="onboarding-pictures-note">
        {mmprojSize ? t('onboarding.ai.picturesNote', { size: mmprojSize }) : t('onboarding.ai.picturesNoteNoSize')}
      </p>
    </div>
  );

  const body = (
    <>
      <div role="radiogroup" aria-label={t('onboarding.ai.groupLabel')} className="flex flex-col gap-3">
        {card('local')}
        {card('claude_cli')}
        <Disclosure
          open={experimentalOpen}
          onToggle={() => setExperimentalOpen((v) => !v)}
          label={t('ai.showExperimental')}
          testId="ai-show-experimental"
          controls="ai-experimental-cards"
        />
        {experimentalOpen ? (
          <div id="ai-experimental-cards" className="flex flex-col gap-3">
            {card('antigravity_cli')}
          </div>
        ) : null}
        <Disclosure
          open={advancedOpen}
          onToggle={() => setAdvancedOpen((v) => !v)}
          label={t('ai.advanced')}
          testId="ai-advanced"
          controls="ai-advanced-cards"
        />
        {advancedOpen ? (
          <div id="ai-advanced-cards" className="flex flex-col gap-3">
            <p className="m-0 text-sm text-text-muted">{t('ai.advancedDesc')}</p>
            {CLOUD.map(card)}
          </div>
        ) : null}
      </div>
      {mediaBlock}
      {providerError ? (
        <p role="alert" data-testid="ai-provider-error" className="m-0 rounded-sm bg-danger-soft p-2">
          {t(`errors.${providerError}.title`)}
        </p>
      ) : null}
      <ConsentDialog
        kind={consentFor ? cloudConsentKindOf(consentFor) : 'cloud_claude'}
        version={consentFor ? CONSENT_VERSIONS[CONSENT_KIND_FOR[consentFor]] : CONSENT_VERSIONS.cloud_claude}
        open={consentFor !== null}
        days={windowDays}
        onAccept={() => void onConsentAccept()}
        onCancel={onConsentCancel}
      />
    </>
  );

  if (embedded) {
    return (
      <div data-testid="onboarding-choose-ai" data-embedded="1" className="flex flex-col gap-3">
        {body}
      </div>
    );
  }

  return (
    <StepFrame
      index={1}
      testId="onboarding-choose-ai"
      title={t('onboarding.ai.title')}
      onBack={onBack}
      primary={
        <button
          type="button"
          className="btn btn-primary"
          data-testid="ai-continue"
          disabled={!canContinue}
          onClick={onContinue}
        >
          {switching ? t('ai.useChecking', { vendor: t(`cli.name.${switching}`) }) : t('onboarding.continue')}
        </button>
      }
    >
      {body}
    </StepFrame>
  );
}

/**
 * Presets first, then the rest of the LIVE list (settings.ts: the presets are ORDERING HINTS ONLY and an id that the
 * account cannot use is never offered). The currently selected id is kept so the select never shows an empty value.
 */
export function orderedModels(
  list: { models: ModelOption[]; presets: string[] } | null,
  current: string | undefined,
): ModelOption[] {
  const models = list?.models ?? [];
  const presets = list?.presets ?? [];
  const byId = new Map(models.map((m) => [m.id, m]));
  const out: ModelOption[] = [];
  for (const id of presets) {
    const hit = byId.get(id);
    if (hit) {
      out.push(hit);
      byId.delete(id);
    }
  }
  out.push(...byId.values());
  if (current && !out.some((m) => m.id === current)) out.unshift({ id: current, displayName: current });
  return out;
}
