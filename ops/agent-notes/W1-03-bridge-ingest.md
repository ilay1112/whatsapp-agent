# W1-03-bridge-ingest - working notes

Package: doorbell, read-only bridge DB reader, timestamp parsing, ingest scan.
Owned paths: `src/main/bridge/{doorbell,bridgeDb,ingest,timestamps}.ts` (+ colocated tests), `tests/fakes/fake-bridge-db.ts`, this file.

Status: **done**. All four modules implemented, 128 colocated tests green, lint clean, typecheck clean in owned files.

---

## What was built

| File | Summary |
|---|---|
| `timestamps.ts` | `parseBridgeTs` for the go-sqlite3 text form (space **or** `T` separator, 1-9 fractional digits truncated - never rounded - to ms, `±HH:MM` / `±HHMM` / `Z` / no suffix), RFC 3339, and integer epoch s/ms given as a number **or** as an all-digit string. Calendar roll-over (`2026-02-31`) and out-of-window values are rejected. |
| `bridgeDb.ts` | `DatabaseSync(path, {readOnly:true})` + `PRAGMA query_only=1` + `busy_timeout=2000`. Lazy open, `open()` returns false when the file is absent, every method degrades to an empty result while closed. Only SELECTs; no journal-mode change, no index creation, no SQL date math. |
| `doorbell.ts` | `http.createServer` on `127.0.0.1:0` `exclusive:true`, `requestTimeout 5000` / `headersTimeout 2000` / `maxHeadersCount 32`. Accepts POST + loopback remote + exact `Host` + no `Origin` + constant-time path secret and `X-Bridge-Token`. Everything else: uniform `404` + `req.socket.destroy()` without touching the body. Accept path answers 200, calls `onRing()` synchronously, then drains byte-count-only with the 20 MB cap and the 10 s drain timeout. 30 req/s sliding-window limiter. |
| `ingest.ts` | Rowid-watermark scan in batches of `LIMITS.ingestBatch`, store-wipe reset, DM filter, `@lid` -> phone-JID resolution + `mergeLidInto`, `is_known` OR'ed over both JID forms, backlog gate (A14), outbound `answered_elsewhere` vs our own send inside 120 s, `supersedePendingRepliesOfChat` when a new open item is created, watermark persisted in the same transaction, 250 ms trailing `poke()`, `resolveLidChats()`, `contextFor()`. |

Constant-time comparison hashes both sides with SHA-256 before `timingSafeEqual`, so neither the value nor its **length** leaks (`timingSafeEqual` throws on unequal lengths).

---

## Decisions, assumptions and deviations

1. **`userHasSentIn` follows ARCHITECTURE, not the CONTRACTS SQL literal.** The CONTRACTS 12 doc comment writes the media guard as
   `(media_type IS NULL OR media_type NOT IN ('', 'reaction') OR content <> '')`. For a reaction row the content is the emoji, so
   `content <> ''` is true and the whole clause is TRUE - an own thumbs-up would flip a stranger's chat to "known", which the *same*
   comment, ARCHITECTURE 4.6 step 4, A13 and TESTS 5.3 all explicitly forbid. Implemented ARCHITECTURE's form
   (`media_type IS NULL OR media_type <> 'reaction'`). **REQUEST (see below) to fix the CONTRACTS comment.**

2. **`older_message` rows are `analysis='held'` with `hold_reason = NULL`.** CONTRACTS 12 says an older-but-live row becomes "a raw card
   (analysis 'held' is NOT used; badge `older_message`, no LLM run)". That is structurally impossible as literally written: a card is
   *listed* only when `analysis IN ('done','held','failed')` (`isListed`) and *open* only when `analysis !== 'done'` (`deriveState`), so the
   only listed-and-open values are `held` and `failed`. `failed` is the red "Analysis failed / Analyse again" card (UX 6.6), whereas UX 496
   gives `older_message` the neutral "Analyse this chat" action - i.e. the `unknown_sender` shape. Read the parenthetical as "no
   `hold_reason` value is used" (none of `unknown_sender|paused|waiting_llm|budget` fits) and stored `analysis='held', hold_reason=NULL`.
   Ingest additionally **never enqueues** an older-live row, whatever S0 returns, so "no LLM run" is enforced structurally here and not only
   in `stage0.ts`. If W1-10 or W2-01 prefers another encoding, ingest is the single place to change.

