// src/main/agent/draft.ts - S3 DRAFT: bounded READ tool loop through ToolGate (v1 owner W1-10; v2 three loops: V2-W1-06-claude-cli).
// `provider.chat()` executes exactly ONE model turn and never runs a tool itself (CONTRACTS 9) - the loop lives here and every
// tool call goes through the gate, which re-builds the arguments from settings. Nothing in this file can write anywhere.
import { z } from 'zod';
import { LIMITS, type CliSandboxProof, type JsonSchemaLcd } from '../../shared/types';
import {
  LlmError,
  type AgenticRunResult,
  type LlmMessage,
  type LlmProvider,
  type LlmResponse,
  type LlmTool,
  type LlmToolResult,
  type LlmUsage,
} from '../llm/types';
import { stripInvisible } from './sanitize';
import type { RunCtx, ToolGate } from './toolGate';
import type { ProviderErrorCode } from '../../shared/errors';

export interface DraftInput {
  messages: LlmMessage[]; // system + user (data block) ; assistant/tool turns are appended here verbatim
  ctx: RunCtx;
  gate: ToolGate;
  maxOutputTokens: number;
  wallClockMs: number; // LIMITS.draftWallClockCloudMs | draftWallClockLocalMs
  onUsage?: (u: LlmUsage) => void;
  /** [V2, additive] a CLI run reports its init proof here (runs.sandbox_ok / sandbox_json); forwarded into CallOpts on the agentic
   *  and prefetch loops. The turn loop (in-process providers) never has one. */
  onSandbox?: (p: CliSandboxProof) => void;
}
export type DraftOutcome =
  | { ok: true; text: string; toolCalls: number; blockedToolCalls: number; manipulation: boolean }
  | { ok: false; reason: 'aborted_manipulation' | 'max_turns' | ProviderErrorCode; blockedToolCalls: number };

/** Turns whose tool calls are NEVER executed (PIPELINE 6.3): a truncated or refused turn is not a decision. */
const NON_EXECUTABLE_STOP_REASONS: ReadonlySet<LlmResponse['stopReason']> = new Set(['max_tokens', 'refusal']);

/** A leading label a chatty model likes to prepend. Anchored, case-insensitive. */
const LEADING_LABEL_RE = /^\s*(?:draft|reply|response|answer|תשובה|טיוטה)\s*:\s*/i;
/** Matching wrapping quotes (straight, curly, guillemets, Hebrew gershayim) around the WHOLE text. */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['«', '»'],
  ['״', '״'],
];

/** PIPELINE 6.3: trim, strip a "Draft:"-style label and wrapping quotes, strip invisible/bidi characters, cap 600 chars. Pure. */
export function cleanDraft(raw: string): string {
  let text = stripInvisible(raw).trim();
  // A label and quotes can nest (`Draft: "..."`), so peel until nothing changes; the string shrinks every round.
  for (;;) {
    const before = text;
    text = text.replace(LEADING_LABEL_RE, '').trim();
    for (const [open, close] of QUOTE_PAIRS) {
      if (text.length > open.length + close.length - 1 && text.startsWith(open) && text.endsWith(close)) {
        text = text.slice(open.length, text.length - close.length).trim();
        break;
      }
    }
    if (text === before) break;
  }
  return text.length > LIMITS.draftChars ? text.slice(0, LIMITS.draftChars).trimEnd() : text;
}

/** [V2, P2 8.4] The constant `{reply}` schema of the `prefetch` loop (antigravity_cli): one no-tool structured() call. */
export const DRAFT_REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { reply: { type: 'string' } },
  required: ['reply'],
} as const satisfies JsonSchemaLcd;
const DraftReplySchema = z.strictObject({ reply: z.string() });

/** The verbatim S3 system constant and the nonce data block of `input.messages` (a CLI run gets them as argv / stdin, B26). */
function splitDraftMessages(messages: readonly LlmMessage[]): { system: string; user: string } {
  let system = '';
  const users: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') system = system.length === 0 ? m.content : `${system}\n\n${m.content}`;
    else if (m.role === 'user')
      users.push(
        typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n'),
      );
  }
  return { system, user: users.join('\n') };
}

/**
 * S3 for every provider (B15): `draft.ts` is the only pipeline file that branches on `provider.loop`, and it does so FIRST.
 * `turn` = the v1 loop below; `agentic` = `provider.runAgentic()` (claude_cli: the provider starts the per-run loopback tool server over
 * THIS gate + RunCtx and closes it in the same finally as the job); `prefetch` = app-side prefetch inlined + one no-tool structured().
 * Same DraftOutcome, cleanDraft(), blockedCallsAbort -> manipulation for all loops; a run without its sandbox proof is never a draft.
 */
