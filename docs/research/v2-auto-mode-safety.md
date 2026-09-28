# v2 research: AUTOMATIC MODE safety (D-037) - compensating controls when the click is gone

Status: research output, 2026-09-27; **revised 2026-09-28** (re-run: aligned with `docs/research/v2-event-editing.md` on linked items / `event_revisions` / the private-tag map, Electron backport facts corrected, Q1 and Q4 resolved from primary sources, Q5 narrowed by `v2-claude-cli-backend.md`, media-derived proposals added to the never-auto list). Author: research agent "v2-auto-mode-safety".
Inputs read: `docs/research/security-threat-model.md`, `docs/ARCHITECTURE.md` section 2 (I1-I7) + 5.4 + 6.6, `src/main/exec/actionExecutor.ts`, `src/main/exec/rateLimiter.ts`, `src/main/exec/buildCreateEventArgs.ts`, `src/main/mcp/writeClient.ts`, `src/main/mcp/readClient.ts`, `src/main/agent/toolGate.ts`, `src/main/agent/validate.ts`, `src/shared/{settings,schemas,types,ipc}.ts`, `src/main/db/migrations.ts`, `src/main/ipc/handlers/settings.ts`, `ops/DECISIONS.md` D-036..D-041, `ops/CONTEXT.md` "v2 request".
Conventions: **MUST** = release blocker for auto mode (auto mode ships OFF and stays unreachable until every MUST is green). **SHOULD** = strongly recommended. **UNVERIFIED** = not confirmed from a primary source.

Locked decisions this document does NOT relitigate: D-036 (delta proposals, `update-event` only from the executor, cancel = status cancelled, never `delete-event`), D-037 (auto mode toggle OFF by default, calendar add + edit only, replies always drafts), D-038 (vendor CLI as headless completion backend, ToolGate + executor kept), D-040 (read-only WhatsApp MCP).

---

## 0. Executive summary

1. **What auto mode really is.** In v1 the app satisfied all three legs of Meta's "Agents Rule of Two" (untrusted input, private data, state change) and was allowed to because every state change waited for a human click [S1][S2]. Auto mode removes the click for one class of state change (calendar add/edit). Per the Rule of Two that is exactly the configuration that "should not be permitted to operate autonomously" without "another reliable means of validation" [S1]. The compensating controls below ARE that other means: they must be deterministic, enforced in code and the DB, and they must shrink the blast radius until an attacker-caused calendar write is (a) bounded, (b) visible within minutes, (c) undoable in one click, and (d) never able to reach anybody but the user.
2. **The residual attack, stated honestly.** With every control below in place, a contact the user has already written to can still, through a message, cause the app to add or move an event on the user's own calendar, inside the next 30 days, with an app-templated description, no attendees, no links, on a calendar the user owns, at most a few times a day, with a toast and an UNDO button. That is the accepted residual of D-037. Anything wider (attendees, other calendars, other people's events, deletes, replies, settings) stays impossible by construction.
3. **Three findings that change the plan.**
   - **(F1) `update-event` in `@cocal/google-calendar-mcp@2.6.3` has no `status` argument** and its handler calls `events.patch` without `If-Match` [S10][S11][S12]. "Cancel = update with status cancelled" (D-036) and "UNDO of an auto-create" are therefore not implementable through the pinned server as-is. Options in section 8.3 (vendored patch adding `status` + `If-Match` is the recommendation). Google's own Calendar MCP (`calendarmcp.googleapis.com`, Developer Preview) has no `status` either [S13].
   - **(F2) `update-event` defaults `sendUpdates` to `"all"`** in the server schema [S10] - an auto edit of an event that somehow had attendees would e-mail people. The write client must pin `sendUpdates:'none'` on updates exactly as it does on creates, and the auto gate must refuse any event whose fetched copy has `attendees`.
   - **(F3) Electron 44.4.3 (the pinned version, `package.json`) supports toast action buttons on Windows**: PR #48132 was merged 2026-02-12, auto-backported to `40-x-y` and `41-x-y` (38/39 needed manual backports) and is listed in the v42.0.0 release notes, so every later line has it [S17][S18]. A one-click UNDO on the notification itself is therefore feasible. The v1 rule "no approval from toasts" stays; UNDO is the fail-safe direction and is allowed from a toast, but only via an id main stored when it created the toast.
4. **Shape of the answer.** I1 becomes "no side effect without a per-action user click OR an auto-mode decision record that references a live, user-confirmed policy record", enforced by a DB trigger, not by an `if`. The auto path re-uses `ActionExecutor` unchanged from the write-ahead onward; the only new code before it is a pure, LLM-free `AutoGate` that must return an *allow* decision with an exhaustive reason enum, and the new code after it is a snapshot-then-patch-then-verify update path with an `auto_writes` undo ledger. ToolGate does not change: the model still gets READ tools only, and the model is never told that auto mode exists.

---

## 1. Threat delta: what reopens when the click is removed

v1 threat register entries (security-threat-model.md section 10) re-examined for auto mode. R1 = any contact who can DM the user; R2 = anyone who can put an event on the user's calendar.

| ID | v1 threat | v1 control that neutralised it | Status under auto mode | Compensating control (section) |
|---|---|---|---|---|
| T1 | "delete all events" | no write tools in loop; `delete-event` not enabled | unchanged: `delete-event` stays disabled; `update-event` reachable only from the executor, and only for app-tagged events | 4.7, 8.2 |
| T3 | exfil via attendees / description | schema has no attendee field; app-template description | unchanged by construction; **F2** adds: refuse edits to any event whose fetched copy has attendees | 4.3, 4.4 |
| T5 | injection via calendar titles | freebusy only, projection | unchanged (auto mode adds `get-event` reads but they are app-side, never shown to a model) | 8.2 |
| T13 | bidi/invisible spoofing of the card | app-rendered card | **reopens**: nobody reads the card before the write. Title/location still go through `cleanField` + `stripInvisible`; the residual is a misleading title in the user's calendar until UNDO | 6 (notification + audit), 4.4 |
| T22 | social engineering of the user through the dashboard | inert bubbles | **new variant**: a contact schedules a fake "meeting with your bank" to lend credibility to a later phishing message. Bounded by: known contacts only, app-template description, no links, toast + UNDO | 5.3, 6 |
| **N1 (new)** | **Calendar spam / DoS**: a known contact sends 50 messages each naming a different time | none (every event needed a click) | per-chat and global auto budgets far below manual budgets; circuit breaker pauses auto mode | 4.8, 7.3 |
| **N2 (new)** | **Reschedule attack**: contact says "moved to Friday" about a real appointment; user misses it | none (update did not exist) | edits only for events this app created from the SAME chat + same item; max 2 auto edits per event; no auto edit within 2 h of start or moving start by > 14 days; user-modified-in-Google events never auto-edited; UNDO with stored previous version | 4.7, 8.2, 6.2 |
| **N3 (new)** | **Silent cancellation**: contact says "cancel", event disappears | none | auto-cancel is a separate sub-scope, OFF by default; cancel is `status:'cancelled'` (restorable on the organizer's calendar [S9]), never delete | 4.7, 3.2 |
| **N4 (new)** | **Settings-toggle attack**: renderer XSS / focus-steal / injected UI text flips auto mode on | n/a (toggle did not exist) | dedicated IPC channel + focused-window check + native modal dialog owned by main + policy record with expiry | 3 |
| **N5 (new)** | **Persistence**: attacker keeps the app in auto mode while the user is away | n/a | policy expiry, unattended pause, shadow period, per-chat taint cooldown | 3.4, 5.4, 7 |
| **N6 (new)** | **Cross-item edit**: a delta proposal references someone else's event id | n/a | the model never outputs an event id; the delta lives on a NEW item linked to the source item (`items.linked_item_id`, app-computed, v2-event-editing.md section 3.2) and resolves through the SOURCE item's `calendar_event_id` in the same chat only; the fetched event must carry `waAgent=1` + `waItem` = source item id + `creator.self` | 4.7, 8.2 |
| **N7 (new)** | **CLI backend side effects (D-038)**: the vendor CLI can run shell/tools on its own | n/a | out of this document's scope but a precondition for I1': the CLI must be launched with its own tools disabled and only the app-hosted read-only MCP attached (pointer for the D-038 research agent) | 2 |

Research consensus used throughout: autonomy must scale inversely with blast radius - "a read is free, a reversible write can auto-execute with an audit entry, and an irreversible destructive action blocks until a human approves" [S4]; "let an agent do anything it can undo" [S5]; keep "a durable, append-only log written before execution" with the intended compensation [S6]; OWASP AI Agent Security Cheat Sheet: "Auto-approve low-risk actions", "Bind approval to the exact action", "Allow users to interrupt and rollback agent operations", "make high-impact actions idempotent", "Log structured decision metadata for high-risk actions" [S7]; OWASP Top 10 for Agentic Applications 2026: ASI01 Agent Goal Hijack, ASI02 Tool Misuse, ASI08 Cascading Failures, ASI09 Human-Agent Trust Exploitation [S3]; "informed abstention" - a pause that "names what is missing, and routes to a concrete recovery action" [S8] (our recovery action = the existing approval card).

---

## 2. Invariant changes

| # | v1 text | v2 text (auto mode) | Enforced by |
|---|---|---|---|
| **I1** | No WhatsApp send and no calendar write without a per-action user click | **No WhatsApp send without a per-action user click. No calendar write without EITHER a per-action user click OR an `auto_decisions` row that (a) belongs to this action, (b) references an `auto_policies` row in state `on` at decision time, (c) was produced by `AutoGate` inside the executor, and (d) is stored before the write-ahead.** | `trg_actions_state` extended (section 8.1): `approved` requires `approved_by`; `approved_by <> 'user'` requires a matching `auto_decisions` row joined to a live policy. Import-graph test: `exec/autoGate.ts` imports no `agent/**`, no `llm/**`. |
| **I2** | LLM reaches only READ calendar tools with app-pinned args | unchanged. Additionally: **the model is never told auto mode exists** (no prompt interpolation, no tool description, no badge text fed back), so an attacker cannot tailor a message to it. | prompt-purity property test extended with `settings.auto.*` as an input that must not change the prompt bytes. |
| I3 | recipient pinned | unchanged (replies are never automatic, D-037) | - |
| I4 | untrusted text never in system prompt / tool defs | unchanged | - |
| I5 | one chat per context | unchanged; **plus**: an auto edit may target only an event whose `waItem` (= the SOURCE item that created it) belongs to the same `chat_id` as the triggering (linked) item | `AutoGate` + `get-event` ownership check |
| I6 | bridge isolation | unchanged | - |
| I7 | crash never duplicates a side effect | unchanged; extended to updates: the update path is write-ahead + `get-event` verify; an `executing` update found at startup becomes `unknown_outcome` and is reconciled by comparing the event's `updated`/`sequence` with the stored snapshot, never re-patched blindly | section 8.2, crash tests |
| **I8 (new)** | **Every automatic write is reversible by one user click for at least the undo window, and the pre-write state needed to reverse it is stored BEFORE the write.** | `auto_writes` row (with `pre_json` for edits) inserted in the same transaction as the write-ahead; on success linked to the `event_revisions` row; UNDO = the editing design's `item:undoChange` (a pending `update_event` with `revertOf`), approved by `user` / `user_toast` |
| **I9 (new)** | **The app never writes to a calendar event it did not create, and never to an event outside the user's own calendar.** | `create-event` only with `extendedProperties.private.waAgent='1'`; `update-event` only after `get-event` shows `waAgent='1'`, `waItem` = the source item id (`items.linked_item_id` chain), `creator.self === true` (or `organizer.self === true`), no `attendees`, `status !== 'cancelled'`; `calendarId` = settings `targetCalendarId` whose `accessRole` is exactly `'owner'` in the last `list-calendars` result (the server does return `accessRole`; v1's `projectCalendars` collapses it to `writable` with a permissive `null => true` default that the auto path must NOT inherit, section 4.1) |
| **I10 (new)** | **Auto mode can be enabled only by a user gesture in a focused window confirmed in a native (main-process) modal dialog, is recorded as a policy row with an expiry, and can be disabled from anywhere with one click.** | section 3 |

