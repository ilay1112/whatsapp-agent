# repair-packaging-blocker - working notes

Phase 3 repair. Owned paths: `electron-builder.yml`, `build/installer.nsh`, `resources/licenses/**`,
`scripts/{smoke-packaged,stage-calendar-mcp,hash-bridge,import-bridge}.mjs` (+ `scripts/smoke-packaged.notices.mjs`,
`README.md`, inherited from `W2-04-packaging`). One file outside that set was edited on purpose - see section 3.

## Summary

| Task | Result |
|---|---|
| 1. packaged app contains no calendar server | **Already fixed in the repo by W2-04; re-proved empirically and hardened.** The verbatim ARCH 15.2 block ships 0 files of the server; the fix that works is a second `extraResources` matcher; the alternative the ticket suggested (an explicit `node_modules/**` include) does **not** work and I measured it. |
| 2. make that regression a hard smoke check | **Done** - new check **4a** with its own message + 11 unit cases. Red before / green after, proved with two full `--dir` packs. |
| 3. `fetch-llama.mjs` truncating my notices | **Done** - it now writes only `resources/licenses/llama.cpp-MIT.txt`; run order no longer matters. I edited that one script (and its test) - declared below. |
| 4. corrected YAML for the architecture doc | Below, under **ARCH 15.2 REPLACEMENT**. `docs/**` not touched. |

Nothing was executed from `resources\bridge`, `resources\llama` or `build-resources\calendar-mcp`; no GUI was started; no
NSIS installer was built (only `electron-builder --dir` via `npm run pack:dir`); no network call to WhatsApp, Google,
Anthropic or Google AI; no dependency added or changed; no commit.

---

## 1. The blocker: measured, not guessed

`app-builder-lib/out/util/filter.js` (electron-builder 26.15.3), inside `createFilter`, which `copyFiles` uses for
**every** matcher including `extraResources`:

```js
// filter the root node_modules, but not a subnode_modules (like /appDir/others/foo/node_modules/blah)
if (relative === "node_modules") {
  return false;
}
...
return minimatchAll(relative, patterns, stat) && ...
```

The rejection happens **before** `minimatchAll`, and it rejects the *directory* - so `copyDir` never descends into it
and no include pattern can bring the subtree back. Three forms packed with `electron-builder --win --x64 --dir`
against the same staging (`build-resources/calendar-mcp/node_modules`: 156 top-level packages, 6721 files):

| # | `extraResources` form | files under `<resources>\calendar-mcp\node_modules` |
|---|---|---|
| a | `- { from: build-resources/calendar-mcp, to: calendar-mcp }` (**ARCH 15.2 verbatim**) | **0** |
| b | `- { from: build-resources/calendar-mcp, to: calendar-mcp, filter: ['**/*', 'node_modules/**'] }` | **0** |
| c | form (a) **plus** `- { from: build-resources/calendar-mcp/node_modules, to: calendar-mcp/node_modules }` | **6721**, relative paths byte-identical to the staging (`diff` of both sorted `find` listings: empty) |

Form (b) is the one the ticket proposed as the likely fix - it does not work, for the reason above. Form (c) works
because with the matcher rooted **at** `node_modules`, its children are `@cocal`, `googleapis`, ... so `relative` is
never the literal string `node_modules`; the nested `foo/node_modules/bar` copies of the tree (8 of them: `body-parser`,
`googleapis-common`, `negotiator`, `string-width-cjs`, `strip-ansi-cjs`, `type-is`, `wrap-ansi-cjs`, `wsl-utils`) fall
under the "subnode_modules" branch and are copied too - which the 6721/6721 equality confirms.

**State of the repo when I arrived:** `electron-builder.yml` already carried form (c) (W2-04 found and fixed this in
wave 2; its notes say so). So the shipping blocker was not live in the tree - but it *is* live in `docs/ARCHITECTURE.md`
15.2, which still prints form (a) as the binding configuration, and nothing in the automated suite would have caught a
"tidy-up" that restored the doc's version. That is what check 4a now prevents. I re-created the blocker twice on purpose
to prove the check and the fix.

### Red -> green proof (`npm run pack:dir` + `node scripts/smoke-packaged.mjs dist/win-unpacked`, full production build each time)

