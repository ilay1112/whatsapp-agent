# v2-repair-v2-packaging-pins - working notes (2026-10-04)

Scope: electron-builder.yml, build/**, resources/licenses/**, scripts/*.mjs (not mark-e2e-build.mjs), vendor/** (not
whatsapp-bridge-src), and the voice entries of `src/main/llm/local/manifest.ts`. No commit, no new dependency, no NSIS build,
packaged GUI never started, no binary run except what `npm run test:smoke` itself spawns (the packaged exe with
`ELECTRON_RUN_AS_NODE=1`, which Windows refused - see below). No network fetch was made by me (electron-builder's own
`pack:dir` step reported its usual electron zip download/extract from its cache).

## Status: partial

- Task 1 (voice URL pins): DONE. Smoke check 8 went red -> green. `npm run test:smoke` as a whole is still RED, but only
  because Windows Smart App Control now refuses to start the freshly packed, unsigned exe (checks 1, 2 and 9 depend on that
  spawn). That is an environment block, not a product defect, and it is reported, not hidden.
- Task 2 (libopus BSD-3 text): DONE, verified offline - result below.

## 1. Voice manifest pins (supply-chain defect)

Change (`src/main/llm/local/manifest.ts`, voice entries only): the four `resolve/main/` URLs were replaced, mechanically, by
the URLs in `vendor/models.pin.json` (a script copied them and asserted the repo part matched; sizes and sha256 untouched):

| id | pinned commit |
|---|---|
| voice-hebrew (ivrit-ai/whisper-large-v3-turbo-ggml) | 2130c78e4a9cb4914cc4df91a1c3031407789705 |
| voice-multilingual (ggerganov/whisper.cpp) | 5359861c739e955e79d9a303bcbc70fb988958b1 |
| voice-lite (ggerganov/whisper.cpp) | 5359861c739e955e79d9a303bcbc70fb988958b1 |
| voice-vad (ggml-org/whisper-vad) | 9ffd54a1e1ee413ddf265af9913beaf518d1639b |

`UNPINNED_MEDIA_IDS` is now `[]` (comment updated). The existing `manifest.media.test.ts` rule then asserts every media URL is
`/resolve/<40-hex>/` (its `else` branch) - no test edited there. No other source references these URLs (grepped src, tests,
scripts, docs/specs, README).

Knock-on in my own tests: `scripts/pin-models.test.mjs` had used the REAL manifest as its "floating resolve/main" fixture, so 4
cases went red once the manifest was pinned. Fixed without weakening: the resolve/main -> commit path is now exercised on
`FLOATING_MANIFEST_SOURCE` (the real source with exactly the four voice URLs put back to `resolve/main/`), and 3 new cases:
- the floating copy differs from the real source in exactly 4 URLs; the real source has no `resolve/main/`;
- `main()` on the real, pinned manifest keeps every media URL verbatim, never calls `revision/main`, and no longer prints
  the "copy the commit-pinned URLs into manifest.ts" hint;
- the committed `vendor/models.pin.json` equals the shipped manifest field-by-field (unit-level twin of smoke check 8, so the
  drift is caught by `vitest` before anyone packages).

### Evidence (raw logs in `ops/agent-notes/v2-repair-v2-packaging-pins/`)
- `01-test-smoke-before.txt` (before any change): the smoke CRASHED at check 1 with `Error: spawn UNKNOWN` - it never reached
  check 8. The earlier red check 8 (8 problems, all voice URLs) is in `ops/agent-notes/v2-build-proof/08-test-smoke.txt`
  (same HEAD manifest).
- `02-test-smoke-after.txt` (after): `[ok] check 8 - the packaged model manifest deep-equals vendor/models.pin.json`.
  All of 3, 4, 4a, 5, 6, 7, 8, 10, 11, 12 ok; FAIL = check 1, check 2 (spawn refused), check 9 (needs check 1's tools/list).
  Exit 1, 3 problems.
- Pure-function red/green on the SAME packaged sidecar (`out/main/manifest.json` from the new app.asar):
  `modelManifestProblems` = 0 problems as shipped; 8 problems with the four voice URLs put back to `resolve/main/`.

## The new blocker: Smart App Control refuses the packaged exe

`spawn UNKNOWN` (errno -4094) on `dist\win-unpacked\WhatsApp Calendar Agent.exe`. Read-only diagnosis:
- `Get-MpComputerStatus`: `SmartAppControlState: On`.
- `Microsoft-Windows-CodeIntegrity/Operational`: events 3033 / 3077 / 3118 ("Smart App Control Block") at each smoke run:
  node.exe "attempted to load ... WhatsApp Calendar Agent.exe that did not meet the Enterprise signing level requirements".
- The exe has no Mark-of-the-Web stream and `Get-AuthenticodeSignature` = NotSigned. Every `pack:dir` produces a new
  exe hash (asar integrity resource), so SAC has no reputation for it. The build-proof run earlier the same day was
  not blocked; why SAC passed that hash is unknown.
- I did NOT change any security setting (forbidden, and turning SAC off cannot be undone without a Windows reset).
  The user's options: run `npm run test:smoke` on a machine/VM without SAC/WDAC enforcement, or sign the build
  (`npm run test:smoke` would then pass checks 1/2/9 if nothing else changed). This also matters for the user's
  manual M9 (installer GUI start): an unsigned installer/exe will hit the same SAC block on SAC-enabled PCs.

Smoke robustness fix (scripts/smoke-packaged.mjs, owned): a refused spawn crashed the WHOLE smoke at check 1, hiding checks
2-12. Now `mcpSession` catches a synchronous spawn throw and an async `'error'` event (plus a stdin EPIPE handler) and returns a
failure built by the new pure `spawnFailure(err, platform)`: the check is reported FAILED ("the check did NOT run ... never
count this as a pass"), with the SAC/WDAC hint for UNKNOWN/EPERM/EACCES on win32. Exit code stays 1. The no-GUI structural
test (exactly one `spawn(` call site, inside `spawnAsNode`) still holds. +4 unit cases in `smoke-packaged.test.mjs`.

## 2. libopus BSD-3 licence text - verified (offline)

- `node_modules/opus-decoder` (0.7.12) ships NO libopus licence: files = index.js, package.json (`"license": "MIT"`),
  README.md ("Based on libopus", link to github.com/xiph/opus), src/*.js, dist/*.min.js(.map). The only copyright comment
  is the wasm-audio-decoders author's. I decoded the embedded WASM (yEnc + raw deflate, read-only, never instantiated):
  93,685-byte valid module, no licence or libopus version string inside. So the package itself cannot verify the text -
  and it is itself redistributing a libopus binary without the BSD-3 notice; our THIRD_PARTY_NOTICES section 11 is what
  satisfies BSD-3 clause 2 for us.
- Offline upstream copy found instead: the installed Electron 44.4.3 `node_modules/electron/dist/LICENSES.chromium.html`,
  product "opus" (Chromium's third_party/opus COPYING, homepage gitlab.xiph.org/xiph/opus). After HTML-unescaping and
  CRLF/trim normalisation it is BYTE-IDENTICAL to `resources/licenses/libopus-BSD-3.txt` (1,944 chars; normalised sha256
  `1cff0ac6c1aa5ce584d59a460fbc1a87b4e9f6f61ea894364f4cbe48fe1d9f0e`), including the copyright-holder line
  "Copyright 2001-2023 Xiph.Org, Skype Limited, Octasic, ... Mozilla, Amazon" and the three IETF IPR patent links.
- `resources/licenses/THIRD_PARTY_NOTICES.txt` contains that text verbatim; the packaged copy
  (`dist/win-unpacked/resources/licenses/`) is byte-identical to the repo copy. Regenerating the notices produced no diff.
- Residual caveat: the libopus revision compiled into opus-decoder 0.7.12 is not identifiable offline. The copyright line
  "2001-2023" is the current upstream COPYING (Chromium's copy); an older libopus would carry a shorter holder list, so
  this is a superset and safe as a notice.
- Guards added (`scripts/smoke-packaged.notices.test.mjs`, +2): the committed text's normalised sha256 is pinned; it must equal
  the Electron/Chromium "opus" section when that file is present (soft-returns when electron's dist is absent - the sha pin
  still holds). Comment in `scripts/smoke-packaged.notices.mjs` records the verification.

## Gates run (my files)
- `npx vitest run scripts/ src/main/llm/local/` -> 18 files, 438 tests pass (+ notices file 19/19).
- eslint + prettier --check clean on all 7 touched files. `npm run build` (inside test:smoke, includes typecheck) green.
- `npm run test:smoke` -> exit 1, 3 problems, all spawn-refusal (above). Check 8 green.

## REQUESTS
- Orchestrator / user: decide how the packaged smoke runs under Smart App Control (machine without SAC, or code signing).
  Until then checks 1, 2, 9 cannot be proven on this PC; do not count them as passed.
- Owner of `src/main/llm/local/manifest.media.test.ts` (V2-W1-07): the test title still says "voice URLs await pin-models";
  cosmetic only - the assertion now enforces commit pins for all seven media entries.
- Commit with the v2 work: `src/main/llm/local/manifest.ts` + `vendor/models.pin.json` must travel together (the new
  pin-models unit test fails if they diverge).
