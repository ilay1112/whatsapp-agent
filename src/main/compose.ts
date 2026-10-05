// src/main/compose.ts - the ONLY place capabilities are wired (ARCHITECTURE 18; build-plan section 3; owner W2-01).
// Wave 0 shipped the final types and a throwing body; W2-01 adds the body below the frozen block.
// sendClient / writeClient VALUES are constructed here and nowhere else; host.callerFor('read'|'write'|'admin') hands out narrowed callers.
import type { Clock, ClockTimer, ElectronFacade, FetchFn, Logger, ProcessQuery, RandomSource, SpawnFn } from './deps';
import { childAndJobExeRoots } from './paths';
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
  // ---- [V2 ADD] v2-build-plan section 3 seam (V2-W0-scaffold; V2-W2-01 wires them). [W0 refinement] optional so index.ts and the v1
  //      harness keep compiling; `seams` above carries the v2 Seams fields (testSeams.ts readSeams v2).
  image?: import('./deps').ImageFacade; // S-IMAGE: the real nativeImage facade (built in index.ts, the only electron importer besides app/**)
  dialog?: import('./deps').ShowMessageBoxFn; // S-DIALOG
  console?: import('./deps').OpenVisibleConsoleFn; // S-CONSOLE
  // ---- [V2-W2-01, additive and optional] the remaining T2 4.3 seams compose() needs; each absent member takes its production value ----
  /** S-JOB: the process primitives of proc/jobRunner.ts (default: node:child_process + taskkill). */
  jobProc?: Partial<Pick<import('./deps').JobProcessDeps, 'spawn' | 'killPid' | 'setPriority'>>;
  /** S-LOCATE: the CLI locator's view of the disk / PATH (default: node:fs stat + process.env + where.exe, production only). */
  locate?: import('./deps').LocateDeps;
  /** The env the CLI runner copies named values from (default process.env; never passed through wholesale). */
  cliEnv?: Readonly<Record<string, string | undefined>>;
  /** S-HOME (agy workspace trust + the agy sign-in console cwd). Default: os.homedir(). */
  home?: import('./deps').HomeDirFn;
  /** S-PROC: "is an agy process running" (default: a CLI job of the JobRunner is live). */
  agyRunning?: import('./deps').AgyRunningFn;
  /** Main-owned native OPEN dialog that returns a PATH (cli:pickExe). Absent => the channel answers INTERNAL (fail closed). */
  pickExePath?: (opts: {
    title: string;
    filters: Array<{ name: string; extensions: string[] }>;
  }) => Promise<string | null>;
  /** A toast WITH action buttons (automatic-mode Undo / Show). Absent => the plain `electron.notify` toast without buttons. */
  notifyWithActions?: (
    toast: { title: string; body: string; actions: string[] },
    onAction: (index: number) => void,
    onClick: () => void,
  ) => void;
}
/** [V2-W2-01] the v1 events plus the four v2 push events, named after their IpcEvent channel (C2 8). */
export type AppRuntimeEvent =
  | 'health'
  | 'dashboard'
  | 'pairing'
  | 'google'
  | 'model'
  | 'language'
  | 'navigate'
  | 'auto:changed'
  | 'cli:changed'
  | 'queue:changed'
  | 'voice:progress';
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
import {
  MEDIA_MODEL_MANIFEST,
  MODEL_MANIFEST,
  type MediaModelManifestEntry,
  type ModelManifestEntry,
} from './llm/local/manifest';
import { pickTier, preferredDeviceArg, probeHardware } from './llm/local/hardware';
import { runDualSelfTest } from './llm/local/selfTest';
import type { LlmProvider } from './llm/types';

import { createToolGate } from './agent/toolGate';
import { createStage0, releaseHeldItems, releaseQuotaHeldItems } from './agent/stage0';
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
import type { HandlerDeps, HandlerDepsV2, SettingsBus } from './ipc/register';
import { mergeHandlerGroups } from './ipc/register.handlers';
import { createAutoHandlers } from './ipc/handlers/auto';
import { createCliHandlers, createOpenVisibleConsole } from './ipc/handlers/cli';
import { createVoiceHandlers } from './ipc/handlers/voice';
import { createWaReadClient } from './bridge/waReadClient';
import { isTrustedSender, type IpcEventLike } from './ipc/sender';

// ---- [V2-W2-01] v2 collaborators (every one constructed HERE and nowhere else, C2 19 / build plan rule 13) ----
import nodePath from 'node:path';
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { canonicalJson, type AutoSnapshotInput } from '../shared/schemas';
import type { AutoState, CliProviderId } from '../shared/types';
import { createJobRunner, type JobRunner } from './proc/jobRunner';
import { createCliRunner } from './llm/cli/runner';
import { createCliLocator, createCliStatus, seamArgsPrefix, type CliSeam } from './llm/cli/locator';
import { makeClaudeCliFactory } from './llm/cli/claudeCli';
import {
  AGY_PROFILE_MODE,
  createAgyProvider,
  createAgyWorkspace,
  listAgyModels,
  makeAgyFactory,
} from './llm/cli/antigravityCli';
import { startToolServer } from './mcp/toolServer';
import { parseCalendarRolesJson } from './mcp/adminClient';
import { MMPROJ_FOR_TIER } from './llm/local/manifest';
import { createMediaFetcher } from './media/fetch';
import { createMediaCache, type MediaCache } from './media/mediaCache';
import { createImageNormalizer } from './media/normalizeImage';
import { createVoiceService, type VoiceServiceV2 } from './voice/service';
import { mediaWindowFor } from './bridge/ingest';
import { createPickImage, createReadImageStage, newestImageRow } from './agent/readImage';
import { FEATURE_GATES } from './agent/gates';
import { CONSENT_KIND_FOR } from './llm/consent';
import type { NormalizedImage } from './media/normalizeImage';
import { evaluateAutoGate } from './exec/autoGate';
import { createAutoPolicyService, type AutoPolicyService } from './exec/autoPolicy';
import { createUndo } from './exec/undo';
import { createAutoDialog, type AutoDialog } from './app/autoDialog';
import type { ImageFacade, ShowMessageBoxFn } from './deps';

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
  // ---- [V2-W2-01] read-only views for index.ts (`__wcaTest` v2 hooks) and the L3 harness ----
  /** Live job pids per kind (JobRunner.jobPids()). */
  jobPids(): Record<'cli' | 'voice', number[]>;
  /** Every native dialog the app built (app/autoDialog.ts `recorded()`), app-built text only. */
  dialogs(): import('./app/autoDialog').DialogRecord[];
  /** Automatic-mode tray line ('pause' / 'disable' / 'open'): the tray's `onAuto`. */
  trayAuto(action: 'pause' | 'disable' | 'open'): void;
  /** Called by index.ts / the harness on every window focus (the unattended pause of automatic mode, B7). */
  noteFocus(): void;
  /** e2e: the argv the app WOULD have opened in a visible console for cli:signIn (the e2e build never opens one). */
  consoles(): string[][];
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
const AUTO_TICK_MS = 10 * 60_000; // [V2] automatic-mode tick (expiry / unattended / reminder)

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

/** [v2-repair REQUEST 11] The host every model file a test build does NOT get from WCA_MODEL_MANIFEST points at: loopback, discard port -
 *  the connection is refused at once, nothing ever leaves the machine. */
