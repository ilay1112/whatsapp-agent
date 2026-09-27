// tests/helpers/harness.ts - L3 integration harness around the PRODUCTION compose() (owner W0 types -> W2-01 body).
// Builds an AppRuntime with every fake wired in: fake bridge (in-process, attach mode), fake bridge DB, fake MCP calendar
// over InMemoryTransport, StubLlm / ObedientAttackerLlm, virtual clock, seeded random, temp userData under os.tmpdir(),
// electron mock facade. Because it is the real compose.ts, capability wiring is exercised exactly as shipped.
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import type { AppRuntime, AppRuntimeHandle } from '../../src/main/compose.ts';
import { compose } from '../../src/main/compose.ts';
import type { AppHealth } from '../../src/shared/health.ts';
import { IPC_CHANNELS, type IpcChannel, type IpcReq, type IpcRes, type IpcContext } from '../../src/shared/ipc.ts';
import type { Result, EpochMs, ProviderId, SecretName } from '../../src/shared/types.ts';
import { LIMITS, CONSENT_VERSIONS } from '../../src/shared/types.ts';
import type { Repos } from '../../src/main/db/index.ts';
import { createRepos, openDb } from '../../src/main/db/index.ts';
import { createPaths, type AppPaths } from '../../src/main/paths.ts';
import { createLogger } from '../../src/main/logger.ts';
import { registerIpc } from '../../src/main/ipc/register.ts';
import type { IpcEventLike } from '../../src/main/ipc/sender.ts';
import type { Clock, ClockTimer, ElectronFacade, ProcessInfo, ProcessQuery, SpawnFn } from '../../src/main/deps.ts';
import type { LlmProvider } from '../../src/main/llm/types.ts';

import type { VirtualClock } from './virtualClock.ts';
import { createSeededRandom, createVirtualClock } from './virtualClock.ts';
import { attachLedgerSources } from './ledger.ts';
import type { FakeBridge } from '../fakes/fake-bridge.ts';
import { startFakeBridge } from '../fakes/fake-bridge.ts';
import type { FakeBridgeDb } from '../fakes/fake-bridge-db.ts';
import type { FakeMcpCalendar } from '../fakes/fake-mcp-calendar.ts';
import { createFakeMcpCalendar } from '../fakes/fake-mcp-calendar.ts';
import type { StubRule } from '../fakes/stub-llm.ts';
import { StubLlm } from '../fakes/stub-llm.ts';
import { ObedientAttackerLlm, type InjectionCase } from '../fakes/obedient-attacker-llm.ts';
import { safeStorage as mockSafeStorage } from '../mocks/electron.ts';

export interface HarnessOptions {
  llm?: 'stub' | 'attacker';
  provider?: 'local' | 'claude' | 'gemini';
  /** Pre-seeded profile: consents, settings, onboarding step, paired_at. Default: everything accepted, onboarding 'done', paired now. */
  profile?: Partial<{ whatsappTos: boolean; cloudConsent: boolean; onboardingDone: boolean; paired: boolean }>;
  calendar?: 'connected' | 'not_configured';
  nowMs?: number;
  timeZone?: string;
  // ---- additive, W2-01: everything an L3 test has to be able to script ------------------------------------------
  /** Rules for the scripted provider (`llm: 'stub'`, the default). */
  rules?: StubRule[];
  /** Corpus for `llm: 'attacker'`. */
  corpus?: InjectionCase[];
  /** Seed events for the fake calendar. */
  events?: Parameters<typeof createFakeMcpCalendar>[0]['seedEvents'];
  /** Free/busy blocks the fake calendar reports. */
  busy?: Array<{ start: string; end: string }>;
  /** Settings overrides applied before `compose()` (e.g. `whatsapp.backlogHours`). */
  settings?: (s: import('../../src/shared/settings.ts').Settings) => void;
  /** Reuse an existing userData directory (crash-recovery tests re-create the app on the same files). */
  userData?: string;
  /** Initial pairing phase of the fake bridge. */
  pairing?: 'connected' | 'qr_pending' | 'connecting';
  /**
   * What the native save dialog returns (`ElectronFacade.showSaveDialog`). A string is the chosen path, `null` is a
   * cancelled dialog (the default), a function is called with the real `{title, defaultFileName}`. This is what lets
   * an L3 test drive `diagnostics:export` all the way to a written bundle.
   */
  saveDialog?:
    string | null | ((opts: { title: string; defaultFileName: string }) => string | null | Promise<string | null>);
  /**
   * `false` hands `runtime.start()` to the test instead of awaiting it here. Only a lifecycle test needs this: it is
   * the sole way to observe a quit that lands WHILE `start()` is still in flight (process-lifecycle-7).
   */
  autoStart?: boolean;
}

