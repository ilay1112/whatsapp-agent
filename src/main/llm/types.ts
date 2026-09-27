// src/main/llm/types.ts
import type { JsonSchemaLcd, ProviderId } from '../../shared/types';
import { type ProviderErrorCode } from '../../shared/errors';
export type { ProviderErrorCode };

export interface LlmTool {
  name: string;
  description: string;
  inputSchema: JsonSchemaLcd;
} // app-authored READ tools only
export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface LlmToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}
/** Aliases under the names used by the task brief. */
export type ToolDef = LlmTool;
export type ToolCall = LlmToolCall;
export type ToolResult = LlmToolResult;

export type LlmMessage =
  | { role: 'system'; content: string } // only from agent/prompt.ts buildSystemPrompt()
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[]; providerData?: unknown } // providerData = opaque verbatim replay (Claude content blocks / Gemini steps)
  | { role: 'tool'; results: LlmToolResult[] }; // ALL results of one assistant turn in ONE message

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}
export interface LlmResponse {
  text: string;
  toolCalls: LlmToolCall[];
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
  usage?: LlmUsage;
  assistantMessage: Extract<LlmMessage, { role: 'assistant' }>; // push this verbatim into the history
}
export interface CallOpts {
  signal: AbortSignal; // Pause / quit / wall-clock abort
  maxOutputTokens: number; // Claude adapter raises to >= 2048
  purpose: 'extract' | 'draft';
  onUsage?: (u: LlmUsage) => void; // [C+] lets structured() report tokens for the runs table
}

export interface LlmProvider {
  readonly id: ProviderId;
  readonly model: string; // model id (cloud) or GGUF file label (local) ; recorded in runs/proposals
  /** S1: schema-constrained JSON, NO tools in the request. Returns the parsed JSON UNVALIDATED (caller runs zod). Throws LlmError. */
  structured<T>(messages: LlmMessage[], schema: JsonSchemaLcd, opts: CallOpts): Promise<T>;
  /** S3: exactly ONE model turn, tool_choice auto, never executes tools. tools=[] => a no-tool turn. Throws LlmError. */
  chat(messages: LlmMessage[], tools: LlmTool[], opts: CallOpts): Promise<LlmResponse>;
  validate(signal: AbortSignal): Promise<{ ok: true; model: string } | { ok: false; reason: ProviderErrorCode }>;
  dispose(): Promise<void>;
}

export class LlmError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    public readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = 'LlmError';
  }
} // message === code on purpose: provider error bodies may echo prompt text and must never be logged

/** llm/factory.ts. Throws LlmError('not_ready') when the key/model is missing and ConsentRequiredError when the consent record is not current.
 *  Providers get NO MCP client, NO bridge client, NO Db. */
export class ConsentRequiredError extends Error {
  constructor(public readonly kind: 'cloud_claude' | 'cloud_gemini') {
    super('consent_required');
  }
}
export interface ProviderFactory {
  /** Returns the provider for settings.llm.provider. Cached until provider/model/key changes. Never falls back to another provider. */
  get(): Promise<LlmProvider>;
  /** Cheap readiness check used by S0 (held/waiting_llm) - never starts llama-server. */
  usable(): { ok: true } | { ok: false; code: import('../../shared/errors').ErrorCode };
  invalidate(): Promise<void>; // dispose + drop cache (provider switch, key change, quit)
}
