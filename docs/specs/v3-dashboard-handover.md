# v3 dashboard: dismiss X, schedule-only filter, week calendar, manual time — spec + implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (one fresh implementer per task, one fresh reviewer per task). Steps use `- [ ]` checkboxes. Planned by Fable 5.1 on 2026-10-18 from the user's request and the answers in §1; executed by Opus 5.5 workers. Ticket: T-904.

**Goal:** four user-requested dashboard changes — (1) an X that dismisses a card, (2) show only cards that are potentially a schedule, (3) a week calendar view beside the card view, (4) manual date/time entry followed by "Add to calendar" — without touching the approval invariants.

**Architecture:** all four are renderer features over data the dashboard already receives (`dashboard:get`), plus one additive field on the card view model (`intent`) and one previously unused IPC channel (`item:completeEvent`) getting a UI. No new write channel. Every calendar write still goes through `action:approve` with a per-action click and `shownHash` (I1'); the X uses the existing `item:dismiss`.

**Tech stack:** Electron 44, React 19, TypeScript, zustand store, i18next (`src/shared/locales/{en,he}.json`), Vitest + jsdom for renderer units, Playwright `_electron` for e2e (`tests/e2e`). Logical CSS only (`Dashboard.static.test.ts` guards it).

**Spec:** §1–§3 of this file. **Plan:** §4. Read both before starting a task.

---

## 1. Decisions already taken (user answers, 2026-10-18)

| # | Question | Decision |
|---|---|---|
| 1 | Calendar view content | **Calendar + side list.** Proposed / added events on a week calendar; undated cards (information missing, replies without an event) in a compact list beside it. Cards view stays, as a toggle. **No Google event reads** — the calendar shows only what the dashboard already knows. |
| 2 | Layout | **Week view** first (7 columns × hour rows). Month/agenda later, not in this plan. |
| 3 | X on a card | **Hide for now** = the existing dismiss (`item:dismiss`). Nothing sent or written; a later scheduling message from the chat produces a new card. Never "never analyse". |
| 4 | Non-schedule cards | **Filter, default on, remembered.** A header toggle "Show all (N hidden)" reveals the rest. Not a hard rule. |
| 5 | Manual time (orchestrator decision, approved in chat) | (a) proposed-event card: an "Edit time" button opens the existing `EventEditor` inline on the compact card; "Add to calendar" sends the edit in the same `action:approve` call the sheet uses. (b) information-missing card: the fill form gets a "Save time" submit wired to the existing `item:completeEvent`; the card then shows "Add to calendar" (two clicks: save, then add). |

## 2. Behaviour

### 2.1 Dismiss X (`dismiss-x-<itemId>`)
- Every **compact** card (all three lists, and the calendar side list) shows a small `×` button at the inline-end of the card header, `aria-label` = `t('action.dismiss')`. The expanded (sheet) card keeps its existing `sheet-dismiss-<id>`; no second X there.
- Click → `controller.dismiss()` (existing: `api.dismiss` → refresh → toast `action.dismissed` with Undo). Keyboard: the button is in the tab order; Enter/Space activates.
- Dismissing an in-calendar card never touches the Google event (already true of `item:dismiss`).

### 2.2 Schedule-only filter
- `ItemCard` (view model, `src/shared/types.ts`) gains `intent: Intent | null` — the current proposal's `extraction.intent`, `null` when there is no proposal yet.
- Renderer predicate `isScheduleRelated(card)`:
  `card.analysis !== 'done' || card.intent === null || SCHEDULE_INTENTS.has(card.intent) || card.event !== null || card.change !== null || card.eventState !== 'none' || card.badges.includes('manipulation')`
  with `SCHEDULE_INTENTS = {'schedule_request','reschedule','cancel','confirmation'}`. So: analysing / held / failed / raw cards stay visible; only a finished analysis with intent in {question, smalltalk, other}, nothing event-like and no `manipulation` badge is hidden. **[fix pass 2026-10-18]** A card that carries the manipulation badge always stays visible: it is a security signal the user should see.
- Store: `scheduleOnly: boolean` (default `true`), persisted in `localStorage` key `wca.dashboard.scheduleOnly` (same pattern as `store/settings.ts` `VOICE_INTENT_KEY`; wrap reads in try/catch, missing/invalid = default).
- Header control (`schedule-filter-toggle`): a quiet button in the dashboard header, left of the view switch. Label when on: `t('filter.showAll', { count })` = "Show all (N hidden)" where N = hidden cards across the three lists; when off: `t('filter.scheduleOnly')` = "Only schedules". Hidden when N = 0 and the filter is on (nothing to reveal) — **but** still rendered when the filter is off so the user can switch back.
- List counts: each column's `count-<key>` shows visible items; the "Showing the latest 20 of N" line is unchanged (it reasons about the server count).
- The open sheet is never filtered (opening by id must work for a hidden card from the Activity page).

### 2.3 Week calendar view
- Header view switch (`view-switch`, two toggle buttons `view-cards` / `view-calendar`, `aria-pressed`), persisted in `localStorage` key `wca.dashboard.view` (`'cards' | 'calendar'`, default `'cards'`).
- `CalendarWeek` (new file `src/renderer/src/components/CalendarWeek.tsx`) renders:
  - toolbar: `cal-prev`, `cal-today`, `cal-next`, and the range label `cal-range` (e.g. "12–18 Oct 2026", `Intl.DateTimeFormat` with the active language);
  - 7 day columns, first day = **Sunday** for `he`, otherwise the locale's `weekInfo.firstDay` if available, else Sunday; day header `cal-day-<yyyy-mm-dd>` with weekday + date (`Intl`), today's column gets `data-today="true"`;
  - hour rows 00–23 (`cal-hour-<h>`), each 48 px; the grid scrolls vertically and initially scrolls to 07:00;
  - one block per calendar entry (`cal-block-<itemId>`), positioned by start/end within its day column (`inset-block-start` / `block-size` in px; events spanning past 24:00 clip at 24:00; all-day = not possible, every entry has a time);
  - block content: time range (`tnum`), then the title in a `<bdi className="msg-text" dir="auto">` (title is untrusted text, like the card); the chat name is NOT shown on the block (space), it appears in the block's `title` attribute via `card.chat.displayName`-equivalent already used by `ItemCard`. **[fix pass 2026-10-18, superseded]** line 1 = start time only, line 2 = title, one line each with an ellipsis; the full range is the `title` attribute (trusted); the chat name is a visually hidden `<bdi className="msg-text sr-only" dir="auto">` inside the block (ux.md 16.5: untrusted text never in an attribute); overlapping blocks share the column width (ux.md 6.11);
  - block style by state: `proposed` / `change_proposed` → dashed outline, amber voice (`data-state="proposed"`); `created` / `updated` → solid (`data-state="in_calendar"`); `cancelled` / `declined` → struck-through, muted (`data-state="cancelled"`). Use existing token classes; no new colours;
  - click or Enter on a block → `onOpenItem(itemId)` (opens the existing sheet);
  - the `calendar.*` and `cal.*` locale keys listed in §2.5.
- Entries come from `selectCalendarEntries(lists)` (pure, in `src/renderer/src/store/calendarEntries.ts`): for each card in the three lists, after the schedule filter,
  - `change !== null` → one entry at `change.to` (start/end/title from `change.to`, state `change_proposed`);
  - else `event !== null && event.startLocal !== '' && event.endLocal !== ''` → one entry from `event` with state `card.eventState` (`none`/`incomplete` → skipped: undated);
  - cards with no entry are **undated** and go to the side list.
  - De-duplicate by `calendar.eventKey` the way `ItemList.dedupeByEvent` does for in-calendar cards (keep the newest `updatedAt`).
- Side list (`cal-undated`): the existing `ItemList` component, `list='needs_reply'`-style props but title `t('cal.undated')` and the undated cards; compact cards with the X and (for info-missing) the fill form of §2.4b. Rendered as a column at the inline-end of the grid from 900 px up; stacked under the grid below that.
- The `dashboard:changed` refresh path is unchanged; the calendar re-derives from the store.
- Limitation stated in the UI once: the first time the calendar view is opened, a one-line note under the toolbar `t('cal.scopeNote')` = "Shows the chats this app analysed, not your whole Google calendar." (dismissable, remembered in `localStorage` `wca.dashboard.calNoteSeen`).

### 2.4 Manual date/time → Add to calendar
**(a) Proposed event, compact card** (`eventState` in {proposed, change_proposed}):
- New quiet button `edit-event-<itemId>`, label `t('action.editTime')` = "Edit time", in the action row next to "Add to calendar". Click toggles an inline `EventEditor` (`mode='edit'`, or `'change'` for a change card — same `editorMode` logic the sheet uses) under the event line; the controller's `setEventEdit` / `setEventValidity` already carry the edit into `action:approve` `edit`. While the editor is open, "Add to calendar" is disabled until `eventValid`. `item:setEditing` is called exactly as the sheet does (so a refresh never overwrites the user's edit).
- No new IPC. The approval record stores the edited `startLocal/endLocal/title/location` (already true via `applyEdit` in `actionExecutor.ts`).

