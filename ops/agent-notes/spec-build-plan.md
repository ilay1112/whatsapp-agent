# Agent notes - spec "build-plan" (2026-09-21)

Output: `docs/specs/build-plan.md` (only deliverable). No other project file touched besides this notes file. No secrets, numbers or message content here.

## What I read
- `docs/ARCHITECTURE.md` in full (binding), `docs/specs/contracts.md` (all block headers, sections 0, 6-16 signatures, 17, 18, concerns), `docs/specs/test-strategy.md` (sections 0-6, 8-15, concerns), `docs/specs/agent-pipeline.md` (overview, section 11, concerns), `docs/specs/ux.md` (section 14, 15.2, 16, 17), the four spec agents' notes, `ops/DECISIONS.md`.
- Did not open the reference bridge folder at all. Ran nothing except read-only `grep`/`sed`/`ls` inside the project.

## Decisions and why
- 1 + 16 + 4 packages. ARCH section 18's 15 lanes were re-cut: doorbell moved next to ingest ("webhook ingest server"); `agent/*` split three ways (pure date/language utils, guard layer incl. ToolGate + attack corpora, pipeline incl. stub LLM + golden set); lane 11 lost `index.ts`/`compose.ts` to Wave 2; lane 10 lost `tests/security/*.test.ts` to Wave 2 (they need the harness over the production `compose()`); Claude + Gemini merged and Onboarding + Settings merged to stay within 16.
- Split directories (`bridge/`, `agent/`, `llm/`, `components/`, `tests/fakes/`, `scripts/`) are owned by file name; helper files must be named `<ownedFile>.<suffix>.ts`.
- contracts.md freezes facades but not every factory, so the plan adds a "supplementary seams" table that W0 must turn into exact TypeScript and index in `docs/specs/wave0-seams.md`.
- `declare function` blocks cannot be imported at run time, so W0 replaces them with bodies throwing `NotImplementedError(owner, name)`; Wave 1 tests that fail only because of another package's stub are listed as `BLOCKED-BY`, never skipped.
- Locale files: single owner (W1-14) + per-package `pending/<id>.json` fragments merged by `import.meta.glob`; folded in by W2-01.
- W0 implements `openDb` + `migrate` so `:memory:` databases work on day one (most packages depend on the schema).

## Open points for the orchestrator
Listed in section 8 of the plan (bridge exe intake approval, Wave 2 ordering vs the 0/1/2 wave schema, new `[B+]` files, webp screenshots, fetch-llama run, package merges).
