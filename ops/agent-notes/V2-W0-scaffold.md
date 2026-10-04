# V2-W0-scaffold - builder notes

Package: `V2-W0-scaffold` (Wave 0 of the v2 build, runs alone). Brief: `docs/specs/v2-build-plan.md` section 2 (deliverables 1-8),
section 3 (supplementary seams), acceptance under `### V2-W0-scaffold` in section 7. Decisions honoured: D-068 (voicePassed in
`ProviderFeatureGates`, all gates false), D-069, D-070 (opus-decoder@0.7.12 approved), D-071, D-072.

Status: DONE with one recorded spec conflict (R-PROMPT-SIZE, below) and the open items listed under REQUESTS.
The seam index for every later package is `docs/specs/v2-wave0-seams.md`: section 3 seams with their final signatures, owners and
consumers, the W0 refinements, the v1 remnants, the F18 edit list and every v1 test edit. It is not repeated here.

## Deliverable 1 - dependency + tooling

- `npm install --save-exact opus-decoder@0.7.12` (npm 11.17.0): `"opus-decoder": "0.7.12"` in `dependencies` only, exact pin.
- Lockfile delta (compared with a copy taken before the install): exactly four ADDED entries, none removed or changed:
  `opus-decoder 0.7.12 MIT`, `@wasm-audio-decoders/common 9.0.7 MIT`, `simple-yenc 1.0.4 MIT`, `@eshaz/web-worker 1.2.2 Apache-2.0`.
  All production, no install scripts, no `binding.gyp` / `gypfile`, none forbidden (ARCH 16 + ARCH2 12). All in the SPDX allow-list.
- U-V1 import probe, plain Node 24.19.0: `import('opus-decoder')` + `new OpusDecoder({channels:1, sampleRate:16000})` +
  `decodeFrame([0xF8,0xFF,0xFE])` (CELT 20 ms silence frame) -> PASS: 320 samples at 16 kHz, 0 errors, max |x| about 2e-34;
  `typeof Worker` / `typeof window` stay `undefined` before and after the import. The same decode runs in every `npm test`
  (`tests/integration/fakes-v2.test.ts`).
- U-V1 under the e2e Electron main bundle: NOT RUN by W0. Running the e2e Electron main means executing the downloaded Electron
  binary, and the brief forbids executing any downloaded binary; I read that strictly. Deferred to V2-W1-07 (its DoD already names
  "opus-decoder import probe (U-V1) green under Electron main in the e2e build") / V2-W2-03. Nothing in Wave 0 depends on it:
  `voice/decode.ts` is a stub.
- Scripts (T2 14): `fetch:whisper`, `gen:fixtures`, `bench:wa`; `verify` runs `fetch:whisper` before `test:smoke`.
- **bench mechanism**: `vitest.config.ts` adds `tests/bench/**/*.bench.test.ts` to the integration include ONLY when the command line
  names `tests/bench/` (`process.argv` check). Only `npm run bench:wa` passes that path, so `npm test` / `test:int` never collect the
  bench, and nothing is ever skipped conditionally. Until V2-W1-05 writes `tests/bench/wa-bridgedb.bench.test.ts`, `npm run bench:wa`
  exits with "No test files found".
