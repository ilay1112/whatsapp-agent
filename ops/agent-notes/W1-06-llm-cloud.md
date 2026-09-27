# W1-06-llm-cloud — working notes

Owner of: `src/main/llm/claude.ts`, `src/main/llm/gemini.ts`, `src/main/llm/__fixtures__/**`
(plus the colocated `claude.test.ts` / `gemini.test.ts` per the colocated-test rule of build-plan §1 rule 6).

Read: ARCH 8 / A8 / A20, CONTRACTS §9, PIPELINE §10, TESTS 5.3 rows `llm/claude.ts` + `llm/gemini.ts`,
`docs/research/claude-provider.md`, `docs/research/gemini-provider.md`, `docs/specs/wave0-seams.md` §6.

## Status

Done. Definition of done (build-plan §1.1) met:

| Item | Result |
|---|---|
| (a) no `NotImplementedError` left in owned source | yes — both providers fully implemented |
| (b) TESTS 5.3 rows covered | yes — 101 colocated tests across the two files |
| (c) `npx eslint <owned paths> --max-warnings 0` | clean (exit 0) |
| (d) `npm run typecheck` | no error in owned files (3 pre-existing errors elsewhere — see OBSERVED below) |
| (e) `npx vitest run --project main src/main/llm` | 6 files / 194 tests green; my two files 101/101 |
| (f) coverage ≥ 90 % | stmts 100 %, branch 92.44 %, funcs 100 %, lines 100 % (claude 91.72 % branch, gemini 93.01 %) |
| (g) notes | this file |

No `BLOCKED-BY`: the providers depend only on the frozen `llm/types.ts` seam, `main/deps.ts` (`Logger`) and
`shared/types.ts` — all W0 type-only surfaces, so no other package's stub is on my path.

## Design decisions / reasoning

**SDK surface was verified against the installed typings, not memory.** `@anthropic-ai/sdk@0.127.0` and
`@google/genai@2.23.0` are what `node_modules` actually holds; the Gemini `interactions` namespace exists in
`dist/genai.d.ts`. Both clients are nevertheless consumed through a narrow hand-written structural interface
(`ClaudeClientLike`, `GeminiClientLike`) rather than the SDK's own types, because:
- it is the S-SDK seam — a plain object recording double must satisfy it with no casts in the test;
- it keeps the blast radius of an SDK minor bump inside one `as unknown as` at the construction site;
- it documents exactly which SDK calls the app is allowed to make (`messages.create`, `models.list/retrieve`;
  `interactions.create`, `models.get/list`) — anything else is a compile error, which is a cheaper guard than a lint rule.

**Env poisoning is closed by construction, not by sanitising `process.env`.** Both SDKs fall back to environment
variables when a field is `undefined`, so `claudeClientOptions()` / `geminiClientOptions()` always return the literal
constants of CONTRACTS §9 and are exported so the test can assert the exact bag. The tests set
`ANTHROPIC_BASE_URL` / `GOOGLE_GEMINI_BASE_URL = https://evil.example` and `GOOGLE_API_KEY=AIzaTESTONLYENV`,
then assert the recording constructor still saw `https://api.anthropic.com` /
`https://generativelanguage.googleapis.com` and our explicitly-passed sentinel key. Deleting env vars in the provider
would have been a global side effect in a shared-process app — rejected.

**The stateless flag lives in exactly one function.** `runInteraction()` is the only call site of
`interactions.create` in `gemini.ts`, so the literal `store:` appears exactly once (grep test asserts length 1).
Every other Gemini code path funnels through it, which makes "no server-side retention" a structural property
rather than a per-call-site discipline. Same idea for the banned keys: the grep test asserts the source never
contains `previous_interaction_id`, `mcpToTool` or `mcp_server`.

**Manual loop, never a tool runner.** `chat()` performs exactly one model turn and returns `toolCalls` as data.
Nothing in `llm/**` can execute a tool, so approval-first cannot be bypassed here: the orchestrator owns the loop.
The Claude grep test pins the absence of `toolRunner` / `beta.messages` / `messages.stream` / `mcp_servers`;
Claude's `tool_choice` is always `{type:'auto'}` and is omitted entirely when `tools` is empty.

**Truncated / refused turns never yield tool calls.** In both providers `toolCalls` is populated only when the
mapped stop reason is `tool_use`. A `max_tokens` turn can contain a syntactically complete but semantically
half-formed `tool_use` block; surfacing it would let a truncated model turn drive a real read. `structured()`
throws `bad_output` outright on `refusal` / `max_tokens` before attempting `JSON.parse`.

**Gemini rejects a `function_call` whose name is not in the request's tool map** (throws `bad_output`).
A name outside the map is either a protocol violation or an injection artefact; failing closed is cheaper than
letting an unknown name reach the tool gate (W1-09) and rely on it.

**`-latest` aliases are refused at construction** (`createGeminiProvider` throws `LlmError('model_not_found')`)
and filtered out of `listGeminiModels`. ARCH §8 NEVER row: Google hot-swaps them, which would silently change the
model recorded in `runs`/`proposals`.

