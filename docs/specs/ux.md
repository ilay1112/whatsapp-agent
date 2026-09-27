# UX + Visual Spec - WhatsApp Calendar Agent (v1)

Status: spec for build lanes 13 (Dashboard + cards + locale files) and 14 (Onboarding + Settings + dialogs), and for lane 11 (`app/tray.ts`, `app/notifications.ts`, `app/window.ts`) where tray, toast and window behaviour is described.
Date: 2026-09-21. Binding parent: `docs/ARCHITECTURE.md` (sections 6.1, 6.6, 7, 11, 12, 13, 14, 15.1). Inputs: `docs/proposals/ux.md`, `docs/research/i18n-rtl.md`, `docs/research/calendar-mcp.md` section 6.3.

Reading rules:

- Where this spec and `ARCHITECTURE.md` disagree, **ARCHITECTURE.md wins**; for IPC shapes and constants `docs/specs/contracts.md` wins over both. Known tensions are listed in section 17 "Architecture concerns"; none of them is resolved here by deviating.
- **Revision 2 (2026-09-22, `[R2]`)** after the adversarial review. Cut from v1: onboarding pictures (phone illustrations, Google console screenshots, tray flyout picture), `notifications:'with_name'`, per-chat `local_only`, "share titles with the AI", the IANA time-zone picker (time zone is shown read-only), the footer token counter, the Alt+P / Ctrl+, / Ctrl+L shortcuts, and the full Ignored drawer (now "Undo dismiss", last 20 dismissed only). Changed: X **always** hides immediately (coach mark shown on the next open); Copy goes through IPC `clipboard:writeText`; sheet initial focus = close button + 500 ms focus-steal guard on approval buttons; named-contact toasts are gone; the `in_calendar` "Reply not sent yet" affordance disappears once a newer item exists for the chat.
- "MUST / NEVER" are acceptance criteria for lanes 13/14. Everything else is a default the implementer may tune by a few pixels, not by concept.
- This is a deliberately **minimal** app. Anything not drawn here is out of scope for v1. No extra views, no charts, no avatars, no chat history browser, no theme picker.

---

## 1. Design direction

### 1.1 What this product is, in one sentence

A quiet tray utility for one person: it notices when a friend proposes a plan on WhatsApp, prepares a reply and a calendar entry, and then **waits for a click**. The window is opened for 20 seconds at a time, a few times a day, often by someone reading Hebrew.

### 1.2 Principles

1. **The click is the product.** Every card ends in a button that says exactly what will happen ("Approve & send", "Add to calendar"). The same words appear in the confirmation ("Sent", "Added to calendar"). No button ever says "OK", "Submit" or "Confirm".
2. **Three voices, never mixed.** A card carries text from three authors, and the user must always be able to tell them apart at a glance:
   - *the contact* (untrusted) - a sunken chat bubble with a bubble tail corner;
   - *the AI* (untrusted, a suggestion) - an editable box with a dashed top edge and the label "Draft reply";
   - *the app* (trusted) - flat chrome: names of actions, dates rendered from structured fields, badges.
   Untrusted text never appears in app chrome: not in headers, toasts, the tray, the window title, or badges (ARCHITECTURE section 2 taint rule).
3. **One signature element, everything else quiet.** The **date tab** (section 6.4) - a small diary leaf showing weekday, day number and month - is the only decorative object in the app. It appears wherever a detected event appears, in all three lists, and is the thing the eye finds first. Nothing else gets ornament: no gradients, no illustrations on the dashboard, no per-card shadows.
4. **Calm states.** Working is not an error. Amber means "the app is handling it", red means "you need to do one thing". Every red state offers exactly one action (A17).
5. **Hebrew is a first language, not a mirror.** Layout is written once with logical properties; Hebrew gets +1 px on every text size, no italics, no capitals, no letter-spacing.

### 1.3 What we deliberately avoid

WhatsApp green and any WhatsApp/Google logo as app identity (the app is unofficial - it must not look official); a cream/terracotta or black/acid-green palette; identical rounded cards with soft grey shadows; all-caps eyebrow labels; monospace labels; arrows appended to button text; entrance animations on cards; emojis in app chrome.

### 1.4 Visual idea

A desk diary: cool paper-grey canvas, white leaves, ink-indigo for the one thing you can press. Cards are flat leaves separated by hairlines of space, not by shadows. Radius is a hierarchy (small things are squarer), not a single value.

---

## 2. Design tokens

All tokens live in `src/renderer/src/styles.css` inside a Tailwind 4 `@theme` block plus a dark override. Components use **only** semantic tokens (`bg-surface`, `text-muted`, `border-line`), never raw hex and never Tailwind's default palette (`bg-gray-100` is a lint failure in review).

Theme follows the OS (`prefers-color-scheme`); there is **no theme setting** (the `Settings` zod schema is `.strict()` and has no such key). Windows "Contrast themes" are honoured through `forced-colors` (section 13.6).

### 2.1 Colour

Contrast ratios were computed (WCAG 2.x relative luminance) for the pairs actually used. Body text >= 7:1, secondary text >= 5.7:1, interactive boundaries >= 3:1.

| Token | Role | Light | Dark |
|---|---|---|---|
| `--color-canvas` | window background, column gutters | `#EEF0F5` | `#12151E` |
| `--color-surface` | cards, sheet, dialogs, inputs | `#FFFFFF` | `#1B2030` |
| `--color-quote` | quoted contact bubble, wells, skeletons | `#E3E7F0` | `#262C40` |
| `--color-line` | decorative hairlines (never the only boundary of a control) | `#CBD1DE` | `#2F3750` |
| `--color-line-strong` | input/secondary-button borders, dashed draft edge | `#7C869C` | `#6C7794` |
| `--color-text` | primary text | `#161B2B` | `#E8EBF4` |
| `--color-text-muted` | secondary text, timestamps, helper text | `#4F5870` | `#A3ABC2` |
| `--color-accent` | primary button fill, links, focus ring, date-tab header | `#3346B8` | `#93A3FF` |
| `--color-accent-hover` | primary button hover/active | `#28389A` | `#AAB7FF` |
| `--color-on-accent` | text on accent fill | `#FFFFFF` | `#0E1224` |
| `--color-accent-soft` | selected radio card, info badge, new-card edge | `#E4E8FA` | `#232B55` |
| `--color-ok` / `--color-ok-soft` | connected, sent, in calendar | `#0B6E5F` / `#DDF2EE` | `#5FD0BC` / `#12332E` |
| `--color-warn` / `--color-warn-soft` | assumptions, "working on it", amber badges | `#7A4700` / `#FCEBC8` | `#F2BC5C` / `#3A2C10` |
| `--color-danger` / `--color-danger-soft` | needs attention, red badges, destructive buttons | `#A8261D` / `#FBE3E0` | `#FF9A8F` / `#40201D` |
| `--color-on-danger` | text on danger fill | `#FFFFFF` | `#2A0B08` |
| `--color-scrim` | behind sheet/dialog | `rgb(22 27 43 / 0.40)` | `rgb(0 0 0 / 0.55)` |

Measured contrast (light / dark): text on surface 17.1 / 13.6; text on quote 13.8 / 11.6; muted on surface 7.1 / 7.1; muted on quote 5.7 / 6.0; on-accent on accent 7.8 / 7.9; accent on surface 7.8 / 6.9; line-strong on surface 3.65 / 3.63; ok on ok-soft 5.3 / 7.3; warn on warn-soft 6.5 / 7.8; danger on danger-soft 5.8 / 7.1.

Rules:

- Colour is never the only carrier of meaning: every badge and health state has an icon shape **and** a text label.
- `--color-accent` fill is reserved for the **single primary approval button of a card** and the primary button of a wizard step. A screen never shows two accent-filled buttons inside one card. "Add to calendar" next to "Approve & send" is an outlined button (section 6.7).
- Red fill (`--color-danger` + `--color-on-danger`) only for "Unlink and wipe", "Delete model", "Delete all data" confirmations.

### 2.2 Typography

Font stack (binding, no bundled font): `--font-ui: "Segoe UI", system-ui, sans-serif`. No second family. No monospace anywhere (phone numbers and times use `font-variant-numeric: tabular-nums` instead).

Scale (ratio ~1.2, six steps only). Hebrew x-height is visually smaller, so `:root:lang(he)` overrides the size tokens by +1 px; spacing tokens do **not** change, so layouts are identical in both languages.

| Token | en | he | Line height | Weight | Use |
|---|---|---|---|---|---|
| `--text-xs` | 12 px | 13 px | 1.35 | 400/600 | badges, timestamps, helper text |
| `--text-sm` | 13 px | 14 px | 1.45 | 400 | secondary lines, settings descriptions, tray-like menus |
| `--text-base` | 14 px | 15 px | 1.5 | 400 | body, message text, draft, inputs, buttons (600) |
| `--text-md` | 16 px | 17 px | 1.4 | 600 | contact name, list titles, settings group titles |
| `--text-lg` | 20 px | 21 px | 1.3 | 600 | sheet title, wizard step title, date-tab day number |
| `--text-xl` | 28 px | 29 px | 1.2 | 600 | onboarding Welcome headline only |

Rules: sentence case everywhere; never `text-transform: uppercase`; never `font-style: italic` (Hebrew has none and Chromium fakes a slant); never `letter-spacing` other than `normal`; weights limited to 400 and 600; body line length capped at 68 characters (`max-inline-size: 68ch`) in onboarding and settings; numbers in times, counts and progress use `tabular-nums`.

### 2.3 Spacing, radius, borders, elevation

Spacing scale (px): `2, 4, 8, 12, 16, 20, 24, 32, 48`. Tailwind's default 4 px unit is used (`p-3` = 12 px); no arbitrary values except the ones named here.

| Thing | Value |
|---|---|
| Window gutter (canvas padding) | 16 px (12 px below 640 px width) |
| Gap between columns | 12 px |
| Gap between cards | 8 px |
| Card padding | 12 px |
| Sheet / dialog padding | 20 px |
| Control height | 32 px (buttons, inputs, selects); 40 px for wizard primary buttons; hit target never below 32 x 32, icon buttons 32 x 32 |
| Header height | 48 px; footer 32 px |

Radius is a hierarchy:

| Token | Value | Used by |
|---|---|---|
| `--radius-xs` | 4 px | badges, chips, date-tab inner corners, bubble tail corner |
| `--radius-sm` | 8 px | buttons, inputs, draft box, pills' inner items |
| `--radius-md` | 12 px | cards, quoted bubble (three corners), radio cards |
| `--radius-lg` | 16 px | sheet (leading corners only), dialogs, QR frame |
| `--radius-full` | 999 px | health pill, download pill, toggle track |

Borders: 1 px. Cards have **no border and no shadow** in light mode (white on grey canvas is enough); in dark mode cards get `1px solid var(--color-line)`. Elevation exists at exactly two levels: `--shadow-pop` (`0 8px 24px rgb(22 27 43 / 0.16)`) for popovers/menus/toasts, and `--shadow-sheet` (`0 0 48px rgb(22 27 43 / 0.24)`) for the sheet and dialogs. Nothing else has a shadow.

### 2.4 Motion

| Token | Value | Use |
|---|---|---|
| `--dur-fast` | 120 ms | hover/press colour, toggle thumb |
| `--dur-base` | 180 ms | sheet slide, popover fade, section collapse |
| `--ease` | `cubic-bezier(0.2, 0, 0, 1)` | all of the above |

- Motion only answers a user action, with one exception: a card that arrives or changes while the window is visible shows a 3 px `--color-accent` inline-start edge that fades out over 1.6 s (no movement). No fade-up entrances, no skeleton shimmer (static blocks), no spinner larger than 16 px.
- Horizontal motion uses `--dir` (`1`, `-1` under `:root:dir(rtl)`): the sheet slides in from the inline-end side with `translateX(calc(var(--dir) * 24px))`.
- `@media (prefers-reduced-motion: reduce)`: all durations become 0 ms, the arrival edge is shown static for 1.6 s, progress bars stay animated only in their value.

### 2.5 Icons

Inline SVG components in the renderer (no icon package, no icon font), 16 x 16 on a 1.5 px stroke, `currentColor`, `aria-hidden="true"` with the label carried by text or `aria-label`. Set (closed list, 22 icons): check, check-circle, alert-triangle, alert-octagon, info, clock, calendar, message, send, copy, pencil, x, chevron (one glyph, rotated), more (three dots), gear, pause, play, download, shield, link-off, eye-off, external.

Mirrored in RTL (`.icon-dir:dir(rtl){transform:scaleX(-1)}`): send, chevron when it means back/forward, external. Never mirrored: check, clock, calendar, QR image, progress percentage, logos.

### 2.6 Tailwind 4 shape (normative sketch)

