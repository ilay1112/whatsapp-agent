# fix-src-renderer-src — repair of the confirmed renderer findings

Phase 3 repair pass over `src/renderer/src`. **This session resumed an interrupted earlier run**: a previous attempt had
already landed fixes for four of the eight findings but stopped before the suite was green. I inherited a tree with
**8 red renderer tests and 3 typecheck errors**, so the first job was establishing an honest baseline, not writing code.

## Final state

| Gate | Result |
|---|---|
| `npm run lint` | clean |
| `npm run typecheck` (node + web + tests) | clean |
| `npx vitest run` (all 167 files) | **3828 passed, 1 skipped, 0 failed** |
| `npm run format:check` | 2 pre-existing failures in `src/main`, not mine — see "Reported, not fixed" |

## Finding-by-finding

### approval-first-2 [major] and ux-i18n-1 [major] — already fixed, verified green
These two are the same defect reported twice ("Add anyway" bypassing the [R2] focus-steal guard). The fix was already in
the tree when I arrived, and it is the right one — better than either proposed fix:

- `ResultAction` gained an opt-in `approving?: true` flag (`ItemCard.tsx:39-49`), and `ResultRowView` applies
  `activationRefused(e)` + `refuseBlockedKey` only to actions carrying it (`ItemCard.tsx:611-627`). This is exactly the
  caveat the ux-i18n-1 verifier raised: a blanket guard would have made the benign "Refresh card" / "Change time"
  actions dead for 500 ms too.
- The mouse half *and* the keyboard half are both covered (`onKeyDown`), which the ux-i18n-1 verifier correctly flagged
  as a second independent hole.
- The `e.detail > 1` double-activation check comes along for free, since `activationRefused` is the shared predicate.
- The reviewer's suggestion to call `controller.approveHandlers(...)` from `ResultAction.run` could not have worked as
  written — `onClick` takes a `React.MouseEvent` while `run()` takes no argument. The flag approach sidesteps that.

I verified rather than re-fixed. The `[R2]` describe block in `ItemCard.test.tsx` now covers `result-add-anyway` for
both mouse and Enter, mirroring the existing `approve-send-1` cases. **These tests were red when I started** — not
because the fix was wrong, but because of the fixture time-bomb below. They pass now.

### ux-i18n-6 [major] — already fixed, verified green
Also already landed, and it followed the verifier's caveat rather than the reviewer's original (destructive) proposal:
the scanner in `i18n.usage.test.ts` was widened first (`QUOTED_KEY_RE` now sees `t(cond ? 'a' : 'b')`, `{key:'...'}`
and mid-segment templates), and only then were the allow-lists emptied — `SEEDED_FOR_OTHER_PACKAGES` is now `[]`. The
three missing affordances are wired (`result-create-anyway` with `confirmDuplicate`, `result-change-time`,
`result-send-again`), so the previously stranded main-side duplicate-override path is reachable from the UI, and the
identical `kind === 'send_reply' ? [refresh] : [refresh]` ternary is gone.

### ux-i18n-10 [minor] — already fixed, verified green
`ApproveButton` now also disables on `controller.result?.tone === 'ok'` (`ItemCard.tsx:650-658`), which is the smaller
and safer of the two proposed fixes, as the verifier recommended.

### ux-i18n-3 [major] — FIXED
The approval sheet printed the raw Google id (`Calendar: primary`) on the screen where the user authorises a calendar
write, unisolated inside an RTL sentence.

- `src/renderer/src/store/settings.ts` — new `calendars` / `calendarsLoaded` slice with a fetch-once `loadCalendars()`,
  plus the pure `calendarNameOf(id, calendars, primaryFallback)`.
- `src/renderer/src/components/ItemCard.tsx` — resolves `targetCalendarId` through that helper; falls back to the new
  `calendar.primaryName` ("Main calendar" / "היומן הראשי") for `primary`, and to the id itself otherwise. A card with an
  event triggers the one-per-window fetch.
- `src/renderer/src/views/Settings.tsx` — now reads the same store slice instead of its own local `useState`, so the two
  screens can never disagree about what "primary" is called. (Settings still re-fetches on mount: the user may have just
  connected Google.)