- `.gitignore`: `vendor/whisper/` was already present; added `test-results/golden-*`, and a negation `!src/main/db/__fixtures__/v3.db`
  (the global `*.db` rule would otherwise hide V2-W1-01's committed synthetic v3 fixture).
- `eslint.config.js`: rule-13 boundaries (see seams doc section 2) + fixtures `tests/eslint-fixtures/src/main/exec/autoGate.ts` (6),
  `mcp/toolServer.ts` (8), `llm/cli/bad-imports.ts` (4), `media/bad-imports.ts` (5). DEVIATION: the exec and mcp fixtures are named
  after their target file, because those two rules are file-specific (`exec/autoGate.ts`, `mcp/toolServer.ts`) and a file called
  `bad-imports.ts` can never match them. Expectations added to `tests/security/import-graph.test.ts` part A.
- `vitest.config.ts`: `tests/helpers/cli-fakes-hook.ts` in the integration and security `setupFiles`; T2 13 coverage delta added
  (16 safety-critical files at 100/95/100 perFile; 90/85/90 for `voice/**`, `media/**`, `llm/cli/**`). `vitest.config.ts` is frozen
  after W0, so the owners could not add these themselves; consequence: `npm run test:coverage` is RED on the stub files until their
  owners land (expected; see REQUESTS).
- `electron.vite.config.ts`: plugin emits `out/main/manifest.json` from every `*MANIFEST` export of `src/main/llm/local/manifest.ts`.

## Deliverable 2 - shared contracts

C2 sections 1-8 applied verbatim to `src/shared/{types,errors,health,settings,schemas,state,ipc}.ts` and `src/preload/index.ts`
(76 invoke channels, 11 push events). C2 19 items 11-31 as colocated tests (`types.test.ts`, `schemas.test.ts`, `ipc.test.ts`,
new `settings.test.ts`, `locales.test.ts`, `preload/index.test.ts`) plus the v1 items 1-10: green. F18 edits and every v1 test edit:
seams doc sections 7-8. `tests/security/gguf-download.test.ts` is byte-unchanged (verified with `git diff --quiet`).

## Deliverable 3 - prompt constants

`src/main/agent/prompt.ts` gained `SYSTEM_PROMPT_EXTRACT_V2`, `EXTRACT_RULES_ADDENDUM_V2`, `EXTRACT_V2_ADDENDUM` (its last line is the
CLI JSON-only line, P2 concern 3), `IMAGE_TEXT_SENTENCE`, `CLI_JSON_ONLY_LINE`, `SYSTEM_PROMPT_DRAFT_V2`, `V1_READ_IMAGE_SYSTEM`, extracted
from the P2 fences by a script and pinned byte-for-byte by `src/main/agent/prompt.size.test.ts` (which re-reads the spec; the V1 prompt
is also equal to `docs/research/v2-image-events.md` 4.3). `buildSystemPrompt()` is NOT switched; the v1 prompt snapshots are green.

Sizes (UTF-8): S1 v2 constant 5,416 B; rule-6a addendum v2 1,707 B; existing-event addendum 5,385 B; S3 v2 2,954 B; V1 3,922 B.
Every single constant is < 8 KB (C2 19 item 28 - green), assembled S3 and assembled V1 (+ JSON-only line + facts) are < 8 KB (green).

**R-PROMPT-SIZE (spec conflict, needs an orchestrator decision).** The build plan asks for the ASSEMBLED S1 (v2 constant + existing-event
addendum + imageText sentence + CLI JSON-only line) < 8 KB. The verbatim P2 6.2 bytes assemble to 12,512 B (+ the facts block); P2 6.2's
own "Size" note and P2 concern 1 say ~13 KB and originally planned `--system-prompt-file`, which F23 then removed. W0 may neither change
the verbatim bytes nor re-introduce `--system-prompt-file`. I pinned the measurement with `it.fails(...)` in `prompt.size.test.ts`:
it passes today because the assertion fails, and it turns RED the moment the bytes or the threshold change, so V2-W1-03 flips it to
`it(...)` once the decision lands. Options: (a) trim the S1 v2 few-shots / addendum to fit 8 KB (P2 edit), (b) raise the F23 threshold
to the real CreateProcess limit (32,767 UTF-16 units; the app spawns with `shell:false`, so the 8,191-char cmd.exe limit does not
apply) and keep `--system-prompt`, (c) re-allow `--system-prompt-file` for S1 only. This is the only "known red" in the tree.

## Deliverable 4 - migration v4

C2 16.2 verbatim (runner: `Migration.foreignKeysOff`, FKs OFF before BEGIN, `foreign_key_check` before COMMIT, ON in `finally`,
`MigrationError 'fk_violation'`; the fourth `MIGRATIONS` entry). New `src/main/db/migrations.v4.test.ts` (6 tests): the
`unixepoch('subsec')` probe (bundled SQLite >= 3.42 asserted), `openDb(':memory:')` at `SCHEMA_VERSION` 4 with the finalisation columns,
the F4 trigger clauses and the reasons `content_rejected` / `multiple_events` / `cross_chat_rows`, and a hand-built v3 file with one row in
each of the 14 v3 tables migrated through `openDb` (all rows kept, FK check clean, backfills: `event_revision` 1 + `event_origin_item_id`,
`provider_class` api_key, `approved_by` 'user', `kind` llm, `auto_policy` inherit, settings parse with the v2 schema; the v4 trigger
refuses an approve without `approved_by`). The full v3-fixture round-trip stays V2-W1-01's.

## Deliverable 5 - frozen signatures and stubs

Every `src/main/**` block of C2 9-16 applied; all new files of step 5 exist, load, and throw `NotImplementedError('<owner>', ...)` from
new members only. Renderer stubs with UX2 12 props + UX2 13 test ids, stores, script stubs: seams doc section 3.
v1 behaviour kept (all v1 suites green) through the refinements and remnants listed in seams doc sections 5-6.

## Deliverable 6 - test infrastructure

Complete: T8/T9 guards + T7 additions with 17 self-tests (`tests/security/setup-guards.v2.test.ts`); `readSeams` v2 + matrix
(`src/main/testSeams.v2.test.ts`); `ogg-fixtures.ts`, `image-fixtures.ts`, `fake-bridge-db.ts` seeders, `stub-llm.ts` deltas, electron
mock v2 - each with passing tests in `tests/integration/fakes-v2.test.ts`. Typed skeletons: harness v2 options/handles (throw), ledger v2
(rules 7/8/11 live, 6/10 fail closed), goldenLoader v2, fake CLI/agy/whisper `.mjs` (exit 99) + type files, MCP client core + probe matrix,
FakeWaReadClient, waWorld, cli-fakes-hook, fake-bridge media names. Details and owners: seams doc section 4.

T9 note: the guard wraps the fs WRITE functions too now (writeFileSync, mkdirSync, rmSync, rename, copyFile, cp, ...); `realpathSync`
is deliberately not wrapped (vite uses `fs.realpathSync.native`). The guard error names the rule label, never the resolved profile
path, so no user name reaches test output.

## Deliverable 7 - locales + links

`en.json` / `he.json` seeded per build plan 1.2 (UX2 10 + 14 + 17, consent v2 copies incl. the Antigravity terms date, enum labels,
`LLM_VCREDIST_MISSING` voice sentence); parity and C2 19 items 12, 13, 30, 31 green. `resources/links.json` gains
`claude_install`, `claude_usage`, `antigravity_install`, `antigravity_terms`, `whisper_licence` (URLs from the three research files;
keys == `EXTERNAL_TARGETS`). Locale decisions (UX2 key clashes, consent titles): seams doc section 9.

## Deliverable 8 - verification (run 2026-09-28, after the last edit)

| Command | Result |
|---|---|
| `npm run typecheck` (node + web + tests) | exit 0, 0 errors |
| `npm run lint` (`--max-warnings 0`) | exit 0 |
| `npm run test:unit` | exit 0: 142 files, 3,504 passed + 1 expected fail (R-PROMPT-SIZE `it.fails`) |
| `vitest run --project integration --project security` | exit 0: 33 files, 684 passed |
| `npm run build` | exit 0 |
| production `out/main/*.js` seam scan | 0 hits each for `WCA_E2E`, `WCA_BRIDGE_CMD`, `WCA_LLM`, `WCA_CLI_CMD`, `WCA_WHISPER_CMD`, `WCA_DIALOG_SCRIPT`, `__wcaTest`, `stub-llm`, `fake-claude-cli`, `fake-agy`, `whisper-cli.mjs` |
| `out/main/manifest.json` | emitted (`MODEL_MANIFEST`) |
| `npm test` | = unit + integration + security above: no failure, nothing "needs Wave 1 body" |
| `prettier --check .` | NOT clean: 40 files, all C2-verbatim `src/**` files (see REQUESTS). Every W0-authored non-verbatim file was formatted. |

Nothing was fetched except the approved `npm install`; no vendor binary, `stage-calendar-mcp.mjs`, `fetch-whisper.mjs` or
`pin-models.mjs` was run; the reference bridge store and the user's vendor-CLI state were never touched.

## Dead ends / lessons

- `String.prototype.replace(a, b)` with a replacement string that contains `` $` `` or `$'` (regex sources ending in `$` followed by a
  backtick) splices file content; my patch scripts use `split(a).join(b)` from that point on. Earlier patches were checked: no such
  sequences in their replacement strings, and typecheck/tests confirm no duplication.
