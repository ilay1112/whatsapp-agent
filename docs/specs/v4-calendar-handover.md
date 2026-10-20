# v4: refresh, sticky shell, theme switch, all calendars + manual management — spec + plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (one fresh Opus implementer per task group, one fresh reviewer at the end). Steps use `- [ ]` checkboxes. Planned by Fable 5.1 on 2026-10-19 from the user's request and the option-dialog answers in §1. Ticket: T-908. Decision: D-089.

**Goal:** (1) a Refresh button that pulls new messages, re-analyses recent chats and re-fetches calendar events; (2) menus that stay put while scrolling; (3) a dark / light / system theme switch; (4) the calendar view shows every calendar of the Google account for the visible week, and the user can create, move, edit and delete events there — through the same approval + undo machinery, with the AI never involved.

**Architecture:** (1) is a main-side `dashboard:refreshNow` over the existing ingest scan + triage queue + rate buckets. (2) is a shell layout change (fixed-height column, inner scroll). (3) is one setting + `data-theme` + `nativeTheme`. (4) adds a main-only read (`list-events` per calendar for a ≤14-day window — the model's tool table is untouched, I2′ holds), a `calendar:*` IPC family that creates *user-authored* pending actions (`source:'manual'`, no chat, no item), executed only by the existing `action:approve` click, with pre-write snapshots in `event_revisions` and undo. `delete-event` becomes an enabled server tool for manual actions only. Invariant I9 is replaced by I9′ (§3).

**Tech stack:** Electron 44, React 19, TS, zustand, i18next, Tailwind v4 `@theme` tokens in `src/renderer/src/styles.css`, Vitest + jsdom, Playwright `_electron` (`tests/e2e`), fake calendar server `tests/fakes/fake-mcp-calendar.ts`.

**Spec:** §1–§3. **Plan:** §4. Read both before a task. Survey facts (file:line) are in the task briefs.

---

## 1. Decisions (user, option dialogs 2026-10-19)
| # | Decision |
|---|---|
| 1 | Other calendars' events are **fetched on demand for the visible week**, kept in memory ≤ 5 min; nothing from other calendars is written to disk. |
| 2 | **Full management** of events on any calendar from the calendar view: create, move/reschedule, edit title/location/duration, delete — each through the approval path with undo. Hard refusals stay: events **with attendees** and **recurring** events are never modified or deleted (I9′). The AI and automatic mode never gain any of this. |
| 3 | Refresh = pull new messages + analyse unanalysed chats **+ re-analyse chats active in the last 24 h**, inside the existing rate limits; in-calendar items stay refused. |
| 4 | Sticky: app header, setup strip, dashboard toolbar, Settings section nav. Theme: `system` default. (Orchestrator decisions, approved with the design.) |

## 2. Behaviour

### 2.1 Refresh (`refresh-now`, dashboard toolbar, both views)
- IPC `dashboard:refreshNow` (NoReq) → `RefreshReport { newRows: number; queued: number; skippedRateLimited: number; skippedInCalendar: number; calendarRefreshed: boolean }`.
- Main: `ingest.scanNow()` (await the scan: `src/main/bridge/ingest.ts:501`), then for every chat with a message in the last 24 h (`LIMITS.syncMaxAgeMs`), newest first, cap 20 chats per press: open item in `needs_reply`/`info_missing` → `items.retriage` semantics (`src/main/agent/items.ts:595`: `RATE_LIMIT_RETRIAGE` → counted as `skippedRateLimited`, `in_calendar` → `skippedInCalendar`); no open item → `repos.queue.enqueue(chatId)` + `queue.poke()` so the orchestrator re-reads the chat's recent rows. Global bucket `llm_global` (60/h) and the CLI `maxRunsPerHour` are respected by the existing stage0 checks — the report counts what the queue accepted, not what the model will run. Then invalidate the calendar cache (§2.4) and push `dashboard:changed`.
- Cooldown 30 s (main-side; a second call inside it returns the last report with `cooldown: true`). Renderer: spinner + disabled while pending, toast `t('refresh.done', {newRows, queued, skipped})` or `t('refresh.cooldown')`.
- Audit: `refresh_now {newRows, queued, skippedRateLimited}`.

### 2.2 Sticky shell
- `App.tsx` root: `h-full overflow-hidden flex flex-col` (today `min-h-full`, so the document scrolls — survey §2). Header (`h-12 shrink-0`) and `SetupStrip` stay in normal flow at the top; the content wrapper gets `min-h-0 grow overflow-y-auto` and is the ONLY scroller (`data-testid="app-scroll"`).
- Dashboard: `dash-toolbar` → `sticky inset-block-start-0 z-10 bg-canvas`; the three columns keep their own `overflow-y-auto`. Settings: the `<nav>` is already sticky; `<main>` drops `overflow-auto` (the app scroller owns it) and the nav's `top-0` becomes `inset-block-start-0`.
- Static test: `Dashboard.static.test.ts` keeps rejecting physical properties; add `App.tsx` to its `OWNED` list.
- e2e (`i18n-rtl.spec.ts` 420 px pass): after scrolling the dashboard to the bottom, `header` and `dash-toolbar` bounding boxes are unchanged; same in Settings for the nav; no horizontal scroll.

### 2.3 Theme
- `settings.general.theme: 'system' | 'light' | 'dark'` (default `system`), in `SettingsSchema`, `SettingsPatchSchema.general` and `DEFAULT_SETTINGS` (`src/shared/settings.ts:49-54, 99, 146-152`).
- Renderer: `applyDocumentTheme(theme)` sets `document.documentElement.dataset.theme` to `light`/`dark` or removes it for `system`; called at boot from the loaded settings and on change. `styles.css`: the dark block stays under `@media (prefers-color-scheme: dark)` but guarded with `:root:not([data-theme='light'])`, plus a copy under `:root[data-theme='dark']`; `color-scheme` follows (`light`, `dark`, or `light dark`). `styles.test.ts:94` (the media query must exist) stays true.
- Header: `ThemeToggle` (new component, same radiogroup pattern as `LanguageToggle.tsx`, test id `theme-toggle`, options `theme-system|theme-light|theme-dark`, icons sun / moon / auto from the closed icon list — add two ids to `docs/specs/v2-ux.md` §1.3 if missing). It calls `setSettings({ general: { theme } })` like the language toggle does (`App.tsx:479-488`, the documented header exception). Settings > General gets a radio row `settings-theme`.
- Main: on settings load and on every `settings:set` that changes `general.theme`, `nativeTheme.themeSource = theme` (`'system'|'light'|'dark'`), so native dialogs and scrollbars match; log `ui.theme {theme}`.
- Locale keys: `theme.system` "System" / "לפי המערכת", `theme.light` "Light" / "בהיר", `theme.dark` "Dark" / "כהה", `settings.general.themeLabel` "Appearance" / "מראה".

### 2.4 All calendars in the calendar view (read)
- `src/shared/types.ts`:
  ```ts
  export interface ForeignEventView { eventId: string; calendarId: string; title: string /* UNTRUSTED, <= 60 */; startLocal: LocalDateTime; endLocal: LocalDateTime; allDay: boolean; attendees: number; recurring: boolean; ownedByApp: boolean; writable: boolean }
  export interface CalendarEventsRes { weekStartMs: EpochMs; events: ForeignEventView[]; fetchedAt: EpochMs; failed: string[] /* calendar ids that errored */ }
  ```
- IPC `calendar:listEvents { anchorMs: EpochMs; calendarIds: string[] (1..10, each in the last list-calendars result or 'primary') }` → `CalendarEventsRes`; `calendar:invalidate` (NoReq) clears the cache.
- Main `CalendarEventsService` (new `src/main/mcp/calendarEvents.ts`): computes the local week of `anchorMs` (Sunday-first for `he`, else locale; reuse `weekOf` logic — move the pure helpers from `src/renderer/src/store/calendarEntries.ts` to `src/shared/week.ts` so main and renderer share them), calls `read.listEventsInWindow(calendarId, window)` per calendar (new facade method in `readClient.ts`, `list-events` with `timeMin/timeMax/singleEvents:true`, PinnedWindow limits ≤ 14 days), projects with an extended `projectEvents` (adds `id`, `recurringEventId`/`recurrence` → `recurring`, `attendees.length`, `extendedProperties.private.waAgent === '1'` → `ownedByApp`), `writable` from the stored calendar roles (`adminClient.ts:43-69`, `owner|writer`). Cache key `(calendarId, weekStartMs)`, TTL 5 min, invalidated by `calendar:invalidate`, by every executed calendar action, and by refresh. A failing calendar lands in `failed`, the rest still return.
- **I2′ untouched:** `MCP_TOOLS`/`ENABLED_TOOLS` (`readClient.ts:16-29`) gain nothing for the model; ToolGate's name table is not edited; `list-events` is already an enabled read tool.
- Renderer: `CalendarEntry.state` gains `'foreign'` with `calendarId`, `eventId`, `writable`, `attendees`, `recurring`; `selectCalendarEntries` merges `ForeignEventView[]` (excluding `ownedByApp` ones that already have a card entry — de-dup by `eventKey`/eventId) with the item entries. `CalendarWeek` gets a calendar picker (`cal-picker`, one checkbox per calendar from `google:listCalendars`, selection persisted in `localStorage` `wca.calendar.visible`, default all), a colour per calendar (`data-cal-hue` 0..7 = sha8(calendarId) mod 8 mapped to 8 token hues — add the tokens to `styles.css`), a legend (`cal-legend`), and a `cal-refresh` button (calls `calendar:invalidate` then re-fetch). Foreign blocks: `cal-block-f-<sha8(eventId)>`, title in `<bdi className="msg-text" dir="auto">`, click → popover `cal-event-popover` (title, calendar name, time, attendees count, "recurring" flag, actions of §2.5 or the reason they are disabled).
- Loading/error: `cal-loading` skeleton rows; a failed calendar shows `t('cal.failedFor', {name})` once.

### 2.5 Manual management (write) — I9′
- **Allowed:** create on any `writable` calendar; move/reschedule, edit title/location/duration, delete — on events that have **no attendees and no recurrence**, on a writable calendar. **Refused in code** (not just hidden): attendees > 0 or recurring → the popover shows the action disabled with `t('cal.refusedAttendees')` / `t('cal.refusedRecurring')`, and the executor returns `CAL_EVENT_FOREIGN_PROTECTED` if asked anyway.
- Every write is a pending action approved by a click: IPC `calendar:proposeCreate { calendarId, title, startLocal, endLocal, location }`, `calendar:proposeEdit { calendarId, eventId, patch: { title?, startLocal?, endLocal?, location? } }`, `calendar:proposeDelete { calendarId, eventId }` → `{ actionId, kind, shownHash, summary }`; the renderer then calls the existing `action:approve { actionId, kind, shownHash }` from a confirm dialog (`cal-confirm`, shows the summary; for edit: old → new). Nothing executes on propose.
- Data model: migration vN+1 rebuilds `actions` with `item_id`/`proposal_id`/`chat_id` **nullable**, `source TEXT NOT NULL DEFAULT 'chat' CHECK(source IN ('chat','manual'))`, kind check extended to `delete_event`; `ACTION_KINDS` += `'delete_event'`; payload schemas `ManualCreatePayload`, `ManualEditPayload` (absolute PATCH + `baseRevision`/etag like `update_event`), `ManualDeletePayload`; `shownHash` over the canonical payload as today.
- Executor (`src/main/exec/actionExecutor.ts`): a `manualOwnershipOf(pf, calendarRoles)` next to `ownershipOf` (980-994): calendar writable, `attendees.length === 0`, no `recurrence`/`recurringEventId`, event id matches; `source:'manual'` actions use it instead of `ownershipOf`. Pre-write snapshot via `get-event` into `event_revisions` (`prev_json`) in the same transaction (I8); delete = `delete-event` after the snapshot; undo of a delete = `create-event` from the snapshot (new id; the new event is app-tagged `waAgent:'1', waManual:'1'`), undo of edit = PATCH back, undo of create = delete. `AutoGate` refuses every `source:'manual'` action (`provider_unsafe`-style reason `manual_only`). `write-ahead`, `If-Match`, reconcile unchanged (I7′).
- Server surface: `delete-event` added to `MCP_TOOLS` (class `write`) and `ENABLED_TOOLS_ENV`; the startup tool-list check expects nine tools; `callerFor('write')` allows `delete-event` only when the action payload is `source:'manual'` (pass the source through the write client call; chat actions can never reach it — test). `docs/specs/contracts.md` updated.
- Undo surface: toast with Undo after each executed manual action (existing toast + `item:undoChange`-style channel generalised to `action:undo {actionId}` for manual actions); the popover of an app-created manual event shows "Undo last change" while `undoCandidate` exists.
- Audit rows: `manual_event_proposed`, `manual_event_executed {kind, calendarSha8}`, `manual_event_refused {reason}`.

### 2.6 Locale keys (both files; `i18n.usage.test.ts` + parity test)
```
refresh.now "Refresh" / "רענון";  refresh.running "Refreshing…" / "מרענן…";  refresh.done "{{newRows}} new messages, {{queued}} chats queued, {{skipped}} skipped" / "{{newRows}} הודעות חדשות, {{queued}} שיחות בתור, {{skipped}} דולגו";  refresh.cooldown "Just refreshed — try again in a moment" / "רוענן הרגע — נסו שוב בעוד רגע"
cal.picker "Calendars" / "יומנים";  cal.refresh "Refresh events" / "רענון אירועים";  cal.failedFor "Could not load {{name}}" / "לא ניתן לטעון את {{name}}";  cal.newEvent "New event" / "אירוע חדש";  cal.edit "Edit" / "עריכה";  cal.move "Move" / "הזזה";  cal.delete "Delete" / "מחיקה";  cal.undoLast "Undo last change" / "ביטול השינוי האחרון";  cal.refusedAttendees "Has other attendees — not changed from here" / "יש משתתפים נוספים — לא משתנה מכאן";  cal.refusedRecurring "Repeating event — not changed from here" / "אירוע חוזר — לא משתנה מכאן";  cal.confirmCreate "Add to {{calendar}}?" / "להוסיף ל-{{calendar}}?";  cal.confirmEdit "Change this event?" / "לשנות את האירוע?";  cal.confirmDelete "Delete this event?" / "למחוק את האירוע?";  cal.readOnlyCalendar "Read-only calendar" / "יומן לקריאה בלבד"
theme.* and settings.general.themeLabel (§2.3);  errors.CAL_EVENT_FOREIGN_PROTECTED.{title,body,action}: "This event is protected" / "It has other attendees or repeats; change it in Google Calendar." / "Open in Google Calendar"  (he: "האירוע מוגן" / "יש בו משתתפים נוספים או שהוא חוזר; שנו אותו ביומן Google." / "פתיחה ביומן Google")
```

## 3. Global constraints
- **I1′** unchanged: every calendar write needs the `action:approve` click with `shownHash`; `calendar:propose*` only creates pending actions. **I2′** unchanged: no new tool for the model. **I3′/I7′/I8** unchanged. **I9 → I9′:** "The app never modifies an event that has attendees or recurrence, never writes automatically to an event it did not create, never lets the model touch foreign events; user-initiated writes to foreign events exist only from the calendar view, each approved by a click, snapshot first, undoable." `delete-event` is enabled for `source:'manual'` actions only.
- Untrusted text (titles, calendar names) only inside `<bdi className="msg-text" dir="auto">`; never in `aria-label`/`title` attributes; logs carry hashes (`calendarSha8`, `eventSha8`), never titles or ids.
- Logical CSS only; locale keys for every string; test ids as listed; he+en screenshots.
- Rate limits unchanged (`LIMITS.llmRunsPerChatPerHour` 6, `llmRunsGlobalPerHour` 60, CLI `maxRunsPerHour`).
- Workers never commit/push; notes only in `ops/agent-notes/<label>.md`.

## Review focus (tests pinned to tasks)
1. A foreign event with one attendee: propose-edit refused by main (`CAL_EVENT_FOREIGN_PROTECTED`) even if the UI is bypassed. → T6.
2. Undo of a delete recreates the event with the snapshot's title/time/location and no attendees, tagged app-owned; a second undo is refused. → T6.
3. Refresh pressed twice within 30 s: one scan, one report, no double queueing. → T3.
4. Theme `dark` with OS light: dashboard, Settings and the calendar all render dark (no light leak in `dashboard.css` sticky backgrounds). → T1 e2e screenshot.
5. A calendar that errors (403) leaves the others visible and the failure named once. → T4/T5.

---

## 4. Plan

File map — create: `src/shared/week.ts`(+test), `src/main/mcp/calendarEvents.ts`(+test), `src/main/ipc/handlers/calendar.ts`(+test), `src/main/exec/manualEvents.ts`(+test), `src/renderer/src/components/ThemeToggle.tsx`(+test), `src/renderer/src/components/CalendarPicker.tsx`(+test), `src/renderer/src/components/EventPopover.tsx`(+test), `src/renderer/src/components/ManualEventDialog.tsx`(+test), `tests/e2e/v4-calendar.spec.ts`, `tests/e2e/v4-shell.spec.ts`. Modify: `src/shared/{settings,types,ipc,schemas}.ts`, `src/main/{index,compose}.ts`, `src/main/app/window.ts`, `src/main/db/migrations.ts`(+v-test), `src/main/db/repos/actions.ts`, `src/main/exec/{actionExecutor,undo,writeClient,buildCreateEventArgs}.ts`, `src/main/agent/autoGate.ts`, `src/main/mcp/{readClient,projection,host}.ts`, `src/main/bridge/ingest.ts`, `src/main/agent/queue.ts`, `src/main/ipc/handlers/{dashboard,settings}.ts`, `src/renderer/src/{App,api}.tsx/ts`, `views/{Dashboard,Settings}.tsx`, `components/{CalendarWeek,LanguageToggle}.tsx`, `store/{dashboard,calendarEntries}.ts`, `styles.css`, `views/dashboard.css`, locales, `tests/fakes/fake-mcp-calendar.ts`, `docs/{ARCHITECTURE-v2,specs/ux,specs/contracts,specs/v2-ux}.md`, `README.md`.

### Task group A — shell: theme (T1) then sticky (T2)   *owner: App.tsx, Settings.tsx (General group + layout), settings.ts, styles.css, dashboard.css, window.ts, handlers/settings.ts, ThemeToggle*
- [ ] T1 tests first: `settings.test.ts` (theme default `system`, patch accepts the three values, rejects others); `ThemeToggle.test.tsx` (radiogroup, arrow keys, `onChange`); `App` test: boot with `theme:'dark'` → `document.documentElement.dataset.theme === 'dark'`, `system` → no attribute; main `handlers/settings.test.ts` → `nativeTheme.themeSource` set (inject a fake `nativeTheme` through the electron facade used by handlers; never import electron in tests); `styles.test.ts`: both selectors present.
- [ ] T1 implement §2.3. Settings radio row under General (`settings-theme-{system,light,dark}`).
- [ ] T2 tests first: `Dashboard.static.test.ts` OWNED += `App.tsx`; a jsdom test cannot assert scrolling — write the e2e spec `tests/e2e/v4-shell.spec.ts` (§2.2 assertions, en + he, 420 px and wide, screenshots `shell-{en,he}-{top,bottom}.png`, `theme-dark-{dashboard,settings,calendar}.png`, `theme-light-dashboard.png`).
- [ ] T2 implement §2.2. Run `npx vitest run src/renderer src/shared src/main/ipc` green; typecheck, lint, format; `npm run -s build:e2e && npx playwright test tests/e2e/v4-shell.spec.ts tests/e2e/i18n-rtl.spec.ts tests/e2e/app.spec.ts`. Note `ops/agent-notes/v4-shell.md`.

### Task group B — refresh (T3)   *owner: ingest.ts (scanNow public API only), queue.ts, handlers/dashboard.ts, ipc.ts (`dashboard:refreshNow` only), Dashboard.tsx toolbar block ONLY (re-read before editing), locales `refresh.*`*
- [ ] Tests first (`handlers/dashboard.test.ts` or a new `refreshNow.test.ts` with the fake clock, fake ingest `{scanNow}` and fake repos): §2.1 report shape; 24 h window; cap 20; `in_calendar` counted; rate-limited counted; cooldown (review focus 3); audit row; `dashboard:changed` pushed.
- [ ] Implement §2.1; renderer button + toast (`Dashboard.v4.test.tsx`: click → IPC once, spinner, toast text; second click inside cooldown → cooldown toast).
- [ ] `npx vitest run src/main/ipc src/main/bridge src/main/agent src/renderer/src/views` green; typecheck, lint, format. Note `ops/agent-notes/v4-refresh.md`.

### Task group C — calendar read + view (T4 then T5)   *owner: week.ts, calendarEvents.ts, readClient.ts, projection.ts, handlers/calendar.ts, ipc.ts (`calendar:listEvents|invalidate`), types.ts (ForeignEventView, CalendarEventsRes), CalendarWeek.tsx, CalendarPicker.tsx, EventPopover.tsx (read-only part), calendarEntries.ts, Dashboard.tsx calendar-section props ONLY, fake-mcp-calendar.ts (multi-calendar events), locales `cal.*` read keys*
- [ ] T4 tests first: `projection.test.ts` extended fields (verbatim Google `events.list` item shapes: attendees, recurringEventId, recurrence, extendedProperties.private.waAgent, all-day `start.date`); `readClient.test.ts` `listEventsInWindow` args (`singleEvents:true`, window ≤ 14 d, calendar id pinned); `calendarEvents.test.ts` cache TTL/invalidate, partial failure (review focus 5), `writable` from roles; `week.test.ts` moved tests pass unchanged.
- [ ] T4 implement §2.4 main side + fake server: `tests/fakes/fake-mcp-calendar.ts` gains a per-calendar event store (seedable from the e2e harness: `scenario` or a seed file) returning Google-shaped `list-events` for `calendarId`, with attendees/recurring/all-day/app-owned samples and a `calendar_403` scenario.
- [ ] T5 tests first: `calendarEntries.test.ts` foreign merge + de-dup; `CalendarPicker.test.tsx` (checkboxes, persistence, default all); `CalendarWeek.test.tsx` foreign blocks with `data-cal-hue`, legend, popover opens with calendar name and the disabled reasons; `cal-refresh` → invalidate + re-fetch.
- [ ] T5 implement §2.4 renderer. `npx vitest run src/shared src/main/mcp src/main/ipc src/renderer` green; typecheck, lint, format. Note `ops/agent-notes/v4-calendar-read.md`. Hand-off block for group D: exact exported names of `CalendarEntry` (foreign fields), `EventPopover` props, the fake server's seed API.

### Task group D — manual management (T6 then T7)   *starts after C; owner: migrations.ts, repos/actions.ts, schemas.ts, types.ts (ACTION_KINDS, payloads), actionExecutor.ts, manualEvents.ts, undo.ts, writeClient.ts, autoGate.ts, readClient.ts MCP_TOOLS/ENABLED (delete-event), host.ts toolset check, handlers/calendar.ts (propose*), ipc.ts (`calendar:propose*`, `action:undo`), EventPopover.tsx actions, ManualEventDialog.tsx, CalendarWeek.tsx "New event" button, locales write keys + error key, contracts.md*
- [ ] T6 tests first: migration v-test (old DB upgrades, chat actions keep NOT NULL semantics via app code, manual rows allowed); `manualEvents.test.ts` propose → pending action, `shownHash`, refusals (review focus 1); executor: create/edit/delete with snapshot-first, `If-Match`, undo (review focus 2), `AutoGate` refuses `manual`; `host.test.ts` nine tools, `delete-event` reachable only with `source:'manual'`; fake server implements `delete-event`.
- [ ] T6 implement §2.5 main side.
- [ ] T7 tests first: `ManualEventDialog.test.tsx` (validation, writable calendars only), `EventPopover.test.tsx` actions → `calendar:propose*` then `cal-confirm` → `action:approve` with the returned `shownHash`, undo toast; `tests/e2e/v4-calendar.spec.ts`: foreign events of 2 calendars visible with colours; picker hides one; create on a second calendar → exactly one `create-event` on the fake with that `calendarId`; edit a foreign event → one `update-event` with `If-Match`; delete → one `delete-event`, undo → one `create-event` from the snapshot; attendee event: actions disabled + propose refused; refresh button invalidates; screenshots `calendar-foreign-{en,he}.png`, `calendar-popover-en.png`, `calendar-confirm-delete-en.png`.
- [ ] T7 implement. Full `npx vitest run` green; typecheck, lint, format; `npm run -s test:e2e` green. Note `ops/agent-notes/v4-manual-events.md`.

### Task 8 — docs (orchestrator or a worker)
- [ ] `docs/ARCHITECTURE-v2.md`: I9 → I9′ row (§3 wording), B-row for the calendar read service, `delete-event` in the tool table; `docs/specs/ux.md` §6.11 + §14 + §16 (new components/test ids); `docs/specs/contracts.md` (IPC + payloads + nine tools); `README.md` features (refresh, theme, all calendars, manual events with the attendee/recurring rule); `ops/DECISIONS.md` D-089.

### Task 9 — review, proof, ship (orchestrator)
- [ ] Fresh Opus reviewer on the whole diff against §2–§3 (invariants first). Fix pass.
- [ ] `npm run lint && typecheck && format:check && npx vitest run` (twice) `&& npm run test:e2e`; `npx playwright test tests/e2e/sweep` (0 broken); look at every screenshot; `npm run build` + `electron-builder --win --x64` + `npm run test:defender`; pre-push scans; commit (noreply author) + push; swap `Desktop\win-unpacked` if the app is not running; PROGRESS/BOARD/ticket.
