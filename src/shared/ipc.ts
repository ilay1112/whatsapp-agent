// src/shared/ipc.ts
import { z } from 'zod';
import {
  ACTION_KINDS,
  CHAT_POLICIES,
  CONSENT_KINDS,
  MODEL_TIERS,
  ONBOARDING_STEPS,
  SECRET_NAMES,
  LIMITS,
} from './types';
import type {
  Bootstrap,
  DashboardData,
  ItemCard,
  ItemDetail,
  ChatView,
  ConsentState,
  HardwareInfo,
  LlmConfig,
  ModelOption,
  ModelPlan,
  DownloadProgress,
  OnboardingState,
  GoogleWizardState,
  CalendarInfo,
  KeyStatus,
  BusyBlock,
  Lang,
  Dir,
  ItemId,
  Result,
  EpochMs,
} from './types';
import type { AppHealth, PairingState } from './health';
import { SettingsPatchSchema, type Settings } from './settings';
import { EventEditSchema, ReplyEditSchema } from './schemas';

// ---------- request schemas ----------
const NoReq = z.undefined();
const ItemIdReq = z.strictObject({ itemId: z.number().int().positive() });
const ConfirmReq = z.strictObject({ confirm: z.literal(true) });
const CloudProviderReq = z.strictObject({ provider: z.enum(['claude', 'gemini']) });
const TierReq = z.strictObject({ tier: z.enum(MODEL_TIERS).optional() }); // omitted = currently selected tier

export const ApproveReqSchema = z
  .strictObject({
    actionId: z.uuid(),
    kind: z.enum(ACTION_KINDS),
    shownHash: z.string().regex(/^[0-9a-f]{64}$/),
    edit: z.union([ReplyEditSchema, EventEditSchema]).optional(),
    confirmConflict: z.literal(true).optional(),
    confirmDuplicate: z.literal(true).optional(),
  })
  .superRefine((r, ctx) => {
    if (r.edit && 'text' in r.edit !== (r.kind === 'send_reply'))
      ctx.addIssue({ code: 'custom', message: 'edit/kind mismatch' });
    if (r.kind === 'send_reply' && (r.confirmConflict || r.confirmDuplicate))
      ctx.addIssue({ code: 'custom', message: 'confirm flags are create_event only' });
  });
export type ApproveReq = z.infer<typeof ApproveReqSchema>;

export const EXTERNAL_TARGETS = [
  'gcp_new_project',
  'gcp_enable_calendar_api',
  'gcp_oauth_consent',
  'gcp_create_credentials',
  'gcp_publish_app',
  'anthropic_api_keys',
  'gemini_api_keys',
  'whatsapp_linked_devices_help',
  'antivirus_help',
  'bridge_update_help',
  'bitlocker_help',
  'google_unverified_app_help',
  'project_readme',
  'vcredist_download',
] as const; // keys of resources/links.json (parity test) ; [R2] vcredist_download = https://aka.ms/vs/17/release/vc_redist.x64.exe (a Microsoft page opened in the browser)
export type ExternalTarget = (typeof EXTERNAL_TARGETS)[number];
/** [R2] external:open {itemId, target:'calendarEvent'}: main NEVER opens a server-supplied link. It builds
 *  `https://calendar.google.com/calendar/r/day/${YYYY}/${MM}/${DD}` from items.event_start_ts in settings.general.timeZone (Intl, 'en-CA' parts) and opens that. */

export const VIEWS = ['dashboard', 'settings', 'onboarding', 'tray_hint'] as const;
export type View = (typeof VIEWS)[number]; // 'tray_hint' = the coach mark shown the FIRST time the window is opened after a hide-to-tray ([R2]: X always hides at once)

