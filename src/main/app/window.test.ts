// TESTS 5.3 row `app/window.ts` + gate item 12a: exact webPreferences, navigation denials, close-to-tray (immediate, every
// time), first-hide toast, and the quit call order.
import { beforeEach, describe, expect, it, vi } from 'vitest';
// The vitest alias maps `electron` to this mock, so production code and this test share one module instance.
import { BrowserWindow, Menu, resetElectronMock } from '../../../tests/mocks/electron';
import {
  APP_URL,
  buildWebPreferences,
  createMainWindow,
  createRendererRecovery,
  hardenWebContents,
  installCloseToTray,
  installTrayHintCoachMark,
  isAppUrl,
  isHiddenStart,
  QUIT_CHILD_GRACE_MS,
  QUIT_DRAIN_MS,
  REBUILD_MAX_ATTEMPTS,
  REBUILD_WINDOW_MS,
  runQuitSequence,
  WINDOW_BOUNDS,
  type QuitDeps,
  type RendererRecoveryDeps,
} from './window';
import { createLogger } from '../logger';
import type { Logger } from '../deps';

const log = createLogger({ logsDir: 'C:\\tmp' });
const deps = {
  preloadPath: 'C:\\app\\out\\preload\\index.cjs',
  isPackaged: true,
  initial: { lang: 'he', dir: 'rtl' } as const,
  startHidden: false,
  log,
};

/** The production code is typed against the real electron API; at run time it is this mock. */
type MockWindow = InstanceType<typeof BrowserWindow>;
type RealWindow = Parameters<typeof installCloseToTray>[0];
const asMock = (w: unknown): MockWindow => w as MockWindow;
const asReal = (w: MockWindow): RealWindow => w as unknown as RealWindow;

beforeEach(() => resetElectronMock());

describe('buildWebPreferences - exact object (ARCHITECTURE 15.1)', () => {
  it('matches the specification key for key', () => {
    expect(buildWebPreferences(deps)).toEqual({
      preload: 'C:\\app\\out\\preload\\index.cjs',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      experimentalFeatures: false,
      spellcheck: false,
      devTools: false,
      additionalArguments: ['--wca-lang=he', '--wca-dir=rtl'],
    });
  });

  it('devTools follow isPackaged', () => {
    expect(buildWebPreferences({ ...deps, isPackaged: false }).devTools).toBe(true);
  });

  it('passes the initial language through additionalArguments, never through a channel', () => {
    expect(buildWebPreferences({ ...deps, initial: { lang: 'en', dir: 'ltr' } }).additionalArguments).toEqual([
      '--wca-lang=en',
      '--wca-dir=ltr',
    ]);
  });
});

describe('isAppUrl', () => {
  it.each([
    ['app://bundle/index.html', true],
    ['app://bundle/assets/x.js', true],
    ['app://evil/index.html', false],
    ['https://example.com/', false],
    ['http://127.0.0.1:1234/', false],
    ['file:///C:/Windows/win.ini', false],
    ['data:text/html,<script>1</script>', false],
    ['about:blank', false],
    ['javascript:alert(1)', false],
    ['not a url', false],
  ])('%s -> %s', (url, expected) => {
    expect(isAppUrl(url)).toBe(expected);
  });
});

describe('createMainWindow', () => {
  it('uses the ARCH geometry, starts hidden and loads only app://bundle', () => {
    const win = asMock(createMainWindow(deps));
    expect(win.options).toMatchObject({ ...WINDOW_BOUNDS, show: false, autoHideMenuBar: true });
    expect(win.loaded).toBe(APP_URL);
    expect(Menu.applicationMenu).toBeNull();
  });

  it('shows itself on ready-to-show unless --hidden was passed', () => {
    const win = asMock(createMainWindow(deps));
    win.emit('ready-to-show');
    expect(win.isVisible()).toBe(true);

    const hidden = asMock(createMainWindow({ ...deps, startHidden: true }));
    hidden.emit('ready-to-show');
    expect(hidden.isVisible()).toBe(false);
  });

  it('denies navigation, window.open, webviews and every permission', () => {
    const win = asMock(createMainWindow(deps));
    const prevented: string[] = [];
    win.webContents.emit('will-navigate', { preventDefault: () => prevented.push('nav') }, 'https://evil.example/');
    expect(prevented).toEqual(['nav']);
    win.webContents.emit('will-navigate', { preventDefault: () => prevented.push('nav2') }, 'app://bundle/index.html');
    expect(prevented).toEqual(['nav']); // our own bundle may navigate
    expect(win.webContents.windowOpenHandler!({ url: 'https://evil.example/' })).toEqual({ action: 'deny' });
    win.webContents.emit('will-attach-webview', { preventDefault: () => prevented.push('webview') });
    expect(prevented).toContain('webview');

    const granted: boolean[] = [];
    win.webContents.session.permissionRequestHandler!(null, 'media', (ok: boolean) => granted.push(ok));
    expect(granted).toEqual([false]);
    expect(win.webContents.session.permissionCheckHandler!()).toBe(false);
  });

  it('hardenWebContents falls back to the default session when the contents carry none', () => {
    const win = new BrowserWindow({});
    (win.webContents as unknown as { session: unknown }).session = undefined;
    expect(() => hardenWebContents(asReal(win), log)).not.toThrow();
  });

  it('reports render-process-gone so the owner can recreate the window', () => {
    const gone = vi.fn();
    const win = asMock(createMainWindow({ ...deps, onRenderProcessGone: gone }));
    win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(gone).toHaveBeenCalledWith('crashed');
  });

  it('survives a render-process-gone event without a reason and without a handler', () => {
    const win = asMock(createMainWindow(deps));
    expect(() => win.webContents.emit('render-process-gone', {}, {})).not.toThrow();
  });
});

