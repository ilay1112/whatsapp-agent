// src/main/llm/gemini.test.ts - TESTS 5.3 row `llm/gemini.ts` (owner W1-06). No network: the SDK module is replaced by a
// recording double and every provider call goes through an injected GeminiClientLike.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GEMINI_BASE_URL,
  GEMINI_TIMEOUT_MS,
  createGeminiProvider,
  createGoogleGenAiClient,
  geminiClientOptions,
  getGeminiModel,
  isAliasModelId,
  listGeminiModels,
  mapGeminiError,
  mapGeminiStopReason,
  toGeminiInput,
  toGeminiSchema,
  toGeminiContent,
  hasImagePart,
  type GeminiClientLike,
} from './gemini';
import { LlmError, type CallOpts, type LlmMessage, type LlmTool } from './types';
import type { JsonSchemaLcd } from '../../shared/types';
import type { LogMeta, Logger } from '../deps';

// ---------------------------------------------------------------------------------------------------------------------
// recording SDK double (proves the CONTRACTS section 9 constructor bag; no request is ever sent)
// ---------------------------------------------------------------------------------------------------------------------
const hoisted = vi.hoisted(() => ({ ctorCalls: [] as unknown[] }));
vi.mock('@google/genai', () => {
  class RecordingGoogleGenAI {
    interactions = { create: vi.fn(async () => ({ status: 'completed' })) };
    models = {
      generateContent: vi.fn(async () => ({})),
      get: vi.fn(async () => ({})),
      list: vi.fn(async () => ({ models: [] })),
    };
    constructor(opts: unknown) {
      hoisted.ctorCalls.push(opts);
    }
  }
  return { GoogleGenAI: RecordingGoogleGenAI };
});

