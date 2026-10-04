// src/main/proc/jobRunner.ts   ADD (B2, B26, B31) - short-lived JOBS under the supervisor's spawn / pid-file / reaper rules. Electron-free.
import type { EpochMs } from '../../shared/types';
import type { ErrorCode } from '../../shared/errors';
import cp from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { JobProcessDeps } from '../deps';
import { LIMITS } from '../../shared/types';
import { createTaskkillOnlyQuery } from './supervisor';

export const JOB_KINDS = ['voice', 'cli'] as const; // whisper-cli.exe ; claude.exe / agy.exe (one kind: concurrency 1 across both CLIs)
export type JobKind = (typeof JOB_KINDS)[number];
/** Literal env allow-lists (asserted by literal tests per kind; never process.env wholesale). Values are computed by the builder; the KEY SET is fixed. */
export const CLAUDE_ENV_KEYS = [
  'SystemRoot',
  'PATH',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'MCP_TIMEOUT',
  'MCP_TOOL_TIMEOUT',
  'ENABLE_TOOL_SEARCH',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_TELEMETRY',
  'DISABLE_ERROR_REPORTING',
  'DISABLE_AUTOUPDATER',
  'DISABLE_BUG_COMMAND',
  'CI',
  // [F8/F15, U-C7] user memory (~/.claude/CLAUDE.md, rules, auto-memory) and claude.ai connectors must not load: values '1', '1', 'false'.
  // Names re-verified against the env-vars docs at build time and by the M-CLI-1 canary; asserted by the env key-set test and the Claude CLI fake.
  'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  'ENABLE_CLAUDEAI_MCP_SERVERS',
] as const;
export const CLAUDE_S3_ENV_KEYS = [...CLAUDE_ENV_KEYS, 'WCA_MCP_TOKEN'] as const; // S3 only
export const AGY_ENV_KEYS = [
  'SystemRoot',
  'PATH',
  'USERPROFILE',
  'HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'AGY_CLI_DISABLE_AUTO_UPDATE',
] as const;
// [F3] isolated mode (default): USERPROFILE = HOME = <userData>\agy-home ; APPDATA / LOCALAPPDATA point under it too unless M-AGY-1 shows agy
// keeps its login only with the real ones (U-A7). Fallback mode (decided by M-AGY-1): the real profile, only after preflightAgyGlobalConfig() passes.
export const WHISPER_ENV_KEYS = ['SystemRoot', 'windir', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS'] as const; // = the llama list
/** Never present in any job env (test asserts absence, case-insensitively). */
export const JOB_ENV_FORBIDDEN = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_PROFILE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'WHATSAPP_BRIDGE_TOKEN',
  'LLAMA_API_KEY',
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
] as const;

export interface JobSpec {
  kind: JobKind;
  exePath: string; // resources\whisper\whisper-cli.exe, or the locator-resolved CLI path recorded in meta.cli_exe_paths_json
  args: readonly string[]; // never message text (B26) ; system prompts are app constants < 8 KB
  env: Record<string, string>; // key set == one of the lists above
  cwd: string; // fresh per-run dir (CLI) / bin dir (whisper)
  stdin: Uint8Array | null; // CLI: the ONE stream-json user line (nonce block, optional image block) ; whisper: null ('ignore')
  stdout: 'ndjson' | 'ignore'; // whisper stdout carries the transcript and is NEVER read
  wallClockMs: number;
  graceMs: number; // LIMITS.cliKillGraceMs (500) / LIMITS.voiceKillGraceMs (3000) before taskkill /PID <pid> /T /F
  belowNormal: boolean; // whisper: true
}
export interface JobHandle {
  readonly pid: number;
  /** NDJSON lines of stdout (CLI only), each parsed as JSON by the caller; raw lines are never logged (B26). */
  lines(): AsyncIterable<string>;
  write(line: string): void; // extra stdin lines (none in v2.0; kept closed after the first line)
  kill(): void; // child.kill() then taskkill after graceMs
  done: Promise<{ exitCode: number | null; killed: boolean; timedOut: boolean; stderrMarkers: string[]; ms: number }>;
}
export interface JobRunner {
  /** One promise mutex per kind (concurrency 1). Writes <userData>\run\job-<kind>-<uuid>.pid.json {pid, exePath, startedAt} atomically before
   *  resolving and deletes it on exit. spawn(exePath, args, {cwd, env, stdio, windowsHide:true, shell:false}) - shell:false is mandatory. */
  run<T>(spec: JobSpec, use: (job: JobHandle) => Promise<T>, signal: AbortSignal): Promise<T>;
  /** Breaker per kind: LIMITS.jobBreakerFailures in LIMITS.jobBreakerWindowMs => open ; open => run() rejects with JobBreakerOpenError(code). */
  breaker(kind: JobKind): { open: boolean; failures: number; openedAt: EpochMs | null };
  resetBreaker(kind: JobKind): void; // only from a user click ("Test again" / "Analyse again")
  /** Quit path: kills every running job BEFORE supervisor.stopAll(). */
  killAll(): Promise<void>;
  /** [V2 seam, v2-build-plan 3] pids of the running jobs per kind, for __wcaTest (e2e leak checks). */
  jobPids(): Record<'cli' | 'voice', number[]>;
}
export class JobBreakerOpenError extends Error {
  constructor(public readonly code: ErrorCode) {
    super('job_breaker_open');
  }
}

