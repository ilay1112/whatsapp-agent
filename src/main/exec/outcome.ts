// src/main/exec/outcome.ts - the item-row consequences of a CONFIRMED side effect (owner W1-11; additive helper, build-plan 1.3 style).
// Shared by exec/actionExecutor.ts (side effect answered straight away) and exec/reconcile.ts (side effect confirmed after a crash),
// so a reconciled action leaves exactly the same item row as a directly executed one. Never executes anything itself.
import { localToEpochMs } from '../../shared/when';
import { ActionPayloadSchema } from '../../shared/schemas';
import type { ActionPayload, CreateEventPayload, SendReplyPayload } from '../../shared/schemas';
import type { ActionResult, ApprovalAction, EpochMs, EventRevisionRecord } from '../../shared/types';
import type { Repos } from '../db/index';
import type { ActionId, ItemId } from '../../shared/types';
import type { EventContentWithStatus } from '../../shared/schemas';
import type { OwnedEventProjection } from '../mcp/readClient';
import { LIMITS } from '../../shared/types';
import { contentOfProjection, normaliseField } from './eventContent';

/** The approved payload (canonical_json after the user's edit). Returns null for a row whose JSON was nulled by retention. */
export function parseFinalPayload(action: ApprovalAction): ActionPayload | null {
  const raw = action.approvedFinalJson ?? '';
  if (raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = ActionPayloadSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** An event proposal that is still waiting for a click keeps the item open even after the reply was sent (ARCH section 7). */
function eventPending(eventState: string): boolean {
  return eventState === 'proposed' || eventState === 'incomplete';
}

/** ARCH section 7: reply sent by approval and no event pending => the item closes as 'replied'. */
export function applySendSuccess(repos: Repos, action: ApprovalAction, _payload: SendReplyPayload, now: EpochMs): void {
  const item = repos.items.byId(action.itemId);
  if (!item) return;
  repos.items.update(
    item.id,
    {
      replyState: 'sent',
      errorCode: null,
      closedReason: item.closedReason ?? (eventPending(item.eventState) ? null : 'replied'),
    },
    now,
  );
}

/** ARCH section 7: a created event moves the item to `in_calendar`; the html link is diagnostics only and never crosses IPC.
 *  [V2, C2 14 / F27 / F1] The item also becomes the event's ORIGIN (event_origin_item_id = its own id = the Google waItem tag), its
 *  event_revision becomes 1, and event_revisions gets the rev-1 'create' row (prev NULL; next = the readback content or, without a
 *  readback, the approved content; post_etag / post_updated = the readback's - the drift baseline of the first change / undo). */
export function applyCreateSuccess(
  repos: Repos,
  action: ApprovalAction,
  payload: CreateEventPayload,
  result: Extract<ActionResult, { kind: 'create_event' }>,
  now: EpochMs,
  readback: OwnedEventProjection | null = null,
): void {
  const item = repos.items.byId(action.itemId);
  if (!item) return;
  const next: EventContentWithStatus =
    readback !== null
      ? contentOfProjection(readback)
      : {
          title: normaliseField(payload.title, LIMITS.titleChars),
          startLocal: payload.startLocal,
          endLocal: payload.endLocal,
          timeZone: payload.timeZone,
          location: normaliseField(payload.location, LIMITS.locationChars),
          status: 'confirmed',
        };
  repos.items.update(
    item.id,
    {
      eventState: 'created',
      errorCode: null,
      calendarEventId: result.eventId,
      calendarHtmlLink: result.htmlLink,
      eventStartTs: localToEpochMs(payload.startLocal, payload.timeZone),
      eventRevision: 1,
      eventOriginItemId: item.id,
      calendarUpdated: readback?.updated ?? null,
    },
    now,
  );
  // One rev-1 row per event id: a reconcile of an already recorded create (or an id_exists retry) adds nothing.
  if (repos.eventRevisions.newestFor(result.eventId) !== null) return;
  repos.eventRevisions.insert({
    calendarEventId: result.eventId,
    itemId: item.id,
    revision: 1,
    kind: 'create',
    prev: null,
    next,
    actionId: action.id,
    appliedAt: now,
    postEtag: readback?.etag ?? null,
    postUpdated: readback?.updated ?? null,
  });
}

/** Records the inline error of a failed action on its item so the card can show one error line (ARCH 6.6 step 7). */
export function applyFailure(
  repos: Repos,
  action: ApprovalAction,
  code: import('../../shared/errors').ErrorCode,
  now: EpochMs,
): void {
  const item = repos.items.byId(action.itemId);
  if (!item) return;
  repos.items.update(item.id, { errorCode: code }, now);
}

// ======================= [V2 ADD] C2 14 (owner V2-W1-04-exec-auto) =======================
/** The audit kind of an applied change (ARCH-v2 7 outcome transaction). */
function auditKindOf(
  kind: 'reschedule' | 'move' | 'cancel' | 'undo',
): 'event_updated' | 'event_cancelled' | 'event_reverted' {
  if (kind === 'undo') return 'event_reverted';
  return kind === 'cancel' ? 'event_cancelled' : 'event_updated';
}

/** exec/outcome.ts - ONE transaction with markDone (the CALLER opens it): the acting item gets event_state updated|cancelled,
 *  calendar_event_id, event_start_ts, event_revision, calendar_updated and [F27] the source's event_origin_item_id (the Google waItem tag is
 *  never rewritten, it is carried forward); the source item closes 'superseded' (unless it IS the acting item - undo / cancelEvent act on
 *  the item holding the event); event_revisions insert (next = the READBACK, post_etag / post_updated of the readback - F1/F5; an undo
 *  also marks `revertOf` reverted by the new row); audit event_updated|event_cancelled|event_reverted (ids and numbers only).
 *  [V2-W1-04] Returns the inserted revision row (callers link auto_writes.revision_id / reverted_by to it); the frozen callers that
 *  ignore the result still compile. */
export function applyUpdateSuccess(
  repos: Repos,
  a: {
    actionId: ActionId;
    itemId: ItemId;
    sourceItemId: ItemId;
    eventId: string;
    revision: number;
    kind: 'reschedule' | 'move' | 'cancel' | 'undo';
    prev: EventContentWithStatus;
    next: EventContentWithStatus;
    calendarUpdated: string | null;
    postEtag: string | null;
    revertOf?: number;
  },
  now: EpochMs,
): EventRevisionRecord {
  const rev = repos.eventRevisions.insert({
    calendarEventId: a.eventId,
    itemId: a.itemId,
    revision: a.revision,
    kind: a.kind,
    prev: a.prev,
    next: a.next,
    actionId: a.actionId,
    appliedAt: now,
    postEtag: a.postEtag,
    postUpdated: a.calendarUpdated,
  });
  if (a.revertOf !== undefined) repos.eventRevisions.markReverted(a.revertOf, rev.id);
  // the revision row above references the acting item (FK): it exists. The source may have been purged meanwhile.
  const acting = repos.items.byId(a.itemId)!;
  const source = a.sourceItemId === a.itemId ? acting : repos.items.byId(a.sourceItemId);
  repos.items.update(
    acting.id,
    {
      eventState: a.next.status === 'cancelled' ? 'cancelled' : 'updated',
      errorCode: null,
      calendarEventId: a.eventId,
      eventStartTs: localToEpochMs(a.next.startLocal, a.next.timeZone),
      eventRevision: a.revision,
      calendarUpdated: a.calendarUpdated,
      eventOriginItemId: source?.eventOriginItemId ?? acting.eventOriginItemId,
    },
    now,
  );
  if (source !== null && source.id !== acting.id && source.closedReason === null) {
    repos.items.update(source.id, { closedReason: 'superseded' }, now);
  }
  repos.audit.append(
    auditKindOf(a.kind),
    a.actionId,
    { itemId: a.itemId, revision: a.revision, revisionId: rev.id, kind: a.kind },
    now,
  );
  return rev;
}

/** The auto_writes row of an action (the automatic-write ledger), or null for a click-approved action. */
export function autoWriteIdOfAction(repos: Repos, actionId: ActionId): string | null {
  const row = repos.db.prepare<{ id: string }>(`SELECT id FROM auto_writes WHERE action_id = ? LIMIT 1`).get(actionId);
  return row === undefined ? null : row.id;
}

/**
 * The whole outcome of a CONFIRMED update (ARCH-v2 7 / C2 14 step 10), shared by the executor (readback right after the PATCH) and by
 * reconcile (readback after a crash) so both leave exactly the same rows. The CALLER wraps it in one transaction. `next` = the readback;
 * `prev` = the approved `from` (the pre-flight readback after "Apply anyway", I8). An automatic write records its readback on its
 * auto_writes row; an undo marks `revertOf` (+ restoreOriginal's `extraReverts`) reverted and each reverted automatic write 'undone'.
 */
export function commitUpdateDone(
  repos: Repos,
  a: ApprovalAction,
  p: import('../../shared/schemas').UpdateEventPayload,
  rb: OwnedEventProjection,
  opts: { autoWriteId: string | null; extraReverts: readonly number[]; auditKind: 'action_done' | 'action_reconciled' },
  now: EpochMs,
): EventRevisionRecord {
  const target = repos.items.byId(p.targetItemId);
  const revision = Math.max(p.baseRevision, target?.eventRevision ?? p.baseRevision) + 1;
  repos.actions.markDone(a.id, { kind: 'update_event', eventId: p.targetEventId, revision, status: p.to.status }, now);
  const rev = applyUpdateSuccess(
    repos,
    {
      actionId: a.id,
      itemId: a.itemId,
      sourceItemId: p.targetItemId,
      eventId: p.targetEventId,
      revision,
      kind: p.change,
      prev: p.from,
      next: contentOfProjection(rb),
      calendarUpdated: rb.updated,
      postEtag: rb.etag,
      ...(p.revertOf !== undefined ? { revertOf: p.revertOf } : {}),
    },
    now,
  );
  repos.audit.append(opts.auditKind, a.id, { kind: 'update_event', attempt: a.attempt }, now);
  if (opts.autoWriteId !== null) {
    repos.autoWrites.recordReadback(opts.autoWriteId, {
      revisionId: rev.id,
      postEtag: rb.etag,
      postUpdated: rb.updated,
      postSequence: rb.sequence,
    });
  }
  if (p.change === 'undo' && p.revertOf !== undefined) {
    for (const id of opts.extraReverts) repos.eventRevisions.markReverted(id, rev.id);
    for (const id of [p.revertOf, ...opts.extraReverts]) {
      const w = autoWriteIdOfAction(repos, repos.eventRevisions.byId(id)!.actionId); // markReverted above threw for an unknown id
      if (w !== null) {
        repos.autoWrites.setUndo(w, { undoState: 'undone', undoActionId: a.id });
        repos.audit.append('auto_undo', w, { actionId: a.id, revisionId: id }, now);
      }
    }
  }
  return rev;
}
