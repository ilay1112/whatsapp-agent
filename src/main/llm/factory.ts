// src/main/llm/factory.ts - ProviderFactory (build-plan section 3; v1 owner W1-12, v2 owner V2-W1-06-claude-cli). Safety-critical (TESTS 13).
// Providers get NO MCP client, NO bridge client, NO Db. Never falls back to another provider (A20, B12).
import { createHash } from 'node:crypto';
import { LlmError, type LlmProvider, type ProviderFactory } from './types';
import { assertConsent, CONSENT_KIND_FOR } from './consent';
import type { Repos } from '../db/index';
import type { SecretStore } from '../secrets';
import type { Settings } from '../../shared/settings';
import type { Logger } from '../deps';
import { NO_RETRY_PROVIDER_ERRORS, providerErrorToErrorCode, type ErrorCode } from '../../shared/errors';
import {
  LIMITS,
  type ApiKeyProviderId,
  type CliProviderId,
  type EpochMs,
  type ProviderId,
  type SecretName,
} from '../../shared/types';

export interface ProviderFactoryDeps {
  settings: () => Settings;
  secrets: Pick<SecretStore, 'get' | 'has'>;
  repos: Pick<Repos, 'consents'>;
  makeClaude: (input: { apiKey: string; model: string }) => LlmProvider; // llm/claude.ts createClaudeProvider bound with log/client
  makeGemini: (input: { apiKey: string; model: string }) => LlmProvider; // llm/gemini.ts
  makeLocal: (input: { tier: Settings['llm']['local'] }) => LlmProvider; // llm/local.ts (lazy llama-server)
  /** E2E only (testSeams): returns the stub/attacker provider under the CURRENT provider id; consent rules still apply to cloud ids.
   *  [V2] Never consulted for the two CLI ids: e2e reaches them through WCA_CLI_CMD and the spawned fakes (T2 4.1). */
  seamProvider?: (id: Settings['llm']['provider']) => LlmProvider | null;
  log: Logger;
  // ---- [V2 ADD] v2-build-plan 3 seam (owner V2-W1-06-claude-cli). [W0 refinement] optional so the v1 wiring and tests compile.
  /** llm/cli/claudeCli.ts makeClaudeCliFactory(...) - locates the exe, checks the floor, builds the provider (throws not_installed | version). */
  makeClaudeCli?: (input: { model: string }) => Promise<LlmProvider>;
  /** llm/cli/antigravityCli.ts createAgyProvider(...) bound by compose (V2-W1-09 / V2-W2-01). */
  makeAgy?: (input: { model: string }) => Promise<LlmProvider>;
  cliStatus?: import('./cli/locator').CliStatusService;
  jobs?: import('../proc/jobRunner').JobRunner;
  /** [V2-W1-06, additive] clock for the 24 h smoke freshness (B12); default Date.now. */
  now?: () => EpochMs;
  /** [v2-repair REQUEST 7, additive] the shared CliRunner's own pause (breaker / overage / usage window, CliRunner.health()). usable()
   *  reports it for a CLI id even before a provider is cached (a provider-start smoke that hit the limit is never cached). */
  cliRunnerHealth?: () => { code: ErrorCode } | null;
  /** [v2-repair REQUEST 7, additive] called after the CLI readiness changed (a smoke passed or failed) - compose refreshes AppHealth.llm. */
  onReadiness?: () => void;
}

/** The secret each API-key provider reads. [V2 CHANGE] keyed by ApiKeyProviderId (C2 9: the CLI providers hold no secret). */
export const SECRET_FOR: Readonly<Record<ApiKeyProviderId, SecretName>> = {
  claude: 'anthropic_api_key',
  gemini: 'gemini_api_key',
};

/** B12: a CLI provider is usable only when its last provider-start smoke (or cli:test) passed within this window. */
export const CLI_SMOKE_FRESH_MS = 24 * 60 * 60 * 1000;

