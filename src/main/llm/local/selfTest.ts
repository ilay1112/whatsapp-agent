// src/main/llm/local/selfTest.ts - local model self-test (build-plan section 3; owner W1-07).
import type { LlmProvider } from '../types';
import { LlmError } from '../types';
import type { Clock, Logger } from '../../deps';
import type { ErrorCode } from '../../../shared/errors';
import { providerErrorToErrorCode } from '../../../shared/errors';
import type { JsonSchemaLcd } from '../../../shared/types';

export interface SelfTestResult {
  ok: boolean;
  tokPerSec: number | null;
  usedCpuFallback: boolean; // [R2] dual self-test: GPU first, CPU fallback
  device: 'gpu' | 'cpu' | null;
  code: ErrorCode | null;
}
export interface SelfTestDeps {
  clock: Clock;
  log: Logger;
  signal?: AbortSignal;
  /** Re-runs the provider with forceCpu when the GPU attempt fails; injected so tests can count attempts. */
  cpuFallbackProvider?: () => Promise<LlmProvider>;
}

// ---------------------------------------------------------------------------------------------------------------------
// the fixed prompt (never message text, never a name: the self-test must be identical on every machine)
// ---------------------------------------------------------------------------------------------------------------------
export const SELF_TEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: { ok: { type: 'boolean', description: 'Always true.' } },
} as const satisfies JsonSchemaLcd;

export const SELF_TEST_SYSTEM = 'You are a JSON generator. Answer with JSON only.';
export const SELF_TEST_USER = 'Reply with the JSON object {"ok": true} and nothing else.';
export const SELF_TEST_MAX_TOKENS = 64;
/** llama-server reports usage; when it does not, this stands in so tok/s stays comparable between the two runs. */
export const SELF_TEST_ASSUMED_TOKENS = 8;
/** Only below this does the UI *suggest* a smaller tier - it never auto-downgrades (ARCH section 9). */
export const SELF_TEST_MIN_TOK_PER_SEC = 5;

interface Measurement {
  ok: boolean;
  tokPerSec: number | null;
  code: ErrorCode | null;
}

function toErrorCode(err: unknown): ErrorCode {
  if (err instanceof LlmError) return providerErrorToErrorCode('local', err.code);
  return 'LLM_LOCAL_FAILED';
}

/** One tiny structured() call, strictly parsed, timed on the injected clock. Never throws. */
async function measure(provider: LlmProvider, deps: SelfTestDeps): Promise<Measurement> {
  let outputTokens = 0;
  const startedAt = deps.clock.now();
  try {
    const answer = await provider.structured<{ ok?: unknown }>(
      [
        { role: 'system', content: SELF_TEST_SYSTEM },
        { role: 'user', content: SELF_TEST_USER },
      ],
      SELF_TEST_SCHEMA,
      {
        signal: deps.signal ?? new AbortController().signal,
        maxOutputTokens: SELF_TEST_MAX_TOKENS,
        purpose: 'extract',
        onUsage: (u) => {
          outputTokens = u.outputTokens;
        },
      },
    );
    const elapsedMs = Math.max(1, deps.clock.now() - startedAt);
    if (typeof answer !== 'object' || answer === null || answer.ok !== true) {
      deps.log.warn('self_test_bad_output');
      return { ok: false, tokPerSec: null, code: 'LLM_BAD_OUTPUT' };
    }
    const tokens = outputTokens > 0 ? outputTokens : SELF_TEST_ASSUMED_TOKENS;
    return { ok: true, tokPerSec: Math.round((tokens / (elapsedMs / 1000)) * 100) / 100, code: null };
  } catch (err) {
    const code = toErrorCode(err);
    deps.log.warn('self_test_failed', { code });
    return { ok: false, tokPerSec: null, code };
  }
}

