// src/main/ipc/handlers/cli.test.ts - T2 5 row `ipc/handlers/cli.ts` (owner V2-W1-06-claude-cli).
// cli:signIn opens the validated exe DIRECTLY via S-CONSOLE (argv [exe,'auth','login','--claudeai'], shell:false, detached, visible;
// never cmd.exe, F7); hostile paths never open a console and never reach settings; cli:setOverage / cli:pickExe / cli:allowWorkspace
// change nothing on a cancelled native dialog (F11); cli:getStatus is the cached service.
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { IpcContext } from '../../../shared/ipc';
import { DEFAULT_SETTINGS, type Settings } from '../../../shared/settings';
import type { CliStatus } from '../../../shared/types';
import type { HandlerDepsV2 } from '../register';
import type { CliLocation, CliLocator } from '../../llm/cli/locator';
import type { CliRunResult } from '../../llm/cli/runner';
import {
  buildSignInCommand,
  createCliHandlers,
  createOpenVisibleConsole,
  isSafeConsoleExe,
  type CliHandlerExtras,
} from './cli';

const FOCUSED: IpcContext = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };
const UNFOCUSED: IpcContext = { windowFocused: false, windowVisible: true, shownByNotificationAt: null };
const CLAUDE = 'C:\\Users\\wca-fake-home\\.local\\bin\\claude.exe';
const AGY = 'C:\\Users\\wca-fake-home\\AppData\\Local\\agy\\bin\\agy.exe';

const statusFor = (provider: CliStatus['provider'], state: CliStatus['state'] = 'ready'): CliStatus => ({
  provider,
  state,
  version: '2.1.258',
  minVersion: '2.1.248',
  quota: null,
  lastTest: null,
  workspaceTrusted: null,
});
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

