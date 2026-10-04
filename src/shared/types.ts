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
/** [V2 CHANGE] B12 order = settings order. There is NO 'gemini_cli' id: the Gemini CLI has no subscription path (B14); the Gemini
 *  subscription route is the opt-in Antigravity CLI ('antigravity_cli'); 'claude' / 'gemini' are the API-key providers ("Advanced"). */
export const PROVIDER_IDS = ['local', 'claude_cli', 'antigravity_cli', 'claude', 'gemini'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export type CloudProviderId = Exclude<ProviderId, 'local'>; // unchanged text; now also covers the two CLI ids
/** [V2 ADD] Vendor CLIs run as JOBS under the user's own sign-in (B2, B13, B14). Never bundled (B32). */
export const CLI_PROVIDER_IDS = ['claude_cli', 'antigravity_cli'] as const;
export type CliProviderId = (typeof CLI_PROVIDER_IDS)[number];
/** [V2 ADD] Providers that hold an API key in `secrets` (v1 'claude' / 'gemini'). `SECRET_FOR` is keyed by this type. */
export const API_KEY_PROVIDER_IDS = ['claude', 'gemini'] as const;
export type ApiKeyProviderId = (typeof API_KEY_PROVIDER_IDS)[number];
/** [V2 ADD] B25 provenance persisted on proposals.provider_class. 'cli_proven' = the S1 AND S3 runs of this version both had runs.sandbox_ok=1. */
export const PROVIDER_CLASSES = ['local', 'api_key', 'cli_proven', 'cli_unproven'] as const;
export type ProviderClass = (typeof PROVIDER_CLASSES)[number];
/** [V2 ADD] B15 */
export const PROVIDER_LOOPS = ['turn', 'agentic', 'prefetch'] as const;
export type ProviderLoop = (typeof PROVIDER_LOOPS)[number];
export const PROVIDER_LOOP: Record<ProviderId, ProviderLoop> = {
  local: 'turn',
  claude_cli: 'agentic',
  antigravity_cli: 'prefetch',
  claude: 'turn',
  gemini: 'turn',
};

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
/** [V2 CHANGE] + change_proposed (a delta is pending on this item), updated, cancelled (B20, ARCH-v2 5.1). */
export const EVENT_STATES = [
  'none',
  'incomplete',
  'proposed',
  'change_proposed',
  'created',
  'updated',
  'cancelled',
  'declined',
] as const;
export type EventState = (typeof EVENT_STATES)[number];
/** [V2 ADD] event_state values whose item represents a live Google event the app wrote (deriveState -> in_calendar). */
export const CALENDAR_EVENT_STATES = ['created', 'updated', 'cancelled'] as const;
/** [V2 ADD] findExistingEvent(): only these are editable (a cancelled event is not re-edited; undo restores it). */
export const EDITABLE_EVENT_STATES = ['created', 'updated'] as const;
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
/** [V2 ADD] B20: S1 fields `change` / `changeConfidence` / `confidence`. */
export const CHANGE_KINDS = ['no_change', 'reschedule', 'move', 'cancel', 'new_event'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];
/** [V2 ADD] The three changes a delta can carry + 'undo' (payload only; never a model value). */
export const DELTA_KINDS = ['reschedule', 'move', 'cancel'] as const;
export type DeltaKind = (typeof DELTA_KINDS)[number];
export const UPDATE_CHANGES = ['reschedule', 'move', 'cancel', 'undo'] as const;
export type UpdateChange = (typeof UPDATE_CHANGES)[number];
export const EVENT_STATUSES = ['confirmed', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
/** [V2 ADD] items.trigger_kind (B25). 'voice' / 'image' = media-derived => automatic only when FEATURE_GATES[p].voicePassed / .imagesPassed (B8, I12, D-068). */
export const TRIGGER_KINDS = ['text', 'voice', 'image'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];
/** [V2 ADD, F28] proposals.trigger_author: 'self' = the run was triggered by the user's own (from_me, non-app-send) message in a chat with an
 *  editable event; S3 is skipped and only an update_event may result (ARCH-v2 B20). */
export const TRIGGER_AUTHORS = ['contact', 'self'] as const;
export type TriggerAuthor = (typeof TRIGGER_AUTHORS)[number];

export const BADGES = [
  'time_assumed',
  'link_removed',
  'personal_details',
  'manipulation',
  'lang_mismatch',
  'conflict',
  'change_in_google',
  'older_message',
  'change_unclear',
  'from_image',
  'image_unclear',
  'image_unread',
  'automatic',
  'auto_shadow',
  'change_target_unclear',
] as const; // [R2] older_message: live row older than LIMITS.ingestMaxAgeMs -> raw card, no LLM run
// [V2 CHANGE] + change_unclear (B20), from_image / image_unclear / image_unread (B19), automatic / auto_shadow (B11),
//              change_target_unclear (F31: the chat has more than one editable event; any delta is manual-only).
// change_in_google is RETIRED (kept for old rows, never set again - B20).
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
  change_unclear: 'amber',
  from_image: 'info',
  image_unclear: 'amber',
  image_unread: 'info',
  automatic: 'info',
  auto_shadow: 'info',
  change_target_unclear: 'amber',
};
/** [V2 ADD] Badges written by the auto path AFTER AutoGate ran; AutoGate's "zero badges" rule (B8) ignores exactly these two. */
export const AUTO_RESULT_BADGES = ['automatic', 'auto_shadow'] as const satisfies readonly Badge[];
export const ASSUMPTIONS = ['hour_assumed_pm', 'hour_assumed_am', 'default_duration'] as const;
export type Assumption = (typeof ASSUMPTIONS)[number];

export const CHAT_POLICIES = ['default', 'never'] as const; // [R2] 'local_only' cut from v1
export type ChatPolicy = (typeof CHAT_POLICIES)[number];
/** [V2 ADD] chats.auto_policy (B28). No 'allow': there is no allow-list mode in v2.0 (C8). */
export const CHAT_AUTO_POLICIES = ['inherit', 'never'] as const;
export type ChatAutoPolicy = (typeof CHAT_AUTO_POLICIES)[number];

/** [V2 CHANGE] + update_event (D-036). Cancel = update_event with to.status='cancelled'; undo = update_event with change='undo'.
 *  There is no delete kind and no undo_auto kind (B10). */
export const ACTION_KINDS = ['send_reply', 'create_event', 'update_event'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
/** [V2 ADD] The kinds AutoGate may ever evaluate (never send_reply - I1'). */
export const CALENDAR_ACTION_KINDS = ['create_event', 'update_event'] as const;
export type CalendarActionKind = (typeof CALENDAR_ACTION_KINDS)[number];
/** [V2 ADD] actions.approved_by (B6): 'user' = click, 'user_toast' = the toast Undo button (update_event only - trigger-enforced),
 *  otherwise the id of an auto_decisions row (uuid) that trg_actions_state JOINs to a live 'on' policy. NULL until approval. */
export type AutoDecisionId = string;
export type ApprovedBy = 'user' | 'user_toast' | AutoDecisionId;
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
/** [V2 ADD] Voice tiers (B18) - selected by settings.voice.tier; 'voice-vad' is always downloaded with any of them. */
export const VOICE_TIERS = ['voice-hebrew', 'voice-multilingual', 'voice-lite'] as const;
export type VoiceTier = (typeof VOICE_TIERS)[number];
export type VoiceTierSetting = 'auto' | VoiceTier;
/** [V2 ADD] Projector files (B19), one per LLM tier, pinned at the v1 commits. */
export const MMPROJ_IDS = ['mmproj-tiny', 'mmproj-small', 'mmproj-mid'] as const;
export type MmprojId = (typeof MMPROJ_IDS)[number];
/** [V2 ADD] model_files.id = every file the ModelManager can hold (DDL CHECK list, consistency test #3). */
export const MODEL_FILE_IDS = [...MODEL_TIERS, ...MMPROJ_IDS, ...VOICE_TIERS, 'voice-vad'] as const;
export type ModelFileId = (typeof MODEL_FILE_IDS)[number];
export const MODEL_FILE_KINDS = ['llm', 'mmproj', 'asr', 'vad'] as const;
export type ModelFileKind = (typeof MODEL_FILE_KINDS)[number];
export function modelFileKindOf(id: ModelFileId): ModelFileKind {
  if ((MODEL_TIERS as readonly string[]).includes(id)) return 'llm';
  if ((MMPROJ_IDS as readonly string[]).includes(id)) return 'mmproj';
  return id === 'voice-vad' ? 'vad' : 'asr';
}
/** [V2 ADD] The `tier` value of the model:* IPC channels (ARCH-v2 section 10). 'mmproj' = the projector of the currently selected LLM tier;
 *  main resolves it to a MmprojId. Never a URL, never a path. */
export const DOWNLOAD_TARGETS = [...MODEL_TIERS, 'mmproj', ...VOICE_TIERS, 'voice-vad'] as const;
export type DownloadTarget = (typeof DOWNLOAD_TARGETS)[number];

/** [V2 CHANGE] + cloud_claude_cli, cloud_antigravity_cli (B21). No cloud_images / auto_mode kinds (C6). */
export const CONSENT_KINDS = [
  'whatsapp_tos',
  'cloud_claude',
  'cloud_gemini',
  'cloud_claude_cli',
  'cloud_antigravity_cli',
] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];
/** Bump a number when the bilingual consent text changes; an older accepted version no longer counts.
 *  [V2 CHANGE] cloud_claude / cloud_gemini -> 2 (text names voice transcripts, pictures when images.cloud, other-chat rows under all_chats). */
export const CONSENT_VERSIONS: Record<ConsentKind, number> = {
  whatsapp_tos: 1,
  cloud_claude: 2,
  cloud_gemini: 2,
  cloud_claude_cli: 1,
  cloud_antigravity_cli: 1,
};
/** [V2 ADD] The consent kind a provider needs before the factory builds it (factory.ts CONSENT_KIND_FOR; 'local' needs none). */
export const CONSENT_KIND_FOR: Record<CloudProviderId, ConsentKind> = {
  claude_cli: 'cloud_claude_cli',
  antigravity_cli: 'cloud_antigravity_cli',
  claude: 'cloud_claude',
  gemini: 'cloud_gemini',
};
/** [V2 ADD] Date (YYYY-MM-DD) on which the Antigravity Terms quoted by the consent text were read; stored in consents.terms_read_on (B14). */
export const ANTIGRAVITY_TERMS_READ_ON = '2026-09-28';
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
  'calendar_roles_json',
  'cli_exe_paths_json',
  'cli_last_smoke_ts',
  'cli_last_version',
  'agy_last_version',
  'agy_workspace_trusted_at',
  'google_account_sha8',
] as const; // [V2 CHANGE] + six keys (ARCH-v2 9.1). calendar_roles_json = {[calendarId]: CalendarAccessRole} from the last list-calendars;
//             cli_exe_paths_json = {claude_cli?: string, antigravity_cli?: string} recorded at provider start (reaper B31); never sent to the renderer.
// [v2-fix auto-mode-6] google_account_sha8 = googleAccountEmailSha8 of the last account answer ('' = none); binds auto_policies.snapshot_sha across restarts.
// [R2] last_online_ts: written on every ONLINE -> not-ONLINE transition and every clean quit (backlog gate, ARCH 4.6)
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
  draftTurnsWithTools: 4, // [V2 CHANGE] 3 -> 4 (B17)
  draftToolCalls: 6, // [V2 CHANGE] 4 -> 6 (B17)
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
  // ---- [V2 ADD] event editing (B20, B10) ----
  eventEditGraceMs: 24 * 3600_000, // findExistingEvent: start >= now - 24 h
  manualUndoWindowMs: 7 * 24 * 3600_000, // manual undo = until the RESTORE TARGET starts (prev_json start) or 7 d, whichever first (F2)
  // ---- [V2 ADD] WhatsApp read tools (B17) ----
  waRowsPerCall: 20,
  waSearchHits: 10,
  waContextSide: 8,
  waTextChars: 500,
  waResultChars: 4_000,
  waQueryChars: 64,
  waQueryMinChars: 2,
  waListChats: 10,
  waWindowDaysMax: 90,
  crossChatLeakWindow: 24, // S4 leak guard: normalised 24-char windows (I5')
  // ---- [V2 ADD] vendor CLIs (B13, B14) ----
  cliWallClockDraftMs: 120_000, // S3
  cliWallClockExtractMs: 60_000, // S1, V1
  cliKillGraceMs: 500,
  cliRunsPerHourMax: 60, // ceiling of settings.llm.cli.maxRunsPerHour
  cliBreakerFailures: 3, // kills or init failures ...
  cliBreakerWindowMs: 10 * 60_000, // ... in 10 min => CLI_UNSTABLE
  cliStatusCacheMs: 60_000, // cli:getStatus / `auth status` at most once a minute
  cliTestWallClockMs: 30_000,
  toolServerBodyBytes: 64 * 1024,
  toolServerRequestTimeoutMs: 2_000,
  // ---- [V2 ADD] jobs (B2) ----
  jobBreakerFailures: 5,
  jobBreakerWindowMs: 10 * 60_000,
  // ---- [V2 ADD] voice (B18) ----
  voiceMaxBytes: 64 * 1024 * 1024,
  voiceMaxSeconds: 15 * 60,
  voiceJobMinMs: 30_000,
  voiceJobMaxMs: 300_000, // [F33] job cap; a note whose PREDICTED time (seconds x benchFactor) exceeds it => VOICE_TOO_LONG_FOR_DEVICE before spawning
  voiceRunBudgetMs: 120_000, // [F33] predicted transcription time V0 may spend per runChat; the rest is deferred to a follow-up run of the chat
  voiceKillGraceMs: 3_000,
  mediaRetryDelayMs: 10_000, // GET /api/media 404/5xx: one retry after 10 s (B5)
  // ---- [V2 ADD] pictures (B19) ----
  imageMaxBytes: 10 * 1024 * 1024,
  imageMaxPixels: 25_000_000,
  imageLongEdgePx: 1536,
  imageThumbPx: 320,
  imageDataUrlMaxBytes: 400_000, // item:getImage
  imageReadTextChars: 1500,
  imageReadMaxOutputTokens: 768,
  readImageWallClockLocalMs: 180_000,
  readImageWallClockCliMs: 120_000,
  // ---- [V2 ADD] automatic mode (B7-B10) - hard ceilings live in AutoScopeSchema (schemas.ts) ----
  autoTrackRecordCreates: 3,
  autoMinShadowDecisions: 3,
  autoShadowMs: 24 * 3600_000,
  autoValidityDaysDefault: 30,
  autoValidityDaysMax: 90,
  autoExpiryReminderMs: 3 * 24 * 3600_000,
  autoDialogPerHour: 3,
  autoUserParticipationMs: 24 * 3600_000, // a from_me row within 24 h before the trigger (B8)
  autoTaintMs: 7 * 24 * 3600_000, // chats.auto_tainted_until = now + 7 d (B28)
  autoCreateMinLeadMs: 15 * 60_000,
  autoEditMinLeadMs: 2 * 3600_000,
  autoEditEarlierMinLeadMs: 24 * 3600_000, // [F2] an automatic edit that moves the event EARLIER needs new start >= now + 24 h
  autoLocationMaxChars: 80, // [F9] content_rejected: automatic path only
  autoCancelMinLeadMs: 24 * 3600_000,
  autoEditsPerEvent: 2,
  autoChatMinGapMs: 30 * 60_000, // per chat 1 / 30 min
  autoChatPerHour: 2,
  autoGlobalPerHour: 4,
  autoUndoWindowMs: 72 * 3600_000, // undo_until = min(written_at + 72 h, S) ; S = event start for a create, start of pre_json (the restore target) for update/cancel (F2)
  autoUndoPauseCount: 2, // 2 undos / 24 h => paused/circuit_breaker_undo
  autoUnattendedMs: 7 * 24 * 3600_000,
  autoToastBurstCount: 3, // 3+ writes in 10 min => one summary toast
  autoToastBurstWindowMs: 10 * 60_000,
  autoStripDays: 7,
  // ---- [V2 ADD] retention (ARCH-v2 9.3) ----
  autoDecisionsRetentionMs: 90 * 24 * 3600_000,
  autoWritesRetentionMs: 180 * 24 * 3600_000,
  revisionJsonRetentionMs: 180 * 24 * 3600_000,
} as const;

