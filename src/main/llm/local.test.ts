// src/main/llm/local.test.ts - TESTS 5.3 row `llm/local.ts` (owner W1-07). Every request goes to the loopback
// fake-llama-server; no real llama-server.exe is ever spawned and no model is ever downloaded.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startFakeLlamaServer, type FakeLlamaServer } from '../../../tests/fakes/fake-llama-server';
import {
  DEFAULT_LOCAL_SAMPLING,
  LOCAL_SCHEMA_NAME,
  LOCAL_WIRE_MODEL,
  createLocalProvider,
  mapFinishReason,
  mapHttpStatus,
  toWireMessages,
  toWireTools,
} from './local';
import { LlmError, type CallOpts, type LlmMessage, type LlmTool } from './types';
import type { LlamaRuntime } from './local/llamaServer';
import { EXTRACTION_JSON_SCHEMA } from '../../shared/schemas';
import type { JsonSchemaLcd } from '../../shared/types';
import type { LogMeta, Logger } from '../deps';

// ---------------------------------------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------------------------------------
const API_KEY = 'a'.repeat(64);

interface Recorded {
  events: Array<{ level: string; event: string; meta?: LogMeta }>;
  log: Logger;
}
function recordingLog(): Recorded {
  const events: Recorded['events'] = [];
  const make = (): Logger => ({
    info: (event, meta) => events.push({ level: 'info', event, meta }),
    warn: (event, meta) => events.push({ level: 'warn', event, meta }),
    error: (event, meta) => events.push({ level: 'error', event, meta }),
    child: () => make(),
  });
  return { events, log: make() };
}

/** A LlamaRuntime double: counts ensureStarted()/stop() so "lazy start" and "stopped on provider switch" are observable. */
function fakeRuntime(port: number, over: Partial<LlamaRuntime> = {}): LlamaRuntime & { starts: number; stops: number } {
  const state = { starts: 0, stops: 0 };
  const runtime = {
    ensureStarted: async () => {
      state.starts += 1;
      return { port, apiKey: API_KEY };
    },
    stop: async () => {
      state.stops += 1;
    },
    childSpec: () => {
      throw new Error('not used in these tests');
    },
    status: () => ({ state: 'ready' as const, code: null, device: 'gpu' as const }),
    ...over,
  } as LlamaRuntime;
  // getters, not Object.assign: assign would snapshot the counters at zero
  return Object.defineProperties(runtime, {
    starts: { get: () => state.starts, enumerable: true },
    stops: { get: () => state.stops, enumerable: true },
  }) as LlamaRuntime & { starts: number; stops: number };
}

const opts = (over: Partial<CallOpts> = {}): CallOpts => ({
  signal: new AbortController().signal,
  maxOutputTokens: 512,
  purpose: 'extract',
  ...over,
});

const servers: FakeLlamaServer[] = [];
async function server(o: Parameters<typeof startFakeLlamaServer>[0] = { apiKey: API_KEY }): Promise<FakeLlamaServer> {
  const fake = await startFakeLlamaServer(o);
  servers.push(fake);
  return fake;
}
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.stop();
});

function provider(fake: FakeLlamaServer, runtime = fakeRuntime(fake.port), log = recordingLog().log) {
  return createLocalProvider({
    runtime,
    modelLabel: 'gemma-4-E4B-it-Q4_K_M',
    sampling: DEFAULT_LOCAL_SAMPLING,
    fetch,
    log,
  });
}

const lastBody = (fake: FakeLlamaServer): Record<string, unknown> => {
  const completions = fake.requests.filter((r) => r.path === '/v1/chat/completions');
  return (completions.at(-1)?.body ?? {}) as Record<string, unknown>;
};

