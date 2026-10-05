// TESTS 4.1 unit-test matrix for readSeams(): packaged => null whatever the env says; mode != e2e => null; WCA_E2E unset => null.
import { afterEach, describe, expect, it } from 'vitest';
import {
  installTestHooks,
  readSeams,
  uninstallTestHooks,
  type WcaTestFacade,
  type WcaTestHooks,
  type WcaTestHooksV2,
} from './testSeams';
import type { DialogRecord } from './app/autoDialog';

const fullEnv = {
  WCA_E2E: '1',
  WCA_BRIDGE_CMD: JSON.stringify({
    command: 'C:\\node\\node.exe',
    args: ['C:\\repo\\tests\\fakes\\fake-bridge.ts', '--control-port', '1'],
    sha256: 'ab',
  }),
  WCA_FAKE_BRIDGE_URL: 'http://127.0.0.1:4321',
  WCA_FAKE_BRIDGE_TOKEN: 'f'.repeat(64),
  WCA_MCP_CMD: JSON.stringify({ command: 'node', args: ['x'] }),
  WCA_LLM: 'stub',
  WCA_LLM_SCRIPT: 'C:\\tmp\\script.json',
  WCA_LLAMA_CMD: JSON.stringify({ command: 'node', args: [] }),
  WCA_MODEL_MANIFEST: 'C:\\tmp\\manifest.json',
  WCA_HW: JSON.stringify({ ramGiB: 16, freeDiskGiB: 50, gpus: [{ name: 'GPU', vramGiB: 8 }] }),
  WCA_TIMERS: JSON.stringify({ debounceMs: 10, sendJitterMs: [1, 2] }),
  WCA_NOW: '2026-09-21T09:00:00Z',
  WCA_FOCUS_CHECK: 'visible-only',
};
const argv = ['electron', '.', '--user-data-dir=C:\\Users\\x\\AppData\\Local\\Temp\\wca-e2e-1'];

