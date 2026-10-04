# V2-W1-03-edit-pipeline - agent notes

Package: `V2-W1-03-edit-pipeline` (build plan section 7). Status: **DONE for everything this package can prove on its own**; the
compose-level tests are written and red only because of the BLOCKED-BY list below (DoD 1.1 (e)).
Two runs: the first (interrupted) wrote the bodies of `resolveDelta.ts`, `existingEvent.ts`, the `prompt.ts` switch, `extract.ts`,
`contextBuilder.ts` and `validate.ts`; the second (this one) fixed two type errors in them (ActionId is a string), wrote the v2
orchestrator, the queue delta, every test file and the golden assets, and verified.

## What was built (owned paths only)

| File | What |
|---|---|
| `src/main/agent/existingEvent.ts` | `findExistingEvent` (P2 7.1 / C2 15) over `items.newestEditableEvent` + `countEditableEvents` (F31) + `byCalendarEventId`; content = the newest DONE create / update (`to`) of THAT event id re-validated with `ActionPayloadSchema` (never a proposal's model text); fail closed on a non-Google id, missing/retention-nulled JSON or a cancelled event; `originItemId` = `event_origin_item_id` (F27). `existingEventBlock` builds the data-block projection key by key (no id of any kind). Read-only. |
| `src/main/agent/resolveDelta.ts` | pure R1-R13 (P2 7.2) incl. R6 duration-only (F40), R7 nearest-candidate ambiguous hour, R8 cancel-naming-the-event, R10 he/en weekday words, R11 sanity (DST gap, 12 months, 5 min-12 h), R13 suppression (F32, `opts.rejectedTos`), the picture date/time of P2 7.4 (`opts.image`). `resolveDeltaOutcome` returns P2's `DeltaOutcome` (keeps `v1` vs `no_change` apart - S4 needs it); `resolveDelta` / `toResolution` give the frozen C2 `DeltaResolution`. |
| `src/main/agent/prompt.ts` | `buildSystemPrompt()` switched to the W0 v2 constants: S1 = `SYSTEM_PROMPT_EXTRACT_V2` + rule-6a v2 + `EXTRACT_V2_ADDENDUM` (its last line = the CLI JSON-only line), S3 = `SYSTEM_PROMPT_DRAFT_V2`, V1 = `V1_READ_IMAGE_SYSTEM` + JSON-only line (C2 9.2) with no reply-language / gender line. One constant per stage for every provider (B15/B29). |
| `src/main/agent/extract.ts` | strict v2 `ExtractionSchema` for every provider; `stripOneCodeFence` (exactly one leading + one trailing fence; two fences stay unparseable => repair turn => `bad_output`); `onSandbox` forwarded into `CallOpts`. |
| `src/main/agent/contextBuilder.ts` | S1/S3 blocks are objects `{app_context:{note, existing_event}, [app_computed], messages}`; rows carry `source` (+ `language` for transcripts, whisper code mapped to he/en/other); audio rows without a done transcript are omitted; `imageText` + `imageKind` on the picture's own row (concern 7), sanitised + capped; head line `existing event: yes/none`; `app_computed.delta` (+ `proposed_slot` = the delta's `to`); `contextFromMeRecent`, `voiceInWindow`, `imageInWindow`, `mediaTexts`. |
| `src/main/agent/validate.ts` | P2 9: `update_event` insertion (all five conditions, mutually exclusive with `create_event`, only action of a self run), outcome table of P2 7.2 on the item, badges `change_unclear` / `change_target_unclear` / image badges / `time_assumed` / `conflict` of a delta, `change_in_google` only for a degraded update surface, leak guard `crossChatLeak`, provenance columns, taint in the same transaction, `trigger_kind` rewrite, `linked_item_id` set/cleared, `providerClassOf` (antigravity always `cli_unproven`). |
| `src/main/agent/orchestrator.ts` | P2 1 order: V0 (`deps.voice.transcribeChat`, `onTranscribing`) -> transcripts attached from app.db -> existing event -> self trigger (F28) -> V1 (`pickImage` + `readImage`, cached read reused, failure never blocks S1) -> P2 3.4 re-check (empty note => closed `not_needed` with 0 LLM runs; failed transcript only => raw card with its `VOICE_*`; F33 deferral => re-queued) -> S1 (sandbox proof recorded with `runs.finishCli`) -> S2 (`resolveExtractionWithImage` + `resolveDeltaOutcome`; free/busy for the new slot minus the own block) -> S3 (skipped on a self run; delta view) -> S4 -> **S5a `tryAuto` for each pending calendar action BEFORE `dashboard:changed`** (a throw never costs the manual card). Every v2 dep is optional with a fail-closed default (`createOrchestrator` accepts `OrchestratorDepsIn`). |
| `src/main/agent/queue.ts` | `QueueStats.transcribing` + optional `TriageQueue.setTranscribing(seconds|null)` (numbers only) for `queue:changed`. |
| `src/main/agent/gates.ts` | unchanged W0 fail-closed constants; `gates.test.ts` pins every value and lints that a `true` carries `// D-0nn` on its line. |
| tests | `existingEvent.test.ts`, `resolveDelta.test.ts` (one row per rule), `validate.v2.test.ts`, `orchestrator.v2.test.ts`, `gates.test.ts` (new); `prompt.test.ts`, `prompt.size.test.ts`, `prompt.purity.test.ts`, `contextBuilder.test.ts`, `extract.test.ts`, `validate.test.ts`, `queue.test.ts` (extended). |
| golden | `tests/golden/edits.jsonl` (the 27 P2 15.3 rows in the loader's on-disk format, anchor 2026-09-21T07:00Z, JIDs ...0060-...0086), `tests/golden/tools.jsonl` (the 2 wa_row injection rows), `tests/golden/golden.v2.test.ts` (parts 1-4), `tests/golden/golden.live.test.ts` v2, `tests/golden/testDb.ts` (`seedCalendarEvent`), `tests/helpers/goldenLoader.ts` v2 (types, `goldenWindow`, `checkEditsCorpus`, `lintGoldenCase`, `loadToolCases`), `tests/fakes/stub-llm.ts` (`fromGoldenCase` v2 with provider identity + V1 rule from `imageRead`; `toCliScript` was already there from W0), `tests/integration/pipeline-edit.test.ts`. |

## Verification (2026-09-29, after the last edit)

- `npx vitest run --project main` : 169 files, 4,588 passed + 1 expected fail (the W0 `it.fails` R-PROMPT-SIZE pin) - all green.
- Integration v1 pipeline suites + `golden.test.ts` + `fakes-v2.test.ts`: 7 files / 126 tests green.
- `golden.v2.test.ts` (through a scratch vitest config, see REQUEST 1) : parts 1 (27/27 rows + the degraded-surface check), 2a (27/27
  parity rows) and 4 (loader, ids, lint, voice 12 = 4/4/4, images 24 with 4 injection, tools) green; parts 2b (8) and 3 (13) red - BLOCKED.
- `pipeline-edit.test.ts` : 3 green (no_change, change_unclear, two events), 6 red - BLOCKED.
- `npx tsc -p tsconfig.node.json / tsconfig.tests.json` : no error in owned files (remaining errors: `src/main/exec/actionExecutor.fixtures.ts`
  (V2-W1-04, `AutoScope` / `Extraction` not exported from shared/types) and `src/main/agent/readImage.ts` (V2-W1-08)).
- `npx eslint --max-warnings 0 <owned paths>` : clean. `prettier --write` run on owned files EXCEPT `existingEvent.ts` / `resolveDelta.ts`
  (they hold C2-verbatim blocks; see W0 REQUEST 2).
- Coverage (main project, owned files): `resolveDelta.ts` 100/100/100; `validate.ts` 100 / 99.1 / 100; `existingEvent.ts` 100 / 90 / 100;
  `orchestrator.ts` 97.7 / 93.6 / 94.7; `queue.ts` 97.3 / 96.7 / 100; `prompt.ts`, `contextBuilder.ts`, `extract.ts`, `gates.ts` 100.
- `golden-live` project run WITHOUT `WCA_GOLDEN_LIVE` only (the guard tests; the live suite skipped - no model, CLI or whisper touched).

## Decisions / assumptions (for the orchestrator)

1. **`DeltaOutcome` alongside the frozen `DeltaResolution`.** C2 folds `v1` and `no_change` into `none`, but R5 needs them apart (a
   `no_change` about the event must suppress the v1 slot proposal, P2 concern 5). `resolveDeltaOutcome` returns P2's union; the frozen
   `resolveDelta` maps it with `toResolution`. No frozen name changed.
2. **R7 assumption value.** `ASSUMPTIONS` (C2, closed set) has no `hour_assumed_near_existing`; the pick is recorded as
   `hour_assumed_pm|am` - same amber `time_assumed`, same AutoGate fallback. If the orchestrator wants the P2 value, it is a C2 change.
3. **Self trigger (F28) detection lives in the orchestrator** (`selfTriggerRow`): the newest window row is from_me text (or a from_me voice
   note with a done transcript), not an app send (recorded `waMsgId` or approved text of an executing/done/unknown `send_reply` of the open
   item or of the event's source item), and the chat has an editable event. `needsReply` forced false, S3 skipped, S4 inserts only an
   `update_event`, anything else closes `not_needed`. The ENQUEUE side is ingest's (REQUEST 3).
4. **Trigger rows** of the P2 3.4 re-check / V1 = the inbound rows from the item's `trigger_msg_id` on (fallbacks: rows at/after
   `trigger_ts`, then the newest inbound). V1 reads only the newest picture among them (older pictures: caption only).
5. **Cached picture read (P2 4.1).** `proposals.image_json` holds the bare `ImageRead` (C2 `Proposal.imageRead`), not P2's
   `{waMsgId, route, read, ms}`; reuse is therefore "`pickImage` returned null AND `media_cache` has the row AND the item's current proposal
   carries a read". If P2's richer shape is wanted, it is a C2 / W1-01 change.
6. **CLI provenance.** `cli_proven` needs every S1/S3 run proven (P2 9.4 / C2 wording "S1 AND S3"). S1's proof arrives through
   `onSandbox` and is written with `runs.finishCli`; `DraftInput` has no `onSandbox` yet (REQUEST 4), so an ok `agentic` draft counts as
   proven (draft.ts discards every agentic run whose `sandboxOk` is false) and S3's `sandbox_ok` column stays NULL until W1-06 forwards it.
   V1 runs are not counted (C2 names S1 and S3 only).
7. **`updateSurfaceAvailable`** is an extra optional orchestrator dep (not in the frozen seam); default `false` degrades every delta to the
   v1 `change_in_google` card (fail closed). `calendarConnected` is now `gate.exposedTools()` containing `get_freebusy` (v1 counted any tool,
   which the WhatsApp tools would now satisfy).
8. **v1 closure kept.** On the v1 path S4 uses `closureFor` unchanged; only the retired badge is gone. Consequently the four v1 golden rows
   `he-05`, `he-10`, `en-05`, `en-06` no longer expect `change_in_google` (B20 / P2 concern 9) - edited in `he.jsonl` / `en.jsonl` (owned).
9. **Golden on-disk format.** edits/tools rows use the loader's GoldenCase format (as W1-07's voice.jsonl does), not P2's raw rows: the
   P2 `harness.recentMe` context row is added by `goldenWindow()` at run time; `expect` carries `eventState`/`needsReply`/`intent` as the
   loader requires; every other P2 15.2 field is kept verbatim. Event ids in fixtures are `evtsrc<n>` because P2 15.2's `exist<n>` is not
   in Google's alphabet (`x` > `v`) and `GOOGLE_EVENT_ID_RE` would refuse it.
