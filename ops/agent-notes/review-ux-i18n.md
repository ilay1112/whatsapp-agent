# Adversarial code review — lens `ux-i18n`

Reviewer label: `review-ux-i18n` (phase 3, adversarial review).
Subject: the BUILT renderer under `src/renderer/` (+ the two shared i18n modules and the one main-side call site that
feeds a renderer error state). Design docs used as context only.
No product file was edited. Scratch reproductions live in
`ops/agent-notes/review-ux-i18n.scratch/` (`findings.test.tsx`, `vitest.scratch.config.ts`, `deadkeys.mjs`) — they are
outside `tests/` and outside `src/`, so they are not part of `npm test`.

Run the reproductions with:

```
$env:PATH = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;" + $env:PATH
npx vitest run --config "ops/agent-notes/review-ux-i18n.scratch/vitest.scratch.config.ts"
```

Result at the time of writing: **6 failing assertions across 3 finding groups** (ux-i18n-1, -2, -3), all red against
the current code.

---

## What is correct (checked, no finding)

These were checked against the locked requirements and hold up; recording them so the next reviewer does not redo them.

- **Three lists, fixed order.** `LIST_KEYS = ['needs_reply','in_calendar','info_missing']`
  (`src/renderer/src/store/dashboard.ts:12`) is the single source of order, and `Dashboard.tsx` maps it directly. Titles
  come from `list.needs_reply` / `list.in_calendar` / `list.info_missing`; all three exist in both locales.
  One-column mode collapses sections with `in_calendar` closed by default (`sectionOpen` initial state) — as specified.
- **No physical-direction CSS.** A grep for `ml-/mr-/pl-/pr-/text-left/text-right/border-l/border-r/rounded-l/rounded-r/
  left-/right-` over `src/renderer/**` (tsx + css) returns exactly one hit, and it is the word "right-to" inside a
  comment in `DownloadPill.tsx:119`. `dashboard.css` and `setup.css` use logical properties throughout
  (`border-start-start-radius`, `inset-block-start`, `border-inline-start`). `QuotedBubble` uses `justify-start` /
  `justify-end` (flex, direction-aware) and `rounded-ss-xs` / `border-s-2`.
- **Untrusted text is inert.** No `dangerouslySetInnerHTML` / `innerHTML` anywhere in `src/renderer` or `src/shared`.
  `QuotedBubble` has no `children` prop and renders `text` as a text node. `renderBdiTemplate`
  (`ItemCard.tsx:63`) deliberately avoids `<Trans>` so an untrusted contact name never reaches an HTML parser — the
  values are handed to React as children. Contact names are wrapped in `<bdi>`; the phone in `<bdi dir="ltr">`;
  message bodies get `.msg-text` (`unicode-bidi: plaintext`) plus `dir="auto"`.
- **No optimistic UI on send/create.** `runApprove` only calls `applyItem` / sets the confirmation row *after* main
  answers (`ItemCard.tsx:236-300`). The busy label is driven by `busyKind`, and `dismiss()` — the one optimistic path —
  is explicitly not an approval.
- **Double-click and single-flight guards.** `approveHandlers.onClick` (`ItemCard.tsx:313-322`) drops `e.detail > 1`,
  drops while `busyRef.current`, and the button is additionally `disabled` while `busyKind !== null`.
- **Focus-steal guard on the primary controls.** `isActivationBlocked()` is read at click time (not render time) in
  `approveHandlers.onClick`, and `onKeyDown` preventDefaults Enter/Space while armed. (But see **ux-i18n-1**.)
- **X hides to tray.** `installCloseToTray` (`src/main/app/window.ts`) preventDefaults every `close` and hides
  immediately, including the first one, unless the quit sequence is running.
