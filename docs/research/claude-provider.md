# Research: Claude provider (Anthropic API)

Researched 2026-09-21 for "WhatsApp Calendar Agent" (Electron + TypeScript, Node 24).
Sources: the bundled `claude-api` skill (cached 2026-06-24), live `platform.claude.com` docs, the npm registry, and the `anthropics/anthropic-sdk-typescript` repo. Anything not confirmed against one of those is marked **UNVERIFIED**.

---

## 1. TL;DR recommendation

| Item | Value |
|---|---|
| SDK | `@anthropic-ai/sdk` **0.127.0** (npm `latest`, published 2026-09-18). Peer dep: `zod ^3.25.0 \|\| ^4.0.0` (optional unless Zod helpers are used). |
| MCP SDK (for the helper types / client) | `@modelcontextprotocol/sdk` **1.30.0** |
| Default (capable) model | `claude-opus-5` - the docs' "start here" model. $5 / $25 per MTok. |
| Balanced option (expose in settings) | `claude-sonnet-5` - $2 / $10 per MTok, "best combination of speed and intelligence". |
| Cheap + fast model | `claude-haiku-4-5` (alias; pinned id `claude-haiku-4-5-20251001`) - $1 / $5 per MTok, 200K context. |
| Endpoint | `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`, `anthropic-version: 2023-06-01` (SDK sets them). |
| Where the SDK runs | Electron **main process** only (never the renderer - no `dangerouslyAllowBrowser`). Key stored with Electron `safeStorage`. |
| Tool loop | **Manual loop**, not the SDK tool runner, so that the app (not the SDK) decides which MCP tools execute. Required by the APPROVAL-FIRST rule. |
| MCP -> Claude tools | `{ name, description, input_schema: mcpTool.inputSchema }` (one-line mapping). Official helper `mcpTools()` exists in `@anthropic-ai/sdk/helpers/beta/mcp` but auto-executes tools through the tool runner - use it only for a read-only tool subset, or not at all. |
| Key validation | `client.models.retrieve("<selected model id>")` - free GET, proves the key is valid *and* the model is available. Optional paid probe: `messages.create` with `max_tokens: 1` on Haiku to detect "no credits". |
| Cost per ~1.5k-token triage call | Haiku 4.5 ~$0.0025, Sonnet 5 ~$0.005-0.008, Opus 5 ~$0.0125-0.02 (section 10). |

Model choice note: the official models page says "If you're unsure which model to use, start with Claude Opus 5 for most workloads." The end user pays with their own key, so the settings UI should offer all three ids and the product owner should pick the shipped default (see Open questions).

---

## 2. SDK package and client setup

```bash
npm install @anthropic-ai/sdk@^0.127.0
```

Verified with `npm view @anthropic-ai/sdk` on 2026-09-21: `latest = 0.127.0`, deps `standardwebhooks`, `json-schema-to-ts`; peer `zod ^3.25.0 || ^4.0.0`. The package export map exposes `./helpers/*` (so `@anthropic-ai/sdk/helpers/beta/mcp`, `.../helpers/zod`, `.../helpers/json-schema`, `.../helpers/beta/zod`, `.../helpers/beta/json-schema` resolve in both ESM and CJS).

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey,              // from Electron safeStorage; NEVER read from renderer
  maxRetries: 2,       // default 2; retries 408/409/429/5xx + connection errors with backoff
  timeout: 60_000,     // MILLISECONDS in the TS SDK (default is 10 min - too long for a desktop UI)
});
```

Notes
- The zero-arg constructor resolves `ANTHROPIC_API_KEY` -> `ANTHROPIC_AUTH_TOKEN` -> `ant auth login` profile. For this app always pass `apiKey` explicitly so a stray env var on the user's machine cannot shadow the key typed in Settings. If both `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are set in the environment the API rejects the request (401) - another reason to pass the key explicitly. **UNVERIFIED**: whether an explicit `apiKey` fully suppresses the env `ANTHROPIC_AUTH_TOKEN` header in 0.127.0; defensively `delete process.env.ANTHROPIC_AUTH_TOKEN` is not needed if you construct with `{ apiKey, authToken: null }`.
- Per-request options are the 2nd argument: `client.messages.create(params, { signal, timeout, maxRetries })`. `signal` is a standard `AbortSignal` - this is how `chat(..., signal)` cancels.
- Timeouts are retried: worst-case wall clock = `timeout x (maxRetries + 1)`.
- Use SDK types, do not redefine them: `Anthropic.MessageParam`, `Anthropic.Tool`, `Anthropic.Message`, `Anthropic.ToolUseBlock`, `Anthropic.ToolResultBlockParam`, `Anthropic.TextBlock`.

---

## 3. Current models (verified 2026-09-21)

