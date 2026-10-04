// src/main/ipc/handlers/llm.ts - handlers for the channels below (build-plan section 3; owner W1-13). Bodies return Result<T>, never throw.
// The handler never builds an SDK client and never sees a key except to hand it straight to the injected metadata helper.
import { providerErrorToErrorCode } from '../../../shared/errors';
import type { ErrorCode } from '../../../shared/errors';
import {
  AgyModelSchema,
  CLAUDE_CLI_MODEL_PRESETS,
  CLAUDE_MODEL_PRESETS,
  DEFAULT_SETTINGS,
  GEMINI_MODEL_PRESETS,
} from '../../../shared/settings';
import { CONSENT_KIND_FOR, CONSENT_KINDS, SECRET_NAMES } from '../../../shared/types';
import type {
  ApiKeyProviderId,
  CliProviderId,
  CliState,
  CloudProviderId,
  ConsentKind,
  KeyStatus,
  LlmConfig,
  ModelOption,
  SecretName,
} from '../../../shared/types';
import type { IpcHandlers } from '../../../shared/ipc';
import { LlmError } from '../../llm/types';
import { fail, ok, type HandlerDeps, type LlmHandlersV2 } from '../register';

export type LlmChannels =
  'llm:getHardware' | 'llm:getConfig' | 'llm:setProvider' | 'llm:validateKey' | 'llm:listModels';

/** A metadata call (list models / validate a key) is free and fast; it never blocks the UI for longer than this. */
export const LLM_METADATA_TIMEOUT_MS = 20_000;
/** `usageToday` is a rolling 24 h window over `runs` - no time-zone boundary, so a zone change cannot reset the budget. */
export const USAGE_WINDOW_MS = 24 * 3600_000;

// [V2 CHANGE] keyed by the API-key providers only (C2 9); the CLI ids hold no secret and use the llm.cli settings.
export const SECRET_FOR: Record<ApiKeyProviderId, SecretName> = {
  claude: 'anthropic_api_key',
  gemini: 'gemini_api_key',
};
export const CONSENT_FOR: Record<CloudProviderId, ConsentKind> = CONSENT_KIND_FOR; // [V2] the shared C2 1.1 table (4 ids)
export const PRESETS_FOR: Record<ApiKeyProviderId, readonly string[]> = {
  claude: CLAUDE_MODEL_PRESETS,
  gemini: GEMINI_MODEL_PRESETS,
};
/** [V2] B12: a CLI provider is selectable only with a passed smoke test (cli:test) no older than this. */
export const CLI_TEST_FRESH_MS = 24 * 3600_000;
/** [V2] The ErrorCode a non-ready CLI state maps to (the Connect card's one action). 'unknown' = auth status unparsable. */
export const CLI_STATE_CODE: Record<Exclude<CliState, 'ready'>, ErrorCode> = {
  not_installed: 'CLI_NOT_INSTALLED',
  too_old: 'CLI_VERSION',
  not_signed_in: 'CLI_NOT_SIGNED_IN',
  unknown: 'CLI_NOT_SIGNED_IN',
};
/** [V2] The agy model listing is vendor-CLI text (B27): only ids the settings schema would accept reach the renderer, capped. */
export const AGY_MODELS_MAX = 50;
const isCliProvider = (p: string): p is CliProviderId => p === 'claude_cli' || p === 'antigravity_cli';

export function createLlmHandlers(deps: HandlerDeps, v2?: LlmHandlersV2): Pick<IpcHandlers, LlmChannels> {
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
      // [V2 ADD, W0 glue] settings.llm.cli minus the path itself (a path never crosses IPC, C2 1.5); quota is V2-W1-10/W1-06's.
      cli: {
        claudeModel: s.llm.cli.claudeModel,
        agyModel: s.llm.cli.agyModel,
        maxRunsPerHour: s.llm.cli.maxRunsPerHour,
        allowOverage: s.llm.cli.allowOverage,
        claudeExePathSet: s.llm.cli.claudeExePath !== '',
      },
      // [V2] B13: the usage window as reported by the active CLI (HealthHub carries it); API-key / local providers have none.
      quota: isCliProvider(s.llm.provider) ? deps.healthHub.get().llm.quota : null,
    };
  };

  /**
   * [V2] C2 8 llm:setProvider for a CLI id: CliStatus.state === 'ready' (else the state's own code) -> consent current
   * (CONSENT_REQUIRED) -> a passed cli:test within 24 h (CLI_UNSTABLE). Checked BEFORE the switch; the consent dialog is the only
   * way to satisfy the second, so a CLI provider can never be selected without it (B21).
   */
  const cliPrecondition = async (provider: CliProviderId): Promise<ErrorCode | null> => {
    if (v2 === undefined) {
      deps.log.error('ipc_v2_unwired', { channel: 'llm:setProvider' });
      return 'INTERNAL';
    }
    const status = await v2.cliStatus.get(provider);
    if (status.state !== 'ready') return CLI_STATE_CODE[status.state];
    if (!deps.repos.consents.isCurrent(CONSENT_FOR[provider])) return 'CONSENT_REQUIRED';
    const test = status.lastTest;
    if (test === null || !test.ok || deps.clock.now() - test.at > CLI_TEST_FRESH_MS) return 'CLI_UNSTABLE';
    return null;
  };

  /** [V2] llm:listModels for a CLI id: Claude = the alias presets (the CLI has no listing); agy = its model listing, schema-filtered. */
  const listCliModels = async (provider: CliProviderId): Promise<{ models: ModelOption[]; presets: string[] }> => {
    if (provider === 'claude_cli') {
      return {
        models: CLAUDE_CLI_MODEL_PRESETS.map((id) => ({ id, displayName: id })),
        presets: [...CLAUDE_CLI_MODEL_PRESETS],
      };
    }
    if (v2 === undefined) throw new LlmError('not_ready');
    const seen = new Set<string>();
    const models: ModelOption[] = [];
    for (const id of await v2.listAgyModels()) {
      if (typeof id !== 'string' || !AgyModelSchema.safeParse(id).success || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, displayName: id });
      if (models.length === AGY_MODELS_MAX) break;
    }
    return { models, presets: [DEFAULT_SETTINGS.llm.cli.agyModel] };
  };

  return {
    'llm:getHardware': async () => ok(await deps.llm.hardware()),

    'llm:getConfig': () => ok(config()),

    /** CONSENT_REQUIRED | KEY_MISSING | MODEL_MISSING - checked BEFORE the switch, so a half-configured provider is never selected. */
    'llm:setProvider': async (req) => {
      if (isCliProvider(req.provider)) {
        const refused = await cliPrecondition(req.provider);
        if (refused !== null) return fail(refused);
      } else if (req.provider === 'local') {
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
      if (isCliProvider(req.provider)) {
        try {
          return ok(await listCliModels(req.provider));
        } catch (e) {
          return fail(codeOf(req.provider, e));
        }
      }
      const provider: ApiKeyProviderId = req.provider;
      const key = await deps.secrets.get(SECRET_FOR[provider]);
      if (key === null) return fail('KEY_MISSING');
      try {
        const models = await withTimeout((signal) => deps.llm.listModels(provider, key, signal));
        // [R2] Presets are ORDERING HINTS only: the renderer intersects them with `models` and hides ids the API did not return.
        return ok({ models, presets: [...PRESETS_FOR[provider]] });
      } catch (e) {
        return fail(codeOf(provider, e));
      }
    },
  };
}