- **en/he key parity.** `deadkeys.mjs` confirms the only he-exclusive keys are the five legitimate Hebrew duals
  (`*_two`), each with an `_one`/`_other` base in en — exactly what `locales.test.ts` allows. Node/ICU 78 reports
  Hebrew plural categories `one | two | other`, so the `_many` ban in that test is correct and no plural form is
  missing.
- **Initial dialog focus.** `useDialogChrome` focuses the close button on open and restores focus to the opener on
  close; the sheet's close button is rendered by the dialog chrome (before `item:get` resolves), so focus lands on the
  first paint.

---

## Findings

### ux-i18n-1 — `major` — the conflict "Add anyway" button is an approval control that bypasses the `[R2]` focus guard

`src/renderer/src/components/ItemCard.tsx:270-281`

The file's own header states: *"`[R2]` every approval control ignores click / Enter / Space while the focus guard is
armed (500 ms after the window gained focus or became visible) — read at CLICK time"*. Every approval funnels through
`approveHandlers`, which enforces that — **except** the `needs_confirm_conflict` recovery action, which builds its own
handler:

```ts
run: () => {
  if (busyRef.current) return;
  busyRef.current = true;
  setBusyKind(action.kind);
  ...
  void runApproveRef.current?.(action, { confirmConflict: true });
},
```

There is no `isActivationBlocked()` check and no `e.detail > 1` check; `ResultRowView` renders it as a bare
`<button onClick={a.run}>` with no `onKeyDown` guard either. This control sends `action:approve` with
`confirmConflict: true` — i.e. it **writes an event to the calendar**.

Failure scenario: the user clicks "Add to calendar", main answers `needs_confirm_conflict`, the red row with
"Add anyway" appears under the pointer. The user alt-tabs away (or a notification/another app steals and returns
focus). Within 500 ms of the window regaining focus, a click — or a click the user did not intend for this window —
lands on "Add anyway" and the event is created. Main's own guard does not cover this: `action:approve`
(`src/main/ipc/handlers/actions.ts:26`) only requires the window to be visible+focused (it is, by then), and the 300 ms
`focusGuardMainMs` in `actionExecutor.ts:363` only applies when `ctx.shownByNotificationAt !== null`.

Proven by `ux-i18n-1` in the scratch file: with the guard armed via `noteActivation(Date.now())`, `action:approve` is
called a second time (`expected "vi.fn()" to be called 1 times, but got 2 times`).

Fix: route the recovery action through `controller.approveHandlers(action, { confirmConflict: true })` instead of a
hand-rolled `run`, or at minimum add `if (isActivationBlocked()) return;` as the first statement of `run` and give
`ResultRowView`'s buttons the same `onKeyDown` guard.

---

### ux-i18n-2 — `major` — every red Calendar state in the status panel has no action button

`src/renderer/src/components/HealthPill.tsx:168-176` (with `src/main/compose.ts:550`)

`HealthPill`'s header says *"Every red state offers exactly one action."* An action label is produced only when the
part carries an `ErrorCode`, or for the two hard-coded non-red calendar states:

```ts
if (part === 'calendar' && (state === 'not_configured' || state === 'needs_sign_in'))
  actionLabel = t('health.action.connect');
```

But `compose.ts:550` publishes the calendar part as `healthHub.setCalendar({ state: s })` — **never with a `code`**
(the only other call site, line 1234, sets `not_configured`). The WhatsApp part does the opposite:
`setBridge(code === null ? { state: s } : { state: s, code })` with `bridgeStatusToErrorCode` mapping every red bridge
state to a code, and the LLM part always passes `usable.code`. So the calendar is the one part whose attention states
arrive code-less.

`overallOf` (`src/shared/health.ts`) makes `reconnect_required`, `unavailable`, `port_busy` and `toolset_mismatch` all
`attention` (they are in neither `OK_CAL` nor `WORKING_CAL`). Result: the row renders red, says e.g.
"Google connection expired" (`health.calendar.reconnect_required`), and offers **nothing** — no button, no link, no
next step. The matching branch in `App.tsx`'s `onHealthAction` (`part === 'calendar' && !code` → open the Google
wizard) is therefore unreachable, and so is the `code === 'CAL_TOOLSET_MISMATCH'` branch.

