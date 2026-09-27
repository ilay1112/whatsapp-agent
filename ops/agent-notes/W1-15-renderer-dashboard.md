# W1-15-renderer-dashboard - working notes

Owner of: `src/renderer/src/store/dashboard.ts`, `src/renderer/src/views/Dashboard.tsx`,
`src/renderer/src/views/dashboard.css`, `src/renderer/src/components/{ItemList,ItemCard,RawCard,DraftBox,EventEditor,Badges,QuotedBubble,UndoDismissDrawer}.tsx`
+ their colocated tests, and `src/shared/locales/pending/W1-15-renderer-dashboard.json`.

Status: **done.** 178 colocated tests green, lint clean, typecheck clean in owned files, coverage 93.9 / 86.6 / 90.0
(lines / branches / functions) against the 75 / 70 / 75 of TESTS section 13.

### Fix round (2026-09-23) - one audit item, resolved

`ops/agent-notes/wave1-audit.md` line 127 attributes exactly one open item to W1-15: the locale key `card.suggestedBy`
("Suggested by: {{provider}}", UX 7.4) was seeded in my fragment but unrenderable, and the audit left the choice open
between "CONTRACTS gains `provider`" and "drop the key at fold-in time". Only the second option is inside my ownership,
and it is also the correct one today - see decision 11 below. **The key is now deleted from
`src/shared/locales/pending/W1-15-renderer-dashboard.json` (both the `en` and the `he` block).** Nothing referenced it
(`grep -rn suggestedBy src tests docs` is empty), so no test changed. The other two rows the audit attributes to this
package (127-129 continued: the `openUndoDrawer()` cast in `App.tsx:274`, and the app-level polite announcement of
UX 13.4) are both in `src/renderer/src/App.tsx`, which is W1-14's file - they stay under REQUESTS, untouched.

Re-verified after the edit: `npx vitest run --project renderer` = 30 files / 422 tests green (the `App.test.tsx`
failure the audit recorded in 2.2 is gone - W1-14/W1-16 fixed it); the 10 W1-15 test files = 178 tests green;
`locales.test.ts` + `i18n.usage.test.ts` = 32 tests green; eslint over the 20 owned `.ts(x)` files = 0 problems;
`tsc -p tsconfig.web.json` and `tsc -p tsconfig.tests.json` = 0 errors. `npm run typecheck` is still red repo-wide on
`src/main/bridge/launcher.ts(673,3)` (W1-02: the returned object is missing `lastRefusalCode` / `errorCode` from
`BridgeLauncherHandle`) - not mine, not touched. Per-file coverage of the owned files (v8): `Dashboard.tsx`
97.2/88.2/97.7, `dashboard.ts` 85.3/73.5/94.1, `ItemCard.tsx` 84.7/81.0/79.4, `ItemList.tsx` 91.7/100/83.3,
`RawCard.tsx` 100/91.3/100, `DraftBox.tsx` 100/96.8/100, `EventEditor.tsx` 95.4/90.2/85.7,
`UndoDismissDrawer.tsx` 96.3/86.3/100, `Badges.tsx` and `QuotedBubble.tsx` 100/100/100 (the v8 text table omits rows
that are 100 % on every metric, which is why those two look "missing" in a coverage run - they are not).

## Read
build-plan 1, 1.1, 1.2, 6, 7 (W1-15) - ARCH 6.1, 6.6, 7 - CONTRACTS 1, 5, 8 - UX 6, 7, 11, 13, 14, 16 - TESTS 3.7, 5.3, 9, 13 -
wave0-seams.md index (no renderer seam is listed there; the renderer seams are the W0/W1-14 files `api.ts`, `i18n.ts`,
`styles.css`, `store/health.ts` and `tests/setup-renderer.ts`, all of which are already implemented).

## Decisions / assumptions

1. **Frozen props.** UX 14.2 fixes the props of all eight components and the W0 stubs already carry them, so nothing that
   needs extra per-card wiring may travel as a prop. Three consequences:
   - roving `tabindex` over card roots is done **imperatively from `Dashboard.tsx`** (it sets `tabindex` on
     `[data-card-root]` nodes) instead of a prop on `ItemCard`;
   - the approval controller (draft text, event edit, focus guard, IPC calls, result rows) lives inside `ItemCard.tsx`
     and is exported from there as `useCardController` so `RawCard.tsx` can reuse it. UX 14.2 forbids new component
     files, so no `ItemCard.controller.ts` was created;
   - `useDialogChrome` (Escape, Tab trap, initial focus, focus restore) lives in `UndoDismissDrawer.tsx` and is imported
     by `Dashboard.tsx` for the sheet. Dashboard already imports the drawer, so this adds no cycle.
