# W1-08-shared-utils — working notes

Package: date resolution, day table, reply language, bidi/format/language helpers.
Owned paths (build-plan §6): `src/shared/when.ts`, `src/shared/i18n/{languages,bidi,format}.ts`,
`src/main/agent/{resolve,dateTable,replyLang}.ts` + their colocated tests and `__fixtures__`.

Status: **done**. Every owned file implemented, no `NotImplementedError` left, lint/prettier/typecheck clean on owned
files, 165 colocated tests green, coverage 100 % lines / 99.4 % branches / 100 % functions over the owned sources.

---

## 1. What was built

| File | Exports added below the frozen signatures | Notes |
|---|---|---|
| `src/shared/when.ts` | `resolveWhen`, `buildDayTable`, `localToEpochMs`, `epochMsToLocal`, `todayIn`, `addMinutes` + **additive** `WEEKDAYS_EN`, `WEEKDAYS_HE` | pure, `Intl.DateTimeFormat` only |
| `src/shared/i18n/languages.ts` | `resolveLanguage`, `localeFor`, `dirFor` + **additive** `isUiLang` | verbatim from `i18n-rtl.md` 4.1 |
| `src/shared/i18n/bidi.ts` | `isolate`, `ltr`, `detectDir`, `detectLanguage` + **additive** `FSI`, `LRI`, `PDI` | |
| `src/shared/i18n/format.ts` | `makeFormatters`, `formatTime`, `formatDayLabel`, `formatTimeRange` + **additive** `DEFAULT_TIME_ZONE` | |
| `src/main/agent/resolve.ts` | `resolveExtraction` + **additive** `needsCalendarChangeBadge`, `closureFor` | see §3 |
| `src/main/agent/dateTable.ts` | `renderDayTable` | |
| `src/main/agent/replyLang.ts` | `detectReplyLang` | thin delegate to `bidi.detectLanguage` |

No frozen name or shape was changed. The additive exports are constants/helpers used by the implementations and the
tests; nothing in CONTRACTS §7 or `wave0-seams.md` §15 was touched.

Fixture: `src/main/agent/__fixtures__/resolve/pipeline11.json` — all 32 rows of PIPELINE §11 reduced to what S2
consumes/produces, driven by a table test in `resolve.test.ts` (build-plan acceptance for this package). Synthetic
content only; the six injection rows are carried as attack **data** for the app under test, never acted on.

## 2. Decisions that needed judgement (spec was silent or two parents disagreed)

1. **`timeAmbiguous` + an hour the model already shifted.** Golden `he-01` / `en-02` report `time24h:"17:00"` **and**
   `timeAmbiguous:true`, and still expect the amber `time_assumed` badge. A rule that only fires for hours 1–11 would
   drop the badge. Implemented: in `assume` mode, hours 1–7 get +12; the assumption is then recorded from the
   **resolved** hour (`>= 12` → `hour_assumed_pm`, else `hour_assumed_am`) whenever `timeAmbiguous` is set. In `ask`
   mode any `timeAmbiguous` time yields `missing += 'time'` and no start (the item goes to "Information missing").
2. **What makes a slot incomplete.** ARCH 6.3 says "missing non-empty ⇒ incomplete", but goldens `he-01` / `en-02`
   carry `missing:["duration","location"]` and are expected in **Needs reply**. PIPELINE 5.4 settles it: duration
   defaults silently. Implemented `BLOCKING_MISSING = ['date','time']` in `resolve.ts`; any `problems[]` entry also
   blocks completion (per the CONTRACTS §7 comment).
3. **Sub-state per intent.** `schedule_request` / `confirmation` → `complete | incomplete`. `question` / `smalltalk` /
   `other` → `none` (ARCH 6.3 "scheduling intent"). `cancel` → always `none`. `reschedule` → `incomplete` when a date
   resolved, else `none`. This is the only rule that reproduces `he-05` (incomplete) together with `en-05` / `he-10` /
   `en-06` (none), and it structurally guarantees v1 never proposes a `create_event` for a reschedule/cancel.
