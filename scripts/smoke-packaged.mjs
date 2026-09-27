#!/usr/bin/env node
// scripts/smoke-packaged.mjs - L6 packaging smoke (TESTS section 11, ARCH 15.4). Owner: W2-04-packaging.
//
//   node scripts/smoke-packaged.mjs "dist/win-unpacked" [--allow-missing-bridge]
//
// Runs the six checks of TESTS section 11 against an `electron-builder --dir` tree, plus check 4a (below):
//   4a. the packaged calendar MCP server: `<resources>\calendar-mcp\node_modules` must carry the whole staged tree.
//      Its own hard check, run FIRST, because the verbatim ARCH 15.2 `extraResources` block ships a package with no
//      calendar server at all (electron-builder drops a matcher's ROOT node_modules) and checks 1/2 would report that
//      shipping blocker as a spawn failure;
//   1. fuse alive + the real calendar MCP server reachable THROUGH the packaged exe under ELECTRON_RUN_AS_NODE=1
//      (initialize + tools/list === the six names of ARCH 5.1; 20 s budget; killed by PID);
//   2. one real `tools/call` through the packaged binary, against a type-stripped copy of
//      `tests/fakes/fake-mcp-calendar.ts` (step 1 cannot call a tool - there is no Google account);
//   3. the fuse wire read back with `@electron/fuses` === the ARCH 15.2 values;
//   4. resources present; the packaged `whatsapp-bridge.exe` STREAMS to the pinned SHA-256 (hashing only);
//      every file of `vendor/llama/MANIFEST.txt`; the staged calendar-mcp entry; icons, links.json, licenses;
//   5. `app.asar` LISTING (never extracted into a temp app): required entries present; no `*.map`, `tests/`,
//      `*.node`, `binding.gyp`, no forbidden root-declared package, no seam string in the main bundle,
//      no `app.asar.unpacked` directory;
//   6. the no-GUI rule: this script NEVER starts the packaged app as a GUI. Every spawn it makes is recorded and
//      asserted to carry ELECTRON_RUN_AS_NODE=1, i.e. the binary only ever runs as plain Node here.
//      Starting the packaged/installed GUI is manual checklist item M9 and is a job for the user, never an agent.
//
// Exit codes: 0 = pass, 1 = fail, 3 = SMOKE INCOMPLETE (`--allow-missing-bridge`; never a release result).
//
// No binary from `resources\bridge` or `resources\llama` is ever EXECUTED: the bridge exe is only hashed and
// llama-server.exe is only checked for existence.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getCurrentFuseWire, FuseV1Options, FuseState } from '@electron/fuses';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import { BRIDGE_EXE_SHA256, BRIDGE_EXE_SIZE } from './import-bridge.mjs';
import { hashFile, parseSums } from './hash-bridge.mjs';

const require = createRequire(import.meta.url);
/** `@electron/asar` is CJS and has no `exports` map; the default import is its `module.exports`. */
const asar = require('@electron/asar');

export const OWNER = 'W2-04-packaging';
/** TESTS 11: `--allow-missing-bridge` produces this exit code, never 0 - it is not a release result. */
export const EXIT_SMOKE_INCOMPLETE = 3;

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url)); // never URL.pathname - the repo path contains a space

// =====================================================================================================================
// frozen expectations (all copied from ARCH / TESTS; a drift here must fail the build, not be "fixed" silently)
// =====================================================================================================================

/** ARCH 5.1 `ENABLED_TOOLS`, in the order the architecture lists them. `tools/list` must equal this SET exactly. */
export const EXPECTED_MCP_TOOLS = [
  'get-current-time',
  'get-freebusy',
  'list-events',
  'list-calendars',
  'create-event',
  'manage-accounts',
];

/**
 * ARCH 15.4 `[R2]`: the fixture credentials file, EXACTLY this shape. `redirect_uris[0]` is dereferenced by the
 * server BEFORE the MCP handshake; a fixture without it throws a TypeError that reads exactly like a flipped fuse.
 * These are not credentials: `TESTONLY` is a literal placeholder and no Google endpoint is ever contacted.
 */
export const OAUTH_FIXTURE = {
  installed: {
    client_id: 'TESTONLY.apps.googleusercontent.com',
    client_secret: 'TESTONLY',
    redirect_uris: ['http://localhost'],
  },
};

/** TESTS 4.1 lock 1: a PRODUCTION bundle must contain none of these. */
export const SEAM_STRINGS = ['WCA_E2E', 'WCA_BRIDGE_CMD', 'WCA_LLM', '__wcaTest', 'stub-llm'];

/**
 * ARCH 16 forbidden packages, checked as ROOT-DECLARED entries inside `app.asar` (`node_modules/<name>`).
 * `ajv` / `ajv-formats` are expected DEEPER in the tree (under `@modelcontextprotocol/sdk`) and are allowed there.
 */
