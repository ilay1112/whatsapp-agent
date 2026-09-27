# verify-process-lifecycle-8 — doorbell pre-auth rate limit

Verdict: **CONFIRMED (partially — the adversarial half only), severity stays minor.**

## What the code really does
`src/main/bridge/doorbell.ts:120-133` — `withinRateLimit()` is the first statement of `handle()`.
`withinRateLimit()` (`:79-85`) pushes a timestamp into one global `recent[]` array for every request
it admits, before the loopback / method / Origin / Host / secret / token checks run. There is no
per-peer scoping and no second budget. So an unauthenticated request that is 404'd a microsecond
later has already consumed one of the 30 slots in the 1000 ms window. Reviewer's reading is correct.

## Proof (scratch probe, real `createDoorbell()` over a real loopback socket)
`probe.mts` — baseline 5/5 genuine rings = 200. Under an unauthenticated `GET /` flood:
- ~90 req/s: genuine rings `200,404,404,404,200,404,404,404,200,200,200` → 5/11 delivered.
- ~360 req/s: 3/11 delivered (`accepted 8, rejected 1088`).
A uniformly paced flood (rather than the probe's 100 ms bursts) would approach total starvation.

## What the reviewer got wrong
1. **"the same starvation occurs benignly during a history sync" is false.**
   `vendor/whatsapp-bridge-src/main.go:2970-3146` (`handleHistorySync`) calls `StoreMessage` only —
   it never calls `SendWebhook`/`SendWebhookWithMedia`. Webhooks are sent only from the live message
   handler (`main.go:1679-1697`). This matches ARCHITECTURE A14: "History sync dumps months of
   messages without webhooks."
2. **"or a busy group, where >30 messages per second is ordinary" is not a failure.**
   A ring is a *coalescing poke*, not a data channel: `ingest.poke()` is a 250 ms trailing debounce
   (`ingest.ts:376-381`) onto a global `rowid > watermark` scan (ARCHITECTURE 4.6 step 2). At most
   ~4 scans/s can be consumed, so the 30 accepted rings/s are already 7.5x redundant; the rings
   dropped above 30/s carry no information the next scan does not read anyway. Nothing is lost.

## Bounded blast radius (why it stays minor)
- No message loss: the watermark scan is the authoritative ingestion path (A6); rows are picked up
  whenever the next scan runs.
- The 30 s fallback is **not** reachable by the attacker: `compose.ts:1245`
  `every(LIMITS.scanIntervalMs, () => ingest?.poke())` calls `poke()` in-process, never through the
  doorbell. ARCHITECTURE section 18/V2 states the design intent: "timer scan backs up the doorbell".
- Worst case = ingest latency rises from ~250 ms to <= 30 s for the duration of the flood. No
  approval bypass, no calendar/WhatsApp write, no crash, app fully usable.
- The attacker must already be executing arbitrary code as the user on the same desktop, where far
  cheaper denials exist (kill the Electron process, lock the app DB).
- No spec is violated: ARCHITECTURE 4.5 says only "Intake limiter 30 req/s" and pins no ordering.
  `tests/security/doorbell.test.ts:320-333` asserts the 30/window cap but never the ordering, so no
  existing test would break if the budget were split.

## Note on the proposed fix
"Authenticate first, rate-limit after" is not free: the secret and token comparisons each compute two
SHA-256 digests (`constantTimeEquals`, `:59-63`), so moving the limiter below them makes an
unauthenticated flood buy 4 hashes per request instead of 0. The two-budget variant the reviewer
offers as the alternative (wide pre-auth window + narrow post-auth window charged only on accept)
is the one that keeps both properties.
