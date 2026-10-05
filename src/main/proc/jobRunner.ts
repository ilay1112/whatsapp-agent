// src/main/proc/jobRunner.ts   ADD (B2, B26, B31) - short-lived JOBS under the supervisor's spawn / pid-file / reaper rules. Electron-free.
import type { EpochMs } from '../../shared/types';
import type { ErrorCode } from '../../shared/errors';
import cp from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { JobProcessDeps, SpawnFn } from '../deps';
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
  // [D-080] the CLI refused the model / flag combination at start (agy 1.2.16: "invalid model selection ... conflicts with --effort=low")
  ['model_rejected', /invalid model selection|conflicts with --|unknown model|issue with the selected model/i],
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

/**
 * [v2-closeout] run() after killAll() began (the quit path): nothing was spawned and nothing ever will be. A subclass of JobAbortedError
 * so every caller that already treats an abort as "not run" (llm/cli/runner.ts, the locator probes, whisper) needs no new branch, and it
 * never counts as a breaker failure.
 */
export class JobRunnerClosedError extends JobAbortedError {
  constructor() {
    super();
    this.name = 'JobRunnerClosedError';
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
  /**
   * [cli-sandbox-4] The process table the post-exit orphan sweep reads. Default: `createWindowsProcessTable()` on win32 with the
   * production spawn; `null` (no sweep) when `proc.spawn` is injected - a fake spawn hands out fake pids, and sweeping the REAL
   * table for children of a fake pid could kill an unrelated process. `null` disables the sweep explicitly.
   */
  processTable?: JobProcessTable | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// [cli-sandbox-4] post-exit orphan sweep. `kill()` tree-kills only on the kill paths; a job that EXITS NORMALLY can leave a
// helper behind (a vendor CLI's daemon), which `taskkill /T` can no longer find once its parent is dead and which no pid file
// names. Windows never reparents an orphan, so after every job exit the runner reads Win32_Process once and tree-kills BY PID
// every process whose ParentProcessId is the dead job's pid and whose CreationDate lies inside the job's lifetime.
// Residual (documented): a grandchild whose own parent ALSO exited cannot be linked to the job any more and is not found.
// ---------------------------------------------------------------------------------------------------------------------

/** One Win32_Process row - only the three fields the sweep needs (never a name, a path or a command line). */
export interface JobProcRow {
  pid: number;
  ppid: number;
  createdAt: EpochMs;
}
export type JobProcessTable = () => Promise<readonly JobProcRow[]>;
/**
 * The kinds swept after exit: the opaque vendor CLIs (claude.exe / agy.exe), which are known to start helpers and whose env can
 * carry the per-run WCA_MCP_TOKEN. NOT 'voice': whisper-cli.exe is our own SHA-pinned single-process binary with a secret-free
 * env, and a ~1 s process-table query after every voice note would serialise behind the voice mutex for nothing.
 */
export const JOB_SWEEP_KINDS: readonly JobKind[] = ['cli'];
/** A hung process-table query is killed and the sweep gives up (kills nothing) after this long. */
export const JOB_SWEEP_QUERY_TIMEOUT_MS = 5_000;
const JOB_SWEEP_MAX_OUTPUT = 8 * 1024 * 1024;
/**
 * A CONSTANT command: nothing (no pid, no path) is ever interpolated or appended. Note `powershell -Command <text> -- <arg>` does NOT
 * pass `<arg>` as `$args[0]` - every token after -Command is joined into the script text - so the whole table is read and filtered here.
 */
export const JOB_SWEEP_PS_ARGS: readonly string[] = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress',
];

function parseCimDate(value: unknown): EpochMs | null {
  if (typeof value !== 'string') return null;
  const dotNet = /^\/Date\((-?\d+)\)\/$/.exec(value); // Windows PowerShell 5.1
  if (dotNet?.[1] !== undefined) return Number(dotNet[1]);
  const iso = Date.parse(value); // PowerShell 7
  return Number.isFinite(iso) ? iso : null;
}

/** Parses the `ConvertTo-Json` table; malformed rows are skipped; null when the text is not a process table at all. */
export function parseProcessTableJson(text: string): JobProcRow[] | null {
  if (text.trim() === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const list: unknown[] = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0 || (list.length === 1 && (list[0] === null || typeof list[0] !== 'object'))) return null;
  const rows: JobProcRow[] = [];
  for (const r of list) {
    if (r === null || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const pid = o.ProcessId;
    const ppid = o.ParentProcessId;
    const createdAt = parseCimDate(o.CreationDate);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || (pid as number) < 0 || (ppid as number) < 0)
      continue;
    if (createdAt === null) continue;
    rows.push({ pid: pid as number, ppid: ppid as number, createdAt });
  }
  return rows;
}

/**
 * The pids to tree-kill: children of `jobPid` created inside `[sinceMs, untilMs]` (the pid-reuse guard - a row whose
 * ParentProcessId names the pid but that was created before the job started belongs to an EARLIER holder of the pid; one created
 * after the exit was seen belongs to a LATER one). Never the job pid itself, never `selfPid` (the app).
 */
export function selectJobOrphans(
  rows: readonly JobProcRow[],
  jobPid: number,
  sinceMs: EpochMs,
  untilMs: EpochMs,
  selfPid: number = process.pid,
): number[] {
  const out = new Set<number>();
  for (const r of rows) {
    if (r.ppid !== jobPid || r.pid === jobPid || r.pid === selfPid || r.pid <= 0) continue;
    if (r.createdAt < sinceMs || r.createdAt > untilMs) continue;
    out.add(r.pid);
  }
  return [...out].sort((a, b) => a - b);
}

/** Production process table: one `powershell.exe` (shell:false, hidden) with the constant JOB_SWEEP_PS_ARGS. Rejects on any failure. */
export function createWindowsProcessTable(deps: { spawn?: SpawnFn; timers?: JobTimers } = {}): JobProcessTable {
  const spawnFn: SpawnFn = deps.spawn ?? ((command, args, options) => cp.spawn(command, [...args], options));
  const timers: JobTimers = deps.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
  };
  return () =>
    new Promise<readonly JobProcRow[]>((resolve, reject) => {
      const child = spawnFn('powershell.exe', [...JOB_SWEEP_PS_ARGS], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        timers.clearTimeout(timer);
        fn();
      };
      const timer = timers.setTimeout(() => {
        settle(() => reject(new Error('process_table_timeout')));
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }, JOB_SWEEP_QUERY_TIMEOUT_MS);
      child.stdout?.on('data', (c: Buffer | string) => {
        const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
        size += b.length;
        if (size <= JOB_SWEEP_MAX_OUTPUT) chunks.push(b);
      });
      child.once('error', () => settle(() => reject(new Error('process_table_spawn'))));
      child.once('close', () =>
        settle(() => {
          const rows =
            size > JOB_SWEEP_MAX_OUTPUT ? null : parseProcessTableJson(Buffer.concat(chunks).toString('utf8'));
          if (rows === null) reject(new Error('process_table_unparsable'));
          else resolve(rows);
        }),
      );
    });
}