export const FORBIDDEN_PACKAGES = [
  'node-llama-cpp',
  'better-sqlite3',
  'electron-rebuild',
  'electron-store',
  'electron-updater',
  'openai',
  'ajv',
  'ipull',
  'tree-kill',
  'dependency-cruiser',
];
/** Same rule, as prefixes: `@electron-toolkit/*` and the `i18next-*` plugin family. */
export const FORBIDDEN_PACKAGE_PREFIXES = ['@electron-toolkit/', 'i18next-'];
/**
 * ARCH 16 `[R2]` explicit allow-list of TRANSITIVE occurrences. npm hoists, so `@modelcontextprotocol/sdk`'s own
 * `ajv` physically lands at `node_modules/ajv` inside the archive even though nothing declares it. The real rule
 * ("no forbidden name in the root package.json") is therefore checked separately, against the package.json that
 * `app.asar` actually carries - see `declaredDependencyProblems`.
 */
export const TRANSITIVE_ALLOWED = ['ajv', 'ajv-formats'];

/** ARCH 15.2 `electronFuses`. Fuses the architecture does not name are not asserted. */
export const EXPECTED_FUSES = {
  [FuseV1Options.RunAsNode]: FuseState.ENABLE, // REQUIRED by the MCP stdio child (A4)
  [FuseV1Options.EnableCookieEncryption]: FuseState.ENABLE,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE,
  [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.DISABLE, // [LR] UNVERIFIED on Windows
  [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: FuseState.DISABLE,
};

export const FUSE_NAMES = {
  [FuseV1Options.RunAsNode]: 'runAsNode',
  [FuseV1Options.EnableCookieEncryption]: 'enableCookieEncryption',
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: 'enableNodeOptionsEnvironmentVariable',
  [FuseV1Options.EnableNodeCliInspectArguments]: 'enableNodeCliInspectArguments',
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: 'enableEmbeddedAsarIntegrityValidation',
  [FuseV1Options.OnlyLoadAppFromAsar]: 'onlyLoadAppFromAsar',
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: 'grantFileProtocolExtraPrivileges',
};

export const PRODUCT_EXE = 'WhatsApp Calendar Agent.exe';
export const MCP_PACKAGE_REL = join('calendar-mcp', 'node_modules', '@cocal', 'google-calendar-mcp');
export const MCP_REL_ENTRY = join(MCP_PACKAGE_REL, 'build', 'index.js');
export const MCP_TIMEOUT_MS = 20_000;
/** The staging `scripts/stage-calendar-mcp.mjs` produces; check 4a compares the package against it. */
export const STAGED_MCP_NODE_MODULES = join(REPO_ROOT, 'build-resources', 'calendar-mcp', 'node_modules');
/**
 * The one line `electron-builder.yml` must carry for the staged server to reach the package at all. Quoted verbatim
 * in the check 4a failure message, because the fix is not guessable from the symptom.
 */
export const CALENDAR_NODE_MODULES_MATCHER =
  '- { from: build-resources/calendar-mcp/node_modules, to: calendar-mcp/node_modules }';

// =====================================================================================================================
// pure helpers (no fs, no spawn - these are what the unit tests drive)
// =====================================================================================================================

/** Compares a `getCurrentFuseWire` result against ARCH 15.2. Returns one line per disagreement. */
export function fuseProblems(wire) {
  const problems = [];
  for (const [key, expected] of Object.entries(EXPECTED_FUSES)) {
    const actual = wire?.[key];
    if (actual !== expected) {
      problems.push(
        `fuse ${FUSE_NAMES[key] ?? key}: expected ${describeFuse(expected)}, packaged exe has ${describeFuse(actual)}`,
      );
    }
  }
  return problems;
}

export function describeFuse(state) {
  if (state === FuseState.ENABLE) return 'ENABLE';
  if (state === FuseState.DISABLE) return 'DISABLE';
  if (state === FuseState.REMOVED) return 'REMOVED';
  if (state === FuseState.INHERIT) return 'INHERIT';
  return `<${String(state)}>`;
}

/** `tools/list` names must equal the six of ARCH 5.1 exactly - extra and missing are both fatal. */
export function toolListProblems(names) {
  const got = [...names].sort();
  const want = [...EXPECTED_MCP_TOOLS].sort();
  if (got.length === want.length && got.every((n, i) => n === want[i])) return [];
  const missing = want.filter((n) => !got.includes(n));
  const extra = got.filter((n) => !want.includes(n));
  const parts = [];
  if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`);
  if (extra.length > 0) parts.push(`unexpected ${extra.join(', ')}`);
  return [`tools/list does not equal the six ARCH 5.1 names (${parts.join('; ')})`];
}

/**
 * ARCH 15.4 / TESTS 11: the two failure modes of check 1 read identically from the outside, so they are
 * separated deliberately.
 *  - the child exited non-zero and said `Failed to start server`  => the FIXTURE or the server runtime is wrong;
 *  - the child is still alive, produced no JSON-RPC line in 20 s   => `runAsNode` is OFF and the exe started as a GUI.
 */
export function classifyMcpFailure({ exited, exitCode, stderr, sawJsonRpc, timedOut }) {
  if (sawJsonRpc) return null;
  const text = String(stderr ?? '');
  if (exited && exitCode !== 0 && /Failed to start server/i.test(text)) {
    return {
      mode: 'fixture',
      message:
        `fixture/runtime problem: the MCP server exited ${String(exitCode)} with "Failed to start server". ` +
        'The packaged exe DID run as Node (the fuse is fine); the credentials fixture or the staged server is wrong.',
    };
  }
  if (exited) {
    return {
      mode: 'fixture',
      message:
        `fixture/runtime problem: the MCP child exited ${String(exitCode)} before any JSON-RPC reply. stderr tail: ` +
        `${text.trim().split(/\r?\n/).slice(-4).join(' | ') || '(empty)'}`,
    };
  }
  if (timedOut) {
    return {
      mode: 'fuse',
      message:
        `fuse flipped: the packaged exe stayed alive for ${String(MCP_TIMEOUT_MS / 1000)} s and wrote no JSON-RPC to ` +
        'stdout. With ELECTRON_RUN_AS_NODE=1 honoured it would have answered `initialize`; instead it ignored the ' +
        'variable and started as an Electron GUI process. Check `electronFuses.runAsNode: true` in electron-builder.yml.',
    };
  }
  return { mode: 'unknown', message: 'the MCP child produced no JSON-RPC reply (no exit, no timeout recorded)' };
}

/**
 * CHECK 4a - "the package actually carries the calendar MCP server".
 *
 * This is a HARD check with its own message, not a by-product of "some file is missing", because the regression it
 * guards is silent, shipping-grade and not guessable from the symptom:
 *
 *   `extraResources: - { from: build-resources/calendar-mcp, to: calendar-mcp }` (the verbatim ARCH 15.2 block)
 *   copies ONLY package.json + package-lock.json. `app-builder-lib/out/util/filter.js` rejects a matcher's ROOT
 *   node_modules before any pattern is consulted:
 *       if (relative === "node_modules") { return false; }
 *   so no `filter:` entry can bring it back (measured: `filter: ['**\/*', 'node_modules/**']` still copies 0 files).
 *   The build stays green, every unit/integration test stays green - and the installed app has no calendar server:
 *   `mcp/host.ts` can never spawn it and every calendar feature is dead at run time.
 *
 * Inputs are plain data so the decision logic is unit-tested without a packaged tree:
 * @param {object} input
 * @param {string[]|null} input.stagedPackages   top-level names under build-resources/calendar-mcp/node_modules
 *                                               (`null` = the folder does not exist; dot-entries excluded)
 * @param {string[]|null} input.packagedPackages the same listing inside `<resources>\calendar-mcp\node_modules`
 * @param {boolean} input.entryExists            `<resources>\` + MCP_REL_ENTRY exists
 * @param {boolean} input.packageJsonExists      `<resources>\calendar-mcp\package.json` exists (ARCH 15.3)
 * @param {boolean} input.lockExists             `<resources>\calendar-mcp\package-lock.json` exists (ARCH 15.3)
 * @returns {string[]} one line per problem; empty = pass
 */
export function calendarServerProblems({
  stagedPackages,
  packagedPackages,
  entryExists,
  packageJsonExists,
  lockExists,
}) {
  const problems = [];
  const staged = stagedPackages ?? [];
  const packaged = packagedPackages ?? [];

  if (packaged.length === 0) {
    if (staged.length === 0) {
      // Not a packaging fault: there was nothing to copy in the first place.
      problems.push(
        'the calendar MCP server was never STAGED: build-resources\\calendar-mcp\\node_modules is empty or missing. ' +
          'Run `npm run stage:mcp` (npm ci --omit=dev --ignore-scripts from the committed lockfile) and re-pack. ' +
          'Until then this run cannot prove anything about the packaging of the server.',
      );
    } else {
      problems.push(
        `PACKAGING REGRESSION - the packaged app contains NO calendar server: <resources>\\calendar-mcp\\node_modules ` +
          `is empty although build-resources\\calendar-mcp\\node_modules holds ${String(staged.length)} packages. ` +
          "Cause: electron-builder drops a matcher's ROOT node_modules unconditionally " +
          '(app-builder-lib/out/util/filter.js: `if (relative === "node_modules") return false`), before any ' +
          '`filter:` pattern is consulted - so an explicit `node_modules/**` include does NOT help (measured: 0 files). ' +
          `Fix: keep a SECOND extraResources matcher rooted AT that folder in electron-builder.yml:  ${CALENDAR_NODE_MODULES_MATCHER}  ` +
          'Without it mcp/host.ts can never spawn the server and every calendar feature is dead at run time.',
      );
    }
    return problems; // everything below would only repeat this one cause
  }

  if (!entryExists) {
    problems.push(
      `the calendar MCP entry point ${MCP_REL_ENTRY} is missing although ${String(packaged.length)} package folder(s) ` +
        'were copied into <resources>\\calendar-mcp\\node_modules - the staged tree is incomplete or the wrong ' +
        'server version was staged. Re-run `npm run stage:mcp` and re-pack.',
    );
  }

  const missing = staged.filter((name) => !packaged.includes(name));
  if (missing.length > 0) {
    problems.push(
      `PARTIAL COPY of the calendar server: ${String(missing.length)} of ${String(staged.length)} staged top-level ` +
        `package folder(s) never reached <resources>\\calendar-mcp\\node_modules (first missing: ` +
        `${missing.slice(0, 6).join(', ')}). A dependency of the server will fail to resolve at run time; check the ` +
        'extraResources matchers in electron-builder.yml - nothing may filter that tree.',
    );
  }

  if (!packageJsonExists) {
    problems.push('<resources>\\calendar-mcp\\package.json is missing - ARCH 15.3 requires it beside node_modules');
  }
  if (!lockExists) {
    problems.push(
      '<resources>\\calendar-mcp\\package-lock.json is missing - ARCH 15.3 ships the committed lockfile with the server',
    );
  }
  return problems;
}

/** `vendor/llama/MANIFEST.txt` -> the file names it lists (MANIFEST.txt itself is not one of them). */
export function manifestNames(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== 'MANIFEST.txt');
}

/** True when `entry` is `node_modules/<name>` at the TOP level of the archive (root-declared), not nested. */
export function rootDeclaredPackage(entry) {
  const p = entry.replace(/\\/g, '/').replace(/^\/+/, '');
  const m = /^node_modules\/(@[^/]+\/[^/]+|[^/]+)$/.exec(p);
  return m ? m[1] : null;
}

/**
 * The literal ARCH 16 rule, applied to the `package.json` that `app.asar` carries: no forbidden name may appear in
 * the root `dependencies` / `devDependencies`. There is NO transitive allow-list here - a declared `ajv` is a
 * violation even though a hoisted one is not.
 */
export function declaredDependencyProblems(packageJsonText) {
  let pkg;
  try {
    pkg = JSON.parse(packageJsonText);
  } catch {
    return ['app.asar/package.json is not valid JSON'];
  }
  const problems = [];
  for (const field of ['dependencies', 'devDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (FORBIDDEN_PACKAGES.includes(name) || FORBIDDEN_PACKAGE_PREFIXES.some((p) => name.startsWith(p))) {
        problems.push(`app.asar/package.json declares the forbidden package "${name}" in ${field} (ARCH 16)`);
      }
    }
  }
  if (Object.keys(pkg.devDependencies ?? {}).length > 0) {
    problems.push(
      'app.asar/package.json still carries devDependencies - the packaged manifest should be production-only',
    );
  }
  return problems;
}

/**
 * The whole of check 5, over a plain list of archive entries plus the text of the main bundle and of package.json.
 * Returns one line per problem; an empty array is a pass.
 */
export function asarProblems({ entries, mainBundleText, packageJsonText, hasUnpackedDir }) {
  const problems = [];
  const norm = entries.map((e) => e.replace(/\\/g, '/').replace(/^\/+/, ''));
  const set = new Set(norm);

  for (const required of ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html', 'package.json']) {
    if (!set.has(required)) problems.push(`app.asar is missing the required entry ${required}`);
  }
  if (!norm.some((e) => /^out\/renderer\/assets\/.+\.js$/.test(e))) {
    problems.push('app.asar contains no built renderer script under out/renderer/assets/');
  }
  if (!norm.some((e) => /^out\/renderer\/assets\/.+\.css$/.test(e))) {
    problems.push('app.asar contains no built renderer stylesheet under out/renderer/assets/');
  }

  for (const e of norm) {
    if (e.endsWith('.map')) problems.push(`app.asar contains a source map: ${e}`);
    if (e.endsWith('.node')) problems.push(`app.asar contains a native addon: ${e}`);
    if (basename(e) === 'binding.gyp') problems.push(`app.asar contains a native build file: ${e}`);
    if (/^tests\//.test(e)) problems.push(`app.asar contains test material: ${e}`);
    if (basename(e) === '.e2e-build') {
      problems.push(
        `app.asar contains the e2e marker ${e} - this tree was built by \`build:e2e\`, or a stale marker survived ` +
          '`npm run build` (TESTS 14 says the production build rewrites out/ without it).',
      );
    }
    const pkg = rootDeclaredPackage(e);
    if (pkg === null || TRANSITIVE_ALLOWED.includes(pkg)) continue;
    if (FORBIDDEN_PACKAGES.includes(pkg) || FORBIDDEN_PACKAGE_PREFIXES.some((p) => pkg.startsWith(p))) {
      problems.push(`app.asar ships the forbidden package node_modules/${pkg} (ARCH 16)`);
    }
  }

  if (packageJsonText !== undefined) problems.push(...declaredDependencyProblems(packageJsonText));

  for (const seam of SEAM_STRINGS) {
    if (String(mainBundleText).includes(seam)) {
      problems.push(`the packaged main bundle contains the seam string "${seam}" (TESTS 4.1 lock 1)`);
    }
  }

  if (hasUnpackedDir) {
    problems.push(
      'resources\\app.asar.unpacked exists - ARCH 15.2 ships nothing unpacked (npmRebuild: false, no asarUnpack)',
    );
  }
  return problems;
}

// =====================================================================================================================
// a minimal newline-delimited JSON-RPC client over a child's stdio
// =====================================================================================================================

/** Every spawn this script makes, for the check-6 assertion. Exported so the unit test can inspect it. */
export const SPAWNS = [];

/**
 * Spawns the PACKAGED exe as plain Node. `ELECTRON_RUN_AS_NODE=1` is not optional and not a parameter:
 * this script must never be able to start the packaged app as a GUI (TESTS 11 check 6).
 */
function spawnAsNode(exePath, args, extraEnv) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    ...extraEnv,
    // Belt and braces: even if something above tried, these can never re-enable a GUI or a debugger.
    ELECTRON_NO_ATTACH_CONSOLE: '1',
  };
  SPAWNS.push({ exePath, args, runAsNode: env.ELECTRON_RUN_AS_NODE });
  return spawn(exePath, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env });
}

