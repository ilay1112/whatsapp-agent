# v2-build-proof - pipeline proof run (2026-10-04)

Edited nothing but this file and `ops/agent-notes/v2-build-proof/` (raw logs 01-10). Golden-live project deliberately NOT run
(its header forbids agents; vitest was run with --project main/renderer/integration/security, WCA_GOLDEN_LIVE unset).
No retries were performed by me; Playwright's own retry=1 is reflected below (a pass on retry would count flaky - there were none).

| # | Step | Exit | Result |
|---|---|---|---|
| 01 | npm run lint | 0 | green |
| 02 | npm run typecheck | 0 | green |
| 03 | npm run format:check | 1 | RED - 47 files not Prettier-formatted (e.g. src/shared/types.ts, src/shared/ipc.ts, src/main/voice/*, src/renderer/src/store/*, tests/fakes/*) - real reflow diffs, not line endings |
| 04 | npx vitest run (4 projects) | 1 | 7315 passed, 1 failed, 1 expected-fail; 309/310 files |
| 05 | npm run build:e2e | 0 | green |
| 06 | npm run test:e2e | 1 | 33 passed, 13 failed, 0 flaky (46 tests, 36.6 min) |
| 07 | npm run build | 0 | green |
| 08 | npm run test:smoke | 1 | RED - 8 problems, all check 8 (voice model URLs) |
| 09 | npm run audit:prod | 0 | 0 vulnerabilities |
| 10 | npm run verify | 1 | stops at format:check (same 47 files) |

## Failures
- vitest: tests/security/electron-hardening.test.ts "every production package ... carries an SPDX licence from the allow-list":
  offender `fast-sha256@1.3.0: Unlicense` (transitive prod dep; allow-list or dependency decision needed).
- e2e (failed on both attempts):
  - auto-mode.spec.ts:37 automatic mode off by default ... pauses from the tray
  - cli-connect.spec.ts:161 (5)+(6) consent ... drafted through S1 + S3 on the fake CLI
  - cli-connect.spec.ts:268 (7a) usage_limit CLOUD_QUOTA
  - cli-connect.spec.ts:300 (7b) overage CLOUD_OVERAGE
  - cli-connect.spec.ts:329 (7c) extra_tool CLI_TOOLSET_MISMATCH
  - cli-connect.spec.ts:355 (8) experimental Gemini
  - cli-connect.spec.ts:410 (9) quitting while a CLI job runs (pid file left in run\)
  - i18n-rtl.spec.ts:217 [v2] AutoStrip / Automatic-mode group / activity page
  - pictures.spec.ts:139 no projector: "Download picture reading" size
  - undo.spec.ts:26 automatic create undone from the AutoStrip
  - undo.spec.ts:87 manual reschedule undone back to pre-write slot
  - voice.spec.ts:105 voice note transcribed by fake whisper -> VoiceBubble
  - voice.spec.ts:168 whisper exit 3 = VOICE_MODEL_MISSING "Download (1.6 GB)"
  Common messages: "End trial is offered right after the third shadow decision" / "enable buttons offered right after the third
  approval" (AutoState not current when Settings opens), "element(s) not found" (18x), AppHealth.llm.code expectations for
  CLOUD_QUOTA/CLOUD_OVERAGE/CLI_TOOLSET_MISMATCH, E2E quit leak of job-cli pid files.
- smoke check 8: voice-hebrew, voice-lite, voice-multilingual, voice-vad in the model manifest use `resolve/main/` URLs; vendor/models.pin.json
  holds commit-pinned URLs. Fix belongs in the manifest (manifest.ts) owner.

## REQUESTS (to owners, via orchestrator)
1. Prettier --write on the 47 files (list in 03-format-check.txt) by their owners.
2. SPDX decision for fast-sha256 (Unlicense) - extend allow-list by a recorded decision or drop the dep.
3. Manifest owner: copy commit-pinned voice URLs from vendor/models.pin.json into manifest.ts.
4. E2E owners (auto, cli, undo, voice, pictures, i18n) triage the 13 failures above.