/** One tiny structured() call with a fixed prompt; parses the answer strictly; measures tok/s. */
export function runSelfTest(provider: LlmProvider, deps: SelfTestDeps): Promise<SelfTestResult> {
  return (async () => {
    const first = await measure(provider, deps);
    if (first.ok) return { ok: true, tokPerSec: first.tokPerSec, usedCpuFallback: false, device: 'gpu', code: null };
    if (first.code === 'ABORTED' || deps.cpuFallbackProvider === undefined) {
      return { ok: false, tokPerSec: null, usedCpuFallback: false, device: null, code: first.code };
    }
    // Garbage / timeout / exit with acceleration Auto => retry ONCE with --device none (ARCH section 9).
    deps.log.info('self_test_cpu_retry');
    let cpu: LlmProvider;
    try {
      cpu = await deps.cpuFallbackProvider();
    } catch {
      return { ok: false, tokPerSec: null, usedCpuFallback: true, device: null, code: 'LLM_LOCAL_FAILED' };
    }
    const second = await measure(cpu, deps);
    return {
      ok: second.ok,
      tokPerSec: second.tokPerSec,
      usedCpuFallback: true,
      device: second.ok ? 'cpu' : null,
      code: second.code,
    };
  })();
}

// ---------------------------------------------------------------------------------------------------------------------
// [R2] dual self-test for machines with NO dedicated GPU. ADDITIVE to the frozen seam of wave0-seams.md section 7.
// ---------------------------------------------------------------------------------------------------------------------
export interface DualSelfTestDeps extends SelfTestDeps {
  /** From probeHardware(): false => time the prompt twice (auto vs --device none) and keep the faster mode. */
  hasDedicatedGpu: boolean;
  /** Builds a provider whose runtime was started with `--device none`. */
  cpuProvider: () => Promise<LlmProvider>;
}
export interface DualSelfTestOutcome {
  result: SelfTestResult;
  /** Stored in `model_files.bench_json`; null on machines with a dedicated GPU (only one run happens there). */
  bench: { gpuTokPerSec: number | null; cpuTokPerSec: number | null; chosen: 'gpu' | 'cpu' } | null;
  /** Persisted into settings.llm.local.forceCpu. */
  forceCpu: boolean;
  /** The UI may SUGGEST a smaller tier; it never switches by itself. */
  suggestSmaller: boolean;
}

export function runDualSelfTest(gpuProvider: LlmProvider, deps: DualSelfTestDeps): Promise<DualSelfTestOutcome> {
  return (async () => {
    if (deps.hasDedicatedGpu) {
      const result = await runSelfTest(gpuProvider, { ...deps, cpuFallbackProvider: deps.cpuProvider });
      return {
        result,
        bench: null,
        forceCpu: result.usedCpuFallback,
        suggestSmaller: result.ok && result.tokPerSec !== null && result.tokPerSec < SELF_TEST_MIN_TOK_PER_SEC,
      };
    }
    const gpu = await measure(gpuProvider, deps);
    if (gpu.code === 'ABORTED') {
      return {
        result: { ok: false, tokPerSec: null, usedCpuFallback: false, device: null, code: 'ABORTED' },
        bench: null,
        forceCpu: false,
        suggestSmaller: false,
      };
    }
    let cpu: Measurement;
    try {
      cpu = await measure(await deps.cpuProvider(), deps);
    } catch {
      cpu = { ok: false, tokPerSec: null, code: 'LLM_LOCAL_FAILED' };
    }
    const gpuRate = gpu.ok ? (gpu.tokPerSec ?? 0) : -1;
    const cpuRate = cpu.ok ? (cpu.tokPerSec ?? 0) : -1;
    if (gpuRate < 0 && cpuRate < 0) {
      return {
        result: { ok: false, tokPerSec: null, usedCpuFallback: true, device: null, code: gpu.code ?? cpu.code },
        bench: null,
        forceCpu: false,
        suggestSmaller: false,
      };
    }
    const chosen: 'gpu' | 'cpu' = cpuRate > gpuRate ? 'cpu' : 'gpu';
    const best = Math.max(gpuRate, cpuRate);
    deps.log.info('self_test_dual', { chosen, gpu: gpuRate, cpu: cpuRate });
    return {
      result: {
        ok: true,
        tokPerSec: chosen === 'cpu' ? cpu.tokPerSec : gpu.tokPerSec,
        usedCpuFallback: chosen === 'cpu',
        device: chosen,
        code: null,
      },
      bench: { gpuTokPerSec: gpu.ok ? gpu.tokPerSec : null, cpuTokPerSec: cpu.ok ? cpu.tokPerSec : null, chosen },
      forceCpu: chosen === 'cpu',
      suggestSmaller: best < SELF_TEST_MIN_TOK_PER_SEC,
    };
  })();
}
