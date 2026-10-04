# signing-pipeline - inactive, env-driven Authenticode signing + post-signing bridge re-pin (D-078)

Date: 2026-10-04. Owner files: `electron-builder.yml`, `scripts/sign-windows.mjs` (new), `scripts/sign-windows.test.mjs` (new),
`src/main/bridge/launcher.ts` + `launcher.test.ts`, `src/main/bridge/invariants.ts` + `invariants.test.ts` (holds the bridge pin).
No dependency, version, certificate, store or security-setting change. No commit. No certificate was created or used.

## What was built

1. **`scripts/sign-windows.mjs`**, wired into `electron-builder.yml` (checked against the INSTALLED electron-builder 26.15.3 code,
   `app-builder-lib/out/winPackager.js`, `codeSign/windowsSignToolManager.js`, `targets/nsis/NsisTarget.js`, `packager.js`):
   - `win.signtoolOptions.sign` (named export `sign`), `signingHashAlgorithms: [sha256]`, `win.signExts: ['.dll']`;
   - top-level hooks `beforePack`, `afterSign`, `artifactBuildCompleted` pointing at the same module (one module instance per build,
     so one signing journal).
   - **OFF** (WCA_SIGN_MODE unset / empty / `off`): every hook returns before reading, hashing, writing or spawning anything.
   - **ON**: a custom signer drives `signtool.exe` itself for BOTH modes. `azureSignOptions` deliberately NOT used: electron-builder's
     Azure manager runs `Install-Module TrustedSigning` / `Install-PackageProvider NuGet` on the build machine and would bypass the
     provenance + re-pin steps. Azure mode uses signtool's documented `/dlib Azure.CodeSigning.Dlib.dll /dmdf metadata.json` path.
2. **Order / coverage** (electron-builder decides when, the module refuses gaps):
   phase 1 = extraResources at copy time (bridge, 23 llama PE, 13 whisper PE), phase 2 = app root (6 Electron runtime DLLs, then the
   app exe), then `afterSign`; NSIS target = `resources\elevate.exe`, `__uninstaller.exe`, installer, then `artifactBuildCompleted`.
   `node scripts/sign-windows.mjs --plan dist/win-unpacked` on today's tree: **44 PE files** (+ elevate, uninstaller, installer).
3. **Safety rules enforced in code** (all unit-tested with a fake signer / fake verifier):
   - half-configured mode => `SigningConfigError` listing EVERY missing/invalid variable, thrown in `beforePack` (before anything is packed)
     and again by `sign` / `afterSign` if the hooks were bypassed;
   - SHA-256 digest only (a sha1 pass throws), RFC 3161 `/tr` + `/td sha256`, `/d "WhatsApp Calendar Agent"`; never `/a`, `/p`, `/f`;
   - **provenance before signing**: bridge exe must equal the import-bridge pin (AC23221E...), whisper files their
     `vendor/whisper/SHA256SUMS` line (CRT DLLs: their vendor copy), llama files their fetch-verified `vendor/llama/win-x64-vulkan`
     copy; an unexpected PE in `resources/bridge`, or a llama/whisper PE with no vetted source, is refused. Our signature never lands
     on an unvetted binary. Files under the repo's `resources/`, `vendor/`, `build-resources/`, `node_modules/` are never signed in place;
   - signer "success" with unchanged bytes => throws; signtool failure => throws (electron-builder fails the build);
   - `afterSign` walks the packed tree, finds every PE file **by MZ/PE header** (not extension), requires each one to be in the journal
     with its post-signing bytes unchanged, then verifies all of them in one `Get-AuthenticodeSignature` call (status `Valid`,
     time-stamped, thumbprint = WCA_SIGN_CERT_SHA1 in signtool-cert mode, subject CN = WCA_SIGN_PUBLISHER when set / azure);
   - installer cannot be signed before the uninstaller and (if present) elevate.exe; the uninstaller is verified right after signing
     (electron-builder deletes it before the installer event); `artifactBuildCompleted` re-walks the tree (elevate.exe) and verifies
     the installer; an installer event without a prior `afterSign` throws;
   - the thumbprint is never written to any file and is redacted (`[REDACTED-SHA1 len=40]`) from signtool output in errors.
