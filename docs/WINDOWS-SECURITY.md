# Windows security: Smart App Control, SmartScreen, Defender and code signing

This page is for you, the owner of the app. It explains three things:

- why Windows may block the app on your PC today;
- what a code-signing certificate would change, and what it would not;
- how to check a build with Microsoft Defender, and what to do if Defender wrongly flags it.

It records the decision of 2026-10-04 (`ops/DECISIONS.md` D-078): **the app ships unsigned for now**. The signing pipeline exists but is switched off until you have a certificate.

> Nothing on this page is done for you by an agent. Agents never create, import or trust certificates. They never change Smart App Control, Defender settings or exclusions, and they never touch any other security setting. Every step that changes your PC or spends money is yours.

---

## 1. Three different gatekeepers

Windows 11 has three separate protections that look alike from the outside. Each asks a different question.

| | Smart App Control (SAC) | Microsoft Defender SmartScreen | Microsoft Defender Antivirus |
|---|---|---|---|
| **Question it asks** | "Is this program known to be safe, or signed by someone Microsoft trusts?" | "Has this downloaded file built up a good reputation?" | "Does this file contain malware?" |
| **When it acts** | Every time a program or DLL **loads**, wherever it came from | When you open a file that came from the internet (it carries the "Mark of the Web") | When a file is written, opened or scanned |
| **What it checks** | Microsoft's cloud prediction first. If the cloud is not sure, it checks for a valid signature from a CA in the **Microsoft Trusted Root Program**. Unsigned and unknown means **blocked**, with no "run anyway" button. | Reputation of the file hash and of the signing certificate | File content: signatures, heuristics, cloud machine learning |
| **Effect on this app** | **The main blocker.** SAC is enforcing on your PC (`ops/CONTEXT.md`). It already refused the freshly built, unsigned exe during the packaging smoke test (`docs/ACCEPTANCE.md`, smoke checks 1/2/9). | A blue "Windows protected your PC" screen with a "More info → Run anyway" link, for a downloaded installer with no reputation | Today: **no detections** (section 4). It would only block the app on a detection. |
| **What fixes it** | A Trusted Root Program certificate on **every** PE file (exe and DLL), or Microsoft's cloud learning the files | A signed installer that builds reputation over time (downloads, installs) | Nothing, while the files are clean. A wrong detection is fixed by a false-positive submission (section 5). |

### Why a self-signed certificate does not help