export const IPC_REQUEST_SCHEMAS = {
  'app:getBootstrap': NoReq,
  'app:ackTrayHint': NoReq, // [C+]
  'health:get': NoReq,
  'dashboard:get': NoReq,
  'dashboard:getIgnored': NoReq, // [C+]
  'item:get': ItemIdReq,
  'item:dismiss': ItemIdReq,
  'item:restore': ItemIdReq,
  'item:retriage': ItemIdReq,
  'item:setEditing': z.strictObject({ itemId: z.number().int().positive(), editing: z.boolean() }),
  'item:completeEvent': z.strictObject({ itemId: z.number().int().positive(), event: EventEditSchema }), // [C+]
  'action:approve': ApproveReqSchema,
  'action:reject': z.strictObject({ actionId: z.uuid() }),
  'agent:setPaused': z.strictObject({ paused: z.boolean() }),
  'chat:setPolicy': z.union([
    z.strictObject({ chatRef: z.number().int().positive(), policy: z.enum(CHAT_POLICIES) }),
    z.strictObject({ chatRef: z.number().int().positive(), forceKnown: z.literal(true) }),
  ]),
  'chat:listPolicies': NoReq, // [C+]
  'clipboard:writeText': z.strictObject({ text: z.string().min(1).max(LIMITS.clipboardChars) }), // [C+]
  'onboarding:getState': NoReq,
  'onboarding:setStep': z.strictObject({ step: z.enum(ONBOARDING_STEPS) }),
  'consent:get': z.strictObject({ kind: z.enum(CONSENT_KINDS) }),
  'consent:accept': z.strictObject({ kind: z.enum(CONSENT_KINDS), version: z.number().int().positive() }),
  // [R2] handler REJECTS version !== CONSENT_VERSIONS[kind] with BAD_REQUEST + audit ipc_rejected (no pre-accepting future bumps)
  'pairing:get': NoReq,
  'pairing:newCode': NoReq,
  'pairing:relink': ConfirmReq,
  'pairing:unlinkAndWipe': ConfirmReq,
  'llm:getHardware': NoReq,
  'llm:getConfig': NoReq,
  'llm:setProvider': z.strictObject({ provider: z.enum(['local', 'claude', 'gemini']) }),
  'llm:validateKey': CloudProviderReq,
  'llm:listModels': CloudProviderReq,
  'secrets:set': z.strictObject({
    name: z.enum(SECRET_NAMES),
    value: z
      .string()
      .min(8)
      .max(512)
      .regex(/^[\x21-\x7E]+$/),
  }),
  'secrets:has': z.strictObject({ name: z.enum(SECRET_NAMES) }),
  'secrets:clear': z.strictObject({ name: z.enum(SECRET_NAMES) }),
  'model:getPlan': NoReq,
  'model:startDownload': TierReq,
  'model:pause': TierReq,
  'model:resume': TierReq,
  'model:cancel': TierReq,
  'model:delete': TierReq,
  'model:selfTest': NoReq,
  'google:getWizardState': NoReq,
  'google:pickCredentialsFile': NoReq, // native dialog opened IN MAIN
  'google:importCredentials': z.strictObject({ jsonText: z.string().min(2).max(LIMITS.credentialsJsonBytes) }), // file CONTENT, never a path
  'google:startSignIn': NoReq,
  'google:status': NoReq,
  'google:disconnect': ConfirmReq,
  'google:listCalendars': NoReq,
  'settings:get': NoReq,
  'settings:set': SettingsPatchSchema,
  'external:open': z.union([
    z.strictObject({ target: z.enum(EXTERNAL_TARGETS) }),
    z.strictObject({ itemId: z.number().int().positive(), target: z.literal('calendarEvent') }),
  ]),
  'data:purgeNow': ConfirmReq,
  'diagnostics:export': NoReq, // save dialog opened IN MAIN
} as const;

export type IpcChannel = keyof typeof IPC_REQUEST_SCHEMAS;
export const IPC_CHANNELS = Object.keys(IPC_REQUEST_SCHEMAS) as IpcChannel[];
export type IpcReq<C extends IpcChannel> = z.infer<(typeof IPC_REQUEST_SCHEMAS)[C]>;

// ---------- response types ----------
export type ApproveOutcome =
  | { outcome: 'done'; item: ItemDetail } // side effect confirmed
  | { outcome: 'needs_confirm_conflict'; busy: BusyBlock[]; item: ItemDetail } // action still 'pending'; re-send with confirmConflict:true
  | { outcome: 'failed'; item: ItemDetail }; // action 'failed' | 'unknown_outcome'; item.actions holds the fresh retry action + lastError
// Gate failures that happen BEFORE the write-ahead (stale hash, expired, rate limit, unfocused window, bridge offline, bad edit)
// are returned as Result.ok=false with ACTION_STALE | ACTION_EXPIRED | RATE_LIMIT_* | WINDOW_NOT_FOCUSED | SEND_NOT_CONNECTED | EVENT_INVALID ...
// and leave the action 'pending' (except expiry, which moves it to 'expired').
// [R2] A compare-and-set miss on the write-ahead (another invocation of the same actionId won the race, or the trigger aborted) is ALSO a gate
// failure: Result.ok=false ACTION_STALE, no audit 'action_failed', no retry clone, the winner's execution is untouched.
// [R2] WINDOW_NOT_FOCUSED is also returned when the approve arrives < LIMITS.focusGuardMainMs after main showed the window from a notification click.

