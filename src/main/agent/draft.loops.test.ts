// src/main/agent/draft.loops.test.ts - [V2] B15 / P2 8.4: runDraft branches on provider.loop FIRST (owner V2-W1-06-claude-cli).
// 'agentic' = runAgentic over the SAME gate + RunCtx (the provider owns the per-run tool server); 'prefetch' = prefetchWaContext inlined
// + one no-tool structured() with DRAFT_REPLY_SCHEMA; same DraftOutcome / cleanDraft / blockedCallsAbort for all loops.
import { describe, expect, it, vi } from 'vitest';
import { DRAFT_REPLY_SCHEMA, runDraft, type DraftInput } from './draft';
import type { RunCtx, ToolGate } from './toolGate';
import { createHandleTable } from './handles';
import { LIMITS } from '../../shared/types';
import { LlmError, type AgenticRunInput, type AgenticRunResult, type LlmProvider } from '../llm/types';

function gate(over: Partial<ToolGate> = {}): ToolGate {
  return {
    exposedTools: vi.fn(() => []),
    exposedSpecs: vi.fn(() => [{ name: 'get_current_time' }] as never),
    invoke: vi.fn(),
    prefetchFreeBusy: vi.fn(async () => null),
    prefetchWaContext: vi.fn(async () => null),
    ...over,
  };
}
function ctx(signal: AbortSignal = new AbortController().signal): RunCtx {
  return {
    runId: 1,
    itemId: 2,
    chatId: 3,
    nowMs: 0,
    timeZone: 'Asia/Jerusalem',
    nonce: 'abcdef0123456789',
    calls: {},
    totalCalls: 0,
    blockedCalls: 0,
    signal,
    handles: createHandleTable(3),
    waRowsServed: 0,
    crossChatRows: 0,
    otherChatTexts: [],
  };
}
const input = (g: ToolGate, c: RunCtx = ctx(), over: Partial<DraftInput> = {}): DraftInput => ({
  messages: [
    { role: 'system', content: 'S3 CONSTANT' },
    { role: 'user', content: '<<DATA-abcdef0123456789>>\n{}\n<<END-DATA-abcdef0123456789>>' },
  ],
  ctx: c,
  gate: g,
  maxOutputTokens: 400,
  wallClockMs: 60_000,
  ...over,
});
function provider(loop: LlmProvider['loop'], over: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id: loop === 'agentic' ? 'claude_cli' : loop === 'prefetch' ? 'antigravity_cli' : 'local',
    model: 'm',
    loop,
    capabilities: { images: false },
    structured: vi.fn(),
    chat: vi.fn(async () => Promise.reject(new Error('chat must not be called'))),
    validate: vi.fn(),
    dispose: vi.fn(),
    ...over,
  };
}
const agentic = (r: Partial<AgenticRunResult> | Error | ((i: AgenticRunInput) => AgenticRunResult)) =>
  vi.fn(async (i: AgenticRunInput) => {
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r(i);
    return {
      text: 'Draft: "Sure, 17:00 works."',
      toolCalls: 1,
      blockedCalls: 0,
      sandboxOk: true,
      stopReason: 'end' as const,
      ...r,
    };
  });

