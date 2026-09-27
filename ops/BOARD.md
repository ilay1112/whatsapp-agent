# Ticket board

Status: `todo` · `doing` · `review` · `done` · `blocked`. Details in `ops/tickets/`.

## Phase 0 — setup

| ID | Title | Owner | Status |
|---|---|---|---|
| T-001 | Scout reference bridge + environment | orchestrator | done |
| T-002 | Architecture option dialog with user | orchestrator | done |
| T-003 | Install toolchain (Node, Git), init repo | orchestrator | done |
| T-004 | Project ops/ knowledge area + CLAUDE.md | orchestrator | done |

## Phase 1 — research + design (workflow ①, run wf_1004b6e0-b2d)

| ID | Title | Owner | Status |
|---|---|---|---|
| T-010 | Research ×10 → `docs/research/` | 10 research agents | done |
| T-011 | Architecture proposals ×3 + synthesis → `docs/ARCHITECTURE.md` | 4 agents | done |
| T-012 | Specs: contracts, UX, agent pipeline, test strategy | 4 agents | done |
| T-013 | Build plan with strict file ownership | 1 agent | done |
| T-014 | Adversarial design critique ×3 + finalize (4 resumes) | 4 agents | done |
| T-015 | Orchestrator review gate; packages → tickets T-1xx | orchestrator | done |

## Phase 2 — build (workflow ②) — tickets in `ops/tickets/`

| ID | Package | Wave | Status |
|---|---|---|---|
| T-100 | W0-scaffold | 0 | done |
| T-101 | W1-01-proc-health | 1 | done |
| T-102 | W1-02-bridge-process | 1 | done |
| T-103 | W1-03-bridge-ingest | 1 | done |
| T-104 | W1-04-db | 1 | done |
| T-105 | W1-05-mcp-calendar | 1 | done |
| T-106 | W1-06-llm-cloud | 1 | done |
| T-107 | W1-07-llm-local | 1 | done |
| T-108 | W1-08-shared-utils | 1 | done |
| T-109 | W1-09-agent-guard | 1 | done |
| T-110 | W1-10-agent-pipeline | 1 | done |
| T-111 | W1-11-exec | 1 | done |
| T-112 | W1-12-shell-main | 1 | done |
| T-113 | W1-13-ipc-preload | 1 | done |
| T-114 | W1-14-renderer-shell | 1 | done |
| T-115 | W1-15-renderer-dashboard | 1 | done |
| T-116 | W1-16-renderer-setup | 1 | done |
| T-117 | W2-01-compose-integration | 2 (step 1) | done |
| T-118 | W2-02-security-gate | 2 (step 2) | done |
| T-119 | W2-03-e2e | 2 (step 2) | done (16/22 e2e; 6 failures handed to phase 3) |
| T-120 | W2-04-packaging | 2 (step 3) | done |

## Phase 3 — test, review, fix (workflow ③)

| ID | Title | Owner | Status |
|---|---|---|---|
| T-300 | Full test run (unit, integration, safety, i18n, E2E, packaging smoke) | agents | done (workflow ③ reverify + acceptance run) |
| T-301 | Adversarial code review (multi-lens) + verification of findings | agents | done (45 raw → 38 confirmed / 7 refuted) |
| T-302 | Fix confirmed findings, re-verify | agents | done (55 fixes, 16 groups) |
| T-303 | Final acceptance vs original request + manual real-world checklist for the user | orchestrator | done — ACCEPTED at code level; M1–M16 remain the user's |

## Phase 4 — close-out (workflow ④, run wf_619acb69-597)

| ID | Title | Owner | Status |
|---|---|---|---|
| T-310 | e2e test-seam defects (4) + fixture hand-offs | final:e2e-seams | done (22/22, run twice) |
| T-311 | L3 regression test consent→bridge-start; fake-bridge reviveDate; coverage exclude glob | final:hygiene | done |
| T-312 | Final proof run of the whole pipeline | final:proof | done — ALL GREEN |

## Residuals / post-v1 (from the phase-3 fix round) — details in `ops/tickets/`

| ID | Title | Kind | Status |
|---|---|---|---|
| T-401 | Edited create-event retry can leave two events (no update/delete in v1) | product decision | todo |
| T-402 | Latched llama breaker has no user-reachable retry | post-v1 | todo |
| T-403 | Settings → Reconnect cannot revive a dead calendar host | post-v1 | todo |
| T-404 | BRIDGE_SPAWN_REFUSED shows "Preparing a code…" forever | post-v1 UX bug | todo |
| T-405 | Executor failure paths still do ungrouped writes | post-v1 | todo |
| T-406 | Doc drift after the fix round (eventId derivation, A14 qualifier) | orchestrator | done |
| T-407 | CAL_PORT_BUSY has no action (contract says none, ARCH says retry) | post-v1 | todo |
| T-408 | WCA_TIMERS.debounceMs does not reach the triage queue (~20 s per scripted e2e) | post-v1 test seam | todo |
| T-409 | WCA_TIMERS.scanMs doc clarity (which scan) | orchestrator | todo |
| T-410 | Dirty state survives a successful approval of an edited draft | product decision | todo |
| T-411 | fake-bridge control.listen() has no error handler | post-v1 test hygiene | todo |
