# T-605 — V2-W1-05-wa-toolserver

**Wave:** 1 · **Status:** todo · **Owner:** build agent `V2-W1-05-wa-toolserver`

## Goal
ToolSpec table, ToolGate v2, WhatsApp read tools, loopback tool server.

## Brief (single source of truth)
`docs/specs/v2-build-plan.md` → heading `V2-W1-05-wa-toolserver`. Global rules: v1 `docs/specs/build-plan.md` §1 + v2-build-plan deltas.

## Owns
- `src/main/agent/{toolDefs,toolGate,waTools,handles}.ts (+ X.<suffix>.test.ts incl. toolGate.corpus.test.ts)`
- `src/main/bridge/{bridgeDb,waReadClient}.ts`
- `src/main/mcp/toolServer.ts`
- `tests/fakes/{fake-bridge-db.ts,fake-mcp-client.ts,mcp-client-core.mjs,fake-wa-read-client.ts}`
- `tests/helpers/waWorld.ts`
- `tests/security/{tool-server,wa-tools}.test.ts`
- `tests/security/injection-corpus.{he,en}.json`
- `tests/integration/pipeline-wa-tools.test.ts`
- `tests/bench/**`

## Acceptance
- probe matrix 404/405/reset with zero gate calls, never 401/403
- initialize + tools/list + tools/call in one run
- projection sweep and toLcd byte identity
- 100/95/100 on toolServer, waTools, handles, waReadClient

## Log
| Date | Event |
|---|---|
| 2026-09-28 | Ticket created from the finalised v2 build plan |
