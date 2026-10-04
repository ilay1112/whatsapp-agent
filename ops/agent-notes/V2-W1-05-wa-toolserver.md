# V2-W1-05-wa-toolserver - working notes

Package: tool gate v2 + the four read-only WhatsApp tools + the app-hosted MCP tool server (build plan section 7,
"V2-W1-05-wa-toolserver"). Run 2026-09-28/29 (resumed after a usage-limit interruption; no earlier notes existed and every owned
file was still the W0 stub, so the work started from the stubs).

## Status

Done, with the BLOCKED-BY items below (all caused by other packages' stubs or by frozen Wave-1 files owned by Wave-2 packages).

- `npx vitest run --project main` (whole project): 156 files, 3949 passed, 1 expected fail, 0 failed.
- `npm run typecheck`: clean (whole repo, at the time of the last run).
- `npx eslint <owned paths> --max-warnings 0`: clean. `prettier --check <owned paths>`: clean.
- Coverage (T2 13 safety set, 100/95/100 perFile) over the colocated unit tests: `toolServer.ts`, `waTools.ts`, `handles.ts`,
  `waReadClient.ts`, `toolGate.ts`, `toolDefs.ts` all 100 % lines / functions and >= 95 % branches (vitest `skipFull` hides them);
  `toolGate.window.ts` 100 %; `bridgeDb.ts` (not in the safety set) 100 % lines, 91 % branches.
- Security: `tool-server.test.ts` 9/9 green; `wa-tools.test.ts` 5/6 (1 BLOCKED-BY V2-W1-03); `tool-gate`, `redaction`,
  `import-graph`, `prompt-purity`, `fixtures-synthetic`, `setup-guards.v2` green.
- `npm run bench:wa` (U-D1, 10^6 rows): green. Measured (ms, dev PC): seed 3581, recentDmChats(30) 110, messagesBefore(big,null,60) 1,
  messagesBefore(big,mid,60) 26, messageByRowid 0, searchContent(all,miss) 176, searchContent(big,miss) 291,
  searchContent(all,hit) 1, facade.chatMessages(21) 1, facade.search(miss) 321. => U-D1 closed: the GROUP BY costs ~0.1 s on 10^6 rows.

## What was built (owned paths)

- `src/main/agent/toolDefs.ts` - the zod-first READ table: `READ_TOOLS` with real `execute` (calendar: pin + clamp -> McpReadClient ->
  projection; WhatsApp: delegates to `waTools.executeWaTool`), `toLcd()` (C2 10 rules 1-3: `$schema` stripped at the ROOT only,
  `required: []` added, exactly the zod safe-integer bounds dropped on `integer`, v1 key order re-emitted, THROWS on every other
  keyword / type array / nested object without `additionalProperties:false`), `llmToolOf()` (LCD derived once per zod object, READ table
  derived at module load so a non-LCD shape fails at load). v1 literals byte-identical (test). `V1_READ_TOOLS` deleted.
- `src/main/agent/toolGate.window.ts` [new helper, rule-8 name] - the v1 calendar clamps / pins / busy projection moved verbatim out of
  toolGate.ts (+ `isSameSlot` for `excludeSelf`), so toolDefs.ts and toolGate.ts share them WITHOUT an import cycle (toolDefs -> toolGate
  value import would have been a TDZ hazard because toolGate's top level reads `READ_TOOL_NAMES`). `toolGate.ts` still exports the frozen
  `constrainReadArgs` (a thin function with the frozen signature).
- `src/main/agent/toolGate.ts` - v2 gate: `exposedSpecs()` (B29: env has no policy field; scope read only when WhatsApp is available),
  `exposedTools() = exposedSpecs().map(llmToolOf)`, `invoke()` (BLOCKED_NAMES case-insensitive + every non-READ name =>
  `blocked_unknown_tool` + strike; unexposed => `blocked_not_exposed` + strike; budgets per tool + `draftToolCalls` 6 across backends;
  zod strict parse => `blocked_bad_args`; budget taken BEFORE the first await (two concurrent MCP calls cannot both pass), given back when
  `execute` answers null (bad handle / bad query / bad window); facade throw => `unavailable`; outer try/catch => never throws),
  `prefetchFreeBusy(..., excludeSelf)`, `prefetchWaContext(ctx)` (same execute + projection + nonce wrap, budget-free, always chat_1).
- `src/main/agent/handles.ts` - run-scoped `chat_N` / `m_N`, trigger pre-seeded as `chat_1`, strict regex before lookup, no reverse lookup.
- `src/main/agent/waTools.ts` - `executeWaTool` for the four tools + `projectWaRow` + `normalizeWaQuery`: pinning through the handle
  table, sanitizeForModel per row, role labels, `ago` + coarse `day` (run zone, UTC fallback for an unusable zone), caps
  (20/10/8/500/4000), result fitted to `waResultChars` with the LONGEST legal handles and real handles handed out only to rows that
  survive the cut (a dropped row never gets a resolvable handle), `waRowsServed` / `crossChatRows` / `otherChatTexts` for S4.
- `src/main/bridge/bridgeDb.ts` - the four SELECT-only methods (bound parameters only, rowid-ordered, aliasJids for the @lid twin,
  `SQLITE_BUSY`/`SQLITE_LOCKED` => [] / null) and the `filename` column on every SELECT (a store without the column reads NULL; probed once
  per connection like `whatsmeow_lid_map`).
- `src/main/bridge/waReadClient.ts` - the READ facade: DM JIDs only, `policy 'never'` / unknown-sender chats invisible (unless
  `processUnknownSenders` or `forceKnown`), deleted / reaction / sticker / media-only / unparseable-timestamp rows invisible, audio only via
  a DONE transcript (looked up under the row JID, then the app chat JID), window in TypeScript via `parseBridgeTs`, over-read + paging
  with a 2,000-row scan cap, scope re-check in `search` and `context`, busy => empty.
- `src/main/mcp/toolServer.ts` - B16 listener (see design notes below).
- Tests: `toolDefs.test.ts`, `toolGate.test.ts` (+ v2 blocks), `toolGate.corpus.test.ts` (v2 shape + families), `handles.test.ts`,
  `waTools.test.ts`, `waReadClient.test.ts`, `bridgeDb.test.ts` (+ v2 block), `toolServer.test.ts`, `tests/security/tool-server.test.ts`
  (group 19 minus the spawned-CLI chain), `tests/security/wa-tools.test.ts` (group 20), `tests/integration/pipeline-wa-tools.test.ts`,
  `tests/bench/wa-bridgedb.bench.test.ts`.
- Test assets: `tests/fakes/mcp-client-core.mjs` (SDK Client + StreamableHTTPClientTransport, loopback-only, `errors` from `onerror`),
  `tests/fakes/fake-mcp-client.ts` (`rawProbe` over a plain socket with every placeholder of the matrix; `INITIALIZE_BODY`),
  `tests/fakes/fake-wa-read-client.ts` (scripted recording double, `fakeWaMessage`), `tests/helpers/waWorld.ts` (`seedWaWorld` = the
  T2 3.5 world; `createWaToolRig` = the production read path for security / integration tests), corpus JSONs (+34 cases).
- One-line edit in `tests/integration/fakes-v2.test.ts` (W0 file, "owners split it"): my `rawProbe` assertion now expects
  `{status:'refused'}` instead of NotImplemented. No other line touched.

## Design decisions / deviations (for the orchestrator; all inside owned files)

1. **toolServer answers `tools/list` and `tools/call` with its own request handlers on the per-request `McpServer`, not through
   `McpServer.registerTool()`.** Verified in SDK 1.30.0 `server/mcp.js`: the registered-tool path answers an unknown tool name itself
   ("Tool x not found") and rejects bad arguments itself (`validateToolInput`) - both WITHOUT calling our callback, i.e. without
   `ToolGate.invoke`, so the strike, the `tool_blocked` audit and `blocked_bad_args` would be lost, contradicting T2 group 19 ("every
   tools/call -> exactly one gate.invoke"; attacker names => one audit row each). Also the SDK would re-derive the JSON schema from zod
   (with `$schema` and the safe-integer bounds), not the gate's LCD bytes. `tools/list` therefore serves the run's `specs` (captured at
   start) with `deps.gate.exposedTools()` LCD schemas (byte-identical on the wire - tested), all `readOnlyHint:true`. Still one new
   `McpServer({name:'wca'})` + one new stateless transport per HTTP request (F22). The C2 text "registerTool(spec.name, ...)" is the only
   thing not followed literally.
2. toolServer takes no VALUE import from agent/** (C2: "values arrive by injection"): schemas come from the injected gate.
3. Over-cap bodies (64 KiB + 1 .. 256 KiB) are read and discarded before the 404 + destroy: destroying a socket with unread input makes
   the peer's stack drop the 404 it already received (RST; reproduced on Windows - the matrix row `body_64k_plus_1` then read 'reset').
   A body declared or streamed past 256 KiB is reset at once (never drained).
4. `requireHostHeader: false` (else Node itself answers 400 for a missing Host - the matrix wants our 404); `headersTimeout` 2 s,
   our own body timer 2 s (=> reset), Node's `requestTimeout` 3 s as a backstop only; `clientError` => destroy (no 400 page).
5. Any listen error on a candidate port => next candidate (not only EADDRINUSE); after `FREE_PORT_MAX_ATTEMPTS` or when `freePort()`
   throws => `ToolServerPortError` (`code 'EADDRINUSE'`, `attempts`). NEVER_PORTS re-checked on every candidate.
6. New exports (additive): `toolServer.ts` `ToolServerPortError`, `setToolServerListenerRegistry`, `ToolServerListenerRecord`,
   `ToolServerListenerRegistry`; `waTools.ts` `normalizeWaQuery`, `WaToolName`, `WaToolResult`, `WA_LAST_TEXT_CHARS`; `toolGate.window.ts`.
   `executeWaTool` returns null for bad arguments (the frozen W0 signature already allowed null).
7. The T7 listener registry: production code cannot import `tests/setup-guards.ts`, so `toolServer.ts` exposes a DI seam
   `setToolServerListenerRegistry(registerListener)`. My tests set it; making it global is a REQUEST to V2-W2-02 (below).
8. Voice rows carry `kind:'voice'` with the transcript as `text` (C2 10 row shape) - P2 8.2's `"source":"voice_transcript"` wording is
   the S1 data-block field, not the tool row; C2 wins.
9. `recentDmChats` / `wa_list_chats` order = MAX(rowid) (C2 SQL; no timestamp math), not message time.
10. An every-chat search (`all_chats`, `chat` omitted) learns each hit's chat through `wa.context(rowid, 0, 0, ...)` (the frozen
    `WaReadClient.search` returns `Message[]` without a ChatRef); a hit the facade cannot confirm is dropped. <= 10 extra point reads.
11. `wa_list_chats` has no result-size cut: 10 entries x 120 chars stay below 4,000 even with every character JSON-escaped (test pins
    the worst case).
12. `context()` finds the AFTER-neighbours by walking the chat newest-first down to the target (BridgeDb has no "rows after" read);
    past the 2,000-row scan cap it returns `after: []` rather than a wrong neighbourhood.
13. `waWorld` stranger: an app chat with `isKnown=false` (what ingest creates for an unknown sender), so `chatId` is not null although
    the W0 type comment says "null = unknown to app.db"; a JID with no app row at all is exercised separately.
14. `V1_READ_TOOL_NAMES` is kept as a `@deprecated` alias ONLY because the frozen `tests/security/tool-gate.test.ts` imports it.

## REQUESTS

- **V2-W2-02** (`tests/security/injection-corpus.test.ts`, frozen in Wave 1): the corpus now carries the T2 8.4 families. 24 new cases
  use the five new vectors `wa_row`, `voice_transcript`, `image_text`, `existing_event_title`, `cli_output`; the current runner's
  `deliver()` has no branch for them, so those 24 cases fail with "the model was never called" until the runner delivers them. Data
  fields: `wa_row` -> `seed {chat:'trigger'|'other', ageDays, rowsBack?, voice?}` (the row to insert into the fake bridge DB; `voice:true`
  = an audio row + a transcripts row carrying `payload`), `trigger` (the inbound message text), optional `scopes`
  (`['trigger_chat','all_chats']`: run the case in both); `voice_transcript` -> `transcript {language,text}` (fake whisper);
  `image_text` -> `image` (`img-en-inject-delimiter.png` / `img-he-inject-daily.png` of P2 15 / W1-08); `existing_event_title` ->
  `existingEvent {title,startLocal,endLocal,location}` + `trigger`; `cli_output` -> `cliMode:'attacker'` (payload in result /
  structured_output); every family may carry `expect` (runner-side expectations of T2 8.4 (h)-(j): `noAutoWrite`,
  `noUnescapedDelimiter`, `verdicts`, `strikes`, `badges`, `queryNormalized`, `initNeverRetrusted`, ...). `mustNot` gains
  `cross_chat_leak` and `system_prompt_leak`. The 10 automatic-mode cases use the v1 `message` / `push_name` vectors and pass today.
- **V2-W2-02** (`tests/security/tool-gate.test.ts`): import `READ_TOOL_NAMES` / use `exposedTools()` instead of the `V1_READ_TOOL_NAMES`
  alias; then delete the alias from `toolDefs.ts` (W2-01 fix-up right).
- **V2-W2-02** (`tests/setup-guards.ts`): call `setToolServerListenerRegistry(registerListener)` once at guard install (integration +
  security + main) so EVERY tool-server listener is in the T7 registry, not only those of my tests; import-graph part B for
  `mcp/toolServer.ts`, `bridge/waReadClient.ts`, `agent/waTools.ts`, `agent/handles.ts` (all four are clean today: toolServer value-imports
  only node:http/node:net-type/node:crypto, the SDK server + types, shared/types and proc/freePort). Add the spawned-fake-CLI chain of
  group 19 to `tool-server.test.ts` once `fake-claude-cli.mjs` speaks MCP (it can import `tests/fakes/mcp-client-core.mjs`).
- **V2-W1-04** (`tests/fakes/obedient-attacker-llm.ts`): widen `InjectionCase.vector` / `mustNot` unions and add the optional fields
  above (the JSON is cast today, so nothing breaks at run time).
- **V2-W2-01** (`tests/helpers/harness.ts`, `compose.ts`): harness option `waWorld: true` = `seedWaWorld(h.bridgeDb, h.repos,
  {nowMs: h.clock.now()})` before `compose()` (the world's trigger JID is `WA_WORLD_JIDS.trigger`); `toolServers` handle = a registry
  passed to `setToolServerListenerRegistry`; compose: `waAvailable = () => settings.whatsapp.readTools.enabled && bridgeDb.open()`
  (today `() => false`), `wa = createWaReadClient({bridgeDb, chats: repos.chats, transcripts: repos.transcripts, settings})` (already),
  and the claudeCli `startToolServer` dep = `startToolServer({gate, ctx: input.ctx, specs: input.specs, randomBytes, freePort:
  () => freePort(), appVersion})`, mapping `ToolServerPortError` to the provider's `not_ready`.
- **V2-W1-03 / V2-W1-06** (whoever persists S3 runs and proposals): `runs.wa_rows_served = ctx.waRowsServed`,
  `proposals.cross_chat_rows = ctx.crossChatRows`, and `validate.crossChatLeak(draft, ctx.otherChatTexts, LIMITS.crossChatLeakWindow)`
  - `pipeline-wa-tools.test.ts` asserts all three.

## BLOCKED-BY

- **V2-W1-03-edit-pipeline**: `tests/security/wa-tools.test.ts` "rows served from another chat ... a draft quoting one is a leak" calls
  `validate.crossChatLeak` (still `NotImplementedError`). My half (the rows and `otherChatTexts` it needs) is asserted and green.
- **V2-W2-01**: `tests/integration/pipeline-wa-tools.test.ts` (4 tests) - harness option `waWorld` throws NotImplemented until W2-01
  wires it (and the S3 draft loop / persistence of the counters above must be in place).
- **V2-W2-02**: the 24 new-vector cases of `injection-corpus.test.ts` (see REQUESTS).
- **V2-W1-06**: the spawned-CLI chain of group 19 (not written; W2-02 inherits it). Note: `tests/integration/fakes-v2.test.ts` "the
  spawned fakes exit 99" currently fails because `fake-claude-cli.mjs` changed (W1-06's line, not mine).

## Dead ends / facts found

- Heredocs / `node -e` with template literals through the Bash tool mangle backticks - edit files with the Write/Edit tools instead.
- SDK client `listTools()` re-orders `inputSchema` keys when it parses (zod object with passthrough), so byte identity must be checked on
  the raw HTTP body, not through the SDK client.
- The T7 guard closes every `DatabaseSync` after each test, so the 10^6-row bench is one test that owns all its handles.
- `@hono/node-server` 2.1.1 (MIT, transitive of the pinned SDK, in the lockfile) is pulled in by `server/streamableHttp.js`; packaging
  (V2-W2-04) must keep it in the main bundle / asar.

No secrets, tokens, phone numbers or real message content are in any file of this package (synthetic 9725500000NN JIDs only).
