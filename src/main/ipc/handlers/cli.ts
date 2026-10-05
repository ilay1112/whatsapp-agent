// src/main/ipc/handlers/cli.ts   ADD (C2 8 vendor-CLI channels; v2-build-plan 3 createCliHandlers) - owner V2-W1-06-claude-cli.
// cli:signIn spawns the validated exe itself in a VISIBLE console through S-CONSOLE - never cmd.exe (F7).
// Focus gating of cli:setOverage / cli:pickExe / cli:allowWorkspace is register.ts's (FOCUS_GATED_CHANNELS); these bodies re-check it
// (defence in depth) and never change a setting on a cancelled native dialog. No channel accepts a path, a token or CLI text (ARCH2 10).
import cp from 'node:child_process';
import nodeFs from 'node:fs';
import path from 'node:path';
import type { IpcContext, IpcHandlers } from '../../../shared/ipc';
import {
  CLI_MIN_VERSION,
  type CliProviderId,
  type CliSignInSession,
  type CliStatus,
  type EpochMs,
  type Result,
} from '../../../shared/types';
import { providerErrorToErrorCode, type ErrorCode, type ProviderErrorCode } from '../../../shared/errors';
import { ClaudeExePathSchema } from '../../../shared/settings';
import type { OpenVisibleConsoleFn, SpawnFn, VisibleConsoleHandle } from '../../deps';
import { fail, ok, type HandlerDepsV2 } from '../register';
import { compareVersion, type CliLocator, type CliStatusRecorder } from '../../llm/cli/locator';
import type { CliRunner } from '../../llm/cli/runner';
import { createClaudeCliProvider } from '../../llm/cli/claudeCli';
import { AGY_WORKSPACE_DIR, planAgyHome, type AgyHomeEnv } from '../../llm/cli/claudeCli.env';
import type { AutoDialog } from '../../app/autoDialog';

export type CliChannels =
  | 'cli:getStatus'
  | 'cli:signIn'
  | 'cli:setOverage'
  | 'cli:test'
  | 'cli:pickExe'
  | 'cli:previewWorkspaceChange'
  | 'cli:allowWorkspace';

/**
 * [V2-W1-06, additive] Collaborators the seven channels need beyond HandlerDepsV2 (wired by V2-W2-01). Every one is optional in the
 * handler signature so the frozen `createCliHandlers(deps: HandlerDepsV2)` keeps compiling; a missing one makes its channel fail
 * CLOSED (INTERNAL, nothing changed, nothing spawned).
 */
export interface CliHandlerExtras {
  cliLocator: CliLocator;
  cliRunner: CliRunner & { resetBreaker?(): void };
  autoDialog: Pick<AutoDialog, 'confirmSetting' | 'confirmWorkspaceTrust'>;
  /** The focused main window (dialog parent); never crosses IPC. */
  window: () => unknown;
  /** Main-owned native OPEN dialog that returns the chosen PATH (ElectronFacade.showOpenDialog returns file text, not a path). */
  pickExePath: (opts: {
    title: string;
    filters: Array<{ name: string; extensions: string[] }>;
  }) => Promise<string | null>;
  /** S-HOME: %USERPROFILE% (display facts only; since D-080 the agy sign-in console runs in the isolated <userData>\agy-home). */
  homeDir: () => string;
  /** S-PROC: "is an agy process running" (display only; cli:allowWorkspace itself refuses while it runs). */
  agyRunning: () => Promise<boolean>;
  /** Whether %USERPROFILE%\.gemini\antigravity-cli\settings.json exists (display only). */
  agySettingsExists: () => boolean;
  /** The antigravity_cli provider for cli:test (llm/cli/antigravityCli.ts createAgyProvider, V2-W1-09). */
  makeAgyForTest: (
    exePath: string,
    observedVersion: string,
  ) => {
    validate(
      signal: AbortSignal,
    ): Promise<{ ok: true; model: string } | { ok: false; reason: import('../../../shared/errors').ProviderErrorCode }>;
  };
  // ---- [D-080, additive] the guided sign-in session ----
  /** <userData>: the agy sign-in runs in the ISOLATED <userData>\agy-home profile, where every agy run looks. Absent => no agy console. */
  userDataDir: string;
  /** The env the copied-by-name values come from (= the runner's processEnv; never passed through wholesale). Default process.env. */
  processEnv: Readonly<Record<string, string | undefined>>;
  /** Pushes a status through the existing `cli:changed` channel (each session phase). */
  emitCliChanged: (status: CliStatus) => void;
  /** true once the quit sequence began: a console closing then re-tests nothing (no CLI job after killJobs). */
  closed: () => boolean;
  /** Writes the app-owned isolated agy settings.json before the console opens (default node:fs). Never reads anything. */
  signInFs: { mkdirSync(p: string, o: { recursive: true }): unknown; writeFileSync(p: string, text: string): void };
}

