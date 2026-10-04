// tests/helpers/harness.ts - L3 integration harness around the PRODUCTION compose() (owner W0 types -> W2-01 body).
// Builds an AppRuntime with every fake wired in: fake bridge (in-process, attach mode), fake bridge DB, fake MCP calendar
// over InMemoryTransport, StubLlm / ObedientAttackerLlm, virtual clock, seeded random, temp userData under os.tmpdir(),
// electron mock facade. Because it is the real compose.ts, capability wiring is exercised exactly as shipped.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import type { AppRuntime, AppRuntimeHandle } from '../../src/main/compose.ts';
import { compose, persistGoogleAccount } from '../../src/main/compose.ts';
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
import type { FakeClaudeState } from '../fakes/fake-claude-cli.types.ts';
import type { FakeAgyState } from '../fakes/fake-agy.types.ts';
import { registerListener, registerUserDataDir } from '../setup-guards.ts';
import { mediaLocalFileName } from '../../src/main/llm/local/manifest.ts';
import { setToolServerListenerRegistry, type ToolServerListenerRecord } from '../../src/main/mcp/toolServer.ts';
import {
  safeStorage as mockSafeStorage,
  dialog as mockDialog,
  Notification as MockNotification,
  nativeImage as mockNativeImage,
} from '../mocks/electron.ts';
import { FAKE_CLAUDE_DEFAULT_STATE, readFakeClaudeJournal } from '../fakes/fake-claude-cli.types.ts';
import { FAKE_AGY_DEFAULT_STATE, readFakeAgyJournal } from '../fakes/fake-agy.types.ts';
import { assertNoFakeViolations, readRegisteredJournals, registerFakeJournal } from './cli-fakes-hook.ts';
import { seedWaWorld } from './waWorld.ts';
import type { ImageFacade, ImageHandle } from '../../src/main/deps.ts';
import { ANTIGRAVITY_TERMS_READ_ON, CONSENT_KIND_FOR } from '../../src/shared/types.ts';

/** [V2] T2 6 harness options (types frozen in Wave 0; the bodies of the new options land with their owners and THROW until then). */
export interface HarnessCliOptions {
  claude?: Partial<FakeClaudeState> & { script?: StubRule[] };
  agy?: Partial<FakeAgyState> & { script?: StubRule[] };
}
export interface HarnessWhisperOptions {
  mode?: string;
  transcripts?: Record<string, { language: string; text: string }>;
}
export type HarnessMediaEntry = { chatJid: string; msgId: string } & (
  | { bytes: Uint8Array }
  | { scenario: 'missing' | 'http_500_once' | 'http_500' | 'partial' | 'slow' | 'oversize' | 'wrong_bytes' }
);
/** [V2] one recorded native dialog (autoDialog / agy workspace trust), as __wcaTest.dialogs() reports it (T2 4.2). */
export interface HarnessDialogRecord {
  kind: string;
  type: string;
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  checkboxLabel: string | null;
  parentFocused: boolean;
}