describe('loop agentic (claude_cli)', () => {
  it('never calls chat(); runAgentic gets the verbatim system, the data block, gate.exposedSpecs(), the SAME RunCtx and maxTurns 5', async () => {
    const g = gate();
    const c = ctx();
    const runAgentic = agentic({});
    const onUsage = vi.fn();
    const p = provider('agentic', { runAgentic });
    const out = await runDraft(p, input(g, c, { onUsage }));
    expect(out).toEqual({
      ok: true,
      text: 'Sure, 17:00 works.',
      toolCalls: 1,
      blockedToolCalls: 0,
      manipulation: false,
    });
    expect(p.chat).not.toHaveBeenCalled();
    const [arg, opts] = runAgentic.mock.calls[0] as unknown as [AgenticRunInput, Record<string, unknown>];
    expect(arg.system).toBe('S3 CONSTANT');
    expect(arg.user).toBe('<<DATA-abcdef0123456789>>\n{}\n<<END-DATA-abcdef0123456789>>');
    expect(arg.specs).toEqual([{ name: 'get_current_time' }]);
    expect(arg.ctx).toBe(c);
    expect(arg.gate).toBe(g);
    expect(arg.maxTurns).toBe(LIMITS.draftTurnsWithTools + 1);
    expect(opts).toMatchObject({ purpose: 'draft', maxOutputTokens: 400, onUsage });
  });

  it('sandboxOk false => sandbox (output discarded); 2 strikes => aborted_manipulation; 1 strike => manipulation flag', async () => {
    expect(
      await runDraft(
        provider('agentic', { runAgentic: agentic({ sandboxOk: false, text: 'ignored' }) }),
        input(gate()),
      ),
    ).toEqual({
      ok: false,
      reason: 'sandbox',
      blockedToolCalls: 0,
    });
    const c2 = ctx();
    const struck = agentic((i) => {
      i.ctx.blockedCalls = LIMITS.blockedCallsAbort;
      return { text: '', toolCalls: 0, blockedCalls: 2, sandboxOk: true, stopReason: 'killed' };
    });
    expect(await runDraft(provider('agentic', { runAgentic: struck }), input(gate(), c2))).toEqual({
      ok: false,
      reason: 'aborted_manipulation',
      blockedToolCalls: 2,
    });
    const c1 = ctx();
    const once = agentic((i) => {
      i.ctx.blockedCalls = 1;
      return { text: 'ok text', toolCalls: 0, blockedCalls: 0, sandboxOk: true, stopReason: 'end' };
    });
    expect(await runDraft(provider('agentic', { runAgentic: once }), input(gate(), c1))).toMatchObject({
      ok: true,
      manipulation: true,
      blockedToolCalls: 1,
    });
  });

  it('empty text => max_turns; stopReason aborted => aborted; LlmError => its code; a non-LlmError after abort => aborted', async () => {
    expect(
      await runDraft(
        provider('agentic', { runAgentic: agentic({ text: '  ""  ', stopReason: 'max_turns' }) }),
        input(gate()),
      ),
    ).toMatchObject({
      ok: false,
      reason: 'max_turns',
    });
    expect(
      await runDraft(provider('agentic', { runAgentic: agentic({ stopReason: 'aborted' }) }), input(gate())),
    ).toMatchObject({
      reason: 'aborted',
    });
    expect(
      await runDraft(provider('agentic', { runAgentic: agentic(new LlmError('usage_limit')) }), input(gate())),
    ).toEqual({
      ok: false,
      reason: 'usage_limit',
      blockedToolCalls: 0,
    });
    const ac = new AbortController();
    const abortThenThrow = vi.fn(async () => {
      ac.abort();
      throw new Error('socket hang up');
    });
    expect(
      await runDraft(provider('agentic', { runAgentic: abortThenThrow }), input(gate(), ctx(ac.signal))),
    ).toMatchObject({
      reason: 'aborted',
    });
    await expect(
      runDraft(provider('agentic', { runAgentic: agentic(new TypeError('adapter bug')) }), input(gate())),
    ).rejects.toThrow('adapter bug');
  });

  it('a provider without runAgentic => unsupported; an already-aborted run never starts', async () => {
    expect(await runDraft(provider('agentic'), input(gate()))).toEqual({
      ok: false,
      reason: 'unsupported',
      blockedToolCalls: 0,
    });
    const ac = new AbortController();
    ac.abort();
    const runAgentic = agentic({});
    expect(await runDraft(provider('agentic', { runAgentic }), input(gate(), ctx(ac.signal)))).toMatchObject({
      reason: 'aborted',
    });
    expect(runAgentic).not.toHaveBeenCalled();
  });

  it('image/array user content is flattened to its text parts (never an image on S3)', async () => {
    const runAgentic = agentic({});
    await runDraft(
      provider('agentic', { runAgentic }),
      input(gate(), ctx(), {
        messages: [
          { role: 'system', content: 'A' },
          { role: 'system', content: 'B' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'T1' },
              { type: 'image', mime: 'image/png', base64: 'x' },
            ],
          },
          { role: 'assistant', content: 'ignored' },
        ],
      }),
    );
    expect(runAgentic.mock.calls[0]![0]).toMatchObject({ system: 'A\n\nB', user: 'T1\n' });
  });
});

