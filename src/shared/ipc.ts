// src/shared/ipc.ts
import { z } from 'zod';
import {
  ACTION_KINDS,
  CHAT_POLICIES,
  CONSENT_KINDS,
  ONBOARDING_STEPS,
  SECRET_NAMES,
  LIMITS,
  PROVIDER_IDS,
  CLI_PROVIDER_IDS,
  API_KEY_PROVIDER_IDS,
  CHAT_AUTO_POLICIES,
  DOWNLOAD_TARGETS,
} from './types'; // [V2 CHANGE] import list (MODEL_TIERS -> DOWNLOAD_TARGETS)
import type { AutoState, AutoWriteView, CliStatus, VoiceState, EventContentView } from './types'; // [V2 ADD]
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
import { EventEditSchema, ReplyEditSchema, AutoScopeSchema } from './schemas'; // [V2 CHANGE] + AutoScopeSchema

// ---------- request schemas ----------
const NoReq = z.undefined();
const ItemIdReq = z.strictObject({ itemId: z.number().int().positive() });
const ConfirmReq = z.strictObject({ confirm: z.literal(true) });
const CloudProviderReq = z.strictObject({ provider: z.enum(API_KEY_PROVIDER_IDS) }); // [V2] same two values, now named: API-key providers only
/** [V2 CHANGE] tier enum = DOWNLOAD_TARGETS ('mmproj' = the projector of the selected LLM tier; voice-* files). Omitted = the selected LLM tier. */
const TierReq = z.strictObject({ tier: z.enum(DOWNLOAD_TARGETS).optional() });
const CliProviderReq = z.strictObject({ provider: z.enum(CLI_PROVIDER_IDS) }); // [V2 ADD]

/** [V2 CHANGE] kind += update_event ; + confirmDrift (update_event only) ; edit for update_event = EventEditSchema applied to `to` only ;
 *  confirmConflict for create_event AND update_event ; confirmDuplicate create_event only. */
