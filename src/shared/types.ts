// src/shared/types.ts
// Pure types + const tuples. No runtime dependency. Imported by main, preload typings and renderer.

// ---------- primitives ----------
export type EpochMs = number; // integer ms since epoch, UTC
export type IsoDate = string; // YYYY-MM-DD
export type LocalDateTime = string; // YYYY-MM-DDTHH:mm:ss (wall clock in an explicit IANA zone)
export type Sha256Hex = string; // 64 lowercase hex chars
export type ItemId = number;
export type ChatRef = number; // = chats.id ; the ONLY chat handle the renderer ever sees
export type ProposalId = number;
export type RunId = number;
export type ActionId = string; // uuid v4

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };
export interface AppError {
  code: import('./errors').ErrorCode;
  /** i18n interpolation values only (numbers / enum codes). NEVER message text, names, JIDs, paths. */
  params?: Record<string, string | number>;
}

// ---------- closed sets ----------
export const PROVIDER_IDS = ['local', 'claude', 'gemini'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export type CloudProviderId = Exclude<ProviderId, 'local'>;

export const LANGS = ['en', 'he'] as const;
export type Lang = (typeof LANGS)[number];
export type Dir = 'ltr' | 'rtl';

/** Stored in items.state; = deriveState(). The three dashboard lists + the hidden bucket. */
export const ITEM_STATES = ['needs_reply', 'info_missing', 'in_calendar', 'ignored'] as const;
export type ItemState = (typeof ITEM_STATES)[number];
/** Renderer-facing status = ItemState plus 'dismissed' (state 'ignored' with closedReason 'dismissed'). = deriveStatus(). Never stored. */
export const ITEM_STATUSES = ['needs_reply', 'info_missing', 'in_calendar', 'ignored', 'dismissed'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const OPEN_ITEM_STATES = ['needs_reply', 'info_missing'] as const;

export const ANALYSIS_STATES = ['queued', 'running', 'done', 'failed', 'held'] as const;
export type Analysis = (typeof ANALYSIS_STATES)[number];
export const HOLD_REASONS = ['unknown_sender', 'paused', 'waiting_llm', 'budget'] as const; // [R2] 'local_only' cut from v1
export type HoldReason = (typeof HOLD_REASONS)[number];
export const REPLY_STATES = ['none', 'draft', 'sent', 'answered_elsewhere', 'skipped'] as const;
export type ReplyState = (typeof REPLY_STATES)[number];
export const EVENT_STATES = ['none', 'incomplete', 'proposed', 'created', 'declined'] as const;
export type EventState = (typeof EVENT_STATES)[number];
export const CLOSED_REASONS = [
  'not_needed',
  'replied',
  'answered_elsewhere',
  'dismissed',
  'superseded',
  'expired',
  'past',
] as const;
export type ClosedReason = (typeof CLOSED_REASONS)[number];

export const INTENTS = [
  'schedule_request',
  'reschedule',
  'cancel',
  'confirmation',
  'question',
  'smalltalk',
  'other',
] as const;
export type Intent = (typeof INTENTS)[number];
export const MISSING_FIELDS = ['date', 'time', 'duration', 'location', 'who', 'confirmation'] as const;
export type MissingField = (typeof MISSING_FIELDS)[number];
export const DATE_KINDS = ['none', 'absolute', 'weekday', 'relative_days'] as const;
export type DateKind = (typeof DATE_KINDS)[number];

export const BADGES = [
  'time_assumed',
  'link_removed',
  'personal_details',
  'manipulation',
  'lang_mismatch',
  'conflict',
  'change_in_google',
  'older_message',
] as const; // [R2] older_message: live row older than LIMITS.ingestMaxAgeMs -> raw card, no LLM run
export type Badge = (typeof BADGES)[number];
export const BADGE_SEVERITY: Record<Badge, 'info' | 'amber' | 'red'> = {
  time_assumed: 'amber',
  link_removed: 'red',
  personal_details: 'amber',
  manipulation: 'red',
  lang_mismatch: 'amber',
  conflict: 'amber',
  change_in_google: 'info',
  older_message: 'info',
};
export const ASSUMPTIONS = ['hour_assumed_pm', 'hour_assumed_am', 'default_duration'] as const;
export type Assumption = (typeof ASSUMPTIONS)[number];

export const CHAT_POLICIES = ['default', 'never'] as const; // [R2] 'local_only' cut from v1
export type ChatPolicy = (typeof CHAT_POLICIES)[number];

export const ACTION_KINDS = ['send_reply', 'create_event'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export const ACTION_STATES = [
  'pending',
  'approved',
  'executing',
  'done',
  'failed',
  'unknown_outcome',
  'rejected',
  'expired',
  'superseded',
] as const;
export type ActionState = (typeof ACTION_STATES)[number];

export const MODEL_TIERS = ['tiny', 'small', 'mid'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export type TierSetting = 'auto' | ModelTier;
export const MODEL_FILE_STATUSES = ['none', 'downloading', 'paused', 'verifying', 'ready', 'failed'] as const;
export type ModelFileStatus = (typeof MODEL_FILE_STATUSES)[number];

export const CONSENT_KINDS = ['whatsapp_tos', 'cloud_claude', 'cloud_gemini'] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];
/** Bump a number when the bilingual consent text changes; an older accepted version no longer counts. */
export const CONSENT_VERSIONS: Record<ConsentKind, number> = { whatsapp_tos: 1, cloud_claude: 1, cloud_gemini: 1 };
export const SECRET_NAMES = ['anthropic_api_key', 'gemini_api_key'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export const ONBOARDING_STEPS = ['welcome', 'choose_ai', 'link_whatsapp', 'google', 'ready', 'done'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const META_KEYS = [
  'paired_at',
  'live_from_ts',
  'bridge_rowid_watermark',
  'onboarding_step',
  'tray_hint_seen',
  'last_backup_at',
  'last_online_ts',
] as const; // [R2] last_online_ts: written on every ONLINE -> not-ONLINE transition and every clean quit (backlog gate, ARCH 4.6)
export type MetaKey = (typeof META_KEYS)[number];
// [R2] paired_at (and live_from_ts = paired_at - settings.whatsapp.backlogHours) is (re)set on EVERY NEEDS_PAIRING -> ONLINE transition that followed a QR
// scan; unlinkAndWipe resets bridge_rowid_watermark to '0' and deletes paired_at / live_from_ts / last_online_ts.

// ---------- limits (single place; tests import these) ----------
export const LIMITS = {
  contextMessages: 12,
  contextChars: 6000,
  messageChars: 2000,
  draftChars: 600,
  titleChars: 80,
  locationChars: 120,
  listSize: 20,
  triggerPreviewChars: 280,
  debounceMs: 20_000,
  debounceCapMs: 60_000,
  scanIntervalMs: 30_000,
  pokeDebounceMs: 250,
  ingestBatch: 500,
  ingestMaxAgeMs: 7 * 24 * 3600_000,
  tsBadStreak: 20, // [R2] live-trigger age cap 24 h -> 7 d (laptop closed over a weekend) for rows that arrive
  syncMaxAgeMs: 24 * 3600_000, //      after the bridge was ONLINE at least once; 24 h for rows seen while (re)syncing history
  heldReleaseWindowMs: 24 * 3600_000, // [R2] held/waiting_llm items older than this are NOT auto-released to a CLOUD provider
  actionTtlMs: 24 * 3600_000,
  editLockMs: 10 * 60_000,
  openItemTtlMs: 7 * 24 * 3600_000,
  draftTurnsWithTools: 3,
  draftToolCalls: 4,
  blockedCallsAbort: 2,
  draftWallClockCloudMs: 60_000,
  draftWallClockLocalMs: 240_000,
  toolWindowDays: 14,
  toolHorizonDays: 60,
  eventMinMin: 5,
  eventMaxMin: 12 * 60,
  eventHorizonMonths: 12,
  llmRunsPerChatPerHour: 6,
  llmRunsGlobalPerHour: 60,
  sendMinGapPerChatMs: 5_000,
  sendPerChatPerHour: 6,
  sendGlobalPerHour: 20,
  sendGlobalPerDay: 60,
  sendJitterMinMs: 3_000,
  sendJitterMaxMs: 8_000,
  createPerHour: 10,
  createPerDay: 30,
  credentialsJsonBytes: 16 * 1024,
  clipboardChars: 4000,
  focusGuardRendererMs: 500,
  focusGuardMainMs: 300, // [R2] approval buttons ignore activation this long after the window gained focus/visibility
  reconcileSendWindowMs: 120_000,
} as const;

/** rate_events.bucket values. key = String(chatId) for *_chat buckets, 'global' otherwise. */
export const RATE_BUCKETS = ['send_chat', 'send_global', 'create_global', 'llm_chat', 'llm_global'] as const;
export type RateBucket = (typeof RATE_BUCKETS)[number];

export const DM_PHONE_JID_RE = /^[0-9]{5,20}@s\.whatsapp\.net$/; // sendable
export const DM_LID_JID_RE = /^[0-9]+@lid$/; // analysed, copy-only. [R2] The vendored bridge already rewrites LID chats to the phone JID
// (resolveLIDChat: SenderAlt/RecipientAlt/LID store) and resolves phone->LID itself on /api/send,
// so an @lid chat in messages.db is the UNRESOLVED residue; ingest re-resolves it on every ONLINE (section 12).

/** LCD JSON Schema subset accepted by all three providers (ARCHITECTURE 5.3 / 6.2). No $ref, anyOf, type arrays, min/max, nullable. */
export type JsonSchemaLcd =
  | { type: 'string'; enum?: readonly string[]; description?: string }
  | { type: 'integer' | 'number' | 'boolean'; description?: string }
  | { type: 'array'; items: JsonSchemaLcd; description?: string }
  | {
      type: 'object';
      properties: Record<string, JsonSchemaLcd>;
      required: readonly string[];
      additionalProperties: false;
      description?: string;
    };

// ======================= MAIN-PROCESS RECORDS (never sent to the renderer) =======================

/** Row of app.db chats. */
export interface Chat {
  id: ChatRef;
  jid: string; // phone JID or @lid JID. NEVER crosses IPC.
  displayName: string | null; // UNTRUSTED (bridge chats.name / push name)
  isKnown: boolean; // user has sent >= 1 REAL message in this chat (bridge DB: is_from_me=1, not a reaction, non-empty, not deleted) [R2]
  // or in the phone-JID chat this @lid chat maps to (BridgeDb.phoneJidForLid) [R2]
  forceKnown: boolean; // user clicked "Analyse this chat"
  sendable: boolean; // jid matches DM_PHONE_JID_RE
  policy: ChatPolicy;
  lang: Lang | null;
  lastInboundTs: EpochMs | null;
  lastOutboundTs: EpochMs | null;
  lastTriagedMsgId: string | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

/** A bridge messages.db row after normalisation by bridge/ingest.ts. All text UNTRUSTED. */
export interface Message {
  rowid: number;
  waMsgId: string; // messages.id
  chatJid: string;
  senderUser: string; // user part only, no @server
  text: string; // messages.content (raw, NOT sanitised)
  ts: EpochMs | null; // null = unparseable timestamp => treated as backlog
  fromMe: boolean;
  mediaType: string; // '', image, video, audio, document, sticker, reaction
  deleted: boolean; // deleted_at IS NOT NULL
}

/** Row of app.db item_messages: the snapshot of what the model saw. */
export interface ItemMessage {
  itemId: ItemId;
  waMsgId: string;
  fromMe: boolean;
  ts: EpochMs;
  text: string | null; // UNTRUSTED; nulled by retention
  textSha256: Sha256Hex;
}

/** Row of app.db items. */
export interface Item {
  id: ItemId;
  chatId: ChatRef;
  state: ItemState; // ALWAYS = deriveState(this) ; written only by db/repos/items.ts
  analysis: Analysis;
  holdReason: HoldReason | null;
  errorCode: import('./errors').ErrorCode | null;
  replyState: ReplyState;
  eventState: EventState;
  triggerMsgId: string;
  triggerTs: EpochMs;
  missing: MissingField[];
  badges: Badge[];
  currentProposalId: ProposalId | null;
  editingUntil: EpochMs; // 0 = not locked
  calendarEventId: string | null;
  calendarHtmlLink: string | null; // UNTRUSTED (MCP result). [R2] NEVER opened and never displayed; kept for diagnostics only.
  // external:open {itemId,target:'calendarEvent'} opens a URL BUILT IN MAIN from eventStartTs (see section 8).
  eventStartTs: EpochMs | null;
  closedReason: ClosedReason | null;
  closedAt: EpochMs | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

/** Row of app.db proposals (one per triage version). */
export interface Proposal {
  id: ProposalId;
  itemId: ItemId;
  version: number; // 1,2,3...
  provider: ProviderId | 'user'; // 'user' = created by item:completeEvent without an LLM turn [C+]
  model: string;
  extraction: import('./schemas').Extraction | null; // null after retention
  draftText: string | null; // UNTRUSTED (LLM output)
  replyLang: Lang | null;
  event: ProposedEvent | null; // UNTRUSTED fields inside (title, location)
  freeBusy: BusyBlock[] | null; // app-prefetched projection used for the conflict badge
  suspicious: boolean;
  createdAt: EpochMs;
  supersededAt: EpochMs | null;
}

/** The task's "ApprovalAction": row of app.db actions. */
export interface ApprovalAction {
  id: ActionId;
  itemId: ItemId;
  proposalId: ProposalId;
  chatId: ChatRef; // recipient pinned at proposal time (I3)
  kind: ActionKind;
  canonicalJson: string; // canonicalJson(ActionPayload). [R2] NULL in the DB after retention (terminal states only); repos map that to '' and such rows never reach the executor
  contentSha256: Sha256Hex; // sha256(canonicalJson) = the renderer's shownHash
  idempotencyKey: string; // `${itemId}:${kind}:${version}` ; retry clones append `:r${attempt}` [C+]
  // [R2] the part WITHOUT the `:rN` suffix is the "chain root" = input of eventIdFor() (same eventId across retries)
  attempt: number; // 1 = first ; >1 = clone created after failed / unknown_outcome [C+]
  retryOf: ActionId | null; // [C+]
  state: ActionState;
  approvedAt: EpochMs | null;
  approvedFinalJson: string | null; // canonicalJson(payload after the user's edit); frozen once state is past 'approved' (trigger) [R2]
  executedAt: EpochMs | null;
  result: ActionResult | null;
  errorCode: import('./errors').ErrorCode | null;
  createdAt: EpochMs;
  expiresAt: EpochMs;
}
export type ActionResult =
  | { kind: 'send_reply'; waMsgId: string | null } // filled by ingest/reconcile when the outbound row is matched
  | { kind: 'create_event'; eventId: string; htmlLink: string | null };

export interface RunRecord {
  id: RunId;
  itemId: ItemId;
  stage: 'extract' | 'draft';
  provider: ProviderId;
  model: string;
  startedAt: EpochMs;
  finishedAt: EpochMs | null;
  outcome: 'ok' | 'failed' | 'aborted' | null;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCalls: number;
  blockedToolCalls: number;
  errorCode: import('./errors').ErrorCode | null;
}
export interface QueueEntry {
  chatId: ChatRef;
  dueAt: EpochMs;
  firstEnqueuedAt: EpochMs;
  attempts: number;
  lastError: import('./errors').ErrorCode | null;
  /** `[+]` Monotonic, bumped by every `enqueue` on an existing row. The worker hands it back to `remove()` so the
   *  delete is a compare-and-set: a row re-armed WHILE the run was in flight survives instead of being dropped. */
  rev: number;
} // [R2] an ErrorCode ONLY - never err.message (provider/zod messages can echo model output)
export interface ConsentRecord {
  kind: ConsentKind;
  version: number;
  acceptedAt: EpochMs;
}
export interface ModelFileRecord {
  id: ModelTier;
  path: string;
  size: number;
  sha256: Sha256Hex;
  mtime: EpochMs;
  status: ModelFileStatus;
  bytesDone: number;
  verifiedAt: EpochMs | null;
  bench: { tokPerSec: number; measuredAt: EpochMs; device: 'gpu' | 'cpu' } | null;
}
export const AUDIT_KINDS = [
  'tool_blocked',
  'run_aborted',
  'action_created',
  'action_approved',
  'action_rejected',
  'action_done',
  'action_failed',
  'action_unknown_outcome',
  'action_reconciled',
  'consent',
  'spawn_refused',
  'toolset_mismatch',
  'ipc_rejected',
  'provider_changed',
  'pairing',
  'relink',
  'wipe',
  'purge',
  'db_recovery',
  'settings_changed',
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];
export interface AuditEntry {
  id: number;
  ts: EpochMs;
  kind: AuditKind;
  ref: string | null;
  detail: Record<string, string | number | boolean | null>;
} // metadata only
// [R2] 'tool_blocked' detail is EXACTLY { nameSha8: sha256(name).slice(0,8), nameLen: number, verdict: ToolGateVerdict, runId: number } - the model-supplied
// tool name itself is attacker-influenced text and is never stored, logged or exported. Same rule for every audit kind: no free text from a model, a message or a server.

// ======================= SHARED VALUE OBJECTS =======================

export interface BusyBlock {
  startLocal: LocalDateTime;
  endLocal: LocalDateTime;
} // no titles

/** proposals.event_json. Complete <=> startLocal !== '' && endLocal !== '' (then eventState = 'proposed'). */
export interface ProposedEvent {
  title: string; // UNTRUSTED until the user edits it ; <= 80, single line
  startLocal: LocalDateTime | '';
  endLocal: LocalDateTime | '';
  timeZone: string; // IANA, from settings.general.timeZone (never from the model)
  location: string; // UNTRUSTED ; '' = none ; <= 120
  assumptions: Assumption[];
  dateHint: IsoDate | ''; // [C+] known date of an INCOMPLETE event (pre-fills the info-missing mini-form)
}
export interface DraftReply {
  text: string; // UNTRUSTED (LLM output) ; <= 600 ; '' on raw cards
  lang: Lang;
  proposalVersion: number;
}

// ======================= RENDERER VIEW MODELS (the only shapes that cross IPC) =======================

export interface ChatView {
  chatRef: ChatRef;
  displayName: string; // UNTRUSTED ; '' when unknown => UI shows phoneDisplay
  phoneDisplay: string; // '+972 50-123-4567' built in main from the JID ; '' for @lid. Display text only; render in <bdi dir="ltr">
  sendable: boolean; // false => copy-only card (no Send button exists)
  isKnown: boolean;
  policy: ChatPolicy;
}
export interface MessageView {
  seq: number; // 0..n-1 oldest first ; React key
  fromMe: boolean;
  ts: EpochMs;
  text: string | null; // UNTRUSTED ; null = removed by retention
}
export type ActionDisabledReason = 'wa_offline' | 'bridge_outdated' | 'calendar_unavailable';
export interface ActionView {
  actionId: ActionId;
  kind: ActionKind;
  shownHash: Sha256Hex; // echo back verbatim in action:approve
  state: ActionState;
  expiresAt: EpochMs;
  attempt: number;
  errorCode: import('./errors').ErrorCode | null; // this action's own failure
  lastError: import('./errors').ErrorCode | null; // failure of the action this one retries (shown as the inline error line)
  disabledReason: ActionDisabledReason | null; // main ALSO rejects; this only greys the button
}
/** One dashboard card. card='raw' when analysis is 'held' | 'failed' (quoted message + empty reply box + reason chip). */
export interface ItemCard {
  itemId: ItemId;
  chat: ChatView;
  status: ItemStatus;
  card: 'full' | 'raw';
  analysis: Analysis;
  holdReason: HoldReason | null;
  errorCode: import('./errors').ErrorCode | null;
  replyState: ReplyState;
  eventState: EventState;
  closedReason: ClosedReason | null;
  trigger: { ts: EpochMs; text: string | null }; // UNTRUSTED, cut to LIMITS.triggerPreviewChars
  draft: DraftReply | null;
  event: ProposedEvent | null;
  missing: MissingField[];
  badges: Badge[];
  actions: ActionView[]; // only states pending | approved | executing | failed | unknown_outcome of the CURRENT proposal ; max one per kind
  calendar: { eventStartTs: EpochMs | null } | null; // set when eventState='created' ; [R2] no link crosses IPC - "Open in calendar" = external:open {itemId, target:'calendarEvent'}
  editingLocked: boolean;
  updatedAt: EpochMs;
}
export interface ItemDetail extends ItemCard {
  messages: MessageView[];
}

export interface DashboardData {
  needsReply: ItemCard[]; // latest LIMITS.listSize, analysis IN (done, held, failed)
  inCalendar: ItemCard[];
  infoMissing: ItemCard[];
  counts: { needsReply: number; inCalendar: number; infoMissing: number; ignored: number };
  analysing: number; // queued + running (header "Analysing N chats...")
}

// ---------- hardware / local model ----------
export interface GpuInfo {
  name: string;
  dedicated: boolean;
  vramGiB: number | null;
} // iGPU: dedicated=false, vramGiB=null
export interface HardwareInfo {
  ramGiB: number;
  gpus: GpuInfo[];
  freeDiskGiB: number;
  recommendedTier: ModelTier;
}
export interface TierInfo {
  tier: ModelTier;
  modelLabel: string;
  sizeBytes: number;
  status: ModelFileStatus;
  bytesDone: number;
  fitsDisk: boolean;
  tokPerSec: number | null;
}
export interface ModelPlan {
  recommendedTier: ModelTier;
  selectedTier: ModelTier;
  tiers: TierInfo[];
  suggestSmaller: boolean;
}
export interface DownloadProgress {
  tier: ModelTier;
  status: ModelFileStatus;
  bytesDone: number;
  bytesTotal: number;
  bytesPerSec: number;
  etaSec: number | null;
  errorCode: import('./errors').ErrorCode | null;
}

// ---------- LLM config view ----------
export interface KeyStatus {
  present: boolean;
  last4: string;
} // last4 computed in main ; '' when absent
export interface LlmConfig {
  provider: ProviderId;
  claudeModel: string;
  geminiModel: string;
  local: { tier: TierSetting; acceleration: 'auto' | 'off'; forceCpu: boolean };
  keys: Record<SecretName, KeyStatus>;
  consents: Record<ConsentKind, boolean>; // true = CURRENT version accepted
  usageToday: { inputTokens: number; outputTokens: number; budget: number }; // cloud only
}
export interface ModelOption {
  id: string;
  displayName: string;
}
export interface ConsentState {
  kind: ConsentKind;
  currentVersion: number;
  acceptedVersion: number | null;
  acceptedAt: EpochMs | null;
}

// ---------- onboarding / google ----------
export interface OnboardingState {
  step: OnboardingStep;
  checklist: {
    ai: 'pending' | 'downloading' | 'ready';
    aiPercent: number | null;
    whatsapp: 'pending' | 'ready';
    calendar: 'pending' | 'skipped' | 'ready';
  };
  userDataCloudSynced: boolean;
}
export const CREDENTIALS_PROBLEMS = [
  'too_large',
  'not_json',
  'not_installed_type',
  'bad_client_id',
  'no_secret',
  'no_localhost_redirect',
  'bad_endpoint',
] as const;
// [R2] bad_endpoint: when present, installed.auth_uri !== 'https://accounts.google.com/o/oauth2/auth' OR token_uri !== 'https://oauth2.googleapis.com/token'
//      OR auth_provider_x509_cert_url !== 'https://www.googleapis.com/oauth2/v1/certs' OR any redirect_uris entry not 'http://localhost' (optionally with a port / trailing slash)
//      and not 'urn:ietf:wg:oauth:2.0:oob'. A foreign token_uri would receive the client secret + auth code; the file is user-supplied but phishable.
export type CredentialsProblem = (typeof CREDENTIALS_PROBLEMS)[number];
export interface GoogleWizardState {
  status: import('./health').McpStatus;
  hasCredentials: boolean;
  accountEmail: string | null; // the user's own account, display only
  targetCalendarId: string;
  code: import('./errors').ErrorCode | null;
  credentialsProblem: CredentialsProblem | null;
}
export interface CalendarInfo {
  id: string;
  name: string;
  primary: boolean;
  timeZone: string;
  writable: boolean;
} // name UNTRUSTED

export interface Bootstrap {
  lang: Lang;
  dir: Dir;
  onboardingStep: OnboardingStep;
  health: import('./health').AppHealth;
  settingsPublic: import('./settings').Settings; // Settings contains no secrets
  version: string;
  trayHintSeen: boolean; // [C+]
}
