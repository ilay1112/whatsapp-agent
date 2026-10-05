# d080-renderer - D-080 renderer side (CLI error card actions, guided sign-in session UI, locales, voiceIntent wipe)

Label: d080-renderer. Scope: src/renderer/**, src/shared/locales/**. Main side: `d080-cli-main` (built in parallel).

## Start state (2026-10-05)
- Working tree had no renderer edits from the earlier (usage-limited) attempt; started from scratch.

## What changed
1. **Every CLI error card carries its ONE action** - new `src/renderer/src/components/cliSignIn.ts`:
   - `runCliErrorAction(t, provider, code)` dispatches on `ERROR_ACTION[code]`: sign_in / sign_in_again -> store `signIn`
     (cli:signIn for that provider), choose_model -> focus `#connect-model-<provider>`, export_diagnostics, test_again,
     copy_install/update_command, open_ai_settings (CLOUD_QUOTA claude -> usage page, else focus the overage row).
   - `cliErrorActionLabel` (CLOUD_QUOTA keeps its two special labels; 'none' -> no button).
   - ChooseAi's "Use"/"Continue" error card (`ai-use-error-<p>`) now shows title + body + action button
     (`ai-use-error-action-<p>`) + "Still using: ...". The sign-in action is disabled while a session is open/retesting.
   - ConnectCard's own error rows use the same dispatcher (`connect-error-action-<p>`); CARD_CODES += CLI_MODEL_REJECTED.
2. **Sign in moved to the cli store** (`signIn`, `signInError`, `signInStartedAt`, `clearSignInWait`) so the Connect card and
   the ChooseAi card start the same thing and the v2 poll fallback is shared.
3. **Guided sign-in session UI** (ConnectCard): reads main's `CliStatus.signIn` through `signInSessionOf()`:
   - `open` -> data-state `sign_in_open`, line "A sign-in window opened. Finish signing in there - the app will test again
     when it closes." (no Sign in button: one console at a time);
   - `retesting` -> `sign_in_retesting`, "Testing {{cli}}...";
   - `done` + ok -> `connect-session-ok-<p>` "Signed in - {{cli}} works."; + failure with a known code -> that code's row
     with its action (CLI_NOT_SIGNED_IN instead flips the state line to not signed in + Sign in); + failure without a known
     code -> `connect-session-failed-<p>` (role=alert) + Sign in.
   - no `signIn` field (older main) -> the v2 10 s poll / 5 min fallback, unchanged.
4. **Never "signed in" after a CLI_NOT_SIGNED_IN result**: ConnectCard gets `lastError` (ChooseAi's last failed Use). Any of
   lastError / the active provider's health code / a failed Run-a-test / the session outcome == CLI_NOT_SIGNED_IN turns a
   stale `ready` (or `unknown`) into `not_signed_in` with Sign in; "Use" is disabled. A later passing session wins over the
   renderer-held results (not over main's health code - main clears that). ChooseAi drops its stale CLI_NOT_SIGNED_IN /
   CLOUD_AUTH card when the provider's session ends ok (store subscription, no setState-in-effect).
5. **CLI_MODEL_REJECTED -> Choose another model**: the compact (onboarding) card shows the model control when the last
   Use / the active code / the session outcome is CLI_MODEL_REJECTED, so the action always has a control to focus.
6. **"Unlink and erase" clears `wca.voiceIntent`** (closeout-renderer REQUEST 5): Settings `confirmDialog('wipe')` calls
   `setVoiceIntent(null)` on success only.
7. Locales (en + he): `cli.session.{open,retesting,ok,failed}`, `errors.CLI_MODEL_REJECTED.{title,body,action}`.

## Main's session field (as landed by d080-cli-main in src/shared/types.ts)
`CliStatus.signIn?: CliSignInSession = { phase: 'idle'|'open'|'retesting'|'done'; outcome: { ok; code: ErrorCode|null; at } | null }`,
ABSENT while idle. `signInSessionOf` reads it typed but re-validates (a push is data): absent / 'idle' / unknown phase ->
null; unknown code -> failure without a code (never a pass). First draft read `state` before main's type existed; switched
to `phase` once main's tests showed the shape.
- Once a session has been seen for a provider, the v2 10 s poll fallback (store `signInStartedAt`) is cleared for good, so
  it cannot reappear when main drops the field back to idle. `cli:signIn`'s new `alreadyOpen` answer needs nothing extra:
  the card renders the pushed phase.

## Verification (2026-10-05, after main landed errors.ts / types.ts)
- `npx vitest run --project renderer`: 66 files, 1120 tests passed (incl. ConnectCard.signin 20, ChooseAi.signin 11,
  store/cli +2, Settings wipe +2). Failing-first: 10 red before the implementation (3 of them stayed red until main added
  ERROR_ACTION.CLI_MODEL_REJECTED - by design, not weakened).
- `npx vitest run src/shared/locales src/renderer/src/i18n`: 53 passed (key parity, he translated, placeholders, no dead keys).
- `npm run lint`: exit 0. `prettier --check src/renderer/src src/shared/locales`: clean.
- `npm run typecheck`: tsconfig.web.json clean; the remaining errors are in main's in-progress files
  (src/main/llm/cli/runner.ts errorTextBeforeInit / classifyErrorBeforeInit, tests/integration/agy-provider.test.ts
  FakeAgyMode) - not renderer, owned by d080-cli-main.
- One assertion of mine was wrong at first ("not.toHaveTextContent('signed in.')" also matches "... not signed in.");
  replaced by the ready-line pattern /Ready - |, signed in./ - a test fix, not a weakening.

## For the orchestrator / e2e (T-903)
- New test ids: `ai-use-error-action-<p>`, `connect-error-action-<p>`, `connect-session-ok-<p>`,
  `connect-session-failed-<p>`; data-state `sign_in_open` / `sign_in_retesting` on `connect-<p>`.
