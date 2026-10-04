# V2-W1-08-vision - builder notes

Package: `V2-W1-08-vision` (Wave 1 of the v2 build). Brief: `docs/specs/v2-build-plan.md` section 7 `### V2-W1-08-vision`.
Status: **DONE for Wave 1** (second attempt, 2026-09-29). The first attempt (interrupted) had landed most source deltas; this attempt
fixed its type errors, finished the sources, and wrote every test, the golden pictures and the manifest.

## What is in the tree (owned paths only)

| File | What |
|---|---|
| `src/main/agent/readImage.ts` | `routeImage` (C2 15 signature; F29: `imagesPassed` never changes the route; `local` / `antigravity_cli` never take the provider route), `readerOf`, `localIsoWithOffset`, `buildReadImageSystemPrompt` (= `buildSystemPrompt({stage:'read_image'})` of prompt.ts, the only system-prompt builder), `buildReadImageUserText` (P2 4.4 text: `now:` line, nonce block `{today, caption}`, closing line), `toImagePart` (the ONLY `LlmImagePart` builder), `buildReadImageMessages` (image FIRST), `imageBadgesOf` (P2 4.5 + F29), `createReadImageStage` (the V1 stage: structured only, IMAGE_READ_SCHEMA, purpose `read_image`, 768 tokens, one repair turn incl. on a provider `bad_output`, one CLI code fence stripped, wall clock 180 s local / 120 s other, caller abort, runs row + `finishCli` sandbox proof, a CLI read with a failed proof is discarded), `readImageStage` (frozen default = fail-closed `no_route`), `newestImageRow`, `createPickImage` (getMedia -> normalise (header gate before S-IMAGE) -> media cache; audits `media_rejected` without text). 100 % lines / 100 % branches / 100 % functions. |
| `src/main/agent/resolve.ts` | P2 7.4 `image_absolute`: `resolveImageDate` (year 0 = next occurrence on/after today; invalid calendar date; weekday word mismatch), `imageBranchApplies`, `resolveExtractionWithImage` (S1 date inside the 14-day table wins, disagreement => `conflict`; S1 time wins, the PM half of an ambiguous bare hour is not a conflict; range => duration; title/location stay S1's; `resolveWhen` unchanged). The v1 `resolveExtraction` is untouched. |
| `src/main/llm/claude.ts` / `gemini.ts` | `loop`, `capabilities.images:true`; `toClaudeContent` (base64 image block) / `toGeminiContent` (Interactions `{type:'image', data, mime_type}` - the Interactions twin of `inline_data`, SDK 2.23.0 `ImageContent`); a picture is refused (`unsupported`) on any purpose but `read_image` and on every `chat()`; the structured request never carries tools. |
| `src/main/llm/local.ts` | `image_url` data-URL parts (order kept), `LOCAL_IMAGE_SCHEMA_NAME`, `capabilities.images` = live `runtime.vision().ready`; a picture is sent only on `read_image` after the lazy start confirmed vision; `chat()` refuses pictures. |
| `src/main/llm/local/llamaServer.ts` | `buildVisionArgs` (C2 9.1 literal: `--mmproj <file> --mmproj-device none --image-max-tokens 1120`, tiny 560, mid + `--batch-size 2048 --ubatch-size 2048`), `LlamaRuntimeDeps.imagesEnabled` / `mmprojPath` (optional), readiness probe `GET /props` -> `modalities.vision === true` (only the boolean leaves the probe), `LlamaRuntime.vision()` {requested, ready, stale}. |
| `src/main/llm/local/supervised.ts` | a child whose picture flags went stale is restarted through `supervisor.restart('llama')` (pid file + backoff stay authoritative). |
| `src/main/llm/__fixtures__/{claude/image-read-turn.json, gemini/image-read-interaction.json}` | hand-written, `_unverified: true`, synthetic. |
| `tests/fakes/fake-llama-server.ts` | T2 3.8 v2: `checkVisionArgv`, `/props` vision, `image_url` parts recorded by sha, `when.imageSha256` / `purpose 'read_image'`, `vision_with_tools`, `image_without_vision`, `vision_garbage`, GGML bodies for `*.bin`; child mode gains `--fake-rules <file>` and `--fake-journal <file>` (argv line + one structure-only line per chat request; `onCompletion` option). |
| `scripts/gen-golden-images.mjs` (+ `.test.mjs`) | the 24 picture specs (single source), HTML templates (no script, CSP `default-src 'none'`), `images.jsonl` + `MEDIA_MANIFEST.json` writers, verify mode. Default mode only VERIFIES (so `npm run gen:fixtures` never regenerates); `--render` relaunches under the project's Electron (offscreen, JavaScript off, sandbox, every non-`data:` request cancelled); `--index` rewrites the two index files. |
| `tests/golden/images/*` (24), `images.jsonl`, `MEDIA_MANIFEST.json` | 8 printed he, 6 printed en, 4 mixed calendar screenshots, 2 script-font, 4 injection; 3 JPEG re-encodes (`img-he-03`, `img-en-02`, `img-mix-02`); 636 KB total; rendered ONCE on 2026-09-29, pinned by sha256. |
| `tests/security/vision-no-tools.test.ts` | group 21 (V1 half): request/argv per provider through the production stage (local over the fake llama, Claude/Gemini over recording SDK doubles, `claude_cli` over the real CliRunner + spawned fake CLI, agy => Local), V1 never calls `chat()`/`runAgentic()`, providers refuse pictures on `chat()`, source grep (only `readImage.ts` builds `{type:'image', mime}`; only it and `types.ts` name `LlmImagePart` in code), bombs/GIF/WebP/10 MiB+1/polyglot/truncated never reach the S-IMAGE facade, the 4 injection pictures => `suspicious` => `manipulation` (scripted). 21 tests green. |
| `tests/integration/pipeline-image.test.ts` | Part A (12 green): the real chain fake bridge `/api/media` -> readClient -> media/fetch -> imageDims/normalizeImage -> mediaCache -> V1 -> S2 -> badges, per provider (Local = the REAL llama runtime spawning the fake llama child with `--mmproj`, `/props` vision), plus the fail-closed paths. Part B (5, through the harness): **BLOCKED-BY V2-W2-01** (harness option `media` throws NotImplemented). Part C: loader counts. |

Tests I extended: `claude.test.ts`, `gemini.test.ts`, `local.test.ts`, `local/llamaServer.test.ts`, `local/supervised.test.ts`, `agent/resolve.test.ts`
(all owned via rule 8). New: `agent/readImage.test.ts` (55 tests).

## Verification (2026-09-29)

- `npm run typecheck`: clean (all three projects).
- `npx eslint <my paths> --max-warnings 0`: clean. `prettier --check` clean on my files (HEAD was clean, so I formatted my own files only).
- `vitest --project main`: 163 files / 4342 passed (whole project). Coverage of my sources: readImage.ts 100/100/100, supervised.ts 100 %, resolve.ts 100 % lines / 99 % branches, claude/gemini/local/llamaServer 100 % lines, >= 92 % branches.
- `vitest --project security tests/security/vision-no-tools.test.ts`: 21/21.
- `vitest --project integration tests/integration/pipeline-image.test.ts`: 12 passed, 5 failed = Part B only, all with `NotImplemented: harness option "media"` (BLOCKED-BY V2-W2-01).
- Full security / integration runs show failures in files I do not own (agy.sandbox, injection-corpus image/voice/wa_row families, agy-provider, cli-provider Part B, pipeline-edit, pipeline-wa-tools, pipeline-voice Part B) - all pre-compose / other lanes; none touches a path of mine.

## Decisions / assumptions (for the orchestrator)

1. **System prompt**: V1 uses `buildSystemPrompt({stage:'read_image', nowIso: <local ISO with offset>, ...})` (W1-03's prompt.ts, `SYSTEM_PREFIX_READ_IMAGE` = V1 constant + CLI JSON-only line) instead of a private builder, so the "system content only from prompt.ts" rule and the I4' pins hold. `replyLang`/`userGender` are passed but not rendered for `read_image`.
2. **Timeout ErrorCode**: `ErrorCode` has no LLM timeout code; a V1 wall-clock expiry is recorded in `runs.error_code` as `providerErrorToErrorCode(p, 'network')` (= `LLM_LOCAL_FAILED` / `CLOUD_UNAVAILABLE`), outcome `failed`; the stage returns `image_unread / timeout`. A caller abort is `aborted` / `ABORTED`.
3. **`mmprojReady`** (ReadImageDeps.local) = "images enabled AND the selected tier's projector file is ready" (a disk fact). The child confirms vision through `/props` on its lazy start; if it does not, `local.structured()` throws `unsupported` and V1 returns `image_unread / no_route` (never a text-only guess). `LlmProvider.capabilities.images` of Local = the live `/props` readiness.
4. **Repair turn** also after a provider `bad_output` throw (non-JSON), not only after a zod failure - P2 4.4 "one repair retry" read literally for both shapes.
5. **Gemini wire**: the v1 Gemini provider is on the Interactions API, so the picture is `{type:'image', data, mime_type}` in the `user_input` content (C2 9 says `inline_data`, the generateContent name of the same thing). UNVERIFIED like every other Gemini fixture.
6. **Golden cases** (`images.jsonl`): S1 is scripted to name NO date/time (title/location only, `missing:['date','time']`) so the date/time come from the picture digits through S2 `image_absolute`; the `read_image` rule matches by **purpose only** (V1 sees the normalised JPEG, whose bytes depend on the nativeImage in use, so a file-sha rule would never match); badges assume the shipped all-false gates (`from_image` + amber `image_unclear`, + `manipulation` on the 4 injection rows); injection rows still expect a manual `create_event` (v1 S4: suspicious keeps the proposal, red badge). The extract rule is FIRST (goldenLoader.stubExtractionOf reads the first structured rule). `category` = `image_<group>` so the live runner can score the 20 non-injection pictures and the 14 printed ones separately (T2 concern 9).
7. **Rendering**: `scripts/gen-golden-images.mjs --render` ran the project's own Electron 44.4.3 (`node_modules/electron`) once, offscreen, data: URLs only - as the brief orders. While debugging an early silent exit I also ran `electron.exe --version` once; nothing else was executed. No network was used.
8. `gates.ts` untouched (all gates `false`). No new dependency, no locale key added (W0 seeded `image.*`).

## REQUESTS

- **V2-W1-03-edit-pipeline** (`orchestrator.ts`, `contextBuilder.ts`, `validate.ts`, `golden.v2.test.ts`):
  1. `runChat`: after V0 and before S1, `const img = await deps.pickImage(chatId, window)`; when non-null `deps.readImage({chatId, itemId, image: img, captionSanitised, nowMs, timeZone, nonce}, signal)` (a caller abort => abandon the run). Link the `media_cache` row to the item (`repos.mediaCache.upsert({...row, itemId})`).
  2. S1 data block: `imageText` = `sanitizeForModel(read.readText)` cut to `LIMITS.messageChars` + `imageKind` on the picture's own row (P2 4.5).
  3. S2: replace `resolveExtraction(x, ctx)` by `resolveExtractionWithImage(x, outcome.ok ? outcome.read : null, ctx)` (same `ResolvedSlot` + `imageMerge`).
  4. S4: `imageBadges = imageBadgesOf(outcome, outcome.ok ? readerOf(outcome.route, provider.id) : provider.id, (p) => deps.featureGates(p).imagesPassed)`; plus `conflict` when `imageMerge.conflict`, `image_unclear` when `imageMerge.unclear`; `mediaTexts` += the sanitised `readText`; `imageRead` = the read; `proposals.image_json = {waMsgId, route: 'local'|'api_key'|'cli', read, ms}`.
  5. `alreadyRead(chatId, waMsgId)` for `createPickImage` = a proposal of the chat whose `image_json.waMsgId === waMsgId` with a successful read (P2 4.1 refinement).
  6. golden.v2 runner: image cases are in `tests/golden/images.jsonl` (see decision 6).
- **V2-W2-01-compose**: wire `createReadImageStage` / `createPickImage` (all deps are injected; see the `ReadImageDeps` / `PickImageDeps` doc comments), `createLlamaRuntime({... imagesEnabled: () => settings.images.enabled, mmprojPath: () => <models dir>/mediaLocalFileName('mmproj-<tier>') when its models row is ready, else null})`, `createSupervisedLlama({supervisor /* with restart */, runtime})`; `consentCurrent(p)` = `consents.isCurrent(CONSENT_KIND_FOR[p])` at the version naming pictures (B21); implement the harness `media` option so `pipeline-image.test.ts` Part B runs.
- **Orchestrator / V2-W1-04-exec-auto**: with the shipped gates every picture proposal carries the AMBER `image_unclear` (F29); `AUTO_REASONS` evaluates `badge_amber` before `media_derived`, so AutoGate will report `badge_amber` where T2 7.2 item 3 expects `media_derived`. Either order is fail-closed; the expectation needs one decision.
- **Orchestrator**: consider an ErrorCode for a V1 / LLM wall-clock expiry (decision 2).

## BLOCKED-BY

- `V2-W2-01`: `tests/integration/pipeline-image.test.ts` Part B (5 tests) - harness option `media` + V1 wiring in `compose()`.
