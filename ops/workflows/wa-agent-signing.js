export const meta = {
  name: 'wa-agent-signing',
  description: 'Phase 8: inactive env-driven Windows code-signing pipeline, post-signing hash re-pinning, Microsoft Defender scan gate, adversarial check, proof',
  phases: [
    { title: 'Build', detail: '2 parallel agents: signing pipeline + re-pinning; Defender scan gate + submission guide' },
    { title: 'Review', detail: 'adversarial check of the signing path and the gate' },
    { title: 'Prove', detail: 'full pipeline incl. packaged smoke and the Defender gate' },
  ],
}

const ROOT = 'C:\\dev\\whatsapp agent'

const RULES = `
## Project: "WhatsApp Calendar Agent" (Electron + TypeScript, Windows 11) at "${ROOT}" (path has a space - always quote it). v1 and v2 are built and reviewed.
### Why this phase exists (read ops/DECISIONS.md D-077 and D-078, ops/NOTES.md R11)
The user asked for the app to be signed for a clean pass at Windows Defender. Their PC has **Smart App Control enforcing**, which only accepts code signed by a CA in the Microsoft Trusted Root Program (self-signed / locally trusted certificates are NOT accepted). The user chose **"Not now"**: the app ships UNSIGNED today, and this phase makes signing a pure configuration step for later and adds a Defender scan gate.
### Hard rules (a violation ends the operation)
- NEVER create, import, trust or delete a certificate; NEVER touch the Windows certificate stores, Smart App Control, Defender settings, exclusions or any security setting. Scanning with MpCmdRun is allowed; changing anything is not.
- NEVER read, list, copy or modify "C:\\Users\\ilay1\\Documents\\minime\\whatsapp-mcp\\whatsapp-bridge\\store". NEVER execute whatsapp-bridge.exe, llama-server.exe, whisper-cli.exe, claude.exe, agy.exe or the packaged app. NEVER start the packaged GUI or run the installer. Building the unpacked tree and the NSIS installer FILE is allowed in this phase (D-078) so they can be scanned - building is not running.
- No secret, password, PIN or certificate thumbprint of the user's in any file; all signing parameters come from environment variables documented in README.
- No new npm dependency, no version change, no git commit. Every PowerShell command starts with: $env:PATH = "C:\\Program Files\\nodejs;C:\\Program Files\\Git\\cmd;" + $env:PATH
- Notes: ops/agent-notes/<your-label>.md. Never edit another agent's notes, ops/PROGRESS.md, ops/BOARD.md or ops/DECISIONS.md. A red test is reported, never weakened.
`

const SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    fixed: { type: 'array', items: { type: 'string' } },
    notFixed: { type: 'array', items: { type: 'string' } },
    filesTouched: { type: 'array', items: { type: 'string' } },
  },
  required: ['label', 'status', 'fixed', 'notFixed', 'filesTouched'],
}

phase('Build')
const [pipeline, gate] = await parallel([
  () => agent(`${RULES}
## Your task: an INACTIVE, environment-driven signing pipeline + post-signing hash re-pinning
You own electron-builder.yml, scripts/sign-windows.mjs (new), scripts/sign-windows.test.mjs (new), src/main/bridge/launcher.ts and its colocated tests, and whatever file holds the runtime SHA-256 pins of the bundled executables (find it: the bridge pin AC23221E... is verified before every spawn; llama-server / whisper-cli are verified via their manifests).
1. **Off by default.** With no WCA_SIGN_MODE set, the build output must be byte-identical to today's (unsigned), and every existing test and the packaged smoke must stay green.
2. **When enabled** (WCA_SIGN_MODE = 'signtool-cert' for a Trusted Root Program certificate available to signtool on this PC - e.g. a cloud-held key exposed through the CA's virtual smart card such as Certum SimplySign - selected by WCA_SIGN_CERT_SHA1 thumbprint; or 'azure' for Azure Artifact Signing with WCA_AZURE_ENDPOINT / WCA_AZURE_ACCOUNT / WCA_AZURE_PROFILE / WCA_SIGN_PUBLISHER), sign EVERY PE file that ships: the app exe, every .exe and .dll under resources (bridge, llama, whisper, elevate), the NSIS installer and the uninstaller, SHA-256 digest, RFC 3161 timestamp (WCA_SIGN_TIMESTAMP_URL, documented default). Use electron-builder's supported hooks (check the INSTALLED electron-builder version's docs/types in node_modules, not memory; win.signtoolOptions / azureSignOptions / a custom sign function). Refuse to run (clear error) if the mode is set but its variables are missing. Never let signing failure produce a partially signed tree silently.
3. **Re-pinning:** signing changes the bytes of whatsapp-bridge.exe, llama-server.exe and whisper-cli.exe, so their runtime SHA-256 pins would break. Keep the ORIGINAL pins as the provenance check at import/fetch time, and have the build write the POST-signing hashes into the packaged pin file the launcher verifies at runtime (e.g. resources/bridge/SHA256SUMS gains a signed entry), so an unsigned build verifies against the original pin and a signed build against the signed one - and a tampered file fails in both. The launcher must never accept "any signed file"; it is still an exact hash match.
4. Unit-test the signing plan with a fake signer (which files, which order, refusal on missing variables, off-by-default no-op) and the launcher's pin selection. Run npm run lint, npm run typecheck, npx vitest run, and npm run test:smoke with signing OFF. Write ops/agent-notes/signing-pipeline.md including the exact env variables for README.`,
    { label: 'signing-pipeline', phase: 'Build', schema: SCHEMA, effort: 'high' }),
  () => agent(`${RULES}
## Your task: a Microsoft Defender scan gate + a false-positive submission guide
You own scripts/defender-scan.mjs (new), scripts/defender-scan.test.mjs (new), scripts/smoke-packaged.mjs (add ONE optional stage only - another agent owns signing; coordinate through your notes), the package.json scripts block (add "test:defender"), and docs/WINDOWS-SECURITY.md (new).
1. scripts/defender-scan.mjs: run "%ProgramFiles%\\Windows Defender\\MpCmdRun.exe" -Scan -ScanType 3 -File <path> -DisableRemediation on dist/win-unpacked and, when present, the NSIS installer in dist/. Parse the exit code and output: 0 = no threats, 2 = threats found (fail, print the detection names), anything else = scan could not run (distinct exit code, never reported as clean). Use child_process with array argv, shell:false. Never pass -Restore, never add exclusions, never change Defender settings. Report per-file Authenticode status as information (Get-AuthenticodeSignature via powershell -NoProfile with array argv): today every file is expected NotSigned - that is not a failure while signing is off (D-078), but when WCA_SIGN_MODE is set, any non-Valid status is a failure.
2. Unit tests with a fake MpCmdRun (injected runner) for clean / threat / cannot-run / timeout.
3. Build the unpacked tree (npm run pack:dir) and the NSIS installer FILE (npx electron-builder --win --x64), then run the gate for real on both and record the true result in your notes. Do NOT run the installer or the app.
4. docs/WINDOWS-SECURITY.md for the user: what Smart App Control, SmartScreen and Defender antivirus each check; why self-signing does not satisfy Smart App Control; the certificate options with 2026 facts from ops/DECISIONS.md D-078 (Certum Open Source cloud, commercial OV cloud, Azure Artifact Signing for organisations; EV gives no SmartScreen advantage since 2024); how to enable signing with the env variables (read ops/agent-notes/signing-pipeline.md when it exists; otherwise leave a clearly marked section for the orchestrator); how to submit a false positive to Microsoft Security Intelligence as a software developer. No user secret, PIN or thumbprint in the file.
Run npm run lint, npm run typecheck, npx vitest run. Write ops/agent-notes/defender-gate.md.`,
    { label: 'defender-gate', phase: 'Build', schema: SCHEMA, effort: 'high' }),
])

