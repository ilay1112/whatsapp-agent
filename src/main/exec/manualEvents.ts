// src/main/exec/manualEvents.ts - [v4 T6] T-908 handover §2.5 (I9'): user-authored calendar-view writes.
//
// Two halves, deliberately separate:
//  - createManualProposals(): calendar:propose* -> ONE pending source:'manual' action (+ shownHash + an app-built summary). It holds
//    NO write capability at all (its deps type has no write client): proposing never writes anything (I1').
//  - createManualExecutor(): the side effect of an approved manual action. Constructed ONLY inside exec/actionExecutor.ts (the sole
//    holder of the write client) and reached ONLY through ActionExecutor.approve (the action:approve click) and
//    ActionExecutor.undoManual (the action:undo click). Approved by 'user' only (also trg_actions_state), never AutoGate.
//
// I9' in code (not only in the UI): an event with other attendees, a recurrence, an instance of a series, a chat card's event (waItem
// tag) or on a calendar that is not owner|writer is refused with CAL_EVENT_FOREIGN_PROTECTED - at propose time AND again by the
// executor's pre-flight get-event (manualOwnershipOf), whatever the renderer sent.
// I8: the pre-write snapshot (get-event) lands in event_revisions IN THE WRITE-AHEAD TRANSACTION, before update-event / delete-event.
// Undo: of a create = delete-event; of an edit = PATCH back to the snapshot; of a delete = create-event from the snapshot (a NEW id,
// tagged waAgent '1' + waManual '1'). One undo per action (the reverted revision / the undo row refuse a second one).
// Titles / locations are UNTRUSTED: they go into payloads and the calendar, never into logs / audit rows (calendarSha8 only).
import { createHash, randomUUID } from 'node:crypto';
import { LIMITS } from '../../shared/types';
import {
  EventEditSchema,
  ManualActionPayloadSchema,
  canonicalJson,
  stripInvisible,
  type EventContent,
  type EventContentWithStatus,
  type ManualActionPayload,
  type ManualCreatePayload,
  type ManualDeletePayload,
  type ManualEditPayload,
} from '../../shared/schemas';
import { localToEpochMs } from '../../shared/when';
import { verifyShownHash } from './actionHash';
import { eventIdFor } from './buildCreateEventArgs';
import { contentOfProjection, equalContent, sameContent, viewOf } from './eventContent';
import type {
  ActionId,
  CalendarAccessRole,
  EpochMs,
  ManualAction,
  ManualOutcomeView,
  ManualProposal,
  ManualRevisionKind,
  ManualSummary,
  Result,
} from '../../shared/types';
import type { ErrorCode } from '../../shared/errors';
import type { ApproveOutcome, ApproveReq } from '../../shared/ipc';
import type { Repos } from '../db/index';
import type { McpErrorKind, McpReadClient, McpResult, OwnedEventProjection } from '../mcp/readClient';
import type { McpWriteClient } from '../mcp/writeClient';
import type { RateLimiter } from './rateLimiter';

const WRITABLE: ReadonlySet<CalendarAccessRole> = new Set<CalendarAccessRole>(['owner', 'writer']);
const sha8 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);
const fail = <T>(code: ErrorCode): Result<T> => ({ ok: false, error: { code } });

/** Why a manual change of an event is refused (audit `manual_event_refused {reason}`). */
export type ManualRefusal =
  'readonly' | 'attendees' | 'recurring' | 'from_chat' | 'all_day' | 'mismatch' | 'held_by_card' | 'cancelled';

/**
 * I9' (handover §2.5), evaluated on the FRESH pre-flight get-event: the calendar is owner|writer, the event is the one named, it has
 * no attendees, no recurrence / recurringEventId, it is not a chat card's event (waItem tag), and it is not cancelled. 'ok' or the
 * FIRST refusal. Used by the propose half and again by the executor right before the write.
 */
