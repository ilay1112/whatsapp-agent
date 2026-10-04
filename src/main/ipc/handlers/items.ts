// src/main/ipc/handlers/items.ts - handlers for the channels below (build-plan section 3; owner W1-13; v2 V2-W1-10-main-platform).
// Bodies return Result<T>, never throw. No business logic: every card, ChatView and phone display is built by ItemService, which is
// also the only place a JID is read. The four v2 item channels carry an itemId (and a revisionId) only - never an event id (C2 19
// item 25): main resolves the event from items.calendar_event_id. The focus gate of the three write channels is register.ts's
// (FOCUS_GATED_CHANNELS); the undo itself is approved through the normal executor by V2-W1-04's Undo, which re-checks everything.
import type { IpcHandlers } from '../../../shared/ipc';
import type { Result } from '../../../shared/types';
import { fail, ok, type HandlerDeps, type ItemsHandlersV2 } from '../register';

export type ItemsChannels =
  | 'dashboard:get'
  | 'dashboard:getIgnored'
  | 'item:get'
  | 'item:dismiss'
  | 'item:restore'
  | 'item:retriage'
  | 'item:setEditing'
  | 'item:completeEvent'
  | 'chat:setPolicy'
  | 'chat:listPolicies'
  // [V2 ADD] C2 8
  | 'item:undoChange'
  | 'item:getImage'
  | 'item:restoreOriginal'
  | 'item:cancelEvent';

/** Event states whose item holds a live, editable Google event (item:cancelEvent, F32). */
const EDITABLE: ReadonlySet<string> = new Set(['created', 'updated']);

export function createItemsHandlers(deps: HandlerDeps, v2?: ItemsHandlersV2): Pick<IpcHandlers, ItemsChannels> {
  /** A missing v2 collaborator is a wiring bug: refuse (INTERNAL) rather than pretend the undo happened. */
  const undoOrRefuse = (channel: string): ItemsHandlersV2['undo'] | null => {
    if (v2 === undefined) {
      deps.log.error('ipc_v2_unwired', { channel });
      return null;
    }
    return v2.undo;
  };
  const refuse = <T>(channel: string, itemId: number, code: 'NOT_FOUND' | 'ACTION_STALE'): Result<T> => {
    deps.audit('ipc_rejected', channel, { itemId, reason: code }, deps.clock.now());
    return fail(code);
  };

  return {
    'dashboard:get': () => ok(deps.items.dashboard()),
    // [R2] "Undo dismiss" drawer: the last 20 items closed with reason 'dismissed', nothing else.
    'dashboard:getIgnored': () => ok(deps.items.ignored()),

    'item:get': (req) => deps.items.detail(req.itemId),
    'item:dismiss': (req) => deps.items.dismiss(req.itemId),
    'item:restore': (req) => deps.items.restore(req.itemId),
    'item:retriage': (req) => deps.items.retriage(req.itemId),
    'item:setEditing': (req) => deps.items.setEditing(req.itemId, req.editing),
    'item:completeEvent': (req) => deps.items.completeEvent(req),

    // chatRef is chats.id - the renderer never sees or sends a JID. [V2] + the {autoPolicy} member (B28).
    'chat:setPolicy': (req) => deps.items.setChatPolicy(req),
    'chat:listPolicies': () => ok(deps.items.listPolicies()),

    /**
     * [V2] B10 / F1: the single undo path. The revision must be the event's undo CANDIDATE and the item must carry that event -
     * a stale card (another undo landed, a newer change applied) is ACTION_STALE here, before the executor is involved.
     * The window (manual 7 d / restore-target start, automatic undo_until) is the Undo service's own check.
     */
    'item:undoChange': async (req) => {
      const item = deps.repos.items.byId(req.itemId);
      if (item === null) return refuse('item:undoChange', req.itemId, 'NOT_FOUND');
      if (item.calendarEventId === null) return refuse('item:undoChange', req.itemId, 'ACTION_STALE');
      const candidate = deps.repos.eventRevisions.undoCandidate(item.calendarEventId);
      // The candidate is looked up by THIS item's event, so "the item carries this event" holds by construction; the candidate's own
      // itemId may be an older card of the chain (W1-04: any card of the event is a door, the executor acts on the current holder).
      if (candidate === null || candidate.id !== req.revisionId)
        return refuse('item:undoChange', req.itemId, 'ACTION_STALE');
      const undo = undoOrRefuse('item:undoChange');
      if (undo === null) return fail('INTERNAL');
      return undo.undoChange(item.id, req.revisionId, 'user');
    },

    /** [V2] B19: the normalised picture of this item as a data URL (<= LIMITS.imageDataUrlMaxBytes); ItemService refuses the rest. */
    'item:getImage': (req) => deps.items.getImage(req.itemId),

    /** [V2] F1 "Restore original": one undo to the oldest un-reverted automatic write since the last user-approved revision. */
    'item:restoreOriginal': async (req) => {
      const item = deps.repos.items.byId(req.itemId);
      if (item === null) return refuse('item:restoreOriginal', req.itemId, 'NOT_FOUND');
      if (item.calendarEventId === null) return refuse('item:restoreOriginal', req.itemId, 'ACTION_STALE');
      if (deps.repos.eventRevisions.unrevertedAutoSpan(item.calendarEventId).length === 0)
        return refuse('item:restoreOriginal', req.itemId, 'ACTION_STALE');
      const undo = undoOrRefuse('item:restoreOriginal');
      if (undo === null) return fail('INTERNAL');
      return undo.restoreOriginal(item.id);
    },

    /** [V2] F32 "Cancel event": only for an item holding a live editable event; approved with 'user' through the section 14 gates. */
    'item:cancelEvent': async (req) => {
      const item = deps.repos.items.byId(req.itemId);
      if (item === null) return refuse('item:cancelEvent', req.itemId, 'NOT_FOUND');
      if (item.calendarEventId === null || !EDITABLE.has(item.eventState) || item.closedReason !== null)
        return refuse('item:cancelEvent', req.itemId, 'ACTION_STALE');
      const undo = undoOrRefuse('item:cancelEvent');
      if (undo === null) return fail('INTERNAL');
      return undo.cancelEvent(item.id);
    },
  };
}
