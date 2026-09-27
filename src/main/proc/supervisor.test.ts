// src/main/proc/supervisor.test.ts - TESTS 5.3 row `proc/supervisor.ts` (owner W1-01).
// Scripted handles + tests/helpers/virtualClock.ts for the state machine; tests/fakes/fake-child.mjs for the real-process paths.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import type { ProcessQuery, RandomSource, SpawnFn } from '../deps';
import { createVirtualClock } from '../../../tests/helpers/virtualClock';
import type { VirtualClock } from '../../../tests/helpers/virtualClock';
import {
  CHILD_NAMES,
  DEFAULT_GRACE_MS,
  DEFAULT_PROBE_INTERVAL_MS,
  DEFAULT_PROBE_MISSES,
  JITTER_RATIO,
  MAX_BACKOFF_MS,
  MAX_PID,
  STOP_ORDER,
  createSupervisor,
  createSyncTaskkill,
  createTaskkillOnlyQuery,
  handleFromChildProcess,
  isChildName,
  isInsideDir,
  isSamePath,
  parsePidFile,
  realClock,
  taskkillArgs,
} from './supervisor';
import { reapOrphans } from './reaper';
import type {
  ChildHandle,
  ChildName,
  ChildSpec,
  ChildState,
  PidFile,
  SpawnSyncFn,
  Supervisor,
  SupervisorDeps,
} from './supervisor';
import type { EpochMs } from '../../shared/types';

const FAKE_CHILD = fileURLToPath(new URL('../../../tests/fakes/fake-child.mjs', import.meta.url));

// ---------------------------------------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------------------------------------
interface ScriptedChild {
  handle: ChildHandle;
  exit(info?: { code?: number | null; signal?: string | null }): void;
  killed: number;
}

function scriptedChild(opts: { pid: number; exePath: string; exitOnKill?: boolean }): ScriptedChild {
  const listeners: Array<(i: { code: number | null; signal: string | null }) => void> = [];
  let exited = false;
  const child: ScriptedChild = {
    killed: 0,
    handle: {
      pid: opts.pid,
      exePath: opts.exePath,
      kill: () => {
        child.killed += 1;
        if (opts.exitOnKill !== false) child.exit({ code: null, signal: 'SIGTERM' });
      },
      onExit: (cb) => {
        listeners.push(cb);
      },
    },
    exit: (info) => {
      if (exited) return;
      exited = true;
      for (const cb of [...listeners]) cb({ code: info?.code ?? 0, signal: info?.signal ?? null });
    },
  };
  return child;
}

let tmpDir: string;
let runDir: string;
let resourcesDir: string;
let clock: VirtualClock;
let logs: Array<{ event: string; meta: Record<string, string | number> }>;
let killCalls: Array<{ pid: number; tree: boolean }>;
let killSyncCalls: number[];
let processQuery: ProcessQuery;
let states: Array<[ChildName, ChildState]>;

const fixedRandom = (value: number): RandomSource => ({
  bytes: (n) => new Uint8Array(n),
  int: (min) => min,
  float: () => value,
});

function makeSupervisor(random = fixedRandom(0)): Supervisor {
  const sup = createSupervisor({
    runDir,
    now: () => clock.now(),
    log: (event, meta) => logs.push({ event, meta }),
    clock,
    processQuery,
    killSync: (pid) => killSyncCalls.push(pid),
    random,
  });
  sup.onState((name, s) => states.push([name, s]));
  return sup;
}

const spec = (over: Partial<ChildSpec> & { name: ChildName; start: ChildSpec['start'] }): ChildSpec => ({
  backoffMs: [2_000, 5_000, 15_000, 60_000],
  breaker: { maxExits: 5, windowMs: 600_000 },
  stableAfterMs: 60_000,
  ...over,
});

