// Scratch verification of review finding `process-lifecycle-1`. NOT a product test.
// Run: npx vitest run --config "ops/agent-notes/verify-process-lifecycle-1.scratch/vitest.scratch.config.ts"
//
// Unlike the reviewer's proof (which hand-wrote a ChildHandle whose onExit() fires inline), this drives the REAL
// createLlamaRuntime().childSpec() through the REAL createSupervisor(). Nothing is spawned: spawn and fetch are doubles.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createVirtualClock, createSeededRandom } from '../../../tests/helpers/virtualClock';
import { createSupervisor } from '../../../src/main/proc/supervisor';
import { createLlamaRuntime, type LlamaRuntimeDeps } from '../../../src/main/llm/local/llamaServer';
import type { FetchFn, Logger, SpawnFn } from '../../../src/main/deps';

const EXE = 'C:\\app\\resources\\llama\\llama-server.exe';
const LLAMA_DIR = 'C:\\app\\resources\\llama';
const MODEL = 'C:\\models\\gemma.gguf';

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

const silent = (): Logger => ({
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent(),
});

interface Rig {
  runDir: string;
  children: ChildDouble[];
  runtime: ReturnType<typeof createLlamaRuntime>;
  sup: ReturnType<typeof createSupervisor>;
  clock: ReturnType<typeof createVirtualClock>;
  states: string[];
}

/**
 * `onHealth` is called on every GET /health BEFORE the 200 is resolved: that is the hook that models the event-loop
 * interleaving in which libuv delivers the child's exit callback in the same loop turn as (and ahead of) the socket
 * read that carries the already-transmitted 200 response.
 */
function rig(onHealth: (children: ChildDouble[], call: number) => void): Rig {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-verify-pl1-'));
  const clock = createVirtualClock();
  const children: ChildDouble[] = [];
  let healthCalls = 0;

  const spawn: SpawnFn = () => {
    const c = new ChildDouble(4000 + children.length);
    children.push(c);
    return c as unknown as ChildProcess;
  };

  const fetchFake = ((): Promise<Response> => {
    healthCalls += 1;
    onHealth(children, healthCalls);
    const live = children[children.length - 1];
    if (live === undefined || live.exitCode !== null || live.signalCode !== null) {
      // after the child is dead a real loopback fetch rejects (ECONNREFUSED) - except for the one racy call below
      if (!pending200) return Promise.reject(new Error('ECONNREFUSED'));
    }
    pending200 = false;
    return Promise.resolve({ status: 200 } as Response);
  }) as unknown as FetchFn;
  let pending200 = false;

  const deps: LlamaRuntimeDeps = {
    exePath: EXE,
    llamaDir: LLAMA_DIR,
    modelPath: () => MODEL,
    tier: () => 'balanced' as never,
    forceCpu: () => true,
    acceleration: () => 'auto',
    freePort: () => Promise.resolve(18080),
    spawn,
    fetch: fetchFake,
    clock,
    random: createSeededRandom(),
    log: silent(),
    exists: () => true,
    totalMemBytes: () => 32 * 1024 ** 3,
    setPriority: () => undefined,
    healthPollMs: 10,
  };
  const runtime = createLlamaRuntime(deps);
  const sup = createSupervisor({
    runDir,
    now: () => clock.now() as never,
    log: () => undefined,
    clock,
    processQuery: { query: () => Promise.resolve(null), kill: () => Promise.resolve() },
    killSync: () => undefined,
    random: createSeededRandom(),
  });
  const states: string[] = [];
  sup.onState((n, s) => states.push(`${n}:${s}`));
  sup.register(runtime.childSpec());
  // let the very first /health answer 200 even though the child just died (the response was already on the wire)
  pending200 = true;
  return { runDir, children, runtime, sup, clock, states };
}

describe('process-lifecycle-1 against the real llamaServer + real supervisor', () => {
  it('CONFIRMS the wedge when the exit callback lands before the 200 resolves', async () => {
    // the child dies during the health call: exitInfo is already set when childSpec().start() builds the handle
    const r = rig((children) => children[0]?.exit(1, null));

    await r.sup.start('llama');

    // crash bookkeeping ran INSIDE startEntry, then startEntry overwrote it
    expect(r.states).toContain('llama:backoff');
    expect(r.sup.state('llama')).toBe('running'); // phantom: no child behind it
    expect(fs.existsSync(path.join(r.runDir, 'llama.pid.json'))).toBe(false); // onExit removed it

    // the armed backoff timer fires and startEntry refuses because state === 'running'
    await r.clock.advance(300_000);
    expect(r.children).toHaveLength(1); // never respawned by the supervisor
    expect(r.sup.state('llama')).toBe('running');

    // the probe cannot rescue it: killChild() returns early on handle === null and the tick stops rescheduling
    expect(r.sup.state('llama')).toBe('running');

    // an explicit start() is refused too - the entry is wedged for the rest of the session
    await r.sup.start('llama');
    expect(r.children).toHaveLength(1);
    expect(r.sup.state('llama')).toBe('running');

    fs.rmSync(r.runDir, { recursive: true, force: true });
  });

  it('CONTROL: when the exit lands one turn after the 200, the supervisor restarts normally', async () => {
    const r = rig(() => undefined); // healthy start

    await r.sup.start('llama');
    expect(r.sup.state('llama')).toBe('running');
    expect(fs.existsSync(path.join(r.runDir, 'llama.pid.json'))).toBe(true);

    r.children[0]?.exit(1, null); // dies AFTER the handle was attached -> asynchronous callback
    expect(r.sup.state('llama')).toBe('backoff');

    await r.clock.advance(60_000);
    expect(r.children.length).toBeGreaterThan(1); // respawned
    fs.rmSync(r.runDir, { recursive: true, force: true });
  });
});

describe('process-lifecycle-1 consequence: is the app unusable?', () => {
  it('the LLM still works, but the respawned child is invisible to stopAll/killAllSync and has no pid file', async () => {
    const r = rig((children) => children[0]?.exit(1, null));
    await r.sup.start('llama');
    expect(r.sup.state('llama')).toBe('running'); // wedged

    // compose.ts wraps the runtime: supervisedLlama.ensureStarted() = supervisor.start() then runtime.ensureStarted().
    await r.sup.start('llama'); // refused (state === 'running')
    const ready = await r.runtime.ensureStarted(); // respawns on its own - inference keeps working
    expect(ready.port).toBe(18080);
    expect(r.children).toHaveLength(2);

    // ...but the supervisor never learned about child #2
    expect(fs.existsSync(path.join(r.runDir, 'llama.pid.json'))).toBe(false); // reaper can never find it
    await r.sup.stopAll({ graceMs: 0 });
    r.sup.killAllSync();
    expect(r.children[1]?.exitCode).toBe(null); // orphan: survives app exit
    fs.rmSync(r.runDir, { recursive: true, force: true });
  });
});
