// src/main/app/window.ts - BrowserWindow factory + close-to-tray (build-plan section 3; owner W1-12). May import `electron`.
import { BrowserWindow, Menu, session } from 'electron';
import { APP_HOST, APP_SCHEME } from './protocol';
import type { Logger } from '../deps';
import type { Lang, Dir } from '../../shared/types';

export interface MainWindowDeps {
  preloadPath: string; // out/preload/index.cjs
  isPackaged: boolean;
  initial: { lang: Lang; dir: Dir }; // -> webPreferences.additionalArguments --wca-lang= / --wca-dir=
  startHidden: boolean; // --hidden (autostart)
  log: Logger;
  /** `render-process-gone`: main state is intact, so the owner (compose.ts) just builds a new window (ARCHITECTURE 14). */
  onRenderProcessGone?: (reason: string) => void;
}

/** The autostart entry launches us with `--hidden` (electron-stack 5.5); `wasOpenedAtLogin` is macOS-only. */
export function isHiddenStart(argv: readonly string[]): boolean {
  return argv.includes('--hidden');
}

/** ARCHITECTURE 15.1 window geometry. */
export const WINDOW_BOUNDS = { width: 980, height: 680, minWidth: 420, minHeight: 560 } as const;
/** The only URL the window ever loads. */
export const APP_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

/** Pure: the exact `webPreferences` object of ARCHITECTURE 15.1 (asserted byte-for-byte by tests/security/electron-hardening). */
export function buildWebPreferences(
  deps: Pick<MainWindowDeps, 'preloadPath' | 'isPackaged' | 'initial'>,
): Record<string, unknown> {
  return {
    preload: deps.preloadPath,
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
    devTools: !deps.isPackaged,
    additionalArguments: [`--wca-lang=${deps.initial.lang}`, `--wca-dir=${deps.initial.dir}`],
  };
}

/** Pure: only our own bundle may be navigated to; every other URL (http, https, file, data, about) is refused. */
export function isAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST;
  } catch {
    return false;
  }
}

/** Installs the navigation / new-window / webview / permission denials of ARCHITECTURE 15.1 on one window. */
export function hardenWebContents(win: BrowserWindow, log: Logger): void {
  const contents = win.webContents;
  contents.on('will-navigate', (event: { preventDefault(): void }, url: string) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    log.warn('navigation.blocked');
  });
  contents.setWindowOpenHandler(() => {
    log.warn('window_open.blocked');
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event: { preventDefault(): void }) => {
    event.preventDefault();
    log.warn('webview.blocked');
  });
  const target = contents.session ?? session.defaultSession;
  target.setPermissionRequestHandler((_wc: unknown, _permission: string, callback: (granted: boolean) => void) =>
    callback(false),
  );
  target.setPermissionCheckHandler(() => false);
}

/** ARCHITECTURE 15.1: 980x680, min 420x560, show:false, autoHideMenuBar, hardened webPreferences, Menu.setApplicationMenu(null),
 *  will-navigate / window.open / will-attach-webview denied, all permission requests denied, loads app://bundle/index.html. */
export function createMainWindow(deps: MainWindowDeps): BrowserWindow {
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    ...WINDOW_BOUNDS,
    show: false,
    autoHideMenuBar: true,
    webPreferences: buildWebPreferences(deps),
  });
  hardenWebContents(win, deps.log);
  win.once('ready-to-show', () => {
    if (!deps.startHidden) win.show();
  });
  win.webContents.on('render-process-gone', (_event: unknown, details: { reason?: string }) => {
    deps.log.error('renderer.gone', { reason: details?.reason ?? 'unknown' });
    deps.onRenderProcessGone?.(details?.reason ?? 'unknown');
  });
  void win.loadURL(APP_URL);
  deps.log.info('window.created', { hidden: deps.startHidden, lang: deps.initial.lang });
  return win;
}

// ---------------------------------------------------------------------------------------------------------------------
// renderer-crash recovery (ARCHITECTURE 14: "Renderer gone -> recreate window", main state intact)
// ---------------------------------------------------------------------------------------------------------------------