Failure scenario (the common one): the Google OAuth token expires. `host.ts:351/363` sets `reconnect_required`. The
user opens the status pill, sees a red Calendar row saying the connection expired, and has no way to reconnect from
there. The only path left is guessing that Settings → Calendar → Reconnect exists.

Proven by `ux-i18n-2` (4 cases): `health-row-calendar` has `data-status="attention"` and
`queryByTestId('health-action-calendar')` is `null`.

Fix: either have `compose.ts` map the McpStatus to an ErrorCode the way `bridgeStatusToErrorCode` does, or extend the
`part === 'calendar'` branch in `HealthPill` to cover `reconnect_required | unavailable | port_busy |
toolset_mismatch`.

---

### ux-i18n-3 — `major` — the approval sheet shows the raw Google calendar id ("Calendar: primary") in both languages

`src/renderer/src/components/ItemCard.tsx:609` → `EventEditor.tsx:263`

```ts
const calendarName = useSettingsStore((s) => s.settings?.calendar.targetCalendarId) ?? 'primary';
...
{t('event.calendarName', { name: props.calendarName })} - {t('event.noInvites')}
```

`targetCalendarId` is an **API identifier**, not a name. `DEFAULT_SETTINGS.calendar.targetCalendarId` is `'primary'`,
so for every user who has not changed it the approval sheet — the screen where the user commits to writing to their
calendar — reads:

- en: `Calendar: primary - No invitations are sent`
- he: `יומן: primary - לא יישלחו הזמנות`

If the user picks a secondary calendar in Settings, it becomes worse, e.g.
`יומן: abc123def@group.calendar.google.com`. The display name is already available: `Settings.tsx:243` fetches
`api.listCalendars()` into `CalendarInfo[]` (which carries `name`), and `Settings.tsx:654-659` falls back to the id
only when the list is empty.

Secondary bidi problem in the same line: `{{name}}` is an LTR-only token interpolated into an RTL sentence with no
isolation (see **ux-i18n-7**).

Proven by `ux-i18n-3`: the rendered `event-editor` text is
`TitleDateFromToWhereCalendar: primary - No invitations are sent`.

Fix: resolve the id to a `CalendarInfo.name` (and isolate it), falling back to a translated "Main calendar" string for
`primary` rather than printing the literal token.

---

### ux-i18n-4 — `major` — a failed bootstrap (other than `DB_RECOVERY`) is an unrecoverable dead-end screen

`src/renderer/src/App.tsx:410-416`

```tsx
if (!bootstrap) {
  return (
    <div data-testid="app-loading" ...>
      {bootError ? t(`errors.${bootError}.title`) : t('app.loading')}
    </div>
  );
}
```

`api.getBootstrap()` is called exactly once, in an effect with `[announce]` deps that never re-runs
(`App.tsx:206-246`). If it fails with anything but `DB_RECOVERY` — `INTERNAL`, a handler throw, an IPC timeout — the
renderer renders one centred sentence: the error **title** only. No body, no retry button, no "Export diagnostics", no
way to reach Settings or onboarding. The window cannot even be closed into a working state, because there is no
reload path. Every `ErrorCode` has an `errors.<CODE>.action` key and an `ERROR_ACTION` entry (used by `HealthPill` and
by `UndoDismissDrawer`, which *does* offer `app.tryAgain`), so the vocabulary for a recovery action exists and is
simply not used here.

Failure scenario: `app:getBootstrap` returns `{ok:false, code:'INTERNAL'}` once on a cold start. The user sees
"Something went wrong" forever; the only escape is quitting from the tray icon and hoping the next start differs.

