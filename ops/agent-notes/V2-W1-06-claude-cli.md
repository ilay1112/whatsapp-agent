# V2-W1-06-claude-cli - builder notes

Package: `V2-W1-06-claude-cli` (Wave 1 of the v2 build). Brief: `docs/specs/v2-build-plan.md` section 7 `### V2-W1-06-claude-cli`.
Status: DONE (one harness-based integration test BLOCKED-BY V2-W2-01, see below).

Found at start (2026-09-28, resumed after a usage-limit interruption): every owned file still held the Wave-0 stub
(`NotImplementedError('V2-W1-06-claude-cli', ...)`) or the v1 body; no notes file existed, so nothing of a previous attempt had to be
merged. No vendor binary was run; the user's real `claude.exe` / profile were never touched (every test uses mkdtemp homes and the
spawned `tests/fakes/fake-claude-cli.mjs` under the system node.exe).

## What was built (brief order)

1. `src/main/proc/jobRunner.ts` - per-kind promise mutex; breaker 5 failures / 10 min per kind (`CLI_UNSTABLE` / `VOICE_LOCAL_FAILED`);
   pid file `job-<kind>-<uuid>.pid.json` written synchronously right after spawn (tmp + rename) and removed in `finally`; env key set
   must equal one literal allow-list per kind and never carry a `JOB_ENV_FORBIDDEN` name (case-insensitive) - else `JobSpecError`, no
   spawn; `shell:false`, `windowsHide:true`; NDJSON splitter (1 MiB line cap = line dropped, 8 MiB total cap = kill); marker-only stderr
   scanner; wall clock; abort; `jobPids()`, `killAll()`. `src/main/proc/supervisor.ts`: `SupervisorDeps.jobs?` - `stopAll()` awaits
   `jobs.killAll()` first (quit order); `isExactCliExePath()`; `parsePidFile` accepts a recorded CLI path only as the EXACT string.
   `src/main/proc/reaper.ts`: job pid files routed by kind (`job-cli` only with an exact recorded CLI path, `job-voice` only under our
   roots / execPath list; a recorded CLI path is never accepted for a child or voice file). `freePort.ts` unchanged (v1 already has
   `NEVER_PORTS`).
2. `src/main/llm/cli/locator.ts` - disk order `claudeExePath` override (validated with `ClaudeExePathSchema`, missing/invalid => not
   installed, never another exe) -> `%USERPROFILE%\.local\bin\claude.exe` -> npm `...\@anthropic-ai\claude-code\bin\claude.exe` ->
   `where.exe` (.exe hits, a `.cmd` hit mapped to the npm exe beside it, never the .cmd); agy `%LOCALAPPDATA%\agy\bin\agy.exe` -> where.
   e2e seam (`WCA_CLI_CMD`) => only the seam command, zero `statFile` / `runWhere` calls. `parseVersion`, `compareVersion`,
   `cliStateOf`; `version()` / `signedIn()` run short probe jobs (claude `auth status --json` reads ONLY `loggedIn`; agy `-p /usage`).
   `createCliStatus` caches per provider for `cacheMs`, dedupes concurrent probes, never probes login below the floor, and (additive)
   records `lastTest` / `quota` / `workspaceTrusted` (`CliStatusRecorder`).
3. `src/main/llm/cli/runner.ts` - concurrency 1 (runner chain on top of the JobRunner mutex); refusals BEFORE any spawn: abort, health
   (breaker `CLI_UNSTABLE`, overage pause, usage window until `resetsAt`), budget `cli_global` (`min(maxRunsPerHour, LIMITS ceiling)`);
   fresh EMPTY run dir `cli-runs\<id>` (agy: `agy-workspace\runs\<id>`) removed in `finally`; init proof on the FIRST parsed event, kill
   before any later line is read, `toolset_mismatch` audit, no retry; strikes (non-`mcp__wca__` tool_use, `permission_denials`) audited as
   `tool_blocked {nameSha8,nameLen,verdict,runId}` and fed to the RunCtx via `onStrike` (2 => kill + `run_aborted`); `StructuredOutput` on
   schema runs is never a strike (F13); `rate_limit_event` => quota; overage (not allowed) => kill at once + pause; classification
   `is_error` FIRST, then subtype / refusal / structured_output (text kept for the fence-strip backstop) / S3 text; `cli_run` audit with
   the ten enum/number/boolean keys. Breaker strikes = init failures, wall-clock kills, crashes without a result (NOT strike-abort kills:
   an attacker message must not be able to disable the provider). Agy branch calls V2-W1-09's builders (see REQUESTS).
