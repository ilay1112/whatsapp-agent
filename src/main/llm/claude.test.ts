// src/main/llm/claude.test.ts - TESTS 5.3 row `llm/claude.ts` (owner W1-06). No network: the SDK module is replaced by a
// recording double and every provider call goes through an injected ClaudeClientLike.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_MAX_RETRIES,
  ANTHROPIC_TIMEOUT_MS,
  CLAUDE_MIN_MAX_TOKENS,
  buildChatRequest,
  buildStructuredRequest,
  claudeClientOptions,
  createAnthropicClient,
  createClaudeProvider,
  listClaudeModels,
  mapClaudeError,
  mapStopReason,
  toClaudeMessages,
  toClaudeSchema,
  type ClaudeClientLike,
} from './claude';
import { LlmError, type CallOpts, type LlmMessage, type LlmTool } from './types';
import type { JsonSchemaLcd } from '../../shared/types';
import type { LogMeta, Logger } from '../deps';

// ---------------------------------------------------------------------------------------------------------------------
// recording SDK double (proves the CONTRACTS section 9 constructor bag; no request is ever sent)
// ---------------------------------------------------------------------------------------------------------------------
const hoisted = vi.hoisted(() => ({ ctorCalls: [] as unknown[] }));
vi.mock('@anthropic-ai/sdk', () => {
  class RecordingAnthropic {
    messages = { create: vi.fn(async () => ({})) };
    models = { list: vi.fn(async () => ({ data: [] })), retrieve: vi.fn(async () => ({})) };
    constructor(opts: unknown) {
      hoisted.ctorCalls.push(opts);
    }
  }
  return { default: RecordingAnthropic };
});

// ---------------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------------
const SENTINEL_KEY = 'sk-ant-TESTONLY-0123456789abcdef';
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
  client: ClaudeClientLike;
  requests: Array<Record<string, unknown>>;
  retrieved: string[];
}
function recorder(reply: unknown | (() => unknown)): Recorder {
  const requests: Array<Record<string, unknown>> = [];
  const retrieved: string[] = [];
  const next = (): unknown => (typeof reply === 'function' ? (reply as () => unknown)() : reply);
  return {
    requests,
    retrieved,
    client: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          requests.push(params);
          const r = next();
          if (r instanceof Error) throw r;
          return r;
        },
      },
      models: {
        list: async () => {
          const r = next();
          if (r instanceof Error) throw r;
          return r;
        },
        retrieve: async (id: string) => {
          retrieved.push(id);
          const r = next();
          if (r instanceof Error) throw r;
          return r;
        },
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
  maxOutputTokens: 512,
  purpose: 'extract',
  ...over,
});

const HISTORY: LlmMessage[] = [
  { role: 'system', content: 'You are a scheduling assistant.' },
  { role: 'user', content: 'MESSAGE-TEXT-PLACEHOLDER' },
];

const apiError = (status: number, extra: Record<string, unknown> = {}): Error =>
  Object.assign(new Error('provider body that must never be logged'), { status }, extra);

beforeEach(() => {
  hoisted.ctorCalls.length = 0;
});
afterEach(() => {
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
});

// ---------------------------------------------------------------------------------------------------------------------

describe('client construction ([R2] env poisoning)', () => {
  it('always passes the binding constants, never undefined', () => {
    expect(claudeClientOptions(SENTINEL_KEY)).toEqual({
      apiKey: SENTINEL_KEY,
      baseURL: ANTHROPIC_BASE_URL,
      maxRetries: ANTHROPIC_MAX_RETRIES,
      timeout: ANTHROPIC_TIMEOUT_MS,
    });
  });

  it('ignores ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY in the environment', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://evil.example';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-TESTONLY-from-the-environment';
    createAnthropicClient(SENTINEL_KEY);
    expect(hoisted.ctorCalls).toHaveLength(1);
    expect(hoisted.ctorCalls[0]).toEqual({
      apiKey: SENTINEL_KEY,
      baseURL: 'https://api.anthropic.com',
      maxRetries: 2,
      timeout: 60_000,
    });
  });

  it('constructs the SDK client lazily and only when no double was injected', async () => {
    const r = recorder(fixture('claude/structured-turn.json'));
    const p = createClaudeProvider({
      apiKey: SENTINEL_KEY,
      model: 'claude-opus-5',
      client: r.client,
      log: recordingLogger().logger,
    });
    await p.structured(HISTORY, SCHEMA, opts());
    expect(hoisted.ctorCalls).toHaveLength(0);
  });
});

