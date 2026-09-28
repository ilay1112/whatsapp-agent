# Agent notes: v2-whisper-local (research, 2026-09-27; re-run 2026-09-28)

Deliverable: `docs/research/v2-whisper-local.md`.

## Re-run 2026-09-28 ("Try again")
The first run wrote the full report but hit the session limit before returning its structured summary (PROGRESS item 48 lists whisper-local as failed). This run re-verified every pin live and amended the report instead of rewriting it:
- whisper.cpp releases API: `b5130` (2026-09-11) is still the newest tag with Windows assets; `v1.9.4` still the newest stable (no assets). Sizes/sha256 of `whisper-bin-x64.zip` unchanged.
- ivrit-ai ggml `ggml-model.bin` size + LFS sha unchanged; model card only states `license: apache-2.0` + ggml compatibility (no base checkpoint named).
- **Decoder decision changed.** `ogg-opus-decoder@1.7.5` (still latest) depends on `codec-parser@2.5.0`, whose licence is **LGPL-3.0-or-later** (npm `license`, GitHub `package.json`, repo `LICENSE` all agree), and on `@wasm-audio-decoders/opus-ml@0.0.3` (8.2 MB unpacked). Switched to `opus-decoder@0.7.12` (MIT) + an app-authored Ogg demuxer (RFC 3533 / RFC 7845); full dependency chain verified: `@wasm-audio-decoders/common@9.0.7` MIT, `simple-yenc@1.0.4` MIT, `@eshaz/web-worker@1.2.2` Apache-2.0, libopus BSD-3. Demuxer code shape added to report section 7.2.
- Verified file magic: `GGML_FILE_MAGIC 0x67676d6c` in `ggml/include/ggml.h`, checked by `whisper_model_load`; `models/convert-silero-vad-to-ggml.py` writes the same magic, so the VAD file has it too. `ggml-org/whisper-vad` card = `license: mit`.
- whisper-cli defaults read from `examples/cli/cli.cpp` (VAD threshold 0.5 / min-speech 250 / min-silence 100 / pad 30 / overlap 0.1; `-vm` short flag; model-load failure `return 3`; unreadable audio `continue` -> exit 0 without JSON) - all consistent with the report.
- CPU speed: 2026 web articles still give no x86-laptop RTF for turbo; stays UNVERIFIED (bench in first-run self-test).

## What the first run did
- Read ARCH sections 3/8/9/17, `ops/CONTEXT.md` v2 request, D-036..D-041, `llm/local/{manifest,download,llamaServer}.ts`, `bridge/{bridgeDb,ingest,janitor}.ts`, `agent/{queue,contextBuilder}.ts`.
- Read the reference bridge *source* only (`main.go`, `media_serve.go`) - never the `store` directory.
- Web: GitHub releases API + release.yml for whisper.cpp, README/cli/server docs, `common-whisper.cpp`, HF trees for ggerganov/whisper.cpp, ivrit-ai ggml, ggml-org/whisper-vad, the ivrit-ai leaderboard `benchmark.csv`, npm/unpkg for the decoders, opus licence page, BtbN/gyan ffmpeg licence facts.
- Downloaded `whisper-bin-x64.zip` (b5130) to the scratchpad, verified sha256, listed it, and scanned PE import strings with a Node script. Nothing was executed.

## Dead ends
- `build-windows.yml` is only the MSYS2 CI; the release zips come from `release.yml`.
- `medium.com` and `npmjs.com` return 403 to fetch; the npm registry JSON, unpkg and raw GitHub work. `raw.githubusercontent.com/eshaz/wasm-audio-decoders/main/LICENSE` and the GitHub contents API for it return 404 (the monorepo has per-package LICENSE files; the npm `license` fields were used instead).
- The Whisper paper PDF could not be rendered (no poppler); the ivrit leaderboard CSV gave better, product-relevant numbers anyway.
- No official quantised ivrit-ai ggml exists; the single community quant is unprovenanced (rejected).
- `src/whisper.cpp` is too long for the fetch tool to reach `whisper_vad_default_params`; the VAD defaults were taken from `cli.cpp` (which is what the exe uses) and `whisper.h` (struct + `WHISPER_SAMPLE_RATE`).

## Assumptions / things the orchestrator must decide
1. Amend A16 to allow `POST /api/download` narrowly as a fallback (report section 6.3) - or accept that vanished audio files stay untranscribed.
2. Voice tier default `hebrew` (ivrit-ai f16, forced `-l he`) vs `multilingual`; the golden set decides if English notes fail.
3. whisper-cli-per-file (chosen) vs whisper-server as a 4th child - swap only if the bench shows model load dominating.
4. Local quantisation with `whisper-quantize.exe` deferred.
5. Licence gate: add a licence allow-list check for runtime packages to the D-022 forbidden-packages gate (LGPL `codec-parser` was one `npm install` away).

## Hand-off
- Everything pinned (tag, sizes, sha256, flags, packages) is in the research file; the UNVERIFIED register (section 12) now has three items resolved and lists what Wave 0 must probe: `opus-decoder` import under Electron main, DTX fixture rendering, real-WhatsApp-file demux (needs one user-recorded note), CPU speed bench, English-through-Hebrew-tier quality.
- Scratchpad artefacts (zip, extracted binaries, scan script) live only under the session scratchpad and are not part of the project.
