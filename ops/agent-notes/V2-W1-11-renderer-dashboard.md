# V2-W1-11-renderer-dashboard - builder notes

Package: `V2-W1-11-renderer-dashboard` (Wave 1 of v2). Brief: `docs/specs/v2-build-plan.md` section 7.
Status: **DONE** (second attempt, 2026-09-29 07:45-08:40). Decisions honoured: D-068..D-071 (nothing in this lane depends on
the gate values; the renderer only renders `AutoCardView` / `AutoState` as main sends them).

## History

The first attempt (00:29-00:36, no notes written) left real bodies in `ChangeLine(.format)`, `ItemCard.bdi`, `UndoControl`,
`AutoStrip`, `VoiceBubble`, `ImageBubble`, `QuotedBubble`, `Badges`, `EventEditor`, `store/auto`, `store/dashboard` and the
`useCardController` half of `ItemCard` (update_event result rows, drift, `extraFor`). The ItemCard render body, RawCard,
ItemList, Dashboard, dashboard.css and every v2 test were missing. This attempt reviewed all of that against UX2 / C2 and
continued from it.

## What landed (owned paths only)

- `components/ItemCard.tsx` render: Change card (ChangeLine between bubble and EventChip; EventChip = `to`; Approve change
  outline unless it is the only approval; Keep {{time}} / Keep the old place = `action:reject`, unguarded; cancel variant
  Cancel event outline + danger text / Keep it; `change_unclear` and `declined` draw no change UI; B4 `calendar_updates_unavailable`
  greys the button with the CAL_UPDATE_UNAVAILABLE title); persisted GONE / FOREIGN after a refresh (`failedUpdateCode`);
  Updated · rev N / Cancelled; UndoControl door `card` -> `item:undoChange {itemId, revisionId}`; Restore original (F1) via
  `item:restoreOriginal`; restore refused -> "Add it back" (approval of the inserted pending create_event); `automatic` /
  `auto_shadow` chip (`auto-chip-<id>`, the raw badge codes are filtered so nothing is drawn twice); "Not automatic: {reason}"
  (`auto-reason-<id>`, only while `policyLive`, only with a pending create/update, never for `ok` / `policy_shadow`,
  `aria-describedby` of the calendar approval button); overflow "Never automatic for this contact" (toast with its own Undo
  -> inherit); source-card chip "Change proposed - see Needs reply" (focuses the delta card, opens a collapsed section, closes
  the sheet); voice / picture bubbles; sheet: Automatic block, "The picture" (`item:getImage`, data-URL only), "What the AI read"
  (open when `image_unclear`), voice rows full / picture rows compact, "Now in your calendar" + EventEditor `mode:'change'`,
  "Check against the picture" date note; card accessible name gains ", change proposed".
- `components/RawCard.tsx` + new `components/RawCard.media.tsx` (`MediaActions`, `imageUnreadCause`): the voice raw card
  (VoiceBubble header, no "Analyse this chat") and the photo placeholder, ONE action each: Download ({size}) / Turn on in Settings
  / Try again / Analyse again (`voice:retry`) / Use Lite; Download picture reading ({size}) / Turn on / Choose an AI / Try
  again / Analyse again (`item:retriage`). Split into its own file so ItemCard can use it without an import cycle
  (build plan 6 naming rule `<ownedFile>.<suffix>.tsx`).
- `components/ItemList.tsx`: In-calendar list de-duplicated and keyed by `calendar.eventKey`; queue line
  "Transcribing a voice note (0:42)..." (`queue-transcribing`) replaces "Analysing N chats..." while a whisper job runs.
- `components/UndoControl.tsx`: `GuardedButton` (one IPC per activation, guard at click time) used by Cancel event (F32) and
  Restore original (F1); the control no longer draws its own "Open in calendar" (the card always has one - no duplicate).
- `components/EventEditor.tsx`: optional `dateNote` prop (aria-describedby on the date field).
- `components/AutoStrip.tsx`: now uses the shared `formatRelativeAge` (T2 9) instead of a private formatter; a `failed`
  row keeps the strip open like an `available` one (it offers Try again).
- `components/VoiceBubble.tsx`: shared `formatClockDuration`. `ChangeLine.format.ts`: private duplicates removed, `keepTimeLabel`.
- `views/Dashboard.tsx`: AutoStrip above the three lists (hydrates `store/auto`, subscribes `auto:changed` + `queue:changed`
  while mounted, unsubscribes on unmount); F6 cycle header -> AutoStrip -> columns -> footer.
- `views/dashboard.css`: `.autostrip`, narrow-window row wrap, `.image-thumb` (96 px cover), `.sheet-picture` (<= 360 px contain).
  Logical properties only.
- `src/shared/locales/pending/V2-W1-11-renderer-dashboard.json` (allowed prefix `card.*`): `card.autoNeverState`,
  `card.changeProposedA11y`, `card.autoBlock.addedOn`, `card.autoBlock.seeAll` (en + he).