/** rate_events.bucket values. key = String(chatId) for *_chat buckets, 'global' otherwise.
 *  [V2 CHANGE] + auto_chat, auto_global (B9; creates + edits + undos of automatic writes count together), cli_global (B13), auto_dialog (B7). */
export const RATE_BUCKETS = [
  'send_chat',
  'send_global',
  'create_global',
  'llm_chat',
  'llm_global',
  'auto_chat',
  'auto_global',
  'cli_global',
  'auto_dialog',
] as const;
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
  autoPolicy: ChatAutoPolicy; // [V2 ADD] chats.auto_policy (B28)
  autoTaintedUntil: EpochMs | null; // [V2 ADD] chats.auto_tainted_until; set to now + LIMITS.autoTaintMs by S4 (B28)
}

/** A bridge messages.db row after normalisation by bridge/ingest.ts. All text UNTRUSTED.   CHANGE - two OPTIONAL fields appended */
export interface Message {
  rowid: number;
  waMsgId: string; // messages.id
  chatJid: string;
  senderUser: string; // user part only, no @server
  text: string; // messages.content (raw, NOT sanitised) ; '' for audio rows
  ts: EpochMs | null; // null = unparseable timestamp => treated as backlog
  fromMe: boolean;
  mediaType: string; // '', image, video, audio, document, sticker, reaction   (UNTRUSTED column - B27)
  deleted: boolean; // deleted_at IS NOT NULL
  /** [V2 ADD] messages.filename - UNTRUSTED, diagnostics only (B5): never used to build a path, never sent to a model or the renderer. */
  mediaFilename?: string | null;
  /** [V2 ADD] Attached by the orchestrator / WaReadClient from app.db `transcripts` for audio rows (never by ingest). UNTRUSTED text:
   *  enters only the nonce data block as {source:'voice_transcript', language, text} and the inert VoiceBubble (B18, B27). */
  voice?: { transcript: string; language: string | null; seconds: number } | null;
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
  linkedItemId: ItemId | null; // [V2 ADD] delta item -> its source in_calendar item (app-computed by findExistingEvent; B20)
  eventRevision: number; // [V2 ADD] 0 = no event ; 1 = created ; +1 per applied update/cancel/undo ; baseRevision CAS target (I7')
  calendarUpdated: string | null; // [V2 ADD] RFC3339 `updated` of OUR last write (ownership baseline, B9) ; UNTRUSTED server text, compared only
  triggerKind: TriggerKind; // [V2 ADD] set at item creation (B25)
  eventOriginItemId: ItemId | null; // [V2 ADD, F27] the item whose create_event made this event (= the Google waItem tag); copied forward by applyUpdateSuccess
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
  // ---- [V2 ADD] B25 provenance: written by S4 (agent/validate.ts) ONCE; AutoGate reads these, never recomputes ----
  delta: import('./schemas').EventDelta | null; // proposals.delta_json ; UNTRUSTED title/location inside
  imageRead: import('./schemas').ImageRead | null; // proposals.image_json ; UNTRUSTED text inside
  blockedCalls: number; // S3 ctx.blockedCalls (> 0 => never automatic)
  providerClass: ProviderClass;
  contextFromMeRecent: boolean; // a from_me row within LIMITS.autoUserParticipationMs before the trigger was in the context window
  crossChatRows: number; // WhatsApp tool rows served from chats other than the trigger chat in this version's S3 run
  triggerAuthor: TriggerAuthor; // [F28] 'self' = triggered by the user's own message (S3 skipped, update_event only)
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
  approvedBy: ApprovedBy | null; // [V2 ADD] NULL until approval ; set once, in the same UPDATE as state='approved' (trg_actions_approver_frozen)
}
export type ActionResult =
  | { kind: 'send_reply'; waMsgId: string | null } // filled by ingest/reconcile when the outbound row is matched
  | { kind: 'create_event'; eventId: string; htmlLink: string | null }
  // [V2 ADD] eventId === payload.targetEventId (readback-verified) ; revision = items.event_revision after the write
  | { kind: 'update_event'; eventId: string; revision: number; status: EventStatus };

