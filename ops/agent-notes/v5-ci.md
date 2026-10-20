# v5-ci (W1 of docs/specs/v5-updates-handover.md) - CI release workflow + release manifest

Owner files: `.github/workflows/release.yml` (new), `scripts/release-manifest.mjs` + `.test.mjs` (new),
`scripts/fetch-llama.mjs` (+ 3 tests in `fetch-llama.test.mjs`), `package.json` (`release:manifest` line),
`docs/ARCHITECTURE.md` 15.4 (one bullet). Nothing committed or pushed.

## What was built

- `scripts/release-manifest.mjs <zip> <version> <commit> [--notes "<text>"] --out release.json`
  - schema 1: `{ schema, version, commit, publishedAt, asset: { name, size, sha256 }, minVersion: "0.1.0", notes }`
    (key order exactly that).
  - size + sha256 by streaming (`createReadStream`), never a whole-file read.
  - refuses: version not `^0\.1\.\d+$`; commit not a full lower-case 40-hex sha; zip not named exactly
    `WhatsAppCalendarAgent-win-x64-<version>.zip`; missing / directory / empty / no `PK\3\4` header; an existing
    `--out` file that holds another version or is not a manifest (same version = re-run, overwritten). Atomic write
    (tmp + rename). Notes: control characters collapsed to spaces, trimmed, capped at 200 chars.
  - exit 0 + one summary line on stdout; exit 1 + `release-manifest: <reason>` on stderr.
- `scripts/fetch-llama.mjs`: new `isCi(env)` (`CI` non-empty and not `false`/`0`, or `GITHUB_ACTIONS=true`). On CI an
  unset `VC_REDIST_CRT_DIR` throws BEFORE any download. Locally the old warn-and-skip path is unchanged. Pin logic
  untouched (null CRT pins still REFUSED).
- `.github/workflows/release.yml`: see ARCHITECTURE 15.4 [v5] bullet for the step list.

## Decisions / deviations (for the orchestrator)

1. **The CRT glob lives in the workflow, not in fetch-llama.mjs.** `fetch-llama.test.mjs` has a deliberate static rule
   "never globs for DLLs and never lists a directory" (no `readdir`, no `glob` in the code). Putting a glob in the
   script would mean weakening that test. So: the workflow step "Locate the VC++ CRT" (pwsh) globs and exports
   `VC_REDIST_CRT_DIR` (fails the job when nothing matches); the script's "fallback" is fail-closed on CI / warn locally.
2. Glob widened from `Microsoft.VC143.CRT` to `Microsoft.VC14*.CRT` (a VS 2026 image may ship a VC145 folder; the DLL
   names are the same and the sha256 pins catch any change). Only numeric MSVC version folders (`v143` merge-module
   folder excluded), only folders holding all three DLLs, newest by `[version]` (numeric, so 14.44 beats 14.9).
3. **No `--project shared`**: `vitest.config.ts` has projects main / renderer / integration / security / golden-live;
   `src/shared/**` tests run in `main` (with `scripts/**/*.test.mjs`). The workflow runs
   `npx vitest run --project main --project renderer`.