export function manualOwnershipOf(
  pf: OwnedEventProjection,
  target: { calendarId: string; eventId: string },
  roles: Readonly<Record<string, CalendarAccessRole>>,
): 'ok' | ManualRefusal {
  const role = Object.hasOwn(roles, target.calendarId) ? roles[target.calendarId] : undefined;
  if (role === undefined || !WRITABLE.has(role)) return 'readonly';
  if (pf.id !== target.eventId) return 'mismatch';
  if (pf.hasAttendees) return 'attendees';
  if (pf.hasRecurrence) return 'recurring';
  if (pf.priv.waItem !== null && pf.priv.waItem !== '') return 'from_chat';
  if (pf.status === 'cancelled') return 'cancelled';
  return 'ok';
}
const refusalCode = (r: ManualRefusal): ErrorCode =>
  r === 'cancelled' ? 'CAL_EVENT_GONE' : 'CAL_EVENT_FOREIGN_PROTECTED';
const readCode = (e: McpErrorKind): ErrorCode =>
  e === 'not_found' ? 'CAL_EVENT_GONE' : e === 'auth' ? 'CAL_RECONNECT' : 'CAL_UNAVAILABLE';

/** Main-generated event id of a manual create (base32hex, 32 chars; deterministic per action so a retry answers 409 => done). */
export function manualEventIdFor(actionKey: string, content: EventContent): string {
  return eventIdFor(`manual:${actionKey}`, content);
}

const summaryOf = (p: ManualActionPayload, undo: boolean): ManualSummary => {
  const op: ManualSummary['op'] = undo
    ? 'undo'
    : p.kind === 'create_event'
      ? 'create'
      : p.kind === 'update_event'
        ? 'edit'
        : 'delete';
  if (p.kind === 'create_event')
    return { op, calendarId: p.calendarId, before: null, after: viewOf({ ...p.to, status: 'confirmed' }) };
  if (p.kind === 'update_event')
    return { op, calendarId: p.calendarId, before: viewOf(p.from), after: viewOf({ ...p.to, status: 'confirmed' }) };
  return { op, calendarId: p.calendarId, before: viewOf(p.from), after: null };
};

type Audit = (
  kind: import('../../shared/types').AuditKind,
  ref: string | null,
  detail: Record<string, string | number | boolean | null>,
) => void;

/** User-typed event fields -> validated content (TRUSTED but re-validated: invisible characters stripped, bounds, 5 min .. 12 h). */
function cleanContent(
  e: { title: string; startLocal: string; endLocal: string; location: string },
  timeZone: string,
): EventContent | null {
  const parsed = EventEditSchema.safeParse({
    title: stripInvisible(e.title).trim(),
    startLocal: e.startLocal,
    endLocal: e.endLocal,
    location: stripInvisible(e.location).trim(),
  });
  if (!parsed.success) return null;
  const minutes =
    (localToEpochMs(parsed.data.endLocal, timeZone) - localToEpochMs(parsed.data.startLocal, timeZone)) / 60_000;
  if (!Number.isFinite(minutes) || minutes < LIMITS.eventMinMin || minutes > LIMITS.eventMaxMin) return null;
  return { ...parsed.data, timeZone };
}

// =====================================================================================================================
// propose (no write capability)
// =====================================================================================================================

export interface ManualProposalsDeps {
  repos: Repos;
  read: Pick<McpReadClient, 'getEvent'>;
  /** CalendarEventsService.resolve: the opaque key of the week read -> the real event id (main only). null = not in the cache. */
  resolve(calendarId: string, eventKey: string): { eventId: string; allDay: boolean } | null;
  roles(): Readonly<Record<string, CalendarAccessRole>>;
  timeZone(): string;
  calendarConnected(): boolean;
  now(): EpochMs;
  audit: Audit;
  randomUuid?: () => string;
}
export interface ManualProposals {
  proposeCreate(req: {
    calendarId: string;
    title: string;
    startLocal: string;
    endLocal: string;
    location: string;
  }): Promise<Result<ManualProposal>>;
  proposeEdit(req: {
    calendarId: string;
    eventKey: string;
    patch: { title?: string; startLocal?: string; endLocal?: string; location?: string };
  }): Promise<Result<ManualProposal>>;
  proposeDelete(req: { calendarId: string; eventKey: string }): Promise<Result<ManualProposal>>;
}

