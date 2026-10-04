# v2 adversarial review - lens "ux-i18n-v2"

Reviewer label: `v2-review-ux-i18n-v2` (v2 phase 3). I reviewed the built renderer under `src/renderer/src` and the shared
i18n under `src/shared/i18n` + `src/shared/locales`, using ARCHITECTURE-v2 and `docs/specs/v2-ux.md` (sections 2-7, 9,
14) as the contract. I edited no product file.

Scratch proofs: `ops/agent-notes/v2-review-ux-i18n-v2.scratch/findings.test.tsx` (own vitest config next to it).
Run:
`npx vitest run --config "ops/agent-notes/v2-review-ux-i18n-v2.scratch/vitest.scratch.config.ts"`
Result on 2026-10-04: **12 of 12 tests fail**. Each test asserts what the spec asks for, so every red test is a confirmed
finding (ids 1-7 below). Findings 8-11 are shown by reading the code; I wrote no test for them.

## Checked and found sound (no finding)

- en/he key parity: 1359 en keys and 1369 he keys. The only extra he keys are Hebrew `_two` plural forms. No key is
  missing in either language. Placeholders match in every pair; the only differences are he `_one` forms that spell the
  number out ("יום אחד"), which is correct. Every dynamic key family resolves in both languages: `auto.reason.<49>`,
  `auto.pausedReason.<7>`, `errors.<68>.title/body`, `label.badge.<15>`, `image.unread.*`, `badge.automatic.long.*`,
  `auto.stateWord.*` and `voice.lang.*`.
- Change card: a ChangeLine with one `<bdi>` per side and an aria-hidden arrow (U+2190 in he); "Approve change" is
  accent only when it is the card's only approval; "Cancel event" uses an outline button with danger text and is never
  primary; "Keep ..." calls `action:reject` without a guard; `change_unclear` has no change buttons; the drift row's
  "Apply anyway" approves the pending clone and is guarded.
- AutoStrip: it is not a fourth list (no counts in list headers, no approvals), it leaves the DOM when idle, its Undo is
  guarded and sends one IPC per click, and Pause shows only while the state is `on`.
- Voice and Image bubbles are inert: one text node each, `dir="auto"`, no links, a `data:image/(jpeg|png|webp);base64`
  allow-list, `draggable=false` and no context menu. `escapeValue:false` is safe because React escapes.
- Connect card: the command field is a read-only LTR input; Antigravity shows the experimental chip and a disclosure
  that cannot be dismissed (full size); the consent dialog repeats the whole disclosure before any switch.

## Findings

### ux-i18n-v2-1 (major) - `navRequest` is never consumed: seven navigation buttons do nothing
`src/renderer/src/store/dashboard.ts:214` stores `requestNavigation(req)` in `navRequest`, and the comment says
"the shell clears it once handled". No file under `src/renderer/src` reads `navRequest` or calls `clearNavRequest`
(App.tsx included). These controls therefore do nothing:
- AutoStrip "Show all in Automatic activity" (`AutoStrip.tsx:245`);
- the sheet's "See all automatic activity" (`ItemCard.tsx:1265`). It also closes the sheet, so the click looks like it
  only closed the sheet;
- RawCard.media (`RawCard.media.tsx:93,134,156,160`): voice "Turn on in Settings", voice "Use Lite"
  (`VOICE_TOO_LONG_FOR_DEVICE`), picture "Turn on in Settings" and "Choose an AI that can read pictures". Each of these
  is the card's ONE action (UX2 3.5 / 3.6), so those cards have no working action.
Proof: scratch tests `ux-i18n-v2-1` (both red). `data-view` stays `dashboard`.
Fix: in App.tsx, subscribe to `navRequest`. `{view:'activity'}` -> `openSettings('activity')`;
`{view:'settings', section}` -> `openSettings(section === 'auto' ? 'auto' : 'ai')`. Then `clearNavRequest()`.

