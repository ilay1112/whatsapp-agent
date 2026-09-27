// SCRATCH ONLY - not part of the suite. Reproduces the supervisedLlama fall-through of compose.ts:660-666 with the REAL
// supervisor + REAL llama runtime, a fake spawn and a stubbed /health. No process is ever executed.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createSupervisor, type Supervisor } from '../../../src/main/proc/supervisor';
import { createLlamaRuntime, type LlamaRuntime } from '../../../src/main/llm/local/llamaServer';
import type { Clock, ClockTimer, Logger, LogMeta, RandomSource, SpawnFn } from '../../../src/main/deps';

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

describe('process-lifecycle-5 repro', () => {
  it('breaker-open supervisor.start is silently overridden by the raw runtime', async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl5-'));
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
    const spawn: SpawnFn = (_cmd, _args, _opts) => {
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

    const llamaRuntime: LlamaRuntime = createLlamaRuntime({
      exePath,
      llamaDir: path.dirname(exePath),
      modelPath: () => path.join(runDir, 'model.gguf'),
      tier: () => 'small',
      forceCpu: () => false,
      acceleration: () => 'auto',
      freePort: () => Promise.resolve(51234),
      spawn,
      fetch: () => Promise.resolve({ status: 200 } as unknown as Response),
      clock: { now: () => t, setTimeout: (fn) => setTimeout(fn, 0) as unknown as ClockTimer, clearTimeout: (h) => clearTimeout(h as never) },
      random,
      log: makeLog(),
      exists: () => true,
      totalMemBytes: () => 32 * 1024 ** 3,
      setPriority: () => undefined,
      healthPollMs: 1,
    });

    // VERBATIM copy of src/main/compose.ts:660-666
    const supervisedLlama: LlamaRuntime = {
      ...llamaRuntime,
      async ensureStarted() {
        await supervisor.start('llama');
        return llamaRuntime.ensureStarted();
      },
    };

    supervisor.register(llamaRuntime.childSpec());
    const pidFile = path.join(runDir, 'llama.pid.json');

    await supervisedLlama.ensureStarted();
    expect(spawns).toHaveLength(1);
    expect(fs.existsSync(pidFile)).toBe(true); // supervised start => pid file

    // crash 1 and 2: the supervisor respawns through the backoff table
    spawns[0]!.exit(1);
    await tick();
    await advance(2000);
    expect(spawns).toHaveLength(2);
    spawns[1]!.exit(1);
    await tick();
    await advance(10_000);
    expect(spawns).toHaveLength(3);

    // crash 3 => LLAMA_BREAKER (3 exits / 10 min) opens
    spawns[2]!.exit(1);
    await tick();
    expect(supervisor.state('llama')).toBe('failed');
    expect(fs.existsSync(pidFile)).toBe(false);

    // the next triage item asks the provider for the local LLM again
    const after = await supervisedLlama.ensureStarted();
    expect(after).toMatchObject({ port: 51234 });
    expect(events.some((e) => e.event === 'proc_start_refused')).toBe(true);
    expect(spawns).toHaveLength(4); // <-- spawned anyway, breaker bypassed
    expect(spawns[3]!.exitCode).toBeNull(); // and it is alive
    expect(fs.existsSync(pidFile)).toBe(false); // <-- no llama.pid.json for it
    expect(supervisor.state('llama')).toBe('failed');

    // session-end: killAllSync cannot reach the child the supervisor never saw
    supervisor.killAllSync();
    expect(killedSyncPids).toEqual([]);
    expect(spawns[3]!.killed).toBe(false);

    // a repeat call spawns yet again once that one dies (no backoff, no breaker)
    spawns[3]!.exit(1);
    await tick();
    await supervisedLlama.ensureStarted();
    expect(spawns).toHaveLength(5);
    spawns[4]!.exit(1);
    await tick();

    fs.rmSync(runDir, { recursive: true, force: true });
  });
});
