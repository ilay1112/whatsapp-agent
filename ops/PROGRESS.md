# Progress log

Newest at the bottom. Orchestrator-maintained.

## 2026-09-21

1. **Scouting.** Inspected the reference bridge repo (source only) and the empty project dir. Found: bridge = verygoodplugins/whatsapp-mcp Go bridge (REST + webhook + bearer token + SQLite). Found the dev machine had no toolchains at all. Noted the reference `store/` holds the live session → declared off-limits.
2. **Option dialog.** Asked 4 architecture questions; answers recorded in `ops/CONTEXT.md` / `ops/DECISIONS.md` (D-001…D-004).
3. **Toolchain.** Installed Node 24.19.0 + Git 2.55.0 via winget (both exit 0). `git init` done. `.gitignore` written (blocks store/, *.db, tokens, *.gguf, .env).
4. **Workflow ① launched** — `wa-agent-research-design`, run `wf_1004b6e0-b2d`, 23 agents: 10 research → 3 proposals → synthesis → 4 specs → build plan → 3 critics → finalizer. Status: **RUNNING**.
   - Script: `C:\Users\ilay1\.claude\projects\C--dev-whatsapp-agent\5fb5cd3d-975b-487a-978a-51cdf67aaeef\workflows\scripts\wa-agent-research-design-wf_1004b6e0-b2d.js`
   - Expected outputs: `docs/research/*.md` (10), `docs/proposals/*.md` (3), `docs/ARCHITECTURE.md`, `docs/specs/{contracts,ux,agent-pipeline,test-strategy,build-plan}.md`.
5. **Ops area created** per user instruction: `CLAUDE.md`, `ops/{CONTEXT,DECISIONS,PROGRESS,BOARD,NOTES}.md`, `ops/tickets/`, `ops/agent-notes/`.
   - Caveat: workflow ① agents started before `CLAUDE.md` existed, so they will not have written `ops/agent-notes/`; their outputs are the docs themselves. The orchestrator will back-fill a summary of their returned findings into `ops/agent-notes/workflow-1-summary.md` when the run completes. Workflows ② and ③ will carry the per-agent-notes rule in every prompt.

6. **Workflow ① partial result.** 13/23 agents finished (10 research + 3 proposals, ~2.4M subagent tokens, 32 min). The remaining 10 (synthesis, 4 specs, build plan, 3 critics, finalizer) failed with "session limit reached" — an account usage quota, not a design problem. Outputs on disk: `docs/research/*.md` ×10, `docs/proposals/*.md` ×3.
7. **Back-fill done:** `ops/agent-notes/workflow-1-summary.md` holds the digest of all research findings, the four cross-report conflicts (C1–C4) and two disclosed process incidents.
8. **Workflow ① resumed** after the user said "Retry" (same run id, task `w9vdmx9xh`). Research + proposals replay from cache; synthesis onward runs live. Status: **RUNNING**. These agents now receive `CLAUDE.md`, so they will write `ops/agent-notes/`.

## 2026-09-22

9. **Workflow ① second stop.** Resume got through synthesis (`docs/ARCHITECTURE.md`, 99 KB), the four specs and the build plan (19/23 agents, another ~2.2M tokens) before the session limit hit again at the 3 critics + finalizer.
10. **Third resume** (task `w2b60o89n`) after the user's limit reset — only critics + finalizer run live.
11. **Tickets created**: T-100…T-120 in `ops/tickets/`, one per build package, each pointing at its brief in `docs/specs/build-plan.md` §7. BOARD updated. DECISIONS D-009…D-019 recorded (A1–A23 accepted, four research conflicts settled, all nine build-plan concerns resolved). NOTES: U1–U7 open user decisions + orchestrator design review.

