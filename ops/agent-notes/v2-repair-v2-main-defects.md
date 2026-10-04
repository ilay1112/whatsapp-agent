# v2-repair-v2-main-defects - repair notes (2026-10-04)

Scope: every file under `src/main/**` + `tests/helpers/harness.ts` (v2 phase 3 repair round). Inputs read first:
`ops/agent-notes/V2-W2-03-e2e.md` (REQUESTS 1-13), `v2-build-proof.md`, `V2-W1-09-antigravity.md`. Every diagnosis was checked
against the code before a change; each fix has a test that was RED before the fix (run and seen failing), except where noted.
No renderer, fake, packaging, docs or ops file of another agent was edited. Nothing committed. No e2e run (a later step does it).
No vendor binary, whisper, llama-server or bridge was run; the only processes were the `.mjs` fakes under the system node.exe.

## Fixed (diagnosis confirmed -> red test -> fix)

| # | Root cause (confirmed) | Fix | Red-first test |
|---|---|---|---|
| 1 | `db/repos/queue.ts` computed the debounce from `LIMITS` directly; only the TriageQueue got `WCA_TIMERS` | `createQueueRepo(db, timers?)` + `createRepos(db, {queueTimers})`; compose passes the seam's `debounceMs`/`debounceCapMs` (non-positive / NaN ignored; production passes nothing) | `src/main/db/repos/queue.timers.test.ts`; L3 `v2-main-repairs` "REQUEST 1" |
| 2 | `notifyAuto` fired only on a policy change / auto write; a click-approved create and a recorded shadow/fallback decision moved AutoState silently | executor: `notifyAuto({kind:'policy'})` after a click-approved `create_event` that completed `done`; after EVERY decision `recordDecision` stores; after a non-done automatic write. Compose turns it into `auto:changed` from the policy service's CURRENT state | `src/main/exec/actionExecutor.repairs.test.ts`; L3 "REQUEST 2" (re-verified red by temporarily removing the line) |
| 3 | `insertChange` copied `current.event` into the undo's new proposal version, so the card (`ItemCard.event` = current proposal) kept the undone slot | `insertChange(..., event?)`: an undo passes its restore target (`plan.restoreTo`); a cancel / undo-of-create keeps the current content | `actionExecutor.repairs.test.ts` REQUEST 3 |
| 4 | `contextFor` admits an audio row only with a DONE transcript, so after a failed V0 the note was not among the trigger rows -> `failedVoice` never found -> `not_needed` | orchestrator: the failed-voice lookup reads the trigger rows of the raw media window (`deps.audioWindow`), the same rows V0 read | L3 "whisper exit 3" (item `failed` / `VOICE_MODEL_MISSING`, listed card) |
| 5 | `onTranscribing(0)` is set before the note's duration is known and nothing updated it | compose: the voice service's progress hook (`audioSeconds`, decided from the Ogg granule before decode) updates `transcribingSeconds` + pushes `queue:changed` | L3 "queue:changed transcribing {seconds: 3}, then null" |
| 7 | (a) `refreshLlmHealth` ran only on settings change / start; (b) a provider-start smoke that hit the usage window is never cached, and the runner's pause was only read through a cached provider; (c) a failed init proof is one runner strike, not a readiness state; (d) `model` fell through to the Gemini id for CLI ids; (e) usage_limit closed/held the item `failed`/`waiting_llm` instead of `held/budget` | factory: optional `cliRunnerHealth` (runner pause reported for a CLI id even uncached; a sticky code that IS the runner pause ends with it) + `onReadiness`; compose: observation-only runner wrapper records `sandbox` => `CLI_TOOLSET_MISMATCH` until a clean run of that CLI; `refreshLlmHealth` after every CLI run / readiness change / every 30 s; per-provider model; `llmStatusFor` maps CLI_NOT_INSTALLED/CLI_VERSION -> not_installed, CLI_NOT_SIGNED_IN -> not_signed_in (overage / toolset / unstable stay `failed` + code, C2 3). S0: usable code `CLOUD_QUOTA` => `held/budget` with code (ingest stores it); orchestrator: a smoke or run `usage_limit` => `held/budget` + `CLOUD_QUOTA`; `releaseQuotaHeldItems` (only `held/budget` + `CLOUD_QUOTA`, never v1 budget holds) runs when the provider is usable again | L3 REQUEST 7 x6 (model id, usage_limit hold + self-release after resetsAt, S1 usage_limit, overage, S1 extra_tool, smoke extra_tool); `factory.repairs.test.ts`, `stage0.repairs.test.ts` (written after the fix, they pin the branches) |
| 9 | isolated agy mode never recorded workspace trust (`workspaceTrusted` stayed null) | compose: `AGY_PROFILE_MODE === 'isolated'` => `cliStatus.recordWorkspaceTrusted(true)` ("not needed": the app-owned profile trusts its own workspace; the user's settings.json is never read/written) | L3 "REQUEST 9" |
| 10 | `jobs.killAll()` resolved on 'exit', the pid file was removed only in runOnce's `finally` (after the 250 ms stdio-close wait + the tree kill), and app.exit() follows at once | `RunningJob.pidFile`; `killAll()` removes each dead job's pid file and drops it from the live set right after its exit (idempotent with the finally) | `src/main/proc/jobRunner.quit.test.ts` |
| 11 | compose never passed `mediaManifest`; media downloads in a test build went to the REAL Hugging Face URLs (proved: the harness fetch guard recorded two blocked HF fetches) | `e2eModelManifests(raw)` (exported, pure): in a test build (`seams !== null`) every LLM tier and every media id comes from the WCA_MODEL_MANIFEST file (extended T2 4.1 shape), anything it does not name keeps its pinned name/size/sha but points at `http://127.0.0.1:9/wca-e2e-no-model-host/<id>` (refused at once); `mediaManifest` wired; `allowHttpLoopback: e2e`. Production (`seams === null`) unchanged | L3 "REQUEST 11" x2 |
| 13 | `llm:setProvider` answered `CLI_UNSTABLE` for "no passed test in 24 h", i.e. also for "never tested" | `LlmHandlersV2.runCliTest?` (additive): with no fresh passed test, setProvider runs the cli:test smoke (UX2 7.1 "While main runs the provider-start smoke: Checking...") and answers with ITS outcome (e.g. CLI_NOT_SIGNED_IN); consent + status still first; refused as CLI_UNSTABLE only while the runner breaker is really open (the smoke would reset it) | L3 "REQUEST 13" x2; `llm.repairs.test.ts` |

Antigravity runner defects of V2-W1-09 (REQUESTS 1-3) - **confirmed closed** by an earlier round, no change needed: `runner.ts` consume
uses `agyEventResult`; `classify` reads `classifyAgyExit(exitCode, stderrMarkers)` BEFORE the no-init branch; `JOB_STDERR_MARKERS` has
`auth_required`, `malformed_input`, `http_429`. `tests/security/agy.sandbox.test.ts` + `tests/integration/agy-provider.test.ts`: 62/62 green.

## Harness (tests/helpers/harness.ts) additions
- `timers` and `modelManifest` options (the WCA_TIMERS / WCA_MODEL_MANIFEST seams as compose receives them).
- **Fetch guard**: the harness `fetch` passes loopback only; any other URL is recorded in `blockedFetches` and refused (`fetched` lists
  all). Before REQUEST 11 a harness test could reach the network through a media download; now that is a visible test failure.

## Decisions / assumptions
- REQUEST 13: "show the honest not-tested state" is realised as UX2 7.1's own flow (Use => smoke => ready or the failure's ErrorCode
  row). No new ErrorCode was added (src/shared is not mine); the renderer shows the "Checking..." state while the IPC is pending.
