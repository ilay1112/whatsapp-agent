// src/main/llm/local.ts - Local provider over llama-server's OpenAI-compatible API (build-plan section 3; owner W1-07). S-FETCH.
import type { CallOpts, LlmMessage, LlmProvider, LlmResponse, LlmTool, LlmToolCall, ProviderErrorCode } from './types';
import { LlmError } from './types';
import type { FetchFn, Logger } from '../deps';
import type { JsonSchemaLcd } from '../../shared/types';
import type { LlamaRuntime } from './local/llamaServer';

export interface LocalSampling {
  extract: { temperature: number }; // 0.1
  draft: { temperature: number; top_p: number; top_k: number }; // Gemma defaults 1.0 / 0.95 / 64
}
export const DEFAULT_LOCAL_SAMPLING: LocalSampling = {
  extract: { temperature: 0.1 },
  draft: { temperature: 1.0, top_p: 0.95, top_k: 64 },
};
export interface LocalProviderInput {
  runtime: LlamaRuntime; // lazy: ensureStarted() on first call
  modelLabel: string; // GGUF file label recorded in runs/proposals (never a path)
  sampling: LocalSampling;
  fetch: FetchFn;
  log: Logger;
}

/** The `model` field of an OpenAI request; llama-server serves exactly one model and ignores the value. */
export const LOCAL_WIRE_MODEL = 'local';
/** Name of the json_schema wrapper (`response_format.json_schema.name`). */
export const LOCAL_SCHEMA_NAME = 'extraction';

// ---------------------------------------------------------------------------------------------------------------------
// wire types (what llama-server speaks; nothing here is exported to the pipeline)
// ---------------------------------------------------------------------------------------------------------------------
interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}
interface WireMessage {
  role?: string;
  content?: string | null;
  tool_calls?: WireToolCall[];
}
interface WireChoice {
  message?: WireMessage;
  finish_reason?: string;
}
interface WireCompletion {
  choices?: WireChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

type WireRequestMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** LlmMessage[] -> OpenAI chat messages. One `role:'tool'` wire message PER result (CONTRACTS section 9). */
export function toWireMessages(messages: readonly LlmMessage[]): WireRequestMessage[] {
  const out: WireRequestMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'user') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const replay = m.providerData as WireMessage | undefined;
      if (replay !== undefined && typeof replay === 'object' && replay.role === 'assistant') {
        out.push({ role: 'assistant', content: replay.content ?? '', tool_calls: replay.tool_calls });
        continue;
      }
      const toolCalls = (m.toolCalls ?? []).map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      }));
      out.push({ role: 'assistant', content: m.content, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content });
  }
  return out;
}

/** LlmTool[] -> OpenAI function tools. The schema is passed through untouched (it is app-authored, LCD subset). */
export function toWireTools(
  tools: readonly LlmTool[],
): Array<{ type: 'function'; function: { name: string; description: string; parameters: JsonSchemaLcd } }> {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

export function mapHttpStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model_not_found';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'not_ready';
  if (status >= 500) return 'overloaded';
  if (status >= 400) return 'bad_output';
  return 'network';
}