Source: https://platform.claude.com/docs/en/about-claude/models/overview and https://platform.claude.com/docs/en/about-claude/model-deprecations

| Model | API id | Context | Max output | Input $/MTok | Output $/MTok | Cache read | 5m cache write | Thinking | `effort` | Retirement (not sooner than) |
|---|---|---|---|---|---|---|---|---|---|---|
| Claude Fable 5.1 | `claude-fable-5-1` | 1M | 128K | 10 | 50 | 0.25 | 12.50 | adaptive, always on | yes | 2027-09-01 |
| Claude Opus 5 | `claude-opus-5` | 1M | 128K | 5 | 25 | 0.50 | 6.25 | adaptive, on by default | yes (`low`..`max`) | 2027-07-24 |
| Claude Sonnet 5 | `claude-sonnet-5` | 1M | 128K | 2 | 10 | 0.20 | 2.50 | adaptive | yes | 2027-06-30 |
| Claude Haiku 4.5 | `claude-haiku-4-5` (alias of `claude-haiku-4-5-20251001`) | 200K | 64K | 1 | 5 | 0.10 | 1.25 | extended (`budget_tokens`), off by default | **not supported - sending it errors** | **2026-10-15** |

Important per-model behaviours for a provider-neutral wrapper:
- **Do not send `temperature` / `top_p` / `top_k`** to Opus 5, Sonnet 5, Fable: non-default values return 400. Haiku 4.5 still accepts them. Simplest: never send them.
- **Do not send `thinking: {type:"enabled", budget_tokens}`** to Opus 5 / Sonnet 5 (400). Omit `thinking` (adaptive is the default on Opus 5 / Sonnet 5) and steer cost with `output_config: { effort: "low" | "medium" | "high" | "xhigh" | "max" }`. For triage use `effort: "low"`.
- **Haiku 4.5**: omit `thinking` entirely (runs with no thinking) and **omit `output_config.effort`** (errors on Haiku 4.5). The provider must branch on model id for these two fields.
- **No assistant prefill** on any current model (400). Use structured outputs for JSON.
- Opus 5 pitfall: `thinking: {type:"disabled"}` can make the model write a tool call as plain text instead of a `tool_use` block. Do not disable thinking on Opus 5; lower `effort` instead.
- Tokenizer: Opus 4.7+ / Sonnet 5 / Opus 5 use a newer tokenizer that yields roughly 30% more tokens for the same text than Haiku 4.5's tokenizer. Hebrew text tokenizes less efficiently than English on every model (**UNVERIFIED** exact ratio - measure with `client.messages.countTokens`).
- Haiku 4.5 is still `Active` (not deprecated) but its "not sooner than" date is 2026-10-15, 3.5 weeks from today. Anthropic promises >= 60 days notice before retirement and none has been announced, so it cannot disappear before roughly late November 2026 - but do not hard-code the model list. Populate the settings dropdown from `client.models.list()` and keep the three ids above only as defaults/fallbacks.

Live model discovery (free): `client.models.list()` (auto-paginates) / `client.models.retrieve(id)` return `id`, `display_name`, `created_at`, `max_input_tokens`, `max_tokens`, `capabilities`.

---

## 4. Tool use: exact request/response shape

### 4.1 Request

```jsonc
POST /v1/messages
{
  "model": "claude-opus-5",
  "max_tokens": 4096,
  "system": [
    { "type": "text", "text": "<long stable system prompt>", "cache_control": { "type": "ephemeral" } }
  ],
  "tools": [
    {
      "name": "list_events",                       // ^[a-zA-Z0-9_-]{1,64}$
      "description": "List calendar events in a time range ...",
      "input_schema": {                             // JSON Schema, root MUST be type: "object"
        "type": "object",
        "properties": {
          "timeMin": { "type": "string", "description": "RFC3339" },
          "timeMax": { "type": "string" }
        },
        "required": ["timeMin", "timeMax"]
      }
      // optional: "strict": true  (then schema needs additionalProperties:false + required, limited keyword subset)
      // optional: "cache_control": {"type":"ephemeral"} on the LAST tool to cache the whole tools block
      // optional: "eager_input_streaming": true (streaming requests only)
    }
  ],
  "tool_choice": { "type": "auto" },                // auto | any | tool{name} | none ; + "disable_parallel_tool_use": true
  "output_config": { "effort": "low" },             // NOT on Haiku 4.5
  "messages": [ { "role": "user", "content": "..." } ]
}
```

`tool_choice` caveat: `any` / `tool` are rejected (400) on `claude-fable-5-1`; they work on Opus 5 / Sonnet 5 / Haiku 4.5. Prefer `auto` everywhere so the provider is model-agnostic.

### 4.2 Response

