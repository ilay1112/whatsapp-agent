// src/main/exec/autoGate.ts   ADD (B8, B9) - PURE, LLM-free, I/O-free. MUST NOT import agent/**, llm/**, ipc/** (import-graph test).
// Owner V2-W1-04-exec-auto. Everything here is a deterministic function of its input: no clock read (only `input.now`), no I/O, no
// randomness, no module state. The reasons are app strings shown on the card; nothing here is ever fed to a model.
import type {
  AutoPolicyRecord,
  ApprovalAction,
  Item,
  Chat,
  Proposal,
  EpochMs,
  AutoReason,
  AutoVerdict,
  BusyBlock,
  CalendarAccessRole,
} from '../../shared/types';
import type { OwnedEventProjection } from '../mcp/readClient';
import { BADGE_SEVERITY, AUTO_RESULT_BADGES, LIMITS } from '../../shared/types';
import { stripInvisible } from '../../shared/schemas';
import { epochMsToLocal, localToEpochMs } from '../../shared/when';
import { busyOverlapping, sameContent } from './eventContent';

/** Everything AutoGate may look at: persisted rows (B25 provenance - never recomputed) + app-side reads done by tryAuto BEFORE calling it. */
export interface AutoGateInput {
  policy: AutoPolicyRecord | null; // repos.autoPolicies.live() ; null => 'no_policy' (no decision row is written)
  snapshotSha: string; // sha256 of the CURRENT AutoSnapshotInput ; != policy.snapshotSha => 'snapshot_changed' (+ pause)
  calendarConnected: boolean;
  updateSurfaceAvailable: boolean; // false => 'undo_unavailable' for EVERY automatic write (creates too: their undo is an update)
  targetAccessRole: CalendarAccessRole; // from meta.calendar_roles_json ; absent => 'unknown' => 'calendar_not_owned'
  approvedCreates: number; // create_event done with approved_by='user' ; < LIMITS.autoTrackRecordCreates => 'no_track_record'
  editsGatePassed: boolean; // FEATURE_GATES[proposal.provider].editsPassed (B30), injected by compose.ts ; false => 'low_confidence' for update_event
  action: ApprovalAction; // kind create_event | update_event, state pending
  payload: import('../../shared/schemas').CreateEventPayload | import('../../shared/schemas').UpdateEventPayload;
  item: Item; // the acting item (triggerKind, badges, missing, linkedItemId)
  chat: Chat; // isKnown, forceKnown, policy, autoPolicy, autoTaintedUntil
  proposal: Proposal; // extraction (intent, confidence, changeConfidence, refersToExisting, suspicious, assumptions via event),
  // blockedCalls, providerClass, contextFromMeRecent, crossChatRows, delta
  sourceItem: Item | null; // update_event: items[item.linkedItemId] ; must be the same chat
  preflight: OwnedEventProjection | null; // update_event: get-event projection taken by tryAuto ; null => 'unknown_prev_state'
  /** [F5/F1] The newest event_revisions row's post_etag / post_updated (the app's last write, undo writes included); items.calendar_updated as
   *  the `updated` fallback. null, or etag === null AND updated === null => 'modified_in_google' (FAIL CLOSED: e.g. a v1-created event without
   *  any v2 revision - its first change must be a click, which records the baseline). Compared field by field when present. */
  lastRecordedWrite: { etag: string | null; updated: string | null } | null;
  editableEventsInChat: number; // [F31] findExistingEvent().editableCount ; > 1 => 'multiple_events' for update_event
  triggerAuthor: import('../../shared/types').TriggerAuthor; // [F28] 'self' is eligible under the same checks (U-v2-13)
  autoEditsOfEvent: number; // auto_writes kind in (update, cancel) for this event_id
  freshBusy: BusyBlock[] | null; // fresh free/busy for the new slot minus the event's own block ; null => fetch failed => 'conflict'
  budget: {
    chatLast30Min: number;
    chatLastHour: number;
    chatToday: number;
    globalLastHour: number;
    globalToday: number;
  };
  now: EpochMs;
  timeZone: string;
  /** [V2-W1-04 addition, D-068 - optional so the frozen shape stays assignable] The active provider's voice / picture golden gates
   *  (FEATURE_GATES[p].voicePassed / .imagesPassed, injected by compose.ts - exec never imports agent/gates.ts). ABSENT = both false
   *  (fail closed: every media-derived item falls back with 'media_derived'). */
  mediaGates?: { voicePassed: boolean; imagesPassed: boolean };
}
export interface AutoGateResult {
  verdict: AutoVerdict; // 'auto' | 'shadow' (policy in shadow and every check passed) | 'fallback'
  reason: AutoReason; // 'ok' for auto / shadow ; the FIRST failing reason otherwise (evaluation order = AUTO_REASONS group order)
  checks: Record<string, string | number | boolean | null>; // -> auto_decisions.checks_json ; metadata only, never text
  pausePolicy: 'circuit_breaker_rate' | 'snapshot_changed' | 'calendar_disconnected' | null; // tryAuto pauses the policy in the same transaction
}

