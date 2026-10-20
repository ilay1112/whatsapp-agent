# v4-review — fresh review of the uncommitted T-908 diff (2026-10-19)

Read-only review against `docs/specs/v4-calendar-handover.md` §2–§4 and the five worker notes. No file edited except this one.

## Verdict: no blockers. 2 should-fix, several nits.

## Test run
`npx vitest run` (once): **361 files: 1 failed / 360 passed; tests: 1 failed / 8337 passed / 1 expected fail / 1 skipped (8340).**
The failure is `src/main/proc/reaper.real.test.ts` ("reaps a crash orphan…", real process table, 5.8 s). The diff does not touch it,
and it passes when run alone (4/4), so it is load flakiness. No `skip` / `fixme` / `only` added.

## Should-fix
1. **Refresh brings back dismissed / ignored cards and can use up the global LLM budget.** `src/main/bridge/ingest.ts:570`
   (`reanalyseChat`) + `src/main/ipc/handlers/dashboard.ts:86-95`. Scenario: the user dismisses the card for message X, presses Refresh,
   and gets a NEW open item for the same X (or a raw "older message" card when X is past the backlog window). Separately, 20 recent
   chats whose newest item is `ignored` cost 20 runs per press. Three presses in 90 s reach `llmRunsGlobalPerHour` (60), and real
   incoming messages are then held for the rest of the hour. The test at `dashboard.test.ts:269` / `ingest.reanalyse.test.ts` asserts
   "dismissed => new item".
   Fix: return `nothing` when the chat's newest item already has `trigger_msg_id` = the newest eligible row (nothing new since the
   last analysis), or at least when it was dismissed. Count held items outside the global-budget guard.
2. **The calendar view is not re-read after the toolbar Refresh or any write door.** `src/renderer/src/store/calendarView.ts:94-151`
   listens only to `google:changed`. Scenario: Refresh (or a card approve or undo) empties main's cache, but the week keeps showing
   the old events. The next Edit or Delete then fails with `CAL_EVENT_GONE`, because `resolve()` misses the empty cache
   (`calendarEvents.ts:217-225`). The same happens after 5 minutes idle (TTL).
   Fix: bump the nonce on `dashboard:changed` and after the main-side invalidation. Optionally, make `resolve()` re-read that one
   calendar's week on a miss.

## Nits
- `src/main/mcp/projection.ts:330-345`: `projectDeletedEvent` sits between `classifyEventErrorText` and its doc comment.
- `calendarView.ts:114`: `assignCalendarHues` changes a module-level map during render. Move it into `useMemo` / `useEffect`.
- `ManualEventActions.tsx:304`: the edit form starts with `location: ''`, so the user cannot see or clear the event's current location
  (`ForeignEventView` has no location).
- Cancelling `cal-confirm` leaves the manual action pending until the next propose or the 24 h expiry (harmless: it still needs a click
  and the shownHash). Reject it on cancel.
- Manual writes use the `create_global` bucket that chat creates also use (`manualEvents.ts:467`).
- Docs are stale: `docs/ARCHITECTURE-v2.md:62` (B3 still says "ENABLED_TOOLS = 8 names … exactly these 8"); `docs/specs/ux.md:624`
  and the I9′ row do not list the `from_chat` / `all_day` refusals (`cal-reason-fromchat|allday`).
- The dashboard `<main>` is a second scroller inside `app-scroll`, and the 70vh `cal-grid` makes a third. This deviation is documented
  and sticky still works, but the calendar can show nested scrollbars.

## Verified OK
- I1′: `createManualProposals` has no write client; refresh and listEvents hold no write path. Manual execution happens only through
  `approveAs` (focus guard first) → `manualExec.approve` (`by==='user'`, shownHash, no edit/flags), and the trigger enforces "manual
  needs a click".
- I2′: the agent never sees `MCP_TOOLS`; ToolGate is unchanged and `BLOCKED_NAMES` still has delete-event; the list facade is main-only.
- I9′: attendees, recurrence, waItem and readonly are refused at propose AND at the approve pre-flight. `callerFor` refuses delete-event
  unless `source:'manual'`, and so does the write client. A chat cancel stays `update-event`. AutoGate checks `manual_only` first and
  breaks.
- I8: the snapshot row is written in the write-ahead transaction. Undo of a delete recreates the event with a new id, waAgent+waManual,
  no attendees. A second undo is refused (`manualUndosOf` / `revertedBy`); a failed undo can be retried.
- §10: `ForeignEventView` has no eventId (opaque eventKey); logs and audit rows carry sha8 / counts only.
- Migration v6: every v4 trigger on actions / event_revisions / auto_decisions is recreated (state rule + manual, NULL-safe frozen);
  CHECKs tie the ids to `source`; the v5→v6 upgrade is tested.
- Theme: the `data-theme` guard and the copy match (test compares the two token sets); nativeTheme is set at compose and on change;
  the window background matches the theme.
- The week helpers are shared and the DST week (2026-10-25) is tested.

## Decisions
- Chat events refused for manual change: sound (keeps the card's CAS and undo chain). Put it in I9′ and ux.md.
- All-day refused: sound for edit and move (the PATCH is timed). Strict for delete, but it keeps undo honest (recreate is timed). OK for v4.
- Refresh result line next to the button instead of a toast: sound (`role=status`, no ownership clash), but manual events use the
  global toast. Follow-up: add params to the global toast.