4. **`weekday_mismatch` without text.** ARCH/PIPELINE describe a regex over the sanitised trigger text, but both frozen
   signatures (`resolveWhen(x, ctx)`, `resolveExtraction(x, ctx)`) receive **no text**. Implemented the only check this
   seam can do: `dateKind === 'absolute'` and the model's `weekday` contradicts the weekday of `isoDate`. `weekday === 0`
   is skipped because the schema says "use 0 unless dateKind is weekday", so 0 cannot be told apart from "not filled".
   See REQUESTS below.
5. **DST.** `localToEpochMs` tries the offsets one day before and one day after the wall time. Ambiguous (autumn
   fall-back, Asia/Jerusalem 2026-10-25 01:00–01:59) → the **first** occurrence. Non-existent (spring gap,
   2026-03-27 02:00–02:59) → a minute-resolution binary search for the transition instant, i.e. the first valid instant
   after the gap = `2026-03-27T00:00Z` = 03:00 local, exactly as CONTRACTS §7 demands.
   `addMinutes` is deliberately **wall-clock only** (no zone), so an event that spans a transition keeps its stated
   duration on the clock; callers convert to instants themselves.
6. **`renderDayTable` output format.** The `wave0-seams.md` §15 JSDoc sketches `"2026-09-24 Thu חמישי"`, PIPELINE 4.2
   shows the real injected block (`  weekday=4 offset=0  2026-09-24  Thursday   יום חמישי  (day 3)`). Build-plan §0 says
   the parent wins, so PIPELINE 4.2's row shape is implemented (signature unchanged). The `today: …` header line is NOT
   produced here: it contains the IANA zone, which `renderDayTable(rows)` is not given — `agent/contextBuilder.ts`
   (W1-09) owns that line. Hebrew weekday names are fixed constants (`WEEKDAYS_HE`), never `Intl` output, so the prompt
   cannot drift with an ICU/CLDR upgrade.
7. **`formatDayLabel`.** `RelativeTimeFormat` is used only for −1/0/+1 days; CLDR 48 appends a dual "(2)" for Hebrew
   (i18n-rtl.md 8.1). 2–6 days → long weekday name; anything else → `dayShort`. A test sweeps ±14 days in both languages
   and asserts no `(\d+)` artefact.
8. **`formatTimeRange`** is built by hand with an ASCII hyphen and wrapped in FSI…PDI rather than using
   `Intl.formatRange` (the ICU en dash is a bidi neutral and reorders inside an RTL paragraph — i18n-rtl.md 6.4).

## 3. Additive helpers in `resolve.ts` (for W1-10)

The frozen `ResolvedSlot` has no field for the `change_in_google` badge or the `not_needed` closure, but the brief asks
this package to own both rules. They are exported as two pure predicates instead of widening the frozen shape:

- `needsCalendarChangeBadge(x): boolean` — `true` for `reschedule` / `cancel` (PIPELINE 5.6).
- `closureFor(x, slot): ClosedReason | null` — `'not_needed'` when `!needsReply && slot.state === 'none'` and no
  calendar-change badge is due.

Both are covered by the golden table test. W1-10 may use them or re-derive the same conditions; nothing depends on them.

## 4. Dead ends / rejected

- Using `Intl.DateTimeFormat.formatToParts` weekday names for the S1 table (rejected: locale-dependent, and the prompt
  must be byte-stable for prompt caching and for the I4 purity property test).
- `Intl.supportedValuesOf('timeZone')` validation of `ctx.timeZone` (rejected: the setting is app-validated upstream and
  a bad zone already throws from `Intl` with a clearer message).
- Collapsing repeated whitespace inside `title` / `location` (rejected: only line terminators must go, per
  `ProposedEventSchema`'s `SINGLE_LINE`; collapsing would silently rewrite user-visible text).
- Writing ` ` / `⁨` escapes in source: the Write tool decodes them into raw invisible characters. All such
  code points are now built with `String.fromCharCode(...)`, and a test asserts the isolate constants are the right
  code points. **Worth knowing for every other builder in this wave.**

## 5. Verification

```
eslint <14 owned files> --max-warnings 0          -> clean
prettier --check <owned files>                    -> clean
tsc --noEmit -p tsconfig.node.json                -> no error in any owned file
vitest run --project main <owned paths>           -> 165 passed, 0 failed
coverage over the 7 owned sources                 -> lines 100 %, branches 99.37 %, functions 100 %
  shared/when.ts (safety-critical, needs 100/95)  -> lines 100 %, branches 100 %, functions 100 %
  i18n/format.ts                                  -> branches 92.85 % (only the legacy `Intl.Locale#weekInfo`
                                                     accessor fallback, unreachable on Node 24)