10. **golden.v2 part 1 runs at orchestrator level** (real repos + real ToolGate + stub transport), because the harness/compose route of the
   same rows cannot produce an `update_event` until W2-01 wires the v2 deps; the compose route is `pipeline-edit.test.ts` and parts 2b/3.

## Dead ends

- Bash heredocs with backticks / `${}` inside `node -e` strings: several patch attempts silently did not match; switched to the Edit tool
  or Write-then-run scripts. One earlier tool pass had turned ` ` inside `validate.ts` PHONE_RE into a literal NBSP (eslint
  `no-irregular-whitespace`); restored byte-identical to HEAD. Likewise a literal U+2028 in a test regex broke the esbuild transform - the
  tests now build those characters with `String.fromCharCode`.
- `vitest --project integration tests/golden/golden.v2.test.ts` finds no file: the frozen config does not collect it (REQUEST 1). Verified
  through a scratch config in the session scratchpad that only overrides the integration `include`.

## REQUESTS

1. **V2-W2-01 (vitest.config.ts, frozen in Wave 1)** - add `tests/golden/golden.v2.test.ts` to the `integration` project's `include`
   (today only `golden.test.ts` is collected, so part 1/2a/4 do not run in `npm test`).
2. **V2-W2-01 (compose.ts)** - pass the v2 orchestrator deps: `updateSurfaceAvailable: () => mcpHost.updateSurface().available` (or the
   equivalent), `tryAuto: (id) => executor.tryAuto(id)`, `voice: voiceService`, `readImage: createReadImageStage(...)`,
   `pickImage: createPickImage(...)`, `onTranscribing: (s) => queue.setTranscribing?.(s)`, `featureGates: (p) => FEATURE_GATES[p]`, and
   forward `QueueStats.transcribing` into the `queue:changed` push. Without `updateSurfaceAvailable` no `update_event` is ever proposed.