function setup(
  opts: { loc?: CliLocation | null; extras?: Partial<CliHandlerExtras>; provider?: Settings['llm']['provider'] } = {},
) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.llm.provider = opts.provider ?? 'claude_cli';
  const loc =
    opts.loc === undefined ? { provider: 'claude_cli' as const, exePath: CLAUDE, version: '2.1.258' } : opts.loc;
  const locator: CliLocator = {
    find: vi.fn(async (p) => (loc === null ? null : { ...loc, provider: p })),
    version: vi.fn(async () => '2.1.258'),
    signedIn: vi.fn(),
  };
  const cliStatus = {
    get: vi.fn(async (p: CliStatus['provider']) => statusFor(p)),
    invalidate: vi.fn(),
    recordTest: vi.fn(),
    recordWorkspaceTrusted: vi.fn(),
  };
  const cliConsole = vi.fn(async () => undefined);
  const runner = { run: vi.fn(async () => okRun({ ok: true })), breakerOpen: () => false, resetBreaker: vi.fn() };
  const autoDialog = { confirmSetting: vi.fn(async () => true), confirmWorkspaceTrust: vi.fn(async () => true) };
  const agyWorkspace = {
    preview: vi.fn(async (): Promise<{ diffLine: string } | { error: string }> => ({
      diffLine: 'trustedWorkspaces: + <workspace>',
    })),
    allow: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };
  const setInternal = vi.fn((mut: (s: Settings) => void) => {
    mut(settings);
    return settings;
  });
  let t = 1_000;
  const deps = {
    cliStatus,
    cliConsole,
    agyWorkspace,
    settings: { get: () => settings, patch: vi.fn(), setInternal, onChange: vi.fn() },
    clock: { now: () => (t += 100), setTimeout: vi.fn(), clearTimeout: vi.fn() },
    providerFactory: { get: vi.fn(), usable: vi.fn(), invalidate: vi.fn(async () => undefined) },
    audit: vi.fn(),
    cliLocator: locator,
    cliRunner: runner,
    autoDialog,
    window: () => 'WIN',
    pickExePath: vi.fn(async () => 'C:\\Tools\\claude.exe'),
    homeDir: () => 'C:\\Users\\wca-fake-home',
    agyRunning: vi.fn(async () => false),
    agySettingsExists: () => true,
    makeAgyForTest: vi.fn(() => ({ validate: vi.fn(async () => ({ ok: true as const, model: 'm' })) })),
    ...opts.extras,
  } as unknown as HandlerDepsV2 & Partial<CliHandlerExtras>;
  return {
    h: createCliHandlers(deps),
    deps,
    settings,
    locator,
    cliStatus,
    cliConsole,
    runner,
    autoDialog,
    agyWorkspace,
    setInternal,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
const HOSTILE = [
  'C:\\x" & calc & "\\claude.exe',
  'C:\\R&D\\claude.exe',
  'C:\\x&calc&\\claude.exe',
  '\\\\server\\share\\claude.exe',
  'C:\\a\\..\\claude.exe',
  'C:\\x\\claude.exe.cmd',
  'C:\\x%PATH%\\claude.exe',
  'C:\\x^y\\claude.exe',
  'C:\\Program Files (x86)\\claude.exe',
  'C:\\x!\\claude.exe',
  'C:\\x@y\\claude.exe',
  'C:\\x|y\\claude.exe',
  'C:\\x<y\\claude.exe',
  'C:\\x>y\\claude.exe',
  'claude.exe',
  ' C:\\x\\claude.exe',
  'C:\\x\\claude.cmd',
];

describe('isSafeConsoleExe / buildSignInCommand (pure)', () => {
  it.each(HOSTILE)('refuses %s', (p) => {
    expect(isSafeConsoleExe(p, ['claude.exe'])).toBe(false);
    expect(buildSignInCommand('claude_cli', p, p, null, false)).toBeNull();
  });
  it('builds the literal commands; refuses a value not equal to the validated path', () => {
    expect(buildSignInCommand('claude_cli', CLAUDE, CLAUDE, 'C:\\home', false)).toEqual({
      exePath: CLAUDE,
      args: ['auth', 'login', '--claudeai'],
    });
    expect(buildSignInCommand('antigravity_cli', AGY, AGY, 'C:\\Users\\wca-fake-home', false)).toEqual({
      exePath: AGY,
      args: [],
      cwd: 'C:\\Users\\wca-fake-home',
    });
    expect(buildSignInCommand('antigravity_cli', AGY, AGY, null, false)).toEqual({ exePath: AGY, args: [] });
    expect(buildSignInCommand('antigravity_cli', AGY, AGY, '', false)).toEqual({ exePath: AGY, args: [] });
    expect(buildSignInCommand('claude_cli', CLAUDE, 'C:\\other\\claude.exe', null, false)).toBeNull();
    expect(buildSignInCommand('claude_cli', AGY, AGY, null, false)).toBeNull(); // wrong basename for the provider
    expect(buildSignInCommand('claude_cli', 'C:\\nodejs\\node.exe', 'C:\\nodejs\\node.exe', null, true)).not.toBeNull(); // e2e seam
    expect(isSafeConsoleExe('C:\\' + 'a'.repeat(300) + '\\claude.exe', ['claude.exe'])).toBe(false);
    expect(isSafeConsoleExe(5 as unknown as string, ['claude.exe'])).toBe(false);
  });
});

describe('createOpenVisibleConsole (production S-CONSOLE)', () => {
  it('spawns the exe itself: shell:false, detached, visible console, never cmd.exe', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const spawn = vi.fn(() => child as unknown as ChildProcess);
    const open = createOpenVisibleConsole({ spawn });
    await open(CLAUDE, ['auth', 'login', '--claudeai'], {});
    expect(spawn).toHaveBeenCalledWith(CLAUDE, ['auth', 'login', '--claudeai'], {
      shell: false,
      detached: true,
      windowsHide: false,
      stdio: 'ignore',
    });
    expect(child.unref).toHaveBeenCalled();
    child.emit('error', new Error('late')); // swallowed
    await open(AGY, [], { cwd: 'C:\\Users\\wca-fake-home' });
    expect(spawn).toHaveBeenLastCalledWith(
      AGY,
      [],
      expect.objectContaining({ cwd: 'C:\\Users\\wca-fake-home', shell: false }),
    );
    await expect(open('C:\\Windows\\System32\\cmd.exe', ['/k', 'claude'], {})).rejects.toThrow(
      'console_via_cmd_refused',
    );
    await expect(open('cmd', [], {})).rejects.toThrow('console_via_cmd_refused');
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(typeof createOpenVisibleConsole()).toBe('function');
  });
});