describe('schema normalisation', () => {
  it('forces additionalProperties:false on every object node', () => {
    const out = toClaudeSchema({
      type: 'object',
      properties: { nested: { type: 'object', properties: {}, required: [], additionalProperties: false } },
      required: ['nested'],
      additionalProperties: false,
    });
    expect(out.additionalProperties).toBe(false);
    const nested = (out.properties as Record<string, Record<string, unknown>>)['nested'];
    expect(nested?.additionalProperties).toBe(false);
  });

  it('deep-copies so the caller cannot be mutated', () => {
    const out = toClaudeSchema(SCHEMA);
    expect(out).not.toBe(SCHEMA);
    expect(out.required as string[]).not.toBe(SCHEMA.required);
  });
});

describe('structured() request (S1)', () => {
  it('sends output_config.format, no tools, and the forbidden keys are absent', () => {
    const req = buildStructuredRequest('claude-opus-5', HISTORY, SCHEMA, 512);
    expect(req.output_config).toEqual({
      effort: 'low',
      format: { type: 'json_schema', schema: toClaudeSchema(SCHEMA) },
    });
    expect(req).not.toHaveProperty('tools');
    expect(req).not.toHaveProperty('tool_choice');
    for (const forbidden of [
      'temperature',
      'top_p',
      'top_k',
      'thinking',
      'budget_tokens',
      'mcp_servers',
      'fallbacks',
    ]) {
      expect(req).not.toHaveProperty(forbidden);
    }
  });

  it('raises max_tokens to at least 2048 and keeps a larger caller budget', () => {
    expect(buildStructuredRequest('claude-opus-5', HISTORY, SCHEMA, 512).max_tokens).toBe(CLAUDE_MIN_MAX_TOKENS);
    expect(buildStructuredRequest('claude-opus-5', HISTORY, SCHEMA, 4096).max_tokens).toBe(4096);
  });

  it('puts every object of the schema in additionalProperties:false form', () => {
    const req = buildStructuredRequest('claude-opus-5', HISTORY, SCHEMA, 512);
    const format = (req.output_config as { format: { schema: Record<string, unknown> } }).format;
    const items = (
      (format.schema.properties as Record<string, Record<string, unknown>>).slots as Record<string, unknown>
    ).items as Record<string, unknown>;
    expect(items.additionalProperties).toBe(false);
  });

  it('parses the JSON body of the text blocks', async () => {
    const r = recorder(fixture('claude/structured-turn.json'));
    const p = createClaudeProvider({
      apiKey: SENTINEL_KEY,
      model: 'claude-opus-5',
      client: r.client,
      log: recordingLogger().logger,
    });
    const usage: Array<{ inputTokens: number; outputTokens: number }> = [];
    const out = await p.structured<{ category: string }>(HISTORY, SCHEMA, opts({ onUsage: (u) => usage.push(u) }));
    expect(out.category).toBe('schedule_candidate');
    expect(usage).toEqual([{ inputTokens: 900, outputTokens: 40 }]);
  });

  it('throws bad_output on a refusal turn', async () => {
    const r = recorder(fixture('claude/refusal-turn.json'));
    const p = createClaudeProvider({
      apiKey: SENTINEL_KEY,
      model: 'claude-opus-5',
      client: r.client,
      log: recordingLogger().logger,
    });
    await expect(p.structured(HISTORY, SCHEMA, opts())).rejects.toMatchObject({
      code: 'bad_output',
      message: 'bad_output',
    });
  });

  it('throws bad_output on a truncated turn and on unparsable text', async () => {
    const truncated = recorder({ content: [{ type: 'text', text: '{"catego' }], stop_reason: 'max_tokens' });
    const p1 = createClaudeProvider({
      apiKey: SENTINEL_KEY,
      model: 'claude-opus-5',
      client: truncated.client,
      log: recordingLogger().logger,
    });
    await expect(p1.structured(HISTORY, SCHEMA, opts())).rejects.toMatchObject({ code: 'bad_output' });

    const garbage = recorder({ content: [{ type: 'text', text: 'not json' }], stop_reason: 'end_turn' });
    const p2 = createClaudeProvider({
      apiKey: SENTINEL_KEY,
      model: 'claude-opus-5',
      client: garbage.client,
      log: recordingLogger().logger,
    });
    await expect(p2.structured(HISTORY, SCHEMA, opts())).rejects.toMatchObject({ code: 'bad_output' });
  });
});

