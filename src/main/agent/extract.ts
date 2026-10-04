// src/main/agent/extract.ts - S1 EXTRACT: structured JSON, no tools, one repair retry (v1 owner W1-10; v2 V2-W1-03-edit-pipeline).
// The provider returns UNVALIDATED JSON (CONTRACTS section 9); this module is the only place that turns it into an `Extraction`.
// [V2] The schema carries the four B20 fields (refersToExisting / change / changeConfidence / confidence) for EVERY provider; model output
// is always parsed with the STRICT ExtractionSchema (stored v1 rows are read by the repos with parseStoredExtraction - never here).
import { EXTRACTION_JSON_SCHEMA, ExtractionSchema, type Extraction } from '../../shared/schemas';
import { LlmError, type LlmProvider, type LlmMessage, type LlmUsage } from '../llm/types';
import type { ProviderErrorCode } from '../../shared/errors';
import type { CliSandboxProof } from '../../shared/types';

export interface ExtractInput {
  systemPrompt: string; // agent/prompt.ts
  userMessage: string; // agent/contextBuilder.ts (nonce data block)
  signal: AbortSignal;
  maxOutputTokens: number;
  onUsage?: (u: LlmUsage) => void;
  /** [V2] CLI providers report each job's init proof (runs.sandbox_ok / sandbox_json); in-process providers never call it. */
  onSandbox?: (p: CliSandboxProof) => void;
}
export type ExtractOutcome =
  { ok: true; extraction: Extraction; repaired: boolean } | { ok: false; reason: 'bad_output' | ProviderErrorCode };

/** PIPELINE 4.1. Constant: it is appended as a `user` turn, so it never touches the cached system prefix. */
export const REPAIR_MESSAGE = 'Your previous output was not valid. Return only JSON matching the schema.';

/**
 * [V2, B20 / P2 6.3] A CLI may hand back the JSON as TEXT wrapped in a markdown code fence. Exactly ONE leading fence (```` ``` ```` or
 * ```` ```json ````) and ONE trailing fence are removed - never two: a doubly fenced answer stays unparseable and goes to the repair turn,
 * so a model cannot smuggle a second document past the parser by nesting fences. Anything that is not a string is returned unchanged.
 */
export function stripOneCodeFence(text: string): string {
  let t = text.trim();
  const open = /^```[A-Za-z]*[ \t]*\r?\n?/.exec(t);
  if (open === null) return t;
  t = t.slice(open[0].length);
  const close = /\r?\n?```$/.exec(t);
  if (close === null) return text.trim(); // an opening fence without its closing fence is not a fenced document: leave it to the parser
  return t.slice(0, t.length - close[0].length).trim();
}

/** A structured answer that arrived as text (CLI fence-strip path): one fence stripped, then JSON.parse. Unparseable => undefined. */
function fromText(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(stripOneCodeFence(raw)) as unknown;
  } catch {
    return undefined; // not JSON => fails the zod parse below => ONE repair turn
  }
}

/** provider.structured() with EXTRACTION_JSON_SCHEMA, then ExtractionSchema.parse; one repair turn on failure. */
export async function runExtract(provider: LlmProvider, input: ExtractInput): Promise<ExtractOutcome> {
  const messages: LlmMessage[] = [
    { role: 'system', content: input.systemPrompt },
    { role: 'user', content: input.userMessage },
  ];
  const opts = {
    signal: input.signal,
    maxOutputTokens: input.maxOutputTokens,
    purpose: 'extract' as const,
    ...(input.onUsage ? { onUsage: input.onUsage } : {}),
    ...(input.onSandbox ? { onSandbox: input.onSandbox } : {}),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: unknown;
    try {
      raw = await provider.structured<unknown>(messages, EXTRACTION_JSON_SCHEMA, opts);
    } catch (e) {
      // LlmError.message === LlmError.code on purpose (CONTRACTS 9): a provider body may echo model output, so nothing
      // but the code ever leaves this catch.
      if (e instanceof LlmError) return { ok: false, reason: e.code };
      if (input.signal.aborted) return { ok: false, reason: 'aborted' };
      throw e; // a non-provider throw is a bug in the adapter, not a model failure: the orchestrator records INTERNAL
    }
    const parsed = ExtractionSchema.safeParse(fromText(raw));
    if (parsed.success) return { ok: true, extraction: parsed.data, repaired: attempt > 0 };
    // ONE repair turn (PIPELINE 4.1). The issue list is NOT logged or replayed: zod echoes the offending value.
    messages.push({ role: 'user', content: REPAIR_MESSAGE });
  }
  return { ok: false, reason: 'bad_output' };
}
