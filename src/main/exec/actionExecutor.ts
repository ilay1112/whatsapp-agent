// src/main/exec/actionExecutor.ts   (frozen signatures; v2 bodies by V2-W1-04-exec-auto)
// Frozen signatures pasted verbatim from docs/specs/contracts.md (owner W1-11) + docs/specs/v2-contracts.md 14 (V2-W1-04). THE approval
// gate: this module is the sole holder of the send / write clients (invariant I1') and contains NO LLM import of any kind (ARCH 18).
// The gate order of ARCH 6.6 / PIPELINE 9 (v1 kinds) and of ARCH-v2 7 / C2 14 (update_event) is implemented literally below, and so
// is the automatic path of ARCH-v2 6.3 (tryAuto) and the single undo path of B10 (undoChange / undoAuto / restoreOriginal / cancelEvent).
// Titles / locations are UNTRUSTED contact text: they are compared, copied into the approved payload and sent to the calendar - never
// logged, audited, toasted or shown by this module.
import { randomUUID } from 'node:crypto';
import { LIMITS } from '../../shared/types';
import {
  ActionPayloadSchema,
  EventEditSchema,
  ReplyEditSchema,
  UpdateEventPayloadSchema,
  canonicalJson,
  stripInvisible,
} from '../../shared/schemas';
import { cardKind, deriveStatus } from '../../shared/state';
import { localToEpochMs } from '../../shared/when';
import { isUiLang } from '../../shared/i18n/languages';
import { FLAT_LOCALES } from '../../shared/i18n/resources';
import { verifyShownHash } from './actionHash';
import { buildSendArgs } from './buildSendArgs';
import { buildCreateEventArgs, chainRootOf } from './buildCreateEventArgs';
import { buildUpdateEventArgs } from './buildUpdateEventArgs';
import { createRateLimiter } from './rateLimiter';
import { applyCreateSuccess, applyFailure, applySendSuccess, commitUpdateDone, parseFinalPayload } from './outcome';
import { reconcileUnknown } from './reconcile';
import { evaluateAutoGate, evaluateAutoGatePhaseA } from './autoGate';
import {
  busyOverlapping,
  contentOfProjection,
  equalContent,
  sameContent,
  snapshotOfProjection,
  viewOf,
} from './eventContent';
import { parseCalendarRolesJson } from '../mcp/adminClient';
import type {
  Result,
  ActionId,
  EpochMs,
  ItemId,
  ItemDetail,
  ApprovalAction,
  BusyBlock,
  AutoPolicyRecord,
  AutoPausedReason,
  AutoWriteKind,
  AutoWriteRecord,
  CalendarAccessRole,
  EventRevisionRecord,
  Item,
  ProviderId,
} from '../../shared/types';
import type { ErrorCode } from '../../shared/errors';
import type { ApproveReq, ApproveOutcome, IpcContext } from '../../shared/ipc';
import type { Settings } from '../../shared/settings';
import type { ActionPayload, CreateEventPayload, EventContentWithStatus, SendReplyPayload } from '../../shared/schemas';
import type { BridgeSendClient, BridgeSendRequest, BridgeSendResult } from '../bridge/sendClient';
import type { CreateEventArgs, McpWriteClient } from '../mcp/writeClient';
import type { McpErrorKind, McpReadClient, McpResult, OwnedEventProjection, PinnedWindow } from '../mcp/readClient';
import type { Repos } from '../db/index';
import type { AutoVerdict, AutoReason, AutoDecisionId } from '../../shared/types';
import type { UpdateEventPayload } from '../../shared/schemas';
import type { McpWriteClient as McpWriteClientV2, UpdateEventArgs } from '../mcp/writeClient';
import type { AutoGateInput, AutoGateResult } from './autoGate';