describe('effort branch', () => {
  it("sets output_config.effort:'low' on every model except claude-haiku-4-5", () => {
    for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1']) {
      expect((buildChatRequest(model, HISTORY, TOOLS, 2048).output_config as Record<string, unknown>).effort).toBe(
        'low',
      );
    }
    expect(buildChatRequest('claude-haiku-4-5', HISTORY, TOOLS, 2048)).not.toHaveProperty('output_config');
    expect(buildChatRequest('claude-haiku-4-5-20251001', HISTORY, TOOLS, 2048)).not.toHaveProperty('output_config');
    const s = buildStructuredRequest('claude-haiku-4-5', HISTORY, SCHEMA, 2048);
    expect(s.output_config).toEqual({ format: { type: 'json_schema', schema: toClaudeSchema(SCHEMA) } });
  });
});

describe('chat() request (S3)', () => {
  it('sends tools + tool_choice auto in a deterministic order and no output format', () => {
    const req = buildChatRequest('claude-opus-5', HISTORY, TOOLS, 2048);
    expect(req.tool_choice).toEqual({ type: 'auto' });
    expect((req.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['get_freebusy', 'list_events']);
    expect((req.output_config as Record<string, unknown>).format).toBeUndefined();
    for (const forbidden of ['temperature', 'top_p', 'top_k', 'thinking', 'budget_tokens', 'mcp_servers']) {
      expect(req).not.toHaveProperty(forbidden);
    }
  });

  it('builds a no-tool turn when tools is empty', () => {
    const req = buildChatRequest('claude-opus-5', HISTORY, [], 2048);
    expect(req).not.toHaveProperty('tools');
    expect(req).not.toHaveProperty('tool_choice');
  });

  it('caches the system prefix with one ephemeral block', () => {
    const req = buildChatRequest('claude-opus-5', HISTORY, TOOLS, 2048);
    expect(req.system).toEqual([
      { type: 'text', text: 'You are a scheduling assistant.', cache_control: { type: 'ephemeral' } },
    ]);
    expect(buildChatRequest('claude-opus-5', [{ role: 'user', content: 'hi' }], TOOLS, 2048)).not.toHaveProperty(
      'system',
    );
  });

  it('returns tool calls and replays the response content verbatim through providerData', async () => {
    const fx = fixture('claude/tool-use-turn.json');
    const r = recorder(fx);
    const p = createClaudeProvider({
      apiKey: SENTINEL_KEY,
      model: 'claude-opus-5',
      client: r.client,
      log: recordingLogger().logger,
    });
    const res = await p.chat(HISTORY, TOOLS, opts({ purpose: 'draft', maxOutputTokens: 2048 }));
    expect(res.stopReason).toBe('tool_use');
    expect(res.text).toBe('Checking the calendar.');
    expect(res.toolCalls).toEqual([
      {
        id: 'toolu_TESTONLY_01',
        name: 'list_events',
        input: { timeMin: '2026-09-24T06:00:00Z', timeMax: '2026-09-24T18:00:00Z' },
      },
    ]);
    expect(res.assistantMessage.providerData).toBe(fx.content);
    expect(res.usage).toEqual({ inputTokens: 1500, outputTokens: 120 });
  });

  it('never surfaces tool calls from a truncated turn', async () => {
    const fx = fixture('claude/tool-use-turn.json');
    const r = recorder({ ...fx, stop_reason: 'max_tokens' });
    const p = createClaudeProvider({
      apiKey: SENTINEL_KEY,
      model: 'claude-opus-5',
      client: r.client,
      log: recordingLogger().logger,
    });
    const res = await p.chat(HISTORY, TOOLS, opts());
    expect(res.stopReason).toBe('max_tokens');
    expect(res.toolCalls).toEqual([]);
  });
});

describe('history mapping', () => {
  it('replays an assistant turn from providerData unchanged', () => {
    const blocks = [
      { type: 'thinking', thinking: '', signature: 'sig_TESTONLY_aaa' },
      { type: 'text', text: 'hi' },
    ];
    const out = toClaudeMessages([{ role: 'assistant', content: 'hi', providerData: blocks }]);
    expect(out).toEqual([{ role: 'assistant', content: blocks }]);
    expect((out[0] as { content: unknown }).content).toBe(blocks);
  });

  it('rebuilds a foreign assistant turn from the neutral fields', () => {
    const out = toClaudeMessages([
      { role: 'assistant', content: 'hi', toolCalls: [{ id: 'x1', name: 'list_events', input: { a: 1 } }] },
    ]);
    expect(out).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 'x1', name: 'list_events', input: { a: 1 } },
        ],
      },
    ]);
  });

  it('puts ALL tool results of one turn in ONE user message', () => {
    const out = toClaudeMessages([
      {
        role: 'tool',
        results: [
          { toolCallId: 'a', name: 'list_events', content: '[]' },
          { toolCallId: 'b', name: 'create_event', content: 'not executed', isError: true },
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: '[]' },
        { type: 'tool_result', tool_use_id: 'b', content: 'not executed', is_error: true },
      ],
    });
  });

  it('drops system messages from the messages array', () => {
    expect(toClaudeMessages(HISTORY)).toEqual([{ role: 'user', content: 'MESSAGE-TEXT-PLACEHOLDER' }]);
  });
});

