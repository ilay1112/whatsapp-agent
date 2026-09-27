// src/main/llm/local/selfTest.test.ts - TESTS 5.3 row `llm/local*`: the self-test garbage / timeout / exit paths and the
// [R2] dual self-test on machines without a dedicated GPU (owner W1-07). No model is loaded: the provider is a double.
import { describe, expect, it, vi } from 'vitest';
import type { Clock, ClockTimer, Logger, LogMeta } from '../../deps';
import { LlmError, type CallOpts, type LlmMessage, type LlmProvider } from '../types';
import type { JsonSchemaLcd } from '../../../shared/types';
import {
  SELF_TEST_ASSUMED_TOKENS,
  SELF_TEST_MAX_TOKENS,
  SELF_TEST_MIN_TOK_PER_SEC,
  SELF_TEST_SCHEMA,
  SELF_TEST_SYSTEM,
  SELF_TEST_USER,
  runDualSelfTest,
  runSelfTest,
} from './selfTest';

// ---------------------------------------------------------------------------------------------------------------------
// doubles
// ---------------------------------------------------------------------------------------------------------------------
/** `now()` jumps by `stepMs` on each read, so `elapsedMs` (and therefore tok/s) is deterministic. */
function clockWithStep(stepMs: number): Clock {
  let t = 1_700_000_000_000;
  return {
    now: () => {
      const v = t;
      t += stepMs;
      return v;
    },
    setTimeout: (fn) => setTimeout(fn, 0) as unknown as ClockTimer,
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

function recordingLog(): { events: Array<{ event: string; meta?: LogMeta }>; log: Logger } {
  const events: Array<{ event: string; meta?: LogMeta }> = [];
  const make = (): Logger => ({
    info: (event, meta) => events.push({ event, meta }),
    warn: (event, meta) => events.push({ event, meta }),
    error: (event, meta) => events.push({ event, meta }),
    child: () => make(),
  });
  return { events, log: make() };
}

type Answer = { ok: unknown; outputTokens?: number } | { throws: LlmError | Error };
interface ProviderDouble extends LlmProvider {
  readonly calls: Array<{ messages: LlmMessage[]; schema: JsonSchemaLcd; opts: CallOpts }>;
}
function providerDouble(...answers: Answer[]): ProviderDouble {
  const calls: ProviderDouble['calls'] = [];
  let i = 0;
  const provider = {
    id: 'local' as const,
    model: 'fake-model',
    structured: async <T>(messages: LlmMessage[], schema: JsonSchemaLcd, opts: CallOpts): Promise<T> => {
      calls.push({ messages, schema, opts });
      const answer = answers[Math.min(i, answers.length - 1)];
      i += 1;
      if (answer === undefined) return {} as T;
      if ('throws' in answer) throw answer.throws;
      if (answer.outputTokens !== undefined) opts.onUsage?.({ inputTokens: 10, outputTokens: answer.outputTokens });
      return { ok: answer.ok } as T;
    },
    chat: () => {
      throw new Error('the self-test never calls chat()');
    },
    validate: () => Promise.resolve({ ok: true as const, model: 'fake-model' }),
    dispose: () => Promise.resolve(),
  };
  return Object.defineProperty(provider, 'calls', { get: () => calls }) as unknown as ProviderDouble;
}

// ---------------------------------------------------------------------------------------------------------------------
// the fixed prompt
// ---------------------------------------------------------------------------------------------------------------------
describe('the self-test prompt is machine-independent', () => {
  it('contains no message text, no name and no locale-dependent wording', () => {
    expect(SELF_TEST_SYSTEM).toMatch(/^[\x20-\x7e]+$/);
    expect(SELF_TEST_USER).toMatch(/^[\x20-\x7e]+$/);
    expect(SELF_TEST_MAX_TOKENS).toBe(64);
  });

  it('asks for a one-key object with additionalProperties:false', () => {
    expect(SELF_TEST_SCHEMA).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: { ok: { type: 'boolean', description: 'Always true.' } },
    });
  });

  it('sends exactly the fixed system + user pair with purpose `extract`', async () => {
    const provider = providerDouble({ ok: true });
    await runSelfTest(provider, { clock: clockWithStep(500), log: recordingLog().log });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.messages).toEqual([
      { role: 'system', content: SELF_TEST_SYSTEM },
      { role: 'user', content: SELF_TEST_USER },
    ]);
    expect(provider.calls[0]!.schema).toBe(SELF_TEST_SCHEMA);
    expect(provider.calls[0]!.opts.purpose).toBe('extract');
    expect(provider.calls[0]!.opts.maxOutputTokens).toBe(SELF_TEST_MAX_TOKENS);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// runSelfTest
// ---------------------------------------------------------------------------------------------------------------------
describe('runSelfTest', () => {
  it('measures tok/s from the reported output tokens', async () => {
    // 20 tokens in 500 ms => 40 tok/s
    const result = await runSelfTest(providerDouble({ ok: true, outputTokens: 20 }), {
      clock: clockWithStep(500),
      log: recordingLog().log,
    });
    expect(result).toEqual({ ok: true, tokPerSec: 40, usedCpuFallback: false, device: 'gpu', code: null });
  });

  it('falls back to a fixed token count when the server reports no usage', async () => {
    const result = await runSelfTest(providerDouble({ ok: true }), {
      clock: clockWithStep(1000),
      log: recordingLog().log,
    });
    expect(result.tokPerSec).toBe(SELF_TEST_ASSUMED_TOKENS);
  });

  it('garbage: a schema-valid answer whose `ok` is not true fails with LLM_BAD_OUTPUT', async () => {
    const { events, log } = recordingLog();
    const result = await runSelfTest(providerDouble({ ok: 'yes' }), { clock: clockWithStep(100), log });
    expect(result).toMatchObject({ ok: false, code: 'LLM_BAD_OUTPUT', usedCpuFallback: false });
    expect(events.map((e) => e.event)).toContain('self_test_bad_output');
  });

  it('garbage: unparseable output surfaces as LLM_BAD_OUTPUT', async () => {
    const result = await runSelfTest(providerDouble({ throws: new LlmError('bad_output') }), {
      clock: clockWithStep(100),
      log: recordingLog().log,
    });
    expect(result.code).toBe('LLM_BAD_OUTPUT');
  });

  it('a timeout / crash without a CPU fallback reports LLM_LOCAL_FAILED', async () => {
    const result = await runSelfTest(providerDouble({ throws: new LlmError('network') }), {
      clock: clockWithStep(100),
      log: recordingLog().log,
    });
    expect(result).toEqual({
      ok: false,
      tokPerSec: null,
      usedCpuFallback: false,
      device: null,
      code: 'LLM_LOCAL_FAILED',
    });
  });

  it('a runtime that never became ready reports LLM_NOT_READY', async () => {
    const result = await runSelfTest(providerDouble({ throws: new LlmError('not_ready') }), {
      clock: clockWithStep(100),
      log: recordingLog().log,
    });
    expect(result.code).toBe('LLM_NOT_READY');
  });

  it('a non-LlmError (an exiting child) is still mapped to LLM_LOCAL_FAILED', async () => {
    const result = await runSelfTest(providerDouble({ throws: new Error('child exited with 1') }), {
      clock: clockWithStep(100),
      log: recordingLog().log,
    });
    expect(result.code).toBe('LLM_LOCAL_FAILED');
  });

  it('an abort is NEVER retried on the CPU', async () => {
    const cpu = vi.fn(() => Promise.resolve(providerDouble({ ok: true })));
    const result = await runSelfTest(providerDouble({ throws: new LlmError('aborted') }), {
      clock: clockWithStep(100),
      log: recordingLog().log,
      cpuFallbackProvider: cpu,
    });
    expect(result).toEqual({ ok: false, tokPerSec: null, usedCpuFallback: false, device: null, code: 'ABORTED' });
    expect(cpu).not.toHaveBeenCalled();
  });

  it('retries EXACTLY once with --device none and reports the CPU device on success', async () => {
    const { events, log } = recordingLog();
    const cpuProvider = providerDouble({ ok: true, outputTokens: 10 });
    const cpu = vi.fn(() => Promise.resolve(cpuProvider));
    const result = await runSelfTest(providerDouble({ throws: new LlmError('network') }), {
      clock: clockWithStep(1000),
      log,
      cpuFallbackProvider: cpu,
    });
    expect(cpu).toHaveBeenCalledTimes(1);
    expect(cpuProvider.calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, usedCpuFallback: true, device: 'cpu', code: null });
    expect(events.map((e) => e.event)).toContain('self_test_cpu_retry');
  });

  it('reports the failure when the CPU retry also fails', async () => {
    const result = await runSelfTest(providerDouble({ throws: new LlmError('network') }), {
      clock: clockWithStep(100),
      log: recordingLog().log,
      cpuFallbackProvider: () => Promise.resolve(providerDouble({ throws: new LlmError('bad_output') })),
    });
    expect(result).toEqual({ ok: false, tokPerSec: null, usedCpuFallback: true, device: null, code: 'LLM_BAD_OUTPUT' });
  });

  it('reports LLM_LOCAL_FAILED when the CPU runtime cannot even be built', async () => {
    const result = await runSelfTest(providerDouble({ throws: new LlmError('network') }), {
      clock: clockWithStep(100),
      log: recordingLog().log,
      cpuFallbackProvider: () => Promise.reject(new Error('spawn failed')),
    });
    expect(result).toEqual({
      ok: false,
      tokPerSec: null,
      usedCpuFallback: true,
      device: null,
      code: 'LLM_LOCAL_FAILED',
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [R2] dual self-test
// ---------------------------------------------------------------------------------------------------------------------
describe('[R2] runDualSelfTest', () => {
  const log = () => recordingLog().log;

  it('a machine WITH a dedicated GPU runs the prompt once and records no bench', async () => {
    const cpu = vi.fn(() => Promise.resolve(providerDouble({ ok: true })));
    const outcome = await runDualSelfTest(providerDouble({ ok: true, outputTokens: 20 }), {
      clock: clockWithStep(500),
      log: log(),
      hasDedicatedGpu: true,
      cpuProvider: cpu,
    });
    expect(cpu).not.toHaveBeenCalled();
    expect(outcome.bench).toBeNull();
    expect(outcome.forceCpu).toBe(false);
    expect(outcome.result).toMatchObject({ ok: true, device: 'gpu', tokPerSec: 40 });
  });

  it('a dedicated-GPU machine that fails falls back to the CPU and persists forceCpu', async () => {
    const outcome = await runDualSelfTest(providerDouble({ throws: new LlmError('network') }), {
      clock: clockWithStep(500),
      log: log(),
      hasDedicatedGpu: true,
      cpuProvider: () => Promise.resolve(providerDouble({ ok: true, outputTokens: 20 })),
    });
    expect(outcome.forceCpu).toBe(true);
    expect(outcome.result.device).toBe('cpu');
  });

  it('a machine with NO dedicated GPU times the prompt twice and keeps the FASTER mode', async () => {
    // gpu: 8 tokens in 1000 ms => 8 tok/s ; cpu: 40 tokens in 1000 ms => 40 tok/s
    const cpuProvider = providerDouble({ ok: true, outputTokens: 40 });
    const outcome = await runDualSelfTest(providerDouble({ ok: true, outputTokens: 8 }), {
      clock: clockWithStep(1000),
      log: log(),
      hasDedicatedGpu: false,
      cpuProvider: () => Promise.resolve(cpuProvider),
    });
    expect(outcome.bench).toEqual({ gpuTokPerSec: 8, cpuTokPerSec: 40, chosen: 'cpu' });
    expect(outcome.forceCpu).toBe(true);
    expect(outcome.result).toMatchObject({ ok: true, device: 'cpu', usedCpuFallback: true, tokPerSec: 40 });
    expect(cpuProvider.calls).toHaveLength(1);
  });

  it('keeps the automatic (GPU) mode when it is the faster of the two', async () => {
    const outcome = await runDualSelfTest(providerDouble({ ok: true, outputTokens: 40 }), {
      clock: clockWithStep(1000),
      log: log(),
      hasDedicatedGpu: false,
      cpuProvider: () => Promise.resolve(providerDouble({ ok: true, outputTokens: 8 })),
    });
    expect(outcome.bench).toEqual({ gpuTokPerSec: 40, cpuTokPerSec: 8, chosen: 'gpu' });
    expect(outcome.forceCpu).toBe(false);
    expect(outcome.result.device).toBe('gpu');
  });

  it('a mode that fails outright loses to the one that works', async () => {
    const outcome = await runDualSelfTest(providerDouble({ throws: new LlmError('network') }), {
      clock: clockWithStep(1000),
      log: log(),
      hasDedicatedGpu: false,
      cpuProvider: () => Promise.resolve(providerDouble({ ok: true, outputTokens: 8 })),
    });
    expect(outcome.bench).toEqual({ gpuTokPerSec: null, cpuTokPerSec: 8, chosen: 'cpu' });
    expect(outcome.forceCpu).toBe(true);
  });

  it('suggests a smaller tier ONLY when the BETTER of the two runs is below 5 tok/s, and never downgrades by itself', async () => {
    // both slow: 4 tok/s and 2 tok/s => suggest
    const slow = await runDualSelfTest(providerDouble({ ok: true, outputTokens: 4 }), {
      clock: clockWithStep(1000),
      log: log(),
      hasDedicatedGpu: false,
      cpuProvider: () => Promise.resolve(providerDouble({ ok: true, outputTokens: 2 })),
    });
    expect(slow.bench).toEqual({ gpuTokPerSec: 4, cpuTokPerSec: 2, chosen: 'gpu' });
    expect(slow.suggestSmaller).toBe(true);

    // the SLOW mode is irrelevant as long as the other one clears the bar
    const mixed = await runDualSelfTest(providerDouble({ ok: true, outputTokens: 1 }), {
      clock: clockWithStep(1000),
      log: log(),
      hasDedicatedGpu: false,
      cpuProvider: () => Promise.resolve(providerDouble({ ok: true, outputTokens: SELF_TEST_MIN_TOK_PER_SEC })),
    });
    expect(mixed.suggestSmaller).toBe(false);
    // the suggestion is advisory: the outcome never names a different tier
    expect(Object.keys(mixed)).toEqual(['result', 'bench', 'forceCpu', 'suggestSmaller']);
  });

  it('both modes failing reports the failure without a bench and without forcing the CPU', async () => {
    const outcome = await runDualSelfTest(providerDouble({ throws: new LlmError('bad_output') }), {
      clock: clockWithStep(1000),
      log: log(),
      hasDedicatedGpu: false,
      cpuProvider: () => Promise.resolve(providerDouble({ throws: new LlmError('network') })),
    });
    expect(outcome).toMatchObject({ bench: null, forceCpu: false, suggestSmaller: false });
    expect(outcome.result).toMatchObject({ ok: false, code: 'LLM_BAD_OUTPUT' });
  });

  it('a CPU provider that cannot be built leaves the GPU measurement standing', async () => {
    const outcome = await runDualSelfTest(providerDouble({ ok: true, outputTokens: 40 }), {
      clock: clockWithStep(1000),
      log: log(),
      hasDedicatedGpu: false,
      cpuProvider: () => Promise.reject(new Error('spawn failed')),
    });
    expect(outcome.bench).toEqual({ gpuTokPerSec: 40, cpuTokPerSec: null, chosen: 'gpu' });
    expect(outcome.forceCpu).toBe(false);
  });

  it('an abort stops the dual run before the second measurement', async () => {
    const cpu = vi.fn(() => Promise.resolve(providerDouble({ ok: true })));
    const outcome = await runDualSelfTest(providerDouble({ throws: new LlmError('aborted') }), {
      clock: clockWithStep(1000),
      log: log(),
      hasDedicatedGpu: false,
      cpuProvider: cpu,
    });
    expect(cpu).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      result: { ok: false, tokPerSec: null, usedCpuFallback: false, device: null, code: 'ABORTED' },
      bench: null,
      forceCpu: false,
      suggestSmaller: false,
    });
  });
});
