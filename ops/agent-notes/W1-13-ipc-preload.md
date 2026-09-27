# W1-13-ipc-preload — working notes

Owner of: `src/preload/**`, `src/main/ipc/{register,sender}.ts`, `src/main/ipc/handlers/{app,items,settings,secrets,llm,model,pairing,google,data}.ts`, `resources/links.json`
(NOT `src/main/ipc/handlers/actions.ts` — that is W1-11-exec.)
Support file I added under my own prefix: `src/main/ipc/register.fixtures.ts` (HandlerDeps doubles for the colocated handler tests).

Status: **done**. All owned source implemented, no `NotImplementedError` left, lint clean, typecheck clean in owned files,
`npx vitest run --project main src/main/ipc src/preload` = 13 files / 140 tests green (post-fix-round; 12/123 before, plus
W1-11's `actions.test.ts` and my two new `SettingsBus` contract rows), coverage 100 % lines / 100 % functions on every
owned file, branches 98.38 % overall with `handlers/app.ts` at 92.59 % (see "Known gaps").

---

## What was already there when I resumed

An earlier interrupted attempt had left `sender.ts`, `register.ts`, `register.fixtures.ts` and all nine handler files
implemented, plus tests for `sender`, `register`, `app`, `items`, `secrets`, `settings` and the preload source-text parity
test. I continued from that rather than restarting; the gaps I closed are listed under "This session".

## This session

1. `handlers/llm.test.ts`, `handlers/model.test.ts`, `handlers/pairing.test.ts`, `handlers/google.test.ts`,
   `handlers/data.test.ts` — the five handler files that had no colocated test.
2. `src/preload/index.test.ts` — added a **runtime** half. The original test only parsed the source text, which left the
   module at 0 % coverage while TESTS section 13 demands 100 % on `src/preload/**`. The new block loads the module with a
   throwaway `electron` double (`vi.doMock`, scoped to the file) so `tests/mocks/electron.ts` — owned by W0 → W1-12 — is
   neither edited nor mutated, and exercises: every allow-listed channel forwarded, unknown channel → `BAD_REQUEST` with
   no `ipcRenderer` touch, event subscribe/unsubscribe, the listener receiving only the payload (never the
   `IpcRendererEvent`), and all four `--wca-lang` / `--wca-dir` paths of `arg()`.
3. `handlers/app.test.ts` — added the `resources/links.json` parity block required by the hot-spot protocol of build-plan
   1.2: keys **equal** `EXTERNAL_TARGETS` (no extra, none missing), every value an absolute `https://` URL with no
   credentials, and `[R2]` `vcredist_download` pinned to `https://aka.ms/vs/17/release/vc_redist.x64.exe`.
4. `register.test.ts` — added two rows: `windowState()` is sampled **fresh per call** (three different `IpcContext`
   values in a row, `shownByNotificationAt` included), and it is sampled **only after** the sender check and the parse, so
   a refused call cannot be used to probe whether the window is focused.
5. `handlers/settings.test.ts` — added a row proving the handler performs no side effect of its own (no
   `ElectronFacade` call, no `onChange` subscription): the language / tray / autostart effects hang off
   `SettingsBus.onChange`, which `compose.ts` subscribes once.
6. `register.ts` — JSDoc only (no shape change to the frozen seam): documented that `patch()` and `setInternal()` MUST
   notify `onChange` subscribers, and which fields each one is for.
7. `handlers/llm.test.ts` / `handlers/model.test.ts` — `TierInfo.status` fixtures corrected from `'absent'` (not a member)
   to `'none'` after `tsc -p tsconfig.tests.json`.

## Fix round (post-audit, 2026-09-23)

The repo-wide audit (`ops/agent-notes/wave1-audit.md`) found **no defect in this package** — section 2 lists no red
item owned by W1-13, section 2.4 lists no stub of mine, and section 4.2 closes my one open request (W1-11 shipped
`handlers/actions.test.ts`). The two items the fix round handed me are both entries from audit **section 5**
("Wave-2 backlog carried out of Wave 1"): they are *my* requests **to** W2-01, and both land in files I do not own
(`src/main/compose.ts`, `vitest.config.ts` — the latter frozen in Wave 1). I did not touch either file. What I did
instead, entirely inside my owned paths, was make the first one impossible to miss and re-file the second:

1. **`register.fixtures.ts`: the `SettingsBus` double now really notifies.** It used to be `onChange: () => () => {}`
   — a no-op — while `patch()` and `setInternal()` wrote. That was the wrong shape for anyone to copy into `compose.ts`
   and it made the "handlers own no side effect" story untestable. The double now keeps a subscriber set, fires every
   subscriber after a successful `patch()` **and** after `setInternal()` (with the Settings *after* the write, deep-cloned
   per subscriber), and returns a working unsubscribe. Deliveries are recorded in the new `Recorders.settingsNotified`.
2. **New export `assertSettingsBusContract(bus)`** in `register.fixtures.ts` — a runner-agnostic conformance check
   (the file imports no test framework, so `compose.ts`'s own test can call it). It asserts: `patch()` writes, returns the
   merged object and notifies exactly once with the post-write value; `setInternal()` does the same for a main-only field
   (`agent.paused`); the function returned by `onChange()` actually stops delivery. It throws an `Error` naming the first
   violated rule and leaves the bus at its original language / paused value. **This is the executable form of the request
   to W2-01** — running it is one line in their test.
3. **`register.test.ts`: two rows** proving the check is not vacuous — the fixture bus conforms (and exactly two
   notifications are delivered for the two writes made while subscribed), and three deliberately broken buses
   (patch that does not notify, setInternal that does not notify, dead unsubscribe) each throw a distinct message.
4. **`vitest.config.ts` `.fixtures.ts` coverage exclude: not actioned — not my path and frozen in Wave 1.** The
   `/* v8 ignore start|stop */` pair in `register.fixtures.ts` stays until W2-01 lands the glob; with it in place the file
   contributes nothing to the report (it does not appear in the coverage table at all). Re-filed under REQUESTS.

Verification after the fix round (from `"C:\dev\whatsapp agent"`):

```
npx vitest run --project main src/main/ipc src/preload      # 13 files, 140 tests, green (was 138)
npx eslint src/preload src/main/ipc --max-warnings 0        # clean
npx tsc --noEmit -p tsconfig.node.json                      # clean
npx tsc --noEmit -p tsconfig.tests.json                     # clean in owned files; 2 errors in src/main/proc/supervisor.test.ts (W1-01)
coverage over src/main/ipc/** + src/preload/**              # 100 % lines / 100 % functions / 98.38 % branches
npx vitest run --project main                               # 103 files, 2518 tests, green
```

Notes on other packages observed while verifying (NOT fixed, not mine):

- `src/main/proc/supervisor.test.ts(897,14)` TS2304 `EpochMs` and `(908,23)` TS2552 `SupervisorDeps` — **W1-01-proc-health**.
  These are new since the audit (which reported three `src/shared/when.test.ts` errors, now gone), so `npm run typecheck`
  is still red repo-wide for a reason outside my paths.
- One `--project main` run mid-session showed 7 failures in 3 files (`scripts/fetch-llama.test.mjs` "copies exactly the
  three named files", plus `bridge/launcher` rows); an immediate re-run of the same command was fully green. Other agents
  are writing the tree right now, so I recorded this as flakiness/interference rather than a defect, and it is not in my files.

## Design decisions and why

- **`isTrustedSender` parses the URL, never string-matches it.** `startsWith('app://bundle')` would accept
  `app://bundle.evil.example/` and `app://bundle@evil.example/`; the check compares `protocol === 'app:'`,
  `host === 'bundle'` and demands empty `username`/`password`. It also requires the event's `sender.id` to equal our
  window's `webContents.id` (a devtools view or a second window is never trusted) and `senderFrame.parent === null`
  (no sub-frame). `sender.test.ts` + a full pass over every channel in `register.test.ts` cover
  `https://evil.example`, `file://` and the iframe case.
- **One refusal shape for everything.** Untrusted sender, failed parse and a throwing `windowState()` all return the same
  `{ok:false,error:{code:'BAD_REQUEST'}}`, so the renderer cannot tell which check fired. A handler exception becomes
  `INTERNAL` and only the channel name + error *name* are logged — a thrown message can echo model output, a provider
  response body or a path.
- **Audit details are enum-only.** `ipc_rejected` carries `{reason: 'untrusted_sender'|'bad_payload'|'window_state'}` and
  the channel name; never the payload. `purge` carries three row counts; `settings_changed` carries the changed group
  *names*, never values.
- **`external:open` resolves an enum, and `calendarEvent` is built, not forwarded.** `[R2]` the stored
  `items.calendar_html_link` is never opened or returned; the handler formats `event_start_ts` with
  `Intl.DateTimeFormat('en-CA', {timeZone})` and interpolates only three digit groups it has regex-checked, so no
  attacker-influenced text can reach the URL. A missing or non-`https://` `links.json` entry opens nothing.
- **`settings:set` does one extra check and no more.** The whole allow-list *is* `SettingsPatchSchema` (strict-parsed in
  `register.ts`), so `llm.provider`, `agent.paused`, `llm.local.forceCpu` and `[R2]` `general.timeZone` cannot arrive at
  all. The one value set that lives outside the schema is a calendar id, so the handler refuses any non-`primary` id that
  the last `listCalendars()` did not contain (`CAL_RECONNECT` when the list is unavailable).
- **LLM metadata calls time out through the injected clock**, not `globalThis.setTimeout`, so a virtual clock drives them
  and the test suite has no real timer. A non-`LlmError` throw collapses to `CLOUD_UNAVAILABLE` rather than being mapped,
  because an SDK error object can carry an echo of the prompt.
- **Model channels take a tier enum.** `model.test.ts` asserts against the real schema that `{tier:'https://…'}`,
  `{tier:'tiny', url:…}` and `{url:…}` are all rejected before any handler runs. An omitted tier resolves to the pinned
  setting, or to `plan().selectedTier` when the setting is `'auto'` — the download source stays the compile-time manifest.
- **No path crosses IPC in the Google flow.** `google:pickCredentialsFile` opens the native dialog in main via the facade
  with `maxBytes: LIMITS.credentialsJsonBytes` (16 KiB) and feeds the returned **content** into the same
  `importCredentials` validation path as a pasted payload; a cancelled dialog returns the unchanged wizard state.

## Known gaps / accepted

- `handlers/app.ts` branches = 92.59 %. The uncovered branch is the `?? ''` fallback in `calendarDayUrl`'s
  `formatToParts` part lookup — defensive only: with a valid zone `Intl` always returns `year`/`month`/`day`, and an
  invalid zone throws and is caught one level up (that path *is* covered). Non-safety-critical file; the global
  `src/**` branch target is 80 %.
- `src/main/ipc/register.fixtures.ts` is test-support code that `vitest.config.ts`'s `coverage.exclude` does not match
  (it only excludes `**/*.test.*`), so its inert doubles were counting as uncovered production lines (65 % L / 43 % F).
  Wrapped in `/* v8 ignore start */ … /* v8 ignore stop */` with the reason comment TESTS section 13 requires; the file is
  outside the safety-critical set. `/* v8 ignore file */` is **not** honoured by vitest 4's AST-aware v8 provider — only the
  start/stop form works. See REQUESTS.
- ~~`handlers/actions.ts` (W1-11) sits at 0 % coverage in my run~~ — **closed in the fix round**: W1-11 shipped
  `handlers/actions.test.ts` (15 tests), it runs inside my `src/main/ipc` invocation and the perFile hole is gone.

## BLOCKED-BY

None. Every owned test passes against real collaborators or local doubles; no other package's Wave 0 stub is on my path.

## REQUESTS

- **W2-01-compose-integration** (still open; `vitest.config.ts` is not my path and is frozen in Wave 1) — add a glob for
  `.fixtures.ts` files to `coverage.exclude`. The `/* v8 ignore start|stop */` pair in `src/main/ipc/register.fixtures.ts`
  exists only to work around its absence and can be deleted once the exclude lands. Until then the file is fully ignored,
  so it does not distort the report.
- **W2-01-compose-integration** (still open; the bus lives in your `compose.ts`) — the `SettingsBus` you implement MUST
  fire every `onChange` subscriber after a successful `patch()` **and** after `setInternal()`. The IPC handlers own no side
  effect, so the language switch (`ui:languageChanged` + main-process i18n), the tray rebuild and the autostart
  registration only happen if the bus notifies. Two things now make this checkable rather than a prose request:
  the JSDoc of `SettingsBus` in `src/main/ipc/register.ts`, and **`assertSettingsBusContract(bus)` exported from
  `src/main/ipc/register.fixtures.ts`** — call it once from `compose`'s own test:
  `import { assertSettingsBusContract } from '../ipc/register.fixtures'; assertSettingsBusContract(runtime.settings);`
  It throws an `Error` naming the first violated rule, imports no test framework, and restores the two values it flips.
- **W2-01-compose-integration** — wire `RegisterIpcOptions.windowState()` so `shownByNotificationAt` is the timestamp
  `app/notifications.ts` set when a toast click showed the window, and so it is cheap: `register.ts` calls it once per
  invoke and treats a throw as a refusal.
- **W1-12-shell-main** — `ElectronFacade.showOpenDialog()` currently takes `{title, filters, maxBytes}` and my handler
  passes an English literal title (`CREDENTIALS_DIALOG_TITLE` in `handlers/google.ts`), because the frozen `HandlerDeps`
  carries no `t`. If you want dialog titles localised, localise them inside the facade (it is the only side that has the
  main-process i18n) rather than widening `HandlerDeps`.
- ~~**W1-11-exec** — `handlers/actions.ts` needs a colocated test~~ — **fulfilled** (audit section 4.2); `actions.test.ts`
  is green. One follow-up note for W1-11: my fixture's `SettingsBus` double now fires `onChange` after `patch()` and
  `setInternal()` (it used to be a no-op). `actions.test.ts` passes unchanged, but a future test that subscribes and
  counts will now see real deliveries.

## Verification run (all from `C:\dev\whatsapp agent`)

```
npx eslint src/preload src/main/ipc --max-warnings 0                 # clean
npx tsc --noEmit -p tsconfig.node.json                               # clean
npx tsc --noEmit -p tsconfig.tests.json                              # clean in owned files (see below)
npx vitest run --project main src/main/ipc src/preload               # 12 files, 123 tests, green
```

Typecheck errors elsewhere in the tree at the time of writing (NOT mine, not fixed — reported per global rule 6):
`src/main/agent/draft.test.ts(11,69)` (W1-10), `src/main/mcp/host.test.ts(404,51)` (W1-05),
`src/shared/when.test.ts(129|140|141)` (W1-08), and `src/renderer/src/components/EventEditor.tsx` `refs` is undefined
(W1-15) which fails `tsconfig.web.json` and therefore short-circuits `npm run typecheck` before the tests project runs.

**Superseded by the fix-round run (2026-09-23):** all of the above are gone. `tsconfig.node.json` is clean and the only
remaining `tsconfig.tests.json` errors are `src/main/proc/supervisor.test.ts(897,14)` TS2304 `EpochMs` and `(908,23)`
TS2552 `SupervisorDeps` — **W1-01-proc-health**, still not mine, still not fixed.
