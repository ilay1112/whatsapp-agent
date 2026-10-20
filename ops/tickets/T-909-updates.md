# T-909 — In-app updates: every push to main → GitHub Release → banner + Settings › Updates

**Status:** in progress (2026-10-20)
**Owner:** orchestrator (plan, Fable 5.1) + Opus 5.5 workers W1–W3
**Spec + plan:** `docs/specs/v5-updates-handover.md`

## Request (user, 2026-10-20)
"add an update route for the app. every push to main should pop an update option for user. update should be in settings and a banner with an x to ignore in the main app"

Option-dialog answers: **portable folder update** (zip + SHA-256 on a GitHub Release, the app swaps its own folder); **check on launch + every 6 h**, banner with X (ignores that version), Settings › Updates with Check now / Install / stop ignoring.

## Shape
- CI (`.github/workflows/release.yml`) on push to main: fetch pinned llama/whisper, bundle the VC++ CRT (closes U10), stage MCP, lint/typecheck/unit, version `0.1.<run_number>`, package, smoke gate, zip, `release.json`, `gh release create`.
- Main `UpdateService`: GitHub API check (allow-list, https, one redirect hop), pinned download with sha256, pure-Node zip extraction, `updater.cjs` folder swap run by the new build's own exe as Node, audit + logs without URLs.
- Renderer: banner with X, Settings › Updates, toasts after an update.

## Progress
- [x] W1 CI + manifest (first CI run must pin the runner CRT hashes: `gh workflow run release.yml -f pin_crt=true`, commit the pins)  - [x] W2 main service + installer  - [ ] W3 renderer + e2e + docs  - [ ] review + proof + ship  - [ ] first CI release observed