3. **Ingest does not write `wa_msg_id` onto an action.** ARCHITECTURE 4.6 step 5 says a matching own send should "record `wa_msg_id` on the
   action", but `Repos['actions']` has no such mutator: the only route is `markDone(id, result, now)`, which is `WHERE state='executing'`
   and throws `ActionStateError` on a miss. `exec/reconcile.ts` (W1-11) owns exactly that matching (`reconcileUnknown({repos, bridgeDb, ...})`),
   so having ingest call `markDone` too would race the executor and turn a benign miss into a thrown error. Ingest therefore only *decides*
   "ours" vs "answered from the phone" (same text, `|ts - executedAt/approvedAt| <= LIMITS.reconcileSendWindowMs`) and leaves the id to reconcile.

4. **`answered_elsewhere` supersedes actions only when the item closes.** ARCHITECTURE 4.6.5 wants "any pending `send_reply` superseded"; the
   repo offers `supersedePending(itemId)` (all kinds) and `supersedePendingRepliesOfChat(chatId, exceptItemId)` (other items of the chat).
   When no event approval is pending the item closes and `supersedePending(item.id)` is correct. When an event approval *is* still pending the
   item stays open and nothing is superseded, because superseding all pending actions would also kill the event approval the user still needs.
   Leaving that one draft approvable is a UX wart, not a safety hole (it still requires an explicit approval). Worth a `supersedePendingOfKind`
   in a future contract revision - listed under REQUESTS.

5. **`resolveLidChats()` reads `chats` through `repos.db`.** `Repos['chats']` exposes `byId`/`byJid`/`withPolicies()` but no "list all chats",
   and the contract is frozen, so the `@lid` sweep uses one read-only `SELECT id, jid FROM chats WHERE jid LIKE '%@lid'` on `repos.db`
   (part of the `Repos` interface). Each merge runs in its own transaction.

6. **Backlog-gate inputs.** `live_from_ts` is read from meta; if absent it is derived from `paired_at - clamp(backlogHours, 0, 72) * 3.6e6`;
   if `paired_at` is absent too there is no lower bound. "Has the bridge been online" is `deps.bridgeOnlineOnce?.()` and falls back to
   `meta.last_online_ts !== null`; "syncing" is `deps.syncing?.() ?? false`. Unparseable timestamp => context-only **and** counted.
   A row timestamped in the future (clock skew) is live.

7. **`poke()` is a coalescing trailing debounce**: the first poke schedules a scan at `now + LIMITS.pokeDebounceMs`; further pokes inside that
   window join it rather than pushing the deadline out, so a continuous burst can never starve the scan. Overlapping `scanNow()` calls share
   one in-flight promise plus a dirty flag (PIPELINE 1.1); a dirty run re-pokes after the current one finishes.

8. **`stats.kept`** counts every DM row that survived the never-trigger filter (reaction / empty / deleted), not only the newest row per chat.

---

## Two Node-level findings that shaped the doorbell (worth keeping)