/**
 * initialize -> notifications/initialized -> tools/list -> (optional) one tools/call, over stdio.
 * Resolves `{ ok, tools, callText, failure }`; never throws for a protocol failure, and always kills by PID.
 */
async function mcpSession({ exePath, args, env, callTool, timeoutMs = MCP_TIMEOUT_MS, log }) {
  const child = spawnAsNode(exePath, args, env);
  const pending = new Map();
  let stdoutBuf = '';
  let stderr = '';
  let sawJsonRpc = false;
  let exited = false;
  let exitCode = null;
  let timedOut = false;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line === '') continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a server that prints a banner on stdout is tolerated; only JSON-RPC lines count
      }
      if (msg.jsonrpc !== '2.0') continue;
      sawJsonRpc = true;
      const waiter = msg.id !== undefined && pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter(msg);
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
  });
  child.on('exit', (code) => {
    exited = true;
    exitCode = code;
    for (const [, waiter] of pending) waiter(null);
    pending.clear();
  });

  const deadline = Date.now() + timeoutMs;
  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolveRpc) => {
      const id = nextId++;
      pending.set(id, resolveRpc);
      const left = deadline - Date.now();
      const timer = setTimeout(
        () => {
          if (pending.delete(id)) {
            timedOut = true;
            resolveRpc(null);
          }
        },
        Math.max(1, left),
      );
      timer.unref();
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch {
        if (pending.delete(id)) resolveRpc(null);
      }
    });

  const finish = (result) => {
    // Kill by PID (TESTS 11): the child is a plain Node process here, so this ends the whole session.
    try {
      if (!exited && typeof child.pid === 'number') process.kill(child.pid);
    } catch {
      /* already gone */
    }
    return result;
  };

  const init = await request('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'wca-smoke-packaged', version: '1.0.0' },
  });
  if (init === null || init.error) {
    return finish({
      ok: false,
      failure: classifyMcpFailure({ exited, exitCode, stderr, sawJsonRpc, timedOut }) ?? {
        mode: 'protocol',
        message: `initialize failed: ${JSON.stringify(init?.error ?? null)}`,
      },
    });
  }
  log?.(
    `      initialize OK (server ${init.result?.serverInfo?.name ?? '?'} ${init.result?.serverInfo?.version ?? ''})`,
  );
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  } catch {
    /* the exit handler reports it */
  }

  const listed = await request('tools/list', {});
  if (listed === null || listed.error || !Array.isArray(listed.result?.tools)) {
    return finish({
      ok: false,
      failure: classifyMcpFailure({ exited, exitCode, stderr, sawJsonRpc, timedOut }) ?? {
        mode: 'protocol',
        message: `tools/list failed: ${JSON.stringify(listed?.error ?? null)}`,
      },
    });
  }
  const tools = listed.result.tools.map((t) => t.name);

  let callText = null;
  if (callTool) {
    const called = await request('tools/call', { name: callTool.name, arguments: callTool.args ?? {} });
    if (called === null || called.error) {
      return finish({
        ok: false,
        tools,
        failure: {
          mode: 'protocol',
          message: `tools/call ${callTool.name} failed: ${JSON.stringify(called?.error ?? null)}`,
        },
      });
    }
    if (called.result?.isError === true) {
      return finish({
        ok: false,
        tools,
        failure: { mode: 'protocol', message: `tools/call ${callTool.name} returned isError` },
      });
    }
    callText = (called.result?.content ?? []).map((c) => c.text ?? '').join('');
  }
  return finish({ ok: true, tools, callText });
}

