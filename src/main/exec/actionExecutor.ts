// src/main/exec/actionExecutor.ts   (frozen signatures)
// Frozen signatures pasted verbatim from docs/specs/contracts.md (owner W1-11). THE approval gate: this module is the sole holder
// of the send / write clients (invariant I1) and contains NO LLM import of any kind (ARCH 18 import boundary).
// The gate order of ARCH 6.6 / PIPELINE 9 is implemented literally below and is the thing every safety test asserts.
import { LIMITS } from '../../shared/types';
import {
  ActionPayloadSchema,
  EventEditSchema,
  ReplyEditSchema,
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
import { createRateLimiter } from './rateLimiter';
import { applyCreateSuccess, applyFailure, applySendSuccess, parseFinalPayload } from './outcome';
import { reconcileUnknown } from './reconcile';
import type { Result, ActionId, EpochMs, ItemId, ItemDetail, ApprovalAction, BusyBlock } from '../../shared/types';
import type { ErrorCode } from '../../shared/errors';
import type { ApproveReq, ApproveOutcome, IpcContext } from '../../shared/ipc';
import type { Settings } from '../../shared/settings';
import type { ActionPayload, CreateEventPayload, SendReplyPayload } from '../../shared/schemas';
import type { BridgeSendClient, BridgeSendRequest, BridgeSendResult } from '../bridge/sendClient';
import type { CreateEventArgs, McpWriteClient } from '../mcp/writeClient';
import type { McpErrorKind, McpReadClient, PinnedWindow } from '../mcp/readClient';
import type { Repos } from '../db/index';

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
export class ActionNotExecutingError extends Error {
  constructor(public readonly actionId: ActionId) {
    super('action_not_executing');
    this.name = 'ActionNotExecutingError';
  }
}

const DRAIN_POLL_MS = 25;
/** Months are clamped generously; the exact horizon test lives in agent/validate.ts (S4). */
const MONTH_MS = 31 * 24 * 3_600_000;

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
    calendar: item !== null && item.eventState === 'created' ? { eventStartTs: item.eventStartTs } : null,
    editingLocked: false,
    updatedAt: item?.updatedAt ?? 0,
    messages: [],
  };
}

