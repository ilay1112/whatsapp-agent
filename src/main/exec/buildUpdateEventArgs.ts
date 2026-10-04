// src/main/exec/buildUpdateEventArgs.ts   ADD (C2 14) - owner V2-W1-04-exec-auto. Safety-critical (T2 13: 100/95/100).
// The ONLY builder of UpdateEventArgs (ARCH-v2 7): key by key from UPDATE_EVENT_KEYS, never spread, never a `description` (F5), never
// attendees / recurrence / reminders / conference data. The three identity tags are COPIED from the pre-flight get-event (never recomputed);
// waUpdate = the chain root of THIS update action, waRev = baseRevision + 1. `sendUpdates:'none'` is a builder invariant (F21).
import { LIMITS } from '../../shared/types';
import type { ActionId } from '../../shared/types';
import type { UpdateEventPayload } from '../../shared/schemas';
import type { Settings } from '../../shared/settings';
import type { UpdateEventArgs } from '../mcp/writeClient';
import { normaliseField } from './eventContent';

/** Thrown before the write-ahead when the pre-flight identity is not the app's (the executor maps it to CAL_EVENT_FOREIGN / EVENT_INVALID). */
export class UpdateArgsError extends Error {
  constructor(readonly problem: 'identity' | 'etag') {
    super(`update_args_${problem}`);
    this.name = 'UpdateArgsError';
  }
}

/** exec/buildUpdateEventArgs.ts - key by key from UPDATE_EVENT_KEYS ; identity tags copied from the pre-flight read. */
export function buildUpdateEventArgs(
  p: UpdateEventPayload,
  chain: { rootActionId: ActionId; chainKey: string },
  preflight: { etag: string; priv: { waAgent: string | null; waItem: string | null; waAction: string | null } },
  settings: Settings,
  opts: { descriptionTemplate: string },
): UpdateEventArgs {
  void opts; // [F5] an update never carries a description: the template is accepted for signature parity with create and ignored.
  const { waAgent, waItem, waAction } = preflight.priv;
  if (waAgent !== '1' || waItem === null || waItem === '' || waAction === null || waAction === '') {
    throw new UpdateArgsError('identity');
  }
  if (typeof preflight.etag !== 'string' || preflight.etag === '') throw new UpdateArgsError('etag');
  const to = p.to;
  return {
    calendarId: settings.calendar.targetCalendarId,
    account: 'personal',
    eventId: p.targetEventId,
    summary: normaliseField(to.title, LIMITS.titleChars),
    start: to.startLocal,
    end: to.endLocal,
    timeZone: to.timeZone,
    location: normaliseField(to.location, LIMITS.locationChars),
    status: to.status,
    sendUpdates: 'none',
    checkConflicts: false,
    ifMatch: preflight.etag,
    extendedProperties: {
      private: {
        waAgent: '1',
        waItem,
        waAction,
        waUpdate: chain.rootActionId,
        waRev: String(p.baseRevision + 1),
      },
    },
  };
}
