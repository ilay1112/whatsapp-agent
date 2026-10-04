// src/main/proc/reaper.ts
// Signatures pasted verbatim from docs/specs/contracts.md section 13 (owner W1-01); Wave 1 adds the bodies below them.
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ProcessInfo, ProcessQuery, SpawnFn } from '../deps';
import type { EpochMs } from '../../shared/types';
import { isChildName, isSamePath, parsePidFile, taskkillArgs } from './supervisor';
import { jobKindOfPidFile } from './jobRunner';
import type { ChildName } from './supervisor';

const PID_FILE_SUFFIX = '.pid.json';
/** Win32_Process.CreationDate vs the pid file's `startedAt` must agree within +-2 s (ARCHITECTURE section 13). */
export const CREATION_TOLERANCE_MS = 2_000;

/**
 * [v2-closeout] The pid travels in this environment variable of the query process - never in argv, never interpolated into the
 * `-Command` string or a WQL literal. (Until this round it was appended as `-- <pid>` after `-Command`; PowerShell joins EVERY token after
 * `-Command` into the script text, so `$args[0]` was always empty, the script ended `ConvertTo-Json -- <pid>`, exited 1 and the reaper
 * never matched a single orphan in production.) The JS side validates a positive safe integer first; `[int]` makes PowerShell itself
 * reject anything else, and a missing / non-positive value exits before any query (`[int]$null` would be pid 0, the idle process).
 */
export const REAPER_PID_ENV = 'REAPER_QUERY_PID';
export const PS_QUERY_ARGS: readonly string[] = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  `$p = [int]$env:${REAPER_PID_ENV}; if ($p -le 0) { exit 2 }; ` +
    `Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p) | Select-Object ProcessId,ExecutablePath,CreationDate | ConvertTo-Json -Compress`,
];
/** A hung query (WMI stall) is killed and answers null after this long: the startup reaper never blocks the app's start. */
export const REAPER_QUERY_TIMEOUT_MS = 15_000;

/** The query's whole environment: the two Windows roots PowerShell needs plus the pid. Nothing else of the app's env is passed. */
export function reaperQueryEnv(
  pid: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows';
  return { SystemRoot: root, windir: env.windir ?? root, [REAPER_PID_ENV]: String(pid) };
}

