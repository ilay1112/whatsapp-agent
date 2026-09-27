# Research: Gemini provider (`gemini-provider`)

Date of research: 2026-09-21. Everything below was checked against the live official docs and against the
actual published npm package (installed into a scratch dir and its `dist/genai.d.ts` / `dist/node/index.mjs` inspected).
Items that could not be checked are marked **UNVERIFIED**. No API key was available, so **no live API call was made** -
all runtime behaviour is from docs + SDK source, not from an executed request.

---

## 1. TL;DR / recommendation

| Topic | Decision |
|---|---|
| SDK | `@google/genai` **2.23.0** (npm `latest` on 2026-09-21). Pin `"@google/genai": "~2.23.0"` (must stay `<3.0.0`, see 2.2). |
| API surface | **Interactions API** (`ai.interactions.create`) - GA since June 2026, "recommended for all new projects". `generateContent` is officially "legacy" but "remains fully supported" (fallback shape in section 11). |
| State | **Stateless: always `store: false`.** Default is `store: true`, which keeps the whole conversation (private WhatsApp text) on Google servers for 55 days (paid) / 1 day (free). |
| Default model | `gemini-3.8-flash` (GA 2026-09-02) |
| Cheap / fast model | `gemini-3.5-flash-lite` (GA 2026-07-21) |
| Tool loop | **Manual loop owned by the app.** Do NOT use `mcpToTool()` (it auto-executes tools = bypasses the approval gate) and do NOT use the Interactions `mcp_server` tool type (Google's servers would call the MCP server). |
| Tool schemas | Pass MCP `inputSchema` as the function's `parameters` after running it through a whitelist sanitizer (section 6). |
| Sampling params | Do not send `temperature` / `top_p` / `top_k` - deprecated 2026-07-21 and absent from the Interactions `generation_config` type. Use `thinking_level` instead. |
| Abort | Second argument of `interactions.create(params, { signal })`. Client-side only; tokens still billed. |
| Key validation | `ai.models.get({ model })` - zero-token, returns 401/403/400 on a bad key. |

---

## 2. SDK

### 2.1 Package facts (verified from the installed package)

- Name: `@google/genai`, version **2.23.0**, repo `https://github.com/googleapis/js-genai`, license Apache-2.0.
- `engines.node`: `>=20.0.0` (we run Node 24 / Electron - fine). ESM + CJS builds (`dist/node/index.mjs`, `index.cjs`), single type bundle `dist/genai.d.ts` (~700 KB).
- Runtime deps: `google-auth-library ^10.3.0`, `ws ^8.18.0`, `p-retry ^4.6.2`, `protobufjs ^7.5.4`.
- Optional peer dep: `@modelcontextprotocol/sdk ^1.25.2` (only needed for `mcpToTool`; we will have the MCP SDK anyway as the app is an MCP host, but we will not hand the client to Gemini).
- Interactions API requires `@google/genai >= 2.3.0` (docs).
- The old `@google/generative-ai` package is dead - do not use.

Must run in the Electron **main process** (or a utility process), never the renderer: official guidance is never to
ship an API key in client-side code, and CORS/CSP would get in the way.

```ts
import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey });           // Gemini Developer API (not Vertex)
```

Env vars the SDK reads if `apiKey` is omitted: `GOOGLE_API_KEY` (wins) then `GEMINI_API_KEY`. **Always pass `apiKey` explicitly**
so a stray env var on the user's machine can never be used silently.

### 2.2 Upcoming breaking change (README warning)

- "Starting from SDK version 3.0.0, Node.js version 22 or later is required."
- In the next major, automatic function calling (AFC) can no longer be invoked from `models.generateContent`; only from `chats`.
  README recommends pinning `<3.0.0`. We do not use AFC, so impact on us is nil, but pin anyway.
- History: the Interactions schema had a breaking change on 2026-05-06 (legacy schema removed 2026-06-08). It is GA now, but
  treat the wire shape as something to cover with a contract test.

---

## 3. Models (as of 2026-09-21)

Source: https://ai.google.dev/gemini-api/docs/models , /pricing , /deprecations , /changelog

| Model id | Status | Released | Free tier | Paid $/1M in / out | Notes |
|---|---|---|---|---|---|
| `gemini-3.8-flash` | stable | 2026-09-02 | yes | 0.75 / 3.75 (intro price until 2026-12-31, rises 2027-01-01) | "most intelligent Flash model ... autonomous agents". **Default.** |
| `gemini-3.7-flash` | stable | 2026-08-13 | yes | 0.75 / 3.75 (intro) | previous gen |
| `gemini-3.6-flash` | stable | 2026-07-21 | yes | 0.75 / 3.75 (intro) | |
| `gemini-3.5-flash` | stable ("legacy Flash") | 2026-05-19 | yes | 1.50 / 9.00 | more expensive than newer ones - skip |
| `gemini-3.5-flash-lite` | stable | 2026-07-21 | yes | 0.30 / 2.50 | 1,048,576 in / 65,536 out; function calling, structured output, thinking (default `minimal`), caching. **Cheap/fast.** |
| `gemini-3.1-flash-lite` | stable | 2026-05-07 | yes | 0.25 / 1.50 | earliest shutdown 2027-05-07, replacement `gemini-3.5-flash-lite` |
| `gemini-3.1-pro-preview` | preview | 2026-02-19 | **no** | 2.00 / 12.00 | paid only; not offered in our UI by default |
| `gemini-2.5-flash` / `-flash-lite` / `-pro` | stable (old family) | 2025 | yes | 0.30/2.50, 0.10/0.40, 1.25/10.00 | no shutdown date announced; `gemini-2.5-flash-lite` is the rock-bottom price option |

Aliases: the SDK README uses `gemini-flash-latest`. Docs: `latest` aliases are "hot-swapped with every new release" with 2-week
notice for breaking changes. **Do not use aliases as the shipped default** - pin `gemini-3.8-flash`, but make the model id a free-text
setting (with the two presets) so the user can move when Google retires a model. Populate a dropdown from `ai.models.list()` if wanted.

Output price includes thinking tokens ("Response pricing is the sum of output tokens and thinking tokens").

Thinking defaults: most models `medium`; `gemini-3.5-flash-lite` `minimal`. For message classification/extraction use
`thinking_level: 'low'` (or `minimal`) to keep latency and cost down; `medium` for the scheduling/tool-calling pass.

Hebrew: handled natively by all of these models (no special config). **UNVERIFIED**: relative Hebrew quality of 3.5-flash-lite vs 3.8-flash - needs our own eval set.

### 3.1 Free tier

- Exists for all Flash / Flash-Lite models above. Israel is in the supported-regions list; user must be 18+.
- **Exact RPM / TPM / RPD are no longer published in the docs.** The rate-limits page says limits "can be viewed in Google AI Studio"
  (https://aistudio.google.com/rate-limit) and depend on project/tier. Third-party blogs quote, for the 2.5 family,
  roughly Flash 10 RPM / 250 RPD and Flash-Lite 15 RPM / 1,000 RPD after the Dec-2025 cut - **UNVERIFIED and not for 3.x models**. Design for "about 10 RPM, a few hundred requests/day".
- Tiers: Free -> Tier 1 (billing account linked) -> Tier 2 ($100 paid + 3 days) -> Tier 3 ($1,000 + 30 days).
- **Privacy: on the free tier, prompts/responses ARE used to improve Google products; on paid tier they are not.** Since we send
  private WhatsApp messages, the settings screen must state this next to the Gemini option (HE + EN) and recommend a billing-enabled key.
- Stored interactions retention (only if `store: true`, which we never use): free 1 day, paid 55 days.
- Consequences for the app: one LLM call per incoming message will burn a free quota fast. Debounce per chat (batch a burst of
  messages into one call), cap concurrency to 1 for Gemini, and surface 429 `quota_exceeded` as "daily Gemini quota used up" rather than retrying.

### 3.2 API keys

- Create at https://aistudio.google.com/apikey . Header on the wire: `x-goog-api-key`.
- Since 2026-05-28 all new AI Studio keys are **"auth keys"** (bound to a service account). Docs: unrestricted *standard* keys are already
  rejected, and "On September 2026 the Gemini API will reject requests from standard keys". SDK usage is identical for both kinds.
- Therefore: **do not regex-validate the key format** (no `^AIza` check - new key format/prefix is UNVERIFIED). Validate by calling the API.
  If a user pastes an old standard key, expect 401/403 - show "create a new key in AI Studio".
- Store with Electron `safeStorage` (DPAPI on Windows); never log it; never send it to the renderer after saving.

---

## 4. Function calling - Interactions API shape (primary)

Source: https://ai.google.dev/gemini-api/docs/function-calling , /interactions , SDK types.

### 4.1 Request

```ts
const interaction = await ai.interactions.create({
  model: 'gemini-3.8-flash',
  store: false,                                   // REQUIRED for us (privacy); disables previous_interaction_id
  system_instruction: systemPrompt,               // plain string
  input: steps,                                   // string | Content | Step[]  (we always send Step[])
  tools: [
    { type: 'function', name: 'list_events', description: '...', parameters: { type: 'object', properties: {...}, required: [...] } },
  ],
  generation_config: {
    thinking_level: 'low',                        // 'minimal' | 'low' | 'medium' | 'high'
    max_output_tokens: 2048,
    tool_choice: 'auto',                          // 'auto' | 'any' | 'none' | 'validated'
    // or: tool_choice: { allowed_tools: { mode: 'any', tools: ['list_events'] } }
  },
  // response_format: { type: 'text', mime_type: 'application/json', schema: jsonSchema },   // structured output
}, { signal, timeout_ms: 60_000 });
```

`tools`, `system_instruction` and `generation_config` are interaction-scoped - they must be re-sent on every call.

### 4.2 Response

`interaction.status`: `'completed' | 'requires_action' | 'failed' | 'cancelled' | 'incomplete' | 'in_progress' | ...`
(`requires_action` = the model is waiting for function results).
`interaction.steps: Step[]` - the ones we care about:

```ts
{ type: 'thought', signature?: string, summary?: [...] }            // MUST be echoed back verbatim in stateless mode
{ type: 'function_call', id: string, name: string, arguments: {...} }
{ type: 'model_output', content: [{ type: 'text', text: string }], error?: Status }
```
`interaction.output_text` is an SDK convenience = concatenated text of the last model output.
`interaction.usage` holds token counts.

Parallel calls = several `function_call` steps in one response. Compositional (chained) calling = the loop simply runs more rounds.

### 4.3 Sending results back (stateless)

```ts
history.push(...interaction.steps);               // includes thought steps + signatures, untouched
history.push({
  type: 'function_result',
  call_id: fc.id,                                 // must equal function_call.id
  name: fc.name,
  is_error: false,                                // true when the tool failed or the USER REJECTED it
  result: [{ type: 'text', text: JSON.stringify(result) }],   // or a plain string
});
// then call ai.interactions.create again with input: history
```
User turns are `{ type: 'user_input', content: [{ type: 'text', text }] }`.

### 4.4 Thought signatures

- Docs (thinking guide): in the Interactions API signatures appear only on `thought` steps and built-in-tool steps, never on
  `function_call` steps. In stateless mode "you MUST always resend all thought blocks exactly as they were received".
- Violations surface as error code `missing_thought_signature` / HTTP 400.
- Implementation rule: the provider stores the raw `steps` array of every assistant turn in an opaque `providerState` field on the
  neutral assistant message and replays it byte-for-byte. Never rebuild Gemini assistant turns from `{text, toolCalls}` when
  `providerState` from Gemini is present.
- If the user switches provider mid-run, another provider's history has no signatures. Simplest safe policy: a run (one analysis of
  one chat) is always finished by the provider that started it; a provider switch applies to the next run. **UNVERIFIED** whether Gemini
  accepts a history whose function_call steps come without preceding thought steps.

---

## 5. MCP: `mcpToTool` vs manual loop

Facts (SDK source `mcpToGeminiTool`, `shouldDisableAfc`, README, legacy function-calling doc):

- `mcpToTool(...clients, config?)` is exported, marked `@experimental` ("may change in future versions"), only supports MCP **tools**
  (no resources/prompts), and works with `models.generateContent` / `chats`, **not** with `ai.interactions`.
- It returns a `CallableTool` (`tool()` + `callTool()`); the presence of a callable tool turns on **automatic function calling**:
  the SDK itself calls `client.callTool(...)` for every function call the model emits, up to `maximumRemoteCalls` (default 10), and
  only returns the final text. There is no per-call hook.
- It can be neutralised with `config.automaticFunctionCalling.disable = true`, at which point it is only a schema converter - and
  the conversion is a one-liner: `parametersJsonSchema: mcpTool.inputSchema`, no sanitising.
- The Interactions API additionally has a server-side tool `{ type: 'mcp_server', ... }` where **Google's backend** connects to a remote
  MCP server. Useless for a local stdio calendar server and it would bypass approval entirely.

**Decision: manual loop, no `mcpToTool`, no `mcp_server`.** Reasons: (1) locked APPROVAL-FIRST rule - every WRITE tool
(`create_event`, `update_event`, `delete_event`, ...) must stop and wait for a click, which AFC cannot do; (2) the same loop must
serve Local and Claude providers, so tool execution belongs in a provider-agnostic orchestrator, not in a provider SDK; (3) experimental API.

Provider contract therefore: `chat()` performs exactly **one** model round and returns `toolCalls`; it never executes anything.
The orchestrator classifies each call (read vs write, by an allow-list of tool names that defaults to *write* for unknown tools),
auto-runs reads through the MCP client, parks writes as "pending approval" cards, and feeds results (or
`is_error: true, "User declined"`) back in the next `chat()` call.

---

## 6. Adapting JSON-Schema tool parameters

What Gemini accepts:

- Interactions `function.parameters` / legacy `parametersJsonSchema` take **JSON Schema**, but only a subset is honoured. The
  documented supported keyword list (SDK doc-comment for `responseJsonSchema`, same engine): `$id, $defs, $ref, $anchor, type, format,
  title, description, enum (strings/numbers), items, prefixItems, minItems, maxItems, minimum, maximum, anyOf, oneOf (treated as anyOf),
  properties, additionalProperties, required` + non-standard `propertyOrdering`. "If `$ref` is set on a sub-schema, no other properties
  [except `$`-prefixed] may be set." Cyclic refs "are unrolled to a limited degree" and only allowed in non-required properties.
- The older OpenAPI-3.0 `Schema` object (`parameters` with `Type.OBJECT` enums, `nullable`) rejects `additionalProperties`, `$ref`,
  `oneOf`, `const`, type arrays. That is where the well-known "additionalProperties / $ref not supported" errors come from. We avoid that field.
- Not in the supported list (dropped or may 400): `$schema`, `const`, `default`, `examples`, `pattern`, `minLength`, `maxLength`,
  `exclusiveMinimum/Maximum`, `multipleOf`, `uniqueItems`, `allOf`, `not`, `if/then/else`, `patternProperties`, `dependentRequired`,
  `type: [..]` arrays. **UNVERIFIED** which of these are silently ignored vs rejected with 400 on the Interactions endpoint - hence sanitize.
- Names: function name must start with a letter/underscore, chars `a-zA-Z0-9_.:-`, max 128 (SDK doc-comment). Parameter names `a-zA-Z0-9_`, max 64.
  MCP tool names with other characters (e.g. `/` or spaces) must be mapped and mapped back.
- "Very large or deeply nested schemas may be rejected" (no numbers given). Keep exposed tools to the handful of calendar tools
  actually needed (docs best practice: fewer, well-described tools; historically 10-20 max recommended - number UNVERIFIED for 3.x).

Sanitizer (whitelist, pure function, unit-testable):

```ts
const KEEP = new Set(['type','format','title','description','enum','items','prefixItems','minItems','maxItems',
  'minimum','maximum','anyOf','properties','required','additionalProperties','propertyOrdering']);
const FORMATS = new Set(['date-time','date','time']);

export function toGeminiSchema(schema: any, root: any = schema, depth = 0): any {
  if (!schema || typeof schema !== 'object' || depth > 12) return {};
  if (typeof schema.$ref === 'string') {                       // inline local refs; break cycles by depth
    const target = schema.$ref.replace(/^#\//, '').split('/').reduce((o: any, k: string) => o?.[decodeURIComponent(k)], root);
    return toGeminiSchema(target, root, depth + 1);
  }
  let s: any = { ...schema };
  if (Array.isArray(s.allOf)) { for (const part of s.allOf) s = mergeObjectSchemas(s, toGeminiSchema(part, root, depth + 1)); }
  if (s.oneOf && !s.anyOf) s.anyOf = s.oneOf;
  if ('const' in s) s.enum = [s.const];
  if (Array.isArray(s.type)) {                                 // ["string","null"] -> "string"
    const t = s.type.filter((x: string) => x !== 'null'); s.type = t[0] ?? 'string';
  }
  const hints: string[] = [];
  for (const k of ['pattern','minLength','maxLength','default','multipleOf','exclusiveMinimum','exclusiveMaximum'])
    if (s[k] !== undefined) hints.push(`${k}: ${JSON.stringify(s[k])}`);
  const out: any = {};
  for (const [k, v] of Object.entries(s)) if (KEEP.has(k)) out[k] = v;
  if (out.format && !FORMATS.has(out.format)) { hints.push(`format: ${out.format}`); delete out.format; }
  if (hints.length) out.description = [out.description, `(${hints.join(', ')})`].filter(Boolean).join(' ');
  if (out.anyOf) { out.anyOf = out.anyOf.map((x: any) => toGeminiSchema(x, root, depth + 1)); delete out.type; } // SDK: type+anyOf cannot both be set
  if (out.properties) out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, toGeminiSchema(v, root, depth + 1)]));
  if (out.items) out.items = toGeminiSchema(out.items, root, depth + 1);
  if (out.prefixItems) out.prefixItems = out.prefixItems.map((x: any) => toGeminiSchema(x, root, depth + 1));
  if (typeof out.additionalProperties === 'object') out.additionalProperties = toGeminiSchema(out.additionalProperties, root, depth + 1);
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}
```
(`mergeObjectSchemas` = shallow merge of `properties` + union of `required`.) Dropped constraints are moved into `description` so the
model still sees them; the orchestrator must re-validate tool arguments against the ORIGINAL MCP schema (e.g. with `ajv`) before
showing an approval card or calling the MCP server, because Gemini no longer enforces what we stripped.

Tool name mapping: `safe = name.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 128)`, keep a `Map<safe, original>` per request.

---

## 7. Structured output

- Interactions: `response_format: { type: 'text', mime_type: 'application/json', schema: <JSON Schema> }` (top-level
  `response_mime_type` is deprecated). Same schema subset as section 6; run the sanitizer on it too.
- Gemini 3.x can combine structured output with function calling in one request (docs: "Gemini 3 lets you combine Structured Outputs
  with built-in tools ... and Function Calling").
- Streamed chunks are "valid partial JSON strings that can be concatenated".
- Still `JSON.parse` in try/catch and validate with zod/ajv; on failure retry once.
- Use for the classification pass (`{ category: 'needs_reply'|'in_calendar'|'info_missing'|'ignore', missing: string[], draftReply, proposedEvent }`).
  Portable alternative that works identically across all three providers: a fake "report_result" function with `tool_choice: 'any'`.
  Pick one approach app-wide; provider should support both.

---

## 8. Streaming

```ts
const stream = await ai.interactions.create({ ...params, stream: true }, { signal });
for await (const ev of stream) {
  switch (ev.event_type) {
    case 'step.start':  /* ev.index, ev.step: for function_call carries id + name */ break;
    case 'step.delta':  /* ev.delta.type === 'text' -> ev.delta.text
                           ev.delta.type === 'arguments_delta' -> ev.delta.arguments (JSON string fragment, accumulate per ev.index)
                           thought_summary / thought signature deltas also arrive here */ break;
    case 'step.stop':   break;
    case 'interaction.completed': /* ev.interaction: status, usage; steps may be omitted */ break;
    case 'error':       /* ev.error */ break;
  }
}
```
Event order: `interaction.created` -> `interaction.status_update` -> (`step.start` -> `step.delta`* -> `step.stop`)* -> `interaction.completed`.

Recommendation: **v1 uses non-streaming.** Drafts are short, the UI shows cards not a chat transcript, and with stateless mode we must
reassemble complete `thought` steps (incl. signature deltas) from the stream to replay them - extra surface for bugs. **UNVERIFIED**:
exact field name of the step object on `step.start` and of signature deltas; check `Interactions.StepStart` / `StepDeltaData` types when implementing. Add streaming later behind the same interface (`onTextDelta` callback).

---

## 9. Abort, timeouts, retries

- Interactions: `create(params, options)` where `options` = `RequestOptions & RequestInit` -> `{ signal, timeout_ms, retries, retry_codes }`
  (wrapper also accepts `timeout`, `maxRetries`). `signal` takes precedence over `timeout_ms`.
- Legacy: `config.abortSignal`, `config.httpOptions.timeout`, `httpOptions.retryOptions { attempts (default 5), initialDelay, maxDelay, expBase, jitter, httpStatusCodes }` (retries 408/429/5xx when enabled).
- SDK comment: "AbortSignal is a client-only operation ... You will still be charged".
- Aborted requests reject with `APIUserAbortError` / `RequestAbortedError` / DOM `AbortError` depending on layer - normalise with `signal.aborted`.
- Policy: `timeout_ms: 60_000`; SDK retries off or max 2 for 5xx/503 only; our own handling for 429 (below) so the UI can show state.

---

## 10. Error handling

Interactions errors (docs https://ai.google.dev/gemini-api/docs/api-errors ; body `error.code` strings):

| HTTP | code | App behaviour |
|---|---|---|
| 400 | `invalid_request`, `parameter_unknown`, `failed_precondition` | bug or bad schema -> log (redacted), mark provider error, no retry. `failed_precondition` can mean free tier not available / billing needed. |
| 401 | `authentication` | "API key missing, invalid, or expired" -> settings prompt |
| 402 | `payment_required` | prepaid credit exhausted -> tell user |
| 403 | `permission_denied` | key lacks permission / old standard key -> settings prompt |
| 404 | `model_not_found`, `not_found` | model retired -> fall back to preset + notify |
| 429 | `rate_limit_exceeded`, `too_many_requests` | backoff (honour `retry-after` if present), max 3 tries |
| 429 | `quota_exceeded` | daily quota -> stop, show banner, do NOT retry until next day / provider switch |
| 499 | `cancelled` | ignore |
| 500/503/504 | `api_error`, `service_unavailable`, `deadline_exceeded` | retry with backoff, max 2 |

Thrown classes for `ai.interactions.*` are internal (`APIError` subclasses: `AuthenticationError`, `RateLimitError`, ... and
`GoogleGenAiError`); they are not exported as values, so **duck-type**: `const status = e?.status ?? e?.statusCode`, body in `e.error` / `e.body`.
Legacy `ai.models.*` throws the exported `ApiError` (`e.status`, `e.message`).

Non-HTTP failures inside a 200: `interaction.status` `failed` / `incomplete`, `model_output.error`, `interaction.errors[]`, and
generation codes: blocked - `safety`, `prohibited_content`, `spii`, `recitation`, `language`, `blocklist`, `content_blocked`; generation -
`malformed_function_call`, `unexpected_tool_call`, `too_many_tool_calls`, `missing_thought_signature`. Treat `malformed_function_call`
as retry-once; treat blocks as "could not analyse this message" (item stays in Needs reply without a draft). Empty text + no tool calls = error.
Never trust `function_call.name`: reject names not in the request's tool map.

Logging: never log the API key or the message bodies at info level.

---

## 11. API-key validation call

```ts
export async function validateGeminiKey(apiKey: string, model = 'gemini-3.5-flash-lite', signal?: AbortSignal) {
  const ai = new GoogleGenAI({ apiKey });
  try {
    await ai.models.get({ model, config: { abortSignal: signal, httpOptions: { timeout: 15_000 } } }); // GET /v1beta/models/{id}, no tokens
    return { ok: true as const };
  } catch (e: any) {
    const status = e?.status ?? e?.statusCode;
    if (status === 400 || status === 401 || status === 403) return { ok: false as const, reason: 'invalid_key' };
    if (status === 404) return { ok: false as const, reason: 'model_not_found' };          // key fine, model id wrong
    return { ok: false as const, reason: 'network', detail: String(e?.message ?? e) };
  }
}
```
Historically an invalid key returned **400** `API_KEY_INVALID` on the v1beta REST surface, the new error table says 401 - handle both.
`models.get` proves the key is valid but not that quota/billing allows generation; optionally follow with a 1-token
`interactions.create({ model, input: 'ping', store: false, generation_config: { max_output_tokens: 1, thinking_level: 'minimal' } })`
behind a "Test" button (costs a request from the free quota). **UNVERIFIED** live.

---

## 12. Minimal provider code shape

Neutral types (shared by Local / Claude / Gemini providers - align with the llm-provider-interface research/agent):

```ts
export type ChatMessage =
  | { role: 'system'; text: string }
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; providerState?: { provider: string; data: unknown } }
  | { role: 'tool'; toolCallId: string; name: string; result: string; isError?: boolean };

export interface ToolDef { name: string; description: string; inputSchema: Record<string, unknown> }   // = MCP tool
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface ChatResult { text: string; toolCalls: ToolCall[]; providerState?: { provider: string; data: unknown };
                              usage?: { inputTokens?: number; outputTokens?: number }; stopReason?: string }
export interface LlmProvider { readonly id: 'local' | 'claude' | 'gemini';
  chat(messages: ChatMessage[], tools: ToolDef[], signal?: AbortSignal, opts?: ChatOptions): Promise<ChatResult>; }
export interface ChatOptions { jsonSchema?: Record<string, unknown>; forceTool?: string; thinking?: 'minimal'|'low'|'medium'|'high'; maxOutputTokens?: number }
```

```ts
// src/main/llm/providers/gemini.ts
import { GoogleGenAI } from '@google/genai';
import { toGeminiSchema } from './gemini-schema';

export class GeminiProvider implements LlmProvider {
  readonly id = 'gemini' as const;
  private ai: GoogleGenAI;
  constructor(apiKey: string, private model = 'gemini-3.8-flash') { this.ai = new GoogleGenAI({ apiKey }); }

  async chat(messages: ChatMessage[], tools: ToolDef[], signal?: AbortSignal, opts: ChatOptions = {}): Promise<ChatResult> {
    const nameMap = new Map<string, string>();                                   // safe -> original
    const fnTools = tools.map(t => {
      const safe = t.name.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 128); nameMap.set(safe, t.name);
      return { type: 'function' as const, name: safe, description: t.description, parameters: toGeminiSchema(t.inputSchema) };
    });
    const toSafe = (n: string) => [...nameMap].find(([, o]) => o === n)?.[0] ?? n;

    const system = messages.filter(m => m.role === 'system').map(m => m.text).join('\n\n') || undefined;
    const input: any[] = [];
    for (const m of messages) {
      if (m.role === 'user') input.push({ type: 'user_input', content: [{ type: 'text', text: m.text }] });
      else if (m.role === 'assistant') {
        if (m.providerState?.provider === 'gemini') input.push(...(m.providerState.data as any[]));   // raw steps incl. thought signatures
        else {                                                                                         // foreign history (best effort, see 4.4)
          if (m.text) input.push({ type: 'model_output', content: [{ type: 'text', text: m.text }] });
          for (const c of m.toolCalls) input.push({ type: 'function_call', id: c.id, name: toSafe(c.name), arguments: c.args });
        }
      } else if (m.role === 'tool')
        input.push({ type: 'function_result', call_id: m.toolCallId, name: toSafe(m.name), is_error: !!m.isError,
                     result: [{ type: 'text', text: m.result }] });
    }

    try {
      const it: any = await this.ai.interactions.create({
        model: this.model, store: false, input, system_instruction: system,
        tools: fnTools.length ? fnTools : undefined,
        generation_config: {
          thinking_level: opts.thinking ?? 'low', max_output_tokens: opts.maxOutputTokens ?? 2048,
          ...(opts.forceTool ? { tool_choice: { allowed_tools: { mode: 'any', tools: [toSafe(opts.forceTool)] } } } : {}),
        },
        ...(opts.jsonSchema ? { response_format: { type: 'text', mime_type: 'application/json', schema: toGeminiSchema(opts.jsonSchema) } } : {}),
      } as any, { signal, timeout_ms: 60_000 } as any);

      if (it.status === 'failed' || it.status === 'cancelled') throw new LlmError('provider_failed', JSON.stringify(it.errors ?? it.status));
      const steps: any[] = it.steps ?? [];
      const toolCalls: ToolCall[] = steps.filter(s => s.type === 'function_call').map(s => {
        const original = nameMap.get(s.name);
        if (!original) throw new LlmError('unexpected_tool_call', s.name);
        return { id: s.id, name: original, args: s.arguments ?? {} };
      });
      const text = it.output_text ?? steps.filter(s => s.type === 'model_output')
        .flatMap(s => s.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
      if (!text && toolCalls.length === 0) throw new LlmError('empty_response', it.status);
      return { text: text ?? '', toolCalls, providerState: { provider: 'gemini', data: steps },
               usage: { inputTokens: it.usage?.total_input_tokens, outputTokens: it.usage?.total_output_tokens },   // field names UNVERIFIED
               stopReason: it.status };
    } catch (e: any) {
      if (signal?.aborted) throw new LlmError('aborted');
      if (e instanceof LlmError) throw e;
      const status = e?.status ?? e?.statusCode;
      const code = e?.error?.code ?? e?.error?.error?.code;                                   // body shape UNVERIFIED
      if (status === 401 || status === 403) throw new LlmError('auth', e.message);
      if (status === 429) throw new LlmError(code === 'quota_exceeded' ? 'quota' : 'rate_limit', e.message);
      if (status === 404) throw new LlmError('model_not_found', e.message);
      if (status >= 500) throw new LlmError('server', e.message);
      throw new LlmError('bad_request', e?.message ?? String(e));
    }
  }
}
```

Notes:
- The provider performs ONE round. The orchestrator loop (shared) does: `chat` -> split toolCalls into read/write -> execute reads via MCP
  client -> queue writes for approval -> append `assistant` (with `providerState`) + `tool` messages -> `chat` again; cap at ~6 rounds.
- `as any` casts: the request types are exposed under the `Interactions` namespace (`Interactions.CreateModelInteractionParamsNonStreaming`,
  `Interactions.FunctionCallStep`, ...); replace the casts with those during implementation.
- Tests: inject a fake `ai` (constructor overload or `vi.mock('@google/genai')`) - no network in CI. Contract-test fixtures should be captured once with a real key by the user.

### Legacy fallback shape (`generateContent`) - only if Interactions misbehaves

```ts
const res = await ai.models.generateContent({
  model, contents,                                   // [{ role:'user'|'model', parts:[{text}|{functionCall}|{functionResponse}] }]
  config: { systemInstruction, abortSignal: signal,
    tools: [{ functionDeclarations: tools.map(t => ({ name, description, parametersJsonSchema: toGeminiSchema(t.inputSchema) })) }],
    toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
    thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    responseMimeType: 'application/json', responseJsonSchema: schema },   // optional
});
res.functionCalls   // [{ id, name, args }]
res.text
// reply: push res.candidates[0].content UNCHANGED (parts carry thoughtSignature), then
// { role:'user', parts:[{ functionResponse:{ id, name, response:{ output } } }] }     ('error' key for failures)
```
Here signatures live on `Part.thoughtSignature` and docs say "Always send the thought_signature back to the model inside its original Part".
Plain function declarations (no callable tools) never trigger AFC.

---

## 13. Open questions / UNVERIFIED list

1. No live request was executed (no key). Wire-level details - usage field names, error body shape, `step.start` payload - need one smoke test with the user's key.
2. Free-tier RPM/RPD numbers for 3.x models are only visible inside AI Studio per project.
3. Which unsupported JSON-Schema keywords are ignored vs rejected on the Interactions endpoint (sanitizer makes this moot).
4. Whether Gemini accepts stateless history lacking thought steps (provider switch mid-run).
5. New "auth key" string format.
6. Hebrew quality of `gemini-3.5-flash-lite` for date/time extraction ("yom chamishi ba-5") - needs the project's eval set.
7. Max number of function declarations recommended for 3.x.

---

## 14. Sources

- npm registry: https://registry.npmjs.org/@google/genai/latest (2.23.0) ; installed package `dist/genai.d.ts`, `dist/node/index.mjs`
- SDK README: https://github.com/googleapis/js-genai (raw: https://raw.githubusercontent.com/googleapis/js-genai/main/README.md)
- Models: https://ai.google.dev/gemini-api/docs/models ; https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite
- Pricing: https://ai.google.dev/gemini-api/docs/pricing
- Rate limits: https://ai.google.dev/gemini-api/docs/rate-limits ; https://aistudio.google.com/rate-limit
- Deprecations: https://ai.google.dev/gemini-api/docs/deprecations ; Changelog: https://ai.google.dev/gemini-api/docs/changelog
- Interactions API: https://ai.google.dev/gemini-api/docs/interactions ; streaming: https://ai.google.dev/gemini-api/docs/interactions/streaming
- Function calling (Interactions): https://ai.google.dev/gemini-api/docs/function-calling
- Function calling (legacy, incl. MCP section): https://ai.google.dev/gemini-api/docs/generate-content/function-calling
- Thinking + signatures: https://ai.google.dev/gemini-api/docs/thinking#signatures
- Structured output: https://ai.google.dev/gemini-api/docs/structured-output
- Errors: https://ai.google.dev/gemini-api/docs/api-errors ; https://ai.google.dev/gemini-api/docs/troubleshooting
- API keys: https://ai.google.dev/gemini-api/docs/api-key ; regions: https://ai.google.dev/gemini-api/docs/available-regions
- Third-party free-tier numbers (UNVERIFIED): https://www.aifreeapi.com/en/posts/gemini-api-free-tier-rate-limits
