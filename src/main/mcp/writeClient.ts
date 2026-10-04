// src/main/mcp/writeClient.ts   (imported ONLY by compose.ts and, type-only, by exec/**)
// Frozen signatures pasted verbatim from docs/specs/contracts.md (owner W1-05); bodies implemented by W1-05.
// Safety-critical (TESTS 13, 100 % lines): this file is the ONLY path from app code to a calendar write, and it is reachable
// only from ActionExecutor, which runs only from the `action:approve` IPC handler (ARCHITECTURE A10).
import { classifyEventErrorText, projectCreateEvent, projectUpdatedEvent } from './projection';
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
  allowDuplicates: boolean; // false ; true ONLY after an explicit confirmDuplicate click ; [V2] never true on the automatic path
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

/** [V2 ADD] Exhaustive whitelist (ARCH-v2 7). Built ONLY by exec/buildUpdateEventArgs.ts, key by key, never spread. ALWAYS an absolute patch of
 *  all five content fields; the COMPLETE private map with waAgent / waItem / waAction COPIED from the pre-flight get-event (never recomputed;
 *  merge-vs-replace of extendedProperties.private is UNVERIFIED U-E2, the full map is safe either way). Never: attendees, recurrence,
 *  modificationScope, originalStartTime, futureStartDate, calendarsToCheck, conferenceData, attachments, reminders, colorId, visibility,
 *  transparency, guestsCan*, anyoneCanAddSelf. */
export interface UpdateEventArgs {
  calendarId: string; // settings.calendar.targetCalendarId
  account: 'personal';
  eventId: string; // = payload.targetEventId (pinned) ; the builder asserts it equals items.calendar_event_id
  summary: string;
  start: LocalDateTime;
  end: LocalDateTime;
  timeZone: string;
  location: string; // '' is sent as-is (clearing semantics U-E2)
  // [F5] NO description: an update never rewrites the description (the user's own notes in Google survive; undo restores from pre_json)
  status: 'confirmed' | 'cancelled'; // B4 insertion (1)+(2) ; cancel = 'cancelled', undo of a cancel = 'confirmed'
  sendUpdates: 'none'; // builder invariant only: 2.6.3 updateAllInstances does NOT forward it (F21); the control is I9 (no attendees)
  checkConflicts: false; // the executor ran its own fresh free/busy
  ifMatch: string; // B4 insertions (3)+(4)+(5): the pre-flight etag -> If-Match header ; HTTP 412 => McpErrorKind 'precondition'
  extendedProperties: { private: { waAgent: '1'; waItem: string; waAction: string; waUpdate: string; waRev: string } };
  // waUpdate = chain root of THIS update action ; waRev = String(baseRevision + 1)
}
export const UPDATE_EVENT_KEYS = [
  'calendarId',
  'account',
  'eventId',
  'summary',
  'start',
  'end',
  'timeZone',
  'location',
  'status',
  'sendUpdates',
  'checkConflicts',
  'ifMatch',
  'extendedProperties',
] as const satisfies readonly (keyof UpdateEventArgs)[];
export interface UpdateEventResult {
  eventId: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  startLocal: LocalDateTime;
  endLocal: LocalDateTime;
}

export interface McpWriteClient {
  createEvent(args: CreateEventArgs): Promise<McpResult<CreateEventResult>>; // 'duplicate' => CAL_DUPLICATE ; 'id_exists' => done (see section 14)
  /** [V2 ADD] 'precondition' (412) => needs_confirm_drift (manual) / fallback modified_in_google (auto) ; 'not_found' => CAL_EVENT_GONE ;
   *  'invalid_args' => CAL_UPDATE_FAILED ; 'timeout' => unknown_outcome. `done` is decided by the executor's get-event READBACK, not by this result. */
  updateEvent(args: UpdateEventArgs): Promise<McpResult<UpdateEventResult>>;
}

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

