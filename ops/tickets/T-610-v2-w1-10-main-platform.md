# T-610 — V2-W1-10-main-platform

**Wave:** 1 · **Status:** todo · **Owner:** build agent `V2-W1-10-main-platform`

## Goal
IPC register + handlers, preload, item view models, paths, health.

## Brief (single source of truth)
`docs/specs/v2-build-plan.md` → heading `V2-W1-10-main-platform`. Global rules: v1 `docs/specs/build-plan.md` §1 + v2-build-plan deltas.

## Owns
- `src/main/ipc/{register,sender,register.fixtures}.ts`
- `src/main/ipc/handlers/{app,items,settings,secrets,llm,model,pairing,google,data}.ts`
- `src/preload/**`
- `resources/links.json`
- `src/main/agent/items.ts`
- `src/main/{paths,logger,secrets,testSeams}.ts`
- `src/main/app/{window,protocol,autostart,i18n}.ts`
- `src/main/health/**`

## Acceptance
- IPC contract tests for all 24 new channels
- zero new allow-listed keys in the key-name regex test
- register/sender 100/95/100

## Log
| Date | Event |
|---|---|
| 2026-09-28 | Ticket created from the finalised v2 build plan |
