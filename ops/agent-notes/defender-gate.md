# defender-gate - Microsoft Defender scan gate + false-positive guide (D-078, NOTES R11)

Date: 2026-10-04. Owner of: `scripts/defender-scan.mjs` (new), `scripts/defender-scan.test.mjs` (new), ONE optional stage in
`scripts/smoke-packaged.mjs` (check 13, `--defender`), `package.json` script `test:defender`, `docs/WINDOWS-SECURITY.md` (new).
No commit, no new dependency, no version change. Nothing was executed from the packaged tree or the installer.

## What was built

- `scripts/defender-scan.mjs`: for every target, one run of
  `"%ProgramFiles%\Windows Defender\MpCmdRun.exe" -Scan -ScanType 3 -File <abs path> -DisableRemediation`
  (array argv, `shell: false`, `windowsHide`, absolute exe path, 20 min timeout per target, bounded output, killed on timeout).
  The default targets are `dist/win-unpacked` and `dist/WhatsAppCalendarAgent-Setup-*.exe` (electron-builder.yml `nsis.artifactName`), each when present.
  Positional args override the defaults. Also supports `--no-installer` and `--timeout-ms=N`.
- Exit codes: 0 PASS, 1 THREATS (detection names printed), 2 SIGNATURE FAIL (only when `WCA_SIGN_MODE` is set),
  4 SCAN INCOMPLETE (never clean). Precedence is 1 > 2 > 4 > 0.
- Authenticode: one `powershell.exe -NoProfile -NonInteractive -Command <fixed script>` per batch.
  - The paths travel in env `WCA_AUTHENTICODE_PATHS`, one per line, never inside the script text.
  - The script is read-only: `Get-AuthenticodeSignature` only, no Set-/Add-/Remove- and no cert store.
  - PE files are found by extension (.exe/.dll/.node/.sys) OR by the MZ + `PE\0\0` header. This matches the signing pipeline's header-based detection.
  - When signing is off, the per-file status is information only. When `WCA_SIGN_MODE` is set (anything except empty/off/none), every non-`Valid` status fails, and so does an unreadable status.
- `smoke-packaged.mjs`: check 13 runs only with `--defender`, after check 12 and before the check 6 spawn audit. It imports `runDefenderGate` and adds no `spawn(` to that file (the existing source-scan tests still hold). Threats, a scan that could not complete and signature failures all become problems.
- `package.json`: `"test:defender": "node scripts/defender-scan.mjs"`. It scans an existing `dist/`; build first. It is NOT added to `verify`, which is the orchestrator's call.
- `docs/WINDOWS-SECURITY.md` covers:
  - SAC, SmartScreen and Defender AV compared;
  - why self-signing fails SAC;
  - the certificate options, using the D-078 facts only;
  - the env-var section, with a clearly marked placeholder (see hand-off);
  - how to run the gate, the exit codes and the measured result;
  - the false-positive submission steps.

## Facts measured on this PC (keep these)

- **MpCmdRun exit 2 is ambiguous.** It means "threats found" AND also `CmdTool: Failed with hr = 0x80508023` (tested on a
  non-existent path). The gate therefore classifies on exit code + console text:
  - clean = exit 0 + "found no threats";
  - threats = a "found N threats" (N>0) line or `Threat :` lines;
  - everything else = incomplete.
  A clean file printed exactly "Scan starting... / Scan finished. / Scanning <path> found no threats." (ANSI, CRLF).
- **Windows PowerShell 5.1 trap.** A JSON array piped through `ConvertFrom-Json` is emitted as ONE pipeline object, so
  `@(... | ConvertFrom-Json)` wrapped it. The first real run therefore reported all 46 files as "Unreadable": the gate showed a
  warning-free but wrong list. The fix is to pass the paths one per line and use `-split "`n"`. A test pins this (no `ConvertFrom-Json` in the script).
