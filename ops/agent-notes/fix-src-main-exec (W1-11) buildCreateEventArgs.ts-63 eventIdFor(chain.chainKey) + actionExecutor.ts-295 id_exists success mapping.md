# fix-src-main-exec (W1-11) — approval-first-1: edited create_event retry re-used the chain eventId

> Filename note: the task asked for `...buildCreateEventArgs.ts:63 ... actionExecutor.ts:295 ...`. Windows forbids
> `:` in a file name (it opens an NTFS alternate data stream), so the colons are written as `-` here.

Scope: the ONE confirmed finding `approval-first-1` (major) — `buildCreateEventArgs.ts:63`
`eventIdFor(chain.chainKey)` + `actionExecutor.ts:295` `id_exists` → success mapping.

## Verdict: the finding is real, and it is one defect with two faces

The `id_exists → done` mapping is not wrong *per se*; it is only sound if the deterministic id identifies
**what the user approved**. It did not: the id was derived from the chain key alone, while `applyEdit`
(actionExecutor.ts:145-166) lets the user change title/start/end/location on ANY pending `create_event`,
including a retry clone. So an edited retry re-sent the id of the event the timed-out first attempt had
already created → Google 409 → `runCreate` reported `done` and `applyCreateSuccess` stamped the NEW start on
the item, while the calendar still held the OLD slot. Reproduced before the fix (see below).

## Fix (one line of behaviour, in the id derivation)

`src/main/exec/buildCreateEventArgs.ts`

- `eventIdFor(chainKey)` → `eventIdFor(chainKey, content: ApprovedEventContent)`, hashing
  `JSON.stringify([chainKey, title, startLocal, endLocal, timeZone, location])` (one JSON array = unambiguous
  framing; still 20 digest bytes → exactly 32 base32hex characters, same alphabet, same shape).
- `buildCreateEventArgs` passes the APPROVED payload (`eventIdFor(chain.chainKey, p)`).
- New exported type `ApprovedEventContent` (`Pick<CreateEventPayload, title|startLocal|endLocal|timeZone|location>`).
- `description` is deliberately NOT hashed: it is the app template, so switching the UI language between two
  attempts must not produce a second event. `allowDuplicates` is not hashed either (it is a confirmation flag,
  not content). `calendarId` is not hashed: a different target calendar cannot collide on an id anyway.

Why the signature changed instead of adding a second function: every existing caller had to be re-pointed on
purpose. A leftover `eventIdFor(chainKey)` would silently compute an id that nothing sends any more.

`src/main/exec/actionExecutor.ts:294` — comment only. The mapping stays `id_exists → done`, and it is now
sound: with the content in the id, a 409 can only mean "an earlier attempt **of this chain, with exactly this
approved content**, already created this event", which is precisely the idempotency I7 wants. I deliberately
did NOT add the reviewer's alternative (re-read via `read.findAppEvent` on 409 and fail on mismatch):

- it costs an extra MCP round trip on every 409,
- there is no `updateEvent`/`deleteEvent` in `McpWriteClient`, so "fail with a distinct error code" would leave
  the user permanently unable to add the moved slot from the app — every further click would fail the same way,
- and it would need a new `ErrorCode` + locale strings (a much larger surface than the id derivation).

`src/main/mcp/writeClient.ts` — comment on `CreateEventArgs.eventId` updated to the new derivation. No code.

## Tests (written to fail first, then made to pass)

- `src/main/exec/actionExecutor.test.ts` — NEW `create outcomes > an EDITED retry clone gets its OWN eventId, so
  the slot the user approved the second time really reaches the calendar`. Drives the real `createActionExecutor`
  over the real in-memory app DB; the write double is a Map keyed by the client-supplied id (repeat id = 409),
  first call = "created, then timeout". Asserts: outcome `done`, the second id differs from the first, the
  calendar entry for the id actually sent holds 19:00-20:00, `items.calendarEventId` = that id,
  `items.eventStartTs` = the approved 19:00, and `waAction` still names the chain root for both calls.
  **Measured before the fix:** `AssertionError: expected 'nuqg31v842bs2rmo2edfdk3lkgukhkc2' not to be
  'nuqg31v842bs2rmo2edfdk3lkgukhkc2'` — i.e. exactly the skeptic's reproduction. Green after the fix.
