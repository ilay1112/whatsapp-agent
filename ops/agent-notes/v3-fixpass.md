# v3 fix pass (T-904) — implementer notes, 2026-10-18

Input: `ops/agent-notes/v3-review.md` should-fix 1-6, nits, and the calendar screenshot defects. Nothing committed.

## Changes per item

1. **No blank fill form / "Save time" on a change or reschedule-without-time card.** `ItemCard.tsx`: `blankFormAllowed` = info-missing, not raw, `item.change === null`, intent not in {reschedule, cancel}. `fillForm` also requires `item.change === null`. Defence in depth in `src/main/agent/items.ts` `completeEvent`: if the current proposal has `event === null` and intent reschedule/cancel, it returns `ACTION_STALE`. The delta `incomplete` path stores `delta: null` in the proposal, so the intent is the only signal left. Tests: `ItemCard.v3.test.tsx` (2 new), `items.test.ts` (1 new).
2. **Overlapping blocks share the width.** Pure `layoutLanes()` in `store/calendarEntries.ts`. Blocks are sorted by start, longer first on a tie, and each takes the first lane whose end ≤ its start. Clusters are chained overlaps, measured on drawn px, so the 12 px minimum also counts. `CalendarWeek` sets `inset-inline-start: calc(lane*share% + 1px)`, `inline-size: calc(share% - 2px)` and `data-lane`. Tests: 4 unit tests plus 2 component tests (15:00-16:00 with 15:30-16:30: distinct starts, both clickable).
3. **Unmount while dirty.** `useCardController` has a cleanup effect keyed on `itemId`. It reads refs (dirty, focused, inline editor open). If any is set, it calls `markDirty(id,false)` and `api.setEditing(id,false)`. Tests: 3, including "clean unmount calls nothing".
4. **"Latest 20 of N" uses the server count.** Added `ItemList.totalCount?`, and Dashboard passes `lists[key].count`. The `count-<key>` label still shows the visible count. Test renamed; it now expects "of 30".
5. **Chat name out of `title`.** The name is now `<bdi className="msg-text sr-only" dir="auto">` inside the block. It reuses Tailwind's `sr-only`, which the app already uses in `App.tsx` / `ChangeLine`.
6. **Calendar opens on the current week.** The `view-calendar` click resets `nowMs` and the anchor to `Date.now()` when coming from cards. The test fakes only `Date` and moves it +8 days. I confirmed it fails without the fix.
7. **Screenshots.**
   - (a) Each header shows the weekday over the day number. `.cal-day` is a size container, and `@container (inline-size < 72px)` swaps `.cal-wd-short` for `.cal-wd-narrow` (CSS only, `dashboard.css`).
   - (b) The block shows the start time (`formatTime`, h23 2-digit) on line 1 and the title bdi on line 2. Both lines have `.cal-block .cal-line` set to nowrap/ellipsis. Two classes deep are needed because the unlayered `.msg-text { white-space: pre-wrap }` beats Tailwind's `truncate`.
   - (c) The `title` attribute is `formatTimeRange(...)`.
   - Iteration: at 420 px "15:00" was still clipped. Block padding went to `px-0.5` and the inline gaps to 1 px, and now it fits.
8. **Nits.**
   - The X has a 32×32 hit area; the glyph stays 14 px. The ItemCard.v2 snapshots were updated; only the style changed.
   - `hiddenCount` de-dupes by `itemId` (test added).
   - `ux.md` §13.2 F6 row and §6.11 now describe the X size, the count line, the header/block content, lanes and the fill-form exception. `v3-dashboard-handover.md` §2.3 block-content line is annotated as superseded.

## E2E adjustments (intentional)
`dashboard-v3.spec.ts` block test:
- The time element reads `15:00`.
- `title` matches `/15:00-16:00/`.
- The chat name is in `bdi.sr-only`.
- Header span visibility is asserted at wide width (short weekday) and at 420 px (narrow weekday).

## Results
- `npx vitest run src/renderer src/shared src/main/agent`: 112 files, 2860 passed, 1 expected fail.
- typecheck 0, lint 0, format:check clean.
- `build:e2e`, then playwright (dashboard-v3, i18n-rtl, app, approval-first): 16/16 passed.
- Screenshots `en-calendar.png`, `he-calendar.png` and `he-calendar-420.png` read correctly. The 420 px headers show "א׳ / 25" etc., and the block shows "15:00 / פגי…".

## Not done / open
- The review nit on side-list arrow keys (narrow layout, info_missing collapsed) was not in the fix list and is untouched.

## Manipulation badge keeps a card visible (2026-10-18)

- Trigger: `tests/e2e/pictures.spec.ts:169` timed out in `cardOfChat`. The injection picture gives `intent:'other'` plus
  the `manipulation` badge, with no event or change, so the schedule-only filter hid the card.
- Decision (orchestrator): a manipulation-flagged card is a security signal and must stay visible.
- Change: `isScheduleRelated` in `src/renderer/src/store/calendarEntries.ts` now also returns true when
  `card.badges.includes('manipulation')`. Nothing else changed.
- Tests first: `calendarEntries.test.ts` gained smalltalk/other/question + `['manipulation']` (kept), plus a control
  case where `['time_assumed']` is still hidden. The new cases failed before the fix (3 red) and pass after it.
- Specs: handover §2.2 (predicate and prose) and ux.md §6.11 now say "... or carries the manipulation badge".
- Verification: vitest store+views 27 files / 521 tests green; lint, typecheck and prettier clean; build:e2e then
  Playwright pictures.spec + dashboard-v3.spec 8/8 passed (retries 0).