4. `src/main/llm/cli/claudeCli.ts` (+ new helper `claudeCli.env.ts`, split out only to avoid a locator <-> claudeCli import cycle):
   `buildClaudeArgs` = ARCH2 4.3 literally (empty element after `--tools`, `--permission-prompts none` iff >= 2.1.259, S3 `--mcp-config`
   with the literal `${WCA_MCP_TOKEN}` or the `run_file` path + `--allowedTools mcp__wca__*`, `--effort medium` on S3 only);
   `buildClaudeEnv` (exact `CLAUDE_ENV_KEYS` / `CLAUDE_S3_ENV_KEYS`, self-checked); `buildClaudeStdinLine(Parts)`; `checkClaudeInit`;
   `mapApiKeySource`; pinned-after-M-CLI-1 constants `CLI_OAUTH_API_KEY_SOURCE = null`, `CLI_NEUTRAL_INTERNALS = []` (fail closed);
   smoke constants; `createClaudeCliProvider` (structured S1/V1, `chat()` => `unsupported`, `runAgentic()` starts the per-run tool server
   through the injected `startToolServer` and closes it in the same `finally` as the run, `validate()` = floor + smoke, `dispose()` aborts
   the in-flight job, extra info members `exePath` / `observedVersion` / `cliHealth()` / `lastSmokeOkAt()`); `makeClaudeCliFactory`.
5. `src/main/llm/factory.ts` - CLI ids: consent first; `makeClaudeCli` / `makeAgy`; cache key `id|model|exePath|version`; the provider-start
   smoke (`validate()`) runs BEFORE the provider is handed out; a smoke older than 24 h is re-run; `usable()` = consent + model + make present
   + live `cliHealth()` + sticky failures (non-retryable codes) - "never tried" is usable (get() proves the smoke first); `invalidate()`
   disposes (= kills the in-flight job) and clears the holds; the e2e `seamProvider` is never consulted for CLI ids. `consent.ts` needed no
   change (the shared C2 table already has the two kinds); `consent.test.ts` gained the v2 block.
6. `src/main/agent/draft.ts` - `runDraft` branches on `provider.loop` FIRST: `turn` = v1 loop (unchanged), `agentic` = `runAgentic()` over
   the same gate + RunCtx (`specs = gate.exposedSpecs()`, `maxTurns = draftTurnsWithTools + 1`, wall clock >= `cliWallClockDraftMs`),
   `prefetch` = `gate.prefetchWaContext()` appended as its own nonce block + one no-tool `structured()` with `DRAFT_REPLY_SCHEMA`.
   `sandboxOk:false` => reason `sandbox`; `ctx.blockedCalls >= blockedCallsAbort` => `aborted_manipulation`; same `cleanDraft()`.
7. `src/main/ipc/handlers/cli.ts` - the seven channels; `cli:signIn` builds `[exe,'auth','login','--claudeai']` (agy: no args, cwd home)
   only for the locator-validated exe and opens it through S-CONSOLE; `createOpenVisibleConsole()` = production S-CONSOLE
   (`shell:false, detached:true, windowsHide:false`, refuses cmd.exe); `cli:setOverage` (true => `confirmSetting('overage')`, cancel =>
   unchanged; false => one click); `cli:test` resets the runner breaker, runs the constant smoke, records `lastTest`, re-arms the factory
   when that CLI is active; `cli:pickExe` (native dialog in main, `ClaudeExePathSchema` + hostile-char/UNC check + version floor, the only
   writer of `llm.cli.claudeExePath`); `cli:previewWorkspaceChange` / `cli:allowWorkspace` delegate to V2-W1-09's `AgyWorkspace` and
   V2-W1-04's `confirmWorkspaceTrust` (the dialog shows exactly the diff that `allow()` writes). Every channel re-checks focus where
   FOCUS_GATED; a missing collaborator fails CLOSED (INTERNAL, nothing changed, nothing spawned).
