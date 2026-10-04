# V2-W2-01-compose - builder notes

Package: `V2-W2-01-compose` (Wave 2, first). Brief: `docs/specs/v2-build-plan.md` section 7 `### V2-W2-01-compose`; fix round driven by
`ops/agent-notes/v2-wave1-audit.md` (section 3.3 class (c) list + the golden.v2 collection gap). Date: 2026-09-29.

## Status

DONE for everything attributed to this package. Repo-wide at hand-off: `npm run lint` exit 0, `npm run typecheck` exit 0,
`npm run build` exit 0 (production `out/main/*.js` free of every seam string, see below). `npm test` (main + renderer + integration +
security): 7146 tests, **3 red, all in V2-W2-02-owned security files** (REQUESTS 1-2 below) - main 4707 (incl. the one deliberate
`it.fails` of R-PROMPT-SIZE), renderer 1017, integration 382 (incl. `golden.v2.test.ts` 84), security 1040 with 3 failures.

Every audit item attributed to me is green: pipeline-edit 9/9 (incl. self trigger), editing-executor 4/4, recovery-v2, auto-mode.flow 2/2,
security auto-mode.injection-corpus Part B, cli-provider part B, pipeline-image Part B 5/5, pipeline-voice Part B 2/2, pipeline-wa-tools
4/4, `golden.v2.test.ts` now collected and 84/84 green (parts 1, 2a, 2b on BOTH CLI fakes, 3, 4).

## What compose() wires now (src/main/compose.ts)