4. **Re-pinning** (`afterSign`, signing ON only): the PACKAGED `resources/bridge/SHA256SUMS` becomes
   ```
   <SIGNED SHA-256>  whatsapp-bridge.exe
   # wca-signed-from <ORIGINAL SHA-256>  whatsapp-bridge.exe
   ```
   (only after checking the packaged file still lists the original pin). `resources/signing-manifest.json` records
   `{path, kind, provenance, originalSha256, signedSha256}` for every signed file of the tree (llama-server, whisper-cli included).
   The repo `resources/bridge/SHA256SUMS` and `BRIDGE_EXE.sha256` / import-bridge pin are unchanged (provenance at import time).
5. **Launcher** (`invariants.ts selectBridgePin`, `launcher.ts readBridgePinFile` + `resolveBridgeExe`): the expected hash is
   - the compiled-in original pin when there is no `wca-signed-from` line (every unsigned build; the file's own hash line alone is
     never trusted);
   - the post-signing hash when there is exactly one signed-from line equal to the compiled-in pin and exactly one hash line that
     differs from it;
   - otherwise the original pin again (`signed_entry_rejected`, fail closed -> a signed exe is BRIDGE_BINARY_BLOCKED).
   Still one exact SHA-256 compared in `spawnOnce()`; never "any signed file". Tampered exe fails in both builds (tested).
   `resolveBridgeExe` gained an optional `readPinFile` seam; return shape unchanged, compose.ts untouched.

## Environment variables (exact text for README "Code signing")

Signing is OFF unless `WCA_SIGN_MODE` is set. Nothing below is ever written to a file; set them only in the shell that runs
`npm run pack:dir` / `electron-builder`.

