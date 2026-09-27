// src/main/llm/factory.ts - ProviderFactory (build-plan section 3; owner W1-12). Safety-critical (TESTS 13).
// Providers get NO MCP client, NO bridge client, NO Db. Never falls back to another provider.
import { createHash } from 'node:crypto';
import { LlmError, type LlmProvider, type ProviderFactory } from './types';
import { assertConsent, CONSENT_KIND_FOR } from './consent';
import type { Repos } from '../db/index';
import type { SecretStore } from '../secrets';
import type { Settings } from '../../shared/settings';
import type { Logger } from '../deps';
import type { ErrorCode } from '../../shared/errors';
import type { ProviderId, SecretName } from '../../shared/types';

export interface ProviderFactoryDeps {
  settings: () => Settings;
  secrets: Pick<SecretStore, 'get' | 'has'>;
  repos: Pick<Repos, 'consents'>;
  makeClaude: (input: { apiKey: string; model: string }) => LlmProvider; // llm/claude.ts createClaudeProvider bound with log/client
  makeGemini: (input: { apiKey: string; model: string }) => LlmProvider; // llm/gemini.ts
  makeLocal: (input: { tier: Settings['llm']['local'] }) => LlmProvider; // llm/local.ts (lazy llama-server)
  /** E2E only (testSeams): returns the stub/attacker provider under the CURRENT provider id; consent rules still apply to cloud ids. */
  seamProvider?: (id: Settings['llm']['provider']) => LlmProvider | null;
  log: Logger;
}

/** The secret each cloud provider reads. */
export const SECRET_FOR: Readonly<Record<Exclude<ProviderId, 'local'>, SecretName>> = {
  claude: 'anthropic_api_key',
  gemini: 'gemini_api_key',
};

/** Cache identity: the provider is rebuilt when the id, the model or the key changes - and for nothing else. */
function cacheKey(id: ProviderId, model: string, apiKey: string | null): string {
  const keyPart = apiKey === null ? 'none' : createHash('sha256').update(apiKey, 'utf8').digest('hex').slice(0, 16);
  return `${id}|${model}|${keyPart}`;
}

function modelFor(settings: Settings, id: ProviderId): string {
  if (id === 'claude') return settings.llm.claudeModel;
  if (id === 'gemini') return settings.llm.geminiModel;
  return settings.llm.local.tier;
}

export function createProviderFactory(deps: ProviderFactoryDeps): ProviderFactory {
  const log = deps.log.child('llm.factory');
  let cached: { key: string; provider: LlmProvider } | null = null;
  let inFlight: Promise<LlmProvider> | null = null;

  const disposeCached = async (): Promise<void> => {
    const previous = cached;
    cached = null;
    if (!previous) return;
    try {
      await previous.provider.dispose();
    } catch {
      /* a provider that fails to dispose must not block the switch */
    }
  };

  const build = async (): Promise<LlmProvider> => {
    const settings = deps.settings();
    const id = settings.llm.provider;
    // Consent FIRST: no key is read and no client is constructed for a cloud provider without a current consent row.
    assertConsent(deps.repos, id);

    const model = modelFor(settings, id);
    if (model.length === 0) throw new LlmError('not_ready');

    const apiKey = id === 'local' ? null : await deps.secrets.get(SECRET_FOR[id]);
    if (id !== 'local' && (apiKey === null || apiKey.length === 0)) throw new LlmError('not_ready');

    const key = cacheKey(id, model, apiKey);
    if (cached && cached.key === key) return cached.provider;
    await disposeCached();

    const seam = deps.seamProvider?.(id) ?? null;
    const provider = seam ?? buildReal(settings, id, model, apiKey);
    cached = { key, provider };
    log.info('provider.created', { provider: id, seam: seam !== null });
    return provider;
  };

  const buildReal = (settings: Settings, id: ProviderId, model: string, apiKey: string | null): LlmProvider => {
    if (id === 'local') return deps.makeLocal({ tier: settings.llm.local });
    // apiKey is non-null here: build() throws LlmError('not_ready') before reaching this point.
    if (id === 'claude') return deps.makeClaude({ apiKey: apiKey as string, model });
    return deps.makeGemini({ apiKey: apiKey as string, model });
  };

  return {
    async get(): Promise<LlmProvider> {
      // A second caller during construction waits for the SAME provider; it never starts a second one.
      if (inFlight) return inFlight;
      inFlight = build().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    /** Cheap readiness check used by S0 (held/waiting_llm) - never starts llama-server, never constructs a provider. */
    usable(): { ok: true } | { ok: false; code: ErrorCode } {
      const settings = deps.settings();
      const id = settings.llm.provider;
      if (id !== 'local' && !deps.repos.consents.isCurrent(CONSENT_KIND_FOR[id])) {
        return { ok: false, code: 'CONSENT_REQUIRED' };
      }
      if (modelFor(settings, id).length === 0) return { ok: false, code: 'MODEL_NOT_FOUND' };
      if (id !== 'local' && !deps.secrets.has(SECRET_FOR[id]).present) return { ok: false, code: 'KEY_MISSING' };
      return { ok: true };
    },

    async invalidate(): Promise<void> {
      await disposeCached();
    },
  };
}

export { ConsentRequiredError } from './types';
