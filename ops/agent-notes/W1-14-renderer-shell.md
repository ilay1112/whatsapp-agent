# W1-14-renderer-shell - builder notes

Package: `W1-14-renderer-shell` (Wave 1). Brief: `docs/specs/build-plan.md` section 7, heading `### W1-14-renderer-shell`.
Read: ARCH 12.3, 15.1, A17, A18; CONTRACTS 2, 3, 8, 18; UX 1-5, 10, 11, 12.2, 13, 14, 15, 16; `docs/research/i18n-rtl.md`
4.2-4.6, 5, 6; TESTS 3.7, 5.3 renderer row, 9, 13. Date: 2026-09-22.

State found on disk: W0's stubs, untouched by any earlier W1-14 attempt. Everything below was built in this run.

---

## 1. What was built, in the order the brief prescribes

### FIRST deliverable - `src/shared/locales/{en,he}.json`

Grew from 340 to 434 keys per language. Added, all bilingual:

| Prefix | Covers |
|---|---|
| `app.*` | wordmark, version, close, tryAgain, main-region label, the three live-region announcements |
| `language.*` | the toggle's group label + the two endonyms (never translated) |
| `health.*` | panel title, part names, "<part> needs attention", `since`, provider names, the two row actions, and **one sentence per `BridgeStatus` / `LlmStatus` / `McpStatus`** (UX 5.2) |
| `download.*` | pill labels per state, popover fields, the three controls, `aria-valuetext`, tier names in plain words, the finished announcement |
| `setup.*` | the three setup rows (text + action) and "Hide" |
| `footer.undoDismiss` | `[R2]` replaces the cut token counter |
| `list.empty.*`, `list.stillLoading`, `list.loadFailed` | UX 11.1/11.2 seeded for W1-15 |
| `dialog.dbRecovery.title|body` | the only full-window blocking state |

**Plural normalisation (i18n-rtl.md 4.6, `Intl.PluralRules('he') = one | two | other`):** `en` now carries only `_one` /
`_other`, `he` carries `_one` / `_two` / `_other`, and the retired `_many` category was removed from both. This touched
`list.analysing`, `tray.tooltipWaiting` and `notify.needsReplyMany.title`. W1-12's `tray.ts` / `notifications.ts` call the
BASE key with `{ count }`, so i18next picks the form - nothing there had to change, and `src/main` stayed green.

`src/shared/locales/locales.test.ts` was rewritten to the TESTS section 9 contract: key sets identical except the Hebrew
dual; no `_two`/`_many` in English; no empty values; identical `{{placeholder}}` sets; **no markup except `<bdi>` /
`<bdi dir="ltr">`** (used through `Trans`); no Hebrew value byte-equal to its English one unless listed in
`SAME_ON_PURPOSE` (7 entries: brand names, endonyms, the deliberately empty `errorAction.none`), plus the CONTRACTS 18
enumerations and a new check that every bridge/llm/calendar state has a status-panel sentence.

### SECOND deliverable - `src/renderer/src/styles.css`

Every token of UX 2.1-2.4 in a Tailwind 4 `@theme` block, the dark column under `prefers-color-scheme`, `:root:lang(he)`
+1 px per step, `--dir` for the transforms that do not flip on their own, `forced-colors` and `prefers-reduced-motion`
blocks, `.msg-text` (`unicode-bidi: plaintext`), `.icon-dir:dir(rtl)`, the card-arrival edge, and all ten `@utility`
recipes whose names UX 2.6 makes normative (`btn`, `btn-primary`, `btn-outline`, `btn-quiet`, `btn-danger`, `icon-btn`,
`field`, `chip`, `pill`, `focus-ring`) plus `tnum` and `card-arrival`.

`styles.test.ts` asserts: zero physical inset/margin/padding/border declarations, no `text-align: left|right`, no CSS
`direction`, no `@font-face`, no italics/uppercase/letter-spacing, every token name, every recipe. Verified on the built
sheet too: `grep` over `out/renderer/assets/*.css` finds **zero** `margin-left|padding-right|left:|right:` (UX 16 item 1).

### Then - shell, i18n, api, stores, components

- `i18n.ts` - one `createInstance()`, merged resources, `languageChanged` -> `<html lang dir>` via `i18next.dir()`, the
  `bdi` / `ltr` plain-string formatters (FSI/PDI, LRI/PDI).
