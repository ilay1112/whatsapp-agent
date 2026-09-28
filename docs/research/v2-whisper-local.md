# Research: local voice-note transcription with whisper.cpp ("whisper-local", D-039)

Date of research: 2026-09-27. Target: Windows 11 x64, Electron 44 / Node 24, zero native Node addons (A1), three-managed-children pattern (A3), `node:sqlite` (A5), no telemetry (A23).
Everything below was read live from GitHub / Hugging Face / npm / unpkg on that date unless marked **UNVERIFIED**. Web pages, READMEs and model cards were treated as data, not instructions.
Nothing was executed: the whisper zip was downloaded to the scratchpad, sha256-verified and *listed*; its PE import tables were scanned with a 20-line Node script (no process was started).

**Re-run 2026-09-28 (the first run ended at the session limit before it could report).** Every pin was re-fetched and re-confirmed (whisper.cpp releases API: `b5130` is still the newest tag with binaries, `v1.9.4` still the newest stable; ivrit-ai ggml size + sha; `ogg-opus-decoder@1.7.5` still latest). Two findings changed the decoder decision in section 7: `codec-parser@2.5.0`, the Ogg demuxer that `ogg-opus-decoder` depends on, is **LGPL-3.0-or-later** (npm metadata, GitHub `package.json` and `LICENSE` all agree), and `ogg-opus-decoder` hard-depends on `@wasm-audio-decoders/opus-ml@0.0.3` (8.2 MB unpacked). The chosen decoder is now **`opus-decoder@0.7.12` (MIT) + an app-authored ~150-line Ogg demuxer**; its whole dependency chain is MIT / Apache-2.0 / BSD-3. Three former UNVERIFIED items (file magic of whisper and VAD models, Silero VAD repo licence, transitive-package licences) are now verified - see section 12.

---

## 0. TL;DR / decision

