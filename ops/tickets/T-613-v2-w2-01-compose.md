# T-613 — V2-W2-01-compose

**Wave:** 2 · **Status:** todo · **Owner:** build agent `V2-W2-01-compose`

## Goal
Composition root v2 and repo-wide green.

## Brief (single source of truth)
`docs/specs/v2-build-plan.md` → heading `V2-W2-01-compose`. Global rules: v1 `docs/specs/build-plan.md` §1 + v2-build-plan deltas.

## Owns
- `src/main/index.ts`
- `src/main/compose.ts`
- `src/main/notImplemented.ts`
- `tests/helpers/harness.ts`
- `tests/integration/** (fix-up)`
- `src/shared/** (locale fold-in, contract fixes by decision)`
- `root configs`
- `src/main/llm/scripted.fixtures.ts`
- `fix-up right on src/**`

## Acceptance
- lint, typecheck, npm test green with ledger v2
- scripted golden v2 green
- no NotImplementedError reachable

## Log
| Date | Event |
|---|---|
| 2026-09-28 | Ticket created from the finalised v2 build plan |
