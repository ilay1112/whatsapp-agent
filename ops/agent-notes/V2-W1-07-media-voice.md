# V2-W1-07-media-voice - builder notes

Status: DONE (2026-09-29) except the items under BLOCKED-BY. The first attempt left `voice/ogg.ts` + `voice/wav.ts` implemented and
nothing else; this run continued from them (both kept, `ogg.ts` got one dead guard removed and a full test file).

## What was built (brief order)

1. `bridge/readClient.ts` `getMedia` (ids re-checked against `MEDIA_JID_RE` / `MEDIA_MSG_ID_RE` before any request, bearer,
   `redirect:'error'`, 15 s CONNECT budget (timer cleared when the head arrives; the body is then bounded by the byte cap and the caller
   signal), declared Content-Length above the cap refused unread, streamed body aborted at cap + 1, 404 => null, 401/403 =>
   `BridgeAuthError`, other statuses / network / mid-body reset => `BridgeUnreachableError`, caller abort => its reason).
   `media/fetch.ts` (the only `getMedia` caller; magic-byte sniff, Content-Type ignored; 404/5xx/unreachable => ONE retry after
   `LIMITS.mediaRetryDelayMs` through the injected `sleep`; `MEDIA_MAX_REQUESTS = 2`; bad_id / too_large / auth / bad_type never retried).
   `bridge/invariants.ts` + test: `BRIDGE_ENDPOINTS` (five), `FORBIDDEN_BRIDGE_ENDPOINT_NAMES` (stored as names so the module does not
   reference them), `sweepBridgeEndpointRefs()` (comments stripped - the C2 doc comment in readClient.ts quotes the forbidden names on
   purpose) run over the real `src/` tree. `tests/fakes/fake-bridge.ts` `/api/media`: media_serve.go validation, row lookup in
   messages.db (read-only handle per request), all seven scenarios, journal `mediaRequests`, violations `media_unknown_row`,
   `media_non_media_row`, `media_retry_storm`; child-mode control verb `setMedia` (bytes as base64).
2. `media/imageDims.ts` (JPEG marker walk to the first SOF / PNG IHDR; sniff JPEG + PNG only; `endsCleanly()` = EOI / IEND terminator),
   `media/normalizeImage.ts` (size -> sniff -> header dims -> 25 MP -> terminator -> ONLY THEN the S-IMAGE facade; decoded size must equal
   the header size or its EXIF swap; long edge 1536, `toJPEG(85)`, 320-px thumbnail `toJPEG(80)` data URL; sha256 of the normalised JPEG),
   `media/mediaCache.ts` (`<dir>\<sha256>.jpg` + `.thumb.jpg`, row upsert keeping an existing item link, `thumb` / `dataUrl` (item:getImage
   cap `LIMITS.imageDataUrlMaxBytes`) from the newest row of the item, `deleteForItem` removes rows + both files).
3. `voice/ogg.ts` (kept), `voice/decode.ts` (opus-decoder@0.7.12 through S-OPUS; decodes straight to 16 kHz - libopus resamples
   internally; stereo down-mixed; 20 s wall clock and abort checked every 500 packets with an event-loop yield; > 50 % frame errors
   or zero samples => `VOICE_DECODE_FAILED`), `voice/wav.ts` (kept + golden header test), `voice/whisperCli.ts` (C2 literal argv,
   `whisperThreads`, `whisperTimeoutMs` clamp, `buildWhisperEnv` = WHISPER_ENV_KEYS by name only, JobSpec kind voice / stdout ignore /
   stdin null / BELOW_NORMAL / grace `voiceKillGraceMs`, exit 3 / -1073741515 + 3221225781 / no or bad JSON / timeout / kill / breaker
   mapping, 1 MiB zod-parsed `-oj` file, WAV + JSON removed in `finally`), `voice/service.ts` (see refinements below).
4. `bridge/ingest.ts`: inbound audio / image rows without text are trigger candidates (own text-less media never is), `mediaFilename`
   (diagnostics only), `items.trigger_kind` set at creation (`voice` / `image`), `contextFor()` attaches `Message.voice` from a `done`
   transcript and omits other audio rows (C2 12 + P2 3.3), new export `mediaWindowFor()` = the raw V0 window. `agent/stage0.ts`: audio
   and image rows are not "empty"; caption-less picture + images off => context only (step 2b); voice note => held/waiting_llm unless
   `voice.enabled` and `voiceReady()` (step 5d, AFTER the stranger / pause / provider / budget gates).