export function createManualProposals(deps: ManualProposalsDeps): ManualProposals {
  const uuid = deps.randomUuid ?? ((): string => randomUUID());
  const refused = (reason: ManualRefusal | 'invalid', calendarId: string): void =>
    deps.audit('manual_event_refused', null, { reason, stage: 'propose', calendarSha8: sha8(calendarId) });

  const writable = (calendarId: string): boolean => {
    const roles = deps.roles();
    const role = Object.hasOwn(roles, calendarId) ? roles[calendarId] : undefined;
    return role !== undefined && WRITABLE.has(role);
  };

  const pending = (payload: ManualActionPayload): ManualProposal => {
    const now = deps.now();
    const action = deps.repos.db.transaction(() => {
      deps.repos.actions.supersedePendingManual(now); // one approvable manual proposal at a time
      return deps.repos.actions.insertManualPending({ payload, now });
    });
    deps.audit('manual_event_proposed', action.id, { kind: payload.kind, calendarSha8: sha8(payload.calendarId) });
    return {
      actionId: action.id,
      kind: action.kind,
      shownHash: action.contentSha256,
      summary: summaryOf(payload, false),
    };
  };

  /** resolve + get-event + I9' for an existing event. */
  const existing = async (
    calendarId: string,
    eventKey: string,
  ): Promise<Result<{ eventId: string; pf: OwnedEventProjection & { etag: string } }>> => {
    if (!deps.calendarConnected()) return fail('CAL_UNAVAILABLE');
    const hit = deps.resolve(calendarId, eventKey);
    if (hit === null) return fail('CAL_EVENT_GONE'); // the view re-reads the week and the user tries again
    if (hit.allDay) {
      refused('all_day', calendarId);
      return fail('CAL_EVENT_FOREIGN_PROTECTED');
    }
    let pre: McpResult<OwnedEventProjection>;
    try {
      pre = await deps.read.getEvent(calendarId, hit.eventId);
    } catch {
      pre = { ok: false, error: 'unavailable' };
    }
    if (!pre.ok) return fail(readCode(pre.error));
    const verdict = manualOwnershipOf(pre.value, { calendarId, eventId: hit.eventId }, deps.roles());
    if (verdict !== 'ok') {
      refused(verdict, calendarId);
      return fail(refusalCode(verdict));
    }
    if (pre.value.etag === null) return fail('CAL_UPDATE_UNAVAILABLE');
    return { ok: true, value: { eventId: hit.eventId, pf: pre.value as OwnedEventProjection & { etag: string } } };
  };

  return {
    async proposeCreate(req) {
      if (!deps.calendarConnected()) return fail('CAL_UNAVAILABLE');
      if (!writable(req.calendarId)) {
        refused('readonly', req.calendarId);
        return fail('CAL_EVENT_FOREIGN_PROTECTED');
      }
      const to = cleanContent(req, deps.timeZone());
      if (to === null) return fail('EVENT_INVALID');
      const payload: ManualCreatePayload = {
        v: 1,
        source: 'manual',
        kind: 'create_event',
        calendarId: req.calendarId,
        eventId: manualEventIdFor(uuid(), to),
        to,
      };
      const parsed = ManualActionPayloadSchema.safeParse(payload);
      if (!parsed.success) return fail('EVENT_INVALID');
      return { ok: true, value: pending(parsed.data) };
    },

    async proposeEdit(req) {
      const found = await existing(req.calendarId, req.eventKey);
      if (!found.ok) return found;
      const { pf, eventId } = found.value;
      const from = contentOfProjection(pf);
      const p = req.patch;
      if ((p.startLocal === undefined) !== (p.endLocal === undefined)) return fail('EVENT_INVALID');
      // a new time is wall clock in the app's zone (what the view shows); an untouched time keeps the event's own zone
      const timeZone = p.startLocal === undefined ? from.timeZone : deps.timeZone();
      const to = cleanContent(
        {
          title: p.title ?? from.title,
          startLocal: p.startLocal ?? from.startLocal,
          endLocal: p.endLocal ?? from.endLocal,
          location: p.location ?? from.location,
        },
        timeZone,
      );
      if (to === null) return fail('EVENT_INVALID');
      if (equalContent({ ...to, status: 'confirmed' }, from)) return fail('BAD_REQUEST'); // nothing to change
      const payload: ManualEditPayload = {
        v: 1,
        source: 'manual',
        kind: 'update_event',
        calendarId: req.calendarId,
        eventId,
        baseEtag: pf.etag,
        from,
        to,
      };
      const parsed = ManualActionPayloadSchema.safeParse(payload);
      if (!parsed.success) return fail('EVENT_INVALID');
      return { ok: true, value: pending(parsed.data) };
    },

    async proposeDelete(req) {
      const found = await existing(req.calendarId, req.eventKey);
      if (!found.ok) return found;
      const { pf, eventId } = found.value;
      const payload: ManualDeletePayload = {
        v: 1,
        source: 'manual',
        kind: 'delete_event',
        calendarId: req.calendarId,
        eventId,
        baseEtag: pf.etag,
        from: contentOfProjection(pf),
      };
      const parsed = ManualActionPayloadSchema.safeParse(payload);
      if (!parsed.success) return fail('EVENT_INVALID');
      return { ok: true, value: pending(parsed.data) };
    },
  };
}