export interface ActionExecutorDeps {
  repos: Repos;
  send: BridgeSendClient; // constructed ONLY in compose.ts
  write: McpWriteClient; // constructed ONLY in compose.ts
  read: McpReadClient; // fresh free/busy pre-check + reconcile
  bridgeOnline: () => boolean;
  calendarConnected: () => boolean;
  settings: () => Settings;
  now: () => EpochMs;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>; // jitter ; virtual clock in tests
  random: () => number;
  notifyChanged: (itemIds: number[]) => void; // -> dashboard:changed
  /** [W1-11 refinement - OPTIONAL and backwards compatible, see ops/agent-notes/W1-11-exec.md]
   *  `ApproveOutcome` carries an `ItemDetail`, but building one is `ItemService`'s job (agent/items.ts) and `exec/**` may not import
   *  `agent/**` (ARCH 18). compose.ts passes `ItemService.detail` here; `ipc/handlers/actions.ts` ALSO re-reads the detail after every
   *  approve, so the IPC response is correct even when this is not wired. Without it a minimal row-only detail is returned. */
  detail?: (itemId: ItemId) => ItemDetail | null;
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

/** [W1-11 addition, not part of the frozen `ActionExecutor`] The direct side-effect entry point TESTS 8.2 item 5 drives: it refuses
 *  every action that is not already `executing` (i.e. that has not gone through the write-ahead) BEFORE touching a client. */
export interface ActionExecutorInternals {
  execute(actionId: ActionId): Promise<ApproveOutcome>;
}
// ======================= [V2 ADD / CHANGE] C2 14 (additive; approve / reject / recoverOnStartup / drain keep their frozen signatures) =======================
export interface ActionExecutorDepsV2 extends ActionExecutorDeps {
  write: McpWriteClientV2; // now with updateEvent (still constructed ONLY in compose.ts)
  updateSurfaceAvailable: () => boolean; // McpHost.updateSurface().available (B4)
  autoGate: (i: AutoGateInput) => AutoGateResult; // = evaluateAutoGate (injected for tests)
  snapshotSha: () => string; // sha256(canonicalJson(AutoSnapshotInput)) of the CURRENT settings/account/provider/app version
  notifyAuto: (e: { kind: 'write' | 'undo' | 'policy'; autoWriteId?: string }) => void; // toast (app text only) + auto:changed ; main-only
  randomUuid: () => string;
  featureGates: (p: import('../../shared/types').ProviderId) => {
    editsPassed: boolean;
    imagesPassed: boolean;
    voicePassed: boolean;
  }; // = FEATURE_GATES (agent/gates.ts) passed in by compose.ts: exec/** never imports agent/**
}
export type AutoDecisionOutcome =
  | { verdict: 'none'; reason: 'no_policy' } // no live policy: nothing recorded (auto_decisions.policy_id is NOT NULL)
  | {
      verdict: AutoVerdict;
      reason: AutoReason;
      decisionId: AutoDecisionId;
      autoWriteId: string | null;
      result: 'done' | 'failed' | 'unknown_outcome' | null;
    };
export interface ActionExecutorV2 extends ActionExecutor {
  /** [V2] approve() additions: sets approved_by 'user' in the write-ahead CAS ; kind 'update_event' gate order of ARCH-v2 7 ; returns
   *  needs_confirm_drift ; CAL_UPDATE_UNAVAILABLE when !updateSurfaceAvailable() ; a done create_event also writes event_revisions rev 1
   *  (kind 'create', prev NULL, next = readback-or-final content) and items.event_revision = 1 in the outcome transaction. */
  /** Called ONLY by the orchestrator after S4, for create_event / update_event (never send_reply), before dashboard:changed (ARCH-v2 6.3). */
  tryAuto(actionId: string): Promise<AutoDecisionOutcome>;
  /** The single undo path (B10, F1/F2/F10): revisionId must be the event's UNDO CANDIDATE = the newest revision with kind <> 'undo' and
   *  reverted_by NULL such that every newer revision of that event is reverted or an 'undo' row (after undo #2 of two automatic edits the
   *  candidate is #1). Inserts a new proposal (provider 'user', version+1, draft carried over - concern 19) and a pending update_event
   *  {change:'undo', from: <newest revision's next_json = current state>, to: candidate.prev, revertOf: candidate.id}, then approves it at once
   *  with approved_by = by through the SAME gates as approve() (drift, gone, foreign, revision CAS, free/busy, rate, write-ahead, readback).
   *  Pre-checks (automatic writes): the pre-flight etag/updated == the NEWEST event_revisions row's post_etag/post_updated (the app's last write,
   *  undo writes included - never the undone write's own auto_writes.post_*), else blocked_changed with zero calls; the RESTORE TARGET's start
   *  (candidate.prev start) is still in the future, else blocked_started; window = auto_writes.undo_until (automatic) / min(restore-target start,
   *  applied_at + LIMITS.manualUndoWindowMs) (manual). Undoing an automatic write also sets chats.auto_tainted_until = now + LIMITS.autoTaintMs
   *  + audit auto_taint in the same transaction (F10). Refused restore of a cancel => pending create_event with prev content ("Add it back", a
   *  click; never AutoGate). Idempotent: a second call on the same revision returns ACTION_STALE. ctx required for 'user'; null only for 'user_toast'. */
  undoChange(
    itemId: ItemId,
    revisionId: number,
    by: 'user' | 'user_toast',
    ctx: IpcContext | null,
  ): Promise<Result<ApproveOutcome>>;
  /** auto:undo / toast Undo: resolves auto_writes -> revision_id and calls undoChange ; bookkeeping auto_writes.undo_state / undo_action_id ;
   *  2 undos in 24 h => policy paused/circuit_breaker_undo. */
  undoAuto(autoWriteId: string, by: 'user' | 'user_toast', ctx: IpcContext | null): Promise<Result<ApproveOutcome>>;
  /** [F1] "Restore original": one undo whose `to` = pre_json of the OLDEST un-reverted automatic write of the item's event since the newest
   *  revision approved by 'user'/'user_toast', revertOf = the newest un-reverted automatic revision; same pre-checks and gates as undoChange;
   *  on done every automatic revision of that span gets reverted_by = the new row (one transaction) and each auto_writes row undo_state='undone'.
   *  Counts as ONE undo for the 2-undos/24 h breaker; taints the chat. */
  restoreOriginal(itemId: ItemId, ctx: IpcContext): Promise<Result<ApproveOutcome>>;
  /** [F32] "Cancel event" (after blocked_started, or from the in-calendar card): new proposal version + pending update_event
   *  {change:'cancel', from: current, to: {...current, status:'cancelled'}} approved at once with 'user' through the approve() gates. */
  cancelEvent(itemId: ItemId, ctx: IpcContext): Promise<Result<ApproveOutcome>>;
}

/** [V2-W1-04] What `createActionExecutor` accepts: the frozen v1 deps (every v1 caller keeps compiling) plus the C2 14 v2 deps, each
 *  OPTIONAL with a FAIL-CLOSED default: no update surface (update_event => CAL_UPDATE_UNAVAILABLE, every automatic write => undo_unavailable),
 *  AutoGate = evaluateAutoGate, snapshot '' (never equals a policy's => snapshot_changed), no toast, crypto uuids, every golden gate closed.
 *  `calendarRoles` is an extra seam (default: meta.calendar_roles_json via mcp/adminClient's parser; absent => not owned). */
export type ActionExecutorInput = ActionExecutorDeps &
  Partial<Omit<ActionExecutorDepsV2, keyof ActionExecutorDeps>> & {
    calendarRoles?: () => Readonly<Record<string, CalendarAccessRole>>;
  };

export class ActionNotExecutingError extends Error {
  constructor(public readonly actionId: ActionId) {
    super('action_not_executing');
    this.name = 'ActionNotExecutingError';
  }
}

const DRAIN_POLL_MS = 25;
/** Months are clamped generously; the exact horizon test lives in agent/validate.ts (S4). */
const MONTH_MS = 31 * 24 * 3_600_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

type SendFailureReason = Extract<BridgeSendResult, { ok: false }>['reason'];

const SEND_FAILURE_CODE: Record<SendFailureReason, ErrorCode> = {
  not_connected: 'SEND_NOT_CONNECTED',
  rejected: 'SEND_FAILED',
  bad_request: 'SEND_FAILED',
  unreachable: 'SEND_FAILED',
  auth: 'SEND_FAILED',
  timeout: 'ACTION_UNKNOWN_OUTCOME', // never reached: 'timeout' is handled as unknown_outcome before this table
};
const MCP_FAILURE_CODE: Record<McpErrorKind, ErrorCode> = {
  unavailable: 'CAL_UNAVAILABLE',
  auth: 'CAL_RECONNECT',
  port_busy: 'CAL_PORT_BUSY',
  duplicate: 'CAL_DUPLICATE',
  id_exists: 'CAL_CREATE_FAILED', // never reached: 'id_exists' is a success path
  timeout: 'ACTION_UNKNOWN_OUTCOME', // never reached: handled as unknown_outcome before this table
  bad_response: 'CAL_CREATE_FAILED',
  invalid_args: 'CAL_CREATE_FAILED',
  not_found: 'CAL_EVENT_GONE', // [V2] update-event / get-event only (V2-W1-04)
  precondition: 'ACTION_STALE', // [V2] HTTP 412 on If-Match (C2 14 step 8; V2-W1-04)
};

function fail<T>(code: ErrorCode): Result<T> {
  return { ok: false, error: { code } };
}

/** Row-only `ItemDetail` used when `deps.detail` is not wired (see ActionExecutorDeps.detail). Never shown by the real app:
 *  `ipc/handlers/actions.ts` replaces it with `ItemService.detail()` before the response leaves main. */
function fallbackDetail(repos: Repos, itemId: ItemId): ItemDetail {
  const item = repos.items.byId(itemId);
  const chat = item ? repos.chats.byId(item.chatId) : null;
  return {
    itemId,
    chat: {
      chatRef: chat?.id ?? 0,
      displayName: '',
      phoneDisplay: '',
      sendable: chat?.sendable ?? false,
      isKnown: chat?.isKnown ?? false,
      policy: chat?.policy ?? 'default',
      autoPolicy: chat?.autoPolicy ?? 'inherit', // [V2]
    },
    status: item ? deriveStatus(item) : 'ignored',
    card: cardKind(item?.analysis ?? 'failed'),
    analysis: item?.analysis ?? 'failed',
    holdReason: item?.holdReason ?? null,
    errorCode: item?.errorCode ?? null,
    replyState: item?.replyState ?? 'none',
    eventState: item?.eventState ?? 'none',
    closedReason: item?.closedReason ?? null,
    trigger: { ts: item?.triggerTs ?? 0, text: null },
    draft: null,
    event: null,
    missing: item?.missing ?? [],
    badges: item?.badges ?? [],
    actions: [],
    // [V2 W0] row-only fallback (never shown, see above): eventKey '' ; ItemService (V2-W1-10) computes the real opaque key.
    calendar:
      item !== null &&
      (item.eventState === 'created' || item.eventState === 'updated' || item.eventState === 'cancelled')
        ? {
            eventStartTs: item.eventStartTs,
            eventKey: '',
            revision: item.eventRevision,
            status: item.eventState === 'cancelled' ? 'cancelled' : 'confirmed',
          }
        : null,
    editingLocked: false,
    updatedAt: item?.updatedAt ?? 0,
    triggerKind: item?.triggerKind ?? 'text',
    change: null,
    changePending: false,
    undo: null,
    auto: null,
    image: null,
    voice: null,
    messages: [],
  };
}

/** Applies the user's edit (TRUSTED but still schema-validated, length-capped, invisible characters stripped).
 *  [V2] `update_event`: the edit touches `to` only (I3': targetEventId / targetItemId / baseRevision / from are not editable), only a
 *  reschedule / move may be edited (a cancel or an undo restores exactly what it names), and the result is re-validated as a whole. */
export function applyEdit(
  payload: ActionPayload,
  edit: ApproveReq['edit'],
): { ok: true; payload: ActionPayload } | { ok: false; code: ErrorCode } {
  if (payload.kind === 'update_event') {
    if (edit === undefined) return { ok: true, payload };
    if ('text' in edit) return { ok: false, code: 'BAD_REQUEST' };
    if (payload.change !== 'reschedule' && payload.change !== 'move') return { ok: false, code: 'BAD_REQUEST' };
    const parsed = EventEditSchema.safeParse({
      title: stripInvisible(edit.title).trim(),
      startLocal: edit.startLocal,
      endLocal: edit.endLocal,
      location: stripInvisible(edit.location).trim(),
    });
    if (!parsed.success) return { ok: false, code: 'EVENT_INVALID' };
    // EventEditSchema has the bounds of EventContentSchema and refuses end <= start: the merged payload is valid by construction
    return { ok: true, payload: UpdateEventPayloadSchema.parse({ ...payload, to: { ...payload.to, ...parsed.data } }) };
  }
  if (payload.kind === 'send_reply') {
    const raw = edit !== undefined && 'text' in edit ? edit.text : payload.text;
    const parsed = ReplyEditSchema.safeParse({ text: stripInvisible(raw) });
    if (!parsed.success) return { ok: false, code: 'BAD_REQUEST' };
    return { ok: true, payload: { ...payload, text: parsed.data.text } };
  }
  const e = edit !== undefined && !('text' in edit) ? edit : null;
  const parsed = EventEditSchema.safeParse({
    title: stripInvisible(e?.title ?? payload.title).trim(),
    startLocal: e?.startLocal ?? payload.startLocal,
    endLocal: e?.endLocal ?? payload.endLocal,
    location: stripInvisible(e?.location ?? payload.location).trim(),
  });
  if (!parsed.success) return { ok: false, code: 'EVENT_INVALID' };
  return { ok: true, payload: { ...payload, ...parsed.data } };
}

/** Re-run of the S4 sanity checks at click time: the proposal may have aged while the card sat on screen. */
export function eventSanity(
  p: Pick<CreateEventPayload, 'startLocal' | 'endLocal' | 'timeZone'>,
  now: EpochMs,
): ErrorCode | null {
  const start = localToEpochMs(p.startLocal, p.timeZone);
  const end = localToEpochMs(p.endLocal, p.timeZone);
  const minutes = (end - start) / 60_000;
  if (minutes < LIMITS.eventMinMin || minutes > LIMITS.eventMaxMin) return 'EVENT_INVALID';
  if (end <= now) return 'EVENT_INVALID';
  if (start > now + LIMITS.eventHorizonMonths * MONTH_MS) return 'EVENT_INVALID';
  return null;
}

/** Same-format local date-time strings compare chronologically (CONTRACTS 5). */
function overlapping(busy: readonly BusyBlock[], p: { startLocal: string; endLocal: string }): BusyBlock[] {
  return busy.filter((b) => b.startLocal < p.endLocal && b.endLocal > p.startLocal);
}

function startOf(c: { startLocal: string; timeZone: string }): EpochMs {
  return localToEpochMs(c.startLocal, c.timeZone);
}

/**
 * [W2-01 integration addition, additive to the frozen `ActionExecutor`] What `createActionExecutor` actually returns.
 * `offerRetryForUnknown()` exists because the retry clone for a CRASH-recovered action cannot be created inside
 * `recoverOnStartup()`: `compose.ts` runs a SECOND `reconcileUnknown()` with the bridge store afterwards (the frozen
 * `ActionExecutorDeps` carries no bridge DB), and an action that second pass resolves to `done` must not get a clone.
 * Every caller written against `ActionExecutor` still compiles.
 */
export type ActionExecutorHandle = ActionExecutorV2 &
  ActionExecutorInternals & {
    /**
     * TESTS section 6 "recovery": after both reconcile passes, every action still `unknown_outcome` gets a fresh
     * PENDING clone so the card can offer "Send again" / "Add again". That is a NEW approval - never a replay - and
     * because the clone keeps the `retry_of` chain, a repeated `create_event` re-uses the chain root's deterministic
     * `eventId`. Idempotent: an action that already has a clone is skipped. Returns how many clones it created.
     */
    offerRetryForUnknown(): number;
  };

/** Who approves a click-path call: the renderer click ('user') or the toast Undo button ('user_toast', undo payloads only - trigger F4). */
type Approver = 'user' | 'user_toast';
/** The automatic write a side effect belongs to (tryAuto only). */
type AutoRun = { autoWriteId: string } | null;
/** In-memory extras of an undo action, keyed by its action id (restoreOriginal's span; lost on a crash - reconcile then reverts `revertOf` only). */
interface UndoExtras {
  extraReverts: number[];
}

export function createActionExecutor(deps: ActionExecutorInput): ActionExecutorHandle {
  const inFlight = new Set<string>();
  const rate = createRateLimiter({ repos: deps.repos, now: deps.now });
  const { repos } = deps;

  // ---- [V2] C2 14 deps with fail-closed defaults (see ActionExecutorInput) ----
  const updateSurfaceAvailable = deps.updateSurfaceAvailable ?? ((): boolean => false);
  const autoGate = deps.autoGate ?? evaluateAutoGate;
  const snapshotSha = deps.snapshotSha ?? ((): string => '');
  const notifyAuto = deps.notifyAuto ?? ((): void => undefined);
  const randomUuid = deps.randomUuid ?? ((): string => randomUUID());
  const featureGates =
    deps.featureGates ??
    ((): { editsPassed: boolean; imagesPassed: boolean; voicePassed: boolean } => ({
      editsPassed: false,
      imagesPassed: false,
      voicePassed: false,
    }));
  const calendarRoles =
    deps.calendarRoles ??
    ((): Readonly<Record<string, CalendarAccessRole>> => parseCalendarRolesJson(repos.meta.get('calendar_roles_json')));

  /** Actions whose LAST outcome was needs_confirm_drift: only for them is `confirmDrift:true` honoured (C2 8 action:approve rule). */
  const driftShown = new Set<ActionId>();
  const undoExtras = new Map<ActionId, UndoExtras>();

  const detailOf = (itemId: ItemId): ItemDetail => deps.detail?.(itemId) ?? fallbackDetail(repos, itemId);
  const targetCalendarId = (): string => deps.settings().calendar.targetCalendarId;

  /** App template, never model text and never a contact name (ARCH 5.4). */
  const descriptionTemplate = (): string => {
    const setting = deps.settings().general.language;
    const lang = isUiLang(setting) ? setting : 'en';
    return FLAT_LOCALES[lang]['calendar.eventDescription'] ?? '';
  };

  /** A CAS miss on a final-state transition is a programming error: audited as 'db_recovery', never silently ignored. */
  const auditedTransition = (ref: ActionId, fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      repos.audit.append('db_recovery', ref, { stage: 'action_transition' }, deps.now());
      throw e;
    }
  };