```
RED   electron-builder.yml = ARCH 15.2 verbatim (second matcher deleted)
      smoke-packaged: FAIL - 2 problem(s):
        - check 4a - PACKAGING REGRESSION - the packaged app contains NO calendar server: <resources>\calendar-mcp\
          node_modules is empty although build-resources\calendar-mcp\node_modules holds 156 packages. ...
        - check 1 - skipped: the calendar MCP entry is missing from the package ... Check 4a above says why.
      exit 1

GREEN electron-builder.yml = form (c) (the file in the repo)
      [ok] check 4a - calendar server packaged: all 156 staged package folder(s),
           calendar-mcp\node_modules\@cocal\google-calendar-mcp\build\index.js and the ARCH 15.3
           package.json/package-lock.json are in <resources>\calendar-mcp
      [ok] check 1 ... [ok] check 2 ... [ok] check 3 ... [ok] check 4 ... [ok] check 5 ... [ok] check 6
      smoke-packaged: PASS - all six checks green.      exit 0
```

`<resources>\calendar-mcp\node_modules\@cocal\google-calendar-mcp\build\index.js` exists in the green pack (261 509
bytes) and check 1 reaches the **real** server through the packaged exe (`initialize OK (server google-calendar 2.6.3)`,
`tools/list` = the six ARCH 5.1 names).

---

## 2. Check 4a - the regression is now a hard check with its own message

`scripts/smoke-packaged.mjs`:

- new exported pure function **`calendarServerProblems({ stagedPackages, packagedPackages, entryExists,
  packageJsonExists, lockExists })`** - it compares the packaged tree against the staged one and returns one line per
  problem. Four distinct verdicts, so the reader is never sent to the wrong place:
  1. staged empty *and* packaged empty -> **"never STAGED ... run `npm run stage:mcp`"** (not a packaging fault);
  2. staged non-empty, packaged empty -> **"PACKAGING REGRESSION - the packaged app contains NO calendar server"**,
     naming the filter.js rule, the measured fact that a `node_modules/**` include does not help, and the exact YAML
     line to restore (`CALENDAR_NODE_MODULES_MATCHER`, exported so the test asserts the message carries the fix);
  3. packages present but `@cocal/google-calendar-mcp/build/index.js` missing -> incomplete/wrong staging;
  4. **partial copy** - any staged top-level package that did not reach the package (names the first six);
  plus the ARCH 15.3 layout requirement (`package.json` and `package-lock.json` beside `node_modules`).
- new fs-side `check4aCalendarServer(...)`, **run first** in `main()` - checks 1 and 2 both spawn that server, so a
  missing server used to read as "the MCP child exited", which is the same symptom as a flipped `runAsNode` fuse;
- check 1's early return now says *"skipped ... check 4a above says why"* instead of blaming `npm run stage:mcp`;
- the old one-line `need(MCP_REL_ENTRY, 'run `npm run stage:mcp`')` inside check 4 is **gone** - reporting a shipping
  blocker as one more missing file is exactly the "incidental" form the ticket asked me to remove. A unit test asserts
  the string is absent from the source and that `check4aCalendarServer` runs before `check1Mcp`.
- `scripts/smoke-packaged.test.mjs`: +11 cases (31 -> 42) over the new function and the wiring.

The six TESTS-11 checks are unchanged in number and meaning; 4a is an additional hard gate, named so it is obvious it
is part of check 4's remit but runs first.

---

## 3. Notices: `fetch-llama.mjs` no longer overwrites my file (edit outside my lane, declared)

`scripts/fetch-llama.mjs` (owner **W1-07-llm-local**) used to `writeFile` a two-section
`resources/licenses/THIRD_PARTY_NOTICES.txt`. That file is generated by `scripts/smoke-packaged.notices.mjs` from eight
sources (bridge, llama.cpp, LLVM OpenMP, VC++ CRT, calendar MCP, models, Electron, ~142 npm packages), so the release
artefact depended on which of the two scripts ran last, and README had to document an order.

**I edited `scripts/fetch-llama.mjs`** (the ticket permits this one script) so that it writes **only its own**
`resources/licenses/llama.cpp-MIT.txt`, verbatim, with no header:

- `export const NOTICES_PATH` -> `export const LLAMA_MIT_PATH = 'resources/licenses/llama.cpp-MIT.txt'`;
- the notices `writeFile` block -> `await fs.writeFile(llamaMitPath, `${license.trim()}\n`, 'utf8')`;
- header contract comment updated.

