# v2-fix-src-main-agent - notes (v2 phase 3 repair)

Scope: five confirmed findings in `src/main/agent`. Test first (each new test was run RED against the unfixed code), then the
smallest product change, then the surrounding suites. No new dependency, no version change, no commit.

## Results

| Finding | Status | Product change | Tests (red first) |
|---|---|---|---|
| injection-v2-1 (minor) S4 leak guard misses short rows / excerpts / homoglyphs | fixed (hardening, see decision note) | `validate.ts` `crossChatLeak` + `leakNormal` | `validate.v2.test.ts` "cross-chat leak guard": 3 red tests + 1 control test |
| injection-v2-3 (minor) picture-digit slot persisted as `trigger_kind 'text'` | fixed | `orchestrator.ts` `triggerKindOfRun({..., imageShapedSlot})`, call site passes `imageMerge?.used === true` | `orchestrator.v2.test.ts`: an end-to-end V1 hand-off run (readText '' + digits => `image`) and the pure-helper row |
| editing-undo-6 (minor) R10 counts the event's old day and "שבת שלום" | fixed | `resolveDelta.ts` R10 drops the event's own weekday for a reschedule; `namedWeekdays` blanks the greeting | `resolveDelta.test.ts` R10 (3 tests) + 4 `namedWeekdays` table rows |
| editing-undo-7 (major) a cancel naming the event's weekday a week ahead becomes a move | fixed | `resolveDelta.ts` R8: bare weekday (offset 0) equal to the event's weekday names the event; its date is the event's own date | `resolveDelta.test.ts` R8 (4 tests: verifier cases A and B, different-time variant, controls) |
| data-integrity-v4-7 (major) Dismiss / "Never analyse" keep transcripts, delta/image JSON, pictures | fixed (one residual, below) | `items.ts` `dismiss()` and `setChatPolicy({policy:'never'})` | `items.v2.test.ts` "Dismiss / Never analyse delete media-derived data at once (9.3)": 2 red + 1 control |

## Details and reasoning

### injection-v2-1 (`validate.ts` crossChatLeak)
- **Kept as the contract says:** any 24-char normalised window of an other-chat row in the draft => leak. The spec row "23-char overlap
  passes" still holds for plain text (no new test contradicts it).
- **Rule added (a), whole short rows:** a row shorter than the window is matched as one whole string once it has >= 12 normalised
  characters (`LEAK_WHOLE_ROW_MIN`). Shorter rows ("ok", "see you", "thanks!") are too common to prove a leak, and a false positive
  withholds the draft with a red badge.
- **Rule added (b), digit runs:** any 4-digit window of a digit run in an other-chat row, found inside a digit run of the draft, is a
  leak. This covers a door code, a card's last four or a PIN quoted out of a longer row. 19xx/20xx is skipped so a year never
  withholds a draft.
- **Rule added (c), confusables:** `leakNormal` folds a closed table of Cyrillic and Greek look-alikes into Latin, after the case fold.
  Hebrew and other scripts are untouched.
- **Rejected from the proposal:** "tokens of 4+ chars". Words like "meeting" or "tomorrow" would withhold almost every all_chats draft.
- **Rejected from the proposal:** "treat the draft as untrusted whenever crossChatRows > 0". It needs a new badge value, which means a
  `Badge` enum change, DDL CHECKs and i18n. That is outside src/main/agent and is a product decision.
- **ORCHESTRATOR DECISION still open:** should any served other-chat row add an info/amber badge so the approver knows other chats
  were read? Today only autoGate's `cross_chat_rows` rail uses the count.
- **Residual:** this is still a verbatim guard. A paraphrase ("four-two-four-two") or a pure-text excerpt of 12-23 chars inside a long
  row passes. No verbatim guard can meet the I5' sentence literally.
- **Existing callers unaffected:** tests/security/injection-corpus.test.ts and wa-tools.test.ts both pass with the stricter guard.

### injection-v2-3 (`orchestrator.ts` triggerKindOfRun)
- `imageShapedSlot` is an optional fourth field, so existing callers and tests keep compiling.
- I used `imageMerge.used` rather than "imageRead !== null". A readable picture whose digits did NOT shape the slot (S1 already named
  a date) contributed nothing. The text-only rule of P2 2 stays for that case.
- **Side effect (good):** items.ts builds the picture bubble only for `triggerKind === 'image'`, so a picture-only slot keeps its
  bubble.
- **Not changed:** the delta path takes picture digits through `imageWhenOf` / `opts.image`. imageMerge is computed for every run, so
  the same flag already covers the usual case. I did not add a separate "delta used image digits" flag.

### editing-undo-6 (`resolveDelta.ts` R10)
- **Reschedule rule:** the existing event's weekday is removed from the named set before the check, because it identifies the event.
  Every OTHER named day must still match the new day: "move Wednesday to Friday" resolved to Thursday is still `weekday_mismatch`
  (tested).
