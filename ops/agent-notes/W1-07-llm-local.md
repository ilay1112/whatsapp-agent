# W1-07-llm-local - working notes

Owner of: `src/main/llm/local.ts`, `src/main/llm/local/**`, `tests/fakes/fake-llama-server.ts`,
`scripts/{fetch-llama,pin-models}.mjs`, `vendor/llama.pin.json` (+ colocated tests).

Read: ARCH 8, 9, 17, A2, A21; CONTRACTS 9; `docs/research/llama-runtime.md`;
TESTS 3.5, 4.2 (`WCA_LLAMA_CMD`, `WCA_MODEL_MANIFEST`, `WCA_HW`), 5.3 row `llm/local*`, 8.2 item 12b;
`docs/specs/wave0-seams.md` section 7; `ops/agent-notes/W0-scaffold.md`.

Status: **done**. No `NotImplementedError` left in any owned file; lint clean; typecheck clean in owned files;
all owned tests green; coverage above the `src/main/llm/**` threshold.

## What is implemented

| File | Contents |
|---|---|
| `src/main/llm/local.ts` | `createLocalProvider` over llama-server's OpenAI API. `structured()` uses the `[R2]` form `response_format.json_schema.{name,strict,schema}` (temperature 0.1, no `tools`); `chat()` uses `tools` + `tool_choice:'auto'` + `parallel_tool_calls:false` + Gemma sampling; both set `chat_template_kwargs.enable_thinking:false` and `cache_prompt:true`. Bearer key from the runtime, `redirect:'error'`, loopback only. Error bodies are read only to be discarded. |
| `local/llamaServer.ts` | `createLlamaRuntime`: VC++ CRT pre-flight -> spawn with the exact ARCH 9 flag array (conditional `--cache-ram 0`, `--device none`, `--device VulkanN`), key via `LLAMA_API_KEY` env only, minimal env block, below-normal priority, marker-only stdout/stderr, `/health` readiness poll, `childSpec()` for the Supervisor, `stop()` for the provider switch. |
| `local/hardware.ts` | `probeHardware`, `parseListDevices`, `isDedicatedGpuName`, `pickTier` (ARCH 17), `preferredDeviceArg`, and the `[R2]` `checkVcRuntime` / `isVcRuntimeExitCode` pre-flight. |
| `local/manifest.ts` | `MODEL_MANIFEST` byte-for-byte from ARCH 17 + `DOWNLOAD_HOST_ALLOWLIST` (suffix rule). |
| `local/download.ts` | `createModelManager`: plan/start/pause/resume/cancel/delete/onProgress/readyPath, one-hop `redirect:'manual'` with the suffix allow-list, `X-Linked-Size` / `X-Linked-Etag` early checks, Range resume into `.part` + sidecar, free-disk `size + 5 %`, GGUF magic, streamed sha256 vs pin, atomic rename, exactly one automatic re-download, 4 Hz progress. |
| `local/selfTest.ts` | `runSelfTest` (fixed prompt, CPU retry once) and the `[R2]` `runDualSelfTest` (two timed runs on machines with no dGPU, faster mode persisted in `forceCpu`, both numbers into `bench_json`, `suggestSmaller` only when the BETTER run is < 5 tok/s). |
| `tests/fakes/fake-llama-server.ts` | TESTS 3.5 double: in-process + child mode, flag/env contract checks, `StubRule` scripting, `garbage` / `exit_on_first_call` / `load_ms:` scenarios, `--list-devices` fixtures, and the fake GGUF model host with `drop_at:` / `expired_redirect_on_resume` / `foreign_redirect_host` / `corrupt_byte` / `wrong_size` / `no_range_support`. |
| `scripts/fetch-llama.mjs` | Pinned-zip staging with an injected `fetch`, explicit file allow-list, THIRD_PARTY_NOTICES, optional CRT staging from `$VC_REDIST_CRT_DIR`. |
| `scripts/pin-models.mjs` | Re-checks every GGUF pin against the Hugging Face tree API with an injected `fetch`. Never downloads. |
| `vendor/llama.pin.json` | llama.cpp `b10964` Vulkan zip pin + the explicit file allow-list + the three CRT file slots. |

Tests added this session: `src/main/llm/local.test.ts`, `local/llamaServer.test.ts`, `local/download.test.ts`,
`local/selfTest.test.ts`, `scripts/fetch-llama.test.mjs`, `scripts/pin-models.test.mjs`
(`local/hardware.test.ts` and `local/manifest.test.ts` already existed from the interrupted attempt).

## Assumptions and decisions

1. **The `.exe` is never run.** No test spawns a real process. `llamaServer.test.ts` injects a `SpawnFn` recorder that
   returns an in-process `EventEmitter` child double, and `/health` is answered by the loopback fake. `fetch-llama` and
   `pin-models` are exercised with an injected `fetch` and an in-memory filesystem, so no byte is downloaded either.
