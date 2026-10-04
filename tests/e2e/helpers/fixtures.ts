// tests/e2e/helpers/fixtures.ts - the common L5 fixture (TESTS section 10; owner W2-03).
//
// Every launch: a fresh temp `--user-data-dir` under os.tmpdir(), the MINIMAL env (no cloud key of the developer's shell
// is ever inherited), `WCA_E2E=1`, renderer console errors collected (any error fails the spec), the side-effect ledger
// run after the spec, then a quit through the tray hook with a hard assertion that the Electron process and every child
// PID are gone. Nothing here starts a real bridge, a real model, a real MCP server or touches a real account.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import type { AppHealth } from '../../../src/shared/health.ts';
import type { TrayMenuItem } from '../../../src/main/app/tray.ts';
import type { DialogRecord } from '../../../src/main/app/autoDialog.ts';
import type { WcaTestFacade, WcaTrayClickId } from '../../../src/main/testSeams.ts';
import {
  assertE2eLedger,
  type CalendarCallRecord,
  type CreateEventRecord,
  type FakeJournalSource,
  type MediaRequestRecord,
  type SendRecord,
  type SurfaceCapture,
} from './ledger.ts';
import { FAKE_BRIDGE_TS, REPO_ROOT, SCREENS_DIR } from './paths.ts';

export { expect };

