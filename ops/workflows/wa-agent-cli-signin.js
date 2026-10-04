export const meta = {
  name: 'wa-agent-cli-signin',
  description: 'Guided CLI sign-in session + Antigravity effort/classification fixes (D-080), leftovers (signing docs, README v2, Defender in verify, flake, settings guard), e2e, final proof',
  phases: [
    { title: 'Build', detail: '3 parallel agents: CLI main side, CLI renderer side, leftovers' },
    { title: 'E2E', detail: 'sign-in flow + Antigravity model case + full run' },
    { title: 'Prove', detail: 'final full pipeline incl. Defender gate' },
  ],
}

const ROOT = 'C:\\dev\\whatsapp agent'

const RULES = `
## Project: "WhatsApp Calendar Agent" (Electron + TypeScript, Windows 11) at "${ROOT}" (path has a space - always quote it). v1 + v2 are built, reviewed, closed out; e2e is 47/47. The user is now using the app live on this PC.
### Read first
ops/DECISIONS.md **D-080** (the live diagnostic and its decisions) and D-078/D-079; ops/PROGRESS.md entries 67-70; docs/ARCHITECTURE-v2.md B12-B14 (CLI providers) and B26/I11 (job rules, sandbox proof); docs/specs/v2-contracts.md (ErrorCode, IPC, CliStatus).
### What the live diagnostic proved (D-080)
- Claude Code: the run printed system/init (apiKeySource "none", tools [StructuredOutput]), then an assistant event with error "authentication_failed" and a result with is_error true: "Failed to authenticate: OAuth session expired and could not be refreshed". The app's CLI_NOT_SIGNED_IN was correct - but the Connect card still said "signed in" (the status probe is cached / reads only loggedIn), and the error card offered no way to sign in.
- Antigravity 1.2.16: with argv "--model gemini-3.8-flash-high --effort low" it prints on stderr "error: invalid model selection (--model \\"gemini-3.8-flash-high\\" --effort \\"low\\"): --model gemini-3.8-flash-high conflicts with --effort=low", exits 1, and its FIRST stdout event is {"event":"result", ...} with keys conversation_id, status, response, error, duration_seconds, num_turns, usage - no init event. The app reported that as CLI_TOOLSET_MISMATCH reason no_init ("changed in a way the app does not recognise"), which is wrong and unhelpful. agy --help documents --input-format/--output-format stream-json, --json-schema, --agent, --print-timeout, --disable-slash-commands; the documented init event is {"event":"init","conversation_id":...,"init":{"cwd","tools","permission_mode"}} (no "agent" field is documented - do NOT relax the init proof on a guess; if the real init lacks "agent", that is for a later M-AGY-1 decision; record what you would need).
### Hard rules (a violation ends the operation)
- NEVER run claude.exe, agy.exe, whatsapp-bridge.exe, llama-server.exe, whisper-cli.exe or the packaged app; NEVER sign in, read or copy CLI credentials or config of the user (%USERPROFILE%\\.claude, %USERPROFILE%\\.gemini, Credential Manager). Tests use the fakes (tests/fakes/fake-claude-cli.mjs, fake-agy.mjs) and the S-CONSOLE seam.
- NEVER touch the user's live app data (C:\\Users\\ilay1\\AppData\\Roaming\\WhatsApp Calendar Agent) or the reference bridge store. NEVER change Windows security settings.
- The sign-in console is the vendor CLI's OWN login, in a VISIBLE window, launched by spawning the validated exe directly (never cmd.exe, never a shell - F7). The app never sees, reads, stores or forwards a password, token or code.
- The init proof (I11) stays fail-closed: no run is ever "proven" with less evidence than today; an error-before-init is a classified FAILURE, never a pass.
- No new npm dependency, no version change, no git commit. Every PowerShell command starts with: $env:PATH = "C:\\Program Files\\nodejs;C:\\Program Files\\Git\\cmd;" + $env:PATH
- Notes: ops/agent-notes/<your-label>.md. Never edit another agent's notes, ops/PROGRESS.md, ops/BOARD.md or ops/DECISIONS.md. Failing test FIRST; a red test is reported, never weakened.
### Shared contract for this round (both CLI agents code to it)
- New ErrorCode **'CLI_MODEL_REJECTED'**: the CLI refused the selected model / flag combination. Action: 'choose_model' (the renderer focuses the model dropdown). The main agent adds it to src/shared/errors.ts (and wherever ErrorCode enums / action maps / parity tests require); the renderer agent adds its en/he locale strings under errors.CLI_MODEL_REJECTED.{title,body,action}.
- CliStatus gains (or reuses) a sign-in session state the renderer can show: 'idle' | 'open' (console window open) | 'retesting' | 'done', plus the last test outcome. Main owns the shape (src/shared/types.ts / ipc.ts); keep it backward compatible.
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
const [cliMain, cliRenderer, leftovers] = await parallel([
  () => agent(`${RULES}
