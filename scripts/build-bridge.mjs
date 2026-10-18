#!/usr/bin/env node
// scripts/build-bridge.mjs - builds resources/bridge/whatsapp-bridge.exe from the vendored Go source (ARCH 4.1 "Bridge build").
//
//   npm run build:bridge        (= node scripts/build-bridge.mjs)
//
// Runs, in vendor/whatsapp-bridge-src, with CGO_ENABLED=1 and CC=$CC (default gcc), shell:false:
//   go build -trimpath -buildvcs=false -o <repo>/resources/bridge/whatsapp-bridge.exe .
// then writes resources/bridge/SHA256SUMS (`<UPPERCASE SHA256>  whatsapp-bridge.exe`) and prints the size + SHA-256.
// The built exe is NEVER started by this script (hard rule): the only processes it runs are `go` and the C compiler probe.
// After a rebuild the pins (scripts/import-bridge.mjs, src/main/bridge/invariants.ts, ...) must be updated to the printed values;
// `node scripts/hash-bridge.mjs` is the gate that proves they agree.
// Why: WhatsApp refuses clients whose whatsmeow is older than a few months (ClientOutdated, 2026-10-18), so the library pinned in
// vendor/whatsapp-bridge-src/go.mod has to be refreshed periodically and the exe rebuilt.
import { spawnSync as realSpawnSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile } from './hash-bridge.mjs';
import { BRIDGE_EXE_SHA256, sha256sumsLine } from './import-bridge.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url)); // the project path contains a space: never URL.pathname
export const BRIDGE_SRC_DIR = join(REPO_ROOT, 'vendor', 'whatsapp-bridge-src');
export const BRIDGE_OUT_EXE = join(REPO_ROOT, 'resources', 'bridge', 'whatsapp-bridge.exe');
export const BRIDGE_OUT_SUMS = join(REPO_ROOT, 'resources', 'bridge', 'SHA256SUMS');

export const TOOLCHAIN_HINT =
  'Install the toolchain first: `winget install GoLang.Go` (Go >= 1.26) and `winget install BrechtSanders.WinLibs.POSIX.UCRT` ' +
  '(gcc for CGO / go-sqlite3), then open a new shell so both are on PATH.';

/** The exact `go` argv (the output path is absolute because the build runs with cwd = vendor/whatsapp-bridge-src). */
export function goBuildArgs(outExe = BRIDGE_OUT_EXE) {
  return ['build', '-trimpath', '-buildvcs=false', '-o', outExe, '.'];
}

/** Build environment: the caller's env plus CGO_ENABLED=1 and CC (from env, default gcc). GOTOOLCHAIN=local: never auto-download a Go toolchain. */
export function buildEnv(env = process.env) {
  return { ...env, CGO_ENABLED: '1', CC: env.CC || 'gcc', GOTOOLCHAIN: env.GOTOOLCHAIN || 'local' };
}

const missing = (r) => !r || (r.error && r.error.code === 'ENOENT');

/**
 * Builds the bridge. Every side effect is injectable so the unit test never runs `go`, never writes into resources/ and never
 * touches a real exe. Returns the process exit code (0 ok, 1 refused / failed).
 */
export async function buildBridge({
  spawnSync = realSpawnSync,
  writeFile = (p, text) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text, 'utf8');
  },
  sizeOf = (p) => statSync(p).size,
  hash = hashFile,
  env = process.env,
  srcDir = BRIDGE_SRC_DIR,
  outExe = BRIDGE_OUT_EXE,
  outSums = BRIDGE_OUT_SUMS,
  pinnedSha256 = BRIDGE_EXE_SHA256,
  io = { out: process.stdout, err: process.stderr },
} = {}) {
  const e = buildEnv(env);
  const probe = { shell: false, windowsHide: true, encoding: 'utf8', env: e };

  const goVer = spawnSync('go', ['version'], probe);
  if (missing(goVer) || goVer.status !== 0) {
    io.err.write(`build-bridge: REFUSED - \`go\` was not found on PATH. ${TOOLCHAIN_HINT}\n`);
    return 1;
  }
  const ccVer = spawnSync(e.CC, ['--version'], probe);
  if (missing(ccVer) || ccVer.status !== 0) {
    io.err.write(`build-bridge: REFUSED - C compiler \`${e.CC}\` (CGO) was not found on PATH. ${TOOLCHAIN_HINT}\n`);
    return 1;
  }
  io.out.write(
    `build-bridge: ${String(goVer.stdout || '').trim()}; CC=${e.CC}; building in vendor/whatsapp-bridge-src ...\n`,
  );

  const r = spawnSync('go', goBuildArgs(outExe), {
    cwd: srcDir,
    shell: false,
    windowsHide: true,
    stdio: 'inherit',
    env: e,
  });
  if (missing(r) || r.status !== 0) {
    io.err.write(`build-bridge: FAIL - go build exited with ${r && r.status !== undefined ? r.status : 'an error'}\n`);
    return 1;
  }

  const bytes = sizeOf(outExe);
  const sha256 = String(await hash(outExe)).toLowerCase();
  writeFile(outSums, sha256sumsLine(sha256, 'whatsapp-bridge.exe'));
  io.out.write(
    `build-bridge: OK ${bytes} bytes sha256 ${sha256.toUpperCase()} -> resources/bridge/whatsapp-bridge.exe\n`,
  );
  if (sha256 !== String(pinnedSha256).toLowerCase()) {
    io.out.write(
      'build-bridge: NOTE - differs from the committed pin; update BRIDGE_EXE (src/main/bridge/invariants.ts), ' +
        'scripts/import-bridge.mjs and the docs, then run `node scripts/hash-bridge.mjs`.\n',
    );
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildBridge().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`build-bridge: FAIL - ${err && err.message ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
