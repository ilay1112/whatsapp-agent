// src/main/proc/supervisor.ts   (frozen signatures)
// Signatures pasted verbatim from docs/specs/contracts.md section 13 (owner W1-01); Wave 1 adds the bodies below them.
// Electron-free: every collaborator (clock, process query, randomness) is injected; the defaults are plain Node 24.
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess, SpawnSyncOptions } from 'node:child_process';
import type { Clock, ClockTimer, ProcessInfo, ProcessQuery, RandomSource, SpawnFn } from '../deps';
import type { EpochMs } from '../../shared/types';

/** Synchronous counterpart of S-SPAWN, needed only by `killAllSync()`; `shell` is never true and the result is never read. */
export type SpawnSyncFn = (command: string, args: readonly string[], options: SpawnSyncOptions) => unknown;
export type ChildName = 'bridge' | 'calendar-mcp' | 'llama';
export type ChildState = 'stopped' | 'starting' | 'running' | 'backoff' | 'failed' | 'stopping';

/** Abstracts over child_process.spawn (bridge, llama) and the SDK's StdioClientTransport (calendar MCP owns its own spawn). */
export interface ChildHandle {
  pid: number;
  exePath: string;
  /**
   * The instant `spawn()` returned this child - NOT the instant the readiness handshake finished. ADDITIVE and OPTIONAL
   * (every handle written against the frozen four-key shape still compiles); when it is absent the supervisor falls back
   * to `now()` at attach time. It exists because proc/reaper.ts matches `Win32_Process.CreationDate` against the pid
   * file's `startedAt` within +-2 s, and every ChildSpec.start() resolves only AFTER readiness (llama polls GET /health
   * for up to 180 s on a cold gguf). Stamping the readiness instant makes the orphan unreapable.
   */
  spawnedAt?: EpochMs;
  kill(): void; // child.kill() ; the supervisor escalates to `taskkill /PID <pid> /T /F` after graceMs
  onExit(cb: (info: { code: number | null; signal: string | null }) => void): void;
}
export interface ChildSpec {
  name: ChildName;
  start(attempt: number): Promise<ChildHandle>; // MUST allocate a fresh port/token per attempt ; throws => counts as an exit
  probe?: () => Promise<boolean>; // liveness ; bridge: GET /api/health answered (200 or 503)
  probeIntervalMs?: number;
  probeMisses?: number; // bridge 20_000 / 3
  backoffMs: readonly number[]; // bridge [2000,5000,15000,60000] ; mcp [2000,10000,60000] ; llama [2000,10000]
  breaker: { maxExits: number; windowMs: number }; // bridge 5/10 min ; mcp 3/10 min ; llama 3/10 min
  stableAfterMs: number; // 60_000 => reset backoff
  terminal?: () => boolean; // true => do not respawn (breaker open with client_outdated annotation, logged_out via REST, spawn refused)
}
export interface PidFile {
  pid: number;
  exePath: string;
  startedAt: EpochMs;
} // <userData>\run\<name>.pid.json, atomic write

// ---------------------------------------------------------------------------------------------------------------------
// constants (exported so the tests assert the real numbers, not a copy)
// ---------------------------------------------------------------------------------------------------------------------
/** ARCHITECTURE section 14: `min(60 s, base * 2^n)` - the per-child `backoffMs` table IS that sequence, capped here. */
export const MAX_BACKOFF_MS = 60_000;
/** Jitter is added on top of the capped delay: delay in [d, d * (1 + JITTER_RATIO)). */
export const JITTER_RATIO = 0.15;
/** `child.kill()` first, `taskkill /PID <pid> /T /F` after this many ms (ARCHITECTURE section 13 quit sequence). */
export const DEFAULT_GRACE_MS = 3_000;
export const DEFAULT_PROBE_INTERVAL_MS = 20_000;
export const DEFAULT_PROBE_MISSES = 3;
/** stopAll order: the leaves first, the bridge last (ARCHITECTURE section 13). */
export const STOP_ORDER: readonly ChildName[] = ['llama', 'calendar-mcp', 'bridge'];
export const CHILD_NAMES: readonly ChildName[] = ['bridge', 'calendar-mcp', 'llama'];
/** A Windows pid is a DWORD; anything at or above 2**31 (or non-integer) is a forged pid file. */
export const MAX_PID = 2 ** 31;
/**
 * Slack allowed between `Win32_Process.CreationDate` and the moment the supervisor adopted the handle, before the pid is
 * treated as recycled and `taskkill /T /F` is refused. Mirrors proc/reaper.ts's CREATION_TOLERANCE_MS (kept local: reaper
 * imports supervisor, so the constant may not travel the other way).
 */
