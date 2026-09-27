# Agent notes - spec "test-strategy"

Date: 2026-09-21. Output: `docs/specs/test-strategy.md`. No other project file was touched.

## What I read
- `docs/ARCHITECTURE.md` in full (binding).
- `docs/research/bridge-contract.md` sections 2-9 (REST contract, webhook, pairing, schema, stdout markers) - basis of the fake bridge.
- `docs/research/calendar-mcp.md` tool list + test hooks - basis of the fake MCP.
- `docs/research/electron-stack.md` sections 9-10 (vitest/Playwright config, E2E seams), `security-threat-model.md` section 12, `i18n-rtl.md` section 12.
- `docs/specs/agent-pipeline.md` did NOT exist yet (docs/specs was empty) - the golden-set record shape in my section 7.1 is a fallback that the pipeline spec overrides.

## Decisions and why
- Master seam name is `WCA_E2E` (the name in ARCH 15.1), not the brief's example `WA_AGENT_TEST_MODE`. One name only.
- Two locks for seams: build-time (`electron-vite build --mode e2e`, all seam code in `src/main/testSeams.ts`, eliminated from production bundles) plus the ARCH run-time lock (`!app.isPackaged`). Stricter than ARCH, not contradictory.
- Added a child-mode bridge seam (`WCA_BRIDGE_CMD`) next to ARCH's attach-mode seam (`WCA_FAKE_BRIDGE_URL`), because attach mode cannot test launcher/invariants/supervisor/reaper or "Quit kills children" end-to-end.
- Spawnable fakes are `.ts` files run by system Node 24 with native type stripping. I verified on this PC: Node v24.19.0 runs a `.ts` file importing `node:sqlite` without flags. Electron-as-Node is never used to run `.ts` fakes (unverified).
- Global "side-effect ledger" afterEach hook in integration, security and E2E: any send / create-event recorded by a fake must map to an approved action row. This is the main proof of I1 besides the import graph and the DB trigger.
- Packaged smoke never starts the packaged GUI (ARCH 15.1 forbids seams when packaged; a GUI start on the dev PC could spawn the real bridge from the real profile). First packaged GUI start is a manual item (M9). Logged as concern C1.

## Dead ends
- Considered loading `tests/fakes/stub-llm.ts` into the app via a dynamic import path from an env var: rejected (Electron's type stripping is unverified, and it would leave a dynamic-import seam in production code). Build-mode bundling is cleaner.
- Considered isolating the packaged app's profile with `APPDATA` env override or the Chromium `--user-data-dir` switch: both unverified on Electron 44, so not relied upon.

## Assumptions to confirm in Wave 0
- `electron-vite build --mode e2e` + `import.meta.env.MODE` constant folding removes the seam branch from the production main bundle (concern C9).
- vitest 4.1.11 per-glob `coverage.thresholds` with `perFile`.
- The real `@cocal/google-calendar-mcp@2.6.3` stays passive (no browser, no listener) during `initialize` + `tools/list` with dummy credentials (concern C7).

## Hand-off
- Wave 0 must land the items listed in section 15 of the spec (configs, guards, mocks, helper types, fake interfaces, `testSeams.ts`, npm scripts).
- Orchestrator: reconcile section 7.1 with `agent-pipeline.md` once it exists; decide on concerns C1-C3.

## Rule compliance
- Did not read, list or open the reference bridge `store\` folder; did not run any exe; did not use any session-connected MCP tool; no git commit; no installs. The only command executed besides reading docs was a throw-away `node strip.ts` type-stripping check in the session scratchpad (file removed).