  /**
   * [R2 / I7] The three writes of a CONFIRMED success - `markDone`, the item consequence and the `action_done` audit -
   * commit as ONE transaction. Torn apart they leave an action in the terminal state `done` whose item row never learned
   * about it, and NO recovery pass revisits such a row (`recoverOnStartup` scans `executing`, `reconcileUnknown` and
   * `offerRetryForUnknown` scan `unknown_outcome`), so the next triage re-drafts the reply / re-proposes the event and
   * offers the user a duplicate they cannot tell is one. Rolling back instead leaves the action `executing`, which
   * startup recovery does see. The `db_recovery` audit stays OUTSIDE the transaction so it survives the rollback.
   */
  const auditedSuccess = (ref: ActionId, fn: () => void): void =>
    auditedTransition(ref, () => repos.db.transaction(fn));

  const cloneForRetry = (a: ApprovalAction, payload: ActionPayload, now: EpochMs): ApprovalAction =>
    repos.actions.insertPending({
      itemId: a.itemId,
      proposalId: a.proposalId,
      chatId: a.chatId,
      payload,
      now,
      retryOf: a.id,
    });

  const markFailure = (a: ApprovalAction, payload: ActionPayload, code: ErrorCode): ApproveOutcome => {
    const now = deps.now();
    auditedTransition(a.id, () => repos.actions.markFailed(a.id, code, now));
    repos.audit.append('action_failed', a.id, { kind: a.kind, attempt: a.attempt, code }, now);
    applyFailure(repos, a, code, now);
    cloneForRetry(a, payload, now);
    return { outcome: 'failed', item: detailOf(a.itemId) };
  };

  /** [V2] CAL_EVENT_GONE / CAL_EVENT_FOREIGN end the action `failed` WITHOUT a retry clone (C2 8 ApproveOutcome note). */
  const markFailureNoClone = (a: ApprovalAction, code: ErrorCode): void => {
    const now = deps.now();
    auditedTransition(a.id, () => repos.actions.markFailed(a.id, code, now));
    repos.audit.append('action_failed', a.id, { kind: a.kind, attempt: a.attempt, code }, now);
    applyFailure(repos, a, code, now);
  };

  const markUnknown = (a: ApprovalAction, payload: ActionPayload): ApproveOutcome => {
    const now = deps.now();
    auditedTransition(a.id, () => repos.actions.markUnknownOutcome(a.id, now));
    repos.audit.append('action_unknown_outcome', a.id, { kind: a.kind, attempt: a.attempt }, now);
    applyFailure(repos, a, 'ACTION_UNKNOWN_OUTCOME', now);
    cloneForRetry(a, payload, now);
    return { outcome: 'failed', item: detailOf(a.itemId) };
  };

  /** get-event, app-side read class only (never exposed to a model). A throw is 'unavailable'. */
  const getEvent = async (eventId: string): Promise<McpResult<OwnedEventProjection>> => {
    try {
      return await deps.read.getEvent(targetCalendarId(), eventId);
    } catch {
      return { ok: false, error: 'unavailable' };
    }
  };

  /** Fresh app-side free/busy for a slot; null when the read failed (the automatic path treats that as a conflict). */
  const readBusy = async (slot: {
    startLocal: string;
    endLocal: string;
    timeZone: string;
  }): Promise<BusyBlock[] | null> => {
    const window: PinnedWindow = {
      timeMinLocal: slot.startLocal,
      timeMaxLocal: slot.endLocal,
      timeZone: slot.timeZone,
      calendarIds: deps.settings().calendar.conflictCalendarIds,
      account: 'personal',
    };
    try {
      const res = await deps.read.getFreeBusy(window);
      return res.ok ? res.value : null;
    } catch {
      return null;
    }
  };

  /** Fresh app-side free/busy right before the write (ARCH 5.4). A read failure is not a conflict: it must not block an approval. */
  const freshBusy = async (
    p: { startLocal: string; endLocal: string; timeZone: string },
    own: { startLocal: string; endLocal: string } | null = null,
  ): Promise<BusyBlock[]> => {
    const busy = await readBusy(p);
    if (busy === null) return [];
    return own === null ? overlapping(busy, p) : busyOverlapping(busy, p, own);
  };

  /** The automatic write behind an action (auto_writes.action_id), or null for a click-approved one. */
  const autoWriteOfAction = (actionId: ActionId): AutoWriteRecord | null => {
    const row = repos.db
      .prepare<{ id: string }>(`SELECT id FROM auto_writes WHERE action_id = ? LIMIT 1`)
      .get(actionId);
    return row === undefined ? null : repos.autoWrites.byId(row.id);
  };

  // -------------------------------------------------------------------------------------------------------------------
  // automatic-mode policy side effects (the policy SERVICE owns the lifecycle; the executor only pauses / expires, B7)
  // -------------------------------------------------------------------------------------------------------------------
  const pausePolicy = (policy: AutoPolicyRecord, reason: AutoPausedReason, now: EpochMs): boolean => {
    if (policy.state === 'paused') return false;
    repos.autoPolicies.setState(policy.id, { state: 'paused', reason });
    repos.audit.append('auto_policy_paused', policy.id, { reason }, now);
    return true;
  };
  const pauseLivePolicy = (reason: AutoPausedReason): void => {
    const live = repos.autoPolicies.live();
    if (live === null) return;
    const now = deps.now();
    if (repos.db.transaction(() => pausePolicy(live, reason, now))) notifyAuto({ kind: 'policy' });
  };

  // -------------------------------------------------------------------------------------------------------------------
  // side effects (reached ONLY with a row that is already `executing`)
  // -------------------------------------------------------------------------------------------------------------------
  const runSend = async (
    a: ApprovalAction,
    payload: SendReplyPayload,
    args: BridgeSendRequest,
  ): Promise<ApproveOutcome> => {
    // [R2] The jitter sleep happens HERE, after the write-ahead - never before it.
    const span = LIMITS.sendJitterMaxMs - LIMITS.sendJitterMinMs;
    await deps.sleep(LIMITS.sendJitterMinMs + Math.floor(deps.random() * (span + 1)));
    let res: BridgeSendResult;
    try {
      res = await deps.send.sendText(args);
    } catch {
      res = { ok: false, reason: 'unreachable', httpStatus: null };
    }
    if (res.ok) {
      const now = deps.now();
      const result = { kind: 'send_reply' as const, waMsgId: null };
      auditedSuccess(a.id, () => {
        repos.actions.markDone(a.id, result, now);
        applySendSuccess(repos, a, payload, now);
        repos.audit.append('action_done', a.id, { kind: 'send_reply', attempt: a.attempt }, now);
      });
      return { outcome: 'done', item: detailOf(a.itemId) };
    }
    // A send that has not answered in 60 s is an UNKNOWN outcome, never a failure (CONTRACTS 12 / ARCH 14).
    if (res.reason === 'timeout') return markUnknown(a, payload);
    return markFailure(a, payload, SEND_FAILURE_CODE[res.reason]);
  };