2. **The sheet's close button is rendered by `Dashboard.tsx`**, not by `ItemCard mode="expanded"`. `item:get` is a round
   trip, so the dialog exists before the card does; keeping `[x]` in the dialog chrome is the only way to honour `[R2]`
   "initial focus is ALWAYS the close button, however the sheet was opened" without a second focus pass when the detail
   arrives. `ItemCard.onClose` is still used - the card calls it after a successful Dismiss.
3. **`SetupStrip` is not rendered by `Dashboard.tsx`.** `App.tsx` (W1-14) already renders it above the view for every
   non-onboarding view, which is the same slot; rendering it again would duplicate the strip. A test asserts this.
4. **Untrusted interpolation never goes through `<Trans>`.** `Trans` interpolates first and parses the result as HTML,
   so a contact name containing `<img src=x onerror=...>` would be parsed into nodes. `card.sendsTo` (the only locale
   value with `<bdi>` markup that W1-15 renders) is instead rendered by `renderBdiTemplate()` in `ItemCard.tsx`: the
   template is interpolated with **private-use sentinels** (U+E000/U+E001 around the index), split on
   `<bdi …>SENTINEL</bdi>`, and the untrusted values are handed to React as children. `SENTINEL` is exported so the test
   builds the same template the component does. Verified by the XSS fixture test and by a render of the `sends-to` line.
5. **No optimistic UI for send/create**; Dismiss removes the card optimistically (UX 6.8 allows it explicitly).
6. **Focus guard** is read at click time through `isActivationBlocked()` (W1-14's `store/health.ts`), never at render
   time, and every approval control also swallows Enter/Space in `onKeyDown` while blocked.
7. **One-column mode** uses `window.matchMedia('(min-width: 56.25rem)')` through `useSyncExternalStore`. jsdom does not
   implement `matchMedia`, so the hook falls back to "wide" when it is absent; the narrow tests stub it.
8. `analysing` is read from `AppHealth.queue` (UX 6.3) with `DashboardData.analysing` as the fallback when health has
   not been hydrated yet.
9. **`ItemList`'s `<h2>` carries an explicit `aria-label`.** The title and the count are two separately styled spans, and
   the accessible-name algorithm concatenates them without a separator ("Needs reply3"). The label fixes the spoken name
   for both the heading and the `aria-labelledby` section.
10. **Provider display names reuse `health.provider.*`** (W1-14, already seeded and already listed in the parity test's
    `SAME_ON_PURPOSE`). My first attempt added `card.provider.*`, which broke `locales.test.ts` because "Claude" and
    "Gemini" are identical in both languages. Do not re-add them.
11. **`card.suggestedBy` is dropped rather than faked (fix round).** UX 7.4 asks the sheet footer for "Suggested by:
    Local model / Claude / Gemini", "provider name only; the model id is in the tooltip". CONTRACTS' `ItemCard` /
    `ItemDetail` (src/shared/types.ts:319-340) carry neither field; `provider` + `model` exist one level down on
    `Proposal` (types.ts:211-212), which never crosses IPC, and build-plan rule 7 freezes `src/shared/**` for all of
    Wave 1. The only renderer-side substitute would be `AppHealth.llm.provider` (health.ts:34), and that is the
    provider configured **now**, not the one that produced this proposal: there is a `provider_changed` audit kind, and
    `Proposal.provider` can even be `'user'` for an item completed through `item:completeEvent` with no LLM turn. A
    footer that confidently mis-attributes a draft to Gemini because the user switched providers yesterday is worse
    than no footer, and the tooltip half of the line is unbuildable either way. So the key is deleted from my fragment
    instead of rendered from the wrong source. If the line is wanted in v1, the fix is a CONTRACTS change, not a
    renderer change - see REQUESTS.

## Things the react-hooks lint rules forced (worth knowing before editing these files)

The flat config enables `eslint-plugin-react-hooks` `recommended-latest`, i.e. the compiler rules. Four patterns are
errors, and all four appear naturally in this package:

- `refs`: reading `someHookResult.someRef` during render is an error. Custom hooks that return refs must be
  **destructured at the call site** (`const { containerRef } = useDialogChrome(...)`), and a component that reads a ref
  off `props` must destructure `props` in its signature - one such read taints every other `props.*` access in the file
  (this is why `ResultRowView` takes `{ row, controller, itemId }`). An object-of-refs (`refs.date`) is banned outright;
  `EventEditor` holds five separate `const`s instead.
- `purity`: `Date.now()` in a render body is an error. Snapshot it with `useState(() => Date.now())`. `useCardStrings`
  now returns that snapshot as `now` so `ItemCard` can reuse it - which is also more correct: a card's "14:02" must not
  silently become "Yesterday" because an unrelated state change re-rendered it.
- `set-state-in-effect`: a synchronous `setState` in an effect body is an error, and so is calling a function the rule
  can inline down to one (`void load()` where `load` is a local `useCallback`). Fixes used: mount the drawer's panel
  only while it is open (so "reset on close" disappears), put the fetch's state writes in a `.then` callback, keep
  `DraftBox`'s "focus after reveal" flag in a ref, and only ever RAISE `stillSending` in the effect (it is lowered in
  the click handler that starts the next approval).
