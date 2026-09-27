// src/main/llm/local/supervised.test.ts - the composition root's supervised LlamaRuntime facade (ARCH A3 + section 14).
// Regression cover for review finding process-lifecycle-5: a start the Supervisor REFUSES (open breaker / terminal
// failure) must never fall through to a direct llama-server spawn, because such a child gets no <run>\llama.pid.json
// and is therefore unreachable for killAllSync() and for the reaper after a hard crash.
// llama-server.exe is never executed: every spawn goes to an in-process child double and /health is answered inline.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createSupervisor, type Supervisor } from '../../proc/supervisor';
import { createLlamaRuntime, LlamaRuntimeError, type LlamaRuntime } from './llamaServer';
import { createSupervisedLlama } from './supervised';
import type { Clock, ClockTimer, Logger, LogMeta, RandomSource, SpawnFn } from '../../deps';

class ChildDouble extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
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

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

interface Harness {
  supervisor: Supervisor;
  runtime: LlamaRuntime;
  supervised: LlamaRuntime;
  spawns: ChildDouble[];
  events: Array<{ event: string; meta?: LogMeta }>;
  killedSyncPids: number[];
  pidFile: string;
  runDir: string;
  advance: (ms: number) => Promise<void>;
}

const dirs: string[] = [];

function makeHarness(): Harness {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervised-llama-'));
  dirs.push(runDir);
  const exePath = path.join(runDir, 'llama-server.exe'); // pid-file content only; never executed

  let t = 1_700_000_000_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const supClock: Clock = {
    now: () => t,
    setTimeout: (fn, ms) => {
      const h = nextId++;
      timers.set(h, { at: t + ms, fn });
      return h as unknown as ClockTimer;
    },
    clearTimeout: (h) => {
      timers.delete(h as unknown as number);
    },
  };
  const advance = async (ms: number): Promise<void> => {
    t += ms;
    const due = [...timers.entries()].filter(([, v]) => v.at <= t).sort((a, b) => a[1].at - b[1].at);
    for (const [h, v] of due) {
      timers.delete(h);
      v.fn();
      await tick();
      await tick();
    }
    await tick();
  };

  const events: Array<{ event: string; meta?: LogMeta }> = [];
  const makeLog = (): Logger => ({
    info: (e, m) => events.push({ event: e, meta: m }),
    warn: (e, m) => events.push({ event: e, meta: m }),
    error: (e, m) => events.push({ event: e, meta: m }),
    child: () => makeLog(),
  });

  const spawns: ChildDouble[] = [];
  const spawn: SpawnFn = () => {
    const c = new ChildDouble(9000 + spawns.length);
    spawns.push(c);
    return c as unknown as ChildProcess;
  };
  const random: RandomSource = { bytes: (n) => new Uint8Array(n), int: (min) => min, float: () => 0 };
  const killedSyncPids: number[] = [];

  const supervisor: Supervisor = createSupervisor({
    runDir,
    now: () => t,
    log: (event, meta) => events.push({ event, meta: meta as LogMeta }),
    clock: supClock,
    processQuery: { query: () => Promise.resolve(null), kill: () => Promise.resolve() },
    killSync: (pid) => killedSyncPids.push(pid),
    random,
  });

  const runtime: LlamaRuntime = createLlamaRuntime({
    exePath,
    llamaDir: path.dirname(exePath),
    modelPath: () => path.join(runDir, 'model.gguf'),
    tier: () => 'small',
    forceCpu: () => false,
    acceleration: () => 'auto',
    freePort: () => Promise.resolve(51234),
    spawn,
    fetch: () => Promise.resolve({ status: 200 } as unknown as Response),
    clock: {
      now: () => t,
      setTimeout: (fn) => setTimeout(fn, 0) as unknown as ClockTimer,
      clearTimeout: (h) => {
        clearTimeout(h as never);
      },
    },
    random,
    log: makeLog(),
    exists: () => true,
    totalMemBytes: () => 32 * 1024 ** 3,
    setPriority: () => undefined,
    healthPollMs: 1,
  });

  const supervised = createSupervisedLlama({ supervisor, runtime });
  supervisor.register(runtime.childSpec());
  return {
    supervisor,
    runtime,
    supervised,
    spawns,
    events,
    killedSyncPids,
    pidFile: path.join(runDir, 'llama.pid.json'),
    runDir,
    advance,
  };
}