5. `llm/local/manifest.ts`: `MODEL_MANIFEST` untouched; `MEDIA_MODEL_MANIFEST` (3 projectors at the v1 commits + 4 voice files, kind +
   magic, B18/B19 sizes, research sha256s), `MMPROJ_FOR_TIER`, `mediaLocalFileName`, `formatModelSize` (F24: 0.99 / 0.99 / 0.18 GB,
   1.6 GB), `UNPINNED_MEDIA_IDS`. `llm/local/download.ts`: `ModelManager` members widened to `ModelFileId` (W1-10's model handler
   already expects it), magic per entry (GGUF / `lmgg`), `model_files.kind` from `modelFileKindOf`, local file name prefixed with the id
   for media files (two projectors share `mmproj-F16.gguf`), `plan().mmproj` filled, a media download queues behind every running LLM
   download. `ipc/handlers/voice.ts` (getState / selfTest with a 330 s signal / retry -> `items.detail`).
6. `scripts/fetch-whisper.mjs` (reuses fetch-llama's zip reader, verified fetch and CRT staging; strips `Release/`, refuses any other
   folder, allow-list, required set, own `resources/licenses/whisper.cpp-MIT.txt`, `vendor/whisper/MANIFEST.txt`) + `vendor/whisper.pin.json`
   (new, B18 pin of record) + test; `scripts/pin-models.mjs` v2 (media parser, `resolve/main` -> commit via `/revision/main`, tree
   size + lfs.oid, 4-byte magic via a Range read that cancels the body, writes `vendor/models.pin.json` only when both tables pass) +
   tests; `scripts/gen-voice-fixtures.ps1` (SAPI, user-run only, refuses a target inside the repo, skips Hebrew without a Hebrew voice);
   `tests/golden/voice.jsonl` (12 rows 4/4/4, distinct durations 3.0 ... 7.4 s, key phrases contained in the scripted sentence).
   Test assets: `tests/fakes/whisper-cli.mjs` (T2 3.3 in full, `main()` exported with an io sink for in-process tests),
   `tests/security/media-isolation.test.ts` (23), `tests/integration/media-fetch.test.ts` (9), `tests/integration/pipeline-voice.test.ts`
   (13: Part A on the real modules incl. W1-06's REAL JobRunner spawning the fake whisper with the system node.exe; Part B through the
   harness = BLOCKED; Part C golden loader), whisper block in `tests/integration/fakes-v2.test.ts`.

Verification (2026-09-29): eslint clean on every owned path; typecheck clean in owned files (errors elsewhere: `draft.loops.test.ts`,
`ipc/handlers/cli.test.ts`, `llm/cli/claudeCli.test.ts`, `llm/factory.cli.test.ts`, `mcp/toolServer.test.ts`, `proc/jobRunner.test.ts` -
not mine); coverage: `media/**` 100/100/100, `voice/ogg.ts` 100 lines / 98 branches / 100 funcs, `voice/**` >= 92 branches, stage0 /
invariants 100, readClient 100/97/100. Main project: 3 failures, none mine (toolGate.corpus W1-05, toolServer W1-05, jobRunner W1-06).
Security project: 26 failures, none in files I own (injection-corpus v2 families need W2-01/W2-02 wiring, cli.sandbox W1-06,
wa-tools W1-05). Integration: pipeline-voice Part B (2, BLOCKED), fakes-v2 skeleton test (W1-06's fake-claude-cli now exits 0 - its
owner must drop it from the "exit 99" loop, as I did for whisper-cli.mjs), pipeline-wa-tools (W1-05).

## Seam refinements made (all OPTIONAL / additive; ratification requested - see REQUESTS)

- `VoiceServiceDeps` += `window?(chatId)` (the frozen deps carry NO message source; without it V0 transcribes nothing - fail closed),
  `whisperSeam?` (`WCA_WHISPER_CMD`), `whisper?`, `decode?` (S-OPUS), `cpuCount?`, `randomId?`.
- `createWhisperRunner` deps += `argsPrefix?` (the WCA_WHISPER_CMD `node.exe <fake> ... --fake-end` prefix).
- `Stage0Deps` += `voiceReady?()` (absent => false => voice notes are held raw cards).
- `ModelManagerDeps` += `mediaManifest?`; `ModelManager` params widened ModelTier -> ModelFileId.
- `MediaModelManifestEntry` = `Omit<ModelManifestEntry,'tier'> & {tier: MediaModelFileId; kind; magic}` - C2 writes
  `ModelManifestEntry & {kind, magic}`, whose `tier: ModelTier` a voice file cannot satisfy.