// =====================================================================================================================
// execute (constructed ONLY by exec/actionExecutor.ts)
// =====================================================================================================================

export interface ManualExecutorDeps {
  repos: Repos;
  /** the executor's write client (the three manual methods only) */
  write: Pick<McpWriteClient, 'createManualEvent' | 'updateManualEvent' | 'deleteManualEvent'>;
  read: Pick<McpReadClient, 'getEvent'>;
  roles(): Readonly<Record<string, CalendarAccessRole>>;
  calendarConnected(): boolean;
  updateSurfaceAvailable(): boolean;
  now(): EpochMs;
  rate: Pick<RateLimiter, 'checkCreate' | 'recordCreate'>;
  descriptionTemplate(): string;
  randomUuid(): string;
}
export interface ManualExecutor {
  /** action:approve of a manual action (by 'user' only). Gates, then the write-ahead WITH the snapshot row, then the side effect. */
  approve(a: ManualAction, req: ApproveReq, by: 'user' | 'user_toast'): Promise<Result<ApproveOutcome>>;
  /** action:undo: builds the undo action of an executed manual action and approves it at once through approve(). */
  undo(actionId: ActionId): Promise<Result<ApproveOutcome>>;
  /** The newest undoable manual action of an event (popover "Undo last change"), or null. */
  undoableFor(eventId: string): ActionId | null;
  /** Startup: manual executing -> unknown_outcome (never re-executed). */
  recover(): void;
}

class Stale extends Error {}