2. **`.part` bookkeeping needs a stalled transfer, not a dropped one.** `ModelManager.run()` retries a failed transfer
   once inside the same `start()`, so a `drop_at:` scenario resolves itself and never leaves a paused `.part` to inspect.
   The download tests therefore use a `stallingFetch()` wrapper (stream N bytes, then block until the abort signal
   fires) to observe pause/resume, and keep `drop_at:` for the "resume keeps the sha256 correct" case, where the single
   automatic retry is exactly the resume being asserted.
3. **`pause()` is never used as "await the download".** It aborts. The tests poll the model row until it reaches a
   terminal status instead (`settle()`), so no assertion depends on timing.
4. Arc detection: the ARCH pattern had to tolerate the `(TM)` / `(R)` marker between the two tokens
   (`Intel(R) Arc(TM) A770 Graphics`). Integrated Arc parts (`Arc(TM) 140V`) still do not match, which is the intent -
   only A/B-series discrete parts count as dedicated.
5. `hardware.ts` exposes `checkVcRuntime` / `isVcRuntimeExitCode` and `selfTest.ts` exposes `runDualSelfTest` as
   ADDITIVE exports next to the frozen seams of `wave0-seams.md` section 7; every frozen signature is unchanged and
   every new dependency on `LlamaRuntimeDeps` is optional, so a caller written against the frozen seam still compiles.
6. The error action for `LLM_VCREDIST_MISSING` is already `install_vcredist` -> `external:open {target:'vcredist_download'}`
   in the frozen `src/shared/errors.ts` + `resources/links.json`; `hardware.test.ts` asserts that mapping rather than
   duplicating it. The app never downloads or runs the redistributable itself.

## Fixes made to owned files during this session

- `local/hardware.ts`: the discrete-GPU regex now matches `Intel(R) Arc(TM) A770/B580` (two red tests from the earlier
  attempt). Also removed two always-overwritten initialisers flagged by `no-useless-assignment`.
- `local/llamaServer.ts`, `local/selfTest.ts`, `tests/fakes/fake-llama-server.ts`: same `no-useless-assignment`
  cleanups; dropped an `eslint-disable no-control-regex` directive the flat config reported as unused.