| Variable | Mode | Required | Meaning |
|---|---|---|---|
| `WCA_SIGN_MODE` | all | - | unset / `off` = unsigned build (default). `signtool-cert` = a Microsoft Trusted Root Program code-signing certificate signtool can reach on this PC (e.g. Certum Open Source via SimplySign Desktop's virtual smart card). `azure` = Azure Artifact Signing (formerly Trusted Signing). |
| `WCA_SIGN_TIMESTAMP_URL` | all | no | RFC 3161 time-stamp URL. Default `http://timestamp.digicert.com` (signtool-cert), `http://timestamp.acs.microsoft.com` (azure). |
| `WCA_SIGNTOOL_PATH` | all | no | Absolute path to `signtool.exe`. Default: newest `C:\Program Files (x86)\Windows Kits\10\bin\10.0.*\x64\signtool.exe`. The Windows SDK is NOT installed on this PC today: install "Windows SDK Signing Tools for Desktop Apps" (10.0.22621 or newer for azure) or set this. Nothing is ever downloaded. |
| `WCA_SIGN_CERT_SHA1` | signtool-cert | yes | SHA-1 thumbprint (40 hex; spaces allowed) of the certificate in the CurrentUser\My store, selected with `/sha1`. |
| `WCA_SIGN_PUBLISHER` | signtool-cert: no; azure: yes | | Exact subject CN of the signing certificate; every signature is checked against it. |
| `WCA_AZURE_ENDPOINT` | azure | yes | Account endpoint, https (e.g. `https://weu.codesigning.azure.net/`). |
| `WCA_AZURE_ACCOUNT` | azure | yes | Artifact Signing account name. |
| `WCA_AZURE_PROFILE` | azure | yes | Certificate profile name. |
| `WCA_AZURE_DLIB` | azure | yes | Absolute path to `Azure.CodeSigning.Dlib.dll` (Microsoft Artifact Signing client). |

Azure authentication is done by the dlib itself (Azure.Identity DefaultAzureCredential: `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` /
`AZURE_CLIENT_SECRET`, or an `az login` session); this pipeline never reads or stores those.
Check a configuration without building: `node scripts/sign-windows.mjs --check-env`. List what would be signed:
`node scripts/sign-windows.mjs --plan dist/win-unpacked`. Example (Certum SimplySign, PowerShell):
`$env:WCA_SIGN_MODE='signtool-cert'; $env:WCA_SIGN_CERT_SHA1='<thumbprint from certmgr>'; $env:WCA_SIGN_PUBLISHER='<CN>'; npm run pack:dir`
(SimplySign Desktop must be running and logged in so the cloud key is visible to signtool).

## Evidence (all signing OFF unless stated)

- Byte identity: `electron-builder --win --x64 --dir` with the ORIGINAL yml (copied to scratch, `--config`) and with the new yml,
  back to back into two scratch output dirs: **6793 files, every sha256 identical** (app.asar included). `out/` changed during the
  window (another agent rebuilt), but both trees were identical, so the comparison holds.
- ON-mode refusals through the REAL electron-builder (scratch output, synthetic thumbprint `0123...4567`, no certificate):
  `WCA_SIGN_MODE=signtool-cert` alone -> exit 1 in `beforePack`, nothing packed; + thumbprint, no signtool -> exit 1 "no signtool.exe
  found"; + a stand-in signtool that just fails (a copy of node.exe in scratch) -> provenance passed for the vendored DLLs, signtool
  "failed", **build exit 1**, packaged SHA256SUMS NOT re-pinned, thumbprint absent from the log (grep count 0).
  NB electron-builder logs "signing failed for file, queue will continue to next file" - misleading; the build still fails.
- `npm run lint` 0. `npm run typecheck` 0. `npx vitest run`: **331 files, 7681 passed, 1 expected fail, 1 skipped**.
  `invariants.ts` coverage 100/100/100/100. New: `scripts/sign-windows.test.mjs` 45 tests, +8 invariants tests, +6 launcher tests.
- `npm run test:smoke`: **exit 1, RED - same as before this change** (docs/ACCEPTANCE.md row 6, v2-reverify): checks 1, 2, 9 did
  not run (`spawn UNKNOWN`, Smart App Control refuses the freshly packed unsigned exe - R11); checks 3, 4, 4a, 5, 6, 7, 8, 10, 11, 12
  pass. Not weakened. The tree it tested is byte-identical to a pre-change build (above), so this is environmental, not this change.

## Not done / hand-off (orchestrator)

1. **README** "Code signing" section: paste the table above (README is not mine).
2. **Smoke in a SIGNED build** (`scripts/smoke-packaged.mjs`, not mine; currently being edited by another agent): check 4 compares the
   packaged bridge exe with the ORIGINAL pin and check 7 compares packaged whisper files with `vendor/whisper/SHA256SUMS`; both will
   fail on a signed tree. Suggested rule: accept a packaged file iff `resources/signing-manifest.json` has an entry whose
   `originalSha256` equals the pin AND whose `signedSha256` equals the packaged file (and, for the bridge, `selectBridgePin` of the
   packaged SHA256SUMS returns `signed` with that hash). `signing-manifest.json` is a new top-level resources file in signed builds only.
3. **NSIS installer not built by me** (only `--dir`): the installer/uninstaller/elevate path is unit-tested with the fake signer and
   matches NsisTarget.js 26.15.3, but the first real signed `electron-builder --win` run should be watched.
4. Electron ships `d3dcompiler_47.dll`, `dxcompiler.dll`, `dxil.dll` (possibly already Microsoft-signed); `signExts: .dll` re-signs them
   with our certificate (electron-builder's documented behaviour). Acceptable for SAC; a later refinement could skip DLLs already
   validly signed by Microsoft (would need a pre-sign Get-AuthenticodeSignature).
5. Trust note: the re-pin lives in `<resources>\bridge\SHA256SUMS`, which is exactly as writable as `app.asar` in the per-user install
   (asar integrity fuse is off), so it gives the same protection as the compiled-in pin against a local writer - but such a writer
   could now add a `wca-signed-from` line to an UNSIGNED build instead of patching app.asar. Once signing is real, consider
   `enableEmbeddedAsarIntegrityValidation: true` and moving the signed pin into the asar (beforePack could write it into `out/`).
6. A failed signed build can leave `dist/win-unpacked` partly signed; it always exits non-zero. Never ship from a failed build
   (electron-builder recreates the tree on the next run).
7. Scratch artefacts (baseline/new trees, logs) are in the session scratchpad only; nothing was left in the repo.
