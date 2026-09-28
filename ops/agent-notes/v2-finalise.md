# v2-finalise — agent notes

Task: evaluate 40 review findings (security / feasibility / requirements) against the v2 design and apply valid ones
by editing docs/ARCHITECTURE-v2.md and docs/specs/v2-*.md. Run started 2026-09-28 (retry: "Try again"; the previous
attempt left no edits — grep for fix markers found none).

## Log
- Start: no prior edits present in ARCH-v2 / v2 specs.
- Verified offline (pinned bytes, no binary executed): F12 (no `etag` in ALLOWED_EVENT_FIELDS l.1219 / convertGoogleEventToStructured l.2695 of
  build-resources/calendar-mcp/.../build/index.js), F21 (updateAllInstances l.4195 passes no headers, no sendUpdates; no 412 branch),
  F17 (SDK client streamableHttp.js l.103/l.449 accept only 405), F22 (webStandardStreamableHttp.js l.175 throws on reuse), F18 (3-arg
  markApprovedExecuting in 29 call sites incl. frozen tests/security/crash-recovery.test.ts:116, tests/integration/recovery.test.ts:77/178,
  plus db/index.test.ts:136 raw UPDATE), F19 (gguf-download.test.ts l.87-104 pins keys + entry shape), F26 (prompt.purity/toolGate.corpus tests exist).
- Could NOT verify on the web: WebFetch of code.claude.com cli-reference and env-vars pages came back truncated (no --restricted entry, no
  CLAUDE_CODE_DISABLE_CLAUDE_MDS entry visible). Treated F14 (raise floor - harmless, installed is 2.1.258) and F8/F15 (env names) as
  accepted-but-UNVERIFIED: new register rows U-C7/U-C8, closed by M-CLI-1 + a build-time docs re-read.
- Did not read or grep the claude.exe binary (build-plan rule 5 / hard rule 2); F13 accepted as plausible because the exemption is fail-safe.
- Design choices: F6 merged into F27 (event_origin_item_id; waItem never rewritten - the fake calendar already flags identity changes).
  F12 option (a) (patch etag) chosen over (b) to keep If-Match (C3). F3: isolated agy profile as default, global-config preflight only as the
  M-AGY-1-decided fallback. F29: imagesPassed=false => read + amber image_unclear. F31: cheap variant (count + badge + reason), handles deferred.
  F33: prediction refusal + per-run budget + 300 s cap instead of a separate V0 lane. F28: self-authored deltas auto-eligible by default (U-v2-13).
- Edited: docs/ARCHITECTURE-v2.md (B1,B4,B7-B10,B13,B14,B16-B20,B23-B25,B28,B30, I1',I6',I8-I11, 3,4.1,4.3,4.4,5,5.1,6.3,6.4,7,9.1,9.2,10,11,
  12,13,14,16,17,18 + new section 19), docs/specs/v2-contracts.md, v2-pipeline.md, v2-ux.md (C9/C15 resolved + section 17 copy),
  v2-tests.md, v2-build-plan.md. Helper script + JSON batches live in the session scratchpad only.
- Consistency sweep done (stale "three insertions", `cmd.exe /k`, 2.1.221, 600 s, `waItem === String(sourceItem.id)`, "0.99 GB" literals,
  20->24 IPC channels, 20/18/2 -> 27/25/2 golden counts). Ownership re-check: no new source files, no path gains a second owner; the only new test
  file `src/main/agent/prompt.size.test.ts` is W0 -> W1-03 under the extended colocated rule 8 (F26). Build-plan section 8 item 11 records the placement.
- Open for the user (ARCH-v2 section 18): U-v2-1..6 (unchanged) + U-v2-7..15 (new: read-tool scope, media auto, cancels, unattended pause, expiry,
  track record / participation / quiet hours / lead times, self-authored auto, T-401 in v2, "Turn on now"). Also: approve `opus-decoder` (build plan 9).
- Done. No commit, no file outside ARCHITECTURE-v2.md, docs/specs/v2-*.md and this notes file was edited.