```jsonc
{
  "id": "msg_...", "type": "message", "role": "assistant", "model": "claude-opus-5",
  "content": [
    { "type": "thinking", "thinking": "", "signature": "..." },          // may appear; echo back unchanged
    { "type": "text", "text": "Let me check Thursday." },
    { "type": "tool_use", "id": "toolu_01...", "name": "list_events", "input": { "timeMin": "...", "timeMax": "..." } }
  ],
  "stop_reason": "tool_use",
  "usage": { "input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0 }
}
```

### 4.3 The loop

1. Send request. 2. If `stop_reason === "tool_use"`: append the assistant turn **with the full `response.content` array** (thinking blocks included, unmodified), execute each `tool_use`, then append **one** user message whose content is **all** the `tool_result` blocks:

```jsonc
{ "role": "user", "content": [
  { "type": "tool_result", "tool_use_id": "toolu_01...", "content": "<string or content blocks>" },
  { "type": "tool_result", "tool_use_id": "toolu_02...", "content": "calendar unreachable", "is_error": true }
] }
```

3. Repeat until a terminal stop reason.

Rules that bite:
- Parallel tool calls are on by default: one assistant message can carry several `tool_use` blocks. Return every result in a single user message; never drop one - answer failures/denials with `is_error: true`.
- Every `tool_use` id must be answered before the next assistant turn, otherwise 400.
- `tool.input` is already a parsed object in the SDK; never string-match the serialized JSON.
- Tool-use system-prompt overhead (billed input tokens whenever `tools` is non-empty): Opus 5 286, Sonnet 5 354, Haiku 4.5 496 tokens (`auto`/`none`).

### 4.4 Stop reasons

| `stop_reason` | Meaning | Provider action |
|---|---|---|
| `end_turn` | Finished normally | return text |
| `tool_use` | Wants client tool(s) | return `toolCalls` |
| `max_tokens` | Hit `max_tokens`; a `tool_use` input may be truncated | never execute tools from this turn; retry with higher `max_tokens` or surface error |
| `stop_sequence` | Custom stop sequence hit | treat as end |
| `pause_turn` | Server-side tool paused (only with Anthropic server tools / MCP connector) | re-send with assistant turn appended; not expected in this app |
| `refusal` | Safety classifier declined (HTTP 200). `stop_details` = `{type, category, explanation}` only in this case | show "model declined", do not run tools |
| `model_context_window_exceeded` | **UNVERIFIED** for current models (seen in older docs) | treat as error |

Optional (Opus 5 / Fable only): server-side refusal fallback - `client.beta.messages.create({ ..., betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })`. Anthropic's guidance recommends it for Opus 5. For this app (benign personal chat triage) refusals should be rare; adopting it forces the `client.beta.messages` namespace and Beta* types. **UNVERIFIED** that the 0.127.0 TypeScript types accept the scalar `"default"` form (the documented TS example uses the array form `fallbacks: [{ model: "claude-opus-4-8" }]` with beta `server-side-fallback-2026-06-01`; mixing header and form returns 400).

---

## 5. MCP tools -> Claude tools

### 5.1 Manual mapping (recommended for this app)

`Client.listTools()` from `@modelcontextprotocol/sdk` returns `{ tools: [{ name, title?, description?, inputSchema, outputSchema?, annotations? }] }`. `inputSchema` is already JSON Schema with `type: "object"`, which is exactly what Claude's `input_schema` wants:

```ts
import type Anthropic from "@anthropic-ai/sdk";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

export function mcpToClaudeTool(t: McpTool): Anthropic.Tool {
  return {
    name: t.name,                                   // must match ^[a-zA-Z0-9_-]{1,64}$ - sanitize/prefix if the server uses dots or slashes
    description: t.description ?? t.title ?? t.name,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  };
}
```

- Sort tools by name before sending: a deterministic `tools` array is required for prompt-cache hits (render order is `tools` -> `system` -> `messages`).
- Do **not** set `strict: true` on MCP-derived tools by default: strict mode requires `additionalProperties: false`, all-`required`, and rejects keywords such as `minimum`/`maxLength`/recursive refs that third-party MCP schemas commonly contain (400 on the whole request).
- Tool result mapping: MCP `callTool` returns `{ content: [{type:"text",text}|{type:"image",data,mimeType}|...], isError? }`. Convert text items to `{type:"text", text}`, images to `{type:"image", source:{type:"base64", media_type, data}}`, and pass `is_error: result.isError`.
- MCP `annotations.readOnlyHint` is only a *hint* from an untrusted server. The approval gate must use an app-side allowlist of read-only tool names (e.g. `list_events`, `list_calendars`, `get_event`, `search_events`, `get_freebusy`), not the annotation.

### 5.2 Official SDK helper (exists, verified)