/** Cache identity: the provider is rebuilt when the id, the model or the key changes - and for nothing else. */
function cacheKey(id: ProviderId, model: string, apiKey: string | null): string {
  const keyPart = apiKey === null ? 'none' : createHash('sha256').update(apiKey, 'utf8').digest('hex').slice(0, 16);
  return `${id}|${model}|${keyPart}`;
}
/** [V2, B12] CLI cache identity = id|model|exePath|version (the exe path never leaves main; it is not logged). */
function cliCacheKey(id: CliProviderId, model: string, p: LlmProvider): string {
  const info = p as Partial<{ exePath: string; observedVersion: string }>;
  return `${id}|${model}|${typeof info.exePath === 'string' ? info.exePath : ''}|${typeof info.observedVersion === 'string' ? info.observedVersion : ''}`;
}
/** The CLI provider's own sync readiness (runner breaker / overage pause / usage window), when it exposes one. */
function cliHealthOf(p: LlmProvider): { code: ErrorCode } | null {
  const h = (p as Partial<{ cliHealth(): { code: ErrorCode } | null }>).cliHealth;
  return typeof h === 'function' ? h.call(p) : null;
}

function modelFor(settings: Settings, id: ProviderId): string {
  if (id === 'claude') return settings.llm.claudeModel;
  if (id === 'gemini') return settings.llm.geminiModel;
  if (id === 'claude_cli') return settings.llm.cli.claudeModel; // [V2]
  if (id === 'antigravity_cli') return settings.llm.cli.agyModel; // [V2]
  return settings.llm.local.tier;
}
/** [V2] The two vendor-CLI ids (B12-B14): no API key; built through makeClaudeCli / makeAgy. */
function isCliId(id: ProviderId): id is CliProviderId {
  return id === 'claude_cli' || id === 'antigravity_cli';
}

interface CliReadiness {
  /** When the last smoke passed (null = failed). */
  okAt: EpochMs | null;
  /** The ErrorCode of a failed build/smoke that must hold items until the user acts (not_installed, version, not signed in, sandbox ...). */
  stickyCode: ErrorCode | null;
  /** [v2-repair REQUEST 7] the sticky code is the runner's own pause (usage window / overage): it ends when that pause ends. */
  clearsWithRunner?: boolean;
}

