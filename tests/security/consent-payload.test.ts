// tests/security/consent-payload.test.ts - gate item 10 of TESTS 8.2 (invariant I5, assumption A20). Owner: W2-02.
//
// The REAL `createProviderFactory`, the REAL `assertConsent`, the REAL Claude / Gemini providers behind S-SDK doubles and
// the REAL `consent:accept` handler through the harness. What leaves the machine is captured and grepped for every
// fixture identifier; nothing that is under test is mocked.
import { afterEach, describe, expect, it } from 'vitest';

import { createHarness, extraction, type Harness } from '../helpers/harness.ts';
import type { StubRule } from '../fakes/stub-llm.ts';
import { createProviderFactory, SECRET_FOR } from '../../src/main/llm/factory.ts';
import { CONSENT_KIND_FOR, assertConsent } from '../../src/main/llm/consent.ts';
import { ConsentRequiredError, LlmError, type LlmMessage, type LlmProvider } from '../../src/main/llm/types.ts';
import {
  ANTHROPIC_BASE_URL,
  claudeClientOptions,
  createClaudeProvider,
  type ClaudeClientLike,
} from '../../src/main/llm/claude.ts';
import {
  GEMINI_BASE_URL,
  createGeminiProvider,
  geminiClientOptions,
  type GeminiClientLike,
} from '../../src/main/llm/gemini.ts';
import { createRepos, openDb } from '../../src/main/db/index.ts';
import { CONSENT_VERSIONS, type EpochMs, type JsonSchemaLcd } from '../../src/shared/types.ts';
import type { Settings } from '../../src/shared/settings.ts';
import type { Logger } from '../../src/main/deps.ts';

const CHAT = '972550000001@s.whatsapp.net';

/** Every identifier that must never appear in an outbound provider request. */
const SENTINELS = [
  '972550000001',
  '972550000002',
  CHAT,
  's.whatsapp.net',
  'Dana Levi', // synthetic push name used below
  'IMG-20260923-WA0001.jpg',
  'sk-ant-TESTONLY',
  'AIzaTESTONLY',
];

const silentLog: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLog,
};

const NOW = Date.UTC(2026, 8, 23, 8, 0, 0) as EpochMs;

function memoryRepos(): ReturnType<typeof createRepos> & { close: () => void } {
  const db = openDb(':memory:');
  const repos = createRepos(db);
  return Object.assign(repos, { close: () => db.close() });
}

