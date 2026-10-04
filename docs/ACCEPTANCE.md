# FINAL ACCEPTANCE — WhatsApp Calendar Agent v0.1.0

Marker: `acceptance` (phase 3, adversarial review). Date: 2026-09-27.
Marked against the user's original words in `ops/CONTEXT.md`, the locked decisions of that file, and the binding
contract in `docs/ARCHITECTURE.md` sections 1-2.

**VERDICT (original run, 2026-09-27 morning): NOT ACCEPTED YET.** Two of the seven release gates were red (`format:check`, `test:e2e`). **Superseded by the Addendum below: RE-SCORED → ACCEPTED at code level after workflow ④ (all seven gates green).** The original text is kept unedited beneath so the two runs can be compared. The product's
core promise (approval-first) is enforced in code and in the database and is proven by the security suite and by the
*negative* end-to-end test, but the *positive* end-to-end path ("approve -> exactly one send", "add to calendar ->
exactly one event") does not currently run to green. Nothing has ever been executed against the real bridge, a real
Google account, a real model or the real Hugging Face CDN — by hard rule — so every "met" below means *met in code and
in the automated suite*, never *observed working on the user's machine*.

---

## Addendum — RE-SCORE after workflow ④ (orchestrator, 2026-09-27, on the proof agent's measured exit codes)

Source: `ops/agent-notes/final-proof.md` (independent proof agent; edited nothing), `ops/agent-notes/final-e2e.md`, `ops/agent-notes/final-hygiene.md`.

| # | Gate | Exit | Result |
|---|---|---|---|
| 1 | `npm run lint` | 0 | green |
| 2 | `npm run typecheck` | 0 | green |
| 3 | `npm run format:check` | **0** | green (the two files were formatted by the orchestrator) |
| 4 | `npx vitest run` (all projects) | 0 | **3837 passed / 1 skipped** (169 files; the skip is `golden.live` gated behind a real model) |
| 5 | `npm run test:e2e` | **0** | **22 / 22 passed, 0 flaky — run twice on the final tree** |
| 6 | `npm run test:smoke` | 0 | seven gates green incl. the new 4a (calendar server present in the package) |
| 7 | `npm run audit:prod` | 0 | 0 vulnerabilities |
| — | `npm run verify` (all of the above as one command) | **0** | green |

**What changed between the two runs — tests only, no product code:** the four red e2e specs were test-seam defects, each closed as the reverify agent had diagnosed (two stale `ready`→`ready|idle` preconditions cited to `contracts.md` L562; a wait for the restarted fake bridge's new pid + control server; the second instance spawned as a raw child). `onboarding.spec.ts:139`, which the original run flagged as "possibly a real defect", was confirmed to be the fake's control server dying with a *legitimate* product restart.

**Why the three `partial` rows below become `met`:** they were partial for one reason only — no green e2e proof of the *positive* approval path. `tests/e2e/approval-first.spec.ts` now passes both `approve → exactly one send with the edited text` and `add to calendar → exactly one create-event`, and the obedient-attacker spec passes with a *real* create-event tool present for the gate to withhold (the e2e agent found the specs had never seeded Google credentials, so the positive create-event path had genuinely never been exercised end to end before this run). Rows 5, 6 and D-002 are therefore re-scored **met** — at code level.

**What has NOT changed:** every `needs_user_action` row and the manual checklist M1–M16 in section 3. The sentence in section 4 still stands verbatim: the suite proves the code does what the architecture says; it cannot prove the product works on the user's machine with the user's WhatsApp account. Residual product decisions from the review are filed as T-401…T-411 in `ops/BOARD.md`.

## 1. The gate run (this session, real exit codes)

Each command was run from `C:\dev\whatsapp agent` with `$env:PATH = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;" + $env:PATH`.

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `npm run lint` | **0** | clean, `--max-warnings 0` |
| 2 | `npm run typecheck` | **0** | three projects (node / web / tests) clean |
| 3 | `npm run format:check` | **1** | **RED** — 2 files unformatted (below) |
| 4 | `npx vitest run` | **0** | 167 files, **3828 passed, 1 skipped** |
| 5 | `npm run test:e2e` | **1** | **RED** — 22 tests, **18 passed, 4 failed** (below) |
| 6 | `npm run test:smoke` | **0** | packaged `--dir` smoke, all six checks + check 4a green |
| 7 | `npm run audit:prod` | **0** | `found 0 vulnerabilities` |

The single skipped vitest case is `tests/golden/golden.live.test.ts:71`
(`describe.skipIf(!LIVE)` — the live golden evaluation, user-run only, needs a real model or real API keys). It is
correctly gated, not a silently disabled test. No test was deleted, skipped or weakened to produce this report.

### 1.1 RED — `format:check` (exit 1) — *resolved, see Addendum*

```
[warn] src/main/bridge/bridgeDb.ts
[warn] src/main/llm/local/llamaServer.test.ts
[warn] Code style issues found in 2 files.
```

Both are cosmetic line-wrap drift left behind by the Sep-27 repair agents, not logic:

- `src/main/bridge/bridgeDb.ts:146` — a union type written over two lines that Prettier collapses to one.
- `src/main/llm/local/llamaServer.test.ts:523` — a call Prettier joins onto one line.

Left unfixed on purpose: the acceptance marker does not repair. `npx prettier --write` on those two paths clears gate 3.

### 1.2 RED — `test:e2e` (exit 1), 4 of 22 failed — *resolved, 22/22 in the re-score, see Addendum*

| Failing test | Symptom | Diagnosis |
|---|---|---|
| `tests/e2e/approval-first.spec.ts:144` — *approve -> exactly one send with the edited text; add to calendar -> exactly one create-event* | `expect(llm.state).toBe('ready')` got `'idle'`, 20 s poll timeout at line 173 | **Test defect, not a product defect.** The profile is seeded `provider: 'local'` (line 151) and `compose.ts:817-820` reports `state:'idle'` for the local provider *by design* — llama-server is lazy (ARCH A2); `'ready'` is only ever reported for a cloud provider with a usable key. The assertion can never pass on a local profile. The in-source comment blames `W2-01: the WCA_LLM seam never reaches createProviderFactory({ seamProvider })`, and that comment is **stale**: the seam is wired (`src/main/index.ts:44, 62, 206` -> `compose.ts:760, 781` -> `factory.ts:75`). |
| `tests/e2e/approval-first.spec.ts:213` — *an obedient attacker model causes no side effect and the card is badged as manipulation* | same `'ready'` vs `'idle'` timeout | Same root cause as above. |
| `tests/e2e/onboarding.spec.ts:139` — *accepting the disclosure starts the bridge, and the QR can be scanned, expired and re-issued* | `TypeError: fetch failed` / `read ECONNRESET`, reproducible on both attempts, ~3.1 s in, no source frame attributed | **Not isolated.** Fails too early for any of its 20-30 s polls, so the throw is an immediate fetch rejection, most likely in the fake-llama/control-channel helper rather than in app code — but that is a hypothesis, not a finding. The sibling test at `:76` uses the same `localModelSeams()` helper and passes. Needs a dedicated debugging pass; traces are on disk at `test-results/onboarding-accepting-the-d-06e14-anned-expired-and-re-issued*/trace.zip`. |
| `tests/e2e/tray-lifecycle.spec.ts:145` — *a second launch on the same profile exits and re-shows the first window* | `electron.launch: Target page, context or browser has been closed` | **Harness limitation.** The product behaves correctly — the second instance takes the single-instance lock, quits, and hands focus back — but it exits before Playwright can attach a debugger, so `electron.launch` throws instead of returning a handle whose `exitCode` the test then polls. The test needs to spawn the second instance without Playwright attachment. |

Consequence for acceptance: the end-to-end proof of the **positive** approval path is missing. The **negative**
invariant is green (`approval-first.spec.ts:79`, see row D-002 below), and the positive path is covered at unit and
integration level, but no green e2e test currently demonstrates "one click -> exactly one send, exactly one event"
through the real IPC, DB, trigger and executor in a running app.

---

## 2. Requirement-by-requirement

### GUI

| # | Requirement (user's words) | Verdict | Evidence / what is missing |
|---|---|---|---|
| 1 | Minimal dashboard with the three latest-lists "Needs reply" / "In calendar" / "Information missing" | **met** | `src/renderer/src/views/Dashboard.tsx` renders exactly three `ItemList`s in that fixed order from `LIST_KEYS = ['needs_reply','in_calendar','info_missing']` (`src/renderer/src/store/dashboard.ts:13`). Labels: `list.needs_reply` / `list.in_calendar` / `list.info_missing` in `src/shared/locales/en.json` + `he.json`. Three columns >= 900 px, collapsible single column below. Tests: `src/renderer/src/views/Dashboard.test.tsx`, `src/renderer/src/components/ItemList.test.tsx`, and e2e `tests/e2e/app.spec.ts:14` *"seeded profile boots to a dashboard with three empty lists, a healthy bridge and the setup strip"* — **PASSED** this run. "Latest" is capped and labelled (`list.latestOf`, latest 20). |
| 2 | Multilanguage Hebrew + English | **met** | `src/shared/locales/en.json` and `he.json` are at full key parity: **755 English keys, 0 missing in Hebrew**; Hebrew carries 5 extra `_two` keys, which is correct Hebrew dual-plural handling, not drift. Machinery: `src/renderer/src/i18n.ts`, `src/main/app/i18n.ts` (main process, so the tray and native dialogs translate too), `src/shared/i18n/bidi.ts`, `src/shared/i18n/languages.ts`. Tests: `src/shared/locales/locales.test.ts`, `src/renderer/src/i18n.usage.test.ts` (no hard-coded strings), `src/shared/i18n/bidi.test.ts`; e2e `tests/e2e/i18n-rtl.spec.ts` — all 4 cases **PASSED**, including *"a language change reaches the tray menu in the main process"* (asserts Hebrew glyphs in the live tray template) and *"a Hebrew dashboard lays out towards the right and neither language scrolls horizontally at 420 px"*. Screenshots of every view in both languages are produced for the user's Hebrew review. Open: the *quality* of the agent-written Hebrew copy is unreviewed (V11 / manual M12) — a human must skim it. |
| 3 | Clicking X minimises to the Windows 11 hidden-icons tray | **met**, with one caveat the app cannot control | `installCloseToTray` (`src/main/app/window.ts:201`) `preventDefault()`s every `close` and calls `win.hide()` immediately — first close included — and only lets the window close when the quit sequence has set `isQuitting`. Wired at `src/main/index.ts:245`. Tray lives in `src/main/app/tray.ts` (Open / status / Pause / Settings / Quit; quit is only reachable from the tray). First-close coach mark: `installTrayHintCoachMark` (`window.ts:222`). Tests: `src/main/app/window.test.ts`, `src/main/app/tray.test.ts`; e2e `tests/e2e/tray-lifecycle.spec.ts:79` *"close hides to the tray within 200 ms, shows the coach mark exactly once, and the tray re-opens it"* — **PASSED**. **Caveat:** the app puts an icon in the notification area; whether Windows 11 files it under the **"hidden icons" overflow flyout** or pins it to the always-visible row is a per-user Windows setting that no application may set. No `Tray` GUID is used while the exe is unsigned. So "hides to the tray" is proven; "lands specifically in the hidden-icons flyout" is Windows' choice and is unverifiable here. |

### Backend

| # | Requirement (user's words) | Verdict | Evidence / what is missing |
|---|---|---|---|
| 4 | The WhatsApp bridge is exactly the user's prebuilt exe, run as a managed child | **met** (never executed) | Identity is pinned by hash, not by trust: `scripts/import-bridge.mjs:18-19` pins `BRIDGE_EXE_SIZE = 43_540_541` and `BRIDGE_EXE_SHA256 = ac23221e8bcf3937a4ca346b3bd80a8da09df94cbecd949af2916c4bc8d22ff5`, copied from the user's own path; `resources/bridge/whatsapp-bridge.exe` + `SHA256SUMS` + `LICENSE` are present. The launcher re-hashes before every spawn and refuses on mismatch (`src/main/bridge/launcher.ts:546-562`, `exe_hash_mismatch` -> `BRIDGE_BINARY_BLOCKED`). Managed child: one `Supervisor` (`src/main/proc/supervisor.ts`) + `Reaper` (`src/main/proc/reaper.ts`), backoff 2/5/15/60 s, breaker 5 exits / 10 min. `assertBridgeSpawnInvariants` (`src/main/bridge/invariants.ts`) refuses to spawn unless cwd is inside the app's own `userData`, the port is not 8080, and the webhook points at our own loopback doorbell — this is what keeps the user's **live** bridge and store untouched (invariant I6). Only the four allowed endpoints are implemented (`readClient.ts`, `sendClient.ts`; ARCH A16). Tests: `tests/security/bridge-invariants.test.ts` (one case per violated precondition), `src/main/bridge/launcher.test.ts`, `src/main/bridge/invariants.test.ts`; packaged smoke check 4 streamed the shipped exe to the pinned SHA-256 **without executing it**. **Never executed by any agent** (hard rule) — closed only by manual M1/M2/M3. |
| 5 | Three LLM options — local (ready to use, laptop-suitable, downloaded on first run), Claude, Gemini | **met** (re-scored 2026-09-27 — see Addendum; was partial only for lack of a green e2e positive path) | All three exist and are selectable: `src/main/llm/factory.ts` builds exactly `local` / `claude` / `gemini`, **never silently falls back** between them, and refuses a cloud provider without a current versioned consent row (`src/main/llm/consent.ts`). Implementations: `src/main/llm/claude.ts` (`@anthropic-ai/sdk` 0.127.0), `gemini.ts` (`@google/genai` 2.23.0, always `store:false`), `local.ts` + `local/llamaServer.ts` (embedded `llama-server.exe`, OpenAI-compatible, loopback + per-launch API key). Laptop suitability is the tiering: `local/manifest.ts` pins three Gemma-4 GGUFs by HF commit + size + sha256 (`tiny` E2B Q4_K_M, `small` E4B Q4_K_M, `mid` 12B-it-qat UD-Q4_K_XL) and `local/hardware.ts:65 pickTier()` chooses from a RAM/GPU probe. First-run download: `local/download.ts` + `src/main/ipc/handlers/model.ts` (tier from an **enum**, never a URL or path from the renderer). `vendor/llama/win-x64-vulkan` holds all 24 pinned llama.cpp b10964 files and the packaged smoke confirmed all 24 shipped. Tests: `factory.test.ts`, `hardware.test.ts`, `manifest.test.ts`, `download.test.ts`, `selfTest.test.ts`, `tests/security/gguf-download.test.ts`, `tests/security/consent-payload.test.ts`; e2e `tests/e2e/onboarding.spec.ts:76` *"Welcome runs nothing before the disclosure is accepted, then the local model starts downloading"* — **PASSED**. **Why partial:** (a) "comes ready to use" depends on a first-run GGUF download that has **never been run against the real Hugging Face CDN** — only against a fake server (V12, manual M7); (b) the **VC++ CRT DLLs are absent** from `vendor/llama/win-x64-vulkan` (`msvcp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll` — not in `MANIFEST.txt`'s 24 files), because nobody supplied `VC_REDIST_CRT_DIR`; on a machine without the Microsoft redistributable the app will show `LLM_VCREDIST_MISSING` instead of a working Local provider (U10, manual M13); (c) no real model has ever produced a token here, so Hebrew quality and tok/s on the laptop target are unknown (V5/V11, manual M8 + `test:golden:live`); (d) the two cloud providers have never seen a real key (V8/V9, manual M11) — their wire handling rests on captured fixtures. |
| 6 | Google Calendar reached through MCP driven by the LLM (read tools called by the model; create-event executed by the app after the approval click — D-026) | **met** (re-scored 2026-09-27 — see Addendum; was partial only for lack of a green e2e positive path) | The mechanism is built exactly as D-026 describes and is the strongest-evidenced part of the backend. The **model** is handed only app-authored **read** tool definitions — `READ_TOOL_NAMES = ['get_current_time','get_freebusy']` (`src/main/agent/toolDefs.ts:8`) — and every call it makes passes `src/main/agent/toolGate.ts` (default-deny allowlist, app-pinned arguments, per-run budgets, projected results, `tool_blocked` audit that logs only a hash of the attempted name). Execution is a real MCP `tools/call` into `@cocal/google-calendar-mcp@2.6.3` over stdio, spawned as a managed child with `process.execPath` + `ELECTRON_RUN_AS_NODE=1`. Capability separation is by construction: `McpHost.callerFor('read'\|'write'\|'admin')` is the only exit from `src/main/mcp/host.ts` and asserts the tool's class at runtime; `create-event` is reachable **only** from `McpWriteClient` (`src/main/mcp/writeClient.ts:83`), which only `ActionExecutor` holds, which only the `action:approve` IPC handler calls (`src/main/ipc/handlers/actions.ts:24`). Tests: `tests/security/tool-gate.test.ts`, `tests/security/import-graph.test.ts` (a read facade calling `create-event` is both a compile error and a build failure), `src/main/mcp/*.test.ts`, `src/main/agent/toolGate.corpus.test.ts`; and the packaged smoke ran the **real** `@cocal` server through the packaged binary and got exactly the six `ENABLED_TOOLS` back from `tools/list` (checks 4a, 1, 2 — all green). **Why partial:** (a) the model's calendar reach was deliberately narrowed to free/busy + current time — `list_events` was **cut** (ARCH A9 `[R2]`, U9), so the LLM can see *that* you are busy but never *what* the event is; (b) D-026 itself is recorded in `ops/DECISIONS.md:32` as *"Orchestrator; confirm as U8"* and **the user has never confirmed it** — it remains an interpretation of "connectivity should run by the LLM via MCP", made by agents, not by the user; (c) no Google account has ever been contacted: no OAuth client exists, no token, no calendar was read or written (V4/V13, manual M5/M6). |

### Locked decisions

| # | Decision | Verdict | Evidence / what is missing |
|---|---|---|---|
| D-002 | **Approval-first** — nothing sent or booked without a click | **met** (re-scored 2026-09-27 — see Addendum; was partial only for lack of a green e2e positive path) | Enforced in code and in SQLite, never in prompts, exactly as required. `ActionExecutor` (`src/main/exec/actionExecutor.ts`) is the sole holder of `BridgeSendClient` and `McpWriteClient`; `compose.ts` is the only place that constructs them (ARCH A22), and `tests/security/import-graph.test.ts` makes a violation a **build failure**. Binding: opaque `actionId` + `sha256(canonical_json)` shown-hash + 24 h expiry + a **focused-window check** (`ipc/handlers/actions.ts:26-28`, refuses and audits `window_not_focused`) + rate limits + write-ahead states `pending -> approved -> executing -> done/failed` enforced by the `trg_actions_state` SQLite trigger. Deterministic `eventIdFor(...)` derived from the retry-chain root makes a duplicate event impossible (I7). Tests: `tests/security/approval-binding.test.ts`, `no-side-effect-fuzz.test.ts`, `injection-corpus.test.ts` (he + en corpora), `crash-recovery.test.ts`, `rate-limiter.test.ts`, `prompt-purity.test.ts`, `redaction.test.ts`, plus `src/main/exec/*.test.ts`; and e2e `tests/e2e/approval-first.spec.ts:79` *"an inbound message is ingested and NOTHING is sent or written without an approval"* — **PASSED**, including the assertion that an approval from a **hidden** window never succeeds. **Why partial:** the two e2e cases that prove the *positive* side — exactly one send with the edited text, exactly one `create-event`, and the attacker-model case being badged `manipulation` — are **RED** (section 1.2). The invariant "nothing without a click" is well proven; "a click produces exactly one effect" is proven only below the e2e layer. |
| D-003 | Personal-assistant profile | **met** | DMs only, enforced twice: ingest skips every non-DM JID (`src/main/bridge/ingest.ts:308` via `isDmJid`, line 69) and S0 filters again (`src/main/agent/stage0.ts:60`). No group endpoints are implemented at all (ARCH A16 — `/api/group/*` absent from `readClient.ts`). The drafting prompt is first-person, in the user's own voice, 1-2 WhatsApp-style sentences, no signature (`src/main/agent/prompt.ts` `SYSTEM_PROMPT_DRAFT`, pinned byte-for-byte against `docs/specs/agent-pipeline.md` by `prompt.test.ts`). Unknown-sender gate ON by default (A13) and the backlog gate (A14) keep it a personal tool rather than an inbox robot. No business features (no hours, no routing, no templates). Tests: `stage0.test.ts`, `ingest.test.ts`, `prompt.test.ts`, `prompt.purity.test.ts`, `tests/security/backlog-gate.test.ts`. |
| D-004 | Embedded llama.cpp with hardware tiering | **met** (same first-run caveats as #5) | Embedded, not Ollama: the official `llama-server.exe` (llama.cpp b10964, Windows Vulkan x64) ships in the package as a lazy managed child on `127.0.0.1:<random>` with a per-launch API key, below-normal priority, 600 s idle sleep (`src/main/llm/local/llamaServer.ts`, `supervised.ts`). Tiering is real: `probeHardware()` + `pickTier()` (`local/hardware.ts:65, 81`) over RAM and a `--list-devices` GPU probe with a dedicated-GPU name allow-list, feeding the three pinned tiers. Zero native Node addons (ARCH A1) — confirmed by packaged smoke check 5: 4499 asar entries, **no `*.node`, no `binding.gyp`, nothing unpacked**. Pre-flight for the missing CRT (`checkVcRuntime`, `VCREDIST_EXIT_CODE`) maps to exactly one `LLM_VCREDIST_MISSING` error. Tests: `hardware.test.ts`, `llamaServer.test.ts`, `supervised.test.ts`, `selfTest.test.ts`, `scripts/fetch-llama.test.mjs`. **Never executed** — no binary from `resources/llama` was run (hard rule). |

---

## 3. What only the user can do (needs_user_action)

These are not gaps in the build; no agent may perform them. Numbers are the register in `docs/ARCHITECTURE.md` §19
and the checklist in `docs/specs/test-strategy.md` §12 / `README.md` §5.

| Item | Why only the user | Closes |
|---|---|---|
| **M2/M3 — pair a real WhatsApp account** (supervised first launch of the real bridge, scan the QR, one free linked-device slot) | No agent may run `whatsapp-bridge.exe` or connect to WhatsApp | V1, V2 |
| **M4/M16 — one real approved reply** to a test contact, and one to an `@lid` contact (release gate: if `/api/send` delivers to `@lid`, those chats stop being copy-only) | Sends a real message to a real person | V2, V3 |
| **M5 — create the Google Cloud OAuth client**, run the real consent, pick the calendar; expect a Windows Firewall dialog on first sign-in (Cancel *and* Allow must both work) | Needs the user's own Google Cloud project and account | V4, V13 |
| **M6 — approve one real event**, then repeat after a simulated crash, and capture the real `create-event` / `get-freebusy` response texts (scrubbed) to correct the fake | Writes to a real calendar | V4 |
| **M7 — first real model download** (tier auto, pause/resume, kill mid-download, resume) | First contact with the real Hugging Face CDN | V12 |
| **M8/M15 + `npm run test:golden:live` — real `llama-server.exe` smoke** per shipped tier, Hebrew path, `--list-devices` capture, tok/s, and the `response_format` wire-shape check | No agent may execute the model server; this is also the only way the one skipped vitest case runs | V5, V11 |
| **M9 — build the NSIS installer from the path with a space, install it, start the packaged GUI for the first time**, then upgrade-install while children run | Explicitly forbidden to agents; the packaged smoke deliberately never starts a GUI | V10 |
| **M11 — enter a real Claude key and a real Gemini key in the app** (never in a file or env), read the consent texts, run the live golden set | Real paid credentials; must be typed into the app's own secret store | V8, V9 |
| **M12 — Hebrew copy review**: skim `he.json` in context using the screenshots `i18n-rtl.spec.ts` produced; check the tray menu, tooltip, toast and native dialogs in Hebrew | Native-speaker judgement | V11 |
| **M13 — clean-machine run** (Windows Sandbox or a second PC without Node/VC++): onboarding to Ready on the `tiny` tier; with the CRT DLLs removed it must show exactly `LLM_VCREDIST_MISSING` | Needs a second machine | V1, V5 |
| **M10 — log off / shut down with the window hidden**, log back in, confirm no orphan children of ours | Needs a real Windows session change | V7 |
| **Supply `VC_REDIST_CRT_DIR`** (or accept the pre-flight-only posture) so the three CRT DLLs ship app-locally | The user must point at a VC++ redistributable folder on the build PC; agents must not search the disk | U10 |
| **Confirm or reject D-026 / U8** — that "calendar via the LLM's MCP" means the model reads (free/busy, current time) and the app writes after the click | It is the user's requirement to interpret; agents chose the reading, the user never confirmed it | U8 |

---

## 4. Honest bottom line

**Built and demonstrably working in the automated suite:** the three-list dashboard; full Hebrew/English parity
including the main-process tray; X-hides-to-tray with a one-time coach mark; the bridge pinned by SHA-256 and run as an
invariant-guarded managed child that cannot reach the user's live store, port 8080 or default webhook; three LLM
providers with no silent fallback and blocking consent for the cloud two; the calendar reached only through a real MCP
server, read-only for the model, write-only from the post-approval executor; and approval-first enforced by module
boundaries, a focused-window check, a shown-hash binding and a SQLite trigger — with the import-graph test making a
violation a build failure. The packaged `--dir` build passes all six packaging checks including a real MCP handshake
through the packaged binary, and production dependencies report zero vulnerabilities.

**Not done (at the original run; both closed in the re-score, see Addendum):** `format:check` was red on two files, and 4 of 22 e2e tests were red. Two of those four are a stale
assertion (`llm.state === 'ready'` on a local-provider profile, which is `'idle'` by design) and one is a harness
limitation (Playwright cannot attach to an instance that correctly exits immediately) — but the third,
`onboarding.spec.ts:139`, is an unexplained reproducible `ECONNRESET` that nobody has diagnosed yet. Until those are
fixed, there is **no green end-to-end proof of the positive approval path**, which is the single most important
behaviour in the product. The VC++ CRT DLLs are not staged. D-026 is still an unconfirmed agent interpretation of the
user's sixth requirement, and `list_events` was cut from what the model may read.

**Unverifiable without the user's own hardware and accounts:** everything about the real world. No agent has ever run
the bridge, connected to WhatsApp, contacted Google, executed `llama-server.exe`, downloaded a GGUF from Hugging Face,
built the installer, or started the packaged GUI. That means: the bridge's real behaviour and DB timestamp format; QR
pairing; message delivery; `@lid` sendability; OAuth and any real calendar read or write; real model speed, Hebrew
quality and VC++ behaviour on a clean machine; the real Claude and Gemini wire shapes and error bodies; installer and
upgrade behaviour; SmartScreen/Defender friction on three unsigned executables; and whether Windows 11 files the tray
icon in the hidden-icons flyout. The automated suite proves the code does what the architecture says. It cannot prove
the product works on the user's machine with the user's WhatsApp account — only M1-M16 can.

Accepted weaknesses were disclosed by design and are unchanged (README §"accepted weaknesses"): same-user malware can
read the local databases and call DPAPI; `runAsNode` is enabled; nothing is code-signed; no auto-update; the bridge is
an opaque binary nobody here can rebuild and will eventually hit "Client outdated"; whatsmeow use violates WhatsApp's
terms regardless of volume; capability separation is module-level, not process-level; and a human who approves without
reading defeats every control above.


---

## v2 additions to the manual checklist (orchestrator, 2026-09-28 — from ARCHITECTURE-v2 §16/§18)

These close the v2 UNVERIFIED register; all need the user's own accounts or hardware, so no agent may run them.

| # | Check | Closes |
|---|---|---|
| M-CLI-1 | With your logged-in Claude Code: run the app's provider-start smoke (one tiny schema call). Confirms the headless flag set on your CLI version, whether the MCP token expands inside an inline `--mcp-config`, image input over stream-json, and the `auth status --json` fields | U-C6, U-C7, U-C8, image path on Claude CLI |
| M-AGY-1 | Only if you opt in to Antigravity: install `agy`, sign in, run the app's smoke. Records the observed tool set (must be empty), whether sign-in survives the isolated app profile, and the error field names. Its result gates the Antigravity release | U4, U-A2, U-A6, U-A7 |
| M-CAL-1 | Approve one change and one cancel on a real test event; confirm the patched calendar server honours `status` and `If-Match` (a 412 on a concurrent edit), and that undo restores the event | U-E1, B4 patch |
| M-VOICE-1 | Record one real Hebrew and one English voice note; confirm transcription and pick the default voice tier | U-v2-2, T2 concern 10 |
| M-GOLDEN-1 | `npm run test:golden:live --feature v1|edits|images|voice` on your machine per provider you use. **This is the gate for automatic edits and for voice/picture events in automatic mode (D-068)**: until it records passing values, automatic edits stay manual and every voice/picture event asks for approval | D-056, D-068 |

---

## v2 acceptance (marker `v2-acceptance`, 2026-10-04)

Marked against the user's own words in `ops/CONTEXT.md` (original request, "v2 request" 2026-09-27, the v2 option dialog),
the locked decisions, `docs/ARCHITECTURE-v2.md` §1-2 and D-068..D-078. Inputs: the four v2 repair notes, `v2-reverify.md`, the six
v2 review lenses and the v2 fix notes in `ops/agent-notes/`. Raw output of this gate run: `ops/agent-notes/v2-acceptance/`.
Every "met" below means **met in code and in the automated suite against the fakes**. No agent has ever run the bridge,
WhatsApp, Google, `claude.exe`, `agy`, `whisper-cli.exe`, `llama-server.exe`, a real model download, the installer or the
packaged GUI (hard rules).

**VERDICT: NOT ACCEPTED as a release.** Three of the seven gates are red:
- e2e: two real product defects are still open (an undo whose card shows the wrong time, and a CLI job started during
  quit that leaves a pid file behind).
- packaged smoke: this PC refuses to run the unsigned build. That is also a warning for the user's own first launch.
- vitest: red on the first run (16 timeouts under full parallel load) and green on an immediate re-run of the unchanged tree.

Approval-first holds in every test that probes it: the negative path, the positive path, the attacker model, and both
automatic-mode rails ("replies never automatic", "writes only under a live, user-granted policy").

### v2.1 The gate run (this session, real exit codes)

Each command was run from `C:\dev\whatsapp agent` with Node/Git prepended to PATH and `WCA_GOLDEN_LIVE` unset, in this order.

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `npm run lint` | **0** | clean, `--max-warnings 0` |
| 2 | `npm run typecheck` | **0** | node / web / tests projects clean |
| 3 | `npm run format:check` | **0** | "All matched files use Prettier code style!" |
| 4 | `npx vitest run` (all projects) | **1**, then **0** on an immediate full re-run | **Run 1: 16 failed / 7506 passed**, all in 4 files, all timeouts (5 s / 20 s), no assertion failure. Files: `src/main/agent/waTools.test.ts` (7), `src/main/bridge/waReadClient.test.ts` (6), `src/main/bridge/ingest.test.ts` (2), `tests/integration/pipeline-gates.test.ts` (1); all four build large synthetic bridge SQLite DBs. Isolated re-run of the 4 files: 125/125 pass (23 s). **Run 2, full, unchanged tree: 323/323 files, 7522 passed, 1 expected fail, 1 skipped.** The expected fail is `prompt.size.test.ts`, an `it.fails` that predates v2; the skip is `golden.live`, which only the user runs. Verdict: these four suites flake under load and the gate is **not reliably green**; their timeouts need headroom. |
| 5 | `npm run test:e2e` | **1** | **41 passed / 5 failed of 46.** Each failure failed again on its retry. **All 22 v1 e2e tests pass**; v2: 19 of 24 pass. See v2.2. |
| 6 | `npm run test:smoke` | **1** | Checks 3, 4, 4a, 5, 6, 7, 8, 10, 11 and 12 pass. Check 8 is newly fixed: the voice-model URLs are now commit-pinned. **Checks 1, 2 and 9 did NOT run**: `spawn UNKNOWN` on `dist\win-unpacked\WhatsApp Calendar Agent.exe`, even when started as plain Node. Smart App Control is enforcing on this PC (CONTEXT, D-078) and refuses the freshly packed, unsigned exe. The script itself says "never count this as a pass". |
| 7 | `npm run audit:prod` | **0** | `found 0 vulnerabilities` |

Against `v2-reverify` (43/46 e2e, smoke red on checks 1/2/9), **e2e got worse by two** after the review-fix round. See v2.2 rows 1 and 2.

### v2.2 The five red e2e tests

| # | Test | Symptom | Diagnosis |
|---|---|---|---|
| 1 | `cli-connect.spec.ts:300` (7b) overage | Teardown: `E2E quit leak: pid files left in run\: job-cli-<id>` (`helpers/fixtures.ts:691`) | **Product defect (main), new since reverify.** Same class as #4. |
| 2 | `cli-connect.spec.ts:329` (7c) extra_tool | Same teardown leak | **Product defect (main), new since reverify.** Same class as #4. |
| 3 | `cli-connect.spec.ts:355` (8) experimental Gemini | Soft assertion `agy-workspace-diff` not visible | **Stale test expectation, not a product defect** (`v2-reverify.md` #2). In isolated agy mode the repair deliberately records `workspaceTrusted:true`, so no diff is shown and the provider is selectable. The spec (owner V2-W2-03) has not been updated. |
| 4 | `cli-connect.spec.ts:410` (9) quit while a CLI job runs | `pid files left in run\: job-cli-<id>` (`fixtures.ts:588`) | **Product defect (main), still open** (REQUEST 10). `src/main/proc/jobRunner.ts` has no shutdown latch: `run()` still accepts jobs after `killAll()`, so a CLI job started during quit is never cleaned up. Fix direction: a `closing` flag set by `killAll()` that refuses every later `run()`, plus a test for that. #1 and #2 first appeared after the `cli-sandbox-4` orphan sweep was added. The sweep adds about 1 s of PowerShell to every CLI job exit and plausibly widened the race; this is a hypothesis, not proven. |
| 5 | `undo.spec.ts:87` manual reschedule undone from its card | Soft assertion: the card shows `17:00-18:00`, expected `15:00` | **Product defect (renderer), still open** (`v2-reverify.md` #1). The DB and `dashboard:get` already hold the restored 15:00; the card on screen is stale. Cause: `ItemList.tsx keyOf()` keys "In calendar" cards by `event-<eventKey>`. When the event moves to the delta item, React reuses the old item's ItemCard and its local draft. The card counts as dirty, so the refresh skips it. A reload shows 15:00. Meanwhile the user sees the wrong time after Undo. |

### v2.3 The v2 request, item by item

| # | Requirement (user's words, v2 request) | Verdict | Evidence / what is missing |
|---|---|---|---|
| a | "the app must also **EDIT** events as conversations evolve" (reschedule / move / cancel, with undo) | **partial** | **Built:** `agent/existingEvent.ts`; the pure delta resolver `agent/resolveDelta.ts`; S4 `update_event` in `agent/validate.ts` / `orchestrator.ts`; executor `runUpdate` + undo/restore in `exec/actionExecutor.ts` + `exec/undo.ts`. Every update carries `ifMatch`. Cancel = `status:'cancelled'`, never delete. The user's own literal example (their own "let's make it 5") is handled as a self-trigger (F28). **Tests:** `resolveDelta.test.ts`, `existingEvent.test.ts`, `tests/integration/pipeline-edit.test.ts` (reschedule, move, cancel, F31, F40, F28 self-trigger, F32 reject, approve → one PATCH with ifMatch), `tests/integration/editing-executor.test.ts`, `tests/security/editing.{executor,foreign,undo}.test.ts`, `never-delete.test.ts`. **e2e:** `edit-change.spec.ts` 4/4 pass (en, he RTL, drift, event_missing); `undo.spec.ts` 2/3 pass. **Open:** (1) red e2e #5: the card shows the pre-undo time after Undo. (2) `editing-undo-5`: the B24 "correction offer" (Google's copy differs from the approved content) has no UI. The exec side is safe; the card/items side was never drawn (REQUEST in `v2-fix-src-main-exec.md`). (3) By design only the **newest** event per chat is editable. A change to an older event becomes `change_target_unclear` (manual) or a new event. (4) Never run against real Google: the patched server's `status` / `If-Match` behaviour is unverified until M-CAL-1. |
| b | "**Automatic mode** ... adds and edits events ... automatically with no approval" (option dialog: calendar add + edit only, replies always drafts, cancel = mark cancelled; rails D-069) | **partial** | **Built:**<br>- `exec/autoGate.ts`: a pure, LLM-free cage.<br>- `exec/autoPolicy.ts`, plus `app/autoDialog.ts` (the native enable dialog, owned by main).<br>- The v2 trigger `trg_actions_state` (`db/migrations.ts`). A non-click approval passes only with an `auto_decisions` row for that exact action, under a live `on` policy, with a byte-equal payload. Any non-click `send_reply` is refused, so **replies can never be automatic**; SQLite enforces this.<br>**Tests:** `tests/security/auto-mode.{gate,i1-trigger,injection-corpus,limits,ownership,shadow,snapshot,toggle,unattended,undo}.test.ts`, `tests/integration/auto-mode.flow.test.ts`, `autoGate.test.ts`, `autoPolicy.test.ts`.<br>**e2e passes:** `auto-mode.spec.ts` covers off by default, UI-only enable, 3 approved creates → trial → shadow → on → zero-click create → tray pause. `undo.spec.ts:26` covers an automatic create undone from the AutoStrip.<br>**Not available out of the box:**<br>- **No automatic edits in this build.** `FEATURE_GATES[*].editsPassed = false` for every provider (`src/main/agent/gates.ts`), so every delta is manual-only. These are source constants: after M-GOLDEN-1, turning one on needs a code change and a rebuild. There is no in-app switch.<br>- Automatic adds start only once the D-069 rails are met: at least 3 approved creates, a 24 h trial, the user having written in that chat within 24 h, quiet hours 22-07, and a 30-day expiry.<br>- Voice- and picture-derived events also stay manual (gates closed, D-068).<br>**Open defects:**<br>- `auto-mode-8` (major, **not fixed**): when the app pauses a trial by itself (calendar disconnect, unattended, snapshot change), "Resume" sets the policy straight to `on` once 3 shadow decisions exist. The user never clicks "Turn on for real". Code: `autoPolicy.ts resume()`; unit test `autoPolicy.test.ts:302` encodes this behaviour.<br>- `ux-i18n-v2-3(b)`: no Renew for an `on` policy in its last 7 days.<br>- `ux-i18n-v2-8`: the sheet says "Added automatically" for automatic moves and cancels. |
| c | "Cloud LLMs must work on an existing **subscription**, not an API key" (Claude Code CLI; Gemini via Antigravity, opt-in experimental; API keys only as fallback) | **partial** | **Built:**<br>- `llm/cli/claudeCli.ts` + `claudeCli.env.ts`, `llm/cli/antigravityCli.ts`, `llm/cli/locator.ts`, and `llm/cli/runner.ts` on top of `proc/jobRunner.ts`. Every run is headless, tool-less and session-less, behind an init-proof sandbox check.<br>- `llm/factory.ts` offers `local` / `claude_cli` / `antigravity_cli` / `claude` / `gemini`, with no silent fallback.<br>- Antigravity is hidden behind "Show experimental", shows a Terms disclosure first, and runs in an isolated app profile.<br>- The API-key providers `llm/claude.ts` / `llm/gemini.ts` are unchanged from v1.<br>**Tests:** `claudeCli.test.ts`, `antigravityCli.test.ts`, `runner.test.ts`, `locator.test.ts`, `factory.cli.test.ts`, `factory.repairs.test.ts`, `tests/security/{cli.sandbox,agy.sandbox,cli-env-poisoning}.test.ts`, `tests/integration/{cli-provider,agy-provider}.test.ts`.<br>**e2e** `cli-connect.spec.ts`: (1)-(6) and (7a) pass; (7b), (7c), (8) and (9) are red (v2.2 #1-#4).<br>**Not verifiable here:** no agent ran the user's `claude.exe` or `agy`. Unverified until M-CLI-1 / M-AGY-1: the headless flag set on the user's CLI version, the `auth status` fields, and image input.<br>**Policy risk (disclosed, unchanged):** Anthropic restricted third-party harnesses on Pro/Max. The user's own single-user CLI login fits the documented carve-out, but that may change. Antigravity Terms §6 is a grey zone. |
| d | "Make sure the **MCP for WhatsApp** is well written as well as for the **calendar**" (read-only WhatsApp tools, gated) | **met** (code level) | **WhatsApp:**<br>- Exactly four read tools: `wa_get_chat_messages` / `wa_search_messages` / `wa_get_message_context` / `wa_list_chats` (`agent/waTools.ts`). The bridge read client has no write method (`bridge/waReadClient.ts`).<br>- CLIs reach the tools through a loopback MCP server with a per-request token (`mcp/toolServer.ts`); API providers go through the same ToolGate.<br>- Scope is pinned to the trigger chat by default; `all_chats` needs a native confirmation.<br>**Tests:** `tests/security/wa-tools.test.ts` (blocked names incl. send / mark-read / homoglyphs, scope pinning, sentinel chats never leak), `tests/security/tool-server.test.ts`, `tests/integration/pipeline-wa-tools.test.ts`, `waTools.test.ts`, `waReadClient.test.ts`.<br>**Calendar:**<br>- `@cocal/google-calendar-mcp@2.6.3` with a vendored, pinned patch (`vendor/calendar-mcp.patch.json`) that adds `status` + `ifMatch` to `update-event`, plus a fail-closed startup schema guard (`mcp/host.ts`).<br>- `get-event` / `update-event` are reachable only from the executor's write facade. `delete-event` is enabled nowhere.<br>**Tests:** `tests/integration/mcp-real-toolslist.test.ts` spawns the **real** patched and unpatched servers (initialize + tools/list only) and checks names, annotations and insertions. Also `host.v2.test.ts`, `writeClient.v2.test.ts`, `never-delete.test.ts`, `import-graph.test.ts`.<br>**Gaps:**<br>- Packaged smoke check 9 (the same assertions through the packaged exe) did not run (Smart App Control).<br>- No e2e drives the WhatsApp read tools; they are proven at integration level only.<br>- `ux-i18n-v2-5` residual: main's `settings:set` does not guard re-enabling a stored `all_chats` scope. The renderer narrows it now, but the main-side guard is still a REQUEST. |
| e | "**Built-in Whisper** to transcribe voice messages" (local audio always) | **met** (code level; never run on real audio) | **Pipeline:**<br>- `voice/ogg.ts`: bounds-checked Ogg parsing.<br>- `voice/decode.ts`: opus-decoder WASM (D-070).<br>- `voice/wav.ts`: writes the WAV.<br>- `voice/whisperCli.ts`: whisper.cpp b5130 as a job, fed only a WAV the app wrote.<br>- `voice/service.ts`.<br>Models are pinned by commit + size + sha in `vendor/models.pin.json` (smoke check 8 green) and downloaded on opt-in. Smoke check 7 hash-checks the packaged whisper binaries without running them.<br>**Tests:** `src/main/voice/*.test.ts`, `tests/integration/pipeline-voice.test.ts`, `tests/security/{media-isolation,media-text-isolation}.test.ts`. e2e `voice.spec.ts` passes 2/2 on the fake whisper.<br>**Open:**<br>- `ux-i18n-v2-4`: the onboarding voice opt-in lives only in window memory, so a restart mid-download forgets it.<br>- `VOICE_AUDIO_MISSING` ends as a terminal card instead of a queued retry (`v2-repair-v2-main-defects.md`).<br>- Real transcription quality and speed are unverified until M-VOICE-1. |
| f | "the ability to **read events from pictures**" (cloud vision of the active provider allowed) | **met** (code level; with a by-design caveat) | **Pipeline:**<br>- `agent/readImage.ts` (stage V1, zero tools on every provider): local reading uses the Gemma `mmproj` projector; cloud reading uses the active provider's vision, never Antigravity.<br>- `media/imageDims.ts` + `media/normalizeImage.ts`: header sniff + size caps before decode.<br>**Tests:** `readImage.test.ts`, `tests/integration/pipeline-image.test.ts`, `tests/security/vision-no-tools.test.ts`, `orchestrator.v2.test.ts:524`. e2e `pictures.spec.ts` 2/2 pass, including a flagged injection picture.<br>**Caveats:**<br>- `imagesPassed = false` for every provider. Until M-GOLDEN-1 plus a code change, **every picture-derived proposal carries the amber `image_unclear` badge** and is never automatic.<br>- Local picture reading needs an extra projector download.<br>- No real picture has ever been read by a real model. |

### v2.4 The original request, re-checked on the v2 tree

| # | Requirement | Verdict | Evidence / what changed since the v1 re-score |
|---|---|---|---|
| 1 | Minimal dashboard: "Needs reply" / "In calendar" / "Information missing" | **met** | Same three lists; the v2 AutoStrip sits inside "In calendar", so there is no fourth list. e2e `app.spec.ts:14` passes. Caveat (v2.2 #5): after an undo, an "In calendar" card can show stale content until a reload. |
| 2 | Hebrew + English | **met** (copy unreviewed) | `src/shared/locales/en.json` has 1367 keys and `he.json` 1379, with **0 missing in Hebrew**; the 12 extras are Hebrew dual plurals. e2e `i18n-rtl.spec.ts` 6/6 pass, covering the v2 AutoStrip, the Automatic-mode group, the Connect card and the media bubbles at 420 px. The Hebrew copy is agent-written and still needs the user's review (M12). |
| 3 | X minimises to the Windows 11 hidden-icons tray | **met** (caveat unchanged) | `app/window.ts installCloseToTray`, `app/tray.ts`. e2e `tray-lifecycle.spec.ts` 5/5 pass. Whether the icon lands in the overflow flyout is a per-user Windows setting, not the app's choice. |
| 4 | WhatsApp bridge = the user's prebuilt exe, as a managed child | **partial** (was met) | **Identity unchanged:** smoke check 4 hashed the packaged exe against the pinned SHA-256 (43,540,541 B; never executed). Spawn invariants: `tests/security/bridge-invariants.test.ts`.<br>**New defect, confirmed by this marker:** the startup orphan reaper's production query in `src/main/proc/reaper.ts` (`PS_QUERY_ARGS` + `'--', pid`) can never succeed.<br>- Mechanism: with `-Command`, PowerShell folds the trailing args into the script, so `$args[0]` is empty and `ConvertTo-Json` errors.<br>- Reproduced with the exact script string from `reaper.ts`, run against the test process's own pid: exit 1, empty stdout, stderr "ConvertTo-Json : The input object cannot be bound...".<br>- Effect: after an app **crash**, the next start never reaps an orphaned bridge, llama-server, whisper or CLI child.<br>- `reaper.test.ts` only uses a fake spawn, so it never caught this. First reported in `v2-fix-src-main-proc.md`; not fixed.<br>Normal quit and kill paths are unaffected and pass e2e. |
| 5 | Three LLM options: local (ready, laptop-suitable, downloaded on first run), Claude, Gemini | **met** (same real-world caveats as v1) | The v1 providers are unchanged; v2 adds the subscription CLIs (row c). The model manifest is pinned (smoke check 8 green). Still open from v1: the VC++ CRT DLLs are not staged (`vendor/llama/win-x64-vulkan/MANIFEST.txt` lists none; U10), and no real GGUF has been downloaded or run. |
| 6 | Google Calendar through MCP driven by the LLM (D-026) | **met** | The user confirmed U8 in the v2 request (D-036). The model gets read tools only. The app executes `create-event` / `update-event` only after an approval record: a click, or for creates a live automatic policy. Evidence: row d, plus v1's `tool-gate.test.ts` / `import-graph.test.ts`. Real Google has never been contacted (M5 / M6 / M-CAL-1). |
| D-002 | Approval-first | **met** | e2e `approval-first.spec.ts` 3/3 pass: nothing happens without approval; one click = exactly one send / one create-event; an obedient attacker model causes no side effect and gets the manipulation badge.<br>Automatic mode is the only v2 exception. It is granted only through the native dialog owned by main, with a ticked checkbox. The SQLite trigger bounds it, and it never covers `send_reply` (`auto-mode.i1-trigger.test.ts`).<br>Residual: `auto-mode-8` (row b) weakens the *consent* to automatic mode, not approval-first for sends. Fixed per the `v2-fix-*` notes: `auto-mode-6` (account binding) and `auto-mode-7` (the dialog now shows the widened scope). |
| D-003 | Personal-assistant profile | **met** | Unchanged: DMs only (ingest + S0), first-person drafts, unknown-sender and backlog gates. e2e `onboarding.spec.ts:245` (history sync → zero cards) passes. |
| D-004 | Embedded llama.cpp, hardware tiering | **met** (never executed) | Unchanged. Smoke check 4 confirmed all 24 llama files; check 7 confirmed the whisper and llama DLLs are not mixed. `llama-server.exe` was never run (hard rule). |

### v2.5 Review findings still open after the fix round (not fixed in code)

- `auto-mode-8` (major): Resume on a trial the app paused itself → real writes without "Turn on for real".
- `editing-undo-5` (major): no UI for the B24 in-calendar correction offer.
- e2e #1, #2, #4: no shutdown latch in `proc/jobRunner.ts` (REQUEST 10 class).
- e2e #5: cards keyed by event show stale content after an undo (renderer).
- e2e #3: stale test expectation (test owner).
- `reaper.ts` production query is broken (v2.4 row 4).
- `cli-sandbox-5` (minor): "Delete all data now" leaves the `<userData>\agy-home` conversation files in place (`db/retention.ts PURGE_NOW_DIRS`).
- `ux-i18n-v2-3(b)`, `-4` (restart), `-5` (main guard), `-8`, `-10` (no read channel for trial decisions): partial.
- db REQUEST: `src/main/index.ts` runs `app.whenReady().then(...)` with no `.catch`. A MigrationError on a real v3 → v4 upgrade becomes an unhandled rejection and no window opens. The data stays intact.
- When agy is installed, the agy sign-in probe still spawns at every launch (REQUEST in `v2-fix-src-main-llm.md`).

### v2.6 What only the user can do (needs_user_action), in addition to M1-M16

| Item | Why only the user |
|---|---|
| **Smart App Control on this PC.** It refused the packaged exe even when started as plain Node (smoke checks 1/2/9). The installed app, the bridge, llama-server and whisper-cli are all unsigned and **may be blocked at the first real launch (M9)**. Options (D-078): a Trusted Root Program certificate, or the user's own decision about SAC. An agent must never change SAC. | Security setting / paid certificate |
| **M9**: build the NSIS installer from the space-containing path, install it, start the GUI | Forbidden to agents |
| **M2/M3/M4/M16**: pair WhatsApp (own linked-device slot); one real approved reply, including an `@lid` contact | Real account, real messages |
| **M5/M6 + M-CAL-1**: create the Google OAuth desktop client. On a real test event, approve one create, one change, one cancel and one undo. Confirm the patched server honours `status` and `If-Match` (a 412 on a concurrent edit) | Real Google account |
| **M-CLI-1**: with the user's signed-in Claude Code, run the in-app provider test (headless flags, `auth status` fields, MCP token expansion, image input) | The user's subscription login; agents may not run `claude.exe` |
| **M-AGY-1** (only if opting in): install and sign in to `agy`, run the in-app test; confirm the empty tool set and the isolated profile | The user's Google login; the Terms grey zone is the user's call |
| **M7 / voice + projector downloads**: first real downloads from Hugging Face of the GGUF, the voice model (~1.6 GB), the VAD and the `mmproj` projector | First contact with the real CDN |
| **M-VOICE-1**: one Hebrew and one English real voice note | Real audio, real whisper |
| **M-GOLDEN-1**: `npm run test:golden:live --feature v1\|edits\|images\|voice` for each provider used, then a recorded decision and a **code change + rebuild** to flip `FEATURE_GATES` | The only path to automatic edits, automatic voice/picture events, and picture proposals without the amber badge |
| **M8/M15**: real `llama-server.exe` smoke per tier; Hebrew quality and tok/s on the laptop | Agents may not execute it |
| **U10 / VC++ redist**: supply `VC_REDIST_CRT_DIR`, or accept the detect-and-link posture | Points at a folder on the user's PC |
| **M12**: Hebrew copy review (now 1379 keys; the v2 screens are in the i18n-rtl screenshots) | Native-speaker judgement |

### v2.7 Honest bottom line

**Built and proven in the automated suite:**
- event editing with ifMatch, cancel-as-status and undo;
- an automatic mode whose rails are enforced by a pure gate *and* a SQLite trigger, never by a prompt, with replies structurally excluded;
- Claude Code and Antigravity as headless, tool-less completion backends behind an init-proof sandbox check, with the API-key providers kept;
- a read-only WhatsApp tool surface;
- a patched, schema-guarded calendar MCP server, checked against the real server's tools/list;
- local whisper voice transcription;
- picture reading with zero tools.

All 22 v1 e2e tests still pass, and approval-first holds in every test that probes it.

**Not done:**
- e2e is 41/46. Two product defects remain open: the stale card after an undo, and a CLI job/pid-file leak during quit (worse after the fix round). One e2e expectation is stale.
- Vitest is green only on the second run: four SQLite-heavy suites time out under full parallel load.
- The packaged smoke cannot run its three spawn checks on this PC.
- `auto-mode-8` (a paused trial resumes to real writes), the missing correction-offer UI, the broken crash-orphan reaper, and the other items in v2.5.
- **Automatic edits, automatic voice/picture events and picture proposals without the amber badge are switched off in this build.** Turning them on requires the user's live golden run followed by a code change.

**Unverifiable without the user's own hardware and accounts:** everything real.
- the bridge, WhatsApp pairing and sending;
- Google OAuth and any real calendar read / write / patch / cancel / undo;
- the user's `claude.exe` and `agy` sessions, and how the vendors' policies treat them;
- whisper on real audio;
- real model and projector downloads, Hebrew quality and speed;
- installer behaviour;
- whether Smart App Control lets the unsigned app start at all.

The suite proves the code does what ARCHITECTURE-v2 says. Only the user's own runs (the M-list above) can show the
product working on their machine with their WhatsApp account.