- `src/renderer/src/components/EventEditor.tsx` — renders `{t('event.calendarLabel')} <bdi>{name}</bdi>`.

**Deviation from the proposed fix, deliberate.** The proposal was `<bdi dir="ltr">`. I used a plain `<bdi>` (auto
direction): a resolved calendar name can legitimately be Hebrew, and forcing LTR would then be wrong. `<bdi>` isolates
in both directions, which is what UX 2.5 item 3 actually asks for.

**Second deviation.** I split `event.calendarName = "Calendar: {{name}}"` into `event.calendarLabel = "Calendar:"` plus
a sibling `<bdi>` element, rather than adding `<bdi>` markup to the locale value and rendering it with
`renderBdiTemplate`. Reason: `renderBdiTemplate` lives in `ItemCard.tsx`, and `ItemCard` already imports `EventEditor` —
having `EventEditor` import it back would create a module cycle. Moving the helper to a shared module was the
alternative, but it carries private-use sentinel characters (U+E000/U+E001) that are invisible in most editors and
fragile to move, and UX 14.2 is pointed about the renderer's file list. A label plus an isolated value is the standard
way to render a label/value pair and needs no template engine.

Note the default `google:listCalendars` fixture returns `{id:'primary', name:'Personal'}`, so the sheet now renders
literally "Calendar: Personal" — the UX 6.7 mock. `EventEditor.test.tsx`'s `calendarName: 'Personal'` fixture, which the
verifier correctly called a value "the production wiring can never produce", is now honest.

### ux-i18n-4 [major] — FIXED
`src/renderer/src/App.tsx`: the bootstrap fetch is extracted into a stable `loadBootstrap` callback; the failure branch
renders `errors.<code>.title` + `errors.<code>.body` + an `app.tryAgain` button (`data-testid="boot-retry"`) inside a
`role="alert"`. I also added the missing `.catch` the verifier flagged as adjacent — a *rejected* invoke used to leave
the window on "Loading..." for ever with no text at all, which is the same dead end minus the sentence, and closing it
costs two lines in the branch I was already editing.

Implementation note: the retry lives in a separate `retryBootstrap` callback that clears `bootError` before calling
`loadBootstrap`. `loadBootstrap` itself performs no synchronous `setState`, because the mounting effect calls it
directly and `react-hooks/set-state-in-effect` (correctly) rejects a sync setState in an effect body.

### ux-i18n-5 [major] — FIXED
- `src/renderer/src/components/QrPairing.tsx` — the `error` branch now renders a `pairing.newCode` button
  (`data-testid="qr-new-code"`) alongside the title and body, so the panel satisfies UX 11.4's "title / body / the
  single action". As the finding's own note confirms, `pairing:newCode` → `restartForNewCode()` → `resetBreaker()`
  clears the terminal flag a logged-out session sets, so this is real recovery rather than a cosmetic button.
- `src/renderer/src/views/Onboarding/LinkWhatsApp.tsx` — the footer now keys off its own `waiting` boolean
  (`!connected && panel.status !== 'error'`) instead of sharing `connected` with the primary slot, so the step no longer
  claims "Waiting for your phone..." underneath an alert saying the link is gone.

I used `pairing:newCode` rather than adding a `pairing:relink` channel: a new IPC channel is a CONTRACTS change, which
is not mine to make, and `newCode` already recovers this state.

### ux-i18n-9 [minor] — FIXED
The verifier's owner correction is right: `styles.css` is correct and complete; the defect was the missing consumption.
I did **not** take the "or delete it" option, because ux.md:131 is normative.

- `src/renderer/src/store/dashboard.ts` — `arrivedItemIds` + `noteArrived(ids)`, cleared by a single restartable timer
  after `ARRIVAL_MS` (1700 ms). The ids are dropped rather than left on the card on purpose: `card-arrival` animates
  `forwards`, so a permanent class would leave a transparent 3 px border and push that one card out of line.
- `src/renderer/src/App.tsx` — the `dashboard:changed` payload's `itemIds` are recorded when
  `document.visibilityState === 'visible'`. Deliberately weaker than the `document.hasFocus()` the announcement uses:
  UX 2.4 says *visible*, and a visible-but-unfocused window should show the edge without speaking.
