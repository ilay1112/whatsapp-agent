# T-401 — edited retry leaves two events

**Kind:** product decision · **Status:** todo · **Raised by:** phase-3 fix group `fix-src-main-exec (W1-11)` (see its notes in `ops/agent-notes/`)

## Problem
After an EDITED create-event retry the calendar can hold BOTH the old event (created by a timed-out attempt) and the newly approved one, because v1 has no update/delete tool (A10). Needs a product decision: accept + surface in the card, or add a gated update-event path.

## Log
| Date | Event |
|---|---|
| 2026-09-27 | Filed from the phase-3 fix round residuals |
