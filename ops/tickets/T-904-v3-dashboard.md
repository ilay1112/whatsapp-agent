# T-904 — v3 dashboard: dismiss X, schedule-only filter, week calendar, manual time

**Status:** done (2026-10-18) - see PROGRESS 80, D-085
**Owner:** orchestrator (plan, Fable 5.1) + Opus 5.5 workers (Tasks 1–7)
**Spec + plan:** `docs/specs/v3-dashboard-handover.md`

## Request (user, 2026-10-18)
1. X button to dismiss conversation cards.
2. Show only conversation cards classified as potentially a schedule.
3. A calendar view instead of the card view.
4. Manual edit of date and time, then add to calendar.

Decisions taken in the option dialog: calendar + side list (no Google reads), week layout, X = hide for now, filter default on with "Show all".

## Acceptance
- Compact cards have `dismiss-x-<id>`; click = existing dismiss with Undo; nothing sent/written.
- Filter hides finished analyses with intent question/smalltalk/other and no event/change; analysing/held/failed stay; header toggle shows the hidden count; persisted.
- `view-calendar` shows a 7-day grid from dashboard data; blocks open the sheet; undated cards in a side list; Hebrew week starts Sunday; no horizontal scroll at 420 px.
- "Edit time" on a proposed card feeds `action:approve.edit`; "Save time" on an info-missing card calls `item:completeEvent`, then "Add to calendar".
- All checks green (lint, typecheck, format, vitest, e2e incl. new `dashboard-v3.spec.ts`), screenshots in `test-results/screens/`, Defender gate on the rebuilt package.

## Progress
- [x] T1 intent on card  - [x] T2 store  - [x] T3 selectors  - [x] T4 CalendarWeek  - [x] T5 card  - [x] T6 dashboard+specs  - [x] T7 e2e  - [x] review + fix pass  - [x] T8 proof+commit

## Proof notes
- Unit: 8066 passed (one load-flaky download-resume test passes alone, untouched files).
- e2e: 54/56 on the first full run; pictures.spec fixed (manipulation badge keeps a card visible); cli-connect 7a fails on HEAD too (pre-existing, follow-up task).
- Screenshots: `test-results/screens/en-calendar.png`, `he-calendar.png`, `he-calendar-420.png`, `calendar-{en,he}.png`.
