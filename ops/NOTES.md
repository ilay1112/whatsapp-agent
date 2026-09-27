# Orchestrator notes, thoughts, risks, open questions

## Thinking behind the plan

- **Why the app is the MCP client, not the LLM vendor.** The requirement says calendar connectivity runs "by the LLM MCP to Google services". With three interchangeable providers (one of them a local GGUF), the only uniform way is: the app hosts an MCP client, lists the calendar server's tools, and hands them to whichever provider is active as function-calling tools. Vendor-side MCP connectors (e.g. Claude's remote MCP connector) would not work for Local/Gemini and would bypass approval gating.
- **Approval-first must be structural.** The LLM loop only ever gets READ tools. WRITE actions (create/update/delete event, send message) are *proposals* in structured JSON; the app executes them itself via MCP/bridge only after an approval record exists. This also is the main prompt-injection defence — a malicious message can at worst produce a bad *draft* that the user sees.
- **"In calendar" semantics.** An item only moves to "In calendar" after the user approved and the app's MCP create-event call succeeded.
- **Local model risk.** Hebrew quality at ~4B is the weakest link. Expect candidates: Gemma family (strong multilingual), Qwen3 family (strong tool calling, weaker Hebrew), DictaLM 3.0 (Hebrew-specialised; tool-calling claims need verification). Research agents must verify on the web — my recollection is not evidence. Mitigation in design: stage-1 extraction is schema-constrained JSON (grammar-enforced on llama.cpp), so even a small model cannot emit malformed output; dates are sanity-checked in code.
- **Shared working tree, no worktrees.** Build agents run in parallel in one tree, so the build plan assigns non-overlapping file ownership and a scaffold wave runs first so everything typechecks from minute one.
- **Tests never touch reality.** Fake bridge (HTTP), fake MCP calendar server (stdio), scripted LLM provider. Real pairing, real Google OAuth and real model download are left as a manual checklist for the user.

## Risks being tracked

| # | Risk | Mitigation / status |
|---|---|---|
| R1 | Reference `store/` leaks private chats or live session gets disturbed | Hard rule in CLAUDE.md + every agent prompt; app uses own store; tests use fakes |
| R2 | Bridge store location may be cwd-relative → must launch exe with cwd = app userData store parent | Awaiting `docs/research/bridge-contract.md` |
| R3 | Native module / Electron ABI pain (better-sqlite3, node-llama-cpp) on Windows without MSVC build tools | Prefer prebuilt binaries or `node:sqlite` / llama-server child process; feasibility critic checks this |
| R4 | Google OAuth: end user must create their own Google Cloud OAuth desktop client (unverified-app screen) | Onboarding wizard with step-by-step helper; confirm in calendar-mcp research |
| R5 | WhatsApp unofficial-client ban risk | Approval-first + human-paced sending lowers it; must be disclosed to the user in README |
| R6 | 4B model Hebrew relative-date extraction quality | Grammar-constrained JSON, code-side date validation, eval set of 30+ snippets, tier up when hardware allows |
| R7 | Workflow ① agents started before CLAUDE.md existed | Back-fill their findings into `ops/agent-notes/workflow-1-summary.md` |

| R8 | Account session quota: workflow ① burned ~2.4M subagent tokens in research alone and hit the limit mid-run | Resume uses the cache; keep workflows ② and ③ smaller per run and checkpoint to disk after each wave so a quota stop loses nothing |
| R9 | Second bridge instance could leak messages to the user's other webhook receiver (default `localhost:8769`) or collide on port 8080 | Host refuses to spawn unless port/token/webhook/media-roots/cwd are all set by us (see workflow-1-summary) |
| R10 | The exe is a locally modified, unsigned build that nobody here can rebuild (no Go) — will break when WhatsApp's protocol moves | Disclose in README; later: CI build of the vendored source |

## Open questions for the user (none blocking the design; all have a default)

| # | Question | Default being used |
|---|---|---|
| Q1 | The app needs its own WhatsApp linked-device slot (max 4; your existing bridge holds one). OK? | yes |
| Q2 | Ambiguous time like "ב-5" with no am/pm cue | propose 17:00, flagged low-confidence, visible before approval |
| Q3 | Events with attendees (would email invites on approval)? | no — attendee-less in v1 |
| Q4 | Claude default model: most capable vs cheaper | user-selectable, list fetched from the API |
| Q5 | Initial backlog after pairing | only messages from the last 24 h before pairing are triaged |
| Q6 | Autostart with Windows | off by default, toggle in settings |
| Q7 | Hebrew UI strings were agent-written | please skim `docs/research/i18n-rtl.md` he.json once the UI exists |

| U1 | Default Claude model | `claude-opus-5` (Sonnet 5 ~2.5× cheaper, one click away) |
| U2 | Ambiguous hour ("at 5") | PM + visible badge (same as Q2) |
| U3 | Senders you never wrote to | raw card, no AI until "Analyse this chat" |
| U4 | Show names of conflicting calendar events to the AI | off (busy/free only) |
| U5 | Backlog window after pairing | 0 h (judge overrode my 24 h lean for privacy; setting 0–72 h) |
| U6 | Retention of message snapshots and drafts | 30 days |
| U7 | Start with Windows | off |

| U8 | Confirm the reading of "calendar via the LLM's MCP" (D-026): LLM gets READ tools by MCP tool calling; the app executes `create-event` through the same MCP client after your click | in force |
| U9 | Confirm the v1 cuts (D-025) — each becomes a post-v1 ticket if wanted | in force |
| U10 | VC++ runtime DLLs: if you can point `VC_REDIST_CRT_DIR` at a `Microsoft.VC143.CRT` folder on this PC they ship inside the app; otherwise the app detects the missing runtime and links to Microsoft's installer | detect + link |

Manual items added by the finalizer for the user's checklist: **M15** llama-server json_schema wire check on the real binary; **M16** `@lid` send test as a release gate; **V13** Windows Defender firewall prompt may appear during Google sign-in (wizard copy covers it).

Rejected finding (1): the suggested upstream contribution of `--host 127.0.0.1` for the calendar MCP OAuth callback is not planned.

## Orchestrator review of the design (2026-09-22, before critics finished)

- Read ARCHITECTURE §1–3, §19–20 and build-plan §1–4, §8. The design honours every locked decision. Notable strengths: seven named invariants each with a test; the bridge spawn invariants (I6) directly close R9; the pipeline split (D-012) removes the dependence on small-model tool-call parsing.
- Accepted all 9 build-plan concerns as written (D-016…D-019).
- Docs are large (ARCH 99 KB, contracts 125 KB, ux 117 KB, tests 94 KB, plan 71 KB). Build agents get told which sections to read; nobody needs all 566 KB.
- Quota plan for workflow ②: run W0 alone first (checkpoint), then Wave 1 in two batches of 8 so a limit stop loses at most half a wave, then Wave 2 sequentially.
