# v3 Task 6: dashboard wiring + spec edits (T-904)

Date: 2026-10-18. Scope: handover §4 Task 6. Done test-first: `Dashboard.v3.test.tsx` was written first and 16 of 17 cases failed; the store-module case was later dropped (see below). No commit made.

## Files
- MOD `src/renderer/src/views/Dashboard.tsx`
  - New toolbar row `dash-toolbar` above the AutoStrip. It holds `schedule-filter-toggle` ("Show all (N hidden)" / "Only schedules"; absent when the filter is on and N = 0) and `view-switch` with `view-cards` / `view-calendar` (`aria-pressed`, `btn-outline` = active, `btn-quiet` = inactive).
  - Cards view: each list gets `visibleItems(...)`. The count passed is `server count - hidden in that list`.
  - Calendar view: `CalendarWeek` plus the side list `cal-undated`, which is the existing `ItemList` with `list="info_missing"`, title `cal.undated`, not collapsible, always open.
  - Calendar inputs:
    - `anchorMs` is local state, initialised to `Date.now()`.
    - `nowMs` is local state, re-read every 60 s while the calendar is shown.
    - `timeZone` = `settings.general.timeZone`, falling back to `Asia/Jerusalem` before settings hydrate.
    - `lang` comes from `i18n.language`.
  - F6 regions are now `{root, focus}`. Focus anywhere inside a region counts as being in it. Order: header, toolbar, AutoStrip, then either the columns or (calendar `cal-range`, side list), then footer.
- MOD `src/renderer/src/views/dashboard.css`: item 7, `.dash-calendar { grid-template-columns: minmax(0,1fr) 20rem }`. It applies to the wide layout only; narrow uses a stacked flex column.
- MOD `src/renderer/src/views/Dashboard.static.test.ts`: added `store/calendarEntries.ts` and `components/CalendarWeek.tsx` to `OWNED`.
- MOD `src/shared/locales/{en,he}.json`: `cal.undated`, `view.cards`, and a new group `filter.showAll` / `filter.scheduleOnly`, with the §2.5 text.
- NEW `src/renderer/src/views/Dashboard.v3.test.tsx` (16 tests).
- MOD `docs/specs/ux.md`:
  - new §6.11;
  - §14 intro: the "no new component files" rule is lifted for `CalendarWeek.tsx` / `calendarEntries.ts`;
  - §14.1: Dashboard row;
  - §14.2: new `CalendarWeek` row, and a note on the `ItemCard` row that its props are unchanged;
  - §16 item 6: all v3 test ids, including Task 5's `inline-editor-<id>` / `fill-form-<id>`.
- MOD `docs/specs/v2-ux.md`: new §3.8, a one-line pointer to ux.md §6.11.

## Decisions / deviations
- **Count semantics.** `count-<key>` = server count minus the cards hidden in that list. "Showing the latest 20 of N" therefore still appears exactly when the server has more than it sent, but N is the filtered figure (e.g. 29 when the server count is 30 and one card is hidden). Doing it this way needed no change to `ItemList`.
- **F6 behaviour change.** Before this task, F6 from a focused card jumped to the first region, because a card did not count as "inside" its column. It now moves to the next region. The existing `Dashboard.test.tsx` and `Dashboard.v2.test.tsx` F6 tests pass unchanged.
- **jsdom quirk.** Element-scoped `root.querySelector('h2 > *')` returned null in jsdom (nwsapi). The focus target is therefore queried from `<main>` with the combined selector.
- **Toolbar position.** The toolbar is an F6 stop between the app header and the AutoStrip. That is an added stop; §2.3 named only "header".
- **`view-switch`** is a `role="group"` with no accessible name, because no locale key exists for one and §2.5 is closed.
- **Side-list empty state** is `null` once hydrated, so only the heading "No date yet 0" shows.
- **Dropped test.** I removed a "fresh module with view=calendar" case from the view test. It only re-tested `dashboard.test.ts` (store persistence). The first-paint case seeds `view:'calendar'` in the store instead.

## Verification
- `npx vitest run src/renderer src/shared`: 81 files, 1957 tests passed.
- `npm run -s typecheck` = 0, `npm run -s lint` = 0, `npm run -s format:check` = 0 ("All matched files use Prettier code style!").

## Deferred
- Task 7: e2e (`tests/e2e/dashboard-v3.spec.ts`, the RTL calendar screenshots). Real-layout checks are unverified in jsdom: the 07:00 initial scroll, no horizontal scroll at 420 px, and the side-list column width.