// =====================================================================================================================
// check 2 fixture: a runnable copy of the fake, type-stripped with node:module
// =====================================================================================================================

/**
 * `tests/fakes/fake-mcp-calendar.ts` only auto-starts when `process.argv[1]` ends in `.ts` (its own guard), so the
 * stripped `.mjs` copy needs a 9-line launcher beside it. That launcher uses the fake's PUBLIC export
 * (`createFakeCalendar`) - it is not a re-implementation of the fake.
 * Both files are written INSIDE the repo so `@modelcontextprotocol/sdk` and `zod` resolve from the root node_modules.
 */
export function writeStrippedFake({ sourcePath, outDir, stripTypeScriptTypes }) {
  mkdirSync(outDir, { recursive: true });
  const stripped = stripTypeScriptTypes(readFileSync(sourcePath, 'utf8'), { mode: 'strip' });
  const fakePath = join(outDir, 'fake-mcp-calendar.mjs');
  const launcherPath = join(outDir, 'launch-fake-mcp-calendar.mjs');
  writeFileSync(fakePath, stripped, 'utf8');
  writeFileSync(
    launcherPath,
    [
      '// generated by scripts/smoke-packaged.mjs - starts the type-stripped fake as an MCP stdio server.',
      "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
      "import { createFakeCalendar } from './fake-mcp-calendar.mjs';",
      '',
      'const enabled =',
      "  process.env.ENABLED_TOOLS === undefined ? undefined : process.env.ENABLED_TOOLS.split(',').filter((s) => s.length > 0);",
      'const fake = createFakeCalendar({ enabledTools: enabled });',
      'await fake.server.connect(new StdioServerTransport());',
      '',
    ].join('\n'),
    'utf8',
  );
  return { fakePath, launcherPath };
}