phase('Review')
const review = await agent(`${RULES}
## Your task: ADVERSARIAL check of the signing pipeline and the Defender gate (edit NOTHING; write ops/agent-notes/signing-review.md)
Read ops/agent-notes/signing-pipeline.md and defender-gate.md and the code they touched. Try to break it: can the default (unsigned) build differ from before? Can a signed build ship a file whose runtime pin still matches the UNSIGNED hash, or a launcher that accepts any signed file? Can a partially signed tree pass? Can the Defender gate report "clean" when the scan did not run, timed out or found nothing because the path was wrong? Is any secret, PIN, thumbprint or credential written to disk, logs or argv? Does anything touch certificate stores or Defender settings? Report concrete findings with file:line and a fix; say plainly when you find nothing.`,
  { label: 'signing-review', phase: 'Review', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, where: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } }, required: ['severity', 'where', 'problem', 'fix'] } } }, required: ['findings'] }, effort: 'high' })

let fix = null
const serious = review ? review.findings.filter(f => f.severity !== 'minor') : []
if (serious.length) {
  fix = await agent(`${RULES}
## Your task: fix the confirmed signing/Defender-gate findings (you may edit the files the two build agents touched; record every edit)
${serious.map((f, i) => `${i + 1}. [${f.severity}] ${f.where}: ${f.problem}\n   FIX: ${f.fix}`).join('\n')}
Failing test first for each. Run npm run lint, npm run typecheck, npx vitest run, npm run test:smoke (signing off). Write ops/agent-notes/signing-fix.md.`,
    { label: 'signing-fix', phase: 'Review', schema: SCHEMA, effort: 'high' })
}

phase('Prove')
const proof = await agent(`${RULES}
## Your task: PROVE the pipeline - edit NOTHING except ops/agent-notes/signing-proof.md and its output dir
Run, capturing output under ops/agent-notes/signing-proof/: npm run lint; npm run typecheck; npm run format:check; npx vitest run (passed count); npm run build:e2e then npm run test:e2e (passed / failed / flaky); npm run test:smoke; npm run test:defender (on the unpacked tree and the installer file - true result, detection names if any); npm run audit:prod. Report true exit codes; a pass on retry is flaky, not green. Confirm every packaged PE file reports NotSigned (expected with signing off) and that no WCA_SIGN_* variable is set in this environment.`,
  { label: 'signing-proof', phase: 'Prove', schema: { type: 'object', properties: { lint: { type: 'number' }, typecheck: { type: 'number' }, format: { type: 'number' }, unitPassed: { type: 'number' }, unitFailed: { type: 'number' }, e2ePassed: { type: 'number' }, e2eFailed: { type: 'number' }, smoke: { type: 'number' }, defender: { type: 'string', description: 'clean | threats: <names> | could not run: <why>' }, audit: { type: 'number' }, allGreen: { type: 'boolean' }, failures: { type: 'array', items: { type: 'string' } } }, required: ['lint', 'typecheck', 'format', 'unitPassed', 'unitFailed', 'e2ePassed', 'e2eFailed', 'smoke', 'defender', 'audit', 'allGreen', 'failures'] }, effort: 'medium' })

return { pipeline, gate, review: review ? review.findings : null, fix, proof }