// =====================================================================================================================
// Implementation (V2-W1-06-claude-cli). Everything below the frozen block is additive.
// =====================================================================================================================

/** The ErrorCode a per-kind breaker reports (B2: "the feature's ErrorCode"). */
export const JOB_BREAKER_CODE: Readonly<Record<JobKind, ErrorCode>> = {
  cli: 'CLI_UNSTABLE',
  voice: 'VOICE_LOCAL_FAILED',
};
/** stdout caps of the NDJSON splitter (P2 13.1): an over-long line is dropped (never yielded, never logged); past the total cap the job is killed. */
export const JOB_LINE_CAP_BYTES = 1024 * 1024;
export const JOB_STDOUT_CAP_BYTES = 8 * 1024 * 1024;
/** How long `done` waits for the stdio 'close' after the process 'exit' before it completes anyway. */
export const JOB_CLOSE_WAIT_MS = 250;
/** stderr passes a MARKER-ONLY redactor (B26): only these names can ever leave the job, never stderr text. */
export const JOB_STDERR_MARKERS: ReadonlyArray<readonly [string, RegExp]> = [
  ['authentication_failed', /authentication[_ ]failed|not logged in|please run \/login|login expired/i],
  ['rate_limit', /rate[_ ]limit/i],
  ['overloaded', /overloaded/i],
  ['model_not_found', /model[_ ]not[_ ]found/i],
  ['usage_limit', /usage limit|session limit|weekly limit/i],
  ['quota', /quota|resource_exhausted/i],
  ['agy_error', /AGY_ERROR:/],
  // agy (research 5.6 / C2 9.2): read by classifyAgyExit - auth prompt (exit 1 / exit 3), a refused stdin line (exit 1/2, U-A6), HTTP 429.
  ['auth_required', /authentication required|UNAUTHENTICATED/i],
  ['malformed_input', /malformed input|unsupported stream message/i],
  ['http_429', /\b429\b/],
];
/** Every key set a job env may have. A spec whose key set equals none of them is refused before any spawn (fail closed). */
const ALLOWED_ENV_KEY_SETS: Readonly<Record<JobKind, ReadonlyArray<readonly string[]>>> = {
  cli: [CLAUDE_ENV_KEYS, CLAUDE_S3_ENV_KEYS, AGY_ENV_KEYS],
  voice: [WHISPER_ENV_KEYS],
};
const PID_FILE_RE = /^job-(cli|voice)-[0-9a-z-]{1,64}\.pid\.json$/;

/** A spec that would break a spawn rule (env allow-list, forbidden key, relative exe or cwd). Never spawned. */
export class JobSpecError extends Error {
  constructor(public readonly reason: 'env_keys' | 'env_forbidden' | 'exe_path' | 'cwd') {
    super('job_spec_refused');
    this.name = 'JobSpecError';
  }
}
/** The OS refused to start the process (ENOENT, EACCES ...). Counts as a breaker failure. */
export class JobSpawnError extends Error {
  constructor(public readonly errno: string) {
    super('job_spawn_failed');
    this.name = 'JobSpawnError';
  }
}
/** run() was called with an already-aborted signal: nothing was spawned. */
export class JobAbortedError extends Error {
  constructor() {
    super('job_aborted');
    this.name = 'JobAbortedError';
  }
}

/** Env key check per kind (case-insensitive for the forbidden list: Windows env names are case-insensitive). */
export function envKeysAllowed(
  kind: JobKind,
  env: Readonly<Record<string, string>>,
): 'ok' | 'env_keys' | 'env_forbidden' {
  const keys = Object.keys(env);
  const forbidden = new Set<string>(JOB_ENV_FORBIDDEN.map((k) => k.toLowerCase()));
  if (keys.some((k) => forbidden.has(k.toLowerCase()))) return 'env_forbidden';
  const sorted = [...keys].sort().join('\n');
  const match = ALLOWED_ENV_KEY_SETS[kind].some((set) => [...set].sort().join('\n') === sorted);
  return match ? 'ok' : 'env_keys';
}