export const E2E_UNREACHABLE_MODEL_URL = 'http://127.0.0.1:9/wca-e2e-no-model-host/';

// ---------------------------------------------------------------------------------------------------------------------
// [V2] auto-mode-6 (B7): the automatic-mode snapshot is bound to the Google account it was granted under, ACROSS RESTARTS.
// googleAuth's e-mail lives only in memory (null after every restart until a sign-in), so every account answer is also
// persisted - as the 8-hex googleAccountEmailSha8, never the e-mail - in meta.google_account_sha8 ('' = no account).
// ---------------------------------------------------------------------------------------------------------------------
type AccountMeta = Pick<Repos['meta'], 'get' | 'set'>;
const ACCOUNT_SHA8_RE = /^[0-9a-f]{8}$/;
const googleAccountSha8 = (email: string): string =>
  createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 8);

/** googleAuth's `persistAccount`: the account (or null on disconnect / no account) -> meta.google_account_sha8. */
export function persistGoogleAccount(meta: Pick<Repos['meta'], 'set'>): (email: string | null) => void {
  return (email) => meta.set('google_account_sha8', email === null ? '' : googleAccountSha8(email));
}

/** C2 5 AutoSnapshotInput -> auto_policies.snapshot_sha: a policy is bound to the calendar, the account, the provider and the
 *  app major.minor it was granted under; any change => snapshot_changed (pause). The account is the wizard's live e-mail, else
 *  the persisted one. An UNKNOWN account answers '' (not a sha256): autoPolicy refuses AUTO_CALENDAR_NOT_OWNED and AutoGate
 *  never matches a stored snapshot - fail closed, never a hash of an empty account. */
export function createAutoSnapshotSha(src: {
  accountEmail: () => string | null;
  meta: AccountMeta;
  targetCalendarId: () => string;
  provider: () => ProviderId;
  appVersion: string;
}): () => string {
  return () => {
    const email = src.accountEmail();
    const persisted = src.meta.get('google_account_sha8');
    const sha8 =
      email !== null
        ? googleAccountSha8(email)
        : persisted !== null && ACCOUNT_SHA8_RE.test(persisted)
          ? persisted
          : '';
    if (sha8 === '') return '';
    const input: AutoSnapshotInput = {
      targetCalendarId: src.targetCalendarId(),
      googleAccountEmailSha8: sha8,
      provider: src.provider(),
      appMajorMinor: src.appVersion.split('.').slice(0, 2).join('.'),
    };
    return createHash('sha256').update(canonicalJson(input)).digest('hex');
  };
}

/**
 * [v2-repair REQUEST 11] The two manifests of a TEST build from the parsed WCA_MODEL_MANIFEST file (T2 4.1 "extended": keyed by
 * ModelFileId - LLM tiers as full ModelManifestEntry objects, media ids as SeamModelEntry {tier,url,size,sha256,kind?,magic?}).
 * An entry the file does not name keeps its pinned label / file name / size / sha256 but gets an unreachable loopback URL, so a test
 * build can never fetch a real Hugging Face URL. Pure; compose() calls it only when seams !== null.
 */
export function e2eModelManifests(raw: unknown): {
  llm: Record<keyof typeof MODEL_MANIFEST, ModelManifestEntry>;
  media: Record<keyof typeof MEDIA_MODEL_MANIFEST, MediaModelManifestEntry>;
} {
  const file = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const entryOf = (id: string): Record<string, unknown> | null => {
    const e = file[id];
    if (typeof e !== 'object' || e === null) return null;
    const r = e as Record<string, unknown>;
    return typeof r.url === 'string' && typeof r.size === 'number' && typeof r.sha256 === 'string' ? r : null;
  };
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v.length > 0 ? v : fallback);
  const llm = {} as Record<keyof typeof MODEL_MANIFEST, ModelManifestEntry>;
  for (const tier of Object.keys(MODEL_MANIFEST) as Array<keyof typeof MODEL_MANIFEST>) {
    const base = MODEL_MANIFEST[tier];
    const e = entryOf(tier);
    llm[tier] =
      e === null
        ? { ...base, url: E2E_UNREACHABLE_MODEL_URL + tier }
        : {
            tier,
            label: str(e.label, base.label),
            fileName: str(e.fileName, base.fileName),
            url: e.url as string,
            size: e.size as number,
            sha256: e.sha256 as ModelManifestEntry['sha256'],
          };
  }
  const media = {} as Record<keyof typeof MEDIA_MODEL_MANIFEST, MediaModelManifestEntry>;
  for (const id of Object.keys(MEDIA_MODEL_MANIFEST) as Array<keyof typeof MEDIA_MODEL_MANIFEST>) {
    const base = MEDIA_MODEL_MANIFEST[id];
    const e = entryOf(id);
    media[id] =
      e === null
        ? { ...base, url: E2E_UNREACHABLE_MODEL_URL + id }
        : {
            ...base,
            label: str(e.label, base.label),
            fileName: str(e.fileName, base.fileName),
            url: e.url as string,
            size: e.size as number,
            sha256: e.sha256 as MediaModelManifestEntry['sha256'],
            kind: e.kind === 'mmproj' || e.kind === 'asr' || e.kind === 'vad' ? e.kind : base.kind,
            magic: e.magic === 'GGUF' || e.magic === 'GGML' ? e.magic : base.magic,
          };
  }
  return { llm, media };
}