A self-signed certificate (or one from a private CA you added to this PC's "Trusted Root" store) satisfies the plain Windows signature check on **your own PC**. Smart App Control does not use that store. It accepts only:

1. binaries that Microsoft's cloud predicts are safe; or
2. binaries signed with a certificate that chains to a CA in the **Microsoft Trusted Root Program**.

A locally trusted certificate meets neither condition, so SAC still blocks the app. Self-signing would also mean adding a root certificate to your machine's trust store. That widens what your PC trusts for every program, not just this one. For these two reasons the self-signed route was rejected (D-078).

Turning Smart App Control off is **your** decision alone. Microsoft documents that on many Windows 11 builds, once SAC is switched off it cannot be switched back on without resetting or reinstalling Windows. Check Microsoft's current SAC documentation before you decide. No agent will ever change it.

---

## 2. Certificate options (state of 2026, from D-078)

Since 2023, publicly trusted code-signing keys must live in hardware (an HSM or a token). Today that usually means a **cloud signing service**: the key stays with the CA and the build sends it only a hash to sign.

| Option | Who it is for | Notes |
|---|---|---|
| **Certum Open Source Code Signing (cloud / SimplySign)** | Individual maintainers of open-source projects | About **EUR 49 per year**. The repository is MIT-licensed (D-077) and public, so it qualifies. Certum checks your identity, and the certificate names **you** as the publisher. It chains to a CA in the Microsoft Trusted Root Program, so it meets Smart App Control's requirement. **This is the recommended route for this app.** |
| **Commercial OV (Organisation Validation) certificate, cloud-signed** | Anyone willing to pay a commercial CA | Same technical effect as Certum for SAC. It costs more and needs organisation or individual validation, depending on the CA. |
| **Azure Artifact Signing** (formerly "Trusted Signing") | Organisations with an Azure subscription and a verifiable business identity | Microsoft-run cloud signing with short-lived certificates. It fits an organisation better than a single hobby developer. |
| **EV (Extended Validation) certificate** | — | **No SmartScreen advantage since 2024.** EV certificates used to give instant SmartScreen reputation. Microsoft removed that, so EV now behaves like OV for SmartScreen and costs more. Not recommended. |

All files need signing, not just the main exe: `WhatsApp Calendar Agent.exe`, the bundled `whatsapp-bridge.exe`, `llama-server.exe`, `whisper-cli.exe`, their DLLs, Electron's own DLLs, and the installer and uninstaller. Smart App Control checks every binary that loads. The Defender gate (section 4) lists them all. In the build of 2026-10-04 there were **46 PE files: 44 unsigned and 2 already signed by Microsoft** (`d3dcompiler_47.dll`, `dxil.dll`).

Signing changes a file's bytes, which changes its SHA-256. The app pins the hashes of its bundled executables, so signing must be followed by **re-pinning** those hashes (ticket T-801, owned by the signing pipeline). [signing-fix] The signed bridge pin is written into `out/main/bridge-signed-pin.txt` before packaging, so it ships **inside `app.asar`** (asar integrity is switched on for signed builds). It is never taken from the writable `resources\bridge\SHA256SUMS`. An unsigned build reads no pin file at all. Before the first signed build, the llama.cpp and whisper.cpp per-file hashes must be generated once from their pinned zips (`node scripts/fetch-llama.mjs --pin-files`, `node scripts/fetch-whisper.mjs --pin-files`), reviewed and committed. Until then a signed build refuses to sign those files.

---

## 3. Turning signing on (environment variables)

The signing pipeline is `scripts/sign-windows.mjs`, wired into `electron-builder.yml` (ticket T-800, hardened by the review fixes of 2026-10-05). It is **off by default**: with `WCA_SIGN_MODE` unset, every hook returns before it reads, hashes, writes or starts anything, and the build is byte-for-byte the unsigned build of before.

### Before you start: what this PC does not have yet

- **A certificate.** Smart App Control accepts only a certificate that chains to a CA in the **Microsoft Trusted Root Program** (section 1), so the certificate must come from a public CA: Certum Open Source cloud (SimplySign), a commercial OV certificate, or Azure Artifact Signing (section 2). A self-signed certificate, or one from your own CA, will never satisfy Smart App Control.
- **`signtool.exe`.** The **Windows SDK is not installed on this PC** (checked on 2026-10-05: there is no `C:\Program Files (x86)\Windows Kits` folder). Install the "Windows SDK Signing Tools for Desktop Apps" component (version 10.0.22621 or newer if you use Azure), or point `WCA_SIGNTOOL_PATH` at a `signtool.exe` you already have. The pipeline never downloads or installs anything.
- **Per-file pins for llama.cpp and whisper.cpp.** The signer refuses to put your signature on a file whose origin it cannot prove. Run these once, review the hashes they record in `vendor/llama.pin.json` and `vendor/whisper.pin.json`, then commit them:

  ```powershell
  node scripts/fetch-llama.mjs --pin-files     # downloads the PINNED llama.cpp zip (~32 MB), checks size + SHA-256, records each file's hash
  node scripts/fetch-whisper.mjs --pin-files   # the same for the pinned whisper.cpp zip (~9 MB)
  ```

  If you ship the Microsoft C++ runtime (`VC_REDIST_CRT_DIR`, see README), pin it too with `node scripts/fetch-llama.mjs --pin-crt`. Until these pins are committed, a signed build stops with an error that names the missing pin. Unsigned builds do not need them.

### The environment variables

**All signing parameters come from environment variables.** None is ever written into a file in this repository. That includes the cloud-signing account, any PIN or password, and the certificate thumbprint. Set them only in the PowerShell window that runs the build, and keep them in your own password manager, never in a committed file. The pipeline redacts the thumbprint from every error message it prints.

| Variable | Used in mode | Required? | Meaning |
|---|---|---|---|
| `WCA_SIGN_MODE` | all | — | Unset, empty or `off`: unsigned build (today's state). `signtool-cert`: a Trusted Root Program code-signing certificate that `signtool` can reach on this PC, for example Certum Open Source through SimplySign Desktop's virtual smart card. `azure`: Azure Artifact Signing (formerly Trusted Signing). Any other value is refused. |
| `WCA_SIGN_TIMESTAMP_URL` | all | no | The RFC 3161 time-stamp server. Default: `http://timestamp.digicert.com` (signtool-cert) or `http://timestamp.acs.microsoft.com` (azure). |
| `WCA_SIGNTOOL_PATH` | all | no | Absolute path to `signtool.exe`. Default: the newest `C:\Program Files (x86)\Windows Kits\10\bin\10.0.*\x64\signtool.exe`. |
| `WCA_SIGN_CERT_SHA1` | signtool-cert | **yes** | SHA-1 thumbprint (40 hex digits; spaces allowed) of the certificate in your `CurrentUser\My` store. `signtool` selects the certificate by it (`/sha1`). |
| `WCA_SIGN_PUBLISHER` | signtool-cert: no · azure: **yes** | | The exact subject CN of the signing certificate. Every signature is checked against it after signing, and the Defender gate checks it again. |
| `WCA_AZURE_ENDPOINT` | azure | **yes** | Account endpoint, https only (for example `https://weu.codesigning.azure.net/`). |
| `WCA_AZURE_ACCOUNT` | azure | **yes** | Artifact Signing account name. |
| `WCA_AZURE_PROFILE` | azure | **yes** | Certificate profile name. |
| `WCA_AZURE_DLIB` | azure | **yes** | Absolute path to `Azure.CodeSigning.Dlib.dll` (Microsoft's Artifact Signing client). |

In `azure` mode, signing in to Azure is done by Microsoft's client library itself (an `az login` session, or the standard `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` variables). The pipeline never reads or stores those.

A half-configured mode is never "partly signed": the build stops before anything is packed and lists **every** missing or invalid variable.

### Rules the pipeline enforces

- **`WCA_SIGN_MODE` must be the same for `npm run build` and for packaging.** The build compiles a "signed build" flag into the app (and writes `out/main/build-flags.json`); packaging refuses a mismatch in either direction. Run both in the same PowerShell window.
- **Every PE file is signed**, found by its file header rather than its extension: the app exe, Electron's DLLs, `whatsapp-bridge.exe`, every llama.cpp and whisper.cpp file, and the NSIS installer, uninstaller and `elevate.exe`. SHA-256 digests and an RFC 3161 time stamp only. A file left unsigned, or changed after signing, fails the build.
- **Provenance before signing.** The bridge must match its import pin; llama.cpp, whisper.cpp and runtime DLLs must match their committed per-file pins. The project's signature never lands on a binary it has not verified.
- **The bridge is re-pinned inside the app.** Signing changes the bridge's bytes and SHA-256. A signed build signs a staged copy of the bridge first and writes its new hash to `out/main/bridge-signed-pin.txt`, which is packed **inside `app.asar`**. Signed builds also switch on Electron's asar integrity check, so that pin cannot be edited on disk. The writable `resources\bridge\SHA256SUMS` is never trusted for this. An unsigned build reads no pin file at all.
- A failed signed build can leave `dist\win-unpacked` partly signed. It always exits with an error; never ship from it. The Defender gate also fails a mixed set (section 4).

### Checking and running

```powershell
$env:PATH = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;" + $env:PATH
cd "C:\dev\whatsapp agent"

# Example: Certum Open Source through SimplySign Desktop (it must be running and logged in, so signtool can see the cloud key)
$env:WCA_SIGN_MODE      = 'signtool-cert'
$env:WCA_SIGN_CERT_SHA1 = '<thumbprint, from certmgr.msc>'
$env:WCA_SIGN_PUBLISHER = '<subject CN of your certificate>'

node scripts/sign-windows.mjs --check-env              # validates the variables; signs nothing
npm run build                                          # same window, same WCA_SIGN_MODE
node scripts/hash-bridge.mjs
npx electron-builder --win --x64                       # signs during packaging; fails on any gap
node scripts/sign-windows.mjs --plan dist/win-unpacked # optional: lists every PE file in signing order
npm run test:defender                                  # now ENFORCES: every file must be Valid and time-stamped
```

With `WCA_SIGN_MODE` set, or when the tree contains `resources\signing-manifest.json` (written by every signed build), the Defender gate **fails** (exit code 2) unless every PE file reports Authenticode status `Valid` with a time stamp, matches the manifest, and, when `WCA_SIGN_PUBLISHER` is set, is signed by that subject CN.

The first real signed build has not happened yet. Watch it closely, and test the result on a PC with Smart App Control on before you share it: the asar integrity check and the NSIS signing order are covered by unit tests but have not yet run against a real certificate.

---

## 4. The Defender scan gate

`scripts/defender-scan.mjs` scans the built app with Microsoft Defender before release. It is **report-only**:

- It runs `"%ProgramFiles%\Windows Defender\MpCmdRun.exe" -Scan -ScanType 3 -File <path> -DisableRemediation` on `dist\win-unpacked` (always: a missing tree fails) and on the NSIS installer `dist\WhatsAppCalendarAgent-Setup-<version>.exe` when it exists. A scanned folder must contain the app exe, `resources\app.asar`, the bridge and at least 44 PE files. An empty or truncated tree is never a pass.
- `-DisableRemediation` means Defender reports but **takes no action**. It also ignores exclusions, so an exclusion can never hide a detection from the gate, and it scans inside archives (`app.asar`, the installer payload).
- It never quarantines or restores anything, never adds exclusions and never changes a Defender setting.
- It also lists the Authenticode signature status of every exe and DLL, using a read-only `Get-AuthenticodeSignature` call.

### How to run it

```powershell
$env:PATH = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;" + $env:PATH
cd "C:\dev\whatsapp agent"
npm run build
node scripts/hash-bridge.mjs
npx electron-builder --win --x64     # builds dist\win-unpacked AND the installer file (does not run it)
npm run test:defender
```

To scan only the unpacked tree: `npm run pack:dir`, then `node scripts/defender-scan.mjs --no-installer`. The packaging smoke test can also run the gate as its optional check 13: `node scripts/smoke-packaged.mjs dist/win-unpacked --defender`.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | **PASS**: no threats in any target, complete payload. While signing is off, unsigned files are listed for information only. |
| 1 | **THREATS FOUND**: the detection names are printed. Do not release. If you believe it is wrong, see section 5. |
| 2 | **SIGNATURE FAIL**: signing is enforced (`WCA_SIGN_MODE` set, or `resources\signing-manifest.json` present) and a PE file is not `Valid`, not time-stamped, signed by another publisher, or differs from the manifest. Also returned when signing is off but the set is **mixed**: some of our files are signed and some are not (a failed signed build, or a stale unsigned installer). The Microsoft-signed DirectX DLLs do not count. |
| 4 | **SCAN INCOMPLETE**: a target could not be scanned (MpCmdRun missing, timed out, an error code, unrecognised output, a "no threats" line that does not name the target), or the packed tree is missing, empty or truncated. **This is never a clean result.** |

`MpCmdRun` returns exit code 2 both for "threats found" and for its own failures (for example `Failed with hr = 0x80508023` when a path does not exist). The gate therefore reads Defender's console text as well as the exit code. Only exit 0 together with the "found no threats" sentence counts as clean.

### Result on 2026-10-04 (version 0.1.0, unsigned)

| Target | Defender | Time |
|---|---|---|
| `dist\win-unpacked` (whole tree) | no threats | about 21–38 s |
| `dist\WhatsAppCalendarAgent-Setup-0.1.0.exe` (158 MB) | no threats | about 1–6 s |

Authenticode: 44 files `NotSigned` and 2 `Valid` (Microsoft-signed DirectX DLLs). This is expected while signing is off.

---

## 5. If Defender flags the app wrongly: submitting a false positive

Unsigned new programs, especially ones that start other processes (the bridge, the local AI engine, speech-to-text), sometimes trip machine-learning detections. If the gate (or Windows Security) reports a detection that you believe is wrong:

1. **Do not add an exclusion** and do not turn protection off. Neither fixes the problem for anyone else, and both weaken your PC.
2. **Write down the details:**
   - the exact **detection name** (for example `Trojan:Win32/Something!ml`, printed by the gate);
   - the file path;
   - the Defender **security intelligence version** (Windows Security → Virus & threat protection → Protection updates).
3. **Go to the Microsoft Security Intelligence submission portal:** <https://www.microsoft.com/wdsi/filesubmission>.
4. **Choose "Software developer"** as your role. Sign in with your Microsoft account, which lets you track the submission.
5. **Fill in the form:**
   - **Product:** "Microsoft Defender Antivirus" (Windows 10/11). Choose "Microsoft Defender SmartScreen" instead if the problem is the SmartScreen warning rather than a detection.
   - **File:** upload the flagged file. For the whole app, upload the installer. If the browser refuses to upload a detected file, put it in a password-protected ZIP and give the password in the form, as the portal explains.
   - **What you believe:** "Incorrect detection" (false positive).
   - **Detection name and definition version:** from step 2.
   - **Notes:** say that this is an open-source app built from the public repository (<https://github.com/ilay1112/whatsapp-agent>), what the flagged file does, and that you are its developer.
6. **Submit and keep the submission ID.** Microsoft's analysts usually reply within a few days. If they agree, they release updated definitions.
7. **Once Microsoft confirms the fix:** update the definitions (Windows Security → Virus & threat protection → Protection updates → Check for updates). Then rebuild and run `npm run test:defender` again. It should return 0.

A signed build (section 2) makes false positives less likely and quicker to clear, because the certificate links every file to an identified publisher.

---

## 6. Summary

- **Today:** the app is unsigned. The Defender gate is clean. Smart App Control is enforcing on this PC and has already refused a freshly packed, unsigned exe (Code Integrity events 3033, 3077 and 3118 during the packaged smoke test, `ops/PROGRESS.md` entry 65; risk R11 in `ops/NOTES.md`). For the same reason `npm run test:smoke` cannot fully pass on this PC until the build is signed.
- **To fix it properly:** get a Trusted Root Program certificate (Certum Open Source cloud is the cheapest fit). Install the Windows SDK signing tools, commit the per-file pins, set the signing environment variables (section 3), rebuild and run `npm run test:defender`.
- **Never:** self-sign, add exclusions, or let anyone else switch off Smart App Control for you.
