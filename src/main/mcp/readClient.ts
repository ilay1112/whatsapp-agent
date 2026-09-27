// src/main/mcp/readClient.ts   (capability-free types + the READ facade; the only mcp/* file agent/** may import)
// Frozen signatures pasted verbatim from docs/specs/contracts.md (owner W1-05); bodies implemented by W1-05.
import { projectAppEvent, projectCurrentTime, projectFreeBusy } from './projection';
import type { BusyBlock, LocalDateTime, ActionId } from '../../shared/types';

/** The six tools enabled at the MCP server and their class. Anything else in tools/list => CAL_TOOLSET_MISMATCH (fail closed). */
export const MCP_TOOLS = {
  'get-current-time': 'read',
  'get-freebusy': 'read',
  'list-events': 'read',
  'list-calendars': 'admin',
  'manage-accounts': 'admin',
  'create-event': 'write',
} as const;
export type McpToolName = keyof typeof MCP_TOOLS;
export type McpToolClass = (typeof MCP_TOOLS)[McpToolName];
export const ENABLED_TOOLS_ENV =
  'get-current-time,get-freebusy,list-events,list-calendars,create-event,manage-accounts';

export type McpErrorKind =
  'unavailable' | 'auth' | 'port_busy' | 'duplicate' | 'id_exists' | 'timeout' | 'bad_response' | 'invalid_args';
// [R2] 'id_exists' = Google answered 409 "The requested identifier already exists" for our deterministic eventId => the event WAS created by an earlier
//      attempt of the same chain; the executor treats it as done (reconcile fills the details). 'duplicate' = the server's similarity heuristic (CAL_DUPLICATE).
export type McpResult<T> = { ok: true; value: T } | { ok: false; error: McpErrorKind };
/** Tool names of one class. */
export type McpToolNameOf<C extends McpToolClass> = {
  [N in McpToolName]: (typeof MCP_TOOLS)[N] extends C ? N : never;
}[McpToolName];
/** [R2] Raw capability TYPE, NARROWED to one tool class: call one enabled tool of that class. VALUES are produced ONLY by McpHost.callerFor(cls)
 *  (mcp/host.ts), which wraps the SDK client in a function that asserts MCP_TOOLS[tool] === cls at RUN TIME (throws McpCapabilityError + audit
 *  'tool_blocked' otherwise) - so a bug in readClient.ts cannot call 'create-event' even if the type check is bypassed. compose.ts hands
 *  host.callerFor('read') to createMcpReadClient, callerFor('write') to createMcpWriteClient, callerFor('admin') to createMcpAdminClient, nothing else.
 *  Returned text is UNTRUSTED. */