// =====================================================================================================================
// the six checks
// =====================================================================================================================

function ok(log, line) {
  log(`  [ok]   ${line}`);
}
function bad(problems, log, line) {
  problems.push(line);
  log(`  [FAIL] ${line}`);
}

/** Top-level entry names of a directory, `null` when it does not exist. Dot-entries (`.bin`) are not packages. */
function packageFolderNames(dir) {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith('.'));
  } catch {
    return null;
  }
}

/**
 * Check 4a - the packaged calendar MCP server. Runs FIRST: checks 1 and 2 both spawn that server, so without this
 * line a missing server reads as "the MCP child exited" and the reader goes looking for a flipped fuse.
 */
function check4aCalendarServer({ resourcesDir, log, problems }) {
  const packagedRoot = join(resourcesDir, 'calendar-mcp');
  const staged = packageFolderNames(STAGED_MCP_NODE_MODULES);
  const packaged = packageFolderNames(join(packagedRoot, 'node_modules'));
  const cp = calendarServerProblems({
    stagedPackages: staged,
    packagedPackages: packaged,
    entryExists: existsSync(join(resourcesDir, MCP_REL_ENTRY)),
    packageJsonExists: existsSync(join(packagedRoot, 'package.json')),
    lockExists: existsSync(join(packagedRoot, 'package-lock.json')),
  });
  for (const p of cp) bad(problems, log, `check 4a - ${p}`);
  if (cp.length === 0) {
    ok(
      log,
      `check 4a - calendar server packaged: all ${String((staged ?? []).length)} staged package folder(s), ` +
        `${MCP_REL_ENTRY} and the ARCH 15.3 package.json/package-lock.json are in <resources>\\calendar-mcp`,
    );
  }
}