interface RunningJob {
  kind: JobKind;
  pid: number;
  kill: () => void;
  exited: Promise<void>;
  /** [v2-repair REQUEST 10] removed by killAll() as soon as the job exited (the quit path does not wait for runOnce's finally). */
  pidFile: string;
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
  const processTable: JobProcessTable | null =
    deps.processTable !== undefined
      ? deps.processTable
      : deps.proc?.spawn === undefined && process.platform === 'win32'
        ? createWindowsProcessTable()
        : null;
  /** In-flight orphan sweeps; killAll() (the quit path) waits for them so no query or orphan outlives the app. */
  const sweeps = new Set<Promise<void>>();
  /** Never rejects. `sinceMs` / `untilMs` are wall-clock (Date.now) like Win32_Process.CreationDate, never the injected `now`. */
  const sweepOrphans = (kind: JobKind, jobPid: number, sinceMs: EpochMs, untilMs: EpochMs): Promise<void> => {
    if (processTable === null || !JOB_SWEEP_KINDS.includes(kind)) return Promise.resolve();
    const run = (async (): Promise<void> => {
      let orphans: number[];
      try {
        orphans = selectJobOrphans(await processTable(), jobPid, sinceMs, untilMs);
      } catch {
        deps.log('job_orphan_sweep_failed', { kind });
        return;
      }
      if (orphans.length === 0) return;
      deps.log('job_orphans_killed', { kind, count: orphans.length });
      // By PID with /T (the orphan is alive, so its own subtree is still enumerable) - never by image name: the user may run the
      // same vendor CLI interactively on this PC.
      await Promise.all(orphans.map((p) => killPid(p, true).catch(() => undefined)));
    })();
    sweeps.add(run);
    void run.finally(() => sweeps.delete(run));
    return run;
  };

