# google-connect-fix — Settings > Google Calendar > Connect does nothing (2026-10-19)

## Root cause (given by the orchestrator, confirmed in code)
- `disconnect()` (`src/main/mcp/googleAuth.ts`) calls `host.stop()`, so the host status becomes `not_configured`. `hasCredentials` stays `true`.
- The next `startSignIn()` went straight to `admin.manageAccounts('add')`. `host.ts` `callerFor` answers `{ok:false, error:'unavailable'}` outside `CALLABLE = ['connected','needs_sign_in','signing_in']`, so the result was `CAL_UNAVAILABLE` with no log line.
- `importCredentials()` calls `host.start()` first. That is why "Replace the key file" still worked.
- Renderer: `Settings.tsx` ignored `!r.ok` and had no busy state, so the click showed nothing at all.

## Fix
- `googleAuth.ts`
  - New export `SIGN_IN_CALLABLE`, which mirrors host.ts `CALLABLE`.
  - `startSignIn()` now calls `host.start()` when the status is not callable, and maps the result the same way `importCredentials` does: `toolset_mismatch` → `CAL_TOOLSET_MISMATCH`, `port_busy` → `CAL_PORT_BUSY`, `unavailable`/`not_configured` → `CAL_UNAVAILABLE`.
  - Every failure return goes through `failSignIn`, which logs `log.warn('google.signin_failed', { code })`. The log carries the code only: no URL, no e-mail, no token.
  - `log.info('google.signin_started', {})` is logged after `openExternal`.
- `Settings.tsx`
  - New `googleBusy: null|'signin'|'replace'|'disconnect'` state. All three buttons are disabled while it is set.
  - While signing in, Connect shows `settings.calendar.signingIn` and has `aria-busy`.
  - New `googleError` state. It renders `data-testid="settings-google-error"` (`role="alert"`) with `errors.<code>.title` plus `errors.<code>.action` when that key exists. The line clears on the next successful call.
  - The Disconnect dialog confirm and Replace the key file go through the same `runGoogle` helper.
- Locales: added `settings.calendar.signingIn` ("Signing in…" / "מתחבר…"). All six error codes already had `.title` and `.action` in both locales, so nothing else was added.

## Tests
- `src/main/mcp/googleAuth.test.ts`, new describe "startSignIn restarts a stopped host". It uses a gated admin that behaves like host.ts.
  - After disconnect, sign-in restarts the host and then calls `add`.
  - An already-callable host is not restarted.
  - `port_busy` from `host.start` → `CAL_PORT_BUSY` with no `manage-accounts` call.
  - `toolset_mismatch`, `unavailable` and `not_configured` from `host.start` are mapped like `importCredentials`.
  - Every failure path logs `google.signin_failed` with its code and never a URL, an e-mail or the secret.
- `src/renderer/src/views/Settings.v3.test.tsx` (6 tests):
  - A failure shows the error title and the action hint.
  - Each code shows its own title.
  - While the promise is pending: busy label, `aria-busy`, all three buttons disabled.
  - Success applies the new state and shows no error line.
  - The error line clears on the next success.
  - A Replace failure uses the same line.

## Verification
- `npx vitest run src/main/mcp src/renderer/src/views src/renderer/src/i18n.usage.test.ts src/shared/locales`: 36 files, 707 tests passed.
- `npm run -s typecheck`, `npm run -s lint` and `npm run -s format:check` all exit 0. Prettier rewrote only my touched files.

## Open / not done (for the orchestrator)
- **`reconnect_required` gap:** host.ts `start()` returns early when `client !== null`, and `reconnect_required` is not in `CALLABLE`. A Connect click from that state still ends in `CAL_UNAVAILABLE`. The difference now is that it shows on screen and in the log instead of failing silently. Fixing it needs a host-level change: let admin `manage-accounts` through in `reconnect_required`, or have `start()` restart in that state. I left host.ts alone because it is out of this ticket's scope.
- `SIGN_IN_CALLABLE` duplicates host.ts `CALLABLE` because that constant is not exported. Exporting it from host.ts would be cleaner.
- No commit or push (subagent rule).

## Follow-up (same day): closing the reconnect_required gap