Source: https://platform.claude.com/docs/en/agents-and-tools/mcp-connector (section "Client-side MCP helpers") and `src/helpers/beta/mcp.ts` in the SDK repo.

```ts
import {
  mcpTools, mcpTool, mcpMessages, mcpMessage, mcpContent,
  mcpResourceToContent, mcpResourceToFile, UnsupportedMCPValueError,
  type MCPClientLike, type MCPCallToolResultLike,
} from "@anthropic-ai/sdk/helpers/beta/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mcpClient = new Client({ name: "whatsapp-calendar-agent", version: "1.0.0" });
await mcpClient.connect(new StdioClientTransport({ command: "...", args: [] }));
const { tools } = await mcpClient.listTools();

// Docs note: the MCP SDK's callTool return type includes a legacy shape mcpTools() does not accept; narrow it.
const forTools: MCPClientLike = {
  callTool: (p) => mcpClient.callTool(p) as Promise<MCPCallToolResultLike>,
};

const finalMessage = await anthropic.beta.messages.toolRunner({
  model: "claude-opus-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "..." }],
  tools: mcpTools(tools, forTools),   // BetaRunnableTool[] - each has a run() that calls mcpClient.callTool
});
```

Signature: `mcpTools(tools: MCPToolLike[], mcpClient: MCPClientLike, extraProps?: Partial<Omit<BetaTool,'name'|'description'|'input_schema'>>): BetaRunnableTool[]`.

Why NOT to use it as the main path here: `toolRunner` **executes every tool call automatically**. With a calendar MCP server that exposes `create_event` / `update_event` / `delete_event`, that violates the locked APPROVAL-FIRST rule. If it is used at all, pass only the read-only subset: `mcpTools(tools.filter(t => READ_ONLY.has(t.name)), forTools)`. Write tools would then be invisible to the model, which is also wrong (the model must be able to *propose* an event). Hence: manual loop, all tools visible, app-side gate on execution.

### 5.3 Server-side "MCP connector" (not applicable)

`mcp_servers: [{type:"url", url:"https://...", name, authorization_token}]` + `tools: [{type:"mcp_toolset", mcp_server_name}]` with beta `mcp-client-2025-11-20` lets Anthropic's servers call the MCP server. It requires a **publicly reachable HTTPS** MCP server (no stdio, no localhost), Anthropic executes tools with no client-side approval hook, and it is Claude-only (Local and Gemini providers could not share it). Rejected for this app.

---

## 6. Structured JSON output

Three options, in order of preference for the triage classifier:

1. **`output_config.format` (GA, constrained decoding)** - supported on Opus 5, Sonnet 5, Haiku 4.5.
   ```ts
   import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
   // or: import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

   const res = await client.messages.parse({
     model, max_tokens: 1024,
     system, messages,
     output_config: { format: jsonSchemaOutputFormat(TRIAGE_SCHEMA as const) },
   });
   res.parsed_output; // typed; null if parsing failed (refusal / max_tokens)
   ```
   Raw shape: `output_config: { format: { type: "json_schema", schema: {...} } }`. The old top-level `output_format` is deprecated.
   Schema limits: every object needs `additionalProperties: false`; no recursive schemas, no `minimum`/`maximum`/`multipleOf`, no `minLength`/`maxLength`, `minItems` only 0 or 1, no external `$ref`. `enum`, `const`, `anyOf`, `allOf`, internal `$ref`/`$defs`, string `format` (`date-time`, `date`, `time`, `email`, `uri`, `uuid`...) are supported.
   Works **together with tools** in the same request (final text turn obeys the schema; tool calls still happen). Incompatible with citations and prefill. First request with a new schema pays a grammar-compile latency; compiled grammars are cached 24h. Changing the schema invalidates the prompt cache. On `refusal` or `max_tokens` the output may not match the schema - always check `stop_reason` first.
2. **Strict tool use** - `strict: true` on an app-defined tool (e.g. `report_triage`) guarantees `tool_use.input` validates. Good fit for the provider-neutral design because Gemini and llama.cpp also do function calling; but do not force it with `tool_choice: {type:"tool"}` if Fable must be supported.
3. **Prompt-only JSON** + `JSON.parse` + Zod validation - the lowest common denominator; needed anyway for the local model path.

Recommended triage schema shape (all fields required, nullable via `anyOf` with `null`): `{ category: "needs_reply" | "schedule_candidate" | "info_missing" | "ignore", language: "he" | "en", proposed_event: { title, start_iso, end_iso, timezone, location } | null, missing_fields: string[], draft_reply: string | null, confidence: "low"|"medium"|"high" }`.

---

## 7. Streaming

```ts
const stream = client.messages.stream({ model, max_tokens: 64000, system, tools, messages }, { signal });
stream.on("text", (delta) => onTextDelta(delta));     // just the text delta string
const message = await stream.finalMessage();          // full Anthropic.Message; rejects on error/abort
```