describe('stop-reason mapping', () => {
  it.each([
    ['end_turn', 'end'],
    ['stop_sequence', 'end'],
    ['tool_use', 'tool_use'],
    ['max_tokens', 'max_tokens'],
    ['refusal', 'refusal'],
    ['pause_turn', 'other'],
    [null, 'other'],
  ])('%s -> %s', (raw, expected) => {
    expect(mapStopReason(raw as string | null)).toBe(expected);
  });
});

describe('error mapping', () => {
  it.each([
    [401, {}, 'auth'],
    [403, {}, 'auth'],
    [402, {}, 'billing'],
    [404, {}, 'model_not_found'],
    [500, {}, 'overloaded'],
    [529, {}, 'overloaded'],
    [413, {}, 'bad_output'],
  ])('status %i -> %s', (status, extra, code) => {
    expect(mapClaudeError(apiError(status as number, extra as Record<string, unknown>)).code).toBe(code);
  });

  it('maps a 400 whose body mentions the credit balance to billing', () => {
    const e = Object.assign(new Error('x'), {
      status: 400,
      error: { error: { message: 'Your credit balance is too low' } },
    });
    expect(mapClaudeError(e).code).toBe('billing');
    expect(mapClaudeError(apiError(400)).code).toBe('bad_output');
  });

  it('maps 429 to rate_limited with retryAfterMs, and the spend cap to quota_daily', () => {
    const limited = Object.assign(new Error('x'), { status: 429, headers: new Headers({ 'retry-after': '30' }) });
    const mapped = mapClaudeError(limited);
    expect(mapped.code).toBe('rate_limited');
    expect(mapped.retryAfterMs).toBe(30_000);

    const spend = Object.assign(new Error('x'), {
      status: 429,
      error: { error: { details: { error_code: 'enforced_spend_limit_reached' } } },
    });
    expect(mapClaudeError(spend).code).toBe('quota_daily');
    expect(mapClaudeError(apiError(429)).retryAfterMs).toBeUndefined();
  });

  it('maps connection failures to network and aborts to aborted', () => {
    expect(mapClaudeError(Object.assign(new Error('x'), { name: 'APIConnectionError' })).code).toBe('network');
    expect(mapClaudeError(Object.assign(new Error('x'), { name: 'APIUserAbortError' })).code).toBe('aborted');
    const ac = new AbortController();
    ac.abort();
    expect(mapClaudeError(apiError(500), ac.signal).code).toBe('aborted');
  });

  it('passes an LlmError through unchanged', () => {
    const e = new LlmError('quota_daily');
    expect(mapClaudeError(e)).toBe(e);
  });

  it('surfaces the mapped code from chat() and logs no body', async () => {
    const rec = recordingLogger();
    const r = recorder(() => apiError(401));
    const p = createClaudeProvider({ apiKey: SENTINEL_KEY, model: 'claude-opus-5', client: r.client, log: rec.logger });
    await expect(p.chat(HISTORY, TOOLS, opts())).rejects.toMatchObject({ code: 'auth', message: 'auth' });
    expect(rec.lines.join('\n')).not.toContain('provider body');
  });
});

