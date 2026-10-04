// src/main/llm/claude.ts - Claude provider over @anthropic-ai/sdk (build-plan section 3; owner W1-06). S-SDK: `client` is injectable.
// Wire rules: ARCHITECTURE section 8 table, PIPELINE 10.2, CONTRACTS section 9, docs/research/claude-provider.md.
// Manual loop only: exactly ONE model turn per chat(); tools are NEVER executed here (approval-first lives in the orchestrator).
import Anthropic from '@anthropic-ai/sdk';
import {
  LlmError,
  type CallOpts,
  type LlmMessage,
  type LlmProvider,
  type LlmResponse,
  type LlmTool,
  type LlmToolCall,
  type LlmUserContent,
  type ProviderErrorCode,
} from './types';
import type { Logger } from '../deps';
import { PROVIDER_LOOP, type JsonSchemaLcd, type ModelOption } from '../../shared/types';

/** CONTRACTS section 9: new Anthropic({ apiKey, baseURL: ANTHROPIC_BASE_URL, maxRetries: 2, timeout: 60_000 }) - never pass undefined for baseURL. */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
/** CONTRACTS section 9 binding constants - the SDK would otherwise read ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY from the environment. */
export const ANTHROPIC_MAX_RETRIES = 2;
export const ANTHROPIC_TIMEOUT_MS = 60_000;
/** PIPELINE 10.1: the Claude adapter raises every request to at least this many output tokens (thinking counts as output). */
export const CLAUDE_MIN_MAX_TOKENS = 2048;
/** ARCHITECTURE section 8: `output_config.effort` errors on claude-haiku-4-5 (and its dated alias); every other model gets 'low'. */
const NO_EFFORT_MODEL_PREFIX = 'claude-haiku-4-5';

/** The slice of the SDK client the provider uses (typed loosely so a recording double can stand in). */
export interface ClaudeClientLike {
  messages: { create: (params: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<unknown> };
  models: {
    list: (params?: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<unknown>;
    // [W1-06] added to the W0 seam: `validate` is models.retrieve (build-plan section 7, TESTS 5.3 row llm/claude.ts).
    retrieve: (modelId: string, params?: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<unknown>;
  };
}
export interface ClaudeProviderInput {
  apiKey: string;
  model: string;
  client?: ClaudeClientLike; // S-SDK double; production constructs the real SDK client with ANTHROPIC_BASE_URL
  log: Logger;
}

// ---------------------------------------------------------------------------------------------------------------------
// client construction
// ---------------------------------------------------------------------------------------------------------------------

/** The exact constructor bag of CONTRACTS section 9. Never `undefined` for baseURL, so a stray env var cannot redirect us. */
export function claudeClientOptions(apiKey: string): {
  apiKey: string;
  baseURL: string;
  maxRetries: number;
  timeout: number;
} {
  return { apiKey, baseURL: ANTHROPIC_BASE_URL, maxRetries: ANTHROPIC_MAX_RETRIES, timeout: ANTHROPIC_TIMEOUT_MS };
}

/** Production client. The key is always passed explicitly (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in the environment are ignored). */
export function createAnthropicClient(apiKey: string): ClaudeClientLike {
  return new Anthropic(claudeClientOptions(apiKey)) as unknown as ClaudeClientLike;
}

// ---------------------------------------------------------------------------------------------------------------------
// request building (pure)
// ---------------------------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** Deep copy that forces `additionalProperties:false` on every object node (structured-output requirement, research section 6). */
export function toClaudeSchema(schema: JsonSchemaLcd): Json {
  const node = schema as unknown as Json;
  const out: Json = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(v as Json).map(([pk, pv]) => [pk, toClaudeSchema(pv as JsonSchemaLcd)]),
      );
    } else if (k === 'items' && v && typeof v === 'object') {
      out.items = toClaudeSchema(v as JsonSchemaLcd);
    } else if (k === 'required' && Array.isArray(v)) {
      out.required = [...v];
    } else if (k === 'enum' && Array.isArray(v)) {
      out.enum = [...v];
    } else if (k !== 'additionalProperties') {
      out[k] = v;
    }
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

function systemBlocks(messages: readonly LlmMessage[]): Json[] | undefined {
  const text = messages
    .filter((m): m is Extract<LlmMessage, { role: 'system' }> => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  if (!text) return undefined;
  // cache_control on the last (only) system block covers tools + system (research section 8).
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

/** [V2] C2 9 binding wire mapping: an LlmImagePart becomes the native base64 image block, in the caller's order (image FIRST). */
export function toClaudeContent(parts: Exclude<LlmUserContent, string>): Json[] {
  return parts.map((part) =>
    part.type === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: part.mime, data: part.base64 } }
      : { type: 'text', text: part.text },
  );
}

/** [V2] true when any user turn carries a picture (V1 read_image only). */
export function hasImagePart(messages: readonly LlmMessage[]): boolean {
  return messages.some(
    (m) => m.role === 'user' && typeof m.content !== 'string' && m.content.some((p) => p.type === 'image'),
  );
}

/** Neutral history -> Anthropic `messages`. Assistant turns are replayed from `providerData` verbatim (thinking signatures, tool_use ids). */
export function toClaudeMessages(messages: readonly LlmMessage[]): Json[] {
  const out: Json[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      out.push({ role: 'user', content: typeof m.content === 'string' ? m.content : toClaudeContent(m.content) });
      continue;
    }
    if (m.role === 'assistant') {
      const replay = m.providerData;
      if (Array.isArray(replay)) {
        out.push({ role: 'assistant', content: replay });
      } else {
        const content: Json[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls ?? []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
        out.push({ role: 'assistant', content });
      }
      continue;
    }
    // ALL tool results of one assistant turn go into ONE user message (research section 4.3).
    out.push({
      role: 'user',
      content: m.results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.toolCallId,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      })),
    });
  }
  return out;
}