```

`npx vitest run --project main` (whole project) is green except `src/main/proc/supervisor.test.ts`
("falls back to 20 s / 3 misses…", `ReferenceError: DEFAULT_PROBE_INTERVAL_MS is not defined`) — W1-01's file, mid-flight,
not caused by and not touched by this package.

`npm run typecheck` (tsconfig.node.json) also reports errors in files this package does not own; recorded, not fixed:

- `src/main/app/i18n.ts(23,17)` — i18next `init` overload (`lng` / `initImmediate`) — W1-12
- `src/main/app/protocol.ts(87,33)` — `Cannot find name 'BodyInit'` (needs a DOM-ish lib or a local type) — W1-12
- `src/main/llm/consent.ts(16,71)` — `ConsentKind` widened to include `'whatsapp_tos'` where only the cloud kinds are
  accepted — W1-12
- `src/main/testSeams.ts(120,17)` — implicit `any` parameter `id` — W1-12

## REQUESTS

- **W1-09-agent-guard / W1-10-agent-pipeline** — S1 prompt: "last Thursday" / "שבוע שעבר" style *past* weekday phrases
  must come back with `missing` containing `'date'`. `resolveWhen` receives no text by contract, so golden row `edge-01`
  (expects `incomplete` + `missing:['date']`) can only be reproduced if S1 flags it. The fixture row encodes that
  assumption explicitly.
- **W1-09-agent-guard** — `agent/contextBuilder.ts` owns the `today: <date> | <weekday-en> | <weekday-he> | <tz> | week
  starts Sunday` header and the `date table (choose a row only if …):` caption of PIPELINE 4.2; `renderDayTable(rows)`
  emits only the 14 indented day lines (no trailing newline). `WEEKDAYS_EN` / `WEEKDAYS_HE` are exported from
  `src/shared/when.ts` for the header's weekday names.
- **W1-10-agent-pipeline** — the S2 anchor must be the **trigger message timestamp** (PIPELINE 5.1), passed as
  `WhenContext.nowMs`; `resolveWhen` uses it for both "today" and the `in_past` check. Also: `ResolvedSlot.state`
  `complete` maps to `event_state='proposed'`, `incomplete` to `'incomplete'`, `none` to `'none'`; the `time_assumed`
  badge is due when `assumptions` contains `hour_assumed_pm` or `hour_assumed_am`.
- **W1-14-renderer-shell** — no new locale keys are needed from this package (it emits enum codes only), so no
  `src/shared/locales/pending/W1-08-shared-utils.json` fragment was created.
- **W1-12-shell-main** — the four typecheck errors listed in §5 are in your files.
- **W1-01-proc-health** — `src/main/proc/supervisor.test.ts` currently fails on an undefined
  `DEFAULT_PROBE_INTERVAL_MS`.

## BLOCKED-BY

None. This package has no runtime dependency on another package's Wave 0 stub.

---

## 6. Fix round (wave-1 audit follow-up)

### 6.1 GENUINE DEFECT — fixed

`src/shared/when.test.ts` had three unguarded index accesses that are errors under `tsconfig.tests.json`
(`noUncheckedIndexedAccess: true`), while `tsconfig.node.json` — the config this package originally verified against —
does not set that flag. That is why the file was reported clean in §5 and still broke repo-wide `npm run typecheck`
(and therefore `npm run verify`). Runtime was never affected: the file passed 45/45 in `--project main` before and after.

| Line | Before | After |
|---|---|---|
| 129 | `expect(rows[13].date)` | `expect(rows[13]?.date)` |
| 140 | `expect(buildDayTable(late, TZ, 1)[0].date)` | `expect(buildDayTable(late, TZ, 1)[0]?.date)` |
| 141 | `expect(buildDayTable(late, 'UTC', 1)[0].date)` | `expect(buildDayTable(late, 'UTC', 1)[0]?.date)` |

Optional chaining rather than `!`: the assertion still fails (with `undefined`) if the row is missing, so no coverage is
lost, and `@typescript-eslint/no-non-null-assertion` (on via `tseslint.configs.recommended`) stays satisfied.
`rows` is asserted `toHaveLength(14)` two lines earlier, so `rows[13]` being present is already proven by the test.

**Lesson for the wave:** verify owned test files with `tsc -p tsconfig.tests.json`, not only `tsconfig.node.json`.
`noUncheckedIndexedAccess` is set only in the tests config.

Verification after the fix (PATH-prefixed PowerShell/bash, project root):

```
npx tsc --noEmit -p tsconfig.tests.json                     -> clean (whole tests project)
npm run typecheck                                           -> only src/main/ipc/register.fixtures.ts(138,11)
                                                               TS2339 'settingsNotified' remains — W1-13's file