- a `useCallback` may not reference itself by name; `runApprove`'s "Add anyway" re-entry goes through `runApproveRef`.

## Bugs found and fixed while testing

- `useDialogChrome`'s Tab trap filtered candidates by `n.offsetParent !== null`. That is 0 for everything in jsdom and
  null for descendants of a `position: fixed` panel in some engines, which collapsed the trap to a single node and let
  Tab escape the dialog. Now it filters on `[hidden]` only; the selector already excludes disabled and `tabindex="-1"`.
- `ItemList` had no separator between title and count in its accessible name (decision 9).

## Test notes

- `src/renderer/src/views/Dashboard.test.tsx` builds its bilingual DOM snapshot with a small `skeleton()` walker
  (tag + class + `data-*`/`dir`) rather than `outerHTML`, which `eslint.config.js` bans.
- The ESLint physical-Tailwind rule matches string literals anywhere, including test NAMES: "right-to-left" in an `it()`
  title trips it. Phrase such titles as "in its own direction".
- Deferred promises in tests use `let resolve!: (v: unknown) => void` - `| null = null` makes TS narrow the variable to
  `null` and the later call is then "not callable" under `tsconfig.tests.json`.
- A `needs_confirm_conflict` approve result must include `busy: []`; without it the mock does not match `ApproveOutcome`.

## REQUESTS

- **W1-14-renderer-shell**: `App.tsx` calls `useDashboardStore.getState().setUndoDrawerOpen?.(true)` through a cast for
  the footer "Undo dismiss" button. `setUndoDrawerOpen(open: boolean)` now exists on the store, so the cast in
  `openUndoDrawer()` can be replaced with a normal selector. No behaviour change is needed - this is a tidy-up.
- **W1-14-renderer-shell / W2-01**: the polite live region lives in `App.tsx`; approval success is announced by the
  card's own `role="status"` row instead (UX 13.4 wants "Sent to <name>." in the app-level polite region). Wiring that
  needs a shell-owned announce hook; not added because `App.tsx` is not mine.
- ~~**W1-14-renderer-shell**: `card.suggestedBy` cannot be rendered.~~ **CLOSED by W1-15 in the 2026-09-23 fix round:**
  the key is deleted from `src/shared/locales/pending/W1-15-renderer-dashboard.json`, so there is nothing left for
  W1-14 or W2-01 to decide at fold-in time and no dead string reaches `en.json` / `he.json`. Reasoning in decision 11.
  **If the UX 7.4 footer line is wanted in v1 it is a CONTRACTS change, not a renderer one** - and it is a
  post-Wave-1 change, since build-plan rule 7 freezes `src/shared/**`:
  - **W2-01-compose-integration**: add `provider: ProviderId | 'user'` **and** `model: string` to `ItemCard` in
    `src/shared/types.ts` (both already exist on `Proposal`, types.ts:211-212, so `ItemService.dashboard()` /
    `detail()` in W1-10's `agent/items.ts` only have to copy them out of the current proposal). Both are enum-ish /
    server-side values, not model output, so they need no sanitisation.
  - then W1-15 re-adds `card.suggestedBy` ("Suggested by: {{provider}}" / "הוצע על ידי: {{provider}}") and renders it
    in the sheet footer next to Dismiss, with the display name from `health.provider.<id>` (decision 10) and `model`
    as the `title` tooltip. Do **not** re-add it before the field exists - rendering it from `AppHealth.llm.provider`
    would attribute every old draft to whatever provider is configured today.
- **W2-01**: when folding `pending/` into the base files, note that `card.analyseExplain.cloud` takes a `{{vendor}}`
  interpolation that W1-15 fills from `health.provider.<id>`.

## BLOCKED-BY

(none)

## Known red elsewhere (NOT mine, not weakened, not touched)

**As of the 2026-09-23 fix round:** `npx vitest run --project renderer` is fully green (30 files, 422 tests) - the
`App.test.tsx` onboarding failure recorded here earlier, and in wave1-audit 2.2, has been fixed by its owners.

One repo-wide gate is still red and it is **not** in a W1-15 file:

- `npm run typecheck` -> `src/main/bridge/launcher.ts(673,3): error TS2322` - the object returned by
  `createBridgeLauncher` is missing `lastRefusalCode` and `errorCode` from `BridgeLauncherHandle`. Owner
  **W1-02-bridge-process**; `tsc -p tsconfig.node.json` stops there, which is why `tsconfig.web.json` and
  `tsconfig.tests.json` (both clean, 0 errors) never run under `npm run typecheck`. Not touched.
