# v2 adversarial design review - requirements coverage (agent notes)

Date: 2026-09-28. Scope: ARCHITECTURE-v2.md, v2-{contracts,pipeline,ux,tests,build-plan}.md, v2 research. Nothing edited except this file.

## Method
- Walked each v2 request line (ops/CONTEXT.md "v2 request") and D-036..D-040 through B1-B32, the pipeline, contracts and tests.
- Traced the edit chain item-by-item (findExistingEvent -> linked_item_id -> targetItemId -> pre-flight waItem check -> applyUpdateSuccess).
- Checked v1 S0 trigger rules (agent-pipeline.md 1.3) against the user's own reschedule example.
- Read `claude --help` of the installed 2.1.258 (no login use): --restricted, --tools "", --json-schema, --effort, --fallback-model, --strict-mcp-config exist; --max-turns absent from help (research already covers it as a hidden flag).
- Web check: Gemini CLI consumer/Pro login stopped 2026-06-18, Antigravity CLI is the consumer path (Google Developers Blog) - matches B14.

## Key findings (full list returned to orchestrator)
1. Second and later edits of the same event, and undo of any applied change, hit CAL_EVENT_FOREIGN: waItem tag stays the ORIGINAL item id, but after applyUpdateSuccess the event moves to the acting item, and the next delta/undo pins targetItemId to that acting item; pre-flight requires waItem === targetItemId.
2. from_me rows never trigger (v1 rule kept), so the user's literal example ("I rescheduled to 5pm") produces no edit unless the contact answers with text.
3. FEATURE_GATES all false => first release reads no pictures and makes no automatic edits; no owner/step to run the live golden sets.
4. Auto-mode MUSTs (media-derived never auto, cancels off, track record, 7-day unattended pause, 30-day expiry, user participation) narrow D-037 without a user decision.
5. One-editable-event-per-chat can edit the WRONG event (newest) when the contact refers to an older one, including automatically.
6. Rejecting a change (Keep 15:00) has no defined state and no re-proposal suppression; "Cancel event" after blocked_started has no IPC.
7. Voice V0 inside the TriageQueue: up to 4 x 600 s stalls of all triage per long note.
8. Smaller: I10 "starts in shadow" vs "Turn on now"; gates.ts shape differs between contracts and tests; no live v1-regression golden run for the new S1 schema; upstream PR = external action; wa_list_chats off by default vs D-040 "list".
