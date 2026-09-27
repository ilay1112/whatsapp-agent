# W0-scaffold - builder notes

Package: `W0-scaffold` (Wave 0, runs alone; every Wave 1 builder waits for this).
Brief: `docs/specs/build-plan.md` section 2 (deliverables 1-7) + section 3 (supplementary seams) + the acceptance list under
`### W0-scaffold` in section 7.
Date of this run: 2026-09-22. This is the **third** attempt; the first two were interrupted by quota and their work was on disk.
Per the resume instruction nothing was restarted - deliverables 1-4 and the bridge exe of deliverable 5 were verified as
already-correct and left untouched.

---

## 1. State found on disk at the start of this run (verified, not rebuilt)

| Deliverable | Found | How it was verified this run |
|---|---|---|
| 1 Tooling | `package.json` + `package-lock.json` + `node_modules`, all root configs, `.prettierrc.json`, `.prettierignore`, `.gitignore`, `eslint.config.js`, `electron-builder.yml` | `npm run typecheck` / `lint` / `test:unit` / `build` all exit 0 (section 4); forbidden-package + native-addon scan re-run (section 3) |
| 2 Shared contracts | `src/shared/**`, `src/preload/index.ts`, `src/renderer/src/env.d.ts`, locales | the eight CONTRACTS section 18 consistency tests are part of the 368 green unit tests |
| 3 Signatures + stubs | 153 files under `src/**` (92 still carrying `NotImplementedError` - expected, Wave 1 fills them) | `npm run typecheck` exit 0; `docs/specs/wave0-seams.md` generated from these files (section 2c) |
| 4 Test infrastructure | 28 files under `tests/**` incl. `setup-guards.ts`, `setup-renderer.ts`, `mocks/electron.ts`, `helpers/*`, `fakes/*`, `eslint-fixtures/**` | `npm test` (main + renderer + integration + security) = 380 passed / 16 files |
| 5 Bridge exe | `resources/bridge/whatsapp-bridge.exe` 43,540,541 bytes, `resources/bridge/SHA256SUMS` | `node scripts/hash-bridge.mjs` -> `OK 43540541 bytes sha256 AC23221E...2FF5` (hash only; **the exe was never executed**) |