**A. Node's HTTP server stops feeding an unfinished request body once the response has completed.** Measured on Node 24 (outside vitest):
with `res.writeHead(200); res.end()` first and then `req.resume()`, exactly 3 MB (48 x 64 KB) of a 25 MB body arrive and the connection then
stalls until `requestTimeout` kills it; the same server drains all 25 MB when the response is sent *after* the body. So the mandated
"answer 200 immediately, then discard" shape means the 20 MB `DOORBELL_BODY_CAP` and the 10 s drain timeout can never be reached through a
real socket - the stack cuts us off far earlier. This is strictly *safer* (less attacker data read), and `stats().bytesDrained` stays tiny.
Consequences:
 - the end-to-end 25 MB test on the valid path asserts only `bytesDrained <= cap + 64 KB` (the spec's real requirement) instead of "cut at 20 MB";
 - the cap branch, the drain timeout and the non-loopback-remote branch are covered by invoking the request handler directly. To make that
   possible `doorbell.ts` calls `http.createServer(...)` through the module object rather than via a named import, so a test can spy on it.
   Everything else (404 uniformity, 200-before-body, payload-unused, limiter, stop) is tested against the real socket.

**B. `Connection: close` on the accept path would break the drain.** Node calls `socket.destroySoon()` as soon as a `close`-marked response is
flushed, cutting the drain instantly. The accept path therefore answers with keep-alive (`Content-Length: 0` only); only the reject path sends
`Connection: close` + `socket.destroy()`, which is exactly what it wants.

**C. `remoteAddress` cannot be stubbed on `net.Socket.prototype`** (non-configurable accessor) - another reason the non-loopback case is a
handler-level test.

---

## Changes to `tests/fakes/fake-bridge-db.ts` (owned by this package)

1. `holdWriteLock(ms)` now uses `BEGIN EXCLUSIVE` instead of `BEGIN IMMEDIATE`. TESTS 3.1 documents this helper as the way to "provoke
   SQLITE_BUSY in the app's read-only connection", but the bridge store uses the **rollback journal** (not WAL), where `BEGIN IMMEDIATE`
   only takes a RESERVED lock and readers still get through - IMMEDIATE could never provoke the SQLITE_BUSY the helper exists for.
   The functional promise is kept; only the statement changed (comment in the file records it).
2. `wipe()` no longer fails on `no such table: sqlite_sequence`. The bridge schema has no `AUTOINCREMENT` column, so that table does not exist;
   the delete is now guarded by a `sqlite_master` probe.

Nothing else in the fake was touched; the schema, the go-sqlite3 timestamp formatting and the CONTRACTS 16 method names are unchanged.

---

## Test map (what covers which acceptance item)

| Acceptance item | Test |
|---|---|
| `bridge/timestamps` table incl. 1-9 fractional digits, RFC 3339, epoch s/ms, garbage -> null | `timestamps.test.ts` (34 cases) |
| opened readOnly + query_only, write attempt throws | `bridgeDb.test.ts` "opens read-only..." + the source-contract test |
| file missing => no-op | `bridgeDb.test.ts`, `ingest.test.ts` |
| `SQLITE_BUSY` => retry at next trigger | `bridgeDb.test.ts` (`holdWriteLock`), `ingest.test.ts` (injected busy error, then success) |
| watermark paging > 500 rows | `ingest.test.ts` "pages through more than one batch" |
| wiped store => reset without re-triage | `ingest.test.ts` |
| DM filter (group / status / newsletter / broadcast / reaction / empty / deleted) | `ingest.test.ts` (8 cases) |
| `is_known` ([R2] reaction, empty, deleted excluded; OR over both JID forms) | `bridgeDb.test.ts` (5 cases) + `ingest.test.ts` |
| `phoneJidForLid` + `resolveLidChats()` merge | `bridgeDb.test.ts`, `ingest.test.ts` |
| backlog gate: 3 d while syncing, 3 d after ONLINE, 10 d -> `older_message`, `live_from_ts`/`backlogHours`, unparseable ts, clock skew | `ingest.test.ts` (8 cases) |
| 300-row history sync => zero queue rows | `ingest.test.ts` |
| BRIDGE_TS_FORMAT after 20 consecutive failures, cleared on success | `ingest.test.ts` |
| outbound-newest => `answered_elsewhere` vs our own send within 120 s | `ingest.test.ts` (5 cases) |
| new open item supersedes the chat's other pending `send_reply` | `ingest.test.ts` |
| watermark in the same transaction (kill between steps) | `ingest.test.ts` "keeps the watermark and the item writes in ONE transaction" |
| doorbell cases of TESTS 8.2 item 7 | `doorbell.test.ts` (34 cases) |
| 25 MB on a wrong path => `bytesDrained < 64 KB` | `doorbell.test.ts` |
| 100 % line coverage on `doorbell.ts` | verified: 100 % lines / 100 % branches / 100 % functions |

Coverage of the owned modules (v8, own tests only):
`doorbell.ts` 100/100/100, `bridgeDb.ts` 100 lines / 95.7 branches, `ingest.ts` 99.5 lines / 88.9 branches, `timestamps.ts` 100 lines / 96.2 branches
- all at or above the TESTS 13 thresholds (doorbell 100/95/100, `bridge/**` 90/85/90).

Not covered end-to-end, deliberately: "slow-body client on the wrong path is cut by `requestTimeout` 5 s" - the doorbell destroys such a
socket immediately, long before the 5 s timeout; the three hardening values are asserted as exported constants instead of poking at the
private `Server` object.

---

## REQUESTS

- **W2-01-compose-integration / orchestrator**: `docs/specs/contracts.md` section 12, `BridgeDb.userHasSentIn` doc comment - the SQL literal
  `(media_type IS NULL OR media_type NOT IN ('', 'reaction') OR content <> '')` contradicts its own prose and A13 (a reaction row has non-empty
  content, so it would satisfy the clause). It should read `(media_type IS NULL OR media_type <> 'reaction')`, as in ARCHITECTURE 4.6 step 4.
  The implementation already follows ARCHITECTURE.
- **W2-01-compose-integration / orchestrator**: `docs/specs/contracts.md` section 12, `Ingest` doc comment - "analysis 'held' is NOT used" for
  `older_message` cannot be satisfied together with "raw card" (see decision 2). Please confirm `analysis='held', hold_reason=NULL` or name the
  intended encoding.
- **W1-04-db** (future contract revision, not a Wave 1 change): a `supersedePendingOfKind(itemId, kind, now)` would let ingest supersede only the
  pending `send_reply` of an item that stays open because an event approval is still pending (decision 4).
- **W1-10-agent-pipeline**: `createStage0` receives `isOlderLive`. Ingest already refuses to enqueue such a row and stores it as a raw card, so
  S0 may return `queued` for it without risk - but returning `held` with a reason would let the card show a more specific chip.
- **W2-01-compose-integration**: wire `createIngest({ bridgeOnlineOnce, syncing })` from the launcher (ONLINE transitions and the
  `history_sync_done` hint) - without them ingest falls back to `meta.last_online_ts` and `syncing = false`, which is correct but coarser.
  Also call `ingest.resolveLidChats()` on every ONLINE transition and `ingest.poke()` from the doorbell, the 30 s timer, app start, reconnect
  and the `history_sync_done` marker (PIPELINE 1.1).

## BLOCKED-BY

None. `W1-04-db` landed `createRepos` while this package was being built, so every ingest test runs against the real app DB.

---

## Fix round (2026-09-23) - re-verification, no code change

The repo-wide audit (`ops/agent-notes/wave1-audit.md` section 5, "W1-03") attributes exactly two items to this
package, and both are explicitly classified there as **doc defects, not code defects**. Both live in
`docs/specs/contracts.md`, which is orchestrator-owned (routed via W2-01) and outside this package's owned paths
(build-plan section 6), so neither can be fixed from here without breaking build-plan rule 8.

Re-checked today that the contract text is still unamended:

- `contracts.md:1511` still carries `(media_type IS NULL OR media_type NOT IN ('', 'reaction') OR content <> '')`.
- `contracts.md:1541` still carries "analysis 'held' is NOT used".

The implementations are unchanged and still follow ARCHITECTURE 4.6 / A13 / TESTS 5.3:

- `src/main/bridge/bridgeDb.ts:50` - `AND (media_type IS NULL OR media_type <> 'reaction')`, with the divergence and
  its reason recorded in the source comment at lines 45-49.
- `src/main/bridge/ingest.ts:196-235` - older-but-live row => `analysis='held'`, `hold_reason=NULL`, badge
  `older_message` (`withOlderBadge`, line 384), and `return` before the queue write, so no LLM run is possible
  whatever `classify` (S0) answers.

Both requests are restated verbatim under REQUESTS above and carried in the structured result as unresolved,
addressed to the orchestrator.

### Evidence re-run (all from this fix round)

| Gate | Command | Result |
|---|---|---|
| owned tests | `npx vitest run --project main src/main/bridge/{doorbell,bridgeDb,ingest,timestamps}.test.ts` | **4 files / 128 tests passed** |
| lint | `npx eslint <4 sources + 4 colocated tests + tests/fakes/fake-bridge-db.ts> --max-warnings 0` | **clean, exit 0** |
| typecheck | `npm run typecheck` | no error in any owned file. Repo-wide it is still red on three TS2532 in `src/shared/when.test.ts` (W1-08-shared-utils, audit section 2.1) - not this package's file, not touched |
| coverage | v8, own tests only | `doorbell.ts` 100 stmt / 100 br / 100 fn / 100 ln - `bridgeDb.ts` 100 / 95.65 / 100 / 100 - `ingest.ts` 97.51 / 88.88 / 100 / 99.48 - `timestamps.ts` 95.83 / 96.15 / 100 / 100. All at or above the TESTS 13 thresholds (doorbell 100/95/100, `bridge/**` 90/85/90) |
| stubs | `grep NotImplementedError` over the owned sources | none |
| doorbell body rule | `grep 'JSON.parse\|\.json()'` over `doorbell.ts` | none |

Note on the coverage command: running it with `--coverage.include='src/main/bridge/**'` reports a false failure,
because that glob also pulls in W1-02's `pairing/readClient/sendClient/stdoutMarkers/invariants/janitor/launcher`,
which this package's tests do not exercise. Scoping the include to the four owned files is what the numbers above
are measured with.

Status after this round: unchanged - **done**.
