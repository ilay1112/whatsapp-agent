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