export interface RunRecord {
  id: RunId;
  itemId: ItemId;
  stage: 'extract' | 'draft' | 'read_image'; // [V2 CHANGE] + read_image (V1). No 'transcribe' stage (C15)
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
  sandboxOk: boolean | null; // [V2 ADD] null = not a CLI run ; true = the run's own system/init (or agy init) proof passed (I11)
  sandboxProof: CliSandboxProof | null; // [V2 ADD] runs.sandbox_json - enums/numbers only
  waRowsServed: number; // [V2 ADD] WhatsApp tool rows returned in this run (all chats)
}
/** [V2 ADD] runs.sandbox_json (B25). Enums, numbers and booleans only - never a tool name, server name or any CLI text (B26). */
export interface CliSandboxProof {
  initOk: boolean;
  toolsCount: number; // entries of init.tools
  mcpServers: number; // entries of init.mcp_servers (0 on S1/V1, exactly 1 = 'wca' on S3)
  apiKeySource: 'oauth' | 'none' | 'other' | 'unknown'; // mapped from the observed literal (U-C2) ; 'other' => initOk=false
  mismatch:
    | 'extra_server'
    | 'extra_tool'
    | 'missing_server'
    | 'server_error'
    | 'api_key_auth'
    | 'agent_mismatch'
    | 'permission_mode'
    | null;
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
  termsReadOn?: IsoDate | null; // [V2 ADD] consents.terms_read_on ; set only for cloud_antigravity_cli (= ANTIGRAVITY_TERMS_READ_ON)
}
export interface ModelFileRecord {
  id: ModelFileId; // [V2 CHANGE] ModelTier -> ModelFileId (widening; v1 rows keep their ids)
  kind: ModelFileKind; // [V2 ADD]
  path: string;
  size: number;
  sha256: Sha256Hex;
  mtime: EpochMs;
  status: ModelFileStatus;
  bytesDone: number;
  verifiedAt: EpochMs | null;
  /** [V2 CHANGE, additive] imageSec: V1 self-test of an mmproj tier ; secPerAudioSec: voice bench (asr rows keep tokPerSec = 0, device 'cpu'). */
  bench: {
    tokPerSec: number;
    measuredAt: EpochMs;
    device: 'gpu' | 'cpu';
    imageSec?: number;
    secPerAudioSec?: number;
  } | null;
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
  'event_updated',
  'event_cancelled',
  'event_reverted',
  'auto_policy_enabled',
  'auto_policy_shadow_ended',
  'auto_policy_paused',
  'auto_policy_resumed',
  'auto_policy_disabled',
  'auto_policy_expired',
  'auto_decision',
  'auto_write',
  'auto_undo',
  'auto_taint',
  'cli_run',
  'media_rejected',
  'voice_job',
] as const; // [V2 CHANGE] + 16 kinds (ARCH-v2 9.1). Details are enums/numbers/booleans/ids only (v1 rule), e.g.
// cli_run {provider, stage, initOk, toolsCount, extraServers, toolCalls, blockedCalls, stopReason, ms, usageWindowHit} (B13 / ARCH-v2 4.3),
// auto_write {decisionId, actionId, kind, eventIdSha8}, voice_job {itemId, seconds, wallMs, exitCode, outcome}, media_rejected {reason, bytes, pixels}.
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

