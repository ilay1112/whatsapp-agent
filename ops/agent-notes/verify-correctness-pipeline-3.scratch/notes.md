# Verification of review finding `correctness-pipeline-3` (skeptic pass)

Verdict: **REFUTED** (claimed severity major; residual hardening value at most **minor**).

## What the code really does
`src/main/bridge/ingest.ts:320-328` resets the watermark only when `bridgeDb.maxRowid() < watermark`.
That much of the finding is an accurate reading of the line.

## Why the failure scenario does not occur end to end

1. **The implementation matches the frozen contract verbatim.** `docs/ARCHITECTURE.md:179` (4.6 step 2) and
   `docs/specs/agent-pipeline.md:53` both specify: "if `max(rowid) < watermark`, reset watermark to 0". No
   requirement is broken by the code; the finding is at most a spec-hardening proposal.
2. **No in-app path leaves a stale watermark.** `relink()` deletes ONLY `store\whatsapp.db`
   (`src/main/bridge/launcher.ts:32`, `:697-701`), so a re-pair keeps `messages.db` and its rowids -
   the finding's "re-pair" trigger does not wipe the store. `unlinkAndWipe()` deletes the store and
   `src/main/compose.ts:991` resets the watermark in the same step.
3. **An externally deleted store can only be repopulated by the bridge the app itself spawns, and the app
   scans it while it is still empty.** `vendor/whatsapp-bridge-src/main.go:2426` calls `NewMessageStore()`
   (which does `MkdirAll("store")` + `CREATE TABLE IF NOT EXISTS messages`, `main.go:90-115`) BEFORE the
   connect/QR loop at `main.go:2630+`. So `messages.db` exists and is empty during the whole pairing window.
   `compose.ts` pokes ingest on bridge ONLINE (`:888`), on every doorbell ring (`:428`), on the
   `history_sync_done` marker (`:478`) and every `LIMITS.scanIntervalMs` = 30 s (`:1245`). The first of those
   scans sees `maxRowid() = 0 < watermark` and fires the reset at `ingest.ts:322`, before any history-sync row
   exists. Proven in `verify.test.ts` ("cp3 refutation A").
4. **Even in the residual race, the skipped rows carry no card.** An external wipe removes `whatsapp.db` too,
   so a QR pairing is forced, and `compose.ts:896-899` -> `recomputeLiveFrom()` (`:877-879`) sets
   `live_from_ts = pairedAt - backlogHours` (default 0). Every history-sync row predates the pairing, so
   `liveness()` returns `context` and `classify` gets `isLive:false` -> no item, no queue row. Proven in
   "cp3 refutation B". The race window is also inversely scaled: only a *tiny* stale watermark can be
   overtaken inside the 250 ms poke debounce, and a tiny watermark means only a couple of skipped rows.

## The reviewer's own proof does not distinguish the two behaviours
`ingest.ts:277-282` classifies only the NEWEST trigger-eligible row per chat. The reviewer's test puts all
five post-wipe rows in ONE chat and asserts `texts` excludes `new b1..b3` and includes `new b5`. That is
exactly what a *correct* (reset) scan also produces. Measured: in the first run of `verify.test.ts` case A,
the watermark had already been reset to `'0'` and all 5 rows were scanned, yet `seen` was `['new b5']` -
identical to the reviewer's "BUG" expectation. Their test therefore proves nothing about lost cards.

## If someone still wants the hardening
The proposed `(rowid, wa_msg_id)` identity check is reasonable defence in depth, but it is a change to a
frozen contract (ARCH 4.6 step 2 / PIPELINE 1.2) plus a new meta key, for a race that the ONLINE poke and the
30 s timer already close. Owner would be `src/main/bridge/ingest.ts` (W1-03). Not a repair-phase item.

Files touched by this pass: only this scratch directory.
