// src/main/mcp/calendarEvents.ts - [V4] T-908 group C (handover §2.4): CalendarEventsService, the calendar view's read of every
// calendar of the account for the visible week.
//
// - Main-side only. It holds the McpCalendarListClient facade (one narrowed 'read' caller, the already-enabled 'list-events'),
//   never the model's McpReadClient, and no ToolSpec / ToolGate entry references it: the model's tool table is untouched (I2').
// - Decision 1: events are fetched on demand for the visible week and kept IN MEMORY for at most CALENDAR_EVENTS_TTL_MS; nothing
//   from another calendar is written to disk.
// - The week is the one the renderer draws (shared/week.ts: Sunday first for he, else the locale), in settings.general.timeZone.
// - Cache key (calendarId, weekStartMs). invalidate() (calendar:invalidate, refresh, every executed calendar action) empties it;
//   a read that was in flight across an invalidate() answers its caller but is not cached (generation counter).
// - Partial failure (review focus 5): a calendar that errors lands in `failed` once and is not cached; the others still return.
//   Every calendar unreachable (transport) -> CAL_UNAVAILABLE; an auth failure anywhere -> CAL_RECONNECT.
// - Calendar ids must be in the last list-calendars answer (meta.calendar_roles_json) or 'primary'; anything else never reaches
//   the wire. `writable` = stored role owner|writer ('primary' without a stored role: not writable, fail closed).
// - Logs carry `calendarSha8` and an error kind only - never an id, a title or a name.
import { createHash } from 'node:crypto';
import type {
  CalendarAccessRole,
  CalendarEventsRes,
  EpochMs,
  ForeignEventView,
  Lang,
  Result,
} from '../../shared/types';
import { firstDayFor, weekWindowOf } from '../../shared/week';
import type { Clock, Logger } from '../deps';
import type { ListedEventProjection, McpCalendarListClient, McpErrorKind } from './readClient';

/** Decision 1: other calendars' events stay in memory at most this long. */
export const CALENDAR_EVENTS_TTL_MS = 5 * 60_000;
/** IPC cap (handover §2.4: 1..10 calendar ids per request). */
export const MAX_CALENDARS_PER_READ = 10;
/** Cache entries kept at most (10 calendars x a few weeks of back-and-forth); the oldest go first. */
const MAX_CACHE_ENTRIES = 80;

const WRITABLE_ROLES: ReadonlySet<CalendarAccessRole> = new Set<CalendarAccessRole>(['owner', 'writer']);
/** Failure kinds that mean "the calendar server could not be reached" rather than "this calendar refused". */
const TRANSPORT_KINDS: ReadonlySet<McpErrorKind> = new Set<McpErrorKind>(['unavailable', 'timeout', 'port_busy']);

export interface CalendarEventsReq {
  anchorMs: EpochMs;
  calendarIds: string[];
}
export interface CalendarEventsService {
  /** The week of `anchorMs`, events of every asked calendar (cached), failed ones named in `failed`. Never throws. */
  listEvents(req: CalendarEventsReq): Promise<Result<CalendarEventsRes>>;
  /** Empties the cache (calendar:invalidate, refresh, every executed calendar action). */
  invalidate(): void;
  /** [v4 T6, ARCH-v2 10] The renderer names an event by (calendarId, opaque eventKey); this maps it back to the real id from the
   *  LIVE week cache (TTL respected). null = not (or no longer) cached -> the propose answers CAL_EVENT_GONE and the view re-reads. */
  resolve(calendarId: string, eventKey: string): { eventId: string; allDay: boolean } | null;
}
export interface CalendarEventsDeps {
  list: McpCalendarListClient;
  /** meta.calendar_roles_json of the last list-calendars (adminClient.parseCalendarRolesJson). */
  roles(): Readonly<Record<string, CalendarAccessRole>>;
  /** settings.general.timeZone */
  timeZone(): string;
  /** The resolved UI language (compose uiLanguage().lang) - decides the first day of the week. */
  lang(): Lang;
  /** mcpHost.status() === 'connected' */
  connected(): boolean;
  clock: Pick<Clock, 'now'>;
  log: Pick<Logger, 'warn'>;
  /** [v4 T6] ActionExecutor.manualUndoableFor: the manual action the popover may undo for this event (main-side lookup). */
  undoableFor?: (eventId: string) => string | null;
}

/** Same opaque key as ItemCard.calendar.eventKey (agent/items.ts eventKeyOf; pinned by a test): first 16 hex of
 *  sha256('wca-event|' + id). Lets the renderer drop a foreign copy of an event a card already shows. */
export function foreignEventKeyOf(eventId: string): string {
  return createHash('sha256').update(`wca-event|${eventId}`, 'utf8').digest('hex').slice(0, 16);
}
const sha8 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);

type Read = { ok: true; events: ListedEventProjection[] } | { ok: false; kind: McpErrorKind | 'thrown' };
interface CacheEntry {
  at: EpochMs;
  events: ListedEventProjection[];
}

