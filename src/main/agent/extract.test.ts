// src/main/agent/extract.test.ts - S1 EXTRACT (TESTS 5.3 row `agent/extract.ts`: one repair retry then LLM_BAD_OUTPUT; owner W1-10).
import { describe, expect, it, vi } from 'vitest';
import { REPAIR_MESSAGE, runExtract, stripOneCodeFence } from './extract';
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
  // [V2] C2 5: the four B20 fields S1 v2 always returns (null-event defaults of the S1 v2 few-shots)
  refersToExisting: false,
  change: 'no_change',
  changeConfidence: 'high',
  confidence: 'high',
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
    loop: 'turn', // [V2] C2 9
    capabilities: { images: false }, // [V2] C2 9
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

// ======================= [V2-W1-03] P2 6.1 / 6.3, T2 5 row `extract.ts` v2 =======================

describe('runExtract v2 - the four B20 fields', () => {
  it('accepts every change kind / confidence the schema allows', async () => {
    for (const change of ['no_change', 'reschedule', 'move', 'cancel', 'new_event'] as const) {
      for (const c of ['high', 'medium', 'low'] as const) {
        const x = { ...VALID, refersToExisting: change !== 'new_event', change, changeConfidence: c, confidence: c };
        const out = await runExtract(provider([x]), input());
        expect(out).toEqual({ ok: true, extraction: x, repaired: false });
      }
    }
  });

  it('a v1-shaped answer (the four fields missing) is not an extraction: repair, then bad_output', async () => {
    const { refersToExisting: _a, change: _b, changeConfidence: _c, confidence: _d, ...v1 } = VALID;
    expect(await runExtract(provider([v1, v1]), input())).toEqual({ ok: false, reason: 'bad_output' });
  });

  it('rejects an unknown change kind and a non-boolean refersToExisting', async () => {
    const a = { ...VALID, change: 'delete' };
    expect(await runExtract(provider([a, a]), input())).toEqual({ ok: false, reason: 'bad_output' });
    const b = { ...VALID, refersToExisting: 'yes' };
    expect(await runExtract(provider([b, b]), input())).toEqual({ ok: false, reason: 'bad_output' });
  });

  it("the model can never name the event it changes: a targetEventId key is a strict-schema failure (I3')", async () => {
    const x = { ...VALID, change: 'cancel', refersToExisting: true, targetEventId: 'abc123' };
    expect(await runExtract(provider([x, x]), input())).toEqual({ ok: false, reason: 'bad_output' });
  });
});

describe('stripOneCodeFence / CLI text answers (P2 6.3)', () => {
  const json = JSON.stringify(VALID);

  it('strips exactly one ```json fence and one trailing fence', () => {
    expect(stripOneCodeFence('```json\n' + json + '\n```')).toBe(json);
    expect(stripOneCodeFence('```\n' + json + '\n```')).toBe(json);
    expect(stripOneCodeFence('  ```json\n' + json + '\n```  ')).toBe(json);
    expect(stripOneCodeFence(json)).toBe(json);
  });

  it('never strips twice: a doubly fenced answer stays fenced (=> parse failure, not a second strip)', () => {
    const twice = '```json\n```json\n' + json + '\n```\n```';
    const once = stripOneCodeFence(twice);
    expect(once.startsWith('```json')).toBe(true);
    expect(() => JSON.parse(once)).toThrow();
  });

  it('an opening fence without a closing fence is left alone', () => {
    const half = '```json\n' + json;
    expect(stripOneCodeFence(half)).toBe(half.trim());
  });

  it('runExtract parses a fenced text answer (the CLI result.result path)', async () => {
    const out = await runExtract(provider(['```json\n' + json + '\n```']), input());
    expect(out).toEqual({ ok: true, extraction: VALID, repaired: false });
  });

  it('a doubly fenced text answer is a bad answer: one repair turn, then bad_output', async () => {
    const twice = '```json\n```json\n' + json + '\n```\n```';
    const p = provider([twice, twice]);
    expect(await runExtract(p, input())).toEqual({ ok: false, reason: 'bad_output' });
    expect(p.calls).toHaveLength(2);
    expect(p.calls[1]!.messages.at(-1)).toEqual({ role: 'user', content: REPAIR_MESSAGE });
  });

  it('non-JSON text goes to the repair turn and a valid second answer wins (the CLI repair JOB is a second structured() call)', async () => {
    const p = provider(['Sure! Here is the JSON you asked for.', '```\n' + json + '\n```'], { id: 'claude_cli' });
    const out = await runExtract(p, input());
    expect(out).toEqual({ ok: true, extraction: VALID, repaired: true });
    expect(p.calls).toHaveLength(2);
    for (const c of p.calls) {
      expect(c.opts.purpose).toBe('extract');
      expect(c.schema).toBe(EXTRACTION_JSON_SCHEMA);
    }
  });

  it('forwards the CLI sandbox proof sink when given, and omits it otherwise', async () => {
    const proofs: unknown[] = [];
    const p = provider([VALID], { id: 'claude_cli' });
    await runExtract(p, input({ onSandbox: (x) => void proofs.push(x) }));
    expect(typeof p.calls[0]!.opts.onSandbox).toBe('function');
    const q = provider([VALID]);
    await runExtract(q, input());
    expect(q.calls[0]!.opts.onSandbox).toBeUndefined();
  });
});
