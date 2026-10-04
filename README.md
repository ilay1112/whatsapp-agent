# WhatsApp Calendar Agent

A Windows 11 desktop app that watches **your own** WhatsApp chats for plans ("coffee Thursday at 5?"), drafts a reply and a Google Calendar event, and **waits for you to click**. It follows the conversation when a plan changes, reads voice notes and pictures, speaks Hebrew and English, runs its AI on your PC by default, and lives in the Windows tray.

| | |
|---|---|
| **Status** | **v2 feature set built, not yet released** (package version still 0.1.0). The automated gates are recorded in [`ops/PROGRESS.md`](ops/PROGRESS.md); the release still waits for the [manual real-world checks](#manual-real-world-checklist), above all the accuracy gate **M-GOLDEN-1**. v0.1.0 (create-only) was the first verified build. |
| **Platform** | Windows 11 x64 |
| **Stack** | Electron 44 + TypeScript, React 19, Tailwind 4, `node:sqlite`, llama.cpp, whisper.cpp, Model Context Protocol (MCP) |
| **Releases** | No installer is published yet — [build it from source](#building-from-source). |

> **Account risk — read this first.** The app talks to WhatsApp through an *unofficial* linked-device client. That violates WhatsApp's terms of service regardless of how little you use it, and your account can be banned. This project is for personal use on your own account, with your eyes open. It is not affiliated with WhatsApp/Meta, Google or Anthropic.

---

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Privacy: what leaves your PC](#privacy-what-leaves-your-pc)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Daily use](#daily-use)
- [Roadmap](#roadmap)
- [Building from source](#building-from-source)
- [Tests and checks](#tests-and-checks)
- [Project structure](#project-structure)
- [How this project was built](#how-this-project-was-built)
- [Known, accepted weaknesses](#known-accepted-weaknesses)
- [Troubleshooting](#troubleshooting)
- [Manual real-world checklist](#manual-real-world-checklist)
- [Third-party components and licence](#third-party-components-and-licence)

---

## Features

### A minimal dashboard with three lists

- **Needs reply** — conversations where a reply is expected, with an AI-drafted answer you can edit.
- **In calendar** — plans that are on your Google Calendar (only after you approved them).
- **Information missing** — plans the app spotted but can't book yet (no time, no day…); the draft reply asks for what's missing.

Each card shows the original message, the proposed event (title, date, time, place) and the draft reply, with **Approve & send**, **Add to calendar**, **Edit**, **Ask for details** and **Dismiss** (*Undo dismiss* keeps the last 20).

### Events that follow the conversation

- When a chat changes a plan the app already put on your calendar ("let's push it to 5", "can we do Sunday instead?", "sorry, I can't make it"), the card becomes a **change card** — *Wed 15:00 → 17:00* with **Approve change** / **Keep**.
- A cancellation marks **the app's own event** as cancelled. Nothing is ever deleted: `delete-event` is not even enabled at the calendar server.
- The previous version is stored **before** anything is written, and every change has **Undo** (and *Restore original* after repeated changes). If you edited the event in Google yourself in the meantime, the app tells you instead of overwriting your edit.
- Only events the app created itself, with no attendees and no recurrence, are ever changed.

### Automatic mode (off by default)

Lets the app **add and change** calendar events without asking first. **WhatsApp replies always stay drafts you approve** — there is no automatic sending, ever.

- It can be switched on only from a native Windows confirmation dialog, and only after you approved at least **3** events yourself. It starts as a **24-hour trial** that only shows what it *would* have done (or *Turn on now* from the same dialog), and it **ends after 30 days** unless you renew it.
- It acts only in chats where **you** wrote within the last 24 hours, never between 22:00 and 07:00, only on your own calendar, never on events with attendees, with per-contact and daily caps. Changes must be at least 2 hours ahead; cancellations stay off unless you tick them.
- Every automatic change shows a notification with **Undo**, a strip on the dashboard and an entry on the *Automatic activity* page. It pauses itself after 7 days without you opening the window.
- Automatic *changes* to existing events, and events that came from a voice note or a picture, stay manual for each AI provider until that provider passed its accuracy check on your machine (release gate M-GOLDEN-1). Until then those proposals appear as normal cards.

### Hebrew and English

- Full Hebrew (RTL) and English UI, switchable at any time without a restart — including the tray menu, notifications and native dialogs.
- Replies are drafted in the **sender's** language, not the UI language.
- Names, phone numbers and times are bidi-isolated so mixed Hebrew/English text renders correctly. Dates use `he-IL` / `en-IL`, a 24-hour clock, weeks starting on Sunday, and `Asia/Jerusalem` by default.

### Lives in the Windows 11 tray

- Clicking **X** hides the window to the tray ("hidden icons"); the agent keeps working in the background. Quit only from the tray menu.
- Tray menu: Open · status · Pause/Resume agent · Settings · Quit. Single instance — launching it again re-shows the window.
- Optional *Start with Windows* (off by default; starts hidden).

### WhatsApp through your own bridge

- Uses the prebuilt Go/whatsmeow bridge (`resources/bridge/whatsapp-bridge.exe`, pinned by SHA-256 and re-checked before every launch) as a **linked device** of your phone — pair once by scanning a QR code.
- Runs with its **own** fresh session store, its own random port and token — it never touches another bridge you may already run on the same PC.
- **Direct chats only**: groups, broadcasts and status updates are ignored. Messages from people you have never written to are shown as a plain card and are **not** sent to the AI until you click *Analyse this chat*.
- After pairing it does not flood you with months of old history.
- **Read-only look-ups** — while drafting, the AI may look up earlier messages of the **same** chat through four read-only WhatsApp tools served by the app itself (never a send tool). Looking across all chats needs a separate, confirmed setting.

### AI options

| Option | Where it runs | Notes |
|---|---|---|
| **On this computer** (default) | Your PC, via llama.cpp | Ready to use: on first run the app detects your RAM/GPU and downloads a model (SHA-256 verified). **Gemma 4 E2B** (~3.1 GB, under 12 GB RAM), **Gemma 4 E4B** (~5.0 GB, typical laptop), **Gemma 4 12B** (~6.7 GB, dedicated GPU with ≥ 7.5 GB VRAM or ≥ 30 GB RAM). Nothing leaves your PC. |
| **Claude (your subscription)** | Anthropic, through the **Claude Code CLI** you installed and signed in to yourself | The app never installs, bundles or signs in to it; it only finds it and runs it headless and locked down — no file, shell or web tools, only the app's read-only tools, and a test run proves that before any message is sent. Paid extra usage stops by default. Blocking consent screen first. |
| **Antigravity CLI (experimental, opt-in)** | Google, through the Antigravity CLI if you installed it | Off unless you opt in. Google's terms prohibit third-party tools and accounts have been suspended — the consent screen says so. It gets **no** tools, its proposals are never automatic, and pictures go to the local model instead. |
| **Claude / Gemini API key** (under *Advanced*) | Anthropic API / Google API | Your API key, stored encrypted with Windows DPAPI. Blocking consent screen, including Gemini's free-tier training warning. The supported way to use Gemini. |

There is **never** a silent fallback from one provider to another. Dates and times are **never** computed by the model — "Thursday at 5" is resolved by plain TypeScript against your clock, and anything ambiguous gets a visible badge.

### Voice notes

- Transcribed **on your PC, always** — whatever AI provider you chose — with whisper.cpp (bundled, CPU) and a Hebrew-specialised model (`ivrit-ai/whisper-large-v3-turbo`, ~1.6 GB, downloaded on request and SHA-256 verified). A multilingual and a lighter tier are available in Settings. The audio never leaves your PC.
- The transcript is treated like any other message text: it shows inertly in a voice bubble on the card and can never act as an instruction. Notes longer than 15 minutes, or too slow for your PC, are refused with a clear message.

### Events from pictures

- Invitations, flyers and screenshots are read for a date, time and place — by the active cloud AI's vision (covered by its consent screen; can be switched off) or by the local model with its picture add-on.
- The picture reader has **no tools at all**. Text inside a picture is data, never an instruction; pictures that look like they try to steer the AI are flagged.
- Until the picture accuracy check (M-GOLDEN-1) has passed for your provider, every picture-derived proposal carries an amber *check the picture* badge and stays manual.

### Google Calendar through MCP

- The app is an **MCP client** of a bundled Google Calendar MCP server (`@cocal/google-calendar-mcp` 2.6.3, run on the app's own Node runtime — no separate install). The bundled copy carries a small, pinned **seven-insertion patch** so the app can change or cancel an event safely (a `cancelled` status, an `If-Match` guard and the event's `etag`); the build refuses any other server bytes.
- The **AI** gets only **read** tools through MCP: the current time and your free/busy slots — never other events' titles.
- **Writing** (`create-event`, `update-event`) is done by the app itself, through the same MCP client, **only** after your click or under an active automatic-mode policy. Events are created without attendees and without sending invitations, and are tagged so the app recognises its own events. `delete-event` is never enabled. If the server cannot prove it supports safe changes, only *changes* are switched off — adding events keeps working.
- Uses **your own** Google Cloud project and OAuth client — no server of ours is involved.

### Approval-first, enforced in code

Nothing is sent to WhatsApp and nothing is written to your calendar without an approval record — created by your click, or, for calendar writes only, by an automatic-mode policy you confirmed in a native dialog. This is enforced by code structure (only one executor module holds the send/write clients, and a build-failing import rule keeps it that way), by a SQLite trigger, by binding each approval to a hash of exactly what you saw, and by a test that feeds a deliberately *malicious* AI model a corpus of prompt-injection attacks (Hebrew and English, including voice transcripts, picture text and earlier messages) and proves zero side effects.

---

## How it works

```text
 WhatsApp (your phone)
        | linked device
        v
 whatsapp-bridge.exe --> messages.db (read-only for the app) --> deterministic filter (DMs, known contacts)
                                                                        |
                              voice note -> whisper-cli (local)  /  picture -> tool-less reader
                                                                        |
                                                                        v
      S1 extract (JSON, no tools) -> S2 resolve dates + changes (TypeScript) -> S3 draft reply (read-only tools)
                                                                        |
                                                                        v
                         card on the dashboard  -->  YOUR CLICK   (or, calendar only: automatic-mode policy)
                                                                        |
                                              +-------------------------+-------------------------+
                                              v                                                   v
                                bridge /api/send (reply)                 calendar MCP create-event / update-event
```

Three managed child processes run under one supervisor (bridge, calendar MCP server, llama-server); short-lived jobs (`whisper-cli`, the Claude or Antigravity CLI) run under the same spawn, PID and reaper rules. Each is restarted with backoff (supervised children), killed by PID only, and reaped by PID + path + start time after a crash. Untrusted text (messages, transcripts, picture text, tool results, CLI and model output) never enters a system prompt, a command line, a log line, the tray tooltip or the window title.

Full design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (v1) and [`docs/ARCHITECTURE-v2.md`](docs/ARCHITECTURE-v2.md) (v2 amendment set).

---

## Privacy: what leaves your PC

| Data | Where it goes | When |
|---|---|---|
| Your WhatsApp messages | **Nowhere** with the default *On this computer* AI. | — |
| Message text for a cloud AI | Anthropic or Google — only if you chose that provider (API key or your own CLI subscription), only after its consent screen, and only a minimised slice of one conversation, with role labels instead of names, numbers or chat IDs. Earlier messages of the same chat only when the AI looks them up through the read-only tools. | per analysed message |
| Voice notes | **Nowhere** — always transcribed on your PC. Only the transcript text is handled like a message. | — |
| Pictures | To the cloud AI you chose, if picture reading by the cloud is on (its consent screen covers it); otherwise read by the local model. | per picture that may hold a plan |
| Your calendar | The AI sees only busy/free times ("busy 15:00–16:00"), never other events' titles. Events are written by the app only after your click, or by automatic mode if you turned it on. | per analysed message / per approval |
| Google credentials | Stay on your PC, in your user profile. Your own Google Cloud project. | — |
| Model downloads | HTTPS from Hugging Face, pinned by commit and SHA-256 (language models, picture add-ons, speech models). | when you pick a local model or turn on voice notes |
| Anything else | **No** analytics, **no** crash reporting, **no** update check, **no** account. | never |

Message snapshots and drafts are kept for 30 days, then deleted.

---

## Requirements

- **Windows 11 x64.** 8 GB RAM minimum, 16 GB recommended; a dedicated GPU helps but is not required.
- **Disk:** about 0.5 GB for the app plus 3–7 GB for a local model, about 1.6 GB for the default Hebrew voice model, and 0.2–1 GB for the local picture add-on.
- **WhatsApp** on your phone with one free *linked device* slot (WhatsApp allows up to four).
- **For calendar features:** a Google account and about 5 minutes to create your own Google Cloud OAuth client (the app walks you through it).
- **Optional:** the Claude Code CLI, installed and signed in by you, to use your Claude subscription; or a Claude or Gemini API key.
- **To build from source:** Node.js 24+ and Git.

---

## Getting started

There is no published installer yet — [build it](#building-from-source), then run the app. On first launch a short wizard (resumable, with the language toggle always visible) takes you through five steps:

1. **Welcome** — pick Hebrew or English and read/accept the WhatsApp account-risk disclosure.
2. **Choose your AI** — *On this computer* (the app shows what it detected on your PC and starts the model download in the background), **Claude** through your installed Claude Code CLI (the app finds it, shows its sign-in state and runs a locked-down test before use), or — under *Advanced* — a Claude / Gemini API key (consent screen, then paste your key — it is checked live).
3. **Link WhatsApp** — on your phone open **WhatsApp → Settings → Linked devices → Link a device** and scan the QR code shown by the app. The code refreshes itself; use *New code* if it expires.
4. **Connect Google Calendar** — *Start* or *Later* (without it the app still drafts replies). The wizard walks you through:
   1. Create a Google Cloud project.
   2. Enable the **Google Calendar API**.
   3. Configure the OAuth consent screen as **External** and **Publish** it (otherwise Google expires your sign-in every 7 days).
   4. Create an **OAuth client ID** of type **Desktop app** and download its JSON.
   5. Drop the JSON file into the app and sign in. Google will warn *"Google hasn't verified this app"* — that is expected for your own project: choose **Advanced → Go to (your app)**. Windows may ask whether the app may use the network — **Cancel** or **Allow** both work.
5. **Ready** — a checklist of what is connected, where to find the app in the tray, and the *Start with Windows* toggle.

---

## Daily use

- New plans appear as cards within about a minute (a local AI on a CPU-only laptop takes roughly 20–60 s per burst of messages).
- **Edit** the draft reply or the event (title, date, time, place) before approving. Sending the reply and adding the event are two separate approvals.
- A **change card** shows *before → after* for an event that already exists; **Undo** reverts a change the app made to an event.
- Voice notes and pictures appear on the card as an inert bubble next to what the app read from them.
- Badges mark anything the app assumed ("at 5" → 17:00), a clash with your calendar, a picture worth double-checking, or text that looks like it is trying to manipulate the AI (that draft is collapsed behind *show anyway*).
- **Pause** the agent from the header or the tray at any time. The status pill shows WhatsApp / AI / Calendar health, each with one action when something is wrong.
- **Settings:** language, AI provider and model (incl. the Claude CLI connection), voice notes and the voice model, picture reading, automatic mode and its activity page, WhatsApp re-link / unlink and read-tool scope, Google Calendar and target calendar, per-chat rules (for example *never analyse this chat*), notifications, *Start with Windows*, data retention, *purge now*, export diagnostics (metadata only), licences.

---

## Roadmap

The v2 features above (events that follow the conversation, automatic mode, Claude on your subscription, the experimental Antigravity option, read-only WhatsApp look-ups, voice notes, events from pictures) are built — see [`docs/ARCHITECTURE-v2.md`](docs/ARCHITECTURE-v2.md) and the decisions log [`ops/DECISIONS.md`](ops/DECISIONS.md) (D-036 onwards). What is still ahead:

- **Release gates** — the user-run checks of the [manual checklist](#manual-real-world-checklist). In particular **M-GOLDEN-1** measures accuracy on your machine and decides when automatic changes and voice/picture-derived automatic events are allowed per provider; **M-AGY-1** decides whether the Antigravity option ships at all.
- **Deferred to v2.1** (each a ticket, D-057): more automatic-mode refinements (allow-list mode, re-trial after a provider change), read-only tools and pictures for the Antigravity CLI, a resident `whisper-server` for faster voice notes, two editable events per chat, title changes as change cards, more CLI path overrides, Electron / MCP SDK version bumps.
- **Not planned:** automatic WhatsApp replies, deleting events, bundling or installing any vendor CLI.

---

## Building from source

Requires Node.js 24+ and Windows 11 x64. The project path may contain spaces — always quote it.

```powershell
git clone https://github.com/ilay1112/whatsapp-agent.git
Set-Location -LiteralPath ".\whatsapp-agent"
npm ci
```

### One-time staging of the bundled third-party pieces

Each command owns the files it writes, so the order does not matter. None of them ever executes a downloaded binary.

```powershell
npm run stage:mcp                          # installs the Google Calendar MCP server (npm ci --omit=dev --ignore-scripts) and applies
                                           # the pinned seven-insertion patch (refuses any bundle whose sha256 is not the pinned one)
node scripts/fetch-llama.mjs               # downloads the pinned llama.cpp b10964 Vulkan zip, verifies sha256, unpacks the allow-list
npm run fetch:whisper                      # downloads the pinned whisper.cpp b5130 CPU zip, verifies size + sha256, unpacks the allow-list
node scripts/smoke-packaged.notices.mjs    # regenerates resources/licenses/THIRD_PARTY_NOTICES.txt
```

Maintainers only: `node scripts/pin-models.mjs` re-checks every model pin against the Hugging Face API (size, SHA-256, first four bytes — never a full download) and writes `vendor/models.pin.json`, which the packaged smoke test compares with the manifest the app ships.

The WhatsApp bridge binary is already in the repository (`resources/bridge/whatsapp-bridge.exe`, verified against `resources/bridge/SHA256SUMS`). `scripts/import-bridge.mjs` only exists to re-import it from a local bridge build.

**Microsoft Visual C++ runtime (optional).** The local AI server and the voice transcriber need it. To ship it inside the app, point `VC_REDIST_CRT_DIR` at a `Microsoft.VC143.CRT` folder, run `node scripts/fetch-llama.mjs --pin-crt` once, review the recorded hashes (copy the same three into `vendor/whisper.pin.json` — whisper gets its own copy in its own folder), then re-run the staging commands. Leaving it unset is supported: the app detects a missing runtime and shows a specific error with a link to Microsoft's installer.

### Run in development

```powershell
npx electron-vite dev
```

### Produce the installer

```powershell
npx electron-builder --win --x64
```

This writes `dist\WhatsAppCalendarAgent-Setup-<version>.exe`, a one-click per-user NSIS installer of about 200–240 MB. Nothing is code-signed yet, so expect a SmartScreen prompt.

---

## Tests and checks

| Command | What it runs |
|---|---|
| `npm run verify` | Everything below, in order — the release gate |
| `npm run lint` · `npm run typecheck` · `npm run format:check` | ESLint (including import-boundary rules), TypeScript, Prettier |
| `npm test` | Unit, renderer, integration and security suites (Vitest) |
| `npm run test:security` | The security gate: approval binding, a prompt-injection corpus (40+ cases, Hebrew and English) run against an "obedient attacker" model, the tool gate, redaction, crash recovery |
| `npm run test:e2e` | Playwright against the built app with a fake WhatsApp bridge, a fake calendar and a scripted AI — never real accounts |
| `npm run test:smoke` | Builds an unpacked package and checks what actually ships (bridge hash, the patched calendar server and its eight tools, Electron fuses, the whisper files and their hashes, the model manifest against its pins, no vendor CLI binary, the voice decoder, the licence notices, no forbidden packages) — never executing a bundled binary |
| `npm run test:golden:live` | Opt-in accuracy check against a real model on your machine |
| `npm run audit:prod` | `npm audit` of the production dependencies |

The tests never run the real bridge, the real Claude or Antigravity CLI, whisper or llama.cpp, never contact WhatsApp, Google, Anthropic or any model API, and use only synthetic data (fake CLIs, a fake transcriber and generated audio and pictures).

---

## Project structure

```text
src/
  main/        Electron main process: supervisor, jobs, bridge, ingest, media + voice, agent pipeline, LLM providers
               (local, CLI, API), MCP client + app-hosted read-only tool server, action executor, automatic mode,
               undo, database, IPC, tray and window
  renderer/    React UI (dashboard, onboarding, settings, automatic activity)
  preload/     sandboxed, allow-listed IPC bridge
  shared/      contracts, types, schemas, en/he locales
tests/         integration, security, e2e, golden sets, fakes (bridge, calendar MCP, Claude/Antigravity CLIs, whisper,
               scripted and attacker LLMs)
resources/     bridge exe + SHA256SUMS, icons, licences, external links
vendor/        whatsapp-bridge-src (Go source, reference only); pins for llama.cpp, whisper.cpp, the calendar server
               and its patch, and the models; llama.cpp and whisper.cpp are fetched here at build time
build-resources/calendar-mcp/   the pinned Google Calendar MCP server package
scripts/       import/hash bridge, fetch llama.cpp / whisper.cpp, stage + patch the MCP server, pin models, fixtures,
               icons, packaged smoke test
docs/          research, architecture, specs, acceptance report
ops/           context, decisions, progress log, ticket board, per-agent notes, workflow scripts
```

---

## How this project was built

The app was researched, designed, built and adversarially reviewed by a multi-agent operation (Claude Code workflows, 130+ agent runs), with every step recorded in this repository:

- **Research and design** — 10 research reports ([`docs/research/`](docs/research/)), three competing architecture proposals, a judged synthesis ([`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)), specs ([`docs/specs/`](docs/specs/)) and three adversarial design critics.
- **Build** — 21 packages with strict per-file ownership, built in parallel waves, then an audit and a fix round.
- **Review** — six adversarial code reviewers (approval-first, prompt injection, pipeline correctness, process lifecycle, data integrity, UX/i18n). Every finding went to an independent skeptic who tried to refute it: 45 raised, 38 confirmed, each fixed with a failing test written first.
- **Acceptance** — a hard-marked report against the original request: [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md).

The running record lives in [`ops/`](ops/): [`CONTEXT.md`](ops/CONTEXT.md) (the original request and locked decisions), [`DECISIONS.md`](ops/DECISIONS.md), [`PROGRESS.md`](ops/PROGRESS.md), [`BOARD.md`](ops/BOARD.md), and one ticket per work package in [`ops/tickets/`](ops/tickets/).

---

## Known, accepted weaknesses

These are real and deliberate. Read them before you install.

- **Other software running as you can read everything.** The WhatsApp session, the message database and your Google tokens sit in your user profile. Windows protects them from other *users*, not from a program you run yourself.
- **`runAsNode` is enabled.** The bundled calendar server needs the app's own binary to run as Node — a real hardening concession forced by that design.
- **Nothing is code-signed.** Four unsigned executables (the app, the bridge, the model server, the voice transcriber) mean SmartScreen/Defender friction on first run.
- **No auto-update.**
- **The bridge is an opaque prebuilt binary.** Its Go source is vendored for reference, but when WhatsApp changes its protocol it will eventually fail with "client outdated" until a new build is supplied.
- **Google setup is fiddly**, and the bundled server asks for the full calendar scope although the app only reads busy/free and creates or changes its own events.
- **The calendar server is a patched copy.** Seven small insertions to `@cocal/google-calendar-mcp` 2.6.3, pinned by SHA-256 before and after; a newer server needs the patch re-done.
- **Automatic mode trades a click for speed.** Even with its rails and Undo, an automatic change can be wrong; it is off by default for that reason.
- **CLI providers depend on the vendor's tool.** A Claude Code CLI update can change its behaviour; the app re-proves the locked-down setup on every run and stops instead of guessing. The Antigravity option may break the vendor's terms and can cost you the Google account.
- **One editable event per chat** — two parallel plans in one conversation collapse into one card.
- **Local models and voice transcription are slow on a CPU-only laptop** (roughly 20–60 s per burst of messages; a long voice note can take minutes).
- **Capability separation is module-level, not process-level.**
- **The last line of defence is you.** Approving without reading defeats every safeguard above.

Every fact not yet verified on real hardware, and the check that closes it, is listed in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) section 19 and [`docs/ARCHITECTURE-v2.md`](docs/ARCHITECTURE-v2.md) section 16.

---

## Troubleshooting

| Symptom | What to do |
|---|---|
| SmartScreen or Defender warns about the app or `whatsapp-bridge.exe` | Expected — nothing is signed yet. Check the bridge against `resources/bridge/SHA256SUMS`. |
| "Install Microsoft runtime" error for the local AI | Install the Microsoft Visual C++ 2015–2022 x64 Redistributable (the error's button opens Microsoft's page), or build with `VC_REDIST_CRT_DIR` set. |
| The QR code never appears | Check the status pill, and make sure your phone has a free linked-device slot (WhatsApp → Settings → Linked devices). |
| Google sign-in expires after 7 days | Your OAuth consent screen is still in *Testing* — **Publish** it. |
| A Windows Firewall prompt during Google sign-in | Expected on the first sign-in; *Cancel* and *Allow* both work. |
| "Client outdated" | WhatsApp changed its protocol; the bridge binary needs a newer build. |
| No card appears for a new contact | By design: people you have never written to are held until you click *Analyse this chat*. |
| "Changes to events are unavailable (component version)" | The calendar server copy is not the patched one — re-run `npm run stage:mcp` and rebuild. Adding events keeps working. |
| The Claude CLI is not found or not signed in | Install it and sign in yourself (the Connect card shows the vendor's command and docs link), then run the connection test again; or point Settings at its exe. |
| A voice note says it is too long for this PC | Switch to the *Lite* voice model in Settings, or read the note yourself. |

---

## Manual real-world checklist

The automated suite proves the code does what the design says; it cannot prove the app works with **your** WhatsApp account, Google account and hardware. That takes the manual checks **M1–M16** plus the v2 checks below, listed with pass criteria in [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md). No automated agent may perform them. Record outcomes in `ops/PROGRESS.md` — never with a phone number, a token or real message text.

| v2 check | What you do |
|---|---|
| **M-CLI-1** | Run the app once with your own signed-in Claude Code CLI against the fake WhatsApp data, and confirm the locked-down setup (no tools beyond the app's, no memory or connectors leaking in). |
| **M-IMG-1** / **M-IMG-1b** | One test picture through the Claude CLI with no tools; the Antigravity picture path is recorded for information only. |
| **M-IMG-2** | The packaged local model with its picture add-on reads one test picture. |
| **M-AGY-1** | Only if you install the Antigravity CLI: the no-tools run, the isolated profile and no MCP child — the release gate for that option. |
| **M-VOICE-1** | Record one Hebrew test sentence yourself and run the voice accuracy check; decides the default voice model. |
| **M-AUTO-1** | On a clean Windows 11 machine, the **Undo** / **Show** buttons of an automatic-change notification work. |
| **M-CAL-1** | Change, cancel and restore a dummy event in a **test** calendar through the patched server. |
| **M-MEDIA-1** | First supervised launch: a history-synced voice note and a live picture are both served by the bridge. |
| **M-GOLDEN-1** | **Release gate:** run `npm run test:golden:live` for `--feature v1`, `edits`, `images` (local and Claude CLI) and `voice`; the results are recorded as the decision that may turn on automatic changes and voice/picture-derived automatic events per provider. |

---

## Third-party components and licence

The installer ships the WhatsApp bridge (a fork of [`verygoodplugins/whatsapp-mcp`](https://github.com/verygoodplugins/whatsapp-mcp), itself a fork of `lharries/whatsapp-mcp`, MIT), llama.cpp `b10964` for Windows/Vulkan (MIT), whisper.cpp `b5130` for Windows x64 CPU (MIT), the LLVM OpenMP runtime (Apache-2.0 with LLVM exception), the Google Calendar MCP server (MIT; shipped with the documented seven-insertion modification), the `opus-decoder` voice decoder chain (MIT / Apache-2.0) with libopus compiled to WebAssembly inside it (BSD-3-Clause, royalty-free patent licences), Electron, and about 146 pure-JavaScript npm packages — **no native Node addon** anywhere, and **no vendor CLI** (Claude Code and Antigravity are never bundled). The full notices are in `resources/licenses/THIRD_PARTY_NOTICES.txt` and are installed alongside the app. Model weights are **not** shipped; you download them on request, under their own licences (Gemma and its picture add-ons: Apache-2.0 with the Gemma terms; ivrit-ai Hebrew Whisper: Apache-2.0; OpenAI Whisper: MIT; Silero VAD: MIT).

This repository does not yet declare a licence for its own code.
