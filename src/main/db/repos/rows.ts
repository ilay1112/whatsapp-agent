// src/main/db/repos/rows.ts - snake_case row <-> camelCase record mapping (owner W1-04).
// Mapping rule (CONTRACTS 15.2, last paragraph): snake_case column = camelCase field; INTEGER 0/1 = boolean;
// `*_json` columns are JSON.parse'd into the field WITHOUT the suffix (missing_json -> missing, event_json -> event,
// freebusy_json -> freeBusy, result_json -> result, bench_json -> bench, detail_json -> detail, extraction_json -> extraction).
import type * as T from '../../../shared/types';
import type { ErrorCode } from '../../../shared/errors';
import {
  AutoPolicyConfirmSchema,
  AutoScopeSchema,
  EventContentWithStatusSchema,
  EventDeltaSchema,
  ImageReadSchema,
  StoredExtractionSchema,
} from '../../../shared/schemas';
import type { EventContentWithStatus, EventDelta, Extraction, ImageRead } from '../../../shared/schemas';

// ---------------------------------------------------------------------------------------------------------------------
// JSON helpers - every *_json column was written by us, but a restored backup or a hand-edited file must not crash a read.
// ---------------------------------------------------------------------------------------------------------------------
export function parseJson<R>(text: string | null, fallback: R): R {
  if (text === null || text === '') return fallback;
  try {
    return JSON.parse(text) as R;
  } catch {
    return fallback;
  }
}
export function parseJsonOrNull<R>(text: string | null): R | null {
  return parseJson<R | null>(text, null);
}
export const boolOf = (n: number): boolean => n === 1;
export const intOf = (b: boolean): number => (b ? 1 : 0);

// ---------------------------------------------------------------------------------------------------------------------
// chats
// ---------------------------------------------------------------------------------------------------------------------
export interface ChatRow {
  id: number;
  jid: string;
  display_name: string | null;
  is_known: number;
  force_known: number;
  sendable: number;
  policy: string;
  lang: string | null;
  last_inbound_ts: number | null;
  last_outbound_ts: number | null;
  last_triaged_msg_id: string | null;
  created_at: number;
  updated_at: number;
  auto_policy: string; // [V2 ADD] migration v4
  auto_tainted_until: number | null; // [V2 ADD] migration v4
}
export const CHAT_COLUMNS =
  'id, jid, display_name, is_known, force_known, sendable, policy, lang, last_inbound_ts, last_outbound_ts, last_triaged_msg_id, created_at, updated_at, ' +
  'auto_policy, auto_tainted_until';