---

## 3. The policy record and how the toggle is protected

### 3.1 Why a record, not a boolean

A boolean in `settings.value_json` can be flipped by any bug in `settings:set`, by a renderer compromise, or by a future "restore settings" feature. A policy **row** with an id, an expiry, a confirmation method and a settings snapshot is (a) referenceable from every automatic action (audit binding, OWASP "approval identifier ... policy version" [S7]), (b) self-expiring, (c) invalidated automatically when what it was granted for changes.

### 3.2 Schema (SQLite, `src/main/db/migrations.ts`; zod in `src/shared/autoPolicy.ts`)

```sql
CREATE TABLE auto_policies (
  id            TEXT PRIMARY KEY,                 -- uuid
  state         TEXT NOT NULL CHECK(state IN ('shadow','on','paused','disabled','expired')),
  enabled_at    INTEGER NOT NULL,                 -- epoch ms
  expires_at    INTEGER NOT NULL,                 -- enabled_at + scope.validityDays
  shadow_until  INTEGER NOT NULL,                 -- enabled_at + 24 h by default ; = enabled_at when the user chose "enable now"
  confirmed_by  TEXT NOT NULL CHECK(confirmed_by IN ('native_dialog')),   -- the only method that exists
  confirm_json  TEXT NOT NULL,                    -- {dialogResponse:1, checkboxChecked:true, windowFocused:true, appVersion, electronVersion}
  scope_json    TEXT NOT NULL,                    -- AutoScope below, validated with zod .strict() on read AND write
  snapshot_sha  TEXT NOT NULL CHECK(length(snapshot_sha)=64),  -- sha256 of {targetCalendarId, googleAccountEmailSha8, provider, appMajor}
  paused_reason TEXT CHECK(paused_reason IS NULL OR paused_reason IN
                  ('user','circuit_breaker_rate','circuit_breaker_undo','circuit_breaker_unknown','unattended','calendar_disconnected','snapshot_changed')),
  disabled_at   INTEGER, disabled_reason TEXT
);
-- exactly one policy may be live
CREATE UNIQUE INDEX ux_auto_policies_live ON auto_policies(state) WHERE state IN ('shadow','on','paused');

CREATE TABLE auto_decisions (
  id          TEXT PRIMARY KEY,                   -- uuid ; referenced by actions.approved_by
  policy_id   TEXT NOT NULL REFERENCES auto_policies(id),
  action_id   TEXT NOT NULL UNIQUE REFERENCES actions(id) ON DELETE CASCADE,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  chat_id     INTEGER NOT NULL REFERENCES chats(id),
  kind        TEXT NOT NULL CHECK(kind IN ('create','update','cancel')),
  verdict     TEXT NOT NULL CHECK(verdict IN ('auto','shadow','fallback')),
  reason      TEXT NOT NULL,                      -- AutoReason enum (section 5.5) ; 'ok' for auto/shadow
  checks_json TEXT NOT NULL,                      -- {known:true, badges:[], assumptions:[], horizonDays:12, minutes:60, ...} metadata only, no free text
  decided_at  INTEGER NOT NULL
);
CREATE INDEX ix_auto_decisions_chat ON auto_decisions(chat_id, decided_at);

CREATE TABLE auto_writes (                        -- the AUTO ledger (I8) ; the previous version itself lives in event_revisions (v2-event-editing.md section 3.3)
  id            TEXT PRIMARY KEY,
  decision_id   TEXT NOT NULL UNIQUE REFERENCES auto_decisions(id),
  action_id     TEXT NOT NULL UNIQUE REFERENCES actions(id),
  item_id       INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,   -- the acting (linked) item
  event_id      TEXT NOT NULL,                    -- Google event id (ours: base32hex from eventIdFor)
  kind          TEXT NOT NULL CHECK(kind IN ('create','update','cancel')),
  pre_json      TEXT,                             -- NULL for create ; for update/cancel: {summary,start,end,timeZone,location,status,etag,updated,sequence} from get-event BEFORE the patch
                                                  -- (I8: stored in the SAME transaction as the write-ahead ; event_revisions.prev_json is written only on success, so it cannot be the pre-write record)
  revision_id   INTEGER REFERENCES event_revisions(id),   -- set on success = the revision this auto write produced ; undo goes through that revision
  post_etag TEXT, post_updated TEXT, post_sequence INTEGER,  -- from get-event AFTER the write (verification ; "unchanged since" baseline for undo)
  undo_state    TEXT NOT NULL DEFAULT 'available' CHECK(undo_state IN ('available','undone','expired','blocked_changed','blocked_started','failed')),
  undo_until    INTEGER NOT NULL,                 -- min(written_at + 72 h, event end)
  undo_action_id TEXT REFERENCES actions(id),
  written_at    INTEGER NOT NULL
);
```

```ts
// src/shared/autoPolicy.ts
export const AutoScopeSchema = z.strictObject({
  creates: z.literal(true),                       // the user asked for add + edit ; create is the base scope
  edits: z.boolean(),                             // default true
  cancels: z.boolean(),                           // default FALSE (N3) ; a separate checkbox in the dialog
  knownContactsOnly: z.literal(true),             // not a choice (5.3)
  validityDays: z.union([z.literal(30), z.literal(90)]),   // default 30 ; re-confirm afterwards
  horizonDays: z.number().int().min(1).max(30),   // default 30 (manual approvals keep 12 months)
  maxMinutes: z.number().int().min(5).max(240),   // default 240 (manual keeps 12 h)
  quietHours: z.strictObject({ from: z.number().int().min(0).max(23), to: z.number().int().min(0).max(23) }).nullable(), // default {from:22,to:7}
  perChatPerDay: z.number().int().min(1).max(3),  // default 3
  globalPerDay: z.number().int().min(1).max(15),  // default 15
});
export type AutoScope = z.infer<typeof AutoScopeSchema>;
```

Everything in `scope_json` is bounded by the schema's `max` values, which are the hard ceilings in code: the UI can only make auto mode *stricter* than the ceilings, never wider. `knownContactsOnly` and `creates` are literals so that no future settings patch can turn them off without a schema change (= a code change = a review).

### 3.3 Enabling: the protected path (MUST)

There is **no** `settings:set` path to auto mode (`SettingsPatchSchema` stays without an `auto` group; the strict parse in `register.ts` rejects it, like `llm.provider` today). Instead:

```ts
// src/shared/ipc.ts additions
'auto:getState':  NoReq,                                                   // -> AutoState (policy summary, counters, shadow stats)
'auto:requestEnable': z.strictObject({ scope: AutoScopeSchema, trial: z.boolean() }),   // opens the NATIVE dialog ; returns AutoState
'auto:disable':   z.strictObject({ reason: z.literal('user') }),           // one click, no confirm (fail-safe direction)
'auto:endShadow': ConfirmReq,                                              // shadow -> on, only after >= 3 shadow decisions were shown
'auto:undo':      z.strictObject({ autoWriteId: z.uuid() }),
'auto:listWrites': z.strictObject({ sinceTs: z.number().int().nonnegative() }),
```

`auto:requestEnable` handler (`src/main/ipc/handlers/auto.ts`), in order, each step failing closed with `Result.ok=false`:

1. Trusted sender frame (existing `register.ts`), zod `.strict()`.
2. `ctx.windowFocused && ctx.windowVisible` else `WINDOW_NOT_FOCUSED`; focus-steal guard: `ctx.shownByNotificationAt + LIMITS.focusGuardMainMs > now` => `WINDOW_NOT_FOCUSED` (same as `action:approve`).
3. Preconditions: calendar connected; `targetCalendarId` has `accessRole === 'owner'` in the last `list-calendars` result (cache it in `meta`) else `AUTO_CALENDAR_NOT_OWNED`; no live policy exists; consent `auto_mode` (new `ConsentKind`, versioned text He/En) is current or will be accepted by this dialog.
4. **Native modal dialog owned by main** - `dialog.showMessageBox(mainWindow, {...})` attaches to the parent and is modal [S16]; it is drawn by the OS, not by the renderer, so a renderer XSS cannot draw a fake one, and a keyboard auto-repeat cannot pre-accept it because `defaultId` and `cancelId` both point at "Cancel":

