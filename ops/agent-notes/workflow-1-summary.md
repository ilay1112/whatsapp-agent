# Workflow ① — research findings digest (orchestrator back-fill)

Run `wf_1004b6e0-b2d`. The 10 research agents and 3 proposal agents started before `CLAUDE.md` existed, so they wrote no per-agent notes. This file consolidates what they returned. Full reports: `docs/research/*.md`, proposals: `docs/proposals/*.md`.

Everything marked UNVERIFIED below was flagged so by the agents themselves; none of it has been checked by running anything.

## bridge-contract
- Ship the exact prebuilt exe: 43,540,541 bytes, SHA-256 `AC23221E8BCF3937A4CA346B3BD80A8DA09DF94CBECD949AF2916C4BC8D22FF5`, go1.26.5, CGO on. It is a **locally modified** build (`vcs.modified=true`) of verygoodplugins/whatsapp-mcp 0.4.1 — `/api/pairing/status` and `/api/pairing/qr.png` do not exist upstream. So "exactly like this one" really does mean *this binary*.
- Store path is hard-coded **cwd-relative `store/`** (no flag/env) → spawn with `cwd=<userData>\bridge`.
- Must ALWAYS set: `WHATSAPP_BRIDGE_PORT` (free port, never 8080 — the user's live bridge uses it; on bind failure the bridge keeps running silently without REST), `WHATSAPP_BRIDGE_TOKEN` (host-generated), `WEBHOOK_URL` (else it POSTs the user's messages to the default `localhost:8769` receiver of their other system), `FORWARD_SELF=true`, `WHATSAPP_MEDIA_ROOTS`. Host must refuse to spawn without all of them and assert cwd is inside userData.
- No REST read API: read `<userData>\bridge\store\messages.db` read-only; webhook is only a doorbell (no message id/timestamp for text, no retry, synchronous — answer 200 instantly). DB catch-up scans mandatory.
- History sync after pairing dumps months of messages with no webhooks → gate on pairedAt / recent window or "Needs reply" floods.
- Pairing states: `connecting|qr_pending|connected|timeout|error`. Process always exits 0; shutdown = hard kill; needs PID-file orphan reaping.
- Don't send documents via this build (Windows filename bug). `/api/typing` and `/api/react` are visible side effects → never automatic.
- Needs one free linked-device slot (max 4; the existing bridge holds one). Bridge auto-downloads all media, no retention → janitor needed.
- UNVERIFIED: exe ⇔ source byte equivalence; messages.db timestamp text format; QR lifetime; no extra DLLs needed.

## local-model-small (8–16 GB CPU-only laptops)
- Pick: **Gemma 4 E4B-it** Q4_K_M (4.98 GB, Apache 2.0), `unsloth/gemma-4-E4B-it-GGUF`. <12 GB RAM → **Gemma 4 E2B-it** (3.11 GB). Fallback family: Qwen3.5-4B (2.74 GB).
- No published Hebrew benchmark for any candidate — pick rests on Gemma lineage. A Hebrew/English golden-set bake-off is required before locking.
- Thinking off; force JSON by grammar/json_schema, not template tool-call parsers; **never let the model do date arithmetic** — inject a pre-computed weekday table and resolve in TypeScript. Pin HF commit + sha256 (not retrieved yet).

## local-model-mid (GPU ≥6–8 GB VRAM or 32 GB RAM)
- Pick: **Gemma 4 12B-it** QAT UD-Q4_K_XL (6.72 GB), alternate plain Q4_K_M (7.12 GB). Fallback Qwen3.5-9B (5.68 GB). DictaLM-3.0-Nemotron-12B only as optional experimental (NVIDIA license).
- Tiering (first match wins): free disk <12 GB → small; dedicated VRAM ≥7.5 GB & RAM ≥15 → mid full offload; VRAM 5.5–7.5 → mid partial; no dGPU & RAM ≥30 → mid on CPU; else small. Never count iGPU shared memory. Post-load micro-benchmark; suggest (never auto) downgrade under 5 tok/s.

## llama-runtime
- Recommends official **`llama-server.exe` (Vulkan x64 zip, pinned build + sha256) as a child process** over OpenAI-compatible HTTP on 127.0.0.1, NOT node-llama-cpp. One zip covers CPU and iGPU/dGPU; no native-addon/asar pain. Own GGUF downloader: Range resume to `.part`, sha256 verify, atomic rename.
- Risks: Intel iGPU Vulkan garbage-output bugs → post-load self-test + CPU fallback + "Hardware acceleration Auto/Off" setting; unsigned exe AV friction; VC++ runtime and Hebrew-path handling UNVERIFIED.

