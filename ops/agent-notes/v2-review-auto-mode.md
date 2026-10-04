# Adversarial code review - lens "auto-mode" (v2 phase 3)

Agent label: `v2-review-auto-mode`. Subject: the BUILT code under `src/` (docs were context only). No product file was edited.
Proofs: `ops/agent-notes/v2-review-auto-mode.scratch/auto-mode.node.test.ts` (8 tests, each asserts the contract, **all 8 RED**
today). Run:

```
npx vitest run --config "ops/agent-notes/v2-review-auto-mode.scratch/vitest.scratch.config.ts"
```

The scratch tests use the existing exec rig (`tests/helpers/ledger.execRig.ts`: real in-memory DB, production triggers, fake
calendar v2 behind the real MCP clients). Nothing touches WhatsApp, Google or any CLI.

## What I traced and found to HOLD

- **I1' write path.** The only calendar writers are `runCreate` / `runUpdate` (`exec/actionExecutor.ts:556`, `:639`), reached
  only with an `executing` row. `trg_actions_state` v2 (`db/migrations.ts:397-421`) refuses `approved` without `approved_by`,
  refuses a non-click `send_reply`, refuses `user_toast` for anything but an undo with `revertOf`, and for any other approver
  requires an `auto_decisions` row **for this action id** with verdict `auto`, its policy `on` and unexpired by the SQLite wall
  clock, `approved_final_json = canonical_json`, no undo, and a matching decision kind. `auto_decisions.action_id` is UNIQUE,
  the table is append-only, `trg_actions_approver_frozen` freezes the approver. A policy paused / disabled / expired while
  `tryAuto` awaits its reads makes the write-ahead CAS fail inside the decision transaction (rolled back, `NONE`): proven by the
  trigger text, not only by app code.
- `tryAuto` refuses `send_reply`, retry clones, non-pending / expired actions, undo payloads, and actions not on the item's
  current proposal (`actionExecutor.ts:1008-1020`); it is called only by the orchestrator's S5a (`agent/orchestrator.ts:821-831`)
  and the triage queue runs one chat at a time (`agent/queue.ts:59-119`), so two `tryAuto` calls never race on the budgets.
  Undo / cancel / "Add as new" / "Add it back" actions are never handed to `tryAuto` (and carry provider `user` =>
  `provider_unsafe` anyway).
- I10: `settings:set` has no `auto` group (`shared/settings.ts:94`); `auto:pause` / `auto:disable` accept only
  `reason:'user'` (`shared/ipc.ts:134-135`); enable/resume/endShadow/undo are focus-gated twice (register + handler); the
  enable dialog is main-owned, parent = main's window ref, accepted only with `response===1 && checkboxChecked`; nothing in
  `tick` ever switches a policy on; `trg_auto_policies_*` freeze the grant and forbid returning to `shadow`.
- Cage rules present in `exec/autoGate.ts` with the documented order; update pre-flight (K1-K4: tags, origin item of the same
  chat, own copy, attendees/recurrence, cancelled, etag/updated baseline + `sameContent`) runs on a fresh `get-event`; fresh
  free/busy minus own block; `allowDuplicates:false`; edit budget per event from `auto_writes` (retention 180 d >> any
  reachable event, so no reset); cancels only with `scope.cancels` and >= 24 h; F2 earlier-move rule.
- Undo: single path through `approveAs` (same gates as a click), candidate CAS on `reverted_by`, idempotency on `revertOf`,
  baseline on the newest revision, `user_toast` only for automatic writes; replay of an automatic write is impossible (one
  decision per action, deterministic create event id, terminal states).

## Findings