export function createManualExecutor(deps: ManualExecutorDeps): ManualExecutor {
  const { repos } = deps;
  const audit: Audit = (kind, ref, detail) => repos.audit.append(kind, ref, detail, deps.now());

  const outcome = (
    a: Pick<ManualAction, 'id'>,
    p: ManualActionPayload,
    result: 'done' | 'failed',
    errorCode: ErrorCode | null,
  ): Result<ApproveOutcome> => {
    const manual: ManualOutcomeView = {
      actionId: a.id,
      op: summaryOf(p, p.undoOf !== undefined).op,
      calendarId: p.calendarId,
      undoable: result === 'done' && p.undoOf === undefined,
      errorCode,
    };
    return { ok: true, value: { outcome: result, item: null, manual } };
  };

  const revisionKindOf = (p: ManualActionPayload): ManualRevisionKind =>
    p.undoOf !== undefined
      ? 'manual_undo'
      : p.kind === 'create_event'
        ? 'manual_create'
        : p.kind === 'update_event'
          ? 'manual_edit'
          : 'manual_delete';

  const getEvent = async (calendarId: string, eventId: string): Promise<McpResult<OwnedEventProjection>> => {
    try {
      return await deps.read.getEvent(calendarId, eventId);
    } catch {
      return { ok: false, error: 'unavailable' };
    }
  };

  const finish = (
    a: ManualAction,
    p: ManualActionPayload,
    revisionId: number,
    res:
      | {
          ok: true;
          result: import('../../shared/types').ActionResult;
          next: EventContentWithStatus | null;
          rb: OwnedEventProjection | null;
        }
      | { ok: false; unknown: true }
      | { ok: false; unknown: false; code: ErrorCode },
  ): Result<ApproveOutcome> => {
    const now = deps.now();
    const detail = { kind: a.kind, op: summaryOf(p, p.undoOf !== undefined).op, calendarSha8: sha8(p.calendarId) };
    if (res.ok) {
      repos.db.transaction(() => {
        repos.actions.markDone(a.id, res.result, now);
        repos.eventRevisions.recordManualOutcome(revisionId, {
          next: res.next,
          postEtag: res.rb?.etag ?? null,
          postUpdated: res.rb?.updated ?? null,
        });
        if (p.undoOf !== undefined) {
          const reverted = repos.eventRevisions.manualForAction(p.undoOf);
          if (reverted !== null) repos.eventRevisions.markReverted(reverted.id, revisionId);
        }
        repos.audit.append('action_done', a.id, { kind: a.kind, attempt: 1 }, now);
        repos.audit.append('manual_event_executed', a.id, { ...detail, outcome: 'done' }, now);
      });
      return outcome(a, p, 'done', null);
    }
    if (res.unknown) {
      repos.actions.markUnknownOutcome(a.id, now);
      repos.audit.append('action_unknown_outcome', a.id, { kind: a.kind, attempt: 1 }, now);
      repos.audit.append('manual_event_executed', a.id, { ...detail, outcome: 'unknown_outcome' }, now);
      return outcome(a, p, 'failed', 'ACTION_UNKNOWN_OUTCOME');
    }
    repos.actions.markFailed(a.id, res.code, now);
    repos.audit.append('action_failed', a.id, { kind: a.kind, attempt: 1, code: res.code }, now);
    repos.audit.append('manual_event_executed', a.id, { ...detail, outcome: 'failed' }, now);
    return outcome(a, p, 'failed', res.code);
  };

  const failureOf = (
    e: McpErrorKind,
    kind: 'create' | 'update' | 'delete',
  ): { ok: false; unknown: true } | { ok: false; unknown: false; code: ErrorCode } => {
    if (e === 'timeout') return { ok: false, unknown: true };
    if (e === 'unavailable' && kind !== 'update') return { ok: false, unknown: true };
    if (e === 'unavailable')
      return deps.updateSurfaceAvailable()
        ? { ok: false, unknown: true }
        : { ok: false, unknown: false, code: 'CAL_UPDATE_UNAVAILABLE' };
    if (e === 'auth') return { ok: false, unknown: false, code: 'CAL_RECONNECT' };
    if (e === 'not_found') return { ok: false, unknown: false, code: 'CAL_EVENT_GONE' };
    if (e === 'precondition') return { ok: false, unknown: false, code: 'ACTION_STALE' };
    return { ok: false, unknown: false, code: kind === 'create' ? 'CAL_CREATE_FAILED' : 'CAL_UPDATE_FAILED' };
  };

  const approve = async (
    a: ManualAction,
    req: ApproveReq,
    by: 'user' | 'user_toast',
  ): Promise<Result<ApproveOutcome>> => {
    const now = deps.now();
    if (by !== 'user') return fail('ACTION_STALE'); // a manual action is approved by a click only (trigger-enforced too)
    if (a.kind !== req.kind) return fail('ACTION_STALE');
    if (a.state === 'expired') return fail('ACTION_EXPIRED');
    if (a.state !== 'pending') return fail('ACTION_STALE');
    if (now >= a.expiresAt) {
      repos.actions.expireOverdue(now);
      return fail('ACTION_EXPIRED');
    }
    if (!verifyShownHash(a.canonicalJson, req.shownHash)) return fail('ACTION_STALE');
    // exactly what the confirm dialog showed: no edit, no confirm flags
    if (req.edit !== undefined || req.confirmConflict || req.confirmDuplicate || req.confirmDrift)
      return fail('BAD_REQUEST');
    const parsed = ManualActionPayloadSchema.safeParse(JSON.parse(a.canonicalJson) as unknown);
    if (!parsed.success || parsed.data.kind !== a.kind) return fail('ACTION_STALE');
    const p = parsed.data;
    if (!deps.calendarConnected()) return fail('CAL_UNAVAILABLE');
    if (p.kind === 'update_event' && !deps.updateSurfaceAvailable()) return fail('CAL_UPDATE_UNAVAILABLE');
    const roles = deps.roles();
    const role = Object.hasOwn(roles, p.calendarId) ? roles[p.calendarId] : undefined;
    if (role === undefined || !WRITABLE.has(role)) {
      audit('manual_event_refused', a.id, { reason: 'readonly', stage: 'approve', calendarSha8: sha8(p.calendarId) });
      repos.actions.markRejected(a.id);
      return fail('CAL_EVENT_FOREIGN_PROTECTED');
    }

    // ---- pre-flight (edit / delete): the snapshot, I9' and drift, all BEFORE the write-ahead ----
    let pf: OwnedEventProjection | null = null;
    if (p.kind !== 'create_event') {
      const pre = await getEvent(p.calendarId, p.eventId);
      if (!pre.ok) return fail(readCode(pre.error));
      const verdict = manualOwnershipOf(pre.value, p, roles);
      if (verdict !== 'ok') {
        audit('manual_event_refused', a.id, { reason: verdict, stage: 'approve', calendarSha8: sha8(p.calendarId) });
        repos.actions.markRejected(a.id);
        return fail(refusalCode(verdict));
      }
      // Google's copy must still be what the user saw (content); If-Match then guards the PATCH itself.
      if (!sameContent(pre.value, p.from)) return fail('ACTION_STALE');
      if (p.kind === 'update_event' && pre.value.etag === null) return fail('CAL_UPDATE_UNAVAILABLE');
      pf = pre.value;
    }
    const limit = deps.rate.checkCreate(); // create_global counts every calendar write
    if (!limit.ok) return fail(limit.code);

    // ---- write-ahead: pending -> approved -> executing AND the pre-write snapshot row, ONE transaction (I8) ----
    const snapshot = pf === null ? null : contentOfProjection(pf);
    const next: EventContentWithStatus | null = p.kind === 'delete_event' ? null : { ...p.to, status: 'confirmed' };
    const writeAheadAt = deps.now();
    let revisionId: number;
    try {
      revisionId = repos.db.transaction(() => {
        if (repos.actions.markApprovedExecuting(a.id, canonicalJson(p), writeAheadAt, 'user') === 'stale')
          throw new Stale();
        const rev = repos.eventRevisions.insertManual({
          calendarEventId: p.eventId,
          kind: revisionKindOf(p),
          prev: snapshot,
          next,
          actionId: a.id,
          appliedAt: writeAheadAt,
        });
        repos.audit.append(
          'action_approved',
          a.id,
          { kind: a.kind, attempt: 1, by: 'user', source: 'manual' },
          writeAheadAt,
        );
        return rev.id;
      });
    } catch (e) {
      if (e instanceof Stale) return fail('ACTION_STALE');
      throw e;
    }
    deps.rate.recordCreate();
    const executing = repos.actions.manualById(a.id)!;

    // ---- the side effect ----
    if (p.kind === 'create_event') {
      let res: Awaited<ReturnType<ManualExecutorDeps['write']['createManualEvent']>>;
      try {
        res = await deps.write.createManualEvent({
          calendarId: p.calendarId,
          account: 'personal',
          summary: p.to.title,
          start: p.to.startLocal,
          end: p.to.endLocal,
          timeZone: p.to.timeZone,
          location: p.to.location,
          description: deps.descriptionTemplate(),
          sendUpdates: 'none',
          eventId: p.eventId,
          extendedProperties: { private: { waAgent: '1', waManual: '1', waAction: a.id } },
        });
      } catch {
        res = { ok: false, error: 'unavailable' };
      }
      const landed = res.ok
        ? res.value
        : !res.ok && res.error === 'id_exists'
          ? { eventId: p.eventId, htmlLink: null }
          : null;
      if (landed === null)
        return finish(executing, p, revisionId, failureOf((res as { error: McpErrorKind }).error, 'create'));
      const rb = await getEvent(p.calendarId, p.eventId);
      return finish(executing, p, revisionId, {
        ok: true,
        result: { kind: 'create_event', eventId: p.eventId, htmlLink: landed.htmlLink },
        next: rb.ok ? contentOfProjection(rb.value) : next,
        rb: rb.ok ? rb.value : null,
      });
    }

    if (p.kind === 'update_event') {
      let res: Awaited<ReturnType<ManualExecutorDeps['write']['updateManualEvent']>>;
      try {
        res = await deps.write.updateManualEvent({
          calendarId: p.calendarId,
          account: 'personal',
          eventId: p.eventId,
          summary: p.to.title,
          start: p.to.startLocal,
          end: p.to.endLocal,
          timeZone: p.to.timeZone,
          location: p.to.location,
          sendUpdates: 'none',
          checkConflicts: false,
          ifMatch: pf!.etag!,
        });
      } catch {
        res = { ok: false, error: 'unavailable' };
      }
      if (!res.ok) return finish(executing, p, revisionId, failureOf(res.error, 'update'));
      // done = a readback of THIS event in the approved slot; anything else is an unknown outcome
      const rb = await getEvent(p.calendarId, p.eventId);
      if (!rb.ok || rb.value.startLocal !== p.to.startLocal || rb.value.endLocal !== p.to.endLocal)
        return finish(executing, p, revisionId, { ok: false, unknown: true });
      const rev = repos.eventRevisions.manualById(revisionId)!;
      return finish(executing, p, revisionId, {
        ok: true,
        result: { kind: 'update_event', eventId: p.eventId, revision: rev.revision, status: 'confirmed' },
        next: contentOfProjection(rb.value),
        rb: rb.value,
      });
    }

    let res: Awaited<ReturnType<ManualExecutorDeps['write']['deleteManualEvent']>>;
    try {
      res = await deps.write.deleteManualEvent({ source: 'manual', calendarId: p.calendarId, eventId: p.eventId });
    } catch {
      res = { ok: false, error: 'unavailable' };
    }
    if (!res.ok) return finish(executing, p, revisionId, failureOf(res.error, 'delete'));
    return finish(executing, p, revisionId, {
      ok: true,
      result: { kind: 'delete_event', eventId: p.eventId },
      next: null,
      rb: null,
    });
  };

  /** The undo-eligibility of an executed manual action: its revision, or the refusal code. */
  const undoTarget = (
    original: ManualAction | null,
  ):
    | {
        ok: true;
        payload: ManualActionPayload;
        rev: NonNullable<ReturnType<Repos['eventRevisions']['manualForAction']>>;
      }
    | { ok: false; code: ErrorCode } => {
    if (original === null || original.state !== 'done') return { ok: false, code: 'ACTION_STALE' };
    const parsed = ManualActionPayloadSchema.safeParse(JSON.parse(original.canonicalJson || 'null') as unknown);
    if (!parsed.success || parsed.data.undoOf !== undefined) return { ok: false, code: 'ACTION_STALE' }; // an undo is not undone
    const rev = repos.eventRevisions.manualForAction(original.id);
    if (rev === null || rev.revertedBy !== null) return { ok: false, code: 'ACTION_STALE' };
    if (repos.actions.manualUndosOf(original.id).length > 0) return { ok: false, code: 'ACTION_STALE' };
    if (deps.now() - rev.appliedAt > LIMITS.manualUndoWindowMs) return { ok: false, code: 'ACTION_EXPIRED' };
    if (parsed.data.kind === 'delete_event' && rev.prev === null) return { ok: false, code: 'ACTION_STALE' };
    if (parsed.data.kind !== 'delete_event' && rev.next === null) return { ok: false, code: 'ACTION_STALE' };
    return { ok: true, payload: parsed.data, rev };
  };

  const undo = async (actionId: ActionId): Promise<Result<ApproveOutcome>> => {
    const original = repos.actions.manualById(actionId);
    const t = undoTarget(original);
    if (!t.ok) return fail(t.code);
    const { payload: o, rev } = t;
    let undoPayload: ManualActionPayload;
    if (o.kind === 'delete_event') {
      // recreate from the snapshot: a NEW id, app-tagged (waAgent '1' + waManual '1'), no attendees by construction
      const prev = rev.prev!;
      const to: EventContent = {
        title: prev.title,
        startLocal: prev.startLocal,
        endLocal: prev.endLocal,
        timeZone: prev.timeZone,
        location: prev.location,
      };
      undoPayload = {
        v: 1,
        source: 'manual',
        kind: 'create_event',
        calendarId: o.calendarId,
        eventId: manualEventIdFor(deps.randomUuid(), to),
        to,
        undoOf: original!.id,
      };
    } else {
      if (!deps.calendarConnected()) return fail('CAL_UNAVAILABLE');
      const pre = await getEvent(o.calendarId, o.eventId);
      if (!pre.ok) return fail(readCode(pre.error));
      // only while Google still holds exactly what this action wrote (nothing changed it since)
      if (!sameContent(pre.value, rev.next!) || pre.value.etag === null) return fail('ACTION_STALE');
      const current = contentOfProjection(pre.value);
      if (o.kind === 'create_event') {
        undoPayload = {
          v: 1,
          source: 'manual',
          kind: 'delete_event',
          calendarId: o.calendarId,
          eventId: o.eventId,
          baseEtag: pre.value.etag,
          from: current,
          undoOf: original!.id,
        };
      } else {
        const prev = rev.prev!;
        undoPayload = {
          v: 1,
          source: 'manual',
          kind: 'update_event',
          calendarId: o.calendarId,
          eventId: o.eventId,
          baseEtag: pre.value.etag,
          from: current,
          to: {
            title: prev.title,
            startLocal: prev.startLocal,
            endLocal: prev.endLocal,
            timeZone: prev.timeZone,
            location: prev.location,
          },
          undoOf: original!.id,
        };
      }
    }
    const checked = ManualActionPayloadSchema.safeParse(undoPayload);
    if (!checked.success) return fail('ACTION_STALE');
    const now = deps.now();
    const action = repos.db.transaction(() => {
      repos.actions.supersedePendingManual(now);
      return repos.actions.insertManualPending({ payload: checked.data, now });
    });
    audit('manual_event_proposed', action.id, { kind: action.kind, calendarSha8: sha8(o.calendarId), undo: true });
    // the Undo click IS the approval of this undo (like item:undoChange): same gates, approved_by 'user'
    return approve(action, { actionId: action.id, kind: action.kind, shownHash: action.contentSha256 }, 'user');
  };

  return {
    approve,
    undo,
    undoableFor(eventId) {
      const row = repos.db
        .prepare<{ action_id: string }>(
          `SELECT r.action_id FROM event_revisions r JOIN actions a ON a.id = r.action_id
             WHERE r.calendar_event_id = ? AND r.item_id IS NULL AND r.kind IN ('manual_create','manual_edit')
               AND r.reverted_by IS NULL AND a.state = 'done' AND a.source = 'manual' AND r.applied_at >= ?
             ORDER BY r.revision DESC LIMIT 1`,
        )
        .get(eventId, deps.now() - LIMITS.manualUndoWindowMs);
      if (row === undefined) return null;
      const newest = repos.db
        .prepare<{ action_id: string }>(
          `SELECT action_id FROM event_revisions WHERE calendar_event_id = ? ORDER BY revision DESC LIMIT 1`,
        )
        .get(eventId);
      // only the LAST change of the event is undone from the popover (an undo row on top means it was undone)
      if (newest?.action_id !== row.action_id) return null;
      return undoTarget(repos.actions.manualById(row.action_id)).ok ? row.action_id : null;
    },
    recover() {
      const now = deps.now();
      for (const a of repos.actions.manualExecuting()) {
        repos.actions.markUnknownOutcome(a.id, now);
        repos.audit.append('action_unknown_outcome', a.id, { kind: a.kind, attempt: 1 }, now);
      }
    },
  };
}
