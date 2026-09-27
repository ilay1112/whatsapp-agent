// src/main/ipc/handlers/llm.ts - handlers for the channels below (build-plan section 3; owner W1-13). Bodies return Result<T>, never throw.
// The handler never builds an SDK client and never sees a key except to hand it straight to the injected metadata helper.
import { providerErrorToErrorCode } from '../../../shared/errors';
import { CLAUDE_MODEL_PRESETS, GEMINI_MODEL_PRESETS } from '../../../shared/settings';
import { CONSENT_KINDS, SECRET_NAMES } from '../../../shared/types';
import type { CloudProviderId, ConsentKind, KeyStatus, LlmConfig, SecretName } from '../../../shared/types';
import type { IpcHandlers } from '../../../shared/ipc';
import { LlmError } from '../../llm/types';
import { fail, ok, type HandlerDeps } from '../register';

export type LlmChannels =
  'llm:getHardware' | 'llm:getConfig' | 'llm:setProvider' | 'llm:validateKey' | 'llm:listModels';

/** A metadata call (list models / validate a key) is free and fast; it never blocks the UI for longer than this. */
export const LLM_METADATA_TIMEOUT_MS = 20_000;
/** `usageToday` is a rolling 24 h window over `runs` - no time-zone boundary, so a zone change cannot reset the budget. */
export const USAGE_WINDOW_MS = 24 * 3600_000;

export const SECRET_FOR: Record<CloudProviderId, SecretName> = {
  claude: 'anthropic_api_key',
  gemini: 'gemini_api_key',
};
export const CONSENT_FOR: Record<CloudProviderId, ConsentKind> = { claude: 'cloud_claude', gemini: 'cloud_gemini' };
export const PRESETS_FOR: Record<CloudProviderId, readonly string[]> = {
  claude: CLAUDE_MODEL_PRESETS,
  gemini: GEMINI_MODEL_PRESETS,
};

export function createLlmHandlers(deps: HandlerDeps): Pick<IpcHandlers, LlmChannels> {
  /** Aborts through the injected clock so the virtual clock controls it in tests. */
  const withTimeout = async <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    const timer = deps.clock.setTimeout(() => controller.abort(), LLM_METADATA_TIMEOUT_MS);
    try {
      return await fn(controller.signal);
    } finally {
      deps.clock.clearTimeout(timer);
    }
  };

  /** LlmError carries a ProviderErrorCode and nothing else on purpose (its message IS the code), so nothing echoes back. */
  const codeOf = (provider: CloudProviderId, e: unknown): ReturnType<typeof providerErrorToErrorCode> =>
    e instanceof LlmError ? providerErrorToErrorCode(provider, e.code) : 'CLOUD_UNAVAILABLE';

  const config = (): LlmConfig => {
    const s = deps.settings.get();
    const keys = {} as Record<SecretName, KeyStatus>;
    for (const name of SECRET_NAMES) keys[name] = deps.secrets.has(name);
    const consents = {} as Record<ConsentKind, boolean>;
    for (const kind of CONSENT_KINDS) consents[kind] = deps.repos.consents.isCurrent(kind);
    const used = deps.repos.runs.cloudTokensSince(deps.clock.now() - USAGE_WINDOW_MS);
    return {
      provider: s.llm.provider,
      claudeModel: s.llm.claudeModel,
      geminiModel: s.llm.geminiModel,
      local: { tier: s.llm.local.tier, acceleration: s.llm.local.acceleration, forceCpu: s.llm.local.forceCpu },
      keys,
      consents,
      usageToday: {
        inputTokens: used.inputTokens,
        outputTokens: used.outputTokens,
        budget: s.llm.cloudDailyTokenBudget,
      },
    };
  };

  return {
    'llm:getHardware': async () => ok(await deps.llm.hardware()),

    'llm:getConfig': () => ok(config()),

    /** CONSENT_REQUIRED | KEY_MISSING | MODEL_MISSING - checked BEFORE the switch, so a half-configured provider is never selected. */
    'llm:setProvider': async (req) => {
      if (req.provider === 'local') {
        const plan = await deps.modelManager.plan();
        const selected = plan.tiers.find((t) => t.tier === plan.selectedTier);
        if (selected === undefined || selected.status !== 'ready') return fail('MODEL_MISSING');
      } else {
        if (!deps.repos.consents.isCurrent(CONSENT_FOR[req.provider])) return fail('CONSENT_REQUIRED');
        if (!deps.secrets.has(SECRET_FOR[req.provider]).present) return fail('KEY_MISSING');
        const s = deps.settings.get();
        const model = req.provider === 'claude' ? s.llm.claudeModel : s.llm.geminiModel;
        if (model.length === 0) return fail('MODEL_MISSING');
      }

      deps.settings.setInternal((s) => {
        s.llm.provider = req.provider;
      });
      await deps.providerFactory.invalidate();
      deps.audit('provider_changed', req.provider, {}, deps.clock.now());
      return ok(config());
    },

    'llm:validateKey': async (req) => {
      const key = await deps.secrets.get(SECRET_FOR[req.provider]);
      if (key === null) return fail('KEY_MISSING');
      try {
        return ok(await withTimeout((signal) => deps.llm.validateKey(req.provider, key, signal)));
      } catch (e) {
        return fail(codeOf(req.provider, e));
      }
    },

    'llm:listModels': async (req) => {
      const key = await deps.secrets.get(SECRET_FOR[req.provider]);
      if (key === null) return fail('KEY_MISSING');
      try {
        const models = await withTimeout((signal) => deps.llm.listModels(req.provider, key, signal));
        // [R2] Presets are ORDERING HINTS only: the renderer intersects them with `models` and hides ids the API did not return.
        return ok({ models, presets: [...PRESETS_FOR[req.provider]] });
      } catch (e) {
        return fail(codeOf(req.provider, e));
      }
    },
  };
}