/** [D-080] The Windows basics an interactive login needs (copied by name when present) - never a key, token, proxy or config redirect. */
const SIGN_IN_BASE_KEYS = [
  'SystemRoot',
  'windir',
  'ComSpec',
  'PATHEXT',
  'SystemDrive',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'PUBLIC',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'TEMP',
  'TMP',
] as const;
/** The profile vars the Claude runs copy by name (claudeCli.env.ts buildClaudeEnv): the sign-in lands where the runs read it. */
const CLAUDE_PROFILE_KEYS = ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA'] as const;

/**
 * [D-080] The env of the sign-in console: the SAME profile the app's runs use, plus the Windows basics a login needs to show its prompt
 * and open the browser. claude = the profile vars copied by name exactly like buildClaudeEnv (so `auth login` writes where the runs read;
 * a CLAUDE_CONFIG_DIR / ANTHROPIC_* / proxy of the parent env is dropped, as in the runs); agy = the ISOLATED planAgyHome() profile vars
 * (required - never the real profile). PATH = the default Windows system path (not the user's PATH). Pure.
 */
export function buildSignInEnv(
  provider: CliProviderId,
  processEnv: Readonly<Record<string, string | undefined>>,
  agyHome: Readonly<AgyHomeEnv> | null,
): Record<string, string> {
  const pick = (name: string): string => {
    const key = Object.keys(processEnv).find((k) => k.toLowerCase() === name.toLowerCase());
    return (key === undefined ? undefined : processEnv[key]) ?? '';
  };
  const env: Record<string, string> = {};
  for (const k of SIGN_IN_BASE_KEYS) {
    const v = pick(k);
    if (v.length > 0) env[k] = v;
  }
  const sysRoot = pick('SystemRoot').length > 0 ? pick('SystemRoot') : 'C:\\Windows';
  env.SystemRoot = sysRoot;
  env.PATH = [
    path.win32.join(sysRoot, 'System32'),
    sysRoot,
    path.win32.join(sysRoot, 'System32', 'Wbem'),
    path.win32.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
  ].join(';');
  if (provider === 'claude_cli') {
    for (const k of CLAUDE_PROFILE_KEYS) {
      const v = pick(k);
      if (v.length > 0) env[k] = v;
    }
    env.DISABLE_AUTOUPDATER = '1';
    env.DISABLE_TELEMETRY = '1';
    env.DISABLE_ERROR_REPORTING = '1';
    return env;
  }
  if (agyHome === null) throw new Error('agy_signin_needs_isolated_profile');
  env.USERPROFILE = agyHome.USERPROFILE;
  env.HOME = agyHome.HOME;
  env.APPDATA = agyHome.APPDATA;
  env.LOCALAPPDATA = agyHome.LOCALAPPDATA;
  env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true';
  return env;
}

/** Characters a console-launched path must never contain (F7: `cmd /k` would re-parse them; we never use cmd.exe, but a path that
 *  needs them is refused anyway). Also refuses UNC paths, relative paths and `..` segments. */
