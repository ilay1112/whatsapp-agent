# V2-W1-12-renderer-settings - builder notes

Package: `V2-W1-12-renderer-settings` (Wave 1 of v2). Brief: `docs/specs/v2-build-plan.md` section 7.
Status: **DONE** (2026-09-29). This run continued an interrupted attempt: deliverables 1-2 and large parts of 5/6
(ConnectCard, ConsentDialog, HealthPill, DownloadPill, SetupStrip, store/cli, store/health, format.ts) were already in the
tree but the locale keys they use were missing and nothing was wired; this run finished 3-7, wired the shell and wrote the
tests.

## Deliverables (brief order)

1. `styles.css` tokens / icons / motion (UX2 1) - done in the first attempt (no new colour token; recipes `chip-*`,
   `media-rule`, `media-caution`, `change-arrow`, `event-cancelled`, `note-amber`, `disclosure-warn`, `command-field`; mask
   icons `icon-mic|image|undo|auto|terminal|alert`, `icon-undo` mirrored in RTL). Tests `styles.test.ts`.
2. `api.ts` wrappers for all 24 v2 channels + `events.on{Auto,Cli,Queue}Changed/onVoiceProgress` + `onUndoSuccess`
   observer (first attempt). **App.tsx** (this run): hydrates `auto` + `cli` stores at boot (reads only), subscribes
   `auto:changed` (store `subscribe()`), `cli:changed`, `queue:changed`; DownloadPill gets the whole downloader queue
   (`toPillProgress` now accepts llm / voice / mmproj, never `voice-vad`; per-row target via `downloadTargetOf`);
   SetupStrip rows 4-9 (`setupTasksOf(health, hidden, facts)`); HealthPill `onSubline` -> Settings group
   (WhatsApp -> rules, AI -> ai, Calendar -> auto); Settings routing `openSettings(group | 'activity')` (a nonce remounts
   Settings so it scrolls); row 4 "Review" opens the v2 ConsentDialog; toast `onUndo` (W1-11 field) honoured.
   Announcements: "Undone." (onUndoSuccess, never throttled), automatic write while focused ("Added automatically: <when>"
   from trusted fields only - `announceAutoWrite`), policy state change ("Automatic mode: <state>.", throttled), download
   completion names the file (voice / picture reading).
