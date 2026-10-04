# V2-W1-02-calendar-mcp - working notes

Package brief: `docs/specs/v2-build-plan.md` section 7 `### V2-W1-02-calendar-mcp`. Worked 2026-09-28/29. Fresh start: no partial
implementation from an earlier attempt existed (only the W0 stubs and the W0 test edits).

## Status: done (all owned tests green, lint + format clean, typecheck clean in owned files, coverage met)

## What was built (owned paths only)
- `scripts/stage-calendar-mcp.mjs` - the SEVEN B4 insertions as data (`PATCH_INSERTIONS`: anchor, mode after/before/replace, text, marker),
  `applyPatch` (refuses already-patched, any anchor count != 1, never partial), `revertPatch` (exact inverse, used by the contract test
  once W2-04 has patched in place), `patchBytes` (only the pinned unpatched sha; a known patched sha that differs = drift), `patchOnly`
  (F25: temp copy `<out>/build/index.js` + `<out>/package.json`, never npm, never touches the staged bundle; `--write` records the pins),
  `patchInPlace` (full mode after `npm ci`; already-patched-with-pinned-bytes = verified, nothing written), `--check` (staged AND patched).
  Only mode run by me: `--patch-only --write` (offline) to create the pins.
- `vendor/calendar-mcp.pin.json` - `bundleSha256Unpatched` = sha of the locally staged 2.6.3 `build/index.js` (installed by W0/v1 from the
  committed lockfile, `3fc4202c...`), `bundleSha256Patched` (`c80c8980...`), `patch: 'status+requestBody.status+ifMatch'` (C2 literal),
  `insertions: 7`, and the tool-list pin (`enabledTools` = the 8 names sorted + `enabledToolsSha256`). There was NO v1 tool-list hash pin
  anywhere in the repo (searched); the pin now lives in this file.
- `vendor/calendar-mcp.patch.json` - the 412 text (`preconditionErrorText`), the regex it must match, and all seven anchors/texts/markers.
  Generated from the script; a test fails on any drift between the two.
- `tests/fakes/fake-mcp-calendar.ts` v2 (T2 3.7 in full) - see "Fake behaviour" below.
- `mcp/projection.ts` - `projectOwnedEvent`, `projectUpdatedEvent`, `classifyEventErrorText` (412 > not_found > invalid_args > bad_response),
  `isEtagFieldRejection`, `eventTextHasEtag`, `GET_EVENT_FIELDS`. Raw text never leaves; description / e-mails / links / conflicts dropped.
- `mcp/readClient.ts` - `getEvent` (ids validated before the wire: calendar id regex + base32hex `EVENT_ID_RE`, account pinned, fixed
  field list). No write method (type + runtime test).
- `mcp/writeClient.ts` - `updateEvent` built key by key in `UPDATE_EVENT_KEYS` order, never spread; defence-in-depth validation
  (`invalid_args`, zero calls) incl. "no If-Match etag => no PATCH at all"; 412 => `precondition`, 404/410 => `not_found`.
- `mcp/host.ts` - startup contract: 8 names, readOnlyHint on the 4 reads, `destructiveHint` on update-event (`'destructive_hint'`),
  required `calendarId,eventId` for get-event/update-event; `verifyUpdateSurface` (pure); `updateSurface()`; `callerFor('write')` refuses
  `update-event` with `unavailable` + audit `toolset_mismatch {reason}` while the surface is off (creates unaffected); F12 observation of
  every get-event result (no etag, or the unpatched `fields` enum refusing etag => surface off, audit `toolset_mismatch {reason:'etag_missing'}`,
  sticky); optional `McpHostExtras.onUpdateSurface` callback.
- `mcp/adminClient.ts` - `accessRoleOf` (anything else/absent => `'unknown'`), `writable` = owner|writer (a MISSING role is no longer
  writable - C2 11), `calendarRolesOf`, `parseCalendarRolesJson` (garbage/unknown => absent, `__proto__` safe).
- `mcp/googleAuth.ts` - optional `GoogleAuthExtras.persistCalendarRoles` called after every successful list-calendars (wizard sign-in and
  `listCalendars()`); a throwing hook is logged (`google.calendar_roles_persist_failed`) and never breaks the wizard.
- Tests: `src/main/mcp/{host.v2,host.fakeCalendar,readClient.v2,writeClient.v2,projection.v2,adminClient.v2}.test.ts`, edits to the
  W0-adapted `host.test.ts` (destructiveHint + patched schema in the client doubles) and `adminClient.test.ts` (absent role not writable),
  `scripts/stage-calendar-mcp.test.mjs` (rewritten: fixture trees only), `tests/integration/mcp-real-toolslist.test.ts` v2,
  `tests/security/never-delete.test.ts`.

