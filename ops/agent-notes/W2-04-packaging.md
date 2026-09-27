# W2-04-packaging - working notes

Wave 2, step 3 (last). Owned paths: `electron-builder.yml`, `build/installer.nsh`, `resources/licenses/**`,
`scripts/{import-bridge,hash-bridge,stage-calendar-mcp,smoke-packaged}.mjs`, `resources/bridge/**`,
`vendor/whatsapp-bridge-src/**`, `build-resources/calendar-mcp/**`, `vendor/llama/**`, `README.md`.

## Result

`npm run test:smoke` exits **0** - all six checks of TESTS section 11 green against a real
`electron-builder --dir` tree. `npm run audit:prod` reports **0 vulnerabilities**. No GUI was ever started; no
bundled binary was ever executed.

Files written or completed this wave:

| File | State |
|---|---|
| `scripts/smoke-packaged.mjs` | implemented (was a W0 stub) |
| `scripts/smoke-packaged.test.mjs` | new, 31 cases over the pure decision logic |
| `scripts/smoke-packaged.notices.mjs` | new helper (naming follows the section 6 disjointness rule) |
| `scripts/smoke-packaged.notices.test.mjs` | new, 12 cases |
| `build/installer.nsh` | new |
| `resources/licenses/THIRD_PARTY_NOTICES.txt` | generated, 13 KB, 8 sections |
| `resources/licenses/llama.cpp-MIT.txt` | new, committed so the notices regenerate without network |
| `electron-builder.yml` | two additions, both justified below |
| `README.md` | new, incl. M1-M16 |
| `vendor/llama/win-x64-vulkan/**` | 24 files staged by `fetch-llama.mjs` (D-017), never executed |
| `scripts/{hash-bridge,import-bridge,stage-calendar-mcp}.mjs` + tests | already implemented by W0; only reformatted (prettier), tests still green |

## D-017: `node scripts/fetch-llama.mjs` - ran once, succeeded

