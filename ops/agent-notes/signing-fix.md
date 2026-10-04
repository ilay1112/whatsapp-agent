# signing-fix - fixes for the confirmed signing-review MAJOR findings 1-5 (D-078)

Date: 2026-10-04/05. Input: `ops/agent-notes/signing-review.md` MAJOR 1-5. No certificate, store, security setting,
Defender setting, commit, npm dependency or version change. Nothing was executed from the packaged tree or an installer.
Every finding got a failing test first: 66 tests were red before the implementation, then green.

## What changed, per finding

### MAJOR 1 - the bridge pin came from a writable text file, unsigned builds included
- `electron.vite.config.ts` (NOT a file of the two build agents; edited because the finding prescribes an electron-vite
  `define`): main gets `define: { __AUTHENTICODE_SIGNED_BUILD__ }`. It is true only when `WCA_SIGN_MODE` is set and not
  `off` at build time, which is the same rule as `readSigningConfig`. A sidecar plugin emits `out/main/build-flags.json`
  `{schema:1, signedBuild}`.
  - The define is NOT named `__WCA_SIGNED_BUILD__` (the review's suggestion): TESTS 4.1's seam lock
    (`tests/security/electron-hardening.test.ts`) forbids any `WCA_*` identifier in `src/` code outside
    `testSeams.ts`. The lock went red with that name; I renamed the define instead of touching the lock.
- `src/main/buildFlags.ts` (new): `SIGNED_BUILD`, false wherever the define is absent (vitest, tsc).
- `src/main/bridge/launcher.ts`:
  - `resolveBridgeExe` with the flag off returns `BRIDGE_EXE.sha256` and reads NO file, which is the pre-pipeline
    behaviour.
  - With the flag on, it reads ONLY `<resources>\app.asar\out\main\bridge-signed-pin.txt` (`signedPinPathFor`), never
    `resources\bridge\SHA256SUMS`.
  - `readBridgePinFile(pinPath)` now takes the pin path, and a `signedBuild?` seam was added. The return shape is
    unchanged and compose.ts is untouched.
- `src/main/bridge/invariants.ts`: `BRIDGE_PIN_FILE` was replaced by `BRIDGE_SIGNED_PIN_FILE = 'bridge-signed-pin.txt'`.
  `selectBridgePin` is unchanged; it now only parses the asar file.
- `scripts/sign-windows.mjs`:
  - `beforePack(ctx)` reads `out/main/build-flags.json` from `packager.info.appDir`. It refuses a missing or malformed
    file, and a mode/flag mismatch in BOTH directions. This is the one read OFF mode now does.
  - Signing ON:
    - sets `packager.config.electronFuses.enableEmbeddedAsarIntegrityValidation = true` (signed builds only; the
      yml `false` stays the unsigned default);
    - checks the repo `resources/bridge/whatsapp-bridge.exe` against the import pin;
    - signs a STAGED copy in `%TEMP%\wca-bridge-*`, then verifies it with Get-AuthenticodeSignature;
    - writes `out/main/bridge-signed-pin.txt`. beforePack runs before copyAppFiles (`platformPackager.js`), so
      electron-builder packs the pin into app.asar.
  - `signFile` on the packaged bridge copies the pre-signed bytes in place and never signs it a second time. Without
    the pre-signing it refuses.
  - `afterSign` checks four things:
    - the packaged bridge equals the pre-signed hash;
    - `app.asar` carries the exact pin text (`readAsarText`, using @electron/asar `extractFile`);
    - the app exe has the asar-integrity fuse ENABLED (`asarIntegrityFuseEnabled`, using @electron/fuses
      `getCurrentFuseWire`; both packages are already installed, so no new dependency);
    - the manifest is written as before.
  - `resources/bridge/SHA256SUMS` is never rewritten any more.
  - Measured: @electron/asar 3.4.1 on Windows does NOT find `out/main/x` with forward slashes, only `out\main\x`.
    `readAsarText` joins with the native separator. A test against a real `createPackage` archive caught this.
  - Temp dirs now share one process-exit cleanup hook instead of one listener per session.
- `electron-builder.yml`: comment only. `enableEmbeddedAsarIntegrityValidation: false` is kept as the unsigned default,
  and a test pins it.

### MAJOR 2 - thumbprint in the error when signtool is killed
- `createSigntoolSigner` never uses `err.message`. The reason is built only from `err.killed` / `err.code` /
  `err.signal`, and the WHOLE message goes through `redact()`. It gained `timeoutMs` and `execFileImpl` seams.
- Tests:
  - a REAL hanging stand-in (`node`) killed by a 300 ms timeout, with a synthetic thumbprint in argv and stdout;
  - four injected failure shapes.
  - In both, the message never contains the thumbprint (plain or spaced) or "Command failed".

### MAJOR 3 - tautological provenance for llama / whisper / CRT
- `createProvenance` takes its reference from two places:
  - llama / whisper files: the COMMITTED `vendor/*.pin.json` `files.fileSha256[name]`;
  - CRT DLLs: `vcRedistCrt.files[name]`, where null = UNPINNED = refused.
  - A missing map or entry is refused, and the message names `--pin-files`. The vendor/ copy and
    `vendor/whisper/SHA256SUMS` are no longer references.
- `scripts/fetch-llama.mjs` gained:
  - `allowedZipFiles`, `zipFileDigests`, `checkFilePins`, `applyFilePins` and `pinFiles` (`--pin-files`);
  - `main()` checks every file against the map BEFORE writing anything. A null map gives a warning; the fetch still
    stages.
- `scripts/fetch-whisper.mjs`: the same, via the shared helpers (`--pin-files`, Release/ stripped).
- `vendor/llama.pin.json` and `vendor/whisper.pin.json`: added `"fileSha256": null` plus a `_fileSha256` explanation.
  - **The values are NOT filled.** Generating them needs a download of the pinned zips, which needs user approval. No
    cached zip exists on this PC.
  - Hashing the current gitignored vendor/ copies would recreate the very tautology the finding describes.
  - Until the values are committed, a SIGNED build refuses every llama / whisper file (fail closed). Unsigned builds
    are unaffected.

### MAJOR 4 - the gate passed an empty / truncated / missing tree
`scripts/defender-scan.mjs`:
- `EXPECTED_PAYLOAD`: the app exe, `resources/app.asar`, the bridge exe, and at least 44 PE files.
- `payloadProblems` is applied to every folder target. Problems give exit 4.
- In enforce mode, 0 PE files is a signature failure.
- `classifyScan({target})` requires the "Scanning <target> found no threats" line to name that target.
- `defaultTargets` ALWAYS includes `dist/win-unpacked`, so a missing tree is exit 4 instead of a "note".
- `smoke-packaged.mjs` check 13 maps `payloadProblems` to problems; otherwise a payload-only failure would have passed
  check 13 silently.

### MAJOR 5 - enforcement only from the gate's shell; any CA accepted
- Enforcement is on when `WCA_SIGN_MODE` is set OR a folder target has `resources/signing-manifest.json`.
- The manifest is cross-checked: each listed file must exist inside the tree and hash to its `signedSha256`.
- When enforcing, every file must be Valid AND time-stamped (the PS script now emits
  `timestamped = [bool]$s.TimeStamperCertificate`). The signer CN must equal `WCA_SIGN_PUBLISHER` when it is set.
- Not enforcing: a MIXED set fails (exit 2). A mixed set means some of OUR files are Valid and some are not.
  Microsoft-signed files (`CN=Microsoft..., O=Microsoft Corporation`) do not count. This catches a partially signed
  tree and a stale unsigned installer next to a signed tree.

## Evidence
- Commands:
  - `npm run lint`: 0.
  - `npm run typecheck`: 0.
  - `npx prettier --check .`: clean.
- `npx vitest run`: 331 files, **7722 passed, 1 failed**, 1 expected fail, 1 skipped.
  - The failure is `src/renderer/src/components/UndoDismissDrawer.test.tsx` "shows a clock time for today...".
  - It is a time-of-day flake, NOT this phase: the test builds "today" as `Date.now() - 1 h`, and the run was at
    00:13 local, so the item is "yesterday". No file of that component or test was touched. Reported, not weakened.
  - Rerun of the touched areas (scripts/, src/main/bridge, electron-hardening): 26 files, 815 passed.
- `npm run pack:dir` with signing OFF: exit 0. Read-only checks of the real output:
  - `out/main/build-flags.json` = `{"schema":1,"signedBuild":false}`;
  - the bundle has `const SIGNED_BUILD = false;` and no longer names `SHA256SUMS`;
  - app.asar has `build-flags.json` and no `bridge-signed-pin.txt`;
  - the packaged bridge = the import pin; the packaged `SHA256SUMS` = the original line; no signing-manifest;
  - the real `asarIntegrityFuseEnabled` reads the real exe: OFF (unchanged); 44 PE files.
- Real Defender gate:
  - `node scripts/defender-scan.mjs` (tree + the older 0.1.0 installer): **exit 0**, no threats. Authenticode
    NotSigned 43, Valid 2 (the Microsoft DirectX DLLs, not "mixed").
  - The reviewer's reproduction (an empty folder): now **exit 4** (payload), and **exit 2** with `WCA_SIGN_MODE` set.

## NOT done / hand-off (orchestrator)
1. **`npm run test:smoke` was NOT run.** `smoke-packaged.mjs` checks 1, 2 and 9 spawn `WhatsApp Calendar Agent.exe`
   (as Node). This phase's hard rules forbid executing the packaged app, and that outranks the checklist step. I ran its
   build half (`npm run pack:dir`, allowed) and the read-only checks above. The smoke unit tests
   (`smoke-packaged.test.mjs`) pass.
2. **Per-file pins are empty (null).** Before the first signed build, run `node scripts/fetch-llama.mjs --pin-files` and
   `node scripts/fetch-whisper.mjs --pin-files`. Each downloads its pinned zip (~31.7 MB / ~8.6 MB) and verifies size +
   sha256 before hashing. Then review and commit `vendor/*.pin.json`. This needs the user's approval for the download.
   The CRT pins (`--pin-crt`) are still null too.
3. README "Code signing":
   - add that `WCA_SIGN_MODE` must be identical for `npm run build` and packaging;
   - add the `--pin-files` step;
   - say that the signed pin lives in app.asar with asar integrity on in signed builds;
   - drop "re-pins resources/bridge/SHA256SUMS". `docs/WINDOWS-SECURITY.md` sections 2-4 are updated.
4. **First real signed build: watch it, and launch-test it on a clean SAC machine.** These are unverified until then:
   - `enableEmbeddedAsarIntegrityValidation` on Windows with electron-builder 26.15.3 (the yml's own `[LR]` note);
   - the beforePack mutation of `packager.config.electronFuses` (read by `doAddElectronFuses` after afterPack).
   - afterSign does verify that the fuse is ON in the exe.
5. Smoke checks 4 and 7 still compare against the ORIGINAL pins, so they fail on a signed tree. This is unchanged
   (review MINOR 11). A signed-tree rule can now use `out/main/bridge-signed-pin.txt` inside app.asar plus
   `signing-manifest.json`.
6. Review MINOR 6-12 were not in scope and are untouched. In the doc I removed the claim that `none` = unsigned for the
   BUILD; the gate still treats `none` as off.
7. `dist/` now holds a fresh unsigned `win-unpacked` (built this phase) next to the OLDER 0.1.0 installer (23:32). Both
   are unsigned build output, not committed.
8. Process note: one Bash `node -e` edit had backticks inside double quotes. bash tried to command-substitute them
   (e.g. `npm run build\`). Each failed with "not found" or "Missing script", nothing ran, and the file was not written.
   All later edits used the Edit tool.

## Files touched
- Scripts:
  - `scripts/sign-windows.mjs`, `scripts/sign-windows.test.mjs`
  - `scripts/defender-scan.mjs`, `scripts/defender-scan.test.mjs`
  - `scripts/fetch-llama.mjs`, `scripts/fetch-llama.test.mjs`
  - `scripts/fetch-whisper.mjs`, `scripts/fetch-whisper.test.mjs`
  - `scripts/smoke-packaged.mjs` (check 13: 2 lines)
- App source:
  - `src/main/buildFlags.ts` (new)
  - `src/main/bridge/launcher.ts`, `src/main/bridge/launcher.test.ts`
  - `src/main/bridge/invariants.ts`, `src/main/bridge/invariants.test.ts`
- Config, pins and docs:
  - `electron.vite.config.ts`, `electron-builder.yml` (comment only)
  - `vendor/llama.pin.json`, `vendor/whisper.pin.json`
  - `docs/WINDOWS-SECURITY.md`
