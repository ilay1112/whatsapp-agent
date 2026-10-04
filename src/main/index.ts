// src/main/index.ts - Electron main entry (owner W2-01). Thin by design: every capability is wired in compose.ts.
// ESM main: protocol.registerSchemesAsPrivileged and requestSingleInstanceLock run at module top level BEFORE any top-level await.
import { app, clipboard, dialog, ipcMain, nativeImage, Notification, safeStorage, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import electronLog from 'electron-log/main';
import nodeFs from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { registerAppProtocol, registerAppSchemes } from './app/protocol';
import {
  createMainWindow,
  createRendererRecovery,
  installCloseToTray,
  installTrayHintCoachMark,
  isHiddenStart,
} from './app/window';
import { createTray, type TrayController } from './app/tray';
import { configureElectronLog, createLogger, type ElectronLogLike } from './logger';
import { createPaths } from './paths';
import { createWindowsProcessQuery } from './proc/reaper';
import { compose, type AppRuntimeEvent, type AppRuntimeHandle } from './compose';
import { registerIpc } from './ipc/register';
import { createIpcSender } from './ipc/sender';
import { trayIconFor } from './app/tray';
import type {
  Clock,
  ClockTimer,
  ElectronFacade,
  ImageFacade,
  ImageHandle,
  RandomSource,
  ShowMessageBoxFn,
} from './deps';
import type { Seams, WcaTestHooks, WcaTestHooksV2 } from './testSeams';
import type { LlmProvider } from './llm/types';
import type { IpcEvent, IpcEventMap } from '../shared/ipc';
import type { ProviderId } from '../shared/types';

const here = dirname(fileURLToPath(import.meta.url)); // out/main ; the project path contains a space: never URL.pathname

// Module top level, before any `await` (ARCHITECTURE section 3).
registerAppSchemes();
app.setAppUserModelId('com.ilay.whatsapp-calendar-agent');

// Build-time lock (TESTS 4.1): a production build constant-folds this whole branch away, so out/main contains no seam code.
let seams: Seams | null = null;
let installTestHooks: ((hooks: WcaTestHooks, v2?: Partial<WcaTestHooksV2>) => void) | null = null;
/** TESTS 4.2 `WCA_LLM` / `WCA_LLM_SCRIPT`, reaching the real ProviderFactory through `ComposeDeps.providerOverride`. */
let providerOverride: ((id: ProviderId) => LlmProvider | null) | undefined;
if (import.meta.env.MODE === 'e2e') {
  const testSeams = await import('./testSeams');
  seams = testSeams.readSeams({
    env: process.env,
    argv: process.argv,
    isPackaged: app.isPackaged,
    mode: import.meta.env.MODE,
    appPath: app.getAppPath(), // [V2] T2 4.1: WCA_CLI_CMD / WCA_WHISPER_CMD must point into <appPath>\tests\fakes\
  });
  installTestHooks = testSeams.installTestHooks;
  if (seams?.userDataDir) app.setPath('userData', seams.userDataDir);
  if (seams !== null && seams.llm !== undefined) {
    // The scripted provider ships inside the e2e BUNDLE (src/main/llm/scripted.fixtures.ts): importing a fake from
    // tests/** would not exist at run time in out/main. Consent and key rules still run first - the factory only asks
    // for the seam after `assertConsent` and the key lookup have passed.
    const { createScriptedProvider } = await import('./llm/scripted.fixtures');
    const mode = seams.llm;
    const scriptPath = seams.llmScript;
    providerOverride = (id: ProviderId): LlmProvider =>
      createScriptedProvider({ id, mode, ...(scriptPath === undefined ? {} : { scriptPath }) });
  }
}

// [REPAIR] The lock is taken in e2e mode too: it is per-`userData`, and every e2e launch already gets its own temp
// profile, so honouring it cannot make specs collide - while bypassing it let two full instances write one `app.db`.
const gotLock = app.requestSingleInstanceLock();

/** AppRuntimeEvent -> the renderer channel it is pushed on. */
const EVENT_CHANNEL: Readonly<Record<AppRuntimeEvent, IpcEvent>> = {
  health: 'health:changed',
  dashboard: 'dashboard:changed',
  pairing: 'pairing:changed',
  google: 'google:changed',
  model: 'model:progress',
  language: 'ui:languageChanged',
  navigate: 'ui:navigate',
  // [V2] C2 8 push events
  'auto:changed': 'auto:changed',
  'cli:changed': 'cli:changed',
  'queue:changed': 'queue:changed',
  'voice:progress': 'voice:progress',
};

/** [V2] S-IMAGE: Electron's nativeImage behind the injected facade (media/normalizeImage.ts never imports electron). */
function imageHandleOf(img: Electron.NativeImage): ImageHandle {
  return {
    isEmpty: () => img.isEmpty(),
    getSize: () => img.getSize(),
    resize: (o) => imageHandleOf(img.resize(o)),
    toJPEG: (quality) => new Uint8Array(img.toJPEG(quality)),
  };
}
const nativeImageFacade: ImageFacade = {
  fromBuffer: (bytes) =>
    imageHandleOf(nativeImage.createFromBuffer(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))),
};

