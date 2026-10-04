# V2-W1-09-antigravity - builder notes

Package: `V2-W1-09-antigravity` (Wave 1 of the v2 build, dispatched last). Brief: `docs/specs/v2-build-plan.md` section 7.
Status: **PARTIAL - own code complete and green; 19 spawn-based tests red because of two other packages** (2026-09-29, second attempt).
**Release of `antigravity_cli` stays gated on M-AGY-1** (user-run, only if the user installs agy). No agent ever runs agy; every test
drives `tests/fakes/fake-agy.mjs` under the system node.exe (T8) with mkdtemp homes (T9).

## Found at start of this attempt

The first (interrupted) attempt had left: `antigravityCli.ts` (complete), `antigravityCli.test.ts` (95 tests, green),
`fake-agy.mjs` + `fake-agy.types.ts` (complete), `tests/fakes/fake-agy.world.ts` (helper). Missing: `tests/security/agy.sandbox.test.ts`,
`tests/integration/agy-provider.test.ts`, the notes. I continued from that state.

## What is built (owned paths)

- `src/main/llm/cli/antigravityCli.ts` - every C2 9.2 declaration + the plan-3 seams, no NotImplemented left:
  `AGY_MIN_VERSION` 1.2.11; `buildAgyArgs` (literal argv, never `-p`, `--print-timeout` = wall - 10 s, `--json-schema <runDir>\schema.json`
  only by that file name, model re-validated with `AgyModelSchema` + not option-like); `buildAgyStdinLine` (agy envelope, one line);
  `planAgyHome` (F3 isolated profile `<userData>\agy-home`, only `settings.json {trustedWorkspaces}`; APPDATA/LOCALAPPDATA under it, U-A7);
  `preflightAgyGlobalConfig` (fail closed: enabled/odd server, unknown top-level key, any hook, unparsable => unsafe); `AGY_PROFILE_MODE`
  'isolated'; `buildAgentFile` (frontmatter exactly B14 + verbatim constant, type test: no untrusted parameter); `checkAgyInit` (documented
  `{"event":"init","init":{...}}` envelope; tools must be an EMPTY array, no mcp_servers, agent `wca-<stage>`, `request-review`);
  `planWorkspaceTrust` (one key, key order kept, round-trip guard refuses files a rewrite could change elsewhere);
  `listAgyModels(runner, probe?)` (parses `agy models`, never a hard-coded list; runs under the isolated profile in the app-owned
  `<userData>\agy-workspace` folder); `createAgyWorkspace` (fallback mode only; S-HOME/S-PROC; backup first, never overwrites a backup;
  refused without confirm, without preview, while agy runs or S-PROC fails, and when the file changed in ANY byte since the preview);
  `createAgyProvider` (loop `prefetch`, `capabilities.images:false`, `chat()`/V1/image parts => `unsupported`, no `runAgentic`, floor +
  fallback preflight before EVERY job, onSandbox/onQuota/onUsage, provider-start smoke `validate()`); helpers `buildAgyEnv`,
  `agyEventResult`, `classifyAgyResult`, `classifyAgyErrorText`, `classifyAgyExit` (marker view incl. `malformed_input` => not_ready),
  `parseAgyModels`, `makeAgyFactory` (the factory's `makeAgy`), `isAgyProvider`.
- `src/main/llm/cli/antigravityCli.test.ts` - T2 5 row (95 tests). Coverage of `antigravityCli.ts` from it alone: 99.3 % lines /
  97 % branches / 96.8 % functions (band 90/85/90).
- `tests/fakes/fake-agy.mjs` + `fake-agy.types.ts` - T2 3.2 in full: flag table, every mode, envelope check, `-p`/`--sandbox`/
  `--dangerously-skip-permissions`/positional => accepted + violation, agent file + frontmatter + body sha, `mcp_config_present`, schema
  file iff `--json-schema`, env allow-list, isolated-home + workspace-trust checks, `global_mcp_present`, started/final journal lines
  (`turnStarted` proves the kill-before-first-turn).
- `tests/fakes/fake-agy.world.ts` - production JobRunner + CliRunner + agy provider with only the S-JOB spawn redirected to the fake.
  ASSUMPTION: owned by W1-09 by the `<ownedFile>.<suffix>.ts` naming of plan 1.3 (it is a helper of `fake-agy.mjs`; nobody else owns it).
- `tests/security/agy.sandbox.test.ts` (group 18, agy half) - 34 tests: argv/env literal with secrets planted, isolated profile,
  smoke run, global_mcp_present in both profile modes (fallback => no spawn), init failures killed before any turn + toolset_mismatch + no
  retry + tree kill, **every agy proposal `cli_unproven` via W1-03's `providerClassOf`**, result table, stdin rejection, hang kill path,
  audit shape, fake self-test, and a runner-INDEPENDENT cross-check (fake bytes -> my classifiers) for every output mode.
- `tests/integration/agy-provider.test.ts` (T2 6 row) - 28 tests: opt-in via the production factory + real consents repo
  (`cloud_antigravity_cli` v1 + Terms read date; no consent => nothing located/spawned; floor), prefetch loop through `draft.ts`
  (one no-tool call, WhatsApp block inlined, prefetch failure tolerated), every T2 3.2 mode through the production runner, pictures ->
  Local (`routeImage`) and refused on the provider, `agy models` fills the list, workspace trust through `cli:allowWorkspace` + the
  W1-04 dialog with a mock `showMessageBox`.

## Decisions / assumptions (this attempt)

1. **Diff line** follows UX2 7.4 literally: `+ "trustedWorkspaces": [ ..., "<dir>" ]` (`[ "<dir>" ]` when the list is empty/absent;
   `= "trustedWorkspaces" already contains "<dir>"` when nothing changes). App-built from the app's own folder, never file content.
2. **allow() requires the settings file to be byte-identical** to what `preview()` read (not only the same diff line) - "diff shown ==
   diff written" cannot be bypassed by a concurrent edit of another key.
3. **`agy models` cwd** = `<userData>\agy-workspace` (created) with the isolated profile written first - never the agy install folder
   (was `dirname(exe)` in the first attempt; that folder is the user's vendor state, T9, and does not exist in tests).
4. **HOMEDRIVE / HOMEPATH**: libuv copies them from the parent into every Windows child env that lacks them, and they are not in the
   frozen `AGY_ENV_KEYS`, so an agy job sees the REAL user's HOMEDRIVE/HOMEPATH next to the isolated USERPROFILE/HOME. The fake now
   tolerates them as OS-injected (like LOGONSERVER etc.); the app's literal env (what `spawn` receives) is still asserted to be exactly
   AGY_ENV_KEYS. Risk for F3 isolation: see REQUESTS (orchestrator) + M-AGY-1.
5. `CLI_UNSAFE_CONFIG` has no ProviderErrorCode: the provider throws `LlmError('sandbox')` (no spawn, not retried) - see REQUESTS.
6. The fake's BOM strip uses `charCodeAt(0) === 0xfeff` (the literal-U+FEFF regex tripped `no-irregular-whitespace`).
7. One-line edit in `tests/integration/fakes-v2.test.ts` (W0 file, same edit V2-W1-06 / V2-W1-07 made for their fakes): `fake-agy.mjs`
   removed from the "skeleton exits 99" loop, which is now empty - V2-W2-01 may delete that test.

## Verification (2026-09-29, after the last edit)

- `npx eslint <all files above> --max-warnings 0` - clean. Prettier `--check` clean on my files (ran `--write` on my paths only;
  `fakes-v2.test.ts` has pre-existing formatting issues in other packages' blocks - not touched).
- `tsc -p tsconfig.node.json` / `tsconfig.tests.json`: **no error in files I own** (other packages: `src/main/agent/readImage.ts`
  (W1-08) and `src/main/agent/resolveDelta.test.ts` (W1-03) had errors at the time of the run).
- `vitest --project main src/main/llm/cli/antigravityCli.test.ts` - 95/95.
- `vitest --project main src/main/llm src/main/ipc/handlers/cli.test.ts src/main/proc` - 890/890 (nothing of W1-06 broke).
- `vitest --project security tests/security/agy.sandbox.test.ts` - 29/34 (5 red: BLOCKED-BY V2-W1-06).
- `vitest --project integration tests/integration/agy-provider.test.ts tests/integration/fakes-v2.test.ts` - 28/42
  (12 red: BLOCKED-BY V2-W1-06; 2 red: BLOCKED-BY V2-W1-04).
- `vitest --project security fixtures-synthetic import-graph cli.sandbox setup-guards.v2` - 182/182.

## BLOCKED-BY

- **V2-W1-06** (runner defects, see REQUESTS 1-3) - red until fixed:
  `agy.sandbox.test.ts`: "ok: SUCCESS + structured_output ...", "waiting/denied/no_structured => LlmError bad_output" (3),
  "the Claude envelope is refused ... not_ready";
  `agy-provider.test.ts`: "with the consent: located -> floor -> provider-start smoke ...", both prefetch-loop tests, and
  "every mode" rows ok, waiting, denied, no_structured, exit3, exit3_auth, not_signed_in, garbage_lines, global_mcp_present.
  The runner-independent cross-check block of `agy.sandbox.test.ts` is GREEN for all these modes: the fake's bytes are correct and the
  W1-09 classifiers read them; only the runner's reading of them is wrong.
- **V2-W1-04** (`app/autoDialog.ts` still the W0 stub, `confirmWorkspaceTrust` throws NotImplemented):
  `agy-provider.test.ts` "global_checked: the dialog shows the one-line diff; allow => backup first ..." and "refused while an agy
  process runs ...".

## REQUESTS

1. **V2-W1-06 (`llm/cli/runner.ts`) - agy result envelope.** agy stream-json ends with `{"event":"result","result":{status, structured_output,
   denied_actions,...}}` (research 5.3; the fake emits exactly that). The runner only accepts an object with a TOP-LEVEL string `status`,
   so every agy run ends `network`/killed (+ a breaker strike). Fix: in `consume`, for agy `const r = agyEventResult(ev); if (r) st.result = r;`
   and in `classifyAgy` use `classifyAgyResult(st.result)` (both exported by antigravityCli.ts).
2. **V2-W1-06 (`runner.ts` + `proc/jobRunner.ts`) - AGY_ERROR / auth on STDERR.** `AGY_ERROR: {...}` (exit 3) and `authentication required`
   (exit 1) are printed on **stderr** (research 5.6: "Diagnostics - errors, authentication prompts ... go to stderr"; C2 9.2 error table);
   the runner looks for them in non-JSON STDOUT lines, so exit 3 quota becomes `network` instead of `usage_limit`, auth becomes
   `sandbox`. Fix: classify from `done.stderrMarkers` with `classifyAgyExit(done.exitCode, done.stderrMarkers)` BEFORE the no-init
   branch for agy, and add markers to `JOB_STDERR_MARKERS`: `['auth_required', /authentication required|UNAUTHENTICATED/i]`,
   `['malformed_input', /malformed input|unsupported stream message/i]`, `['http_429', /\b429\b/]` (names already used by
   `classifyAgyExit`; `authentication_failed`, `quota`, `agy_error` are reused as they are).
3. **V2-W1-06 (`runner.ts`) - stdin rejection = not_ready (U-A6, brief).** agy exit 1/2 "malformed input" before any init must map to
   `not_ready` (never `sandbox`, never an argv fallback); `classifyAgyExit` returns that once the `malformed_input` marker exists.
4. **V2-W1-06 (`ipc/handlers/cli.ts`)** - `cli:allowWorkspace` shows the native dialog BEFORE `allow()` checks S-PROC; UX2 7.4 says
   "refused while agy runs: Close Antigravity first" - check `deps.agyRunning()` first (no dialog while agy runs). `allow()` still
   refuses either way (no write happens).
5. **V2-W1-04** - implement `AutoDialog.confirmWorkspaceTrust(win, diffLine)`: title "Change your Antigravity settings?", detail = the
   diff line verbatim, buttons ["Cancel" (default, cancelId 0), "Change one line"]; `true` iff response === 1; kind `agy_workspace`
   (the integration test answers `{response: 1}` from a mock `showMessageBox`).
6. **Orchestrator (contract C2 13 `AGY_ENV_KEYS`)** - consider adding `HOMEDRIVE` / `HOMEPATH` (values = the drive / path of
   `<userData>\agy-home`) so libuv cannot inject the real user's values into an agy job (decision 4). Until then M-AGY-1 must check
   that agy resolves its profile from USERPROFILE/HOME only.
7. **Orchestrator (contract C2 `PROVIDER_ERROR_CODES`)** - add a provider code (e.g. `unsafe_config`) mapped to `CLI_UNSAFE_CONFIG` by
   `providerErrorToErrorCode`, so the fallback-mode preflight refusal shows the right card (today it surfaces as `sandbox` =>
   `CLI_TOOLSET_MISMATCH`). Only relevant if M-AGY-1 flips `AGY_PROFILE_MODE` to `global_checked`.
8. **Orchestrator** - ratify `tests/fakes/fake-agy.world.ts` as W1-09-owned (decision "assumption" above).
9. **V2-W2-01 (compose)** - wire: factory `makeAgy = makeAgyFactory({locator, runner, userDataDir, onLocated: meta.cli_exe_paths_json,
   onSmoke: cliStatus.recordTest, onQuota})`; `agyWorkspace = createAgyWorkspace({home: S-HOME, proc: S-PROC, fs, mkdirSync,
   userDataDir, mode: AGY_PROFILE_MODE})`; `CliHandlerExtras.makeAgyForTest = (exe, v) => createAgyProvider({runner, locator, model:
   settings.llm.cli.agyModel, exePath: exe, userDataDir, observedVersion: v})`; harness `cli.agy` can follow `fake-agy.world.ts`.
10. **V2-W1-10 (`ipc/handlers/llm.ts`)** - `llm:listModels {provider:'antigravity_cli'}` = `listAgyModels(runner, {jobs, exePath:
    <located agy>, userDataDir, argsPrefix: <e2e seam prefix>})`; an empty list means "keep the current setting", never a fallback list.

## Dead ends

- Editing the runner to make the red tests pass: not my file (rule 8) - REQUESTS 1-3 instead; the cross-check block proves the fake.
- A literal U+FEFF in a regex (lint) and heredoc/Edit-tool backslash collapsing while patching tests - fixed by `charCodeAt` and by
  re-editing the affected lines.

## Fix round (2026-09-29) - audit finding A2 / #4

- `tests/integration/agy-provider.test.ts` workspace-trust fixture: `window: () => 'WIN'` replaced by a focused, live window double
  `{ isFocused: () => true, isDestroyed: () => false }`. W1-04's `createAutoDialog` correctly fails closed (Cancel, no
  `showMessageBox`) on a parent that is not a focused, non-destroyed window; the fixture had been written against the Wave-0 stub.
- Result: all 3 workspace-trust tests green ("isolated mode", "global_checked ... one-line diff", "refused while an agy process runs").
  eslint clean on the file; `tsc -p tsconfig.tests.json` reports nothing in the file.
- Still red in the same file (12 tests: opt-in smoke, 2 prefetch, 9 "every mode of T2 3.2") - all end `network`/`sandbox` from
  `src/main/llm/cli/runner.ts` / `proc/jobRunner.ts`, owned by V2-W1-06 (audit #1; REQUESTS 1-3 above). Not touched, not weakened.
