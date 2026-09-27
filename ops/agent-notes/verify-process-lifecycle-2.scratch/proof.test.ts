// SCRATCH ONLY - verification of review finding process-lifecycle-2. Not part of the suite.
// Traces the real code end to end: createSupervisor() writes the pid file AFTER spec.start() resolves,
// and reapOrphans() then refuses to kill the still-live orphan because CreationDate != startedAt.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSupervisor } from '../../../src/main/proc/supervisor';
import type { ChildHandle, ChildSpec, Supervisor } from '../../../src/main/proc/supervisor';
import { reapOrphans } from '../../../src/main/proc/reaper';
import type { Clock, ClockTimer, ProcessQuery } from '../../../src/main/deps';
import type { EpochMs } from '../../../src/shared/types';

const SPAWN_AT = 1_700_000_000_000 as EpochMs;
const READY_MS = 45_000; // cold multi-GB gguf: llama polls GET /health until 200 (budget 180 s)

let tmpDir: string;
let runDir: string;
let resourcesDir: string;
let exe: string;
let t: number;

const clock: Clock = {
  now: () => t as EpochMs,
  setTimeout: (): ClockTimer => 0 as ClockTimer, // never fires: this proof does not need timers
  clearTimeout: () => undefined,
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl2-'));
  runDir = path.join(tmpDir, 'run');
  resourcesDir = path.join(tmpDir, 'resources');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });
  exe = path.join(resourcesDir, 'llama-server.exe');
  fs.writeFileSync(exe, 'x');
  t = SPAWN_AT;
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function slowStartSpec(): ChildSpec {
  return {
    name: 'llama',
    // mirrors llamaServer.ts childSpec().start: await ensureStarted() (spawn, then poll /health), THEN return the handle
    start: async (): Promise<ChildHandle> => {
      const pid = 4242; // the OS created the process now, at t === SPAWN_AT
      t += READY_MS; // ... and /health only answers 200 forty-five seconds later
      return Promise.resolve({
        pid,
        exePath: exe,
        kill: () => undefined,
        onExit: () => undefined,
      });
    },
    backoffMs: [2000],
    breaker: { maxExits: 3, windowMs: 600_000 },
    stableAfterMs: 60_000,
  };
}

describe('process-lifecycle-2', () => {
  it('pid file records readiness time, so the reaper leaves a live orphan alive', async () => {
    const sup: Supervisor = createSupervisor({
      runDir,
      now: () => t as EpochMs,
      log: () => undefined,
      clock,
      processQuery: { query: () => Promise.resolve(null), kill: () => Promise.resolve() },
      killSync: () => undefined,
    });
    sup.register(slowStartSpec());
    await sup.start('llama');

    const written = JSON.parse(fs.readFileSync(path.join(runDir, 'llama.pid.json'), 'utf8')) as {
      pid: number;
      startedAt: number;
    };
    // (1) the recorded startedAt is readiness, not spawn
    expect(written.startedAt).toBe(SPAWN_AT + READY_MS);
    expect(written.startedAt - SPAWN_AT).toBe(45_000);

    // (2) app is hard-killed; next boot: the orphan is still live, Win32_Process reports its TRUE creation date
    const kills: number[] = [];
    const query: ProcessQuery = {
      query: (pid) =>
        Promise.resolve({ pid, executablePath: exe, creationDate: SPAWN_AT as EpochMs }),
      kill: (pid) => {
        kills.push(pid);
        return Promise.resolve();
      },
    };
    const events: string[] = [];
    const result = await reapOrphans(runDir, resourcesDir, {
      processQuery: query,
      execPath: path.join(tmpDir, 'app.exe'),
      log: (e) => events.push(e),
    });

    expect(result).toEqual({ killed: [], stalePidFiles: 1 });
    expect(kills).toEqual([]);
    expect(events).toContain('reaper_pidfile_stale');
    expect(fs.existsSync(path.join(runDir, 'llama.pid.json'))).toBe(false);
  });

  it('control: a 1 s readiness delay still reaps (tolerance is 2 s)', async () => {
    t = SPAWN_AT;
    const sup = createSupervisor({
      runDir,
      now: () => t as EpochMs,
      log: () => undefined,
      clock,
      processQuery: { query: () => Promise.resolve(null), kill: () => Promise.resolve() },
      killSync: () => undefined,
    });
    sup.register({
      ...slowStartSpec(),
      start: async (): Promise<ChildHandle> => {
        t += 1_000;
        return Promise.resolve({ pid: 4242, exePath: exe, kill: () => undefined, onExit: () => undefined });
      },
    });
    await sup.start('llama');
    const kills: number[] = [];
    const result = await reapOrphans(runDir, resourcesDir, {
      processQuery: {
        query: (pid) => Promise.resolve({ pid, executablePath: exe, creationDate: SPAWN_AT as EpochMs }),
        kill: (pid) => {
          kills.push(pid);
          return Promise.resolve();
        },
      },
      execPath: path.join(tmpDir, 'app.exe'),
    });
    expect(result).toEqual({ killed: ['llama'], stalePidFiles: 0 });
    expect(kills).toEqual([4242]);
  });
});
