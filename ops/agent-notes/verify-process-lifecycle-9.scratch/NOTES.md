# verify-process-lifecycle-9 — verdict: CONFIRMED (severity stays minor)

Tried to refute; could not. Everything below is from the real code, and `proof.test.ts`
(5/5 green, run with `vitest --config ops/agent-notes/verify-process-lifecycle-9.scratch/vitest.scratch.config.ts`)
exercises the real `createPaths`, `parsePidFile` and `reapOrphans`.

## Chain traced end to end

1. `src/main/paths.ts:48-49` — unpackaged: `resourcesDir = <appRoot>\resources`,
   `llamaDir = <appRoot>\vendor\llama\win-x64-vulkan` (`DEV_LLAMA_DIR`, line 39), so
   `llamaServerExe` is NOT under `resourcesDir`. `appRoot = app.getAppPath()` (`index.ts:125`).
2. `src/main/compose.ts:642` — `createLlamaRuntime({ exePath: llamaCmd?.command ?? paths.llamaServerExe })`.
3. `src/main/llm/local/llamaServer.ts:321` — the `llama` ChildSpec's `ChildHandle.exePath` is exactly `deps.exePath`.
4. `src/main/proc/supervisor.ts:249` — `writePidFile` persists `handle.exePath` verbatim into `<runDir>\llama.pid.json`.
5. `src/main/compose.ts:390-391` — `ownResourcesDir = paths.resourcesDir` (a single directory) is passed to `reapOrphans`.
6. `src/main/proc/supervisor.ts:104-109` — `parsePidFile` requires `isInsideDir(exePath, ownResourcesDir)`
   or `isSamePath(exePath, execPath)`. The dev llama path satisfies neither -> `null`.
7. `src/main/proc/reaper.ts:153-159` — `null` -> `stalePidFiles++`, `reaper_pidfile_rejected`, file deleted,
   `query.query()` never called, `query.kill()` never called. Proven: with a LIVE process whose
   `executablePath` and `creationDate` match perfectly, the dev layout yields `{killed: [], stalePidFiles: 1}`
   while the packaged layout yields `{killed: ['llama'], stalePidFiles: 0}`.

## Refutation attempts that failed

- No upstream guard: nothing rewrites `exePath` before the pid file is written.
- No test covers it: `reaper.test.ts` builds a synthetic `resourcesDir` and always puts `ownExe` inside it
  (`reaper.test.ts:69,80,99,...`), so the dev/packaged divergence is invisible to the suite.
- Not self-healing: `--sleep-idle-seconds 600` (`llamaServer.ts:111-112`) only frees VRAM; the process stays alive.
  `killAllSync()` runs on `process 'exit'`, which a hard kill skips, and the child is not in a job object.
- Bridge and MCP really are unaffected: `bridgeExe = <resourcesDir>\bridge\...` in both modes, and the MCP handle's
  `exePath` is `deps.execPath` (`mcp/host.ts:449`).

## Correction to the finding (does not change the verdict)

The proposed fix under-delivers for the e2e half of the scenario: `tests/e2e/helpers/fakes.ts:142` sets
`WCA_LLAMA_CMD.command = process.execPath` of the *Playwright runner* (node.exe), which is outside
`resourcesDir`, `llamaDir` AND `mcpRoot`, and is not the app's `execPath`. Adding the three roots fixes
`npm run dev` only; the e2e fake-llama pid file stays rejected (proof test case 4). If e2e orphan reaping
is wanted, the seam command has to be an accepted root too.

## Severity: minor (reviewer was right)

Unpackaged-only. The shipped/packaged build has `llamaDir = <resources>\llama`, inside `ownResourcesDir`,
so the reaper works for users. No data loss, no message/calendar write without approval, no crash, app usable.
Impact is a leaked `llama-server.exe` in a developer's session and a hole in the reaper's dev coverage.
