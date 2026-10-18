# T-905 — CLOUD_QUOTA row without the reset time (e2e cli-connect 7a soft check)

**Status:** fixed, not committed (2026-10-18) - see PROGRESS 81
**Owner:** orchestrator (Fable 5.1), single session
**Files:** `src/main/llm/cli/locator.ts` (peek), `src/main/llm/cli/locator.test.ts` (new unit test)

## Symptom
`tests/e2e/cli-connect.spec.ts` (7a) failed on `main` (74a18b5) on its soft check only: `connect-error-claude_cli` showed the
CLOUD_QUOTA row with the generic body ("New chats wait until this is fixed") instead of "continues by itself at HH:MM". Every hard
assertion passed (item held/budget, AppHealth.llm.code CLOUD_QUOTA, nothing sent). Suspected: seconds-vs-ms or a pause window
compared against the real clock (the app clock is pinned to a future Monday).

## Root cause (evidence: fake journal + main.log of a kept run, a throw-away spec with a `cli:changed` listener)
- The reset time was never dropped. Runner -> `CliRunResult.quota` (ms) -> `onCliQuota` -> `cliStatus.recordQuota` +
  `healthHub.setLlmQuota` all carried `resetsAt`; `AppHealth.llm.quota` and `cli:getStatus` both answered it.
- The run that hit the limit was the lazy **provider-start smoke** of the first chat (not an extract): the chat was then held by
  stage0 (`triage_no_provider` CLOUD_QUOTA) without any extract run.
- `llm:setProvider` probes the status (cliPrecondition -> cache filled) and then `providerFactory.invalidate()` ->
  `cliStatus.invalidate()` empties that cache. So when the smoke's quota arrived, `cliStatus.peek()` was null and `onCliQuota`
  pushed **no `cli:changed`** (the renderer's listener saw zero events).
- The renderer therefore learned the quota only from its own `cli:getStatus` on opening the card, which on an empty cache runs
  a full probe (`--version` + `auth status` = two node.exe spawns of the fake): ~2.1 s on this machine. The spec allows 2 s
  after the row appears. Not date-dependent: the margin was always thin; the probe got a little slower.
- In production the same gap shows the CLOUD_QUOTA row without the time while the AI settings are open, until the card re-mounts.

## Fix
`peek()` falls back to `lastKnown` (the last probed status, already kept for the closed path) and decorates it, so a quota or
smoke recorded while the cache is dropped is pushed at once. `get()` still re-probes (the cache really is dropped). Never staler
than what the renderer holds: the renderer only ever receives statuses from this recorder.

## Proof
- New unit test fails before / passes after the fix (`locator.test.ts` "peek() after invalidate() ...").
- `npx vitest run src/main/llm/cli src/renderer/src/components/ConnectCard.test.tsx`: 395/395.
- `npm run -s build:e2e && npx playwright test tests/e2e/cli-connect.spec.ts:269 --retries=0`: 1 passed (was 1 failed, 3/3 runs).
- typecheck + eslint clean on the two files. Full `cli-connect.spec.ts` run: see PROGRESS 81.