// ======================= [V2 ADD] AUTOMATIC MODE, REVISIONS, MEDIA RECORDS (main process; views below) =======================

export const AUTO_POLICY_STATES = ['shadow', 'on', 'paused', 'disabled', 'expired'] as const;
export type AutoPolicyState = (typeof AUTO_POLICY_STATES)[number];
/** At most ONE row in these states (ux_auto_policies_live). */
export const AUTO_LIVE_STATES = ['shadow', 'on', 'paused'] as const;
export const AUTO_PAUSED_REASONS = [
  'user',
  'circuit_breaker_rate',
  'circuit_breaker_undo',
  'circuit_breaker_unknown',
  'unattended',
  'calendar_disconnected',
  'snapshot_changed',
] as const;
export type AutoPausedReason = (typeof AUTO_PAUSED_REASONS)[number];
export const AUTO_DISABLED_REASONS = ['user', 'purge'] as const;
export type AutoDisabledReason = (typeof AUTO_DISABLED_REASONS)[number];
export const AUTO_VERDICTS = ['auto', 'shadow', 'fallback'] as const;
export type AutoVerdict = (typeof AUTO_VERDICTS)[number];
export const AUTO_WRITE_KINDS = ['create', 'update', 'cancel'] as const;
export type AutoWriteKind = (typeof AUTO_WRITE_KINDS)[number];
export const AUTO_UNDO_STATES = [
  'available',
  'undone',
  'expired',
  'blocked_changed',
  'blocked_started',
  'failed',
] as const;
export type AutoUndoState = (typeof AUTO_UNDO_STATES)[number];
/** Exhaustive (B8, ARCH-v2 6.2): v2-auto-mode-safety 5.5 + no_track_record (B8) + cross_chat_rows (B8's `cross_chat_rows === 0` needs a
 *  reason of its own). Stored in auto_decisions.reason (DDL CHECK, consistency test #3); shown on the card as an app string; NEVER fed to a model.
 *  Evaluation order = the group order below (policy -> contact/chat -> proposal quality -> provider -> cage -> edits; budgets = auto_budget). */
