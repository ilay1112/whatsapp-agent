# T-402 — llama breaker no user retry

**Kind:** post-v1 · **Status:** todo · **Raised by:** phase-3 fix group `fix compose.ts breaker-reset wiring` (see its notes in `ops/agent-notes/`)

## Problem
A latched llama-server circuit breaker survives the session: its only start is supervisedLlama.ensureStarted() (automatic per queue item), so no user action can reset it. Bridge and calendar got resetBreaker wiring; llama needs a Retry surface. Also: nothing subscribes to supervisor.onState(llama) so factory.usable() cannot see a failed child.

## Log
| Date | Event |
|---|---|
| 2026-09-27 | Filed from the phase-3 fix round residuals |
