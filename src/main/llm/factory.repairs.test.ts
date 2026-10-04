// src/main/llm/factory.repairs.test.ts - v2-repair-v2-main-defects REQUEST 7 (factory part): the shared CliRunner's own pause (usage
// window / overage / breaker) is reported by usable() for a CLI id even when no provider is cached (the provider-start smoke that hit
// the limit is never cached); a sticky code that IS the runner's pause ends with that pause; onReadiness fires on every readiness change.
// Never a fallback: nothing here constructs another provider.
import { describe, expect, it, vi } from 'vitest';
import { createProviderFactory, type ProviderFactoryDeps } from './factory';
import { LlmError, type LlmProvider } from './types';
import { createLogger } from '../logger';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { CONSENT_VERSIONS, type ConsentKind } from '../../shared/types';
import type { ErrorCode, ProviderErrorCode } from '../../shared/errors';

function cliProvider(validate: () => Promise<{ ok: true; model: string } | { ok: false; reason: ProviderErrorCode }>) {
  return {
    id: 'claude_cli' as const,
    model: 'sonnet',
    loop: 'agentic' as const,
    capabilities: { images: true },
    exePath: 'C:\\h\\.local\\bin\\claude.exe',
    observedVersion: '2.1.258',
    structured: vi.fn(),
    chat: vi.fn(),
    runAgentic: vi.fn(),
    validate: vi.fn(validate),
    dispose: vi.fn(async () => undefined),
    cliHealth: () => null,
  } as unknown as LlmProvider;
}

function harness(over: Partial<ProviderFactoryDeps>) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.llm.provider = 'claude_cli';
  const accepted: Partial<Record<ConsentKind, number>> = { cloud_claude_cli: CONSENT_VERSIONS.cloud_claude_cli };
  const others = { claude: vi.fn(), gemini: vi.fn(), local: vi.fn() };
  const deps: ProviderFactoryDeps = {
    settings: () => settings,
    secrets: { get: vi.fn(async () => null), has: vi.fn(() => ({ present: false, last4: '' })) },
    repos: {
      consents: {
        accept: vi.fn(),
        latest: vi.fn(() => null),
        isCurrent: vi.fn((k: ConsentKind) => accepted[k] === CONSENT_VERSIONS[k]),
      } as never,
    },
    makeClaude: others.claude as never,
    makeGemini: others.gemini as never,
    makeLocal: others.local as never,
    log: createLogger({ logsDir: 'unused', sink: () => undefined }),
    now: () => 1_000_000,
    ...over,
  };
  return { factory: createProviderFactory(deps), others };
}

describe('CLI readiness reaches usable() and AppHealth (REQUEST 7)', () => {
  it('a smoke that hit the usage window: usable() = CLOUD_QUOTA while the runner pauses, usable again when the pause ends', async () => {
    let runner: { code: ErrorCode } | null = null;
    const onReadiness = vi.fn();
    const h = harness({
      makeClaudeCli: async () =>
        cliProvider(async () => {
          runner = { code: 'CLOUD_QUOTA' }; // the runner recorded usagePausedUntil from the smoke's rate_limit_event
          return { ok: false, reason: 'usage_limit' };
        }),
      cliRunnerHealth: () => runner,
      onReadiness,
    });
    await expect(h.factory.get()).rejects.toBeInstanceOf(LlmError);
    expect(onReadiness).toHaveBeenCalledTimes(1);
    expect(h.factory.usable()).toEqual({ ok: false, code: 'CLOUD_QUOTA' });
    runner = null; // resetsAt passed
    expect(h.factory.usable()).toEqual({ ok: true });
    expect(h.factory.usable()).toEqual({ ok: true }); // the sticky entry is gone, not re-derived
    expect(h.others.claude).not.toHaveBeenCalled();
    expect(h.others.local).not.toHaveBeenCalled();
  });

  it('a sticky code that is NOT the runner pause stays until the user acts (sandbox, not signed in)', async () => {
    const h = harness({
      makeClaudeCli: async () => cliProvider(async () => ({ ok: false, reason: 'sandbox' })),
      cliRunnerHealth: () => null,
    });
    await expect(h.factory.get()).rejects.toBeInstanceOf(LlmError);
    expect(h.factory.usable()).toEqual({ ok: false, code: 'CLI_TOOLSET_MISMATCH' });
    expect(h.factory.usable()).toEqual({ ok: false, code: 'CLI_TOOLSET_MISMATCH' });
  });

  it('the runner pause wins even with nothing cached and no readiness yet (overage)', () => {
    const h = harness({
      makeClaudeCli: async () => cliProvider(async () => ({ ok: true, model: 'sonnet' })),
      cliRunnerHealth: () => ({ code: 'CLOUD_OVERAGE' }),
    });
    expect(h.factory.usable()).toEqual({ ok: false, code: 'CLOUD_OVERAGE' });
  });

  it('onReadiness fires on a passed smoke and on a failed build (not_installed)', async () => {
    const onReadiness = vi.fn();
    const ok = harness({
      makeClaudeCli: async () => cliProvider(async () => ({ ok: true, model: 'sonnet' })),
      onReadiness,
    });
    await ok.factory.get();
    expect(onReadiness).toHaveBeenCalledTimes(1);
    const missing = harness({
      makeClaudeCli: async () => {
        throw new LlmError('not_installed');
      },
      onReadiness,
    });
    await expect(missing.factory.get()).rejects.toBeInstanceOf(LlmError);
    expect(onReadiness).toHaveBeenCalledTimes(2);
    expect(missing.factory.usable()).toEqual({ ok: false, code: 'CLI_NOT_INSTALLED' });
  });

  it('without the optional deps the factory behaves exactly as before (sticky usage window until invalidate)', async () => {
    const h = harness({ makeClaudeCli: async () => cliProvider(async () => ({ ok: false, reason: 'usage_limit' })) });
    await expect(h.factory.get()).rejects.toBeInstanceOf(LlmError);
    expect(h.factory.usable()).toEqual({ ok: false, code: 'CLOUD_QUOTA' });
    await h.factory.invalidate();
    expect(h.factory.usable()).toEqual({ ok: true });
  });
});
