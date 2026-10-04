// src/main/ipc/register.ts - registers every IPC channel with sender check + zod parse + focus gate + audit (build-plan section 3;
// owner W1-13; v2 deltas V2-W1-10-main-platform: FOCUS_GATED_CHANNELS, the v2 handler-deps types).
// One of the five files allowed to import `electron` (types only here; the value comes in by injection so vitest uses the mock).
import type { IpcMain } from 'electron';
import {
  FOCUS_GATED_CHANNELS,
  IPC_CHANNELS,
  IPC_REQUEST_SCHEMAS,
  type IpcChannel,
  type IpcHandlers,
  type IpcContext,
} from '../../shared/ipc';
import { LIMITS, type AppError, type AuditEntry, type AuditKind, type EpochMs, type Result } from '../../shared/types';
import type { ErrorCode } from '../../shared/errors';
import type { Settings, SettingsPatch } from '../../shared/settings';
import type { Clock, ElectronFacade, Logger } from '../deps';
import type { AppPaths } from '../paths';
import type { Repos } from '../db/index';
import type { SecretStore } from '../secrets';
import type { HealthHub } from '../health/healthHub';
import type { ItemService } from '../agent/items';
import type { TriageQueue } from '../agent/queue';
import type { ActionExecutor } from '../exec/actionExecutor';
import type { BridgeLauncher } from '../bridge/launcher';
import type { GoogleAuthService } from '../mcp/googleAuth';
import type { ModelManager } from '../llm/local/download';
import type { ProviderFactory } from '../llm/types';
import type { IpcEventLike } from './sender';

/**
 * Settings bus: read + patch + change notifications (repos.settings behind an event).
 *
 * The handler files own NO side effect. The language switch (`ui:languageChanged` + the main-process i18n), the tray
 * rebuild and the autostart registration are driven by `onChange`, which `compose.ts` subscribes once - so `patch()` and
 * `setInternal()` MUST notify every `onChange` subscriber after a successful write (W2-01 implements this bus).
 */
export interface SettingsBus {
  get(): Settings;
  /** Renderer-originated patch: only `SettingsPatchSchema` members (register.ts strict-parses first). Throws if the MERGED object is invalid. */
  patch(p: SettingsPatch): Settings;
  /** Main-only write for the fields no renderer may set: `llm.provider`, `agent.paused`, `llm.local.forceCpu`, `[R2]` `general.timeZone`. */
  setInternal(mut: (s: Settings) => void): Settings;
  onChange(cb: (s: Settings) => void): () => void;
}
/** Everything a handler file may need; each createXHandlers picks what it uses. */
export interface HandlerDeps {
  repos: Repos;
  items: ItemService;
  executor: ActionExecutor;
  launcher: BridgeLauncher;
  googleAuth: GoogleAuthService;
  modelManager: ModelManager;
  providerFactory: ProviderFactory;
  secrets: SecretStore;
  healthHub: HealthHub;
  queue: TriageQueue;
  settings: SettingsBus;
  electron: ElectronFacade;
  paths: AppPaths;
  clock: Clock;
  log: Logger;
  audit: (kind: AuditKind, ref: string | null, detail: AuditEntry['detail'], now: EpochMs) => void;
  version: string;
  links: Record<string, string>; // resources/links.json (keys == EXTERNAL_TARGETS)
  /** llm helpers injected so handlers never construct SDK clients themselves. */
  llm: {
    validateKey: (provider: 'claude' | 'gemini', apiKey: string, signal: AbortSignal) => Promise<{ model: string }>;
    listModels: (
      provider: 'claude' | 'gemini',
      apiKey: string,
      signal: AbortSignal,
    ) => Promise<Array<{ id: string; displayName: string }>>;
    hardware: () => Promise<import('../../shared/types').HardwareInfo>;
    selfTest: () => Promise<{ ok: boolean; tokPerSec: number | null; usedCpuFallback: boolean }>;
  };
  onboarding: {
    getState(): import('../../shared/types').OnboardingState;
    setStep(step: import('../../shared/types').OnboardingStep): import('../../shared/types').OnboardingState;
  };
  showWindow: () => void;
  exportDiagnostics: () => Promise<boolean>; // save dialog in main; redacted bundle
}
// ======================= [V2 ADD] v2-build-plan section 3 seam (V2-W0-scaffold; owner V2-W1-10-main-platform, wired by V2-W2-01) =======================
/** The collaborators the v2 handler files (auto / cli / voice and the item + settings deltas) need on top of HandlerDeps. */
export type HandlerDepsV2 = HandlerDeps & {
  autoPolicy: import('../exec/autoPolicy').AutoPolicyService;
  undo: import('../exec/undo').Undo;
  cliStatus: import('../llm/cli/locator').CliStatusService;
  cliConsole: import('../deps').OpenVisibleConsoleFn /* S-CONSOLE */;
  agyWorkspace: import('../llm/cli/antigravityCli').AgyWorkspace;
  voice: import('../voice/service').VoiceServiceV2;
  mediaCache: import('../media/mediaCache').MediaCache;
  jobs: import('../proc/jobRunner').JobRunner;
};