```css
@import "tailwindcss";

@theme {
  --font-ui: "Segoe UI", system-ui, sans-serif;
  --color-canvas: #EEF0F5;  --color-surface: #FFFFFF;  --color-quote: #E3E7F0;
  --color-line: #CBD1DE;    --color-line-strong: #7C869C;
  --color-text: #161B2B;    --color-text-muted: #4F5870;
  --color-accent: #3346B8;  --color-accent-hover: #28389A;  --color-on-accent: #FFFFFF;  --color-accent-soft: #E4E8FA;
  --color-ok: #0B6E5F;      --color-ok-soft: #DDF2EE;
  --color-warn: #7A4700;    --color-warn-soft: #FCEBC8;
  --color-danger: #A8261D;  --color-danger-soft: #FBE3E0;   --color-on-danger: #FFFFFF;
  --text-xs: 0.75rem; --text-sm: 0.8125rem; --text-base: 0.875rem; --text-md: 1rem; --text-lg: 1.25rem; --text-xl: 1.75rem;
  --radius-xs: 4px; --radius-sm: 8px; --radius-md: 12px; --radius-lg: 16px;
  --breakpoint-cols: 56.25rem;   /* 900px: three columns */
  --breakpoint-roomy: 40rem;     /* 640px: wider gutters, side-by-side form rows */
}
:root { --dir: 1; color-scheme: light dark; }
:root:dir(rtl) { --dir: -1; }
:root:lang(he) { --text-xs: 0.8125rem; --text-sm: 0.875rem; --text-base: 0.9375rem; --text-md: 1.0625rem; --text-lg: 1.3125rem; --text-xl: 1.8125rem; }
@media (prefers-color-scheme: dark) { :root { /* dark column of 2.1 */ } }
body { font-family: var(--font-ui); font-size: var(--text-base); background: var(--color-canvas); color: var(--color-text); text-align: start; }
.msg-text { unicode-bidi: plaintext; text-align: start; white-space: pre-wrap; overflow-wrap: anywhere; }
```

Shared class recipes (`@utility` in `styles.css`, so no extra component files are needed): `btn`, `btn-primary`, `btn-outline`, `btn-quiet`, `btn-danger`, `icon-btn`, `field`, `chip`, `pill`, `focus-ring`. Lanes 13 and 14 both consume these; lane 13 owns `styles.css` and lane 14 requests additions through the orchestrator rather than editing it.

---

## 3. Window and layout

| Property | Value (binding from ARCHITECTURE 15.1) |
|---|---|
| Default size | **980 x 680** |
| Minimum size | **420 x 560** |
| Chrome | native Windows title bar, no application menu, title = "WhatsApp Calendar Agent" (constant - never a contact name or count) |
| Resizable / maximisable | yes; content max inline size 1320 px, centred on wider windows |

Breakpoints (viewport width):

| Width | Layout |
|---|---|
| >= 900 px (`cols`) | Dashboard = three equal columns, each scrolls independently; sheet = 560 px side panel on the inline-end side |
| 640-899 px | one column, three collapsible sections stacked; sheet = full-width overlay; settings rows side by side |
| 420-639 px | same, gutters 12 px, header collapses (language toggle and pause move into the gear menu), form rows stack |

