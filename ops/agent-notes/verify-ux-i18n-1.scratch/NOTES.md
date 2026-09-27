# verify-ux-i18n-1 - verdict: CONFIRMED (severity: major, as claimed)

Scope: read-only review + one scratch vitest run. No product file touched.

## Refutation attempts, all failed
1. Guard at the render site? `ResultRowView` (ItemCard.tsx:532-557) renders each row action as
   `<button onClick={a.run}>` with NO `onKeyDown` and NO `isActivationBlocked()`. The guarded pair lives only
   in `controller.approveHandlers` (ItemCard.tsx:310-327), used only by `ApproveButton`.
2. Guard elsewhere in the renderer? `grep` for `isActivationBlocked` / `useFocusGuardStore` over src/ + tests/:
   the only production readers are ItemCard.tsx:315 and :324, plus `installFocusGuard()` in App.tsx:246.
   There is no app-wide overlay, no blur handler that clears `result`, no pointer-events gate.
3. Guard in main? `actions.ts:26` only checks `windowVisible && windowFocused` (both true after a refocus).
   `actionExecutor.ts:363` is conditioned on `ctx.shownByNotificationAt !== null`, which is null for an
   alt-tab / notification-toast / app-closing refocus. The action is still `pending` after
   `needs_confirm_conflict` (actionExecutor.ts:395-397), so a 2nd approve with `confirmConflict:true`
   passes straight to the write-ahead and the MCP create.
4. Already covered by a test? The three [R2] tests in ItemCard.test.tsx:144-178 only exercise
   `approve-send-1`. ItemCard.test.tsx:398-415 clicks `result-add-anyway` with the guard DISARMED.
5. Is "Add anyway" really an approval control? UX 6.8 (docs/specs/ux.md:561) enumerates it by name:
   "every approval button (Approve & send, Add to calendar, Ask for details, Send, **Add anyway**,
   Create anyway, Send again, Add again) ignores activation - click, Enter and Space - for 500 ms".
   ARCH 6.6 step 1 (ARCHITECTURE.md:317) and the ItemCard file header say the same.

## Independent reproduction
`ops/agent-notes/verify-ux-i18n-1.scratch/verify.test.tsx` (+ vitest.scratch.config.ts), run with
`npx vitest run --config ops/agent-notes/verify-ux-i18n-1.scratch/vitest.scratch.config.ts`:
- CONTROL "approve-event-1 is blocked while armed"  -> PASSES (the mechanism works where it is wired)
- SUBJECT mouse click on `result-add-anyway` while armed -> FAILS (approve called 2x, not 1x)
- SUBJECT Enter on `result-add-anyway` while armed     -> FAILS (approve called 2x, not 1x)
- SANITY: the 2nd call carries `confirmConflict: true` -> PASSES (it is the call that creates the event)

## Severity: major (NOT blocker)
Not a calendar write without approval: the user's own deliberate, guarded first click on "Add to calendar"
approved this exact actionId/payload, and the shownHash + pending-state checks still hold. What is lost is
the [R2] mitigation on the *conflict confirmation* - a named, spec-level requirement. Requirement broken,
no data loss, app usable => major.

## Note on the proposed fix
`controller.approveHandlers(action, {confirmConflict:true})` cannot be dropped in as-is: its `onClick`
takes a `React.MouseEvent`, while `ResultAction.run()` takes no argument. Either widen `ResultAction`
to carry the handler pair, or (smaller) add `if (isActivationBlocked()) return;` as the first statement of
the `run` at ItemCard.tsx:274 AND give ResultRowView's buttons the `onKeyDown` Enter/Space guard - the
keyboard half is a real second hole, proven separately above.
Secondary: that `run` also lacks the `e.detail > 1` double-activation check; `busyRef` masks it today.