const HOSTILE_PATH_RE = /["<>|?*\r\n%^&()!@]/;
export function isSafeConsoleExe(exePath: string, basenames: readonly string[]): boolean {
  if (typeof exePath !== 'string' || exePath.length === 0 || exePath.length > 260) return false;
  if (HOSTILE_PATH_RE.test(exePath) || exePath.trim() !== exePath) return false;
  if (!/^[A-Za-z]:\\/.test(exePath)) return false; // absolute drive path only (no UNC \\server\share, no relative)
  if (/(^|\\|\/)\.\.(\\|\/|$)/.test(exePath)) return false;
  return basenames.includes(path.win32.basename(exePath).toLowerCase());
}

/** The sign-in console command (pure): claude = `<exe> auth login --claudeai`; agy = `<exe>` with no args, cwd = `homeDir` (since
 *  D-080 the caller passes the isolated <userData>\agy-home, never %USERPROFILE%).
 *  Refuses any exe that is not EXACTLY the locator-validated path (T2 5: hostile values => console never opened). */
export function buildSignInCommand(
  provider: CliProviderId,
  exePath: string,
  validatedExePath: string,
  homeDir: string | null,
  seamCommand: boolean,
): { exePath: string; args: string[]; cwd?: string } | null {
  if (exePath !== validatedExePath) return null;
  const names = seamCommand ? ['node.exe'] : provider === 'claude_cli' ? ['claude.exe'] : ['agy.exe'];
  if (!isSafeConsoleExe(exePath, names)) return null;
  if (provider === 'claude_cli') return { exePath, args: ['auth', 'login', '--claudeai'] };
  return homeDir === null || homeDir.length === 0 ? { exePath, args: [] } : { exePath, args: [], cwd: homeDir };
}

/** Production S-CONSOLE: spawn the exe itself, detached, with its own VISIBLE console - never cmd.exe, never a shell (F7). */
export function createOpenVisibleConsole(deps: { spawn?: SpawnFn } = {}): OpenVisibleConsoleFn {
  const spawnFn: SpawnFn = deps.spawn ?? ((command, args, options) => cp.spawn(command, [...args], options));
  return async (exePath, args, opts): Promise<VisibleConsoleHandle> => {
    if (/(^|\\|\/)cmd(\.exe)?$/i.test(exePath)) throw new Error('console_via_cmd_refused');
    const child = spawnFn(exePath, [...args], {
      shell: false,
      detached: true,
      windowsHide: false,
      stdio: 'ignore',
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      ...(opts.env === undefined ? {} : { env: opts.env }),
    });
    // [D-080] the console's end (window closed / login finished / spawn failed) is what cli:signIn waits for; it never rejects
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
    child.unref();
    return { exited };
  };
}

const focused = (ctx: IpcContext): boolean => ctx.windowFocused && ctx.windowVisible;
const SMOKE_TIMEOUT_MS = 45_000;

export function createCliHandlers(deps: HandlerDepsV2 & Partial<CliHandlerExtras>): Pick<IpcHandlers, CliChannels> {
  const status = deps.cliStatus as HandlerDepsV2['cliStatus'] & Partial<CliStatusRecorder>;
  const now = (): EpochMs => deps.clock.now();
  const statusOf = async (provider: CliProviderId): Promise<Result<CliStatus>> => ok(await status.get(provider));
  const isSeamExe = (exePath: string): boolean => path.win32.basename(exePath).toLowerCase() === 'node.exe';
  const signInFs = deps.signInFs ?? {
    mkdirSync: (p: string, o: { recursive: true }) => nodeFs.mkdirSync(p, o),
    writeFileSync: (p: string, t: string) => nodeFs.writeFileSync(p, t, { encoding: 'utf8', mode: 0o600 }),
  };

  /**
   * The smoke test of one provider (cli:test, and the ONE automatic re-test after a sign-in console closed). `resetBreaker` only for
   * the user's "Test again" click (B13): the automatic re-test never closes the breaker or the identity pause.
   */
  const runTest = async (
    provider: CliProviderId,
    opts: { resetBreaker: boolean },
  ): Promise<Result<{ ok: true; ms: number }>> => {
    if (!deps.cliLocator || !deps.cliRunner) return fail('INTERNAL');
    if (opts.resetBreaker) deps.cliRunner.resetBreaker?.(); // "Test again" is the user click that closes the CLI_UNSTABLE breaker (B13)
    const loc = await deps.cliLocator.find(provider);
    if (loc === null) return fail('CLI_NOT_INSTALLED');
    if (loc.version === null || compareVersion(loc.version, CLI_MIN_VERSION[provider]) < 0) return fail('CLI_VERSION');
    const started = now();
    let outcome: { ok: true; model: string } | { ok: false; reason: ProviderErrorCode };
    const signal = AbortSignal.timeout(SMOKE_TIMEOUT_MS);
    if (provider === 'claude_cli') {
      const p = createClaudeCliProvider({
        runner: deps.cliRunner,
        locator: deps.cliLocator,
        model: deps.settings.get().llm.cli.claudeModel,
        exePath: loc.exePath,
        observedVersion: loc.version,
        startToolServer: () => Promise.reject(new Error('no_tool_server_in_cli_test')),
        now,
      });
      outcome = await p.validate(signal);
    } else {
      if (!deps.makeAgyForTest) return fail('INTERNAL');
      outcome = await deps.makeAgyForTest(loc.exePath, loc.version).validate(signal);
    }
    const ms = now() - started;
    status.recordTest?.(provider, { ok: outcome.ok, at: now(), ms });
    status.invalidate();
    if (!outcome.ok) return fail(providerErrorToErrorCode(provider, outcome.reason));
    // A passed test clears a held provider (B12): the next get() re-proves the smoke before any user data.
    if (deps.settings.get().llm.provider === provider) await deps.providerFactory.invalidate();
    return ok({ ok: true as const, ms });
  };

  // ---------------- [D-080] the guided sign-in session (one per provider) ----------------
  /** Providers with a console open or a re-test running. Reserved synchronously, so a double click can never open two consoles. */
  const busy = new Set<CliProviderId>();
  const recordSession = (provider: CliProviderId, session: CliSignInSession | null): void => {
    status.recordSignIn?.(provider, session);
  };
  /** Pushes the (re-probed when the cache was dropped) status through cli:changed; never throws. */
  const push = async (provider: CliProviderId): Promise<void> => {
    if (!deps.emitCliChanged) return;
    try {
      deps.emitCliChanged(await status.get(provider));
    } catch {
      // a failing probe must never break the session; the Connect card still polls cli:getStatus
    }
  };
  /** The console closed: invalidate, re-probe, re-run the smoke ONCE, push every phase. */
  const afterConsole = async (provider: CliProviderId): Promise<void> => {
    try {
      if (deps.closed?.() === true) {
        recordSession(provider, null); // quitting: no CLI job after killJobs
        return;
      }
      status.invalidate();
      recordSession(provider, { phase: 'retesting', outcome: null });
      await push(provider); // re-probes (the cache was dropped above)
      let r: Result<{ ok: true; ms: number }>;
      try {
        r = await runTest(provider, { resetBreaker: false });
      } catch {
        r = fail('INTERNAL');
      }
      recordSession(provider, {
        phase: 'done',
        outcome: { ok: r.ok, code: r.ok ? null : r.error.code, at: now() },
      });
      status.invalidate();
      await push(provider);
    } finally {
      busy.delete(provider);
    }
  };
  /** tracked = a console whose end is awaited: the provider stays busy until afterConsole() finished. */
  const signIn = async (provider: CliProviderId): Promise<{ res: Result<{ opened: true }>; tracked: boolean }> => {
    const untracked = (res: Result<{ opened: true }>): { res: Result<{ opened: true }>; tracked: boolean } => ({
      res,
      tracked: false,
    });
    if (!deps.cliLocator) return untracked(fail('INTERNAL'));
    const loc = await deps.cliLocator.find(provider);
    if (loc === null) return untracked(fail('CLI_NOT_INSTALLED'));
    if (loc.version === null || compareVersion(loc.version, CLI_MIN_VERSION[provider]) < 0)
      return untracked(fail('CLI_VERSION'));
    // The SAME environment the runs use: claude = the run profile vars; agy = the isolated <userData>\agy-home profile with its
    // app-written settings.json (the same bytes every agy run writes) and cwd inside it - never the user's real profile (F3).
    let cwd: string | null = null;
    let agyHome: ReturnType<typeof planAgyHome>['env'] | null = null;
    if (provider === 'antigravity_cli') {
      if (deps.userDataDir === undefined || deps.userDataDir.length === 0) return untracked(fail('INTERNAL'));
      const plan = planAgyHome(deps.userDataDir, path.win32.join(deps.userDataDir, AGY_WORKSPACE_DIR));
      try {
        for (const f of plan.files) {
          signInFs.mkdirSync(path.win32.dirname(f.path), { recursive: true });
          signInFs.writeFileSync(f.path, f.text);
        }
      } catch {
        return untracked(fail('INTERNAL'));
      }
      cwd = plan.homeDir;
      agyHome = plan.env;
    }
    const cmd = buildSignInCommand(provider, loc.exePath, loc.exePath, cwd, isSeamExe(loc.exePath));
    if (cmd === null) return untracked(fail('BAD_REQUEST'));
    const env = buildSignInEnv(provider, deps.processEnv ?? process.env, agyHome);
    let handle: void | VisibleConsoleHandle;
    try {
      handle = await deps.cliConsole(cmd.exePath, cmd.args, {
        ...(cmd.cwd === undefined ? {} : { cwd: cmd.cwd }),
        env,
      });
    } catch {
      return untracked(fail('INTERNAL'));
    }
    if (handle === undefined || handle === null || typeof handle.exited?.then !== 'function') {
      // An untracked console (e2e recorder, older seam): no session - the Connect card polls cli:getStatus as before.
      status.invalidate();
      return untracked(ok({ opened: true as const }));
    }
    recordSession(provider, { phase: 'open', outcome: null });
    await push(provider);
    void handle.exited.then(
      () => afterConsole(provider),
      () => afterConsole(provider),
    );
    return { res: ok({ opened: true as const }), tracked: true };
  };

  return {
    'cli:getStatus': async ({ provider }) => statusOf(provider),

    'cli:signIn': async ({ provider }) => {
      // One session per provider: a second click while its console is open (or its re-test runs) opens nothing; it re-pushes the state.
      if (busy.has(provider)) {
        await push(provider);
        return ok({ opened: true as const, alreadyOpen: true as const });
      }
      busy.add(provider); // reserved before the first await: a concurrent second click sees it
      let tracked = false;
      try {
        const r = await signIn(provider);
        tracked = r.tracked;
        return r.res;
      } finally {
        // a tracked console keeps the provider busy until afterConsole() ends; every other outcome frees it now
        if (!tracked) busy.delete(provider);
      }
    },

    'cli:setOverage': async ({ allow }, ctx) => {
      if (!focused(ctx)) return fail('WINDOW_NOT_FOCUSED');
      if (allow) {
        // [F11] turning overage ON needs the main-owned native confirmation; a cancel changes nothing.
        if (!deps.autoDialog || !deps.window) return fail('INTERNAL');
        const confirmed = await deps.autoDialog.confirmSetting(deps.window(), 'overage', 'Claude');
        if (!confirmed) return statusOf('claude_cli');
      }
      deps.settings.setInternal((s) => {
        s.llm.cli.allowOverage = allow;
      });
      return statusOf('claude_cli');
    },

    'cli:test': async ({ provider }) => runTest(provider, { resetBreaker: true }),

    'cli:pickExe': async (_req, ctx) => {
      if (!focused(ctx)) return fail('WINDOW_NOT_FOCUSED');
      if (!deps.pickExePath || !deps.cliLocator) return fail('INTERNAL');
      const chosen = await deps.pickExePath({
        title: 'claude.exe',
        filters: [{ name: 'claude.exe', extensions: ['exe'] }],
      });
      if (chosen === null) return statusOf('claude_cli'); // cancelled => unchanged
      // Regex + floor (concern #5, F7): the ONLY writer of llm.cli.claudeExePath. Hostile paths never reach the settings or a spawn.
      if (
        chosen.length === 0 ||
        !ClaudeExePathSchema.safeParse(chosen).success ||
        !isSafeConsoleExe(chosen, ['claude.exe'])
      )
        return fail('BAD_REQUEST');
      const version = await deps.cliLocator.version(chosen, AbortSignal.timeout(20_000)).catch(() => null);
      if (version === null || compareVersion(version, CLI_MIN_VERSION.claude_cli) < 0) return fail('CLI_VERSION');
      deps.settings.setInternal((s) => {
        s.llm.cli.claudeExePath = chosen;
      });
      status.invalidate();
      if (deps.settings.get().llm.provider === 'claude_cli') await deps.providerFactory.invalidate();
      return statusOf('claude_cli');
    },

    'cli:previewWorkspaceChange': async () => {
      const preview = await deps.agyWorkspace.preview();
      if ('error' in preview) return fail('BAD_REQUEST');
      return ok({
        diffLine: preview.diffLine,
        settingsFileExists: deps.agySettingsExists?.() ?? false,
        agyRunning: (await deps.agyRunning?.().catch(() => true)) ?? false,
      });
    },

    'cli:allowWorkspace': async (_req, ctx) => {
      if (!focused(ctx)) return fail('WINDOW_NOT_FOCUSED');
      if (!deps.autoDialog || !deps.window || !deps.agyRunning) return fail('INTERNAL');
      // UX2 7.4 "Close Antigravity first": refused while an agy process runs (S-PROC), BEFORE any native dialog; a probe that cannot
      // tell counts as running (fail closed). allow() re-checks it, so nothing is written either way.
      if (await deps.agyRunning().catch(() => true)) return fail('BAD_REQUEST');
      const preview = await deps.agyWorkspace.preview();
      if ('error' in preview) return fail('BAD_REQUEST');
      // The native dialog shows EXACTLY the app-built diff line that allow() then writes (one key: trustedWorkspaces).
      const confirmed = await deps.autoDialog.confirmWorkspaceTrust(deps.window(), preview.diffLine);
      if (!confirmed) return statusOf('antigravity_cli');
      const r = await deps.agyWorkspace.allow(true);
      if (!r.ok) return fail(r.error.code as ErrorCode);
      status.recordWorkspaceTrusted?.(true);
      status.invalidate();
      return statusOf('antigravity_cli');
    },
  };
}
