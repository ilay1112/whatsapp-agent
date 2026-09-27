// Scratch proofs for ops/agent-notes/review-process-lifecycle.md. NOT a product test; lives outside tests/ on purpose.
// Run: npx vitest run --config "ops/agent-notes/review-process-lifecycle.scratch/vitest.scratch.config.ts"
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVirtualClock } from '../../../tests/helpers/virtualClock';
import { createSupervisor, DEFAULT_GRACE_MS } from '../../../src/main/proc/supervisor';
import type { ChildHandle, ChildSpec } from '../../../src/main/proc/supervisor';
import { reapOrphans } from '../../../src/main/proc/reaper';
import type { ProcessInfo, ProcessQuery } from '../../../src/main/deps';

const tmpRun = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'wca-scratch-'));

// =====================================================================================================================
// process-lifecycle-1 : a ChildHandle that reports its exit SYNCHRONOUSLY from onExit() wedges the supervisor in
// 'running' with handle === null, forever. llm/local/llamaServer.ts childSpec().start() returns exactly such a handle
// (onExit -> `if (exitInfo !== null) { cb(exitInfo); return; }`).
// =====================================================================================================================
describe('process-lifecycle-1: synchronous onExit wedges the supervisor', () => {
  it('leaves state=running with no child and refuses every later start', async () => {
    const clock = createVirtualClock();
    const runDir = tmpRun();
    const sup = createSupervisor({
      runDir,
      now: () => clock.now(),
      log: () => undefined,
      clock,
      processQuery: { query: async () => null, kill: async () => undefined },
      killSync: () => undefined,
      random: { bytes: () => new Uint8Array(0), int: () => 0, float: () => 0 },
    });

    let starts = 0;
    // Attempt 1 mirrors llamaServer: readiness succeeded, then the process died before the supervisor attached,
    // so `exitInfo !== null` and onExit() invokes the callback inline.
    const spec: ChildSpec = {
      name: 'llama',
      start: (): Promise<ChildHandle> => {
        starts += 1;
        const diedAlready = starts === 1;
        return Promise.resolve({
          pid: 4242,
          exePath: 'C:\\app\\resources\\llama\\llama-server.exe',
          kill: () => undefined,
          onExit: (cb) => {
            if (diedAlready) cb({ code: 1, signal: null }); // SYNCHRONOUS, inside startEntry
          },
        });
      },
      backoffMs: [2000, 10_000],
      breaker: { maxExits: 3, windowMs: 600_000 },
      stableAfterMs: 60_000,
    };
    sup.register(spec);
    await sup.start('llama');

    // The exit was processed (backoff scheduled) but startEntry then overwrote the state.
    expect(sup.state('llama')).toBe('running'); // <-- phantom: there is no child

    // The backoff timer fires and startEntry refuses because state === 'running'.
    await clock.advance(120_000);
    expect(starts).toBe(1); // never respawned
    expect(sup.state('llama')).toBe('running'); // still lying

    // And it never recovers: an explicit start() is refused too.
    await sup.start('llama');
    expect(starts).toBe(1);
    fs.rmSync(runDir, { recursive: true, force: true });
  });
});

