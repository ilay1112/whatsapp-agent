# v2 adversarial design review - FEASIBILITY (agent notes)

Date: 2026-09-28. Read-only review; no design file edited. Findings were returned to the orchestrator via StructuredOutput.

## Method (what was checked, how)
- Claude Code: local `claude.exe --help` / `auth --help` (2.1.258, no login used), string search of the binary for hidden flags/env names,
  code.claude.com docs (headless, cli-reference, env-vars, mcp, memory, setup) fetched 2026-09-28.
- Antigravity: antigravity.google/docs/cli/headless (flags, stdin envelope, exit codes); research doc CHANGELOG citations taken as-is.
- Gemini CLI: consumer-login shutdown 2026-06-18 confirmed (Google dev blog / discussion #27274).
- whisper.cpp: GitHub releases API (b5130 / v1.9.4 assets, size + sha256 match), examples/cli/cli.cpp at v1.9.4 (all argv flags + exit codes).
- Hugging Face API: ivrit-ai ggml-model.bin, silero v6.2.0, large-v3-turbo-q8_0, small-q8_0, the three mmproj-F16 at the v1 commits (all sizes match).
- llama.cpp b10964 common/arg.cpp (--mmproj-device none, --image-max-tokens) and server /props modalities.vision: present.
- npm: opus-decoder 0.7.12 MIT (+ deps MIT/MIT/Apache-2.0), sampleRate 16000 supported; zod 4.6.5 accepts target 'draft-07';
  MCP SDK 1.30.0 stateless transport throws on reuse; allowedHosts etc. @deprecated (as stated).
- Staged @cocal/google-calendar-mcp 2.6.3 bundle under build-resources/calendar-mcp/node_modules (read only).

## Verified OK (no finding)
whisper release asset + VAD flags; model sizes/sha; mmproj sizes; llama flags; opus-decoder licence chain / no native addon;
Gemini CLI consumer shutdown; `--max-turns` hidden but present; `--permission-prompts` >= 2.1.259; `claude auth status --json`,
`auth login --claudeai`; `--effort`, `--fallback-model`, `--no-session-persistence`, `--disable-slash-commands`, `--tools ""`;
Electron 44 Notification actions typed for win32; get-event/list-calendars readOnlyHint; accessRole returned by list-calendars.

## Dead ends / assumptions
- Could not confirm whether `StructuredOutput` appears in `system/init.tools` (needs a logged-in run = M-CLI-1); the binary proves the tool exists.
- Could not confirm Claude Code's reaction to a 404 on GET /mcp (needs a real run); SDK client behaviour verified from source.