- `main.tsx` - unchanged in shape: i18n is initialised from the language main resolved before the window existed, and only
  then React mounts, so the first paint is already in the right direction.
- `api.ts` - unchanged (W0 shipped the full wrapper set); now covered by `api.test.ts`, which also pins that the four
  destructive channels always carry `confirm: true` and that `model:*` sends a tier enum, never a URL.
- `App.tsx` - bootstrap in one round trip, routing `onboarding | dashboard | settings`, header (wordmark, `HealthPill`,
  `DownloadPill`, pause toggle, `LanguageToggle`, gear), setup strip, footer (`[R2]` Undo dismiss + version only), the two
  live regions, the toast, the `tray_hint` coach mark and the `DB_RECOVERY` alertdialog.
- `store/health.ts` - health, download progress, setup-row dismissals **and the `[R2]` focus guard**.
- `store/settings.ts` - optimistic set through the same pure `applySettingsPatch` main uses, rollback + `saveError`,
  `savedAt` so the shell can announce "Saved.".
- `components/{HealthPill,DownloadPill,SetupStrip,LanguageToggle}.tsx` - exact UX 14.2 props, inline SVG icons only.

---

## 2. Decisions, assumptions and deviations (each one deliberate)

1. **The focus guard lives in `store/health.ts`, not in `App.tsx`.** The brief puts "a global `focusGuard` hook" in
   `App.tsx`, but `App.tsx` imports `Dashboard`, so W1-15 importing the hook back from `App.tsx` would create a real
   module cycle. Exports: `useFocusGuardStore`, `installFocusGuard()` (App calls it once) and **`isActivationBlocked(now?)`,
   which approval buttons MUST call at CLICK time** - a render-time snapshot would let a stale render unblock an approval.
   See REQUESTS -> W1-15.
2. **`t()` and `i18n` are held in refs inside `App.tsx`.** react-i18next hands out a fresh `i18n` binding together with the
   new `t` on every language change; with `i18n` in the subscription effect's dependency array the whole shell
   re-bootstrapped (a second `app:getBootstrap`, every push re-subscribed, and `<html dir>` was reset to the bootstrap
   language moments after the user switched). Caught by `App.test.tsx` "the language toggle asks main to persist the
   choice"; the refs are the fix, and the test is the regression guard.
3. **`styles.test.ts` and `i18n.usage.test.ts` read the tree through helpers in `tests/setup-renderer.ts`.** vitest stubs
   every `.css` import to `''` - including `?raw` and `import.meta.glob(..., {query:'?raw'})`, both verified - and
   `src/renderer/**` may not import node built-ins (eslint). `tests/**` may, so `readRepoFile()` / `listRepoFiles()` were
   added there (both owned by this package). Paths are built from `process.cwd()`, never from `URL.pathname` (the project
   path contains a space); `import.meta.url` is not a `file:` URL under the jsdom environment.
4. **Onboarding is routed from `App.tsx`.** No `views/Onboarding/index.tsx` exists, so the shell maps `OnboardingStep` ->
   the five step components and persists every move with `onboarding:setStep`. See REQUESTS -> W1-16.
5. **The coach mark is push-driven only.** It appears on `ui:navigate {view:'tray_hint'}` and `app:ackTrayHint` dismisses
   it. `Bootstrap.trayHintSeen` is deliberately NOT used to show it: the flag is set by main on the first *hide*, so at
   start-up it cannot distinguish "hint pending" from "hint already acknowledged". Main owns the trigger (ARCH 13).
