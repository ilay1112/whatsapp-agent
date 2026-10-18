# v3 Task 7 — e2e + screenshots (T-904)

Date: 2026-10-18. Scope: handover §4 Task 7. No `src/` file touched; no commit.

## Files
- NEW `tests/e2e/dashboard-v3.spec.ts` (6 tests; each uses its own profile, synthetic jids `97255000004N`, the stub LLM and the fake MCP calendar):
  1. X dismiss: `dismiss-x-<id>` removes the card; toast + `toast-undo` appear; `items.closed_reason='dismissed'`; no create_event/send_reply done; no create-event and no send. Undo brings the card back and `closed_reason` returns to NULL.
  2. Filter: a smalltalk card (`intent:'smalltalk'`, analysis `done`) is hidden. The toggle reads "Show all (1 hidden)"; clicking it shows both cards and the label becomes "Only schedules". After quit + relaunch on the same profile the filter is still off. Turning it back on hides the card again.
  3. Calendar: `view-calendar` (aria-pressed), the scope note, and one `data-today` column. `cal-next` until `cal-day-<WED>`, where WED = `anchorDate(2)` from the stub's pinned clock. The renderer's week starts at REAL now, so it takes 1–2 clicks. Checked: `cal-col-<WED>` contains `cal-block-<id>` (data-state proposed, 15:00, title = chat name), the block is drawn once, and the card is not in `cal-undated`. Clicking the block opens the sheet (`sheet-dismiss-<id>`). `cal-next` then `cal-today` restore the original `cal-range`. Nothing is written. `view-cards` switches back.
  4a. Edit time: `edit-event-<id>` opens `inline-editor-<id>`; start 15:00 → 17:00, end → 18:00; approve. Result: exactly one create-event with `${WED}T17:00` / `T18:00`.
  4b. Save time: `extraction({missing:['date','time'], dateKind:'none'})` puts the card in `info_missing`. `save-event` is disabled until date, start and end are filled (THU = anchorDate(3), 10:00–11:00). Saving shows the toast; the newest `proposals.provider='user'`; the card moves to `needs_reply` with `approve-event`. Zero creates before approval, exactly one after (`${THU}T10:00`).
  5. Hebrew: the first `cal-day-*` is a Sunday, before and after navigation. The `cal-prev`/`cal-next` svg computed transform is `matrix(-1, 0, 0, 1, 0, 0)` (icon-dir mirror, no rotate). At 420 px `scrollWidth - clientWidth <= 0`.
- MOD `tests/e2e/i18n-rtl.spec.ts`:
  - The per-language loop screenshots `calendar-${lang}`, then switches back to cards.
  - The Hebrew 420 px test switches to the calendar, asserts zero horizontal overflow, screenshots `calendar-he-420`, and switches back before the English check.
- The world helper `launchV3` mirrors `helpers/edit.ts` `launchEditWorld` but keeps the env so spec 2 can relaunch. It reuses `createTurn` / `editStubRules`.

## Screenshots (test-results/screens/)
- `en-calendar.png`, `he-calendar.png`, `he-calendar-420.png` (dashboard-v3: grid with the proposed block)
- `calendar-en.png`, `calendar-he.png`, `calendar-he-420.png` (i18n-rtl: empty week)

## Results
- `npm run -s build:e2e`: ok.
- `npx playwright test tests/e2e/dashboard-v3.spec.ts tests/e2e/i18n-rtl.spec.ts --reporter=line`: 12 passed (48 s). dashboard-v3 alone was re-run afterwards: 6 passed.
- No `fixme`.
- `npx prettier --check` on both files: clean. `npm run -s lint`: 0. `tsc -p tsconfig.tests.json`: no errors in either file.

## Observations for the orchestrator (UX, not failures)
- At 420 px in Hebrew the day headers truncate to "יום …", so the date number is not visible (`he-calendar-420.png`). Consider a narrow format (weekday narrow + day) below some width.
- A 60-minute block is 48 px tall. It shows the time range on two lines, so the title is clipped ("Meeting" is cut off in `en-calendar.png`).