**(b) Information missing, compact card and sheet:**
- The existing `fill` editor gets a submit row: `save-event-<itemId>` label `t('action.saveTime')` = "Save time", enabled when `eventValid` and `startLocal`/`endLocal` are set. Click → `api.completeEvent({ itemId, event: EventEdit })` (`item:completeEvent`, already implemented: inserts a `provider:'user'` proposal, sets `eventState:'proposed'`, `missing: []`, creates a pending `create_event` action) → `applyItem(detail)` → toast `t('action.timeSaved')`.
- After save the card re-derives to Needs reply with "Add to calendar" primary; with the filter on it stays visible (intent unchanged, event present). In the calendar view it moves from the side list onto the grid.
- Errors map to the existing error toast (`CAL_UNAVAILABLE` → the existing calendar error text; `EVENT_INVALID` → `t('event.invalid')`).

### 2.5 Locale keys (add to BOTH `en.json` and `he.json`; `locales.test.ts` enforces parity, `i18n.usage.test.ts` enforces use)
```
filter.showAll        "Show all ({{count}} hidden)"       / "הצג הכל ({{count}} מוסתרים)"
filter.scheduleOnly   "Only schedules"                    / "רק פגישות"
view.cards            "Cards"                             / "כרטיסים"
view.calendar         "Calendar"                          / "יומן"
cal.prev              "Previous week"                     / "שבוע קודם"
cal.next              "Next week"                         / "שבוע הבא"
cal.today             "Today"                             / "היום"
cal.undated           "No date yet"                       / "עדיין בלי תאריך"
cal.scopeNote         "Shows the chats this app analysed, not your whole Google calendar." / "מציג את השיחות שהאפליקציה ניתחה, לא את כל יומן Google שלך."
cal.gotIt             "Got it"                            / "הבנתי"
cal.empty             "Nothing this week"                 / "אין כלום השבוע"
action.editTime       "Edit time"                         / "עריכת זמן"
action.saveTime       "Save time"                         / "שמירת זמן"
action.timeSaved      "Time saved. Add it to the calendar when ready." / "הזמן נשמר. אפשר להוסיף ליומן כשתרצה."
```
`action.dismiss` already exists and is reused for the X's `aria-label`.