- SSE events: `message_start`, `content_block_start`, `content_block_delta` (`text_delta`, `input_json_delta`, `thinking_delta`), `content_block_stop`, `message_delta` (carries `stop_reason` + usage), `message_stop`.
- Do not wrap `.on()` handlers in a `new Promise` - `finalMessage()` handles completion/error/abort.
- Non-streaming `create()` is fine for triage (small outputs, keep `max_tokens` <= ~16000). Use streaming only for the draft-reply UI if a typing effect is wanted, or when `max_tokens` is large (SDK requires streaming for very large values).
- `eager_input_streaming: true` on tools is only useful when tool inputs are large (file contents). Calendar tool inputs are tiny -> **leave it off**; with it on, the API stops validating tool input JSON and the client must validate it.
- On Opus 5 / Sonnet 5 thinking `display` defaults to `"omitted"`: streamed `thinking` blocks have empty text, which looks like a pause before the first text token. Fine for this app (no reasoning is shown).

---

## 8. Prompt caching (long stable system prompt)

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-caching, pricing page.

- Prefix match over `tools` -> `system` -> `messages`. Any byte change invalidates everything after it.
- Easiest: top-level `cache_control: { type: "ephemeral" }` on the request (auto-caches up to the last cacheable block). Explicit: put `cache_control` on the last `system` text block (covers tools + system). Max 4 breakpoints. TTL 5 min (default, write 1.25x) or `ttl: "1h"` (write 2x). Reads 0.1x base input.
- **Minimum cacheable prefix is model-dependent**: Opus 5 **512** tokens, Sonnet 5 **1024**, Haiku 4.5 **4096**. Below the minimum nothing is cached and there is no error (`cache_creation_input_tokens: 0`). A ~1.2k-token system prompt + calendar tools caches on Opus 5 and Sonnet 5 but **not on Haiku 4.5**.
- Keep volatile data OUT of the system prompt: current date/time, the user's timezone "now", chat name, message ids. Put them in the user message (after the breakpoint). `new Date()` in the system prompt is the classic silent invalidator. Also keep the tool list sorted and identical on every call.
- Realistic benefit for this app: personal chats produce sparse traffic, so the 5-minute cache is usually cold between messages (each cold call pays 1.25x on the prefix). Caching reliably pays off **inside one tool loop** (2-4 requests within seconds: every request after the first reads the prefix at 0.1x) and during bursts/backlog processing on startup. `ttl: "1h"` breaks even after two reads per hour; only worth it for users with steady traffic. Recommendation: enable 5m caching (cheap, no downside beyond +25% on cold prefix), do not bother with 1h.
- Cached reads do not count toward the ITPM rate limit.
- Verify with `usage.cache_read_input_tokens` > 0 on the 2nd request of a loop.

---

## 9. Errors, rate limits, retries

Typed errors (all extend `Anthropic.APIError`, which has `.status`, `.type`, `.message`, `.requestID`; `APIConnectionError` is a subclass of `APIError` in TS, so test it first):

| HTTP | `error.type` | TS class | Retry? | UI message |
|---|---|---|---|---|
| 400 | `invalid_request_error` | `BadRequestError` | no | bug / bad schema (also "reached your specified API usage limits" = user-set spend limit) |
| 401 | `authentication_error` | `AuthenticationError` | no | "API key invalid or revoked" |
| 402 | `billing_error` | (APIError, status 402) | no | "Add credits in the Claude Console" |
| 403 | `permission_error` | `PermissionDeniedError` | no | key/workspace not allowed |
| 404 | `not_found_error` | `NotFoundError` | no | model id unknown or not available to this org |
| 413 | `request_too_large` | (APIError) | no | trim history |
| 429 | `rate_limit_error` | `RateLimitError` | yes, honour `retry-after` | "Rate limited, retrying" |
| 500 | `api_error` | `InternalServerError` | yes | transient |
| 529 | `overloaded_error` | `InternalServerError` (status 529) | yes, longer backoff | "Claude is busy" |
| network | - | `APIConnectionError` / `APIConnectionTimeoutError` | yes | offline |
| abort | - | `APIUserAbortError` | no | silent |

- The SDK already retries 408/409/429/>=500 and connection errors `maxRetries` times (default 2) with exponential backoff and respects `retry-after`. App-level: on a final `RateLimitError` read `err.headers?.get("retry-after")` (seconds) and re-queue the message for later rather than dropping it.
- **Monthly spend-cap 429**: `error.type === "rate_limit_error"` with `error.details.error_code === "enforced_spend_limit_reached"` and **no `retry-after` header** - retrying is pointless until next month. Detect it and show a persistent banner.
- Rate-limit headers on every response: `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}`, `retry-after`. Read via `const { data, response } = await client.messages.create(...).withResponse()`.
- Lowest standard tier ("Start"): 1,000 RPM, 2,000,000 ITPM, 400,000 OTPM for Opus 5 / Sonnet 5 / Haiku 4.5. Brand-new orgs may start in an "Evaluation" tier with lower, undocumented limits. A personal assistant will not approach these; still, serialize LLM calls through a small queue (concurrency 1-2).
- Log `err.requestID` (never the key) for support.

