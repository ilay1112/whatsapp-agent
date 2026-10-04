// src/main/mcp/projection.ts - fail-closed projection of MCP result text to typed app values (owner W1-05). Safety-critical (TESTS 13).
// The MCP server's response text is UNTRUSTED (event titles and descriptions are written by other people; a calendar invite is a
// known indirect prompt-injection vector). NOTHING raw leaves this module: every exported function returns typed app values or
// {ok:false,'bad_response'}. No logging, no error text pass-through, no free-text field survives.
// [C7] The wire shapes below are the ASSUMED shapes of @cocal/google-calendar-mcp 2.6.3 (ARCH V4 is UNVERIFIED). They are
// deliberately tolerant about *container* shape (text block vs bare JSON, `events` vs array) and strict about *values*.
import { epochMsToLocal } from '../../shared/when';
import { stripInvisible } from '../../shared/schemas';
import type { BusyBlock } from '../../shared/types';
import type {
  AppEventRef,
  CurrentTimeProjection,
  EventProjection,
  McpErrorKind,
  McpResult,
  OwnedEventProjection,
} from './readClient';
import type { UpdateEventResult } from './writeClient';

// ---------------------------------------------------------------------------------------------------------------------
// limits and shared helpers
// ---------------------------------------------------------------------------------------------------------------------

/** EventProjection.title cap (CONTRACTS 11). */
export const TITLE_MAX = 60;
/** A server text longer than this is never parsed (a 10 MB "event list" is not a response we act on). */
export const RESULT_TEXT_MAX = 512 * 1024;
/** Busy blocks / events we keep from one response; a longer list is a malformed response, not a calendar. */
export const MAX_ITEMS = 500;

const BAD = { ok: false, error: 'bad_response' } as const;
const LOCAL_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** RFC 3339 instant with an explicit offset or Z - the only form we convert through a time zone. */
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$/;
const TIME_ZONE_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** JSON.parse of a server text block; anything that is not a finite-size object/array is a bad response. */
function parseJson(text: string): Json | unknown[] | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > RESULT_TEXT_MAX) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(value)) return value;
  return isObject(value) ? value : null;
}

/** Reads a string property without letting `toString` of a hostile object run. */
function str(o: Json, key: string): string | null {
  const v = o[key];
  return typeof v === 'string' ? v : null;
}

/**
 * Wire time -> LocalDateTime in `timeZone`.
 * Accepted: an RFC 3339 instant (converted through the pinned zone), an already-local `YYYY-MM-DDTHH:mm:ss`
 * (taken as wall clock, the server was asked for that zone) and an all-day `YYYY-MM-DD` (midnight).
 */
export function wireToLocal(value: unknown, timeZone: string): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  if (INSTANT_RE.test(value)) {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) return null;
    return epochMsToLocal(ms, timeZone);
  }
  if (LOCAL_DT_RE.test(value)) return value;
  if (ISO_DATE_RE.test(value)) return `${value}T00:00:00`;
  return null;
}

/** Google event time: `{dateTime, timeZone?}` | `{date}` | a bare string. */
function eventTime(value: unknown, timeZone: string): string | null {
  if (typeof value === 'string') return wireToLocal(value, timeZone);
  if (!isObject(value)) return null;
  const dateTime = str(value, 'dateTime');
  if (dateTime !== null) return wireToLocal(dateTime, timeZone);
  const date = str(value, 'date');
  return date === null ? null : wireToLocal(date, timeZone);
}

/** UNTRUSTED text -> one safe line of at most TITLE_MAX characters (invisible/bidi controls removed). */
export function sanitiseTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return stripInvisible(raw).replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
}

/** Only an https link on a Google host survives; anything else becomes null (never opened, never shown). */
export function safeHtmlLink(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  return host === 'google.com' || host.endsWith('.google.com') ? u.toString() : null;
}