6. **The `DB_RECOVERY` dialog can only retry.** No IPC channel restores a backup or starts fresh - `IPC_REQUEST_SCHEMAS`
   has nothing for it and ARCH 10/14 put recovery inside main's start-up path. Both buttons therefore reload the window
   (which re-runs main's own recovery). See REQUESTS -> W2-01.
7. **The coach mark's tray glyph is drawn inline in `App.tsx`.** `resources/icons/tray.svg` belongs to W1-12 and importing
   an asset from outside `src/renderer` would add a build edge; the inline diary-leaf glyph is the same signature shape.
8. **The header does not collapse into a gear menu below 640 px.** UX 3 suggests moving the pause and language controls
   into the gear menu at 420-639 px; instead the wordmark hides (`max-roomy:sr-only`) and everything stays reachable, which
   satisfies the actual acceptance criterion (UX 16 item 9: nothing overflows at 420 x 560) without inventing a menu.
9. **`npm run format:check` was left as W0 left it - red, nothing reformatted.** W0 recorded the collision between
   prettier and the specs' verbatim house style (93 files) and left the decision open. Running prettier on this package's
   files only would make the tree inconsistent with itself, so it was not run. The definition of done (build-plan 1.1)
   asks for eslint, typecheck and vitest, all green.
10. The AI row of the status panel reads the download percentage from `store/health.ts` rather than from props, because
    UX 14.2 freezes `HealthPill`'s props to `{health, onAction}` while UX 5.2 asks for "downloading, 43 %".

---

## 3. Verification (all commands run from the project root)

| Command | Result |
|---|---|
| `npx vitest run --project renderer` | **12 files, 107 tests, all green** |
| `npx vitest run --project main src/shared/locales` | **26 tests green** |
| `npx vitest run --project main` (whole project, for information) | 1497 green, 4 red - all four in `src/main/bridge/launcher.test.ts` (W1-02), none touching this package |
| `npx tsc --noEmit -p tsconfig.web.json` | **exit 0** |
| `npx tsc --noEmit -p tsconfig.tests.json`, filtered to owned paths | **no error in any owned file** (errors remain in `src/main/**` - W1-02/04/07/12 files, listed in section 4) |
| `npx eslint src/renderer src/shared/locales src/shared/i18n tests/setup-renderer.ts --max-warnings 0` | **exit 0** |
| `npx electron-vite build` | **exit 0**, renderer CSS 20.75 kB; zero physical-direction declarations in the output |
| renderer coverage (`--coverage.include='src/renderer/**'`) | **lines 90.85 %, branches 84.86 %, functions 84.01 %** vs the 75/70/75 gate of TESTS 13 - and that number still carries the untested W1-15/W1-16 stubs |

`npm run typecheck` as a whole is red because `tsconfig.node.json` runs first and other packages' files do not compile yet
(`src/main/app/i18n.ts`, `src/main/app/protocol.ts`, `src/main/llm/consent.ts`, `src/main/proc/supervisor.ts`,
`src/main/testSeams.ts`, plus several `src/main/**/*.test.ts`). Nothing in those files is owned here and nothing was
touched there.

BLOCKED-BY: none. No test in this package fails because of another package's Wave 0 stub.

---

## 4. REQUESTS

**W1-15-renderer-dashboard**
- The footer's "Undo dismiss" button (UX 5.5) has to open the drawer that lives in `Dashboard.tsx`. Please add
  `undoDrawerOpen: boolean` + `setUndoDrawerOpen(open: boolean): void` to `store/dashboard.ts` and bind
  `UndoDismissDrawer` to them. `App.tsx` already calls `setUndoDrawerOpen?.(true)` through an optional-property cast, so
  the button starts working the moment the slice exists and nothing breaks until then.
- Import the focus guard from `@/store/health`, not from `App.tsx`: `isActivationBlocked()` must be called **inside the
  click/keydown handler**, not read during render.
- The toast slice `{key, itemId?}` is rendered by `App.tsx`: `key` is a locale key and an `itemId` makes an "Undo" button
  appear that calls `item:restore`. If a toast needs a different undo action, tell me and I will widen the slice's shape
  rather than have two toast renderers.
- Already seeded for you in `en/he.json` (no fragment needed): `list.empty.*`, `list.stillLoading`, `list.loadFailed`,
  `list.latestOf`, `card.*`, `action.*`, `footer.ignored`, `app.close`, `app.dashboard`, `label.badge.*`,
  `label.holdReason.*`, `label.missingField.*`, `label.closedReason.*`.

**W1-16-renderer-setup**
- `App.tsx` routes the five onboarding steps itself (there is no `views/Onboarding/index.tsx`). If you add a container
  component, say so and I will route to it instead of to the steps.
- Seeded for you: `welcome.*`, `ai.*`, `pair.*`, `google.intro.later`, `consent.*` (all three kinds at their current
  `CONSENT_VERSIONS` version), `app.back`, `label.credentialsProblem.*`, `label.pairingStatus.*`.
- The consent copy key is `consent.<kind>.v<version>.{title,body,accept}` and `locales.test.ts` fails if a stale version's
  copy is left behind, so bump copy and `CONSENT_VERSIONS` together.

**W1-12-shell-main**
- Plural suffixes changed: `en` has `_one`/`_other` only, `he` has `_one`/`_two`/`_other`, and `_many` is gone
  (`tray.tooltipWaiting`, `notify.needsReplyMany.title`). Keep calling the base key with `{ count }` - your current code
  already does, and `src/main/app/{tray,notifications,i18n}` stayed green.
- The coach mark is shown only when main pushes `ui:navigate {view:'tray_hint'}`; `app:ackTrayHint` is called on both the
  button and Escape.

**W2-01-compose-integration**
- There is no IPC for the `DB_RECOVERY` dialog's two buttons ("Restore" / "Start fresh"); both currently reload the
  window. Either document DB recovery as fully automatic in main (then the dialog becomes informational) or add
  `data:restoreBackup` / `data:startFresh` to `shared/ipc.ts` and I will wire them.
- When you fold `src/shared/locales/pending/*` into the base files, re-run `src/shared/locales/locales.test.ts` and
  `src/renderer/src/i18n.usage.test.ts`: the second one keeps two allow-lists (`SEEDED_FOR_OTHER_PACKAGES`,
  `SEEDED_KEYS`) whose entries should shrink as the other packages start referencing their keys.
- `format:check` is still red repo-wide (W0's recorded deviation); this package added no exception to it.

---

## 5. FIX ROUND (2026-09-23) - repairs against `ops/agent-notes/wave1-audit.md`

Nothing was rewritten; five items attributed to this package were repaired in place.

### 5.1 RED TEST - `App.test.tsx` "starts in onboarding ... and walks the steps" (audit 2.2) - **FIXED**

The test still drove the Wave 0 `Welcome` stub (a click on the `onboarding-welcome` container). W1-16 shipped the real
consent gate, so nothing advanced. Replaced with W1-16's own snippet plus one extra assertion that the gate is real:

```tsx
expect(screen.getByTestId('welcome-start')).toBeDisabled();
await userEvent.click(screen.getByTestId('welcome-accept'));
await userEvent.click(screen.getByTestId('welcome-start'));
```

The `disabled` assertion is deliberate: it pins the approval-first property of step 0 (no consent record, no bridge) in
the SHELL's test as well, so a future change to `Welcome` that drops the gate fails two tests, not one. No source file
changed for this - `Welcome.tsx` was already correct.

### 5.2 Stateful `llm:*` / `secrets:*` fakes in `tests/setup-renderer.ts` (W1-16 request) - **DONE**

`buildMocks()` now resets one module-level `llmState: LlmConfig` per test and serves five channels from it:
`llm:getConfig` and `secrets:has` read it; `llm:setProvider`, `secrets:set` and `secrets:clear` mutate it (`secrets:set`
derives `last4` from the value it was given). Two helpers were added for tests that need to start from a non-pristine
config: `setLlmState(patch)` and `getLlmState()`. Every other channel keeps the generic `structuredClone(IPC_DEFAULTS[c])`
behaviour, and `mockInvoke()` still overrides any of them. All 427 renderer tests pass unchanged, including W1-16's,
which no longer have to teach two channels together.

### 5.3 `App.tsx` optional-property cast for `setUndoDrawerOpen` (W1-15 request) - **DONE**

`store/dashboard.ts:146` exports the real action, so the cast is gone:
`useDashboardStore.getState().setUndoDrawerOpen(true)`. A silent no-op is no longer possible.

### 5.4 UX 13.4 row 1 - approval success in the APP-LEVEL polite region (W1-15 request) - **DONE**

Design note, because the obvious implementation does not work: the shell cannot derive "an approval just succeeded" from
the dashboard store. `applyItem()` only writes when the approved card is the OPEN one, so a compact card's success never
reaches the store, and the `refresh()` that follows 3 s later cannot be told apart from an ordinary list refresh (an item
that is already `sent` when it first appears would announce a stale success).

So the observer sits where every approval already passes exactly once - `api.ts`, the one file allowed to touch
`window.api`, which this package owns:

- `onApprovalSuccess(listener)` (new, in `api.ts`) fires only for `r.ok && outcome === 'done'`, carrying `{kind, item}`.
  It is an **observer only**: it cannot start, retry or suppress an approval, so the approval-first rule is untouched -
  the user's click is still the only thing that reaches `action:approve`.
- `App.tsx` subscribes once and announces `app.announce.sent` / `app.announce.added`, **never throttled** (UX 13.4 marks
  only "new cards" and "health overall" as coalesced/throttled; a second identical success must still be heard, so the
  polite region appends a ZWJ when the sentence repeats - the node's text changes, what a reader says does not).
- New keys `app.announce.sent` = "Sent to {{name, bdi}}." and `app.announce.added` = "Added to calendar: {{when}}."
  (both languages). `{{name, bdi}}` uses the plain-string bidi formatter of `i18n.ts`, not `<bdi>` markup, because the
  live region is plain text, not `Trans`. UX 15.1 item 5 explicitly allows the chat name here and nothing else untrusted:
  `announceWhenOf()` reads only `calendar.eventStartTs` (falling back to the proposal's `startLocal` + `timeZone`) and
  formats it with `Intl.DateTimeFormat`, wrapped in try/catch so an unknown IANA zone cannot take the shell down.
- The card keeps its own inline confirmation row; this is the screen-reader half of the same event, not a replacement.

Covered by three new tests in `App.test.tsx` (send_reply, create_event + the failure case that must stay silent, and the
two pure helpers).

### 5.5 `i18n.usage.test.ts` allow-lists (W1-16 + W2-01 requests) - **DONE**

Added a test that fails while an allow-list entry is redundant, then shrank both lists to what it still reports:
`SEEDED_FOR_OTHER_PACKAGES` went from 13 prefixes to 6 (`tray. calendar. card. action. event. google.`) and
`SEEDED_KEYS` from 5 keys to 2 (`app.name`, `footer.ignored`). The new test is the mechanism W2-01 asked for: after the
`pending/` fold-in it will name every entry that has to go, instead of the lists silently rotting.

### 5.6 `DB_RECOVERY` buttons (W2-01 request) - **DOCUMENTED, still a W2-01 decision**

Verified in main: `openDbWithRecovery()` (`src/main/db/backup.ts`) already restores the newest backup, or moves the
unreadable file aside and starts empty, *before* the window exists - recovery is fully automatic and finished by the
time `DB_RECOVERY` can reach the renderer. `App.tsx` now says so in a comment at the dialog. The two buttons stay,
because UX 10 makes "Restore (secondary: Start fresh)" normative, and both re-run that automatic path by reloading.
Giving them distinct behaviour needs `data:restoreBackup` / `data:startFresh` in `src/shared/ipc.ts`, which is a
CONTRACTS change only W2-01 may make. Not fixable inside this package's paths - see REQUESTS.

### 5.7 Locale fold-in (W2-01 request) - **NOT MINE TO DO**

`src/shared/locales/pending/*.json` are the other packages' own files and `pending/` is deleted by W2-01 per the
hot-spot table of build-plan 1.2. This package prepared everything around it (5.5) but folded nothing.

### 5.8 Verification after the fix round

| Command | Result |
|---|---|
| `npx vitest run --project renderer` | **30 files, 427 tests, all green** (was 421/422) |
| `npx vitest run` (both projects, whole repo) | **138 files, 3089 passed, 1 skipped, 0 failed** |
| `npx vitest run --project main src/shared/locales` | **26 green** |
| `npx eslint src/renderer src/shared/locales src/shared/i18n tests/setup-renderer.ts --max-warnings 0` | **exit 0** |
| `npx tsc --noEmit -p tsconfig.web.json` | **exit 0** |
| `npx tsc --noEmit -p tsconfig.tests.json`, filtered to owned paths | **no error in any owned file** |
| `npx electron-vite build` | **exit 0** |
| renderer coverage (`--coverage.include='src/renderer/**'`) | lines **94.65 %**, branches **85.99 %**, funcs **89.19 %** vs the 75/70/75 gate |

BLOCKED-BY: none.

### 5.9 REQUESTS still open after this round

**W2-01-compose-integration**
- Decide `DB_RECOVERY` (5.6): either mark the dialog informational in UX/ARCH, or add `data:restoreBackup` /
  `data:startFresh` to `src/shared/ipc.ts` - the dialog is one `onClick` away from using them.
- Fold `src/shared/locales/pending/*` into `en.json`/`he.json`, delete `pending/`, then re-run
  `src/shared/locales/locales.test.ts` and `src/renderer/src/i18n.usage.test.ts`. The new redundancy test of 5.5 will
  name every allow-list entry that must be dropped; do not widen the lists to make it pass.
- `card.suggestedBy` (W1-15's fragment) still has no `provider` field in `ItemCard`/`ItemDetail`. Either CONTRACTS gains
  it or the key is dropped during the fold-in. Not this package's call.
- `format:check` / `prettier --check` is still red repo-wide (W0's recorded deviation); this round reformatted nothing.