/** ConvertTo-Json renders a DateTime as `/Date(ms)/` (Windows PowerShell 5.1) or as an ISO-8601 string (PowerShell 7). */
export function parseCreationDate(value: unknown): EpochMs | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const dotNet = /^\/Date\((-?\d+)\)\/$/.exec(value);
  if (dotNet?.[1] !== undefined) {
    const ms = Number(dotNet[1]);
    return Number.isFinite(ms) ? ms : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parses the `Select-Object ... | ConvertTo-Json` payload; returns null unless the row really is the pid we asked for. */
export function parseProcessJson(pid: number, jsonText: string): ProcessInfo | null {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (Array.isArray(raw)) raw = raw[0];
  if (raw === null || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (row.ProcessId !== pid) return null;
  const exe = typeof row.ExecutablePath === 'string' && row.ExecutablePath.length > 0 ? row.ExecutablePath : null;
  return { pid, executablePath: exe, creationDate: parseCreationDate(row.CreationDate) };
}

const MAX_QUERY_OUTPUT = 64 * 1024;

/** Production ProcessQuery: `powershell.exe` for the lookup, `taskkill` for the kill - both `shell:false`, both by PID only. */
export function createWindowsProcessQuery(deps: { spawn?: SpawnFn } = {}): ProcessQuery {
  const spawnFn: SpawnFn = deps.spawn ?? ((command, args, options) => cp.spawn(command, [...args], options));
  return {
    query: (pid) =>
      new Promise<ProcessInfo | null>((resolve) => {
        if (!Number.isSafeInteger(pid) || pid <= 0) {
          resolve(null); // defence in depth: parsePidFile already rejected everything else
          return;
        }
        const child = spawnFn('powershell.exe', [...PS_QUERY_ARGS], {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: reaperQueryEnv(pid),
        });
        let out = '';
        let settled = false;
        const finish = (v: ProcessInfo | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(v);
        };
        const timer = setTimeout(() => {
          finish(null);
          try {
            child.kill();
          } catch {
            /* already gone */
          }
        }, REAPER_QUERY_TIMEOUT_MS);
        timer.unref?.();
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          if (out.length < MAX_QUERY_OUTPUT) out += chunk;
        });
        child.once('error', () => finish(null));
        child.once('close', () => finish(parseProcessJson(pid, out)));
      }),
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

/**
 * [v2-closeout] Win32_Process.CreationDate is wall-clock time, while pid files and the supervisor stamp `startedAt` with the APP clock.
 * In production both are Date.now(). Under the e2e `WCA_NOW` seam the app clock is based at a fixed instant, so the comparison (reaper
 * match, supervisor taskkill veto) must happen in ONE time base: this wrapper moves every creation time by `offsetMs()` (= app clock -
 * wall clock). index.ts uses it only when the seam clock is active; an offset of 0 returns the query unchanged.
 */
export function inAppClockBase(q: ProcessQuery, offsetMs: () => number): ProcessQuery {
  return {
    kill: (pid, tree) => q.kill(pid, tree),
    query: async (pid) => {
      const info = await q.query(pid);
      if (info === null || info.creationDate === null) return info;
      return { ...info, creationDate: info.creationDate + offsetMs() };
    },
  };
}

/**
 * `runDir` and `ownResourcesDir` are the frozen parameters (CONTRACTS section 13). `deps` is ADDITIVE and OPTIONAL so the
 * S-SPAWN seam of TESTS 4.3 exists: a test injects a ProcessQuery (or just a SpawnFn) and asserts it was never called.
 *
 * `ownResourcesDir` and `deps.execPath` accept a LIST as well as a single path (purely additive widening). Unpackaged the
 * llama and calendar-mcp trees sit OUTSIDE `<appRoot>\resources`, so compose.ts passes `childExeRoots(paths)`; the e2e
 * seam commands (WCA_BRIDGE_CMD / WCA_MCP_CMD / WCA_LLAMA_CMD) are passed as extra exact `execPath` entries.
 */
export interface ReapDeps {
  processQuery?: ProcessQuery;
  spawn?: SpawnFn;
  execPath?: string | readonly string[];
  log?: (event: string, meta: Record<string, string | number>) => void;
  toleranceMs?: number;
  /** [V2 ADD] C2 13 reapOrphansV2 third parameter, carried in deps so every v1 caller keeps compiling (W0 refinement): the
   *  locator-resolved CLI exe paths of meta.cli_exe_paths_json. Job pid files (job-<kind>-<uuid>.pid.json) are V2-W1-06's. */
  acceptedCliExePaths?: readonly string[];
}

function matches(info: ProcessInfo, file: { exePath: string; startedAt: EpochMs }, toleranceMs: number): boolean {
  if (info.executablePath === null || !isSamePath(info.executablePath, file.exePath)) return false;
  if (info.creationDate === null) return false;
  return Math.abs(info.creationDate - file.startedAt) <= toleranceMs;
}

export async function reapOrphans(
  runDir: string,
  ownResourcesDir: string | readonly string[],
  deps: ReapDeps = {},
): Promise<{ killed: Array<ChildName | 'job-voice' | 'job-cli'>; stalePidFiles: number }> {
  const execPath = deps.execPath ?? process.execPath;
  const log = deps.log ?? ((): void => {});
  const toleranceMs = deps.toleranceMs ?? CREATION_TOLERANCE_MS;
  const query = deps.processQuery ?? createWindowsProcessQuery({ spawn: deps.spawn });

  const killed: Array<ChildName | 'job-voice' | 'job-cli'> = [];
  let stalePidFiles = 0;

  let files: string[];
  try {
    files = fs.readdirSync(runDir).filter((f) => f.toLowerCase().endsWith(PID_FILE_SUFFIX));
  } catch {
    return { killed, stalePidFiles: 0 }; // no run dir yet: nothing was ever spawned
  }

  const discard = (full: string): void => {
    try {
      fs.rmSync(full, { force: true });
    } catch (err) {
      log('reaper_pidfile_remove_failed', { reason: err instanceof Error ? err.name : typeof err });
    }
  };

  for (const file of files) {
    const full = path.join(runDir, file);
    const name = file.slice(0, -PID_FILE_SUFFIX.length).toLowerCase();

    let text: string;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      stalePidFiles += 1;
      discard(full);
      continue;
    }

    // [R2] parsePidFile FIRST: a rejected file is discarded and nothing is spawned, queried or killed.
    // [V2, B31] job pid files are routed by kind: a CLI job is accepted ONLY with an exePath exactly equal to a recorded
    // locator-resolved CLI path; a voice job (whisper) and the three children only under our roots / the execPath list.
    const jobKind = jobKindOfPidFile(file);
    const parsed =
      jobKind === 'cli'
        ? parsePidFile(text, [], [], deps.acceptedCliExePaths ?? [])
        : parsePidFile(text, ownResourcesDir, execPath, []);
    if (parsed === null || (jobKind === null && !isChildName(name))) {
      stalePidFiles += 1;
      log('reaper_pidfile_rejected', { file: name });
      discard(full);
      continue;
    }

    const info = await query.query(parsed.pid);
    if (info === null || !matches(info, parsed, toleranceMs)) {
      stalePidFiles += 1;
      log('reaper_pidfile_stale', { name, pid: parsed.pid });
      discard(full);
      continue;
    }

    log('reaper_kill', { name, pid: parsed.pid });
    await query.kill(parsed.pid, true); // taskkill /PID <pid> /T /F - never /IM
    killed.push(jobKind === null ? (name as ChildName) : (`job-${jobKind}` as const));
    discard(full);
  }

  return { killed, stalePidFiles };
}
// kills ONLY when Win32_Process.ExecutablePath is inside one of the ownResourcesDir roots (or equals one of the execPath entries - process.execPath for the
//   calendar-mcp child, plus the e2e seam commands) AND CreationDate matches startedAt (+-2 s)
// [R2] Process lookup NEVER builds a shell string: spawn('powershell.exe', PS_QUERY_ARGS (a CONSTANT script),
//   { shell: false, windowsHide: true, env: { SystemRoot, windir, REAPER_QUERY_PID: String(pid) } }) after parsePidFile() accepted the integer
//   ([v2-closeout] the pid is passed in the environment: `-Command <text> -- <pid>` never reached `$args`); kill = spawn('taskkill',
//   ['/PID', String(pid), '/T', '/F'], { shell: false }).
//   A hostile pid file (e.g. pid: "1 OR 1=1", exePath outside ownResourcesDir) results in NO spawn and NO kill (reaper test).