/** TESTS 10: the only variables an e2e Electron child inherits. */
const MINIMAL_ENV_KEYS = ['SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATH'] as const;
/** Windows needs these to spawn `taskkill` at all; none of them can carry a credential. */
const WINDOWS_ENV_KEYS = ['ComSpec', 'windir', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'] as const;

export function minimalEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [...MINIMAL_ENV_KEYS, ...WINDOWS_ENV_KEYS]) {
    const value = process.env[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * [V2] T2 10.0 / T9: variable-name prefixes an e2e Electron child NEVER receives, whatever a spec passes in `env` - a vendor
 * credential or a CLI config dir of the developer's shell must not be able to steer the app under test. (`minimalEnv()` is an
 * allow-list already; this is the explicit deny check on the final env, so a spec cannot re-introduce one by accident.)
 */
export const FORBIDDEN_ENV_PREFIXES = ['ANTHROPIC_', 'GEMINI_', 'GOOGLE_', 'CLAUDE_'] as const;

export function assertNoVendorEnv(env: Record<string, string>): void {
  const bad = Object.keys(env).filter((k) => FORBIDDEN_ENV_PREFIXES.some((p) => k.toUpperCase().startsWith(p)));
  if (bad.length > 0) throw new Error(`E2E: the launch env must not carry vendor variables (${bad.join(', ')})`);
}

/**
 * [V2] T2 10.0 / T9: the "fake home" every launch of a spec gets instead of the real profile. The developer PC has a signed-in
 * `claude.exe` under `%USERPROFILE%\.local\bin\` and CLI state under `%USERPROFILE%\.claude*` / `.gemini\` / `%APPDATA%\npm\`;
 * the app under test sees none of them: USERPROFILE, HOMEDRIVE/HOMEPATH, APPDATA and LOCALAPPDATA all point into the spec's
 * temp root. (TEMP/TMP stay the real temp dir: the spec root itself lives there.)
 */
export function fakeHomeEnv(fakeHome: string): Record<string, string> {
  const roaming = join(fakeHome, 'AppData', 'Roaming');
  const local = join(fakeHome, 'AppData', 'Local');
  mkdirSync(roaming, { recursive: true });
  mkdirSync(local, { recursive: true });
  return {
    USERPROFILE: fakeHome,
    HOMEDRIVE: fakeHome.slice(0, 2),
    HOMEPATH: fakeHome.slice(2),
    APPDATA: roaming,
    LOCALAPPDATA: local,
  };
}

// There is NO global console allow-list: every renderer console error fails the spec that produced it. The one entry
// this list used to carry ("Content Security Policy directive 'frame-ancestors' is ignored") can no longer be emitted -
// the `<meta>` tag now holds `META_CSP`, which drops the header-only directives (`src/main/app/protocol.ts`, see
// ops/agent-notes/repair-renderer-csp.md). A launch that deliberately provokes an error opts in per launch through
// `LaunchOptions.allowConsoleErrors` (app.spec's `connect-src` refusal); anything else is a finding, not an allow-list entry.

export interface LaunchOptions {
  /** Extra argv after `.` and `--user-data-dir=<dir>` (e.g. `--hidden`). */
  argv?: string[];
  /** Seam variables (TESTS 4.2). `WCA_E2E` is always added. */
  env?: Record<string, string>;
  /** Override the profile directory (relaunch on the SAME profile, orphan reaping, single-instance scenarios). */
  userDataDir?: string;
  /** `false` when the launch is expected to start hidden (`--hidden`). */
  expectWindow?: boolean;
  /** Console-error substrings this launch is allowed to produce (e.g. the deliberate CSP violation of app.spec). */
  allowConsoleErrors?: string[];
  /**
   * `false` when this launch is not expected to reach the end of its start-up. Otherwise the fixture waits for
   * `globalThis.__wcaTest`, which the main process installs as the LAST step of `whenReady` - i.e. it is the app's own
   * "fully started" signal, and spawning a child bridge delays it. (An instance that is designed to exit at once, such
   * as a second launch on a held single-instance lock, cannot go through `launch()` at all - see `spawnRaw`.)
   */
  waitForHooks?: boolean;
}

export interface LaunchedApp {
  app: ElectronApplication;
  /** The first BrowserWindow, or null when the launch was expected not to show one. */
  page: Page | null;
  userDataDir: string;
  pid: number;
  consoleErrors: string[];
  closed: boolean;
  /** Exit code of the Electron process, once it has exited (a clean Quit is 0). */
  exitCode: number | null;
  /** [V2] every job pid (`__wcaTest.jobPids()`, cli + voice) this launch was seen running - each must be dead within 10 s of quit. */
  jobPidsSeen: Set<number>;
  /** [V2] T2 8.1 rule 12: the user-visible surfaces captured just before the quit (toasts, tray labels, window title). */
  surfaces: SurfaceCapture | null;
  /** Real time (spec process) at which this launch was asked for. */
  launchedAtReal: number;
  /**
   * [V2] `WCA_NOW` launches: app clock - real clock. The app's clock is BASED at WCA_NOW when its main module loads and then
   * advances in real time, so every timestamp it writes (approved_at, audit ts) is "real + offset", while the fakes journal REAL
   * time. The offset is measured against the Electron process start (`Date.now() - process.uptime()`), which precedes the module
   * load by a few hundred ms at most - so a fake timestamp mapped into app time is at most that much LATE, never early.
   * 0 for a launch without WCA_NOW.
   */
  clockOffsetMs: number;
}

/**
 * The `globalThis.__wcaTest` facade of TESTS 4.2 + T2 4.2, reached through `app.evaluate`. It mirrors `WcaTestFacade` of
 * `src/main/testSeams.ts` member for member (the frozen facade `installTestHooks()` builds: the eight v1 hooks, the three
 * v2 reads `dialogs` / `consoles` / `jobPids`, and `trayClick` widened by `'autoPause'` - nothing else: no `notify`, no
 * token, no approve / undo function), so a hook that disappears from the product side is a type error here rather than a
 * runtime surprise.
 */
export type WcaTest = {
  [K in keyof WcaTestFacade]: K extends 'trayTemplate'
    ? () => Promise<TrayMenuItem[]>
    : (...args: Parameters<WcaTestFacade[K]>) => Promise<ReturnType<WcaTestFacade[K]>>;
};

type HookBag = Record<string, ((...args: never[]) => unknown) | undefined>;

/** Calls one hook of the installed facade by its frozen name; a missing hook is an error, never a silent fallback. */
export function wca(app: ElectronApplication): WcaTest {
  const read = <T>(name: keyof WcaTestFacade): Promise<T> =>
    app.evaluate((_electronApi, hook) => {
      const bag = (globalThis as unknown as { __wcaTest?: Record<string, () => unknown> }).__wcaTest ?? {};
      const fn = bag[hook];
      if (typeof fn !== 'function') throw new Error(`__wcaTest.${hook} is not installed`);
      return fn() as unknown;
    }, name) as Promise<T>;

  const trayClick = (id: WcaTrayClickId): Promise<void> =>
    app.evaluate(
      (_electronApi, payload) => {
        const bag = (globalThis as unknown as { __wcaTest?: Record<string, (a: unknown) => void> }).__wcaTest ?? {};
        const fn = bag.trayClick;
        if (typeof fn !== 'function') throw new Error('__wcaTest.trayClick is not installed');
        fn(payload.id);
      },
      { id },
    );

  return {
    trayTemplate: () => read<TrayMenuItem[]>('trayTemplate'),
    trayClick,
    trayState: () => read<{ icon: string; tooltip: string }>('trayState'),
    doorbellUrl: () => read<string>('doorbellUrl'),
    health: () => read<AppHealth>('health'),
    notifications: () => read<Array<{ title: string; body: string; actions: string[] }>>('notifications'),
    openedExternal: () => read<string[]>('openedExternal'),
    childPids: () => read<Record<string, number>>('childPids'),
    // ---- [V2] T2 4.2 ----
    dialogs: () => read<DialogRecord[]>('dialogs'),
    consoles: () => read<string[][]>('consoles'),
    jobPids: () => read<Record<'cli' | 'voice', number[]>>('jobPids'),
  };
}

/**
 * Waits until the main process finished `whenReady` and installed `globalThis.__wcaTest`. In child-bridge mode the
 * install happens after `runtime.start()` has spawned the children, so it can be several seconds after the first paint.
 */
export async function waitForTestHooks(app: ElectronApplication, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const installed = await app
      .evaluate(() => typeof (globalThis as unknown as { __wcaTest?: unknown }).__wcaTest === 'object')
      .catch(() => false);
    if (installed) return;
    if (Date.now() > deadline)
      throw new Error('E2E: globalThis.__wcaTest was never installed (app did not finish start-up)');
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** True when the main process installed any of the given hooks on `globalThis.__wcaTest`. */
export async function hasHook(app: ElectronApplication, ...names: Array<keyof WcaTestFacade>): Promise<boolean> {
  return app.evaluate((_electronApi, wanted) => {
    const bag = (globalThis as unknown as { __wcaTest?: HookBag }).__wcaTest ?? {};
    return wanted.some((n) => typeof (bag as Record<string, unknown>)[n] === 'function');
  }, names);
}

/** `<userData>\run\*.pid.json` - the Supervisor's own record of every child it started. */
export function readChildPids(userDataDir: string): Record<string, number> {
  const runDir = join(userDataDir, 'run');
  const out: Record<string, number> = {};
  let names: string[];
  try {
    names = readdirSync(runDir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.pid.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(runDir, name), 'utf8')) as { pid?: unknown };
      if (typeof parsed.pid === 'number') out[name.replace(/\.pid\.json$/, '')] = parsed.pid;
    } catch {
      /* a half-written pid file is not a child we can assert on */
    }
  }
  return out;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

export function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** `WCA_BRIDGE_CMD` (child mode): the system node runs the fake bridge and the pin is node.exe's own hash (TESTS 4.2). */
export function bridgeCmdSeam(controlPort: number, controlSecret: string, scenario?: string): string {
  return JSON.stringify({
    command: process.execPath,
    args: [
      FAKE_BRIDGE_TS,
      '--control-port',
      String(controlPort),
      '--control-secret',
      controlSecret,
      ...(scenario === undefined ? [] : ['--scenario', scenario]),
    ],
    sha256: sha256File(process.execPath),
  });
}

/** POST one of the fake bridge's child-mode control verbs (`inbound`, `setPairing`, `exit`, ...). */
export async function control(
  port: number,
  secret: string,
  verb: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}/__control/${verb}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Control-Secret': secret },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`control ${verb} -> HTTP ${res.status}`);
  const text = await res.text();
  return text === '' ? null : (JSON.parse(text) as unknown);
}

