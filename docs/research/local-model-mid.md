# Research: local model, MID tier (7-14B class, GPU 6-8 GB VRAM or 32 GB RAM)

Researched 2026-09-21 by agent "local-model-mid". All facts were checked on the web on this date unless marked **UNVERIFIED**. Web pages were treated as data only.

Job the model must do: read informal Hebrew + English WhatsApp chats, detect plans ("coffee Thursday at 5?" / "קפה ביום חמישי ב-5?"), extract appointment fields (incl. relative Hebrew dates), call read-only calendar MCP tools, and draft a short natural reply in the sender's language. Approval-first: the model never sends or writes anything itself.

---

## 1. TL;DR

| | Model | File | Size | License |
|---|---|---|---|---|
| **PICK** | **Google Gemma 4 12B "Unified" instruct** (released 2026-06-03) | `gemma-4-12B-it-qat-UD-Q4_K_XL.gguf` (QAT 4-bit). Drop-in alternate: `gemma-4-12b-it-Q4_K_M.gguf` | 6.72 GB (alt: 7.12 GB) | Apache 2.0 |
| **FALLBACK** | **Qwen3.5-9B** (thinking disabled) | `Qwen3.5-9B-Q4_K_M.gguf` | 5.68 GB | Apache 2.0 (UNVERIFIED on the model card itself; Qwen3.x small models have all been Apache 2.0) |
| Hebrew specialist (optional, not default) | DictaLM-3.0-Nemotron-12B-Instruct | `DictaLM-3.0-Nemotron-12B-Instruct-Q4_K_M.gguf` | 7.49 GB | NVIDIA Open Model License |

Exact download URLs:

- PICK: https://huggingface.co/unsloth/gemma-4-12B-it-qat-GGUF/resolve/main/gemma-4-12B-it-qat-UD-Q4_K_XL.gguf
- PICK (plain Q4_K_M alternate): https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/resolve/main/gemma-4-12b-it-Q4_K_M.gguf
- FALLBACK: https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf
- Optional: https://huggingface.co/dicta-il/DictaLM-3.0-Nemotron-12B-Instruct-GGUF/resolve/main/DictaLM-3.0-Nemotron-12B-Instruct-Q4_K_M.gguf

Note the repo-name casing really differs between the two Unsloth Gemma repos (`gemma-4-12B-it-qat-GGUF` vs `gemma-4-12b-it-GGUF`); HF URLs are case-sensitive in the file part. The `mmproj-*.gguf` (vision/audio projector) and `mtp-*.gguf` (multi-token-prediction draft) files in those repos are NOT needed for this text-only app.