export function createCalendarEventsService(deps: CalendarEventsDeps): CalendarEventsService {
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<Read>>();
  let generation = 0;

  /** [v4 T6] main-side undo lookup; a throw is "no undo offered" (the read never fails because of it). */
  const undoOf = (eventId: string): string | null => {
    try {
      return deps.undoableFor?.(eventId) ?? null;
    } catch {
      return null;
    }
  };
  const keyOf = (calendarId: string, weekStartMs: EpochMs, timeZone: string): string =>
    `${weekStartMs}|${timeZone}|${calendarId}`;

  const prune = (now: EpochMs): void => {
    for (const [k, e] of cache) if (now - e.at >= CALENDAR_EVENTS_TTL_MS) cache.delete(k);
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
  };

  const readOne = (
    calendarId: string,
    key: string,
    window: { timeMinLocal: string; timeMaxLocal: string; timeZone: string },
  ): Promise<Read> => {
    const running = inFlight.get(key);
    if (running !== undefined) return running;
    const gen = generation;
    const self: { p?: Promise<Read> } = {};
    const p = (async (): Promise<Read> => {
      try {
        // Deferred one tick: even a list client that throws synchronously settles after inFlight.set below.
        const res = await Promise.resolve().then(() => deps.list.listEventsInWindow(calendarId, window));
        if (!res.ok) return { ok: false, kind: res.error };
        if (gen === generation) cache.set(key, { at: deps.clock.now(), events: res.value });
        return { ok: true, events: res.value };
      } catch {
        return { ok: false, kind: 'thrown' };
      } finally {
        if (inFlight.get(key) === self.p) inFlight.delete(key);
      }
    })();
    self.p = p;
    inFlight.set(key, p);
    return p;
  };

  return {
    async listEvents(req) {
      if (!deps.connected()) return { ok: false, error: { code: 'CAL_UNAVAILABLE' } };
      const timeZone = deps.timeZone();
      const window = weekWindowOf(req.anchorMs, firstDayFor(deps.lang()), timeZone);
      const roles = deps.roles();
      const ids = [...new Set(req.calendarIds)].slice(0, MAX_CALENDARS_PER_READ);
      const now = deps.clock.now();
      prune(now);

      const failed: string[] = [];
      const reads: Array<{ calendarId: string; read: Promise<Read> }> = [];
      for (const calendarId of ids) {
        if (calendarId !== 'primary' && !Object.hasOwn(roles, calendarId)) {
          failed.push(calendarId);
          deps.log.warn('calendar.list_unknown_id', { calendarSha8: sha8(calendarId) });
          continue;
        }
        const key = keyOf(calendarId, window.startMs, timeZone);
        const hit = cache.get(key);
        reads.push({
          calendarId,
          read:
            hit !== undefined
              ? Promise.resolve({ ok: true, events: hit.events })
              : readOne(calendarId, key, {
                  timeMinLocal: window.timeMinLocal,
                  timeMaxLocal: window.timeMaxLocal,
                  timeZone,
                }),
        });
      }

      const events: ForeignEventView[] = [];
      const kinds: Array<McpErrorKind | 'thrown'> = [];
      for (const { calendarId, read } of reads) {
        const r = await read;
        if (!r.ok) {
          kinds.push(r.kind);
          failed.push(calendarId);
          deps.log.warn('calendar.list_failed', { calendarSha8: sha8(calendarId), kind: r.kind });
          continue;
        }
        const role = Object.hasOwn(roles, calendarId) ? roles[calendarId] : undefined;
        const writable = role !== undefined && WRITABLE_ROLES.has(role);
        for (const e of r.events) {
          const undoActionId = undoOf(e.eventId);
          events.push({
            calendarId,
            title: e.title,
            startLocal: e.startLocal,
            endLocal: e.endLocal,
            allDay: e.allDay,
            attendees: e.attendees,
            recurring: e.recurring,
            ownedByApp: e.ownedByApp,
            fromChat: e.fromChat,
            location: e.location,
            writable,
            eventKey: foreignEventKeyOf(e.eventId),
            undoActionId,
          });
        }
      }

      if (kinds.includes('auth')) return { ok: false, error: { code: 'CAL_RECONNECT' } };
      if (
        reads.length > 0 &&
        kinds.length === reads.length &&
        kinds.every((k) => k !== 'thrown' && TRANSPORT_KINDS.has(k))
      )
        return { ok: false, error: { code: 'CAL_UNAVAILABLE' } };

      // Stable: by start, then calendar order of the request (the push order above).
      const order = events.map((e, i) => ({ e, i }));
      order.sort((a, b) => (a.e.startLocal < b.e.startLocal ? -1 : a.e.startLocal > b.e.startLocal ? 1 : a.i - b.i));
      return {
        ok: true,
        value: { weekStartMs: window.startMs, events: order.map((o) => o.e), fetchedAt: now, failed },
      };
    },

    invalidate() {
      generation += 1;
      cache.clear();
      inFlight.clear(); // a read started after this never joins one from before it
    },

    resolve(calendarId, eventKey) {
      prune(deps.clock.now());
      for (const [key, entry] of cache) {
        if (!key.endsWith(`|${calendarId}`)) continue;
        const hit = entry.events.find((e) => foreignEventKeyOf(e.eventId) === eventKey);
        if (hit !== undefined) return { eventId: hit.eventId, allDay: hit.allDay };
      }
      return null;
    },
  };
}