/** True for a file name the JobRunner writes (`job-<kind>-<id>.pid.json`); the reaper routes job pid files with it. */
export function jobKindOfPidFile(file: string): JobKind | null {
  const m = PID_FILE_RE.exec(file.toLowerCase());
  return m === null ? null : (m[1] as JobKind);
}

/** Minimal timer seam (tests use vi fake timers or inject a recorder). */
export interface JobTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}
/** The fs slice the pid files need (production = node:fs). */
export interface JobFs {
  writeFileSync(p: string, text: string): void;
  renameSync(from: string, to: string): void;
  rmSync(p: string, opts: { force: true }): void;
  mkdirSync(p: string, opts: { recursive: true }): void;
}

/**
 * `runDir`, `now`, `log` are the frozen deps (C2 13). `proc` (S-JOB, T2 4.3), `fs`, `timers` and `randomId` are ADDITIVE and
 * OPTIONAL: every caller written against the frozen three-key object keeps compiling and gets the production defaults.
 */
export interface JobRunnerDeps {
  runDir: string;
  now: () => EpochMs;
  log: (event: string, meta: Record<string, string | number>) => void;
  proc?: Partial<Pick<JobProcessDeps, 'spawn' | 'killPid' | 'setPriority'>>;
  fs?: JobFs;
  timers?: JobTimers;
  randomId?: () => string;
}

interface RunningJob {
  kind: JobKind;
  pid: number;
  kill: () => void;
  exited: Promise<void>;
}

/** Splits a byte stream into NDJSON lines with the two caps. An over-long line is dropped whole; past the total cap `onOverflow` fires once. */
export function createLineSplitter(push: (line: string) => void, onOverflow: () => void): (chunk: Buffer) => void {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let dropping = false;
  let total = 0;
  let overflowed = false;
  return (chunk: Buffer): void => {
    if (overflowed) return;
    total += chunk.length;
    if (total > JOB_STDOUT_CAP_BYTES) {
      overflowed = true;
      pending = [];
      onOverflow();
      return;
    }
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      const piece = chunk.subarray(start, nl === -1 ? chunk.length : nl);
      if (!dropping) {
        if (pendingBytes + piece.length > JOB_LINE_CAP_BYTES) {
          dropping = true;
          pending = [];
          pendingBytes = 0;
        } else if (piece.length > 0) {
          pending.push(piece);
          pendingBytes += piece.length;
        }
      }
      if (nl === -1) return;
      if (!dropping) {
        const line = Buffer.concat(pending).toString('utf8').replace(/\r$/, '');
        if (line.trim().length > 0) push(line);
      }
      pending = [];
      pendingBytes = 0;
      dropping = false;
      start = nl + 1;
    }
  };
}