export const AUTO_REASONS = [
  'ok',
  // policy
  'no_policy',
  'policy_shadow',
  'policy_paused',
  'policy_expired',
  'snapshot_changed',
  'calendar_disconnected',
  'calendar_not_owned',
  'no_track_record',
  'undo_unavailable', // [V2 spec] update surface disabled (CAL_UPDATE_UNAVAILABLE): an automatic write could not be undone (I8) - concerns #7
  // contact / chat
  'unknown_contact',
  'chat_opted_out',
  'chat_tainted',
  'no_user_participation',
  'no_user_echo',
  // proposal quality
  'badge_red',
  'badge_amber',
  'badge_info',
  'blocked_tool_call',
  'suspicious',
  'assumed_hour',
  'missing_fields',
  'low_confidence',
  'intent_not_eligible',
  'title_rejected',
  'content_rejected', // [F9] automatic path: title/location with a URL/domain, e-mail, phone pattern, bidi/invisible char, or location > LIMITS.autoLocationMaxChars
  'media_derived',
  'cross_chat_rows',
  'multiple_events', // [F31] the chat has more than one editable event; a delta is never automatic
  // provider
  'provider_unsafe',
  // cage
  'beyond_horizon',
  'too_long',
  'too_soon',
  'quiet_hours',
  'conflict',
  'duplicate',
  'auto_budget',
  // edits
  'edits_not_in_scope',
  'cancel_not_in_scope',
  'cancel_too_soon',
  'not_app_event',
  'wrong_item',
  'not_own_copy',
  'event_has_attendees',
  'event_cancelled',
  'modified_in_google',
  'move_too_far',
  'edit_budget',
  'unknown_prev_state',
] as const;
export type AutoReason = (typeof AUTO_REASONS)[number];