describe('createRendererRecovery (ARCHITECTURE 14 "Renderer gone -> recreate window", main state intact)', () => {
  /** A logger that records the event names per level, so a test can pin `renderer.rebuild_limit`. */
  const recordingLogger = (): { log: Logger; lines: Array<{ level: string; event: string }> } => {
    const lines: Array<{ level: string; event: string }> = [];
    const mk = (): Logger => ({
      info: (event) => void lines.push({ level: 'info', event }),
      warn: (event) => void lines.push({ level: 'warn', event }),
      error: (event) => void lines.push({ level: 'error', event }),
      child: () => mk(),
    });
    return { log: mk(), lines };
  };

  const setup = (over: Partial<RendererRecoveryDeps> = {}) => {
    const rec = recordingLogger();
    const built: Array<{ win: MockWindow; startHidden: boolean }> = [];
    let quitting = over.isQuitting === undefined ? false : over.isQuitting();
    let nowMs = 1_000_000;
    const exhausted = vi.fn();
    const recovery = createRendererRecovery({
      build: (startHidden) => {
        const win = new BrowserWindow({});
        built.push({ win, startHidden });
        // Real windows show themselves on ready-to-show; the mock needs the same nudge to be "visible".
        if (!startHidden) win.show();
        return asReal(win) as unknown as ReturnType<RendererRecoveryDeps['build']>;
      },
      isQuitting: () => quitting,
      now: () => nowMs,
      log: rec.log,
      startHidden: false,
      onExhausted: exhausted,
      ...over,
    });
    return {
      recovery,
      built,
      exhausted,
      lines: rec.lines,
      setQuitting: () => (quitting = true),
      advance: (ms: number) => (nowMs += ms),
      crash: (win: MockWindow): MockWindow | null => {
        const next = recovery.recover(asReal(win), 'crashed');
        return next === null ? null : asMock(next);
      },
    };
  };

  it('destroys the crashed window instead of leaving a ghost behind', () => {
    const h = setup();
    const first = asMock(h.recovery.start());
    expect(BrowserWindow.getAllWindows()).toContain(first);

    const replacement = h.crash(first);
    expect(replacement).not.toBeNull();
    expect(replacement).not.toBe(first);
    expect(first.isDestroyed()).toBe(true);
    expect(BrowserWindow.getAllWindows()).not.toContain(first);
    expect(BrowserWindow.getAllWindows()).toContain(replacement!);
  });

  it('destroys the crashed window even though close-to-tray would only hide it', () => {
    const h = setup();
    const first = asMock(h.recovery.start());
    // The crashed window carries the same close-to-tray handler as any other window: close() would merely hide it.
    const firstHide = vi.fn();
    installCloseToTray(asReal(first), {
      onFirstHide: firstHide,
      trayHintSeen: () => false,
      isQuitting: () => false,
    });

    h.crash(first);
    expect(first.isDestroyed()).toBe(true);
    // The ghost must not burn the one-shot tray coach mark on its way out.
    expect(firstHide).not.toHaveBeenCalled();
  });

  it('builds no window once the quit sequence started', () => {
    const h = setup();
    const first = asMock(h.recovery.start());
    h.setQuitting();

    expect(h.crash(first)).toBeNull();
    expect(h.built).toHaveLength(1); // only the original
    expect(first.isDestroyed()).toBe(true);
  });

  it(`caps rebuilds at ${REBUILD_MAX_ATTEMPTS} inside the window and then stops looping`, () => {
    const h = setup();
    let live = asMock(h.recovery.start());
    for (let i = 0; i < REBUILD_MAX_ATTEMPTS; i++) {
      h.advance(1_000);
      const next = h.crash(live);
      expect(next).not.toBeNull();
      live = next!;
    }
    h.advance(1_000);
    expect(h.crash(live)).toBeNull();
    expect(live.isDestroyed()).toBe(true);
    expect(h.built).toHaveLength(1 + REBUILD_MAX_ATTEMPTS);
    expect(h.exhausted).toHaveBeenCalledTimes(1);
    expect(h.lines.filter((l) => l.level === 'error' && l.event === 'renderer.rebuild_limit')).toHaveLength(1);
  });

  it('the cap is a sliding window: a later crash rebuilds again', () => {
    const h = setup();
    let live = asMock(h.recovery.start());
    for (let i = 0; i < REBUILD_MAX_ATTEMPTS; i++) {
      const next = h.crash(live);
      live = next!;
    }
    h.advance(REBUILD_WINDOW_MS + 1);
    const next = h.crash(live);
    expect(next).not.toBeNull();
    expect(h.built).toHaveLength(2 + REBUILD_MAX_ATTEMPTS);
  });

  it('a crash while the app sits in the tray does not pop a visible window', () => {
    const h = setup({ startHidden: true });
    const first = asMock(h.recovery.start());
    expect(h.built[0]!.startHidden).toBe(true);

    h.crash(first);
    expect(h.built[1]!.startHidden).toBe(true);
  });

  it('a crash while the window is on screen brings a visible window back', () => {
    const h = setup({ startHidden: true });
    const first = asMock(h.recovery.start());
    first.show(); // the user opened it from the tray

    h.crash(first);
    expect(h.built[1]!.startHidden).toBe(false);
  });

  it('a window hidden to the tray after start is rebuilt hidden', () => {
    const h = setup();
    const first = asMock(h.recovery.start());
    first.hide();

    h.crash(first);
    expect(h.built[1]!.startHidden).toBe(true);
  });

  it('an already destroyed crashed window is not destroyed twice', () => {
    const h = setup();
    const first = asMock(h.recovery.start());
    first.destroy();
    expect(() => h.crash(first)).not.toThrow();
    expect(h.built).toHaveLength(2);
  });
});

