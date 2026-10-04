# v2-fix: compose.ts snapshotSha / Google account binding (auto-mode-6)

Agent label: `v2-fix-src-main-compose.ts (snapshotSha) together with src`. Date: 2026-10-04.

## Finding

auto-mode-6 [major]: CONFIRMED by my own trace and fixed.

- `googleAuth`'s `accountEmail` lived only in memory. It started as null and was set only by `startSignIn`/`status()` (pollAccount). `status()` has no renderer caller.
- compose hashed a null account as `googleAccountEmailSha8: ''` and still returned a valid sha256. So `autoPolicy.precondition()`'s `SHA256_HEX` guard could never fire. That breaks the contract (v2-contracts C2 5 / schemas.ts:351: "'' when unknown => AUTO_CALENDAR_NOT_OWNED").
- Scenario 1: a policy enabled after a restart stays valid after an account switch plus a restart. Scenario 2: a policy enabled in the sign-in session is paused `snapshot_changed` after a restart. Both reproduced by the new test against the real `createGoogleAuth`.

## Fix (smallest surface)

1. `src/main/mcp/googleAuth.ts`: a new optional extra, `GoogleAuthExtras.persistAccount(email | null)`.
   - Every pollAccount answer goes through `setAccount()`, which sets the in-memory e-mail and persists it. `disconnect()` persists null.
   - Persisting is wrapped in try/catch, so a failure never breaks the wizard. It logs `google.account_persist_failed` with no data.
2. `src/shared/types.ts`: `META_KEYS += 'google_account_sha8'`. It holds the 8-hex googleAccountEmailSha8 of the last account answer, or `''` when there is none. The e-mail itself is never stored.
3. `src/main/compose.ts`: two exported pure helpers, used by compose and by the test.
   - `persistGoogleAccount(meta)` maps the e-mail to `meta.google_account_sha8`.
   - `createAutoSnapshotSha({accountEmail, meta, targetCalendarId, provider, appVersion})` uses the live e-mail first, then the persisted sha8 (only if it is exactly 8 hex).
   - When the account is unknown it returns `''`, not a hash. autoPolicy then refuses AUTO_CALENDAR_NOT_OWNED, and AutoGate can never match a stored snapshot (fail closed).
   - The inline `snapshotSha` closure is replaced by this factory. googleAuth is wired with `persistAccount: persistGoogleAccount(repos.meta)`.

### Where I differ from the reviewer's proposed fix

- **Persistence and "unknown => non-hash": both done.**
- **Startup account poll: NOT done.** With persistence it is not needed for B7. Inside the product the 'personal' account changes only through `startSignIn`, which persists via pollAccount, or through `disconnect`, which persists null. Both paths now write meta.
  - A startup poll would also add an async admin call at launch.
  - Until that call finished, the snapshot would be `''`, which would pause a live policy on the first tryAuto. That is the scenario-2 break again, caused by a race.
  - Possible follow-up: poll on the host's transition to `connected` and persist the result. It would catch a tokens.json swapped by hand outside the app. This is not required for this finding.

## Tests (written first, red before the fix)

- New: `src/main/compose.autoSnapshot.test.ts` (5 tests). It uses the real `createGoogleAuth` with a scripted admin facade (synthetic `@example.test` e-mails) and an in-memory meta. A "restart" is a new service over the same meta. It covers:
  - an unknown account gives a non-hash;
  - scenario 2: same snapshot after a restart;
  - scenario 1: disconnect gives a non-hash, account B gets a different snapshot, and after a restart it is still B's and never A's again;
  - case-insensitive matching, and meta never holds the e-mail;
  - a corrupt persisted value is treated as unknown.
- `src/main/mcp/googleAuth.test.ts`:
  - The harness's override type is widened to `GoogleAuthDeps & GoogleAuthExtras`.
  - New describe "[V2] B7 account persistence (auto-mode-6)" with 3 tests: status and disconnect persist; sign-in persists; a persistence failure never breaks the wizard.

## Fixture updates required by the fix (they simulate a profile that "signed in once")

- `tests/helpers/harness.ts`: when `calendarMode === 'connected'`, it also seeds `google_account_sha8` via `persistGoogleAccount(repos.meta)('user@example.test')` (the fake's synthetic account), next to the existing `calendar_roles_json` seed. Without this, every compose-level auto-mode integration test was refused AUTO_CALENDAR_NOT_OWNED, which is correct behaviour for an unknown account.
  - Another agent also added a fallback seed (`'0a1b2c3d'` when the key is empty) to `tests/integration/auto-mode.flow.test.ts` while I worked. I did not touch that file. The fallback is harmless because the harness seed makes the key non-empty.
- `tests/e2e/helpers/auto.ts` (`launchAutoWorld`): seeds the same meta key (sha8 of the fake's `user@example.test`, computed with node:crypto). It sits next to `calendar_roles_json` and uses the existing `meta` option of seedProfile. **Not run:** I did not run e2e because it launches the Electron GUI. The orchestrator should run `auto-mode.spec`, `undo.spec` and `i18n-rtl.spec` (screens-auto). Without this seed those specs' `enableAutoViaUi` would now be refused.

## Verification

- `npx vitest run tests/security/auto-mode* tests/integration/auto-mode.flow.test.ts src/main/exec/autoPolicy.test.ts src/main/ipc src/main/mcp src/main/compose* src/main/db/repos`: 62 files, 919 tests, all pass.
- eslint and prettier are clean on every file I touched. Typecheck shows no errors in my files.
- Typecheck errors elsewhere at run time come from other agents' in-flight edits: `src/main/llm/cli/runner.ts` (TS2783 duplicate env keys) and `src/renderer/src/views/settings/VoiceNotes.test.tsx` (`voiceIntent`).
- Wider `vitest run src/main src/shared tests/security tests/integration` had failures I traced to other agents' concurrent work, not to this change:
  - `actionExecutor.v2fix.test.ts` (a new red-first file);
  - `actionExecutor.test.ts` / `pipeline-happy` (`closedReason` null);
  - `media-text-isolation` (voice job status);
  - `backup.test.ts` / `migrations.v4.test.ts` (migration failure path).
  - None of them touches the snapshot, googleAuth or the new meta key.

## Spec follow-up (orchestrator)

- v2-contracts.md META_KEYS should add `google_account_sha8`, with its meaning: the 8-hex googleAccountEmailSha8 of the last manage-accounts answer, `''` = none, written by googleAuth.persistAccount through compose. I did not edit the docs.
- Upgrade note: a policy enabled on a pre-fix v2 build before any sign-in has a snapshot built with account `''`. It now pauses `snapshot_changed` and needs a re-enable. That is fail-closed and v2 has not shipped.