  /**
   * [v2-closeout] The shutdown latch: set synchronously at the top of killAll() and never cleared. Checked by run() itself, again when a
   * queued run reaches the head of its mutex, and once more in runOnce() right before spawn (no await in between), so no job can start
   * after the quit sequence killed the running ones - such a job would outlive app.exit() with its pid file (I7', e2e cli-connect 7b/7c/9).
   */
  let closed = false;
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
    if (closed) throw new JobRunnerClosedError(); // [v2-closeout] last check before spawn: no await between here and spawnFn

    const startedAt = deps.now();
    const sweepSince = Date.now(); // [cli-sandbox-4] taken BEFORE spawn: every descendant's CreationDate is >= this
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
      let sweep: Promise<void> = Promise.resolve(); // [cli-sandbox-4] the post-exit orphan sweep: `done` waits for it too

      const exitPromise = new Promise<number | null>((resolve) => {
        child.once('exit', (code: number | null) => {
          exited = true;
          // Started on 'exit' only (the process is gone; an 'error' alone does not prove that), on every path - normal or killed.
          sweep = sweepOrphans(spec.kind, pid, sweepSince, Date.now());
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

      const entry: RunningJob = { kind: spec.kind, pid, kill, exited: exitPromise.then(() => undefined), pidFile };
      running.add(entry);

      const done = exitPromise.then(async (code) => {
        timers.clearTimeout(wall);
        if (graceTimer !== null) timers.clearTimeout(graceTimer);
        signal.removeEventListener('abort', onAbort);
        await closed;
        await killing;
        await sweep;
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
      if (closed) {
        deps.log('job_refused_closing', { kind: spec.kind });
        return Promise.reject(new JobRunnerClosedError());
      }
      if (breakerState(spec.kind).open) return Promise.reject(new JobBreakerOpenError(JOB_BREAKER_CODE[spec.kind]));
      const previous = mutex[spec.kind];
      let release!: () => void;
      mutex[spec.kind] = new Promise<void>((r) => {
        release = r;
      });
      return previous
        .then(() => {
          if (closed) {
            deps.log('job_refused_closing', { kind: spec.kind });
            throw new JobRunnerClosedError(); // queued before the quit, reached the head after it
          }
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
      closed = true; // [v2-closeout] the latch FIRST, synchronously: nothing queued or requested from here on is ever spawned
      const jobs = [...running];
      for (const j of jobs) j.kill();
      await Promise.all(jobs.map((j) => j.exited));
      // [v2-repair REQUEST 10] app.exit() follows at once: runOnce's finally (after the stdio close wait and the tree kill) may never
      // run, so the dead jobs leave the live set and their pid files go NOW (idempotent - the finally removes them again if it runs).
      for (const j of jobs) {
        running.delete(j);
        removePidFile(j.pidFile);
      }
      // [cli-sandbox-4] the exits above started their orphan sweeps (bounded by JOB_SWEEP_QUERY_TIMEOUT_MS; they never reject).
      await Promise.all([...sweeps]);
    },
    jobPids() {
      const out: Record<'cli' | 'voice', number[]> = { cli: [], voice: [] };
      for (const j of running) out[j.kind].push(j.pid);
      return out;
    },
  };
}
