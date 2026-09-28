# T-602 — V2-W1-02-calendar-mcp

**Wave:** 1 · **Status:** todo · **Owner:** build agent `V2-W1-02-calendar-mcp`

## Goal
8-tool contract, update surface, seven-insertion patch (offline).

## Brief (single source of truth)
`docs/specs/v2-build-plan.md` → heading `V2-W1-02-calendar-mcp`. Global rules: v1 `docs/specs/build-plan.md` §1 + v2-build-plan deltas.

## Owns
- `src/main/mcp/** except toolServer.ts`
- `tests/fakes/fake-mcp-calendar.ts`
- `tests/integration/mcp-real-toolslist.test.ts`
- `tests/security/never-delete.test.ts`
- `scripts/stage-calendar-mcp.mjs`
- `vendor/calendar-mcp.{pin,patch}.json`

## Acceptance
- patch step refuses unknown bytes and double patching; seven anchors each found once
- real-vs-fake tools/list parity on --patch-only output
- status_field_absent/ifmatch_absent/etag-less degrade proven with a working create
- no npm ci / network by this package

## Log
| Date | Event |
|---|---|
| 2026-09-28 | Ticket created from the finalised v2 build plan |