## Your task: the MAIN side (you own src/main/llm/cli/**, src/main/ipc/handlers/cli.ts, src/main/ipc/handlers/llm.ts, src/main/llm/factory.ts, src/shared/errors.ts, src/shared/types.ts, src/shared/ipc.ts, tests/fakes/fake-claude-cli.mjs, tests/fakes/fake-agy.mjs and their tests)
1. **Antigravity effort conflict:** never pass --effort when the model slug already carries an effort suffix (e.g. -low / -medium / -high, as reported by agy models). Derive it from the slug, test both shapes. Teach fake-agy to reject --effort combined with a suffixed slug exactly as the real 1.2.16 does (stderr line + exit 1 + a first-event {"event":"result"} with an error), so the regression is pinned.
2. **Error before init:** when the first event is NOT an init (agy {"event":"result"...} with an error, or Claude result/assistant error before init), classify it by the error text: model / flag rejection -> CLI_MODEL_REJECTED; authentication -> CLI_NOT_SIGNED_IN; quota -> the existing quota codes; anything else -> a NOT-toolset error (e.g. CLOUD_UNAVAILABLE). Keep reason no_init for a stream that has no recognisable event at all. Never proven, never a retry with looser flags. Read the stderr lines the runner already collects (marker-only redaction rules of B26 still apply - nothing raw is logged; record only the classified reason in the audit).
3. **Guided sign-in session (user request):** cli:signIn opens the CLI's own login in a visible console in the SAME environment the app's runs use: Claude = the validated claude.exe with "auth login --claudeai" and the run profile vars; Antigravity = the validated agy.exe interactive login with the ISOLATED agy-home profile env (planAgyHome) and cwd inside agy-home, so the sign-in lands where the runs look. Track the console process: when it exits, invalidate the CLI status cache, re-probe status, and automatically re-run that provider's smoke test once; push the session state ('open' -> 'retesting' -> 'done' with the outcome) to the renderer through the existing push channel. One session per provider at a time; a second click focuses the existing state instead of opening another window. Nothing about credentials is ever read by the app.
4. **Stale "signed in":** after a run or test ends in CLI_NOT_SIGNED_IN, the cached status must flip to not signed in at once (the Connect card must stop saying "signed in"). A status of "unknown" must surface as "Could not tell whether you are signed in" (B13), not as "not signed in" - check llm.ts NOT_SIGNED_IN mapping of 'unknown'.
Run npm run lint, npm run typecheck, npx vitest run (all projects). Do NOT run e2e.`,
    { label: 'cli-signin-main', phase: 'Build', schema: SCHEMA, effort: 'high' }),
  () => agent(`${RULES}
## Your task: the RENDERER side (you own src/renderer/**, src/shared/locales/**, src/shared/i18n/**)
1. The CLI error card (screenshots: "Claude Code is not signed in" / "Antigravity changed in a way the app does not recognise", each showing only "Still using: On this computer") must ALWAYS carry its one action: for CLI_NOT_SIGNED_IN a **Sign in** button (cli:signIn for that provider); for CLI_MODEL_REJECTED **Choose another model** (focus the model dropdown); for the others their existing action.
2. The guided sign-in session UI on the Connect card: after "Sign in", show "A sign-in window opened. Finish signing in there - the app will test again when it closes." Then "Testing..." and the outcome, driven by main's pushed session state (main is being built in parallel to the contract in the task header; code to it). After a CLI_NOT_SIGNED_IN result, never keep showing "signed in" in the status line.
3. Locale strings in en and he (natural Hebrew) for every new string and for errors.CLI_MODEL_REJECTED.{title,body,action}; key parity tests green.
4. Also: "Delete all data" must clear the renderer's wca.voiceIntent entry (closeout-renderer REQUEST).
Failing test first; run npx vitest run --project renderer, npm run lint, npm run typecheck.`,
    { label: 'cli-signin-renderer', phase: 'Build', schema: SCHEMA, effort: 'high' }),
  () => agent(`${RULES}
