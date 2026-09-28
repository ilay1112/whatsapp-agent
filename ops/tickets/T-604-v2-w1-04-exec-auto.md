# T-604 — V2-W1-04-exec-auto

**Wave:** 1 · **Status:** todo · **Owner:** build agent `V2-W1-04-exec-auto`

## Goal
Executor v2, AutoGate, policy, chain undo, dialogs, toasts, ledger v2.

## Brief (single source of truth)
`docs/specs/v2-build-plan.md` → heading `V2-W1-04-exec-auto`. Global rules: v1 `docs/specs/build-plan.md` §1 + v2-build-plan deltas.

## Owns
- `src/main/exec/**`
- `src/main/ipc/handlers/{actions,auto}.ts`
- `src/main/app/{notifications,tray,autoDialog}.ts`
- `tests/helpers/{ledger,ledger-hook}.ts`
- `tests/mocks/electron.ts`
- `tests/fakes/obedient-attacker-llm.ts`
- `tests/security/{auto-mode.*,editing.*}.test.ts`
- `tests/integration/{auto-mode.flow,editing-executor,recovery-v2}.test.ts`

## Acceptance
- group 17 chain tests: auto-edit x2 + undo x2 => first from, 2 PATCHes, policy paused; Restore original one PATCH; move to now+2h01 undone at now+3h
- group 22 chain: create->change->change / ->undo / ->cancel->undo one PATCH each, no CAL_EVENT_FOREIGN
- AutoGate table covers every reason incl. content_rejected and multiple_events
- 100/95/100 on autoGate, autoPolicy, undo, buildUpdateEventArgs, auto handlers, actionExecutor

## Log
| Date | Event |
|---|---|
| 2026-09-28 | Ticket created from the finalised v2 build plan |
