# T-606 — V2-W1-06-claude-cli

**Wave:** 1 · **Status:** todo · **Owner:** build agent `V2-W1-06-claude-cli`

## Goal
JobRunner, CLI locator/runner, Claude CLI provider, draft loops, cli handlers.

## Brief (single source of truth)
`docs/specs/v2-build-plan.md` → heading `V2-W1-06-claude-cli`. Global rules: v1 `docs/specs/build-plan.md` §1 + v2-build-plan deltas.

## Owns
- `src/main/proc/**`
- `tests/fakes/fake-child.mjs`
- `src/main/llm/cli/{locator,runner,claudeCli}.ts`
- `src/main/llm/{factory,consent}.ts`
- `src/main/agent/draft.ts`
- `src/main/ipc/handlers/cli.ts`
- `tests/fakes/{fake-claude-cli.mjs,fake-claude-cli.types.ts}`
- `tests/helpers/cli-fakes-hook.ts`
- `tests/security/{cli.sandbox,cli-env-poisoning}.test.ts`
- `tests/integration/cli-provider.test.ts`

## Acceptance
- argv/env literal tests per stage incl. U-C7 keys
- StructuredOutput passes on schema runs, fails on S3, never a strike
- cli:signIn argv exactly [exe,'auth','login','--claudeai'] shell:false; hostile paths refused
- runner builders/assertInit 100/95/100

## Log
| Date | Event |
|---|---|
| 2026-09-28 | Ticket created from the finalised v2 build plan |
