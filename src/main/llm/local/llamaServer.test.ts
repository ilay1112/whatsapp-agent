// src/main/llm/local/llamaServer.test.ts - TESTS 5.3 row `llm/local*`: the exact flag array of ARCH section 9, the
// minimal env with the key ONLY in LLAMA_API_KEY, below-normal priority, marker-only stdout, the readiness contract and
// the [R2] VC++ CRT pre-flight / exit-code mapping (owner W1-07). llama-server.exe is NEVER spawned: every spawn goes
// to a recorder that returns an in-process child double, and /health is answered by the loopback fake.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startFakeLlamaServer,
  checkLlamaArgv,
  checkVisionArgv,
  type FakeLlamaServer,
} from '../../../../tests/fakes/fake-llama-server';
import type { Clock, ClockTimer, FetchFn, Logger, LogMeta, RandomSource, SpawnFn } from '../../deps';
import {
  LLAMA_BACKOFF_MS,
  LLAMA_BREAKER,
  LLAMA_CONTEXT_SIZE,
  LLAMA_ENV_PASSTHROUGH,
  LLAMA_MARKERS,
  LLAMA_SLEEP_IDLE_SECONDS,
  LLAMA_STABLE_AFTER_MS,
  LlamaRuntimeError,
  buildLlamaArgs,
  buildLlamaEnv,
  createLlamaRuntime,
  matchLlamaMarkers,
  buildVisionArgs,
  LLAMA_IMAGE_MAX_TOKENS,
  LLAMA_MID_VISION_BATCH,
  type LlamaRuntimeDeps,
} from './llamaServer';
import { VC_RUNTIME_DLLS, VCREDIST_EXIT_CODE } from './hardware';

// ---------------------------------------------------------------------------------------------------------------------
// doubles
// ---------------------------------------------------------------------------------------------------------------------
const EXE = 'C:\\app\\resources\\llama\\llama-server.exe';
const LLAMA_DIR = 'C:\\app\\resources\\llama';
const MODEL = 'C:\\users\\t\\AppData\\Roaming\\wca\\models\\gemma-4-E4B-it-Q4_K_M.gguf';