export const REVISION_KINDS = ['create', 'reschedule', 'move', 'cancel', 'undo'] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];
export const TRANSCRIPT_STATUSES = ['done', 'empty', 'failed', 'aborted'] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];
/** [V2 ADD] Google calendarList accessRole as projected by adminClient; 'unknown' is NOT owned (fail closed, B7). */
export const CALENDAR_ACCESS_ROLES = ['owner', 'writer', 'reader', 'freeBusyReader', 'unknown'] as const;
export type CalendarAccessRole = (typeof CALENDAR_ACCESS_ROLES)[number];

/** Event content + status as the app approved / read back. title/location UNTRUSTED (contact-derived). = z.infer<EventContentWithStatusSchema>. */
export type EventContentWithStatus = import('./schemas').EventContentWithStatus;
/** auto_writes.pre_json: the pre-flight get-event projection, stored BEFORE the write in the write-ahead transaction (I8). */
export interface EventSnapshot {
  title: string;
  startLocal: LocalDateTime;
  endLocal: LocalDateTime;
  timeZone: string;
  location: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  etag: string | null;
  updated: string | null;
  sequence: number | null;
}

/** Row of auto_policies (B7). Grant columns are immutable (trg_auto_policies_frozen). */
export interface AutoPolicyRecord {
  id: string; // uuid
  state: AutoPolicyState;
  enabledAt: EpochMs;
  expiresAt: EpochMs; // enabledAt + scope.validityDays ; DB CHECK <= 90 d
  shadowUntil: EpochMs; // enabledAt + 24 h ('Start a 24-hour trial') or enabledAt ('Turn on now')
  confirmedBy: 'native_dialog';
  confirm: import('./schemas').AutoPolicyConfirm;
  scope: import('./schemas').AutoScope;
  snapshotSha: Sha256Hex; // sha256(canonicalJson({targetCalendarId, googleAccountEmailSha8, provider, appMajorMinor}))
  pausedReason: AutoPausedReason | null;
  disabledAt: EpochMs | null;
  disabledReason: AutoDisabledReason | null;
}
/** Row of auto_decisions (immutable). One per action at most; NO row when there is no live policy (policy_id is NOT NULL). */
export interface AutoDecisionRecord {
  id: AutoDecisionId; // uuid ; the value actions.approved_by carries for verdict 'auto'
  policyId: string;
  actionId: ActionId;
  itemId: ItemId;
  chatId: ChatRef;
  kind: AutoWriteKind;
  verdict: AutoVerdict; // DB CHECK: verdict in (auto, shadow) <=> reason = 'ok'
  reason: AutoReason;
  checks: Record<string, string | number | boolean | null>; // checks_json: metadata only, never text
  decidedAt: EpochMs;
}
/** Row of auto_writes (the automatic-write ledger over event_revisions; bookkeeping columns only are updatable). */
export interface AutoWriteRecord {
  id: string; // uuid
  decisionId: AutoDecisionId;
  actionId: ActionId;
  itemId: ItemId; // the acting item
  eventId: string; // Google event id - main only, never crosses IPC
  kind: AutoWriteKind;
  pre: EventSnapshot | null; // NULL exactly for kind 'create' (DB CHECK)
  revisionId: number | null; // set on success
  postEtag: string | null;
  postUpdated: string | null;
  postSequence: number | null;
  undoState: AutoUndoState;
  undoUntil: EpochMs; // min(writtenAt + LIMITS.autoUndoWindowMs, S) ; S = event start (create) / pre start = restore target (update, cancel) - F2 ; DB CHECK <= 72 h
  undoActionId: ActionId | null;
  writtenAt: EpochMs;
}
/** Row of event_revisions: the ONLY previous-version store (B10). revision 1 <=> kind 'create' (DB CHECK). */
export interface EventRevisionRecord {
  id: number;
  calendarEventId: string; // main only
  itemId: ItemId;
  revision: number;
  kind: RevisionKind;
  prev: EventContentWithStatus | null; // NULL for 'create' and after retention
  next: EventContentWithStatus | null; // readback AFTER the write ; NULL after retention
  actionId: ActionId;
  appliedAt: EpochMs;
  revertedBy: number | null;
  postEtag: string | null; // [F1/F5] readback etag of THIS app write (undo writes included) = the drift baseline for the next change / undo
  postUpdated: string | null; // [F1/F5] readback `updated`
}
/** Row of transcripts (B18). text UNTRUSTED; NULL after retention. */
export interface TranscriptRecord {
  chatJid: string; // main only
  waMsgId: string; // main only
  status: TranscriptStatus;
  text: string | null;
  language: string | null;
  seconds: number;
  modelLabel: string;
  errorCode: import('./errors').ErrorCode | null;
  createdAt: EpochMs;
}
/** Row of media_cache (B19). File = <userData>\media-cache\<sha256(waMsgId|sha256)>.jpg (+ .thumb.jpg) - media/mediaCache.ts mediaCacheFileNames. */
export interface MediaCacheRecord {
  itemId: ItemId | null;
  chatId: ChatRef;
  waMsgId: string; // main only
  sha256: Sha256Hex;
  width: number;
  height: number;
  bytes: number;
  createdAt: EpochMs;
}

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
  autoPolicy: ChatAutoPolicy; // [V2 ADD]
}
export interface MessageView {
  seq: number; // 0..n-1 oldest first ; React key
  fromMe: boolean;
  ts: EpochMs;
  text: string | null; // UNTRUSTED ; null = removed by retention
  voice?: VoiceView | null; // [V2 ADD] audio rows (VoiceBubble)
  image?: { thumbDataUrl: string | null; readText: string | null } | null; // [V2 ADD] image rows ; null fields = not read / retention
}
/** [V2 CHANGE] + calendar_updates_unavailable (B4 narrow fail-closed guard: update_event buttons greyed, creates keep working). */
export type ActionDisabledReason =
  'wa_offline' | 'bridge_outdated' | 'calendar_unavailable' | 'calendar_updates_unavailable';

