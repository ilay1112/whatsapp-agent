# verify-data-integrity-1 — attempt to refute, result: CONFIRMED (severity downgraded to major)

Probe: `probe.mjs` (node:sqlite, schema extracted verbatim from `src/main/db/migrations.ts`). Run:
`node "ops/agent-notes/verify-data-integrity-1.scratch/probe.mjs"`

```
ABORT direct DELETE FROM actions WHERE id=a1 -> ERR_SQLITE_ERROR approved content is immutable
ABORT DELETE FROM items WHERE closed_at < 200 (cascade) -> ERR_SQLITE_ERROR approved content is immutable
PASS  control: cascade with no retry_of -> {"itemsDeleted":1}
ABORT cascade with terminal+purged clone -> ERR_SQLITE_ERROR approved content is immutable
ABORT plain UPDATE actions SET retry_of=NULL WHERE id=a2 -> ERR_SQLITE_ERROR approved content is immutable
```

Refutations tried and defeated:
1. "FK actions don't fire user triggers" — false for SQLite; the implicit `SET NULL` update does fire
   `trg_actions_frozen` (probe lines 1 and 2).
2. "The clone is deleted before its parent, so the SET NULL never runs" — false; both actions belong to the same
   item and the `items -> actions` CASCADE deletes the parent (lower rowid) first, which trips the trigger (probe line 2).
3. "The frozen trigger's escape hatch (terminal + canonical_json already NULLed) lets it through" — false;
   the hatch also requires `NEW.retry_of IS OLD.retry_of`, which a NULLing violates (probe line 4).
4. "A test already covers it" — false; `grep retryOf` over all `*.test.ts` shows no retention/purge test with a
   retry chain. `src/main/db/retention.test.ts` only exercises chains-free actions, which is why 3660 tests are green.

Severity: the rubric's `blocker` needs data loss, an unapproved send/calendar write, or an unusable app. This is the
opposite of data loss (data fails to be deleted) and the app keeps working, so `major`: a stated requirement
(ARCHITECTURE section 10 retention + the "Delete now" button) is silently broken.
