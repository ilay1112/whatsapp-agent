# ui-sweep (2026-10-19) - every view, menu and button, clicked once

QA agent, READ-ONLY on `src/`. Trigger: user report "the Connect button doesn't work" (Settings > Google Calendar) + "test every
menu and button". The Google Connect root cause is owned elsewhere; it is included here as observed behaviour only.

## What was built

| File | Role |
|---|---|
| `tests/e2e/sweep/harness.ts` | Generic engine: per STATE (scope selector + idempotent `ensure()`), enumerate every visible `button`, `[role=menuitem/radio/button/tab/switch]`, `select`, `input[type=checkbox/radio]`, `a`, `summary` and `[data-testid]` with a React `onClick`; per control: re-enter state, screenshot (box + 200 px, x0.75), click / change, 500 ms (+1.5 s if nothing yet), screenshot, record. |
| `tests/e2e/sweep/sweep.spec.ts` | 5 tests, each its own temp profile: dashboard+menus+sheets+calendar+health+undo drawer (en), dashboard (he), settings+activity (en), settings (he), onboarding from a fresh profile (en). |
| `tests/e2e/sweep/report.mjs` | Builds the tables below from `test-results/sweep/results-*.json` (mechanical verdicts, reviewed by hand in "Findings"). |

Run: `npm run -s build:e2e` then `npx playwright test tests/e2e/sweep --reporter=line --retries=0 --timeout=180000` (5 passed, ~13 min),
then `node tests/e2e/sweep/report.mjs`. Screenshots: `test-results/sweep/<state>-<control>-<lang>-{before,after}.png` (~680 files, ~16 MB).

### How effects are observed (test-side only, nothing in `src/` changed)
- **IPC journal**: the wca facade has no IPC log, so the spec wraps `ipcMain._invokeHandlers.get` in the main process (`app.evaluate`) and
  journals the channel name of every renderer `invoke`. Channels the renderer calls on its own during a 1.5-2.5 s idle sample per state
  are reported as background and excluded from `ipcInvoked`.
- **Native dialogs**: `dialog.showOpenDialog / showSaveDialog / showMessageBox` are replaced in main by stubs that answer "cancelled" and
  journal the title - no native window ever opened. The main-owned automatic-mode / read-scope dialogs go through `WCA_DIALOG_SCRIPT='[]'`
  (scripted Cancel) and are read back with `wca(app).dialogs()`.
- **Clipboard**: `clipboard.writeText` is stubbed (length journalled) - the user's real clipboard was never touched. `ai-key-paste`
  (reads the real clipboard) is never clicked.
- **External URLs**: the existing e2e recorder (`wca(app).openedExternal()`); no browser was opened.
- **Visible change**: hash of `body.innerHTML` + form-control state (checked/value) before vs after, with ticking nodes (QR countdown,
  card times, live regions) blanked; plus view/settings-group, open modal, scroll position, focus moved, "was already selected".
- **Console errors**: `page.on('console' error)` + `page.on('pageerror')`; the fixture's own fail-on-error is switched off with
  `allowConsoleErrors: ['']` so an error is RECORDED as a finding rather than failing the spec. **Zero renderer errors were logged.**

### Safety rules applied
- Approval-class controls are never clicked: `approve-*`, `cancel-event-*`, `add-new-event-*`, `undo-<id>` / `undo-<door>-<id>`,
  `autostrip-undo-*`, `keep-*`, `restore-refused-*`, `consent-accept`, `discard-confirm-yes` (recorded as SKIP).
  The ONE "Add to calendar" click per dashboard profile is SETUP of the in-calendar card on the FAKE calendar (same move as
  dashboard-v3 / edit-change); the reply is never sent. The spec asserts `create-event == 1` and `update-event == 0` afterwards.
  (An earlier iteration of the spec missed the in-card `undo-<id>` pattern and clicked it once on the fake calendar of a temp profile;
  the pattern is now in the skip list and the final run asserts zero `update-event` calls.)
- Destructive controls with a confirm (`settings-wipe`, `-google-disconnect`, `-purge`, `-delete-model`, `-relink`, voice delete,
  `ai-key-remove`) are clicked, the confirm is recorded (`confirm dialog shown: yes/no`) and CANCELLED.
- Dismiss / Never-analyse / Analyse-again / Restore run in a second pass (they change the seeded cards for good); their effect is
  undone through IPC (`item:restore`, `chat:setPolicy default`, `item:dismiss`) by the spec, not through the UI.
- Fakes only: bridge ATTACH (dashboard/settings) or CHILD `needs_pairing` (onboarding), `WCA_MCP_CMD` fake calendar, stub LLM, fake CLIs
  (`claude` not signed in, no `agy`), fake model host; `WCA_MODEL_MANIFEST` absent elsewhere = unreachable loopback URLs. No real
  WhatsApp, Google or model endpoint, no reference store touched.

### Seeded states
(a) onboarding: welcome, choose AI, link WhatsApp (QR / expired / connected via the child bridge control port), Google sub-steps 0-5
(the fake calendar has NO account, so step 5 shows "Sign in with Google"), ready.
(b) dashboard with 4 cards from the stub LLM: scheduling (`[s1]` Wed 15:00, item 1), information missing (`[m1]`, item 2), in-calendar
(`[c1]` + the setup click, item 3), smalltalk (`[t1]`, item 4, hidden by the schedule filter until "Show all") + one dismissed card
(item 5) for the drawer. (c) Settings with every disclosure / `<details>` expanded. (d) Automatic activity (no policy -> empty state).
(e) Undo-dismiss drawer. (f) Health-pill panel (all green: only sub-line buttons). (g) each card's overflow menu + its approval sheet.
(h) calendar toolbar, current week and the week holding the event blocks.

## Counts (final run, 5/5 tests passed, 0 renderer console errors, 0 page errors)

| state | controls | OK | BROKEN | UNCLEAR | SKIP (approval-class) |
|---|---|---|---|---|---|
| (a) onboarding (12 sub-states, en) | 46 | 46 | 0 | 0 | 0 |
| (b) dashboard (en / he) | 38 / 38 | 33 / 33 | 0 | 0 | 5 / 5 |
| (g) overflow menus x4 (en) | 16 | 15 | 0 | 1 | 0 |
| (g) approval sheets x4 (en) | 29 | 23 | 0 | 1 | 5 |
| (h) calendar toolbar + event week (en) | 12 | 12 | 0 | 0 | 0 |
| (f) health panel (en) | 2 | 2 | 0 | 0 | 0 |
| (e) undo-dismiss drawer (en) | 2 | 2 | 0 | 0 | 0 |
| (c) settings, all groups expanded (en / he) | 85 / 85 | 78 / 78 | 0 | 7 / 7 | 0 |
| (d) automatic activity (en) | 2 | 2 | 0 | 0 | 0 |
| **total** | **355** | **324** | **0** | **16** | **15** |

The mechanical verdicts above are re-ranked by hand below: three of the "UNCLEAR"s are real defects (BROKEN), and two rows that read
"OK" mechanically hide a defect that only shows across controls (Findings 1 and 3).

## Findings (ranked)

1. **BROKEN - Undo / Restore of a dismissed card gives it back WITHOUT its approval buttons.**
   Repro: dashboard, scheduling card (item 1: "Send", "Add to calendar", "Edit time") -> X (`dismiss-x-1`; same with menu "Dismiss"
   or sheet "Dismiss") -> toast "Undo" or footer "Undo dismiss" > "Restore". The card returns to Needs reply with its event chip but
   with no `approve-send-*`, `approve-event-*` or `edit-event-*`; the smalltalk card loses its "Send"; the info-missing card loses its
   "Send" (keeps only the fill form). DB afterwards: item `needs_reply / proposed / analysis done`, every action of the item superseded,
   none pending. Evidence: `test-results/sweep/probe-dashboard-en.json` (`before:*` vs `after:*`), rows `dashboard-dismiss-x-*`.
   Pointer (read-only): `src/main/agent/items.ts` `dismiss()` calls `repos.actions.supersedePending(id)`; `restore()` only clears
   `closed_reason` - nothing re-creates or un-supersedes the actions. ux.md 6.10 / v3 2.1 promise "Undo restores it". No console error.
2. **BROKEN - "Analyse again" on an in-calendar card makes the card disappear for good.**
   Repro: in-calendar card (item 3, created by one "Add to calendar") -> `overflow-3` -> "Analyse again" (`retriage-3`): IPC
   `item:retriage` + `dashboard:get`, the card leaves the dashboard; minutes later the item is still `in_calendar / created /
   analysis = queued` (probe json) and `overflow-3` / the sheet can no longer be reached (rows `menu-incal never-3`,
   `sheet-incal (state)` = "ensure failed ... waiting for overflow-3"). Pointer: `items.ts` `retriage()` re-queues a non-open item
   when the chat has no other open item; `orchestrator.ts` `runChat` takes `repos.items.openForChat()`, whose open states exclude
   `in_calendar`, so the queued item is never run. No console error.
