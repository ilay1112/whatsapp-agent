// src/main/llm/types.ts   CHANGE (complete v2 frozen block; replaces contracts.md section 9 block) - V2-W0-scaffold, frozen in Wave 1
import type {
  JsonSchemaLcd,
  ProviderId,
  ProviderLoop,
  EpochMs,
  CliProviderId,
  CliSandboxProof,
} from '../../shared/types';
import { type ProviderErrorCode } from '../../shared/errors';
import type { RunCtx, ToolGate } from '../agent/toolGate';
import type { ToolSpec } from '../agent/toolDefs';
export type { ProviderErrorCode, ProviderLoop };

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

/** [V2 ADD] A picture for V1 READ-IMAGE. Built ONLY by agent/readImage.ts (import-graph + purity test); S1/S3/S4 never emit one. */
export interface LlmImagePart {
  type: 'image';
  mime: 'image/jpeg' | 'image/png';
  base64: string;
}
/** [V2 ADD] The user turn: S1/S3/S4 keep passing a string; V1 passes [image, text] (image FIRST - the Claude CLI stdin line order, B19). */
export type LlmUserContent = string | Array<{ type: 'text'; text: string } | LlmImagePart>;

export type LlmMessage =
  | { role: 'system'; content: string } // only from agent/prompt.ts buildSystemPrompt()
  | { role: 'user'; content: LlmUserContent } // [V2 CHANGE] string -> LlmUserContent (widening)
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
  purpose: 'extract' | 'draft' | 'read_image'; // [V2 CHANGE] + read_image
  onUsage?: (u: LlmUsage) => void; // [C+] lets structured() report tokens for the runs table
  /** [V2 ADD] CLI providers report the run's own init proof here (runs.sandbox_ok / sandbox_json); in-process providers never call it. */
  onSandbox?: (p: CliSandboxProof) => void;
  /** [V2 ADD] CLI providers report rate_limit_event / agy /usage here (AppHealth.llm.quota). */
  onQuota?: (q: { resetsAt: EpochMs | null; usingOverage: boolean | null }) => void;
}

/** [V2 ADD] loop 'agentic' (claude_cli S3): the app-hosted loopback tool server IS the gate transport (B16). */
export interface AgenticRunInput {
  system: string; // verbatim S3 constant (byte-identical across providers, I4')
  user: string; // the nonce data block ; delivered on stdin, never argv (B26)
  specs: readonly ToolSpec[]; // = gate.exposedSpecs() of THIS run
  ctx: RunCtx; // budgets, handles, nonce, audit - the same object ToolGate.invoke() mutates
  gate: ToolGate;
  maxTurns: number; // LIMITS.draftTurnsWithTools + 1
  jsonSchema?: JsonSchemaLcd; // optional {reply} schema
}
export interface AgenticRunResult {
  text: string;
  structured?: unknown;
  toolCalls: number;
  blockedCalls: number; // gate strikes + CLI-side refusals (non-mcp__wca__ tool_use, permission_denials)
  sandboxOk: boolean; // the run's system/init proof passed (I11) ; false => the caller discards the output
  stopReason: 'end' | 'max_turns' | 'aborted' | 'killed' | 'bad_output';
  usage?: LlmUsage;
  rateLimit?: { resetsAt: EpochMs | null; usingOverage: boolean | null };
}

export interface LlmProvider {
  readonly id: ProviderId;
  readonly model: string; // model id (cloud) or GGUF file label (local) ; recorded in runs/proposals
  readonly loop: ProviderLoop; // [V2 ADD] = PROVIDER_LOOP[id]; draft.ts branches on it FIRST
  /** [V2 ADD] local: mmprojReady (projector file ready AND /props modalities.vision) ; claude / gemini / claude_cli: true ; antigravity_cli: false (v2.0). */
  readonly capabilities: { images: boolean };
  /** S1 (and V1): schema-constrained JSON, NO tools in the request. Returns the parsed JSON UNVALIDATED (caller runs zod). Throws LlmError.
   *  CLI providers: ONE job, --json-schema, no MCP server, --max-turns 1, init proof asserted before the first turn. */
  structured<T>(messages: LlmMessage[], schema: JsonSchemaLcd, opts: CallOpts): Promise<T>;
  /** S3 on loop 'turn': exactly ONE model turn, tool_choice auto, never executes tools. tools=[] => a no-tool turn. Throws LlmError.
   *  [V2] CLI providers throw LlmError('unsupported') (draft.ts never calls it for them). */
  chat(messages: LlmMessage[], tools: LlmTool[], opts: CallOpts): Promise<LlmResponse>;
  /** [V2 ADD] loop 'agentic' only (claude_cli). */
  runAgentic?(input: AgenticRunInput, opts: CallOpts): Promise<AgenticRunResult>;
  /** [V2] CLI: exe found + version floor + provider-start smoke init (haiku, 1-field schema, --max-turns 1) ; NO login probe here. */
  validate(signal: AbortSignal): Promise<{ ok: true; model: string } | { ok: false; reason: ProviderErrorCode }>;
  dispose(): Promise<void>; // [V2] CLI: kills the in-flight job
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
 *  Providers get NO MCP client, NO bridge client, NO Db. [V2] CLI providers get a CliRunner + CliLocator (llm/cli/**) and nothing else. */
export class ConsentRequiredError extends Error {
  constructor(public readonly kind: 'cloud_claude' | 'cloud_gemini' | 'cloud_claude_cli' | 'cloud_antigravity_cli') {
    super('consent_required');
  } // [V2 CHANGE]
}
export interface ProviderFactory {
  /** Returns the provider for settings.llm.provider. Cached until provider/model/key changes [V2: CLI cache key = id|model|exePath|version].
   *  Never falls back to another provider (A20). */
  get(): Promise<LlmProvider>;
  /** Cheap readiness check used by S0 (held/waiting_llm) - never starts llama-server, never spawns a CLI.
   *  [V2] CLI ids: exe found + version floor + consent current + last smoke/test init passed within 24 h (B12). */
  usable(): { ok: true } | { ok: false; code: import('../../shared/errors').ErrorCode };
  invalidate(): Promise<void>; // dispose + drop cache (provider switch, key change, quit) ; [V2] kills any in-flight job
}
/** [V2 ADD] factory.ts constants. [W0 refinement] C2 9 writes `export declare const SECRET_FOR: Record<ApiKeyProviderId, SecretName>` here.
 *  A `declare const` export does not exist at run time, and a value re-export would make this type-only module import llm/factory at run
 *  time (dragging the SDKs into every importer of LlmError), so the constant lives ONLY in llm/factory.ts with that exact type. */
export type CliProvider = LlmProvider & { readonly id: CliProviderId };
