# fix-src-main-ipc — repair notes

Label: `fix-src-main-ipc`. Scope: confirmed defects in `src/main/ipc`.
Run 1 was cut off by the weekly usage limit; run 2 (2026-09-27) resumed and closed it out.

## Status

| Finding | Severity | Verdict | Outcome |
|---|---|---|---|
| data-integrity-4 — `data:purgeNow` bypasses `runRetention` | major | finding CORRECT (and understated) | **FIXED** |

One finding in scope; fixed, with a red-first test at both levels.

---

## data-integrity-4 — `data:purgeNow` called `repos.retention.purge()` directly

### What was actually wrong

`src/main/ipc/handlers/data.ts` computed its own cutoff from `settings.privacy.retentionDays`
and called `deps.repos.retention.purge({before, closedBefore})`. It never called `runRetention`,
so `mode: 'purgeNow'` was never passed by any product caller and the whole `purgeNow` branch of
`src/main/db/retention.ts` was dead code. Four separate guarantees were therefore not kept:

1. **retentionDays = 0** (`retention.ts:48`). With the schema default of 30 — and a floor of 7
   (`src/shared/settings.ts:43`, `z.number().int().min(7).max(90)`) — the cutoff can never reach
   `now`. So "Delete stored message text now" deleted **nothing at all** for any message younger
   than the window, which is every message a user would press it about. The reviewer's scenario
   said the text "is NULLed in app.db"; it was not. That half is worse than reported.
2. **`backups\` wipe + one fresh VACUUM INTO copy** (`retention.ts:64-75`). Up to
   `DEFAULT_KEEP = 3` daily copies kept the text verbatim. `retention.ts:3` promises the opposite.
3. **180-day prune** of `runs` / `audit_log` / `rate_events` (`retention.ts:55-61`).
4. **The audit row.** The handler wrote its own thin `deps.audit('purge', …)` with only the three
   row counts — no `mode`, no effective `retentionDays`.

Spec being broken: `docs/ARCHITECTURE.md:513`, restated at `src/main/db/retention.ts:2-4`.

### Red first — both levels

Before touching the product file I reconstructed the old handler and ran the new tests against it:

- `src/main/ipc/handlers/data.test.ts` → **4 of 9 failed** (retentionDays-0 NULLing, the
  backups wipe, the 180-day prune, the single-audit-row assertion).
- `tests/security/redaction.test.ts` → the purge case failed on exactly the reviewer's scenario:
  `grepSentinels` found `ZZSENTINELMESSAGEBODYZZ` still inside
  `…\backups\app-20260921.db` after `data:purgeNow` returned ok.

With the fix in place, all of them pass. The reconstruction was scratch-only and was reverted;
the product file on disk is byte-identical to the fixed version (verified by diff).

### The fix

`src/main/ipc/handlers/data.ts` — the handler now calls the shared job:

```ts
runRetention({
  repos: deps.repos,
  settings: () => deps.settings.get(),
  now: () => deps.clock.now(),
  mode: 'purgeNow',
  backups: { dir: deps.paths.backupsDir },
});
```

The reviewer's proposed fix was correct, including its footnote: because `runRetention` appends
its own richer `purge` audit row, the handler's `deps.audit('purge', …)` had to be **dropped**,
or every "Delete now" would write two purge rows, the second one poorer. No new plumbing was
needed — `paths: AppPaths` was already on `HandlerDeps` (`register.ts:57`) and
`paths.backupsDir` already exists (`src/main/paths.ts:57`), so nothing had to be threaded
through. Product diff is 12 lines in one file.

`src/main/db/retention.ts` was **not** touched: the `purgeNow` branch was already written and
correct, merely unreachable.

### Tests changed, and why they were wrong before

- **`src/main/ipc/handlers/data.test.ts`** — the old case
  *"derives the cutoff from settings.privacy.retentionDays"* actively enshrined the defect,
  contradicting ARCHITECTURE 513. Replaced. The suite now runs the handler over a **real
  on-disk db + backups directory** (`fileRepos` / `tempDir`) rather than a `repos.retention.purge`
  spy: the purgeNow contract is about files and SQL rows, and a spy can see neither half.
  Five cases: retentionDays is ignored; `backups\` ends with exactly one fresh copy that does not
  contain the sentinel; the 180-day prune runs; exactly one audit row carrying `mode` and counts
  and no body/name; an empty purge still answers ok.
- **`tests/security/redaction.test.ts`** (the purge case) — was **vacuous three ways** and the
  skeptic was right about all three. (a) No backup file existed at purge time, so "the backups
  directory is clean" asserted over an empty directory: the test now stands in for the daily timer
  with an explicit `backupNow()` and *asserts the copy carries the sentinel before the purge*, so
  the check can never go hollow again. (b) Its line `expect(files.some(…) || true).toBe(true)`
  was a tautology; removed. (c) `filesToGrep` deliberately skips `app.db`, so in-DB survival was
  invisible; the test now queries `item_messages` / `proposals` / `actions` directly.
  Two further seams had to be fixed for the case to mean anything: the inbound fixture needs an
  explicit `ts` on the **virtual** clock (the fake bridge otherwise stamps from the wall clock,
  landing hours in the future and outside every window by accident), and the pending approvals
  must be rejected first, because retention only NULLs the payload of a **terminal** action
  (CONTRACTS 15.2 / `trg_actions_frozen`).
- **`src/main/db/__fixtures__/testDb.ts`** — added `fileRepos(dir)`, tracked by the existing
  `cleanup()` leak guard. No behaviour change to existing fixtures.

### Approval-first

Untouched. This path deletes local rows and local backup files; it sends no WhatsApp message and
writes no calendar event, so no approval record is in play. The daily timer
(`compose.ts:1318`, `runRetention({repos, settings, now})`, no `mode`) is unchanged and still
runs in `'daily'` mode. After the fix `repos.retention.purge` has exactly one product caller,
`runRetention` itself.

## Verification

- `npx vitest run src/main/ipc src/main/db tests/security` → **37 files, 784 tests, all green.**
- `npx eslint` over every file I touched → clean.
- `tsc -p tsconfig.node.json` and `-p tsconfig.web.json` → clean.

## Two pre-existing breakages OUTSIDE my surface — not mine, not fixed

Both are in files another fix group was mid-edit on when the weekly limit hit (mtimes
2026-09-23 18:05, same minute as the interruption). I am flagging rather than touching them,
since they belong to the `agent` and `bridge` groups:

1. **`src/main/agent/sanitize.test.ts:51` — repo-wide `npm run typecheck` is RED.**
   `error TS1161: Unterminated regular expression literal` (3 errors, all in this one file).
   A raw U+2028/U+2029 was written *literally* into the regex `/[\r\n  ]/u` on line 51 — the
   very line terminators the test is about — which physically splits the source line. The
   character needs to go back to an escape (`  `) inside the class.
   `tsconfig.tests.json` is the only project that fails; node and web are clean.
2. **`npm run lint` is RED** on two unrelated files: `src/main/agent/sanitize.ts:46`
   `'DECIMAL_DIGIT_RE' is assigned a value but never used`, and a stale unused
   eslint-disable directive at `src/main/bridge/ingest.ts:404` (warning, but `--max-warnings 0`).

Neither is caused by, nor blocks, the ipc fix; `src/main/ipc` and `tests/security` are green and
lint-clean on their own.

## Files touched

- `src/main/ipc/handlers/data.ts` (product)
- `src/main/ipc/handlers/data.test.ts`
- `tests/security/redaction.test.ts`
- `src/main/db/__fixtures__/testDb.ts`
