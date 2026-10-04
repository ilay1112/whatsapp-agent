// src/main/llm/factory.cli.test.ts - [V2] T2 5 row `llm/cli/*` (factory part) + B12 (owner V2-W1-06-claude-cli).
// CLI ids: consent cloud_claude_cli v1 first, smoke BEFORE the provider is handed out, cache key id|model|exePath|version,
// usable() = exe + floor + consent + passed smoke (lazy when never tried), invalidate() kills the in-flight job,
// NEVER a silent fallback (constructor spies on every other provider), SECRET_FOR has no CLI entry (type test).
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createProviderFactory, CLI_SMOKE_FRESH_MS, SECRET_FOR, type ProviderFactoryDeps } from './factory';
import { ConsentRequiredError, LlmError, type LlmProvider } from './types';
import { createLogger } from '../logger';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings';
import { CONSENT_VERSIONS, type ApiKeyProviderId, type ConsentKind } from '../../shared/types';
import type { ProviderErrorCode } from '../../shared/errors';
import type { ErrorCode } from '../../shared/errors';

type CliFake = LlmProvider & {
  exePath: string;
  observedVersion: string;
  disposed: number;
  health: { code: ErrorCode; retryAtMs: null } | null;
  cliHealth(): { code: ErrorCode; retryAtMs: null } | null;
};
function cliProvider(
  over: {
    exePath?: string;
    version?: string;
    validate?: () => Promise<{ ok: true; model: string } | { ok: false; reason: ProviderErrorCode }>;
  } = {},
): CliFake {
  const p: CliFake = {
    id: 'claude_cli',
    model: 'sonnet',
    loop: 'agentic',
    capabilities: { images: true },
    exePath: over.exePath ?? 'C:\\h\\.local\\bin\\claude.exe',
    observedVersion: over.version ?? '2.1.258',
    disposed: 0,
    health: null,
    structured: vi.fn(),
    chat: vi.fn(),
    runAgentic: vi.fn(),
    validate: vi.fn(over.validate ?? (async () => ({ ok: true as const, model: 'sonnet' }))),
    async dispose() {
      p.disposed += 1;
    },
    cliHealth() {
      return p.health;
    },
  };
  return p;
}

