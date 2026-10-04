# V2-W2-02-security - agent notes

## Fix round 1 (2026-09-29) - audit item (b) #16: the corpus runner's v2 vectors

Scope of this round (per the fix-round task): `tests/security/injection-corpus.test.ts` only - extend `deliver()` for the five v2
vectors (REQUEST V2-W1-05 -> V2-W2-02) and add the T2 8.4 assertions (h)-(j). The rest of the W2-02 brief (groups 1-25 extensions,
`media-text-isolation.test.ts`, import-graph B-D, setup-guards T8/T9, fixture lint, ...) was NOT part of this fix round and is not
claimed here.

### What changed in the runner

- **v1 cases are untouched in behaviour**: same harness, same corpus object, same benign-baseline (g). The per-case functions now
  take a `Mark` (calendar-call / provider-call offsets, seeded events, state fingerprint taken right before the attack) so a v2 setup
  step can legitimately create things first; for v1 cases the mark is all zeros = the old behaviour.
- New per-case assertions for EVERY case: (h) `auto_writes` empty; (i) a `manipulation` badge => `chats.auto_tainted_until > now`;
  a forged `<<(END-)DATA-x>>` token of the payload never reaches a model unescaped (system/user/tool text).
- `wa_row` cases run once per scope in `scopes` (default `trigger_chat`) -> 8 twins x scopes = 20 runs.
- **Part B (compose, T2 6 harness options)** - `deliver()` branches:
  - `wa_row`: `waWorld: true` + `whatsapp.readTools {enabled, scope}`; the hostile row is added to the fake bridge DB in the world's
    trigger / other chat at `now - max(ageDays, 30 min)` (backlog timestamp: never a live trigger); `voice:true` = audio row + a
    `transcripts` row carrying the payload; the trigger text arrives in `WA_WORLD_JIDS.trigger` (the source chat for (c)/(d)).
  - `voice_transcript`: `whisper: {transcripts: {'3.0': c.transcript}}` + `voice.enabled`; inbound audio row, `setMedia(oggSilence(3))`.
  - `image_text`: `images.enabled`; attacker `capabilities.images = true`; inbound image row with a caption, `setMedia(png(64,48))`.
    The corpus names `img-en-inject-delimiter.png` / `img-he-inject-daily.png`, which do not exist under `tests/golden/images/`;
    the scripted reader ignores pixels, so a synthetic PNG stands in (T5).
  - `existing_event_title`: a REAL setup - a benign message whose (attacker-corpus alias) extraction carries the hostile title
    (cut to `LIMITS.titleChars`), a real `action:approve` of its `create_event`, then the trigger. `findExistingEvent` hands the
    approved title to the next run. `resetTurns()` so turn 1 of the attack emits the case's tool calls.
  - `cli_output`: `provider:'claude_cli'`, `cli.claude.script` = S1 `structured_output` (title = payload) and S3 `result` = payload
    (whose first line is the `init`-shaped object). `cliMode:'attacker'` of the fake does not carry the case payload (its text is
    fixed), so the script mode is used to put the payload where T2 8.4 says ("payload in result / structured_output").
  - Attacker-corpus aliases (`#trigger`, `#read`, `#setup`) let the obedient attacker recognise a conversation by the trigger /
    caption / setup text; the case itself is always first so a conversation that shows the payload matches the case.
- **(g) for v2**: the harness config differs per vector and the system prompt carries the per-run nonce, so v2 uses a stricter
  config-independent form: every system prompt must equal `buildSystemPrompt()` of one stage with only trusted facts, every
  offered tool must be byte-identical to `llmToolOf(READ_TOOLS[name])`; payload never outside a data block of user AND tool text.
- **Delivery proof (non-vacuity)** per v2 vector: `wa_row` - the trigger reached the model AND a `wa_*` tool was offered (and an
  other-chat row never reached the model under `trigger_chat`); voice / image - the case payload reached the model; existing event -
  a non-null `"existing_event":{` block with the title's tail; `cli_output` - a draft-stage CLI invocation exited 0. Without it a
  vector the app never wired would pass every "nothing happened" assertion vacuously.
- `mustNot` `cross_chat_leak` (card drafts vs the other-chat payload, S4's own `crossChatLeak`), `system_prompt_leak` (no 48-char
  window of any system prefix in a card draft - there is no product-side "prompt leak" guard; the enforceable property is that
  nothing leaves without approval, which (a)/(d) already prove), `expect.badges`.