## 3. Global constraints
- **I1'**: no send and no calendar write without a per-action user click; `action:approve` with `shownHash` is the only write path for events; `item:completeEvent` writes a *proposal*, never a calendar event.
- **I2'/I9**: no new read of Google events; the calendar derives from `DashboardData` only.
- UX 14.2's "no new component files" is **lifted for this plan** (spec amendment in Task 6); the renderer's other rules hold: logical CSS properties only (`Dashboard.static.test.ts`), no `settings:set` from components, untrusted text (titles, chat names, message text) only inside `<bdi className="msg-text" dir="auto">`, locale keys for every string (no literals), test ids as listed here.
- Hebrew + English; RTL verified by the e2e screenshot pass (Task 7).
- No secrets, phone numbers, chat ids or real message text in any committed file; e2e uses the synthetic `9725500000NN@s.whatsapp.net` jids and the stub LLM.
- Commits by the orchestrator only (noreply author); workers never commit or push. Workers write notes to `ops/agent-notes/<label>.md` only.
- Keep `npm run lint`, `typecheck`, `format:check` and `vitest run` green after every task; `test:e2e` after Task 7.

## Review focus (what the spec implies but no happy path tests)
1. A card whose `event.startLocal` is set but `endLocal` is `''` (incomplete proposals exist): must be **undated**, never a zero-height block. → Task 3 unit test.
2. An entry crossing midnight (22:30–01:00): block clipped at 24:00 in its start day, no second block, no exception. → Task 3 unit test.
3. Filter on, the only card is smalltalk: the column shows its normal empty state and the header shows "Show all (1 hidden)". → Task 2 unit test.
4. "Save time" with end ≤ start, or a date more than `LIMITS.eventHorizonMonths` ahead: the button stays disabled (editor validity), no IPC call. → Task 5 unit test.
5. Hebrew week: Sunday is the first column and the toolbar's prev/next arrows are mirrored (icons use logical direction, no `rotate`), and nothing scrolls horizontally at 420 px. → Task 7 e2e screenshot + assertion.