const LOCAL_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const TIME_ZONE_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;
const CALENDAR_ID_RE = /^[A-Za-z0-9._%+@#-]{1,256}$/;
/** Google event ids are base32hex, 5-1024 chars (= UpdateEventPayloadSchema.targetEventId). */
const EVENT_ID_RE = /^[a-v0-9]{5,1024}$/;
/** App-authored tag values (uuid / item id / decimal revision). */
const TAG_RE = /^[A-Za-z0-9-]{1,64}$/;
const isStr = (v: unknown): v is string => typeof v === 'string';

/**
 * Defence in depth below exec/buildUpdateEventArgs.ts: an update that is not exactly what C2 11 allows never leaves the app
 * ('invalid_args' => CAL_UPDATE_FAILED). In particular: no If-Match etag => no PATCH at all (B4 / F12 - never an If-Match-less write).
 */
function isValidUpdate(args: UpdateEventArgs): boolean {
  if (args === null || typeof args !== 'object') return false;
  if (!isStr(args.calendarId) || !CALENDAR_ID_RE.test(args.calendarId)) return false;
  if (args.account !== 'personal') return false;
  if (!isStr(args.eventId) || !EVENT_ID_RE.test(args.eventId)) return false;
  if (!isStr(args.summary) || !isStr(args.location)) return false;
  if (!isStr(args.start) || !LOCAL_DT_RE.test(args.start) || !isStr(args.end) || !LOCAL_DT_RE.test(args.end))
    return false;
  if (args.end < args.start) return false;
  if (!isStr(args.timeZone) || !TIME_ZONE_RE.test(args.timeZone)) return false;
  if (args.status !== 'confirmed' && args.status !== 'cancelled') return false;
  if (args.sendUpdates !== 'none' || args.checkConflicts !== false) return false;
  if (!isStr(args.ifMatch) || args.ifMatch.length === 0 || args.ifMatch.length > 256) return false;
  const priv = (args.extendedProperties as { private?: unknown } | undefined)?.private as
    Record<string, unknown> | undefined;
  if (priv === undefined || priv === null || typeof priv !== 'object') return false;
  if (priv.waAgent !== '1') return false;
  return (['waItem', 'waAction', 'waUpdate', 'waRev'] as const).every((k) => isStr(priv[k]) && TAG_RE.test(priv[k]));
}

/** WRITE facade. One narrowed caller, two methods (create + update), no read, no admin and no delete capability. */
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

    // [V2 ADD] update-event (C2 11, ARCH-v2 7): the outbound object is BUILT key by key in UPDATE_EVENT_KEYS order - never spread - so an
    // extra property on the input (a cast, a JSON round-trip) never reaches the wire. Always an absolute patch of the five content fields,
    // status, sendUpdates:'none', checkConflicts:false, the If-Match etag, and the COMPLETE private map. No description (F5).
    async updateEvent(args) {
      if (!isValidUpdate(args)) return { ok: false, error: 'invalid_args' };
      const priv = args.extendedProperties.private;
      const out: Record<string, unknown> = {
        calendarId: args.calendarId,
        account: 'personal',
        eventId: args.eventId,
        summary: args.summary,
        start: args.start,
        end: args.end,
        timeZone: args.timeZone,
        location: args.location,
        status: args.status,
        sendUpdates: 'none',
        checkConflicts: false,
        ifMatch: args.ifMatch,
        extendedProperties: {
          private: {
            waAgent: '1',
            waItem: priv.waItem,
            waAction: priv.waAction,
            waUpdate: priv.waUpdate,
            waRev: priv.waRev,
          },
        },
      };
      const res = await call('update-event', out);
      if (!res.ok) return res;
      if (res.value.isError) return { ok: false, error: classifyEventErrorText(res.value.text) };
      return projectUpdatedEvent(res.value.text, args.eventId, args.timeZone);
    },
  };
}
export type { ActionId, ItemId };