### Decision: option (b) plus a token purge
I read the vendored server (`build-resources/calendar-mcp/node_modules/@cocal/google-calendar-mcp/build/index.js`) before choosing. Neither literal option works:
- **(a) let `manage-accounts` through on the live child: does not work.** `addAccount` checks the in-memory `context.accounts`. While tokens.json still names `personal`, it returns `status:"already_authenticated"` with no `auth_url`, even when the refresh token is dead. That holds in `reconnect_required`. The adminClient would project that answer to `bad_response`. Removing the account first does not help: `remove` refuses to remove the last account.
- **(b) a bare restart: does not work either.** `loadAllAccounts` re-reads the same dead tokens.json, so the host comes back `reconnect_required`. The existing host test already says "A restart would only re-read the same dead token file".
- **Implemented:** in `startSignIn()`, when the status is `reconnect_required`, it calls `host.stop()`, unlinks tokens.json (the credentials file is never touched), calls `setAccount(null)`, then falls through to the existing start-if-not-callable path and calls `add`. This is the same recovery as Disconnect → Connect, which already worked. No new host API was needed.
- If the host still comes back `reconnect_required` (for example, the unlink failed), sign-in fails with `CAL_RECONNECT` and `add` is not called.
- `persistAccount(null)` during the purge makes automatic mode fail closed (unknown account) until the same account is signed in again, at which point the snapshot matches again.

### Changes
- `host.ts`: `CALLABLE` is now exported (comment explains `reconnect_required` is excluded on purpose). The facade gating is unchanged: read, write and admin are all still refused in `reconnect_required`.
- `googleAuth.ts`: imports `CALLABLE` from `./host`. `SIGN_IN_CALLABLE` is removed. Adds the reconnect purge and the `reconnect_required` → `CAL_RECONNECT` mapping after start.

### Tests
- `googleAuth.test.ts`: the `gated` helper now uses host `CALLABLE`. It also models the real server's `already_authenticated` behaviour: `add` → `bad_response` while the tokens are stale.
  - New: "startSignIn from reconnect_required reaches manage-accounts add (no CAL_UNAVAILABLE)". Asserts the order stop → unlink tokens → start → add, and that the credentials file is never unlinked.
  - New: "a host that comes back still reconnect_required fails with CAL_RECONNECT and never calls add".
- `host.test.ts`:
  - New: "CALLABLE is exactly ... never reconnect_required".
  - New: "in reconnect_required the read AND admin facades stay refused before the server sees a call".

### Verification
- `npx vitest run src/main/mcp src/renderer/src/views src/renderer/src/i18n.usage.test.ts src/shared/locales`: 36 files, 711 tests passed.
- `npm run -s typecheck`: exit 0.
- `npm run -s lint` and `npm run -s format:check` fail, but only on `tests/e2e/sweep/harness.ts` and `tests/e2e/sweep/sweep.spec.ts`. Those belong to the parallel sweep agent and I left them alone. On my changed files, `eslint` and `prettier --check` both exit 0.

### Still open (outside this ticket)
- Connect while the host is already `connected` with an active account would also get `already_authenticated` and fail with `CAL_UNAVAILABLE`. It was not touched here.
- For an account whose refresh failed, the server's `list` reports `status:"active"` whenever a refresh_token exists, even when verification threw. That was not reproduced here because the purge removes the token first.

## Follow-up 2: compose.autoSnapshot.test.ts scenario 1 regression

- **Symptom:** "auto-mode-6 … scenario 1: switching Google accounts changes the snapshot, also after a restart" failed. `startSignIn()` after `disconnect()` returned `{ok:false, error:{code:'CAL_UNAVAILABLE'}}` with the host still `not_configured`. I confirmed this with a temporary print and then restored the file through git.
- **Branch:** the new start-if-not-callable path. The test's fake `host.start()` was `async () => status`, so after `disconnect()` it answered `not_configured`, which maps to `CAL_UNAVAILABLE`, the same mapping as `importCredentials`. The reconnect_required purge and the `CALLABLE` import from host.ts played no part.
- **Verdict: the fake was wrong, not the production code.**
  - The real `McpHost.start()` never answers `not_configured` from a stopped host unless `stop()` races it. It spawns the child and answers `needs_sign_in` or `connected`, or a failure status.
  - The fake's admin also answered while the host was stopped. That is exactly the bug the user hit; the scenario only passed before because the fake hid it.
  - Disconnect → Connect is a legitimate flow and it works against the real host.
- **Fix:** test only. In `src/main/compose.autoSnapshot.test.ts`, the fake `start()` now moves `not_configured` to `needs_sign_in`, as the real host's start-up probe does after disconnect deleted tokens.json. Production logic is unchanged.
- **Verification:**
  - `npx vitest run src/main/compose.autoSnapshot.test.ts src/main/mcp src/renderer/src/views src/renderer/src/i18n.usage.test.ts src/shared/locales`: 37 files, 734 tests passed.
  - `typecheck`, `lint` and `format:check` all exit 0. The sweep files are clean now.
