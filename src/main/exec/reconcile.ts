// src/main/exec/reconcile.ts - resolves unknown_outcome actions read-only (build-plan section 3; owner W1-11). Safety-critical.
// NOTHING here executes a side effect: it only LOOKS for evidence that the side effect already happened (an outbound row in the
// bridge's own messages.db, or a calendar event carrying our chain-root action id) and, when it finds it, marks the action done.
// [R2] A reconcile that fails (MCP down, store missing) leaves the action in `unknown_outcome`; the card keeps offering the clone.
import { LIMITS } from '../../shared/types';
import { epochMsToLocal, localToEpochMs } from '../../shared/when';
import { parseBridgeTs } from '../bridge/timestamps';
import { applyCreateSuccess, applySendSuccess, parseFinalPayload } from './outcome';
import type { Repos } from '../db/index';
import type { BridgeDb } from '../bridge/bridgeDb';
import type { McpReadClient, PinnedWindow } from '../mcp/readClient';
import type { ActionId, ApprovalAction, EpochMs } from '../../shared/types';

export interface ReconcileDeps {
  repos: Repos;
  bridgeDb: Pick<BridgeDb, 'open' | 'outboundAfter' | 'close'> | null; // null when the bridge store does not exist yet
  read: Pick<McpReadClient, 'findAppEvent'> | null; // null when the calendar is not connected
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
  const now = deps.now();
  const result = { kind: 'create_event' as const, eventId: found.value.eventId, htmlLink: found.value.htmlLink };
  // [I7] markDone + the item consequence + the audit are ONE transaction: a `done` action whose item row still says
  // 'proposed' is revisited by no later pass, so the next triage would propose - and offer to create - the event again.
  deps.repos.db.transaction(() => {
    deps.repos.actions.markDone(action.id, result, now);
    applyCreateSuccess(deps.repos, action, payload, result, now);
    deps.repos.audit.append('action_reconciled', action.id, { kind: 'create_event', attempt: action.attempt }, now);
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
    const resolved = action.kind === 'send_reply' ? reconcileSend(deps, action) : await reconcileCreate(deps, action);
    if (resolved) out.resolvedDone += 1;
    else out.stillUnknown += 1;
  }
  return out;
}
