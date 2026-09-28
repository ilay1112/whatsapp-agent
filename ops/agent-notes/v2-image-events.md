# Agent notes: v2-image-events (research, 2026-09-27; retry 2026-09-28)

Deliverable: `docs/research/v2-image-events.md`.

## Retry 2026-09-28 - what changed and why
The orchestrator relayed "Try again". The first-run report already existed (54 KB) and the digest had consumed it, so this pass
re-verified the claims the digest flagged as inferred and reconciled section 3 with the two CLI-backend reports instead of rewriting.
- **U-IMG-1 resolved**: GitHub compare API `163a407...b10964` -> `status: ahead, behind_by: 0, ahead_by: 157`, merge base = PR #28335's
  merge commit (2026-09-04T10:23:27Z). b10964 (tag -> `b29c606e…`, "bump version to 0.4.1 (#28900)", 14 Sep 2026) contains the Gemma 4
  vision fix. The WebFetch summariser printed the release year as 2024 - a summariser artefact; the compare API is authoritative.
- **Section 3 rewritten**: the first run assumed "Read tool on a file path" for Claude and "Gemini CLI read_file" for Gemini. The sibling
  reports chose (a) Claude: `--input-format stream-json` with an `image` content block on stdin, `--restricted --tools "" --strict-mcp-config`;
  (b) Gemini: Antigravity `agy`, not Gemini CLI. Verified 2026-09-28: Claude streaming-input page (image block shape; single-message mode
  "does not support direct image attachments"), cli-reference page (`--input-format`, `--json-schema`, `--tools`), local `claude.exe --help`
  2.1.258 (`--restricted`, `--strict-mcp-config`, `--system-prompt[-file]`, `--tools ""`) - help text only, no login; agy headless page
  ("text is the only supported block type" over stdin; `--json-schema` accepts a file path); agy CHANGELOG 1.2.12 (no headless image entry).
  Result: Claude = stdin image block (Read-in-cwd only as fallback); Gemini = API-key provider `inline_data` until gate M-IMG-1b proves
  `agy @path` headlessly.
- **Corrected a false claim**: `/api/media` is a bridge endpoint (contract 3.8) but `src/main/bridge/readClient.ts` has only
  `health/pairingStatus/pairingQrPng` - the report now specifies the additive `getMedia()` / `requestDownload()` methods as a frozen-signature
  amendment, shared with the voice research (which also needs the A16 `/api/download` amendment).
- Spot-checked the E4B mmproj table against the HF tree API at the pinned commit: sizes and LFS sha256 match.
- Confirmed from source: CSP already has `img-src 'self' data:` (protocol.ts, index.html); `nativeImage` already used in main (tray.ts);
  `isNeverTrigger` (ingest.ts:74) and `isNeverTriggerRow` (stage0.ts:58) are the two places an empty-text image row is dropped;
  `LlmMessage.user.content` is a plain string in `llm/types.ts:29`.
- Flag names NOT on the public cli-reference page but present in `--help`: `--restricted`, `--strict-mcp-config`, `--system-prompt-file`.
  Noted in the report so the build does not trust either source alone.

## What the first run did (2026-09-27)
- Read ARCH 1/2/8/9/17, pipeline S1/S2/8, ux 6.5/7.1-7.2, bridge-contract 3.7/3.8/4/6, `llm/types.ts`, `bridge/ingest.ts`, `shared/types.ts`.
- Web: HF API tree listings at the three v1-pinned commits (still `main` HEAD, lastModified 2026-07-17) for mmproj sizes + LFS sha256;
  llama.cpp server README / multimodal.md / mtmd README; PR #28335 + issues #21461/#21550/#24251/#26981/#22582; Gemma 4 model cards
  (token budgets, OmniDocBench); Unsloth guide; Anthropic vision page; Gemini image-understanding page; Electron nativeImage;
  `npm view jimp` (no install); CSA image-injection note.
- No binary executed against an account, no reference store touched, no global installs, no commits.

## Assumptions / inferences still open
- F16 over BF16 projector is a conservative Vulkan choice, not a measured one (U-IMG-3).
- CPU-projector encode time on the laptop target is an order-of-magnitude guess (U-IMG-4).
- Hebrew OCR quality of the small Gemma 4 tiers is unmeasured (U-IMG-5) - the 24-image golden set is the gate.
- Raw-CLI stdin image block (U-IMG-6) and agy `@path` (U-IMG-7) need the one-time manual gates with the user present.

## Dead ends
- Gemini CLI `@file` / `read_file` for images in headless mode: moot - Gemini CLI is not the subscription path (gemini-cli report).
- `--bare` for Claude Code: bypasses subscription login -> incompatible with D-038.
- Webhook `mediaBase64`: rejected (doorbell must stay tiny; absent for history rows).
- Reading the bridge store dir directly: rejected in favour of `/api/media` (validated ids, Range).

## Hand-offs
- cli-backend (Claude): the V1 run is a variant of the 7.1 command with `--max-turns 1`, a different system-prompt file and schema, and an
  image block in the stdin line; needs the runner to accept a content-block array and to assert `system/init.tools == []`.
- gemini-cli-backend: `runAgy()` already has `attachments?: string[]`; gate M-IMG-1b decides whether it is ever used for pictures.
- voice research: share `readClient.getMedia()/requestDownload()`, `media-cache` retention, and the A16 amendment.
- spec agent: additive types in report sections 6.3 and 7 (`LlmImagePart`, `ImageReadView`, badges, settings.images, consent `cloud_images`);
  proposed decisions D-042..D-047 in section 8; UNVERIFIED register section 9 (U-IMG-1 resolved, U-IMG-11 added).