- New exports: `ingest.{mediaWindowFor,isWindowRow,isVoiceOrImage,triggerKindOf}`, `invariants.{BRIDGE_ENDPOINTS,...,sweepBridgeEndpointRefs,
  stripComments}`, `fetch.{sniffMedia,MEDIA_MAX_REQUESTS}`, `decode.{createWavDecoder,realOpusDecoderFactory,VoiceDecodeError,...}`,
  `whisperCli.{whisperThreads,whisperTimeoutMs,buildWhisperEnv,WhisperJobError,...}`, `imageDims.{sniffImage,endsCleanly}`.

## Decisions / assumptions (for the orchestrator's DECISIONS log)

- Fake bridge answers a malformed id with **404 "media not found"** exactly like the vendored `media_serve.go` (T2 3.6 says 400; the real
  bridge never returns 400 there). The app never sends one (checked before the request).
- `media_retry_storm` = a 3rd request for one message since its last `setMedia()` (a "triage" is not observable from the fake under a
  virtual clock); tests that exercise queue-level retries re-arm with `setMedia`.
- Media-cache key hashes `<chatRef>|<waMsgId>` (put() receives the ChatRef, not the JID); still a hash only, no contact text in a path.
  `put()` leaves `item_id` NULL (or keeps an existing link): the caller links it with `repos.mediaCache.upsert({...rec, itemId})`.
- Voice URLs of `MEDIA_MODEL_MANIFEST` are `resolve/main/` - the research pinned size + sha256 (LFS oid) but no commit, and no network
  is allowed here. Downloads stay content-addressed (sha256 verified); `pin-models.mjs` resolves the commits (W2-04).
- `fetch-whisper.mjs` writes its own `resources/licenses/whisper.cpp-MIT.txt` instead of appending to THIRD_PARTY_NOTICES.txt (the
  fetch-llama repair: the notices file is generated by `smoke-packaged.notices.mjs`). MANIFEST at `vendor/whisper/MANIFEST.txt` (brief).
- Pending transcripts = no row, another tier's label, `aborted`, or `failed` with `VOICE_AUDIO_MISSING`; `VOICE_TIMEOUT` and every other
  failure are never re-run automatically (F33). `voice:retry` rewrites the row's label to `retry` (the repo has no delete), resets the
  voice breaker (a user click) and re-enqueues the chat. Fetch `too_large` => `VOICE_TOO_LONG`; `bad_type`/`bad_id` =>
  `VOICE_DECODE_FAILED`; `auth`/`unreachable`/`missing` => `VOICE_AUDIO_MISSING`.
- `DEFAULT_BENCH_FACTOR = 1` (realtime) until the self-test measured this PC: a note > 5 min is refused `VOICE_TOO_LONG_FOR_DEVICE`
  before the first self-test. A single note above the 120 s run budget (but under the 300 s job cap) still runs, else it never would.
- `resolvedTier()` for 'auto' = the default Hebrew tier when ready, else the first ready tier, else the default (no RAM/disk probe is
  available in the frozen deps). `suggestLite` = bench > 2 s per audio second and not already Lite.
- Self-test signal = a deterministic 5 s speech-band tone burst generated in code (the app ships no recording). VAD may drop it, so the
  bench is optimistic; M-VOICE-1 is the real measurement.
- `contextFor()` attaches `Message.voice` (C2 12 wins over the W0 comment in types.ts that says "never by ingest").

## Findings worth the orchestrator's attention

- **Windows child env (affects every job, I6')**: a child spawned with an explicit minimal env still receives HOMEDRIVE, HOMEPATH,
  LOGONSERVER, PATH, SYSTEMDRIVE, USERDOMAIN, USERNAME, USERPROFILE, WINDIR (libuv fills the "required" Windows variables from the
  parent when absent), and NUMBER_OF_PROCESSORS came out as the machine's value although '8' was passed (probe with the system node,
  2026-09-29). So a job's real env is a superset of the literal allow-list; W1-06 may want to pass those keys explicitly with safe
  values. The fake whisper tolerates the libuv set and takes the core count from `--fake-cores`.
