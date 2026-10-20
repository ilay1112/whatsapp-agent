# T-908 — v4: refresh button, sticky menus, theme switch, all calendars + manual event management

**Status:** done (2026-10-20) — see PROGRESS 84, D-089
**Owner:** orchestrator (plan, Fable 5.1) + Opus 5.5 workers (groups A–D)
**Spec + plan:** `docs/specs/v4-calendar-handover.md`

## Request (user, 2026-10-19)
1. Refresh button to read the latest messages and scan for calendar events.
2. All menus sticky (no movement when scrolling).
3. Dark / light mode switch.
4. Sync all events from all calendars of the Google account into the app, so the calendar view can manage calendars other than WhatsApp's.

Option-dialog answers: fetch the visible week on demand (no disk cache); **full management** (create / move / edit / delete, with attendees and recurring events refused — I9′); refresh also re-analyses chats active in the last 24 h. Design approved in chat; from now on every user decision goes through an option dialog.

## Decisions after build (option dialog, 2026-10-20)
- Keep both extra refusals: events created from a chat card and all-day events stay read-only in the calendar popover (chat events change through their card; all-day needs a date-only form later).

## Progress
- [x] A theme + sticky  - [x] B refresh  - [x] C calendar read + view  - [x] D manual management  - [x] docs + D-089  - [x] review (no blockers; 2 should-fix + nits -> fix pass)  - [x] proof + ship (vitest 8351 green; e2e 65/66, the one failure is the pre-existing cli-connect 7a; Defender clean)
