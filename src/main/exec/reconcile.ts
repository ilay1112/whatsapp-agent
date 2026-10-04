// src/main/exec/reconcile.ts - resolves unknown_outcome actions read-only (build-plan section 3; owner W1-11). Safety-critical.
// NOTHING here executes a side effect: it only LOOKS for evidence that the side effect already happened (an outbound row in the
// bridge's own messages.db, or a calendar event carrying our chain-root action id) and, when it finds it, marks the action done.
// [R2] A reconcile that fails (MCP down, store missing) leaves the action in `unknown_outcome`; the card keeps offering the clone.
import { LIMITS } from '../../shared/types';
import { epochMsToLocal, localToEpochMs } from '../../shared/when';
import { parseBridgeTs } from '../bridge/timestamps';
import {
  applyCreateSuccess,
  applySendSuccess,
  autoWriteIdOfAction,
  commitUpdateDone,
  parseFinalPayload,
} from './outcome';
import { contentOfProjection, normaliseField } from './eventContent';
import type { OwnedEventProjection } from '../mcp/readClient';
import type { CreateEventPayload, EventContentWithStatus, UpdateEventPayload } from '../../shared/schemas';
import type { Repos } from '../db/index';
import type { BridgeDb } from '../bridge/bridgeDb';
import type { McpReadClient, PinnedWindow } from '../mcp/readClient';
import type { ActionId, ApprovalAction, EpochMs } from '../../shared/types';

export interface ReconcileDeps {
  repos: Repos;
  bridgeDb: Pick<BridgeDb, 'open' | 'outboundAfter' | 'close'> | null; // null when the bridge store does not exist yet
  /** null when the calendar is not connected. [V2-W1-04] getEvent (optional so v1 callers compile): update reconcile + the B24 edit check. */
  read: (Pick<McpReadClient, 'findAppEvent'> & Partial<Pick<McpReadClient, 'getEvent'>>) | null;
  now: () => EpochMs;
  timeZone: () => string;
}
export interface ReconcileResult {
  checked: number;
  resolvedDone: number; // matched outbound row / found app event (waAction = chain root) -> markDone
  stillUnknown: number;
}

/** How many outbound rows of one chat are inspected. The window is 2 minutes wide, so this is generous. */
const OUTBOUND_SCAN_LIMIT = 200;
/** Margin around the approved slot for the read-only `list-events` lookup (the event was created with exactly these local times). */
const EVENT_LOOKUP_MARGIN_MS = 24 * 3_600_000;

/** `SELECT id` only: the rows themselves are re-read through the repo so every mapping stays in db/repos/rows.ts. */
function unknownOutcomeIds(repos: Repos): ActionId[] {
  return repos.db
    .prepare<{ id: string }>(
      `SELECT id FROM actions WHERE state = 'unknown_outcome' ORDER BY executed_at ASC, created_at ASC`,
    )
    .all()
    .map((r) => r.id);
}

/** send_reply: an is_from_me row of that chat within LIMITS.reconcileSendWindowMs after executed_at whose text equals the final payload. */
function findOutboundMatch(
  db: Pick<BridgeDb, 'outboundAfter'>,
  chatJid: string,
  text: string,
  from: EpochMs,
): string | null {
  const until = from + LIMITS.reconcileSendWindowMs;
  for (const row of db.outboundAfter(chatJid, 0, OUTBOUND_SCAN_LIMIT)) {
    if (row.content !== text) continue;
    const ts = parseBridgeTs(row.timestamp);
    if (ts === null || ts < from || ts > until) continue;
    return row.id;
  }
  return null;
}

