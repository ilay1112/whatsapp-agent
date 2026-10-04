# v2-fix-src-main-llm - working notes

Scope: the confirmed findings filed against src/main/llm (CLI sandbox and injection reviews). I wrote each failing test first, saw it go red, then fixed the code.
No new dependency, no version change, no commit. No real CLI, WhatsApp, Google or Anthropic was touched. Every test uses scripted jobs or the fakes.

## Results

| Finding | Status | Where |
|---|---|---|
| cli-sandbox-1 (= injection-v2-2), unexposed `mcp__wca__*` not struck | FIXED | runner.ts `consume()` |
| injection-v2-2 | FIXED (same defect and fix as cli-sandbox-1) | runner.ts |
| cli-sandbox-3, agy sign-in probe ran in the REAL profile | FIXED (isolation); consent/disclosure gate NOT added (see below) | locator.ts, claudeCli.env.ts, antigravityCli.ts (re-exports), compose.ts (+2 lines) |
| cli-sandbox-2, stdin sent before the init proof | HARDENED (the verifier's "cheap hardenings"); the transport itself is unchanged | runner.ts |
| cli-sandbox-6, exe path recorded after the first spawn | FIXED | locator.ts `onExeResolved`, compose.ts wiring |

### cli-sandbox-1 / injection-v2-2
- Before: an S3 `tool_use` was counted as a tool call whenever its name started with `mcp__wca__`.
- Now: it counts only when the part after the prefix is in `req.exposedNames`. The check is case-sensitive, like ToolGate. Any other `mcp__wca__*` name goes through the existing `strike()`:
  - writes a `tool_blocked` audit with sha8 and length only,
  - calls `onStrike` (so `ctx.blockedCalls` rises),
  - aborts at `blockedCallsAbort`.
- Why: Claude Code answers a name outside its tool list itself and never forwards it to the loopback server, so the gate never sees it.
- Double-count risk: if some CLI does forward such a call, the gate strikes it as well. That over-counts, which fails safe.
- Test: runner.test.ts `[cli-sandbox-1 / injection-v2-2, B17]`. It was red with `toolCalls 3, blockedCalls 0` and is now green.
- The reviewer's scratch test `v2-verify-injection-v2-2.scratch` (the injection-v2-2 case) now passes. Its other red case is injection-v2-3, which is not mine.
- Spec wording to correct (orchestrator, not done by me): ARCH2 §4 "Result check", v2-pipeline.md:489 "Strikes" row and the v2-contracts `blockedCalls` comment say "non-mcp__wca__". They should say "not an exposed mcp__wca__<name>". I updated the `CliRunResult.blockedCalls` comment in runner.ts.

### cli-sandbox-3
- `buildAgyProbeEnv(processEnv, tempDir, home)` now REQUIRES the isolated profile vars. It no longer copies the real USERPROFILE, HOME, APPDATA or LOCALAPPDATA.
- `planAgyHome`, `AGY_HOME_DIR` and `AGY_WORKSPACE_DIR` moved to claudeCli.env.ts and are re-exported unchanged from antigravityCli.ts. Reason: locator.ts cannot import antigravityCli.ts, because that would create an import cycle (the env file exists to avoid exactly that).
- `createCliLocator` takes a new optional dep `userDataDir`. Every agy probe (`--version` and `-p /usage`) now:
  - creates `<userData>\agy-workspace`,
  - writes `<userData>\agy-home\.gemini\antigravity-cli\settings.json` before the spawn,
  - runs with cwd = the workspace and TEMP/TMP = the workspace,
  - uses the profile vars of `<userData>\agy-home`.
- Without `userDataDir`, no agy probe is spawned at all: version is null and signedIn is 'unknown'. That fails closed.
- U-A7: if the isolated profile cannot see the login, agy exits 1 and prints its auth prompt on STDERR. The probe used to read stdout only, so it answered 'unknown'. It now also reads the JobRunner's `auth_required` stderr marker and answers `false` (not signed in), which is what the runs under that profile would get. (The fake prints the prompt on stderr too.)
- compose.ts: `createCliLocator({... userDataDir: paths.userData, onExeResolved: ...})`. Both fields are additive.
- Tests in locator.test.ts:
  - isolated env, cwd and settings.json present at spawn,
  - stderr marker gives not-signed-in,
  - no userData means no spawn.
- The reviewer's scratch `v2-verify-cli-sandbox-3.scratch/probe.test.ts` asserts the defect, so it is now red as expected: no real-profile spawn happens.
- I changed one existing test, `claudeCli.test.ts > agy probe env`. It used to assert `env.HOME === planted.USERPROFILE`, which is the defect itself. It now asserts the isolated profile and that the real profile is absent. `tests/security/cli-env-poisoning.test.ts` got the new call signature plus a stronger assertion: USERPROFILE is agy-home and the real profile is never present.
- I also corrected a latent spot in runner.ts's agy run env. The defaults it overrode were the REAL APPDATA/LOCALAPPDATA, and the stale planAgyHome mock in runner.test.ts returns `env: {}`. The defaults are now under agy-home, so the real profile can never appear even if `plan.env` lacks a key.
- NOT done, with reasons:
  - **Gate the probe on the `cloud_antigravity_cli` consent.** I rejected this because ConnectCard asks for sign-in BEFORE consent (ConnectCard.tsx ~l.100 sign-in poll, ~l.121-126 consent shown only once the state is `ready`). Gating the probe on consent would deadlock the card in 'unknown'.
  - **Gate the probe on the experimental disclosure being open.** That state exists only in the renderer, so the gate needs renderer and IPC changes outside src/main/llm.
  - Isolation alone already closes the I6'/F3 breach: no user-level MCP config or hooks are in reach.
  - Residual: when agy is installed, the probe still spawns at every app launch (App.tsx bootstrap `useCliStore.getState().refresh()` covers both ids). REQUEST to the renderer owner: refresh antigravity_cli only once "Show experimental" is open or agy is the chosen provider.

### cli-sandbox-2 (minor)
- Not changed: the transport. The single stdin line still goes out at spawn, as C2 §13.1 / ARCH2 §4.3 specify. Delaying stdin until init is accepted only works if claude emits system/init before reading stdin, which is unverified and belongs to M-CLI-1.
- Hardening: the runner keeps a per-provider `proofPaused` set.
  - An init failure with mismatch `api_key_auth` or `extra_server` (the identity / connector change in the finding) pauses THAT provider on the FIRST failure.
  - While paused, runs are refused before the budget and before any spawn, with error 'sandbox' (so the item and AppHealth show CLI_TOOLSET_MISMATCH through the existing compose wrapper).
  - Only `resetBreaker()` lifts it, which is the user's "Test again" click in cli.ts:146.
  - The other CLI is not paused.
  - Possibly transient mismatches (`server_error`, `missing_server`, no_init) and `extra_tool` keep the 3-strike breaker. extra_tool is out because the e2e (7c) and integration semantics for it were designed around the breaker. It can be added to `PAUSE_ON_FIRST` by decision.
- Tests in runner.test.ts: `[cli-sandbox-2] api_key_auth / extra_server pauses ...` (red, then green) and `... transient mismatch keeps the 3-strike rule`.
- I corrected the overclaiming comments in runner.ts ("killed before the first turn" in three places). REQUEST to the orchestrator, outside my scope:
  - correct v2-contracts.md:2034 and the ARCH2 I11 enforcement wording,
  - correct the "no turn consumed" text in tests/fakes/fake-claude-cli.types.ts:97.
  The guarantee is "a run is used only if it proved itself, and the CLI already holds the stdin line", not "nothing was sent".

### cli-sandbox-6 (minor)
- `createCliLocator` takes a new optional dep `onExeResolved(provider, exePath)`. find() calls it right after resolving the path and BEFORE the `--version` job.
- Every route spawns only through find() first: cli:getStatus probes, cli:test (cli.ts:147 find, then validate or makeAgyForTest), and runCliTest and the factories. So every probe, test and smoke pid file now names a recorded path, and the reaper can kill an orphan.
- A throwing recorder fails closed: find() rejects and nothing is spawned.
- compose wires `recordCliExePath`. It is idempotent: a write happens only when the path changed.
- Only validated paths ever reach it: `acceptableExe` on disk, or the validated seam command in e2e.
- Tests: locator.test.ts `[cli-sandbox-6, B31]`, which checks the order record, then spawn, for both CLIs; never on not-found; a throw means no spawn.

## Verification (2026-10-04)
- `npx vitest run src/main/llm src/main/agent tests/security/{cli-env-poisoning,cli.sandbox,tool-gate} tests/integration/{cli-provider,agy-provider,v2-main-repairs,app-boot} src/main/ipc/handlers/cli.test.ts`: 58 files, 1733 passed, 1 expected fail.
- eslint over src/main/llm/cli, compose.ts and the touched security test: clean. Prettier: clean.
- tsc: no error in any file I touched.
- `npm run typecheck` / `npm run lint` are red on OTHER agents' in-flight files, which I did not touch:
  - actionExecutor.ts (AutoPolicyRecord | null),
  - App.tsx (NavRequest.section, set-state-in-effect),
  - ReadTools.test.tsx.
- `tests/security/media-text-isolation.test.ts` voice batches fail ("note N: expected null to match {status:'done'}"). That harness uses the stub provider and the fake whisper, with no CLI code, while src/main/media/mediaCache.ts is being modified concurrently by the media fixer. It is not caused by this change; reported, not touched.

## Files touched
- src/main/llm/cli/runner.ts, runner.test.ts
- src/main/llm/cli/locator.ts, locator.test.ts
- src/main/llm/cli/claudeCli.env.ts, claudeCli.test.ts
- src/main/llm/cli/antigravityCli.ts (planAgyHome / dir constants re-exported, no behaviour change)
- src/main/compose.ts (createCliLocator: +userDataDir, +onExeResolved)
- tests/security/cli-env-poisoning.test.ts (new buildAgyProbeEnv signature + stronger assertion)