export async function compose(deps: ComposeDeps): Promise<AppRuntimeHandle> {
  const { paths, clock, random, spawn, fetch, electron, seams, isPackaged, version, execPath } = deps;
  const log = deps.logger;
  const now = (): EpochMs => clock.now();
  /**
   * [v2-closeout] Set synchronously at the top of shutdown(). Everything that would START a vendor-CLI job reads it and starts none once
   * the quit began (the Connect card's status probes, a provider build / provider-start smoke); the JobRunner's own latch (killAll)
   * refuses whatever still asks. A job spawned after killJobs outlived app.exit() with run/job-cli-<id>.pid.json (e2e cli-connect 7b/7c/9).
   */
  const lifecycle = { closing: false };
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
  /** [V2] the automatic-mode service is built after the collaborators that report into it (host, executor): late-bound here. */
  const v2Late: { autoPolicy: AutoPolicyService | null } = { autoPolicy: null };
  /** auto:changed + AppHealth.auto + the tray line, from the policy service's CURRENT state (never from a caller's payload). */
  const emitAutoChanged = (): void => {
    const svc = v2Late.autoPolicy;
    if (svc === null) return;
    let state: AutoState;
    try {
      state = svc.getState();
    } catch (err) {
      log.warn('auto_state_failed', { reason: err instanceof Error ? err.name : 'unknown' });
      return;
    }
    const p = state.policy;
    const live = p !== null && (p.state === 'on' || p.state === 'shadow' || p.state === 'paused');
    healthHub.setAuto(
      live
        ? { state: p.state, expiresAt: p.expiresAt, pausedReason: p.pausedReason }
        : { state: 'off', expiresAt: null, pausedReason: null },
    );
    emit('auto:changed', state);
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
    paths.mediaCacheDir, // [V2]
    paths.voiceTmpDir,
    paths.cliRunsDir,
  ]) {
    nodeFs.mkdirSync(dir, { recursive: true });
  }

  const opened = openDbWithRecovery(paths.appDb, paths.backupsDir, now);
  const db: Db = opened.db;
  // [v2-repair REQUEST 1] the WCA_TIMERS debounce reaches the ONE place the triage debounce is computed (repos.queue.enqueue);
  // production (seams === null) passes nothing and keeps LIMITS.debounceMs / debounceCapMs.
  const repos = createRepos(
    db,
    seamTimers === undefined
      ? undefined
      : {
          queueTimers: {
            ...(seamTimers.debounceMs === undefined ? {} : { debounceMs: seamTimers.debounceMs }),
            ...(seamTimers.debounceCapMs === undefined ? {} : { debounceCapMs: seamTimers.debounceCapMs }),
          },
        },
  );
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
  /** [v2-fix auto-mode-1] auto_writes ids whose toast Undo is running -> true once runUndo's notifyAuto('undo') toasted its result. */
  const toastUndos = new Map<string, boolean>();
  const notifier: Notifier = createNotifier({
    electron,
    t: () => t,
    clock,
    enabled: () => settings().general.notifications === 'generic',
    onClick: (itemId) => {
      showWindow();
      emit('navigate', { view: 'dashboard', ...(itemId === null ? {} : { itemId }) });
    },
    // ---- [V2] automatic-mode toasts: action 0 = Undo (main-only, approved_by 'user_toast'), action 1 = Show ----
    // [v2-fix auto-mode-1] ONE truthful result toast per click. undoAuto answers ok:true for 'failed' / 'needs_confirm_*'
    // outcomes too, so r.ok is never "undone". When runUndo reached its write it already toasted from auto_writes.undo_state
    // (notifyAuto 'undo' below marks toastUndos); only a refusal before that (expired, started, changed, stale, a throw) is
    // toasted here - and then only 'done' could ever say "undone".
    onUndo: (autoWriteId) => {
      if (toastUndos.has(autoWriteId)) return; // this toast's Undo is already running (the executor would answer ACTION_STALE)
      toastUndos.set(autoWriteId, false);
      let settled = false;
      const settle = (undone: boolean): void => {
        if (settled) return;
        settled = true;
        const reported = toastUndos.get(autoWriteId) === true;
        toastUndos.delete(autoWriteId);
        if (!reported) notifier.autoUndone(undone);
      };
      void executor
        .undoAuto(autoWriteId, 'user_toast', null)
        .then((r) => {
          settle(r.ok && r.value.outcome === 'done');
          emitAutoChanged();
        })
        .catch((err: unknown) => {
          log.warn('toast_undo_failed', { reason: err instanceof Error ? err.name : 'unknown' });
          settle(false);
        });
    },
    onShow: (itemId) => {
      showWindow();
      emit('navigate', { view: 'dashboard', itemId });
    },
    ...(deps.notifyWithActions === undefined ? {} : { notifyWithActions: deps.notifyWithActions }),
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 7. reaper (BEFORE any spawn, ARCH 13) + supervisor
  // ---------------------------------------------------------------------------------------------------------------
  const processQuery: ProcessQuery = deps.processQuery;
  const killSync = createSyncTaskkill();
  // Every directory a SHIPPED child executable lives in. Packaged these are all under <resources>; unpackaged llamaDir
  // (<appRoot>\vendor\llama\...) and mcpRoot (<appRoot>\build-resources\...) sit OUTSIDE <appRoot>\resources, so passing
  // resourcesDir alone made the reaper discard every dev/e2e llama.pid.json as forged and leak the orphan.
  // [V2] B2/B31: the job class adds whisper-cli.exe (unpackaged: <appRoot>\vendor\whisper, outside every v1 root).
  const ownResourcesDirs = childAndJobExeRoots(paths);
  // parsePidFile also accepts an exePath equal to one of these exact paths: execPath (the ELECTRON_RUN_AS_NODE MCP child)
  // and - in e2e builds only, where `seams` is non-null - the seam commands that stand in for the real child exes.
  const seamExePaths = [
    seams?.bridgeCmd?.command,
    seams?.mcpCmd?.command,
    seams?.llamaCmd?.command,
    seams?.whisperCmd?.command, // [V2] the e2e whisper fake runs under node.exe
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);
  /** [V2, B31] meta.cli_exe_paths_json = {claude_cli?: string, antigravity_cli?: string}: the ONLY CLI paths a job pid file may name. */
  const recordedCliExePaths = (): Partial<Record<CliProviderId, string>> => {
    try {
      const parsed: unknown = JSON.parse(repos.meta.get('cli_exe_paths_json') ?? '{}');
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Partial<Record<CliProviderId, string>> = {};
      for (const k of ['claude_cli', 'antigravity_cli'] as const) {
        const v = (parsed as Record<string, unknown>)[k];
        if (typeof v === 'string' && v.length > 0) out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  };
  const recordCliExePath = (provider: CliProviderId, exePath: string): void => {
    const current = recordedCliExePaths();
    if (current[provider] === exePath) return;
    repos.meta.set('cli_exe_paths_json', JSON.stringify({ ...current, [provider]: exePath }));
  };
  await reapOrphans(paths.runDir, ownResourcesDirs, {
    processQuery,
    execPath: [execPath, ...seamExePaths],
    log: (event, meta) => log.info(event, meta),
    toleranceMs: REAPER_TOLERANCE_MS,
    acceptedCliExePaths: Object.values(recordedCliExePaths()),
  });

  /** [V2] B2: one JobRunner for every whisper / vendor-CLI job; killed BEFORE the supervised children on quit. */
  const jobs: JobRunner = createJobRunner({
    runDir: paths.runDir,
    now,
    log: (event, meta) => log.info(event, meta),
    ...(deps.jobProc === undefined ? {} : { proc: deps.jobProc }),
  });

  const supervisor: Supervisor = createSupervisor({
    runDir: paths.runDir,
    now,
    log: (event, meta) => log.info(event, meta),
    clock,
    processQuery,
    killSync,
    random,
    jobs,
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
    // [V2] B4: AppHealth.calendar.updatesAvailable follows the startup guard and the F12 pre-flight observation.
    onUpdateSurface: (s) => {
      healthHub.setCalendarUpdates(s.available);
      emitAutoChanged(); // AutoState.preconditions.updatesAvailable moved with it
    },
  });
  const updateSurfaceAvailable = (): boolean => mcpHost.updateSurface().available;
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
    // [V2] B7: {[calendarId]: accessRole} of the last list-calendars; automatic mode needs 'owner' for the target calendar.
    persistCalendarRoles: (roles) => repos.meta.set('calendar_roles_json', JSON.stringify(roles)),
    // [V2] auto-mode-6: the account the automatic-mode snapshot binds to, as a short hash only (survives restarts).
    persistAccount: persistGoogleAccount(repos.meta),
  });
  googleAuth.onChange((s) => emit('google', s));
  const calendarRoles = (): ReturnType<typeof parseCalendarRolesJson> =>
    parseCalendarRolesJson(repos.meta.get('calendar_roles_json'));

  // ---------------------------------------------------------------------------------------------------------------
  // 11. LLM: model manager -> lazy llama runtime -> provider factory
  // ---------------------------------------------------------------------------------------------------------------
  // [v2-repair REQUEST 11] a test build (seams !== null) never downloads from a real host: every LLM tier AND every media file
  // (projectors, voice models, VAD) comes from the WCA_MODEL_MANIFEST file, and whatever it does not name points at an unreachable
  // loopback placeholder. Production (seams === null) keeps the pinned manifests exactly.
  const seamManifests = ((): ReturnType<typeof e2eModelManifests> | null => {
    if (seams === null) return null;
    let raw: unknown = null;
    if (seams.modelManifest !== undefined) {
      try {
        raw = JSON.parse(nodeFs.readFileSync(seams.modelManifest, 'utf8')) as unknown;
      } catch {
        log.warn('seam_manifest_unreadable', {});
      }
    }
    return e2eModelManifests(raw);
  })();
  const seamManifest: typeof MODEL_MANIFEST = seamManifests?.llm ?? MODEL_MANIFEST;

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
    ...(seamManifests === null ? {} : { mediaManifest: seamManifests.media }),
    allowHttpLoopback: e2e, // production: always false (W1-07); a test build only ever reaches loopback (seamManifests)
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
    // [V2] B19: the selected tier's projector (--mmproj) once downloaded and verified, only while pictures are on
    imagesEnabled: () => settings().images.enabled,
    mmprojPath: () => modelManager.readyPath(MMPROJ_FOR_TIER[resolvedTier]),
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

  // ---- [V2] vendor CLIs: ONE CliRunner over the JobRunner, the locator (S-LOCATE / the e2e WCA_CLI_CMD seam), the status service ----
  const cliEnv: Readonly<Record<string, string | undefined>> = deps.cliEnv ?? process.env;
  const cliSeam: CliSeam =
    seams === null
      ? null
      : {
          claude_cli: seams.cliCmd?.claude_cli ?? null,
          antigravity_cli: seams.cliCmd?.antigravity_cli ?? null,
        };
  const locate = deps.locate ?? {
    statFile: (p: string) => {
      try {
        return { isFile: nodeFs.statSync(p).isFile() };
      } catch {
        return null;
      }
    },
    env: cliEnv,
    // where.exe: production only (the e2e seam and every test answer before the locator reaches it, T8)
    runWhere: (name: string) =>
      new Promise<string[]>((resolve) => {
        if (e2e) {
          resolve([]);
          return;
        }
        const out: Buffer[] = [];
        const child = spawn('where.exe', [name], {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        child.stdout?.on('data', (b: Buffer) => out.push(b));
        child.once('error', () => resolve([]));
        child.once('close', () =>
          resolve(
            Buffer.concat(out)
              .toString('utf8')
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter((l) => l.length > 0)
              .slice(0, 16),
          ),
        );
      }),
  };
  const cliRunnerCore = createCliRunner({
    jobs,
    userDataDir: paths.userData,
    now,
    audit: (kind, ref, detail) => audit(kind, ref, detail, now()),
    processEnv: cliEnv,
    budget: {
      maxRunsPerHour: () => settings().llm.cli.maxRunsPerHour,
      countSince: (since) => repos.rate.countSince('cli_global', 'global', since),
      record: (at) => repos.rate.record('cli_global', 'global', at),
    },
    allowOverage: () => settings().llm.cli.allowOverage,
    argsPrefix: (exe) => seamArgsPrefix(cliSeam, exe),
    ...(seamTimers?.jobGraceMs?.cli === undefined ? {} : { graceMs: seamTimers.jobGraceMs.cli }),
  });
  /**
   * [v2-repair REQUEST 7] What a finished CLI run says about the PROVIDER (not the chat) reaches AppHealth.llm: a failed init proof
   * ('sandbox' = CLI_TOOLSET_MISMATCH) is shown until a later run of that CLI passes its proof cleanly; the account states (usage
   * window, overage, breaker) come from the runner's own pause through providerFactory.usable(). Observation only: the result is
   * returned unchanged, so every safety behaviour of the runner (no S3 after a failed S1 proof, no run while paused) is untouched.
   */
  const cliIssue = new Map<CliProviderId, ErrorCode>();
  const cliRunner: typeof cliRunnerCore = {
    ...cliRunnerCore,
    run: async (req, signal) => {
      const res = await cliRunnerCore.run(req, signal);
      if (res.error === 'sandbox') cliIssue.set(req.provider, 'CLI_TOOLSET_MISMATCH');
      else if (res.error === null && res.sandbox.initOk) cliIssue.delete(req.provider);
      refreshLlmHealth();
      // [D-080] a run that proved "not signed in" flips the Connect card at once (the status service overrules the cached probe)
      if (res.error === 'not_logged_in') {
        const peek = cliStatus.peek(req.provider);
        if (peek !== null) emit('cli:changed', peek);
      }
      return res;
    },
  };
  const cliLocator = createCliLocator({
    ...locate,
    settingsClaudeExePath: () => settings().llm.cli.claudeExePath,
    seam: cliSeam,
    jobs,
    // [cli-sandbox-3] agy probes run under the isolated <userData>\agy-home profile (F3/B14/I6'), never the real one
    userDataDir: paths.userData,
    // [cli-sandbox-6, B31] every located exe path is recorded BEFORE its first job (probe, cli:test, smoke) can spawn
    onExeResolved: (provider, exePath) => recordCliExePath(provider, exePath),
  });
  const cliStatus = createCliStatus({
    locator: cliLocator,
    runner: cliRunner,
    clock,
    cacheMs: seamTimers?.cliStatusCacheMs ?? LIMITS.cliStatusCacheMs,
    closed: () => lifecycle.closing, // [v2-closeout] no probe job once the quit began
  });
  // [v2-repair REQUEST 9] F3 isolated profile: the app-owned <userData>/agy-home already trusts the app's own workspace, so no
  // workspace-trust step exists (cli:previewWorkspaceChange answers isolated_profile). Recorded as satisfied ("not needed"), or the
  // Connect card waits for an Allow that can never be offered and the experimental provider can never be chosen. The user's own
  // settings.json is never read or written in this mode.
  if (AGY_PROFILE_MODE === 'isolated') cliStatus.recordWorkspaceTrusted(true);
  const onCliQuota = (provider: CliProviderId, q: import('../shared/types').LlmQuota): void => {
    cliStatus.recordQuota(provider, q);
    healthHub.setLlmQuota(q);
    const peek = cliStatus.peek(provider);
    if (peek !== null) emit('cli:changed', peek);
  };
  const onCliSmoke = (provider: CliProviderId, r: { ok: boolean; at: EpochMs; ms: number | null }): void => {
    cliStatus.recordTest(provider, r);
    const peek = cliStatus.peek(provider);
    if (peek !== null) emit('cli:changed', peek);
  };
  /** Late-bound: the per-run loopback tool server serves the ToolGate built in step 12. */
  const startCliToolServer: Parameters<typeof makeClaudeCliFactory>[0]['startToolServer'] = (input) =>
    startToolServer({
      gate: input.gate,
      ctx: input.ctx,
      specs: input.specs,
      randomBytes: (n) => new Uint8Array(nodeRandomBytes(n)),
      freePort: () => freePort(),
      appVersion: version,
    });
  const makeClaudeCli = makeClaudeCliFactory({
    locator: cliLocator,
    runner: cliRunner,
    startToolServer: startCliToolServer,
    now,
    onLocated: (exe) => recordCliExePath('claude_cli', exe),
    onSmoke: (r) => onCliSmoke('claude_cli', r),
    onQuota: (q) => onCliQuota('claude_cli', q),
  });
  const makeAgy = makeAgyFactory({
    locator: cliLocator,
    runner: cliRunner,
    userDataDir: paths.userData,
    now,
    onLocated: (exe) => recordCliExePath('antigravity_cli', exe),
    onSmoke: (r) => onCliSmoke('antigravity_cli', r),
    onQuota: (q) => onCliQuota('antigravity_cli', q),
  });
  const homeDir = deps.home ?? ((): string => nodeOs.homedir());
  const agyRunning = deps.agyRunning ?? ((): Promise<boolean> => Promise.resolve(jobs.jobPids().cli.length > 0));

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
    // [V2] B12: the two CLI providers (usable() = exe found + floor + consent + a smoke within 24 h)
    makeClaudeCli,
    makeAgy,
    cliStatus,
    jobs,
    now,
    cliRunnerHealth: () => cliRunnerCore.health(), // [v2-repair REQUEST 7]
    onReadiness: () => refreshLlmHealth(), // [v2-repair REQUEST 7]
    closed: () => lifecycle.closing, // [v2-closeout] no provider build / provider-start smoke once the quit began
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
      // [v2-repair REQUEST 7] C2 3: the CLI states (a failed init proof, CLI_UNSTABLE and CLOUD_OVERAGE stay 'failed' + code)
      case 'CLI_NOT_INSTALLED':
      case 'CLI_VERSION':
        return 'not_installed';
      case 'CLI_NOT_SIGNED_IN':
        return 'not_signed_in';
      case 'DOWNLOAD_FAILED':
      case 'DISK_FULL':
        return 'downloading';
      default:
        return 'failed';
    }
  };
  /** [v2-repair REQUEST 7] true once start() ran its recovery pass: only then may refreshLlmHealth release quota-held chats. */
  const llmRelease = { armed: false };
  const refreshLlmHealth = (): void => {
    const s = settings();
    const id = s.llm.provider;
    const usable = providerFactory.usable();
    // [v2-repair REQUEST 7] every provider reports its OWN model id (the CLI ids used to fall through to the Gemini model)
    const model =
      id === 'local'
        ? seamManifest[resolvedTier].label
        : id === 'claude'
          ? s.llm.claudeModel
          : id === 'gemini'
            ? s.llm.geminiModel
            : id === 'claude_cli'
              ? s.llm.cli.claudeModel
              : s.llm.cli.agyModel;
    const issue = id === 'claude_cli' || id === 'antigravity_cli' ? cliIssue.get(id) : undefined;
    // 'idle' = Local configured, llama-server not running (lazy); 'ready' = a cloud provider with a usable key.
    healthHub.setLlm(
      !usable.ok
        ? { state: llmStatusFor(usable.code), code: usable.code, provider: id, model }
        : issue !== undefined
          ? { state: 'failed', code: issue, provider: id, model }
          : { state: id === 'local' ? 'idle' : 'ready', provider: id, model },
    );
    // [v2-repair REQUEST 7] the subscription window reset (usable again): the chats it held as budget/CLOUD_QUOTA go back to the queue
    if (usable.ok && llmRelease.armed) {
      const released = releaseQuotaHeldItems(repos, now());
      if (released.length > 0) {
        notifyChanged(released);
        theQueue.poke();
      }
    }
  };

  // ---------------------------------------------------------------------------------------------------------------
  // 12. agent pipeline: ToolGate -> S0 -> queue -> orchestrator -> items
  // ---------------------------------------------------------------------------------------------------------------
  const gate = createToolGate({
    read: mcpRead,
    // [V2] the WhatsApp READ facade (only compose constructs it, C2 19): available while the user keeps the read tools on and the
    // bridge's messages.db is open (B17).
    wa: createWaReadClient({ bridgeDb, chats: repos.chats, transcripts: repos.transcripts, settings }),
    settings,
    calendarConnected,
    waAvailable: () => settings().whatsapp.readTools.enabled && bridgeDb.open(),
    audit: (kind, ref, detail) => audit(kind, ref, detail, now()),
  });

  // ---- [V2] media: the ONE BridgeReadClient media/fetch.ts uses (B5), normaliser (S-IMAGE), cache ----
  const mediaRead = createBridgeReadClient(() => launcher?.endpoint() ?? null, fetch);
  const clockSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
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
  const mediaFetcher = createMediaFetcher({ read: mediaRead, sleep: clockSleep });
  const sha256Hex = (data: string | Uint8Array): import('../shared/types').Sha256Hex =>
    createHash('sha256').update(data).digest('hex') as import('../shared/types').Sha256Hex;
  /** S-IMAGE: the real nativeImage facade comes from index.ts; without it every picture is rejected 'decode' (fail closed). */
  const imageFacade: ImageFacade = deps.image ?? {
    fromBuffer: () => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      resize() {
        return this;
      },
      toJPEG: () => new Uint8Array(0),
    }),
  };
  const normalizeImage = createImageNormalizer({ image: imageFacade, hash: (b) => sha256Hex(b) });
  const mediaCache: MediaCache = createMediaCache({
    dir: paths.mediaCacheDir,
    repos,
    fs: {
      writeFileSync: (p, data) => nodeFs.writeFileSync(p, data),
      readFileSync: (p) => nodeFs.readFileSync(p),
      rmSync: (p, o) => nodeFs.rmSync(p, o),
      mkdirSync: (p, o) => nodeFs.mkdirSync(p, o),
    },
    hash: (text) => sha256Hex(text),
  });

  // ---- [V2] voice (V0): fetch -> demux -> decode -> WAV -> whisper job -> transcripts row ----
  let transcribingSeconds: number | null = null;
  const pushQueue = (): void => {
    const q = healthHub.get().queue;
    emit('queue:changed', {
      pending: q.pending,
      running: q.running,
      transcribing: transcribingSeconds === null ? null : { seconds: transcribingSeconds },
    });
  };
  const whisperSeam =
    seams === null
      ? null
      : seams.whisperCmd === undefined
        ? undefined
        : {
            command: seams.whisperCmd.command,
            args: [...seams.whisperCmd.args],
            cwd: nodePath.dirname(seams.whisperCmd.args[0] ?? seams.whisperCmd.command),
          };
  const voice: VoiceServiceV2 = createVoiceService({
    repos,
    jobs,
    fetchMedia: mediaFetcher,
    models: { pathOf: (id) => modelManager.readyPath(id) },
    settings,
    clock,
    log,
    paths: { voiceTmpDir: paths.voiceTmpDir, whisperDir: paths.whisperDir, whisperCliExe: paths.whisperCliExe },
    onProgress: (p) => {
      emit('voice:progress', p);
      // [v2-repair REQUEST 5] the orchestrator opens the header line with onTranscribing(0) before the note's duration is known; the
      // seconds arrive here (decided from the last Ogg granule before any decoder runs) and become "Transcribing a voice note (0:03)".
      if (transcribingSeconds !== null && p.audioSeconds > 0 && p.audioSeconds !== transcribingSeconds) {
        transcribingSeconds = p.audioSeconds;
        pushQueue();
      }
    },
    window: (chatId) => mediaWindowFor({ bridgeDb, repos }, chatId, LIMITS.contextMessages),
    // e2e without the whisper command seam: voice is disabled (null = no whisper at all); production: the shipped whisper exe
    ...(whisperSeam === undefined ? (e2e ? { whisperSeam: null } : {}) : { whisperSeam }),
  });
  const voiceReady = (): boolean => {
    try {
      const v = voice.state();
      return v.model?.status === 'ready' && v.vad.status === 'ready';
    } catch {
      return false;
    }
  };
  const refreshVoiceHealth = (): void => {
    let v: ReturnType<VoiceServiceV2['state']>;
    try {
      v = voice.state();
    } catch {
      return;
    }
    const state: import('../shared/health').VoiceStatus = !v.enabled
      ? 'off'
      : transcribingSeconds !== null
        ? 'transcribing'
        : v.model === null
          ? 'off'
          : v.model.status === 'ready' && v.vad.status === 'ready'
            ? 'ready'
            : v.model.status === 'failed'
              ? 'failed'
              : 'downloading';
    healthHub.setVoice({ state });
  };

  // ---- [V2] V1 READ-IMAGE: the picture of a run (pickImage) and the tool-less reading stage (readImage) ----
  const mmprojReady = (): boolean =>
    settings().images.enabled &&
    modelManager.readyPath(resolvedTier) !== null &&
    modelManager.readyPath(MMPROJ_FOR_TIER[resolvedTier]) !== null;
  const pickImageRaw = createPickImage({
    images: () => ({ enabled: settings().images.enabled }),
    chatJidOf: (chatId) => repos.chats.byId(chatId)?.jid ?? null,
    media: mediaFetcher,
    normalize: normalizeImage,
    cache: mediaCache,
    alreadyRead: (chatId, waMsgId) => {
      const row = repos.db
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM proposals p JOIN items i ON i.id = p.item_id
            WHERE i.chat_id = ? AND p.image_json IS NOT NULL AND json_extract(p.image_json, '$.waMsgId') = ?
              AND json_extract(p.image_json, '$.read') IS NOT NULL`,
        )
        .get(chatId, waMsgId);
      return (row?.n ?? 0) > 0;
    },
    audit: (kind, detail) => audit(kind, null, detail, now()),
  });
  /** Links the cached picture to the chat's open item so Dismiss / retention delete its files (mediaCache.deleteForItem). */
  const pickImage = async (
    chatId: import('../shared/types').ChatRef,
    window: readonly import('../shared/types').Message[],
  ): Promise<NormalizedImage | null> => {
    const img = await pickImageRaw(chatId, window);
    if (img === null) return null;
    const row = newestImageRow(window);
    const item = repos.items.openForChat(chatId);
    if (row !== null && item !== null) {
      const cached = repos.mediaCache.get(chatId, row.waMsgId);
      if (cached !== null && cached.itemId !== item.id) repos.mediaCache.upsert({ ...cached, itemId: item.id });
    }
    return img;
  };
  const readImage = createReadImageStage({
    images: () => ({ enabled: settings().images.enabled, cloud: settings().images.cloud }),
    activeProvider: () => providerFactory.get(),
    // B21: the provider's consent at the CURRENT version (whose text names pictures); Local needs none
    consentCurrent: (p) => p === 'local' || repos.consents.isCurrent(CONSENT_KIND_FOR[p]),
    local: { mmprojReady, provider: () => seamProvider?.('local') ?? makeLocal() },
    imagesPassed: (p) => FEATURE_GATES[p].imagesPassed,
    repos,
    clock,
    log,
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
    voiceReady, // [V2] a voice note triggers only when the resolved voice tier + VAD are ready (P2 2 item 1)
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
    // ---- [V2] OrchestratorDepsV2 (v2-build-plan section 3) ----
    voice,
    readImage,
    pickImage,
    tryAuto: (actionId) => executor.tryAuto(actionId),
    onTranscribing: (seconds) => {
      transcribingSeconds = seconds;
      refreshVoiceHealth();
      pushQueue();
    },
    featureGates: (p) => FEATURE_GATES[p],
    updateSurfaceAvailable,
    audioWindow: (chatId) => mediaWindowFor({ bridgeDb, repos }, chatId, LIMITS.contextMessages),
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
  theQueue.onStats((s) => {
    healthHub.setQueue(s);
    pushQueue(); // [V2] queue:changed carries the transcribing seconds for the header line
  });
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
    updatesAvailable: updateSurfaceAvailable, // [V2] B4
    mediaCache, // [V2] thumbnails + item:getImage
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

  /** C2 5 AutoSnapshotInput -> auto_policies.snapshot_sha (see createAutoSnapshotSha; auto-mode-6: survives restarts, '' when unknown). */
  const snapshotSha = createAutoSnapshotSha({
    accountEmail: () => googleAuth.wizardState().accountEmail,
    meta: repos.meta,
    targetCalendarId: () => settings().calendar.targetCalendarId,
    provider: () => settings().llm.provider,
    appVersion: version,
  });
  /** RFC 4122 v4 from S-RAND bytes (auto_decisions / auto_writes ids). */
  const randomUuidOf = (bytes: Uint8Array): string => {
    const b = Array.from(bytes.slice(0, 16));
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const hex = b.map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  };

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
    // ---- [V2] C2 14 ----
    updateSurfaceAvailable,
    autoGate: evaluateAutoGate,
    snapshotSha,
    notifyAuto: (e) => {
      emitAutoChanged();
      if (e.autoWriteId === undefined) return;
      const w = repos.autoWrites.byId(e.autoWriteId);
      if (w === null) return;
      if (e.kind === 'write') {
        notifier.autoWrite({ kind: w.kind, autoWriteId: w.id, burstCount: 0, itemId: w.itemId });
      } else if (e.kind === 'undo') {
        if (toastUndos.has(w.id)) toastUndos.set(w.id, true); // [v2-fix auto-mode-1] the toast's onUndo must not toast again
        notifier.autoUndone(w.undoState === 'undone');
      }
    },
    randomUuid: () => randomUuidOf(random.bytes(16)),
    featureGates: (p) => FEATURE_GATES[p],
    calendarRoles,
  });

  // ---- [V2] automatic mode: the main-owned native dialog (S-DIALOG / WCA_DIALOG_SCRIPT), the policy service, undo ----
  const showMessageBox: ShowMessageBoxFn =
    deps.dialog ??
    ((): Promise<{ response: number; checkboxChecked: boolean }> =>
      Promise.resolve({ response: 0, checkboxChecked: false })); // no dialog facade => every question answers Cancel
  const autoDialog: AutoDialog = createAutoDialog({
    showMessageBox,
    t: () => t,
    ...(seams?.dialogScript === undefined ? {} : { script: seams.dialogScript }),
  });
  /** The dialog parent: the attached main window (never a renderer-supplied value). */
  const dialogParent = (): unknown => windowRef;
  let lastFocusAt: EpochMs | null = null;
  const autoPolicy: AutoPolicyService = createAutoPolicyService({
    repos,
    clock,
    random,
    dialog: autoDialog,
    rate: {
      record: (bucket, key, at) => repos.rate.record(bucket, key, at),
      countSince: (bucket, key, since) => repos.rate.countSince(bucket, key, since),
    },
    calendarRoles,
    updateSurfaceAvailable,
    snapshotSha,
    audit: (kind, ref, detail) => audit(kind, ref, detail, now()),
    notify: () => emitAutoChanged(),
    calendarConnected,
    calendarName: () => '', // no calendar display name is stored main-side (REQUEST in V2-W2-01 notes); the dialog still names the account's calendar generically
    versions: () => ({ app: version, electron: process.versions.electron ?? '' }),
    lastFocusAt: () => lastFocusAt,
    onAppPause: () => notifier.autoPolicy('paused'),
    onExpiring: () => notifier.autoExpiring(),
  });
  v2Late.autoPolicy = autoPolicy;
  const undo = createUndo({
    repos,
    executor,
    clock,
    audit: (kind, ref, detail) => audit(kind, ref, detail, now()),
    windowState: () => runtimeWindowState(),
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
  /** [V2] the onboarding "Voice notes" line from the voice service (numbers and enums only). */
  const voiceChecklist = (): { voice: 'off' | 'downloading' | 'ready'; voicePercent: number | null } => {
    try {
      const v = voice.state();
      if (!v.enabled || v.model === null) return { voice: 'off', voicePercent: null };
      if (v.model.status === 'ready' && v.vad.status === 'ready') return { voice: 'ready', voicePercent: null };
      if (v.model.status === 'downloading' || v.model.status === 'paused' || v.model.status === 'verifying')
        return {
          voice: 'downloading',
          voicePercent: v.model.sizeBytes > 0 ? Math.round((v.model.bytesDone / v.model.sizeBytes) * 100) : null,
        };
      return { voice: 'off', voicePercent: null };
    } catch {
      return { voice: 'off', voicePercent: null };
    }
  };
  const onboardingState = (): OnboardingState => {
    const s = settings();
    const step = onboardingStep();
    const aiReady =
      s.llm.provider === 'local'
        ? modelManager.readyPath(resolvedTier) !== null
        : s.llm.provider === 'claude_cli' || s.llm.provider === 'antigravity_cli'
          ? providerFactory.usable().ok // [V2] B12: exe + floor + consent + a smoke within 24 h
          : secrets.has(s.llm.provider === 'claude' ? 'anthropic_api_key' : 'gemini_api_key').present;
    const mcp = mcpHost.status();
    return {
      step,
      checklist: {
        ai: aiReady ? 'ready' : downloadPercent === null ? 'pending' : 'downloading',
        aiPercent: aiReady ? null : downloadPercent,
        whatsapp: bridgeOnline() ? 'ready' : 'pending',
        ...voiceChecklist(), // [V2] C2 1.5
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

  // ---- [V2] the collaborators HandlerDepsV2 carries (v2-build-plan section 3) ----
  const agyWorkspace = createAgyWorkspace({
    home: homeDir,
    proc: agyRunning,
    fs: {
      readFileSync: (p, enc) => nodeFs.readFileSync(p, enc),
      writeFileSync: (p, text) => nodeFs.writeFileSync(p, text, 'utf8'),
      existsSync: (p) => nodeFs.existsSync(p),
    },
    userDataDir: paths.userData,
    mkdirSync: (p, o) => {
      nodeFs.mkdirSync(p, o);
    },
  });
  /** S-CONSOLE: production spawns the vendor exe in its own visible console; an e2e build only RECORDS the argv (T2 4.2). */
  const consoleCalls: string[][] = [];
  /** [D-080] WCA_CONSOLE_DIR: the e2e recorder is TRACKED - it writes console-<n>.json ({argv, cwd, env}: what production would have
   *  spawned; nothing is spawned) and its `exited` resolves once the spec writes console-<n>.exit ("the window was closed"). */
  const consoleDir = seams?.consoleDir;
  const trackedE2eConsole = (
    dir: string,
    n: number,
    argv: string[],
    opts: { cwd?: string; env?: Record<string, string> },
  ): import('./deps').VisibleConsoleHandle => {
    const base = nodePath.join(dir, `console-${String(n)}`);
    nodeFs.writeFileSync(
      `${base}.json`,
      JSON.stringify({ argv, cwd: opts.cwd ?? null, env: opts.env ?? null }),
      'utf8',
    );
    const exited = new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (lifecycle.closing || nodeFs.existsSync(`${base}.exit`)) {
          clearInterval(poll);
          resolve();
        }
      }, 200);
      poll.unref();
    });
    return { exited };
  };
  const cliConsole: import('./deps').OpenVisibleConsoleFn =
    deps.console ??
    (e2e
      ? async (exe, args, opts) => {
          consoleCalls.push([exe, ...args]);
          if (consoleDir === undefined) return; // untracked recorder (T2 4.2)
          return trackedE2eConsole(consoleDir, consoleCalls.length, [exe, ...args], opts);
        }
      : createOpenVisibleConsole({ spawn }));
  const handlerDepsV2: HandlerDepsV2 = {
    ...handlerDeps,
    autoPolicy,
    undo,
    cliStatus,
    cliConsole,
    agyWorkspace,
    voice,
    mediaCache,
    jobs,
  };
  /** `llm:listModels {provider:'antigravity_cli'}`: `agy models` under the isolated profile; an empty list keeps the current setting. */
  const listAgyModelsNow = async (): Promise<string[]> => {
    if (lifecycle.closing) return []; // [v2-closeout] `agy models` is a CLI job: none once the quit began
    const loc = await cliLocator.find('antigravity_cli').catch(() => null);
    if (loc === null) return [];
    recordCliExePath('antigravity_cli', loc.exePath);
    return listAgyModels(cliRunner, {
      jobs,
      exePath: loc.exePath,
      userDataDir: paths.userData,
      processEnv: cliEnv,
      argsPrefix: seamArgsPrefix(cliSeam, loc.exePath),
    });
  };
  const cliHandlers = createCliHandlers({
    ...handlerDepsV2,
    cliLocator,
    cliRunner,
    autoDialog,
    window: dialogParent,
    ...(deps.pickExePath === undefined ? {} : { pickExePath: deps.pickExePath }),
    homeDir,
    agyRunning,
    agySettingsExists: () =>
      nodeFs.existsSync(nodePath.win32.join(homeDir(), '.gemini', 'antigravity-cli', 'settings.json')),
    makeAgyForTest: (exePath, observedVersion) =>
      createAgyProvider({
        runner: cliRunner,
        locator: cliLocator,
        model: settings().llm.cli.agyModel,
        exePath,
        userDataDir: paths.userData,
        observedVersion,
        now,
      }),
    // [D-080] the guided sign-in session: the isolated agy profile, the runs' env source, the cli:changed push, the quit guard
    userDataDir: paths.userData,
    processEnv: cliEnv,
    emitCliChanged: (s) => emit('cli:changed', s),
    closed: () => lifecycle.closing,
  });
  /** [v2-repair REQUEST 13] llm:setProvider's smoke for a never/stale-tested CLI: the cli:test handler itself (same consent, same
   *  locator, same recorder), refused while the runner breaker is open (that IS "keeps stopping", reset only by a Test-again click). */
  const runCliTest = async (provider: CliProviderId): Promise<import('../shared/types').Result<unknown>> => {
    if (cliRunner.breakerOpen()) return { ok: false, error: { code: 'CLI_UNSTABLE' } };
    return cliHandlers['cli:test'](
      { provider },
      { windowFocused: true, windowVisible: true, shownByNotificationAt: null },
    );
  };
  const baseHandlers: IpcHandlers = mergeHandlerGroups([
    createAppHandlers(handlerDepsV2),
    createItemsHandlers(handlerDepsV2, { undo }),
    createActionsHandlers(handlerDepsV2),
    createSettingsHandlers(handlerDepsV2, { voice, autoDialog, dialogParent }),
    createSecretsHandlers(handlerDepsV2),
    createLlmHandlers(handlerDepsV2, { cliStatus, listAgyModels: listAgyModelsNow, runCliTest }),
    createModelHandlers(handlerDepsV2),
    createPairingHandlers(handlerDepsV2),
    createGoogleHandlers(handlerDepsV2),
    createDataHandlers(handlerDepsV2, { autoPolicy }),
    createAutoHandlers(handlerDepsV2, { dialogParent }),
    cliHandlers,
    createVoiceHandlers(handlerDepsV2),
  ]);

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
    // [V2] B19: Dismiss deletes the item's cached picture + thumbnail at once (mediaCache.deleteForItem), after the dismiss itself.
    'item:dismiss': async (req, ctx) => {
      const res = await baseHandlers['item:dismiss'](req, ctx);
      if (res.ok) {
        try {
          mediaCache.deleteForItem(req.itemId);
        } catch (err) {
          log.warn('media_cache_delete_failed', { reason: err instanceof Error ? err.name : 'unknown' });
        }
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
      cliIssue.clear(); // [v2-repair REQUEST 7] a provider switch re-proves the CLI from scratch
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
    refreshVoiceHealth(); // [V2] voice.enabled / tier
    emitAutoChanged(); // [V2] a settings change can move an automatic-mode precondition
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

    // [V2-W2-01] The two passes above run before the calendar child exists, so a calendar-side unknown_outcome (a create, or an
    // update_event whose PATCH may have landed - crash_after_patch) could not be read yet. Now that the calendar is connected,
    // one more READ-ONLY pass (get-event / findAppEvent only - never list-events, never a re-patch) resolves what really landed.
    if (calendarConnected()) {
      await reconcileUnknown({
        repos,
        bridgeDb: bridgeDb.open() ? bridgeDb : null,
        read: mcpRead,
        now,
        timeZone: () => settings().general.timeZone,
      }).catch((err: unknown) => {
        log.warn('reconcile_failed', { reason: err instanceof Error ? err.name : 'unknown' });
        return undefined;
      });
      if (abortStart('reconcile_calendar')) return;
    }
    // Only now, after EVERY reconcile pass, is it known which recovered actions are genuinely unresolved. Those get a
    // fresh pending clone so the card offers "Send again" / "Add again" - a new approval, never a replay (TESTS 6).
    const clones = executor.offerRetryForUnknown();
    if (clones > 0) log.info('recovery_retry_offered', { clones });

    llmRelease.armed = true; // [v2-repair REQUEST 7]
    refreshLlmHealth();
    refreshVoiceHealth(); // [V2]
    healthHub.setCalendarUpdates(updateSurfaceAvailable()); // [V2] after the calendar startup guard ran
    emitAutoChanged(); // [V2] AppHealth.auto + the tray line from the stored policy
    applyAutostart({ electron, enabled: settings().general.autostart, isPackaged });

    theQueue.setPaused(settings().agent.paused);
    theQueue.start();
    later.pokeIngest();

    // periodic work
    every(LIMITS.scanIntervalMs, () => ingest?.poke());
    // [v2-repair REQUEST 7] time-based provider states (a usage window resetting at resetsAt) reach AppHealth + release held chats
    every(LIMITS.scanIntervalMs, () => refreshLlmHealth());
    every(JANITOR_INTERVAL_MS, () => {
      try {
        runMediaJanitor({ storeDir: paths.bridgeStoreDir, now, maxAgeDays: MEDIA_MAX_AGE_DAYS });
      } catch {
        /* the store may not exist yet */
      }
    });
    // [V2] B7: expiry, the 7-day unattended pause and the expiry reminder of automatic mode
    every(AUTO_TICK_MS, () => {
      autoPolicy.tick(now());
    });
    every(RETENTION_INTERVAL_MS, () => {
      const run = runRetention({ repos, settings, now });
      // [V2] C2 16.1: the purged media_cache rows' files are unlinked here (the DB job only names them)
      for (const name of run.mediaFiles) {
        if (nodePath.basename(name) !== name || name.includes('..')) continue; // plain file names only
        try {
          nodeFs.rmSync(nodePath.join(paths.mediaCacheDir, name), { force: true });
        } catch {
          /* already gone */
        }
      }
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
    lifecycle.closing = true; // [v2-closeout] before the first await: no new CLI job is even attempted from here on
    for (const handle of timers) clock.clearTimeout(handle);
    timers.clear();
    if (dashboardTimer !== null) clock.clearTimeout(dashboardTimer);
    notifier.dispose();
    await runQuitSequence({
      setQuitting: () => undefined, // index.ts flips its own flag before calling shutdown()
      stopQueue: async () => {
        theQueue.abortInFlight();
        // [v2-closeout] stop() stops the queue synchronously and then AWAITS the in-flight run. A run waiting on a job that its abort
        // signal does not reach (a provider-start smoke hanging after init: the smoke has its own wall clock) blocked this step until
        // the whole quit timed out, and app.exit() then left that job and its pid file behind - killJobs never ran. So the jobs die
        // while the run is awaited (the JobRunner latches first; the killJobs step below is then a no-op that re-asserts it).
        const stopping = theQueue.stop();
        await jobs.killAll();
        await stopping;
      },
      killJobs: () => jobs.killAll(), // [V2] B2: every whisper / CLI job dies BEFORE the supervised children
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
    // [V2] B11: the automatic-mode line, from the live policy (absent when there is none)
    let auto: TrayState['auto'] = null;
    try {
      const p = autoPolicy.getState().policy;
      if (p !== null && (p.state === 'on' || p.state === 'shadow' || p.state === 'paused'))
        auto = { state: p.state, pausedReason: p.pausedReason };
    } catch {
      auto = null;
    }
    return {
      health: h,
      paused: h.paused,
      waiting: counts.needsReply + counts.infoMissing,
      setupDone: onboardingStep() === 'done',
      auto,
    };
  };

  /** The tray's automatic-mode line (B11): pause / disable from main (no window, no dialog), or open the settings group. */
  const trayAuto = (action: 'pause' | 'disable' | 'open'): void => {
    if (action === 'pause') autoPolicy.pause('user');
    else if (action === 'disable') autoPolicy.disable('user');
    else {
      showWindow();
      emit('navigate', { view: 'settings' });
    }
  };

  /** `RegisterIpcOptions.windowState`, sampled once per invoke; a focused sample also feeds the unattended pause (B7). */
  function runtimeWindowState(): IpcContext {
    const live = windowRef !== null && !windowRef.isDestroyed() ? windowRef : null;
    const windowVisible = live !== null && live.isVisible();
    // TESTS 4.2 `WCA_FOCUS_CHECK=visible-only`: Windows foreground-lock makes `isFocused()` flaky under automation,
    // so an e2e run may treat a VISIBLE window as focused. The hidden-window rejection is untouched (it is
    // `windowVisible` that carries it), and the seam is unreachable in production (`seams` is null there).
    const windowFocused = visibleOnlyFocus ? windowVisible : live !== null && live.isFocused();
    if (windowFocused && windowVisible) lastFocusAt = now();
    return { windowFocused, windowVisible, shownByNotificationAt: notifier.shownByNotificationAt() };
  }

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
    windowState: runtimeWindowState,
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
    jobPids: () => jobs.jobPids(),
    dialogs: () => autoDialog.recorded(),
    consoles: () => consoleCalls.map((c) => [...c]),
    trayAuto,
    noteFocus: () => {
      lastFocusAt = now();
    },
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
