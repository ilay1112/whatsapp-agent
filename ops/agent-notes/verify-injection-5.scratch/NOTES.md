# verify-injection-5 — skeptic pass on review finding `injection-5`

Verdict: **CONFIRMED** (code fact), severity corrected **minor -> major**.
Scope rule for this task: I edited nothing outside this scratch dir, so this note lives here
rather than at ops/agent-notes/<label>.md.

## What I ran
- `probe.test.ts` (V1-V5) and `probe2.test.ts` (V6), run with `vitest.scratch.config.ts`.
  7 assertions, all green. Not part of `npm test`.

## Facts established (not taken from the reviewer)
1. NFKC: `U+FF0E -> '.'`, `U+2024 -> '.'`, `U+FF61 -> U+3002`, `U+3002 -> U+3002`.
   So only the ideographic full stop (and the halfwidth form that folds into it) survives.
2. `sanitizeForModel` (sanitize.ts:28) masks `evil.com/x`, `evil．com/x`, `evil․com/x`;
   it does NOT mask `evil。com/x` / `evil｡com/x` -> `linkRemoved:false`, no `link_removed` badge.
3. `scrubDraft` (validate.ts:57) is WORSE than the finding says: it does no NFKC at all
   (only `stripInvisible`), so `U+FF0E` and `U+2024` also slip the OUTPUT gate, not just `U+3002`.
4. Nothing downstream closes it: `applyEdit` -> `stripInvisible`, `buildSendArgs` -> `stripInvisible`.
   `stripInvisible` leaves U+3002 untouched.
5. A scheme (`http://`) still forces a match regardless of separator; a `www。` prefix does not.

## Where the finding is wrong
- Proposed fix for sanitize.ts is partly redundant: NFKC already folds FF0E and 2024 there.
  The only new members needed are U+3002 and U+FF61.
- `exec/buildCreateEventArgs.ts:38` does NOT "share the ASCII-only assumption". Its regex needs a
  scheme or `www.`; it never stripped a bare `evil.com/x` either. Folding dots there changes nothing.
  (Separate, broader pre-existing gap — not this finding.)

## Why not a blocker
`ActionExecutor` still requires a pending action + an `approve` IPC call whose `shownHash` matches the
card the user saw. Approval-first (I1) is intact; no send or calendar write happens without a click.