3. Locales: all keys the new code uses added directly to `en.json` / `he.json` (parity green, Hebrew `_two` duals where
   counts appear). `locales.test.ts` gained the v2 copy rules: dialog bullets == settings bullets (new
   `src/shared/i18n/autoCopy.ts` = the ONE key list + `autoDialogDetail()` for main's dialog), AUTO_REASONS exhaustive,
   `undo.button` he = "ביטול השינוי", `download.kind.*` for every visible file, duals, CLI names/vendors.
   `i18n.usage.test.ts`: dropped every seeded prefix now referenced (the staleness test forces it), moved `download.kind.`
   to DYNAMIC_PREFIXES (resolved from the file id), and listed 7 individual keys whose screens have no channel/data yet
   (see REQUESTS).
4. `views/Settings.tsx` + `views/settings/**`: group order General - AI engine - WhatsApp - Google Calendar - **Automatic
   mode** - Working rules - Replies - Privacy; `initialGroup` accepts `'auto' | 'activity'`. New sub-views:
   `parts.tsx` (Toggle/Row/Group/SubGroup/ConfirmDialog/Disclosure moved out of Settings.tsx; Settings re-exports
   Toggle/ConfirmDialog), `VoiceNotes.tsx`, `Pictures.tsx`, `CliLimits.tsx` (runs/hour via `settings:set`, overage via
   `cli:setOverage` ONLY, exe via `cli:pickExe`), `ReadTools.tsx` (Off via `settings:set`, scopes via `wa:setReadScope`
   ONLY, consent-first for all_chats with a cloud provider), `AutomaticMode.tsx`. Settings also: notifications second
   line, budget "(API keys only)", calendar role line (`settings-calendar-role`), per-contact "Automatic" column
   (`chat:setPolicy {chatRef, autoPolicy}`), privacy table 8 rows, purge copy. `views/AutoActivity.tsx` (sub-page).
5. `ConnectCard.tsx` (first attempt; reviewed, one locale bug fixed) + `ConsentDialog.tsx` (+ `cloudConsentKindOf`).
6. Shell components (first attempt) - wired and tested this run. `store/{health,settings,cli}.ts` done.
7. Onboarding: `ChooseAi.tsx` v2 (B12 card order, "Show experimental" / "Advanced" disclosures that auto-open for the
   active provider, compact Connect cards in onboarding / full in Settings, subscription switch = consent (exact version)
   -> `llm:setProvider` with "Checking ...", failure keeps the previous provider + "Still using: ...", voice opt-in +
   pictures sentence), `Ready.tsx` voice row, `GoogleWizard.tsx` closing sentence. `shared/i18n/format.ts` (first
   attempt). `tests/setup-renderer.ts` typed fake `window.api` v2 (first attempt / W0).

## Decisions / assumptions (the specs were silent or disagreed)

- **Subscription switch in onboarding**: UX2 6 says Continue is enabled when "Ready + consent + setProvider succeeded",
  but the compact card offers no action in `ready`. Resolved: Continue is enabled when the selected subscription card is
  `ready`; clicking it runs consent (if missing) -> `llm:setProvider` ("Checking Claude Code...") and moves on only on
  success. Behind the focus-steal guard.
- **Voice enabled vs readiness (UX2 C11)**: C2 4 says main refuses `voice.enabled=true` until the model is ready. Settings
  therefore stores only `voice.tier` for a missing tier (+ `model:startDownload` after the inline confirm); onboarding
  tries `{enabled:true, tier}` and falls back to `{tier}` on refusal. Nobody flips `enabled` when the download finishes -
  see REQUESTS (C11 needs a decision).
- **Voice sizes**: `voice:getState` only describes the resolved tier; other tiers show a size / status only while their
  file is in the downloader queue. A size the renderer does not know is never guessed (key variants `...NoSize`).
- **Shadow tally**: `AutoState.shadowTally` has one `wouldAuto` total, no add/change split, so the state card and the
  SetupStrip trial row use new "total" keys (`auto.state.shadowReadyTotal`, `setup.auto.trialReadyTotal`); the UX2 keys
  with `{{wouldAdd}}/{{wouldChange}}` stay unused.
- **Renew** is offered for `expired` only (`auto:requestEnable`; main refuses a request while a policy is live, so
  "Renew" on a live `on` policy has no channel). For `on` within 7 days the page repeats "ends in N days".
- **Rate limit (UX2 C8)**: a `BAD_REQUEST` answer to `auto:requestEnable` is shown as "Try again in an hour." (the only
  documented BAD_REQUEST cases the UI can reach once the preconditions line passed).
- **AutomaticMode props**: added OPTIONAL `onOpenActivity?()` (the W0 prop shape `{ state }` still compiles; the link only
  renders when it is given). ConnectCard props unchanged; "Checking ..." / error rows are rendered by ChooseAi under it.
- **Activity page** shows `write` rows only (see REQUESTS). The page reuses W1-11's `UndoControl` (door `activity`).
- **CLI exe path** is never rendered (a path never crosses IPC for display): "Found automatically" / "Chosen by you" from
  `LlmConfig.cli.claudeExePathSet`.
- `v2-stubs.test.tsx` (W0): its header asks each owner to replace its block; the `useCliStore.refresh()` assertion now
  expects a resolved promise (W1-11 did the same for `useAutoStore.hydrate()`).
- Found and fixed while testing: `download.downloadingShort` duplicated the file name ("{{name}} {{percent}} %").

## Test status (this run, 2026-09-29)

- `npx vitest run --project renderer` -> 64 files, 1017 tests green (includes W1-11's files as they stand now).
- `npx vitest run --project main src/shared` -> 708 green (locales parity + v2 copy rules, i18n helpers).
- `npx eslint <owned paths> --max-warnings 0` clean; `npx prettier --check <owned paths>` clean (formatted own files only).
- `tsc -p tsconfig.web.json` clean; `tsc -p tsconfig.tests.json` shows no error in owned files. `tsc -p tsconfig.node.json`
  has errors outside my paths (`src/main/agent/existingEvent.ts`, `readImage.ts`, `validate.ts`) - not mine, W1-03/W1-08.
- New test files: `App.v2.test.tsx`, `components/{ConnectCard,ConsentDialog.v2,DownloadPill.v2,HealthPill.v2,
  SetupStrip.v2}.test.tsx`, `store/cli.test.ts`, `views/{AutoActivity,Settings.v2}.test.tsx`,
  `views/settings/{AutomaticMode,CliLimits,Pictures,ReadTools,VoiceNotes}.test.tsx`,
  `views/Onboarding/{ChooseAi.v2,Ready.v2}.test.tsx`; extended `store/{health,settings}.test.ts`, `GoogleWizard.test.tsx`,
  `ChooseAi.test.tsx` (API-key cards behind "Advanced"), `Settings.test.tsx`, `DownloadPill.test.tsx` (value text names
  the file). RTL snapshots updated for Settings / ChooseAi / Ready (intended v2 changes) and written for AutomaticMode,
  AutoActivity and every Connect-card state.
- Coverage (renderer project, owned files; lines / branches / functions): AutomaticMode 100/95/100, AutoActivity
  98/87/100, ConnectCard 99/93/98, Settings 99/85/95, ChooseAi 97/89/99, HealthPill 100/98/100, DownloadPill 97/90/96,
  SetupStrip 100/100/100, store/cli 100/100/100, ReadTools 100/88/100, Pictures 98/89/100, VoiceNotes 94/89/100,
  CliLimits 100/85+/100; shared/i18n (main project) autoCopy/bidi/languages 100, format 100/97/100, resources 100/87/100.
  Below 90/85/90: `App.tsx` functions ~84 % (two `window.location.reload` DB-recovery handlers and the 60 s clock tick),
  `ConsentDialog.tsx` branches ~75 % (the v1 scroll-to-accept path needs layout, jsdom has none), `LanguageToggle.tsx`
  branches 72 % (v1 file, unchanged), `store/settings.ts` functions 89 % (one v1 callback).
- Acceptance items covered in he + en: no automatic-mode control bound to `settings:set` (click-all test spying
  `settings:set` + a static scan that `requestAutoEnable` has exactly one caller), every AUTO_REASONS / ErrorCode string
  from the locale files (locales.test), "Show experimental" hides `antigravity_cli`, onboarding never offers automatic
  mode (ChooseAi, GoogleWizard, Ready), parity + `i18n.usage.test.ts` green over the merged resources, every UX2 13
  settings / shell / consent test id present.

## REQUESTS

1. **Orchestrator / V2-W2-01 - `.gitignore` line `store/` also ignores `src/renderer/src/store/`** (`git check-ignore`
   confirms; `git ls-files src/renderer/src/store` is EMPTY - the v1 renderer stores were never committed to the public
   repo). Suggest `/store/` (+ an explicit pattern for the bridge's `store/` if it can appear elsewhere), then stage
   `src/renderer/src/store/*.ts`.
2. **Orchestrator (C2) - automatic activity decisions**: UX2 4.6 wants shadow ("Would have been added") and fallback
   ("Not automatic · reason") rows, but no channel returns decisions (`auto:listWrites` = writes only). Suggest
   `auto:listDecisions {sinceTs}` -> `{ decisions: {id, itemId, verdict, reason, decidedAt}[] }` (no text). Keys
   `activity.notAutomatic|wouldAdd|wouldChange` are seeded meanwhile (`SEEDED_KEYS`).
3. **Orchestrator (C2) - `AutoState.shadowTally` has no add / change split** (UX2 4.5 / 2.3 copy uses wouldAdd +
   wouldChange). Either add `wouldAdd`/`wouldChange` or drop those keys; the UI uses the total meanwhile.
4. **Orchestrator (C2 / UX2 C11) - who sets `voice.enabled=true` after a download** requested from Settings or the
   onboarding opt-in: main refuses it before the model is ready, and nothing flips it afterwards. Suggest main enables
   voice when the stored tier's file (+ vad) becomes ready if the user asked for it (an intent flag), or the handler
   accepts `enabled:true` as intent.
5. **Orchestrator (C2) - `voice:getState` per-tier facts**: only the resolved tier's `{sizeBytes,status}` is known, so
   the Voice notes group cannot show sizes / "ready - Delete" for the other two tiers. Suggest
   `models: {id, sizeBytes, status, bytesDone}[]` for all three tiers.
6. **Orchestrator (C2) - "Use automatic" for the Claude Code location**: no channel resets `llm.cli.claudeExePath` to ''
   (`cli:pickExe` only sets a path; `settings:set` refuses the key). Key `cli.exeAuto` seeded meanwhile.
7. **Orchestrator (C2) - consent withdraw**: UX2 4.3 / 7.1 show "[Withdraw]" next to the consent date; no channel exists.
   Key `cli.withdraw` seeded meanwhile.
8. **V2-W1-04 - main's enable dialog**: build `detail` with `autoDialogDetail(t, {validityDays, endsOn})` from
   `src/shared/i18n/autoCopy.ts` so the dialog can never say something the settings list does not (UX2 4.5.1; the
   locales test pins the six keys). Keys `cli.agy.dialogTitle|dialogOk` (main's workspace dialog, V2-W1-06/09) are seeded.
9. **V2-W1-11 - AutoStrip "Show all" link**: UX2 4.6 reaches the activity page from the strip too; the shell can open it
   with Settings `initialGroup='activity'` - if the strip gets an `onShowAll` prop, App/Dashboard can route it
   (App's `openSettings('activity')`).
10. **Observation for V2-W1-04 / V2-W2-02**: `tests/security/import-graph.test.ts` B fails right now because
    `src/main/exec/actionExecutor.fixtures.ts` value-imports `../mcp/writeClient` (not a renderer file; not touched).

## BLOCKED-BY

None.