/** create_event: read.findAppEvent(chainRoot) -> markDone with the found eventId. */
async function reconcileCreate(deps: ReconcileDeps, action: ApprovalAction): Promise<boolean> {
  const read = deps.read;
  const payload = parseFinalPayload(action);
  if (read === null || payload === null || payload.kind !== 'create_event') return false;
  // The approved payload always pins its own zone; `deps.timeZone()` is the settings fallback for a row that somehow lost it.
  const settingsZone = deps.timeZone();
  const timeZone = payload.timeZone || settingsZone;
  const startMs = localToEpochMs(payload.startLocal, timeZone);
  const endMs = localToEpochMs(payload.endLocal, timeZone);
  const settings = deps.repos.settings.get();
  const window: PinnedWindow = {
    timeMinLocal: epochMsToLocal(startMs - EVENT_LOOKUP_MARGIN_MS, timeZone),
    timeMaxLocal: epochMsToLocal(endMs + EVENT_LOOKUP_MARGIN_MS, timeZone),
    timeZone,
    calendarIds: [settings.calendar.targetCalendarId],
    account: 'personal',
  };
  const root = deps.repos.actions.chainRoot(action.id);
  let found: Awaited<ReturnType<McpReadClient['findAppEvent']>>;
  try {
    found = await read.findAppEvent(root.id, window);
  } catch {
    return false; // [R2] a reconcile failure keeps unknown_outcome and still offers the clone
  }
  if (!found.ok || found.value === null) return false;
  // [V2] the readback of the found event: the rev-1 baseline (post_etag / post_updated) and the B24 edit check.
  const eventId = found.value.eventId;
  const readback = await readEvent(deps, settings.calendar.targetCalendarId, eventId);
  const now = deps.now();
  const result = { kind: 'create_event' as const, eventId, htmlLink: found.value.htmlLink };
  const approved = approvedContentOf(payload);
  const foundContent = readback === null || readback.status === 'cancelled' ? null : contentOfProjection(readback);
  const edited = foundContent !== null && !sameApprovedContent(foundContent, approved);
  // [I7] markDone + the item consequence + the audit are ONE transaction: a `done` action whose item row still says
  // 'proposed' is revisited by no later pass, so the next triage would propose - and offer to create - the event again.
  deps.repos.db.transaction(() => {
    deps.repos.actions.markDone(action.id, result, now);
    applyCreateSuccess(deps.repos, action, payload, result, now, readback);
    deps.repos.audit.append('action_reconciled', action.id, { kind: 'create_event', attempt: action.attempt }, now);
    // [V2] B24 (T-401): found but EDITED in Google => ONE pending update_event from the found content to the approved content -
    // a card, zero writes without a click (F38).
    if (edited && foundContent !== null) offerCorrection(deps, action, payload, eventId, foundContent, approved, now);
  });
  return true;
}

function reconcileSend(deps: ReconcileDeps, action: ApprovalAction): boolean {
  const bridgeDb = deps.bridgeDb;
  const payload = parseFinalPayload(action);
  if (bridgeDb === null || payload === null || payload.kind !== 'send_reply') return false;
  const chat = deps.repos.chats.byId(action.chatId);
  if (!chat) return false;
  const anchor = action.executedAt ?? action.approvedAt;
  if (anchor === null) return false;
  if (!bridgeDb.open()) return false;
  const waMsgId = findOutboundMatch(bridgeDb, chat.jid, payload.text, anchor);
  if (waMsgId === null) return false;
  const now = deps.now();
  const result = { kind: 'send_reply' as const, waMsgId };
  // [I7] ONE transaction, same reason as reconcileCreate: a torn resolution leaves a `done` action whose item row still
  // reads 'draft', which no recovery pass revisits and the next triage turns into a duplicate draft.
  deps.repos.db.transaction(() => {
    deps.repos.actions.markDone(action.id, result, now);
    applySendSuccess(deps.repos, action, payload, now);
    deps.repos.audit.append('action_reconciled', action.id, { kind: 'send_reply', attempt: action.attempt }, now);
  });
  return true;
}

export async function reconcileUnknown(deps: ReconcileDeps): Promise<ReconcileResult> {
  const out: ReconcileResult = { checked: 0, resolvedDone: 0, stillUnknown: 0 };
  for (const id of unknownOutcomeIds(deps.repos)) {
    const action = deps.repos.actions.byId(id);
    if (!action) continue;
    out.checked += 1;
    const resolved =
      action.kind === 'send_reply'
        ? reconcileSend(deps, action)
        : action.kind === 'update_event'
          ? (await reconcileUpdateWith(deps, action)) === 'done'
          : await reconcileCreate(deps, action);
    if (resolved) out.resolvedDone += 1;
    else out.stillUnknown += 1;
  }
  return out;
}

// ======================= [V2 ADD] C2 14 (owner V2-W1-04-exec-auto) =======================

async function readEvent(
  deps: ReconcileDeps,
  calendarId: string,
  eventId: string,
): Promise<OwnedEventProjection | null> {
  const getEvent = deps.read?.getEvent;
  if (getEvent === undefined) return null;
  try {
    const res = await getEvent(calendarId, eventId);
    return res.ok ? res.value : null;
  } catch {
    return null;
  }
}

