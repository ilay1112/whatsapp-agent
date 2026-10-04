# v2-repair-v2-renderer-defects - agent notes

Scope: src/renderer/** and src/shared/i18n/** only. Source: ops/agent-notes/V2-W2-03-e2e.md REQUESTS 2, 6, 8.
Method: failing test first for each item (all were seen red), then the fix, then `npx vitest run --project renderer`
(64 files / 1034 tests green), `npx vitest run --project main src/shared` (709 green), `npm run lint` (0),
`npm run typecheck` (0), prettier clean on src/renderer + src/shared. No e2e run (not in this task's verification list).

## REQUEST 2 - stale AutoState in Settings > Automatic mode

Cause (renderer half): `Settings.tsx` hydrated the auto store only when it was `null`, so a state hydrated at boot was
never re-read while Settings was opened / re-opened. (Main half - nothing emits `auto:changed` after a click-approved
create or a shadow decision - is another agent's fix.)

Fix:
- `store/auto.ts`: `hydrate()` is now safe to call any number of times: a read older than one already applied is
  dropped, and a read that was in flight when an `auto:changed` push landed is dropped (the push is at least as new).
  A failed newer read does not block an older successful one. New `applyPush(state)` = the one `auto:changed` handler
  (payload replaces the state, rows re-read); `subscribe()` uses it. The payload stays authoritative (C2 8: it IS the
  new AutoState), so no extra `auto:getState` round trip per push.
- `views/Settings.tsx`: re-reads AutoState on every mount (guard `=== null` removed), on the "Automatic mode" nav button,
  on "< Automatic mode" back from Automatic activity, and - while Settings is mounted - on every `dashboard:changed`
  (fallback: an approved create completing the track record / a shadow decision moves AutoState even if main forgets
  `auto:changed`). All of these are READS; no enable channel and no `settings:set` is touched (tests assert it).
- `auto:changed` itself is applied by App's window-wide subscription (unchanged location), now through `applyPush`.

Tests: store/auto.test.ts (+4: push wins over in-flight read, newest of overlapping reads, older read lands when newer
failed, applyPush), Settings.v2.test.tsx (+5: re-read on open with a stale store, auto:changed -> "End trial",
dashboard:changed re-read, nav + back-from-activity re-read, no re-read after unmount).

## REQUEST 6 - one size formatter (F24)

`src/shared/i18n/format.ts formatModelSize(bytes, lng)` now implements exactly the F24 rule of
`src/main/llm/local/manifest.ts formatModelSize(entry)` (decimal GB; 1 decimal >= 1 GB, 2 decimals >= 0.1 GB, whole MB
(min 1) below; Latin digits). A parity test in `src/shared/i18n/format.test.ts` compares the two for every
`MEDIA_MODEL_MANIFEST` entry, both languages, a 0..12 GB sweep and the rounding edges, so they cannot drift.
Result: "Download (1.6 GB)", "Download picture reading (0.18 GB / 0.99 GB)", and the same strings in Settings > Voice
notes / Pictures and the onboarding opt-in (one formatter everywhere - the card and Settings no longer disagree).
The v1 LLM tier sizes (Onboarding/frame.tsx, ux.md 8.1 GiB rule) are untouched.

Expectation updates that follow from the contract change (not weakened - same assertions, F24 values):
RawCard.media.test (1.5 -> 1.6, 0.2 -> 0.18), VoiceNotes.test (1.5 -> 1.6), Pictures.test (0.9 -> 0.99),
ChooseAi.v2.test (1.5 -> 1.6, 0.9 -> 0.99), format.test (rule rewritten + parity).
Note: the onboarding "Needs {{size}} of free space" fallback (no voice model known) formats 4 GiB, now "4.3 GB".

Spec tension (recorded, not resolved by me): UX2 C1 / 4.5 / 6 mockups still say "1.5 GB" / "0.9 GB" (GiB rule), while
ARCH-v2 B19, v2-pipeline and F24 say decimal (0.99 / 0.18 / 1.6). The orchestrator's task picked F24.

## REQUEST 8 - a red badge must never be hidden

Cause: `Badges` filters codes by scope; the draft-scope row is drawn only with a draft box, the event-scope row only
on the EventChip (compact) / sheet (expanded). S3 aborted for `manipulation` => no draft => no row => no badge.

Fix: `Badges` gains `adoptScopes` (scopes whose host row is not drawn; their codes join this row). `ItemCard` passes
`draft` when no draft box is drawn (`item.draft === null && !raw`) and `event` when neither the EventChip nor the sheet
is drawn (`!expanded && eventVm === null`); the card row never carries `automatic` / `auto_shadow` (AutoChip draws
them, as before). `RawCard` (no EventChip, no draft-scope row) adopts both. No duplicate: when the host row exists the
code stays there only (tests assert exactly-once).

Tests: ItemCard.v2.test (+5), RawCard.test (+1), Badges.v2.test (+2).

## REQUESTS for other owners

- main (`src/main/llm/local/manifest.ts`, owner of src/main): optionally make `formatModelSize(entry)` delegate to
  `@shared/i18n/format formatModelSize(entry.size, 'en')` so there is literally one implementation; the parity test
  holds them together meanwhile.
- e2e (`auto-mode.spec`, `undo.spec`, `i18n-rtl.spec`): the soft REQUEST 2 checks should now pass for Settings even
  before main emits `auto:changed` after a create (dashboard:changed fallback), but the Dashboard AutoStrip still relies
  on main's `auto:changed`. `pictures.spec` / `voice.spec` soft REQUEST 6 checks compare against the manifest
  formatter - now equal. Not re-run here.
