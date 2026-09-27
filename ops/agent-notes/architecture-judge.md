# Agent notes - architecture-judge (workflow 1, synthesis step)

Date: 2026-09-21. Output: `docs/ARCHITECTURE.md` (binding). No code was written, nothing was executed except read-only registry/API lookups.

## What I read
All three proposals in full; all ten research reports (i18n-rtl: sections 1-10 in full, the starter key sets skimmed); `ops/CONTEXT.md`, `ops/NOTES.md`, `ops/DECISIONS.md`, `ops/agent-notes/workflow-1-summary.md`. The bridge `store\` folder was never touched; no exe was run; no session-connected Google/Gmail/Drive tools were used.

## Live verification done (read-only)
- `npm view` on 24 packages: research pins still match `latest` except the known traps (vite 8.3.0, plugin-react 6.1.1, vitest 5.0.1, typescript 7.0.2) plus react-i18next 17.0.15 and typescript-eslint 8.70.1 (kept the research-resolved 17.0.14 / 8.70.0). `@testing-library/dom` pinned to 10.4.2.
- Hugging Face API: commit SHA, byte size and LFS sha256 for the three Gemma 4 GGUF files (values are in ARCHITECTURE section 17). This closes the "sha256 not captured" TODO of both local-model reports.
- `claude-api` skill: model ids `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`, `claude-fable-5-1` confirmed; forced `tool_choice` is a 400 on `claude-fable-5-1`; structured outputs via `output_config.format`.

## Scoring (1-5)
simplicity 4/5/5/3/3 = 20; safety 4/3/3/5/3 = 18; ux 4/3/4/4/5 = 20 (requirements fit / buildability / packaging risk / safety / UX). Base = simplicity; grafts from safety (invariants, ToolGate, action binding, spawn invariants, extract-then-draft, test gate) and ux (AppHealth/ErrorCode, onboarding order, copy escape hatch, edit-lock, raw cards).

## The one design call that is mine (not in any proposal as-is)
Pipeline = S1 `structured()` with NO tools, then S3 `chat()` tool loop whose terminal output is the PLAIN TEXT draft. Reason: every proposal combined or forced something unverified (forced tool choice; anyOf union grammar; tools + response_format in one request). Splitting by feature means each stage uses only the most basic, documented capability of all three backends, and S1 (the part that decides item state and the event) does not depend on local tool-call parsing at all. Cost: 2 LLM calls for items that need a reply; 1 for noise; 1 for "confirmation with event, no reply needed". Schema is flat with sentinel values (no nulls, no unions) because type arrays crash gemma4.jinja and Claude structured outputs reject min/max keywords.

## Deviations from orchestrator leans (flagged in the doc)
- Q5 backlog: default 0 h instead of 24 h (privacy on first run with a cloud provider); it is a setting 0-72 h. Listed as open user decision U5.
- Q4 Claude default: `claude-opus-5` per Anthropic guidance instead of the proposals' `claude-sonnet-5`; listed as U1 because the user pays.

## Dead ends / things I considered and dropped
- Keyword pre-filter as a priority hint only - still speculative, dropped.
- Showing every inbound message as an instant card (ux D1) - without the lexicon filter it flickers for every "lol"; replaced by "Analysing N chats..." + raw cards only when the LLM is unavailable/held/failed.
- dependency-cruiser - replaced by ESLint no-restricted-imports + a vitest import-graph test (no new dependency).
- Deterministic eventId: kept, because the executor never depends on how the server reports a 409 (any error -> failed -> reconcile by private extended property).

## Hand-off notes
- Spec agents: section 6 (pipeline), 7 (state), 10 (schema), 11 (IPC) are the contracts to expand into `docs/specs/*`.
- Build agents: section 16 pins are exact; section 18 has the ownership table and import boundaries; section 19 lists what only a supervised first run can confirm.
- Orchestrator: please copy decisions A1-A23 into `ops/DECISIONS.md` and U1-U7 into the open-questions table.
