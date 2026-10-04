// src/main/agent/draft.test.ts - S3 DRAFT loop bounds + cleanDraft (TESTS 5.3 row `agent/draft.ts`; owner W1-10).
// The gate is a recording double here: this file tests the LOOP (turn/call budgets, non-executable stop reasons, abort),
// while agent/toolGate.test.ts (W1-09) tests the gate itself.
import { describe, expect, it } from 'vitest';
import { cleanDraft, runDraft, type DraftInput } from './draft';
import type { RunCtx, ToolGate, ToolGateOutcome, ToolGateVerdict } from './toolGate';
import { createHandleTable } from './handles';
import { LIMITS } from '../../shared/types';
import type { LlmMessage, LlmTool, LlmToolCall } from '../llm/types';
import { StubLlm, type StubRule } from '../../../tests/fakes/stub-llm';

const FREEBUSY: LlmTool = {
  name: 'get_freebusy',
  description: 'd',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

interface FakeGate extends ToolGate {
  readonly invoked: LlmToolCall[];
}
function fakeGate(opts: { verdicts?: ToolGateVerdict[]; abortAt?: number; tools?: LlmTool[] } = {}): FakeGate {
  const invoked: LlmToolCall[] = [];
  const verdicts = opts.verdicts ?? [];
  return {
    invoked,
    exposedTools: () => opts.tools ?? [FREEBUSY],
    invoke(call: LlmToolCall): Promise<ToolGateOutcome> {
      invoked.push(call);
      const verdict = verdicts[invoked.length - 1] ?? 'executed';
      return Promise.resolve({
        result: { toolCallId: call.id, name: call.name, content: '{"busy":[]}' },
        verdict,
        abortRun: opts.abortAt !== undefined && invoked.length >= opts.abortAt,
      });
    },
    prefetchFreeBusy: () => Promise.resolve(null),
    // [V2] C2 10 ToolGate additions (unused by the v1 turn loop)
    exposedSpecs: () => [],
    prefetchWaContext: () => Promise.resolve(null),
  };
}

function ctx(signal: AbortSignal): RunCtx {
  return {
    runId: 1,
    itemId: 1,
    chatId: 1,
    nowMs: Date.parse('2026-09-21T07:00:00.000Z'),
    timeZone: 'Asia/Jerusalem',
    nonce: 'abcdef0123456789',
    calls: {},
    totalCalls: 0,
    blockedCalls: 0,
    signal,
    // [V2] C2 10 RunCtx additions (a Wave 0 stub handle table; the v1 gate never reads them)
    handles: createHandleTable(1),
    waRowsServed: 0,
    crossChatRows: 0,
    otherChatTexts: [],
  };
}

const MESSAGES: LlmMessage[] = [
  { role: 'system', content: 'SYSTEM' },
  { role: 'user', content: '<<DATA-abcdef0123456789>>[]<<END-DATA-abcdef0123456789>>' },
];

function input(
  rules: StubRule[],
  over: Partial<DraftInput> = {},
): { provider: StubLlm; input: DraftInput; gate: FakeGate } {
  const gate = (over.gate as FakeGate | undefined) ?? fakeGate();
  const signal = over.ctx?.signal ?? new AbortController().signal;
  return {
    provider: new StubLlm({ rules }),
    gate,
    input: {
      messages: MESSAGES,
      ctx: over.ctx ?? ctx(signal),
      gate,
      maxOutputTokens: 2048,
      wallClockMs: LIMITS.draftWallClockCloudMs,
      ...over,
    },
  };
}

describe('cleanDraft', () => {
  it('trims, strips a leading label and matching wrapping quotes', () => {
    expect(cleanDraft('  Draft: "See you at 17:00"  ')).toBe('See you at 17:00');
    expect(cleanDraft('תשובה: «מעולה, נתראה»')).toBe('מעולה, נתראה');
    expect(cleanDraft("Reply: 'ok'")).toBe('ok');
    expect(cleanDraft('Response: “yes”'.replace(' ', ' '))).toBe('yes');
  });
  it('peels a nested label + quote pair', () => {
    expect(cleanDraft('Answer: "Draft: “ok”"')).toBe('ok');
  });
  it('leaves unmatched quotes alone', () => {
    expect(cleanDraft('"half quoted')).toBe('"half quoted');
    expect(cleanDraft('«mismatched')).toBe('«mismatched');
    expect(cleanDraft('“open only')).toBe('“open only');
  });
  it('strips invisible and bidi characters', () => {
    expect(cleanDraft('ok​‮⁦!')).toBe('ok!');
  });
  it('caps at LIMITS.draftChars and trims the trailing edge', () => {
    const long = `${'a'.repeat(LIMITS.draftChars + 20)} tail`;
    expect(cleanDraft(long)).toHaveLength(LIMITS.draftChars);
  });
  it('returns an empty string for an all-invisible draft', () => {
    expect(cleanDraft('​‌ ⁨')).toBe('');
  });
  it('does not strip a quote character that is not a wrapping pair', () => {
    expect(cleanDraft('he said "yes" then left')).toBe('he said "yes" then left');
  });
});

describe('runDraft loop bounds', () => {
  it('returns the first no-tool turn as the draft', async () => {
    const { provider, input: i } = input([{ when: { purpose: 'draft' }, respond: { text: 'Draft: "sounds good"' } }]);
    expect(await runDraft(provider, i)).toEqual({
      ok: true,
      text: 'sounds good',
      toolCalls: 0,
      blockedToolCalls: 0,
      manipulation: false,
    });
  });

  it('executes a tool call, replays the result and then finishes', async () => {
    const {
      provider,
      input: i,
      gate,
    } = input([
      { when: { turn: 0 }, respond: { toolCalls: [{ name: 'get_freebusy', input: { timeMin: 'x', timeMax: 'y' } }] } },
      { when: { hasToolResultFor: 'get_freebusy' }, respond: { text: 'Thursday at 17:00 works' } },
    ]);
    const out = await runDraft(provider, i);
    expect(out).toEqual({
      ok: true,
      text: 'Thursday at 17:00 works',
      toolCalls: 1,
      blockedToolCalls: 0,
      manipulation: false,
    });
    expect(gate.invoked.map((c) => c.name)).toEqual(['get_freebusy']);
    // The StubLlm throws if the assistant turn was not replayed by identity, so reaching here proves verbatim replay.
    const second = provider.calls[1]!.messages;
    expect(second.at(-1)).toMatchObject({ role: 'tool' });
    expect(second.at(-2)).toMatchObject({ role: 'assistant' });
  });

  it('offers the gate tools on every tool turn and NO tools on the final turn', async () => {
    const { provider, input: i } = input([
      { when: { purpose: 'draft' }, respond: { toolCalls: [{ name: 'get_freebusy', input: {} }] } },
    ]);
    await runDraft(provider, i);
    const toolNames = provider.seen.map((s) => s.toolNames);
    expect(toolNames.slice(0, LIMITS.draftTurnsWithTools)).toEqual(
      Array(LIMITS.draftTurnsWithTools).fill(['get_freebusy']),
    );
    expect(toolNames.at(-1)).toEqual([]); // the mandatory no-tool turn
  });

  it('stops after LIMITS.draftTurnsWithTools tool turns and answers from the final no-tool turn', async () => {
    const {
      provider,
      input: i,
      gate,
    } = input([
      { when: { turn: LIMITS.draftTurnsWithTools }, respond: { text: 'out of tools, here is the reply' } },
      { when: { purpose: 'draft' }, respond: { toolCalls: [{ name: 'get_freebusy', input: {} }] } },
    ]);
    const out = await runDraft(provider, i);
    expect(out).toEqual({
      ok: true,
      text: 'out of tools, here is the reply',
      toolCalls: LIMITS.draftTurnsWithTools,
      blockedToolCalls: 0,
      manipulation: false,
    });
    expect(gate.invoked).toHaveLength(LIMITS.draftTurnsWithTools);
    expect(provider.calls).toHaveLength(LIMITS.draftTurnsWithTools + 1);
  });

  it('counts every call of a multi-call turn and never exceeds the gate', async () => {
    const gate = fakeGate();
    const { provider, input: i } = input(
      [
        {
          when: { turn: 0 },
          respond: {
            toolCalls: [
              { name: 'get_freebusy', input: {} },
              { name: 'get_current_time', input: {} },
            ],
          },
        },
        { when: { turn: 1 }, respond: { text: 'ok' } },
      ],
      { gate },
    );
    const out = await runDraft(provider, i);
    expect(out).toMatchObject({ ok: true, toolCalls: 2 });
    expect(gate.invoked).toHaveLength(2);
  });

  it('counts blocked calls but not "unavailable" ones', async () => {
    const gate = fakeGate({ verdicts: ['blocked_unknown_tool', 'unavailable'] });
    const { provider, input: i } = input(
      [
        {
          when: { turn: 0 },
          respond: {
            toolCalls: [
              { name: 'delete-event', input: {} },
              { name: 'get_freebusy', input: {} },
            ],
          },
        },
        { when: { turn: 1 }, respond: { text: 'fine' } },
      ],
      { gate },
    );
    const out = await runDraft(provider, i);
    expect(out).toEqual({ ok: true, text: 'fine', toolCalls: 0, blockedToolCalls: 1, manipulation: false });
  });

  it('reports manipulation when the run context recorded blocked calls', async () => {
    const signal = new AbortController().signal;
    const runCtx = { ...ctx(signal), blockedCalls: 1 };
    const { provider, input: i } = input([{ when: { purpose: 'draft' }, respond: { text: 'hello' } }], { ctx: runCtx });
    expect(await runDraft(provider, i)).toMatchObject({ ok: true, manipulation: true });
  });

  it('aborts the run when the gate says so, and never runs the remaining calls of that turn', async () => {
    const gate = fakeGate({ verdicts: ['blocked_unknown_tool'], abortAt: 1 });
    const { provider, input: i } = input(
      [
        {
          when: { turn: 0 },
          respond: {
            toolCalls: [
              { name: 'create-event', input: {} },
              { name: 'get_freebusy', input: {} },
            ],
          },
        },
      ],
      { gate },
    );
    expect(await runDraft(provider, i)).toEqual({ ok: false, reason: 'aborted_manipulation', blockedToolCalls: 1 });
    expect(gate.invoked).toHaveLength(1);
  });

  it('never executes the tool calls of a max_tokens or refusal turn', async () => {
    for (const stopReason of ['max_tokens', 'refusal'] as const) {
      const gate = fakeGate();
      const { provider, input: i } = input(
        [
          {
            when: { turn: 0 },
            respond: { toolCalls: [{ name: 'get_freebusy', input: {} }], text: 'partial text', stopReason },
          },
          { when: { turn: 1 }, respond: { text: 'here is the reply in words' } },
        ],
        { gate },
      );
      const out = await runDraft(provider, i);
      expect(gate.invoked).toHaveLength(0);
      // The loop breaks and the mandatory no-tool turn produces the draft.
      expect(provider.calls.at(-1)!.tools).toEqual([]);
      expect(out.ok).toBe(true);
    }
  });

  it('treats an empty final answer as max_turns', async () => {
    const { provider, input: i } = input([{ when: { purpose: 'draft' }, respond: { text: '   ' } }]);
    expect(await runDraft(provider, i)).toEqual({ ok: false, reason: 'max_turns', blockedToolCalls: 0 });
  });

  it('maps a provider error to its code', async () => {
    const { provider, input: i } = input([{ when: { purpose: 'draft' }, respond: { error: 'overloaded' } }]);
    expect(await runDraft(provider, i)).toEqual({ ok: false, reason: 'overloaded', blockedToolCalls: 0 });
  });

  it('maps a provider error on the FINAL no-tool turn too', async () => {
    const { provider, input: i } = input([
      { when: { turn: LIMITS.draftTurnsWithTools }, respond: { error: 'rate_limited' } },
      { when: { purpose: 'draft' }, respond: { toolCalls: [{ name: 'get_freebusy', input: {} }] } },
    ]);
    expect(await runDraft(provider, i)).toEqual({ ok: false, reason: 'rate_limited', blockedToolCalls: 0 });
  });

  it('returns aborted immediately when the ctx signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const { provider, input: i } = input([{ when: { purpose: 'draft' }, respond: { text: 'never reached' } }], {
      ctx: ctx(ac.signal),
    });
    expect(await runDraft(provider, i)).toEqual({ ok: false, reason: 'aborted', blockedToolCalls: 0 });
    expect(provider.calls).toHaveLength(0);
  });

  it('returns aborted when Pause fires while the model hangs', async () => {
    const ac = new AbortController();
    const { provider, input: i } = input([{ when: { purpose: 'draft' }, respond: { hang: true } }], {
      ctx: ctx(ac.signal),
    });
    const promise = runDraft(provider, i);
    ac.abort();
    expect(await promise).toEqual({ ok: false, reason: 'aborted', blockedToolCalls: 0 });
  });

  it('honours the wall clock as a second guard even when the caller signal never fires', async () => {
    const { provider, input: i } = input([{ when: { purpose: 'draft' }, respond: { hang: true } }], { wallClockMs: 5 });
    expect(await runDraft(provider, i)).toEqual({ ok: false, reason: 'aborted', blockedToolCalls: 0 });
  });

  it('clamps a non-positive wall clock to at least 1 ms instead of throwing', async () => {
    const { provider, input: i } = input([{ when: { purpose: 'draft' }, respond: { hang: true } }], { wallClockMs: 0 });
    expect(await runDraft(provider, i)).toEqual({ ok: false, reason: 'aborted', blockedToolCalls: 0 });
  });

  it('rethrows a non-provider throw from the adapter', async () => {
    const provider = new StubLlm({ rules: [] });
    // A history whose assistant turn carries foreign providerData is a caller bug; the stub throws a plain Error.
    const { input: i } = input([]);
    await expect(
      runDraft(provider, {
        ...i,
        messages: [...MESSAGES, { role: 'assistant', content: 'x', providerData: { forged: true } }],
      }),
    ).rejects.toThrow(/verbatim-replay/);
  });

  it('forwards onUsage and the token budget to the provider', async () => {
    const seen: number[] = [];
    const { provider, input: i } = input([{ when: { purpose: 'draft' }, respond: { text: 'ok' } }]);
    await runDraft(provider, { ...i, maxOutputTokens: 777, onUsage: (u) => void seen.push(u.outputTokens) });
    expect(provider.calls[0]!.opts.maxOutputTokens).toBe(777);
    expect(provider.calls[0]!.opts.purpose).toBe('draft');
    expect(seen.length).toBeGreaterThan(0);
  });
});