One-column collapse rules: section order stays "Needs reply", "In calendar", "Information missing" (the user's order). Each section header is a disclosure button with the count. Defaults: "Needs reply" and "Information missing" open, "In calendar" collapsed. The open/closed state is kept in the Zustand store for the session only. The page scrolls as one document; section headers are `position: sticky` at `inset-block-start: 48px`.

App frame (all views):

```
+----------------------------------------------------------------------------------------------+
| HEADER 48px   wordmark | HealthPill | DownloadPill?        ...        Pause | he/EN | Settings |
+----------------------------------------------------------------------------------------------+
| SetupStrip? (0..2 rows, 36px each)                                                           |
+----------------------------------------------------------------------------------------------+
|                                                                                              |
|  VIEW: Dashboard | Settings | Onboarding                                                     |
|                                                                                              |
+----------------------------------------------------------------------------------------------+
| FOOTER 32px   Ignored (n)                                       cloud usage today? | version |
+----------------------------------------------------------------------------------------------+
```

During onboarding the header shows only the wordmark, `DownloadPill` (once a download runs) and `LanguageToggle`; there is no footer.

---

## 4. RTL and bidi rules (MUST)

1. Direction is set once: `<html lang dir>` from `i18next.dir()`. No CSS `direction`, no `row-reverse` for RTL, no per-component `dir="rtl"`.
2. Logical properties/utilities only: `ms-* me-* ps-* pe-* start-* end-* border-s border-e rounded-s-* rounded-e-* text-start text-end`. Physical utilities (`ml- mr- pl- pr- left- right- text-left text-right rounded-l rounded-r border-l border-r`) are lint-banned.
3. Untrusted text (message, draft, event title, location, contact name) is direction-independent of the UI:
   - block text: `<p class="msg-text" dir="auto">`; textareas and single-line inputs for title/location: `dir="auto"`;
   - inline names inside UI sentences: `<bdi>`; phone numbers: `<bdi dir="ltr">`; time ranges: `<bdi>` around the whole range, formatted by `shared/i18n/format.ts`.
4. In RTL the first column ("Needs reply") is on the right, the sheet slides in from the left, the header order mirrors, toasts sit at the bottom inline-end (bottom-left). All of that falls out of rules 1-2; no RTL-specific layout code exists.
5. Things that stay LTR in both languages: the QR image, progress percentages, API key fields (`dir="ltr"`, `text-align: start`), model ids, version string.
6. Dates/times: only through `Intl` helpers with explicit `he-IL` / `en-IL`, `hourCycle: 'h23'`, explicit `timeZone`. The time zone is printed only when it differs from `settings.general.timeZone`.
7. The language toggle switches at runtime without reload: `settings:set` -> main -> `ui:languageChanged` -> renderer `i18n.changeLanguage` + `<html lang dir>` update; main rebuilds the tray.
8. RTL wireframes in this document are drawn **mirrored with English placeholder labels**, because Hebrew inside monospace boxes is reordered by bidi-aware viewers. Hebrew copy is in section 15.

---

## 5. App shell

### 5.1 Header

LTR:
```
+----------------------------------------------------------------------------------------------+
| WA Calendar Agent   (v) All running    [dl 43%  12 min]              [|| Pause] [he|EN] [gear]|
+----------------------------------------------------------------------------------------------+
```
RTL (mirrored):
```
+----------------------------------------------------------------------------------------------+
|[gear] [he|EN] [Pause ||]              [12 min  43% dl]    All running (v)   WA Calendar Agent |
+----------------------------------------------------------------------------------------------+
```

- Wordmark: text only, `--text-md` 600, "WA Calendar Agent" / "סוכן יומן לוואטסאפ" (the full product name stays in the title bar). Not a link. No logo in the header.
- Pause: a toggle button (`aria-pressed`), label "Pause" / "Resume". When paused the header gets a 2 px `--color-warn` bottom border and the pill reads "Paused". Calls `agent:setPaused`. Pausing never disables approval buttons (kill switch leaves pending approvals usable).
- LanguageToggle: two-segment control "עב | EN" (labels are never translated), `role="radiogroup"`.
- Gear: opens Settings view (`ui:navigate`-compatible). In Settings the gear becomes a "Back to dashboard" button with a mirrored chevron.

### 5.2 Status strip = HealthPill + status panel

The "status strip" of the brief is implemented exactly as ARCHITECTURE section 14 prescribes: **one pill in the header; clicking it expands three rows** (WhatsApp / AI / Calendar), each with one sentence and at most one action.

Pill states (from `AppHealth.overall`, `paused`):

| overall | Icon | Label en / he | Colours |
|---|---|---|---|
| `ok` | check-circle | All running / הכול פועל | text `--color-ok` on `--color-ok-soft` |
| `working` | clock | Working on it / עובד על זה | `--color-warn` on `--color-warn-soft` |
| `attention` | alert-octagon | Needs attention / דרוש טיפול | `--color-danger` on `--color-danger-soft` |
| paused (overrides ok/working) | pause | Paused / מושהה | `--color-warn` on `--color-warn-soft` |

When `overall = attention` and exactly one part is failing, the pill names the part instead: "WhatsApp needs attention", "AI needs attention", "Calendar needs attention".

Status panel (popover anchored to the pill, 360 px wide, `--shadow-pop`; at < 640 px it is a full-width sheet from the top):

LTR:
```
( ) All running  v
+--------------------------------------------------------------+
| (v) WhatsApp   Connected                                     |
|--------------------------------------------------------------|
| (~) AI         Local model - downloading, 43 %               |
|                Chats wait as plain cards until it is ready.  |
|--------------------------------------------------------------|
| (!) Calendar   Google connection expired        [Reconnect]  |
|--------------------------------------------------------------|
| Analysing 2 chats                                            |
+--------------------------------------------------------------+
```
RTL:
```
                                                  v  All running ( )
+--------------------------------------------------------------+
|                                     Connected   WhatsApp (v) |
|--------------------------------------------------------------|
|               Local model - downloading, 43 %         AI (~) |
|  .Chats wait as plain cards until it is ready                |
|--------------------------------------------------------------|
|  [Reconnect]        Google connection expired   Calendar (!) |
+--------------------------------------------------------------+
```

Row content per part = `{state, code?, since}`: state sentence from the table below or, when `code` is set, the `ErrorCode` title + body + its single action (section 11.4). `since` is shown as a relative time in muted text only for non-ok states ("for 12 min").

| Part | States and sentence (en) |
|---|---|
| WhatsApp | Connected / Starting... / Waiting for you to link WhatsApp [Link] / Reconnecting... / ErrorCode row |
| AI | Local model - ready / Local model - downloading, N % / Local model - starting... / Claude - ready (model id in muted text) / Gemini - ready / Paused / ErrorCode row |
| Calendar | Connected (<bdi>account email</bdi> is NOT shown here - settings only) / Not connected - replies only [Connect] / Starting... / ErrorCode row |

Behaviour: opens on click/Enter/Space, closes on Escape, outside click, or action click; `aria-expanded`, `aria-controls`; the panel is a `role="dialog"` non-modal with focus moved to its first row; rows are a list. `health:changed` updates it live. A change of `overall` is announced through the polite live region (section 13.4), throttled to one announcement per 10 s.

### 5.3 DownloadPill

Visible in the header whenever a `model_files.status` is `downloading | paused | verifying | failed`, in onboarding and on the dashboard.

```
[ dl  43 %  -  12 min left ]      [ ||  Paused 43 % ]      [ v  Checking file... ]      [ !  Download failed ]
```
- A 2 px progress track runs along the bottom edge of the pill (fills from the inline-start side, so right-to-left in Hebrew; the percentage text is never mirrored).
- Click opens a small popover: tier name in plain words, bytes done / total, speed, ETA, buttons "Pause"/"Resume" and "Cancel download". Failed: ErrorCode copy + its one action.
- Updates arrive at 4 Hz (`model:progress`); the DOM text updates at most once per second; `role="progressbar"` with `aria-valuenow`, `aria-valuetext` ("43 percent, about 12 minutes left"). Progress is **not** put in a live region; only "Download finished - the AI is ready" is announced.

### 5.4 SetupStrip

Shown under the header for each unfinished setup task, max two rows, most blocking first. Never a modal.

| Condition | Text (en) | Action |
|---|---|---|
| WhatsApp not paired | WhatsApp is not linked yet. | Link WhatsApp -> onboarding step 2 |
| No usable AI (no model, no key, no consent) | The AI is not set up yet - chats appear as plain cards. | Set up AI -> onboarding step 1 |
| Calendar skipped | Google Calendar is not connected - replies only. | Connect -> onboarding step 3; secondary "Hide" |

```
| (i) Google Calendar is not connected - replies only.                    [Connect]   Hide     |
```
"Hide" is offered only for the calendar row and lasts until the app restarts (renderer memory; the fact stays visible in the status panel). Background `--color-accent-soft`, text `--color-text`, no icon colour coding beyond the info icon.

### 5.5 Footer

`[R2]` `Undo dismiss` quiet button at the inline-start (opens `UndoDismissDrawer`, 6.10; shown only when at least one item was dismissed in the last 7 days); at the inline-end the version string. Nothing else (the cloud token counter is cut from v1; `held/budget` raw cards still explain an exhausted budget).

---

## 6. Dashboard

### 6.1 Three columns (>= 900 px)

LTR:
```
+----------------------------------------------------------------------------------------------+
| WA Calendar Agent   (v) All running                               [|| Pause] [he|EN] [gear]   |
+----------------------------------------------------------------------------------------------+
| Needs reply  3               | In calendar  2               | Information missing  1         |
| Analysing 2 chats...         |                              |                                |
| +---------------------------+| +---------------------------+| +---------------------------+  |
| | Dana Levi        14:02  ...|| | Yoav Ben-Ami    Mon  ... || | Michal            09:41 ...|  |
| | +972 54-555-0142          || | +-----+ Dinner            || | ,------------------------. |  |
| | ,------------------------.|| | | Thu | 20:00-21:30       || | | lets meet next week?   | |  |
| | | coffee thursday at 5?  ||| | | 24  | Cafe Noir         || | '------------------------' |  |
| | '------------------------'|| | | Sep |                   || | Missing: day, time         |  |
| | +-----+ Coffee            || | +-----+ (v) In calendar   || | - - Draft reply - - - - -  |  |
| | | Thu | 17:00-18:00       || | [Open in calendar]        || | | Sure - which day works? ||  |
| | | 24  | (~) 5 taken as PM || | Reply not sent yet  [Show]|| | '------------------------' |  |
| | | Sep |                   || +---------------------------+| | [Ask for details]   [Copy] |  |
| | +-----+                   || +---------------------------+| +---------------------------+  |
| | - - Draft reply - - - - - || | Noa               Sun  ...||                                |
| | | Sounds great, Thursday |||                             ||                                |
| | | at 17:00 works.        |||                             ||                                |
| | '------------------------'||                             ||                                |
| | [Approve & send]          ||                             ||                                |
| | [Add to calendar]  [Copy] ||                             ||                                |
| +---------------------------+|                              |                                |
+----------------------------------------------------------------------------------------------+
| Ignored (12)                                                                        v0.1.0   |
+----------------------------------------------------------------------------------------------+
```

RTL (column order, card internals and header mirror; message text direction follows its own content):
```
+----------------------------------------------------------------------------------------------+
|   [gear] [he|EN] [Pause ||]                               All running (v)   WA Calendar Agent |
+----------------------------------------------------------------------------------------------+
|         1  Information missing |               2  In calendar |               3  Needs reply |
|                                |                              |         ...Analysing 2 chats |
|  +---------------------------+ | +---------------------------+| +---------------------------+|
|  |... 09:41            Michal| | |... Mon        Yoav Ben-Ami || |...  14:02        Dana Levi ||
|  | ,------------------------.| | |            Dinner +-----+ || |          0142-555-54 972+  ||
|  | |   ?lets meet next week || | |       20:00-21:30 | Thu | || |,------------------------. ||
|  | '------------------------'| | |         Cafe Noir | 24  | || ||  ?coffee thursday at 5  | ||
|  |         Missing: day, time| | |                   | Sep | || |'------------------------' ||
|  | - - - - - Draft reply - - | | | In calendar (v)   +-----+ || |            Coffee +-----+  ||
|  | [Copy]   [Ask for details]| | |        [Open in calendar] || |       17:00-18:00 | Thu |  ||
|  +---------------------------+ | +---------------------------+| | 5 taken as PM (~) | 24  |  ||
|                                |                              | |                   | Sep |  ||
|                                |                              | |  - - - - Draft reply - - - ||
|                                |                              | |           [Approve & send] ||
|                                |                              | |  [Copy]  [Add to calendar] ||
+----------------------------------------------------------------------------------------------+
|   v0.1.0                                                                        (12) Ignored |
+----------------------------------------------------------------------------------------------+
```
(The phone number is shown LTR inside `<bdi dir="ltr">` in the real UI: `+972 54-555-0142` in both languages; the mirrored digits above are only an artefact of mirroring the drawing.)

### 6.2 One column (< 900 px)

Identical in LTR and RTL apart from mirroring of each row:
```
+------------------------------------------+
| WA Calendar Agent   (v) All running [gear]|
+------------------------------------------+
| v Needs reply  3    Analysing 2 chats... |   <- sticky disclosure header
| +--------------------------------------+ |
| | Dana Levi                 14:02  ... | |
| | ...card as above, full width...      | |
| +--------------------------------------+ |
| > In calendar  2                         |   <- collapsed by default
| v Information missing  1                 |
| +--------------------------------------+ |
| | Michal ...                           | |
| +--------------------------------------+ |
+------------------------------------------+
| Ignored (12)                     v0.1.0  |
+------------------------------------------+
```

### 6.3 List (column) rules

- Title `--text-md` 600 + count in muted text (count = total open in that state, not just the rendered 20). No coloured column headers.
- Shows the latest **20** (`updated_at DESC`). When the count exceeds 20 the column ends with muted text "Showing the latest 20 of N" - there is no pagination in v1.
- "Needs reply" header carries the queue line from `AppHealth.queue`: "Analysing N chats..." with a 12 px spinner; hidden when `pending + running = 0`. Queued/running items are never rendered as cards (ARCHITECTURE 6.1).
- Refresh: on `dashboard:changed` the store refetches `dashboard:get`. **A card whose inputs have focus or unsaved edits is never re-rendered from server data, never reordered and never removed**; instead it shows the inline notice "This card changed - review again" with a "Refresh card" button once the edit-lock ends or main rejects an approval. Other cards keep their DOM identity by `itemId` (React key) so scroll position is stable.
- Column body: `role="list"`, each card `role="listitem"` wrapping an `<article aria-labelledby>`.

### 6.4 Signature element: the date tab (`EventChip`, exported from `EventEditor.tsx`)

```
+-------+
|  Thu  |   <- weekday short, --text-xs 600, --color-on-accent on --color-accent, radius-xs top corners
|  24   |   <- day of month, --text-lg 600, tabular-nums
|  Sep  |   <- month short, --text-xs, muted
+-------+      48 px wide, surface background, 1px --color-line-strong
```
To its inline-end: line 1 = event title (`dir="auto"`, one line, ellipsis), line 2 = `<bdi>17:00-18:00</bdi>` (+ time zone only when not the default), line 3 = location if any (`dir="auto"`, muted) - then event badges.

States of the tab:

| Event state | Look |
|---|---|
| `proposed` | as drawn; header `--color-accent` |
| `incomplete` | missing parts are drawn as a dashed empty slot: day `--`, time "time?"; header `--color-line-strong`; dashed 1 px border |
| `created` | header `--color-ok`; a check icon + "In calendar" under the time |
| `declined` / no event | the tab is not rendered |
| conflict badge present | unchanged tab; the amber `conflict` badge sits on line 3 |

The whole chip is a button ("Edit event details") that opens the sheet with the `EventEditor` focused; it is **not** itself an approval.

All text in the tab is produced by the app from structured fields via `Intl` - never model text - so it is trusted chrome; the title and location next to it are untrusted and styled as `msg-text`.

### 6.5 Card anatomy (`ItemCard`, compact mode)

```
+--------------------------------------------------+
| (1) Dana Levi                        14:02  [...]|   header: name <bdi>, relative/clock time, overflow menu
|     +972 54-555-0142                             |   phone <bdi dir="ltr">, muted, --text-xs
| (2) ,------------------------------------------. |   QuotedBubble: trigger message, dir="auto", 3-line clamp,
|     | coffee thursday at 5? the place near     | |   "Show more" opens the sheet
|     | your office                              | |
|     '------------------------------------------' |
| (3) [date tab]  Coffee                           |   EventChip (only when an event is detected)
|                 17:00-18:00                      |
| (4)             (~) 5 taken as 17:00             |   Badges (event badges under the chip, draft badges under the draft)
| (5) - - Draft reply - - - - - - - - - - - - - -  |   DraftBox: label + textarea dir="auto", auto-grow 2..6 rows
|     | Sounds great, Thursday at 17:00 works.   | |
|     '------------------------------------------' |
|     (!) Link removed                             |
| (6) [Approve & send]                             |   primary action, full card width
|     [Add to calendar]          [Copy]            |   secondary row; Dismiss lives in [...] and in the sheet
+--------------------------------------------------+
```

1. **Header.** Contact display name in `<bdi>` (`--text-md` 600; untrusted, plain text, single line, ellipsis, max 40 chars rendered). Fallback when no name: the formatted phone becomes the title. Below: formatted phone in `<bdi dir="ltr">`, muted - always shown for phone JIDs so the user sees *who* receives the message (ARCHITECTURE 6.6). `@lid` chats show the chip "Number hidden by WhatsApp - copy only" instead of a phone. Time: today -> `HH:mm`; this week -> weekday short; older -> `d MMM`; full timestamp in `title` and `aria-label`.
   Clicking the header (or Enter on the focused card) opens the sheet.
2. **QuotedBubble.** `--color-quote` background, radius `--radius-md` with the start-start corner `--radius-xs` (bubble tail), padding 8/12. Text `--text-base`, `msg-text`, inert: no links, no markdown, no emoji enlargement. Non-text triggers show an app-authored placeholder in muted text: "Photo", "Voice message", "Sticker", "Location" (media is never displayed).
3. **EventChip** (6.4).
4. **Badges** (6.6).
5. **DraftBox.** A 1 px dashed `--color-line-strong` top edge with the inline label "Draft reply" (`--text-xs` 600, muted) - the dashed edge is the visual code for "AI wrote this, you own it". Textarea: `--color-surface`, 1 px `--color-line-strong`, `--radius-sm`, `dir="auto"`, `spellcheck=false`, max 600 chars with a counter that appears at >= 500 ("548 / 600"). Focus -> `item:setEditing {editing:true}`; blur -> `{editing:false}`. If the user changed the text, a quiet "Reset to suggestion" link appears under the box. With the red `manipulation` badge the box is collapsed behind "Show draft anyway" (6.6).
6. **Actions** (6.7).

Overflow menu `[...]` (`role="menu"`): Open details, Dismiss, Analyse again (`item:retriage`), Never analyse this chat (`chat:setPolicy never`, with an inline undo toast). (`[R2]` "Only analyse with the local model" is cut with the `local_only` policy.)

### 6.6 Badges (`Badges.tsx`)

`chip` recipe: `--text-xs`, 20 px high, `--radius-xs`, icon + text, soft background + strong text of the same family. Text comes only from locale keys - the LLM returns enum codes, never badge text.

| Code | Tone | Icon | en | he |
|---|---|---|---|---|
| `time_assumed` | amber | clock | 5 taken as 17:00 - tap to change | 5 פורש כ-17:00 - אפשר לשנות |
| `conflict` | amber | alert-triangle | You are busy then | יש לך משהו בזמן הזה |
| `personal_details` | amber | shield | Contains personal details - check before sending | יש בטיוטה פרטים אישיים - כדאי לבדוק |
| `lang_mismatch` | amber | info | Draft is not in the chat's language | הטיוטה לא בשפת השיחה |
| `link_removed` | red | link-off | A link was removed from the draft | קישור הוסר מהטיוטה |
| `manipulation` | red | alert-octagon | This message may be trying to steer the AI - read it carefully | ייתכן שההודעה מנסה להשפיע על הבינה - כדאי לקרוא בעיון |
| `change_in_google` | info | calendar | Change or cancel it in Google Calendar | שינוי או ביטול נעשים ביומן Google |
| `older_message` | info | history | Older message - not analysed automatically | הודעה ישנה יותר - לא נותחה אוטומטית |

`[R2]` `older_message` appears only on raw cards (a live message older than 7 days that surfaced after the bridge was offline); the card action is "Analyse this chat" (`item:retriage`).

`time_assumed` is a button: it opens the sheet with the time field focused. `manipulation` collapses the DraftBox: the box is replaced by the badge, one sentence ("The draft is hidden. You can still write your own reply.") and two quiet buttons "Show draft anyway" / "Write my own" (clears the box and focuses it). Badges are advisory only and never disable an approval button.

Hold/failure reason chips (raw cards, neutral tone unless noted):

| `hold_reason` / error | en | he | Card action |
|---|---|---|---|
| `unknown_sender` | New contact - not analysed | איש קשר חדש - לא נותח | Analyse this chat (`chat:setPolicy {forceKnown:true}` then `item:retriage`) |
| `waiting_llm` | Waiting for the AI to be ready | ממתין שהבינה תהיה מוכנה | - (SetupStrip / pill carry the action) |
| `paused` | Paused | מושהה | Resume |
| `budget` | Hourly AI limit reached - will continue later | הגעת למגבלת הניתוחים לשעה - ימשיך בהמשך | - |
| `analysis='failed'` (red) | ErrorCode title (usually `LLM_BAD_OUTPUT`: "Could not analyse this chat") | | Analyse again |

### 6.7 Actions per list - what the buttons are

One accent-filled button per card at most. Approval buttons are rendered **only** when the matching pending action exists in `item.actions` (`kind`, `state='pending'`), and each click sends `action:approve {actionId, kind, shownHash, edit?}`.

| List / situation | Primary (accent fill) | Secondary (outline) | Quiet |
|---|---|---|---|
| Needs reply, draft + event proposed | Approve & send | Add to calendar | Copy, [...] |
| Needs reply, draft only | Approve & send | - | Copy, [...] |
| Needs reply, event only (no reply needed) | Add to calendar | - | [...] |
| Needs reply, chat not sendable (`@lid`) | Copy reply | Add to calendar | [...] |
| Information missing | Ask for details (= approve `send_reply` whose text is the clarifying question) | Add to calendar (enabled only when the mini-form is complete, see 7.3) | Copy, [...] |
| In calendar | Open in calendar (outline, not accent - nothing to approve; `[R2]` opens the day view built by main from the event date, never a server link) | Approve & send (accent, only while a `pending` `send_reply` still exists for this item; collapsed behind "Reply not sent yet - Show". `[R2]` Once the contact writes again and a newer open item exists for the chat, ingest supersedes this action and the affordance disappears) | [...] |
| Raw card (held / failed) | Send (accent; disabled until the box is non-empty) | reason action (Analyse this chat / Analyse again / Resume) | Copy, [...] |

"Edit" from the brief: there is no separate edit mode - the draft is always editable in place. The sheet offers an explicit "Edit" button that focuses the draft (useful for keyboard and screen-reader users and as a visible affordance); on the compact card clicking into the box is the edit.

Disabled approval buttons always say why, in a `--text-xs` line under the button (also `aria-describedby`):

| Reason | Text (en) |
|---|---|
| Bridge not ONLINE | WhatsApp is offline - sending is paused. You can still copy the reply. |
| Calendar not connected / MCP down | Calendar is not available right now. |
| Action expired (24 h) | This suggestion expired. [Analyse again] |
| Empty draft | Write a reply first. |

### 6.8 Approval interaction (no optimistic UI)

```
idle            [ Approve & send ]
click           [ (spinner) Sending... ]            all inputs and buttons of THIS card disabled; other cards stay live
                (the send queue adds 3-8 s of spacing; the label stays "Sending..."; after 10 s a muted line
                 "Still sending - WhatsApp sends are spaced out to protect your account" appears)
success         card shows a 1.2 s ok-soft confirmation row "(v) Sent" / "(v) Added to calendar", then the list refreshes
                (the item moves or leaves according to deriveState); a polite live-region message repeats it
failure         the card stays intact with an inline danger-soft row under the buttons (one sentence + one action)
```

Inline result rows (all inside the card, never toasts):

| Result | Row text (en) | Action |
|---|---|---|
| send failed / bridge offline | Sending failed. Nothing was sent. | Try again (a new click on a fresh action) + Copy |
| rate limit | Hourly send limit reached - this protects your account. | - (shows when it frees up: "Try again after 14:32") |
| stale / superseded / hash mismatch | This card changed - review again. | Refresh card |
| `needs_confirm_conflict` | You are busy at that time. | Add anyway (`confirmConflict:true`) / Change time (focus EventEditor) |
| `CAL_DUPLICATE` | An event like this already exists. | Create anyway (`confirmDuplicate:true`) / Dismiss |
| `unknown_outcome` | We could not confirm this - check WhatsApp (or: your calendar). | Send again / Add again (new action, new click) |
| window not focused (rejected by main) | Click the button again. | - |

"Add anyway", "Create anyway" and "Send again" are outline buttons, never accent: the accent fill means "the normal path".

Double activation: the button is disabled synchronously on the first activation (before the IPC promise), and the handler ignores `event.detail > 1`. `[R2]` **Focus-steal guard**: every approval button (Approve & send, Add to calendar, Ask for details, Send, Add anyway, Create anyway, Send again, Add again) ignores activation - click, Enter and Space - for **500 ms** after the window gained focus or became visible (`window.onfocus` / `visibilitychange`); a keystroke meant for the previous app must never approve a send. Main mirrors this by rejecting `action:approve` that arrives < 300 ms after a notification click showed the window (`WINDOW_NOT_FOCUSED` -> row "Click the button again").

Copy: `[R2]` sends `clipboard:writeText { text }` with the current textarea content (IPC, `LIMITS.clipboardChars`; the sandboxed renderer has no `navigator.clipboard`); the button label switches to "Copied" for 2 s (`aria-live` polite). Copy never changes item state. jsdom test: one click sends exactly one `clipboard:writeText` with the textarea value.

Dismiss: `item:dismiss`; the card leaves immediately (this is not a send/create, so optimistic removal is allowed) and an in-window toast "Dismissed - Undo" (6 s) calls `item:restore`.

### 6.9 RawCard

Used for `analysis IN ('held','failed')`. Same header and QuotedBubble; then the reason chip; then an **empty** DraftBox whose label is "Your reply" (no dashed AI edge - a solid top edge, because no AI text is involved); then the actions of 6.7.

```
+--------------------------------------------------+
| +972 52-555-0199                     08:15  [...]|
| ,----------------------------------------------. |
| | hi, this is Avi from the garage, can you     | |
| | come tomorrow at 9?                          | |
| '----------------------------------------------' |
| (i) New contact - not analysed                   |
| ___ Your reply _______________________________   |
| |                                              | |
| '----------------------------------------------' |
| [Send]  (disabled: Write a reply first.)         |
| [Analyse this chat]               [Copy]         |
+--------------------------------------------------+
```

"Analyse this chat" shows a one-time inline explanation before the first use per provider type: Local - "The message will be read by the AI on this computer."; cloud - "The message will be sent to <Claude|Gemini> for analysis." with buttons "Analyse" / "Cancel".

### 6.10 UndoDismissDrawer (`[R2]` was "IgnoredDrawer")

Opened from the footer "Undo dismiss". Side panel on the inline-end side (same geometry as the sheet), title "Dismissed", a flat list of the **last 20 items the user dismissed** (`dashboard:getIgnored`, `closed_reason='dismissed'` only): name `<bdi>`, one-line message excerpt (`dir="auto"`), relative time, and "Restore" (`item:restore`). No other closed items are listed (not_needed / replied / expired / past are not browsable in v1). Empty state: "Nothing to undo."

---

## 7. Item detail / approval sheet

`ItemCard` in `mode="expanded"`, hosted by `Dashboard.tsx` in a sheet. Data from `item:get {itemId}`. Opened by: card header click, Enter on a focused card, "Show more", EventChip, `time_assumed` badge, `ui:navigate {view:'dashboard', itemId}` (toast click). Only one sheet at a time; opening it sets the edit-lock only when an input is focused, not on open.

Geometry: >= 900 px - 560 px wide panel on the inline-end side over the columns, scrim on the rest, leading corners `--radius-lg`; < 900 px - full window. `role="dialog" aria-modal="true" aria-labelledby`, focus trapped, Escape closes (with a "Discard your edits?" confirm only if the draft or event fields were changed and not yet approved), focus returns to the originating card. `[R2]` **Initial focus is always the close button `[x]`** (never an approval button, never the textarea), however the sheet was opened - including `ui:navigate` from a toast click; jsdom test asserts `document.activeElement` is the close button after open, and the E2E step in `approval-first.spec.ts` opens the sheet via a simulated notification click, presses Enter, and asserts no send.

LTR:
```
+-- columns (dimmed by scrim) --------+----------------------------------------------------------+
|                                     | [x]  Dana Levi                                           |
|                                     |      +972 54-555-0142                        Needs reply |
|                                     |----------------------------------------------------------|
|                                     |  Conversation (what the AI read)                         |
|                                     |                        ,------------------------------.  |
|                                     |                        | me: are you around this week? |  |
|                                     |                        '------------------------------'  |
|                                     |  ,----------------------------------.                    |
|                                     |  | coffee thursday at 5? the place  |  14:02             |
|                                     |  | near your office                 |                    |
|                                     |  '----------------------------------'                    |
|                                     |----------------------------------------------------------|
|                                     |  Event                                                   |
|                                     |  +-----+  Title    [ Coffee                         ]    |
|                                     |  | Thu |  Date     [ Thu 24 Sep 2026   v]                |
|                                     |  | 24  |  From     [ 17:00 ]   To [ 18:00 ]              |
|                                     |  | Sep |  Where    [ Cafe Noir                      ]    |
|                                     |  +-----+  (~) 5 taken as 17:00      (~) You are busy then|
|                                     |           Calendar: Personal   (no invitations are sent) |
|                                     |  [Add to calendar]                                       |
|                                     |----------------------------------------------------------|
|                                     |  - - Draft reply - - - - - - - - - - - - - - - - - - - - |
|                                     |  | Sounds great, Thursday at 17:00 works. See you     |  |
|                                     |  | at Cafe Noir.                                      |  |
|                                     |  '----------------------------------------------------'  |
|                                     |  Sends to Dana Levi, +972 54-555-0142                    |
|                                     |  [Approve & send]   [Edit]   [Copy]                      |
|                                     |----------------------------------------------------------|
|                                     |  [Dismiss]                          Suggested by: Local  |
+-------------------------------------+----------------------------------------------------------+
```
RTL: the panel is on the left, the close button sits at the panel's inline-start (its top right), labels are to the right of their fields, contact bubbles hug the right edge and the user's own bubbles the left edge:

```
+----------------------------------------------------------+-- columns (dimmed by scrim) --------+
|                                           Dana Levi  [x] |                                     |
| Needs reply                        0142-555-54 972+      |                                     |
|----------------------------------------------------------|                                     |
|                         (Conversation (what the AI read  |                                     |
|  ,------------------------------.                        |                                     |
|  | ?me: are you around this week |                       |                                     |
|  '------------------------------'                        |                                     |
|                    ,----------------------------------.  |                                     |
|             14:02  |  coffee thursday at 5? the place |  |                                     |
|                    '----------------------------------'  |                                     |
|----------------------------------------------------------|                                     |
|                                                    Event |                                     |
|    [                         Coffee ]    Title  +-----+  |                                     |
|                [v   Thu 24 Sep 2026 ]     Date  | Thu |  |                                     |
|              [ 18:00 ] To   [ 17:00 ]     From  | 24  |  |                                     |
|    [                      Cafe Noir ]    Where  | Sep |  |                                     |
|                                       [Add to calendar]  |                                     |
|----------------------------------------------------------|                                     |
|  - - - - - - - - - - - - - - - - - - - Draft reply - -   |                                     |
|                      [Copy]   [Edit]   [Approve & send]  |                                     |
|----------------------------------------------------------|                                     |
|  Suggested by: Local                          [Dismiss]  |                                     |
+----------------------------------------------------------+-------------------------------------+
```

### 7.1 Conversation block

The `item_messages` snapshot (<= 12 rows), oldest first. Contact messages: `QuotedBubble` aligned to the inline-start; the user's own messages: same bubble on `--color-accent-soft`, aligned to the inline-end, prefixed for screen readers with "You:". The trigger message has a 2 px `--color-accent` inline-start edge. All text inert, `dir="auto"` per bubble. If retention nulled the text: muted "Message text was removed after 30 days". Heading copy "What the AI read" is literal: it tells the user this is the exact context, nothing more.

### 7.2 Event block (`EventEditor`)

Fields: Title (text, `dir="auto"`, max 80), Date (native `<input type="date">`), From / To (native `<input type="time">`, 24 h), Where (text, `dir="auto"`, max 120). Native inputs are used on purpose: keyboard- and screen-reader-complete with zero code, locale aware. Below: target calendar name (from settings, read-only here) and the fixed reassurance "No invitations are sent". Validation is inline and immediate, mirroring S2 sanity rules: start in the past -> "That time has already passed."; end <= start -> "End time must be after the start."; duration > 12 h or < 5 min -> "Choose a duration between 5 minutes and 12 hours."; > 12 months ahead -> "That is more than a year away." Invalid => "Add to calendar" disabled with the message as its description.

Edited values travel as `edit: {title, startLocal, endLocal, location}` on `action:approve`; nothing is saved before approval (closing the sheet discards edits, after the confirm in section 7).

After `created`: fields become read-only text, the button becomes "Open in calendar" (`external:open {itemId, target:'calendarEvent'}`), plus the `change_in_google` info chip.

### 7.3 Information-missing variant

The Event block shows only the missing fields as empty inputs, each marked "Needed", with the known ones as read-only text and a quiet "Change" link. A one-line summary sits above: "Missing: day, time" (from `missing[]` mapped to locale keys: date -> day, time, duration, location -> place, who, confirmation). Primary action of the sheet is "Ask for details" (sends the clarifying question in the draft). "Add to calendar" becomes enabled when the form validates **and** a pending `create_event` action exists for the item (see Architecture concerns C2).

### 7.4 Footer of the sheet

"Dismiss" (quiet, inline-start) and provenance in muted text: "Suggested by: Local model" / "Claude" / "Gemini" (provider name only; the model id is in the tooltip). No confidence scores, no token counts.

---

## 8. Onboarding wizard

One view, five steps, resumable (`onboarding:getState` / `onboarding:setStep`). **Order is the architecture's (12.1): 0 Welcome + language -> 1 Choose the AI -> 2 Link WhatsApp -> 3 Google Calendar -> 4 Ready**, so the multi-gigabyte download runs while the user does the other steps.

Shared frame: content column 560 px max, start-aligned text (not centred), one primary button per step at the bottom inline-end, "Back" as a quiet button at the bottom inline-start. A progress rail under the header shows the four named stages after Welcome - they are a real sequence, so they are numbered:

```
   1 AI  ------  2 WhatsApp  ------  3 Calendar  ------  4 Ready
   ====== done (ok colour) ====== current (accent) ------ upcoming (line)
```
`<ol>` with `aria-current="step"`. In RTL the rail starts at the right. Closing the window during onboarding hides to tray like everywhere else; downloads continue.

### 8.0 Welcome (`Welcome.tsx`)

LTR:
```
+----------------------------------------------------------------------------------------------+
| WA Calendar Agent                                                                 [ עב | EN ] |
+----------------------------------------------------------------------------------------------+
|                                                                                              |
|   Plans from your WhatsApp chats, ready for your calendar.                  (--text-xl)      |
|                                                                                              |
|   It reads your one-to-one chats and notices when someone suggests a plan.                   |
|   It drafts a reply and a calendar entry for you.                                            |
|   Nothing is sent or scheduled without your approval.                        (600 weight)    |
|                                                                                              |
|   Language      ( ) עברית     (o) English                                                    |
|                                                                                              |
|   Before you continue                                                                        |
|   - This links to WhatsApp as an unofficial "linked device". WhatsApp does not support       |
|     this and could restrict an account that uses it.                                         |
|   - It uses one of your free linked-device slots.                                            |
|   [ ] I understand and want to continue                                                      |
|                                                                                              |
|                                                                              [ Get started ] |
+----------------------------------------------------------------------------------------------+
```
RTL: identical structure mirrored - language toggle at the top left, text start-aligned to the right edge, "Get started" at the bottom left.

- Language default from main (`app:getBootstrap.lang`); switching re-renders immediately.
- "Get started" is disabled until the checkbox is ticked; then `consent:accept {kind:'whatsapp_tos', version}`. Without it the bridge is never spawned.
- The three sentences are plain paragraphs, not a bulleted feature list; the third is the promise and the only bold line.

### 8.1 Choose the AI (`ChooseAi.tsx`)

Three radio cards (`role="radiogroup"`), stacked (never side by side - the privacy note needs room). Selected card: `--color-accent-soft` background + 2 px accent border. Each card: name, one-line plain description, **privacy note** (shield icon, always visible, not a tooltip), then its own expanding body.

LTR:
```
|  Choose where the AI runs                                                                    |
|                                                                                              |
|  (o) On this computer                                                          Recommended   |
|      Free and private. One-time download of 4.6 GB.                                          |
|      (shield) Your messages never leave this computer.                                       |
|      ------------------------------------------------------------------------------------   |
|      Your computer: 16 GB memory, no separate graphics card, 212 GB free.                    |
|      Best fit: the standard model. A reply suggestion takes about 20-60 seconds.             |
|      [ Download and continue ]        Choose a different size v                              |
|                                                                                              |
|  ( ) Claude (Anthropic)                                                                      |
|      Faster and more accurate. Needs your own API key; you pay Anthropic per use.            |
|      (shield) The chat being analysed is sent to Anthropic - without names or phone numbers. |
|                                                                                              |
|  ( ) Gemini (Google)                                                                         |
|      Fast. Needs your own API key; a free tier exists.                                       |
|      (shield) The chat being analysed is sent to Google - without names or phone numbers.    |
|               On the free tier Google may use it to improve its products, and people         |
|               may review it.                                                                 |
|                                                                                              |
| [Back]                                                                          [ Continue ] |
```

Local body: hardware sentence from `llm:getHardware` in plain words (never "VRAM", "GGUF", "quantisation", tier code names). Tier names shown to the user: tiny = "Light (2.9 GB)", small = "Standard (4.6 GB)", mid = "Large (6.3 GB)" (sizes = pinned bytes / 2^30, one decimal). "Choose a different size" reveals a three-option select with a one-line consequence each ("Large - more accurate, slower on this computer"). Free disk too low: danger-soft row "Not enough free space: needs 5.2 GB, 3.1 GB available." with action "Check again". "Download and continue" calls `model:startDownload {tier}` and **moves on immediately**; the `DownloadPill` takes over.

Cloud body, in order (each stage replaces the previous inside the card):
1. `ConsentDialog` (blocking, versioned): title "Before you switch to Claude"; body as a short definition list - *What is sent*: the last messages of the one chat being analysed, labelled only "contact" and "me". *What is never sent*: names, phone numbers, photos, your other chats, your calendar event titles (unless you turn that on in settings). *Who receives it*: Anthropic, under their API terms. Gemini adds the free-tier warning. Buttons: "I agree - use Claude" (accent) / "Cancel". Accept -> `consent:accept`.
2. Key field: `<input type="password" dir="ltr" autocomplete="off">` + "Show" toggle + "Paste" button, helper link "Where do I get a key?" (`external:open {target:'claudeKeyHelp'|'geminiKeyHelp'}`). "Check key" -> `secrets:set` then `llm:validateKey`.
3. Result row: ok - "(v) Key works" + model select (from `llm:listModels`; presets first; default per architecture) ; errors are specific: `auth` "This key was not accepted.", `billing` "The key works, but the account has no credit.", `network` "Could not reach Anthropic - check your internet.", `model_not_found` "That model is not available for this key - choose another."
After saving, the field shows only "Key saved - ends in 4f2a" with "Replace" and "Remove"; the key is never shown again.

"Continue" is enabled when: Local selected and a download was started or a model is ready; or cloud selected with consent + validated key.

RTL: mirrored; radio dots at the right, "Recommended" chip at the left, key field stays LTR.

### 8.2 Link WhatsApp (`LinkWhatsApp.tsx` + `QrPairing.tsx`)

LTR:
```
|  Link your WhatsApp                                                                          |
|                                                                                              |
|  +------------------------+     1  Open WhatsApp on your phone.                              |
|  |                        |     2  Tap Settings (or the three dots), then Linked devices.    |
|  |       QR  240x240      |     3  Tap Link a device and point the phone at this code.       |
|  |                        |                                                                  |
|  |                        |     ([R2] no illustration strip in v1)                           |
|  +------------------------+                                                                  |
|   New code in 0:41  ======------                                                             |
|   [ Show new code ]  (only after timeout)                                                    |
|                                                                                              |
| [Back]                                                       Waiting for your phone...       |
```
RTL:
```
|                                                                          Link your WhatsApp |
|                                                                                              |
|                 .Open WhatsApp on your phone  1     +------------------------+               |
|   .Tap Settings, then Linked devices          2     |                        |               |
|   .Tap Link a device and point at this code   3     |       QR  240x240      |               |
|                                                     |    (never mirrored)    |               |
|                                                     +------------------------+               |
|                                                        ------======  New code in 0:41        |
|      ...Waiting for your phone                                                       [Back]  |
```
- QR: data URL from `pairing:get`, rendered at 240 x 240 on a **white** plate with 16 px quiet zone in both themes (`--radius-lg` frame), `alt="QR code to link WhatsApp"`. `image-rendering: pixelated`.
- Steps are a real sequence -> numbered `<ol>`. `[R2]` No illustrations in v1 (`resources/onboarding/**` does not exist; no lane can produce raster assets). A post-v1 ticket may add pictures the user captures.
- Countdown: a thin bar + "New code in m:ss" from `expiresAt`; the text is not a live region. On refresh (`pairing:changed`) the image swaps without layout shift.
- States: *preparing* (skeleton plate + "Preparing the code..."), *qr* (above), *timeout* ("The code expired." + "Show new code" -> `pairing:newCode`), *connected* (plate replaced by a large check on ok-soft: "Connected. Older messages are ignored - the agent starts from now." and the primary button "Continue" appears), *error rows*: no free slot - "WhatsApp limits how many devices can be linked. Remove one under Linked devices on your phone and try again."; `BRIDGE_OUTDATED`, `BRIDGE_BINARY_BLOCKED`, `BRIDGE_SPAWN_REFUSED` per section 11.4.
- There is no "Skip": WhatsApp is the product. "Back" stays available.

### 8.3 Google Calendar (`GoogleWizard.tsx`)

Intro:
```
|  Connect Google Calendar                                                                     |
|                                                                                              |
|  About 5 minutes, one time. Google asks every personal app like this one to be registered    |
|  by its owner - so you will create a small free "project" in your own Google account.        |
|  We will walk through it one click at a time. Nothing here costs money.                      |
|  (shield) The Google keys stay on this computer.                                             |
|                                                                                              |
| [Back]                                                 [ Later - replies only ]   [ Start ]  |
```
"Later" -> step 4; the dashboard shows the calendar SetupStrip.

The OAuth-client setup helper = five sub-steps, each with the same anatomy: a sub-rail "Step 2 of 5", one or two **Open** buttons (deep links through `external:open {target: enum}` from `resources/links.json` - the renderer never sees the URL), a numbered text instruction list (`[R2]` **no screenshots in v1** - nobody in the build can capture the Google console; the numbered steps name the exact button labels instead), and "Done - next".

```
|  Step 2 of 5 - Let the app ask for permission                                                |
|                                                                                              |
|     1  Click Open consent screen.                                                            |
|     2  Choose External, fill in an app name and your own e-mail, and save.                   |
|     3  Click Publish app, then Confirm. (Otherwise Google signs you out every 7 days.)        |
|                                                                                              |
|  [ Open consent screen ]   [ Open publishing page ]                                          |
|                                                                                              |
| [Back]                                                                     [ Done - next ]   |
```

| Sub-step | Title (en) | Buttons | Notes |
|---|---|---|---|
| 1 | Create a project and turn on the Calendar API | Open new project / Open Calendar API | Tip row: "Check that the right Google account and the new project are selected at the top of the Google page." |
| 2 | Let the app ask for permission | Open consent screen / Open publishing page | Steers to External + Publish app; a quiet disclosure "I prefer to keep it in testing" explains the 7-day reconnect and the test-user step |
| 3 | Create the key file | Open credentials page | Instruction: Create credentials -> OAuth client ID -> **Desktop app** -> Download JSON. Copy chip for a suggested client name |
| 4 | Add the key file | drop zone + "Browse..." | `google:pickCredentialsFile` (native dialog in main) or drop -> the renderer reads the **content** and calls `google:importCredentials {jsonText}`; specific errors below |
| 5 | Sign in with Google | Sign in with Google | Shown **before** the browser opens (text only, `[R2]` no picture): "Google will show a page saying it hasn't verified this app. That warning appears because the project is your own private one. Click Advanced, then Go to <your app name>." and `[R2]` "Windows may ask whether this app can use the network - Cancel or Allow both work." (the calendar server's sign-in listener triggers the Defender Firewall dialog once for this unsigned app). Then `google:startSignIn`; waiting state with a spinner, "Waiting for you to finish in the browser... (up to 5 minutes)" and "Open the page again" |

Drop zone: 120 px high dashed `--color-line-strong` box, keyboard-focusable button semantics ("Choose the key file"), drag-over state = accent border + accent-soft fill. Validation errors (inline, danger-soft): not JSON - "This is not the file Google gave you. It should be named client_secret_....json."; `web` client - "This key is for a Web application. Go back one step and choose Desktop app."; missing fields - "The file is incomplete - download it again."; too large - "This file is too big to be a Google key file."; `[R2]` `bad_endpoint` - "This key file points at a server that is not Google. Download it again from the Google page."

Success: "(v) Connected" + calendar picker (select from `google:listCalendars`, default primary) + "Continue". Failure rows map: `access_denied` -> link back to sub-step 2; API disabled -> sub-step 1; `CAL_PORT_BUSY`; timeout -> "Try again".

RTL: mirrored; a muted note in Hebrew says "Google's pages may appear in English".

### 8.4 Ready (`Ready.tsx`)

```
|  You are set                                                                                 |
|                                                                                              |
|  (~) AI          Downloading, 43 % - about 12 minutes. Chats wait until it is ready.         |
|  (v) WhatsApp    Connected                                                                   |
|  (v) Calendar    Connected - Personal                                                        |
|                                                                                              |
|  [tray icon glyph]  Closing the window with X keeps the agent running. You will find it     |
|                     next to the clock, under the ^ arrow (hidden icons).                     |
|                     To quit, right-click the icon and choose Quit.                           |
|                                                                                              |
|                     [ ] Start with Windows (hidden, next to the clock)                       |
|                                                                                              |
|  (i) Tip: your chats are stored on this computer. Turning on BitLocker protects them         |
|      if the computer is lost.                                                                |
|  (!) Your data folder is inside a cloud-synced folder (OneDrive). [What to do]   (if true)   |
|                                                                                              |
|                                                                        [ Open dashboard ]    |
```
The checklist is live (`health:changed`, `model:progress`). Autostart is **unchecked by default**. `[R2]` No flyout picture in v1: the tray icon glyph (`resources/icons/tray.ico` rendered inline as SVG) plus two sentences; in RTL the text says "left of the clock" because Hebrew Windows puts the clock at the left.

---

## 9. Settings (`Settings.tsx`)

One scrolling page, max content width 720 px, start-aligned; groups are `<section>` with an `<h2>` (`--text-md` 600) and a hairline above; at >= 900 px a sticky in-page group list sits at the inline-start (plain text links, no icons). Every row = label (+ one-sentence description in muted `--text-sm`) at the start, control at the end; below 640 px the control drops under the label. Changes save immediately (`settings:set` with the partial); a muted "Saved" appears next to the control for 2 s (polite live region). There is no "Save" button and no dirty state. Destructive things ask in a dialog.

LTR:
```
+----------------------------------------------------------------------------------------------+
| [< Dashboard]   Settings                     (v) All running          [|| Pause] [he|EN]     |
+----------------------------------------------------------------------------------------------+
| General            |  General                                                                |
| AI                 |  Language                                   [ System | עברית | English ] |
| WhatsApp           |  Start with Windows                                             ( o )   |
| Google Calendar    |    Starts hidden, next to the clock.                                    |
| Working rules      |  Notifications                                  [ Without names    v ]  |
| Replies            |    Message text is never shown in notifications.                        |
| Privacy and data   |  Time zone                                      [ Asia/Jerusalem   v ]  |
|                    |  Pause the agent                                                ( o )   |
|                    |    Stops reading new chats with the AI. WhatsApp stays linked and       |
|                    |    cards you already have still work.                                   |
|                    | ----------------------------------------------------------------------- |
|                    |  AI                                                                     |
|                    |  (o) On this computer     (shield) Messages never leave this computer.  |
|                    |      Standard model - ready - speed: good                               |
|                    |      Model size [ Automatic v ]   Graphics acceleration [ Automatic v ] |
|                    |      [Test again]   [Delete model]                                      |
|                    |  ( ) Claude               (shield) The analysed chat is sent to Anthropic|
|                    |      Key saved - ends in 4f2a  [Replace] [Remove]   Model [claude-... v] |
|                    |  ( ) Gemini               (shield) The analysed chat is sent to Google   |
|                    |  Daily cloud limit      [ 200,000 ] tokens     Used today: 41,200       |
+----------------------------------------------------------------------------------------------+
```
RTL: group list at the right, labels at the right, controls at the left; toggles flip their "on" side automatically because the thumb uses `inset-inline-start`.

Groups, rows and their bindings (the brief's items in **bold**):

| Group | Row | Control | Binding |
|---|---|---|---|
| General | **Language** | 3-segment | `general.language` (`system/he/en`) |
| | **Start with Windows** | toggle, default off | `general.autostart` |
| | Notifications | select: Off / On (never shows who or what) | `general.notifications` (`off/generic`; `[R2]` `with_name` cut) |
| | Time zone | read-only text ("Asia/Jerusalem - from Windows") | `general.timeZone` (`[R2]` main sets it from the OS; no picker in v1) |
| | **Pause the agent** | toggle (same state as header Pause) | `agent:setPaused` |
| AI | **Provider** | three radio cards as in onboarding 8.1, privacy note always visible | `llm:setProvider`; switching to a cloud provider without consent opens `ConsentDialog`; failure reasons inline ("Add a key first") - **never silently falls back** |
| | **Model** - Local: size (Automatic / Light / Standard / Large, download size shown before confirming), acceleration (Automatic / Off), speed result (good / slow + suggestion to pick a smaller size, never automatic), Test again, Delete model, Download again | selects + buttons | `settings.llm.local.*`, `model:*` |
| | **Model** - Claude / Gemini: key status (last 4), Replace, Remove, Check key, model select (live list; Gemini id editable), consent date + "Withdraw consent" | | `secrets:*`, `llm:validateKey`, `llm:listModels`, `consent:get` |
| | Daily cloud limit | number input (step 10,000) | `llm.cloudDailyTokenBudget` (`[R2]` the "used today" counter is cut from v1) |
| WhatsApp | Status + Re-link | status text + button (dialog: "Re-linking shows a new QR code. Your cards stay.") | `pairing:relink {confirm:true}` |
| | Unlink and delete WhatsApp data | danger button + dialog that also says "Then remove 'WhatsApp Calendar Agent' under Linked devices on your phone." | `pairing:unlinkAndWipe {confirm:true}` |
| Google Calendar | Account (`<bdi>` email), Reconnect, Disconnect, Replace key file | | `google:*` |
| | Add events to | select from `google:listCalendars` | `calendar.targetCalendarId` |
| | Check these calendars for conflicts | checkbox list | `calendar.conflictCalendarIds` |
| **Working rules** | Analyse chats from people I have never written to | toggle, default off; description: "When off, new contacts appear as plain cards with an 'Analyse this chat' button." | `whatsapp.processUnknownSenders` |
| | Look back after linking | select: From now / 12 h / 24 h / 48 h / 72 h | `whatsapp.backlogHours` |
| | When someone writes "at 5" without am/pm | radio: Assume the afternoon and show a note / Ask me (goes to Information missing) | `agent.ambiguousHour` |
| | Default event length | select 30 / 45 / 60 / 90 / 120 min | `calendar.defaultDurationMin` |
| | **Ignored chats** | list of chats with a non-default policy: name `<bdi>`, policy select (Analyse normally / Never analyse), remove; empty: "No ignored chats. Use the ... menu on a card to ignore a chat." (`[R2]` "Local model only" and "Let the AI see the titles of my events" are cut from v1: the AI only ever sees busy/free times) | `chat:setPolicy` + `chat:listPolicies` |
| Replies | How the AI should phrase Hebrew for me | radio: Masculine / Feminine / Not specified | `agent.userGender` |
| Privacy and data | What leaves this computer | static table (per provider: what / to whom) | - |
| | Keep message text for | select 7 / 14 / 30 / 60 / 90 days | `privacy.retentionDays` |
| | Delete stored message text now | button + dialog | `data:purgeNow` |
| | Export diagnostics | button; description "Settings and error codes only - never messages, names or keys." | `diagnostics:export` |
| | Licences | button opening a plain-text dialog | - |

Toggle: 36 x 20 track, `role="switch"`, `aria-checked`; on = accent track, off = `--color-line-strong` track; the thumb carries a check icon when on (not colour-only).

---

## 10. Dialogs and toasts

- **Dialog** (`ConsentDialog` and confirm dialogs): centred, max 480 px, `--radius-lg`, `--shadow-sheet`, scrim, `role="dialog"`/`alertdialog`, `aria-modal`, focus trap, initial focus on the **least destructive** button, Escape = cancel. Button order follows reading order: primary at the inline-end. Destructive confirms name the object: "Delete the Standard model (4.6 GB)?" - "Delete model" / "Keep it".
- **In-window toast**: bottom inline-end, 320 px, `--shadow-pop`, max one at a time (a new one replaces the old), 6 s, pauses on hover/focus, `role="status"`. Used only for: Dismissed - Undo; Copied; chat policy changed - Undo; Download finished. **Never** for approvals or their results (those stay on the card), never containing message text or names.
- Rendered by `App.tsx` from a tiny toast slice in `store/dashboard.ts`.

---

## 11. Empty, loading and error states

### 11.1 First paint

`app:getBootstrap` paints the frame in one round trip. Until `dashboard:get` resolves (normally < 100 ms) each column shows **two static skeleton cards** (`--color-quote` blocks: one name line, one bubble, one button), no shimmer. If it takes > 3 s: muted "Still loading..." under the skeletons. If it fails: column-spanning row "Could not load your items." + "Try again".

### 11.2 Empty lists (an empty screen is an invitation or a reassurance, never a drawing)

Plain text, start-aligned at the top of the column, muted, max 36ch. No illustrations.

| Situation | en | he |
|---|---|---|
| Needs reply - empty, all healthy | Nothing is waiting for you. The agent keeps watching in the background. | אין הודעות שמחכות לך. הסוכן ממשיך לעקוב ברקע. |
| Needs reply - empty, queue busy | Analysing N chats... cards appear here when they are ready. | מנתח N שיחות... הכרטיסים יופיעו כאן כשיהיו מוכנים. |
| Needs reply - empty, WhatsApp not linked | Link WhatsApp to get started. [Link WhatsApp] | קשרו את וואטסאפ כדי להתחיל. |
| Needs reply - empty, paused | The agent is paused. [Resume] | הסוכן מושהה. |
| In calendar - empty | Events you approve appear here. | אירועים שתאשרו יופיעו כאן. |
| In calendar - calendar not connected | Connect Google Calendar to add events. [Connect] | חברו את יומן Google כדי להוסיף אירועים. |
| Information missing - empty | When a plan is missing a day or a time, it shows up here with a question you can send. | כשחסרים לתוכנית יום או שעה, היא תופיע כאן עם שאלה שאפשר לשלוח. |

First-run dashboard with a model still downloading: "Needs reply" shows its normal empty text plus the DownloadPill in the header; arriving chats appear as raw cards with the `waiting_llm` chip and are replaced by analysed cards, oldest first, when the model is ready.

### 11.3 Per-card loading/error

Covered in 6.8 (approval) and 6.6 (hold/failed chips). "Analyse again" on a failed card puts the item back in the queue: the card disappears into "Analysing N chats..." (that is the architecture's visibility rule) and a toast-free, polite live-region message says "Analysing again".

### 11.4 ErrorCode copy deck (title / body / the single action)

Shown in the status panel row of the owning part and, where marked, inline. Every code MUST exist in both locale files (`errors.<CODE>.title|body|action`), enforced by the parity test.

| ErrorCode | Part | Title en | Body en | Action en | Title he | Action he |
|---|---|---|---|---|---|---|
| `BRIDGE_CRASH_LOOP` | WhatsApp | The WhatsApp connection keeps stopping | It was restarted several times and is now resting. | Try again | חיבור הוואטסאפ נעצר שוב ושוב | ניסיון נוסף |
| `BRIDGE_BINARY_BLOCKED` | WhatsApp | The WhatsApp component is missing or was blocked | An antivirus may have removed it. | Open instructions | רכיב הוואטסאפ חסר או נחסם | פתיחת הנחיות |
| `BRIDGE_SPAWN_REFUSED` | WhatsApp | The WhatsApp component was not started, to stay safe | A safety check failed. Your other WhatsApp tools were not touched. | Export diagnostics | רכיב הוואטסאפ לא הופעל, מטעמי בטיחות | ייצוא אבחון |
| `WA_OFFLINE` | WhatsApp | WhatsApp has been offline for a while | Sending is paused until it reconnects. Copy still works. | Check your internet | וואטסאפ לא מחובר כבר זמן מה | בדיקת החיבור לאינטרנט |
| `WA_LOGGED_OUT` | WhatsApp | This computer was unlinked from WhatsApp | Link it again to continue. Your cards stay. | Re-link | המחשב נותק מוואטסאפ | קישור מחדש |
| `BRIDGE_OUTDATED` | WhatsApp | WhatsApp no longer accepts this version | Drafts still work and you can copy them; sending needs an app update. | How to update | וואטסאפ כבר לא מקבל את הגרסה הזו | איך מעדכנים |
| `BRIDGE_TS_FORMAT` | WhatsApp | New messages cannot be read correctly | The message dates are in an unexpected format. | Export diagnostics | לא ניתן לקרוא הודעות חדשות כראוי | ייצוא אבחון |
| `LLM_LOCAL_FAILED` | AI | The AI on this computer did not start | You can test again or choose a smaller model. Chats wait as plain cards. | Test again | הבינה במחשב הזה לא עלתה | בדיקה חוזרת |
| `MODEL_MISSING` | AI | The AI model file is missing or damaged | It needs to be downloaded again. | Download again | קובץ המודל חסר או פגום | הורדה מחדש |
| `DISK_FULL` | AI | Not enough disk space for the AI model | Free up X GB and continue the download. | Free up X GB (opens Windows storage settings via enum link) | אין מספיק מקום בדיסק למודל | פינוי X GB |
| `DOWNLOAD_FAILED` | AI | The model download stopped | It will continue from where it stopped. | Download again | הורדת המודל נעצרה | הורדה מחדש |
| `KEY_INVALID` | AI | The API key was not accepted | The AI is paused until you update it. | Update key | מפתח ה-API לא התקבל | עדכון מפתח |
| `KEY_MISSING` | AI | An API key is needed | The saved key could not be read on this computer. | Enter key | נדרש מפתח API | הזנת מפתח |
| `CLOUD_QUOTA` | AI | The AI account is out of credit or quota | New chats wait until this is fixed. | Open AI settings | נגמרה המכסה או היתרה בחשבון הבינה | פתיחת הגדרות הבינה |
| `MODEL_NOT_FOUND` | AI | The chosen AI model is no longer available | Pick another model to continue. | Choose a model | המודל שנבחר כבר לא זמין | בחירת מודל |
| `LLM_BAD_OUTPUT` | card | Could not analyse this chat | You can still reply yourself. | Analyse again | לא הצלחנו לנתח את השיחה | ניתוח מחדש |
| `CAL_UNAVAILABLE` | Calendar | The calendar connection stopped | Replies still work; adding events is paused. | Try again | החיבור ליומן נעצר | ניסיון נוסף |
| `CAL_RECONNECT` | Calendar | Google connection expired | Sign in again. If this happens every week, publish your Google project (see setup step 2). | Reconnect | החיבור ל-Google פג | התחברות מחדש |
| `CAL_PORT_BUSY` | Calendar | Google sign-in could not start | Another program is using the ports it needs (3500-3505). Close it and try again. | Try again | לא ניתן להתחיל את ההתחברות ל-Google | ניסיון נוסף |
| `CAL_TOOLSET_MISMATCH` | Calendar | The calendar component is not the expected version | It was turned off to stay safe. | Export diagnostics | רכיב היומן אינו בגרסה הצפויה | ייצוא אבחון |
| `DB_RECOVERY` | app (blocking dialog) | The app's data could not be opened | You can restore yesterday's backup. WhatsApp stays linked either way. | Restore (secondary: Start fresh) | לא ניתן לפתוח את נתוני האפליקציה | שחזור |

Hebrew bodies are written by lane 13 following the English meaning and the style rules of section 15.1. Amber transient states (rate limited, overloaded, reconnecting) have a sentence but no action.

`DB_RECOVERY` is the only full-window blocking state; it is an `alertdialog` with two buttons and nothing behind it.

---

## 12. Tray, close-to-tray hint, notifications (lane 11 implements; copy from the locale files via main's i18n instance)

### 12.1 Tray menu

```
LTR                                   RTL (Windows mirrors native menus for Hebrew UI)
+--------------------------------+    +--------------------------------+
| Open                           |    |                         פתיחה |
| Active - local model (disabled)|    |      פעיל - מודל מקומי (אפור) |
|--------------------------------|    |--------------------------------|
| Pause processing               |    |                  השהיית הסוכן |
| Settings                       |    |                        הגדרות |
|--------------------------------|    |--------------------------------|
| Quit                           |    |                         יציאה |
+--------------------------------+    +--------------------------------+
```
- Status line values: "Active - local model" / "Active - Claude" / "Active - Gemini" / "Paused" / "WhatsApp offline" / "Needs attention - open the app" / "Setting up". Never counts of people, never names.
- "Pause processing" <-> "Resume processing". Left click and double click = Open. Rebuilt on language, pause and health change.
- Tooltip: "WhatsApp Calendar Agent" + at most " - 3 waiting" (a count is allowed; text and names are not).
- Icons: `tray.ico` (neutral diary-leaf glyph), `tray-attention.ico` (leaf + dot, open items exist), `tray-paused.ico` (leaf + pause bars), `tray-error.ico` (leaf + exclamation). Shapes differ, not only colours; each ships 16/20/24/32 px and reads on both light and dark taskbars (1 px contrasting outline). The glyph is the date tab of 6.4 - the same signature object.
- No approvals, no item list and no message text in the tray, ever.

### 12.2 First-close coach mark (once, `meta.tray_hint_seen`) - `[R2]` ARCHITECTURE 13 is the rule

**Every X click hides the window immediately** (`preventDefault(); hide()`; e2e `tray-lifecycle.spec.ts` asserts the first close hides within 200 ms). On the **first** hide main shows the Windows toast (title "Still running next to the clock", body "Under hidden icons. To quit: right-click the icon, then Quit.") and sets `meta.tray_hint_seen`. The coach mark below is shown **the next time the window is opened** (`Bootstrap.trayHintSeen` / `ui:navigate {view:'tray_hint'}`); "Got it" calls `app:ackTrayHint`, which only dismisses the mark. The window is never kept open to show it.

```
+----------------------------------------------------------------------------------------------+
|                                   (scrim over the dashboard)                                 |
|                 +----------------------------------------------------------+                 |
|                 |  The agent keeps running                                 |                 |
|                 |                                                          |                 |
|                 |  [tray glyph]  Closing the window does not stop it.      |                 |
|                 |                You will find it next to the clock,       |                 |
|                 |                under the ^ arrow (hidden icons).         |                 |
|                 |                To quit: right-click the icon, then Quit. |                 |
|                 |                                                          |                 |
|                 |                                            [ Got it ]    |                 |
|                 +----------------------------------------------------------+                 |
+----------------------------------------------------------------------------------------------+
```
`role="dialog"`, focus on the button, Escape = same as the button. No picture (`[R2]`); the tray glyph is the inline SVG of `tray.ico`. In Hebrew the text says the icon is at the left of the clock.

He: title "הסוכן ממשיך לפעול"; body "סגירת החלון לא עוצרת אותו. הוא נמצא ליד השעון, תחת החץ של הסמלים המוסתרים. ליציאה: לחיצה ימנית על הסמל ואז 'יציאה'."; button "הבנתי".

### 12.3 Windows notifications

| Setting | Title | Body |
|---|---|---|
| `generic` (default) | A chat needs your reply | Open the app to review the suggestion. |
| `off` | - | - |

`[R2]` `with_name` is cut from v1: the push name is chosen by the sender and a toast is app chrome on the lock screen (T22). `app/notifications.ts` test: no toast ever contains a `chats.display_name`.

One notification per item creation at most, coalesced to one per 60 s ("3 chats need your reply"). Never message text, never draft text, never names, no action buttons. Click = show window + `ui:navigate {view:'dashboard', itemId}` (opens the sheet with focus on its close button, 7) and main records `shownByNotificationAt` for the 300 ms approve guard (6.8). Attention-state notifications (`WA_LOGGED_OUT`, `KEY_INVALID`, `CAL_RECONNECT`): once per occurrence, title = ErrorCode title, body "Open the app to fix it."

---

## 13. Accessibility

Target: WCAG 2.2 AA; fully operable without a mouse; tested with Narrator and NVDA in both languages.

### 13.1 Structure and landmarks

`<header role="banner">`, `<main>`, `<footer role="contentinfo">`; one `<h1>` per view (on the dashboard it is a visually hidden "Dashboard"; in Settings and onboarding it is the visible view title); each column is a `<section aria-labelledby>` with an `<h2>`; each card an `<article>` whose accessible name is "<contact>, <list name>, <time>". The sheet, dialogs, status panel and drawers are labelled dialogs. `<html lang>` always matches the UI language; untrusted text blocks carry `dir="auto"` and, when main knows `chats.lang`, `lang="he|en"` so screen readers switch voice.

### 13.2 Keyboard map

| Key | Where | Effect |
|---|---|---|
| Tab / Shift+Tab | everywhere | DOM order = visual reading order in both directions (no `tabindex` > 0, no CSS reordering) |
| F6 / Shift+F6 | dashboard | cycle regions: header, column 1, column 2, column 3, footer |
| Up / Down | focus on a card (card root is focusable, `tabindex=0`, roving) | previous / next card in the column |
| Left / Right | focus on a card root | adjacent column **in visual direction** (Right moves to the visually right column in both LTR and RTL) |
| Enter | card root | open the sheet |
| Escape | sheet, dialog, popover, menu, drawer | close, return focus to the opener |
| Ctrl+Enter | inside a draft textarea | **moves focus to the card's primary approval button** (it does not send: approval stays a deliberate second key press - Enter or Space on the button) |
| Arrow keys | radio groups, segmented controls, menus | standard roving behaviour; Home/End in menus |

`[R2]` Alt+P, Ctrl+, and Ctrl+L are cut from v1 (Pause, Settings and the language toggle are one click away in the header). No single-letter shortcuts (they collide with typing Hebrew/English drafts). No "Keyboard shortcuts" disclosure in Settings.

### 13.3 Focus

Focus ring: `outline: 2px solid var(--color-accent); outline-offset: 2px` on `:focus-visible` for every interactive element, including cards (the ring follows the card radius). Never removed, never replaced by a colour change. After an approval succeeds and the card leaves, focus moves to the next card in the same column, or to the column heading if none. After a failure, focus moves to the inline result row (which is `tabindex="-1"` and `role="alert"`).

### 13.4 Live regions

Two visually hidden regions in `App.tsx`: polite (`role="status"`) and assertive (`role="alert"`).

| Event | Region | Text |
|---|---|---|
| Approval success | polite | "Sent to <name>." / "Added to calendar: <weekday date time>." (name and event come from trusted fields; draft text is never read out automatically) |
| Approval failure | assertive | the inline row text |
| New card while window focused | polite, coalesced 10 s | "1 new chat needs your reply." |
| Health overall changed | polite, throttled 10 s | pill label |
| Download finished | polite | "Download finished - the AI is ready." |
| Saved (settings) | polite | "Saved." |

### 13.5 Forms

Every input has a visible `<label>`; errors are text under the field linked by `aria-describedby` and `aria-invalid`; required state is text ("Needed"), not an asterisk; password/key fields have a "Show" toggle with `aria-pressed`; the character counter is `aria-live="off"` and is referenced by `aria-describedby`.

### 13.6 Windows contrast themes and zoom

`@media (forced-colors: active)`: all soft backgrounds drop to `Canvas`; cards, bubbles, chips and the date tab get `1px solid CanvasText`; the primary button uses `Highlight`/`HighlightText`; the dashed draft edge stays dashed (`border-style` survives forced colours), so the three voices remain distinguishable by border style: bubble = solid + tail corner, draft = dashed, chrome = none. Icons use `currentColor`. The layout must survive Chromium zoom 200 % at the default window size (which is equivalent to a 490 px viewport -> the one-column layout engages) and Windows text scaling 150 %.

### 13.7 Targets and timing

Minimum target 32 x 32 px with 8 px between adjacent targets (desktop pointer; WCAG 2.5.8 requires 24). Nothing times out except toasts (6 s, pause on hover/focus, and every toast action is also reachable elsewhere: Undo dismiss = footer "Undo dismiss" drawer > Restore). The QR countdown is informational; expiry just offers a new code.

---

## 14. Component inventory

Files are exactly those of ARCHITECTURE section 18 - no new component files. Small internal parts are co-located and exported from the named file. `VM` types below are what the renderer needs; the authoritative shapes live in `src/shared/types.ts` / `src/shared/ipc.ts` (Wave 0) and must contain at least these fields.

```ts
// view models needed by the renderer (subset of shared types)
type ListKey = 'needs_reply' | 'in_calendar' | 'info_missing';
type BadgeCode = 'time_assumed'|'conflict'|'personal_details'|'lang_mismatch'|'link_removed'|'manipulation'|'change_in_google'|'older_message';   // [R2] older_message added
type HoldReason = 'unknown_sender'|'paused'|'waiting_llm'|'budget';   // [R2] local_only cut
type MissingCode = 'date'|'time'|'duration'|'location'|'who'|'confirmation';

interface ActionVM  { actionId: string; kind: 'send_reply'|'create_event'; shownHash: string;
                      state: 'pending'|'approved'|'executing'|'done'|'failed'|'unknown_outcome'|'expired'|'superseded'|'rejected';
                      errorCode?: ErrorCode; expiresAt: number }
interface EventVM   { title: string; startLocal: string; endLocal: string; timeZone: string; location: string;
                      assumptions: string[]; state: 'incomplete'|'proposed'|'created'|'declined'; hasCalendarLink: boolean }
interface ContactVM { chatRef: number; displayName: string /* UNTRUSTED */; phoneDisplay: string | null /* formatted in main */;
                      sendable: boolean; lang: 'he'|'en'|null }
interface ItemVM    { itemId: number; list: ListKey; analysis: 'done'|'held'|'failed'; holdReason?: HoldReason; errorCode?: ErrorCode;
                      contact: ContactVM; trigger: { text: string /* UNTRUSTED */; ts: number; mediaKind?: 'photo'|'voice'|'sticker'|'location'|'other' };
                      draft?: { text: string /* UNTRUSTED */; lang: 'he'|'en' }; replyState: 'none'|'draft'|'sent'|'answered_elsewhere'|'skipped';
                      event?: EventVM; missing: MissingCode[]; badges: BadgeCode[]; actions: ActionVM[];
                      provider?: 'local'|'claude'|'gemini'; updatedAt: number }
interface ItemDetailVM extends ItemVM { messages: { fromMe: boolean; ts: number; text: string | null; isTrigger: boolean }[] }
```

### 14.1 Views

| Component (file) | Props | Notes |
|---|---|---|
| `App` | - | bootstrap (`app:getBootstrap`), `<html lang dir>`, routes `onboarding | dashboard | settings` from store, hosts header/footer, live regions, toast, coach mark, `DB_RECOVERY` dialog; subscribes to `ui:navigate`, `ui:languageChanged` |
| `Dashboard` | - | reads `store/dashboard`; renders three `ItemList`s, `SetupStrip`, the sheet (expanded `ItemCard`), `UndoDismissDrawer`; owns F6/arrow navigation |
| `Settings` | `{ initialGroup?: 'general'|'ai'|'whatsapp'|'calendar'|'rules'|'replies'|'privacy' }` | section 9 |
| `Onboarding/Welcome` | `{ onDone(): void }` | 8.0 |
| `Onboarding/ChooseAi` | `{ onDone(): void; onBack(): void; embedded?: boolean }` | `embedded` = reused inside Settings > AI without wizard chrome |
| `Onboarding/LinkWhatsApp` | `{ onDone(): void; onBack(): void }` | 8.2 |
| `Onboarding/GoogleWizard` | `{ onDone(): void; onSkip(): void; onBack(): void; startAt?: 0|1|2|3|4|5 }` | `startAt` for error deep links ("go to step 2") |
| `Onboarding/Ready` | `{ onDone(): void }` | 8.4 |

### 14.2 Components

| Component | Props | Behaviour summary |
|---|---|---|
| `ItemList` | `{ list: ListKey; title: string; count: number; items: ItemVM[]; queueCount?: number; collapsible: boolean; open: boolean; onToggle(): void; emptyState: ReactNode; onOpenItem(itemId: number): void }` | column/section; renders `ItemCard` or `RawCard` by `analysis`; "Showing the latest 20 of N" |
| `ItemCard` | `{ item: ItemVM | ItemDetailVM; mode: 'compact'|'expanded'; onOpen?(): void; onClose?(): void }` | anatomy 6.5 / sheet 7; owns local edit state (draft text, event fields), calls `api.approve`, `api.dismiss`, `api.setEditing`; never re-syncs local edits from props while dirty |
| `RawCard` | `{ item: ItemVM; onOpen(): void }` | 6.9 |
| `QuotedBubble` | `{ text: string | null; from: 'contact'|'me'; lang?: 'he'|'en'|null; clampLines?: number; isTrigger?: boolean; mediaKind?: ItemVM['trigger']['mediaKind']; timeLabel?: string }` | inert text only; no children prop (prevents accidental rich content) |
| `DraftBox` | `{ value: string; suggestion: string | null; onChange(v: string): void; onEditingChange(editing: boolean): void; label: 'draft'|'own'; maxLength?: 600; disabled?: boolean; collapsedReason?: 'manipulation'; describedBy?: string }` | dashed/solid edge by `label`; counter; "Reset to suggestion"; Ctrl+Enter -> `onRequestPrimaryFocus` via ref |
| `EventEditor` (+ exports `EventChip`) | `EventEditor: { value: EventVM; missing: MissingCode[]; mode: 'edit'|'fill'|'readonly'; calendarName: string; onChange(v: EventEdit): void; onValidityChange(ok: boolean, message?: string): void; focusField?: 'title'|'date'|'start'|'end'|'location' }`; `EventChip: { event: EventVM; badges: BadgeCode[]; onOpen(): void }` | 6.4, 7.2, 7.3; `EventEdit = { title, startLocal, endLocal, location }` |
| `Badges` | `{ codes: BadgeCode[]; holdReason?: HoldReason; errorCode?: ErrorCode; scope: 'event'|'draft'|'card'; onBadgeAction?(code: BadgeCode): void }` | filters by scope; text from locale keys only |
| `HealthPill` | `{ health: AppHealth; onAction(part: 'whatsapp'|'llm'|'calendar', code?: ErrorCode): void }` | pill + status panel 5.2 |
| `DownloadPill` | `{ progress: { tier: 'tiny'|'small'|'mid'; status: 'downloading'|'paused'|'verifying'|'failed'; bytesDone: number; bytesTotal: number; bytesPerSec?: number; etaSec?: number; errorCode?: ErrorCode } | null; onPause(): void; onResume(): void; onCancel(): void; onRetry(): void }` | renders nothing when `null` |
| `SetupStrip` | `{ tasks: ('whatsapp'|'ai'|'calendar')[]; onAction(task): void; onHide(task: 'calendar'): void }` | 5.4 |
| `UndoDismissDrawer` | `{ open: boolean; onClose(): void }` | fetches on open (`dashboard:getIgnored`, last 20 dismissed); 6.10 |
| `QrPairing` | `{ state: { status: 'preparing'|'qr'|'timeout'|'connected'|'error'; qrDataUrl?: string; expiresAt?: number; errorCode?: ErrorCode }; onNewCode(): void }` | 8.2; also used by Settings > WhatsApp > Re-link |
| `ConsentDialog` | `{ kind: 'cloud_claude'|'cloud_gemini'; version: number; open: boolean; onAccept(): void; onCancel(): void }` | text from locale keys `consent.<kind>.v<version>.*`; accept button disabled until the body was scrolled to the end only if it overflows |
| `LanguageToggle` | `{ value: 'he'|'en'; onChange(lang: 'he'|'en'): void; compact?: boolean }` | labels fixed "עב" / "EN", `lang` attribute on each label |

### 14.3 Stores and API

- `store/dashboard.ts`: `{ lists: Record<ListKey, {items: ItemVM[]; count: number}>; ignoredCount; openItemId; sectionOpen; toast; dirtyItemIds: Set<number> }` + `refresh()`, `openItem()`, `markDirty()`. `dashboard:changed` -> `refresh()`; lists are replaced except entries in `dirtyItemIds`, which keep their old VM and get a `stale` flag.
- `store/health.ts`: `AppHealth` + download progress; hydrated by `health:get`, `health:changed`, `model:progress`.
- `store/settings.ts`: `settingsPublic`, `set(partial)`, optimistic locally (settings are not side effects), rolled back on error with an inline "Could not save".
- `api.ts`: typed wrappers over `window.api.invoke(channel, payload)` returning `Result<T, ErrorCode>`; no component calls `window.api` directly.

---

## 15. Copy

### 15.1 Voice rules

- Plain verbs, sentence case, no exclamation marks, no "please", no "sorry", no "oops". Errors state what happened and the one thing to do.
- The app says "the agent" for itself and "the AI" for the model; never "I", never "we" except in "We could not confirm this" (architecture wording).
- Name things by what the user sees: "AI on this computer" not "local LLM"; "key file" not "OAuth client credentials"; "WhatsApp component" not "bridge"; "Standard model" not "E4B Q4_K_M".
- An action keeps its name through the flow: button "Approve & send" -> progress "Sending..." -> result "Sent". "Add to calendar" -> "Adding..." -> "Added to calendar". "Dismiss" -> "Dismissed".
- Hebrew: buttons are action nouns (אישור ושליחה, הוספה ליומן, העתקה); instructions use the plural imperative (סרקו, לחצו, בחרו), which is also gender-neutral; no niqqud; Hebrew punctuation with maqaf-free simple hyphens; product and vendor names stay in Latin script (WhatsApp may be written וואטסאפ in running text, Google / Claude / Gemini stay Latin).
- Interpolated untrusted values are always wrapped: `"Sent to <bdi>{{name}}</bdi>"` through the `Trans` component - never string concatenation.

### 15.2 Core strings

| Key | en | he |
|---|---|---|
| `list.needs_reply` | Needs reply | ממתינות לתשובה |
| `list.in_calendar` | In calendar | ביומן |
| `list.info_missing` | Information missing | חסרים פרטים |
| `list.analysing` (plural) | Analysing {{count}} chat(s)... | מנתח שיחה אחת... / מנתח {{count}} שיחות... |
| `list.latestOf` | Showing the latest 20 of {{count}} | מוצגות 20 האחרונות מתוך {{count}} |
| `card.draftLabel` | Draft reply | טיוטת תשובה |
| `card.ownLabel` | Your reply | התשובה שלך |
| `card.sendsTo` | Sends to <bdi>{{name}}</bdi>, <bdi dir="ltr">{{phone}}</bdi> | יישלח אל <bdi>{{name}}</bdi>, <bdi dir="ltr">{{phone}}</bdi> |
| `action.approveSend` | Approve & send | אישור ושליחה |
| `action.sending` | Sending... | שולח... |
| `action.sent` | Sent | נשלח |
| `action.addToCalendar` | Add to calendar | הוספה ליומן |
| `action.adding` | Adding... | מוסיף... |
| `action.added` | Added to calendar | נוסף ליומן |
| `action.askDetails` | Ask for details | בקשת פרטים |
| `action.edit` | Edit | עריכה |
| `action.copy` / `action.copied` | Copy / Copied | העתקה / הועתק |
| `action.copyReply` | Copy reply | העתקת התשובה |
| `action.dismiss` / `action.dismissed` | Dismiss / Dismissed | התעלמות / הוסר מהרשימה |
| `action.undo` | Undo | ביטול |
| `action.openInCalendar` | Open in calendar | פתיחה ביומן |
| `action.analyseChat` | Analyse this chat | ניתוח השיחה |
| `action.analyseAgain` | Analyse again | ניתוח מחדש |
| `action.resetSuggestion` | Reset to suggestion | חזרה להצעה |
| `action.addAnyway` / `action.createAnyway` / `action.sendAgain` | Add anyway / Create anyway / Send again | הוספה בכל זאת / יצירה בכל זאת / שליחה נוספת |
| `card.changed` | This card changed - review again. | הכרטיס השתנה - כדאי לעבור עליו שוב. |
| `card.unknownOutcome` | We could not confirm this - check WhatsApp. | לא הצלחנו לוודא שזה בוצע - כדאי לבדוק בוואטסאפ. |
| `card.lidCopyOnly` | Number hidden by WhatsApp - copy only | המספר מוסתר על ידי וואטסאפ - העתקה בלבד |
| `event.noInvites` | No invitations are sent | לא נשלחות הזמנות |
| `missing.date/time/duration/location/who/confirmation` | day / time / length / place / who / confirmation | יום / שעה / משך / מקום / עם מי / אישור |
| `health.ok/working/attention/paused` | All running / Working on it / Needs attention / Paused | הכול פועל / עובד על זה / דרוש טיפול / מושהה |
| `header.pause` / `header.resume` | Pause / Resume | השהיה / המשך |
| `footer.ignored` | Ignored ({{count}}) | לא רלוונטי ({{count}}) |
| `welcome.promise` | Nothing is sent or scheduled without your approval. | שום דבר לא נשלח ולא נקבע בלי אישור שלך. |
| `welcome.start` | Get started | מתחילים |
| `ai.local.name` / `.privacy` | On this computer / Your messages never leave this computer. | במחשב הזה / ההודעות שלך לא יוצאות מהמחשב. |
| `ai.cloud.privacy` | The chat being analysed is sent to {{vendor}} - without names or phone numbers. | השיחה שמנותחת נשלחת אל {{vendor}} - בלי שמות ובלי מספרי טלפון. |
| `pair.title` | Link your WhatsApp | קישור הוואטסאפ |
| `pair.connected` | Connected. Older messages are ignored - the agent starts from now. | מחובר. הודעות ישנות לא נקראות - הסוכן מתחיל מעכשיו. |
| `google.intro.later` | Later - replies only | אחר כך - תשובות בלבד |
| `tray.open/settings/quit` | Open / Settings / Quit | פתיחה / הגדרות / יציאה |
| `tray.pause/resume` | Pause processing / Resume processing | השהיית הסוכן / המשך פעולה |

Lane 13 owns both locale files and extends this table; lane 14 hands over its keys through the orchestrator. Hebrew plural forms follow i18next v4 JSON plurals (`_one`, `_two`, `_many`, `_other`).

---

## 16. Acceptance checklist for lanes 13 / 14 (jsdom + Playwright hooks)

1. No physical direction utilities or properties in `src/renderer/**` (ESLint rule + a grep test over built CSS for `margin-left|padding-right|left:|right:` outside `@supports` shims).
2. RTL snapshot: `dir="rtl"` render of Dashboard, sheet, each onboarding step and Settings; assertions on `getComputedStyle(...).direction` of `msg-text` nodes with English content = `ltr` inside an RTL page.
3. Every approval button's click sends exactly one `action:approve` with the `shownHash` from the VM it rendered; a second synchronous click sends nothing. No code path calls `action:approve` from `useEffect`, a timer, a toast or a keyboard shortcut other than Enter/Space on the focused button.
4. A dirty card is not replaced on `dashboard:changed` (test: type, push a changed VM, assert textarea value unchanged and the "card changed" notice appears after blur).
5. Untrusted strings (`displayName`, `trigger.text`, `draft.text`, `event.title`, `event.location`) appear only inside `QuotedBubble`, `DraftBox`, the `EventChip`/`EventEditor` title and location nodes, the card/sheet header name, and `<bdi>` interpolations; never in `document.title`, toasts, `aria-live` text other than the name in "Sent to <name>", or attributes other than `aria-label` of the card. No `dangerouslySetInnerHTML`.
6. `data-testid` contract for e2e: `list-<ListKey>`, `card-<itemId>`, `approve-send-<itemId>`, `approve-event-<itemId>`, `draft-<itemId>`, `copy-<itemId>`, `dismiss-<itemId>`, `health-pill`, `health-row-<part>`, `download-pill`, `setup-strip-<task>`, `lang-toggle`, `pause-toggle`, `qr-image`, `coach-mark`, `onboarding-step-<n>`.
7. axe-core (dev dependency is **not** in the pinned list - so: `@testing-library` role queries + a manual Narrator/NVDA pass are the gate; see concern C7).
8. Light/dark/forced-colors screenshots of the dashboard and sheet in both languages reviewed by a human once before release.
9. Window: at 420 x 560 nothing overflows horizontally in either language; at 980 x 680 three columns are visible with no horizontal scrollbar; zoom 200 % engages the one-column layout.

---

## 17. Architecture concerns

The spec above follows `ARCHITECTURE.md` in every case. These are the points where it is silent, internally inconsistent, or where the brief and the architecture differ. None was resolved by deviating.

| # | Concern | What this spec does | Suggested fix (for the orchestrator) |
|---|---|---|---|
| C1 | **Raw cards offer "Send" but have no action row.** Section 6.1 says held/failed items are raw cards with "Send/Copy", yet `actions` rows are only inserted in S4 (6.5) and `action:approve` requires an existing `actionId` + `shownHash`. There is no IPC to create a user-authored send. | `RawCard` renders "Send" only when `item.actions` contains a pending `send_reply`; otherwise it is copy-only with the disabled-reason line. | Have S0 mint a pending `send_reply` action with empty canonical text for held/failed items on sendable chats (the user's `edit:{text}` supplies the body; all I1/I3 checks still apply), or document raw cards as copy-only. |
| C2 | **"Fill the mini-form and press Add to calendar without another LLM turn" (section 7) has no action to approve.** `create_event` actions are inserted only when `event_state='proposed'`; an `incomplete` item has none, and `edit` cannot be sent without an `actionId`. | The button is enabled only if a pending `create_event` action exists. | Insert a pending `create_event` action for `incomplete` items too (canonical JSON with empty fields; executor sanity checks already reject incomplete events unless `edit` completes them), or add `item:completeEvent {itemId, title, startLocal, endLocal, location}` that creates the action in main. |
| C3 | **No IPC returns the ignored items.** `dashboard:get` returns "three lists + counts + ignored count"; `IgnoredDrawer` and `item:restore` need the list. | Drawer specified; data source unspecified. | `[R2]` Resolved: `dashboard:getIgnored` returns the last 20 dismissed items only ("Undo dismiss"). |
| C4 | **No IPC lists chats with a non-default policy** although Settings must show "per-chat policies" (12.2) and the brief asks for "ignored chats". | Settings row specified against a hypothetical `chat:listPolicies`. | Add `chat:listPolicies` returning `{chatRef, displayName, policy}[]`. |
| C5 | **Onboarding order differs from the brief.** The brief lists language -> pair WhatsApp -> choose LLM -> Google; the architecture (12.1) fixes Welcome -> Choose AI -> Link WhatsApp -> Google so the download runs in the background. | Architecture order used. | None needed; recorded so the user is not surprised. |
| C6 | **Window size.** The brief suggests ~960 x 640; architecture 15.1 fixes 980 x 680 / min 420 x 560. | Architecture values used. | None. |
| C7 | **No automated accessibility checker in the pinned dependency list** (`axe-core`/`@axe-core/playwright` absent, additions forbidden without a decision). | Role-based testing-library queries + manual screen-reader pass. | Consider adding `@axe-core/playwright` as a devDependency in a later decision. |
| C8 | **The component list has no file for shared primitives, the sheet, toasts or the coach mark.** | Primitives are CSS recipes in `styles.css`; the sheet lives in `Dashboard.tsx` (expanded `ItemCard`); toast, live regions and coach mark live in `App.tsx`. `styles.css` is shared by lanes 13 and 14 -> single owner (13). | Confirm lane 13 owns `styles.css`, `App.tsx` and both locale files; lane 14 submits keys/recipes through the orchestrator. |
| C9 | **First-close coach mark vs "close => hide".** Section 13 says close hides the window and shows an "in-window coach mark + toast"; an in-window coach mark cannot be seen in a hidden window. | `[R2]` RESOLVED: ARCHITECTURE 13 is the rule - every X hides at once; toast on the first hide; coach mark shown on the next open (12.2). | Lane 11: `preventDefault(); hide()` always; `app:ackTrayHint` only dismisses the mark. |
| C10 | **Send jitter (3-8 s) is invisible dead time and cannot be cancelled.** The write-ahead state is already `executing` while the executor waits, so the UI can only show "Sending...". | Spinner + explanatory line after 10 s. | Post-v1: apply the jitter in state `approved` and allow `action:reject` during it ("Undo send"), which would be a real safety gain for mis-clicks. |
| C11 | **`dashboard:get` payload carries draft text and message excerpts for up to 60 items** on every `dashboard:changed` (150 ms debounce). Fine functionally; noted because the renderer is the least trusted process and the payload is the largest privacy surface in it. | Accepted. | Optionally send the trigger excerpt (<= 280 chars) in lists and full text only via `item:get`. |
| C12 | **Theme.** The settings schema has no theme key, so dark mode can only follow Windows. | System-only theming. | None for v1. |
| C13 | **`DISK_FULL` action "Free up X GB"** needs a target; `external:open` takes only enum targets from `links.json`, and `ms-settings:storagesense` is not an https URL. | Spec marks it as an enum link. | Allow exactly one non-https entry (`ms-settings:storagesense`) in the enum table, or change the action to "Check again". |