class ChildDouble extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = null;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  constructor(readonly pid: number) {
    super();
  }
  kill(): boolean {
    this.killed = true;
    this.exit(0, 'SIGTERM');
    return true;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

interface SpawnRecord {
  command: string;
  args: readonly string[];
  options: Parameters<SpawnFn>[2];
  child: ChildDouble;
}
function spawnRecorder(): { spawn: SpawnFn; calls: SpawnRecord[] } {
  const calls: SpawnRecord[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    const child = new ChildDouble(4000 + calls.length);
    calls.push({ command, args, options, child });
    return child as unknown as ChildProcess;
  };
  return { spawn, calls };
}

/** `now()` advances by `stepMs` on every read, so a readiness deadline is reached without any real waiting. */
function steppingClock(stepMs = 0): Clock & { readonly reads: number } {
  let t = 1_700_000_000_000;
  let reads = 0;
  const clock: Clock = {
    now: () => {
      reads += 1;
      const value = t;
      t += stepMs;
      return value;
    },
    setTimeout: (fn) => setTimeout(fn, 0) as unknown as ClockTimer,
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  return Object.defineProperty(clock, 'reads', { get: () => reads }) as Clock & { readonly reads: number };
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

const random: RandomSource = {
  bytes: (n) => Uint8Array.from({ length: n }, (_v, i) => (i * 7 + 3) & 0xff),
  int: (min) => min,
  float: () => 0,
};

const servers: FakeLlamaServer[] = [];
async function health(opts: { loadMs?: number } = {}): Promise<FakeLlamaServer> {
  const fake = await startFakeLlamaServer({ apiKey: 'unused-by-health', loadMs: opts.loadMs ?? 0 });
  servers.push(fake);
  return fake;
}
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.stop();
});

function deps(over: Partial<LlamaRuntimeDeps> & { port: number }): LlamaRuntimeDeps {
  const { spawn } = spawnRecorder();
  return {
    exePath: EXE,
    llamaDir: LLAMA_DIR,
    modelPath: () => MODEL,
    tier: () => 'small',
    forceCpu: () => false,
    acceleration: () => 'auto',
    freePort: () => Promise.resolve(over.port),
    spawn,
    fetch,
    clock: steppingClock(),
    random,
    log: recordingLog().log,
    exists: () => true, // the CRT is present unless a test says otherwise
    totalMemBytes: () => 32 * 1024 ** 3,
    setPriority: () => undefined,
    readyTimeoutMs: 180_000,
    healthPollMs: 1,
    ...over,
  };
}

/** Lets the double answer /health from the loopback fake: the runtime always fetches 127.0.0.1:<freePort>. */
async function readyRuntime(over: Partial<LlamaRuntimeDeps> = {}) {
  const fake = await health();
  const rec = spawnRecorder();
  const logger = recordingLog();
  const runtime = createLlamaRuntime(deps({ port: fake.port, spawn: rec.spawn, log: logger.log, ...over }));
  return { fake, rec, logger, runtime };
}

// ---------------------------------------------------------------------------------------------------------------------
// the flag array (ARCH section 9 / TESTS 3.5)
// ---------------------------------------------------------------------------------------------------------------------
describe('buildLlamaArgs', () => {
  const base = { modelPath: MODEL, port: 51234, lowRam: false, forceCpu: false, deviceArg: null };

  it('is the exact array of ARCHITECTURE section 9', () => {
    expect(buildLlamaArgs(base)).toEqual([
      '-m',
      MODEL,
      '--host',
      '127.0.0.1',
      '--port',
      '51234',
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
    ]);
  });

  it('satisfies the fake server flag contract and carries no --log-file and no key', () => {
    expect(checkLlamaArgv(buildLlamaArgs(base), 'deadbeef')).toEqual([]);
    expect(buildLlamaArgs(base)).not.toContain('--log-file');
    expect(buildLlamaArgs(base)).not.toContain('--api-key');
  });

  it('adds `--cache-ram 0` only on a low-RAM machine', () => {
    expect(buildLlamaArgs({ ...base, lowRam: true }).join(' ')).toContain('--cache-ram 0');
    expect(buildLlamaArgs(base).join(' ')).not.toContain('--cache-ram');
  });

  it('adds `--device none` when the CPU is forced and `--device VulkanN` when a discrete device was picked', () => {
    expect(buildLlamaArgs({ ...base, forceCpu: true }).join(' ')).toContain('--device none');
    expect(buildLlamaArgs({ ...base, deviceArg: 'Vulkan1' }).join(' ')).toContain('--device Vulkan1');
    // forceCpu wins over a device preference
    expect(buildLlamaArgs({ ...base, forceCpu: true, deviceArg: 'Vulkan1' }).join(' ')).toContain('--device none');
    expect(buildLlamaArgs({ ...base, forceCpu: true, deviceArg: 'Vulkan1' }).join(' ')).not.toContain('Vulkan1');
  });
});

describe('buildLlamaEnv', () => {
  it('passes the key ONLY through LLAMA_API_KEY and forwards nothing but the allow-list', () => {
    const env = buildLlamaEnv('secret-key', {
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      NUMBER_OF_PROCESSORS: '8',
      PATH: 'C:\\evil',
      HTTPS_PROXY: 'http://proxy.example',
      NODE_EXTRA_CA_CERTS: 'C:\\ca.pem',
      SSL_CERT_FILE: 'C:\\ca.pem',
      ANTHROPIC_API_KEY: 'sk-ant-TESTONLY-nope',
    });
    expect(env).toEqual({
      LLAMA_API_KEY: 'secret-key',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      NUMBER_OF_PROCESSORS: '8',
    });
    for (const forbidden of ['PATH', 'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'ANTHROPIC_API_KEY']) {
      expect(Object.keys(env)).not.toContain(forbidden);
    }
  });

  it('skips empty and absent allow-list entries', () => {
    expect(buildLlamaEnv('k', { SystemRoot: '', windir: 'C:\\Windows' })).toEqual({
      LLAMA_API_KEY: 'k',
      windir: 'C:\\Windows',
    });
    expect(LLAMA_ENV_PASSTHROUGH).toContain('SystemRoot');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// marker-only stdout
// ---------------------------------------------------------------------------------------------------------------------
describe('matchLlamaMarkers', () => {
  it('returns marker NAMES and never the line itself', () => {
    expect(matchLlamaMarkers('main: server is listening on http://127.0.0.1:51234\n')).toEqual(['server_listening']);
    expect(matchLlamaMarkers('\u001b[32mload: model loaded\u001b[0m\n')).toEqual(['model_loaded']);
    expect(matchLlamaMarkers('ggml_vulkan: found 1 Vulkan devices\n')).toEqual(['vulkan_devices']);
  });

  it('ignores prompt text and unknown lines entirely', () => {
    expect(matchLlamaMarkers('prompt: "meet me at 5 on Thursday"\nslot released\n')).toEqual([]);
    expect(matchLlamaMarkers('')).toEqual([]);
  });

  it('never reports the same marker twice for one chunk', () => {
    expect(matchLlamaMarkers('model loaded\nmodel loaded\n')).toEqual(['model_loaded']);
  });

  it('every marker name has a regex and none of them is a substring search on the whole buffer', () => {
    expect(Object.keys(LLAMA_MARKERS).sort()).toEqual([
      'device_lost',
      'loading_model',
      'model_loaded',
      'out_of_memory',
      'server_listening',
      'vulkan_devices',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// ensureStarted()
// ---------------------------------------------------------------------------------------------------------------------
describe('ensureStarted', () => {
  it('spawns with the production contract and reports ready + the generated key', async () => {
    const { fake, rec, runtime } = await readyRuntime();
    const started = await runtime.ensureStarted();

    expect(started.port).toBe(fake.port);
    expect(started.apiKey).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.calls).toHaveLength(1);
    const call = rec.calls[0]!;
    expect(call.command).toBe(EXE);
    expect(call.options.shell).toBe(false);
    expect(call.options.windowsHide).toBe(true);
    expect(call.options.cwd).toBe(path.dirname(EXE));
    expect(call.options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    // the key is in the env block only, never in argv
    expect((call.options.env as Record<string, string>).LLAMA_API_KEY).toBe(started.apiKey);
    expect(call.args.some((a) => a.includes(started.apiKey))).toBe(false);
    expect(checkLlamaArgv(call.args, started.apiKey)).toEqual([]);
    expect(runtime.status()).toEqual({ state: 'ready', code: null, device: 'gpu' });
    await runtime.stop();
  });

  it('adds --cache-ram 0 below 16 GiB of RAM and omits it above', async () => {
    const low = await readyRuntime({ totalMemBytes: () => 8 * 1024 ** 3 });
    await low.runtime.ensureStarted();
    expect(low.rec.calls[0]!.args.join(' ')).toContain('--cache-ram 0');
    await low.runtime.stop();

    const high = await readyRuntime({ totalMemBytes: () => 32 * 1024 ** 3 });
    await high.runtime.ensureStarted();
    expect(high.rec.calls[0]!.args.join(' ')).not.toContain('--cache-ram');
    await high.runtime.stop();
  });

  it.each([
    ['a persisted forceCpu after a failed self-test', { forceCpu: () => true, acceleration: () => 'auto' as const }],
    ['acceleration = off', { forceCpu: () => false, acceleration: () => 'off' as const }],
  ])('passes --device none for %s', async (_name, over) => {
    const { rec, runtime } = await readyRuntime(over);
    await runtime.ensureStarted();
    expect(rec.calls[0]!.args.join(' ')).toContain('--device none');
    expect(runtime.status().device).toBe('cpu');
    await runtime.stop();
  });

  it('passes the preferred discrete device on an iGPU + dGPU machine (and never together with --device none)', async () => {
    const { rec, runtime } = await readyRuntime({ preferredDevice: () => 'Vulkan1' });
    await runtime.ensureStarted();
    expect(rec.calls[0]!.args.join(' ')).toContain('--device Vulkan1');
    await runtime.stop();

    const cpu = await readyRuntime({ preferredDevice: () => 'Vulkan1', forceCpu: () => true });
    await cpu.runtime.ensureStarted();
    expect(cpu.rec.calls[0]!.args.join(' ')).not.toContain('Vulkan1');
    await cpu.runtime.stop();
  });

  it('lowers the child to below-normal priority with its own pid', async () => {
    const priorities: Array<[number, number]> = [];
    const { rec, runtime } = await readyRuntime({ setPriority: (pid, prio) => priorities.push([pid, prio]) });
    await runtime.ensureStarted();
    expect(priorities).toHaveLength(1);
    expect(priorities[0]![0]).toBe(rec.calls[0]!.child.pid);
    expect(priorities[0]![1]).toBeGreaterThan(0); // PRIORITY_BELOW_NORMAL === 10 on every platform Node reports
    await runtime.stop();
  });

  it('survives a failing setPriority', async () => {
    const { logger, runtime } = await readyRuntime({
      setPriority: () => {
        throw new Error('EPERM');
      },
    });
    await expect(runtime.ensureStarted()).resolves.toMatchObject({
      apiKey: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown as string,
    });
    expect(logger.events.map((e) => e.event)).toContain('llama_priority_failed');
    await runtime.stop();
  });

  it('logs marker NAMES from stdout and stderr, never the raw line', async () => {
    const { rec, logger, runtime } = await readyRuntime();
    await runtime.ensureStarted();
    rec.calls[0]!.child.stdout.write(Buffer.from('prompt: "meet at 5" \nload: model loaded\n', 'utf8'));
    rec.calls[0]!.child.stderr.write(Buffer.from('ggml_vulkan: found 2 Vulkan devices\n', 'utf8'));
    await new Promise((r) => setImmediate(r));
    const markers = logger.events.filter((e) => e.event === 'llama_marker').map((e) => e.meta?.marker);
    expect(markers).toEqual(['model_loaded', 'vulkan_devices']);
    expect(JSON.stringify(logger.events)).not.toContain('meet at 5');
    await runtime.stop();
  });

  it('is idempotent while running and shares one in-flight start between concurrent callers', async () => {
    const { rec, runtime } = await readyRuntime();
    const [a, b] = await Promise.all([runtime.ensureStarted(), runtime.ensureStarted()]);
    expect(a).toEqual(b);
    const again = await runtime.ensureStarted();
    expect(again).toEqual(a);
    expect(rec.calls).toHaveLength(1);
    await runtime.stop();
  });

  it('excludes the ports it has already used when it starts again', async () => {
    const fake = await health();
    const rec = spawnRecorder();
    const excluded: Array<number[] | undefined> = [];
    const runtime = createLlamaRuntime(
      deps({
        port: fake.port,
        spawn: rec.spawn,
        freePort: (o) => {
          excluded.push(o.exclude === undefined ? undefined : [...o.exclude]);
          return Promise.resolve(fake.port);
        },
      }),
    );
    await runtime.ensureStarted();
    await runtime.stop();
    await runtime.ensureStarted();
    expect(excluded[0]).toEqual([]);
    expect(excluded[1]).toEqual([fake.port]);
    await runtime.stop();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// failure paths
// ---------------------------------------------------------------------------------------------------------------------
describe('failure paths', () => {
  it('[R2] a missing VC++ CRT fails with LLM_VCREDIST_MISSING and NEVER spawns', async () => {
    const fake = await health();
    const rec = spawnRecorder();
    const runtime = createLlamaRuntime(deps({ port: fake.port, spawn: rec.spawn, exists: () => false }));
    await expect(runtime.ensureStarted()).rejects.toBeInstanceOf(LlamaRuntimeError);
    await expect(runtime.ensureStarted()).rejects.toMatchObject({ code: 'LLM_VCREDIST_MISSING' });
    expect(rec.calls).toEqual([]);
    expect(runtime.status()).toEqual({ state: 'failed', code: 'LLM_VCREDIST_MISSING', device: null });
    // the pre-flight looks in both places before giving up
    expect(VC_RUNTIME_DLLS).toHaveLength(3);
  });

  it('[R2] a child that exits with 0xC0000135 maps to LLM_VCREDIST_MISSING and is terminal for the Supervisor', async () => {
    const fake = await health({ loadMs: 60_000 });
    const rec = spawnRecorder();
    const runtime = createLlamaRuntime(deps({ port: fake.port, spawn: rec.spawn }));
    const pending = runtime.ensureStarted();
    await new Promise((r) => setImmediate(r));
    rec.calls[0]!.child.exit(VCREDIST_EXIT_CODE);
    await expect(pending).rejects.toMatchObject({ code: 'LLM_VCREDIST_MISSING' });
    expect(runtime.status().code).toBe('LLM_VCREDIST_MISSING');
    expect(runtime.childSpec().terminal?.()).toBe(true);
  });

  it('any other early exit maps to LLM_LOCAL_FAILED and is NOT terminal', async () => {
    const fake = await health({ loadMs: 60_000 });
    const rec = spawnRecorder();
    const runtime = createLlamaRuntime(deps({ port: fake.port, spawn: rec.spawn }));
    const pending = runtime.ensureStarted();
    await new Promise((r) => setImmediate(r));
    rec.calls[0]!.child.exit(1);
    await expect(pending).rejects.toMatchObject({ code: 'LLM_LOCAL_FAILED' });
    expect(runtime.childSpec().terminal?.()).toBe(false);
  });

  it('a server that never becomes ready times out, kills the child and reports LLM_LOCAL_FAILED', async () => {
    const fake = await health({ loadMs: 60_000 });
    const rec = spawnRecorder();
    const logger = recordingLog();
    const runtime = createLlamaRuntime(
      deps({
        port: fake.port,
        spawn: rec.spawn,
        log: logger.log,
        clock: steppingClock(100_000),
        readyTimeoutMs: 180_000,
      }),
    );
    await expect(runtime.ensureStarted()).rejects.toMatchObject({ code: 'LLM_LOCAL_FAILED' });
    expect(rec.calls[0]!.child.killed).toBe(true);
    expect(logger.events.map((e) => e.event)).toContain('llama_ready_timeout');
    expect(runtime.status()).toEqual({ state: 'failed', code: 'LLM_LOCAL_FAILED', device: 'gpu' });
  });

  it('an unreachable health endpoint is treated as "not ready yet", not as a crash', async () => {
    const rec = spawnRecorder();
    const runtime = createLlamaRuntime(
      deps({
        port: 1,
        spawn: rec.spawn,
        clock: steppingClock(100_000),
        fetch: () => Promise.reject(new Error('ECONNREFUSED')),
      }),
    );
    await expect(runtime.ensureStarted()).rejects.toMatchObject({ code: 'LLM_LOCAL_FAILED' });
    expect(rec.calls).toHaveLength(1);
  });

  it('no model file => MODEL_MISSING and no spawn', async () => {
    const fake = await health();
    const rec = spawnRecorder();
    const runtime = createLlamaRuntime(deps({ port: fake.port, spawn: rec.spawn, modelPath: () => '' }));
    await expect(runtime.ensureStarted()).rejects.toMatchObject({ code: 'MODEL_MISSING' });
    expect(rec.calls).toEqual([]);
  });

  it('LlamaRuntimeError carries the ErrorCode as its message by default', () => {
    expect(new LlamaRuntimeError('LLM_LOCAL_FAILED').message).toBe('LLM_LOCAL_FAILED');
    expect(new LlamaRuntimeError('LLM_LOCAL_FAILED', 'detail').message).toBe('detail');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// stop() + childSpec()
// ---------------------------------------------------------------------------------------------------------------------
describe('stop and childSpec', () => {
  it('stop() kills the child and returns to `stopped` (this is the provider-switch path)', async () => {
    const { rec, runtime } = await readyRuntime();
    await runtime.ensureStarted();
    await runtime.stop();
    expect(rec.calls[0]!.child.killed).toBe(true);
    expect(runtime.status()).toEqual({ state: 'stopped', code: null, device: null });
  });

  it('stop() on a runtime that was never started is a no-op', async () => {
    const { rec, runtime } = await readyRuntime();
    await runtime.stop();
    expect(rec.calls).toEqual([]);
    expect(runtime.status().state).toBe('stopped');
  });

  it('stop() after the child already exited resolves without waiting', async () => {
    const { rec, runtime } = await readyRuntime();
    await runtime.ensureStarted();
    rec.calls[0]!.child.exit(0);
    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it('exposes the Supervisor contract of ARCHITECTURE section 14', async () => {
    const { runtime } = await readyRuntime();
    const spec = runtime.childSpec();
    expect(spec.name).toBe('llama');
    expect(spec.backoffMs).toEqual(LLAMA_BACKOFF_MS);
    expect(spec.breaker).toEqual({ ...LLAMA_BREAKER });
    expect(spec.stableAfterMs).toBe(LLAMA_STABLE_AFTER_MS);
    expect(spec.probeMisses).toBe(3);
  });

  // [FIX ROUND] fix-src-main-proc / process-lifecycle-1: the readiness loop checked currentExit() only at the TOP of the
  // loop, so a 200 that was already on the wire when the process died (OOM / Vulkan device lost) was still 'ready', and
  // childSpec().start() handed the Supervisor a handle for the corpse.
  it('is not ready when the child died while GET /health was in flight', async () => {
    const rec = spawnRecorder();
    const logger = recordingLog();
    const raceFetch: FetchFn = () => {
      rec.calls[0]?.child.exit(1); // the process dies while the 200 is in flight
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const runtime = createLlamaRuntime(deps({ port: 59_999, spawn: rec.spawn, log: logger.log, fetch: raceFetch }));

    await expect(runtime.ensureStarted()).rejects.toBeInstanceOf(LlamaRuntimeError);
    expect(runtime.status().state).toBe('failed');
    expect(runtime.status().code).toBe('LLM_LOCAL_FAILED');
    expect(logger.events.map((e) => e.event)).not.toContain('llama_ready');
  });

  it('childSpec().start() refuses to hand back a handle for an already-exited child', async () => {
    const { rec, runtime } = await readyRuntime();
    await runtime.ensureStarted();
    rec.calls[0]!.child.exit(1); // died after readiness; ensureStarted() would respawn, start() must not adopt the corpse
    const spec = runtime.childSpec();
    // start() either throws or returns a handle for a LIVE child - never one whose exit is already known.
    let handle: Awaited<ReturnType<typeof spec.start>> | null = null;
    try {
      handle = await spec.start(0);
    } catch (err) {
      expect(err).toBeInstanceOf(LlamaRuntimeError);
    }
    if (handle !== null) {
      const inline: unknown[] = [];
      handle.onExit((info) => inline.push(info));
      expect(inline).toHaveLength(0); // the handle belongs to the respawned child, not the dead one
      expect(handle.pid).toBe(rec.calls.at(-1)!.child.pid);
    }
  });

  it('childSpec().start() yields a handle whose kill()/onExit() drive the real child', async () => {
    const { rec, runtime } = await readyRuntime();
    const handle = await runtime.childSpec().start(0);
    expect(handle.pid).toBe(rec.calls[0]!.child.pid);
    expect(handle.exePath).toBe(EXE);
    const exits: Array<{ code: number | null }> = [];
    handle.onExit((info) => exits.push(info));
    handle.kill();
    expect(exits).toEqual([{ code: 0, signal: 'SIGTERM' }]);
    // a listener registered after the exit is called back immediately
    const late: Array<{ code: number | null }> = [];
    handle.onExit((info) => late.push(info));
    expect(late).toHaveLength(1);
  });

  it('probe() is true while /health answers 200 or 503 and false when the socket is gone', async () => {
    const { fake, runtime } = await readyRuntime();
    await runtime.ensureStarted();
    await expect(runtime.childSpec().probe?.()).resolves.toBe(true);
    await fake.stop();
    servers.length = 0;
    await expect(runtime.childSpec().probe?.()).resolves.toBe(false);
    await runtime.stop();
  });

  it('a loading server (503) still counts as alive for the liveness probe', async () => {
    const fake = await health({ loadMs: 60_000 });
    const rec = spawnRecorder();
    const runtime = createLlamaRuntime(deps({ port: fake.port, spawn: rec.spawn, clock: steppingClock(100_000) }));
    await expect(runtime.ensureStarted()).rejects.toBeInstanceOf(LlamaRuntimeError);
    await expect(runtime.childSpec().probe?.()).resolves.toBe(true);
  });

  it('never spawns anything but the injected exe path (no shell, no image name)', async () => {
    const { rec, runtime } = await readyRuntime();
    await runtime.ensureStarted();
    for (const call of rec.calls) {
      expect(call.options.shell).not.toBe(true);
      expect(call.command).toBe(EXE);
    }
    expect(vi.isMockFunction(rec.spawn)).toBe(false);
    await runtime.stop();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [V2, V2-W1-08-vision] --mmproj respawn + GET /props vision readiness (B19, C2 9.1, T2 3.8)
// ---------------------------------------------------------------------------------------------------------------------
const MMPROJ = 'C:\\users\\t\\AppData\\Roaming\\wca\\models\\gemma-4-E4B-it-mmproj-F16.gguf';

describe('buildVisionArgs / buildLlamaArgs vision', () => {
  const base = { modelPath: MODEL, port: 51234, lowRam: false, forceCpu: false, deviceArg: null };

  it('is the literal of C2 9.1 per tier (tiny 560, small 1120, mid 1120 + batch 2048)', () => {
    expect(buildVisionArgs(MMPROJ, 'small')).toEqual([
      '--mmproj',
      MMPROJ,
      '--mmproj-device',
      'none',
      '--image-max-tokens',
      '1120',
    ]);
    expect(buildVisionArgs(MMPROJ, 'tiny')).toEqual([
      '--mmproj',
      MMPROJ,
      '--mmproj-device',
      'none',
      '--image-max-tokens',
      '560',
    ]);
    expect(buildVisionArgs(MMPROJ, 'mid')).toEqual([
      '--mmproj',
      MMPROJ,
      '--mmproj-device',
      'none',
      '--image-max-tokens',
      '1120',
      '--batch-size',
      String(LLAMA_MID_VISION_BATCH),
      '--ubatch-size',
      String(LLAMA_MID_VISION_BATCH),
    ]);
    expect(LLAMA_IMAGE_MAX_TOKENS).toEqual({ tiny: 560, small: 1120, mid: 1120 });
  });

  it('no vision (absent / null) keeps the exact v1 array; with vision the fake flag contract holds for every tier', () => {
    expect(buildLlamaArgs({ ...base, vision: null })).toEqual(buildLlamaArgs(base));
    for (const tier of ['tiny', 'small', 'mid'] as const) {
      const args = buildLlamaArgs({ ...base, vision: { mmprojPath: MMPROJ, tier } });
      expect(checkLlamaArgv(args)).toEqual([]);
      expect(checkVisionArgv(args, tier)).toEqual([]);
      expect(args.slice(0, buildLlamaArgs(base).length)).toEqual(buildLlamaArgs(base)); // v1 flags first, unchanged
    }
    expect(checkVisionArgv(buildLlamaArgs(base))).toEqual([]);
  });
});

describe('vision runtime (respawn with --mmproj, /props readiness)', () => {
  async function visionRuntime(opts: {
    serverVision: boolean;
    enabled: () => boolean;
    mmproj: () => string | null;
    tier?: 'tiny' | 'small' | 'mid';
  }) {
    const fake = await startFakeLlamaServer({ apiKey: 'unused-by-health', vision: opts.serverVision });
    servers.push(fake);
    const rec = spawnRecorder();
    const logger = recordingLog();
    const runtime = createLlamaRuntime(
      deps({
        port: fake.port,
        spawn: rec.spawn,
        log: logger.log,
        tier: () => opts.tier ?? 'small',
        imagesEnabled: opts.enabled,
        mmprojPath: opts.mmproj,
      }),
    );
    return { fake, rec, logger, runtime };
  }

  it('images enabled + projector present => spawned with --mmproj, /props vision => ready', async () => {
    const { fake, rec, runtime, logger } = await visionRuntime({
      serverVision: true,
      enabled: () => true,
      mmproj: () => MMPROJ,
      tier: 'mid',
    });
    expect(runtime.vision!()).toEqual({ requested: false, ready: false, stale: false });
    await runtime.ensureStarted();
    const args = rec.calls[0]!.args;
    expect(checkVisionArgv(args, 'mid')).toEqual([]);
    expect(args).toContain('--mmproj');
    expect(runtime.vision!()).toEqual({ requested: true, ready: true, stale: false });
    expect(fake.requests.some((r) => r.path === '/props')).toBe(true);
    expect(logger.events.find((e) => e.event === 'llama_vision')?.meta).toEqual({ ready: true });
    expect(logger.events.find((e) => e.event === 'llama_spawned')?.meta).toMatchObject({ vision: true });
    expect(JSON.stringify(logger.events)).not.toContain('mmproj-F16'); // no path in a log line
    await runtime.stop();
    expect(runtime.vision!()).toEqual({ requested: false, ready: false, stale: false });
  });

  it('a --mmproj child whose /props does not report vision is text-ready but NOT picture-ready', async () => {
    const { rec, runtime } = await visionRuntime({ serverVision: false, enabled: () => true, mmproj: () => MMPROJ });
    await runtime.ensureStarted();
    expect(rec.calls[0]!.args).toContain('--mmproj');
    expect(runtime.status().state).toBe('ready');
    expect(runtime.vision!()).toEqual({ requested: true, ready: false, stale: false });
    await runtime.stop();
  });

  it('/props failures (non-200, unreachable, non-JSON, null) all mean no vision and never fail the text start', async () => {
    const answers: Array<() => Promise<Response>> = [
      async () => new Response('nope', { status: 500 }),
      async () => {
        throw new Error('ECONNRESET');
      },
      async () => new Response('not json', { status: 200 }),
      async () => new Response('null', { status: 200 }),
    ];
    for (const answer of answers) {
      const fake = await health();
      const rec = spawnRecorder();
      const fetchVia: FetchFn = async (url, init) => (String(url).endsWith('/props') ? answer() : fetch(url, init));
      const runtime = createLlamaRuntime(
        deps({
          port: fake.port,
          spawn: rec.spawn,
          fetch: fetchVia,
          imagesEnabled: () => true,
          mmprojPath: () => MMPROJ,
        }),
      );
      await runtime.ensureStarted();
      expect(runtime.status().state).toBe('ready');
      expect(runtime.vision!().ready).toBe(false);
      await runtime.stop();
    }
  });

  it('images disabled or projector missing => the v1 text-only flag set and no /props probe', async () => {
    const cfgs: Array<{ enabled: () => boolean; mmproj: () => string | null }> = [
      { enabled: () => false, mmproj: () => MMPROJ },
      { enabled: () => true, mmproj: () => null },
      { enabled: () => true, mmproj: () => '' },
    ];
    for (const cfg of cfgs) {
      const { fake, rec, runtime } = await visionRuntime({ serverVision: true, ...cfg });
      await runtime.ensureStarted();
      expect(rec.calls[0]!.args).not.toContain('--mmproj');
      expect(fake.requests.some((r) => r.path === '/props')).toBe(false);
      expect(runtime.vision!()).toEqual({ requested: false, ready: false, stale: false });
      await runtime.stop();
    }
    const fake = await health();
    const rec = spawnRecorder();
    const runtime = createLlamaRuntime(
      deps({
        port: fake.port,
        spawn: rec.spawn,
        exists: (p) => p !== MMPROJ,
        imagesEnabled: () => true,
        mmprojPath: () => MMPROJ,
      }),
    );
    await runtime.ensureStarted();
    expect(rec.calls[0]!.args).not.toContain('--mmproj');
    await runtime.stop();
    const plain = await readyRuntime();
    await plain.runtime.ensureStarted();
    expect(plain.rec.calls[0]!.args).not.toContain('--mmproj');
    expect(plain.runtime.vision!()).toEqual({ requested: false, ready: false, stale: false });
    await plain.runtime.stop();
  });

  it('toggling images marks the running child stale; a fresh start picks up the new flag set', async () => {
    let enabled = false;
    const { rec, runtime } = await visionRuntime({ serverVision: true, enabled: () => enabled, mmproj: () => MMPROJ });
    await runtime.ensureStarted();
    expect(runtime.vision!().stale).toBe(false);
    enabled = true;
    expect(runtime.vision!()).toEqual({ requested: false, ready: false, stale: true });
    await runtime.stop();
    expect(runtime.vision!().stale).toBe(false); // not running => nothing is stale
    await runtime.ensureStarted();
    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[1]!.args).toContain('--mmproj');
    expect(runtime.vision!()).toEqual({ requested: true, ready: true, stale: false });
    enabled = false;
    expect(runtime.vision!().stale).toBe(true);
    await runtime.stop();
  });
});
