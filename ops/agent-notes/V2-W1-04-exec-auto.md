# V2-W1-04-exec-auto - builder notes

Package: `V2-W1-04-exec-auto` (build plan section 7). Owns `src/main/exec/**`, `src/main/ipc/handlers/{actions,auto}.ts`,
`src/main/app/{notifications,tray,autoDialog}.ts`, `tests/helpers/{ledger,ledger-hook}.ts`, `tests/mocks/electron.ts`,
`tests/fakes/obedient-attacker-llm.ts`, the 12 security files of groups 14-17/22 and the 3 integration files.
Decisions honoured: D-068 (media gates per provider, `voicePassed` + `imagesPassed`, all closed by default), D-069 (auto rails as
designed), D-070, D-071. No dependency, no version change, no network, no vendor binary, no commit.

A partial earlier attempt had left `exec/autoGate.ts`, `exec/buildUpdateEventArgs.ts` and `exec/eventContent.ts` (reviewed and kept);
everything else of the package was still the Wave-0 stub.

## Status: DONE (one security test and the three integration files BLOCKED-BY V2-W2-01, see below)

## What was built

| Area | File(s) | Notes |
|---|---|---|
| AutoGate (B8/B9) | `exec/autoGate.ts` (+ `eventContent.ts`) | Pure; evaluation order policy -> contact -> quality -> provider -> cage -> edits -> budgets; one reason per `AUTO_REASONS` value; `RESERVED_AUTO_REASONS` (`policy_shadow`, `no_user_echo`, `duplicate`) unreachable; `evaluateAutoGatePhaseA` (P2 10.3: no Google read for a proposal that fails a pure check). D-068 via the optional `mediaGates` input (absent = both closed). F2/F5/F9/F27/F28/F31 as specified. |
| Update builder | `exec/buildUpdateEventArgs.ts` | Key set == `UPDATE_EVENT_KEYS`, no `description` (F5), identity tags copied from the pre-flight, `waRev = baseRevision+1`, `UpdateArgsError` on a foreign identity / missing etag. |
| Executor v2 | `exec/actionExecutor.ts` | `approve()` + update gate order of C2 14 (to==from, surface, sanity, baseRevision/target CAS, pre-flight get-event with GONE / FOREIGN (write-ahead then `failed`, no clone, "Add as new event") / drift question (confirmDrift honoured only after a `needs_confirm_drift`), own-block free/busy, `create_global`, write-ahead with `approved_by`, PATCH with If-Match, 412 => failed ACTION_STALE + clone + drift question about the clone, readback-verified `done` else `unknown_outcome`). "Apply anyway" stores the PRE-FLIGHT content as `from` (decision 4 / T2 concern 7). A done create writes rev 1 + origin + baseline (readback). `tryAuto` = ARCH-v2 6.3 / P2 10.6 (Phase A, reads, full gate, ONE transaction decision + CAS with the decision id + auto_writes{pre_json, undo_until} + audits + auto buckets; canonical_json verbatim (F4); failed write = ordinary card; unknown pauses). Undo path (`undoChange`/`undoAuto`/`restoreOriginal`/`cancelEvent`) over the revision chain (F1) acting on the event's CURRENT holder item, windows (F2), baseline pre-check (blocked_changed, zero calls), blocked_started, taint (F10), draft carry-over (concern 19), 2-undos breaker counted per undo ACTION, "Add it back" (U-E1) as a click. |
| Outcome / reconcile | `exec/outcome.ts`, `exec/reconcile.ts` | `applyUpdateSuccess` (returns the revision row), `commitUpdateDone` (shared by executor + reconcile), `applyCreateSuccess(..., readback)`. `reconcileUpdate` = get-event only; B24 (T-401) in `reconcileCreate`: found + edited => done + ONE pending update_event (zero writes). |
| Policy | `exec/autoPolicy.ts` | C2 8 preconditions in order, `auto_dialog` 3/h, dialog `response===1 && checkbox`, shadow default / "Turn on now" (F34), endShadow >= 3 decisions, pause/resume/disable, expiry + reminder, unattended + calendar-disconnect pause on `tick()`. A paused TRIAL resumes only with >= 3 decisions (never a silent promotion). |
| Undo facade | `exec/undo.ts` | Doors onto the executor; `user` doors carry the sampled window state (optional `windowState` dep), the toast none; a throw => INTERNAL. |
| Dialog / toasts / tray | `app/autoDialog.ts`, `app/notifications.ts`, `app/tray.ts` | Exact native options; calendar name cleaned/truncated/FSI..PDI; `WCA_DIALOG_SCRIPT` answers after the real options are built + recorded; unfocused parent => no box. Toasts app-text only, shown with notifications off, burst => one summary, action 0 Undo / 1 Show (focus-steal guard armed). Tray `autoPause` line only while a policy is live; CLI status lines. |
| IPC | `ipc/handlers/auto.ts` (actions.ts unchanged: confirmDrift passes through) | 9 channels; focus re-checked for requestEnable/resume/endShadow/undo; disable/pause unfocused; listWrites (readback content, pre_json as `before`); export = metadata only. |
| Test infra | `tests/helpers/ledger.ts`, `tests/mocks/electron.ts`, `tests/fakes/obedient-attacker-llm.ts` | Ledger rules 6 (update-event <-> exactly one approved row, args == builder output), 8, 9 (`neverForeignProblems` when `appCreated` is attached), 10 (fake violations + named rows), 12 (sentinel sweep of file names / export / toasts / tray / title / run tokens). Mock `BrowserWindow.id`. Attacker v2 (T2 3.9): V1 "not suspicious" + injected readText, S1 confident cancel + forbidden keys, S3 reference names / forged handles / FQNs / calendar classes / auto verbs; corpus type widened (W1-05 request). |
| Test support | `src/main/exec/autoGate.fixtures.ts` (pure inputs, excluded from coverage), `tests/helpers/ledger.execRig.ts`, `tests/helpers/ledger.policyWorld.ts` (named after my `ledger.ts`, build plan 6) | Real DB + fake calendar v2 behind the real MCP clients; `stopRigsChecked()` runs the ledger BEFORE closing the DB (the file's afterEach runs before the global ledger hook). The rig lives under `tests/` because it value-imports `mcp/writeClient` (import-graph part B allows that only in compose.ts for `src/**`). |

## Tests (all run 2026-09-29)

- Unit (main): `exec/{autoGate,eventContent,buildUpdateEventArgs,actionExecutor.v2,actionExecutor.undo,actionExecutor.edges,autoPolicy,undo,outcome.v2,reconcile.v2}.test.ts`, `ipc/handlers/{auto,actions.v2}.test.ts`, `app/{autoDialog,notifications.v2,tray.v2}.test.ts` + every v1 exec/app/ipc test: green.
- Security (12 files, groups 14-17, 22): green except `auto-mode.injection-corpus.test.ts` Part B (see BLOCKED-BY). Every security file attaches the T2 8.1 ledger (rules 2, 6-9) to its rig.
- Integration: `auto-mode.flow`, `editing-executor`, `recovery-v2` written; red until V2-W2-01 (see BLOCKED-BY).
- Coverage (main + security projects over my files): `actionExecutor.ts` 100 lines / 98.99 branches / 100 funcs; `autoPolicy.ts`, `undo.ts`, `autoGate.ts` (99.4 br), `buildUpdateEventArgs.ts`, `outcome.ts`, `ipc/handlers/auto.ts`, `eventContent.ts` 100/100/100 (or >= 95 branches); `reconcile.ts` 100/98.9/100. `app/**` is excluded from coverage by the frozen config.
- `npx eslint <my paths> --max-warnings 0`: clean. Prettier: my files formatted. `npm run typecheck`: no error in my files.

## Decisions / assumptions (additive seam refinements - all OPTIONAL members, every frozen caller still compiles)

1. `createActionExecutor(deps: ActionExecutorInput)` = v1 deps + every C2 14 v2 dep optional with a FAIL-CLOSED default (no update
   surface, evaluateAutoGate, snapshot '' (never matches => snapshot_changed), no toast, crypto uuid, all golden gates closed) + optional
   `calendarRoles` (default: `meta.calendar_roles_json` through `mcp/adminClient.parseCalendarRolesJson`).
2. `AutoGateInput.mediaGates?` (D-068); `AutoPolicyServiceDeps` + `calendarConnected? calendarName? versions? lastFocusAt? onAppPause?
   onExpiring?`; `AutoDialog.confirmEnable` p + `validityDays? endsOn? renew?`; `Notifier.autoExpiring()` + `NotifierDeps.notifyWithActions?`
   + `autoWrite({..., itemId?})`; `TrayDeps.onAuto?`, `click('autoPause')`; `createUndo` deps + `windowState?`; `createAutoHandlers(deps,
   ext?: {dialogParent?, writeFile?})`; `reconcileUpdate(actionId, deps?)` (the frozen one-argument form has no repository => stays
   unknown); `ReconcileDeps.read` + optional `getEvent`; `applyUpdateSuccess` returns the inserted revision; `applyCreateSuccess(...,
   readback?)`; new exports `evaluateAutoGatePhaseA`, `commitUpdateDone`, `autoWriteIdOfAction`, `autoTrayAction`, `isolateCalendarName`.
3. GONE / FOREIGN after a click end the action `failed` (C2 8): the trigger allows `failed` only from `executing`, so the executor does
   the write-ahead (approved_by the clicker) and fails it immediately - no side effect, no clone.
4. A failed AUTOMATIC write gets the v1 retry clone (P2 10.6.8 "ordinary failed card with Try again"; tryAuto never runs for a clone).
5. The undo acts on the item that currently HOLDS the event (highest event_revision among the items carrying the id). Any card of the
   event may be the door (after a chain, the undo candidate's own item is an older, superseded card).
6. A change card must be LINKED to its target (`items.linked_item_id`), and the chain root (origin item) must be in the action's chat;
   else FOREIGN (click) / `wrong_item` (auto). `waAction` missing on the pre-flight = foreign.
7. The executor refuses the undo of a MANUAL change by `'user_toast'` (the toast exists only for automatic writes).
8. "Restore original" counts as ONE undo (breaker counts distinct undo actions), its `extraReverts` live in memory (after a crash the
   reconcile reverts `revertOf` only - documented residual).
9. AutoGate inside tryAuto: the pre-flight read is taken only for updates; a create's free/busy read failure => `conflict` (fail closed);
   the click path keeps v1 "a failed read is not a conflict".
10. The auto path does not call eventSanity(): the cage is strictly narrower (lead >= 15 min, 5..240 min, 30 d).
11. Security files are named per build plan 4; their shared rig lives in `tests/helpers/ledger.{execRig,policyWorld}.ts`.

## Dead ends / lessons

- The tool layer decodes `\uXXXX` and `\\` inside Write/Bash inputs: several files first received RAW bidi / zero-width characters.
  All my files were re-escaped by a script (`String.fromCharCode(92)+'u'+hex`); a scan over my paths is clean (the v1 files
  `actionExecutor.test.ts`, `buildSendArgs.test.ts` and three v1 security files still carry raw characters - pre-existing, not mine).
- Vitest runs a file's `afterEach` BEFORE the setup-file hooks: closing the rig DB in the file's hook broke the global ledger hook,
  and deferring the close tripped the T7 leak guard. `stopRigsChecked()` runs the ledger itself, detaches, then closes.
- `node -e` with backticks inside bash strings mangles code; patch scripts go through the Write tool.

## REQUESTS

1. **V2-W2-01 (compose.ts)** - wire: `createActionExecutor({...v1, updateSurfaceAvailable: () => host.updateSurface().available,
   snapshotSha: () => sha256(canonicalJson({targetCalendarId, googleAccountEmailSha8, provider, appMajorMinor})), featureGates:
   FEATURE_GATES lookup, notifyAuto: e => { push('auto:changed', autoPolicy.getState()); kind 'write' => notifier.autoWrite({kind,
   autoWriteId, burstCount: 0, itemId: repos.autoWrites.byId(id).itemId}); 'undo' => notifier.autoUndone(repos.autoWrites.byId(id)
   .undoState === 'undone'); 'policy' => notifier.autoPolicy(live?.state ?? 'off') }})` (calendarRoles default is fine);
   `OrchestratorDepsV2.tryAuto = executor.tryAuto` (after S4, before dashboard:changed); `createAutoPolicyService({..., calendarConnected,
   calendarName, versions, lastFocusAt, onAppPause: () => notifier.autoPolicy('paused'), onExpiring: () => notifier.autoExpiring()})` +
   a timer calling `tick(now)` (e.g. every 10 min + on focus); `createUndo({..., windowState: runtime.windowState})`;
   `createAutoHandlers(deps, {dialogParent: () => focusedWindow, writeFile})`; `createAutoDialog({showMessageBox: (w, o) =>
   dialog.showMessageBox(w, o), t, script: seams.dialogScript})`; `NotifierDeps.notifyWithActions` = an Electron `Notification` with
   `actions: [{type:'button', text}]` whose 'action' / 'click' events call the given callbacks, `onUndo: (id) => executor.undoAuto(id,
   'user_toast', null)`, `onShow`; `TrayDeps.onAuto` ('pause' => autoPolicy.pause('user'), 'disable' => autoPolicy.disable('user'),
   'open' => show window at Settings > Automatic mode); `TrayState.auto` from `autoPolicy.getState().policy`; `recoverOnStartup` already
   passes `deps.read` (with getEvent) to reconcile. Harness v2: a `dialogs` handle over `autoDialog.recorded()`; attach the ledger with
   `calendar.appCreated` so rule 9 runs in every integration test, and the rule-12 surfaces (`userDataDir`, `toasts`, `trayLabels`,
   `windowTitle`, `exportTexts`, `runTokens`).
2. **V2-W1-10 (ipc/handlers/items.ts, agent/items.ts)** - `item:undoChange` refuses when `candidate.itemId !== item.id`; after a change
   chain the candidate of undo #2 belongs to an OLDER (superseded) card while the holder card is the live one. The executor now resolves
   the current holder itself, so please relax the handler check to "the item carries this event" (`item.calendarEventId` equals the
   candidate's event) - and `undoViewOf` (same `rev.itemId !== item.id` rule) so the holder card shows the Undo of an older revision.
   Your request #5: the read-all-chats confirmation uses the existing `settings.readTools.confirmTitle/confirmBody/confirmAllow/
   confirmKeep` keys (`confirmBody` needs `{{vendor}}`; with `vendor === null` the dialog shows `settings.readTools.desc`).
3. **V2-W1-12 (locales)** - W0 seeded the automatic toast titles as `notify.auto.added.title`, `notify.auto.added.moved.title`,
   `notify.auto.added.cancelled.title`, `notify.auto.undone.undoFailed.*` (UX2 14.3 intends `notify.auto.moved.title`, ...,
   `notify.auto.undoFailed.*`). I use the seeded keys; if you rename them, tell me/W2-01 (one table: `WRITE_TITLE_KEY` in notifications.ts).
4. **Orchestrator** - record the additive refinements of "Decisions" 1-2 in `docs/specs/v2-wave0-seams.md` / DECISIONS; decisions 3-8
   are behaviour choices where the specs are silent or contradictory (esp. 3: GONE/FOREIGN need a write-ahead to reach `failed`).
5. **V2-W2-02** - `tests/security/auto-mode.injection-corpus.test.ts` Part B needs the composed auto:* channels (compose wave0 stub
   answers INTERNAL today); extend it to the full corpus replay with a live `on` policy (T2 8.4 (h)/(i)) once W2-01 lands.
6. **V2-W1-10 / V2-W2-01** - `auto:export` titles its save dialog with the literal "Automatic activity": HandlerDepsV2 carries no i18n.

## BLOCKED-BY

- **V2-W2-01**: `tests/integration/{auto-mode.flow,editing-executor,recovery-v2}.test.ts` (compose() wiring of tryAuto, the auto:* handlers,
  the dialog seam and the v2 pipeline's change cards) and `tests/security/auto-mode.injection-corpus.test.ts` Part B (auto:getState through
  compose answers INTERNAL from `wave0HandlerDepsV2`).

## Typecheck / suite state at hand-off

`npm run typecheck`: exit 0 (no error anywhere at my last run). Full `main + security + integration` run: the only red tests
of my package are the four BLOCKED-BY items above; the other reds belong to lanes still in progress (agy, pipeline-edit / -image /
-voice / -wa-tools, cli-provider, injection-corpus new vectors).
