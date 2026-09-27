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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CONSENT_VERSIONS,
  MODEL_TIERS,
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
} from '@shared/types';
import type { ErrorCode } from '@shared/errors';
import { api } from '../../api';
import { ConsentDialog } from '../../components/ConsentDialog';
import { PrivacyNote, StepFrame, gib, num } from './frame';

export interface ChooseAiProps {
  onDone(): void;
  onBack(): void;
  embedded?: boolean;
}

const CLOUD: readonly CloudProviderId[] = ['claude', 'gemini'];
const TIER_SETTINGS: readonly TierSetting[] = ['auto', ...MODEL_TIERS];

/** The consent kind a cloud provider needs. Narrower than `ConsentKind`: `whatsapp_tos` is not reachable from here. */
export type CloudConsentKind = Extract<ConsentKind, 'cloud_claude' | 'cloud_gemini'>;

export function consentKindOf(provider: CloudProviderId): CloudConsentKind {
  return provider === 'claude' ? 'cloud_claude' : 'cloud_gemini';
}
export function secretNameOf(provider: CloudProviderId): SecretName {
  return provider === 'claude' ? 'anthropic_api_key' : 'gemini_api_key';
}
export function keyHelpTargetOf(provider: CloudProviderId): 'anthropic_api_keys' | 'gemini_api_keys' {
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

  const loadModels = useCallback(async (provider: CloudProviderId) => {
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
      if (r.value.provider !== 'local') {
        setKeyOk(r.value.keys[secretNameOf(r.value.provider)].present);
        void loadModels(r.value.provider);
      }
    });
    // The plan/hardware probe is started from the promise chain (not called straight from the effect body) so that no
    // state update can ever happen synchronously while the effect runs.
    void Promise.resolve().then(() => loadPlan());
    return () => {
      cancelled = true;
    };
  }, [loadPlan, loadModels]);

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

  const onConsentAccept = useCallback(async () => {
    const provider = consentFor;
    setConsentFor(null);
    if (!provider) return;
    const kind = consentKindOf(provider);
    const r = await api.acceptConsent(kind, CONSENT_VERSIONS[kind]);
    if (!r.ok) {
      setProviderError(r.error.code);
      setSelected('local');
      return;
    }
    setConfig((c) => (c ? { ...c, consents: { ...c.consents, [kind]: true } } : c));
    await commitProvider(provider);
  }, [consentFor, commitProvider]);

  const onConsentCancel = useCallback(() => {
    // UX 8.1 / acceptance: declining leaves Local selected and nothing was changed in main.
    setConsentFor(null);
    setSelected('local');
  }, []);

  const startDownload = useCallback(async () => {
    const r = await api.startDownload(effectiveTier);
    if (!r.ok) {
      setProviderError(r.error.code);
      return;
    }
    setDownloadStarted(true);
    if (tier !== 'auto') void api.setSettings({ llm: { local: { tier } } });
    if (!embedded) onDone(); // UX 8.1: the download continues in the background, the wizard moves on at once
  }, [effectiveTier, tier, embedded, onDone]);

  const checkKey = useCallback(async () => {
    if (selected === 'local') return;
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
    if (selected === 'local') return;
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

  const onModel = useCallback((provider: CloudProviderId, id: string) => {
    setConfig((c) => (c ? { ...c, [provider === 'claude' ? 'claudeModel' : 'geminiModel']: id } : c));
    void api.setSettings(provider === 'claude' ? { llm: { claudeModel: id } } : { llm: { geminiModel: id } });
  }, []);

  const canContinue =
    selected === 'local'
      ? downloadStarted || tierInfo?.status === 'ready'
      : Boolean(config?.consents[consentKindOf(selected)] && config.keys[secretNameOf(selected)].present && keyOk);

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

  const cloudBody = (provider: CloudProviderId) => {
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

  const card = (provider: ProviderId) => {
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
          <span className="grow font-semibold">
            {provider === 'local' ? t('ai.local.name') : t(`onboarding.ai.${provider}.name`)}
          </span>
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
        {isSelected ? (cloud ? cloudBody(provider) : localBody) : null}
      </div>
    );
  };

  const body = (
    <>
      <div role="radiogroup" aria-label={t('onboarding.ai.groupLabel')} className="flex flex-col gap-3">
        {(['local', ...CLOUD] as ProviderId[]).map(card)}
      </div>
      {providerError ? (
        <p role="alert" data-testid="ai-provider-error" className="m-0 rounded-sm bg-danger-soft p-2">
          {t(`errors.${providerError}.title`)}
        </p>
      ) : null}
      <ConsentDialog
        kind={consentFor ? consentKindOf(consentFor) : 'cloud_claude'}
        version={consentFor ? CONSENT_VERSIONS[consentKindOf(consentFor)] : 1}
        open={consentFor !== null}
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
          onClick={onDone}
        >
          {t('onboarding.continue')}
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
