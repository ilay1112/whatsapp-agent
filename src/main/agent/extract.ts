// src/main/agent/extract.ts - S1 EXTRACT: structured JSON, no tools, one repair retry (owner W1-10).
// The provider returns UNVALIDATED JSON (CONTRACTS section 9); this module is the only place that turns it into an `Extraction`.
import { EXTRACTION_JSON_SCHEMA, ExtractionSchema, type Extraction } from '../../shared/schemas';
import { LlmError, type LlmProvider, type LlmMessage, type LlmUsage } from '../llm/types';
import type { ProviderErrorCode } from '../../shared/errors';

export interface ExtractInput {
  systemPrompt: string; // agent/prompt.ts
  userMessage: string; // agent/contextBuilder.ts (nonce data block)
  signal: AbortSignal;
  maxOutputTokens: number;
  onUsage?: (u: LlmUsage) => void;
}
export type ExtractOutcome =
  { ok: true; extraction: Extraction; repaired: boolean } | { ok: false; reason: 'bad_output' | ProviderErrorCode };

/** PIPELINE 4.1. Constant: it is appended as a `user` turn, so it never touches the cached system prefix. */
export const REPAIR_MESSAGE = 'Your previous output was not valid. Return only JSON matching the schema.';

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
    const parsed = ExtractionSchema.safeParse(raw);
    if (parsed.success) return { ok: true, extraction: parsed.data, repaired: attempt > 0 };
    // ONE repair turn (PIPELINE 4.1). The issue list is NOT logged or replayed: zod echoes the offending value.
    messages.push({ role: 'user', content: REPAIR_MESSAGE });
  }
  return { ok: false, reason: 'bad_output' };
}
