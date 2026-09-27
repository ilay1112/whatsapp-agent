// src/main/db/repos/rows.ts - snake_case row <-> camelCase record mapping (owner W1-04).
// Mapping rule (CONTRACTS 15.2, last paragraph): snake_case column = camelCase field; INTEGER 0/1 = boolean;
// `*_json` columns are JSON.parse'd into the field WITHOUT the suffix (missing_json -> missing, event_json -> event,
// freebusy_json -> freeBusy, result_json -> result, bench_json -> bench, detail_json -> detail, extraction_json -> extraction).
import type * as T from '../../../shared/types';
import type { ErrorCode } from '../../../shared/errors';

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
}
export const CHAT_COLUMNS =
  'id, jid, display_name, is_known, force_known, sendable, policy, lang, last_inbound_ts, last_outbound_ts, last_triaged_msg_id, created_at, updated_at';
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
}
export const ITEM_COLUMNS =
  'id, chat_id, state, analysis, hold_reason, error_code, reply_state, event_state, trigger_msg_id, trigger_ts, missing_json, badges_json, ' +
  'current_proposal_id, editing_until, calendar_event_id, calendar_html_link, event_start_ts, closed_reason, closed_at, created_at, updated_at';
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
}
export const PROPOSAL_COLUMNS =
  'id, item_id, version, provider, model, extraction_json, draft_text, reply_lang, event_json, freebusy_json, suspicious, created_at, superseded_at';
export function toProposal(r: ProposalRow): T.Proposal {
  return {
    id: r.id,
    itemId: r.item_id,
    version: r.version,
    provider: r.provider as T.ProviderId | 'user',
    model: r.model,
    extraction: parseJsonOrNull<import('../../../shared/schemas').Extraction>(r.extraction_json),
    draftText: r.draft_text,
    replyLang: r.reply_lang as T.Lang | null,
    event: parseJsonOrNull<T.ProposedEvent>(r.event_json),
    freeBusy: parseJsonOrNull<T.BusyBlock[]>(r.freebusy_json),
    suspicious: boolOf(r.suspicious),
    createdAt: r.created_at,
    supersededAt: r.superseded_at,
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
}
export const ACTION_COLUMNS =
  'id, item_id, proposal_id, chat_id, kind, canonical_json, content_sha256, idempotency_key, attempt, retry_of, state, ' +
  'approved_at, approved_final_json, executed_at, result_json, error_code, created_at, expires_at';
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
}
export function toConsent(r: ConsentRow): T.ConsentRecord {
  return { kind: r.kind as T.ConsentKind, version: r.version, acceptedAt: r.accepted_at };
}

export interface ModelFileRow {
  id: string;
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
    id: r.id as T.ModelTier,
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
