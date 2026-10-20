# v4-refresh (T-908 task group B / T3) — agent notes

Spec: `docs/specs/v4-calendar-handover.md` §2.1, §2.6 (refresh keys), review focus 3.

## Status
Done, test-first. `npx vitest run src/main/ipc src/main/bridge src/main/agent src/renderer/src/views/Dashboard* src/preload src/shared` green (87 files, 2486 tests; dashboard.test.ts now 15). `npm run typecheck` green. My files lint- and prettier-clean; at the time of writing the only lint/format failures in the tree were in group C's in-progress files (calendarEntries.test.ts unused import; calendarEvents*.ts, projection.v4.test.ts, readClient.v4.test.ts, fake-mcp-calendar.ts formatting).

## Contract
```ts
// src/shared/types.ts
export interface RefreshReport {
  newRows: number;            // IngestStats.kept of the awaited scan (0 if the scan threw)
  queued: number;             // chats THIS press newly put on the triage queue
  skippedRateLimited: number; // RATE_LIMIT_RETRIAGE / per-chat llm_chat budget used up
  skippedInCalendar: number;  // chat whose newest item is in_calendar (refused, like "Analyse again")
  calendarRefreshed: boolean; // invalidateCalendar was wired and did not throw
  cooldown: boolean;          // true = press inside 30 s; this is the previous press's report
}
```
- IPC `dashboard:refreshNow` (NoReq) → `RefreshReport`. Not focus-gated (it sends/writes nothing).
- Audit kind `refresh_now` added to `AUDIT_KINDS`: detail `{newRows, queued, skippedRateLimited}`, ref null.
- Calendar invalidation dep: **`invalidateCalendar?: () => void`** on `RefreshDeps` (src/main/ipc/handlers/dashboard.ts). Group C already wired it in compose: `invalidateCalendar: () => calendarEvents.invalidate()`.