**I also edited `scripts/fetch-llama.test.mjs`** (same owner), because leaving it would have left a red test: the case
"writes the llama.cpp MIT text into THIRD_PARTY_NOTICES.txt" pinned the old contract. It is replaced by two cases -
"writes the verbatim llama.cpp MIT text into its OWN file" and "never touches THIRD_PARTY_NOTICES.txt". No case was
deleted without a replacement and nothing was weakened.

Consequences: `resources/licenses/THIRD_PARTY_NOTICES.txt` is authoritative and independent of run order; the VC++ CRT
paragraph that fetch-llama used to emit already exists as section 4 of the generated notices (and is *conditional* on
the CRT actually being staged, which the old two-section file was not). `README.md` section "One-time staging" now says
the order of the four commands does not matter, and `scripts/smoke-packaged.notices.mjs`'s header comment was updated.
Regenerating the notices is idempotent against the committed file (`diff` after a re-run: empty) and needs no network.

---

## ARCH 15.2 REPLACEMENT

For `docs/ARCHITECTURE.md` section 15.2 (orchestrator-owned). Only the `extraResources` block changes; every other line
of the printed YAML is as the architecture already has it. The repo's `electron-builder.yml` is the same configuration
in prettier's formatting (prettier owns that file's layout, `format:check` covers it) and additionally carries
`'!out/.e2e-build'` in `files`, which W2-04 added and I kept.

```yaml
appId: com.ilay.whatsapp-calendar-agent
productName: WhatsApp Calendar Agent
directories: { output: dist, buildResources: build }
files: [ "out/**", "package.json", "!**/*.map", "!out/.e2e-build" ]   # [W2-04] never ship the e2e marker of scripts/mark-e2e-build.mjs
asar: true
npmRebuild: false                      # no native modules anywhere; NO asarUnpack
electronLanguages: [en-US, he]
extraResources:
  - { from: resources/bridge,             to: bridge,       filter: ["whatsapp-bridge.exe", "LICENSE", "SHA256SUMS"] }
  - { from: vendor/llama/win-x64-vulkan,  to: llama,        filter: ["llama-server.exe", "llama-server-impl.dll", "llama-common.dll", "llama.dll", "mtmd.dll",
                                                                     "ggml.dll", "ggml-base.dll", "ggml-vulkan.dll", "ggml-cpu-*.dll", "libomp.dll",
                                                                     "msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll", "LICENSE-LLVM-OpenMP"] }   # [R2] explicit allow-list (fetch-llama.mjs already keeps only these)
  - { from: build-resources/calendar-mcp, to: calendar-mcp }
  # The entry above copies ONLY package.json + package-lock.json. electron-builder rejects a matcher's ROOT
  # node_modules in app-builder-lib/out/util/filter.js (`if (relative === "node_modules") return false`) BEFORE any
  # filter pattern is consulted, for extraResources too, so an explicit `filter: ["**/*", "node_modules/**"]`
  # copies 0 files as well (both measured with 26.15.3). The second matcher below is rooted AT that folder, so its
  # children (@cocal, googleapis, ...) are the relative paths and the rule never fires. Without it the installed app
  # has NO calendar server and every calendar feature is dead at run time; `npm run test:smoke` check 4a fails.
  - { from: build-resources/calendar-mcp/node_modules, to: calendar-mcp/node_modules }
  - { from: resources/icons,              to: icons }
  - { from: resources/links.json,         to: links.json }      # [R2] resources/onboarding/** removed: no raster onboarding assets in v1
  - { from: resources/licenses,           to: licenses }
electronFuses:
  runAsNode: true                      # REQUIRED by the MCP stdio child (A4) - do NOT "harden" this off; guarded by 15.4
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false # => Playwright runs against the UNPACKAGED build
  onlyLoadAppFromAsar: true
  enableEmbeddedAsarIntegrityValidation: false   # [LR] UNVERIFIED on Windows with 26.15.3
  enableCookieEncryption: true
  grantFileProtocolExtraPrivileges: false
win:  { target: [{ target: nsis, arch: [x64] }], icon: build/icon.ico, requestedExecutionLevel: asInvoker }
nsis: { oneClick: true, perMachine: false, createDesktopShortcut: true, createStartMenuShortcut: true,   # Start-menu shortcut REQUIRED for toasts
        shortcutName: WhatsApp Calendar Agent, runAfterFinish: true, deleteAppDataOnUninstall: false,
        artifactName: "WhatsAppCalendarAgent-Setup-${version}.${ext}" }
```