describe('cli:getStatus', () => {
  it('answers from the cached status service', async () => {
    const s = setup();
    expect(await s.h['cli:getStatus']({ provider: 'claude_cli' }, FOCUSED)).toEqual({
      ok: true,
      value: statusFor('claude_cli'),
    });
    expect(s.cliStatus.get).toHaveBeenCalledWith('claude_cli');
  });
});

describe('cli:signIn', () => {
  it('claude: opens [exe, auth, login, --claudeai] via S-CONSOLE; invalidates the status cache', async () => {
    const s = setup();
    expect(await s.h['cli:signIn']({ provider: 'claude_cli' }, UNFOCUSED)).toEqual({
      ok: true,
      value: { opened: true },
    });
    expect(s.cliConsole).toHaveBeenCalledWith(CLAUDE, ['auth', 'login', '--claudeai'], {});
    expect(s.cliStatus.invalidate).toHaveBeenCalled();
  });
  it('agy: the exe with no args, cwd %USERPROFILE%', async () => {
    const s = setup({ loc: { provider: 'antigravity_cli', exePath: AGY, version: '1.2.11' } });
    await s.h['cli:signIn']({ provider: 'antigravity_cli' }, FOCUSED);
    expect(s.cliConsole).toHaveBeenCalledWith(AGY, [], { cwd: 'C:\\Users\\wca-fake-home' });
    const noHome = setup({
      loc: { provider: 'antigravity_cli', exePath: AGY, version: '1.2.11' },
      extras: { homeDir: undefined },
    });
    await noHome.h['cli:signIn']({ provider: 'antigravity_cli' }, FOCUSED);
    expect(noHome.cliConsole).toHaveBeenCalledWith(AGY, [], {});
  });
  it('not installed / too old / unreadable version / hostile located path => refused, console never opened', async () => {
    for (const [loc, code] of [
      [null, 'CLI_NOT_INSTALLED'],
      [{ provider: 'claude_cli', exePath: CLAUDE, version: '2.1.247' }, 'CLI_VERSION'],
      [{ provider: 'claude_cli', exePath: CLAUDE, version: null }, 'CLI_VERSION'],
      [{ provider: 'claude_cli', exePath: 'C:\\R&D\\claude.exe', version: '2.1.258' }, 'BAD_REQUEST'],
    ] as const) {
      const s = setup({ loc });
      expect(await s.h['cli:signIn']({ provider: 'claude_cli' }, FOCUSED)).toEqual({ ok: false, error: { code } });
      expect(s.cliConsole).not.toHaveBeenCalled();
    }
    const none = setup({ extras: { cliLocator: undefined } });
    expect(await none.h['cli:signIn']({ provider: 'claude_cli' }, FOCUSED)).toEqual({
      ok: false,
      error: { code: 'INTERNAL' },
    });
  });
});