Fix: give the bootstrap-error screen the same treatment as `undo-dismiss-error` — `errors.<code>.body` plus an
`app.tryAgain` button that re-runs `api.getBootstrap()`.

---

### ux-i18n-5 — `major` — the pairing error panel has no recovery action

`src/renderer/src/components/QrPairing.tsx:77-86`, with `src/renderer/src/views/Onboarding/LinkWhatsApp.tsx:65-100`

`QrPairing` renders three branches. The `timeout` branch offers `pairing.newCode` → `onNewCode()`. The `error` branch
renders only `errors.<code>.title` + `errors.<code>.body` inside a `role="alert"` box — **no button at all**, although
`onNewCode` is already in scope and `errors.<code>.action` exists for every code.

In `LinkWhatsApp`, the surrounding `StepFrame` sets `primary={connected ? <continue/> : null}`, so in the error state
there is no primary button either, and `footerStart` still shows "Waiting for you to scan…" (`pairing.waiting`) while
the panel above says the pairing failed — two contradictory statements on screen at once.

Failure scenario: the bridge refuses to start (`BRIDGE_SPAWN_REFUSED`) or the session was logged out
(`WA_LOGGED_OUT`). `toPanelState` maps pairing status `error`/`unavailable` → `{status:'error', errorCode}`. The
onboarding step shows a red box, a contradictory "waiting" footer, and only "Back" as an exit — the user cannot
request a fresh code or retry from the step that is supposed to link WhatsApp.

Fix: render `errors.<code>.action` (or `pairing.newCode`) as a button in the `error` branch, and suppress the
`pairing.waiting` footer while `panel.status === 'error'`.

---

### ux-i18n-6 — `minor` — six dead locale keys, hidden by the `SEEDED_*` allow-lists; the "send again / add again" retry action was dropped

`src/shared/locales/{en,he}.json`, `src/renderer/src/i18n.usage.test.ts:41-46`

`i18n.usage.test.ts` allow-lists the whole prefixes `card.`, `action.`, `event.`, `google.`, `tray.`, `calendar.` as
"seeded for a package that has not written its screens yet". W1-15 (`card.*`, `action.*`, `event.*`) has since
shipped, but the guard's staleness check (`no allow-list entry covers only keys that are referenced anyway`) only
fires when **every** key under a prefix is referenced — one unreferenced key keeps the prefix alive and masks all the
others. `deadkeys.mjs` reproduces the scan; cross-checking each candidate by hand (several are reached through
ternaries or `t(variable)` that the scanner cannot see) leaves six keys with **zero** references anywhere in `src/`,
tests included:

| key | en value |
|---|---|
| `action.sendAgain` | "Send again" |
| `action.addAgain` | "Add again" |
| `action.createAnyway` | "Create anyway" |
| `action.edit` | "Edit" |
| `card.changeTime` | "Change time" |
| `footer.ignored` | "Ignored ({{count}})" — the drawer uses `ignored.title` instead |

`action.sendAgain` / `action.addAgain` are not merely unused strings: `rowForError`'s default branch
(`ItemCard.tsx:220-226`) contains the tell-tale

```ts
actions: kind === 'send_reply' ? [refresh] : [refresh],
```

— two identical branches where the send/create retry action clearly used to differ. So after a generic failure the
only offered action is "Refresh card"; the user is never offered "Send again" / "Add again", and the offered branch is
dead code that lint cannot see.

`footer.ignored` is additionally listed in `SEEDED_KEYS` as "W1-15", whose screen (`UndoDismissDrawer`) shipped using
`ignored.title`/`ignored.empty`; the entry is stale and the guard cannot detect it.

Fix: delete the six keys (and the stale `SEEDED_KEYS` entry / the `card.`, `action.`, `event.` prefixes), or wire
`action.sendAgain` / `action.addAgain` back into `rowForError` and collapse the identical ternary.

---

### ux-i18n-7 — `minor` — LTR-only identifiers are interpolated into Hebrew sentences with no isolation; `ltr()` has zero callers

