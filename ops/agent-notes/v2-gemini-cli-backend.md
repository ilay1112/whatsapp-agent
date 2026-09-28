# Agent notes: v2-gemini-cli-backend (research)

Dates: first pass 2026-09-27; second pass ("try again") 2026-09-28. Output: `docs/research/v2-gemini-cli-backend.md`.

## Method (second pass)
- Re-verified every headline claim of the first pass against primary sources: gemini-cli discussions #27274/#28017, the Code Assist deprecation page, geminicli.com auth/quota pages, antigravity.google docs (headless, install, permissions, mcp, settings, subagents, hooks, plans, models, faq, terms, sdk), the raw CHANGELOG.md (grepped locally), GitHub API for issue open/closed state, the five forum threads.
- Local: `where agy`, `where gemini`, directory listings of `~/.gemini`, sizes/dates of `settings.json` and `updater/`. Did not open `brain/`, `conversations/`, `history.jsonl`, `cli.log`, `mcp/*`. Ran no CLI (none installed). Did not touch the reference bridge store.

## Conclusions
1. User is right: Gemini CLI dropped free/Pro/Ultra Google login on 2026-06-18; Antigravity CLI (`agy`) is the replacement. API key / Vertex / Code Assist Standard-Enterprise still work in Gemini CLI.
2. Only subscription path: `agy -p` headless (json / stream-json / --json-schema / --agent / --model / --effort / --mode / --print-timeout / --disable-slash-commands; exit 0/1/2/3; AGY_ERROR stderr line). Antigravity SDK is API-key/Vertex only. IDE has no external API.
3. Policy is a gray zone: Terms §6 + FAQ forbid third-party tools; forum answers (badge unverified) say single-user child-process use is supported (Sep 7/15) but "powering third-party agents" is not (Sep 25); ban wave precedent Feb 27 2026. Recommendation unchanged: opt-in + disclosure, API key stays the supported path.
4. Tool-less design still recommended: #548 (headless ignores permissions) and #794 (schema + denied tool = fake success) are open.

## Corrections made in pass 2
- Non-TTY stdout bugs are fixed and closed (Windows verified on 1.1.13 / 1.2.11) - the wrapper can rely on piped stdout.
- #687 closed 2026-09-16. Default headless timeout unlimited since 1.2.6 (docs stale). Version gate now >= 1.2.11.
- Added `--disable-slash-commands` (untrusted prompt text may start with `/`), `denied_actions`, `excludeDefaultComponents`, headless `/usage`.
- Gemini CLI custom schema closed "not planned" 2026-05-06.

## Dead ends / assumptions
- Could not confirm staff badges of forum responders (fetch strips them). Marked UNVERIFIED.
- Image via `@path` in `-p` still unverified; no changelog entry covers it.
- No config-dir override env var exists; trust must be granted by editing the user's settings.json with consent.
- `AGY_ERROR` field names, `/usage` JSON fields, `agy models` format: build-time checks.

## Hand-off
- Build ticket: gate on agy >= 1.2.11; smoke test `--agent` + `--json-schema` + empty `init.tools` in the app-owned trusted workspace before enabling the provider.
- Consent record `cloud_gemini_cli` v1 must carry §6 text + date, the data-use note, the local transcript note and the user-level hooks note.
