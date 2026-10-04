// TESTS 5.3 row `llm/factory.ts`: consent gate, not_ready without key/model, caching, NO fallback provider (constructor spy),
// providers receive no MCP / bridge / DB handle. Safety-critical: 100 % line coverage.
import { describe, expect, it, vi } from 'vitest';
import { createProviderFactory, SECRET_FOR, type ProviderFactoryDeps } from './factory';
import { ConsentRequiredError, LlmError, type LlmProvider } from './types';
import { createLogger } from '../logger';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings';
import { CONSENT_VERSIONS, type ConsentKind, type KeyStatus, type SecretName } from '../../shared/types';

const CLAUDE_KEY = 'sk-ant-TESTONLYabcdefghijklmnop';
const GEMINI_KEY = 'AIzaTESTONLY0123456789012345678901234';

function fakeProvider(id: LlmProvider['id'], model: string): LlmProvider & { disposed: number } {
  return {
    id,
    model,
    loop: 'turn', // [V2] C2 9
    capabilities: { images: false }, // [V2] C2 9
    disposed: 0,
    structured: vi.fn(async () => ({}) as never),
    chat: vi.fn(
      async () =>
        ({ text: '', toolCalls: [], stopReason: 'end', assistantMessage: { role: 'assistant', content: '' } }) as never,
    ),
    validate: vi.fn(async () => ({ ok: true, model }) as never),
    async dispose() {
      this.disposed++;
    },
  };
}

interface Harness {
  deps: ProviderFactoryDeps;
  settings: Settings;
  setSettings(mut: (s: Settings) => void): void;
  keys: Map<SecretName, string>;
  accepted: Partial<Record<ConsentKind, number>>;
  made: { claude: number; gemini: number; local: number };
  lastClaude: ReturnType<typeof fakeProvider> | null;
  lines: string[];
}

function harness(overrides: Partial<ProviderFactoryDeps> = {}): Harness {
  const state: Harness = {
    settings: structuredClone(DEFAULT_SETTINGS),
    setSettings: (mut) => mut(state.settings),
    keys: new Map<SecretName, string>(),
    accepted: {},
    made: { claude: 0, gemini: 0, local: 0 },
    lastClaude: null,
    lines: [],
    deps: {} as ProviderFactoryDeps,
  };
  state.deps = {
    settings: () => state.settings,
    secrets: {
      get: async (name: SecretName) => state.keys.get(name) ?? null,
      has: (name: SecretName): KeyStatus => {
        const v = state.keys.get(name);
        return v ? { present: true, last4: v.slice(-4) } : { present: false, last4: '' };
      },
    },
    repos: {
      consents: {
        accept: vi.fn(),
        latest: vi.fn(() => null),
        isCurrent: (kind: ConsentKind) => state.accepted[kind] === CONSENT_VERSIONS[kind],
      },
    },
    makeClaude: vi.fn(({ model }) => {
      state.made.claude++;
      state.lastClaude = fakeProvider('claude', model);
      return state.lastClaude;
    }),
    makeGemini: vi.fn(({ model }) => {
      state.made.gemini++;
      return fakeProvider('gemini', model);
    }),
    makeLocal: vi.fn(({ tier }) => {
      state.made.local++;
      return fakeProvider('local', tier.tier);
    }),
    log: createLogger({ logsDir: 'C:\\tmp', sink: (l) => state.lines.push(l) }),
    ...overrides,
  };
  return state;
}