export function toChat(r: ChatRow): T.Chat {
  return {
    id: r.id,
    jid: r.jid,
    displayName: r.display_name,
    isKnown: boolOf(r.is_known),
    forceKnown: boolOf(r.force_known),
    sendable: boolOf(r.sendable),
    policy: r.policy as T.ChatPolicy,
    lang: r.lang as T.Lang | null,
    lastInboundTs: r.last_inbound_ts,
    lastOutboundTs: r.last_outbound_ts,
    lastTriagedMsgId: r.last_triaged_msg_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    autoPolicy: r.auto_policy as T.ChatAutoPolicy,
    autoTaintedUntil: r.auto_tainted_until,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// items
// ---------------------------------------------------------------------------------------------------------------------
export interface ItemRow {
  id: number;
  chat_id: number;
  state: string;
  analysis: string;
  hold_reason: string | null;
  error_code: string | null;
  reply_state: string;
  event_state: string;
  trigger_msg_id: string;
  trigger_ts: number;
  missing_json: string;
  badges_json: string;
  current_proposal_id: number | null;
  editing_until: number;
  calendar_event_id: string | null;
  calendar_html_link: string | null;
  event_start_ts: number | null;
  closed_reason: string | null;
  closed_at: number | null;
  created_at: number;
  updated_at: number;
  linked_item_id: number | null; // [V2 ADD] migration v4
  event_revision: number; // [V2 ADD]
  calendar_updated: string | null; // [V2 ADD]
  trigger_kind: string; // [V2 ADD]
  event_origin_item_id: number | null; // [V2 ADD, F27]
}
export const ITEM_COLUMNS =
  'id, chat_id, state, analysis, hold_reason, error_code, reply_state, event_state, trigger_msg_id, trigger_ts, missing_json, badges_json, ' +
  'current_proposal_id, editing_until, calendar_event_id, calendar_html_link, event_start_ts, closed_reason, closed_at, created_at, updated_at, ' +
  'linked_item_id, event_revision, calendar_updated, trigger_kind, event_origin_item_id';
export function toItem(r: ItemRow): T.Item {
  return {
    id: r.id,
    chatId: r.chat_id,
    state: r.state as T.ItemState,
    analysis: r.analysis as T.Analysis,
    holdReason: r.hold_reason as T.HoldReason | null,
    errorCode: r.error_code as ErrorCode | null,
    replyState: r.reply_state as T.ReplyState,
    eventState: r.event_state as T.EventState,
    triggerMsgId: r.trigger_msg_id,
    triggerTs: r.trigger_ts,
    missing: parseJson<T.MissingField[]>(r.missing_json, []),
    badges: parseJson<T.Badge[]>(r.badges_json, []),
    currentProposalId: r.current_proposal_id,
    editingUntil: r.editing_until,
    calendarEventId: r.calendar_event_id,
    calendarHtmlLink: r.calendar_html_link,
    eventStartTs: r.event_start_ts,
    closedReason: r.closed_reason as T.ClosedReason | null,
    closedAt: r.closed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    linkedItemId: r.linked_item_id,
    eventRevision: r.event_revision,
    calendarUpdated: r.calendar_updated,
    triggerKind: r.trigger_kind as T.TriggerKind,
    eventOriginItemId: r.event_origin_item_id,
  };
}

export interface ItemMessageRow {
  item_id: number;
  wa_msg_id: string;
  from_me: number;
  ts: number;
  text: string | null;
  text_sha256: string;
}
export function toItemMessage(r: ItemMessageRow): T.ItemMessage {
  return {
    itemId: r.item_id,
    waMsgId: r.wa_msg_id,
    fromMe: boolOf(r.from_me),
    ts: r.ts,
    text: r.text,
    textSha256: r.text_sha256,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// proposals
// ---------------------------------------------------------------------------------------------------------------------
export interface ProposalRow {
  id: number;
  item_id: number;
  version: number;
  provider: string;
  model: string;
  extraction_json: string | null;
  draft_text: string | null;
  reply_lang: string | null;
  event_json: string | null;
  freebusy_json: string | null;
  suspicious: number;
  created_at: number;
  superseded_at: number | null;
  delta_json: string | null; // [V2 ADD] migration v4 (B25 provenance)
  image_json: string | null;
  blocked_calls: number;
  provider_class: string;
  context_from_me_recent: number;
  cross_chat_rows: number;
  trigger_author: string;
}
export const PROPOSAL_COLUMNS =
  'id, item_id, version, provider, model, extraction_json, draft_text, reply_lang, event_json, freebusy_json, suspicious, created_at, superseded_at, ' +
  'delta_json, image_json, blocked_calls, provider_class, context_from_me_recent, cross_chat_rows, trigger_author';
/** [V2] proposals.extraction_json of v1 rows lacks the four B20 fields: read through StoredExtractionSchema (= parseStoredExtraction(),
 *  fail-closed defaults, C2 5). [V2-W1-01 final rule] A row that does not parse at all (a hand-edited file, a restored backup from a
 *  foreign build) reads as `null` - the same value retention leaves behind - never as an unvalidated object whose missing `change` /
 *  `confidence` fields a consumer could misread. */
export function storedExtraction(text: string | null): Extraction | null {
  const raw = parseJsonOrNull<unknown>(text);
  if (raw === null) return null;
  const parsed = StoredExtractionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
/** [V2-W1-01] proposals.delta_json / image_json are persisted, so they are re-validated on read (C2 5); a bad row reads as null. */
export function storedDelta(text: string | null): EventDelta | null {
  const parsed = EventDeltaSchema.safeParse(parseJsonOrNull<unknown>(text));
  return parsed.success ? parsed.data : null;
}
export function storedImageRead(text: string | null): ImageRead | null {
  const parsed = ImageReadSchema.safeParse(parseJsonOrNull<unknown>(text));
  return parsed.success ? parsed.data : null;
}
export function toProposal(r: ProposalRow): T.Proposal {
  return {
    id: r.id,
    itemId: r.item_id,
    version: r.version,
    provider: r.provider as T.ProviderId | 'user',
    model: r.model,
    extraction: storedExtraction(r.extraction_json),
    draftText: r.draft_text,
    replyLang: r.reply_lang as T.Lang | null,
    event: parseJsonOrNull<T.ProposedEvent>(r.event_json),
    freeBusy: parseJsonOrNull<T.BusyBlock[]>(r.freebusy_json),
    suspicious: boolOf(r.suspicious),
    createdAt: r.created_at,
    supersededAt: r.superseded_at,
    delta: storedDelta(r.delta_json),
    imageRead: storedImageRead(r.image_json),
    blockedCalls: r.blocked_calls,
    providerClass: r.provider_class as T.ProviderClass,
    contextFromMeRecent: boolOf(r.context_from_me_recent),
    crossChatRows: r.cross_chat_rows,
    triggerAuthor: r.trigger_author as T.TriggerAuthor,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------------------------------------------------
export interface ActionRow {
  id: string;
  item_id: number;
  proposal_id: number;
  chat_id: number;
  kind: string;
  canonical_json: string | null;
  content_sha256: string;
  idempotency_key: string;
  attempt: number;
  retry_of: string | null;
  state: string;
  approved_at: number | null;
  approved_final_json: string | null;
  executed_at: number | null;
  result_json: string | null;
  error_code: string | null;
  created_at: number;
  expires_at: number;
  approved_by: string | null; // [V2 ADD] migration v4 (B6)
}
export const ACTION_COLUMNS =
  'id, item_id, proposal_id, chat_id, kind, canonical_json, content_sha256, idempotency_key, attempt, retry_of, state, ' +
  'approved_at, approved_final_json, executed_at, result_json, error_code, created_at, expires_at, approved_by';
export function toAction(r: ActionRow): T.ApprovalAction {
  return {
    id: r.id,
    itemId: r.item_id,
    proposalId: r.proposal_id,
    chatId: r.chat_id,
    kind: r.kind as T.ActionKind,
    // [R2] canonical_json is NULL after retention (terminal rows only); the repo maps that to '' and such rows never reach the executor.
    canonicalJson: r.canonical_json ?? '',
    contentSha256: r.content_sha256,
    idempotencyKey: r.idempotency_key,
    attempt: r.attempt,
    retryOf: r.retry_of,
    state: r.state as T.ActionState,
    approvedAt: r.approved_at,
    approvedFinalJson: r.approved_final_json,
    executedAt: r.executed_at,
    result: parseJsonOrNull<T.ActionResult>(r.result_json),
    errorCode: r.error_code as ErrorCode | null,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    approvedBy: r.approved_by,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// queue / consents / model files
// ---------------------------------------------------------------------------------------------------------------------
export interface QueueRow {
  chat_id: number;
  due_at: number;
  first_enqueued_at: number;
  attempts: number;
  last_error: string | null;
  rev: number;
}
export function toQueueEntry(r: QueueRow): T.QueueEntry {
  return {
    chatId: r.chat_id,
    dueAt: r.due_at,
    firstEnqueuedAt: r.first_enqueued_at,
    attempts: r.attempts,
    lastError: r.last_error as ErrorCode | null,
    rev: r.rev,
  };
}

// (No `RunRecord` mapper: `runs` is write-only from the app's side - it is read with aggregates (cloudTokensSince) and by a
//  diagnostics export, never row by row.)

export interface ConsentRow {
  kind: string;
  version: number;
  accepted_at: number;
  terms_read_on?: string | null; // [V2 ADD] migration v4 (absent from v1 SELECT lists)
}
export function toConsent(r: ConsentRow): T.ConsentRecord {
  return {
    kind: r.kind as T.ConsentKind,
    version: r.version,
    acceptedAt: r.accepted_at,
    // [V2-W1-01] the optional field appears only when a date was recorded (cloud_antigravity_cli), so v1 records keep their shape.
    ...(typeof r.terms_read_on === 'string' ? { termsReadOn: r.terms_read_on } : {}),
  };
}

export interface ModelFileRow {
  id: string;
  kind: string; // [V2 ADD] migration v4 (the DDL CHECK ties it to the id)
  path: string;
  size: number;
  sha256: string;
  mtime: number;
  status: string;
  bytes_done: number;
  verified_at: number | null;
  bench_json: string | null;
}
export function toModelFile(r: ModelFileRow): T.ModelFileRecord {
  return {
    id: r.id as T.ModelFileId,
    kind: r.kind as T.ModelFileKind,
    path: r.path,
    size: r.size,
    sha256: r.sha256,
    mtime: r.mtime,
    status: r.status as T.ModelFileStatus,
    bytesDone: r.bytes_done,
    verifiedAt: r.verified_at,
    bench: parseJsonOrNull<T.ModelFileRecord['bench']>(r.bench_json),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// [V2 ADD, V2-W1-01] runs (CLI sandbox proof), event_revisions, auto_policies, auto_decisions, auto_writes, transcripts, media_cache
// ---------------------------------------------------------------------------------------------------------------------
const API_KEY_SOURCES = ['oauth', 'none', 'other', 'unknown'] as const;
const SANDBOX_MISMATCHES = [
  'extra_server',
  'extra_tool',
  'missing_server',
  'server_error',
  'api_key_auth',
  'agent_mismatch',
  'permission_mode',
] as const;
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
/**
 * runs.sandbox_json (B25/B26): enums, numbers and booleans ONLY. The proof is rebuilt key by key from a closed list, so no extra key
 * (a tool name, a server name, any CLI text) can ever be persisted; a value outside its enum/range is refused (null).
 */
export function cleanSandboxProof(p: unknown): T.CliSandboxProof | null {
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  if (typeof o.initOk !== 'boolean' || !isCount(o.toolsCount) || !isCount(o.mcpServers)) return null;
  if (!(API_KEY_SOURCES as readonly unknown[]).includes(o.apiKeySource)) return null;
  if (o.mismatch !== null && !(SANDBOX_MISMATCHES as readonly unknown[]).includes(o.mismatch)) return null;
  return {
    initOk: o.initOk,
    toolsCount: o.toolsCount,
    mcpServers: o.mcpServers,
    apiKeySource: o.apiKeySource as T.CliSandboxProof['apiKeySource'],
    mismatch: o.mismatch as T.CliSandboxProof['mismatch'],
  };
}

/** event_revisions.prev_json / next_json: re-validated on read; NULL after retention (or a bad row) reads as null. */
export function storedContent(text: string | null): EventContentWithStatus | null {
  const parsed = EventContentWithStatusSchema.safeParse(parseJsonOrNull<unknown>(text));
  return parsed.success ? parsed.data : null;
}

export interface EventRevisionRow {
  id: number;
  calendar_event_id: string;
  item_id: number;
  revision: number;
  kind: string;
  prev_json: string | null;
  next_json: string | null;
  action_id: string;
  applied_at: number;
  reverted_by: number | null;
  post_etag: string | null;
  post_updated: string | null;
}
export const EVENT_REVISION_COLUMNS =
  'id, calendar_event_id, item_id, revision, kind, prev_json, next_json, action_id, applied_at, reverted_by, post_etag, post_updated';
export function toEventRevision(r: EventRevisionRow): T.EventRevisionRecord {
  return {
    id: r.id,
    calendarEventId: r.calendar_event_id,
    itemId: r.item_id,
    revision: r.revision,
    kind: r.kind as T.RevisionKind,
    prev: storedContent(r.prev_json),
    next: storedContent(r.next_json),
    actionId: r.action_id,
    appliedAt: r.applied_at,
    revertedBy: r.reverted_by,
    postEtag: r.post_etag,
    postUpdated: r.post_updated,
  };
}

export interface AutoPolicyRow {
  id: string;
  state: string;
  enabled_at: number;
  expires_at: number;
  shadow_until: number;
  confirmed_by: string;
  confirm_json: string;
  scope_json: string;
  snapshot_sha: string;
  paused_reason: string | null;
  disabled_at: number | null;
  disabled_reason: string | null;
}
export const AUTO_POLICY_COLUMNS =
  'id, state, enabled_at, expires_at, shadow_until, confirmed_by, confirm_json, scope_json, snapshot_sha, paused_reason, disabled_at, disabled_reason';
/** The grant is re-validated on EVERY read (AutoScopeSchema / AutoPolicyConfirmSchema .safeParse): a row that does not parse maps to
 *  null, and the caller treats it as "no policy" (fail closed, C2 16.1). */
export function toAutoPolicy(r: AutoPolicyRow): T.AutoPolicyRecord | null {
  const scope = AutoScopeSchema.safeParse(parseJsonOrNull<unknown>(r.scope_json));
  const confirm = AutoPolicyConfirmSchema.safeParse(parseJsonOrNull<unknown>(r.confirm_json));
  if (!scope.success || !confirm.success) return null;
  return {
    id: r.id,
    state: r.state as T.AutoPolicyState,
    enabledAt: r.enabled_at,
    expiresAt: r.expires_at,
    shadowUntil: r.shadow_until,
    confirmedBy: r.confirmed_by as 'native_dialog',
    confirm: confirm.data,
    scope: scope.data,
    snapshotSha: r.snapshot_sha,
    pausedReason: r.paused_reason as T.AutoPausedReason | null,
    disabledAt: r.disabled_at,
    disabledReason: r.disabled_reason as T.AutoDisabledReason | null,
  };
}

export interface AutoDecisionRow {
  id: string;
  policy_id: string;
  action_id: string;
  item_id: number;
  chat_id: number;
  kind: string;
  verdict: string;
  reason: string;
  checks_json: string;
  decided_at: number;
}
export const AUTO_DECISION_COLUMNS =
  'id, policy_id, action_id, item_id, chat_id, kind, verdict, reason, checks_json, decided_at';
export function toAutoDecision(r: AutoDecisionRow): T.AutoDecisionRecord {
  return {
    id: r.id,
    policyId: r.policy_id,
    actionId: r.action_id,
    itemId: r.item_id,
    chatId: r.chat_id,
    kind: r.kind as T.AutoWriteKind,
    verdict: r.verdict as T.AutoVerdict,
    reason: r.reason as T.AutoReason,
    checks: parseJson<T.AutoDecisionRecord['checks']>(r.checks_json, {}),
    decidedAt: r.decided_at,
  };
}

export interface AutoWriteRow {
  id: string;
  decision_id: string;
  action_id: string;
  item_id: number;
  event_id: string;
  kind: string;
  pre_json: string | null;
  revision_id: number | null;
  post_etag: string | null;
  post_updated: string | null;
  post_sequence: number | null;
  undo_state: string;
  undo_until: number;
  undo_action_id: string | null;
  written_at: number;
}
export const AUTO_WRITE_COLUMNS =
  'id, decision_id, action_id, item_id, event_id, kind, pre_json, revision_id, post_etag, post_updated, post_sequence, undo_state, ' +
  'undo_until, undo_action_id, written_at';
export function toAutoWrite(r: AutoWriteRow): T.AutoWriteRecord {
  return {
    id: r.id,
    decisionId: r.decision_id,
    actionId: r.action_id,
    itemId: r.item_id,
    eventId: r.event_id,
    kind: r.kind as T.AutoWriteKind,
    pre: parseJsonOrNull<T.EventSnapshot>(r.pre_json),
    revisionId: r.revision_id,
    postEtag: r.post_etag,
    postUpdated: r.post_updated,
    postSequence: r.post_sequence,
    undoState: r.undo_state as T.AutoUndoState,
    undoUntil: r.undo_until,
    undoActionId: r.undo_action_id,
    writtenAt: r.written_at,
  };
}

export interface TranscriptRow {
  chat_jid: string;
  wa_msg_id: string;
  status: string;
  text: string | null;
  language: string | null;
  seconds: number;
  model_label: string;
  error_code: string | null;
  created_at: number;
}
export const TRANSCRIPT_COLUMNS =
  'chat_jid, wa_msg_id, status, text, language, seconds, model_label, error_code, created_at';
export function toTranscript(r: TranscriptRow): T.TranscriptRecord {
  return {
    chatJid: r.chat_jid,
    waMsgId: r.wa_msg_id,
    status: r.status as T.TranscriptStatus,
    text: r.text,
    language: r.language,
    seconds: r.seconds,
    modelLabel: r.model_label,
    errorCode: r.error_code as ErrorCode | null,
    createdAt: r.created_at,
  };
}

export interface MediaCacheRow {
  item_id: number | null;
  chat_id: number;
  wa_msg_id: string;
  sha256: string;
  width: number;
  height: number;
  bytes: number;
  created_at: number;
}
export const MEDIA_CACHE_COLUMNS = 'item_id, chat_id, wa_msg_id, sha256, width, height, bytes, created_at';
export function toMediaCache(r: MediaCacheRow): T.MediaCacheRecord {
  return {
    itemId: r.item_id,
    chatId: r.chat_id,
    waMsgId: r.wa_msg_id,
    sha256: r.sha256,
    width: r.width,
    height: r.height,
    bytes: r.bytes,
    createdAt: r.created_at,
  };
}
