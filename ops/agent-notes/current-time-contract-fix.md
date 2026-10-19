# current-time-contract-fix (implementer, 2026-10-19)

## Root cause (given, confirmed in the vendored build)
`@cocal/google-calendar-mcp` 2.6.3 `GetCurrentTimeHandler` (build/index.js ~L4458) answers
`{"currentTime":"<wall clock>.mmm+HH:MM","timezone":"<IANA>","offset":"+HH:MM","isDST":bool,"dayOfWeek":"Monday"}` - lowercase
`timezone`. `projectCurrentTime` required `timeZone` -> `bad_response` -> sign-in smoke failed -> CAL_UNAVAILABLE on every real sign-in.
The fake emitted `timeZone`, hiding it.

## Changes
- `src/main/mcp/projection.ts` `projectCurrentTime`: accepts `timezone` or `timeZone`; both present and different -> BAD. `INSTANT_RE`
  already accepted `.mmm` + numeric offset, unchanged. Zone regex / finite-instant strictness unchanged.
- `projection.test.ts`: verbatim real answer -> `{nowIso:'2026-10-19T15:40:23.000Z', timeZone:'Asia/Jerusalem'}`; `Z` form; garbage zone,
  missing zone, non-string zone, conflicting keys -> BAD. Old camelCase tests kept.
- `tests/fakes/fake-mcp-calendar.ts` `shapes.currentTime`: real shape (wall clock in zone + offset, `Z` at offset 0, `timezone`, `offset`,
  `isDST`, `dayOfWeek`). isDST deliberately mirrors the server's `min(jan, jul)` comparison (it reports `false` for Israel summer time) -
  mirrored, not corrected. Only one test asserted the old shape (`host.test.ts` "passes the tool text ... untouched") - updated to `timezone`.
- `googleAuth.ts` `startSignIn()`: smoke retried up to `SIGN_IN_SMOKE_ATTEMPTS = 5` at `SIGN_IN_POLL_MS` for `bad_response`/`unavailable`/
  `timeout`; `auth`/`port_busy`/others fail immediately. Every failure logs `google.smoke_failed {kind, attempt}`; final code via `failSignIn`.
  Tests: 2 fails then ok; 5 fails -> CAL_UNAVAILABLE (5 logs); auth -> CAL_RECONNECT with 1 call.
- `host.ts` callerFor: tool-level `isError` that is not auth/port_busy logs `mcp.tool_error {tool, marker}` (first `MCP_STDERR_MARKERS`
  name via `stderrMarkersOf`, else `'other'`); text never logged. Test asserts the text is absent from the log calls.
- Docs: `docs/specs/contracts.md` (wire shape comment above `CurrentTimeProjection`; contracts.md had no explicit wire-response contract,
  only the projection type), `docs/specs/test-strategy.md` fake-behaviour row.

## Verification
- `npx vitest run src/main/mcp tests/security tests/integration/mcp* src/renderer/src/views/Onboarding`: 62 files / 1591 tests green
  (mcp-real-toolslist run separately: 10/10).
- typecheck, lint, format:check clean.
- Full suite: 1 failure `tests/security/gguf-download.test.ts` "resume after a dropped connection" - load flake, passes 3/3 in isolation
  and passes without these changes; unrelated.

## Notes / hand-off
- `docs/ARCHITECTURE.md` L226 and `docs/specs/agent-pipeline.md` L300 mention `{nowIso, timeZone}` - that is the projection, correct as is.
- Process slip: I ran `git stash` / `git stash pop` once to compare the flaky test on a clean tree; that also stashed and restored the
  orchestrator's uncommitted ops/ edits (BOARD, DECISIONS, PROGRESS, T-907 ticket untouched as untracked). Pop was clean; re-check if
  anything was written to those files at 18:5x.
- Not verified against a real Google account (by rule). The real server's smoke answer should now project; confirm on the next supervised sign-in.
