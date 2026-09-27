# T-407 — cal port busy has no action

**Kind:** post-v1 · **Status:** todo · **Raised by:** phase-3 fix group `fix-src-main-compose-line-550` (see its notes in `ops/agent-notes/`)

## Problem
port_busy renders with no button because ERROR_ACTION.CAL_PORT_BUSY is none (shared/errors.ts, frozen in contracts.md) while ARCHITECTURE says the intended UX is a retry. Needs a contract amendment.

## Log
| Date | Event |
|---|---|
| 2026-09-27 | Filed from the phase-3 fix round residuals |
