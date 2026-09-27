# Agent notes - design-finalizer (workflow 1, last step)

Date: 2026-09-22. Task: evaluate the 38 adversarial-review findings, edit the design docs so they are consistent again, return the final work packages.

Context: a first run of this step hit the usage limit after editing `docs/specs/contracts.md` sections 1-11 (marked `[R2]`). This run finished contracts.md sections 11-18 and applied the matching `[R2]` edits to `docs/ARCHITECTURE.md`, `agent-pipeline.md`, `ux.md`, `test-strategy.md`, `build-plan.md`. contracts.md remains the single source of truth for shapes/DDL/constants; every other doc now says so in its header.

## Disposition of the findings

| # | Sev | Verdict | Where fixed |
|---|---|---|---|
| 1 | major | ACCEPTED (option "never authoritative") - markers are hints/annotations only; `logged_out` from REST only; `client_outdated` only selects the ErrorCode when the breaker opens; line-anchored matcher skips message-echo lines; `token_banner`/`invalid_port`/`token_too_short` accepted only while STARTING with no REST answer (they are printed before the REST server exists, so no message can be echoed yet) | ARCH 4.2-4.4, 14; CONTRACTS 12 `stdoutMarkers.ts`, 18 #10; TESTS 5.3, 6, 8.2 #3; PLAN W1-02, W1-09 |
| 2 | major | ACCEPTED - CAS in `repos.actions`, `inFlight` set before the first await, jitter after the write-ahead, CAS miss = `ACTION_STALE` never failed/clone | ARCH A11, 6.6; CONTRACTS 8 (`ApproveOutcome` note), 14, 15.1; PIPELINE 9; TESTS 5.3 `exec/*`, 8.2 #5; PLAN W1-04, W1-11 |
| 3 | major | ACCEPTED - hardened `trg_actions_state`, `failed` terminal, no return to `pending`, `approved_final_json` required, `trg_actions_frozen` extended (with the retention-NULL exception), new `trg_actions_final_frozen` | CONTRACTS 15.2 (binding text) + concern #8 resolved; ARCH 10 quotes it; TESTS `db/*`, 8.2 #5; PLAN W1-04 |
| 4 | major | ACCEPTED - explicit base URLs for both SDKs, env poisoning test, R4 residual documented | ARCH 8; CONTRACTS 9 (already in R2 pass 1); TESTS 5.3, 8.2 #10; PLAN W1-06 |
| 5 | major | ACCEPTED - `McpHost.callerFor(cls)` is the only exit, `McpToolCaller<C>` generic, facades take narrowed callers, fake implements `McpCallerSource` | ARCH A22, 5.2; CONTRACTS 11, 16; TESTS 5.3, 8.2 #1; PLAN W1-05, W2-01 |
| 6 | major | ACCEPTED - `eventIdFor(chainKey)` with chainKey = idempotency key without `:rN`; `waAction` = chain-root id; `id_exists` => done | ARCH I7, 5.4, 6.6; CONTRACTS 1, 11, 14; PIPELINE 9; TESTS 5.3, 6, 8.2 #6; PLAN W1-11 |
| 7 | minor | ACCEPTED - `userHasSentIn` excludes reactions/empty/deleted; OR over both JID forms | ARCH A13, 4.6; CONTRACTS 12; PIPELINE 3; TESTS 5.3; PLAN W1-03 |
| 8 | minor | ACCEPTED - retention nulls action payloads on terminal rows (trigger exception), `purgeNow` deletes backups + one fresh backup; `canonical_json` made nullable for that | ARCH 10; CONTRACTS 1, 15; TESTS `db/*`, 8.2 #9; PLAN W1-04 |
| 9 | minor | ACCEPTED - `tool_blocked` = `{nameSha8,nameLen,verdict,runId}`; `last_error`/`error_code` = ErrorCode only; logger hashes non-allowlisted tool names | ARCH 10, 14; CONTRACTS 1, 10 (pass 1); PIPELINE 6.2, 7, 9; TESTS 5.3, 8.2 #1/#9; PLAN W1-09, W1-10, W1-12 |
| 10 | minor | ACCEPTED (option "do not open server links") - main builds the day URL from `event_start_ts`; `htmlLink` diagnostics-only; bypass strings in the hardening test | ARCH 11; CONTRACTS 1, 8 (pass 1); UX 6.7; TESTS 5.3, 8.2 #12a; PLAN W1-13, W1-15 |
| 11 | minor | ACCEPTED - `paired_at` reset on every QR pairing, watermark reset in wipe, cloud release limited to 24 h (`LIMITS.heldReleaseWindowMs`), `items.heldWith(reason,{triggerTsSince})` | ARCH 4.3, 6.1, 11, 12.1; CONTRACTS 1 (META_KEYS note), 15.1; PIPELINE 3; TESTS 6, 8.2 #11; PLAN W1-02, W1-10 |
| 12 | minor | ACCEPTED (option "drop with_name") | ARCH 12.2, 13; CONTRACTS 4 (pass 1); UX 9, 12.3; TESTS 5.3; PLAN W1-12, W1-16 |
| 13 | minor | ACCEPTED - sheet initial focus = close button; renderer 500 ms guard; main 300 ms guard via `IpcContext.shownByNotificationAt` | ARCH 6.6, 13; CONTRACTS 1 `LIMITS` (pass 1), 8 `IpcContext`, 14; UX 6.8, 7, 12.3; TESTS 5.3, 8.2 #5; PLAN W1-11, W1-12, W1-13, W1-14, W1-15, W2-03 |
| 14 | minor | ACCEPTED - handler rejects `version !== CONSENT_VERSIONS[kind]`; `isCurrent` exact | ARCH 8, 11; CONTRACTS 8 (pass 1), 15.1; TESTS 5.3, 8.2 #10; PLAN W1-12, W1-13 |
| 15 | minor | ACCEPTED - `bad_endpoint` validation of `auth_uri`/`token_uri`/`auth_provider_x509_cert_url`/`redirect_uris` | ARCH 11; CONTRACTS 4 (pass 1); UX 8.3; TESTS 5.3; PLAN W1-05 |
| 16 | minor | ACCEPTED - `parsePidFile()`, argv-only PowerShell/taskkill, hostile pid-file tests | ARCH 10, 13; CONTRACTS 13; TESTS 5.3, 8.2 #8; PLAN W1-01 |
| 17 | minor | ACCEPTED - 404 + socket destroy without drain, timeouts, `bytesDrained` stat, 25 MB wrong-path test | ARCH 4.5; CONTRACTS 12 doorbell; TESTS 8.2 #7; PLAN W1-03 |
| 18 | blocker | ACCEPTED - OpenAI `json_schema` form; fake rejects a missing `json_schema.schema`; manual M15 | ARCH 8; CONTRACTS 9 (pass 1), 16; PIPELINE 10.2; TESTS 5.3, 12 M15; PLAN W1-07 |
| 19 | major | ACCEPTED, both options - CRT DLLs copied from `VC_REDIST_CRT_DIR` when the build PC has them (build warns otherwise) + `LLM_VCREDIST_MISSING` pre-flight/exit-code mapping; V5 rewritten | ARCH 9, 14, 15.2, 15.3, 19 V5; CONTRACTS errors (pass 1); TESTS 5.3, 12 M13; PLAN W1-07, W2-04, concern 10 |
| 20 | major | ACCEPTED - forbidden = direct deps + root-declared lockfile entries; no `binding.gyp` in the production tree; `ajv`/`ajv-formats` transitive allow-list; "6 direct deps (~143 packages)" | ARCH 15.3, 16; TESTS 8.2 #12a, 11; PLAN 2.1, W0, W2-04 |
| 21 | minor | ACCEPTED - `tests/setup-guards.ts` -> W2-02 only; `playwright.config.ts` -> W2-03 only; root configs listed; `.prettierignore` added | PLAN 1.2, 5, 6, W2-01/02/03 briefs |
| 22 | minor | ACCEPTED - literal source paths for LICENSE/README from the repository root; never glob `*.exe` | ARCH 4.1; PLAN 2.5, W0 |
| 23 | minor | ACCEPTED - `[.f{1,9}]`, nanosecond/zero-fraction/T-form test rows, fake DB emits go-sqlite3 form by default | ARCH 4.6; CONTRACTS 12, 16; PIPELINE 1.3; TESTS 3.1, 5.3 |
| 24 | minor | ACCEPTED - suffix rule for HF CDN hosts, one hop, `X-Linked-*` sanity | ARCH 9, 19 V12; TESTS 8.2 #12b, M7; PLAN W1-07 |
| 25 | minor | ACCEPTED (copy + M5); the upstream `--host` contribution is out of scope and not planned | ARCH 12.1, 19 V13; UX 8.3; TESTS M5 |
| 26 | minor | ACCEPTED - exact fixture, two failure modes | ARCH 15.4; TESTS 11 |
| 27 | minor | ACCEPTED - explicit file allow-list, `LICENSE-LLVM-OpenMP`, llama.cpp MIT text into THIRD_PARTY_NOTICES | ARCH 9, 15.2, 15.3; PLAN W1-07, W2-04 |
| 28 | major | ACCEPTED - 24 h cap only while syncing history / before first ONLINE; 7 d after; `older_message` raw cards; `meta.last_online_ts` | ARCH A14, 4.3, 4.6; CONTRACTS 1 (`LIMITS.syncMaxAgeMs`, `META_KEYS`, `BADGES`), 12 `Ingest`; PIPELINE 1.3; UX 6.6; TESTS 5.3, 8.2 #11; PLAN W1-02, W1-03 |
| 29 | major | ACCEPTED - `BridgeDb.phoneJidForLid`, `repos.chats.mergeLidInto`, `ingest.resolveLidChats()` on every ONLINE, `is_known` over both forms, V3 promoted to release-gate manual M16, share recorded in PROGRESS | ARCH A12, 4.3, 4.6, 19 V3; CONTRACTS 1 (pass 1), 12, 15.1; TESTS 5.3, M16; PLAN W1-03, W2-01 |
| 30 | major | ACCEPTED (1) prefetch moved to S2 (`PIPELINE 5.7`), (2) decision text written into ARCH A9 + U8 for the orchestrator/user to confirm, README sentence in W2-04; (3) optional S3-for-confirmations NOT adopted (extra LLM turn for a literal reading; the user can confirm otherwise) | ARCH A9, 5.4, 6.3, 6.4, 19 U8; CONTRACTS 10 (pass 1); PIPELINE 5.7, 6.1; TESTS 6; PLAN W1-10, W2-04 |
| 31 | major | ACCEPTED - all onboarding pictures cut; `resources/onboarding/**` removed from the layout, extraResources and the ownership matrix; W1-12 exports `tray.svg` for the inline glyph | ARCH 12.1, 15.2, 15.3, 18; UX 8.2-8.4, 12.2; PLAN 2.6, 4, 6, W1-12, W1-16, concern 6 |
| 32 | major | ACCEPTED - ARCH 13 is the rule: every X hides at once; toast on first hide; coach mark on next open; `app:ackTrayHint` only dismisses; C9 resolved | ARCH 13; CONTRACTS 8 (pass 1), 17 #6; UX 12.2, C9; TESTS 5.3; PLAN W1-12, W1-14, W2-03 |
| 33 | minor | ACCEPTED - `repos.actions.supersedePendingRepliesOfChat` in the ingest transaction; `in_calendar` affordance disappears | ARCH 4.6, 7; CONTRACTS 14, 15.1; PIPELINE 8.1; UX 6.7; TESTS 6; PLAN W1-03 |
| 34 | minor | ACCEPTED - block rewritten with `\u` escapes (the reviewer's own suggested text was garbled by the same pipeline; the escaped form here is authoritative) + unit test | PIPELINE 2; PLAN W1-09 |
| 35 | minor | ACCEPTED - presets are ordering hints intersected with the live list; `claude-haiku-4-5` dropped (pass 1) | ARCH 8; CONTRACTS 4; PIPELINE 10.2; TESTS 5.3; CONTRACTS 18 #9 |
| 36 | minor | ACCEPTED - `clipboard:writeText` everywhere | ARCH 11; UX 6.8; TESTS 5.3; PLAN W1-15 |
| 37 | minor | ACCEPTED - dual self-test on no-dGPU machines, both numbers persisted, suggest only when the better one is < 5 tok/s | ARCH 9; TESTS 5.3; PLAN W1-07 |
| 38 | minor | ACCEPTED with two keeps: `list_events`/share-titles, `local_only`, `with_name`, Alt+P/Ctrl+L/Ctrl+, and the time-zone picker are cut; the footer usage counter is cut but `cloudDailyTokenBudget` stays (it feeds `held/budget`); `chat:listPolicies` stays (the "never analyse" list needs it); the Ignored drawer becomes "Undo dismiss" (last 20 dismissed) so `dashboard:getIgnored` stays with a narrower contract | ARCH 5.3, 6.1, 12.2, 18; CONTRACTS (pass 1) 1, 4, 8, 10, 17; UX 5.5, 6.5, 6.10, 9, 13.2; PLAN W1-13, W1-15, W1-16 |

No finding was rejected outright. Two were narrowed (30 part 3, 38 partial keeps) - both recorded above with the reason.

## Things the orchestrator must do (I may not edit these files)

1. `ops/DECISIONS.md`: record D-020+ for every row above (at least: stdout markers demoted; CAS/trigger hardening; callerFor; chain-root eventId; v1 cuts of finding 38; pictures cut; X-always-hides; 7-day backlog window; CRT DLL policy; forbidden-package rule; "LLM via MCP = read-only tool calling + app-executed create-event").
2. Confirm with the user: U8 (reading of "calendar via the LLM's MCP"), U9 (the v1 cuts), U10 (CRT DLLs: does the build PC have a `Microsoft.VC143.CRT` folder? If not, only the pre-flight layer exists).
3. `ops/NOTES.md`: add V13 (Defender firewall prompt) and manual items M15/M16 to the tracked list.
4. Tickets T-100..T-120: briefs changed (see build-plan section 7 `[R2]` lines); the package list itself is unchanged (21 packages).
5. contracts.md header claims the `ts` blocks were re-checked by reading, not recompiled. W0 must run the section 18 consistency tests first and report drift in its notes (already stated there).

## Dead ends / assumptions

- I considered a SQLite "retention mode" flag checked by the trigger; main-database triggers cannot reference TEMP tables reliably, so the frozen trigger instead permits exactly one shape of change (NULLing on a terminal row with every other column unchanged). Simpler and testable.
- `fetch-llama.mjs` cannot extract the CRT DLLs from `vc_redist.x64.exe` (self-extracting MSI cabs) - hence the `VC_REDIST_CRT_DIR` env var + loud warning instead of a hard build failure.
- I kept `list-events` enabled at the MCP server because reconcile (`findAppEvent`) needs it; only the LLM-facing `list_events` tool is gone.
- The sanitizer block in agent-pipeline.md was replaced by line number (the literal invisible characters defeat exact-match editing) - verify with `cat -A` that it now contains only `\u` escapes (done).