  const runCreate = async (
    a: ApprovalAction,
    payload: CreateEventPayload,
    args: CreateEventArgs,
    auto: AutoRun,
  ): Promise<ApproveOutcome> => {
    let res: Awaited<ReturnType<McpWriteClient['createEvent']>>;
    try {
      res = await deps.write.createEvent(args);
    } catch {
      res = { ok: false, error: 'unavailable' };
    }
    // [R2] 409 on OUR deterministic eventId => an earlier attempt of the same chain already created THIS event => done, not a duplicate.
    // Sound only because the id is derived from the chain key AND the approved content (buildCreateEventArgs.eventIdFor):
    // an edited retry carries a different id, so it is really created instead of being reported "added" against the old slot.
    const value = res.ok ? res.value : res.error === 'id_exists' ? { eventId: args.eventId, htmlLink: null } : null;
    if (value !== null) {
      // [V2] readback: the rev-1 revision row's next / post_etag / post_updated (the drift baseline of the first change / undo, F1/F5).
      const rb = await getEvent(value.eventId);
      const readback = rb.ok && rb.value.id === value.eventId ? rb.value : null;
      const now = deps.now();
      const result = { kind: 'create_event' as const, eventId: value.eventId, htmlLink: value.htmlLink };
      auditedSuccess(a.id, () => {
        repos.actions.markDone(a.id, result, now);
        applyCreateSuccess(repos, a, payload, result, now, readback);
        repos.audit.append('action_done', a.id, { kind: 'create_event', attempt: a.attempt }, now);
        if (auto !== null) {
          const rev = repos.eventRevisions.newestFor(value.eventId);
          if (rev !== null) {
            repos.autoWrites.recordReadback(auto.autoWriteId, {
              revisionId: rev.id,
              postEtag: readback?.etag ?? null,
              postUpdated: readback?.updated ?? null,
              postSequence: readback?.sequence ?? null,
            });
          }
        }
      });
      return { outcome: 'done', item: detailOf(a.itemId) };
    }
    if (!res.ok && res.error === 'timeout') return markUnknown(a, payload);
    return markFailure(a, payload, MCP_FAILURE_CODE[(res as { error: McpErrorKind }).error]);
  };

  /** [V2] CAL_EVENT_GONE: the action ends failed (no clone) and, when the change would leave a live event, a pending create_event with
   *  the `to` content is offered as "Add as new event" / "Add it back" (a click; never through AutoGate). */
  const offerAddAsNew = (a: ApprovalAction, p: UpdateEventPayload): void => {
    markFailureNoClone(a, 'CAL_EVENT_GONE');
    if (p.to.status !== 'cancelled') offerCreate(a, p); // a cancel of a gone event already holds: nothing to add
  };

  /** A pending create_event with the `to` content of `p` on the action's item and proposal version - "Add as new event" after
   *  CAL_EVENT_GONE, "Add it back" after a refused restore (U-E1). Always a CLICK (never AutoGate: tryAuto refuses anything that is
   *  not the proposal's own action). At most one per proposal version: an existing offer is kept as it is. */
  const offerCreate = (a: ApprovalAction, p: UpdateEventPayload): void => {
    if (repos.actions.forItem(a.itemId).some((x) => x.kind === 'create_event' && x.proposalId === a.proposalId)) return;
    const create: CreateEventPayload = {
      v: 1,
      kind: 'create_event',
      itemId: p.itemId,
      chatRef: p.chatRef,
      proposalVersion: p.proposalVersion,
      title: p.to.title,
      startLocal: p.to.startLocal,
      endLocal: p.to.endLocal,
      timeZone: p.to.timeZone,
      location: p.to.location,
    };
    repos.actions.insertPending({
      itemId: a.itemId,
      proposalId: a.proposalId,
      chatId: a.chatId,
      payload: create,
      now: deps.now(),
    });
  };

  /** `done` requires a readback of THIS event in the approved status and slot (C2 14 step 9); anything else is unknown_outcome. */
  const readbackMatches = (rb: OwnedEventProjection, p: UpdateEventPayload): boolean =>
    rb.id === p.targetEventId &&
    rb.status === p.to.status &&
    (p.to.status === 'cancelled' || (rb.startLocal === p.to.startLocal && rb.endLocal === p.to.endLocal));

  const runUpdate = async (
    a: ApprovalAction,
    p: UpdateEventPayload,
    args: UpdateEventArgs,
    auto: AutoRun,
  ): Promise<ApproveOutcome> => {
    let res: Awaited<ReturnType<McpWriteClientV2['updateEvent']>>;
    try {
      res = await deps.write.updateEvent(args);
    } catch {
      res = { ok: false, error: 'unavailable' };
    }
    if (!res.ok) {
      switch (res.error) {
        case 'precondition': {
          // C2 14 step 8 / concern 12: the 412 arrives AFTER the write-ahead, so the action cannot stay pending: failed ACTION_STALE +
          // a pending clone, and the outcome asks the drift question about the clone (confirmDrift is honoured for it).
          const outcome = markFailure(a, p, 'ACTION_STALE');
          const clone = repos.actions.forItem(a.itemId).find((x) => x.retryOf === a.id && x.state === 'pending');
          if (clone !== undefined) driftShown.add(clone.id);
          const fresh = await getEvent(p.targetEventId);
          const current = viewOf(fresh.ok ? contentOfProjection(fresh.value) : p.from);
          return { outcome: 'needs_confirm_drift', current, item: outcome.item };
        }
        case 'timeout':
          return markUnknown(a, p);
        case 'unavailable':
          // The host refuses update-event while the update surface is off: nothing left the app (W1-02 notes (c)).
          if (!updateSurfaceAvailable()) return markFailure(a, p, 'CAL_UPDATE_UNAVAILABLE');
          return markUnknown(a, p);
        case 'not_found':
          offerAddAsNew(a, p);
          return { outcome: 'failed', item: detailOf(a.itemId) };
        case 'auth':
          return markFailure(a, p, 'CAL_RECONNECT');
        default:
          return markFailure(a, p, 'CAL_UPDATE_FAILED');
      }
    }
    const rb = await getEvent(p.targetEventId);
    if (!rb.ok || !readbackMatches(rb.value, p)) {
      // [U-E1] the undo of a cancel that Google refused (readback still cancelled): the card offers "Add it back" (a click).
      if (rb.ok && p.change === 'undo' && p.to.status === 'confirmed' && rb.value.status === 'cancelled') {
        const outcome = markUnknown(a, p);
        offerCreate(a, p);
        return { ...outcome, item: detailOf(a.itemId) };
      }
      return markUnknown(a, p);
    }
    const now = deps.now();
    auditedSuccess(a.id, () => {
      commitUpdateDone(
        repos,
        a,
        p,
        rb.value,
        {
          autoWriteId: auto?.autoWriteId ?? null,
          extraReverts: undoExtras.get(a.id)?.extraReverts ?? [],
          auditKind: 'action_done',
        },
        now,
      );
    });
    undoExtras.delete(a.id);
    return { outcome: 'done', item: detailOf(a.itemId) };
  };

  /** Rebuilds the wire arguments from the APPROVED payload. Pure: any throw here happens before the write-ahead. */
  const prepareArgs = (
    a: ApprovalAction,
    payload: SendReplyPayload | CreateEventPayload,
    confirmDuplicate: boolean,
  ):
    | { kind: 'send_reply'; payload: SendReplyPayload; args: BridgeSendRequest }
    | { kind: 'create_event'; payload: CreateEventPayload; args: CreateEventArgs } => {
    if (payload.kind === 'send_reply') {
      // I3 / A12: the recipient is re-read from `actions.chat_id` - never model- or renderer-supplied.
      const chat = repos.chats.byId(a.chatId);
      return { kind: 'send_reply', payload, args: buildSendArgs(chat?.jid ?? '', payload.text) };
    }
    return {
      kind: 'create_event',
      payload,
      args: buildCreateEventArgs(payload, chainRootOf(a, repos), deps.settings(), {
        allowDuplicates: confirmDuplicate,
        descriptionTemplate: descriptionTemplate(),
      }),
    };
  };

  const runPrepared = (
    a: ApprovalAction,
    prepared: ReturnType<typeof prepareArgs>,
    auto: AutoRun,
  ): Promise<ApproveOutcome> =>
    prepared.kind === 'send_reply'
      ? runSend(a, prepared.payload, prepared.args)
      : runCreate(a, prepared.payload, prepared.args, auto);

  // -------------------------------------------------------------------------------------------------------------------
  // [V2] update_event approve (ARCH-v2 7 / C2 14 steps 2-10; every READ pre-check before the write-ahead, action stays pending)
  // -------------------------------------------------------------------------------------------------------------------
  type Ownership = 'ok' | 'foreign';
  /** The acting item of an update is either the target itself (undo / cancel / B24) or a change card linked to it (B20). */
  const linkedTo = (p: UpdateEventPayload): boolean =>
    p.itemId === p.targetItemId || repos.items.byId(p.itemId)?.linkedItemId === p.targetItemId;
  /** I9 / F27: the event is ours - tagged, the chain root's origin item of THIS chat, our own copy, no attendees / recurrence. */
  const ownershipOf = (pf: OwnedEventProjection, p: UpdateEventPayload, target: Item, chatId: number): Ownership => {
    const originId = target.eventOriginItemId;
    const origin = originId === null ? null : repos.items.byId(originId);
    if (pf.id !== p.targetEventId) return 'foreign';
    if (pf.priv.waAgent !== '1') return 'foreign';
    if (originId === null || origin === null || pf.priv.waItem !== String(originId)) return 'foreign';
    if (pf.priv.waAction === null || pf.priv.waAction === '') return 'foreign'; // the create's chain tag is part of our identity
    if (origin.chatId !== chatId || target.chatId !== chatId) return 'foreign';
    if (!pf.creatorSelf && !pf.organizerSelf) return 'foreign';
    if (pf.hasAttendees || pf.hasRecurrence) return 'foreign';
    // a change card acts for its LINKED source only (B20: linked_item_id is app-computed); undo / cancel act on the holder itself
    if (!linkedTo(p)) return 'foreign';
    return 'ok';
  };

