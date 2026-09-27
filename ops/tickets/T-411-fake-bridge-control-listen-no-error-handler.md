# T-411 — fake bridge control listen no error handler

**Kind:** post-v1 (test hygiene) · **Status:** todo · **Raised by:** `reverify / final-e2e`

## Problem
tests/fakes/fake-bridge.ts control.listen() has no error handler (reverify.md secondary hardening); a port collision would surface as an unhandled error instead of a clear failure.

## Log
| Date | Event |
|---|---|
| 2026-09-27 | Filed from workflow ④ residuals |