### auto-mode-1 (major) - the toast's Undo says "Calendar change undone" when nothing was undone
`src/main/compose.ts:644-649`:
```ts
onUndo: (autoWriteId) => {
  void executor.undoAuto(autoWriteId, 'user_toast', null)
    .then((r) => { notifier.autoUndone(r.ok); ... })
```
`undoAuto` answers `ok:true` for every outcome that got past the pre-checks - `needs_confirm_conflict`, `needs_confirm_drift`
and `failed` (CAL_EVENT_GONE, CAL_UPDATE_FAILED, an unknown outcome) included (`actionExecutor.ts:1390-1403` returns
`approveAs`'s Result as is). So `autoUndone(true)` shows "Calendar change undone" although the event is still where the automatic
write put it. `runUndo` has already raised its own toast via `notifyAuto({kind:'undo'})` -> `notifier.autoUndone(w.undoState
=== 'undone')` (`compose.ts:1600-1602`), so the user gets "undo failed" immediately followed by "Calendar change undone" (the
last word is the false one); on a real success the user gets two "undone" toasts.
- Scenario (proven, scratch `auto-mode-1`): automatic reschedule Wed 15:00 -> Thu 17:00; something is booked on Wed 15:00;
  toast Undo -> `undoAuto` = `{ok:true, value:{outcome:'needs_confirm_conflict'}}`, event still on Thursday, `auto_writes.
  undo_state='available'`, toast text "Calendar change undone". The toast is the primary undo door for a user who is not looking
  (B11); believing the change is reverted, they never open the card that still waits for "add anyway".
- Fix: in `onUndo` drop the second toast (notifyAuto already reports the result from `undo_state`), or call
  `autoUndone(r.ok && r.value.outcome === 'done')`.

### auto-mode-2 (major) - an automatic create whose readback failed can never be undone, and the policy keeps writing
`runCreate` marks the action `done` even when the readback `get-event` fails (`actionExecutor.ts:566-586`); the rev-1 row then
has `post_etag = post_updated = NULL` (`exec/outcome.ts:99-100`). For an automatic write, `runUndo` treats a missing baseline as
"changed in Google": `noBaseline || moved` -> every write `blocked_changed`, `ACTION_STALE`, zero calls
(`actionExecutor.ts:1343-1353`). Nothing pauses the policy (only `unknown_outcome` does, `:1213`).
- Scenario (proven, scratch `auto-mode-2`): one transient MCP failure on the readback right after an automatic create ->
  `tryAuto` = `{verdict:'auto', result:'done'}`; the event is live and untouched; `undoAuto(...,'user')` = `ACTION_STALE`,
  `undo_state='blocked_changed'` (copy: "You changed this event in Google after it was added - undo would overwrite your
  change", which is false), policy still `on`. The B10/B11 promise "every automatic write is undoable" is broken for that write.
- Fix (any of): on the automatic path a create without a readback ends `unknown_outcome` (=> `circuit_breaker_unknown` pause and
  reconcile records the baseline); or record the baseline by a second `get-event` before reporting `done`; or in `runUndo`, for
  an automatic create whose baseline is missing, accept the pre-flight when its tags are this write's (`waAction` = the
  action id) and its content equals `newest.next`, using the pre-flight etag as If-Match.

### auto-mode-3 (minor) - per-chat opt-out and taint set while `tryAuto` awaits its Google reads are ignored
`tryAuto` builds the whole `AutoGateInput` (chat row, budgets, snapshot, track record) BEFORE its awaits
(`actionExecutor.ts:1015-1067`), then awaits `getEvent` / `readBusy` (`:1073-1093`) and runs the full gate on the same stale
`input` with only `now`, the reads and `updateSurfaceAvailable` refreshed (`:1094-1100`). The DB trigger re-checks only the
policy state / expiry. Nothing re-reads `chats.auto_policy` / `auto_tainted_until` before the write-ahead.
- Scenario (proven, scratch `auto-mode-3`, both tests): during the fresh free/busy read the user clicks "Never automatic for this
  contact" (`chat:setPolicy {autoPolicy:'never'}`) - or undoes an earlier automatic write of the same chat, which taints it
  (`actionExecutor.ts:1295`) - and the automatic create is still written. B8 lists both as eligibility rules; B9 says the
  executor re-checks "with fresh reads".
- Fix: inside the decision transaction (`:1160`) re-read `repos.chats.byId(a.chatId)` and the auto budgets (and
  `snapshotSha()`), and fall back (`chat_opted_out` / `chat_tainted` / `auto_budget` / `snapshot_changed`) on a change.

### auto-mode-4 (minor) - undos of automatic writes never count in `auto_chat` / `auto_global`
C2 rate rules (`docs/specs/v2-contracts.md:340`), B9 and G31: "creates + edits + undos of automatic writes count together" in
the auto buckets. Only `tryAuto` records them (`actionExecutor.ts:1196-1197`); the undo goes through `approveAs` ->
`approveUpdate`, which records `create_global` only (`:836-849`).
- Scenario (proven, scratch `auto-mode-4`): automatic create + its undo -> `auto_global` = 1 and `auto_chat` = 1 (expected 2).
  The global 4/h and `globalPerDay` budgets therefore allow more automatic churn than specified (the chat budget is moot after an
  undo because of the 7-day taint, the global one is not).
- Fix: in `runUndo`, when `automatic`, record `auto_chat` / `auto_global` in the same transaction as the undo's write-ahead.

### auto-mode-5 (minor, fail-closed) - the D-068 picture gate can never open
D-068: picture items may be automatic once `FEATURE_GATES[p].imagesPassed`. But every picture that contributed text gets the
badge `from_image` (`agent/readImage.ts:184`, `agent/orchestrator.ts:774`, persisted by `agent/validate.ts:244`), whose severity
is `info` (`shared/types.ts:158`), and AutoGate rejects any non-result badge (`exec/autoGate.ts:161-163, 205` -> `badge_info`)
before it reaches `media_derived`. The unit test that shows `imagesPassed => ok` (`exec/autoGate.test.ts:309-313`) uses an image
item WITHOUT the badge, a state S4 never produces for a readable picture.
- Scenario (proven, scratch `auto-mode-5`): triggerKind `image` + badges `['from_image']` + `imagesPassed:true` -> `badge_info`.
  Safety direction is closed; the decided feature is unreachable and the green unit test hides it.
- Fix: decide whether `from_image` is a result-style badge for AutoGate (exempt it like `AUTO_RESULT_BADGES` when
  `imagesPassed`), or record that D-068 does not apply to pictures; make the unit test use the badge S4 actually writes.

### auto-mode-6 (major) - the policy's account binding is absent in practice, and the "known account" precondition is dead code
`snapshotSha()` hashes `googleAuth.wizardState().accountEmail` (`compose.ts:1554-1563`). `accountEmail` is in-memory, starts
`null` (`mcp/googleAuth.ts:165`) and is set only by `pollAccount()` (`:208-215`), called from `startSignIn` and `status()`;
`status()` is reachable only through IPC `google:status`, which no renderer code calls (`renderer/src/api.ts:122`
`getGoogleStatus` has no caller). So after every restart that is not followed by a fresh sign-in, `googleAccountEmailSha8` is
`''`. The contract says `''` must refuse with `AUTO_CALENDAR_NOT_OWNED` (`shared/schemas.ts:351`), and `autoPolicy.ts:162-163`
tries to enforce it with `SHA256_HEX.test(deps.snapshotSha())` - but compose always returns `sha256Hex(...)`, which always
matches, so the check never fires.
- Consequences (code-path traced, no scratch test - the value lives in the compose closure):
  1. A policy enabled after any restart is bound to account `''`: the user disconnects, signs in to a different Google account
     (in-session the email becomes B, so a `tryAuto` in that session would pause `snapshot_changed`), restarts -> the hash is
     `sha('')` again, equal to the stored one -> automatic writes continue into account B's `primary` (also an `owner` role)
     with no new dialog. B7 binds the grant to the account precisely to require a fresh dialog here.
  2. The reverse: a policy enabled in the sign-in session (onboarding: sign in -> 3 approvals -> enable) is bound to the real
     email; after the first restart the hash differs -> the first `tryAuto` pauses `snapshot_changed`, `auto:resume` is refused
     (`autoPolicy.ts:268`) and `requestEnable` refuses while a live row exists (`:159`): the user must Stop and re-enable.
- Fix: persist the account e-mail hash (e.g. `meta`) at sign-in / on every successful `pollAccount`, poll the account once at
  startup when the host is connected, and make `snapshotSha()` return a non-hash (or `precondition()` refuse) when the account
  is unknown.

### auto-mode-7 (minor, design-level) - the native enable dialog never sees the scope the renderer submits
`auto:requestEnable` takes `scope` from the renderer (`shared/ipc.ts:133`); `requestEnable` passes only
`{calendarName, trial, validityDays, endsOn}` to the dialog (`exec/autoPolicy.ts:197-202`), whose detail is six fixed bullets
(`app/autoDialog.ts:108-140`). `cancels:true` and `quietHours:null` are stored in the immutable grant
(`autoPolicy.ts:212-230`) without ever appearing in what the user confirmed.
- Scenario (proven, scratch `auto-mode-7`): `requestEnable({scope:{...default, cancels:true, quietHours:null, validityDays:90}})`
  -> live policy with automatic cancels at any hour; the dialog input has no cancels / quiet-hours field. B7's threat model ("a
  renderer compromise ... must not be able to flip it") makes the native dialog the trust anchor; for the two widening toggles
  it is not.
- Fix: pass the scope to `confirmEnable` and add a bullet for `cancels:true` and for "no quiet hours" when they differ from the
  defaults (both locales).

### auto-mode-8 (major) - "Resume" on an app-paused TRIAL turns real automatic writes on
`trg_auto_policies_state` forbids returning to `shadow` (`db/migrations.ts:205`), so `resume()` always sets `on`
(`exec/autoPolicy.ts:273`). For a paused trial it only requires >= 3 tally decisions (`:270-272`; `shadowTally.decisions` counts
fallbacks too). The Settings page shows a paused trial as "Paused - {reason}" + [Resume] (`renderer/src/views/settings/
AutomaticMode.tsx:155-157, 222-238`) - nothing says the trial will end. A trial is paused by the app, not the user (the shadow
branch has no Pause button): `calendar_disconnected`, `unattended`, `snapshot_changed`.
- Scenario (proven, scratch `auto-mode-8`): trial with 3 decisions -> calendar briefly disconnects -> paused -> user clicks
  Resume -> state `on` -> the next eligible proposal is written automatically. The user never clicked "Turn on for real"
  (`auto:endShadow`) nor "Turn on now"; B7/F34: "nothing else ever produces `on`". The existing unit test
  `exec/autoPolicy.test.ts:312-318` encodes this behaviour, so the fix must change that test deliberately.
- Fix: a paused trial whose shadow was never ended resumes only through `auto:endShadow` semantics (UI shows "Turn on for real"
  for a paused trial), or `resume()` refuses it with a code the UI maps to "End the trial or stop".

## Not findings (checked, deliberately left out)
- `chat:setPolicy {autoPolicy:'inherit'}` is not focus-gated: matches B28 / FOCUS_GATED_CHANNELS as designed.
- The update 412 on the automatic path ends `failed ACTION_STALE` + a pending clone with `driftShown` pre-armed instead of a
  `fallback modified_in_google` decision row: deviation from ARCH-v2 7 wording, but every further step is a click.
- Retry clones of failed automatic writes: `tryAuto` refuses `retry_of`, so they are always clicks.
- `lastFocusAt` is in-memory: after a restart of a policy older than 7 days the first tick pauses `unattended` unless the
  window is focused first - fail-closed.