export interface Harness {
  runtime: AppRuntime;
  repos: Repos;
  clock: VirtualClock;
  bridge: FakeBridge;
  bridgeDb: FakeBridgeDb;
  calendar: FakeMcpCalendar;
  llm: StubLlm;
  userData: string;
  /** Invokes an IPC handler exactly as register.ts would (trusted sender, zod parse) with the given window state. */
  invoke<C extends IpcChannel>(channel: C, req: IpcReq<C>, ctx?: Partial<IpcContext>): Promise<Result<IpcRes<C>>>;
  health(): AppHealth;
  /** Fires the doorbell + lets ingest/queue run under the virtual clock until idle (bounded). */
  settle(): Promise<void>;
  /** Stops every child/fake, closes the DB, removes the temp userData. Always call in afterEach. */
  dispose(): Promise<void>;
  // ---- additive, W2-01 -------------------------------------------------------------------------------------------
  /** The full compose() handle (tray state, doorbell url, settings bus, ...). */
  app: AppRuntimeHandle;
  paths: AppPaths;
  /** The scripted provider as it really is (`ObedientAttackerLlm` when `llm: 'attacker'`). */
  provider: StubLlm | ObedientAttackerLlm;
  /** Every already-redacted log line the app produced. */
  logs: string[];
  /** Push events the runtime emitted, in order. */
  pushes: Array<{ event: string; payload: unknown }>;
  /** Advances the virtual clock and drains microtasks (no real sleeps - TESTS T7). */
  advance(ms: number): Promise<void>;
  /** Window state the next `invoke()` reports unless the call overrides it. */
  setWindowState(s: Partial<{ focused: boolean; visible: boolean }>): void;
  // ---- electron-facade recorders (the L3 twins of `__wcaTest.openedExternal` / `.notifications`) ------------------
  /** Every URL the app asked the shell to open, in order. */
  opened: string[];
  /** Every toast the app raised, in order. Never message text (UX 12.3 / ARCH 13). */
  notifications: Array<{ title: string; body: string }>;
  /** Every `showSaveDialog` the app opened, in order (scripted by `HarnessOptions.saveDialog`). */
  saveDialogCalls: Array<{ title: string; defaultFileName: string }>;
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_TZ = 'Asia/Jerusalem';
const DEFAULT_NOW = Date.UTC(2026, 8, 21, 9, 0, 0);
const BRIDGE_TOKEN = 'harness-bridge-token-0123456789abcdef';

/** Synthetic Google credentials (TESTS T5): never a real client id, never a real secret. */
const FAKE_CREDENTIALS = JSON.stringify({
  installed: {
    client_id: '000000000000-testonly0000000000000000000000.apps.googleusercontent.com',
    project_id: 'wca-testonly',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_secret: 'TESTONLY-client-secret',
    redirect_uris: ['http://localhost'],
  },
});

const SECRET_FOR: Readonly<Record<'claude' | 'gemini', SecretName>> = {
  claude: 'anthropic_api_key',
  gemini: 'gemini_api_key',
};
const TEST_KEY: Readonly<Record<'claude' | 'gemini', string>> = {
  claude: 'sk-ant-TESTONLY-0123456789abcdef',
  gemini: 'AIzaTESTONLY0123456789abcdefghijklmno',
};

/** A schema-valid `Extraction` with every field at its neutral value; spread it and override what a test cares about. */
export function extraction(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: 'other',
    needsReply: false,
    title: '',
    dateKind: 'none',
    isoDate: '',
    weekday: 0,
    weekOffset: 0,
    daysFromToday: 0,
    time24h: '',
    timeAmbiguous: false,
    durationMin: 0,
    location: '',
    missing: [],
    suspicious: false,
    ...over,
  };
}