/** Drives the real crash loop of LLAMA_BACKOFF_MS [2000, 10000] until LLAMA_BREAKER (3 exits / 10 min) opens. */
async function crashUntilBreakerOpen(h: Harness): Promise<void> {
  await h.supervised.ensureStarted();
  expect(h.spawns).toHaveLength(1);
  expect(fs.existsSync(h.pidFile)).toBe(true); // a supervised start writes the pid file
  h.spawns[0]!.exit(1);
  await tick();
  await h.advance(2000);
  expect(h.spawns).toHaveLength(2);
  h.spawns[1]!.exit(1);
  await tick();
  await h.advance(10_000);
  expect(h.spawns).toHaveLength(3);
  h.spawns[2]!.exit(1);
  await tick();
  expect(h.events.some((e) => e.event === 'proc_breaker_open')).toBe(true);
  expect(h.supervisor.state('llama')).toBe('failed');
  expect(fs.existsSync(h.pidFile)).toBe(false);
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('createSupervisedLlama', () => {
  it('starts through the supervisor and reuses the supervised child (one spawn, one pid file)', async () => {
    const h = makeHarness();
    const first = await h.supervised.ensureStarted();
    expect(first).toMatchObject({ port: 51234 });
    expect(h.spawns).toHaveLength(1);
    expect(h.supervisor.state('llama')).toBe('running');
    expect(fs.existsSync(h.pidFile)).toBe(true);

    // a second triage item must NOT spawn a second llama-server
    const second = await h.supervised.ensureStarted();
    expect(second).toMatchObject({ port: 51234 });
    expect(h.spawns).toHaveLength(1);

    await h.supervisor.stop('llama');
  });

  it('propagates LLM_LOCAL_FAILED instead of spawning past an open breaker (process-lifecycle-5)', async () => {
    const h = makeHarness();
    await crashUntilBreakerOpen(h);
    const spawnsWhenBreakerOpened = h.spawns.length;

    // Three further triage items ask the local provider for the LLM while the breaker is open.
    for (let i = 0; i < 3; i++) {
      await expect(h.supervised.ensureStarted()).rejects.toBeInstanceOf(LlamaRuntimeError);
      expect(h.spawns).toHaveLength(spawnsWhenBreakerOpened); // no unthrottled multi-GB respawn loop
      expect(h.supervisor.state('llama')).toBe('failed');
    }
    expect(h.events.some((e) => e.event === 'proc_start_refused')).toBe(true);
    // Nothing unsupervised is alive, so there is no child without a <run>\llama.pid.json entry.
    expect(h.spawns.every((c) => c.exitCode !== null || c.signalCode !== null)).toBe(true);
    expect(fs.existsSync(h.pidFile)).toBe(false);
    expect(fs.readdirSync(h.runDir).filter((f) => f.startsWith('llama.pid'))).toEqual([]);
  });

  it('carries the runtime ErrorCode of a refused start', async () => {
    const h = makeHarness();
    await crashUntilBreakerOpen(h);
    await expect(h.supervised.ensureStarted()).rejects.toMatchObject({ code: 'LLM_LOCAL_FAILED' });
  });

  it('leaves every child reachable by killAllSync after the breaker opened', async () => {
    const h = makeHarness();
    await crashUntilBreakerOpen(h);
    await expect(h.supervised.ensureStarted()).rejects.toBeInstanceOf(LlamaRuntimeError);

    h.supervisor.killAllSync();
    // Every spawned child either already exited or was killed by the supervisor; none survives untracked.
    expect(h.spawns.filter((c) => c.exitCode === null && c.signalCode === null && !c.killed)).toEqual([]);
  });

  it('recovers after resetBreaker() and starts through the supervisor again', async () => {
    const h = makeHarness();
    await crashUntilBreakerOpen(h);
    await expect(h.supervised.ensureStarted()).rejects.toBeInstanceOf(LlamaRuntimeError);

    h.supervisor.resetBreaker('llama');
    const after = await h.supervised.ensureStarted();
    expect(after).toMatchObject({ port: 51234 });
    expect(h.supervisor.state('llama')).toBe('running');
    expect(fs.existsSync(h.pidFile)).toBe(true); // the new child IS supervised and reapable

    await h.supervisor.stop('llama');
  });

  it('joins an in-flight supervised start instead of spawning a second child', async () => {
    const h = makeHarness();
    const both = await Promise.all([h.supervised.ensureStarted(), h.supervised.ensureStarted()]);
    expect(both[0]).toMatchObject({ port: 51234 });
    expect(both[1]).toMatchObject({ port: 51234 });
    expect(h.spawns).toHaveLength(1);
    await h.supervisor.stop('llama');
  });

  it('falls back to LLM_LOCAL_FAILED when the runtime recorded no ErrorCode', async () => {
    let raw = 0;
    const runtime = {
      ensureStarted: () => {
        raw += 1;
        return Promise.resolve({ port: 1, apiKey: '' });
      },
      stop: () => Promise.resolve(),
      childSpec: () => ({}) as never,
      status: () => ({ state: 'stopped', code: null, device: null }) as never,
    } as unknown as LlamaRuntime;
    const supervised = createSupervisedLlama({
      supervisor: { start: () => Promise.resolve(), state: () => 'failed' },
      runtime,
    });
    await expect(supervised.ensureStarted()).rejects.toMatchObject({ code: 'LLM_LOCAL_FAILED' });
    expect(raw).toBe(0); // the raw runtime is never consulted after a refused start
  });

  it('delegates stop/status/childSpec to the wrapped runtime', async () => {
    const h = makeHarness();
    expect(h.supervised.childSpec().name).toBe('llama');
    expect(h.supervised.status()).toMatchObject({ state: 'stopped' });
    await h.supervised.ensureStarted();
    expect(h.supervised.status()).toMatchObject({ state: 'ready' });
    await h.supervised.stop();
    expect(h.runtime.status()).toMatchObject({ state: 'stopped' });
    await h.supervisor.stop('llama');
  });
});