describe('cli:setOverage (F11)', () => {
  it('unfocused => WINDOW_NOT_FOCUSED, nothing changes', async () => {
    const s = setup();
    expect(await s.h['cli:setOverage']({ allow: true }, UNFOCUSED)).toEqual({
      ok: false,
      error: { code: 'WINDOW_NOT_FOCUSED' },
    });
    expect(s.setInternal).not.toHaveBeenCalled();
  });
  it('allow:true shows the native confirmation; cancel changes nothing; confirm sets it', async () => {
    const s = setup();
    s.autoDialog.confirmSetting.mockResolvedValueOnce(false);
    expect(await s.h['cli:setOverage']({ allow: true }, FOCUSED)).toMatchObject({ ok: true });
    expect(s.setInternal).not.toHaveBeenCalled();
    expect(s.settings.llm.cli.allowOverage).toBe(false);
    expect(s.autoDialog.confirmSetting).toHaveBeenCalledWith('WIN', 'overage', 'Claude');
    await s.h['cli:setOverage']({ allow: true }, FOCUSED);
    expect(s.settings.llm.cli.allowOverage).toBe(true);
  });
  it('allow:false needs no dialog (one click)', async () => {
    const s = setup();
    s.settings.llm.cli.allowOverage = true;
    await s.h['cli:setOverage']({ allow: false }, FOCUSED);
    expect(s.autoDialog.confirmSetting).not.toHaveBeenCalled();
    expect(s.settings.llm.cli.allowOverage).toBe(false);
  });
  it('without the dialog collaborator the ON direction fails closed', async () => {
    const s = setup({ extras: { autoDialog: undefined } });
    expect(await s.h['cli:setOverage']({ allow: true }, FOCUSED)).toEqual({ ok: false, error: { code: 'INTERNAL' } });
    expect(s.setInternal).not.toHaveBeenCalled();
  });
});

describe('cli:test', () => {
  it('claude: resets the breaker, runs the constant smoke, records the outcome, re-arms the current provider', async () => {
    const s = setup();
    const r = await s.h['cli:test']({ provider: 'claude_cli' }, FOCUSED);
    expect(r).toEqual({ ok: true, value: { ok: true, ms: expect.any(Number) } });
    expect(s.runner.resetBreaker).toHaveBeenCalled();
    const req = (
      s.runner.run.mock.calls as unknown as Array<[{ stage: string; model: string; exePath: string }]>
    )[0]![0];
    expect(req).toMatchObject({ stage: 'smoke', model: 'haiku', exePath: CLAUDE });
    expect(s.cliStatus.recordTest).toHaveBeenCalledWith('claude_cli', {
      ok: true,
      at: expect.any(Number),
      ms: expect.any(Number),
    });
    expect(s.deps.providerFactory.invalidate).toHaveBeenCalled();
  });
  it('a failed smoke maps to its ErrorCode; nothing re-armed; another active provider is never invalidated', async () => {
    const s = setup({ provider: 'local' });
    s.runner.run.mockResolvedValueOnce({
      ...okRun(null),
      sandbox: { initOk: false, toolsCount: 2, mcpServers: 1, apiKeySource: 'none', mismatch: 'extra_server' },
    });
    expect(await s.h['cli:test']({ provider: 'claude_cli' }, FOCUSED)).toEqual({
      ok: false,
      error: { code: 'CLI_TOOLSET_MISMATCH' },
    });
    expect(s.cliStatus.recordTest).toHaveBeenCalledWith('claude_cli', expect.objectContaining({ ok: false }));
    await s.h['cli:test']({ provider: 'claude_cli' }, FOCUSED);
    expect(s.deps.providerFactory.invalidate).not.toHaveBeenCalled();
  });
  it('agy goes through makeAgyForTest; missing collaborators / not installed / too old', async () => {
    const s = setup({
      loc: { provider: 'antigravity_cli', exePath: AGY, version: '1.2.11' },
      provider: 'antigravity_cli',
    });
    expect(await s.h['cli:test']({ provider: 'antigravity_cli' }, FOCUSED)).toMatchObject({ ok: true });
    expect(s.deps.makeAgyForTest).toHaveBeenCalledWith(AGY, '1.2.11');
    const noAgy = setup({
      loc: { provider: 'antigravity_cli', exePath: AGY, version: '1.2.11' },
      extras: { makeAgyForTest: undefined },
    });
    expect(await noAgy.h['cli:test']({ provider: 'antigravity_cli' }, FOCUSED)).toEqual({
      ok: false,
      error: { code: 'INTERNAL' },
    });
    expect(
      await setup({ extras: { cliRunner: undefined } }).h['cli:test']({ provider: 'claude_cli' }, FOCUSED),
    ).toEqual({ ok: false, error: { code: 'INTERNAL' } });
    expect(await setup({ loc: null }).h['cli:test']({ provider: 'claude_cli' }, FOCUSED)).toEqual({
      ok: false,
      error: { code: 'CLI_NOT_INSTALLED' },
    });
    expect(
      await setup({ loc: { provider: 'claude_cli', exePath: CLAUDE, version: '2.1.221' } }).h['cli:test'](
        { provider: 'claude_cli' },
        FOCUSED,
      ),
    ).toEqual({ ok: false, error: { code: 'CLI_VERSION' } });
    const noBreaker = setup({
      extras: { cliRunner: { run: vi.fn(async () => okRun({ ok: true })), breakerOpen: () => false } },
    });
    expect(await noBreaker.h['cli:test']({ provider: 'claude_cli' }, FOCUSED)).toMatchObject({ ok: true });
  });
});