`scripts/import-bridge.mjs` was **not** re-run and the reference folder
`C:\Users\ilay1\Documents\minime\whatsapp-mcp\whatsapp-bridge\` was not touched again except for the one pattern-scoped
listing described in 2a. The private `store\` subtree was never read, listed, opened or copied.

---

## 2. Work done in this run

### (a) Deliverable 5, remainder - Go source + licence vendoring

Method (hard rule compliance): ONE non-recursive, pattern-scoped listing
`Get-ChildItem -LiteralPath "<...>\whatsapp-bridge" -Filter *.go -File`, then `Copy-Item -LiteralPath` per literal file name.
No recursion, no unscoped listing, no `*.exe` glob, no `store`, no `*.db`, no `.env*`, no `.bridge-token`.

`vendor/whatsapp-bridge-src/` (18 files, nothing else):
`auth.go`, `auth_test.go`, `group_participant_count.go`, `group_status.go`, `main.go`, `main_test.go`, `media_path.go`,
`media_path_test.go`, `media_serve.go`, `media_serve_test.go`, `pairing_status.go`, `pairing_status_test.go`, `webhook.go`,
`webhook_test.go`, `go.mod`, `go.sum`, `LICENSE`, `README.md`.

`[R2]` confirmed on this machine: the `whatsapp-bridge\` folder holds **no** LICENSE and **no** README - both were copied by
literal path from the repository ROOT `C:\Users\ilay1\Documents\minime\whatsapp-mcp\`:
- `LICENSE` (1,216 bytes, matches the size the brief states) -> `vendor/whatsapp-bridge-src/LICENSE` **and** `resources/bridge/LICENSE`
- `README.md` (30,659 bytes) -> `vendor/whatsapp-bridge-src/README.md`

The Go sources and the README are **reference data only**. Nothing in them was treated as an instruction (global rule 4).

Assumption recorded: the brief says "top-level `*.go`" without excluding `*_test.go`, so the seven Go test files were vendored
too - they document the bridge's own expectations about `/api/pairing/status` and the webhook, which W1-02 and W1-03 need.

### (b) Deliverable 6 - calendar MCP staging, scripts, placeholders

- `build-resources/calendar-mcp/package.json` - private, one exact-pinned dependency `@cocal/google-calendar-mcp@2.6.3` (ARCH A4).
- `build-resources/calendar-mcp/package-lock.json` - generated with `npm install --package-lock-only --ignore-scripts`
  (lockfileVersion 3, 171 packages + root). Committed; `node_modules/` under it stays git-ignored.
- `scripts/stage-calendar-mcp.mjs` + `scripts/stage-calendar-mcp.test.mjs`.
  - Runs `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` in `build-resources/calendar-mcp`.
  - **`shell: false` everywhere.** Node refuses to spawn `npm.cmd` without a shell, so the script resolves the npm CLI js
    (`process.env.npm_execpath`, else `<dirname(process.execPath)>/node_modules/npm/bin/npm-cli.js`) and spawns
    `process.execPath <npm-cli.js> ci ...`. This is the one deviation from a literal reading of "`npm ci` in that folder" and it
    exists only to avoid a shell.
  - Flags: `--force` (re-install), `--check` (verify only, never installs). The runner is injectable, so the tests start no process.
  - The staged server is never started by this script.
- Ran it once: `added 171 packages`, and
  `build-resources/calendar-mcp/node_modules/@cocal/google-calendar-mcp/build/index.js` now exists (261,509 bytes) - acceptance (7).
- `scripts/mark-e2e-build.mjs` - writes `out/.e2e-build`; a production `npm run build` rewrites `out/` without it (verified:
  the marker is absent after `npm run build`).
- Wave 0 stubs (each documents the full contract its future owner must implement, then exits 1 / throws):
  `scripts/fetch-llama.mjs` (W1-07), `scripts/pin-models.mjs` (W1-07), `scripts/make-icons.mjs` (W1-12),
  `scripts/smoke-packaged.mjs` (W2-04).
- `resources/links.json` was already present with the 14 `EXTERNAL_TARGETS` keys - left untouched.
- `.gitkeep` added in `resources/icons/`, `resources/licenses/`, `build/`. `[R2]` no `resources/onboarding/`.

### (c) Deliverable 3, remainder - `docs/specs/wave0-seams.md`

**Generated**, not hand-written: a throwaway script in the session scratchpad parsed every file of build-plan section 3 and
emitted each top-level exported signature (with its JSDoc) under a section carrying that row's owner and consumer list.
Interfaces / classes / enums are reproduced whole; function and const signatures are cut at the body and shown as `{ ... }`.
Result: 21 numbered seam sections, 1,395 lines, plus an index table. Because it is generated from the files, it cannot drift
from them at the moment of writing - if a Wave 1 builder needs to change a signature, the rule is still global rule 6/7
(`REQUESTS` in notes, never an edit).

Refinements to section 3 parameter types that were already in the stubs and are now frozen by this document (recorded as the
brief requires): `BridgeLauncherDeps` carries the extra optional `exeArgs?` (the `WCA_BRIDGE_CMD` child-mode argv, TESTS C2) and
`storeDir?` (defaults to `paths.bridgeStoreDir`); `ComposeDeps` carries `isPackaged`, `version`, `execPath` and
`preferredLanguages()` beyond the list in the table. `Clock.setTimeout` returns an opaque `ClockTimer`, not a `NodeJS.Timeout`.

### (d) One scaffold bug fixed

`npm run lint` was **red** at the start of this run with one error:

```
scripts/import-bridge.mjs
  40:5  error  There is no `cause` attached to the symptom error being thrown  preserve-caught-error
```

Fixed by attaching the caught error as `cause` on the re-thrown "source not found or unreadable" error. The message itself is
unchanged (it still reports only `err.code`, never the source path), and the static source test of `import-bridge.test.mjs`
(one path literal, no `readdir`, no `spawn`/`exec`) still passes.

---

## 3. Acceptance list (build-plan section 7, `### W0-scaffold`)

