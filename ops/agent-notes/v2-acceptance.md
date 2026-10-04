# v2-acceptance — agent notes (2026-10-04)

Role: final v2 acceptance marker (workflow 7, phase Accept). I edited only these files:
- `docs/ACCEPTANCE.md`: appended the section "v2 acceptance (marker `v2-acceptance`, 2026-10-04)". Every earlier section is untouched; the append starts at byte 29490.
- this note.
- `ops/agent-notes/v2-acceptance/`: raw logs of the gate run.

I fixed no product code and changed no test. Nothing was committed. Every tool I ran was a project script or the system node.exe / powershell.exe; I executed no vendor binary and contacted no external service.

## Gate run (real exit codes)

| Step | Exit | Result |
|---|---|---|
| lint | 0 | |
| typecheck | 0 | |
| format:check | 0 | |
| vitest, run 1 | 1 | 16 timeouts in 4 SQLite-heavy files |
| vitest, isolated re-run of those 4 files | 0 | 125/125 |
| vitest, full re-run 2 | 0 | 7522 passed, 1 expected-fail, 1 skip |
| test:e2e | 1 | 41/46 passed |
| test:smoke | 1 | checks 1/2/9 could not spawn: Smart App Control refuses the unsigned exe |
| audit:prod | 0 | |

## Verdict: NOT ACCEPTED as a release

The red e2e tests:
- `cli-connect` (7b) and (7c): quit-time pid-file leak. These are **new since reverify**.
- `cli-connect` (9): the same leak. Root cause: `jobRunner` has no shutdown latch.
- `cli-connect` (8): a stale soft assertion.
- `undo.spec:87`: the "In calendar" card is keyed by event, so after an undo it shows the stale time.

## Found and reproduced by me

`src/main/proc/reaper.ts` `PS_QUERY_ARGS`: the production query always fails. I ran the exact script string from `reaper.ts` against node's own pid: exit 1, empty stdout, "ConvertTo-Json : The input object cannot be bound". As a result, crash orphans are never reaped. This was first reported in `v2-fix-src-main-proc.md` and is not fixed.

## Not fixed after the review round (listed for the orchestrator)

- `auto-mode-8`: a paused trial goes to real writes on Resume.
- `editing-undo-5`: no UI for the correction offer.
- `cli-sandbox-5`: the agy-home folder is not purged.
- The `ux-i18n-v2` partials.
- `index.ts`: no `.catch` on `whenReady`, so a MigrationError produces no window.

## Points the user must not miss

- **FEATURE_GATES are all false and are source constants.** Automatic edits never happen in this build, voice and picture events never go automatic, and every picture proposal is amber. Changing this needs M-GOLDEN-1, then a code change and a rebuild.
- **Smart App Control is enforcing on this PC.** It already blocks the packaged exe in the smoke run, so the user's own first launch (M9) may be blocked too.