```ts
try { ... } catch (e) {
  if (e instanceof Anthropic.APIUserAbortError) return;                 // cancelled
  if (e instanceof Anthropic.AuthenticationError) throw new ProviderError("auth", e);
  if (e instanceof Anthropic.PermissionDeniedError) throw new ProviderError("permission", e);
  if (e instanceof Anthropic.NotFoundError) throw new ProviderError("model_unavailable", e);
  if (e instanceof Anthropic.RateLimitError) throw new ProviderError("rate_limited", e);
  if (e instanceof Anthropic.APIConnectionError) throw new ProviderError("network", e);
  if (e instanceof Anthropic.APIError && e.status === 402) throw new ProviderError("billing", e);
  if (e instanceof Anthropic.InternalServerError) throw new ProviderError("server", e);
  if (e instanceof Anthropic.APIError) throw new ProviderError("bad_request", e);
  throw e;
}
```

---

## 10. End-user API key validation

Keys look like `sk-ant-api03-...` (format check is a hint only - do not reject on it; **UNVERIFIED** that the prefix is stable). Admin keys `sk-ant-admin...` are the wrong kind of key for inference.

Recommended two-step check when the user presses "Save / Test":

1. **Free**: `await client.models.retrieve(selectedModelId)` (GET `/v1/models/{id}`).
   - 200 -> key valid and model available; show `display_name`.
   - `AuthenticationError` (401) -> invalid key. `NotFoundError` (404) -> key fine, model not available to that org -> fall back to `client.models.list()` and let the user pick.
   - Use `{ maxRetries: 0, timeout: 10_000 }` for a snappy settings dialog.
2. **Optional, costs ~$0.00001**: a real inference probe, because step 1 does not prove the org has credits:
   ```ts
   await client.messages.create({ model: "claude-haiku-4-5", max_tokens: 1,
     messages: [{ role: "user", content: "ping" }] }, { maxRetries: 0, timeout: 15_000 });
   ```
   402 `billing_error` / 400 "credit balance is too low" (**UNVERIFIED** which of the two a zero-balance org gets today) -> tell the user to add credits at https://platform.claude.com/settings/billing.

`client.messages.countTokens(...)` is another free authenticated call but adds nothing over `models.retrieve`.

Storage: encrypt with Electron `safeStorage.encryptString()` (DPAPI on Windows) and keep in userData; never send the key to the renderer, never log it, redact it in error dumps.

---

## 11. Cost estimate: one ~1.5k-token triage call

Assumption: 1,500 input tokens total (system prompt ~800, 4-6 calendar tool definitions ~350, tool-use overhead ~300-500, message + short chat context ~150-350), output ~200 tokens of JSON/draft. Thinking tokens are billed as output: on Opus 5 / Sonnet 5 with `effort: "low"` expect 0-300 extra, hence the ranges.

| Model | Input cost | Output cost (200 -> 500 tok) | **Per call** | 100 msgs/day, 30 days |
|---|---|---|---|---|
| `claude-haiku-4-5` | 1,500 x $1/M = $0.0015 | $0.0010 | **~$0.0025** | ~$7.50 |
| `claude-sonnet-5` | 1,500 x $2/M = $0.0030 | $0.0020 -> $0.0050 | **~$0.005 - $0.008** | ~$15 - $24 |
| `claude-opus-5` | 1,500 x $5/M = $0.0075 | $0.0050 -> $0.0125 | **~$0.0125 - $0.02** | ~$37 - $60 |

Modifiers
- A message that triggers a calendar lookup costs 2-3 requests (each re-sends the prefix). With 5m caching, requests 2+ read ~1,200 prefix tokens at 0.1x: on Opus 5 that turns a $0.0075 input into ~$0.0021.
- Newer-tokenizer models (Opus 5 / Sonnet 5) count ~30% more tokens than Haiku 4.5 for identical text, and Hebrew is denser in tokens than English - budget +30-60% on Hebrew-heavy chats (**UNVERIFIED**, measure with `countTokens`).
- Biggest lever is not the model but **not calling the LLM**: skip groups/status, skip own outgoing messages, debounce bursts from one chat into a single call (e.g. 20-30 s quiet window), and optionally run a cheap pre-filter (Haiku or local model) and escalate only schedule-like messages to the capable model.
- Batch API (-50%) is not useful (asynchronous, up to 24h).

