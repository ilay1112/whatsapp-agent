// src/main/compose.ts - the ONLY place capabilities are wired (ARCHITECTURE 18; build-plan section 3; owner W2-01).
// Wave 0 shipped the final types and a throwing body; W2-01 adds the body below the frozen block.
// sendClient / writeClient VALUES are constructed here and nowhere else; host.callerFor('read'|'write'|'admin') hands out narrowed callers.
import type { Clock, ClockTimer, ElectronFacade, FetchFn, Logger, ProcessQuery, RandomSource, SpawnFn } from './deps';
import { childExeRoots } from './paths';
import type { AppPaths } from './paths';
import type { Seams } from './testSeams';
import type { IpcContext, IpcHandlers } from '../shared/ipc';
import type { AppHealth, BridgeStatus, LlmStatus, PairingState } from '../shared/health';
import type { ClaudeClientLike } from './llm/claude';
import type { GeminiClientLike } from './llm/gemini';
import type { LlmProvider as LlmProviderLike } from './llm/types';

/** S-MCP: prod = () => new StdioClientTransport(...) ; tests = InMemoryTransport pair. Typed structurally to keep the SDK out of shared types. */
export type TransportFactory = () => { start(): Promise<void>; close(): Promise<void> };

export interface ComposeDeps {
  paths: AppPaths;
  clock: Clock;
  random: RandomSource;
  logger: Logger;
  spawn: SpawnFn;
  fetch: FetchFn;
  processQuery: ProcessQuery;
  electron: ElectronFacade;
  seams: Seams | null; // readSeams() result; null in production
  transportFactory?: TransportFactory; // S-MCP
  sdk?: { claude?: ClaudeClientLike; gemini?: GeminiClientLike }; // S-SDK doubles
  /**
   * [W2-01, additive and optional] The whole-provider seam behind `ProviderFactoryDeps.seamProvider`: returns the
   * scripted provider to use for the CURRENT provider id, or null to fall back to the real one. It is the L3 / e2e
   * injection point for `StubLlm` / `ObedientAttackerLlm` (`sdk` only covers the two cloud SDK CLIENTS). Consent and
   * key rules still apply to cloud ids, because the factory checks them before it asks. Never set in production.
   */
  providerOverride?: (id: ProviderId) => LlmProviderLike | null;
  isPackaged: boolean;
  version: string;
  execPath: string; // process.execPath (ELECTRON_RUN_AS_NODE child for the MCP server)
  preferredLanguages: () => string[];
}
export type AppRuntimeEvent = 'health' | 'dashboard' | 'pairing' | 'google' | 'model' | 'language' | 'navigate';
export interface AppRuntime {
  handlers: IpcHandlers; // registered by index.ts via ipc/register.ts
  start(): Promise<void>; // recoverOnStartup, reaper, supervisor children (bridge only after ToS), queue, timers
  shutdown(): Promise<void>; // runQuitSequence order
  health(): AppHealth;
  on(event: AppRuntimeEvent, cb: (payload: unknown) => void): () => void;
}

// =====================================================================================================================
// implementation (W2-01)
// =====================================================================================================================

import nodeFs from 'node:fs';
import nodeOs from 'node:os';

import {
  LIMITS,
  type AuditEntry,
  type AuditKind,
  type EpochMs,
  type ItemId,
  type Lang,
  type OnboardingState,
  type OnboardingStep,
  type ProviderId,
} from '../shared/types';
import type { ErrorCode } from '../shared/errors';
import type { Settings, SettingsPatch } from '../shared/settings';
import { dirFor, resolveLanguage } from '../shared/i18n/languages';

import { createRepos, setSlowStatementHandler, type Db, type Repos } from './db/index';
import { backupNow, newestBackup, openDbWithRecovery, type RecoveryOutcome } from './db/backup';
import { runRetention } from './db/retention';

import { createSecretStore } from './secrets';
import { createHealthHub, type HealthHub } from './health/healthHub';
import { reapOrphans } from './proc/reaper';
import {
  createSupervisor,
  createSyncTaskkill,
  type ChildName,
  type ChildSpec,
  type Supervisor,
} from './proc/supervisor';
import { freePort } from './proc/freePort';

import { createDoorbell } from './bridge/doorbell';
import {
  bridgeStatusToErrorCode,
  createBridgeLauncher,
  resolveBridgeExe,
  HEALTH_POLL_MS,
  type BridgeLauncher,
  type BridgeLauncherHandle,
} from './bridge/launcher';
import { createBridgeReadClient } from './bridge/readClient';
import { createPairingPoller } from './bridge/pairing';
import { createBridgeDb } from './bridge/bridgeDb';
import { createIngest, type Ingest } from './bridge/ingest';
import { createBridgeSendClient } from './bridge/sendClient';
import { runMediaJanitor } from './bridge/janitor';

import { createMcpHost, mcpStatusToErrorCode, type McpHostWithChildSpec } from './mcp/host';
import { createMcpReadClient } from './mcp/readClient';
import { createMcpWriteClient } from './mcp/writeClient';
import { createMcpAdminClient } from './mcp/adminClient';
import { createGoogleAuth, type GoogleAuthDeps, type GoogleAuthService } from './mcp/googleAuth';

import { createProviderFactory } from './llm/factory';
import { createClaudeProvider, listClaudeModels } from './llm/claude';
import { createGeminiProvider, getGeminiModel, listGeminiModels } from './llm/gemini';
import { createLocalProvider, DEFAULT_LOCAL_SAMPLING } from './llm/local';
import { createLlamaRuntime, type LlamaRuntime } from './llm/local/llamaServer';
import { createSupervisedLlama } from './llm/local/supervised';
import { createModelManager, type ModelManager } from './llm/local/download';
import { MODEL_MANIFEST } from './llm/local/manifest';
import { pickTier, preferredDeviceArg, probeHardware } from './llm/local/hardware';
import { runDualSelfTest } from './llm/local/selfTest';
import type { LlmProvider } from './llm/types';

import { createToolGate } from './agent/toolGate';
import { createStage0, releaseHeldItems } from './agent/stage0';
import { createTriageQueue, type TriageQueue } from './agent/queue';
import { createOrchestrator } from './agent/orchestrator';
import { createItemService, type ItemService } from './agent/items';

import { createActionExecutor, type ActionExecutorHandle } from './exec/actionExecutor';
import { reconcileUnknown } from './exec/reconcile';

import { createNotifier, type Notifier } from './app/notifications';
import { createMainI18n } from './app/i18n';
import { applyAutostart } from './app/autostart';
import { runQuitSequence, QUIT_CHILD_GRACE_MS, QUIT_DRAIN_MS } from './app/window';
import { buildTrayTemplate, trayIconFor, type TFn, type TrayState } from './app/tray';

import { createAppHandlers } from './ipc/handlers/app';
import { createItemsHandlers } from './ipc/handlers/items';
import { createActionsHandlers } from './ipc/handlers/actions';
import { createSettingsHandlers } from './ipc/handlers/settings';
import { createSecretsHandlers } from './ipc/handlers/secrets';
import { createLlmHandlers } from './ipc/handlers/llm';
import { createModelHandlers } from './ipc/handlers/model';
import { createPairingHandlers } from './ipc/handlers/pairing';
import { createGoogleHandlers } from './ipc/handlers/google';
import { createDataHandlers } from './ipc/handlers/data';
import type { HandlerDeps, SettingsBus } from './ipc/register';
import { isTrustedSender, type IpcEventLike } from './ipc/sender';

/**
 * The window slice `compose()` needs. `index.ts` hands the real `BrowserWindow` to `attachWindow()`; the integration
 * harness hands a tiny stand-in. Keeping it structural is what lets `compose.ts` run under plain Node in vitest.
 */
export interface ComposeWindow {
  webContents: { id: number };
  isDestroyed(): boolean;
  isFocused(): boolean;
  isVisible(): boolean;
  show(): void;
  focus(): void;
}