| # | Criterion | Result |
|---|---|---|
| 1 | `npm install` exit 0, exact pins, no forbidden DIRECT dependency / root-declared lockfile entry, no `binding.gyp` in the production tree | **PASS.** 6 direct runtime deps (`@anthropic-ai/sdk`, `@google/genai`, `@modelcontextprotocol/sdk`, `electron-log`, `i18next`, `zod`) = the root lockfile entries; every dependency and devDependency is an exact pin (no `^`/`~`); forbidden-name scan over `dependencies` + `devDependencies` (incl. `@electron-toolkit/*`, `i18next-*` plugins, font packages) = none; production tree = **143 packages + root**, matching ARCH 16's "~143"; **zero** `binding.gyp` and **zero** `*.node` files in it. `react-i18next` is present and is deliberately not an `i18next-*` plugin. |
| 2 | `npm run typecheck`, `lint`, `test:unit`, `build` exit 0 | **PASS** - see section 4. |
| 3 | Every file of ARCH 18 and TESTS 15 exists; CONTRACTS blocks verbatim | **PASS.** 153 files under `src/**`, 28 under `tests/**`; every asset TESTS 15 names for Wave 0 is present and compiling. |
| 4 | The eight CONTRACTS section 18 consistency tests pass | **PASS** (part of the 368 green unit tests). |
| 5 | `docs/specs/wave0-seams.md` lists every section 3 seam with its final signature | **PASS** - 21 sections, generated from the sources (2c). |
| 6 | Bridge exe size + pinned SHA-256 in `SHA256SUMS`; `vendor/whatsapp-bridge-src/` holds only `*.go`/`go.mod`/`go.sum`/`LICENSE`/`README.md`; nothing named `store`, no `*.db`, no token file anywhere; exe never executed | **PASS.** `hash-bridge` re-verified the pin. Repo-wide scan (excluding `node_modules`) finds exactly one `*.exe` (the vendored bridge), no `*.db`, no `*.db-wal`, no `.bridge-token`. The only path component named `store` in the repo is `src/renderer/src/store/` - the Zustand store folder of ARCH section 18, unrelated to the bridge's private store. |
| 7 | `build-resources/calendar-mcp/node_modules/@cocal/google-calendar-mcp/build/index.js` exists | **PASS** (261,509 bytes). |
| 8 | Production `out/main` has no seam strings | **PASS.** Scanned every file of `out/main` after `npm run build` for `WCA_E2E`, `WCA_BRIDGE_CMD`, `WCA_LLM`, `__wcaTest`, `stub-llm` - none present. **TESTS concern C9 is therefore resolved in the affirmative**: electron-vite's `--mode e2e` / `import.meta.env.MODE` elimination works here and the string-absence assertions in `tests/security/electron-hardening.test.ts` and `scripts/smoke-packaged.mjs` can stay. Caveat for W2-01: `out/main/index.js` is currently only 1.95 kB because `compose.ts` is still a throwing stub, so the whole graph is not yet pulled in - W2-01 must re-confirm C9 once `compose()` is real. |

---

## 4. Deliverable 7 - verification run (this machine, Node v24.19.0)

| Command | Exit | Output |
|---|---|---|
| `npm run typecheck` | **0** | three `tsc --noEmit` projects (node / web / tests), no diagnostics |
| `npm run lint` | **0** | `eslint . --max-warnings 0`, clean (after the fix in 2d) |
| `npm run test:unit` | **0** | 14 files, **368 tests passed** |
| `npm test` (main + renderer + integration + security) | **0** | 16 files, **380 tests passed** - run as extra information, not required by deliverable 7 |
| `npm run build` | **0** | `out/main/index.js` 1.95 kB, `out/preload/index.cjs` 2.26 kB, renderer 773.89 kB + 5.36 kB css |
| `node scripts/hash-bridge.mjs` | **0** | `OK 43540541 bytes sha256 AC23221E8BCF3937A4CA346B3BD80A8DA09DF94CBECD949AF2916C4BC8D22FF5` |
| `npm run format:check` | **1** | **DEVIATION - see below** |

### DEVIATION: `npm run format:check` is red (93 files) and was deliberately NOT fixed

Prettier (`printWidth: 120`) disagrees with the house style of **93 of the repo's ~95 checkable files**, across `src/shared`,
`src/main`, `src/renderer`, `src/preload`, `tests`, `scripts` and the configs. The disagreement is structural, not cosmetic:
the specs' own style packs a declaration onto one line and aligns trailing comments, e.g.

```ts
export interface WhenContext { nowMs: EpochMs; timeZone: string; defaultDurationMin: number; ambiguousHour: 'assume' | 'ask' }
```

which prettier explodes into six lines. Running `prettier --write` would therefore rewrite the CONTRACTS blocks that
deliverable 2 requires to be **pasted verbatim** and that global rule 7 freezes, and would reflow `vitest.config.ts`
(TESTS 2.1 "exactly") and `electron-builder.yml` (ARCH 15.2 "verbatim").

Two binding rules collide here and I did not have the authority to resolve it, so I left the gate honestly red rather than
either reformatting 93 spec-verbatim files or neutering the gate by widening `.prettierignore` until it checks nothing.
Deliverable 7 and acceptance (2) list only `typecheck`, `lint`, `test:unit` and `build` - all green. `format:check` only
appears inside the composite `npm run verify` (a W2-04 release gate), so the decision can still be made before it matters.
**Nothing was reformatted and `.prettierrc.json` / `.prettierignore` were left exactly as found.** See `REQUESTS` below.