---

## 12. Minimal provider shape (TypeScript)

Design constraints baked in:
- Provider-neutral interface shared with Local and Gemini providers.
- The provider performs **one model turn** per `chat()` call and returns `toolCalls`; it never executes tools. The orchestrator owns the loop and the approval gate (auto-run allowlisted read-only MCP tools; turn write-tool calls into "pending approval" cards; answer un-approved calls with an `is_error` tool result or end the loop).
- Assistant turns must be replayed to Claude **verbatim** (thinking blocks + signatures, tool_use ids). So the neutral message type carries an opaque `providerData` that the Claude provider fills with `response.content` and re-uses on the next call.

```ts
// src/main/llm/types.ts  (provider-neutral)
export interface LlmTool { name: string; description: string; inputSchema: Record<string, unknown>; }
export interface LlmToolCall { id: string; name: string; input: Record<string, unknown>; }
export interface LlmToolResult { toolCallId: string; content: string; isError?: boolean; }

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: LlmToolCall[]; providerData?: unknown }
  | { role: "tool"; results: LlmToolResult[] };

export interface LlmResponse {
  text: string;
  toolCalls: LlmToolCall[];
  stopReason: "end" | "tool_use" | "max_tokens" | "refusal" | "other";
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  assistantMessage: Extract<LlmMessage, { role: "assistant" }>;   // push this into history as-is
}

export interface LlmProvider {
  readonly id: "local" | "claude" | "gemini";
  chat(messages: LlmMessage[], tools: LlmTool[], signal?: AbortSignal): Promise<LlmResponse>;
  validate(signal?: AbortSignal): Promise<{ ok: true; model: string } | { ok: false; reason: string }>;
}
```

```ts
// src/main/llm/claudeProvider.ts
import Anthropic from "@anthropic-ai/sdk";
import type { LlmMessage, LlmProvider, LlmResponse, LlmTool, LlmToolCall } from "./types";

const SUPPORTS_EFFORT = (m: string) => !m.startsWith("claude-haiku-4-5");

export class ClaudeProvider implements LlmProvider {
  readonly id = "claude" as const;
  private client: Anthropic;

  constructor(apiKey: string, private model = "claude-opus-5") {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
  }

  async chat(messages: LlmMessage[], tools: LlmTool[], signal?: AbortSignal): Promise<LlmResponse> {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");

    const claudeTools: Anthropic.Tool[] = [...tools]
      .sort((a, b) => a.name.localeCompare(b.name))            // deterministic order => cache hits
      .map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      }));

    const res = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 4096,
        system: system
          ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]   // caches tools + system
          : undefined,
        tools: claudeTools.length ? claudeTools : undefined,
        ...(SUPPORTS_EFFORT(this.model) ? { output_config: { effort: "low" as const } } : {}),
        messages: toClaudeMessages(messages),
      },
      { signal },
    );

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const runnable = res.stop_reason === "tool_use";            // never run tools from max_tokens / refusal turns
    const toolCalls: LlmToolCall[] = runnable
      ? res.content
          .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }))
      : [];

    return {
      text,
      toolCalls,
      stopReason:
        res.stop_reason === "end_turn" || res.stop_reason === "stop_sequence" ? "end"
        : res.stop_reason === "tool_use" ? "tool_use"
        : res.stop_reason === "max_tokens" ? "max_tokens"
        : res.stop_reason === "refusal" ? "refusal"
        : "other",
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      },
      assistantMessage: { role: "assistant", content: text, toolCalls, providerData: res.content },
    };
  }

  async validate(signal?: AbortSignal) {
    try {
      const m = await this.client.models.retrieve(this.model, { signal, maxRetries: 0, timeout: 10_000 });
      return { ok: true as const, model: m.display_name };
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) return { ok: false as const, reason: "invalid_key" };
      if (e instanceof Anthropic.PermissionDeniedError) return { ok: false as const, reason: "permission" };
      if (e instanceof Anthropic.NotFoundError) return { ok: false as const, reason: "model_unavailable" };
      if (e instanceof Anthropic.APIConnectionError) return { ok: false as const, reason: "network" };
      throw e;
    }
  }
}

function toClaudeMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      // Replay Claude's own blocks verbatim (thinking signatures, tool_use ids). If the turn came from
      // another provider (user switched provider mid-thread), rebuild from neutral fields.
      const raw = m.providerData as Anthropic.ContentBlockParam[] | undefined;
      out.push({
        role: "assistant",
        content: Array.isArray(raw) ? raw : [
          ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
          ...(m.toolCalls ?? []).map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input })),
        ],
      });
    } else {
      out.push({
        role: "user",
        content: m.results.map((r) => ({
          type: "tool_result" as const, tool_use_id: r.toolCallId, content: r.content, is_error: r.isError,
        })),
      });
    }
  }
  return out;
}
```