async function check1Mcp({ exePath, resourcesDir, tmpDir, log, problems }) {
  const entry = join(resourcesDir, MCP_REL_ENTRY);
  if (!existsSync(entry)) {
    bad(
      problems,
      log,
      `check 1 - skipped: the calendar MCP entry is missing from the package: ${entry}. Check 4a above says why ` +
        '(staging vs the extraResources matchers of electron-builder.yml).',
    );
    return;
  }
  const credsPath = join(tmpDir, 'smoke-oauth-fixture.json');
  writeFileSync(credsPath, JSON.stringify(OAUTH_FIXTURE), 'utf8');

  const r = await mcpSession({
    exePath,
    args: [entry, 'start', '--transport', 'stdio'],
    env: {
      GOOGLE_OAUTH_CREDENTIALS: credsPath,
      GOOGLE_CALENDAR_MCP_TOKEN_PATH: join(tmpDir, 'smoke-tokens.json'),
      GOOGLE_ACCOUNT_MODE: 'personal',
      ENABLED_TOOLS: EXPECTED_MCP_TOOLS.join(','),
    },
    log,
  });
  if (!r.ok) {
    bad(problems, log, `check 1 - ${r.failure.message}`);
    return;
  }
  const listProblems = toolListProblems(r.tools);
  if (listProblems.length > 0) {
    for (const p of listProblems) bad(problems, log, `check 1 - ${p}`);
    return;
  }
  ok(log, `check 1 - the packaged exe ran as Node and the real MCP server listed exactly the six ARCH 5.1 tools`);
}