/** Sliding budget for automatic rebuilds after `render-process-gone`. */
export const REBUILD_WINDOW_MS = 60_000;
export const REBUILD_MAX_ATTEMPTS = 3;

export interface RendererRecoveryDeps {
  /** Builds a fully wired window (close-to-tray, coach mark, `attachWindow`); owned by the composition root. */
  build: (startHidden: boolean) => BrowserWindow;
  /** True once the quit sequence started: a renderer killed during teardown must NOT resurrect a window. */
  isQuitting: () => boolean;
  now: () => number;
  log: Logger;
  /** The launch intent (`--hidden`); afterwards the live window's own show/hide decides. */
  startHidden: boolean;
  /** Called once when the budget is exhausted. No replacement is built after that. */
  onExhausted?: (reason: string) => void;
}

export interface RendererRecovery {
  /** Builds the first window and starts tracking its visibility. */
  start: () => BrowserWindow;
  /**
   * Handles one `render-process-gone`. Returns the replacement window, or `null` when none was built
   * (the app is quitting, or the rebuild budget is spent). The crashed window is always disposed.
   */
  recover: (crashed: BrowserWindow, reason: string) => BrowserWindow | null;
}

/**
 * Replaces a crashed renderer's window without leaving the dead one behind.
 *
 * `destroy()` - never `close()` - because `installCloseToTray` is attached to the crashed window too and would turn a
 * close into a hide, leaving an un-closable ghost on screen that also burns the one-shot tray coach mark. The
 * replacement is built BEFORE the old one is disposed, so a throwing `build` leaves the user with a window rather
 * than none.
 */
export function createRendererRecovery(deps: RendererRecoveryDeps): RendererRecovery {
  /** Timestamps of the rebuilds still inside the sliding window. */
  const attempts: number[] = [];
  let current: BrowserWindow | null = null;
  let hidden = deps.startHidden;

  const make = (startHidden: boolean): BrowserWindow => {
    const win = deps.build(startHidden);
    current = win;
    hidden = startHidden;
    // Only the live window may move the flag: a crashed one is disposed right after the replacement is built.
    win.on('show', () => {
      if (current === win) hidden = false;
    });
    win.on('hide', () => {
      if (current === win) hidden = true;
    });
    return win;
  };

  const dispose = (win: BrowserWindow): void => {
    if (!win.isDestroyed()) win.destroy();
  };

  return {
    start: () => make(deps.startHidden),
    recover: (crashed, reason) => {
      if (deps.isQuitting()) {
        deps.log.warn('renderer.gone.quitting', { reason });
        dispose(crashed);
        current = null;
        return null;
      }
      const at = deps.now();
      const cutoff = at - REBUILD_WINDOW_MS;
      while (attempts.length > 0 && (attempts[0] as number) <= cutoff) attempts.shift();
      if (attempts.length >= REBUILD_MAX_ATTEMPTS) {
        deps.log.error('renderer.rebuild_limit', { reason, max: REBUILD_MAX_ATTEMPTS, windowMs: REBUILD_WINDOW_MS });
        dispose(crashed);
        current = null;
        deps.onExhausted?.(reason);
        return null;
      }
      attempts.push(at);
      const replacement = make(hidden);
      dispose(crashed);
      return replacement;
    },
  };
}

export interface CloseToTrayDeps {
  onFirstHide: () => void; // toast + meta.tray_hint_seen (UX 12.2)
  trayHintSeen: () => boolean;
  isQuitting: () => boolean; // runQuitSequence sets it; then close really closes
}

/** Every X click hides at once (preventDefault + hide). Returns an uninstall function. */
export function installCloseToTray(win: BrowserWindow, deps: CloseToTrayDeps): () => void {
  const onClose = (event: { preventDefault(): void }): void => {
    if (deps.isQuitting()) return; // the quit sequence is running: let the window close
    event.preventDefault();
    win.hide(); // immediately, EVERY time - the first close included (ARCHITECTURE 13)
    if (!deps.trayHintSeen()) deps.onFirstHide();
  };
  win.on('close', onClose);
  return () => {
    win.removeListener('close', onClose);
  };
}