/**
 * True once SOMETHING answers HTTP on the fake bridge's control port. The probe verb `ping` does not exist, so the fake
 * answers 404 without touching any state - the socket is what is being tested, not the verb. A refused or reset
 * connection (no child, or a child that is still booting) is `false`.
 */
export async function controlReachable(port: number, secret: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__control/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Control-Secret': secret },
      body: '{}',
    });
    await res.arrayBuffer(); // drain, so the keep-alive socket is released
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits until the fake bridge child's control server answers again. The control server lives INSIDE the child
 * (`tests/fakes/fake-bridge.ts`, `runChildMode`), so every product-side restart of the bridge - `pairing:newCode` ->
 * `restartForNewCode()` = stop + start (`src/main/compose.ts`, `bridgeControl`) - kills it and brings it back on the
 * same port a moment later. A spec that drives the restarted child must wait here first, or its next `control()` dies
 * with ECONNREFUSED / ECONNRESET.
 */
export async function waitForControl(port: number, secret: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await controlReachable(port, secret)) return;
    if (Date.now() > deadline) {
      throw new Error(`E2E: the fake bridge control server on 127.0.0.1:${port} did not answer within ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The Electron executable Playwright itself launches (`require('electron/index.js')` from the repo root). */
export function electronExecutable(): string {
  const resolved: unknown = createRequire(join(REPO_ROOT, 'package.json'))('electron/index.js');
  if (typeof resolved !== 'string' || resolved === '') throw new Error('E2E: electron/index.js did not yield a path');
  return resolved;
}

/** A launch that was NOT attached to Playwright: only its process identity and its exit are observable. */
export interface RawInstance {
  pid: number;
  /** Exit code once the process has exited; null while it runs. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Everything the process wrote to stderr (diagnostics when an exit code is not what a spec expected). */
  stderr: string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * [V2] T2 10.0 after-spec check: no `job-*.pid.json` in `run\` (the JobRunner removes its pid file when a job ends), and the per-run
 * work dirs are gone - `cli-runs\` (a fresh empty cwd per Claude job) and `agy-workspace\runs\` (one dir per agy job) must be empty.
 */
export function jobDirLeaks(userDataDir: string): string[] {
  const leaks: string[] = [];
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const jobPidFiles = list(join(userDataDir, 'run')).filter((n) => /^job-.*\.pid\.json$/i.test(n));
  if (jobPidFiles.length > 0) leaks.push(`job pid files left in run\\ (${jobPidFiles.length})`);
  const cliRuns = list(join(userDataDir, 'cli-runs'));
  if (cliRuns.length > 0) leaks.push(`cli-runs\\ is not empty (${cliRuns.length} entries)`);
  const agyRuns = list(join(userDataDir, 'agy-workspace', 'runs'));
  if (agyRuns.length > 0) leaks.push(`agy-workspace\\runs\\ is not empty (${agyRuns.length} entries)`);
  return leaks;
}

/** [V2] T2 8.1 rule 12: what a user (or another process) can see of the running app - captured just before the quit. */
async function captureSurfaces(launched: LaunchedApp): Promise<SurfaceCapture | null> {
  if (launched.closed) return null;
  try {
    const hooks = wca(launched.app);
    const toasts = await hooks.notifications();
    const tray = await hooks.trayTemplate();
    const labels = tray.map((i) => (typeof i.label === 'string' ? i.label : '')).filter((l) => l !== '');
    const titles = await launched.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => w.getTitle()),
    );
    const tooltip = (await hooks.trayState()).tooltip;
    return { toasts, trayLabels: [...labels, tooltip], windowTitles: titles };
  } catch {
    return null;
  }
}

/** The per-spec context: temp dirs, launches, fakes and everything the ledger needs afterwards. */
export class E2eContext {
  readonly root: string;
  /** [V2] T2 10.0: the temp "fake home" (USERPROFILE / HOMEDRIVE+HOMEPATH / APPDATA / LOCALAPPDATA) of every launch of this spec. */
  readonly fakeHome: string;
  readonly launches: LaunchedApp[] = [];
  readonly sends: SendRecord[] = [];
  readonly createEvents: CreateEventRecord[] = [];
  /** [V2] every tool call any fake calendar of this spec received (ledger rules 6-9), with its create-event / update-event args. */
  readonly calendarCalls: CalendarCallRecord[] = [];
  /** [V2] every `/api/media` request any fake bridge of this spec served (ledger rule 10). */
  readonly mediaRequests: MediaRequestRecord[] = [];
  /** [V2] every fake CLI / whisper journal of this spec (ledger rule 11: all entries violation-free). */
  readonly journals: FakeJournalSource[] = [];
  readonly violations: string[] = [];
  readonly sentinels: string[] = [];
  private profileSeq = 0;
  private readonly stoppers: Array<() => Promise<void> | void> = [];

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), 'wca-e2e-'));
    // T2 T11: a scrubbed capture may only name a user profile called `wca-fake-home` - so that is the fake home's name.
    this.fakeHome = join(this.root, 'wca-fake-home');
    mkdirSync(this.fakeHome, { recursive: true });
  }

  /** A fresh profile directory INSIDE os.tmpdir() (the app must refuse any other location in e2e mode). */
  newProfileDir(label = 'profile'): string {
    this.profileSeq += 1;
    const dir = join(this.root, `${label}-${this.profileSeq}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** A scratch file (stub-llm script, MCP seed/journal, model manifest) under the spec's temp root. */
  writeTempFile(name: string, content: string): string {
    const file = join(this.root, name);
    writeFileSync(file, content, 'utf8');
    return file;
  }

  onStop(fn: () => Promise<void> | void): void {
    this.stoppers.push(fn);
  }

  /** The argv, cwd and env EVERY launch hands Electron - `launch()` and `spawnRaw()` share this by construction. */
  private launchSpec(
    opts: LaunchOptions,
    userDataDir: string,
  ): { args: string[]; cwd: string; env: Record<string, string> } {
    const env = { ...minimalEnv(), ...fakeHomeEnv(this.fakeHome), WCA_E2E: '1', ...(opts.env ?? {}) };
    assertNoVendorEnv(env);
    return {
      args: ['.', `--user-data-dir=${userDataDir}`, ...(opts.argv ?? [])],
      cwd: REPO_ROOT,
      env,
    };
  }

  async launch(opts: LaunchOptions = {}): Promise<LaunchedApp> {
    const userDataDir = opts.userDataDir ?? this.newProfileDir();
    mkdirSync(userDataDir, { recursive: true });
    const app = await electron.launch({ ...this.launchSpec(opts, userDataDir), timeout: 60_000 });
    const consoleErrors: string[] = [];
    const allow = opts.allowConsoleErrors ?? [];
    const record = (text: string): void => {
      if (!allow.some((a) => text.includes(a))) consoleErrors.push(text);
    };
    app.on('window', (page) => {
      page.on('console', (msg) => {
        if (msg.type() === 'error') record(msg.text());
      });
      page.on('pageerror', (err) => record(`pageerror: ${err.message}`));
    });
    const launched: LaunchedApp = {
      app,
      page: null,
      userDataDir,
      pid: app.process().pid ?? 0,
      consoleErrors,
      closed: false,
      exitCode: null,
      jobPidsSeen: new Set<number>(),
      surfaces: null,
      launchedAtReal: Date.now(),
      clockOffsetMs: 0,
    };
    const seamNow = opts.env?.WCA_NOW;
    if (seamNow !== undefined) {
      const processStartReal = await app.evaluate(() => Date.now() - process.uptime() * 1000);
      launched.clockOffsetMs = Date.parse(seamNow) - processStartReal;
    }
    app.on('close', () => {
      launched.closed = true;
    });
    // `app.process()` is unusable once Playwright has torn the connection down, so the code is captured while it lives.
    app.process().on('exit', (code) => {
      launched.exitCode = code;
    });
    this.launches.push(launched);
    if (opts.expectWindow !== false) {
      launched.page = await app.firstWindow({ timeout: 30_000 });
      await launched.page.waitForSelector('[data-testid="app"]', { timeout: 30_000 });
    }
    if (opts.waitForHooks !== false) await waitForTestHooks(app, 60_000);
    return launched;
  }

  /**
   * Starts the app as a plain child process - the SAME executable Playwright launches, the same argv, cwd and minimal
   * env as `launch()` - without attaching Playwright to it. This is the only way to model an instance that is designed
   * to exit at once: `src/main/index.ts` takes `app.requestSingleInstanceLock()` and a second instance on the same
   * profile calls `app.quit()` within milliseconds, before Playwright could finish attaching over the inspector and
   * DevTools websockets (`electron.launch` then fails with "Target page, context or browser has been closed").
   * Only the exit is observable here; the spec asserts on the exit code and on what the FIRST instance did in response.
   * A raw instance that is still alive on dispose is killed (it is never a leak the ledger could explain).
   */
  spawnRaw(opts: LaunchOptions & { userDataDir: string }): RawInstance {
    const spec = this.launchSpec(opts, opts.userDataDir);
    const child = spawn(electronExecutable(), spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    const raw: RawInstance = {
      pid: child.pid ?? 0,
      exitCode: null,
      signal: null,
      stderr: '',
      exited: new Promise((resolve) => {
        child.once('exit', (code, signal) => {
          raw.exitCode = code;
          raw.signal = signal;
          resolve({ code, signal });
        });
      }),
    };
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (raw.stderr.length < 64_000) raw.stderr += chunk;
    });
    child.once('error', (err) => {
      raw.stderr += `\nspawn error: ${err.message}`;
    });
    this.onStop(() => {
      if (raw.exitCode === null && raw.signal === null && raw.pid > 0 && isAlive(raw.pid)) {
        try {
          process.kill(raw.pid);
        } catch {
          /* already gone */
        }
      }
    });
    return raw;
  }

  /** Quits through the tray hook and asserts the Electron process AND every child PID are gone within 10 s. */
  async quit(launched: LaunchedApp): Promise<void> {
    if (launched.closed) return;
    const childPids = readChildPids(launched.userDataDir);
    // [V2] T2 10.0 / 8.1 rule 12: while the app still runs, record its live job pids and the surfaces a user can see.
    await this.noteJobPids(launched);
    launched.surfaces = await captureSurfaces(launched);
    try {
      await wca(launched.app).trayClick('quit');
    } catch {
      // No tray hook (or the app is already tearing down): fall back to Playwright's own close.
      await launched.app.close().catch(() => undefined);
    }
    const closed = await launched.app
      .waitForEvent('close', { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    launched.closed = true;
    const leaks: string[] = [];
    if (!closed && launched.pid > 0 && !(await waitUntilGone(launched.pid, 5_000))) {
      leaks.push(`electron pid ${launched.pid} survived the quit`);
      try {
        process.kill(launched.pid);
      } catch {
        /* last resort */
      }
    }
    for (const [name, pid] of Object.entries(childPids)) {
      if (!(await waitUntilGone(pid, 10_000))) {
        leaks.push(`child ${name} (pid ${pid}) survived the quit`);
        try {
          process.kill(pid);
        } catch {
          /* last resort */
        }
      }
    }
    // [V2] T2 10.0: every job pid the spec saw (vendor-CLI / whisper fakes run as JobRunner jobs) is dead within 10 s of quit.
    for (const pid of launched.jobPidsSeen) {
      if (!(await waitUntilGone(pid, 10_000))) {
        leaks.push(`job pid ${pid} survived the quit`);
        try {
          process.kill(pid);
        } catch {
          /* last resort */
        }
      }
    }
    const leftover = readChildPids(launched.userDataDir);
    if (Object.keys(leftover).length > 0) {
      leaks.push(`pid files left in run\\: ${Object.keys(leftover).join(', ')}`);
    }
    leaks.push(...jobDirLeaks(launched.userDataDir));
    if (leaks.length > 0) throw new Error(`E2E quit leak: ${leaks.join('; ')}`);
  }

  /**
   * [V2] Records the job pids the app reports right now (`__wcaTest.jobPids()`). `quit()` calls it once more before quitting; a spec
   * that wants a short-lived job covered calls it while the job runs. A launch without the v2 hooks (tearing down) records nothing.
   */
  async noteJobPids(launched: LaunchedApp): Promise<Record<'cli' | 'voice', number[]>> {
    const empty = { cli: [], voice: [] };
    if (launched.closed) return empty;
    try {
      const pids = await wca(launched.app).jobPids();
      for (const pid of [...pids.cli, ...pids.voice]) launched.jobPidsSeen.add(pid);
      return pids;
    } catch {
      return empty;
    }
  }

  /** Hard kill (orphan-reaping scenario): no quit sequence runs, so the children stay behind on purpose. */
  async hardKill(launched: LaunchedApp): Promise<void> {
    if (launched.closed) return;
    try {
      process.kill(launched.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    launched.closed = true;
    await new Promise((r) => setTimeout(r, 500));
  }

  /** TESTS 9: named screenshot for the user's manual Hebrew review; never pixel-compared. */
  async screenshot(page: Page, name: string): Promise<void> {
    mkdirSync(SCREENS_DIR, { recursive: true });
    await page.screenshot({ path: join(SCREENS_DIR, `${name}.png`) });
  }

  async dispose(): Promise<void> {
    const problems: string[] = [];
    for (const launched of this.launches) {
      try {
        await this.quit(launched);
      } catch (e) {
        problems.push(String((e as Error).message));
      }
      if (launched.consoleErrors.length > 0) {
        problems.push(`renderer console errors: ${launched.consoleErrors.slice(0, 5).join(' | ')}`);
      }
    }
    for (const stop of this.stoppers.reverse()) {
      try {
        await stop();
      } catch {
        /* a fake that is already stopped is fine */
      }
    }
    // One ledger run per PROFILE (a relaunch on the same userData is one profile); a fake record tagged with another profile's
    // userData is that profile's business, an untagged one is checked against every profile (the v1 behaviour).
    const profiles = new Map<string, LaunchedApp[]>();
    for (const launched of this.launches) {
      const key = launched.userDataDir.toLowerCase();
      profiles.set(key, [...(profiles.get(key) ?? []), launched]);
    }
    for (const group of profiles.values()) {
      const userDataDir = group[0]!.userDataDir;
      // [V2] fake journals carry REAL time; the profile's rows carry APP time (WCA_NOW) - map each record into the clock of the
      // launch that was running when it happened.
      const toAppTime = (at: number): number => {
        const running = [...group].reverse().find((l) => l.launchedAtReal <= at) ?? group[0]!;
        return at + running.clockOffsetMs;
      };
      const mine = <T extends { userDataDir?: string; at?: number }>(rows: T[]): T[] =>
        rows
          .filter((r) => r.userDataDir === undefined || r.userDataDir.toLowerCase() === userDataDir.toLowerCase())
          .map((r) => (typeof r.at === 'number' ? { ...r, at: toAppTime(r.at) } : r));
      try {
        assertE2eLedger({
          userDataDir,
          sends: mine(this.sends),
          createEvents: mine(this.createEvents),
          calendarCalls: mine(this.calendarCalls),
          mediaRequests: mine(this.mediaRequests),
          journals: mine(this.journals),
          violations: this.violations,
          sentinels: this.sentinels,
          surfaces: group.map((l) => l.surfaces).filter((s): s is SurfaceCapture => s !== null),
        });
      } catch (e) {
        problems.push(String((e as Error).message));
      }
    }
    // `E2E_KEEP_TMP=1` (set in the RUNNER's shell, never inherited by the app - see MINIMAL_ENV_KEYS) keeps the spec's
    // temp root for a post-mortem: `<root>\<profile>\app.db` and `<root>\<profile>\logs\` are the only record of what
    // the app did once a launch is gone. Off by default so a green run leaves nothing behind.
    if (process.env.E2E_KEEP_TMP === '1') {
      console.warn(`E2E_KEEP_TMP=1: temp root kept at ${this.root}`);
    } else {
      try {
        rmSync(this.root, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* Windows keeps a handle for a moment after a child dies; the temp root is disposable anyway */
      }
    }
    if (problems.length > 0) throw new Error(problems.join('\n'));
  }
}

export const test = base.extend<{ e2e: E2eContext }>({
  // No browser fixture is requested anywhere in this suite: `_electron` is the only Playwright driver we use, so
  // `npx playwright install` is never needed (TESTS 2.2).
  // eslint-disable-next-line no-empty-pattern
  e2e: async ({}, use) => {
    const ctx = new E2eContext();
    await use(ctx);
    await ctx.dispose();
  },
});
