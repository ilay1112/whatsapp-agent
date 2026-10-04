# verify editing-undo-4 (skeptic pass)
Verdict: confirmed, minor. Run: npx vitest run --config "ops/agent-notes/v2-verify-editing-undo-4.scratch/vitest.scratch.config.ts"
After a reschedule WED->THU, undoChange with calendarConnected=false answers CAL_UNAVAILABLE; Google keeps THU, but the holder
(state in_calendar, eventState updated) has a new current proposal whose event is WED (insertChange at actionExecutor.ts:1369
commits before approveAs/approveUpdate gates at 783-837). The pending undo action stays pending but is not approvable from an
in_calendar card. A retry once reconnected succeeds (Google -> WED), so it is a display mismatch, not a write without approval.