/**
 * What `compose()` actually returns: the frozen `AppRuntime` plus the handles `index.ts` and the L3 harness need.
 * Additive only - every consumer written against `AppRuntime` still compiles (same widening pattern as
 * `createBridgeLauncher`'s `BridgeLauncherHandle` and `createMcpHost`'s `McpHostWithChildSpec`).
 */
export interface AppRuntimeHandle extends AppRuntime {
  repos: Repos;
  settings: SettingsBus;
  paths: AppPaths;
  /** DB_RECOVERY surface: what `openDbWithRecovery` did at start. */
  recovery: { recovered: RecoveryOutcome; restoredFrom: string | null };
  /** Sets (or clears) the window used by `isTrustedSender`, `showWindow` and the focus guard. */
  attachWindow(win: ComposeWindow | null): void;
  /** `RegisterIpcOptions.windowState`: sampled once per invoke. */
  windowState(): IpcContext;
  /** `RegisterIpcOptions.isTrusted`. */
  isTrusted(event: IpcEventLike): boolean;
  /** Tray input (UX 12.1). */
  trayState(): TrayState;
  /** Main-process i18n `t` for the tray and the toasts. */
  t(): TFn;
  /** The current UI language pair, recomputed on every language change. */
  uiLanguage(): { lang: Lang; dir: 'ltr' | 'rtl' };
  togglePause(): void;
  /** Session-end / `process.on('exit')`: by PID only, synchronous, safe to call twice. */
  killAllSync(): void;
  /** Ingest/queue doorbell for the integration harness (production calls it from the doorbell and the 30 s timer). */
  poke(): void;
  /** True once `start()` has run to completion. */
  started(): boolean;
  /**
   * The live `WEBHOOK_URL` of the doorbell (`http://127.0.0.1:<port>/hook/<secret>`), or null before the first launch
   * rotated a secret. The L3 harness needs it to point its in-process fake bridge at the real doorbell.
   */
  doorbellUrl(): string | null;
  /** Doorbell statistics (TESTS 8.2: `bytesDrained` after a 25 MB body on a wrong path). */
  doorbellStats(): { accepted: number; rejected: number; bytesDrained: number };
}

/** The frozen `BridgeLauncher` plus what `compose()` needs from it; satisfied by the spawning and the attached launcher alike. */
interface BridgeControl extends BridgeLauncher {
  errorCode(): ErrorCode | null;
  childSpec?(): ChildSpec;
}

const DAY_MS = 24 * 3_600_000;
const DASHBOARD_DEBOUNCE_MS = 150;
const JANITOR_INTERVAL_MS = 3_600_000; // hourly media janitor
const MEDIA_MAX_AGE_DAYS = 30;
const BACKUP_INTERVAL_MS = DAY_MS;
const RETENTION_INTERVAL_MS = DAY_MS;
const REAPER_TOLERANCE_MS = 2_000;
const SYNCING_WINDOW_MS = 120_000; // ARCH 4.6: spawn .. first `history_sync_done` hint or 120 s

/** Errors the user is told about with a toast (UX 12.3). */
const ATTENTION_CODES: readonly ErrorCode[] = ['WA_LOGGED_OUT', 'KEY_INVALID', 'CAL_RECONNECT'];

/** IANA zone from the OS, validated; falls back to the stored value when the host reports something unusable. */
function osTimeZone(fallback: string): string {
  try {
    const tz = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof tz !== 'string' || tz.length === 0) return fallback;
    const supported = Intl.supportedValuesOf('timeZone');
    return supported.includes(tz) ? tz : fallback;
  } catch {
    return fallback;
  }
}

function freeDiskBytesOf(dir: string): Promise<number> {
  return nodeFs.promises
    .statfs(dir)
    .then((s) => Number(s.bavail) * Number(s.bsize))
    .catch(() => 0);
}

/**
 * ARCHITECTURE 4.3 / 14 + CONTRACTS 13: `"Try again" resets the breaker`. `Supervisor.resetBreaker()` is the ONLY way
 * out of a latched breaker - `stop()` preserves it deliberately and no amount of elapsed time clears it - so without a
 * production caller a supervised child that crash-looped once stays dead for the whole session (process-lifecycle-6).
 *
 * This is that caller, and it is deliberately NOT reachable from an automatic respawn: it is invoked only where the
 * user asked for the child to run again (Settings -> Re-link / Show new code / Forget and wipe, and the consent
 * acceptance that starts the bridge for the first time). The Supervisor's own backoff path never reaches it, so the
 * breaker keeps its meaning: it still stops a crash LOOP, it just no longer outlives the user's retry.
 *
 * The `'failed'` guard is what keeps this honest: a healthy or backing-off child keeps its exit history, so a retry
 * cannot be used to launder a crash loop that is still in progress.
 *
 * Returns true when a latch was actually cleared (the Supervisor logs `proc_breaker_reset`).
 */
export function clearLatchedBreaker(sup: Pick<Supervisor, 'state' | 'resetBreaker'>, name: ChildName): boolean {
  if (sup.state(name) !== 'failed') return false;
  sup.resetBreaker(name);
  return true;
}

export interface SupervisedCalendarHostInput {
  supervisor: Pick<Supervisor, 'start' | 'stop' | 'state' | 'resetBreaker'>;
  host: GoogleAuthDeps['host'];
  /** Registers the `calendar-mcp` ChildSpec unless `start()` already did. MUST be idempotent: a second `register()`
   *  replaces the entry and would throw away a live child's handle, pid file and exit history. */
  ensureRegistered: () => void;
}

/**
 * The `McpHost` facade the Google wizard gets (the calendar twin of `llm/local/supervised.ts`).
 *
 * `googleAuth` calls `host.start()` from Import credentials / Replace key and `host.stop()` from Disconnect - user
 * actions, every one of them. Handing it the raw host made those the only calendar start path that bypasses the
 * Supervisor: no `calendar-mcp.pid.json`, so `killAllSync()` and `reapOrphans()` (ARCH 3) can never reach that child,
 * and no backoff or breaker accounting either. And because `supervisor.start('calendar-mcp')` otherwise runs exactly
 * once per session (compose's `start()`), a latched calendar breaker had no user-reachable way back at all
 * (process-lifecycle-6) - the supervised child stayed dead while an unsupervised one took its place.
 *
 * So every wizard start goes through the Supervisor here, and - being a user's "Try again" (ARCHITECTURE 4.3) - first
 * clears a LATCHED breaker. `clearLatchedBreaker`'s `'failed'` guard keeps a crash loop in progress intact.
 *
 * The returned status is the host's own, which is what `googleAuth` maps to `CAL_*` ErrorCodes: a refused or failed
 * supervised start leaves it at `unavailable` / `port_busy` / `toolset_mismatch`, exactly as a direct start did.
 */
export function supervisedCalendarHost(input: SupervisedCalendarHostInput): GoogleAuthDeps['host'] {
  const { supervisor, host, ensureRegistered } = input;
  return {
    status: () => host.status(),
    onStatus: (cb) => host.onStatus(cb),
    async start() {
      ensureRegistered();
      clearLatchedBreaker(supervisor, 'calendar-mcp');
      await supervisor.start('calendar-mcp');
      return host.status();
    },
    async stop() {
      ensureRegistered(); // a Disconnect before start() must still stop the child the Supervisor owns
      await supervisor.stop('calendar-mcp');
    },
  };
}