export const PID_REUSE_TOLERANCE_MS = 2_000;

export function isChildName(v: string): v is ChildName {
  return (CHILD_NAMES as readonly string[]).includes(v);
}

/** By PID only - NEVER `/IM <image>`: the user's own bridge runs the same image name (ARCHITECTURE section 3). */
export function taskkillArgs(pid: number, tree: boolean): string[] {
  return tree ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/F'];
}

// ---------------------------------------------------------------------------------------------------------------------
// parsePidFile - untrusted input
// ---------------------------------------------------------------------------------------------------------------------
const canonicalise = (p: string): string =>
  path
    .resolve(p)
    .replace(/[\\/]+$/, '')
    .toLowerCase();

/** True when `child` is strictly inside `dir` (after normalisation, so `..` traversal cannot escape it). */
export function isInsideDir(child: string, dir: string): boolean {
  const c = canonicalise(child);
  const d = canonicalise(dir);
  return c.length > d.length + 1 && c.startsWith(d + path.sep.toLowerCase());
}
export function isSamePath(a: string, b: string): boolean {
  return canonicalise(a) === canonicalise(b);
}
/** [V2] B31 exact-match rule for a recorded vendor-CLI exe: identical strings, absolute, no `..` segment, no surrounding
 *  whitespace, never a `.cmd` / `.bat` (a CLI job is only ever spawned from an `.exe` - or, in e2e, the recorded node.exe seam). */
export function isExactCliExePath(pidFileExePath: string, recorded: string): boolean {
  if (typeof recorded !== 'string' || recorded.length === 0 || pidFileExePath !== recorded) return false;
  if (recorded.trim() !== recorded || !path.isAbsolute(recorded)) return false;
  if (/(^|[\\/])\.\.([\\/]|$)/.test(recorded)) return false;
  return /\.exe$/i.test(recorded);
}

/** [R2] The pid file is UNTRUSTED input. parsePidFile returns null unless: pid is a safe integer with 0 < pid < 2**31; exePath is an absolute
 *  path whose normalised form starts with one of `ownResourcesDir` + sep or equals one of `execPath`; startedAt is a finite safe integer > 0.
 *  A null result counts as a stale file (deleted, never used). No field is ever interpolated into a shell string or a WQL filter.
 *
 *  `ownResourcesDir` and `execPath` widened from `string` to `string | readonly string[]` (purely additive: every caller
 *  written against the frozen CONTRACTS section 13 shape still compiles). Unpackaged the three staged resource trees are
 *  NOT nested under one directory - see `childExeRoots()` in paths.ts. An empty root list accepts no directory at all. */
export function parsePidFile(
  jsonText: string,
  ownResourcesDir: string | readonly string[],
  execPath: string | readonly string[],
  /** [V2 ADD] C2 13 parsePidFileV2: (c) EXACTLY equal (case-insensitive, normalised) to one of the locator-resolved claude.exe / agy.exe
   *  paths recorded in meta.cli_exe_paths_json at provider start. [W0 refinement] defaulted to [] so every v1 caller keeps compiling. */
  acceptedCliExePaths: readonly string[] = [],
): PidFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const pid = o.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pid >= MAX_PID) return null;

  const startedAt = o.startedAt;
  if (typeof startedAt !== 'number' || !Number.isSafeInteger(startedAt) || startedAt <= 0) return null;

  const exePath = o.exePath;
  if (typeof exePath !== 'string' || exePath.length === 0 || exePath.includes('\0') || !path.isAbsolute(exePath))
    return null;
  const normalised = path.resolve(exePath);
  const roots = typeof ownResourcesDir === 'string' ? [ownResourcesDir] : ownResourcesDir;
  const execPaths = typeof execPath === 'string' ? [execPath] : execPath;
  const insideARoot = roots.some((dir) => typeof dir === 'string' && dir.length > 0 && isInsideDir(normalised, dir));
  const isAnExecPath = execPaths.some((p) => typeof p === 'string' && p.length > 0 && isSamePath(normalised, p));
  // [V2, B31 / T2 5] a CLI exe is accepted only when the pid file carries EXACTLY the recorded string: the JobRunner writes the
  // locator-resolved path verbatim, so a case-changed, trailing-space, `..` or `.cmd` variant can only come from a forged file.
  const isACliExe = acceptedCliExePaths.some((p) => isExactCliExePath(exePath, p));
  if (!insideARoot && !isAnExecPath && !isACliExe) return null;

  return { pid, exePath: normalised, startedAt };
}

