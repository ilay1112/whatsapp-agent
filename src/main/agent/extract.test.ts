// src/main/agent/extract.test.ts - S1 EXTRACT (TESTS 5.3 row `agent/extract.ts`: one repair retry then LLM_BAD_OUTPUT; owner W1-10).
import { describe, expect, it, vi } from 'vitest';
import { REPAIR_MESSAGE, runExtract } from './extract';
import {
  LlmError,
  type CallOpts,
  type LlmMessage,
  type LlmProvider,
  type LlmResponse,
  type LlmUsage,
} from '../llm/types';
import { EXTRACTION_JSON_SCHEMA, type Extraction } from '../../shared/schemas';
import type { JsonSchemaLcd, ProviderId } from '../../shared/types';

const VALID: Extraction = {
  intent: 'schedule_request',
  needsReply: true,
  title: 'coffee',
  dateKind: 'relative_days',
  isoDate: '',
  weekday: 0,
  weekOffset: 0,
  daysFromToday: 1,
  time24h: '17:00',
  timeAmbiguous: true,
  durationMin: 0,
  location: '',
  missing: ['duration', 'location'],
  suspicious: false,
};

/** A minimal LlmProvider whose `structured()` plays one scripted answer per call. */
function provider(
  answers: Array<unknown | Error>,
  opts: { id?: ProviderId } = {},
): LlmProvider & {
  calls: Array<{ messages: LlmMessage[]; schema: JsonSchemaLcd; opts: CallOpts }>;
} {
  const calls: Array<{ messages: LlmMessage[]; schema: JsonSchemaLcd; opts: CallOpts }> = [];
  let i = 0;
  return {
    id: opts.id ?? 'local',
    model: 'test-model',
    calls,
    structured<T>(messages: LlmMessage[], schema: JsonSchemaLcd, o: CallOpts): Promise<T> {
      calls.push({ messages: [...messages], schema, opts: o });
      const answer = answers[Math.min(i++, answers.length - 1)];
      if (answer instanceof Error) return Promise.reject(answer);
      o.onUsage?.({ inputTokens: 10, outputTokens: 5 });
      return Promise.resolve(answer as T);
    },
    chat(): Promise<LlmResponse> {
      throw new Error('S1 must never call chat()');
    },
    validate: () => Promise.resolve({ ok: true as const, model: 'test-model' }),
    dispose: () => Promise.resolve(),
  };
}

const input = (over: Partial<Parameters<typeof runExtract>[1]> = {}): Parameters<typeof runExtract>[1] => ({
  systemPrompt: 'SYSTEM',
  userMessage: 'USER DATA BLOCK',
  signal: new AbortController().signal,
  maxOutputTokens: 512,
  ...over,
});

describe('runExtract', () => {
  it('parses a valid first answer and reports repaired=false', async () => {
    const p = provider([VALID]);
    const out = await runExtract(p, input());
    expect(out).toEqual({ ok: true, extraction: VALID, repaired: false });
    expect(p.calls).toHaveLength(1);
  });

  it('sends system + user with EXTRACTION_JSON_SCHEMA, purpose "extract" and no tools', async () => {
    const p = provider([VALID]);
    await runExtract(p, input());
    expect(p.calls[0]!.messages).toEqual([
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'USER DATA BLOCK' },
    ]);
    expect(p.calls[0]!.schema).toBe(EXTRACTION_JSON_SCHEMA);
    expect(p.calls[0]!.opts.purpose).toBe('extract');
    expect(p.calls[0]!.opts.maxOutputTokens).toBe(512);
  });

  it('forwards usage to onUsage when a sink is given, and omits the key when it is not', async () => {
    const usage: LlmUsage[] = [];
    await runExtract(provider([VALID]), input({ onUsage: (u) => void usage.push(u) }));
    expect(usage).toEqual([{ inputTokens: 10, outputTokens: 5 }]);

    const p = provider([VALID]);
    await runExtract(p, input());
    expect(p.calls[0]!.opts.onUsage).toBeUndefined();
  });

  it('retries ONCE with the repair message and succeeds', async () => {
    const p = provider([{ nonsense: true }, VALID]);
    const out = await runExtract(p, input());
    expect(out).toEqual({ ok: true, extraction: VALID, repaired: true });
    expect(p.calls).toHaveLength(2);
    expect(p.calls[1]!.messages.at(-1)).toEqual({ role: 'user', content: REPAIR_MESSAGE });
    // The repair is a USER turn, so the cached system prefix is untouched.
    expect(p.calls[1]!.messages[0]).toEqual({ role: 'system', content: 'SYSTEM' });
  });

  it('gives up with bad_output after the second invalid answer - never a third call', async () => {
    const p = provider([{ nope: 1 }, { still: 'wrong' }]);
    expect(await runExtract(p, input())).toEqual({ ok: false, reason: 'bad_output' });
    expect(p.calls).toHaveLength(2);
  });

  it('rejects an extraction with an extra key (strict) and an out-of-range field', async () => {
    const extra = { ...VALID, recipient: '972500000000@s.whatsapp.net' };
    expect(await runExtract(provider([extra, extra]), input())).toEqual({ ok: false, reason: 'bad_output' });
    const badRange = { ...VALID, weekday: 9 };
    expect(await runExtract(provider([badRange, badRange]), input())).toEqual({ ok: false, reason: 'bad_output' });
  });

  it('maps an LlmError to its provider code without retrying', async () => {
    const p = provider([new LlmError('rate_limited')]);
    expect(await runExtract(p, input())).toEqual({ ok: false, reason: 'rate_limited' });
    expect(p.calls).toHaveLength(1);
  });

  it('reports "aborted" when a non-LlmError throw races an aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const p = provider([new Error('socket closed')]);
    expect(await runExtract(p, input({ signal: ac.signal }))).toEqual({ ok: false, reason: 'aborted' });
  });

  it('rethrows a non-provider error when the run was NOT aborted (adapter bug, not a model failure)', async () => {
    const boom = new TypeError('adapter bug');
    await expect(runExtract(provider([boom]), input())).rejects.toThrow(boom);
  });

  it('never logs or replays the zod issues (the repair message is a constant)', () => {
    expect(REPAIR_MESSAGE).toBe('Your previous output was not valid. Return only JSON matching the schema.');
  });

  it('does not touch the caller message array between attempts', async () => {
    const p = provider([{ bad: true }, VALID]);
    const spy = vi.spyOn(p, 'structured');
    await runExtract(p, input());
    expect(spy).toHaveBeenCalledTimes(2);
    expect(p.calls[0]!.messages).toHaveLength(2);
    expect(p.calls[1]!.messages).toHaveLength(3);
  });
});