/** [V2 ADD] App-rendered event content (the card renders it with EventChip). title/location UNTRUSTED. */
export interface EventContentView {
  title: string;
  startLocal: LocalDateTime;
  endLocal: LocalDateTime;
  timeZone: string;
  location: string;
  status: EventStatus;
}
/** [V2 ADD] The Change card line (B20, ARCH-v2 7): "Change: Wed 15:00 -> 17:00" / "Cancel: Wed 15:00 meeting". */
export interface ChangeView {
  kind: UpdateChange;
  from: EventContentView;
  to: EventContentView; // what the inline editor edits (to only)
  confidence: Confidence;
  baseRevision: number;
}
/** [V2 ADD] One Undo door (B10/B11). Present only while undo is possible or its refusal must be explained. */
export interface UndoView {
  revisionId: number; // echo back in item:undoChange
  until: EpochMs;
  state: AutoUndoState; // 'available' for manual changes too
  automatic: boolean; // the revision came from an automatic write
}
/** [V2 ADD] Automatic-mode decoration of a card (B11). Present only while a policy row exists for the decision. */
export interface AutoCardView {
  chip: 'automatic' | 'auto_shadow' | null;
  notAutomaticReason: AutoReason | null; // rendered as the muted line "Not automatic: {reason}" (app string)
  autoWriteId: string | null;
}
export const IMAGE_KINDS = [
  'invitation',
  'flyer',
  'calendar_screenshot',
  'chat_screenshot',
  'ticket',
  'other',
  'none',
] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];
/** [V2 ADD] ImageBubble (B19). readText/dateText/timeText/location UNTRUSTED, inert text only. */
export interface ImageReadView {
  thumbDataUrl: string | null; // 'data:image/jpeg;base64,...' <= 320 px ; null after retention
  readText: string;
  dateText: string;
  timeText: string;
  location: string;
  confidence: Confidence;
  kind: ImageKind;
}
/** [V2 ADD] VoiceBubble (B18). transcript UNTRUSTED, inert text only. */
export interface VoiceView {
  seconds: number; // from the Ogg granule, app-computed
  language: string | null; // whisper result.language ('he' | 'en' | ...) - display chip only
  transcript: string | null; // null = not transcribed yet / failed / retention
  status: TranscriptStatus | 'pending';
}
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
  /** set when eventState is created | updated | cancelled ; [R2] no link crosses IPC - "Open in calendar" = external:open {itemId, target:'calendarEvent'}.
   *  [V2 CHANGE] + eventKey: opaque per-event key computed in main (first 16 hex of sha256('wca-event|' + calendar_event_id)) so the renderer can
   *  key the "In calendar" list per event without the Google event id crossing IPC; + revision / status. */
  calendar: { eventStartTs: EpochMs | null; eventKey: string; revision: number; status: EventStatus } | null;
  editingLocked: boolean;
  updatedAt: EpochMs;
  // ---- [V2 ADD] ----
  triggerKind: TriggerKind;
  change: ChangeView | null; // the delta item's Change card ; null otherwise
  changePending: boolean; // on the SOURCE in_calendar card: "Change proposed - see Needs reply"
  undo: UndoView | null;
  auto: AutoCardView | null;
  image: ImageReadView | null; // image triggers that were read
  voice: VoiceView | null; // audio triggers
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
  /** [V2 ADD] projector of the selected tier ("Download picture reading ({size})" - size formatted from the tier's MEDIA_MODEL_MANIFEST entry, F24); downloaded on demand from the card, never in onboarding. */
  mmproj: { id: MmprojId; sizeBytes: number; status: ModelFileStatus; bytesDone: number } | null;
}
export interface DownloadProgress {
  tier: ModelFileId; // [V2 CHANGE] ModelTier -> ModelFileId (widening): one downloader queue for llm / mmproj / voice files
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
  /** [V2 ADD] settings.llm.cli minus the path itself (a path never crosses IPC). */
  cli: {
    claudeModel: string;
    agyModel: string;
    maxRunsPerHour: number;
    allowOverage: boolean;
    claudeExePathSet: boolean; // true = the user picked claude.exe with cli:pickExe
  };
  quota: LlmQuota | null; // [V2 ADD] CLI providers only (B13)
}
/** [V2 ADD] From Claude `rate_limit_event` (resetsAt / isUsingOverage) or agy `/usage`; values "as reported by the CLI". */
export interface LlmQuota {
  resetsAt: EpochMs | null;
  usingOverage: boolean | null;
}
/** [V2 ADD] cli:getStatus (B13, ARCH-v2 4.1 "Status pill"). Never carries a path, a token or CLI output text. */
export const CLI_STATES = ['not_installed', 'too_old', 'not_signed_in', 'unknown', 'ready'] as const;
export type CliState = (typeof CLI_STATES)[number];
export const CLI_MIN_VERSION: Record<CliProviderId, string> = { claude_cli: '2.1.248', antigravity_cli: '1.2.11' }; // [F14]
export interface CliStatus {
  provider: CliProviderId;
  state: CliState;
  version: string | null; // /^\d+\.\d+\.\d+$/ parsed from `--version` ; anything else => null
  minVersion: string; // = CLI_MIN_VERSION[provider]
  quota: LlmQuota | null;
  lastTest: { ok: boolean; at: EpochMs; ms: number | null } | null; // factory.usable() needs ok within 24 h (B12)
  workspaceTrusted: boolean | null; // antigravity_cli only (cli:allowWorkspace) ; null for claude_cli
}
/** [V2 ADD] voice:getState (B18). */
export interface VoiceState {
  enabled: boolean;
  tier: VoiceTierSetting;
  resolvedTier: VoiceTier | null; // 'auto' resolved by RAM/disk ; null = none fits
  model: { id: VoiceTier; sizeBytes: number; status: ModelFileStatus; bytesDone: number } | null;
  vad: { status: ModelFileStatus };
  secPerAudioSec: number | null; // bench of the bundled 5 s fixture
  suggestLite: boolean; // bench > 2x realtime ; never auto-switches
}
/** [V2 ADD] auto:getState (B7, B11). */
export interface AutoState {
  policy: {
    id: string;
    state: AutoPolicyState;
    enabledAt: EpochMs;
    expiresAt: EpochMs;
    shadowUntil: EpochMs;
    pausedReason: AutoPausedReason | null;
    scope: import('./schemas').AutoScope;
  } | null; // the live row, or the newest closed row (disabled/expired) for the "Ended on ..." line
  preconditions: {
    calendarConnected: boolean;
    calendarOwned: boolean; // accessRole === 'owner' for settings.calendar.targetCalendarId (absent = false)
    approvedCreates: number; // create_event done with approved_by='user'
    approvedCreatesNeeded: number; // LIMITS.autoTrackRecordCreates
    providerAllowsAuto: boolean; // false while antigravity_cli is active (B14)
    updatesAvailable: boolean; // McpHost.updateSurface().available - undo of an automatic create needs update-event (I8)
  };
  shadowTally: {
    decisions: number;
    wouldAuto: number;
    approvedUnchanged: number;
    edited: number;
    dismissed: number;
  } | null;
  usedToday: { writes: number; limit: number };
  undoableCount: number; // AutoStrip visibility (gone when 0)
}
/** [V2 ADD] One AutoStrip / activity-page row (auto:listWrites). Event text comes from proposals at render time (UNTRUSTED), never from audit rows. */
export interface AutoWriteView {
  autoWriteId: string;
  itemId: ItemId;
  kind: AutoWriteKind;
  event: EventContentView; // after the write
  before: EventContentView | null; // update / cancel: the pre-write content
  writtenAt: EpochMs;
  undoState: AutoUndoState;
  undoUntil: EpochMs;
  revisionId: number | null;
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
    voice: 'off' | 'downloading' | 'ready'; // [V2 ADD] "Voice notes: downloading 62 % / ready / off"
    voicePercent: number | null; // [V2 ADD]
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
  accessRole: CalendarAccessRole; // [V2 ADD] cached in meta.calendar_roles_json ; automatic mode needs 'owner' for the target (B7, I9)
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