const pidFileOf = (name: ChildName): PidFile | null => {
  const p = path.join(runDir, `${name}.pid.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as PidFile;
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-sup-'));
  runDir = path.join(tmpDir, 'run');
  resourcesDir = path.join(tmpDir, 'resources');
  fs.mkdirSync(resourcesDir, { recursive: true });
  clock = createVirtualClock();
  logs = [];
  killCalls = [];
  killSyncCalls = [];
  states = [];
  processQuery = {
    query: () => Promise.resolve(null),
    kill: (pid, tree) => {
      killCalls.push({ pid, tree });
      return Promise.resolve();
    },
  };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------------
// parsePidFile - untrusted input
// ---------------------------------------------------------------------------------------------------------------------
describe('parsePidFile', () => {
  const own = 'C:\\Program Files\\WhatsApp Calendar Agent\\resources';
  const exe = path.join(own, 'bridge', 'whatsapp-bridge.exe');
  const execPath = 'C:\\Program Files\\WhatsApp Calendar Agent\\WhatsApp Calendar Agent.exe';
  const good = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({ pid: 4242, exePath: exe, startedAt: 1_700_000_000_000, ...over });

  it('accepts a well-formed file inside ownResourcesDir', () => {
    expect(parsePidFile(good(), own, execPath)).toEqual({
      pid: 4242,
      exePath: path.resolve(exe),
      startedAt: 1_700_000_000_000,
    });
  });

  it('accepts exePath === process.execPath (the ELECTRON_RUN_AS_NODE calendar MCP child)', () => {
    expect(parsePidFile(good({ exePath: execPath }), own, execPath)?.pid).toBe(4242);
  });

  it.each([
    ['not JSON at all', 'definitely not json'],
    ['a JSON array', '[{"pid":1,"exePath":"C:\\\\x.exe","startedAt":1}]'],
    ['a JSON string', '"hello"'],
    ['null', 'null'],
  ])('rejects %s', (_label, text) => {
    expect(parsePidFile(text, own, execPath)).toBeNull();
  });

  // [R2] the hostile pid files named in TESTS 5.3
  it.each([
    ['pid is a WQL injection string', { pid: '1 OR 1=1' }],
    ['pid is fractional', { pid: 1.5 }],
    ['pid is 2**31', { pid: MAX_PID }],
    ['pid is negative', { pid: -1 }],
    ['pid is zero', { pid: 0 }],
    ['pid is NaN', { pid: Number.NaN }],
    ['exePath is a foreign executable', { exePath: 'C:\\Windows\\System32\\cmd.exe' }],
    ['exePath escapes ownResourcesDir with ..', { exePath: `${own}\\..\\..\\Windows\\System32\\cmd.exe` }],
    ['exePath is relative', { exePath: 'bridge\\whatsapp-bridge.exe' }],
    ['exePath is empty', { exePath: '' }],
    ['exePath carries a NUL', { exePath: `${own}\\bridge\\whatsapp-bridge.exe\u0000.txt` }],
    ['exePath is a number', { exePath: 7 }],
    ['exePath is exactly ownResourcesDir', { exePath: own }],
    ['startedAt is a string', { startedAt: 'x' }],
    ['startedAt is zero', { startedAt: 0 }],
    ['startedAt is fractional', { startedAt: 1.25 }],
    ['startedAt is Infinity', { startedAt: Number.POSITIVE_INFINITY }],
  ])('rejects a pid file where %s', (_label, over) => {
    expect(parsePidFile(good(over), own, execPath)).toBeNull();
  });

  // process-lifecycle-9: unpackaged the three staged resource trees are NOT nested under one directory.
  describe('several legal roots', () => {
    const llamaDir = 'C:\\dev\\whatsapp agent\\vendor\\llama\\win-x64-vulkan';
    const llamaExe = path.join(llamaDir, 'llama-server.exe');
    const roots = [own, llamaDir];

    it('accepts an exePath inside any of the roots', () => {
      expect(parsePidFile(good({ exePath: llamaExe }), roots, execPath)?.exePath).toBe(path.resolve(llamaExe));
      expect(parsePidFile(good(), roots, execPath)?.exePath).toBe(path.resolve(exe));
    });

    it('rejects an exePath inside none of the roots', () => {
      expect(parsePidFile(good({ exePath: 'C:\\Windows\\System32\\cmd.exe' }), roots, execPath)).toBeNull();
      expect(parsePidFile(good({ exePath: llamaDir }), roots, execPath)).toBeNull(); // the root itself is not a child
    });

    it('rejects every exePath when the root list is empty', () => {
      expect(parsePidFile(good(), [], execPath)).toBeNull();
      expect(parsePidFile(good({ exePath: execPath }), [], execPath)?.pid).toBe(4242); // execPath still matches
    });

    it('accepts any of several exact exe paths (the e2e seam commands)', () => {
      const seam = 'C:\\Program Files\\nodejs\\node.exe';
      expect(parsePidFile(good({ exePath: seam }), roots, [execPath, seam])?.pid).toBe(4242);
      expect(parsePidFile(good({ exePath: seam }), roots, [execPath])).toBeNull();
    });
  });

  it('returns only the three documented fields - no extra key survives', () => {
    const parsed = parsePidFile(good({ token: 'secret', cmd: 'calc.exe' }), own, execPath);
    expect(parsed && Object.keys(parsed).sort()).toEqual(['exePath', 'pid', 'startedAt']);
  });

  it('path helpers are prefix-safe and case-insensitive', () => {
    expect(isInsideDir(path.join(own, 'a.exe'), own)).toBe(true);
    expect(isInsideDir(own, own)).toBe(false);
    expect(isInsideDir(`${own}-evil\\a.exe`, own)).toBe(false);
    expect(isSamePath(execPath, execPath.toUpperCase())).toBe(true);
  });
});

describe('taskkill argv', () => {
  it('kills by PID and NEVER by image name', () => {
    expect(taskkillArgs(1234, true)).toEqual(['/PID', '1234', '/T', '/F']);
    expect(taskkillArgs(1234, false)).toEqual(['/PID', '1234', '/F']);
    expect(taskkillArgs(1234, true).join(' ')).not.toContain('/IM');
    expect(taskkillArgs(1234, false).join(' ')).not.toContain('/IM');
  });

  it('knows the three child names and the quit order', () => {
    expect([...CHILD_NAMES].sort()).toEqual(['bridge', 'calendar-mcp', 'llama']);
    expect(STOP_ORDER).toEqual(['llama', 'calendar-mcp', 'bridge']);
    expect(isChildName('bridge')).toBe(true);
    expect(isChildName('powershell.exe')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// production defaults (used when compose() injects nothing)
// ---------------------------------------------------------------------------------------------------------------------
describe('production defaults', () => {
  it('realClock is a thin wrapper over Date.now / globalThis timers', async () => {
    const before = Date.now();
    expect(realClock.now()).toBeGreaterThanOrEqual(before);

    await new Promise<void>((resolve) => {
      realClock.setTimeout(() => resolve(), 1);
    });

    const never = vi.fn();
    const timer = realClock.setTimeout(never, 5);
    realClock.clearTimeout(timer);
    await new Promise<void>((resolve) => {
      realClock.setTimeout(() => resolve(), 20);
    });
    expect(never).not.toHaveBeenCalled();
  });

  it('createTaskkillOnlyQuery kills by PID with /T /F and never queries', async () => {
    const calls: Array<{ command: string; args: string[]; shell: unknown }> = [];
    const spawn: SpawnFn = (command, args, options) => {
      calls.push({ command, args: [...args], shell: options.shell });
      const emitter = new EventEmitter();
      queueMicrotask(() => emitter.emit('close', 0));
      return emitter as unknown as ChildProcess;
    };

    const query = createTaskkillOnlyQuery({ spawn });
    await expect(query.query(1234)).resolves.toBeNull();
    await query.kill(1234, true);
    await query.kill(1234, false);

    expect(calls).toEqual([
      { command: 'taskkill', args: ['/PID', '1234', '/T', '/F'], shell: false },
      { command: 'taskkill', args: ['/PID', '1234', '/F'], shell: false },
    ]);
    expect(calls.flatMap((c) => c.args)).not.toContain('/IM');
  });

  it('createTaskkillOnlyQuery resolves even when taskkill cannot be started', async () => {
    const spawn: SpawnFn = () => {
      const emitter = new EventEmitter();
      queueMicrotask(() => emitter.emit('error', new Error('ENOENT')));
      return emitter as unknown as ChildProcess;
    };
    await expect(createTaskkillOnlyQuery({ spawn }).kill(1, true)).resolves.toBeUndefined();
  });

  it('createSyncTaskkill spawns taskkill synchronously by PID', () => {
    const calls: Array<{ command: string; args: string[]; shell: unknown }> = [];
    const spawnSync: SpawnSyncFn = (command, args, options) => {
      calls.push({ command, args: [...args], shell: options.shell });
      return { status: 0 };
    };
    createSyncTaskkill({ spawnSync })(4321);
    expect(calls).toEqual([{ command: 'taskkill', args: ['/PID', '4321', '/T', '/F'], shell: false }]);
  });

  it('a supervisor built with only the frozen deps still runs', async () => {
    const child = scriptedChild({ pid: 321, exePath: path.join(resourcesDir, 'x.exe') });
    const sup = createSupervisor({ runDir, now: () => Date.now(), log: () => {} });
    sup.register(spec({ name: 'llama', start: () => Promise.resolve(child.handle), stableAfterMs: 3_600_000 }));
    await sup.start('llama');
    expect(sup.state('llama')).toBe('running');
    await sup.stop('llama', { graceMs: 1_000 });
    expect(sup.state('llama')).toBe('stopped');
    expect(child.killed).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// state machine
// ---------------------------------------------------------------------------------------------------------------------
describe('state machine', () => {
  it('stopped -> starting -> running, and writes an atomic pid file', async () => {
    const child = scriptedChild({ pid: 111, exePath: path.join(resourcesDir, 'bridge.exe') });
    const sup = makeSupervisor();
    sup.register(spec({ name: 'bridge', start: () => Promise.resolve(child.handle) }));
    expect(sup.state('bridge')).toBe('stopped');

    await sup.start('bridge');

    expect(sup.state('bridge')).toBe('running');
    expect(states).toEqual([
      ['bridge', 'starting'],
      ['bridge', 'running'],
    ]);
    expect(pidFileOf('bridge')).toEqual({
      pid: 111,
      exePath: path.join(resourcesDir, 'bridge.exe'),
      startedAt: clock.now(),
    });
    expect(fs.existsSync(path.join(runDir, 'bridge.pid.json.tmp'))).toBe(false);

    await sup.stop('bridge');
  });

  it('throws for an unregistered child', () => {
    const sup = makeSupervisor();
    expect(() => sup.state('bridge')).toThrow(/not registered/);
  });

  it('a start() that throws counts as an exit and backs off', async () => {
    const sup = makeSupervisor();
    sup.register(spec({ name: 'llama', start: () => Promise.reject(new Error('EACCES')), backoffMs: [2_000] }));
    await sup.start('llama');
    expect(sup.state('llama')).toBe('backoff');
    expect(logs.map((l) => l.event)).toContain('proc_start_failed');
    await sup.stop('llama');
  });

  it('start() on an already-running child is a no-op', async () => {
    const child = scriptedChild({ pid: 1, exePath: 'C:\\x.exe' });
    const start = vi.fn(() => Promise.resolve(child.handle));
    const sup = makeSupervisor();
    sup.register(spec({ name: 'bridge', start }));
    await sup.start('bridge');
    await sup.start('bridge');
    expect(start).toHaveBeenCalledTimes(1);
    await sup.stop('bridge');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// crashes, backoff, breaker
// ---------------------------------------------------------------------------------------------------------------------
describe('crash handling', () => {
  const rig = async (over: Partial<ChildSpec> = {}, random = fixedRandom(0)) => {
    const children: ScriptedChild[] = [];
    const sup = makeSupervisor(random);
    sup.register(
      spec({
        name: 'bridge',
        start: (attempt) => {
          const c = scriptedChild({ pid: 500 + attempt, exePath: path.join(resourcesDir, 'bridge.exe') });
          children.push(c);
          return Promise.resolve(c.handle);
        },
        ...over,
      }),
    );
    await sup.start('bridge');
    return { sup, children, last: () => children[children.length - 1] as ScriptedChild };
  };

  it('exit code 0 while not stopping is a crash', async () => {
    const { sup, last } = await rig();
    last().exit({ code: 0 });
    expect(sup.state('bridge')).toBe('backoff');
    expect(logs.find((l) => l.event === 'proc_crash')?.meta.code).toBe(0);
    expect(pidFileOf('bridge')).toBeNull();
    await sup.stop('bridge');
  });

  it('walks the backoff table and respawns with a fresh attempt number', async () => {
    const { sup, children, last } = await rig({ backoffMs: [2_000, 5_000, 15_000, 60_000] });

    last().exit({ code: 1 });
    expect(sup.state('bridge')).toBe('backoff');
    await clock.advance(1_999);
    expect(sup.state('bridge')).toBe('backoff');
    await clock.advance(1);
    expect(sup.state('bridge')).toBe('running');
    expect(children).toHaveLength(2);
    expect(children[1]?.handle.pid).toBe(501); // spec.start(attempt=1)

    last().exit({ code: 1 });
    await clock.advance(4_999);
    expect(sup.state('bridge')).toBe('backoff');
    await clock.advance(1);
    expect(sup.state('bridge')).toBe('running');

    last().exit({ code: 1 });
    await clock.advance(15_000);
    expect(sup.state('bridge')).toBe('running');
    expect(children).toHaveLength(4);

    await sup.stop('bridge');
  });

  it('caps the delay at 60 s even when the table asks for more', async () => {
    const { sup, last } = await rig({ backoffMs: [600_000], breaker: { maxExits: 99, windowMs: 600_000 } });
    last().exit({ code: 1 });
    const delay = logs.find((l) => l.event === 'proc_backoff')?.meta.delayMs;
    expect(delay).toBe(MAX_BACKOFF_MS);
    await sup.stop('bridge');
  });

  it('adds jitter inside [d, d * 1.15)', async () => {
    for (const f of [0, 0.5, 0.999]) {
      logs = [];
      const { sup, last } = await rig({ backoffMs: [10_000] }, fixedRandom(f));
      last().exit({ code: 1 });
      const delay = logs.find((l) => l.event === 'proc_backoff')?.meta.delayMs as number;
      expect(delay).toBeGreaterThanOrEqual(10_000);
      expect(delay).toBeLessThan(10_000 * (1 + JITTER_RATIO));
      expect(delay).toBe(10_000 + Math.floor(10_000 * JITTER_RATIO * f));
      await sup.stop('bridge');
    }
  });

  it('resets the backoff position after stableAfterMs of stable running', async () => {
    const { sup, last } = await rig({ backoffMs: [2_000, 5_000], stableAfterMs: 60_000 });

    last().exit({ code: 1 }); // attempt 0 -> delay 2 000
    await clock.advance(2_000);
    expect(sup.state('bridge')).toBe('running');

    await clock.advance(60_000); // stable
    expect(logs.some((l) => l.event === 'proc_stable')).toBe(true);

    logs = [];
    last().exit({ code: 1 });
    expect(logs.find((l) => l.event === 'proc_backoff')?.meta.delayMs).toBe(2_000); // back to the top of the table
    await sup.stop('bridge');
  });

  it('opens the breaker after maxExits crashes inside the window, and only resetBreaker() closes it', async () => {
    const { sup, last } = await rig({ backoffMs: [1_000], breaker: { maxExits: 3, windowMs: 600_000 } });

    last().exit({ code: 1 });
    await clock.advance(1_000);
    last().exit({ code: 1 });
    await clock.advance(1_000);
    expect(sup.state('bridge')).toBe('running');

    last().exit({ code: 1 }); // third exit inside the window
    expect(sup.state('bridge')).toBe('failed');
    expect(logs.some((l) => l.event === 'proc_breaker_open')).toBe(true);

    await sup.start('bridge'); // a plain start must not reopen it
    expect(sup.state('bridge')).toBe('failed');
    expect(logs.some((l) => l.event === 'proc_start_refused')).toBe(true);
    await clock.advance(600_000);
    expect(sup.state('bridge')).toBe('failed');

    sup.resetBreaker('bridge');
    expect(sup.state('bridge')).toBe('stopped');
    await sup.start('bridge');
    expect(sup.state('bridge')).toBe('running');
    await sup.stop('bridge');
  });

  it('forgets exits that fell out of the breaker window', async () => {
    const { sup, last } = await rig({ backoffMs: [1_000], breaker: { maxExits: 2, windowMs: 10_000 } });
    last().exit({ code: 1 });
    await clock.advance(1_000);
    await clock.advance(30_000); // the first exit ages out of the 10 s window
    last().exit({ code: 1 });
    expect(sup.state('bridge')).toBe('backoff');
    await sup.stop('bridge');
  });

  it('terminal() suppresses the respawn without opening the breaker', async () => {
    let terminal = false;
    const { sup, last } = await rig({ terminal: () => terminal });
    terminal = true;
    last().exit({ code: 1 });
    expect(sup.state('bridge')).toBe('failed');
    expect(logs.some((l) => l.event === 'proc_terminal')).toBe(true);
    expect(clock.pendingCount()).toBe(0); // no backoff timer was armed
    sup.resetBreaker('bridge');
    terminal = false;
    await sup.start('bridge');
    expect(sup.state('bridge')).toBe('running');
    await sup.stop('bridge');
  });

  it('ignores an exit reported by a handle that was already replaced', async () => {
    const { sup, children, last } = await rig({ backoffMs: [1_000] });
    const first = last();
    first.exit({ code: 1 });
    await clock.advance(1_000);
    expect(children).toHaveLength(2);
    logs = [];
    first.exit({ code: 1 }); // stale handle, already superseded
    expect(logs.some((l) => l.event === 'proc_crash')).toBe(false);
    expect(sup.state('bridge')).toBe('running');
    await sup.stop('bridge');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// liveness probe
// ---------------------------------------------------------------------------------------------------------------------
describe('liveness probe', () => {
  it('kills and restarts after probeMisses consecutive misses', async () => {
    let alive = true;
    const children: ScriptedChild[] = [];
    const sup = makeSupervisor();
    sup.register(
      spec({
        name: 'bridge',
        start: (attempt) => {
          const c = scriptedChild({ pid: 600 + attempt, exePath: path.join(resourcesDir, 'bridge.exe') });
          children.push(c);
          return Promise.resolve(c.handle);
        },
        probe: () => Promise.resolve(alive),
        probeIntervalMs: 20_000,
        probeMisses: 3,
        backoffMs: [2_000],
      }),
    );
    await sup.start('bridge');

    await clock.advance(20_000);
    expect(sup.state('bridge')).toBe('running'); // probe answered

    alive = false;
    await clock.advance(20_000);
    await clock.advance(20_000);
    expect(sup.state('bridge')).toBe('running'); // 2 misses
    expect(children).toHaveLength(1);

    await clock.advance(20_000); // third miss -> kill
    expect(children[0]?.killed).toBe(1);
    expect(logs.some((l) => l.event === 'proc_probe_dead')).toBe(true);
    expect(sup.state('bridge')).toBe('backoff');

    alive = true;
    await clock.advance(2_000);
    expect(sup.state('bridge')).toBe('running');
    expect(children).toHaveLength(2);
    await sup.stop('bridge');
  });

  it('a throwing probe counts as a miss and a later success resets the counter', async () => {
    let mode: 'throw' | 'ok' = 'throw';
    const child = scriptedChild({ pid: 7, exePath: 'C:\\x.exe' });
    const sup = makeSupervisor();
    sup.register(
      spec({
        name: 'calendar-mcp',
        start: () => Promise.resolve(child.handle),
        probe: () => (mode === 'throw' ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve(true)),
        probeIntervalMs: 1_000,
        probeMisses: 3,
      }),
    );
    await sup.start('calendar-mcp');
    await clock.advance(1_000);
    await clock.advance(1_000);
    expect(logs.filter((l) => l.event === 'proc_probe_miss')).toHaveLength(2);
    mode = 'ok';
    await clock.advance(1_000);
    mode = 'throw';
    await clock.advance(1_000);
    expect(sup.state('calendar-mcp')).toBe('running'); // the counter restarted at 1
    await sup.stop('calendar-mcp');
  });

  it('falls back to 20 s / 3 misses when the spec omits them', async () => {
    const child = scriptedChild({ pid: 9, exePath: 'C:\\x.exe', exitOnKill: false });
    const sup = makeSupervisor();
    sup.register(
      spec({ name: 'bridge', start: () => Promise.resolve(child.handle), probe: () => Promise.resolve(false) }),
    );
    await sup.start('bridge');
    expect(DEFAULT_PROBE_INTERVAL_MS).toBe(20_000);
    expect(DEFAULT_PROBE_MISSES).toBe(3);
    await clock.advance(DEFAULT_PROBE_INTERVAL_MS * (DEFAULT_PROBE_MISSES - 1));
    expect(child.killed).toBe(0);
    const dying = clock.advance(DEFAULT_PROBE_INTERVAL_MS);
    await dying;
    expect(child.killed).toBe(1);
    await clock.advance(DEFAULT_GRACE_MS);
    expect(killCalls).toEqual([{ pid: 9, tree: true }]);
    await sup.stop('bridge');
  });

  it('a spec without a probe arms no probe timer', async () => {
    const child = scriptedChild({ pid: 8, exePath: 'C:\\x.exe' });
    const sup = makeSupervisor();
    sup.register(spec({ name: 'llama', start: () => Promise.resolve(child.handle), stableAfterMs: 60_000 }));
    await sup.start('llama');
    expect(clock.pendingCount()).toBe(1); // only the stable timer
    await sup.stop('llama');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// stop / stopAll / killAllSync
// ---------------------------------------------------------------------------------------------------------------------
describe('stop', () => {
  it('a cooperative child exits on kill() and taskkill is never reached', async () => {
    const child = scriptedChild({ pid: 900, exePath: path.join(resourcesDir, 'bridge.exe') });
    const sup = makeSupervisor();
    sup.register(spec({ name: 'bridge', start: () => Promise.resolve(child.handle) }));
    await sup.start('bridge');

    await sup.stop('bridge', { graceMs: 3_000 });

    expect(sup.state('bridge')).toBe('stopped');
    expect(child.killed).toBe(1);
    expect(killCalls).toEqual([]);
    expect(pidFileOf('bridge')).toBeNull();
    expect(clock.pendingCount()).toBe(0);
  });

  it('escalates to `taskkill /PID <pid> /T /F` after the grace period and never respawns', async () => {
    const child = scriptedChild({ pid: 901, exePath: path.join(resourcesDir, 'bridge.exe'), exitOnKill: false });
    const sup = makeSupervisor();
    sup.register(spec({ name: 'bridge', start: () => Promise.resolve(child.handle) }));
    await sup.start('bridge');

    const stopping = sup.stop('bridge', { graceMs: DEFAULT_GRACE_MS });
    await clock.advance(DEFAULT_GRACE_MS);
    await stopping;

    expect(killCalls).toEqual([{ pid: 901, tree: true }]);
    expect(sup.state('bridge')).toBe('stopped');
    expect(states.filter(([, s]) => s === 'backoff')).toEqual([]);
    expect(pidFileOf('bridge')).toBeNull();

    child.exit({ code: null, signal: 'SIGKILL' }); // the real exit event arrives late: ignored
    expect(sup.state('bridge')).toBe('stopped');
  });

  // process-lifecycle-3: `taskkill /T /F` on a bare pid is the one supervisor action that can reach a process we do not
  // own. Windows recycles PIDs, so the escalation must not fire against a row that is demonstrably NOT our child.
  it('never taskkills a pid the OS has recycled to another image (/T would take a stranger s tree)', async () => {
    const exePath = path.join(resourcesDir, 'bridge.exe');
    const child = scriptedChild({ pid: 910, exePath, exitOnKill: false });
    processQuery = {
      query: (pid) =>
        Promise.resolve({ pid, executablePath: 'C:\\Windows\\System32\\notepad.exe', creationDate: clock.now() }),
      kill: (pid, tree) => {
        killCalls.push({ pid, tree });
        return Promise.resolve();
      },
    };
    const sup = makeSupervisor();
    sup.register(spec({ name: 'bridge', start: () => Promise.resolve(child.handle) }));
    await sup.start('bridge');

    const stopping = sup.stop('bridge', { graceMs: DEFAULT_GRACE_MS });
    await clock.advance(DEFAULT_GRACE_MS);
    await stopping;

    expect(killCalls).toEqual([]);
    expect(logs.some((l) => l.event === 'proc_taskkill')).toBe(false);
    expect(logs.some((l) => l.event === 'proc_taskkill_skipped')).toBe(true);
    expect(sup.state('bridge')).toBe('stopped'); // the exit is still synthesised: the entry never wedges
    expect(pidFileOf('bridge')).toBeNull();
  });

  it('never taskkills a pid whose Win32 row was created after we spawned our child', async () => {
    const exePath = path.join(resourcesDir, 'bridge.exe');
    const child = scriptedChild({ pid: 911, exePath, exitOnKill: false });
    // Same image name, but created long after our child started: a recycled pid, not ours.
    processQuery = {
      query: (pid) => Promise.resolve({ pid, executablePath: exePath, creationDate: clock.now() + 3_600_000 }),
      kill: (pid, tree) => {
        killCalls.push({ pid, tree });
        return Promise.resolve();
      },
    };
    const sup = makeSupervisor();
    sup.register(spec({ name: 'bridge', start: () => Promise.resolve(child.handle) }));
    await sup.start('bridge');
    const stopping = sup.stop('bridge', { graceMs: DEFAULT_GRACE_MS });
    await clock.advance(DEFAULT_GRACE_MS);
    await stopping;

    expect(killCalls).toEqual([]);
    expect(sup.state('bridge')).toBe('stopped');
  });

  it('still taskkills when the row confirms our own child', async () => {
    const exePath = path.join(resourcesDir, 'bridge.exe');
    const child = scriptedChild({ pid: 912, exePath, exitOnKill: false });
    const spawnedAt = clock.now(); // a real child is created at or before the moment we record startedAt
    processQuery = {
      query: (pid) => Promise.resolve({ pid, executablePath: exePath, creationDate: spawnedAt - 40 }),
      kill: (pid, tree) => {
        killCalls.push({ pid, tree });
        return Promise.resolve();
      },
    };
    const sup = makeSupervisor();
    sup.register(spec({ name: 'bridge', start: () => Promise.resolve(child.handle) }));
    await sup.start('bridge');
    const stopping = sup.stop('bridge', { graceMs: DEFAULT_GRACE_MS });
    await clock.advance(DEFAULT_GRACE_MS);
    await stopping;

    expect(killCalls).toEqual([{ pid: 912, tree: true }]);
  });

  it('never taskkills pid 0 (a handle whose transport exposed no pid)', async () => {
    const child = scriptedChild({ pid: 0, exePath: path.join(resourcesDir, 'bridge.exe'), exitOnKill: false });
    const sup = makeSupervisor();
    sup.register(spec({ name: 'bridge', start: () => Promise.resolve(child.handle) }));
    await sup.start('bridge');
    const stopping = sup.stop('bridge', { graceMs: DEFAULT_GRACE_MS });
    await clock.advance(DEFAULT_GRACE_MS);
    await stopping;

    expect(killCalls).toEqual([]);
    expect(sup.state('bridge')).toBe('stopped');
  });

  it('stop() during backoff cancels the pending respawn', async () => {
    const child = scriptedChild({ pid: 902, exePath: 'C:\\x.exe' });
    const sup = makeSupervisor();
    sup.register(spec({ name: 'bridge', start: () => Promise.resolve(child.handle), backoffMs: [5_000] }));
    await sup.start('bridge');
    child.exit({ code: 1 });
    expect(sup.state('bridge')).toBe('backoff');

    await sup.stop('bridge');
    expect(sup.state('bridge')).toBe('stopped');
    await clock.advance(60_000);
    expect(sup.state('bridge')).toBe('stopped');
  });

  it('stop() while spec.start is still pending kills the child that arrives late', async () => {
    let release: (h: ChildHandle) => void = () => {};
    const child = scriptedChild({ pid: 903, exePath: 'C:\\x.exe' });
    const sup = makeSupervisor();
    sup.register(
      spec({
        name: 'bridge',
        start: () =>
          new Promise<ChildHandle>((resolve) => {
            release = resolve;
          }),
      }),
    );
    const starting = sup.start('bridge');
    expect(sup.state('bridge')).toBe('starting');

    const stopping = sup.stop('bridge');
    release(child.handle);
    await starting;
    await stopping;

    expect(child.killed).toBe(1);
    expect(sup.state('bridge')).toBe('stopped');
    expect(pidFileOf('bridge')).toBeNull();
  });

  it('stop() on a stopped child is a no-op and leaves a failed child failed', async () => {
    const child = scriptedChild({ pid: 904, exePath: 'C:\\x.exe' });
    const sup = makeSupervisor();
    sup.register(
      spec({ name: 'bridge', start: () => Promise.resolve(child.handle), breaker: { maxExits: 1, windowMs: 600_000 } }),
    );
    await sup.stop('bridge');
    expect(states).toEqual([]);

    await sup.start('bridge');
    child.exit({ code: 1 });
    expect(sup.state('bridge')).toBe('failed');
    await sup.stop('bridge');
    expect(sup.state('bridge')).toBe('failed');
  });

  it('restart() stops, resets the backoff position and starts again', async () => {
    const children: ScriptedChild[] = [];
    const sup = makeSupervisor();
    sup.register(
      spec({
        name: 'bridge',
        start: (attempt) => {
          const c = scriptedChild({ pid: 910 + attempt, exePath: 'C:\\x.exe' });
          children.push(c);
          return Promise.resolve(c.handle);
        },
        backoffMs: [3_000, 9_000],
      }),
    );
    await sup.start('bridge');
    children[0]?.exit({ code: 1 });
    await clock.advance(3_000); // attempt is now 1

    await sup.restart('bridge');
    expect(sup.state('bridge')).toBe('running');
    expect(children[children.length - 1]?.handle.pid).toBe(910); // attempt reset to 0

    logs = [];
    children[children.length - 1]?.exit({ code: 1 });
    expect(logs.find((l) => l.event === 'proc_backoff')?.meta.delayMs).toBe(3_000);
    await sup.stop('bridge');
  });
});

describe('stopAll / killAllSync', () => {
  const registerThree = (sup: Supervisor): Map<ChildName, ScriptedChild> => {
    const map = new Map<ChildName, ScriptedChild>();
    CHILD_NAMES.forEach((name, i) => {
      const c = scriptedChild({ pid: 1000 + i, exePath: path.join(resourcesDir, `${name}.exe`) });
      map.set(name, c);
      sup.register(spec({ name, start: () => Promise.resolve(c.handle) }));
    });
    return map;
  };

  it('stops llama, then calendar-mcp, then bridge', async () => {
    const sup = makeSupervisor();
    const children = registerThree(sup);
    for (const name of CHILD_NAMES) await sup.start(name);
    states = [];

    await sup.stopAll({ graceMs: 3_000 });

    expect(states.filter(([, s]) => s === 'stopping').map(([n]) => n)).toEqual(['llama', 'calendar-mcp', 'bridge']);
    for (const name of CHILD_NAMES) {
      expect(sup.state(name)).toBe('stopped');
      expect(children.get(name)?.killed).toBe(1);
      expect(pidFileOf(name)).toBeNull();
    }
  });

  it('killAllSync kills every live child by PID and clears the pid files', async () => {
    const sup = makeSupervisor();
    const children = registerThree(sup);
    for (const name of CHILD_NAMES) await sup.start(name);
    expect(fs.readdirSync(runDir).filter((f) => f.endsWith('.pid.json'))).toHaveLength(3);

    sup.killAllSync();

    expect(killSyncCalls.sort()).toEqual([1000, 1001, 1002]);
    expect(fs.readdirSync(runDir).filter((f) => f.endsWith('.pid.json'))).toHaveLength(0);
    for (const name of CHILD_NAMES) expect(sup.state(name)).toBe('stopped');
    expect(children.get('bridge')?.killed).toBe(1);
    expect(clock.pendingCount()).toBe(0);
  });

  it('killAllSync is safe when nothing is running', () => {
    const sup = makeSupervisor();
    registerThree(sup);
    sup.killAllSync();
    expect(killSyncCalls).toEqual([]);
  });

  it('stopAll skips children that were never registered', async () => {
    const child = scriptedChild({ pid: 1, exePath: 'C:\\x.exe' });
    const sup = makeSupervisor();
    sup.register(spec({ name: 'bridge', start: () => Promise.resolve(child.handle) }));
    await sup.start('bridge');
    await sup.stopAll({ graceMs: 100 });
    expect(sup.state('bridge')).toBe('stopped');
  });

  it('onState unsubscribes', async () => {
    const sup = makeSupervisor();
    const seen: ChildState[] = [];
    const off = sup.onState((_n, s) => seen.push(s));
    const child = scriptedChild({ pid: 2, exePath: 'C:\\x.exe' });
    sup.register(spec({ name: 'bridge', start: () => Promise.resolve(child.handle) }));
    await sup.start('bridge');
    off();
    await sup.stop('bridge');
    expect(seen).toEqual(['starting', 'running']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// against the real tests/fakes/fake-child.mjs (TESTS 3.6) - a plain node script, never the bridge exe
// ---------------------------------------------------------------------------------------------------------------------
describe('with fake-child.mjs', () => {
  const spawnFake = (args: string[]): ChildHandle => {
    const child = cp.spawn(process.execPath, [FAKE_CHILD, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return handleFromChildProcess(child, process.execPath);
  };

  it('treats a real clean exit (code 0) as a crash and backs off', async () => {
    const sup = makeSupervisor();
    const crashed = new Promise<void>((resolve) => {
      sup.onState((_n, s) => {
        if (s === 'backoff') resolve();
      });
    });
    sup.register(
      spec({
        name: 'llama',
        start: () => Promise.resolve(spawnFake(['--exit-after', '30', '--exit-code', '0'])),
        backoffMs: [2_000],
      }),
    );

    await sup.start('llama');
    const pidFile = pidFileOf('llama');
    expect(pidFile?.pid).toBeGreaterThan(0);
    expect(pidFile?.exePath).toBe(process.execPath);

    await crashed;
    expect(sup.state('llama')).toBe('backoff');
    expect(pidFileOf('llama')).toBeNull();
    await sup.stop('llama');
  });

  it('stop() ends a long-lived real child without needing taskkill', async () => {
    const sup = makeSupervisor();
    sup.register(spec({ name: 'llama', start: () => Promise.resolve(spawnFake(['--ready-line', 'ready'])) }));
    await sup.start('llama');
    const pid = pidFileOf('llama')?.pid ?? 0;
    expect(pid).toBeGreaterThan(0);

    await sup.stop('llama', { graceMs: 5_000 });

    expect(sup.state('llama')).toBe('stopped');
    expect(killCalls).toEqual([]);
    expect(pidFileOf('llama')).toBeNull();
  });

  it('--write-pid produces a file that parsePidFile accepts', async () => {
    const target = path.join(tmpDir, 'written.pid.json');
    const child = cp.spawn(process.execPath, [FAKE_CHILD, '--write-pid', target, '--exit-after', '20'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const parsed = parsePidFile(fs.readFileSync(target, 'utf8'), resourcesDir, process.execPath);
    expect(parsed?.pid).toBe(child.pid);
    expect(parsed?.exePath).toBe(path.resolve(process.execPath));
  });

  it('handleFromChildProcess reports a real exit and a spawn error', async () => {
    const child = cp.spawn(process.execPath, [FAKE_CHILD, '--exit-after', '20', '--exit-code', '3'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const handle = handleFromChildProcess(child, process.execPath);
    expect(handle.pid).toBeGreaterThan(0);
    const info = await new Promise<{ code: number | null; signal: string | null }>((resolve) => handle.onExit(resolve));
    expect(info.code).toBe(3);

    const missing = cp.spawn(path.join(resourcesDir, 'nope.exe'), [], { windowsHide: true });
    const errHandle = handleFromChildProcess(missing, 'C:\\nope.exe');
    expect(errHandle.pid).toBeGreaterThanOrEqual(-1);
    await new Promise<void>((resolve) => errHandle.onExit(() => resolve()));
  });

  it('kill() on an already-dead handle does not throw', async () => {
    const child = cp.spawn(process.execPath, [FAKE_CHILD, '--exit-after', '10'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const handle = handleFromChildProcess(child, process.execPath);
    await new Promise<void>((resolve) => handle.onExit(() => resolve()));
    expect(() => handle.kill()).not.toThrow();
  });

  it('a start that rejects because the executable does not exist backs off', async () => {
    const sup = makeSupervisor();
    sup.register(
      spec({
        name: 'llama',
        start: () =>
          new Promise<ChildHandle>((_resolve, reject) => {
            const child = cp.spawn(path.join(resourcesDir, 'does-not-exist.exe'), [], { windowsHide: true });
            child.once('error', (err) => reject(err));
          }),
        backoffMs: [2_000],
      }),
    );
    await sup.start('llama');
    expect(sup.state('llama')).toBe('backoff');
    await sup.stop('llama');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [FIX ROUND] fix-src-main-proc: process-lifecycle-1 (re-entrant exit during start) and -2 (pid-file startedAt)
// ---------------------------------------------------------------------------------------------------------------------
describe('a ChildHandle that reports an already-known exit (process-lifecycle-1)', () => {
  /**
   * llm/local/llamaServer.ts hands back a handle whose `onExit` calls the listener INLINE when `exitInfo !== null`
   * (asserted by llamaServer.test.ts). That happens whenever the child dies while its GET /health 200 was in flight.
   * The supervisor must treat that as a crash, not overwrite the crash bookkeeping with 'running'.
   */
  const deadOnArrival = (pid: number, exePath: string): ChildHandle => ({
    pid,
    exePath,
    kill: () => {},
    onExit: (cb) => {
      cb({ code: 1, signal: null });
    },
  });

  it('lands in backoff and respawns instead of wedging in a phantom "running"', async () => {
    const exePath = path.join(resourcesDir, 'llama.exe');
    const live = scriptedChild({ pid: 777, exePath });
    let attempts = 0;
    const sup = makeSupervisor();
    sup.register(
      spec({
        name: 'llama',
        start: () => {
          attempts += 1;
          return Promise.resolve(attempts === 1 ? deadOnArrival(4242, exePath) : live.handle);
        },
        backoffMs: [2_000],
        breaker: { maxExits: 3, windowMs: 600_000 },
      }),
    );

    await sup.start('llama');

    expect(sup.state('llama')).toBe('backoff');
    expect(states.at(-1)).toEqual(['llama', 'backoff']);
    expect(logs.map((l) => l.event)).toContain('proc_crash');
    expect(logs.map((l) => l.event)).toContain('proc_backoff');
    expect(pidFileOf('llama')).toBeNull(); // the crash path removed it and nothing re-created it

    // the armed backoff timer really respawns (a phantom 'running' makes startEntry return early instead)
    await clock.advance(2_000);
    expect(attempts).toBe(2);
    expect(sup.state('llama')).toBe('running');
    expect(pidFileOf('llama')?.pid).toBe(777);

    await sup.stop('llama');
    expect(live.killed).toBe(1); // the respawn is tracked, so stopAll/killAllSync can reach it
  });

  it('keeps the breaker and the probe honest across three dead-on-arrival starts', async () => {
    const exePath = path.join(resourcesDir, 'llama.exe');
    const sup = makeSupervisor();
    sup.register(
      spec({
        name: 'llama',
        start: () => Promise.resolve(deadOnArrival(4242, exePath)),
        backoffMs: [2_000],
        breaker: { maxExits: 3, windowMs: 600_000 },
      }),
    );

    await sup.start('llama');
    await clock.advance(2_000);
    await clock.advance(2_000);

    expect(sup.state('llama')).toBe('failed');
    expect(logs.map((l) => l.event)).toContain('proc_breaker_open');
  });
});

describe('pid-file startedAt (process-lifecycle-2)', () => {
  it('records the spawn instant, not the readiness instant, so reapOrphans can match the orphan', async () => {
    const exePath = path.join(resourcesDir, 'llama.exe');
    const spawnedAt = clock.now() as EpochMs;
    const child = scriptedChild({ pid: 909, exePath });
    let resolveStart!: (h: ChildHandle) => void;
    const readiness = new Promise<ChildHandle>((resolve) => {
      resolveStart = resolve;
    });

    const sup = makeSupervisor();
    sup.register(spec({ name: 'llama', start: () => readiness }));
    const starting = sup.start('llama');
    await clock.advance(45_000); // a cold multi-GB gguf: ChildSpec.start() resolves 45 s after the child exists
    resolveStart({ ...child.handle, spawnedAt });
    await starting;

    expect(clock.now()).toBe(spawnedAt + 45_000);
    expect(pidFileOf('llama')?.startedAt).toBe(spawnedAt);

    // end to end: the real reaper, against a live process whose CreationDate is the true spawn instant
    const reaped = await reapOrphans(runDir, resourcesDir, {
      execPath: path.join(tmpDir, 'app.exe'),
      processQuery: {
        query: (pid) => Promise.resolve({ pid, executablePath: exePath, creationDate: spawnedAt }),
        kill: (pid, tree) => {
          killCalls.push({ pid, tree });
          return Promise.resolve();
        },
      },
    });
    expect(reaped).toEqual({ killed: ['llama'], stalePidFiles: 0 });
    expect(killCalls).toEqual([{ pid: 909, tree: true }]);

    await sup.stop('llama');
  });

  it('falls back to now() when the ChildHandle carries no spawn instant', async () => {
    const child = scriptedChild({ pid: 5, exePath: path.join(resourcesDir, 'bridge.exe') });
    const sup = makeSupervisor();
    sup.register(spec({ name: 'bridge', start: () => Promise.resolve(child.handle) }));
    await sup.start('bridge');
    expect(pidFileOf('bridge')?.startedAt).toBe(clock.now());
    await sup.stop('bridge');
  });

  it('ignores a spawn instant that parsePidFile would reject', async () => {
    const exePath = path.join(resourcesDir, 'bridge.exe');
    const child = scriptedChild({ pid: 6, exePath });
    const sup = makeSupervisor();
    sup.register(spec({ name: 'bridge', start: () => Promise.resolve({ ...child.handle, spawnedAt: 0 as EpochMs }) }));
    await sup.start('bridge');
    expect(pidFileOf('bridge')?.startedAt).toBe(clock.now());
    await sup.stop('bridge');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// frozen-signature conformance
// [FIX ROUND] W2-01-compose-integration asked to RATIFY OR REVERT the additive optional deps (notes section 2 / 2a).
// Ratified - and pinned here so the ratification cannot quietly rot into a breaking change.
// ---------------------------------------------------------------------------------------------------------------------
/**
 * `FrozenCreateSupervisor` is the declaration of CONTRACTS section 13 / wave0-seams section 8 pasted verbatim.
 * The two assignments below are COMPILE-TIME assertions (enforced by `tsc -p tsconfig.tests.json`, i.e. by
 * `npm run typecheck`): they only type-check while every parameter Wave 1 added is optional - that is, while the
 * widening is purely additive and every caller written against the frozen shape still compiles unchanged.
 * If someone later makes `clock`, `processQuery`, `killSync` or `random` required, THIS FILE stops compiling.
 */
type FrozenCreateSupervisor = (deps: {
  runDir: string;
  now: () => EpochMs;
  log: (event: string, meta: Record<string, string | number>) => void;
}) => Supervisor;

describe('frozen-signature conformance', () => {
  it('createSupervisor still satisfies the verbatim CONTRACTS section 13 declaration', () => {
    const frozen: FrozenCreateSupervisor = createSupervisor;
    expect(frozen).toBe(createSupervisor);
  });

  it('a deps object holding ONLY the frozen keys is a complete SupervisorDeps', () => {
    const frozenOnly: SupervisorDeps = { runDir, now: () => clock.now(), log: () => {} };
    expect(Object.keys(frozenOnly).sort()).toEqual(['log', 'now', 'runDir']);
    // and it really produces a working supervisor on the production defaults (no injected clock / query / random)
    const sup = createSupervisor(frozenOnly);
    sup.register(spec({ name: 'calendar-mcp', start: () => Promise.reject(new Error('not started in this test')) }));
    expect(sup.state('calendar-mcp')).toBe('stopped');
  });
});