  /** Write-ahead for a pre-flight refusal that must END the action failed (GONE / FOREIGN): no side effect happens. */
  const writeAheadThenFail = (
    a: ApprovalAction,
    finalJson: string,
    by: Approver,
    code: 'CAL_EVENT_GONE' | 'CAL_EVENT_FOREIGN',
    p: UpdateEventPayload,
  ): Result<ApproveOutcome> => {
    const at = deps.now();
    if (repos.actions.markApprovedExecuting(a.id, finalJson, at, by) === 'stale') return fail('ACTION_STALE');
    repos.audit.append('action_approved', a.id, { kind: a.kind, itemId: a.itemId, attempt: a.attempt, by }, at);
    const executing = repos.actions.byId(a.id)!;
    if (code === 'CAL_EVENT_GONE') offerAddAsNew(executing, p);
    else markFailureNoClone(executing, code);
    deps.notifyChanged([a.itemId]);
    return { ok: true, value: { outcome: 'failed', item: detailOf(a.itemId) } };
  };

  const approveUpdate = async (
    a: ApprovalAction,
    stored: UpdateEventPayload,
    req: ApproveReq,
    by: Approver,
  ): Promise<Result<ApproveOutcome>> => {
    const now = deps.now();
    const edited = applyEdit(stored, req.edit);
    if (!edited.ok) return fail(edited.code);
    let p = edited.payload as UpdateEventPayload;
    // (payload itemId / chatRef == the row: enforced by repos.actions.insertPending - RepoContractError otherwise)
    if (!updateSurfaceAvailable()) return fail('CAL_UPDATE_UNAVAILABLE');
    if (!deps.calendarConnected()) return fail('CAL_UNAVAILABLE');
    if (p.to.status !== 'cancelled') {
      const bad = eventSanity(p.to, now);
      if (bad !== null) return fail(bad);
    }
    if (equalContent(p.to, p.from)) return fail('ACTION_STALE');
    const target = repos.items.byId(p.targetItemId);
    if (target === null || target.eventRevision !== p.baseRevision || target.calendarEventId !== p.targetEventId) {
      return fail('ACTION_STALE');
    }

    // ---- pre-flight get-event (read class; app-side only) ----
    const pre = await getEvent(p.targetEventId);
    if (!pre.ok) {
      if (pre.error === 'not_found') return writeAheadThenFail(a, canonicalJson(p), by, 'CAL_EVENT_GONE', p);
      if (pre.error === 'invalid_args') return fail('CAL_UPDATE_UNAVAILABLE');
      return fail(pre.error === 'auth' ? 'CAL_RECONNECT' : 'CAL_UNAVAILABLE');
    }
    const pf = pre.value;
    // The pre-flight itself can switch the surface off (F12: an unpatched bundle refuses `etag`) - re-read it (W1-02 notes (b)).
    if (!updateSurfaceAvailable() || pf.etag === null) return fail('CAL_UPDATE_UNAVAILABLE');
    if (pf.status === 'cancelled' && p.change !== 'undo')
      return writeAheadThenFail(a, canonicalJson(p), by, 'CAL_EVENT_GONE', p);
    if (ownershipOf(pf, p, target, a.chatId) === 'foreign') {
      return writeAheadThenFail(a, canonicalJson(p), by, 'CAL_EVENT_FOREIGN', p);
    }
    if (!sameContent(pf, p.from)) {
      if (req.confirmDrift !== true || !driftShown.has(a.id)) {
        driftShown.add(a.id);
        return {
          ok: true,
          value: { outcome: 'needs_confirm_drift', current: viewOf(contentOfProjection(pf)), item: detailOf(a.itemId) },
        };
      }
      // "Apply anyway" (build plan decision 4, T2 concern 7, literal I8): the pre-state stored BEFORE the write is the pre-flight readback,
      // so the approved `from` becomes Google's current copy and the undo restores exactly that.
      // contentOfProjection() yields cleaned, capped single-line content of the same shape: the re-validation cannot fail
      p = UpdateEventPayloadSchema.parse({ ...p, from: contentOfProjection(pf) });
    }

    // ---- fresh free/busy for the new slot minus the event's own current block ----
    if (p.to.status !== 'cancelled') {
      const busy = await freshBusy(p.to, { startLocal: pf.startLocal, endLocal: pf.endLocal });
      if (busy.length > 0 && req.confirmConflict !== true) {
        return { ok: true, value: { outcome: 'needs_confirm_conflict', busy, item: detailOf(a.itemId) } };
      }
    }

    // the builder refuses only a foreign identity or a missing etag - both were refused above
    const args = buildUpdateEventArgs(p, chainRootOf(a, repos), { etag: pf.etag, priv: pf.priv }, deps.settings(), {
      descriptionTemplate: descriptionTemplate(),
    });
    const limit = rate.checkCreate(); // create_global counts creates + updates + undos (C2 1.2)
    if (!limit.ok) return fail(limit.code);

    const writeAheadAt = deps.now();
    if (repos.actions.markApprovedExecuting(a.id, canonicalJson(p), writeAheadAt, by) === 'stale')
      return fail('ACTION_STALE');
    driftShown.delete(a.id);
    repos.audit.append(
      'action_approved',
      a.id,
      { kind: a.kind, itemId: a.itemId, attempt: a.attempt, by },
      writeAheadAt,
    );
    rate.recordCreate();
    const executing = repos.actions.byId(a.id)!;
    const outcome = await runUpdate(executing, p, args, null);
    deps.notifyChanged([a.itemId]);
    return { ok: true, value: outcome };
  };

  // -------------------------------------------------------------------------------------------------------------------
  // approve
  // -------------------------------------------------------------------------------------------------------------------
  const approveAs = async (req: ApproveReq, ctx: IpcContext | null, by: Approver): Promise<Result<ApproveOutcome>> => {
    // [R2] SYNCHRONOUS, before the first await.
    if (inFlight.has(req.actionId)) return fail('ACTION_STALE');
    inFlight.add(req.actionId);
    try {
      const now = deps.now();
      // [R2] Focus-steal guard: an approve arriving right after a notification click showed the window.
      if (
        ctx !== null &&
        ctx.shownByNotificationAt !== null &&
        ctx.shownByNotificationAt + LIMITS.focusGuardMainMs > now
      ) {
        return fail('WINDOW_NOT_FOCUSED');
      }

      const a = repos.actions.byId(req.actionId);
      if (a === null || a.kind !== req.kind) return fail('ACTION_STALE');
      if (a.state === 'expired') return fail('ACTION_EXPIRED');
      if (a.state !== 'pending') return fail('ACTION_STALE');
      if (now >= a.expiresAt) {
        repos.actions.expireOverdue(now);
        deps.notifyChanged([a.itemId]);
        return fail('ACTION_EXPIRED');
      }
      if (!verifyShownHash(a.canonicalJson, req.shownHash)) return fail('ACTION_STALE');

      const stored = ActionPayloadSchema.safeParse(JSON.parse(a.canonicalJson) as unknown);
      if (!stored.success || stored.data.kind !== a.kind) return fail('ACTION_STALE');

      // [V2] update_event: ARCH-v2 7 gate order ('user_toast' is refused by the trigger for anything but an undo, F4).
      if (stored.data.kind === 'update_event') return await approveUpdate(a, stored.data, req, by);

      const edited = applyEdit(stored.data, req.edit);
      if (!edited.ok) return fail(edited.code);
      const payload = edited.payload as SendReplyPayload | CreateEventPayload;

      if (payload.kind === 'send_reply') {
        // [repair] The conversation was already answered by hand from the phone (ingest.handleOutbound). Ingest supersedes the pending
        // send_reply, so this is only reachable through a racing/stale approve - refuse it rather than deliver a duplicate reply.
        const owner = repos.items.byId(a.itemId);
        if (owner !== null && owner.replyState === 'answered_elsewhere') return fail('ACTION_STALE');
        const chat = repos.chats.byId(a.chatId);
        if (chat === null || !chat.sendable) return fail('SEND_NOT_SENDABLE');
        // Approvals never queue for later delivery (ARCH 6.6 step 6).
        if (!deps.bridgeOnline()) return fail('SEND_NOT_CONNECTED');
      } else {
        if (!deps.calendarConnected()) return fail('CAL_UNAVAILABLE');
        const bad = eventSanity(payload, now);
        if (bad !== null) return fail(bad);
        const busy = await freshBusy(payload);
        if (busy.length > 0 && req.confirmConflict !== true) {
          // The action STAYS pending: one more explicit click with confirmConflict:true executes it.
          return { ok: true, value: { outcome: 'needs_confirm_conflict', busy, item: detailOf(a.itemId) } };
        }
      }

      let prepared: ReturnType<typeof prepareArgs>;
      try {
        prepared = prepareArgs(a, payload, req.confirmDuplicate === true);
      } catch {
        return fail(payload.kind === 'send_reply' ? 'SEND_NOT_SENDABLE' : 'EVENT_INVALID');
      }

      const limit = payload.kind === 'send_reply' ? rate.checkSend(a.chatId) : rate.checkCreate();
      if (!limit.ok) return fail(limit.code);

      // ---- write-ahead: pending -> approved -> executing, committed BEFORE the side effect ----
      const approvedFinalJson = canonicalJson(payload);
      const writeAheadAt = deps.now();
      if (repos.actions.markApprovedExecuting(a.id, approvedFinalJson, writeAheadAt, by) === 'stale') {
        // [R2] A concurrent winner (or a trigger abort): ACTION_STALE and NOTHING else - no failed, no clone, no audit.
        return fail('ACTION_STALE');
      }
      repos.audit.append('action_approved', a.id, { kind: a.kind, itemId: a.itemId, attempt: a.attempt }, writeAheadAt);
      if (payload.kind === 'send_reply') rate.recordSend(a.chatId);
      else rate.recordCreate();

      const executing = repos.actions.byId(a.id)!;
      const outcome = await runPrepared(executing, prepared, null);
      deps.notifyChanged([a.itemId]);
      return { ok: true, value: outcome };
    } finally {
      inFlight.delete(req.actionId);
    }
  };