Why Gemma 4 12B:
1. Best available Hebrew evidence in this size class (Gemma family consistently at/near the top of open models on the Hebrew chat leaderboard; Gemma 3 12B already matched or beat the Hebrew-specialised DictaLM 12B on Hebrew summarisation/translation/Winograd - see section 3).
2. Native function calling + a dedicated tool-call parser in llama.cpp (`peg-gemma4`, PR #21418) and first-class support in node-llama-cpp (v3.19.0+).
3. Apache 2.0 - no redistribution or use-policy friction (Gemma 3 used the custom Gemma Terms; Gemma 4 does not).
4. Fits an 8 GB laptop GPU at Q4 with 8k context; ~20 tok/s reported on an RTX 4060 8 GB.
5. Same family as the probable small-tier model (Gemma 4 E4B) so the app needs one prompt style / one chat wrapper for both tiers.

---

## 2. Landscape check (what exists as of 2026-09)

- **Gemma 4** exists. Released 2026-04-02 (E2B, E4B, 26B-A4B MoE, 31B dense), Apache 2.0; **Gemma 4 12B Unified** added 2026-06-03 (dense, decoder-only, encoder-free multimodal incl. audio, 256K context, 140+ languages, native function calling, optional thinking via `<|think|>` in the system prompt). Sources: https://developers.googleblog.com/gemma-4-12b-the-developer-guide/ , https://huggingface.co/google/gemma-4-12B-it , https://unsloth.ai/docs/models/gemma-4
- **Qwen3.5** exists: 0.8B, 2B, 4B, **9B**, 27B, 35B-A3B, 122B-A10B, 397B-A17B. 256K context, 201 languages, hybrid thinking (small models default to thinking OFF). Source: https://unsloth.ai/docs/models/qwen3.5
- **Qwen3.6** exists but only 27B and 35B-A3B - nothing in the 7-14B range. Source: https://unsloth.ai/docs/models/qwen3.6
- **DictaLM 3.0** (Dicta, Israel; tech report arXiv 2602.02104, 2026-02-02; HF collection updated 2025-12-10): 24B (Mistral-Small-3.1 based, Instruct + Thinking), **12B (NVIDIA Nemotron-Nano-12B-v2 hybrid-SSM based, Instruct only - no thinking variant)**, 1.7B (Qwen3-1.7B based). ~100B Hebrew tokens of continued pre-training, 65k context, "tool-calling support" using the Hermes `<tool_call>` convention with Qwen3-style message delimiters. Sources: https://arxiv.org/abs/2602.02104 , https://huggingface.co/dicta-il/DictaLM-3.0-Nemotron-12B-Instruct
- **Hebatron** (HebArabNlpProject/Hebatron, 2026-04-26, arXiv 2605.11255): Hebrew-specialised 30B-A3B MoE on Nemotron-3-Nano. License **CC BY-NC-ND 4.0** (non-commercial, no derivatives), no GGUF or tool-calling info found. Rejected on license + size. Source: https://arxiv.org/html/2605.11255
- **Ministral 3** (2512, Dec 2025): 3B / 8B / 14B, Instruct + Reasoning, Apache 2.0, native function calling + JSON output. Official language list is 11 languages and does NOT include Hebrew (it includes Arabic). Sources: https://huggingface.co/mistralai/Ministral-3-14B-Instruct-2512 , https://huggingface.co/bartowski/mistralai_Ministral-3-14B-Instruct-2512-GGUF
- ZAYA1-8B (Zyphra) was mentioned in one 2026 roundup as a good pure-8B; no Hebrew evidence found; not evaluated further. UNVERIFIED.

---

## 3. Hebrew evidence (the deciding factor)

### 3.1 DictaLM 3.0 tech report, Table 8 - Hebrew chat benchmarks, 12B class
Source: https://arxiv.org/html/2602.02104 (numbers as extracted; re-check against the PDF before quoting publicly)

| Model | Summarization | Translation | Winograd | Israeli Trivia | Nikud |
|---|---|---|---|---|---|
| DictaLM-3.0-Nemotron-12B-Instruct | 33.27 | 13.50 | 73.74 | 45.18 | 76.12 |
| Gemma-3-12B-IT | **39.48** | **16.50** | **75.90** | 44.85 | 51.78 |
| Qwen3-14B (thinking) | 15.83 | 0.90 | 73.38 | 41.86 | 4.73 |

Reading: the previous-generation Gemma 12B already matches or beats the Hebrew-specialised 12B on everything except diacritization (irrelevant to this app). Qwen3-generation models *understand* Hebrew (Winograd 73) but *generate* it badly (translation 0.9, nikud 4.7). That rules out **Qwen3 8B/14B** for drafting Hebrew replies.

English side of the same report (Table 10): DictaLM 12B vs Gemma 3 12B - MMLU 80.2 vs 77.9, MATH 75.0 vs 84.3, **AlpacaEval 2 LC 17.5 vs 50.6**. The AlpacaEval gap suggests noticeably weaker chat polish / instruction following in DictaLM 12B.

### 3.2 Hebrew Chat Leaderboard V2 (live data, fetched 2026-09-21)
Source: https://huggingface.co/datasets/hebrew-llm-leaderboard/chat-results (Space: https://huggingface.co/spaces/hebrew-llm-leaderboard/chat-leaderboard)

| Model | Nikud | SummaryPairwise | TranslationPairwise | Trivia0Shot | Winograd0Shot |
|---|---|---|---|---|---|
| google/gemma-4-31B-it | 73.41 | 48.50 | 33.30 | 58.47 | 85.97 |
| google/gemma-4-26B-A4B-it | 68.07 | 46.04 | 27.28 | 44.52 | 78.06 |
| google/gemma-3-27b-it | 60.21 | 44.54 | 26.73 | 45.51 | 79.86 |
| dicta-il/DictaLM-3.0-24B-Thinking | 86.87 | 56.86 | 30.09 | 60.13 | 78.06 |
| Qwen/Qwen3.5-122B-A10B | 67.11 | 46.19 | 30.99 | 70.10 | 93.17 |
| Qwen/Qwen3-30B-A3B-Thinking-2507 | 15.77 | 12.42 | 1.00 | 43.52 | 76.98 |
| CohereLabs/aya-expanse-32b | 45.40 | 29.46 | 17.10 | 53.82 | 80.58 |
| meta-llama/Llama-3.3-70B-Instruct | 4.05 | 37.83 | 19.31 | 60.13 | 83.45 |
| openai/gpt-4o-mini (reference) | 50.84 | 23.90 | 11.84 | 54.82 | 77.34 |
| nvidia/Nemotron-3-Nano-30B-A3B | 5.45 | 20.54 | 7.02 | 52.68 | 70.86 |

Reading:
- Gemma 4 improved Hebrew over Gemma 3 at every comparable size; Gemma 4 mid models beat gpt-4o-mini on Hebrew generation tasks.
- Qwen jumped massively from Qwen3 (translation 1.0) to Qwen3.5 (translation 31) - the Qwen3.5 data mix fixed Hebrew generation, at least at 122B. **No Hebrew number exists for Qwen3.5-9B - UNVERIFIED.** Its MMMLU (multilingual) is 81.2 vs Gemma 4 12B's 83.4 (sources: https://venturebeat.com/technology/alibabas-small-open-source-qwen3-5-9b-beats-openais-gpt-oss-120b-and-can-run , https://huggingface.co/google/gemma-4-12B-it).
- Even Llama 3.3 **70B** and Aya Expanse **32B** trail Gemma on Hebrew generation, so their 8B siblings are not competitive.
- **No leaderboard entry exists for Gemma 4 12B itself - UNVERIFIED**; the pick is inferred from Gemma-3-12B (3.1) + the Gemma 3 -> 4 improvement (3.2). Section 8 defines the in-house eval that must confirm it.

No public benchmark covers informal WhatsApp Hebrew (slang, no punctuation, mixed he/en, voice-typed text) or Hebrew relative-date extraction. UNVERIFIED for every candidate; mitigated by design in section 7.

---

## 4. Candidate matrix

Sizes are HF-listed file sizes verified 2026-09-21 unless marked. "VRAM @8k" = weights + KV cache (fp16) + compute buffers, fully offloaded; these are **estimates (UNVERIFIED)** except where a source is given. Speeds are community reports, laptop RTX 4060 8 GB class.

| Model | Hebrew evidence | Tool calling in llama.cpp (`--jinja`) | License | GGUF repo / Q4_K_M file / size | VRAM @8k | Speed | Verdict |
|---|---|---|---|---|---|---|---|
| **Gemma 4 12B it** | Strong (inferred, sec. 3) | Native; dedicated `peg-gemma4` parser (PR #21418, merged 2026-04-04). Known open edge-case bugs, see 5.1 | Apache 2.0 | `unsloth/gemma-4-12b-it-GGUF` / `gemma-4-12b-it-Q4_K_M.gguf` / 7.12 GB. QAT: `unsloth/gemma-4-12B-it-qat-GGUF` / `gemma-4-12B-it-qat-UD-Q4_K_XL.gguf` / 6.72 GB | ~6.6-7.5 GB (report: "~6.6 GB at Q4_K_M", Unsloth: "7-8 GB" total). Sliding-window attention (1024) on local layers keeps KV small | ~21 tok/s RTX 4060 8 GB; 20+ tok/s decode / 700+ tok/s prefill with QAT (+MTP) | **PICK** |
| **Qwen3.5-9B** | Family fixed Hebrew at 122B; 9B UNVERIFIED | Native Hermes-style `<tool_call>`; `peg-native` parser. Bugs when thinking is ON (issues #20837, #20260, #21158) - run with thinking OFF | Apache 2.0 (UNVERIFIED) | `unsloth/Qwen3.5-9B-GGUF` / `Qwen3.5-9B-Q4_K_M.gguf` / 5.68 GB | ~6.5 GB (Unsloth table). Hybrid linear-attention -> very small KV | 54-58 tok/s, full offload at 4K-32K ctx on 8 GB | **FALLBACK** |
| DictaLM-3.0-Nemotron-12B-Instruct | Hebrew-native (100B he tokens); but <= Gemma-3-12B on he summarisation/translation; weak AlpacaEval | Claimed (vLLM `--tool-call-parser hermes`). No llama.cpp tool-call evidence found - UNVERIFIED. Hybrid-SSM `nemotron_h` arch needs a recent llama.cpp; no BFCL-type score published | NVIDIA Open Model License (commercial use OK with conditions; must ship the license notice - read before redistributing) | `dicta-il/DictaLM-3.0-Nemotron-12B-Instruct-GGUF` / `DictaLM-3.0-Nemotron-12B-Instruct-Q4_K_M.gguf` / 7.49 GB | ~8 GB (UNVERIFIED; SSM layers make ctx cheap, but weights alone are 7.49 GB -> does not fully fit 8 GB cards) | UNVERIFIED | Optional "Hebrew specialist" download, not default |
| Gemma 3 12B it (QAT) | Proven (Table 8) | No native tool tokens; prompt-based / generic JSON fallback only | Gemma Terms of Use (custom) | `google/gemma-3-12b-it-qat-q4_0-gguf` (~8 GB, UNVERIFIED) | ~8.5 GB | ~18-20 tok/s | Superseded by Gemma 4 12B |
| Qwen3-14B / Qwen3-8B | Poor Hebrew generation (translation 0.90, nikud 4.73) | Good (Hermes) | Apache 2.0 | `unsloth/Qwen3-14B-GGUF` / `Qwen3-14B-Q4_K_M.gguf` / 9.0 GB; Qwen3-8B Q4_K_M ~5.0 GB (UNVERIFIED) | 14B: ~10.5 GB (does not fit 8 GB) | - | Rejected (Hebrew) |
| Ministral 3 14B Instruct 2512 | Hebrew not in official 11-language list; no Hebrew benchmark | Native Mistral tool format; supported | Apache 2.0 | `bartowski/mistralai_Ministral-3-14B-Instruct-2512-GGUF` / `mistralai_Ministral-3-14B-Instruct-2512-Q4_K_M.gguf` / 8.24 GB (quantised with llama.cpp b7229) | ~9.5 GB (does not fit 8 GB) | - | Rejected (Hebrew, size) |
| Ministral 3 8B Instruct 2512 | same as above | same | Apache 2.0 | bartowski repo, Q4_K_M ~5.2 GB (UNVERIFIED) | ~6.5 GB | - | Rejected (Hebrew) |
| Ministral 8B 2410 (old) | none | supported | Mistral Research License (non-commercial) | ~4.9 GB (UNVERIFIED) | - | - | Rejected (license) |
| Mistral Nemo 12B 2407 | Not a listed language; 2024 model | Native handler in llama.cpp docs (needs `--jinja`) | Apache 2.0 | `bartowski/Mistral-Nemo-Instruct-2407-GGUF` Q4_K_M ~7.5 GB (UNVERIFIED) | ~9 GB | - | Rejected (Hebrew, age) |
| Llama 3.1 8B Instruct | Hebrew not among 8 official languages; even Llama 3.3 70B scores Nikud 4.05 / Translation 19.3 | Native handler, mature | Llama 3.1 Community License | `bartowski/Meta-Llama-3.1-8B-Instruct-GGUF` Q4_K_M ~4.9 GB (UNVERIFIED) | ~6.5 GB | ~45 tok/s | Rejected (Hebrew) |
| Aya Expanse 8B | Hebrew IS one of its 23 official languages (model card; the GGUF page fetched did not list them - partially verified); Aya 32B is mid-pack on the Hebrew leaderboard | No tool calling; generic JSON fallback only | **CC-BY-NC 4.0** (non-commercial) | `bartowski/aya-expanse-8b-GGUF` / `aya-expanse-8b-Q4_K_M.gguf` / 5.06 GB | ~6.5 GB | - | Rejected (license, no tools) |
| Gemma 4 26B-A4B it (MoE, 3.8B active) | Verified on leaderboard (68.1 / 46.0 / 27.3 / 44.5 / 78.1) | same parser as 12B | Apache 2.0 | `unsloth/gemma-4-26B-A4B-it-GGUF` Q4_K_M 16.9 GB | 16-18 GB total memory | MoE -> CPU speed close to a 4B dense | Out of scope for this tier; interesting "32 GB RAM, no GPU" power-user option (sec. 6) |
| Hebatron 30B-A3B | Strong Hebrew reasoning (avg 73.8) | unknown | CC BY-NC-ND 4.0 | no GGUF found | - | - | Rejected (license) |

---

## 5. Tool calling / JSON details

### 5.1 llama.cpp state (relevant if the app bundles `llama-server`)
- Tool calling requires `--jinja`. llama.cpp now uses a PEG-grammar based parser layer; Gemma 4 has a dedicated parser (`peg-gemma4`) added in https://github.com/ggml-org/llama.cpp/pull/21418 (also makes `<|tool_response>` an end-of-generation token; earlier template fixes in PR #21326). Use a llama.cpp build from **July 2026 or later**.
- The official doc page https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md still only lists older native formats (Llama 3.x, Hermes 2/3, Qwen 2.5, Mistral Nemo, Functionary, Firefunction, Command R7B, DeepSeek R1) plus the "Generic" fallback; it is out of date relative to the code.
- Known Gemma 4 parser bugs to design around:
  - https://github.com/ggml-org/llama.cpp/issues/25986 - intermittent unparseable output when a tool call carries **long multi-line string arguments**. Our calendar-read tools take short scalar args, so exposure is low. Keep tool args short; never pass message bodies through tool args.
  - https://github.com/ggml-org/llama.cpp/issues/25072 - intermittent "does not match the expected peg-gemma4 format" (31B + draft model, closed as stale/not planned). Mitigation: catch the error and retry once; do not use speculative/MTP drafting.
  - gemma4.jinja crashes on JSON-Schema array-style types such as `"type": ["string","null"]`. **MCP servers often emit these.** Normalise tool schemas before handing them to the local model: collapse `["string","null"]` to `"string"` and drop the field from `required`.
- Known Qwen3.5 parser bugs: tool call emitted inside/after a thinking block or after prefix text fails to parse (#20837 for the 9B specifically, #20260, #21158); optional-parameter-heavy tools fail under long context (#20164). Mitigation: `enable_thinking:false`, make tool params required where possible.
- Thinking off: `--chat-template-kwargs "{\"enable_thinking\":false}"` works for both Gemma 4 and Qwen3.5 (PowerShell quoting shown). Gemma 4 may still emit an empty thought block - strip `<|channel>thought ... <channel|>` defensively, and never feed thought blocks back into history.

### 5.2 node-llama-cpp state (relevant if the app embeds via the Node binding - the natural choice for Electron)
- Latest: **node-llama-cpp 3.21.1** (2026-09-12). Gemma 4 support landed in **3.19.0** (2026-06-30); Qwen 3.5 chat wrapper in **3.18.0** (2026-03-15); 3.21.0 adds a native Jinja fallback; 3.20.0 exposes download speed/ETA (useful for the progress bar). Source: https://github.com/withcatai/node-llama-cpp/releases
- node-llama-cpp does its own function-calling (its chat wrappers + grammar-forced call syntax) and its own **JSON-schema-to-GBNF grammar** (`llama.createGrammarForJsonSchema`), so the llama-server PEG parser bugs above do not apply on that path. Whether DictaLM's Nemotron-H hybrid template is handled by a specialised wrapper or only by the Jinja fallback is UNVERIFIED.
- The exact llama.cpp build bundled in 3.21.1 is UNVERIFIED (the release page extraction was unclear).

### 5.3 Recommended call pattern for this app (model-agnostic, works for both pick and fallback)
Do not depend on free-form tool calling for the critical path. Use two constrained steps:

```ts
// Step 1 - extraction: grammar-constrained JSON, no tools. Always parses.
type Extraction = {
  is_plan: boolean;
  language: "he" | "en";
  title: string | null;
  // The model does NOT compute calendar dates. It reports what was said; code resolves it.
  date_expr: {
    kind: "absolute" | "weekday" | "relative_days" | "none";
    iso_date?: string;        // only when the text has an explicit date
    weekday?: 0|1|2|3|4|5|6;  // 0 = Sunday (Israeli week)
    week_offset?: 0 | 1 | 2;  // "this Thursday"=0, "next week Thursday / ביום חמישי הבא"=1
    days_from_today?: number; // "מחר"=1, "מחרתיים"=2
  };
  time_24h: string | null;    // "17:00"; null if missing -> "Information missing" list
  duration_min: number | null;
  location: string | null;
  missing: ("date" | "time" | "location" | "who")[];
  needs_reply: boolean;
};

// Step 2 - availability: app (or model via MCP read-only tool) lists events for the resolved slot.
// Step 3 - draft reply: plain text generation, short, in `language`, given extraction + availability.
```

Prompt must include: today's ISO date, weekday name in Hebrew and English, timezone `Asia/Jerusalem`, and a 14-day lookup table (`2026-09-24 = Thursday = יום חמישי`). Small models are unreliable at weekday arithmetic; resolving `date_expr` in TypeScript removes that failure class. Ambiguity rule for "ב-5": report `time_24h: "17:00"` only when context says afternoon/evening, otherwise add `"time"` to `missing`... or accept 17:00 with a flag - product decision.

Sampling: Google recommends `temperature 1.0, top_p 0.95, top_k 64` for Gemma 4; for step 1 use `temperature 0-0.2` with the JSON grammar (deterministic extraction), and the recommended settings only for step 3 (reply drafting). Qwen3.5 non-thinking: `temperature 0.7, top_p 0.8, top_k 20, presence_penalty 1.5`.

### 5.4 Model catalog entry (code shape)
```ts
export const MID_TIER = {
  id: "gemma-4-12b-it-qat",
  displayName: "Gemma 4 12B (QAT 4-bit)",
  family: "gemma4",
  url: "https://huggingface.co/unsloth/gemma-4-12B-it-qat-GGUF/resolve/main/gemma-4-12B-it-qat-UD-Q4_K_XL.gguf",
  fileName: "gemma-4-12B-it-qat-UD-Q4_K_XL.gguf",
  sizeBytes: 6_720_000_000,   // approx; read Content-Length at download time
  sha256: "<PIN AT BUILD TIME - not captured in this research>",
  license: "Apache-2.0",
  contextSize: 8192,
  flashAttention: true,
  kvCacheType: "q8_0",        // optional: halves KV memory, negligible quality loss
  thinking: false,
  minNodeLlamaCpp: "3.19.0",
} as const;

export const MID_TIER_FALLBACK = {
  id: "qwen3.5-9b",
  url: "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf",
  fileName: "Qwen3.5-9B-Q4_K_M.gguf",
  sizeBytes: 5_680_000_000,
  license: "Apache-2.0",
  contextSize: 8192,
  thinking: false,
  minNodeLlamaCpp: "3.18.0",
} as const;
```
Equivalent llama-server flags if the server binary is bundled instead: `--jinja -fa on -c 8192 -ngl 99 --cache-type-k q8_0 --cache-type-v q8_0 --chat-template-kwargs "{\"enable_thinking\":false}"`.

HF downloads support HTTP Range requests, so the downloader can resume; verify sha256 after download (HF shows the LFS sha256 on each file's page).

---

## 6. Hardware detection thresholds (small tier vs this tier)

Inputs: `os.totalmem()`; GPU type + VRAM from node-llama-cpp (`getLlama()` then `llama.gpu`, `llama.getVramState()`, `llama.getGpuDeviceNames()` - API names from memory, UNVERIFIED against 3.21 docs); free disk on the userData drive.

Important: **integrated GPUs (Intel Iris/Arc iGPU, AMD Radeon Graphics) report shared system RAM as "VRAM" through Vulkan.** Do not count them. Treat a GPU as "dedicated" only if backend is CUDA, or the Vulkan device name matches a discrete part (NVIDIA GeForce/RTX/Quadro, AMD Radeon RX, Intel Arc A/B-series discrete). When unsure, treat as no GPU.

Reported numbers are always a little under nominal (8 GB card reports ~7.9-8.0 GiB total, some reserved by Windows DWM; 32 GB RAM reports ~31.7 GiB), so thresholds are set below nominal.

| Condition (first match wins) | Tier | Model | Mode |
|---|---|---|---|
| Free disk < 12 GB | small | (small-tier model) | - |
| Dedicated VRAM >= 7.5 GB and RAM >= 15 GB | **mid** | Gemma 4 12B QAT, 8k ctx | full GPU offload (expect ~20 tok/s) |
| Dedicated VRAM >= 5.5 GB and < 7.5 GB, RAM >= 15 GB | **mid** | Gemma 4 12B QAT, 8k ctx | partial offload (auto `gpuLayers`), expect ~8-14 tok/s UNVERIFIED. If the post-download benchmark is < 8 tok/s, offer Qwen3.5-9B (fits almost fully in 6 GB) or the small tier |
| No dedicated GPU (or VRAM < 5.5 GB) and RAM >= 30 GB | **mid** | Gemma 4 12B QAT, 8k ctx | CPU only; expect ~4-7 tok/s decode on DDR5 laptops UNVERIFIED (memory-bandwidth bound: ~7 GB read per token). Acceptable because drafting is a background job, but show an expectation note |
| Everything else (8-16 GB RAM, CPU/iGPU only; or dedicated VRAM < 5.5 GB with RAM < 30 GB) | small | ~4B class | - |

Additional rules:
- Always run a 5-second micro-benchmark after the model loads (prompt-eval tok/s and decode tok/s) and store it. If decode < 5 tok/s on the mid tier, surface a one-click "switch to the smaller model" suggestion. Never auto-switch silently (it triggers a new multi-GB download).
- Let the user override the tier in Settings; show download size before starting.
- Check free RAM, not just total, before loading on the CPU path (need ~9 GB free for a 12B Q4 + 8k ctx).
- Power-user option (not default): on 32 GB RAM without GPU, `gemma-4-26B-A4B-it` Q4_K_M (16.9 GB, 3.8B active params) should decode about as fast as a 4B dense model while having leaderboard-verified Hebrew quality. Cost: 17 GB download and ~18 GB resident RAM. Worth offering later as "Large (MoE)" if users on 32 GB machines complain about speed or quality.

---

## 7. Why not DictaLM as the default, given the Hebrew focus?

It is the only Hebrew-native candidate and deserves a place in the model list, but as default it loses on:
1. Measured Hebrew chat quality is not better than general Gemma at the same size (3.1), and Gemma 4 is a generation newer.
2. Instruction-following/chat polish gap (AlpacaEval 2 LC 17.5 vs 50.6).
3. Tool calling is only documented for vLLM (`--tool-call-parser hermes`); nothing verified on llama.cpp / node-llama-cpp; no function-calling benchmark published.
4. 7.49 GB weights do not fully fit an 8 GB laptop GPU with context.
5. NVIDIA Open Model License adds redistribution conditions vs Apache 2.0.
6. Hybrid-SSM (`nemotron_h`) support in llama.cpp is newer and less battle-tested on Windows/Vulkan. UNVERIFIED.

Keep it as an optional manual download ("Hebrew specialist - experimental") only if the in-house eval (section 8) shows a real advantage on informal Hebrew.

---

## 8. Verification plan before locking the choice (cannot be done by web research)

Build a fixed eval set of ~40 synthetic WhatsApp snippets (no real user data): 25 Hebrew, 10 English, 5 mixed; covering "מחר", "מחרתיים", "ביום חמישי", "חמישי הבא", "בשבוע הבא", "ב-5", "בערב", "אחרי העבודה", typos, slang ("יאללה", "סבבה", "נדבר"), messages that are NOT plans, and messages missing time/date. Score each of Gemma 4 12B QAT, Qwen3.5-9B, DictaLM 12B on:
1. `is_plan` precision/recall; 2. field-level extraction accuracy (after code-side date resolution); 3. correct `missing[]`; 4. reply language matches sender; 5. human 1-5 naturalness of Hebrew replies (gender agreement, register); 6. JSON validity (should be 100% under grammar); 7. tool-call success rate over 50 calendar-read calls; 8. tok/s and peak VRAM at 8k ctx on a real 8 GB laptop GPU.
Switch pick <-> fallback only if Gemma 4 12B loses on (1)-(5).

---

## 9. Items marked UNVERIFIED (summary)
- Hebrew quality of Gemma 4 **12B** and Qwen3.5 **9B** specifically (no public Hebrew numbers at these sizes).
- All candidates on informal WhatsApp Hebrew and relative-date extraction.
- Exact VRAM at 8k context for every model (estimates; one community report of ~6.6 GB for Gemma 4 12B Q4_K_M and ~20 tok/s on RTX 4060 8 GB, plus an X post - https://x.com/analogalok/status/2064282424532672841 - not independently reproduced).
- CPU-only and partial-offload speeds.
- Qwen3.5-9B license text (assumed Apache 2.0); sizes for Qwen3-8B, Ministral 3 8B, Mistral Nemo, Llama 3.1 8B, Ministral 8B 2410, Gemma 3 12B QAT Q4_K_M files (from memory).
- DictaLM tool calling and Nemotron-H stability under llama.cpp / node-llama-cpp on Windows.
- node-llama-cpp API names for VRAM detection and the llama.cpp build bundled with 3.21.1.
- sha256 checksums (pin at build time from the HF file pages).
- Unsloth's QAT quality claims (e.g. "85.6% vs 70.2% top-1" for 26B) are vendor-reported.

---

## 10. Sources
- Gemma 4 12B developer guide: https://developers.googleblog.com/gemma-4-12b-the-developer-guide/
- Gemma 4 12B model card: https://huggingface.co/google/gemma-4-12B-it
- Unsloth Gemma 4 docs: https://unsloth.ai/docs/models/gemma-4 ; QAT: https://unsloth.ai/docs/models/gemma-4/qat
- Gemma 4 12B GGUF files: https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/tree/main ; QAT: https://huggingface.co/unsloth/gemma-4-12B-it-qat-GGUF/tree/main
- Gemma 4 26B-A4B GGUF: https://huggingface.co/unsloth/gemma-4-26B-A4B-it-GGUF
- Google llama.cpp integration page: https://ai.google.dev/gemma/docs/integrations/llamacpp
- Qwen3.5 docs: https://unsloth.ai/docs/models/qwen3.5 ; files: https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/tree/main ; Qwen3.6: https://unsloth.ai/docs/models/qwen3.6
- Qwen3.5-9B coverage: https://venturebeat.com/technology/alibabas-small-open-source-qwen3-5-9b-beats-openais-gpt-oss-120b-and-can-run
- 8 GB VRAM roundups (speed numbers): https://localllm.in/blog/best-local-llms-8gb-vram-2025 , https://techsy.io/en/blog/gemma-4-12b , https://www.buildfastwithai.com/blogs/gemma-4-12b-guide
- DictaLM 3.0: https://huggingface.co/dicta-il/DictaLM-3.0-Nemotron-12B-Instruct , https://huggingface.co/dicta-il/DictaLM-3.0-Nemotron-12B-Instruct-GGUF/tree/main , https://arxiv.org/abs/2602.02104 , https://arxiv.org/html/2602.02104 , https://dicta.org.il/publications/DictaLM_3_0___Techincal_Report.pdf
- Hebrew chat leaderboard data: https://huggingface.co/datasets/hebrew-llm-leaderboard/chat-results ; Space: https://huggingface.co/spaces/hebrew-llm-leaderboard/chat-leaderboard
- Hebatron: https://arxiv.org/html/2605.11255
- Ministral 3: https://huggingface.co/mistralai/Ministral-3-14B-Instruct-2512 , https://huggingface.co/bartowski/mistralai_Ministral-3-14B-Instruct-2512-GGUF
- Qwen3-14B GGUF: https://huggingface.co/unsloth/Qwen3-14B-GGUF/tree/main
- Aya Expanse 8B GGUF: https://huggingface.co/bartowski/aya-expanse-8b-GGUF
- llama.cpp function calling doc: https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md
- llama.cpp Gemma 4 parser: https://github.com/ggml-org/llama.cpp/pull/21418 , https://github.com/ggml-org/llama.cpp/pull/21326 ; issues https://github.com/ggml-org/llama.cpp/issues/25072 , https://github.com/ggml-org/llama.cpp/issues/25986
- llama.cpp Qwen3.5 tool-call issues: https://github.com/ggml-org/llama.cpp/issues/20837 , https://github.com/ggml-org/llama.cpp/issues/20260 , https://github.com/ggml-org/llama.cpp/issues/21158 , https://github.com/ggml-org/llama.cpp/issues/20164
- node-llama-cpp releases: https://github.com/withcatai/node-llama-cpp/releases