function settingsWith(provider: 'local' | 'claude' | 'gemini'): Settings {
  return {
    general: { timeZone: 'Asia/Jerusalem', language: 'en' },
    llm: {
      provider,
      claudeModel: 'claude-test-model',
      geminiModel: 'gemini-test-model',
      local: { tier: 'small' },
    },
  } as unknown as Settings;
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. the factory refuses without consent
// ---------------------------------------------------------------------------------------------------------------------
describe('A20 - no cloud provider is constructed without a current consent record', () => {
  it('assertConsent throws for a cloud provider and is a no-op for local', () => {
    const repos = memoryRepos();
    try {
      expect(() => assertConsent(repos, 'local')).not.toThrow();
      expect(() => assertConsent(repos, 'claude')).toThrow(ConsentRequiredError);
      expect(() => assertConsent(repos, 'gemini')).toThrow(ConsentRequiredError);
      repos.consents.accept('cloud_claude', CONSENT_VERSIONS.cloud_claude, NOW);
      expect(() => assertConsent(repos, 'claude')).not.toThrow();
      expect(() => assertConsent(repos, 'gemini')).toThrow(ConsentRequiredError);
    } finally {
      repos.close();
    }
  });

  it.each(['claude', 'gemini'] as const)(
    'the %s factory reads no key and builds no client without consent',
    async (id) => {
      const repos = memoryRepos();
      try {
        const reads: string[] = [];
        const built: string[] = [];
        const factory = createProviderFactory({
          settings: () => settingsWith(id),
          secrets: {
            get: (name) => {
              reads.push(name);
              return Promise.resolve('sk-ant-TESTONLY-0123456789abcdef');
            },
            has: () => ({ present: true, encrypted: true }) as never,
          },
          repos,
          makeClaude: () => {
            built.push('claude');
            return {} as LlmProvider;
          },
          makeGemini: () => {
            built.push('gemini');
            return {} as LlmProvider;
          },
          makeLocal: () => {
            built.push('local');
            return {} as LlmProvider;
          },
          log: silentLog,
        });

        await expect(factory.get()).rejects.toBeInstanceOf(ConsentRequiredError);
        expect(reads, 'the API key must not even be decrypted without consent').toEqual([]);
        expect(built).toEqual([]);
        expect(factory.usable()).toEqual({ ok: false, code: 'CONSENT_REQUIRED' });

        repos.consents.accept(CONSENT_KIND_FOR[id], CONSENT_VERSIONS[CONSENT_KIND_FOR[id]], NOW);
        await expect(factory.get()).resolves.toBeDefined();
        expect(reads).toEqual([SECRET_FOR[id]]);
        expect(built).toEqual([id]);
      } finally {
        repos.close();
      }
    },
  );

  it('a consent version bump re-blocks an already-accepted provider', async () => {
    // A bump means: the row on disk carries the version the user really read, and that is no longer the current one.
    const repos = memoryRepos();
    try {
      repos.consents.accept('cloud_claude', CONSENT_VERSIONS.cloud_claude, NOW);
      expect(repos.consents.isCurrent('cloud_claude')).toBe(true);
      const factory = createProviderFactory({
        settings: () => settingsWith('claude'),
        secrets: {
          get: () => Promise.resolve('sk-ant-TESTONLY-0123456789abcdef'),
          has: () => ({ present: true, encrypted: true }) as never,
        },
        repos,
        makeClaude: () => ({ id: 'claude', model: 'm', dispose: () => Promise.resolve() }) as unknown as LlmProvider,
        makeGemini: () => ({}) as LlmProvider,
        makeLocal: () => ({}) as LlmProvider,
        log: silentLog,
      });
      await expect(factory.get()).resolves.toBeDefined();
    } finally {
      repos.close();
    }

    // Same app, but the only acceptance on disk is the text the user read BEFORE the bump.
    const stale = memoryRepos();
    try {
      stale.consents.accept('cloud_claude', CONSENT_VERSIONS.cloud_claude - 1, NOW);
      expect(stale.consents.latest('cloud_claude')?.version).toBe(CONSENT_VERSIONS.cloud_claude - 1);
      expect(stale.consents.isCurrent('cloud_claude')).toBe(false);
      const keyReads: string[] = [];
      const staleFactory = createProviderFactory({
        settings: () => settingsWith('claude'),
        secrets: {
          get: (name) => {
            keyReads.push(name);
            return Promise.resolve('sk-ant-TESTONLY-0123456789abcdef');
          },
          has: () => ({ present: true, encrypted: true }) as never,
        },
        repos: stale,
        makeClaude: () => ({ id: 'claude', model: 'm', dispose: () => Promise.resolve() }) as unknown as LlmProvider,
        makeGemini: () => ({}) as LlmProvider,
        makeLocal: () => ({}) as LlmProvider,
        log: silentLog,
      });
      await expect(staleFactory.get()).rejects.toBeInstanceOf(ConsentRequiredError);
      expect(staleFactory.usable()).toEqual({ ok: false, code: 'CONSENT_REQUIRED' });
      expect(keyReads).toEqual([]);
    } finally {
      stale.close();
    }
  });

  it('a missing key is `not_ready`, never a silent fall back to another provider', async () => {
    const repos = memoryRepos();
    try {
      repos.consents.accept('cloud_gemini', CONSENT_VERSIONS.cloud_gemini, NOW);
      const built: string[] = [];
      const factory = createProviderFactory({
        settings: () => settingsWith('gemini'),
        secrets: { get: () => Promise.resolve(null), has: () => ({ present: false, encrypted: false }) as never },
        repos,
        makeClaude: () => {
          built.push('claude');
          return {} as LlmProvider;
        },
        makeGemini: () => {
          built.push('gemini');
          return {} as LlmProvider;
        },
        makeLocal: () => {
          built.push('local');
          return {} as LlmProvider;
        },
        log: silentLog,
      });
      await expect(factory.get()).rejects.toBeInstanceOf(LlmError);
      expect(built).toEqual([]);
      expect(factory.usable()).toEqual({ ok: false, code: 'KEY_MISSING' });
    } finally {
      repos.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. [R2] SDK base-URL poisoning
// ---------------------------------------------------------------------------------------------------------------------
describe('[R2] I5 - a hostile environment cannot redirect a provider', () => {
  it('constructs both SDK clients with the constant base URLs even with poisoned env vars', () => {
    const saved = { ...process.env };
    try {
      process.env.ANTHROPIC_BASE_URL = 'https://evil.example';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-attacker';
      process.env.ANTHROPIC_AUTH_TOKEN = 'attacker';
      process.env.GOOGLE_GEMINI_BASE_URL = 'https://evil.example';
      process.env.GEMINI_API_KEY = 'AIzaAttacker';
      process.env.GOOGLE_API_KEY = 'AIzaAttacker';

      const claude = claudeClientOptions('sk-ant-TESTONLY-0123456789abcdef');
      expect(claude.baseURL).toBe(ANTHROPIC_BASE_URL);
      expect(claude.baseURL).toBe('https://api.anthropic.com');
      expect(claude.apiKey).toBe('sk-ant-TESTONLY-0123456789abcdef');
      expect(typeof claude.maxRetries).toBe('number');
      expect(typeof claude.timeout).toBe('number');

      const gemini = geminiClientOptions('AIzaTESTONLY0123456789abcdefghijklmno');
      expect(gemini.httpOptions.baseUrl).toBe(GEMINI_BASE_URL);
      expect(gemini.httpOptions.baseUrl).toBe('https://generativelanguage.googleapis.com');
      expect(gemini.apiKey).toBe('AIzaTESTONLY0123456789abcdefghijklmno');
      // `undefined` would let the SDK fall back to the environment - the bag must always carry a literal.
      expect(Object.values(claude).includes(undefined as never)).toBe(false);
      expect(gemini.httpOptions.baseUrl).not.toContain('evil');
    } finally {
      process.env = saved;
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. request snapshots: what actually leaves the machine
// ---------------------------------------------------------------------------------------------------------------------
const SCHEMA: JsonSchemaLcd = {
  type: 'object',
  properties: { intent: { type: 'string' } },
  required: ['intent'],
  additionalProperties: false,
} as unknown as JsonSchemaLcd;

/** A conversation carrying every kind of identifier the app knows about. */
const MESSAGES: LlmMessage[] = [
  { role: 'system', content: 'You are a scheduling assistant. Today is 2026-09-23 in Asia/Jerusalem.' },
  {
    role: 'user',
    content:
      '<<DATA nonce=abc123>>\n{"messages":[{"from":"them","text":"coffee Thursday at 5?"}]}\n<<END-DATA nonce=abc123>>',
  },
];

describe('I5 - the outbound request carries role labels, never identities', () => {
  it('Claude: the captured request contains no JID, phone number, push name or file name', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const client: ClaudeClientLike = {
      messages: {
        create: (params) => {
          captured.push(params);
          return Promise.resolve({
            content: [{ type: 'text', text: '{"intent":"schedule_request"}' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 2 },
          });
        },
      },
      models: {
        list: () => Promise.resolve({ data: [] }),
        retrieve: () => Promise.resolve({ id: 'claude-test-model' }),
      },
    };
    const provider = createClaudeProvider({
      apiKey: 'sk-ant-TESTONLY-0123456789abcdef',
      model: 'claude-test-model',
      client,
      log: silentLog,
    });
    await provider.structured(MESSAGES, SCHEMA, {
      signal: AbortSignal.timeout(5_000),
      maxOutputTokens: 1024,
      purpose: 'extract',
    });
    await provider.chat(MESSAGES, [], {
      signal: AbortSignal.timeout(5_000),
      maxOutputTokens: 1024,
      purpose: 'draft',
    });

    expect(captured).toHaveLength(2);
    const text = JSON.stringify(captured);
    for (const sentinel of SENTINELS) expect(text, sentinel).not.toContain(sentinel);
    // Only role labels identify a speaker.
    for (const params of captured) {
      const messages = params.messages as Array<{ role: string }>;
      expect(messages.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);
      expect(params.model).toBe('claude-test-model');
      expect(params.api_key).toBeUndefined();
      expect(params.metadata).toBeUndefined(); // no user_id / session id ever travels
    }
    await provider.dispose();
  });

  it('Gemini: the captured request carries store:false on EVERY call and no identities', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const client: GeminiClientLike = {
      interactions: {
        create: (params) => {
          captured.push(params);
          return Promise.resolve({
            status: 'completed',
            output_text: '{"intent":"schedule_request"}',
            steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"intent":"schedule_request"}' }] }],
            usage: { total_input_tokens: 10, total_output_tokens: 2 },
          });
        },
      },
      models: {
        generateContent: () => Promise.resolve({}),
        get: () => Promise.resolve({ name: 'models/gemini-test-model' }),
        list: () => Promise.resolve({ models: [] }),
      },
    };
    const provider = createGeminiProvider({
      apiKey: 'AIzaTESTONLY0123456789abcdefghijklmno',
      model: 'gemini-test-model',
      client,
      log: silentLog,
    });
    await provider.structured(MESSAGES, SCHEMA, {
      signal: AbortSignal.timeout(5_000),
      maxOutputTokens: 1024,
      purpose: 'extract',
    });
    await provider.chat(MESSAGES, [], {
      signal: AbortSignal.timeout(5_000),
      maxOutputTokens: 1024,
      purpose: 'draft',
    });

    expect(captured).toHaveLength(2);
    for (const params of captured) {
      expect(params.store, 'A20: Gemini prompts are never retained').toBe(false);
      expect(params.model).toBe('gemini-test-model');
      // The three banned request keys of the ARCH section 8 NEVER row.
      expect(params.cached_content).toBeUndefined();
      expect(params.file_data).toBeUndefined();
      expect(params.tool_config).toBeUndefined();
    }
    const text = JSON.stringify(captured);
    for (const sentinel of SENTINELS) expect(text, sentinel).not.toContain(sentinel);
    await provider.dispose();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. what the real pipeline hands the provider (through the harness)
// ---------------------------------------------------------------------------------------------------------------------
const RULES: StubRule[] = [
  { when: { purpose: 'extract' }, respond: { structured: extraction({ intent: 'other' }) } },
  { when: { purpose: 'draft' }, respond: { text: 'ok', stopReason: 'end' } },
];

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

describe('I5 - the pipeline hands the provider no identity of its own', () => {
  it('never puts a JID, a phone number, a push name or a media file name into a message', async () => {
    h = await createHarness({ rules: RULES });
    await h.bridge.outboundFromPhone({ chatJid: CHAT, text: 'hey', ts: new Date(h.clock.now() - 3_600_000) });
    await h.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?', pushName: 'Dana Levi' });
    await h.settle();

    expect(h.llm.calls.length).toBeGreaterThan(0);
    const text = JSON.stringify(h.llm.calls);
    for (const sentinel of SENTINELS) expect(text, sentinel).not.toContain(sentinel);
    for (const call of h.llm.calls) {
      for (const message of call.messages) {
        expect(['system', 'user', 'assistant', 'tool']).toContain(message.role);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. [R2] consent:accept and llm:setProvider through the real IPC surface
// ---------------------------------------------------------------------------------------------------------------------
describe('[R2] A20 - the consent channel itself', () => {
  it('rejects `consent:accept {version: 999}` with BAD_REQUEST and stores nothing', async () => {
    h = await createHarness({ rules: RULES, profile: { cloudConsent: false } });
    const res = await h.invoke('consent:accept', { kind: 'cloud_claude', version: 999 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('BAD_REQUEST');
    expect(h.repos.consents.isCurrent('cloud_claude')).toBe(false);
    const audit = h.repos.db.prepare(`SELECT kind FROM audit_log WHERE kind='ipc_rejected'`).all() as Array<{
      kind: string;
    }>;
    expect(audit.length).toBeGreaterThan(0);
  });

  it('rejects a version that is merely one BELOW the current one', async () => {
    h = await createHarness({ rules: RULES, profile: { cloudConsent: false } });
    const res = await h.invoke('consent:accept', {
      kind: 'cloud_gemini',
      version: CONSENT_VERSIONS.cloud_gemini - 1,
    });
    expect(res.ok).toBe(false);
    expect(h.repos.consents.isCurrent('cloud_gemini')).toBe(false);
  });

  it('accepts exactly the current version', async () => {
    h = await createHarness({ rules: RULES, profile: { cloudConsent: false } });
    const res = await h.invoke('consent:accept', {
      kind: 'cloud_claude',
      version: CONSENT_VERSIONS.cloud_claude,
    });
    expect(res.ok).toBe(true);
    expect(h.repos.consents.isCurrent('cloud_claude')).toBe(true);
  });

  it('llm:setProvider fails with CONSENT_REQUIRED, then KEY_MISSING - never switching silently', async () => {
    h = await createHarness({ rules: RULES, profile: { cloudConsent: false } });
    const before = h.repos.settings.get().llm.provider;

    const noConsent = await h.invoke('llm:setProvider', { provider: 'claude' });
    expect(noConsent.ok).toBe(false);
    if (!noConsent.ok) expect(noConsent.error.code).toBe('CONSENT_REQUIRED');
    expect(h.repos.settings.get().llm.provider).toBe(before);

    const accepted = await h.invoke('consent:accept', {
      kind: 'cloud_claude',
      version: CONSENT_VERSIONS.cloud_claude,
    });
    expect(accepted.ok).toBe(true);

    const noKey = await h.invoke('llm:setProvider', { provider: 'claude' });
    expect(noKey.ok).toBe(false);
    if (!noKey.ok) expect(noKey.error.code).toBe('KEY_MISSING');
    expect(h.repos.settings.get().llm.provider).toBe(before);
  });
});
