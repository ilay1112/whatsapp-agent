# Agent notes - v2-pipeline (v2 spec workflow, spec "pipeline")

Date: 2026-09-28. Output: `docs/specs/v2-pipeline.md` (delta over `docs/specs/agent-pipeline.md`).
Nothing executed except read-only inspection: `claude.exe --version` / `--help` (flag names only, no login), a node one-liner measuring the byte size of the v1 prompt constants, and a node validator over the JSON blocks of the new spec. The bridge `store\` folder was never touched; no vendor CLI was run with any login; no session-connected tools were used.

## What I read
- `docs/ARCHITECTURE-v2.md` in full (B1-B32, I1'-I12, sections 3-18).
- `docs/specs/agent-pipeline.md` in full (v1 R2).
- Research: `v2-event-editing.md` 2.x + 5.x; `v2-image-events.md` 4.x; `v2-auto-mode-safety.md` 4-6; `v2-whatsapp-mcp-readonly.md` 5.x + 8.3; `v2-whisper-local.md` 8.x; `v2-cli-mcp-bridge.md` 6-7.
- Live v1 code: `src/main/agent/prompt.ts` (verbatim constants + `EXTRACT_RULES_ADDENDUM` 6a), `contextBuilder.ts` (data block shape, trailers, date table), `src/shared/when.ts` (weekday resolution), `src/shared/types.ts` (LIMITS, BADGES, ASSUMPTIONS), `llm/local/llamaServer.ts` (`-c 8192`).

## Decisions I had to make (refinements, all marked [refinement] in the spec)
1. S1 data block is ALWAYS the object `{app_context:{note, existing_event|null}, messages:[...]}` (research 2.2), so one shape is learned by the 4B model; the v1 few-shots keep the bare-array input and the v2 addendum rule 10 says so explicitly (keeps the v1 example bytes, only outputs gain 4 fields).
2. The CLI "JSON only, one line" sentence is part of the S1 constant for EVERY provider, so B15 byte-identity holds (B20 wording "CLI runs get one extra line" read as "the line exists for the CLIs' sake").
3. The one media sentence appended to S1 rule 1 covers both `imageText` and `source:"voice_transcript"` (still one sentence; architecture 5 counts three constants).
4. `no_change` + `refersToExisting` suppresses the v1 slot resolution (else "see you at 3!" becomes an info_missing create proposal).
5. `cancel` with a date/time that only names the event being cancelled stays `cancel` (else "can't make it tomorrow" becomes a reschedule onto itself).
6. `trigger_kind` is rewritten per proposal version, conservatively (any media-derived text in the S1 window => voice/image).
7. V1 CLI wall clock 120 s (B19) not 60 s (B13) - conflict flagged.
8. Quiet hours check applies to both the write time and the (new) start - flagged.
9. `cross_chat_rows > 0` has no AUTO_REASON - proposed `cross_chat_context`, flagged.
10. S1 v2 system prompt is ~13 KB (measured) > 8 KB => `--system-prompt-file` for claude_cli per B26 (flagged against the B13 argv literal).

## Found while reading (v1 defect, not architecture)
- `contextBuilder.renderDayRows` increments `offset` AT each Sunday, so the coming Sunday is labelled `offset=1`, while `when.ts` resolves `weekday=0, weekOffset=1` to the Sunday AFTER it. The v1 injection few-shot ("meet Sunday 10:00" -> weekOffset 1) therefore resolves one week late. Kept v1 bytes; eval rows avoid Sunday; listed as the last architecture concern with the fix (offset = floor(dayIndex/7)).

## Dead ends
- Tried to keep S1 under 8 KB by moving few-shots to the user message: rejected, it would make the user message carry app examples next to untrusted text and break the cache prefix.
- Considered asserting `expect.auto` in live golden runs: rejected (model self-reported confidence varies); asserted only in stubbed runs, reported in live runs.

## Hand-off
- L3 owns sections 5-9 and the eval files; L4 sections 10-11; L5 section 8.2-8.4; L6/L10 section 13; L7/L8 sections 3-4.
- contracts.md needs: BADGES +6, ASSUMPTIONS +`hour_assumed_near_existing`, `EXTRACTION_JSON_SCHEMA` +4, `IMAGE_READ_SCHEMA`, `DRAFT_REPLY_SCHEMA`, `EventDelta`, `ExistingEventCtx`, `GoldenCase` additions, `LIMITS.cliWallClockMs/imageWallClockLocalMs`.