export async function runDraft(provider: LlmProvider, input: DraftInput): Promise<DraftOutcome> {
  if (provider.loop === 'agentic') return runAgenticDraft(provider, input);
  if (provider.loop === 'prefetch') return runPrefetchDraft(provider, input);
  return runTurnDraft(provider, input);
}

/** loop 'agentic' (claude_cli, B16): the CLI runs the turns; every tools/call arrives at the tool server and goes through gate.invoke(ctx). */
async function runAgenticDraft(provider: LlmProvider, input: DraftInput): Promise<DraftOutcome> {
  const { ctx, gate } = input;
  // The CLI job carries its own 120 s wall clock (LIMITS.cliWallClockDraftMs); the draft guard must not cut it shorter.
  const signal = AbortSignal.any([
    ctx.signal,
    AbortSignal.timeout(Math.max(1, input.wallClockMs, LIMITS.cliWallClockDraftMs)),
  ]);
  const blockedNow = (): number => ctx.blockedCalls;
  if (!provider.runAgentic) return { ok: false, reason: 'unsupported', blockedToolCalls: 0 };
  if (signal.aborted) return { ok: false, reason: 'aborted', blockedToolCalls: 0 };
  const { system, user } = splitDraftMessages(input.messages);
  let res: AgenticRunResult;
  try {
    res = await provider.runAgentic(
      { system, user, specs: gate.exposedSpecs(), ctx, gate, maxTurns: LIMITS.draftTurnsWithTools + 1 },
      {
        signal,
        maxOutputTokens: input.maxOutputTokens,
        purpose: 'draft',
        ...(input.onUsage ? { onUsage: input.onUsage } : {}),
        ...(input.onSandbox ? { onSandbox: input.onSandbox } : {}),
      },
    );
  } catch (e) {
    if (e instanceof LlmError) return { ok: false, reason: e.code, blockedToolCalls: blockedNow() };
    if (signal.aborted) return { ok: false, reason: 'aborted', blockedToolCalls: blockedNow() };
    throw e;
  }
  const blocked = Math.max(res.blockedCalls, ctx.blockedCalls);
  // I11: no proof => the output is discarded, whatever it says (CLI_TOOLSET_MISMATCH).
  if (!res.sandboxOk) return { ok: false, reason: 'sandbox', blockedToolCalls: blocked };
  if (ctx.blockedCalls >= LIMITS.blockedCallsAbort)
    return { ok: false, reason: 'aborted_manipulation', blockedToolCalls: blocked };
  if (res.stopReason === 'aborted') return { ok: false, reason: 'aborted', blockedToolCalls: blocked };
  const text = cleanDraft(res.text);
  // A run that ended at max_turns (or otherwise) without text is a bad output - there is no forced final no-tool turn (P2 8.4).
  if (text === '') return { ok: false, reason: 'max_turns', blockedToolCalls: blocked };
  return { ok: true, text, toolCalls: res.toolCalls, blockedToolCalls: blocked, manipulation: ctx.blockedCalls > 0 };
}

/** loop 'prefetch' (antigravity_cli, B14): no tools exist; the WhatsApp context is prefetched by the app (budget-free, same projection). */
async function runPrefetchDraft(provider: LlmProvider, input: DraftInput): Promise<DraftOutcome> {
  const { ctx, gate } = input;
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(1, input.wallClockMs))]);
  if (signal.aborted) return { ok: false, reason: 'aborted', blockedToolCalls: 0 };
  const { system, user } = splitDraftMessages(input.messages);
  // The free/busy of the proposed slot is already app_computed in the S3 data block (S2 prefetch, P2 7.3); the WhatsApp earlier
  // messages arrive here as their own nonce-wrapped block (gate.prefetchWaContext = the wa_get_chat_messages execute + projection).
  // The WhatsApp read surface is optional context: its failure never fails the draft.
  const wa = await Promise.resolve()
    .then(() => gate.prefetchWaContext(ctx))
    .catch((): null => null);
  let raw: unknown;
  try {
    raw = await provider.structured<unknown>(
      [
        { role: 'system', content: system },
        { role: 'user', content: wa === null ? user : `${user}\n${wa}` },
      ],
      DRAFT_REPLY_SCHEMA,
      {
        signal,
        maxOutputTokens: input.maxOutputTokens,
        purpose: 'draft',
        ...(input.onUsage ? { onUsage: input.onUsage } : {}),
        ...(input.onSandbox ? { onSandbox: input.onSandbox } : {}),
      },
    );
  } catch (e) {
    if (e instanceof LlmError) return { ok: false, reason: e.code, blockedToolCalls: 0 };
    if (signal.aborted) return { ok: false, reason: 'aborted', blockedToolCalls: 0 };
    throw e;
  }
  const parsed = DraftReplySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'bad_output', blockedToolCalls: 0 };
  const text = cleanDraft(parsed.data.reply);
  if (text === '') return { ok: false, reason: 'bad_output', blockedToolCalls: 0 };
  return { ok: true, text, toolCalls: 0, blockedToolCalls: 0, manipulation: false };
}