describe('isHiddenStart', () => {
  it.each([
    [['electron', '.', '--hidden'], true],
    [['electron', '.'], false],
    [['electron', '.', '--hidden=1'], false],
  ])('%s -> %s', (argv, expected) => {
    expect(isHiddenStart(argv)).toBe(expected);
  });
});

describe('installTrayHintCoachMark', () => {
  it('sends ui:navigate {view:"tray_hint"} the next time the window is shown', () => {
    const win = new BrowserWindow({});
    let pending = true;
    const onShow = vi.fn(() => {
      pending = false;
    });
    const uninstall = installTrayHintCoachMark(asReal(win), { pending: () => pending, onShow });
    win.show();
    expect(onShow).toHaveBeenCalledTimes(1);
    win.hide();
    win.show();
    expect(onShow).toHaveBeenCalledTimes(1); // it is shown once, never on every open
    uninstall();
  });

  it('shows nothing when no coach mark is pending', () => {
    const win = new BrowserWindow({});
    const onShow = vi.fn();
    installTrayHintCoachMark(asReal(win), { pending: () => false, onShow });
    win.show();
    expect(onShow).not.toHaveBeenCalled();
  });

  it('the uninstall function removes the listener', () => {
    const win = new BrowserWindow({});
    const onShow = vi.fn();
    installTrayHintCoachMark(asReal(win), { pending: () => true, onShow })();
    win.show();
    expect(onShow).not.toHaveBeenCalled();
  });

  it('the window is never kept open for the mark - it only reacts to a show', () => {
    const win = new BrowserWindow({});
    const onShow = vi.fn();
    installTrayHintCoachMark(asReal(win), { pending: () => true, onShow });
    win.close();
    expect(onShow).not.toHaveBeenCalled();
  });
});

