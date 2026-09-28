# T-609 — V2-W1-09-antigravity

**Wave:** 1 · **Status:** todo · **Owner:** build agent `V2-W1-09-antigravity`

## Goal
Antigravity provider (opt-in, isolated profile, no tools).

## Brief (single source of truth)
`docs/specs/v2-build-plan.md` → heading `V2-W1-09-antigravity`. Global rules: v1 `docs/specs/build-plan.md` §1 + v2-build-plan deltas.

## Owns
- `src/main/llm/cli/antigravityCli.ts`
- `tests/fakes/{fake-agy.mjs,fake-agy.types.ts}`
- `tests/security/agy.sandbox.test.ts`
- `tests/integration/agy-provider.test.ts`

## Acceptance
- global_mcp_present: isolated mode ignores, fallback refuses with no spawn
- Claude envelope rejected by fake-agy
- no mcp_config.json ever; every agy proposal cli_unproven

## Log
| Date | Event |
|---|---|
| 2026-09-28 | Ticket created from the finalised v2 build plan |