8. `tests/fakes/fake-claude-cli.mjs` (T2 3.1: flag table + unknown-option exit 1 + version-gated `--permission-prompts`, forbidden flags
   journaled, stage from argv, env / stdin / argv checks, `mcp-client-core.mjs` connection + authenticated `GET /mcp` = 405 check BEFORE
   init, all 26 modes, script rules, non-loopback exit 97) + `.types.ts` (additive fields, `readFakeClaudeJournal`), 
   `tests/helpers/cli-fakes-hook.ts` (afterEach fails a test on any registered journal violation - ledger rule 11; `readRegisteredJournals`
   for the ledger), new helper `tests/helpers/cli-fakes-hook.world.ts` (production JobRunner/CliRunner/provider over the spawned fake).

Tests added: `src/main/proc/jobRunner.test.ts`, v2 blocks in `reaper.test.ts` / `supervisor.test.ts`, `src/main/llm/cli/{locator,runner,
claudeCli}.test.ts`, `src/main/llm/factory.cli.test.ts`, `consent.test.ts` v2 block, `src/main/agent/draft.loops.test.ts`,
`src/main/ipc/handlers/cli.test.ts`, `tests/security/cli.sandbox.test.ts` (group 18 Claude half + fake self-test),
`tests/security/cli-env-poisoning.test.ts`, `tests/integration/cli-provider.test.ts`. `tests/integration/fakes-v2.test.ts`: the
"skeleton exits 99" loop no longer lists fake-claude-cli.mjs (same edit V2-W1-07 made for whisper).

## Verification (2026-09-29, after the last edit)

| Check | Result |
|---|---|
| `npx eslint <owned paths> --max-warnings 0` | clean |
| `npm run typecheck` | 0 errors in owned files (other errors in the tree belong to packages in flight, e.g. `bridge/readClient.ts`, `media/fetch.ts`) |
| `vitest --project main` (whole project) | 156 files, 3,949 passed + 1 expected fail (R-PROMPT-SIZE, W0) |
| owned security files | `cli.sandbox.test.ts` 26/26, `cli-env-poisoning.test.ts` 5/5 |
| `cli-provider.test.ts` | 24/25; the 1 red is part B (harness) = BLOCKED-BY V2-W2-01 |
| coverage `jobRunner.ts`, `runner.ts`, `factory.ts` | 100 / 100 / 100 / 100 |
| coverage rest of `llm/cli/**` | locator 99/95/100, claudeCli 98.7/95.5/97, claudeCli.env 95/92/100 (band 90/85/90) |
| prettier | owned non-verbatim files formatted; the four files holding C2-verbatim blocks (`jobRunner.ts`, `locator.ts`, `runner.ts`, `claudeCli.ts`) left unformatted like every C2-verbatim file (W0 REQUEST 2: formatting pass by V2-W2-01) |

