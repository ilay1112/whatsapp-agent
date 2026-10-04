# V2-W1-10-main-platform - builder notes

Package: `V2-W1-10-main-platform` (Wave 1 of the v2 build). Brief: `docs/specs/v2-build-plan.md` section 7. Started from the W0
stubs (no partial implementation from an earlier attempt existed in the owned files). Decisions honoured: D-068..D-071.

Status: DONE, with one red test that is blocked by another package (BLOCKED-BY below) and the REQUESTS below.

## What was built (owned paths only)

| File | Delta |
|---|---|
| `src/main/ipc/register.ts` | Focus gate: `FOCUS_GATED` = `new Set(FOCUS_GATED_CHANNELS)` exactly, `passesFocusGate(ctx, now)` (focused AND visible AND not within `LIMITS.focusGuardMainMs` of a toast raise). Applied AFTER the sender check, the strict parse and the window-state sample; refusal = `WINDOW_NOT_FOCUSED` + audit `ipc_rejected {reason:'window_not_focused'}` (ref = channel). `RejectReason` += `window_not_focused`. New types for the optional v2 collaborators of the v1 handler files: `ItemsHandlersV2`, `SettingsHandlersV2`, `LlmHandlersV2`, `DataHandlersV2`. `HandlerDepsV2` (frozen) untouched. |
| `src/main/ipc/register.handlers.ts` (new, `<ownedFile>.<suffix>.ts`) | `createIpcHandlers(depsV2, ext)` assembles all 13 handler groups (incl. W1-04 auto, W1-06 cli, W1-07 voice) and `mergeHandlerGroups()` throws on a channel served twice or a union != `IPC_CHANNELS`. `IpcHandlersExtV2 = {autoDialog, dialogParent, listAgyModels}` (what HandlerDepsV2 lacks). |
| `src/main/ipc/handlers/items.ts` | `item:undoChange` (item exists, holds an event, `revisionId` == `eventRevisions.undoCandidate(eventId).id` and belongs to the item, else `ACTION_STALE` + audit) -> `undo.undoChange(itemId, revisionId, 'user')`; `item:restoreOriginal` (non-empty `unrevertedAutoSpan`) -> `undo.restoreOriginal`; `item:cancelEvent` (event_state created/updated, open, holds an event) -> `undo.cancelEvent`; `item:getImage` -> `ItemService.getImage`; `chat:setPolicy {autoPolicy}` pass-through. Missing Undo collaborator => `INTERNAL` + log `ipc_v2_unwired` (never a silent success). |
| `src/main/ipc/handlers/settings.ts` | `wa:setReadScope` (only writer of `whatsapp.readTools.scope`, F11): same scope = no-op; `all_chats` needs the active cloud provider's consent at its CURRENT version (`CONSENT_REQUIRED` + audit, no dialog) and `autoDialog.confirmSetting(dialogParent(), 'read_all_chats', vendorOf(provider))`; cancel = unchanged scope, ok; written with `setInternal`, audited `settings_changed {key, value}`. `settings:set` v2: `voice.enabled=true` (turning it on) needs `resolvedTier` + model `ready` + `voice-vad` `ready` (`VOICE_MODEL_MISSING`; unwired voice service = fail closed); `llm.cli.maxRunsPerHour` re-clamped to `LIMITS.cliRunsPerHourMax`. The forbidden keys are refused by the strict parse in register.ts (BAD_REQUEST + `ipc_rejected {reason:'bad_payload'}`), proven in `register.test.ts`. |
| `src/main/ipc/handlers/llm.ts` | `llm:setProvider` CLI ids: `CliStatus.state==='ready'` (else `CLI_STATE_CODE`: not_installed->`CLI_NOT_INSTALLED`, too_old->`CLI_VERSION`, not_signed_in/unknown->`CLI_NOT_SIGNED_IN`) -> consent current (`CONSENT_REQUIRED`) -> `lastTest.ok` within `CLI_TEST_FRESH_MS` = 24 h (`CLI_UNSTABLE`), all BEFORE the switch; `llm:listModels` claude_cli = `CLAUDE_CLI_MODEL_PRESETS` (the CLI has no listing), antigravity_cli = injected `listAgyModels()` filtered through `AgyModelSchema`, de-duplicated, capped at 50 (vendor-CLI text, B27), presets = the default agy model; `llm:getConfig.quota` = `healthHub.get().llm.quota` for a CLI provider only. |
| `src/main/ipc/handlers/model.ts` | Targets = `DOWNLOAD_TARGETS`: LLM tiers unchanged; voice files / voice-vad by their own id; `'mmproj'` resolves to the SELECTED tier's projector from `plan().mmproj` (none => `BAD_REQUEST`). Non-LLM ids go through a typed view of the one downloader queue (see REQUEST to W1-07). |
| `src/main/ipc/handlers/data.ts` | `data:purgeNow`: first disables a live policy (`autoPolicy.disable('purge')`; direct repo write + audit `auto_policy_disabled` when unwired / refused / throwing - fail-safe direction), then the v1 retention job, then wipes the CONTENTS of `media-cache\`, `voice\tmp\`, `cli-runs\`, `agy-workspace\runs\` (`purgeDirsOf`, `wipeDirContents`; a busy entry is skipped and logged by count only). |
| `src/main/ipc/handlers/app.ts` | `consent:accept` for `cloud_antigravity_cli` stores `ANTIGRAVITY_TERMS_READ_ON` (B14); the five new `external:open` targets work through the generic links table (tests added). |
| `resources/links.json` | Keys unchanged (== `EXTERNAL_TARGETS`). Fixed `project_readme`: it pointed at `ilay1112/whatsapp-calendar-agent` (does not exist); the repo is `ilay1112/whatsapp-agent` (CLAUDE.md). |
| `src/main/agent/items.ts` | C2 1.5 view models: `calendar` for created/updated/cancelled with `eventKey = eventKeyOf(id)` (16 hex of `sha256('wca-event|'+id)`; an id-less calendar row gets `sha256('wca-item|'+itemId)`), revision, status; `change` (ChangeView from `proposals.delta_json`, only while `change_proposed`); `changePending` (the chat's open item is a `change_proposed` delta linked to this item); `undo` (UndoView of the event's undo candidate: manual = `min(appliedAt + 7 d, restore-target start)`, automatic = `auto_writes.undo_until` + `undo_state`, blocked_*/failed shown, expired/undone/past-window hidden); `auto` (AutoCardView: chip automatic/auto_shadow, "Not automatic" reason only for a pending calendar action while a policy is live and never `policy_shadow`); `voice` (VoiceView from `transcripts`, text only when `done`); `image` (ImageReadView from `proposals.image_json` + `mediaCache.thumb`); trigger-row `MessageView.voice/image`; In-calendar list = one entry per eventKey (newest wins); `getImage` (item + media_cache row, JPEG data URL only, <= `LIMITS.imageDataUrlMaxBytes`, else `NOT_FOUND` / `MEDIA_UNAVAILABLE`); `update_event` buttons greyed `calendar_updates_unavailable` without a verified update surface; `completeEvent` refused for updated/cancelled/change_proposed too. Every v2 decoration is wrapped in `decorate()`: a failing lookup degrades only that field and logs `item_view_degraded {field,itemId,name}` (never the message). New optional deps `updatesAvailable?`, `mediaCache?` (absent => fail closed). |
| `src/main/health/healthHub.ts` | `setVoice` (a HealthPart with `since`), `setAuto`, `setLlmQuota`, `setCalendarUpdates`; inputs copied; none of them feeds `overallOf`. |
| `src/main/paths.ts` | (dirs were W0's) + `childAndJobExeRoots(paths)` = v1 roots + `whisperDir` (unpackaged whisper lives outside every v1 root). `childExeRoots` byte-identical (W1-06's reaper test pins 3 entries). |
| `src/main/logger.ts` | Redactor: 43-char base64url standalone run (the per-run MCP token) -> `[REDACTED-TOKEN43]`; `WCA_MCP_TOKEN=`, `CLAUDE_CODE_OAUTH_TOKEN=`, `ANTHROPIC_AUTH_TOKEN=` values. Structural rule at the choke point: meta keys `stdout`/`jobStdout` are DROPPED (job stdout never logged, not even its length); `stderr`/`jobStderr` become `stderrBytes`, `stderrSha8`, `stderrMarkers` (closed set `JOB_STDERR_MARKERS`) via `jobStderrMeta()`. Sentinels are NOT redacted by pattern on purpose: the ledger sentinel sweep must see a leak, so the guarantee is "never logged", not "masked". |
| `src/main/testSeams.ts` | `__wcaTest` v2 (T2 4.2): `installTestHooks(hooks, v2?)` - facade = the eight v1 hooks + `dialogs()`, `consoles()`, `jobPids()` (copies; empty defaults when not wired), `notifications()[].actions` (always present), `trayClick('autoPause')` routed to `v2.trayClickAutoPause` (throws when not wired), unknown ids throw. `WcaTestHooks` keeps its v1 member set (the e2e fixture maps it member-for-member), new types `WcaTestHooksV2`, `WcaTestFacade`, `WcaTrayClickId`. |
| `src/main/app/window.ts` | `QuitDeps.killJobs?` step after `stopQueue`, before `drainExecutor` / `stopChildren` (B2: jobs die before `supervisor.stopAll`). |
| `src/main/app/i18n.ts` | unchanged; tests prove the v2 dialog / toast / tray keys resolve in en + he. `protocol.ts` CSP unchanged (`img-src 'self' data:`). `autostart.ts`, `secrets.ts`, `sender.ts`, `src/preload/**` unchanged (preload lists were already W0's). |

## Tests added / changed (all owned)
`src/main/agent/items.v2.test.ts` (28), `src/main/ipc/register.test.ts` (+ focus gate matrix over every channel x 5 window states,
wrong-type payloads for every channel, settings:set forbidden keys + audit, C2 19 item 25 exact names, text-free key rule),
`register.handlers.test.ts` (5), `handlers/{items,settings,llm,model}.v2.test.ts`, `handlers/{app,data}.test.ts` (v2 blocks; data
fixture gained the four dirs), `sender.test.ts`, `health/healthHub.test.ts`, `paths.test.ts`, `logger.test.ts`, `testSeams.test.ts`
(hook facade rewritten for eleven hooks), `app/window.test.ts`, `app/i18n.test.ts`.

## Decisions / assumptions (for the orchestrator)
1. **Key-name test with ZERO new allow-listed keys.** W0 had added `readTools` to the allow-list (it matches `/tool/`). The allow-list
   is back to exactly the v1 `['jsonText']`; instead a matching key passes only when its value schema can hold NO text at all
   (`canCarryText` = false: numbers / booleans / non-string literals only, recursively). `whatsapp.readTools` is `{enabled, windowDays}`
   and qualifies structurally. A string, enum or string literal anywhere below a matching key makes it an offender again (tested with
   five hostile shapes). The C2 19 item 25 exact-name list is checked separately with no exemption at all.
2. **v2 collaborators of v1 handler files as an OPTIONAL second factory argument** (not new members of the frozen `HandlerDepsV2`), so the
   Wave-0 `compose.ts` keeps compiling untouched. Each handler fails closed when its collaborator is absent.
3. **ItemService `updatesAvailable` absent => false** (greys update buttons) and **`mediaCache` absent => no thumbnails**, fail closed.
4. Manual undo window of a CREATE is timed to the created event's own start (`prev` is null, the restore target is "no event").
5. `unknown` CLI state maps to `CLI_NOT_SIGNED_IN` (the Connect card's user-fixable action).
6. `wa:setReadScope` with the same scope is a no-op without dialog and without audit.

## Dead ends / incidents (honest record)
- **Accidental shell command substitution of `agy`.** One `node -e "..."` edit command contained a JS template literal with backticks
  around the words "agy models" inside a double-quoted bash string; bash tried to run `agy models` as a command substitution. Bash
  answered `agy: command not found` three times - nothing was found on PATH and nothing executed, and the node script aborted before
  writing. No vendor CLI state was read. From then on every edit script was written to a file in the scratchpad and run with
  `node <file>`, never inline.
- The Bash tool turns `\\` into `\` inside heredocs, which corrupted Windows-path literals in two appended test blocks (one produced a
  raw TAB/CR); fixed with the Edit tool and verified with a control-character scan of every owned file.

## Verification (2026-09-29)
- `npx vitest run --project main <owned tests>`: 30 files, 564 passed, 1 failed (BLOCKED-BY V2-W1-01, below).
- Coverage over the owned sources (text reporter, `skipFull`): every owned file 100 % except `agent/items.ts` 99.3 / 97.5 / 100 / 100,
  `handlers/app.ts` 98.5 / 93.1 / 100 / 100 (v1 `calendarDayUrl` branches), `handlers/data.ts` 97.3 / 100 / 90 / 96.9 (the v1
  `settings` thunk runRetention never calls in purgeNow mode). `register.ts`, `sender.ts` 100 / 100 / 100.
- `npx eslint --max-warnings 0 <owned paths>`: clean (links.json is eslint-ignored by config).
- `npm run typecheck` (node + tests + web): no error in any owned file. Errors elsewhere at the time of the run (not mine, other lanes
  in progress): `src/main/mcp/host.v2.test.ts` (9), `src/main/proc/jobRunner.test.ts` (4), `src/main/voice/service.test.ts` (2),
  `src/main/ipc/handlers/voice.test.ts` (1), `src/main/llm/cli/claudeCli.test.ts` (1), `tests/integration/mcp-real-toolslist.test.ts` (1),
  plus `src/main/media/fetch.ts` earlier in the session.
- Full `--project main`: 4 failures, 3 of them other lanes' (`mcp/host.v2.test.ts` x2, `proc/jobRunner.test.ts`). `--project security`
  + `--project integration`: 814/815, the failure is `tests/integration/fakes-v2.test.ts` "typed shapes" (W1-05's `rawProbe` is now
  implemented; the W0 skeleton row still expects a rejection) - not mine. My focus gate broke no security / integration test.
- `prettier --write` run on my changed files only.

## REQUESTS
1. **V2-W1-01** - `repos.chats.withPolicies()` must also return chats with `auto_policy = 'never'` (C2 8 IpcResMap
   `'chat:listPolicies': chats with policy != 'default' or forceKnown ; [V2] or autoPolicy = 'never'`). Today it filters
   `policy <> 'default' OR force_known = 1` only, so `src/main/agent/items.v2.test.ts` "chat:setPolicy {autoPolicy} ... lists the chat"
   is red. One WHERE clause.
2. **V2-W2-01 (compose)** - wire:
   a. `createIpcHandlers(depsV2, { autoDialog, dialogParent: () => focused BrowserWindow, listAgyModels: () => listAgyModels(cliRunner) })`
      from `src/main/ipc/register.handlers.ts` instead of the per-file spreads (it also asserts the channel union);
   b. `createItemService({... , updatesAvailable: () => mcpHost.updateSurface().available, mediaCache })`;
   c. `installTestHooks(hooks, { dialogs: () => autoDialog.recorded(), consoles: () => <S-CONSOLE recorder argv>, jobPids: () => jobs.jobPids(), trayClickAutoPause: () => tray.click('autoPause') })`
      (and pass `actions` in the recorded notifications);
   d. `QuitDeps.killJobs: () => jobs.killAll()`;
   e. the reaper roots: `childAndJobExeRoots(paths)` instead of `childExeRoots(paths)` (dev-layout whisper pid files);
   f. HealthHub: `setVoice` from the voice service state, `setAuto` from `auto:changed`, `setLlmQuota` from the CLI `rate_limit_event`,
      `setCalendarUpdates(mcpHost.updateSurface().available)` after the startup guard.
3. **Orchestrator (contract)** - `HandlerDepsV2` has no `autoDialog` / dialog parent, but `cli:setOverage` (W1-06) and `wa:setReadScope`
   (W1-10) both need `autoDialog.confirmSetting(win, ...)`. I used `IpcHandlersExtV2` + an optional factory argument; W1-06 will hit
   the same gap in `createCliHandlers(deps)`. Suggest adding `autoDialog` + `dialogParent` to `HandlerDepsV2` in Wave 2 (then
   `IpcHandlersExtV2` shrinks to `listAgyModels`).
4. **V2-W1-07** - widen `ModelManager.start/pause/resume/cancel/delete` from `ModelTier` to `ModelFileId` (one downloader queue, C2 8).
   `handlers/model.ts` calls the non-LLM ids through a typed view of the same object until then; after the widening the view is a no-op.
5. **V2-W1-04** - `autoDialog.confirmSetting(win, 'read_all_chats', vendor)` needs its copy keys (only `cli.limits.overageConfirm*`
   exists for the overage kind; no read-all-chats confirmation copy is seeded).
6. **Orchestrator / V2-W1-11 (contract gap)** - UX2 3.4 shows **Restore original** "after two automatic edits of one event", but C2 1.5
   `UndoView` / `ItemCard` carry no field that tells the renderer so. ItemService could expose it cheaply
   (`eventRevisions.unrevertedAutoSpan(eventId).length >= 2`) if a field is added to `ItemCard` (e.g. `undo.restoreOriginal: boolean`).
7. **V2-W1-02** - confirm that `meta.calendar_roles_json` is written on every `google:listCalendars` / picker refresh (host.ts says
   adminClient.listCalendars persists it); `handlers/google.ts` does not write it to avoid a second writer.

## BLOCKED-BY
- **V2-W1-01** - `src/main/agent/items.v2.test.ts` > "chat:setPolicy {autoPolicy} stores "never" / "inherit" and lists the chat"
  (REQUEST 1). Not skipped, not weakened.

## Fix round (2026-09-29) - W1-04 request: relax the undo door
Audit `v2-wave1-audit.md` 3.2(b): W1-04 -> W1-10, relax `candidate.itemId !== item.id`.
- `src/main/ipc/handlers/items.ts` `item:undoChange`: the `candidate.itemId !== item.id` refusal is gone. The candidate is looked up by
  the door item's OWN `calendar_event_id`, so "the item carries this event" holds by construction; the refusal is now only "no
  candidate" / "revisionId is not the candidate" (ACTION_STALE + audit). The executor resolves the current holder itself (W1-04 `holderOf`).
- `src/main/agent/items.ts` `undoViewOf`: the door is shown on the card that CURRENTLY HOLDS the event (new `holdsEvent`: no other card
  carrying the id has a higher `event_revision`; a tie keeps the card - the executor's `holderOf` rule), whatever card the candidate
  revision belongs to. Superseded older cards (lower `event_revision`) show no door, so a chain never shows two Undo buttons.
  Decision: view = holder-only (one door per event), IPC = any carrying card (W1-04 decision 5 "any card may be the door").
- Tests: `handlers/items.v2.test.ts` (candidate of another card now delegates, stale loop keeps null / wrong id);
  `agent/items.v2.test.ts` (holder shows an older card's revision, superseded card none, other-event cards ignored, tie keeps door).
  The old "candidate belongs to another item => no door" assertion was REPLACED because the requirement changed (W1-04), not weakened.
- Verification: `vitest --project main` over agent/ipc/health/app/paths/logger/testSeams: 64 files, 1446 passed + 1 expected-fail, 0 red.
  The former BLOCKED-BY (V2-W1-01 `withPolicies` + `never`) is now green. eslint clean on the 4 touched files; `npm run typecheck` clean.
- Still open for others (unchanged): REQUESTS 2 (compose wiring, V2-W2-01), 3, 4, 6, 7 above.
