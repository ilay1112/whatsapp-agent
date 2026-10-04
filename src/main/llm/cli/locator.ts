// src/main/llm/cli/{locator,runner,claudeCli,antigravityCli}.ts   [V2 ADD] (B12-B14, B26, I11)
// llm/cli/** MUST NOT import mcp/host, bridge/**, exec/** (ESLint + import-graph). The tool server arrives through AgenticRunInput / startToolServer injection.
// file 1 of 4 of the C2 9.2 block - owner V2-W1-06-claude-cli (the Wave-0 stub bodies are replaced below the frozen declarations).
import nodeFs from 'node:fs';
import path from 'node:path';
import type { CliProviderId, CliState, CliStatus, EpochMs, LlmQuota } from '../../../shared/types';
import { CLI_MIN_VERSION } from '../../../shared/types';
import { ClaudeExePathSchema } from '../../../shared/settings';
import type { LocateDeps } from '../../deps';
import type { CliRunner } from './runner';
import { AGY_WORKSPACE_DIR, buildAgyProbeEnv, buildClaudeEnv, planAgyHome } from './claudeCli.env';

// ---------------- locator.ts ----------------
/** Resolution order (claude_cli): settings.llm.cli.claudeExePath (set only by cli:pickExe; must end in \claude.exe) -> %USERPROFILE%\.local\bin\claude.exe
 *  -> `where.exe claude` entries ending in .exe -> a .cmd entry is mapped to %APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe
 *  (never the .cmd itself). antigravity_cli: %LOCALAPPDATA%\agy\bin\agy.exe -> `where.exe agy` .exe entries. Nothing is ever downloaded (B32). */
export interface CliLocation {
  provider: CliProviderId;
  exePath: string;
  version: string | null;
}
export interface CliLocator {
  find(provider: CliProviderId): Promise<CliLocation | null>;
  /** `<exe> --version` only (no login involved); parses /^(\d+)\.(\d+)\.(\d+)/ ; anything else => null. */
  version(exePath: string, signal: AbortSignal): Promise<string | null>;
  /** claude: `auth status --json` parsing ONLY `loggedIn` (other fields UNVERIFIED U-C4; unparsable => 'unknown'); agy: `-p "/usage"
   *  --output-format json` exit 0 => signed in, exit 1 + /authentication required/ => not. At most once per LIMITS.cliStatusCacheMs. */
  signedIn(provider: CliProviderId, exePath: string, signal: AbortSignal): Promise<boolean | 'unknown'>;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)/;
/** `<exe> --version` stdout ("2.1.258 (Claude Code)") -> "2.1.258"; anything else -> null. Pure. */
export function parseVersion(stdout: string): string | null {
  const m = VERSION_RE.exec(stdout.trim());
  if (m === null) return null;
  return `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`;
}