/** Default S1/S3 script: nothing to schedule and a short draft, so an unscripted test never hangs on an unmatched call. */
const DEFAULT_RULES: StubRule[] = [
  { when: { purpose: 'extract' }, respond: { structured: extraction() } },
  { when: { purpose: 'draft' }, respond: { text: 'Sounds good.', stopReason: 'end' } },
];

/** A spawn that refuses: no L3 test may ever start a child process (TESTS T1). */
const refusingSpawn: SpawnFn = ((command: string) => {
  throw new Error(`harness: nothing may be spawned in an L3 test (tried: ${command})`);
}) as SpawnFn;

const noProcesses: ProcessQuery = {
  query: (): Promise<ProcessInfo | null> => Promise.resolve(null),
  kill: (): Promise<void> => Promise.resolve(),
};

function flush(): Promise<void> {
  return new Promise<void>((done) => setImmediate(done));
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const nowMs = opts.nowMs ?? DEFAULT_NOW;
  const timeZone = opts.timeZone ?? DEFAULT_TZ;
  const profile = {
    whatsappTos: opts.profile?.whatsappTos ?? true,
    cloudConsent: opts.profile?.cloudConsent ?? true,
    onboardingDone: opts.profile?.onboardingDone ?? true,
    paired: opts.profile?.paired ?? true,
  };
  const providerId: ProviderId = opts.provider ?? 'local';
  const calendarMode = opts.calendar ?? 'connected';

  const userData = opts.userData ?? mkdtempSync(join(tmpdir(), 'wca-l3-'));
  const resourcesDir = join(userData, 'resources');
  mkdirSync(resourcesDir, { recursive: true });
  const paths = createPaths({ userData, resourcesPath: resourcesDir, appRoot: REPO_ROOT, isPackaged: false });
  for (const dir of [
    paths.backupsDir,
    paths.logsDir,
    paths.runDir,
    paths.bridgeCwd,
    paths.bridgeStoreDir,
    paths.googleDir,
    paths.modelsDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const clock = createVirtualClock(nowMs);
  const random = createSeededRandom();
  const logs: string[] = [];
  const logger = createLogger({ logsDir: paths.logsDir, sink: (line) => logs.push(line), now: () => clock.now() });

  // ---- profile seeding: everything compose() reads at construction time must already be in app.db ------------------
  // Seeded once per userData directory. A RESTART (an app.db that already exists) is never re-seeded: a recovery test
  // must see exactly the database the crash left behind.
  if (!existsSync(paths.appDb)) {
    const db = openDb(paths.appDb);
    const repos = createRepos(db);
    const at = nowMs as EpochMs;
    if (profile.whatsappTos) repos.consents.accept('whatsapp_tos', CONSENT_VERSIONS.whatsapp_tos, at);
    if (profile.cloudConsent) {
      repos.consents.accept('cloud_claude', CONSENT_VERSIONS.cloud_claude, at);
      repos.consents.accept('cloud_gemini', CONSENT_VERSIONS.cloud_gemini, at);
    }
    repos.meta.set('onboarding_step', profile.onboardingDone ? 'done' : 'welcome');
    if (profile.paired) {
      repos.meta.set('paired_at', String(at));
      repos.meta.set('live_from_ts', String(at));
      repos.meta.set('last_online_ts', String(at));
    }
    repos.settings.setInternal((s) => {
      s.general.timeZone = timeZone;
      s.general.language = 'en';
      s.llm.provider = providerId;
      opts.settings?.(s);
    });
    if (providerId !== 'local') {
      const name = SECRET_FOR[providerId];
      repos.secrets.put(name, mockSafeStorage.encryptString(TEST_KEY[providerId]));
    }
    db.close();
  }

  if (calendarMode === 'connected') {
    writeFileSync(paths.googleCredentials, FAKE_CREDENTIALS, 'utf8');
    writeFileSync(paths.googleTokens, JSON.stringify({ personal: { access_token: 'TESTONLY' } }), 'utf8');
  }

  // ---- fakes ------------------------------------------------------------------------------------------------------
  const calendar = createFakeMcpCalendar({
    now: () => clock.now(),
    timeZone,
    accounts: 'personal_ok',
    ...(opts.events === undefined ? {} : { seedEvents: opts.events }),
  });
  await calendar.connect();
  if (opts.busy) calendar.setBusy(opts.busy);

  const provider: StubLlm | ObedientAttackerLlm =
    opts.llm === 'attacker'
      ? new ObedientAttackerLlm(opts.corpus ?? [], providerId)
      : new StubLlm({ id: providerId, rules: opts.rules ?? DEFAULT_RULES, clock });

  // ---- electron facade over the mock -------------------------------------------------------------------------------
  const notifications: Array<{ title: string; body: string }> = [];
  const opened: string[] = [];
  const saveDialogCalls: Array<{ title: string; defaultFileName: string }> = [];
  const electron: ElectronFacade = {
    safeStorage: {
      isEncryptionAvailable: () => mockSafeStorage.isEncryptionAvailable(),
      encryptString: (plain) => mockSafeStorage.encryptString(plain),
      decryptString: (cipher) => mockSafeStorage.decryptString(cipher),
    },
    openExternal: async (url) => {
      opened.push(url);
    },
    clipboardWrite: () => undefined,
    showOpenDialog: async () => null,
    showSaveDialog: async (o) => {
      saveDialogCalls.push({ title: o.title, defaultFileName: o.defaultFileName });
      const scripted = opts.saveDialog;
      if (scripted === undefined || scripted === null) return null;
      return typeof scripted === 'function' ? await scripted(o) : scripted;
    },
    notify: (title, body) => {
      notifications.push({ title, body });
    },
    setLoginItem: () => undefined,
    preferredLanguages: () => ['en-US'],
  };

  // The seams object is MUTATED after compose(): the fake bridge cannot start until the doorbell is listening.
  const seams = {
    userDataDir: userData,
    bridgeCmd: undefined,
    fakeBridge: { url: 'http://127.0.0.1:1', token: BRIDGE_TOKEN },
    mcpCmd: undefined,
    llm: (opts.llm ?? 'stub') as 'stub' | 'attacker',
    llmScript: undefined,
    llamaCmd: undefined,
    modelManifest: undefined,
    hardware: { ramGiB: 32, freeDiskGiB: 200, gpus: [{ name: 'NVIDIA GeForce RTX 4070', vramGiB: 12 }] },
    timers: undefined,
    now: nowMs,
    focusCheck: undefined,
  };

  const app = await compose({
    paths,
    clock: clock as Clock,
    random,
    logger,
    spawn: refusingSpawn,
    fetch: globalThis.fetch,
    processQuery: noProcesses,
    electron,
    seams,
    transportFactory: () => calendar.clientTransport() as unknown as { start(): Promise<void>; close(): Promise<void> },
    providerOverride: (): LlmProvider => provider,
    isPackaged: false,
    version: '0.0.0-l3',
    execPath: process.execPath,
    preferredLanguages: () => ['en-US'],
  });

  // ---- the fake bridge, now that the doorbell is listening ----------------------------------------------------------
  const webhookUrl = app.doorbellUrl();
  const bridge = await startFakeBridge({
    token: BRIDGE_TOKEN,
    storeDir: paths.bridgeStoreDir,
    ...(webhookUrl === null ? {} : { webhookUrl }),
    pairing: opts.pairing ?? 'connected',
  });
  seams.fakeBridge.url = bridge.url;

  // ---- push events --------------------------------------------------------------------------------------------------
  const pushes: Array<{ event: string; payload: unknown }> = [];
  for (const event of ['health', 'dashboard', 'pairing', 'google', 'model', 'language', 'navigate'] as const) {
    app.on(event, (payload) => pushes.push({ event, payload }));
  }

  // ---- IPC through the REAL register.ts ------------------------------------------------------------------------------
  const windowState = { focused: true, visible: true };
  const win = {
    webContents: { id: 1 },
    isDestroyed: () => false,
    isFocused: () => windowState.focused,
    isVisible: () => windowState.visible,
    show: () => {
      windowState.visible = true;
    },
    focus: () => {
      windowState.focused = true;
    },
  };
  app.attachWindow(win);

  type Registered = (event: unknown, payload?: unknown) => Promise<Result<unknown>>;
  const registry = new Map<string, Registered>();
  const ipcMainDouble = {
    handle: (channel: string, fn: Registered) => {
      registry.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      registry.delete(channel);
    },
  };
  let ctxOverride: Partial<IpcContext> = {};
  const unregister = registerIpc(ipcMainDouble as unknown as Parameters<typeof registerIpc>[0], app.handlers, {
    isTrusted: (event: IpcEventLike) => app.isTrusted(event),
    windowState: () => ({ ...app.windowState(), ...ctxOverride }),
    audit: (kind, ref, detail, at) => app.repos.audit.append(kind, ref, detail, at),
    now: () => clock.now(),
    log: logger,
  });

  const trustedEvent: IpcEventLike = {
    senderFrame: { url: 'app://bundle/index.html', parent: null },
    sender: { id: 1, isDestroyed: () => false },
  };

  if (opts.autoStart !== false) await app.start();

  attachLedgerSources({
    bridge,
    calendar,
    db: app.repos.db,
    ...(provider instanceof StubLlm ? { unmatchedLlm: () => provider.unmatched } : {}),
    logText: () => logs.join('\n'),
  });

  const advance = async (ms: number): Promise<void> => {
    await clock.advance(ms);
    await flush();
  };

  /**
   * Drives the app forward under the virtual clock until nothing is queued any more. `runAll()` is deliberately NOT
   * used: compose() keeps four periodic timers armed for the whole process life (ingest scan, media janitor, retention,
   * backup), so a "run every pending timer" loop can never terminate. Bounded by rounds, never by a real sleep (T7).
   */
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 30; round++) {
      app.poke();
      await advance(LIMITS.pokeDebounceMs);
      await advance(LIMITS.debounceMs);
      await advance(1_000);
      const h = app.health();
      if (h.queue.pending === 0 && h.queue.running === 0) return;
    }
  };

  /**
   * Awaits a promise while keeping the VIRTUAL clock moving, so an injected `sleep()` inside it can resolve. Without
   * this, `action:approve` would deadlock: the executor's send jitter is a `clock.setTimeout` that nobody would fire.
   * The clock is advanced only while the promise is still pending, and never more than `stepMs * rounds`.
   */
  const pumpUntil = async <T>(p: Promise<T>, stepMs = 250, rounds = 400): Promise<T> => {
    let settled = false;
    const tracked = p.then(
      (v) => {
        settled = true;
        return v;
      },
      (err: unknown) => {
        settled = true;
        throw err;
      },
    );
    await flush();
    for (let i = 0; i < rounds && !settled; i++) {
      await clock.advance(stepMs);
      await flush();
    }
    return tracked;
  };

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    attachLedgerSources(null);
    unregister();
    try {
      await pumpUntil(app.shutdown());
    } finally {
      await bridge.stop();
      await calendar.stop();
      app.attachWindow(null);
      if (opts.userData === undefined) rmSync(userData, { recursive: true, force: true });
    }
  };

  return {
    runtime: app,
    app,
    paths,
    repos: app.repos,
    clock,
    bridge,
    bridgeDb: bridge.db,
    calendar,
    llm: provider as StubLlm,
    provider,
    userData,
    logs,
    pushes,
    opened,
    notifications,
    saveDialogCalls,
    advance,
    setWindowState: (s) => {
      if (s.focused !== undefined) windowState.focused = s.focused;
      if (s.visible !== undefined) windowState.visible = s.visible;
    },
    async invoke<C extends IpcChannel>(
      channel: C,
      req: IpcReq<C>,
      ctx?: Partial<IpcContext>,
    ): Promise<Result<IpcRes<C>>> {
      const handler = registry.get(channel);
      if (handler === undefined) throw new Error(`harness: channel ${channel} is not registered`);
      ctxOverride = ctx ?? {};
      try {
        return (await pumpUntil(handler(trustedEvent, req))) as Result<IpcRes<C>>;
      } finally {
        ctxOverride = {};
      }
    },
    health: () => app.health(),
    settle,
    dispose,
  };
}

/** TESTS section 6 names the entry point `createTestApp`; it is the same function. */
export const createTestApp = createHarness;

/** Every channel register.ts wired, for the tests that assert the surface is complete. */
export const HARNESS_CHANNELS: readonly IpcChannel[] = IPC_CHANNELS;

export type { ClockTimer };