// ---------------------------------------------------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------------------------------------------------
describe('wire mapping', () => {
  it('maps system/user/assistant and emits ONE tool wire message per result', () => {
    const messages: LlmMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_freebusy', input: { a: 1 } }] },
      {
        role: 'tool',
        results: [
          { toolCallId: 'c1', name: 'get_freebusy', content: '{"busy":[]}' },
          { toolCallId: 'c2', name: 'get_current_time', content: '{"iso":"x"}' },
        ],
      },
    ];
    expect(toWireMessages(messages)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_freebusy', arguments: '{"a":1}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"busy":[]}' },
      { role: 'tool', tool_call_id: 'c2', content: '{"iso":"x"}' },
    ]);
  });

  it('replays an assistant turn verbatim through providerData', () => {
    const replay = {
      role: 'assistant',
      content: 'kept',
      tool_calls: [{ id: 'z', type: 'function', function: { name: 'n', arguments: '{}' } }],
    };
    const wire = toWireMessages([{ role: 'assistant', content: 'ignored', providerData: replay }]);
    expect(wire).toEqual([{ role: 'assistant', content: 'kept', tool_calls: replay.tool_calls }]);
  });

  it('assistant without tool calls carries no tool_calls key at all', () => {
    expect(toWireMessages([{ role: 'assistant', content: 'plain' }])).toEqual([
      { role: 'assistant', content: 'plain' },
    ]);
  });

  it('passes an app-authored tool schema through untouched', () => {
    const tool: LlmTool = { name: 't', description: 'd', inputSchema: EXTRACTION_JSON_SCHEMA as JsonSchemaLcd };
    expect(toWireTools([tool])).toEqual([
      { type: 'function', function: { name: 't', description: 'd', parameters: EXTRACTION_JSON_SCHEMA } },
    ]);
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [404, 'model_not_found'],
    [429, 'rate_limited'],
    [503, 'not_ready'],
    [500, 'overloaded'],
    [502, 'overloaded'],
    [400, 'bad_output'],
    [418, 'bad_output'],
    [200, 'network'],
  ] as const)('mapHttpStatus(%i) === %s', (status, code) => {
    expect(mapHttpStatus(status)).toBe(code);
  });

  it.each([
    ['stop', false, 'end'],
    ['tool_calls', false, 'tool_use'],
    ['length', false, 'max_tokens'],
    ['content_filter', false, 'refusal'],
    [undefined, false, 'other'],
    ['stop', true, 'tool_use'],
  ] as const)('mapFinishReason(%s, %s) === %s', (reason, hasCalls, expected) => {
    expect(mapFinishReason(reason, hasCalls)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// S1 - structured()
// ---------------------------------------------------------------------------------------------------------------------
describe('structured() - S1 request contract', () => {
  it('[R2] sends response_format.json_schema.schema (deep-equal to EXTRACTION_JSON_SCHEMA), strict:true, and no tools', async () => {
    const fake = await server({
      apiKey: API_KEY,
      rules: [{ when: { purpose: 'extract' }, respond: { structured: { kind: 'none' } } }],
    });
    const out = await provider(fake).structured<{ kind: string }>(
      [{ role: 'user', content: 'x' }],
      EXTRACTION_JSON_SCHEMA as JsonSchemaLcd,
      opts(),
    );
    expect(out).toEqual({ kind: 'none' });

    const body = lastBody(fake);
    const rf = body.response_format as {
      type: string;
      json_schema: { name: string; strict: boolean; schema: unknown };
    };
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema.strict).toBe(true);
    expect(rf.json_schema.name).toBe(LOCAL_SCHEMA_NAME);
    expect(rf.json_schema.schema).toEqual(EXTRACTION_JSON_SCHEMA);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.model).toBe(LOCAL_WIRE_MODEL);
    expect(body.temperature).toBe(DEFAULT_LOCAL_SAMPLING.extract.temperature);
    expect(body.cache_prompt).toBe(true);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(fake.violations).toEqual([]);
  });

  it('contract test: the OLD top-level `schema` shape gets a 400 from llama-server b10964', async () => {
    const fake = await server();
    const res = await fetch(`${fake.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      // the pre-[R2] shape: a top-level `schema` key means NO grammar is installed
      body: JSON.stringify({
        model: 'local',
        messages: [{ role: 'user', content: 'x' }],
        response_format: { type: 'json_schema', schema: EXTRACTION_JSON_SCHEMA },
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    expect(res.status).toBe(400);
  });

  it('carries the bearer key and reports usage', async () => {
    const fake = await server({ apiKey: API_KEY, rules: [{ when: {}, respond: { structured: { ok: true } } }] });
    const usage: Array<{ inputTokens: number; outputTokens: number }> = [];
    await provider(fake).structured(
      [{ role: 'user', content: 'x' }],
      EXTRACTION_JSON_SCHEMA as JsonSchemaLcd,
      opts({ onUsage: (u) => usage.push(u) }),
    );
    expect(fake.requests.filter((r) => r.path === '/v1/chat/completions').every((r) => r.authorized)).toBe(true);
    expect(usage).toEqual([{ inputTokens: 40, outputTokens: 12 }]);
  });

  it('a wrong key is rejected by the server and mapped to LlmError(auth)', async () => {
    const fake = await server({ apiKey: API_KEY });
    const runtime = fakeRuntime(fake.port, {
      ensureStarted: () => Promise.resolve({ port: fake.port, apiKey: 'wrong' }),
    });
    const { events, log } = recordingLog();
    await expect(
      provider(fake, runtime, log).structured(
        [{ role: 'user', content: 'x' }],
        EXTRACTION_JSON_SCHEMA as JsonSchemaLcd,
        opts(),
      ),
    ).rejects.toMatchObject({
      code: 'auth',
    });
    // the 401 body may echo prompt text: only status + code are logged
    const warned = events.find((e) => e.event === 'llama_http_error');
    expect(warned?.meta).toEqual({ status: 401, code: 'auth', purpose: 'extract' });
  });

  it('non-JSON content => bad_output', async () => {
    const fake = await server({ apiKey: API_KEY, scenario: 'garbage' });
    await expect(
      provider(fake).structured([{ role: 'user', content: 'x' }], EXTRACTION_JSON_SCHEMA as JsonSchemaLcd, opts()),
    ).rejects.toMatchObject({
      code: 'bad_output',
    });
  });

  it('an empty content string => bad_output', async () => {
    const fake = await server({ apiKey: API_KEY, rules: [{ when: {}, respond: { text: '' } }] });
    await expect(
      provider(fake).structured([{ role: 'user', content: 'x' }], EXTRACTION_JSON_SCHEMA as JsonSchemaLcd, opts()),
    ).rejects.toMatchObject({
      code: 'bad_output',
    });
  });

  it('a non-JSON HTTP body => bad_output (the JSON parse of the envelope fails)', async () => {
    const fake = await server({ apiKey: API_KEY, rules: [{ when: {}, respond: { status: 200, body: 'not json' } }] });
    await expect(
      provider(fake).structured([{ role: 'user', content: 'x' }], EXTRACTION_JSON_SCHEMA as JsonSchemaLcd, opts()),
    ).rejects.toMatchObject({
      code: 'bad_output',
    });
  });

  it('a dropped connection => network', async () => {
    const fake = await server({ apiKey: API_KEY, scenario: 'exit_on_first_call' });
    await expect(
      provider(fake).structured([{ role: 'user', content: 'x' }], EXTRACTION_JSON_SCHEMA as JsonSchemaLcd, opts()),
    ).rejects.toMatchObject({
      code: 'network',
    });
  });

  it('an aborted signal => aborted', async () => {
    const fake = await server({ apiKey: API_KEY, rules: [{ when: {}, respond: { hang: true } }] });
    const controller = new AbortController();
    const pending = provider(fake).structured(
      [{ role: 'user', content: 'x' }],
      EXTRACTION_JSON_SCHEMA as JsonSchemaLcd,
      opts({ signal: controller.signal }),
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });

  it('a runtime that cannot start => not_ready (the precise code stays in runtime.status())', async () => {
    const fake = await server();
    const runtime = fakeRuntime(fake.port, { ensureStarted: () => Promise.reject(new Error('LLM_VCREDIST_MISSING')) });
    await expect(
      provider(fake, runtime).structured(
        [{ role: 'user', content: 'x' }],
        EXTRACTION_JSON_SCHEMA as JsonSchemaLcd,
        opts(),
      ),
    ).rejects.toMatchObject({
      code: 'not_ready',
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// S3 - chat()
// ---------------------------------------------------------------------------------------------------------------------
describe('chat() - S3 request contract', () => {
  const tools: LlmTool[] = [
    {
      name: 'get_current_time',
      description: 'now',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} } as JsonSchemaLcd,
    },
  ];

  it('sends tools, tool_choice auto, parallel_tool_calls false and Gemma sampling', async () => {
    const fake = await server({ apiKey: API_KEY, rules: [{ when: {}, respond: { text: 'hello' } }] });
    const res = await provider(fake).chat([{ role: 'user', content: 'x' }], tools, opts({ purpose: 'draft' }));
    expect(res.text).toBe('hello');
    expect(res.stopReason).toBe('end');

    const body = lastBody(fake);
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe('auto');
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.response_format).toBeUndefined();
    expect(body.temperature).toBe(DEFAULT_LOCAL_SAMPLING.draft.temperature);
    expect(body.top_p).toBe(DEFAULT_LOCAL_SAMPLING.draft.top_p);
    expect(body.top_k).toBe(DEFAULT_LOCAL_SAMPLING.draft.top_k);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(fake.violations).toEqual([]);
  });

  it('a no-tool turn omits tools, tool_choice and parallel_tool_calls entirely', async () => {
    const fake = await server({ apiKey: API_KEY, rules: [{ when: {}, respond: { text: 'plain' } }] });
    await provider(fake).chat([{ role: 'user', content: 'x' }], [], opts({ purpose: 'draft' }));
    const body = lastBody(fake);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.parallel_tool_calls).toBeUndefined();
  });

  it('parses tool calls and replays the raw message as providerData', async () => {
    const fake = await server({
      apiKey: API_KEY,
      rules: [{ when: {}, respond: { toolCalls: [{ name: 'get_current_time', input: { tz: 'Asia/Jerusalem' } }] } }],
    });
    const res = await provider(fake).chat([{ role: 'user', content: 'x' }], tools, opts({ purpose: 'draft' }));
    expect(res.stopReason).toBe('tool_use');
    expect(res.toolCalls).toEqual([{ id: 'call_0', name: 'get_current_time', input: { tz: 'Asia/Jerusalem' } }]);
    expect(res.assistantMessage.providerData).toMatchObject({ role: 'assistant' });
    expect(res.usage).toEqual({ inputTokens: 40, outputTokens: 12 });
  });

  it('maps finish_reason `length` to max_tokens', async () => {
    const fake = await server({
      apiKey: API_KEY,
      rules: [{ when: {}, respond: { text: 'cut', finishReason: 'length' } }],
    });
    const res = await provider(fake).chat([{ role: 'user', content: 'x' }], [], opts({ purpose: 'draft' }));
    expect(res.stopReason).toBe('max_tokens');
  });

  it.each([
    ['unparseable arguments', { id: 'c', type: 'function', function: { name: 'n', arguments: '{oops' } }],
    ['a non-object argument', { id: 'c', type: 'function', function: { name: 'n', arguments: '[1,2]' } }],
    ['a missing name', { id: 'c', type: 'function', function: { arguments: '{}' } }],
  ])('a tool call with %s => bad_output', async (_name, call) => {
    const fake = await server({
      apiKey: API_KEY,
      rules: [
        {
          when: {},
          respond: {
            status: 200,
            body: JSON.stringify({
              choices: [
                { message: { role: 'assistant', content: '', tool_calls: [call] }, finish_reason: 'tool_calls' },
              ],
            }),
          },
        },
      ],
    });
    await expect(
      provider(fake).chat([{ role: 'user', content: 'x' }], tools, opts({ purpose: 'draft' })),
    ).rejects.toMatchObject({ code: 'bad_output' });
  });

  it('a response with no choices => bad_output', async () => {
    const fake = await server({
      apiKey: API_KEY,
      rules: [{ when: {}, respond: { status: 200, body: '{"choices":[]}' } }],
    });
    await expect(
      provider(fake).chat([{ role: 'user', content: 'x' }], [], opts({ purpose: 'draft' })),
    ).rejects.toMatchObject({ code: 'bad_output' });
  });

  it('a call without a usage block omits usage from the response', async () => {
    const fake = await server({
      apiKey: API_KEY,
      rules: [
        {
          when: {},
          respond: {
            status: 200,
            body: JSON.stringify({
              choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            }),
          },
        },
      ],
    });
    const res = await provider(fake).chat([{ role: 'user', content: 'x' }], [], opts({ purpose: 'draft' }));
    expect(res.usage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// lifecycle: lazy start, validate, dispose
// ---------------------------------------------------------------------------------------------------------------------
describe('lifecycle', () => {
  it('lazy start: constructing the provider never starts llama-server; the first call does', async () => {
    const fake = await server({ apiKey: API_KEY, rules: [{ when: {}, respond: { structured: { ok: true } } }] });
    const runtime = fakeRuntime(fake.port);
    const p = provider(fake, runtime);
    expect(runtime.starts).toBe(0);
    await p.structured([{ role: 'user', content: 'x' }], EXTRACTION_JSON_SCHEMA as JsonSchemaLcd, opts());
    expect(runtime.starts).toBe(1);
  });

  it('dispose() stops the runtime - the provider switch in llm/factory.ts is what shuts llama-server down', async () => {
    const fake = await server();
    const runtime = fakeRuntime(fake.port);
    await provider(fake, runtime).dispose();
    expect(runtime.stops).toBe(1);
  });

  it('validate() reports the model label on /health 200', async () => {
    const fake = await server();
    await expect(provider(fake).validate(new AbortController().signal)).resolves.toEqual({
      ok: true,
      model: 'gemma-4-E4B-it-Q4_K_M',
    });
  });

  it('validate() maps a still-loading server (503) to not_ready', async () => {
    const fake = await server({ apiKey: API_KEY, loadMs: 60_000 });
    await expect(provider(fake).validate(new AbortController().signal)).resolves.toEqual({
      ok: false,
      reason: 'not_ready',
    });
  });

  it('validate() reports not_ready when the runtime refuses to start', async () => {
    const fake = await server();
    const runtime = fakeRuntime(fake.port, { ensureStarted: () => Promise.reject(new Error('nope')) });
    await expect(provider(fake, runtime).validate(new AbortController().signal)).resolves.toEqual({
      ok: false,
      reason: 'not_ready',
    });
  });

  it('validate() maps an unreachable server to network and an aborted signal to aborted', async () => {
    const fake = await server();
    const dead = createLocalProvider({
      runtime: fakeRuntime(fake.port),
      modelLabel: 'm',
      sampling: DEFAULT_LOCAL_SAMPLING,
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
      log: recordingLog().log,
    });
    await expect(dead.validate(new AbortController().signal)).resolves.toEqual({ ok: false, reason: 'network' });

    const aborted = createLocalProvider({
      runtime: fakeRuntime(fake.port),
      modelLabel: 'm',
      sampling: DEFAULT_LOCAL_SAMPLING,
      fetch: () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      log: recordingLog().log,
    });
    await expect(aborted.validate(new AbortController().signal)).resolves.toEqual({ ok: false, reason: 'aborted' });
  });

  it('every request refuses redirects and targets loopback only', async () => {
    const fake = await server({ apiKey: API_KEY, rules: [{ when: {}, respond: { structured: { ok: true } } }] });
    const seen: Array<{ url: string; redirect: string | undefined }> = [];
    const spy: typeof fetch = (input, init) => {
      seen.push({ url: String(input), redirect: init?.redirect });
      return fetch(input, init);
    };
    const p = createLocalProvider({
      runtime: fakeRuntime(fake.port),
      modelLabel: 'm',
      sampling: DEFAULT_LOCAL_SAMPLING,
      fetch: spy,
      log: recordingLog().log,
    });
    await p.structured([{ role: 'user', content: 'x' }], EXTRACTION_JSON_SCHEMA as JsonSchemaLcd, opts());
    await p.validate(new AbortController().signal);
    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.url.startsWith(`http://127.0.0.1:${String(fake.port)}/`)).toBe(true);
      expect(call.redirect).toBe('error');
    }
  });

  it('the provider id is `local` and the model is the GGUF label, never a path', async () => {
    const fake = await server();
    const p = provider(fake);
    expect(p.id).toBe('local');
    expect(p.model).toBe('gemma-4-E4B-it-Q4_K_M');
    expect(p.model).not.toMatch(/[\\/]/);
  });

  it('the LlmError message is the code itself (provider bodies are never logged)', () => {
    expect(new LlmError('bad_output').message).toBe('bad_output');
    expect(vi.isMockFunction(fetch)).toBe(false);
  });
});
