# T-603 — V2-W1-03-edit-pipeline

**Wave:** 1 · **Status:** todo · **Owner:** build agent `V2-W1-03-edit-pipeline`

## Goal
Delta pipeline, self trigger, prompts v2, S4 v2, orchestrator, golden sets.

## Brief (single source of truth)
`docs/specs/v2-build-plan.md` → heading `V2-W1-03-edit-pipeline`. Global rules: v1 `docs/specs/build-plan.md` §1 + v2-build-plan deltas.

## Owns
- `src/main/agent/{existingEvent,resolveDelta,extract,prompt,contextBuilder,validate,orchestrator,queue,gates,sanitize,minimize,dateTable,replyLang}.ts (+ X.<suffix>.test.ts)`
- `src/shared/when.ts`
- `tests/fakes/stub-llm.ts`
- `tests/helpers/goldenLoader.ts`
- `tests/golden/** except images/**, images.jsonl, voice.jsonl, MEDIA_MANIFEST.json`
- `tests/integration/pipeline-edit.test.ts`

## Acceptance
- every B20 rule incl. R13 has a table row
- 27 edit rows pass scripted on local (+ CLI fakes when available)
- prompt.size.test.ts and I4' purity green
- resolveDelta.ts 100/95/100

## Log
| Date | Event |
|---|---|
| 2026-09-28 | Ticket created from the finalised v2 build plan |