describe('installCloseToTray', () => {
  const setup = (over: { trayHintSeen?: boolean; isQuitting?: boolean } = {}) => {
    const win = new BrowserWindow({});
    let seen = over.trayHintSeen ?? false;
    let quitting = over.isQuitting ?? false;
    const firstHide = vi.fn(() => {
      seen = true;
    });
    const uninstall = installCloseToTray(asReal(win), {
      onFirstHide: firstHide,
      trayHintSeen: () => seen,
      isQuitting: () => quitting,
    });
    return { win, firstHide, uninstall, setQuitting: () => (quitting = true) };
  };

  it('the FIRST close hides immediately and fires the toast exactly once', () => {
    const h = setup();
    h.win.show();
    h.win.close();
    expect(h.win.isVisible()).toBe(false);
    expect(h.win.isDestroyed()).toBe(false);
    expect(h.firstHide).toHaveBeenCalledTimes(1);
  });

  it('every later close hides too, without another toast', () => {
    const h = setup();
    h.win.close();
    h.win.show();
    h.win.close();
    h.win.show();
    h.win.close();
    expect(h.firstHide).toHaveBeenCalledTimes(1);
    expect(h.win.isVisible()).toBe(false);
    expect(h.win.isDestroyed()).toBe(false);
  });

  it('no toast when the hint was already seen in an earlier run', () => {
    const h = setup({ trayHintSeen: true });
    h.win.close();
    expect(h.firstHide).not.toHaveBeenCalled();
    expect(h.win.isDestroyed()).toBe(false);
  });

  it('once the quit sequence started, close really closes', () => {
    const h = setup();
    h.setQuitting();
    h.win.close();
    expect(h.win.isDestroyed()).toBe(true);
    expect(h.firstHide).not.toHaveBeenCalled();
  });

  it('the uninstall function removes the handler', () => {
    const h = setup();
    h.uninstall();
    h.win.close();
    expect(h.win.isDestroyed()).toBe(true);
  });
});

describe('runQuitSequence', () => {
  const setup = (over: Partial<QuitDeps> = {}): { deps: QuitDeps; order: string[] } => {
    const order: string[] = [];
    const record = (name: string) => async (): Promise<void> => {
      order.push(name);
    };
    const quitDeps: QuitDeps = {
      setQuitting: () => void order.push('setQuitting'),
      stopQueue: record('stopQueue'),
      drainExecutor: async (ms) => void order.push(`drainExecutor:${ms}`),
      stopChildren: async (opts) => void order.push(`stopChildren:${opts.graceMs}`),
      writeLastOnline: () => void order.push('writeLastOnline'),
      closeDb: () => void order.push('closeDb'),
      destroyTray: () => void order.push('destroyTray'),
      exit: () => void order.push('exit'),
      log,
      timeoutMs: 10_000,
      ...over,
    };
    return { deps: quitDeps, order };
  };

  it('runs the exact order of ARCHITECTURE 13', async () => {
    const h = setup();
    await runQuitSequence(h.deps);
    expect(h.order).toEqual([
      'setQuitting',
      'stopQueue',
      `drainExecutor:${QUIT_DRAIN_MS}`,
      `stopChildren:${QUIT_CHILD_GRACE_MS}`,
      'writeLastOnline',
      'closeDb',
      'destroyTray',
      'exit',
    ]);
  });

  it('a throwing step does not stop the sequence and exit still happens once', async () => {
    const h = setup({
      stopQueue: () => Promise.reject(new Error('stuck')),
      stopChildren: () => {
        throw new Error('taskkill failed');
      },
    });
    await runQuitSequence(h.deps);
    expect(h.order).toEqual([
      'setQuitting',
      `drainExecutor:${QUIT_DRAIN_MS}`,
      'writeLastOnline',
      'closeDb',
      'destroyTray',
      'exit',
    ]);
    expect(h.order.filter((s) => s === 'exit')).toHaveLength(1);
  });

  it('exits anyway when a step hangs past timeoutMs', async () => {
    const h = setup({ timeoutMs: 20, stopChildren: () => new Promise<void>(() => {}) });
    await runQuitSequence(h.deps);
    expect(h.order).toContain('exit');
    expect(h.order).not.toContain('closeDb');
  });

  it('the drain budget never exceeds the overall timeout', async () => {
    const h = setup({ timeoutMs: 1_000 });
    await runQuitSequence(h.deps);
    expect(h.order).toContain('drainExecutor:1000');
  });

  it('[V2] B2: every job is killed BEFORE the supervised children stop (call-order spy)', async () => {
    const h = setup();
    h.deps.killJobs = async () => void h.order.push('killJobs');
    await runQuitSequence(h.deps);
    expect(h.order.indexOf('killJobs')).toBeGreaterThan(h.order.indexOf('stopQueue'));
    expect(h.order.indexOf('killJobs')).toBeLessThan(h.order.indexOf(`stopChildren:${QUIT_CHILD_GRACE_MS}`));
    expect(h.order.filter((x) => x === 'killJobs')).toHaveLength(1);
  });

  it('[V2] a failing job kill never stops the sequence', async () => {
    const h = setup({ killJobs: () => Promise.reject(new Error('taskkill refused')) });
    await runQuitSequence(h.deps);
    expect(h.order).toContain(`stopChildren:${QUIT_CHILD_GRACE_MS}`);
    expect(h.order.at(-1)).toBe('exit');
  });

  it('setQuitting runs before anything else so the close handler stops hiding', async () => {
    const h = setup();
    await runQuitSequence(h.deps);
    expect(h.order[0]).toBe('setQuitting');
  });
});