describe('validate()', () => {
  it('uses models.retrieve and returns the display name', async () => {
    const r = recorder({ id: 'claude-opus-5', display_name: 'Claude Opus 5' });
    const p = createClaudeProvider({
      apiKey: SENTINEL_KEY,
      model: 'claude-opus-5',
      client: r.client,
      log: recordingLogger().logger,
    });
    await expect(p.validate(new AbortController().signal)).resolves.toEqual({ ok: true, model: 'Claude Opus 5' });
    expect(r.retrieved).toEqual(['claude-opus-5']);
  });

  it('falls back to the configured id when the response carries no names', async () => {
    const r = recorder({});
    const p = createClaudeProvider({
      apiKey: SENTINEL_KEY,
      model: 'claude-opus-5',
      client: r.client,
      log: recordingLogger().logger,
    });
    await expect(p.validate(new AbortController().signal)).resolves.toEqual({ ok: true, model: 'claude-opus-5' });
  });

  it('reports a ProviderErrorCode instead of throwing', async () => {
    const r = recorder(() => apiError(404));
    const p = createClaudeProvider({
      apiKey: SENTINEL_KEY,
      model: 'claude-gone-9',
      client: r.client,
      log: recordingLogger().logger,
    });
    await expect(p.validate(new AbortController().signal)).resolves.toEqual({ ok: false, reason: 'model_not_found' });
  });
});