/** The approved content of a create, cleaned exactly like the builder cleans it (so Google's copy of it compares equal). */
function approvedContentOf(p: CreateEventPayload): EventContentWithStatus {
  return {
    title: normaliseField(p.title, LIMITS.titleChars),
    startLocal: p.startLocal,
    endLocal: p.endLocal,
    timeZone: p.timeZone,
    location: normaliseField(p.location, LIMITS.locationChars),
    status: 'confirmed',
  };
}
function sameApprovedContent(a: EventContentWithStatus, b: EventContentWithStatus): boolean {
  return a.title === b.title && a.startLocal === b.startLocal && a.endLocal === b.endLocal && a.location === b.location;
}

/** B24: the pending update_event of a found-but-edited create (same proposal version; NEVER approved here - a card). */
function offerCorrection(
  deps: ReconcileDeps,
  action: ApprovalAction,
  payload: CreateEventPayload,
  eventId: string,
  found: EventContentWithStatus,
  approved: EventContentWithStatus,
  now: EpochMs,
): void {
  const slotChanged = found.startLocal !== approved.startLocal || found.endLocal !== approved.endLocal;
  const update: UpdateEventPayload = {
    v: 1,
    kind: 'update_event',
    itemId: payload.itemId,
    chatRef: payload.chatRef,
    proposalVersion: payload.proposalVersion,
    targetEventId: eventId,
    targetItemId: action.itemId,
    baseRevision: 1,
    change: slotChanged ? 'reschedule' : 'move',
    from: found,
    to: approved,
  };
  try {
    deps.repos.actions.insertPending({
      itemId: action.itemId,
      proposalId: action.proposalId,
      chatId: action.chatId,
      payload: update,
      now,
    });
  } catch {
    deps.repos.audit.append('db_recovery', action.id, { stage: 'b24_update_offer' }, now);
  }
}

/** One unknown_outcome update_event, read-only: get-event only (never list-events, never a re-patch). */
async function reconcileUpdateWith(
  deps: ReconcileDeps,
  action: ApprovalAction,
): Promise<'done' | 'superseded' | 'unknown_outcome'> {
  const payload = parseFinalPayload(action);
  if (payload === null || payload.kind !== 'update_event' || action.state !== 'unknown_outcome')
    return 'unknown_outcome';
  const target = deps.repos.items.byId(payload.targetItemId);
  if (target !== null && target.eventRevision > payload.baseRevision) {
    // another change of this event landed meanwhile: this one can never apply as approved
    const now = deps.now();
    deps.repos.db
      .prepare(`UPDATE actions SET state = 'superseded' WHERE id = ? AND state = 'unknown_outcome'`)
      .run(action.id);
    deps.repos.audit.append(
      'action_reconciled',
      action.id,
      { kind: 'update_event', attempt: action.attempt, superseded: true },
      now,
    );
    return 'superseded';
  }
  const rb = await readEvent(deps, deps.repos.settings.get().calendar.targetCalendarId, payload.targetEventId);
  if (rb === null) return 'unknown_outcome';
  const root = deps.repos.actions.chainRoot(action.id);
  const applied =
    rb.id === payload.targetEventId &&
    rb.priv.waUpdate === root.id &&
    rb.status === payload.to.status &&
    (payload.to.status === 'cancelled' ||
      (rb.startLocal === payload.to.startLocal && rb.endLocal === payload.to.endLocal));
  if (!applied) return 'unknown_outcome';
  const now = deps.now();
  deps.repos.db.transaction(() => {
    commitUpdateDone(
      deps.repos,
      action,
      payload,
      rb,
      { autoWriteId: autoWriteIdOfAction(deps.repos, action.id), extraReverts: [], auditKind: 'action_reconciled' },
      now,
    );
  });
  return 'done';
}

/** exec/reconcile.ts - get-event only (never list-events, never a re-patch): waUpdate === chain root and status/slot == `to` => done ;
 *  items.event_revision > baseRevision => superseded ; else stays unknown_outcome + pending clone ("Apply again").
 *  B24 (T-401): offerRetryForUnknown on a create: findAppEvent first; found + unedited => done ; found + EDITED => an update_event from the
 *  found content to the edited content ; not found => create retry clone (v1).
 *  [V2-W1-04] The frozen one-argument form has no repository to read: `deps` is an additive optional second argument; without it the
 *  action cannot be resolved and stays unknown_outcome (fail safe - nothing is ever re-sent). */
export async function reconcileUpdate(
  actionId: ActionId,
  deps?: ReconcileDeps,
): Promise<'done' | 'superseded' | 'unknown_outcome'> {
  if (deps === undefined) return 'unknown_outcome';
  const action = deps.repos.actions.byId(actionId);
  if (action === null || action.kind !== 'update_event') return 'unknown_outcome';
  return reconcileUpdateWith(deps, action);
}