// ---------------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------------
const SENTINEL_KEY = 'AIzaTESTONLY0123456789abcdefghijklmno';
const MODEL = 'gemini-3.8-flash';
const fixture = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./__fixtures__/${rel}`, import.meta.url)), 'utf8')) as Record<
    string,
    unknown
  >;

interface RecordedLog {
  lines: string[];
  logger: Logger;
}
function recordingLogger(): RecordedLog {
  const lines: string[] = [];
  const mk = (scope: string): Logger => ({
    info: (e: string, m?: LogMeta) => lines.push(`${scope} info ${e} ${JSON.stringify(m ?? {})}`),
    warn: (e: string, m?: LogMeta) => lines.push(`${scope} warn ${e} ${JSON.stringify(m ?? {})}`),
    error: (e: string, m?: LogMeta) => lines.push(`${scope} error ${e} ${JSON.stringify(m ?? {})}`),
    child: (s: string) => mk(`${scope}.${s}`),
  });
  return { lines, logger: mk('root') };
}

interface Recorder {
  client: GeminiClientLike;
  requests: Array<Record<string, unknown>>;
  callOpts: Array<Record<string, unknown> | undefined>;
  gets: string[];
}
function recorder(reply: unknown | (() => unknown)): Recorder {
  const requests: Array<Record<string, unknown>> = [];
  const callOpts: Array<Record<string, unknown> | undefined> = [];
  const gets: string[] = [];
  const next = (): unknown => {
    const r = typeof reply === 'function' ? (reply as () => unknown)() : reply;
    if (r instanceof Error) throw r;
    return r;
  };
  return {
    requests,
    callOpts,
    gets,
    client: {
      interactions: {
        create: async (params: Record<string, unknown>, o?: Record<string, unknown>) => {
          requests.push(params);
          callOpts.push(o);
          return next();
        },
      },
      models: {
        generateContent: async () => next(),
        get: async (p: { model: string }) => {
          gets.push(p.model);
          return next();
        },
        list: async () => next(),
      },
    },
  };
}

const SCHEMA: JsonSchemaLcd = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: ['needs_reply', 'ignore'] },
    slots: {
      type: 'array',
      items: {
        type: 'object',
        properties: { startIso: { type: 'string' } },
        required: ['startIso'],
        additionalProperties: false,
      },
    },
  },
  required: ['category', 'slots'],
  additionalProperties: false,
};

const TOOLS: LlmTool[] = [
  {
    name: 'list_events',
    description: 'List events',
    inputSchema: {
      type: 'object',
      properties: { timeMin: { type: 'string' } },
      required: ['timeMin'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_freebusy',
    description: 'Free/busy',
    inputSchema: {
      type: 'object',
      properties: { timeMin: { type: 'string' } },
      required: ['timeMin'],
      additionalProperties: false,
    },
  },
];

const opts = (over: Partial<CallOpts> = {}): CallOpts => ({
  signal: new AbortController().signal,
  maxOutputTokens: 2048,
  purpose: 'extract',
  ...over,
});

const HISTORY: LlmMessage[] = [
  { role: 'system', content: 'You are a scheduling assistant.' },
  { role: 'user', content: 'MESSAGE-TEXT-PLACEHOLDER' },
];

const apiError = (status: number, extra: Record<string, unknown> = {}): Error =>
  Object.assign(new Error('provider body that must never be logged'), { status }, extra);

const provider = (client: GeminiClientLike, log: Logger, model = MODEL) =>
  createGeminiProvider({ apiKey: SENTINEL_KEY, model, client, log });

beforeEach(() => {
  hoisted.ctorCalls.length = 0;
});
afterEach(() => {
  delete process.env.GOOGLE_GEMINI_BASE_URL;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

// ---------------------------------------------------------------------------------------------------------------------

describe('client construction ([R2] env poisoning)', () => {
  it('always passes the binding constants, never undefined', () => {
    expect(geminiClientOptions(SENTINEL_KEY)).toEqual({
      apiKey: SENTINEL_KEY,
      httpOptions: { baseUrl: GEMINI_BASE_URL },
    });
  });

  it('ignores GOOGLE_GEMINI_BASE_URL / GOOGLE_API_KEY / GEMINI_API_KEY in the environment', () => {
    process.env.GOOGLE_GEMINI_BASE_URL = 'https://evil.example';
    process.env.GOOGLE_API_KEY = 'AIzaTESTONLYENV';
    process.env.GEMINI_API_KEY = 'AIzaTESTONLYENV2';
    createGoogleGenAiClient(SENTINEL_KEY);
    expect(hoisted.ctorCalls).toEqual([
      { apiKey: SENTINEL_KEY, httpOptions: { baseUrl: 'https://generativelanguage.googleapis.com' } },
    ]);
  });

  it('does not construct an SDK client when a double was injected', async () => {
    const r = recorder(fixture('gemini/structured-interaction.json'));
    await provider(r.client, recordingLogger().logger).structured(HISTORY, SCHEMA, opts());
    expect(hoisted.ctorCalls).toHaveLength(0);
  });
});

describe('the stateless flag', () => {
  it('appears on every interactions.create request', async () => {
    const r = recorder(fixture('gemini/structured-interaction.json'));
    const p = provider(r.client, recordingLogger().logger);
    await p.structured(HISTORY, SCHEMA, opts());
    await p.chat(HISTORY, TOOLS, opts());
    expect(r.requests).toHaveLength(2);
    for (const req of r.requests) {
      expect(req.store).toBe(false);
      expect(req).not.toHaveProperty('previous_interaction_id');
    }
    expect(r.callOpts.every((o) => o?.timeout_ms === GEMINI_TIMEOUT_MS)).toBe(true);
  });

  it('is written in exactly one place in the source file (grep test)', () => {
    const src = readFileSync(fileURLToPath(new URL('./gemini.ts', import.meta.url)), 'utf8');
    expect(src.match(/store:/g) ?? []).toHaveLength(1);
    expect(src).not.toContain('previous_interaction_id');
    expect(src).not.toContain('mcpToTool');
    expect(src).not.toContain('mcp_server');
  });
});

describe('schema mapping', () => {
  it('deep-copies the LCD schema without mutating the caller', () => {
    const out = toGeminiSchema(SCHEMA);
    expect(out).toEqual(SCHEMA);
    expect(out).not.toBe(SCHEMA);
    expect(out.required).not.toBe(SCHEMA.required);
    const slots = (out.properties as Record<string, Record<string, unknown>>)['slots'];
    expect(slots?.items).not.toBe((SCHEMA.properties as Record<string, unknown>)['slots']);
  });
});

describe('structured() request (S1)', () => {
  it('sends response_format JSON and no tools', async () => {
    const r = recorder(fixture('gemini/structured-interaction.json'));
    const usage: Array<{ inputTokens: number; outputTokens: number }> = [];
    const out = await provider(r.client, recordingLogger().logger).structured<{ category: string }>(
      HISTORY,
      SCHEMA,
      opts({ onUsage: (u) => usage.push(u) }),
    );
    expect(out.category).toBe('needs_reply');
    const req = r.requests[0] as Record<string, unknown>;
    expect(req.response_format).toEqual({
      type: 'text',
      mime_type: 'application/json',
      schema: toGeminiSchema(SCHEMA),
    });
    expect(req).not.toHaveProperty('tools');
    expect(req.generation_config).toEqual({ thinking_level: 'low', max_output_tokens: 2048 });
    expect(req.system_instruction).toBe('You are a scheduling assistant.');
    for (const forbidden of ['temperature', 'top_p', 'top_k'])
      expect(req.generation_config).not.toHaveProperty(forbidden);
    expect(usage).toEqual([{ inputTokens: 800, outputTokens: 35 }]);
  });

  it('omits system_instruction when there is no system message', async () => {
    const r = recorder(fixture('gemini/structured-interaction.json'));
    await provider(r.client, recordingLogger().logger).structured([{ role: 'user', content: 'hi' }], SCHEMA, opts());
    expect(r.requests[0]).not.toHaveProperty('system_instruction');
  });

  it('throws bad_output when the model was blocked or the text is not JSON', async () => {
    const blocked = recorder(fixture('gemini/blocked-interaction.json'));
    await expect(
      provider(blocked.client, recordingLogger().logger).structured(HISTORY, SCHEMA, opts()),
    ).rejects.toMatchObject({
      code: 'bad_output',
      message: 'bad_output',
    });

    const garbage = recorder({ status: 'completed', output_text: 'not json' });
    await expect(
      provider(garbage.client, recordingLogger().logger).structured(HISTORY, SCHEMA, opts()),
    ).rejects.toMatchObject({ code: 'bad_output' });

    const truncated = recorder({ status: 'incomplete', output_text: '{"cat' });
    await expect(
      provider(truncated.client, recordingLogger().logger).structured(HISTORY, SCHEMA, opts()),
    ).rejects.toMatchObject({ code: 'bad_output' });
  });
});

describe('chat() request (S3)', () => {
  it('sends function tools in a deterministic order with tool_choice auto and no response_format', async () => {
    const r = recorder(fixture('gemini/tool-use-interaction.json'));
    await provider(r.client, recordingLogger().logger).chat(HISTORY, TOOLS, opts({ purpose: 'draft' }));
    const req = r.requests[0] as Record<string, unknown>;
    expect((req.tools as Array<{ type: string; name: string }>).map((t) => [t.type, t.name])).toEqual([
      ['function', 'get_freebusy'],
      ['function', 'list_events'],
    ]);
    expect(req).not.toHaveProperty('response_format');
    expect(req.generation_config).toEqual({ thinking_level: 'low', max_output_tokens: 2048, tool_choice: 'auto' });
  });

  it('builds a no-tool turn when tools is empty', async () => {
    const r = recorder({ status: 'completed', output_text: 'Sure.' });
    const res = await provider(r.client, recordingLogger().logger).chat(HISTORY, [], opts());
    const req = r.requests[0] as Record<string, unknown>;
    expect(req).not.toHaveProperty('tools');
    expect(req.generation_config).not.toHaveProperty('tool_choice');
    expect(res.stopReason).toBe('end');
    expect(res.text).toBe('Sure.');
  });

  it('returns tool calls and replays the raw steps through providerData', async () => {
    const fx = fixture('gemini/tool-use-interaction.json');
    const r = recorder(fx);
    const res = await provider(r.client, recordingLogger().logger).chat(HISTORY, TOOLS, opts());
    expect(res.stopReason).toBe('tool_use');
    expect(res.text).toBe('Checking the calendar.');
    expect(res.toolCalls).toEqual([
      {
        id: 'fc_TESTONLY_01',
        name: 'list_events',
        input: { timeMin: '2026-09-24T06:00:00Z', timeMax: '2026-09-24T18:00:00Z' },
      },
    ]);
    expect(res.assistantMessage.providerData).toBe(fx.steps);
    expect(res.usage).toEqual({ inputTokens: 1400, outputTokens: 110 });
  });

  it('rejects a function_call whose name is not in the request tool map', async () => {
    const r = recorder({
      status: 'requires_action',
      steps: [{ type: 'function_call', id: 'fc_1', name: 'delete_everything', arguments: {} }],
    });
    await expect(provider(r.client, recordingLogger().logger).chat(HISTORY, TOOLS, opts())).rejects.toMatchObject({
      code: 'bad_output',
    });
  });

  it('rejects a function_call without an id', async () => {
    const r = recorder({
      status: 'requires_action',
      steps: [{ type: 'function_call', name: 'list_events', arguments: {} }],
    });
    await expect(provider(r.client, recordingLogger().logger).chat(HISTORY, TOOLS, opts())).rejects.toMatchObject({
      code: 'bad_output',
    });
  });

  it('defaults missing arguments to an empty object', async () => {
    const r = recorder({
      status: 'requires_action',
      steps: [{ type: 'function_call', id: 'fc_1', name: 'list_events' }],
    });
    const res = await provider(r.client, recordingLogger().logger).chat(HISTORY, TOOLS, opts());
    expect(res.toolCalls).toEqual([{ id: 'fc_1', name: 'list_events', input: {} }]);
  });

  it('never surfaces tool calls from a truncated turn', async () => {
    const r = recorder({
      status: 'incomplete',
      steps: [{ type: 'function_call', id: 'fc_1', name: 'list_events', arguments: {} }],
    });
    const res = await provider(r.client, recordingLogger().logger).chat(HISTORY, TOOLS, opts());
    expect(res.stopReason).toBe('max_tokens');
    expect(res.toolCalls).toEqual([]);
  });
});

describe('history mapping', () => {
  it('replays a Gemini assistant turn (thought signatures) unchanged', () => {
    const steps = [
      { type: 'thought', signature: 'thoughtsig_TESTONLY_aaa' },
      { type: 'model_output', content: [{ type: 'text', text: 'hi' }] },
    ];
    expect(toGeminiInput([{ role: 'assistant', content: 'hi', providerData: steps }])).toEqual(steps);
  });

  it('rebuilds a foreign assistant turn from the neutral fields', () => {
    expect(
      toGeminiInput([
        { role: 'assistant', content: 'hi', toolCalls: [{ id: 'x1', name: 'list_events', input: { a: 1 } }] },
      ]),
    ).toEqual([
      { type: 'model_output', content: [{ type: 'text', text: 'hi' }] },
      { type: 'function_call', id: 'x1', name: 'list_events', arguments: { a: 1 } },
    ]);
  });

  it('maps user turns and every tool result of a turn to function_result steps', () => {
    expect(
      toGeminiInput([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
        {
          role: 'tool',
          results: [
            { toolCallId: 'a', name: 'list_events', content: '[]' },
            { toolCallId: 'b', name: 'create_event', content: 'not executed', isError: true },
          ],
        },
      ]),
    ).toEqual([
      { type: 'user_input', content: [{ type: 'text', text: 'hello' }] },
      {
        type: 'function_result',
        call_id: 'a',
        name: 'list_events',
        is_error: false,
        result: [{ type: 'text', text: '[]' }],
      },
      {
        type: 'function_result',
        call_id: 'b',
        name: 'create_event',
        is_error: true,
        result: [{ type: 'text', text: 'not executed' }],
      },
    ]);
  });
});

describe('stop-reason mapping', () => {
  it('maps status and generation codes', () => {
    expect(mapGeminiStopReason({ status: 'completed' })).toBe('end');
    expect(mapGeminiStopReason({ status: 'completed', steps: [{ type: 'function_call', id: 'a', name: 'x' }] })).toBe(
      'tool_use',
    );
    expect(mapGeminiStopReason({ status: 'requires_action' })).toBe('tool_use');
    expect(mapGeminiStopReason({ status: 'incomplete' })).toBe('max_tokens');
    expect(mapGeminiStopReason({ status: 'in_progress' })).toBe('other');
    expect(mapGeminiStopReason({ status: 'completed', errors: [{ code: 'max_output_tokens' }] })).toBe('max_tokens');
  });

  it.each(['safety', 'prohibited_content', 'spii', 'recitation', 'language', 'blocklist', 'content_blocked'])(
    'treats %s as a refusal',
    (code) => {
      expect(mapGeminiStopReason({ status: 'completed', steps: [{ type: 'model_output', error: { code } }] })).toBe(
        'refusal',
      );
      expect(mapGeminiStopReason({ status: 'completed', errors: [{ status: code.toUpperCase() }] })).toBe('refusal');
    },
  );
});

describe('interaction status failures', () => {
  it('maps failed / cancelled / budget_exceeded before parsing', async () => {
    await expect(
      provider(recorder({ status: 'failed' }).client, recordingLogger().logger).chat(HISTORY, TOOLS, opts()),
    ).rejects.toMatchObject({
      code: 'bad_output',
    });
    await expect(
      provider(recorder({ status: 'cancelled' }).client, recordingLogger().logger).chat(HISTORY, TOOLS, opts()),
    ).rejects.toMatchObject({
      code: 'aborted',
    });
    await expect(
      provider(recorder({ status: 'budget_exceeded' }).client, recordingLogger().logger).chat(HISTORY, TOOLS, opts()),
    ).rejects.toMatchObject({ code: 'quota_daily' });
  });

  it('tolerates an empty body', async () => {
    const res = await provider(recorder(null).client, recordingLogger().logger).chat(HISTORY, TOOLS, opts());
    expect(res).toMatchObject({
      text: '',
      toolCalls: [],
      stopReason: 'other',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });
});

describe('error mapping (duck-typed)', () => {
  it.each([
    [401, {}, 'auth'],
    [403, {}, 'auth'],
    [402, {}, 'billing'],
    [404, {}, 'model_not_found'],
    [499, {}, 'aborted'],
    [503, {}, 'overloaded'],
    [418, {}, 'bad_output'],
  ])('status %i -> %s', (status, extra, code) => {
    expect(mapGeminiError(apiError(status as number, extra as Record<string, unknown>)).code).toBe(code);
  });

  it('treats a 400 API_KEY_INVALID as auth and any other 400 as bad_output', () => {
    expect(mapGeminiError(apiError(400, { error: { error: { code: 'API_KEY_INVALID' } } })).code).toBe('auth');
    expect(mapGeminiError(apiError(400, { error: { code: 'authentication' } })).code).toBe('auth');
    expect(mapGeminiError(apiError(400)).code).toBe('bad_output');
  });

  it('separates the daily quota from a transient rate limit', () => {
    expect(mapGeminiError(apiError(429, { code: 'quota_exceeded' })).code).toBe('quota_daily');
    const limited = mapGeminiError(apiError(429, { headers: new Headers({ 'retry-after': '12' }) }));
    expect(limited.code).toBe('rate_limited');
    expect(limited.retryAfterMs).toBe(12_000);
    expect(mapGeminiError(apiError(429)).retryAfterMs).toBeUndefined();
  });

  it('maps transport failures and aborts', () => {
    expect(mapGeminiError(new Error('socket hang up')).code).toBe('network');
    expect(mapGeminiError(Object.assign(new Error('x'), { name: 'RequestAbortedError' })).code).toBe('aborted');
    const ac = new AbortController();
    ac.abort();
    expect(mapGeminiError(apiError(500), ac.signal).code).toBe('aborted');
    const e = new LlmError('quota_daily');
    expect(mapGeminiError(e)).toBe(e);
  });

  it('surfaces the mapped code from chat() and logs no body', async () => {
    const rec = recordingLogger();
    const r = recorder(() => apiError(401));
    await expect(provider(r.client, rec.logger).chat(HISTORY, TOOLS, opts())).rejects.toMatchObject({
      code: 'auth',
      message: 'auth',
    });
    expect(rec.lines.join('\n')).not.toContain('provider body');
  });
});

describe('model ids', () => {
  it('refuses -latest aliases at construction and in getGeminiModel', async () => {
    expect(isAliasModelId('gemini-flash-latest')).toBe(true);
    expect(isAliasModelId('gemini-3.8-flash')).toBe(false);
    expect(() => provider(recorder({}).client, recordingLogger().logger, 'gemini-flash-latest')).toThrow(LlmError);
    expect(() => provider(recorder({}).client, recordingLogger().logger, '')).toThrow(LlmError);
    await expect(
      getGeminiModel({ apiKey: SENTINEL_KEY, model: 'gemini-flash-latest', client: recorder({}).client }),
    ).rejects.toMatchObject({
      code: 'model_not_found',
    });
  });

  it('resolves a model id through models.get', async () => {
    const r = recorder({ name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' });
    await expect(getGeminiModel({ apiKey: SENTINEL_KEY, model: MODEL, client: r.client })).resolves.toEqual({
      id: 'gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash',
    });
    expect(r.gets).toEqual([MODEL]);
  });

  it('falls back to the requested id when the response carries no names', async () => {
    await expect(getGeminiModel({ apiKey: SENTINEL_KEY, model: MODEL, client: recorder({}).client })).resolves.toEqual({
      id: MODEL,
      displayName: MODEL,
    });
  });

  it('maps a models.get failure', async () => {
    await expect(
      getGeminiModel({ apiKey: SENTINEL_KEY, model: MODEL, client: recorder(() => apiError(404)).client }),
    ).rejects.toMatchObject({
      code: 'model_not_found',
    });
  });
});

describe('validate()', () => {
  it('uses models.get and returns the display name', async () => {
    const r = recorder({ name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' });
    await expect(provider(r.client, recordingLogger().logger).validate(new AbortController().signal)).resolves.toEqual({
      ok: true,
      model: 'Gemini 3.8 Flash',
    });
  });

  it('reports a ProviderErrorCode instead of throwing', async () => {
    const r = recorder(() => apiError(403));
    await expect(provider(r.client, recordingLogger().logger).validate(new AbortController().signal)).resolves.toEqual({
      ok: false,
      reason: 'auth',
    });
  });
});

describe('listGeminiModels()', () => {
  it('returns the live list without -latest aliases', async () => {
    const r = recorder(fixture('gemini/models-list.json'));
    await expect(listGeminiModels({ apiKey: SENTINEL_KEY, client: r.client })).resolves.toEqual([
      { id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' },
      { id: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash Lite' },
    ]);
  });

  it('accepts a bare array page, drops nameless rows and maps transport errors', async () => {
    await expect(
      listGeminiModels({ apiKey: SENTINEL_KEY, client: recorder([{ name: 'models/gemini-3.8-flash' }, {}]).client }),
    ).resolves.toEqual([{ id: 'gemini-3.8-flash', displayName: 'gemini-3.8-flash' }]);
    await expect(listGeminiModels({ apiKey: SENTINEL_KEY, client: recorder({ nope: 1 }).client })).resolves.toEqual([]);
    await expect(
      listGeminiModels({ apiKey: SENTINEL_KEY, client: recorder(() => apiError(401)).client }),
    ).rejects.toMatchObject({ code: 'auth' });
  });
});

describe('dispose()', () => {
  it('drops the cached client so the next call rebuilds it with the binding constants', async () => {
    const r = recorder(fixture('gemini/structured-interaction.json'));
    const p = provider(r.client, recordingLogger().logger);
    await p.structured(HISTORY, SCHEMA, opts());
    expect(hoisted.ctorCalls).toHaveLength(0);
    await p.dispose();
    await expect(p.structured(HISTORY, SCHEMA, opts())).rejects.toBeInstanceOf(LlmError);
    expect(hoisted.ctorCalls).toEqual([geminiClientOptions(SENTINEL_KEY)]);
  });
});

describe('the key never reaches a log line (sentinel)', () => {
  it('holds across a successful turn, a failed turn and validate()', async () => {
    const rec = recordingLogger();
    const ok = recorder(fixture('gemini/tool-use-interaction.json'));
    const p = provider(ok.client, rec.logger);
    await p.chat(HISTORY, TOOLS, opts());

    const bad = recorder(() => apiError(429, { code: 'quota_exceeded' }));
    const p2 = provider(bad.client, rec.logger);
    await expect(p2.structured(HISTORY, SCHEMA, opts())).rejects.toBeInstanceOf(LlmError);
    await p2.validate(new AbortController().signal);

    const all = rec.lines.join('\n');
    expect(rec.lines.length).toBeGreaterThan(0);
    expect(all).not.toContain(SENTINEL_KEY);
    expect(all).not.toContain('TESTONLY');
    expect(all).not.toContain('MESSAGE-TEXT-PLACEHOLDER');
  });
});

describe('fixtures', () => {
  it('are all flagged unverified and carry only sentinel material', () => {
    for (const rel of [
      'gemini/tool-use-interaction.json',
      'gemini/structured-interaction.json',
      'gemini/blocked-interaction.json',
      'gemini/models-list.json',
    ]) {
      const raw = readFileSync(fileURLToPath(new URL(`./__fixtures__/${rel}`, import.meta.url)), 'utf8');
      expect(JSON.parse(raw)._unverified).toBe(true);
      expect(raw).not.toMatch(/@s\.whatsapp\.net|@lid/);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [V2, V2-W1-08-vision] V1 READ-IMAGE (C2 9 / 9.1, B19, I12): the inline picture FIRST, no function declarations
// ---------------------------------------------------------------------------------------------------------------------
describe('V1 read_image (inline picture, no function declarations)', () => {
  const B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
  const V1: LlmMessage[] = [
    { role: 'system', content: 'V1 CONSTANT (test)' },
    {
      role: 'user',
      content: [
        { type: 'image', mime: 'image/png', base64: B64 },
        { type: 'text', text: '<<DATA-0123456789abcdef>>\n{}\n<<END-DATA-0123456789abcdef>>' },
      ],
    },
  ];

  it('capabilities.images is true and the loop is the v1 turn loop', () => {
    const p = provider(recorder({}).client, recordingLogger().logger);
    expect(p.capabilities).toEqual({ images: true });
    expect(p.loop).toBe('turn');
  });

  it('sends the picture as the Interactions image block before the text, with no tools of any kind', async () => {
    const r = recorder(fixture('gemini/image-read-interaction.json'));
    const out = await provider(r.client, recordingLogger().logger).structured<{ readable: boolean; month: number }>(
      V1,
      SCHEMA,
      opts({ purpose: 'read_image', maxOutputTokens: 768 }),
    );
    expect(out).toMatchObject({ readable: true, month: 10 });
    const req = r.requests[0] as Record<string, unknown>;
    for (const k of ['tools', 'tool_config', 'function_declarations', 'functionDeclarations'])
      expect(req).not.toHaveProperty(k);
    expect(JSON.stringify(req)).not.toMatch(/function_?[dD]eclarations/);
    expect(req.system_instruction).toBe('V1 CONSTANT (test)');
    expect(req.input).toEqual([
      {
        type: 'user_input',
        content: [
          { type: 'image', data: B64, mime_type: 'image/png' },
          { type: 'text', text: '<<DATA-0123456789abcdef>>\n{}\n<<END-DATA-0123456789abcdef>>' },
        ],
      },
    ]);
  });

  it('toGeminiContent keeps the caller order; hasImagePart only sees image parts of user turns', () => {
    expect(
      toGeminiContent([
        { type: 'text', text: 'a' },
        { type: 'image', mime: 'image/jpeg', base64: 'AA==' },
      ]),
    ).toEqual([
      { type: 'text', text: 'a' },
      { type: 'image', data: 'AA==', mime_type: 'image/jpeg' },
    ]);
    expect(hasImagePart(HISTORY)).toBe(false);
    expect(hasImagePart(V1)).toBe(true);
    expect(hasImagePart([{ role: 'user', content: [{ type: 'text', text: 'x' }] }])).toBe(false);
  });

  it('a picture on any other purpose, or in chat(), is refused before any request (unsupported)', async () => {
    const r = recorder(fixture('gemini/image-read-interaction.json'));
    const p = provider(r.client, recordingLogger().logger);
    await expect(p.structured(V1, SCHEMA, opts({ purpose: 'extract' }))).rejects.toMatchObject({ code: 'unsupported' });
    await expect(p.chat(V1, TOOLS, opts({ purpose: 'read_image' }))).rejects.toMatchObject({ code: 'unsupported' });
    expect(r.requests).toHaveLength(0);
  });

  it('the image fixture is flagged unverified and synthetic', () => {
    const raw = readFileSync(
      fileURLToPath(new URL('./__fixtures__/gemini/image-read-interaction.json', import.meta.url)),
      'utf8',
    );
    expect(JSON.parse(raw)._unverified).toBe(true);
    expect(raw).not.toMatch(/@s\.whatsapp\.net|@lid/);
  });
});