export interface HarnessOptions {
  llm?: 'stub' | 'attacker';
  /** [V2] widened to every ProviderId; 'claude_cli' / 'antigravity_cli' run the spawned CLI fakes (`cli`; default fake state). */
  provider?: ProviderId;
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
  // ---- [V2] T2 6 ------------------------------------------------------------------------------------------------
  /** Spawns the real CLI fakes (system node.exe + tests/fakes/fake-*.mjs, the WCA_CLI_CMD seam shape) with a fake home under the temp dir. */
  cli?: HarnessCliOptions;
  /** Fake whisper via S-JOB (V2-W1-07). */
  whisper?: HarnessWhisperOptions;
  /** Seeds the standard WhatsApp read world (tests/helpers/waWorld.ts, V2-W1-05). */
  waWorld?: boolean;
  /** `/api/media` answers of the fake bridge (V2-W1-07). */
  media?: HarnessMediaEntry[];
  // ---- [v2-repair-v2-main-defects] ------------------------------------------------------------------------------------
  /** The WCA_TIMERS seam as compose() receives it (delays only). Default: none (production delays). */
  timers?: import('../../src/main/testSeams.ts').SeamTimers;
  /** The WCA_MODEL_MANIFEST seam (path to the extended manifest JSON). Default: none - every download URL is then the app's
   *  unreachable loopback placeholder, and the harness fetch refuses anything that is not loopback (T1/T2: no real network). */
  modelManifest?: string;
  // NOTE: no `autoPolicy` option by design - a policy is reached only through auto:requestEnable + the scripted dialog.
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
  // ---- [V2] T2 6 handles ---------------------------------------------------------------------------------------------
  /** Parsed journal lines of every fake CLI invocation of this harness (fake-claude-cli / fake-agy). */
  cliJournal(): unknown[];
  /** Parsed journal lines of every fake whisper invocation. */
  whisperJournal(): unknown[];
  /** Every native dialog the app built (autoDialog, agy workspace trust), in order. */
  readonly dialogs: HarnessDialogRecord[];
  /** Tool-server listeners opened by this harness (T7 registry view). */
  readonly toolServers: Array<{ name: string; listening: boolean }>;
  /** Live job pids per kind (JobRunner.jobPids()). */
  jobs(): Record<'cli' | 'voice', number[]>;
  // ---- [v2-repair-v2-main-defects] ------------------------------------------------------------------------------------
  /** Every URL the app handed to `fetch`, in order (loopback or not). */
  readonly fetched: string[];
  /** Every NON-loopback URL the app tried to fetch - refused by the harness (it never reaches the network). */
  readonly blockedFetches: string[];
  // ---- [v2-closeout] ------------------------------------------------------------------------------------------------------
  /** Runs the REAL quit sequence (runtime.shutdown()) under the pumped clock and keeps userData on disk for inspection; dispose() later
   *  still stops the fakes and removes the temp dir (its own shutdown() is then a no-op). */
  quit(): Promise<void>;
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

/** A spawn that refuses: no L3 test may start a supervised child (TESTS T1). [V2] The only processes an L3 test starts are the
 *  spawned .mjs fakes (vendor CLIs / whisper, T2 6), run by the JobRunner under the system node.exe - never a vendor binary (T8). */
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
/** [V2] Real-time yield for a spawned fake child (vendor CLI / whisper); the only real wait in the harness, bounded below. */
function realWait(ms: number): Promise<void> {
  return new Promise<void>((done) => setTimeout(done, ms));
}
/** Upper bound of real waits per settle()/invoke (~15 s at 10 ms): a hung fake fails the test, it never hangs the run. */
const SETTLE_REAL_WAITS = 1_500;
/** Drops the fake-only `script` member from a fake CLI state option. */
function withoutScript<T extends { script?: unknown }>(o: T | undefined): Omit<T, 'script'> | Record<string, never> {
  if (o === undefined) return {};
  const { script: _script, ...rest } = o;
  return rest;
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
  const unregisterUserData = registerUserDataDir(userData); // [V2] T7 (b)-(d) leak scan
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

  // ---- [V2] fake home, CLI fakes, whisper fake (T2 6; T9: never the real profile, T8: only node.exe + tests/fakes/*.mjs) ----
  const fakesRoot = join(userData, 'wca-fakes'); // outside every dir the app wipes; removed with userData
  const fakeHome = join(fakesRoot, 'home');
  mkdirSync(join(fakeHome, 'AppData', 'Local'), { recursive: true });
  mkdirSync(join(fakeHome, 'AppData', 'Roaming'), { recursive: true });
  mkdirSync(join(fakesRoot, 'temp'), { recursive: true });
  const fakeEnv: Record<string, string | undefined> = {
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    USERPROFILE: fakeHome,
    HOMEDRIVE: fakeHome.slice(0, 2),
    HOMEPATH: fakeHome.slice(2),
    APPDATA: join(fakeHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(fakeHome, 'AppData', 'Local'),
    TEMP: join(fakesRoot, 'temp'),
    TMP: join(fakesRoot, 'temp'),
  };
  const useClaude = opts.cli?.claude !== undefined || providerId === 'claude_cli';
  const useAgy = opts.cli?.agy !== undefined || providerId === 'antigravity_cli';
  const cliJournalFiles: Array<{ kind: 'claude' | 'agy'; file: string }> = [];
  const fakeCommand = (
    kind: 'claude' | 'agy',
    state: Record<string, unknown>,
    script: StubRule[] | undefined,
  ): { command: string; args: string[] } => {
    const journal = join(fakesRoot, `${kind}-journal.jsonl`);
    const stateFile = join(fakesRoot, `${kind}-state.json`);
    const scriptFile = join(fakesRoot, `${kind}-script.json`);
    writeFileSync(stateFile, JSON.stringify(state));
    writeFileSync(scriptFile, JSON.stringify({ rules: script ?? opts.rules ?? DEFAULT_RULES }));
    cliJournalFiles.push({ kind, file: journal });
    registerFakeJournal(kind, journal); // the cli-fakes-hook afterEach clears the registry
    const fake = join(REPO_ROOT, 'tests', 'fakes', kind === 'claude' ? 'fake-claude-cli.mjs' : 'fake-agy.mjs');
    return {
      command: process.execPath,
      args: [fake, '--fake-journal', journal, '--fake-state', stateFile, '--fake-script', scriptFile, '--fake-end'],
    };
  };
  const cliCmd = {
    claude_cli: useClaude
      ? fakeCommand(
          'claude',
          { ...FAKE_CLAUDE_DEFAULT_STATE, ...withoutScript(opts.cli?.claude) },
          opts.cli?.claude?.script,
        )
      : null,
    antigravity_cli: useAgy
      ? fakeCommand('agy', { ...FAKE_AGY_DEFAULT_STATE, ...withoutScript(opts.cli?.agy) }, opts.cli?.agy?.script)
      : null,
  };
  let whisperJournalFile: string | null = null;
  const whisperCmd = ((): { command: string; args: string[] } | undefined => {
    if (opts.whisper === undefined) return undefined;
    const journal = join(fakesRoot, 'whisper-journal.ndjson');
    whisperJournalFile = journal;
    const transcripts = join(fakesRoot, 'whisper-transcripts.json');
    writeFileSync(transcripts, JSON.stringify({ byDuration: opts.whisper.transcripts ?? {} }));
    registerFakeJournal('whisper', journal);
    return {
      command: process.execPath,
      args: [
        join(REPO_ROOT, 'tests', 'fakes', 'whisper-cli.mjs'),
        '--fake-journal',
        journal,
        '--fake-mode',
        opts.whisper.mode ?? 'ok',
        '--fake-transcripts',
        transcripts,
        '--fake-cores',
        String(cpus().length),
        '--fake-end',
      ],
    };
  })();

  // [V2] T7 (a): every loopback tool server this harness's app opens is in the leak registry AND the harness's own view
  const toolServers: ToolServerListenerRecord[] = [];
  setToolServerListenerRegistry((l) => {
    toolServers.push(l);
    return registerListener(l);
  });

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
    if (providerId === 'claude' || providerId === 'gemini') {
      const name = SECRET_FOR[providerId];
      repos.secrets.put(name, mockSafeStorage.encryptString(TEST_KEY[providerId]));
    }
    // [V2] the CLI providers need their consent at the current version (B12), like the cloud ones
    if (profile.cloudConsent && (providerId === 'claude_cli' || providerId === 'antigravity_cli')) {
      const kind = CONSENT_KIND_FOR[providerId];
      repos.consents.accept(
        kind,
        CONSENT_VERSIONS[kind],
        at,
        kind === 'cloud_antigravity_cli' ? ANTIGRAVITY_TERMS_READ_ON : undefined,
      );
    }
    // [V2] B7: a connected calendar profile has listed its calendars once - the target calendar is owned
    if (calendarMode === 'connected') repos.meta.set('calendar_roles_json', JSON.stringify({ primary: 'owner' }));
    // [V2] auto-mode-6: ... and has signed in once - the fake's account is persisted (as its hash) like a real sign-in does
    if (calendarMode === 'connected') persistGoogleAccount(repos.meta)('user@example.test');
    // [V2] whisper option: the default voice tier + VAD are downloaded and verified (GGML magic, as the fake checks it)
    if (opts.whisper !== undefined) {
      for (const [id, kind] of [
        ['voice-hebrew', 'asr'],
        ['voice-vad', 'vad'],
      ] as const) {
        const file = join(paths.modelsDir, mediaLocalFileName(id)); // the ModelManager's own file name for this id
        writeFileSync(file, Buffer.from([0x6c, 0x6d, 0x67, 0x67, 0]));
        repos.models.upsert({
          id,
          kind,
          path: file,
          size: 5,
          sha256: '0'.repeat(64) as never,
          mtime: 0,
          status: 'ready',
          bytesDone: 5,
          verifiedAt: at,
          bench: null,
        });
      }
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

  // [V2] S-IMAGE over the electron mock's deterministic nativeImage; S-DIALOG over the mock's scripted showMessageBox
  const handleOf = (img: ReturnType<typeof mockNativeImage.createFromBuffer>): ImageHandle => ({
    isEmpty: () => img.isEmpty(),
    getSize: () => img.getSize(),
    resize: (o) => handleOf(img.resize(o)),
    toJPEG: (q) => new Uint8Array(img.toJPEG(q)),
  });
  const imageFacade: ImageFacade = {
    fromBuffer: (bytes) => handleOf(mockNativeImage.createFromBuffer(Buffer.from(bytes))),
  };
  /** Toasts WITH action buttons go through the mock Notification (T2 3.10: `Notification.__emitAction`) and are recorded too. */
  const notifyWithActions = (
    toast: { title: string; body: string; actions: string[] },
    onAction: (index: number) => void,
    onClick: () => void,
  ): void => {
    notifications.push({ title: toast.title, body: toast.body });
    const n = new MockNotification({
      title: toast.title,
      body: toast.body,
      actions: toast.actions.map((text) => ({ type: 'button' as const, text })),
    });
    n.on('action', (_e: unknown, index: number) => onAction(index));
    n.on('click', () => onClick());
    n.show();
  };

  // [v2-repair-v2-main-defects] T1/T2: an L3 test never reaches the network. Loopback (the fake bridge, a fake model host) passes;
  // anything else is recorded and refused, so a wiring gap (e.g. a media download on a real Hugging Face URL) is a visible failure.
  const fetched: string[] = [];
  const blockedFetches: string[] = [];
  const guardedFetch: typeof globalThis.fetch = (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    fetched.push(raw);
    let host = '';
    try {
      host = new URL(raw).hostname;
    } catch {
      /* unparsable => refused below */
    }
    if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1') {
      return globalThis.fetch(input, init);
    }
    blockedFetches.push(raw);
    return Promise.reject(new TypeError('harness: network access refused (non-loopback URL)'));
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
    modelManifest: opts.modelManifest,
    hardware: { ramGiB: 32, freeDiskGiB: 200, gpus: [{ name: 'NVIDIA GeForce RTX 4070', vramGiB: 12 }] },
    timers: opts.timers,
    now: nowMs,
    focusCheck: undefined,
    // [V2] the CLI / whisper fakes in the exact validated seam shape (node.exe + tests/fakes/<fake>.mjs ... --fake-end)
    cliCmd: useClaude || useAgy ? cliCmd : undefined,
    whisperCmd,
    dialogScript: undefined, // L3 scripts the mock's showMessageBox instead (dialog.__script)
  };

  const app = await compose({
    paths,
    clock: clock as Clock,
    random,
    logger,
    spawn: refusingSpawn,
    fetch: guardedFetch,
    processQuery: noProcesses,
    electron,
    seams,
    transportFactory: () => calendar.clientTransport() as unknown as { start(): Promise<void>; close(): Promise<void> },
    providerOverride: (): LlmProvider => provider,
    isPackaged: false,
    version: '0.0.0-l3',
    execPath: process.execPath,
    preferredLanguages: () => ['en-US'],
    // ---- [V2] T2 4.3 seams ----
    image: imageFacade,
    dialog: (win, o) => mockDialog.showMessageBox(win, o),
    notifyWithActions,
    home: () => fakeHome,
    cliEnv: fakeEnv,
    locate: { statFile: () => null, env: fakeEnv, runWhere: async () => [] }, // never the real disk / PATH (T8, T9)
  });

  const jobsLive = (): boolean => {
    const j = app.jobPids();
    return j.cli.length > 0 || j.voice.length > 0;
  };

  // ---- the fake bridge, now that the doorbell is listening ----------------------------------------------------------
  const webhookUrl = app.doorbellUrl();
  const bridge = await startFakeBridge({
    token: BRIDGE_TOKEN,
    storeDir: paths.bridgeStoreDir,
    ...(webhookUrl === null ? {} : { webhookUrl }),
    pairing: opts.pairing ?? 'connected',
  });
  seams.fakeBridge.url = bridge.url;
  // [V2] /api/media answers and the standard WhatsApp read world
  for (const m of opts.media ?? []) {
    bridge.setMedia(m.chatJid, m.msgId, 'bytes' in m ? m.bytes : { scenario: m.scenario });
  }
  if (opts.waWorld === true) bridge.db.batch(() => seedWaWorld(bridge.db, app.repos, { nowMs: clock.now() })); // [v2-closeout] one commit

  // ---- push events --------------------------------------------------------------------------------------------------
  const pushes: Array<{ event: string; payload: unknown }> = [];
  for (const event of [
    'health',
    'dashboard',
    'pairing',
    'google',
    'model',
    'language',
    'navigate',
    'auto:changed',
    'cli:changed',
    'queue:changed',
    'voice:progress',
  ] as const) {
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
    // [V2] T2 8.1 rules 10-12 sources
    mediaRequests: () => bridge.mediaRequests,
    fakeJournals: () => readRegisteredJournals(),
    userDataDir: userData,
    sweepExcludeDirs: ['wca-fakes'],
    toasts: () => notifications,
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
    let realWaits = 0;
    for (let round = 0; round < 30; round++) {
      app.poke();
      await advance(LIMITS.pokeDebounceMs);
      await advance(LIMITS.debounceMs);
      await advance(1_000);
      // [V2] a spawned fake (vendor CLI / whisper) runs in REAL time: while a job is live or a triage is still running, the virtual
      // clock only moves in small steps (a media retry or a backoff still elapses) and the loop yields real time to the child.
      while (realWaits < SETTLE_REAL_WAITS && (jobsLive() || app.health().queue.running > 0)) {
        realWaits += 1;
        await realWait(jobsLive() ? 10 : 2);
        if (!jobsLive()) await advance(250);
      }
      const h = app.health();
      if (h.queue.pending === 0 && h.queue.running === 0 && !jobsLive()) return;
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
    let realWaits = 0;
    for (let i = 0; i < rounds && !settled; i++) {
      // [V2] a spawned fake runs in real time: wait for it without moving the virtual clock (its wall-clock timers stay honest)
      while (!settled && jobsLive() && realWaits < SETTLE_REAL_WAITS) {
        realWaits += 1;
        await realWait(10);
      }
      if (settled) break;
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
    // [V2] ledger rule 11: the fakes' journals live under the temp userData, which is removed below - read them first (the
    // cli-fakes-hook afterEach would otherwise find no file and check nothing)
    let journalProblem: unknown = null;
    try {
      await pumpUntil(app.shutdown());
    } finally {
      await bridge.stop();
      await calendar.stop();
      app.attachWindow(null);
      try {
        assertNoFakeViolations(readRegisteredJournals());
      } catch (err) {
        journalProblem = err;
      }
      if (opts.userData === undefined) rmSync(userData, { recursive: true, force: true });
      unregisterUserData();
      setToolServerListenerRegistry(null);
    }
    if (journalProblem !== null) throw journalProblem;
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
    // [V2] T2 6 handles
    cliJournal: () =>
      cliJournalFiles.flatMap(({ kind, file }): unknown[] => {
        let text: string;
        try {
          text = readFileSync(file, 'utf8');
        } catch {
          return [];
        }
        return kind === 'claude' ? readFakeClaudeJournal(text) : readFakeAgyJournal(text);
      }),
    whisperJournal: () => {
      if (whisperJournalFile === null) return [];
      let text: string;
      try {
        text = readFileSync(whisperJournalFile, 'utf8');
      } catch {
        return [];
      }
      return text
        .split(/\r?\n/)
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as unknown);
    },
    get dialogs() {
      return app.dialogs().map((d) => ({ ...d, buttons: [...d.buttons] }));
    },
    get toolServers() {
      return toolServers.map((l) => ({ name: l.name, listening: l.listening }));
    },
    jobs: () => app.jobPids(),
    quit: () => pumpUntil(app.shutdown()),
    fetched,
    blockedFetches,
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
