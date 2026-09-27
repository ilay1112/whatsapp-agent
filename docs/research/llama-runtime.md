# Research: embedding llama.cpp in the Electron app ("llama-runtime")

Date of research: 2026-09-21. Target: Windows 11 x64, Electron + TypeScript, electron-builder (NSIS).
All versions below were read live from npm / the GitHub API on that date. Items I could not confirm are marked **UNVERIFIED**.

---

## 0. TL;DR / decision

**Recommendation: Option 2 - ship the official `llama-server.exe` (Windows Vulkan x64 build) as a managed child process and talk OpenAI-compatible HTTP to it on `127.0.0.1`.**

- Pin llama.cpp nightly build **`b10964`** (the build that the stable tag **`v0.4.1`**, 2026-09-14, points at).
  Asset: `llama-b10964-bin-win-vulkan-x64.zip`, 31,674,542 bytes,
  sha256 `1ee3ad952f4ba71f438bd6d7bebef19e1c7af04adcaa35d08b4ddabb27d4c642`
  URL: <https://github.com/ggml-org/llama.cpp/releases/download/b10964/llama-b10964-bin-win-vulkan-x64.zip>
- Keep `node-llama-cpp@3.21.1` as the documented fallback (section 3), not as the primary runtime.
- Write our own ~150-line GGUF downloader (HTTP Range resume + streaming sha256 against Hugging Face `X-Linked-ETag`) - neither option gives sha256 verification out of the box.

Why (scored against the criteria in the task):