/**
 * Reasons that exist in AUTO_REASONS (and the DB CHECK) but that AutoGate can NEVER return (T2 concern 4, 8.2 group 15 property test):
 * - `policy_shadow`: a shadow policy with every check passing is `{verdict:'shadow', reason:'ok'}` (DB CHECK verdict<->ok);
 * - `no_user_echo`: the user-echo check is deferred to v2.1 (D-057);
 * - `duplicate`: only observable from the server AFTER the write-ahead (P2 10.3 K6) - it is the v1 duplicate card, not a decision.
 */
export const RESERVED_AUTO_REASONS = [
  'policy_shadow',
  'no_user_echo',
  'duplicate',
] as const satisfies readonly AutoReason[];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Every provider class that proved its sandbox (B11/I11); `cli_unproven` never qualifies. */
const SAFE_PROVIDER_CLASSES: ReadonlySet<string> = new Set(['local', 'api_key', 'cli_proven']);
const RESULT_BADGES: ReadonlySet<string> = new Set(AUTO_RESULT_BADGES);

// ---------------------------------------------------------------------------------------------------------------------
// content screen (F9) and title heuristic (G18) - automatic path only; a hit falls back to the ordinary manual card
// ---------------------------------------------------------------------------------------------------------------------

/** A URL (scheme or www.) or a bare domain `name.tld` (letters-only TLD of 2-24 chars). False positives only cost a click. */
const URL_OR_DOMAIN_RE = /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.)|[\p{L}\p{N}-]+\.[a-z]{2,24}(?![\p{L}\p{N}])/iu;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/u;
/** Runs of digits and phone separators; a run with >= 7 digits is a phone-number pattern. */
const PHONE_RUN_RE = /\+?[\d][\d\s().\-/]*[\d]/gu;

function hasPhonePattern(s: string): boolean {
  for (const m of s.matchAll(PHONE_RUN_RE)) {
    let digits = 0;
    for (const ch of m[0]) if (ch >= '0' && ch <= '9') digits += 1;
    if (digits >= 7) return true;
  }
  return false;
}

/** F9: true when `s` must not be written automatically (URL / domain, e-mail, phone pattern, bidi or invisible character). */
export function contentScreenHit(s: string): boolean {
  if (stripInvisible(s) !== s) return true; // the sanitize set: TAG block, bidi controls, zero-width, C0 (\n included is harmless here)
  if (/[\u061C\u00AD\u180E]/u.test(s)) return true; // ALM, soft hyphen, Mongolian vowel separator (invisible, not in stripInvisible)
  return URL_OR_DOMAIN_RE.test(s) || EMAIL_RE.test(s) || hasPhonePattern(s);
}

/** G18: an empty title, digits/punctuation only, or text that reads like an instruction to the agent. */
const INJECTION_TITLE_RE =
  /\b(?:ignore|disregard|forget)\s+(?:all|any|the|previous|prior|above|your)\b|system\s*prompt|\byou\s+are\s+now\b|<<|>>|END-DATA|\b(?:assistant|system|developer)\s*:|\bauto[-\s]?approve|\bapproved?\s+by\b|התעלם|הוראות\s+(?:קודמות|מערכת)/iu;
export function titleRejected(title: string): boolean {
  const t = stripInvisible(title).replace(/\s+/g, ' ').trim();
  if (t === '') return true;
  if (/^[\p{N}\p{P}\p{S}\s]+$/u.test(t)) return true;
  return INJECTION_TITLE_RE.test(t);
}