export interface Supervisor {
  register(spec: ChildSpec): void;
  start(name: ChildName): Promise<void>;
  stop(name: ChildName, opts?: { graceMs?: number }): Promise<void>;
  restart(name: ChildName): Promise<void>;
  resetBreaker(name: ChildName): void; // only from a user click ("Try again")
  state(name: ChildName): ChildState;
  onState(cb: (name: ChildName, s: ChildState) => void): () => void;
  stopAll(opts: { graceMs: number }): Promise<void>; // ordered: llama, calendar-mcp, bridge
  killAllSync(): void; // session-end / process 'exit' ; by PID only, NEVER by image name
}

/**
 * `runDir`, `now` and `log` are the frozen deps (CONTRACTS section 13). `clock`, `processQuery`, `killSync` and `random` are
 * ADDITIVE and OPTIONAL: TESTS 4.3 names proc/supervisor.ts as an S-CLOCK and S-SPAWN injection point, and every caller
 * written against the frozen three-key object still compiles and gets the production defaults.
 */
export interface SupervisorDeps {
  runDir: string;
  now: () => EpochMs;
  log: (event: string, meta: Record<string, string | number>) => void;
  clock?: Clock;
  processQuery?: ProcessQuery;
  killSync?: (pid: number) => void;
  random?: RandomSource;
  /** [V2 ADD, B2] the JobRunner (structural slice, no import cycle): `stopAll` kills every running job FIRST, then the children
   *  in STOP_ORDER ("Quit kills jobs before supervisor.stopAll", T2 5 call-order row). Optional so every v1 caller keeps compiling. */
  jobs?: { killAll(): Promise<void> };
}

/** Wraps a real ChildProcess as a ChildHandle (used by bridge/launcher.ts, llm/local/llamaServer.ts and the lane-1 tests). */
export function handleFromChildProcess(child: ChildProcess, exePath: string): ChildHandle {
  return {
    pid: child.pid ?? -1,
    exePath,
    kill: () => {
      child.kill();
    },
    onExit: (cb) => {
      child.once('exit', (code, signal) => cb({ code: code ?? null, signal: signal ?? null }));
      child.once('error', () => cb({ code: null, signal: null }));
    },
  };
}

function reasonOf(err: unknown): string {
  if (err instanceof Error) return err.name;
  return typeof err;
}

/** The production Clock (S-CLOCK default). Tests inject tests/helpers/virtualClock.ts instead. */
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (t) => {
    globalThis.clearTimeout(t as ReturnType<typeof globalThis.setTimeout>);
  },
};

/**
 * Default ProcessQuery of the supervisor: kill only. `taskkill /PID <pid> /T /F`, `shell:false`, by PID - never `/IM`.
 * `query()` always resolves null because the Win32_Process lookup belongs to proc/reaper.ts, which owns the full ProcessQuery.
 */
