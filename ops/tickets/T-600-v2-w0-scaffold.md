# T-600 — V2-W0-scaffold

**Wave:** 0 · **Status:** todo · **Owner:** build agent `V2-W0-scaffold`

## Goal
Scaffold: contracts, migration v4, stubs, fakes interfaces, v1-test approvedBy edits.

## Brief (single source of truth)
`docs/specs/v2-build-plan.md` → heading `V2-W0-scaffold`. Global rules: v1 `docs/specs/build-plan.md` §1 + v2-build-plan deltas.

## Owns
- `everything except docs/** (but docs/specs/v2-wave0-seams.md), ops/** (but its own notes), CLAUDE.md`

## Acceptance
- typecheck/lint/test:unit/build exit 0
- openDb(':memory:') at SCHEMA_VERSION 4 incl. finalisation columns; unixepoch('subsec') probe passes
- C2 checklist 11-31 + v1 1-10 green
- every F18 call-site edit listed in v2-wave0-seams.md; gguf-download.test.ts byte-unchanged
- nothing fetched, no vendor binary executed, stage script not run

## Log
| Date | Event |
|---|---|
| 2026-09-28 | Ticket created from the finalised v2 build plan |
