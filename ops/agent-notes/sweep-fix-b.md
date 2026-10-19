# sweep-fix-b: UI sweep findings 3, 5, 6, 7 (2026-10-19)

Scope: `ops/agent-notes/ui-sweep.md` Findings 3, 5, 6 and 7. This builds on `google-connect-fix.md`: the busy and error states, the host restart and the token purge are all kept. No commit or push.

## Finding 3: Settings said "Not connected" after every launch
- **Cause:** Settings read `google:getWizardState`, the in-memory snapshot. After a restart its `accountEmail` is null. Settings never called `google:status`.
- **Renderer (`Settings.tsx`):**
  - On mount, Settings calls `google:status` (deferred through `Promise.resolve()` so no state is set synchronously inside the effect) and no longer calls `getWizardState`. While that call is in flight the row shows `settings.calendar.checking`.
  - A failed result or a rejected call shows the existing `settings-google-error` line.
  - A `google:changed` push whose status is `connected` but has no e-mail keeps the last known e-mail on screen and calls `google:status` again. A push that carries the e-mail is applied as is.
  - Account text, in priority order: the e-mail; "Connected" (status `connected`, e-mail unknown); `errors.CAL_RECONNECT.title` (status `reconnect_required`); otherwise "Not connected".
  - Button: "Connect" when there is no account (the existing `settings.calendar.reconnect` key, which `AutomaticMode` also uses, so its value is unchanged). The new `settings.calendar.reconnectAction` ("Reconnect") is shown for `connected` and `reconnect_required`. When connected the button is `btn-quiet`; otherwise it is `btn-outline`. Test ids are unchanged; the account span gained `data-status`.
- **Main (`googleAuth.status()`):**
  - No `manage-accounts list` while the host is not in `CALLABLE`. The last known e-mail is kept.
  - Concurrent calls share one in-flight list.
  - The host emits only on a status change, so the loop push → `status` → push is bounded.

## Finding 5: Claude "Sign in" inside Settings showed nothing
- **Cause:** `cli:signIn` answers only after main pushed the `open` phase. `push()` calls `status.get()`, which re-probes the CLI (`auth status`) whenever the status cache has expired (60 s in production, 1 s with the e2e FAST_TIMERS). Settings is usually open for longer than that; onboarding mounts the card fresh, so the cache is warm there.
  - The card only changed state once the answer arrived, which took seconds.
  - The embedding itself was fine: same store, and App subscribes to `cli:changed`.
- **Fix (`ConnectCard.tsx`):** a local `signInPending` flag is set on the click. `uiState` becomes `waiting_sign_in` while the call is pending, even when an earlier `done` session is on the status. A pushed `open` or `retesting` phase still wins. A refusal ends the pending state and shows the refusal row.
- I did not change `cli.ts`. It would also be reasonable for main to answer before the re-probe (`void push`), but that file is not mine.

## Finding 6: voice Test without a model
- `VoiceNotes.tsx`: Test is disabled unless `voice.model.status` and `vad.status` are both `ready`. Main's `selfTest` needs both and returns `ok:false` at once otherwise. While disabled, the reason line `settings-voice-test-needs-model` is shown and referenced by `aria-describedby`.
- A run shows "Testing..." and then either the speed line or the `settings-voice-test-error` line (role `alert`, `settings.voice.testFailed`). The error line clears on the next run.
- `voice:selfTest` returns no error code, so the error line is generic.

## Finding 7: the last conflict calendar
- `toggleConflictCalendar` sets `settings-conflict-min-one` (role `status`, `settings.calendar.conflictMinOne`) when a click is refused, and clears it on the next accepted change.

## Locale keys (en and he; targeted edits)
- `settings.calendar.{checking, connected, reconnectAction, conflictMinOne}`
- `settings.voice.{testNeedsModel, testFailed}`

## Tests
- `Settings.v3.test.tsx`
  - `paint` now mocks `google:status`.
  - The busy-then-success case now expects "Reconnect".
  - New Google cases: connected (e-mail shown, quiet Reconnect, `getWizardState` not called), connected with no e-mail, `needs_sign_in`, `reconnect_required`, "Checking…", a failed status, a rejected status, and push handling.
  - New conflict hint case.
  - New embedded Claude Sign-in case. It fails without the ConnectCard fix.
- `ConnectCard.signin.test.tsx`: full and compact wait-on-click; a prior `done` session; a refusal; a pushed `open` phase taking over.
- `VoiceNotes.test.tsx`: disabled with a reason, VAD missing, Testing… then the speed, a failure then a clear, an IPC failure. The existing Test case now uses a ready model.
- `googleAuth.test.ts`: no round trip while not callable; concurrent calls share one list.
- `Settings.test.tsx.snap` (RTL) updated for the intended changes: the default mock is connected without an e-mail, so the row reads "מחובר" with a quiet Reconnect; and the voice reason line appears.

## Verification
- `npx vitest run src/renderer/src/views src/renderer/src/components/ConnectCard* src/main/mcp src/main/voice src/shared src/renderer/src/i18n.usage.test.ts`: 53 files, 1550 tests passed. Also passed with the `google` and `voice` handler tests: 55 files, 1564 tests.
- `npm run -s typecheck`: exit 0. `npm run -s lint`: exit 0. Prettier was run on every touched file.

## Not done / for the orchestrator
- The sweep e2e (`tests/e2e/sweep`) was not re-run. Its visible-change detector blanks live regions, and the ConnectCard state line is `role=status`. In the sweep, finding 5 will therefore show up through the removed Sign in button and `data-state`, not through the text.

## Addendum: Finding 4 renderer side (coordinator request)
- `Settings.tsx`: "Remove the rule" (`settings-policy-remove-<n>`) now calls a new `removeRule(chatRef)`. It sends `api.setChatPolicy({ chatRef, removeRule: true })` and then re-lists. `api.ts` needed no change: `setChatPolicy` takes `IpcReq<'chat:setPolicy'>`, which already includes the new union member. The per-row policy SELECT still sends `{policy}` (see sweep-fix-a).
- Tests:
  - New `Settings.v3.test.tsx` case "Remove the rule": the IPC call is `{chatRef: 8, removeRule: true}` (never `{policy:'default'}`), and the row is gone after the refreshed list.
  - `Settings.v2.test.tsx`: the old `{policy:'default'}` assertion for Remove now expects `removeRule: true`.
- i18n dead-key test: `i18n.usage.test.ts` passes (7/7). All six new keys are referenced: `settings.calendar.{checking, connected, reconnectAction, conflictMinOne}` in `Settings.tsx`, and `settings.voice.{testNeedsModel, testFailed}` in `VoiceNotes.tsx`.
- Re-verified: the requested suite passes (53 files, 1551 tests). `typecheck` and `lint` exit 0. Prettier was run on the touched files.
