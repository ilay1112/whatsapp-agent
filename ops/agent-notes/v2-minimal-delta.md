# Agent notes - v2-minimal-delta (architecture proposal, MINIMAL-DELTA angle)

Date: 2026-09-28. Output: `docs/proposals/v2-minimal-delta.md`. Nothing executed against any vendor CLI, WhatsApp, Google or a model; no file outside the two named here was written.

## What I read
- `docs/ARCHITECTURE.md` in full (A1-A23, I1-I7, sections 3-11, 12-20).
- All eight `docs/research/v2-*.md` reports in full (the truncated tails were read in a second pass).
- `ops/CONTEXT.md` (v2 request + dialog), `ops/DECISIONS.md` D-001..D-041.
- Source seams the delta is stated against: `src/main/llm/types.ts`, `src/shared/settings.ts`, `src/shared/types.ts` (LIMITS, AUDIT_KINDS, BADGES, CONSENT_*, RATE_BUCKETS, PROVIDER_IDS), `src/shared/errors.ts` (ERROR_CODES list), `src/shared/ipc.ts` (channel list, IpcContext), `src/main/agent/toolGate.ts` (RunCtx, ToolGateDeps, ToolGate), `src/main/agent/orchestrator.ts` (stage order), `src/main/exec/actionExecutor.ts` (exports), `src/main/mcp/host.ts` (exports), `src/main/compose.ts` (children wiring), `src/main/llm/factory.ts`, `src/main/db/migrations.ts` (v1-v3, SCHEMA_VERSION), `docs/specs/contracts.md` and `agent-pipeline.md` section lists, `docs/research/bridge-contract.md` 3.7/3.8 (the `/api/media` fact that let voice and pictures share one client).

## Reasoning that shaped the choices
- "Minimal delta" was operationalised as: zero new *mechanisms* (gate, supervised child kind, approval path, transport family), and every capability lands on a named v1 seam. Section 0 of the proposal is the audit of that rule.
- The biggest merge decision: auto mode reuses `approve()` from the load step onward with `approved_by = decision id` (auto-mode report 8.4), not an `AutoApprover` with a fake `IpcContext` (event-editing 3.5). Same code size, but the DB trigger can verify the join.
- Cancel: the locked D-036 wording forces the vendored `status` patch; I dropped `If-Match` and the `CANCEL_MODE` dual path because the executor's pre-flight + readback already detects (not prevents) a lost update. Disclosed as weakness 1.
- Media: `bridge-contract.md` 3.8 shows `/api/media` serves `voice-note.ogg` as well as `photo.jpg`, so one `getMedia()`/`requestDownload()` pair replaces the whisper report's `audioLocator.ts` (filesystem realpath/regex/30 s wait). A16 goes four -> six endpoints, one caller module.
- Vision: no `VisionProvider` interface; V1 is one more `provider.structured()` call with an image part (the `LlmMessage.user.content` extension the image report already asks for). `capabilities.images` per provider does the routing.
- Consent: one v2 bump per cloud kind + two CLI kinds, instead of `cloud_images` + `auto_mode` + CLI kinds. Coarser; disclosed as weakness 11.
- Antigravity: shipped tool-less (`loop:'prefetch'`) because it is the smallest provider and the user asked for the subscription; auto mode and pictures excluded while it is active because `init.tools` is UNVERIFIED and stdin is text-only.
- Invariants: amended I1-I7, added I8 (reversibility) and I9 (own tagged events only); the auto-mode report's I10 folded into I1' enforcement text.
- SHOULD items of the auto-mode report deferred except the burst summary toast.

## Dead ends / things I chose not to do
- Considered shipping Gemini as API-key only (no agy) - rejected: the user's v2 request explicitly names the subscription and the tool-less provider is cheaper than the Claude one.
- Considered reading audio from the bridge store directory as the whisper report proposed - rejected once `/api/media` was confirmed to serve audio.
- Considered a settings override for the CLI exe path - deferred (adds a user-supplied path to settings; the documented locations + `where.exe` cover the observed install).

## Hand-off
- The proposal's section 17 lists the decisions the orchestrator must record (D-042..D-049 + the `[V2+]` frozen-signature list).
- Section 16 lists twelve UNVERIFIED items and the manual check that closes each; eight need the user's own logins.
- Sibling proposals (other angles) should reconcile against section 1 (Q1-Q29), which answers every open question the eight reports raised.