function effortField(model: string): Json {
  return model.startsWith(NO_EFFORT_MODEL_PREFIX) ? {} : { effort: 'low' };
}

/** S1: schema-constrained JSON, no `tools` key at all. */
export function buildStructuredRequest(
  model: string,
  messages: readonly LlmMessage[],
  schema: JsonSchemaLcd,
  maxOutputTokens: number,
): Json {
  const system = systemBlocks(messages);
  return {
    model,
    max_tokens: Math.max(maxOutputTokens, CLAUDE_MIN_MAX_TOKENS),
    ...(system ? { system } : {}),
    messages: toClaudeMessages(messages),
    output_config: { ...effortField(model), format: { type: 'json_schema', schema: toClaudeSchema(schema) } },
  };
}

/** S3: exactly one model turn with `tool_choice:{type:'auto'}` and no output format. `tools=[]` builds a no-tool turn. */
export function buildChatRequest(
  model: string,
  messages: readonly LlmMessage[],
  tools: readonly LlmTool[],
  maxOutputTokens: number,
): Json {
  const system = systemBlocks(messages);
  // Deterministic tool order keeps the prompt-cache prefix stable (research section 5.1).
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const effort = effortField(model);
  return {
    model,
    max_tokens: Math.max(maxOutputTokens, CLAUDE_MIN_MAX_TOKENS),
    ...(system ? { system } : {}),
    messages: toClaudeMessages(messages),
    ...(sorted.length
      ? {
          tools: sorted.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: toClaudeSchema(t.inputSchema),
          })),
          tool_choice: { type: 'auto' },
        }
      : {}),
    ...(Object.keys(effort).length ? { output_config: effort } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// response parsing (pure)
// ---------------------------------------------------------------------------------------------------------------------

interface ClaudeBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}
interface ClaudeMessageResponse {
  content?: ClaudeBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function mapStopReason(raw: string | null | undefined): LlmResponse['stopReason'] {
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

function textOf(blocks: readonly ClaudeBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

// ---------------------------------------------------------------------------------------------------------------------
// error mapping (pure) - LlmError.message === code; provider bodies are read but NEVER logged
// ---------------------------------------------------------------------------------------------------------------------

function statusOf(e: unknown): number | undefined {
  const r = e as { status?: unknown; statusCode?: unknown } | null;
  const s = r?.status ?? r?.statusCode;
  return typeof s === 'number' ? s : undefined;
}

function bodyTextOf(e: unknown): string {
  const r = e as { error?: { error?: { message?: unknown } }; message?: unknown } | null;
  const inner = r?.error?.error?.message;
  const parts = [typeof inner === 'string' ? inner : '', typeof r?.message === 'string' ? r.message : ''];
  return parts.join(' ').toLowerCase();
}

function errorCodeOf(e: unknown): string {
  const r = e as { error?: { error?: { details?: { error_code?: unknown } } } } | null;
  const c = r?.error?.error?.details?.error_code;
  return typeof c === 'string' ? c : '';
}

function retryAfterMsOf(e: unknown): number | undefined {
  const h = (e as { headers?: { get?: (n: string) => string | null } } | null)?.headers;
  const raw = typeof h?.get === 'function' ? h.get('retry-after') : null;
  const secs = raw === null || raw === undefined ? NaN : Number(raw);
  return Number.isFinite(secs) && secs >= 0 ? Math.round(secs * 1000) : undefined;
}

function isAbort(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'APIUserAbortError' || name === 'AbortError';
}

/** Maps an SDK / duck-typed error to a ProviderErrorCode (ARCHITECTURE section 8, research section 9). */
export function mapClaudeError(e: unknown, signal?: AbortSignal): LlmError {
  if (e instanceof LlmError) return e;
  if (isAbort(e, signal)) return new LlmError('aborted');
  const status = statusOf(e);
  const text = bodyTextOf(e);
  if (status === undefined) return new LlmError('network');
  if (status === 401 || status === 403) return new LlmError('auth');
  if (status === 402) return new LlmError('billing');
  if (status === 404) return new LlmError('model_not_found');
  if (status === 429) {
    if (errorCodeOf(e) === 'enforced_spend_limit_reached' || text.includes('spend limit'))
      return new LlmError('quota_daily');
    return new LlmError('rate_limited', retryAfterMsOf(e));
  }
  if (status >= 500) return new LlmError('overloaded');
  if (status === 400 && (text.includes('credit balance') || text.includes('billing'))) return new LlmError('billing');
  return new LlmError('bad_output');
}

// ---------------------------------------------------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------------------------------------------------

export function createClaudeProvider(input: ClaudeProviderInput): LlmProvider {
  const { apiKey, model } = input;
  const log = input.log.child('llm.claude');
  let client: ClaudeClientLike | null = input.client ?? null;
  const sdk = (): ClaudeClientLike => (client ??= createAnthropicClient(apiKey));

  const call = async (params: Json, signal: AbortSignal): Promise<ClaudeMessageResponse> => {
    try {
      return (await sdk().messages.create(params, { signal })) as ClaudeMessageResponse;
    } catch (e) {
      const mapped = mapClaudeError(e, signal);
      log.warn('llm.request.failed', { code: mapped.code, status: statusOf(e) ?? null });
      throw mapped;
    }
  };

  const reportUsage = (res: ClaudeMessageResponse, opts: CallOpts): { inputTokens: number; outputTokens: number } => {
    const usage = { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 };
    opts.onUsage?.(usage);
    return usage;
  };

  return {
    id: 'claude',
    model,
    loop: PROVIDER_LOOP.claude, // [V2 ADD]
    capabilities: { images: true }, // [V2 ADD] C2 9: native image block (V1 read_image), no tools on that request

    async structured<T>(messages: LlmMessage[], schema: JsonSchemaLcd, opts: CallOpts): Promise<T> {
      // [V2] a picture only on the V1 purpose (C2 9.1); the structured request never carries `tools` (I12).
      if (opts.purpose !== 'read_image' && hasImagePart(messages)) throw new LlmError('unsupported');
      const res = await call(buildStructuredRequest(model, messages, schema, opts.maxOutputTokens), opts.signal);
      reportUsage(res, opts);
      const stop = mapStopReason(res.stop_reason);
      if (stop === 'refusal' || stop === 'max_tokens') {
        log.warn('llm.structured.unusable', { stop });
        throw new LlmError('bad_output');
      }
      const text = textOf(res.content ?? []);
      try {
        return JSON.parse(text) as T;
      } catch {
        log.warn('llm.structured.unparsable', { stop });
        throw new LlmError('bad_output');
      }
    },

    async chat(messages: LlmMessage[], tools: LlmTool[], opts: CallOpts): Promise<LlmResponse> {
      if (hasImagePart(messages)) throw new LlmError('unsupported'); // [V2] C2 9.1: chat() never receives a picture
      const res = await call(buildChatRequest(model, messages, tools, opts.maxOutputTokens), opts.signal);
      const usage = reportUsage(res, opts);
      const blocks = res.content ?? [];
      const stopReason = mapStopReason(res.stop_reason);
      const text = textOf(blocks);
      // Never surface tool calls from a truncated or refused turn (research section 4.4).
      const toolCalls: LlmToolCall[] =
        stopReason === 'tool_use'
          ? blocks
              .filter((b) => b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string')
              .map((b) => ({
                id: b.id as string,
                name: b.name as string,
                input: (b.input ?? {}) as Record<string, unknown>,
              }))
          : [];
      return {
        text,
        toolCalls,
        stopReason,
        usage,
        // providerData = the response content array, replayed verbatim on the next turn.
        assistantMessage: { role: 'assistant', content: text, toolCalls, providerData: blocks },
      };
    },

    async validate(
      signal: AbortSignal,
    ): Promise<{ ok: true; model: string } | { ok: false; reason: ProviderErrorCode }> {
      try {
        const info = (await sdk().models.retrieve(model, undefined, { signal })) as {
          id?: string;
          display_name?: string;
        } | null;
        log.info('llm.validate.ok', {});
        return { ok: true, model: info?.display_name ?? info?.id ?? model };
      } catch (e) {
        const mapped = mapClaudeError(e, signal);
        log.warn('llm.validate.failed', { code: mapped.code });
        return { ok: false, reason: mapped.code };
      }
    },

    async dispose(): Promise<void> {
      client = null;
    },
  };
}

/** `models.list()` returns a paginated page in the real SDK and a plain object in a double; accept both. */
function modelRows(raw: unknown): Array<{ id?: unknown; display_name?: unknown }> {
  if (Array.isArray(raw)) return raw as Array<{ id?: unknown; display_name?: unknown }>;
  const data = (raw as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data as Array<{ id?: unknown; display_name?: unknown }>) : [];
}

/** llm:listModels for 'claude'. Throws LlmError on auth/network problems.
 *  Returns the LIVE list only - CLAUDE_MODEL_PRESETS are ordering hints the renderer intersects with this result. */
export async function listClaudeModels(inputArg: {
  apiKey: string;
  client?: ClaudeClientLike;
  signal?: AbortSignal;
}): Promise<ModelOption[]> {
  const client = inputArg.client ?? createAnthropicClient(inputArg.apiKey);
  try {
    const raw = await client.models.list({ limit: 100 }, { signal: inputArg.signal });
    return modelRows(raw)
      .filter((m): m is { id: string; display_name?: unknown } => typeof m.id === 'string')
      .map((m) => ({ id: m.id, displayName: typeof m.display_name === 'string' ? m.display_name : m.id }));
  } catch (e) {
    throw mapClaudeError(e, inputArg.signal);
  }
}