  // -------------------------------------------------------------------------------------------------------------------
  // [V2] tryAuto - ARCH-v2 6.3 / P2 10.6 / C2 14 (no LLM, no model output re-read; AutoGate over persisted facts + fresh reads)
  // -------------------------------------------------------------------------------------------------------------------
  const NONE: AutoDecisionOutcome = { verdict: 'none', reason: 'no_policy' };

  const lastRecordedWriteOf = (eventId: string, source: Item | null): AutoGateInput['lastRecordedWrite'] => {
    const newest = repos.eventRevisions.newestFor(eventId);
    const etag = newest?.postEtag ?? null;
    const updated = newest?.postUpdated ?? source?.calendarUpdated ?? null;
    if (newest === null && updated === null) return null;
    return { etag, updated };
  };

  const recordDecision = (
    a: ApprovalAction,
    policy: AutoPolicyRecord,
    kind: AutoWriteKind,
    result: AutoGateResult,
    now: EpochMs,
  ): AutoDecisionOutcome => {
    const decisionId = randomUuid();
    let policyChanged = false;
    repos.db.transaction(() => {
      repos.autoDecisions.insert({
        id: decisionId,
        policyId: policy.id,
        actionId: a.id,
        itemId: a.itemId,
        chatId: a.chatId,
        kind,
        verdict: result.verdict,
        reason: result.reason,
        checks: result.checks,
        decidedAt: now,
      });
      repos.audit.append(
        'auto_decision',
        a.id,
        { decisionId, verdict: result.verdict, reason: result.reason, kind },
        now,
      );
      if (result.reason === 'policy_expired') {
        repos.autoPolicies.setState(policy.id, { state: 'expired' });
        repos.audit.append('auto_policy_expired', policy.id, {}, now);
        policyChanged = true;
      } else if (result.pausePolicy !== null) {
        policyChanged = pausePolicy(policy, result.pausePolicy, now);
      }
    });
    if (policyChanged) notifyAuto({ kind: 'policy' });
    return { verdict: result.verdict, reason: result.reason, decisionId, autoWriteId: null, result: null };
  };

  const tryAuto = async (actionId: string): Promise<AutoDecisionOutcome> => {
    if (inFlight.has(actionId)) return NONE;
    inFlight.add(actionId);
    try {
      const now = deps.now();
      const a = repos.actions.byId(actionId);
      // Never for send_reply (I3'), never for a retry clone, never for anything that is not a fresh pending proposal action.
      if (a === null || a.kind === 'send_reply' || a.state !== 'pending' || now >= a.expiresAt || a.retryOf !== null)
        return NONE;
      // a pending row always carries the validated content of its own (calendar) kind - insertPending wrote both
      const payload = ActionPayloadSchema.parse(JSON.parse(a.canonicalJson) as unknown) as
        CreateEventPayload | UpdateEventPayload;
      // An undo is always a click or the toast (C2 14): never evaluated.
      if (payload.kind === 'update_event' && payload.change === 'undo') return NONE;
      const policy = repos.autoPolicies.live();
      if (policy === null) return NONE;
      const item = repos.items.byId(a.itemId);
      const chat = repos.chats.byId(a.chatId);
      const proposal = repos.proposals.current(a.itemId);
      if (item === null || chat === null || proposal === null || proposal.id !== a.proposalId) return NONE;

      const settings = deps.settings();
      const kind: AutoWriteKind =
        payload.kind === 'create_event' ? 'create' : payload.change === 'cancel' ? 'cancel' : 'update';
      // The source must be the one the change card is LINKED to, and its chain root (the origin item = the Google waItem tag, F27)
      // must belong to THIS chat; otherwise AutoGate sees no source => 'wrong_item'.
      const linkedSource =
        payload.kind === 'update_event' && linkedTo(payload) ? repos.items.byId(payload.targetItemId) : null;
      const originOf =
        linkedSource?.eventOriginItemId == null ? null : repos.items.byId(linkedSource.eventOriginItemId);
      const sourceItem =
        linkedSource !== null && originOf !== null && originOf.chatId === a.chatId ? linkedSource : null;
      const gates = proposal.provider === 'user' ? null : featureGates(proposal.provider as ProviderId);
      const chatKey = String(chat.id);
      const input: AutoGateInput = {
        policy,
        snapshotSha: snapshotSha(),
        calendarConnected: deps.calendarConnected(),
        updateSurfaceAvailable: updateSurfaceAvailable(),
        targetAccessRole: calendarRoles()[settings.calendar.targetCalendarId] ?? 'unknown',
        approvedCreates: repos.actions.countUserApprovedCreates(),
        editsGatePassed: gates?.editsPassed === true,
        action: a,
        payload,
        item,
        chat,
        proposal,
        sourceItem,
        preflight: null,
        lastRecordedWrite:
          payload.kind === 'update_event' ? lastRecordedWriteOf(payload.targetEventId, sourceItem) : null,
        editableEventsInChat: repos.items.countEditableEvents(chat.id, (now - LIMITS.eventEditGraceMs) as EpochMs),
        triggerAuthor: proposal.triggerAuthor,
        autoEditsOfEvent:
          payload.kind === 'update_event' ? repos.autoWrites.countEditsOfEvent(payload.targetEventId) : 0,
        freshBusy: null,
        budget: {
          chatLast30Min: repos.rate.countSince('auto_chat', chatKey, (now - LIMITS.autoChatMinGapMs) as EpochMs),
          chatLastHour: repos.rate.countSince('auto_chat', chatKey, (now - HOUR_MS) as EpochMs),
          chatToday: repos.rate.countSince('auto_chat', chatKey, (now - DAY_MS) as EpochMs),
          globalLastHour: repos.rate.countSince('auto_global', 'global', (now - HOUR_MS) as EpochMs),
          globalToday: repos.rate.countSince('auto_global', 'global', (now - DAY_MS) as EpochMs),
        },
        now,
        timeZone: settings.general.timeZone,
        mediaGates: { voicePassed: gates?.voicePassed === true, imagesPassed: gates?.imagesPassed === true },
      };

      // Phase A (P2 10.3): no Google read for a proposal that fails a pure check (a paused / expired policy never reads the calendar).
      const phaseA = evaluateAutoGatePhaseA(input);
      if (phaseA !== null) return recordDecision(a, policy, kind, phaseA, now);

      // Phase B reads: the pre-flight get-event (update) - its snapshot becomes pre_json - and the fresh free/busy.
      let preflight: (OwnedEventProjection & { etag: string }) | null = null;
      if (payload.kind === 'update_event') {
        const pre = await getEvent(payload.targetEventId);
        const etag = pre.ok ? pre.value.etag : null;
        preflight = pre.ok && etag !== null && updateSurfaceAvailable() ? { ...pre.value, etag } : null;
      }
      let busy: BusyBlock[] | null;
      if (payload.kind === 'create_event') {
        const raw = await readBusy(payload);
        busy = raw === null ? null : overlapping(raw, payload);
      } else if (payload.to.status === 'cancelled') {
        busy = [];
      } else {
        const raw = await readBusy(payload.to);
        const own = preflight ?? payload.from;
        busy =
          raw === null
            ? null
            : busyOverlapping(raw, payload.to, { startLocal: own.startLocal, endLocal: own.endLocal });
      }
      const full = autoGate({
        ...input,
        preflight,
        freshBusy: busy,
        now: deps.now(),
        updateSurfaceAvailable: updateSurfaceAvailable(),
      });
      if (full.verdict !== 'auto') return recordDecision(a, policy, kind, full, deps.now());

      // ---- verdict auto: same whitelist builders as the click path, the general rate limit, then ONE transaction ----
      let prepared:
        | { kind: 'create_event'; payload: CreateEventPayload; args: CreateEventArgs }
        | { kind: 'update_event'; payload: UpdateEventPayload; args: UpdateEventArgs };
      if (payload.kind === 'create_event') {
        // The cage of B9 (lead >= 15 min, 5..240 min, horizon <= 30 d) is strictly narrower than eventSanity(): no second check.
        prepared = {
          kind: 'create_event',
          payload,
          args: buildCreateEventArgs(payload, chainRootOf(a, repos), settings, {
            allowDuplicates: false, // never allowDuplicates:true automatically (B9)
            descriptionTemplate: descriptionTemplate(),
          }),
        };
      } else {
        // A gate (e.g. an injected one) that answered `auto` without a usable pre-flight never writes: no pre_json, no If-Match (I8).
        if (preflight === null) {
          return recordDecision(
            a,
            policy,
            kind,
            { verdict: 'fallback', reason: 'unknown_prev_state', checks: full.checks, pausePolicy: null },
            now,
          );
        }
        prepared = {
          kind: 'update_event',
          payload,
          args: buildUpdateEventArgs(
            payload,
            chainRootOf(a, repos),
            { etag: preflight.etag, priv: preflight.priv },
            settings,
            {
              descriptionTemplate: descriptionTemplate(),
            },
          ),
        };
      }
      if (!rate.checkCreate().ok) {
        return recordDecision(
          a,
          policy,
          kind,
          { verdict: 'fallback', reason: 'auto_budget', checks: full.checks, pausePolicy: 'circuit_breaker_rate' },
          now,
        );
      }

      const writtenAt = deps.now();
      const decisionId = randomUuid();
      const autoWriteId = randomUuid();
      const restoreStart = payload.kind === 'create_event' ? startOf(payload) : startOf(preflight!);
      const undoUntil = Math.min(writtenAt + LIMITS.autoUndoWindowMs, restoreStart) as EpochMs;
      const eventId = prepared.kind === 'create_event' ? prepared.args.eventId : prepared.payload.targetEventId;
      class Stale extends Error {}
      try {
        repos.db.transaction(() => {
          repos.autoDecisions.insert({
            id: decisionId,
            policyId: policy.id,
            actionId: a.id,
            itemId: a.itemId,
            chatId: a.chatId,
            kind,
            verdict: 'auto',
            reason: 'ok',
            checks: full.checks,
            decidedAt: writtenAt,
          });
          // F4: the automatic path passes canonical_json VERBATIM as the final JSON; the trigger verifies the JOIN to a live `on` decision.
          if (repos.actions.markApprovedExecuting(a.id, a.canonicalJson, writtenAt, decisionId) === 'stale')
            throw new Stale();
          repos.autoWrites.insert({
            id: autoWriteId,
            decisionId,
            actionId: a.id,
            itemId: a.itemId,
            eventId,
            kind,
            pre: preflight === null ? null : snapshotOfProjection(preflight),
            undoUntil,
            writtenAt,
          });
          repos.audit.append(
            'action_approved',
            a.id,
            { kind: a.kind, itemId: a.itemId, attempt: a.attempt, by: 'auto', decisionId },
            writtenAt,
          );
          repos.audit.append('auto_decision', a.id, { decisionId, verdict: 'auto', reason: 'ok', kind }, writtenAt);
          repos.audit.append('auto_write', autoWriteId, { decisionId, actionId: a.id, kind }, writtenAt);
          rate.recordCreate();
          repos.rate.record('auto_chat', chatKey, writtenAt);
          repos.rate.record('auto_global', 'global', writtenAt);
        });
      } catch (e) {
        if (e instanceof Stale) return NONE; // a concurrent click won the CAS: nothing was recorded (rolled back)
        throw e;
      }

      const executing = repos.actions.byId(a.id)!;
      const auto = { autoWriteId };
      if (prepared.kind === 'create_event') await runCreate(executing, prepared.payload, prepared.args, auto);
      else await runUpdate(executing, prepared.payload, prepared.args, auto);
      const endState = repos.actions.byId(a.id)?.state;
      const result: 'done' | 'failed' | 'unknown_outcome' =
        endState === 'done' ? 'done' : endState === 'unknown_outcome' ? 'unknown_outcome' : 'failed';
      if (result !== 'done') repos.autoWrites.setUndo(autoWriteId, { undoState: 'failed' });
      // An unknown outcome pauses the policy (B7); a failed automatic write is an ordinary card (its retry clone is a click).
      if (result === 'unknown_outcome') pauseLivePolicy('circuit_breaker_unknown');
      if (result === 'done') notifyAuto({ kind: 'write', autoWriteId });
      deps.notifyChanged([a.itemId]);
      return { verdict: 'auto', reason: 'ok', decisionId, autoWriteId, result };
    } finally {
      inFlight.delete(actionId);
    }
  };

