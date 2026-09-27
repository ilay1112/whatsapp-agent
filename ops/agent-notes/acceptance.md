# acceptance — working notes

Label: `acceptance`. Date: 2026-09-27. Phase 3, final acceptance against `ops/CONTEXT.md`.
Report: `docs/ACCEPTANCE.md` (mine). I edited no source file, no other agent's notes, and none of
PROGRESS / BOARD / DECISIONS.

## Verdict

**NOT ACCEPTED YET** — 2 of 7 gates red: `format:check` (exit 1) and `test:e2e` (exit 1). Everything else green.

| Gate | Exit |
|---|---|
| lint | 0 |
| typecheck | 0 |
| format:check | **1** |
| vitest | 0 (3828 passed, 1 skipped) |
| test:e2e | **1** (18/22) |
| test:smoke | 0 (all six checks + 4a) |
| audit:prod | 0 |

## What I actually did

Ran the seven gates in two background PowerShell batches, each command's exit code captured separately
(logs in the session scratchpad, `acc/*.log` + `acc/*.exit`). Then read the source for every requirement rather
than trusting the notes: Dashboard + dashboard store, window/tray, locales (key-parity computed, not eyeballed),
bridge launcher + invariants + the import-bridge pin, llm factory + local manifest/hardware, mcp host/read/write
clients, toolDefs, toolGate, the `action:approve` handler, prompt.ts, ingest/stage0 DM filtering.

I executed no binary from `resources/bridge`, `resources/llama` or `vendor/`, contacted no network service, and
never touched the reference bridge's `store`. `test:smoke` was read before running — it asserts its own no-GUI rule
and only hashes the bridge exe.

## Findings worth another agent's time

1. **`format:check` red on 2 files** — `src/main/bridge/bridgeDb.ts:146` and
   `src/main/llm/local/llamaServer.test.ts:523`. Pure line-wrap drift from the Sep-27 repair round; `prettier --write`
   on those two paths clears it. I did not fix it — the marker does not repair.

2. **Two e2e reds are a stale assertion, not a product bug.** `approval-first.spec.ts:173` and the same line pattern
   at `:213` poll for `llm.state === 'ready'` on a profile seeded `provider: 'local'`. `compose.ts:817-820` reports
   `'idle'` for the local provider on purpose (llama-server is lazy, ARCH A2); `'ready'` is cloud-only. The assertion
   is unsatisfiable there. The comment on line 173 blames `W2-01: the WCA_LLM seam never reaches
   createProviderFactory({ seamProvider })` — **that comment is out of date**: the seam is wired
   (`index.ts:44, 62, 206` -> `compose.ts:760, 781` -> `factory.ts:75`). Whoever fixes this should poll something that
   is actually true of a stub provider on a local profile, not relax the test.

3. **`onboarding.spec.ts:139` is an undiagnosed red.** `TypeError: fetch failed` / `read ECONNRESET`, reproducible on
   both attempts, ~3.1 s in, no source frame attributed — too early for any of its 20-30 s polls, so it is an immediate
   fetch rejection. Sibling test `:76` uses the same `localModelSeams()` helper and passes. I did not isolate it;
   traces are at `test-results/onboarding-accepting-the-d-06e14-*/trace.zip`. This is the only one of the four reds
   that might be a real defect.

4. **`tray-lifecycle.spec.ts:145` is a harness limitation.** The single-instance lock works; the second instance exits
   before Playwright can attach, so `electron.launch` throws instead of handing back a process whose `exitCode` the
   test polls. Needs a non-Playwright spawn for the second instance.

5. **VC++ CRT DLLs are not staged.** `vendor/llama/win-x64-vulkan/MANIFEST.txt` lists 24 files and none of them is
   `msvcp140.dll` / `vcruntime140.dll` / `vcruntime140_1.dll` — `VC_REDIST_CRT_DIR` was never supplied (U10). The
   `LLM_VCREDIST_MISSING` pre-flight exists and is tested, so this degrades cleanly, but on a clean machine Local will
   not start until the user installs the Microsoft redistributable.

6. **D-026 / U8 was never confirmed by the user.** `ops/DECISIONS.md:32` still reads "Orchestrator; confirm as U8".
   The whole of requirement 6 rests on it, and `list_events` was cut from the model's reach (A9 `[R2]`, U9). The
   orchestrator should put that one sentence to the user rather than let it ship as settled.

## Assumptions and limits of this pass

- "met" in my report means *met in code and in the automated suite*. I could not, and did not, verify anything against
  real WhatsApp, real Google, a real model, the real HF CDN, or a packaged GUI.
- I did not re-derive the 3828 vitest assertions; I relied on the suite being green plus my own reading of the
  safety-critical modules. The one skipped case is `tests/golden/golden.live.test.ts:71`, correctly gated behind
  `skipIf(!LIVE)`.
- Requirement 3 has a caveat no code can close: whether the tray icon lands in the Windows 11 **hidden-icons overflow**
  rather than the always-visible row is a per-user Windows setting. "Hides to tray" is proven; "hidden-icons flyout
  specifically" is not something an app may choose.