Security-project failures seen in the full run (NOT caused by this package): `injection-corpus.test.ts` v2 vectors ("the model was
never called", runner = W2-02) and `wa-tools.test.ts` (`crossChatLeak` stub of V2-W1-03). Integration failures seen: harness-based tests
of W1-05 / W1-07 / this package (harness options throw until V2-W2-01).

## Decisions / assumptions made here (for ops/DECISIONS.md)

1. **Tree kill FIRST.** `JobHandle.kill()` issues `taskkill /PID <pid> /T /F` immediately while the job is alive and falls back to
   `child.kill()` after `graceMs`; the literal "child.kill() then taskkill after grace" order cannot work on Windows: `child.kill()` is
   TerminateProcess of the parent only, after which `/T` can no longer enumerate the orphaned tree (`kill_me` grandchild). `done` also
   awaits the taskkill so no helper process outlives the run. By PID only, never `/IM`; no kill after an observed exit (pid reuse).
2. **libuv adds env vars.** On Windows `uv_spawn` copies `LOGONSERVER`, `SYSTEMDRIVE`, `USERDOMAIN`, `USERNAME`, `WINDIR` from the parent
   into every child env that lacks them. The literal allow-list is what the app PASSES (asserted on the JobSpec and by the runner);
   the fake tolerates exactly these five names (reported apart, never a secret). Consequence worth knowing: the Windows user name always
   reaches the CLI child.
3. **`--fallback-model haiku` is omitted when the model is haiku** (the smoke run): Claude Code refuses a fallback equal to the main
   model (UNVERIFIED from memory of the CLI's behaviour; add to the M-CLI-1 checklist).
4. **usable() for a CLI id that was never started answers ok**; `get()` then runs the provider-start smoke before any user data (B12's
   "smoke within 24 h" is enforced at `get()`, which re-smokes after 24 h). A failed smoke with a non-retryable code holds items until a
   user action (`invalidate()` via provider switch / "Test again").
5. **Overage**: the in-flight run is killed at the `rate_limit_event` (stops paying) and its output discarded; the runner refuses every
   run until `allowOverage` or `resetsAt`.
6. **Strike-abort kills do not count for the CLI breaker** (init failures, timeouts and crashes do).
7. The smoke prompt uses a fixed constant nonce block (it carries no untrusted data).
8. `agentic` draft: the PROVIDER starts and closes the tool server (its injected `startToolServer`), because `AgenticRunInput` has no
   url/token and the listener must die in the same `finally` as the job; `draft.ts` hands it `gate.exposedSpecs()` + the RunCtx.
9. `prefetch` draft: only `prefetchWaContext()` is inlined; free/busy is already app_computed in the S3 data block from S2 (the draft
   stage has no slot to call `prefetchFreeBusy()` with).

## REQUESTS

1. **Orchestrator (seams doc, additive signature refinements made here - please index them in `v2-wave0-seams.md`)**:
   `createJobRunner` deps += optional `proc` (S-JOB: spawn/killPid/setPriority), `fs`, `timers`, `randomId` (T2 4.3 names S-JOB for
   jobRunner but the W0 signature had no slot); `createCliRunner` deps += optional `processEnv`, `budget`, `allowOverage`, `argsPrefix`,
   `mcpConfigMode`, `graceMs`, `fs`, `randomId`, and it returns `CliRunnerExt` (`health()`, `resetBreaker()`, `lastQuota()`);
   `run()` accepts the additive `ClaudeRunRequestExt` (`exposedNames`, `runId`, `auditRef`, `onStrike`) - the frozen `CliRunRequest` has
   no field for the S3 exposed names the init proof needs; `createCliStatus` returns `CliStatusRecorder`; `buildClaudeArgs(req, opts?)`;
   `createCliHandlers(deps: HandlerDepsV2 & Partial<CliHandlerExtras>)`; `SupervisorDeps.jobs?`; `ProviderFactoryDeps.now?`;
   `FakeClaudeJournalEntry` += optional `invocation`, `phase`, `mode`, `turnStarted`, `grandchildPid`; new files `claudeCli.env.ts`,
   `tests/helpers/cli-fakes-hook.world.ts`; `parsePidFile` CLI-path rule is now exact-string (stricter than W0's `isSamePath`).
2. **Orchestrator / C2**: `CliSandboxProof` has no `memoryLoaded` field (C2 9.2 prose asks for `sandbox_json.memoryLoaded`); not
   representable without a contract change - today every CLI run records only the five C2 fields.
3. **V2-W2-01 (compose wiring)**: `createJobRunner({runDir: paths.runDir, now, log})`; `createSupervisor({..., jobs})`; `reapOrphans(...,
   {acceptedCliExePaths: meta.cli_exe_paths_json values})`; `createCliRunner({jobs, userDataDir, now, audit, budget: repos.rate bucket
   'cli_global' + settings.llm.cli.maxRunsPerHour, allowOverage: () => settings().llm.cli.allowOverage, argsPrefix: (exe) =>
   seamArgsPrefix(seams.cliCmd ?? null, exe), graceMs: seams.timers.jobGraceMs?.cli})`; `createCliLocator({statFile, env: process.env,
   runWhere (production only), settingsClaudeExePath, seam: e2e ? seams.cliCmd : null, jobs})`; `createCliStatus({..., cacheMs:
   seams.timers.cliStatusCacheMs ?? LIMITS.cliStatusCacheMs})`; factory `makeClaudeCli: makeClaudeCliFactory({locator, runner,
   startToolServer: (i) => startToolServer({gate: i.gate, ctx: i.ctx, specs: i.specs, randomBytes, freePort, appVersion}), onLocated:
   write meta.cli_exe_paths_json, onSmoke: cliStatus.recordTest, onQuota: healthHub.setLlmQuota + cliStatus.recordQuota})`, `cliStatus`;
   `cliConsole: createOpenVisibleConsole()` (e2e: a recorder for `__wcaTest.consoles()`); the `CliHandlerExtras`; harness option `cli`
   + `cliJournal()` (pattern: `cli-fakes-hook.world.ts`, journals via `registerFakeJournal`); ledger source `fakeJournals:
   readRegisteredJournals`.
4. **V2-W1-03 (orchestrator)**: use `CallOpts.onSandbox` for `runs.sandbox_ok/sandbox_json`; map `LlmError` codes from
   `providers.get()` through `providerErrorToErrorCode` (today every get() failure becomes `LLM_NOT_READY`; a CLI needs
   `CLI_NOT_INSTALLED` / `CLI_VERSION` / `CLI_NOT_SIGNED_IN` / `CLI_TOOLSET_MISMATCH`); draft reason `sandbox` => `CLI_TOOLSET_MISMATCH`
   (today every failed draft becomes `LLM_BAD_OUTPUT`); the S1 wall clock for CLI providers is `LIMITS.cliWallClockExtractMs`.
5. **V2-W1-09 (agy)**: `CliRunner` agy branch calls `planAgyHome(userDataDir, <userData>\agy-workspace)` (files written, env merged over
   the AGY base), `buildAgentFile(stage, system)` into `<runDir>\.agents\agents\wca-<stage>.md`, `schema.json`, `buildAgyArgs(req,
   schemaPath)`, `checkAgyInit(<first parsed stdout object>, stage)`; result = the last stdout object with a string `status`;
   `AGY_ERROR:` / `authentication required` are read from NON-JSON stdout lines; `read_image` is refused before any spawn. The provider
   must pass `stdinLine: buildAgyStdinLine(text)`. `cli:test` for agy uses `CliHandlerExtras.makeAgyForTest`. The locator's agy probes use
   `buildAgyProbeEnv` with the REAL profile env - revisit if M-AGY-1 shows the probes need the isolated home.
6. **V2-W1-10**: `__wcaTest.jobPids()` = `jobs.jobPids()`; `consoles()` from the e2e S-CONSOLE recorder.
7. **V2-W2-02**: review the `tests/integration/fakes-v2.test.ts` one-line edit and the fake's `OS_INJECTED_ENV` tolerance (decision 2).
8. **M-CLI-1 checklist additions**: pin `CLI_OAUTH_API_KEY_SOURCE`, `CLI_NEUTRAL_INTERNALS`, the fallback-model rule (decision 3), and
   whether `mcp_server_errors` is `[]` or absent in a clean init (both accepted today).

## BLOCKED-BY

- **V2-W2-01**: `tests/integration/cli-provider.test.ts` > "B. through compose() (harness)" - `createHarness({provider:'claude_cli', cli})`
  throws `NotImplemented: harness option "cli"` until the compose/harness wiring lands (expected red, not skipped).

## FIX ROUND (2026-09-29, after `ops/agent-notes/v2-wave1-audit.md`)

Repaired, not rewritten. All four W1-09 -> W1-06 REQUESTS and the W1-03 -> W1-06 REQUEST are now DONE:

1. `src/main/llm/cli/runner.ts` - agy branch reads the `{event:'result', result:{...}}` envelope through W1-09's `agyEventResult`
   (a top-level `status` object is no longer taken as a result) and classifies it with `classifyAgyResult` (result table unchanged in
   meaning: SUCCESS + structured_output + empty/absent denied_actions => ok, else bad_output, never retried).
2. Error exits are classified from the JobRunner's marker-only stderr view with `classifyAgyExit(done.exitCode, done.stderrMarkers)`
   FIRST; the old non-JSON-stdout `AGY_ERROR:` / `authentication required` reading is kept only as a fallback (format U-A3 unverified).
   `src/main/proc/jobRunner.ts` `JOB_STDERR_MARKERS` += `auth_required` (/authentication required|UNAUTHENTICATED/i),
   `malformed_input` (/malformed input|unsupported stream message/i), `http_429` (/\b429\b/). Names only ever leave the job (B26).
3. Pre-init agy refusals (no init event, not aborted, not timed out, not killed by us): `classifyAgyExit` decides - not signed in =>
   `not_logged_in`, refused stdin line => `not_ready` (U-A6, never an argv fallback), AGY_ERROR => its code; sandbox = NO_PROOF;
   **no breaker strike** (a provider state, not instability - decision 10 below). A pre-init exit with no known marker stays `sandbox`
   + breaker strike as before; Claude runs never read these markers as agy states (unit-tested).
4. `src/main/ipc/handlers/cli.ts` `cli:allowWorkspace` checks `deps.agyRunning()` BEFORE the preview and the native dialog (UX2 7.4
   "Close Antigravity first"): running => `BAD_REQUEST`, a failing probe counts as running (fail closed), a missing probe => `INTERNAL`
   (missing collaborator fails closed like the dialog/window). `allow()` still re-checks S-PROC.
5. `src/main/agent/draft.ts` `DraftInput.onSandbox?` (additive) forwarded into the CallOpts of `runAgentic` and of the prefetch
   `structured()`; the turn loop never gets it. W1-03's `Object.assign` workaround in `orchestrator.ts` (~line 654) now type-checks as a
   plain member and can be simplified by its owner (cosmetic, no behaviour change).

Tests: `runner.test.ts` agy fixtures moved to the real envelope; the mocked `./antigravityCli` now re-exports W1-09's REAL pure
classifiers (`agyEventResult`, `classifyAgyResult`, `classifyAgyExit`) so the runner is tested against their definitions; new cases for
every stderr-marker route + a pre-init block (no proof, breaker stays closed); `cli.test.ts` "refused while agy runs BEFORE any dialog";
`draft.loops.test.ts` onSandbox forwarding (agentic + prefetch, absent => no key).

Decision 10 (for DECISIONS): agy `not_logged_in` / `not_ready` / `usage_limit` before init do not count toward the CLI breaker - they
are user-fixable states surfaced by their own cards; counting them would turn "please sign in" into `CLI_UNSTABLE` after 5 tries.

### Verification (fix round, after the last edit)
| Check | Result |
|---|---|
| `npx eslint` on the 7 touched files `--max-warnings 0` | clean |
| `npm run typecheck` | 0 `error TS` (whole tree) |
| `vitest --project main` | 179 files, 4717 passed + 1 expected fail (R-PROMPT-SIZE) |
| `vitest --project renderer` | 64 files, 1017 passed |
| `tests/integration/agy-provider.test.ts` | 28/28 (audit #1, #5 green) |
| `tests/security/agy.sandbox.test.ts` | 34/34 (audit #2, #3 green); `cli.sandbox`, `cli-env-poisoning`, `media-isolation` green |
| `tests/integration/cli-provider.test.ts` | 24/25 - part B still BLOCKED-BY V2-W2-01 (harness option `cli`) |
| coverage `runner.ts` + `jobRunner.ts` | 100/100/100/100 |

Full integration / security runs at the time of this round showed many harness-based failures with
`ReferenceError: wave0HandlerDepsV2 is not defined` at `src/main/compose.ts:1315` - compose.ts is being edited concurrently by its
owner (V2-W2-01); none of those tests touch a file changed in this round.

### REQUESTS (fix round)
- V2-W1-03 (optional, cosmetic): drop the `Object.assign` wrapper around `draftInput` in `orchestrator.ts`; `onSandbox` is a real
  `DraftInput` member now.
- Orchestrator: record decision 10 above.

### BLOCKED-BY (unchanged)
- V2-W2-01: `cli-provider.test.ts` part B (harness option `cli`).
