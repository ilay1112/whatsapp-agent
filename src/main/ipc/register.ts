// src/main/ipc/register.ts - registers every IPC channel with sender check + zod parse + audit (build-plan section 3; owner W1-13).
// One of the five files allowed to import `electron` (types only here; the value comes in by injection so vitest uses the mock).
import type { IpcMain } from 'electron';
import {
  IPC_CHANNELS,
  IPC_REQUEST_SCHEMAS,
  type IpcChannel,
  type IpcHandlers,
  type IpcContext,
} from '../../shared/ipc';
import type { AppError, AuditEntry, AuditKind, EpochMs, Result } from '../../shared/types';
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
export type RejectReason = 'untrusted_sender' | 'bad_payload' | 'window_state';

/** The one response a refused call ever gets: the renderer learns nothing about which check failed. */
const BAD_REQUEST: Result<never> = { ok: false, error: { code: 'BAD_REQUEST' } };
const INTERNAL: Result<never> = { ok: false, error: { code: 'INTERNAL' } };

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
