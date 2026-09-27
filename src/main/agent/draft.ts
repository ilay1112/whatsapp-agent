// src/main/agent/draft.ts - S3 DRAFT: bounded READ tool loop through ToolGate (owner W1-10).
// `provider.chat()` executes exactly ONE model turn and never runs a tool itself (CONTRACTS 9) - the loop lives here and every
// tool call goes through the gate, which re-builds the arguments from settings. Nothing in this file can write anywhere.
import { LIMITS } from '../../shared/types';
import {
  LlmError,
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

/** <= LIMITS.draftTurnsWithTools turns, <= LIMITS.draftToolCalls calls; tool results are replayed verbatim (providerData by identity). */
export async function runDraft(provider: LlmProvider, input: DraftInput): Promise<DraftOutcome> {
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
