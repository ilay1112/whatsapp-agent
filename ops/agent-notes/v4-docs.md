# v4-docs — T-908 Task 8 (docs), agent notes

Spec: `docs/specs/v4-calendar-handover.md` §1-§3, §4 Task 8. Sources: worker notes `v4-shell.md`, `v4-refresh.md`,
`v4-calendar-read.md`, and the implemented `src/shared/{ipc,types}.ts` + new components (read only). No `src/`/`tests/` file,
PROGRESS, BOARD or ticket touched. No commit / push.

## Sections changed

### `docs/ARCHITECTURE-v2.md`
- §1 heading: "B1-B32" -> "B1-B36 (B33-B36 added by v4, D-089)".
- B3: appended a *[v4, D-089]* amendment note (`delete-event` = ninth tool, class `write`, `source:'manual'` only).
- New rows **B33** calendar read service (`calendarEvents.ts`, `createMcpCalendarListClient`, `projectListedEvents`, ToolGate /
  `MCP_TOOLS` untouched = I2' holds, 5-min in-memory cache, nothing on disk, partial-failure semantics, `calendarIds` as the
  bounded exception to §10's "no MCP argument" rule), **B34** refresh (`dashboard:refreshNow`, 24 h, cap 20, cooldown 30 s,
  rate limits, `Ingest.reanalyseChat`), **B35** theme (`general.theme`, `data-theme`, `nativeTheme.themeSource`), **B36** sticky
  shell (single scroller `app-scroll`).
- §2: row **I9** replaced by **I9′** (exact §3 wording; `delete-event` for `source:'manual'` only; attendees/recurrence
  refusal `CAL_EVENT_FOREIGN_PROTECTED`; undo via `event_revisions`; group-D tests named "per v4-manual-events.md").
- §17 rejected ideas: the "`delete-event` for cancel or undo" row annotated (still rejected for chat/auto; manual deletes use it).

### `docs/specs/ux.md`
- §5.1 Header: ThemeToggle bullet (+ "header never scrolls" bullet).
- §6.11: source paragraph amended for v4; toolbar (`refresh-now` first, sticky); new **Refresh** and **Sticky shell**
  paragraphs; new scope-note text (en + he); new block "All calendars in the week view" (picker, hues, legend, `cal-refresh`,
  `cal-loading`, `cal-failed`, foreign blocks, all-day row, popover).
- New **§6.12 Manual event management** (propose -> confirm `cal-confirm` -> approve -> undo toast; disabled reasons for
  read-only calendar / attendees / recurring; `CAL_EVENT_FOREIGN_PROTECTED`).
- §9 Settings table: General > Appearance row (`settings-theme`).
- §14 intro: v4 new-file exception list; §14.2 rows `RefreshButton`, `CalendarPicker` (+`CalendarLegend`), `EventPopover`,
  `ManualEventDialog` (props "per v4-manual-events.md"), `ThemeToggle`; `CalendarWeek` row gains `renderEventActions`.
- §16 item 6: all v4 test ids.
- §17 C12 marked resolved by T-908.

### `docs/specs/v2-ux.md`
- §1.3 heading count (22 -> 27 -> 29). The `sun` / `moon` rows were already added by group A.

### `docs/specs/contracts.md`
- New §19 (before "Architecture concerns"): 19.1 request/response contracts for `dashboard:refreshNow`, `calendar:listEvents`,
  `calendar:invalidate` (schemas copied from `ipc.ts`, errors, handler files, preload/api/audit additions); 19.2 `RefreshReport`,
  `ForeignEventView`, `CalendarEventsRes` copied verbatim from `types.ts` + deliberate deviations + main-side seams;
  19.3 **placeholder** "calendar:propose* — filled from v4-manual-events.md".

### `README.md`
- Dashboard features: Calendar switch wording, Refresh, sticky layout, theme switch.
- "Events that follow the conversation": the delete sentence and the "only own events" sentence scoped to chats/AI.
- New subsection "Your whole calendar in the week view" (all calendars, picker + colour legend, manual management, the
  attendee/recurring rule, privacy note: per week, memory only).
- "Google Calendar through MCP": `delete-event` sentence rewritten for I9′.
- Privacy table "Your calendar" row; Daily use > Settings mentions theme. `npx prettier --check README.md`: clean.

### `ops/DECISIONS.md`
- Row **D-089** inserted directly after D-088 (before the out-of-order D-019 row at the end), same 6-column format.

## Open items for the orchestrator
- **`cal.scopeNote` locale text is still the v3 sentence** (false since v4). ux.md §6.11 now specifies the new en/he text; the
  locale files belong to the code workers — update `cal.scopeNote` in `en.json` / `he.json`.
- `docs/ARCHITECTURE-v2.md` §10 header says no channel accepts "an event id"; group D's `calendar:proposeEdit/proposeDelete`
  take `eventId`. B33 records `calendarIds` as a bounded exception; the same note is needed for `eventId` once D lands
  (validated against the cached week read / fresh `get-event` in main).
- After group D: fill contracts.md §19.3, the "per v4-manual-events.md" props/test ids in ux.md §6.12/§14/§16, and confirm the
  §6.12 details written from the handover (Cancel as default in `cal-confirm`, `aria-describedby` on disabled actions, "New
  event" absent without a writable calendar).
- v2-ux.md §1.3 lists 7 icons but `styles.css` also has `icon-alert` (pre-existing, not v4) — not touched.
