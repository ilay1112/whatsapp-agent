# Context

## Original request (user, 2026-09-21)

Run a multi-agent (40+) operation to plan, build and test an independent WhatsApp AI agent that reads, replies and schedules appointments from WhatsApp directly to a Google Calendar.

GUI
1. Minimal, with a dashboard of latest "needs reply", "in calendar", "information missing".
2. Multilanguage option (Hebrew and English).
3. Can be minimized to "hidden icons" in Windows 11 upon clicking the X button.

Backend
1. WhatsApp bridge exactly like `C:\Users\ilay1\Documents\minime\whatsapp-mcp\whatsapp-bridge\whatsapp-bridge.exe`.
2. LLM — 3 options: local, Claude and Gemini. Local comes ready to use (investigate the best local model for the job; must work on a laptop).
3. Google Calendar connectivity should run by the LLM via MCP to Google services.

For architecture and design refinements: prompt an option-selection dialog.

Follow-up instruction (2026-09-21): keep all context, notes, progress, tickets and thoughts in local MD files in the project folder.

## Locked decisions (from the option dialog)

| Topic | Choice | Note |
|---|---|---|
| App stack | Electron + TypeScript | recommended option |
| Autonomy | **Approval-first** | user chose this over the recommended "hybrid" — nothing is sent or booked without a click |
| Use case | **Personal assistant** | user chose this over the recommended configurable/business profile |
| Local LLM delivery | llama.cpp embedded, hardware-tiered GGUF downloaded on first run | recommended option; no Ollama |

## Environment facts

- Dev machine: Windows 11 Home, i7-14700F, 32 GB RAM, RTX 4060 (a desktop — the laptop target is weaker and is treated separately).
- No toolchains were present. Installed via winget on 2026-09-21 with user approval: Node.js LTS 24.19.0 (npm 11.17.0), Git 2.55.0. Go is NOT installed → bridge ships as the prebuilt exe, source vendored for reference.
- Shell PATH in agent sessions can be stale; prepend `C:\Program Files\nodejs;C:\Program Files\Git\cmd`.

## Reference bridge (facts gathered by the orchestrator)

- Fork `verygoodplugins/whatsapp-mcp` of `lharries/whatsapp-mcp`, MIT license. Go + whatsmeow.
- REST (default `:8080`): `/api/health`, `/api/pairing/status`, `/api/pairing/qr.png`, `/api/group/status`, `/api/group/participant-count`, `/api/media`, `/api/send`, `/api/react`, `/api/download`, `/api/typing`.
- Bearer token auth (`WHATSAPP_BRIDGE_TOKEN`, else generated `.bridge-token` next to the whatsmeow DB).
- Env: `WHATSAPP_BRIDGE_PORT`, `WEBHOOK_URL` (outgoing webhook for incoming messages), `FORWARD_SELF`, `WHATSAPP_MEDIA_ROOTS`. Flag: `--full-history-pair`.
- Two SQLite DBs: `whatsapp.db` (whatsmeow, opaque) and `messages.db` (bridge-owned).
- The reference `store/` dir contains the user's LIVE session and real messages → off-limits (see CLAUDE.md hard rules). The new app runs the exe with its own fresh store.
- Full contract: `docs/research/bridge-contract.md` (produced by workflow ①).

## v2 request (user, 2026-09-27)

1. U8 confirmed — **but the app must also EDIT events as conversations evolve**: "I scheduled a meeting at 3pm on Wednesday and later in the conversation I rescheduled to 5pm — the LLM should tell the app there is a change and edit the calendar event."
2. **Automatic mode in settings**: if the user doesn't want to approve every event, the app adds and edits events on Google Calendar automatically with no approval.
3. Commit approved → baseline commit made.
4. **Cloud LLMs must work on an existing subscription, not an API key.** For Gemini the user suggests the needed CLI may be Antigravity ("discontinued for the pro members" — to be verified by research). "Make sure the MCP for WhatsApp is well written as well for the calendar."
5. **Built-in Whisper** to transcribe voice messages, and the ability to **read events from pictures**.
6. All of the above researched, evaluated, planned and built with the multi-agent system as before.

### v2 option dialog (2026-09-27)

| Topic | Choice |
|---|---|
| Automatic mode scope | **Calendar add + edit only**; replies always stay drafts; cancellation marks the event cancelled, never deletes |
| Subscription cloud LLMs | **Vendor CLI as a completion backend** — the app keeps its verified pipeline + ToolGate + executor; the CLI is called headlessly; the app's read-only tools reach the CLI as a small MCP server |
| Voice + pictures | **Local audio always** (whisper.cpp); **pictures may use the active cloud provider's vision** when one is selected |
| WhatsApp MCP | **Read-only WhatsApp MCP** (search/read chats + messages, never send), same gating pattern as calendar |

## Remote repository (user, 2026-09-28)

"I created a remote repo for this project, upload and work remotely with this repo: https://github.com/ilay1112/whatsapp-agent.git — it's empty right now, needs a git ignore and a readme with all the app's info, features and instructions." The repo is public (GitHub API answers unauthenticated).

## Code signing request (user, 2026-10-04)

"After all tests make sure the app is signed for a clean pass at windows defender." Option dialogs: licence **MIT**; certificate route first "self-signed, this PC only", then — after the orchestrator found **Smart App Control is ON (enforcing)** on this PC and confirmed from Microsoft docs that SAC does not accept self-signed/locally trusted certificates — **"Not now"**: ship unsigned, add an inactive signing pipeline + a Defender scan gate, ready for a Trusted Root Program certificate later.

Environment facts (read-only check 2026-10-04): Smart App Control state 1 (enforce); Defender AV normal mode, real-time on, signatures current; MpCmdRun.exe present.