- `ItemCard.tsx` and `RawCard.tsx` — the root `<article>` carries `card-arrival` while its id is listed. The expanded
  sheet never does; the edge is a column cue, and the sheet is what the user just opened on purpose. I included
  `RawCard` (beyond the literal finding) because a raw card arrives in the same columns.

**Verified the fix is actually load-bearing**, since the verifier noted an unused Tailwind v4 `@utility` is never
emitted: after `electron-vite build`, `out/renderer/assets/index-*.css` now contains both the `card-arrival` utility and
the `prefers-reduced-motion` override, plus the `wca-arrival` keyframes. Before this change that CSS did not ship at all.

## Two defects I found and fixed that were not on the list

Both were blocking: without them I could not have proved any of the work above.

### A time-bomb fixture — 8 red tests (`tests/setup-renderer.ts`)
`defaultCard.event` hard-coded `startLocal: '2026-09-24T17:00:00'`. `ItemCard` validates the proposal against the **real**
clock (`Date.now()`, the S2 "already passed" rule), never against the fixture's `NOW`, so on 2026-09-25 that date slipped
into the past, `eventComplete` went false, and `approve-event-1` rendered `disabled`. Every test that approves a
`create_event` went red — including all six of the new `result-add-anyway` / `result-create-anyway` cases the previous
session had just written. Nothing was wrong with the product code.

Fixed by deriving the day: the Thursday 14–20 days ahead of the real clock. Still a Thursday, so
`App.test.tsx`'s `announceWhenOf(...)` assertions still hold; always clear of both the "already passed" and the "more
than a year away" bounds. This mirrors the reasoning `EventEditor.test.tsx` already applies to its own `DAY` constant —
that file got it right, the shared fixture did not. Nothing was deleted, skipped or weakened.

### `retryClone` widened `lastError` to `string` — 3 typecheck errors (`ItemCard.test.tsx`)
The previous session's new CAL_DUPLICATE / unknown-outcome helper declared `lastError: string`, which is not assignable
to `ActionView['lastError']: ErrorCode | null`. Invisible to `tsconfig.web.json` (it does not include tests) and to
`vitest`, so it only showed up under `npm run typecheck`'s third project. Typed the parameter as `ErrorCode`.

## Reported, not fixed

`npm run format:check` fails on two files I never touched and which are outside this task's surface:

- `src/main/bridge/bridgeDb.ts`
- `src/main/llm/local/llamaServer.test.ts`

They were already unformatted when I arrived. Flagging rather than silently reformatting another agent's files; whoever
owns `src/main` should run prettier over them, or the orchestrator can fold it into a formatting pass.

Also worth a ticket (out of scope here, raised by the ux-i18n-5 verifier and independently true): a real
`BRIDGE_SPAWN_REFUSED` makes the pairing poller emit `{status:'unavailable'}`, which `toPanelState` maps to
`preparing` — so that failure shows "Preparing a code..." for ever instead of the error panel. My fix improves the
`error`/`logged_out` path; it does not touch that separate mapping defect.

## Files changed

Product:
- `src/renderer/src/App.tsx`
- `src/renderer/src/components/ItemCard.tsx`
- `src/renderer/src/components/EventEditor.tsx`
- `src/renderer/src/components/QrPairing.tsx`
- `src/renderer/src/components/RawCard.tsx`
- `src/renderer/src/store/dashboard.ts`
- `src/renderer/src/store/settings.ts`
- `src/renderer/src/views/Settings.tsx`
- `src/renderer/src/views/Onboarding/LinkWhatsApp.tsx`
- `src/shared/locales/en.json`, `src/shared/locales/he.json`

Tests (every fix got a failing test first; 17 new cases):
- `src/renderer/src/App.test.tsx`
- `src/renderer/src/components/ItemCard.test.tsx`
- `src/renderer/src/components/QrPairing.test.tsx`
- `src/renderer/src/components/RawCard.test.tsx`
- `src/renderer/src/store/dashboard.test.ts`
- `src/renderer/src/views/Onboarding/LinkWhatsApp.test.tsx`
- `tests/setup-renderer.ts`

No npm dependency added or changed, no git commit, no binary executed, no network call.
