# WhatsApp Calendar Agent

A Windows 11 desktop app that watches **your own** WhatsApp chats for plans ("coffee Thursday at 5?"), drafts a reply and a Google Calendar event, and **waits for you to click**. It speaks Hebrew and English, runs its AI on your PC by default, and lives in the Windows tray.

| | |
|---|---|
| **Status** | **v0.1.0 — built and verified** (lint, typecheck, 3,837 unit/integration/security tests, 22/22 end-to-end tests, packaged smoke test, dependency audit: all green). **v2 — in development** (see [Roadmap](#roadmap-v2-in-development)). |
| **Platform** | Windows 11 x64 |
| **Stack** | Electron 44 + TypeScript, React 19, Tailwind 4, `node:sqlite`, llama.cpp, Model Context Protocol (MCP) |
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
- [Roadmap (v2, in development)](#roadmap-v2-in-development)
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

### Three AI options

| Option | Where it runs | Notes |
|---|---|---|
| **On this computer** (default) | Your PC, via llama.cpp | Ready to use: on first run the app detects your RAM/GPU and downloads a model (SHA-256 verified). **Gemma 4 E2B** (~3.1 GB, under 12 GB RAM), **Gemma 4 E4B** (~5.0 GB, typical laptop), **Gemma 4 12B** (~6.7 GB, dedicated GPU with ≥ 7.5 GB VRAM or ≥ 30 GB RAM). Nothing leaves your PC. |
| **Claude** | Anthropic API | Your API key, stored encrypted with Windows DPAPI. Blocking consent screen before first use. |
| **Gemini** | Google API | Your API key, stored encrypted. Blocking consent screen, including the free-tier training warning. |

There is **never** a silent fallback from one provider to another. Dates and times are **never** computed by the model — "Thursday at 5" is resolved by plain TypeScript against your clock, and anything ambiguous gets a visible badge.

### Google Calendar through MCP

- The app is an **MCP client** of a bundled Google Calendar MCP server (`@cocal/google-calendar-mcp`, run on the app's own Node runtime — no separate install).
- The **AI** gets only **read** tools through MCP: the current time and your free/busy slots — never other events' titles.
- **Writing** (`create-event`) is done by the app itself, through the same MCP client, **only after your click**. Events are created without attendees and without sending invitations, and are tagged so the app recognises its own events.
- Uses **your own** Google Cloud project and OAuth client — no server of ours is involved.

### Approval-first, enforced in code

Nothing is sent to WhatsApp and nothing is written to your calendar without an approval record created by your click. This is enforced by code structure (only one executor module holds the send/write clients, and a build-failing import rule keeps it that way), by a SQLite trigger, by binding each approval to a hash of exactly what you saw, and by a test that feeds a deliberately *malicious* AI model a corpus of prompt-injection attacks and proves zero side effects.

---

## How it works

```text
 WhatsApp (your phone)
        | linked device
        v
 whatsapp-bridge.exe --> messages.db (read-only for the app) --> deterministic filter (DMs, known contacts)
                                                                        |
                                                                        v
      S1 extract (JSON, no tools) -> S2 resolve dates (TypeScript) -> S3 draft reply (read-only calendar tools via MCP)
                                                                        |
                                                                        v
                                                     card on the dashboard  -->  YOUR CLICK
                                                                        |
                                              +-------------------------+-------------------------+
                                              v                                                   v
                                bridge /api/send (reply)                          calendar MCP create-event
```

Three managed child processes run under one supervisor (bridge, calendar MCP server, llama-server). Each is restarted with backoff, killed by PID only, and reaped by PID + path + start time after a crash. Untrusted text (messages, tool results, model output) never enters a system prompt, a log line, the tray tooltip or the window title.

Full design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (v1) and [`docs/ARCHITECTURE-v2.md`](docs/ARCHITECTURE-v2.md) (v2 amendment set).

---

## Privacy: what leaves your PC

| Data | Where it goes | When |
|---|---|---|
| Your WhatsApp messages | **Nowhere** with the default *On this computer* AI. | — |
| Message text for a cloud AI | Anthropic or Google — only if you chose that provider, only after its consent screen, and only a minimised slice of one conversation, with role labels instead of names, numbers or chat IDs. | per analysed message |
| Your calendar | The AI sees only busy/free times ("busy 15:00–16:00"), never other events' titles. Events are written by the app only after your click. | per analysed message / per approval |
| Google credentials | Stay on your PC, in your user profile. Your own Google Cloud project. | — |
| Model downloads | HTTPS from Hugging Face, pinned by SHA-256. | when you pick a local model |
| Anything else | **No** analytics, **no** crash reporting, **no** update check, **no** account. | never |

Message snapshots and drafts are kept for 30 days, then deleted.

---

## Requirements

- **Windows 11 x64.** 8 GB RAM minimum, 16 GB recommended; a dedicated GPU helps but is not required.
- **Disk:** about 0.5 GB for the app plus 3–7 GB for a local model.
- **WhatsApp** on your phone with one free *linked device* slot (WhatsApp allows up to four).
- **For calendar features:** a Google account and about 5 minutes to create your own Google Cloud OAuth client (the app walks you through it).
- **Optional:** a Claude or Gemini API key if you prefer a cloud AI.
- **To build from source:** Node.js 24+ and Git.

---

## Getting started

There is no published installer yet — [build it](#building-from-source), then run the app. On first launch a short wizard (resumable, with the language toggle always visible) takes you through five steps:

1. **Welcome** — pick Hebrew or English and read/accept the WhatsApp account-risk disclosure.
2. **Choose your AI** — *On this computer* (the app shows what it detected on your PC and starts the model download in the background), or Claude / Gemini (consent screen, then paste your API key — it is checked live).
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
- Badges mark anything the app assumed ("at 5" → 17:00), a clash with your calendar, or text that looks like it is trying to manipulate the AI (that draft is collapsed behind *show anyway*).
- **Pause** the agent from the header or the tray at any time. The status pill shows WhatsApp / AI / Calendar health, each with one action when something is wrong.
- **Settings:** language, AI provider and model, WhatsApp re-link / unlink, Google Calendar and target calendar, per-chat rules (for example *never analyse this chat*), notifications, *Start with Windows*, data retention, *purge now*, export diagnostics (metadata only), licences.

---

## Roadmap (v2, in development)

v2 is designed and being built as an amendment set over v1 — see [`docs/ARCHITECTURE-v2.md`](docs/ARCHITECTURE-v2.md) and the decisions log [`ops/DECISIONS.md`](ops/DECISIONS.md) (D-036 to D-072). **Nothing in this section is in v0.1.0 yet.**

- **Events that follow the conversation** — "let's push it to 5" becomes a change card (*Wed 15:00 → 17:00*: **Approve change** / **Keep**); a cancellation marks the event cancelled, never deleted. Every change has **one-click undo**, and the previous version is stored before anything is written.
- **Automatic mode** (off by default) — calendar **add and edit** without approval; WhatsApp replies **always** stay drafts you approve. Guard rails: it can be switched on only from a native confirmation dialog, after 3 events you approved yourself; it starts with a 24-hour trial that only shows what it *would* do; it renews every 30 days; it acts only in chats where you wrote within the last 24 hours; no automatic changes between 22:00 and 07:00; cancellations stay off unless you enable them; own calendar only, no attendees, daily caps; an Undo toast and an activity page for every automatic change. Events from voice notes and pictures join automatic mode once they pass an accuracy check on your machine.
- **Cloud AI on your subscription** — **Claude** through the Claude Code CLI you already have installed and signed in to, run headless and locked down (no file or shell tools — only the app's read-only tools). **Gemini** is possible only through the Antigravity CLI, so it is **opt-in and experimental**: Google's terms prohibit third-party tools and accounts have been suspended. The API-key providers stay as the supported fallback.
- **Read-only WhatsApp tools over MCP** — the AI can look up earlier messages of the same chat (never send), through the same gate as the calendar tools.
- **Voice notes** — transcribed **on your PC** with whisper.cpp and a Hebrew-specialised model (`ivrit-ai/whisper-large-v3-turbo`).
- **Events from pictures** — invitations, flyers and screenshots are read by the active cloud AI's vision, or by the local model.

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
npm run stage:mcp                          # installs the Google Calendar MCP server (npm ci --omit=dev --ignore-scripts)
node scripts/fetch-llama.mjs               # downloads the pinned llama.cpp b10964 Vulkan zip, verifies sha256, unpacks the allow-list
node scripts/smoke-packaged.notices.mjs    # regenerates resources/licenses/THIRD_PARTY_NOTICES.txt
```

The WhatsApp bridge binary is already in the repository (`resources/bridge/whatsapp-bridge.exe`, verified against `resources/bridge/SHA256SUMS`). `scripts/import-bridge.mjs` only exists to re-import it from a local bridge build.

**Microsoft Visual C++ runtime (optional).** The local AI server needs it. To ship it inside the app, point `VC_REDIST_CRT_DIR` at a `Microsoft.VC143.CRT` folder, run `node scripts/fetch-llama.mjs --pin-crt` once, review the recorded hashes, then re-run the staging commands. Leaving it unset is supported: the app detects a missing runtime and shows a specific error with a link to Microsoft's installer.

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
| `npm run test:smoke` | Builds an unpacked package and checks what actually ships (bridge hash, calendar server present, Electron fuses, no forbidden packages) |
| `npm run test:golden:live` | Opt-in accuracy check against a real model on your machine |
| `npm run audit:prod` | `npm audit` of the production dependencies |

The tests never run the real bridge, never contact WhatsApp, Google, Anthropic or any model API, and use only synthetic data.

---

## Project structure

```text
src/
  main/        Electron main process: supervisor, bridge, ingest, agent pipeline, LLM providers,
               MCP client, action executor, database, IPC, tray and window
  renderer/    React UI (dashboard, onboarding, settings)
  preload/     sandboxed, allow-listed IPC bridge
  shared/      contracts, types, schemas, en/he locales
tests/         integration, security, e2e, golden set, fakes (bridge, calendar MCP, scripted and attacker LLMs)
resources/     bridge exe + SHA256SUMS, icons, licences, external links
vendor/        whatsapp-bridge-src (Go source, reference only); llama.cpp is fetched here at build time
build-resources/calendar-mcp/   the pinned Google Calendar MCP server package
scripts/       import/hash bridge, fetch llama.cpp, stage the MCP server, pin models, icons, packaged smoke test
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
- **Nothing is code-signed.** Three unsigned executables (the app, the bridge, the model server) mean SmartScreen/Defender friction on first run.
- **No auto-update.**
- **The bridge is an opaque prebuilt binary.** Its Go source is vendored for reference, but when WhatsApp changes its protocol it will eventually fail with "client outdated" until a new build is supplied.
- **Google setup is fiddly**, and the bundled server asks for the full calendar scope although the app only reads busy/free and creates events.
- **v0.1.0 is create-only** — it never edits or deletes an existing event (editing arrives in v2).
- **One open item per chat** — two parallel topics in one conversation collapse into one card.
- **Local models are slow on a CPU-only laptop** (roughly 20–60 s per burst of messages).
- **Capability separation is module-level, not process-level.**
- **The last line of defence is you.** Approving without reading defeats every safeguard above.

Every fact not yet verified on real hardware, and the check that closes it, is listed in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) section 19.

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

---

## Manual real-world checklist

The automated suite proves the code does what the design says; it cannot prove the app works with **your** WhatsApp account, Google account and hardware. That takes the manual checks **M1–M16** (plus the v2 checks **M-CLI-1, M-AGY-1, M-CAL-1, M-VOICE-1 and M-GOLDEN-1**), listed with pass criteria in [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md). No automated agent may perform them. Record outcomes in `ops/PROGRESS.md` — never with a phone number, a token or real message text.

---

## Third-party components and licence

The installer ships the WhatsApp bridge (a fork of [`verygoodplugins/whatsapp-mcp`](https://github.com/verygoodplugins/whatsapp-mcp), itself a fork of `lharries/whatsapp-mcp`, MIT), llama.cpp `b10964` for Windows/Vulkan (MIT), the LLVM OpenMP runtime (Apache-2.0 with LLVM exception), the Google Calendar MCP server (MIT), Electron, and about 142 pure-JavaScript npm packages — **no native Node addon** anywhere. The full notices are in `resources/licenses/THIRD_PARTY_NOTICES.txt` and are installed alongside the app. Model weights are **not** shipped; you download them on request, under their own licences (Gemma: Apache-2.0).

This repository does not yet declare a licence for its own code.
