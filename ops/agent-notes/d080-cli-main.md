# d080-cli-main - D-080 main side (CLI sign-in session, agy effort conflict, error-before-init)

Label: d080-cli-main. Scope: src/main/llm/cli/**, ipc/handlers/cli.ts + llm.ts, llm/factory.ts, shared/errors|types|ipc.ts, the two fakes + tests.
Started from a clean tree at 7fc9d3a (the interrupted attempt of this round had left no edits). No CLI exe, no live app data, no
credentials touched; every test drives the fakes / scripted JobRunner / S-CONSOLE. No dependency, no version change, no commit.

## What changed (failing tests written first, then the code)

### 1. agy effort conflict (antigravityCli.ts)
- `agyModelEffort(slug)` / `AGY_EFFORT_SUFFIX_RE = /-(minimal|low|medium|high|xhigh|max)$/i`. `buildAgyArgs` passes `--effort low` ONLY when
  the slug has no suffix. Default `gemini-3.8-flash-high` => no `--effort`; `gemini-3.8-flash` / `-flash-lite` => `--effort low`.
- fake-agy.mjs: `--effort` no longer a required flag; a missing `--effort` on an UNsuffixed slug is a violation; `--effort` + suffixed slug
  => exactly the 1.2.16 behaviour: stderr `error: invalid model selection (--model "X" --effort "low"): --model X conflicts with --effort=low`,
  first stdout event `{"event":"result",conversation_id,status,response,error,duration_seconds,num_turns,usage}`, exit 1 (violation
  `effort_with_suffixed_model`). Keys are from the capture; the VALUES of status/response/usage are marked ASSUMED in the fake.
- Regression pin: the production S1/smoke argv literal tests in tests/security/agy.sandbox.test.ts run the real builders against the fake -
  re-adding `--effort` breaks ~30 security tests (seen red before the fix).

### 2. error before init (runner.ts)
- `errorTextBeforeInit(provider, ev)`: agy `event: 'result' | 'error'` (flat 1.2.16 shape, nested `result`, `{"event":"error"}`); Claude
  `type: 'result'` or `type: 'assistant'` with `error`. Only consulted when the init check already FAILED - a passing init is never
  reinterpreted. Text kept in memory only (cap 2000 chars), never logged/audited.
- `classifyErrorBeforeInit(text, stderrMarkers)`: model/flag -> `model_rejected`; auth -> `not_logged_in`; quota -> `usage_limit`;
  rate limit -> `rate_limited`; overload -> `overloaded`; else `network` (CLOUD_UNAVAILABLE). Text first, then the marker-only stderr view.
  A model rejection wins over an auth word in the same text.
- On such a first event: job killed, nothing later read (I11), NO toolset_mismatch audit, NO breaker strike, NO identity pause,
  sandbox NO_PROOF, stopReason bad_output. `cli_run` audit gets `errorBeforeInit: <code>` (enum only).
- A stream with no recognisable event keeps `no_init` -> sandbox (unchanged).
- New ProviderErrorCode `model_rejected` -> ErrorCode `CLI_MODEL_REJECTED` (action `choose_model`), in NO_RETRY_PROVIDER_ERRORS.
- proc/jobRunner.ts (outside my list, one additive line): stderr marker `model_rejected` (/invalid model selection|conflicts with --|unknown
  model|issue with the selected model/i). Needed because the task says to read the collected stderr markers.
- fake-claude-cli.mjs modes: `oauth_expired` (the D-080 stream: init FIRST, assistant `error:"authentication_failed"`, is_error result) ->
  CLI_NOT_SIGNED_IN (already right before, now pinned); `auth_error_before_init` -> CLI_NOT_SIGNED_IN; `model_error_before_init` ->
  CLI_MODEL_REJECTED. fake-agy modes `result_error_auth|quota|other`.

### 3. guided sign-in session (cli.ts, locator.ts, deps.ts, compose.ts)
- S-CONSOLE (`OpenVisibleConsoleFn`, deps.ts - outside my list, type only) now takes `opts.env` and may return `{ exited: Promise<void> }`
  (resolves on exit or spawn error, never rejects). Production `createOpenVisibleConsole` returns it; still spawn of the exe itself,
  shell:false, detached, visible, never cmd.exe.
- `buildSignInEnv(provider, processEnv, agyHome)`: Windows basics (SystemRoot, windir, ComSpec, PATHEXT, Program*, USERNAME, TEMP...) +
  PATH = default system path (System32;SystemRoot;Wbem;PowerShell) + claude: the profile vars buildClaudeEnv copies by name (USERPROFILE,
  HOMEDRIVE, HOMEPATH, APPDATA, LOCALAPPDATA) + DISABLE_AUTOUPDATER/TELEMETRY/ERROR_REPORTING; agy: planAgyHome().env (isolated) +
  AGY_CLI_DISABLE_AUTO_UPDATE. Never ANTHROPIC_*, CLAUDE_CONFIG_DIR, proxies, NODE_OPTIONS, CI (CI=1 could make the login non-interactive).
- agy console: writes the app-owned isolated settings.json (same bytes as every run), cwd = `<userData>\agy-home` (was %USERPROFILE% -
  the sign-in landed where the runs never look). No userDataDir => INTERNAL, no console.
- Session per provider (`busy` set reserved synchronously -> a double click never opens two consoles; second click => `{opened:true,
  alreadyOpen:true}` + a push). Phases recorded on the status service (`recordSignIn`) and pushed via `emitCliChanged` (`cli:changed`):
  open -> (console exit) invalidate + re-probe -> retesting -> runTest ONCE (no breaker reset - only the "Test again" click resets) ->
  done {ok, code, at}. Quit in progress (`closed()`) => no re-test, session cleared. Untracked console (e2e recorder returns nothing) =>
  legacy behaviour (invalidate, no session) - so e2e cli-connect (3) is unchanged.
- `cli:test` body factored into `runTest(provider, {resetBreaker})`, behaviour unchanged.
- compose.ts (outside my list, wiring only): createCliHandlers gets `userDataDir`, `processEnv: cliEnv`, `emitCliChanged`, `closed`; the
  cliRunner wrapper pushes `cli:changed` after a run ended in not_logged_in.

### 4. stale "signed in" / 'unknown'
- CliRunnerExt.onRunEnd(listener) (runner notifies every finished run; a throwing listener is ignored). createCliStatus subscribes when the
  runner has it: `not_logged_in` => provider marked signed-out; it overrules a `ready`/`unknown` probe (cache or fresh) until a run proves
  the sign-in (`signInEvidenceOf`: initOk + error null / usage_limit / overage) or `recordTest(ok:true)`. too_old / not_installed untouched.
- llm.ts: 'unknown' removed from CLI_STATE_CODE. llm:setProvider with 'unknown' => consent check, then the smoke ALWAYS runs (a fresh
  older test is not trusted) and its outcome is reported; without a smoke runner => `CLI_NOT_SIGNED_IN` with `params: {state:'unknown'}`.

### Shared contract (renderer agent)
- `CliStatus.signIn?: CliSignInSession` - ABSENT = idle. `CliSignInSession = { phase: 'idle'|'open'|'retesting'|'done'; outcome: {ok, code:
  ErrorCode|null, at} | null }`; `CLI_SIGN_IN_PHASES` exported from shared/types.ts.
- `cli:signIn` response `{ opened: true; alreadyOpen?: true }`.
- `CLI_MODEL_REJECTED` (action choose_model) needs `errors.CLI_MODEL_REJECTED.{title,body,action}` in en/he - locales.test.ts is red until
  the renderer agent adds them (expected, not weakened).
- `CLI_NOT_SIGNED_IN` may carry `params.state === 'unknown'` => the renderer should say "Could not tell whether you are signed in".

## Open / for M-AGY-1 (not decided here)
- The real agy init line was never seen (the diagnostic run failed before it). The documented init has no `agent` field; checkAgyInit still
  requires `init.agent === 'wca-<stage>'` (NOT relaxed). To decide M-AGY-1 we need one scrubbed capture of a SUCCESSFUL run's first event
  (keys of `init`: cwd/tools/permission_mode/agent?) with the corrected argv.
- The 1.2.16 error result was FLAT (`{"event":"result",status,...}`); the success-path reader `agyEventResult` still requires the nested
  `{"event":"result","result":{...}}` envelope and `structured_output`. If a real success result is flat too, every agy run would end as
  `network`. Not changed on a guess - needs the same capture (keys of a successful result event, where the structured output lives).
- HOMEDRIVE/HOMEPATH are not set for the agy console (libuv copies the parent's), same as the runs.

## Verification
- npm run lint: clean. npm run typecheck: clean (node, web, tests).
- npx vitest run (all projects, with the renderer agent's concurrent edits in the tree): 335 files, 7808 passed, 1 expected fail,
  1 skipped, 0 failed. After prettier --write of my files: lint + typecheck clean again, focused re-run 38 files / 1335 tests green.
- e2e NOT run (per the task).