- `tests/fakes/fake-llama-server.ts`: the `drop_at:` scenario now destroys the socket in the `res.write` callback
  (plus a 10 ms unref'd timer) instead of immediately, so the partial body actually reaches the client. Before the fix
  the client received zero bytes and a Range resume could never be demonstrated.

## Verification

```
npx eslint src/main/llm/local.ts src/main/llm/local.test.ts src/main/llm/local \
  tests/fakes/fake-llama-server.ts scripts/{fetch-llama,fetch-llama.test,pin-models,pin-models.test}.mjs --max-warnings 0
  -> clean

npm run typecheck   -> no error in any W1-07 file (see UNRESOLVED for the other packages' errors)

npx vitest run --project main src/main/llm scripts/fetch-llama.test.mjs scripts/pin-models.test.mjs
  -> 12 files, 420 tests, all green (fix round: +18, see "Fix round" below)

coverage (src/main/llm/local.ts + local/**, threshold src/main/llm/** = 90 lines / 85 branches / 90 functions)
  local.ts        99.06 stmts / 90.90 branch / 93.75 funcs / 100 lines
  download.ts     95.55 / 90.78 / 100 / 96.65
  hardware.ts     96.29 / 93.10 / 94.11 / 98.33
  llamaServer.ts  98.89 / 91.56 / 100 / 100
  manifest.ts     100 / 100 / 100 / 100
  selfTest.ts     100 / 93.75 / 100 / 100
```

## Fix round (wave1-audit item: "vendor/llama.pin.json would ship UNPINNED binaries")

The audit asked me to "run `scripts/fetch-llama.mjs` once with `VC_REDIST_CRT_DIR` set and replace them". I did **not**
do that, for two reasons, and repaired the underlying hazard instead:

1. Running that script downloads the 31 MB llama.cpp release zip. Build-plan section 7 (`W1-07-llm-local`) is explicit:
   *"You never run llama-server.exe, never download a model and never run the two scripts against the network."* That
   rule is binding and outranks the audit line.
2. Half the request rests on a false premise that came from my own earlier note: `llama.sha256`/`llama.size` were never
   placeholders (see REQUESTS). Only the CRT slots are unpinned, and their correct values are a property of the staging
   machine, not of this repo.

Changes, all inside owned paths:

| File | Change |
|---|---|
| `scripts/fetch-llama.mjs` | `stageCrt` refuses a `null`/malformed CRT pin (was: warn + stage anyway); `fetchVerified` refuses a non-64-hex `llama.sha256` before any network call; new `crtDigests`, `applyCrtPins`, `pinCrt` + the `--pin-crt` CLI path. |
| `scripts/fetch-llama.test.mjs` | The old *"warns loudly for every UNPINNED file it stages"* test asserted the hazard, so it was replaced by *"REFUSES to stage an UNPINNED file"* (+ malformed-pin, matching-pin, `--pin-crt` round-trip, idempotence, formatting-preservation, "never touches the network when unpinned", and a pin-vs-ARCH-section-9 drift test). Net +18 tests, none weakened or deleted. |
| `vendor/llama.pin.json` | `_comment` on `llama` records that the hashes are the ARCH 9 pin of record (so nobody calls them placeholders again); `_comment` on `vcRedistCrt` documents the fail-closed contract and the `--pin-crt` procedure. The three `null`s are unchanged - honestly unpinned, and now unshippable. |

Verified end to end against the real pin file: `stageCrt` with the shipped `vendor/llama.pin.json` throws
*"msvcp140.dll is UNPINNED ... refusing to stage an unverified binary"* and writes nothing, while the `b10964` zip pin
passes the guard and proceeds to the (never-made) network call.

## BLOCKED-BY

None. No owned test depends on another package's Wave 0 stub: `download.ts` takes `Pick<Repos,'models'>` and the tests
supply an in-memory repo, and the provider takes a `LlamaRuntime` double.

## REQUESTS

- **W2-01-compose-integration** - wiring, for the record (W1-07 wires nothing itself):
  - `createLlamaRuntime` needs `freePort` (W1-01), `paths.llamaDir` / `paths.llamaServerExe` (W1-12), and
    `modelPath: () => modelManager.readyPath(tier) ?? ''` so a missing model surfaces as `MODEL_MISSING`.
  - `createModelManager` needs `repos.models` (W1-04), `paths.modelsDir`, and `freeDiskBytes` over the userData drive.
  - `createLocalProvider` must be built lazily by `llm/factory.ts` (W1-12) and disposed on every provider switch -
    `dispose()` is what stops `llama-server.exe`.
  - `allowHttpLoopback` must stay `false` in production; it is the `WCA_MODEL_MANIFEST` e2e seam only.
- **W2-04-packaging** - CRT pins. **Correction to an earlier version of this note** (which the wave-1 audit inherited):
  `llama.sha256` / `llama.size` are **NOT placeholders**. They are the real pin of record, byte-for-byte from
  ARCHITECTURE section 9 (`31,674,542` bytes, `1ee3ad95...c642`), and `fetch-llama.test.mjs` now asserts the pin file and
  ARCH section 9 agree, so either one drifting fails the build. Nothing needs replacing there.

  The three `vcRedistCrt.files` values **are** genuinely `null`, and they cannot be filled from this repo: they are the
  sha256 of the specific `Microsoft.VC143.CRT` folder the staging machine ships, which varies per redist version. There
  is no Visual Studio / redist folder on this machine (only OS-serviced copies in `System32`, different provenance), and
  obtaining the hashes any other way would mean fabricating a pin - exactly the failure mode the audit is trying to
  prevent. So instead of guessing, W1-07 made the hole **fail closed**:
  - `stageCrt` now **refuses** a `null` or malformed pin instead of warning and continuing, so an unverified DLL can no
    longer reach the installer. (`VC_REDIST_CRT_DIR` unset still only warns - nothing is staged at all, which is ARCH 9's
    documented behaviour.)
  - `fetchVerified` refuses **before the network call** if `llama.sha256` is ever nulled - "unpinned" can never degrade
    into "download and trust".
  - New `node scripts/fetch-llama.mjs --pin-crt`: with `VC_REDIST_CRT_DIR` set it hashes the three files **locally**
    (no download, no execution), writes the values into `vendor/llama.pin.json` in place (comments and formatting
    preserved - the diff is exactly three lines) and prints them for review.

  **W2-04 action:** on the staging machine, `--pin-crt` once, eyeball the three printed hashes, commit that three-line
  diff, then run the normal `fetch-llama` - which now verifies rather than warns. `resources/licenses/THIRD_PARTY_NOTICES.txt`
  is still written by that same normal run. W1-07 never runs either script against the network (build-plan section 7).
- **W2-02-security-gate** - `tests/security/gguf-download.test.ts` (gate item 12b) can reuse
  `tests/fakes/fake-llama-server.ts`'s model host and the exported `isAllowedDownloadUrl` /
  `DOWNLOAD_HOST_ALLOWLIST`; every 12b case already has a colocated unit test in `src/main/llm/local/download.test.ts`.

## UNRESOLVED (other packages - reported, not touched)

`npm run typecheck` is red in files W1-07 does not own. Listed here only so the orchestrator can route them:
`src/main/agent/draft.test.ts`, `src/renderer/src/components/ItemCard.test.tsx`,
`src/renderer/src/store/dashboard.test.ts`, `src/renderer/src/views/Onboarding/GoogleWizard.test.tsx`,
`src/renderer/src/views/Onboarding/LinkWhatsApp.test.tsx`, `src/shared/when.test.ts`.