3. **V2-W1-07 (bridge/ingest.ts)** - the ENQUEUE half of the self trigger (F28, P2 2 item 5): in `handleOutbound`, when the row is not an
   app send and `findExistingEvent(repos, chat.id, now) !== null`, keep the item OPEN (do not set `closedReason: 'answered_elsewhere'`),
   supersede only its pending `send_reply`, open an item for the row when none is open (`trigger_msg_id` = the row), and enqueue the chat.
   The orchestrator then runs it as a self run (only `update_event`, no S3). A from_me voice row qualifies once its transcript is done.
4. **V2-W1-06 (agent/draft.ts)** - add `onSandbox?: (p: CliSandboxProof) => void` to `DraftInput` and forward it into the `CallOpts` of
   `runAgentic` / the prefetch `structured()` call, so the S3 run's proof lands in `runs.sandbox_json` (the orchestrator already passes it).
5. **Orchestrator (spec)** - R-EVAL-LEAK: the F28 row `he-self-01` ("...נעשה את זה ב-5 במקום") shares a 12-char window with the verbatim
   S1 few-shot input "נעשה את זה ב-6 במקום" (P2 6.2 says no 12-char window of a 15.3 message may occur in a few-shot input). Fix either
   byte set; `prompt.test.ts` exempts exactly that row and has a companion test that turns red once the spec is fixed.
