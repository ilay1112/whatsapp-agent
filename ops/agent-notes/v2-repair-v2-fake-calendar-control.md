# v2-repair-v2-fake-calendar-control - notes

Task: REQUEST 12 of `ops/agent-notes/V2-W2-03-e2e.md`. The child-mode fake calendar (`WCA_MCP_CMD`) had no control channel, so a
Google-side user edit before an undo (drift -> `blocked_changed`) could not be driven end to end, and `drift` /
`precondition_412` only acted on the first call. Owned paths this round: `tests/fakes/**` (+ one new test file).

## What changed

1. `tests/fakes/fake-mcp-calendar.ts`
   - New exported dispatcher `applyCalendarControl(fake, verb, args)` + `CALENDAR_CONTROL_VERBS`, `CalendarControlVerb`,
     `CalendarControlState`, `calendarControlError()`. Verbs:
     - `userEditsInGoogle {eventId, patch:{summary?,start?,end?,location?,status?}}` - the edit happens NOW (etag/updated/sequence move);
       answers the stored event.
     - `drift {eventId?, minutes=60, count=1}` - arms one-shot drifts consumed by the NEXT matching get-event(s); repeatable, per event
       (`eventId` absent = any event).
     - `precondition_412 {eventId?, count=1}` - the NEXT matching update-event(s) answer the vendored 412 text (etag bumped first).
     - `scenario {name}` / `clearScenario {name}` - add / remove a NON-schema v2 scenario (`status_field_absent`/`ifmatch_absent` refused:
       the host checks tools/list once per start). Clearing `drift` also resets its per-event "already drifted" set.
     - `failNext`, `delay`, `setBusy` (same semantics as the in-process wrapper), `state`, `ping`.
     - Malformed payloads throw with a reason (never a silent no-op).
   - Inside `createFakeCalendar`: two armed queues (`armedDrifts`, `armedPreconditions`) consumed in get-event (after the existing
     `drift` scenario) and update-event (after the existing `precondition_412` scenario, before the If-Match check). Internal hooks
     `__armDrift`, `__armPrecondition`, `__clearScenario`, `__controlState` (same `__` pattern as `__setBusy`). Nothing changes when
     nothing is armed.
   - Child mode: `--control-port <n|0> --control-secret <s, >= 8 chars> [--control-port-file <path>]` starts a 127.0.0.1-only HTTP
     server: `POST /__control/<verb>`, header `X-Control-Secret` (constant-time compare; wrong secret / method / path = 404, unknown
     verb = 404 with reason, bad payload = 400 with reason, > 1 MB = 413). Bound port journalled as `{kind:'control', detail:{port}}`
     (and written to the port file). Every verb journalled as `control_verb {verb, ok}`. Missing/short secret = `control_error` and NO
     listener (the MCP server still runs). The listener is `unref()`'d and answers `Connection: close`, so it never keeps the child
     alive after the app closes stdio (tested: stdin end -> exit 0).
   - The `--control-secret` value is replaced by `[REDACTED]` in the journalled `argv`.
   - **Fix-up found while testing (pre-existing gap):** the journal flush timer (50 ms, unref'd) never ran after the last calls when the
     host closed stdio within 50 ms, so the tail of the `call`/`violation` journal - what the e2e ledger checks - was lost. Added a
     synchronous `process.on('exit', flush)`. (A SIGKILL/TerminateProcess still loses the last <50 ms; a natural stdin-close exit does not.)
   - Removed nothing from the in-process API; `createFakeMcpCalendar` / `FakeMcpCalendar` / `FakeCalendar` are unchanged.
   - Still strip-safe (`node:module.stripTypeScriptTypes` mode `strip` + `node --check` OK): no class, no `satisfies`, built-ins only
     (`node:http`, `node:crypto`), so the packaged smoke's `.mjs` copy is unaffected.
2. NEW `tests/fakes/fake-mcp-calendar-control.ts` (no SDK import, safe for Playwright helpers): `newCalendarControlSecret()`,
   `calendarControlArgv(secret, port=0, portFile?)`, `controlPortFromJournal(journal)` (LATEST port: the app may respawn the child),
   `waitForCalendarControl(journal, secret, timeoutMs)` (polls the journal + `ping`), typed `calendarControl(ep, verb, args)`.
3. NEW `tests/integration/fake-calendar-control.test.ts` (7 tests): in-process userEditsInGoogle -> stale-etag 412; repeatable/per-event
   drift + unchanged `drift` scenario + clearScenario re-arm; per-event precondition_412 x2 then success; refusals; wrapper API unchanged;
   a REAL stdio child driven over MCP while edited through the control port (secret enforced, secret not journalled); listener never
   keeps the child alive + port file + no-secret = no listener.

## Hand-off to the e2e owner (tests/e2e is NOT mine - not edited)

`tests/e2e/helpers/fakes.ts mcpChild()` needs (a) `...calendarControlArgv(secret)` appended to the child args when a spec asks for
control, and (b) a `control()` accessor using `waitForCalendarControl(journalFile, secret)` + `calendarControl(...)`. Then
`undo.spec` "drift before undo => blocked_changed" = create/move via the UI, `calendarControl(ep, 'userEditsInGoogle', {eventId, patch})`,
click Undo, expect `blocked_changed`. The `control` / `control_verb` / `control_error` journal kinds are ignored by the current ledger
feed (it reads only `call` and `violation`).

## Verification (2026-10-04)

- `npx vitest run tests/integration/fake-calendar-control.test.ts`: 7/7, three consecutive runs.
- `npx vitest run --project main --project integration --project security --exclude tests/integration/mcp-real-toolslist.test.ts`:
  245/246 files, 6303 passed, 1 expected fail, **1 failed**: `golden.v2.test.ts > part 2b > claude_cli he-ev-03` (spawned Claude-CLI
  fake parity). It passed alone (`-t he-ev-03`) and the whole file passed 84/84 on rerun - a load flake under the full parallel run,
  not related to the calendar (the in-process calendar path is unchanged unless a control verb is sent). Reported, not hidden.
- Excluded on purpose: `mcp-real-toolslist.test.ts` (spawns the vendored real calendar MCP server; I did not touch annotations or schemas).
- `npx tsc -p tsconfig.tests.json --noEmit` clean, `tsc -p tsconfig.node.json` clean, `eslint tests/fakes <new test> --max-warnings 0`
  clean, `prettier --check` clean.
- Other agents were editing `src/**` / `scripts/**` concurrently (git status shows their files); I touched only the three paths above.

## Assumptions / dead ends

- HTTP port chosen over a `--control <file>`: a file gives no acknowledgement, and a spec must know the Google edit landed before it
  clicks Undo. Port 0 + journalled port avoids a pre-picked-port race and survives a respawn (latest entry wins).
- `state` does not report a call count: child mode shifts `fake.calls` into the journal, so the journal is the only call record.