export async function compose(deps: ComposeDeps): Promise<AppRuntimeHandle> {
  const { paths, clock, random, spawn, fetch, electron, seams, isPackaged, version, execPath } = deps;
  const log = deps.logger;
  const now = (): EpochMs => clock.now();
  const e2e = seams !== null;
  const seamTimers = seams?.timers;
  /** TESTS 4.2 `WCA_FOCUS_CHECK`: honoured by `windowState()` below; always false in production (`seams` is null). */
  const visibleOnlyFocus = seams?.focusCheck === 'visible-only';

  // ---------------------------------------------------------------------------------------------------------------
  // 1. event bus (AppRuntimeEvent -> index.ts / harness; index.ts forwards each one on the matching IpcEvent channel)
  // ---------------------------------------------------------------------------------------------------------------
  const listeners = new Map<AppRuntimeEvent, Set<(payload: unknown) => void>>();
  const on = (event: AppRuntimeEvent, cb: (payload: unknown) => void): (() => void) => {
    const set = listeners.get(event) ?? new Set();
    set.add(cb);
    listeners.set(event, set);
    return () => {
      set.delete(cb);
    };
  };
  const emit = (event: AppRuntimeEvent, payload: unknown): void => {
    const set = listeners.get(event);
    if (set === undefined) return;
    for (const cb of [...set]) {
      try {
        cb(payload);
      } catch (err) {
        log.warn('runtime_listener_failed', { event, reason: err instanceof Error ? err.name : 'unknown' });
      }
    }
  };

  // ---------------------------------------------------------------------------------------------------------------
  // 2. database -> repos (+ recovery, backup, retention)
  // ---------------------------------------------------------------------------------------------------------------
  nodeFs.mkdirSync(paths.userData, { recursive: true });
  for (const dir of [
    paths.backupsDir,
    paths.logsDir,
    paths.runDir,
    paths.bridgeCwd,
    paths.googleDir,
    paths.modelsDir,
  ]) {
    nodeFs.mkdirSync(dir, { recursive: true });
  }

  const opened = openDbWithRecovery(paths.appDb, paths.backupsDir, now);
  const db: Db = opened.db;
  const repos = createRepos(db);
  const audit = (kind: AuditKind, ref: string | null, detail: AuditEntry['detail'], at: EpochMs): void => {
    repos.audit.append(kind, ref, detail, at);
  };
  if (opened.recovered !== 'none') {
    audit('db_recovery', null, { outcome: opened.recovered, hadBackup: opened.restoredFrom !== null }, now());
    log.warn('db_recovered', { outcome: opened.recovered });
  }
  setSlowStatementHandler((s) => {
    if (!isPackaged) log.warn('db_slow_statement', { op: s.op, ms: s.ms });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 3. settings bus (the ONLY writer; every side effect hangs off onChange - W1-13's wiring contract)
  // ---------------------------------------------------------------------------------------------------------------
  const settingsSubs = new Set<(s: Settings) => void>();
  const notifySettings = (s: Settings): void => {
    for (const cb of [...settingsSubs]) {
      try {
        cb(s);
      } catch (err) {
        log.warn('settings_listener_failed', { reason: err instanceof Error ? err.name : 'unknown' });
      }
    }
  };
  const settingsBus: SettingsBus = {
    get: () => repos.settings.get(),
    patch: (p: SettingsPatch) => {
      const next = repos.settings.patch(p); // throws BEFORE notifying when the merged object is invalid
      notifySettings(next);
      return next;
    },
    setInternal: (mut) => {
      const next = repos.settings.setInternal(mut);
      notifySettings(next);
      return next;
    },
    onChange: (cb) => {
      settingsSubs.add(cb);
      return () => settingsSubs.delete(cb);
    },
  };
  const settings = (): Settings => settingsBus.get();

  // [R2] general.timeZone is main-owned: written from the OS at start (and on every bridge ONLINE transition).
  const syncTimeZone = (): void => {
    const current = settings().general.timeZone;
    const tz = osTimeZone(current);
    if (tz !== current) settingsBus.setInternal((s) => (s.general.timeZone = tz));
  };
  syncTimeZone();

  // ---------------------------------------------------------------------------------------------------------------
  // 4. i18n (main) + language
  // ---------------------------------------------------------------------------------------------------------------
  let uiLang: Lang = resolveLanguage(settings().general.language, deps.preferredLanguages());
  let i18n = createMainI18n(uiLang);
  const t: TFn = (key, opts) => i18n.t(key, opts) as string;
  const uiLanguage = (): { lang: Lang; dir: 'ltr' | 'rtl' } => ({ lang: uiLang, dir: dirFor(uiLang) });
  const applyLanguage = (): void => {
    const next = resolveLanguage(settings().general.language, deps.preferredLanguages());
    if (next === uiLang) return;
    uiLang = next;
    i18n = createMainI18n(uiLang);
    emit('language', uiLanguage());
  };

  // ---------------------------------------------------------------------------------------------------------------
  // 5. secrets + health hub
  // ---------------------------------------------------------------------------------------------------------------
  const secrets = createSecretStore({ repos, safeStorage: electron.safeStorage });
  const healthHub: HealthHub = createHealthHub({ now });
  healthHub.setPaused(settings().agent.paused);
  healthHub.onChange((h) => {
    emit('health', h);
    const code = h.overall === 'attention' ? (h.whatsapp.code ?? h.llm.code ?? h.calendar.code ?? null) : null;
    if (code !== null && ATTENTION_CODES.includes(code)) notifier.attention(code);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 6. window reference + notifier (needed by the orchestrator and by RegisterIpcOptions.windowState)
  // ---------------------------------------------------------------------------------------------------------------
  let windowRef: ComposeWindow | null = null;
  const attachWindow = (win: ComposeWindow | null): void => {
    windowRef = win;
  };
  const showWindow = (): void => {
    if (windowRef === null || windowRef.isDestroyed()) return;
    windowRef.show();
    windowRef.focus();
  };
  const notifier: Notifier = createNotifier({
    electron,
    t: () => t,
    clock,
    enabled: () => settings().general.notifications === 'generic',
    onClick: (itemId) => {
      showWindow();
      emit('navigate', { view: 'dashboard', ...(itemId === null ? {} : { itemId }) });
    },
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 7. reaper (BEFORE any spawn, ARCH 13) + supervisor
  // ---------------------------------------------------------------------------------------------------------------
  const processQuery: ProcessQuery = deps.processQuery;
  const killSync = createSyncTaskkill();
  // Every directory a SHIPPED child executable lives in. Packaged these are all under <resources>; unpackaged llamaDir
  // (<appRoot>\vendor\llama\...) and mcpRoot (<appRoot>\build-resources\...) sit OUTSIDE <appRoot>\resources, so passing
  // resourcesDir alone made the reaper discard every dev/e2e llama.pid.json as forged and leak the orphan.
  const ownResourcesDirs = childExeRoots(paths);
  // parsePidFile also accepts an exePath equal to one of these exact paths: execPath (the ELECTRON_RUN_AS_NODE MCP child)
  // and - in e2e builds only, where `seams` is non-null - the seam commands that stand in for the real child exes.
  const seamExePaths = [seams?.bridgeCmd?.command, seams?.mcpCmd?.command, seams?.llamaCmd?.command].filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  );
  await reapOrphans(paths.runDir, ownResourcesDirs, {
    processQuery,
    execPath: [execPath, ...seamExePaths],
    log: (event, meta) => log.info(event, meta),
    toleranceMs: REAPER_TOLERANCE_MS,
  });

  const supervisor: Supervisor = createSupervisor({
    runDir: paths.runDir,
    now,
    log: (event, meta) => log.info(event, meta),
    clock,
    processQuery,
    killSync,
    random,
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 8. doorbell (started BEFORE the launcher: createBridgeLauncher excludes its port and needs a live secret)
  // ---------------------------------------------------------------------------------------------------------------
  /**
   * The doorbell and the bridge launcher are built before Ingest and the TriageQueue (the launcher's port allocation
   * needs a listening doorbell, and Ingest needs S0 which needs the provider factory). This holder is the one
   * forward reference; it is filled in step 12 and is a no-op for the few milliseconds in between.
   */
  const later = {
    pokeIngest: (): void => undefined,
    queuePoke: (): void => undefined,
    bridgeToken: (): string | null => launcher?.endpoint()?.token ?? null,
  };

  let doorbellPort = 0;
  let webhookUrl: string | null = null;
  const doorbell = createDoorbell({
    // The doorbell authenticates with the bridge's per-launch token (`X-Bridge-Token`), which only the endpoint knows.
    token: () => later.bridgeToken(),
    onRing: () => {
      later.pokeIngest();
    },
  });
  // Listening here, not in start(): `createBridgeLauncher` excludes the doorbell port from its own port draw and
  // `rotateSecret()` must already produce a live `http://127.0.0.1:<port>/hook/<secret>`, or the spawn is refused.
  doorbellPort = (await doorbell.start()).port;
  const rotateWebhook = (): string => {
    webhookUrl = doorbell.newWebhookUrl();
    return webhookUrl;
  };
  // One secret exists from the moment compose() returns, so `doorbellUrl()` is usable before start(). The spawning
  // launcher rotates it again on every launch (`rotateSecret`); in attach mode this first one stays live.
  rotateWebhook();

  // ---------------------------------------------------------------------------------------------------------------
  // 9. bridge: launcher -> bridgeDb -> ingest
  // ---------------------------------------------------------------------------------------------------------------
  let bridgeOnlineOnce = repos.meta.get('last_online_ts') !== null;
  let syncingUntil = 0;
  const syncing = (): boolean => syncingUntil > now();

  /**
   * TESTS 4.2 ATTACH MODE (`WCA_FAKE_BRIDGE_URL` / `WCA_FAKE_BRIDGE_TOKEN`, both locks of TESTS 4.1 open): a fake bridge
   * is ALREADY listening, so nothing is spawned. The REST clients, the pairing poller and the health poll are the real
   * production modules - only the process lifecycle is skipped. `seams.fakeBridge.url` is read at CALL time so a test can
   * start its fake after `compose()` has returned (the doorbell has to listen first).
   */
  const attach = seams?.fakeBridge;
  const attachedEndpoint = (): { port: number; token: string } | null => {
    if (attach === undefined) return null;
    try {
      const port = Number(new URL(attach.url).port);
      return Number.isInteger(port) && port > 0 ? { port, token: attach.token } : null;
    } catch {
      return null;
    }
  };

  const bridgeExe =
    attach !== undefined
      ? null
      : resolveBridgeExe({
          bridgeExe: paths.bridgeExe,
          e2e,
          ...(seams?.bridgeCmd === undefined ? {} : { seamBridgeCmd: seams.bridgeCmd }),
        });

  const onBridgeMarker = (marker: string): void => {
    if (marker === 'history_sync_done') {
      syncingUntil = 0;
      later.pokeIngest();
    }
  };

  const spawningLauncher: BridgeLauncherHandle | null =
    bridgeExe === null
      ? null
      : createBridgeLauncher({
          paths,
          exePath: bridgeExe.exePath,
          exeArgs: bridgeExe.exeArgs,
          expectedSha256: bridgeExe.expectedSha256,
          tosAccepted: () => repos.consents.isCurrent('whatsapp_tos'),
          doorbell: { port: () => doorbellPort, rotateSecret: rotateWebhook },
          spawn,
          fetch,
          clock,
          random,
          log,
          audit,
          onMarker: onBridgeMarker,
        });

  const attachedLauncher = attach === undefined ? null : createAttachedBridge();
  const launcher: BridgeControl | null = spawningLauncher ?? attachedLauncher;

  const bridgeStatus = (): BridgeStatus => launcher?.status() ?? 'not_started';
  const bridgeOnline = (): boolean => launcher?.isOnline() ?? false;
  const bridgeOutdated = (): boolean => bridgeStatus() === 'outdated';

  const bridgeDb = createBridgeDb(paths.bridgeMessagesDb);

  // dashboard:changed is debounced 150 ms over the union of the item ids seen in the window.
  let dashboardPending = new Set<number>();
  let dashboardTimer: ReturnType<Clock['setTimeout']> | null = null;
  const notifyChanged = (itemIds: number[]): void => {
    for (const id of itemIds) dashboardPending.add(id);
    if (dashboardTimer !== null) return;
    dashboardTimer = clock.setTimeout(() => {
      dashboardTimer = null;
      const ids = [...dashboardPending];
      dashboardPending = new Set();
      emit('dashboard', { itemIds: ids });
    }, DASHBOARD_DEBOUNCE_MS);
  };

  let tsFormatBroken = false;

  // ---------------------------------------------------------------------------------------------------------------
  // 10. calendar MCP: ONE host, three narrowed facades ([R2] the only three callerFor calls in the codebase)
  // ---------------------------------------------------------------------------------------------------------------
  const credentialsExist = (): boolean => nodeFs.existsSync(paths.googleCredentials);
  const mcpHost: McpHostWithChildSpec = createMcpHost({
    execPath,
    mcpRoot: paths.mcpRoot,
    credentialsPath: paths.googleCredentials,
    tokenPath: paths.googleTokens,
    onStderrMarker: (marker) => log.warn('mcp_stderr_marker', { marker }),
    ...(deps.transportFactory === undefined ? {} : { transportFactory: deps.transportFactory as never }),
    ...(seams?.mcpCmd === undefined
      ? {}
      : { spawnOverride: { command: seams.mcpCmd.command, args: seams.mcpCmd.args } }),
    audit,
    clock,
    log,
    appVersion: version,
  });
  const mcpRead = createMcpReadClient(mcpHost.callerFor('read'));
  const mcpWrite = createMcpWriteClient(mcpHost.callerFor('write'));
  const mcpAdmin = createMcpAdminClient(mcpHost.callerFor('admin'));
  const calendarConnected = (): boolean => mcpHost.status() === 'connected';
  mcpHost.onStatus((s) => {
    // A17: a red calendar row must carry its ErrorCode, exactly like the bridge below (`bridgeStatusToErrorCode`).
    // The code is what HealthPill turns into the row's one action and what raises the CAL_RECONNECT toast.
    const code = mcpStatusToErrorCode(s);
    healthHub.setCalendar(code === null ? { state: s } : { state: s, code });
  });

  /** `start()` registers the three children; a wizard retry that lands first registers this one itself (idempotent). */
  let mcpChildRegistered = false;
  const registerMcpChild = (): void => {
    if (mcpChildRegistered) return;
    mcpChildRegistered = true;
    supervisor.register(mcpHost.childSpec());
  };

  const googleAuth: GoogleAuthService = createGoogleAuth({
    host: supervisedCalendarHost({ supervisor, host: mcpHost, ensureRegistered: registerMcpChild }),
    admin: mcpAdmin,
    read: mcpRead,
    paths,
    openExternal: (url) => electron.openExternal(url),
    clock,
    log,
    audit,
    targetCalendarId: () => settings().calendar.targetCalendarId,
  });
  googleAuth.onChange((s) => emit('google', s));

  // ---------------------------------------------------------------------------------------------------------------
  // 11. LLM: model manager -> lazy llama runtime -> provider factory
  // ---------------------------------------------------------------------------------------------------------------
  const seamManifest = ((): typeof MODEL_MANIFEST => {
    if (seams?.modelManifest === undefined) return MODEL_MANIFEST;
    try {
      const raw = JSON.parse(nodeFs.readFileSync(seams.modelManifest, 'utf8')) as typeof MODEL_MANIFEST;
      return raw;
    } catch {
      log.warn('seam_manifest_unreadable', {});
      return MODEL_MANIFEST;
    }
  })();

  const listDevices = async (): Promise<string | null> => null; // the exe is never executed to probe; hardware uses the cached list
  const hardwareOnce = (() => {
    let cached: Promise<import('../shared/types').HardwareInfo> | null = null;
    return (): Promise<import('../shared/types').HardwareInfo> => {
      cached ??= probeHardware({
        totalMemBytes: () => nodeOs.totalmem(),
        freeDiskBytes: (dir) => freeDiskBytesOf(dir),
        userData: paths.userData,
        listDevices,
        spawn,
        log,
      }).catch((err: unknown) => {
        log.warn('hardware_probe_failed', { reason: err instanceof Error ? err.name : 'unknown' });
        cached = null;
        throw err;
      });
      return cached;
    };
  })();
  const seamHardware = seams?.hardware;
  const hardware = async (): Promise<import('../shared/types').HardwareInfo> => {
    if (seamHardware !== undefined) {
      const base = {
        ramGiB: seamHardware.ramGiB,
        freeDiskGiB: seamHardware.freeDiskGiB,
        gpus: seamHardware.gpus.map((g) => ({ name: g.name, vramGiB: g.vramGiB, dedicated: g.vramGiB !== null })),
      };
      return { ...base, recommendedTier: pickTier(base) };
    }
    return hardwareOnce();
  };

  const modelManager: ModelManager = createModelManager({
    manifest: seamManifest,
    allowHttpLoopback: e2e && seams?.modelManifest !== undefined, // production: always false (W1-07)
    modelsDir: paths.modelsDir,
    repos,
    hardware,
    selectedTier: () => settings().llm.local.tier,
    freeDiskBytes: () => freeDiskBytesOf(paths.userData),
    fetch,
    clock,
    log,
  });
  modelManager.onProgress((p) => emit('model', p));

  const effectiveTier = async (): Promise<import('../shared/types').ModelTier> => {
    const selected = settings().llm.local.tier;
    if (selected !== 'auto') return selected;
    try {
      return (await hardware()).recommendedTier;
    } catch {
      return 'tiny';
    }
  };
  let resolvedTier: import('../shared/types').ModelTier = 'tiny';
  void effectiveTier().then((tr) => {
    resolvedTier = tr;
  });

  const llamaCmd = seams?.llamaCmd;
  const llamaRuntime: LlamaRuntime = createLlamaRuntime({
    exePath: llamaCmd?.command ?? paths.llamaServerExe,
    ...(llamaCmd === undefined ? {} : { exeArgs: llamaCmd.args }),
    llamaDir: paths.llamaDir,
    modelPath: () => modelManager.readyPath(resolvedTier) ?? '',
    tier: () => resolvedTier,
    forceCpu: () => settings().llm.local.forceCpu,
    acceleration: () => settings().llm.local.acceleration,
    freePort: (opts) => freePort(opts),
    spawn,
    fetch,
    clock,
    random,
    log,
    exists: (p) => nodeFs.existsSync(p),
    totalMemBytes: () => nodeOs.totalmem(),
    preferredDevice: () => preferredDeviceArg([], null),
  });
  // Starting llama through the Supervisor is what writes <userData>\run\llama.pid.json for the reaper (ARCH 3) and what
  // enforces the section 14 breaker/backoff: a refused start is reported as LLM_LOCAL_FAILED, never re-spawned raw.
  const supervisedLlama: LlamaRuntime = createSupervisedLlama({ supervisor, runtime: llamaRuntime });

  const makeLocal = (): LlmProvider =>
    createLocalProvider({
      runtime: supervisedLlama,
      modelLabel: seamManifest[resolvedTier].label,
      sampling: DEFAULT_LOCAL_SAMPLING,
      fetch,
      log,
    });

  const seamProvider = deps.providerOverride;

  const providerFactory = createProviderFactory({
    settings,
    secrets,
    repos,
    makeClaude: ({ apiKey, model }) =>
      createClaudeProvider({
        apiKey,
        model,
        log,
        ...(deps.sdk?.claude === undefined ? {} : { client: deps.sdk.claude }),
      }),
    makeGemini: ({ apiKey, model }) =>
      createGeminiProvider({
        apiKey,
        model,
        log,
        ...(deps.sdk?.gemini === undefined ? {} : { client: deps.sdk.gemini }),
      }),
    makeLocal,
    ...(seamProvider === undefined ? {} : { seamProvider }),
    log,
  });

  /** ARCH section 8: the `usable()` ErrorCode decides WHICH non-ready `LlmStatus` the health pill shows. */
  const llmStatusFor = (code: ErrorCode): LlmStatus => {
    switch (code) {
      case 'MODEL_MISSING':
        return 'model_missing';
      case 'KEY_MISSING':
        return 'key_missing';
      case 'KEY_INVALID':
        return 'key_invalid';
      case 'CONSENT_REQUIRED':
        return 'consent_missing';
      case 'CLOUD_QUOTA':
        return 'quota';
      case 'CLOUD_UNAVAILABLE':
        return 'degraded';
      case 'DOWNLOAD_FAILED':
      case 'DISK_FULL':
        return 'downloading';
      default:
        return 'failed';
    }
  };
  const refreshLlmHealth = (): void => {
    const s = settings();
    const usable = providerFactory.usable();
    const model =
      s.llm.provider === 'local'
        ? seamManifest[resolvedTier].label
        : s.llm.provider === 'claude'
          ? s.llm.claudeModel
          : s.llm.geminiModel;
    // 'idle' = Local configured, llama-server not running (lazy); 'ready' = a cloud provider with a usable key.
    healthHub.setLlm(
      usable.ok
        ? { state: s.llm.provider === 'local' ? 'idle' : 'ready', provider: s.llm.provider, model }
        : { state: llmStatusFor(usable.code), code: usable.code, provider: s.llm.provider, model },
    );
  };

  // ---------------------------------------------------------------------------------------------------------------
  // 12. agent pipeline: ToolGate -> S0 -> queue -> orchestrator -> items
  // ---------------------------------------------------------------------------------------------------------------
  const gate = createToolGate({
    read: mcpRead,
    settings,
    calendarConnected,
    audit: (kind, ref, detail) => audit(kind, ref, detail, now()),
  });

  /** [R2] W1-10's wiring contract: tokens REMAINING today, never the configured ceiling. */
  const cloudDailyTokenBudget = (): number => {
    const ceiling = settings().llm.cloudDailyTokenBudget;
    const start = startOfLocalDay(now(), settings().general.timeZone);
    const used = repos.runs.cloudTokensSince(start);
    return Math.max(0, ceiling - (used.inputTokens + used.outputTokens));
  };

  const stage0 = createStage0({
    repos,
    settings,
    providerUsable: () => providerFactory.usable(),
    paused: () => settings().agent.paused,
    budgets: {
      llmRunsPerChatPerHour: LIMITS.llmRunsPerChatPerHour,
      llmRunsGlobalPerHour: LIMITS.llmRunsGlobalPerHour,
      cloudDailyTokenBudget,
    },
    now,
  });

  const ingest: Ingest = createIngest({
    bridgeDb,
    repos,
    classify: stage0,
    settings,
    clock,
    log,
    onTsFormatError: (active) => {
      tsFormatBroken = active;
      if (active) log.warn('bridge_ts_format', {});
    },
    notifyChanged: (ids) => {
      notifyChanged(ids);
      later.queuePoke();
    },
    bridgeOnlineOnce: () => bridgeOnlineOnce,
    syncing,
  });

  const orchestrator = createOrchestrator({
    repos,
    providers: providerFactory,
    gate,
    ingest,
    settings,
    clock,
    random,
    log,
    notifyChanged,
    onItemCreated: (itemId) => notifier.itemCreated(itemId as ItemId),
  });

  const theQueue: TriageQueue = createTriageQueue({
    repos,
    runChat: (chatId, signal) => orchestrator.runChat(chatId, signal),
    clock,
    log,
    ...(seamTimers === undefined
      ? {}
      : {
          timers: {
            ...(seamTimers.debounceMs === undefined ? {} : { debounceMs: seamTimers.debounceMs }),
            ...(seamTimers.debounceCapMs === undefined ? {} : { debounceCapMs: seamTimers.debounceCapMs }),
            ...(seamTimers.scanMs === undefined ? {} : { scanMs: seamTimers.scanMs }),
          },
        }),
  });
  theQueue.onStats((s) => healthHub.setQueue(s));
  later.pokeIngest = () => ingest.poke();
  later.queuePoke = () => theQueue.poke();

  const items: ItemService = createItemService({
    repos,
    settings,
    clock,
    log,
    bridgeOnline,
    bridgeOutdated,
    calendarConnected,
    notifyChanged,
    enqueueRetriage: () => theQueue.poke(), // [R2] a doorbell, never a second enqueue (W1-10)
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 13. execution: the ONLY construction of BridgeSendClient and McpWriteClient in the whole codebase
  // ---------------------------------------------------------------------------------------------------------------
  const sendClient = createBridgeSendClient(() => launcher?.endpoint() ?? null, fetch);
  const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((done) => {
      const timer = clock.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        done();
      }, ms);
      function onAbort(): void {
        clock.clearTimeout(timer);
        done();
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });

  const executor: ActionExecutorHandle = createActionExecutor({
    repos,
    send: sendClient,
    write: mcpWrite,
    read: mcpRead,
    bridgeOnline,
    calendarConnected,
    settings,
    now,
    sleep,
    random: () => random.float(),
    notifyChanged,
    detail: (itemId) => {
      const r = items.detail(itemId);
      return r.ok ? r.value : null;
    },
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 14. bridge lifecycle side effects the launcher cannot do itself (it has no `repos`) - W1-02's wiring contract
  // ---------------------------------------------------------------------------------------------------------------
  let prevBridgeStatus: ReturnType<BridgeLauncher['status']> = 'not_started';
  let prevPairing: string = 'unavailable';

  const recomputeLiveFrom = (at: EpochMs): void => {
    const backlogHours = settings().whatsapp.backlogHours;
    repos.meta.set('live_from_ts', String(at - backlogHours * 3_600_000));
  };

  launcher?.onStatus((s) => {
    const at = now();
    if (prevBridgeStatus === 'online' && s !== 'online') repos.meta.set('last_online_ts', String(at));
    if (s === 'online') {
      bridgeOnlineOnce = true;
      syncTimeZone();
      void ingest.resolveLidChats().catch(() => undefined);
      later.pokeIngest();
    }
    if (s === 'starting') syncingUntil = at + SYNCING_WINDOW_MS;
    prevBridgeStatus = s;
    const code = launcher.errorCode();
    healthHub.setBridge(code === null ? { state: s } : { state: s, code });
  });
  launcher?.onPairing((p) => {
    if (prevPairing === 'qr_pending' && p.status === 'connected') {
      const at = now();
      repos.meta.set('paired_at', String(at));
      recomputeLiveFrom(at);
      void ingest.resolveLidChats().catch(() => undefined);
    }
    prevPairing = p.status;
    healthHub.setPairing(p);
    emit('pairing', p);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 15. IPC handlers
  // ---------------------------------------------------------------------------------------------------------------
  const links = ((): Record<string, string> => {
    try {
      return JSON.parse(nodeFs.readFileSync(paths.linksJson, 'utf8')) as Record<string, string>;
    } catch {
      log.warn('links_unreadable', {});
      return {};
    }
  })();

  const onboardingStep = (): OnboardingStep => {
    const raw = repos.meta.get('onboarding_step');
    return raw === null ? 'welcome' : (raw as OnboardingStep);
  };
  const onboardingState = (): OnboardingState => {
    const s = settings();
    const step = onboardingStep();
    const aiReady =
      s.llm.provider === 'local'
        ? modelManager.readyPath(resolvedTier) !== null
        : secrets.has(s.llm.provider === 'claude' ? 'anthropic_api_key' : 'gemini_api_key').present;
    const mcp = mcpHost.status();
    return {
      step,
      checklist: {
        ai: aiReady ? 'ready' : downloadPercent === null ? 'pending' : 'downloading',
        aiPercent: aiReady ? null : downloadPercent,
        whatsapp: bridgeOnline() ? 'ready' : 'pending',
        calendar:
          mcp === 'connected'
            ? 'ready'
            : credentialsExist()
              ? 'pending'
              : step === 'ready' || step === 'done'
                ? 'skipped'
                : 'pending',
      },
      userDataCloudSynced: /[\\/](OneDrive|Dropbox|Google Drive)[\\/]/i.test(paths.userData),
    };
  };
  let downloadPercent: number | null = null;
  modelManager.onProgress((p) => {
    downloadPercent = p.bytesTotal > 0 ? Math.round((p.bytesDone / p.bytesTotal) * 100) : null;
  });

  const exportDiagnostics = async (): Promise<boolean> => {
    const target = await electron.showSaveDialog({
      title: t('settings.privacy.diag'),
      defaultFileName: `wca-diagnostics-${new Date(now()).toISOString().slice(0, 10)}.json`,
    });
    if (target === null) return false;
    const bundle = {
      version,
      generatedAt: now(),
      health: healthHub.get(),
      settings: settings(),
      counts: repos.items.counts(),
      recovery: { recovered: opened.recovered, hadBackup: newestBackup(paths.backupsDir) !== null },
      tsFormatBroken,
    };
    await nodeFs.promises.writeFile(target, JSON.stringify(bundle, null, 2), 'utf8');
    return true;
  };

  /** The launcher facade the IPC handlers get: the Supervisor owns restarts, so every user action goes through it. */
  const bridgeControl: BridgeLauncher = {
    start: () => startBridge(),
    stop: () => stopBridge(),
    restartForNewCode: async () => {
      await stopBridge();
      await launcher?.restartForNewCode();
      await startBridge();
    },
    relink: async () => {
      await stopBridge();
      await launcher?.relink();
      await startBridge();
    },
    unlinkAndWipe: async () => {
      await stopBridge();
      await launcher?.unlinkAndWipe();
      // [R2] `unlinkAndWipe` deletes the whole bridge store, so the ingest watermark must restart at 0 (CONTRACTS 5).
      repos.meta.set('bridge_rowid_watermark', '0');
      await startBridge();
    },
    status: bridgeStatus,
    pairing: () => launcher?.pairing() ?? { status: 'unavailable' },
    isOnline: bridgeOnline,
    onStatus: (cb) => launcher?.onStatus(cb) ?? (() => undefined),
    onPairing: (cb) => launcher?.onPairing(cb) ?? (() => undefined),
    endpoint: () => launcher?.endpoint() ?? null,
  };

  const handlerDeps: HandlerDeps = {
    repos,
    items,
    executor,
    launcher: bridgeControl,
    googleAuth,
    modelManager,
    providerFactory,
    secrets,
    healthHub,
    queue: theQueue,
    settings: settingsBus,
    electron,
    paths,
    clock,
    log,
    audit,
    version,
    links,
    llm: {
      validateKey: async (provider, apiKey, signal) => {
        if (provider === 'claude') {
          const models = await listClaudeModels({
            apiKey,
            signal,
            ...(deps.sdk?.claude === undefined ? {} : { client: deps.sdk.claude }),
          });
          const wanted = settings().llm.claudeModel;
          const hit = models.find((m) => m.id === wanted) ?? models[0];
          if (hit === undefined) throw new Error('no_models');
          return { model: hit.id };
        }
        const option = await getGeminiModel({
          apiKey,
          model: settings().llm.geminiModel,
          signal,
          ...(deps.sdk?.gemini === undefined ? {} : { client: deps.sdk.gemini }),
        });
        return { model: option.id };
      },
      listModels: async (provider, apiKey, signal) =>
        provider === 'claude'
          ? listClaudeModels({ apiKey, signal, ...(deps.sdk?.claude === undefined ? {} : { client: deps.sdk.claude }) })
          : listGeminiModels({
              apiKey,
              signal,
              ...(deps.sdk?.gemini === undefined ? {} : { client: deps.sdk.gemini }),
            }),
      hardware,
      selfTest: async () => {
        const provider = await providerFactory.get();
        const hw = await hardware().catch(() => null);
        const outcome = await runDualSelfTest(provider, {
          clock,
          log,
          hasDedicatedGpu: hw !== null && hw.gpus.some((g) => g.dedicated),
          cpuProvider: async () => makeLocal(),
          cpuFallbackProvider: async () => makeLocal(),
        });
        // The dual run decides forceCpu; it is main-owned settings state (never settable through settings:set).
        if (outcome.forceCpu !== settings().llm.local.forceCpu) {
          settingsBus.setInternal((st) => (st.llm.local.forceCpu = outcome.forceCpu));
        }
        return {
          ok: outcome.result.ok,
          tokPerSec: outcome.result.tokPerSec,
          usedCpuFallback: outcome.result.usedCpuFallback,
        };
      },
    },
    onboarding: {
      getState: onboardingState,
      setStep: (step: OnboardingStep) => {
        repos.meta.set('onboarding_step', step);
        return onboardingState();
      },
    },
    showWindow,
    exportDiagnostics,
  };

  const baseHandlers: IpcHandlers = {
    ...createAppHandlers(handlerDeps),
    ...createItemsHandlers(handlerDeps),
    ...createActionsHandlers(handlerDeps),
    ...createSettingsHandlers(handlerDeps),
    ...createSecretsHandlers(handlerDeps),
    ...createLlmHandlers(handlerDeps),
    ...createModelHandlers(handlerDeps),
    ...createPairingHandlers(handlerDeps),
    ...createGoogleHandlers(handlerDeps),
    ...createDataHandlers(handlerDeps),
  };

  /**
   * PRODUCT DEFECT FIX (fresh profile could never pair): `start()` runs before the user has read the WhatsApp
   * disclosure, so on a first run `startBridge()` finds no current `whatsapp_tos` consent and the launcher stays
   * 'not_started'. The consent write goes through the `consent:accept` handler, which owns no side effect by design
   * (W1-13), and nothing else was listening - so the Link-WhatsApp step sat in 'preparing' for ever and the panel has
   * no button to recover with. The side effect belongs here, where the bridge is wired: accepting the disclosure
   * starts the bridge immediately, with no restart.
   *
   * Deliberately NOT awaited: the spawn + readiness handshake takes seconds, and the renderer must get its consent
   * record back at once so the wizard can move to the QR panel. Errors are the launcher's own (it publishes them on
   * `onStatus` and through `errorCode()`); they must never turn a recorded consent into a failed IPC call.
   */
  const handlers: IpcHandlers = {
    ...baseHandlers,
    'consent:accept': async (req, ctx) => {
      const res = await baseHandlers['consent:accept'](req, ctx);
      if (res.ok && req.kind === 'whatsapp_tos' && isStarted && repos.consents.isCurrent('whatsapp_tos')) {
        void startBridge().catch((err: unknown) => {
          log.warn('bridge_start_after_consent_failed', { reason: err instanceof Error ? err.name : 'unknown' });
        });
      }
      return res;
    },
  };

  // ---------------------------------------------------------------------------------------------------------------
  // 16. settings-driven side effects (the bus is the ONLY place they are triggered - W1-13)
  // ---------------------------------------------------------------------------------------------------------------
  let lastProvider = settings().llm.provider;
  let lastPaused = settings().agent.paused;
  settingsBus.onChange((s) => {
    applyLanguage();
    applyAutostart({ electron, enabled: s.general.autostart, isPackaged });
    if (s.agent.paused !== lastPaused) {
      lastPaused = s.agent.paused;
      healthHub.setPaused(s.agent.paused);
      theQueue.setPaused(s.agent.paused);
      if (s.agent.paused) theQueue.abortInFlight();
      else theQueue.poke();
    }
    if (s.llm.provider !== lastProvider) {
      lastProvider = s.llm.provider;
      void providerFactory.invalidate().then(() => {
        void effectiveTier().then((tr) => {
          resolvedTier = tr;
        });
        const released = releaseHeldItems(repos, { provider: s.llm.provider, now: now() });
        if (released.length > 0) notifyChanged(released);
        refreshLlmHealth();
        theQueue.poke();
      });
    } else {
      refreshLlmHealth();
    }
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 17. timers
  // ---------------------------------------------------------------------------------------------------------------
  const timers = new Set<ReturnType<Clock['setTimeout']>>();
  const every = (ms: number, fn: () => void): void => {
    const tick = (): void => {
      try {
        fn();
      } catch (err) {
        log.warn('timer_failed', { reason: err instanceof Error ? err.name : 'unknown' });
      }
      const handle = clock.setTimeout(tick, ms);
      timers.add(handle);
    };
    const first = clock.setTimeout(tick, ms);
    timers.add(first);
  };

  // ---------------------------------------------------------------------------------------------------------------
  // 18. lifecycle
  // ---------------------------------------------------------------------------------------------------------------
  let isStarted = false;
  let quitting = false;

  /**
   * [process-lifecycle-7] index.ts builds the tray - Quit item included - BEFORE it awaits `start()`, and `start()`
   * can sit inside one await for tens of seconds (bridge launch 3 x 10 s, MCP connect + listTools 2 x 30 s). A quit
   * in that window runs `shutdown()` -> stopChildren concurrently with a `start()` that would otherwise carry on and
   * spawn the next child AFTER the stop pass. Such a child is invisible to `killAllSync()` (no handle yet) and to the
   * reaper (its pid file is written only after the handshake), i.e. a true orphan. So every await inside `start()` is
   * followed by this check: `quitting` is set synchronously at the top of `shutdown()`, and between a check and the
   * `supervisor.start()` that follows it there is no await, so the guard cannot be raced.
   */
  const abortStart = (at: string): boolean => {
    if (!quitting) return false;
    log.info('start_aborted_by_quit', { at });
    return true;
  };

  async function startBridge(): Promise<void> {
    if (quitting) return; // also covers the IPC/consent callers: nothing may be launched once the quit began
    if (launcher === null) return;
    if (!repos.consents.isCurrent('whatsapp_tos')) {
      // The launcher itself refuses to spawn without a current `whatsapp_tos` consent and publishes 'not_started'.
      await spawningLauncher?.start();
      return;
    }
    if (spawningLauncher === null) {
      await launcher.start(); // attach mode: nothing to spawn or supervise
      return;
    }
    // Every caller of startBridge() is either first boot or an explicit user action (consent accepted, Re-link, Show
    // new code, Forget and wipe) - never an automatic respawn, which the Supervisor drives through its own backoff.
    // So this is the "Try again" of ARCHITECTURE 4.3: without it a latched breaker refuses every start for the rest
    // of the session and the bridge can only come back by restarting the app (process-lifecycle-6).
    clearLatchedBreaker(supervisor, 'bridge');
    await supervisor.start('bridge');
  }
  async function stopBridge(): Promise<void> {
    if (spawningLauncher !== null) await supervisor.stop('bridge');
    await launcher?.stop();
  }

  const start = async (): Promise<void> => {
    if (isStarted) return;
    if (abortStart('entry')) return; // a quit that landed before start() was ever called: there is nothing to boot
    isStarted = true;

    // recovery: running -> queued, overdue actions, executing -> unknown_outcome + reconcile
    repos.items.recoverRunning(now());
    repos.items.expireOld(now());
    await executor.recoverOnStartup();
    if (abortStart('recovery')) return;

    // [R2] W1-11: recoverOnStartup reconciles calendar actions only (it has no bridge DB). Do the send side here.
    if (bridgeDb.open()) {
      await reconcileUnknown({
        repos,
        bridgeDb,
        read: calendarConnected() ? mcpRead : null,
        now,
        timeZone: () => settings().general.timeZone,
      }).catch((err: unknown) => {
        log.warn('reconcile_failed', { reason: err instanceof Error ? err.name : 'unknown' });
        return undefined;
      });
    }
    if (abortStart('reconcile')) return;
    // Only now, after BOTH reconcile passes, is it known which recovered actions are genuinely unresolved. Those get a
    // fresh pending clone so the card offers "Send again" / "Add again" - a new approval, never a replay (TESTS 6).
    const clones = executor.offerRetryForUnknown();
    if (clones > 0) log.info('recovery_retry_offered', { clones });

    // children: the Supervisor owns all three (ARCH 3 "Supervisor x3 + Reaper (PID files)").
    // In attach mode there is no `childSpec()` - the bridge process is not ours, so it is neither supervised nor reaped.
    if (spawningLauncher !== null) supervisor.register(spawningLauncher.childSpec());
    registerMcpChild();
    supervisor.register(llamaRuntime.childSpec());

    // A start that was ALREADY in flight when the flag flipped is collected by `supervisor.stop()`, which awaits the
    // entry's pending start before it kills the handle. That rendezvous holds for every child here: with the guard in
    // place, `start()` can only be inside calendar-mcp's launch once the bridge launch has returned, so whichever
    // entry stopAll walks past still has `pending !== null`. What the guard adds is the other half: no NEW child is
    // launched once the pass has begun.
    await startBridge();
    if (abortStart('bridge')) return;

    if (credentialsExist()) {
      await supervisor.start('calendar-mcp').catch((err: unknown) => {
        log.warn('mcp_start_failed', { reason: err instanceof Error ? err.name : 'unknown' });
      });
    } else {
      healthHub.setCalendar({ state: 'not_configured' });
    }
    if (abortStart('children')) return; // no autostart flag, no queue, no periodic timers on a quitting app

    refreshLlmHealth();
    applyAutostart({ electron, enabled: settings().general.autostart, isPackaged });

    theQueue.setPaused(settings().agent.paused);
    theQueue.start();
    later.pokeIngest();

    // periodic work
    every(LIMITS.scanIntervalMs, () => ingest?.poke());
    every(JANITOR_INTERVAL_MS, () => {
      try {
        runMediaJanitor({ storeDir: paths.bridgeStoreDir, now, maxAgeDays: MEDIA_MAX_AGE_DAYS });
      } catch {
        /* the store may not exist yet */
      }
    });
    every(RETENTION_INTERVAL_MS, () => {
      runRetention({ repos, settings, now });
    });
    every(BACKUP_INTERVAL_MS, () => {
      const last = Number(repos.meta.get('last_backup_at') ?? 0);
      if (now() - last < BACKUP_INTERVAL_MS) return;
      try {
        backupNow(db, { backupsDir: paths.backupsDir, now });
        repos.meta.set('last_backup_at', String(now()));
      } catch (err) {
        log.warn('backup_failed', { reason: err instanceof Error ? err.name : 'unknown' });
      }
    });
  };

  const shutdown = async (): Promise<void> => {
    if (quitting) return;
    quitting = true;
    for (const handle of timers) clock.clearTimeout(handle);
    timers.clear();
    if (dashboardTimer !== null) clock.clearTimeout(dashboardTimer);
    notifier.dispose();
    await runQuitSequence({
      setQuitting: () => undefined, // index.ts flips its own flag before calling shutdown()
      stopQueue: async () => {
        theQueue.abortInFlight();
        await theQueue.stop();
      },
      drainExecutor: (ms) => executor.drain(ms),
      stopChildren: async (opts) => {
        await providerFactory.invalidate(); // disposes the local provider => stops llama-server
        await supervisor.stopAll(opts);
        await launcher?.stop();
        await doorbell.stop();
      },
      writeLastOnline: () => {
        if (bridgeOnline() || prevBridgeStatus === 'online') repos.meta.set('last_online_ts', String(now()));
      },
      closeDb: () => {
        bridgeDb.close();
        setSlowStatementHandler(null);
        db.close();
      },
      destroyTray: () => undefined, // index.ts owns the tray
      exit: () => undefined, // index.ts owns app.exit
      log,
      timeoutMs: QUIT_DRAIN_MS + QUIT_CHILD_GRACE_MS + 5_000,
    });
  };

  /**
   * TESTS 4.2 attach mode: the bridge process already exists (an in-process fake in L3, a child the E2E runner started).
   * Everything that reads the bridge is the real production code - `createBridgeReadClient`, `createPairingPoller`,
   * `bridgeStatusToErrorCode` - only spawn / hash / backoff are skipped, because there is nothing to spawn.
   * Declared as a hoisted function so step 9 can build it before this point in the file.
   */
  function createAttachedBridge(): BridgeControl {
    const read = createBridgeReadClient(attachedEndpoint, fetch);
    let status: BridgeStatus = 'not_started';
    let pairingState: PairingState = { status: 'unavailable' };
    let healthTimer: ClockTimer | null = null;
    let running = false;
    const statusCbs = new Set<(s: BridgeStatus) => void>();
    const pairingCbs = new Set<(p: PairingState) => void>();

    const setStatus = (next: BridgeStatus): void => {
      if (next === status) return;
      status = next;
      for (const cb of [...statusCbs]) cb(next);
    };
    const poller = createPairingPoller({
      read,
      clock,
      log,
      onState: (p) => {
        pairingState = p;
        for (const cb of [...pairingCbs]) cb(p);
      },
    });
    const tick = async (): Promise<void> => {
      if (!running) return;
      try {
        const h = await read.health();
        setStatus(h.connected ? 'online' : 'reconnecting');
      } catch {
        setStatus('backoff');
      }
      if (running) healthTimer = clock.setTimeout(() => void tick(), HEALTH_POLL_MS);
    };
    const startAttached = async (): Promise<void> => {
      if (running) return;
      running = true;
      setStatus('starting');
      syncingUntil = now() + SYNCING_WINDOW_MS;
      poller.start(); // the attached bridge already has the WEBHOOK_URL compose minted above
      await tick();
    };
    const stopAttached = async (): Promise<void> => {
      running = false;
      if (healthTimer !== null) clock.clearTimeout(healthTimer);
      healthTimer = null;
      poller.stop();
      setStatus('stopped');
      return Promise.resolve();
    };
    const restart = async (): Promise<void> => {
      await stopAttached();
      await startAttached();
    };
    return {
      start: startAttached,
      stop: stopAttached,
      restartForNewCode: restart,
      relink: restart,
      unlinkAndWipe: restart,
      status: () => status,
      pairing: () => pairingState,
      isOnline: () => status === 'online',
      onStatus: (cb) => {
        statusCbs.add(cb);
        return () => statusCbs.delete(cb);
      },
      onPairing: (cb) => {
        pairingCbs.add(cb);
        return () => pairingCbs.delete(cb);
      },
      endpoint: attachedEndpoint,
      errorCode: () => bridgeStatusToErrorCode(status, null),
    };
  }

  const trayState = (): TrayState => {
    const h = healthHub.get();
    const counts = repos.items.counts();
    return {
      health: h,
      paused: h.paused,
      waiting: counts.needsReply + counts.infoMissing,
      setupDone: onboardingStep() === 'done',
    };
  };

  const togglePause = (): void => {
    const next = !settings().agent.paused;
    settingsBus.setInternal((s) => (s.agent.paused = next));
  };

  return {
    handlers,
    start,
    shutdown,
    health: () => healthHub.get(),
    on,
    repos,
    settings: settingsBus,
    paths,
    recovery: { recovered: opened.recovered, restoredFrom: opened.restoredFrom },
    attachWindow,
    windowState: (): IpcContext => {
      const live = windowRef !== null && !windowRef.isDestroyed() ? windowRef : null;
      const windowVisible = live !== null && live.isVisible();
      return {
        // TESTS 4.2 `WCA_FOCUS_CHECK=visible-only`: Windows foreground-lock makes `isFocused()` flaky under automation,
        // so an e2e run may treat a VISIBLE window as focused. The hidden-window rejection is untouched (it is
        // `windowVisible` that carries it), and the seam is unreachable in production (`seams` is null there).
        windowFocused: visibleOnlyFocus ? windowVisible : live !== null && live.isFocused(),
        windowVisible,
        shownByNotificationAt: notifier.shownByNotificationAt(),
      };
    },
    isTrusted: (event: IpcEventLike) =>
      isTrustedSender(event, () =>
        windowRef === null
          ? null
          : {
              webContents: { id: windowRef.webContents.id },
              isDestroyed: () => windowRef?.isDestroyed() ?? true,
              isFocused: () => windowRef?.isFocused() ?? false,
              isVisible: () => windowRef?.isVisible() ?? false,
            },
      ),
    trayState,
    t: () => t,
    uiLanguage,
    togglePause,
    killAllSync: () => supervisor.killAllSync(),
    poke: () => {
      later.pokeIngest();
      theQueue.poke();
    },
    started: () => isStarted,
    doorbellUrl: () => webhookUrl,
    doorbellStats: () => doorbell.stats(),
  };
}

/** Local midnight of `at` in `timeZone`, as EpochMs. Pure; falls back to UTC midnight when the zone is unusable. */
function startOfLocalDay(at: EpochMs, timeZone: string): EpochMs {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date(at)).map((p) => [p.type, p.value]));
    const secondsIntoDay = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
    return (at - secondsIntoDay * 1000) as EpochMs;
  } catch {
    return (at - (at % DAY_MS)) as EpochMs;
  }
}

// Re-exported so `index.ts` and the harness do not have to reach into `app/tray.ts` themselves.
export { buildTrayTemplate, trayIconFor };
export type { TrayState, TFn };
