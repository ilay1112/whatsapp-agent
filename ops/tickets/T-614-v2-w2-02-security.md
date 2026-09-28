# T-614 — V2-W2-02-security

**Wave:** 2 · **Status:** todo · **Owner:** build agent `V2-W2-02-security`

## Goal
Security gate groups 1-25.

## Brief (single source of truth)
`docs/specs/v2-build-plan.md` → heading `V2-W2-02-security`. Global rules: v1 `docs/specs/build-plan.md` §1 + v2-build-plan deltas.

## Owns
- `tests/security/**`
- `tests/setup-guards.ts`

## Acceptance
- npx vitest run --project security green, no skips

## Log
| Date | Event |
|---|---|
| 2026-09-28 | Ticket created from the finalised v2 build plan |