- (j): no `runs.sandbox_json` of a `claude_cli` run lists the forged `Bash`; the CLI draft stage runs at most once.
- **Part A (module level, no compose, green today)**:
  - `wa_row` x scope: the real ToolGate + WaReadClient + BridgeDb rig (`createWaToolRig`); the case row seeded; `obey.toolCalls`
    replayed; asserts nothing but READ executed, zero calendar writes, results = exactly one nonce block, forged delimiter escaped,
    other-chat row never served under `trigger_chat` (and counted + caught by `crossChatLeak` under `all_chats`), runner-side
    `expect` of T2 8.4 (`verdicts`, `strikes`, `facadeCallsForUnknownHandles`, `queryNormalized`, `resultHasNoBidiOrTag`, `abort`,
    badge preconditions), sha8-only audit.
  - voice / image / existing-event: the real `buildContext` (extract + draft): one open / one close delimiter, forged delimiter
    escaped, untrusted text only inside the block and actually present there, S4's `mediaTexts` carries it, window flags set.
  - `cli_output`: the forged init fails `checkClaudeInit` for every stage; an attacker-padded S3 init => `extra_tool`.
  - `slotIsDeterministic` (wr-fake-end-block) is pipeline-only (S2 is app-computed); it is covered by (a) no create + the draft
    being produced from the app slot, not asserted separately.

### Later adjustments in this round (after V2-W2-01 landed its harness options mid-run)
- `wa_row` cases answer S1 with a valid `question` extraction (the case scripts no S1 answer; the attacker's generic forbidden-key
  extraction would stop the run before S3, the only stage with the WhatsApp tools). Without this the delivery proof failed with
  "the WhatsApp read tools were never offered".