// =====================================================================================================================
// process-lifecycle-2 : the pid file's `startedAt` is stamped when spec.start() RESOLVES (after readiness), not when
// the OS created the process. reaper.matches() demands |Win32_Process.CreationDate - startedAt| <= 2000 ms, so any
// child whose readiness takes > 2 s can never be reaped after a hard crash.
// =====================================================================================================================
describe('process-lifecycle-2: slow readiness makes every orphan unreapable', () => {
  it('reaper discards the pid file as stale instead of killing the orphan', async () => {
    const clock = createVirtualClock();
    const runDir = tmpRun();
    const resourcesDir = path.join(runDir, 'resources');
    const exePath = path.join(resourcesDir, 'llama', 'llama-server.exe');
    fs.mkdirSync(path.dirname(exePath), { recursive: true });

    const spawnedAt = clock.now(); // the instant the OS created the process
    const READINESS_MS = 45_000; // a cold 4 GB gguf; the budget is 180 s

    const sup = createSupervisor({
      runDir,
      now: () => clock.now(),
      log: () => undefined,
      clock,
      processQuery: { query: async () => null, kill: async () => undefined },
      killSync: () => undefined,
      random: { bytes: () => new Uint8Array(0), int: () => 0, float: () => 0 },
    });
    sup.register({
      name: 'llama',
      start: async (): Promise<ChildHandle> => {
        // spawn happens now; the handle is only returned once GET /health answers 200.
        await clock.advance(READINESS_MS);
        return { pid: 4242, exePath, kill: () => undefined, onExit: () => undefined };
      },
      backoffMs: [2000],
      breaker: { maxExits: 3, windowMs: 600_000 },
      stableAfterMs: 60_000,
    });
    await sup.start('llama');

    const written = JSON.parse(fs.readFileSync(path.join(runDir, 'llama.pid.json'), 'utf8')) as { startedAt: number };
    expect(written.startedAt - spawnedAt).toBe(READINESS_MS); // 45 s of drift, tolerance is 2 s

    // --- app is hard-killed here; next boot runs the reaper against a still-live orphan ---
    const killed: number[] = [];
    const query: ProcessQuery = {
      query: (pid): Promise<ProcessInfo | null> =>
        Promise.resolve({ pid, executablePath: exePath, creationDate: spawnedAt }), // the TRUE creation time
      kill: (pid) => {
        killed.push(pid);
        return Promise.resolve();
      },
    };
    const res = await reapOrphans(runDir, resourcesDir, { processQuery: query, execPath: 'C:\\app\\app.exe' });

    expect(killed).toEqual([]); // <-- the orphan llama-server.exe keeps running and keeps the GPU/model RAM
    expect(res.killed).toEqual([]);
    expect(res.stalePidFiles).toBe(1); // silently written off as "stale"
    fs.rmSync(runDir, { recursive: true, force: true });
  });
});

// =====================================================================================================================
// process-lifecycle-3 : mcp/host.ts `stop()` does `exitCbs = []` BEFORE tearing the transport down, so the handle the
// supervisor holds never reports its exit. Result: every supervisor-initiated stop of calendar-mcp force-kills a PID
// whose process is already gone, 3 s later, with /T.
// =====================================================================================================================
describe('process-lifecycle-3: calendar-mcp always gets a blind taskkill of a dead pid', () => {
  it('escalates to taskkill /PID <pid> /T /F although the child exited cleanly', async () => {
    const clock = createVirtualClock();
    const runDir = tmpRun();
    const taskkilled: Array<{ pid: number; tree: boolean }> = [];
    const sup = createSupervisor({
      runDir,
      now: () => clock.now(),
      log: () => undefined,
      clock,
      processQuery: {
        query: async () => null,
        kill: (pid, tree) => {
          taskkilled.push({ pid, tree });
          return Promise.resolve();
        },
      },
      killSync: () => undefined,
      random: { bytes: () => new Uint8Array(0), int: () => 0, float: () => 0 },
    });

    let alive = true;
    // Faithful copy of mcp/host.ts: kill() = host.stop(), which clears exitCbs and then closes the transport.
    let exitCbs: Array<(i: { code: number | null; signal: string | null }) => void> = [];
    sup.register({
      name: 'calendar-mcp',
      start: (): Promise<ChildHandle> =>
        Promise.resolve({
          pid: 9001,
          exePath: 'C:\\app\\app.exe',
          kill: () => {
            exitCbs = []; // host.stop(): `exitCbs = []`
            alive = false; // ...then teardown() closes the transport, which really does kill the child
          },
          onExit: (cb) => {
            exitCbs.push(cb);
          },
        }),
      backoffMs: [2000],
      breaker: { maxExits: 3, windowMs: 600_000 },
      stableAfterMs: 60_000,
    });
    await sup.start('calendar-mcp');

    const stopped = sup.stop('calendar-mcp', { graceMs: DEFAULT_GRACE_MS });
    await clock.advance(DEFAULT_GRACE_MS + 1);
    await stopped;

    expect(alive).toBe(false); // the child was already gone when the grace period expired
    expect(taskkilled).toEqual([{ pid: 9001, tree: true }]); // ...and we tree-force-killed pid 9001 anyway
    expect(exitCbs).toEqual([]);
    fs.rmSync(runDir, { recursive: true, force: true });
  });
});
