# final-proof-v2 - final proof after the D-080 round (2026-10-05)

Label: final-proof-v2. Edited nothing except this file and `ops/agent-notes/final-proof-v2/` (logs).
Started fresh after the usage-limit pause: no earlier final-proof-v2 output existed. Run order matches the task.
The "exit" column is the real exit code of each command; nothing was retried.

| # | Command | Exit | Result | Log |
|---|---|---|---|---|
| 1 | `npm run lint` | 0 | clean (`--max-warnings 0`) | 01-lint.log |
| 2 | `npm run typecheck` | 0 | node + web + tests tsconfigs clean | 02-typecheck.log |
| 3 | `npm run format:check` | 0 | "All matched files use Prettier code style!" | 03-format.log |
| 4 | `npx vitest run` (run 1) | 0 | 335/335 files; 7809 passed, 1 expected fail, 1 skipped (7811) | 04-vitest-run1.log |
| 5 | `npx vitest run` (run 2) | 0 | same: 335/335 files; 7809 passed, 1 expected fail, 1 skipped | 05-vitest-run2.log |
| 6 | `npm run build:e2e` | 0 | built | 06-build-e2e.log |
| 7 | `npm run test:e2e` | 0 | **50 passed, 0 failed, 0 flaky** (5.0 min; config retries: 1, but no test needed a retry) | 07-test-e2e.log |
| 8 | `npm run pack:dir` | 0 | dist/win-unpacked rebuilt | 08-pack-dir.log |
| 9 | `npm run test:defender -- dist/win-unpacked --no-installer` | 0 | PASS: no threats; Authenticode NotSigned 42, Valid 2 (Microsoft DX DLLs), info only (D-078 signing off) | 09-defender-unpacked.log |
| 10 | `npx electron-builder --win --x64` | 0 | new NSIS file dist/WhatsAppCalendarAgent-Setup-0.1.0.exe (Oct 5 03:03, 158,452,538 B), replacing the stale Oct 4 one. Never run. | 10-nsis-build.log |
| 11 | `npm run test:defender -- dist/WhatsAppCalendarAgent-Setup-0.1.0.exe` | 0 | PASS: no threats; NotSigned (info) | 11-defender-installer.log |
| 12 | `npm run test:defender` (default targets: both, fresh) | 0 | PASS: 2 targets, no threats; NotSigned 44, Valid 2 | 12-defender-default-both.log |
| 13 | `npm run audit:prod` | 0 | found 0 vulnerabilities | 13-audit-prod.log |
| - | `npm run test:smoke` | - | **not runnable here (R11)**: it starts the packaged exe, which Smart App Control blocks on this PC and which this phase may not run. | - |

## Notes
- e2e is now 50 tests (was 47 at v2 close-out); the 3 new ones come from the D-080 round (e.g. tests/e2e/cli-signin.spec.ts).
- Step 10 re-packs win-unpacked as a side effect, so step 12 re-scanned the final tree and the new installer together.
- electron-builder prints "signing with signtool.exe" lines, but no certificate is configured; Authenticode confirms the
  files are NotSigned (expected under D-078 "Not now"). The 2 Valid files are Microsoft-signed d3dcompiler_47.dll / dxil.dll.
- Did not run claude.exe, agy.exe, the bridge, llama-server, whisper-cli, the packaged app or the installer. Did not touch
  user app data, CLI credentials, Defender settings or git.
- Verdict: everything is green apart from smoke, which cannot run on this PC (R11).