// TESTS 4.2 `WCA_NOW`: the injected clock is BASED at the given instant and advances in real time from there, so a
// weekday table or a "Thursday at 5" resolves identically on any day. `seamNow` is undefined in production.
const seamNow = seams?.now;
const bootRealMs = Date.now();

const realClock: Clock = {
  now: () => (seamNow === undefined ? Date.now() : seamNow + (Date.now() - bootRealMs)),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as ClockTimer,
  clearTimeout: (t) => globalThis.clearTimeout(t as ReturnType<typeof globalThis.setTimeout>),
};

const realRandom: RandomSource = {
  bytes: (n) => new Uint8Array(randomBytes(n)),
  int: (min, max) => randomInt(min, max),
  float: () => randomInt(0, 2 ** 30) / 2 ** 30,
};

if (!gotLock) {
  app.quit();
} else {
  let runtime: AppRuntimeHandle | null = null;
  let win: BrowserWindow | null = null;
  let tray: TrayController | null = null;
  let quitting = false;
  let trayHintPending = false;
  /** The notifier the facade forwards toast clicks to; set once the runtime exists. */
  let onToastClick: (() => void) | null = null;

  const killAllSync = (): void => {
    try {
      runtime?.killAllSync();
    } catch {
      /* best effort on the way out */
    }
  };

  app.on('second-instance', () => {
    if (win !== null && !win.isDestroyed()) {
      if (!win.isVisible()) win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    electronLog.initialize();

    const paths = createPaths({
      userData: app.getPath('userData'),
      resourcesPath: process.resourcesPath,
      appRoot: app.getAppPath(),
      isPackaged: app.isPackaged,
    });
    nodeFs.mkdirSync(paths.logsDir, { recursive: true });
    const sink = configureElectronLog(electronLog as unknown as ElectronLogLike, {
      logsDir: paths.logsDir,
      fs: nodeFs,
    });
    const log = createLogger({ logsDir: paths.logsDir, sink });

    // TESTS 4.2, last row: in e2e mode `shell.openExternal` and `Notification` are REPLACED by recorders, so no browser
    // window and no Windows toast can appear during a test run (a spec may click "Sign in with Google" safely). The
    // whole branch is constant-folded away in a production build.
    const recordSideEffects = import.meta.env.MODE === 'e2e' && seams !== null;
    const openedExternal: string[] = [];
    const notifications: Array<{ title: string; body: string; actions?: string[] }> = [];

    const electronFacade: ElectronFacade = {
      safeStorage: {
        isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
        // Async encrypt (W1-12: createSecretStore awaits it); synchronous decrypt so `has().last4` is exact from the first read.
        encryptString: ((plain: string) => safeStorage.encryptStringAsync(plain)) as unknown as (
          plain: string,
        ) => Buffer,
        decryptString: (cipher: Buffer) => safeStorage.decryptString(cipher),
      },
      openExternal: async (url) => {
        if (recordSideEffects) {
          openedExternal.push(url);
          return;
        }
        await shell.openExternal(url);
      },
      clipboardWrite: (text) => clipboard.writeText(text),
      showOpenDialog: async (opts) => {
        const res = await dialog.showOpenDialog({
          title: opts.title,
          filters: [...opts.filters],
          properties: ['openFile'],
        });
        const file = res.canceled ? undefined : res.filePaths[0];
        if (file === undefined) return null;
        const stat = await nodeFs.promises.stat(file);
        if (stat.size > opts.maxBytes) return null;
        return nodeFs.promises.readFile(file, 'utf8');
      },
      showSaveDialog: async (opts) => {
        const res = await dialog.showSaveDialog({ title: opts.title, defaultPath: opts.defaultFileName });
        return res.canceled || !res.filePath ? null : res.filePath;
      },
      notify: (title, body) => {
        if (recordSideEffects) {
          notifications.push({ title, body });
          return;
        }
        if (!Notification.isSupported()) return;
        const toast = new Notification({ title, body });
        // W1-12: ElectronFacade.notify has no click callback, so the facade forwards the click to the notifier.
        toast.on('click', () => onToastClick?.());
        toast.show();
      },
      setLoginItem: (opts) => app.setLoginItemSettings({ openAtLogin: opts.openAtLogin, args: [...opts.args] }),
      preferredLanguages: () => app.getPreferredSystemLanguages(),
    };

    // [V2] S-DIALOG: the main-owned native message box, parented to the focused main window (autoDialog checks focus first).
    const showMessageBox: ShowMessageBoxFn = async (parent, options) => {
      const owner = parent as BrowserWindow | null;
      const res =
        owner !== null && typeof owner === 'object' && !owner.isDestroyed()
          ? await dialog.showMessageBox(owner, { ...options, buttons: [...options.buttons] })
          : await dialog.showMessageBox({ ...options, buttons: [...options.buttons] });
      return { response: res.response, checkboxChecked: res.checkboxChecked };
    };
    // [V2] automatic-mode toasts with action buttons (Undo / Show); e2e records them (never a real toast during a test run).
    const notifyWithActions = (
      toast: { title: string; body: string; actions: string[] },
      onAction: (index: number) => void,
      onClick: () => void,
    ): void => {
      if (recordSideEffects) {
        notifications.push({ title: toast.title, body: toast.body, actions: [...toast.actions] });
        return;
      }
      if (!Notification.isSupported()) return;
      const n = new Notification({
        title: toast.title,
        body: toast.body,
        actions: toast.actions.map((text) => ({ type: 'button' as const, text })),
      });
      n.on('action', (_e, index) => onAction(index));
      n.on('click', () => onClick());
      n.show();
    };
    // [V2] cli:pickExe: the main-owned OPEN dialog returning the chosen PATH (never file text, never a renderer value)
    const pickExePath = async (opts: {
      title: string;
      filters: Array<{ name: string; extensions: string[] }>;
    }): Promise<string | null> => {
      const res = await dialog.showOpenDialog({
        title: opts.title,
        filters: [...opts.filters],
        properties: ['openFile'],
      });
      return res.canceled ? null : (res.filePaths[0] ?? null);
    };

    runtime = await compose({
      paths,
      clock: realClock,
      random: realRandom,
      logger: log,
      spawn: nodeSpawn,
      fetch: globalThis.fetch,
      processQuery: createWindowsProcessQuery({ spawn: nodeSpawn }),
      electron: electronFacade,
      seams,
      ...(providerOverride === undefined ? {} : { providerOverride }),
      isPackaged: app.isPackaged,
      version: app.getVersion(),
      execPath: process.execPath,
      preferredLanguages: () => app.getPreferredSystemLanguages(),
      image: nativeImageFacade,
      dialog: showMessageBox,
      notifyWithActions,
      pickExePath,
    });
    const rt = runtime;

    registerAppProtocol({ rendererDir: join(here, '../renderer') });

    // ---- IPC -------------------------------------------------------------------------------------------------------
    registerIpc(ipcMain, rt.handlers, {
      isTrusted: (event) => rt.isTrusted(event),
      windowState: () => rt.windowState(),
      audit: (kind, ref, detail, at) => rt.repos.audit.append(kind, ref, detail, at),
      now: () => realClock.now(),
      log,
    });

    // ---- window ----------------------------------------------------------------------------------------------------
    const sender = createIpcSender(() => (win === null || win.isDestroyed() ? null : win));
    const push = <E extends IpcEvent>(event: E, payload: IpcEventMap[E]): void => sender.send(event, payload);

    const buildWindow = (startHidden: boolean): BrowserWindow => {
      const created = createMainWindow({
        preloadPath: join(here, '../preload/index.cjs'),
        isPackaged: app.isPackaged,
        initial: rt.uiLanguage(),
        startHidden,
        log,
        // [REPAIR] The crashed window used to be left behind: a ghost that `installCloseToTray` could only hide, that
        // `attachWindow` no longer trusted, and that a crash-during-load rebuilt without limit - even mid-quit.
        // `createRendererRecovery` destroys it, honours `quitting` and caps the rebuilds.
        onRenderProcessGone: (reason) => {
          log.warn('render_process_gone', {});
          win = recovery.recover(created, reason);
          if (win === null) rt.attachWindow(null); // nothing to push to and nothing to trust any more
        },
      });
      installCloseToTray(created, {
        onFirstHide: () => {
          trayHintPending = true;
          rt.repos.meta.set('tray_hint_seen', '1');
        },
        trayHintSeen: () => rt.repos.meta.get('tray_hint_seen') === '1',
        isQuitting: () => quitting,
      });
      installTrayHintCoachMark(created, {
        pending: () => trayHintPending,
        onShow: () => {
          trayHintPending = false;
          push('ui:navigate', { view: 'tray_hint' });
        },
      });
      rt.attachWindow(created);
      created.on('focus', () => rt.noteFocus()); // [V2] B7 unattended pause
      return created;
    };

    // Owns the `render-process-gone` policy (ARCHITECTURE 14 "recreate window", main state intact). When the budget is
    // spent it logs `renderer.rebuild_limit` and stops: the app stays in the tray and Quit still works. The error table
    // gives this row no user-visible UI, so nothing is shown beyond the log / diagnostics export.
    const recovery = createRendererRecovery({
      build: buildWindow,
      isQuitting: () => quitting,
      now: () => realClock.now(),
      log,
      startHidden: isHiddenStart(process.argv),
    });
    win = recovery.start();

    // ---- push events -----------------------------------------------------------------------------------------------
    for (const key of Object.keys(EVENT_CHANNEL) as AppRuntimeEvent[]) {
      rt.on(key, (payload) => {
        sender.send(EVENT_CHANNEL[key], payload as IpcEventMap[IpcEvent]);
        // [REPAIR] 'language' too: compose() rebuilds its i18next instance and emits, but the tray menu, its status
        // line and its tooltip are built from `rt.t()` - without a rebuild they stayed in the OLD language after a
        // switch, which is a direct miss of the multilanguage requirement (UX 12.1).
        if (key === 'health' || key === 'pairing' || key === 'language' || key === 'auto:changed') tray?.rebuild();
      });
    }

    // ---- tray ------------------------------------------------------------------------------------------------------
    tray = createTray({
      iconsDir: paths.iconsDir,
      t: () => rt.t(),
      state: () => rt.trayState(),
      onOpen: () => {
        win?.show();
        win?.focus();
      },
      onTogglePause: () => {
        rt.togglePause();
        tray?.rebuild();
      },
      onSettings: () => {
        win?.show();
        win?.focus();
        push('ui:navigate', { view: 'settings' });
      },
      onQuit: () => {
        app.quit();
      },
      log,
      onAuto: (action) => {
        rt.trayAuto(action); // [V2] B11
        tray?.rebuild();
      },
    });

    onToastClick = () => {
      win?.show();
      win?.focus();
    };

    await rt.start();
    tray.rebuild();

    // TESTS 4.2: the FROZEN eight-hook facade of `testSeams.ts` - read-only except `trayClick`, and it carries no
    // token, no key, no approve function and no repo handle.
    if (import.meta.env.MODE === 'e2e' && seams !== null && installTestHooks !== null) {
      /** `<userData>\run\<name>.pid.json` is the Supervisor's own record of every child it started. */
      const childPids = (): Record<string, number> => {
        const out: Record<string, number> = {};
        let names: string[];
        try {
          names = nodeFs.readdirSync(paths.runDir);
        } catch {
          return out;
        }
        for (const name of names) {
          if (!name.endsWith('.pid.json')) continue;
          try {
            const parsed = JSON.parse(nodeFs.readFileSync(join(paths.runDir, name), 'utf8')) as { pid?: unknown };
            if (typeof parsed.pid === 'number') out[name.slice(0, -'.pid.json'.length)] = parsed.pid;
          } catch {
            /* a half-written pid file is not a child */
          }
        }
        return out;
      };
      installTestHooks(
        {
          trayTemplate: () => tray?.template() ?? [],
          trayClick: (id) => tray?.click(id),
          trayState: () => trayIconFor(rt.trayState(), rt.t()),
          doorbellUrl: () => rt.doorbellUrl() ?? '',
          health: () => rt.health(),
          notifications: () => notifications.map((n) => ({ ...n })),
          openedExternal: () => [...openedExternal],
          childPids,
        },
        {
          dialogs: () => rt.dialogs(),
          consoles: () => rt.consoles(),
          jobPids: () => rt.jobPids(),
          trayClickAutoPause: () => tray?.click('autoPause'),
        },
      );
    }
  });

  // ---- quit --------------------------------------------------------------------------------------------------------
  app.on('window-all-closed', () => {
    // Close-to-tray keeps the app alive on Windows; only an explicit Quit ends the process.
  });

  // ARCHITECTURE 13 order: setQuitting -> stopQueue -> drainExecutor -> stopChildren -> writeLastOnline -> closeDb
  // (all six inside `runtime.shutdown()`, which runs the real `runQuitSequence`) -> destroyTray -> exit.
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true; // makes installCloseToTray let the window close
    void (async () => {
      try {
        await runtime?.shutdown();
      } finally {
        tray?.destroy();
        killAllSync();
        app.exit(0);
      }
    })();
  });

  // The Windows-only session-end event is missing from the electron type overloads; it is the last chance to kill children.
  (app as unknown as { on(event: string, cb: () => void): void }).on('session-end', killAllSync);
  process.on('exit', killAllSync);
}
