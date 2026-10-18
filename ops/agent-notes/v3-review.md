# v3 review (T-904): fresh reviewer, uncommitted diff of 2026-10-18

Scope: `git diff HEAD -- src docs` plus the new untracked `src/` files. `tests/e2e/*` was not reviewed (it is being written in parallel). Read-only: no files changed except this note, and nothing was committed.

Unit run: `npx vitest run src/renderer src/shared src/main/agent` gave **112 files, 2844 passed, 1 expected fail, exit 0**.

## Verdict: no blockers

I1' holds:
- The X only calls `controller.dismiss`, which is `item:dismiss`. RawCard's X goes the same way.
- "Save time" only calls `item:completeEvent`. That writes a `provider:'user'` proposal, and `autoGate.ts:275` refuses `provider_unsafe` for user proposals, so automatic mode cannot approve one.
- "Edit time" only changes the `edit` that the existing click-driven `action:approve` carries.
- No new IPC channel. No Google event read. The calendar is derived from `lists` only.

## Should-fix

1. **Reschedule with no new day or time: "Save time" creates a duplicate event.**
   - Where: `ItemCard.tsx:1352` (blank `editorVm`) and `:1615` (the sheet now renders `sheet-event` when `event` is null).
   - Scenario: the delta `incomplete` path (`validate.ts`: `eventState:'incomplete'`, `event:null`) now shows a blank form. "Save time" leads to `completeEvent`, which inserts a `create_event`. "Add to calendar" then adds a second Google event and the original stays at its old time. Before v3 this card had no editor.
   - Fix: show the fill form / Save time only when `eventVmOf(item) !== null`. Or have `completeEvent` return `ACTION_STALE` when the current proposal has a `delta`.

2. **Overlapping entries hide each other.**
   - Where: `CalendarWeek.tsx:223`.
   - Scenario: two chats propose 15:00 the same day. Both blocks are absolute and full width, so one pending proposal is invisible and cannot be clicked.
   - Fix: split the column width per overlap group (lane index), or at least offset and narrow later blocks.

3. **A card that unmounts while dirty stays dirty.**
   - Where: `ItemCard.tsx:292-294`. The store's dirty flag is never cleared on unmount.
   - Scenario: type a draft on a proposed card, then switch to Calendar or toggle the filter. The edit is lost, but `dirtyItemIds` keeps the id. `refresh()` pins the stale view model, so the block never updates. An open inline editor also leaves `item:setEditing(true)` until `editLockMs`.
   - Fix: add an unmount cleanup, `return () => { markDirty(id, false); if (inlineOpenRef.current) void api.setEditing(id, false); }`.

4. **The "latest 20 of N" line no longer follows the server count.**
   - Where: `Dashboard.tsx:155`. The test at `Dashboard.v3.test.tsx:147` asserts "latest 20 of 29" under a name that says "server count".
   - Scenario: 19 cards are drawn, and the line says "20 of 29". §2.2 says this line is unchanged.
   - Fix: give `ItemList` the server count for the `more-` line (for example a `totalCount` prop), or rename the test and amend §2.2.

5. **The chat name in the block's `title` attribute contradicts `ux.md` §16.5.** That section allows untrusted strings only in the card's `aria-label`.
   - Where: `CalendarWeek.tsx:221`.
   - Fix: amend §16.5 to allow `cal-block` `title`, or move the name into a visually hidden `<bdi>`.

6. **The calendar can open on the wrong week.**
   - Where: `Dashboard.tsx:127`. `anchorMs` and `nowMs` are set when the Dashboard mounts.
   - Scenario: the app has been open since last week. Switching to Calendar shows last week, and the today mark is stale for up to 60 s.
   - Fix: on entering the calendar view, `setNowMs(Date.now()); setAnchorMs(Date.now())`.

## Nits

- **X size:** the X is 28 px (`ItemCard.tsx:774`) and `MIN_BLOCK_PX` is 12, both below `ux.md` §13.7's 32 px minimum. Amend §13.7 for the X, or use 32.
- **Block time format:** the block's time range is hand-built with an en dash (`CalendarWeek.tsx:227`). Reuse `formatTimeRange` from `@shared/i18n/format`.
- **F6 table:** the `ux.md` §13.2 F6 row still says "header, column 1-3, footer". The toolbar and calendar stops are documented only in §6.11.
- **Side-list arrow keys:** in the narrow layout with "Information missing" collapsed, Up/Down in the side list does nothing. `visibleLists` excludes `info_missing`, and `data-list` is the card's status.
- **Double count:** `hiddenCount` counts a card twice when it appears in two lists (a pinned dirty card).