describe('loop prefetch (antigravity_cli)', () => {
  it('prefetchWaContext inlined into the user block, ONE no-tool structured() with DRAFT_REPLY_SCHEMA, reply cleaned', async () => {
    const g = gate({
      prefetchWaContext: vi.fn(
        async () => '<<DATA-abcdef0123456789>>\n{"earlier_messages":[]}\n<<END-DATA-abcdef0123456789>>',
      ),
    });
    const structured = vi.fn(async () => ({ reply: 'Reply: "See you at 5"' }));
    const p = provider('prefetch', { structured: structured as never });
    const out = await runDraft(p, input(g));
    expect(out).toEqual({ ok: true, text: 'See you at 5', toolCalls: 0, blockedToolCalls: 0, manipulation: false });
    expect(p.chat).not.toHaveBeenCalled();
    expect(g.exposedTools).not.toHaveBeenCalled();
    const [msgs, schema, opts] = structured.mock.calls[0] as unknown as [
      Array<{ role: string; content: string }>,
      unknown,
      { purpose: string },
    ];
    expect(schema).toBe(DRAFT_REPLY_SCHEMA);
    expect(DRAFT_REPLY_SCHEMA).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { reply: { type: 'string' } },
      required: ['reply'],
    });
    expect(opts.purpose).toBe('draft');
    expect(msgs[0]).toEqual({ role: 'system', content: 'S3 CONSTANT' });
    expect(msgs[1]!.content).toContain('earlier_messages');
  });

  it('WhatsApp unavailable (null) or failing => no extra block; bad shape / empty => bad_output; LlmError => code', async () => {
    const structured = vi.fn(async () => ({ reply: 'x' }));
    await runDraft(
      provider('prefetch', { structured: structured as never }),
      input(gate({ prefetchWaContext: vi.fn(async () => Promise.reject(new Error('db'))) })),
    );
    expect((structured.mock.calls[0] as unknown as [Array<{ content: string }>])[0][1]!.content).toBe(
      '<<DATA-abcdef0123456789>>\n{}\n<<END-DATA-abcdef0123456789>>',
    );
    for (const raw of [{ reply: 5 }, { reply: 'x', extra: 1 }, null]) {
      expect(
        await runDraft(provider('prefetch', { structured: vi.fn(async () => raw) as never }), input(gate())),
      ).toEqual({
        ok: false,
        reason: 'bad_output',
        blockedToolCalls: 0,
      });
    }
    expect(
      await runDraft(
        provider('prefetch', { structured: vi.fn(async () => ({ reply: ' "" ' })) as never }),
        input(gate()),
      ),
    ).toMatchObject({
      reason: 'bad_output',
    });
    expect(
      await runDraft(
        provider('prefetch', { structured: vi.fn(async () => Promise.reject(new LlmError('not_logged_in'))) as never }),
        input(gate()),
      ),
    ).toMatchObject({ reason: 'not_logged_in' });
  });

  it('abort before start / during the call; a non-LlmError without abort rethrows; usage is reported', async () => {
    const ac = new AbortController();
    ac.abort();
    const structured = vi.fn();
    expect(await runDraft(provider('prefetch', { structured }), input(gate(), ctx(ac.signal)))).toMatchObject({
      reason: 'aborted',
    });
    expect(structured).not.toHaveBeenCalled();
    const ac2 = new AbortController();
    const abortThenThrow = vi.fn(async () => {
      ac2.abort();
      throw new Error('x');
    });
    expect(
      await runDraft(provider('prefetch', { structured: abortThenThrow }), input(gate(), ctx(ac2.signal))),
    ).toMatchObject({
      reason: 'aborted',
    });
    await expect(
      runDraft(
        provider('prefetch', { structured: vi.fn(async () => Promise.reject(new TypeError('bug'))) }),
        input(gate()),
      ),
    ).rejects.toThrow('bug');
    const onUsage = vi.fn();
    const s2 = vi.fn(async (_m: unknown, _s: unknown, o: { onUsage?: unknown }) => {
      expect(o.onUsage).toBe(onUsage);
      return { reply: 'ok' };
    });
    await runDraft(provider('prefetch', { structured: s2 as never }), input(gate(), ctx(), { onUsage }));
  });
});

describe('loop turn stays the v1 loop', () => {
  it('a turn provider never gets runAgentic / structured calls from S3', async () => {
    const runAgentic = agentic({});
    const p = provider('turn', {
      runAgentic,
      chat: vi.fn(async () => ({
        text: 'hello',
        toolCalls: [],
        stopReason: 'end' as const,
        assistantMessage: { role: 'assistant' as const, content: 'hello' },
      })),
    });
    expect(await runDraft(p, input(gate()))).toMatchObject({ ok: true, text: 'hello' });
    expect(runAgentic).not.toHaveBeenCalled();
    expect(p.structured).not.toHaveBeenCalled();
  });
});

describe('onSandbox (runs.sandbox_json of S3): forwarded into CallOpts on the CLI loops only', () => {
  const proof = { initOk: true, toolsCount: 3, mcpServers: 1, apiKeySource: 'none', mismatch: null } as const;
  it('agentic: the provider reports the S3 init proof through the DraftInput callback; absent => no key in CallOpts', async () => {
    const onSandbox = vi.fn();
    const runAgentic = vi.fn(async (_i: AgenticRunInput, o: { onSandbox?: (p: unknown) => void }) => {
      o.onSandbox?.(proof);
      return { text: 'ok', toolCalls: 0, blockedCalls: 0, sandboxOk: true, stopReason: 'end' as const };
    });
    await runDraft(provider('agentic', { runAgentic: runAgentic as never }), input(gate(), ctx(), { onSandbox }));
    expect(onSandbox).toHaveBeenCalledWith(proof);
    const bare = agentic({});
    await runDraft(provider('agentic', { runAgentic: bare }), input(gate()));
    expect((bare.mock.calls[0] as unknown as [AgenticRunInput, Record<string, unknown>])[1]).not.toHaveProperty(
      'onSandbox',
    );
  });
  it('prefetch: the same callback reaches the one structured() call', async () => {
    const onSandbox = vi.fn();
    const structured = vi.fn(async (_m: unknown, _s: unknown, o: { onSandbox?: (p: unknown) => void }) => {
      o.onSandbox?.(proof);
      return { reply: 'ok' };
    });
    await runDraft(provider('prefetch', { structured: structured as never }), input(gate(), ctx(), { onSandbox }));
    expect(onSandbox).toHaveBeenCalledWith(proof);
  });
});