function harness(over: Partial<ProviderFactoryDeps> = {}, provider: Settings['llm']['provider'] = 'claude_cli') {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.llm.provider = provider;
  const accepted: Partial<Record<ConsentKind, number>> = { cloud_claude_cli: CONSENT_VERSIONS.cloud_claude_cli };
  let t = 1_000_000;
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
    now: () => t,
    ...over,
  };
  const factory = createProviderFactory(deps);
  return {
    factory,
    deps,
    settings,
    accepted,
    others,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('SECRET_FOR (type + value)', () => {
  it('has exactly the two API-key providers - no CLI entry', () => {
    expect(Object.keys(SECRET_FOR).sort()).toEqual(['claude', 'gemini']);
    expectTypeOf(SECRET_FOR).toEqualTypeOf<
      Readonly<Record<ApiKeyProviderId, 'anthropic_api_key' | 'gemini_api_key'>>
    >();
  });
});

describe('claude_cli through the factory', () => {
  it('consent cloud_claude_cli v1 is checked FIRST: nothing is located or spawned without it', async () => {
    const make = vi.fn(async () => cliProvider());
    const h = harness({ makeClaudeCli: make });
    delete h.accepted.cloud_claude_cli;
    await expect(h.factory.get()).rejects.toBeInstanceOf(ConsentRequiredError);
    expect(make).not.toHaveBeenCalled();
    expect(h.factory.usable()).toEqual({ ok: false, code: 'CONSENT_REQUIRED' });
    h.accepted.cloud_claude_cli = CONSENT_VERSIONS.cloud_claude_cli + 1; // exact version only
    await expect(h.factory.get()).rejects.toBeInstanceOf(ConsentRequiredError);
  });

  it('the smoke (validate) runs BEFORE the provider is returned; the cached provider is reused while the key and smoke are fresh', async () => {
    const order: string[] = [];
    const p1 = cliProvider({
      validate: async () => {
        order.push('smoke');
        return { ok: true, model: 'sonnet' };
      },
    });
    const p2 = cliProvider();
    const make = vi.fn().mockResolvedValueOnce(p1).mockResolvedValueOnce(p2);
    const h = harness({ makeClaudeCli: make });
    const got = await h.factory.get();
    order.push('returned');
    expect(got).toBe(p1);
    expect(order).toEqual(['smoke', 'returned']);
    expect(make).toHaveBeenCalledWith({ model: DEFAULT_SETTINGS.llm.cli.claudeModel });
    expect(await h.factory.get()).toBe(p1); // same id|model|exePath|version => cached; the fresh probe object is disposed
    expect(p2.disposed).toBe(1);
    expect(p2.validate).not.toHaveBeenCalled();
    expect(h.factory.usable()).toEqual({ ok: true });
  });

  it('cache key id|model|exePath|version: a new version or exe path rebuilds (old disposed); a stale (> 24 h) smoke re-runs', async () => {
    const a = cliProvider({ version: '2.1.258' });
    const b = cliProvider({ version: '2.1.260' });
    const c = cliProvider({ version: '2.1.260', exePath: 'C:\\other\\claude.exe' });
    const d = cliProvider({ version: '2.1.260', exePath: 'C:\\other\\claude.exe' });
    const make = vi
      .fn()
      .mockResolvedValueOnce(a)
      .mockResolvedValueOnce(b)
      .mockResolvedValueOnce(c)
      .mockResolvedValueOnce(d);
    const h = harness({ makeClaudeCli: make });
    await h.factory.get();
    expect(await h.factory.get()).toBe(b);
    expect(a.disposed).toBe(1);
    expect(await h.factory.get()).toBe(c);
    h.advance(CLI_SMOKE_FRESH_MS);
    expect(await h.factory.get()).toBe(d);
    expect(d.validate).toHaveBeenCalledTimes(1);
  });

  it('a model change rebuilds', async () => {
    const make = vi.fn(async () => cliProvider());
    const h = harness({ makeClaudeCli: make });
    const first = await h.factory.get();
    h.settings.llm.cli.claudeModel = 'opus';
    const second = await h.factory.get();
    expect(second).not.toBe(first);
    expect(make).toHaveBeenLastCalledWith({ model: 'opus' });
  });

  it('build errors (not installed / version) and smoke failures are held with the mapped code; retryable smoke errors are not sticky', async () => {
    const h1 = harness({ makeClaudeCli: vi.fn(async () => Promise.reject(new LlmError('not_installed'))) });
    await expect(h1.factory.get()).rejects.toMatchObject({ code: 'not_installed' });
    expect(h1.factory.usable()).toEqual({ ok: false, code: 'CLI_NOT_INSTALLED' });
    const h2 = harness({ makeClaudeCli: vi.fn(async () => Promise.reject(new LlmError('version'))) });
    await expect(h2.factory.get()).rejects.toMatchObject({ code: 'version' });
    expect(h2.factory.usable()).toEqual({ ok: false, code: 'CLI_VERSION' });
    const h3 = harness({ makeClaudeCli: vi.fn(async () => Promise.reject(new Error('bug'))) });
    await expect(h3.factory.get()).rejects.toThrow('bug');
    expect(h3.factory.usable()).toEqual({ ok: true });

    for (const [reason, code, sticky] of [
      ['sandbox', 'CLI_TOOLSET_MISMATCH', true],
      ['not_logged_in', 'CLI_NOT_SIGNED_IN', true],
      ['overage', 'CLOUD_OVERAGE', true],
      ['usage_limit', 'CLOUD_QUOTA', true],
      ['network', 'CLOUD_UNAVAILABLE', false],
    ] as const) {
      const p = cliProvider({ validate: async () => ({ ok: false, reason }) });
      const h = harness({ makeClaudeCli: vi.fn(async () => p) });
      await expect(h.factory.get()).rejects.toMatchObject({ code: reason });
      expect(p.disposed).toBe(1);
      expect(h.factory.usable()).toEqual(sticky ? { ok: false, code } : { ok: true });
      await h.factory.invalidate(); // a user action ("Test again", provider switch) clears the hold
      expect(h.factory.usable()).toEqual({ ok: true });
    }
  });

  it('usable(): without makeClaudeCli => CLI_NOT_INSTALLED; model empty => MODEL_NOT_FOUND; the live provider health wins', async () => {
    expect(harness().factory.usable()).toEqual({ ok: false, code: 'CLI_NOT_INSTALLED' });
    await expect(harness().factory.get()).rejects.toMatchObject({ code: 'not_installed' });
    const h0 = harness({ makeClaudeCli: vi.fn() });
    h0.settings.llm.cli.claudeModel = '';
    expect(h0.factory.usable()).toEqual({ ok: false, code: 'MODEL_NOT_FOUND' });
    await expect(h0.factory.get()).rejects.toMatchObject({ code: 'not_ready' });
    const p = cliProvider();
    const h = harness({ makeClaudeCli: vi.fn(async () => p) });
    expect(h.factory.usable()).toEqual({ ok: true }); // never tried: get() will smoke first
    await h.factory.get();
    p.health = { code: 'CLI_UNSTABLE', retryAtMs: null };
    expect(h.factory.usable()).toEqual({ ok: false, code: 'CLI_UNSTABLE' });
    p.health = { code: 'CLOUD_OVERAGE', retryAtMs: null };
    expect(h.factory.usable()).toEqual({ ok: false, code: 'CLOUD_OVERAGE' });
  });

  it('invalidate() disposes (= kills the in-flight job of) the CLI provider and invalidates the status cache', async () => {
    const p = cliProvider();
    const cliStatus = { get: vi.fn(), invalidate: vi.fn() };
    const h = harness({ makeClaudeCli: vi.fn(async () => p), cliStatus });
    await h.factory.get();
    await h.factory.invalidate();
    expect(p.disposed).toBe(1);
    expect(cliStatus.invalidate).toHaveBeenCalledTimes(1);
  });

  it('NEVER a silent fallback: while claude_cli is not ready no other provider is constructed (constructor spies)', async () => {
    const seamProvider = vi.fn(() => cliProvider());
    const h = harness({
      makeClaudeCli: vi.fn(async () => cliProvider({ validate: async () => ({ ok: false, reason: 'not_logged_in' }) })),
      seamProvider,
    });
    h.accepted.cloud_claude = CONSENT_VERSIONS.cloud_claude;
    for (let i = 0; i < 3; i++) await expect(h.factory.get()).rejects.toBeInstanceOf(LlmError);
    expect(h.others.claude).not.toHaveBeenCalled();
    expect(h.others.gemini).not.toHaveBeenCalled();
    expect(h.others.local).not.toHaveBeenCalled();
    expect(seamProvider).not.toHaveBeenCalled(); // e2e reaches CLI ids through the spawned fakes, never the stub seam
  });

  it('antigravity_cli is built through makeAgy with its own consent; missing makeAgy => CLI_NOT_INSTALLED', async () => {
    const agy = {
      ...cliProvider(),
      id: 'antigravity_cli' as const,
      loop: 'prefetch' as const,
      capabilities: { images: false },
    };
    const h = harness({ makeAgy: vi.fn(async () => agy) }, 'antigravity_cli');
    await expect(h.factory.get()).rejects.toBeInstanceOf(ConsentRequiredError);
    h.accepted.cloud_antigravity_cli = CONSENT_VERSIONS.cloud_antigravity_cli;
    expect(await h.factory.get()).toBe(agy);
    expect(h.deps.makeAgy).toHaveBeenCalledWith({ model: DEFAULT_SETTINGS.llm.cli.agyModel });
    const noAgy = harness({}, 'antigravity_cli');
    noAgy.accepted.cloud_antigravity_cli = CONSENT_VERSIONS.cloud_antigravity_cli;
    expect(noAgy.factory.usable()).toEqual({ ok: false, code: 'CLI_NOT_INSTALLED' });
  });

  it('a provider without the info members still gets a stable key (agy seam object) and a provider without cliHealth is healthy', async () => {
    const bare: LlmProvider = {
      id: 'claude_cli',
      model: 'm',
      loop: 'agentic',
      capabilities: { images: true },
      structured: vi.fn(),
      chat: vi.fn(),
      validate: vi.fn(async () => ({ ok: true as const, model: 'm' })),
      dispose: vi.fn(async () => Promise.reject(new Error('dispose failed'))),
    };
    const make = vi.fn(async () => bare);
    const h = harness({ makeClaudeCli: make });
    expect(await h.factory.get()).toBe(bare);
    expect(h.factory.usable()).toEqual({ ok: true });
    await h.factory.invalidate(); // a throwing dispose never blocks
    expect(await h.factory.get()).toBe(bare);
  });

  it('switching from claude_cli to local disposes the CLI provider (kills its job) and builds local', async () => {
    const p = cliProvider();
    const local = { ...cliProvider(), id: 'local' as const, loop: 'turn' as const };
    const h = harness({ makeClaudeCli: vi.fn(async () => p), makeLocal: vi.fn(() => local) });
    await h.factory.get();
    h.settings.llm.provider = 'local';
    expect(await h.factory.get()).toBe(local);
    expect(p.disposed).toBe(1);
    expect(h.factory.usable()).toEqual({ ok: true });
  });

  it('a rejecting dispose() of a discarded probe or of a failed-smoke provider is swallowed', async () => {
    const a = cliProvider();
    const b = cliProvider();
    b.dispose = () => Promise.reject(new Error('x'));
    const h = harness({ makeClaudeCli: vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b) });
    await h.factory.get();
    expect(await h.factory.get()).toBe(a);
    const bad = cliProvider({ validate: async () => ({ ok: false, reason: 'sandbox' }) });
    bad.dispose = () => Promise.reject(new Error('y'));
    const h2 = harness({ makeClaudeCli: vi.fn(async () => bad) });
    await expect(h2.factory.get()).rejects.toMatchObject({ code: 'sandbox' });
  });

  it('the default clock is Date.now', async () => {
    const p = cliProvider();
    const h = harness({ makeClaudeCli: vi.fn(async () => p), now: undefined });
    await h.factory.get();
    expect(await h.factory.get()).toBe(p);
  });
});

