# T-403 — settings reconnect cannot revive dead calendar host

**Kind:** post-v1 · **Status:** todo · **Raised by:** phase-3 fix group `fix compose.ts breaker-reset wiring` (see its notes in `ops/agent-notes/`)

## Problem
Settings -> Reconnect (google:startSignIn) calls admin.manageAccounts(add) directly and returns unavailable while client === null; it never restarts the MCP host, so a dead calendar host cannot be revived from Settings.

## Log
| Date | Event |
|---|---|
| 2026-09-27 | Filed from the phase-3 fix round residuals |