15.4 is also worth one sentence: the packaged smoke now has a seventh gate (4a) that compares
`<resources>\calendar-mcp\node_modules` against `build-resources\calendar-mcp\node_modules` and fails the build when the
staged server did not reach the package.

---

## Verification recorded (every command after `$env:PATH = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;" + $env:PATH`)

| Command | Result |
|---|---|
| `npx electron-builder --win --x64 --dir` x4 (forms a, b, c + reruns) | exit 0 each; file counts in the table above |
| `npm run pack:dir` (RED, ARCH 15.2 verbatim) + smoke | smoke **exit 1**, 2 problems, both the calendar server |
| `npm run pack:dir` (GREEN, repo config) + smoke | smoke **exit 0** - "PASS - all six checks green" |
| `npx vitest run --project main scripts/` | **0** - 8 files, **174** tests (was 163) |
| `npm test` | **0** - 162 files, **3678** tests |
| `npm run typecheck` | **0** |
| `npm run lint` | **0** |
| `npm run format:check` | **0** (repo-wide clean now; W2-04's note recorded it red for W1-07/W2-02 files - those are formatted in the tree I inherited) |
| `node scripts/smoke-packaged.notices.mjs` | exit 0, 12 977 bytes, byte-identical to the committed file |

Not run by me: `npm run test:e2e` (W2-03's lane), `npm run audit:prod` (no dependency change), the NSIS installer and
the packaged GUI (manual items M9/M13 - the smoke still structurally forbids a GUI start: one `spawn(` call site,
`ELECTRON_RUN_AS_NODE: '1'` hard-coded, asserted by the unit test against the file's own source).

## Observation for the orchestrator (NOT reproducible, reported because I saw it once)

The **first** RED pack of this session produced an `app.asar` whose header was internally consistent but whose data
region was 1 958 bytes longer than the sum of the recorded entry sizes, so every entry after `out/main/index.js` read
back shifted - `asar.extractFile(app.asar, 'package.json')` returned renderer JavaScript and check 5 failed with
"app.asar/package.json is not valid JSON". In that same tree `out/main/index.js` on disk was newer than `app.asar`
(08:21:07 vs 08:20:44), i.e. `out/` and the archive disagreed, although `pack:dir` runs the build before
electron-builder. A second identical RED pack and both GREEN packs were perfectly consistent
(`data region == sum of sizes`, package.json parses, main bundle byte-identical to `out/main/index.js`). I could not
reproduce it and I did not change anything to make it go away, so I am not claiming a cause - possibly an interaction
with my own earlier `npx electron-builder` runs in the same working tree. Two things are worth keeping:
check 5 **did** catch it, and it is one more reason not to pack while anything else writes `out/`.

## Files I changed

| File | Change |
|---|---|
| `electron-builder.yml` | comment only: recorded the three measured forms so nobody "simplifies" the second matcher into a filter. The configuration itself is unchanged (W2-04's form (c) was already correct). |
| `scripts/smoke-packaged.mjs` | check 4a: `calendarServerProblems()`, `check4aCalendarServer()`, run first; check 1's message; removed the incidental `need(MCP_REL_ENTRY, ...)`; header comment. |
| `scripts/smoke-packaged.test.mjs` | +11 cases (42 total). |
| `scripts/smoke-packaged.notices.mjs` | header comment - the run-order workaround it documented no longer exists. |
| `scripts/fetch-llama.mjs` | **not my file, edited with the ticket's permission**: writes only `llama.cpp-MIT.txt`. |
| `scripts/fetch-llama.test.mjs` | **not my file**: the one case that pinned the old contract replaced by two cases for the new one. |
| `README.md` | staging order note. |
| `ops/agent-notes/repair-packaging-blocker.md` | this file. |

`docs/**`, `ops/PROGRESS.md`, `ops/BOARD.md`, `ops/DECISIONS.md` and other agents' notes: untouched.