- **U-V1 under the e2e Electron main build: NOT RUN** - it means executing the downloaded Electron binary (rule 4 read strictly, as W0
  did). Plain Node 24: the real decoder decodes the fixtures in every run of `decode.test.ts` and `pipeline-voice.test.ts` Part A.
  Hand it to V2-W2-03 (e2e) with the other Electron runs.
- **F28 self trigger** (P2 2 item 5) touches `bridge/ingest.ts` (mine) but needs W1-03's `findExistingEvent` and S4's `trigger_author`;
  it is not in this brief and is NOT implemented - from_me rows keep the v1 answered_elsewhere path.

## REQUESTS

- **V2-W2-01 (compose / harness)**: wire `createVoiceService({..., window: (id) => mediaWindowFor({bridgeDb, repos}, id,
  LIMITS.contextMessages), whisperSeam: seams.whisperCmd ? {command, args, cwd: dirname(args[0])} : null})` (e2e without the seam =>
  voice disabled); `createMediaFetcher({read: bridgeReadClient, sleep: seam-aware mediaRetryMs})`; `createImageNormalizer({image:
  nativeImage facade, hash})`; `createMediaCache({dir: paths.mediaCacheDir, ...})` + link `item_id` after V1; Stage0 `voiceReady: () =>
  voice.state().model?.status === 'ready' && voice.state().vad.status === 'ready'`; `createModelManager({..., mediaManifest})` from the
  WCA_MODEL_MANIFEST seam; `createVoiceHandlers`; `OrchestratorDepsV2.voice = voiceService`. Harness: implement the `whisper` / `media`
  options + `whisperJournal()` (register the journal with `registerFakeJournal('whisper', file)`), then pipeline-voice Part B turns green.
  A prettier pass over my files (I did not reformat the C2-verbatim blocks).
- **V2-W1-04 (ledger owner)**: rule 10 may stop failing closed: fail on the fake bridge's `media_unknown_row` / `media_non_media_row` /
  `media_retry_storm` violations (the fake already enforces "row exists, media_type audio|image, <= 2 per message per scripted triage").
- **V2-W1-06**: see the Windows child-env finding; drop `fake-claude-cli.mjs` from the "exit 99" skeleton loop in fakes-v2.test.ts.
- **V2-W1-03**: call `voice.transcribeChat()` in `runChat` before S1, treat `deferred` as "re-armed" (the service already re-enqueues),
  omit non-done audio rows (contextFor does), map the transcript into `{source:'voice_transcript', language, text}`; F28 self trigger
  (above) needs a home.
- **V2-W2-04**: run `npm run fetch:whisper` and `node scripts/pin-models.mjs`; copy the four commit-pinned voice URLs it writes to
  `vendor/models.pin.json` into `MEDIA_MODEL_MANIFEST` (mechanical; `UNPINNED_MEDIA_IDS` then becomes `[]` and
  `manifest.media.test.ts` expects every URL commit-pinned); add `whisper.cpp-MIT.txt` to the notices generator; extraResources from
  `vendor/whisper/win-x64-cpu`; CRT pins in `vendor/whisper.pin.json` (null = refused).
- **Orchestrator**: ratify the seam refinements and decisions above (DECISIONS log).

## BLOCKED-BY

- `V2-W2-01`: `tests/integration/pipeline-voice.test.ts` Part B (2 tests) - `createHarness({whisper, media})` throws NotImplemented
  until the harness options land. Not skipped, not weakened.

## Dead ends

- Bash heredocs containing backticks + `${...}` broke the tool's shell parsing; edits went through node scripts in the scratchpad instead.
- Injecting the core count through `NUMBER_OF_PROCESSORS` does not work on Windows (see finding); `--fake-cores` instead.

## Fix round 2026-09-29 (audit item #7: F28 self trigger, ENQUEUE half)

Assigned by the orchestrator after `ops/agent-notes/v2-wave1-audit.md` #7 (W1-03 REQUEST 3). Detection stays in W1-03's
`orchestrator.ts selfTriggerRow()`; this is the ingest side only.

