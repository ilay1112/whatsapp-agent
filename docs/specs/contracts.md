# SPEC: Cross-module contracts (v1)

Status: **binding for Wave 0 and every build lane.** Date: 2026-09-21. Author: spec agent `spec-contracts`.
Parent: `docs/ARCHITECTURE.md` (binding). Bridge facts: `docs/research/bridge-contract.md`. Calendar MCP facts: `docs/research/calendar-mcp.md`.

This file is the single source of truth for everything two modules must agree on. Every fenced `ts` block is **verbatim TypeScript**: the Wave 0 scaffolder pastes it into the file named in the block's first comment line. Blocks for `src/shared/*` are complete files. Blocks for `src/main/**` are the **frozen exported signatures** of that file (the lane owner adds the implementation below them and MUST NOT change an exported name or shape without an orchestrator decision recorded in `ops/DECISIONS.md`).

Where this spec adds something ARCHITECTURE.md does not mention, the addition is marked `[C+]` and listed in section 17. Nothing here removes or changes an ARCHITECTURE.md rule.

**Revision 2 (2026-09-22, design finalisation after adversarial review).** Changes marked `[R2]` were applied to this file and to ARCHITECTURE.md / the other specs at the same time: hardened `actions` triggers (`failed` terminal, no return to `pending`, payload immutability with a retention exception), compare-and-set semantics in `repos.actions`, `McpToolCaller<C>` narrowed per tool class via `McpHost.callerFor()`, deterministic `eventId` derived from the retry-chain root, `list_events` / `shareTitlesWithAi` / `local_only` / `notifications:'with_name'` cut from v1, backlog cap 24 h -> 7 d, `userHasSentIn` excludes reactions, `parseBridgeTs` accepts 1-9 fractional digits, stdout markers demoted to hints, doorbell hardening, reaper input validation, consent version exactness, credentials endpoint validation, `LLM_VCREDIST_MISSING`. The `ts` blocks were re-checked by reading, not recompiled; W0 must run the section 18 consistency tests and report any drift in its notes rather than "fixing" the contract.

Verification done on 2026-09-21 (outside the repo, in a scratch folder): all 31 `ts` blocks were extracted to their target paths and compiled together with `typescript@6.0.3` (`strict`, `noUncheckedIndexedAccess`) + `zod@4.6.5` with zero errors (preload and `env.d.ts` excluded - they need `electron` / `vite` types); the migration SQL was executed in `node:sqlite` (Node 24) and the three action triggers, the one-open-item index and the cascade delete were exercised; preload literal lists == `IPC_CHANNELS` / `IPC_EVENTS` (52 invoke channels, 7 events); every tuple in `types.ts` matches its DDL `CHECK`.

## 0. Conventions

| Topic | Rule |
|---|---|
| Time stamps | `EpochMs` = integer milliseconds since the Unix epoch, UTC. Every `INTEGER` time column in `app.db` and every `*Ts` / `*At` field is `EpochMs`. The bridge uses Unix **seconds** in REST (`timestamp`, `expires_at`); clients convert at the boundary. |
| Local date-times | `LocalDateTime` = `YYYY-MM-DDTHH:mm:ss` wall clock, always paired with an IANA `timeZone`. `IsoDate` = `YYYY-MM-DD`. No offsets, no `Z`. Conversions live only in `src/shared/when.ts`. |
| Identifiers | Renderer-visible: `itemId` (int), `chatRef` (= `chats.id`, int), `actionId` (uuid v4 string). JIDs, ports, paths, tokens, MCP tool names and calendar event ids never cross IPC as identifiers. A formatted phone number crosses IPC as **display text only**. |
| Trust | Fields documented `UNTRUSTED` hold text from WhatsApp, the calendar or an LLM. Renderer: inert text in a quoted bubble only. Main: never in prompts' system part, tool definitions, logs, toasts, tray, window title. |
| Enums | Every closed set is a `const` tuple + derived union type so zod schemas, DDL `CHECK`s and i18n parity tests share one list. |
| Results | Every IPC handler returns `Result<T>`. Errors carry an `ErrorCode` and optional numeric/enum `params` for i18n interpolation - never free text. |
| zod | zod 4 (`4.6.5`). Objects crossing a trust boundary are `z.strictObject`. LLM-facing JSON Schemas are hand-written constants in the LCD subset (no generation from zod). |
| Imports | `src/shared/**` imports only `zod` and other `src/shared/**` files. Never `electron`, `node:*`, React. |

---

## 1. `src/shared/types.ts` - domain types

```ts
// src/shared/types.ts
// Pure types + const tuples. No runtime dependency. Imported by main, preload typings and renderer.

// ---------- primitives ----------
export type EpochMs = number;            // integer ms since epoch, UTC
export type IsoDate = string;            // YYYY-MM-DD
export type LocalDateTime = string;      // YYYY-MM-DDTHH:mm:ss (wall clock in an explicit IANA zone)
export type Sha256Hex = string;          // 64 lowercase hex chars
export type ItemId = number;
export type ChatRef = number;            // = chats.id ; the ONLY chat handle the renderer ever sees
export type ProposalId = number;
export type RunId = number;
export type ActionId = string;           // uuid v4

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: AppError };
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
export const HOLD_REASONS = ['unknown_sender', 'paused', 'waiting_llm', 'budget'] as const;   // [R2] 'local_only' cut from v1
export type HoldReason = (typeof HOLD_REASONS)[number];
export const REPLY_STATES = ['none', 'draft', 'sent', 'answered_elsewhere', 'skipped'] as const;
export type ReplyState = (typeof REPLY_STATES)[number];
export const EVENT_STATES = ['none', 'incomplete', 'proposed', 'created', 'declined'] as const;
export type EventState = (typeof EVENT_STATES)[number];
export const CLOSED_REASONS = ['not_needed', 'replied', 'answered_elsewhere', 'dismissed', 'superseded', 'expired', 'past'] as const;
export type ClosedReason = (typeof CLOSED_REASONS)[number];

export const INTENTS = ['schedule_request', 'reschedule', 'cancel', 'confirmation', 'question', 'smalltalk', 'other'] as const;
export type Intent = (typeof INTENTS)[number];
export const MISSING_FIELDS = ['date', 'time', 'duration', 'location', 'who', 'confirmation'] as const;
export type MissingField = (typeof MISSING_FIELDS)[number];
export const DATE_KINDS = ['none', 'absolute', 'weekday', 'relative_days'] as const;
export type DateKind = (typeof DATE_KINDS)[number];

export const BADGES = ['time_assumed', 'link_removed', 'personal_details', 'manipulation', 'lang_mismatch', 'conflict', 'change_in_google',
  'older_message'] as const;   // [R2] older_message: live row older than LIMITS.ingestMaxAgeMs -> raw card, no LLM run
export type Badge = (typeof BADGES)[number];
export const BADGE_SEVERITY: Record<Badge, 'info' | 'amber' | 'red'> = {
  time_assumed: 'amber', link_removed: 'red', personal_details: 'amber', manipulation: 'red',
  lang_mismatch: 'amber', conflict: 'amber', change_in_google: 'info', older_message: 'info',
};
export const ASSUMPTIONS = ['hour_assumed_pm', 'hour_assumed_am', 'default_duration'] as const;
export type Assumption = (typeof ASSUMPTIONS)[number];

export const CHAT_POLICIES = ['default', 'never'] as const;                       // [R2] 'local_only' cut from v1
export type ChatPolicy = (typeof CHAT_POLICIES)[number];

export const ACTION_KINDS = ['send_reply', 'create_event'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export const ACTION_STATES = ['pending', 'approved', 'executing', 'done', 'failed', 'unknown_outcome', 'rejected', 'expired', 'superseded'] as const;
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

export const META_KEYS = ['paired_at', 'live_from_ts', 'bridge_rowid_watermark', 'onboarding_step', 'tray_hint_seen', 'last_backup_at',
  'last_online_ts'] as const;   // [R2] last_online_ts: written on every ONLINE -> not-ONLINE transition and every clean quit (backlog gate, ARCH 4.6)
export type MetaKey = (typeof META_KEYS)[number];
// [R2] paired_at (and live_from_ts = paired_at - settings.whatsapp.backlogHours) is (re)set on EVERY NEEDS_PAIRING -> ONLINE transition that followed a QR
// scan; unlinkAndWipe resets bridge_rowid_watermark to '0' and deletes paired_at / live_from_ts / last_online_ts.

// ---------- limits (single place; tests import these) ----------
export const LIMITS = {
  contextMessages: 12, contextChars: 6000, messageChars: 2000,
  draftChars: 600, titleChars: 80, locationChars: 120,
  listSize: 20, triggerPreviewChars: 280,
  debounceMs: 20_000, debounceCapMs: 60_000, scanIntervalMs: 30_000, pokeDebounceMs: 250,
  ingestBatch: 500, ingestMaxAgeMs: 7 * 24 * 3600_000, tsBadStreak: 20,          // [R2] live-trigger age cap 24 h -> 7 d (laptop closed over a weekend) for rows that arrive
  syncMaxAgeMs: 24 * 3600_000,                                                     //      after the bridge was ONLINE at least once; 24 h for rows seen while (re)syncing history
  heldReleaseWindowMs: 24 * 3600_000,                                              // [R2] held/waiting_llm items older than this are NOT auto-released to a CLOUD provider
  actionTtlMs: 24 * 3600_000, editLockMs: 10 * 60_000, openItemTtlMs: 7 * 24 * 3600_000,
  draftTurnsWithTools: 3, draftToolCalls: 4, blockedCallsAbort: 2,
  draftWallClockCloudMs: 60_000, draftWallClockLocalMs: 240_000,
  toolWindowDays: 14, toolHorizonDays: 60,
  eventMinMin: 5, eventMaxMin: 12 * 60, eventHorizonMonths: 12,
  llmRunsPerChatPerHour: 6, llmRunsGlobalPerHour: 60,
  sendMinGapPerChatMs: 5_000, sendPerChatPerHour: 6, sendGlobalPerHour: 20, sendGlobalPerDay: 60,
  sendJitterMinMs: 3_000, sendJitterMaxMs: 8_000, createPerHour: 10, createPerDay: 30,
  credentialsJsonBytes: 16 * 1024, clipboardChars: 4000,
  focusGuardRendererMs: 500, focusGuardMainMs: 300,                                // [R2] approval buttons ignore activation this long after the window gained focus/visibility
  reconcileSendWindowMs: 120_000,
} as const;

/** rate_events.bucket values. key = String(chatId) for *_chat buckets, 'global' otherwise. */
export const RATE_BUCKETS = ['send_chat', 'send_global', 'create_global', 'llm_chat', 'llm_global'] as const;
export type RateBucket = (typeof RATE_BUCKETS)[number];

export const DM_PHONE_JID_RE = /^[0-9]{5,20}@s\.whatsapp\.net$/;   // sendable
export const DM_LID_JID_RE = /^[0-9]+@lid$/;                       // analysed, copy-only. [R2] The vendored bridge already rewrites LID chats to the phone JID
                                                                   // (resolveLIDChat: SenderAlt/RecipientAlt/LID store) and resolves phone->LID itself on /api/send,
                                                                   // so an @lid chat in messages.db is the UNRESOLVED residue; ingest re-resolves it on every ONLINE (section 12).

/** LCD JSON Schema subset accepted by all three providers (ARCHITECTURE 5.3 / 6.2). No $ref, anyOf, type arrays, min/max, nullable. */
export type JsonSchemaLcd =
  | { type: 'string'; enum?: readonly string[]; description?: string }
  | { type: 'integer' | 'number' | 'boolean'; description?: string }
  | { type: 'array'; items: JsonSchemaLcd; description?: string }
  | { type: 'object'; properties: Record<string, JsonSchemaLcd>; required: readonly string[]; additionalProperties: false; description?: string };

// ======================= MAIN-PROCESS RECORDS (never sent to the renderer) =======================

/** Row of app.db chats. */
export interface Chat {
  id: ChatRef;
  jid: string;                      // phone JID or @lid JID. NEVER crosses IPC.
  displayName: string | null;       // UNTRUSTED (bridge chats.name / push name)
  isKnown: boolean;                 // user has sent >= 1 REAL message in this chat (bridge DB: is_from_me=1, not a reaction, non-empty, not deleted) [R2]
                                    // or in the phone-JID chat this @lid chat maps to (BridgeDb.phoneJidForLid) [R2]
  forceKnown: boolean;              // user clicked "Analyse this chat"
  sendable: boolean;                // jid matches DM_PHONE_JID_RE
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
  waMsgId: string;                  // messages.id
  chatJid: string;
  senderUser: string;               // user part only, no @server
  text: string;                     // messages.content (raw, NOT sanitised)
  ts: EpochMs | null;               // null = unparseable timestamp => treated as backlog
  fromMe: boolean;
  mediaType: string;                // '', image, video, audio, document, sticker, reaction
  deleted: boolean;                 // deleted_at IS NOT NULL
}

/** Row of app.db item_messages: the snapshot of what the model saw. */
export interface ItemMessage {
  itemId: ItemId;
  waMsgId: string;
  fromMe: boolean;
  ts: EpochMs;
  text: string | null;              // UNTRUSTED; nulled by retention
  textSha256: Sha256Hex;
}

/** Row of app.db items. */
export interface Item {
  id: ItemId;
  chatId: ChatRef;
  state: ItemState;                 // ALWAYS = deriveState(this) ; written only by db/repos/items.ts
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
  editingUntil: EpochMs;            // 0 = not locked
  calendarEventId: string | null;
  calendarHtmlLink: string | null;  // UNTRUSTED (MCP result). [R2] NEVER opened and never displayed; kept for diagnostics only.
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
  version: number;                  // 1,2,3...
  provider: ProviderId | 'user';    // 'user' = created by item:completeEvent without an LLM turn [C+]
  model: string;
  extraction: import('./schemas').Extraction | null;   // null after retention
  draftText: string | null;         // UNTRUSTED (LLM output)
  replyLang: Lang | null;
  event: ProposedEvent | null;      // UNTRUSTED fields inside (title, location)
  freeBusy: BusyBlock[] | null;     // app-prefetched projection used for the conflict badge
  suspicious: boolean;
  createdAt: EpochMs;
  supersededAt: EpochMs | null;
}

/** The task's "ApprovalAction": row of app.db actions. */
export interface ApprovalAction {
  id: ActionId;
  itemId: ItemId;
  proposalId: ProposalId;
  chatId: ChatRef;                  // recipient pinned at proposal time (I3)
  kind: ActionKind;
  canonicalJson: string;            // canonicalJson(ActionPayload). [R2] NULL in the DB after retention (terminal states only); repos map that to '' and such rows never reach the executor
  contentSha256: Sha256Hex;         // sha256(canonicalJson) = the renderer's shownHash
  idempotencyKey: string;           // `${itemId}:${kind}:${version}` ; retry clones append `:r${attempt}` [C+]
                                    // [R2] the part WITHOUT the `:rN` suffix is the "chain root" = one input of eventIdFor() (same eventId across UNEDITED retries; an edited retry gets its own id - [R3])
  attempt: number;                  // 1 = first ; >1 = clone created after failed / unknown_outcome [C+]
  retryOf: ActionId | null;         // [C+]
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
  | { kind: 'send_reply'; waMsgId: string | null }                       // filled by ingest/reconcile when the outbound row is matched
  | { kind: 'create_event'; eventId: string; htmlLink: string | null };

export interface RunRecord {
  id: RunId; itemId: ItemId; stage: 'extract' | 'draft'; provider: ProviderId; model: string;
  startedAt: EpochMs; finishedAt: EpochMs | null; outcome: 'ok' | 'failed' | 'aborted' | null;
  inputTokens: number | null; outputTokens: number | null; toolCalls: number; blockedToolCalls: number;
  errorCode: import('./errors').ErrorCode | null;
}
export interface QueueEntry { chatId: ChatRef; dueAt: EpochMs; firstEnqueuedAt: EpochMs; attempts: number;
  lastError: import('./errors').ErrorCode | null }   // [R2] an ErrorCode ONLY - never err.message (provider/zod messages can echo model output)
export interface ConsentRecord { kind: ConsentKind; version: number; acceptedAt: EpochMs }
export interface ModelFileRecord {
  id: ModelTier; path: string; size: number; sha256: Sha256Hex; mtime: EpochMs; status: ModelFileStatus;
  bytesDone: number; verifiedAt: EpochMs | null; bench: { tokPerSec: number; measuredAt: EpochMs; device: 'gpu' | 'cpu' } | null;
}
export const AUDIT_KINDS = ['tool_blocked', 'run_aborted', 'action_created', 'action_approved', 'action_rejected', 'action_done', 'action_failed',
  'action_unknown_outcome', 'action_reconciled', 'consent', 'spawn_refused', 'toolset_mismatch', 'ipc_rejected', 'provider_changed',
  'pairing', 'relink', 'wipe', 'purge', 'db_recovery', 'settings_changed'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];
export interface AuditEntry { id: number; ts: EpochMs; kind: AuditKind; ref: string | null; detail: Record<string, string | number | boolean | null> } // metadata only
// [R2] 'tool_blocked' detail is EXACTLY { nameSha8: sha256(name).slice(0,8), nameLen: number, verdict: ToolGateVerdict, runId: number } - the model-supplied
// tool name itself is attacker-influenced text and is never stored, logged or exported. Same rule for every audit kind: no free text from a model, a message or a server.

// ======================= SHARED VALUE OBJECTS =======================

export interface BusyBlock { startLocal: LocalDateTime; endLocal: LocalDateTime }   // no titles

/** proposals.event_json. Complete <=> startLocal !== '' && endLocal !== '' (then eventState = 'proposed'). */
export interface ProposedEvent {
  title: string;                    // UNTRUSTED until the user edits it ; <= 80, single line
  startLocal: LocalDateTime | '';
  endLocal: LocalDateTime | '';
  timeZone: string;                 // IANA, from settings.general.timeZone (never from the model)
  location: string;                 // UNTRUSTED ; '' = none ; <= 120
  assumptions: Assumption[];
  dateHint: IsoDate | '';           // [C+] known date of an INCOMPLETE event (pre-fills the info-missing mini-form)
}
export interface DraftReply {
  text: string;                     // UNTRUSTED (LLM output) ; <= 600 ; '' on raw cards
  lang: Lang;
  proposalVersion: number;
}

// ======================= RENDERER VIEW MODELS (the only shapes that cross IPC) =======================

export interface ChatView {
  chatRef: ChatRef;
  displayName: string;              // UNTRUSTED ; '' when unknown => UI shows phoneDisplay
  phoneDisplay: string;             // '+972 50-123-4567' built in main from the JID ; '' for @lid. Display text only; render in <bdi dir="ltr">
  sendable: boolean;                // false => copy-only card (no Send button exists)
  isKnown: boolean;
  policy: ChatPolicy;
}
export interface MessageView {
  seq: number;                      // 0..n-1 oldest first ; React key
  fromMe: boolean;
  ts: EpochMs;
  text: string | null;              // UNTRUSTED ; null = removed by retention
}
export type ActionDisabledReason = 'wa_offline' | 'bridge_outdated' | 'calendar_unavailable';
export interface ActionView {
  actionId: ActionId;
  kind: ActionKind;
  shownHash: Sha256Hex;             // echo back verbatim in action:approve
  state: ActionState;
  expiresAt: EpochMs;
  attempt: number;
  errorCode: import('./errors').ErrorCode | null;      // this action's own failure
  lastError: import('./errors').ErrorCode | null;      // failure of the action this one retries (shown as the inline error line)
  disabledReason: ActionDisabledReason | null;          // main ALSO rejects; this only greys the button
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
  trigger: { ts: EpochMs; text: string | null };        // UNTRUSTED, cut to LIMITS.triggerPreviewChars
  draft: DraftReply | null;
  event: ProposedEvent | null;
  missing: MissingField[];
  badges: Badge[];
  actions: ActionView[];            // only states pending | approved | executing | failed | unknown_outcome of the CURRENT proposal ; max one per kind
  calendar: { eventStartTs: EpochMs | null } | null;   // set when eventState='created' ; [R2] no link crosses IPC - "Open in calendar" = external:open {itemId, target:'calendarEvent'}
  editingLocked: boolean;
  updatedAt: EpochMs;
}
export interface ItemDetail extends ItemCard { messages: MessageView[] }

export interface DashboardData {
  needsReply: ItemCard[];           // latest LIMITS.listSize, analysis IN (done, held, failed)
  inCalendar: ItemCard[];
  infoMissing: ItemCard[];
  counts: { needsReply: number; inCalendar: number; infoMissing: number; ignored: number };
  analysing: number;                // queued + running (header "Analysing N chats...")
}

// ---------- hardware / local model ----------
export interface GpuInfo { name: string; dedicated: boolean; vramGiB: number | null }   // iGPU: dedicated=false, vramGiB=null
export interface HardwareInfo { ramGiB: number; gpus: GpuInfo[]; freeDiskGiB: number; recommendedTier: ModelTier }
export interface TierInfo {
  tier: ModelTier; modelLabel: string; sizeBytes: number; status: ModelFileStatus; bytesDone: number;
  fitsDisk: boolean; tokPerSec: number | null;
}
export interface ModelPlan { recommendedTier: ModelTier; selectedTier: ModelTier; tiers: TierInfo[]; suggestSmaller: boolean }
export interface DownloadProgress {
  tier: ModelTier; status: ModelFileStatus; bytesDone: number; bytesTotal: number;
  bytesPerSec: number; etaSec: number | null; errorCode: import('./errors').ErrorCode | null;
}

// ---------- LLM config view ----------
export interface KeyStatus { present: boolean; last4: string }                          // last4 computed in main ; '' when absent
export interface LlmConfig {
  provider: ProviderId; claudeModel: string; geminiModel: string;
  local: { tier: TierSetting; acceleration: 'auto' | 'off'; forceCpu: boolean };
  keys: Record<SecretName, KeyStatus>;
  consents: Record<ConsentKind, boolean>;                                               // true = CURRENT version accepted
  usageToday: { inputTokens: number; outputTokens: number; budget: number };           // cloud only
}
export interface ModelOption { id: string; displayName: string }
export interface ConsentState { kind: ConsentKind; currentVersion: number; acceptedVersion: number | null; acceptedAt: EpochMs | null }

// ---------- onboarding / google ----------
export interface OnboardingState {
  step: OnboardingStep;
  checklist: { ai: 'pending' | 'downloading' | 'ready'; aiPercent: number | null; whatsapp: 'pending' | 'ready'; calendar: 'pending' | 'skipped' | 'ready' };
  userDataCloudSynced: boolean;
}
export const CREDENTIALS_PROBLEMS = ['too_large', 'not_json', 'not_installed_type', 'bad_client_id', 'no_secret', 'no_localhost_redirect', 'bad_endpoint'] as const;
// [R2] bad_endpoint: when present, installed.auth_uri !== 'https://accounts.google.com/o/oauth2/auth' OR token_uri !== 'https://oauth2.googleapis.com/token'
//      OR auth_provider_x509_cert_url !== 'https://www.googleapis.com/oauth2/v1/certs' OR any redirect_uris entry not 'http://localhost' (optionally with a port / trailing slash)
//      and not 'urn:ietf:wg:oauth:2.0:oob'. A foreign token_uri would receive the client secret + auth code; the file is user-supplied but phishable.
export type CredentialsProblem = (typeof CREDENTIALS_PROBLEMS)[number];
export interface GoogleWizardState {
  status: import('./health').McpStatus;
  hasCredentials: boolean;
  accountEmail: string | null;      // the user's own account, display only
  targetCalendarId: string;
  code: import('./errors').ErrorCode | null;
  credentialsProblem: CredentialsProblem | null;
}
export interface CalendarInfo { id: string; name: string; primary: boolean; timeZone: string; writable: boolean }   // name UNTRUSTED

export interface Bootstrap {
  lang: Lang; dir: Dir; onboardingStep: OnboardingStep;
  health: import('./health').AppHealth;
  settingsPublic: import('./settings').Settings;      // Settings contains no secrets
  version: string;
  trayHintSeen: boolean;            // [C+]
}
```