---

## 4. Plan

File map (create / modify):
- Modify `src/shared/types.ts` (ItemCard.intent), `src/main/agent/items.ts` (`cardOf`), `src/main/agent/items*.test.ts` (or `src/main/db/repos/repos.v2.test.ts` style — pick the existing items test file).
- Create `src/renderer/src/store/calendarEntries.ts` + `.test.ts` (pure selectors: `isScheduleRelated`, `selectCalendarEntries`, `weekOf`).
- Modify `src/renderer/src/store/dashboard.ts` + `dashboard.test.ts` (scheduleOnly, view, persistence).
- Create `src/renderer/src/components/CalendarWeek.tsx` + `CalendarWeek.test.tsx`.
- Modify `src/renderer/src/components/ItemCard.tsx` + `ItemCard.v3.test.tsx` (new test file: X, Edit time, Save time).
- Modify `src/renderer/src/views/Dashboard.tsx` + `Dashboard.v3.test.tsx` (new test file: filter toggle, view switch, side list).
- Modify `src/shared/locales/en.json`, `he.json`.
- Modify `docs/specs/ux.md` (§6.11 new, §14.2 amendment, §16 test ids), `docs/specs/v2-ux.md` (§3.8 pointer).
- Create `tests/e2e/dashboard-v3.spec.ts`; modify `tests/e2e/i18n-rtl.spec.ts` (screenshot the calendar view too).