describe('readSeams two-lock matrix', () => {
  it.each([
    ['packaged + e2e + WCA_E2E=1', { env: fullEnv, argv, isPackaged: true, mode: 'e2e' }],
    ['unpackaged + production mode + WCA_E2E=1', { env: fullEnv, argv, isPackaged: false, mode: 'production' }],
    [
      'unpackaged + e2e + WCA_E2E unset',
      { env: { ...fullEnv, WCA_E2E: undefined }, argv, isPackaged: false, mode: 'e2e' },
    ],
    [
      'unpackaged + e2e + WCA_E2E=true (not "1")',
      { env: { ...fullEnv, WCA_E2E: 'true' }, argv, isPackaged: false, mode: 'e2e' },
    ],
    ['packaged + production', { env: fullEnv, argv, isPackaged: true, mode: 'production' }],
    ['empty env', { env: {}, argv: [], isPackaged: false, mode: 'e2e' }],
  ])('%s => null', (_n, input) => {
    expect(readSeams(input)).toBeNull();
  });

  it('both locks open => every seam parsed', () => {
    const s = readSeams({ env: fullEnv, argv, isPackaged: false, mode: 'e2e' });
    expect(s).not.toBeNull();
    expect(s!.userDataDir).toBe('C:\\Users\\x\\AppData\\Local\\Temp\\wca-e2e-1');
    expect(s!.bridgeCmd).toEqual({
      command: 'C:\\node\\node.exe',
      args: ['C:\\repo\\tests\\fakes\\fake-bridge.ts', '--control-port', '1'],
      sha256: 'ab',
    });
    expect(s!.fakeBridge).toEqual({ url: 'http://127.0.0.1:4321', token: 'f'.repeat(64) });
    expect(s!.mcpCmd).toEqual({ command: 'node', args: ['x'] });
    expect(s!.llm).toBe('stub');
    expect(s!.llmScript).toBe('C:\\tmp\\script.json');
    expect(s!.llamaCmd).toEqual({ command: 'node', args: [] });
    expect(s!.modelManifest).toBe('C:\\tmp\\manifest.json');
    expect(s!.hardware).toEqual({ ramGiB: 16, freeDiskGiB: 50, gpus: [{ name: 'GPU', vramGiB: 8 }] });
    expect(s!.timers).toEqual({ debounceMs: 10, sendJitterMs: [1, 2] });
    expect(s!.now).toBe(Date.UTC(2026, 8, 21, 9, 0, 0));
    expect(s!.focusCheck).toBe('visible-only');
  });

  it('malformed values are ignored individually, never throw', () => {
    const s = readSeams({
      env: {
        WCA_E2E: '1',
        WCA_BRIDGE_CMD: '{not json',
        WCA_MCP_CMD: JSON.stringify({ command: 1, args: 'x' }),
        WCA_FAKE_BRIDGE_URL: 'http://evil.example:80',
        WCA_FAKE_BRIDGE_TOKEN: 'f'.repeat(64),
        WCA_LLM: 'real',
        WCA_HW: '[]',
        WCA_NOW: 'yesterday',
        WCA_FOCUS_CHECK: 'none',
      },
      argv: ['--user-data-dir='],
      isPackaged: false,
      mode: 'e2e',
    });
    expect(s).toEqual({
      userDataDir: undefined,
      bridgeCmd: undefined,
      fakeBridge: undefined,
      mcpCmd: undefined,
      llm: undefined,
      llmScript: undefined,
      llamaCmd: undefined,
      modelManifest: undefined,
      hardware: undefined,
      timers: undefined,
      now: undefined,
      focusCheck: undefined,
    });
  });

  it('fake bridge attach seam requires 127.0.0.1 and a 64-hex token', () => {
    const base = { argv: [], isPackaged: false, mode: 'e2e' };
    expect(
      readSeams({
        ...base,
        env: { WCA_E2E: '1', WCA_FAKE_BRIDGE_URL: 'http://localhost:1', WCA_FAKE_BRIDGE_TOKEN: 'f'.repeat(64) },
      })!.fakeBridge,
    ).toBeUndefined();
    expect(
      readSeams({
        ...base,
        env: { WCA_E2E: '1', WCA_FAKE_BRIDGE_URL: 'http://127.0.0.1:1', WCA_FAKE_BRIDGE_TOKEN: 'short' },
      })!.fakeBridge,
    ).toBeUndefined();
  });

  it('[D-080] WCA_CONSOLE_DIR (the tracked e2e S-CONSOLE recorder) takes an absolute drive path only', () => {
    const base = { argv: [], isPackaged: false, mode: 'e2e' };
    const dir = (v: string | undefined) =>
      readSeams({ ...base, env: { WCA_E2E: '1', WCA_CONSOLE_DIR: v } })!.consoleDir;
    expect(dir('C:\\Users\\x\\AppData\\Local\\Temp\\wca-e2e-1\\wca-consoles\\a')).toBe(
      'C:\\Users\\x\\AppData\\Local\\Temp\\wca-e2e-1\\wca-consoles\\a',
    );
    expect(dir(undefined)).toBeUndefined();
    expect(dir('')).toBeUndefined();
    expect(dir('relative\\dir')).toBeUndefined();
    expect(dir('\\\\server\\share\\dir')).toBeUndefined();
    expect(dir('C:\\tmp\\..\\Windows')).toBeUndefined();
    // the production locks still win
    expect(
      readSeams({ argv: [], isPackaged: true, mode: 'e2e', env: { WCA_E2E: '1', WCA_CONSOLE_DIR: 'C:\\x' } }),
    ).toBeNull();
  });
});

