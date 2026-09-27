// src/main/exec/outcome.ts - the item-row consequences of a CONFIRMED side effect (owner W1-11; additive helper, build-plan 1.3 style).
// Shared by exec/actionExecutor.ts (side effect answered straight away) and exec/reconcile.ts (side effect confirmed after a crash),
// so a reconciled action leaves exactly the same item row as a directly executed one. Never executes anything itself.
import { localToEpochMs } from '../../shared/when';
import { ActionPayloadSchema } from '../../shared/schemas';
import type { ActionPayload, CreateEventPayload, SendReplyPayload } from '../../shared/schemas';
import type { ActionResult, ApprovalAction, EpochMs } from '../../shared/types';
import type { Repos } from '../db/index';

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

/** ARCH section 7: a created event moves the item to `in_calendar`; the html link is diagnostics only and never crosses IPC. */
export function applyCreateSuccess(
  repos: Repos,
  action: ApprovalAction,
  payload: CreateEventPayload,
  result: Extract<ActionResult, { kind: 'create_event' }>,
  now: EpochMs,
): void {
  const item = repos.items.byId(action.itemId);
  if (!item) return;
  repos.items.update(
    item.id,
    {
      eventState: 'created',
      errorCode: null,
      calendarEventId: result.eventId,
      calendarHtmlLink: result.htmlLink,
      eventStartTs: localToEpochMs(payload.startLocal, payload.timeZone),
    },
    now,
  );
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