export const ApproveReqSchema = z
  .strictObject({
    actionId: z.uuid(),
    kind: z.enum(ACTION_KINDS),
    shownHash: z.string().regex(/^[0-9a-f]{64}$/),
    edit: z.union([ReplyEditSchema, EventEditSchema]).optional(),
    confirmConflict: z.literal(true).optional(),
    confirmDuplicate: z.literal(true).optional(),
    confirmDrift: z.literal(true).optional(), // [V2 ADD]
  })
  .superRefine((r, ctx) => {
    if (r.edit && 'text' in r.edit !== (r.kind === 'send_reply'))
      ctx.addIssue({ code: 'custom', message: 'edit/kind mismatch' });
    if (r.kind === 'send_reply' && (r.confirmConflict || r.confirmDuplicate || r.confirmDrift))
      ctx.addIssue({ code: 'custom', message: 'confirm flags are calendar kinds only' });
    if (r.kind === 'update_event' && r.confirmDuplicate)
      ctx.addIssue({ code: 'custom', message: 'confirmDuplicate is create_event only' });
    if (r.kind === 'create_event' && r.confirmDrift)
      ctx.addIssue({ code: 'custom', message: 'confirmDrift is update_event only' });
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
  'claude_install', // [V2 ADD] the vendor's install docs (B32: the app never installs anything)
  'claude_usage',
  'antigravity_install',
  'antigravity_terms',
  'whisper_licence',
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
    z.strictObject({ chatRef: z.number().int().positive(), autoPolicy: z.enum(CHAT_AUTO_POLICIES) }), // [V2 ADD] "Never automatic for this contact"
  ]),
  // ---- [V2 ADD] event editing + undo (B10, B19) ----
  'item:undoChange': z.strictObject({ itemId: z.number().int().positive(), revisionId: z.number().int().positive() }), // focused window + focus-steal guard
  'item:getImage': ItemIdReq, // normalised picture as a data URL (<= LIMITS.imageDataUrlMaxBytes)
  'item:restoreOriginal': ItemIdReq, // [F1] focused window + focus-steal guard
  'item:cancelEvent': ItemIdReq, // [F32] focused window + focus-steal guard ; the "Cancel event" door (blocked_started, card)
  'wa:setReadScope': z.strictObject({ scope: z.enum(['trigger_chat', 'all_chats']) }), // [F11] all_chats: focus-gated + native confirmation
  // ---- [V2 ADD] automatic mode (B7, B10, B11) - none of these exists on any MCP surface (B29) ----
  'auto:getState': NoReq,
  'auto:requestEnable': z.strictObject({ scope: AutoScopeSchema, trial: z.boolean() }), // focused + visible window, 3/h, native dialog in MAIN
  'auto:disable': z.strictObject({ reason: z.literal('user') }), // no dialog, works unfocused
  'auto:pause': z.strictObject({ reason: z.literal('user') }), // no dialog, works unfocused
  'auto:resume': ConfirmReq, // focused window
  'auto:endShadow': ConfirmReq, // focused window, >= LIMITS.autoMinShadowDecisions shadow decisions
  'auto:undo': z.strictObject({ autoWriteId: z.uuid() }), // delegates to the item:undoChange path with approved_by 'user'
  'auto:listWrites': z.strictObject({ sinceTs: z.number().int().nonnegative() }),
  'auto:export': NoReq, // save dialog opened IN MAIN ; JSON metadata only
  // ---- [V2 ADD] vendor CLIs (B13, B14) ----
  'cli:getStatus': CliProviderReq, // cached LIMITS.cliStatusCacheMs
  'cli:signIn': CliProviderReq, // spawns the validated exe itself in a VISIBLE console (never cmd.exe, F7); the app never sees a credential
  'cli:setOverage': z.strictObject({ allow: z.boolean() }), // [F11] true: focus-gated + native confirmation ; false: one click
  'cli:test': CliProviderReq, // one tiny constant run ("uses a little of your quota")
  'cli:pickExe': z.strictObject({ provider: z.literal('claude_cli') }), // [S+] native open dialog IN MAIN; the only writer of llm.cli.claudeExePath
  'cli:previewWorkspaceChange': z.strictObject({ provider: z.literal('antigravity_cli') }),
  'cli:allowWorkspace': z.strictObject({ provider: z.literal('antigravity_cli'), confirm: z.literal(true) }), // + native dialog showing the diff
  // ---- [V2 ADD] voice (B18) ----
  'voice:getState': NoReq,
  'voice:selfTest': NoReq, // bundled 5 s fixture -> bench_json.secPerAudioSec
  'voice:retry': ItemIdReq, // re-run a failed / aborted transcript of this item's trigger
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
  'llm:setProvider': z.strictObject({ provider: z.enum(PROVIDER_IDS) }), // [V2 CHANGE] 5 ids ; CLI ids need status ready + consent + passed test
  'llm:validateKey': CloudProviderReq, // API-key providers only (unchanged values)
  'llm:listModels': z.strictObject({ provider: z.enum(['claude', 'gemini', 'claude_cli', 'antigravity_cli']) }), // [V2 CHANGE] + CLI ids
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
  // [V2 ADD] update_event: Google's copy differs from payload.from. Pre-flight drift: the action is still 'pending'; HTTP 412 on If-Match (after the
  // write-ahead): the action failed and item.actions holds its pending clone (v2-contracts concerns #12). The card says
  // "In Google it is now Thu 16:00 - apply the change anyway?" -> re-send with confirmDrift:true ("Apply anyway") or action:reject ("Keep Google's").
  | { outcome: 'needs_confirm_drift'; current: EventContentView; item: ItemDetail }
  | { outcome: 'failed'; item: ItemDetail }; // action 'failed' | 'unknown_outcome'; item.actions holds the fresh retry action + lastError
