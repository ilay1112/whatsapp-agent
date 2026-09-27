# T-409 — wca timers scanms doc clarity

**Kind:** orchestrator · **Status:** todo · **Raised by:** `final-e2e`

## Problem
WCA_TIMERS.scanMs shortens the triage-queue scan, not the 30 s ingest timer (LIMITS.scanIntervalMs, compose.ts ~L1359); TESTS 4.2 does not say which scan it means. Clarify docs/specs/test-strategy.md 4.2 (orchestrator-owned).

## Log
| Date | Event |
|---|---|
| 2026-09-27 | Filed from workflow ④ residuals |