`src/shared/i18n/bidi.ts:28` (`export function ltr`), `src/renderer/src/i18n.ts:28` (the `ltr` i18next formatter)

The project has two mechanisms for this exact problem — `bidi.ts`'s `ltr()` ("phone numbers, JIDs, e-mail, URLs,
paths, versions inside RTL text") and the `{{value, ltr}}` i18next formatter — and **neither has a single caller in
product code**. A grep over `src/**` finds `ltr(` only in `bidi.ts` itself and in tests; `{{…, ltr}}` appears in no
locale value; `{{…, bdi}}` appears in exactly one (`app.announce.sent`).

The values that need it and do not have it:

- `src/renderer/src/components/HealthPill.tsx:171` — `detail = health.llm.model`, rendered as
  `<span className="block text-xs text-text-muted">{row.detail}</span>`: no `dir`, no `bdi`, no isolation. The value is
  a cloud model id such as `claude-sonnet-4-5-20250929`. In the Hebrew UI this sits in an RTL paragraph; by UAX#9 N1/N2
  the hyphens that separate a Latin run from a digit run are neutrals between L and (number-as-R) and take the
  paragraph level, so the id is rendered with its segments re-ordered rather than as one LTR token.
- `src/renderer/src/views/Settings.tsx:474` — `settings.general.timeZoneValue` = `"{{zone}} - נלקח מ-Windows"` with
  `zone = "Asia/Jerusalem"`.
- `src/renderer/src/components/EventEditor.tsx:263` — `event.calendarName` = `"יומן: {{name}}"` with a calendar id /
  e-mail (see **ux-i18n-3**).

By contrast the places that *were* handled are handled correctly (`<bdi dir="ltr">` on `card-phone` and in
`card.sendsTo`; `<bdi>` on `settings.calendar.accountLabel`'s e-mail; `formatTimeRange`'s `FSI…PDI`), which is what
makes these three look like omissions rather than a deliberate policy.

Fix: wrap the three values with the existing `ltr()` helper (plain strings) or `<bdi dir="ltr">` (JSX).

---

### ux-i18n-8 — `minor` — the "Still loading…" message is inside an `aria-hidden` subtree, so it is never announced

`src/renderer/src/views/Dashboard.tsx:54` and `:62`

```tsx
<div data-testid="list-skeletons" aria-hidden="true" ...>
  ...
  {slow ? <p ...>{t('list.stillLoading')}</p> : null}
</div>
```

`aria-hidden="true"` is correct for the two skeleton blocks, but it also covers the delayed status line. After 3 s of
a slow `dashboard:get`, sighted users get "Still loading…" and screen-reader users get nothing at all — the columns
stay silent and empty. `list.stillLoading` exists in both locales purely for this line, so it is effectively
unreachable for AT.

Failure scenario: `dashboard:get` takes longer than 3 s (cold SQLite open, large backlog). A screen-reader user hears
the three column headings with counts of 0 and no indication that anything is still in flight.

Fix: move the `slow` paragraph outside the `aria-hidden` wrapper (and give it `role="status"`).

---

### ux-i18n-9 — `minor` — the UX 2.4 "arrival" edge is defined in CSS and never applied

`src/renderer/src/styles.css` (`@keyframes wca-arrival` / `@utility card-arrival`)

The stylesheet defines, and documents, the arrival affordance: *"A card that arrived or changed while the window was
visible: a 3 px edge that fades, no movement (UX 2.4)"*, including its `prefers-reduced-motion` override. A grep for
`card-arrival` across `src/**` returns only the definition — no component, no class-name expression, no test applies
it. `ItemList`/`ItemCard` render every card identically whether it is new or not.

Failure scenario: a new card is pushed into "Needs reply" (`dashboard:changed` → `refresh()`) while the user is
looking at the dashboard. Nothing marks it as new; the only cue is the throttled polite announcement in
`App.tsx` (`app.announce.newCards`), which sighted users never see. The column simply re-orders under them.

