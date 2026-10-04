# v2-wave1-audit - read-only audit of the 12 v2 Wave-1 packages

Date: 2026-09-29. Auditor: `v2-wave1-audit` (edits only this file and `ops/agent-notes/v2-audit/`).
Tree state: shared working tree on `main` (HEAD a990584), uncommitted Wave-1 work. v1 baseline = `6223fcf` (the pre-scrub
"Baseline v0.1.0" commit; `ops/agent-notes/v2-audit/diffstat-6223fcf.txt`: 289 files changed, +40592 / -2252).

## 1. Commands and raw output (all under `ops/agent-notes/v2-audit/`)

| Command (exact package.json script / brief) | Exit | Result | Capture |
|---|---|---|---|
| `npm run lint` (`eslint . --max-warnings 0`) | 0 | clean | `lint.txt` |
| `npm run typecheck` (node + web + tests tsconfigs) | 0 | 0 `error TS` | `typecheck.txt` |
| `npx vitest run --project main` | 0 | 179 files, 4697 tests: 4696 passed + 1 expected fail | `main.txt`, `main.json` |
| `npx vitest run --project renderer` | 0 | 64 files, 1017 tests passed | `renderer.txt`, `renderer.json` |
| supplementary: `npx vitest run --project integration` | 1 | 26 files (9 failed), 287 tests: 248 passed, **39 failed** | `integration.txt`, `integration.json` |
| supplementary: `npx vitest run --project security` | 1 | 39 files (3 failed), 1011 tests: 981 passed, **30 failed** | `security.txt`, `security.json` |

The four required commands are all green. The one expected fail is the deliberate `it.fails` pin in
`src/main/agent/prompt.size.test.ts:144` (assembled S1 < 8 KB; R-PROMPT-SIZE, still undecided - W1-03 REQUEST to the
orchestrator). The integration and security projects were run in addition (only fakes; no binary, no network) because every
package's BLOCKED-BY list points into them; their 69 failures are classified below.

Several reported Wave-1 blockers have been resolved since the packages reported and are now green:
- W1-10 blocker `chat:setPolicy {autoPolicy} ... lists the chat` - `repos.chats.withPolicies()` now includes `auto_policy = 'never'` (W1-01 fulfilled).
- W1-05 blocker `wa-tools.test.ts` "a draft quoting another chat is a leak" - `validate.crossChatLeak` implemented (W1-03).
- W1-11's note that `v2-stubs.test.tsx` was red - now green.
- W1-12 observation `import-graph.test.ts` B (`actionExecutor.fixtures.ts` value import) - now green.
- W1-09 blocker "confirmWorkspaceTrust is a NotImplemented stub" - W1-04 implemented it (but see 3.1 A2).
- W1-01 REQUESTS to W1-10 (`consent:accept` passes `ANTIGRAVITY_TERMS_READ_ON`; `data:purgeNow` wipes dirs and disables a live policy with reason `purge`) - done.
- W1-08 typecheck errors in `pipeline-image.test.ts` / `vision-no-tools.test.ts`, W1-03 typecheck errors from `actionExecutor.fixtures.ts` - gone (typecheck exit 0).

## 2. Failure map (integration + security; main and renderer have none)

Owner column = build-plan section 6 owner of the file whose code must change.