/** Applies the user's edit (TRUSTED but still schema-validated, length-capped, invisible characters stripped). */
export function applyEdit(
  payload: ActionPayload,
  edit: ApproveReq['edit'],
): { ok: true; payload: ActionPayload } | { ok: false; code: ErrorCode } {
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
export function eventSanity(p: CreateEventPayload, now: EpochMs): ErrorCode | null {
  const start = localToEpochMs(p.startLocal, p.timeZone);
  const end = localToEpochMs(p.endLocal, p.timeZone);
  const minutes = (end - start) / 60_000;
  if (minutes < LIMITS.eventMinMin || minutes > LIMITS.eventMaxMin) return 'EVENT_INVALID';
  if (end <= now) return 'EVENT_INVALID';
  if (start > now + LIMITS.eventHorizonMonths * MONTH_MS) return 'EVENT_INVALID';
  return null;
}

/** Same-format local date-time strings compare chronologically (CONTRACTS 5). */
function overlapping(busy: readonly BusyBlock[], p: CreateEventPayload): BusyBlock[] {
  return busy.filter((b) => b.startLocal < p.endLocal && b.endLocal > p.startLocal);
}

/**
 * [W2-01 integration addition, additive to the frozen `ActionExecutor`] What `createActionExecutor` actually returns.
 * `offerRetryForUnknown()` exists because the retry clone for a CRASH-recovered action cannot be created inside
 * `recoverOnStartup()`: `compose.ts` runs a SECOND `reconcileUnknown()` with the bridge store afterwards (the frozen
 * `ActionExecutorDeps` carries no bridge DB), and an action that second pass resolves to `done` must not get a clone.
 * Every caller written against `ActionExecutor` still compiles.
 */
export type ActionExecutorHandle = ActionExecutor &
  ActionExecutorInternals & {
    /**
     * TESTS section 6 "recovery": after both reconcile passes, every action still `unknown_outcome` gets a fresh
     * PENDING clone so the card can offer "Send again" / "Add again". That is a NEW approval - never a replay - and
     * because the clone keeps the `retry_of` chain, a repeated `create_event` re-uses the chain root's deterministic
     * `eventId`. Idempotent: an action that already has a clone is skipped. Returns how many clones it created.
     */
    offerRetryForUnknown(): number;
  };

export function createActionExecutor(deps: ActionExecutorDeps): ActionExecutorHandle {
  const inFlight = new Set<ActionId>();
  const rate = createRateLimiter({ repos: deps.repos, now: deps.now });

  const detailOf = (itemId: ItemId): ItemDetail => deps.detail?.(itemId) ?? fallbackDetail(deps.repos, itemId);

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
      deps.repos.audit.append('db_recovery', ref, { stage: 'action_transition' }, deps.now());
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
    auditedTransition(ref, () => deps.repos.db.transaction(fn));

  const cloneForRetry = (a: ApprovalAction, payload: ActionPayload, now: EpochMs): void => {
    deps.repos.actions.insertPending({
      itemId: a.itemId,
      proposalId: a.proposalId,
      chatId: a.chatId,
      payload,
      now,
      retryOf: a.id,
    });
  };

  const markFailure = (a: ApprovalAction, payload: ActionPayload, code: ErrorCode): ApproveOutcome => {
    const now = deps.now();
    auditedTransition(a.id, () => deps.repos.actions.markFailed(a.id, code, now));
    deps.repos.audit.append('action_failed', a.id, { kind: a.kind, attempt: a.attempt, code }, now);
    applyFailure(deps.repos, a, code, now);
    cloneForRetry(a, payload, now);
    return { outcome: 'failed', item: detailOf(a.itemId) };
  };

  const markUnknown = (a: ApprovalAction, payload: ActionPayload): ApproveOutcome => {
    const now = deps.now();
    auditedTransition(a.id, () => deps.repos.actions.markUnknownOutcome(a.id, now));
    deps.repos.audit.append('action_unknown_outcome', a.id, { kind: a.kind, attempt: a.attempt }, now);
    applyFailure(deps.repos, a, 'ACTION_UNKNOWN_OUTCOME', now);
    cloneForRetry(a, payload, now);
    return { outcome: 'failed', item: detailOf(a.itemId) };
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
        deps.repos.actions.markDone(a.id, result, now);
        applySendSuccess(deps.repos, a, payload, now);
        deps.repos.audit.append('action_done', a.id, { kind: 'send_reply', attempt: a.attempt }, now);
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
      const now = deps.now();
      const result = { kind: 'create_event' as const, eventId: value.eventId, htmlLink: value.htmlLink };
      auditedSuccess(a.id, () => {
        deps.repos.actions.markDone(a.id, result, now);
        applyCreateSuccess(deps.repos, a, payload, result, now);
        deps.repos.audit.append('action_done', a.id, { kind: 'create_event', attempt: a.attempt }, now);
      });
      return { outcome: 'done', item: detailOf(a.itemId) };
    }
    if (!res.ok && res.error === 'timeout') return markUnknown(a, payload);
    return markFailure(a, payload, MCP_FAILURE_CODE[(res as { error: McpErrorKind }).error]);
  };

  /** Rebuilds the wire arguments from the APPROVED payload. Pure: any throw here happens before the write-ahead. */
  const prepareArgs = (
    a: ApprovalAction,
    payload: ActionPayload,
    confirmDuplicate: boolean,
  ):
    | { kind: 'send_reply'; payload: SendReplyPayload; args: BridgeSendRequest }
    | { kind: 'create_event'; payload: CreateEventPayload; args: CreateEventArgs } => {
    if (payload.kind === 'send_reply') {
      // I3 / A12: the recipient is re-read from `actions.chat_id` - never model- or renderer-supplied.
      const chat = deps.repos.chats.byId(a.chatId);
      return { kind: 'send_reply', payload, args: buildSendArgs(chat?.jid ?? '', payload.text) };
    }
    return {
      kind: 'create_event',
      payload,
      args: buildCreateEventArgs(payload, chainRootOf(a, deps.repos), deps.settings(), {
        allowDuplicates: confirmDuplicate,
        descriptionTemplate: descriptionTemplate(),
      }),
    };
  };

  const runPrepared = (a: ApprovalAction, prepared: ReturnType<typeof prepareArgs>): Promise<ApproveOutcome> =>
    prepared.kind === 'send_reply'
      ? runSend(a, prepared.payload, prepared.args)
      : runCreate(a, prepared.payload, prepared.args);

  /** Fresh app-side free/busy right before the write (ARCH 5.4). A read failure is not a conflict: it must not block an approval. */
  const freshBusy = async (p: CreateEventPayload): Promise<BusyBlock[]> => {
    const window: PinnedWindow = {
      timeMinLocal: p.startLocal,
      timeMaxLocal: p.endLocal,
      timeZone: p.timeZone,
      calendarIds: deps.settings().calendar.conflictCalendarIds,
      account: 'personal',
    };
    try {
      const res = await deps.read.getFreeBusy(window);
      return res.ok ? overlapping(res.value, p) : [];
    } catch {
      return [];
    }
  };

  // -------------------------------------------------------------------------------------------------------------------
  // approve
  // -------------------------------------------------------------------------------------------------------------------
  const approve = async (req: ApproveReq, ctx: IpcContext): Promise<Result<ApproveOutcome>> => {
    // [R2] SYNCHRONOUS, before the first await.
    if (inFlight.has(req.actionId)) return fail('ACTION_STALE');
    inFlight.add(req.actionId);
    try {
      const now = deps.now();
      // [R2] Focus-steal guard: an approve arriving right after a notification click showed the window.
      if (ctx.shownByNotificationAt !== null && ctx.shownByNotificationAt + LIMITS.focusGuardMainMs > now) {
        return fail('WINDOW_NOT_FOCUSED');
      }

      const a = deps.repos.actions.byId(req.actionId);
      if (a === null || a.kind !== req.kind) return fail('ACTION_STALE');
      if (a.state === 'expired') return fail('ACTION_EXPIRED');
      if (a.state !== 'pending') return fail('ACTION_STALE');
      if (now >= a.expiresAt) {
        deps.repos.actions.expireOverdue(now);
        deps.notifyChanged([a.itemId]);
        return fail('ACTION_EXPIRED');
      }
      if (!verifyShownHash(a.canonicalJson, req.shownHash)) return fail('ACTION_STALE');

      const stored = ActionPayloadSchema.safeParse(JSON.parse(a.canonicalJson) as unknown);
      if (!stored.success || stored.data.kind !== a.kind) return fail('ACTION_STALE');

      const edited = applyEdit(stored.data, req.edit);
      if (!edited.ok) return fail(edited.code);
      const payload = edited.payload;

      if (payload.kind === 'send_reply') {
        // [repair] The conversation was already answered by hand from the phone (ingest.handleOutbound). Ingest supersedes the pending
        // send_reply, so this is only reachable through a racing/stale approve - refuse it rather than deliver a duplicate reply.
        const owner = deps.repos.items.byId(a.itemId);
        if (owner !== null && owner.replyState === 'answered_elsewhere') return fail('ACTION_STALE');
        const chat = deps.repos.chats.byId(a.chatId);
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
      if (deps.repos.actions.markApprovedExecuting(a.id, approvedFinalJson, writeAheadAt) === 'stale') {
        // [R2] A concurrent winner (or a trigger abort): ACTION_STALE and NOTHING else - no failed, no clone, no audit.
        return fail('ACTION_STALE');
      }
      deps.repos.audit.append(
        'action_approved',
        a.id,
        { kind: a.kind, itemId: a.itemId, attempt: a.attempt },
        writeAheadAt,
      );
      if (payload.kind === 'send_reply') rate.recordSend(a.chatId);
      else rate.recordCreate();

      const executing = deps.repos.actions.byId(a.id) ?? a;
      const outcome = await runPrepared(executing, prepared);
      deps.notifyChanged([a.itemId]);
      return { ok: true, value: outcome };
    } finally {
      inFlight.delete(req.actionId);
    }
  };

  const executor: ActionExecutorHandle = {
    approve,

    async reject(actionId) {
      const a = deps.repos.actions.byId(actionId);
      if (a === null) return fail('ACTION_STALE');
      if (a.state !== 'pending') return fail('ACTION_STALE');
      const now = deps.now();
      deps.repos.actions.markRejected(actionId);
      deps.repos.audit.append('action_rejected', actionId, { kind: a.kind, attempt: a.attempt }, now);
      deps.notifyChanged([a.itemId]);
      return { ok: true, value: null };
    },

    async recoverOnStartup() {
      const now = deps.now();
      const touched = new Set<ItemId>();
      for (const a of deps.repos.actions.executing()) {
        // NEVER re-executed: the side effect may or may not have happened, so it becomes unknown_outcome and is reconciled read-only.
        deps.repos.actions.markUnknownOutcome(a.id, now);
        deps.repos.audit.append(
          'action_unknown_outcome',
          a.id,
          { kind: a.kind, attempt: a.attempt, recovered: true },
          now,
        );
        applyFailure(deps.repos, a, 'ACTION_UNKNOWN_OUTCOME', now);
        touched.add(a.itemId);
      }
      deps.repos.actions.expireOverdue(now);
      // The bridge store is not reachable from here (no bridgeDb in the frozen deps), so this pass resolves calendar actions only;
      // compose.ts runs `reconcileUnknown` again with the bridge DB once the store is open (REQUESTS in the notes file).
      await reconcileUnknown({
        repos: deps.repos,
        bridgeDb: null,
        read: deps.read,
        now: deps.now,
        timeZone: () => deps.settings().general.timeZone,
      });
      if (touched.size > 0) deps.notifyChanged([...touched]);
    },

    offerRetryForUnknown(): number {
      const now = deps.now();
      const stuck = deps.repos.db
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
        const a = deps.repos.actions.byId(row.id as ActionId);
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

    /** [W1-11 addition] see ActionExecutorInternals. */
    async execute(actionId) {
      const a = deps.repos.actions.byId(actionId);
      if (a === null || a.state !== 'executing') throw new ActionNotExecutingError(actionId);
      const payload = parseFinalPayload(a);
      if (payload === null || payload.kind !== a.kind) throw new ActionNotExecutingError(actionId);
      return runPrepared(a, prepareArgs(a, payload, false));
    },
  };
  return executor;
}
