# T-405 — executor ungrouped failure writes

**Kind:** post-v1 · **Status:** todo · **Raised by:** phase-3 fix group `fix-src-main-exec` (see its notes in `ops/agent-notes/`)

## Problem
actionExecutor.ts markFailure and markUnknown each perform four ungrouped writes (state transition, audit row, applyFailure, cloneForRetry); the same tearing argument fixed for the success path (data-integrity-6) applies here.

## Log
| Date | Event |
|---|---|
| 2026-09-27 | Filed from the phase-3 fix round residuals |