  // -------------------------------------------------------------------------------------------------------------------
  // [V2] undo (B10, F1, F2, F10, F32) - every path ends in approveAs(), i.e. the SAME gates as a click on a card
  // -------------------------------------------------------------------------------------------------------------------

  /** Automatic undos of the last 24 h, counting one per UNDO ACTION (restoreOriginal reverts several writes with one action = one undo). */
  const undoActionsSince = (since: EpochMs): number =>
    repos.db
      .prepare<{ n: number }>(
        `SELECT COUNT(DISTINCT w.undo_action_id) AS n FROM auto_writes w JOIN actions u ON u.id = w.undo_action_id
          WHERE w.undo_state = 'undone' AND COALESCE(u.executed_at, u.approved_at, u.created_at) >= ?`,
      )
      .get(since)!.n;

  /** Inserts a new proposal version (provider 'user') on the item holding the event + the pending update_event, carrying a pending draft
   *  over to the new version (C2 concern 19); taints the chat for the undo of an automatic write (F10) - one transaction. */
  const insertChange = (
    item: Item,
    payloadOf: (version: number) => UpdateEventPayload,
    taint: boolean,
  ): ApprovalAction => {
    const now = deps.now();
    return repos.db.transaction(() => {
      // an in-calendar card always has a proposal (its create_event action references it)
      const current = repos.proposals.current(item.id)!;
      const pendingDraft = repos.actions
        .forItem(item.id)
        .find((x) => x.kind === 'send_reply' && x.state === 'pending' && x.proposalId === current.id);
      repos.actions.supersedePending(item.id, now);
      const proposal = repos.proposals.insertNext({
        itemId: item.id,
        provider: 'user',
        model: 'user',
        extraction: current.extraction,
        draftText: current.draftText,
        replyLang: current.replyLang,
        event: current.event,
        freeBusy: current.freeBusy,
        suspicious: current.suspicious,
        createdAt: now,
      });
      const action = repos.actions.insertPending({
        itemId: item.id,
        proposalId: proposal.id,
        chatId: item.chatId,
        payload: payloadOf(proposal.version),
        now,
      });
      if (pendingDraft !== undefined) {
        // the same unsent text, re-approvable on the new version (C2 concern 19); insertPending re-validates it
        const draft = JSON.parse(pendingDraft.canonicalJson) as SendReplyPayload;
        repos.actions.insertPending({
          itemId: item.id,
          proposalId: proposal.id,
          chatId: item.chatId,
          payload: { ...draft, proposalVersion: proposal.version },
          now,
        });
      }
      repos.items.update(item.id, { currentProposalId: proposal.id }, now);
      if (taint) repos.chats.taint(item.chatId, (now + LIMITS.autoTaintMs) as EpochMs);
      return action;
    });
  };

  interface UndoPlan {
    item: Item;
    revertOf: EventRevisionRecord;
    /** content to restore; null = cancel the event (undo of a create) */
    restoreTo: EventContentWithStatus | null;
    restoreStart: EpochMs;
    writes: AutoWriteRecord[];
    extraReverts: number[];
    by: Approver;
    ctx: IpcContext | null;
  }

