# T-616 — V2-W2-04-packaging

**Wave:** 2 · **Status:** todo · **Owner:** build agent `V2-W2-04-packaging`

## Goal
Whisper fetch, calendar patch staging (network), model pins, smoke 7-12.

## Brief (single source of truth)
`docs/specs/v2-build-plan.md` → heading `V2-W2-04-packaging`. Global rules: v1 `docs/specs/build-plan.md` §1 + v2-build-plan deltas.

## Owns
- `electron-builder.yml`
- `build/**`
- `resources/licenses/**`
- `resources/bridge/**`
- `resources/icons/**`
- `scripts/{smoke-packaged,smoke-packaged.notices,stage-calendar-mcp,hash-bridge,import-bridge,fetch-whisper,pin-models,fetch-llama,make-icons}.mjs`
- `vendor/** except vendor/whatsapp-bridge-src/**`
- `build-resources/calendar-mcp/**`
- `README.md`

## Acceptance
- npm run test:smoke green (checks 1-12, etag in ALLOWED_EVENT_FIELDS of the staged bundle)
- npm run verify exit 0
- nothing vendor-owned under resources, no binary executed

## Log
| Date | Event |
|---|---|
| 2026-09-28 | Ticket created from the finalised v2 build plan |
