# v4-calendar-read — T-908 group C (T4 read, T5 view)

Worker notes, 2026-10-19. Spec: `docs/specs/v4-calendar-handover.md` §2.4 (+ §3). No commit / push.

## State
- Green: `npx vitest run src/shared src/main/mcp src/main/ipc src/renderer` (132 files / 2702 tests at the time of the run),
  `npm run typecheck`, `npm run lint`, `prettier --check .`, `npm run -s build:e2e && npx playwright test tests/e2e/dashboard-v3.spec.ts tests/e2e/approval-first.spec.ts` (9 passed).
- projection.ts (safety-critical) still 100 % lines / 98.6 % branches; calendarEvents.ts 100 % lines.

## What was built
### Main (T4)
- `src/shared/week.ts` (+test): `weekOf`, `shiftWeek`, `firstDayFor`, `addDays`, new `weekWindowOf(anchorMs, firstDay, tz) -> {startMs, timeMinLocal, timeMaxLocal}` (7 local days, end exclusive). Moved verbatim from the renderer store, which re-exports them (`export { firstDayFor, shiftWeek, weekOf } from '@shared/week'`). Week tests moved to `src/shared/week.test.ts`.
- `projection.ts`: NEW `projectListedEvents(text, tz)` (reconcile's `projectEvents` untouched, pinned by a test). Fail closed: odd attendees/recurrence count as present; cancelled instances dropped; one malformed event = bad_response. Attendee COUNT only (cap 999).
- `readClient.ts`: a SEPARATE facade `createMcpCalendarListClient(call: McpToolCaller<'read'>)` -> `McpCalendarListClient.listEventsInWindow(calendarId, {timeMinLocal,timeMaxLocal,timeZone})`. Deliberately NOT on `McpReadClient` (ToolGate/agent hold that one; test asserts its keys are unchanged). `MCP_TOOLS` / `ENABLED_TOOLS_ENV` untouched (I2'). Args: `{calendarId, timeMin, timeMax, timeZone, singleEvents:true, account:'personal'}`; PinnedWindow rules (<= 14 days). Note: the real 2.6.3 server hardcodes `singleEvents: true` and its zod object strips the unknown key — sending it is harmless and documents intent.
- `src/main/mcp/calendarEvents.ts` (+ unit test + `calendarEvents.fakeCalendar.test.ts` over the fake): `CalendarEventsService`.
- `src/main/ipc/handlers/calendar.ts` (+test): `calendar:listEvents`, `calendar:invalidate`. Registered in `register.handlers.ts` (ext `calendarEvents?`) and in `compose.ts` (`createCalendarHandlers({ calendarEvents })`).
- `compose.ts`: service built right after `calendarRoles` (roles = meta.calendar_roles_json, tz = settings, lang = `uiLanguage().lang`, connected = mcpHost status). Replaced group B's TODO: `invalidateCalendar: () => calendarEvents.invalidate()` in `createRefreshService`. Wrapped `action:approve` (kind != send_reply), `item:undoChange`, `item:restoreOriginal`, `item:cancelEvent`, `auto:undo` in `handlers` so each invalidates the cache in `finally`. Automatic writes (no IPC door) rely on the 5-min TTL.
- `ipc.ts`: `calendar:listEvents {anchorMs:int>=0, calendarIds: string(1..256)[1..10]}` -> `CalendarEventsRes` (errors CAL_UNAVAILABLE | CAL_RECONNECT); `calendar:invalidate` NoReq -> null. Also added to `src/preload/index.ts` INVOKE (needed for the renderer), `register.test.ts` sample table, `tests/setup-renderer.ts` IPC_DEFAULTS.
- `types.ts`: `ForeignEventView` (spec shape **+ `eventKey`**, see decisions) and `CalendarEventsRes`.

### Renderer (T5)
- `store/calendarEntries.ts`: union `CalendarEntry = ItemCalendarEntry | ForeignCalendarEntry`; `foreignEntryOf`, `mergeForeignEntries`, `selectCalendarEntries(..., foreign?)` overload, `isForeignEntry`, `hash8` (FNV-1a 32-bit, 8 hex — not sha; renderer has no sync sha256), `calendarHueOf`, `CAL_HUES`, `manageRefusals`.
- `store/calendarView.ts`: `useVisibleCalendars`, `useCalendarView(anchorMs)`, `readVisibleCalendars/writeVisibleCalendars/effectiveVisible`, `VISIBLE_CALENDARS_KEY = 'wca.calendar.visible'` (JSON array of visible ids; absent/unreadable = all; ids gone from the account ignored; > 10 visible -> first 10 read).
- `components/CalendarPicker.tsx` (`CalendarPicker`, `CalendarLegend`, `hueVar`), `components/EventPopover.tsx`, `CalendarWeek.tsx` (foreign blocks, all-day row `cal-allday`, legend, picker, `cal-refresh`, `cal-loading`, `cal-failed` / `cal-failed-<hash8(calendarId)>`). Dashboard.tsx NOT edited: CalendarWeek fetches and merges itself.
- `styles.css`: `--color-cal-0..7` appended to the end of `@theme`; `styles.test.ts` token count 19 -> 19 + 8 (asserts exactly the 8 hue names).
- Locales (en + he): `cal.picker`, `cal.refresh`, `cal.failedFor`, `cal.readOnlyCalendar`, `cal.refusedAttendees`, `cal.refusedRecurring` — all referenced.

## Decisions / assumptions
- `ForeignEventView.eventKey` added (= `sha256('wca-event|'+id)[0:16]`, same as `ItemCard.calendar.eventKey`; `foreignEventKeyOf` pinned equal to `agent/items.eventKeyOf` by a test). Without it the renderer cannot de-dup app-owned events against cards (no sync sha256 in the renderer).
- Calendar ids not in the stored roles (and not `'primary'`) never reach the wire and land in `failed`. `'primary'` without a stored role is read but `writable:false` (fail closed). Roles with `unknown` are dropped by `parseCalendarRolesJson`, so such calendars are not readable from the view.
- Errors: auth on any calendar -> `CAL_RECONNECT`; every calendar unreachable (unavailable/timeout/port_busy) -> `CAL_UNAVAILABLE`; otherwise partial -> `failed`. Failed reads are not cached; a read in flight across `invalidate()` is not cached (generation counter).
- Week: main uses `firstDayFor(uiLanguage().lang)`; the renderer uses `firstDayFor(i18n lang)` — same function, so the same week.
- An event shared into two visible calendars draws twice (once per calendar) and both blocks share the test id `cal-block-f-<hash8(eventId)>` (spec's id). React keys use `calendarId|eventId`.
- Popover is a non-modal dialog rendered above the grid (not anchored to the block); focus goes to its close button and returns to the block on close.

## Open items for the orchestrator
- `cal.scopeNote` ("Shows the chats this app analysed, not your whole Google calendar.") is now false. Not in my key list — reword or drop.
- `docs/specs/contracts.md` / ux.md: new channels, test ids, `ForeignEventView.eventKey` (Task 8).
- Files touched outside the group C list (necessary wiring): `src/preload/index.ts`, `src/main/ipc/register.handlers.ts`, `src/main/ipc/register.test.ts`, `tests/setup-renderer.ts`, `src/renderer/src/styles.test.ts`.

## HAND-OFF for group D (T6/T7)
```ts
// src/shared/types.ts
export interface ForeignEventView { eventId: string; calendarId: string; title: string /* UNTRUSTED <=60 */; startLocal: LocalDateTime;
  endLocal: LocalDateTime; allDay: boolean; attendees: number; recurring: boolean; ownedByApp: boolean; writable: boolean; eventKey: string }
export interface CalendarEventsRes { weekStartMs: EpochMs; events: ForeignEventView[]; fetchedAt: EpochMs; failed: string[] }

// src/renderer/src/store/calendarEntries.ts
export interface ForeignCalendarEntry { state: 'foreign'; itemId: null; card: null; startMs: EpochMs; endMs: EpochMs; title: string;
  eventKey: string; eventId: string; calendarId: string; writable: boolean; attendees: number; recurring: boolean; allDay: boolean; ownedByApp: boolean }
export type CalendarEntry = ItemCalendarEntry | ForeignCalendarEntry;   // ItemCalendarEntry = the v3 shape, unchanged
export const isForeignEntry: (e: CalendarEntry) => e is ForeignCalendarEntry;
export type ManageRefusal = 'readonly' | 'attendees' | 'recurring';
export function manageRefusals(e: ForeignCalendarEntry): ManageRefusal[];   // [] = manageable (UI hint; main must refuse too)
export function hash8(s: string): string; export function calendarHueOf(calendarId: string): number;   // 0..7

// src/renderer/src/components/EventPopover.tsx
export interface EventPopoverProps { entry: ForeignCalendarEntry; calendarName: string /* UNTRUSTED */; hue: number; lang: Lang;
  timeZone: string; onClose(): void; actions?: ReactNode /* EXTENSION POINT: rendered in footer `cal-popover-actions` */ }
// test ids: cal-event-popover (data-attendees / data-recurring / data-writable), cal-popover-close, cal-popover-calendar,
// cal-popover-time, cal-popover-reasons, cal-reason-readonly | cal-reason-attendees | cal-reason-recurring, cal-popover-actions

// src/renderer/src/components/CalendarWeek.tsx — new optional prop (Dashboard does not pass it yet):
renderEventActions?(entry: ForeignCalendarEntry): ReactNode;   // its result becomes EventPopover.actions
// "New event" button: add next to `cal-refresh` (toolbar `ms-auto` group, rendered only when calendars are loaded).
// After a manual write: call `calendar:invalidate` is NOT needed if the write goes through action:approve / an undo door
// (compose invalidates); to redraw, the view must re-read: expose/use `useCalendarView(...).refresh()` (store/calendarView.ts).

// src/main/mcp/calendarEvents.ts
export const CALENDAR_EVENTS_TTL_MS = 300_000; export const MAX_CALENDARS_PER_READ = 10;
export interface CalendarEventsService {
  listEvents(req: { anchorMs: EpochMs; calendarIds: string[] }): Promise<Result<CalendarEventsRes>>;
  invalidate(): void;   // empties cache + drops in-flight joins; compose: refresh, calendar:invalidate, approve/undo doors
}
export function createCalendarEventsService(deps: { list: McpCalendarListClient; roles(): Readonly<Record<string, CalendarAccessRole>>;
  timeZone(): string; lang(): Lang; connected(): boolean; clock: Pick<Clock,'now'>; log: Pick<Logger,'warn'> }): CalendarEventsService;
export function foreignEventKeyOf(eventId: string): string;
// compose.ts: `calendarEvents` const (section 10, after calendarRoles). handlers/calendar.ts: add calendar:propose* to createCalendarHandlers
// (CalendarHandlerDeps currently { calendarEvents?: CalendarEventsService }).

// src/main/mcp/readClient.ts
export interface McpCalendarListClient { listEventsInWindow(calendarId: string, w: ListWindow): Promise<McpResult<ListedEventProjection[]>> }
export function createMcpCalendarListClient(call: McpToolCaller<'read'>): McpCalendarListClient;
```
Fake server seed API (`tests/fakes/fake-mcp-calendar.ts`):
- `v4CalendarSeed(day: 'YYYY-MM-DD', timeZone = 'Asia/Jerusalem') -> { calendars, events }`; `V4_CALENDARS = { primary:'primary' (owner), work:'work@group.calendar.google.com' (writer), holidays:'holidays@group.v.calendar.google.com' (reader) }`; `V4_EVENT_IDS = { plain:'v4plain001' (primary, manageable, location 'Clinic', day 10-11), appOwned:'v4appevt01' (primary, waAgent '1', createdByApp, day 15-16), attendees:'v4attend01' (work, 2 attendees, day+1 09-10), recurring:'v4recur001' (work, recurringEventId 'v4recurbase', day+1 13-13:30), allDay:'v4alldate1' (holidays, day..day+2 exclusive) }` — all base32hex (EVENT_ID_RE).
- In-process: `createFakeMcpCalendar({ calendars: s.calendars, seedEvents: s.events, v2Scenarios })`. e2e: `mcpChild(ctx, label, { calendars: s.calendars, events: s.events, v2Scenarios })` (existing helper writes the `--seed` file).
- `calendars[].accessRole` per calendar (default 'owner'); an `access_role:*` scenario still overrides all.
- Scenarios: `calendar_403` (bare = the LAST calendar, when 2+), `calendar_403:<calendarId>`; also accepted by the control channel (`isV2Scenario`).
- list-events now emits `attendees`, `recurrence`, `recurringEventId`, and all-day seeds (`start: 'YYYY-MM-DD'`) as `{date}`.
- NOT done (group D): `delete-event` handler, FAKE_MCP_TOOLS still eight tools; `structured()`/get-event unchanged.
