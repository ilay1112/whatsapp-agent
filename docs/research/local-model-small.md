# Research: local-model-small (~3-5B tier, CPU-only 8-16 GB Windows laptop)

Research date: 2026-09-21. All facts below were checked on the web on that date unless marked **UNVERIFIED**.
Scope: the "small" tier of the embedded llama.cpp provider (CPU-only, 8-16 GB RAM). The 8-12B tier is a separate research task.

---

## 1. TL;DR

| Role | Model | File | Size | License |
|---|---|---|---|---|
| **PICK** (12-16 GB RAM) | **Gemma 4 E4B-it** (Google DeepMind, 4.5B effective / 8B with embeddings) | `gemma-4-E4B-it-Q4_K_M.gguf` | 4.98 GB | Apache 2.0 |
| Pick, low-RAM variant (8 GB RAM) | Gemma 4 E2B-it (2.3B effective / 5.1B with embeddings) - same family, same chat template/wrapper | `gemma-4-E2B-it-Q4_K_M.gguf` | 3.11 GB | Apache 2.0 |
| **FALLBACK** (different family) | **Qwen3.5-4B** (Alibaba Qwen, released 2026-03-02) | `Qwen3.5-4B-Q4_K_M.gguf` | 2.74 GB | Apache 2.0 |

Exact download URLs (public, not gated, no HF token needed):

```
PICK
https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf          (4.98 GB)

PICK, 8 GB-RAM variant
https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf          (3.11 GB)

FALLBACK
https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf                  (2.74 GB)
```

Optional smaller/better-quality quant of the pick (QAT = quantization-aware-trained checkpoint, 760 MB smaller than Q4_K_M):

```
https://huggingface.co/unsloth/gemma-4-E4B-it-qat-GGUF/resolve/main/gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf   (4.22 GB)
```

Do NOT download the `mmproj-*.gguf` files (vision/audio projector, 0.6-1.9 GB). The app is text-only.

Why this pick, in one paragraph: the job's hard part is *informal Hebrew*. JSON validity can be forced by llama.cpp grammars for any model, but Hebrew comprehension/generation cannot be patched in. The only independent Hebrew benchmark that compares the relevant families (Dicta's DictaLM 3.0 tech report) shows the Gemma family far ahead of the Qwen3 family on Hebrew generation at every size it tested, and Gemma 4 E4B is the newest Gemma, Apache-2.0 (the old restrictive "Gemma Terms" are gone), has native function calling, and has a dedicated `Gemma4ChatWrapper` in node-llama-cpp v3.19. Qwen3.5-4B has the best published agent/tool numbers at this size and is much smaller on disk, but its Hebrew quality is unverified and its lineage has a poor Hebrew record - hence fallback, not pick.

---

## 2. Requirements recap (what the model must do)

1. Understand informal Hebrew + English WhatsApp chat (slang, no nikud, typos, code-switching, emojis).
2. Extract appointment details: relative dates ("yom chamishi", "machar ba-erev", "next Thu"), times, place, people.
3. Reliable structured JSON / function calling (MCP calendar tools are exposed to the model; in this app the model may only autonomously call READ tools - free/busy, list events).
4. Draft a short natural reply in the sender's language.
5. Run inside embedded llama.cpp on a CPU-only 8-16 GB Windows 11 laptop next to Electron + the Go bridge.
6. License must allow an end-user app to download (and ideally redistribute) the weights.

---

## 3. Candidate-by-candidate findings

### 3.1 Gemma 4 E4B-it / E2B-it (Google DeepMind) - PICK

- Release: Gemma 4 family launched 2026-04-02 (E2B, E4B, 26B-A4B, 31B; a 12B "Unified" followed). Tech report arXiv 2607.02770 (July 2026).
  - https://huggingface.co/google/gemma-4-E4B-it
  - https://arxiv.org/abs/2607.02770
  - https://ai.google.dev/gemma/docs/core