---

## 2. `src/shared/errors.ts` - ErrorCode, one action per code

```ts
// src/shared/errors.ts
export const ERROR_CODES = [
  // bridge / WhatsApp
  'BRIDGE_CRASH_LOOP', 'BRIDGE_BINARY_BLOCKED', 'BRIDGE_SPAWN_REFUSED', 'BRIDGE_OUTDATED', 'BRIDGE_TS_FORMAT',
  'WA_OFFLINE', 'WA_LOGGED_OUT', 'WA_TOS_REQUIRED',
  // LLM
  'LLM_LOCAL_FAILED', 'LLM_VCREDIST_MISSING', 'LLM_NOT_READY', 'LLM_BAD_OUTPUT', 'MODEL_MISSING', 'DISK_FULL', 'DOWNLOAD_FAILED',   // [R2] LLM_VCREDIST_MISSING
  'KEY_INVALID', 'KEY_MISSING', 'CLOUD_QUOTA', 'CLOUD_UNAVAILABLE', 'MODEL_NOT_FOUND', 'CONSENT_REQUIRED',
  // calendar
  'CAL_UNAVAILABLE', 'CAL_RECONNECT', 'CAL_PORT_BUSY', 'CAL_TOOLSET_MISMATCH', 'CAL_DUPLICATE', 'CAL_CREATE_FAILED',
  'GOOGLE_CREDENTIALS_INVALID', 'GOOGLE_SIGNIN_TIMEOUT',
  // actions (inline on the card)
  'SEND_FAILED', 'SEND_NOT_CONNECTED', 'SEND_NOT_SENDABLE', 'RATE_LIMIT_SEND', 'RATE_LIMIT_CREATE', 'RATE_LIMIT_RETRIAGE',
  'ACTION_STALE', 'ACTION_EXPIRED', 'ACTION_UNKNOWN_OUTCOME', 'EVENT_INVALID', 'WINDOW_NOT_FOCUSED',
  // app
  'DB_RECOVERY', 'BAD_REQUEST', 'NOT_FOUND', 'ABORTED', 'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** The ONE user action offered with an error. i18n keys: errors.<CODE>.title | .body | .action (both locales; parity test). */
export const ERROR_ACTIONS = ['none', 'try_again', 'open_instructions', 'export_diagnostics', 'check_internet', 'relink', 'how_to_update',
  'accept_terms', 'test_again', 'download_again', 'free_disk', 'update_key', 'enter_key', 'open_ai_settings', 'choose_model', 'give_consent',
  'analyse_again', 'reconnect_google', 'replace_credentials', 'create_anyway', 'send_again', 'review_again', 'copy_instead', 'restore_db',
  'focus_window', 'install_vcredist'] as const;   // [R2] install_vcredist = external:open {target:'vcredist_download'} (Microsoft page; no runtime exe download by the app)
export type ErrorAction = (typeof ERROR_ACTIONS)[number];

export const ERROR_ACTION: Record<ErrorCode, ErrorAction> = {
  BRIDGE_CRASH_LOOP: 'try_again', BRIDGE_BINARY_BLOCKED: 'open_instructions', BRIDGE_SPAWN_REFUSED: 'export_diagnostics',
  BRIDGE_OUTDATED: 'how_to_update', BRIDGE_TS_FORMAT: 'export_diagnostics',
  WA_OFFLINE: 'check_internet', WA_LOGGED_OUT: 'relink', WA_TOS_REQUIRED: 'accept_terms',
  LLM_LOCAL_FAILED: 'test_again', LLM_VCREDIST_MISSING: 'install_vcredist', LLM_NOT_READY: 'none', LLM_BAD_OUTPUT: 'analyse_again', MODEL_MISSING: 'download_again',
  DISK_FULL: 'free_disk', DOWNLOAD_FAILED: 'download_again',
  KEY_INVALID: 'update_key', KEY_MISSING: 'enter_key', CLOUD_QUOTA: 'open_ai_settings', CLOUD_UNAVAILABLE: 'none',
  MODEL_NOT_FOUND: 'choose_model', CONSENT_REQUIRED: 'give_consent',
  CAL_UNAVAILABLE: 'try_again', CAL_RECONNECT: 'reconnect_google', CAL_PORT_BUSY: 'none', CAL_TOOLSET_MISMATCH: 'export_diagnostics',
  CAL_DUPLICATE: 'create_anyway', CAL_CREATE_FAILED: 'try_again',
  GOOGLE_CREDENTIALS_INVALID: 'replace_credentials', GOOGLE_SIGNIN_TIMEOUT: 'try_again',
  SEND_FAILED: 'try_again', SEND_NOT_CONNECTED: 'copy_instead', SEND_NOT_SENDABLE: 'copy_instead',
  RATE_LIMIT_SEND: 'none', RATE_LIMIT_CREATE: 'none', RATE_LIMIT_RETRIAGE: 'none',
  ACTION_STALE: 'review_again', ACTION_EXPIRED: 'review_again', ACTION_UNKNOWN_OUTCOME: 'send_again', EVENT_INVALID: 'review_again',
  WINDOW_NOT_FOCUSED: 'focus_window',
  DB_RECOVERY: 'restore_db', BAD_REQUEST: 'none', NOT_FOUND: 'none', ABORTED: 'none', INTERNAL: 'export_diagnostics',
};

/** Severity drives AppHealth.overall: 'attention' codes turn the pill red/amber-with-action, 'working' codes are transient amber. */
export const ERROR_SEVERITY: Partial<Record<ErrorCode, 'working' | 'attention'>> = {
  CLOUD_UNAVAILABLE: 'working', LLM_NOT_READY: 'working', CAL_PORT_BUSY: 'attention',
}; // every code not listed = 'attention'

/** Provider-level error classes (defined here so shared code can map them; re-exported by src/main/llm/types.ts). */
export const PROVIDER_ERROR_CODES = ['auth', 'billing', 'quota_daily', 'rate_limited', 'model_not_found', 'overloaded', 'network', 'aborted', 'bad_output', 'not_ready'] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export function providerErrorToErrorCode(provider: 'local' | 'claude' | 'gemini', e: ProviderErrorCode): ErrorCode {
  if (e === 'aborted') return 'ABORTED';
  if (e === 'bad_output') return 'LLM_BAD_OUTPUT';
  if (provider === 'local') return e === 'not_ready' ? 'LLM_NOT_READY' : 'LLM_LOCAL_FAILED';
  switch (e) {
    case 'auth': return 'KEY_INVALID';
    case 'billing': case 'quota_daily': return 'CLOUD_QUOTA';
    case 'model_not_found': return 'MODEL_NOT_FOUND';
    case 'not_ready': return 'LLM_NOT_READY';
    default: return 'CLOUD_UNAVAILABLE';               // rate_limited | overloaded | network
  }
}
/** Never retried by the queue (ARCHITECTURE section 8). */
export const NO_RETRY_PROVIDER_ERRORS: readonly ProviderErrorCode[] = ['auth', 'billing', 'quota_daily', 'model_not_found', 'aborted'];
```

---

## 3. `src/shared/health.ts` - AppHealth, BridgeStatus, PairingState, McpStatus, AgentStatus

```ts
// src/shared/health.ts
import type { EpochMs, ProviderId } from './types';
import type { ErrorCode } from './errors';

/** Host state machine of ARCHITECTURE 4.3 (+ terminal states). */
export const BRIDGE_STATUSES = ['not_started', 'stopped', 'starting', 'needs_pairing', 'online', 'reconnecting', 'backoff',
  'logged_out', 'outdated', 'refused', 'failed'] as const;
export type BridgeStatus = (typeof BRIDGE_STATUSES)[number];
// not_started = ToS not accepted yet ; refused = spawn invariant / binary blocked ; failed = circuit breaker open

/** /api/pairing/status values of the bridge + host-side additions. */
export const PAIRING_STATUSES = ['unavailable', 'connecting', 'qr_pending', 'connected', 'timeout', 'error', 'logged_out'] as const;
export type PairingStatus = (typeof PAIRING_STATUSES)[number];
export interface PairingState {
  status: PairingStatus;            // 'unavailable' = bridge not running / not answering ; 'logged_out' = error + logged-out message
  qrDataUrl?: string;               // 'data:image/png;base64,...' fetched by MAIN ; only when status='qr_pending'
  expiresAt?: EpochMs;              // bridge expires_at * 1000 ; a hint for the countdown
}

export const MCP_STATUSES = ['not_configured', 'starting', 'needs_sign_in', 'signing_in', 'connected', 'reconnect_required',
  'port_busy', 'toolset_mismatch', 'unavailable'] as const;
export type McpStatus = (typeof MCP_STATUSES)[number];

export const LLM_STATUSES = ['ready', 'idle', 'starting', 'self_testing', 'downloading', 'verifying', 'model_missing',
  'key_missing', 'key_invalid', 'consent_missing', 'quota', 'degraded', 'failed'] as const;
export type LlmStatus = (typeof LLM_STATUSES)[number];
// idle = Local provider configured, llama-server not running (lazy) ; degraded = transient cloud errors, queue backing off

export interface HealthPart<S extends string> { state: S; code?: ErrorCode; since: EpochMs }

export interface AppHealth {
  overall: 'ok' | 'working' | 'attention';
  whatsapp: HealthPart<BridgeStatus>;
  llm: HealthPart<LlmStatus> & { provider: ProviderId; model: string };   // model = model id or tier label ; never a path
  calendar: HealthPart<McpStatus>;
  queue: { pending: number; running: number };
  paused: boolean;
}

/** The task's "AgentStatus": derived view for the tray status line and the list header. */
export interface AgentStatus { state: 'idle' | 'analysing' | 'paused'; queue: { pending: number; running: number }; paused: boolean }
export function agentStatusOf(h: AppHealth): AgentStatus {
  return { state: h.paused ? 'paused' : h.queue.pending + h.queue.running > 0 ? 'analysing' : 'idle', queue: h.queue, paused: h.paused };
}

const OK_WA: readonly BridgeStatus[] = ['online'];
const WORKING_WA: readonly BridgeStatus[] = ['starting', 'reconnecting', 'backoff', 'needs_pairing', 'not_started', 'stopped'];
const OK_LLM: readonly LlmStatus[] = ['ready', 'idle'];
const WORKING_LLM: readonly LlmStatus[] = ['starting', 'self_testing', 'downloading', 'verifying', 'degraded'];
const OK_CAL: readonly McpStatus[] = ['connected', 'not_configured'];        // skipped Google = reply-only mode, not an error
const WORKING_CAL: readonly McpStatus[] = ['starting', 'signing_in', 'needs_sign_in'];

/** Pure; HealthHub calls it after every part change. A part with a `code` always counts as 'attention' unless ERROR_SEVERITY says 'working'. */
export function overallOf(h: Pick<AppHealth, 'whatsapp' | 'llm' | 'calendar'>, severityOf: (c: ErrorCode) => 'working' | 'attention'): AppHealth['overall'] {
  const parts: Array<'ok' | 'working' | 'attention'> = [
    h.whatsapp.code ? severityOf(h.whatsapp.code) : OK_WA.includes(h.whatsapp.state) ? 'ok' : WORKING_WA.includes(h.whatsapp.state) ? 'working' : 'attention',
    h.llm.code ? severityOf(h.llm.code) : OK_LLM.includes(h.llm.state) ? 'ok' : WORKING_LLM.includes(h.llm.state) ? 'working' : 'attention',
    h.calendar.code ? severityOf(h.calendar.code) : OK_CAL.includes(h.calendar.state) ? 'ok' : WORKING_CAL.includes(h.calendar.state) ? 'working' : 'attention',
  ];
  return parts.includes('attention') ? 'attention' : parts.includes('working') ? 'working' : 'ok';
}
```

---

## 4. `src/shared/settings.ts`