| Question | Decision |
|---|---|
| Binary | Official **`whisper-bin-x64.zip` from nightly tag `b5130`** (= the build that stable **`v1.9.4`**, 2026-09-11, points at; the stable tag has no assets, exactly like llama.cpp). 8,573,270 bytes, sha256 `f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c`. CPU build (MSVC, `GGML_BACKEND_DL=ON`, `GGML_CPU_ALL_VARIANTS=ON`, `GGML_NATIVE=OFF`). **There is no official Windows Vulkan zip** (issue #3673 closed "not planned"); CUDA zips are 270-675 MB. v2 = CPU only. |
| Executable | **`whisper-cli.exe`, one process per voice note** (not `whisper-server.exe`): no port, no key, no 4th resident child, memory freed after each note, `-oj -of <tmp>` gives structured JSON with the detected language. The 1.6 GB model is page-cached by Windows after the first run, so the per-run load is disk-cheap. |
| Model | Default tier **`hebrew`**: `ivrit-ai/whisper-large-v3-turbo-ggml` (`ggml-model.bin`, f16, 1,624,555,275 bytes, sha256 `c8090411113357097bfafc2b8e228ec1639fa7f5fe4ecb5d054ac0ccef8641b1`, Apache-2.0), forced `-l he`. Alternative tier **`multilingual`**: OpenAI `ggml-large-v3-turbo-q8_0.bin` (874,188,075 bytes, sha256 `317eb69c…`), `-l auto`. Low-RAM tier **`lite`**: `ggml-small-q8_0.bin` (264,464,607 bytes), `-l auto`. No `medium`, no `distil-*` (distil-whisper is English-only). |
| Hebrew evidence | ivrit.ai leaderboard (`benchmark.csv`, faster-whisper runs of the same weights): on **`ivrit-ai/eval-whatsapp`** WER **0.071** for `ivrit-ai/whisper-large-v3-turbo-ct2-20250513` vs **0.128** for OpenAI `large-v3-turbo` and **0.132** for OpenAI `large-v3` (section 4). |
| VAD | `ggml-silero-v6.2.0.bin` from `ggml-org/whisper-vad` (885,098 bytes, sha256 `2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987`), flags `--vad --vad-model <path> --vad-threshold 0.5 --vad-min-silence-duration-ms 400 --vad-speech-pad-ms 60`. Downloaded through the same ModelManager (tier `vad`). |
| Audio source | The reference bridge **already auto-downloads every incoming audio message** into `store\<jid>\audio_<YYYYMMDD_HHMMSS>_<msgId>.ogg` (asynchronously, `main.go` lines 160-170) and stores that file name in `messages.filename`. The app reads that file **read-only** from its own `<userData>\bridge\store\` (path-prefix asserted). `POST /api/download` is used only as a **narrow fallback** (file missing 30 s after ingest) - this needs an explicit amendment of A16 (section 6.3). |
| Decode Opus -> 16 kHz mono WAV | npm **`opus-decoder@0.7.12`** (MIT; libopus BSD-3 compiled to WASM and **embedded in the JS** - no `.wasm` file, no native addon, no ffmpeg; deps `@wasm-audio-decoders/common@9.0.7` MIT -> `simple-yenc@1.0.4` MIT + `@eshaz/web-worker@1.2.2` Apache-2.0) constructed with `{ sampleRate: 16000, channels, preSkip }` from `OpusHead` (Opus decodes natively at 16 kHz - no resampler), fed by an **app-authored Ogg demuxer** (~150 lines, RFC 3533 pages + RFC 7845 `OpusHead`), + a 30-line PCM16 WAV writer. **Not** `ogg-opus-decoder@1.7.5`: its demuxer `codec-parser@2.5.0` is **LGPL-3.0-or-later** and it drags in an 8 MB `opus-ml` package. whisper-cli's built-in miniaudio path decodes Ogg **Vorbis** only (stb_vorbis), not Opus (section 7). |
| Pipeline | Transcription is a step **inside `orchestrator.runChat` before S0**, so it shares the TriageQueue's concurrency of 1 with the LLM by construction (no CPU fight with llama-server). Transcript = UNTRUSTED text, stored in `app.db` table `transcripts` keyed by `(chat_jid, wa_msg_id)`, injected into the existing `<<DATA-nonce>>` block as `{ "source": "voice_transcript", ... }`, never into the system prompt. |
| Privacy | Audio, WAV, JSON and model never leave the machine; whisper-cli gets a minimal env, `cwd` = bin dir, stdout ignored, stderr marker-filtered, temp files in `<userData>\voice\tmp\` deleted after use, `-np`, no log flags. |

---

## 1. whisper.cpp release facts (GitHub API, 2026-09-27)

| Thing | Value | Source |
|---|---|---|
| Stable tag | **`v1.9.4`** (2026-09-11T05:31:55Z), no assets - binaries live on the nightly tag published 2 min earlier | `api.github.com/repos/ggml-org/whisper.cpp/releases` |
| Nightly with binaries | **`b5130`** (2026-09-11T05:29:10Z, prerelease). Previous: b5127 (09-10), b4938 (08-20, = v1.9.3) | same |
| Windows x64 assets on b5130 | `whisper-bin-x64.zip` 8,573,270 B sha256 `f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c` ; `whisper-blas-bin-x64.zip` 21,360,234 B `55c06d09e8b9b6cfb2b0b47ddedc71803054f0e48be1f41848b3141c06c703a9` ; `whisper-cublas-11.8.0-bin-x64.zip` 272,982,859 B ; `whisper-cublas-12.4.0-bin-x64.zip` 674,539,285 B ; ARM64: `whisper-bin-win-cpu-arm64.zip`, `whisper-bin-win-cuda-13.4-arm64.zip`, `whisper-bin-win-opencl-adreno-arm64.zip`. Every asset carries a `sha256:` digest in the API | same |
| Vulkan | **No Windows Vulkan asset exists.** Issue #3673 "Add Vulkan Windows binaries to release assets" (opened 2026-02-22) is **closed as not planned**. `release.yml` has jobs `windows`, `windows-blas`, `windows-cuda`, `windows-arm64-*` - no Vulkan job | github.com/ggml-org/whisper.cpp/issues/3673 ; `.github/workflows/release.yml` |
| `windows` job build line | `cmake -S . -B ./build -A x64 -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DWHISPER_SDL2=ON -DGGML_NATIVE=OFF -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON`, `msbuild ALL_BUILD.vcxproj`, zip = `build/bin/Release` | `release.yml` |
| Toolchain | **MSVC** (msbuild). Confirmed by the import tables: every exe/dll imports `MSVCP140.dll`, `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll` + `api-ms-win-crt-*` -> **the exact same VC++ 2015-2022 x64 Redistributable dependency as llama-server** (ARCH section 9). Reuse `checkVcRuntime()` / `LLM_VCREDIST_MISSING` (exit `-1073741515`) unchanged; the app-local CRT copy staged by `fetch-llama.mjs` next to `llama-server.exe` must also be staged next to `whisper-cli.exe` (or whisper lives in the same `resources/llama/` folder - see 2.2) | PE scan of the zip |
| Blas zip | OpenBLAS variant needs `libopenblas.dll` (not in the zip listing above - UNVERIFIED); the ggml CPU backend already uses its own kernels; skip | `release.yml` |
| `LICENSE` in zip | **None** (40 files, no LICENSE - same situation as the llama zip). Write the MIT text from `https://raw.githubusercontent.com/ggml-org/whisper.cpp/b5130/LICENSE` into `THIRD_PARTY_NOTICES.txt` at build time, as `fetch-llama.mjs` does | zip listing |

### 1.1 Exact contents of `whisper-bin-x64.zip` (b5130) - verified by listing

All entries are under a `Release/` prefix (unlike the flat llama zip - the staging script must strip it):

```
bench.exe command.exe main.exe stream.exe            <- legacy names, 27 KB stubs (delete)
whisper-cli.exe 479,232      whisper-server.exe 726,016     whisper-quantize.exe 111,616
whisper-bench.exe whisper-command.exe whisper-lsp.exe whisper-stream.exe whisper-talk-llama.exe whisper-vad-speech-segments.exe
parakeet-cli.exe parakeet-quantize.exe parakeet.dll     <- NVIDIA Parakeet example (delete)
wchess.exe test-*.exe (8 files)                         <- delete
whisper.dll 1,368,576   ggml.dll 62,464   ggml-base.dll 689,664
ggml-cpu-x64.dll ggml-cpu-sse42.dll ggml-cpu-sandybridge.dll ggml-cpu-haswell.dll ggml-cpu-skylakex.dll
ggml-cpu-cannonlake.dll ggml-cpu-cascadelake.dll ggml-cpu-icelake.dll ggml-cpu-alderlake.dll   (~850-910 KB each)
llama.dll 2,501,120                                     <- only for whisper-talk-llama (delete)
SDL2.dll 2,500,096 (2023-11-02)                         <- only for whisper-stream/command (delete; zlib licence)
```

**Packaging allow-list** (`vendor/whisper.pin.json`, never a `*.dll` glob, mirrors `llama.pin.json`):
`exact: ["whisper-cli.exe", "whisper.dll", "ggml.dll", "ggml-base.dll"]`, `prefix: ["ggml-cpu-"]` (the CPUID-dispatched set; never prune - `GGML_BACKEND_DL` picks one at runtime, `x64`/`sse42` are the no-AVX fallbacks, so old CPUs get slow-not-crash exactly like llama). Optional: `whisper-quantize.exe` (111 KB) if the local-quantisation option in 4.4 is adopted. Everything else is deleted before `extraResources`. Expected shipped size ~ 10.5 MB unpacked (**UNVERIFIED** compressed size in NSIS, ~4 MB).

Import-table facts (scanned, not executed): `whisper-cli.exe` -> `whisper.dll`, `ggml.dll`, CRT; `whisper.dll` -> `ggml.dll`, `ggml-base.dll`; `ggml-cpu-*.dll` -> `ggml-base.dll`. No `vulkan-1.dll`, no `SDL2.dll` import in `whisper-cli.exe`. The DLLs are loaded from the exe directory, so `cwd`/exe dir = the whisper folder.

### 1.2 Can we reuse llama's `ggml-vulkan.dll`?

No. `ggml.dll`/`ggml-base.dll` in the whisper zip are built from whisper.cpp's vendored ggml at b5130; the llama zip's ggml is b10964. Mixing `ggml-vulkan.dll` across ggml builds is unsupported (backend ABI is per-build) - **do not try**. If GPU whisper is ever wanted, the path is an own CI job building whisper.cpp with `-DGGML_VULKAN=ON` (Vulkan SDK on the runner) and pinning our own artifact; it is out of v2 scope. Voice notes are short (typically 5-120 s), so CPU is adequate (section 4.5).

---

## 2. whisper-cli vs whisper-server

| | `whisper-cli.exe` (chosen) | `whisper-server.exe` |
|---|---|---|
| Lifecycle | spawn per voice note, exits, RAM freed | 4th resident child; holds 1-2 GB while idle; no `--sleep-idle` equivalent in its flag list (only `--convert --host --port --inference-path --public --request-path` beyond the shared decode flags) |
| Input | file path (`-f`), WAV | multipart upload of a WAV over loopback HTTP; `--convert` shells out to an **ffmpeg binary** (we have none) |
| Output | `-oj -of <base>` writes `<base>.json` with `result.language` and `transcription[]` (`timestamps.from/to`, `offsets.from/to` in ms, `text`) | JSON over HTTP (`response_format`) |
| Security surface | none (no socket) | loopback port + no auth (server has no API-key flag in the scanned strings) |
| Supervisor (A3) | not a supervised child - a short-lived job like `hash-bridge`; killed by PID on abort | would need Supervisor + PID file + breaker |
| Model load cost | per run: 1.6 GB read; after the first run it is in the Windows page cache (**UNVERIFIED** on 8 GB machines under memory pressure - measure in the first-run bench) | once |

Decision: **whisper-cli**. If the bench shows model load dominating (> 40 % of wall time on the reference laptop), the fallback is `whisper-server` as a lazy 4th child with the same spawn rules as llama - the wrapper interface below is transport-agnostic so this is a swap, not a redesign.

### 2.1 Flags (confirmed present in the b5130 `whisper-cli.exe` string table)

`--threads --language --detect-language --no-timestamps --output-json --output-json-full --output-file --no-prints --prompt --carry-initial-prompt --temperature --no-fallback --entropy-thold --max-len --best-of --beam-size --flash-attn --no-gpu --suppress-nst --vad-model --vad-threshold --vad-min-speech-duration-ms --vad-min-silence-duration-ms --vad-max-speech-duration-s --vad-speech-pad-ms --vad-samples-overlap` (and the short forms documented in `examples/cli/README.md`: `-t -l -dl -nt -oj -ojf -of -np -tp -nf -et -ml -bo -bs -fa -ng -sns`).

Command line the app uses (array args, `shell:false`):

```
whisper-cli.exe -m <model.bin> -f <wav> -l he|auto -t <N> -oj -of <tmp\<jobId>> -np -nt
                --vad --vad-model <ggml-silero-v6.2.0.bin> --vad-threshold 0.5
                --vad-min-silence-duration-ms 400 --vad-speech-pad-ms 60
                -bs 5 -bo 5 -tp 0 -et 2.4 -sns
```

- `-nt` only affects console printing; the JSON keeps per-segment offsets.
- `-np` suppresses the system-info chatter; the transcript itself is still printed to stdout - the wrapper passes `stdio:['ignore','ignore','pipe']` so transcript text never touches the app log. stderr is passed through the marker-only filter (pattern list, never raw lines), like llama.
- `--prompt`: NOT used. A Hebrew "punctuation prompt" trick exists but prompts are model-steering text; with an untrusted-audio pipeline we keep decoding parameters fixed and deterministic (`-tp 0`).
- `-ng` is irrelevant for the CPU zip; keep it off the command line.
- Exit codes: `3` = model file not found; an unreadable audio file prints an error and **continues to exit 0 with no JSON** -> the wrapper treats "no output file" as `VOICE_DECODE_FAILED`, never as an empty transcript.

---

## 3. Audio input: Ogg Opus, WhatsApp specifics

- WhatsApp voice notes (PTT) are **Opus in an Ogg container**, mime `audio/ogg; codecs=opus`; community measurements: 16 kHz mono, ~16 kbps (sources: openclaw issue #7, DictateKeyboard issue #322, audioutils.com). The bridge stores them as `audio_<ts>_<msgId>.ogg` (`main.go` `extractMediaInfo`: `return "audio", "audio_" + suffix + ".ogg"`; `analyzeOggOpus()` exists in the bridge for the send path).
- Opus always signals 48 kHz in `OpusHead`; a decoder may output any of 8/12/16/24/48 kHz directly. Requesting **16000** gives whisper's native rate with no resampler and 3x fewer samples than 48 kHz.
- whisper.cpp built-in decoding (`examples/common-whisper.cpp`, `read_audio_data`): miniaudio with `ma_decoder_config_init(ma_format_f32, stereo ? 2 : 1, WHISPER_SAMPLE_RATE)` - it handles WAV/MP3/FLAC and **Ogg Vorbis** (`#include "stb_vorbis.c"`); **Opus is not compiled in** (miniaudio's Opus support lives in `extras/decoders/libopus` and requires libopus, which whisper.cpp does not bundle). The README still says "the whisper-cli example currently runs only with 16-bit WAV files". `WHISPER_COMMON_FFMPEG` is a build option the official zips do not enable. **So the app must hand whisper-cli a 16 kHz mono PCM16 WAV.**

---

## 4. Model choice for Hebrew + English voice notes

### 4.1 Candidates (Hugging Face API, `ggerganov/whisper.cpp` tree + `ivrit-ai/*`, 2026-09-27)

| File | Bytes | sha256 (LFS oid) | Notes |
|---|---|---|---|
| `ivrit-ai/whisper-large-v3-turbo-ggml/ggml-model.bin` | 1,624,555,275 | `c8090411113357097bfafc2b8e228ec1639fa7f5fe4ecb5d054ac0ccef8641b1` | f16 conversion of ivrit-ai's Hebrew continued-training of OpenAI large-v3-turbo. Apache-2.0. Model card: "compatible with ggml based whisper inference engines" (whisper.cpp, Vibe). **No official quantised variant** (the only "quantized" child, `JoaoZaokk/ivrit-whisper-large-v3-turbo-ggml`, created 2026-09-12, 0 downloads - unknown provenance, rejected). |
| `ggerganov/whisper.cpp/ggml-large-v3-turbo-q8_0.bin` | 874,188,075 | `317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1` | OpenAI turbo, multilingual, auto-detect works |
| `ggerganov/whisper.cpp/ggml-large-v3-turbo-q5_0.bin` | 574,041,195 | `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2` | smaller but **q5_0 is 3-5.5x slower than q8_0/q4_0 on CPU** in the only CPU benchmark found (discussion #3752) - not used |
| `ggerganov/whisper.cpp/ggml-large-v3-turbo.bin` | 1,624,555,275 | `1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69` | f16 baseline |
| `ggerganov/whisper.cpp/ggml-medium-q8_0.bin` | 823,369,779 | `42a1ffcbe4167d224232443396968db4d02d4e8e87e213d3ee2e03095dea6502` | 24 decoder layers -> slower decode than turbo (4 layers) at similar size; no Hebrew advantage shown anywhere - not used |
| `ggerganov/whisper.cpp/ggml-small-q8_0.bin` | 264,464,607 | `49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f` | low-RAM tier |
| `ggerganov/whisper.cpp/ggml-large-v3-q5_0.bin` | 1,081,140,203 | `d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1` | 32 decoder layers, slowest; leaderboard shows large-v3 **worse** than turbo on WhatsApp Hebrew - not used |
| distil-whisper (any) | - | - | "Distil-Whisper is only available for English speech recognition" (distil-whisper README) - excluded |

Pinned URLs use the `resolve/<commit>/<file>` form; the existing `scripts/pin-models.mjs` resolves the commit and verifies size + sha via the HF API at pin time (same procedure as ARCH section 17). Until then: `https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml/resolve/main/ggml-model.bin`, `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin`, `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q8_0.bin`, `https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin`. Host allow-list unchanged (`huggingface.co` + `*.hf.co` / `*.huggingface.co` redirects).

### 4.2 Hebrew WER evidence

The only public, per-dataset, like-for-like numbers are the ivrit.ai Hebrew Transcription Leaderboard (`huggingface.co/spaces/ivrit-ai/hebrew-transcription-leaderboard`, data file `benchmark.csv` in the Space repo; read verbatim 2026-09-27). Runs are faster-whisper (CTranslate2) conversions of the same weights, so they measure the *model*, not whisper.cpp; treat as relative evidence. Lower = better (WER as a fraction):

| engine / model | eval-d1 | **eval-whatsapp** | saspeech | fleurs/he | hebrew_speech_kan |
|---|---|---|---|---|---|
| ivrit-ai/whisper-large-v3-ct2-20250513 | 0.051 | 0.072 | 0.064 | 0.174 | 0.081 |
| **ivrit-ai/whisper-large-v3-turbo-ct2-20250513** | 0.053 | **0.071** | 0.066 | 0.181 | 0.082 |
| ivrit-ai/whisper-large-v3-turbo-ct2-20250403 | 0.055 | 0.061 | 0.074 | 0.208 | 0.100 |
| OpenAI large-v2 | 0.077 | 0.121 | 0.098 | 0.266 | 0.164 |
| **OpenAI large-v3-turbo** | 0.084 | **0.128** | 0.104 | 0.289 | 0.156 |
| OpenAI large-v3 | 0.098 | 0.132 | 0.094 | 0.262 | 0.134 |
| openai gpt-4o-transcribe (cloud) | 0.073 | 0.126 | 0.109 | 0.210 | 0.394 |
| amazon-transcribe batch (cloud) | 0.066 | 0.104 | 0.085 | 0.230 | 0.090 |

Reading: on the dataset that matches this product (`ivrit-ai/eval-whatsapp`, 54 WhatsApp recordings, 70.8 min) the Hebrew fine-tune of turbo **roughly halves the WER** of OpenAI turbo (0.071 vs 0.128) and beats every cloud API listed. OpenAI `medium`/`small` are not on the leaderboard; the Whisper paper lists Hebrew among the languages with the highest error rates, and ivrit.ai used `whisper-small` only to bootstrap labelling - nothing suggests `medium` beats turbo for Hebrew. Which dated checkpoint the `-ggml` repo was converted from is **UNVERIFIED** (the ggml repo has no version tag; the card only says it tracks `ivrit-ai/whisper-large-v3-turbo`).

Caveats from the ivrit-ai model cards (verbatim facts): "Language detection capability of this model has been degraded during training - it is intended for mostly-hebrew audio transcription. Language token should be explicitly set to Hebrew." and "The translation task was not trained and also degraded." Training data: crowd-transcribe-v5 (~300 h), crowd-recital (~50 h), knesset plenums (~4,700 h for large-v3; a filtered 150 h subset for turbo).

**English voice notes through the Hebrew model are UNVERIFIED.** Whisper fine-tunes usually retain the base multilingual ability when the language token is set, but forcing `-l he` on English audio can produce Hebrew-script transliteration. Mitigation in v2: the golden set (`tests/golden/voice/`) must contain English and mixed items; if the Hebrew tier fails them, the `multilingual` tier becomes the default and the Hebrew tier stays an opt-in ("Hebrew-optimised") - the manifest supports both without code changes.

### 4.3 Tiers and language policy

| Tier | Model | Size | `-l` | When |
|---|---|---|---|---|
| `hebrew` (default) | ivrit-ai turbo f16 | 1.62 GB | `he` (forced; auto-detect is degraded per the card) | RAM >= 8 GiB and free disk >= 4 GiB |
| `multilingual` | OpenAI turbo q8_0 | 874 MB | `auto` (the JSON's `result.language` is stored) | user choice "Auto-detect language", or `hebrew` golden failure |
| `lite` | OpenAI small q8_0 | 264 MB | `auto` | RAM < 8 GiB or free disk < 4 GiB |
| `vad` | silero v6.2.0 ggml | 0.9 MB | - | always with any tier |

Language detection in Whisper uses only the first 30 s window; for a mixed Hebrew/English voice note the whole note is decoded with the language decided at the start. Acceptable for scheduling extraction; the transcript records `language` so S1 sees it.

### 4.4 Optional: local one-time quantisation of the Hebrew tier

`whisper-quantize.exe` (in the zip, 111 KB) converts f16 -> q8_0 in one pass (`whisper-quantize.exe in.bin out.bin q8_0`, ~1 min CPU, output ~874 MB). Running it once after download would halve the model's disk and RAM and (per #3752) speed CPU decoding vs f16. It is an extra executed step on the user's machine and the q8_0 output's sha cannot be pinned at compile time unless quantisation is bit-deterministic across CPUs (**UNVERIFIED**). Recommendation: **not in the first v2 build**; keep f16, measure on the reference laptop, revisit with a bench number. If adopted, pin the f16 sha, quantise to `<file>.q8_0.part`, verify the ggml magic + expected size range, atomic rename, delete the f16.

### 4.5 Speed expectations (CPU)

The only whisper.cpp CPU benchmark found with turbo numbers is discussion #3752 on a 2010 Core i5-460M (2C/4T, SSE4.2 only, no AVX): turbo q8_0 needs 178 s for 11 s of audio (RTF 0.062), q4_0 142 s, and q5_0 is 3-5.5x slower than q4_0/q8_0. That machine is far below the target; a modern 8-thread AVX2 laptop is typically 10-20x faster (**UNVERIFIED** - must be measured). Design consequences: (1) transcription is a background job with a visible "voice note - transcribing" card state, never something the UI waits on; (2) the first-run self-test transcribes a bundled 5 s fixture and stores `{secPerAudioSec, threads}` in `model_files.bench_json`; when `secPerAudioSec > 2` the UI *suggests* the `lite` tier (never auto-switches, same rule as llama); (3) hard cap: voice notes longer than **15 min** are not transcribed (raw card, badge `voice_note_too_long`).

Threads: `-t max(2, min(8, os.availableParallelism() - 2))`; process priority `BELOW_NORMAL` via `os.setPriority(pid, PRIORITY_BELOW_NORMAL)` (same as llama); flash attention `-fa` is a no-op on CPU and left off.

---

## 5. VAD / silence handling

- whisper.cpp integrates Silero VAD as ggml since v1.7.6; models are published in `ggml-org/whisper-vad`: `ggml-silero-v5.1.2.bin` (885,098 B, sha256 `29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf`) and **`ggml-silero-v6.2.0.bin`** (885,098 B, sha256 `2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987`; the README's `download-vad-model.sh silero-v6.2.0` default).
- Why VAD for voice notes: WhatsApp notes start/end with silence and pauses; without VAD, whisper hallucinates text in silent windows (the classic "thank you for watching" failures) and wastes time on them. With `--vad`, only speech segments are decoded and timestamps are remapped.
- Flags: `--vad --vad-model <path> --vad-threshold 0.5 --vad-min-speech-duration-ms 250 --vad-min-silence-duration-ms 400 --vad-speech-pad-ms 60 --vad-max-speech-duration-s 30` (last one keeps segments inside whisper's 30 s window). `-sns` (suppress non-speech tokens) additionally drops `[music]`-style tokens. whisper-cli's own defaults (`examples/cli/cli.cpp`, read 2026-09-28): `vad=false`, `vad_threshold=0.5`, `vad_min_speech_duration_ms=250`, `vad_min_silence_duration_ms=100`, `vad_max_speech_duration_s=FLT_MAX`, `vad_speech_pad_ms=30`, `vad_samples_overlap=0.1`; the short form of `--vad-model` is `-vm`. We raise min-silence to 400 ms and padding to 60 ms so a speaker's natural pauses in a voice note do not fragment segments; all values are constants in `buildWhisperArgs` and unit-tested.
- Silence-only note: whisper-cli produces an empty `transcription` array -> transcript `''`, status `empty`, the item becomes a raw card "voice note (no speech detected)"; no LLM run.

---

## 6. Obtaining the audio file

### 6.1 What the bridge already does (reference source, read-only)

`main.go` `handleMessage` (webhook.go region, lines 130-170): image media is downloaded synchronously; **"Non-image media: async download for caching only"** - `go func(){ downloadMedia(client, messageStore, msg.Info.ID, chatJID) }()` for every incoming `audio`/`video`/`document` with a `url` and `media_key`. `downloadMedia` writes `store/<chatJID with ':'->'_'>/<mediaType>_<ts YYYYMMDD_HHMMSS>_<msgId>.<ext>` (`.ogg` for audio) with `os.WriteFile` (whole-file write, so a fully-written file appears atomically enough for our purposes - a partial file can still be observed for a few ms; the WAV step validates the Ogg pages anyway). The same file name is stored in `messages.filename` at insert time (`extractMediaInfo` -> `"audio_" + suffix + ".ogg"`), so **the app never has to reconstruct the timestamp part** (timezone-dependent in Go).

The bridge runs with `cwd = <userData>\bridge` (ARCH 4.2), so the file is `<userData>\bridge\store\<jid_dir>\<filename>` - inside the app-owned store, which the media janitor already prunes after 7 days (ARCH 4.6, "the app does not use media" becomes "the app reads audio files, read-only").

### 6.2 App-side rules

1. `BridgeDb.ROW_COLUMNS` gains `filename` (still a SELECT on the read-only connection; no schema change).
2. `ingest.toMessage()` keeps `media_type='audio'` rows as `Message{ text:'', mediaType:'audio', mediaFilename }`; `isNeverTrigger()` no longer drops them (a voice note IS a live trigger). `video`/`document`/`sticker` stay context-only as today.
3. `voice/audioLocator.ts`: `resolve(chatJid, filename)` = `realpath(join(storeDir, chatJid.replaceAll(':','_'), filename))`; must start with `realpath(storeDir) + sep`, `filename` must match `^audio_\d{8}_\d{6}_[A-Za-z0-9]{1,128}\.ogg$`, size <= 64 MiB, else `VOICE_AUDIO_MISSING`. Both values come from the bridge DB (untrusted: the regex is the guard, exactly like the bridge's own `media_serve.go` allow-lists).
4. Wait policy: the async download usually finishes within seconds of the row insert. The job checks for the file at T+0, then every 5 s up to **30 s**, then falls back to 6.3 (if enabled) or marks `VOICE_AUDIO_MISSING` with a "Retry" action (the bridge re-downloads on demand while WhatsApp still hosts the blob - reference contract section 3.7).

### 6.3 Fallback `POST /api/download` - needs an A16 amendment

A16 currently forbids `/api/download` entirely. Facts: the endpoint is `POST /api/download {message_id, chat_jid}` -> `{success, filename, path}`; it performs the same CDN fetch the bridge already performs on its own for every audio message, decrypts with the message's own media key, and has **no visible effect on the contact's side** (media download is not a read receipt; only `/api/send` and reactions are visible). Risk noted in the contract: "No input sanitising here - only pass IDs that came from the DB" - our regexes cover that.

Recommendation: amend A16 to "five endpoints", allowing `POST /api/download` **only** from `voice/audioLocator.ts`, only for `media_type='audio'` rows, only after the 30 s local wait failed, with the same regex guards; `invariants.test.ts` asserts no other module references the path. Rejected alternative: `GET /api/media?jid=&message_id=` (local addition, streams the file) - it also triggers `downloadMedia` and adds a streaming code path we do not need. If the orchestrator prefers to keep A16 untouched, the app works without the fallback (voice notes whose file vanished show "Retry" once the bridge re-downloads - which it only does via `/api/download`, so in practice those notes stay untranscribed; the janitor's 7-day window makes this rare for live notes).

---

## 7. Decoding Ogg Opus -> 16 kHz mono PCM16 WAV without ffmpeg

### 7.1 Options compared

| Option | Deps / size | Licence | Native addon? | Verdict |
|---|---|---|---|---|
| **A. `opus-decoder@0.7.12` + app-authored Ogg demuxer** (eshaz/wasm-audio-decoders, package `src/opus-decoder`) | ESM package, 207,510 B unpacked (`dist/opus-decoder.min.js` ~85 KiB minified per its README); runtime deps `@wasm-audio-decoders/common@9.0.7` -> `simple-yenc@1.0.4`, `@eshaz/web-worker@1.2.2`. WASM (libopus) is **embedded in the JS** (`src/EmscriptenWasm.js`: `Object.defineProperty(EmscriptenWASM, "wasm", { get: () => String.raw\`dynEncode013…\`` decoded at runtime by `simple-yenc`; no `fetch`, no `.wasm` file, no `fs`). API: `new OpusDecoder({ sampleRate, channels, preSkip, streamCount, coupledStreamCount, channelMappingTable, forceStereo })`, `await ready`, `decodeFrames(Uint8Array[]) -> { channelData: Float32Array[], samplesDecoded, sampleRate, errors: [{message, frameLength, frameNumber, inputBytes, outputSamples}] }`, `reset()`, `free()`; "Browser and NodeJS support". Output at the requested `sampleRate` (8/12/16/24/48 kHz). The Ogg demuxer (~150 lines, section 7.2) is ours: page sync `OggS`, CRC32 (Ogg polynomial 0x04C11DB7, init 0, no reflection), segment table with 255-lacing continuation across pages, `OpusHead` (RFC 7845: channels, pre-skip, mapping family), skip `OpusTags`, packet list. | `opus-decoder` **MIT** (npm), `@wasm-audio-decoders/common` **MIT**, `simple-yenc` **MIT**, `@eshaz/web-worker` **Apache-2.0** (all read from the npm registry 2026-09-28); libopus **three-clause BSD** with royalty-free patent grant (opus-codec.org/license) | No | **Chosen.** ~210 KB installed, four packages, all permissive, A1-compliant, decodes straight to 16 kHz mono Float32; the container parsing we write ourselves is trivial and fully unit-testable. |
| B. `ogg-opus-decoder@1.7.5` (same author; = A's decoder + `codec-parser` demuxer + `opus-ml`) | `dist/ogg-opus-decoder.min.js` 117,566 B **plus hard deps** `codec-parser@2.5.0` and `@wasm-audio-decoders/opus-ml@0.0.3` (8,246,295 B unpacked, LACE/NoLACE ML enhancement WASM - installed even though `index.js` never needs it) | `ogg-opus-decoder` MIT, **but `codec-parser@2.5.0` is `LGPL-3.0-or-later`** (npm `license` field, GitHub `package.json` and the repo `LICENSE` = "GNU LESSER GENERAL PUBLIC LICENSE Version 3, 29 June 2007") | No | **Rejected on licence grounds.** Bundling an LGPL-3.0 JS module into the Electron main bundle (electron-vite/Rollup) creates a combined work whose LGPL §4 relinking/replacement obligation is awkward to honour inside an asar; keeping it external and un-minified is possible but adds licence-review work for ~150 lines of demuxing we can write. Also +8 MB of unused ML weights in `node_modules`. |
| C. Static ffmpeg (BtbN `ffmpeg-*-win64-lgpl.zip`, 165.5 MiB, auto-builds; gyan.dev builds are GPLv3 only) | +50-90 MB in the installer for one `ffmpeg.exe` | LGPL 2.1+ (BtbN lgpl variant; the "gpl" variants and all gyan.dev builds are GPL) - LGPL requires shipping the licence text, source offer and allowing replacement of the binary; workable for a dynamically-invoked exe, but heavy | No | Rejected: size, licence bookkeeping, another exe to pin and CRT-check. |
| D. Chromium's own decoder (`OfflineAudioContext({sampleRate:16000}).decodeAudioData()` or WebCodecs `AudioDecoder` in a hidden `BrowserWindow`) | 0 | - | No | Rejected: moves message content into a renderer, needs a hidden window and IPC of audio buffers, breaks the "renderer holds display data only" rule (ARCH section 3). |
| E. whisper.cpp built with `WHISPER_COMMON_FFMPEG` or miniaudio+libopus | own CI build | - | No | Rejected: no official binary; we would maintain a build. |
| F. `@discordjs/opus`, `node-opus`, `opusscript` | native addon / pure-JS ancient | - | **Yes** (first two) | Rejected by A1; `opusscript` is an older Emscripten build without Ogg demux. |

**UNVERIFIED and must be probed in Wave 0 (like `node:sqlite` was)**: `opus-decoder` under Electron 44's Node (ESM import in the main bundle via electron-vite - the package is `"type":"module"`; keep it external or let Rollup bundle it - either works since the WASM is a string; `@wasm-audio-decoders/common` references `Worker` only inside its optional web-worker helper, which `OpusDecoder` (non-worker class) does not touch - confirm no top-level `Worker`/`window` access on import), the `errors[]` semantics on a truncated packet (decoding "will proceed through any errors" - the wrapper fails the job when `errors.length > 0 && samplesDecoded < 0.9 * expected` or when `samplesDecoded === 0`, where `expected` = last-page granule position minus pre-skip, scaled 48 kHz -> 16 kHz), and peak memory (a 15 min note = 14.4 M Float32 samples = 58 MB - acceptable; longer notes are rejected by the cap in 4.5 *before* decoding, using the granule position of the last Ogg page as the duration estimate - the demuxer exposes it).

### 7.2 Decoder + WAV writer shape

```ts
// src/main/voice/ogg.ts  (pure TypeScript, no deps; RFC 3533 Ogg framing + RFC 7845 Ogg Opus mapping; unit-tested with synthetic pages)
export interface OggOpusStream {
  channels: number; preSkip: number; mappingFamily: number;             // from OpusHead (RFC 7845 section 5.1)
  streamCount: number; coupledStreamCount: number; channelMappingTable: number[];
  packets: Uint8Array[];                                                 // audio packets only (OpusHead/OpusTags removed)
  lastGranule: bigint;                                                   // granule position of the last page = 48 kHz sample count incl. pre-skip
}

export function demuxOggOpus(bytes: Uint8Array, maxBytes = 64 * 2 ** 20): OggOpusStream {
  if (bytes.length > maxBytes) throw new VoiceError('VOICE_TOO_LONG');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0, serial: number | undefined, pageSeq = -1, lastGranule = 0n;
  const packets: Uint8Array[] = []; let partial: Uint8Array[] = []; let head: OggOpusStream | undefined; let seenTags = false;
  while (off + 27 <= bytes.length) {
    if (bytes[off] !== 0x4f || bytes[off+1] !== 0x67 || bytes[off+2] !== 0x67 || bytes[off+3] !== 0x53) throw new VoiceError('VOICE_DECODE_FAILED'); // "OggS"
    if (bytes[off+4] !== 0) throw new VoiceError('VOICE_DECODE_FAILED');                       // stream_structure_version
    const flags = bytes[off+5], granule = dv.getBigUint64(off+6, true), ser = dv.getUint32(off+14, true);
    const seq = dv.getUint32(off+18, true), crc = dv.getUint32(off+22, true), nseg = bytes[off+26];
    const bodyStart = off + 27 + nseg; if (bodyStart > bytes.length) throw new VoiceError('VOICE_DECODE_FAILED');
    let bodyLen = 0; for (let i = 0; i < nseg; i++) bodyLen += bytes[off+27+i];
    const pageEnd = bodyStart + bodyLen; if (pageEnd > bytes.length) throw new VoiceError('VOICE_DECODE_FAILED');   // truncated file
    if (oggCrc32(bytes.subarray(off, pageEnd), off + 22) !== crc) throw new VoiceError('VOICE_DECODE_FAILED');       // CRC over the page with the crc field zeroed
    if (serial === undefined) serial = ser; else if (ser !== serial) throw new VoiceError('VOICE_DECODE_FAILED');       // WhatsApp files are single-stream; multiplexed Ogg is rejected
    if (seq !== pageSeq + 1) throw new VoiceError('VOICE_DECODE_FAILED'); pageSeq = seq;
    if (!(flags & 0x01)) partial = [];                                                          // not a continuation page -> drop any dangling partial packet
    let p = bodyStart;
    for (let i = 0; i < nseg; i++) {
      const lace = bytes[off+27+i]; partial.push(bytes.subarray(p, p + lace)); p += lace;
      if (lace < 255) {                                                                        // packet complete
        const pkt = concat(partial); partial = [];
        if (!head) head = parseOpusHead(pkt);                                                  // first packet MUST be OpusHead
        else if (!seenTags) { if (!startsWith(pkt, 'OpusTags')) throw new VoiceError('VOICE_DECODE_FAILED'); seenTags = true; }
        else if (pkt.length > 0) packets.push(pkt);                                            // zero-length packets are legal padding
      }
    }
    if (granule !== 0xffff_ffff_ffff_ffffn) lastGranule = granule;
    if (flags & 0x04) break;                                                                   // end-of-stream
    off = pageEnd;
  }
  if (!head || !seenTags) throw new VoiceError('VOICE_DECODE_FAILED');
  return { ...head, packets, lastGranule };
}

function parseOpusHead(p: Uint8Array): Omit<OggOpusStream, 'packets' | 'lastGranule'> {
  if (p.length < 19 || !startsWith(p, 'OpusHead') || (p[8] >> 4) !== 0) throw new VoiceError('VOICE_DECODE_FAILED'); // version major 0
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const channels = p[9], preSkip = dv.getUint16(10, true), mappingFamily = p[18];
  if (mappingFamily === 0) { if (channels < 1 || channels > 2) throw new VoiceError('VOICE_DECODE_FAILED');
    return { channels, preSkip, mappingFamily, streamCount: 1, coupledStreamCount: channels - 1, channelMappingTable: channels === 1 ? [0] : [0, 1] }; }
  if (p.length < 21 + channels) throw new VoiceError('VOICE_DECODE_FAILED');                    // family 1 (surround): read the table, still handed to the decoder
  return { channels, preSkip, mappingFamily, streamCount: p[19], coupledStreamCount: p[20], channelMappingTable: Array.from(p.subarray(21, 21 + channels)) };
}
// oggCrc32: table-driven CRC-32 with polynomial 0x04C11DB7, initial value 0, no bit reflection, no final XOR (RFC 3533 section 6), computed with bytes [22..26) treated as zero.

// src/main/voice/decode.ts  (S-FS only; pure function over bytes; unit-tested with a synthetic fixture)
import { OpusDecoder } from 'opus-decoder';
import { demuxOggOpus } from './ogg';

export const WHISPER_SAMPLE_RATE = 16_000;
export const MAX_VOICE_SECONDS = 15 * 60;

export interface DecodedAudio { pcm16: Buffer; seconds: number; samples: number; decodeErrors: number }

export async function oggOpusToWav16k(ogg: Uint8Array): Promise<DecodedAudio> {
  const s = demuxOggOpus(ogg);
  const expected48k = s.lastGranule - BigInt(s.preSkip);                                        // duration BEFORE decoding (granule = 48 kHz samples, RFC 7845 section 4)
  if (expected48k > BigInt(MAX_VOICE_SECONDS * 48_000)) throw new VoiceError('VOICE_TOO_LONG');
  const dec = new OpusDecoder({ sampleRate: WHISPER_SAMPLE_RATE, channels: s.channels, preSkip: s.preSkip,
                                streamCount: s.streamCount, coupledStreamCount: s.coupledStreamCount, channelMappingTable: s.channelMappingTable, forceStereo: false });
  try {
    await dec.ready;
    const { channelData, samplesDecoded, sampleRate, errors } = dec.decodeFrames(s.packets);      // one Opus packet per array element
    if (sampleRate !== WHISPER_SAMPLE_RATE || samplesDecoded === 0) throw new VoiceError('VOICE_DECODE_FAILED');
    const expected16k = Number(expected48k / 3n);
    if (errors.length > 0 && samplesDecoded < 0.9 * expected16k) throw new VoiceError('VOICE_DECODE_FAILED');
    const mono = channelData.length === 1 ? channelData[0] : downmix(channelData);   // WhatsApp is mono; downmix is defensive
    return { pcm16: wavPcm16(mono, WHISPER_SAMPLE_RATE), seconds: mono.length / WHISPER_SAMPLE_RATE, samples: mono.length, decodeErrors: errors.length };
  } finally { dec.free(); }
}

/** 44-byte RIFF/WAVE header + PCM16 LE; whisper-cli reads exactly this ("16-bit WAV"). */
export function wavPcm16(f32: Float32Array, rate: number): Buffer {
  const out = Buffer.alloc(44 + f32.length * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + f32.length * 2, 4); out.write('WAVE', 8);
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(f32.length * 2, 40);
  for (let i = 0; i < f32.length; i++) { const s = Math.max(-1, Math.min(1, f32[i])); out.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, 44 + i * 2); }
  return out;
}
```

Test fixture without ffmpeg: `scripts/make-ogg-fixture.mjs` writes a deterministic Ogg Opus stream (Ogg pages with CRC32, `OpusHead`/`OpusTags`, then N one-byte Opus packets `0x08` = SILK-WB 20 ms code-0 with a zero-length frame, which RFC 6716 defines as a lost/DTX frame the decoder renders as silence) -> `tests/fixtures/voice/silence-2s.ogg`. The same generator doubles as the demuxer's unit-test oracle (continuation packets across pages, bad CRC, wrong serial, truncated page, missing `OpusTags`). **UNVERIFIED** that `opus-decoder` renders the DTX packets without entries in `errors[]`; if it does report errors, the fixture generator falls back to encoding real frames with `opus-encdec`'s WASM encoder at dev time (dev dependency only). A second fixture with speech is needed for the golden set; it must be recorded by the user or synthesised - never taken from the private store.

---

## 8. Pipeline placement, data model, queueing

### 8.1 Where transcription runs

```
Ingest (row media_type='audio', filename)  ->  items row kind='voice_note', analysis='queued'  ->  TriageQueue (per chat, concurrency 1)
   -> orchestrator.runChat(chat):
        1. for each live message with mediaType==='audio' and no transcript row:  await voice.transcribe(msg)   [NEW - before S0]
        2. S0 deterministic filter  (transcript text now participates; '' transcripts are never triggers)
        3. S1 extract -> S2 resolve -> S3 draft -> S4 validate  (unchanged; transcript arrives as message text)
```

- Because the step sits inside `runChat`, whisper-cli and llama-server never run at the same time on behalf of the app (queue concurrency 1). No new semaphore, no change to A3 (whisper-cli is a job, not a supervised child). Cost: a long note delays the next chat's triage by its transcription time - accepted; the queue stats already expose `running`.
- Abort: `signal` from the TriageQueue (Pause / edit-lock) kills the child by PID (`taskkill /PID /T /F` after 3 s grace) and leaves the transcript row `status='aborted'` so the next run retries.
- Retry: `VOICE_TIMEOUT`, `VOICE_AUDIO_MISSING` -> `TriageRetryError` (60 s / 5 min / 30 min backoff, existing); `VOICE_DECODE_FAILED`, `VOICE_TOO_LONG`, `VOICE_MODEL_MISSING` -> terminal, raw card with the ErrorCode and an "Analyse again" action.

### 8.2 Caching by message id

`app.db` migration `voice_transcripts`:

```sql
CREATE TABLE transcripts (
  chat_jid     TEXT NOT NULL,
  wa_msg_id    TEXT NOT NULL,
  status       TEXT NOT NULL CHECK(status IN ('done','empty','failed','aborted')),
  text         TEXT,                 -- UNTRUSTED; NULL after retention (same rule as items.trigger text)
  language     TEXT,                 -- whisper result.language ('he','en',...)
  seconds      REAL NOT NULL,
  model_label  TEXT NOT NULL,        -- manifest label, e.g. 'ivrit-large-v3-turbo-f16'
  error_code   TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (chat_jid, wa_msg_id)
) WITHOUT ROWID;
```

A transcript is computed once per `(chat_jid, wa_msg_id)` and per model label (changing the tier invalidates via `model_label` mismatch -> re-transcribe lazily on the next run of that chat). Retention (`db/retention.ts`) nulls `text` on the same schedule as message previews. Backups (`db/backup.ts`) include the table.

### 8.3 Transcript = untrusted text

- Presented to S1/S3 through `contextBuilder` inside the existing `<<DATA-nonce>> … <<END-DATA-nonce>>` block as a message object with an extra field: `{ "id": "...", "from": "them", "ts": "...", "source": "voice_transcript", "language": "he", "text": "<sanitizeForModel(transcript)>" }`. Nothing about the transcript enters the system prompt; `prompt.purity.test.ts` extends to assert that.
- `sanitizeForModel()` and `stripInvisible()` apply unchanged (whisper output can contain RTL marks and odd Unicode). `LIMITS.messageChars` applies (a 15 min note can be ~2,000 words; truncate with the existing tail-marker rule).
- The renderer shows the transcript as the trigger preview with a "voice note" badge and the language; it is `UNTRUSTED` display text like any message. S0's "own message / reaction / empty" rules apply to `''` transcripts (never a trigger).
- Cloud providers: the transcript is message text; if the user selected Claude/Gemini, it goes to that provider under the existing `cloud_*` consent (the consent copy must mention "including transcripts of voice notes"). Transcription itself is always local (D-039).

### 8.4 Timeouts

`timeoutMs = clamp(30_000, 4 × seconds × 1000 × benchFactor, 600_000)` where `benchFactor = bench_json.secPerAudioSec ?? 2`. Model load is included; the first run after boot may be slow (cold page cache) - the self-test warms it. Decode (WASM) timeout 20 s. Wait-for-file 30 s (6.2). Job wall-clock is logged as a number only (no text).

### 8.5 Wrapper shape

```ts
// src/main/voice/whisperCli.ts   (S-PROC, S-FS, S-CLOCK; Electron-free; deps injected like llamaServer.ts)
export interface WhisperRunner {
  transcribe(input: { wavPath: string; modelPath: string; vadPath: string; language: 'he' | 'auto'; seconds: number }, signal: AbortSignal): Promise<WhisperResult>;
}
export interface WhisperResult { text: string; language: string | null; segments: { fromMs: number; toMs: number; text: string }[]; wallMs: number }

export const WHISPER_ENV_PASSTHROUGH = ['SystemRoot', 'windir', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS'] as const;   // same as llama
export const WHISPER_BREAKER = { maxFailures: 5, windowMs: 600_000 } as const;                                      // then VOICE_LOCAL_FAILED, retry later
export const WHISPER_MARKERS: Readonly<Record<string, RegExp>> = {                                                  // stderr -> marker names only
  modelMissing: /error: failed to (initialize whisper context|open '.*')/, badWav: /failed to read (WAV|audio) file/, vadFail: /vad/i,
};

export function buildWhisperArgs(i: { model: string; wav: string; vad: string; lang: 'he'|'auto'; outBase: string; threads: number }): string[] {
  return ['-m', i.model, '-f', i.wav, '-l', i.lang, '-t', String(i.threads), '-oj', '-of', i.outBase, '-np', '-nt',
          '--vad', '--vad-model', i.vad, '--vad-threshold', '0.5', '--vad-min-speech-duration-ms', '250',
          '--vad-min-silence-duration-ms', '400', '--vad-speech-pad-ms', '60', '--vad-max-speech-duration-s', '30',
          '-bs', '5', '-bo', '5', '-tp', '0', '-et', '2.4', '-sns'];
}

// createWhisperRunner(deps): spawn(exe, args, { cwd: binDir, env: buildMinimalEnv(), windowsHide: true, shell: false, stdio: ['ignore','ignore','pipe'] })
//   -> os.setPriority(pid, BELOW_NORMAL) -> race(exit, timeout, signal) -> on exit 0: read `${outBase}.json`, zod .strict() parse
//   { result:{language:string}, transcription: [{ offsets:{from:number,to:number}, text:string }] } (unknown keys ignored via .passthrough() on the root only)
//   -> text = segments.map(s=>s.text.trim()).join(' ') -> delete json+wav in finally -> ErrorCode mapping: exit 3 => VOICE_MODEL_MISSING,
//   -1073741515 => LLM_VCREDIST_MISSING (reuse), no JSON => VOICE_DECODE_FAILED, timeout => VOICE_TIMEOUT, signal => aborted.
```

`src/main/voice/service.ts` orchestrates: locate (6.2) -> read bytes (<= 64 MiB) -> decode (7.2) -> write `<userData>\voice\tmp\<jobId>.wav` -> run -> store transcript -> `notifyChanged()`. Temp dir is wiped at start-up (crash leftovers) and each job deletes its files in `finally`. Job id = `randomUUID()`, never the message id (no message ids in file names on disk beyond what the bridge already does).

### 8.6 Model download via the existing ModelManager

- `ModelManifestEntry` gains `kind: 'llm' | 'asr' | 'vad'` and `magic: 'GGUF' | 'GGML'`; `ModelTier` becomes a union with `'voice-hebrew' | 'voice-multilingual' | 'voice-lite' | 'voice-vad'`. **Verified 2026-09-28:** whisper models are checked in `whisper_model_load` against `GGML_FILE_MAGIC` = `0x67676d6c` (`ggml/include/ggml.h`, comment `"ggml"`), written little-endian, so the first 4 bytes on disk are `6c 6d 67 67` (ASCII `lmgg`); the Silero VAD converter `models/convert-silero-vad-to-ggml.py` writes the **same** header (`fout.write(struct.pack("i", 0x67676d6c))`), so one `GGML` magic check covers all four voice files. (`pin-models.mjs` should still read the first 4 bytes of each pinned file via a `Range: bytes=0-3` request at pin time and fail on drift, as it does for GGUF.)
- Everything else is reused unchanged: HTTPS-only, one-hop redirect to `*.hf.co`, `X-Linked-Size`/`X-Linked-ETag` pre-check, `Range` resume into `<userData>\models\<file>.part`, free-disk `size + 5 %`, streamed sha256 against the pin, atomic rename, one automatic re-download, 4 Hz progress over `model:progress`, `model_files` rows with `bench_json`.
- Plan rule: the voice tier is selected by RAM/disk (4.3) independently of the LLM tier; both downloads are queued through one downloader (one connection at a time - the existing behaviour). Total first-run download with defaults: LLM tier + 1.62 GB + 0.9 MB. The settings page shows the voice download size before starting and lets the user pick "Voice notes: Off / Hebrew-optimised / Auto-detect language / Lite".
- Update path: bumping the pin changes `model_label`; old files are deleted by the existing `delete(tier)` flow after the new one is `ready`.

### 8.7 Settings (zod, one JSON value like today)

```ts
voice: { enabled: boolean /* default true once a voice model is ready, false before */,
         tier: 'auto' | 'voice-hebrew' | 'voice-multilingual' | 'voice-lite',
         maxMinutes: 15, threads: 'auto' | number }
```

### 8.8 Error codes (add to `shared/errors.ts`)

`VOICE_MODEL_MISSING`, `VOICE_AUDIO_MISSING`, `VOICE_DECODE_FAILED`, `VOICE_TOO_LONG`, `VOICE_TIMEOUT`, `VOICE_LOCAL_FAILED` (breaker), plus reuse of `LLM_VCREDIST_MISSING` (same single action: open `https://aka.ms/vs/17/release/vc_redist.x64.exe` in the browser).

---

## 9. Privacy and security checklist

- Nothing leaves the machine: audio file (bridge store), WAV (temp), JSON (temp), model (models dir). No network in `whisper-cli` (it has no network code path; there is no `--offline` flag because there is nothing to switch off). Downloads only via the existing allow-listed downloader.
- Process hygiene = llama rules: minimal env block, `cwd` = bin dir, `windowsHide`, `shell:false`, argv never contains message text (only paths with random job ids), stdout ignored (it carries the transcript), stderr marker-only, kill by PID, BELOW_NORMAL priority, breaker 5 failures / 10 min.
- Files: read the `.ogg` only after the realpath prefix assertion; write temp files only under `<userData>\voice\tmp\`; delete in `finally`; wipe the dir at start-up. Media janitor unchanged (7 days); transcripts persist independently of the audio file.
- Untrusted data: transcript text is the same class as message text (sanitised, wrapped, never in the system prompt, truncated). whisper JSON is parsed with zod; `result.language` is validated against `^[a-z]{2,3}$` before storage. The `filename` column and JIDs are regex-guarded before touching the filesystem or `/api/download`.
- Threat delta vs v1: the app now opens attacker-supplied media bytes with a WASM decoder (memory-safe sandbox; a malformed file can at worst throw / return errors) and hands a WAV the app itself wrote to `whisper-cli` (native code, but it parses only our own 44-byte-header PCM, not the attacker's container). The Ogg container is parsed by ~150 lines of our own bounds-checked TypeScript (every page/segment length is validated against the buffer, CRC-checked, single-stream only, 64 MiB cap before parsing) and the Opus bitstream by libopus inside WASM - no native code ever sees attacker-controlled bytes. This is the reason for choosing option A over the ffmpeg exe.
- Invariant tests to add under `tests/security/`: (I-V1) no code path sends audio, WAV, transcript or model bytes to any host other than the LLM provider chosen under consent; (I-V2) `whisper-cli.exe` is never spawned with `shell:true` or with message text in argv; (I-V3) `/api/download` (if amended into A16) is only reachable from `voice/audioLocator.ts` and only with regex-validated ids.

---

## 10. Packaging and build scripts

- `scripts/fetch-whisper.mjs` (clone of `fetch-llama.mjs`): download `whisper-bin-x64.zip` from `vendor/whisper.pin.json` (`tag b5130`, size 8,573,270, sha256 above), verify, unzip, strip the `Release/` prefix, copy the allow-list into `vendor/whisper/win-x64-cpu/`, write the MIT text from `https://raw.githubusercontent.com/ggml-org/whisper.cpp/b5130/LICENSE` into `THIRD_PARTY_NOTICES.txt`, stage the same three CRT DLLs if `VC_REDIST_CRT_DIR` is set (or place whisper in the same `resources/llama/` directory so one CRT copy serves both - preferred; the ggml DLL names collide only in name, and whisper's `whisper-cli.exe` must load *its* `ggml.dll`, so **keep separate folders**: `resources/llama/` and `resources/whisper/`, each with its own CRT copy; 3 × ~1 MB duplicated).
- `electron-builder.yml`: `extraResources: [{ from: vendor/whisper/win-x64-cpu, to: whisper, filter: [allow-list] }]`; `smoke-packaged.mjs` asserts the file set and the notices entry. `npmRebuild:false` unchanged; no `asarUnpack` (the decoder is plain JS).
- Third-party notices additions: whisper.cpp (MIT), `opus-decoder` (MIT), `@wasm-audio-decoders/common` (MIT), `simple-yenc` (MIT), `@eshaz/web-worker` (Apache-2.0 - ship its NOTICE if present), libopus (BSD-3, with the patent note), ivrit-ai model (Apache-2.0), OpenAI Whisper weights (MIT), Silero VAD ggml files (`ggml-org/whisper-vad` model card front matter `license: mit` - verified 2026-09-28; the upstream `snakers4/silero-vad` repo is also MIT - **UNVERIFIED**, one fetch at pin time). **No LGPL/GPL code enters the tree** - the existing "forbidden packages" gate (D-022) gains a licence allow-list check (`MIT`, `Apache-2.0`, `BSD-2/3-Clause`, `ISC`, `0BSD`) for the four decoder packages so a future `opus-decoder` release cannot silently re-introduce `codec-parser`.
- `npm audit --omit=dev` gate: the decoder adds 4 runtime packages (`opus-decoder`, `@wasm-audio-decoders/common`, `simple-yenc`, `@eshaz/web-worker`); check them in W0.

---

## 11. Test strategy hooks

- Unit: `buildWhisperArgs`, `wavPcm16` (header bytes golden), `audioLocator` (traversal, regex, prefix), JSON parser (`result.language`, empty `transcription`), error mapping, timeout math.
- Fake `whisper-cli`: `tests/fakes/whisper-cli.mjs` launched via `process.execPath` (same trick as the fake bridge) that copies a fixture JSON to `-of`, honours a `WCA_FAKE_WHISPER_MODE=slow|exit3|nojson|crash` env for failure paths. The real exe is never executed by tests.
- Integration: ingest row with `media_type='audio'` -> transcript row -> S1 sees `source:'voice_transcript'` in the DATA block -> proposal. Retention nulls `text`. Tier change re-transcribes.
- Golden (release gate): 10-15 synthetic Hebrew / English / mixed voice fixtures with expected key phrases (not exact WER); pass criteria per tier; this is where the Hebrew-model-on-English question (4.2) is decided.
- Manual first-run checklist additions: VC++ runtime absent -> `LLM_VCREDIST_MISSING` from the voice path too; a 10 min note completes under the timeout on the reference laptop; CPU stays below 100 % of all cores (threads cap) while the UI remains responsive.

---

## 12. UNVERIFIED register (carry into ARCH section 19)

1. `opus-decoder@0.7.12` runs under Electron 44 main (Node 24) and decodes real WhatsApp packets without `errors[]`; peak memory on a 15 min note; the app-authored Ogg demuxer against real WhatsApp files (only synthetic fixtures can be produced by agents - the user must supply one recorded note for the golden set).
2. ~~Transitive-package licences~~ **VERIFIED 2026-09-28**: `opus-decoder` MIT, `@wasm-audio-decoders/common` MIT, `simple-yenc` MIT, `@eshaz/web-worker` Apache-2.0; `codec-parser` is LGPL-3.0-or-later and is therefore NOT used (section 7.1). Still UNVERIFIED: whether `@wasm-audio-decoders/common` touches `Worker`/`window` at import time in Node (its README claims Node support; a one-line import smoke in W0 settles it).
3. English / mixed audio quality of the ivrit-ai Hebrew tier with `-l he` forced; the exact ivrit-ai checkpoint behind the `-ggml` repo (the model card names no base checkpoint; verified 2026-09-28 that it only states `license: apache-2.0` and ggml compatibility).
4. CPU speed of turbo f16 on a modern laptop (only a 2010 CPU benchmark exists; 2026 web articles give no x86 laptop RTF for turbo - re-checked 2026-09-28); whether the model load dominates per-run time (would flip 2 to `whisper-server`).
5. ~~Silero VAD ggml licence and file magic; whisper ggml magic bytes~~ **VERIFIED 2026-09-28**: both file types start with `GGML_FILE_MAGIC 0x67676d6c` (`lmgg` on disk); `ggml-org/whisper-vad` card = MIT (section 8.6, 10). Remaining: the upstream Silero VAD weights licence (one fetch of `snakers4/silero-vad` at pin time).
6. Determinism of `whisper-quantize.exe` output across CPUs (only matters if 4.4 is adopted).
7. Bit-level equality of the b5130 zip with what `release.yml` describes (the zip was listed and its imports scanned; nothing was run).
8. WhatsApp PTT parameters (16 kHz mono ~16 kbps) come from community measurements, not a spec; the decoder does not depend on them.

---

## Sources

- whisper.cpp releases (GitHub API): https://api.github.com/repos/ggml-org/whisper.cpp/releases ; asset https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip (downloaded to the scratchpad, sha256 verified, listed, import tables scanned)
- Release workflow: https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/.github/workflows/release.yml ; Vulkan issue: https://github.com/ggml-org/whisper.cpp/issues/3673
- README / examples: https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/README.md , https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/examples/cli/README.md , https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/examples/server/README.md , https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/examples/common-whisper.cpp , https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/examples/cli/cli.cpp
- Models: https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main , https://huggingface.co/api/models/ivrit-ai/whisper-large-v3-turbo-ggml/tree/main , https://huggingface.co/ivrit-ai/whisper-large-v3-turbo , https://huggingface.co/ivrit-ai/whisper-large-v3 , https://huggingface.co/api/models/ggml-org/whisper-vad/tree/main , https://huggingface.co/api/models?filter=base_model:quantized:ivrit-ai/whisper-large-v3-turbo-ggml
- Hebrew WER: https://huggingface.co/spaces/ivrit-ai/hebrew-transcription-leaderboard (data: `raw/main/benchmark.csv`, app: `raw/main/app.py`) ; https://www.ivrit.ai/en/2025/02/13/training-whisper/ ; https://ar5iv.labs.arxiv.org/html/2307.08720 ; distil-whisper README https://raw.githubusercontent.com/huggingface/distil-whisper/main/README.md
- CPU benchmark: https://github.com/ggml-org/whisper.cpp/discussions/3752
- Decoder: https://registry.npmjs.org/opus-decoder/0.7.12 (MIT, deps) , https://registry.npmjs.org/@wasm-audio-decoders/common/9.0.7 (MIT) , https://registry.npmjs.org/simple-yenc/latest (1.0.4, MIT) , https://registry.npmjs.org/@eshaz/web-worker/1.2.2 (Apache-2.0) , https://raw.githubusercontent.com/eshaz/wasm-audio-decoders/main/src/opus-decoder/README.md (constructor options, `decodeFrames`, errors shape, Node support) , https://unpkg.com/opus-decoder@0.7.12/src/EmscriptenWasm.js , https://opus-codec.org/license/ ; rejected: https://registry.npmjs.org/ogg-opus-decoder/latest (1.7.5; deps `codec-parser@2.5.0`, `@wasm-audio-decoders/opus-ml@0.0.3`) , https://registry.npmjs.org/codec-parser/2.5.0 (`license: LGPL-3.0-or-later`) , https://api.github.com/repos/eshaz/codec-parser/contents/package.json (same) , https://raw.githubusercontent.com/eshaz/codec-parser/master/LICENSE (LGPL v3 text) , https://registry.npmjs.org/@wasm-audio-decoders/opus-ml/0.0.3 (8,246,295 B unpacked)
- Container/codec specs: RFC 3533 (Ogg framing, CRC) https://www.rfc-editor.org/rfc/rfc3533 , RFC 7845 (Ogg Opus: `OpusHead`, pre-skip, granule position at 48 kHz) https://www.rfc-editor.org/rfc/rfc7845 , RFC 6716 (Opus packet TOC / DTX) https://www.rfc-editor.org/rfc/rfc6716
- File magic / VAD: https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/ggml/include/ggml.h (`GGML_FILE_MAGIC 0x67676d6c`) , https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/src/whisper.cpp (`whisper_model_load` bad-magic check) , https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/models/convert-silero-vad-to-ggml.py (same magic) , https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/include/whisper.h (`whisper_vad_params`, `WHISPER_SAMPLE_RATE 16000`) , https://huggingface.co/ggml-org/whisper-vad/raw/main/README.md (`license: mit`)
- ffmpeg builds: https://github.com/BtbN/FFmpeg-Builds/releases , https://www.gyan.dev/ffmpeg/builds/
- WhatsApp PTT format: https://github.com/openclaw/openclaw/issues/7 , https://github.com/DevEmperor/DictateKeyboard/issues/322 , https://audioutils.com/blog/best-format-for-whatsapp
- Reference bridge source (read-only, no store access): `C:\Users\ilay1\Documents\minime\whatsapp-mcp\whatsapp-bridge\main.go` (`extractMediaInfo`, `downloadMedia`, `handleMessage`), `media_serve.go`; project docs `docs/research/bridge-contract.md`, `docs/ARCHITECTURE.md` sections 3, 4, 8, 9, 17.
