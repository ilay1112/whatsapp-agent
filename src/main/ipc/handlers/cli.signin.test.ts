// src/main/ipc/handlers/cli.signin.test.ts - [D-080] the guided sign-in session of cli:signIn (user request).
// The vendor CLI's OWN login opens in a VISIBLE console in the SAME environment the app's runs use (Claude: the run profile vars;
// Antigravity: the isolated <userData>\agy-home profile, cwd inside it), launched through S-CONSOLE (never cmd.exe, F7). When the console
// exits: the status cache is invalidated, the status re-probed and the provider's smoke test re-run ONCE; the session state
// ('open' -> 'retesting' -> 'done' + outcome) is pushed through cli:changed. One session per provider; a second click while one is open
// opens nothing. Nothing about credentials is ever read: the handler never reads a file of the profile, it only writes the app-owned
// isolated settings.json (the same bytes every agy run writes).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IpcContext } from '../../../shared/ipc';
import { DEFAULT_SETTINGS, type Settings } from '../../../shared/settings';
import type { CliSignInSession, CliStatus } from '../../../shared/types';
import type { HandlerDepsV2 } from '../register';
import type { CliLocation, CliLocator } from '../../llm/cli/locator';
import type { CliRunResult } from '../../llm/cli/runner';
import { planAgyHome } from '../../llm/cli/claudeCli.env';
import { buildSignInEnv, createCliHandlers, type CliHandlerExtras } from './cli';

const CTX: IpcContext = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };
const CLAUDE = 'C:\\Users\\wca-fake-home\\.local\\bin\\claude.exe';
const AGY = 'C:\\Users\\wca-fake-home\\AppData\\Local\\agy\\bin\\agy.exe';
const PROCESS_ENV = {
  SystemRoot: 'C:\\Windows',
  windir: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  PATHEXT: '.COM;.EXE',
  USERPROFILE: 'C:\\Users\\wca-fake-home',
  HOMEDRIVE: 'C:',
  HOMEPATH: '\\Users\\wca-fake-home',
  APPDATA: 'C:\\Users\\wca-fake-home\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\wca-fake-home\\AppData\\Local',
  TEMP: 'C:\\Users\\wca-fake-home\\AppData\\Local\\Temp',
  TMP: 'C:\\Users\\wca-fake-home\\AppData\\Local\\Temp',
  USERNAME: 'wca-fake',
  PATH: 'C:\\evil\\bin;C:\\Windows\\System32',
  // a poisoned parent env: none of these may reach a sign-in console (the runs never see them either)
  ANTHROPIC_API_KEY: 'sk-ant-TESTONLY-planted',
  CLAUDE_CONFIG_DIR: 'C:\\evil\\claude',
  CLAUDE_CODE_OAUTH_TOKEN: 'TESTONLY-oauth',
  GEMINI_API_KEY: 'AIzaTESTONLY',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  NODE_OPTIONS: '--require evil',
  CI: '1',
};

const okRun = (structured: unknown): CliRunResult => ({
  sandbox: { initOk: true, toolsCount: 1, mcpServers: 0, apiKeySource: 'none', mismatch: null },
  structured,
  text: null,
  toolCalls: 0,
  blockedCalls: 0,
  stopReason: 'end',
  error: null,
  quota: null,
  usage: null,
  ms: 3,
});
const notSignedInRun: CliRunResult = { ...okRun(null), error: 'not_logged_in', stopReason: 'bad_output' };

let userData: string;
beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-signin-'));
});
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

/** A console whose window the test "closes" with close(). */
function controllableConsole() {
  const opened: Array<{ exe: string; args: readonly string[]; opts: { cwd?: string; env?: Record<string, string> } }> =
    [];
  const closers: Array<() => void> = [];
  const fn = vi.fn(
    async (exe: string, args: readonly string[], opts: { cwd?: string; env?: Record<string, string> }) => {
      opened.push({ exe, args, opts });
      return { exited: new Promise<void>((resolve) => closers.push(resolve)) };
    },
  );
  return { fn, opened, close: (i = closers.length - 1) => closers[i]?.() };
}