- **Known trade-off:** a model error that resolves "move to Wednesday" (the event's own day) to another day is no longer caught by
  R10. It is a fail-open convenience trade, still manual or auto-gated.
- **Cancel rule unchanged:** a cancel still checks against the event's own day, as before.
- **Greeting:** `[ו]שבת שלום` (whole words, any whitespace) is blanked before the scan. "בשבת", "מוצאי שבת" and a bare "שבת" still
  count (table rows + R10 test).

### editing-undo-7 (`resolveDelta.ts` R8)
- **Fix:** for a cancel with `dateKind:'weekday'`, `weekOffset:0` and `weekday` equal to the event's weekday, R8 computes the named
  slot with `dateKind:'none'`. The date is then the event's own date.
  - With no time, the slot is "nothing named" => stays a cancel (verifier variants A and B).
  - With a different time, it becomes a reschedule on the EVENT's date, not on this week's day.
- **Not covered on purpose:** an explicit week offset (`weekOffset >= 1`, "next ...") keeps the old comparison. The user said "next",
  and B20's "cancel with a named new slot => reschedule" applies.
- **Reschedule unchanged:** "move it to Wednesday" for an event next Wednesday plausibly means this week.
- **Reviewer's "within the event's own week" alternative:** not used. Variant B (today Monday, event Thursday next week) is not in
  "today's week" logic either way, so the weekday-equality rule is the precise one.

### data-integrity-v4-7 (`items.ts`)
- **dismiss():** in the same transaction as supersede + close, it nulls:
  - `transcripts.text` of the item's messages: chat jid from `chats`, `wa_msg_id` in the item snapshot or the trigger row;
  - `proposals.delta_json` / `image_json` of the item.
  - The cached picture was already deleted by compose.ts's `item:dismiss` wrapper. compose.ts is untouched.
- **setChatPolicy({policy:'never'}):** one transaction nulls the chat's transcripts (`chat_jid = chats.jid`) and the delta/image JSON
  of every item of the chat. Then `deps.mediaCache.deleteForItem(itemId)` runs for every item with a media_cache row of that chat
  (rows + files).
- **mediaCache type:** `ItemServiceDeps.mediaCache` gained an OPTIONAL `deleteForItem`. compose already passes the full MediaCache
  object, so no wiring change was needed. If it is absent, nothing is deleted and `media_cache_delete_unwired` is logged. A row is
  never deleted without its files.
- **Other policies:** `autoPolicy:'never'` ("Never automatic") and `policy:'default'` delete nothing (control test).
- **SQL location:** raw SQL via `repos.db.prepare`, the same precedent as bridge/ingest.ts and exec/outcome.ts. This avoids touching
  the `Repos` interface in src/main/db, which another fix agent is editing concurrently.
- **Residual 1:** media_cache rows with `item_id IS NULL` (transient between put and link, or after the item row was deleted) are not
  unlinked on 'never'. Unlinking needs the media module's file-naming function, and src/main/media/mediaCache.ts is being changed
  right now by the data-integrity-v4-2 fix (`mediaCacheFileNames`). Suggested follow-up: a `deleteForChat(chatId)` on the repo plus the
  media module, called from here.
- **Residual 2:** transcripts are matched by `chats.jid`. A transcript stored under a pre-@lid-merge jid is not reached. Same limitation
  as `orchestrator.ts` lookups.
- **Noticed, not mine:** retention's `mediaFileNames(sha256)` naming does not match the media module's naming. That is
  data-integrity-v4-1/-2, owned by another fix.

## Verification
- **New tests:** all 16 new tests were RED before the fixes and are green after. The Dismiss test was re-proven red by temporarily
  removing the two SQL lines.
- **eslint:** clean on every file I touched. `npm run lint` reports 2 errors, both in files other agents are editing
  (src/renderer/src/App.tsx, src/main/exec/actionExecutor.v2fix.test.ts).
- **prettier --check src/main/agent/*.ts:** clean.
- **Typecheck:** `tsc -p tsconfig.node.json` shows only TS2783 in src/main/llm/cli/runner.ts (in-flight edit by another agent).
  `tsconfig.web.json` and `tsconfig.tests.json` are clean.
- **`npx vitest run src/main/agent tests/security tests/golden tests/integration src/main/exec`:** 2913 pass. The only failures are the
  10 "voice notes" batches of tests/security/media-text-isolation.test.ts (a transcript row is missing). They fail identically with
  ALL my product changes reverted (bisected), and they passed in the later full run, so they are load-dependent and not caused by
  this change.
- **Full `npx vitest run`:** 7498 pass, 24 fail. All 24 are 5 s timeouts in waTools.test.ts, bridge/waReadClient.test.ts,
  bridge/ingest.test.ts and integration/pipeline-gates.test.ts, under heavy parallel load from other agents' suites. None of them
  imports a module I changed. Each takes about 6-7 s per test right now.

## Files touched
- src/main/agent/validate.ts, src/main/agent/orchestrator.ts, src/main/agent/resolveDelta.ts, src/main/agent/items.ts
- src/main/agent/validate.v2.test.ts, src/main/agent/orchestrator.v2.test.ts, src/main/agent/resolveDelta.test.ts,
  src/main/agent/items.v2.test.ts