| Criterion | node-llama-cpp 3.21.1 | llama-server.exe (Vulkan zip) | Winner |
|---|---|---|---|
| electron-builder packaging | Native `.node` addon + ~20 DLLs; must be externalised from the bundler, ESM-only, needs `asarUnpack` + `files` filters, all `@node-llama-cpp/win-x64*` optional deps are installed (incl. 175 MB CUDA + 368 MB CUDA-ext) and must be filtered out by hand; ABI tied to the Electron/Node version | A folder of plain files in `extraResources`. No ABI coupling to Electron, no bundler rules, no asar rules. Same supervisor pattern the app already needs for `whatsapp-bridge.exe` | llama-server |
| New model chat templates + tool calls | Own TypeScript chat-wrapper layer (`QwenChatWrapper`, `Gemma4ChatWrapper`, ...) + a partial Jinja fallback; docs say the Jinja wrapper "can underperform" for function calling. Observed lag: Gemma 4 was released 2026-04-02, node-llama-cpp support shipped in 3.19.0 on 2026-06-30 (no release at all between 3.18.1 on 03-17 and 3.19.0) | Upstream Jinja engine (`--jinja` is now **default: enabled**), upstream native tool-call parsers per model family + generic fallback, `--chat-template-file` override. New models work the day llama.cpp supports them; we update by swapping a zip | llama-server |
| Hebrew tokenisation | Same llama.cpp tokenizer (model-defined). | Same. | tie (model choice matters, not runtime) |
| Laptop iGPU via Vulkan | Prebuilt `@node-llama-cpp/win-x64-vulkan`; `gpu:"auto"` tries CUDA -> Vulkan -> CPU. A bad Vulkan driver can segfault the hosting process (open issue #554) - must live in a `utilityProcess` | Same ggml Vulkan backend, but always out-of-process; a driver crash / device-lost just kills the child and we restart with `--device none`. `--fit on` (default) auto-sizes layers/context to free VRAM | llama-server (isolation is free) |
| Installer size | `win-x64` 48.6 MB + `win-x64-vulkan` 103.4 MB unpacked (+ 39 MB main package, of which ~34 MB is a useless `llama/gitRelease.bundle`) => roughly +150-190 MB unpacked after filtering; ~695 MB if you forget to filter CUDA | 30.4 MB zip download; after deleting the CLI tools we do not need, roughly 85-95 MB unpacked (**UNVERIFIED** - dominated by `ggml-vulkan.dll` ~52 MB), ~25-30 MB inside the NSIS 7z | llama-server |
| UI never blocks | Must be moved to `utilityProcess` manually (docs only say "main process only, never renderer") | Separate OS process by construction | llama-server |
| HW introspection API | Excellent: `getVramState()`, `getGpuDeviceNames()`, `getRamState()`, memory estimation | Only `llama-server --list-devices` (text) + Node `os.totalmem()`; but `--fit` makes precise estimation mostly unnecessary | node-llama-cpp |
| Model downloader | Built in (`createModelDownloader`, `hf:` URIs, progress, ETA, AbortSignal). No sha256 check | Has `-hf` auto-download, but no progress events for our UI -> we write our own | node-llama-cpp (but we need our own anyway for sha256) |
| Approval-first tool calling | `LlamaChatSession` auto-executes handlers; need the low-level `LlamaChat.generateResponse()` loop to intercept calls | Standard OpenAI `tool_calls` - the app's agent loop decides what to execute. Identical shape to the Claude/Gemini providers' loops | llama-server |

"llama.cpp EMBEDDED in the app, no Ollama" is satisfied by both: in option 2 the binaries live inside the installer under `resources/`, are started/stopped by the app, listen on loopback only with a random port + random API key, and the user never installs or sees anything separate.

---

## 1. Verified version facts (2026-09-21)

| Thing | Value | Source |
|---|---|---|
| `node-llama-cpp` latest | **3.21.1** (2026-09-12), engines `node >=20.0.0`, ESM only, ships llama.cpp `v0.4.0` | `npm view node-llama-cpp`, <https://github.com/withcatai/node-llama-cpp/releases/tag/v3.21.1> |
| Prebuilt binary packages (optionalDependencies) | `@node-llama-cpp/win-x64` (48.6 MB unpacked), `@node-llama-cpp/win-x64-vulkan` (103.4 MB), `@node-llama-cpp/win-x64-cuda` (175.5 MB), `@node-llama-cpp/win-x64-cuda-ext` (367.8 MB), all `3.21.1` | `npm view <pkg> dist.unpackedSize` |
| `node-llama-cpp` main package | 39.1 MB unpacked, 929 files; contains `llama/gitRelease.bundle` (~34 MB llama.cpp source bundle, useless in a packaged app) | npm; <https://github.com/stuffbucket/monimal/pull/50> |
| `ipull` (downloader used by node-llama-cpp) | dependency `^3.9.5`; latest on npm 4.0.3 | npm |
| llama.cpp stable tag | **v0.4.1** (2026-09-14). The stable release has **no binary assets** (only `nightly-tag.txt`); its notes point to nightly **b10964** for binaries | <https://github.com/ggml-org/llama.cpp/releases/tag/v0.4.1> |
| llama.cpp newest nightly | b11070 (2026-09-21); nightlies are published several times a day, flagged prerelease | GitHub API |
| Windows assets per nightly | `llama-<tag>-bin-win-cpu-x64.zip` 17.6 MB, `...-win-vulkan-x64.zip` 30.4 MB, `...-win-cuda-12.4-x64.zip` 242 MB, `...-win-cuda-13.4-x64.zip` 143 MB (+ `cudart-llama-bin-win-cuda-13.4-x64.zip` 404 MB), `...-win-sycl-x64.zip` 114 MB, `...-win-openvino-2026.4-x64.zip` 84 MB, `...-win-rocm-10.0-x64.zip` 244 MB. Every asset has a `sha256:` digest in the GitHub API | GitHub API `releases?per_page=3` |
| `electron` latest | 44.4.3 | npm |
| `electron-builder` latest | 26.15.3 | npm |
| node-llama-cpp's own Electron template pins | `electron ^40.4.1`, `electron-builder ^26.7.0`, `vite-plugin-electron ^0.29.0` | <https://github.com/withcatai/node-llama-cpp/tree/master/templates/electron-typescript-react> |

Build facts for the official Windows zips (from `.github/workflows/release.yml` on master):

- CPU build flags: `-DGGML_NATIVE=OFF -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON -DGGML_OPENMP=ON -DLLAMA_BUILD_BORINGSSL=ON`, LLVM/clang toolchain (`cmake/x64-windows-llvm.cmake`).
- The Vulkan zip is "CPU zip + `ggml-vulkan.dll`" (the workflow builds only the `ggml-vulkan` target with `-DGGML_CPU=OFF` and a "Merge artifacts" step injects the CPU zip). So **one Vulkan zip covers CPU-only machines as well** - there is no need to ship both.
- `GGML_CPU_ALL_VARIANTS` means the CPU backend is a set of DLLs selected at runtime by CPUID. node-llama-cpp 3.21.1's `win-x64` package shows the same set: `ggml-cpu-x64.dll`, `-sse42`, `-sandybridge`, `-ivybridge`, `-piledriver`, `-haswell`, `-skylakex`, `-cannonlake`, `-cascadelake`, `-cooperlake`, `-icelake`, `-alderlake`, `-zen4`, `-sapphirerapids` (verified via unpkg `?meta`). **Neither option requires AVX2**; old CPUs fall back to the `x64`/`sse42` variant (slow, but no illegal-instruction crash).
- Exact file list inside the official Vulkan zip: **UNVERIFIED** (I did not download it). Expected: `llama-server.exe`, `llama.dll`, `llama-common.dll`, `ggml.dll`, `ggml-base.dll`, `ggml-cpu-*.dll`, `ggml-vulkan.dll`, `ggml-rpc.dll`, `mtmd.dll`, an OpenMP runtime DLL, plus many `llama-*.exe` CLI tools we can delete. The build-time task must unzip and list it, then write an allow-list.

---

## 2. Option 2 in detail (RECOMMENDED): `llama-server.exe` child process

### 2.1 Relevant server facts (from `tools/server/README.md`, master)

- `--jinja, --no-jinja` - "whether to use jinja template engine for chat (**default: enabled**)". Tool calling (`tools` in `/v1/chat/completions`) requires it; it is on by default now, pass `--jinja` explicitly anyway for clarity.
- `--chat-template-file FILE` - override a broken/absent tool-use template; worst case `--chat-template chatml` (generic tool-call fallback). Docs: <https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md>
  - Native tool-call formats listed there: Llama 3.1/3.3, Functionary v3.1/v3.2, Hermes 2/3, Qwen 2.5, Mistral Nemo, Firefunction v2, Command R7B, DeepSeek R1; everything else -> "Generic" format (more tokens, still grammar-constrained). Newer families (Qwen3.x, Gemma 4, gpt-oss...) have dedicated parsers in `common/parsers` per the v0.4.1 notes ("Split specialized chat parsers into `common/parsers`") - exact list **UNVERIFIED**.
  - "`parallel_tool_calls`: true" must be set per request to allow several calls in one turn (default off).
  - Caveat quoted from the doc: "Beware of extreme KV quantizations (e.g. `-ctk q4_0`), they can substantially degrade the model's tool calling performance." -> do not quantise the KV cache below `q8_0`.
- `-ngl, --n-gpu-layers N` - "exact number, 'auto', or 'all' (**default: auto**)"; `-fit, --fit [on|off]` - "adjust unset arguments to fit in device memory (**default: on**)", `--fit-target` margin default 1024 MiB, `--fit-ctx` minimum ctx default 4096. This is what makes iGPU/shared-memory laptops workable without our own VRAM estimator.
- `-dev, --device <list>` - `none` = do not offload (force CPU). `--list-devices` prints devices and exits.
- `--host` default `127.0.0.1`; `--port` default 8080; `--api-key KEY` (env `LLAMA_API_KEY`) or `--api-key-file`; `GET /health` is public (no key) and returns 503 while the model is loading, 200 when ready.
- `--no-webui` (alias `--no-ui`) disables the built-in web UI - always pass it.
- `--sleep-idle-seconds N` - unloads the model after N idle seconds and reloads on next request (PR #18228). Useful on 8-16 GB laptops: the assistant is idle 99% of the time.
- `--reasoning-format` (`none` | `deepseek` -> `message.reasoning_content`), `--reasoning-budget N` (0 = no thinking). For a small scheduling extractor use `--reasoning-budget 0` or a per-request `chat_template_kwargs: {"enable_thinking": false}` (**UNVERIFIED** for every model family; works for Qwen3-style templates).
- Structured output: `response_format: {"type":"json_schema","schema":{...}}` or `json_schema` field -> GBNF grammar sampling. Note: `tools` and `response_format` in the same request are not reliably combinable (**UNVERIFIED**); use two phases (tool loop, then a final schema-constrained "classification" call) or make "report_result" itself a tool.
- The server also exposes an Anthropic-compatible `/v1/messages` endpoint ("Tool use requires `--jinja`"). Not needed, but it means the Local provider could reuse the Claude provider's message/tool mapping if that turns out simpler.
- `--log-file FNAME`, `--log-jsonl` (new in v0.4.1) for diagnostics; `--offline` to guarantee the server itself never touches the network (we download models ourselves).

### 2.2 Spawn shape (main process or a small supervisor module)

```ts
// src/main/llm/local/llamaServer.ts   (shape, not final code)
import { spawn, ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { app } from "electron";

const binDir = app.isPackaged
  ? path.join(process.resourcesPath, "llama")              // extraResources target
  : path.join(app.getAppPath(), "vendor", "llama", "win-x64-vulkan");

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port; s.close(() => res(p));
    }).on("error", rej);
  });
}

export async function startLlamaServer(modelPath: string, opts: { forceCpu?: boolean; ctx?: number }) {
  const port = await freePort();
  const apiKey = randomBytes(24).toString("hex");
  const args = [
    "-m", modelPath,                      // array args => spaces in path are safe, NO shell
    "--host", "127.0.0.1", "--port", String(port),
    "--jinja", "--no-webui", "--offline",
    "-c", String(opts.ctx ?? 8192),
    "-np", "1",                           // one slot: personal assistant, keeps KV small
    "--sleep-idle-seconds", "600",
    "--reasoning-format", "deepseek",
    "--log-file", path.join(app.getPath("logs"), "llama-server.log"),
    ...(opts.forceCpu ? ["--device", "none"] : []),   // else: -ngl auto + --fit on (defaults)
  ];
  const child: ChildProcess = spawn(path.join(binDir, "llama-server.exe"), args, {
    cwd: binDir,                          // DLL search path = exe dir; cwd too for safety
    env: { ...process.env, LLAMA_API_KEY: apiKey },   // key via env, not argv (argv is visible in Task Manager)
    windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
  });
  // wait for readiness: poll GET /health until 200 (503 = loading), timeout ~180 s for a cold 5 GB model on HDD/iGPU
  // on 'exit' before ready with !forceCpu  -> retry once with forceCpu:true and remember it in settings
  return { child, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey };
}
```

Lifecycle rules:
- Kill on quit: `app.on("before-quit")` -> `child.kill()`; on Windows also guard against orphaning if Electron itself crashes. Simplest robust approach: a Windows Job Object is not available from Node without a native module, so instead (a) write `pid`+`port` to `userData/llama-server.json` and kill a stale PID at next start after checking its image name, and (b) keep `--sleep-idle-seconds` so an orphan at least frees RAM. **UNVERIFIED** whether llama-server has a "exit when parent dies" flag - I found none in the README.
- Never start it at app launch. Start lazily when the Local provider is selected and a message needs analysis; stop it when the user switches provider.
- Restart policy: exponential back-off, max 3 restarts per 10 min, then surface "Local model failed - switch to CPU / re-download model" in the UI.

### 2.3 Chat-with-tools + abort (approval-first)

Use plain `fetch` (Node 24 / Electron 44 have it built in). No SDK dependency is required; the `openai` npm package also works with `baseURL` but adds weight.

```ts
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export async function chatOnce(
  srv: { baseUrl: string; apiKey: string },
  messages: any[], tools: any[], signal: AbortSignal,
) {
  const r = await fetch(`${srv.baseUrl}/chat/completions`, {
    method: "POST", signal,                                   // AbortController.abort() closes the socket;
    headers: { "content-type": "application/json",            // llama-server cancels the slot on disconnect
               authorization: `Bearer ${srv.apiKey}` },
    body: JSON.stringify({
      model: "local", messages, tools,
      tool_choice: "auto", parallel_tool_calls: true,
      temperature: 0.2, max_tokens: 1024, stream: false,
      cache_prompt: true,                                     // reuse KV for the long fixed system prompt
    }),
  });
  if (!r.ok) throw new Error(`llama-server ${r.status}: ${await r.text()}`);
  const msg = (await r.json()).choices[0].message as { content: string | null; tool_calls?: ToolCall[] };
  return msg;
}

// Agent loop lives in provider-agnostic code. READ tools run automatically, WRITE tools never do:
for (let step = 0; step < 6; step++) {
  const msg = await chatOnce(srv, messages, mcpToolsAsOpenAI, ac.signal);
  messages.push({ role: "assistant", ...msg });
  if (!msg.tool_calls?.length) break;
  for (const tc of msg.tool_calls) {
    const args = JSON.parse(tc.function.arguments);
    const result = isReadOnlyTool(tc.function.name)
      ? await mcp.callTool(tc.function.name, args)                        // e.g. list-events / freebusy
      : await queueProposalForUserApproval(tc.function.name, args);       // returns {status:"pending_user_approval"}
    messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
  }
}
```

Notes:
- MCP tool -> OpenAI tool mapping is mechanical: `{type:"function", function:{name, description, parameters: tool.inputSchema}}`. llama.cpp converts `parameters` to a GBNF grammar, so **arguments are always schema-valid JSON**; strip JSON-Schema features the converter rejects (`$ref` to remote, `format` exotic values, `patternProperties`) - v0.4.1 refactored this ("`common_schema` internal representation"), supported subset **UNVERIFIED**; add a unit test that feeds every MCP tool schema to the server once at startup.
- Streaming (`stream:true`, SSE) is supported including tool-call deltas; for this app (background drafts, short outputs) non-streaming is simpler and sufficient. Hebrew in streamed chunks is safe either way: the server only emits complete UTF-8 sequences (**UNVERIFIED** by test here; it is long-standing behaviour).
- Abort: `AbortController` on the fetch. The server detects the closed connection and stops generation for that slot. For a hard stop (model wedged in a Vulkan call) kill the child.

### 2.4 electron-builder packaging (Option 2)

```jsonc
// electron-builder config (excerpt)
{
  "asar": true,
  "extraResources": [
    { "from": "vendor/llama/win-x64-vulkan", "to": "llama",  "filter": ["llama-server.exe", "*.dll", "LICENSE*"] },
    { "from": "vendor/whatsapp-bridge",      "to": "bridge", "filter": ["whatsapp-bridge.exe", "LICENSE*"] }
  ],
  "win":  { "target": [{ "target": "nsis", "arch": ["x64"] }] },
  "nsis": { "oneClick": false, "perMachine": false, "allowToChangeInstallationDirectory": false }
}
```

- `extraResources` lands in `<install>/resources/llama/`, outside `app.asar`, so there is no asar issue at all (an `.exe` cannot be executed from inside an asar).
- A dev script `scripts/fetch-llama.ps1|.mjs` downloads the pinned zip, verifies the sha256 above, unzips to `vendor/llama/win-x64-vulkan/`, deletes every `llama-*.exe` except `llama-server.exe` (keep all DLLs; `GGML_BACKEND_DL` loads backends by filename from the exe directory). `vendor/llama/` is git-ignored; the pin (tag + sha256) lives in a small JSON file that is committed.
- License: llama.cpp is MIT - ship its `LICENSE` next to the exe.
- Per-user install (`perMachine:false`) puts the app under `%LOCALAPPDATA%\Programs\<app>` - path contains the user name; spaces/non-ASCII (Hebrew user names!) are possible -> always pass paths as `spawn` array args, never via `shell:true` or string concatenation.

### 2.5 Hardware tiering without node-llama-cpp

- RAM: `os.totalmem()`.
- GPU: run `llama-server.exe --list-devices` once (takes well under a second, loads no model) and parse lines like `Vulkan0: <name> (<total> MiB, <free> MiB free)` - exact format **UNVERIFIED**, write a tolerant regex and unit-test it against captured output. Classify: no Vulkan device -> CPU tier; device name matches `Intel|Radeon(TM) Graphics|UHD|Iris|Xe` with total <= shared RAM -> iGPU (treat as CPU tier for model size, still allow offload); dedicated device with >= 6 GB -> GPU tier.
- Alternative without spawning: Electron `app.getGPUInfo("complete")` gives device/vendor IDs but not VRAM; good enough only as a secondary signal.
- Tier rule from the locked decisions: ~4B-class Q4_K_M (about 2.5-5 GB file) for 8-16 GB CPU/iGPU laptops; 8-12B class when a dGPU >= 6-8 GB VRAM or >= 32 GB RAM. (Model choice itself is another agent's research task. Verified example of size: `unsloth/gemma-4-E4B-it-GGUF` -> `gemma-4-E4B-it-Q4_K_M.gguf` = 4,977,171,584 bytes.)

---

## 3. Option 1 in detail (fallback): `node-llama-cpp@3.21.1`

Docs: <https://node-llama-cpp.withcat.ai/guide/electron>, API: <https://node-llama-cpp.withcat.ai/api/functions/getLlama>

### 3.1 Electron rules (from the official guide)

- "You can only use `node-llama-cpp` on the main process in Electron applications. Trying to use it on a renderer process will crash the application."
- The guide does **not** mention `utilityProcess`. A `utilityProcess` is a Node environment, so it should work and third-party apps run it in a worker file (e.g. `src/main/llama-worker.ts` in stuffbucket/monimal), but official support is **UNVERIFIED** - a GitHub issue search for "utilityProcess" in the repo returned zero hits. Running it directly in the main process is a bad idea: a native crash (Vulkan driver, OOM abort) takes the whole app - tray icon and WhatsApp bridge supervisor included - down with it.
- Building from source is disabled in Electron by default (`build: "never"` when packaged/asar) - prebuilt binaries only. Pass `build: "never"` explicitly.
- Do not bundle it: mark `node-llama-cpp` as external in Vite/esbuild; its on-disk layout matters. It is ESM-only (`import`, `"type":"module"`, or dynamic `import()` from CJS).
- Cross-packaging: packaging arm64 on an x64 machine is supported; other cross-platform packaging is not (irrelevant for us: Windows x64 on Windows x64).
- Scaffold for reference: `npm create node-llama-cpp@latest -- --template electron-typescript-react`.

### 3.2 electron-builder rules (copied from the official template `electron-builder.ts`)

```ts
files: [
  "dist", "dist-electron",
  "!node_modules/node-llama-cpp/bins/**/*",
  "node_modules/node-llama-cpp/bins/${os}-${arch}*/**/*",
  "!node_modules/node-llama-cpp/llama/localBuilds/**/*",
  "node_modules/node-llama-cpp/llama/localBuilds/${os}-${arch}*/**/*",
  "!node_modules/@node-llama-cpp/*/bins/**/*",
  "node_modules/@node-llama-cpp/${os}-${arch}*/bins/**/*"
],
asarUnpack: [
  "node_modules/node-llama-cpp/bins",
  "node_modules/node-llama-cpp/llama/localBuilds",
  "node_modules/@node-llama-cpp/*"
],
```

Additions we would need for installer size (not in the template):

```ts
  "!node_modules/@node-llama-cpp/win-x64-cuda/**/*",       // 175 MB
  "!node_modules/@node-llama-cpp/win-x64-cuda-ext/**/*",   // 368 MB
  "!node_modules/node-llama-cpp/llama/gitRelease.bundle",  // ~34 MB llama.cpp source bundle, unused with build:"never"
```

(The `${os}-${arch}*` glob in the template matches `win-x64`, `win-x64-vulkan`, `win-x64-cuda` and `win-x64-cuda-ext`, i.e. ~695 MB unpacked unless the CUDA ones are excluded.) Keep `llama/grammars` - it is read at runtime.

### 3.3 Minimal code shape: load + chat-with-tools + abort (inside a utilityProcess)

```ts
// src/llm-worker/index.ts  - forked with utilityProcess.fork(path, [], {serviceName:"llm"}) AFTER app 'ready'
import { getLlama, LlamaChat, defineChatSessionFunction, resolveChatWrapper,
         type ChatHistoryItem, type ChatModelFunctionCall } from "node-llama-cpp";

const llama   = await getLlama({ gpu: "auto", build: "never", logLevel: "warn" }); // auto = cuda -> vulkan -> cpu
const model   = await llama.loadModel({ modelPath });          // gpuLayers auto-fit by default
const context = await model.createContext({ contextSize: { max: 8192 } });
const chat    = new LlamaChat({ contextSequence: context.getSequence() }); // chatWrapper: "auto" -> resolveChatWrapper()

// Low-level loop (guide: https://node-llama-cpp.withcat.ai/guide/external-chat-state) -
// generateResponse() RETURNS functionCalls and does not execute them => fits approval-first.
const functions = { list_events: { description: "...", params: {/* JSON schema */} } };
let history: ChatHistoryItem[] = chat.chatWrapper.generateInitialChatHistory({ systemPrompt });
history.push({ type: "user", text }, { type: "model", response: [] });
let lastEval: any;
while (true) {
  const res = await chat.generateResponse(history, {
    functions, signal: ac.signal, stopOnAbortSignal: true, maxTokens: 1024, temperature: 0.2,
    lastEvaluationContextWindow: lastEval && { history: lastEval.contextWindow },
    contextShift: lastEval && { lastEvaluationMetadata: lastEval.contextShiftMetadata },
  });
  history = res.lastEvaluation.cleanHistory; lastEval = res.lastEvaluation;
  if (!res.functionCalls) break;
  const items: ChatModelFunctionCall[] = await Promise.all(res.functionCalls.map(async fc => ({
    type: "functionCall", name: fc.functionName, params: fc.params, rawCall: fc.raw,
    result: await runReadToolOrQueueProposal(fc.functionName, fc.params),   // via MessagePort to main
  })));
  items[0]!.startsNewChunk = true;
  (history.at(-1) as any).response.push(...items);
  (lastEval.contextWindow.at(-1) as any).response.push(...items);
}
```

(The exact field names in the loop follow the "external chat state" guide; treat the snippet as a shape and re-check against the 3.21.1 typings when implementing.)

Simpler but auto-executing variant: `new LlamaChatSession({contextSequence})` + `session.prompt(text, {functions: {x: defineChatSessionFunction({description, params, handler})}, signal, stopOnAbortSignal:true, onTextChunk})`. Parameters are grammar-constrained to the schema. **`grammar` and `functions` cannot be combined in one prompt** (documented). For approval-first, write-tool handlers would have to return a "queued for approval" string instead of executing.

Other verified API surface:
- JSON-schema grammar: `const g = await llama.createGrammarForJsonSchema(schema); const out = await session.prompt(q, {grammar: g}); g.parse(out)`.
- Introspection: `llama.gpu` (`"cuda" | "vulkan" | "metal" | false`), `llama.supportsGpuOffloading`, `await llama.getVramState()` (`total/used/free`), `await llama.getRamState()`, `await llama.getSwapState()`, `await llama.getGpuDeviceNames()`, `llama.cpuMathCores`, `llama.setVramCap()/setRamCap()` (3.19+), `model.memoryUsage` / `context.memoryUsage` (3.21+), `LlamaModelOptions.lazyMode` (3.21+). CLI: `npx --no node-llama-cpp inspect gpu`, `inspect measure <model>`.
- Defaults that matter on laptops: `vramPadding` = min(8 % VRAM, 1.2 GB); `ramPadding` = min(25 % RAM, 6 GB); `InsufficientMemoryError` is thrown instead of crashing when the estimate does not fit.
- Downloader: `createModelDownloader({modelUri, dirPath, fileName?, headers?, onProgress({totalSize, downloadedSize}), skipExisting=true, deleteTempFileOnCancel=true, parallelDownloads=4, tokens?, endpoints?})` -> `downloader.download({signal})`, `.cancel({deleteTempFile})`, getters `totalSize`, `downloadedSize`, `averageSpeed`, `estimatedTimeLeft` (3.20+), `entrypointFilePath`. URI scheme: `hf:<user>/<model>:<quant>` or `hf:<user>/<model>/<file>#<branch>`; multi-part GGUFs are resolved automatically from the first part. `skipExisting` compares **file size only**; there is **no sha256 verification**. Resume after a full process restart: ipull documents pause/resume, cross-restart resume is **UNVERIFIED**; note `deleteTempFileOnCancel` defaults to `true`, which defeats resume unless set to `false`.
- Chat wrappers present in 3.21.1 `src/chatWrappers/`: Alpaca, ChatML, DeepSeek, Falcon, Functionary, **Gemma4**, Gemma, General, Harmony (gpt-oss), Llama2, Llama3, Llama3_1, Llama3_2Lightweight, Mistral, Muse, **Qwen**, Seed, plus `generic/JinjaTemplateChatWrapper` and `TemplateChatWrapper`. 3.21.0 added a "native jinja implementation fallback". The function-calling guide warns that the Jinja wrapper can underperform and suggests `functionCallMessageTemplate: "noJinja"`.

### 3.4 Why it lost

1. **Template/tool-call lag and divergence.** node-llama-cpp re-implements chat formatting and tool-call syntax in TypeScript per model family. A brand-new model either gets the partial-Jinja fallback (tool calls unreliable) or waits for a release. Hard data point: Gemma 4 (2026-04-02) -> supported in 3.19.0 (2026-06-30), with no npm release in between. The locked decision says the model is downloaded at first run and the tier list will change over time - we want "swap the GGUF URL (and at most the llama.cpp zip)" to be the whole upgrade.
2. **Packaging surface.** Native addon + ESM-only + must-not-bundle + asarUnpack + optional-deps filtering + Electron ABI/Node-version coupling, versus "copy a folder".
3. **Crash isolation is opt-in** and the opt-in path (utilityProcess) is not documented upstream. Open issue #554 shows a segfault on the Vulkan->CPU fallback path (Linux, but same code path class); #545 shows a release (3.15.0) whose Windows prebuilt CUDA/Vulkan binaries failed to load on Win 11 until fixed.
4. **Size**: ~150 MB+ vs ~90 MB unpacked.

Where it is genuinely better (memory estimation, introspection, built-in downloader) we can compensate with `--fit on`, `--list-devices`, and a small custom downloader that we need anyway for sha256.

---

## 4. Multi-GB GGUF download: resume + sha256 (applies to both options)

Verified against Hugging Face on 2026-09-21 with `HEAD https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf` (no redirect follow):

```
302
X-Repo-Commit: bfc15c382204943c3a8fff0c750b94ae2364d7a3
X-Linked-Size: 4977171584
X-Linked-ETag: "85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87"   <- sha256 of the file (LFS oid)
X-Xet-Hash:   2c9f928b...
Accept-Ranges: bytes
Location: https://us.aws.cdn.hf.co/xet-bridge-us/...            <- signed, short-lived CDN URL
```

and `GET https://huggingface.co/api/models/<repo>/tree/main` returns per file `size` and `lfs.oid` (= the same sha256). So:

**Model manifest (committed in the app, one entry per tier):**
```jsonc
{ "id": "tier-small", "repo": "<org>/<model>-GGUF", "commit": "<40-hex X-Repo-Commit>",   // pin the revision!
  "file": "<name>-Q4_K_M.gguf", "size": 4977171584,
  "sha256": "85a896a0...fab87", "minRamGB": 8 }
```
URL form: `https://huggingface.co/<repo>/resolve/<commit>/<file>?download=true` - pinning `<commit>` instead of `main` makes size+sha256 immutable.

**Algorithm (run in the main process with streams, or in a utilityProcess; never in the renderer):**
1. Target dir: `path.join(app.getPath("userData"), "models")`. Check free disk space first (`fs.statfs`, Node >= 18.15) - need `size + 5 %`.
2. Temp file `<file>.part` + sidecar `<file>.part.json` `{url, size, sha256, etag}`. If `.part` exists and the sidecar matches the manifest, `offset = stat(.part).size`, else start at 0.
3. `fetch(url, {headers: offset ? {Range: \`bytes=${offset}-\`} : {}, redirect: "follow", signal})`. **Always re-request the `huggingface.co/.../resolve/...` URL on every (re)try** - the redirected CDN URL is signed and expires, never cache it. Expect `206` when resuming; if the server answers `200`, truncate and restart from 0. If `416`, the part is already complete -> go to step 5.
4. Pipe `response.body` to `fs.createWriteStream(part, {flags: offset ? "a" : "w"})`; count bytes; emit throttled progress (every 250 ms: `{downloaded, total, bytesPerSec, etaSec}`) over IPC to the renderer's progress bar. Retry network errors with back-off (1 s, 2 s, 5 s, 15 s, 60 s), resuming from the new offset each time. Pause = `abort()` and keep `.part`; Cancel = abort and delete.
5. Verify: stream the completed `.part` through `crypto.createHash("sha256")` (about 10-25 s for 5 GB on an NVMe laptop; show "Verifying..." in the UI). Hashing after the fact - instead of incrementally during download - keeps resume trivial because hash state cannot be serialised in Node. Compare with the manifest; on mismatch delete and offer re-download.
6. `fs.rename(part, final)` (atomic on the same volume), delete the sidecar. Optionally sanity-check the GGUF magic (`GGUF` = bytes `47 47 55 46`) before step 5 to fail fast on HTML error pages / captive portals.

Extras:
- Single connection is fine and the most proxy/AV friendly. Parallel ranged segments (what ipull does, default 3-4) speed things up on HF's CDN but multiply failure modes; not worth it for a one-time download.
- Gated/private repos would need `Authorization: Bearer hf_...`; avoid gated models for the "ready to use" requirement. Note `fetch` drops the `Authorization` header on cross-origin redirect, which is what we want for the CDN hop.
- Mirror/override: make the base URL configurable (`HF_ENDPOINT`-style) for users behind filters.
- If Option 1 were chosen anyway: `createModelDownloader({modelUri:"hf:<repo>/<file>#<commit>", dirPath, deleteTempFileOnCancel:false, onProgress})` then do step 5 ourselves.

---

## 5. Hebrew notes (runtime-relevant only)

- Tokenisation is performed by llama.cpp from the vocabulary inside the GGUF; both options share it bit-for-bit. What matters is the model's vocabulary: large-vocab multilingual models (Gemma family ~262k vocab, Qwen3.x ~150k+) encode Hebrew at roughly 2-3x fewer tokens per word than Llama-2/Mistral-era 32k vocabularies -> directly affects latency and how many chat messages fit in an 8k context on a CPU-only laptop. Exact tokens/word numbers **UNVERIFIED**; the model-selection agent should measure with `POST /tokenize` on llama-server (`{"content": "..."}` -> token ids) over a sample of real Hebrew chat lines.
- Grammar-constrained tool arguments contain Hebrew strings (event titles, names). GBNF string rules allow arbitrary Unicode, so this works; add a regression test with Hebrew + niqqud + emoji + RTL marks (U+200F) in a tool argument and round-trip it through `JSON.parse`.
- Dates: make the model output ISO-8601 with the user's IANA zone (`Asia/Jerusalem`) and resolve relative expressions ("יום חמישי ב-5") in app code given an injected "today is ..., weekday ..." line in the system prompt; small models are unreliable at calendar arithmetic regardless of runtime.

---

## 6. Windows pitfalls checklist

| Pitfall | Detail / mitigation |
|---|---|
| **AVX2 / old CPUs** | Official zips and node-llama-cpp prebuilts are both `GGML_CPU_ALL_VARIANTS` + `GGML_BACKEND_DL`: runtime CPUID dispatch from `ggml-cpu-x64/sse42/sandybridge/haswell/...dll`. No AVX2 hard requirement. Do **not** delete any `ggml-cpu-*.dll` to save space - the loader picks the best one present and a missing baseline can mean "no CPU backend". |
| **MSVC runtime** | Official Windows builds use the LLVM/clang toolchain with `GGML_OPENMP=ON` (OpenMP runtime DLL is in the zip). Whether `vcruntime140.dll`/`msvcp140.dll` from the VC++ 2015-2022 redistributable are additionally required: **UNVERIFIED**. Windows 11 usually has them, but a clean install may not. Test on a clean Windows 11 VM/Sandbox; if needed, place the app-local redistributable DLLs next to `llama-server.exe` (permitted by the VC redist license) rather than running an installer. |
| **Vulkan loader** | `ggml-vulkan.dll` links to `vulkan-1.dll`, which is installed by GPU drivers (Intel/AMD/NVIDIA), not by us. On machines without it (VMs, RDP-only, Microsoft Basic Display Adapter) the Vulkan backend DLL fails to load; with `GGML_BACKEND_DL` that should be skipped and CPU used (**UNVERIFIED** - test in Windows Sandbox). Belt and braces: if the first start exits non-zero before `/health` is ready, retry with `--device none`; if that also fails, rename/skip `ggml-vulkan.dll` via a CPU-only copy of the folder. |
| **Intel iGPU Vulkan quality** | Real issues exist: llama.cpp #28648 "Vulkan on Intel Arc 140V (Windows) outputs garbage with layers on GPU, depends on batch settings"; Ollama #18531 Iris Xe `ErrorOutOfDeviceMemory` on KV-cache alloc. iGPU Vulkan is often no faster than CPU for token generation (shared DDR bandwidth), mainly helps prompt processing. Mitigation: (1) after first model load run a 1-shot self-test (fixed prompt, temperature 0, expect a known JSON answer); on garbage/timeout flip to CPU and persist `localLlm.device = "cpu"`; (2) expose "Hardware acceleration: Auto / Off" in settings; (3) default iGPU-only machines to the small tier. |
| **Two GPUs (iGPU + dGPU laptops)** | llama.cpp enumerates both (`Vulkan0`, `Vulkan1`) and may split across them. Pick one explicitly with `--device VulkanN` chosen from `--list-devices` (prefer the discrete one; on battery the user may prefer iGPU/CPU). |
| **Antivirus / SmartScreen** | Unsigned `llama-server.exe` spawned from an unsigned Electron app that then opens a listening socket and reads a multi-GB file is a classic heuristic trigger (Defender "Behavior:Win32/..." false positives, third-party AV quarantining `resources\llama\*.exe`). Mitigations: code-sign the app **and** the bundled exes with the same certificate (electron-builder `win.signtoolOptions` / `signExts` - exact option names for 26.x **UNVERIFIED**); bind to `127.0.0.1` only (no Windows Firewall prompt - the prompt appears only for non-loopback binds); never download executables at runtime (ship them in the installer - only GGUF data is downloaded); detect "exe missing after install" and show a specific "your antivirus removed a component" message. Real-time scanning also slows first model load (mmap of 5 GB); nothing to do but show a spinner. |
| **Spaces / non-ASCII in paths** | Install dir `C:\Users\<name with space or Hebrew>\AppData\Local\Programs\...` and `userData` likewise. Use `spawn(exe, argsArray, {shell:false})` only. llama.cpp on Windows converts UTF-8 argv/paths to wide chars (long-standing), but Hebrew user-profile paths for `-m` are **UNVERIFIED** -> add an automated test with a model placed under a directory named `בדיקה test`. If it fails, fall back to the 8.3 short path or `subst`-free workaround: store models under `C:\ProgramData\<app>\models` (ASCII). The dev project path itself (`C:\dev\whatsapp agent`) has a space: quote everything in npm scripts. |
| **Long paths (MAX_PATH 260)** | Option 1 is the risky one (`...\resources\app.asar.unpacked\node_modules\@node-llama-cpp\win-x64-vulkan\bins\win-x64-vulkan\ggml-cpu-sapphirerapids.dll` is ~150 chars before the install prefix). Option 2 paths are short (`resources\llama\*.dll`). Keep GGUF file names as published but the models dir shallow. |
| **EPERM / symlinks when building** | electron-builder's winCodeSign cache extraction needs symlink rights: enable Windows Developer Mode or run the first build elevated, then delete `%LOCALAPPDATA%\electron-builder\Cache` if it was half-extracted (also listed in node-llama-cpp troubleshooting). |
| **Orphan processes** | If Electron is killed from Task Manager, children survive. Track PID in `userData`, reap on next start (verify image name before killing), use `--sleep-idle-seconds`. |
| **Port collisions / local attackers** | Random free port + random bearer key per launch, loopback only, `--no-webui`. Pass the key via `LLAMA_API_KEY` env rather than argv. |
| **RAM pressure** | 8 GB laptops: 4B Q4 (~2.5-5 GB) + Electron (~300-500 MB) + bridge is tight. `-c 8192 -np 1`, `--sleep-idle-seconds 600`, `--cache-ram 0` or a small value (default is 8192 MiB of prompt-cache RAM!) on low-RAM tiers. mmap is the default; avoid `--mlock`. |
| **Sleep / hibernate / GPU reset** | After resume from sleep Vulkan devices can be lost (`vk::DeviceLostError`) -> child exits -> supervisor restarts on next request. Treat any local-LLM failure as retryable once. |
| **Updating llama.cpp** | It is one JSON pin (tag + sha256) + re-run fetch script. Re-run the tool-calling regression suite (Hebrew + English fixtures) before bumping, because nightlies occasionally regress a template parser. |

---

## 7. Open questions for the architect / other agents

1. Exact contents and unpacked size of `llama-b10964-bin-win-vulkan-x64.zip` (needs a download, which I did not perform) -> drives the `extraResources` allow-list.
2. Does the Vulkan zip start cleanly on a machine with **no** `vulkan-1.dll`? (Windows Sandbox test.)
3. Does `llama-server -m` accept a Hebrew/Unicode path on Windows in b10964?
4. VC++ redistributable dependency of the clang-built binaries on a clean Windows 11.
5. Code-signing: will the project have a certificate? Without it expect SmartScreen + more AV friction for the bundled exes (the WhatsApp bridge has the same problem).
6. Optional later: offer a one-click "NVIDIA acceleration pack" download (CUDA 13.4 zip 143 MB + cudart 404 MB) - Vulkan on NVIDIA is already decent, so not for v1.

---

## 8. Sources

- npm registry (queried 2026-09-21): `node-llama-cpp`, `@node-llama-cpp/win-x64`, `-vulkan`, `-cuda`, `-cuda-ext`, `electron`, `electron-builder`, `ipull`; file lists via `https://unpkg.com/@node-llama-cpp/win-x64-vulkan@3.21.1/?meta`
- node-llama-cpp: <https://node-llama-cpp.withcat.ai/guide/electron> - <https://node-llama-cpp.withcat.ai/guide/function-calling> - <https://node-llama-cpp.withcat.ai/guide/external-chat-state> - <https://node-llama-cpp.withcat.ai/guide/chat-wrapper> - <https://node-llama-cpp.withcat.ai/guide/downloading-models> - <https://node-llama-cpp.withcat.ai/guide/troubleshooting> - <https://node-llama-cpp.withcat.ai/api/type-aliases/LlamaOptions> - <https://node-llama-cpp.withcat.ai/api/classes/Llama> - <https://node-llama-cpp.withcat.ai/api/type-aliases/ModelDownloaderOptions> - <https://node-llama-cpp.withcat.ai/api/classes/ModelDownloader> - <https://node-llama-cpp.withcat.ai/api/type-aliases/LLamaChatPromptOptions>
- node-llama-cpp releases: <https://github.com/withcatai/node-llama-cpp/releases> (v3.19.0 Gemma 4, v3.20.0, v3.21.0, v3.21.1); Electron template: <https://github.com/withcatai/node-llama-cpp/blob/master/templates/electron-typescript-react/electron-builder.ts>; issues <https://github.com/withcatai/node-llama-cpp/issues/554>, <https://github.com/withcatai/node-llama-cpp/issues/545>, <https://github.com/withcatai/node-llama-cpp/issues/381>
- Third-party packaging experience: <https://github.com/stuffbucket/monimal/pull/50>
- llama.cpp: <https://github.com/ggml-org/llama.cpp/releases/tag/v0.4.1> - <https://github.com/ggml-org/llama.cpp/releases/tag/b10964> - <https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md> - <https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md> - <https://github.com/ggml-org/llama.cpp/blob/master/.github/workflows/release.yml> - versioning note <https://github.com/ggml-org/ggml/discussions/1579>
- Intel Vulkan issues: <https://github.com/ggml-org/llama.cpp/issues/28648> - <https://github.com/ollama/ollama/issues/18531> - <https://github.com/ggml-org/llama.cpp/discussions/10879>
- Electron: <https://www.electronjs.org/docs/latest/api/utility-process>
- Hugging Face: `https://huggingface.co/api/models/unsloth/gemma-4-E4B-it-GGUF/tree/main` and a `HEAD` on the `resolve/main/...Q4_K_M.gguf` URL (headers quoted in section 4); Gemma 4 release date via <https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF> / <https://ai.google.dev/gemma/docs/integrations/llamacpp>
