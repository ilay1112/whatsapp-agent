# bridge-rebuild (2026-10-18)

## Result
- New exe: `resources/bridge/whatsapp-bridge.exe` = **37,538,577 bytes**, SHA-256
  **`150A85FC65B0D1989B692F3DA4399888D92CBC23AC9283E915D4E090C4358AB5`** (whatsmeow `v0.0.0-20261017175727-b2b1e71d45e2`,
  go1.27.0 windows/amd64, gcc 16.2.0 WinLibs UCRT r2). Built twice: identical SHA-256 (reproducible on this toolchain).
- Old pin (43,540,541 / `ac23221e...2ff5`) replaced everywhere live; historical mentions left on purpose:
  `docs/specs/build-plan.md` L62 (original plan), `docs/ACCEPTANCE.md` ~L250 (record of an earlier smoke run), `ops/PROGRESS.md`.
- The exe was never started (only `go version`, `gcc --version`, `go build` ran).

## Commands
```
export PATH="/c/Program Files/nodejs:/c/Program Files/Git/cmd:/c/Program Files/Go/bin:<WinLibs>/mingw64/bin:$PATH"
export CGO_ENABLED=1 CC=gcc
npm run -s build:bridge          # ~14 s; prints OK <bytes> bytes sha256 <HEX>, writes resources/bridge/SHA256SUMS
node scripts/hash-bridge.mjs     # hash-bridge: OK 37538577 bytes sha256 150A85FC...8AB5
npx vitest run scripts tests/security/bridge-invariants.test.ts src/main/bridge   # 28 files, 834 tests passed
npm run -s typecheck             # exit 0
npm run -s lint                  # exit 0
npm run -s format:check          # exit 1 ONLY because of .claude/worktrees/modest-fermat-cbe1c4 (another agent's worktree);
npx prettier --check src scripts tests docs package.json   # all clean
```

## scripts/build-bridge.mjs design
- `buildBridge({ spawnSync, writeFile, sizeOf, hash, env, srcDir, outExe, outSums, pinnedSha256, io })` - all side effects
  injectable; the unit test never runs `go` (tests/setup-guards T1 would refuse an argv naming whatsapp-bridge.exe anyway).
- Probes `go version` and `$CC --version` first; either missing -> exit 1 naming `winget install GoLang.Go` and
  `BrechtSanders.WinLibs.POSIX.UCRT`, nothing built or written.
- argv `['build','-trimpath','-buildvcs=false','-o',<abs repo>/resources/bridge/whatsapp-bridge.exe,'.']`, cwd
  `vendor/whatsapp-bridge-src`, `shell:false`. Deviation: `-o` is ABSOLUTE - a relative `resources/bridge/...` would land
  inside the vendor dir because cwd is the vendor dir.
- Env = process.env + `CGO_ENABLED=1`, `CC=$CC||gcc`, `GOTOOLCHAIN=$GOTOOLCHAIN||local` (addition: never auto-download a Go
  toolchain; an old Go then fails loudly on the go.mod floor).
- On success: SHA256SUMS via `sha256sumsLine` (import-bridge.mjs), prints size + sha, and a NOTE if it differs from the pin.

## Other edits
- `scripts/import-bridge.mjs`: header now says LEGACY; pins = new exe (so copying the reference exe now refuses, by design).
- `scripts/hash-bridge.mjs`: failure hint now says `npm run build:bridge`.
- `scripts/smoke-packaged.notices.mjs` + committed `resources/licenses/THIRD_PARTY_NOTICES.txt`: new sha, and the line
  "A prebuilt Go binary; ... for reference" -> "A Go binary built from the vendored source ... (`npm run build:bridge` ...)".
- `invariants.ts`/`invariants.test.ts` "43.5 MB" comments -> "~37.5 MB"; `bridge-contract.md` "~43.5 MB" -> "~37.5 MB".
- `docs/ARCHITECTURE.md` 4.1: new pin + "Bridge build" bullet; intake bullet marked legacy.
- `docs/research/bridge-contract.md` section 0: built-exe row, former-exe row, go.mod rows updated, "Bridge build" paragraph.
- `docs/ACCEPTANCE.md` L100 evidence text (requirement column = user's words, left unchanged).

## For the orchestrator
- `resources/bridge/whatsapp-bridge.exe` is tracked: the commit will carry a new 37.5 MB binary.
- Consider a periodic ticket: refresh whatsmeow (`go get go.mau.fi/whatsmeow@latest && go mod tidy`), rebuild, re-pin.