### ux-i18n-v2-2 (major) - AutomaticMode reads every BAD_REQUEST as "rate limited", or hides it
`views/settings/AutomaticMode.tsx:110` sets `rateLimited` on ANY `BAD_REQUEST` from `auto:requestEnable`, and `:445`
hides every `BAD_REQUEST` error. But main (`src/main/exec/autoPolicy.ts` `precondition()` / `resume` / `endShadow`)
returns `BAD_REQUEST` for several cases that have nothing to do with the rate limit: provider does not allow auto
(Antigravity), a live policy already exists, an invalid scope, a changed snapshot on resume / endShadow, an expired
policy on resume, and a trial with fewer than 3 decisions on resume.
- With Antigravity active, UX2 keeps the enable buttons enabled with a warning. Clicking one gets `BAD_REQUEST` and the
  page then says "Try again in an hour." for the rest of the mount, and the enable buttons disappear. That is false.
- Paused with reason `snapshot_changed` (calendar, account, AI or app version changed): "Resume" gets `BAD_REQUEST` and
  nothing at all is shown. Resume can never succeed, and the page never says "Stop and turn it on again". The same
  silence follows a refused "Turn on for real".
Proof: scratch tests `ux-i18n-v2-2` (both red).
Fix: main needs a distinct code (for example a rate-limit code, plus `AUTO_SNAPSHOT_CHANGED` / provider codes), or the
renderer must not map `BAD_REQUEST` to `rate`. Either way, show the refusal with the action that works (Stop + enable
again).

### ux-i18n-v2-3 (major) - Automatic mode states with no action
- `expired` with an unmet precondition (for example the calendar is disconnected, or fewer than 3 approved creates):
  `AutomaticMode.tsx:177` hides Renew and `:396` (`policy?.state !== 'expired'`) hides the precondition line. The user
  sees "Ended on ... Events wait for your approval." with no button and no reason. The SetupStrip "Renew" (row 9)
  navigates to this dead end.
- `on` with 7 days or fewer left: UX2 4.5 lists "Pause / Stop / Renew (only in the last 7 days)", and SetupStrip row 7
  shows **Renew** (`SetupStrip.tsx:100-101` -> `openSettings('auto')`). The `on` actions at `:208-222` have no Renew;
  the page only repeats "Automatic mode ends in N days." The builder noted the missing channel (V2-W1-12 notes) but the
  UI still promises "Renew" and then leads nowhere.
Proof: scratch tests `ux-i18n-v2-3` (both red).

