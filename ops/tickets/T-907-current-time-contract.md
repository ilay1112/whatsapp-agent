# T-907 — "Adding events is paused" (CAL_UNAVAILABLE) right after a successful Google sign-in

**Status:** done (2026-10-19) — see PROGRESS 83, D-088
**Owner:** orchestrator + Opus worker (`ops/agent-notes/current-time-contract-fix.md`)

## Symptom (user, 2026-10-19)
Onboarding step 5 shows "Connected to Google Calendar" + the account, and at the same time the banner
"Replies still work; adding events is paused" with "Go to step 1".

## Root cause (log + vendored server source + audit log)
- `main.log`: `google.signin_started` → stderr marker `token_saved` (+6 s) → `google.signin_failed code="CAL_UNAVAILABLE"` (+2.4 s), no `mcp.call_failed`.
- `startSignIn()` runs a smoke `get-current-time` after the account turns active; `projectCurrentTime` requires the key `timeZone`.
- The real server (@cocal/google-calendar-mcp 2.6.3, `GetCurrentTimeHandler`) answers `{currentTime, timezone, offset, isDST, dayOfWeek}` — `timezone`, lowercase.
  The projection returns BAD → `bad_response` → CAL_UNAVAILABLE. The fake server emitted `timeZone`, so the suite never saw it.
- `audit_log` on this PC has no `google_signin accepted` row ever (only credentials / disconnect since 2026-09-23): the real smoke never passed.
  The calendar still worked because the account was active; only the post-sign-in self-check failed, and the wizard showed both states at once.

## Fix
- `projectCurrentTime` accepts `timezone` and `timeZone`; the fake server now mirrors the real 2.6.3 shape; `contracts.md` corrected.
- Smoke retried up to 5× at the poll interval for transient kinds; `google.smoke_failed {kind, attempt}` logged; host logs `mcp.tool_error {tool, marker}` (marker names only).
