// Scratch proof for review finding process-lifecycle-5. Real createSupervisor + real createLlamaRuntime,
// wrapped with the VERBATIM 3 lines of compose.ts:660-665. No real exe is ever spawned: SpawnFn is a fake.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSupervisor } from '../../../src/main/proc/supervisor';
import { createLlamaRuntime } from '../../../src/main/llm/local/llamaServer';
import type { ChildProcess } from 'node:child_process';

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plc5-'));
let spawnCount = 0;
const spawnedPids: number[] = [];

// A fake "llama-server.exe" that always dies 5 ms after it is spawned (crash-at-load, e.g. GPU OOM).
const fakeSpawn = (): ChildProcess => {
  spawnCount += 1;
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.assign(child, { pid: 1000 + spawnCount, stdout: null, stderr: null, exitCode: null, signalCode: null, kill: () => true });
  spawnedPids.push(1000 + spawnCount);
  setTimeout(() => child.emit('exit', 1, null), 5);
  return child;
};

const logs: string[] = [];
const log = (event: string, meta: Record<string, string | number>) => logs.push(`${event} ${JSON.stringify(meta)}`);
const loggerStub: any = { info: () => {}, warn: () => {}, error: () => {}, child: () => loggerStub };

// Supervisor clock: zero-delay timers so the [2000,10000] backoff table runs in real time here.
const fastClock = {
  now: () => Date.now() as never,
  setTimeout: (fn: () => void, _ms: number) => setTimeout(fn, 0),
  clearTimeout: (t: any) => clearTimeout(t),
};

const supervisor = createSupervisor({
  runDir,
  now: () => Date.now() as never,
  log,
  clock: fastClock as never,
  processQuery: { query: () => Promise.resolve(null), kill: () => Promise.resolve() },
  killSync: () => {},
  random: { bytes: (n: number) => new Uint8Array(n), int: () => 0, float: () => 0 },
});

const llamaRuntime = createLlamaRuntime({
  exePath: 'C:\fake\resources\llama\llama-server.exe',
  llamaDir: 'C:\fake\resources\llama',
  modelPath: () => 'C:\fake\models\model.gguf',
  tier: () => 'tiny' as never,
  forceCpu: () => true,
  acceleration: () => 'auto',
  freePort: () => Promise.resolve(18000 + spawnCount),
  spawn: fakeSpawn as never,
  fetch: (() => Promise.reject(new Error('down'))) as never, // /health never answers
  clock: { now: () => Date.now() as never, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (t: any) => clearTimeout(t) },
  random: { bytes: (n: number) => new Uint8Array(n), int: () => 0, float: () => 0 },
  log: loggerStub,
  exists: () => true, // VC++ runtime present
  totalMemBytes: () => 32 * 1024 ** 3,
  preferredDevice: () => null,
  setPriority: () => {},
  readyTimeoutMs: 2_000,
  healthPollMs: 5,
});

// ---- verbatim compose.ts:660-665 ----
const supervisedLlama = {
  ...llamaRuntime,
  async ensureStarted() {
    await supervisor.start('llama');
    return llamaRuntime.ensureStarted();
  },
};

const pidFile = path.join(runDir, 'llama.pid.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  supervisor.register(llamaRuntime.childSpec());

  // Phase 1: one supervised start; the supervisor's own backoff drives the crash loop until the breaker opens.
  await supervisedLlama.ensureStarted().catch(() => {});
  for (let i = 0; i < 40 && supervisor.state('llama') !== 'failed'; i++) await sleep(50);

  const spawnsBeforeBreaker = spawnCount;
  console.log('state after crash loop:', supervisor.state('llama'));
  console.log('spawns while supervised:', spawnsBeforeBreaker);
  console.log('breaker_open logged:', logs.some((l) => l.startsWith('proc_breaker_open')));
  console.log('pid file present while supervised (sampled after exit):', fs.existsSync(pidFile));

  // Phase 2: the breaker is open. Three more triage items each call the composed ensureStarted().
  for (let i = 0; i < 3; i++) {
    await supervisedLlama.ensureStarted().catch((e) => console.log('  call rejected with', (e as Error & { code?: string }).code));
    console.log('  after call', i + 1, '-> supervisor state', supervisor.state('llama'), '| total spawns', spawnCount, '| pid file', fs.existsSync(pidFile));
  }

  console.log('proc_start_refused count:', logs.filter((l) => l.startsWith('proc_start_refused')).length);
  console.log('spawns AFTER the breaker opened:', spawnCount - spawnsBeforeBreaker);
  console.log('pid file exists at the end:', fs.existsSync(pidFile));
  console.log('run dir contents:', fs.readdirSync(runDir));
  fs.rmSync(runDir, { recursive: true, force: true });
})();