// [v2-closeout] the quit sequence: a provider build must not start a CLI job (locate probes, the provider-start smoke) once the app is
// closing - such a job would outlive app.exit() with its pid file (e2e cli-connect 7b/7c).
describe('closed (the quit sequence began)', () => {
  it('get() is refused before any make / smoke once closed', async () => {
    let closed = true;
    const make = vi.fn(async () => cliProvider());
    const h = harness({ makeClaudeCli: make, closed: () => closed });
    await expect(h.factory.get()).rejects.toMatchObject({ code: 'not_ready' });
    expect(make).not.toHaveBeenCalled();
    closed = false;
    await expect(h.factory.get()).resolves.toMatchObject({ id: 'claude_cli' });
  });
  it('a build in flight when the quit begins never runs its smoke: the fresh provider is disposed instead', async () => {
    let closed = false;
    const p = cliProvider();
    let located!: () => void;
    const make = vi.fn(
      () =>
        new Promise<CliFake>((r) => {
          located = () => r(p); // the locator probes are running
        }),
    );
    const h = harness({ makeClaudeCli: make as never, closed: () => closed });
    const pending = h.factory.get();
    await vi.waitFor(() => expect(make).toHaveBeenCalled());
    closed = true; // killJobs ran meanwhile
    located();
    await expect(pending).rejects.toMatchObject({ code: 'not_ready' });
    expect(p.validate).not.toHaveBeenCalled();
    expect(p.disposed).toBe(1);
  });
});