describe('createProviderFactory - consent gate (A20)', () => {
  it.each(['claude', 'gemini'] as const)(
    '%s without consent throws ConsentRequiredError and constructs nothing',
    async (id) => {
      const h = harness();
      h.setSettings((s) => (s.llm.provider = id));
      h.keys.set(SECRET_FOR[id], id === 'claude' ? CLAUDE_KEY : GEMINI_KEY);
      await expect(createProviderFactory(h.deps).get()).rejects.toBeInstanceOf(ConsentRequiredError);
      expect(h.made).toEqual({ claude: 0, gemini: 0, local: 0 });
    },
  );

  it('the key is never read when consent is missing', async () => {
    const h = harness();
    const getSpy = vi.spyOn(h.deps.secrets, 'get');
    h.setSettings((s) => (s.llm.provider = 'claude'));
    await expect(createProviderFactory(h.deps).get()).rejects.toBeInstanceOf(ConsentRequiredError);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('a consent version bump re-blocks an already built provider', async () => {
    const h = harness();
    h.setSettings((s) => (s.llm.provider = 'claude'));
    h.accepted.cloud_claude = CONSENT_VERSIONS.cloud_claude;
    h.keys.set('anthropic_api_key', CLAUDE_KEY);
    const factory = createProviderFactory(h.deps);
    expect((await factory.get()).id).toBe('claude');
    h.accepted.cloud_claude = CONSENT_VERSIONS.cloud_claude - 1; // as if the text changed and the version was bumped
    await expect(factory.get()).rejects.toBeInstanceOf(ConsentRequiredError);
  });

  it('local needs no consent', async () => {
    const h = harness();
    const provider = await createProviderFactory(h.deps).get();
    expect(provider.id).toBe('local');
    expect(h.made.local).toBe(1);
  });
});

describe('createProviderFactory - readiness', () => {
  it.each(['claude', 'gemini'] as const)('%s with consent but no key throws LlmError(not_ready)', async (id) => {
    const h = harness();
    h.setSettings((s) => (s.llm.provider = id));
    h.accepted[id === 'claude' ? 'cloud_claude' : 'cloud_gemini'] =
      CONSENT_VERSIONS[id === 'claude' ? 'cloud_claude' : 'cloud_gemini']; // [V2] v2 consent text
    const err = await createProviderFactory(h.deps)
      .get()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).code).toBe('not_ready');
    expect(h.made).toEqual({ claude: 0, gemini: 0, local: 0 });
  });

  it('gemini fully configured builds the Gemini provider with its own key and model', async () => {
    const h = harness();
    h.setSettings((s) => (s.llm.provider = 'gemini'));
    h.accepted.cloud_gemini = CONSENT_VERSIONS.cloud_gemini;
    h.keys.set('gemini_api_key', GEMINI_KEY);
    const provider = await createProviderFactory(h.deps).get();
    expect(provider.id).toBe('gemini');
    expect(h.made).toEqual({ claude: 0, gemini: 1, local: 0 });
    expect(vi.mocked(h.deps.makeGemini).mock.calls[0]![0]).toEqual({ apiKey: GEMINI_KEY, model: 'gemini-3.8-flash' });
  });

  it('an empty key counts as missing', async () => {
    const h = harness();
    h.setSettings((s) => (s.llm.provider = 'claude'));
    h.accepted.cloud_claude = CONSENT_VERSIONS.cloud_claude; // [V2]
    h.keys.set('anthropic_api_key', '');
    await expect(createProviderFactory(h.deps).get()).rejects.toBeInstanceOf(LlmError);
  });

  it('an empty model id throws not_ready before any construction', async () => {
    const h = harness();
    h.setSettings((s) => {
      s.llm.provider = 'claude';
      s.llm.claudeModel = '';
    });
    h.accepted.cloud_claude = CONSENT_VERSIONS.cloud_claude; // [V2]
    h.keys.set('anthropic_api_key', CLAUDE_KEY);
    await expect(createProviderFactory(h.deps).get()).rejects.toBeInstanceOf(LlmError);
    expect(h.made.claude).toBe(0);
  });
});

