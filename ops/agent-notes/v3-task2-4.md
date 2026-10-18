# v3 Tasks 2–4: schedule filter state, calendar selectors, CalendarWeek (T-904)

Date: 2026-10-18. Scope: handover §4 Tasks 2, 3 and 4. Each was done test-first: the tests failed before the code existed and passed after. No commit made.

## Files
- NEW `src/renderer/src/store/calendarEntries.ts` + `calendarEntries.test.ts` (51 tests)
- MOD `src/renderer/src/store/dashboard.ts` + `dashboard.test.ts` (6 new `[V3]` tests in their own describe)
- NEW `src/renderer/src/components/CalendarWeek.tsx` + `CalendarWeek.test.tsx` (24 tests)
- MOD `src/shared/locales/en.json`, `he.json`: new top-level groups `cal` and `view`, appended at the end of the file (the other worker's `action.*` keys sit inside `action`, so the two edits don't collide)

## Exported API as implemented
`calendarEntries.ts`:
- `SCHEDULE_INTENTS: ReadonlySet<Intent>`, `isScheduleRelated(card)`, `visibleItems(items, scheduleOnly)`, `hiddenCount(lists, scheduleOnly)`. All match the plan.
- `CalendarEntry` matches the plan. `CalendarEntryState` is also exported, as the union type.
- `selectCalendarEntries(lists, scheduleOnly, timeZone): { entries; undated }`. Matches the plan.
- `weekOf(anchorMs, firstDay: 0|1, timeZone): { startMs; days }`. Matches the plan.
- `firstDayFor(lang: Lang): 0|1`. Matches the plan.
- **DIFFERS:** `clipToDay(entry, dayStartMs, timeZone)`. I added a third `timeZone` argument. Positions use wall-clock time, so on the 25-hour DST day (2026-10-25) a 10:00 event still sits on the 10:00 row. Elapsed-ms maths would put it one row lower.
- **NEW:** `shiftWeek(anchorMs, weeks, timeZone)` moves the anchor by whole local weeks. Prev/next use it so a DST change can't push the anchor into the neighbouring day. For a week without a DST change it equals `anchor ± 7 days`.
- **NEW:** constants `HOUR_PX = 48`, `DAY_PX`, `MIN_BLOCK_PX = 12`.

`dashboard.ts`:
- `scheduleOnly / setScheduleOnly`, `view / setView`, `calNoteSeen / setCalNoteSeen` as planned.
- Also exported: `DashboardView`, `SCHEDULE_ONLY_KEY`, `VIEW_KEY`, `CAL_NOTE_KEY`.
- Storage is read once, when the module is created, and every access is wrapped in try/catch. The tests use `vi.resetModules()` to get a fresh module.

`CalendarWeek.tsx`:
- `CalendarWeekProps` / `CalendarWeek(props)` exactly as planned.

## Behaviour decisions
- **Event key de-duplication** applies only to `in_calendar` / `cancelled` entries; the newest `updatedAt` wins. `proposed` / `change_proposed` entries are never merged, because each one is a pending decision on its own card. A change card therefore shows its new slot, and the source card still shows its current slot.
- **A card that appears in two lists** (a dirty card pinned by `mergeColumn`) produces only one entry.
- **Undated cards:** `eventState` is `none` or `incomplete`, `startLocal` or `endLocal` is `''`, or end ≤ start. These cards never become blocks (review focus 1).
- **Event zone:** an entry uses the event's own `timeZone`. The `timeZone` argument only fills in a blank one.
- **Minimum block height** is 12 px. A block that ends near midnight is moved up so it stays inside the 1152 px day.
- **Extra test id `cal-col-<yyyy-mm-dd>`** marks the day column that holds the blocks. Also added: `calendar-week` (the section) and `cal-grid` (the scroller).
- **Block element:** each block is a `<button>`, so Enter and Space work natively. `data-state` is `proposed` for both proposed and change_proposed, `in_calendar`, or `cancelled`. The styles reuse existing token classes: dashed warn = proposal, solid accent = in calendar, `line-through` muted = cancelled. The chat name goes in the `title` attribute.
- **Prev/next icons** are inline chevron SVGs with `icon-dir`, so CSS mirrors them in RTL and there is no `rotate`. I didn't touch the v2-ux §1.3 icon list: ux.md §1.3 already lists `chevron` as mirrored when it means back/forward.
- **Grid scroller:** `max-block-size: 70vh`, initial `scrollTop = 7 * 48`. jsdom can't verify the scroll, so it is untested.

## Locale keys deferred to Task 6 (the usage test would flag them as dead now)
- `cal.undated` — the side-list title is rendered by Dashboard (`ItemList` title).
- `view.cards` — the view switch lives in Dashboard.
`view.calendar` was added now because `CalendarWeek` uses it as the section's `aria-label`. Task 6 should add `"cards"` to the existing `"view"` group and `"undated"` to `"cal"`.

## Hand-off notes for Task 6
- Add `src/renderer/src/components/CalendarWeek.tsx` and `src/renderer/src/store/calendarEntries.ts` to `OWNED` in `src/renderer/src/views/Dashboard.static.test.ts`. They already use logical properties only, but I couldn't edit that file.
- Dashboard must pass `anchorMs` state (init `Date.now()`), `nowMs`, `lang`, and `timeZone` (from `settings.general.timeZone`). Wire `noteSeen={calNoteSeen}` and `onNoteSeen={setCalNoteSeen}`.
- `CalendarWeek` renders `cal-empty` as a line above the grid; the grid itself always renders.

## Verification
- `npx vitest run src/renderer src/shared/locales`: 70 files, 1265 tests passed. This includes the other worker's in-progress ItemCard tests at the time of the run.
- `npm run -s typecheck` → 0; `npm run -s lint` → 0.
- Prettier `--write` on the six touched TS files; `--check` on both locale files is clean.
