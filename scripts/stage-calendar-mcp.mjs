#!/usr/bin/env node
// scripts/stage-calendar-mcp.mjs - ARCH 16 / 15.3: installs the isolated dependency tree of the bundled Google Calendar MCP
// server into `build-resources/calendar-mcp/node_modules` from the COMMITTED lockfile, with
// `npm ci --omit=dev --ignore-scripts`. electron-builder then copies that folder to `<resources>\calendar-mcp`
// (`extraResources` entry `{ from: build-resources/calendar-mcp, to: calendar-mcp }`).
//
//   node scripts/stage-calendar-mcp.mjs            install unless already staged
//   node scripts/stage-calendar-mcp.mjs --force    install even when `build/index.js` is already there
//   node scripts/stage-calendar-mcp.mjs --check    verify only; never installs (exit 1 when missing)
//
// `--ignore-scripts` is mandatory: nothing in that third-party tree may run a lifecycle script on this machine.
// The staged server is NEVER started by this script; W1-05 spawns it through the MCP host with injected deps.
// Owner W0 -> W2-04.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url)); // never URL.pathname - the repo path contains a space

/** `build-resources/calendar-mcp` - the isolated package root (has its own package.json + committed lockfile). */
export const MCP_DIR = join(REPO_ROOT, 'build-resources', 'calendar-mcp');
/** The stdio entry point W1-05 spawns with `ELECTRON_RUN_AS_NODE=1` (dev path; packaged path comes from `paths.ts`). */
export const MCP_ENTRY = join(MCP_DIR, 'node_modules', '@cocal', 'google-calendar-mcp', 'build', 'index.js');
/** Pinned server version - must equal the single dependency of `build-resources/calendar-mcp/package.json` (ARCH A4). */
export const MCP_PACKAGE = '@cocal/google-calendar-mcp';
export const MCP_VERSION = '2.6.3';

/**
 * The npm argv, as a flat array. `ci` (never `install`) so the committed lockfile is authoritative,
 * `--omit=dev` so no dev tree is shipped, `--ignore-scripts` so no third-party lifecycle script runs.
 */
export function stageArgs() {
  return ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
}

/**
 * Resolves the npm CLI js file so it can be run as `process.execPath <npm-cli.js> ...` with `shell: false`.
 * Spawning `npm.cmd` would need a shell (Node refuses `.cmd` without one), which this script never uses.
 */
export function npmCliPath(env = process.env, execPath = process.execPath) {
  const fromNpm = env.npm_execpath;
  if (fromNpm && fromNpm.endsWith('.js') && existsSync(fromNpm)) return fromNpm;
  const beside = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return existsSync(beside) ? beside : null;
}

/** True when the staged tree already exposes the server entry point. */
export function isStaged(entry = MCP_ENTRY) {
  return existsSync(entry);
}

/** Default runner: `node <npm-cli.js> ci ...` inside `cwd`, inheriting stdio, `shell: false`. */
function defaultRun(cliPath, args, cwd) {
  const r = spawnSync(process.execPath, [cliPath, ...args], { cwd, stdio: 'inherit', shell: false });
  if (r.error) return { status: 1, message: String(r.error.message) };
  return { status: r.status ?? 1 };
}

export async function main(
  argv = process.argv.slice(2),
  io = { out: process.stdout, err: process.stderr },
  run = defaultRun,
) {
  const force = argv.includes('--force');
  const checkOnly = argv.includes('--check');

  if (isStaged() && !force) {
    io.out.write(`stage-calendar-mcp: already staged - ${MCP_ENTRY}\n`);
    return 0;
  }
  if (checkOnly) {
    io.err.write(`stage-calendar-mcp: NOT staged - run \`npm run stage:mcp\` (expected ${MCP_ENTRY})\n`);
    return 1;
  }
  if (!existsSync(join(MCP_DIR, 'package-lock.json'))) {
    io.err.write(
      'stage-calendar-mcp: FAIL - build-resources/calendar-mcp/package-lock.json is missing (it is committed).\n',
    );
    return 1;
  }
  const cli = npmCliPath();
  if (!cli) {
    io.err.write('stage-calendar-mcp: FAIL - could not locate npm-cli.js next to this node binary.\n');
    return 1;
  }
  const args = stageArgs();
  io.out.write(`stage-calendar-mcp: npm ${args.join(' ')} in ${MCP_DIR}\n`);
  const r = run(cli, args, MCP_DIR);
  if (r.status !== 0) {
    io.err.write(`stage-calendar-mcp: FAIL - npm exited ${r.status}${r.message ? ` (${r.message})` : ''}\n`);
    return 1;
  }
  if (!isStaged()) {
    io.err.write(`stage-calendar-mcp: FAIL - npm succeeded but ${MCP_ENTRY} is still missing\n`);
    return 1;
  }
  io.out.write(`stage-calendar-mcp: OK ${MCP_PACKAGE}@${MCP_VERSION} -> ${MCP_ENTRY}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => process.exit(code));
}
