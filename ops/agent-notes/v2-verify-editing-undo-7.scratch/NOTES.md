# v2-verify-editing-undo-7 (skeptic pass)
Verdict: CONFIRMED. Probe r8.test.ts (run: node node_modules/vitest/vitest.mjs run --config "ops/agent-notes/v2-verify-editing-undo-7.scratch/vitest.scratch.config.ts" --silent=false)
- A: Wed 09:00, event next Wed 15:00, cancel + weekday 3 offset 0 => delta reschedule to today 15:00 (manual only: AutoGate too_soon, earlier move < 24 h).
- B: Mon, event Thu next week, cancel + weekday 4 offset 0 => delta reschedule to THIS Thu 15:00 (7 days earlier, > 24 h lead, within moveMaxDays 14: auto-eligible when scope.edits is on).
- C: same as A but after 15:00 => unclear/sanity (R11 saves it).
Existing unit test resolveDelta.test.ts "event's own weekday named in a cancel" only covers the event in the CURRENT week.
