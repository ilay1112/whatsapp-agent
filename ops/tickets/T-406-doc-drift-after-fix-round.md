# T-406 — doc drift after fix round

**Kind:** orchestrator · **Status:** done · **Raised by:** phase-3 fix group `fix-src-main-exec; fix src/main/bridge` (see its notes in `ops/agent-notes/`)

## Problem
Docs still describe the pre-fix eventId derivation: contracts.md ~1372 and ~1753, build-plan.md ~212, ARCHITECTURE.md I7 row (~76). ARCHITECTURE A14 needs the last_online_ts qualifier on the 24 h sync cap (correctness-pipeline-4). docs/proposals/ux.md:108 asks for an already-answered-from-phone chip that the renderer does not read. Orchestrator-owned.

## Log
| Date | Event |
|---|---|
| 2026-09-27 | Filed from the phase-3 fix round residuals || 2026-09-27 | contracts.md ×4, build-plan.md ×1, ARCHITECTURE I7 patched to the content-bound eventId. A14 NOT changed: it already carries the last_online_ts qualifier ([R2]); the collision was in compose.ts (armed `syncing` on every start) and was fixed in code by correctness-pipeline-4. |