export interface CoachMarkDeps {
  /** True while the first-close toast has been shown but the in-window coach mark has not been displayed yet. */
  pending: () => boolean;
  /** Sends `ui:navigate {view:'tray_hint'}` to the renderer (UX 12.2). */
  onShow: () => void;
}

/** UX 12.2 / ARCHITECTURE 13: the coach mark appears the NEXT time the window is opened - the window is never kept open for it. */
export function installTrayHintCoachMark(win: BrowserWindow, deps: CoachMarkDeps): () => void {
  const onShow = (): void => {
    if (deps.pending()) deps.onShow();
  };
  win.on('show', onShow);
  return () => {
    win.removeListener('show', onShow);
  };
}

/** Quit sequence inputs (ARCHITECTURE section 13 / electron-stack 5.3): every step is an injected thunk so the ORDER is unit-testable. */
export interface QuitDeps {
  setQuitting: () => void; // makes the close handler let the window close
  stopQueue: () => Promise<void>; // TriageQueue.stop() + abortInFlight()
  /** [V2] B2: JobRunner.killAll() - every whisper / vendor-CLI job is killed BEFORE the supervised children stop. Optional so the
   *  v1 wiring compiles; V2-W2-01 passes it. */
  killJobs?: () => Promise<void>;
  drainExecutor: (ms: number) => Promise<void>; // ActionExecutor.drain()
  stopChildren: (opts: { graceMs: number }) => Promise<void>; // Supervisor.stopAll() : llama, calendar-mcp, bridge
  writeLastOnline: () => void; // meta.last_online_ts (backlog gate)
  closeDb: () => void;
  destroyTray: () => void;
  exit: () => void; // app.exit(0)
  log: Logger;
  timeoutMs: number; // hard cap for the whole sequence (then exit anyway)
}

/** ARCHITECTURE 13: wait up to 5 s for actions in `executing`, then stop the children with a 3 s grace period. */
export const QUIT_DRAIN_MS = 5_000;
export const QUIT_CHILD_GRACE_MS = 3_000;

/** Pure order: setQuitting -> stopQueue -> [V2] killJobs -> drainExecutor -> stopChildren -> writeLastOnline -> closeDb -> destroyTray
 *  -> exit. */
export async function runQuitSequence(deps: QuitDeps): Promise<void> {
  const log = deps.log.child('quit');
  let exited = false;
  const exitOnce = (reason: string): void => {
    if (exited) return;
    exited = true;
    log.info('exit', { reason });
    deps.exit();
  };
  /** One step never aborts the sequence: a stuck child must not keep the app alive. */
  const step = async (name: string, run: () => void | Promise<void>): Promise<void> => {
    try {
      await run();
    } catch {
      log.warn('step.failed', { step: name });
    }
  };

  deps.setQuitting();
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = globalThis.setTimeout(() => resolve('timeout'), deps.timeoutMs);
  });
  const sequence = (async (): Promise<'done'> => {
    await step('stopQueue', () => deps.stopQueue());
    const killJobs = deps.killJobs;
    if (killJobs !== undefined) await step('killJobs', () => killJobs());
    await step('drainExecutor', () => deps.drainExecutor(Math.min(QUIT_DRAIN_MS, deps.timeoutMs)));
    await step('stopChildren', () => deps.stopChildren({ graceMs: QUIT_CHILD_GRACE_MS }));
    await step('writeLastOnline', () => deps.writeLastOnline());
    await step('closeDb', () => deps.closeDb());
    await step('destroyTray', () => deps.destroyTray());
    return 'done';
  })();

  const outcome = await Promise.race([sequence, timeout]);
  if (timer !== undefined) globalThis.clearTimeout(timer);
  exitOnce(outcome);
}