## Verification (commands run)
- `npx vitest run --project main src/main/mcp scripts/stage-calendar-mcp.test.mjs` green (only failure in the folder is W1-05's
  `toolServer.test.ts`, not mine).
- `npx vitest run --project integration tests/integration/mcp-real-toolslist.test.ts` green: the `--patch-only` output of the REAL staged
  bundle is spawned (initialize + tools/list only) together with the unpatched bundle; fake `patched:true` deep-equals the patched server
  and `patched:false` deep-equals the unpatched one (names, required, annotations, status enum, ifMatch, get-event `fields` enum incl./excl. etag).
- `npx vitest run --project security --project integration` : 36 files / 829 tests green (includes never-delete).
- Full `--project main`: 1 failure, W1-05's `toolServer.test.ts` (in progress by that lane).
- Coverage (owned src): writeClient 100/100/100, projection 100/98.3/100, readClient/adminClient/googleAuth 100, host 100/93.8/96.2.
- `npx eslint <owned paths> --max-warnings 0` and `prettier --check <owned paths>` clean. `npm run typecheck`: no error in owned files.

## INCIDENT (reported honestly) - staged bundle patched in place by a test run, then restored byte-identically
The v1 test `main() ... reports "already staged"` called `main([])` against the REAL tree. After my rewrite, default mode = "staged =>
patch in place", so one run of `scripts/stage-calendar-mcp.test.mjs` (2026-09-28 ~23:49) patched
`build-resources/calendar-mcp/node_modules/@cocal/google-calendar-mcp/build/index.js` in place (the brief allows only `--patch-only`
on a temp copy; the in-place patch is W2-04's). Found when I checked the sha; restored with `revertPatch` and verified the restored sha
equals the pinned unpatched sha `3fc4202c...` (= the sha I measured before starting). No network, no npm, nothing executed. Fix: the
stage test now runs every writing `main()` call against temp fixture trees (`paths` injection) and an `afterAll` asserts the real staged
bundle is byte-identical. The staged bundle was re-checked after all later runs: unpatched, unchanged. Other agents' tests that ran in
that window would have seen a patched bundle; nothing else in the repo reads it except the (then updated) contract test.

## Fake behaviour (T2 3.7) - for W1-04 / W2 test authors
- Constructor `patched` (default true). `patched:false`: get-event `fields` enum without etag (the SDK refuses it with the zod text
  "Invalid option: expected one of ... at fields[0]"), no etag ever emitted, update-event has neither `status` nor `ifMatch`.
- `scenario(s)` is ADDITIVE (several active). Schema scenarios `status_field_absent` / `ifmatch_absent` must be set before connect()
  (the wrapper throws after connect). Also constructor option `v2Scenarios`.
- `drift` fires on the FIRST get-event of each event AFTER activation (+1 h, etag bump) - activate it after the create's readback.
- `precondition_412` is ONE-SHOT (and bumps the etag like a user edit); `precondition_412_always` (extra) is sticky.
- `timeout` applies the patch and never answers; `crash_after_patch` applies it and closes the server (caller sees `unavailable`).
- `restore_refused`, `readback_mismatch` (+30 min), `private_map_replace` (default = merge), `attendees`, `foreign_tags`, `event_missing`,
  `gone_410`, `access_role:<owner|writer|reader|freeBusyReader|unknown|absent>` (default owner).
- Violations are computed on the RAW tools/call arguments (protocol-level interception, before the SDK strips unknown keys):
  `update_event_forbidden_key:<k>`, `update_event_scope_key`, `update_event_send_updates:<v>` (absent = `undefined`),
  `update_event_check_conflicts`, `update_event_without_ifmatch`, `update_event_private_map:<missing,extra:k|shared>`,
  `update_event_identity_changed`, `update_event_status:<v>` (tentative is refused), `update_on_foreign_event:<untagged|attendees|
  recurrence|recurring_instance|not_self>`, and `write_or_disabled_tool_called:delete-event` for ANY delete-event call, registered or not.
- `onBeforeCall(cb)` probes run synchronously when the tools/call arrives. `userEditsInGoogle`, `storedEvents` (copies), `appCreated`.
- Seeds: `FakeEvent` gained optional v2 fields incl. `createdByApp` (ledger rule 9 treats such a seed as made by an app create-event).
- Ledger helpers: `neverDeleteProblems(calls)` (rule 8), `neverForeignProblems(fake)` (rule 9: foreign violations + every update-event
  must target an `appCreated` event with the same waAgent/waItem/waAction).
- The 412 text is read lazily from `vendor/calendar-mcp.patch.json` (walks up from the fake), so the type-stripped copy of smoke check 2
  still loads.

## Decisions / assumptions
- `UpdateSurfaceProblem` is frozen to `'status_missing' | 'ifmatch_missing'`. Before the first verified tools/list the host reports
  `{available:false, problem:'status_missing'}` (fail closed, "not verified"); the F12 etag-missing observation reports `'ifmatch_missing'`
  (the If-Match machinery cannot work without an etag). See REQUESTS.
- The etag-missing flag is sticky for the host's lifetime (the bundle cannot change while it runs). The list-derived problem wins when both exist.
- `isEtagFieldRejection`: zod 4 names the allowed options, not the refused value; every other field the app requests exists in 2.6.3,
  so "validation error about `fields` whose allowed list lacks \"etag\"" == insertion 6 missing.
- `OwnedEventProjection.timeZone` = the event's own `start.timeZone` (fallback `end.timeZone`); an event without a zone is not projected
  (bad_response) - the app always creates with a zone.
- `hasAttendees` / `hasRecurrence` fail closed on odd shapes (present and not an empty array => true).
- writeClient tag charset: `waItem/waAction/waUpdate/waRev` must match `[A-Za-z0-9-]{1,64}` (app-authored ids); projection accepts any
  printable ASCII token <= 128 so a stranger tag is still visible to the foreign check.
- `never-delete.test.ts` allows the literal in exactly two places: `BLOCKED_NAMES` (spec) and `src/main/llm/scripted.fixtures.ts`
  (test-support attack fixture: the attacker model asking for delete-event).
- The contract test writes its temp copies to `build-resources/calendar-mcp/node_modules/.wca-patch-check-*` (git-ignored; dot-folders
  are not counted by smoke check 4a) so the copy resolves the bundle's own dependencies; removed in afterAll.

## REQUESTS
- **orchestrator (C2 11)**: consider adding `'etag_missing'` and `'unverified'` to `UpdateSurfaceProblem`; today they are reported as
  `'ifmatch_missing'` / `'status_missing'` (behaviour identical: surface off, fail closed). The audit row already says `etag_missing`.
- **V2-W2-01 (compose)**: wire `createMcpHost({... onUpdateSurface: (s) => healthHub.setCalendarUpdates(s.available) })` (the boot value
  is unavailable until the first tools/list); `createGoogleAuth({... persistCalendarRoles: (r) => repos.meta.set('calendar_roles_json',
  JSON.stringify(r)) })`; `AutoPolicyService.calendarRoles = () => parseCalendarRolesJson(repos.meta.get('calendar_roles_json'))`
  (from `mcp/adminClient.ts`); `ActionExecutor.updateSurfaceAvailable = () => host.updateSurface().available`.
- **V2-W1-04 (exec + ledger)**: (a) wire `neverDeleteProblems` / `neverForeignProblems` from `tests/fakes/fake-mcp-calendar.ts` into
  `tests/helpers/ledger.ts` rules 8/9 (the `calendar` source then needs `appCreated`, and `violations`); (b) re-read
  `updateSurfaceAvailable()` AFTER the pre-flight `getEvent` (the pre-flight itself can switch the surface off, F12) and treat
  `etag === null` and a pre-flight `invalid_args` as `CAL_UPDATE_UNAVAILABLE` (manual) / `unknown_prev_state` (auto); (c) the host refuses
  `update-event` with `{ok:false,error:'unavailable'}` while the surface is off - never map that to `unknown_outcome` (nothing left the app).
- **V2-W2-04 (packaging)**: `npm run stage:mcp` (in `verify`) now patches in place after `npm ci` and needs the committed
  `vendor/calendar-mcp.pin.json`; it verifies (no rewrite) when already patched; `--check` now means "staged AND patched". Smoke check 1
  can compare against `pin.enabledTools` and `bundleSha256Patched`. THIRD_PARTY_NOTICES: the patch notice. The upstream PR text for the
  seven insertions (B4/F37) is not written by me (docs are the orchestrator's; `vendor/calendar-mcp.patch.json` has every insertion).

## BLOCKED-BY
- none.

## Typecheck errors seen elsewhere (not mine, not touched)
`src/main/agent/draft.loops.test.ts`, `src/main/ipc/handlers/cli.test.ts`, `src/main/ipc/handlers/voice.test.ts`,
`src/main/llm/cli/claudeCli.test.ts`, `src/main/llm/factory.cli.test.ts`, `src/main/mcp/toolServer.test.ts` (W1-05),
`src/main/proc/jobRunner.test.ts`, `src/main/voice/service.test.ts` - all files of lanes still in progress.

## Dead ends
- Placing the patched copy under the OS temp dir: the bundle imports bare specifiers (`googleapis`, the SDK, zod) and reads
  `../package.json`, so it only runs from inside the staged tree's module-resolution scope; hence the `.wca-patch-check-*` dot folder.
- Recognising the unpatched `fields` refusal by the word "etag" failed: zod 4 lists the allowed values only (probed against the fake,
  which uses the same SDK 1.30.0 / zod 4.6.5 as the staged server).