/** loop 'turn' (v1): <= LIMITS.draftTurnsWithTools turns, <= LIMITS.draftToolCalls calls; tool results are replayed verbatim. */
async function runTurnDraft(provider: LlmProvider, input: DraftInput): Promise<DraftOutcome> {
  const { ctx, gate } = input;
  // The wall clock is a hard second guard: the orchestrator already arms one on the injected Clock (virtual in tests) and
  // folds it into ctx.signal, but a draft run must never outlive its budget because one timer was forgotten.
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(1, input.wallClockMs))]);
  const opts = {
    signal,
    maxOutputTokens: input.maxOutputTokens,
    purpose: 'draft' as const,
    ...(input.onUsage ? { onUsage: input.onUsage } : {}),
  };
  const history: LlmMessage[] = [...input.messages];
  let executed = 0;
  let blocked = 0; // every call the gate refused (budget / bad args / unknown name), reported on the runs row

  const finish = (text: string): DraftOutcome => {
    const cleaned = cleanDraft(text);
    if (cleaned === '') return { ok: false, reason: 'max_turns', blockedToolCalls: blocked };
    // A blocked STRIKE (an unknown / unexposed tool name) is the manipulation signal; a budget refusal is not.
    return {
      ok: true,
      text: cleaned,
      toolCalls: executed,
      blockedToolCalls: blocked,
      manipulation: ctx.blockedCalls > 0,
    };
  };

  type TurnResult = { ok: true; value: LlmResponse } | { ok: false; outcome: DraftOutcome };
  const turn = async (tools: LlmTool[]): Promise<TurnResult> => {
    if (signal.aborted) return { ok: false, outcome: { ok: false, reason: 'aborted', blockedToolCalls: blocked } };
    try {
      return { ok: true, value: await provider.chat(history, tools, opts) };
    } catch (e) {
      // LlmError.message === LlmError.code on purpose (CONTRACTS 9): a provider body may echo model output.
      if (e instanceof LlmError)
        return { ok: false, outcome: { ok: false, reason: e.code, blockedToolCalls: blocked } };
      if (signal.aborted) return { ok: false, outcome: { ok: false, reason: 'aborted', blockedToolCalls: blocked } };
      throw e; // an adapter bug, not a model failure
    }
  };

  for (let i = 0; i < LIMITS.draftTurnsWithTools; i++) {
    const step = await turn(gate.exposedTools());
    if (!step.ok) return step.outcome;
    const res = step.value;
    history.push(res.assistantMessage);

    // A truncated or refused turn is terminal for the tool loop: its calls are dropped, its text (if any) is the draft.
    if (NON_EXECUTABLE_STOP_REASONS.has(res.stopReason)) break;
    if (res.toolCalls.length === 0) return finish(res.text);

    const results: LlmToolResult[] = [];
    let abortRun = false;
    for (const call of res.toolCalls) {
      const outcome = await gate.invoke(call, ctx);
      results.push(outcome.result);
      if (outcome.verdict === 'executed') executed += 1;
      else if (outcome.verdict !== 'unavailable') blocked += 1;
      if (outcome.abortRun) {
        abortRun = true;
        break;
      }
    }
    history.push({ role: 'tool', results });
    if (abortRun) return { ok: false, reason: 'aborted_manipulation', blockedToolCalls: blocked };
  }

  // Final turn WITHOUT tools: the model is out of tool budget and must answer in words (PIPELINE 6.3 / ARCHITECTURE 14).
  const last = await turn([]);
  if (!last.ok) return last.outcome;
  history.push(last.value.assistantMessage);
  return finish(last.value.text);
}