Tests (all mine, colocated): `ChangeLine.test.tsx` (+ he/en DOM snapshots of the three kinds), `ChangeLine.format.test.ts`,
`UndoControl.test.tsx`, `AutoStrip.test.tsx` (+ he/en snapshots), `VoiceBubble.test.tsx`, `ImageBubble.test.tsx` (XSS fixtures,
`safeImageSrc` matrix), `ItemCard.v2.test.tsx` (every new approval-class button: one IPC, shownHash, double click, focus guard
mouse + keyboard; every AUTO_REASONS value except ok/policy_shadow renders its string; he/en snapshots of the Change card in all
three kinds), `ItemCard.bdi.test.tsx`, `RawCard.media.test.tsx`, `ItemList.v2.test.tsx`, `Badges.v2.test.tsx`,
`QuotedBubble.v2.test.tsx`, `EventEditor.v2.test.tsx`, `store/auto.test.ts`, `store/dashboard.v2.test.ts`,
`views/Dashboard.v2.test.tsx`, `views/Dashboard.static.test.ts` (no `settings:set` / enable call in any owned file, no
`dangerouslySetInnerHTML`, no physical Tailwind utility, bubbles have no link, dashboard.css logical only). Snapshots use
`container.firstChild` (the lint config bans reading `innerHTML`).

## Verification (2026-09-29 ~08:35)

| Check | Result |
|---|---|
| `npx eslint --max-warnings 0` on every owned source + test file | clean |
| `npm run typecheck` | no error in owned files (3 errors elsewhere, see below) |
| `npx prettier --check` on owned files | clean |
| `npx vitest run --project renderer` | 855 passed, 1 failed - NOT mine (see BLOCKED-BY / REQUESTS: W1-12's block of `v2-stubs.test.tsx`) |
| `src/shared/locales/locales.test.ts` + `src/shared/i18n` | green (parity over the merged fragment) |
| coverage (owned files) | every file >= 90 lines / 85 branches / 90 functions; lowest: ItemCard 94.5 / 90.5 / 90.8, UndoDismissDrawer (v1, unchanged) 100 / 86.3 / 100 |

Typecheck errors outside my paths (not fixed, reported): `tests/integration/pipeline-image.test.ts(70,101)` and `(626,69)`
(`file` on the media-kind union), `tests/security/vision-no-tools.test.ts(271,77)` (`LlmTool` shape) - both V2-W1-08's.

## Assumptions / view-model gaps (the renderer reads what C2 1.5 gives; main re-checks everything)

1. **F28 self trigger**: `ItemCard` VM has no `triggerAuthor`. `selfTriggered(item)` reads an optional `triggerAuthor === 'self'`
   defensively, so the line appears as soon as main sends it (REQUEST 1).
2. **F1 Restore original**: no explicit flag. Shown when `undo.automatic && undo.state !== 'undone' && calendar.revision >= 3`
   (create + two edits). Main refuses anything else. Not shown on AutoStrip rows (an `AutoWriteView` cannot be tied to its
   event chain) (REQUEST 1).
3. **Automatic chip kind** ("Added / Moved / Cancelled automatically") is read from `eventState` (created / updated / cancelled).
4. **Image unread cause**: `MEDIA_UNAVAILABLE` -> media_unavailable, `LLM_BAD_OUTPUT` -> read_failed, `images.enabled=false` ->
   disabled, projector not ready (`model:getPlan().mmproj`) -> no_local_reader, else provider_cannot.
5. **Voice model size / tier** for "Download ({size})" come from `voice:getState` (read once per such card, never on a timer).
6. The sheet voice caution with the model name (`voice.cautionSheet`) and the footer provenance line (UX2 3.7) are NOT rendered:
   `VoiceView` carries no model label and `ItemCard` no provider (REQUEST 1). The ordinary caution line is shown instead.
7. AutoStrip row arrival edge (UX2 1.4) not implemented (no per-row arrival signal); the strip never animates open (as specified).
8. `v2-stubs.test.tsx` (W0 file, blocks per owner): I replaced only MY two assertions - `autostrip` is now absent with no rows,
   and `useAutoStore.hydrate()` resolves. W1-12's `useCliStore.refresh()` assertion is theirs.

## REQUESTS

1. **Orchestrator (C2 1.5 `ItemCard`)**: add `triggerAuthor: TriggerAuthor` (F28 `change.byYou` line), `canRestoreOriginal:
   boolean` (F1, also per `AutoWriteView`), `provider: ProviderId` (UX2 3.7 footer provenance) and a voice `modelLabel`
   (`voice.cautionSheet`). The renderer already reads `triggerAuthor` if present.
2. **V2-W1-12 (App.tsx)**: consume `useDashboardStore.navRequest` (`{view:'activity'}` from the AutoStrip "Show all" link and the
   sheet's Automatic block; `{view:'settings', section:'ai'|'voice'|'pictures'}` from the voice / picture card actions), then
   call `clearNavRequest()`. Until then those buttons only record the request.
3. **V2-W1-12 (`src/renderer/src/v2-stubs.test.tsx`)**: your block still expects `useCliStore.refresh()` to reject with
   `/V2-W1-12/`; it now resolves, so the file's second test is red.
4. **V2-W1-12 (`i18n.usage.test.ts`)**: I now reference keys under `change.`, `undo.`, `badge.`, `voice.`, `image.`, `auto.`
   (strip/verb/reason/never/allowAgain), `event.updatedRev`, `event.cancelled`, `download` is untouched. Delete the
   `SEEDED_FOR_OTHER_PACKAGES` entries once the staleness test says so (it is green today).
5. **V2-W1-12 (`App.tsx`)**: `queue:changed` is subscribed by the Dashboard into `useDashboardStore.queue` while it is mounted; the
   Dashboard falls back to `useHealthStore.queue`. Either source is fine; no change needed unless you want one owner.
6. **V2-W2-01**: fold `src/shared/locales/pending/V2-W1-11-renderer-dashboard.json` into the base files.

## BLOCKED-BY

None for my own tests. The only red renderer test (`v2-stubs.test.tsx` > "stores keep what they are given") fails on V2-W1-12's
`useCliStore.refresh()` assertion (REQUEST 3), not on anything this package owns.