  const runUndo = async (plan: UndoPlan): Promise<Result<ApproveOutcome>> => {
    const { item, revertOf } = plan;
    const eventId = item.calendarEventId!;
    const key = `undo:${eventId}`;
    if (inFlight.has(key)) return fail('ACTION_STALE');
    inFlight.add(key);
    try {
      const now = deps.now();
      const newest = repos.eventRevisions.newestFor(eventId)!; // the candidate is a revision of this event
      const current = newest.next;
      if (current === null) return fail('ACTION_STALE'); // its JSON was nulled by retention: nothing to restore from
      const automatic = plan.writes.length > 0;
      if (automatic) {
        const setAll = (s: 'blocked_started' | 'expired' | 'blocked_changed'): void =>
          repos.db.transaction(() => {
            for (const w of plan.writes) repos.autoWrites.setUndo(w.id, { undoState: s });
          });
        if (now >= plan.restoreStart) {
          setAll('blocked_started');
          deps.notifyChanged([item.id]);
          return fail('ACTION_STALE');
        }
        if (now >= Math.min(...plan.writes.map((w) => w.undoUntil))) {
          setAll('expired');
          deps.notifyChanged([item.id]);
          return fail('ACTION_EXPIRED');
        }
        // F1: the baseline is the NEWEST revision's post_* (the app's last write, undo writes included); zero calls on a mismatch.
        const pre = await getEvent(eventId);
        if (!pre.ok && pre.error !== 'not_found')
          return fail(pre.error === 'auth' ? 'CAL_RECONNECT' : 'CAL_UNAVAILABLE');
        if (pre.ok) {
          const pf = pre.value;
          const noBaseline = newest.postEtag === null && newest.postUpdated === null;
          const moved =
            (newest.postEtag !== null && pf.etag !== newest.postEtag) ||
            (newest.postUpdated !== null && pf.updated !== newest.postUpdated);
          if (noBaseline || moved) {
            setAll('blocked_changed');
            deps.notifyChanged([item.id]);
            return fail('ACTION_STALE');
          }
        }
      } else {
        const until = Math.min(revertOf.appliedAt + LIMITS.manualUndoWindowMs, plan.restoreStart);
        if (now >= until) return fail('ACTION_EXPIRED');
      }
      // Idempotent: an undo of this revision that already got past the write-ahead answers ACTION_STALE.
      const already = repos.db
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM actions WHERE kind = 'update_event' AND state IN ('approved','executing','done','unknown_outcome')
             AND json_valid(canonical_json) AND json_extract(canonical_json, '$.revertOf') = ?`,
        )
        .get(revertOf.id)!.n;
      if (already > 0) return fail('ACTION_STALE');

      const to: EventContentWithStatus = plan.restoreTo ?? { ...current, status: 'cancelled' };
      const action = insertChange(
        item,
        (version) => ({
          v: 1,
          kind: 'update_event',
          itemId: item.id,
          chatRef: item.chatId,
          proposalVersion: version,
          targetEventId: eventId,
          targetItemId: item.id,
          baseRevision: item.eventRevision,
          change: 'undo',
          from: current,
          to,
          revertOf: revertOf.id,
        }),
        automatic,
      );
      if (plan.extraReverts.length > 0) undoExtras.set(action.id, { extraReverts: plan.extraReverts });
      const res = await approveAs(
        { actionId: action.id, kind: 'update_event', shownHash: action.contentSha256 },
        plan.ctx,
        plan.by,
      );
      if (automatic) {
        if (res.ok && res.value.outcome === 'done') {
          if (undoActionsSince((deps.now() - DAY_MS) as EpochMs) >= LIMITS.autoUndoPauseCount)
            pauseLivePolicy('circuit_breaker_undo');
        }
        notifyAuto({ kind: 'undo', autoWriteId: plan.writes[plan.writes.length - 1]!.id });
      }
      deps.notifyChanged([item.id]);
      return res;
    } finally {
      inFlight.delete(key);
    }
  };

  /**
   * The item that CURRENTLY holds an event (F27 chain): every applied change moves the event to its acting item, so after a chain of
   * changes older items (closed 'superseded') still carry the id with a stale event_revision. The holder is the one with the highest
   * event_revision; the revision compare-and-set of the undo / cancel payload is taken from it.
   */
  const holderOf = (door: Item & { calendarEventId: string }): Item =>
    repos.items
      .byCalendarEventId(door.calendarEventId)
      .reduce((best, x) => (x.eventRevision > best.eventRevision ? x : best), door);

  /** The restore-target start of a revision: prev start for a change, the created event's own start for a create (F2). */
  const restoreStartOf = (r: EventRevisionRecord): EpochMs | null => {
    const target = r.prev ?? r.next;
    return target === null ? null : startOf(target);
  };

  const undoChange = async (
    itemId: ItemId,
    revisionId: number,
    by: Approver,
    ctx: IpcContext | null,
  ): Promise<Result<ApproveOutcome>> => {
    const door = repos.items.byId(itemId);
    if (door === null) return fail('NOT_FOUND');
    if (door.calendarEventId === null) return fail('ACTION_STALE');
    const cand = repos.eventRevisions.undoCandidate(door.calendarEventId);
    if (cand === null || cand.id !== revisionId) return fail('ACTION_STALE');
    // Any card of the event may be the door (the chain moves the event forward); the undo acts on the CURRENT holder.
    const item = holderOf({ ...door, calendarEventId: door.calendarEventId });
    const restoreStart = restoreStartOf(cand);
    if (restoreStart === null) return fail('ACTION_STALE');
    const write = autoWriteOfAction(cand.actionId);
    // 'user_toast' approves the undo of an AUTOMATIC write only (the toast exists only for those).
    if (by === 'user_toast' && write === null) return fail('ACTION_STALE');
    return runUndo({
      item,
      revertOf: cand,
      restoreTo: cand.prev,
      restoreStart,
      writes: write === null ? [] : [write],
      extraReverts: [],
      by,
      ctx,
    });
  };

  const undoAuto = async (
    autoWriteId: string,
    by: Approver,
    ctx: IpcContext | null,
  ): Promise<Result<ApproveOutcome>> => {
    const w = repos.autoWrites.byId(autoWriteId);
    if (w === null) return fail('NOT_FOUND');
    if (w.revisionId === null) return fail('ACTION_STALE');
    const cand = repos.eventRevisions.undoCandidate(w.eventId);
    if (cand === null || cand.id !== w.revisionId) return fail('ACTION_STALE');
    // the write's own item carries the event (FK); the undo itself acts on whichever card holds it now
    const holder = holderOf({ ...repos.items.byId(w.itemId)!, calendarEventId: w.eventId });
    return undoChange(holder.id, cand.id, by, ctx);
  };

  const restoreOriginal = async (itemId: ItemId, ctx: IpcContext): Promise<Result<ApproveOutcome>> => {
    const door = repos.items.byId(itemId);
    if (door === null) return fail('NOT_FOUND');
    if (door.calendarEventId === null) return fail('ACTION_STALE');
    const span = repos.eventRevisions.unrevertedAutoSpan(door.calendarEventId);
    if (span.length === 0) return fail('ACTION_STALE');
    const newestAuto = span[span.length - 1]!;
    const oldest = span[0]!;
    // with a non-empty span its newest row IS the undo candidate: any newer non-undo change would be user-approved and end the span
    const item = holderOf({ ...door, calendarEventId: door.calendarEventId });
    const restoreStart = restoreStartOf(oldest);
    if (restoreStart === null) return fail('ACTION_STALE');
    const writes = span.map((r) => autoWriteOfAction(r.actionId)).filter((w): w is AutoWriteRecord => w !== null);
    return runUndo({
      item,
      revertOf: newestAuto,
      restoreTo: oldest.prev,
      restoreStart,
      writes,
      extraReverts: span.slice(0, -1).map((r) => r.id),
      by: 'user',
      ctx,
    });
  };

  const cancelEvent = async (itemId: ItemId, ctx: IpcContext): Promise<Result<ApproveOutcome>> => {
    const door = repos.items.byId(itemId);
    if (door === null) return fail('NOT_FOUND');
    if (door.calendarEventId === null) return fail('ACTION_STALE');
    const eventId = door.calendarEventId;
    const item = holderOf({ ...door, calendarEventId: eventId });
    // the live event is held by an in-calendar card whose event is not cancelled (F32)
    if (item.eventState !== 'created' && item.eventState !== 'updated') return fail('ACTION_STALE');
    let current = repos.eventRevisions.newestFor(eventId)?.next ?? null;
    if (current === null) {
      // a v1-created event has no revision row (C2 concern 17): the current content comes from a pre-flight read
      const pre = await getEvent(eventId);
      if (!pre.ok) return fail(pre.error === 'not_found' ? 'CAL_EVENT_GONE' : 'CAL_UNAVAILABLE');
      current = contentOfProjection(pre.value);
    }
    if (current.status === 'cancelled') return fail('ACTION_STALE');
    const from = current;
    const action = insertChange(
      item,
      (version) => ({
        v: 1,
        kind: 'update_event',
        itemId: item.id,
        chatRef: item.chatId,
        proposalVersion: version,
        targetEventId: eventId,
        targetItemId: item.id,
        baseRevision: item.eventRevision,
        change: 'cancel',
        from,
        to: { ...from, status: 'cancelled' },
      }),
      false,
    );
    const res = await approveAs(
      { actionId: action.id, kind: 'update_event', shownHash: action.contentSha256 },
      ctx,
      'user',
    );
    deps.notifyChanged([item.id]);
    return res;
  };

  const executor: ActionExecutorHandle = {
    approve: (req, ctx) => approveAs(req, ctx, 'user'),
    tryAuto,
    undoChange,
    undoAuto,
    restoreOriginal,
    cancelEvent,

    async reject(actionId) {
      const a = repos.actions.byId(actionId);
      if (a === null) return fail('ACTION_STALE');
      if (a.state !== 'pending') return fail('ACTION_STALE');
      const now = deps.now();
      // [V2, F32 - V2-W2-01 fix-up] a rejected update_event ("Keep 15:00") sets the delta item's event_state = 'declined' in the SAME
      // transaction (linked_item_id kept); S4's suppression rule (rejectedDeltaTo) then never re-proposes the same `to`.
      repos.db.transaction(() => {
        repos.actions.markRejected(actionId);
        if (a.kind === 'update_event') repos.items.update(a.itemId, { eventState: 'declined' }, now);
      });
      repos.audit.append('action_rejected', actionId, { kind: a.kind, attempt: a.attempt }, now);
      driftShown.delete(actionId);
      deps.notifyChanged([a.itemId]);
      return { ok: true, value: null };
    },

    async recoverOnStartup() {
      const now = deps.now();
      const touched = new Set<ItemId>();
      let autoCrashed = false;
      for (const a of repos.actions.executing()) {
        // NEVER re-executed: the side effect may or may not have happened, so it becomes unknown_outcome and is reconciled read-only.
        repos.actions.markUnknownOutcome(a.id, now);
        repos.audit.append('action_unknown_outcome', a.id, { kind: a.kind, attempt: a.attempt, recovered: true }, now);
        applyFailure(repos, a, 'ACTION_UNKNOWN_OUTCOME', now);
        if (autoWriteOfAction(a.id) !== null) autoCrashed = true;
        touched.add(a.itemId);
      }
      // [V2] an automatic write interrupted by a crash pauses the policy (circuit_breaker_unknown, B7).
      if (autoCrashed) pauseLivePolicy('circuit_breaker_unknown');
      repos.actions.expireOverdue(now);
      // The bridge store is not reachable from here (no bridgeDb in the frozen deps), so this pass resolves calendar actions only;
      // compose.ts runs `reconcileUnknown` again with the bridge DB once the store is open (REQUESTS in the notes file).
      await reconcileUnknown({
        repos,
        bridgeDb: null,
        read: deps.read,
        now: deps.now,
        timeZone: () => deps.settings().general.timeZone,
      });
      if (touched.size > 0) deps.notifyChanged([...touched]);
    },

    offerRetryForUnknown(): number {
      const now = deps.now();
      const stuck = repos.db
        .prepare<{ id: string }>(
          `SELECT a.id FROM actions a
             WHERE a.state = 'unknown_outcome'
               AND NOT EXISTS (SELECT 1 FROM actions r WHERE r.retry_of = a.id)
             ORDER BY a.created_at ASC`,
        )
        .all();
      const touched = new Set<ItemId>();
      let created = 0;
      for (const row of stuck) {
        const a = repos.actions.byId(row.id as ActionId);
        const payload = a === null ? null : parseFinalPayload(a);
        // Retention nulls `approved_final_json` on terminal rows, and a row that old no longer carries what the user
        // approved. Nothing is reconstructed or guessed: the card keeps its ACTION_UNKNOWN_OUTCOME line instead.
        if (a === null || payload === null || payload.kind !== a.kind) continue;
        cloneForRetry(a, payload, now);
        created += 1;
        touched.add(a.itemId);
      }
      if (touched.size > 0) deps.notifyChanged([...touched]);
      return created;
    },

    async drain(ms) {
      const deadline = deps.now() + ms;
      while (inFlight.size > 0 && deps.now() < deadline) {
        await deps.sleep(DRAIN_POLL_MS);
      }
    },

    /** [W1-11 addition] see ActionExecutorInternals. [V2] an update_event re-reads its pre-flight identity (etag, tags) first. */
    async execute(actionId) {
      const a = repos.actions.byId(actionId);
      if (a === null || a.state !== 'executing') throw new ActionNotExecutingError(actionId);
      const payload = parseFinalPayload(a);
      if (payload === null || payload.kind !== a.kind) throw new ActionNotExecutingError(actionId);
      if (payload.kind === 'update_event') {
        const pre = await getEvent(payload.targetEventId);
        if (!pre.ok || pre.value.etag === null) return markFailure(a, payload, 'CAL_UPDATE_UNAVAILABLE');
        let args: UpdateEventArgs;
        try {
          args = buildUpdateEventArgs(
            payload,
            chainRootOf(a, repos),
            { etag: pre.value.etag, priv: pre.value.priv },
            deps.settings(),
            {
              descriptionTemplate: descriptionTemplate(),
            },
          );
        } catch {
          return markFailure(a, payload, 'CAL_EVENT_FOREIGN');
        }
        return runUpdate(a, payload, args, null);
      }
      return runPrepared(a, prepareArgs(a, payload, false), null);
    },
  };
  return executor;
}
