// src/main/llm/gemini.ts - Gemini provider over @google/genai (build-plan section 3; owner W1-06). S-SDK: `client` is injectable.
// Wire rules: ARCHITECTURE section 8 table, PIPELINE 10.2, CONTRACTS section 9, docs/research/gemini-provider.md.
// Interactions API, stateless, manual loop: exactly ONE model turn per chat(); tools are NEVER executed here.
// The stateless flag is set in exactly ONE function (`runInteraction`) and nowhere else in this file - there is a grep test for it.
import { GoogleGenAI } from '@google/genai';
import {
  LlmError,
  type CallOpts,
  type LlmMessage,
  type LlmProvider,
  type LlmResponse,
  type LlmTool,
  type LlmToolCall,
  type ProviderErrorCode,
} from './types';
import type { Logger } from '../deps';
import type { JsonSchemaLcd, ModelOption } from '../../shared/types';

/** CONTRACTS section 9: new GoogleGenAI({ apiKey, httpOptions: { baseUrl: GEMINI_BASE_URL } }) - never pass undefined for httpOptions.baseUrl. */
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
/** Wall-clock ceiling of PIPELINE 10.3 for a cloud turn. */
export const GEMINI_TIMEOUT_MS = 60_000;
/** PIPELINE 10.2: thinking_level 'low' on every request; sampling parameters are never sent. */
export const GEMINI_THINKING_LEVEL = 'low';

/** The slice of the SDK client the provider uses (typed loosely so a recording double can stand in). */
export interface GeminiClientLike {
  // [W1-06] added to the W0 seam: the provider uses the Interactions API (ARCH section 8, TESTS 5.3 row llm/gemini.ts).
  interactions: {
    create: (params: Record<string, unknown>, opts?: { signal?: AbortSignal; timeout_ms?: number }) => Promise<unknown>;
  };
  models: {
    generateContent: (params: Record<string, unknown>) => Promise<unknown>;
    get: (params: { model: string }) => Promise<unknown>;
    list: (params?: Record<string, unknown>) => Promise<unknown>;
  };
}
export interface GeminiProviderInput {
  apiKey: string;
  model: string;
  client?: GeminiClientLike; // S-SDK double; production constructs the real SDK client with GEMINI_BASE_URL
  log: Logger;
}

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------------------------------
// client construction
// ---------------------------------------------------------------------------------------------------------------------

/** The exact constructor bag of CONTRACTS section 9. GOOGLE_API_KEY / GEMINI_API_KEY / GOOGLE_GEMINI_BASE_URL are ignored by construction. */
export function geminiClientOptions(apiKey: string): { apiKey: string; httpOptions: { baseUrl: string } } {
  return { apiKey, httpOptions: { baseUrl: GEMINI_BASE_URL } };
}

export function createGoogleGenAiClient(apiKey: string): GeminiClientLike {
  return new GoogleGenAI(geminiClientOptions(apiKey)) as unknown as GeminiClientLike;
}

// ---------------------------------------------------------------------------------------------------------------------
// model ids
// ---------------------------------------------------------------------------------------------------------------------

/** ARCHITECTURE section 8 NEVER row: `-latest` aliases are hot-swapped by Google and are refused outright. */
export function isAliasModelId(model: string): boolean {
  return model.includes('-latest') || model.endsWith('latest');
}
function assertModelId(model: string): void {
  if (!model || isAliasModelId(model)) throw new LlmError('model_not_found');
}

// ---------------------------------------------------------------------------------------------------------------------
// request building (pure)
// ---------------------------------------------------------------------------------------------------------------------

/** Deep copy of an LCD schema. The LCD subset (shared/types JsonSchemaLcd) is already inside Gemini's supported keyword set. */
export function toGeminiSchema(schema: JsonSchemaLcd): Json {
  const node = schema as unknown as Json;
  const out: Json = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(v as Json).map(([pk, pv]) => [pk, toGeminiSchema(pv as JsonSchemaLcd)]),
      );
    } else if (k === 'items' && v && typeof v === 'object') {
      out.items = toGeminiSchema(v as JsonSchemaLcd);
    } else if (Array.isArray(v)) {
      out[k] = [...v];
    } else {
      out[k] = v;
    }
  }
  return out;
}