// ======================= [V2 ADD] V2-W1-10-main-platform: v2 collaborators of the v1 handler files =======================
// Passed as an OPTIONAL second argument of createItemsHandlers / createSettingsHandlers / createLlmHandlers / createDataHandlers so
// the Wave-0 compose.ts keeps compiling unchanged; `createIpcHandlers()` (register.handlers.ts) passes them all. An absent member
// fails CLOSED in its handler (INTERNAL for a missing collaborator, never a silent success, never a skipped precondition).
/** item:undoChange / item:restoreOriginal / item:cancelEvent (V2-W1-04's exec/undo.ts). */
export interface ItemsHandlersV2 {
  undo: Pick<import('../exec/undo').Undo, 'undoChange' | 'restoreOriginal' | 'cancelEvent'>;
}
/** wa:setReadScope's native confirmation (V2-W1-04's app/autoDialog.ts) + settings:set's voice precondition (V2-W1-07). */
export interface SettingsHandlersV2 {
  voice: Pick<import('../voice/service').VoiceServiceV2, 'state'>;
  autoDialog: Pick<import('../app/autoDialog').AutoDialog, 'confirmSetting'>;
  /** The focused BrowserWindow the native dialog is parented to (main-side; the renderer never names a window). */
  dialogParent: () => unknown;
}
/** llm:setProvider / llm:listModels for the CLI ids (V2-W1-06's CliStatusService, V2-W1-09's `agy models`). */
export interface LlmHandlersV2 {
  cliStatus: Pick<import('../llm/cli/locator').CliStatusService, 'get'>;
  listAgyModels: () => Promise<string[]>;
}
/** data:purgeNow additionally disables a live automatic policy (`disabled_reason 'purge'`, C2 16.1) and wipes the v2 dirs. */
export interface DataHandlersV2 {
  autoPolicy: Pick<import('../exec/autoPolicy').AutoPolicyService, 'disable'>;
}

export interface RegisterIpcOptions {
  isTrusted: (event: IpcEventLike) => boolean; // sender.ts isTrustedSender bound to the window ref
  windowState: () => IpcContext; // windowFocused / windowVisible / shownByNotificationAt sampled at call time
  audit: HandlerDeps['audit'];
  now: () => EpochMs;
  log: Logger;
}

// ---------------------------------------------------------------------------------------------------------------------
// Result helpers - shared by every handler file so a handler body is one expression and never throws.
// ---------------------------------------------------------------------------------------------------------------------

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}
/** `params` carries i18n interpolation values only (numbers / enum codes) - never message text, names, JIDs or paths. */
export function fail<T = never>(code: ErrorCode, params?: AppError['params']): Result<T> {
  return { ok: false, error: params === undefined ? { code } : { code, params } };
}
/** Why a call was refused before the handler ran. Enum-only: an audit detail never carries renderer-supplied text. */
export type RejectReason = 'untrusted_sender' | 'bad_payload' | 'window_state' | 'window_not_focused';