## Files
- NEW `src/main/ipc/handlers/dashboard.ts` — `createRefreshService(deps)`, `createDashboardHandlers(refresh | undefined, log)`, `REFRESH_COOLDOWN_MS = 30_000`, `REFRESH_CHAT_CAP = 20`. Unwired service ⇒ INTERNAL (fail closed).
- NEW `src/main/ipc/handlers/dashboard.test.ts` (real in-memory DB + virtual clock + fake `{scanNow}` + retriage spy; 14 tests).
- NEW `src/renderer/src/components/RefreshButton.tsx`, NEW `src/renderer/src/views/Dashboard.v4.test.tsx` (4 tests).
- Edited (minimal insertions): `src/shared/ipc.ts` (2 lines), `src/shared/types.ts` (RefreshReport + audit kind), `src/shared/ipc.test.ts` (channel count → 79, includes group C's two), `src/preload/index.ts` (allow-list), `src/main/ipc/register.handlers.ts` (`IpcHandlersExtV2.refresh?` + group), `src/main/ipc/register.test.ts` (VALID entry), `tests/setup-renderer.ts` (IPC_DEFAULTS entry), `src/main/compose.ts` (import + group), `src/renderer/src/api.ts` (`api.refreshNow`), `Dashboard.tsx` (one import line + `<RefreshButton />` first in `dash-toolbar`), `en.json`/`he.json` (`refresh.*` group after `view`).
- `ingest.ts` and `queue.ts`: **no change needed** — `Ingest.scanNow()` is already public, serialised and returns the awaited scan's stats.

## Behaviour (main)
1. `await ingest.scanNow()`; a throw is logged (`refresh_scan_failed`, error name only) and the press continues with `newRows: 0`.
2. Chats with `MAX(last_inbound_ts, last_outbound_ts) >= now - LIMITS.syncMaxAgeMs`, `policy <> 'never'`, newest first, LIMIT 20.
3. Global guard: once `llm_global` (last hour) + queued so far reaches 60, remaining chats count as skippedRateLimited. Per chat — open item: skipped (not counted) if held for `unknown_sender`/`paused`, analysis already `queued`/`running`, or edit-locked; otherwise `ItemService.retriage` (ok → queued, RATE_LIMIT_RETRIAGE → skippedRateLimited). No open item: newest item `in_calendar` → skippedInCalendar; per-chat `llm_chat` ≥ 6/h → skippedRateLimited; else `repos.queue.enqueue` → queued. One `queue.poke()` if anything was queued.
4. `invalidateCalendar()` (try/catch), `notifyChanged(touchedItemIds)` (always → `dashboard:changed`), audit, log.
5. Cooldown: second press while in flight shares the run (`cooldown: true`); inside 30 s of the start returns the last report with `cooldown: true` (no scan, no queueing, no audit).

## Renderer
`RefreshButton` (`refresh-now`): disabled + `aria-busy` + `refresh-spinner` (motion-safe) + "Refreshing…" while pending; result in its own `role="status"` line `refresh-toast` (auto-hide 6 s): `refresh.done {newRows, queued, skipped = skippedRateLimited + skippedInCalendar}`, `refresh.cooldown`, or `errors.<code>.title`.

## Deviations / open questions for the orchestrator
- **Toast:** the global toast (`store/dashboard.ts` `toast: {key, ...}`, rendered in `App.tsx` as `t(toast.key)`) has no interpolation params and both files belong to others, so the result is an inline status next to the button. To use the global toast instead: add `params?: Record<string, number>` to the toast type and render `t(toast.key, toast.params)` in App.tsx, then call `setToast` from RefreshButton.
- **No-open-item chats are a doorbell only:** `orchestrator.runChat` returns immediately when the chat has no open item, so enqueueing such a chat (spec text) runs no analysis today; it still counts in `queued` ("what the queue accepted"). Making it re-analyse would need an item to be created — a behaviour change I did not make.
- **Global budget:** spec says stage 0 enforces `llm_global`, but the retriage path never passes stage 0 (only `stage0.ts:134` reads `llm_global`). Refresh therefore applies it itself: `llm_global` runs in the last hour + chats queued by this press < `LIMITS.llmRunsGlobalPerHour` (60), the rest count as `skippedRateLimited` (tested). The CLI `maxRunsPerHour` is not checked here (left to the CLI runner).
- Held `unknown_sender` / `paused` items are deliberately NOT released by a bulk refresh (user-gated); `waiting_llm` / `budget` / failed ones are retriaged.

## Follow-up (coordinator, 2026-10-19): deviation 2 closed — no-open-item chats are really re-analysed
- NEW `Ingest.reanalyseChat?(chatId) → { outcome: 'queued' | 'held' | 'nothing'; itemId }` in `src/main/bridge/ingest.ts` (optional on the interface so v1-shaped doubles stay assignable). It reuses ingest's own `handleInbound` (Stage 0, backlog gate, unknown-sender / paused holds, `createOpen`, `triggerKindOf`, `supersedePendingRepliesOfChat`, queue row) in one transaction for the chat's newest trigger-eligible row (same "newest row decides" rule as `handleChat`). `nothing` when: an open item exists, no eligible row, the newest eligible row is the user's own (answered), its ts is null or older than `LIMITS.syncMaxAgeMs`, or Stage 0 makes no item (policy 'never'). It does not notify; refresh pushes `dashboard:changed` with the returned item id.
- A dismissed / closed item does not block it: a NEW item is created for the newest row.
- `RefreshReport` gains **`skippedNothingToAnalyse: number`** (unchanged chats: nothing to analyse, already queued/running, user-gated hold, edit-locked, other retriage refusals). `queued` = open item re-queued or new item created — a new item HELD by Stage 0 (unknown sender / paused) counts as `queued` too (literal reading of "created"); say if it should count as unchanged instead.
- `refresh.done` now ends with ", {{nothing}} unchanged" / ", {{nothing}} ללא שינוי".
- The per-chat budget check still runs before `reanalyseChat` (no budget-held cards from a refresh); the global budget guard counts every created item.
- Tests: `src/main/bridge/ingest.reanalyse.test.ts` (8: closed chat → one new queued item + queue row with trigger = newest row; voice trigger kind; > 24 h → nothing; dismissed → new item; policy never → nothing; unknown sender → held; own row newest → nothing; open item / unknown id → nothing); `dashboard.test.ts` now 18; `Dashboard.v4.test.tsx` checks "…, 4 unchanged".
- Run: the vitest set (89 files, 2505 passed; one `launcher.test.ts` timing test failed once in the full run and passes alone, unrelated). `tsc -p tsconfig.node.json` green; web/tests projects fail only in group C's in-progress `CalendarWeek.tsx` / `calendarView.ts`. My files are lint- and prettier-clean.
