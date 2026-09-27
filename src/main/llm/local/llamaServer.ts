// src/main/llm/local/llamaServer.ts - llama-server.exe runtime (build-plan section 3; owner W1-07). S-SPAWN / S-FETCH / S-CLOCK / S-RAND.
import path from 'node:path';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcess } from 'node:child_process';
import type { Clock, FetchFn, Logger, RandomSource, SpawnFn } from '../../deps';
import type { ChildHandle, ChildSpec } from '../../proc/supervisor';
import type { EpochMs, ModelTier } from '../../../shared/types';
import type { ErrorCode } from '../../../shared/errors';
import { checkVcRuntime, isVcRuntimeExitCode } from './hardware';

export type LlamaRuntimeStatus = 'stopped' | 'starting' | 'ready' | 'failed';
export interface LlamaRuntime {
  /** Spawns llama-server (fresh port + LLAMA_API_KEY via env, never argv) if needed and waits for GET /health 200. */
  ensureStarted(): Promise<{ port: number; apiKey: string }>;
  stop(): Promise<void>;
  childSpec(): ChildSpec; // registered with the Supervisor by compose.ts
  status(): { state: LlamaRuntimeStatus; code: ErrorCode | null; device: 'gpu' | 'cpu' | null };
}
export interface LlamaRuntimeDeps {
  exePath: string; // <resources>\llama\llama-server.exe (or the WCA_LLAMA_CMD command in e2e builds)
  exeArgs?: readonly string[];
  llamaDir: string; // for the VC++ runtime pre-flight (msvcp140.dll, vcruntime140*.dll) -> LLM_VCREDIST_MISSING
  modelPath: () => string; // <userData>\models\<file>.gguf of the selected tier
  tier: () => ModelTier;
  forceCpu: () => boolean;
  acceleration: () => 'auto' | 'off';
  freePort: (opts: { exclude?: number[] }) => Promise<number>;
  spawn: SpawnFn;
  fetch: FetchFn;
  clock: Clock;
  random: RandomSource;
  log: Logger;
  // --- ADDITIVE, all optional: every caller written against the frozen seam still compiles (build-plan rule 7). ---
  /** S-FS for the VC++ CRT pre-flight. */
  exists?: (p: string) => boolean;
  /** RAM probe for the conditional `--cache-ram 0` (ARCH section 9: RAM < 16 GiB). */
  totalMemBytes?: () => number;
  /** `--device VulkanN` when both an iGPU and a dGPU are listed (see hardware.preferredDeviceArg). */
  preferredDevice?: () => string | null;
  /** os.setPriority(pid, PRIORITY_BELOW_NORMAL); injected so the test can assert the call. */
  setPriority?: (pid: number, priority: number) => void;
  /** Readiness budget; ARCH section 9 says 180 s for a cold multi-GB model. */
  readyTimeoutMs?: number;
  healthPollMs?: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// constants (exported so tests assert the real values, not a copy)
// ---------------------------------------------------------------------------------------------------------------------
export const LLAMA_CONTEXT_SIZE = 8192;
export const LLAMA_SLEEP_IDLE_SECONDS = 600;
export const LLAMA_READY_TIMEOUT_MS = 180_000;
export const LLAMA_HEALTH_POLL_MS = 500;
export const LOW_RAM_BYTES = 16 * 1024 ** 3;
/** Minimal child environment (ARCH section 9). HTTPS_PROXY / NODE_EXTRA_CA_CERTS / SSL_CERT_FILE are NEVER propagated. */
export const LLAMA_ENV_PASSTHROUGH: readonly string[] = ['SystemRoot', 'windir', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS'];
export const LLAMA_BACKOFF_MS: readonly number[] = [2000, 10_000];
export const LLAMA_BREAKER = { maxExits: 3, windowMs: 600_000 } as const;
export const LLAMA_STABLE_AFTER_MS = 60_000;

/** Marker-only stdout filter: llama-server logs can contain prompt text, so ONLY these names ever reach the logger. */
export const LLAMA_MARKERS: Readonly<Record<string, RegExp>> = {
  server_listening: /\bserver is listening\b/i,
  model_loaded: /\bmodel loaded\b/i,
  loading_model: /\bloading model\b/i,
  device_lost: /\b(?:devicelosterror|device lost|erroroutofdevicememory)\b/i,
  out_of_memory: /\bout of memory\b/i,
  vulkan_devices: /\bggml_vulkan: found\b/i,
};

// ANSI CSI/OSC stripping: the ESC and BEL bytes below are literal control characters on purpose.
const ANSI_RE = /\[[0-9;?]*[ -/]*[@-~]|\][^]*(?:|\\)/g;

/** Line-anchored marker names for one already-decoded chunk. Raw text never leaves this function. */
export function matchLlamaMarkers(chunk: string): string[] {
  const names: string[] = [];
  for (const line of chunk.replace(ANSI_RE, '').split(/\r?\n/)) {
    if (line === '') continue;
    for (const [name, re] of Object.entries(LLAMA_MARKERS)) {
      if (re.test(line) && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

export interface LlamaArgsInput {
  modelPath: string;
  port: number;
  lowRam: boolean;
  forceCpu: boolean;
  deviceArg: string | null;
}

/** Exact flag array of ARCHITECTURE section 9 / TESTS 3.5. No `--log-file`; the API key is NEVER an argument. */
export function buildLlamaArgs(input: LlamaArgsInput): string[] {
  const args = [
    '-m',
    input.modelPath,
    '--host',
    '127.0.0.1',
    '--port',
    String(input.port),
    '--jinja',
    '--no-webui',
    '--offline',
    '-c',
    String(LLAMA_CONTEXT_SIZE),
    '-np',
    '1',
    '--sleep-idle-seconds',
    String(LLAMA_SLEEP_IDLE_SECONDS),
    '--reasoning-budget',
    '0',
  ];
  if (input.lowRam) args.push('--cache-ram', '0');
  if (input.forceCpu) args.push('--device', 'none');
  else if (input.deviceArg !== null) args.push('--device', input.deviceArg);
  return args;
}

/** Minimal env block + the key. Nothing else from `process.env` is forwarded. */
export function buildLlamaEnv(apiKey: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { LLAMA_API_KEY: apiKey };
  for (const key of LLAMA_ENV_PASSTHROUGH) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  return env;
}

export class LlamaRuntimeError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'LlamaRuntimeError';
    this.code = code;
  }
}

const PRIORITY_BELOW_NORMAL = os.constants.priority.PRIORITY_BELOW_NORMAL;

export function createLlamaRuntime(deps: LlamaRuntimeDeps): LlamaRuntime {
  const log = deps.log.child('llama');
  const readyTimeoutMs = deps.readyTimeoutMs ?? LLAMA_READY_TIMEOUT_MS;
  const healthPollMs = deps.healthPollMs ?? LLAMA_HEALTH_POLL_MS;

  let state: LlamaRuntimeStatus = 'stopped';
  let code: ErrorCode | null = null;
  let device: 'gpu' | 'cpu' | null = null;
  let child: ChildProcess | null = null;
  let port = 0;
  let apiKey = '';
  let exitInfo: { code: number | null; signal: string | null } | null = null;
  /** The instant `deps.spawn()` returned - the value the Supervisor must stamp into the pid file (proc/supervisor.ts
   *  ChildHandle.spawnedAt). readiness can be tens of seconds later on a cold multi-GB gguf, and proc/reaper.ts only
   *  reaps an orphan whose Win32_Process.CreationDate is within +-2 s of that stamp. */
  let spawnedAt: EpochMs = 0 as EpochMs;
  let starting: Promise<{ port: number; apiKey: string }> | null = null;
  const exitListeners: Array<(info: { code: number | null; signal: string | null }) => void> = [];
  const usedPorts: number[] = [];

  /** Read through a function so TypeScript does not narrow the closure variable away inside the readiness loop. */
  const currentExit = (): { code: number | null; signal: string | null } | null => exitInfo;

  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      deps.clock.setTimeout(resolve, ms);
    });

  const pipeMarkers = (stream: NodeJS.ReadableStream | null, channel: string): void => {
    if (stream === null) return;
    const decoder = new StringDecoder('utf8');
    stream.on('data', (chunk: Buffer) => {
      for (const name of matchLlamaMarkers(decoder.write(chunk))) log.info('llama_marker', { marker: name, channel });
    });
  };

  const health = async (signal?: AbortSignal): Promise<number> => {
    const res = await deps.fetch(`http://127.0.0.1:${String(port)}/health`, { redirect: 'error', signal });
    return res.status;
  };

  const killChild = (): void => {
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  };

  const spawnOnce = async (): Promise<{ port: number; apiKey: string }> => {
    const preflight = checkVcRuntime({ llamaDir: deps.llamaDir, exists: deps.exists });
    if (!preflight.ok) {
      state = 'failed';
      code = 'LLM_VCREDIST_MISSING';
      device = null;
      log.error('llama_vcredist_missing', { missing: preflight.missing.length });
      throw new LlamaRuntimeError('LLM_VCREDIST_MISSING');
    }
    const modelPath = deps.modelPath();
    if (modelPath === '') {
      state = 'failed';
      code = 'MODEL_MISSING';
      throw new LlamaRuntimeError('MODEL_MISSING');
    }

    port = await deps.freePort({ exclude: [...usedPorts] });
    usedPorts.push(port);
    apiKey = Buffer.from(deps.random.bytes(32)).toString('hex');
    exitInfo = null;

    const forceCpu = deps.forceCpu() || deps.acceleration() === 'off';
    const lowRam = (deps.totalMemBytes?.() ?? LOW_RAM_BYTES) < LOW_RAM_BYTES;
    const deviceArg = forceCpu ? null : (deps.preferredDevice?.() ?? null);
    const flags = buildLlamaArgs({ modelPath, port, lowRam, forceCpu, deviceArg });
    const args = [...(deps.exeArgs ?? []), ...flags];

    state = 'starting';
    code = null;
    device = forceCpu ? 'cpu' : 'gpu';
    const spawned = deps.spawn(deps.exePath, args, {
      cwd: path.dirname(deps.exePath),
      env: buildLlamaEnv(apiKey),
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = spawned;
    spawnedAt = deps.clock.now();
    log.info('llama_spawned', { tier: deps.tier(), port, device, lowRam });
    spawned.on('exit', (exitCode, signal) => {
      exitInfo = { code: exitCode, signal };
      if (isVcRuntimeExitCode(exitCode)) {
        state = 'failed';
        code = 'LLM_VCREDIST_MISSING';
      } else if (state !== 'stopped') {
        state = 'failed';
        if (code === null) code = 'LLM_LOCAL_FAILED';
      }
      for (const cb of exitListeners.splice(0)) cb({ code: exitCode, signal });
    });
    pipeMarkers(spawned.stdout, 'stdout');
    pipeMarkers(spawned.stderr, 'stderr');
    if (typeof spawned.pid === 'number') {
      try {
        (deps.setPriority ?? os.setPriority.bind(os))(spawned.pid, PRIORITY_BELOW_NORMAL);
      } catch {
        log.warn('llama_priority_failed');
      }
    }

    const deadline = deps.clock.now() + readyTimeoutMs;
    for (;;) {
      const info = currentExit();
      if (info !== null) {
        const failure: ErrorCode = isVcRuntimeExitCode(info.code) ? 'LLM_VCREDIST_MISSING' : 'LLM_LOCAL_FAILED';
        state = 'failed';
        code = failure;
        throw new LlamaRuntimeError(failure);
      }
      let status: number;
      try {
        status = await health();
      } catch {
        status = 0;
      }
      if (status === 200) {
        // Re-check the exit AFTER the fetch resolves, not only at the top of the loop: the 200 can already be on the
        // wire when the process dies (OOM, Vulkan device lost), and the 'exit' event is then delivered while this
        // await is pending. Without this check `state = 'ready'` overwrites the exit handler's 'failed' and the
        // Supervisor is handed a ChildHandle for a corpse.
        const raced = currentExit();
        if (raced !== null) {
          const failure: ErrorCode = isVcRuntimeExitCode(raced.code) ? 'LLM_VCREDIST_MISSING' : 'LLM_LOCAL_FAILED';
          state = 'failed';
          code = failure;
          log.warn('llama_exit_raced_ready', { exitCode: raced.code ?? -1 });
          throw new LlamaRuntimeError(failure);
        }
        state = 'ready';
        code = null;
        log.info('llama_ready', { port, device });
        return { port, apiKey };
      }
      if (deps.clock.now() >= deadline) {
        state = 'failed';
        code = 'LLM_LOCAL_FAILED';
        killChild();
        log.error('llama_ready_timeout');
        throw new LlamaRuntimeError('LLM_LOCAL_FAILED');
      }
      await delay(healthPollMs);
    }
  };

  const runtime: LlamaRuntime = {
    ensureStarted: async () => {
      if (state === 'ready' && child !== null && exitInfo === null) return { port, apiKey };
      if (starting !== null) return starting;
      starting = spawnOnce().finally(() => {
        starting = null;
      });
      return starting;
    },
    stop: async () => {
      if (child === null) {
        state = 'stopped';
        code = null;
        device = null;
        return;
      }
      state = 'stopped';
      const done = new Promise<void>((resolve) => {
        if (exitInfo !== null) {
          resolve();
          return;
        }
        exitListeners.push(() => resolve());
      });
      killChild();
      await done;
      child = null;
      device = null;
      code = null;
      log.info('llama_stopped');
    },
    childSpec: (): ChildSpec => ({
      name: 'llama',
      start: async (): Promise<ChildHandle> => {
        await runtime.ensureStarted();
        const spawned = child;
        if (spawned === null) throw new LlamaRuntimeError('LLM_LOCAL_FAILED');
        // Never hand the Supervisor a handle for a child whose exit is already known: its onExit() calls back inline,
        // which re-enters the Supervisor in the middle of its own start. A failed start is the honest answer - the
        // Supervisor counts it as an exit and backs off.
        if (exitInfo !== null) throw new LlamaRuntimeError('LLM_LOCAL_FAILED');
        return {
          pid: spawned.pid ?? 0,
          exePath: deps.exePath,
          spawnedAt,
          kill: () => killChild(),
          onExit: (cb) => {
            if (exitInfo !== null) {
              cb(exitInfo);
              return;
            }
            exitListeners.push(cb);
          },
        };
      },
      probe: async () => {
        try {
          const status = await health();
          return status === 200 || status === 503;
        } catch {
          return false;
        }
      },
      probeIntervalMs: 20_000,
      probeMisses: 3,
      backoffMs: LLAMA_BACKOFF_MS,
      breaker: { ...LLAMA_BREAKER },
      stableAfterMs: LLAMA_STABLE_AFTER_MS,
      terminal: () => code === 'LLM_VCREDIST_MISSING',
    }),
    status: () => ({ state, code, device }),
  };
  return runtime;
}