export type McpToolCaller<C extends McpToolClass = McpToolClass> = (
  tool: McpToolNameOf<C>,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<McpResult<{ text: string; isError: boolean }>>;
export class McpCapabilityError extends Error {
  constructor(public readonly cls: McpToolClass) {
    super('mcp_capability');
    this.name = 'McpCapabilityError';
  }
}
export interface McpCallerSource {
  callerFor<C extends McpToolClass>(cls: C): McpToolCaller<C>;
} // implemented by McpHost and by the fake

/** Arguments are ALWAYS app-built. calendarIds / timeZone / account come from settings, never from a model. */
export interface PinnedWindow {
  timeMinLocal: LocalDateTime;
  timeMaxLocal: LocalDateTime;
  timeZone: string;
  calendarIds: string[];
  account: 'personal';
}
export interface CurrentTimeProjection {
  nowIso: string;
  timeZone: string;
}
export interface EventProjection {
  startLocal: LocalDateTime;
  endLocal: LocalDateTime;
  title: string;
} // title sanitised, <= 60 chars, UNTRUSTED
export interface AppEventRef {
  eventId: string;
  htmlLink: string | null;
  startLocal: LocalDateTime;
}

export interface McpReadClient {
  getCurrentTime(): Promise<McpResult<CurrentTimeProjection>>;
  getFreeBusy(w: PinnedWindow): Promise<McpResult<BusyBlock[]>>;
  /** [C+] Reconcile only (exec/reconcile.ts): list-events with privateExtendedProperty ["waAction=<id>"]. Not reachable from ToolGate's name table.
   *  [R2] `id` is the retry-CHAIN root action id (exec/actionExecutor.ts chainRootOf): every clone stamps waAction=<root id>. */
  findAppEvent(chainRootActionId: ActionId, w: PinnedWindow): Promise<McpResult<AppEventRef | null>>;
}
// [R2] `listEvents()` (EventProjection with titles) is REMOVED from the facade with the `list_events` LLM tool; EventProjection stays for reconcile's projection only.

// ---------------------------------------------------------------------------------------------------------------------
// implementation (W1-05)
// ---------------------------------------------------------------------------------------------------------------------

const LOCAL_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const TIME_ZONE_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;
/** Calendar ids come from settings, never from a model; this only keeps a corrupted settings value out of a request. */
const CALENDAR_ID_RE = /^[A-Za-z0-9._%+@#-]{1,256}$/;
/** The chain-root action id is interpolated into a `waAction=<id>` filter string: uuid v4 characters only. */
const ACTION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
/** ARCHITECTURE 5.3: the app clamps the window before it reaches the server; a longer one is a bug upstream, not a request. */
export const MAX_WINDOW_DAYS = 14;
const MS_DAY = 86_400_000;

const INVALID = { ok: false, error: 'invalid_args' } as const;

/** Every PinnedWindow is app-built (settings + clamps). A window that is not is refused before the tool call. */
export function isPinnedWindowValid(w: PinnedWindow): boolean {
  if (w === null || typeof w !== 'object') return false;
  if (!LOCAL_DT_RE.test(w.timeMinLocal) || !LOCAL_DT_RE.test(w.timeMaxLocal)) return false;
  if (w.timeMaxLocal <= w.timeMinLocal) return false;
  if (!TIME_ZONE_RE.test(w.timeZone)) return false;
  if (w.account !== 'personal') return false;
  if (!Array.isArray(w.calendarIds) || w.calendarIds.length === 0 || w.calendarIds.length > 10) return false;
  if (!w.calendarIds.every((id) => typeof id === 'string' && CALENDAR_ID_RE.test(id))) return false;
  // Wall-clock difference is enough for a coarse cap (a DST hour never turns 14 days into 15).
  const span = Date.parse(`${w.timeMaxLocal}Z`) - Date.parse(`${w.timeMinLocal}Z`);
  return Number.isFinite(span) && span <= MAX_WINDOW_DAYS * MS_DAY;
}

/** READ facade. Holds ONE narrowed caller and no other capability: there is no write method and no way to reach one. */
export function createMcpReadClient(call: McpToolCaller<'read'>): McpReadClient {
  return {
    async getCurrentTime() {
      const res = await call('get-current-time', { account: 'personal' });
      return res.ok
        ? res.value.isError
          ? { ok: false, error: 'bad_response' }
          : projectCurrentTime(res.value.text)
        : res;
    },

    async getFreeBusy(w) {
      if (!isPinnedWindowValid(w)) return INVALID;
      const res = await call('get-freebusy', {
        calendars: w.calendarIds.map((id) => ({ id })),
        timeMin: w.timeMinLocal,
        timeMax: w.timeMaxLocal,
        timeZone: w.timeZone,
        account: w.account,
      });
      if (!res.ok) return res;
      if (res.value.isError) return { ok: false, error: 'bad_response' };
      return projectFreeBusy(res.value.text, w.timeZone);
    },

    async findAppEvent(chainRootActionId, w) {
      if (!isPinnedWindowValid(w) || !ACTION_ID_RE.test(String(chainRootActionId))) return INVALID;
      const res = await call('list-events', {
        calendarId: w.calendarIds.length === 1 ? w.calendarIds[0] : w.calendarIds,
        timeMin: w.timeMinLocal,
        timeMax: w.timeMaxLocal,
        timeZone: w.timeZone,
        privateExtendedProperty: [`waAction=${chainRootActionId}`],
        account: w.account,
      });
      if (!res.ok) return res;
      if (res.value.isError) return { ok: false, error: 'bad_response' };
      return projectAppEvent(res.value.text, chainRootActionId, w.timeZone);
    },
  };
}