export function createTaskkillOnlyQuery(deps: { spawn?: SpawnFn } = {}): ProcessQuery {
  const spawnFn: SpawnFn = deps.spawn ?? ((command, args, options) => cp.spawn(command, [...args], options));
  return {
    query: () => Promise.resolve(null),
    kill: (pid, tree) =>
      new Promise<void>((resolve) => {
        const child = spawnFn('taskkill', taskkillArgs(pid, tree), {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
        child.once('error', () => resolve());
        child.once('close', () => resolve());
      }),
  };
}

/** Default `killAllSync` primitive: synchronous `taskkill /PID <pid> /T /F` for `session-end` / `process.on('exit')`. */
export function createSyncTaskkill(deps: { spawnSync?: SpawnSyncFn } = {}): (pid: number) => void {
  const spawnSyncFn: SpawnSyncFn =
    deps.spawnSync ?? ((command, args, options) => cp.spawnSync(command, [...args], options));
  return (pid) => {
    spawnSyncFn('taskkill', taskkillArgs(pid, true), { shell: false, windowsHide: true, stdio: 'ignore' });
  };
}

interface Entry {
  spec: ChildSpec;
  state: ChildState;
  handle: ChildHandle | null;
  attempt: number;
  exits: EpochMs[];
  breakerOpen: boolean;
  stopping: boolean;
  probeMisses: number;
  probeTimer: ClockTimer | null;
  backoffTimer: ClockTimer | null;
  stableTimer: ClockTimer | null;
  generation: number;
  exitWaiters: Array<() => void>;
  pending: Promise<void> | null;
  /** When this generation's handle was adopted; the pid file carries the same value. 0 = no child was ever adopted. */
  startedAt: EpochMs;
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const clock = deps.clock ?? realClock;
  const processQuery = deps.processQuery ?? createTaskkillOnlyQuery();
  const killSync = deps.killSync ?? createSyncTaskkill();
  const randomFloat = (): number => deps.random?.float() ?? Math.random();
  const now = (): EpochMs => deps.now();
  const log = deps.log;
  const runDir = deps.runDir;

  const entries = new Map<ChildName, Entry>();
  const stateListeners = new Set<(name: ChildName, s: ChildState) => void>();

  const must = (name: ChildName): Entry => {
    const e = entries.get(name);
    if (!e) throw new Error(`supervisor: child "${name}" is not registered`);
    return e;
  };

  const clearTimer = (t: ClockTimer | null): null => {
    if (t !== null) clock.clearTimeout(t);
    return null;
  };

  const setState = (e: Entry, s: ChildState): void => {
    if (e.state === s) return;
    e.state = s;
    log('proc_state', { name: e.spec.name, state: s });
    for (const cb of [...stateListeners]) cb(e.spec.name, s);
  };

  // ------------------------------------------------------------------ pid files
  const pidPath = (name: ChildName): string => path.join(runDir, `${name}.pid.json`);
  const writePidFile = (e: Entry, handle: ChildHandle): void => {
    // Remembered on the entry, not just written to the file: killChild compares it against Win32_Process.CreationDate.
    // A handle's `spawnedAt` is only honoured when parsePidFile would accept it back; anything else falls back to now().
    const stamped = handle.spawnedAt;
    e.startedAt =
      typeof stamped === 'number' && Number.isSafeInteger(stamped) && stamped > 0 ? (stamped as EpochMs) : now();
    const body: PidFile = { pid: handle.pid, exePath: handle.exePath, startedAt: e.startedAt };
    const target = pidPath(e.spec.name);
    const tmp = `${target}.tmp`;
    try {
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(body), 'utf8');
      fs.renameSync(tmp, target); // atomic replace on the same volume
    } catch (err) {
      log('proc_pidfile_write_failed', { name: e.spec.name, reason: reasonOf(err) });
    }
  };
  const removePidFile = (e: Entry): void => {
    try {
      fs.rmSync(pidPath(e.spec.name), { force: true });
    } catch (err) {
      log('proc_pidfile_remove_failed', { name: e.spec.name, reason: reasonOf(err) });
    }
  };

  // ------------------------------------------------------------------ timing helpers
  const sleep = (ms: number): { promise: Promise<void>; cancel: () => void } => {
    let timer: ClockTimer | null = null;
    const promise = new Promise<void>((resolve) => {
      timer = clock.setTimeout(() => {
        timer = null;
        resolve();
      }, ms);
    });
    return {
      promise,
      cancel: () => {
        timer = clearTimer(timer);
      },
    };
  };

  /** `min(60 s, backoffMs[attempt])` + jitter in [0, 15 %). */
  const backoffDelay = (e: Entry): number => {
    const table = e.spec.backoffMs;
    const base = table.length === 0 ? 0 : (table[Math.min(e.attempt, table.length - 1)] ?? 0);
    const capped = Math.min(MAX_BACKOFF_MS, Math.max(0, base));
    return capped + Math.floor(capped * JITTER_RATIO * randomFloat());
  };

  const waitForExit = (e: Entry): Promise<void> =>
    new Promise<void>((resolve) => {
      e.exitWaiters.push(resolve);
    });

  // ------------------------------------------------------------------ exit handling
  const onExit = (e: Entry, generation: number, info: { code: number | null; signal: string | null }): void => {
    if (generation !== e.generation) return; // a stale handle reporting after it was replaced
    e.generation += 1;
    e.handle = null;
    e.probeTimer = clearTimer(e.probeTimer);
    e.stableTimer = clearTimer(e.stableTimer);
    removePidFile(e);
    for (const resolve of e.exitWaiters.splice(0)) resolve();

    if (e.stopping) {
      e.stopping = false;
      setState(e, 'stopped');
      return;
    }

    // Any exit while not stopping is a crash - including a clean code 0 (ARCHITECTURE section 14).
    log('proc_crash', { name: e.spec.name, code: info.code ?? -1, signal: info.signal ?? '' });
    const t = now();
    e.exits.push(t);
    e.exits = e.exits.filter((x) => x > t - e.spec.breaker.windowMs);

    if (e.exits.length >= e.spec.breaker.maxExits) {
      e.breakerOpen = true;
      log('proc_breaker_open', { name: e.spec.name, exits: e.exits.length, windowMs: e.spec.breaker.windowMs });
      setState(e, 'failed');
      return;
    }
    if (e.spec.terminal?.() === true) {
      log('proc_terminal', { name: e.spec.name });
      setState(e, 'failed');
      return;
    }

    const delay = backoffDelay(e);
    e.attempt += 1;
    log('proc_backoff', { name: e.spec.name, attempt: e.attempt, delayMs: delay });
    setState(e, 'backoff');
    e.backoffTimer = clock.setTimeout(() => {
      e.backoffTimer = null;
      void launch(e);
    }, delay);
  };

  /**
   * Reason to REFUSE `taskkill /PID <pid> /T /F`, or null when nothing contradicts "this pid is still our child".
   *
   * Only a positive contradiction vetoes: a `query()` that answers null is "unknown" (the supervisor's own default
   * ProcessQuery cannot look a pid up at all - see createTaskkillOnlyQuery), and treating unknown as a veto would
   * silently disable the escalation and leave real orphans alive. Under the production ProcessQuery a recycled pid
   * DOES return a row, and that row is what this check throws out.
   */
  const taskkillVeto = async (e: Entry, handle: ChildHandle): Promise<string | null> => {
    const pid = handle.pid;
    // handle.pid is `childPid ?? 0` for the calendar MCP and `child.pid ?? -1` for a spawned child: never kill those.
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid >= MAX_PID) return 'bad_pid';
    let info: ProcessInfo | null;
    try {
      info = await processQuery.query(pid);
    } catch {
      return null; // the lookup itself failed: unknown, not a contradiction
    }
    if (info === null) return null;
    if (info.executablePath !== null && !isSamePath(info.executablePath, handle.exePath)) return 'exe_mismatch';
    // Our child was created at or before the moment we adopted its handle. A pid recycled after our child died shows a
    // creation time later than that, so anything beyond the tolerance is somebody else's process.
    if (info.creationDate !== null && e.startedAt > 0 && info.creationDate > e.startedAt + PID_REUSE_TOLERANCE_MS)
      return 'created_after_start';
    return null;
  };

  /** `child.kill()`, then `taskkill /PID <pid> /T /F` after the grace period; the exit is synthesised if nothing arrives. */
  const killChild = async (e: Entry, graceMs: number): Promise<void> => {
    const handle = e.handle;
    if (!handle) return;
    const pid = handle.pid;
    const generation = e.generation;
    let exited = false;
    const exitedPromise = waitForExit(e).then(() => {
      exited = true;
    });
    try {
      handle.kill();
    } catch (err) {
      log('proc_kill_failed', { name: e.spec.name, reason: reasonOf(err) });
    }
    const grace = sleep(graceMs);
    await Promise.race([exitedPromise, grace.promise]);
    grace.cancel();
    if (exited || e.generation !== generation || e.handle === null) return;
    // `taskkill /T /F` is the one action here that can reach a process we do not own: the grace window is long enough
    // for Windows to recycle the pid, and `/T` would take the stranger's whole tree with it. Veto the escalation on a
    // pid that cannot be ours, or on a Win32 row that positively contradicts the child we spawned.
    const veto = await taskkillVeto(e, handle);
    if (veto !== null) {
      log('proc_taskkill_skipped', { name: e.spec.name, pid, reason: veto });
    } else {
      log('proc_taskkill', { name: e.spec.name, pid });
      await processQuery.kill(pid, true);
    }
    // The exit is synthesised either way: a vetoed kill must never leave the entry wedged in 'stopping'.
    if (e.generation === generation && e.handle !== null) onExit(e, generation, { code: null, signal: 'SIGKILL' });
  };

  // ------------------------------------------------------------------ liveness probe
  const scheduleProbe = (e: Entry): void => {
    const probe = e.spec.probe;
    if (!probe) return;
    const interval = e.spec.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    const maxMisses = e.spec.probeMisses ?? DEFAULT_PROBE_MISSES;
    const tick = async (): Promise<void> => {
      e.probeTimer = null;
      if (e.state !== 'running') return;
      let alive: boolean;
      try {
        alive = await probe();
      } catch {
        alive = false; // a throwing probe counts as a miss, never as a crash
      }
      if (e.state !== 'running') return;
      if (alive) {
        e.probeMisses = 0;
      } else {
        e.probeMisses += 1;
        log('proc_probe_miss', { name: e.spec.name, misses: e.probeMisses });
        if (e.probeMisses >= maxMisses) {
          log('proc_probe_dead', { name: e.spec.name, misses: e.probeMisses });
          await killChild(e, DEFAULT_GRACE_MS); // the synthesised exit is a crash => backoff + respawn
          return;
        }
      }
      e.probeTimer = clock.setTimeout(() => void tick(), interval);
    };
    e.probeTimer = clock.setTimeout(() => void tick(), interval);
  };

  // ------------------------------------------------------------------ start
  const startEntry = async (e: Entry): Promise<void> => {
    if (e.breakerOpen) {
      log('proc_start_refused', { name: e.spec.name, reason: 'breaker_open' });
      return;
    }
    if (e.state === 'starting' || e.state === 'running' || e.state === 'stopping') return;
    e.backoffTimer = clearTimer(e.backoffTimer);
    e.stopping = false;
    e.probeMisses = 0;
    setState(e, 'starting');
    const attempt = e.attempt;
    const generation = ++e.generation;

    let handle: ChildHandle;
    try {
      handle = await e.spec.start(attempt);
    } catch (err) {
      log('proc_start_failed', { name: e.spec.name, attempt, reason: reasonOf(err) });
      onExit(e, generation, { code: null, signal: null }); // a throwing start counts as an exit
      return;
    }

    if (e.generation !== generation) {
      // stop()/killAllSync() overtook us while spec.start was pending
      try {
        handle.kill();
      } catch {
        /* already gone */
      }
      return;
    }
    if (e.stopping) {
      e.stopping = false;
      try {
        handle.kill();
      } catch {
        /* already gone */
      }
      setState(e, 'stopped');
      return;
    }

    e.handle = handle;
    writePidFile(e, handle);
    // Attaching the exit callback can re-enter onExit() SYNCHRONOUSLY: a ChildSpec may hand back a handle for a child
    // whose exit is already known, and llm/local/llamaServer.ts does exactly that (its onExit calls back inline when
    // `exitInfo !== null` - reachable when the GET /health 200 was already on the wire as the process died). At this
    // instant `generation === e.generation`, so the full crash path runs here: generation++, handle = null, pid file
    // removed, exit recorded, backoff armed (or the breaker opened).
    handle.onExit((info) => onExit(e, generation, info));
    if (e.generation !== generation) return;
    // ^ the exit landed during the attach. Falling through would overwrite that crash bookkeeping with 'running' and
    // wedge the entry forever: startEntry returns early on `state === 'running'` when the backoff timer fires, and
    // killChild returns early on `!handle`, so nothing ever respawns, reaps or probes this child again.
    setState(e, 'running');
    e.stableTimer = clock.setTimeout(() => {
      e.stableTimer = null;
      e.attempt = 0; // "reset after stableAfterMs of stable running" - the breaker window is deliberately NOT reset
      log('proc_stable', { name: e.spec.name, afterMs: e.spec.stableAfterMs });
    }, e.spec.stableAfterMs);
    scheduleProbe(e);
  };

  /** Every path into startEntry goes through here so `stop()` can always await an in-flight start (including a backoff retry). */
  const launch = (e: Entry): Promise<void> => {
    const p = startEntry(e).finally(() => {
      if (e.pending === p) e.pending = null;
    });
    e.pending = p;
    return p;
  };

  const start = (name: ChildName): Promise<void> => launch(must(name));

  const stop = async (name: ChildName, opts?: { graceMs?: number }): Promise<void> => {
    const e = must(name);
    e.backoffTimer = clearTimer(e.backoffTimer);
    e.stableTimer = clearTimer(e.stableTimer);
    e.probeTimer = clearTimer(e.probeTimer);
    if (e.state === 'stopped') return;
    if (e.state === 'failed' && e.handle === null && e.pending === null) return; // the breaker stays visible until resetBreaker()
    e.stopping = true;
    if (e.state !== 'starting') setState(e, 'stopping');
    const inFlight = e.pending;
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        /* startEntry never rejects, but never let stop() throw */
      }
    }
    if (e.handle) {
      setState(e, 'stopping');
      await killChild(e, opts?.graceMs ?? DEFAULT_GRACE_MS);
    }
    e.stopping = false;
    removePidFile(e); // idempotent: the exit handler usually removed it already
    setState(e, 'stopped'); // no-op when the exit handler already reported 'stopped'
  };

  return {
    register(spec) {
      entries.set(spec.name, {
        spec,
        state: 'stopped',
        handle: null,
        attempt: 0,
        exits: [],
        breakerOpen: false,
        stopping: false,
        probeMisses: 0,
        probeTimer: null,
        backoffTimer: null,
        stableTimer: null,
        generation: 0,
        exitWaiters: [],
        pending: null,
        startedAt: 0,
      });
    },
    start,
    stop,
    async restart(name) {
      const e = must(name);
      await stop(name);
      e.attempt = 0; // a deliberate restart starts from the top of the backoff table
      await start(name);
    },
    resetBreaker(name) {
      const e = must(name);
      e.breakerOpen = false;
      e.exits = [];
      e.attempt = 0;
      log('proc_breaker_reset', { name });
      if (e.state === 'failed') setState(e, 'stopped');
    },
    state(name) {
      return must(name).state;
    },
    onState(cb) {
      stateListeners.add(cb);
      return () => {
        stateListeners.delete(cb);
      };
    },
    async stopAll(opts) {
      // [V2] jobs (claude.exe / agy.exe / whisper-cli.exe) die before any supervised child: a CLI job may hold a tool-server
      // request that reads through the children, and nothing may outlive the quit (I7').
      if (deps.jobs) {
        try {
          await deps.jobs.killAll();
        } catch (err) {
          log('proc_jobs_kill_failed', { reason: reasonOf(err) });
        }
      }
      for (const name of STOP_ORDER) {
        if (entries.has(name)) await stop(name, { graceMs: opts.graceMs });
      }
    },
    killAllSync() {
      for (const e of entries.values()) {
        e.backoffTimer = clearTimer(e.backoffTimer);
        e.stableTimer = clearTimer(e.stableTimer);
        e.probeTimer = clearTimer(e.probeTimer);
        const handle = e.handle;
        // Invalidate the exit callback FIRST: this is the session-end path, a late exit must not schedule a respawn.
        e.generation += 1;
        e.handle = null;
        if (handle && handle.pid > 0) {
          log('proc_kill_sync', { name: e.spec.name, pid: handle.pid });
          try {
            handle.kill();
          } catch {
            /* already gone */
          }
          killSync(handle.pid); // taskkill /PID <pid> /T /F - never /IM
        }
        e.stopping = false;
        removePidFile(e);
        setState(e, 'stopped');
      }
    },
  };
}