**`listClaudeModels` returns the LIVE list only.** No preset is injected. The renderer (W1-13/W1-16) intersects
`CLAUDE_MODEL_PRESETS` with this result, so a preset the account cannot reach is never offered. The fixture
deliberately omits `claude-haiku-4-5` and the test asserts it does not appear in the output.

**Error mapping is duck-typed on both sides.** Anthropic's error classes are exported but a recording double
throws plain objects; Gemini's Interactions error classes are SDK-internal and not exported as values at all.
Mapping therefore reads `status`/`statusCode`, a body code and the `retry-after` header off an `unknown`.
`LlmError.message === code` by construction (`types.ts`), and no mapper ever puts a provider body in a log line —
`log.warn('llm.request.failed', { code, status })` only. A sentinel test asserts the API key never appears in any
recorded log line across a successful turn, a failed turn and `validate()`.

**`effort:'low'` branch.** `output_config.effort` errors on `claude-haiku-4-5` (and its dated aliases), so the
field is added by prefix check. For `chat()` this means `output_config` is present only when there is an effort to
send — a haiku chat request carries no `output_config` key at all, which is what the absent-key assertions expect.

**`max_tokens` floor.** Claude requests are raised to `CLAUDE_MIN_MAX_TOKENS = 2048` (PIPELINE 10.1: thinking
counts against output); a larger caller budget is kept as-is. Gemini passes `opts.maxOutputTokens` through and
relies on `thinking_level:'low'`.

**Tools are sorted by name** in both providers so the cached prompt prefix is stable across turns.

## Dead ends / rejected alternatives

- *Using the SDK's `zodOutputFormat` / response-schema helpers.* Rejected: the app's schemas are `JsonSchemaLcd`
  (CONTRACTS), not zod, and the helper would re-add keywords the LCD subset deliberately excludes.
- *Letting `toClaudeSchema` pass `additionalProperties` through when the caller already set it.* Rejected —
  forcing `false` on every object node is the requirement, and honouring a caller-supplied `true` would be a
  silent hole. The key is stripped and re-added.
- *Mapping Gemini HTTP 400 to `bad_output` unconditionally.* Gemini reports an invalid API key as 400 with
  `API_KEY_INVALID`, which must surface as `auth` or onboarding shows the wrong remedy. Special-cased.
- *Sanitising `process.env` inside the provider.* Rejected (global side effect) — see above.
- *A shared `cloudBase.ts` for the two providers.* The overlap is ~30 lines of error-shape probing with different
  body layouts; a shared base would have needed a strategy object per provider and made the two grep tests
  (which read one file each) unable to prove their invariants. Kept two self-contained files.

## Assumptions (flagged, not verified against a live API)

Every fixture starts with `"_unverified": true` and `src/main/llm/__fixtures__/README.md` states the rule.
Nothing here was recorded from a real call — no network request is made by any test.

1. Claude `refusal` arrives as HTTP 200 with `stop_reason: 'refusal'` (not as a 4xx).
2. Gemini generation blocks arrive as HTTP 200 with a per-step/interaction `error.code` in
   `{safety, prohibited_content, spii, recitation, language, blocklist, content_blocked}` — the code set is a
   superset guess; extra members are harmless, a missing one degrades to `other`.
3. Gemini `interactions.create` accepts `timeout_ms` in the per-call options bag.
4. `models.list()` shape: Anthropic `{data:[...]}`, Gemini `{models:[...]}` / `{pageInternal:[...]}`.
   Both `modelRows()` helpers also accept a bare array so a double can stay simple; unknown shapes yield `[]`.
5. Anthropic surfaces the daily spend cap as 429 with `error_code: 'enforced_spend_limit_reached'`; a body
   mentioning "spend limit" is treated the same way so a wording change does not turn a hard cap into a retry loop.

If any of these is later contradicted by a real response, the fix is local to the mapper plus its fixture.

## OBSERVED (not mine, not fixed)

`npm run typecheck` currently reports 3 errors, all outside my paths:

```
src/shared/when.test.ts(129,12): error TS2532: Object is possibly 'undefined'.
src/shared/when.test.ts(140,12): error TS2532: Object is possibly 'undefined'.
src/shared/when.test.ts(141,12): error TS2532: Object is possibly 'undefined'.
```

## REQUESTS

- **W1-08-shared-utils:** `src/shared/when.test.ts` lines 129/140/141 fail `tsc -p tsconfig.tests.json` with
  TS2532 (`Object is possibly 'undefined'`). It is in your owned path; I did not touch it. It makes the repo-wide
  `npm run typecheck` red, which W2-01 will need green.
- **W2-01-wiring:** `createClaudeProvider` / `createGeminiProvider` take `{ apiKey, model, client?, log }` and
  `client` must be left undefined in production so the constructor bag of CONTRACTS §9 is used. The
  `compose.ts` seam's `sdk?: { claude?, gemini? }` doubles are for tests only — please do not default them.
- **W1-13 / W1-16 (renderer model picker):** `listClaudeModels` returns the live list *only*. Intersect
  `CLAUDE_MODEL_PRESETS` with it; do not render a preset that is absent from the live list.
  `listGeminiModels` already strips `-latest` aliases — do not re-add them, `createGeminiProvider` throws on one.

## BLOCKED-BY

None.