## calendar-mcp
- **`@cocal/google-calendar-mcp@2.6.3`** (nspady, MIT), shipped as an isolated extraResources dir, spawned over stdio with Electron's own binary (`ELECTRON_RUN_AS_NODE=1`), `@modelcontextprotocol/sdk@1.30.0`.
- READ (LLM may call): list-calendars, list-events, search-events, get-event, get-freebusy, get-current-time. WRITE (app only, after Approve): create-event, update-event. delete-event etc. disabled at the server via `ENABLED_TOOLS`.
- Unavoidable user setup: own Google Cloud project + Desktop OAuth client, publish consent screen to "In production" (else tokens die every 7 days). 5-step in-app wizard. Google's official remote Calendar MCP is preview / Workspace-only → not v1.
- googleapis is ~200 MB unpacked. Tokens are plain JSON on disk.

## claude-provider / gemini-provider
- Claude: `@anthropic-ai/sdk`, **manual tool loop** — the SDK's MCP helper + tool runner auto-executes tools and would break approval-first. Opaque `providerData` to replay thinking blocks. Model list from `models.list()`, no hard-coded ids. Validate key with `models.retrieve`.
- Gemini: `@google/genai` pinned `~2.23.0`, manual loop, **never `mcpToTool()`** (auto-executes). Schema sanitizer + re-validate args with ajv. `store:false` always. Free tier = Google may train on prompts → explicit consent warning.
- Both: a run finishes on the provider that started it.

## electron-stack
- electron 44.x, electron-vite 5 + vite 7 (npm `latest` tags for vite/vitest/typescript are traps — pin exact), React 19, zustand, tailwind 4 logical utilities, electron-builder NSIS. **`node:sqlite`** instead of better-sqlite3 → no native rebuild. safeStorage for keys. Tray: intercept `close` → hide, `isQuitting` flag, single-instance lock, autostart `--hidden`. Electron-free ProcessSupervisor with backoff + orphan reaper. vitest + Playwright `_electron`.

## i18n-rtl
- i18next + react-i18next, two bundled JSON files shared by renderer and main (tray/dialogs). CSS logical properties only; `dir="auto"` on message text, `<bdi>` for names/phones/times. Segoe UI default. `he-IL`, h23, Asia/Jerusalem, Sunday week start. Reply language = **sender's** language by Hebrew-vs-Latin script counting. Starter en/he key sets are in the report (Hebrew not yet reviewed by a native reader → user should skim it).

## security-threat-model
- Assume the LLM is attacker-controlled after reading any message. Default-deny READ allowlist in code; LLM output is only a strict JSON proposal with **no recipient/attendee/calendarId fields**; an LLM-free ActionExecutor runs only after a click bound to an action id + content hash; recipient pinned to the source chat JID; events attendee-less in v1; rate limits; consent screen before cloud providers; exe hash check before each spawn; webhook on 127.0.0.1 random port + secret path + token.

## Conflicts between reports the synthesis must settle
| # | Conflict | Orchestrator lean |
|---|---|---|
| C1 | RunAsNode fuse: calendar-mcp needs it ON to spawn the Node MCP server; security wants it OFF | ON for v1 (simplest, works without Node installed) + packaging test; revisit utilityProcess later |
| C2 | Runtime: llama-runtime says llama-server.exe child; security/electron reports assumed node-llama-cpp | llama-server.exe (no native addon, newest model templates) |
| C3 | READ allowlist breadth: security wants 3 tools with app-pinned args; calendar-mcp lists 6 | start narrow (time, freebusy, list-events), widen only if needed |
| C4 | Structured output: provider-native JSON schema vs one portable forced tool | per-provider native behind one `LlmProvider.extract()` |

## Process incidents (disclosed)
- The bridge-contract agent's first directory glob was not scoped to source files and returned file *names* from the forbidden `store\` directory. Nothing was opened, copied or written into any doc.
- The orchestrator's own initial scouting command (before the rule was written) also listed the names in that directory. Same: names only, nothing opened or copied, nothing recorded in project files. The rule now lives in `CLAUDE.md` and every agent prompt.