Not the SMOKE INCOMPLETE path. The pinned zip downloaded, the streamed sha256 matched
`1ee3ad95...c642`, and 24 allow-listed files were unpacked into `vendor/llama/win-x64-vulkan` with a `MANIFEST.txt`.
`VC_REDIST_CRT_DIR` was **not** set (I must not search the disk and must not ask on the user's behalf mid-run), so the
three MSVC CRT DLLs are **not** staged. This is the supported `U10` posture: the build warns, the app's pre-flight
raises `LLM_VCREDIST_MISSING` instead. `THIRD_PARTY_NOTICES.txt` says so explicitly, and manual item M13 checks it.
Nothing in `vendor/llama/` was executed - `llama-server.exe` is only ever checked for existence.

## Two defects found by the smoke, fixed inside `electron-builder.yml`

Both are deviations from "verbatim ARCH 15.2". I did not want either, but a verbatim file produces a broken package.

### 1. The calendar MCP server was missing from the package entirely (severity: feature-dead)

`- { from: build-resources/calendar-mcp, to: calendar-mcp }` copied **only** `package.json` and `package-lock.json`.
Root cause, in `node_modules/app-builder-lib/out/util/filter.js`:

```js
// filter the root node_modules, but not a subnode_modules (...)
if (relative === "node_modules") { return false; }
```

electron-builder drops a matcher's **root** `node_modules` unconditionally - this applies to `extraResources`, not just
to app files. So `<resources>\calendar-mcp\node_modules\` never existed, `mcp/host.ts` could never spawn the server,
and every calendar feature would have failed at run time on a packaged build. Nothing in the automated suite caught it
because every other test uses the dev path or the fake.

Fix: one extra matcher whose root **is** that folder, so its children (`@cocal`, ...) are the relative paths and the
rule never fires:

```yaml
  - { from: build-resources/calendar-mcp/node_modules, to: calendar-mcp/node_modules }
```

The resulting installed layout is byte-for-byte the one ARCH 15.3 specifies. Verified: check 1 now reaches the **real**
server through the packaged exe and gets the six ARCH 5.1 tool names back.

### 2. `out/.e2e-build` was being packaged into `app.asar` (severity: would ship a test marker)

Added `"!out/.e2e-build"` to `files`, for the same reason `"!**/*.map"` is already there: the packaging layer must never
ship test scaffolding. See the REQUEST below for the underlying build-script bug.

`electron-builder.yml` was also run through prettier (it is an owned file and `format:check` covers it). No setting
changed; `runAsNode` is still `true`. W2-02's `tests/security/electron-hardening.test.ts` - 53 cases, including the
fuse-wire and installer.nsh assertions - passes against the reformatted file.

## Decisions inside my own files

- **`build/installer.nsh`**: `customInit` only, one `taskkill /F /T /IM "WhatsApp Calendar Agent.exe"` plus a 1.5 s
  sleep for the file handles. I deliberately did **not** add a `customUnInit`: ARCH 15.2 names `customInit` and nothing
  else, and the smaller the file the smaller the chance someone later "improves" it into killing a foreign image. The
  file names no other process image, which is the invariant behind V10/M9 - the user runs an unrelated whatsapp-mcp
  bridge on this machine and `/IM whatsapp-bridge.exe` would kill it. `/T` reaches our children because they are ours.
- **TESTS 11 check 4 says "icons, onboarding, links.json, licenses"**. I do **not** require `resources\onboarding`:
  `[R2]` removed the raster onboarding assets from v1 (ARCH 15.2 comment, build-plan section 6 "no
  `resources/onboarding/**`"), so requiring it would fail a correct build. The stale word in TESTS 12/11 is noted in the
  REQUESTS below.
- **`ajv` in `app.asar`**: my first implementation failed the build on `node_modules/ajv` at the archive root. That was
  my bug, not the build's. npm hoists, so `@modelcontextprotocol/sdk`'s own `ajv` physically lands at the root even
  though nothing declares it, and ARCH 16 `[R2]` explicitly allows it as a transitive occurrence. The check now does
  what ARCH 16 actually says: a physical-presence scan with an `ajv` / `ajv-formats` exemption, **plus**
  `declaredDependencyProblems()` over the `package.json` that `app.asar` carries, where there is no exemption at all.
- **`--allow-missing-bridge` no longer downgrades a good run.** The flag is a permission to proceed, not a result: exit
  3 is now returned only when the zero-byte placeholder was actually used (`state.placeholderUsed`), not merely because
  the flag was passed. Passing the flag with a correctly pinned exe present gives a normal exit 0.
- **Check 2 needs a 9-line launcher.** `tests/fakes/fake-mcp-calendar.ts` self-starts only when `process.argv[1]` ends
  in `.ts` (`/fake-mcp-calendar\.ts$/`), but TESTS 11 requires the type-stripped copy to be `fake-mcp-calendar.mjs`,
  which therefore never starts. The smoke writes a small launcher beside it that calls the fake's **public** export
  `createFakeCalendar` - not a re-implementation. See the REQUEST to W1-05.
- **`scripts/smoke-packaged.notices.mjs` exists** because `fetch-llama.mjs` (W1-07) `writeFile`s
  `THIRD_PARTY_NOTICES.txt` with a two-section minimal version, overwriting the release notices. Running fetch-llama
  therefore truncates the file, and the README documents the required order. Regeneration needs no network because the
  llama.cpp MIT text is committed at `resources/licenses/llama.cpp-MIT.txt`.
- **Raw JSON-RPC rather than the MCP SDK client** in the smoke: the two failure modes of check 1 (fixture problem vs
  flipped fuse) can only be told apart with direct control over the 20 s budget, the child's exit code, its stderr and
  whether any JSON-RPC line ever appeared. An SDK client hides all four behind one thrown error.

## Verification recorded

| Command | Result |
|---|---|
| `npm run lint` | **0** (clean, whole repo) |
| `npm run typecheck` | **0** (clean, whole repo) |
| `npm test` (main + renderer + integration + security) | **0** - 162 files, 3660 tests passed |
| `npx vitest run --project main scripts/` | **0** - 8 files, 163 tests passed |
| `npm run test:smoke` | **0** - all six checks green |
| `npm run audit:prod` | **0** - 0 vulnerabilities |
| `npm run format:check` | **1** - see BLOCKED-BY; none of the offending files is mine any more |
| `npm run verify` | **not green as a whole**, and it aborts at step 2 (`format:check`) for reasons outside this package. Every other stage of it was run individually and is listed above. `test:e2e` is W2-03's lane and was not run by me. |

## Cross-package evidence worth keeping

`npm run build` does **not** delete `out/.e2e-build`, contradicting TESTS 14 and the comment inside
`scripts/mark-e2e-build.mjs` ("`npm run build` rewrites `out/` without the marker"). Measured directly:

```
npm run build:e2e  -> marker exists: YES
npm run build      -> marker exists: YES      <-- should be NO
```

electron-vite only empties `out/main`, `out/preload`, `out/renderer`, never the `out/` root. Consequences:

1. `tests/security/electron-hardening.test.ts` > "a PRODUCTION out/main contains none of the seam strings" goes **red**
   whenever a production build follows an e2e build, because it sees the marker and then asserts the bundle *does*
   carry seams. I reproduced this, removed the stale marker (a gitignored build artifact, not anyone's source), and the
   test went green again - 53/53. I did not touch the test or the build script.
2. In `npm run verify` the order is `test:coverage` -> `test:e2e` -> `test:smoke`, so the security test runs *before*
   the e2e build and is safe there; but `pack:dir` then runs with the marker present. My `"!out/.e2e-build"` entry
   keeps it out of `app.asar`, so `test:smoke` passes anyway - confirmed by running `test:smoke` with the marker
   deliberately in place (exit 0).

So nothing is blocked, but the underlying bug is real and `npm test` after `npm run test:e2e` still fails for anyone.

## REQUESTS

- **W2-01-compose-integration** (`package.json` owner): make `"build"` delete `out/.e2e-build`, per TESTS 14 - e.g.
  `"build": "npm run typecheck && electron-vite build && node -e \"require('node:fs').rmSync('out/.e2e-build',{force:true})\""`.
  Evidence above. My `electron-builder.yml` exclusion protects the *package*; it does not make `out/` honest, and
  `npm test` after `npm run test:e2e` is red until this is fixed.
- **W1-05-mcp-calendar**: please widen the child-mode guard in `tests/fakes/fake-mcp-calendar.ts` from
  `/fake-mcp-calendar\.ts$/` to `/fake-mcp-calendar\.(ts|mjs)$/`. TESTS 11 check 2 requires a **type-stripped `.mjs`
  copy** of your fake to run as a stdio server, and it currently cannot start itself. Until then the smoke writes a
  9-line launcher around your public `createFakeCalendar` export; that launcher can be deleted the moment the regex
  accepts `.mjs`.
- **W1-07-llm-local**: `scripts/fetch-llama.mjs` overwrites `resources/licenses/THIRD_PARTY_NOTICES.txt` (my file) with
  a two-section minimal version. It is not wrong, just destructive; the documented order in README section 4 works
  around it. If you would rather not depend on run order, write the llama block to
  `resources/licenses/llama.cpp-MIT.txt` (which I now commit) and leave `THIRD_PARTY_NOTICES.txt` alone.
- **W1-07-llm-local**: `scripts/pin-models.mjs` and `scripts/pin-models.test.mjs` fail `npm run format:check`
  (`prettier --write` fixes both; I did not touch files I do not own).
- **W2-02-security-gate**: 16 files under `tests/security/` plus `tests/setup-guards.ts` fail
  `npm run format:check`, which aborts `npm run verify` at step 2.
- **Orchestrator** (owns `docs/**`): two spec corrections are worth folding in, both proven by a real package -
  (a) ARCH 15.2's `extraResources` cannot carry `build-resources/calendar-mcp/node_modules` without the extra matcher
  described above, so the verbatim YAML in ARCH 15.2 ships a package with no calendar server;
  (b) TESTS section 11 check 4 still lists `onboarding` among the required resource folders although `[R2]` removed
  `resources/onboarding/**` from v1.

## BLOCKED-BY

None. No test of mine fails because of another package's stub. `npm run format:check` is red for files owned by
W1-07 and W2-02 (listed under REQUESTS); that is a repo-wide gate, not a blocked test of mine.

## Not done, by design

Building the NSIS installer and the first GUI start of the packaged app are **manual user steps** (M9). I built only
`--dir` (`pack:dir`), never the installer, and never started the app as a GUI - the smoke enforces that structurally:
there is exactly one `spawn(` call site in `scripts/smoke-packaged.mjs` and it hard-codes `ELECTRON_RUN_AS_NODE: '1'`,
which `scripts/smoke-packaged.test.mjs` asserts against the file's own source text.
