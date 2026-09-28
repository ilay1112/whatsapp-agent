# Agent notes: v2-claude-cli-backend (research)

Date: 2026-09-27. Deliverable: `docs/research/v2-claude-cli-backend.md`.

## What I did
- Loaded the `claude-api` skill (it covers the Messages API and explicitly does not cover the Agent SDK/CLI; used it only for model-id sanity).
- Fetched the official Claude Code docs pages (headless, cli-reference, authentication, legal-and-compliance, setup, model-config, costs, errors, interactive-mode, agent-sdk/{overview,typescript,structured-outputs,mcp,custom-tools,streaming-input,permissions,agent-loop,cost-tracking,modifying-system-prompts}), the Pro/Max support article, npm registry metadata, three GitHub issues, one community PR and two press pieces.
- Ran the locally installed CLI with `--version`, `--help`, `auth --help`, `auth status --help`, `auth login --help`, `install --help` only. Did not run `auth status` (would read the credential), did not run any prompt, did not touch `~/.claude/.credentials.json`.

## Assumptions / dead ends
- The Agent SDK's `sdk.d.ts` on unpkg could not be read whole through WebFetch (it truncates and one summary contradicted the docs); I trusted the docs for type shapes and marked the `.d.ts`-only claims UNVERIFIED.
- Image input over `--input-format stream-json` on the raw CLI is documented for the SDK (same transport) but I could not execute it; the build ticket needs a one-time smoke test by the user.
- `--restricted` exists in the local 2.1.258 help but I found no docs page naming its minimum version.
- `claude auth status --json` field names beyond `loggedIn` are unverified; the app should parse only `loggedIn`.
- `--setting-sources ""` empty-value acceptance on 2.1.258 unverified; `--restricted` covers the need.

## Hand-off to the orchestrator
- Recommend: direct `child_process.spawn` of the user-installed `claude.exe`; no Agent SDK dependency; no bundled binary (legal page conditions bundling on Commercial ToS).
- Minimum CLI version 2.1.221; gate `--permission-prompts none` on 2.1.259+ (this machine: 2.1.258).
- `--bare` must not be used (never reads OAuth). Use `--restricted --tools "" --strict-mcp-config --permission-mode dontAsk --disable-slash-commands --no-session-persistence` in an empty app-owned cwd.
- Loopback HTTP MCP with per-run bearer token in a temp config file, so ToolGate stays in the Electron main process and the same server serves Gemini's CLI.
- Policy risk: Anthropic's April 2026 harness block; our path matches the documented "end user signs in to the unmodified Claude Code binary" carve-out, but keep providers pluggable and never store tokens.
- Open question for the orchestrator: whether to keep `Read` enabled (confined) to avoid the `--json-schema` `$PARAMETER_NAME` retry bug and as the image fallback, or stay strictly tool-less.