```ts
// src/shared/settings.ts
import { z } from 'zod';

export const SettingsSchema = z.strictObject({
  general: z.strictObject({
    language: z.enum(['system', 'en', 'he']),
    autostart: z.boolean(),
    timeZone: z.string().min(1).max(64),                         // IANA. [R2] READ-ONLY for the user: main sets it from Intl.DateTimeFormat().resolvedOptions().timeZone
                                                                 // at start and on every 'resume'/ONLINE; validated with Intl.supportedValuesOf('timeZone'). No picker in v1.
    notifications: z.enum(['off', 'generic']),                   // never message text ; [R2] 'with_name' cut (push names are attacker-chosen)
  }),
  llm: z.strictObject({
    provider: z.enum(['local', 'claude', 'gemini']),
    claudeModel: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
    geminiModel: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/).refine((s) => !s.endsWith('-latest'), 'no -latest aliases'),
    local: z.strictObject({ tier: z.enum(['auto', 'tiny', 'small', 'mid']), acceleration: z.enum(['auto', 'off']), forceCpu: z.boolean() }),
    cloudDailyTokenBudget: z.number().int().min(10_000).max(5_000_000),
  }),
  whatsapp: z.strictObject({ processUnknownSenders: z.boolean(), backlogHours: z.number().int().min(0).max(72) }),
  calendar: z.strictObject({
    targetCalendarId: z.string().min(1).max(256),
    conflictCalendarIds: z.array(z.string().min(1).max(256)).min(1).max(10),
    defaultDurationMin: z.number().int().min(5).max(720),          // [R2] shareTitlesWithAi removed with the list_events tool
  }),
  agent: z.strictObject({ paused: z.boolean(), ambiguousHour: z.enum(['assume', 'ask']), userGender: z.enum(['m', 'f', 'unspecified']) }),
  privacy: z.strictObject({ retentionDays: z.number().int().min(7).max(90) }),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  general: { language: 'system', autostart: false, timeZone: 'Asia/Jerusalem', notifications: 'generic' },
  llm: { provider: 'local', claudeModel: 'claude-opus-5', geminiModel: 'gemini-3.8-flash',
         local: { tier: 'auto', acceleration: 'auto', forceCpu: false }, cloudDailyTokenBudget: 200_000 },
  whatsapp: { processUnknownSenders: false, backlogHours: 0 },
  calendar: { targetCalendarId: 'primary', conflictCalendarIds: ['primary'], defaultDurationMin: 60 },
  agent: { paused: false, ambiguousHour: 'assume', userGender: 'unspecified' },
  privacy: { retentionDays: 30 },
};
/** [R2] UI ORDERING HINTS ONLY - never rendered as-is. The renderer intersects them with the live `llm:listModels` result and hides absent ids
 *  (ARCHITECTURE section 8: "never a hard-coded list"). `claude-haiku-4-5` dropped (expected to retire after 2026-10-15). */
export const CLAUDE_MODEL_PRESETS = ['claude-opus-5', 'claude-sonnet-5'] as const;
export const GEMINI_MODEL_PRESETS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite'] as const;

/** settings:set request: any subset of any group. NOT settable through settings:set (dedicated channels enforce preconditions):
 *  llm.provider (llm:setProvider), agent.paused (agent:setPaused), llm.local.forceCpu (main only), general.timeZone (main only) [R2]. The handler rejects them with BAD_REQUEST. */
export const SettingsPatchSchema = z.strictObject({
  general: z.strictObject({ language: z.enum(['system', 'en', 'he']), autostart: z.boolean(), notifications: z.enum(['off', 'generic']) }).partial(),
  llm: z.strictObject({
    claudeModel: SettingsSchema.shape.llm.shape.claudeModel,
    geminiModel: SettingsSchema.shape.llm.shape.geminiModel,
    local: z.strictObject({ tier: z.enum(['auto', 'tiny', 'small', 'mid']), acceleration: z.enum(['auto', 'off']) }).partial(),
    cloudDailyTokenBudget: SettingsSchema.shape.llm.shape.cloudDailyTokenBudget,
  }).partial(),
  whatsapp: SettingsSchema.shape.whatsapp.partial(),
  calendar: SettingsSchema.shape.calendar.partial(),
  agent: z.strictObject({ ambiguousHour: z.enum(['assume', 'ask']), userGender: z.enum(['m', 'f', 'unspecified']) }).partial(),
  privacy: SettingsSchema.shape.privacy.partial(),
}).partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
// Extra main-side checks in the settings handler: calendar ids must be in the last list-calendars result (or 'primary');
// timeZone must be a supported IANA zone. Stored as ONE row: settings(key='settings', value_json).

/** Pure deep-merge used by db/repos/settings.ts ; result is re-validated with SettingsSchema. */
export function applySettingsPatch(current: Settings, patch: SettingsPatch): Settings {
  const out = structuredClone(current) as Record<string, Record<string, unknown>>;
  for (const [group, values] of Object.entries(patch)) {
    if (!values) continue;
    for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[group]![k] = typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...(out[group]![k] as object), ...v } : v;
    }
  }
  return SettingsSchema.parse(out);
}
```

---

## 5. `src/shared/schemas.ts` - the triage JSON the LLM must emit, event/draft schemas, action payloads

S1 EXTRACT is the only schema-constrained LLM output. S3 DRAFT emits **plain text** (the draft), cleaned by `cleanDraft()`; it has no JSON schema by design (ARCHITECTURE A8).

```ts
// src/shared/schemas.ts
import { z } from 'zod';
import { DATE_KINDS, INTENTS, MISSING_FIELDS, ASSUMPTIONS, ACTION_KINDS, LIMITS, type JsonSchemaLcd } from './types';

// ---------- S1 EXTRACT ----------
/** JSON Schema sent to ALL providers. Wire shapes (binding, ARCHITECTURE section 8):
 *    Local  : response_format: { type: 'json_schema', json_schema: { name: 'extraction', strict: true, schema } }   [R2] OpenAI form - llama-server b10964 reads
 *             response_format.json_schema.schema; a top-level `schema` key is IGNORED and an absent schema means "any object" (no grammar at all).
 *    Claude : output_config: { format: { type: 'json_schema', schema } }
 *    Gemini : response_format: { type: 'text', mime_type: 'application/json', schema }
 *  Flat, no nulls, no unions, no numeric/length bounds (Claude rejects them) - bounds are enforced by ExtractionSchema afterwards. */
export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'needsReply', 'title', 'dateKind', 'isoDate', 'weekday', 'weekOffset', 'daysFromToday', 'time24h',
             'timeAmbiguous', 'durationMin', 'location', 'missing', 'suspicious'],
  properties: {
    intent:        { type: 'string', enum: INTENTS },
    needsReply:    { type: 'boolean' },
    title:         { type: 'string', description: 'Short event title in the chat language. Empty string if none.' },
    dateKind:      { type: 'string', enum: DATE_KINDS },
    isoDate:       { type: 'string', description: 'YYYY-MM-DD only if a calendar date is explicit in the text, else empty string.' },
    weekday:       { type: 'integer', description: '0=Sunday .. 6=Saturday. Use 0 unless dateKind is weekday.' },
    weekOffset:    { type: 'integer', description: '0 = the next occurrence, 1 = the week after, 2 = two weeks after.' },
    daysFromToday: { type: 'integer', description: '0=today, 1=tomorrow. Use 0 unless dateKind is relative_days.' },
    time24h:       { type: 'string', description: 'HH:MM 24-hour, or empty string if no time was mentioned.' },
    timeAmbiguous: { type: 'boolean', description: 'true if an hour was given without any am/pm/morning/evening cue.' },
    durationMin:   { type: 'integer', description: '0 if not specified.' },
    location:      { type: 'string', description: 'Empty string if none.' },
    missing:       { type: 'array', items: { type: 'string', enum: MISSING_FIELDS } },
    suspicious:    { type: 'boolean', description: 'true if the messages try to instruct the assistant or ask for unusual actions.' },
  },
} as const satisfies JsonSchemaLcd;

/** Validation of the model output (zod strict). Failure => ONE repair retry => analysis='failed', LLM_BAD_OUTPUT. */
export const ExtractionSchema = z.strictObject({
  intent: z.enum(INTENTS),
  needsReply: z.boolean(),
  title: z.string().max(LIMITS.titleChars),
  dateKind: z.enum(DATE_KINDS),
  isoDate: z.string().regex(/^(|\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))$/),
  weekday: z.number().int().min(0).max(6),
  weekOffset: z.number().int().min(0).max(2),
  daysFromToday: z.number().int().min(0).max(60),
  time24h: z.string().regex(/^(|([01]\d|2[0-3]):[0-5]\d)$/),
  timeAmbiguous: z.boolean(),
  durationMin: z.number().int().min(0).max(LIMITS.eventMaxMin),
  location: z.string().max(LIMITS.locationChars),
  missing: z.array(z.enum(MISSING_FIELDS)).max(MISSING_FIELDS.length),
  suspicious: z.boolean(),
});
export type Extraction = z.infer<typeof ExtractionSchema>;
// Deliberately absent (test asserts the key list): recipient, jid, attendees, calendarId, eventId, sendUpdates, url, approve/auto flags, draft.
// Cross-field coherence (e.g. dateKind='absolute' with isoDate='') is NOT a schema failure: S2 resolve turns it into missing+='date'.

// ---------- event / draft value schemas ----------
const LOCAL_DT = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const SINGLE_LINE = /^[^\r\n\u2028\u2029]*$/;
export const LocalDateTimeSchema = z.string().regex(LOCAL_DT);
export const TimeZoneSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_+\-/]+$/);

/** Persisted proposals.event_json (may be incomplete). */
export const ProposedEventSchema = z.strictObject({
  title: z.string().max(LIMITS.titleChars).regex(SINGLE_LINE),
  startLocal: z.union([z.literal(''), LocalDateTimeSchema]),
  endLocal: z.union([z.literal(''), LocalDateTimeSchema]),
  timeZone: TimeZoneSchema,
  location: z.string().max(LIMITS.locationChars).regex(SINGLE_LINE),
  assumptions: z.array(z.enum(ASSUMPTIONS)),
  dateHint: z.string().regex(/^(|\d{4}-\d{2}-\d{2})$/),
});

/** The user-editable part of an event: action:approve `edit` for create_event, and item:completeEvent. TRUSTED but still validated. */
export const EventEditSchema = z.strictObject({
  title: z.string().trim().min(1).max(LIMITS.titleChars).regex(SINGLE_LINE),
  startLocal: LocalDateTimeSchema,
  endLocal: LocalDateTimeSchema,
  location: z.string().trim().max(LIMITS.locationChars).regex(SINGLE_LINE),
}).refine((e) => e.endLocal > e.startLocal, { message: 'end<=start' });   // same-format strings compare chronologically
export type EventEdit = z.infer<typeof EventEditSchema>;

export const ReplyEditSchema = z.strictObject({ text: z.string().min(1).max(LIMITS.draftChars) });
export type ReplyEdit = z.infer<typeof ReplyEditSchema>;

// ---------- action payloads: THE thing the user approves (canonical_json) ----------
export const SendReplyPayloadSchema = z.strictObject({
  v: z.literal(1), kind: z.literal('send_reply'),
  itemId: z.number().int().positive(), chatRef: z.number().int().positive(), proposalVersion: z.number().int().positive(),
  text: z.string().min(0).max(LIMITS.draftChars),            // '' on raw cards: the user MUST supply edit.text
});
export const CreateEventPayloadSchema = z.strictObject({
  v: z.literal(1), kind: z.literal('create_event'),
  itemId: z.number().int().positive(), chatRef: z.number().int().positive(), proposalVersion: z.number().int().positive(),
  title: z.string().max(LIMITS.titleChars), startLocal: LocalDateTimeSchema, endLocal: LocalDateTimeSchema,
  timeZone: TimeZoneSchema, location: z.string().max(LIMITS.locationChars),
});
export const ActionPayloadSchema = z.discriminatedUnion('kind', [SendReplyPayloadSchema, CreateEventPayloadSchema]);
export type SendReplyPayload = z.infer<typeof SendReplyPayloadSchema>;
export type CreateEventPayload = z.infer<typeof CreateEventPayloadSchema>;
/** The task's "proposed write action": the ONLY two side effects that exist. No recipient/JID, calendarId, attendees, URL or tool name inside. */
export type ActionPayload = z.infer<typeof ActionPayloadSchema>;
export const ActionKindSchema = z.enum(ACTION_KINDS);

/** Deterministic serialisation: keys sorted (UTF-16 order) at every level, no whitespace, arrays keep order.
 *  Only strings, finite integers, booleans, arrays, plain objects are allowed (throws otherwise).
 *  content_sha256 = lowercase hex sha256 of the UTF-8 bytes of this string; computed by db/repos/actions.ts on insert
 *  and re-computed by exec/actionHash.ts on approve (shared stays free of node:crypto). */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isInteger(value)) throw new TypeError('canonicalJson: non-integer'); return String(value); }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const o = value as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
  }
  throw new TypeError('canonicalJson: unsupported value');
}

/** Applied to every LLM output and every user edit before persisting/sending: strips Unicode TAG block, bidi controls, zero-width, C0 (keeps \n). */
export function stripInvisible(s: string): string {
  return s.replace(/[\u0000-\u0009\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|\uDB40[\uDC00-\uDC7F]/g, '');
}
```

## 6. `src/shared/state.ts`

```ts
// src/shared/state.ts
import type { Analysis, ReplyState, EventState, ClosedReason, ItemState, ItemStatus } from './types';

export interface StateInputs { analysis: Analysis; replyState: ReplyState; eventState: EventState; closedReason: ClosedReason | string | null }

/** VERBATIM from ARCHITECTURE section 7. The only writer of items.state is db/repos/items.ts, which calls this on every update. */
export function deriveState(i: StateInputs): ItemState {
  if (i.closedReason)                 return 'ignored';
  if (i.eventState === 'created')     return 'in_calendar';
  if (i.analysis !== 'done')          return 'needs_reply';      // raw card (listed only when held/failed)
  if (i.eventState === 'incomplete')  return 'info_missing';
  if (i.replyState === 'draft' || i.eventState === 'proposed') return 'needs_reply';
  return 'ignored';
}

/** Renderer-facing status: splits the user's own "Dismiss" out of the hidden bucket. */
export function deriveStatus(i: StateInputs): ItemStatus {
  return i.closedReason === 'dismissed' ? 'dismissed' : deriveState(i);
}

export function isOpen(state: ItemState): boolean { return state === 'needs_reply' || state === 'info_missing'; }
/** Dashboard visibility rule (ARCHITECTURE 6.1): queued/running items are counted, not listed. */
export function isListed(analysis: Analysis): boolean { return analysis === 'done' || analysis === 'held' || analysis === 'failed'; }
export function cardKind(analysis: Analysis): 'full' | 'raw' { return analysis === 'done' ? 'full' : 'raw'; }
```

## 7. `src/shared/when.ts` (signatures; implementation owned by lane 9, pure, no `Date` parsing of free text)

```ts
// src/shared/when.ts
import type { EpochMs, IsoDate, LocalDateTime, Assumption, MissingField } from './types';
import type { Extraction } from './schemas';

export interface WhenContext { nowMs: EpochMs; timeZone: string; defaultDurationMin: number; ambiguousHour: 'assume' | 'ask' }
export const WHEN_PROBLEMS = ['in_past', 'too_far', 'bad_duration', 'weekday_mismatch', 'incoherent_date'] as const;
export type WhenProblem = (typeof WHEN_PROBLEMS)[number];
export interface ResolvedWhen {
  date: IsoDate | '';
  startLocal: LocalDateTime | '';
  endLocal: LocalDateTime | '';
  timeZone: string;
  assumptions: Assumption[];
  missing: MissingField[];          // extraction.missing plus what resolution found missing ; deduplicated, order of MISSING_FIELDS
  problems: WhenProblem[];          // any problem => the slot is NOT complete (missing += 'date' or 'time')
}
/** S2: the model never does date arithmetic. Hours 1-7 + timeAmbiguous => PM, 8-11 => AM when ambiguousHour='assume'; 'ask' => missing += 'time'. */
export declare function resolveWhen(x: Extraction, ctx: WhenContext): ResolvedWhen;

export interface DayRow { date: IsoDate; weekdayIndex: number; weekdayEn: string; weekdayHe: string }   // weekdayIndex 0 = Sunday
/** The 14-day table injected into the S1 user message (week starts Sunday). */
export declare function buildDayTable(nowMs: EpochMs, timeZone: string, days?: number): DayRow[];

export declare function localToEpochMs(local: LocalDateTime, timeZone: string): EpochMs;       // DST gaps: first valid instant after the gap
export declare function epochMsToLocal(ms: EpochMs, timeZone: string): LocalDateTime;
export declare function todayIn(timeZone: string, nowMs: EpochMs): IsoDate;
export declare function addMinutes(local: LocalDateTime, minutes: number): LocalDateTime;
```
(`declare function` marks a frozen signature; the lane replaces `declare` with the body.)

---

## 8. `src/shared/ipc.ts` - the typed IPC contract

