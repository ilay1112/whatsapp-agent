// src/main/ipc/handlers/cli.ts   ADD (C2 8 vendor-CLI channels; v2-build-plan 3 createCliHandlers) - owner V2-W1-06-claude-cli.
// cli:signIn spawns the validated exe itself in a VISIBLE console through S-CONSOLE - never cmd.exe (F7).
// Focus gating of cli:setOverage / cli:pickExe / cli:allowWorkspace is register.ts's (FOCUS_GATED_CHANNELS); these bodies re-check it
// (defence in depth) and never change a setting on a cancelled native dialog. No channel accepts a path, a token or CLI text (ARCH2 10).
import cp from 'node:child_process';
import path from 'node:path';
import type { IpcContext, IpcHandlers } from '../../../shared/ipc';
import { CLI_MIN_VERSION, type CliProviderId, type CliStatus, type EpochMs, type Result } from '../../../shared/types';
import { providerErrorToErrorCode, type ErrorCode } from '../../../shared/errors';
import { ClaudeExePathSchema } from '../../../shared/settings';
import type { OpenVisibleConsoleFn, SpawnFn } from '../../deps';
import { fail, ok, type HandlerDepsV2 } from '../register';
import { compareVersion, type CliLocator, type CliStatusRecorder } from '../../llm/cli/locator';
import type { CliRunner } from '../../llm/cli/runner';
import { createClaudeCliProvider } from '../../llm/cli/claudeCli';
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
  /** S-HOME: %USERPROFILE% (cwd of the agy sign-in console). */
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

/** The sign-in console command (pure): claude = `<exe> auth login --claudeai`; agy = `<exe>` with no args, cwd %USERPROFILE%.
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
  return async (exePath, args, opts) => {
    if (/(^|\\|\/)cmd(\.exe)?$/i.test(exePath)) throw new Error('console_via_cmd_refused');
    const child = spawnFn(exePath, [...args], {
      shell: false,
      detached: true,
      windowsHide: false,
      stdio: 'ignore',
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    });
    child.once('error', () => undefined);
    child.unref();
  };
}

const focused = (ctx: IpcContext): boolean => ctx.windowFocused && ctx.windowVisible;
const SMOKE_TIMEOUT_MS = 45_000;

export function createCliHandlers(deps: HandlerDepsV2 & Partial<CliHandlerExtras>): Pick<IpcHandlers, CliChannels> {
  const status = deps.cliStatus as HandlerDepsV2['cliStatus'] & Partial<CliStatusRecorder>;
  const now = (): EpochMs => deps.clock.now();
  const statusOf = async (provider: CliProviderId): Promise<Result<CliStatus>> => ok(await status.get(provider));
  const isSeamExe = (exePath: string): boolean => path.win32.basename(exePath).toLowerCase() === 'node.exe';

  return {
    'cli:getStatus': async ({ provider }) => statusOf(provider),

    'cli:signIn': async ({ provider }) => {
      if (!deps.cliLocator) return fail('INTERNAL');
      const loc = await deps.cliLocator.find(provider);
      if (loc === null) return fail('CLI_NOT_INSTALLED');
      if (loc.version === null || compareVersion(loc.version, CLI_MIN_VERSION[provider]) < 0)
        return fail('CLI_VERSION');
      const home = deps.homeDir?.() ?? null;
      const cmd = buildSignInCommand(provider, loc.exePath, loc.exePath, home, isSeamExe(loc.exePath));
      if (cmd === null) return fail('BAD_REQUEST');
      await deps.cliConsole(cmd.exePath, cmd.args, cmd.cwd === undefined ? {} : { cwd: cmd.cwd });
      status.invalidate(); // the Connect card polls cli:getStatus until it reads "signed in"
      return ok({ opened: true as const });
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

    'cli:test': async ({ provider }) => {
      if (!deps.cliLocator || !deps.cliRunner) return fail('INTERNAL');
      deps.cliRunner.resetBreaker?.(); // "Test again" is the user click that closes the CLI_UNSTABLE breaker (B13)
      const loc = await deps.cliLocator.find(provider);
      if (loc === null) return fail('CLI_NOT_INSTALLED');
      if (loc.version === null || compareVersion(loc.version, CLI_MIN_VERSION[provider]) < 0)
        return fail('CLI_VERSION');
      const started = now();
      let outcome:
        { ok: true; model: string } | { ok: false; reason: import('../../../shared/errors').ProviderErrorCode };
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
    },

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
