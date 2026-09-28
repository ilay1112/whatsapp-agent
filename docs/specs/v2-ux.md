# UX + Visual Spec v2 - delta over `docs/specs/ux.md`

Status: spec for the v2 renderer lane **L9** (dashboard, cards, settings, onboarding, both locale files) and for the renderer-facing parts of L4 (`app/notifications.ts`, `app/autoDialog.ts`, tray line), L6/L10 (Connect card data), L7/L8 (voice and picture card data). Date: 2026-09-28.
Binding parents: `docs/ARCHITECTURE-v2.md` (B1-B32, I1'-I12, sections 6.1, 6.4, 7, 10, 11, 13) over `docs/ARCHITECTURE.md`; v1 visual/interaction spec `docs/specs/ux.md` (R2). Inputs: `docs/proposals/v2-ux.md`, `docs/research/v2-auto-mode-safety.md` 5.5/6, the live renderer sources under `src/renderer/src/**` and the live locale files `src/shared/locales/{en,he}.json`.

Reading rules:

- **This is a delta.** Everything in `docs/specs/ux.md` stands (tokens, three voices, date tab, card anatomy, focus-steal guard, no optimistic approvals, copy rules 15.1, accessibility 13) unless a section below replaces it. Section numbers `ux.md N` refer to the v1 spec.
- Precedence: `ARCHITECTURE-v2.md` > `ARCHITECTURE.md` > `docs/specs/contracts.md` (shapes) > this spec > `ux.md`. Known tensions are listed in the final section "Architecture concerns"; none is resolved here by deviating.
- **MUST / NEVER** = acceptance criteria for L9 (and the named lanes). Anything not drawn here is out of scope for v2.0: no audio playback (U-v2-6), no fourth dashboard list (C9), no auto-mode offer in onboarding, no in-app installer or login for any vendor CLI (B32), no picture zoom/gallery, no scope editing while a policy is live.
- Locale keys follow the **live file conventions**, not the v1 spec's illustrative keys: short badge labels live in `label.badge.<code>`, error decks in `errors.<CODE>.{title,body,action}`, single action verbs in `label.errorAction.<id>`, consent texts in `consent.<kind>.v<N>.{title,body,accept}`. New namespaces: `auto.*`, `activity.*`, `change.*`, `voice.*`, `image.*`, `cli.*`, `undo.*`.
- RTL wireframes are drawn mirrored with English placeholder labels (ux.md 4 rule 8); the Hebrew copy is in section 14. Where a Hebrew line is itself drawn, it is in logical order.
- Vendor facts re-checked on 2026-09-28 (read-only, nothing run): Claude Code native install command `irm https://claude.ai/install.ps1 | iex`, WinGet `winget install Anthropic.ClaudeCode` (no auto-update), manual update `claude update` (native/npm) or `winget upgrade Anthropic.ClaudeCode` (WinGet) - code.claude.com/docs/en/setup; Antigravity CLI install `irm https://antigravity.google/cli/install.ps1 | iex`, binary in `%LOCALAPPDATA%\agy\bin`, sign-in = first interactive `agy` opens the browser - antigravity.google/docs/cli/install. The Gemini CLI offers no subscription route (B14); the UI says so once and points at the two real routes.

---

## 0. What v2 adds to the screen, at a glance

```
+----------------------------------------------------------------------------------------------+
| WA Calendar Agent  (v) All running v  [dl Voice model 43 %  +1]          [|| Pause] [he|EN] [gear]
+----------------------------------------------------------------------------------------------+
| (i) Automatic mode - trial: 3 would have been added. [Turn on for real]  [Stop]              |  SetupStrip row (2.3)
+----------------------------------------------------------------------------------------------+
| (auto) Done automatically - last 7 days (2)                           [Pause]  [Hide v]      |  AutoStrip (3.1)
|   [Thu 24 Sep] Dentist  16:00-17:00   moved from 15:00 · 12 min ago      [Undo]  [Show]      |
|   [Mon 28 Sep] Coffee   09:00-09:30   added · 1 h ago                    [Undo]  [Show]      |
+----------------------------------------------------------------------------------------------+
| Needs reply  3                | In calendar  5               | Information missing  1        |
| Transcribing a voice note     |                              |                               |  queue line (3.7)
|  (0:42)...                    |                              |                               |
| +---------------------------+ | +--------------------------+ |                               |
| | Dana Levi     14:02  ...  | | | Yoav          Mon  ...   | |                               |
| | ,-----------------------. | | | [date] Meeting 17:00-18:00 |                               |
| | | (mic) Voice msg · 0:42 | | | | (v) Updated · rev 2      | |                               |  after a change (3.4)
| | | Transcript             | | | | [Undo]  [Open in calendar] |                               |
| | | let's move it to 5     | | | +--------------------------+ |                               |
| | '-----------------------' | |                              |                               |
| | Change: Wed 15:00 -> 17:00| |                              |                               |  ChangeLine (3.3)
| | [date] Meeting 17:00-18:00| |                              |                               |
| | - - Draft reply - - - - - | |                              |                               |
| | [Approve & send]          | |                              |                               |
| | [Approve change] [Keep 15:00] [Copy]                         |                               |
| | Not automatic: it came from a voice note or a picture        |                               |  reason line (3.2)
| +---------------------------+ |                              |                               |
+----------------------------------------------------------------------------------------------+
```

Three lists stay the only lists (C9). Every new thing is either a strip that disappears when idle, a new bubble kind inside the unchanged card, one new line on the card, or a settings group.

---

## 1. Design deltas (tokens, icons, the "four voices")

### 1.1 Voices

v1 has three voices: contact (sunken bubble), AI (dashed draft), app (flat chrome). v2 adds a **fourth reading of the first voice**: *the contact, as the app heard or read it* (voice transcript, text read from a picture). It is still untrusted (B27, I12) and must never look more authoritative than a quoted message. Rule (MUST):

- Transcripts and picture text are rendered **inside the contact bubble** (`--color-quote` surface, tail corner), never as app chrome and never as a draft.
- They carry an **app-authored header strip** (icon + app text such as "Voice message · 0:42") and a **dotted** 1 px `--color-line-strong` rule between header and text. Dotted (not dashed, not solid) is the visual code for "machine-transcribed contact text": solid = the contact typed it, dashed = the AI wrote it, dotted = a machine turned sound/pixels into text. It survives `forced-colors` (border-style is kept, ux.md 13.6).
- A fixed caution line in muted `--text-xs` under the text: "Transcribed on this computer - may contain mistakes" / "Read from the picture - may contain mistakes". App text, always shown, not a tooltip.

### 1.2 Colour

No new colour tokens. Mapping of the new states onto the v1 families:

| New thing | Family | Why |
|---|---|---|
| `automatic` chip, AutoStrip header icon | `--color-accent-soft` / `--color-accent` (info) | it happened; nothing to fix |
| `auto_shadow` chip | info, outlined (1 px dashed `--color-accent` border, no fill) | "would have" = hypothetical, visibly lighter than `automatic` |
| ChangeLine | text `--color-text`, arrow glyph `--color-text-muted` | trusted app text |
| `change_unclear`, `image_unclear` | amber (`--color-warn` on `--color-warn-soft`) | the app is handling it; check it |
| `from_image`, `image_unread` | info | a fact about the source |
| "Undone" chip | ok (`--color-ok` on `--color-ok-soft`) | the fail-safe direction succeeded |
| blocked undo lines | amber | nothing is broken; the user decides |
| Connect card "not installed / not signed in" state line | neutral text + amber icon | a setup step, not an error |
| `CLI_TOOLSET_MISMATCH`, `CLOUD_AUTH`, `CLOUD_OVERAGE` | red (needs one action) | ux.md 1.2 rule 4 |
| "Experimental" chip | `--color-warn-soft` + `--color-warn` text | an honest risk marker |

The accent fill stays reserved for the single primary approval button of a card (ux.md 2.1). **"Approve change" is outline** when "Approve & send" is also on the card; it is accent only when it is the card's only approval (a change with no reply to send). **Undo is never accent** (it is a quiet/outline button: undo is the cheap, calm direction, not the "normal path").

### 1.3 Icons (closed list grows from 22 to 27)

| New icon | Used by | Mirrored in RTL |
|---|---|---|
| `mic` | VoiceBubble header, voice raw card, settings row | no |
| `image` | ImageBubble header, picture placeholder, settings row | no |
| `undo` (counter-clockwise arrow) | Undo buttons, "Undone" chip | **yes** (it points "back" in reading direction) |
| `auto` (calendar leaf + small lightning-free spark: two concentric arcs) | `automatic` chip, AutoStrip header, tray line | no |
| `terminal` (rectangle + prompt caret) | Connect card install/sign-in rows | no |

No vendor logos, ever (B12). The ChangeLine arrow is a **text glyph** (`→` U+2192 in en, `←` U+2190 in he), `aria-hidden`, never an icon, never appended to button text (ux.md 1.3 still forbids arrows in buttons).

### 1.4 Motion

Unchanged. One addition: when an automatic write lands while the window is visible, its AutoStrip row gets the same 1.6 s accent inline-start edge as an arriving card; the strip does not animate open. Under `prefers-reduced-motion` the edge is static.

---

## 2. App shell deltas

### 2.1 Header and DownloadPill (replaces ux.md 5.3 labels)

The DownloadPill now serves **one downloader queue** of four kinds (B18, B19, `model:*` tier enum): `llm` (tiny/small/mid), `voice` (voice-hebrew / voice-multilingual / voice-lite; the 0.9 MB `voice-vad` file rides silently with the first voice tier and is never shown separately), `mmproj` (picture reading). The pill shows the **active** download plus a muted `+N` when more are queued.

```
[ dl  AI model 43 %  -  12 min ]   [ dl  Voice model 62 %  +1 ]   [ dl  Picture reading 8 % ]   [ ||  Paused 43 % ]   [ v  Checking file... ]   [ !  Download failed ]
```

Popover (click): one row per queued or active file, in queue order - name in plain words, size, state (Queued / Downloading N % / Paused / Checking file... / Failed + ErrorCode action), and Pause/Resume/Cancel per row. Order is fixed by main: the LLM tier always first (the product needs it), then voice, then picture reading. The renderer never reorders.

Names shown (never tier ids): AI model sizes as v1 (`download.tier.*`); "Voice model (Hebrew)" / "Voice model (all languages)" / "Voice model (lite)"; "Picture reading". Sizes are always interpolated from pinned bytes with the v1 formula (bytes / 2^30, one decimal, see concern C1).

`model:progress` carries `kind` + `tier`; `aria-valuetext` names the file: "Voice model, 62 percent, about 4 minutes left". Only completions are announced: "Voice model ready - voice notes will be transcribed." / "Picture reading ready."

### 2.2 Status panel sub-lines (extends ux.md 5.2; ARCH-v2 11)

Each of the three rows keeps **one sentence + at most one action**, and gains **at most one muted sub-line**. Where several facts apply, they are joined into that one line with " · " (never a second line):

| Part | Main sentence (new values) | Sub-line (joined with " · ", each fragment only when true) | Sub-line click |
|---|---|---|---|
| WhatsApp | unchanged | "Reading older messages: this chat only" / "Reading older messages: all chats" (only when `whatsapp.readTools.enabled`) | Settings > Working rules |
| AI | "Claude - your subscription - ready" / "Gemini - your subscription (experimental) - ready" / "Claude with an API key - ready" / v1 values; CLI states from `cli:getStatus` ("Claude - your subscription - not signed in") | "usage resets 15:40" (from `llm.quota.resetsAt`) · "Voice notes: ready / downloading 43 % / off" · "Pictures: ready / not downloaded / off" | Settings > AI |
| Calendar | unchanged + `CAL_UPDATE_UNAVAILABLE` row: "Changes to events are unavailable (component version)" | "Automatic mode: on - ends in 23 days" / "trial - 2 of 3 seen" / "paused - {reason}" / "off" (fragment omitted entirely when no policy has ever existed) | Settings > Automatic mode |

`CLOUD_QUOTA` (subscription): the AI row becomes amber, body "Your {{vendor}} usage limit is reached. It continues by itself at {{time}}. Chats wait as plain cards." (`{{time}}` from `llm.quota.resetsAt`, `HH:mm`, tomorrow's date when not today), action "Open usage page" (`external:open {target:'claude_usage'}`; for Antigravity: no web page is known, the action is "Open AI settings").

`CLOUD_OVERAGE`: red, body "Claude started using paid extra usage. The AI is paused so nothing is charged without you." action "Open AI settings" (where the overage switch lives; it calls `cli:setOverage`, which shows `cli.limits.overageConfirm*` as a main-owned native dialog before allowing - F11).

### 2.3 SetupStrip rows (extends ux.md 5.4; still max two rows, most blocking first)

Priority order (1 = most blocking). v1 rows keep priorities 1-3.

| # | Condition | Text (en) | Action(s) |
|---|---|---|---|
| 4 | Active cloud provider's consent is below the current version (after the v2 upgrade: `cloud_claude`/`cloud_gemini` v1 -> v2) | "Your approval is needed again for {{vendor}} - it now also covers voice-note transcripts and pictures." | Review (opens `ConsentDialog` v2) |
| 5 | Policy `paused` (any reason) | "Automatic mode is paused - {{reason}}." | Resume (focused click; `auto:resume {confirm:true}`) / Settings |
| 6 | Policy `shadow`, < 3 decisions | "Automatic mode - trial: {{seen}} of 3 decisions seen so far." | Review (Settings > Automatic mode) |
| 6 | Policy `shadow`, >= 3 decisions | "Automatic mode - trial: {{wouldAdd}} would have been added, {{wouldChange}} changed." | **Turn on for real** (`auto:endShadow {confirm:true}`) / Stop |
| 7 | Policy `on`, expires within 3 days | "Automatic mode ends in {{days}} days." | Renew (native dialog again) |
| 8 | Voice model downloading/queued and `voice.enabled` | "Voice notes: model downloading {{percent}} %." | - (the pill has the controls) |
| 9 | Policy `expired` in the last 7 days | "Automatic mode ended on {{date}}. Events wait for your approval again." | Renew / Hide |

Rows 5-9 have "Hide" (session memory only, like v1's calendar row); the fact stays in the status panel sub-line.

### 2.4 Tray (extends ux.md 12.1; lane L4/app)

Only while a policy is live (`shadow|on|paused`), one line is added under the status line:

```
| Open                                        |
| Active - Claude (your subscription) (grey)  |
| Automatic mode: on - click to pause         |   <- state 'on'
|---------------------------------------------|
| Pause processing                            |
```

| Policy state | Tray line | Click |
|---|---|---|
| `on` | Automatic mode: on - click to pause | `auto:pause {reason:'user'}` from main, no window, no dialog |
| `shadow` | Automatic mode: trial - click to stop | `auto:disable {reason:'user'}` |
| `paused` | Automatic mode: paused - open to resume | shows the window at Settings > Automatic mode (resume needs a focused click, B7) |

Status line values gain "Active - Claude (your subscription)", "Active - Gemini (your subscription)", "Active - Claude (API key)", "Active - Gemini (API key)". The tooltip is unchanged (a count only). Never a title, a name or a reason text beyond the fixed strings above.

### 2.5 Header queue line (extends ux.md 6.3)

`queue:changed {transcribing?: {seconds}}` replaces the "Needs reply" header line while a whisper job runs: "Transcribing a voice note (0:42)..." (duration as `m:ss`, `tabular-nums`, from the Ogg granule, B18). It never names the chat. When a CLI run is active the line stays "Analysing N chats...". Queued/running items are still never rendered as cards (v1 visibility rule).

---
## 3. Dashboard deltas

### 3.1 AutoStrip (`components/AutoStrip.tsx`, B11 door 2)

A collapsible region **above the three lists**, full content width, shown only when `auto:listWrites {sinceTs: now - 7 d}` returns at least one row whose `undo_state` is `available`, or a row written in the last 24 h (so a just-undone write is still visible as "Undone"). It is **not a list**: no counts in the list header area, no cards, no approvals. Data: `auto:listWrites`; refreshed on `auto:changed`.

LTR:
```
+----------------------------------------------------------------------------------------------+
| (auto) Done automatically - last 7 days (3)                              [Pause]  [Hide ^]   |
|----------------------------------------------------------------------------------------------|
|  +-----+ Dentist                    moved from Wed 15:00 · 12 min ago      [Undo]   [Show]   |
|  | Thu | 16:00-17:00                                                                         |
|  | 24  |                                                                                     |
|  +-----+                                                                                     |
|  +-----+ Coffee                     added · 1 h ago                        [Undo]   [Show]   |
|  | Mon | 09:00-09:30                                                                         |
|  | 28  |                                                                                     |
|  +-----+                                                                                     |
|  +-----+ Book club                  cancelled · yesterday      (v) Undone           [Show]   |
|  | Sat |                                                                                     |
|  +-----+                                                                                     |
+----------------------------------------------------------------------------------------------+
```
RTL (mirrored):
```
+----------------------------------------------------------------------------------------------+
|   [^ Hide]  [Pause]                              (3) Done automatically - last 7 days (auto) |
|----------------------------------------------------------------------------------------------|
|   [Show]   [Undo]      12 min ago · moved from Wed 15:00                   Dentist +-----+   |
|                                                                        16:00-17:00 | Thu |   |
|                                                                                    | 24  |   |
|                                                                                    +-----+   |
|   [Show]   [Undo]                 1 h ago · added                           Coffee +-----+   |
|                                                                        09:00-09:30 | Mon |   |
|                                                                                    +-----+   |
+----------------------------------------------------------------------------------------------+
```

Rules:

- **Header**: `auto` icon + "Done automatically - last 7 days ({{count}})"; "Pause" quiet button (only while the policy is `on`; `auto:pause`, no dialog, works unfocused); "Hide"/"Show" disclosure (`aria-expanded`, renderer memory only; default **open** while any row has Undo available, collapsed otherwise). Collapsed height 36 px.
- **Row** = compact `EventChip` (the date tab, 40 px wide variant) + title (`dir="auto"`, untrusted, rendered from the proposal at render time - B11, never from audit rows) + time range `<bdi>` + the **verb phrase** (app text) + relative time + actions. Max 5 rows visible; "Show all in Automatic activity" link below when more exist.
- **Verb phrase** by `auto_writes.kind` / change: `added`; `moved from {{when}}` (old start from `pre_json`, app-formatted); `place changed`; `cancelled`.
- **Actions by `undo_state`**:

| `undo_state` | Right side of the row |
|---|---|
| `available` | **Undo** (outline, `undo` icon) + **Show** (quiet) |
| (in flight) | "Undoing..." (spinner 12 px, both buttons disabled) |
| `undone` | chip "(v) Undone" (ok family) + Show |
| `expired` | muted "Undo no longer available" + Show |
| `blocked_changed` | amber line "You changed this in Google after it was added" + Show |
| `blocked_started` | amber line "It has already started" + Show |
| `failed` | red line "Could not undo" + **Try again** + Show |

- Undo = `auto:undo {autoWriteId}` (delegates to the single undo path, B10). Show = opens the item's sheet (`ui:navigate {view:'dashboard', itemId}` semantics; sheet focus rule ux.md 7 applies).
- The strip leaves the DOM entirely when nothing qualifies. It never shows fallback decisions or shadow decisions (those live on the cards and in Automatic activity).
- One-column layout (< 900 px): the strip sits above the three disclosure sections, same content, rows wrap: actions drop under the verb phrase.

### 3.2 Card chips and the "Not automatic" line (B11 door 3)

`ItemVM.auto` (section 12) drives three things on an ordinary card; nothing else about the card changes.

| Situation | Where | What (en) |
|---|---|---|
| Automatic write done | chip row under the EventChip (`scope:'event'`) | `automatic` chip: "Added automatically" / "Moved automatically" / "Cancelled automatically" (by kind) |
| Shadow decision (trial) | same | `auto_shadow` chip: "Would have been automatic" (dashed outline) |
| Fallback while a policy is live | **one muted `--text-xs` line directly under the button rows** | "Not automatic: {{reason}}" - reason sentence from `auto.reason.<AUTO_REASON>` (section 14.3) |

Rules: the reason line appears **only** while a policy is live (`shadow|on|paused`) and only on cards with a pending `create_event`/`update_event`; it is app text (never model text, never fed back to a model - B8); it is `aria-describedby`-linked to the calendar approval button. `policy_shadow` never renders as a line (the chip covers it). An `automatic` item lives in "In calendar" like any created event and carries the same Undo as 3.4.

Card overflow menu `[...]` gains **"Never automatic for this contact"** (`chat:setPolicy {chatRef, autoPolicy:'never'}`, B28) - shown only while a policy is live or has existed; in-window toast "Automatic changes turned off for this contact - Undo" (6 s, `autoPolicy:'inherit'` on Undo). When `auto_policy='never'` the item reads "Automatic for this contact: never - [Allow again]" in the same menu.

### 3.3 Change card (D-036, B20, ARCH-v2 7 "Cards")

A delta item is the ordinary open item of the chat, in **Needs reply**, linked to its source `in_calendar` item. Card anatomy = ux.md 6.5 with one new row, the **ChangeLine**, between the bubble and the EventChip. The EventChip shows the **new** slot (`to`); the inline editor edits `to` only (I3').

#### 3.3.1 Reschedule / move

LTR:
```
+--------------------------------------------------+
| Dana Levi                            14:02  [...]|
| +972 54-555-0142                                 |
| ,----------------------------------------------. |
| | can we do 5 instead of 3?                     | |
| '----------------------------------------------' |
| Change: Wed 15:00 -> 17:00                       |   ChangeLine (app text; each side in <bdi>)
| +-----+ Meeting                                  |   EventChip = the NEW slot
| | Wed | 17:00-18:00                              |
| | 23  | Cafe Noir                                |
| +-----+ (~) 5 taken as 17:00                     |
| - - Draft reply - - - - - - - - - - - - - - - -  |
| | Sure, 17:00 works. See you then.             | |
| '----------------------------------------------' |
| [Approve & send]                                 |   accent
| [Approve change]     [Keep 15:00]       [Copy]   |   outline / quiet / quiet
+--------------------------------------------------+
```
RTL:
```
+--------------------------------------------------+
|[...]  14:02                            Dana Levi |
|                                 0142-555-54 972+ |
| ,----------------------------------------------. |
| |                     ?can we do 5 instead of 3 | |
| '----------------------------------------------' |
|                    Change: Wed 15:00 <- 17:00    |   he: "שינוי: יום רביעי 15:00 ← 17:00"
|                                  Meeting +-----+ |
|                              17:00-18:00 | Wed | |
|                                Cafe Noir | 23  | |
|                     5 taken as 17:00 (~) +-----+ |
|  - - - - - - - - - - - - - - - - Draft reply - - |
|                                 [Approve & send] |
|   [Copy]       [Keep 15:00]     [Approve change] |
+--------------------------------------------------+
```

ChangeLine forms (all app-rendered from `delta_json` via `Intl`; the only untrusted values are title/location, wrapped in `<bdi dir="auto">`):

| `change` | en | he |
|---|---|---|
| reschedule, same day | Change: Wed 15:00 -> 17:00 | שינוי: יום רביעי 15:00 ← 17:00 |
| reschedule, other day | Change: Wed 23 Sep 15:00 -> Thu 24 Sep 17:00 | שינוי: יום רביעי 23 בספט׳ 15:00 ← יום חמישי 24 בספט׳ 17:00 |
| move | Place: Cafe Noir -> Office | מקום: Cafe Noir ← Office |
| cancel | Cancel: Meeting, Wed 15:00 | ביטול: Meeting, יום רביעי 15:00 |

The arrow glyph is `aria-hidden`; the line's accessible text is a full sentence: "Change from Wednesday 15:00 to 17:00" / "שינוי: 17:00 במקום יום רביעי 15:00". Each side is its own `<bdi>`, so in Hebrew the old value is read first (at the right) and the arrow points at the new value (left).

Buttons (only when the matching pending `update_event` exists, ux.md 6.7 rule):

| Situation | Primary (accent) | Secondary | Quiet |
|---|---|---|---|
| change + draft | Approve & send | **Approve change** (outline) | **Keep {{oldTime}}** (`action:reject {actionId}` of the `update_event`), Copy, [...] |
| change only (no reply needed) | **Approve change** | - | Keep {{oldTime}}, [...] |
| move | as above; "Keep {{oldTime}}" becomes "Keep the old place" | | |
| cancel | Approve & send (if draft) | **Cancel event** (outline; danger text colour, never danger fill) | **Keep it**, Copy, [...] |

Flow copy (an action keeps its name): Approve change -> "Changing..." -> "(v) Changed in calendar"; Cancel event -> "Cancelling..." -> "(v) Cancelled in calendar"; Keep -> the change leaves the card, the draft stays.

#### 3.3.2 `change_unclear`

Amber badge `change_unclear` ("Not sure this changes the event") under the ChangeLine slot (no ChangeLine is drawn because there is no delta), **no change buttons**; the draft asks the contact (S3 rule). The card otherwise behaves as a v1 Needs-reply card.

#### 3.3.3 While a change is pending: the source card

The source `in_calendar` card keeps its place and gains a muted chip **"Change proposed - see Needs reply"** (a button: focuses the delta card, `scrollIntoView`, moves keyboard focus to its root). The renderer keys the In-calendar list by `calendar_event_id` so one event is never drawn twice (B20). Scope note under the chip in the sheet only: "Changes apply to the latest event of this chat."

#### 3.3.4 Inline results for `update_event` (extends ux.md 6.8 table)

| Result | Row text (en) | Action(s) |
|---|---|---|
| `needs_confirm_drift` | In Google it is now {{when}} - apply the change anyway? | **Apply anyway** (`confirmDrift:true`, outline) / **Keep Google's** (reject) |
| HTTP 412 (manual) | same as drift (ARCH-v2 7) | same |
| `CAL_EVENT_GONE` | The event is no longer in your calendar. | **Add as new event** (the pending `create_event` the executor inserted) |
| `CAL_EVENT_FOREIGN` | This event was not added by the agent - change it in Google Calendar. | - (info tone, no action; "Open in calendar" stays available) |
| `CAL_UPDATE_FAILED` | The change was not saved. Nothing in your calendar changed. | Try again |
| `ACTION_STALE` (base revision moved) | This card changed - review again. | Refresh card |
| `unknown_outcome` | We could not confirm this - check your calendar. | Apply again (new action, new click) |
| `CAL_UPDATE_UNAVAILABLE` | (no update action exists; the card falls back to the v1 `change_in_google` info chip "Change or cancel it in Google Calendar") | - |

"Apply anyway", "Add as new event", "Apply again" are outline, never accent, and are behind the focus-steal guard.

### 3.4 After a change lands: Updated / Cancelled + Undo (B10, I8)

The acting item becomes the `in_calendar` card; the source closes `superseded`. EventChip header states (extends ux.md 6.4):

| `event_state` | Date-tab header | Line under the time |
|---|---|---|
| `created` | `--color-ok` | (v) In calendar |
| `updated` | `--color-ok` | (v) Updated · rev {{n}} |
| `cancelled` | `--color-line-strong`, title struck through (`text-decoration: line-through`, plus the text "Cancelled", never colour or strike alone) | Cancelled |

```
+--------------------------------------------------+
| Yoav Ben-Ami                         Mon    [...]|
| +-----+ Meeting                                  |
| | Wed | 17:00-18:00                              |
| | 23  | (v) Updated · rev 2   (auto) Moved automatically
| +-----+                                          |
| [Undo]            [Open in calendar]             |   Undo = outline with undo icon; Open = outline
| Undo available until Wed 17:00                   |   muted, --text-xs (undo_until)
+--------------------------------------------------+
```

Undo button rules:

- Shown while the newest `event_revisions` row of the event has `reverted_by IS NULL` and the window is open: **automatic** writes `undo_until = min(written_at + 72 h, start)`; **manual** changes until the event starts or 7 days, whichever first (B10). A muted line states the deadline.
- Click = `item:undoChange {itemId, revisionId}` (trusted frame, focused window, focus-steal guard - same gate as approve). No confirm dialog: undo is the fail-safe direction and is itself undoable while the window lasts.
- Flow: "Undo" -> "Undoing..." -> chip "(v) Undone" (1.2 s confirmation row, then the list refreshes; the reverted state becomes the card's state).
- Undo of a create = the event becomes `cancelled` ("Undone - removed from your calendar"); undo of a cancel = restored ("Undone - back in your calendar").
- Blocked outcomes (inline rows, amber):
  - `blocked_changed`: "You changed this event in Google after it was added - undo would overwrite your change." + "Open in calendar".
  - `blocked_started`: "The event has already started - undo is not available." + "Open in calendar"; a **Cancel event** button (explicit click, `item:cancelEvent {itemId}` - resolved C9, F32). After two automatic edits of one event the card and the AutoStrip row also show **Restore original** (`item:restoreOriginal`, F1; he: "החזרת המועד המקורי").
  - Restore refused (U-E1): "Google did not restore the cancelled event." + **Add it back** (the pending `create_event`; a normal user approval).
- A cancelled card leaves the list 24 h later (`past`).

### 3.5 VoiceBubble (`components/VoiceBubble.tsx`, B18)

Replaces `QuotedBubble` when `trigger.kind === 'voice'` (and inside the sheet's conversation for every voice row that has a transcript).

LTR:
```
,--------------------------------------------------.
| (mic) Voice message · 0:42               Hebrew   |   app header: icon, label, m:ss (tabular), language chip
| . . . . . . . . . . . . . . . . . . . . . . . . . |   dotted rule = machine-transcribed
| let's move it to 5, I'm busy until then          |   transcript: msg-text, dir="auto", lang from transcript, 3-line clamp
| Transcribed on this computer - may contain        |   muted --text-xs, fixed app text
| mistakes                                Show more |
'--------------------------------------------------'
```
RTL:
```
,--------------------------------------------------.
|   Hebrew               0:42 · Voice message (mic) |
| . . . . . . . . . . . . . . . . . . . . . . . . . |
|        בוא נזיז ל-5, אני עסוקה עד אז              |   (Hebrew text shown in logical order)
|            Transcribed on this computer - may     |
| Show more                        contain mistakes |
'--------------------------------------------------'
```

States (the item is not listed while queued/running - the header line of 2.5 covers it):

| Transcript state | Bubble content | Card |
|---|---|---|
| `done` | as drawn | normal analysed card |
| `empty` | header + muted "No speech detected" (no dotted rule, no caution line) | raw card, no analysis (an empty transcript is never a trigger), actions Copy/[...] |
| `failed` / `aborted` | header + muted "Not transcribed" | raw card with the ErrorCode chip and its one action (section 10) |
| model missing | header only | raw card, hold chip "Voice notes: model not downloaded" + **Download ({{size}})** or, when off, **Turn on in Settings** |
| too long | header "Voice message · 17:05" + "Longer than 15 minutes - not transcribed" | raw card, no action |

Language chip: "Hebrew" / "English" / "Other language" from `transcripts.language` (`he` / `en` / anything else); the transcript node gets `lang="he|en"` only for those two. No play button (U-v2-6). Transcript text is inert (no links, no emoji enlargement) and **never** appears in toasts, tray, window title, `aria-live` announcements or file names (B27).

Sheet: the conversation block renders voice rows with the full transcript (no clamp) and the caution line "Transcribed on this computer with the {{model}} voice model - may contain mistakes" ("Hebrew", "all-languages", "lite"). Retention: once `transcripts.text` is nulled, the bubble says "Transcript was removed after {{days}} days" (v1 retention sentence pattern).

### 3.6 ImageBubble (`components/ImageBubble.tsx`, B19)

Replaces `QuotedBubble` when `trigger.kind === 'image'`.

LTR:
```
,--------------------------------------------------.
| (image) Picture                                   |   app header
| . . . . . . . . . . . . . . . . . . . . . . . . . |
| +--------+  Text read from the picture            |   thumbnail 96 x 96 (object-fit: cover, radius-sm)
| | thumb  |  Dana & Yossi's wedding · Thursday     |   readText: msg-text, dir="auto", 3-line clamp, inert
| |  96px  |  24.9.26 · reception 19:00 · ...       |
| +--------+                              Show more |
| Read from the picture - may contain mistakes      |
'--------------------------------------------------'
+-----+ Dana & Yossi's wedding
| Thu | 19:00-20:00
| 24  | (i) Read from a picture   (~) Hard to read - check the picture
+-----+
```
RTL: thumbnail at the inline-start (right), text to its left; the thumbnail is never mirrored (it is a picture).

- Thumbnail: the 320-px data URL from the VM (`ItemVM.image.thumbDataUrl`), displayed at 96 px; `alt` = "Picture sent by {{name}}" (`<bdi>` rule does not apply to attributes; the name is inserted as plain text); **not a link**, not draggable (`draggable="false"`), no context-menu "open image".
- Badges (section 14.2): `from_image` (info, always), `image_unclear` (amber, a button that opens the sheet with the Date field focused - like `time_assumed`), `manipulation` (red) when V1 flagged `suspicious`.
- **Placeholder card** "Photo" (`image_unread`, info) when the picture was not read, with exactly one action by cause:

| Cause | Chip text | Action |
|---|---|---|
| local reading not downloaded | Picture not read - picture reading is not downloaded | **Download picture reading ({{size}})** -> `model:startDownload {tier:'mmproj'}` |
| `images.enabled === false` | Picture not read - turned off | **Turn on in Settings** (Settings > AI > Pictures) |
| provider cannot read pictures and no local reading | Picture not read by this AI | **Choose an AI that can read pictures** (Settings > AI) |
| `MEDIA_UNAVAILABLE` | The picture was not received | **Try again** (`item:retriage`) |
| V1 failed (`LLM_BAD_OUTPUT`) | Could not read the picture | **Analyse again** |

A text-only analysis still runs (V1 failure never blocks S1), so the placeholder may carry a normal draft and EventChip underneath.

- Sheet: section **"The picture"** above the conversation: the normalised image from `item:getImage {itemId}` (lazy, on sheet open), max 360 px, `object-fit: contain`, same `alt`; below it a disclosure **"What the AI read from the picture"** (open by default when `image_unclear`) with the full `readText` in a dotted-rule bubble and three app-labelled lines whose *values* are untrusted literals from `image_json`: "Date as written: {{v}}", "Time as written: {{v}}", "Place as written: {{v}}" (`<bdi dir="auto">`; "-" when empty). When `image_unclear`, the EventEditor's Date field shows the hint "Check against the picture" (`aria-describedby`).
- Thumbnails and the cached picture disappear at once on Dismiss / "Never analyse" and with the 30-day retention; the bubble then says "Picture was removed after {{days}} days" / nothing (dismissed items are gone).

### 3.7 Sheet deltas (extends ux.md 7)

- Conversation block: voice rows = VoiceBubble (full), image rows = compact ImageBubble without thumbnail when not the trigger ("Picture" header + read text if any), the trigger picture = section "The picture" above.
- Event block for a delta item: a read-only "Now in your calendar" line (the `from` values, app-rendered) above the editable fields of `to`; the editor has no Calendar/target controls (the target is pinned, I3').
- Footer provenance (ux.md 7.4) values: "Suggested by: AI on this computer" / "Claude (your subscription)" / "Gemini (your subscription, experimental)" / "Claude (API key)" / "Gemini (API key)"; a shadow/automatic item adds "· Automatic mode: {{state}}"; an unproven CLI run adds nothing visible (the `provider_unsafe` reason line already says it).
- An automatic item's sheet shows an **"Automatic"** block at the top: "Added automatically on {{when}}" + the Undo control of 3.4 + link "See all automatic activity".

---

## 4. Settings deltas (extends ux.md 9)

Group order (additions in bold): General - **AI engine** (provider cards + **Voice notes** + **Pictures**) - WhatsApp - Google Calendar - **Automatic mode** - Working rules - Replies - Privacy and data. **Automatic activity** is a sub-page reached from the Automatic mode group (and from the AutoStrip "Show all" link); it is not a group in the in-page nav. `SettingsGroup` gains `'auto'`; `initialGroup` accepts `'auto' | 'activity'`.

General > Notifications gets a second description line: "Automatic calendar changes always show a notification, even when this is off." (B11).

### 4.1 AI engine: provider cards (B12)

Radio cards in this order, stacked, privacy note always visible (ux.md 8.1 anatomy):

```
|  AI engine                                                                                   |
|  (o) On this computer                                                      Recommended       |
|      (shield) Your messages never leave this computer.                                       |
|      Standard model - ready - speed: good                   [Test again] [Delete model]      |
|                                                                                              |
|  ( ) Claude - your subscription                                                              |
|      Uses the Claude plan you already pay for, through the Claude Code you installed.        |
|      No API key.                                                                             |
|      (shield) The analysed chat is sent to Anthropic through your own sign-in - without      |
|               names or phone numbers.                                                        |
|      [ Connect card body, section 7 ]                                                        |
|                                                                                              |
|  > Show experimental                                                                         |
|  ( ) Gemini - your subscription   [Experimental]                                             |   only after "Show experimental"
|      [ Connect card body + risk disclosure, section 7.4 ]                                    |
|                                                                                              |
|  > Advanced: use an API key                                                                  |
|  ( ) Claude with an API key        (shield) ...           (v1 card body)                     |
|  ( ) Gemini with an API key        (shield) ...           (v1 card body)                     |
|      Use this if you do not have a subscription or the subscription route stops working.     |
```

- "Show experimental" and "Advanced" are disclosure buttons (`aria-expanded`), collapsed by default, **open automatically when the active provider is inside them**.
- Selecting a card never switches the provider by itself: switching = `llm:setProvider`, which requires (B12) exe found + version floor + consent at the exact version + a smoke init within 24 h for CLI providers. The card's primary button says what it does: **"Use Claude - your subscription"**; disabled with its reason in a `--text-xs` line until the Connect card is Ready ("Finish the steps above first"). Never a silent fallback (A20): if the active CLI provider breaks, the card shows the ErrorCode row and the provider stays selected.
- Model rows: Claude subscription = editable combobox (`llm.cli.claudeModel`, regex-validated, presets "sonnet (recommended)", "haiku", "opus" listed as hints with the line "as available on your plan"); Antigravity = select filled from `llm:listModels {provider:'antigravity_cli'}` ("as reported by the CLI"), default `gemini-3.8-flash-high`.
- CLI limits (collapsed "Usage limits" disclosure under the subscription cards, both CLIs share it - `llm.cli`):
  - "Up to {{n}} AI runs per hour" - number 1..60, default 20. Description: "Your subscription's usage window is shared with your own use of {{vendor}}."
  - "Allow paid extra usage" - toggle, default **off**. Description: "When off, the AI pauses as soon as your plan starts charging for extra usage." Turning it on opens a v1-style confirm dialog: title "Allow paid extra usage?", body "When your plan's included usage runs out, Anthropic may charge you for the AI's runs.", buttons "Allow" / "Keep it off" (initial focus on "Keep it off").
  - "Claude Code location" - read-only path of the resolved exe with "Change..." (native file picker in main; must end in `claude.exe`, B23) and "Use automatic" to reset to `''`.
- The v1 "Daily cloud limit" row stays, and now says "(API keys only)".

### 4.2 AI engine > Voice notes (B18, B23)

```
|  Voice notes                                                                                 |
|    Voice notes are always transcribed on this computer. Nothing is sent anywhere.            |
|    ( ) Off                                                                                   |
|    (o) Hebrew-optimised (recommended)            1.5 GB   - ready                            |
|    ( ) Any language, detected automatically      0.8 GB   - not downloaded                   |
|    ( ) Lite - faster, less accurate               0.2 GB   - not downloaded                   |
|    Speed on this computer: about 20 s per minute of audio       [Test]                       |
|    (i) Slow on this computer - the Lite model is faster.       (only when > 2x realtime)     |
```

- One radio group bound to `voice.enabled` + `voice.tier` (`Off` = `enabled:false`). Choosing a tier whose file is missing asks inline first: "Download the Hebrew-optimised voice model (1.5 GB)?" [Download] [Cancel] - never downloads on a mere radio focus. The chosen tier is active only when ready; until then the row says "Downloading 43 % - voice notes wait as plain cards".
- Per-option status: not downloaded / queued / downloading N % / checking file... / ready / failed (+ ErrorCode action) / "not enough disk space" (DISK_FULL action). A ready, unselected tier offers "Delete" (confirm dialog naming the size).
- `Test` = `voice:selfTest` (bundled 5 s fixture): "Testing..." -> "about {{seconds}} s per minute of audio". The app **never** switches tier automatically; the Lite suggestion is a sentence with a "Use Lite" button.
- Fixed facts shown as text, not controls: "Notes longer than 15 minutes are not transcribed." (`maxMinutes` is a literal).
- "Threads" stays automatic and is not shown (B23 allows `'auto'`; a number is an advanced JSON edit only - out of scope for the UI).

### 4.3 AI engine > Pictures (B19)

```
|  Pictures                                                                                    |
|    Read pictures                                                          ( o )  on          |
|      Dates and places written in a picture (an invitation, a poster) become event            |
|      suggestions. What was read is always shown on the card.                                 |
|    Read pictures with Claude                                             ( o )  on           |   only when the active provider can read pictures
|      Pictures are sent to Anthropic. Agreed on 28 Sep 2026.  [Withdraw]                       |
|    Picture reading on this computer                0.9 GB - not downloaded   [Download]       |
|      Used when the cloud AI does not read pictures. Downloads only when you ask or when the   |
|      first picture arrives and you click Download.                                           |
```

- "Read pictures" = `images.enabled`. "Read pictures with {{vendor}}" = `images.cloud`; shown only when the active provider has `capabilities.images` and is a cloud provider; its description names the consent date from `consent:get` (the v2 consent text is the gate, B21). For `antigravity_cli`: the row is replaced by the fixed line "With this AI, pictures are read on this computer." (B14).
- Local picture reading: size from the pinned projector of the **current** tier; states not downloaded / queued / downloading / ready / failed. After download or when toggling "Read pictures" with the projector present, the local AI restarts (B19): inline note "The AI on this computer restarts to load picture reading (about 30 seconds)." and the AI status row shows "starting".

### 4.4 Google Calendar group

Adds one read-only line under "Calendar for new events": "You own this calendar" / "This calendar is shared with you - automatic mode is not available for it" (from `meta.calendar_roles_json`, B7). No other change.

### 4.5 Automatic mode group (B7, B9, I10; `views/settings/AutomaticMode.tsx`)

LTR (policy off, preconditions met):
```
|  Automatic mode                                                                              |
|  +------------------------------------------------------------------------------------------+|
|  | Off - events wait for your approval.                                                     ||   state card (one line + actions)
|  +------------------------------------------------------------------------------------------+|
|  The agent adds and changes events in "Family" by itself. Replies always wait for you.       |
|                                                                                              |
|  What happens without asking you              What never happens                             |
|  - only with people you have written to,      - deleting an event                            |
|    in chats where you wrote in the last day   - inviting anyone                              |
|  - within the next 30 days, 5 min to 4 hours  - sending a WhatsApp message                   |
|  - up to 3 per contact a day, 15 a day        - anything from a voice note or a picture      |
|  - each one shows a notification with Undo    - anything the AI was unsure about or that     |
|  - replies still wait for your approval         carries a warning                            |
|  - ends by itself after 30 days               - changing events the agent did not add        |
|                                                                                              |
|  Also change events when the contact asks                                 ( o )  on          |
|  Also cancel events when the contact asks                                 ( o )  off         |
|    A cancelled event stays restorable - Undo brings it back.                                 |
|  Not during quiet hours (22:00-07:00)                                     ( o )  on          |
|  Ends after                                                     [ 30 days v ]  (30 / 90)     |
|                                                                                              |
|                                      [ Start a 24-hour trial ]   [ Turn on now ]             |
|  See automatic activity                                                                      |
```
RTL: the two columns swap sides (the "happens" column at the right), toggles at the left, the two buttons at the bottom left with "Start a 24-hour trial" at the inline-end (rightmost of the pair), link at the right.

State card by `auto_policies.state` (data: `auto:getState`):

| State | Line | Actions |
|---|---|---|
| none / `disabled` | Off - events wait for your approval. | (the two enable buttons below the lists) |
| `expired` | Ended on {{date}}. Events wait for your approval. | Renew (= enable flow again, fresh dialog) |
| `shadow` < 3 decisions | Trial until {{time}} - {{seen}} of 3 decisions seen. Nothing is changed for real. | Stop |
| `shadow` >= 3 | Trial until {{time}}: {{wouldAdd}} to add, {{wouldChange}} to change. You approved {{same}} of them unchanged. Nothing was changed for real. | **Turn on for real** (`auto:endShadow {confirm:true}`, focused click) / Stop |
| `on` | On - {{used}} of {{limit}} today · ends in {{days}} days. | Pause / Stop / Renew (only in the last 7 days) |
| `paused` | Paused - {{reason}}. | Resume (`auto:resume {confirm:true}`, focused window) / Stop |

- **Stop** = `auto:disable {reason:'user'}`, **Pause** = `auto:pause`, both one click, no dialog, work unfocused (fail-safe direction, I10). Manual approvals keep working in every state.
- The shadow tally is never started or ended by the app: when `shadow_until` passes, the state card keeps the tally and the "Turn on for real" button; nothing switches itself on.
- **Preconditions** (from `auto:getState`, see concern C5) replace the two enable buttons with one sentence each, in this priority: calendar not connected ("Connect Google Calendar first." + Connect); calendar not owned ("Only for a calendar you own - '{{calendar}}' is shared with you."); track record < 3 ("Available after you approve 3 events yourself ({{count}} of 3 so far)."); rate limit 3/h ("Try again in an hour."). With `antigravity_cli` active the buttons stay enabled but a warning line reads "With Gemini - your subscription (experimental) nothing will happen automatically; every event will wait for you." (B14/C4, concern C4).
- **Scope controls** (edits, cancels, quiet hours, validity) are editable only while no policy is live; while live they render read-only with "To change these, stop automatic mode and turn it on again." (no scope-update IPC exists - concern C6). The ceilings in the left list are fixed text in v2.0.
- The two enable buttons call `auto:requestEnable {scope, trial}` (`trial:true` for "Start a 24-hour trial" - listed first at the inline-end as the recommended path; "Turn on now" is the other outline button; **neither is accent**, because nothing is approved by them - the native dialog is where the decision is made). Both are behind the focus-steal guard; main additionally requires a focused, visible window (B7). The renderer shows "Waiting for your answer in the Windows dialog..." while the dialog is up; the result is either a new state card (success) or the ErrorCode line (`AUTO_NOT_CONFIRMED`: "Automatic mode was not turned on." - no action; the others per section 10).
- **Per-contact**: Working rules > "Chats with their own rule" (ux.md 9) gains a column "Automatic" with a select "As everyone" / "Never" (`chat:setPolicy {chatRef, autoPolicy}`).

#### 4.5.1 The native dialog (main-owned, `app/autoDialog.ts`; text from main's i18n instance)

`dialog.showMessageBox(win, {type:'warning', noLink:true, defaultId:0, cancelId:0, checkboxLabel, buttons})` (B7). Copy (both locales, parity test):

| Field | en | he |
|---|---|---|
| title | Turn on automatic mode? | להפעיל מצב אוטומטי? |
| message | Events will be added to and changed in '{{calendar}}' without asking you first. | אירועים יתווספו ליומן '{{calendar}}' וישתנו בו בלי לשאול אותך קודם. |
| detail | the six "What happens without asking you" bullets, one per line, prefixed "- " (same keys as the settings list; no information appears only in the dialog), then an empty line and "Ends on {{date}}." | same, Hebrew keys; "יסתיים ב-{{date}}." |
| checkboxLabel | I understand events can be added or moved without asking me | ידוע לי שאירועים יתווספו או יזוזו בלי אישור ממני |
| buttons[0] (default, cancel) | Cancel | ביטול |
| buttons[1] trial | Start a 24-hour trial | התחלת ניסיון של 24 שעות |
| buttons[1] now | Turn on now | הפעלה עכשיו |

`{{calendar}}` is a Google calendar name (user-owned but external text): main wraps it in U+2068 FIRST STRONG ISOLATE ... U+2069 POP DIRECTIONAL ISOLATE and truncates it at 60 characters, because a native dialog has no `<bdi>`. Accepted only with `response === 1 && checkboxChecked`. Renew uses the same dialog with title "Renew automatic mode?" / "לחדש את המצב האוטומטי?" and button "Renew for {{days}} days" / "חידוש ל-{{days}} יום".

### 4.6 Automatic activity page (`views/AutoActivity.tsx`, B11 door 4)

Reached from Settings > Automatic mode "See automatic activity" and the AutoStrip "Show all" link. Header row "< Automatic mode" back link + title "Automatic activity".

```
|  < Automatic mode        Automatic activity                               [Export (JSON)]     |
|                                                                                              |
|  On · 4 of 15 today · ends in 23 days                                         [Pause]        |
|  Today                                                                                       |
|  +-----+ Dentist                  moved from Wed 15:00 · 14:10    (auto)  [Undo]  [Show]     |
|  | Thu | 16:00-17:00                                                                         |
|  +-----+                                                                                     |
|  ,----------------------------------------.                                                  |
|  | Not automatic · 13:02 · Yoav Ben-Ami   |   fallback row: contact name <bdi>, reason, Show |
|  | the hour was assumed            [Show] |                                                  |
|  '----------------------------------------'                                                  |
|  Yesterday                                                                                   |
|  ...                                                                                         |
|  Older entries are kept for 180 days (decisions for 90 days).                                |
```

- Per-day groups (`auto:listWrites {sinceTs}` + decisions), newest first, 30 days per page with "Show older". Row kinds: **write** (same row as the AutoStrip, with its `undo_state` right side), **shadow** ("Would have been added" / "... changed", no Undo - nothing was written), **fallback** ("Not automatic" + reason sentence). Titles/names are untrusted and rendered inside the row as `dir="auto"` / `<bdi>`, never in headings.
- "Export (JSON)" = `auto:export` (metadata only - B11); after save, in-window toast "Exported". The export file never contains titles or names (main enforces; the UI says "Times, kinds and reasons only - no titles, names or messages.").
- Empty: "Nothing happened automatically yet."

### 4.7 Working rules: "Let the AI read older messages" (B17, ARCH-v2 8)

```
|  Let the AI read older messages                                                              |
|    The AI can look further back when a message refers to something said earlier.             |
|    ( ) Off                                                                                   |
|    (o) Of this chat only                                              (recommended)          |
|    ( ) Of all my chats                                                                       |
|        With a cloud AI this sends parts of other chats to {{vendor}}.                        |
|    How far back                         [=====o---------]  30 days                           |
```

- Binding: Off = `readTools.enabled:false` (`settings:set`); the two radios call **`wa:setReadScope {scope}`** - never `settings:set` (F11): "Of all my chats" first shows a main-owned native confirmation, "Of this chat only" is one click without a dialog. Selecting "Of all my chats" while a cloud provider is active opens the `ConsentDialog` at v2 (`cloud_claude`/`cloud_gemini`) or the CLI consent, and **refuses** (radio snaps back, inline "Not changed - your approval is needed first.") until accepted.
- With `antigravity_cli` the row adds "With this AI the app hands over the last {{days}} days of this chat instead; the AI cannot look further by itself." (B14 prefetch).
- Slider: 1..90 days, step 1, default 30 (`windowDays`), `role="slider"` with `aria-valuetext` "30 days"; the value text is not mirrored; the track fills from inline-start.

### 4.8 Privacy and data: "What leaves this computer" (extends the v1 table)

| Service | What is sent | Who receives it |
|---|---|---|
| AI on this computer | Nothing | Nobody |
| Claude - your subscription | The text of the chat being analysed, without names or phone numbers; transcripts of voice notes; pictures when "Read pictures with Claude" is on; older messages of this chat (or of all chats if you chose that) | Anthropic, through your own Claude Code sign-in |
| Gemini - your subscription (experimental) | The same text, voice transcripts and older messages; never pictures. Antigravity also keeps a copy of each request on this computer. | Google, through your own Antigravity sign-in |
| Claude / Gemini with an API key | as the v1 rows + transcripts, pictures (when on), older messages | Anthropic / Google |
| Voice notes | Nothing - transcribed on this computer | Nobody |
| Google Calendar | v1 row + "changes and cancellations you approved or that automatic mode made" | Google |
| WhatsApp | unchanged (the replies you approved) | the person you reply to |

Rows for providers never selected are still listed (the table explains choices, not state). `data:purgeNow` dialog body adds "Pictures and voice transcripts are deleted too."

---

## 5. Notifications (extends ux.md 12.3; lane L4 `app/notifications.ts`)

All texts are app strings from the locale files; **never** a title, a contact name, message text, a transcript or picture text.

| Toast | When | Title | Body | Buttons | Shown when `notifications:'off'`? |
|---|---|---|---|---|---|
| auto write | each automatic create/update/cancel | Calendar: an event was added automatically / ...moved automatically / ...cancelled automatically | Open the app to see it. | **Undo** (index 0) / **Show** (index 1) | **yes** (B11: it is a control) |
| auto burst | 3+ writes in 10 min (replaces the individual ones) | {{count}} automatic calendar changes | Open the app to review them. | **Show** | yes |
| auto undo result (toast Undo only) | after `undoAuto(id,'user_toast')` | Calendar change undone / Could not undo the calendar change | - / Open the app to see why. | - / Show | yes |
| policy paused by the app | any automatic pause | Automatic mode paused | Open the app to see why. | Show | yes |
| policy expiring | 3 days before `expires_at`, once | Automatic mode ends in 3 days | You can renew it in Settings. | Show | no |
| overage | first `isUsingOverage:true` per day | The AI was paused | Paid extra usage started. Open the app to decide. | Show | yes (money) |
| voice model ready | first time only | Voice notes are ready | Voice messages will now be transcribed on this computer. | - | no |

Button wiring stays in main (no renderer): Undo -> `executor.undoAuto(autoWriteId,'user_toast')`; Show -> show window + `ui:navigate {view:'dashboard', itemId}` (sheet opens with focus on its close button; the 300 ms approve guard applies). The burst toast's Show opens the dashboard with the AutoStrip expanded. Toast activation on a clean VM is UNVERIFIED (U-N1): the card and the activity page are the other two Undo doors, so nothing depends on it.

---
## 6. Onboarding deltas (extends ux.md 8; ARCH-v2 11)

| Step | Change |
|---|---|
| 0 Welcome | The promise line stays verbatim ("Nothing is sent or scheduled without your approval.") - automatic mode is off until the user grants it later, so it is still true at onboarding time. |
| 1 Choose the AI | Cards in the order of 4.1: On this computer / Claude - your subscription / (Show experimental) Gemini - your subscription / (Advanced) API keys. The two subscription cards use the **compact Connect card** (7.3): one state line + one action, detection runs silently on step entry. Below the cards: checkbox **"Also understand voice notes (1.5 GB, Hebrew-optimised)"** (default checked when free disk >= 4 GiB and RAM >= 8 GiB, else unchecked with the reason "Needs 1.5 GB of free space" / "Needs 8 GB of memory"; checking it queues the voice download behind the AI model in the same DownloadPill) and the sentence "Pictures are read by the AI you choose. Picture reading on this computer (0.9 GB) downloads only when you ask for it." "Continue" is enabled when: Local as v1; a subscription card is Ready **and** its consent was accepted **and** `llm:setProvider` succeeded (the smoke run passed; the button shows "Checking Claude..." meanwhile); API keys as v1. |
| 2 Link WhatsApp | unchanged |
| 3 Google Calendar | unchanged; one closing sentence on the success screen: "Later, in Settings, you can let the agent add and change events by itself." Automatic mode is **never** offered in onboarding (it needs 3 approved events). |
| 4 Ready | checklist gains a row "Voice notes": "downloading 62 % - voice messages wait until it is ready" / "ready" / "off" (`ready-voice`). |

LTR, step 1 with the compact subscription card (RTL mirrors: radio at the right, action button at the left):
```
|  ( ) Claude - your subscription                                                              |
|      Uses the Claude plan you already pay for. No API key.                                   |
|      (shield) The analysed chat is sent to Anthropic through your own sign-in.               |
|      (!) Claude Code is installed but not signed in.                          [ Sign in ]    |
|                                                                                              |
|  [x] Also understand voice notes (1.5 GB, Hebrew-optimised)                                  |
|      Pictures are read by the AI you choose. Picture reading on this computer (0.9 GB)       |
|      downloads only when you ask for it.                                                     |
```

---

## 7. Provider setup: the Connect card (`components/ConnectCard.tsx`; B12-B14, B32; IPC `cli:*`)

One component, two providers (`claude_cli`, `antigravity_cli`), two sizes (`full` in Settings, `compact` in onboarding). The app **never** installs, updates, signs in, reads a credential, or runs an installer (B32). It detects, shows the vendor's own command as copyable text, opens a *visible* console for the vendor's own sign-in, and tests.

### 7.1 States

Data: `cli:getStatus {provider}` -> `{state, version?, minVersion, quota?}` (main caches 60 s; `auth status` is run at most once a minute, B13), pushed updates via `cli:changed`. UI-only states: `checking` (request in flight) and `waiting_sign_in` (after `cli:signIn`, up to 5 min).

Full size, LTR (each block replaces the previous one inside the card):
```
( ) Claude - your subscription
    Uses the Claude plan you already pay for, through the Claude Code you installed. No API key.
    (shield) The analysed chat is sent to Anthropic through your own sign-in - without names or phone numbers.

  checking         (~) Looking for Claude Code on this computer...

  not_installed    (terminal) Claude Code is not installed on this computer.
                   Run this in PowerShell, then come back:
                   [ irm https://claude.ai/install.ps1 | iex            ]  [Copy command]
                   The app never installs anything itself.       [Open install page]  [Check again]

  too_old          (terminal) Claude Code 2.1.150 is too old - version 2.1.248 or newer is needed.
                   [ claude update                                      ]  [Copy command]  [Check again]
                   Installed with WinGet? Use: winget upgrade Anthropic.ClaudeCode

  not_signed_in    (!) Claude Code 2.1.258 is installed but not signed in.              [ Sign in ]
                   Sign-in opens in Anthropic's own window. The app never sees your password.

  waiting_sign_in  (~) Finish signing in in the window that opened. It can take up to a minute
                   for the app to notice.                                          [Check again]

  unknown          (!) Could not tell whether you are signed in.                 [Sign in]  [Check again]

  ready            (v) Ready - Claude Code 2.1.258, signed in.   usage resets 15:40
                   Model [ sonnet (recommended)  v ]  as available on your plan
                   [Run a test]  (uses a little of your usage)      -> "Works - answered in about 2 s"
                   Agreed to send chats on 28 Sep 2026.  [Withdraw]
                   [ Use Claude - your subscription ]
```

RTL (mirrored; the command field stays LTR and start-aligned to the left edge of its own box):
```
                                                                  Claude - your subscription ( )
                Uses the Claude plan you already pay for, through the Claude Code you installed.
  not_installed                         .Claude Code is not installed on this computer (terminal)
                                                           :Run this in PowerShell, then come back
                 [Copy command]  [ irm https://claude.ai/install.ps1 | iex            ]
                  [Check again]  [Open install page]       .The app never installs anything itself
  ready          usage resets 15:40   .Ready - Claude Code 2.1.258, signed in (v)
                                     [ Use Claude - your subscription ]
```

Rules:

- **Command field**: read-only `<input dir="ltr">` (Segoe UI - the v1 "no monospace" rule stands), select-all on focus, `aria-label` "Install command". "Copy command" = `clipboard:writeText` (v1 IPC) -> "Copied" for 2 s. The command strings are app constants (section 14.6), never fetched. "Open install page" = `external:open {target:'claude_install' | 'antigravity_install'}`.
- **Sign in** = `cli:signIn {provider}` (main spawns the validated `claude.exe` itself with `auth login --claudeai`, or `agy.exe` with no arguments and cwd `%USERPROFILE%`, each in its own visible console; **never through `cmd.exe`**, F7). The card enters `waiting_sign_in`, re-requests `cli:getStatus` every 10 s for 5 minutes (main answers from its 60 s cache), then falls back to the state it gets with "Check again". The app never reads the console.
- **Check again** is always a manual escape; it shows "Checked just now" / "Checked 40 s ago" in muted text.
- **Run a test** = `cli:test {provider}` (`haiku` / the Flash slug, 30 s): "Testing..." -> "Works - answered in about {{seconds}} s" or the ErrorCode row. Disabled with "Testing is limited while the AI is busy" when a CLI run holds the mutex.
- **Use {{provider}}** = consent (7.5) if missing -> `llm:setProvider`. While main runs the provider-start smoke: "Checking {{vendor}}...". Failure = the ErrorCode row inline; the previously active provider stays active and says so ("Still using: AI on this computer").
- ErrorCode rows on the card (section 10): `CLI_TOOLSET_MISMATCH` (red, "Export diagnostics", plus the secondary "Switch to the AI on this computer"), `CLI_UNSTABLE`, `CLOUD_AUTH`, `CLOUD_QUOTA` (with the reset time), `CLOUD_OVERAGE`.
- The card never shows a token, a path under `.claude`, the OAuth account email, or any text printed by the CLI beyond `version` (B27).

### 7.2 Claude-specific lines

"usage resets {{time}}" appears in `ready` only when `quota.resetsAt` is known. When `quota.usingOverage === true` and overage is not allowed, the card shows the `CLOUD_OVERAGE` row instead of `ready`.

### 7.3 Compact size (onboarding)

Name + one-line description + privacy note + **one** state line with **one** action: not_installed -> "Copy install command"; too_old -> "Copy update command"; not_signed_in/unknown -> "Sign in"; waiting -> "Check again"; ready -> nothing (the radio selection + wizard "Continue" do the rest). The full card (model, test, limits) is in Settings only.

### 7.4 Antigravity ("Gemini - your subscription", experimental; B14)

Hidden behind "Show experimental". Card = the Connect card with three additions, in this order:

1. **Risk disclosure** (always visible above the states, `--color-warn-soft` box, `alert-triangle` icon, not dismissible):
   > Experimental. Google's terms for Antigravity forbid using it with "third-party software, tools, or services", and Google has suspended accounts for it; Google staff have also said that running the official CLI on your own computer is fine. The app runs the unmodified Antigravity CLI with your own sign-in and nothing else - the risk to your account is yours. Antigravity keeps a copy of every request on this computer. Google's supported way is Gemini with an API key (under Advanced). Terms read on {{termsDate}}.
2. **Capability lines** (muted, fixed): "This AI cannot look up older messages by itself; the app hands it the last {{days}} days of this chat." · "Pictures are read on this computer while this AI is selected." · "Automatic mode does nothing while this AI is selected."
3. **Setup step "Allow the app's folder"** (after `ready` sign-in, before "Use"): 
```
  (terminal) Antigravity needs to trust the app's working folder once.
             This changes one line in your Antigravity settings file:
             + "trustedWorkspaces": [ ..., "C:\Users\<you>\AppData\Roaming\WhatsApp Calendar Agent\agy-workspace" ]
             A backup of the file is saved next to it. Nothing else in the file is touched.
             [ Allow the app's folder... ]
```
   The diff text comes from `cli:previewWorkspaceChange` (displayed `dir="ltr"`, app-rendered from main's computed diff, never the file content). The button calls `cli:allowWorkspace {provider, confirm:true}`, which shows main's native confirm dialog (title "Change your Antigravity settings?", the same one-line diff as detail, buttons "Cancel" (default) / "Change one line"). Results: "(v) Done - a backup was saved next to the file." / refused while agy runs: "Close Antigravity first, then try again." / any failure: `CLI_NOT_SIGNED_IN`-style row with "Try again".

Commands: install `irm https://antigravity.google/cli/install.ps1 | iex`; sign-in = "Sign in" opens a console running `agy` ("Antigravity opens your browser to sign in; close the console window when it says you are signed in."). Version floor 1.2.11. Model select filled from `llm:listModels` ("as reported by the CLI").

**Gemini CLI note** (a muted line under the Antigravity card and under "Gemini with an API key"): "Looking for the Gemini CLI? It no longer accepts Google AI Pro or Ultra sign-ins, so it cannot use your subscription. Use this experimental option or Gemini with an API key." - re-read before each release like the consent dates (U-A5).

### 7.5 Consent dialogs (extends ux.md 14.2 `ConsentDialog`; B21)

`ConsentDialog.kind` gains `cloud_claude_cli` and `cloud_antigravity_cli`; `version` = the current constant. Layout unchanged (definition list: What is sent / What is never sent / Who processes it / + "Good to know" for the CLI kinds). Accept is disabled until the body was scrolled to the end when it overflows (v1 rule) - the Antigravity text always overflows at 480 px.

| Kind / version | What is sent | Good to know | Accept button |
|---|---|---|---|
| `cloud_claude` v2 / `cloud_gemini` v2 | the text of the chat being analysed; transcripts of its voice notes; pictures in it when "Read pictures with {{vendor}}" is on; older messages of this chat, or of all chats if you chose that | (v1 free-tier line for Gemini) | Send to {{vendor}} |
| `cloud_claude_cli` v1 | same as `cloud_claude` v2 | Runs the Claude Code you installed, under your own sign-in; Anthropic processes the text under its consumer terms. Anthropic changed its subscription rules several times in 2026 - if it changes again, the app shows a sign-in error and chats wait. Runs count against your 5-hour and weekly usage. Paid extra usage is off unless you turn it on. | Use my Claude subscription |
| `cloud_antigravity_cli` v1 | the text of the chat being analysed; transcripts of its voice notes; the last {{days}} days of this chat; never pictures | the full 7.4 disclosure incl. the quoted terms, the suspension risk, the local copy of requests, and "Terms read on {{termsDate}}" (stored in the consent record) | I accept the risk - use Gemini |

What is never sent (all kinds): names, phone numbers, your other chats (unless you chose "all my chats"), your calendar event titles. After the upgrade, a v1 `cloud_claude`/`cloud_gemini` record makes that provider `consent_missing` until the v2 dialog is accepted (SetupStrip row 4).

---

## 8. Change, undo and automatic flows as state diagrams (for implementers)

```
Change card (update_event pending)
  [Approve change] --click--> Changing... --done--> (v) Changed in calendar -> card moves to In calendar as "Updated · rev n" + [Undo]
                                      \--needs_confirm_drift / 412--> "In Google it is now ..." [Apply anyway] [Keep Google's]
                                      \--CAL_EVENT_GONE--> "no longer in your calendar" [Add as new event]
                                      \--CAL_EVENT_FOREIGN--> info line, no action
                                      \--ACTION_STALE--> "This card changed" [Refresh card]
  [Keep 15:00] --action:reject--> ChangeLine + change buttons removed; draft stays; source chip removed; delta item event_state = 'declined'; the same `to` is never proposed again for this event revision (F32)

Undo (any door: card / AutoStrip / activity / toast)
  [Undo] --> Undoing... --> (v) Undone
                      \--> blocked_changed  (amber, Open in calendar)
                      \--> blocked_started  (amber, [Cancel event])
                      \--> restore refused  ([Add it back] = pending create_event, user click)
                      \--> failed           (red, [Try again])

Automatic write (no click)
  S4 -> tryAuto: auto  --> toast (Undo/Show) + AutoStrip row + card chip "Added automatically" in In calendar
                 shadow--> card chip "Would have been automatic" (dashed), normal buttons
                 fallback-> normal buttons + "Not automatic: {reason}" line (policy live only)
                 failed write -> ordinary pending card (no chip), policy may pause (unknown_outcome)
```

---

## 9. Model download states (whisper and vision; B18, B19)

| State (per file) | DownloadPill | Settings row (Voice notes / Pictures) | Card placeholder |
|---|---|---|---|
| not downloaded | - | "{{size}} - not downloaded" + [Download] | voice: "Voice notes: model not downloaded" + Download ({{size}}); picture: "Download picture reading ({{size}})" |
| queued | "+N" on the active pill | "Queued - starts after the AI model" | same chip, action disabled with "Queued" |
| downloading | "Voice model 43 % - 4 min" | "Downloading 43 %" + Pause | chip "Downloading 43 %", no action |
| paused | "Paused 43 %" | "Paused 43 %" + Resume | chip "Download paused" + Resume |
| verifying | "Checking file..." | "Checking file..." | unchanged |
| ready | - (announce once) | "ready" + Delete (unselected tiers) | cards re-analysed automatically (items `held/waiting_llm` are re-queued by main) |
| failed | red pill + ErrorCode action | ErrorCode row (`DOWNLOAD_FAILED` / `DISK_FULL` / `MODEL_MISSING`) | chip "Download failed" + Download again |
| projector loaded (pictures) | - | "ready - loaded" / "ready - the AI restarts to load it" | - |

Voice and picture files never download during onboarding unless the user ticked the voice checkbox; picture reading downloads only from a card or from Settings (B19). The cancel action on a voice download asks nothing (downloads are resumable); deleting a ready model confirms (v1 rule: "Delete the voice model (1.5 GB)?" - "Delete model" / "Keep it").

---

## 10. ErrorCode deck additions (extends ux.md 11.4; ARCH-v2 13; parity test over `errors.<CODE>.{title,body,action}`)

`{{cli}}` = "Claude Code" | "Antigravity"; `{{vendor}}` = "Anthropic" | "Google". Hebrew uses the plural imperative for instructions (ux.md 15.1).

| ErrorCode | Part | Title en / he | Body en / he | Action en / he |
|---|---|---|---|---|
| `CLI_NOT_INSTALLED` | AI | {{cli}} is not installed / {{cli}} לא מותקן | The subscription route needs {{cli}} on this computer. Chats wait as plain cards. / המסלול דרך המנוי צריך את {{cli}} במחשב הזה. השיחות ממתינות ככרטיסים פשוטים. | Copy install command / העתקת פקודת ההתקנה |
| `CLI_VERSION` | AI | {{cli}} needs an update / צריך לעדכן את {{cli}} | Version {{version}} is too old for the app; {{min}} or newer is needed. / הגרסה {{version}} ישנה מדי בשביל האפליקציה; נדרשת {{min}} ומעלה. | Copy update command / העתקת פקודת העדכון |
| `CLI_NOT_SIGNED_IN` | AI | {{cli}} is not signed in / {{cli}} לא מחובר לחשבון | Sign in with your own account in the window that opens. The app never sees your password. / התחברו לחשבון שלכם בחלון שייפתח. האפליקציה לא רואה את הסיסמה. | Sign in / התחברות |
| `CLI_TOOLSET_MISMATCH` | AI | {{cli}} changed in a way the app does not recognise / {{cli}} השתנה באופן שהאפליקציה לא מזהה | The AI is paused to stay safe. Chats wait as plain cards. You can switch to the AI on this computer. / הבינה הושהתה ליתר ביטחון. השיחות ממתינות ככרטיסים פשוטים. אפשר לעבור לבינה שבמחשב הזה. | Export diagnostics / ייצוא אבחון |
| `CLI_UNSTABLE` | AI | {{cli}} keeps stopping / {{cli}} נעצר שוב ושוב | It stopped several times within a few minutes and is resting now. / הוא נעצר כמה פעמים בתוך דקות ספורות ועכשיו במנוחה. | Test again / בדיקה חוזרת |
| `CLOUD_AUTH` | AI | {{vendor}} did not accept your sign-in / {{vendor}} לא קיבלה את ההתחברות שלך | Your account may be signed out, on hold, or no longer allowed to be used this way. Chats wait as plain cards. / ייתכן שהחשבון התנתק, הושהה, או שכבר אי אפשר להשתמש בו בדרך הזו. השיחות ממתינות ככרטיסים פשוטים. | Sign in again / התחברות מחדש |
| `CLOUD_QUOTA` (v1 code; new body variant `bodyReset` when `llm.quota.resetsAt` is known) | AI | v1 title | Your {{vendor}} usage limit is reached. It continues by itself at {{time}}. Chats wait as plain cards. / הגעת למגבלת השימוש של {{vendor}}. הפעולה תימשך מעצמה ב-{{time}}. השיחות ממתינות ככרטיסים פשוטים. | Open usage page / פתיחת דף השימוש (Antigravity: Open AI settings) |
| `CLOUD_OVERAGE` | AI | Paid extra usage started / התחיל שימוש נוסף בתשלום | The AI is paused so nothing is charged without you. You can allow extra usage in AI settings. / הבינה הושהתה כדי שלא תחויבו בלי ידיעתכם. אפשר לאשר שימוש נוסף בהגדרות הבינה. | Open AI settings / פתיחת הגדרות הבינה |
| `CAL_EVENT_GONE` | card | The event is no longer in your calendar / האירוע כבר לא ביומן שלך | It was deleted or cancelled in Google. You can add it again as a new event. / הוא נמחק או בוטל ב-Google. אפשר להוסיף אותו מחדש כאירוע חדש. | Add as new event / הוספה כאירוע חדש |
| `CAL_EVENT_FOREIGN` | card (info) | This event was not added by the agent / האירוע הזה לא נוסף על ידי הסוכן | Change it in Google Calendar. / אפשר לשנות אותו ביומן Google. | - (none) |
| `CAL_UPDATE_FAILED` | card | The change was not saved / השינוי לא נשמר | Nothing in your calendar changed. / שום דבר ביומן לא השתנה. | Try again / ניסיון נוסף |
| `CAL_UPDATE_UNAVAILABLE` | Calendar | Changes to events are unavailable / אי אפשר לשנות אירועים כרגע | The calendar component is not the expected version. Adding events still works; change or cancel events in Google Calendar. / רכיב היומן אינו בגרסה הצפויה. הוספת אירועים עדיין עובדת; שינוי או ביטול נעשים ביומן Google. | Export diagnostics / ייצוא אבחון |
| `AUTO_NOT_CONFIRMED` | settings (inline) | Automatic mode was not turned on / המצב האוטומטי לא הופעל | It turns on only when you tick the box and choose it in the Windows dialog. / הוא מופעל רק אחרי שמסמנים את התיבה ובוחרים בו בחלון של Windows. | - |
| `AUTO_CALENDAR_NOT_OWNED` | settings (inline) | This calendar is not yours / היומן הזה אינו בבעלותך | Automatic mode works only in a calendar you own. Choose one under Google Calendar. / המצב האוטומטי עובד רק ביומן שבבעלותך. אפשר לבחור יומן אחר בהגדרות יומן Google. | Choose a calendar / בחירת יומן |
| `AUTO_NO_TRACK_RECORD` | settings (inline) | Approve a few events first / קודם צריך לאשר כמה אירועים | Automatic mode becomes available after you approve 3 events yourself. / המצב האוטומטי יהיה זמין אחרי שתאשרו בעצמכם 3 אירועים. | - |
| `VOICE_MODEL_MISSING` | card / AI sub-line | The voice model is not downloaded / מודל הקול לא הורד | Voice messages wait as plain cards until it is ready. / הודעות קוליות ממתינות ככרטיסים פשוטים עד שהוא יהיה מוכן. | Download ({{size}}) / הורדה ({{size}}) |
| `VOICE_AUDIO_MISSING` | card | The voice message was not received / ההודעה הקולית לא התקבלה | WhatsApp did not hand over the audio. It may arrive later. / וואטסאפ לא העביר את הקובץ. ייתכן שהוא יגיע מאוחר יותר. | Try again / ניסיון נוסף |
| `VOICE_DECODE_FAILED` | card | The voice message could not be read / לא הצלחנו לקרוא את ההודעה הקולית | The audio file looks damaged or unusual. / קובץ השמע נראה פגום או חריג. | Analyse again / ניתוח מחדש |
| `VOICE_LOCAL_FAILED` | card / AI sub-line | Transcription on this computer stopped / התמלול במחשב הזה נעצר | It failed several times and is resting now. / הוא נכשל כמה פעמים ועכשיו במנוחה. | Analyse again / ניתוח מחדש |
| `VOICE_TOO_LONG` | card | Longer than 15 minutes - not transcribed / ארוכה מ-15 דקות - לא תומללה | Listen to it on your phone. / אפשר להאזין לה בטלפון. | - |
| `VOICE_TIMEOUT` | card | Transcription took too long / התמלול לקח יותר מדי זמן | A lighter voice model is faster on this computer. / מודל קול קל יותר מהיר יותר במחשב הזה. | Try again / ניסיון נוסף |
| `MEDIA_UNAVAILABLE` | card (inline) | The picture was not received / התמונה לא התקבלה | The text of the chat was still analysed. / הטקסט של השיחה נותח בכל זאת. | Try again / ניסיון נוסף |
| `LLM_VCREDIST_MISSING` (reused) | AI | v1 title | v1 body + " Voice notes need it too." / + " גם הודעות קוליות צריכות אותו." | v1 action |

New `label.errorAction.*` ids: `copy_install_command`, `copy_update_command`, `sign_in`, `sign_in_again`, `open_usage_page`, `add_as_new_event`, `choose_calendar`, `download_voice`. Existing ids are reused for the rest.

---

## 11. Accessibility deltas (extends ux.md 13; WCAG 2.2 AA)

1. **Landmarks**: the AutoStrip is a `<section aria-labelledby="autostrip-title">` placed before the three columns in DOM order; F6 cycles header -> AutoStrip (when present) -> columns -> footer. Its rows are a `role="list"`.
2. **ChangeLine**: the visible line is `aria-hidden="true"`; a visually hidden sibling carries the full sentence ("Change from Wednesday 15:00 to 17:00" / "שינוי: 17:00 במקום יום רביעי 15:00"). The card's accessible name gains ", change proposed".
3. **Chips and the reason line**: `automatic`/`auto_shadow` chips have icon + text (never colour only); the "Not automatic" line is referenced by `aria-describedby` from the calendar approval button so a screen reader hears why when focusing it.
4. **Undo**: an ordinary `<button>` with text "Undo" and `aria-describedby` pointing at the deadline line ("Undo available until Wed 17:00"). During "Undoing..." the button is `aria-disabled="true"` (stays focusable). After success focus stays on the card root and the polite region says "Undone." Failures go to the assertive region with the inline row text (ux.md 13.3 rule).
5. **Focus-steal guard (500 ms)** applies to: Approve change, Cancel event, Apply anyway, Add as new event, Add it back, Undo (all doors in the window), Turn on for real, Resume, Start a 24-hour trial, Turn on now, Allow the app's folder, Use {{provider}}. It does **not** apply to Pause, Stop, Keep {{time}}, Keep it, Keep Google's (fail-safe direction).
6. **Voice/picture text**: transcript and read text are blocks with `dir="auto"` and `lang` when known; the header strip is read first ("Voice message, 42 seconds, Hebrew"). Durations have `aria-label` in words ("42 seconds", "‏42 שניות"). The thumbnail is `<img alt="Picture sent by ...">`; it is not focusable (not interactive). "Show more" is a real button.
7. **Connect card**: the state line is a `role="status"` region (polite) so "Ready" is announced after sign-in detection; the command field is labelled; "Copied" is announced (v1 Copy rule).
8. **Native dialog** (auto enable, workspace trust): OS-accessible by construction; the renderer announces "Waiting for your answer in the Windows dialog" politely when it opens.
9. **Live-region additions** (polite unless stated): automatic write while the window is focused - "Added automatically: {{when}}." / "Moved automatically: {{when}}." / "Cancelled automatically: {{when}}." (event from trusted fields; never the title); undo success "Undone."; transcription finished is **not** announced (the card arrives through the normal "new chat" message); download completion per 2.1; policy state change "Automatic mode: {{state}}." (throttled 10 s).
10. **Forced colours**: the dotted media rule, the dashed shadow chip and the struck-through cancelled title all survive (`border-style`, `text-decoration`); the "Experimental" chip has the word, not only a colour.
11. **Targets and timing**: Undo buttons are >= 32 x 32; the toast's Undo is never the only way (card + AutoStrip + activity page). The 72 h / start-time undo window is stated in text, not only by the button disappearing.
12. **Reduced motion**: unchanged rules; no new animation.

---

## 12. Component and view-model deltas (extends ux.md 14)

New files (L9 owns; ARCH-v2 15 L9): `components/AutoStrip.tsx`, `components/ChangeLine.tsx`, `components/UndoControl.tsx`, `components/VoiceBubble.tsx`, `components/ImageBubble.tsx`, `components/ConnectCard.tsx`, `views/settings/AutomaticMode.tsx`, `views/AutoActivity.tsx`, `store/auto.ts`, `store/cli.ts`. Extended: `ItemCard`, `RawCard`, `QuotedBubble` (delegates by `trigger.kind`), `Badges`, `EventEditor`/`EventChip` (states `updated`/`cancelled`, `mode:'change'`), `HealthPill` (sub-lines), `DownloadPill` (kinds + queue), `SetupStrip` (rows 4-9), `ConsentDialog` (kinds), `Settings`, `Onboarding/ChooseAi`, `Onboarding/Ready`, `App` (announcements, `auto:changed`/`cli:changed`/`queue:changed` subscriptions).

View models (authoritative shapes land in `src/shared/types.ts` / `ipc.ts` via L1; these are the fields the renderer needs at minimum):

```ts
type ProviderId = 'local' | 'claude_cli' | 'antigravity_cli' | 'claude' | 'gemini';
type BadgeCode = /* v1 */ 'time_assumed'|'conflict'|'personal_details'|'lang_mismatch'|'link_removed'|'manipulation'|'change_in_google'|'older_message'
               | /* v2 */ 'change_unclear'|'from_image'|'image_unclear'|'image_unread'|'automatic'|'auto_shadow';
type AutoReason = (typeof AUTO_REASONS)[number];      // v2-auto-mode-safety 5.5 + 'no_track_record' (B8)

interface EventVM { /* v1 fields */ state: 'incomplete'|'proposed'|'change_proposed'|'created'|'updated'|'cancelled'|'declined'; revision?: number }
interface ChangeVM { kind: 'reschedule'|'move'|'cancel'; from: EventVM; to: EventVM; actionId: string; shownHash: string }   // from delta_json; renderer never sends targetEventId
interface UndoVM   { revisionId: number; until: EpochMs; state: 'available'|'undone'|'expired'|'blocked_changed'|'blocked_started'|'failed'; autoWriteId?: string }
interface AutoVM   { chip: 'automatic'|'auto_shadow'|null; writeKind?: 'create'|'update'|'cancel'; fallbackReason?: AutoReason }
interface VoiceVM  { seconds: number; status: 'done'|'empty'|'failed'|'aborted'|'model_missing'|'too_long'; transcript: string | null /* UNTRUSTED */;
                     language: 'he'|'en'|'other'|null; modelLabel: 'hebrew'|'multilingual'|'lite'|null; errorCode?: ErrorCode }
interface ImageVM  { thumbDataUrl: string | null; readText: string | null /* UNTRUSTED */; asWritten: { date: string; time: string; place: string } /* UNTRUSTED */;
                     unreadCause?: 'no_local_reader'|'disabled'|'provider_cannot'|'media_unavailable'|'read_failed' }
interface ItemVM   { /* v1 fields */ trigger: { kind: 'text'|'voice'|'image'; text: string; ts: number; mediaKind?: ...; voice?: VoiceVM; image?: ImageVM };
                     change?: ChangeVM; undo?: UndoVM; auto?: AutoVM; pendingChangeOnSource?: boolean; calendarEventKey?: string /* opaque de-dup key, never the Google id */;
                     provider?: ProviderId }
interface AutoStateVM { policy: null | { state: 'shadow'|'on'|'paused'|'disabled'|'expired'; pausedReason?: string; expiresAt: EpochMs; shadowUntil: EpochMs;
                        scope: AutoScope; usedToday: number; limitToday: number; shadow: { seen: number; wouldAdd: number; wouldChange: number; approvedUnchanged: number } };
                        preconditions: { calendarConnected: boolean; calendarOwned: boolean; calendarName: string; approvedCreates: number; providerAutoCapable: boolean; dialogAllowed: boolean } }   // see concern C5
interface CliStatusVM { provider: 'claude_cli'|'antigravity_cli'; state: 'not_installed'|'too_old'|'not_signed_in'|'unknown'|'ready'; version?: string; minVersion: string;
                        quota?: { resetsAt: EpochMs|null; usingOverage: boolean|null }; checkedAt: EpochMs }
```

`calendarEventKey` is an opaque per-event key minted by main for de-duplication (B20 says the list is keyed by `calendar_event_id`; the renderer does not need the raw Google id - no IPC request may carry an event id, ARCH-v2 10).

Component props (additions):

| Component | Props |
|---|---|
| `AutoStrip` | `{ rows: AutoWriteRowVM[]; policyState: AutoStateVM['policy']; onUndo(id): void; onShow(itemId): void; onPause(): void }` |
| `ChangeLine` | `{ change: ChangeVM; lang: 'he'|'en' }` |
| `UndoControl` | `{ undo: UndoVM; itemId: number; door: 'card'|'strip'|'activity'; onUndo(): Promise<Result> }` |
| `VoiceBubble` | `{ voice: VoiceVM; clampLines?: number; full?: boolean }` (inert text only; no children) |
| `ImageBubble` | `{ image: ImageVM; contactName: string; mode: 'card'|'sheet' }` |
| `ConnectCard` | `{ provider: 'claude_cli'|'antigravity_cli'; size: 'full'|'compact'; status: CliStatusVM; selected: boolean; onUse(): void }` |
| `AutomaticMode` | `{ state: AutoStateVM }` |
| `AutoActivity` | `{ onBack(): void }` (fetches `auto:listWrites`, decisions) |

Stores: `store/auto.ts` = `AutoStateVM` + strip rows, hydrated by `auto:getState`/`auto:listWrites`, refreshed on `auto:changed`; `store/cli.ts` = `Record<provider, CliStatusVM>`, refreshed on `cli:changed`. The dirty-card rule of ux.md 6.3 extends to delta cards (an edited `to` is never overwritten by a refresh).

---

## 13. Test ids (extends the ux.md 16.6 contract and the live convention `<thing>-<id>`)

| Area | `data-testid` |
|---|---|
| AutoStrip | `autostrip`, `autostrip-toggle`, `autostrip-pause`, `autostrip-row-<autoWriteId>`, `autostrip-undo-<autoWriteId>`, `autostrip-show-<autoWriteId>`, `autostrip-state-<autoWriteId>` (`data-state` = undo_state), `autostrip-more` |
| Card auto | `auto-chip-<itemId>` (`data-chip` = automatic/auto_shadow), `auto-reason-<itemId>` (`data-reason` = AUTO_REASON), `never-auto-<itemId>` (overflow item) |
| Change card | `change-line-<itemId>` (`data-kind`), `approve-change-<itemId>`, `keep-change-<itemId>`, `cancel-event-<itemId>`, `keep-event-<itemId>`, `drift-row-<itemId>`, `apply-anyway-<itemId>`, `keep-google-<itemId>`, `add-new-event-<itemId>`, `change-pending-chip-<itemId>` (on the source card) |
| Undo | `undo-<itemId>`, `undo-until-<itemId>`, `undo-state-<itemId>` (`data-state`), `add-back-<itemId>` |
| Event chip | `event-chip-updated`, `event-chip-cancelled`, `event-chip-rev` |
| Voice | `voice-bubble-<itemId>`, `voice-duration`, `voice-lang`, `voice-transcript`, `voice-caution`, `voice-download-<itemId>`, `queue-transcribing` |
| Picture | `image-bubble-<itemId>`, `image-thumb`, `image-readtext`, `image-caution`, `image-unread-action-<itemId>` (`data-cause`), `sheet-picture`, `sheet-picture-read`, `sheet-as-written-<date|time|place>` |
| Settings AI | `ai-card-claude_cli`, `ai-card-antigravity_cli`, `ai-card-claude`, `ai-card-gemini` (renamed ids keep `ai-card-local`), `ai-show-experimental`, `ai-advanced`, `ai-use-<provider>`, `connect-<provider>` (`data-state`), `connect-command-<provider>`, `connect-copy-<provider>`, `connect-open-install-<provider>`, `connect-check-<provider>`, `connect-signin-<provider>`, `connect-test-<provider>`, `connect-test-result-<provider>`, `connect-model-<provider>`, `agy-disclosure`, `agy-workspace-diff`, `agy-workspace-allow`, `gemini-cli-note`, `settings-cli-runs-per-hour`, `settings-cli-overage`, `settings-cli-exe-path` |
| Settings voice/pictures | `settings-voice-<off|voice-hebrew|voice-multilingual|voice-lite>`, `settings-voice-status-<tier>`, `settings-voice-test`, `settings-voice-bench`, `settings-voice-suggest-lite`, `settings-images-enabled`, `settings-images-cloud`, `settings-images-local-status`, `settings-images-download` |
| Settings auto | `settings-group-auto`, `settings-nav-auto`, `auto-state-card` (`data-state`), `auto-happens`, `auto-never`, `auto-scope-edits`, `auto-scope-cancels`, `auto-scope-quiet`, `auto-scope-validity`, `auto-enable-trial`, `auto-enable-now`, `auto-precondition` (`data-reason`), `auto-end-shadow`, `auto-pause`, `auto-resume`, `auto-stop`, `auto-renew`, `auto-waiting-dialog`, `auto-open-activity` |
| Activity | `auto-activity`, `activity-day-<yyyy-mm-dd>`, `activity-row-<id>` (`data-kind` = write/shadow/fallback), `activity-export`, `activity-empty`, `activity-older` |
| Working rules | `settings-readtools-<off|trigger_chat|all_chats>`, `settings-readtools-days`, `settings-policy-auto-<chatRef>` |
| Shell | `health-subline-<part>`, `setup-strip-<consent_v2|auto_paused|auto_trial|auto_expiring|voice_download|auto_expired>`, `download-row-<kind>-<tier>`, `ready-voice`, `onboarding-voice-optin` |
| Consent | `consent-dialog` (`data-kind`, `data-version`), `consent-terms-date` |

---

## 14. Locale keys (both files; parity test; Hebrew natural, gender-neutral where possible)

Hebrew style notes for v2 (additions to ux.md 15.1): (1) **"Undo" on calendar changes is "ביטול השינוי"**, never the bare "ביטול" - next to an event, "ביטול" reads as "cancel the event" (and "Cancel event" is "ביטול האירוע"). The v1 key `action.undo` ("ביטול") stays for dismiss/policy toasts only. (2) Buttons stay action nouns where natural; where a noun is clumsy the infinitive is used (as in v1 settings: "להשאיר ב-15:00"). (3) Vendor and product names stay Latin (Claude, Claude Code, Gemini, Antigravity, Google, Anthropic, PowerShell, WinGet). (4) Counts use i18next plurals `_one`/`_two`/`_other` ("יום אחד" / "יומיים" / "{{count}} ימים"). (5) Time ranges and the change arrow sides are separate `<bdi>`s.

### 14.1 `change.*`, `undo.*`, event states

| Key | en | he |
|---|---|---|
| `change.line.reschedule` | Change: <bdi>{{from}}</bdi> <arrow/> <bdi>{{to}}</bdi> | שינוי: <bdi>{{from}}</bdi> <arrow/> <bdi>{{to}}</bdi> |
| `change.line.move` | Place: <bdi>{{from}}</bdi> <arrow/> <bdi>{{to}}</bdi> | מקום: <bdi>{{from}}</bdi> <arrow/> <bdi>{{to}}</bdi> |
| `change.line.cancel` | Cancel: <bdi>{{title}}</bdi>, <bdi>{{when}}</bdi> | ביטול: <bdi>{{title}}</bdi>, <bdi>{{when}}</bdi> |
| `change.a11y.reschedule` | Change from {{from}} to {{to}} | שינוי: {{to}} במקום {{from}} |
| `change.a11y.move` | Place change from {{from}} to {{to}} | שינוי מקום: {{to}} במקום {{from}} |
| `change.a11y.cancel` | Cancel {{title}}, {{when}} | ביטול {{title}}, {{when}} |
| `change.approve` / `.approving` / `.approved` | Approve change / Changing... / Changed in calendar | אישור השינוי / משנה... / שונה ביומן |
| `change.keepTime` | Keep {{time}} | להשאיר ב-{{time}} |
| `change.keepPlace` | Keep the old place | להשאיר את המקום הקודם |
| `change.cancelEvent` / `.cancelling` / `.cancelled` | Cancel event / Cancelling... / Cancelled in calendar | ביטול האירוע / מבטל... / בוטל ביומן |
| `change.keepIt` | Keep it | להשאיר |
| `change.pendingChip` | Change proposed - see Needs reply | הוצע שינוי - ראו ב"ממתינות לתשובה" |
| `change.latestOnly` | Changes apply to the latest event of this chat. | שינויים חלים על האירוע האחרון בשיחה הזו. |
| `change.nowInCalendar` | Now in your calendar | כרגע ביומן שלך |
| `change.drift` | In Google it is now <bdi>{{when}}</bdi> - apply the change anyway? | ב-Google האירוע נמצא עכשיו במועד <bdi>{{when}}</bdi> - להחיל את השינוי בכל זאת? |
| `change.applyAnyway` / `change.keepGoogle` / `change.applyAgain` | Apply anyway / Keep Google's / Apply again | להחיל בכל זאת / להשאיר כמו ב-Google / להחיל שוב |
| `event.updatedRev` | Updated · rev {{n}} | עודכן · גרסה {{n}} |
| `event.cancelled` | Cancelled | בוטל |
| `undo.button` / `.undoing` / `.undone` | Undo / Undoing... / Undone | ביטול השינוי / מבטל את השינוי... / השינוי בוטל |
| `undo.until` | Undo available until <bdi>{{when}}</bdi> | אפשר לבטל עד <bdi>{{when}}</bdi> |
| `undo.expired` | Undo no longer available | כבר אי אפשר לבטל |
| `undo.removed` | Undone - removed from your calendar | השינוי בוטל - האירוע הוסר מהיומן |
| `undo.restored` | Undone - back in your calendar | השינוי בוטל - האירוע חזר ליומן |
| `undo.blockedChanged` | You changed this event in Google after it was added - undo would overwrite your change. | שינית את האירוע ב-Google אחרי שנוסף - ביטול יכתוב מעל השינוי שלך. |
| `undo.blockedChangedShort` | You changed this in Google after it was added | שינית את זה ב-Google אחרי שנוסף |
| `undo.blockedStarted` | The event has already started - undo is not available. | האירוע כבר התחיל - אי אפשר לבטל. |
| `undo.blockedStartedShort` | It has already started | הוא כבר התחיל |
| `undo.restoreRefused` | Google did not restore the cancelled event. | Google לא שחזרה את האירוע שבוטל. |
| `undo.addBack` | Add it back | הוספה בחזרה |
| `undo.failed` | Could not undo | לא הצלחנו לבטל |
| `undo.announce` | Undone. | השינוי בוטל. |

### 14.2 Badges (`label.badge.*` short labels; long sentences in `badge.<code>.long`)

| Code | Tone | `label.badge` en / he | `badge.<code>.long` en / he |
|---|---|---|---|
| `change_unclear` | amber | Change unclear / שינוי לא ברור | Not sure this changes the event - the draft asks / לא ברור אם זה משנה את האירוע - הטיוטה שואלת |
| `from_image` | info | From a picture / מתמונה | Read from a picture / נקרא מתמונה |
| `image_unclear` | amber | Hard to read / קשה לקריאה | Hard to read - check the picture / קשה לקריאה - כדאי לבדוק מול התמונה |
| `image_unread` | info | Picture not read / התמונה לא נקראה | The picture was not read / התמונה לא נקראה |
| `automatic` (create / update / cancel) | info | Automatic / אוטומטי | Added automatically / Moved automatically / Cancelled automatically - נוסף אוטומטית / הוזז אוטומטית / בוטל אוטומטית |
| `auto_shadow` | info (dashed) | Trial / ניסיון | Would have been automatic / היה מתבצע אוטומטית |

`label.badge.change_in_google` keeps its v1 text; it is shown only for old rows and under `CAL_UPDATE_UNAVAILABLE`.

### 14.3 `auto.*` (settings, states, reasons, dialog, toasts, tray)

| Key | en | he |
|---|---|---|
| `settings.group.auto` | Automatic mode | מצב אוטומטי |
| `auto.intro` | The agent adds and changes events in <bdi>{{calendar}}</bdi> by itself. Replies always wait for you. | הסוכן מוסיף ומשנה אירועים ביומן <bdi>{{calendar}}</bdi> בעצמו. תשובות תמיד ממתינות לך. |
| `auto.happensTitle` | What happens without asking you | מה קורה בלי לשאול אותך |
| `auto.happens.people` | only with people you have written to, in chats where you wrote in the last day | רק עם אנשים שכתבת להם, בשיחות שכתבת בהן ביממה האחרונה |
| `auto.happens.window` | within the next 30 days, 5 minutes to 4 hours long | בתוך 30 הימים הקרובים, באורך של 5 דקות עד 4 שעות |
| `auto.happens.limits` | up to 3 per contact a day and 15 a day in total | עד 3 ביום לכל איש קשר ועד 15 ביום בסך הכול |
| `auto.happens.notify` | each one shows a notification with Undo | על כל אחד מופיעה התראה עם אפשרות ביטול |
| `auto.happens.replies` | replies still wait for your approval | תשובות עדיין ממתינות לאישור שלך |
| `auto.happens.ends` | ends by itself after {{days}} days | מסתיים מעצמו אחרי {{days}} ימים |
| `auto.neverTitle` | What never happens | מה אף פעם לא קורה |
| `auto.never.delete` | deleting an event | מחיקת אירוע |
| `auto.never.invite` | inviting anyone | הזמנת אנשים |
| `auto.never.send` | sending a WhatsApp message | שליחת הודעת וואטסאפ |
| `auto.never.media` | anything from a voice note or a picture | שום דבר שמקורו בהודעה קולית או בתמונה |
| `auto.never.unsure` | anything the AI was unsure about or that carries a warning | שום דבר שהבינה לא הייתה בטוחה בו או שיש עליו אזהרה |
| `auto.never.foreign` | changing events the agent did not add | שינוי אירועים שהסוכן לא הוסיף |
| `auto.scope.edits` | Also change events when the contact asks | לשנות גם אירועים כשאיש הקשר מבקש |
| `auto.scope.cancels` | Also cancel events when the contact asks | לבטל גם אירועים כשאיש הקשר מבקש |
| `auto.scope.cancelsDesc` | A cancelled event stays restorable - Undo brings it back. | אירוע שבוטל נשאר ניתן לשחזור - ביטול השינוי מחזיר אותו. |
| `auto.scope.quiet` | Not during quiet hours (22:00-07:00) | לא בשעות השקטות (22:00-07:00) |
| `auto.scope.validity` | Ends after | מסתיים אחרי |
| `auto.scope.lockedWhileLive` | To change these, stop automatic mode and turn it on again. | כדי לשנות את אלה צריך לעצור את המצב האוטומטי ולהפעיל אותו מחדש. |
| `auto.enableTrial` / `auto.enableNow` | Start a 24-hour trial / Turn on now | התחלת ניסיון של 24 שעות / הפעלה עכשיו |
| `auto.endShadow` | Turn on for real | הפעלה בפועל |
| `auto.pause` / `auto.resume` / `auto.stop` / `auto.renew` | Pause / Resume / Stop / Renew | השהיה / המשך / עצירה / חידוש |
| `auto.waitingDialog` | Waiting for your answer in the Windows dialog... | ממתין לתשובה שלך בחלון של Windows... |
| `auto.openActivity` | See automatic activity | צפייה בפעילות האוטומטית |
| `auto.state.off` | Off - events wait for your approval. | כבוי - אירועים ממתינים לאישור שלך. |
| `auto.state.expired` | Ended on <bdi>{{date}}</bdi>. Events wait for your approval. | הסתיים ב-<bdi>{{date}}</bdi>. אירועים ממתינים לאישור שלך. |
| `auto.state.shadowEarly` | Trial until <bdi>{{time}}</bdi> - {{seen}} of 3 decisions seen. Nothing is changed for real. | ניסיון עד <bdi>{{time}}</bdi> - נבדקו {{seen}} מתוך 3 החלטות. בפועל שום דבר לא משתנה. |
| `auto.state.shadowReady` | Trial until <bdi>{{time}}</bdi>: {{wouldAdd}} to add, {{wouldChange}} to change. You approved {{same}} of them unchanged. Nothing was changed for real. | ניסיון עד <bdi>{{time}}</bdi>: {{wouldAdd}} להוספה, {{wouldChange}} לשינוי. {{same}} מהם אישרת בלי שינוי. בפועל שום דבר לא השתנה. |
| `auto.state.on_one` / `_two` / `_other` | On - {{used}} of {{limit}} today · ends in {{count}} day(s). | פועל - {{used}} מתוך {{limit}} היום · מסתיים בעוד יום אחד / יומיים / {{count}} ימים. |
| `auto.state.paused` | Paused - {{reason}}. | מושהה - {{reason}}. |
| `auto.pausedReason.user` | you paused it | השהית אותו |
| `auto.pausedReason.circuit_breaker_rate` | it reached today's limit | הוא הגיע למגבלה היומית |
| `auto.pausedReason.circuit_breaker_undo` | you undid two changes today, so it stopped to be safe | ביטלת היום שני שינויים, ולכן הוא נעצר ליתר ביטחון |
| `auto.pausedReason.circuit_breaker_unknown` | one change could not be confirmed | לא הצלחנו לוודא שינוי אחד |
| `auto.pausedReason.unattended` | the app was not opened for a week | האפליקציה לא נפתחה במשך שבוע |
| `auto.pausedReason.calendar_disconnected` | Google Calendar is not connected | יומן Google לא מחובר |
| `auto.pausedReason.snapshot_changed` | the calendar, account, AI or app version changed since you turned it on | היומן, החשבון, הבינה או גרסת האפליקציה השתנו מאז שהפעלת אותו |
| `auto.pre.connect` | Connect Google Calendar first. | קודם צריך לחבר את יומן Google. |
| `auto.pre.notOwned` | Only for a calendar you own - <bdi>{{calendar}}</bdi> is shared with you. | רק ביומן שבבעלותך - היומן <bdi>{{calendar}}</bdi> משותף איתך. |
| `auto.pre.trackRecord` | Available after you approve 3 events yourself ({{count}} of 3 so far). | יהיה זמין אחרי שתאשרו בעצמכם 3 אירועים (עד עכשיו {{count}} מתוך 3). |
| `auto.pre.rate` | Try again in an hour. | אפשר לנסות שוב בעוד שעה. |
| `auto.pre.providerWarning` | With Gemini - your subscription (experimental) nothing will happen automatically; every event will wait for you. | עם Gemini - המנוי שלך (ניסיוני) שום דבר לא יתבצע אוטומטית; כל אירוע ימתין לך. |
| `auto.notAutomatic` | Not automatic: {{reason}} | לא בוצע אוטומטית: {{reason}} |
| `auto.reason.no_policy` | automatic mode is off | המצב האוטומטי כבוי |
| `auto.reason.policy_shadow` | trial only | מצב ניסיון בלבד |
| `auto.reason.policy_paused` | automatic mode is paused | המצב האוטומטי מושהה |
| `auto.reason.policy_expired` | automatic mode has ended | תוקף המצב האוטומטי הסתיים |
| `auto.reason.snapshot_changed` | the calendar, account, AI or app version changed | היומן, החשבון, הבינה או גרסת האפליקציה השתנו |
| `auto.reason.calendar_disconnected` | Google Calendar is not connected | יומן Google לא מחובר |
| `auto.reason.calendar_not_owned` | the calendar is not yours | היומן אינו בבעלותך |
| `auto.reason.unknown_contact` | you have not written to this contact before | עוד לא כתבת לאיש הקשר הזה |
| `auto.reason.chat_opted_out` | you turned it off for this contact | כיבית את זה לאיש הקשר הזה |
| `auto.reason.chat_tainted` | a message in this chat looked suspicious this week | הודעה בשיחה הזו נראתה חשודה השבוע |
| `auto.reason.no_user_participation` | you have not written in this chat in the last 24 hours | לא כתבת בשיחה הזו ב-24 השעות האחרונות |
| `auto.reason.no_user_echo` | you have not confirmed the plan in the chat | לא אישרת את התוכנית בשיחה |
| `auto.reason.badge_red` | there is a warning on this card | יש אזהרה בכרטיס |
| `auto.reason.badge_amber` | something on this card needs checking | משהו בכרטיס דורש בדיקה |
| `auto.reason.badge_info` | there is a note on this card | יש הערה בכרטיס |
| `auto.reason.blocked_tool_call` | the AI tried something it is not allowed to do | הבינה ניסתה לעשות משהו שאסור לה |
| `auto.reason.suspicious` | the message may be trying to steer the AI | ייתכן שההודעה מנסה להשפיע על הבינה |
| `auto.reason.assumed_hour` | the hour was assumed | השעה הונחה |
| `auto.reason.missing_fields` | details are missing | חסרים פרטים |
| `auto.reason.low_confidence` | the AI was not sure | הבינה לא הייתה בטוחה |
| `auto.reason.intent_not_eligible` | this kind of request is never automatic | בקשה מהסוג הזה אף פעם לא מתבצעת אוטומטית |
| `auto.reason.title_rejected` | the event title needs checking | כותרת האירוע דורשת בדיקה |
| `auto.reason.media_derived` | it came from a voice note or a picture | זה הגיע מהודעה קולית או מתמונה |
| `auto.reason.provider_unsafe` | the AI used for this card may not act automatically | הבינה שניתחה את הכרטיס הזה לא מורשית לפעול אוטומטית |
| `auto.reason.beyond_horizon` | it is more than 30 days away | זה בעוד יותר מ-30 יום |
| `auto.reason.too_long` | its length is outside 5 minutes to 4 hours | המשך שלו מחוץ לטווח של 5 דקות עד 4 שעות |
| `auto.reason.too_soon` | it starts too soon | זה מתחיל בקרוב מדי |
| `auto.reason.quiet_hours` | it arrived during quiet hours | זה הגיע בשעות השקטות |
| `auto.reason.conflict` | you are busy then | יש לך משהו בזמן הזה |
| `auto.reason.duplicate` | a similar event already exists | כבר קיים אירוע דומה |
| `auto.reason.auto_budget` | today's limit for automatic changes was reached | הגעת למגבלה היומית של שינויים אוטומטיים |
| `auto.reason.edits_not_in_scope` | automatic changes to events are off | שינוי אוטומטי של אירועים כבוי |
| `auto.reason.cancel_not_in_scope` | automatic cancelling is off | ביטול אוטומטי כבוי |
| `auto.reason.cancel_too_soon` | the event is less than 24 hours away | האירוע בעוד פחות מ-24 שעות |
| `auto.reason.not_app_event` | the agent did not add this event | האירוע לא נוסף על ידי הסוכן |
| `auto.reason.wrong_item` | the event belongs to another conversation | האירוע שייך לשיחה אחרת |
| `auto.reason.not_own_copy` | the event is not yours | האירוע אינו שלך |
| `auto.reason.event_has_attendees` | the event has guests or repeats | לאירוע יש מוזמנים או שהוא חוזר |
| `auto.reason.event_cancelled` | the event is already cancelled | האירוע כבר בוטל |
| `auto.reason.modified_in_google` | you changed the event in Google | שינית את האירוע ב-Google |
| `auto.reason.move_too_far` | it moves the event by more than 14 days | השינוי מזיז את האירוע ביותר מ-14 יום |
| `auto.reason.edit_budget` | this event was already changed automatically twice | האירוע כבר שונה אוטומטית פעמיים |
| `auto.reason.unknown_prev_state` | the current event could not be read | לא הצלחנו לקרוא את האירוע הנוכחי |
| `auto.reason.no_track_record` | approve 3 events yourself first | קודם צריך לאשר בעצמך 3 אירועים |
| `auto.dialog.title` / `.titleRenew` | Turn on automatic mode? / Renew automatic mode? | להפעיל מצב אוטומטי? / לחדש את המצב האוטומטי? |
| `auto.dialog.message` | Events will be added to and changed in '{{calendar}}' without asking you first. | אירועים יתווספו ליומן '{{calendar}}' וישתנו בו בלי לשאול אותך קודם. |
| `auto.dialog.ends` | Ends on {{date}}. | יסתיים ב-{{date}}. |
| `auto.dialog.checkbox` | I understand events can be added or moved without asking me | ידוע לי שאירועים יתווספו או יזוזו בלי אישור ממני |
| `auto.dialog.cancel` / `.trial` / `.now` / `.renew` | Cancel / Start a 24-hour trial / Turn on now / Renew for {{days}} days | ביטול / התחלת ניסיון של 24 שעות / הפעלה עכשיו / חידוש ל-{{days}} ימים |
| `auto.strip.title` | Done automatically - last 7 days ({{count}}) | בוצע אוטומטית - 7 הימים האחרונים ({{count}}) |
| `auto.strip.hide` / `.show` / `.more` | Hide / Show / Show all in Automatic activity | הסתרה / הצגה / הצגת הכול בפעילות האוטומטית |
| `auto.verb.added` / `.movedFrom` / `.placeChanged` / `.cancelled` | added / moved from <bdi>{{when}}</bdi> / place changed / cancelled | נוסף / הוזז (היה <bdi>{{when}}</bdi>) / המקום שונה / בוטל |
| `auto.neverForContact` / `.allowAgain` / `.neverToast` | Never automatic for this contact / Allow again / Automatic changes turned off for this contact | אף פעם לא אוטומטית לאיש הקשר הזה / לאפשר שוב / שינויים אוטומטיים כובו לאיש הקשר הזה |
| `auto.announce.added` / `.moved` / `.cancelled` | Added automatically: {{when}}. / Moved automatically: {{when}}. / Cancelled automatically: {{when}}. | נוסף אוטומטית: {{when}}. / הוזז אוטומטית: {{when}}. / בוטל אוטומטית: {{when}}. |
| `auto.announce.state` | Automatic mode: {{state}}. | מצב אוטומטי: {{state}}. |
| `auto.stateWord.on` / `.shadow` / `.paused` / `.off` | on / trial / paused / off | פועל / ניסיון / מושהה / כבוי |
| `notify.auto.added.title` / `.moved.title` / `.cancelled.title` | Calendar: an event was added automatically / Calendar: an event was moved automatically / Calendar: an event was cancelled automatically | יומן: אירוע נוסף אוטומטית / יומן: אירוע הוזז אוטומטית / יומן: אירוע בוטל אוטומטית |
| `notify.auto.body` | Open the app to see it. | פתחו את האפליקציה כדי לראות. |
| `notify.auto.undo` / `.show` | Undo / Show | ביטול השינוי / הצגה |
| `notify.auto.burst.title_other` (+`_two`) | {{count}} automatic calendar changes | {{count}} שינויים אוטומטיים ביומן (two: שני שינויים אוטומטיים ביומן) |
| `notify.auto.burst.body` | Open the app to review them. | פתחו את האפליקציה כדי לעבור עליהם. |
| `notify.auto.undone.title` / `.undoFailed.title` / `.undoFailed.body` | Calendar change undone / Could not undo the calendar change / Open the app to see why. | השינוי ביומן בוטל / לא הצלחנו לבטל את השינוי ביומן / פתחו את האפליקציה כדי לראות למה. |
| `notify.auto.paused.title` / `.body` | Automatic mode paused / Open the app to see why. | המצב האוטומטי הושהה / פתחו את האפליקציה כדי לראות למה. |
| `notify.auto.expiring.title` / `.body` | Automatic mode ends in 3 days / You can renew it in Settings. | המצב האוטומטי יסתיים בעוד 3 ימים / אפשר לחדש אותו בהגדרות. |
| `notify.overage.title` / `.body` | The AI was paused / Paid extra usage started. Open the app to decide. | הבינה הושהתה / התחיל שימוש נוסף בתשלום. פתחו את האפליקציה כדי להחליט. |
| `notify.voiceReady.title` / `.body` | Voice notes are ready / Voice messages will now be transcribed on this computer. | הודעות קוליות מוכנות / מעכשיו הודעות קוליות יתומללו במחשב הזה. |
| `tray.auto.on` / `.shadow` / `.paused` | Automatic mode: on - click to pause / Automatic mode: trial - click to stop / Automatic mode: paused - open to resume | מצב אוטומטי: פועל - לחיצה להשהיה / מצב אוטומטי: ניסיון - לחיצה לעצירה / מצב אוטומטי: מושהה - פתיחה להמשך |
| `tray.status.active_claude_cli` / `active_antigravity_cli` / `active_claude_api` / `active_gemini_api` | Active - Claude (your subscription) / Active - Gemini (your subscription) / Active - Claude (API key) / Active - Gemini (API key) | פעיל - Claude (המנוי שלך) / פעיל - Gemini (המנוי שלך) / פעיל - Claude (מפתח API) / פעיל - Gemini (מפתח API) |
| `settings.general.notificationsAutoNote` | Automatic calendar changes always show a notification, even when this is off. | שינויים אוטומטיים ביומן תמיד מציגים התראה, גם כשזה כבוי. |

`auto.reason.no_user_echo` exists for exhaustiveness but is never emitted in v2.0 (D-057 defers user-echo; concern C12).

### 14.4 `activity.*`

| Key | en | he |
|---|---|---|
| `activity.title` / `.back` | Automatic activity / Automatic mode | פעילות אוטומטית / מצב אוטומטי |
| `activity.today` / `.yesterday` | Today / Yesterday | היום / אתמול |
| `activity.notAutomatic` | Not automatic | לא בוצע אוטומטית |
| `activity.wouldAdd` / `.wouldChange` | Would have been added / Would have been changed | היה מתווסף / היה משתנה |
| `activity.export` / `.exportNote` / `.exported` | Export (JSON) / Times, kinds and reasons only - no titles, names or messages. / Exported | ייצוא (JSON) / רק זמנים, סוגים וסיבות - בלי כותרות, שמות או הודעות. / יוצא |
| `activity.retention` | Entries are kept for 180 days (decisions for 90 days). | הרשומות נשמרות 180 יום (החלטות - 90 יום). |
| `activity.empty` / `.older` | Nothing happened automatically yet. / Show older | עוד לא קרה שום דבר אוטומטית. / הצגת ישנים יותר |

### 14.5 `voice.*` and `image.*`

| Key | en | he |
|---|---|---|
| `voice.label` | Voice message · <bdi>{{duration}}</bdi> | הודעה קולית · <bdi>{{duration}}</bdi> |
| `voice.durationA11y` | {{minutes}} minutes {{seconds}} seconds | {{minutes}} דקות ו-{{seconds}} שניות |
| `voice.lang.he` / `.en` / `.other` | Hebrew / English / Other language | עברית / אנגלית / שפה אחרת |
| `voice.transcriptLabel` | Transcript | תמלול |
| `voice.caution` | Transcribed on this computer - may contain mistakes | תומלל במחשב הזה - ייתכנו טעויות |
| `voice.cautionSheet` | Transcribed on this computer with the {{model}} voice model - may contain mistakes | תומלל במחשב הזה עם מודל הקול {{model}} - ייתכנו טעויות |
| `voice.model.hebrew` / `.multilingual` / `.lite` | Hebrew / all-languages / lite | העברי / הרב-לשוני / הקל |
| `voice.noSpeech` / `.notTranscribed` / `.removed` | No speech detected / Not transcribed / Transcript was removed after {{days}} days | לא זוהה דיבור / לא תומלל / התמלול הוסר אחרי {{days}} ימים |
| `voice.holdModel` | Voice notes: model not downloaded | הודעות קוליות: המודל לא הורד |
| `voice.transcribing` | Transcribing a voice note (<bdi>{{duration}}</bdi>)... | מתמלל הודעה קולית (<bdi>{{duration}}</bdi>)... |
| `settings.voice.title` / `.desc` | Voice notes / Voice notes are always transcribed on this computer. Nothing is sent anywhere. | הודעות קוליות / הודעות קוליות מתומללות תמיד במחשב הזה. שום דבר לא נשלח. |
| `settings.voice.off` / `.hebrew` / `.multilingual` / `.lite` | Off / Hebrew-optimised (recommended) / Any language, detected automatically / Lite - faster, less accurate | כבוי / מותאם לעברית (מומלץ) / כל שפה, בזיהוי אוטומטי / קל - מהיר יותר, מדויק פחות |
| `settings.voice.confirmDownload` | Download the {{name}} voice model ({{size}})? | להוריד את מודל הקול {{name}} ({{size}})? |
| `settings.voice.bench` / `.test` / `.testing` | Speed on this computer: about {{seconds}} s per minute of audio / Test / Testing... | מהירות במחשב הזה: בערך {{seconds}} שניות לכל דקת שמע / בדיקה / בודק... |
| `settings.voice.suggestLite` / `.useLite` | Slow on this computer - the Lite model is faster. / Use Lite | איטי במחשב הזה - המודל הקל מהיר יותר. / מעבר למודל הקל |
| `settings.voice.maxNote` | Notes longer than 15 minutes are not transcribed. | הודעות ארוכות מ-15 דקות לא מתומללות. |
| `settings.voice.waiting` | Downloading {{percent}} % - voice notes wait as plain cards | בהורדה {{percent}} % - הודעות קוליות ממתינות ככרטיסים פשוטים |
| `download.kind.voice-hebrew` / `voice-multilingual` / `voice-lite` / `mmproj` | Voice model (Hebrew) / Voice model (all languages) / Voice model (lite) / Picture reading | מודל קול (עברית) / מודל קול (כל השפות) / מודל קול (קל) / קריאת תמונות |
| `download.queued` / `download.more` | Queued - starts after the AI model / +{{count}} | בתור - יתחיל אחרי מודל הבינה / +{{count}} |
| `download.finishedVoice` / `.finishedImages` | Voice model ready - voice notes will be transcribed. / Picture reading ready. | מודל הקול מוכן - הודעות קוליות יתומללו. / קריאת התמונות מוכנה. |
| `image.label` | Picture | תמונה |
| `image.readLabel` | Text read from the picture | טקסט שנקרא מהתמונה |
| `image.caution` | Read from the picture - may contain mistakes | נקרא מהתמונה - ייתכנו טעויות |
| `image.alt` | Picture sent by {{name}} | תמונה שנשלחה על ידי {{name}} |
| `image.sheetTitle` / `.whatRead` | The picture / What the AI read from the picture | התמונה / מה הבינה קראה מהתמונה |
| `image.asWritten.date` / `.time` / `.place` | Date as written: <bdi>{{v}}</bdi> / Time as written: <bdi>{{v}}</bdi> / Place as written: <bdi>{{v}}</bdi> | התאריך כפי שכתוב: <bdi>{{v}}</bdi> / השעה כפי שכתובה: <bdi>{{v}}</bdi> / המקום כפי שכתוב: <bdi>{{v}}</bdi> |
| `image.checkAgainst` | Check against the picture | כדאי לבדוק מול התמונה |
| `image.unread.no_local_reader` / `.disabled` / `.provider_cannot` / `.media_unavailable` / `.read_failed` | Picture not read - picture reading is not downloaded / Picture not read - turned off / Picture not read by this AI / The picture was not received / Could not read the picture | התמונה לא נקראה - רכיב קריאת התמונות לא הורד / התמונה לא נקראה - האפשרות כבויה / הבינה הזו לא קוראת תמונות / התמונה לא התקבלה / לא הצלחנו לקרוא את התמונה |
| `image.action.download` / `.turnOn` / `.chooseAi` | Download picture reading ({{size}}) / Turn on in Settings / Choose an AI that can read pictures | הורדת רכיב קריאת תמונות ({{size}}) / הפעלה בהגדרות / בחירת בינה שיודעת לקרוא תמונות |
| `image.removed` | Picture was removed after {{days}} days | התמונה הוסרה אחרי {{days}} ימים |
| `settings.images.title` / `.enabled` / `.enabledDesc` | Pictures / Read pictures / Dates and places written in a picture (an invitation, a poster) become event suggestions. What was read is always shown on the card. | תמונות / קריאת תמונות / תאריכים ומקומות שכתובים בתמונה (הזמנה, מודעה) הופכים להצעות לאירוע. מה שנקרא תמיד מוצג בכרטיס. |
| `settings.images.cloud` / `.cloudDesc` | Read pictures with {{vendor}} / Pictures are sent to {{vendor}}. Agreed on <bdi>{{date}}</bdi>. | קריאת תמונות עם {{vendor}} / התמונות נשלחות אל {{vendor}}. אושר ב-<bdi>{{date}}</bdi>. |
| `settings.images.localOnly` | With this AI, pictures are read on this computer. | עם הבינה הזו, תמונות נקראות במחשב הזה. |
| `settings.images.local` / `.localDesc` / `.restartNote` | Picture reading on this computer / Used when the cloud AI does not read pictures. Downloads only when you ask. / The AI on this computer restarts to load picture reading (about 30 seconds). | קריאת תמונות במחשב הזה / משמשת כשהבינה בענן לא קוראת תמונות. יורדת רק כשמבקשים. / הבינה שבמחשב תופעל מחדש כדי לטעון את קריאת התמונות (בערך 30 שניות). |

### 14.6 `cli.*` (Connect card, provider cards, limits, consents)

| Key | en | he |
|---|---|---|
| `ai.provider.local` | On this computer | במחשב הזה |
| `ai.provider.claude_cli` / `.claude_cliDesc` | Claude - your subscription / Uses the Claude plan you already pay for, through the Claude Code you installed. No API key. | Claude - המנוי שלך / משתמש במנוי Claude שכבר יש לך, דרך Claude Code שהתקנת. בלי מפתח API. |
| `ai.provider.antigravity_cli` / `.antigravity_cliDesc` | Gemini - your subscription / Uses your Google AI plan through the Antigravity CLI you installed. | Gemini - המנוי שלך / משתמש במנוי Google AI שלך דרך Antigravity CLI שהתקנת. |
| `ai.provider.claude` / `.gemini` | Claude with an API key / Gemini with an API key | Claude עם מפתח API / Gemini עם מפתח API |
| `ai.experimental` / `ai.showExperimental` | Experimental / Show experimental | ניסיוני / הצגת אפשרויות ניסיוניות |
| `ai.advanced` / `ai.advancedDesc` | Advanced: use an API key / Use this if you do not have a subscription or the subscription route stops working. | מתקדם: שימוש במפתח API / מתאים אם אין לך מנוי או אם המסלול דרך המנוי מפסיק לעבוד. |
| `ai.cli.privacy` | The analysed chat is sent to {{vendor}} through your own sign-in - without names or phone numbers. | השיחה שמנותחת נשלחת אל {{vendor}} דרך החשבון שלך - בלי שמות ובלי מספרי טלפון. |
| `ai.use` / `ai.useChecking` / `ai.stillUsing` / `ai.finishSteps` | Use {{provider}} / Checking {{vendor}}... / Still using: {{provider}} / Finish the steps above first | שימוש ב-{{provider}} / בודק את {{vendor}}... / עדיין בשימוש: {{provider}} / קודם צריך להשלים את השלבים שלמעלה |
| `cli.checking` | Looking for {{cli}} on this computer... | מחפש את {{cli}} במחשב הזה... |
| `cli.notInstalled` | {{cli}} is not installed on this computer. | {{cli}} לא מותקן במחשב הזה. |
| `cli.runThis` | Run this in PowerShell, then come back: | הריצו את הפקודה ב-PowerShell וחזרו לכאן: |
| `cli.neverInstalls` | The app never installs anything itself. | האפליקציה אף פעם לא מתקינה דבר בעצמה. |
| `cli.commandLabel` | Install command / Update command | פקודת התקנה / פקודת עדכון |
| `cli.copyCommand` / `cli.openInstallPage` / `cli.checkAgain` | Copy command / Open install page / Check again | העתקת הפקודה / פתיחת דף ההתקנה / בדיקה חוזרת |
| `cli.checkedAgo` | Checked {{value}} ago | נבדק לפני {{value}} |
| `cli.tooOld` | {{cli}} {{version}} is too old - version {{min}} or newer is needed. | הגרסה {{version}} של {{cli}} ישנה מדי - נדרשת גרסה {{min}} ומעלה. |
| `cli.wingetHint` | Installed with WinGet? Use: <bdi dir="ltr">winget upgrade Anthropic.ClaudeCode</bdi> | הותקן דרך WinGet? השתמשו ב: <bdi dir="ltr">winget upgrade Anthropic.ClaudeCode</bdi> |
| `cli.notSignedIn` | {{cli}} {{version}} is installed but not signed in. | {{cli}} {{version}} מותקן אבל לא מחובר לחשבון. |
| `cli.signIn` | Sign in | התחברות |
| `cli.signInNote.claude_cli` | Sign-in opens in Anthropic's own window. The app never sees your password. | ההתחברות נפתחת בחלון של Anthropic עצמה. האפליקציה לא רואה את הסיסמה. |
| `cli.signInNote.antigravity_cli` | Antigravity opens your browser to sign in; close the console window when it says you are signed in. | Antigravity תפתח את הדפדפן להתחברות; אפשר לסגור את חלון המסוף כשיופיע שההתחברות הצליחה. |
| `cli.waitingSignIn` | Finish signing in in the window that opened. It can take up to a minute for the app to notice. | סיימו את ההתחברות בחלון שנפתח. ייתכן שיעבור עד דקה עד שהאפליקציה תזהה את זה. |
| `cli.unknown` | Could not tell whether you are signed in. | לא הצלחנו לבדוק אם יש חיבור לחשבון. |
| `cli.ready` | Ready - {{cli}} {{version}}, signed in. | מוכן - {{cli}} {{version}}, מחובר לחשבון. |
| `cli.usageResets` | usage resets <bdi>{{time}}</bdi> | המכסה מתחדשת ב-<bdi>{{time}}</bdi> |
| `cli.model` / `cli.modelHintClaude` / `cli.modelHintAgy` / `cli.recommended` | Model / as available on your plan / as reported by the CLI / recommended | מודל / לפי מה שזמין במנוי שלך / לפי מה שה-CLI מדווח / מומלץ |
| `cli.test` / `cli.testNote` / `cli.testing` / `cli.testOk` / `cli.testBusy` | Run a test / (uses a little of your usage) / Testing... / Works - answered in about {{seconds}} s / Testing is limited while the AI is busy | הרצת בדיקה / (משתמש במעט מהמכסה שלך) / בודק... / עובד - ענה תוך כ-{{seconds}} שניות / אי אפשר לבדוק כשהבינה עסוקה |
| `cli.consentDate` / `cli.withdraw` | Agreed to send chats on <bdi>{{date}}</bdi>. / Withdraw | אושרה שליחת שיחות ב-<bdi>{{date}}</bdi>. / ביטול ההסכמה |
| `cli.limits.title` | Usage limits | מגבלות שימוש |
| `cli.limits.runsPerHour` / `.runsDesc` | Up to {{count}} AI runs per hour / Your subscription's usage window is shared with your own use of {{vendor}}. | עד {{count}} הרצות בינה בשעה / חלון השימוש של המנוי משותף עם השימוש שלך ב-{{vendor}}. |
| `cli.limits.overage` / `.overageDesc` | Allow paid extra usage / When off, the AI pauses as soon as your plan starts charging for extra usage. | לאפשר שימוש נוסף בתשלום / כשזה כבוי, הבינה נעצרת ברגע שהמנוי מתחיל לחייב על שימוש נוסף. |
| `cli.limits.overageConfirmTitle` / `.overageConfirmBody` / `.overageAllow` / `.overageKeepOff` | Allow paid extra usage? / When your plan's included usage runs out, Anthropic may charge you for the AI's runs. / Allow / Keep it off | לאפשר שימוש נוסף בתשלום? / כשהשימוש הכלול במנוי ייגמר, Anthropic עשויה לחייב אותך על הרצות הבינה. / לאפשר / להשאיר כבוי |
| `cli.exePath` / `.exeChange` / `.exeAuto` | Claude Code location / Change... / Use automatic | המיקום של Claude Code / שינוי... / זיהוי אוטומטי |
| `cli.agy.disclosureTitle` | Experimental - read before using | ניסיוני - כדאי לקרוא לפני השימוש |
| `cli.agy.disclosure` | Google's terms for Antigravity forbid using it with "third-party software, tools, or services", and Google has suspended accounts for it; Google staff have also said that running the official CLI on your own computer is fine. The app runs the unmodified Antigravity CLI with your own sign-in and nothing else - the risk to your account is yours. Antigravity keeps a copy of every request on this computer. Google's supported way is Gemini with an API key (under Advanced). Terms read on <bdi>{{termsDate}}</bdi>. | תנאי השימוש של Google ב-Antigravity אוסרים שימוש בו עם "third-party software, tools, or services" (תוכנות, כלים או שירותים של צד שלישי), ו-Google כבר השעתה חשבונות בגלל זה; מנגד, עובדי Google אמרו שהפעלת ה-CLI הרשמי על המחשב שלך מותרת. האפליקציה מפעילה את Antigravity CLI המקורי, ללא שינוי, עם החשבון שלך ותו לא - הסיכון לחשבון הוא שלך. Antigravity שומרת עותק של כל בקשה במחשב הזה. הדרך ש-Google תומכת בה היא Gemini עם מפתח API (תחת "מתקדם"). התנאים נקראו ב-<bdi>{{termsDate}}</bdi>. |
| `cli.agy.noTools` | This AI cannot look up older messages by itself; the app hands it the last {{days}} days of this chat. | הבינה הזו לא יכולה לחפש הודעות ישנות בעצמה; האפליקציה מעבירה לה את {{days}} הימים האחרונים של השיחה. |
| `cli.agy.picturesLocal` | Pictures are read on this computer while this AI is selected. | כשהבינה הזו נבחרת, תמונות נקראות במחשב הזה. |
| `cli.agy.noAuto` | Automatic mode does nothing while this AI is selected. | כשהבינה הזו נבחרת, המצב האוטומטי לא מבצע דבר. |
| `cli.agy.workspaceTitle` / `.workspaceBody` / `.workspaceBackup` / `.workspaceAllow` | Antigravity needs to trust the app's working folder once. / This changes one line in your Antigravity settings file: / A backup of the file is saved next to it. Nothing else in the file is touched. / Allow the app's folder... | Antigravity צריכה לסמוך פעם אחת על תיקיית העבודה של האפליקציה. / זה משנה שורה אחת בקובץ ההגדרות של Antigravity: / גיבוי של הקובץ נשמר לידו. שום דבר אחר בקובץ לא משתנה. / אישור התיקייה של האפליקציה... |
| `cli.agy.workspaceDone` / `.workspaceBusy` | Done - a backup was saved next to the file. / Close Antigravity first, then try again. | בוצע - גיבוי נשמר ליד הקובץ. / קודם סגרו את Antigravity ואז נסו שוב. |
| `cli.agy.dialogTitle` / `.dialogOk` | Change your Antigravity settings? / Change one line | לשנות את ההגדרות של Antigravity? / שינוי שורה אחת |
| `cli.geminiCliNote` | Looking for the Gemini CLI? It no longer accepts Google AI Pro or Ultra sign-ins, so it cannot use your subscription. Use this experimental option or Gemini with an API key. | מחפשים את Gemini CLI? הוא כבר לא מקבל התחברות עם מנוי Google AI Pro או Ultra, ולכן אי אפשר להשתמש בו עם המנוי. אפשר להשתמש באפשרות הניסיונית הזו או ב-Gemini עם מפתח API. |
| `cli.command.claudeInstall` (constant, not translated) | irm https://claude.ai/install.ps1 \| iex | (same) |
| `cli.command.claudeUpdate` | claude update | (same) |
| `cli.command.agyInstall` | irm https://antigravity.google/cli/install.ps1 \| iex | (same) |
| `consent.cloud_claude.v2.*`, `consent.cloud_gemini.v2.*`, `consent.cloud_claude_cli.v1.*`, `consent.cloud_antigravity_cli.v1.*` | `{title, sent, never, who, goodToKnow?, accept}` with the texts of 7.5 | Hebrew per 7.5 in the same structure; the Antigravity `goodToKnow` = `cli.agy.disclosure` |
| `setup.consentV2.text` / `.action` | Your approval is needed again for {{vendor}} - it now also covers voice-note transcripts and pictures. / Review | נדרש שוב אישור שלך עבור {{vendor}} - עכשיו הוא כולל גם תמלולי הודעות קוליות ותמונות. / לעיון |
| `setup.auto.paused` / `.trialEarly` / `.trialReady` / `.expiring` / `.expired` | Automatic mode is paused - {{reason}}. / Automatic mode - trial: {{seen}} of 3 decisions seen so far. / Automatic mode - trial: {{wouldAdd}} would have been added, {{wouldChange}} changed. / Automatic mode ends in {{count}} days. / Automatic mode ended on <bdi>{{date}}</bdi>. Events wait for your approval again. | המצב האוטומטי מושהה - {{reason}}. / מצב אוטומטי - ניסיון: נבדקו עד עכשיו {{seen}} מתוך 3 החלטות. / מצב אוטומטי - ניסיון: {{wouldAdd}} היו מתווספים ו-{{wouldChange}} היו משתנים. / המצב האוטומטי יסתיים בעוד {{count}} ימים. / המצב האוטומטי הסתיים ב-<bdi>{{date}}</bdi>. אירועים שוב ממתינים לאישור שלך. |
| `setup.voice.downloading` | Voice notes: model downloading {{percent}} %. | הודעות קוליות: המודל בהורדה {{percent}} %. |
| `health.sub.readTools.trigger_chat` / `.all_chats` | Reading older messages: this chat only / Reading older messages: all chats | קריאת הודעות ישנות: רק מהשיחה הזו / קריאת הודעות ישנות: מכל השיחות |
| `health.sub.voice.ready` / `.downloading` / `.off` | Voice notes: ready / Voice notes: downloading {{percent}} % / Voice notes: off | הודעות קוליות: מוכן / הודעות קוליות: בהורדה {{percent}} % / הודעות קוליות: כבוי |
| `health.sub.images.ready` / `.missing` / `.off` | Pictures: ready / Pictures: not downloaded / Pictures: off | תמונות: מוכן / תמונות: לא הורד / תמונות: כבוי |
| `health.sub.auto.on` / `.shadow` / `.paused` / `.off` | Automatic mode: on - ends in {{count}} days / Automatic mode: trial - {{seen}} of 3 seen / Automatic mode: paused - {{reason}} / Automatic mode: off | מצב אוטומטי: פועל - מסתיים בעוד {{count}} ימים / מצב אוטומטי: ניסיון - {{seen}} מתוך 3 / מצב אוטומטי: מושהה - {{reason}} / מצב אוטומטי: כבוי |
| `health.provider.claude_cli` / `.antigravity_cli` | Claude - your subscription / Gemini - your subscription (experimental) | Claude - המנוי שלך / Gemini - המנוי שלך (ניסיוני) |
| `health.llm.cliState.not_installed` / `.too_old` / `.not_signed_in` / `.unknown` | {{provider}} - not installed / {{provider}} - needs an update / {{provider}} - not signed in / {{provider}} - sign-in unknown | {{provider}} - לא מותקן / {{provider}} - צריך עדכון / {{provider}} - לא מחובר לחשבון / {{provider}} - מצב ההתחברות לא ידוע |
| `health.calendar.update_unavailable` | Changes to events are unavailable (component version) | אי אפשר לשנות אירועים (גרסת הרכיב) |
| `settings.readTools.title` / `.desc` / `.off` / `.trigger` / `.all` / `.allWarn` / `.days` / `.refused` / `.agyNote` | Let the AI read older messages / The AI can look further back when a message refers to something said earlier. / Off / Of this chat only / Of all my chats / With a cloud AI this sends parts of other chats to {{vendor}}. / How far back / Not changed - your approval is needed first. / With this AI the app hands over the last {{days}} days of this chat instead; the AI cannot look further by itself. | לאפשר לבינה לקרוא הודעות ישנות / הבינה יכולה להסתכל אחורה כשהודעה מתייחסת למשהו שנאמר קודם. / כבוי / רק מהשיחה הזו / מכל השיחות שלי / עם בינה בענן, זה שולח קטעים משיחות אחרות אל {{vendor}}. / כמה זמן אחורה / לא שונה - קודם נדרש אישור שלך. / עם הבינה הזו האפליקציה מעבירה במקום זה את {{days}} הימים האחרונים של השיחה; הבינה לא יכולה לחפש רחוק יותר בעצמה. |
| `settings.rules.autoColumn` / `.autoInherit` / `.autoNever` | Automatic / As everyone / Never | אוטומטי / כמו כולם / אף פעם |
| `settings.calendar.owned` / `.shared` | You own this calendar / This calendar is shared with you - automatic mode is not available for it | היומן הזה בבעלותך / היומן הזה משותף איתך - המצב האוטומטי לא זמין בו |
| `onboarding.ai.voiceOptIn` / `.voiceNoDisk` / `.voiceNoRam` / `.picturesNote` | Also understand voice notes ({{size}}, Hebrew-optimised) / Needs {{size}} of free space / Needs 8 GB of memory / Pictures are read by the AI you choose. Picture reading on this computer ({{size}}) downloads only when you ask for it. | להבין גם הודעות קוליות ({{size}}, מותאם לעברית) / נדרשים {{size}} פנויים / נדרשים 8 GB זיכרון / תמונות נקראות על ידי הבינה שבחרתם. קריאת תמונות במחשב הזה ({{size}}) יורדת רק כשמבקשים. |
| `onboarding.google.autoLater` | Later, in Settings, you can let the agent add and change events by itself. | בהמשך, בהגדרות, אפשר לאפשר לסוכן להוסיף ולשנות אירועים בעצמו. |
| `onboarding.ready.voice` (+ states) | Voice notes: downloading {{percent}} % - voice messages wait until it is ready / ready / off | הודעות קוליות: בהורדה {{percent}} % - הודעות קוליות ממתינות עד שהמודל יהיה מוכן / מוכן / כבוי |
| `sheet.provider.<id>` | AI on this computer / Claude (your subscription) / Gemini (your subscription, experimental) / Claude (API key) / Gemini (API key) | הבינה שבמחשב הזה / Claude (המנוי שלך) / Gemini (המנוי שלך, ניסיוני) / Claude (מפתח API) / Gemini (מפתח API) |
| `sheet.autoBlock` | Added automatically on <bdi>{{when}}</bdi> | נוסף אוטומטית: <bdi>{{when}}</bdi> |

---

## 15. Acceptance checklist additions (L9; jsdom + Playwright against the fakes)

1. **No approval without a click, v2 edition**: every new approval-class button (Approve change, Cancel event, Apply anyway, Add as new event, Add it back, Undo in any in-window door) sends exactly one IPC per activation, is disabled synchronously, ignores `event.detail > 1`, and ignores activation for 500 ms after focus/visibility (test per button). No code path calls `item:undoChange`, `auto:undo`, `auto:requestEnable`, `auto:endShadow` or `auto:resume` from an effect, a timer, a toast, a push event or a keyboard shortcut.
2. **The renderer never flips automatic mode**: grep/import test - no `settings:set` payload contains an `auto` key; `auto:requestEnable` is called only from the two enable buttons' click handlers; Pause/Stop exist in the strip, settings and activity page.
3. **Untrusted strings** (v1 list + transcript, `readText`, `asWritten.*`, calendar name, CLI version string) appear only inside VoiceBubble/ImageBubble/EventChip/EventEditor/ChangeLine `<bdi>` slots, AutoStrip/activity row title slots, and `<bdi>` interpolations; never in `document.title`, toasts, tray, `aria-live` text, headings or attributes other than `alt`/`aria-label` of the card and image. No `dangerouslySetInnerHTML`.
4. **Three lists stay**: the dashboard renders exactly three `list-*` sections; `autostrip` has no `role="list"` at the page level other than its rows and no approval buttons.
5. **De-duplication**: with a pending change, the In-calendar list renders the event once (keyed by `calendarEventKey`) and the source card shows `change-pending-chip-*`.
6. **Reason line gating**: `auto-reason-*` renders only when `AutoStateVM.policy` is live; every `AUTO_REASONS` value has an `auto.reason.*` key in both files (parity + exhaustiveness test over the shared constant).
7. **Locale parity** extends to every key of section 14 and every new `errors.<CODE>`; Hebrew plural forms `_one/_two/_other` exist where counts appear; `undo.button` in he is "ביטול השינוי" (regression test for the undo/cancel ambiguity).
8. **RTL**: snapshots of AutoStrip, Change card (all three kinds), VoiceBubble, ImageBubble, Connect card (each state), Automatic mode group and activity page in `dir="rtl"`; ChangeLine order test: in he the DOM order is from-arrow-to and the computed direction is rtl; command fields compute `direction: ltr`.
9. **Accessibility**: role/name queries for every new control; the ChangeLine exposes the sentence form; the reason line is in the approval button's description; Narrator/NVDA manual pass in both languages covers the auto-enable flow (native dialog) and Undo.
10. **Forced colours / dark**: screenshots of the new components reviewed once (dotted media rule, dashed shadow chip, struck cancelled title visible).
11. **Window 420 x 560**: AutoStrip rows, the Change card button row and the Connect card command field wrap without horizontal overflow in both languages.

---

## 16. Architecture concerns

This spec follows `ARCHITECTURE-v2.md` in every case. The points below are where it is silent, internally inconsistent, or where a UX need has no contract yet. None was resolved by deviating; each says what the spec does meanwhile.

| # | Concern | What this spec does | Suggested fix (orchestrator) |
|---|---|---|---|
| C1 | **Size literals disagree with the v1 size formula.** ARCH-v2 copy says "Download (1.6 GB)", "(0.99 GB)", "1.6 GB, Hebrew-optimised" (decimal GB), while ux.md 8.1 fixes sizes as pinned bytes / 2^30 with one decimal (1,624,555,275 B -> 1.5; 985,654,080 B -> 0.9). The picture-reading size also depends on the tier (12B projector = 175,115,840 B -> 0.2), so a fixed "0.99 GB" is wrong for the Large tier. | All sizes are `{{size}}` from the pinned bytes with the v1 formula. | Record that copy sizes are always interpolated; drop the literals from ARCH-v2 11/13. |
| C2 | **The update command depends on how Claude Code was installed** (native/npm: `claude update`; WinGet: `winget upgrade Anthropic.ClaudeCode`, no auto-update - verified 2026-09-28), but `cli:getStatus` returns no install kind. | Shows `claude update` plus a WinGet hint line. | Add `installKind: 'native'|'npm'|'winget'|'unknown'` (derived by the locator from the resolved path) to the `cli:getStatus` response. |
| C3 | **Sign-in detection latency.** B13 limits `auth status` to once a minute; after `cli:signIn` the user may wait up to 60 s before the card flips to Ready. | Explains the delay in `cli.waitingSignIn`; renderer polls, main serves the cache. | Allow one extra `auth status` probe per `cli:signIn` (e.g. first poll after 20 s), still bounded. |
| C4 | **Enabling automatic mode while `antigravity_cli` is active** passes every B7 precondition, yet every decision will fall back `provider_unsafe` (B14/C4) - a policy that can never act, consuming its 30-day window. | Buttons stay enabled; a warning line says nothing will happen automatically. | Either add "active provider is auto-capable" to the B7 preconditions (new ErrorCode) or keep the warning as the documented behaviour. |
| C5 | **`auto:getState` does not expose the enable preconditions** (calendar connected/owned + name, count of user-approved done creates, dialog rate budget, provider auto-capability). Without them the settings page can only learn them by pressing Enable and getting an ErrorCode. | Spec defines `AutoStateVM.preconditions` (section 12). | Extend the `auto:getState` response in contracts.md with the `preconditions` object. |
| C6 | **No IPC changes the scope of a live policy.** Narrowing (e.g. turning cancels off) while on requires Stop + a new enable, which restarts the trial and the 30-day window. | Scope controls are read-only while live, with an explanatory line. | Acceptable for v2.0; a later `auto:narrowScope` (narrowing only, no dialog) would be safe. |
| C7 | **Quiet hours: toggle or fixed?** ARCH-v2 11 lists quiet hours among the scope toggles; B7 gives `quietHours` "default 22-07" but does not say whether it may be null/off. | Rendered as a toggle defaulting on. | Define `quietHours: {start,end} | null` (or literal) in `AutoScopeSchema`; if literal, L9 renders a fixed line. |
| C8 | **No ErrorCode for the 3-per-hour enable-dialog rate limit** (`rate_events` bucket `auto_dialog`, B7). | Inline text "Try again in an hour." | Add `AUTO_DIALOG_RATE_LIMITED` (or reuse a `RATE_LIMIT_*` code) to the deck. |
| C9 | **RESOLVED by F32 (`item:cancelEvent`).** "Cancel event" after `blocked_started` has no channel. B10/6.4 say the card offers "Cancel event" as an explicit click, but no IPC creates a user-initiated cancel `update_event` (all updates today come from S4 deltas or `item:undoChange`). | Button specified but rendered only once the channel exists; meanwhile the amber line + "Open in calendar". | Add `item:cancelEvent {itemId}` (focused window, same gate as approve) that mints a pending `update_event {change:'cancel'}` + approves it with `approved_by 'user'`. |
| C10 | **Thumbnails in the list payload.** ARCH-v2 10 says lists carry the 320-px thumbnail; with 60 items per `dashboard:get` this can add ~1-2 MB to every refresh (ux.md C11 already flags the list payload as the largest privacy surface in the renderer). | Uses `ItemVM.trigger.image.thumbDataUrl` as specified. | Cap thumbnails to items in the first 20 of each list, or add `item:getThumb {itemId}` fetched lazily per visible card. |
| C11 | **Who sets `voice.enabled` after the onboarding opt-in?** B23 comments "enabled: false until a voice model is ready", but ARCH-v2 5 S0 already holds audio as raw cards when enabled and no model is ready, and onboarding offers the checkbox before any model exists. | The checkbox sets `voice.enabled = true` + queues the download (S0 holds voice notes until ready). | Confirm in contracts.md that `enabled` is the user's intent and readiness is a separate fact (drop the "until ready" comment). |
| C12 | **`no_user_echo` is in `AUTO_REASONS` but user-echo is deferred** (D-057). | Locale key exists; never expected at runtime. | Keep the value for exhaustiveness; the gate test should assert it is unreachable in v2.0. |
| C13 | **Status panel "at most one sub-line" vs three AI facts** (quota, voice, pictures - ARCH-v2 11). | Facts joined into one line with " · ". | None if joining is acceptable; otherwise allow two sub-lines for the AI row. |
| C14 | **Health has no pictures fact.** `health:changed` gains `llm.quota` and a `voice` part, but "Pictures: ready / not downloaded" needs `mmprojPresent` / `images.enabled` (and whether the active provider reads pictures). | Reads it from the model store (`model:*`) and settings. | Add `images: {state:'ready'|'missing'|'off'|'cloud'}` to `AppHealth` for one source of truth. |
| C15 | **RESOLVED by F32 (`event_state='declined'` + S4 suppression of a re-proposal with the same `to`).** Rejecting an `update_event` ("Keep 15:00") has no defined item state. `event_state='change_proposed'` maps to `needs_reply`; after `action:reject` the delta item still has a reply draft but no pending change. | Removes ChangeLine and change buttons; the card stays for the reply; the source chip disappears. | Define in `deriveState()`: rejected update -> `event_state` back to `none` on the delta item (and `linked_item_id` kept for audit). |
| C16 | **Toast-Undo result feedback is not in B11.** When Undo is pressed on a Windows toast the window is hidden; without a result the user cannot know whether the undo happened. | Adds `notify.auto.undone` / `undoFailed` toasts (app text only). | Confirm in L4; it is one more app-text toast under the same rules. |
| C17 | **Antigravity sign-in console cwd** (F7: agy is now spawned directly, never via `cmd /k`; the cwd rule stands). `cli:signIn` for agy opens agy interactively; the first run may ask to trust the current folder or start an agent session there. ARCH does not name the cwd. | Copy tells the user to close the console once signed in. | Specify cwd = `%USERPROFILE%` (a folder the user would use anyway), never `<userData>\agy-workspace` before the trust step. |
| C18 | **`auto:listWrites` response shape.** B11 requires titles "from `proposals` at render time"; the response must therefore carry an `EventVM` (title, start/end, zone) per row plus the verb inputs (`pre_json` old start, kind), not only ids. | Assumes `AutoWriteRowVM = {autoWriteId, itemId, kind, event: EventVM, oldStart?: EpochMs, writtenAt, undo: UndoVM}`. | Pin `AutoWriteRowVM` in contracts.md. |
| C19 | **Event ids and the renderer.** B20 keys the In-calendar list by `calendar_event_id`, but ARCH-v2 10 forbids event ids in requests and the renderer never needs the Google id. | Uses an opaque `calendarEventKey` minted by main. | Record that list VMs carry an opaque key, never the raw event id. |
| C20 | **The Gemini CLI sentence is a dated vendor fact in app copy.** | Muted help line, re-read each release (like U-A5 consent dates). | Add it to the release checklist next to the consent Terms date. |

---

## 17. Finalisation additions (2026-09-28, review findings F1-F40; ARCHITECTURE-v2 section 19)

Binding for W1-11 / W1-12; W0 seeds these keys in both locales (parity + `i18n.usage.test.ts` cover them). Resolves C9 and C15 above.

| Key | en | he |
|---|---|---|
| `undo.restoreOriginal` / `.restoring` / `.restored` (F1) | Restore original / Restoring... / Original time restored | החזרת המועד המקורי / מחזיר... / המועד המקורי הוחזר |
| `badge.change_target_unclear` / `label.badge.change_target_unclear` (F31) | Which event? This chat has more than one - the change would apply to the latest | איזה אירוע? יש בצ'אט הזה יותר מאירוע אחד - השינוי יחול על האחרון |
| `auto.reason.content_rejected` (F9) | Not automatic: the title or place contains a link, a number or unusual characters | לא אוטומטי: הכותרת או המקום מכילים קישור, מספר או תווים חריגים |
| `auto.reason.multiple_events` (F31) | Not automatic: this chat has more than one event | לא אוטומטי: יש בצ'אט הזה יותר מאירוע אחד |
| `errors.VOICE_TOO_LONG_FOR_DEVICE.title` / `.body` / action (F33) | Voice note too long for this computer / Transcribing it here would take more than 5 minutes. The Lite voice model is faster. / Use Lite | ההודעה הקולית ארוכה מדי למחשב הזה / תמלול כאן ייקח יותר מ-5 דקות. מודל הקול הקל מהיר יותר. / מעבר לקל |
| `errors.CLI_UNSAFE_CONFIG.title` / `.body` / action (F3) | Gemini setup on this computer is not safe to use / Your Antigravity setup loads extra tools or hooks in every run. The app will not use it until they are removed. / Open AI settings | הגדרת Gemini במחשב הזה אינה בטוחה לשימוש / ההגדרה של Antigravity טוענת כלים או hooks נוספים בכל הרצה. האפליקציה לא תשתמש בה עד שיוסרו. / פתיחת הגדרות הבינה |
| `change.titleNotApplied` (F40) | Changes to the event name are not applied - edit it in Google Calendar. | שינוי שם האירוע לא מיושם - אפשר לערוך אותו ביומן Google. |
| `change.byYou` (F28, muted line on a self-triggered Change card) | You changed this in the chat | שינית את זה בצ'אט |
| `settings.readTools.confirmTitle` / `.confirmBody` / `.confirmAllow` / `.confirmKeep` (F11, main-owned dialog) | Let the AI read all your chats? / When a message refers to something said elsewhere, the AI may read other chats. With a cloud AI, parts of them are sent to {{vendor}}. / Allow / Keep this chat only | לאפשר לבינה לקרוא את כל הצ'אטים? / כשהודעה מתייחסת למשהו שנאמר במקום אחר, הבינה עשויה לקרוא צ'אטים אחרים. עם בינה בענן, חלקים מהם נשלחים ל-{{vendor}}. / לאפשר / רק הצ'אט הזה |

Behaviour notes: the "Download picture reading ({size})" and onboarding picture-model sizes are formatted from the active tier's `MEDIA_MODEL_MANIFEST` entry with the ux.md 8.1 size rule (F24, also settles C1 for that string). The overage switch and the read-scope radios never call `settings:set` (F11). A self-triggered delta (F28) renders as the ordinary Change card with `change.byYou` and no reply draft. A rejected change (C15) leaves the card as a plain reply card; the same change is not proposed again for that event revision.