4. **BLOCKER for the first release run - CRT pins are null.** `vendor/llama.pin.json` and `vendor/whisper.pin.json`
   have `vcRedistCrt.files = null`, and stageCrt REFUSES unpinned DLLs. So the first push fails at "Fetch pinned
   llama.cpp" with "UNPINNED". Bootstrap: after the workflow is on `main`, run it by hand (`gh workflow run release.yml
   -f pin_crt=true`); the `crt-pins` job only locates the CRT and prints `node scripts/fetch-llama.mjs --pin-crt` output
   + the pin-file diff (no build, no release). A human reviews, copies the three hashes into BOTH pin files, commits,
   pushes. When GitHub updates the runner's VS, the hashes drift and the release fails closed again - re-run the
   bootstrap. (Alternative the user may prefer: install a fixed VC++ redist version in CI instead of the image's VS copy.)
5. Added `node scripts/smoke-packaged.notices.mjs` after the fetches so the shipped THIRD_PARTY_NOTICES section 4 says
   the CRT IS shipped (the committed file says "NOT SHIPPED"). Only the CI workspace copy changes.
6. `--publish never` on electron-builder (it auto-publishes on CI when it sees a token otherwise; GH_TOKEN is only set
   on the publish step anyway). `gh release create ... --target <sha> --latest`.
7. Zip layout (for W2; built with ZipArchive, not Compress-Archive - see the zip dry run below): the CONTENTS of `win-unpacked` are at the zip root (`WhatsApp Calendar Agent.exe`,
   `resources/app.asar`, ...), not a `win-unpacked/` top folder. The zip step re-opens the zip and fails unless every
   file is present, all names use `/`, none is absolute or has `..`, and the exe + `resources/app.asar` are at the root.
8. `npx install-electron --no` (ARCH 15.4 mentions it for CI) is NOT in the workflow: no CI step needs the dev Electron
   binary (vitest mocks electron; electron-builder downloads its own; smoke runs the packaged exe). Note `install.js`
   reads no argv, so `--no` there is a no-op anyway.
9. Re-running a failed run with the same `run_number` after the release was created fails at `gh release create`
   (tag exists). Intentional; delete the release or push a new commit.
10. Commit subject reaches node/gh as a pwsh variable (`--notes "$subject"`), never via `${{ }}` interpolation into the
    script, so a subject with quotes/`$()` cannot inject commands.

## Exact local commands run (Git Bash, `export PATH="/c/Program Files/nodejs:/c/Program Files/Git/cmd:$PATH"`)

- `npx vitest run scripts/release-manifest.test.mjs` - red first (module missing), then 27/27 green.
- `npx vitest run scripts/fetch-llama.test.mjs` - red (3 new CI tests), then green; with fetch-whisper + manifest: 93-104 green.
- `CI=true GITHUB_ACTIONS=true VC_REDIST_CRT_DIR=<scratch>/no-crt npx vitest run --project main --project renderer`
  - 290/291 files, 6783 tests passed in ~50 s; the one failing file is W2's in-progress `src/main/update/zip.test.ts`
  (`./zip` module not written yet) - not mine.
- `npm run -s lint` - my files clean (`--max-warnings 0`); the remaining 2 errors are W2's in-progress
  `src/main/update/zip.test.ts` (no-console) and `src/shared/update.test.ts` (node:fs import in src/shared).
- `npx prettier --check` on all my files incl. the workflow - clean. `npx --yes yaml-lint .github/workflows/release.yml` - OK.
- CRT glob, Windows PowerShell 5.1, the workflow's exact pipeline:
  - this PC: no match -> local variant warns and exits 0 (CI variant: `Write-Error` + exit 1).
  - a fake tree in the scratchpad (`2022/Enterprise/.../MSVC/{14.44.35112,14.9.1,v143}/x64/Microsoft.VC143.CRT`):
    `v143` excluded, an incomplete folder excluded, `14.44.35112` chosen over `14.9.1` (numeric sort).
- `env -u VC_REDIST_CRT_DIR CI=true node scripts/fetch-llama.mjs` - exit 1 "VC_REDIST_CRT_DIR is not set on CI" before
  any network call; vendor/ untouched.
- Zip dry run on the existing `dist/win-unpacked` (720 MB, 6795 files), Windows PowerShell 5.1, output in the scratchpad:
  - `Compress-Archive -LiteralPath <sorted top-level items> -CompressionLevel Optimal` (Archive module 1.0.1.0): 75 s,
    227 MB, but entry names use BACKSLASHES (`locales\en-US.pak`) and 53 directory entries end in a backslash; the
    zip guard rejected it (6832 bad names). `[ZipFile]::CreateFromDirectory` (.NET Framework): also backslashes.
  - => the workflow does NOT use Compress-Archive (deviation from the handover): it adds every file explicitly with
    `ZipArchive` + `CreateEntryFromFile`, ordinal-sorted, `/` names, Optimal. The same step body run locally via a
    harness: 21 s, 6795 entries = 6795 files, 0 bad names, exe + `resources/app.asar` at the root, 226,973,371 B.
    Only .NET APIs, so it behaves the same in PS 5.1 and pwsh 7.
  - `node scripts/release-manifest.mjs <that zip> 0.1.999 <HEAD sha> --notes "<subject>" --out <scratch>/release.json`
    -> exit 0; its sha256 equals `sha256sum` of the zip. Same zip with version 0.1.998 -> exit 1 (name mismatch).
    `npm run -s release:manifest -- ...` same-version re-run -> exit 0 (overwrite allowed). Zip + fake trees deleted.
- `gh release create` NOT run. It would be:
  `gh release create v0.1.<N> WhatsAppCalendarAgent-win-x64-0.1.<N>.zip release.json --title "v0.1.<N>" --notes "<subject>\n\ncommit <sha>" --target <sha> --latest`

## Could not test locally

- The workflow itself (no `act`; runs only after the orchestrator pushes). Untested in practice: pwsh 7 on the runner
  (local only has Windows PowerShell 5.1), the runner's VS CRT folder name/version, `npm ci` + build + electron-builder
  on a clean runner, `smoke-packaged.mjs` on the runner, the 45-minute budget, `gh release create` permissions.
- fetch-llama / fetch-whisper with a real CRT folder (none on this PC) and the pinned-CRT happy path (pins are null).
- The package was not rebuilt (per instructions); the zip dry run used the existing `dist/win-unpacked`.

## Review fix pass (2026-10-20, ops/agent-notes/v5-review.md items 1, 4, 5) - supersedes note 7 and the permissions above

- **Zip layout (blocker 1a)**: every entry now sits under ONE top folder `WhatsAppCalendarAgent/` (src/shared/update.ts
  `UPDATE_ZIP_TOP_FOLDER`). The zip step's shape proof also fails on any entry outside that folder and checks
  `WhatsAppCalendarAgent/WhatsApp Calendar Agent.exe` + `WhatsAppCalendarAgent/resources/app.asar`. The app's stager refuses
  any other layout (flat, `win-unpacked/`, extra top entries). `scripts/release-manifest.mjs` does not inspect the zip's
  entries (only name + `PK` header + size/sha), so it is unchanged.
- Local dry run of the new step body (Windows PowerShell 5.1, the existing `dist/win-unpacked`, output in the scratchpad):
  6795 files under `WhatsAppCalendarAgent/`, 227,272,351 B, exit 0. The app's own extractor + packaged-build rule run on that
  zip (Node 24 type stripping): 6795 files / 737 MB extracted in 7.2 s, longest event-loop gap 33 ms, verdict ok. Deleted.
- **Least privilege (should-fix 4)**: three jobs. `crt-pins` (read, unchanged role). `build` (`contents: read`, checkout
  `persist-credentials: false`) does everything the old `release` job did up to release.json, then `upload-artifact`
  (`release-bundle`, zip + release.json, compression 0, 3 days). `publish` (`contents: write`, ubuntu-latest, NO checkout, runs
  nothing of the repo): `download-artifact`, then bash verifies the artifact holds exactly `release.json` + the zip, schema 1,
  version = `0.1.<run_number>` (derived in the publish job, never taken from build outputs), commit = `GITHUB_SHA`, asset name,
  size (`stat`) and sha256 (`sha256sum`) against release.json; then `gh release create` with `GH_REPO`, notes from
  release.json's `notes` + the sha, passed as shell variables (no `${{ }}` in scripts).
- **SHA pins (should-fix 5)**, looked up with `git ls-remote https://github.com/actions/<name> refs/tags/v4` on 2026-10-20
  (all four `v4` tags are lightweight, so the listed object IS the commit; it equals the newest v4.x.y tag):
  - actions/checkout `11d5960a326750d5838078e36cf38b85af677262` (v4.4.0)
  - actions/setup-node `49933ea5288caeca8642d1e84afbd3f7d6820020` (v4.4.0)
  - actions/upload-artifact `ea165f8d65b6e75b540449e92b4886f43607fa02` (v4.6.2)
  - actions/download-artifact `d3f86a106a0bac45b974a628896c90dbdf5c8093` (v4.3.0)
- YAML validated by parsing with the repo's `js-yaml` (jobs crt-pins/build/publish, every `uses:` matches `@[0-9a-f]{40}`,
  checkout has `persist-credentials: false`, permissions read/read/write). Still not runnable locally (no `act`): untested are
  the artifact hand-off, `jq`/`gh` on ubuntu-latest and the publish permissions.
