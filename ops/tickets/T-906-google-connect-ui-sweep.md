# T-906 — Google "Connect" does nothing; full UI sweep of every menu and button

**Status:** done (2026-10-19) — see PROGRESS 82, D-087
**Owner:** orchestrator + Opus workers (`ops/agent-notes/google-connect-fix.md`, `ops/agent-notes/ui-sweep.md`)

## Request (user, 2026-10-19)
"connect button doesnt work, use tools with screen shots, open every menu and test every button to see that its opening correctly.
fix all menus and buttons that doesnt"

## Google Connect — root cause (from `logs/main.log` + code)
- 16:17 local: key file replaced (`importCredentials` → `host.start()`); 16:18:34 `calendar-mcp` stopped = **Disconnect**.
- `disconnect()` stops the MCP host and keeps the credentials; `startSignIn()` then calls `manageAccounts('add')` on the stopped host →
  `unavailable` → `CAL_UNAVAILABLE`, **never logged**; Settings does `r.ok && setGoogle(...)` so the failure is invisible and there is no busy state.
- Fix: `startSignIn()` starts the host first (same mapping as `importCredentials`), logs `google.signin_failed {code}`; Settings shows
  "Signing in…" and an inline error line (`settings-google-error`) for Connect / Replace key / Disconnect.

## UI sweep
- Playwright `_electron` sweep spec `tests/e2e/sweep/sweep.spec.ts`: onboarding, dashboard (4 card kinds), Settings (all groups), Activity,
  undo drawer, health panel, card overflow menus + sheet, calendar toolbar; he + en; screenshots in `test-results/sweep/`.
- Result (2026-10-19): 355 controls across 8 states, no renderer console/page errors. Findings: (1) restore after dismiss loses the approval buttons, (2) Analyse again on an in-calendar card makes it vanish, (3) Settings shows Not connected after every launch although the calendar works (the user-facing symptom), (4) Remove the rule does nothing for known contacts, (5) Settings-embedded Claude Sign in shows no state, (6) Voice Test gives no feedback without a model, (7) unchecking the only conflict calendar is silently ignored. Fix pass: worker A = 1, 2, 4 (`sweep-fix-a.md`); worker B = 3, 5, 6, 7 (`sweep-fix-b.md`). Google Connect itself also fixed from Disconnect and from an expired token (`google-connect-fix.md`).

## Note
WhatsApp itself is connected since 16:16 local on the rebuilt bridge (T-905 verified by the user's own run: `qr_phase` → `connected` → `history_sync_done`).

## Progress
- [x] root cause Google Connect  - [x] fix + tests  - [x] sweep report  - [x] sweep fixes  - [x] proof + package + commit