/** Numeric semver-core comparison of two `a.b.c` strings. An unparsable side compares as older (fail closed). */
export function compareVersion(a: string, b: string): -1 | 0 | 1 {
  const pa = VERSION_RE.exec(a);
  const pb = VERSION_RE.exec(b);
  if (pa === null && pb === null) return 0;
  if (pa === null) return -1;
  if (pb === null) return 1;
  for (let i = 1; i <= 3; i++) {
    const x = Number(pa[i]);
    const y = Number(pb[i]);
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** B13 status pill: not found => not_installed; version unreadable => unknown; below the floor => too_old; then the login probe. */
export function cliStateOf(
  loc: CliLocation | null,
  signedIn: boolean | 'unknown' | null,
  minVersion: string,
): CliState {
  if (loc === null) return 'not_installed';
  if (loc.version === null) return 'unknown';
  if (compareVersion(loc.version, minVersion) < 0) return 'too_old';
  if (signedIn === true) return 'ready';
  if (signedIn === false) return 'not_signed_in';
  return 'unknown';
}

// ---- v2-build-plan section 3 seam: cli:getStatus lives in ipc/handlers/cli.ts over this service (llm/cli/status.ts is NOT created) ----
/** CliStatusVM of the seam = C2 1.5 `CliStatus`. */
export type CliStatusVM = CliStatus;
export interface CliStatusService {
  get(provider: CliProviderId): Promise<CliStatusVM>;
  invalidate(): void;
}

/** [V2-W1-06, additive] What the service additionally records for the Connect card (never a path, token or CLI text). */
export interface CliStatusRecorder extends CliStatusService {
  /** cli:test / provider-start smoke outcome (B12: usable() needs ok within 24 h). */
  recordTest(provider: CliProviderId, t: { ok: boolean; at: EpochMs; ms: number | null }): void;
  /** rate_limit_event / agy /usage (AppHealth.llm.quota and the "usage resets HH:MM" line). */
  recordQuota(provider: CliProviderId, q: LlmQuota | null): void;
  /** antigravity_cli only (cli:allowWorkspace). */
  recordWorkspaceTrusted(trusted: boolean | null): void;
  /** The last computed status without probing (null = never computed). */
  peek(provider: CliProviderId): CliStatusVM | null;
}

/**
 * `get()` = find (disk / seam) + `--version` + at most one login probe per `cacheMs` (virtual clock in tests). A get() within
 * `cacheMs` of the previous one answers from the cache (no job spawned). `invalidate()` drops the cache (sign-in poll, "Test again",
 * cli:pickExe). The deps object is the frozen W0 seam; `runner` is kept for the breaker-aware callers and unused here.
 */
export function createCliStatus(deps: {
  locator: CliLocator;
  runner: CliRunner;
  clock: { now(): EpochMs };
  cacheMs: number;
  /**
   * [v2-closeout] true once the quit sequence began: get() never probes again (a probe is a CLI job - `--version`, `auth status`,
   * `agy -p /usage` - that would be spawned after killJobs and outlive app.exit() with its pid file). It answers the last known status,
   * even a stale or invalidated one, else 'unknown'. Absent = never closed.
   */
  closed?: () => boolean;
}): CliStatusRecorder {
  const cache = new Map<CliProviderId, { at: EpochMs; status: CliStatusVM }>();
  /** The last probed status per provider, kept across invalidate() for the closed path only. */
  const lastKnown = new Map<CliProviderId, CliStatusVM>();
  const inflight = new Map<CliProviderId, Promise<CliStatusVM>>();
  const tests = new Map<CliProviderId, CliStatus['lastTest']>();
  const quotas = new Map<CliProviderId, LlmQuota | null>();
  let workspaceTrusted: boolean | null = null;

  const decorate = (s: CliStatusVM): CliStatusVM => ({
    ...s,
    quota: quotas.get(s.provider) ?? null,
    lastTest: tests.get(s.provider) ?? null,
    workspaceTrusted: s.provider === 'antigravity_cli' ? workspaceTrusted : null,
  });

  const probe = async (provider: CliProviderId): Promise<CliStatusVM> => {
    const signal = AbortSignal.timeout(30_000);
    let loc: CliLocation | null = null;
    let signedIn: boolean | 'unknown' | null = null;
    try {
      loc = await deps.locator.find(provider);
      if (loc !== null && loc.version !== null && compareVersion(loc.version, CLI_MIN_VERSION[provider]) >= 0) {
        signedIn = await deps.locator.signedIn(provider, loc.exePath, signal);
      }
    } catch {
      // a failing probe (job breaker open, spawn refused) is "unknown", never a crash of the settings page
      signedIn = loc === null ? null : 'unknown';
    }
    return {
      provider,
      state: cliStateOf(loc, signedIn, CLI_MIN_VERSION[provider]),
      version: loc?.version ?? null,
      minVersion: CLI_MIN_VERSION[provider],
      quota: null,
      lastTest: null,
      workspaceTrusted: null,
    };
  };

  return {
    async get(provider) {
      const hit = cache.get(provider);
      if (hit !== undefined && deps.clock.now() - hit.at < deps.cacheMs) return decorate(hit.status);
      const running = inflight.get(provider);
      if (running !== undefined) return decorate(await running);
      if (deps.closed?.() === true) {
        // [v2-closeout] quitting: no probe job. The last known answer (a closing window only needs something to draw), else unknown.
        const known = lastKnown.get(provider);
        return decorate(
          known ?? {
            provider,
            state: 'unknown',
            version: null,
            minVersion: CLI_MIN_VERSION[provider],
            quota: null,
            lastTest: null,
            workspaceTrusted: null,
          },
        );
      }
      const p = probe(provider).then((status) => {
        cache.set(provider, { at: deps.clock.now(), status });
        lastKnown.set(provider, status);
        return status;
      });
      inflight.set(provider, p);
      try {
        return decorate(await p);
      } finally {
        inflight.delete(provider);
      }
    },
    invalidate() {
      cache.clear();
    },
    recordTest(provider, t) {
      tests.set(provider, { ok: t.ok, at: t.at, ms: t.ms });
    },
    recordQuota(provider, q) {
      quotas.set(provider, q === null ? null : { resetsAt: q.resetsAt, usingOverage: q.usingOverage });
    },
    recordWorkspaceTrusted(trusted) {
      workspaceTrusted = trusted;
    },
    peek(provider) {
      const hit = cache.get(provider);
      return hit === undefined ? null : decorate(hit.status);
    },
  };
}

/** The e2e `WCA_CLI_CMD` seam value (already validated by readSeams: node.exe + tests\fakes\<fake>.mjs + --fake-end). */
export type CliSeam = {
  claude_cli?: { command: string; args: string[] } | null;
  antigravity_cli?: { command: string; args: string[] } | null;
} | null;

/** The argv prefix a seam command needs before the production argv (`[fake.mjs, --fake-journal, ..., --fake-end]`); [] otherwise. */
export function seamArgsPrefix(seam: CliSeam, exePath: string): readonly string[] {
  if (seam === null) return [];
  for (const entry of [seam.claude_cli, seam.antigravity_cli]) {
    if (entry !== null && entry !== undefined && entry.command === exePath) return entry.args;
  }
  return [];
}

const NPM_CLAUDE_EXE = ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'] as const;
const PROBE_WALL_CLOCK_MS = 15_000;
const PROBE_GRACE_MS = 500;

/** [W0 seam] Locator factory over S-LOCATE (`WCA_CLI_CMD` replaces the disk probe in e2e mode, v2-tests 4.1). */
export function createCliLocator(
  deps: LocateDeps & {
    settingsClaudeExePath: () => string;
    seam: {
      claude_cli?: { command: string; args: string[] } | null;
      antigravity_cli?: { command: string; args: string[] } | null;
    } | null;
    jobs: import('../../proc/jobRunner').JobRunner;
    // ---- additive, optional (v2 fix wave, src/main/llm) ----
    /** [cli-sandbox-3] <userData>: every agy probe runs under the isolated <userData>\agy-home profile with cwd = <userData>\agy-workspace
     *  (F3/B14/I6'). Absent => no agy probe is ever spawned (version null, signedIn 'unknown') - never the user's real profile. */
    userDataDir?: string;
    /** writes the isolated agy profile before a probe (default node:fs). */
    agyFs?: { mkdirSync(p: string, o: { recursive: true }): unknown; writeFileSync(p: string, text: string): void };
    /** [cli-sandbox-6, B31] called with every exe path find() resolved, BEFORE the first job of that path spawns (compose records it in
     *  meta.cli_exe_paths_json so the reaper can kill an orphan of a probe / cli:test). A throw fails closed: nothing is spawned. */
    onExeResolved?: (provider: CliProviderId, exePath: string) => void;
  },
): CliLocator {
  const env = deps.env;
  const agyFs = deps.agyFs ?? {
    mkdirSync: (p: string, o: { recursive: true }) => nodeFs.mkdirSync(p, o),
    writeFileSync: (p: string, t: string) => nodeFs.writeFileSync(p, t, { encoding: 'utf8', mode: 0o600 }),
  };
  /** [cli-sandbox-3] Writes the isolated profile (idempotent) + creates the app workspace; returns the probe cwd and env. */
  const agyProbeSetup = (userDataDir: string): { cwd: string; env: Record<string, string> } => {
    const cwd = path.win32.join(userDataDir, AGY_WORKSPACE_DIR);
    const plan = planAgyHome(userDataDir, cwd);
    agyFs.mkdirSync(cwd, { recursive: true });
    for (const f of plan.files) {
      agyFs.mkdirSync(path.win32.dirname(f.path), { recursive: true });
      agyFs.writeFileSync(f.path, f.text);
    }
    return { cwd, env: buildAgyProbeEnv(env, cwd, plan.env) };
  };
  const envOf = (name: string): string | undefined => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    const v = key === undefined ? undefined : env[key];
    return v === undefined || v.length === 0 ? undefined : v;
  };
  const isFile = (p: string): boolean => {
    try {
      return deps.statFile(p)?.isFile === true;
    } catch {
      return false;
    }
  };
  const winJoin = (...parts: string[]): string => path.win32.join(...parts);

  /** A validated absolute `.exe` path (never `.cmd` / `.bat`, never relative, never with `..`). */
  const acceptableExe = (p: string, basename: 'claude.exe' | 'agy.exe'): boolean =>
    path.win32.isAbsolute(p) &&
    path.win32.basename(p).toLowerCase() === basename &&
    !/(^|\\|\/)\.\.(\\|\/|$)/.test(p) &&
    isFile(p);

  const findOnDisk = async (provider: CliProviderId): Promise<string | null> => {
    if (provider === 'claude_cli') {
      const override = deps.settingsClaudeExePath();
      if (override.length > 0) {
        // The pick is the user's explicit choice: when it is invalid or gone, the answer is "not installed", never another exe.
        return ClaudeExePathSchema.safeParse(override).success && acceptableExe(override, 'claude.exe')
          ? override
          : null;
      }
      const home = envOf('USERPROFILE');
      if (home !== undefined) {
        const local = winJoin(home, '.local', 'bin', 'claude.exe');
        if (acceptableExe(local, 'claude.exe')) return local;
      }
      const appData = envOf('APPDATA');
      if (appData !== undefined) {
        const npmExe = winJoin(appData, 'npm', ...NPM_CLAUDE_EXE);
        if (acceptableExe(npmExe, 'claude.exe')) return npmExe;
      }
    } else {
      const local = envOf('LOCALAPPDATA');
      if (local !== undefined) {
        const agy = winJoin(local, 'agy', 'bin', 'agy.exe');
        if (acceptableExe(agy, 'agy.exe')) return agy;
      }
    }
    // where.exe is the LAST resort (production only; T8: never in tests or e2e - the seam branch returned before this point).
    const name = provider === 'claude_cli' ? 'claude' : 'agy';
    const basename = provider === 'claude_cli' ? 'claude.exe' : 'agy.exe';
    let hits: string[];
    try {
      hits = await deps.runWhere(name);
    } catch {
      return null;
    }
    for (const hit of hits) {
      const h = hit.trim();
      if (/\.exe$/i.test(h) && acceptableExe(h, basename)) return h;
    }
    if (provider === 'claude_cli') {
      for (const hit of hits) {
        const h = hit.trim();
        if (!/\.cmd$/i.test(h)) continue;
        const mapped = winJoin(path.win32.dirname(h), ...NPM_CLAUDE_EXE); // the npm layout's real exe - never the .cmd itself
        if (acceptableExe(mapped, 'claude.exe')) return mapped;
      }
    }
    return null;
  };

  /** Runs one short probe job and returns its stdout lines + exit code (stdout is regex/JSON-parsed only, never logged, B26). */
  const probeJob = async (
    provider: CliProviderId,
    exePath: string,
    args: readonly string[],
    signal: AbortSignal,
  ): Promise<{ lines: string[]; exitCode: number | null; stderrMarkers: readonly string[] }> => {
    let cwd: string;
    let jobEnv: Record<string, string>;
    if (provider === 'claude_cli') {
      cwd = path.win32.isAbsolute(exePath) || path.isAbsolute(exePath) ? path.dirname(exePath) : exePath;
      jobEnv = buildClaudeEnv({ processEnv: env, tempDir: envOf('TEMP') ?? cwd, token: null });
    } else {
      // [cli-sandbox-3] never the real profile and never the install folder: no userData => no agy probe at all (fail closed).
      if (deps.userDataDir === undefined || deps.userDataDir.length === 0)
        throw new Error('agy_probe_no_isolated_profile');
      ({ cwd, env: jobEnv } = agyProbeSetup(deps.userDataDir));
    }
    return deps.jobs.run(
      {
        kind: 'cli',
        exePath,
        args: [...seamArgsPrefix(deps.seam, exePath), ...args],
        env: jobEnv,
        cwd,
        stdin: null,
        stdout: 'ndjson',
        wallClockMs: PROBE_WALL_CLOCK_MS,
        graceMs: PROBE_GRACE_MS,
        belowNormal: false,
      },
      async (job) => {
        const lines: string[] = [];
        for await (const l of job.lines()) if (lines.length < 64) lines.push(l);
        const d = await job.done;
        return { lines, exitCode: d.exitCode, stderrMarkers: d.stderrMarkers };
      },
      signal,
    );
  };

  /** Which CLI an exe path belongs to (the seam command is node.exe for both fakes; on disk the basename decides). */
  const providerOf = (exePath: string): CliProviderId => {
    if (deps.seam !== null) {
      const agy = deps.seam.antigravity_cli?.command === exePath;
      const claude = deps.seam.claude_cli?.command === exePath;
      return agy && !claude ? 'antigravity_cli' : 'claude_cli';
    }
    return path.win32.basename(exePath).toLowerCase() === 'agy.exe' ? 'antigravity_cli' : 'claude_cli';
  };

  const locator: CliLocator = {
    async find(provider) {
      let exePath: string | null;
      if (deps.seam !== null) {
        // e2e mode (T2 4.1): ONLY the validated seam command - no stat, no where.exe, never a real claude.exe / agy.exe.
        const entry = provider === 'claude_cli' ? deps.seam.claude_cli : deps.seam.antigravity_cli;
        exePath = entry === null || entry === undefined ? null : entry.command;
      } else {
        exePath = await findOnDisk(provider);
      }
      if (exePath === null) return null;
      deps.onExeResolved?.(provider, exePath); // [cli-sandbox-6, B31] recorded BEFORE the --version job below spawns
      const version = await locator
        .version(exePath, AbortSignal.timeout(PROBE_WALL_CLOCK_MS + 5_000))
        .catch(() => null);
      return { provider, exePath, version };
    },
    async version(exePath, signal) {
      const out = await probeJob(providerOf(exePath), exePath, ['--version'], signal);
      return parseVersion(out.lines[0] ?? '');
    },
    async signedIn(provider, exePath, signal) {
      if (provider === 'claude_cli') {
        const out = await probeJob(provider, exePath, ['auth', 'status', '--json'], signal);
        // ONLY `loggedIn` is read (U-C4); every other field is ignored and never stored. Exit code is not trusted.
        try {
          const parsed: unknown = JSON.parse(out.lines.join('\n'));
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            typeof (parsed as { loggedIn?: unknown }).loggedIn === 'boolean'
          )
            return (parsed as { loggedIn: boolean }).loggedIn;
        } catch {
          /* unparsable => unknown */
        }
        return 'unknown';
      }
      if (deps.userDataDir === undefined || deps.userDataDir.length === 0) return 'unknown'; // [cli-sandbox-3] fail closed, no spawn
      const out = await probeJob(provider, exePath, ['-p', '/usage', '--output-format', 'json'], signal);
      if (out.exitCode === 0) return true;
      // The isolated profile may not see the login (U-A7): agy then prints its auth prompt (on STDERR, research 5.6 - read only as
      // the JobRunner's marker) and the answer is "not signed in", the same answer the runs under that profile would get.
      if (
        out.exitCode === 1 &&
        (/authentication required/i.test(out.lines.join('\n')) || out.stderrMarkers.includes('auth_required'))
      )
        return false;
      return 'unknown';
    },
  };
  return locator;
}