What changed (owned files only):
- `bridge/ingest.ts`: `handleOutbound` now calls `trySelfTrigger()` after the v1 `ownSendMatches` check. A self trigger needs ALL of:
  own TEXT row (`isSelfTriggerCandidate`: DM, from_me, not deleted, not a reaction, `mediaType === ''`, non-empty); liveness `live`
  (backlog / history replay / older-than-7-d rows never run); `findExistingEvent(repos, chat.id, now) !== null`; NOT an app send
  (`isAppSendInChat`: wa id equals a recorded `send_reply` result, or text equals its approved text, over every executing / done /
  unknown_outcome `send_reply` of the chat - read-only bounded query `SENT_REPLY_ITEMS_SQL`, no time window: a false match only keeps
  v1); S0 (`classify` with `selfTrigger: true`) answers `queued` or `deferred`. Then: no open item => `createOpen` (trigger = the row,
  analysis queued) + `supersedePendingRepliesOfChat`; open item => stays OPEN, `replyState 'answered_elsewhere'` (the v1 bookkeeping is
  kept, P2 2 item 5), `analysis 'queued'`, `triggerMsgId/Ts` = the row, only its pending `send_reply` superseded. Chat enqueued
  (deferred => `queue.defer`). Log line `ingest_self_trigger` carries ids only. Any failed condition => the unchanged v1 path.
- `agent/stage0.ts`: `Stage0Input.selfTrigger?` (optional, additive) + exported `isSelfTriggerCandidate()`. Step 1 waives ONLY the
  from_me rule for a flagged candidate; backlog, policy 'never', stranger, pause, provider/consent, budgets, voice and edit-lock gates
  all still apply (a self run costs an LLM run and counts against the per-chat budget like any other).
- Tests: `ingest.test.ts` new describe (11 cases: open-new, re-arm open, app send by text, app send by wa id, other own text after an
  app send, no editable event => no S0 call, pending v1 event approval => v1, held => v1 closure, own approved send within 120 s,
  backlog + own voice note, deferred); `stage0.test.ts` (candidate predicate; the waiver; every later gate still applies).

Assumptions / decisions for the orchestrator:
- **Open item with a pending v1 event approval (event_state proposed / incomplete) keeps the v1 path** (not re-queued). A self run
  inserts only an `update_event` and closes everything else `not_needed` (validate.ts), which would throw away a pending create_event
  card because the user typed something in the chat. Consequence: a delta that ended `incomplete` (e.g. contact "can we move it?",
  user "let's do 5") is not re-run from the user's own answer. If the orchestrator wants that, the rule needs "incomplete from a
  delta" vs "incomplete v1 event" (e.g. `items.linked_item_id` set) - a W1-03 / spec decision.
- **Own voice notes are not self triggers at ingest time.** P2 2 item 5 allows a from_me voice row "whose transcript is done", but a
  transcript only exists after V0, which runs inside `runChat` - after ingest has already passed the row (watermark). Making it
  reachable means enqueueing every own voice note in a chat with an editable event speculatively (a whisper job each) and teaching
  the orchestrator's fallbacks about an item whose trigger is an own audio row. Not done; product decision.
- A held / dropped / no_item verdict for the self candidate falls back to the v1 answered_elsewhere closure (never a held raw card for
  the user's own message).
- Every own text message in a chat with an upcoming app event now costs one S1 run (within S0's budgets). That is F28 as specified.

Verification: `vitest --project main --project renderer` 243 files / 5734 passed + 1 expected fail; eslint clean on the four files
(prettier applied to them); `npm run typecheck` exit 0; bridge + stage0 + orchestrator unit tests 427 green; media-isolation 23 green.
`tests/integration/pipeline-edit.test.ts`: first run 6 red / 3 green, all red through compose (no `updateSurfaceAvailable` => every
delta degrades; the self-trigger test fails at `pendingKinds == []` for that reason). Later runs: 9/9 red with ReferenceErrors inside
`src/main/compose.ts` (`wave0HandlerDepsV2`, then `autoPushing` not defined) - compose.ts was being rewritten by another package during
this round, so the harness-level check (including the "hey" fixture point below) could NOT be run end to end; the ingest behaviour is
proven by the unit tests only.

REQUESTS (fix round):
- **V2-W1-03 (tests/integration/pipeline-edit.test.ts, fixture)**: `setup()` seeds the editable event and THEN syncs the user's own
  live row "hey" - under F28 that row is itself a self trigger (own text, not an app send, editable event, live). With compose wired
  the stub answers every extract with a reschedule, so "hey" produces a Change card on its own and the self-trigger test would count
  two `extract` runs on one item. Seed "hey" before the event (or as a backlog row before `live_from_ts`), or accept the extra run.
- **V2-W2-01**: nothing new for ingest (the self trigger uses `classify`, `repos`, `bridgeDb` it already has). The orchestrator deps
  from W1-03 REQUEST 2 are what turns the self-trigger test green.