export function createProviderFactory(deps: ProviderFactoryDeps): ProviderFactory {
  const log = deps.log.child('llm.factory');
  const now = deps.now ?? ((): EpochMs => Date.now());
  let cached: { key: string; provider: LlmProvider; smokeAt: EpochMs | null } | null = null;
  let inFlight: Promise<LlmProvider> | null = null;
  const readiness = new Map<CliProviderId, CliReadiness>();

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

  /** [V2] CLI ids: build (locate + floor) -> provider-start smoke BEFORE the provider is handed out (no user data before it, B13). */
  const buildCli = async (id: CliProviderId, model: string): Promise<LlmProvider> => {
    const make = id === 'claude_cli' ? deps.makeClaudeCli : deps.makeAgy;
    if (make === undefined) throw new LlmError('not_installed');
    let fresh: LlmProvider;
    try {
      fresh = await make({ model });
    } catch (e) {
      if (e instanceof LlmError) {
        readiness.set(id, { okAt: null, stickyCode: providerErrorToErrorCode(id, e.code) });
        deps.onReadiness?.();
      }
      throw e;
    }
    const key = cliCacheKey(id, model, fresh);
    if (cached && cached.key === key && cached.smokeAt !== null && now() - cached.smokeAt < CLI_SMOKE_FRESH_MS) {
      await fresh.dispose().catch(() => undefined);
      return cached.provider;
    }
    const v = await fresh.validate(AbortSignal.timeout(LIMITS.cliTestWallClockMs + 10_000));
    if (!v.ok) {
      const code = providerErrorToErrorCode(id, v.reason);
      const sticky = NO_RETRY_PROVIDER_ERRORS.includes(v.reason) ? code : null;
      const runnerCode = deps.cliRunnerHealth?.()?.code ?? null;
      readiness.set(id, { okAt: null, stickyCode: sticky, clearsWithRunner: sticky !== null && runnerCode === sticky });
      deps.onReadiness?.();
      await fresh.dispose().catch(() => undefined);
      log.info('provider.cli_smoke_failed', { provider: id, code });
      throw new LlmError(v.reason);
    }
    await disposeCached();
    const at = now();
    cached = { key, provider: fresh, smokeAt: at };
    readiness.set(id, { okAt: at, stickyCode: null });
    deps.onReadiness?.();
    log.info('provider.created', { provider: id, seam: false });
    return fresh;
  };

  const build = async (): Promise<LlmProvider> => {
    const settings = deps.settings();
    const id = settings.llm.provider;
    // Consent FIRST: no key is read, no exe located and no client constructed for a cloud provider without a current consent row.
    assertConsent(deps.repos, id);

    const model = modelFor(settings, id);
    if (model.length === 0) throw new LlmError('not_ready');
    if (isCliId(id)) return buildCli(id, model);

    const apiKey = id === 'local' ? null : await deps.secrets.get(SECRET_FOR[id]);
    if (id !== 'local' && (apiKey === null || apiKey.length === 0)) throw new LlmError('not_ready');

    const key = cacheKey(id, model, apiKey);
    if (cached && cached.key === key) return cached.provider;
    await disposeCached();

    const seam = deps.seamProvider?.(id) ?? null;
    const provider = seam ?? buildReal(settings, id, model, apiKey);
    cached = { key, provider, smokeAt: null };
    log.info('provider.created', { provider: id, seam: seam !== null });
    return provider;
  };

  const buildReal = (
    settings: Settings,
    id: Exclude<ProviderId, 'claude_cli' | 'antigravity_cli'>,
    model: string,
    apiKey: string | null,
  ): LlmProvider => {
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

    /** Cheap readiness check used by S0 (held/waiting_llm) - never starts llama-server, never constructs a provider, never spawns a CLI. */
    usable(): { ok: true } | { ok: false; code: ErrorCode } {
      const settings = deps.settings();
      const id = settings.llm.provider;
      if (id !== 'local' && !deps.repos.consents.isCurrent(CONSENT_KIND_FOR[id])) {
        return { ok: false, code: 'CONSENT_REQUIRED' };
      }
      if (modelFor(settings, id).length === 0) return { ok: false, code: 'MODEL_NOT_FOUND' };
      if (isCliId(id)) {
        // B12: exe found + version floor + consent + last smoke passed within 24 h. A provider that was never started yet is
        // started lazily by get(), which runs the smoke before any user data - so "never tried" is usable, "tried and failed" is not.
        if ((id === 'claude_cli' ? deps.makeClaudeCli : deps.makeAgy) === undefined)
          return { ok: false, code: 'CLI_NOT_INSTALLED' };
        if (cached !== null && cached.provider.id === id) {
          const h = cliHealthOf(cached.provider);
          if (h !== null) return { ok: false, code: h.code };
        }
        // [v2-repair REQUEST 7] the runner's pause holds for a provider that is not cached yet (its smoke hit the limit)
        const runnerHealth = deps.cliRunnerHealth?.() ?? null;
        if (runnerHealth !== null) return { ok: false, code: runnerHealth.code };
        const r = readiness.get(id);
        if (r !== undefined && r.stickyCode !== null) {
          // the usage window / overage pause that made the smoke fail has ended: the next get() re-proves the smoke
          if (r.clearsWithRunner === true) readiness.delete(id);
          else return { ok: false, code: r.stickyCode };
        }
        return { ok: true };
      }
      if (id !== 'local' && !deps.secrets.has(SECRET_FOR[id]).present) return { ok: false, code: 'KEY_MISSING' };
      return { ok: true };
    },

    async invalidate(): Promise<void> {
      // [V2] disposing a CLI provider aborts its in-flight job (tree kill by PID, run dir removed); readiness is re-proven next get().
      readiness.clear();
      deps.cliStatus?.invalidate();
      await disposeCached();
    },
  };
}

export { ConsentRequiredError } from './types';