3. **UNCLEAR (relevant to the user's report) - Settings > Google Calendar says "Not connected" + "Connect" while the calendar IS
   connected.** Repro: any configured profile, launch, Settings: account row "Not connected" next to "Connect", while the health pill
   says all running, the target-calendar picker lists "Personal - You own this calendar" and cards add to the calendar (screenshot
   `settings-settings-google-reconnect_0-en-before.png`). Clicking "Connect" (`settings-google-reconnect`) invokes `google:startSignIn`,
   which starts a NEW OAuth sign-in and opens `accounts.google.com/o/oauth2/v2/auth?...` (recorded); with the fake (already signed in)
   the row then shows the account e-mail (`..._after.png`). So in e2e the button does act; what the user sees is a misleading status
   and a button that always re-runs the whole browser sign-in. Pointer: Settings loads `google:getWizardState` (snapshot; the account
   e-mail lives only in memory and is null after a restart) and never `google:status` (which polls `manage-accounts list`); the button
   label key is `settings.calendar.reconnect` = "Connect" in both states. The real-MCP leg (what happens in the browser) is NOT covered.
4. **BROKEN - Settings > Working rules > "Chats with their own rule" > "Remove the rule" does nothing for a contact that is listed
   because it was marked as known.** Repro: contacts with `force_known = 1` (every seeded known contact; in real use a contact the user
   marked as known) appear in the list; "Remove the rule" (`settings-policy-remove-<n>`, en and he) invokes `chat:setPolicy {policy:
   'default'}` + `chat:listPolicies`, and the row stays exactly as it was. Pointer: `repos.chats.withPolicies()` lists
   `policy <> 'default' OR force_known = 1 OR auto_policy = 'never'`; Remove only resets `policy`.
5. **UNCLEAR - Settings > AI engine > Claude (subscription, not signed in) > "Sign in" shows nothing.** `connect-signin-claude_cli`
   invokes `cli:signIn` (console recorder `WCA_CONSOLE_DIR` set), but the card did not change within 2 s (v2-ux 7.1: the card enters
   "Finish signing in in the window that opened"). Same in he. cli-signin.spec covers the session flow from the onboarding card; worth
   checking the Settings-embedded card specifically.
6. **UNCLEAR - Settings > Voice notes > "Test" with no voice model downloaded gives no feedback.** `settings-voice-test` invokes
   `voice:selfTest` + `voice:getState`; no "Testing..." and no result/error line within 2 s (v2-ux 4.2: "Testing..." -> "about N s
   per minute of audio"). The button is enabled while every tier reads "not downloaded".
7. **Minor - unchecking the only conflict calendar is silently ignored** (`settings-conflict-primary`): the click is swallowed by
   design (at least one must stay) but nothing tells the user why.
8. **Info** - the onboarding Google sub-step 5 "Sign in with Google" behaves as specified against the fake: `google:startSignIn`,
   recorded `accounts.google.com` URL, "Open the browser again" + disabled sign-in while waiting (`onb-google-5-google-signin_0-en-after.png`).
   Everything else in the wizard (QR expiry -> "New code", Continue after pairing, all Google console links, drop zone -> native open
   dialog, Later, Ready) is OK.

No control produced a renderer console error or page error; every destructive Settings control showed its confirm (cancelled).

## Not covered
- Native dialogs themselves (open/save/message boxes are stubbed to "cancelled"; only the request and its title are verified).
- Tray menu, the close-to-tray coach mark (seeded as seen), Windows notifications / toast buttons (recorded by the e2e build only).
- Real OAuth / the real calendar MCP (the Google leg after the browser), the real bridge, real CLI sign-in consoles, real model downloads.
- Approval-class controls (send, add to calendar, approve / cancel change, undo of a write, consent accept) - covered by
  approval-first / undo / edit-change / dashboard-v3 specs, deliberately never clicked here.
- Automatic-mode states that need a live policy (AutoStrip rows, auto-stop / pause / resume / renew, activity rows, "Never
  automatic"), voice / picture cards, change cards, the DownloadPill popover on the dashboard, error-state health rows and their actions.
- Hebrew for onboarding, menus, sheets, calendar, health and drawer (only dashboard and Settings were run in both languages).
- Text inputs, drag-and-drop, keyboard-only paths, narrow (420 px) layouts.

## Hand-off
- Re-run: `npm run -s build:e2e && npx playwright test tests/e2e/sweep --reporter=line --retries=0 --timeout=180000 && node tests/e2e/sweep/report.mjs`.
  Playwright wipes `test-results/` at the start of every run, so run the whole folder (not one test) when the screenshots matter.
- The spec does NOT fail on a finding; it fails only if the sweep itself writes to the calendar (`create-event != 1`, `update-event != 0`).
- Not committed (QA agent never commits).
- Build under test: `out/` from `npm run -s build:e2e` at 2026-10-19 16:33:58, base commit 5900449 PLUS the uncommitted Google-Connect
  work another agent had in the tree at that time (`src/main/mcp/googleAuth.ts`, `host.ts`, `views/Settings.tsx`, locales - see
  `ops/agent-notes/google-connect-fix.md`). Finding 3 reproduces on that tree (Settings still loads `google:getWizardState` on mount);
  re-run the sweep after that fix lands.

## Per-state tables
Verdict column = mechanical (see `report.mjs` header); the screenshot is the "after" file under `test-results/sweep/`.

#### dashboard (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `health-pill` | Opens the status panel (3 rows, one action each) - ux.md 5.2 | DOM changed; IPC model:getPlan | OK | dashboard-health-pill_0-en-after.png |
| `pause-toggle` | Toggles Pause/Resume (agent:setPaused), header border + pill read "Paused" - ux.md 5.1 | DOM changed; IPC agent:setPaused, auto:listWrites | OK | dashboard-pause-toggle_0-en-after.png |
| button[radio] "עברית" | Language segment: switches UI language + dir without reload - ux.md 5.1 | DOM changed; IPC settings:set, auto:listWrites | OK | dashboard-button_radio_0_16dnk-en-after.png |
| button[radio] "English" | Language segment: switches UI language + dir without reload - ux.md 5.1 | no DOM change; IPC settings:set, auto:listWrites; (was already the selected choice) | OK | dashboard-button_radio_English_0-en-after.png |
| `settings-toggle` | Gear opens Settings; in Settings it is "Back to dashboard" - ux.md 5.1 | view dashboard -> settings/general; DOM changed; IPC llm:getConfig, auto:getState, auto:listWrites, google:getWizardState, google:listCalendars, chat:listPolicies, model:getPlan, llm:getHardware, cli:getStatus, voice:getState | OK | dashboard-settings-toggle_0-en-after.png |
| `schedule-filter-toggle` | Schedule-only filter: "Show all (n hidden)" <-> "Only schedules" - ux.md 6.11 | DOM changed | OK | dashboard-schedule-filter-toggle_0-en-after.png |
| `view-cards` | View switch: card lists - ux.md 6.11 | no DOM change; (was already the selected choice) | OK | dashboard-view-cards_0-en-after.png |
| `view-calendar` | View switch: week calendar - ux.md 6.11 | DOM changed | OK | dashboard-view-calendar_0-en-after.png |
| `overflow-4` | Opens the card overflow menu (Open details / Dismiss / Analyse again / Never analyse) - ux.md 6.5 | DOM changed | OK | dashboard-overflow-4_0-en-after.png |
| `show-more-4` | Shows the rest of the conversation excerpt - ux.md 6.5 | dialog open: item-sheet; DOM changed; IPC item:get | OK | dashboard-show-more-4_0-en-after.png |
| `approve-send-4` | (no spec line found - inferred from the label) | not clicked: approval-class control (never clicked by the sweep) | SKIP | dashboard-approve-send-4_0-en-before.png |
| `copy-4` | Copies the draft/reply text to the clipboard ("Copied") - ux.md 6.7 | DOM changed; IPC clipboard:writeText; clipboard x1 | OK | dashboard-copy-4_0-en-after.png |
| `overflow-1` | Opens the card overflow menu (Open details / Dismiss / Analyse again / Never analyse) - ux.md 6.5 | DOM changed | OK | dashboard-overflow-1_0-en-after.png |
| `show-more-1` | Shows the rest of the conversation excerpt - ux.md 6.5 | dialog open: item-sheet; DOM changed; IPC item:get | OK | dashboard-show-more-1_0-en-after.png |
| `event-chip` | (no spec line found - inferred from the label) | dialog open: item-sheet; DOM changed; IPC item:get | OK | dashboard-event-chip_0-en-after.png |
| `approve-send-1` | (no spec line found - inferred from the label) | not clicked: approval-class control (never clicked by the sweep) | SKIP | dashboard-approve-send-1_0-en-before.png |
| `approve-event-1` | (no spec line found - inferred from the label) | not clicked: approval-class control (never clicked by the sweep) | SKIP | dashboard-approve-event-1_0-en-before.png |
| `edit-event-1` | "Edit time": toggles the inline event editor (no approval) - v3 2.4a | DOM changed; IPC item:setEditing | OK | dashboard-edit-event-1_0-en-after.png |
| `copy-1` | Copies the draft/reply text to the clipboard ("Copied") - ux.md 6.7 | DOM changed; IPC clipboard:writeText; clipboard x1 | OK | dashboard-copy-1_0-en-after.png |
| `overflow-3` | Opens the card overflow menu (Open details / Dismiss / Analyse again / Never analyse) - ux.md 6.5 | DOM changed | OK | dashboard-overflow-3_0-en-after.png |
| `show-more-3` | Shows the rest of the conversation excerpt - ux.md 6.5 | dialog open: item-sheet; DOM changed; IPC item:get | OK | dashboard-show-more-3_0-en-after.png |
| `event-chip` | (no spec line found - inferred from the label) | dialog open: item-sheet; DOM changed; IPC item:get | OK | dashboard-event-chip_1-en-after.png |
| `show-send-3` | "Show" the unsent reply under an in-calendar card - ux.md 6.7 | DOM changed | OK | dashboard-show-send-3_0-en-after.png |
| `open-calendar-3` | "Open in Google Calendar": opens the event (external:open calendarEvent) - ux.md 6.7 | no DOM change; IPC external:open; external https://calendar.google.com/calendar/r/day/2026/10/28 | OK | dashboard-open-calendar-3_0-en-after.png |
| `copy-3` | Copies the draft/reply text to the clipboard ("Copied") - ux.md 6.7 | DOM changed; IPC clipboard:writeText; clipboard x1 | OK | dashboard-copy-3_0-en-after.png |
| `undo-3` | (no spec line found - inferred from the label) | not clicked: approval-class control (never clicked by the sweep) | SKIP | dashboard-undo-3_0-en-before.png |
| `overflow-2` | Opens the card overflow menu (Open details / Dismiss / Analyse again / Never analyse) - ux.md 6.5 | DOM changed | OK | dashboard-overflow-2_0-en-after.png |
| `show-more-2` | Shows the rest of the conversation excerpt - ux.md 6.5 | dialog open: item-sheet; DOM changed; IPC item:get | OK | dashboard-show-more-2_0-en-after.png |
| `event-chip` | (no spec line found - inferred from the label) | dialog open: item-sheet; DOM changed; IPC item:get | OK | dashboard-event-chip_2-en-after.png |
| `event-change-title` | (no spec line found - inferred from the label) | DOM changed | OK | dashboard-event-change-title_0-en-after.png |
| `save-event-2` | "Save time" on an info-missing card: proposes the event (provider=user), no calendar write - v3 2.4b | disabled | OK | dashboard-save-event-2_0-en-before.png |
| `approve-send-2` | (no spec line found - inferred from the label) | not clicked: approval-class control (never clicked by the sweep) | SKIP | dashboard-approve-send-2_0-en-before.png |
| `copy-2` | Copies the draft/reply text to the clipboard ("Copied") - ux.md 6.7 | DOM changed; IPC clipboard:writeText; clipboard x1 | OK | dashboard-copy-2_0-en-after.png |
| `undo-dismiss` | Footer "Undo dismiss": opens the UndoDismissDrawer - ux.md 5.5 / 6.10 | dialog open: undo-dismiss-drawer; DOM changed; IPC dashboard:getIgnored | OK | dashboard-undo-dismiss_0-en-after.png |
| `dismiss-x-1` | Compact card X: dismisses the card (item:dismiss), toast with Undo - v2-ux 3.8 / v3 2.1 | DOM changed; IPC item:dismiss, dashboard:get | OK | dashboard-dismiss-x-1_0-en-after.png |
| `dismiss-x-4` | Compact card X: dismisses the card (item:dismiss), toast with Undo - v2-ux 3.8 / v3 2.1 | DOM changed; IPC item:dismiss, dashboard:get | OK | dashboard-dismiss-x-4_0-en-after.png |
| `dismiss-x-3` | Compact card X: dismisses the card (item:dismiss), toast with Undo - v2-ux 3.8 / v3 2.1 | DOM changed; IPC item:dismiss, dashboard:get | OK | dashboard-dismiss-x-3_0-en-after.png |
| `dismiss-x-2` | Compact card X: dismisses the card (item:dismiss), toast with Undo - v2-ux 3.8 / v3 2.1 | DOM changed; IPC item:dismiss, dashboard:get | OK | dashboard-dismiss-x-2_0-en-after.png |

#### menu-sched (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| button[menuitem] "Open details" | (no spec line found - inferred from the label) | dialog open: item-sheet; DOM changed; IPC item:get | OK | menu-sched-button_menuitem_Open_details_0-en-after.png |
| `dismiss-1` | Menu "Dismiss": item:dismiss, card leaves, toast with Undo - ux.md 6.5 | DOM changed; IPC item:dismiss, dashboard:get | OK | menu-sched-dismiss-1_0-en-after.png |
| `retriage-1` | Menu "Analyse again": item:retriage, card re-analysed - ux.md 6.5 | DOM changed; IPC item:retriage, dashboard:get | OK | menu-sched-retriage-1_0-en-after.png |
| `never-1` | Menu "Never analyse this contact": chat:setPolicy never + toast - ux.md 6.5 | DOM changed; IPC chat:setPolicy, dashboard:get | OK | menu-sched-never-1_0-en-after.png |

#### menu-missing (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| button[menuitem] "Open details" | (no spec line found - inferred from the label) | dialog open: item-sheet; DOM changed; IPC item:get | OK | menu-missing-button_menuitem_Open_details_0-en-after.png |
| `dismiss-2` | Menu "Dismiss": item:dismiss, card leaves, toast with Undo - ux.md 6.5 | DOM changed; IPC item:dismiss, dashboard:get | OK | menu-missing-dismiss-2_0-en-after.png |
| `retriage-2` | Menu "Analyse again": item:retriage, card re-analysed - ux.md 6.5 | DOM changed; IPC item:retriage, dashboard:get | OK | menu-missing-retriage-2_0-en-after.png |
| `never-2` | Menu "Never analyse this contact": chat:setPolicy never + toast - ux.md 6.5 | DOM changed; IPC chat:setPolicy, dashboard:get | OK | menu-missing-never-2_0-en-after.png |

#### menu-incal (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| button[menuitem] "Open details" | (no spec line found - inferred from the label) | dialog open: item-sheet; DOM changed; IPC item:get | OK | menu-incal-button_menuitem_Open_details_0-en-after.png |
| `dismiss-3` | Menu "Dismiss": item:dismiss, card leaves, toast with Undo - ux.md 6.5 | DOM changed; IPC item:dismiss, dashboard:get | OK | menu-incal-dismiss-3_0-en-after.png |
| `retriage-3` | Menu "Analyse again": item:retriage, card re-analysed - ux.md 6.5 | DOM changed; IPC item:retriage, dashboard:get | OK | menu-incal-retriage-3_0-en-after.png |
| `never-3` | Menu "Never analyse this contact": chat:setPolicy never + toast - ux.md 6.5 | ensure failed: locator.click: Timeout 10000ms exceeded. / Call log: /   - waiting for getByTestId('overflow-3') | UNCLEAR |  |

#### menu-small (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| button[menuitem] "Open details" | (no spec line found - inferred from the label) | dialog open: item-sheet; DOM changed; IPC item:get | OK | menu-small-button_menuitem_Open_details_0-en-after.png |
| `dismiss-4` | Menu "Dismiss": item:dismiss, card leaves, toast with Undo - ux.md 6.5 | DOM changed; IPC item:dismiss, dashboard:get | OK | menu-small-dismiss-4_0-en-after.png |
| `retriage-4` | Menu "Analyse again": item:retriage, card re-analysed - ux.md 6.5 | DOM changed; IPC item:retriage, dashboard:get | OK | menu-small-retriage-4_0-en-after.png |
| `never-4` | Menu "Never analyse this contact": chat:setPolicy never + toast - ux.md 6.5 | DOM changed; IPC chat:setPolicy, dashboard:get | OK | menu-small-never-4_0-en-after.png |

#### sheet-sched (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `sheet-close` | Closes the sheet (asks before discarding an edited draft) - ux.md 7 | DOM changed | OK | sheet-sched-sheet-close_0-en-after.png |
| `overflow-1` | Opens the card overflow menu (Open details / Dismiss / Analyse again / Never analyse) - ux.md 6.5 | dialog open: item-sheet; DOM changed | OK | sheet-sched-overflow-1_0-en-after.png |
| `approve-send-1` | (no spec line found - inferred from the label) | not clicked: approval-class control (never clicked by the sweep) | SKIP | sheet-sched-approve-send-1_0-en-before.png |
| `approve-event-1` | (no spec line found - inferred from the label) | not clicked: approval-class control (never clicked by the sweep) | SKIP | sheet-sched-approve-event-1_0-en-before.png |
| `sheet-edit-1` | "Edit": focuses the draft textarea - ux.md 7.4 | dialog open: item-sheet; no DOM change; IPC item:setEditing; focus -> draft-1 | OK | sheet-sched-sheet-edit-1_0-en-after.png |
| `copy-1` | Copies the draft/reply text to the clipboard ("Copied") - ux.md 6.7 | dialog open: item-sheet; DOM changed; IPC item:setEditing, clipboard:writeText; clipboard x1 | OK | sheet-sched-copy-1_0-en-after.png |
| `sheet-dismiss-1` | Sheet "Dismiss": item:dismiss, sheet closes - ux.md 7.4 | DOM changed; IPC item:dismiss, dashboard:get | OK | sheet-sched-sheet-dismiss-1_0-en-after.png |

#### sheet-missing (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `sheet-close` | Closes the sheet (asks before discarding an edited draft) - ux.md 7 | DOM changed | OK | sheet-missing-sheet-close_0-en-after.png |
| `overflow-2` | Opens the card overflow menu (Open details / Dismiss / Analyse again / Never analyse) - ux.md 6.5 | dialog open: item-sheet; DOM changed | OK | sheet-missing-overflow-2_0-en-after.png |
| `event-change-title` | (no spec line found - inferred from the label) | dialog open: item-sheet; DOM changed | OK | sheet-missing-event-change-title_0-en-after.png |
| `save-event-2` | "Save time" on an info-missing card: proposes the event (provider=user), no calendar write - v3 2.4b | disabled | OK | sheet-missing-save-event-2_0-en-before.png |
| `approve-send-2` | (no spec line found - inferred from the label) | not clicked: approval-class control (never clicked by the sweep) | SKIP | sheet-missing-approve-send-2_0-en-before.png |
| `sheet-edit-2` | "Edit": focuses the draft textarea - ux.md 7.4 | dialog open: item-sheet; no DOM change; IPC item:setEditing; focus -> draft-2 | OK | sheet-missing-sheet-edit-2_0-en-after.png |
| `copy-2` | Copies the draft/reply text to the clipboard ("Copied") - ux.md 6.7 | dialog open: item-sheet; DOM changed; IPC item:setEditing, clipboard:writeText; clipboard x1 | OK | sheet-missing-copy-2_0-en-after.png |
| `sheet-dismiss-2` | Sheet "Dismiss": item:dismiss, sheet closes - ux.md 7.4 | DOM changed; IPC item:dismiss, dashboard:get | OK | sheet-missing-sheet-dismiss-2_0-en-after.png |

#### sheet-incal (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `sheet-close` | Closes the sheet (asks before discarding an edited draft) - ux.md 7 | DOM changed | OK | sheet-incal-sheet-close_0-en-after.png |
| `overflow-3` | Opens the card overflow menu (Open details / Dismiss / Analyse again / Never analyse) - ux.md 6.5 | dialog open: item-sheet; DOM changed | OK | sheet-incal-overflow-3_0-en-after.png |
| `show-send-3` | "Show" the unsent reply under an in-calendar card - ux.md 6.7 | dialog open: item-sheet; DOM changed | OK | sheet-incal-show-send-3_0-en-after.png |
| `open-calendar-3` | "Open in Google Calendar": opens the event (external:open calendarEvent) - ux.md 6.7 | dialog open: item-sheet; no DOM change; IPC external:open; external https://calendar.google.com/calendar/r/day/2026/10/28 | OK | sheet-incal-open-calendar-3_0-en-after.png |
| `sheet-edit-3` | "Edit": focuses the draft textarea - ux.md 7.4 | dialog open: item-sheet; no DOM change; IPC item:setEditing; focus -> draft-3 | OK | sheet-incal-sheet-edit-3_0-en-after.png |
| `copy-3` | Copies the draft/reply text to the clipboard ("Copied") - ux.md 6.7 | dialog open: item-sheet; DOM changed; IPC item:setEditing, clipboard:writeText; clipboard x1 | OK | sheet-incal-copy-3_0-en-after.png |
| `undo-3` | (no spec line found - inferred from the label) | not clicked: approval-class control (never clicked by the sweep) | SKIP | sheet-incal-undo-3_0-en-before.png |
|  "" | (no spec line found - inferred from the label) | ensure failed: locator.click: Timeout 10000ms exceeded. / Call log: /   - waiting for getByTestId('overflow-3') | UNCLEAR |  |

#### sheet-small (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `sheet-close` | Closes the sheet (asks before discarding an edited draft) - ux.md 7 | DOM changed | OK | sheet-small-sheet-close_0-en-after.png |
| `overflow-4` | Opens the card overflow menu (Open details / Dismiss / Analyse again / Never analyse) - ux.md 6.5 | dialog open: item-sheet; DOM changed | OK | sheet-small-overflow-4_0-en-after.png |
| `approve-send-4` | (no spec line found - inferred from the label) | not clicked: approval-class control (never clicked by the sweep) | SKIP | sheet-small-approve-send-4_0-en-before.png |
| `sheet-edit-4` | "Edit": focuses the draft textarea - ux.md 7.4 | dialog open: item-sheet; no DOM change; IPC item:setEditing; focus -> draft-4 | OK | sheet-small-sheet-edit-4_0-en-after.png |
| `copy-4` | Copies the draft/reply text to the clipboard ("Copied") - ux.md 6.7 | dialog open: item-sheet; DOM changed; IPC item:setEditing, clipboard:writeText; clipboard x1 | OK | sheet-small-copy-4_0-en-after.png |
| `sheet-dismiss-4` | Sheet "Dismiss": item:dismiss, sheet closes - ux.md 7.4 | DOM changed; IPC item:dismiss, dashboard:get | OK | sheet-small-sheet-dismiss-4_0-en-after.png |

#### calendar (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `schedule-filter-toggle` | Schedule-only filter: "Show all (n hidden)" <-> "Only schedules" - ux.md 6.11 | DOM changed | OK | calendar-schedule-filter-toggle_0-en-after.png |
| `view-cards` | View switch: card lists - ux.md 6.11 | DOM changed | OK | calendar-view-cards_0-en-after.png |
| `view-calendar` | View switch: week calendar - ux.md 6.11 | no DOM change; (was already the selected choice) | OK | calendar-view-calendar_0-en-after.png |
| `cal-prev` | Previous week - ux.md 6.11 | DOM changed | OK | calendar-cal-prev_0-en-after.png |
| `cal-today` | Back to the current week - ux.md 6.11 | DOM changed | OK | calendar-cal-today_0-en-after.png |
| `cal-next` | Next week - ux.md 6.11 | DOM changed | OK | calendar-cal-next_0-en-after.png |
| `cal-note-dismiss` | Dismisses the one-time scope note - ux.md 6.11 | DOM changed | OK | calendar-cal-note-dismiss_0-en-after.png |

#### calendar-event-week (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `cal-prev` | Previous week - ux.md 6.11 | DOM changed | OK | calendar-event-week-cal-prev_0-en-after.png |
| `cal-today` | Back to the current week - ux.md 6.11 | DOM changed | OK | calendar-event-week-cal-today_0-en-after.png |
| `cal-next` | Next week - ux.md 6.11 | DOM changed | OK | calendar-event-week-cal-next_0-en-after.png |
| `cal-block-3` | Event block: opens the approval sheet - ux.md 6.11 | dialog open: item-sheet; DOM changed; IPC item:get | OK | calendar-event-week-cal-block-3_0-en-after.png |
| `cal-block-1` | Event block: opens the approval sheet - ux.md 6.11 | dialog open: item-sheet; DOM changed; IPC item:get | OK | calendar-event-week-cal-block-1_0-en-after.png |

#### health (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `health-subline-whatsapp` | Sub-line click: Settings > Working rules - v2-ux 2.2 | view dashboard -> settings/rules; DOM changed; IPC llm:getConfig, auto:getState, auto:listWrites, google:getWizardState, google:listCalendars, chat:listPolicies, model:getPlan, llm:getHardware, cli:getStatus, voice:getState | OK | health-health-subline-whatsapp_0-en-after.png |
| `health-subline-llm` | Sub-line click: Settings > AI engine - v2-ux 2.2 | view dashboard -> settings/ai; DOM changed; IPC llm:getConfig, auto:getState, auto:listWrites, google:getWizardState, google:listCalendars, chat:listPolicies, model:getPlan, llm:getHardware, cli:getStatus, voice:getState | OK | health-health-subline-llm_0-en-after.png |

#### undo-drawer (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `undo-dismiss-close` | Closes the drawer - ux.md 6.10 | DOM changed | OK | undo-drawer-undo-dismiss-close_0-en-after.png |
| `restore-5` | "Restore": item:restore, the card returns to its list - ux.md 6.10 | dialog open: undo-dismiss-drawer; DOM changed; IPC item:restore, dashboard:getIgnored, dashboard:get | OK | undo-drawer-restore-5_0-en-after.png |

#### dashboard (he)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `health-pill` | Opens the status panel (3 rows, one action each) - ux.md 5.2 | DOM changed; IPC model:getPlan | OK | dashboard-health-pill_0-he-after.png |
| `pause-toggle` | Toggles Pause/Resume (agent:setPaused), header border + pill read "Paused" - ux.md 5.1 | DOM changed; IPC agent:setPaused, auto:listWrites | OK | dashboard-pause-toggle_0-he-after.png |
| button[radio] "עברית" | Language segment: switches UI language + dir without reload - ux.md 5.1 | no DOM change; IPC settings:set, auto:listWrites; (was already the selected choice) | OK | dashboard-button_radio_0_16dnk-he-after.png |
| button[radio] "English" | Language segment: switches UI language + dir without reload - ux.md 5.1 | DOM changed; IPC settings:set, auto:listWrites | OK | dashboard-button_radio_English_0-he-after.png |
| `settings-toggle` | Gear opens Settings; in Settings it is "Back to dashboard" - ux.md 5.1 | view dashboard -> settings/general; DOM changed; IPC llm:getConfig, auto:getState, auto:listWrites, google:getWizardState, google:listCalendars, chat:listPolicies, model:getPlan, llm:getHardware, cli:getStatus, voice:getState | OK | dashboard-settings-toggle_0-he-after.png |
| `schedule-filter-toggle` | Schedule-only filter: "Show all (n hidden)" <-> "Only schedules" - ux.md 6.11 | DOM changed | OK | dashboard-schedule-filter-toggle_0-he-after.png |
| `view-cards` | View switch: card lists - ux.md 6.11 | no DOM change; (was already the selected choice) | OK | dashboard-view-cards_0-he-after.png |
| `view-calendar` | View switch: week calendar - ux.md 6.11 | DOM changed | OK | dashboard-view-calendar_0-he-after.png |
| `overflow-4` | Opens the card overflow menu (Open details / Dismiss / Analyse again / Never analyse) - ux.md 6.5 | DOM changed | OK | dashboard-overflow-4_0-he-after.png |
| `show-more-4` | Shows the rest of the conversation excerpt - ux.md 6.5 | dialog open: item-sheet; DOM changed; IPC item:get | OK | dashboard-show-more-4_0-he-after.png |
| `approve-send-4` | (no spec line found - inferred from the label) | not clicked: approval-class control (never clicked by the sweep) | SKIP | dashboard-approve-send-4_0-he-before.png |
| `copy-4` | Copies the draft/reply text to the clipboard ("Copied") - ux.md 6.7 | DOM changed; IPC clipboard:writeText; clipboard x1 | OK | dashboard-copy-4_0-he-after.png |
| `overflow-1` | Opens the card overflow menu (Open details / Dismiss / Analyse again / Never analyse) - ux.md 6.5 | DOM changed | OK | dashboard-overflow-1_0-he-after.png |
| `show-more-1` | Shows the rest of the conversation excerpt - ux.md 6.5 | dialog open: item-sheet; DOM changed; IPC item:get | OK | dashboard-show-more-1_0-he-after.png |
| `event-chip` | (no spec line found - inferred from the label) | dialog open: item-sheet; DOM changed; IPC item:get | OK | dashboard-event-chip_0-he-after.png |
| `approve-send-1` | (no spec line found - inferred from the label) | not clicked: approval-class control (never clicked by the sweep) | SKIP | dashboard-approve-send-1_0-he-before.png |
| `approve-event-1` | (no spec line found - inferred from the label) | not clicked: approval-class control (never clicked by the sweep) | SKIP | dashboard-approve-event-1_0-he-before.png |
| `edit-event-1` | "Edit time": toggles the inline event editor (no approval) - v3 2.4a | DOM changed; IPC item:setEditing | OK | dashboard-edit-event-1_0-he-before.png |
| `copy-1` | Copies the draft/reply text to the clipboard ("Copied") - ux.md 6.7 | DOM changed; IPC clipboard:writeText; clipboard x1 | OK | dashboard-copy-1_0-he-after.png |
| `overflow-3` | Opens the card overflow menu (Open details / Dismiss / Analyse again / Never analyse) - ux.md 6.5 | DOM changed | OK | dashboard-overflow-3_0-he-after.png |
| `show-more-3` | Shows the rest of the conversation excerpt - ux.md 6.5 | dialog open: item-sheet; DOM changed; IPC item:get | OK | dashboard-show-more-3_0-he-after.png |
| `event-chip` | (no spec line found - inferred from the label) | dialog open: item-sheet; DOM changed; IPC item:get | OK | dashboard-event-chip_1-he-after.png |
| `show-send-3` | "Show" the unsent reply under an in-calendar card - ux.md 6.7 | DOM changed | OK | dashboard-show-send-3_0-he-after.png |
| `open-calendar-3` | "Open in Google Calendar": opens the event (external:open calendarEvent) - ux.md 6.7 | no DOM change; IPC external:open; external https://calendar.google.com/calendar/r/day/2026/10/28 | OK | dashboard-open-calendar-3_0-he-after.png |
| `copy-3` | Copies the draft/reply text to the clipboard ("Copied") - ux.md 6.7 | DOM changed; IPC clipboard:writeText; clipboard x1 | OK | dashboard-copy-3_0-he-after.png |
| `undo-3` | (no spec line found - inferred from the label) | not clicked: approval-class control (never clicked by the sweep) | SKIP | dashboard-undo-3_0-he-before.png |
| `overflow-2` | Opens the card overflow menu (Open details / Dismiss / Analyse again / Never analyse) - ux.md 6.5 | DOM changed | OK | dashboard-overflow-2_0-he-after.png |
| `show-more-2` | Shows the rest of the conversation excerpt - ux.md 6.5 | dialog open: item-sheet; DOM changed; IPC item:get | OK | dashboard-show-more-2_0-he-after.png |
| `event-chip` | (no spec line found - inferred from the label) | dialog open: item-sheet; DOM changed; IPC item:get | OK | dashboard-event-chip_2-he-after.png |
| `event-change-title` | (no spec line found - inferred from the label) | DOM changed | OK | dashboard-event-change-title_0-he-after.png |
| `save-event-2` | "Save time" on an info-missing card: proposes the event (provider=user), no calendar write - v3 2.4b | disabled | OK | dashboard-save-event-2_0-he-before.png |
| `approve-send-2` | (no spec line found - inferred from the label) | not clicked: approval-class control (never clicked by the sweep) | SKIP | dashboard-approve-send-2_0-he-before.png |
| `copy-2` | Copies the draft/reply text to the clipboard ("Copied") - ux.md 6.7 | DOM changed; IPC clipboard:writeText; clipboard x1 | OK | dashboard-copy-2_0-he-after.png |
| `undo-dismiss` | Footer "Undo dismiss": opens the UndoDismissDrawer - ux.md 5.5 / 6.10 | dialog open: undo-dismiss-drawer; DOM changed; IPC dashboard:getIgnored | OK | dashboard-undo-dismiss_0-he-after.png |
| `dismiss-x-1` | Compact card X: dismisses the card (item:dismiss), toast with Undo - v2-ux 3.8 / v3 2.1 | DOM changed; IPC item:dismiss, dashboard:get | OK | dashboard-dismiss-x-1_0-he-after.png |
| `dismiss-x-4` | Compact card X: dismisses the card (item:dismiss), toast with Undo - v2-ux 3.8 / v3 2.1 | DOM changed; IPC item:dismiss, dashboard:get | OK | dashboard-dismiss-x-4_0-he-after.png |
| `dismiss-x-3` | Compact card X: dismisses the card (item:dismiss), toast with Undo - v2-ux 3.8 / v3 2.1 | DOM changed; IPC item:dismiss, dashboard:get | OK | dashboard-dismiss-x-3_0-he-after.png |
| `dismiss-x-2` | Compact card X: dismisses the card (item:dismiss), toast with Undo - v2-ux 3.8 / v3 2.1 | DOM changed; IPC item:dismiss, dashboard:get | OK | dashboard-dismiss-x-2_0-he-after.png |

#### onb-welcome (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| button[radio] "עברית" | Language segment: switches UI language + dir without reload - ux.md 5.1 | DOM changed; IPC settings:set, auto:listWrites | OK | onb-welcome-button_radio_0_16dnk-en-after.png |
| button[radio] "English" | Language segment: switches UI language + dir without reload - ux.md 5.1 | no DOM change; IPC settings:set, auto:listWrites; (was already the selected choice) | OK | onb-welcome-button_radio_English_0-en-after.png |
| `welcome-language-he` | Welcome language choice - ux.md 8.0 | DOM changed; IPC settings:set, auto:listWrites | OK | onb-welcome-welcome-language-he_0-en-after.png |
| `welcome-language-en` | Welcome language choice - ux.md 8.0 | no DOM change; (was already the selected choice) | OK | onb-welcome-welcome-language-en_0-en-after.png |
| `welcome-accept` | Accepts the disclosure; enables Start - ux.md 8.0 | DOM changed | OK | onb-welcome-welcome-accept_0-en-after.png |
| `welcome-start` | Start: records the ToS consent, starts the bridge, goes to Choose AI (disabled until accepted) - ux.md 8.0 | disabled | OK | onb-welcome-welcome-start_0-en-before.png |

#### onb-choose-ai (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `choose-ai-local` | Selects the provider card (cloud: consent first) - ux.md 8.1 / v2-ux 4.1 | no DOM change; (was already the selected choice) | OK | onb-choose-ai-choose-ai-local_0-en-after.png |
| `ai-download` | Downloads the local model in the background and moves on - ux.md 8.1 | DOM changed; IPC model:startDownload, settings:set, auto:listWrites, voice:getState, onboarding:setStep, pairing:get | OK | onb-choose-ai-ai-download_0-en-after.png |
| `ai-size-toggle` | Reveals the model-size picker - ux.md 8.1 | DOM changed | OK | onb-choose-ai-ai-size-toggle_0-en-after.png |
| `choose-ai-claude_cli` | Selects the provider card (cloud: consent first) - ux.md 8.1 / v2-ux 4.1 | DOM changed | OK | onb-choose-ai-choose-ai-claude_cli_0-en-after.png |
| `connect-copy-claude_cli` | Copies the install / sign-in command - v2-ux 7.1 | DOM changed; IPC clipboard:writeText; clipboard x1 | OK | onb-choose-ai-connect-copy-claude_cli_0-en-after.png |
| `ai-show-experimental` | "Show experimental": reveals the Antigravity card - v2-ux 4.1 | DOM changed | OK | onb-choose-ai-ai-show-experimental_0-en-after.png |
| `ai-advanced` | "Advanced: use an API key": reveals the API-key cards - v2-ux 4.1 | DOM changed | OK | onb-choose-ai-ai-advanced_0-en-after.png |
| `onboarding-voice-optin` | Opt in to voice notes (download later) - v2-ux 6 | DOM changed | OK | onb-choose-ai-onboarding-voice-optin_0-en-after.png |
| `onboarding-back` | Back to the previous step / sub-step - ux.md 8 | DOM changed; IPC onboarding:setStep | OK | onb-choose-ai-onboarding-back_0-en-after.png |
| `ai-continue` | Continue to the next onboarding step - ux.md 8.1 | DOM changed; IPC settings:set, auto:listWrites, model:startDownload, voice:getState, onboarding:setStep, pairing:get | OK | onb-choose-ai-ai-continue_0-en-after.png |

#### onb-link-whatsapp (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `onboarding-back` | Back to the previous step / sub-step - ux.md 8 | DOM changed; IPC onboarding:setStep, llm:getConfig, voice:getState, llm:getHardware, model:getPlan, cli:getStatus | OK | onb-link-whatsapp-onboarding-back_0-en-after.png |

#### onb-link-expired (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `qr-new-code` | "New code": restarts pairing with a fresh QR - ux.md 8.2 | DOM changed; IPC pairing:newCode | OK | onb-link-expired-qr-new-code_0-en-after.png |
| `onboarding-back` | Back to the previous step / sub-step - ux.md 8 | DOM changed; IPC onboarding:setStep, llm:getConfig, voice:getState, llm:getHardware, model:getPlan, cli:getStatus | OK | onb-link-expired-onboarding-back_0-en-after.png |

#### onb-link-connected (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `onboarding-back` | Back to the previous step / sub-step - ux.md 8 | DOM changed; IPC onboarding:setStep, llm:getConfig, voice:getState, llm:getHardware, model:getPlan, cli:getStatus | OK | onb-link-connected-onboarding-back_0-en-after.png |
| `pairing-continue` | Continue once linked (disabled before) - ux.md 8.2 | DOM changed; IPC onboarding:setStep, google:getWizardState | OK | onb-link-connected-pairing-continue_0-en-after.png |

#### onb-google-0 (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `onboarding-back` | Back to the previous step / sub-step - ux.md 8 | DOM changed; IPC onboarding:setStep, pairing:get | OK | onb-google-0-onboarding-back_0-en-after.png |
| `google-later` | "Later": skips Google, reply-only - ux.md 8.3 | DOM changed; IPC onboarding:setStep, onboarding:getState | OK | onb-google-0-google-later_0-en-after.png |
| `google-start` | "Start": sub-step 1 - ux.md 8.3 | DOM changed | OK | onb-google-0-google-start_0-en-after.png |

#### onb-google-1 (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `google-open-gcp_new_project` | Opens the Google Cloud console page (external:open <target>) - ux.md 8.3 | no DOM change; IPC external:open; external https://console.cloud.google.com/projectcreate | OK | onb-google-1-google-open-gcp_new_project_0-en-after.png |
| `google-open-gcp_enable_calendar_api` | Opens the Google Cloud console page (external:open <target>) - ux.md 8.3 | no DOM change; IPC external:open; external https://console.cloud.google.com/apis/library/calendar-json.googleapis.com | OK | onb-google-1-google-open-gcp_enable_calendar_api_0-en-after.png |
| `onboarding-back` | Back to the previous step / sub-step - ux.md 8 | DOM changed | OK | onb-google-1-onboarding-back_0-en-after.png |
| `google-next` | "Next" sub-step (disabled at 4 until a client file is accepted) - ux.md 8.3 | DOM changed | OK | onb-google-1-google-next_0-en-after.png |

#### onb-google-2 (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `google-open-gcp_oauth_consent` | Opens the Google Cloud console page (external:open <target>) - ux.md 8.3 | no DOM change; IPC external:open; external https://console.cloud.google.com/auth/overview | OK | onb-google-2-google-open-gcp_oauth_consent_0-en-after.png |
| `google-open-gcp_publish_app` | Opens the Google Cloud console page (external:open <target>) - ux.md 8.3 | no DOM change; IPC external:open; external https://console.cloud.google.com/auth/audience | OK | onb-google-2-google-open-gcp_publish_app_0-en-after.png |
| summary "What happens if I leave it in Testing?" | (no spec line found - inferred from the label) | DOM changed | OK | onb-google-2-summary_What_happens_if_I_leave_it_in_Testing_0-en-after.png |
| `onboarding-back` | Back to the previous step / sub-step - ux.md 8 | DOM changed | OK | onb-google-2-onboarding-back_0-en-after.png |
| `google-next` | "Next" sub-step (disabled at 4 until a client file is accepted) - ux.md 8.3 | DOM changed | OK | onb-google-2-google-next_0-en-after.png |

#### onb-google-3 (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `google-open-gcp_create_credentials` | Opens the Google Cloud console page (external:open <target>) - ux.md 8.3 | no DOM change; IPC external:open; external https://console.cloud.google.com/auth/clients | OK | onb-google-3-google-open-gcp_create_credentials_0-en-after.png |
| `google-copy-name` | Copies the OAuth client name - ux.md 8.3 | DOM changed; IPC clipboard:writeText; clipboard x1 | OK | onb-google-3-google-copy-name_0-en-after.png |
| `onboarding-back` | Back to the previous step / sub-step - ux.md 8 | DOM changed | OK | onb-google-3-onboarding-back_0-en-after.png |
| `google-next` | "Next" sub-step (disabled at 4 until a client file is accepted) - ux.md 8.3 | DOM changed | OK | onb-google-3-google-next_0-en-after.png |

#### onb-google-4 (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `google-drop-zone` | Drop zone / Browse: native open dialog (google:pickCredentialsFile) - ux.md 8.3 | no DOM change; IPC google:pickCredentialsFile; native showOpenDialog(Google OAuth credentials (JSON)) | OK | onb-google-4-google-drop-zone_0-en-after.png |
| `onboarding-back` | Back to the previous step / sub-step - ux.md 8 | DOM changed | OK | onb-google-4-onboarding-back_0-en-after.png |
| `google-next` | "Next" sub-step (disabled at 4 until a client file is accepted) - ux.md 8.3 | disabled | OK | onb-google-4-google-next_0-en-before.png |

#### onb-google-5 (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `google-unverified-help` | Opens the "unverified app" help page - ux.md 8.3 | no DOM change; IPC external:open; external https://support.google.com/cloud/answer/7454865 | OK | onb-google-5-google-unverified-help_0-en-after.png |
| `onboarding-back` | Back to the previous step / sub-step - ux.md 8 | DOM changed | OK | onb-google-5-onboarding-back_0-en-after.png |
| `google-signin` | "Sign in with Google": google:startSignIn, opens the browser, shows Waiting... then Connected - ux.md 8.3 | DOM changed; IPC google:startSignIn; external https://accounts.google.com/o/oauth2/v2/auth?... | OK | onb-google-5-google-signin_0-en-after.png |

#### onb-ready (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `ready-autostart` | Start with Windows (no-op unpackaged) - ux.md 8.4 | DOM changed; IPC settings:set, auto:listWrites | OK | onb-ready-ready-autostart_0-en-after.png |
| button "What to do" | (no spec line found - inferred from the label) | no DOM change; IPC external:open; external https://support.microsoft.com/windows/bitlocker-recovery-6c2b4fd5-4b3c-4a55-9a66-0ffb06f39cfb | OK | onb-ready-button_What_to_do_0-en-after.png |
| `ready-open` | "Open the dashboard" - ux.md 8.4 | view onboarding -> dashboard; DOM changed; IPC onboarding:setStep, auto:getState, auto:listWrites | OK | onb-ready-ready-open_0-en-after.png |

#### settings (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `settings-nav-general` | In-page nav: scrolls to the group - ux.md 9 | no DOM change; scrolled | OK | settings-settings-nav-general_0-en-after.png |
| `settings-nav-ai` | In-page nav: scrolls to the group - ux.md 9 | no DOM change; scrolled | OK | settings-settings-nav-ai_0-en-after.png |
| `settings-nav-whatsapp` | In-page nav: scrolls to the group - ux.md 9 | DOM changed | OK | settings-settings-nav-whatsapp_0-en-after.png |
| `settings-nav-calendar` | In-page nav: scrolls to the group - ux.md 9 | no DOM change; scrolled | OK | settings-settings-nav-calendar_0-en-after.png |
| `settings-nav-auto` | In-page nav: scrolls to the group - ux.md 9 | no DOM change; IPC auto:getState, auto:listWrites; scrolled | OK | settings-settings-nav-auto_0-en-after.png |
| `settings-nav-rules` | In-page nav: scrolls to the group - ux.md 9 | no DOM change; scrolled | OK | settings-settings-nav-rules_0-en-after.png |
| `settings-nav-replies` | In-page nav: scrolls to the group - ux.md 9 | DOM changed; (effect only after > 500 ms) | OK | settings-settings-nav-replies_0-en-after.png |
| `settings-nav-privacy` | In-page nav: scrolls to the group - ux.md 9 | no DOM change; scrolled | OK | settings-settings-nav-privacy_0-en-after.png |
| `settings-language-system` | Language choice (System / English / Hebrew), saved at once - ux.md 9 | DOM changed; IPC settings:set, auto:listWrites | OK | settings-settings-language-system_0-en-after.png |
| `settings-language-he` | Language choice (System / English / Hebrew), saved at once - ux.md 9 | DOM changed; IPC settings:set, auto:listWrites | OK | settings-settings-language-he_0-en-after.png |
| `settings-language-en` | Language choice (System / English / Hebrew), saved at once - ux.md 9 | DOM changed; (effect only after > 500 ms) | OK | settings-settings-language-en_0-en-after.png |
| `settings-autostart` | (no spec line found - inferred from the label) | DOM changed; IPC settings:set, auto:listWrites | OK | settings-settings-autostart_0-en-after.png |
| `settings-notifications` | Notifications choice, saved ("Saved" chip) - ux.md 9 | DOM changed; IPC settings:set, auto:listWrites; [select "generic" -> "off"] | OK | settings-settings-notifications_0-en-after.png |
| `settings-pause` | (no spec line found - inferred from the label) | DOM changed; IPC agent:setPaused, auto:listWrites | OK | settings-settings-pause_0-en-after.png |
| `choose-ai-local` | Selects the provider card (cloud: consent first) - ux.md 8.1 / v2-ux 4.1 | no DOM change; (was already the selected choice) | OK | settings-choose-ai-local_0-en-after.png |
| `ai-download` | Downloads the local model in the background and moves on - ux.md 8.1 | DOM changed; IPC model:startDownload | OK | settings-ai-download_0-en-after.png |
| `ai-size-toggle` | Reveals the model-size picker - ux.md 8.1 | DOM changed | OK | settings-ai-size-toggle_0-en-after.png |
| `ai-size-select` | Model size picker - ux.md 8.1 | DOM changed; [select "auto" -> "tiny"] | OK | settings-ai-size-select_0-en-after.png |
| `choose-ai-claude_cli` | Selects the provider card (cloud: consent first) - ux.md 8.1 / v2-ux 4.1 | DOM changed | OK | settings-choose-ai-claude_cli_0-en-after.png |
| `connect-signin-claude_cli` | "Sign in": opens the vendor login in a visible console (recorded in e2e) - v2-ux 7.1 | no DOM change; IPC cli:signIn | UNCLEAR | settings-connect-signin-claude_cli_0-en-after.png |
| `ai-use-claude_cli` | "Use <provider>": consent dialog first (cloud), then switches provider; disabled until the CLI is ready - v2-ux 4.1 / 7.1 | disabled | OK | settings-ai-use-claude_cli_0-en-before.png |
| `ai-show-experimental` | "Show experimental": reveals the Antigravity card - v2-ux 4.1 | DOM changed | OK | settings-ai-show-experimental_0-en-after.png |
| `choose-ai-antigravity_cli` | Selects the provider card (cloud: consent first) - ux.md 8.1 / v2-ux 4.1 | DOM changed | OK | settings-choose-ai-antigravity_cli_0-en-after.png |
| `connect-copy-antigravity_cli` | Copies the install / sign-in command - v2-ux 7.1 | DOM changed; IPC clipboard:writeText; clipboard x1 | OK | settings-connect-copy-antigravity_cli_0-en-after.png |
| `connect-open-install-antigravity_cli` | "Open install page": external:open <cli>_install - v2-ux 7.1 | no DOM change; IPC external:open; external https://antigravity.google/docs/cli/install/ | OK | settings-connect-open-install-antigravity_cli_0-en-after.png |
| `connect-check-antigravity_cli` | "Check again": re-detects the CLI - v2-ux 7.1 | DOM changed; IPC cli:getStatus | OK | settings-connect-check-antigravity_cli_0-en-after.png |
| `ai-use-antigravity_cli` | "Use <provider>": consent dialog first (cloud), then switches provider; disabled until the CLI is ready - v2-ux 4.1 / 7.1 | disabled | OK | settings-ai-use-antigravity_cli_0-en-before.png |
| `ai-advanced` | "Advanced: use an API key": reveals the API-key cards - v2-ux 4.1 | DOM changed | OK | settings-ai-advanced_0-en-after.png |
| `choose-ai-claude` | Selects the provider card (cloud: consent first) - ux.md 8.1 / v2-ux 4.1 | dialog open: consent-dialog; DOM changed; IPC llm:listModels | OK | settings-choose-ai-claude_0-en-after.png |
| `choose-ai-gemini` | Selects the provider card (cloud: consent first) - ux.md 8.1 / v2-ux 4.1 | dialog open: consent-dialog; DOM changed; IPC llm:listModels | OK | settings-choose-ai-gemini_0-en-after.png |
| `settings-cli-limits` | (no spec line found - inferred from the label) | DOM changed | OK | settings-settings-cli-limits_0-en-after.png |
| `settings-cli-overage` | (no spec line found - inferred from the label) | DOM changed; IPC cli:setOverage; native seamDialog(setting_overage) | OK | settings-settings-cli-overage_0-en-after.png |
| `settings-cli-exe-change` | Choose the CLI exe: native open dialog (cli:pickExe) - v2-ux 7 | DOM changed; IPC cli:pickExe, settings:get, llm:getConfig; native showOpenDialog(claude.exe) | OK | settings-settings-cli-exe-change_0-en-after.png |
| `settings-acceleration` | Local model acceleration, saved - ux.md 9 | DOM changed; IPC settings:set, auto:listWrites; [select "auto" -> "off"] | OK | settings-settings-acceleration_0-en-after.png |
| `settings-self-test` | "Test the model": model:selfTest, shows tok/s or failure - ux.md 9 | DOM changed; IPC model:selfTest | OK | settings-settings-self-test_0-en-after.png |
| `settings-delete-model` | Delete model: confirm dialog first - ux.md 9 / 10 | dialog open: settings-confirm; DOM changed; confirm dialog shown: yes | OK | settings-settings-delete-model_0-en-after.png |
| `settings-voice-off` | Voice notes tier / download (confirm) / delete / test - v2-ux 4.2 | no DOM change; (was already the selected choice) | OK | settings-settings-voice-off_0-en-after.png |
| `settings-voice-voice-hebrew` | Voice notes tier / download (confirm) / delete / test - v2-ux 4.2 | DOM changed | OK | settings-settings-voice-voice-hebrew_0-en-after.png |
| `settings-voice-voice-multilingual` | Voice notes tier / download (confirm) / delete / test - v2-ux 4.2 | DOM changed | OK | settings-settings-voice-voice-multilingual_0-en-after.png |
| `settings-voice-voice-lite` | Voice notes tier / download (confirm) / delete / test - v2-ux 4.2 | DOM changed | OK | settings-settings-voice-voice-lite_0-en-after.png |
| `settings-voice-test` | Voice notes tier / download (confirm) / delete / test - v2-ux 4.2 | no DOM change; IPC voice:selfTest, voice:getState | UNCLEAR | settings-settings-voice-test_0-en-after.png |
| `settings-images-enabled` | Pictures: local-only toggle / download / restart - v2-ux 4.3 | DOM changed; IPC settings:set, auto:listWrites | OK | settings-settings-images-enabled_0-en-after.png |
| `settings-images-download` | Pictures: local-only toggle / download / restart - v2-ux 4.3 | DOM changed; IPC model:startDownload, model:getPlan | OK | settings-settings-images-download_0-en-after.png |
| `settings-relink` | Re-link WhatsApp: confirm first, then QR panel - ux.md 9 | dialog open: settings-confirm; DOM changed; confirm dialog shown: yes | OK | settings-settings-relink_0-en-after.png |
| `settings-wipe` | Unlink and wipe: danger confirm first - ux.md 9 | dialog open: settings-confirm; DOM changed; confirm dialog shown: yes | OK | settings-settings-wipe_0-en-after.png |
| `settings-google-reconnect` | "Connect" (Google): google:startSignIn -> opens the Google sign-in in the browser, shows waiting/connected - ux.md 9 / 8.3 | DOM changed; IPC google:startSignIn; external https://accounts.google.com/o/oauth2/v2/auth?... | OK | settings-settings-google-reconnect_0-en-after.png |
| `settings-google-replace` | "Replace key file": native open dialog (google:pickCredentialsFile) - ux.md 9 | no DOM change; IPC google:pickCredentialsFile; native showOpenDialog(Google OAuth credentials (JSON)) | OK | settings-settings-google-replace_0-en-after.png |
| `settings-google-disconnect` | Disconnect Google: danger confirm first - ux.md 9 | dialog open: settings-confirm; DOM changed; confirm dialog shown: yes | OK | settings-settings-google-disconnect_0-en-after.png |
| `settings-target-calendar` | Target calendar, saved - ux.md 9 | DOM changed; [select has a single option - nothing to change] | OK | settings-settings-target-calendar_0-en-after.png |
| `settings-conflict-primary` | Conflict calendars (at least one stays checked) - ux.md 9 | DOM changed; (effect only after > 500 ms) | OK | settings-settings-conflict-primary_0-en-after.png |
| `auto-scope-edits` | (no spec line found - inferred from the label) | DOM changed | OK | settings-auto-scope-edits_0-en-after.png |
| `auto-scope-cancels` | (no spec line found - inferred from the label) | DOM changed | OK | settings-auto-scope-cancels_0-en-after.png |
| `auto-scope-quiet` | (no spec line found - inferred from the label) | DOM changed | OK | settings-auto-scope-quiet_0-en-after.png |
| `auto-scope-validity` | (no spec line found - inferred from the label) | DOM changed; [select "30" -> "90"] | OK | settings-auto-scope-validity_0-en-after.png |
| `auto-open-activity` | Opens the Automatic activity page - v2-ux 4.5 / 4.6 | view settings/general -> settings/activity; DOM changed; IPC auto:listWrites | OK | settings-auto-open-activity_0-en-after.png |
| `settings-unknown-senders` | (no spec line found - inferred from the label) | DOM changed; IPC settings:set, auto:listWrites | OK | settings-settings-unknown-senders_0-en-after.png |
| `settings-readtools-off` | "Let the AI read older messages" choice - v2-ux 4.7 | DOM changed; IPC settings:set, auto:listWrites | OK | settings-settings-readtools-off_0-en-after.png |
| `settings-readtools-trigger_chat` | "Let the AI read older messages" choice - v2-ux 4.7 | DOM changed; (effect only after > 500 ms) | OK | settings-settings-readtools-trigger_chat_0-en-after.png |
| `settings-readtools-all_chats` | "Let the AI read older messages" choice - v2-ux 4.7 | no DOM change; IPC wa:setReadScope, settings:get; native seamDialog(setting_read_all_chats) | OK | settings-settings-readtools-all_chats_0-en-after.png |
| `settings-backlog` | Backlog hours, saved - ux.md 9 | DOM changed; IPC settings:set, auto:listWrites; [select "0" -> "12"] | OK | settings-settings-backlog_0-en-after.png |
| `settings-ambiguous-assume` | Ambiguous time rule, saved - ux.md 9 | DOM changed; (effect only after > 500 ms) | OK | settings-settings-ambiguous-assume_0-en-after.png |
| `settings-ambiguous-ask` | Ambiguous time rule, saved - ux.md 9 | DOM changed; IPC settings:set, auto:listWrites | OK | settings-settings-ambiguous-ask_0-en-after.png |
| `settings-duration` | Default duration, saved - ux.md 9 | DOM changed; IPC settings:set, auto:listWrites; [select "60" -> "30"] | OK | settings-settings-duration_0-en-after.png |
| `settings-policy-select-1` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | DOM changed; IPC chat:setPolicy, chat:listPolicies; [select "default" -> "never"] | OK | settings-settings-policy-select-1_0-en-after.png |
| `settings-policy-auto-1` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | DOM changed; IPC chat:setPolicy, chat:listPolicies; [select "inherit" -> "never"] | OK | settings-settings-policy-auto-1_0-en-after.png |
| `settings-policy-remove-1` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | no DOM change; IPC chat:setPolicy, chat:listPolicies | UNCLEAR | settings-settings-policy-remove-1_0-en-after.png |
| `settings-policy-select-2` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | DOM changed; IPC chat:setPolicy, chat:listPolicies; [select "default" -> "never"] | OK | settings-settings-policy-select-2_0-en-after.png |
| `settings-policy-auto-2` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | DOM changed; IPC chat:setPolicy, chat:listPolicies; [select "inherit" -> "never"] | OK | settings-settings-policy-auto-2_0-en-after.png |
| `settings-policy-remove-2` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | no DOM change; IPC chat:setPolicy, chat:listPolicies | UNCLEAR | settings-settings-policy-remove-2_0-en-after.png |
| `settings-policy-select-3` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | DOM changed; IPC chat:setPolicy, chat:listPolicies; [select "default" -> "never"] | OK | settings-settings-policy-select-3_0-en-after.png |
| `settings-policy-auto-3` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | DOM changed; IPC chat:setPolicy, chat:listPolicies; [select "inherit" -> "never"] | OK | settings-settings-policy-auto-3_0-en-after.png |
| `settings-policy-remove-3` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | no DOM change; IPC chat:setPolicy, chat:listPolicies | UNCLEAR | settings-settings-policy-remove-3_0-en-after.png |
| `settings-policy-select-4` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | DOM changed; IPC chat:setPolicy, chat:listPolicies; [select "default" -> "never"] | OK | settings-settings-policy-select-4_0-en-after.png |
| `settings-policy-auto-4` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | DOM changed; IPC chat:setPolicy, chat:listPolicies; [select "inherit" -> "never"] | OK | settings-settings-policy-auto-4_0-en-after.png |
| `settings-policy-remove-4` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | no DOM change; IPC chat:setPolicy, chat:listPolicies | UNCLEAR | settings-settings-policy-remove-4_0-en-after.png |
| `settings-policy-select-5` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | DOM changed; IPC chat:setPolicy, chat:listPolicies; [select "default" -> "never"] | OK | settings-settings-policy-select-5_0-en-after.png |
| `settings-policy-auto-5` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | DOM changed; IPC chat:setPolicy, chat:listPolicies; [select "inherit" -> "never"] | OK | settings-settings-policy-auto-5_0-en-after.png |
| `settings-policy-remove-5` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | no DOM change; IPC chat:setPolicy, chat:listPolicies | UNCLEAR | settings-settings-policy-remove-5_0-en-after.png |
| `settings-gender-m` | Hebrew address form, saved - ux.md 9 | DOM changed; IPC settings:set, auto:listWrites | OK | settings-settings-gender-m_0-en-after.png |
| `settings-gender-f` | Hebrew address form, saved - ux.md 9 | DOM changed; IPC settings:set, auto:listWrites | OK | settings-settings-gender-f_0-en-after.png |
| `settings-gender-unspecified` | Hebrew address form, saved - ux.md 9 | DOM changed | OK | settings-settings-gender-unspecified_0-en-after.png |
| `settings-retention` | Retention, saved - ux.md 9 | DOM changed; IPC settings:set, auto:listWrites; [select "30" -> "7"] | OK | settings-settings-retention_0-en-after.png |
| `settings-purge` | Purge now: danger confirm first - ux.md 9 | dialog open: settings-confirm; DOM changed; confirm dialog shown: yes | OK | settings-settings-purge_0-en-after.png |
| `settings-diagnostics` | Export diagnostics: native save dialog - ux.md 9 | no DOM change; IPC diagnostics:export; native showSaveDialog(Export diagnostics) | OK | settings-settings-diagnostics_0-en-after.png |
| `settings-licences` | Opens the licences dialog - ux.md 9 | dialog open: settings-licences-dialog; DOM changed | OK | settings-settings-licences_0-en-after.png |

#### activity (en)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `auto-activity-back` | Back to Settings > Automatic mode - v2-ux 4.6 | view settings/activity -> settings/general; DOM changed; IPC auto:getState, auto:listWrites, llm:getConfig, llm:getHardware, model:getPlan, cli:getStatus, voice:getState | OK | activity-auto-activity-back_0-en-after.png |
| `activity-export` | Export: native save dialog (auto:export) - v2-ux 4.6 | no DOM change; IPC auto:export; native showSaveDialog(Automatic activity) | OK | activity-activity-export_0-en-after.png |

#### settings (he)

| control (test id / label) | expected (spec) | observed | verdict | screenshot |
|---|---|---|---|---|
| `settings-nav-general` | In-page nav: scrolls to the group - ux.md 9 | no DOM change; scrolled | OK | settings-settings-nav-general_0-he-after.png |
| `settings-nav-ai` | In-page nav: scrolls to the group - ux.md 9 | no DOM change; scrolled | OK | settings-settings-nav-ai_0-he-after.png |
| `settings-nav-whatsapp` | In-page nav: scrolls to the group - ux.md 9 | DOM changed | OK | settings-settings-nav-whatsapp_0-he-after.png |
| `settings-nav-calendar` | In-page nav: scrolls to the group - ux.md 9 | no DOM change; scrolled | OK | settings-settings-nav-calendar_0-he-after.png |
| `settings-nav-auto` | In-page nav: scrolls to the group - ux.md 9 | no DOM change; IPC auto:getState, auto:listWrites; scrolled | OK | settings-settings-nav-auto_0-he-after.png |
| `settings-nav-rules` | In-page nav: scrolls to the group - ux.md 9 | no DOM change; scrolled | OK | settings-settings-nav-rules_0-he-after.png |
| `settings-nav-replies` | In-page nav: scrolls to the group - ux.md 9 | DOM changed; (effect only after > 500 ms) | OK | settings-settings-nav-replies_0-he-after.png |
| `settings-nav-privacy` | In-page nav: scrolls to the group - ux.md 9 | no DOM change; scrolled | OK | settings-settings-nav-privacy_0-he-after.png |
| `settings-language-system` | Language choice (System / English / Hebrew), saved at once - ux.md 9 | DOM changed; IPC settings:set, auto:listWrites | OK | settings-settings-language-system_0-he-after.png |
| `settings-language-he` | Language choice (System / English / Hebrew), saved at once - ux.md 9 | DOM changed; (effect only after > 500 ms) | OK | settings-settings-language-he_0-he-after.png |
| `settings-language-en` | Language choice (System / English / Hebrew), saved at once - ux.md 9 | DOM changed; IPC settings:set, auto:listWrites | OK | settings-settings-language-en_0-he-after.png |
| `settings-autostart` | (no spec line found - inferred from the label) | DOM changed; IPC settings:set, auto:listWrites | OK | settings-settings-autostart_0-he-after.png |
| `settings-notifications` | Notifications choice, saved ("Saved" chip) - ux.md 9 | DOM changed; IPC settings:set, auto:listWrites; [select "generic" -> "off"] | OK | settings-settings-notifications_0-he-after.png |
| `settings-pause` | (no spec line found - inferred from the label) | DOM changed; IPC agent:setPaused, auto:listWrites | OK | settings-settings-pause_0-he-after.png |
| `choose-ai-local` | Selects the provider card (cloud: consent first) - ux.md 8.1 / v2-ux 4.1 | no DOM change; (was already the selected choice) | OK | settings-choose-ai-local_0-he-after.png |
| `ai-download` | Downloads the local model in the background and moves on - ux.md 8.1 | DOM changed; IPC model:startDownload | OK | settings-ai-download_0-he-after.png |
| `ai-size-toggle` | Reveals the model-size picker - ux.md 8.1 | DOM changed | OK | settings-ai-size-toggle_0-he-after.png |
| `ai-size-select` | Model size picker - ux.md 8.1 | DOM changed; [select "auto" -> "tiny"] | OK | settings-ai-size-select_0-he-after.png |
| `choose-ai-claude_cli` | Selects the provider card (cloud: consent first) - ux.md 8.1 / v2-ux 4.1 | DOM changed | OK | settings-choose-ai-claude_cli_0-he-after.png |
| `connect-signin-claude_cli` | "Sign in": opens the vendor login in a visible console (recorded in e2e) - v2-ux 7.1 | no DOM change; IPC cli:signIn | UNCLEAR | settings-connect-signin-claude_cli_0-he-after.png |
| `ai-use-claude_cli` | "Use <provider>": consent dialog first (cloud), then switches provider; disabled until the CLI is ready - v2-ux 4.1 / 7.1 | disabled | OK | settings-ai-use-claude_cli_0-he-before.png |
| `ai-show-experimental` | "Show experimental": reveals the Antigravity card - v2-ux 4.1 | DOM changed | OK | settings-ai-show-experimental_0-he-after.png |
| `choose-ai-antigravity_cli` | Selects the provider card (cloud: consent first) - ux.md 8.1 / v2-ux 4.1 | DOM changed | OK | settings-choose-ai-antigravity_cli_0-he-after.png |
| `connect-copy-antigravity_cli` | Copies the install / sign-in command - v2-ux 7.1 | DOM changed; IPC clipboard:writeText; clipboard x1 | OK | settings-connect-copy-antigravity_cli_0-he-after.png |
| `connect-open-install-antigravity_cli` | "Open install page": external:open <cli>_install - v2-ux 7.1 | no DOM change; IPC external:open; external https://antigravity.google/docs/cli/install/ | OK | settings-connect-open-install-antigravity_cli_0-he-after.png |
| `connect-check-antigravity_cli` | "Check again": re-detects the CLI - v2-ux 7.1 | DOM changed; IPC cli:getStatus | OK | settings-connect-check-antigravity_cli_0-he-after.png |
| `ai-use-antigravity_cli` | "Use <provider>": consent dialog first (cloud), then switches provider; disabled until the CLI is ready - v2-ux 4.1 / 7.1 | disabled | OK | settings-ai-use-antigravity_cli_0-he-before.png |
| `ai-advanced` | "Advanced: use an API key": reveals the API-key cards - v2-ux 4.1 | DOM changed | OK | settings-ai-advanced_0-he-after.png |
| `choose-ai-claude` | Selects the provider card (cloud: consent first) - ux.md 8.1 / v2-ux 4.1 | dialog open: consent-dialog; DOM changed; IPC llm:listModels | OK | settings-choose-ai-claude_0-he-after.png |
| `choose-ai-gemini` | Selects the provider card (cloud: consent first) - ux.md 8.1 / v2-ux 4.1 | dialog open: consent-dialog; DOM changed; IPC llm:listModels | OK | settings-choose-ai-gemini_0-he-after.png |
| `settings-cli-limits` | (no spec line found - inferred from the label) | DOM changed | OK | settings-settings-cli-limits_0-he-after.png |
| `settings-cli-overage` | (no spec line found - inferred from the label) | DOM changed; IPC cli:setOverage; native seamDialog(setting_overage) | OK | settings-settings-cli-overage_0-he-after.png |
| `settings-cli-exe-change` | Choose the CLI exe: native open dialog (cli:pickExe) - v2-ux 7 | DOM changed; IPC cli:pickExe, settings:get, llm:getConfig; native showOpenDialog(claude.exe) | OK | settings-settings-cli-exe-change_0-he-after.png |
| `settings-acceleration` | Local model acceleration, saved - ux.md 9 | DOM changed; IPC settings:set, auto:listWrites; [select "auto" -> "off"] | OK | settings-settings-acceleration_0-he-after.png |
| `settings-self-test` | "Test the model": model:selfTest, shows tok/s or failure - ux.md 9 | DOM changed; IPC model:selfTest | OK | settings-settings-self-test_0-he-after.png |
| `settings-delete-model` | Delete model: confirm dialog first - ux.md 9 / 10 | dialog open: settings-confirm; DOM changed; confirm dialog shown: yes | OK | settings-settings-delete-model_0-he-after.png |
| `settings-voice-off` | Voice notes tier / download (confirm) / delete / test - v2-ux 4.2 | no DOM change; (was already the selected choice) | OK | settings-settings-voice-off_0-he-after.png |
| `settings-voice-voice-hebrew` | Voice notes tier / download (confirm) / delete / test - v2-ux 4.2 | DOM changed | OK | settings-settings-voice-voice-hebrew_0-he-after.png |
| `settings-voice-voice-multilingual` | Voice notes tier / download (confirm) / delete / test - v2-ux 4.2 | DOM changed | OK | settings-settings-voice-voice-multilingual_0-he-after.png |
| `settings-voice-voice-lite` | Voice notes tier / download (confirm) / delete / test - v2-ux 4.2 | DOM changed | OK | settings-settings-voice-voice-lite_0-he-after.png |
| `settings-voice-test` | Voice notes tier / download (confirm) / delete / test - v2-ux 4.2 | no DOM change; IPC voice:selfTest, voice:getState | UNCLEAR | settings-settings-voice-test_0-he-after.png |
| `settings-images-enabled` | Pictures: local-only toggle / download / restart - v2-ux 4.3 | DOM changed; IPC settings:set, auto:listWrites | OK | settings-settings-images-enabled_0-he-after.png |
| `settings-images-download` | Pictures: local-only toggle / download / restart - v2-ux 4.3 | DOM changed; IPC model:startDownload, model:getPlan | OK | settings-settings-images-download_0-he-after.png |
| `settings-relink` | Re-link WhatsApp: confirm first, then QR panel - ux.md 9 | dialog open: settings-confirm; DOM changed; confirm dialog shown: yes | OK | settings-settings-relink_0-he-after.png |
| `settings-wipe` | Unlink and wipe: danger confirm first - ux.md 9 | dialog open: settings-confirm; DOM changed; confirm dialog shown: yes | OK | settings-settings-wipe_0-he-after.png |
| `settings-google-reconnect` | "Connect" (Google): google:startSignIn -> opens the Google sign-in in the browser, shows waiting/connected - ux.md 9 / 8.3 | DOM changed; IPC google:startSignIn; external https://accounts.google.com/o/oauth2/v2/auth?... | OK | settings-settings-google-reconnect_0-he-after.png |
| `settings-google-replace` | "Replace key file": native open dialog (google:pickCredentialsFile) - ux.md 9 | no DOM change; IPC google:pickCredentialsFile; native showOpenDialog(Google OAuth credentials (JSON)) | OK | settings-settings-google-replace_0-he-after.png |
| `settings-google-disconnect` | Disconnect Google: danger confirm first - ux.md 9 | dialog open: settings-confirm; DOM changed; confirm dialog shown: yes | OK | settings-settings-google-disconnect_0-he-after.png |
| `settings-target-calendar` | Target calendar, saved - ux.md 9 | DOM changed; [select has a single option - nothing to change] | OK | settings-settings-target-calendar_0-he-after.png |
| `settings-conflict-primary` | Conflict calendars (at least one stays checked) - ux.md 9 | DOM changed; (effect only after > 500 ms) | OK | settings-settings-conflict-primary_0-he-after.png |
| `auto-scope-edits` | (no spec line found - inferred from the label) | DOM changed | OK | settings-auto-scope-edits_0-he-after.png |
| `auto-scope-cancels` | (no spec line found - inferred from the label) | DOM changed | OK | settings-auto-scope-cancels_0-he-after.png |
| `auto-scope-quiet` | (no spec line found - inferred from the label) | DOM changed | OK | settings-auto-scope-quiet_0-he-after.png |
| `auto-scope-validity` | (no spec line found - inferred from the label) | DOM changed; [select "30" -> "90"] | OK | settings-auto-scope-validity_0-he-after.png |
| `auto-open-activity` | Opens the Automatic activity page - v2-ux 4.5 / 4.6 | view settings/general -> settings/activity; DOM changed; IPC auto:listWrites | OK | settings-auto-open-activity_0-he-after.png |
| `settings-unknown-senders` | (no spec line found - inferred from the label) | DOM changed; IPC settings:set, auto:listWrites | OK | settings-settings-unknown-senders_0-he-after.png |
| `settings-readtools-off` | "Let the AI read older messages" choice - v2-ux 4.7 | DOM changed; IPC settings:set, auto:listWrites | OK | settings-settings-readtools-off_0-he-after.png |
| `settings-readtools-trigger_chat` | "Let the AI read older messages" choice - v2-ux 4.7 | DOM changed; (effect only after > 500 ms) | OK | settings-settings-readtools-trigger_chat_0-he-after.png |
| `settings-readtools-all_chats` | "Let the AI read older messages" choice - v2-ux 4.7 | no DOM change; IPC wa:setReadScope, settings:get; native seamDialog(setting_read_all_chats) | OK | settings-settings-readtools-all_chats_0-he-after.png |
| `settings-backlog` | Backlog hours, saved - ux.md 9 | DOM changed; IPC settings:set, auto:listWrites; [select "0" -> "12"] | OK | settings-settings-backlog_0-he-after.png |
| `settings-ambiguous-assume` | Ambiguous time rule, saved - ux.md 9 | DOM changed; (effect only after > 500 ms) | OK | settings-settings-ambiguous-assume_0-he-after.png |
| `settings-ambiguous-ask` | Ambiguous time rule, saved - ux.md 9 | DOM changed; IPC settings:set, auto:listWrites | OK | settings-settings-ambiguous-ask_0-he-after.png |
| `settings-duration` | Default duration, saved - ux.md 9 | DOM changed; IPC settings:set, auto:listWrites; [select "60" -> "30"] | OK | settings-settings-duration_0-he-after.png |
| `settings-policy-select-1` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | DOM changed; IPC chat:setPolicy, chat:listPolicies; [select "default" -> "never"] | OK | settings-settings-policy-select-1_0-he-after.png |
| `settings-policy-auto-1` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | DOM changed; IPC chat:setPolicy, chat:listPolicies; [select "inherit" -> "never"] | OK | settings-settings-policy-auto-1_0-he-after.png |
| `settings-policy-remove-1` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | no DOM change; IPC chat:setPolicy, chat:listPolicies | UNCLEAR | settings-settings-policy-remove-1_0-he-after.png |
| `settings-policy-select-2` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | DOM changed; IPC chat:setPolicy, chat:listPolicies; [select "default" -> "never"] | OK | settings-settings-policy-select-2_0-he-after.png |
| `settings-policy-auto-2` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | DOM changed; IPC chat:setPolicy, chat:listPolicies; [select "inherit" -> "never"] | OK | settings-settings-policy-auto-2_0-he-after.png |
| `settings-policy-remove-2` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | no DOM change; IPC chat:setPolicy, chat:listPolicies | UNCLEAR | settings-settings-policy-remove-2_0-he-after.png |
| `settings-policy-select-3` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | DOM changed; IPC chat:setPolicy, chat:listPolicies; [select "default" -> "never"] | OK | settings-settings-policy-select-3_0-he-after.png |
| `settings-policy-auto-3` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | DOM changed; IPC chat:setPolicy, chat:listPolicies; [select "inherit" -> "never"] | OK | settings-settings-policy-auto-3_0-he-after.png |
| `settings-policy-remove-3` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | no DOM change; IPC chat:setPolicy, chat:listPolicies | UNCLEAR | settings-settings-policy-remove-3_0-he-after.png |
| `settings-policy-select-4` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | DOM changed; IPC chat:setPolicy, chat:listPolicies; [select "default" -> "never"] | OK | settings-settings-policy-select-4_0-he-after.png |
| `settings-policy-auto-4` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | DOM changed; IPC chat:setPolicy, chat:listPolicies; [select "inherit" -> "never"] | OK | settings-settings-policy-auto-4_0-he-after.png |
| `settings-policy-remove-4` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | no DOM change; IPC chat:setPolicy, chat:listPolicies | UNCLEAR | settings-settings-policy-remove-4_0-he-after.png |
| `settings-policy-select-5` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | DOM changed; IPC chat:setPolicy, chat:listPolicies; [select "default" -> "never"] | OK | settings-settings-policy-select-5_0-he-after.png |
| `settings-policy-auto-5` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | DOM changed; IPC chat:setPolicy, chat:listPolicies; [select "inherit" -> "never"] | OK | settings-settings-policy-auto-5_0-he-after.png |
| `settings-policy-remove-5` | Per-contact policy, saved - ux.md 9 / v2-ux 4.5 | no DOM change; IPC chat:setPolicy, chat:listPolicies | UNCLEAR | settings-settings-policy-remove-5_0-he-after.png |
| `settings-gender-m` | Hebrew address form, saved - ux.md 9 | DOM changed; IPC settings:set, auto:listWrites | OK | settings-settings-gender-m_0-he-after.png |
| `settings-gender-f` | Hebrew address form, saved - ux.md 9 | DOM changed; IPC settings:set, auto:listWrites | OK | settings-settings-gender-f_0-he-after.png |
| `settings-gender-unspecified` | Hebrew address form, saved - ux.md 9 | DOM changed | OK | settings-settings-gender-unspecified_0-he-after.png |
| `settings-retention` | Retention, saved - ux.md 9 | DOM changed; IPC settings:set, auto:listWrites; [select "30" -> "7"] | OK | settings-settings-retention_0-he-after.png |
| `settings-purge` | Purge now: danger confirm first - ux.md 9 | dialog open: settings-confirm; DOM changed; confirm dialog shown: yes | OK | settings-settings-purge_0-he-after.png |
| `settings-diagnostics` | Export diagnostics: native save dialog - ux.md 9 | no DOM change; IPC diagnostics:export; native showSaveDialog(לייצא אבחון) | OK | settings-settings-diagnostics_0-he-after.png |
| `settings-licences` | Opens the licences dialog - ux.md 9 | dialog open: settings-licences-dialog; DOM changed | OK | settings-settings-licences_0-he-after.png |
