// src/shared/state.ts
import type { Analysis, ReplyState, EventState, ClosedReason, ItemState, ItemStatus } from './types';

export interface StateInputs {
  analysis: Analysis;
  replyState: ReplyState;
  eventState: EventState;
  closedReason: ClosedReason | string | null;
}

/** VERBATIM from ARCHITECTURE section 7 [V2: + ARCH-v2 5.1]. The only writer of items.state is db/repos/items.ts, which calls this on every update. */
export function deriveState(i: StateInputs): ItemState {
  if (i.closedReason) return 'ignored';
  // [V2 CHANGE] updated / cancelled are in_calendar too (a cancelled card leaves 24 h later as closed 'past', like a started event)
  if (i.eventState === 'created' || i.eventState === 'updated' || i.eventState === 'cancelled') return 'in_calendar';
  if (i.analysis !== 'done') return 'needs_reply'; // raw card (listed only when held/failed)
  if (i.eventState === 'incomplete') return 'info_missing';
  // [V2 CHANGE] change_proposed = a pending delta on this (linked) item => the Change card in "Needs reply"
  if (i.replyState === 'draft' || i.eventState === 'proposed' || i.eventState === 'change_proposed')
    return 'needs_reply';
  return 'ignored';
}

/** Renderer-facing status: splits the user's own "Dismiss" out of the hidden bucket. */
export function deriveStatus(i: StateInputs): ItemStatus {
  return i.closedReason === 'dismissed' ? 'dismissed' : deriveState(i);
}

export function isOpen(state: ItemState): boolean {
  return state === 'needs_reply' || state === 'info_missing';
}
/** Dashboard visibility rule (ARCHITECTURE 6.1): queued/running items are counted, not listed. */
export function isListed(analysis: Analysis): boolean {
  return analysis === 'done' || analysis === 'held' || analysis === 'failed';
}
export function cardKind(analysis: Analysis): 'full' | 'raw' {
  return analysis === 'done' ? 'full' : 'raw';
}