### Task 1: `intent` on the card view model
**Files:** modify `src/shared/types.ts:1015-1046`, `src/main/agent/items.ts:419-470`; test: the existing items service test (find with `grep -ln "cardOf\|dashboard()" src/main/agent/*.test.ts`), add cases there.
**Interfaces:** produces `ItemCard.intent: Intent | null` (import `Intent` from the same file). `cardOf` sets `intent: proposal?.extraction?.intent ?? null` (check the proposal row's extraction field name in `src/main/db/repos/proposals.ts`; it is the parsed `Extraction` with `intent: z.enum(INTENTS)`).
- [ ] Write a failing test: a seeded item whose current proposal has `intent:'smalltalk'` → `dashboard().needsReply[0].intent === 'smalltalk'`; an item with no proposal → `intent === null`.
- [ ] Run it: `npx vitest run <that test file>` → FAIL (property missing).
- [ ] Add the field to `ItemCard` (with a one-line comment `[V3] current proposal's intent; null before analysis — the renderer's schedule-only filter reads it`) and set it in `cardOf`.
- [ ] `npm run typecheck` → every place that builds an `ItemCard` literal (tests' `defaultCard` in `tests/setup-renderer.ts`, fixtures) now needs `intent`; add `intent: 'schedule_request'` to `defaultCard` and `null`/a value where fixtures are built. Run the test → PASS; `npx vitest run src/main tests/setup-renderer.ts` → green.
- [ ] Note in `ops/agent-notes/v3-task1.md`; stop (orchestrator commits).

### Task 2: filter + view state in the store
**Files:** create `src/renderer/src/store/calendarEntries.ts`, `calendarEntries.test.ts`; modify `src/renderer/src/store/dashboard.ts`, `dashboard.test.ts`.
**Interfaces (produces):**
```ts
// calendarEntries.ts
export const SCHEDULE_INTENTS: ReadonlySet<Intent>;
export function isScheduleRelated(card: ItemCard): boolean;           // §2.2 predicate
export function hiddenCount(lists: DashboardStore['lists'], scheduleOnly: boolean): number;
export function visibleItems(items: ItemCard[], scheduleOnly: boolean): ItemCard[];
// dashboard.ts additions
scheduleOnly: boolean; setScheduleOnly(v: boolean): void;             // persisted 'wca.dashboard.scheduleOnly'
view: 'cards' | 'calendar'; setView(v: 'cards' | 'calendar'): void;   // persisted 'wca.dashboard.view'
calNoteSeen: boolean; setCalNoteSeen(): void;                          // persisted 'wca.dashboard.calNoteSeen'
```
- [ ] Failing tests (`calendarEntries.test.ts`): `isScheduleRelated` truth table — analysing card (`analysis:'queued'`) → true; `intent:null` → true; `smalltalk` with `event:null, change:null, eventState:'none'` → false; `smalltalk` with `event` set → true; `question` with `change` set → true; `confirmation` → true. `visibleItems` keeps order. `hiddenCount` with filter off → 0.
- [ ] Failing tests (`dashboard.test.ts`): defaults (`scheduleOnly true`, `view 'cards'`); `setView('calendar')` writes `localStorage['wca.dashboard.view']`; a store created with `localStorage['wca.dashboard.scheduleOnly']='false'` starts with `false`; garbage in storage → default; `localStorage` throwing (define a getter that throws) → defaults, no exception.
- [ ] Run → FAIL. Implement. Run → PASS. `npx vitest run src/renderer/src/store` green.
- [ ] Note in `ops/agent-notes/v3-task2.md`.

### Task 3: calendar entry selector
**Files:** modify `src/renderer/src/store/calendarEntries.ts` + test.
**Interfaces (produces):**
```ts
export interface CalendarEntry { itemId: ItemId; startMs: EpochMs; endMs: EpochMs; title: string; state: 'proposed' | 'change_proposed' | 'in_calendar' | 'cancelled'; eventKey: string | null; card: ItemCard }
export function selectCalendarEntries(lists: DashboardStore['lists'], scheduleOnly: boolean, timeZone: string): { entries: CalendarEntry[]; undated: ItemCard[] };
export function weekOf(anchorMs: EpochMs, firstDay: 0 | 1, timeZone: string): { startMs: EpochMs; days: EpochMs[] }; // 7 local-midnight starts
export function firstDayFor(lang: 'he' | 'en'): 0 | 1;                 // 'he' → 0 (Sunday); 'en' → Intl weekInfo.firstDay===1 ? 1 : 0
export function clipToDay(entry: CalendarEntry, dayStartMs: EpochMs): { topPx: number; heightPx: number } | null; // 48 px per hour, null if not on that day
```
`startMs` from `startLocal` + `timeZone` using the renderer's existing helper (`startMsOf` used in `ItemCard.tsx` — import from where it lives, do not duplicate).
- [ ] Failing tests: a proposed card → one entry `state:'proposed'`; a change card → entry at `change.to`, `state:'change_proposed'`; created → `in_calendar`; cancelled → `cancelled`; `endLocal:''` → undated (review focus 1); smalltalk filtered out when `scheduleOnly`; two in-calendar cards with the same `eventKey` → one entry (newest `updatedAt`); `clipToDay` for 22:30–01:00 on the start day → `{topPx: 22.5*48, heightPx: 1.5*48}` and `null` on the next day (review focus 2); `weekOf` with `firstDay 0` on a Wednesday → `days[0]` is the previous Sunday local midnight in `Asia/Jerusalem`; DST week (2026-10-25 is Israel's DST end — Sunday) → 7 days, each a local midnight.
- [ ] Run → FAIL. Implement. Run → PASS.
- [ ] Note in `ops/agent-notes/v3-task3.md`.

### Task 4: `CalendarWeek` component
**Files:** create `src/renderer/src/components/CalendarWeek.tsx`, `CalendarWeek.test.tsx`; locale keys `cal.*`, `view.*` from §2.5 in both JSON files.
**Interfaces:** consumes Task 3. Produces
```ts
export interface CalendarWeekProps { entries: CalendarEntry[]; anchorMs: EpochMs; onAnchorChange(ms: EpochMs): void; nowMs: EpochMs; lang: 'he' | 'en'; timeZone: string; onOpenItem(itemId: ItemId): void; noteSeen: boolean; onNoteSeen(): void }
export function CalendarWeek(props: CalendarWeekProps): JSX.Element;
```
Test ids per §2.3: `cal-prev`, `cal-today`, `cal-next`, `cal-range`, `cal-day-<yyyy-mm-dd>`, `cal-hour-<h>`, `cal-block-<itemId>`, `cal-note`, `cal-note-dismiss`, `cal-empty`.
- [ ] Failing tests (`render` + `userEvent`, `lang:'he'` and `'en'`): 7 `cal-day-*` ids starting on Sunday for `he`; today's column has `data-today`; a block renders with `inset-block-start: 1080px` for 22:30 and text "22:30–01:00" + the title inside `bdi.msg-text`; click → `onOpenItem(itemId)`; Enter on a focused block → same; `cal-next` → `onAnchorChange(anchor + 7 days)`; `cal-today` → `onAnchorChange(nowMs)`; no entries → `cal-empty`; `noteSeen:false` → `cal-note` shown, dismiss → `onNoteSeen()`; `data-state` attribute per state.
- [ ] Run → FAIL. Implement with logical CSS only (`inset-block-start`, `inline-size`, `margin-inline-*`); icons: reuse the existing Chevron/icon set (`src/renderer/src/components/icons*` — find it; the closed icon list in `docs/specs/v2-ux.md` §1.3 may need two new ids `chevron-start` / `chevron-end` if no suitable one exists — add them there).
- [ ] Run → PASS; `npx vitest run src/renderer/src/components/CalendarWeek.test.tsx src/renderer/src/i18n.usage.test.ts src/shared/locales` green.
- [ ] Note in `ops/agent-notes/v3-task4.md`.

### Task 5: card changes — X, Edit time, Save time
**Files:** modify `src/renderer/src/components/ItemCard.tsx` (controller ~L232-599, action row ~L1464-1592, header `<article>` ~L1244); create `ItemCard.v3.test.tsx`; locale keys `action.editTime`, `action.saveTime`, `action.timeSaved`; `src/renderer/src/api.ts` already wraps `completeEvent`.
**Interfaces:** consumes nothing new. Produces on the compact card: `dismiss-x-<id>`, `edit-event-<id>`, `save-event-<id>`; controller gains `inlineEditorOpen: boolean; toggleInlineEditor(): void; saveTime(): Promise<void>`.
- [ ] Failing tests: compact card renders `dismiss-x-<id>` with `aria-label` "Dismiss"; click → `item:dismiss` invoked once with `{itemId}` (use `mockInvoke`/`invokeMocks` from `tests/setup-renderer.ts`) and the toast key `action.dismissed`; expanded card has no `dismiss-x-*`. Proposed card: `edit-event-<id>` toggles `event-editor[data-mode=edit]`; changing `event-start` then clicking `approve-event-<id>` → `action:approve` called with `edit.startLocal` = the new value; invalid edit (end before start) → `approve-event-<id>` disabled. Info-missing card: `save-event-<id>` disabled until date+start+end filled; filled → `item:completeEvent` invoked with `{itemId, event:{title,startLocal,endLocal,location}}`, then `applyItem` with the returned detail and toast `action.timeSaved`; end ≤ start → stays disabled and no IPC (review focus 4); `CAL_UNAVAILABLE` result → error toast, card unchanged.
- [ ] Run → FAIL. Implement: the X is a 28×28 px quiet icon button at the header's inline-end (before the overflow menu), hidden in `mode='expanded'`; "Edit time" only when `eventState ∈ {proposed, change_proposed}` and `mode='compact'`; `setEditing(true)` when the inline editor opens (mirror the sheet's call), `false` on close; `save-event` row rendered under the `fill` editor in both modes.
- [ ] Run → PASS; `npx vitest run src/renderer/src/components` green (existing `ItemCard*.test.tsx` must still pass — the X must not shift existing test ids or tab order assertions; if a snapshot/order test breaks, fix the test only when the new order is intended).
- [ ] Note in `ops/agent-notes/v3-task5.md`.

### Task 6: dashboard wiring + specs
**Files:** modify `src/renderer/src/views/Dashboard.tsx` (header, L280-295 grid, F6 navigation L171-219), create `Dashboard.v3.test.tsx`; modify `docs/specs/ux.md` (add §6.11 "Schedule filter, view switch and week calendar" with §2.1–2.4 condensed; amend §14.2: new rows `CalendarWeek`, `ItemCard` props unchanged, note that v3 lifts the "no new component files" rule for `CalendarWeek.tsx`; §16: the new test ids) and `docs/specs/v2-ux.md` (§3.8 one-line pointer to ux.md §6.11); locale keys `filter.*`.
**Interfaces:** consumes Tasks 2–5.
- [ ] Failing tests: filter on + one smalltalk card → `list-needs_reply` shows its empty state and `schedule-filter-toggle` reads "Show all (1 hidden)" (review focus 3); click → the card appears and the button reads "Only schedules"; filter on + zero hidden → toggle absent; `view-calendar` click → `CalendarWeek` rendered (`cal-range` present), `view-cards` has `aria-pressed=false`, the three lists are not rendered, the side list `cal-undated` holds the info-missing card; reload with `localStorage['wca.dashboard.view']='calendar'` → calendar first paint; `openItemById` of a hidden card still opens the sheet; F6 cycles header → (calendar grid | columns) → footer.
- [ ] Run → FAIL. Implement: header row = `[schedule-filter-toggle] [view-switch]` placed where the existing header comment (L173-177) says the header region is; calendar layout = `grid-template-columns: 1fr 320px` from 900 px (reuse `useWideLayout`), stacked below. Pass `timeZone` from the settings store (`settings.general.timeZone`) and `lang` from i18n.
- [ ] Run → PASS; `npx vitest run src/renderer` green; `npm run lint && npm run typecheck && npm run format:check` green.
- [ ] Spec edits as listed. Note in `ops/agent-notes/v3-task6.md`.

### Task 7: e2e + screenshots
**Files:** create `tests/e2e/dashboard-v3.spec.ts`; modify `tests/e2e/i18n-rtl.spec.ts` (add the calendar view to the per-language screenshot loop, `test-results/screens/<lang>-calendar.png`). Use `seedProfile`, `attachBridge`, `bridge.deliver`, the stub LLM rules (`extraction()` in `tests/e2e/helpers/v2.ts`), `cardOfChat`, `cardIdsIn`, `actionsOfItem`, `query`.
- [ ] Spec 1 — X dismiss: deliver one scheduling inbound (`extraction({intent:'schedule_request', ...})`), wait for the card, click `dismiss-x-<id>` → card gone, toast with Undo, `items.closed_reason='dismissed'` in the DB, zero `create_event`/`send_reply` executed; click Undo → card back.
- [ ] Spec 2 — filter: deliver a smalltalk inbound and a scheduling one → only the scheduling card visible, toggle reads "Show all (1 hidden)"; click → both; relaunch on the same profile → the choice persisted.
- [ ] Spec 3 — calendar: switch to `view-calendar`, the proposed card's block `cal-block-<id>` is in the column of its date; click → sheet opens (`sheet-dismiss-<id>` visible); `cal-next` then `cal-today` returns; screenshot `test-results/screens/en-calendar.png`.
- [ ] Spec 4 — manual time: (a) proposed card: `edit-event-<id>`, set `event-start` to 17:00 / `event-end` 18:00, `approve-event-<id>` → exactly one `create-event` on the fake calendar with `start` 17:00 (read the fake's ledger as `approval-first.spec.ts` L153 does); (b) info-missing inbound (`extraction({intent:'schedule_request', missing:['date','time'], ...})`) → card in `info_missing`, fill `event-date`/`event-start`/`event-end`, `save-event-<id>` → card now in `needs_reply` with `approve-event-<id>`, `proposals.provider='user'` for the newest row; approve → exactly one `create-event`.
- [ ] Spec 5 — Hebrew: profile `settings:{language:'he'}`, calendar view: first `cal-day-*` is a Sunday, `document.documentElement.scrollWidth <= clientWidth` at 420 px, screenshot `he-calendar.png` (review focus 5).
- [ ] `npm run test:e2e` → all green (50 existing + new). Attach the four screenshots' paths in `ops/agent-notes/v3-task7.md`.

### Task 8 (orchestrator): review, proof, commit
- Fresh reviewer (Opus) on the whole diff against §2–§3; fix findings.
- `npm run lint && npm run typecheck && npm run format:check && npx vitest run` twice; `npm run test:e2e`; look at the four screenshots; `npm run build` + `electron-builder --win --x64` + `npm run test:defender`.
- Pre-push scans (CLAUDE.md), commit as `ilay1 <ilay1112@users.noreply.github.com>`, push; update `ops/PROGRESS.md`, `ops/BOARD.md` (T-904), `ops/DECISIONS.md` (D-085: schedule filter + week calendar from dashboard data only), swap `Desktop\win-unpacked` on request.