- REQUEST 9: "not needed" is recorded as `workspaceTrusted: true` (CliStatus has no third value). The renderer may still choose to hide
  the block in isolated mode (renderer agent).
- REQUEST 7 hold reason: B13 / P2 9 say `USAGE_LIMIT -> items held/budget until resetsAt`; the code CLOUD_QUOTA on the item marks the
  hold so the automatic release never touches a v1 budget hold (runs/h, daily tokens), which keeps its "Analyse this chat".
- The toolset-mismatch health state is derived (compose map), not a factory sticky: S1 init failure stays a single runner strike
  (3 => CLI_UNSTABLE breaker, unchanged); the item is still `failed`, no S3, no retry with looser flags.
- `npx vitest run` was run as the four projects of `npm test` (main, renderer, integration, security), like v2-build-proof: the
  `golden-live` project is the user's opt-in live evaluation and is not run by agents.

## Verification (after the last edit)
- `npm run lint` 0 - `npm run typecheck` 0 - prettier --check clean on every file I touched.
- `npx vitest run --project main --project renderer --project integration --project security`: **318 files, 7386 passed, 1 expected
  fail, 0 failed** (includes the other repair agents' work in the tree at that moment).

## Not mine / left for others (REQUESTS)
- **Renderer agent**: REQUEST 2's renderer half (Settings hydrates the auto store only when null - main now emits); REQUEST 4's
  "Download (1.6 GB)" action on the VOICE_MODEL_MISSING raw card; REQUEST 9 optional: hide the workspace-trust block in isolated mode.
  REQUESTS 6 and 8 are renderer defects. REQUEST 12 is the fake calendar owner's.
- Noticed, not in my list: P2 3.5 says `VOICE_AUDIO_MISSING` retries through the queue backoff (TriageRetryError); today the fetcher
  retries once and the item becomes a terminal raw card (`failed`), which after REQUEST 4 is at least visible. Orchestrator follow-up.
- `src/main/llm/local/manifest.ts` shows as modified in the tree: that is the packaging-pins agent's edit, not mine.