// ---------------------------------------------------------------------------------------------------------------------
// slot helpers
// ---------------------------------------------------------------------------------------------------------------------

function hourIn(ms: EpochMs, timeZone: string): number {
  return Number(epochMsToLocal(ms, timeZone).slice(11, 13));
}
/** Quiet hours `{from, to}` in local wall-clock hours; `from > to` wraps midnight (22 -> 7 = 22:00..06:59). */
export function inQuietHours(ms: EpochMs, timeZone: string, q: { from: number; to: number } | null): boolean {
  if (q === null || q.from === q.to) return false;
  const h = hourIn(ms, timeZone);
  return q.from < q.to ? h >= q.from && h < q.to : h >= q.from || h < q.to;
}

interface Slot {
  start: EpochMs;
  end: EpochMs;
  startLocal: string;
  endLocal: string;
  timeZone: string;
}
function slotOf(c: { startLocal: string; endLocal: string; timeZone: string }): Slot {
  return {
    start: localToEpochMs(c.startLocal, c.timeZone),
    end: localToEpochMs(c.endLocal, c.timeZone),
    startLocal: c.startLocal,
    endLocal: c.endLocal,
    timeZone: c.timeZone,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// the evaluation
// ---------------------------------------------------------------------------------------------------------------------

type Mode = 'full' | 'phaseA';
type Check = { reason: AutoReason; failed: boolean; pause?: AutoGateResult['pausePolicy']; needsReads?: boolean };

function hasSeverity(item: Item, severity: 'red' | 'amber' | 'info'): boolean {
  return item.badges.some((b) => !RESULT_BADGES.has(b) && BADGE_SEVERITY[b] === severity);
}

/** The ordered check list (ARCH-v2 6.2: policy -> contact/chat -> proposal quality -> provider -> cage -> edits -> budgets; inside a group
 *  the order of AUTO_REASONS). Built lazily so a check that needs data an earlier guard excluded is never evaluated. */
function* checks(
  i: AutoGateInput,
  facts: Record<string, string | number | boolean | null>,
  mode: Mode,
): Generator<Check> {
  const now = i.now;
  const policy = i.policy;
  // ---- policy ----
  yield { reason: 'no_policy', failed: policy === null || policy.state === 'disabled' };
  const p = policy!;
  facts.policyState = p.state;
  yield { reason: 'policy_paused', failed: p.state === 'paused' };
  yield { reason: 'policy_expired', failed: p.state === 'expired' || p.expiresAt <= now };
  yield { reason: 'snapshot_changed', failed: i.snapshotSha !== p.snapshotSha, pause: 'snapshot_changed' };
  yield { reason: 'calendar_disconnected', failed: !i.calendarConnected, pause: 'calendar_disconnected' };
  yield { reason: 'calendar_not_owned', failed: i.targetAccessRole !== 'owner' };
  facts.approvedCreates = i.approvedCreates;
  yield { reason: 'no_track_record', failed: i.approvedCreates < LIMITS.autoTrackRecordCreates };
  yield { reason: 'undo_unavailable', failed: !i.updateSurfaceAvailable };

  // ---- contact / chat ----
  const chat = i.chat;
  yield { reason: 'unknown_contact', failed: !chat.isKnown };
  yield { reason: 'chat_opted_out', failed: chat.policy === 'never' || chat.autoPolicy === 'never' };
  yield { reason: 'chat_tainted', failed: chat.autoTaintedUntil !== null && chat.autoTaintedUntil >= now };
  yield { reason: 'no_user_participation', failed: !i.proposal.contextFromMeRecent };

  // ---- proposal quality ----
  const isUpdate = i.payload.kind === 'update_event';
  const upd = i.payload.kind === 'update_event' ? i.payload : null;
  const create = i.payload.kind === 'create_event' ? i.payload : null;
  const x = i.proposal.extraction;
  facts.kind = i.payload.kind;
  facts.triggerKind = i.item.triggerKind;
  facts.triggerAuthor = i.triggerAuthor;
  facts.badges = i.item.badges.filter((b) => !RESULT_BADGES.has(b)).length;
  yield { reason: 'badge_red', failed: hasSeverity(i.item, 'red') };
  yield { reason: 'badge_amber', failed: hasSeverity(i.item, 'amber') };
  yield { reason: 'badge_info', failed: hasSeverity(i.item, 'info') };
  facts.blockedCalls = i.proposal.blockedCalls;
  yield { reason: 'blocked_tool_call', failed: i.proposal.blockedCalls > 0 };
  yield {
    reason: 'suspicious',
    failed: i.proposal.suspicious || x?.suspicious === true || i.proposal.imageRead?.suspicious === true,
  };
  const assumptions: readonly string[] = [
    ...(i.proposal.event?.assumptions ?? []),
    ...(i.proposal.delta?.assumptions ?? []),
  ];
  yield { reason: 'assumed_hour', failed: assumptions.some((a) => a.startsWith('hour_assumed')) };
  yield { reason: 'missing_fields', failed: i.item.missing.length > 0 };
  const confident = isUpdate
    ? x !== null &&
      x.changeConfidence === 'high' &&
      x.refersToExisting &&
      i.proposal.delta?.confidence !== 'low' &&
      i.proposal.delta?.confidence !== 'medium' &&
      i.editsGatePassed
    : x !== null && x.confidence === 'high';
  facts.editsGatePassed = i.editsGatePassed;
  yield { reason: 'low_confidence', failed: !confident };
  const eligible = upd
    ? upd.change === 'reschedule' || upd.change === 'move' || upd.change === 'cancel'
    : x !== null && (x.intent === 'schedule_request' || x.intent === 'confirmation');
  yield { reason: 'intent_not_eligible', failed: !eligible };
  const title = create ? create.title : upd!.to.title;
  const location = create ? create.location : upd!.to.location;
  yield { reason: 'title_rejected', failed: titleRejected(title) };
  yield {
    reason: 'content_rejected',
    failed: contentScreenHit(title) || contentScreenHit(location) || location.length > LIMITS.autoLocationMaxChars,
  };
  const gates = i.mediaGates ?? { voicePassed: false, imagesPassed: false };
  yield {
    reason: 'media_derived',
    failed:
      (i.item.triggerKind === 'voice' && !gates.voicePassed) || (i.item.triggerKind === 'image' && !gates.imagesPassed),
  };
  facts.crossChatRows = i.proposal.crossChatRows;
  yield { reason: 'cross_chat_rows', failed: i.proposal.crossChatRows > 0 };
  facts.editableEventsInChat = i.editableEventsInChat;
  yield { reason: 'multiple_events', failed: isUpdate && i.editableEventsInChat !== 1 };

  // ---- provider ----
  facts.providerClass = i.proposal.providerClass;
  yield {
    reason: 'provider_unsafe',
    failed:
      !SAFE_PROVIDER_CLASSES.has(i.proposal.providerClass) ||
      i.proposal.provider === 'antigravity_cli' ||
      i.proposal.provider === 'user',
  };

  // ---- cage (B9) ----
  const scope = p.scope;
  const target = create ?? upd!.to;
  const slot = slotOf(target);
  const minutes = Math.round((slot.end - slot.start) / MINUTE_MS);
  facts.minutes = minutes;
  facts.leadMinutes = Math.floor((slot.start - now) / MINUTE_MS);
  yield { reason: 'beyond_horizon', failed: slot.start > now + scope.horizonDays * DAY_MS };
  yield { reason: 'too_long', failed: minutes > scope.maxMinutes || minutes < LIMITS.eventMinMin };
  let tooSoon: boolean;
  let old: Slot | null = null;
  if (upd) {
    old = slotOf(upd.from);
    tooSoon =
      old.start < now + LIMITS.autoEditMinLeadMs ||
      slot.start < now + LIMITS.autoEditMinLeadMs ||
      (slot.start < old.start && slot.start < now + LIMITS.autoEditEarlierMinLeadMs);
  } else {
    tooSoon = slot.start < now + LIMITS.autoCreateMinLeadMs;
  }
  yield { reason: 'too_soon', failed: tooSoon };
  yield {
    reason: 'quiet_hours',
    failed:
      inQuietHours(now, i.timeZone, scope.quietHours) || inQuietHours(slot.start, slot.timeZone, scope.quietHours),
  };
  const isCancel = upd !== null && upd.change === 'cancel';
  const conflicting = isCancel ? [] : i.freshBusy === null ? null : busyOverlapping(i.freshBusy, slot, null);
  facts.conflicts = conflicting === null ? null : conflicting.length;
  yield { reason: 'conflict', failed: conflicting === null || conflicting.length > 0, needsReads: true };

  // ---- edits (update_event only) ----
  if (upd) {
    yield {
      reason: 'edits_not_in_scope',
      failed: (upd.change === 'reschedule' || upd.change === 'move') && !scope.edits,
    };
    yield { reason: 'cancel_not_in_scope', failed: isCancel && !scope.cancels };
    yield { reason: 'cancel_too_soon', failed: isCancel && old!.start < now + LIMITS.autoCancelMinLeadMs };
    // Phase A never looks at Google's copy (P2 10.3): the pre-flight dependent checks K1-K4 run in full mode only.
    if (mode === 'full') yield* preflightChecks(i, upd, facts);
    const moveMs = Math.abs(slot.start - old!.start);
    facts.moveMinutes = Math.round(moveMs / MINUTE_MS);
    yield { reason: 'move_too_far', failed: moveMs > scope.moveMaxDays * DAY_MS };
    facts.autoEditsOfEvent = i.autoEditsOfEvent;
    yield { reason: 'edit_budget', failed: i.autoEditsOfEvent >= LIMITS.autoEditsPerEvent };
  }

  // ---- budgets (auto_chat / auto_global; creates + edits + undos together) ----
  const b = i.budget;
  facts.chatToday = b.chatToday;
  facts.globalToday = b.globalToday;
  yield {
    reason: 'auto_budget',
    failed:
      b.chatLast30Min >= 1 ||
      b.chatLastHour >= LIMITS.autoChatPerHour ||
      b.chatToday >= scope.perChatPerDay ||
      b.globalLastHour >= LIMITS.autoGlobalPerHour ||
      b.globalToday >= scope.globalPerDay,
    pause: 'circuit_breaker_rate',
  };
}

/** K1-K4 (P2 10.3 Phase B, update_event only): the pre-flight get-event projection against the app's rows. */
function* preflightChecks(
  i: AutoGateInput,
  upd: import('../../shared/schemas').UpdateEventPayload,
  facts: Record<string, string | number | boolean | null>,
): Generator<Check> {
  {
    const pf = i.preflight;
    // K1 (F12): no pre-flight, or one without an etag => no pre_json / no If-Match => never an automatic write (I8)
    yield { reason: 'unknown_prev_state', failed: pf === null || pf.etag === null, needsReads: true };
    const src = i.sourceItem;
    yield { reason: 'not_app_event', failed: pf!.priv.waAgent !== '1', needsReads: true };
    const originOk =
      src !== null &&
      src.eventOriginItemId !== null &&
      src.id === upd.targetItemId &&
      src.calendarEventId === upd.targetEventId &&
      src.chatId === i.item.chatId &&
      i.item.chatId === i.action.chatId &&
      pf!.id === upd.targetEventId &&
      pf!.priv.waItem === String(src.eventOriginItemId);
    yield { reason: 'wrong_item', failed: !originOk, needsReads: true };
    yield { reason: 'not_own_copy', failed: !pf!.creatorSelf && !pf!.organizerSelf, needsReads: true };
    yield { reason: 'event_has_attendees', failed: pf!.hasAttendees || pf!.hasRecurrence, needsReads: true };
    yield { reason: 'event_cancelled', failed: pf!.status === 'cancelled', needsReads: true };
    const base = i.lastRecordedWrite;
    const baselineMissing = base === null || (base.etag === null && base.updated === null);
    const baselineMoved =
      !baselineMissing &&
      ((base.etag !== null && pf!.etag !== base.etag) || (base.updated !== null && pf!.updated !== base.updated));
    facts.baseline = baselineMissing ? 'missing' : baselineMoved ? 'moved' : 'same';
    yield {
      reason: 'modified_in_google',
      failed: baselineMissing || baselineMoved || !sameContent(pf!, upd.from),
      needsReads: true,
    };
  }
}

function run(input: AutoGateInput, mode: Mode): AutoGateResult | null {
  const facts: Record<string, string | number | boolean | null> = {};
  const failed: AutoReason[] = [];
  let first: Check | null = null;
  for (const c of checks(input, facts, mode)) {
    // Phase A never looks at a Google read (P2 10.3): `conflict` needs the fresh free/busy, K1-K4 are not even generated.
    if (mode === 'phaseA' && c.needsReads === true) continue;
    if (!c.failed) continue;
    failed.push(c.reason);
    if (first === null) first = c;
    // The first failure decides; a failing guard in the policy group (no_policy) ends evaluation because later checks need the row.
    if (c.reason === 'no_policy') break;
    if (c.reason === 'unknown_prev_state' && mode === 'full') break;
  }
  if (first === null) {
    if (mode === 'phaseA') return null;
    const verdict: AutoVerdict = input.policy!.state === 'shadow' ? 'shadow' : 'auto';
    return { verdict, reason: 'ok', checks: { ...facts, failCount: 0 }, pausePolicy: null };
  }
  return {
    verdict: 'fallback',
    reason: first.reason,
    checks: { ...facts, failCount: failed.length, fails: failed.join('+').slice(0, 128) },
    pausePolicy: first.pause ?? null,
  };
}

/** Exhaustive: a table-driven test has one row per AUTO_REASONS value and an all-clear fixture yielding {verdict:'auto', reason:'ok'}.
 *  Eligibility (B8): chat.isKnown (forceKnown alone does NOT qualify) ; chat.policy !== 'never' ; chat.autoPolicy !== 'never' ;
 *  chat.autoTaintedUntil < now ; proposal.contextFromMeRecent ; zero badges of any tone except AUTO_RESULT_BADGES ; proposal.blockedCalls === 0 ;
 *  !suspicious ; no hour_assumed_* assumption ; item.missing empty ; title + location pass contentScreen() (else 'content_rejected', F9: URL or
 *  bare domain, e-mail address, phone-number pattern (>= 7 digits with separators), any bidi/invisible char (the sanitize.ts set), location >
 *  LIMITS.autoLocationMaxChars) ; update_event: editableEventsInChat === 1 (else 'multiple_events', F31) ; intent in {schedule_request, confirmation} (create) or change in
 *  {reschedule, move} (+ cancel with scope.cancels) (update) ; confidence === 'high' (update: changeConfidence === 'high' && refersToExisting) ;
 *  item.triggerKind === 'text' ; providerClass in {local, api_key, cli_proven} ; crossChatRows === 0.
 *  Cage (B9): accessRole 'owner' ; payload has no attendees/recurrence by construction ; horizon <= scope.horizonDays ; minutes in
 *  [LIMITS.eventMinMin, scope.maxMinutes] ; create start >= now + 15 min ; update old AND new start >= now + 2 h, and new start >= now +
 *  LIMITS.autoEditEarlierMinLeadMs when new start < old start (F2) ; quiet hours ; freshBusy overlap
 *  => conflict ; move <= scope.moveMaxDays ; autoEditsOfEvent < LIMITS.autoEditsPerEvent ; cancel: scope.cancels && start >= now + 24 h ;
 *  update ownership (F27): preflight.priv.waAgent === '1', waItem === String(sourceItem.eventOriginItemId) (the chain root; 'wrong_item'
 *  otherwise), the origin item's chatId === item.chatId === action.chatId, creatorSelf || organizerSelf, status !== 'cancelled',
 *  !hasAttendees, !hasRecurrence, etag/updated equal to lastRecordedWrite (missing baseline => 'modified_in_google', F5) ;
 *  budgets per chat 1/30 min, 2/h, scope.perChatPerDay ; global 4/h, scope.globalPerDay (any hit => 'auto_budget' + pause circuit_breaker_rate). */
export function evaluateAutoGate(input: AutoGateInput): AutoGateResult {
  return run(input, 'full')!;
}

/**
 * [V2-W1-04 addition] P2 10.3 Phase A: every check that needs no Google read (i.e. all but `conflict` and the pre-flight dependent
 * edit checks), in the same order. `null` = Phase A passed and tryAuto may do its reads (pre-flight get-event, fresh free/busy) before
 * the full {@link evaluateAutoGate}. A shadow or paused policy therefore never causes a calendar read for an ineligible proposal.
 */
export function evaluateAutoGatePhaseA(input: AutoGateInput): AutoGateResult | null {
  return run(input, 'phaseA');
}