async function check2ToolCall({ exePath, tmpDir, log, problems }) {
  const { stripTypeScriptTypes } = await import('node:module');
  if (typeof stripTypeScriptTypes !== 'function') {
    bad(
      problems,
      log,
      'check 2 - node:module.stripTypeScriptTypes is unavailable (Node 24 is required, ARCH 16 engines)',
    );
    return;
  }
  const source = join(REPO_ROOT, 'tests', 'fakes', 'fake-mcp-calendar.ts');
  if (!existsSync(source)) {
    bad(problems, log, `check 2 - ${source} is missing`);
    return;
  }
  let launcherPath;
  try {
    ({ launcherPath } = writeStrippedFake({ sourcePath: source, outDir: tmpDir, stripTypeScriptTypes }));
  } catch (err) {
    bad(problems, log, `check 2 - could not type-strip the fake: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const r = await mcpSession({
    exePath,
    args: [launcherPath],
    env: { ENABLED_TOOLS: EXPECTED_MCP_TOOLS.join(',') },
    callTool: { name: 'get-current-time', args: {} },
    log,
  });
  if (!r.ok) {
    bad(problems, log, `check 2 - ${r.failure.message}`);
    return;
  }
  for (const p of toolListProblems(r.tools)) bad(problems, log, `check 2 - ${p}`);
  if (typeof r.callText !== 'string' || r.callText.trim() === '') {
    bad(problems, log, 'check 2 - `get-current-time` returned no text content through the packaged runtime');
    return;
  }
  ok(log, 'check 2 - one tools/call round trip completed over stdio through the packaged binary');
}

async function check3Fuses({ exePath, log, problems }) {
  let wire;
  try {
    wire = await getCurrentFuseWire(exePath);
  } catch (err) {
    bad(problems, log, `check 3 - could not read the fuse wire: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const fp = fuseProblems(wire);
  for (const p of fp) bad(problems, log, `check 3 - ${p}`);
  if (fp.length === 0) ok(log, 'check 3 - the fuse wire read back equals the seven ARCH 15.2 values');
}

async function check4Resources({ resourcesDir, allowMissingBridge, state, log, problems }) {
  const need = (rel, why) => {
    const p = join(resourcesDir, rel);
    if (existsSync(p)) return true;
    bad(problems, log, `check 4 - missing ${rel}${why ? ` (${why})` : ''}`);
    return false;
  };

  // --- bridge -------------------------------------------------------------------------------------------------
  const exe = join(resourcesDir, 'bridge', 'whatsapp-bridge.exe');
  need(join('bridge', 'LICENSE'));
  const sumsOk = need(join('bridge', 'SHA256SUMS'));
  if (!existsSync(exe)) {
    bad(problems, log, 'check 4 - missing bridge\\whatsapp-bridge.exe');
  } else if (allowMissingBridge && statSync(exe).size === 0) {
    // Only THIS branch downgrades the run to SMOKE INCOMPLETE. Passing the flag while a real, correctly pinned exe
    // is present must still produce a normal exit 0 - the flag is a permission to proceed, not a result.
    state.placeholderUsed = true;
    log('  [skip] check 4 - bridge hash line skipped: this tree was packed with the zero-byte placeholder');
  } else {
    const size = statSync(exe).size;
    const sha = (await hashFile(exe)).toUpperCase();
    if (size !== BRIDGE_EXE_SIZE) {
      bad(
        problems,
        log,
        `check 4 - packaged bridge exe is ${String(size)} bytes, the pin is ${String(BRIDGE_EXE_SIZE)}`,
      );
    } else if (sha !== BRIDGE_EXE_SHA256.toUpperCase()) {
      bad(problems, log, 'check 4 - packaged bridge exe does not match the pinned SHA-256');
    } else {
      ok(
        log,
        `check 4 - packaged whatsapp-bridge.exe streams to the pinned SHA-256 (${String(size)} bytes, never executed)`,
      );
    }
    if (sumsOk) {
      const listed = parseSums(readFileSync(join(resourcesDir, 'bridge', 'SHA256SUMS'), 'utf8'))['whatsapp-bridge.exe'];
      if (listed !== sha.toLowerCase())
        bad(problems, log, 'check 4 - packaged SHA256SUMS disagrees with the packaged exe');
    }
  }

  // --- llama --------------------------------------------------------------------------------------------------
  const manifest = join(REPO_ROOT, 'vendor', 'llama', 'win-x64-vulkan', 'MANIFEST.txt');
  if (!existsSync(manifest)) {
    bad(
      problems,
      log,
      'check 4 - vendor/llama/win-x64-vulkan/MANIFEST.txt is missing (run `node scripts/fetch-llama.mjs`)',
    );
  } else {
    const names = manifestNames(readFileSync(manifest, 'utf8'));
    const missing = names.filter((n) => !existsSync(join(resourcesDir, 'llama', n)));
    if (!names.includes('llama-server.exe'))
      bad(problems, log, 'check 4 - MANIFEST.txt does not list llama-server.exe');
    if (missing.length > 0) {
      bad(
        problems,
        log,
        `check 4 - resources\\llama is missing ${String(missing.length)} manifest file(s): ${missing.slice(0, 6).join(', ')}`,
      );
    } else {
      ok(
        log,
        `check 4 - all ${String(names.length)} files of vendor/llama/MANIFEST.txt are in resources\\llama (none executed)`,
      );
    }
  }

  // --- calendar mcp, icons, links, licenses -------------------------------------------------------------------
  // [R2] `resources\onboarding` is deliberately NOT required: ARCH 15.2 / build-plan section 6 removed the raster
  // onboarding assets from v1, so the "onboarding" word in TESTS 11 check 4 is stale. Requiring it would fail a
  // correct build.
  // The calendar MCP server is NOT checked here: it has its own hard check (4a), which compares the package against
  // the staged tree and names the electron-builder matcher that has to exist. A one-line `need()` here would report
  // that shipping blocker as just another missing file.
  const icons = ['tray.ico', 'tray-attention.ico', 'tray-paused.ico', 'tray-error.ico', 'notification.png'];
  const missingIcons = icons.filter((n) => !existsSync(join(resourcesDir, 'icons', n)));
  if (missingIcons.length > 0) bad(problems, log, `check 4 - resources\\icons is missing ${missingIcons.join(', ')}`);
  else ok(log, 'check 4 - the five tray/notification icons are present');
  need('links.json');
  if (need(join('licenses', 'THIRD_PARTY_NOTICES.txt'), 'run `node scripts/smoke-packaged.notices.mjs`')) {
    ok(log, 'check 4 - THIRD_PARTY_NOTICES.txt is present');
  }
}

function check5Asar({ resourcesDir, log, problems }) {
  const asarPath = join(resourcesDir, 'app.asar');
  if (!existsSync(asarPath)) {
    bad(problems, log, 'check 5 - resources\\app.asar does not exist');
    return;
  }
  let entries;
  let mainBundleText;
  let packageJsonText;
  try {
    entries = asar.listPackage(asarPath, { isPack: false });
    // `extractFile` splits the name on `path.sep`, so on Windows it must be given a backslash path even though
    // `listPackage` is normalised to forward slashes by `asarProblems`.
    mainBundleText = asar.extractFile(asarPath, join('out', 'main', 'index.js')).toString('utf8');
    packageJsonText = asar.extractFile(asarPath, 'package.json').toString('utf8');
  } catch (err) {
    bad(problems, log, `check 5 - could not read app.asar: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const ap = asarProblems({
    entries,
    mainBundleText,
    packageJsonText,
    hasUnpackedDir: existsSync(join(resourcesDir, 'app.asar.unpacked')),
  });
  for (const p of ap) bad(problems, log, `check 5 - ${p}`);
  if (ap.length === 0) {
    ok(
      log,
      `check 5 - app.asar listing clean (${String(entries.length)} entries, no map/test/native/seam content, nothing unpacked)`,
    );
  }
}

function check6NoGui({ log, problems }) {
  const offenders = SPAWNS.filter((s) => s.runAsNode !== '1');
  if (offenders.length > 0) {
    bad(
      problems,
      log,
      `check 6 - ${String(offenders.length)} spawn(s) of the packaged exe did NOT set ELECTRON_RUN_AS_NODE=1`,
    );
    return;
  }
  ok(
    log,
    `check 6 - no-GUI rule held: all ${String(SPAWNS.length)} spawn(s) ran the packaged exe as plain Node. ` +
      'Starting the packaged GUI is manual item M9.',
  );
}

// =====================================================================================================================
// main
// =====================================================================================================================

export async function main(argv = process.argv.slice(2), io = { out: process.stdout, err: process.stderr }) {
  const allowMissingBridge = argv.includes('--allow-missing-bridge');
  const target = argv.find((a) => !a.startsWith('--')) ?? 'dist/win-unpacked';
  const unpacked = resolve(REPO_ROOT, target);
  const log = (line) => io.out.write(`${line}\n`);

  log(`smoke-packaged: ${unpacked}`);
  const exePath = join(unpacked, PRODUCT_EXE);
  if (!existsSync(exePath)) {
    io.err.write(`smoke-packaged: FAIL - ${exePath} does not exist. Run \`npm run pack:dir\` first.\n`);
    return 1;
  }
  const resourcesDir = join(unpacked, 'resources');
  const tmpDir = join(REPO_ROOT, 'test-results', 'smoke');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  SPAWNS.length = 0;

  const problems = [];
  const state = { placeholderUsed: false };
  check4aCalendarServer({ resourcesDir, log, problems });
  await check1Mcp({ exePath, resourcesDir, tmpDir, log, problems });
  await check2ToolCall({ exePath, tmpDir, log, problems });
  await check3Fuses({ exePath, log, problems });
  await check4Resources({ resourcesDir, allowMissingBridge, state, log, problems });
  check5Asar({ resourcesDir, log, problems });
  check6NoGui({ log, problems });

  if (problems.length > 0) {
    io.err.write(`\nsmoke-packaged: FAIL - ${String(problems.length)} problem(s):\n`);
    for (const p of problems) io.err.write(`  - ${p}\n`);
    return 1;
  }
  if (state.placeholderUsed) {
    log(
      '\nSMOKE INCOMPLETE - this tree was packed with the zero-byte bridge placeholder, so check 4 could not verify\n' +
        'the pinned bridge binary. Every other check passed. This is NOT a release result: run\n' +
        '`node scripts/import-bridge.mjs` (manual item M1) and then `npm run test:smoke` without the flag.',
    );
    return EXIT_SMOKE_INCOMPLETE;
  }
  log('\nsmoke-packaged: PASS - all six checks green.');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`smoke-packaged: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(1);
    },
  );
}
