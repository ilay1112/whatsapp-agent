# T-608 — V2-W1-08-vision

**Wave:** 1 · **Status:** todo · **Owner:** build agent `V2-W1-08-vision`

## Goal
V1 READ-IMAGE, image route, image_absolute, llama --mmproj, picture golden set.

## Brief (single source of truth)
`docs/specs/v2-build-plan.md` → heading `V2-W1-08-vision`. Global rules: v1 `docs/specs/build-plan.md` §1 + v2-build-plan deltas.

## Owns
- `src/main/agent/{readImage,resolve}.ts`
- `src/main/llm/{claude,gemini,local}.ts`
- `src/main/llm/local/** except manifest.ts, download.ts`
- `src/main/llm/__fixtures__/**`
- `tests/fakes/{fake-llama-server.ts,image-fixtures.ts}`
- `tests/golden/{images/**,images.jsonl,MEDIA_MANIFEST.json}`
- `scripts/gen-golden-images.mjs`
- `scripts/fetch-llama.mjs`
- `vendor/llama.pin.json`
- `tests/security/vision-no-tools.test.ts`
- `tests/integration/pipeline-image.test.ts`

## Acceptance
- V1 snapshot per provider has no tools
- 4 injection pictures => manipulation
- imagesPassed=false still reads with amber badge
- readImage.ts 100/95/100

## Log
| Date | Event |
|---|---|
| 2026-09-28 | Ticket created from the finalised v2 build plan |
