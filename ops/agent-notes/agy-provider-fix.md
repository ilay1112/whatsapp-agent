# agy-provider-fix - Antigravity (agy 1.2.16) provider fix

Agent label: `agy-provider-fix` (subagent of the orchestrator, 2026-10-05). No agy.exe / claude.exe / app run; fakes only. No git commit.

## Why

The orchestrator captured the real agy 1.2.16 behaviour on the user's PC (synthetic prompts only):

- `init.tools` ALWAYS lists all 60 available tools (Google's docs define it as "names of all available tools"), even though the agent file
  says `tools: []`. The old rule "init.tools must be empty" could never pass: every run ended as CLI_TOOLSET_MISMATCH (extra_tool).
- The agent file's `tools: []` IS enforced at call time (8 runs, incl. runs told to call run_command / read_url_content / view_file): no
  real tool ever ran. Invented names ended in state ERROR. The only tool that succeeded is agy's own `manage_task {"Action":"list"}`,
  which agy calls by itself even in a plain run.
- Tool activity arrives as `{"event":"step_update","step_update":{...,"state":"ACTIVE|DONE|ERROR","step_type":"tool"|"agent_response",
  "tool_name":...,"tool_info":{"name","parameters","output"}}}`.
- Success = `{"event":"result","result":{conversation_id,status:"SUCCESS",response:"<JSON as a STRING>",duration_seconds,num_turns,
  json_schema,usage}}` - NO `structured_output`, even with `--json-schema`.
- agy has a permissions policy in the profile settings.json (`deny > ask > allow`); whether `deny` is honoured headless is undocumented.
- Runs that try tools tend to hit `[agy] print timeout after ... returning partial output` (stderr).

## What changed and why each control exists (I11 stays fail-closed; the provider stays cli_unproven, never automatic, pictures local)

### A. Deny-all permissions policy, re-read before every spawn
- `src/main/llm/cli/claudeCli.env.ts`: `AGY_DENY_ALL` (frozen: read_file(*), write_file(*), read_url(*), execute_url(*), command(*),
  unsandboxed(*), mcp(*)), `agySettingsPath()`, `checkAgyPolicy(text) -> 'deny_all' | 'missing' | 'altered'` (exactly allow [], ask [],
  deny = the 7 wildcards in any order without duplicates, no other key in `permissions`). `planAgyHome()` now writes
  `{trustedWorkspaces:[ws], permissions:{allow:[],ask:[],deny:[...7]}}`. Re-exported from antigravityCli.ts.
- `src/main/llm/cli/runner.ts` (agy branch of `prepare`): after writing the isolated settings.json it RE-READS it (new optional
  `CliRunFs.readFileSync`, default node:fs utf8) and throws `AgyPolicyRefusal` unless the verdict is `deny_all`. `runOnce` turns that into
  `refusal('sandbox')` (CLI_TOOLSET_MISMATCH, never retried), audits `toolset_mismatch {reason:'policy_missing'|'policy_altered'}`, and
  NOTHING is spawned (the stdin line with the message text never leaves the app). A CliRunFs seam without `readFileSync` cannot verify ->
  every agy job refused (Claude unaffected).
- Why: defence in depth. If agy honours `deny` headless, no tool can run even if the agent-file restriction regressed in a later agy. If
  it does not, the runtime watch (C) still kills the run. The re-read catches a lost/tampered write (AV, concurrent process, broken seam).

### B. checkAgyInit
- `src/main/llm/cli/antigravityCli.ts`: keeps `agent === wca-<stage>`, `permission_mode === 'request-review'`, no MCP servers, the init
  envelope; `tools` must now only be an ARRAY (missing / non-array -> still `extra_tool`, fail closed). `toolsCount` = its length,
  information only.
- The runner stamps every passing agy proof with `policy:'deny_all', runtimeWatch:true` (it verified A before the spawn and watches every
  step after it). `CliSandboxProof` (src/shared/types.ts) gains these two OPTIONAL keys; `cleanSandboxProof` (src/main/db/repos/rows.ts)
  keeps them only with their closed values (anything else refuses the proof), so `runs.sandbox_json` says what the proof rests on. The
  `cli_run` audit row of agy runs carries `policy` ('deny_all' | 'missing' | 'altered' | 'not_checked') and `runtimeWatch:true`.
  Claude proofs / audit rows are byte-identical to before.

### C. Runtime tool watch (runner agy branch of `consume`)
- `agyStepVerdict(ev)` (antigravityCli.ts, pure): non-step events and `agent_response` / `user_input` steps without tool fields -> none;
  `manage_task` with `tool_info.parameters` EXACTLY `{"Action":"list"}` (tool_info.name absent or equal) -> allowed, in ANY state;
  everything else that is a step_update -> blocked: any other tool, manage_task with any other parameters, a tool step without a name, an
  agent_response step that carries tool fields, an UNKNOWN step_type, a malformed step payload. Each step (incl. DONE / ERROR) is judged on
  its own, so a missed ACTIVE step changes nothing.
- On blocked: `tool_blocked {nameSha8, nameLen, verdict:'blocked_unknown_tool', runId}` (B26: hash only), `run_aborted`, `job.kill()`
  at once, stop reading. `classify` then returns error `sandbox`, stopReason `killed`, `structured/text = null`, the proof marked failed
  (`initOk:false, mismatch:'extra_tool'`, so `runs.sandbox_ok = 0`) and a breaker strike (3 in the window -> CLI_UNSTABLE). A forbidden
  step after the result line still fails the run.

### D. Result parsing
- `classifyAgyResult`: SUCCESS + empty/absent denied_actions + no non-empty `error` -> `structured_output` if present (a later version may
  add it), else `parseAgyResponse(result.response)`: string only, trim, strip exactly ONE whole-text code fence, `JSON.parse`; prose,
  truncated JSON, JSON `null`, two fences, non-string -> bad_output. The caller still zod-validates (unchanged).
- Print timeout: new JobRunner stderr marker `print_timeout` (`/\bprint timeout\b/i`, src/main/proc/jobRunner.ts). `classifyAgy`: the
  marker -> `network` + breaker strike, the (partial) answer never used even if it parses.

### E. Fake (tests/fakes/fake-agy.mjs, fake-agy.types.ts, fake-agy.world.ts)
- Default success stream = the 1.2.16 capture: init without top-level conversation_id, `{model,cwd,agent,tools[60],permission_mode,
  json_schema}`; `manage_task {"Action":"list"}` ACTIVE then DONE (output "No background tasks are currently running."); agent_response
  ACTIVE/DONE; nested result with `response` string and NO structured_output. Only 7 tool names were captured; the other 53 are
  `assumed_tool_NN` filler (the app records only the count).
- `extra_tools` now lists 61 tools (adds an MCP-looking name) and is no longer an init failure.
- New modes: `forbidden_tool_step` (run_command ACTIVE, 3 s pause, DONE), `forbidden_tool_done_only` (only the DONE step),
  `manage_task_other_action` (`{"Action":"create",...}`), `policy_missing` / `policy_altered` (the WORLD's CliRunFs seam strips the
  permissions block / drops `command(*)` from the settings.json write -> the runner must refuse before spawn), `print_timeout_partial`
  (stderr line + a truncated response).
- Journal additions: `policyDenyAll`, `toolStepEmitted`, `toolStepCompleted` (false = killed before getting past the forbidden step).
  Every run now checks the isolated settings.json carries the deny-all policy (violation `policy_not_deny_all`).

### F. Tests (written first; red run recorded before the implementation)
- Unit: antigravityCli.test.ts (planAgyHome text, checkAgyPolicy table, checkAgyInit with 60 tools, agyStepVerdict table,
  classifyAgyResult 1.2.16 + parseAgyResponse), runner.test.ts (policy refusal x4 + no-readFileSync seam, watch x5 + after-result +
  breaker + tolerated manage_task, nested result, print timeout; the antigravityCli mock now passes the real checkAgyPolicy /
  agyStepVerdict and the real settings text), repos.v2.test.ts (sandbox_json keeps policy/runtimeWatch, refuses other values).
- Integration: tests/integration/agy-provider.test.ts - mode table (all 23 modes), 1.2.16 end to end (smoke + S1 + proof + audit), S3
  prefetch draft with a forbidden step -> `sandbox`, scripted answer never surfaces.
- Security: tests/security/agy.sandbox.test.ts - forbidden step x3 kills the run (tree kill, toolStepCompleted false, hashed audit only,
  failed proof), breaker after 3, smoke with a forbidden step never ready; policy_missing / policy_altered -> no spawn, no journal, audited;
  a tampered file is rewritten + re-verified next job; print timeout; fake stream shape pinned to the capture.
- Spec changes (by design B, not weakening): the old "extra_tools => init failure" expectations now expect a passing init (the watch +
  policy carry the proof); the isolated settings.json expectation includes the permissions block; agy proofs include policy/runtimeWatch.

## Results (see the final report in the orchestrator transcript; repeated here)
- Red first: before the implementation the new / changed tests in the 4 agy files failed (60+ failures: missing exports, old init
  rule, old stream shape).
- `npm run lint` 0. `npm run typecheck` 0.
- `npm run format:check`: my files are clean. It reports 2 files that are NOT mine: `src/main/diagnostics.ts` and
  `src/main/diagnostics.test.ts` (untracked, from the PROGRESS 74 privacy fix). I left them alone.
- `npx vitest run` (all projects), full run 1: 7922 passed, 1 failed. The failure was `locator.test.ts` expecting the old
  settings.json without the permissions block. That is a direct result of design A (the probes share the isolated profile), so I updated
  the expectation.
- Full run 2: 7922 passed, 1 expected fail, 1 skipped, 1 failed: `src/main/proc/reaper.real.test.ts` "a dead pid answers null". It
  touches the real process table and nothing I changed, and it passed in full run 1. Re-run alone 3 times: 4/4 passed each time. I take it
  to be a load-dependent flake and did not weaken it. The orchestrator's proof run should confirm.
- e2e (Playwright) was not run. The e2e helpers drive fake-agy through compose with node:fs and the real planAgyHome, so the policy is
  written and verified there as well.

## For the orchestrator's single real run (things only the real agy 1.2.16 can confirm)
1. A plain smoke + S1 run passes now: init accepted with 60 tools, only `manage_task {"Action":"list"}` steps seen, the answer parsed from
   `result.response`. If the real run is killed by the watch, the cause is one of: a `step_type` other than tool / agent_response /
   user_input (e.g. a planner or system step - the watch treats an UNKNOWN step kind as a tool, fail closed); manage_task steps whose
   ACTIVE event lacks `tool_info.parameters` or carries it in another shape; `tool_info.name` differing from `tool_name`. The audit row
   `tool_blocked` has only `nameSha8`/`nameLen`; compare with `sha256(name).slice(0,8)` of the candidate names.
2. The isolated settings.json now holds the `permissions` deny-all block: confirm agy 1.2.16 still starts and still accepts the sign-in /
   `agy models` / `--version` / `-p /usage` probes under it (they all share this profile), and that it does not rewrite or drop the block.
3. Whether `deny` is honoured headless stays undocumented; a run that asks for a tool should now end in ERROR / denied (and is killed by the
   watch anyway).
4. The `[agy] print timeout` line must reach the JobRunner's stderr marker view (`print_timeout`); if agy prints it on stdout instead, it is
   ignored and the truncated response is refused by the parser (bad_output) - still never used.
5. The result's `response` for the S1/S3/smoke schemas: plain JSON or one fenced block are accepted; anything else is LLM_BAD_OUTPUT.
