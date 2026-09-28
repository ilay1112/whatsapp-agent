# T-607 — V2-W1-07-media-voice

**Wave:** 1 · **Status:** todo · **Owner:** build agent `V2-W1-07-media-voice`

## Goal
Media fetch, image normalise, Ogg/Opus/WAV, whisper job, voice service, manifests.

## Brief (single source of truth)
`docs/specs/v2-build-plan.md` → heading `V2-W1-07-media-voice`. Global rules: v1 `docs/specs/build-plan.md` §1 + v2-build-plan deltas.

## Owns
- `src/main/media/**`
- `src/main/voice/**`
- `src/main/bridge/** except bridgeDb.ts, waReadClient.ts`
- `src/main/agent/stage0.ts`
- `src/main/llm/local/{manifest,download}.ts`
- `src/main/ipc/handlers/voice.ts`
- `tests/fakes/{fake-bridge.ts,whisper-cli.mjs,ogg-fixtures.ts}`
- `tests/golden/voice.jsonl`
- `scripts/{fetch-whisper.mjs,pin-models.mjs,gen-voice-fixtures.ps1}`
- `vendor/{models,whisper}.pin.json`
- `tests/security/media-isolation.test.ts`
- `tests/integration/{pipeline-voice,media-fetch}.test.ts`

## Acceptance
- gguf-download.test.ts unchanged and green
- hostile Ogg set => precise codes, zero spawns; >300 s predicted => zero spawns
- fetch-whisper/pin-models tests with injected fetch; no network
- 100/95/100 on media/fetch, imageDims, voice/ogg

## Log
| Date | Event |
|---|---|
| 2026-09-28 | Ticket created from the finalised v2 build plan |