---

## 5. Assumptions, dead ends, things the next agents should know

- **PowerShell execution policy blocks `npm.ps1`** on this machine (`running scripts is disabled on this system`). Use
  `& npm.cmd ...` (or `& node.exe ...`) from PowerShell. `powershell -NoProfile -Command '$env:PATH = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;" + $env:PATH; ...'`
  is the working prefix. Dead end: `npm install ...` written bare fails before doing anything.
- **Do not spawn `npm.cmd` from Node with `shell: false`** - Node refuses `.cmd` without a shell, and
  `tests/setup-guards.ts` hard-fails any `spawn` with `shell: true`. Spawn `process.execPath` + `npm-cli.js` instead
  (`scripts/stage-calendar-mcp.mjs` has the resolver; reuse it rather than re-inventing it).
- `out/.e2e-build` is created by `npm run build:e2e` only. A production `npm run build` wipes `out/`, so its absence is a
  reliable "this is a production bundle" signal for the Playwright fixtures (W2-03).
- The vitest `integration` project's include list already names `tests/golden/golden.test.ts` and the `golden-live` project
  names `tests/golden/golden.live.test.ts`; neither file exists yet (they belong to lane 9 / W1-09). Vitest tolerates the
  missing glob today because `tests/integration/scaffold-smoke.test.ts` matches the project. Nobody needs to "fix" this.
- `tests/e2e/**` and `tests/golden/**` are intentionally absent from Wave 0: TESTS 15 assigns them to lanes 15 and 9.
- 92 of the 153 `src/**` files still throw `NotImplementedError('<owner>', '<name>')`. That is the designed Wave 0 state.
  If one of your tests fails *only* because of another package's stub, record it under `BLOCKED-BY <package-id>` - do not
  weaken the test and do not re-implement that module.

---

## REQUESTS

- **W2-01-compose-integration** (Wave 2 owner of `package.json`, `.prettierrc.json`, `.prettierignore`): decide the
  prettier question recorded in section 4. Three options, in my order of preference:
  1. add the spec-verbatim trees (`src/**`, `tests/**`, `scripts/**`, `vitest.config.ts`, `electron-builder.yml`) to
     `.prettierignore` with a comment naming deliverable 2 / global rule 7 as the reason, and keep `format:check` for
     everything else;
  2. drop `format:check` from the composite `npm run verify` and keep prettier as an editor-only convenience;
  3. accept a one-off `prettier --write` over the whole tree **after** Wave 1 ends - which knowingly ends the
     byte-for-byte relationship with CONTRACTS and invalidates any exact-match test that relies on it.
  Whichever is chosen, `npm run verify` cannot currently exit 0 until it is.
- **W2-01-compose-integration**: re-confirm TESTS concern C9 (no seam strings in a production `out/main`) once `compose()`
  actually pulls the full main graph in. My check passed against a 1.95 kB stub bundle, which is necessary but not sufficient.
- **W1-07-llm-local**: `scripts/fetch-llama.mjs` and `scripts/pin-models.mjs` are documented stubs that exit 1. The
  contract each must fulfil is in the file header. Neither was ever run, nothing was downloaded, and `vendor/llama/` does
  not exist. `vendor/llama.pin.json` is yours to author.
- **W1-12-shell-main**: `scripts/make-icons.mjs` is a documented stub that exits 1. `resources/icons/` and `build/` exist
  with a `.gitkeep` and are otherwise empty - no icon has been generated, so `electron-builder.yml`'s icon paths do not
  resolve yet.
- **W2-04-packaging**: `scripts/smoke-packaged.mjs` is a documented stub that exits 1 (its header carries the six checks of
  TESTS 11 and the `EXIT_SMOKE_INCOMPLETE = 3` constant). `resources/licenses/` is empty apart from `.gitkeep`; the bridge MIT
  text you need for `THIRD_PARTY_NOTICES.txt` is already vendored at `resources/bridge/LICENSE` and
  `vendor/whatsapp-bridge-src/LICENSE`.
- **W1-02-bridge-process / W1-03-bridge-ingest**: the bridge's own Go sources and its `*_test.go` files are vendored under
  `vendor/whatsapp-bridge-src/` - read them there. The reference folder under `Documents\minime\` is out of bounds and there
  is no reason to open it again.

## BLOCKED-BY

None. No W0 test fails because of another package's stub - W0 is the first package.