12. **Workflow ② script drafted** at `ops/workflows/wa-agent-build.js` (kept in the project per the user's rule): W0 alone → Wave 1 in two batches of 8 → repo-wide audit agent → fix round for failing packages → W2-01 → W2-02 ∥ W2-03 → W2-04. 22–38 agents depending on the fix round. Launches once workflow ①'s finalizer returns (it may still edit the specs).

13. **Critics done** (third resume): security 17 findings, requirements 11, feasibility 10 — 1 blocker, ~13 majors, rest minor. All raw findings back-filled to `ops/agent-notes/design-critique-findings.md`. Finalizer failed with an API 529 overload (not quota).
    - The blocker (feasibility): the spec's Local `structured` wire shape (`response_format:{type:'json_schema', schema}`) is silently ignored by llama-server b10964 → S1 extraction would run unconstrained on the default provider and every item would fail as `LLM_BAD_OUTPUT`. Fix = OpenAI form `response_format.json_schema.schema` + a fake-server contract test.
    - Other notable majors: llama-server MSVC build needs VC++ runtime DLLs (ship app-local or detect + link to Microsoft installer); `ajv` is an unavoidable transitive dep of the MCP SDK so the "forbidden packages" rule must mean *direct* deps; three docs disagree on the first-X close-to-tray coach mark; ~12 raster onboarding assets nobody can produce (→ SVG, D-018 already covers); two Wave-2 files have two owners.
14. **Fourth resume** (task `wk6fnx2rs`): finalizer only. It edits ARCHITECTURE + specs for every valid finding and returns the final package list.

15. **Workflow ① COMPLETE** — 23/23 agents over four runs (~6.3M subagent tokens total). Finalizer applied 7 groups of edits across ARCHITECTURE + all 5 specs (see `ops/agent-notes/finalise-design.md` and `design-finalizer.md`), rejected 1 finding, left U8–U10 for the user. Package list unchanged (21) → tickets T-100…T-120 stand. DECISIONS D-020…D-028 recorded.
16. **Workflow ② launched** — run `wf_4161a039-416`, task `w7cf1n7zm`, script `ops/workflows/wa-agent-build.js`. No baseline git commit was made (user has not asked for commits). Resume on a quota stop: `Workflow({scriptPath, resumeFromRunId: 'wf_4161a039-416'})`.

17. **W0 interrupted by the session limit** after 41 min / 184 tool uses. On disk: package.json + lockfile + node_modules (477 pkgs), all root configs, 153 files in `src/`, 28 in `tests/`. Missing: `wave0-seams.md`, bridge vendoring, calendar-MCP staging, W0 notes. Script got a RESUME NOTE telling W0 what exists; workflow resumed (task `wg7svgddq`).

18. **W0 interrupted again** (Fable model quota, 7.5 min in). It did complete deliverable 5: `resources/bridge/whatsapp-bridge.exe` copied, **hash verified by the orchestrator** = `ac23221e…2ff5`, 43,540,541 bytes — matches the pin exactly; never executed.
19. **Model switched to Opus 5** by the user; build agents inherit it. Resume note in the script rewritten to list exactly what remains (Go source vendoring, calendar-MCP staging, seams index, verify+notes). Workflow resumed (task `wx3uo5vsg`).

20. **W0 COMPLETE** (2026-09-22). Scaffold verified, bridge exe vendored + hash-checked, calendar MCP staged, seams index written. Notes: `ops/agent-notes/W0-scaffold.md`.
21. **Wave 1A COMPLETE** — all 8 packages returned `done` with their own tests green: W1-01-proc-health, W1-02-bridge-process, W1-03-bridge-ingest, W1-04-db, W1-08-shared-utils, W1-09-agent-guard, W1-12-shell-main, W1-14-renderer-shell. ~4.87M subagent tokens, 1583 tool uses.
22. **Wave 1B hit the session limit** — all 8 agents lost their return values, BUT most had already written code to disk (verified: `src/main/{mcp,llm,ipc,exec,agent}` implemented; 228 src files, 84 test files; only `compose.ts` + `notImplemented.ts` still carry stubs, which is expected — compose.ts is W2-01 work). Notes exist for W1-07 and W1-15.
23. **Resumed** 2026-09-23 (task `wnhrqgsa0`): W0 + Wave 1A replay from cache; Wave 1B re-runs live and continues from its partial work (builder rule: never restart from scratch).

## Cross-package requests raised by Wave 1A (audit + W2-01 must resolve)

- **Frozen-signature deviations needing ratification:** W1-01 added ADDITIVE OPTIONAL params to `createSupervisor`, `reapOrphans`, `freePort` for the TESTS 4.3 injection seams. All existing callers still compile.
- **Contract bugs found while building:** (a) CONTRACTS §12 `BridgeDb.userHasSentIn` SQL literal contradicts its own prose and A13 — implemented per ARCH 4.6 step 4; (b) CONTRACTS §15.1 `chats.mergeLidInto` asks to move action rows but `trg_actions_frozen` makes `chat_id` immutable (invariant I3) — implemented items-only; (c) `older_message` encoding in CONTRACTS §12 is structurally impossible as written — implemented as `analysis=held`.
- **Red tests flagged across package boundaries:** `doorbell.test.ts` (3 failures), `tests/mocks/electron.ts` missing helpers used by `app/*.test.ts`, `when.ts:252` + `when.test.ts` type errors, `db/repos/items.ts:33` conversion error.
- Full lists live in each `ops/agent-notes/W1-*.md`.

24. **Wave 1B + audit + fix round + integration COMPLETE** (2026-09-23, task `wnhrqgsa0`, 34/37 agents, ~5.2M tokens, 2 h). All 16 Wave-1 packages report `done` with their own tests green. Audit: lint exit 0, typecheck 2 errors, unit 1 failure — all attributed and handed to owners; 13 of 15 fix-round packages returned `done`, 2 `partial` for principled reasons (see D-034). Only 2 stubs left, both W2-01-owned and expected.
25. **W2-01 compose-integration COMPLETE** — the composition root wires every module; `npm run lint`, `typecheck`, `test` (main + renderer + integration) and `build` all exit 0 at its hand-off. `tests/helpers/harness.ts` (createTestApp over the real `compose()`) is live for the security gate.
26. **Orchestrator resolved the two escalations** (D-029…D-034): patched three genuine defects in `docs/specs/contracts.md` sections 12/15.1 where the spec contradicted itself and the code correctly followed ARCHITECTURE; ratified W1-01's additive optional params; dropped UX 7.4 `card.suggestedBy` from v1; endorsed W1-07's refusal to make a network call or fabricate a VC++ CRT pin hash.
27. **Final three launched** (task `weiz69h5k`): W2-02 security gate + W2-03 e2e in parallel, then W2-04 packaging.

### Known-open at this point (for phase 3)

- `npm run format:check` red on 14 files, all owned by W2-02/W2-04/W1-07 — their owners format them; `npm run verify` cannot pass until then.
- `tests/golden/golden.test.ts` still drives the real orchestrator directly instead of `createHarness()` (green either way; W1-10 follow-up now unblocked).
- `bridge-lifecycle.test.ts` covers ATTACH mode only at L3; child-process lifecycle is covered at L1/L2 and by W2-03 in child mode.
- `vendor/llama.pin.json` VC++ CRT hashes are null and unshippable pending U10.

28. **Workflow ② COMPLETE** (2026-09-23, task `weiz69h5k`, 37/37 agents, ~11.2M subagent tokens across 6 runs). Final three: W2-02 security gate **done, tests green**; W2-04 packaging **done** (lint 0, typecheck 0, 162 test files / 3660 tests, smoke 0, audit:prod 0 vulnerabilities); W2-03 e2e **partial — 16 passed / 6 failed, all six reported, none skipped or weakened**.
29. **Orchestrator ran `npx prettier --write .`** — format:check now clean (was 14 files red). Then ran `npm run verify`: everything green up to e2e; the 6 e2e failures reproduce exactly as W2-03 reported.

### What the e2e agent found — 3 real product defects (not test problems)

- **BLOCKER: the bridge is never started after the WhatsApp ToS consent is accepted.** compose() starts the launcher only if the consent already existed at startup, so on a fresh profile "Link WhatsApp" sits in `preparing` for ever and **a first run can never pair**. The app would be unusable out of the box. Caught only because the e2e suite drives a real fresh profile.
- **Tray labels do not follow a language change** (index.ts rebuilds the tray on health/pairing events only) — a direct miss of the multilanguage requirement.
- **The single-instance lock is skipped in e2e mode**, so two instances could write one app.db.
The other 3 failures are missing test seams (`__wcaTest` facade, openExternal/Notification recorders, the WCA_LLM provider override), all owned by W2-01.

### What the packaging agent found — 1 shipping blocker

- **The packaged app would contain no calendar server.** ARCH 15.2's verbatim `extraResources` cannot carry `build-resources/calendar-mcp/node_modules` because electron-builder drops a matcher's root `node_modules`. Google Calendar would be dead in the installed app while every test passed.

30. **Workflow ③ launched** — `ops/workflows/wa-agent-review.js`, run `wf_5d77946b-f94`, task `wn8lz2fej`: 4 repair agents (compose/product defects, packaging blocker, test fakes, renderer CSP) → full re-verify incl. e2e → 6 adversarial reviewers (approval-first, injection, pipeline correctness, process lifecycle, data integrity, UX/i18n) → one skeptic per finding who tries to REFUTE it → fixes by area → final acceptance against the original request into `docs/ACCEPTANCE.md`.

## 2026-09-24

31. **Phase ③ repairs COMPLETE (4/4).** All three product defects and the packaging blocker are fixed:
    - bridge now starts the moment the ToS consent is accepted (first run can pair);
    - tray rebuilds on the language event;
    - single-instance lock taken in e2e mode too;
    - `extraResources` corrected so the calendar MCP server actually ships — proven by the packaging smoke failing before and passing after, with a dedicated hard check added for the regression.
32. **Re-verify: lint 0, typecheck 0, format 0, unit 0 (3679 passed / 1 skipped), smoke 0. e2e improved 16→18 passed, 6→4 failed.** The reverify agent diagnosed all four remaining failures as **test-seam defects, not product defects**, each with a traced root cause:
    - 2 × stale assertion — the spec expects `llm.state==='ready'` but `idle` is the *correct* healthy lazy state for the local provider (OK_LLM allows both); the WCA_LLM seam is now wired, so the BLOCKED-BY comment was stale;
    - 1 × the fake bridge's control server lives inside the child and dies when `qr-new-code` legitimately restarts it — the spec never waits for it to come back;
    - 1 × created *by* the correct single-instance fix: the Playwright helper cannot attach to an instance designed to exit instantly; it must be spawned as a raw child process.
33. **Adversarial review: 45 raw findings from 6 lenses.** Each went to a separate skeptic instructed to refute it. First pass: 20 confirmed, 3 refuted, 22 verifiers lost to the session limit (re-running).
34. **Session limit hit again** during verification + fixes (34/68 agents, ~5.9M tokens). Resumed as task `wr349s2jy`.

### Confirmed defects the review caught (all traced to a specific file, all independently confirmed)

**Approval-first (the product's core promise):**
- A create-event retry re-uses the chain's deterministic event id even after the user *edited* the event, so Google's duplicate error is mapped to success and **the newly approved slot never reaches the calendar**.
- "Add anyway" is the one approval control that bypasses the renderer's focus-steal guard.
- Replying by hand from the phone leaves an approvable draft when an event is also pending → **duplicate reply possible** (found independently by two lenses).

**Prompt injection:** the draft stage never renders the app-computed resolved slot, so the model's only source for "which meeting, when" is the attacker-controlled transcript; and three mask/scrub gaps — U+2028/2029 line breaks can forge trusted-looking lines inside the data block, non-ASCII digits defeat the phone mask, and `evil。com` defeats both link gates.

**Pipeline correctness:** context lookup breaks after a LID→phone migration (empty context window); the queue deletes a row re-armed mid-run; the backlog gate makes the 7-day path unreachable on every first scan; validate overwrites row changes made during a run, **including re-opening a card the user dismissed**.

**Process lifecycle:** orphans are never reaped after a hard crash (timestamp compared against the wrong instant); the MCP host clears its exit callbacks before teardown so the supervisor force-kills **a PID the OS may have reused**; a latched circuit breaker can never be reset by any user action; the crashed BrowserWindow is never destroyed and has no crash-loop cap.

## 2026-09-27

35. **Verification of review findings COMPLETE** (task `wr349s2jy`): 45 raw → **38 confirmed, 7 refuted, 0 uncertain**. Severity after the skeptics' correction: **1 blocker, 26 major, 11 minor**. Full list with claims in `ops/PROGRESS.md` item 34 and the review files `ops/agent-notes/review-*.md`.
    - **The blocker** (data-integrity-2): `chats.mergeLidInto`'s `DELETE FROM actions WHERE chat_id=?` trips `ON DELETE SET NULL` → `trg_actions_frozen` abort, which **rolls back the entire ingest batch including the watermark** — so a single @lid merge could stall ingestion permanently. Directly caused by my D-031 (delete instead of move); the trigger interaction was not foreseen. Owner: `src/main/db`.
    - Refuted (7): the skeptics found an upstream guard, a DB constraint or an existing test for each; recorded in the verify results, not carried forward.
36. **Fix round partially done before the WEEKLY limit** (65/73 agents): 9 fix groups completed — eventId bound to approved content (approval-first-1), MCP host exit observation (process-lifecycle-3), supervisedLlama breaker bypass (-5), compose.start quitting guard (-7), ownResourcesDir/llamaDir (-9), renderer-crash recovery with crash-loop cap (-10), DST gap in `when.ts` (correctness-8), plus two compose wiring fixes. **7 groups + acceptance failed on the weekly limit**: db (incl. the blocker), renderer, agent, ipc, proc, bridge, compose/bridgeControl.
37. **Resumed 2026-09-27** (task `w47eq3t9j`) after the weekly reset: the 7 fix groups + acceptance run live; everything else replays from cache.
38. Known follow-up NOT covered by this workflow's Fix phase (it groups by confirmed *product* findings): the 4 remaining e2e failures are test-seam defects in `tests/e2e/**` (2 stale `ready`→`idle` assertions, 1 fake-bridge control-server race after a legitimate restart, 1 helper unable to launch an instance that correctly exits at once), plus REQUEST 3 from `repair-compose-defects` (permanent L3 regression test for consent→bridge-start in `tests/integration/`), plus the dead `frame-ancestors` console allow-list entry. → planned as a small workflow ④ after acceptance, since e2e cannot run concurrently with the acceptance agent's own e2e run.

39. **Phase ③ COMPLETE** (task `w47eq3t9j`, 73/73 agents, ~13.5M subagent tokens across 3 runs). Fix round: **16 groups, 55 fixes landed** for the 38 confirmed findings, incl. the blocker (db: `mergeLidInto` no longer trips the frozen-action trigger and cannot roll back an ingest batch). Several reviewer-proposed fixes were **rejected by the fixers with evidence** (e.g. widening `PHONE_RE` to an optional `+` would have masked every ISO date in a draft; a `queueMicrotask` in `llamaServer` would have broken an asserted contract) — each argued in its `ops/agent-notes/fix-*.md`. Four renderer findings turned out to be already fixed by the interrupted earlier run and were verified rather than re-done.
40. **Acceptance (hard marker): NOT ACCEPTED YET** — `docs/ACCEPTANCE.md`. At its run: lint 0, typecheck 0, vitest **3828 passed / 1 correctly-gated skip**, smoke 0 (all six checks incl. a real MCP handshake through the packaged exe), audit 0; **format:check red** (2 files, cosmetic) and **e2e red 18/22**. Requirements: GUI 1–3 **met**; bridge-as-exact-exe **met**; personal-assistant **met**; embedded llama.cpp with tiering **met**; three-LLM and calendar-via-MCP and approval-first **partial** only because there is no green e2e proof of the *positive* approval path yet (the *negative* invariant — nothing sent or written without a click — is green e2e and across `tests/security/`). Seven `needs_user_action` rows = the real-world checklist M1–M16.
    - The acceptance marker's own words, worth keeping: *"The suite proves the code does what the architecture says; it cannot prove the product works on the user's machine with the user's WhatsApp account. Do not read any 'met' as 'observed working'."*
    - It also re-flagged `onboarding.spec.ts:139` as "the only one of the four that may be a real defect" (undiagnosed ECONNRESET) — the reverify agent had traced it to the fake bridge's control server dying with a legitimate restart. Workflow ④ is told to verify the diagnosis against the code before touching anything.
41. **Orchestrator formatted the 2 flagged files** (`bridgeDb.ts`, `llamaServer.test.ts`) → format:check green again.
42. **Workflow ④ launched** — `ops/workflows/wa-agent-final.js`, run `wf_619acb69-597`, task `wqcwzrrzk`: e2e seams (4 failures + fixture hand-offs) ∥ hygiene (permanent L3 regression test for consent→bridge-start, fake-bridge `reviveDate`, coverage exclude glob) → final proof run of the whole pipeline. The acceptance report will be re-scored after it.

### Residuals from the fix round that need a product decision or a post-v1 ticket → T-401…T-407

43. **Workflow ④ COMPLETE** (task `wqcwzrrzk`, 3 agents, ~0.6M tokens, 49 min). **Final proof: ALL GREEN** — lint 0, typecheck 0, format 0, vitest **3837 passed / 1 correctly-gated skip** (169 files), **e2e 22/22 passed, 0 flaky, run twice**, packaged smoke 0 (seven gates), audit:prod 0. `npm run verify` exit 0. Report: `ops/agent-notes/final-proof.md`.
    - e2e seams: all four closed **without touching product code**; the `onboarding.spec.ts:139` failure the acceptance marker had called "possibly a real defect" was confirmed to be the fake bridge's control server dying with a *legitimate* restart — the spec now waits for a different bridge pid and a reachable control server. The second-instance test now spawns the instance as a raw child and asserts exit 0 + first window re-shown.
    - **Bonus found by the e2e agent once the specs ran past their precondition:** the two scripted approval specs had never seeded Google credentials, so "Add to calendar" was never offered and the positive create-event path had never actually been exercised e2e. Now seeded; the attacker spec is stronger for it (the gate now has a real create-event tool to withhold). Also: attach-mode fakes now ring the doorbell with the real webhook shape instead of relying on a 250 ms debounce window.
    - Hygiene: permanent L3 regression test `tests/integration/consent-starts-bridge.test.ts` (proven to fail with the fix reverted in a scratch copy, compose.ts sha256-verified untouched); fake-bridge `reviveDate`; `__fixtures__/` coverage exclude.
44. **Orchestrator re-scored `docs/ACCEPTANCE.md`** on the proof agent's measured numbers (see the addendum there). Verdict moves to ACCEPTED at code level; the real-world checklist M1–M16 is unchanged and still the user's.

## 2026-09-27 — v2

45. **Baseline commit made** (user approved). Tree was all-green.
46. **v2 request received** (see `ops/CONTEXT.md` "v2 request"): event editing, automatic mode, subscription-based cloud LLMs via vendor CLIs, WhatsApp MCP, built-in Whisper, events from pictures. Option dialog answered → D-036…D-041.
47. **Workflow ⑤ (v2 research + design) written** at `ops/workflows/wa-agent-v2-design.js`, modelled on ①: 8 researchers → 3 proposals → synthesis (`docs/ARCHITECTURE-v2.md` as an amendment set over v1) → 4 delta specs → build plan v2 → 3 critics → finalizer. Build (⑥) and review (⑦) follow the ②/③ pattern.

48. **Workflow ⑤ first run stopped at the session limit** (5/21 agents, ~1.9M tokens): research done for claude-cli-backend, event-editing, auto-mode-safety, image-events, whatsapp-mcp-readonly; gemini-cli-backend, cli-mcp-bridge, whisper-local + the whole design chain failed. Digest in `ops/agent-notes/v2-research-digest.md`. Resumed 2026-09-28.
    - Notable already: Claude subscription path = the user-installed **unmodified Claude Code CLI** spawned headlessly with a restricted, tool-less, session-less flag set (never the Agent SDK, never bundled) — with an explicit policy risk: Anthropic blocked third-party harnesses from Pro/Max on 2026-04-04; the single-user own-login CLI path fits the documented carve-out but must stay pluggable with the API-key fallback.
    - Event editing found a **decision blocker**: the shipped calendar MCP server's `update-event` has NO `status` field (zod strips it), so "cancel = status cancelled" needs either a 2-line vendored patch guarded by a startup schema check, or a soft-cancel (title prefix). → U11 for the user; default = vendored patch + upstream PR.

49. **Workflow ⑤ second run: all 8 research reports done** (~2.7M tokens); the design chain (proposals → finalizer) hit the session limit again. Resumed 2026-09-28 afternoon. Digest updated in `ops/agent-notes/v2-research-digest.md`.
    - **Gemini: the user's belief is verified.** On 2026-06-18 the open-source Gemini CLI stopped serving Google-login for free/AI Pro/AI Ultra accounts; those tiers moved to the **Antigravity CLI (`agy`)**. Gemini CLI now needs an API key / Vertex / business seat and has no schema flag. `agy -p --output-format json --json-schema` is the only no-API-key path — and a **policy gray zone** (Antigravity Terms §6 forbids third-party tools; forum staff answers say single-user headless use is fine but "cannot power third-party agents"; ban-wave precedent Feb 2026). Researcher recommends: opt-in "Gemini via Antigravity CLI (experimental)", OFF by default, with an in-app disclosure, tool-less, and keep the API-key Gemini provider as the supported path. → **U12 for the user**.

50. **Workflow ⑤ COMPLETE** (21/21 agents over 4 runs, ~10.3M tokens). `docs/ARCHITECTURE-v2.md` (B1-B32, invariants I1'-I7' + new I8-I12), four delta specs, v2 build plan (17 packages). Critics: 40 findings, 4 blockers; finalizer applied all valid ones (14 change groups), rejected 4, recorded F1-F40 in ARCH-v2 §19. Digest: `ops/agent-notes/v2-finalise-design.md`.
51. **User dialog on automatic mode** (2026-09-28): rails **as designed**; voice/picture events **may be automatic once the provider's golden gate passes** — this overrode the design's "never in v2.0". Orchestrator amended ARCH-v2 (B8, I12, D-044, U-v2-8/13), v2-contracts (`voicePassed` added to the gates), v2-pipeline G19, v2-tests (both gate states), v2-build-plan — 12 edits, none missed.
52. **Decisions recorded**: D-042…D-067 (drafted by the v2 synthesis/finalizer), D-068 (media auto after gate), D-069 (auto rails as designed), D-070 (**approved** the only new dependency `opus-decoder@0.7.12`, MIT/Apache-2.0, WASM, no native code), D-071 (remaining user decisions at defaults), D-072 (build-plan §8 + Wave-1 batching so Antigravity starts after the JobRunner).
53. **Tickets T-600…T-616** created from the 17 final packages. **Workflow ⑥ (v2 build) launched** — `ops/workflows/wa-agent-v2-build.js`: W0 → Wave 1A (6) → Wave 1B (6, Antigravity last) → audit incl. **v1-regression check against the baseline commit** → fix round → compose → security ∥ e2e → packaging → independent proof run.

## Next (state at 2026-09-27 — the automated operation is complete)

Totals: 4 workflows, **136 agent runs** (23 + 37 + 73 + 3), ~32M subagent tokens, 11 quota interruptions, 0 lost work (resume cache + on-disk continuation).

- **User:** run the manual real-world checklist M1–M16 in `docs/ACCEPTANCE.md` §3 (pair WhatsApp, Google OAuth client, first model download, NSIS build from the space-containing path, clean-machine run, Hebrew copy review). Nothing in it can be done by an agent by rule.
- **User decisions still open:** U8 (reading of "calendar via the LLM's MCP", D-026), U10 (`VC_REDIST_CRT_DIR`), T-401 (edited-retry double event), T-410 (dirty state after a successful approval). Defaults are in force for all four.
- **Baseline git commit:** none has been made in the whole operation — the user has not asked for commits. The tree is clean-green; one commit would freeze it.
- **Post-v1 tickets:** T-402…T-405, T-407…T-409, T-411 (`ops/BOARD.md`).
