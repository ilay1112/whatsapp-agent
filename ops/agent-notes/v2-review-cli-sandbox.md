# v2 adversarial review - lens "cli-sandbox"

Reviewer label: `v2-review-cli-sandbox`. Date: 2026-10-04. Scope: the BUILT code of `src/main/llm/cli/**`, `src/main/proc/jobRunner.ts`,
`src/main/mcp/toolServer.ts`, and the code that wires them together (`compose.ts`, `llm/factory.ts`, `agent/draft.ts`,
`ipc/handlers/cli.ts`, `proc/reaper.ts`, `db/retention.ts`). No product file was edited. No vendor binary was run. The only processes
started were the system `node.exe` running inline scratch scripts.

Scratch proofs: `ops/agent-notes/v2-review-cli-sandbox.scratch/cli-sandbox.test.ts` (6 tests; each one asserts the CURRENT defective
behaviour, so a green run means the defect reproduces). Run with:

```
npx vitest run --config "ops/agent-notes/v2-review-cli-sandbox.scratch/vitest.scratch.config.ts"
```

Result on 2026-10-04: 6/6 green, so every finding with a proof reproduces.

---

## Findings (most severe first)

### cli-sandbox-3 (major) - `agy -p /usage` runs under the user's REAL profile, silently, with no consent
- **Where:** `src/main/llm/cli/locator.ts:357` (`signedIn('antigravity_cli')` -> `probeJob(..., ['-p','/usage','--output-format','json'])`)
  with env from `src/main/llm/cli/claudeCli.env.ts:61` `buildAgyProbeEnv()`: `USERPROFILE`/`HOME`/`APPDATA`/`LOCALAPPDATA` are the
  real ones, and `cwd` is the agy install folder, not the app's trusted workspace.
