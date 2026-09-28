# Agent notes — v2-event-editing (research, D-036)

Date: 2026-09-28 (second pass after "Try again"; the 2026-09-27 draft was re-verified line by line and rewritten). Output: `docs/research/v2-event-editing.md`.

## What I did
- Read: pipeline spec (all 505 lines), ARCHITECTURE §5-7, agent/{extract,validate,items,resolve,contextBuilder,orchestrator,prompt}, exec/* (all seven), mcp/{readClient,writeClient,projection,host}, db/migrations + repos/actions, shared/{schemas,types,state,settings,ipc,when}, golden loader + harness header + fake MCP, DECISIONS D-036..D-041, CONTEXT "v2 request", calendar-mcp.md.
- Read the BUNDLED 2.6.3 server (`build/index.js`, 261,509 bytes) at the real line numbers: update-event schema (5092), handler (4074), patch call (4200), buildUpdateRequestBody (4013), registerSingleTool + schema.parse (5523-5537), get-event schema (4886), response envelope (2308), event formatter (2695), error mapping (1955-2040), annotations (5253-5280). Bundled zod is 4.6.5.
- Web-verified (2026-09-28): npm latest 2.6.3 (no newer); GitHub main registry.ts has no `status`/`showDeleted`; Google Events resource (`status` writable, cancelled = deleted, `get` always returns cancelled, restore note), events.patch, events.get, error-code guide.

## Key findings (blocking for the design)
1. Stock `update-event` cannot set `status`; unknown keys are silently stripped (non-strict zod at both the SDK and the server layer). D-036's "status cancelled" needs a 2-line vendored patch (+ sha256 pin + startup guard) or a soft-cancel fallback. Orchestrator decision needed (D-042 candidate).
2. Cancelled events are invisible to `list-events` (no `showDeleted`); `events.get` always returns them => add `get-event` (read class, executor/reconcile only, never in ToolGate).
3. `sendUpdates` is not even forwarded to `events.patch` on the single-event path in 2.6.3 — pin `'none'` anyway.
4. `items.event_state`, `items.closed_reason`, `actions.kind` are CHECK constraints => migration v4 is a table rebuild.
5. Update idempotency = absolute PATCH on a fixed id + `waUpdate=<chain root>` + `baseRevision` CAS (late clones become `superseded`, allowed from `unknown_outcome` by the trigger).

## Corrections vs the 2026-09-27 draft
- "events.get on a cancelled event" is now VERIFIED from Google's resource doc ("The get method always returns them"); restore-by-patch is documented as possible but the exact call stays UNVERIFIED.
- 410 `deleted` is NOT mapped by the server's 404 branch; it arrives as the generic "Google API error: ..." text — the projection regex must cover both.
- The fake MCP already lists `update-event` among the 13 real names; only a real handler is missing.
- Added the `baseRevision` ordering guard and the `superseded` resolution for stale unknown updates; added `approved_by` on actions for D-037.

## Assumptions
- Golden anchor stays 2026-09-21 Monday; existing-event fixture Wed 2026-09-23 15:00-16:00.
- One editable event per chat (the newest `in_calendar`); a second live event is out of scope for v2.
- The delta rides on the NEW open item ingest already creates, linked to the source item (option 2 of §3.1).

## Dead ends
- No upstream issue/PR about `status` on update-event was found by web search; an upstream PR is recommended.
- Google docs do not state the retention window of API-cancelled events; the design re-creates on failure.

## Hand-off
- No source files were touched. Ticket slicing in §6.1 of the research doc; T-401 can be closed by the rule in §4.4.