- JobRunner (`createJobRunner`, S-JOB via optional `ComposeDeps.jobProc`), handed to the Supervisor (`jobs`) and to the quit sequence
  (`killJobs` BEFORE `stopChildren`, B2). Reaper roots = `childAndJobExeRoots(paths)`; `acceptedCliExePaths` = the values of
  `meta.cli_exe_paths_json` (written by the factories' `onLocated`, B31); the e2e whisper seam command joins the execPath list.
- CLI: `createCliRunner` (budget = `rate` bucket `cli_global` + `settings.llm.cli.maxRunsPerHour`, `allowOverage`, `argsPrefix` from the
  WCA_CLI_CMD seam, `graceMs` from `WCA_TIMERS.jobGraceMs.cli`, `processEnv` = `ComposeDeps.cliEnv ?? process.env`), `createCliLocator`
  (S-LOCATE = `ComposeDeps.locate ?? {fs stat, process.env, where.exe - never in e2e}`, seam = `seams.cliCmd` whenever seams exist),
  `createCliStatus` (cache `WCA_TIMERS.cliStatusCacheMs ?? LIMITS.cliStatusCacheMs`), `makeClaudeCliFactory` / `makeAgyFactory`
  (`onLocated`, `onSmoke` -> `cliStatus.recordTest` + `cli:changed`, `onQuota` -> `recordQuota` + `HealthHub.setLlmQuota` + `cli:changed`),
  the per-run loopback tool server (`startToolServer`), factory deps `makeClaudeCli/makeAgy/cliStatus/jobs/now`.
- Calendar: `createMcpHost({onUpdateSurface -> HealthHub.setCalendarUpdates + auto:changed})`, `createGoogleAuth({persistCalendarRoles ->
  meta.calendar_roles_json})`, `calendarRoles = parseCalendarRolesJson(meta)`, `updateSurfaceAvailable = host.updateSurface().available`.
- WhatsApp read tools: `waAvailable = settings.whatsapp.readTools.enabled && bridgeDb.open()`.
- Media: one `createBridgeReadClient` for `media/fetch.ts` (virtual-clock sleep for the retry), `createImageNormalizer` over
  `ComposeDeps.image` (S-IMAGE; absent => an always-empty facade = every picture rejected, fail closed), `createMediaCache`
  (`<userData>\media-cache`, sha256 names), `createPickImage` (+ `alreadyRead` from `proposals.image_json`, + links the cached row to the
  chat's open item so Dismiss / retention can delete it), `createReadImageStage` (consent at the current version via
  `CONSENT_KIND_FOR`, Local route = `mmprojReady` = pictures on + the resolved tier's model AND projector ready; Local provider = the seam
  provider when one is injected, else `makeLocal()`), llama runtime `imagesEnabled` / `mmprojPath`.
- Voice: `createVoiceService` (`models.pathOf = modelManager.readyPath`, `window = mediaWindowFor`, `whisperSeam` from `seams.whisperCmd`;
  e2e without it => `null` = voice disabled), `voice:progress` push, Stage0 `voiceReady`, `onTranscribing` -> `queue:changed.transcribing`
  + `HealthHub.setVoice`, onboarding checklist `voice` / `voicePercent`.
- Automatic mode: executor v2 deps (`updateSurfaceAvailable`, `autoGate: evaluateAutoGate`, `snapshotSha`, `notifyAuto`, `randomUuid`,
  `featureGates: FEATURE_GATES`, `calendarRoles`), `createAutoDialog({showMessageBox: ComposeDeps.dialog (absent => Cancel), t,
  script: seams.dialogScript})`, `createAutoPolicyService` (+ `calendarConnected`, `versions`, `lastFocusAt`, `onAppPause`, `onExpiring`),
  `createUndo({windowState})`, a 10-minute `autoPolicy.tick(now)` timer, `emitAutoChanged()` (AppHealth.auto + `auto:changed` from the
  service's own state), Notifier `onUndo` (toast action 0 -> `executor.undoAuto(id,'user_toast',null)`), `onShow`,
  `notifyWithActions` (`ComposeDeps.notifyWithActions`), `TrayState.auto`, `trayAuto()` for the tray line.
- Orchestrator v2 deps: `voice`, `readImage`, `pickImage`, `tryAuto: (id) => executor.tryAuto(id)`, `onTranscribing`, `featureGates`,
  `updateSurfaceAvailable`, and the new `audioWindow` (see fix-ups).
- ItemService: `updatesAvailable`, `mediaCache`. Handlers: the 13 groups assembled with `mergeHandlerGroups` (register.handlers.ts) so
  the union is asserted to be exactly IPC_CHANNELS, with every v2 collaborator (`HandlerDepsV2`, items `{undo}`, settings `{voice,
  autoDialog, dialogParent}`, llm `{cliStatus, listAgyModels}`, data `{autoPolicy}`, auto `{dialogParent}`, cli extras incl.
  `makeAgyForTest`, `pickExePath`, `homeDir`, `agyRunning`, `agySettingsExists`). `wave0HandlerDepsV2` is gone; `item:dismiss` also
  deletes the item's cached picture (B19). `cliConsole` = `ComposeDeps.console ?? (e2e ? argv recorder : createOpenVisibleConsole)`.
- Startup: a third, READ-ONLY reconcile pass runs once the calendar child is connected (the first two run before any child exists, so a
  calendar-side `unknown_outcome` could never be read at startup - crash_after_patch stayed unknown). `offerRetryForUnknown()` moved after
  it. Retention now unlinks the purged `media_cache` files (W1-01 REQUEST 3).
- `AppRuntimeEvent` += `'auto:changed' | 'cli:changed' | 'queue:changed' | 'voice:progress'` (named after their IpcEvent);
  `AppRuntimeHandle` += `jobPids()`, `dialogs()`, `consoles()`, `trayAuto()`, `noteFocus()`. `ComposeDeps` += optional `jobProc`,
  `locate`, `cliEnv`, `home`, `agyRunning`, `pickExePath`, `notifyWithActions` (all additive; absent => production value).
- `index.ts`: the four v2 push events, the real `nativeImage` facade, `dialog.showMessageBox` parented to the main window, toasts with
  action buttons (e2e: recorded with `actions`), `pickExePath` (open dialog returning a PATH), window `focus` -> `noteFocus`, tray
  `onAuto`, `installTestHooks(v1, {dialogs, consoles, jobPids, trayClickAutoPause})`.

## Harness v2 (tests/helpers/harness.ts)

Options `provider` (all five ids), `cli` (`claude` / `agy` state + script), `whisper` (mode + transcripts; seeds the default voice tier
+ VAD as ready at the ModelManager's own file names with the GGML magic), `waWorld` (`seedWaWorld(bridge.db, app.repos, {nowMs})` after
the fake bridge starts), `media` (`bridge.setMedia`). The CLI / whisper fakes run exactly in the validated WCA_CLI_CMD / WCA_WHISPER_CMD
shape (system `node.exe` + `tests/fakes/<fake>.mjs` ... `--fake-end`), under a fake home in the temp userData (T8 / T9); `locate` is a
stub that never touches the disk or PATH. Handles: `cliJournal()`, `whisperJournal()`, `dialogs` (= `autoDialog.recorded()`),
`toolServers` (via `setToolServerListenerRegistry`, also into the T7 leak registry), `jobs()`. `settle()` / `invoke()` yield REAL time
(bounded, ~15 s) only while a spawned fake job is live, without moving the virtual clock. The electron mock provides S-DIALOG
(`dialog.__script`), toast actions (`Notification.__emitAction`) and S-IMAGE. Profile seeding: CLI consents at the current version
(agy with the terms date), `meta.calendar_roles_json = {primary: owner}` for a connected calendar. Ledger sources += `mediaRequests`,
`fakeJournals`, `userDataDir` (+ `sweepExcludeDirs: ['wca-fakes']`), `toasts`; the fake journals are checked for violations in
`dispose()` BEFORE the temp userData is removed (otherwise the cli-fakes-hook would find no file and check nothing).

## Fix-ups outside compose/harness (fix-up right, integration bugs) - per file and reason

- `src/main/exec/actionExecutor.ts` (W1-04) `reject()`: F32 / C2 5 - a rejected `update_event` sets the delta item's
  `event_state = 'declined'` in the same transaction (was missing; pipeline-edit "reject" red).
- `src/main/agent/orchestrator.ts` (W1-03): (1) optional dep `audioWindow` (compose passes `mediaWindowFor`): `contextFor` omits every
  audio row without a done transcript (C2 12), so `pendingAudio` was always false and V0 never ran; (2) the window is re-read after V0
  so the freshly transcribed note is a trigger (was: `triage_not_needed`).
- `src/main/proc/jobRunner.ts` (W1-06): comment wording only - the string `fake-claude-cli` in a comment reached `out/main/index.js`
  (the seam-string scan of the production build must be empty).
- `vitest.config.ts`: `tests/golden/golden.v2.test.ts` in the integration include (W1-03 REQUEST 1).
- `.gitignore`: `store/` -> `/store/` + `**/whatsapp-bridge/store/` + `vendor/**/store/` (W1-12 finding: the bare rule hid
  `src/renderer/src/store/`). **Orchestrator: `src/renderer/src/store/*.ts` now show as untracked - stage them after the push scan.**
- Locales: `src/shared/locales/pending/V2-W1-11-renderer-dashboard.json` folded into `en.json` / `he.json` (4 keys each, nothing else
  changed); `pending/` deleted. `src/main/notImplemented.ts` deleted (no importer left anywhere).

## Test fix-ups (tests/integration/** + golden.v2.test.ts; each carries a `[V2-W2-01]` comment)

- `pipeline-edit.test.ts`: the setup's own "hey" moved before `live_from` (a LIVE own message with an existing event is itself an F28
  self trigger, which doubled every run); the fake calendar's copy of the seeded event gets the app's identity tags (F27 ownership -
  otherwise the pre-flight correctly answers CAL_EVENT_FOREIGN); the approve request carries `kind: 'update_event'` (the strict schema
  refused it as BAD_REQUEST).
- `recovery-v2.test.ts`: the restarted app talks to a calendar holding the SAME events (the Google calendar outlives the app).
- `auto-mode.flow.test.ts`: every message asks for its own slot (a second "Dentist at 15:00" is a genuine free/busy conflict -> amber
  `conflict` -> AutoGate `badge_amber`); no re-sent "hey" into a chat that already has an event (F28 self trigger); 60 s timeout for the
  7-virtual-day test.
- `pipeline-states.test.ts`: 60 s timeout for the 8-virtual-day test (13.5 s under load already at the audit; the 20 s default made it
  flaky under the parallel run).
- `pipeline-failures.test.ts`: I2 now asserts "no CALENDAR tool without a calendar; S1 never gets a tool" - the wa_* read tools (B17)
  do not depend on the calendar.
- `cli-provider.test.ts` part B: the locator's `--version` / `auth status` probes (constant argv, no data) precede the smoke; the
  assertion is "the first prompt-carrying invocation is the smoke".
- `pipeline-voice.test.ts` / `pipeline-image.test.ts` Part B: the contact is known (a fresh profile holds unknown senders, A11), voice
  reads the chat's newest item (the default script closes it `not_needed`), pictures on the Local route get the projector marked ready
  (B19), `model:getPlan` is called with `undefined` (NoReq).
- `golden.v2.test.ts` part 3: track record (three click-approved creates in other chats) + the scripted native dialog before
  `auto:requestEnable`; the frozen C2 `AutoScope` shape (`DEFAULT_AUTO_SCOPE`); `gateAdjusted()`: the FIRST failing reason in C2's
  AUTO_REASONS order is expected when D-068 (every golden gate false => an automatic `update_event` falls back `low_confidence`) or
  B28 (S4 taints a `manipulation` chat => `chat_tainted` before `badge_red`) ranks earlier than the row's own reason. When
  M-GOLDEN-1 records `editsPassed: true` the rows' own reasons apply unchanged.

## Verification (2026-09-29, after the last edit)

| Command | Result |
|---|---|
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0; `out/main/*.js`: 0 hits for WCA_E2E, WCA_BRIDGE_CMD, WCA_LLM, WCA_CLI_CMD, WCA_WHISPER_CMD, WCA_DIALOG_SCRIPT, WCA_FAKE, WCA_MCP_CMD, WCA_LLAMA_CMD, WCA_TIMERS, WCA_NOW, __wcaTest, stub-llm, fake-claude-cli, fake-agy, whisper-cli.mjs, scripted.fixtures (the `.js.map` keeps sources, as in v1) |
| `vitest --project main renderer integration security` | 309 files, 7146 tests, 3 failed (all V2-W2-02 security files, REQUESTS 1-2) |
| prettier --check on every file I wrote | clean |

No binary, fetch or network; only the `.mjs` fakes under the system node.exe. The reference bridge store and the user's vendor-CLI state
were never touched.

## Assumptions / decisions

- The L3 harness reaches the CLI / whisper fakes through the validated command seams (`seams.cliCmd` / `seams.whisperCmd`, the e2e
  shape) instead of a spawn redirect: production modules unchanged, locator probes and job env built exactly as in e2e.
- `golden.v2.test.ts` is treated as inside my fix-up right (my brief's acceptance names it; it is collected by the integration project).
- `snapshotSha` uses the wizard's last known account e-mail (`googleAuth.wizardState().accountEmail`, '' when unknown). See REQUEST 4.
- `calendarName` for the enable dialog is '' (no calendar display name is stored main-side). See REQUEST 5.

## REQUESTS

1. **V2-W2-02** (`tests/security/approval-binding.test.ts` "only `ui:navigate` is ever pushed ..."): the allowed push list is the v1
   AppRuntimeEvent set; C2 8 adds four push events and compose now emits them (`auto:changed` at start / on settings changes,
   `queue:changed` on every queue stats change). Add `'auto:changed', 'cli:changed', 'queue:changed', 'voice:progress'` to the list
   (a tray click still produces no side effect - the bridge-sends assertion is unchanged).
2. **V2-W2-02** (`tests/security/injection-corpus.test.ts`, 2 cases `*-image-text-reply-confirmed`): the harness runs the attacker as
   provider `local` and `NEVER_PROVIDER_ROUTE` contains `local`, so the picture is read only on the Local route, which needs the
   projector (B19) - the app correctly never reads it. Either mark the tier + projector ready in the models table (see
   `projectorReady()` in `tests/integration/pipeline-image.test.ts` Part B) or run the case as provider `claude` (images.cloud is on by
   default, the harness seeds the consent).
3. **Orchestrator** - W0 REQUEST 2 (prettier over the C2-verbatim `src/**` files) is still open; I formatted only the files I wrote.
4. **Orchestrator / C2** - `AutoSnapshotInput.googleAccountEmailSha8` has no persisted source: the wizard knows the e-mail only after a
   `manage-accounts list` poll in this session, so after a restart the snapshot can differ from the one recorded at enable time and the
   policy pauses `snapshot_changed` (fail-safe, but noisy). Suggest a meta key (e.g. `google_account_sha8`) written by googleAuth.
5. **Orchestrator / UX** - the enable dialog's `calendarName` is '' (no display name is stored main-side); a meta key or the
   calendar list cache could provide it.
6. **V2-W1-10 / V2-W1-04** (carried from the audit, not blocking a test now): relax `item:undoChange` / `undoViewOf` to "the item
   carries this event" (W1-04 REQUEST 2).

## BLOCKED-BY

None for my files. Red at hand-off: the three security tests of REQUESTS 1-2 (owner V2-W2-02).

## Dead ends / lessons

- Bash heredocs choke on some backtick / `${}` mixes inside patch scripts; patch scripts went through the Write tool into the scratchpad.
- `console.log` from a test is swallowed by the setup; debugging went through a deliberately failing `expect(...).toBe(null)` in a
  throw-away scratch test (deleted).
- The integration `afterEach` order: a test file's own hooks run before the setup-file hooks, so anything a hook must read has to
  outlive `dispose()` - hence the journal check inside `dispose()`.

## Re-verification (retry run, 2026-09-29)

The package's work was already complete on disk; the retry changed no source file and re-ran the acceptance commands:
`npm run lint` exit 0, `npm run typecheck` exit 0, `npm run build` exit 0 (seam-string scan of `out/main/*.js` empty, no
`NotImplementedError` anywhere in `src/`), `npm test` 309 files / 7146 tests: 7142 passed, 1 expected fail (R-PROMPT-SIZE `it.fails`),
**3 failed - the same three V2-W2-02-owned security tests of REQUESTS 1-2** (`approval-binding.test.ts` push list;
`injection-corpus.test.ts` en/he `*-image-text-reply-confirmed`).
