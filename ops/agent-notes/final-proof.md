# final-proof - whole-pipeline proof run (2026-09-27)

Read-only agent. I edited nothing except this file and `ops/agent-notes/final-proof/` (raw stage output, one file per
stage). No source, test, config or dependency was touched. Nothing committed. No installer built, no packaged GUI
started, no real binary executed (the smoke run hashes `whatsapp-bridge.exe`, never runs it; the packaged exe is run
only as plain Node for the MCP checks). No network target other than 127.0.0.1 and the npm registry (`npm audit`).
Nothing under the reference bridge's `store` was read or listed. `WCA_GOLDEN_LIVE` was unset for every run, so the
golden-live project never reached a model.

Read first, as instructed: `reverify.md`, `repair-compose-defects.md` (REQUEST 1 and 3), `repair-renderer-csp.md`,
`repair-test-fakes.md`, plus `final-e2e.md` (the agent that closed the four e2e seams this run proves).

Every command was run from the quoted project path with `C:\Program Files\nodejs;C:\Program Files\Git\cmd` prepended
to `PATH` (Git Bash equivalent of the mandated PowerShell prefix).

## Stage results (in the order run)

| # | Command | Exit | Result | Raw output |
|---|---|---|---|---|
| 1 | `npm run lint` | **0** | `eslint . --max-warnings 0` clean | `final-proof/01-lint.txt` |
| 2 | `npm run typecheck` | **0** | node + web + tests tsconfigs clean | `final-proof/02-typecheck.txt` |
| 3 | `npm run format:check` | **0** | "All matched files use Prettier code style!" | `final-proof/03-format-check.txt` |
| 4 | `npx vitest run` (all five projects) | **0** | 169 files, **3837 passed / 0 failed / 1 skipped** (3838), 19.9 s | `final-proof/04-vitest.txt` |
| 5 | `npm run build:e2e` | **0** | e2e bundle + marker written | `final-proof/05-build-e2e.txt` |
| 6 | `npm run test:e2e` | **0** | **22 passed / 0 failed / 0 flaky** (no `retry #` line, every spec `ok` first attempt), 1.5 min | `final-proof/06-test-e2e.txt` |
| 7 | `npm run build` (production) | **0** | `out/main` = `index.js` (+ map) only; `out/.e2e-build` marker confirmed deleted | `final-proof/07-build.txt` |
| 8 | `npm run test:smoke` | **0** | `smoke-packaged: PASS - all six checks green` (check 6: no-GUI rule held) | `final-proof/08-test-smoke.txt` |
| 9 | `npm run audit:prod` | **0** | `found 0 vulnerabilities` | `final-proof/09-audit-prod.txt` |
| 10 | `npm run verify` (one command) | **0** | lint, format, typecheck, stage:mcp, test:coverage (168 files / 3836 passed), test:e2e (22 passed), test:smoke (PASS), audit (0 vulns) | `final-proof/10-verify.txt` |

**All green. `npm run verify` exit code: 0.** No number above is rounded; flaky would have been reported as flaky.

## Details worth knowing

### The one skipped vitest test (stage 4)
`tests/golden/golden.live.test.ts:71` - `describe.skipIf(!LIVE)('golden live evaluation (L7, user-run only)')`, where
`LIVE = process.env.WCA_GOLDEN_LIVE === '1'`. This is the deliberate self-skip: it is the only test that talks to a
real model and the operating rules forbid that. Its sibling `it('is skipped unless WCA_GOLDEN_LIVE=1 ...')` at line 166
runs and passes, which is why `npx vitest run` shows 169 files / 3837 passed / 1 skipped while `npm run verify`'s
`test:coverage` (four projects, no golden-live) shows 168 files / 3836 passed / 0 skipped. The two counts are
consistent.

### The four e2e specs that were red in `reverify.md` are now green, first attempt
- `approval-first.spec.ts:153` (approve -> one send; add to calendar -> one create-event) - ok, 29.1 s
- `approval-first.spec.ts:248` (obedient attacker model -> no side effect, manipulation badge) - ok, 26.9 s
- `onboarding.spec.ts:150` (bridge starts after the disclosure; QR scanned / expired / re-issued) - ok, 5.0 s
- `tray-lifecycle.spec.ts:145` (second launch exits and re-shows the first window) - ok, 1.1 s
The fixes are `final-e2e.md`'s and live only under `tests/e2e/`; I verified no product file is involved by reading
that note, not by diffing (there is no git baseline - the whole tree is untracked).

### Coverage (inside `npm run verify`)
Statements 96.22 % (8686/9027), Branches 91.24 % (5449/5972), Functions 93.72 % (1883/2009), Lines 97.4 %
(7530/7731). All configured thresholds held (the stage exited 0; a threshold miss makes vitest exit non-zero).

### Benign noise in the coverage stage - reported, not a red
`test:coverage` prints one `Failed to parse file:///C:/dev/whatsapp agent/src/renderer/index.html. Excluding it from
coverage.` followed by a Rollup `PARSE_ERROR` stack from `@vitest/coverage-v8`'s `getCoverageMapForUncoveredFiles`.
Cause: the coverage `include` glob picks up `src/renderer/index.html`, which the v8 provider then tries to parse as
JavaScript for the "uncovered files" pass. It excludes the file and continues; no test, threshold or exit code is
affected. Cosmetic fix for whoever owns `vitest.config.ts`: add `**/*.html` to `coverage.exclude`. Not mine to make.

### Electron-builder warning (smoke stage, both runs)
`duplicate dependency references` listing `@modelcontextprotocol/sdk`, `debug`, `express`, ... - an informational
electron-builder notice about the hoisted dependency tree; the pack completed and all six packaged checks passed.

## What I did not do
- Did not run `npm run test:golden:live`, the NSIS target, or the packaged GUI (manual item M9).
- Did not edit, skip, delete or weaken any test. Nothing was red, so nothing needed a citation.
- Did not touch `ops/PROGRESS.md`, `ops/BOARD.md`, `ops/DECISIONS.md` or any other agent's notes.

## REQUESTS
- **Orchestrator**: the pipeline is fully green including `npm run verify`; the only open cosmetic item is the
  coverage-provider HTML parse warning above (`vitest.config.ts` `coverage.exclude`).

## BLOCKED-BY
None.