export function mapFinishReason(reason: string | undefined, hasToolCalls: boolean): LlmResponse['stopReason'] {
  if (hasToolCalls) return 'tool_use';
  switch (reason) {
    case 'stop':
      return 'end';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

export function createLocalProvider(input: LocalProviderInput): LlmProvider {
  const log = input.log.child('llm.local');

  const start = async (): Promise<{ port: number; apiKey: string }> => {
    try {
      return await input.runtime.ensureStarted();
    } catch {
      // The runtime already recorded the precise ErrorCode in status(); the provider layer only knows "not usable yet".
      throw new LlmError('not_ready');
    }
  };

  const post = async (body: Record<string, unknown>, opts: CallOpts): Promise<WireCompletion> => {
    const { port, apiKey } = await start();
    let res: Response;
    try {
      res = await input.fetch(`http://127.0.0.1:${String(port)}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: opts.signal,
      });
    } catch (err) {
      throw new LlmError(isAbort(err) ? 'aborted' : 'network');
    }
    if (!res.ok) {
      // The body may echo prompt text, so it is read only to be discarded (CONTRACTS section 9).
      await res.text().catch(() => '');
      const code = mapHttpStatus(res.status);
      log.warn('llama_http_error', { status: res.status, code, purpose: opts.purpose });
      throw new LlmError(code);
    }
    try {
      return (await res.json()) as WireCompletion;
    } catch {
      throw new LlmError('bad_output');
    }
  };

  const reportUsage = (wire: WireCompletion, opts: CallOpts): void => {
    const usage = wire.usage;
    if (usage === undefined || opts.onUsage === undefined) return;
    opts.onUsage({ inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 });
  };

  return {
    id: 'local',
    model: input.modelLabel,

    async structured<T>(messages: LlmMessage[], schema: JsonSchemaLcd, opts: CallOpts): Promise<T> {
      // [R2] OpenAI form: llama-server b10964 reads response_format.json_schema.schema; a top-level `schema` gives NO grammar.
      const wire = await post(
        {
          model: LOCAL_WIRE_MODEL,
          messages: toWireMessages(messages),
          response_format: { type: 'json_schema', json_schema: { name: LOCAL_SCHEMA_NAME, strict: true, schema } },
          temperature: input.sampling.extract.temperature,
          max_tokens: opts.maxOutputTokens,
          stream: false,
          cache_prompt: true,
          chat_template_kwargs: { enable_thinking: false },
        },
        opts,
      );
      reportUsage(wire, opts);
      const content = wire.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content === '') throw new LlmError('bad_output');
      try {
        return JSON.parse(content) as T;
      } catch {
        throw new LlmError('bad_output');
      }
    },

    async chat(messages: LlmMessage[], tools: LlmTool[], opts: CallOpts): Promise<LlmResponse> {
      const wire = await post(
        {
          model: LOCAL_WIRE_MODEL,
          messages: toWireMessages(messages),
          ...(tools.length > 0 ? { tools: toWireTools(tools), tool_choice: 'auto', parallel_tool_calls: false } : {}),
          temperature: input.sampling.draft.temperature,
          top_p: input.sampling.draft.top_p,
          top_k: input.sampling.draft.top_k,
          max_tokens: opts.maxOutputTokens,
          stream: false,
          cache_prompt: true,
          chat_template_kwargs: { enable_thinking: false },
        },
        opts,
      );
      reportUsage(wire, opts);
      const choice = wire.choices?.[0];
      const message = choice?.message;
      if (message === undefined) throw new LlmError('bad_output');
      const text = typeof message.content === 'string' ? message.content : '';
      const toolCalls: LlmToolCall[] = [];
      for (const [i, raw] of (message.tool_calls ?? []).entries()) {
        const name = raw.function?.name;
        if (typeof name !== 'string' || name === '') throw new LlmError('bad_output');
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.function?.arguments ?? '{}');
        } catch {
          throw new LlmError('bad_output');
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new LlmError('bad_output');
        toolCalls.push({ id: raw.id ?? `call_${String(i)}`, name, input: parsed as Record<string, unknown> });
      }
      const stopReason = mapFinishReason(choice?.finish_reason, toolCalls.length > 0);
      return {
        text,
        toolCalls,
        stopReason,
        ...(wire.usage !== undefined
          ? { usage: { inputTokens: wire.usage.prompt_tokens ?? 0, outputTokens: wire.usage.completion_tokens ?? 0 } }
          : {}),
        assistantMessage: { role: 'assistant', content: text, toolCalls, providerData: message },
      };
    },

    async validate(
      signal: AbortSignal,
    ): Promise<{ ok: true; model: string } | { ok: false; reason: ProviderErrorCode }> {
      let port: number;
      let apiKey: string;
      try {
        ({ port, apiKey } = await input.runtime.ensureStarted());
      } catch {
        return { ok: false, reason: 'not_ready' };
      }
      try {
        const res = await input.fetch(`http://127.0.0.1:${String(port)}/health`, {
          headers: { authorization: `Bearer ${apiKey}` },
          redirect: 'error',
          signal,
        });
        if (res.status === 200) return { ok: true, model: input.modelLabel };
        return { ok: false, reason: mapHttpStatus(res.status) };
      } catch (err) {
        return { ok: false, reason: isAbort(err) ? 'aborted' : 'network' };
      }
    },

    async dispose(): Promise<void> {
      await input.runtime.stop();
    },
  };
}