describe('cli:pickExe (the only writer of llm.cli.claudeExePath)', () => {
  it('unfocused / cancelled => unchanged', async () => {
    const s = setup();
    expect(await s.h['cli:pickExe']({ provider: 'claude_cli' }, UNFOCUSED)).toEqual({
      ok: false,
      error: { code: 'WINDOW_NOT_FOCUSED' },
    });
    (s.deps.pickExePath as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    expect(await s.h['cli:pickExe']({ provider: 'claude_cli' }, FOCUSED)).toMatchObject({ ok: true });
    expect(s.setInternal).not.toHaveBeenCalled();
    expect(
      await setup({ extras: { pickExePath: undefined } }).h['cli:pickExe']({ provider: 'claude_cli' }, FOCUSED),
    ).toEqual({
      ok: false,
      error: { code: 'INTERNAL' },
    });
  });
  it.each(['', ...HOSTILE])('hostile pick %j => BAD_REQUEST; never versioned, never written', async (p) => {
    const s = setup({ extras: { pickExePath: vi.fn(async () => p) } });
    expect(await s.h['cli:pickExe']({ provider: 'claude_cli' }, FOCUSED)).toEqual({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    });
    expect(s.locator.version).not.toHaveBeenCalled();
    expect(s.setInternal).not.toHaveBeenCalled();
  });
  it('below the floor or unreadable => CLI_VERSION; a valid exe >= floor is written and the provider re-armed', async () => {
    const s = setup();
    (s.locator.version as ReturnType<typeof vi.fn>).mockResolvedValueOnce('2.1.247');
    expect(await s.h['cli:pickExe']({ provider: 'claude_cli' }, FOCUSED)).toEqual({
      ok: false,
      error: { code: 'CLI_VERSION' },
    });
    (s.locator.version as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('spawn'));
    expect(await s.h['cli:pickExe']({ provider: 'claude_cli' }, FOCUSED)).toEqual({
      ok: false,
      error: { code: 'CLI_VERSION' },
    });
    expect(s.setInternal).not.toHaveBeenCalled();
    expect(await s.h['cli:pickExe']({ provider: 'claude_cli' }, FOCUSED)).toMatchObject({ ok: true });
    expect(s.settings.llm.cli.claudeExePath).toBe('C:\\Tools\\claude.exe');
    expect(s.cliStatus.invalidate).toHaveBeenCalled();
    expect(s.deps.providerFactory.invalidate).toHaveBeenCalled();
    const local = setup({ provider: 'local' });
    await local.h['cli:pickExe']({ provider: 'claude_cli' }, FOCUSED);
    expect(local.deps.providerFactory.invalidate).not.toHaveBeenCalled();
  });
});

describe('cli:previewWorkspaceChange / cli:allowWorkspace (delegating to V2-W1-09 + the W1-04 dialog)', () => {
  it('preview: diff + display facts; an error => BAD_REQUEST; a failing S-PROC reads as running', async () => {
    const s = setup();
    expect(await s.h['cli:previewWorkspaceChange']({ provider: 'antigravity_cli' }, FOCUSED)).toEqual({
      ok: true,
      value: { diffLine: 'trustedWorkspaces: + <workspace>', settingsFileExists: true, agyRunning: false },
    });
    (s.deps.agyRunning as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('x'));
    expect(await s.h['cli:previewWorkspaceChange']({ provider: 'antigravity_cli' }, FOCUSED)).toMatchObject({
      value: { agyRunning: true },
    });
    s.agyWorkspace.preview.mockResolvedValueOnce({ error: 'unparsable' });
    expect(await s.h['cli:previewWorkspaceChange']({ provider: 'antigravity_cli' }, FOCUSED)).toEqual({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    });
    const bare = setup({ extras: { agyRunning: undefined, agySettingsExists: undefined } });
    expect(await bare.h['cli:previewWorkspaceChange']({ provider: 'antigravity_cli' }, FOCUSED)).toMatchObject({
      value: { settingsFileExists: false, agyRunning: false },
    });
  });
  it('allow: unfocused refused; the dialog shows the SAME diff; cancel writes nothing; confirm writes and records', async () => {
    const s = setup();
    expect(await s.h['cli:allowWorkspace']({ provider: 'antigravity_cli', confirm: true }, UNFOCUSED)).toEqual({
      ok: false,
      error: { code: 'WINDOW_NOT_FOCUSED' },
    });
    s.autoDialog.confirmWorkspaceTrust.mockResolvedValueOnce(false);
    expect(await s.h['cli:allowWorkspace']({ provider: 'antigravity_cli', confirm: true }, FOCUSED)).toMatchObject({
      ok: true,
    });
    expect(s.autoDialog.confirmWorkspaceTrust).toHaveBeenCalledWith('WIN', 'trustedWorkspaces: + <workspace>');
    expect(s.agyWorkspace.allow).not.toHaveBeenCalled();
    expect(await s.h['cli:allowWorkspace']({ provider: 'antigravity_cli', confirm: true }, FOCUSED)).toMatchObject({
      ok: true,
    });
    expect(s.agyWorkspace.allow).toHaveBeenCalledWith(true);
    expect(s.cliStatus.recordWorkspaceTrusted).toHaveBeenCalledWith(true);
  });
  it('allow: preview error / allow refusal / no dialog', async () => {
    const s = setup();
    s.agyWorkspace.preview.mockResolvedValueOnce({ error: 'unparsable' });
    expect(await s.h['cli:allowWorkspace']({ provider: 'antigravity_cli', confirm: true }, FOCUSED)).toEqual({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    });
    s.agyWorkspace.allow.mockResolvedValueOnce({ ok: false, error: { code: 'BAD_REQUEST' } } as never);
    expect(await s.h['cli:allowWorkspace']({ provider: 'antigravity_cli', confirm: true }, FOCUSED)).toEqual({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    });
    expect(
      await setup({ extras: { autoDialog: undefined } }).h['cli:allowWorkspace'](
        { provider: 'antigravity_cli', confirm: true },
        FOCUSED,
      ),
    ).toEqual({
      ok: false,
      error: { code: 'INTERNAL' },
    });
  });
  it('allow: refused while agy runs (S-PROC) BEFORE any dialog; an S-PROC failure counts as running; no probe => INTERNAL', async () => {
    const s = setup();
    const running = s.deps.agyRunning as ReturnType<typeof vi.fn>;
    running.mockResolvedValueOnce(true);
    expect(await s.h['cli:allowWorkspace']({ provider: 'antigravity_cli', confirm: true }, FOCUSED)).toEqual({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    });
    running.mockRejectedValueOnce(new Error('tasklist failed'));
    expect(await s.h['cli:allowWorkspace']({ provider: 'antigravity_cli', confirm: true }, FOCUSED)).toEqual({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    });
    expect(s.autoDialog.confirmWorkspaceTrust).not.toHaveBeenCalled();
    expect(s.agyWorkspace.preview).not.toHaveBeenCalled();
    expect(s.agyWorkspace.allow).not.toHaveBeenCalled();
    const bare = setup({ extras: { agyRunning: undefined } });
    expect(await bare.h['cli:allowWorkspace']({ provider: 'antigravity_cli', confirm: true }, FOCUSED)).toEqual({
      ok: false,
      error: { code: 'INTERNAL' },
    });
    expect(bare.autoDialog.confirmWorkspaceTrust).not.toHaveBeenCalled();
  });
});