### ux-i18n-v2-4 (major) - Voice notes say "on" after a download while voice stays off
`views/settings/VoiceNotes.tsx:119-124` stores only `voice.tier` and starts the download, because main refuses
`enabled:true` before the model is ready. `:96` then checks the radio of `chosen`. When the download finishes, the
status turns "ready" and the radio still shows the tier as selected, but `settings.voice.enabled` stays `false`.
Nothing ever sets it (the builder's REQUEST 4 is still open). Clicking an already-checked radio fires no `onChange`, so
the user cannot fix it from the control that looks on. Voice notes keep arriving as untranscribed raw cards, and their
"Turn on in Settings" button is dead (finding 1). The onboarding opt-in (`Onboarding/ChooseAi.tsx:231-233`) has the same
fall-back, so a user who ticks "Also understand voice notes" never gets voice notes.
Proof: scratch test `ux-i18n-v2-4` (red): radio checked, `voice.enabled === false`.

### ux-i18n-v2-5 (major) - ReadTools: "Not changed" after it changed; all chats re-enabled without main's confirmation
`views/settings/ReadTools.tsx:63-77`. `choose()` first sends `settings:set {readTools:{enabled:true}}` and only then
checks consent and scope:
- Off -> "Of all my chats" with a cloud provider whose consent is out of date: reading older messages is switched ON
  (with the stored scope, `trigger_chat` by default), while the page says "Not changed - your approval is needed first."
  It stays on when the consent dialog is cancelled.
- Off -> "Of all my chats" when the stored scope is already `all_chats`: `choice === rt.scope`, so `wa:setReadScope` is
  never called. All-chats reading comes back through `settings:set` with no main-owned native confirmation (F11 / UX2
  4.7). Main's `settings:set` has no guard on `readTools.enabled`.
Proof: scratch tests `ux-i18n-v2-5` (both red).
Fix: decide consent and scope before enabling, and always route `all_chats` through `wa:setReadScope`.

### ux-i18n-v2-6 (minor) - "Cancel event" / "Restore original" swallow main's refusal
`components/UndoControl.tsx:94-101`: `GuardedButton` does `.catch(() => undefined)` and never reads the `Result`. A
refused `item:cancelEvent` (CAL_UNAVAILABLE, WINDOW_NOT_FOCUSED, ACTION_STALE, ...) or a refused
`item:restoreOriginal` puts the button back to its label with no message. The card refreshes unchanged and the user
cannot tell whether anything happened.
Proof: scratch test `ux-i18n-v2-6` (red).

### ux-i18n-v2-7 (minor) - "ends in 1 days": count keys without plural forms
`health.sub.auto.on` ("Automatic mode: on - ends in {{count}} days") and `setup.auto.expiring` ("Automatic mode ends in
{{count}} days.") have no `_one` / `_two` / `_other` variants in en or he. On the last day of a policy, the status
sub-line (`HealthPill.tsx:86`), SetupStrip row 7 (`SetupStrip.tsx:74`) and the settings line
(`AutomaticMode.tsx:292`) read "ends in 1 days" / "בעוד 1 ימים". The sibling keys `auto.state.on` and
`activity.stateOn` already have plural forms.
Proof: scratch tests `ux-i18n-v2-7` (both red).

### ux-i18n-v2-8 (minor) - The sheet's Automatic block says "Added automatically on ..." for moves and cancels
`components/ItemCard.tsx:1255` always uses `card.autoBlock.addedOn`. For an automatic move or cancel, the same sheet
shows the chip "Moved automatically" / "Cancelled automatically" (`badge.automatic.long.update/cancel`) and the block
"Added automatically on Wed 23 Sept 14:10". The two contradict each other.

### ux-i18n-v2-9 (minor) - The Undo deadline shows only a weekday, which is ambiguous at 7 days
`components/UndoControl.tsx:168` formats `undo.until` with `formatWhen` ("Wed 10:00"). A manual change has a 7-day undo
window. A change made on Wednesday at 10:00 to an event three weeks away therefore reads "Undo available until Wed
10:00" on that same Wednesday, which looks already expired. `formatWhenWithDay` exists and gives the date.

### ux-i18n-v2-10 (minor) - Undo doors are incomplete in the strip and the activity page
- `components/AutoStrip.tsx:193-198`: a strip row never offers "Restore original". UX2 3.4 says that after two automatic
  edits "the card and the AutoStrip row also show Restore original".
- `views/AutoActivity.tsx:224-229`: write rows have no "Show" (UX2 4.6: the same row as the AutoStrip, "Show" opens the
  item). There is no way to open the item from the activity page. Shadow and fallback rows are missing too (builder
  REQUEST: there is no read channel). During a trial, the page says "Nothing happened automatically yet." even though the
  trial made decisions.

### ux-i18n-v2-11 (minor) - Connect card: a failed sign-in is silent
`components/ConnectCard.tsx:169-172`: `signIn` only does `if (r.ok) setWaiting(true)`. `cli:signIn` can return
`CLI_NOT_INSTALLED`, `CLI_VERSION`, `BAD_REQUEST` or `INTERNAL` (`src/main/ipc/handlers/cli.ts:116-128`). On those the
button does nothing visible and no status is refreshed. Example: the CLI was uninstalled after the last 60 s status.

## Notes / assumptions
- I did not count as defects the known spec gaps the builder already listed (shadow tally without an add/change split,
  no consent Withdraw channel). I did count those whose visible result is a dead or false UI: 3, 4 and 10.
- `canRestoreOriginal` is a renderer heuristic (revision >= 3). Main accepts any non-empty automatic span, so a false
  positive acts like Undo and is harmless. No finding.
- D-068 (media-derived items may be automatic once the gates pass): every `FEATURE_GATES` entry is false today, so
  "What never happens: anything from a voice note or a picture" is still true. It becomes false when a gate flips. Watch
  this, but it is not a defect now.
