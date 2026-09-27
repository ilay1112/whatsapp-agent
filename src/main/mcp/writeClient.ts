// src/main/mcp/writeClient.ts   (imported ONLY by compose.ts and, type-only, by exec/**)
// Frozen signatures pasted verbatim from docs/specs/contracts.md (owner W1-05); bodies implemented by W1-05.
// Safety-critical (TESTS 13, 100 % lines): this file is the ONLY path from app code to a calendar write, and it is reachable
// only from ActionExecutor, which runs only from the `action:approve` IPC handler (ARCHITECTURE A10).
import { projectCreateEvent } from './projection';
import type { LocalDateTime, ActionId, ItemId } from '../../shared/types';
import type { McpResult, McpToolCaller } from './readClient';

/** Exact whitelist of ARCHITECTURE 5.4. Built ONLY by exec/buildCreateEventArgs.ts. No index signature, nothing spread from model output. */
export interface CreateEventArgs {
  calendarId: string; // settings.calendar.targetCalendarId
  account: 'personal';
  summary: string; // <= 80, single line, URLs stripped
  start: LocalDateTime;
  end: LocalDateTime;
  timeZone: string;
  location?: string; // <= 120
  description: string; // fixed app template (i18n) ; never model text, never a contact name
  sendUpdates: 'none';
  allowDuplicates: boolean; // false ; true ONLY after an explicit confirmDuplicate click
  // [R2] eventIdFor(chainKey, approvedContent) = first 32 chars of lowercase base32hex(sha256(JSON of the chain key -
  // the idempotency key without ':rN' - plus the approved title/start/end/zone/location). Chain key => a retry of the SAME
  // approved content re-sends the same id (409 instead of a duplicate); content => an EDITED retry gets its own id.
  eventId: string;
  extendedProperties: { private: { waAgent: '1'; waItem: string; waAction: string } }; // [R2] waAction = chain-root action id (same for every retry clone)
}
export interface CreateEventResult {
  eventId: string;
  htmlLink: string | null;
}
export interface McpWriteClient {
  createEvent(args: CreateEventArgs): Promise<McpResult<CreateEventResult>>;
} // 'duplicate' => CAL_DUPLICATE ; 'id_exists' => done (see section 14)

// ---------------------------------------------------------------------------------------------------------------------
// implementation (W1-05)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The exact key list that may reach `create-event`, in the order of ARCHITECTURE 5.4. The outbound object is BUILT from
 * these keys one by one - never spread, never `Object.assign`ed - so an extra property on a `CreateEventArgs` value
 * (a cast, a bug, a JSON round-trip) cannot add `attendees`, `recurrence`, `conferenceData` or `calendarsToCheck`.
 */
export const CREATE_EVENT_KEYS = [
  'calendarId',
  'account',
  'summary',
  'start',
  'end',
  'timeZone',
  'location',
  'description',
  'sendUpdates',
  'allowDuplicates',
  'eventId',
  'extendedProperties',
] as const;

/** WRITE facade. One narrowed caller, one method, no read and no admin capability. */
export function createMcpWriteClient(call: McpToolCaller<'write'>): McpWriteClient {
  return {
    async createEvent(args) {
      const out: Record<string, unknown> = {
        calendarId: args.calendarId,
        account: 'personal',
        summary: args.summary,
        start: args.start,
        end: args.end,
        timeZone: args.timeZone,
        description: args.description,
        sendUpdates: 'none',
        allowDuplicates: args.allowDuplicates === true,
        eventId: args.eventId,
        extendedProperties: {
          private: {
            waAgent: '1',
            waItem: args.extendedProperties.private.waItem,
            waAction: args.extendedProperties.private.waAction,
          },
        },
      };
      if (typeof args.location === 'string' && args.location.length > 0) out.location = args.location;
      const res = await call('create-event', out);
      if (!res.ok) return res;
      return projectCreateEvent(res.value.text);
    },
  };
}
export type { ActionId, ItemId };
