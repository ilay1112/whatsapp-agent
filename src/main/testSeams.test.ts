// TESTS 4.1 unit-test matrix for readSeams(): packaged => null whatever the env says; mode != e2e => null; WCA_E2E unset => null.
import { afterEach, describe, expect, it } from 'vitest';
import { installTestHooks, readSeams, uninstallTestHooks, type WcaTestHooks } from './testSeams';

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
  const wca = (): WcaTestHooks | undefined => (globalThis as { __wcaTest?: WcaTestHooks }).__wcaTest;

  afterEach(() => uninstallTestHooks());

  it('exposes exactly the eight hooks of TESTS 4.2 and nothing else', () => {
    const h = hooks();
    installTestHooks(h);
    expect(Object.keys(wca()!).sort()).toEqual(
      [
        'childPids',
        'doorbellUrl',
        'health',
        'notifications',
        'openedExternal',
        'trayClick',
        'trayState',
        'trayTemplate',
      ].sort(),
    );
    expect(Object.keys(wca()!)).not.toContain('clicks');
  });

  it('forwards every read hook to the implementation', () => {
    installTestHooks(hooks());
    expect(wca()!.trayTemplate()).toEqual([{ id: 'open', label: 'Open' }]);
    expect(wca()!.trayState()).toEqual({ icon: 'tray', tooltip: 'WhatsApp Calendar Agent' });
    expect(wca()!.doorbellUrl()).toContain('127.0.0.1');
    expect(wca()!.health()).toEqual({ overall: 'ok' });
    expect(wca()!.notifications()).toEqual([{ title: 't', body: 'b' }]);
    expect(wca()!.openedExternal()).toEqual(['https://example.com/']);
    expect(wca()!.childPids()).toEqual({ bridge: 4242 });
  });

  it('trayClick is the only state-changing hook and is forwarded', () => {
    const h = hooks();
    installTestHooks(h);
    wca()!.trayClick('pause');
    expect(h.clicks).toEqual(['pause']);
  });

  it('the facade is frozen: a test page cannot bolt an approve function onto it', () => {
    installTestHooks(hooks());
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
