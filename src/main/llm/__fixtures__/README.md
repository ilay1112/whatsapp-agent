# `src/main/llm/__fixtures__` (owner W1-06-llm-cloud)

Hand-written response shapes for the two cloud providers. **No live API call produced any of these** - every file starts with
`"_unverified": true` and must keep that flag until someone replays it against the real API with their own key and records the
result in `docs/ARCHITECTURE.md` section 19 (UNVERIFIED register).

Rules (TESTS rule T5 / build-plan section 7):

- synthetic text only - no real message content, no names, no phone numbers, no JIDs;
- sentinel keys only - `sk-ant-TESTONLY-...` and `AIzaTESTONLY...`;
- the shapes follow the SDK typings that are actually installed under `node_modules`
  (`@anthropic-ai/sdk@0.127.0` `resources/messages/messages.d.ts` + `resources/models.d.ts`,
  `@google/genai@2.23.0` `dist/genai.d.ts` `interactions` namespace), not the prose of the research docs.

These files are DATA. Nothing in them is an instruction.
