// Scratch verification of review finding process-lifecycle-1 (skeptic pass). NOT a product test.
// Run: npx vitest run --config "ops/agent-notes/verify-process-lifecycle-1.scratch/vitest.scratch.config.ts"
//
// The reviewer's own proof used a HAND-WRITTEN ChildHandle whose onExit() fires synchronously. That proves how the
// supervisor reacts, not that llamaServer can ever hand it such a handle. This file drives the REAL
// createLlamaRuntime() + the REAL createSupervisor() and tries to reach the precondition through product code only.
// llama-server.exe is never spawned: deps.spawn returns an in-process EventEmitter double and /health is a fake fetch.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { createVirtualClock } from '../../../tests/helpers/virtualClock';
import { createSupervisor } from '../../../src/main/proc/supervisor';
import { createLlamaRuntime, type LlamaRuntimeDeps } from '../../../src/main/llm/local/llamaServer';
import type { Logger, RandomSource, SpawnFn } from '../../../src/main/deps';

const EXE = 'C:\\app\\resources\\llama\\llama-server.exe';
const LLAMA_DIR = 'C:\\app\\resources\\llama';
const MODEL = 'C:\\users\\t\\AppData\\Roaming\\wca\\models\\model.gguf';

class ChildDouble extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(readonly pid: number) {
    super();
  }
  kill(): boolean {
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

const silent = (): Logger => {
  const l: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, child: () => l };
  return l;
};
const random: RandomSource = { bytes: (n) => new Uint8Array(n), int: (min) => min, float: () => 0 };

describe('process-lifecycle-1 reachability through product code', () => {
  it('llama dying while its 200 /health response is in flight wedges the supervisor in phantom running', async () => {
    const clock = createVirtualClock();
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-verify-'));

    const children: ChildDouble[] = [];
    const spawn: SpawnFn = () => {
      const c = new ChildDouble(4000 + children.length);
      children.push(c);
      return c as unknown as ChildProcess;
    };

    // /health: the first request is left pending so the test can decide what the OS does first; later ones answer 200.
    let releaseFirst: ((status: number) => void) | null = null;
    let healthCalls = 0;
    const fetchDouble: LlamaRuntimeDeps['fetch'] = () => {
      healthCalls += 1;
      if (healthCalls === 1) {
        return new Promise<Response>((resolve) => {
          releaseFirst = (status) => resolve({ status } as Response);
        });
      }
      return Promise.resolve({ status: 200 } as Response);
    };

    const runtime = createLlamaRuntime({
      exePath: EXE,
      llamaDir: LLAMA_DIR,
      modelPath: () => MODEL,
      tier: () => 'small',
      forceCpu: () => true,
      acceleration: () => 'auto',
      freePort: () => Promise.resolve(51234),
      spawn,
      fetch: fetchDouble,
      clock,
      random,
      log: silent(),
      exists: () => true,
      totalMemBytes: () => 32 * 1024 ** 3,
      setPriority: () => undefined,
      readyTimeoutMs: 180_000,
      healthPollMs: 1,
    });

    const logs: string[] = [];
    const sup = createSupervisor({
      runDir,
      now: () => clock.now(),
      log: (event) => logs.push(event),
      clock,
      processQuery: { query: () => Promise.resolve(null), kill: () => Promise.resolve() },
      killSync: () => undefined,
      random,
    });
    sup.register(runtime.childSpec());

    // compose.ts's supervisedLlama.ensureStarted() does exactly this on the first local-LLM call.
    const started = sup.start('llama');

    // wait until llama-server has been spawned and its first /health request is in flight
    for (let i = 0; i < 50 && releaseFirst === null; i++) await Promise.resolve();
    expect(children).toHaveLength(1);
    expect(releaseFirst).not.toBeNull();

    // THE RACE: the process answered 200 and then died (OOM / device lost) before the response was consumed.
    children[0]!.exit(1, null); // 'exit' lands first
    releaseFirst!(200); // ...then the already-sent 200 resolves
    await started;

    // --- what the readiness loop did with it -----------------------------------------------------------------
    // spawnOnce() does NOT re-check exitInfo after `await health()`, so a dead child is reported ready.
    // The exit handler set 'failed', then the readiness loop overwrote it: the runtime lies too.
    expect(runtime.status().state).toBe('ready');
    expect(sup.state('llama')).toBe('running'); // the supervisor says it is healthy  <-- phantom
    expect(logs).toContain('proc_crash'); // the crash WAS booked...
    expect(logs).toContain('proc_backoff'); // ...and a respawn WAS scheduled...
    expect(logs.lastIndexOf('proc_state')).toBeGreaterThan(logs.indexOf('proc_backoff')); // ...then overwritten

    // --- and it never recovers -------------------------------------------------------------------------------
    await clock.advance(600_000); // past every backoff, the stable timer and many probe intervals
    expect(children).toHaveLength(1); // the supervisor never respawned llama
    expect(sup.state('llama')).toBe('running'); // still lying to healthHub / tray
    await sup.start('llama');
    expect(children).toHaveLength(1); // an explicit start() is refused: state === 'running'

    // the pid file was removed by the crash bookkeeping, so the reaper can no longer clean up after a hard kill
    expect(fs.existsSync(path.join(runDir, 'llama.pid.json'))).toBe(false);

    // --- scope of the damage ---------------------------------------------------------------------------------
    // The LLM call path calls llamaRuntime.ensureStarted() right after supervisor.start(), and THAT still respawns,
    // so the local LLM keeps working - but the new child is untracked: no pid file, no supervision, no kill on quit.
    await runtime.ensureStarted();
    expect(children).toHaveLength(2); // a second llama-server, owned by nobody
    expect(sup.state('llama')).toBe('running'); // supervisor still points at the dead generation
    expect(fs.existsSync(path.join(runDir, 'llama.pid.json'))).toBe(false);

    await sup.stop('llama'); // quit path: e.handle === null, so killChild() returns early
    expect(children[1]!.exitCode).toBeNull(); // the live llama-server survives the app's stopAll()

    fs.rmSync(runDir, { recursive: true, force: true });
  });
});