- Bash `node -e` strings turn `\\n` into real newlines inside template literals; multi-line code goes through script files or the Edit tool.
- The fuzz test regression was a seeded-trajectory change (76 channels instead of 52), not a v2 bug: the fuzz completed
  consent + `llm:setProvider` for a cloud provider and cleared its key, so the final inbound message was held `LLM_NOT_READY`.

## REQUESTS

1. **Orchestrator - R-PROMPT-SIZE** (Deliverable 3): decide (a) / (b) / (c). Then V2-W1-03 flips the `it.fails` in `prompt.size.test.ts`.
2. **Orchestrator / V2-W2-01 - formatting of C2-verbatim files**: `prettier --check` fails on 40 C2-verbatim `src/**` files (long verbatim
   lines kept for diff-by-eye). Either a formatting pass after Wave 1 (the v1 precedent, W2-01) or an explicit `.prettierignore` decision.
   Until then `npm run verify` stops at `format:check`.
3. **V2-W1-07** - `MEDIA_MODEL_MANIFEST` (C2 13 F19 prose, binding) is not in `llm/local/manifest.ts`: its pinned URLs/sizes/sha256 come
   from `pin-models`, which W0 must not run. The manifest sidecar picks it up automatically.
4. **V2-W1-07 / V2-W2-03** - U-V1 under the e2e Electron main bundle (not run by W0, see Deliverable 1).
5. **V2-W1-10** - `__wcaTest` v2 hooks of T2 4.2 (`dialogs()`, `consoles()`, `jobPids()`, `trayClick('autoPause')`, `notifications()[].actions`)
   are not in `installTestHooks` yet (the v1 "exactly eight hooks" test stays as is until then).
6. **V2-W1-05** - `tests/bench/wa-bridgedb.bench.test.ts` does not exist yet (`npm run bench:wa` has nothing to collect).
7. **All Wave-1 owners** - `npm run test:coverage` is red on the new safety-critical stub files until their bodies land (T2 13 thresholds
   are in the frozen config now).
8. **UX / V2-W1-12** - UX2 7.5 has no consent titles; W0 kept the v1 wording for `consent.cloud_{claude,gemini}.v2.title`. UX2 17 reuses
   `undo.*` keys: W0 seeded `undo.restoreOriginal`, `undo.restoringOriginal`, `undo.originalRestored`.
9. **V2-W2-02** - review the three security-test adaptations: the `WCA_MCP_TOKEN` exemption in the seam source lock, the provider re-arm
   step in `no-side-effect-fuzz.test.ts`, the v1-name alias in `tool-gate.test.ts`.

## BLOCKED-BY

None.