function setup(opts: { provider?: 'claude_cli' | 'antigravity_cli'; extras?: Partial<CliHandlerExtras> } = {}) {
  const provider = opts.provider ?? 'claude_cli';
  const settings = structuredClone(DEFAULT_SETTINGS) as Settings;
  settings.llm.provider = provider;
  const loc: CliLocation =
    provider === 'claude_cli'
      ? { provider, exePath: CLAUDE, version: '2.1.258' }
      : { provider, exePath: AGY, version: '1.2.16' };
  const locator: CliLocator = {
    find: vi.fn(async () => loc),
    version: vi.fn(async () => loc.version),
    signedIn: vi.fn(),
  };
  const sessions: Array<CliSignInSession | null> = [];
  let current: CliSignInSession | null = null;
  const status = (p: CliStatus['provider']): CliStatus => ({
    provider: p,
    state: 'ready',
    version: loc.version,
    minVersion: '2.1.248',
    quota: null,
    lastTest: null,
    workspaceTrusted: null,
    ...(current === null ? {} : { signIn: current }),
  });
  const cliStatus = {
    get: vi.fn(async (p: CliStatus['provider']) => status(p)),
    peek: vi.fn((p: CliStatus['provider']) => status(p)),
    invalidate: vi.fn(),
    recordTest: vi.fn(),
    recordWorkspaceTrusted: vi.fn(),
    recordSignIn: vi.fn((_p: CliStatus['provider'], s: CliSignInSession | null) => {
      current = s;
      sessions.push(s);
    }),
  };
  const con = controllableConsole();
  const runner = {
    run: vi.fn(async (_req: unknown) => okRun({ ok: true })),
    breakerOpen: () => false,
    resetBreaker: vi.fn(),
  };
  const pushed: CliStatus[] = [];
  const agyValidate = vi.fn(async () => ({ ok: true as const, model: 'm' }));
  let t = 1_000;
  const deps = {
    cliStatus,
    cliConsole: con.fn,
    agyWorkspace: { preview: vi.fn(), allow: vi.fn() },
    settings: { get: () => settings, patch: vi.fn(), setInternal: vi.fn(), onChange: vi.fn() },
    clock: { now: () => (t += 100), setTimeout: vi.fn(), clearTimeout: vi.fn() },
    providerFactory: { get: vi.fn(), usable: vi.fn(), invalidate: vi.fn(async () => undefined) },
    audit: vi.fn(),
    cliLocator: locator,
    cliRunner: runner,
    autoDialog: { confirmSetting: vi.fn(), confirmWorkspaceTrust: vi.fn() },
    window: () => 'WIN',
    homeDir: () => 'C:\\Users\\wca-fake-home',
    agyRunning: vi.fn(async () => false),
    agySettingsExists: () => false,
    makeAgyForTest: vi.fn(() => ({ validate: agyValidate })),
    userDataDir: userData,
    processEnv: PROCESS_ENV,
    emitCliChanged: (s: CliStatus) => pushed.push(s),
    ...opts.extras,
  } as unknown as HandlerDepsV2 & Partial<CliHandlerExtras>;
  return { h: createCliHandlers(deps), deps, con, cliStatus, sessions, pushed, runner, agyValidate, locator };
}
/** Lets every pending promise callback run (the console-exit chain is a few awaits deep). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
};
const phases = (s: Array<CliSignInSession | null>): string[] => s.map((x) => (x === null ? 'idle' : x.phase));

describe('buildSignInEnv (pure): the run profile vars + the Windows basics a login needs; never a key, token or redirect', () => {
  it('claude: the profile vars exactly as the runs copy them; no ANTHROPIC_* / CLAUDE_CONFIG_DIR / proxy / CI', () => {
    const env = buildSignInEnv('claude_cli', PROCESS_ENV, null);
    expect(env).toMatchObject({
      USERPROFILE: PROCESS_ENV.USERPROFILE,
      HOMEDRIVE: 'C:',
      HOMEPATH: PROCESS_ENV.HOMEPATH,
      APPDATA: PROCESS_ENV.APPDATA,
      LOCALAPPDATA: PROCESS_ENV.LOCALAPPDATA,
      SystemRoot: 'C:\\Windows',
      DISABLE_AUTOUPDATER: '1',
    });
    expect(env.PATH).toBe(
      'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
    );
    for (const k of [
      'ANTHROPIC_API_KEY',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'GEMINI_API_KEY',
      'HTTPS_PROXY',
      'NODE_OPTIONS',
      'CI',
    ])
      expect(Object.keys(env).map((x) => x.toUpperCase())).not.toContain(k);
    expect(JSON.stringify(env)).not.toMatch(/TESTONLY|evil/);
  });
  it('agy: the ISOLATED profile vars of planAgyHome (where the runs look) + auto-update off', () => {
    const plan = planAgyHome(userData, path.win32.join(userData, 'agy-workspace'));
    const env = buildSignInEnv('antigravity_cli', PROCESS_ENV, plan.env);
    expect(env).toMatchObject({ ...plan.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' });
    expect(env.USERPROFILE).not.toBe(PROCESS_ENV.USERPROFILE);
    expect(JSON.stringify(env)).not.toMatch(/TESTONLY|evil/);
    expect(() => buildSignInEnv('antigravity_cli', PROCESS_ENV, null)).toThrow('agy_signin_needs_isolated_profile');
  });
});

describe('[D-080] cli:signIn - a tracked console session', () => {
  it('claude: the validated exe + auth login --claudeai in the run environment; open -> (exit) -> retesting -> done(ok)', async () => {
    const s = setup();
    expect(await s.h['cli:signIn']({ provider: 'claude_cli' }, CTX)).toEqual({ ok: true, value: { opened: true } });
    expect(s.con.opened).toHaveLength(1);
    expect(s.con.opened[0]).toEqual({
      exe: CLAUDE,
      args: ['auth', 'login', '--claudeai'],
      opts: { env: buildSignInEnv('claude_cli', PROCESS_ENV, null) },
    });
    expect(phases(s.sessions)).toEqual(['open']);
    expect(s.pushed.at(-1)?.signIn).toEqual({ phase: 'open', outcome: null });
    expect(s.runner.run).not.toHaveBeenCalled(); // no re-test while the console is open
    s.con.close();
    await settle();
    expect(phases(s.sessions)).toEqual(['open', 'retesting', 'done']);
    expect(s.cliStatus.invalidate).toHaveBeenCalled();
    // the re-test ran ONCE: one smoke run of the constant prompt
    expect(s.runner.run).toHaveBeenCalledTimes(1);
    expect(s.runner.run.mock.calls[0]?.[0]).toMatchObject({ provider: 'claude_cli', stage: 'smoke' });
    expect(s.runner.resetBreaker).not.toHaveBeenCalled(); // the automatic re-test never closes the breaker (only "Test again")
    expect(s.cliStatus.recordTest).toHaveBeenCalledWith('claude_cli', expect.objectContaining({ ok: true }));
    const done = s.sessions.at(-1);
    expect(done).toMatchObject({ phase: 'done', outcome: { ok: true, code: null } });
    expect(s.pushed.map((x) => x.signIn?.phase)).toEqual(['open', 'retesting', 'done']);
    // the passed test re-arms the active provider exactly like cli:test
    expect(s.deps.providerFactory.invalidate).toHaveBeenCalledTimes(1);
  });

  it('the re-test failing (still not signed in) ends the session done with CLI_NOT_SIGNED_IN', async () => {
    const s = setup();
    s.runner.run.mockResolvedValueOnce(notSignedInRun);
    await s.h['cli:signIn']({ provider: 'claude_cli' }, CTX);
    s.con.close();
    await settle();
    expect(s.sessions.at(-1)).toMatchObject({ phase: 'done', outcome: { ok: false, code: 'CLI_NOT_SIGNED_IN' } });
    expect(s.deps.providerFactory.invalidate).not.toHaveBeenCalled();
  });

  it('one session per provider: a second click while open (or re-testing) opens nothing and pushes the current state', async () => {
    const s = setup();
    await s.h['cli:signIn']({ provider: 'claude_cli' }, CTX);
    const pushedBefore = s.pushed.length;
    expect(await s.h['cli:signIn']({ provider: 'claude_cli' }, CTX)).toEqual({
      ok: true,
      value: { opened: true, alreadyOpen: true },
    });
    expect(s.con.fn).toHaveBeenCalledTimes(1);
    expect(s.pushed.length).toBe(pushedBefore + 1);
    // concurrent double click before the first console even opened: still ONE console
    const t = setup();
    const [a, b] = await Promise.all([
      t.h['cli:signIn']({ provider: 'claude_cli' }, CTX),
      t.h['cli:signIn']({ provider: 'claude_cli' }, CTX),
    ]);
    expect(t.con.fn).toHaveBeenCalledTimes(1);
    expect([a, b].filter((r) => r.ok && 'alreadyOpen' in r.value)).toHaveLength(1);
    // after the session ended a new click opens a new console
    s.con.close();
    await settle();
    await s.h['cli:signIn']({ provider: 'claude_cli' }, CTX);
    expect(s.con.fn).toHaveBeenCalledTimes(2);
  });

  it('agy: the validated exe with no args, cwd INSIDE <userData>\\agy-home, the isolated profile env; settings.json written first', async () => {
    const s = setup({ provider: 'antigravity_cli' });
    await s.h['cli:signIn']({ provider: 'antigravity_cli' }, CTX);
    const plan = planAgyHome(userData, path.win32.join(userData, 'agy-workspace'));
    expect(s.con.opened[0]).toEqual({
      exe: AGY,
      args: [],
      opts: { cwd: plan.homeDir, env: buildSignInEnv('antigravity_cli', PROCESS_ENV, plan.env) },
    });
    expect(s.con.opened[0]?.opts.cwd).not.toBe('C:\\Users\\wca-fake-home'); // never the real profile any more
    const settingsFile = plan.files[0]!;
    expect(fs.readFileSync(settingsFile.path, 'utf8')).toBe(settingsFile.text);
    s.con.close();
    await settle();
    expect(s.agyValidate).toHaveBeenCalledTimes(1);
    expect(s.sessions.at(-1)).toMatchObject({ phase: 'done', outcome: { ok: true, code: null } });
  });

  it('agy without the isolated profile (no userDataDir) => INTERNAL, no console (never the real profile)', async () => {
    const s = setup({ provider: 'antigravity_cli', extras: { userDataDir: undefined } });
    expect(await s.h['cli:signIn']({ provider: 'antigravity_cli' }, CTX)).toEqual({
      ok: false,
      error: { code: 'INTERNAL' },
    });
    expect(s.con.fn).not.toHaveBeenCalled();
    // and the provider is not left "busy": a later click with a profile works
    expect(s.sessions).toEqual([]);
  });

  it('a console that fails to open => INTERNAL, no session left behind; the next click may try again', async () => {
    const s = setup();
    s.con.fn.mockRejectedValueOnce(new Error('spawn EACCES'));
    expect(await s.h['cli:signIn']({ provider: 'claude_cli' }, CTX)).toEqual({
      ok: false,
      error: { code: 'INTERNAL' },
    });
    expect(await s.h['cli:signIn']({ provider: 'claude_cli' }, CTX)).toEqual({ ok: true, value: { opened: true } });
    expect(s.con.fn).toHaveBeenCalledTimes(2);
  });

  it('an untracked console (S-CONSOLE without an exit handle, the e2e recorder) keeps the legacy behaviour: invalidate, no session', async () => {
    const s = setup();
    s.con.fn.mockResolvedValueOnce(undefined as never);
    expect(await s.h['cli:signIn']({ provider: 'claude_cli' }, CTX)).toEqual({ ok: true, value: { opened: true } });
    expect(s.cliStatus.invalidate).toHaveBeenCalled();
    expect(s.sessions.filter((x) => x !== null)).toEqual([]);
    expect(await s.h['cli:signIn']({ provider: 'claude_cli' }, CTX)).toEqual({ ok: true, value: { opened: true } });
  });

  it('once the quit began the console exit re-tests nothing (no CLI job after killJobs)', async () => {
    let closing = false;
    const s = setup({ extras: { closed: () => closing } });
    await s.h['cli:signIn']({ provider: 'claude_cli' }, CTX);
    closing = true;
    s.con.close();
    await settle();
    expect(s.runner.run).not.toHaveBeenCalled();
    expect(s.sessions.at(-1)).toBeNull();
  });
});