- Size: E4B = 4.5B effective parameters, 8B total including per-layer embeddings (PLE); E2B = 2.3B effective / 5.1B total. 128K context. Text + image + audio (we use text only).
- License: **Apache 2.0** (verified on the google/, unsloth/ and ggml-org/ repos). Not gated. This is a major change from Gemma 3 / 3n, which use the custom "Gemma Terms of Use".
- Hebrew evidence:
  - Model card: "pre-trained on 140+ languages, out-of-the-box support for 35+". Hebrew is not individually named on the card (the card does not enumerate the list). **UNVERIFIED** that Hebrew is in the "35+" list.
  - MMMLU (multilingual MMLU): E4B 76.6, E2B 67.4 (Gemma 3 27B = 70.7) - per the Gemma 4 tech report. No per-language Hebrew number published.
  - Lineage evidence (independent, Hebrew-specific): DictaLM 3.0 tech report Table 8 - Gemma-3-12B-it vs Qwen3-14B (think) on Hebrew: summarization 39.48 vs 15.83, translation 16.50 vs 0.90, Israeli trivia 44.85 vs 41.86, nikud 51.78 vs 4.73. Gemma-3-27B-it also beats Aya-Expanse-32B and Llama-3.3-70B on Hebrew summarization/translation. Gemma is consistently the strongest *general* open family in Hebrew; only Dicta's own Hebrew-adapted models beat it. https://arxiv.org/html/2602.02104
  - No Gemma 4 entry found on a Hebrew leaderboard; the HF "Open Hebrew LLM leaderboard" (https://huggingface.co/blog/leaderboard-hebrew) appears not to track 2026 models. **UNVERIFIED**: direct Hebrew score for Gemma 4 E4B.
- Tool calling:
  - Native function calling with dedicated tokens; thinking is optional (`enable_thinking` template kwarg; off = faster).
  - llama.cpp: supported; official template in repo `models/templates/google-gemma-4-31B-it-interleaved.jinja`; llama-server parses Gemma's native call tokens with a PEG parser. Known caveat (llama.cpp discussion #21839): the grammar constrains the *structure* of Gemma's fc notation but not argument values against the JSON schema, because `json-schema-to-grammar` only emits JSON rules. A template fix for tool calling landed after launch - use a current llama.cpp build. https://github.com/ggml-org/llama.cpp/discussions/21839
  - node-llama-cpp **v3.19 (2026-06-30)** ships `Gemma4ChatWrapper`, reasoning-budget control and "improved performance for grammar and function calling inference". https://node-llama-cpp.withcat.ai/blog/v3.19-gemma-4
  - Published agent score: Tau2 (avg of 3) = 42.2 for E4B-it. No BFCL number published.
- GGUF:
  - `unsloth/gemma-4-E4B-it-GGUF`: `gemma-4-E4B-it-Q4_K_M.gguf` 4.98 GB; `gemma-4-E4B-it-UD-Q4_K_XL.gguf` 5.13 GB; `Q5_K_M` 5.48 GB; `Q8_0` 8.19 GB. https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/tree/main
  - `unsloth/gemma-4-E4B-it-qat-GGUF`: `gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf` 4.22 GB; MTP drafter `mtp-gemma-4-E4B-it.gguf` 59.7 MB. https://huggingface.co/unsloth/gemma-4-E4B-it-qat-GGUF/tree/main
  - `ggml-org/gemma-4-E4B-it-GGUF` (llama.cpp maintainers' mirror): `gemma-4-E4B-it-Q4_0.gguf` 4.59 GB, `Q8_0` 8.03 GB - no Q4_K_M there. https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/tree/main
  - `google/gemma-4-E4B-it-qat-q4_0-gguf` (official, 4.59 GB, not gated; exact filename **UNVERIFIED**). https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf
  - `unsloth/gemma-4-E2B-it-GGUF`: `gemma-4-E2B-it-Q4_K_M.gguf` 3.11 GB; `UD-Q4_K_XL` 3.18 GB; `Q8_0` 5.05 GB. https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/tree/main
- RAM: Unsloth guidance - E2B ~4 GB, E4B ~5.5-6 GB at 4-bit. Important detail: a large part of the file is the per-layer-embedding lookup table, which is mmap'd and lazily paged (a measured run showed the 1.93 GB E2B embedding table stayed mostly non-resident). So the working set is smaller than the file. https://unsloth.ai/docs/models/gemma-4 , https://dev.to/gde/a-4-gb-laptop-gpu-beats-a-12-core-cpu-by-43x-on-gemma-4-4150
- Speed (CPU):
  - Measured: Gemma 4 E2B-it QAT Q4_0 on Intel i7-1360P laptop (12C/16T), llama.cpp `-ngl 0 -t 4 -tb 8`: **~16.6 tok/s decode**; time-to-first-token 1.1 s (short prompt) to 24 s (very long prompt). (dev.to link above)
  - E4B: no trustworthy CPU measurement found. Estimate by scaling active compute (4.5B vs 2.3B): **~7-10 tok/s** on the same class of CPU, **~4-6 tok/s** on older 4-core U-series. SEO sites quote "3-5 tok/s"; treat all as **UNVERIFIED** until measured in-app.
  - A 59.7 MB MTP drafter GGUF exists for speculative decoding (speed-up on CPU **UNVERIFIED**; optional, not needed for v1).
- Sampling (official): temperature 1.0, top_p 0.95, top_k 64. For the extraction step we recommend temperature 0.1-0.3 with a JSON grammar (our recommendation, not Google's).

### 3.2 Qwen3.5-4B (Alibaba Qwen) - FALLBACK

- Release 2026-03-02 (Qwen3.5 small series: 0.8B / 2B / 4B / 9B). There is NO newer small Qwen: Qwen3.6 (April 2026) is 27B and 35B-A3B only; Qwen3.8 (Aug 2026) starts at 27B. https://huggingface.co/Qwen/Qwen3.5-4B , https://codersera.com/blog/qwen-3-8-model-lineup-2026/
- Architecture: hybrid Gated DeltaNet + gated attention (3:1), 32 layers, 262K native context, vision-capable (separate mmproj). License **Apache 2.0**.
- Hebrew evidence:
  - "201 languages and dialects" (up from 119 in Qwen3). Hebrew is reported as included in the Qwen3.5 language list, but no Hebrew-specific score exists. **UNVERIFIED** quality.
  - Negative lineage evidence: DictaLM 3.0 report - Qwen3-1.7B scored 0 on Hebrew translation and 0.4 on summarization; Qwen3-14B scored 0.90 on translation. Older user report of Chinese/English tokens leaking into Hebrew output (QwenLM/Qwen3 issue #1114, Nov 2024, Qwen2.5). Qwen3.5 may have fixed this; nobody has published proof.
  - Aggregate multilingual numbers are strong: MMMLU 76.1, MMLU-ProX 71.5, INCLUDE 71.0, WMT24++ 66.6.
- Tool calling: best published numbers at this size - **BFCL-V4 50.3, TAU2-Bench 79.9, IFEval 89.8**. Hermes-style `<tool_call>` XML, vLLM parser name `qwen3_coder`.
  - llama.cpp caveat: llama-server's PEG parser failed when the model emitted any text before `<tool_call>` (issues #20260, #21158 - closed; PR #20424 was a partial fix), plus #20837 (tool calls inside thinking block) and #19872. Unsloth re-uploaded GGUFs with chat-template fixes that "improved tool-calling". Use a current llama.cpp build and the re-uploaded GGUF; keep thinking disabled. https://github.com/ggml-org/llama.cpp/issues/21158 , https://unsloth.ai/docs/models/qwen3.5
  - node-llama-cpp: v3.19 release notes do not mention Qwen3.5. Whether the bundled llama.cpp build supports the `qwen35` architecture and which chat wrapper is auto-selected is **UNVERIFIED** - must be smoke-tested.
- Thinking: Unsloth docs say thinking is disabled by default for the 0.8B-9B GGUFs; Qwen's own card says thinking is on by default. Always pass `enable_thinking: false` explicitly.
- GGUF: `unsloth/Qwen3.5-4B-GGUF` - `Qwen3.5-4B-Q4_K_M.gguf` **2.74 GB**; `UD-Q4_K_XL` 2.91 GB; `Q5_K_M` 3.14 GB; `Q8_0` 4.48 GB. https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/tree/main
- Sampling (non-thinking): temperature 0.7, top_p 0.8, top_k 20. If output is gibberish: `--cache-type-k bf16 --cache-type-v bf16` (Unsloth note).
- Speed: no model-specific CPU measurement found. Generic 4B Q4_K_M expectation 8-15 tok/s on a modern laptop CPU; DeltaNet layers keep long-context decode cheap. **UNVERIFIED**.
- RAM: ~4.5 GB at 4-bit (Unsloth).

### 3.3 DictaLM 3.0 small (Dicta, Hebrew-specialised)

- The DictaLM 3.0 family (Dec 2025; arXiv 2602.02104) has exactly three sizes: **1.7B** (from Qwen3-1.7B-Base), **12B** (from NVIDIA Nemotron Nano 12B v2, hybrid SSM), **24B** (from Mistral-Small-3.1-24B). There is **no 3-5B DictaLM 3.0**. 65K context; tool calling supported (Hermes parser). Weights Apache 2.0.
  - https://huggingface.co/dicta-il/DictaLM-3.0-1.7B-Instruct
  - https://huggingface.co/collections/dicta-il/dictalm-30-collection
- Hebrew (Table 8, "tiny" class): DictaLM-3.0-1.7B-Instruct vs Qwen3-1.7B vs Gemma-3-1b-it - summarization 9.72 / 0.4 / 0.35; translation 2.16 / 0 / 0.15; Hebrew Winogrande 58.2 / 51.08 / 47.84; Israeli trivia 30.21 / 21.59 / 26.58. It wins its weight class clearly, but in absolute terms these are weak (Winogrande 58 is close to chance; Gemma-3-12B gets 75.9, summarization 39.5). A 1.7B model is not good enough for reliable relative-date reasoning + reply drafting.
- GGUF: official GGUF exists only for the *Thinking* variant: `dicta-il/DictaLM-3.0-1.7B-Thinking-GGUF` -> `DictaLM-3.0-1.7B-Thinking-Q4_K_M.gguf` **1.11 GB** (Apache 2.0). No official GGUF for 1.7B-Instruct (the HF page lists 2 community quantizations; not vetted). https://huggingface.co/dicta-il/DictaLM-3.0-1.7B-Thinking-GGUF/tree/main
- Verdict: not the pick for this tier. Relevant to the *large* tier instead: `dicta-il/DictaLM-3.0-Nemotron-12B-Instruct-GGUF` (official GGUF incl. Q5_K_M; on Hebrew it is roughly on par with Gemma-3-12B-it: better on nikud/trivia, worse on summarization/translation). Possible future "ultra-low-RAM" emergency option at 1.11 GB.

### 3.4 Gemma 3 4B-it / Gemma 3n E4B

- Gemma 3 4B-it (Mar 2025): good Hebrew for its size (same lineage evidence as above), 128K ctx. `unsloth/gemma-3-4b-it-GGUF` -> `gemma-3-4b-it-Q4_K_M.gguf` **2.49 GB**. Google's own QAT GGUF repo `google/gemma-3-4b-it-qat-q4_0-gguf` is gated.
- Weaknesses: license is the custom **Gemma Terms of Use** (redistribution allowed but with pass-through conditions and a prohibited-use policy); **no native tool-calling tokens/template** (function calling is prompt-only, llama.cpp falls back to the "Generic" handler); weak multilingual reasoning (Multilingual Reasoning Gym: Gemma 3 4B 25.3% vs Qwen3-4B 54.7% across 15 languages, arXiv 2603.10793).
- Gemma 3n E4B: same licence problem, superseded by Gemma 4 E4B (Gemma 4 report shows double-digit relative gains over 3n).
- Verdict: superseded by Gemma 4 on every axis except file size. Keep `gemma-3-4b-it-Q4_K_M.gguf` in mind only if Gemma 4 turns out to be too heavy AND Qwen3.5 Hebrew is bad.

### 3.5 Phi-4-mini-instruct (Microsoft, 3.8B, Feb 2025)

- MIT license. 128K ctx. Hebrew IS in the official 23-language list. Function-calling format with `<|tool|>` tokens. https://huggingface.co/microsoft/Phi-4-mini-instruct
- But multilingual strength is low: Multilingual MMLU 49.3 (vs ~76 for Gemma 4 E4B / Qwen3.5-4B on MMMLU - different harnesses, but the gap is large). Not in llama.cpp's native tool-call handler list (Generic fallback). 19 months old.
- GGUF: `unsloth/Phi-4-mini-instruct-GGUF` -> `Phi-4-mini-instruct-Q4_K_M.gguf` **2.49 GB**.
- Verdict: rejected (weak Hebrew, old).

### 3.6 Llama 3.2 3B Instruct (Meta, Sep 2024)

- Llama 3.2 Community License (custom; attribution + "Built with Llama" + AUP; acceptable-use and EU multimodal clauses). Officially 8 languages - **Hebrew not supported**. Native tool-call handler in llama.cpp (Llama 3.x is on the native list).
- GGUF: `bartowski/Llama-3.2-3B-Instruct-GGUF` -> `Llama-3.2-3B-Instruct-Q4_K_M.gguf` **2.02 GB**.
- Verdict: rejected (no Hebrew).

### 3.7 SmolLM3-3B (Hugging Face, Jul 2025)

- Apache 2.0; tool calling supported; dual-mode reasoning. Multilingual focus is European languages (EN/FR/ES/DE/IT/PT + limited others) - **no Hebrew**.
- GGUF: `unsloth/SmolLM3-3B-GGUF` -> `SmolLM3-3B-Q4_K_M.gguf` **1.92 GB**.
- Verdict: rejected (no Hebrew).

### 3.8 Ministral 3 3B Instruct 2512 (Mistral, Dec 2025)

- Apache 2.0; native function calling + JSON output; vision; 256K ctx. Listed languages: EN, FR, ES, DE, IT, PT, NL, ZH, JA, KO, AR ("dozens") - **Hebrew not listed**; no Hebrew evidence found.
- GGUF: `unsloth/Ministral-3-3B-Instruct-2512-GGUF` -> `Ministral-3-3B-Instruct-2512-Q4_K_M.gguf` **2.15 GB**; official `mistralai/Ministral-3-3B-Instruct-2512-GGUF` also exists.
- Verdict: rejected for Hebrew uncertainty; good tool-caller otherwise.

### 3.9 Anything newer in 2026?

- Checked: Qwen3.6 / Qwen3.8 (no small sizes), Gemma 4 (yes - picked), Phi (no Phi-5-mini found), Llama (no new small open model found), DictaLM (nothing after 3.0; 24B refreshed May 2026). No newer 3-5B model with Hebrew evidence was found. **UNVERIFIED**: exhaustive coverage - the small-model space moves monthly.

---

## 4. Comparison matrix

| Model | Params | Q4_K_M size | License | Hebrew evidence | Native tool calling in llama.cpp | Est. CPU decode tok/s (modern laptop) |
|---|---|---|---|---|---|---|
| **Gemma 4 E4B-it** | 4.5B eff / 8B | 4.98 GB (QAT UD-Q4_K_XL 4.22 GB) | Apache 2.0 | Strong lineage (Gemma 3 >> Qwen3 in Dicta tests); MMMLU 76.6; direct Hebrew score UNVERIFIED | Yes (PEG parser; node-llama-cpp `Gemma4ChatWrapper`) | ~7-10 (UNVERIFIED) |
| Gemma 4 E2B-it | 2.3B eff / 5.1B | 3.11 GB | Apache 2.0 | Same family; MMMLU 67.4 | Yes | ~16.6 measured on i7-1360P |
| **Qwen3.5-4B** | 4B | 2.74 GB | Apache 2.0 | 201 langs claimed; lineage weak in Hebrew; UNVERIFIED | Yes but parser bugs in H1 2026; BFCL-V4 50.3, TAU2 79.9 | ~8-15 (UNVERIFIED) |
| DictaLM-3.0-1.7B | 1.7B | 1.11 GB (Thinking only) | Apache 2.0 | Best-in-class at 1.7B, weak in absolute terms | Hermes format | ~20+ (UNVERIFIED) |
| Gemma 3 4B-it | 4B | 2.49 GB | Gemma Terms (custom) | Good | No (Generic fallback) | ~8-14 (UNVERIFIED) |
| Phi-4-mini | 3.8B | 2.49 GB | MIT | Hebrew listed; MMLU-multilingual 49.3 | Generic fallback | ~8-15 (UNVERIFIED) |
| Llama 3.2 3B | 3.2B | 2.02 GB | Llama 3.2 Community | Not supported | Native | ~12-18 (UNVERIFIED) |
| SmolLM3-3B | 3B | 1.92 GB | Apache 2.0 | None | Hermes-ish | ~12-18 (UNVERIFIED) |
| Ministral 3 3B | 3B (+vision) | 2.15 GB | Apache 2.0 | Not listed | Native (Mistral) | ~12-18 (UNVERIFIED) |

---

## 5. Recommendation details

### 5.1 Tier rule for the first-run hardware detector (small tier only)

```
totalRAM >= 12 GB (CPU-only)  -> gemma-4-E4B-it-Q4_K_M.gguf            (4.98 GB)  [or QAT UD-Q4_K_XL 4.22 GB]
totalRAM  <  12 GB            -> gemma-4-E2B-it-Q4_K_M.gguf            (3.11 GB)
user override / Gemma failure -> Qwen3.5-4B-Q4_K_M.gguf                (2.74 GB)
```

Rationale for the 12 GB cut: Windows 11 + Electron + Go bridge typically hold 4-5 GB; E4B needs ~5.5-6 GB incl. KV cache at 8K context; on an 8 GB machine that means paging. E2B uses the identical template, tokenizer and chat wrapper, so it is a file swap, not a code path.

### 5.2 Model manifest shape (for the downloader)

```ts
export interface LocalModelSpec {
  id: string;               // "gemma-4-e4b-it-q4km"
  family: "gemma4" | "qwen35";
  displayName: string;
  url: string;              // HF resolve URL; pin a commit instead of "main" at build time
  fileName: string;
  sizeBytesApprox: number;  // for progress bar before Content-Length arrives
  sha256: string;           // UNVERIFIED here - fetch from HF API (lfs.oid) at build time and pin
  minRamGb: number;
  license: "Apache-2.0";
  sampling: { temperature: number; topP: number; topK: number };
  disableThinking: true;
}

export const SMALL_TIER: LocalModelSpec[] = [
  { id: "gemma-4-e4b-it-q4km", family: "gemma4", displayName: "Gemma 4 E4B (4-bit)",
    url: "https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf",
    fileName: "gemma-4-E4B-it-Q4_K_M.gguf", sizeBytesApprox: 4.98e9, sha256: "<pin>", minRamGb: 12,
    license: "Apache-2.0", sampling: { temperature: 1.0, topP: 0.95, topK: 64 }, disableThinking: true },
  { id: "gemma-4-e2b-it-q4km", family: "gemma4", displayName: "Gemma 4 E2B (4-bit)",
    url: "https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf",
    fileName: "gemma-4-E2B-it-Q4_K_M.gguf", sizeBytesApprox: 3.11e9, sha256: "<pin>", minRamGb: 8,
    license: "Apache-2.0", sampling: { temperature: 1.0, topP: 0.95, topK: 64 }, disableThinking: true },
  { id: "qwen3.5-4b-q4km", family: "qwen35", displayName: "Qwen3.5 4B (4-bit)",
    url: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf",
    fileName: "Qwen3.5-4B-Q4_K_M.gguf", sizeBytesApprox: 2.74e9, sha256: "<pin>", minRamGb: 8,
    license: "Apache-2.0", sampling: { temperature: 0.7, topP: 0.8, topK: 20 }, disableThinking: true },
];
```

Notes: HF `resolve` URLs support HTTP Range (resumable download). Replace `main` with a commit SHA so a future re-upload by Unsloth cannot silently change the file. SHA256 values were not retrieved in this research (HF API calls were reset by the network) - **UNVERIFIED / TODO at build time**: `GET https://huggingface.co/api/models/unsloth/gemma-4-E4B-it-GGUF/tree/main` returns `lfs.oid` = sha256.

### 5.3 How to use a small model reliably for THIS job (design guidance)

Small models fail at (a) date arithmetic and (b) free-form multi-step tool loops. Do not ask them to do either.

1. **Never let the model compute dates.** Inject into the system prompt: now (ISO, Asia/Jerusalem), and a pre-computed 14-day table with English and Hebrew weekday names, e.g. `2026-09-24 | Thursday | yom chamishi | יום חמישי`. Ask the model to *select* a date from the table or return the raw phrase. Resolve "machar", "ba-erev" (default 19:00-20:00), "achar ha-tzohorayim", "next week" in TypeScript as a second safety net and cross-check the model's answer; disagreement -> "Information missing" list.
2. **Two-step pipeline instead of an open agent loop**:
   - Step A (grammar-constrained JSON, temperature ~0.2): classify + extract.
   - Step B (app code, not model): if Step A yields a concrete time window, the app calls the MCP calendar READ tool (free/busy / list events) itself, or offers exactly that one tool to the model.
   - Step C (free text, family default sampling): draft a 1-2 sentence reply in the sender's language given extraction + availability. Draft only - user clicks to send.
   This keeps the locked "calendar via MCP tools exposed to the LLM" architecture (the tools are still registered with the local provider), while not depending on a 4B model to plan multi-tool chains. Claude/Gemini providers can use the full loop.
3. **Force JSON with a grammar**, not with the chat-template tool parser. llama.cpp `json_schema` / GBNF (node-llama-cpp: `llama.createGrammarForJsonSchema`) guarantees parseable output for any model, side-stepping both the Gemma "arguments not constrained" caveat and the Qwen3.5 PEG-parser bugs.
4. **Disable thinking** on both families for latency (`enable_thinking:false` / node-llama-cpp reasoning budget 0). At ~8 tok/s a 300-token thought costs ~40 s.
5. Context 4096-8192 tokens is plenty (last N messages of one chat); keeps KV cache small. Threads = physical cores (not logical). Keep the model loaded (mmap) but allow unload-on-idle for 8 GB machines.
6. Keep Hebrew text as-is (no transliteration). Include 3-4 few-shot examples in Hebrew slang in the system prompt ("נקבע ליום ה בערב?", "בא לך קפה מחר ב5?", "סבבה, איפה?").

Extraction schema (code shape):

```ts
const extractionSchema = {
  type: "object",
  properties: {
    intent: { enum: ["propose_meeting", "confirm_meeting", "reschedule", "cancel", "question_needs_reply", "no_action"] },
    language: { enum: ["he", "en", "mixed"] },
    title: { type: "string" },
    date_iso: { type: ["string", "null"] },          // chosen from the injected date table
    date_phrase: { type: ["string", "null"] },       // raw text, e.g. "יום חמישי", "machar ba-erev"
    start_time: { type: ["string", "null"] },        // "17:00"
    end_time: { type: ["string", "null"] },
    part_of_day: { enum: ["morning", "noon", "afternoon", "evening", "night", null] },
    location: { type: ["string", "null"] },
    people: { type: "array", items: { type: "string" } },
    missing: { type: "array", items: { enum: ["date", "time", "location", "who"] } },
    confidence: { enum: ["high", "medium", "low"] }
  },
  required: ["intent", "language", "missing", "confidence"]
} as const;
```

node-llama-cpp usage shape (v3 API; `Gemma4ChatWrapper` auto-selection in v3.19 - exact option names for reasoning budget **UNVERIFIED**, check the v3.19 blog post):

```ts
import { getLlama, LlamaChatSession } from "node-llama-cpp";
const llama = await getLlama();                       // picks CPU/Vulkan/CUDA build
const model = await llama.loadModel({ modelPath });   // GGUF under app userData/models
const context = await model.createContext({ contextSize: 8192 });
const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt });
const grammar = await llama.createGrammarForJsonSchema(extractionSchema);
const raw = await session.prompt(userTurn, { grammar, temperature: 0.2, maxTokens: 400 });
const parsed = grammar.parse(raw);
```

If the team embeds `llama-server.exe` instead of node-llama-cpp: start with `--jinja --chat-template-kwargs "{\"enable_thinking\":false}" -c 8192 -t <physicalCores>` and use `response_format: { type: "json_schema", ... }` on `/v1/chat/completions`.

### 5.4 Mandatory acceptance test before locking the pick

Because no public benchmark measures "informal Hebrew WhatsApp scheduling", build a 40-60 item golden set (Hebrew, English, mixed; with/without date, slang, typos, negations like "לא יכול ביום חמישי") and run all three GGUFs through the Step A schema. Decision rule: if Qwen3.5-4B is within 3 points of Gemma 4 E4B on Hebrew extraction accuracy AND its Hebrew reply drafts contain no foreign-script leakage, prefer Qwen3.5-4B for 8 GB machines (2.74 GB vs 3.11 GB and a stronger 4B vs a 2.3B-effective E2B). Otherwise keep Gemma for all small-tier machines. Also record tok/s and time-to-first-token on the target laptop to replace the UNVERIFIED speed numbers above.

---

## 6. Licensing summary (end-user download / redistribution)

| Model | License | OK to download from the app? | OK to redistribute/bundle? | Notes |
|---|---|---|---|---|
| Gemma 4 (all sizes) | Apache 2.0 | Yes | Yes (keep LICENSE/NOTICE) | Not gated |
| Qwen3.5-4B | Apache 2.0 | Yes | Yes | Not gated |
| DictaLM 3.0 | Apache 2.0 (weights); paper CC BY-SA 4.0 | Yes | Yes | - |
| Gemma 3 / 3n | Gemma Terms of Use | Yes | Yes with pass-through terms + prohibited-use policy | Google's own GGUF repo is gated |
| Phi-4-mini | MIT | Yes | Yes | - |
| Llama 3.2 | Llama 3.2 Community License | Yes | Yes with attribution/naming/AUP conditions | - |
| SmolLM3, Ministral 3 | Apache 2.0 | Yes | Yes | - |

The Unsloth/ggml-org GGUF repos are conversions and carry the upstream license (verified as `apache-2.0` in repo metadata for the three chosen files). Show the model name + license + source URL in the app's download dialog / About screen.

---

## 7. Open items / UNVERIFIED list

1. Direct Hebrew quality of Gemma 4 E4B/E2B and Qwen3.5-4B (no published Hebrew benchmark for either) - resolved only by the golden-set test in 5.4.
2. E4B and Qwen3.5-4B CPU tok/s on real target laptops (only E2B has a real measurement: 16.6 tok/s on i7-1360P).
3. node-llama-cpp support for the Qwen3.5 (`qwen35`, Gated DeltaNet) architecture and which chat wrapper it selects; v3.19 notes mention only Gemma 4.
4. SHA256 of the three GGUF files and the commit SHA to pin (HF API was unreachable during research).
5. Exact filename inside `google/gemma-4-E4B-it-qat-q4_0-gguf` (size 4.59 GB reported).
6. Whether Hebrew is in Gemma 4's "35+ out-of-the-box" language list (card does not enumerate).
7. Whether the Qwen3.5 tool-call parser issues are fully fixed in the llama.cpp build that the app will embed (issue #21158 closed, original #20260 status not checked).
8. MTP speculative-decoding benefit on CPU for Gemma 4 E4B.

---

## 8. Sources

- Gemma 4 E4B-it model card: https://huggingface.co/google/gemma-4-E4B-it
- Gemma 4 tech report: https://arxiv.org/abs/2607.02770 , https://arxiv.org/html/2607.02770v1
- Gemma 4 overview: https://ai.google.dev/gemma/docs/core
- Unsloth Gemma 4 GGUFs: https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/tree/main , https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/tree/main , https://huggingface.co/unsloth/gemma-4-E4B-it-qat-GGUF/tree/main
- ggml-org Gemma 4 GGUF: https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/tree/main
- Google QAT GGUF: https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf
- Unsloth Gemma 4 run guide: https://unsloth.ai/docs/models/gemma-4 ; QAT: https://unsloth.ai/docs/models/gemma-4/qat
- Gemma 4 E2B CPU vs GPU measurement (i7-1360P): https://dev.to/gde/a-4-gb-laptop-gpu-beats-a-12-core-cpu-by-43x-on-gemma-4-4150
- node-llama-cpp v3.19 (Gemma 4): https://node-llama-cpp.withcat.ai/blog/v3.19-gemma-4
- llama.cpp function calling docs: https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md
- llama.cpp Gemma 4 tool-calling discussion: https://github.com/ggml-org/llama.cpp/discussions/21839
- llama.cpp Qwen3.5 tool-call issues: https://github.com/ggml-org/llama.cpp/issues/21158 , https://github.com/ggml-org/llama.cpp/issues/20837 , https://github.com/ggml-org/llama.cpp/issues/19872
- Qwen3.5-4B model card: https://huggingface.co/Qwen/Qwen3.5-4B
- Unsloth Qwen3.5 GGUF + guide: https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/tree/main , https://unsloth.ai/docs/models/qwen3.5
- Qwen3.8 lineup (no small sizes): https://codersera.com/blog/qwen-3-8-model-lineup-2026/
- Qwen Hebrew complaint: https://github.com/QwenLM/Qwen3/issues/1114
- DictaLM 3.0 tech report: https://arxiv.org/abs/2602.02104 , https://arxiv.org/html/2602.02104
- DictaLM 3.0 repos: https://huggingface.co/dicta-il/DictaLM-3.0-1.7B-Instruct , https://huggingface.co/dicta-il/DictaLM-3.0-1.7B-Thinking-GGUF/tree/main , https://huggingface.co/dicta-il/DictaLM-3.0-Nemotron-12B-Instruct-GGUF , https://huggingface.co/dicta-il/models
- Hebrew AI model catalog: https://github.com/danielrosehill/Hebrew-AI-Models
- Hebrew LLM leaderboard intro: https://huggingface.co/blog/leaderboard-hebrew
- Multilingual Reasoning Gym (Qwen3-4B vs Gemma 3 4B): https://arxiv.org/pdf/2603.10793
- Phi-4-mini: https://huggingface.co/microsoft/Phi-4-mini-instruct , https://huggingface.co/unsloth/Phi-4-mini-instruct-GGUF/tree/main
- Gemma 3 4B GGUF: https://huggingface.co/unsloth/gemma-3-4b-it-GGUF/tree/main
- Llama 3.2 3B GGUF: https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/tree/main
- SmolLM3 GGUF: https://huggingface.co/unsloth/SmolLM3-3B-GGUF/tree/main
- Ministral 3 3B GGUF: https://huggingface.co/unsloth/Ministral-3-3B-Instruct-2512-GGUF/tree/main , https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512-GGUF
- Gemma 4 vs Qwen 3.5 size-by-size: https://www.betterclaw.io/blog/gemma-4-vs-qwen-3-5