/** A single-consumer async queue of lines. */
function createLineQueue(): { push(l: string): void; end(): void; iterable: AsyncIterable<string> } {
  const buffered: string[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const poke = (): void => {
    const w = wake;
    wake = null;
    if (w) w();
  };
  return {
    push(l) {
      if (ended) return;
      buffered.push(l);
      poke();
    },
    end() {
      ended = true;
      poke();
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<string> {
        return {
          async next(): Promise<IteratorResult<string>> {
            for (;;) {
              const l = buffered.shift();
              if (l !== undefined) return { value: l, done: false };
              if (ended) return { value: undefined, done: true };
              await new Promise<void>((r) => {
                wake = r;
              });
            }
          },
        };
      },
    },
  };
}

/** Marker-only stderr scan over a sliding window (never keeps or returns stderr text). */
export function createStderrScanner(): { feed(chunk: Buffer): void; markers(): string[] } {
  const found = new Set<string>();
  let tail = '';
  return {
    feed(chunk) {
      const text = tail + chunk.toString('utf8');
      for (const [name, re] of JOB_STDERR_MARKERS) if (re.test(text)) found.add(name);
      tail = text.slice(-256);
    },
    markers: () => [...found].sort(),
  };
}

const defaultSetPriority = (pid: number): void => {
  os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
};

export function createJobRunner(deps: JobRunnerDeps): JobRunner {
  const spawnFn = deps.proc?.spawn ?? ((command, args, options) => cp.spawn(command, [...args], options));
  const killPid = deps.proc?.killPid ?? ((pid: number, tree: boolean) => createTaskkillOnlyQuery().kill(pid, tree));
  const setPriority = deps.proc?.setPriority ?? defaultSetPriority;
  const jfs: JobFs = deps.fs ?? {
    writeFileSync: (p, t) => fs.writeFileSync(p, t, 'utf8'),
    renameSync: (a, b) => fs.renameSync(a, b),
    rmSync: (p, o) => fs.rmSync(p, o),
    mkdirSync: (p, o) => fs.mkdirSync(p, o),
  };
  const timers: JobTimers = deps.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
  };
  const newId = deps.randomId ?? ((): string => randomUUID());

  const mutex: Record<JobKind, Promise<void>> = { cli: Promise.resolve(), voice: Promise.resolve() };
  const failures: Record<JobKind, EpochMs[]> = { cli: [], voice: [] };
  const openedAt: Record<JobKind, EpochMs | null> = { cli: null, voice: null };
  const running = new Set<RunningJob>();

  const breakerState = (kind: JobKind): { open: boolean; failures: number; openedAt: EpochMs | null } => {
    const since = deps.now() - LIMITS.jobBreakerWindowMs;
    failures[kind] = failures[kind].filter((t) => t > since);
    return { open: openedAt[kind] !== null, failures: failures[kind].length, openedAt: openedAt[kind] };
  };
  const recordFailure = (kind: JobKind): void => {
    failures[kind].push(deps.now());
    const state = breakerState(kind);
    if (state.failures >= LIMITS.jobBreakerFailures && openedAt[kind] === null) {
      openedAt[kind] = deps.now();
      deps.log('job_breaker_open', { kind, failures: state.failures });
    }
  };

  const writePidFile = (file: string, pid: number, exePath: string, startedAt: EpochMs): void => {
    jfs.mkdirSync(deps.runDir, { recursive: true });
    const tmp = `${file}.tmp`;
    jfs.writeFileSync(tmp, JSON.stringify({ pid, exePath, startedAt }));
    jfs.renameSync(tmp, file);
  };
  const removePidFile = (file: string): void => {
    try {
      jfs.rmSync(file, { force: true });
      jfs.rmSync(`${file}.tmp`, { force: true });
    } catch (err) {
      deps.log('job_pidfile_remove_failed', { reason: err instanceof Error ? err.name : 'unknown' });
    }
  };

  const runOnce = async <T>(spec: JobSpec, use: (job: JobHandle) => Promise<T>, signal: AbortSignal): Promise<T> => {
    const envCheck = envKeysAllowed(spec.kind, spec.env);
    if (envCheck !== 'ok') throw new JobSpecError(envCheck);
    if (!path.win32.isAbsolute(spec.exePath) && !path.isAbsolute(spec.exePath)) throw new JobSpecError('exe_path');
    if (spec.exePath.includes('\0')) throw new JobSpecError('exe_path');
    if (!path.win32.isAbsolute(spec.cwd) && !path.isAbsolute(spec.cwd)) throw new JobSpecError('cwd');
    if (signal.aborted) throw new JobAbortedError();

    const startedAt = deps.now();
    let child: ChildProcess;
    try {
      child = spawnFn(spec.exePath, [...spec.args], {
        cwd: spec.cwd,
        env: { ...spec.env },
        stdio: [spec.stdin === null ? 'ignore' : 'pipe', spec.stdout === 'ndjson' ? 'pipe' : 'ignore', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      recordFailure(spec.kind);
      const code = (err as { code?: unknown } | null)?.code;
      throw new JobSpawnError(typeof code === 'string' ? code : 'spawn');
    }

    const pid = child.pid;
    if (pid === undefined) {
      // The OS refused the spawn: 'error' follows asynchronously - no pid file, no kill.
      const errno = await new Promise<string>((resolve) => {
        child.once('error', (e: Error & { code?: string }) => resolve(typeof e.code === 'string' ? e.code : 'spawn'));
        child.once('exit', () => resolve('spawn'));
      });
      recordFailure(spec.kind);
      throw new JobSpawnError(errno);
    }

    // B31 / T2 5: the pid file is written BEFORE the first await after spawn (synchronously, atomically) and removed in finally.
    const pidFile = path.join(deps.runDir, `job-${spec.kind}-${newId()}.pid.json`);
    try {
      writePidFile(pidFile, pid, spec.exePath, startedAt);
    } catch (err) {
      // Without a pid file the reaper could never find an orphan: refuse to run the job at all.
      void killPid(pid, true).catch(() => undefined);
      recordFailure(spec.kind);
      removePidFile(pidFile);
      throw err;
    }
    try {
      if (spec.belowNormal) {
        try {
          setPriority(pid, 'below_normal');
        } catch {
          /* best effort: a priority failure never fails the job */
        }
      }

      const queue = createLineQueue();
      const stderr = createStderrScanner();
      let killed = false;
      let timedOut = false;
      let exited = false;
      let graceTimer: unknown = null;
      let killing: Promise<void> = Promise.resolve(); // the tree kill in flight: `done` waits for it (no taskkill outlives the run)

      const exitPromise = new Promise<number | null>((resolve) => {
        child.once('exit', (code: number | null) => {
          exited = true;
          resolve(code);
        });
        child.once('error', () => {
          exited = true;
          resolve(null);
        });
      });
      const closed = new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          queue.end();
          resolve();
        };
        child.once('close', finish);
        void exitPromise.then(() => {
          timers.setTimeout(finish, JOB_CLOSE_WAIT_MS);
        });
      });

      const kill = (): void => {
        if (killed || exited) return;
        killed = true;
        // Tree kill FIRST while the job is still alive, so `/T` can enumerate its descendants (a dead parent's orphans cannot be
        // found by `taskkill /T`); `child.kill()` is the fallback once graceMs passed without an exit. By PID only - never `/IM`.
        killing = killPid(pid, true).catch(() => undefined);
        graceTimer = timers.setTimeout(() => {
          // Only reachable while the job is still running: `done` clears this timer as soon as 'exit' arrives.
          graceTimer = null;
          try {
            child.kill();
          } catch {
            /* already gone */
          }
        }, spec.graceMs);
      };

      child.stdout?.on(
        'data',
        createLineSplitter((l) => queue.push(l), kill),
      );
      child.stderr?.on('data', (c: Buffer) => stderr.feed(c));
      child.stdin?.on('error', () => undefined); // EPIPE when the job exits before reading stdin
      if (spec.stdin !== null && child.stdin) child.stdin.end(Buffer.from(spec.stdin));

      const wall = timers.setTimeout(() => {
        timedOut = true;
        kill();
      }, spec.wallClockMs);
      const onAbort = (): void => kill();
      signal.addEventListener('abort', onAbort);

      const entry: RunningJob = { kind: spec.kind, pid, kill, exited: exitPromise.then(() => undefined) };
      running.add(entry);

      const done = exitPromise.then(async (code) => {
        timers.clearTimeout(wall);
        if (graceTimer !== null) timers.clearTimeout(graceTimer);
        signal.removeEventListener('abort', onAbort);
        await closed;
        await killing;
        return { exitCode: code, killed, timedOut, stderrMarkers: stderr.markers(), ms: deps.now() - startedAt };
      });
      const handle: JobHandle = {
        pid,
        lines: () => queue.iterable,
        write: () => {
          throw new Error('job_stdin_closed'); // v2.0: stdin carries exactly one line and is closed right after it
        },
        kill,
        done,
      };

      try {
        const value = await use(handle);
        const d = await done;
        if (d.timedOut) recordFailure(spec.kind);
        return value;
      } catch (err) {
        kill();
        await done;
        recordFailure(spec.kind);
        throw err;
      } finally {
        running.delete(entry);
      }
    } finally {
      removePidFile(pidFile);
    }
  };

  return {
    run<T>(spec: JobSpec, use: (job: JobHandle) => Promise<T>, signal: AbortSignal): Promise<T> {
      if (breakerState(spec.kind).open) return Promise.reject(new JobBreakerOpenError(JOB_BREAKER_CODE[spec.kind]));
      const previous = mutex[spec.kind];
      let release!: () => void;
      mutex[spec.kind] = new Promise<void>((r) => {
        release = r;
      });
      return previous
        .then(() => {
          if (breakerState(spec.kind).open) throw new JobBreakerOpenError(JOB_BREAKER_CODE[spec.kind]);
          return runOnce(spec, use, signal);
        })
        .finally(() => release());
    },
    breaker: (kind) => breakerState(kind),
    resetBreaker(kind) {
      failures[kind] = [];
      openedAt[kind] = null;
    },
    async killAll(): Promise<void> {
      const jobs = [...running];
      for (const j of jobs) j.kill();
      await Promise.all(jobs.map((j) => j.exited));
    },
    jobPids() {
      const out: Record<'cli' | 'voice', number[]> = { cli: [], voice: [] };
      for (const j of running) out[j.kind].push(j.pid);
      return out;
    },
  };
}
