# T-408 — wca timers debouncems not reaching queue

**Kind:** post-v1 (test seam) · **Status:** todo · **Raised by:** `final-e2e`

## Problem
In every scripted e2e run triage started exactly 20.1 s after the trigger row (= LIMITS.debounceMs) although the spec passes WCA_TIMERS.debounceMs:100; compose.ts ~L892-900 appears to forward it, so the seam is lost somewhere between compose and the triage queue. Costs each scripted e2e ~20 s. Owner: compose/queue.

## Log
| Date | Event |
|---|---|
| 2026-09-27 | Filed from workflow ④ residuals |
