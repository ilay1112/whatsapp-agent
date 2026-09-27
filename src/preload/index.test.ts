// CONTRACTS section 18 item 1: IPC_CHANNELS == preload INVOKE set; IPC_EVENTS == preload EVENTS set.
// The preload calls contextBridge at import time and exports nothing, so the literal lists are parsed from its SOURCE text.
// The second half of this file LOADS the module against a local `electron` double (never the shared mock, which this
// package does not own) so the exposed object itself is exercised - TESTS section 13 wants 100 % on `src/preload/**`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IPC_CHANNELS, IPC_EVENTS } from '../shared/ipc';

const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

function literalSet(name: 'INVOKE' | 'EVENTS'): string[] {
  const m = source.match(new RegExp(`const ${name} = new Set<string>\\(\\[([\\s\\S]*?)\\]\\);`));
  expect(m, `${name} literal list`).not.toBeNull();
  return [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

describe('preload allow-lists', () => {
  it('INVOKE == IPC_CHANNELS', () => {
    expect([...literalSet('INVOKE')].sort()).toEqual([...IPC_CHANNELS].sort());
  });
  it('EVENTS == IPC_EVENTS', () => {
    expect([...literalSet('EVENTS')].sort()).toEqual([...IPC_EVENTS].sort());
  });
  it('imports only electron and exposes exactly invoke/on/initial', () => {
    const imports = [...source.matchAll(/^import .* from '([^']+)';?$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['electron']);
    expect(source).toContain("contextBridge.exposeInMainWorld('api', Object.freeze({");
    for (const key of ['invoke:', 'on:', 'initial:']) expect(source).toContain(key);
    expect(source).not.toMatch(/require\(|process\.env|eval\(/);
  });
  it('unknown channels are answered with BAD_REQUEST without touching ipcRenderer', () => {
    expect(source).toContain(
      "if (!INVOKE.has(channel)) return Promise.resolve({ ok: false, error: { code: 'BAD_REQUEST' } });",
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Runtime behaviour of the exposed object.
// ---------------------------------------------------------------------------------------------------------------------
type Listener = (...args: unknown[]) => void;
interface ExposedApi {
  invoke(channel: string, req?: unknown): Promise<unknown>;
  on(event: string, listener: (payload: unknown) => void): () => void;
  initial: { lang: string; dir: string };
}
interface Recorder {
  invokes: Array<[string, unknown]>;
  ons: Array<[string, Listener]>;
  removals: Array<[string, Listener]>;
}

/**
 * Imports the preload with a throwaway `electron` double and the given `process.argv`. `vi.doMock` is scoped to this
 * file, so `tests/mocks/electron.ts` (owned by W0 -> W1-12) is neither edited nor mutated.
 */
async function loadPreload(argv: string[] = []): Promise<{ api: ExposedApi; rec: Recorder; exposedKeys: string[] }> {
  const rec: Recorder = { invokes: [], ons: [], removals: [] };
  const exposed: Array<[string, unknown]> = [];

  vi.resetModules();
  vi.doMock('electron', () => ({
    contextBridge: {
      exposeInMainWorld: (key: string, value: unknown) => {
        exposed.push([key, value]);
      },
    },
    ipcRenderer: {
      invoke: (channel: string, req?: unknown) => {
        rec.invokes.push([channel, req]);
        return Promise.resolve({ ok: true, value: channel });
      },
      on: (channel: string, listener: Listener) => {
        rec.ons.push([channel, listener]);
      },
      removeListener: (channel: string, listener: Listener) => {
        rec.removals.push([channel, listener]);
      },
    },
  }));

  const saved = process.argv;
  process.argv = ['electron.exe', 'main.js', ...argv];
  try {
    await import('./index');
  } finally {
    process.argv = saved;
  }

  expect(exposed.map(([k]) => k)).toEqual(['api']);
  return { api: exposed[0]![1] as ExposedApi, rec, exposedKeys: Object.keys(exposed[0]![1] as object) };
}

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
});

describe('preload runtime surface', () => {
  it('exposes exactly invoke / on / initial, all frozen - no ipcRenderer object reaches the renderer', async () => {
    const { api, exposedKeys } = await loadPreload();
    expect(exposedKeys.sort()).toEqual(['initial', 'invoke', 'on']);
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.initial)).toBe(true);
    expect(JSON.stringify(Object.keys(api))).not.toContain('ipcRenderer');
  });

  it('forwards every allow-listed channel, request payload included', async () => {
    const { api, rec } = await loadPreload();
    for (const channel of IPC_CHANNELS)
      expect(await api.invoke(channel, { probe: channel })).toEqual({ ok: true, value: channel });
    expect(rec.invokes).toEqual(IPC_CHANNELS.map((c) => [c, { probe: c }]));
  });

  it('a request-less channel forwards `undefined`', async () => {
    const { api, rec } = await loadPreload();
    await api.invoke('app:getBootstrap');
    expect(rec.invokes).toEqual([['app:getBootstrap', undefined]]);
  });

  it('an unknown channel resolves BAD_REQUEST and never reaches ipcRenderer', async () => {
    const { api, rec } = await loadPreload();
    for (const channel of [
      '',
      'app:getBootstrap ',
      'APP:getBootstrap',
      'fs:readFile',
      'action:approveAll',
      '__proto__',
      'toString',
    ]) {
      expect(await api.invoke(channel, { x: 1 }), channel).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    }
    expect(rec.invokes).toEqual([]);
  });

  it('subscribes to an allow-listed event, hands the listener ONLY the payload and unsubscribes exactly once', async () => {
    const { api, rec } = await loadPreload();
    const seen: unknown[] = [];
    const off = api.on('health:changed', (payload) => seen.push(payload));

    expect(rec.ons).toHaveLength(1);
    expect(rec.ons[0]![0]).toBe('health:changed');
    // ipcRenderer calls the wrapper with (event, payload); the IpcRendererEvent must not be visible to the renderer.
    rec.ons[0]![1]({ sender: 'IpcRendererEvent' }, { paused: true });
    expect(seen).toEqual([{ paused: true }]);

    off();
    expect(rec.removals).toEqual([['health:changed', rec.ons[0]![1]]]);
  });

  it('every IPC_EVENT can be subscribed to', async () => {
    const { api, rec } = await loadPreload();
    for (const event of IPC_EVENTS) api.on(event, () => {});
    expect(rec.ons.map(([e]) => e)).toEqual([...IPC_EVENTS]);
  });

  it('an unknown event or a non-function listener is a no-op unsubscribe, with no ipcRenderer.on', async () => {
    const { api, rec } = await loadPreload();
    const offUnknown = api.on('fs:watch', () => {});
    const offNotAFn = api.on('health:changed', null as unknown as (payload: unknown) => void);
    expect(typeof offUnknown).toBe('function');
    expect(typeof offNotAFn).toBe('function');
    offUnknown();
    offNotAFn();
    expect(rec.ons).toEqual([]);
    expect(rec.removals).toEqual([]);
  });

  it('initial defaults to en/ltr when main passed no additionalArguments', async () => {
    const { api } = await loadPreload();
    expect(api.initial).toEqual({ lang: 'en', dir: 'ltr' });
  });

  it('initial reads --wca-lang / --wca-dir when they name an allowed value', async () => {
    const { api } = await loadPreload(['--wca-lang=he', '--wca-dir=rtl']);
    expect(api.initial).toEqual({ lang: 'he', dir: 'rtl' });
  });

  it('a value outside the allow-list falls back instead of reaching the renderer', async () => {
    const { api } = await loadPreload(['--wca-lang=../../etc/passwd', '--wca-dir=<script>']);
    expect(api.initial).toEqual({ lang: 'en', dir: 'ltr' });
  });

  it('only the exact --wca-<name>= prefix is read (a look-alike argument is ignored)', async () => {
    const { api } = await loadPreload(['--wca-language=he', '--not-wca-lang=he', '--wca-dir=rtl']);
    expect(api.initial).toEqual({ lang: 'en', dir: 'rtl' });
  });
});