export interface IpcResMap {
  'app:getBootstrap': Bootstrap;
  'app:ackTrayHint': null;
  'health:get': AppHealth;
  'dashboard:get': DashboardData;
  'dashboard:getIgnored': { items: ItemCard[] }; // [R2] latest 20 with closed_reason='dismissed' ONLY ("Undo dismiss" drawer; other closed items are not listed)
  'item:get': ItemDetail;
  'item:dismiss': ItemDetail;
  'item:restore': ItemDetail;
  'item:retriage': ItemDetail; // analysis -> 'queued' ; RATE_LIMIT_RETRIAGE when over budget
  'item:setEditing': null;
  'item:completeEvent': ItemDetail; // new proposal version (provider 'user') + pending create_event action
  'action:approve': ApproveOutcome;
  'action:reject': ItemDetail;
  'agent:setPaused': AppHealth;
  'chat:setPolicy': ChatView;
  'chat:listPolicies': { chats: ChatView[] }; // chats with policy != 'default' or forceKnown
  'clipboard:writeText': null;
  'onboarding:getState': OnboardingState;
  'onboarding:setStep': OnboardingState;
  'consent:get': ConsentState;
  'consent:accept': ConsentState;
  'pairing:get': PairingState;
  'pairing:newCode': PairingState;
  'pairing:relink': PairingState;
  'pairing:unlinkAndWipe': PairingState;
  'llm:getHardware': HardwareInfo;
  'llm:getConfig': LlmConfig;
  'llm:setProvider': LlmConfig; // CONSENT_REQUIRED | KEY_MISSING | MODEL_MISSING on failure
  'llm:validateKey': { model: string }; // KEY_INVALID | CLOUD_QUOTA | MODEL_NOT_FOUND | CLOUD_UNAVAILABLE on failure
  'llm:listModels': { models: ModelOption[]; presets: string[] };
  'secrets:set': KeyStatus;
  'secrets:has': KeyStatus;
  'secrets:clear': KeyStatus;
  'model:getPlan': ModelPlan;
  'model:startDownload': DownloadProgress;
  'model:pause': DownloadProgress;
  'model:resume': DownloadProgress;
  'model:cancel': ModelPlan;
  'model:delete': ModelPlan;
  'model:selfTest': { ok: boolean; tokPerSec: number | null; usedCpuFallback: boolean };
  'google:getWizardState': GoogleWizardState;
  'google:pickCredentialsFile': GoogleWizardState; // cancelled dialog => unchanged state
  'google:importCredentials': GoogleWizardState;
  'google:startSignIn': GoogleWizardState; // main opens auth_url only if host === accounts.google.com
  'google:status': GoogleWizardState;
  'google:disconnect': GoogleWizardState;
  'google:listCalendars': { calendars: CalendarInfo[] };
  'settings:get': Settings;
  'settings:set': Settings;
  'external:open': null;
  'data:purgeNow': { itemsPurged: number };
  'diagnostics:export': { saved: boolean };
}
export type IpcRes<C extends IpcChannel> = IpcResMap[C];
type _AssertAllChannelsHaveRes = { [C in IpcChannel]: IpcResMap[C] }; // compile error if a channel lacks a response type

// ---------- main -> renderer push events ----------
export interface IpcEventMap {
  'dashboard:changed': { itemIds: ItemId[] }; // debounced 150 ms ; renderer re-fetches dashboard:get (and item:get for an open card)
  'health:changed': AppHealth;
  'pairing:changed': PairingState;
  'model:progress': DownloadProgress; // 4 Hz max
  'google:changed': GoogleWizardState;
  'ui:languageChanged': { lang: Lang; dir: Dir };
  'ui:navigate': { view: View; itemId?: ItemId }; // 'tray_hint' = first-close coach mark
}
export type IpcEvent = keyof IpcEventMap;
export const IPC_EVENTS = [
  'dashboard:changed',
  'health:changed',
  'pairing:changed',
  'model:progress',
  'google:changed',
  'ui:languageChanged',
  'ui:navigate',
] as const satisfies readonly IpcEvent[];

// ---------- preload API (window.api) ----------
type InvokeArgs<C extends IpcChannel> = undefined extends IpcReq<C> ? [] : [req: IpcReq<C>];
export interface WindowApi {
  invoke<C extends IpcChannel>(channel: C, ...args: InvokeArgs<C>): Promise<Result<IpcRes<C>>>;
  /** Returns an unsubscribe function. The listener receives ONLY the payload (never the IpcRendererEvent). */
  on<E extends IpcEvent>(event: E, listener: (payload: IpcEventMap[E]) => void): () => void;
  /** Resolved by main before window creation and passed through webPreferences.additionalArguments (--wca-lang= / --wca-dir=). */
  readonly initial: { readonly lang: Lang; readonly dir: Dir };
}

/** Main-side handler signature used by src/main/ipc/register.ts. `ctx.windowFocused` is sampled by register.ts at call time. */
export interface IpcContext {
  windowFocused: boolean;
  windowVisible: boolean;
  shownByNotificationAt: EpochMs | null;
} // [R2] set by app/notifications.ts when a toast click showed the window; action:approve within LIMITS.focusGuardMainMs => WINDOW_NOT_FOCUSED
export type IpcHandler<C extends IpcChannel> = (
  req: IpcReq<C>,
  ctx: IpcContext,
) => Promise<Result<IpcRes<C>>> | Result<IpcRes<C>>;
export type IpcHandlers = { [C in IpcChannel]: IpcHandler<C> };