## Your task: leftovers (you own README.md, docs/WINDOWS-SECURITY.md, the package.json scripts block, src/main/ipc/handlers/settings.ts + its tests, src/renderer/src/components/UndoDismissDrawer.test.tsx)
1. docs/WINDOWS-SECURITY.md section 3 still has a "TO BE COMPLETED BY THE ORCHESTRATOR" placeholder: fill it from ops/agent-notes/signing-pipeline.md and signing-fix.md (exact env variables, the Trusted Root Program requirement, Smart App Control facts of D-078, that signtool / the Windows SDK is not installed on this PC). No secret, PIN or thumbprint of the user.
2. README.md: v2 is now built - move the shipped v2 features from "Roadmap (v2, in development)" into "Features" (event editing + undo, automatic mode and its rails, Claude subscription via Claude Code, Gemini via Antigravity experimental, read-only WhatsApp tools, local voice notes, events from pictures), keep the honest limits (automatic edits and media-derived automatic events wait for M-GOLDEN-1; Smart App Control blocks the unsigned build - see docs/WINDOWS-SECURITY.md), add a short "Code signing and Windows security" section and a "Signing in to Claude Code / Antigravity" note (the app opens the CLI's own login; Claude sessions can expire), update test counts only to numbers you can cite from ops/PROGRESS.md, and set the licence section to MIT (LICENSE exists). Never add a phone number, token, real message text or personal e-mail. Also set "license": "MIT" in package.json.
3. Add test:defender to the npm "verify" chain after test:smoke.
4. UndoDismissDrawer.test.tsx fails when run just after local midnight ('today' built as now minus 1 h): pin the clock so it is time-of-day independent, without weakening what it asserts.
5. settings:set has no guard on readTools.enabled when the stored scope is all_chats (ux-i18n-v2-5): turning read tools back on must not silently re-widen to all chats without the native confirmation of wa:setReadScope - add the guard with a failing test first.
Run npm run lint, npm run typecheck, npm run format:check, npx vitest run.`,
    { label: 'cli-leftovers', phase: 'Build', schema: SCHEMA, effort: 'high' }),
])

phase('E2E')
const e2e = await agent(`${RULES}
## Your task: e2e for this round + full run (you own tests/e2e/**, playwright.config.ts)
Read ops/agent-notes/cli-signin-main.md and cli-signin-renderer.md. Add specs with the fakes and the S-CONSOLE seam: (a) Claude test fails with an expired session -> the error card shows Sign in -> the recorded console command is claude.exe auth login --claudeai (never cmd.exe) -> when the fake console exits the app re-tests automatically and shows Ready; (b) Antigravity with an effort-suffixed model -> the argv has no --effort and the test passes; with a rejected model the card shows CLI_MODEL_REJECTED with Choose another model, never "changed in a way the app does not recognise"; (c) the Antigravity sign-in console runs with the isolated agy-home profile env. Then npm run build:e2e and npm run test:e2e: report passed / failed / flaky and the root cause of every failure.`,
  { label: 'cli-signin-e2e', phase: 'E2E', schema: { type: 'object', properties: { status: { type: 'string', enum: ['done', 'partial', 'blocked'] }, e2ePassed: { type: 'number' }, e2eFailed: { type: 'number' }, e2eFlaky: { type: 'number' }, failures: { type: 'array', items: { type: 'string' } } }, required: ['status', 'e2ePassed', 'e2eFailed', 'failures'] }, effort: 'high' })

phase('Prove')
const proof = await agent(`${RULES}
## Your task: FINAL PROOF - edit NOTHING except ops/agent-notes/final-proof-v2.md and its output dir
Run in order, each captured under ops/agent-notes/final-proof-v2/: npm run lint; npm run typecheck; npm run format:check; npx vitest run (passed count) TWICE in a row; npm run build:e2e then npm run test:e2e (passed / failed / flaky); npm run pack:dir then npm run test:defender (true result on the unpacked tree; build the NSIS installer FILE with npx electron-builder --win --x64 and scan it too - never run it); npm run audit:prod. Do NOT run npm run test:smoke (it starts the packaged exe, which Smart App Control blocks on this PC and which this phase may not run) - report it as "not runnable here (R11)". Report true exit codes; a pass on retry is flaky, not green.`,
  { label: 'final-proof-v2', phase: 'Prove', schema: { type: 'object', properties: { lint: { type: 'number' }, typecheck: { type: 'number' }, format: { type: 'number' }, unitRun1: { type: 'string' }, unitRun2: { type: 'string' }, e2ePassed: { type: 'number' }, e2eFailed: { type: 'number' }, e2eFlaky: { type: 'number' }, defender: { type: 'string' }, audit: { type: 'number' }, allGreen: { type: 'boolean' }, failures: { type: 'array', items: { type: 'string' } } }, required: ['lint', 'typecheck', 'format', 'unitRun1', 'unitRun2', 'e2ePassed', 'e2eFailed', 'defender', 'audit', 'allGreen', 'failures'] }, effort: 'medium' })

return { cliMain, cliRenderer, leftovers, e2e, proof }