/** The one response a refused call ever gets: the renderer learns nothing about which check failed. */
const BAD_REQUEST: Result<never> = { ok: false, error: { code: 'BAD_REQUEST' } };
const INTERNAL: Result<never> = { ok: false, error: { code: 'INTERNAL' } };
/** [V2] The focus gate's answer - the only refusal the renderer may tell apart, because its fix is the user's ("click the window"). */
const WINDOW_NOT_FOCUSED: Result<never> = { ok: false, error: { code: 'WINDOW_NOT_FOCUSED' } };

/**
 * [V2] C2 8 / C2 19 item 24: EXACTLY these channels need a focused + visible window and the focus-steal guard (a click that lands
 * within LIMITS.focusGuardMainMs after a toast click showed the window is not counted). `auto:disable` / `auto:pause` are
 * deliberately absent: the fail-safe direction works from anywhere. No other channel is gated - the set is the list, verbatim.
 */
export const FOCUS_GATED: ReadonlySet<IpcChannel> = new Set<IpcChannel>(FOCUS_GATED_CHANNELS);

/** Pure: true when the sampled window state lets a focus-gated call through at `now`. */
export function passesFocusGate(ctx: IpcContext, now: EpochMs): boolean {
  if (!ctx.windowFocused || !ctx.windowVisible) return false;
  // Focus-steal guard: main itself just raised the window from a notification; the click may be aimed at what was there before.
  if (ctx.shownByNotificationAt !== null && ctx.shownByNotificationAt + LIMITS.focusGuardMainMs > now) return false;
  return true;
}

/**
 * For every channel: untrusted sender => audit 'ipc_rejected' + {ok:false, BAD_REQUEST}; zod parse of IPC_REQUEST_SCHEMAS[channel];
 * handler exceptions => INTERNAL (never the message). Returns an unregister function.
 */
export function registerIpc(
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>,
  handlers: IpcHandlers,
  opts: RegisterIpcOptions,
): () => void {
  const registered: IpcChannel[] = [];

  const reject = (channel: IpcChannel, reason: RejectReason): Result<never> => {
    opts.audit('ipc_rejected', channel, { reason }, opts.now());
    opts.log.warn('ipc_rejected', { channel, reason });
    return BAD_REQUEST;
  };

  for (const channel of IPC_CHANNELS) {
    const handler = handlers[channel] as (req: unknown, ctx: IpcContext) => Promise<Result<unknown>> | Result<unknown>;
    const schema = IPC_REQUEST_SCHEMAS[channel];

    ipcMain.handle(channel, async (event: unknown, payload?: unknown): Promise<Result<unknown>> => {
      if (!opts.isTrusted(event as IpcEventLike)) return reject(channel, 'untrusted_sender');

      // `.strictObject` everywhere in IPC_REQUEST_SCHEMAS: an extra key is a rejected payload, not a stripped one.
      const parsed = schema.safeParse(payload);
      if (!parsed.success) return reject(channel, 'bad_payload');

      let ctx: IpcContext;
      try {
        ctx = opts.windowState();
      } catch {
        return reject(channel, 'window_state');
      }

      if (FOCUS_GATED.has(channel) && !passesFocusGate(ctx, opts.now())) {
        opts.audit('ipc_rejected', channel, { reason: 'window_not_focused' }, opts.now());
        opts.log.warn('ipc_rejected', { channel, reason: 'window_not_focused' });
        return WINDOW_NOT_FOCUSED;
      }

      try {
        return await handler(parsed.data, ctx);
      } catch (e) {
        // The message of a thrown error can echo model output, a provider body or a path: only the channel is recorded.
        opts.log.error('ipc_handler_threw', { channel, name: e instanceof Error ? e.name : 'unknown' });
        return INTERNAL;
      }
    });
    registered.push(channel);
  }

  return () => {
    for (const channel of registered) ipcMain.removeHandler(channel);
    registered.length = 0;
  };
}