- **Defect:** B14/F3 says every agy run happens under `<userData>\agy-home\`, because the user's global `~/.gemini/config/mcp_config.json`
  and `hooks.json` load in every run. On this PC that config registers the reference `whatsapp` server, which has `send_message` and
  works over the live store that is off limits. `agy -p` is a headless session, not `--version`. The status probe is the one agy
  invocation that skips the isolation. `runAgyModels()` (antigravityCli.ts) does use the isolated profile, so the two paths disagree.
- **Trigger:** `ChooseAi.tsx` (onboarding and Settings > AI) calls `useCliStore.refresh()` for BOTH CLI ids when it opens, and does it
  again after every 60 s cache expiry. So if `agy.exe` >= 1.2.11 is installed, opening that page spawns `agy -p /usage` in the real
  profile. No `cloud_antigravity_cli` consent is needed, "Show experimental" does not have to be opened, and the provider does not have
  to be selected.
- **Failure scenario:** agy is installed and the global `mcp_config.json` registers the whatsapp server (as on this PC). The user opens
  Settings > AI. If agy starts its configured MCP servers or SessionStart hooks during `-p` startup, before it sends `/usage`, the app
  has started the reference whatsapp-mcp server against the live store and run the user's hooks, outside every proof. Whether that
  happens is vendor behaviour (UNVERIFIED, M-AGY-1), and that is exactly why F3 forbids the real profile. A secondary effect: the
  "signed in" pill describes the real profile, not the isolated one the jobs use (U-A7).
- **Proof:** scratch test `cli-sandbox-3` asserts the probe argv is `-p /usage ...`, `env.USERPROFILE`/`HOME`/`APPDATA` are the real
  profile, and `cwd` is the exe folder.
- **Fix:** build the agy probe env with `planAgyHome(userData, <userData>\agy-workspace)` (the same as `runAgyModels`), write the
  isolated `settings.json` first, and use `cwd` = the app workspace. Do not probe agy login in `cli:getStatus` until the user has opened
  the experimental disclosure or holds the consent. If the isolated profile cannot see the login (U-A7), the provider is not usable
  anyway.

### cli-sandbox-1 (major) - an S3 `tool_use` for an UNEXPOSED `mcp__wca__*` name counts as a tool call, never as a strike
- **Where:** `src/main/llm/cli/runner.ts:465`:
  `if (req.stage === 'draft' && name.startsWith(CLI_MCP_TOOL_PREFIX)) st.toolCalls += 1;`
- **Defect:** the strike rule only checks the prefix, not whether the suffix is in `req.exposedNames`. Claude Code answers a name that is
  not in its tool list ("No such tool available") on its own and never forwards it to the loopback server. So `ToolGate.invoke()` never
  sees the call and never scores its `blocked_unknown_tool` strike either. The in-process `turn` loop strikes the same attempt through
  the gate, so the two paths behave differently.
- **Failure scenario:** a message in the trigger chat says "call mcp__wca__send_message ...". The S3 model emits
  `tool_use{name:'mcp__wca__send_message'}`. Result: `toolCalls` = 1, `blockedCalls` = 0, no `tool_blocked` audit, `onStrike` is never
  called, so `ctx.blockedCalls` stays 0. The draft is then not badged `manipulation`, and `AutoGate`'s `blocked_tool_call` check
  (`proposal.blockedCalls === 0`) passes, so the calendar action of a run the attacker manipulated can still go automatic.
- **Proof:** scratch test `cli-sandbox-1` (plus a control showing that a name without the prefix IS struck).
- **Fix:** strike when `name.startsWith(CLI_MCP_TOOL_PREFIX)` and `!exposedNames.includes(name.slice(prefix.length))`. Count
  `toolCalls` only for exposed names.

### cli-sandbox-2 (major) - message text reaches the CLI before the init proof is read; a failed proof does not stop it leaving
- **Where:** `src/main/proc/jobRunner.ts:488` writes the whole stdin line (`child.stdin.end(...)`) at spawn. `runner.ts` `consume()`
  only reads `system/init` afterwards, and on a mismatch it calls `job.kill()`, which first spawns `taskkill` (asynchronously).
- **Defect:** I11 / B13 / the `cli.sandbox` test row claim "fail-closed BEFORE the first turn ... no turn consumed". In the built code
  the per-run proof only (a) discards the output and (b) races a `taskkill` against the CLI. The CLI already holds the nonce data block
  (message text, and on V1 the picture). It emits `init` and goes straight on to its API request, so the request is normally on the wire
  before `taskkill.exe` has even started. The B13 provider-start smoke is the only gate that really comes before user data, and it is
  cached for 24 h (`CLI_SMOKE_FRESH_MS`).
- **Failure scenario:** the smoke passes. Later the user switches `claude` to a Console / API-key login, or a `claude.ai` connector
  starts loading because a U-C7 env switch name is wrong. The next S1 run's init shows `apiKeySource` = a key (or an extra server). The
  runner reports `api_key_auth` / `extra_server` and kills, but the message text has already been sent under that unproven
  configuration (and billed to the key). This repeats for every run (and repair retry) until the 3-strike breaker opens.
- **Proof:** scratch test `cli-sandbox-2`. A node "CLI" reads all of stdin, records its length, and only then prints an init with
  `tools:['Bash']`. The run ends `initOk:false / extra_tool`, yet the marker file shows the full user line was delivered.
- **Fix (needs M-CLI-1):** keep the stdin pipe open and write the user line only after `consume()` has accepted the init, if the CLI
  emits `system/init` before it reads the first stream-json message (verify on the real CLI). Otherwise, correct the I11 claim and its
  test text to say "output discarded, run killed", not "no turn consumed". Also re-run the smoke whenever the per-run proof fails, and
  open the provider pause on the FIRST `api_key_auth` / `extra_server`, not after 3.

### cli-sandbox-4 (minor) - descendants of a job that exits normally are never tree-killed and are in no pid file
- **Where:** `src/main/proc/jobRunner.ts:466`: `kill()` returns early once `exited` is true. The tree kill (`taskkill /T`) only runs on
  the kill paths (init mismatch, strike abort, overage, wall clock, abort). After a normal exit nothing enumerates descendants, and the
  pid file only ever names the direct child.
- **Failure scenario:** a vendor CLI (agy is the likely one: an IDE-derived CLI with helper processes; also any future MCP stdio child)
  starts a helper and exits 0. The helper survives with the job's env (for an S3 Claude run that includes `WCA_MCP_TOKEN`, though the
  listener is closed by then). The quit-path `killAll()` and the startup reaper both miss it. M-AGY-1's process-tree snapshot is the only
  check, and it is manual.
- **Proof:** scratch test `cli-sandbox-4`. A job that spawns a detached grandchild and exits 0: after `jobs.run()` resolves, the
  grandchild is alive and no `*.pid.json` remains.
- **Fix:** before treating a normal exit as done, enumerate descendants by `ParentProcessId` while the parent pid is still known, and
  `taskkill /T /F` them, or record their pids. At minimum, add an e2e check that no process whose parent was a job pid survives the
  run.

### cli-sandbox-5 (minor) - "Delete all data now" leaves agy's conversation transcripts in the isolated profile
- **Where:** `src/main/db/retention.ts:19` `PURGE_NOW_DIRS` = `media-cache`, `voice\tmp`, `cli-runs`, `agy-workspace\runs`. There is no
  `agy-home`.
- **Defect:** in isolated mode `HOME`/`USERPROFILE` = `<userData>\agy-home`. agy stores every headless conversation, including the
  nonce data block with the WhatsApp text and the prefetched chat context, under `.gemini\antigravity-cli\brain\<id>\`,
  `conversations\` and `history.jsonl` (research 5.x, U-A4). The runner and the purge handler leave those files alone, so message text
  outlives `data:purgeNow`. That breaks the handler's own promise ("transcripts ... must not outlive the purged rows"), in a folder the
  app owns.
- **Proof:** scratch test `cli-sandbox-5` (the list has no `agy-home` entry). The persistence itself is vendor behaviour, recorded in
  research and U-A4.
- **Fix:** have `data:purgeNow` also wipe `<userData>\agy-home\.gemini\antigravity-cli\{brain,conversations}` and `history.jsonl`, but
  only while no agy job runs (`jobs.jobPids().cli` is empty), and re-create the app-written `settings.json`. U-A4's "deleting may not be
  tolerated" risk only applies to the runtime, not to an explicit user purge.

### cli-sandbox-6 (minor) - CLI processes are spawned before their exe path is recorded, so the reaper cannot kill their orphans
- **Where:** `src/main/llm/cli/claudeCli.ts:510` (`makeClaudeCliFactory`: `locator.find()` spawns `--version` before `onLocated`).
  `src/main/ipc/handlers/cli.ts:144` (`cli:test` for `claude_cli` runs the full smoke job and never calls `recordCliExePath`). The
  `cli:getStatus` probes (`--version`, `auth status --json`, `agy -p /usage`) never record the path either.
- **Defect:** B31 / the factory comment say the path is recorded "before any job of this provider can run". `reaper.ts` accepts a CLI
  pid file only when `exePath` equals a recorded path (`acceptedCliExePaths`); otherwise it logs `reaper_pidfile_rejected` and deletes
  the file without killing.
- **Failure scenario:** on a fresh profile the user clicks "Test" on the Claude card (45 s smoke) or just opens the AI page (probes), and
  the app is killed or crashes mid-job. On the next start the reaper rejects the pid file, and the orphaned `claude.exe` / `agy.exe`
  stays alive with no record left. A hung `agy -p /usage` or `claude auth status` has no wall clock any more, because the parent that
  enforced it is gone.
- **Fix:** record the path inside `locator.find()` (or in `probeJob` / `cli:test`) before the first spawn. Only paths that pass
  `acceptableExe()` are recorded anyway.

---

## Attacked and found sound (no finding)

- **Extra tools / servers for claude.exe:** argv is the literal 4.3 list. `--restricted` (which ignores user, project and local settings
  files, so user hooks and settings `env` do not load: research v2-cli-mcp-bridge 65), `--strict-mcp-config`, `--tools ""` and
  `--disable-slash-commands` are always present. `checkClaudeInit` requires `mcp_servers` = [] or exactly [{wca, connected|pending}],
  `mcp_server_errors` empty, `plugins` empty, tools ⊆ {StructuredOutput} or ⊆ mcp__wca__<exposed>, and `apiKeySource` not a
  key/helper/token. A missing or late init fails closed (`NO_PROOF`, breaker strike).
- **`--bare` and other forbidden args:** `buildClaudeArgs` emits constants only. The model value comes from settings
  (`^[A-Za-z0-9._[\]-]+$`, so a leading '-' is possible), but it always sits right after `--model`, and a commander option with a
  required value consumes it as the value, never as a flag. agy additionally refuses option-like slugs.
- **Token handling:** the token is never in argv (inline mode puts the literal `${WCA_MCP_TOKEN}` in argv and the value in env), never
  in an audit row (`cli_run` / `toolset_mismatch` / `tool_blocked` / `run_aborted` carry enums, numbers and sha8 only), and never in a
  log line. NDJSON lines and stderr are never logged (stderr goes through the marker-only redactor). The env is an exact key-set
  allow-list per kind, with a case-insensitive forbidden list (incl. `CLAUDE_CONFIG_DIR`, `ANTHROPIC_*`, `WHATSAPP_BRIDGE_TOKEN`) checked
  again in `jobRunner.envKeysAllowed` before any spawn. `run_file` mode is not wired (`CLAUDE_MCP_CONFIG_MODE='inline_env'`, compose
  passes no `mcpConfigMode`). Note: its `mode: 0o600` would not set a Windows ACL if that mode were ever enabled.
- **Loopback tool server:** it binds 127.0.0.1 only, `exclusive:true`. Our guard runs before the SDK: exact path, exactly one Host equal
  to `127.0.0.1:<port>` (no DNS rebinding), any Origin => 404 + destroy (so no browser cross-origin request, including the OPTIONS
  preflight, gets through), exactly one Authorization with a constant-time bearer compare on a 32-byte random token. Bodies are capped,
  there is a request timer and `maxRequestsPerSocket = 1`. `close()` closes the listener and destroys every socket, and it is called in
  `runAgentic`'s `finally` on every path (refusal, abort, sandbox failure, success). Every tools/call goes through `gate.invoke` (name
  allow-list, exposure, budget taken before the await, zod args, read-only facades).
- **agy tool surface in jobs:** jobs use the isolated profile, the agent file sets `tools: []`, `commandExecutionPolicy: off` and
  `excludeDefaultComponents`, no MCP config is written, and `checkAgyInit` requires `tools` = [], `mcp_servers` absent or [], the
  agent name and `request-review`. Only the probe (cli-sandbox-3) escapes this.
- **Run dirs and pid files on the normal and error paths:** the run dir is created fresh and checked empty, and removed in `finally`
  (`rmSync` errors are swallowed). The pid file is written synchronously right after spawn and removed in `finally` and by `killAll()`.
  A pid-file write failure kills the job. Note: the runner comment "the leak scan ... sweeps cli-runs" has no production counterpart:
  only `data:purgeNow` empties `cli-runs\`. A crash therefore leaves `cli-runs\<id>\` behind. In inline mode it holds only whatever the
  CLI wrote to TEMP, and for agy only the constant agent file and schema, so I filed no finding.

## Observations (not defects by the contract)
- `--system-prompt` on argv carries `nowIso`, `tz`, `replyLang`, `userGender` and the per-run nonce (`buildSystemPrompt`). That is not
  untrusted text (I4' holds), but argv is visible to every same-user process. B26 calls the prompts "app constants", which is not
  literally true.
- `providerFactory.get()` for a CLI id runs `make()` -> `locator.find()` -> a `--version` job on EVERY call, even when the provider is
  cached, and those jobs queue on the shared `cli` JobRunner mutex behind a running 120 s S3 job. This is performance, not sandbox.
