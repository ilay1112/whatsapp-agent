# T-404 — spawn refused shows preparing forever

**Kind:** post-v1 (UX bug) · **Status:** todo · **Raised by:** phase-3 fix group `Repair confirmed defects in src/renderer/src` (see its notes in `ops/agent-notes/`)

## Problem
A real BRIDGE_SPAWN_REFUSED makes the pairing poller emit status unavailable, which toPanelState maps to preparing, so the Link-WhatsApp step shows Preparing a code... for ever instead of the refusal reason. Found by the renderer fix group.

## Log
| Date | Event |
|---|---|
| 2026-09-27 | Filed from the phase-3 fix round residuals |