6. **Orchestrator (spec)** - R-PROMPT-SIZE (W0 REQUEST 1) is still undecided: the assembled S1 v2 prompt is ~12.5 KB; the W0 `it.fails`
   pin in `prompt.size.test.ts` is kept as is (it passes because the < 8 KB assertion fails). Flip it to `it` once the decision lands.
7. **V2-W2-02 (injection-corpus.test.ts)** - the v2 vectors (`wa_row`, `voice_transcript`, `image_text`, `existing_event_title`,
   `cli_output`) are not delivered by the runner's `deliver()` yet (24 cases "the model was never called"); `tools.jsonl` holds the two P2
   15.3 wa_row rows for it.
8. **V2-W1-04** - `src/main/exec/actionExecutor.fixtures.ts` imports `AutoScope` / `Extraction` from `shared/types` (typecheck errors).
9. **V2-W2-01 / W2-04 (golden.live)** - the live runner builds the provider through `createProviderFactory` with a partial deps object
   (as the v1 file did); before M-GOLDEN-1 it needs the real `makeLocal` / `makeClaudeCli` / `makeAgy` wiring (a compose-level helper).

## BLOCKED-BY

- **V2-W2-01** - `tests/integration/pipeline-edit.test.ts` (6 of 9: reschedule, move, duration-only, self trigger, reject, approve) and
  `golden.v2.test.ts` part 2b (harness `cli` option / providers) and part 3 (auto pass through the IPC path + dialog script); also the
  config include of REQUEST 1.
- **V2-W1-04** - approve / reject of an `update_event` (pipeline-edit "approve", "reject") and `tryAuto` / AutoGate verdicts (part 3).
- **V2-W1-06 / V2-W1-09** - the spawned CLI fakes for parity part 2b; **V2-W1-07** - the ingest half of the self trigger (pipeline-edit
  "self trigger").