/** Unwraps the containers the server may use: `{content:[{type:'text',text}]}`, `{result:...}` or the value itself. */
function listOf(value: Json | unknown[], key: string): unknown[] | null {
  if (Array.isArray(value)) return value;
  const direct = value[key];
  if (Array.isArray(direct)) return direct;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// exported projections (frozen signatures)
// ---------------------------------------------------------------------------------------------------------------------

/** Server text (UNTRUSTED JSON inside a text block) -> BusyBlock[] in the pinned time zone; garbage => {ok:false,'bad_response'}. */
export function projectFreeBusy(text: string, timeZone: string): McpResult<BusyBlock[]> {
  const root = parseJson(text);
  if (root === null || !TIME_ZONE_RE.test(timeZone)) return BAD;
  // Shape A: Google free/busy - {calendars: {<id>: {busy: [{start,end}], errors?: []}}}. Shape B: {busy: [...]}. Shape C: [...].
  const groups: unknown[][] = [];
  if (!Array.isArray(root) && isObject(root.calendars)) {
    for (const entry of Object.values(root.calendars)) {
      if (!isObject(entry)) return BAD;
      // A calendar the server could not read must never be projected as "free".
      if (Array.isArray(entry.errors) && entry.errors.length > 0) return BAD;
      const busy = entry.busy;
      if (!Array.isArray(busy)) return BAD;
      groups.push(busy);
    }
  } else {
    const busy = listOf(root, 'busy');
    if (busy === null) return BAD;
    groups.push(busy);
  }
  const blocks: BusyBlock[] = [];
  for (const group of groups) {
    if (group.length > MAX_ITEMS) return BAD;
    for (const raw of group) {
      if (!isObject(raw)) return BAD;
      const startLocal = wireToLocal(raw.start, timeZone);
      const endLocal = wireToLocal(raw.end, timeZone);
      if (startLocal === null || endLocal === null || endLocal < startLocal) return BAD;
      blocks.push({ startLocal, endLocal });
    }
  }
  blocks.sort((a, b) => (a.startLocal < b.startLocal ? -1 : a.startLocal > b.startLocal ? 1 : 0));
  return { ok: true, value: blocks };
}

export function projectCurrentTime(text: string): McpResult<CurrentTimeProjection> {
  const root = parseJson(text);
  if (root === null || Array.isArray(root)) return BAD;
  const raw = str(root, 'currentTime') ?? str(root, 'nowIso') ?? str(root, 'now');
  const zone = str(root, 'timeZone');
  if (raw === null || zone === null || !TIME_ZONE_RE.test(zone)) return BAD;
  if (!INSTANT_RE.test(raw)) return BAD;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return BAD;
  return { ok: true, value: { nowIso: new Date(ms).toISOString(), timeZone: zone } };
}

/** list-events text -> sanitised projections (title <= 60 chars, invisible chars stripped). Used by reconcile only. */
export function projectEvents(text: string, timeZone: string): McpResult<EventProjection[]> {
  const root = parseJson(text);
  if (root === null || !TIME_ZONE_RE.test(timeZone)) return BAD;
  const items = listOf(root, 'events') ?? listOf(root, 'items');
  if (items === null || items.length > MAX_ITEMS) return BAD;
  const out: EventProjection[] = [];
  for (const raw of items) {
    if (!isObject(raw)) return BAD;
    const startLocal = eventTime(raw.start, timeZone);
    const endLocal = eventTime(raw.end, timeZone);
    if (startLocal === null || endLocal === null) return BAD;
    // description, location, attendees, htmlLink, organiser, conferencing and every other field are dropped here.
    out.push({ startLocal, endLocal, title: sanitiseTitle(raw.summary) });
  }
  return { ok: true, value: out };
}

/** list-events text filtered by privateExtendedProperty waAction=<chainRootActionId> -> the app's own event or null. */
export function projectAppEvent(
  text: string,
  chainRootActionId: string,
  timeZone: string,
): McpResult<AppEventRef | null> {
  const root = parseJson(text);
  if (root === null || !TIME_ZONE_RE.test(timeZone)) return BAD;
  if (typeof chainRootActionId !== 'string' || chainRootActionId.length === 0) return BAD;
  const items = listOf(root, 'events') ?? listOf(root, 'items');
  if (items === null || items.length > MAX_ITEMS) return BAD;
  let best: AppEventRef | null = null;
  for (const raw of items) {
    if (!isObject(raw)) return BAD;
    const ext = raw.extendedProperties;
    const priv = isObject(ext) && isObject(ext.private) ? ext.private : null;
    // The server filter is a request, not a guarantee: the tag is re-checked here before an event is called ours.
    if (priv === null || priv.waAction !== chainRootActionId || priv.waAgent !== '1') continue;
    const eventId = str(raw, 'id') ?? str(raw, 'eventId');
    const startLocal = eventTime(raw.start, timeZone);
    if (eventId === null || eventId.length === 0 || eventId.length > 1024 || startLocal === null) return BAD;
    const ref: AppEventRef = { eventId, htmlLink: safeHtmlLink(raw.htmlLink), startLocal };
    if (best === null || ref.startLocal < best.startLocal) best = ref;
  }
  return { ok: true, value: best };
}

// [R2] Duplicate / id_exists detection. Both are answers about OUR OWN request, so they are matched on the server's
// wording; nothing else about the text is trusted and the text itself never leaves this module.
const DUPLICATE_RE = /\bduplicate|similar event/i;
const ID_EXISTS_RE = /already exists|duplicate id|requested identifier/i;

/** create-event text -> { eventId, htmlLink }; 'duplicate' / 'id_exists' detection lives here too. */
export function projectCreateEvent(text: string): McpResult<{ eventId: string; htmlLink: string | null }> {
  if (typeof text !== 'string' || text.length > RESULT_TEXT_MAX) return BAD;
  // 409 on our deterministic eventId: the event exists from an earlier attempt of the same chain (executor => done).
  if (ID_EXISTS_RE.test(text)) return { ok: false, error: 'id_exists' };
  const root = parseJson(text);
  if (root === null || Array.isArray(root)) {
    return DUPLICATE_RE.test(text) ? { ok: false, error: 'duplicate' } : BAD;
  }
  const duplicates = root.duplicates;
  if ((Array.isArray(duplicates) && duplicates.length > 0) || DUPLICATE_RE.test(text)) {
    return { ok: false, error: 'duplicate' };
  }
  const event = isObject(root.event) ? root.event : root;
  const eventId = str(event, 'id') ?? str(event, 'eventId');
  if (eventId === null || eventId.length === 0 || eventId.length > 1024) return BAD;
  return { ok: true, value: { eventId, htmlLink: safeHtmlLink(event.htmlLink) } };
}

// =====================================================================================================================
// [V2] get-event / update-event (V2-W1-02; C2 11). Same rules: typed values out, raw text never leaves this module.
// =====================================================================================================================

/** OwnedEventProjection caps (C2 11). */
export const SUMMARY_MAX = 80;
export const LOCATION_MAX = 120;
/** A private-map tag value the app wrote is a short ASCII token (uuid / number / '1'); anything else is projected as null. */
const TAG_RE = /^[\x21-\x7e]{1,128}$/;
const ETAG_RE = /^[\x20-\x7e]{1,256}$/;
/** The fields every get-event call passes (C2 11: the server's defaults omit most of them; 'etag' exists only in the PATCHED bundle). */
export const GET_EVENT_FIELDS = [
  'etag',
  'updated',
  'sequence',
  'status',
  'creator',
  'organizer',
  'attendees',
  'recurrence',
  'recurringEventId',
  'extendedProperties',
] as const;

/** C2 11 "Vendored patch contract": the 412 text of B4 insertion (5) on OUR OWN update-event request. */
export const PRECONDITION_RE = /precondition failed|\b412\b/i;
/** 404 / 410 / "deleted" on OUR OWN get-event / update-event request (GetEventHandler "Event with ID ... not found", 404 "Resource not
 *  found", 410 "Resource has been deleted"). */
export const NOT_FOUND_RE = /not found|\b404\b|\b410\b|\bdeleted\b/i;
/** The SDK's input validation / Google's 400 on our own arguments. */
const INVALID_ARGS_RE = /input validation error|invalid arguments|bad request|\b400\b/i;

/** Error TEXT of our own get-event / update-event request -> the McpErrorKind of C2 11 (order: 412, not found, invalid, other). */
export function classifyEventErrorText(text: string): McpErrorKind {
  if (typeof text !== 'string' || text.length > RESULT_TEXT_MAX) return 'bad_response';
  if (PRECONDITION_RE.test(text)) return 'precondition';
  if (NOT_FOUND_RE.test(text)) return 'not_found';
  if (INVALID_ARGS_RE.test(text)) return 'invalid_args';
  return 'bad_response';
}

/**
 * F12: the UNPATCHED 2.6.3 bundle rejects `fields: [..., 'etag']` in its zod enum. That error text on OUR OWN get-event is the signal that
 * B4 insertion (6) is missing - the host then disables the update surface (never an If-Match-less PATCH).
 */
export function isEtagFieldRejection(text: string): boolean {
  if (typeof text !== 'string' || text.length > RESULT_TEXT_MAX) return false;
  // zod 4 lists the ALLOWED options, not the refused value ("Invalid option: expected one of "id"|... at fields[0]"): every other field
  // the app requests exists in 2.6.3, so a validation error about `fields` whose allowed list lacks "etag" is exactly insertion 6 missing.
  if (!/invalid|validation|allowed/i.test(text)) return false;
  if (!/\bfields\b|\betag\b/.test(text)) return false;
  return !/"etag"/.test(text);
}

/** get-event success text -> does the projected event carry an etag? null = not a parsable event (no decision). */
export function eventTextHasEtag(text: string): boolean | null {
  const root = parseJson(text);
  if (root === null || Array.isArray(root)) return null;
  const event = isObject(root.event) ? root.event : root;
  if (str(event, 'id') === null) return null;
  const etag = str(event, 'etag');
  return etag !== null && ETAG_RE.test(etag);
}

/** UNTRUSTED text -> one safe line of at most `max` characters (invisible/bidi controls removed). */
function cleanLine(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  return stripInvisible(raw).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** wireToLocal that never throws on a zone the regex admits but Intl does not know. */
function safeLocal(value: string, timeZone: string): string | null {
  try {
    return wireToLocal(value, timeZone);
  } catch {
    return null;
  }
}

/** Google event time `{dateTime|date, timeZone?}` or a bare string -> LocalDateTime in `timeZone`. */
function eventTimeIn(value: unknown, timeZone: string): string | null {
  if (typeof value === 'string') return safeLocal(value, timeZone);
  if (!isObject(value)) return null;
  const raw = str(value, 'dateTime') ?? str(value, 'date');
  return raw === null ? null : safeLocal(raw, timeZone);
}

function tagOf(priv: Json | null, key: string): string | null {
  if (priv === null) return null;
  const v = priv[key];
  return typeof v === 'string' && TAG_RE.test(v) ? v : null;
}

const STATUSES = ['confirmed', 'tentative', 'cancelled'] as const;
type EventStatus = (typeof STATUSES)[number];
const statusOf = (raw: unknown): EventStatus | null =>
  typeof raw === 'string' && (STATUSES as readonly string[]).includes(raw) ? (raw as EventStatus) : null;

/** Present and not an empty array (fail closed: a foreign event must never look attendee- or recurrence-free). */
const presentNonEmpty = (v: unknown): boolean => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);

/**
 * get-event text -> OwnedEventProjection of exactly `expectedEventId` (another id = bad_response). The zone is the event's own
 * `start.timeZone` (the app always creates with one); an event without a known zone is not projected (fail closed).
 * summary/location are cleaned + capped and stay UNTRUSTED; tags are short ASCII tokens or null; description, attendee e-mails,
 * links, conference data and every other field are dropped here.
 */
export function projectOwnedEvent(text: string, expectedEventId: string): McpResult<OwnedEventProjection> {
  const root = parseJson(text);
  if (root === null || Array.isArray(root)) return BAD;
  const event = isObject(root.event) ? root.event : root;
  const id = str(event, 'id');
  if (id === null || id !== expectedEventId) return BAD;
  const status = statusOf(event.status);
  if (status === null) return BAD;
  const zone =
    (isObject(event.start) ? str(event.start, 'timeZone') : null) ??
    (isObject(event.end) ? str(event.end, 'timeZone') : null);
  if (zone === null || !TIME_ZONE_RE.test(zone)) return BAD;
  const startLocal = eventTimeIn(event.start, zone);
  const endLocal = eventTimeIn(event.end, zone);
  if (startLocal === null || endLocal === null || endLocal < startLocal) return BAD;
  const etag = str(event, 'etag');
  const updated = str(event, 'updated');
  const seq = event.sequence;
  const recurringEventId = str(event, 'recurringEventId');
  const ext = isObject(event.extendedProperties) ? event.extendedProperties : null;
  const priv = ext !== null && isObject(ext.private) ? ext.private : null;
  return {
    ok: true,
    value: {
      id,
      status,
      startLocal,
      endLocal,
      timeZone: zone,
      summary: cleanLine(event.summary, SUMMARY_MAX),
      location: cleanLine(event.location, LOCATION_MAX),
      etag: etag !== null && ETAG_RE.test(etag) ? etag : null,
      updated: updated !== null && INSTANT_RE.test(updated) ? updated : null,
      sequence: typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : null,
      creatorSelf: isObject(event.creator) && event.creator.self === true,
      organizerSelf: isObject(event.organizer) && event.organizer.self === true,
      hasAttendees: presentNonEmpty(event.attendees),
      hasRecurrence: presentNonEmpty(event.recurrence) || (recurringEventId !== null && recurringEventId.length > 0),
      priv: {
        waAgent: tagOf(priv, 'waAgent'),
        waItem: tagOf(priv, 'waItem'),
        waAction: tagOf(priv, 'waAction'),
        waUpdate: tagOf(priv, 'waUpdate'),
        waRev: tagOf(priv, 'waRev'),
      },
    },
  };
}

/** update-event success text -> UpdateEventResult of exactly `expectedEventId`, times in the zone the app wrote. */
export function projectUpdatedEvent(
  text: string,
  expectedEventId: string,
  timeZone: string,
): McpResult<UpdateEventResult> {
  const root = parseJson(text);
  if (root === null || Array.isArray(root) || !TIME_ZONE_RE.test(timeZone)) return BAD;
  const event = isObject(root.event) ? root.event : root;
  const eventId = str(event, 'id');
  if (eventId === null || eventId !== expectedEventId) return BAD;
  const status = statusOf(event.status);
  if (status === null) return BAD;
  const startLocal = eventTimeIn(event.start, timeZone);
  const endLocal = eventTimeIn(event.end, timeZone);
  if (startLocal === null || endLocal === null || endLocal < startLocal) return BAD;
  // conflicts / warnings (free text about OTHER events) are dropped: the executor ran its own free/busy.
  return { ok: true, value: { eventId, status, startLocal, endLocal } };
}