// [V2] update_event gate failures before the write-ahead: ACTION_STALE (to == from, or baseRevision != items.event_revision),
// CAL_UPDATE_UNAVAILABLE (startup guard), EVENT_INVALID. CAL_EVENT_GONE / CAL_EVENT_FOREIGN end the action 'failed' WITHOUT a retry clone
// (GONE instead inserts a pending create_event with `to` - "Add as new event").
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
  'chat:listPolicies': { chats: ChatView[] }; // chats with policy != 'default' or forceKnown ; [V2] or autoPolicy = 'never'
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
  'item:undoChange': ApproveOutcome; // [V2 ADD] the undo action is approved immediately through the normal executor
  'item:getImage': { dataUrl: string }; // [V2 ADD] 'data:image/jpeg;base64,...'
  'item:restoreOriginal': ApproveOutcome; // [F1]
  'item:cancelEvent': ApproveOutcome; // [F32]
  'wa:setReadScope': { scope: 'trigger_chat' | 'all_chats' }; // [F11] cancelled confirmation => unchanged scope
  'auto:getState': AutoState; // [V2 ADD]
  'auto:requestEnable': AutoState; // AUTO_NOT_CONFIRMED | AUTO_CALENDAR_NOT_OWNED | AUTO_NO_TRACK_RECORD | WINDOW_NOT_FOCUSED | CAL_UNAVAILABLE | CAL_UPDATE_UNAVAILABLE | BAD_REQUEST
  'auto:disable': AutoState;
  'auto:pause': AutoState;
  'auto:resume': AutoState;
  'auto:endShadow': AutoState;
  'auto:undo': ApproveOutcome;
  'auto:listWrites': { writes: AutoWriteView[] };
  'auto:export': { saved: boolean };
  'cli:getStatus': CliStatus; // [V2 ADD]
  'cli:signIn': { opened: true };
  'cli:setOverage': CliStatus; // [F11] cancelled confirmation => unchanged
  'cli:test': { ok: true; ms: number }; // failures = Result.ok=false with the mapped ErrorCode
  'cli:pickExe': CliStatus; // cancelled dialog => unchanged status
  'cli:previewWorkspaceChange': { diffLine: string; settingsFileExists: boolean; agyRunning: boolean }; // diffLine = app-built display text
  'cli:allowWorkspace': CliStatus; // BAD_REQUEST while an agy process runs ; the file is backed up first
  'voice:getState': VoiceState; // [V2 ADD]
  'voice:selfTest': { ok: boolean; secPerAudioSec: number | null };
  'voice:retry': ItemDetail;
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
  'auto:changed': AutoState; // [V2 ADD] policy state / AutoStrip ; also after every automatic write, undo and pause
  'cli:changed': CliStatus; // [V2 ADD] Connect card (sign-in poll, quota line)
  'queue:changed': { pending: number; running: number; transcribing: { seconds: number } | null }; // [V2 ADD] header "Transcribing a voice note (0:42)..."
  'voice:progress': { itemId: ItemId; phase: 'fetch' | 'decode' | 'transcribe'; audioSeconds: number }; // [V2 ADD] 2 Hz max ; numbers only
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
  'auto:changed',
  'cli:changed',
  'queue:changed',
  'voice:progress',
] as const satisfies readonly IpcEvent[];

/** [V2 ADD] Channels that require ctx.windowFocused && ctx.windowVisible and the focus-steal guard (same gate as action:approve).
 *  auto:disable / auto:pause are deliberately absent (fail-safe direction works from anywhere). Asserted by a register.ts test. */
export const FOCUS_GATED_CHANNELS = [
  'action:approve',
  'item:undoChange',
  'auto:requestEnable',
  'auto:resume',
  'auto:endShadow',
  'auto:undo',
  'cli:allowWorkspace',
  'cli:pickExe',
  'item:restoreOriginal', // [F1]
  'item:cancelEvent', // [F32]
  'cli:setOverage', // [F11] focus-gated in both directions (the control lives on the focused Settings page); only {allow:true} shows the native confirmation
  'wa:setReadScope', // [F11] focus-gated in both directions; only {scope:'all_chats'} shows the native confirmation
] as const satisfies readonly IpcChannel[];
/** [V2 ADD] Nothing on an MCP surface (the loopback tool server, the calendar child) may ever carry one of these (B29, test A18). */
export const NEVER_ON_MCP_PREFIXES = [
  'auto:',
  'item:undoChange',
  'item:restoreOriginal',
  'item:cancelEvent',
  'action:',
  'settings:',
  'cli:',
  'consent:',
  'wa:',
] as const;

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