describe('createProviderFactory - caching and no fallback', () => {
  const claudeReady = (): Harness => {
    const h = harness();
    h.setSettings((s) => (s.llm.provider = 'claude'));
    h.accepted.cloud_claude = CONSENT_VERSIONS.cloud_claude;
    h.keys.set('anthropic_api_key', CLAUDE_KEY);
    return h;
  };

  it('repeated get() returns the SAME instance', async () => {
    const h = claudeReady();
    const f = createProviderFactory(h.deps);
    const a = await f.get();
    const b = await f.get();
    expect(a).toBe(b);
    expect(h.made.claude).toBe(1);
  });

  it('concurrent get() calls construct exactly one provider', async () => {
    const h = claudeReady();
    const f = createProviderFactory(h.deps);
    const [a, b, c] = await Promise.all([f.get(), f.get(), f.get()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(h.made.claude).toBe(1);
  });

  it('a failing run never builds another provider (constructor spy)', async () => {
    const h = claudeReady();
    const f = createProviderFactory(h.deps);
    const provider = await f.get();
    vi.mocked(provider.chat).mockRejectedValue(new LlmError('auth'));
    await expect(
      provider.chat([], [], { signal: AbortSignal.abort(), maxOutputTokens: 2048, purpose: 'draft' }),
    ).rejects.toBeInstanceOf(LlmError);
    await f.get(); // the orchestrator asks again after the failure
    expect(h.made).toEqual({ claude: 1, gemini: 0, local: 0 });
  });

  it('changing the model rebuilds and disposes the previous provider', async () => {
    const h = claudeReady();
    const f = createProviderFactory(h.deps);
    const first = (await f.get()) as ReturnType<typeof fakeProvider>;
    h.setSettings((s) => (s.llm.claudeModel = 'claude-sonnet-5'));
    const second = await f.get();
    expect(second).not.toBe(first);
    expect(second.model).toBe('claude-sonnet-5');
    expect(first.disposed).toBe(1);
    expect(h.made.claude).toBe(2);
  });

  it('changing the key rebuilds', async () => {
    const h = claudeReady();
    const f = createProviderFactory(h.deps);
    await f.get();
    h.keys.set('anthropic_api_key', `${CLAUDE_KEY}2`);
    await f.get();
    expect(h.made.claude).toBe(2);
  });

  it('switching the provider disposes the old one and builds the new one - never both at once', async () => {
    const h = claudeReady();
    const f = createProviderFactory(h.deps);
    const claude = (await f.get()) as ReturnType<typeof fakeProvider>;
    h.setSettings((s) => (s.llm.provider = 'local'));
    const local = await f.get();
    expect(local.id).toBe('local');
    expect(claude.disposed).toBe(1);
    expect(h.made).toEqual({ claude: 1, gemini: 0, local: 1 });
  });

  it('invalidate() disposes and drops the cache', async () => {
    const h = claudeReady();
    const f = createProviderFactory(h.deps);
    const first = (await f.get()) as ReturnType<typeof fakeProvider>;
    await f.invalidate();
    expect(first.disposed).toBe(1);
    await f.get();
    expect(h.made.claude).toBe(2);
  });

  it('invalidate() on an empty cache is a no-op', async () => {
    const h = harness();
    await expect(createProviderFactory(h.deps).invalidate()).resolves.toBeUndefined();
  });

  it('a provider whose dispose() throws does not block the switch', async () => {
    const h = claudeReady();
    const f = createProviderFactory(h.deps);
    const first = await f.get();
    vi.spyOn(first, 'dispose').mockRejectedValue(new Error('stuck'));
    h.setSettings((s) => (s.llm.provider = 'local'));
    await expect(f.get()).resolves.toMatchObject({ id: 'local' });
  });
});

describe('createProviderFactory - usable()', () => {
  it('local is usable and starting nothing', () => {
    const h = harness();
    expect(createProviderFactory(h.deps).usable()).toEqual({ ok: true });
    expect(h.made.local).toBe(0);
  });

  it('cloud without consent => CONSENT_REQUIRED', () => {
    const h = harness();
    h.setSettings((s) => (s.llm.provider = 'gemini'));
    h.keys.set('gemini_api_key', GEMINI_KEY);
    expect(createProviderFactory(h.deps).usable()).toEqual({ ok: false, code: 'CONSENT_REQUIRED' });
  });

  it('cloud with consent but no key => KEY_MISSING', () => {
    const h = harness();
    h.setSettings((s) => (s.llm.provider = 'gemini'));
    h.accepted.cloud_gemini = CONSENT_VERSIONS.cloud_gemini;
    expect(createProviderFactory(h.deps).usable()).toEqual({ ok: false, code: 'KEY_MISSING' });
  });

  it('cloud with consent, key and an empty model id => MODEL_NOT_FOUND', () => {
    const h = harness();
    h.setSettings((s) => {
      s.llm.provider = 'gemini';
      s.llm.geminiModel = '';
    });
    h.accepted.cloud_gemini = CONSENT_VERSIONS.cloud_gemini;
    h.keys.set('gemini_api_key', GEMINI_KEY);
    expect(createProviderFactory(h.deps).usable()).toEqual({ ok: false, code: 'MODEL_NOT_FOUND' });
  });

  it('cloud fully configured => ok', () => {
    const h = harness();
    h.setSettings((s) => (s.llm.provider = 'claude'));
    h.accepted.cloud_claude = CONSENT_VERSIONS.cloud_claude;
    h.keys.set('anthropic_api_key', CLAUDE_KEY);
    expect(createProviderFactory(h.deps).usable()).toEqual({ ok: true });
  });
});

describe('createProviderFactory - seam provider (E2E only)', () => {
  it('returns the seam provider under the current id without constructing a real one', async () => {
    const stub = fakeProvider('local', 'stub-llm');
    const h = harness({ seamProvider: vi.fn(() => stub) });
    const provider = await createProviderFactory(h.deps).get();
    expect(provider).toBe(stub);
    expect(h.made).toEqual({ claude: 0, gemini: 0, local: 0 });
  });

  it('consent rules still apply to a cloud id in seam mode', async () => {
    const seam = vi.fn(() => fakeProvider('claude', 'stub-llm'));
    const h = harness({ seamProvider: seam });
    h.setSettings((s) => (s.llm.provider = 'claude'));
    h.keys.set('anthropic_api_key', CLAUDE_KEY);
    await expect(createProviderFactory(h.deps).get()).rejects.toBeInstanceOf(ConsentRequiredError);
    expect(seam).not.toHaveBeenCalled();
  });

  it('a seam that returns null falls back to the real constructor for that id (never to another id)', async () => {
    const h = harness({ seamProvider: vi.fn(() => null) });
    const provider = await createProviderFactory(h.deps).get();
    expect(provider.id).toBe('local');
    expect(h.made).toEqual({ claude: 0, gemini: 0, local: 1 });
  });
});

describe('createProviderFactory - isolation (I5 / A20)', () => {
  it('the factory offers the makers nothing but a key, a model and the local tier', async () => {
    const h = harness();
    h.setSettings((s) => (s.llm.provider = 'claude'));
    h.accepted.cloud_claude = CONSENT_VERSIONS.cloud_claude;
    h.keys.set('anthropic_api_key', CLAUDE_KEY);
    await createProviderFactory(h.deps).get();
    expect(vi.mocked(h.deps.makeClaude).mock.calls[0]![0]).toEqual({ apiKey: CLAUDE_KEY, model: 'claude-opus-5' });
    h.setSettings((s) => (s.llm.provider = 'local'));
    await createProviderFactory(h.deps).get();
    expect(Object.keys(vi.mocked(h.deps.makeLocal).mock.calls[0]![0])).toEqual(['tier']);
  });

  it('never logs the key', async () => {
    const h = harness();
    h.setSettings((s) => (s.llm.provider = 'claude'));
    h.accepted.cloud_claude = CONSENT_VERSIONS.cloud_claude;
    h.keys.set('anthropic_api_key', CLAUDE_KEY);
    await createProviderFactory(h.deps).get();
    const all = h.lines.join('\n');
    expect(all).toContain('provider.created');
    expect(all).not.toContain('TESTONLY');
    expect(all).not.toContain('sk-ant-');
  });
});