function systemInstruction(messages: readonly LlmMessage[]): string | undefined {
  const text = messages
    .filter((m): m is Extract<LlmMessage, { role: 'system' }> => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  return text ? text : undefined;
}

/** Neutral history -> Interactions `input` steps. Assistant turns are replayed verbatim (thought signatures, 4.4). */
export function toGeminiInput(messages: readonly LlmMessage[]): Json[] {
  const out: Json[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      out.push({ type: 'user_input', content: [{ type: 'text', text: m.content }] });
      continue;
    }
    if (m.role === 'assistant') {
      const replay = m.providerData;
      if (Array.isArray(replay)) {
        out.push(...(replay as Json[]));
      } else {
        if (m.content) out.push({ type: 'model_output', content: [{ type: 'text', text: m.content }] });
        for (const c of m.toolCalls ?? [])
          out.push({ type: 'function_call', id: c.id, name: c.name, arguments: c.input });
      }
      continue;
    }
    for (const r of m.results) {
      out.push({
        type: 'function_result',
        call_id: r.toolCallId,
        name: r.name,
        is_error: r.isError === true,
        result: [{ type: 'text', text: r.content }],
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// response parsing (pure)
// ---------------------------------------------------------------------------------------------------------------------

interface GeminiStep {
  type?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  content?: Array<{ type?: string; text?: string }>;
  error?: { code?: unknown; status?: unknown };
}
interface GeminiInteraction {
  status?: string;
  steps?: GeminiStep[];
  output_text?: string;
  usage?: { total_input_tokens?: number; total_output_tokens?: number };
  errors?: Array<{ code?: unknown; status?: unknown }>;
}

/** Generation codes that mean "the model was blocked" (research section 10). */
const BLOCK_CODES = new Set([
  'safety',
  'prohibited_content',
  'spii',
  'recitation',
  'language',
  'blocklist',
  'content_blocked',
]);
const TRUNCATION_CODES = new Set(['max_tokens', 'max_output_tokens', 'length']);

function interactionCodes(it: GeminiInteraction): string[] {
  const out: string[] = [];
  for (const e of it.errors ?? []) {
    for (const v of [e.code, e.status]) if (typeof v === 'string') out.push(v.toLowerCase());
  }
  for (const s of it.steps ?? []) {
    for (const v of [s.error?.code, s.error?.status]) if (typeof v === 'string') out.push(v.toLowerCase());
  }
  return out;
}

export function mapGeminiStopReason(it: GeminiInteraction): LlmResponse['stopReason'] {
  const codes = interactionCodes(it);
  if (codes.some((c) => BLOCK_CODES.has(c))) return 'refusal';
  if (codes.some((c) => TRUNCATION_CODES.has(c))) return 'max_tokens';
  if (it.status === 'incomplete') return 'max_tokens';
  if (it.status === 'requires_action') return 'tool_use';
  if (it.status === 'completed') return (it.steps ?? []).some((s) => s.type === 'function_call') ? 'tool_use' : 'end';
  return 'other';
}

function textOf(it: GeminiInteraction): string {
  if (typeof it.output_text === 'string' && it.output_text) return it.output_text;
  return (it.steps ?? [])
    .filter((s) => s.type === 'model_output')
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
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

function bodyCodeOf(e: unknown): string {
  const r = e as { error?: { code?: unknown; error?: { code?: unknown; status?: unknown } }; code?: unknown } | null;
  for (const v of [r?.error?.error?.code, r?.error?.error?.status, r?.error?.code, r?.code]) {
    if (typeof v === 'string') return v.toLowerCase();
  }
  return '';
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
  return name === 'APIUserAbortError' || name === 'AbortError' || name === 'RequestAbortedError';
}

/** Duck-typed mapping: the Interactions error classes are internal to the SDK and not exported as values (research section 10). */
export function mapGeminiError(e: unknown, signal?: AbortSignal): LlmError {
  if (e instanceof LlmError) return e;
  if (isAbort(e, signal)) return new LlmError('aborted');
  const status = statusOf(e);
  const code = bodyCodeOf(e);
  if (status === undefined) return new LlmError('network');
  if (status === 401 || status === 403) return new LlmError('auth');
  if (status === 400)
    return code === 'api_key_invalid' || code === 'authentication' ? new LlmError('auth') : new LlmError('bad_output');
  if (status === 402) return new LlmError('billing');
  if (status === 404) return new LlmError('model_not_found');
  if (status === 429)
    return code === 'quota_exceeded' ? new LlmError('quota_daily') : new LlmError('rate_limited', retryAfterMsOf(e));
  if (status === 499) return new LlmError('aborted');
  if (status >= 500) return new LlmError('overloaded');
  return new LlmError('bad_output');
}

// ---------------------------------------------------------------------------------------------------------------------
// the single stateless call site
// ---------------------------------------------------------------------------------------------------------------------

/** The ONLY function in this file that talks to interactions.create, and therefore the only place the stateless flag is set
 *  (ARCHITECTURE A20 / section 8). Stateless also means no interaction id is ever carried over between turns and nothing
 *  Google hosts is ever addressed as a tool: the whole history is re-sent on every call and the app owns the loop.
 *  gemini.test.ts greps this file for the three banned request keys of the ARCHITECTURE section 8 NEVER row. */
async function runInteraction(client: GeminiClientLike, body: Json, signal: AbortSignal): Promise<GeminiInteraction> {
  const raw = await client.interactions.create({ ...body, store: false }, { signal, timeout_ms: GEMINI_TIMEOUT_MS });
  return (raw ?? {}) as GeminiInteraction;
}

// ---------------------------------------------------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------------------------------------------------

export function createGeminiProvider(input: GeminiProviderInput): LlmProvider {
  const { apiKey, model } = input;
  assertModelId(model);
  const log = input.log.child('llm.gemini');
  let client: GeminiClientLike | null = input.client ?? null;
  const sdk = (): GeminiClientLike => (client ??= createGoogleGenAiClient(apiKey));

  const call = async (body: Json, opts: CallOpts): Promise<GeminiInteraction> => {
    let it: GeminiInteraction;
    try {
      it = await runInteraction(sdk(), body, opts.signal);
    } catch (e) {
      const mapped = mapGeminiError(e, opts.signal);
      log.warn('llm.request.failed', { code: mapped.code, status: statusOf(e) ?? null });
      throw mapped;
    }
    opts.onUsage?.({
      inputTokens: it.usage?.total_input_tokens ?? 0,
      outputTokens: it.usage?.total_output_tokens ?? 0,
    });
    if (it.status === 'budget_exceeded') {
      log.warn('llm.request.budget', {});
      throw new LlmError('quota_daily');
    }
    if (it.status === 'failed' || it.status === 'cancelled') {
      log.warn('llm.request.unusable', { status: it.status });
      throw new LlmError(it.status === 'cancelled' ? 'aborted' : 'bad_output');
    }
    return it;
  };

  return {
    id: 'gemini',
    model,

    async structured<T>(messages: LlmMessage[], schema: JsonSchemaLcd, opts: CallOpts): Promise<T> {
      const system = systemInstruction(messages);
      const it = await call(
        {
          model,
          input: toGeminiInput(messages),
          ...(system ? { system_instruction: system } : {}),
          response_format: { type: 'text', mime_type: 'application/json', schema: toGeminiSchema(schema) },
          generation_config: { thinking_level: GEMINI_THINKING_LEVEL, max_output_tokens: opts.maxOutputTokens },
        },
        opts,
      );
      const stop = mapGeminiStopReason(it);
      if (stop === 'refusal' || stop === 'max_tokens') {
        log.warn('llm.structured.unusable', { stop });
        throw new LlmError('bad_output');
      }
      try {
        return JSON.parse(textOf(it)) as T;
      } catch {
        log.warn('llm.structured.unparsable', { stop });
        throw new LlmError('bad_output');
      }
    },

    async chat(messages: LlmMessage[], tools: LlmTool[], opts: CallOpts): Promise<LlmResponse> {
      const system = systemInstruction(messages);
      const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const known = new Set(sorted.map((t) => t.name));
      const it = await call(
        {
          model,
          input: toGeminiInput(messages),
          ...(system ? { system_instruction: system } : {}),
          ...(sorted.length
            ? {
                tools: sorted.map((t) => ({
                  type: 'function',
                  name: t.name,
                  description: t.description,
                  parameters: toGeminiSchema(t.inputSchema),
                })),
              }
            : {}),
          generation_config: {
            thinking_level: GEMINI_THINKING_LEVEL,
            max_output_tokens: opts.maxOutputTokens,
            ...(sorted.length ? { tool_choice: 'auto' } : {}),
          },
        },
        opts,
      );
      const steps = it.steps ?? [];
      const stopReason = mapGeminiStopReason(it);
      const text = textOf(it);
      const toolCalls: LlmToolCall[] = [];
      if (stopReason === 'tool_use') {
        for (const s of steps) {
          if (s.type !== 'function_call') continue;
          // Never trust function_call.name: a name outside this request's tool map is a protocol violation.
          if (typeof s.name !== 'string' || !known.has(s.name) || typeof s.id !== 'string') {
            log.warn('llm.chat.unexpectedTool', {});
            throw new LlmError('bad_output');
          }
          toolCalls.push({ id: s.id, name: s.name, input: (s.arguments ?? {}) as Record<string, unknown> });
        }
      }
      return {
        text,
        toolCalls,
        stopReason,
        usage: { inputTokens: it.usage?.total_input_tokens ?? 0, outputTokens: it.usage?.total_output_tokens ?? 0 },
        // providerData = the raw steps array (thought signatures), replayed verbatim on the next turn.
        assistantMessage: { role: 'assistant', content: text, toolCalls, providerData: steps },
      };
    },

    async validate(
      signal: AbortSignal,
    ): Promise<{ ok: true; model: string } | { ok: false; reason: ProviderErrorCode }> {
      try {
        const option = await getGeminiModel({ apiKey, model, client: sdk(), signal });
        log.info('llm.validate.ok', {});
        return { ok: true, model: option.displayName };
      } catch (e) {
        const mapped = mapGeminiError(e, signal);
        log.warn('llm.validate.failed', { code: mapped.code });
        return { ok: false, reason: mapped.code };
      }
    },

    async dispose(): Promise<void> {
      client = null;
    },
  };
}

function modelId(name: unknown, fallback: string): string {
  return typeof name === 'string' && name ? name.replace(/^models\//, '') : fallback;
}

/** Resolves a model id (never a '-latest' alias) via models.get; throws LlmError('model_not_found' | 'auth' | ...). */
export async function getGeminiModel(inputArg: {
  apiKey: string;
  model: string;
  client?: GeminiClientLike;
  signal?: AbortSignal;
}): Promise<ModelOption> {
  assertModelId(inputArg.model);
  const client = inputArg.client ?? createGoogleGenAiClient(inputArg.apiKey);
  try {
    const raw = (await client.models.get({ model: inputArg.model })) as {
      name?: unknown;
      displayName?: unknown;
    } | null;
    const id = modelId(raw?.name, inputArg.model);
    return { id, displayName: typeof raw?.displayName === 'string' && raw.displayName ? raw.displayName : id };
  } catch (e) {
    throw mapGeminiError(e, inputArg.signal);
  }
}

function modelRows(raw: unknown): Array<{ name?: unknown; displayName?: unknown }> {
  if (Array.isArray(raw)) return raw as Array<{ name?: unknown; displayName?: unknown }>;
  const rec = raw as { models?: unknown; pageInternal?: unknown } | null;
  for (const v of [rec?.models, rec?.pageInternal])
    if (Array.isArray(v)) return v as Array<{ name?: unknown; displayName?: unknown }>;
  return [];
}

/** llm:listModels for 'gemini'. Alias ids (`-latest`) are filtered out: they are never offered in the dropdown. */
export async function listGeminiModels(inputArg: {
  apiKey: string;
  client?: GeminiClientLike;
  signal?: AbortSignal;
}): Promise<ModelOption[]> {
  const client = inputArg.client ?? createGoogleGenAiClient(inputArg.apiKey);
  try {
    const raw = await client.models.list({ config: { pageSize: 100 } });
    return modelRows(raw)
      .map((m) => {
        const id = modelId(m.name, '');
        return { id, displayName: typeof m.displayName === 'string' && m.displayName ? m.displayName : id };
      })
      .filter((m) => m.id !== '' && !isAliasModelId(m.id));
  } catch (e) {
    throw mapGeminiError(e, inputArg.signal);
  }
}