- `src/main/exec/buildCreateEventArgs.test.ts` — known-answer vectors recomputed for the new input string
  (documented in the test), plus two new cases: the id is stable for same chain + same content and differs for a
  different chain; and it changes when ANY of title/start/end/zone/location changes. The existing
  "a retry clone gets the SAME eventId" case is unchanged and still passes (unedited retry stays idempotent).
- `src/main/exec/actionExecutor.test.ts:911` (the `[R2]` unedited-retry case) is untouched in substance and green.

Call sites updated (no assertion weakened anywhere):

- `tests/helpers/ledger.ts` — now a STRONGER invariant: the wire `eventId` must equal
  `eventIdFor(chainKey, content)` for the content of some **approval record** of that chain
  (`approved_final_json` of an executed row), not just for the chain key. A create-event whose id is not derived
  from something the user approved fails the ledger.
- `tests/security/crash-recovery.test.ts` — `crashMid` now carries the approved `eventContent`; the
  "stable across clones and unique per chain" case additionally asserts that the SAME chain with a DIFFERENT
  approved slot does not collide with the chain-root id.
- `tests/integration/recovery.test.ts` — the `[R2]` "Add again re-uses the chain root eventId" case now builds
  the approved payload and the expected id from one `eventContent` object; it still proves the UNEDITED retry
  re-sends the same id and that exactly one event exists.

## Verification

- `npx vitest run src/main/exec src/main/mcp tests/security/crash-recovery.test.ts tests/integration/recovery.test.ts tests/integration/ledger.test.ts` → 15 files, 331 tests, all green.
- `npx vitest run tests/security tests/integration` → 555 tests, 554 green (the one red is NOT mine, see below).
- `npx eslint` over every touched file → clean. `npx prettier --check` → clean.
- `npm run typecheck`: no error in any file I touched (`grep` over exec/, ledger, crash-recovery,
  integration/recovery, writeClient → nothing).

### Red tests I did not cause and did not touch (reported, not hidden)

The repo is being edited by other agents while I worked (files changed under me mid-run), so the full-suite
result moved between runs. Neither failure involves `exec/**`:

- `tests/security/redaction.test.ts > after data:purgeNow neither app.db nor the daily backups still hold the
  message text` — fails with a `TEMP-DIAG` label someone else added; found `item_messages.text=1`,
  `actions.canonical_json=1`. Retention/purge, not the calendar id. It passed again on a later run.
- `src/main/llm/local/llamaServer.test.ts > is not ready when the child died while GET /health was in flight`.
- `src/renderer/src/**` (`App`, `ItemCard`, `ItemList`, `RawCard`, `Dashboard`, `main`) failed to transform in
  one run (esbuild error) and `npm run typecheck` reports errors in `agent/contextBuilder.test.ts` and
  `components/ItemCard.test.tsx` — all other owners' in-flight work.

## Residual behaviour worth a decision (NOT a regression, REQUEST to the orchestrator)

An edited retry now creates its own event, but the app cannot remove the event the timed-out first attempt
created (there is no update/delete in `McpWriteClient`), so the calendar can end up holding both the 17:00 and
the 19:00 event. That is strictly better than the old behaviour (a `done` with no calendar write at all), and
both events did have an approval record. Two mitigations already exist and need no code here: the MCP
`create-event` duplicate check can answer `duplicate` → `CAL_DUPLICATE` → the user gets the explicit
"add anyway?" click, and `reconcileUnknown` usually resolves the first attempt to `done` (then the card is
read-only and this path is not reachable at all). If the product wants the stale event cleaned up, that needs a
delete capability on the write facade — a spec change, out of this task's scope.

## Docs that now describe the old derivation (I do not own them — REQUEST)

- `docs/specs/contracts.md:1372` and `:1753` (`eventIdFor(chainKey)` signature + "sha256(idempotencyKey without ':rN')").
- `docs/specs/build-plan.md:212` ("deterministic `eventIdFor(chainKey)`").
- `docs/ARCHITECTURE.md:76` (I7 row).
- `src/shared/types.ts:311` and `docs/specs/contracts.md:264` still read "the part WITHOUT the `:rN` suffix is
  the chain root = input of eventIdFor()" — still true (it IS an input), so I left them alone.

`ops/agent-notes/verify-approval-first-1.scratch/` and `ops/agent-notes/review-approval-first.scratch/` were
read only; I did not modify or delete another agent's files.
