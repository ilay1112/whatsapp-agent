# v2-verify-editing-undo-1 (skeptic pass) - verdict: CONFIRMED, severity major

Run: npx vitest run --config "ops/agent-notes/v2-verify-editing-undo-1.scratch/vitest.scratch.config.ts"
Result 2026-10-04: the copied review test is red (2 confirmed waAgent events after an edited "Add again").

Trace: approve() (actionExecutor.ts ~891-937) -> applyEdit -> eventSanity -> freshBusy (FRI does not overlap WED) ->
prepareArgs -> buildCreateEventArgs -> eventIdFor(chainKey, EDITED content) = new id -> createEvent succeeds.
markUnknown() clones immediately in-session; findAppEvent is never called on the click path (only in reconcile.ts at startup).
Every write still has a user approval record (each click), so approval-first is not broken; no data loss -> major, not blocker.

Side observation (not this finding): an UNEDITED "Add again" after a landed-but-timed-out create returns
needs_confirm_conflict, because freshBusy counts the app's own landed event as busy (second test in eu1.test.ts).
