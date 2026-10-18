# T-905 — WhatsApp bridge rejected as "client outdated"; QR never appears

**Status:** done (2026-10-18) — see PROGRESS 81, D-086
**Owner:** orchestrator + Opus workers (`ops/agent-notes/bridge-outdated-fix.md`, `ops/agent-notes/bridge-rebuild.md`)

## Symptom (user, 2026-10-18)
Settings > WhatsApp shows "connection: starting" and "preparing code…" forever; no QR.

## Root cause (from `logs/main.log`, redacted)
1. The vendored prebuilt bridge (reference build 2026-07-12, whatsmeow 2026-06-04) gets WhatsApp's `ClientOutdated` ~3 s after every connect
   (`client_outdated` marker ×2 → `reconnecting`), then reconnects forever; the reference project's own exe was never rebuilt.
2. The app only showed `BRIDGE_OUTDATED` after exits (breaker / readiness exhaustion); a bridge that stays running while outdated left the UI on
   "starting".

## Fix
- **Bridge rebuilt from the vendored source** on whatsmeow `v0.0.0-20261017175727-b2b1e71d45e2` (go 1.26 floor), via the new `npm run build:bridge`
  (`scripts/build-bridge.mjs`: `go build -trimpath -buildvcs=false`, CGO for go-sqlite3). Toolchain on this PC: Go 1.27 (`winget GoLang.Go`) +
  WinLibs GCC (`winget BrechtSanders.WinLibs.POSIX.UCRT`), both user-approved installs. All hash pins + `resources/bridge/SHA256SUMS` updated.
  `.go` sources unchanged. Pre-existing on Windows: 3 Go tests fail only in TempDir teardown (file lock), same on the old module.
- **Launcher**: a `client_outdated` line while running is confirmed by one `GET /api/health` (503 = genuine; 200 = could be message text, [R2]),
  then terminal + stop + status `outdated` → `BRIDGE_OUTDATED` with "How to update". `resetBreaker()` (Re-link / New code / Wipe) clears it.
- `eslint.config.js` ignores `.claude/**` (another session's worktree broke the repo-wide lint).

## Follow-up (not in this ticket)
- Supervised mode: compose `startBridge()` (plain retry) does not call `resetBreaker()`, so `terminal` sticks until Re-link / New code / Wipe.
- The whatsmeow pin must be refreshed every few months; a release-checklist line in `docs/ACCEPTANCE.md` would help.