Orchestrator sketch (shared by all three providers; this is where approval-first lives):

```ts
const READ_ONLY = new Set(["list_calendars", "list_events", "get_event", "search_events", "get_freebusy"]); // match the chosen MCP server's names
for (let i = 0; i < 6; i++) {                                  // hard iteration cap
  const r = await provider.chat(history, tools, signal);
  history.push(r.assistantMessage);
  if (r.stopReason !== "tool_use") break;
  const results = await Promise.all(r.toolCalls.map(async (c) => {
    if (!READ_ONLY.has(c.name)) {
      proposals.push(c);                                        // -> "pending approval" card in the UI
      return { toolCallId: c.id, isError: true,
        content: "Not executed: write actions require explicit user approval in the app. Summarize the proposal instead." };
    }
    const out = await mcpClient.callTool({ name: c.name, arguments: c.input });
    return { toolCallId: c.id, content: flattenMcpContent(out), isError: !!out.isError };
  }));
  history.push({ role: "tool", results });                      // ALL results in ONE message
}
```

When the user later clicks "Add to calendar", the app calls `mcpClient.callTool({ name: proposal.name, arguments: proposal.input })` directly - the MCP server still does the Google call, the LLM is not involved in the write, and nothing is sent without the click.

Prompt-injection note: WhatsApp message text is untrusted input. Wrap it in a clearly delimited block inside the *user* message, state in the system prompt that message content is data and never instructions, and rely on the execution gate above (not on the prompt) for safety.

---

## 13. Electron-specific notes

- Run the SDK in the main process (or a utility process). Renderer talks over IPC. The SDK refuses to run in a browser-like context unless `dangerouslyAllowBrowser: true` - do not set it.
- Node 24 has global `fetch`/`AbortController`; no polyfills needed. Electron's bundled Node version (not the system Node 24.19) is what actually runs - SDK needs Node 20+ (**UNVERIFIED** exact minimum for 0.127.0; current Electron majors ship Node 22+).
- Bundling: the SDK is dual ESM/CJS with an `exports` map; works with electron-vite/esbuild without special config. Keep `@anthropic-ai/sdk` external in the main-process bundle if tree-shaking causes issues with `helpers/*` subpath imports.
- Corporate proxies: pass `fetchOptions`/custom `fetch` if proxy support is needed (**UNVERIFIED** option name in 0.127.0 - check the SDK README "Configuring proxies").

---

## 14. Sources

- npm registry (`npm view`, 2026-09-21): `@anthropic-ai/sdk` 0.127.0, `@modelcontextprotocol/sdk` 1.30.0, `zod` 4.6.5
- Models overview: https://platform.claude.com/docs/en/about-claude/models/overview
- Model deprecations: https://platform.claude.com/docs/en/about-claude/model-deprecations
- Pricing (models, caching multipliers, tool-use overhead tokens): https://platform.claude.com/docs/en/about-claude/pricing
- Rate limits + headers + spend-cap 429: https://platform.claude.com/docs/en/api/rate-limits
- Errors: https://platform.claude.com/docs/en/api/errors
- Tool use: https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
- MCP connector + client-side MCP helpers: https://platform.claude.com/docs/en/agents-and-tools/mcp-connector
- SDK MCP helper source: https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/helpers/beta/mcp.ts
- SDK helpers doc (tool runner, structured output helpers): https://github.com/anthropics/anthropic-sdk-typescript/blob/main/helpers.md
- Structured outputs: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Streaming: https://platform.claude.com/docs/en/build-with-claude/streaming
- Bundled `claude-api` skill (TypeScript README, tool-use, streaming, error-codes, prompt-caching, model-migration; cache date 2026-06-24)

## 15. UNVERIFIED items (collected)

1. Exact zero-credit error (402 `billing_error` vs 400 "credit balance is too low") for a new key with no balance.
2. Whether TS SDK 0.127.0 types accept `fallbacks: "default"` (scalar form) on `client.beta.messages.create`.
3. Hebrew token inflation factor on the old (Haiku 4.5) and new (Opus 5 / Sonnet 5) tokenizers.
4. `model_context_window_exceeded` stop reason on current models.
5. Minimum Node version required by SDK 0.127.0; proxy option name.
6. Whether `client.messages.toolRunner` (non-beta) exists in 0.127.0 - `helpers.md` on `main` mentions it, the platform docs still show `client.beta.messages.toolRunner`. Irrelevant if the manual loop is used.
7. `sk-ant-api03-` key prefix stability.
8. Tool names the chosen Google Calendar MCP server actually exposes (the read-only allowlist in section 12 is illustrative - owned by the calendar-MCP research task).