| # | Test file (tests) | Failing because | Class | Owner of the fix |
|---|---|---|---|---|
| 1 | `tests/integration/agy-provider.test.ts` - 12 runner tests (opt-in smoke, 2 prefetch, 9 of "every mode of T2 3.2": ok, waiting, denied, no_structured, exit3, exit3_auth, not_signed_in, garbage_lines, global_mcp_present) | `src/main/llm/cli/runner.ts` agy branch: ignores the `{event:'result',result:{...}}` envelope (every run ends `network`); looks for `AGY_ERROR` / `authentication required` on stdout only (runner.ts:408-409) while agy prints them on stderr; `JOB_STDERR_MARKERS` (`proc/jobRunner.ts:79`) lack `auth_required`, `malformed_input`, `http_429` | (b) unfulfilled REQUEST W1-09 -> W1-06 | **V2-W1-06-claude-cli** |
| 2 | `tests/security/agy.sandbox.test.ts` - 4 result-table tests (ok, waiting, denied, no_structured) | same runner defect as #1 (the runner-independent cross-check in the same file is green) | (b) W1-09 -> W1-06 | **V2-W1-06** |
| 3 | `tests/security/agy.sandbox.test.ts` - "the Claude envelope is refused by the fake (exit 1, malformed input): not_ready" | runner maps a rejected stdin line to `sandbox`, U-A6 requires `not_ready` | (b) W1-09 -> W1-06 | **V2-W1-06** |
| 4 | `tests/integration/agy-provider.test.ts` - "global_checked: the dialog shows the one-line diff ..." | the test's handler fixture passes `window: () => 'WIN'` (a string). W1-04's `createAutoDialog.ask` fails closed on a parent without `isFocused()` (autoDialog.ts:57-62, 91): it records the dialog, answers Cancel, never calls `showMessageBox`. Cancel returns `ok:true` status, so `showMessageBox` count is 0 | (a) test-fixture defect in the W1-09-owned test (cross-package mismatch with W1-04's fail-closed parent rule, which is correct per UX2) | **V2-W1-09-antigravity** (pass a focused window double `{isFocused:()=>true,isDestroyed:()=>false}`) |
| 5 | `tests/integration/agy-provider.test.ts` - "refused while an agy process runs (S-PROC)" | `ipc/handlers/cli.ts` `cli:allowWorkspace` never checks `agyRunning()` before the dialog (cli.ts:214-226); currently also masked by #4 (Cancel => `ok:true`) | (b) unfulfilled REQUEST W1-09 -> W1-06 | **V2-W1-06** (and #4's fixture) |
| 6 | `tests/integration/pipeline-edit.test.ts` - 5 tests (reschedule, move/cancel, duration-only, reject, approve) | `compose()` does not pass `updateSurfaceAvailable` / `tryAuto` / `voice` / `readImage` / `pickImage` / `onTranscribing` / `featureGates` to `createOrchestrator`, so every delta degrades to `change_in_google` and no Change card exists | (c) compose | (list only) |
| 7 | `tests/integration/pipeline-edit.test.ts` - "self trigger (F28)" | needs compose (#6) **and** the ENQUEUE half of F28 in `bridge/ingest.ts` `handleOutbound` (ingest.ts:240-250 still closes with `answered_elsewhere`) | (b) unfulfilled REQUEST W1-03 -> W1-07, plus (c) | **V2-W1-07-media-voice** (W1-07 says it needs `findExistingEvent`/`trigger_author`; W1-03 says its side is done - orchestrator must assign) |
| 8 | `tests/integration/editing-executor.test.ts` - 4 tests | compose does not wire the v2 executor / change cards (`undefined.actions`) | (c) compose | (list only) |
| 9 | `tests/integration/recovery-v2.test.ts` - crash_after_patch | same as #8 | (c) compose | (list only) |
| 10 | `tests/integration/auto-mode.flow.test.ts` - 2 tests | `auto:*` handlers answer through `wave0HandlerDepsV2` (INTERNAL) | (c) compose | (list only) |
| 11 | `tests/security/auto-mode.injection-corpus.test.ts` - Part B (1 test) | same as #10 | (c) compose | (list only) |
| 12 | `tests/integration/cli-provider.test.ts` - part B (1 test) | `NotImplemented: harness option "cli"` | (c) harness/compose | (list only) |
| 13 | `tests/integration/pipeline-image.test.ts` - Part B (5 tests) | `NotImplemented: harness option "media"` | (c) harness/compose | (list only) |
| 14 | `tests/integration/pipeline-voice.test.ts` - Part B (2 tests) | `NotImplemented: harness option "whisper"` | (c) harness/compose | (list only) |
| 15 | `tests/integration/pipeline-wa-tools.test.ts` - 4 tests | `NotImplemented: harness option "waWorld"` | (c) harness/compose | (list only) |
| 16 | `tests/security/injection-corpus.test.ts` - 24 cases (8 `wa_row` x2 langs, `voice_transcript`, `image_text`, `existing_event_title`, `cli_output` x2 langs) | the frozen v1 runner's `deliver()` has no branch for the 5 v2 vectors ("the model was never called"). The runner is W0 -> frozen -> **V2-W2-02** (section 6); the obedient attacker `InjectionCase` has already been widened by W1-04 | (b) unfulfilled REQUEST W1-05 -> V2-W2-02 (a Wave-2 package; not a Wave-1 defect) | V2-W2-02-security (Wave 2) |

Totals: class (a) 1 test (#4); class (b) 18 Wave-1 tests (#1, #2, #3, #5; plus #7 which is also (c)) + 24 corpus cases owed to V2-W2-02;
class (c) 26 tests (#6, #8-#15, #7 counted here too).

Not collected at all (so neither green nor red): `tests/golden/golden.v2.test.ts` - `vitest.config.ts` integration `include` does not
list it (W1-03 REQUEST -> V2-W2-01). W1-03 reports part 2b (8 tests) and part 3 (13 tests) red when it is run directly. The
orchestrator should treat those 21 as outstanding (c)/(b) items, not as passing.

## 3. Findings per class

### 3.1 (a) Genuine defects in the owner's files
- A1 none in production source from the four required commands (lint, typecheck, main, renderer all green).
- A2 `tests/integration/agy-provider.test.ts` (owner V2-W1-09): the workspace-trust fixture passes a string as the dialog parent;
  W1-04's `autoDialog` correctly refuses to show a box without a focused parent (records it, answers Cancel). The test was written
  against the Wave-0 stub and never ran against W1-04's body. Fix is in the W1-09 test, not in autoDialog.
- A3 (latent, no red test yet) `src/main/ipc/handlers/cli.ts` `cli:allowWorkspace`: after Cancel it returns `ok:true` with a status
  (not an error). That is consistent with other confirm channels but means the "refused while running" case can only be proven once
  the `agyRunning()` pre-check (REQUEST #5) lands.

### 3.2 (b) Failures caused by an unfulfilled REQUEST
| REQUEST (from -> to) | Status | Red tests it causes |
|---|---|---|
| W1-09 -> W1-06: runner.ts read agy `{event:'result'}` envelope via `agyEventResult`/`classifyAgyResult` | NOT done | #1, #2 |
| W1-09 -> W1-06: classify agy exits from `done.stderrMarkers` with `classifyAgyExit`; add `auth_required`, `malformed_input`, `http_429` to `JOB_STDERR_MARKERS` | NOT done | #1, #2 |
| W1-09 -> W1-06: rejected stdin (`malformed input`, exit 1/2 before init) => `not_ready` | NOT done | #3, `not_signed_in` in #1 |
| W1-09 -> W1-06: `cli:allowWorkspace` checks `agyRunning()` before the native dialog | NOT done | #5 |
| W1-03 -> W1-07: F28 enqueue half in `bridge/ingest.ts handleOutbound` | NOT done | #7 (also needs compose) |
| W1-05 -> V2-W2-02: `injection-corpus.test.ts deliver()` for 5 v2 vectors | Wave 2, pending | #16 (24 cases) |
| W1-04 -> W1-10: relax `item:undoChange` / `ItemService.undoViewOf` from `candidate.itemId !== item.id` to "the item carries this event" | NOT done (`ipc/handlers/items.ts:70`, `agent/items.ts:218`) | none today; will surface in `auto-mode.flow` toast Undo after a change chain once compose lands |
| W1-03 -> W1-06: `onSandbox` in `DraftInput`, forwarded to `runAgentic` / prefetch `structured()` | NOT done (`agent/draft.ts` has no `onSandbox`) | none today; `runs.sandbox_json` stays empty for S3 CLI runs |
| W1-06 -> W1-03: `providerErrorToErrorCode` for `providers.get()` errors | done (`orchestrator.ts:331`) | - |
| W1-07 -> W1-03: `voice.transcribeChat()` before S1 | done (`orchestrator.ts:353`) | - |
| W1-04 -> W1-09 InjectionCase widening (W1-05 -> W1-04) | done (`tests/fakes/obedient-attacker-llm.ts:13-43`) | - |
| W1-01 -> W1-10 (consent 4th arg, purge dirs + policy disable) | done | - |
| W1-10 -> W1-01 (`withPolicies` + `auto_policy='never'`) | done (`db/repos/chats.ts:215`) | - |
| W1-09 -> W1-04 `confirmWorkspaceTrust` | done (`app/autoDialog.ts:142`) | - |

Open orchestrator/contract REQUESTS that cause no red test but need a decision (collected from the 12 notes): mergeLidInto vs frozen
`actions.chat_id` (W1-01); `UpdateSurfaceProblem` lacks `etag_missing`/`unverified` (W1-02); `CliSandboxProof.memoryLoaded` missing
(W1-06); libuv injects HOMEDRIVE/HOMEPATH/LOGONSERVER/USERDOMAIN/USERNAME/WINDIR into every Windows child env so job env is a
superset of the I6' allow-list (W1-06, W1-07, W1-09 - one decision covers all three); `unsafe_config` provider code (W1-09);
AutoGate `badge_amber` vs `media_derived` ordering (W1-08); LLM wall-clock timeout ErrorCode (W1-08); `HandlerDepsV2` lacks
`autoDialog` + dialog parent + i18n (W1-10, W1-04); C2 1.5 VM fields `triggerAuthor`/`canRestoreOriginal`/`provider`/voice
`modelLabel` (W1-11, W1-10); decisions read channel, shadowTally split, voice per-tier state, `claudeExePath` reset, consent
withdraw channel, nobody sets `voice.enabled=true` after download (W1-12); `.gitignore` `store/` also ignores
`src/renderer/src/store/` so the renderer stores were never committed to the public repo (W1-12 - **publishing risk**, change to
`/store/` before the next push); R-EVAL-LEAK and R-PROMPT-SIZE (W1-03); missing indexes `items.calendar_event_id` /
`auto_policy='never'` (W1-01, optional).

### 3.3 (c) Blocked only on V2-W2-01's compose() / harness (expected per plan concern 1 - listed, not assigned)
`pipeline-edit` (5 + self-trigger), `editing-executor` (4), `recovery-v2` (1), `auto-mode.flow` (2),
`auto-mode.injection-corpus` Part B (1), `cli-provider` part B (1), `pipeline-image` Part B (5), `pipeline-voice` Part B (2),
`pipeline-wa-tools` (4); plus `golden.v2.test.ts` (not collected; 21 tests red when run directly per W1-03).

### 3.4 (d) NotImplementedError stubs left in `src/**`
Only the Wave-0 wiring placeholders owned by V2-W2-01 remain:
- `src/main/compose.ts:159-171` - `wave0HandlerDepsV2` Proxy (`HandlerDepsV2.<name>.<prop>`) and `cliConsole`.
- (tests, not src) `tests/helpers/harness.ts:250,253,540,543,548` - harness options `cli`/`media`/`whisper`/`waWorld`,
  provider `claude_cli`/`antigravity_cli`, `cliJournal`, `whisperJournal`, `jobs`.
No Wave-1 owned source file still throws `NotImplementedError` (grep of `src/**` excluding tests and `notImplemented.ts`).

### 3.5 (e) v1 regressions
None. Method (git stash forbidden): v1 test files = `git ls-tree 6223fcf` `*.test.{ts,tsx,mjs}` (217 files,
`v1-test-files.txt`). Every test in the main and renderer projects passes. In integration/security the only failing file that
existed at the baseline is `tests/security/injection-corpus.test.ts`; its baseline corpus had 68 cases (48 en + 20 he), none
with a v2 id; today 102 cases, the 78 non-v2 ones (incl. all 68 v1 ids) pass and the 24 failing ids are all new v2-vector cases.
All other failing files are new v2 files (absent at 6223fcf). `tests/golden/golden.test.ts` (v1) and `tests/integration/recovery.test.ts` (v1) pass.

## 4. Assumptions and dead ends
- Ran the integration and security projects as a supplement; they only use the repo's fakes (node-spawned `.mjs`), no downloaded binary.
- Did not run coverage (not in the brief); the T2 13 per-file safety thresholds are therefore unverified by this audit.
- `6223fcf` is not an ancestor of HEAD (history was rewritten for the public push); used it only as a read-only tree for `ls-tree` / `show` / `diff --stat`.

## REQUESTS
- Orchestrator: assign REQUEST #7 (F28 ingest half) explicitly - W1-03 and W1-07 each consider the other side the missing one.
- V2-W1-06: the four agy runner/handler REQUESTS from W1-09 (section 3.2) are the only Wave-1-owned source changes blocking red tests.
- V2-W1-09: fix the workspace-trust handler fixture's window double (finding A2).
- V2-W2-01: add `tests/golden/golden.v2.test.ts` to the integration include so its 21 tests are visible.
- Orchestrator: fix `.gitignore` `store/` -> `/store/` before the next public push (W1-12 finding), after the push scan.

## BLOCKED-BY
- none (auditor).