```ts
const r = await dialog.showMessageBox(win, {
  type: 'warning', noLink: true,
  title: t('auto.dialog.title'),                 // app string, never message text
  message: t('auto.dialog.message', { calendar: settings.calendar.targetCalendarId }),
  detail: t('auto.dialog.detail'),               // what will happen without approval, limits, undo window, expiry, "replies still need your approval"
  checkboxLabel: t('auto.dialog.checkbox'),      // "I understand events can be added or moved without asking me"
  buttons: [t('common.cancel'), trial ? t('auto.dialog.startTrial') : t('auto.dialog.enableNow')],
  defaultId: 0, cancelId: 0,
});
if (r.response !== 1 || !r.checkboxChecked) return fail('AUTO_NOT_CONFIRMED');
```

5. Insert the `auto_policies` row (`state = trial ? 'shadow' : 'on'`, `confirm_json` with `dialogResponse`, `checkboxChecked`, `windowFocused`, `appVersion`, `electronVersion`), audit `auto_policy_enabled {policyId, trial, validityDays, horizonDays, cancels}`, emit `auto:changed`.
6. Tray menu gains "Automatic mode: ON / trial - click to pause" (tray shows state, like "Paused" in v1 SHOULD S9).

Rate limit the dialog itself: at most 3 `auto:requestEnable` per hour (a compromised renderer must not be able to spam native dialogs until the user clicks through one).

### 3.4 Disabling, pausing, expiring (MUST)

- `auto:disable` needs no confirmation; also reachable from the tray menu and from the "Automatic activity" page. Audit `auto_policy_disabled {reason:'user'}`.
- **Automatic pause** (`state='paused'`, `paused_reason`), each with a toast + banner, resumed only by the user re-opening settings and clicking "Resume" (focused window, no dialog) - every reason below means "the assumptions of the grant no longer hold":
  - `snapshot_changed`: `targetCalendarId`, Google account, or `llm.provider` changed since the grant (`snapshot_sha` mismatch, checked on every `AutoGate` evaluation, not only on settings change). Changing the provider re-arms the shadow period (SHOULD) because a different model has a different injection profile.
  - `calendar_disconnected`: MCP host down or `manage-accounts` shows the account not `active`.
  - `circuit_breaker_rate`: any auto budget (4.8) hit.
  - `circuit_breaker_undo`: 2 UNDOs within 24 h (the user is correcting the agent; stop and ask).
  - `circuit_breaker_unknown`: any auto write ended `unknown_outcome`.
  - `unattended`: the app window has not been focused for 7 days (nobody is reading the audit trail, so the "visible within minutes" leg is gone).
- **Expiry**: `expires_at` reached => `state='expired'`, banner "Automatic mode ended - enable again?". Renewal is a fresh `auto:requestEnable` (fresh native dialog). Reminder toast 3 days before.
- **App update** with a different major/minor (`snapshot_sha` includes `appMajor`) => `paused / snapshot_changed`: the controls may have changed; the user re-confirms.

### 3.5 What the renderer can and cannot do (MUST)

- Can: request enable (result depends on the native dialog), disable, end shadow, undo, list. Cannot: create decisions, name an action to auto-execute, widen scope beyond schema ceilings, set `state`.
- `auto:*` channels are **not** exported to the app-hosted MCP server that the vendor CLI sees (D-038) and not to the WhatsApp MCP (D-040). Test: the MCP tool list of both servers is a compile-time constant with no `auto`, `settings`, `approve` or `write` tool.

---

## 4. Hard limits enforced in code (the "cage")

Every limit below is checked by `AutoGate` (pure function, `src/main/exec/autoGate.ts`) **and** re-checked by the existing executor path where one already exists (sanity, free/busy, rate limits, arg building). A failed check never blocks the item: it produces `verdict:'fallback'` with a reason, and the ordinary approval card appears exactly as in v1 (informed abstention: "names what is missing, and routes to a concrete recovery action" [S8]).