describe('installTestHooks (globalThis.__wcaTest)', () => {
  const hooks = (): WcaTestHooks & { clicks: string[] } => {
    const clicks: string[] = [];
    return {
      clicks,
      trayTemplate: () => [{ id: 'open', label: 'Open' }],
      trayClick: (id) => void clicks.push(id),
      trayState: () => ({ icon: 'tray', tooltip: 'WhatsApp Calendar Agent' }),
      doorbellUrl: () => 'http://127.0.0.1:5511/hook/secret',
      health: () => ({ overall: 'ok' }) as never,
      notifications: () => [{ title: 't', body: 'b' }],
      openedExternal: () => ['https://example.com/'],
      childPids: () => ({ bridge: 4242 }),
    };
  };
  const RECORD: DialogRecord = {
    kind: 'auto_enable',
    type: 'warning',
    title: 'Turn on automatic mode?',
    message: 'm',
    detail: 'd',
    buttons: ['Cancel', 'Start a 24-hour trial'],
    defaultId: 0,
    cancelId: 0,
    checkboxLabel: 'I understand',
    parentFocused: true,
  };
  const v2 = (): WcaTestHooksV2 & { autoPauses: number } => {
    const state = {
      autoPauses: 0,
      dialogs: () => [RECORD],
      consoles: () => [['C:/fake/claude.exe', 'auth', 'login', '--claudeai']],
      jobPids: () => ({ cli: [11], voice: [] as number[] }),
      trayClickAutoPause: () => {
        state.autoPauses += 1;
      },
    };
    return state;
  };
  const wca = (): WcaTestFacade | undefined => (globalThis as { __wcaTest?: WcaTestFacade }).__wcaTest;

  afterEach(() => uninstallTestHooks());

  it('[V2] exposes exactly the eleven hooks of TESTS 4.2 (eight v1 + dialogs, consoles, jobPids) and nothing else', () => {
    installTestHooks(hooks(), v2());
    expect(Object.keys(wca()!).sort()).toEqual(
      [
        'childPids',
        'consoles',
        'dialogs',
        'doorbellUrl',
        'health',
        'jobPids',
        'notifications',
        'openedExternal',
        'trayClick',
        'trayState',
        'trayTemplate',
      ].sort(),
    );
    expect(Object.keys(wca()!)).not.toContain('clicks');
    expect(Object.keys(wca()!)).not.toContain('trayClickAutoPause');
    expect(Object.keys(wca()!)).not.toContain('autoPauses');
  });

  it('forwards every read hook to the implementation', () => {
    installTestHooks(hooks(), v2());
    expect(wca()!.trayTemplate()).toEqual([{ id: 'open', label: 'Open' }]);
    expect(wca()!.trayState()).toEqual({ icon: 'tray', tooltip: 'WhatsApp Calendar Agent' });
    expect(wca()!.doorbellUrl()).toContain('127.0.0.1');
    expect(wca()!.health()).toEqual({ overall: 'ok' });
    expect(wca()!.notifications()).toEqual([{ title: 't', body: 'b', actions: [] }]);
    expect(wca()!.openedExternal()).toEqual(['https://example.com/']);
    expect(wca()!.childPids()).toEqual({ bridge: 4242 });
    expect(wca()!.dialogs()).toEqual([RECORD]);
    expect(wca()!.consoles()).toEqual([['C:/fake/claude.exe', 'auth', 'login', '--claudeai']]);
    expect(wca()!.jobPids()).toEqual({ cli: [11], voice: [] });
  });

  it('[V2] notifications carry the toast actions', () => {
    const h = hooks();
    installTestHooks({ ...h, notifications: () => [{ title: 't', body: 'b', actions: ['Undo', 'Show'] }] });
    expect(wca()!.notifications()).toEqual([{ title: 't', body: 'b', actions: ['Undo', 'Show'] }]);
  });

  it('[V2] the v2 reads default to empty values when the caller wires none (the v1 call site keeps working)', () => {
    installTestHooks(hooks());
    expect(wca()!.dialogs()).toEqual([]);
    expect(wca()!.consoles()).toEqual([]);
    expect(wca()!.jobPids()).toEqual({ cli: [], voice: [] });
    expect(() => wca()!.trayClick('autoPause')).toThrow(/autoPause is not wired/);
  });

  it('[V2] every v2 read returns a copy: mutating it never reaches the recorder', () => {
    const impl = v2();
    const pids = { cli: [11], voice: [22] };
    const consoles = [['a', 'b']];
    const dialogs = [{ ...RECORD, buttons: ['x'] }];
    installTestHooks(hooks(), { ...impl, jobPids: () => pids, consoles: () => consoles, dialogs: () => dialogs });
    wca()!.jobPids().cli.push(99);
    wca()!.consoles()[0]!.push('c');
    wca()!.dialogs()[0]!.buttons.push('y');
    expect(pids).toEqual({ cli: [11], voice: [22] });
    expect(consoles).toEqual([['a', 'b']]);
    expect(dialogs[0]!.buttons).toEqual(['x']);
  });

  it('trayClick is the only state-changing hook: v1 ids go to the tray, autoPause to the B11 item, anything else throws', () => {
    const h = hooks();
    const impl = v2();
    installTestHooks(h, impl);
    wca()!.trayClick('pause');
    expect(h.clicks).toEqual(['pause']);
    wca()!.trayClick('autoPause');
    expect(impl.autoPauses).toBe(1);
    expect(h.clicks).toEqual(['pause']);
    expect(() => wca()!.trayClick('approve' as never)).toThrow(/unknown id/);
    expect(h.clicks).toEqual(['pause']);
  });

  it('the facade is frozen: a test page cannot bolt an approve function onto it', () => {
    installTestHooks(hooks(), v2());
    expect(Object.isFrozen(wca())).toBe(true);
    expect(() => {
      (wca() as unknown as Record<string, unknown>).approve = () => 'pwned';
    }).toThrow();
    expect((wca() as unknown as Record<string, unknown>).approve).toBeUndefined();
  });

  it('the property is non-enumerable and removable again', () => {
    installTestHooks(hooks());
    expect(Object.keys(globalThis)).not.toContain('__wcaTest');
    uninstallTestHooks();
    expect(wca()).toBeUndefined();
  });
});