- **Bash-tool heredocs on this machine collapse `\\` to `\`.** Scratch .mjs files written that way had corrupted Windows
  paths. Write such files with the Write tool.

## Real gate runs (true results)

Build 1 (23:20, before the signing-pipeline edited electron-builder.yml):
- Commands: `npm run pack:dir` (exit 0), then `npx electron-builder --win --x64` (exit 0).
- Output: `dist/WhatsAppCalendarAgent-Setup-0.1.0.exe`, 158,447,159 B.

Build 2 (23:32, with the signing-pipeline's hooks present, WCA_SIGN_MODE unset):
- Same two commands, both exit 0.
- electron-builder logged "signing with signtool.exe" for each file, but nothing was signed (the hook is a no-op while off).
- The packaged bridge still hashes to the import pin (`ac23221e...`).

`npm run test:defender` on build 2 exited **0 (PASS)**:
- `dist\win-unpacked`: no threats (38.1 s; 21-32 s on build 1).
- `dist\WhatsAppCalendarAgent-Setup-0.1.0.exe`: no threats (6.2 s; 1-3 s on build 1).
- Authenticode, 46 PE files: **NotSigned 44, Valid 2**. The two Valid files are `d3dcompiler_47.dll` and `dxil.dll`, signed by Microsoft Windows.
  All of ours are NotSigned: the app exe, the bridge, llama-server and its DLLs, whisper-cli and its DLLs, elevate.exe, Electron's
  ffmpeg/vulkan/swiftshader/dxcompiler and the installer. No CRT DLLs are in the tree (VC_REDIST_CRT_DIR unset).

The installer was never run. The app was never started. `smoke-packaged.mjs` was NOT run, because it starts the packaged exe as Node and this
phase forbids executing the packaged app. Check 13 is therefore covered by source and wiring tests only.

## Checks

- `npm run lint`: 0. (Mid-phase it showed one error in `scripts/sign-windows.mjs`, the signing-pipeline's file. It was clean at the end.)
- `npm run typecheck`: 0.
- `npx vitest run`: 331 files, 7681 passed, 1 expected fail, 1 skipped. 0 failed.
- `prettier --check` on my files: clean.
- `scripts/defender-scan.test.mjs` has 35 tests. They cover:
  - fake MpCmdRun: clean / threat / cannot-run (hr + ENOENT) / timeout / missing target / mixed targets;
  - signature enforcement;
  - argv and env shape;
  - source bans: no shell:true, no exec/execFile/spawnSync, no preference/exclusion/quarantine/cert-store tokens;
  - smoke check 13 wiring;
  - the real `defaultRunner` timeout kill and ENOENT, using `node` only.

## Hand-off / coordination

- **signing-pipeline:**
  - `WCA_SIGN_MODE` semantics are compatible. Your pipeline treats unset/off as off and signtool-cert|azure as on. My gate enforces `Valid` on every PE file for any value except empty/off/none.
  - The gate scans the whole tree, including Microsoft-signed `d3dcompiler_47.dll` / `dxil.dll`, which are already Valid.
  - I do not read `resources/signing-manifest.json`. A later gate could cross-check it.
- **Orchestrator:**
  - (a) `docs/WINDOWS-SECURITY.md` section 3 has an HTML-comment marker plus a "TO BE COMPLETED BY THE ORCHESTRATOR" box.
    `ops/agent-notes/signing-pipeline.md` did not exist when I wrote it. The variable names I saw in `scripts/sign-windows.mjs`
    (`WCA_SIGN_MODE`, `WCA_SIGN_TIMESTAMP_URL`, `WCA_SIGNTOOL_PATH`, `WCA_SIGN_PUBLISHER`, `WCA_SIGN_CERT_SHA`, `WCA_AZURE_*`)
    should be copied there from that agent's notes, NOT from me.
  - (b) Consider adding `test:defender` to `verify`, or to a release checklist after the installer build.
  - (c) T-803's README section can link to `docs/WINDOWS-SECURITY.md`.
- The false-positive guide gives the portal URL `https://www.microsoft.com/wdsi/filesubmission` with the role "Software developer".
  The exact form labels can drift, so the user should follow what the portal shows.
- `dist/` now holds a fresh unsigned win-unpacked tree and the 0.1.0 installer FILE, built 23:32. Both are untracked build output.