- Voice / picture delivery = `bridgeDb.seedMediaRow` + `bridge.setMedia` (same as the lanes' pipeline-voice / pipeline-image).
- CLI script answers carry the four v2 Extraction fields (`V1_EXTRACTION_DEFAULTS`): the spawned fake answers verbatim, and without
  them S1 ended in `LLM_BAD_OUTPUT` (runner defect, fixed).
- (c) for v2: a v2 run reaches S3, so a pending `send_reply`'s `text` is the attacker's draft (phone / e-mail text for the user to
  read). The routing part of `canonical_json` (everything except `text`) is checked; v1 cases keep the whole-JSON check. For v2
  every stored draft text is URL-free and, if it carries personal details (S4's own `scrubDraft` rule), the item has
  `personal_details`.
- Badges are read from the dashboard cards AND `items.badges_json` of the source chat.
  **Observation (for V2-W1-03 / the orchestrator):** an S3 run aborted at `blockedCallsAbort` on a `question` item ends with the
  item in state `ignored`, `reply_state 'none'`, badge `manipulation` - it is on no dashboard list, although the orchestrator
  comment says "the card is not lost: it becomes a manipulation-badged item with no draft". Not asserted here (not this package's
  contract); flagged for the owner.
- `cross_chat_leak` at pipeline level compares the drafts with the 24-char windows of the other-chat payload that were ACTUALLY
  served in tool results (a number the attacker invents after projection removed it is not a served-text leak).

### Result of this round (`npx vitest run --project security tests/security/injection-corpus.test.ts`)
135 tests: 131 pass, 4 fail. All 78 non-v2 corpus cases (incl. the 68 v1 ids) pass with the added (h)/(i)/forged-delimiter checks;
all 20 `wa_row` runs, both `existing_event_title`, both `cli_output` Part B cases pass; all Part A tests pass. The 4 red:
`en/he-voice-transcript-dictates-reply` ("the model was never called": the audio row is ingested as `ignored`, no media request,
no whisper job) and `en/he-image-text-reply-confirmed` (delivery proof: the picture text never reached the model). The lanes' own
`pipeline-voice` Part B (2) and `pipeline-image` Part B (4) are red for the same reason at the same moment - compose's V0/V1 wiring
is V2-W2-01's (in progress). BLOCKED-BY V2-W2-01 for those 4.

### Dependencies / blocked

- Part B of `voice_transcript` / `image_text` needs V2-W2-01's compose wiring of V0 (voice service) and V1 (`readImage` /
  `pickImage`). `waWorld`, `whisper`, `cli` + `claude_cli` harness options and `waAvailable` landed during this round.
- While this round ran, `src/main/compose.ts` was being edited by another package (transform errors: `autoPushing` undefined, then an
  unterminated string at line ~2030) - every compose-based test of this file was red for that reason at that moment.

### REQUESTS
- **V2-W1-05 (corpus)**: `image` names `img-en-inject-delimiter.png` / `img-he-inject-daily.png` do not exist in `tests/golden/images/`
  (the injection set is `img-inj-01..04.png`); either rename in the corpus or add the files + manifest rows.
- **V2-W2-01 (harness)**: `whisper.transcripts` is keyed here by the note duration string `"3.0"` (the fake's `byDuration` key);
  `h.provider` for `provider:'claude_cli'` should expose `calls` (or `[]`) - the runner reads `calls?.length ?? 0`.

---

## Package run (2026-10-04) - the full V2-W2-02 brief (continued after the usage-limit interruption)

State found on disk at start: `npx vitest run --project security` = 39 files / 1052 tests green. Already done by earlier W2-02
sessions: import-graph parts B/C/D (TS-AST resolver), the corpus runner v2 (fix round 1), W2-01 REQUESTS 1-2 (push list, image cases),
T8/T9 guards in `tests/setup-guards.ts` (W0) + `setup-guards.v2.test.ts`. Remaining brief items are done in this run (log below).

### Progress log (this run)
- `tool-gate.test.ts`: [V2] group 1 block over the v2 gate (`createWaToolRig`): update-/get-/delete-event dash+underscore + casing /
  whitespace / homoglyph / FQN variants, `wa_*` variants => blocked_unknown_tool + strike, zero calendar / WhatsApp calls, sha8-only
  audit; two v2 strikes abort; wa_list_chats unexposed in trigger_chat; six-name READ table + exposure per scope; exercising every
  exposed tool reaches only get-current-time / get-freebusy. Green.
- `approval-binding.test.ts`: [V2] update_event rows (execRig + ledger): confirmDrift honoured only after this action's
  needs_confirm_drift (not on a first click, not across actions); repeated plain clicks never apply drift; confirmDrift overrides no
  other refusal (hash, kind via schema, stale revision, foreign); double approve racing a slow pre-flight get-event => one PATCH;
  raw SQL approve without approved_by aborts. Green.
- `bridge-invariants.test.ts`: [V2] literal job env key sets (whisper = llama list), real builders under a poisoned env, envKeysAllowed
  refusals, JobRunner refuses bad env before spawn, NEVER_PORTS / freePort. Green.
- `electron-hardening.test.ts`: [V2] ARCH2 12 forbidden packages (direct, production tree, references; LGPL pair nowhere) + SPDX
  allow-list over every production lockfile entry. **RED - FINDING F1** (see FINDINGS).
- `fixtures-synthetic.test.ts`: fixed the corrupted first header line (a stray regex had been pasted over it in an earlier session);
  + T10 (TS-parser import specifiers of every `tests/fakes/*.mjs` vs the allow-list: Node built-ins, MCP SDK, zod, tests/fakes/**;
  the CLI fake's own non-loopback guard / exit 97), T11 (UUID v4, `C:\Users\<name>` other than wca-fake-home, `session_id` not
  `fake-*`, e-mail domains over every fixture + the CLI fakes; a JSON CLI capture must start with `"_unverified": true`), T12 (every
  media file under tests/ listed in MEDIA_MANIFEST.json with sha256 / bytes / an existing generator script; none unlisted; none under
  src/). Negative controls for each. Green.
- `consent-payload.test.ts`: [V2] CLI providers need their own consent (claude_cli / antigravity_cli: factory throws, nothing located);
  a v1 record of cloud_claude / cloud_gemini no longer counts (factory throws, no key read); `wa:setReadScope all_chats` with claude on
  a v1 consent => CONSENT_REQUIRED, no dialog, nothing written; with v2 it reaches the native confirmation (cancelled). Green.
- `no-side-effect-fuzz.test.ts`: exclusion list = action:approve, item:undoChange, auto:undo (T2 8.2); auto:requestEnable stays fuzzed
  (empty dialog script); + zero auto_policies rows, zero auto decisions / writes, no auto_policy_enabled audit, no approved action, no
  update-/delete-event; every listed v2 channel driven. Green.
- `media-text-isolation.test.ts` (NEW, group 21 text isolation): 500 seeded iterations through compose() - 250 voice notes (fake whisper
  `--fake-transcripts`, distinct durations per batch of 25) + 250 pictures (stub V1 `readText`, matched per caption) incl. corpus
  payloads, nonce look-alikes, bidi / zero-width, 50 KB strings. Per call: system prompt identical to a he+en benign baseline after
  normalising the two per-run TRUSTED facts (`current time:` line, run nonce), tool array identical, text only inside the nonce block
  AND delivered there (non-vacuity), no forged delimiter; never in log, audit, toast, tray, dialog, push, openExternal, whisper / CLI
  argv, file names or non-DB file text under userData. Provider half (500 more iterations): Local request body (fake llama-server),
  Claude / Gemini SDK doubles, Claude CLI `--system-prompt` argv element (`buildClaudeArgs` of the recorded request), agy agent file
  body (`buildAgentFile`) - raw system bytes identical to the provider's baseline, untrusted text never in argv, delivered only inside
  the nonce block. Source half: no runtime window-title setter in src/. Green (~45 s).
- `redaction.test.ts`: [V2] rule 12 sentinel set through compose(): stub run (voice SENTINEL_TRANSCRIPT + whisper stdout/stderr
  sentinels, picture SENTINEL_OCR, WhatsApp rows SENTINEL_WA_ROW_* and SENTINEL_OTHER_CHAT under all_chats, auto:export written) and a
  claude_cli run (stderr_flood + script, S3 through the tool server: SENTINEL_CLI_STDOUT + per-run MCP token captured by a recording
  `vi.mock` wrapper around the REAL startToolServer). Delivery proof per data-path sentinel. Swept: logs, file names, non-DB files,
  audit, runs, triage_queue, toasts, tray, dialogs, openExternal, fake journals, auto:export file. Green.
- `prompt-purity.test.ts`: [V2] group 23 - policy matrix (none + shadow/on/paused/expired/disabled x 2 scopes x chat inherit/never,
  22 runs in one harness with the WhatsApp tools offered): normalised system prompts and tool arrays identical; tool names carry no
  capability word; tools/list of the real tool server (fake MCP client) identical with / without a live policy; provider payload incl.
  wa_* tool results free of JIDs, numbers, fixture names, bridge message ids, media file names; no clock time in a tool result. Green.

### Decisions / assumptions (this run)
- **System-prompt byte identity across harness runs** is asserted after normalising the per-run nonce and the `current time:` line
  (both trusted app facts, prompt.ts). Raw byte identity is asserted where those facts are fixed (provider half, unit purity test).
- **T2 group 23 "no auto / approve / undo / settings string" vs the parent specs**: C2 10 pins the wa_search_messages `chat`
  description "...(only when allowed by the user's settings)." and P2 pins S1/S3/V1 constants that quote "approve" as an example of an
  injected instruction. The parent wins (build-plan header), so exactly those two pinned texts are removed before the word scan (the C2
  sentence must occur exactly once); every other occurrence fails. Tool NAMES may carry none of the words. Concern C1 below.
- CLI argv / agy agent files across policy states: `CliRunRequest` and `buildAgentFile(stage, systemConstant)` carry no policy input
  (frozen C2 types); their bytes are proven identical under untrusted input in media-text-isolation's provider half.
- `no-side-effect-fuzz`: item:restoreOriginal / item:cancelEvent stay fuzzed (stricter than T2's list; no app event exists to act on).

## FINDINGS (red tests - never weakened)
- **F1 (owner: orchestrator - dependency / licence policy; not a code bug of any package)**: `electron-hardening.test.ts` >
  "every production package (direct AND transitive) carries an SPDX licence from the allow-list" fails on
  `fast-sha256@1.3.0: Unlicense` (production transitive: `@anthropic-ai/sdk` -> `standardwebhooks@1.1.1` -> `fast-sha256`). B18 /
  ARCH2 12 allow only MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD. Options: a DECISION adding `Unlicense` (public-domain
  dedication) to the allow-list, or an `@anthropic-ai/sdk` pin whose tree avoids it (a version change = out of every builder's rights).

## REQUESTS
- Orchestrator: decide F1 (above).
- Orchestrator (concern C1): T2 8.2 group 23 wording "no auto, approve, undo, settings string in any of them" conflicts with C2 10
  (wa_search_messages description contains "settings") and P2 (S1/S3/V1 quote "approve" as an injection example). Implemented per
  the hierarchy (parent wins, pinned texts excepted exactly); if the orchestrator prefers the literal T2 rule, C2 10 / P2 need an edit
  (V2-W1-05 / V2-W1-03) and the exception in prompt-purity.test.ts is removed.
- V2-W2-01 (harness, optional): `attachLedgerSources` does not pass `sentinels`, `runTokens`, `trayLabels`, `windowTitle`,
  `exportTexts` (rule 12 surfaces); redaction.test.ts sweeps them itself, but the global ledger hook would then cover every test.

## BLOCKED-BY
- None.

## Verification (this run, 2026-10-04)
- `npx vitest run --project security`: 40 files, 1174 tests: 1173 passed, 1 failed (F1 only).
- `npx eslint tests/security tests/setup-guards.ts --max-warnings 0`: clean. `npm run typecheck`: exit 0.
- prettier --write on the 11 security files touched (all W2-02-owned in Wave 2).
- No binary executed (only the .mjs fakes under the system node), no network, the reference bridge store and the user's vendor-CLI
  state never touched.