Rules: every invoke channel returns `Promise<Result<Res>>`; requests are validated in main with the zod schema below **after** the trusted-sender check (`app://bundle`, our window's main frame); a failed check or parse => `{ok:false,error:{code:'BAD_REQUEST'}}` + audit `ipc_rejected`. Responses are TypeScript-typed only (main is trusted). No request field anywhere is a JID, URL, file path, tool name or MCP argument.

Channels marked `[C+]` are additions to the ARCHITECTURE section 11 table (justified in section 17).

```ts
// src/shared/ipc.ts
import { z } from 'zod';
import { ACTION_KINDS, CHAT_POLICIES, CONSENT_KINDS, MODEL_TIERS, ONBOARDING_STEPS, SECRET_NAMES, LIMITS } from './types';
import type { Bootstrap, DashboardData, ItemCard, ItemDetail, ChatView, ConsentState, HardwareInfo, LlmConfig, ModelOption, ModelPlan,
  DownloadProgress, OnboardingState, GoogleWizardState, CalendarInfo, KeyStatus, BusyBlock, Lang, Dir, ItemId, Result, EpochMs } from './types';
import type { AppHealth, PairingState } from './health';
import { SettingsPatchSchema, type Settings } from './settings';
import { EventEditSchema, ReplyEditSchema } from './schemas';

// ---------- request schemas ----------
const NoReq = z.undefined();
const ItemIdReq = z.strictObject({ itemId: z.number().int().positive() });
const ConfirmReq = z.strictObject({ confirm: z.literal(true) });
const CloudProviderReq = z.strictObject({ provider: z.enum(['claude', 'gemini']) });
const TierReq = z.strictObject({ tier: z.enum(MODEL_TIERS).optional() });          // omitted = currently selected tier

export const ApproveReqSchema = z.strictObject({
  actionId: z.uuid(),
  kind: z.enum(ACTION_KINDS),
  shownHash: z.string().regex(/^[0-9a-f]{64}$/),
  edit: z.union([ReplyEditSchema, EventEditSchema]).optional(),
  confirmConflict: z.literal(true).optional(),
  confirmDuplicate: z.literal(true).optional(),
}).superRefine((r, ctx) => {
  if (r.edit && ('text' in r.edit) !== (r.kind === 'send_reply')) ctx.addIssue({ code: 'custom', message: 'edit/kind mismatch' });
  if (r.kind === 'send_reply' && (r.confirmConflict || r.confirmDuplicate)) ctx.addIssue({ code: 'custom', message: 'confirm flags are create_event only' });
});
export type ApproveReq = z.infer<typeof ApproveReqSchema>;

export const EXTERNAL_TARGETS = ['gcp_new_project', 'gcp_enable_calendar_api', 'gcp_oauth_consent', 'gcp_create_credentials', 'gcp_publish_app',
  'anthropic_api_keys', 'gemini_api_keys', 'whatsapp_linked_devices_help', 'antivirus_help', 'bridge_update_help', 'bitlocker_help',
  'google_unverified_app_help', 'project_readme', 'vcredist_download'] as const;    // keys of resources/links.json (parity test) ; [R2] vcredist_download = https://aka.ms/vs/17/release/vc_redist.x64.exe (a Microsoft page opened in the browser)
export type ExternalTarget = (typeof EXTERNAL_TARGETS)[number];
/** [R2] external:open {itemId, target:'calendarEvent'}: main NEVER opens a server-supplied link. It builds
 *  `https://calendar.google.com/calendar/r/day/${YYYY}/${MM}/${DD}` from items.event_start_ts in settings.general.timeZone (Intl, 'en-CA' parts) and opens that. */

export const VIEWS = ['dashboard', 'settings', 'onboarding', 'tray_hint'] as const;
export type View = (typeof VIEWS)[number];   // 'tray_hint' = the coach mark shown the FIRST time the window is opened after a hide-to-tray ([R2]: X always hides at once)

export const IPC_REQUEST_SCHEMAS = {
  'app:getBootstrap': NoReq,
  'app:ackTrayHint': NoReq,                                                         // [C+]
  'health:get': NoReq,
  'dashboard:get': NoReq,
  'dashboard:getIgnored': NoReq,                                                    // [C+]
  'item:get': ItemIdReq,
  'item:dismiss': ItemIdReq,
  'item:restore': ItemIdReq,
  'item:retriage': ItemIdReq,
  'item:setEditing': z.strictObject({ itemId: z.number().int().positive(), editing: z.boolean() }),
  'item:completeEvent': z.strictObject({ itemId: z.number().int().positive(), event: EventEditSchema }),   // [C+]
  'action:approve': ApproveReqSchema,
  'action:reject': z.strictObject({ actionId: z.uuid() }),
  'agent:setPaused': z.strictObject({ paused: z.boolean() }),
  'chat:setPolicy': z.union([
    z.strictObject({ chatRef: z.number().int().positive(), policy: z.enum(CHAT_POLICIES) }),
    z.strictObject({ chatRef: z.number().int().positive(), forceKnown: z.literal(true) }),
  ]),
  'chat:listPolicies': NoReq,                                                       // [C+]
  'clipboard:writeText': z.strictObject({ text: z.string().min(1).max(LIMITS.clipboardChars) }),          // [C+]
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
  'secrets:set': z.strictObject({ name: z.enum(SECRET_NAMES), value: z.string().min(8).max(512).regex(/^[\x21-\x7E]+$/) }),
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
  'google:pickCredentialsFile': NoReq,                                              // native dialog opened IN MAIN
  'google:importCredentials': z.strictObject({ jsonText: z.string().min(2).max(LIMITS.credentialsJsonBytes) }),   // file CONTENT, never a path
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
  'diagnostics:export': NoReq,                                                      // save dialog opened IN MAIN
} as const;

export type IpcChannel = keyof typeof IPC_REQUEST_SCHEMAS;
export const IPC_CHANNELS = Object.keys(IPC_REQUEST_SCHEMAS) as IpcChannel[];
export type IpcReq<C extends IpcChannel> = z.infer<(typeof IPC_REQUEST_SCHEMAS)[C]>;

// ---------- response types ----------
export type ApproveOutcome =
  | { outcome: 'done'; item: ItemDetail }                                           // side effect confirmed
  | { outcome: 'needs_confirm_conflict'; busy: BusyBlock[]; item: ItemDetail }      // action still 'pending'; re-send with confirmConflict:true
  | { outcome: 'failed'; item: ItemDetail };                                        // action 'failed' | 'unknown_outcome'; item.actions holds the fresh retry action + lastError
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
  'dashboard:getIgnored': { items: ItemCard[] };                                    // [R2] latest 20 with closed_reason='dismissed' ONLY ("Undo dismiss" drawer; other closed items are not listed)
  'item:get': ItemDetail;
  'item:dismiss': ItemDetail;
  'item:restore': ItemDetail;
  'item:retriage': ItemDetail;                                                      // analysis -> 'queued' ; RATE_LIMIT_RETRIAGE when over budget
  'item:setEditing': null;
  'item:completeEvent': ItemDetail;                                                 // new proposal version (provider 'user') + pending create_event action
  'action:approve': ApproveOutcome;
  'action:reject': ItemDetail;
  'agent:setPaused': AppHealth;
  'chat:setPolicy': ChatView;
  'chat:listPolicies': { chats: ChatView[] };                                       // chats with policy != 'default' or forceKnown
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
  'llm:setProvider': LlmConfig;                                                     // CONSENT_REQUIRED | KEY_MISSING | MODEL_MISSING on failure
  'llm:validateKey': { model: string };                                             // KEY_INVALID | CLOUD_QUOTA | MODEL_NOT_FOUND | CLOUD_UNAVAILABLE on failure
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
  'google:pickCredentialsFile': GoogleWizardState;                                  // cancelled dialog => unchanged state
  'google:importCredentials': GoogleWizardState;
  'google:startSignIn': GoogleWizardState;                                          // main opens auth_url only if host === accounts.google.com
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
type _AssertAllChannelsHaveRes = { [C in IpcChannel]: IpcResMap[C] };               // compile error if a channel lacks a response type

// ---------- main -> renderer push events ----------
export interface IpcEventMap {
  'dashboard:changed': { itemIds: ItemId[] };                                       // debounced 150 ms ; renderer re-fetches dashboard:get (and item:get for an open card)
  'health:changed': AppHealth;
  'pairing:changed': PairingState;
  'model:progress': DownloadProgress;                                               // 4 Hz max
  'google:changed': GoogleWizardState;
  'ui:languageChanged': { lang: Lang; dir: Dir };
  'ui:navigate': { view: View; itemId?: ItemId };                                   // 'tray_hint' = first-close coach mark
}
export type IpcEvent = keyof IpcEventMap;
export const IPC_EVENTS = ['dashboard:changed', 'health:changed', 'pairing:changed', 'model:progress', 'google:changed',
  'ui:languageChanged', 'ui:navigate'] as const satisfies readonly IpcEvent[];

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
export interface IpcContext { windowFocused: boolean; windowVisible: boolean;
  shownByNotificationAt: EpochMs | null }   // [R2] set by app/notifications.ts when a toast click showed the window; action:approve within LIMITS.focusGuardMainMs => WINDOW_NOT_FOCUSED
export type IpcHandler<C extends IpcChannel> = (req: IpcReq<C>, ctx: IpcContext) => Promise<Result<IpcRes<C>>> | Result<IpcRes<C>>;
export type IpcHandlers = { [C in IpcChannel]: IpcHandler<C> };
```

Handler ownership (file -> channels): `handlers/app.ts` app:*, health:get, onboarding:*, consent:*, external:open, clipboard:writeText, agent:setPaused - `handlers/items.ts` dashboard:*, item:*, chat:* - `handlers/actions.ts` action:* (lane 10) - `handlers/settings.ts` settings:* - `handlers/secrets.ts` secrets:* - `handlers/llm.ts` llm:* - `handlers/model.ts` model:* - `handlers/pairing.ts` pairing:* - `handlers/google.ts` google:* - `handlers/data.ts` data:purgeNow, diagnostics:export.

### 8.1 `src/renderer/src/env.d.ts`

```ts
// src/renderer/src/env.d.ts
/// <reference types="vite/client" />
import type { WindowApi } from '../../shared/ipc';
declare global { interface Window { readonly api: WindowApi } }
export {};
```

### 8.2 `src/preload/index.ts` (complete file; CJS output, sandboxed, no imports except `electron`)

The literal lists are duplicated **on purpose** (a sandboxed preload must not pull zod). `tests/unit/preload-parity.test.ts` asserts they equal `IPC_CHANNELS` / `IPC_EVENTS`.

```ts
// src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron';

const INVOKE = new Set<string>([
  'app:getBootstrap', 'app:ackTrayHint', 'health:get', 'dashboard:get', 'dashboard:getIgnored',
  'item:get', 'item:dismiss', 'item:restore', 'item:retriage', 'item:setEditing', 'item:completeEvent',
  'action:approve', 'action:reject', 'agent:setPaused', 'chat:setPolicy', 'chat:listPolicies', 'clipboard:writeText',
  'onboarding:getState', 'onboarding:setStep', 'consent:get', 'consent:accept',
  'pairing:get', 'pairing:newCode', 'pairing:relink', 'pairing:unlinkAndWipe',
  'llm:getHardware', 'llm:getConfig', 'llm:setProvider', 'llm:validateKey', 'llm:listModels',
  'secrets:set', 'secrets:has', 'secrets:clear',
  'model:getPlan', 'model:startDownload', 'model:pause', 'model:resume', 'model:cancel', 'model:delete', 'model:selfTest',
  'google:getWizardState', 'google:pickCredentialsFile', 'google:importCredentials', 'google:startSignIn', 'google:status',
  'google:disconnect', 'google:listCalendars',
  'settings:get', 'settings:set', 'external:open', 'data:purgeNow', 'diagnostics:export',
]);
const EVENTS = new Set<string>([
  'dashboard:changed', 'health:changed', 'pairing:changed', 'model:progress', 'google:changed', 'ui:languageChanged', 'ui:navigate',
]);

function arg(name: string, allowed: readonly string[], fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--wca-${name}=`));
  const v = hit ? hit.slice(name.length + 7) : fallback;
  return allowed.includes(v) ? v : fallback;
}

contextBridge.exposeInMainWorld('api', Object.freeze({
  invoke: (channel: string, req?: unknown) => {
    if (!INVOKE.has(channel)) return Promise.resolve({ ok: false, error: { code: 'BAD_REQUEST' } });
    return ipcRenderer.invoke(channel, req);
  },
  on: (event: string, listener: (payload: unknown) => void) => {
    if (!EVENTS.has(event) || typeof listener !== 'function') return () => {};
    const wrapped = (_e: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(event, wrapped);
    return () => { ipcRenderer.removeListener(event, wrapped); };
  },
  initial: Object.freeze({ lang: arg('lang', ['en', 'he'], 'en'), dir: arg('dir', ['ltr', 'rtl'], 'ltr') }),
}));
```

---

## 9. `src/main/llm/types.ts` - provider abstraction

```ts
// src/main/llm/types.ts
import type { JsonSchemaLcd, ProviderId } from '../../shared/types';
import { type ProviderErrorCode } from '../../shared/errors';
export type { ProviderErrorCode };

export interface LlmTool     { name: string; description: string; inputSchema: JsonSchemaLcd }      // app-authored READ tools only
export interface LlmToolCall { id: string; name: string; input: Record<string, unknown> }
export interface LlmToolResult { toolCallId: string; name: string; content: string; isError?: boolean }
/** Aliases under the names used by the task brief. */
export type ToolDef = LlmTool; export type ToolCall = LlmToolCall; export type ToolResult = LlmToolResult;

export type LlmMessage =
  | { role: 'system';    content: string }                                                        // only from agent/prompt.ts buildSystemPrompt()
  | { role: 'user';      content: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[]; providerData?: unknown }     // providerData = opaque verbatim replay (Claude content blocks / Gemini steps)
  | { role: 'tool';      results: LlmToolResult[] };                                              // ALL results of one assistant turn in ONE message

export interface LlmUsage { inputTokens: number; outputTokens: number }
export interface LlmResponse {
  text: string;
  toolCalls: LlmToolCall[];
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
  usage?: LlmUsage;
  assistantMessage: Extract<LlmMessage, { role: 'assistant' }>;                                   // push this verbatim into the history
}
export interface CallOpts {
  signal: AbortSignal;                                                                            // Pause / quit / wall-clock abort
  maxOutputTokens: number;                                                                        // Claude adapter raises to >= 2048
  purpose: 'extract' | 'draft';
  onUsage?: (u: LlmUsage) => void;                                                                // [C+] lets structured() report tokens for the runs table
}

export interface LlmProvider {
  readonly id: ProviderId;
  readonly model: string;                                                                         // model id (cloud) or GGUF file label (local) ; recorded in runs/proposals
  /** S1: schema-constrained JSON, NO tools in the request. Returns the parsed JSON UNVALIDATED (caller runs zod). Throws LlmError. */
  structured<T>(messages: LlmMessage[], schema: JsonSchemaLcd, opts: CallOpts): Promise<T>;
  /** S3: exactly ONE model turn, tool_choice auto, never executes tools. tools=[] => a no-tool turn. Throws LlmError. */
  chat(messages: LlmMessage[], tools: LlmTool[], opts: CallOpts): Promise<LlmResponse>;
  validate(signal: AbortSignal): Promise<{ ok: true; model: string } | { ok: false; reason: ProviderErrorCode }>;
  dispose(): Promise<void>;
}

export class LlmError extends Error {
  constructor(public readonly code: ProviderErrorCode, public readonly retryAfterMs?: number) { super(code); this.name = 'LlmError'; }
} // message === code on purpose: provider error bodies may echo prompt text and must never be logged

/** llm/factory.ts. Throws LlmError('not_ready') when the key/model is missing and ConsentRequiredError when the consent record is not current.
 *  Providers get NO MCP client, NO bridge client, NO Db. */
export class ConsentRequiredError extends Error { constructor(public readonly kind: 'cloud_claude' | 'cloud_gemini') { super('consent_required'); } }
export interface ProviderFactory {
  /** Returns the provider for settings.llm.provider. Cached until provider/model/key changes. Never falls back to another provider. */
  get(): Promise<LlmProvider>;
  /** Cheap readiness check used by S0 (held/waiting_llm) - never starts llama-server. */
  usable(): { ok: true } | { ok: false; code: import('../../shared/errors').ErrorCode };
  invalidate(): Promise<void>;                                                                    // dispose + drop cache (provider switch, key change, quit)
}
```

Wire rules per provider (ARCHITECTURE section 8 table) are binding and not repeated here. `role:'tool'` mapping: Local -> one `{role:'tool', tool_call_id, content}` message per result; Claude -> one user message with one `tool_result` block per result; Gemini -> `function_result` steps.

`[R2]` **SDK client construction (binding constants; both SDKs otherwise read `process.env`):**
```ts
// llm/claude.ts
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
new Anthropic({ apiKey, baseURL: ANTHROPIC_BASE_URL, maxRetries: 2, timeout: 60_000 });          // never pass undefined for baseURL
// llm/gemini.ts
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
new GoogleGenAI({ apiKey, httpOptions: { baseUrl: GEMINI_BASE_URL } });                          // never pass undefined for httpOptions.baseUrl
```
`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_GEMINI_BASE_URL` in the main process environment are ignored by construction (the key and base URL are always passed explicitly). `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` in the main process are an accepted R4 residual (same-user attacker) and are never propagated to any child (bridge, llama, MCP use minimal env blocks).

---

## 10. Tool gating - `src/main/agent/toolDefs.ts` and `src/main/agent/toolGate.ts`

```ts
// src/main/agent/toolDefs.ts   (compile-time constants; I4 purity test asserts byte-identical output for any untrusted input)
import type { LlmTool } from '../llm/types';
import type { JsonSchemaLcd } from '../../shared/types';
import type { McpToolName } from '../mcp/readClient';

/** READ allowlist: the ONLY names ToolGate will ever execute for a model. [R2] `list_events` (calendar titles to the model) is cut from v1:
 *  free/busy is enough for drafting and it was the only tool that could ship event titles to a cloud provider. */
export const READ_TOOL_NAMES = ['get_current_time', 'get_freebusy'] as const;
export type ReadToolName = (typeof READ_TOOL_NAMES)[number];

const WINDOW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['timeMin', 'timeMax'],
  properties: {
    timeMin: { type: 'string', description: 'Local start, format YYYY-MM-DDTHH:mm:ss' },
    timeMax: { type: 'string', description: 'Local end, format YYYY-MM-DDTHH:mm:ss, at most 14 days after timeMin' },
  },
} as const satisfies JsonSchemaLcd;
const EMPTY_SCHEMA = { type: 'object', additionalProperties: false, required: [], properties: {} } as const satisfies JsonSchemaLcd;

export interface ReadToolSpec { def: LlmTool; mcpTool: McpToolName; maxCallsPerRun: number }
export const READ_TOOLS: Record<ReadToolName, ReadToolSpec> = {
  get_current_time: { mcpTool: 'get-current-time', maxCallsPerRun: 1,
    def: { name: 'get_current_time', description: "Returns the current date, time and time zone of the user's calendar.", inputSchema: EMPTY_SCHEMA } },
  get_freebusy: { mcpTool: 'get-freebusy', maxCallsPerRun: 3,
    def: { name: 'get_freebusy', description: 'Returns the busy time blocks of the user between timeMin and timeMax. No event details.', inputSchema: WINDOW_SCHEMA } },
};
```

```ts
// src/main/agent/toolGate.ts   (frozen signatures)
import type { LlmTool, LlmToolCall, LlmToolResult } from '../llm/types';
import type { McpReadClient, PinnedWindow } from '../mcp/readClient';
import type { BusyBlock, EpochMs, ItemId, ChatRef, RunId, LocalDateTime } from '../../shared/types';
import type { Settings } from '../../shared/settings';

/** Mutable per-run state owned by agent/draft.ts; one per S3 run; never shared between chats (I5). */
export interface RunCtx {
  runId: RunId; itemId: ItemId; chatId: ChatRef;
  nowMs: EpochMs; timeZone: string;
  nonce: string;                                  // 16 hex chars ; data-block delimiter <<DATA-nonce>> ... <<END-nonce>>
  calls: Record<string, number>;                  // per LLM-facing tool name
  totalCalls: number;                             // <= LIMITS.draftToolCalls
  blockedCalls: number;                           // >= LIMITS.blockedCallsAbort => abort run + badge 'manipulation'
  signal: AbortSignal;
}
export type ToolGateVerdict = 'executed' | 'blocked_unknown_tool' | 'blocked_not_exposed' | 'blocked_budget' | 'blocked_bad_args' | 'unavailable';
export interface ToolGateOutcome {
  result: LlmToolResult;                          // ALWAYS present: projected JSON in a nonce data block, or {"error":"tool not available"|"unavailable"}
  verdict: ToolGateVerdict;
  abortRun: boolean;                              // true once ctx.blockedCalls reaches the limit
}
export interface ToolGateDeps {
  read: McpReadClient;                            // facade with NO write method (I2)
  settings: () => Settings;
  calendarConnected: () => boolean;
  audit: (kind: 'tool_blocked', ref: string, detail: Record<string, string | number | boolean | null>) => void;
}
export interface ToolGate {
  /** Tool definitions to offer this run: [] when the calendar is not connected, else both READ tools. */
  exposedTools(): LlmTool[];
  /** Steps 1-6 of ARCHITECTURE 5.3. Never throws. Names are matched case-SENSITIVELY against READ_TOOL_NAMES.
   *  A blocked call audits ONLY { nameSha8, nameLen, verdict, runId } - never the name [R2]. */
  invoke(call: LlmToolCall, ctx: RunCtx): Promise<ToolGateOutcome>;
  /** App-side prefetch (window [start-2h, end+2h]) used by S2 for the `conflict` badge and by S3 for the prompt; same pin/clamp/projection path;
   *  does not consume the model's budget. [R2] Runs in S2 whenever a COMPLETE slot exists and the calendar is connected - independent of needsReply. */
  prefetchFreeBusy(slot: { startLocal: LocalDateTime; endLocal: LocalDateTime }, ctx: Pick<RunCtx, 'nowMs' | 'timeZone' | 'signal' | 'itemId' | 'chatId'>): Promise<BusyBlock[] | null>;
}
export declare function createToolGate(deps: ToolGateDeps): ToolGate;
/** zod .strict() parse + clamp: timeMin >= now, window <= 14 d, horizon <= 60 d ; pins calendar ids / timeZone / account from settings. null = bad args. */
export declare function constrainReadArgs(raw: Record<string, unknown>, ctx: Pick<RunCtx, 'nowMs' | 'timeZone'>, settings: Settings): PinnedWindow | null;
```

---

## 11. Calendar MCP clients - `src/main/mcp/*`


```ts
// src/main/mcp/readClient.ts   (capability-free types + the READ facade; the only mcp/* file agent/** may import)
import type { BusyBlock, LocalDateTime, ActionId } from '../../shared/types';

/** The six tools enabled at the MCP server and their class. Anything else in tools/list => CAL_TOOLSET_MISMATCH (fail closed). */
export const MCP_TOOLS = {
  'get-current-time': 'read', 'get-freebusy': 'read', 'list-events': 'read',
  'list-calendars': 'admin', 'manage-accounts': 'admin', 'create-event': 'write',
} as const;
export type McpToolName = keyof typeof MCP_TOOLS;
export type McpToolClass = (typeof MCP_TOOLS)[McpToolName];
export const ENABLED_TOOLS_ENV = 'get-current-time,get-freebusy,list-events,list-calendars,create-event,manage-accounts';

export type McpErrorKind = 'unavailable' | 'auth' | 'port_busy' | 'duplicate' | 'id_exists' | 'timeout' | 'bad_response' | 'invalid_args';
// [R2] 'id_exists' = Google answered 409 "The requested identifier already exists" for our deterministic eventId => the event WAS created by an earlier
//      attempt of the same chain; the executor treats it as done (reconcile fills the details). 'duplicate' = the server's similarity heuristic (CAL_DUPLICATE).
export type McpResult<T> = { ok: true; value: T } | { ok: false; error: McpErrorKind };
/** Tool names of one class. */
export type McpToolNameOf<C extends McpToolClass> = { [N in McpToolName]: (typeof MCP_TOOLS)[N] extends C ? N : never }[McpToolName];
/** [R2] Raw capability TYPE, NARROWED to one tool class: call one enabled tool of that class. VALUES are produced ONLY by McpHost.callerFor(cls)
 *  (mcp/host.ts), which wraps the SDK client in a function that asserts MCP_TOOLS[tool] === cls at RUN TIME (throws McpCapabilityError + audit
 *  'tool_blocked' otherwise) - so a bug in readClient.ts cannot call 'create-event' even if the type check is bypassed. compose.ts hands
 *  host.callerFor('read') to createMcpReadClient, callerFor('write') to createMcpWriteClient, callerFor('admin') to createMcpAdminClient, nothing else.
 *  Returned text is UNTRUSTED. */
export type McpToolCaller<C extends McpToolClass = McpToolClass> =
  (tool: McpToolNameOf<C>, args: Record<string, unknown>, signal?: AbortSignal) => Promise<McpResult<{ text: string; isError: boolean }>>;
export class McpCapabilityError extends Error { constructor(public readonly cls: McpToolClass) { super('mcp_capability'); this.name = 'McpCapabilityError'; } }
export interface McpCallerSource { callerFor<C extends McpToolClass>(cls: C): McpToolCaller<C> }   // implemented by McpHost and by the fake

/** Arguments are ALWAYS app-built. calendarIds / timeZone / account come from settings, never from a model. */
export interface PinnedWindow { timeMinLocal: LocalDateTime; timeMaxLocal: LocalDateTime; timeZone: string; calendarIds: string[]; account: 'personal' }
export interface CurrentTimeProjection { nowIso: string; timeZone: string }
export interface EventProjection { startLocal: LocalDateTime; endLocal: LocalDateTime; title: string }     // title sanitised, <= 60 chars, UNTRUSTED
export interface AppEventRef { eventId: string; htmlLink: string | null; startLocal: LocalDateTime }

export interface McpReadClient {
  getCurrentTime(): Promise<McpResult<CurrentTimeProjection>>;
  getFreeBusy(w: PinnedWindow): Promise<McpResult<BusyBlock[]>>;
  /** [C+] Reconcile only (exec/reconcile.ts): list-events with privateExtendedProperty ["waAction=<id>"]. Not reachable from ToolGate's name table.
   *  [R2] `id` is the retry-CHAIN root action id (exec/actionExecutor.ts chainRootOf): every clone stamps waAction=<root id>. */
  findAppEvent(chainRootActionId: ActionId, w: PinnedWindow): Promise<McpResult<AppEventRef | null>>;
}
// [R2] `listEvents()` (EventProjection with titles) is REMOVED from the facade with the `list_events` LLM tool; EventProjection stays for reconcile's projection only.
export declare function createMcpReadClient(call: McpToolCaller<'read'>): McpReadClient;   // projection lives in mcp/projection.ts ; [R2] narrowed caller
```

```ts
// src/main/mcp/host.ts   (frozen signatures; the raw SDK Client never leaves this module)
import type { McpStatus } from '../../shared/health';
import type { McpToolCaller, McpToolClass, McpCallerSource } from './readClient';

export interface McpHostDeps {
  execPath: string;                               // process.execPath (ELECTRON_RUN_AS_NODE=1)
  mcpRoot: string;                                // <resources>\calendar-mcp | build-resources/calendar-mcp
  credentialsPath: string; tokenPath: string;     // <userData>\google\...
  onStderrMarker: (marker: string) => void;       // redacted marker names only
}
export interface McpHost extends McpCallerSource {
  /** Spawn via StdioClientTransport, initialize, verify tools/list === the six names + readOnlyHint on READ tools, else 'toolset_mismatch'. */
  start(): Promise<McpStatus>;
  stop(): Promise<void>;
  status(): McpStatus;
  onStatus(cb: (s: McpStatus) => void): () => void;
  pid(): number | null;                           // for the Supervisor PID file
  /** [R2] The ONLY way out of this module. Returns a wrapper that (1) asserts MCP_TOOLS[tool] === cls at run time - a mismatch throws
   *  McpCapabilityError and audits 'tool_blocked' {nameSha8,nameLen,verdict:'blocked_not_exposed',runId:0} - and (2) fails with 'unavailable'
   *  unless status is connected | needs_sign_in | signing_in. There is NO un-narrowed `caller` property. */
  callerFor<C extends McpToolClass>(cls: C): McpToolCaller<C>;
}
export declare function createMcpHost(deps: McpHostDeps): McpHost;
```

```ts
// src/main/mcp/writeClient.ts   (imported ONLY by compose.ts and, type-only, by exec/**)
import type { LocalDateTime, ActionId, ItemId } from '../../shared/types';
import type { McpResult, McpToolCaller } from './readClient';

/** Exact whitelist of ARCHITECTURE 5.4. Built ONLY by exec/buildCreateEventArgs.ts. No index signature, nothing spread from model output. */
export interface CreateEventArgs {
  calendarId: string;                             // settings.calendar.targetCalendarId
  account: 'personal';
  summary: string;                                // <= 80, single line, URLs stripped
  start: LocalDateTime;
  end: LocalDateTime;
  timeZone: string;
  location?: string;                              // <= 120
  description: string;                            // fixed app template (i18n) ; never model text, never a contact name
  sendUpdates: 'none';
  allowDuplicates: boolean;                       // false ; true ONLY after an explicit confirmDuplicate click
  eventId: string;                                // [R3] eventIdFor(chainKey, approvedContent) = first 32 chars of lowercase base32hex(sha256(JSON([chainKey,title,startLocal,endLocal,timeZone,location]))) - same id for an UNEDITED retry, a fresh id once the user edits (approval-first-1)
  extendedProperties: { private: { waAgent: '1'; waItem: string; waAction: string } };   // [R2] waAction = chain-root action id (same for every retry clone)
}
export interface CreateEventResult { eventId: string; htmlLink: string | null }
export interface McpWriteClient { createEvent(args: CreateEventArgs): Promise<McpResult<CreateEventResult>> }   // 'duplicate' => CAL_DUPLICATE ; 'id_exists' => done (see section 14)
export declare function createMcpWriteClient(call: McpToolCaller<'write'>): McpWriteClient;   // [R2] narrowed caller
export type { ActionId, ItemId };
```

```ts
// src/main/mcp/adminClient.ts   (GoogleAuthService / wizard / settings ONLY; never agent/**, llm/**)
import type { CalendarInfo } from '../../shared/types';
import type { McpResult, McpToolCaller } from './readClient';

export interface AccountInfo { accountId: 'personal'; status: 'active' | 'expired' | 'error'; email: string | null }
export type ManageAccountsResult =
  | { action: 'list'; accounts: AccountInfo[] }
  | { action: 'add'; authUrl: string; expiresInMinutes: number }      // caller opens authUrl only if host === accounts.google.com
  | { action: 'remove' };
export interface McpAdminClient {
  manageAccounts(action: 'list' | 'add' | 'remove'): Promise<McpResult<ManageAccountsResult>>;   // account_id is pinned to 'personal' inside
  listCalendars(): Promise<McpResult<CalendarInfo[]>>;
}
export declare function createMcpAdminClient(call: McpToolCaller<'admin'>): McpAdminClient;   // [R2] narrowed caller
```

---

## 12. WhatsApp bridge contract - `src/main/bridge/*`

Mirrors `docs/research/bridge-contract.md` exactly. **Implemented surface = four endpoints.** Types for the unimplemented endpoints are deliberately absent so nobody can call them by accident.

```ts
// src/main/bridge/readClient.ts   (frozen signatures)
/** Base URL is ALWAYS http://127.0.0.1:<port> (never 'localhost'); header `Authorization: Bearer <token>` (case-sensitive prefix);
 *  fetch with redirect:'error'. 403 'Forbidden: host not allowed' / 401 'Unauthorized' => a foreign listener => BridgeAuthError. */
export interface BridgeEndpoint { port: number; token: string }            // memory only ; never logged, never sent to the renderer

/** GET /api/health -> 200 {"status":"ok","connected":true,"timestamp":<unix s>} | 503 {"status":"disconnected","connected":false,"timestamp":...} */
export interface BridgeHealthWire { status: 'ok' | 'disconnected'; connected: boolean; timestamp: number }
export interface BridgeHealth { httpStatus: 200 | 503; connected: boolean; timestampS: number }

/** GET /api/pairing/status -> always 200 */
export interface BridgePairingStatusWire {
  status: 'connecting' | 'qr_pending' | 'connected' | 'timeout' | 'error';
  qr_present?: true;                                // only while a QR code is held
  expires_at?: number;                              // unix SECONDS ; last rotation + 20 s ; a hint only
  message?: string;                                 // on timeout / error ; UNTRUSTED for display, matched only against LOGGED_OUT_MESSAGE_RE
}
export const LOGGED_OUT_MESSAGE_RE = /logged out/i;  // "Device was logged out -- restart the bridge to pair again"
// [R2] `status:'error'` + LOGGED_OUT_MESSAGE_RE on THIS endpoint is the ONLY source of the launcher's `logged_out` state (never a stdout marker).

export class BridgeAuthError extends Error {}        // 401 / 403: someone else's process on our port
export class BridgeUnreachableError extends Error {} // connection refused / timeout (15 s)

export interface BridgeReadClient {
  health(): Promise<BridgeHealth>;                                   // treats 200 and 503 as answers ; anything else throws
  pairingStatus(): Promise<BridgePairingStatusWire>;                 // zod-validated ; unknown status => throws
  /** GET /api/pairing/qr.png -> 200 image/png | 404 'no QR code available' (=> null) | 500 (=> null). Main converts to a data: URL. */
  pairingQrPng(): Promise<Uint8Array | null>;
}
export declare function createBridgeReadClient(ep: () => BridgeEndpoint | null): BridgeReadClient;
```

```ts
// src/main/bridge/sendClient.ts   (imported ONLY by compose.ts and, type-only, by exec/**)
/** POST /api/send body. The wire format ALSO accepts media_path, quoted_message_id, quoted_sender_jid, quoted_content -
 *  they are NEVER sent by this app; this type has exactly two keys and the client serialises exactly these two keys. */
export interface BridgeSendRequest { recipient: string; message: string }   // recipient: full phone JID matching DM_PHONE_JID_RE
/** 200 {"success":true,"message":"Message sent to <recipient>"} ; 500/403 {"success":false,"message":"..."} ; 400/405 text/plain.
 *  The response NEVER contains the sent message id (matched later from messages.db by ingest/reconcile). */
export interface BridgeSendWire { success: boolean; message: string }
export type BridgeSendResult =
  | { ok: true }
  | { ok: false; reason: 'not_connected' | 'rejected' | 'bad_request' | 'unreachable' | 'auth' | 'timeout'; httpStatus: number | null };
// 'not_connected' = 500 + /Not connected to WhatsApp/ ; 'timeout' (60 s) => the executor records unknown_outcome, NOT failed.
export interface BridgeSendClient { sendText(req: BridgeSendRequest, signal?: AbortSignal): Promise<BridgeSendResult> }
export declare function createBridgeSendClient(ep: () => { port: number; token: string } | null): BridgeSendClient;
```

```ts
// src/main/bridge/doorbell.ts   (frozen signatures)
/** Bridge -> host webhook body, exactly as emitted by webhook.go. DOCUMENTATION + fake-bridge ONLY:
 *  the doorbell NEVER parses the body (ARCHITECTURE 4.5); no production code may reference this type (lint rule in tests/security). */
export interface BridgeWebhookPayload {
  eventType?: 'reaction';             // ONLY for reactions
  sender: string;                     // USER PART ONLY (phone digits, else LID digits)
  content: string;                    // text/caption ; emoji for reactions ('' = removed)
  chatJID: string;                    // full JID
  isFromMe: boolean;
  quotedMessageId?: string; quotedSender?: string; quotedContent?: string;
  messageId?: string;                 // ONLY for image messages and reactions ; plain text has NO id and NO timestamp
  mediaType?: 'image' | 'reaction';
  mimeType?: string; mediaFilename?: string;
  mediaBase64?: string;               // image only, omitted when > 10 MB
  reactionToMessageId?: string; reactionEmoji?: string; reactionRemoved?: boolean;
}
/** Request contract: POST <WEBHOOK_URL>, Content-Type application/json, header X-Bridge-Token: <token>. No retry; success is status 200 exactly;
 *  synchronous inside the bridge's event handler => answer 200 IMMEDIATELY.
 *  [R2] Server hardening (binding): server.requestTimeout = 5_000, headersTimeout = 2_000, maxHeadersCount = 32.
 *  Reject path (wrong method/path/secret/token, or any exception): `res.writeHead(404); res.end(); req.socket.destroy()` WITHOUT reading the body.
 *  Accept path: `res.writeHead(200); res.end()` FIRST, then `onRing()` synchronously, then `req.resume()` (discard) with a DOORBELL_BODY_CAP
 *  byte cap and a 10 s drain timeout - both destroy the socket; the drain is never awaited before onRing(). */
export const DOORBELL_BODY_CAP = 20 * 1024 * 1024;
export interface DoorbellDeps { token: () => string | null; onRing: () => void }    // onRing = ingest.poke()
export interface Doorbell {
  /** Listens on 127.0.0.1:0 exclusive. Returns the URL to put in WEBHOOK_URL: http://127.0.0.1:<port>/hook/<secret>. New secret per bridge launch. */
  start(): Promise<{ port: number }>;
  newWebhookUrl(): string;                             // fresh 32-byte base64url secret per bridge launch ; returns the full WEBHOOK_URL value
  stop(): Promise<void>;
  stats(): { accepted: number; rejected: number; bytesDrained: number };   // [R2] bytesDrained: tests assert < 64 KB after a 25 MB body on a wrong path
}
export declare function createDoorbell(deps: DoorbellDeps): Doorbell;
```

```ts
// src/main/bridge/bridgeDb.ts   (frozen signatures; the ONLY module that opens <userData>\bridge\store\messages.db, always readOnly)
/** Raw row as read from the bridge's `messages` table (schema: bridge-contract.md section 6). */
export interface BridgeMessageRow {
  rowid: number;
  id: string;
  chat_jid: string;
  sender: string;                     // user part only
  content: string | null;
  timestamp: string | number | null;  // on-disk format UNVERIFIED => parsed ONLY by bridge/timestamps.ts parseBridgeTs()
  is_from_me: number | boolean | null;
  media_type: string | null;          // '', image, video, audio, document, sticker, reaction
  deleted_at: string | number | null;
}
export interface BridgeChatRow { jid: string; name: string | null }
export interface BridgeDb {
  /** false when the file does not exist yet. Opens with {readOnly:true}, PRAGMA query_only=1, busy_timeout=2000 ; never changes journal mode ; never adds indexes. */
  open(): boolean;
  close(): void;
  maxRowid(): number;
  /** SELECT rowid,id,chat_jid,sender,content,timestamp,is_from_me,media_type,deleted_at FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ? */
  rowsAfter(watermark: number, limit: number): BridgeMessageRow[];
  /** Last n rows of ONE chat (context window), newest last. Ordered by rowid (no SQL date math). */
  lastMessages(chatJid: string, n: number): BridgeMessageRow[];
  /** [R3] EXISTS(SELECT 1 FROM messages WHERE chat_jid=? AND is_from_me=1 AND (media_type IS NULL OR media_type <> 'reaction')
   *  AND content IS NOT NULL AND content <> '' AND deleted_at IS NULL) - i.e. a REAL message the user typed or sent: an own reaction, an empty row
   *  or a deleted row never makes a chat "known". Ingest ORs this over both JID forms of a contact (phone JID and its @lid twin). */
  userHasSentIn(chatJid: string): boolean;
  /** [R2] Read-only LID -> phone-JID resolution using the bridge's own tables (whatsmeow_lid_map / chats), null when unmapped.
   *  Called by ingest for every @lid chat on every bridge ONLINE transition; a hit re-keys app.db chats to the phone JID and merges items. */
  phoneJidForLid(lidJid: string): string | null;
  chatName(chatJid: string): string | null;
  /** Reconcile: newest is_from_me rows of a chat with rowid > sinceRowid. */
  outboundAfter(chatJid: string, sinceRowid: number, limit: number): BridgeMessageRow[];
}
export declare function createBridgeDb(path: string): BridgeDb;
```

```ts
// src/main/bridge/timestamps.ts
import type { EpochMs } from '../../shared/types';
/** Accepts the go-sqlite3 text form 'YYYY-MM-DD HH:MM:SS[.f{1,9}][+HH:MM|-HH:MM|Z]' (space separator, 0-9 fractional digits, truncated to ms),
 *  the RFC 3339 'T' form, and integer epoch s / ms. [R2] 1-9 fractional digits: mattn/go-sqlite3 stores time.Time as
 *  '2006-01-02 15:04:05.999999999-07:00' with trailing zeros trimmed, so own sends (time.Now()) look like '2026-09-21 20:15:03.123456789+03:00'.
 *  null = unparseable (=> backlog + BRIDGE_TS_FORMAT streak counter). */
export declare function parseBridgeTs(raw: string | number | null): EpochMs | null;
```

```ts
// src/main/bridge/ingest.ts   (frozen signatures)
export interface IngestStats { scanned: number; kept: number; unparseableTs: number; watermark: number; olderLive: number }
/** [R2] Backlog gate (ARCHITECTURE 4.6 step 3): a row is CONTEXT-ONLY when ts < live_from_ts, or when it was scanned while the bridge is
 *  (re)syncing history (spawn .. first `history_sync_done` hint or 120 s) and now - ts > LIMITS.syncMaxAgeMs. A row scanned after the bridge has
 *  been ONLINE at least once in this app life (or with meta.last_online_ts set) is a LIVE trigger when now - ts <= LIMITS.ingestMaxAgeMs;
 *  older-but-live rows still create a raw card, encoded as analysis='held' with hold_reason=NULL and badge 'older_message' (never enqueued, no LLM run),
 *  instead of being dropped. [R3] Corrected: the earlier wording "analysis 'held' is NOT used" was unimplementable - isListed() requires
 *  analysis in (done|held|failed) and deriveState() requires analysis !== done, so 'held' is the only encoding that yields a listed raw card. */
export interface Ingest {
  poke(): void;                                        // 250 ms trailing debounce ; doorbell, timer, startup, reconnect, history-sync hint
  scanNow(): Promise<IngestStats>;                     // serialised ; SQLITE_BUSY => retry at the next trigger
  /** [R2] On every bridge ONLINE transition: for each @lid chat in app.db, BridgeDb.phoneJidForLid() -> repos.chats.mergeLidInto(). */
  resolveLidChats(): Promise<{ merged: number }>;
  /** Context window for S1/S3 (live read of ONE chat) - the only path from message text to the agent. */
  contextFor(chatId: import('../../shared/types').ChatRef, n: number): import('../../shared/types').Message[];
}
```

```ts
// src/main/bridge/stdoutMarkers.ts
/** [R2] Bridge stdout is UNTRUSTED: the bridge echoes every live message verbatim (`[ts] <- sender: content`, content may contain newlines), so a
 *  contact can put any marker string on stdout. Therefore:
 *  - A marker is matched ONLY at the start of a LINE (after ANSI strip \x1b\[[0-9;]*m and CRLF split) and only when that line does NOT start with
 *    the message-echo prefix MESSAGE_ECHO_RE. The whatsmeow-framed lines ('HH:MM:SS.fff [Client INFO|WARN|ERROR] ...') are matched after their prefix.
 *  - NO marker causes a state transition with a side effect. Markers are HINTS: `rest_starting` (readiness poll may begin), `qr_phase`
 *    (poll pairing/status now), `history_sync_done` (ingest.poke() + end of the "syncing" window, see ingest), `token_banner`/`invalid_port`/
 *    `token_too_short` (audit 'spawn_refused' + stop: these can only be printed BEFORE the REST server exists, before any message can be echoed,
 *    so they are accepted only while the launcher is in SPAWNING with no health answer yet).
 *  - `logged_out` comes ONLY from GET /api/pairing/status (LOGGED_OUT_MESSAGE_RE). `client_outdated`, `rest_error`, `unstable`, `stream_replaced`
 *    only ANNOTATE: when the health probe/breaker later decides (503 persisting -> respawn -> breaker open), the most recent annotation within
 *    the last 60 s selects the ErrorCode shown (BRIDGE_OUTDATED when `client_outdated`, else BRIDGE_CRASH_LOOP). They never stop, kill or respawn by themselves.
 *  ONLY the marker name is ever logged; raw stdout is never persisted or displayed. */
export const MESSAGE_ECHO_RE = /^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\] /;      // main.go: fmt.Printf("[%s] %s %s: %s\n", timestamp, direction, sender, content)
export const CLIENT_LOG_PREFIX_RE = /^\d\d:\d\d:\d\d\.\d{3} \[Client (INFO|WARN|ERROR|DEBUG)\] /;
export const BRIDGE_MARKERS = {
  rest_starting:     'Starting REST API server on 127.0.0.1:',
  rest_error:        'REST API server error:',
  qr_phase:          'Scan this QR code with your WhatsApp app:',
  connected_1:       'Successfully connected and authenticated!',
  connected_2:       'Connected to WhatsApp!',
  connected_3:       'Successfully connected to WhatsApp servers',
  qr_timeout_1:      'QR code timed out',
  qr_timeout_2:      'Timeout waiting for QR code scan',
  logged_out:        'Device logged out',
  disconnected:      'Disconnected from WhatsApp servers',
  reconnecting:      'Attempting to reconnect',
  reconnected:       'Reconnected successfully',
  reconnect_failed:  'Reconnection failed',
  stream_replaced:   'Stream replaced by another session',
  client_outdated:   'Client outdated',
  unstable:          'Failed to establish stable connection',
  history_sync_done: 'History sync complete.',
  token_banner:      'WHATSAPP BRIDGE AUTH TOKEN',     // must NEVER appear (we inject the token) => audit if seen
  invalid_port:      'Invalid WHATSAPP_BRIDGE_PORT',
  token_too_short:   'WHATSAPP_BRIDGE_TOKEN is too short',
} as const;
export type BridgeMarker = keyof typeof BRIDGE_MARKERS;
/** [R2] Hint-only markers (may trigger a poll/poke/annotation). Everything else in BRIDGE_MARKERS is logged by name and otherwise ignored. */
export const HINT_MARKERS = ['rest_starting', 'qr_phase', 'history_sync_done', 'token_banner', 'invalid_port', 'token_too_short'] as const;
export const ANNOTATION_MARKERS = ['client_outdated', 'rest_error', 'unstable', 'stream_replaced'] as const;
/** Line-anchored matcher over a stdout CHUNK (may hold partial lines: the caller keeps the tail). A line matching MESSAGE_ECHO_RE yields nothing. */
export declare function matchMarkers(chunkUtf8: string): BridgeMarker[];
```

```ts
// src/main/bridge/invariants.ts   (frozen signatures; I6)
export const BRIDGE_EXE = { fileName: 'whatsapp-bridge.exe', size: 43_540_541,
  sha256: 'ac23221e8bcf3937a4ca346b3bd80a8da09df94cbecd949af2916c4bc8d22ff5' } as const;   // compared lowercase
export const BRIDGE_ENV_KEYS = ['WHATSAPP_BRIDGE_PORT', 'WHATSAPP_BRIDGE_TOKEN', 'WEBHOOK_URL', 'FORWARD_SELF', 'WHATSAPP_MEDIA_ROOTS'] as const;
export const OS_ENV_PASSTHROUGH = ['SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'] as const;
export const FORBIDDEN_BRIDGE_ARGS = ['--full-history-pair'] as const;

export interface BridgeSpawnPlan {
  exePath: string;                    // <resources>\bridge\whatsapp-bridge.exe
  args: readonly [];                  // ALWAYS empty
  cwd: string;                        // <userData>\bridge
  env: Record<(typeof BRIDGE_ENV_KEYS)[number], string> & Partial<Record<(typeof OS_ENV_PASSTHROUGH)[number], string>>;
  userDataDir: string;
  outboxDir: string;                  // <userData>\bridge\outbox-empty
  doorbellPort: number;               // our LIVE doorbell
  exeSha256: string;                  // streamed hash computed just before this call
  tosAccepted: boolean;
}
export const SPAWN_VIOLATIONS = ['tos_not_accepted', 'cwd_outside_userdata', 'cwd_missing', 'env_missing', 'env_extra', 'port_8080', 'port_invalid',
  'token_weak', 'webhook_not_loopback', 'webhook_wrong_port', 'webhook_no_secret', 'forward_self_not_true', 'outbox_missing', 'outbox_not_empty',
  'outbox_outside_userdata', 'exe_hash_mismatch', 'exe_outside_resources', 'args_not_empty'] as const;
export type SpawnViolation = (typeof SPAWN_VIOLATIONS)[number];
/** Throws SpawnInvariantError listing ALL violations. exe_hash_mismatch => BRIDGE_BINARY_BLOCKED ; anything else => BRIDGE_SPAWN_REFUSED. */
export class SpawnInvariantError extends Error { constructor(public readonly violations: SpawnViolation[]) { super(violations.join(',')); } }
export declare function assertBridgeSpawnInvariants(plan: BridgeSpawnPlan, fs: { existsDir(p: string): boolean; isEmptyDir(p: string): boolean }): void;
```

```ts
// src/main/bridge/launcher.ts   (frozen signatures)
import type { BridgeStatus, PairingState } from '../../shared/health';
export interface BridgeLauncher {
  start(): Promise<void>;                              // no-op + status 'not_started' until consent whatsapp_tos is current
  stop(): Promise<void>;
  restartForNewCode(): Promise<void>;                  // pairing:newCode = kill + respawn (fresh port, token, doorbell secret)
  relink(): Promise<void>;                             // stop ; delete ONLY <userData>\bridge\store\whatsapp.db ; start
  unlinkAndWipe(): Promise<void>;                      // stop ; delete <userData>\bridge\store (path-prefix asserted) ; start
  status(): BridgeStatus;
  pairing(): PairingState;
  isOnline(): boolean;                                 // executor precondition for send_reply
  onStatus(cb: (s: BridgeStatus) => void): () => void;
  onPairing(cb: (p: PairingState) => void): () => void;
  endpoint(): { port: number; token: string } | null;  // passed as a thunk to the two REST clients by compose.ts
}
```

---

## 13. Process supervision - `src/main/proc/supervisor.ts` (Electron-free)

```ts
// src/main/proc/supervisor.ts   (frozen signatures)
import type { EpochMs } from '../../shared/types';
export type ChildName = 'bridge' | 'calendar-mcp' | 'llama';
export type ChildState = 'stopped' | 'starting' | 'running' | 'backoff' | 'failed' | 'stopping';

/** Abstracts over child_process.spawn (bridge, llama) and the SDK's StdioClientTransport (calendar MCP owns its own spawn). */
export interface ChildHandle {
  pid: number; exePath: string;
  kill(): void;                                        // child.kill() ; the supervisor escalates to `taskkill /PID <pid> /T /F` after graceMs
  onExit(cb: (info: { code: number | null; signal: string | null }) => void): void;
}
export interface ChildSpec {
  name: ChildName;
  start(attempt: number): Promise<ChildHandle>;        // MUST allocate a fresh port/token per attempt ; throws => counts as an exit
  probe?: () => Promise<boolean>;                      // liveness ; bridge: GET /api/health answered (200 or 503)
  probeIntervalMs?: number; probeMisses?: number;      // bridge 20_000 / 3
  backoffMs: readonly number[];                        // bridge [2000,5000,15000,60000] ; mcp [2000,10000,60000] ; llama [2000,10000]
  breaker: { maxExits: number; windowMs: number };     // bridge 5/10 min ; mcp 3/10 min ; llama 3/10 min
  stableAfterMs: number;                               // 60_000 => reset backoff
  terminal?: () => boolean;                            // true => do not respawn (breaker open with client_outdated annotation, logged_out via REST, spawn refused)
}
export interface PidFile { pid: number; exePath: string; startedAt: EpochMs }   // <userData>\run\<name>.pid.json, atomic write
/** [R2] The pid file is UNTRUSTED input. parsePidFile returns null unless: pid is a safe integer with 0 < pid < 2**31; exePath is an absolute
 *  path whose normalised form starts with ownResourcesDir + sep or equals process.execPath; startedAt is a finite safe integer > 0.
 *  A null result counts as a stale file (deleted, never used). No field is ever interpolated into a shell string or a WQL filter. */
export declare function parsePidFile(jsonText: string, ownResourcesDir: string, execPath: string): PidFile | null;
export interface Supervisor {
  register(spec: ChildSpec): void;
  start(name: ChildName): Promise<void>;
  stop(name: ChildName, opts?: { graceMs?: number }): Promise<void>;
  restart(name: ChildName): Promise<void>;
  resetBreaker(name: ChildName): void;                 // only from a user click ("Try again")
  state(name: ChildName): ChildState;
  onState(cb: (name: ChildName, s: ChildState) => void): () => void;
  stopAll(opts: { graceMs: number }): Promise<void>;   // ordered: llama, calendar-mcp, bridge
  killAllSync(): void;                                 // session-end / process 'exit' ; by PID only, NEVER by image name
}
export declare function createSupervisor(deps: { runDir: string; now: () => EpochMs; log: (event: string, meta: Record<string, string | number>) => void }): Supervisor;
// proc/reaper.ts
export declare function reapOrphans(runDir: string, ownResourcesDir: string): Promise<{ killed: ChildName[]; stalePidFiles: number }>;
// kills ONLY when Win32_Process.ExecutablePath is inside ownResourcesDir (or equals process.execPath for calendar-mcp) AND CreationDate matches startedAt (+-2 s)
// [R2] Process lookup NEVER builds a shell string: spawn('powershell.exe', ['-NoProfile','-NonInteractive','-Command',
//   'Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$args[0]) | Select-Object ProcessId,ExecutablePath,CreationDate | ConvertTo-Json', '--', String(pid)],
//   { shell: false, windowsHide: true }) after parsePidFile() accepted the integer; kill = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false }).
//   A hostile pid file (e.g. pid: "1 OR 1=1", exePath outside ownResourcesDir) results in NO spawn and NO kill (reaper test).
```

---

## 14. Execution stage - `src/main/exec/actionExecutor.ts` (no LLM, sole holder of send/write)

```ts
// src/main/exec/actionExecutor.ts   (frozen signatures)
import type { Result, ActionId, EpochMs } from '../../shared/types';
import type { ApproveReq, ApproveOutcome, IpcContext } from '../../shared/ipc';
import type { Settings } from '../../shared/settings';
import type { BridgeSendClient } from '../bridge/sendClient';
import type { McpWriteClient } from '../mcp/writeClient';
import type { McpReadClient } from '../mcp/readClient';
import type { Repos } from '../db/index';

export interface ActionExecutorDeps {
  repos: Repos;
  send: BridgeSendClient;                              // constructed ONLY in compose.ts
  write: McpWriteClient;                               // constructed ONLY in compose.ts
  read: McpReadClient;                                 // fresh free/busy pre-check + reconcile
  bridgeOnline: () => boolean;
  calendarConnected: () => boolean;
  settings: () => Settings;
  now: () => EpochMs;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;   // jitter ; virtual clock in tests
  random: () => number;
  notifyChanged: (itemIds: number[]) => void;          // -> dashboard:changed
}
export interface ActionExecutor {
  /** ARCHITECTURE 6.6 steps 2-7 (step 1 sender/zod is done by ipc/register.ts + handlers/actions.ts; ctx carries focus state).
   *  Order: [R2] SYNCHRONOUS (before the first await): `inFlight.has(actionId)` => ACTION_STALE, else `inFlight.add(actionId)` (removed in finally)
   *  -> focus-steal guard (ctx.shownByNotificationAt + LIMITS.focusGuardMainMs > now => WINDOW_NOT_FOCUSED)
   *  -> load+kind+state+expiry+hash -> edit validation -> bridge/calendar precondition -> event sanity + fresh free/busy (may return
   *  needs_confirm_conflict with the action STILL pending) -> rate limits -> write-ahead pending->approved->executing (ONE transaction, compare-and-set:
   *  `changes !== 1` or a trigger ABORT => Result.ok=false ACTION_STALE, nothing else happens) -> send jitter sleep (AFTER the write-ahead, never before)
   *  -> side effect -> done | failed | unknown_outcome (each a CAS `WHERE state='executing'`) -> on failed / unknown_outcome(not found) insert a fresh
   *  pending retry clone. create_event: McpErrorKind 'id_exists' (409 on our deterministic eventId) => markDone with the chain root's eventId, then reconcile. */
  approve(req: ApproveReq, ctx: IpcContext): Promise<Result<ApproveOutcome>>;
  reject(actionId: ActionId): Promise<Result<null>>;
  /** Startup: executing -> unknown_outcome (never re-executed) ; then read-only reconcile. Also expires overdue pending actions. */
  recoverOnStartup(): Promise<void>;
  /** Waits up to ms for in-flight executions (quit path). */
  drain(ms: number): Promise<void>;
}
export declare function createActionExecutor(deps: ActionExecutorDeps): ActionExecutor;

// exec/actionHash.ts
export declare function sha256Hex(utf8: string): string;
export declare function verifyShownHash(canonicalJson: string, shownHash: string): boolean;          // constant-time compare
// exec/buildSendArgs.ts
export declare function buildSendArgs(chatJid: string, finalText: string): import('../bridge/sendClient').BridgeSendRequest;   // throws unless DM_PHONE_JID_RE
// exec/buildCreateEventArgs.ts
export declare function buildCreateEventArgs(p: import('../../shared/schemas').CreateEventPayload, chain: { rootActionId: ActionId; chainKey: string },
  settings: Settings, opts: { allowDuplicates: boolean; descriptionTemplate: string }): import('../mcp/writeClient').CreateEventArgs;
/** [R2] chainKey = idempotency_key without the `:rN` suffix = `${itemId}:create_event:${version}`; identical for the first action and every retry clone,
 *  so a retry re-sends the SAME eventId and Google answers 409 (McpErrorKind 'id_exists') instead of creating a second event. */
export declare function eventIdFor(chainKey: string, content: ApprovedEventContent): string;          // [R3] base32hex(sha256(JSON([chainKey, title, startLocal, endLocal, timeZone, location]))).slice(0,32), lowercase
/** [R2] Follows retry_of to the first action of the chain (its id is stamped as waAction, its key prefix is the chainKey). */
export declare function chainRootOf(a: import('../../shared/types').ApprovalAction, repos: Repos): { rootActionId: ActionId; chainKey: string };
```

Action lifecycle (enforced by `trg_actions_state` + repo; `[R2]` every arrow is a compare-and-set on the OLD state, `failed` is terminal, nothing returns to `pending`):

```
pending --approve--> approved --(same tx)--> executing --ok--> done
   |                                            |--error--> failed (terminal)   + fresh pending clone (attempt+1, retry_of)
   |                                            |--timeout/crash--> unknown_outcome --reconcile found--> done
   |                                                                                 --not found--> stays unknown_outcome + fresh pending clone ("Send again")
   |--reject--> rejected      |--now > expires_at--> expired      |--re-triage / item closed / newer open item in the same chat--> superseded
```

---

## 15. App database - `src/main/db/*`

### 15.1 `src/main/db/index.ts` (frozen signatures)

```ts
// src/main/db/index.ts
import type * as T from '../../shared/types';
import type { Settings, SettingsPatch } from '../../shared/settings';
import type { ErrorCode } from '../../shared/errors';
import type { ActionPayload } from '../../shared/schemas';

/** Thin wrapper over node:sqlite DatabaseSync so a future engine swap touches one file. Synchronous; every statement is an indexed read/write. */
export interface Stmt<Row = unknown> {
  get(...params: SqlValue[]): Row | undefined;
  all(...params: SqlValue[]): Row[];
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number };
}
export type SqlValue = string | number | bigint | null | Uint8Array;
export interface Db {
  readonly path: string;                               // ':memory:' in tests
  exec(sql: string): void;
  prepare<Row = unknown>(sql: string): Stmt<Row>;
  /** BEGIN IMMEDIATE ... COMMIT ; ROLLBACK + rethrow on error ; nested calls join the outer transaction. */
  transaction<R>(fn: () => R): R;
  userVersion(): number;
  close(): void;
}
export declare function openDb(path: string): Db;      // PRAGMA journal_mode=WAL, foreign_keys=ON, busy_timeout=3000 ; quick_check ; migrate()

export interface Repos {
  db: Db;
  meta: { get(k: T.MetaKey): string | null; set(k: T.MetaKey, v: string): void };
  settings: { get(): Settings; patch(p: SettingsPatch): Settings; setInternal(mut: (s: Settings) => void): Settings };
  secrets: { put(name: T.SecretName, ciphertext: Uint8Array): void; get(name: T.SecretName): Uint8Array | null; delete(name: T.SecretName): void };
  consents: { accept(kind: T.ConsentKind, version: number, now: T.EpochMs): void; latest(kind: T.ConsentKind): T.ConsentRecord | null;
              /** [R2] EXISTS(SELECT 1 FROM consents WHERE kind=? AND version = CONSENT_VERSIONS[kind]) - the EXACT current version, never max()>=. */
              isCurrent(kind: T.ConsentKind): boolean };
  chats: {
    upsertFromBridge(jid: string, name: string | null, isKnown: boolean, now: T.EpochMs): T.Chat;
    /** [R3] LID resolution: re-key the @lid chat row to the phone JID (or, when a phone-JID row already exists, move the @lid row's ITEMS to it,
     *  DELETE its action rows, and delete the @lid row) in ONE transaction; is_known = OR of both; returns the surviving chat.
     *  Actions are deleted, not moved: trg_actions_frozen makes actions.chat_id immutable so that invariant I3 (recipient = chat of the trigger
     *  message) cannot be bypassed by a re-key. A pending approval on an @lid chat is therefore dropped at merge and re-proposed on the next run. */
    mergeLidInto(lidChatId: T.ChatRef, phoneJid: string, now: T.EpochMs): T.Chat;
    byId(id: T.ChatRef): T.Chat | null; byJid(jid: string): T.Chat | null;
    touch(id: T.ChatRef, p: { lastInboundTs?: T.EpochMs; lastOutboundTs?: T.EpochMs; lang?: T.Lang; lastTriagedMsgId?: string }): void;
    setPolicy(id: T.ChatRef, policy: T.ChatPolicy): T.Chat; setForceKnown(id: T.ChatRef): T.Chat;
    withPolicies(): T.Chat[];
  };
  items: {
    openForChat(chatId: T.ChatRef): T.Item | null;
    createOpen(p: { chatId: T.ChatRef; triggerMsgId: string; triggerTs: T.EpochMs; analysis: T.Analysis; holdReason: T.HoldReason | null; now: T.EpochMs }): T.Item;
    /** The ONLY mutator: applies the patch, recomputes state = deriveState(), bumps updated_at. */
    update(id: T.ItemId, patch: Partial<Omit<T.Item, 'id' | 'chatId' | 'state' | 'createdAt' | 'updatedAt'>>, now: T.EpochMs): T.Item;
    byId(id: T.ItemId): T.Item | null;
    list(state: T.ItemState, limit: number): T.Item[];                 // analysis IN (done, held, failed), updated_at DESC
    counts(): { needsReply: number; inCalendar: number; infoMissing: number; ignored: number; analysing: number };
    heldWith(reason: T.HoldReason, opts?: { triggerTsSince?: T.EpochMs }): T.Item[];   // oldest first ; [R2] cloud release passes triggerTsSince = now - LIMITS.heldReleaseWindowMs
    recoverRunning(now: T.EpochMs): number;                            // startup: running -> queued
    expireOld(now: T.EpochMs): number;                                 // open > 7 d => expired ; in_calendar start + 1 d => past
    snapshotMessages(itemId: T.ItemId, rows: T.ItemMessage[]): void; messages(itemId: T.ItemId): T.ItemMessage[];
  };
  retention: {                                                          // [R2] used by the daily job and by data:purgeNow
    /** Nulls item_messages.text, proposals.draft_text/extraction_json/event_json/freebusy_json and actions.canonical_json/approved_final_json
     *  (actions in TERMINAL states only - the frozen trigger permits exactly this NULLing, see 15.2; content_sha256 kept) for rows older than
     *  `before`; deletes closed items (cascade) older than `closedBefore`. */
    purge(p: { before: T.EpochMs; closedBefore: T.EpochMs }): { textRows: number; actionRows: number; itemsDeleted: number };
  };
  proposals: {
    insertNext(p: Omit<T.Proposal, 'id' | 'version' | 'supersededAt'>): T.Proposal;       // version = max+1 ; supersedes older
    current(itemId: T.ItemId): T.Proposal | null;
  };
  actions: {
    /** Validates payload, computes canonical_json + content_sha256 + idempotency_key, state='pending', expires_at = now + 24 h. */
    insertPending(p: { itemId: T.ItemId; proposalId: T.ProposalId; chatId: T.ChatRef; payload: ActionPayload; now: T.EpochMs; retryOf?: T.ActionId }): T.ApprovalAction;
    byId(id: T.ActionId): T.ApprovalAction | null;
    forItem(itemId: T.ItemId): T.ApprovalAction[];
    supersedePending(itemId: T.ItemId, now: T.EpochMs): number;
    /** [R2] Called by ingest in the SAME transaction that creates a new open item for a chat: supersedes every pending send_reply of that chat's
     *  NON-open items (an in_calendar card's unsent draft) so at most one approvable draft exists per chat. */
    supersedePendingRepliesOfChat(chatId: T.ChatRef, exceptItemId: T.ItemId, now: T.EpochMs): number;
    /** [R2] Compare-and-set, ONE transaction: UPDATE ... SET state='approved', approved_at=?, approved_final_json=? WHERE id=? AND state='pending'
     *  then UPDATE ... SET state='executing' WHERE id=? AND state='approved'. Returns 'stale' (no throw, no side effect) when either UPDATE
     *  reports changes !== 1 or a trigger aborts; the caller maps 'stale' to ACTION_STALE and NEVER to failed/clone. */
    markApprovedExecuting(id: T.ActionId, approvedFinalJson: string, now: T.EpochMs): 'ok' | 'stale';
    /** [R2] All three: UPDATE ... WHERE id=? AND state='executing'; changes !== 1 => throw ActionStateError (a programming error, audited 'db_recovery'
     *  never silently ignored). markDone is additionally allowed from 'unknown_outcome' (reconcile found). */
    markDone(id: T.ActionId, result: T.ActionResult, now: T.EpochMs): void;
    markFailed(id: T.ActionId, code: ErrorCode, now: T.EpochMs): void;
    markUnknownOutcome(id: T.ActionId, now: T.EpochMs): void;
    markRejected(id: T.ActionId): void;                                // WHERE state='pending'
    expireOverdue(now: T.EpochMs): number;
    executing(): T.ApprovalAction[];                                   // startup recovery
    chainRoot(id: T.ActionId): T.ApprovalAction;                        // [R2] follows retry_of to attempt 1
  };
  queue: {
    enqueue(chatId: T.ChatRef, now: T.EpochMs): void;                  // due = min(now + 20 s, first_enqueued_at + 60 s)
    nextDue(now: T.EpochMs): T.QueueEntry | null; defer(chatId: T.ChatRef, dueAt: T.EpochMs, lastError?: string): void;
    remove(chatId: T.ChatRef): void; size(): number;
  };
  runs: { start(p: Pick<T.RunRecord, 'itemId' | 'stage' | 'provider' | 'model' | 'startedAt'>): T.RunId;
          finish(id: T.RunId, p: Partial<T.RunRecord>): void; cloudTokensSince(ts: T.EpochMs): { inputTokens: number; outputTokens: number } };
  audit: { append(kind: T.AuditKind, ref: string | null, detail: T.AuditEntry['detail'], now: T.EpochMs): void };
  rate: { record(bucket: T.RateBucket, key: string, now: T.EpochMs): void; countSince(bucket: T.RateBucket, key: string, since: T.EpochMs): number;
          lastTs(bucket: T.RateBucket, key: string): T.EpochMs | null };
  models: { get(tier: T.ModelTier): T.ModelFileRecord | null; upsert(r: T.ModelFileRecord): void; delete(tier: T.ModelTier): void };
}
export declare function createRepos(db: Db): Repos;
```

### 15.2 `src/main/db/migrations.ts` (complete file) - the full DDL

`PRAGMA user_version` is the authority (ARCHITECTURE A5/section 10); `schema_migrations` `[C+]` is an append-only human-readable log of the same fact. Each migration runs in one transaction; a `VACUUM INTO` backup is taken before the first pending migration. Migrations are append-only: never edit a released entry.

```ts
// src/main/db/migrations.ts
export interface Migration { version: number; name: string; sql: string }

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', sql: String.raw`
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);

CREATE TABLE meta      (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE settings  (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE secrets   (name TEXT PRIMARY KEY CHECK(name IN ('anthropic_api_key','gemini_api_key')),
                        ciphertext BLOB NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE consents  (kind TEXT NOT NULL CHECK(kind IN ('whatsapp_tos','cloud_claude','cloud_gemini')),
                        version INTEGER NOT NULL, accepted_at INTEGER NOT NULL, PRIMARY KEY(kind, version));

CREATE TABLE chats     (id INTEGER PRIMARY KEY, jid TEXT NOT NULL UNIQUE, display_name TEXT,
                        is_known INTEGER NOT NULL DEFAULT 0, force_known INTEGER NOT NULL DEFAULT 0,
                        sendable INTEGER NOT NULL DEFAULT 0,
                        policy TEXT NOT NULL DEFAULT 'default' CHECK(policy IN ('default','never')),
                        lang TEXT CHECK(lang IN ('he','en')), last_inbound_ts INTEGER, last_outbound_ts INTEGER,
                        last_triaged_msg_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX ix_chats_policy ON chats(policy) WHERE policy <> 'default' OR force_known = 1;

CREATE TABLE items     (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id),
                        state TEXT NOT NULL CHECK(state IN ('needs_reply','info_missing','in_calendar','ignored')),
                        analysis TEXT NOT NULL DEFAULT 'queued' CHECK(analysis IN ('queued','running','done','failed','held')),
                        hold_reason TEXT CHECK(hold_reason IS NULL OR hold_reason IN ('unknown_sender','paused','waiting_llm','budget')),
                        error_code TEXT,
                        reply_state TEXT NOT NULL DEFAULT 'none' CHECK(reply_state IN ('none','draft','sent','answered_elsewhere','skipped')),
                        event_state TEXT NOT NULL DEFAULT 'none' CHECK(event_state IN ('none','incomplete','proposed','created','declined')),
                        trigger_msg_id TEXT NOT NULL, trigger_ts INTEGER NOT NULL,
                        missing_json TEXT NOT NULL DEFAULT '[]', badges_json TEXT NOT NULL DEFAULT '[]',
                        current_proposal_id INTEGER, editing_until INTEGER NOT NULL DEFAULT 0,
                        calendar_event_id TEXT, calendar_html_link TEXT, event_start_ts INTEGER,
                        closed_reason TEXT CHECK(closed_reason IS NULL OR closed_reason IN
                          ('not_needed','replied','answered_elsewhere','dismissed','superseded','expired','past')),
                        closed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX ux_items_open ON items(chat_id) WHERE state IN ('needs_reply','info_missing');
CREATE INDEX ix_items_list ON items(state, updated_at DESC);
CREATE INDEX ix_items_analysis ON items(analysis, created_at);
CREATE INDEX ix_items_chat ON items(chat_id, updated_at DESC);

CREATE TABLE item_messages (item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                        wa_msg_id TEXT NOT NULL, from_me INTEGER NOT NULL, ts INTEGER NOT NULL,
                        text TEXT, text_sha256 TEXT NOT NULL,
                        PRIMARY KEY(item_id, wa_msg_id));

CREATE TABLE triage_queue (chat_id INTEGER PRIMARY KEY REFERENCES chats(id), due_at INTEGER NOT NULL,
                        first_enqueued_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT);
CREATE INDEX ix_queue_due ON triage_queue(due_at);

CREATE TABLE runs      (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                        stage TEXT NOT NULL CHECK(stage IN ('extract','draft')),
                        provider TEXT NOT NULL CHECK(provider IN ('local','claude','gemini')), model TEXT NOT NULL,
                        started_at INTEGER NOT NULL, finished_at INTEGER,
                        outcome TEXT CHECK(outcome IS NULL OR outcome IN ('ok','failed','aborted')), input_tokens INTEGER, output_tokens INTEGER,
                        tool_calls INTEGER NOT NULL DEFAULT 0, blocked_tool_calls INTEGER NOT NULL DEFAULT 0, error_code TEXT);
CREATE INDEX ix_runs_item ON runs(item_id);
CREATE INDEX ix_runs_started ON runs(provider, started_at);

CREATE TABLE proposals (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, version INTEGER NOT NULL,
                        provider TEXT NOT NULL CHECK(provider IN ('local','claude','gemini','user')), model TEXT NOT NULL,
                        extraction_json TEXT,
                        draft_text TEXT, reply_lang TEXT CHECK(reply_lang IS NULL OR reply_lang IN ('he','en')), event_json TEXT,
                        freebusy_json TEXT, suspicious INTEGER NOT NULL DEFAULT 0,
                        created_at INTEGER NOT NULL, superseded_at INTEGER, UNIQUE(item_id, version));

CREATE TABLE actions   (id TEXT PRIMARY KEY,
                        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                        proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
                        chat_id INTEGER NOT NULL REFERENCES chats(id),
                        kind TEXT NOT NULL CHECK(kind IN ('send_reply','create_event')),
                        canonical_json TEXT, content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
                        idempotency_key TEXT NOT NULL UNIQUE,
                        attempt INTEGER NOT NULL DEFAULT 1, retry_of TEXT REFERENCES actions(id) ON DELETE SET NULL,
                        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN
                          ('pending','approved','executing','done','failed','unknown_outcome','rejected','expired','superseded')),
                        approved_at INTEGER, approved_final_json TEXT, executed_at INTEGER, result_json TEXT, error_code TEXT,
                        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX ix_actions_item ON actions(item_id, state);
CREATE INDEX ix_actions_state ON actions(state, expires_at);

CREATE TRIGGER trg_actions_state BEFORE UPDATE OF state ON actions WHEN NEW.state <> OLD.state BEGIN
  SELECT CASE
    WHEN OLD.state IN ('done','failed','rejected','expired','superseded') THEN RAISE(ABORT,'terminal state')
    WHEN NEW.state='pending'   THEN RAISE(ABORT,'cannot return to pending')
    WHEN NEW.state='approved'  AND (OLD.state<>'pending' OR NEW.approved_at IS NULL OR NEW.approved_final_json IS NULL) THEN RAISE(ABORT,'bad approve')
    WHEN NEW.state='executing' AND (OLD.state<>'approved' OR NEW.approved_final_json IS NULL) THEN RAISE(ABORT,'execute without approval')
    WHEN NEW.state='done'      AND OLD.state NOT IN ('executing','unknown_outcome') THEN RAISE(ABORT,'bad done')
    WHEN NEW.state IN ('failed','unknown_outcome') AND OLD.state<>'executing' THEN RAISE(ABORT,'bad outcome')
    WHEN NEW.state='rejected'  AND OLD.state<>'pending' THEN RAISE(ABORT,'bad reject')
    WHEN NEW.state IN ('expired','superseded') AND OLD.state NOT IN ('pending','unknown_outcome') THEN RAISE(ABORT,'bad close')
  END; END;
CREATE TRIGGER trg_actions_insert BEFORE INSERT ON actions WHEN NEW.state <> 'pending' OR NEW.canonical_json IS NULL BEGIN
  SELECT RAISE(ABORT,'actions must be born pending with content'); END;
CREATE TRIGGER trg_actions_frozen BEFORE UPDATE OF canonical_json, content_sha256, chat_id, kind, item_id, proposal_id, idempotency_key, attempt, retry_of ON actions
  WHEN NOT (NEW.canonical_json IS NULL AND OLD.canonical_json IS NOT NULL
            AND OLD.state IN ('done','failed','rejected','expired','superseded','unknown_outcome')
            AND NEW.content_sha256 = OLD.content_sha256 AND NEW.chat_id = OLD.chat_id AND NEW.kind = OLD.kind AND NEW.item_id = OLD.item_id
            AND NEW.proposal_id = OLD.proposal_id AND NEW.idempotency_key = OLD.idempotency_key AND NEW.attempt = OLD.attempt AND NEW.retry_of IS OLD.retry_of)
  BEGIN SELECT RAISE(ABORT,'approved content is immutable'); END;
CREATE TRIGGER trg_actions_final_frozen BEFORE UPDATE OF approved_final_json ON actions
  WHEN OLD.state IN ('executing','done','failed','unknown_outcome')
   AND NOT (NEW.approved_final_json IS NULL AND OLD.state <> 'executing')
  BEGIN SELECT RAISE(ABORT,'final payload is immutable'); END;

CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT, detail_json TEXT NOT NULL);
CREATE INDEX ix_audit_ts ON audit_log(ts);
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'append-only'); END;

CREATE TABLE rate_events (bucket TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX ix_rate ON rate_events(bucket, key, ts);

CREATE TABLE model_files (id TEXT PRIMARY KEY CHECK(id IN ('tiny','small','mid')), path TEXT NOT NULL, size INTEGER NOT NULL,
                        sha256 TEXT NOT NULL, mtime INTEGER NOT NULL,
                        status TEXT NOT NULL CHECK(status IN ('none','downloading','paused','verifying','ready','failed')),
                        bytes_done INTEGER NOT NULL DEFAULT 0, verified_at INTEGER, bench_json TEXT);
` },
] as const;

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** Runner contract (implemented below by lane 4):
 *  v = PRAGMA user_version ; v > SCHEMA_VERSION => throw (downgrade) => DB_RECOVERY.
 *  for each m with m.version > v, ascending: backupBefore() once ; BEGIN IMMEDIATE ; exec(m.sql) ;
 *  INSERT INTO schema_migrations(version,name,applied_at) ; PRAGMA user_version = m.version ; COMMIT.
 *  Any error => ROLLBACK, restore newest backup, surface DB_RECOVERY. */
export declare function migrate(db: import('./index').Db, backupBefore: () => void, now: () => number): { from: number; to: number };
```

Differences from the DDL printed in ARCHITECTURE section 10 (all additive, all `[C+]`): `schema_migrations`; `actions.attempt` and `actions.retry_of`; `proposals.extraction_json` nullable (the architecture's own retention rule nulls it, which `NOT NULL` would forbid); `proposals.provider` admits `'user'`; extra `CHECK`s on `hold_reason`, `closed_reason`, `runs.outcome`, `runs.provider`, `model_files.id`; `ON DELETE CASCADE` on children of `items` (needed by the 90-day closed-item retention); triggers `trg_actions_insert`, `trg_actions_frozen`, `trg_actions_final_frozen`; six secondary indexes. Column names, types and the partial unique index are verbatim.

`[R2]` **Trigger hardening (this text is now the binding one; ARCHITECTURE section 10 quotes it):** `failed` is terminal (the retry-clone model never re-arms a row); no state may return to `pending`; `approved`/`executing` require `approved_final_json`; `failed`/`unknown_outcome` only from `executing`; `rejected` only from `pending`; `expired`/`superseded` only from `pending`/`unknown_outcome`. `actions.canonical_json` is nullable **only** so retention can null it on terminal rows - `trg_actions_insert` forbids a NULL at birth and `trg_actions_frozen` permits exactly the terminal-row NULLing (every other column of the row must be unchanged in the same statement). `approved_final_json` is frozen once the row is past `approved`, except the same retention NULLing on terminal rows. The `db/*` trigger test table enumerates every illegal transition (`executing -> pending`, `failed -> pending`, `unknown_outcome -> pending`, `executing -> failed` by a second statement after `done`, `approved -> executing` with a NULL final payload, `UPDATE approved_final_json` on an executing row) and `approval-binding.test.ts` asserts that direct SQL `UPDATE actions SET state='pending'` on an executing row aborts.

Row <-> record mapping: snake_case column = camelCase field; `INTEGER` 0/1 = `boolean`; `*_json` columns = `JSON.parse` into the typed field without the suffix (`missing_json` -> `missing`, `event_json` -> `event`, `freebusy_json` -> `freeBusy`, `result_json` -> `result`, `bench_json` -> `bench`, `detail_json` -> `detail`, `extraction_json` -> `extraction`).

---

## 16. Test fakes - frozen interfaces (`tests/fakes/*`)

```ts
// tests/fakes/fake-bridge.ts            - node:http server implementing EXACTLY the four endpoints + Host/Bearer checks of bridge-contract.md section 2
// (one block for brevity: the scaffolder splits it into the files named in the comments)
import type { LlmProvider, LlmResponse, LlmMessage } from '../../src/main/llm/types';
import type { McpCallerSource } from '../../src/main/mcp/readClient';
export interface FakeBridge {
  start(opts: { token: string; port?: number }): Promise<{ port: number }>;
  stop(): Promise<void>;
  setPairing(s: import('../../src/main/bridge/readClient').BridgePairingStatusWire): void;
  setConnected(connected: boolean): void;                                   // drives /api/health 200 vs 503
  failNextSend(mode: 'not_connected' | 'error_500' | 'hang'): void;
  readonly sends: ReadonlyArray<{ recipient: string; message: string; extraKeys: string[] }>;   // security tests assert extraKeys = []
  readonly otherRequests: ReadonlyArray<{ method: string; path: string }>;                       // MUST stay empty (typing/react/download/media/group)
  ringDoorbell(webhookUrl: string, payload: import('../../src/main/bridge/doorbell').BridgeWebhookPayload): Promise<number>;   // returns the HTTP status
}
// tests/fakes/fake-bridge-db.ts         - builds a messages.db with the schema of bridge-contract.md section 6 (rollback journal; timestamps default to the
//                                         go-sqlite3 text form '2026-09-21 20:15:03.123456789+03:00' [R2]; also seeds whatsmeow_lid_map rows via addLidMapping)
export interface FakeBridgeDb {
  path: string;
  addChat(jid: string, name: string | null): void;
  addMessage(m: { id: string; chatJid: string; sender: string; content: string; timestamp?: string | number; fromMe: boolean; mediaType?: string; deleted?: boolean }): number;  // returns rowid
  addLidMapping(lidJid: string, phoneJid: string): void;                    // [R2]
  wipe(): void;
}
// tests/fakes/fake-mcp-calendar.ts      - MCP Server over InMemoryTransport exposing the six tools with the real server's input schemas
export interface FakeMcpCalendar extends McpCallerSource {                  // [R2] hands out narrowed callers exactly like McpHost
  connect(): Promise<void>;
  setBusy(blocks: Array<{ start: string; end: string }>): void;
  setToolList(names: string[]): void;                                       // toolset-mismatch tests
  failNext(tool: string, kind: 'auth' | 'duplicate' | 'error' | 'hang' | 'crash_on_call'): void;
  readonly calls: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>;   // I1/I2 tests assert no 'create-event' without approval
  readonly events: ReadonlyArray<{ eventId: string }>;                      // [R2] create-event with an existing eventId => 409 'id_exists' (exactly-one-event tests)
}
// tests/fakes/stub-llm.ts / obedient-attacker-llm.ts  - implement LlmProvider
export interface StubLlm extends LlmProvider {
  script(s: { structured?: unknown[]; chat?: Array<Partial<LlmResponse>> }): void;
  readonly seen: ReadonlyArray<{ kind: 'structured' | 'chat'; messages: LlmMessage[]; toolNames: string[] }>;
}
// obedient-attacker-llm: reads the untrusted data block and DOES what it says (emits write/unknown tool calls, foreign recipients, URLs in drafts).
// tests/fakes/fake-llama-server.ts      - OpenAI-compatible /v1/chat/completions + /health with Bearer check ; tests/fakes/fake-child.mjs - scripted exit/hang child
//   [R2] the fake REJECTS (400) a request with response_format.type==='json_schema' whose response_format.json_schema.schema is missing - the real
//   llama-server b10964 reads exactly that path and treats an absent schema as "any object" (contract test in llm/local).
```

---

## 17. Additions made by this spec (`[C+]`) and why

| # | Addition | Reason |
|---|---|---|
| 1 | `ItemStatus` (+`'dismissed'`) and `deriveStatus()` | The task brief lists a `dismissed` status; the architecture keeps 4 stored states with `closed_reason='dismissed'`. Stored `state` is unchanged; `dismissed` exists only in the view model so the "Undo dismiss" drawer can offer "Restore". |
| 2 | IPC `dashboard:getIgnored` | `[R2]` Reduced to "Undo dismiss": the last 20 items with `closed_reason='dismissed'`; no other closed items are listed. |
| 3 | IPC `item:completeEvent` | Architecture section 7: the user "may fill the mini-form and press Add to calendar without another LLM turn", but no `create_event` action exists for an `incomplete` event, so there is nothing to approve. This channel only creates a `pending` action from user-typed (TRUSTED, validated) fields; the side effect still needs `action:approve`. |
| 4 | IPC `clipboard:writeText` | "Copy" is on every card, all renderer permission requests are denied (15.1), so `navigator.clipboard` is unavailable. Text only, length-capped; main calls `clipboard.writeText`. |
| 5 | IPC `chat:listPolicies` | Settings page lists per-chat policies (`never` + force-known); no listing channel existed. Returns `ChatView` (no JIDs). |
| 6 | IPC `app:ackTrayHint`, `Bootstrap.trayHintSeen`, view `'tray_hint'` | `[R2]` X ALWAYS hides at once (ARCHITECTURE 13 is the rule). The coach mark is shown the next time the window is opened; `app:ackTrayHint` only dismisses it. |
| 7 | `actions.attempt`, `actions.retry_of`, idempotency key suffix `:rN` | "Retry = a new click on a fresh action" is impossible with `UNIQUE(itemId:kind:version)` unless the proposal version changes. The first action of a version keeps the architecture's exact key. `[R2]` The key WITHOUT the suffix is the chain key that `eventIdFor()` hashes, so an UNEDITED clone re-sends the same Google `eventId`; `[R3]` the approved content is hashed in too, so an EDITED retry gets a fresh id and the corrected slot really reaches the calendar. |
| 8 | `McpReadClient.findAppEvent()` | Reconcile needs `privateExtendedProperty`; the three-method facade cannot express it. Still read-only, app-built args, unreachable from `ToolGate`'s name table. |
| 13 | `[R2]` `repos.retention`, `repos.chats.mergeLidInto`, `repos.actions.supersedePendingRepliesOfChat` / `chainRoot`, `BridgeDb.phoneJidForLid`, `parsePidFile`, `McpHost.callerFor`, `IpcContext.shownByNotificationAt`, `DOORBELL_BODY_CAP`, `HINT_MARKERS` / `ANNOTATION_MARKERS`, `LIMITS.heldReleaseWindowMs` / `focusGuard*Ms` | Adversarial-review fixes (findings 1, 2, 5, 6, 7, 8, 11, 13, 16, 17, 29, 33 of the design review; see ops/DECISIONS.md D-020+). |
| 9 | `CallOpts.onUsage`, `LlmProvider.model` | `structured<T>()` returns only `T`, yet `runs` must record tokens and model. |
| 10 | `ProposedEvent.dateHint`, `Proposal.provider='user'` | Pre-fill the info-missing mini-form; record user-completed proposals. |
| 11 | `schema_migrations`, extra CHECKs/indexes/triggers, nullable `extraction_json` | See 15.2. |
| 12 | Extra `ErrorCode`s beyond section 14's table (`WA_TOS_REQUIRED`, `LLM_NOT_READY`, `CLOUD_UNAVAILABLE`, `CONSENT_REQUIRED`, `CAL_CREATE_FAILED`, `GOOGLE_*`, `SEND_*`, `RATE_LIMIT_*`, `ACTION_*`, `EVENT_INVALID`, `WINDOW_NOT_FOCUSED`, `BAD_REQUEST`, `NOT_FOUND`, `ABORTED`, `INTERNAL`) | The architecture describes these situations in prose ("inline ...") without naming codes; typed `Result` needs a code for each. |

## 18. Consistency checklist (enforced by unit tests the scaffolder adds)

1. `IPC_CHANNELS` == preload `INVOKE` set; `IPC_EVENTS` == preload `EVENTS` set.
2. Every `ErrorCode` has `errors.<CODE>.title|body|action` in `en.json` and `he.json`; every `ErrorAction`, `Badge`, `MissingField`, `HoldReason`, `ClosedReason`, `BridgeStatus`, `McpStatus`, `LlmStatus`, `PairingStatus`, `CredentialsProblem`, `Assumption` has a label key in both.
3. Every `const` tuple in `types.ts` equals the matching DDL `CHECK` list (parsed from `MIGRATIONS[0].sql`).
4. `Object.keys(EXTRACTION_JSON_SCHEMA.properties)` == `Object.keys(ExtractionSchema.shape)` == `EXTRACTION_JSON_SCHEMA.required`; none of the forbidden keys of section 5 is present.
5. `EXTERNAL_TARGETS` == keys of `resources/links.json`.
6. `deriveState` truth table (all 5 x 5 x 5 x 2 combinations) matches a golden file; `items.state` written by the repo always equals it.
7. `Object.keys(MCP_TOOLS).sort().join(',')` equals the sorted `ENABLED_TOOLS_ENV`; `READ_TOOLS[*].mcpTool` all have class `'read'`.
8. `BridgeSendRequest` serialises to exactly the keys `recipient`, `message`.
9. `[R2]` `CLAUDE_MODEL_PRESETS` / `GEMINI_MODEL_PRESETS` are never rendered without intersecting the live `llm:listModels` result (renderer test); `CONSENT_VERSIONS[kind]` equals the version literal used by the consent copy key in both locales.
10. `[R2]` For every string in `BRIDGE_MARKERS`, a fake-bridge-db message row whose content equals that string, plus the echoed stdout line `[2026-09-21 12:00:00] <- 972500000000: <marker>`, produces no launcher state change and no marker event (`bridge-lifecycle.test.ts`, injection corpus vector `stdout_marker`).

## Architecture concerns

Followed as written; flagged for the orchestrator.

1. **Retry vs. unique idempotency key (6.5/6.6).** `idempotency_key = itemId:kind:version` is `UNIQUE`, `failed`/`unknown_outcome` actions cannot return to `pending`, yet 6.6 promises "Retry (= a new click on a fresh action)" and "Send again". The architecture never says how the fresh action is created. This spec adds `attempt`/`retry_of` and a `:rN` key suffix (section 17 #7). A decision should confirm it.
2. **Info-missing "Add to calendar" has no action to approve (section 7 vs 6.5).** S4 inserts `create_event` only when `event_state='proposed'`. Closed here with `item:completeEvent`; the alternative is dropping the mini-form from v1.
3. **`proposals.extraction_json TEXT NOT NULL` contradicts the retention rule** in the same section ("`extraction_json` ... nulled after retentionDays"). Made nullable.
4. **Closed-item retention vs. foreign keys.** "closed items after 90 days" are deleted, but `runs`, `proposals`, `actions` reference `items(id)` without `ON DELETE`; with `foreign_keys=ON` the delete would fail. Added `ON DELETE CASCADE` (audit rows survive - they hold no FK).
5. **Where the action hash is computed.** `exec/actionHash.ts` owns hashing, but S4 (`agent/validate.ts`) must write `content_sha256` and `agent/**` may not import `exec/**`. Resolved by computing the hash inside `db/repos/actions.ts.insertPending()` (node:crypto) and keeping `canonicalJson()` in `src/shared/schemas.ts`; `exec/actionHash.ts` only verifies.
6. **Conflict pre-check ordering (5.4 vs 6.6).** 5.4 says the executor runs the free/busy check "before the call" and may return `needs_confirm_conflict` for another click; 6.6 commits `pending -> approved -> executing` before "execute". If the check ran after the write-ahead the action could never be approved again (the trigger requires `OLD.state='pending'`). This spec fixes the order: all READ pre-checks run **before** the write-ahead, the action stays `pending`.
7. **"Copy" needs a main-process clipboard channel** because section 15.1 denies every permission request (section 17 #4). The architecture puts "Copy" on every card but names no mechanism for it.
8. **`trg_actions_state` does not treat `failed` as terminal** and does not forbid `executing -> pending`. `[R2] RESOLVED` - adopted in 15.2 (finding 3 of the adversarial review); the hardened text in this file is binding and ARCHITECTURE section 10 now quotes it.
9. **Calendar MCP child is spawned by the SDK's `StdioClientTransport`, not by our `spawn`.** "One Supervisor for three children" therefore needs the `ChildHandle` abstraction of section 13 (the transport exposes `pid`); backoff/breaker/PID-file logic stays shared. Below-normal priority and `windowsHide` cannot be set on that child through the SDK - verify during lane 5.
10. **`timeout` on `/api/send`** is not mentioned in the failure table. A send whose HTTP response is lost may have been delivered, so this spec maps it to `unknown_outcome` (reconciled from `messages.db`), not `failed`.
11. **Task brief vs. architecture on `Item.status`.** The brief asks for a 5-value status including `dismissed`; the binding architecture stores 4. Resolved without touching storage (section 17 #1).