| # | Limit | Value (auto) | Value (manual, unchanged) | Where enforced | Reason enum |
|---|---|---|---|---|---|
| 4.1 | Own calendar only | `calendarId = settings.calendar.targetCalendarId` AND that id had `accessRole === 'owner'` in the cached `list-calendars` result. `CalendarInfo` gains `accessRole: 'owner' \| 'writer' \| 'reader' \| 'freeBusyReader' \| 'unknown'` next to the existing `writable`; the nspady server does emit `accessRole` per calendar [S20] and `adminClient.projectCalendars` already reads it (`str(raw,'accessRole')`) but collapses it to `writable` with `role === null => true` - for auto, `'unknown'` is NOT owned (fail closed) | any listed calendar (`writable`) | `AutoGate` + `buildCreateEventArgs` (already pins calendarId) | `calendar_not_owned` |
| 4.2 | No attendees, ever | `CreateEventArgs`/`UpdateEventArgs` have no `attendees` key (type + exhaustive key list, section 8.2); fetched event with `attendees.length > 0` is never auto-edited | same | `writeClient` key list; `AutoGate` for edits | `event_has_attendees` |
| 4.3 | No `sendUpdates` other than `'none'` | pinned literal on create (exists) and **update (new, F2)** | same | `writeClient` | - |
| 4.4 | No model text in description; title/location cleaned | description = app template (exists); `cleanField` (strip invisible, strip URLs, single line, cap) (exists); **auto adds**: title must be non-empty after cleaning and must not match the injection heuristic, and must not consist only of digits/punctuation | same cleaning | `buildCreateEventArgs` / `buildUpdateEventArgs`; `AutoGate` | `title_rejected` |
| 4.5 | Time horizon | `start <= now + scope.horizonDays` (default 30 d, ceiling 30 d) | 12 months | `AutoGate` (`eventSanity` keeps 12 months for manual) | `beyond_horizon` |
| 4.6 | Event length | `scope.maxMinutes` (default 240, ceiling 240); minimum `LIMITS.eventMinMin` (5) | 5 min - 12 h | `AutoGate` | `too_long` |
| 4.6b | Not in the past / not imminent | `start >= now + 15 min` for creates; edits: `oldStart - now >= 2 h` AND `newStart - now >= 2 h` (last-minute moves need a human) | `end > now` | `AutoGate` | `too_soon` |
| 4.6c | No all-day, no recurrence, no colour/visibility/reminder changes | `CreateEventPayload` already cannot express them; `UpdateEventArgs` key list excludes them | same | type + key list | - |
| 4.7 | **Never delete; never touch events we did not create; edits only within the same chat + linked item** | `delete-event` stays out of `ENABLED_TOOLS`. An auto edit requires, in one `get-event` round-trip before the patch: `extendedProperties.private.waAgent === '1'`, `waItem === String(sourceItem.id)` where `sourceItem = items[deltaItem.linked_item_id]` (the delta lives on a NEW linked item, v2-event-editing.md section 3.2; the tag carries the SOURCE item id, stable across revisions) and `sourceItem.chat_id === deltaItem.chat_id === action.chat_id`, `creator.self === true` (fallback `organizer.self === true`), `status !== 'cancelled'`, no `attendees`, no `recurrence`/`recurringEventId`, and `updated`/`etag` equal to what the app recorded after its own last write (`auto_writes.post_*` / `event_revisions` newest row / `items.calendar_updated` for manual creates) - otherwise the user changed it in Google and the delta goes to approval (the editing design's `needs_confirm_drift`) | manual edits: same ownership checks, but a user-modified event may be edited after the card shows the diff | `AutoGate` + update path (8.2) | `not_app_event`, `wrong_item`, `not_own_copy`, `event_cancelled`, `modified_in_google` |
| 4.7b | Edit distance | move of start by <= 14 days; max **2** auto edits per event lifetime (count `auto_writes` with `kind='update'` for the `event_id`); 1 auto create per item | unbounded (with diff card) | `AutoGate` | `move_too_far`, `edit_budget` |
| 4.7c | Cancel | only if `scope.cancels === true`; cancel = `status:'cancelled'` (needs F1 fix); never for an event starting within 24 h | manual cancel via card | `AutoGate` | `cancel_not_in_scope`, `cancel_too_soon` |
| 4.8 | **Auto budgets** (sub-budgets inside the existing `createPerHour 10 / createPerDay 30`, so manual approvals keep working when auto is exhausted) | per chat: 1 per 30 min, 2 per hour, `scope.perChatPerDay` (default 3); global: 4 per hour, `scope.globalPerDay` (default 15); creates and edits count together | 10/h, 30/day global | new `rate_events` buckets `auto_chat`, `auto_global`; hitting any bucket => decision `fallback/auto_budget` **and** policy `paused/circuit_breaker_rate` | `auto_budget` |
| 4.9 | Conflicts and duplicates | fresh app-side `getFreeBusy` overlap => fallback (never auto-book over an existing event); MCP `duplicate` response => fallback (never `allowDuplicates:true` automatically); `id_exists` on our deterministic id => done (idempotent, as today) | conflict => `needs_confirm_conflict` click | executor (exists) | `conflict`, `duplicate` |
| 4.10 | Quiet hours | inside `scope.quietHours` (local, settings time zone) => fallback (not delayed execution: a queue that fires at 07:00 is a surprise; the card is the queue) | - | `AutoGate` | `quiet_hours` |
| 4.11 | One write per decision; no chaining | an auto decision covers exactly one action; the update path never creates; the create path never updates; an auto write never triggers another triage run (`from_me` calendar changes do not exist; the item is marked `in_calendar` and the queue row is dropped) | - | executor | - |

---

## 5. Eligibility gates: confidence, badges, known contact, shadow

### 5.1 Confidence: deterministic first, model self-report second (MUST)

The v1 extraction schema has no confidence field; the editing design adds `changeConfidence: 'high'|'medium'|'low'` for deltas (v2-event-editing.md section 2.3). Research says confidence thresholds are the weaker governance signal compared with action reversibility [S5]; but they are still a useful *fallback trigger*. Two layers:

1. **Deterministic "no guessing" rule** (from data the pipeline already produces): auto requires `extraction.intent ∈ {'schedule_request','confirmation','reschedule'}` (cancel only with `scope.cancels`), `missing.length === 0`, `event` complete (`startLocal` and `endLocal` non-empty), `dateKind` resolved without an ambiguous-hour assumption: `assumptions` may contain only `default_duration` (never `hour_assumed_am/pm` - "3" could be 03:00 or 15:00), `dateHint` consistent, `title !== ''`, `needsReply` irrelevant.
2. **Model self-report**: for creates, `confidence: 'high' | 'medium' | 'low'` added to `EXTRACTION_JSON_SCHEMA` (same `CONFIDENCE` enum as the editing design's `changeConfidence`; string enum - inside the LCD JSON-schema subset all three providers accept) and to `ExtractionSchema`; for deltas, `changeConfidence` plus `refersToExisting === true` and `change !== 'no_change'`. Auto requires `'high'`. Advisory only: an attacker can make the model say "high"; the deterministic layer and the cage are the controls. It is kept because it costs nothing and catches honest uncertainty ("maybe Tuesday?").

### 5.2 Badges and manipulation => never auto (MUST)

`verdict:'fallback'` when the proposal carries **any** badge of severity `red` (`link_removed`, `manipulation`) or `amber` (`time_assumed`, `personal_details`, `lang_mismatch`, `conflict`), or when the S3 run had a blocked tool call (`ctx.blockedCalls > 0`, not only the abort threshold), or `extraction.suspicious === true`, or the injection heuristic matched anywhere in the context window (not only the draft). `info` badges (`change_in_google`, `older_message`) => fallback too (`change_in_google` = event modified outside the app; `older_message` = stale context).

**Media-derived proposals => never auto in v2.0 (MUST):** an item whose trigger is a picture (badges `from_image` / `image_unclear`, v2-image-events.md) or a locally transcribed voice note (D-039) falls back with `media_derived`. OCR/ASR text is a second untrusted channel with its own injection surface (text inside pictures) and unmeasured Hebrew accuracy; it earns auto eligibility only after a shadow tally shows the same approve-unchanged rate as text items (a later scope flag `scope.mediaAuto`, default false).

**Per-chat taint cooldown (SHOULD):** a chat that produced a `manipulation` badge or a blocked tool call gets `chats.auto_tainted_until = now + 7 d`; during that window nothing from that chat is automatic, even clean-looking messages (the attacker's second message is usually the clean one). Audit `auto_taint`.

### 5.3 Known contact requirement (MUST)

- `chats.is_known === 1` (the user has sent a real message in this chat, A13) **and** `chats.policy !== 'never'` **and** new `chats.auto_policy !== 'never'` (per-contact opt-out, SHOULD: also an opt-in allowlist mode `scope.contactsMode: 'all_known' | 'allowlist'` for users who want auto only for family/colleagues).
- `force_known` alone (user clicked "Analyse this chat") does **not** qualify: analysing a stranger's message is not the same as trusting them with the calendar.
- **User-participation check (SHOULD):** the context window of the run contains at least one `from_me` message newer than `trigger_ts - 24 h`. A contact the user wrote to once a year ago should not be able to schedule things unattended. Deterministic, uses data the context builder already has.
- **User-echo check (SHOULD, heuristic):** for `confirmation`/`schedule_request`, the resolved date or the resolved time appears (via `agent/dateTable.ts` tokens) in one of the user's own messages in the window - i.e. the user proposed or repeated the slot. An attacker cannot forge `from_me` rows. Ship behind a scope flag; measure its fallback rate in shadow mode first.

### 5.4 Shadow period / dry run (MUST mechanism, SHOULD default)

- A new policy starts in `state='shadow'` for 24 h (`shadow_until`) unless the user chose "Enable now" in the native dialog (still recorded). Research on agent rollouts is unanimous that a dry-run/shadow phase - "produce the exact action they would have taken without executing it" - is the fastest way to build evidence before granting real power [S14][S15].
- In shadow, `AutoGate` runs for real and stores `auto_decisions` with `verdict:'shadow'` (or `'fallback'` + reason); the card shows an `auto_shadow` badge ("would have been automatic") and the user approves as in v1. If the user **edits** the event before approving, or **dismisses** it, the decision row gets `outcome:'edited'|'dismissed'` (in `checks_json`, metadata only).
- `auto:endShadow` is accepted only after `>= 3` shadow decisions were shown, and the settings page shows the tally: "In the trial, N events would have been added automatically; you approved K unchanged, edited E, dismissed D." E + D > 0 keeps the "end trial" button but shows a warning. The transition shadow -> on **always** needs the user's click on `auto:endShadow` (focused window, no second native dialog: the grant was already confirmed); at `shadow_until` the app only shows the tally and asks. If the user never clicks, the policy stays in shadow indefinitely, which is still a useful mode ("approval with a hint"). A silent switch to autonomous is exactly the surprise this document exists to prevent.

### 5.5 `AutoReason` (exhaustive; stored in `auto_decisions.reason`, shown on the card as an app string)

```ts
export const AUTO_REASONS = [
  'ok',
  // policy
  'no_policy', 'policy_shadow', 'policy_paused', 'policy_expired', 'snapshot_changed', 'calendar_disconnected', 'calendar_not_owned',
  // contact / chat
  'unknown_contact', 'chat_opted_out', 'chat_tainted', 'no_user_participation', 'no_user_echo',
  // proposal quality
  'badge_red', 'badge_amber', 'badge_info', 'blocked_tool_call', 'suspicious', 'assumed_hour', 'missing_fields', 'low_confidence', 'intent_not_eligible', 'title_rejected', 'media_derived',
  // provider
  'provider_unsafe',
  // cage
  'beyond_horizon', 'too_long', 'too_soon', 'quiet_hours', 'conflict', 'duplicate', 'auto_budget',
  // edits
  'edits_not_in_scope', 'cancel_not_in_scope', 'cancel_too_soon', 'not_app_event', 'wrong_item', 'not_own_copy', 'event_has_attendees',
  'event_cancelled', 'modified_in_google', 'move_too_far', 'edit_budget', 'unknown_prev_state',
] as const;
```

Fallback reasons are visible to the user on the card ("Not automatic: the contact is not someone you have written to") so that the mode is predictable; they are **never** fed back to the model.

---

## 6. Notification, UNDO, audit trail

### 6.1 Notification (MUST)

- Every automatic write produces (a) a dashboard card in a new list **"Automatic"** at the top of the dashboard with the event rendered by the app from structured fields (as the approval card does) and a prominent **Undo** button, (b) a Windows toast with **app text only**: "Calendar: an event was added automatically" / "... was moved automatically" + buttons **Undo** and **Show**. Never the title, never the contact name, never message text (ARCH trust rule: untrusted text never in toasts).
- Toast buttons: Electron `Notification` `actions` are supported on Windows and macOS; the `'action'` event carries `actionIndex` (and `selectionIndex` on Windows) [S17]; Windows button support landed in PR #48132 (merged 2026-02-12, auto-backported to 40/41 via #49786/#49787, manual backports for 38/39, listed in the v42.0.0 release notes) [S18], so the pinned Electron 44.4.3 has it (the packaged smoke test must still click a toast button once; release dates of the backport minors: **UNVERIFIED**). Windows toasts need an AppUserModelID + Start-menu shortcut for actions to activate the app - the NSIS installer already creates one; verify in the packaged test.
- The toast's Undo is wired in main: `notifications.ts` stores `{autoWriteId}` when it creates the toast and calls `executor.undoAuto(autoWriteId)` on `action` index 0. No renderer, no payload parsing. `notifications: 'off'` in settings does not silence auto-write toasts (the toast is a safety control, not a convenience) - the settings copy says so.
- Batching: if 3+ auto writes happen within 10 minutes, one summary toast "3 events were added automatically - review" instead of three (toast fatigue is how users stop reading them).

### 6.2 UNDO (MUST; I8)

- `auto_writes.pre_json` is captured with `get-event` **before** the patch and written in the same transaction as the write-ahead (`pending -> approved -> executing`); if `get-event` fails the auto write does not happen (`fallback/unknown_prev_state`). For creates `pre_json` is NULL and undo = cancel. On success the `event_revisions` row the editing design inserts (`prev_json`/`next_json`, section 3.3 there) is linked through `auto_writes.revision_id`.
- UNDO **reuses the editing design's undo path** (`item:undoChange {itemId, revisionId}`: a new proposal with provider `'user'` + a pending `update_event` action with `revertOf`, approved immediately through the normal executor with `approved_by='user'`, or `'user_toast'` from the toast). There is no separate `undo_auto` action kind: one undo path for manual and automatic changes means one set of tests and one reconcile. Auto adds on top: the `auto_writes` bookkeeping (`undo_state`, `undo_until`, `undo_action_id`), the toast button, and a `get-event` pre-check that the event's `updated`/`etag` still equals `auto_writes.post_*` (nobody touched it since we did), then:
  - create -> `update-event {status:'cancelled', sendUpdates:'none'}` (needs F1; with `CANCEL_MODE:'soft'` the editing design's soft cancel); the event remains restorable on the organizer's calendar per Google's own description of cancelled status [S9]; the item goes to `declined`, with the card re-offering "Add" (a *new* proposal version, so a re-add gets a new deterministic `eventId` and cannot 409 against the cancelled one).
  - update -> patch back `summary,start,end,timeZone,location` from the revision's `prev_json` (key list, section 8.2); the item's `calendar_updated` is refreshed from the post-undo `get-event`.
  - cancel -> `status:'confirmed'` + fields from `prev_json`; if Google will not restore (404/410 or readback still `cancelled`, UNVERIFIED per the editing doc) the executor offers the editing design's "Add it back" `create_event` - executed under the user's Undo click (`approved_by='user'`), **not** through `AutoGate`, so it is a user action in the audit, never an auto write (this corrects v2-event-editing.md section 3.3's aside that the re-create is "auto-applied" in automatic mode).
- If `updated` differs (`blocked_changed`): no automatic reversal; the card shows "You changed this event in Google Calendar after it was added; undo would overwrite your change" with a link to the event. If the event already started (`blocked_started`): the card offers "Cancel event" instead (explicit click).
- Undo window: `undo_until = min(written_at + 72 h, event end)`; after that the card keeps the link but the button is gone; `undo_state='expired'`. Two undos within 24 h pause the policy (3.4).
- Undo is idempotent (a second click sees `undo_state='undone'`; `item:undoChange` also refuses a revision with `reverted_by` set), and the undo action is subject to the same write-ahead/unknown_outcome/reconcile machinery as every other action (I7).

### 6.3 Audit trail the user can read (MUST)

- New `AUDIT_KINDS`: `auto_policy_enabled`, `auto_policy_shadow_ended`, `auto_policy_paused`, `auto_policy_resumed`, `auto_policy_disabled`, `auto_policy_expired`, `auto_decision` (detail: `{decisionId, itemId, kind, verdict, reason}`), `auto_write` (detail: `{decisionId, actionId, kind, eventIdSha8}`), `auto_undo` (detail: `{autoWriteId, result}`), `auto_taint`. Metadata only, as today: no titles, no message text, no contact names (the existing rule for every audit kind).
- Settings > **"Automatic activity"** page: a per-day list joining `auto_writes` + `auto_decisions` + `items` (title and time come from the proposals row at render time, rendered as untrusted text in a quoted bubble, never from the audit row), with Undo state, fallback reasons for items that were *not* automatic, the policy's remaining validity, budgets used today, and an **Export** button (JSON, metadata only). Retention: `auto_decisions` 90 days, `auto_writes` 180 days (aligned with the action log), `auto_policies` forever (they are small and are the consent history).
- The dashboard "Automatic" list shows the last 7 days by default.

---

## 7. Operating envelope summary (defaults)

| Control | Default | Ceiling in code |
|---|---|---|
| Policy validity | 30 days, then re-confirm | 90 days |
| Shadow / trial | 24 h, ends only by user click after >= 3 shadow decisions | - |
| Horizon | 30 days | 30 days |
| Event length | 5 min - 4 h | 4 h |
| Not sooner than | 15 min (create), 2 h (edit, old and new slot) | - |
| Quiet hours | 22:00-07:00 local | configurable, may be off |
| Per chat | 1 / 30 min, 2 / h, 3 / day | 3 / day |
| Global | 4 / h, 15 / day | 15 / day |
| Edits per event | 2 | 2 |
| Move distance | <= 14 days | 14 days |
| Cancels | off | on (separate checkbox) |
| Undo window | 72 h or until event end | - |
| Unattended pause | 7 days without window focus | - |
| Circuit breakers | any auto budget hit; 2 undos / 24 h; any unknown_outcome | - |

---

## 8. Exact code changes

### 8.1 DB and the I1' trigger (MUST)

```sql
ALTER TABLE actions ADD COLUMN approved_by TEXT;   -- 'user' | 'user_toast' | <auto_decisions.id>
-- NOTE vs v2-event-editing.md section 3.5, which proposes approved_by IN ('user','auto') with DEFAULT 'user': a bare 'auto' string cannot be
-- verified by the DB, and a DEFAULT would let an UPDATE that forgets the column pass the trigger. approved_by stays NULL until approve time
-- and, for automatic writes, is the decision id so the trigger can JOIN it to a live policy (I1').
ALTER TABLE chats   ADD COLUMN auto_policy TEXT NOT NULL DEFAULT 'inherit' CHECK(auto_policy IN ('inherit','never','allow'));
ALTER TABLE chats   ADD COLUMN auto_tainted_until INTEGER;
ALTER TABLE items   ADD COLUMN calendar_updated TEXT;     -- RFC3339 `updated` of OUR last write (baseline for 4.7)
-- kind gains ONE new value (from the editing design; undo is an update_event with revertOf, no separate kind). CHECK constraints need the
-- 12-step table rebuild (v2-event-editing.md section 3.4), so this migration and the editing migration are ONE migration.
-- kind TEXT NOT NULL CHECK(kind IN ('send_reply','create_event','update_event'))

DROP TRIGGER trg_actions_state;
CREATE TRIGGER trg_actions_state BEFORE UPDATE OF state ON actions WHEN NEW.state <> OLD.state BEGIN
  SELECT CASE
    WHEN OLD.state IN ('done','failed','rejected','expired','superseded') THEN RAISE(ABORT,'terminal state')
    WHEN NEW.state='pending'   THEN RAISE(ABORT,'cannot return to pending')
    WHEN NEW.state='approved'  AND (OLD.state<>'pending' OR NEW.approved_at IS NULL OR NEW.approved_final_json IS NULL
                                    OR NEW.approved_by IS NULL) THEN RAISE(ABORT,'bad approve')
    -- I1': a send is NEVER automatic ; a calendar write is automatic only with a live-policy decision for THIS action
    WHEN NEW.state='approved'  AND NEW.kind='send_reply' AND NEW.approved_by NOT IN ('user') THEN RAISE(ABORT,'send needs a click')
    WHEN NEW.state='approved'  AND NEW.approved_by NOT IN ('user','user_toast')
         AND NOT EXISTS (SELECT 1 FROM auto_decisions d JOIN auto_policies p ON p.id = d.policy_id
                         WHERE d.id = NEW.approved_by AND d.action_id = NEW.id AND d.verdict = 'auto' AND p.state = 'on')
         THEN RAISE(ABORT,'auto approve without live policy decision')
    WHEN NEW.state='executing' AND (OLD.state<>'approved' OR NEW.approved_final_json IS NULL) THEN RAISE(ABORT,'execute without approval')
    WHEN NEW.state='done'      AND OLD.state NOT IN ('executing','unknown_outcome') THEN RAISE(ABORT,'bad done')
    WHEN NEW.state IN ('failed','unknown_outcome') AND OLD.state<>'executing' THEN RAISE(ABORT,'bad outcome')
    WHEN NEW.state='rejected'  AND OLD.state<>'pending' THEN RAISE(ABORT,'bad reject')
    WHEN NEW.state IN ('expired','superseded') AND OLD.state NOT IN ('pending','unknown_outcome') THEN RAISE(ABORT,'bad close')
  END; END;
-- approved_by is frozen with the rest (add to trg_actions_frozen's column list)
```

`repos.actions.markApprovedExecuting(id, finalJson, at, approvedBy)` gains the fourth parameter; the existing two CAS statements stay; `approved_by` is set in the first one.

### 8.2 MCP layer (MUST)

```ts
// src/main/mcp/readClient.ts
export const MCP_TOOLS = {
  'get-current-time': 'read', 'get-freebusy': 'read', 'list-events': 'read',
  'get-event': 'read',                    // NEW: app-side only ; NOT in agent/toolDefs READ_TOOLS, so the model never sees it
  'list-calendars': 'admin', 'manage-accounts': 'admin',
  'create-event': 'write', 'update-event': 'write',   // NEW class member ; delete-event stays absent (never enabled)
} as const;
export const ENABLED_TOOLS_ENV = 'get-current-time,get-freebusy,list-events,get-event,list-calendars,create-event,update-event,manage-accounts';

// McpReadClient gains (app-side, projected, never wrapped for a model):
getEvent(calendarId: string, eventId: string): Promise<McpResult<OwnedEventProjection>>;
// OwnedEventProjection = { id, status:'confirmed'|'tentative'|'cancelled', startLocal, endLocal, timeZone, summary(<=80, cleaned), location(<=120, cleaned),
//   etag: string|null, updated: string|null, sequence: number|null, creatorSelf: boolean, organizerSelf: boolean, hasAttendees: boolean, hasRecurrence: boolean,
//   priv: { waAgent: string|null, waItem: string|null, waAction: string|null } }
// projection.ts: projectOwnedEvent(text, timeZone) - raw server text never leaves this function.
```

`get-event`'s `fields` argument must request `etag,updated,sequence,status,creator,organizer,attendees,recurrence,recurringEventId,extendedProperties` explicitly: the server's `DEFAULT_EVENT_FIELDS` are `id, summary, start, end, status, htmlLink, location, attendees, reminders, recurrence`, and its `ALLOWED_EVENT_FIELDS` enum (`src/utils/field-mask-builder.ts`) **does** include `etag, updated, sequence, creator, organizer, status, extendedProperties, attendees, recurrence, recurringEventId` [S19] - verified 2026-09-28, so no server patch is needed for the read side.

```ts
// src/main/mcp/writeClient.ts
export interface UpdateEventArgs {          // built ONLY by exec/buildUpdateEventArgs.ts
  calendarId: string; account: 'personal'; eventId: string;
  summary?: string; start?: LocalDateTime; end?: LocalDateTime; timeZone: string; location?: string;   // only the fields the delta changes
  status?: 'confirmed' | 'cancelled';       // needs F1 (section 8.3)
  sendUpdates: 'none';                      // F2: the server default is 'all'
  checkConflicts: false;                    // the executor did its own free/busy ; server-side behaviour UNVERIFIED
  ifMatch?: string;                         // etag from the pre-write get-event ; needs F1 ; when unsupported the executor falls back to the updated/sequence post-check
  extendedProperties: { private: { waAgent: '1'; waItem: string; waAction: string; waUpdate: string; waRev: string } };
  // ^ the COMPLETE private map on every update (aligned with v2-event-editing.md section 4.2: patch semantics for maps are UNVERIFIED, so the
  //   app re-sends the full map). waAgent/waItem/waAction are COPIED from the pre-flight get-event, never recomputed; waUpdate/waRev are new.
}
export const UPDATE_EVENT_KEYS = ['calendarId','account','eventId','summary','start','end','timeZone','location','status','sendUpdates','checkConflicts','ifMatch','extendedProperties'] as const;
// never: attendees, description (kept as-is on the server), recurrence, colorId, reminders, visibility, transparency, conferenceData, attachments,
//        modificationScope, originalStartTime, futureStartDate, calendarsToCheck, guestsCan*, anyoneCanAddSelf
export interface McpWriteClient {
  createEvent(args: CreateEventArgs): Promise<McpResult<CreateEventResult>>;
  updateEvent(args: UpdateEventArgs): Promise<McpResult<{ eventId: string; etag: string | null; updated: string | null; sequence: number | null }>>;
}
```

The update body is built key by key like `createEvent` (no spread). The private tag map is always sent in full with the identity values copied from the pre-flight read, so the `waAgent/waItem/waAction` tag survives whether `events.patch` merges or replaces the map (the nspady handler uses `events.patch` [S11]; Google: patch = partial update, but array/map semantics are not spelled out for `extendedProperties` [S9]). Test A19 asserts that the three identity values on the wire equal the fetched ones.

### 8.3 F1: `status` and `If-Match` are missing from the pinned server - options (decision needed, NOT locked here)

| Option | What | Cost | Verdict |
|---|---|---|---|
| A (recommended) | **Vendored patch** of `@cocal/google-calendar-mcp@2.6.3` inside `build-resources/calendar-mcp/` (it is already an isolated, lock-filed package the app never imports) - the same two-insertion patch of `build/index.js` that v2-event-editing.md section 1.6 specifies (`status` enum on `ToolSchemas["update-event"]` + `requestBody.status` in `buildUpdateRequestBody`), guarded by a sha256 pre-check of the 2.6.3 bundle and a fail-closed startup assertion that `tools/list['update-event'].inputSchema.properties.status.enum` contains `"cancelled"` (else `CAL_TOOLSET_MISMATCH`), **plus one more insertion for this document**: `ifMatch: z.string().optional()` and `headers: {'If-Match': args.ifMatch}` on the `events.patch` call, with 412 mapped to a distinct error text the projection turns into `McpErrorKind 'precondition'`. The read side needs nothing (S19). | ~15 lines JS + tests; must be re-applied on server upgrades | do it |
| B | Upstream PR to nspady, wait | unknown latency; v2.6.3 is "Latest" as of 2026-09-02 with no `status` in the changelog [S12] | file it anyway, do not wait |
| C | Cancel by cosmetic marking: `summary: '[cancelled] ' + summary`, `transparency:'transparent'`, `colorId` grey | works with the unpatched server; the event still shows; no real cancel; no `If-Match` | fallback only if A is rejected |
| D | Direct Google REST call from the app for `status`/`If-Match` (bypassing MCP) | breaks "all calendar I/O through the MCP child" (A4/A10) and duplicates OAuth handling | rejected |

Whichever option wins, **`update-event` without `sendUpdates:'none'` must never be sent** (F2), and the `ifMatch` gap is covered by the post-write verification: `get-event` after the patch must show `sequence`/`updated` advanced from the pre-write snapshot, otherwise `unknown_outcome` + reconcile.

### 8.4 Executor changes (MUST)

```ts
// src/main/exec/actionExecutor.ts - additive; approve()/reject()/recoverOnStartup()/drain() keep their frozen signatures
export interface ActionExecutorHandle /* += */ {
  /** Called by the orchestrator right after S4 inserted the pending actions (create_event / update_event only; never send_reply).
   *  Runs AutoGate; on 'auto' it performs the SAME steps as approve() from "load+kind+state" onward (no ctx, no shownHash, no edit),
   *  with approved_by = decision id. On 'shadow' / 'fallback' it only records the decision (the card is shown as in v1). */
  tryAuto(actionId: ActionId): Promise<AutoDecision>;
  /** UNDO of an automatic write: resolves auto_writes -> revision_id and drives the editing design's `item:undoChange` path
   *  (a pending update_event with revertOf, approved with approved_by 'user' | 'user_toast'), plus the auto_writes bookkeeping. Section 6.2. */
  undoAuto(autoWriteId: string, by: 'user' | 'user_toast'): Promise<Result<ApproveOutcome>>;
}
// deps additions
autoPolicy: () => LiveAutoPolicy | null;   // repos.autoPolicies.live() with snapshot check
autoRate: AutoRateLimiter;                 // buckets auto_chat / auto_global
windowFocusedRecently: () => boolean;      // for the 'unattended' pause
```

`tryAuto` order (each step is a `fallback` reason or a hard stop; nothing below the write-ahead differs from `approve`):

1. `inFlight` guard (synchronous, as in `approve`).
2. Load action; `kind ∈ {'create_event','update_event'}`; `state='pending'`; not expired.
3. `policy = deps.autoPolicy()`; null => `no_policy`; `state='shadow'` => evaluate everything, store `verdict:'shadow'`, return; `paused/expired` => reason.
4. `AutoGate.evaluate({ policy, action, item, chat, proposal, badges, extraction subset, now, quietHours })` - pure, no I/O, no LLM import; returns `{ok:true}` or `{ok:false, reason}`.
5. For `update_event`: `deps.read.getEvent(...)` ownership + unchanged checks (4.7) - the only I/O before the write-ahead besides free/busy; snapshot kept for `pre_json` (this is the same pre-flight the editing design runs for drift/gone/foreign; auto adds the ownership-by-linked-item and unchanged-since checks and turns every failure into a fallback instead of `needs_confirm_drift`).
6. `eventSanity` (manual bounds) then the auto bounds; `freshBusy` => `conflict`; `prepareArgs` (pure); general rate limit (`checkCreate`) AND `autoRate.check(chatId)`.
7. **One transaction**: insert `auto_decisions {verdict:'auto', reason:'ok'}`, `markApprovedExecuting(id, finalJson, now, decision.id)` (the trigger verifies the join), insert `auto_writes {pre_json}`, audit `action_approved {by:'auto'}` + `auto_decision`. Any abort => nothing happened.
8. `runCreate` / `runUpdate` (the editing design's update path; same outcome handling: `done | failed | unknown_outcome`, retry clone for failures **is NOT created** on the auto path - a failed auto write turns into an ordinary pending card, i.e. the retry needs a click), then `get-event` verify for updates, `auto_writes.post_*` + `revision_id`, item `calendar_updated`.
9. Notify (toast + `dashboard:changed`); `autoRate.record`; circuit-breaker evaluation.

`approve()` (user click) sets `approved_by:'user'` and is otherwise unchanged. Undo reuses `approve()` on the pending `update_event` that `item:undoChange` inserted from `event_revisions.prev_json`, never from the renderer. **D-038 precondition (M16):** `tryAuto` must also refuse (`fallback/provider_unsafe`) when the proposal's provider row says the run was made by a vendor CLI whose `system/init.tools` assertion (v2-claude-cli-backend.md: `--tools "" --strict-mcp-config --disallowedTools ...`) did not pass - a CLI that could run its own tools is a second executor below the app, and I1' cannot hold.

### 8.5 ToolGate: what changes (and what deliberately does not)

- `READ_TOOLS` (LLM-facing, `agent/toolDefs.ts`) **unchanged**: `get_freebusy`, `get_current_time`. `get-event`/`list-events` remain app-side only. The WhatsApp MCP tools (D-040) join `READ_TOOLS` through the same table with their own budgets - not this document's scope.
- `exposedTools()` does not depend on the auto policy; `RunCtx` gets no auto field; `buildSystemPrompt` gets no auto parameter (I2 test extension).
- The `blockedCalls` counter is already in `RunCtx`; S4 must persist `blockedCalls > 0` into the proposal (`proposals.blocked_calls INTEGER`) so `AutoGate` can read it without touching `agent/**`.
- New `toolGate` audit detail unchanged; `AutoGate` reads badges/blocked count from the proposals row.

### 8.6 Delta proposals (D-036) as seen from the gate

The extraction never outputs an event id. A `reschedule`/`cancel` intent resolves in S2 to the item's own `calendar_event_id` (same chat, same item, `event_state='created'`); if the item has none, or the chat has several created items, the delta becomes an ordinary proposal with a "which event?" question (fallback `wrong_item`). The `UpdateEventPayload` (`kind:'update_event'`, `eventId` **copied from the items row by S4, never from the model**, `prevStartLocal/prevEndLocal` for the diff card, new `title/startLocal/endLocal/location`, `status?`) is what the user approves or the gate auto-approves; `buildUpdateEventArgs` re-reads `items.calendar_event_id` at execution time and refuses if it differs (`ACTION_STALE`).

---

## 9. Tests that prove each control (all against fake bridge / fake MCP / virtual clock; `tests/security/auto-mode.*.test.ts`)

| # | Test (name) | Proves |
|---|---|---|
| A1 | `auto-mode.i1-trigger.test.ts`: UPDATE actions SET state='approved', approved_by=NULL / ='bogus' / = a decision of another action / = a decision whose policy is `shadow`,`paused`,`expired`,`disabled` => all `RAISE(ABORT)`; `send_reply` with any non-`'user'` approver aborts | I1' at the DB layer |
| A2 | `auto-mode.import-graph.test.ts`: `exec/autoGate.ts` imports nothing from `agent/**`, `llm/**`, `ipc/**`; `agent/**` imports nothing from `exec/autoGate.ts` | capability separation |
| A3 | `auto-mode.prompt-purity.test.ts`: for every `settings.auto`/policy state, `buildSystemPrompt()` bytes and `exposedTools()` are identical | model never learns about auto mode |
| A4 | `auto-mode.injection-corpus.test.ts`: the v1 corpus (He + En) plus 20 new auto-mode cases ("add it automatically", "move my dentist to Friday", "cancel everything", fake `waAgent=1` text, 60 messages naming 60 slots, push name `AUTO APPROVED`) run with the obedient fake model and a live `on` policy: assertions - zero writes for non-known chats; at most `perChatPerDay` writes for a known chat; every write has `attendees` absent, `sendUpdates:'none'`, description = template, calendarId = target; no `update-event` for an event lacking the tag; zero `delete-event` ever; every write has an `auto_decisions` + `auto_writes` row | the cage under worst-case model behaviour |
| A5 | `auto-mode.gate.test.ts` (table-driven, one row per `AUTO_REASONS` value): each condition alone flips `ok` to that reason; the all-clear fixture returns `ok` | exhaustiveness of the gate |
| A6 | `auto-mode.known-contact.test.ts`: `is_known=0` + `force_known=1` => `unknown_contact`; `auto_policy='never'` => `chat_opted_out`; taint window => `chat_tainted` | 5.3 / 5.2 |
| A7 | `auto-mode.badges.test.ts`: each badge (incl. `from_image`, `image_unclear`), a voice-note-derived item, `suspicious`, `blockedCalls=1`, `hour_assumed_pm`, `confidence:'medium'`, `changeConfidence:'medium'`, `refersToExisting:false` on an update => fallback | 5.1 / 5.2 |
| A8 | `auto-mode.limits.test.ts` (virtual clock): horizon 30 d + 1 min, 241 min, start in 14 min, edit at start-119 min, move 15 d, third edit of one event, quiet hours edge (21:59 vs 22:00), fifth global write in an hour => fallback; the budget hit also pauses the policy (`circuit_breaker_rate`) and manual approval still works after it | section 4 / 7 |
| A9 | `auto-mode.ownership.test.ts`: fake `get-event` variants - missing tag, `waItem` of another item/chat, `waItem` = the delta item's own id instead of the linked source item, `linked_item_id` NULL, `creatorSelf=false`, attendees present, recurrence/`recurringEventId` present, `status:'cancelled'`, `updated` changed since our write => no `update-event` call, correct reason | 4.7 / I9 |
| A10 | `auto-mode.undo.test.ts`: create -> undo => exactly one `update-event {status:'cancelled', sendUpdates:'none'}`; update -> undo => one `update_event` action with `revertOf` and a patch carrying the revision's `prev_json` fields + the full private map; `updated` drifted => `blocked_changed`, zero calls; event started => `blocked_started`; double undo => one call; two undos in 24 h => policy paused; undo-of-cancel with a fake that refuses restore => the re-create action has `approved_by='user'` and no `auto_decisions` row | I8 / 6.2 |
| A11 | `auto-mode.crash.test.ts`: kill between write-ahead and patch => `unknown_outcome`, reconcile compares `sequence`/`updated`, never re-patches; kill after patch before `post_*`/`revision_id` are written => reconcile resolves `done` (by `waUpdate` on the read-back event) and fills `post_*` + `revision_id` | I7 for updates |
| A12 | `auto-mode.toggle.test.ts`: `settings:set {auto:{...}}` => `BAD_REQUEST`; `auto:requestEnable` with `windowFocused=false`, within the focus guard, dialog response 0, response 1 without checkbox, calendar `accessRole:'writer'` / `'reader'` / absent (`'unknown'`), 4th request in an hour => no policy row; happy path => one row with `confirm_json` and audit; `auto:disable` from unfocused window still works (fail-safe) | 3.3 / 3.4 / 4.1 |
| A13 | `auto-mode.snapshot.test.ts`: change `targetCalendarId` / provider / account / app major after enabling => next `tryAuto` is `snapshot_changed` and the policy is `paused` | 3.4 |
| A14 | `auto-mode.shadow.test.ts`: shadow policy => decisions recorded, zero writes, card badge `auto_shadow`; `auto:endShadow` refused with 2 decisions, accepted with 3; no automatic shadow->on at `shadow_until` | 5.4 |
| A15 | `auto-mode.unattended.test.ts` (virtual clock): 7 days without focus => paused/`unattended`; focus + Resume click => `on` | 3.4 |
| A16 | `auto-mode.notification.test.ts`: every auto write => one toast with app strings only (snapshot: contains no title/name/message text), a stored `autoWriteId`; `action` index 0 => `undoAuto(id,'user_toast')`; 3 writes in 10 min => one summary toast | 6.1 |
| A17 | `auto-mode.audit.test.ts`: every auto write/decision/undo produces exactly the listed audit kinds with metadata-only detail (property test: random titles/names never appear in `detail_json`); export JSON snapshot | 6.3 |
| A18 | `auto-mode.mcp-surface.test.ts`: the app-hosted MCP (D-038) and WhatsApp MCP (D-040) tool lists contain no tool whose name matches `/auto|approve|settings|write|create|update|delete|send/i`; fake CLI client calling `auto:*` names gets "tool not available" | 3.5 / N7 |
| A19 | `write-client.update.test.ts`: `updateEvent` body key set == `UPDATE_EVENT_KEYS` filtered by presence; extra props on the args object never reach the wire; `sendUpdates:'none'` always; `extendedProperties.private` on the wire has exactly `waAgent,waItem,waAction,waUpdate,waRev` and the first three equal the pre-flight `get-event` values | 8.2 / F2 |
| A20 | packaged smoke (manual, ACCEPTANCE): with dummy Google creds, `tools/list` shows `update-event`, `get-event`; the vendored patch's `status` field is present in the schema (`tools/list` hash pin updated) | F1 |

---

## 10. MUST / SHOULD list

### MUST (auto mode cannot be enabled in a build where any of these is missing)

| # | Control | Section |
|---|---|---|
| M1 | I1' enforced by the `actions` trigger: `approved` requires `approved_by`; sends require `'user'`; calendar writes require `'user'|'user_toast'` or a live-policy `auto_decisions` row for that action | 2, 8.1 |
| M2 | Policy record (`auto_policies`) with expiry (default 30 d), settings snapshot hash, native-dialog confirmation record; exactly one live policy; no `settings:set` path | 3 |
| M3 | Enable only from a focused, visible window outside the focus guard, through `dialog.showMessageBox(mainWindow, …)` with `defaultId = cancelId = Cancel` and a required checkbox; enable requests rate-limited; disable is one click from settings, tray or activity page | 3.3, 3.4 |
| M4 | Automatic pause on snapshot change, calendar disconnect, any auto budget hit, 2 undos / 24 h, any `unknown_outcome`, 7 days unattended; resume needs a click | 3.4 |
| M5 | `AutoGate` pure and LLM-free with the exhaustive `AUTO_REASONS`; fallback = the v1 approval card with the reason shown | 4, 5, 8.4 |
| M6 | Cage: own calendar (`accessRole:'owner'`), no attendees, `sendUpdates:'none'` on create AND update, app-template description, horizon <= 30 d, 5 min-4 h, not sooner than 15 min / 2 h for edits, no all-day/recurrence/colour/visibility, never delete, never an event without our private tag + matching item/chat + `creator.self`, never a user-modified event, <= 2 edits per event, move <= 14 d, cancel off by default and never < 24 h before start | 4 |
| M7 | Auto budgets as sub-budgets (1/30 min, 2/h, 3/day per chat; 4/h, 15/day global) in persisted `rate_events`; conflict and duplicate => fallback, never `allowDuplicates:true` automatically | 4.8, 4.9 |
| M8 | Eligibility: `is_known` (not `force_known`), chat not opted out; any badge / suspicious / blocked call / assumed hour / missing field / non-eligible intent / `confidence !== 'high'` (deltas: `changeConfidence !== 'high'` or `refersToExisting !== true`) => fallback | 5.1-5.3 |
| M9 | Shadow state exists, is the default first state, records decisions without writing, never switches itself on | 5.4 |
| M10 | Toast + dashboard "Automatic" card for every auto write, app text only; UNDO button on both; `prev_json` captured before the write in the same transaction; undo verifies unchanged-since, is idempotent, and is itself an audited action | 6.1, 6.2 |
| M11 | Audit kinds + readable "Automatic activity" page + export; metadata only | 6.3 |
| M12 | `update-event` reachable only through `McpWriteClient.updateEvent` with the exhaustive `UPDATE_EVENT_KEYS`; the private tag's identity values (`waAgent,waItem,waAction`) are copied from the pre-flight read and never recomputed; post-write `get-event` verification; crash => `unknown_outcome` + reconcile by `sequence`/`updated` | 8.2, 8.4 |
| M13 | Resolve F1 (status/If-Match) - option A vendored patch, or explicitly accept option C - before D-036 cancel and undo-of-create ship; F2 pin `sendUpdates:'none'` regardless | 8.3 |
| M14 | Model never learns about auto mode (prompt purity + tool defs unchanged); `auto:*` channels absent from every MCP surface the CLI or the model can reach | 2, 3.5, 8.5 |
| M15 | Tests A1-A20 green; the injection corpus runs with a live `on` policy | 9 |
| M16 | Media-derived proposals (picture / voice note) never auto in v2.0; with a vendor-CLI provider (D-038) auto is allowed only for runs whose `system/init.tools` assertion proved the CLI had no tools beyond the app's read-only MCP (`provider_unsafe` otherwise) | 5.2, 8.4 |
| M17 | One migration with the editing design (table rebuild for the CHECK lists) and one undo path (`item:undoChange` over `event_revisions`) for manual and automatic changes; `auto_writes` is a ledger over it, not a second copy of the previous version | 3.2, 6.2, 8.1 |

### SHOULD

| # | Control | Section |
|---|---|---|
| S1 | Per-chat taint cooldown (7 d) after a manipulation badge or blocked call | 5.2 |
| S2 | User-participation check (a `from_me` message in the window within 24 h of the trigger) | 5.3 |
| S3 | User-echo check (resolved date/time appears in the user's own message), behind a scope flag, measured in shadow first | 5.3 |
| S4 | Per-contact allowlist mode (`contactsMode:'allowlist'`) in addition to per-contact opt-out | 5.3 |
| S5 | Provider change re-arms a 24 h shadow period rather than only pausing | 3.4 |
| S6 | Summary toast for bursts; reminder toast 3 days before policy expiry | 6.1, 3.4 |
| S7 | Undo also offered inside the Google event's app-template description? **No** - the description is app text but a link back into the app would be a URL scheme (rejected in v1 section 7.9). Keep undo in-app only. | - |
| S8 | Local-provider caveat: with the `tiny` tier (E2B) the injection-following rate is highest; show an extra line in the enable dialog when the active provider is `local/tiny` (no hard block: the cage, not the model, is the control) | 5 |
| S9 | Upstream the `status` / `If-Match` change to nspady/google-calendar-mcp so the vendored patch can be retired | 8.3 |

---

## 11. Open questions / UNVERIFIED

- Q1. **F1 decision**: vendored patch (A: the editing design's two insertions + the `ifMatch` insertion from this document) vs soft cancel (the editing design's `CANCEL_MODE:'soft'`). Needed before D-036 cancel semantics and undo-of-create are implemented. *Resolved part (2026-09-28):* `get-event` needs no patch - `ALLOWED_EVENT_FIELDS` already exposes `etag, updated, sequence, creator, organizer, status, extendedProperties, attendees, recurrence, recurringEventId` [S19].
- Q2. Whether `events.patch` through the server merges or replaces `extendedProperties.private` when the request carries it (Google does not spell out map semantics [S9]). Mitigated by always sending the complete map (section 8.2, aligned with the editing design); confirm in the packaged smoke test with a dummy event - never with the user's real calendar during development.
- Q3. Electron 44.4.3 Windows toast buttons: PR #48132 is in the v42.0.0 notes and backported to 40/41 [S18], so 44.4.3 has the code; the NSIS shortcut / AppUserModelID prerequisite for toast *activation* (buttons reaching the app when it is not in the foreground) must be confirmed on a clean Windows 11 VM (**UNVERIFIED**); the exact dates of the backport minors are UNVERIFIED (the release page summary returned implausible dates).
- Q4. *Resolved (2026-09-28):* the server returns `accessRole` per calendar [S20] and `adminClient.projectCalendars` already parses it into `writable` with `WRITABLE_ROLES`; the auto path needs the raw role (`CalendarInfo.accessRole`, section 4.1) and must treat an absent role as not owned - the existing `role === null => writable:true` default is fine for the manual path only.
- Q5. *Narrowed (2026-09-28):* v2-claude-cli-backend.md shows Claude Code CLI can be launched with `--tools "" --strict-mcp-config --disallowedTools ... --permission-mode dontAsk` and that the run's `system/init.tools` can be asserted; auto mode with that provider is allowed only when the assertion passed for the run that produced the proposal (M16). Whether Gemini CLI offers an equivalent hard tool disable is **UNVERIFIED** here (pointer to v2-gemini-cli-backend.md); until it does, auto mode is unavailable while Gemini CLI is the provider.
- Q6. Product: should `reschedule` deltas that move an event to a *different day* be auto at all, or only same-day time changes? The cage allows <= 14 days; a stricter default (same day) is a one-line scope change if the shadow tally shows frequent edits.
- Q7. Hebrew copy for the native dialog and the reason strings (i18n agent).
- Q8. Cross-document: v2-event-editing.md section 3.5 sketches `approved_by IN ('user','auto') DEFAULT 'user'` and an `AutoApprover.consider()` that calls `executor.approve()` with a fake `IpcContext`. This document supersedes that sketch (section 8.1 note, section 8.4 `tryAuto`): the decision id, not a constant, is what the trigger can verify, and `approve()` keeps its click-only contract. The orchestrator should record the merge as one decision.

---

## 12. Sources

- [S1] Simon Willison, "New prompt injection papers: Agents Rule of Two and The Attacker Moves Second" (2025-11-02), quoting Meta's Rule of Two: an agent with all three properties "should not be permitted to operate autonomously and requires supervision via human-in-the-loop approval or another reliable means of validation" - https://simonwillison.net/2025/Nov/2/new-prompt-injection-papers/
- [S2] Nasr et al., "The Attacker Moves Second", arXiv:2510.09023 (why filters/classifiers are not a control) - https://arxiv.org/abs/2510.09023
- [S3] OWASP Top 10 for Agentic Applications for 2026 (published 2025-12-09) - https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/ ; ASI list read from the Promptfoo mirror (secondary) - https://www.promptfoo.dev/docs/red-team/owasp-agentic-ai/
- [S4] Munder Difflin, "The Agents Rule of Two: A Simple Safety Rule for Coding Agents" (autonomy inversely proportional to blast radius; reversible write may auto-execute with an audit entry) - https://munderdiffl.in/blog/agents-rule-of-two/
- [S5] this+that, "Let an agent do anything it can undo" (reversibility as a property of the action; "A send that notifies you and then holds for an hour gives you time to stop it") - https://www.thisandthat.chat/blog/let-an-agent-do-anything-it-can-undo
- [S6] TianPan.co, "The Compensating Transaction Your Agent Never Runs" (2026-07-05; saga/compensation tiers, durable append-only log before execution, idempotent compensations, dry-run for irreversible actions) - https://tianpan.co/blog/2026/07/05/the-compensating-transaction-your-agent-never-runs
- [S7] OWASP Cheat Sheet Series, "AI Agent Security" (auto-approve low-risk, bind approval to the exact action, rollback, idempotency, structured decision metadata incl. approval identifier and policy version, step-up for privilege changes) - https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html
- [S8] Ojewale & Venkatasubramanian, "Designing for Doubt: The Case for Informed Abstention in Autonomous Agents", arXiv:2606.02965 (2026-06-01, rev. 2026-08-03) - https://arxiv.org/abs/2606.02965
- [S9] Google Calendar API, Events resource (`status` writable: confirmed/tentative/cancelled; "Cancelled events will eventually disappear"; `etag`, `sequence`, `updated`, `creator.self`, `organizer.self`) and Events: update (`sendUpdates` all/externalOnly/none; "To do a partial update, perform a get followed by an update using etags") - https://developers.google.com/workspace/calendar/api/v3/reference/events ; https://developers.google.com/workspace/calendar/api/v3/reference/events/update ; conditional modification with `If-Match` / 412 - https://developers.google.com/workspace/calendar/api/guides/version-resources ; extended properties limits (key 44 chars, value 1024, 300 props / 32 kB) and `privateExtendedProperty` filter - https://developers.google.com/workspace/calendar/extended-properties
- [S10] nspady/google-calendar-mcp `src/tools/registry.ts` (`update-event`: `sendUpdates` default `"all"`, `attendees`, `extendedProperties`, `checkConflicts`, `modificationScope`; **no `status`**; annotations destructiveHint/idempotentHint) - https://raw.githubusercontent.com/nspady/google-calendar-mcp/main/src/tools/registry.ts
- [S11] nspady/google-calendar-mcp `src/handlers/core/UpdateEventHandler.ts` (uses `events.patch`; conditional `events.get`; no `If-Match`; no `sendUpdates` handling in the handler; no status path) - https://raw.githubusercontent.com/nspady/google-calendar-mcp/main/src/handlers/core/UpdateEventHandler.ts
- [S12] nspady/google-calendar-mcp releases (v2.6.3 "Latest", 2026-09-02; no status/etag/delete changelog lines) - https://github.com/nspady/google-calendar-mcp/releases
- [S13] Google, Calendar MCP tools reference `update_event` (calendarmcp.googleapis.com, Developer Preview; no `status`/`sendUpdates`/etag fields) - https://developers.google.com/workspace/calendar/api/v3/reference/mcp/tools_list/update_event
- [S14] Brightlume AI, "Shadow Mode Rollouts for AI Agents" (2026) - https://brightlume.ai/blog/shadow-mode-rollouts-ai-agents-pilot-production
- [S15] GAICC, "How to Govern AI Agents That Can Take Autonomous Actions" (dry-run mode: "produce the exact action they would have taken without executing it") - https://gaicc.org/blog/how-to-govern-ai-agents-that-can-take-autonomous-actions/
- [S16] Electron `dialog.showMessageBox([window,] options)` (modal when attached to a parent; `defaultId`, `cancelId`, `checkboxLabel`, `noLink`; returns `{response, checkboxChecked}`) - https://www.electronjs.org/docs/latest/api/dialog ; `BrowserWindow.isFocused()` / `isVisible()` / focus events - https://www.electronjs.org/docs/latest/api/browser-window
- [S17] Electron `Notification` (`actions` on macOS and Windows; `'action'` event with `actionIndex`; `toastXml` on Windows) - https://www.electronjs.org/docs/latest/api/notification
- [S18] electron/electron PR #48132 "feat: improve Windows Toast actions support" (buttons, select, replies; merged 2026-02-12; auto-backported to 40-x-y and 41-x-y, manual backports needed for 38/39; the v42.0.0 release notes list "Extended actions support for Windows notifications to include buttons, select dropdowns, and replies" with "Also in 40 (#49786), 41 (#49787)") - https://github.com/electron/electron/pull/48132 ; https://github.com/electron/electron/pull/49787 ; https://github.com/electron/electron/releases
- [S19] nspady/google-calendar-mcp `src/utils/field-mask-builder.ts` (`ALLOWED_EVENT_FIELDS` incl. `etag, updated, sequence, creator, organizer, status, extendedProperties, attendees, recurrence, recurringEventId`; `DEFAULT_EVENT_FIELDS` = id, summary, start, end, status, htmlLink, location, attendees, reminders, recurrence) - https://raw.githubusercontent.com/nspady/google-calendar-mcp/main/src/utils/field-mask-builder.ts (fetched 2026-09-28)
- [S20] nspady/google-calendar-mcp `src/handlers/core/ListCalendarsHandler.ts` (`convertCalendarToStructured` emits `accessRole`, `primary`, `id`, `summary` per calendar) - https://raw.githubusercontent.com/nspady/google-calendar-mcp/main/src/handlers/core/ListCalendarsHandler.ts (fetched 2026-09-28)
- [S21] Sibling v2 research (same tree, read 2026-09-28): `docs/research/v2-event-editing.md` (linked items, `event_revisions`, full private map, `CANCEL_MODE`, `item:undoChange`), `docs/research/v2-claude-cli-backend.md` (`--tools ""`, `--strict-mcp-config`, `system/init.tools` assertion), `docs/research/v2-image-events.md` (`from_image` / `image_unclear` badges, never-auto rule)
- Project sources: `docs/research/security-threat-model.md` (C-01..C-52, T1..T22), `docs/research/calendar-mcp.md` (tool schemas incl. `update-event` `sendUpdates` default `"all"`), `docs/ARCHITECTURE.md` sections 2, 5.4, 6.6, `src/main/exec/*` (`actionExecutor.ts` gate order, `rateLimiter.ts`, `buildCreateEventArgs.ts`), `src/main/mcp/*` (`adminClient.projectCalendars`, `writeClient` key list), `src/main/agent/toolGate.ts` (`RunCtx.blockedCalls`, `exposedTools`), `src/main/db/migrations.ts` (`trg_actions_state` v1 text, `rate_events`, `chats.is_known/force_known`), `src/shared/{types,settings,ipc,schemas}.ts` (`BADGES`/`BADGE_SEVERITY`, `ASSUMPTIONS`, `LIMITS`, `RATE_BUCKETS`, `AUDIT_KINDS`, `SettingsPatchSchema`, `IpcContext`), `package.json` (electron 44.4.3), `build-resources/calendar-mcp/package.json` (@cocal/google-calendar-mcp 2.6.3).
