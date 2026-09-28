# Agent notes - v2-build-plan (spec agent)

Date: 2026-09-28. Output: `docs/specs/v2-build-plan.md`. Second attempt ("Try again"); no partial file from the first attempt existed.

## Inputs read
- `docs/ARCHITECTURE-v2.md` (all), v1 `docs/specs/build-plan.md` (sections 1-8), `docs/specs/v2-tests.md` (0-15 + concerns), `docs/specs/v2-contracts.md` (intro, 16.1, 17-19, concerns, block index), `docs/specs/v2-ux.md` (0, 12, 13, concerns), `docs/specs/v2-pipeline.md` (outline + 4.4), live `src/` / `tests/` / `scripts/` tree (file names only), `package.json` scripts, `src/shared/i18n/resources.ts` (fragment mechanism still present).
- Nothing was executed; no vendor CLI, no binary, no network. The bridge store was not touched.

## Shape chosen
- W0 scaffold (contracts verbatim, migration v4 + runner, prompt constants, stubs, seams doc, test infra, locales, opus-decoder only after approval).
- Wave 1 = 12 packages: db, calendar-mcp, edit-pipeline, exec-auto, wa-toolserver, claude-cli (+ JobRunner/reaper), media-voice (+ manifest/downloader), vision, antigravity (dispatched last), main-platform (IPC/preload/view models/paths/seams/health), renderer-dashboard, renderer-settings (+ shell + locales).
- Wave 2 = compose, security, e2e, packaging (v1 order kept).

## Ownership decisions (why)
- JobRunner/reaper with claude-cli: heaviest consumer; first deliverable unblocks voice + agy.
- manifest.ts/download.ts with media-voice; llamaServer --mmproj with vision: splits `llm/local/**` by file name.
- `draft.ts` implements all three loops in claude-cli so antigravity owns only its provider file + fake.
- W0 pastes every verbatim prompt constant (S1 v2, S3 v2, V1, addenda) -> removes the L3/L8 byte-constant dependency.
- `contextBuilder.ts` stays with edit-pipeline (imageText consumed as a typed value object) - resolves the ARCH2 15 overlap L3/L8.
- `stage0.ts` + `ingest.ts` with media-voice (media triggers).
- `items.ts` (ItemService view models) with main-platform, `item:undoChange` delegates to exec-auto's `undo.ts`.
- Lane-authored v2 integration/security tests: owned by the lane in Wave 1, inherited by W2-01/W2-02 in Wave 2; v1 files frozen in Wave 1.
- MEDIA_MANIFEST.json single owner = vision; voice commits no media (in-memory Oggs, SAPI WAVs outside the repo).
- Injection corpus JSON: all v2 families authored by wa-toolserver (v1 precedent: toolGate owner owned the corpus).

## Spec conflicts settled in the plan (section 8)
1. Ogg generator path: T2 `tests/fakes/ogg-fixtures.ts` vs C2 17 `tests/helpers/ogg.ts` -> T2.
2. Test pictures: T2 `tests/golden/images/` vs C2 17 `tests/fixtures/images/` -> T2.
3. `claudeExePath`: C2 (cli:pickExe only) wins over T2 5 ("one allow-listed key") -> zero new allow-listed keys.
4. agy proposals always `cli_unproven` (T2 concern 1) assigned to edit-pipeline's `providerClassOf`.
5. `prev_json` after Apply anyway = pre-flight readback (T2 concern 7).

## Open for the orchestrator
- Approve or reject `opus-decoder@0.7.12` before W0 runs.
- Accept `WCA_DIALOG_SCRIPT` as a seam (T2 concern 8).
- Fail-closed golden gates vs settings defaults (C2 concern 20).
- UX2 C9 / C15 / C18 contract gaps (builders follow specs as written).
- Record section 8 decisions + section 1.3 new files in `ops/DECISIONS.md`.

## REQUESTS
- none (plan-only agent).