Fix: apply `card-arrival` to cards whose `itemId` is in the `dashboard:changed` payload (the ids are already delivered
and currently discarded in `App.tsx:238-244`), or delete the utility and the keyframes.

---

### ux-i18n-10 — `minor` — after a successful send the approval button is live again for ~1.2 s

`src/renderer/src/components/ItemCard.tsx:255-264`

On `outcome === 'done'` the controller sets the green confirmation row, calls `applyItem(out.item)` and schedules the
list refresh 1.2 s later (`CONFIRM_MS`). But `applyItem` only replaces the **open** item (`dashboard.ts:applyItem`
early-returns unless `openItemId === item.itemId`), and `busyKind` / `busyRef` are both cleared before that. So on a
**compact** card the props still carry the now-executed `send_reply` action as `state:'pending'`, and the
"Approve & send" button is re-enabled next to the green "Sent." row for the whole confirmation window.

Failure scenario: the user clicks "Approve & send", sees the button re-enable when the green row appears, and clicks
again (a common reflex when a control flickers back to enabled). A second `action:approve` goes out for the same
`actionId`; main rejects it as stale, and the card replaces the green "Sent." row with a red
"This card changed — review again." on a message that was in fact sent successfully.

Fix: keep the approval buttons disabled while `controller.result?.tone === 'ok'`, or have `applyItem` also patch the
matching card inside `lists`.

---

### ux-i18n-11 — `minor` — `renderBdiTemplate`'s "sentinel" is a bare decimal digit, and its own comment says otherwise

`src/renderer/src/components/ItemCard.tsx:52-54`

```ts
/** Private-use delimiters: an interpolated value can never collide with them, and they are invisible if one leaks. */
export const SENTINEL = (index: number): string => `${index}`;
const SENTINEL_RE = /(<bdi(?: dir="(?:ltr|rtl)")?>)?(\d)(<\/bdi>)?/g;
```

The comment describes private-use code points; the implementation emits the plain characters `0`, `1`, …, and the
regex matches **any** decimal digit in the template, wrapped in `<bdi>` or not. Every digit in the raw string is
replaced by `values[digit] ?? null` — i.e. a digit that is not an index is silently deleted and replaced with an empty
`<bdi></bdi>`.

Today only `card.sendsTo` goes through this function and it happens to contain no other digit, so nothing is visibly
broken. But the function is exported and the locale files are translator-facing: any translator (or any future caller)
who writes a digit into a template routed through `renderBdiTemplate` — "Sends to X, 2nd number …", a Hebrew ordinal,
a year — has that digit silently vanish from the UI. The guard rails that would catch it do not exist: `locales.test.ts`
only checks markup and placeholders, not digits.

Fix: make `SENTINEL` emit what the comment promises (e.g. `\uE000 + index` from the Private Use Area) and anchor
`SENTINEL_RE` on that character class, so a literal digit in a template is left alone.

---

## Notes for the orchestrator

- **ux-i18n-2 requires a main-side decision**: the cleanest fix (`compose.ts:550` mapping McpStatus → ErrorCode) touches
  a file this lens does not own. The renderer-only fix (extend the `part === 'calendar'` branch in `HealthPill`) is
  self-contained but leaves `App.tsx`'s `CAL_TOOLSET_MISMATCH` branch unreachable.
- **ux-i18n-6** implies an edit to `i18n.usage.test.ts`'s allow-lists. That test is the guard that was *supposed* to
  catch these keys; whoever fixes it should shrink `SEEDED_FOR_OTHER_PACKAGES` at the same time, otherwise the prefixes
  keep masking future dead keys under `card.` / `action.` / `event.`.
- Nothing in this review required running the bridge, a model, or any network call. The scratch suite uses only the
  fake `window.api` from `tests/setup-renderer.ts`.