npx vitest run --project main <7 owned test files>          -> 7 files, 165 passed, 0 failed
npx eslint <owned files> --max-warnings 0                   -> clean
npx prettier --check <owned files>                          -> clean
```

The incoming requests from **W1-02-bridge-process** and **W1-06-llm-cloud** (both flagged exactly these three TS2532
errors and correctly declined to edit another package's file) are hereby **fulfilled**.

### 6.2 The W1-09 request is NOT fulfillable inside this package's owned paths

The audit lists "S1 prompt must emit `missing:['date']` for past-weekday phrases" as a request this package should
fulfil. It cannot be: `src/main/agent/prompt.ts` is **W1-09-agent-guard's** file per build-plan §6, and rule 10 forbids
edits outside owned paths. Re-checked this round — `prompt.ts` still has no past-tense rule (rule 5 covers `dateKind`,
rule 6 covers `missing`, neither mentions past phrasing).

Nothing in this package's seam can substitute for it. `resolveWhen(x, ctx)` and `resolveExtraction(x, ctx)` receive the
**Extraction object only, never the message text** (frozen in `wave0-seams.md` §15), and "let's meet last Thursday" and
"let's meet Thursday" produce byte-identical extractions unless S1 marks the difference. Weekday resolution is
forward-only by contract, so both would resolve to the next Thursday and come back `complete`.

The consuming side is already implemented and correct: `resolveExtraction` seeds its missing-set from `x.missing`
(`resolve.ts` line 202), so the moment S1 emits `missing:['date']`, golden row `edge-01` yields
`state:'incomplete', missing:['date','time']` — which is exactly what `__fixtures__/resolve/pipeline11.json` row
`edge-01` asserts today, and that table test is green. No red test exists on this side; the gap is live-model-only
behaviour that no unit test in this repo can observe.

## REQUESTS (fix round — supersedes the W1-09 bullet in §REQUESTS above)

- **W1-09-agent-guard — `src/main/agent/prompt.ts`, S1 (extraction) prompt.** Add one numbered rule so the past-weekday
  case reaches S2 flagged. Suggested wording, matching the style of rules 4-6 already in the file:

  > If the phrase refers to a weekday or date **in the past** ("last Thursday", "yesterday", "שבוע שעבר",
  > "ביום חמישי שעבר"), do not resolve it forward: keep the weekday you read, and add "date" to missing.

  An example pair in the few-shot block would make it stick, e.g. `"let's meet last Thursday"` ->
  `{"intent":"schedule_request", ..., "dateKind":"weekday","weekday":4, ..., "missing":["date","time","duration","location"], ...}`.
  PIPELINE §11 row `edge-01` (`expect.resolved = {eventState:"incomplete", missing:["date"]}`,
  note "past weekday -> not resolvable forward with confidence; ask") is the acceptance criterion.
  No change is needed on the W1-08 side once this lands.

- **W1-13-ipc-preload** — `src/main/ipc/register.fixtures.ts(138,11)`: `Property 'settingsNotified' does not exist on
  type 'Recorders'`. This is now the **only** error left in repo-wide `npm run typecheck`; it alone blocks
  `npm run verify`.

- The §5 requests to **W1-12-shell-main** (4 errors) and **W1-01-proc-health** (`DEFAULT_PROBE_INTERVAL_MS`) are
  resolved — those files typecheck and that suite passes as of this round.