describe('listClaudeModels()', () => {
  it('returns the LIVE list only - no preset is injected', async () => {
    const r = recorder(fixture('claude/models-list.json'));
    const out = await listClaudeModels({ apiKey: SENTINEL_KEY, client: r.client });
    expect(out).toEqual([
      { id: 'claude-opus-5', displayName: 'Claude Opus 5' },
      { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' },
      { id: 'claude-testonly-9', displayName: 'Claude TestOnly 9' },
    ]);
    expect(out.some((m) => m.id === 'claude-haiku-4-5')).toBe(false);
  });

  it('accepts a bare array page and falls back to the id as display name', async () => {
    const r = recorder([{ id: 'claude-opus-5' }, { notAModel: true }]);
    await expect(listClaudeModels({ apiKey: SENTINEL_KEY, client: r.client })).resolves.toEqual([
      { id: 'claude-opus-5', displayName: 'claude-opus-5' },
    ]);
  });

  it('returns [] for an unknown page shape and maps transport errors', async () => {
    await expect(listClaudeModels({ apiKey: SENTINEL_KEY, client: recorder({ nope: 1 }).client })).resolves.toEqual([]);
    await expect(
      listClaudeModels({ apiKey: SENTINEL_KEY, client: recorder(() => apiError(401)).client }),
    ).rejects.toMatchObject({ code: 'auth' });
  });
});

describe('dispose()', () => {
  it('drops the cached client', async () => {
    const r = recorder(fixture('claude/structured-turn.json'));
    const p = createClaudeProvider({
      apiKey: SENTINEL_KEY,
      model: 'claude-opus-5',
      client: r.client,
      log: recordingLogger().logger,
    });
    await p.structured(HISTORY, SCHEMA, opts());
    expect(hoisted.ctorCalls).toHaveLength(0);
    await p.dispose();
    // After dispose the injected double is gone, so the next call constructs a real client with the binding constants.
    await expect(p.structured(HISTORY, SCHEMA, opts())).rejects.toBeInstanceOf(LlmError);
    expect(hoisted.ctorCalls).toEqual([claudeClientOptions(SENTINEL_KEY)]);
  });
});

describe('the key never reaches a log line (sentinel)', () => {
  it('holds across a successful turn, a failed turn and validate()', async () => {
    const rec = recordingLogger();
    const ok = recorder(fixture('claude/tool-use-turn.json'));
    const p = createClaudeProvider({
      apiKey: SENTINEL_KEY,
      model: 'claude-opus-5',
      client: ok.client,
      log: rec.logger,
    });
    await p.chat(HISTORY, TOOLS, opts());
    await p.validate(new AbortController().signal);

    const bad = recorder(() => apiError(429, { headers: new Headers({ 'retry-after': '1' }) }));
    const p2 = createClaudeProvider({
      apiKey: SENTINEL_KEY,
      model: 'claude-opus-5',
      client: bad.client,
      log: rec.logger,
    });
    await expect(p2.structured(HISTORY, SCHEMA, opts())).rejects.toBeInstanceOf(LlmError);
    await p2.validate(new AbortController().signal);

    const all = rec.lines.join('\n');
    expect(rec.lines.length).toBeGreaterThan(0);
    expect(all).not.toContain(SENTINEL_KEY);
    expect(all).not.toContain('TESTONLY');
    expect(all).not.toContain('MESSAGE-TEXT-PLACEHOLDER');
  });
});

describe('the source file never reaches for a banned feature', () => {
  it('has no tool runner, no MCP helper and no beta namespace (grep test)', () => {
    const src = readFileSync(fileURLToPath(new URL('./claude.ts', import.meta.url)), 'utf8');
    for (const banned of [
      'toolRunner',
      'mcpTools',
      'mcp_servers',
      'helpers/beta',
      'beta.messages',
      'dangerouslyAllowBrowser',
      'messages.stream',
    ]) {
      expect(src).not.toContain(banned);
    }
  });
});

describe('fixtures', () => {
  it('are all flagged unverified and carry only sentinel material', () => {
    for (const rel of [
      'claude/tool-use-turn.json',
      'claude/structured-turn.json',
      'claude/refusal-turn.json',
      'claude/models-list.json',
    ]) {
      const raw = readFileSync(fileURLToPath(new URL(`./__fixtures__/${rel}`, import.meta.url)), 'utf8');
      expect(JSON.parse(raw)._unverified).toBe(true);
      expect(raw).not.toMatch(/@s\.whatsapp\.net|@lid/);
    }
  });
});
