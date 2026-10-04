#!/usr/bin/env node
// scripts/stage-calendar-mcp.mjs - ARCH 16 / 15.3 + ARCH-v2 B4 / 12: installs the isolated dependency tree of the bundled Google Calendar
// MCP server into `build-resources/calendar-mcp/node_modules` from the COMMITTED lockfile, with `npm ci --omit=dev --ignore-scripts`,
// then applies the vendored SEVEN-insertion patch (B4, F12/F21) to `build/index.js`. electron-builder then copies that folder to
// `<resources>\calendar-mcp` (`extraResources` entry `{ from: build-resources/calendar-mcp, to: calendar-mcp }`).
//
//   node scripts/stage-calendar-mcp.mjs                       install unless already staged, then patch in place (or verify the patch)
//   node scripts/stage-calendar-mcp.mjs --force               install even when `build/index.js` is already there, then patch
//   node scripts/stage-calendar-mcp.mjs --check               verify only (staged AND patched with the pinned bytes); never installs
//   node scripts/stage-calendar-mcp.mjs --patch-only [--out <dir>] [--write]
//        OFFLINE (F25): patch a TEMP COPY of the already staged `build/index.js` (+ the package.json next to it) into <dir>
//        (default: a fresh mkdtemp under the OS temp dir). Never runs npm, never touches the staged bundle. With --write it also
//        records the post-patch sha256 in vendor/calendar-mcp.pin.json and the 412 text + anchors in vendor/calendar-mcp.patch.json.
//
// Patch rules (B4): patched ONLY when the sha256 of `build/index.js` equals the pinned UNPATCHED 2.6.3 bundle; any other bytes are
// refused (non-zero exit, file untouched); already-patched bytes are refused by --patch-only and never patched twice; every insertion is
// located by an anchor that must occur EXACTLY once; the post-patch sha256 must equal the pinned patched sha (both pins fail on drift).
// `--ignore-scripts` is mandatory: nothing in that third-party tree may run a lifecycle script on this machine.
// The staged server is NEVER started by this script. Owner W0 -> V2-W1-02 (patch step) -> V2-W2-04 (runs the full mode).
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url)); // never URL.pathname - the repo path contains a space

/** `build-resources/calendar-mcp` - the isolated package root (has its own package.json + committed lockfile). */
export const MCP_DIR = join(REPO_ROOT, 'build-resources', 'calendar-mcp');
/** The stdio entry point W1-05 spawns with `ELECTRON_RUN_AS_NODE=1` (dev path; packaged path comes from `paths.ts`). */
export const MCP_ENTRY = join(MCP_DIR, 'node_modules', '@cocal', 'google-calendar-mcp', 'build', 'index.js');
/** Pinned server version - must equal the single dependency of `build-resources/calendar-mcp/package.json` (ARCH A4). */
export const MCP_PACKAGE = '@cocal/google-calendar-mcp';
export const MCP_VERSION = '2.6.3';
/** Pins (both fail on drift): the unpatched and the patched sha256 of build/index.js + the 8-name tool-list pin. */
export const PIN_PATH = join(REPO_ROOT, 'vendor', 'calendar-mcp.pin.json');
/** The 412 error text + the seven anchors/insertions, as data (the fake calendar reads the 412 text from here). */
export const PATCH_PATH = join(REPO_ROOT, 'vendor', 'calendar-mcp.patch.json');

/** C2 11 "Vendored patch contract": `patch` literal of the pin file. */
export const PATCH_ID = 'status+requestBody.status+ifMatch';
/**
 * The distinct text insertion (5) throws for HTTP 412. mcp/projection.ts maps /precondition failed|\b412\b/i on OUR OWN update-event
 * request to McpErrorKind 'precondition'. The server wraps it as an McpError, so the tool result reads "MCP error -32600: <this text>".
 */
export const PRECONDITION_ERROR_TEXT =
  'Precondition failed (HTTP 412): the event was changed after it was read (If-Match etag mismatch).';
/** The v2 ENABLED_TOOLS (C2 11 ENABLED_TOOLS_ENV), sorted - the tool-list pin of the staged server (B3). */
export const EXPECTED_TOOLS = [
  'create-event',
  'get-current-time',
  'get-event',
  'get-freebusy',
  'list-calendars',
  'list-events',
  'manage-accounts',
  'update-event',
];

/**
 * The SEVEN insertions of B4 (F12/F21), verified against the pinned 2.6.3 `build/index.js` (research v2-event-editing 1.2-1.3).
 * `mode`: 'after' = insert `text` right after the anchor, 'before' = right before it, 'replace' = the anchor becomes `text`.
 * Every anchor must occur EXACTLY once in the unpatched bundle; every `marker` (a substring only the patch introduces) must occur
 * zero times before and exactly once after.
 */
export const PATCH_INSERTIONS = [
  {
    id: 1,
    name: 'update_event_status_schema',
    anchor: '    location: z.string().optional().describe("Updated location"),\n',
    mode: 'after',
    text: '    status: z.enum(["confirmed", "tentative", "cancelled"]).optional().describe("Updated status; \'cancelled\' cancels the event"),\n',
    marker: 'status: z.enum(["confirmed", "tentative", "cancelled"]).optional().describe("Updated status;',
  },
  {
    id: 2,
    name: 'update_request_body_status',
    anchor: '    if (args.location !== void 0 && args.location !== null) requestBody.location = args.location;\n',
    mode: 'after',
    text: '    if (args.status !== void 0 && args.status !== null) requestBody.status = args.status;\n',
    marker: 'requestBody.status = args.status;',
  },
  {
    id: 3,
    name: 'update_event_ifmatch_schema',
    anchor: '    eventId: z.string().describe("ID of the event to update"),\n',
    mode: 'after',
    text: '    ifMatch: z.string().optional().describe("ETag of the event as last read; sent as the If-Match header"),\n',
    marker: 'ifMatch: z.string().optional()',
  },
  {
    id: 4,
    name: 'update_all_instances_if_match_header',
    anchor:
      '      ...supportsAttachments && { supportsAttachments }\n    });\n    if (!response.data) throw new Error("Failed to update event");\n',
    mode: 'replace',
    text: '      ...supportsAttachments && { supportsAttachments }\n    }, args.ifMatch ? { headers: { "If-Match": args.ifMatch } } : void 0);\n    if (!response.data) throw new Error("Failed to update event");\n',
    marker: '{ headers: { "If-Match": args.ifMatch } }',
  },
  {
    id: 5,
    name: 'handle_google_api_error_412',
    anchor: '      if (status === 400) {\n',
    mode: 'before',
    text: `      if (status === 412) {\n        throw new McpError(\n          ErrorCode.InvalidRequest,\n          ${JSON.stringify(PRECONDITION_ERROR_TEXT)}\n        );\n      }\n`,
    marker: 'if (status === 412) {',
  },
  {
    id: 6,
    name: 'allowed_event_fields_etag',
    anchor: '  "source",\n  "eventType"\n];\nvar DEFAULT_EVENT_FIELDS = [\n',
    mode: 'replace',
    text: '  "source",\n  "eventType",\n  "etag"\n];\nvar DEFAULT_EVENT_FIELDS = [\n',
    marker: '  "eventType",\n  "etag"\n];',
  },
  {
    id: 7,
    name: 'structured_event_etag',
    anchor: '    sequence: event.sequence ?? void 0,\n',
    mode: 'after',
    text: '    etag: event.etag ?? void 0,\n',
    marker: 'etag: event.etag ?? void 0,',
  },
];

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

// =====================================================================================================================
// the patch (pure: string in, string out)
// =====================================================================================================================

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** Non-overlapping occurrences of `needle` in `hay`. */
export function countOccurrences(hay, needle) {
  if (typeof hay !== 'string' || typeof needle !== 'string' || needle.length === 0) return 0;
  let n = 0;
  let at = hay.indexOf(needle);
  while (at !== -1) {
    n += 1;
    at = hay.indexOf(needle, at + needle.length);
  }
  return n;
}

/** sha256 of the sorted tool names joined by '\n' - the tool-list pin (ARCH-v2 12 "tool-list hash pin updated to the 8-name list"). */
export function toolListSha256(names = EXPECTED_TOOLS) {
  return sha256Hex([...names].sort().join('\n'));
}

/**
 * Applies the seven insertions to the bundle text. Refuses (never partially applies) when a marker is already present
 * ('already_patched') or an anchor is not found exactly once ('anchor:<id>:<count>'); the post-condition checks every marker once.
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function applyPatch(source, insertions = PATCH_INSERTIONS) {
  if (typeof source !== 'string') return { ok: false, reason: 'not_text' };
  for (const ins of insertions) {
    if (countOccurrences(source, ins.marker) !== 0) return { ok: false, reason: 'already_patched' };
  }
  for (const ins of insertions) {
    const n = countOccurrences(source, ins.anchor);
    if (n !== 1) return { ok: false, reason: `anchor:${ins.id}:${n}` };
  }
  let text = source;
  for (const ins of insertions) {
    const at = text.indexOf(ins.anchor);
    // Anchors are disjoint, so an earlier insertion never moves another anchor out of "exactly once" - re-checked below anyway.
    if (at === -1 || countOccurrences(text, ins.anchor) !== 1) return { ok: false, reason: `anchor:${ins.id}:moved` };
    const before = text.slice(0, at);
    const after = text.slice(at + ins.anchor.length);
    if (ins.mode === 'after') text = before + ins.anchor + ins.text + after;
    else if (ins.mode === 'before') text = before + ins.text + ins.anchor + after;
    else if (ins.mode === 'replace') text = before + ins.text + after;
    else return { ok: false, reason: `mode:${ins.id}` };
  }
  for (const ins of insertions) {
    if (countOccurrences(text, ins.marker) !== 1) return { ok: false, reason: `marker:${ins.id}` };
  }
  return { ok: true, text };
}

/**
 * The exact inverse of applyPatch (every insertion must be found exactly once in its patched form). Used by the contract test to obtain
 * the UNPATCHED bytes once the staged bundle has been patched in place (V2-W2-04), so both variants stay testable; the caller verifies
 * the result against the unpatched pin. Never used to un-patch a shipped bundle.
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function revertPatch(patchedText, insertions = PATCH_INSERTIONS) {
  if (typeof patchedText !== 'string') return { ok: false, reason: 'not_text' };
  let text = patchedText;
  for (const ins of [...insertions].reverse()) {
    const patchedForm =
      ins.mode === 'after' ? ins.anchor + ins.text : ins.mode === 'before' ? ins.text + ins.anchor : ins.text;
    if (countOccurrences(text, patchedForm) !== 1) return { ok: false, reason: `patched_form:${ins.id}` };
    const at = text.indexOf(patchedForm);
    text = text.slice(0, at) + ins.anchor + text.slice(at + patchedForm.length);
  }
  return { ok: true, text };
}

/** Reads a pin/patch JSON file; `null` when missing or not an object. */
export function readJson(path) {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

/** 'unpatched' | 'patched' | 'unknown' for the bytes of build/index.js against the pin. */
export function classifyBundle(bytes, pin) {
  const sha = sha256Hex(bytes);
  if (pin && sha === pin.bundleSha256Unpatched) return 'unpatched';
  if (pin && typeof pin.bundleSha256Patched === 'string' && sha === pin.bundleSha256Patched) return 'patched';
  return 'unknown';
}

/** The pin file content for a given patched sha (keys in a stable order; never a secret, never a path). */
export function pinDocument(pin, patchedSha) {
  return {
    package: MCP_PACKAGE,
    version: MCP_VERSION,
    file: 'build/index.js',
    bundleSha256Unpatched: pin.bundleSha256Unpatched,
    bundleSha256Patched: patchedSha,
    patch: PATCH_ID,
    insertions: PATCH_INSERTIONS.length,
    enabledTools: [...EXPECTED_TOOLS],
    enabledToolsSha256: toolListSha256(),
  };
}

/** The patch file content: the 412 text and every anchor/insertion as data (B4 "anchor recorded in vendor/calendar-mcp.patch.json"). */
export function patchDocument() {
  return {
    package: MCP_PACKAGE,
    version: MCP_VERSION,
    file: 'build/index.js',
    patch: PATCH_ID,
    preconditionErrorText: PRECONDITION_ERROR_TEXT,
    preconditionErrorPattern: '/precondition failed|\\b412\\b/i',
    insertions: PATCH_INSERTIONS.map(({ id, name, anchor, mode, text, marker }) => ({
      id,
      name,
      mode,
      anchor,
      text,
      marker,
    })),
  };
}

const jsonText = (v) => `${JSON.stringify(v, null, 2)}\n`;

/**
 * Checks the bytes against the unpatched pin and produces the patched bytes. Nothing is written here.
 * @returns {{ ok: true, patched: Buffer, sha: string } | { ok: false, reason: string }}
 */
export function patchBytes(bytes, pin) {
  if (!pin || typeof pin.bundleSha256Unpatched !== 'string' || !HEX64.test(pin.bundleSha256Unpatched)) {
    return { ok: false, reason: 'no_unpatched_pin' };
  }
  const kind = classifyBundle(bytes, pin);
  if (kind === 'patched') return { ok: false, reason: 'already_patched' };
  if (kind !== 'unpatched') return { ok: false, reason: 'unknown_bytes' };
  const r = applyPatch(bytes.toString('utf8'));
  if (!r.ok) return r;
  const patched = Buffer.from(r.text, 'utf8');
  const sha = sha256Hex(patched);
  if (typeof pin.bundleSha256Patched === 'string' && pin.bundleSha256Patched !== sha) {
    return { ok: false, reason: 'patched_sha_drift' };
  }
  return { ok: true, patched, sha };
}

/**
 * F25 `--patch-only`: patch a TEMP COPY of the staged bundle offline. Writes `<outDir>/build/index.js` and `<outDir>/package.json`
 * (the server reads `../package.json` for its version) and nothing else - unless `write`, which records the pins.
 * @param {{ entry?: string, outDir?: string | null, write?: boolean, pinPath?: string, patchPath?: string }} [opts]
 * @returns {{ ok: true, outDir: string, entry: string, sha: string } | { ok: false, reason: string }}
 */
export function patchOnly({
  entry = MCP_ENTRY,
  outDir = null,
  write = false,
  pinPath = PIN_PATH,
  patchPath = PATCH_PATH,
} = {}) {
  if (!existsSync(entry)) return { ok: false, reason: 'not_staged' };
  const pin = readJson(pinPath);
  const bytes = readFileSync(entry);
  const r = patchBytes(bytes, pin);
  if (!r.ok) return r;
  const dir = outDir ?? mkdtempSync(join(tmpdir(), 'wca-calendar-mcp-patch-'));
  const stagedPackageRoot = resolve(dirname(entry), '..');
  if (resolve(dir) === stagedPackageRoot) return { ok: false, reason: 'out_dir_is_staged_package' };
  mkdirSync(join(dir, 'build'), { recursive: true });
  const outEntry = join(dir, 'build', 'index.js');
  writeFileSync(outEntry, r.patched);
  const pkg = join(stagedPackageRoot, 'package.json');
  if (existsSync(pkg)) copyFileSync(pkg, join(dir, 'package.json'));
  if (write) {
    writeFileSync(pinPath, jsonText(pinDocument(pin, r.sha)), 'utf8');
    writeFileSync(patchPath, jsonText(patchDocument()), 'utf8');
  }
  return { ok: true, outDir: dir, entry: outEntry, sha: r.sha };
}

/**
 * Full mode, after `npm ci`: patch `build/index.js` IN PLACE. Already patched with the pinned bytes => verified, nothing written.
 * Records the patched sha in the pin when it is not pinned yet (first run); a pinned sha that differs is drift (refused).
 * @returns {{ ok: true, state: 'patched_now' | 'already_patched', sha: string } | { ok: false, reason: string }}
 */
export function patchInPlace({ entry = MCP_ENTRY, pinPath = PIN_PATH, patchPath = PATCH_PATH } = {}) {
  if (!existsSync(entry)) return { ok: false, reason: 'not_staged' };
  const pin = readJson(pinPath);
  const bytes = readFileSync(entry);
  if (pin && classifyBundle(bytes, pin) === 'patched')
    return { ok: true, state: 'already_patched', sha: sha256Hex(bytes) };
  const r = patchBytes(bytes, pin);
  if (!r.ok) return r;
  writeFileSync(entry, r.patched);
  if (typeof pin.bundleSha256Patched !== 'string') {
    writeFileSync(pinPath, jsonText(pinDocument(pin, r.sha)), 'utf8');
    writeFileSync(patchPath, jsonText(patchDocument()), 'utf8');
  }
  return { ok: true, state: 'patched_now', sha: r.sha };
}

/** `--check`: staged AND the bytes equal the pinned PATCHED bundle. */
export function checkStaged({ entry = MCP_ENTRY, pinPath = PIN_PATH } = {}) {
  if (!existsSync(entry)) return { ok: false, reason: 'not_staged' };
  const pin = readJson(pinPath);
  const kind = classifyBundle(readFileSync(entry), pin);
  if (kind === 'patched') return { ok: true };
  return { ok: false, reason: kind === 'unpatched' ? 'not_patched' : 'unknown_bytes' };
}

/** Default runner: `node <npm-cli.js> ci ...` inside `cwd`, inheriting stdio, `shell: false`. */
function defaultRun(cliPath, args, cwd) {
  const r = spawnSync(process.execPath, [cliPath, ...args], { cwd, stdio: 'inherit', shell: false });
  if (r.error) return { status: 1, message: String(r.error.message) };
  return { status: r.status ?? 1 };
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/**
 * @param paths injectable locations (tests use temp dirs and fixture bundles; production uses the module constants)
 */
export async function main(
  argv = process.argv.slice(2),
  io = { out: process.stdout, err: process.stderr },
  run = defaultRun,
  paths = {},
) {
  const mcpDir = paths.mcpDir ?? MCP_DIR;
  const entry = paths.entry ?? MCP_ENTRY;
  const pinPath = paths.pinPath ?? PIN_PATH;
  const patchPath = paths.patchPath ?? PATCH_PATH;
  const force = argv.includes('--force');
  const checkOnly = argv.includes('--check');

  if (argv.includes('--patch-only')) {
    // F25: offline. No npm, no network, the staged bundle is only READ.
    const r = patchOnly({
      entry,
      outDir: argValue(argv, '--out'),
      write: argv.includes('--write'),
      pinPath,
      patchPath,
    });
    if (!r.ok) {
      io.err.write(`stage-calendar-mcp: --patch-only REFUSED - ${r.reason}\n`);
      return 1;
    }
    io.out.write(`stage-calendar-mcp: --patch-only OK sha256=${r.sha} -> ${r.entry}\n`);
    return 0;
  }

  if (checkOnly) {
    const c = checkStaged({ entry, pinPath });
    if (!c.ok) {
      io.err.write(
        `stage-calendar-mcp: --check FAILED - ${c.reason} (expected the patched ${MCP_PACKAGE}@${MCP_VERSION} at ${entry})\n`,
      );
      return 1;
    }
    io.out.write(`stage-calendar-mcp: staged and patched - ${entry}\n`);
    return 0;
  }

  if (!isStaged(entry) || force) {
    if (!existsSync(join(mcpDir, 'package-lock.json'))) {
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
    io.out.write(`stage-calendar-mcp: npm ${args.join(' ')} in ${mcpDir}\n`);
    const r = run(cli, args, mcpDir);
    if (r.status !== 0) {
      io.err.write(`stage-calendar-mcp: FAIL - npm exited ${r.status}${r.message ? ` (${r.message})` : ''}\n`);
      return 1;
    }
    if (!isStaged(entry)) {
      io.err.write(`stage-calendar-mcp: FAIL - npm succeeded but ${entry} is still missing\n`);
      return 1;
    }
  } else {
    io.out.write(`stage-calendar-mcp: already staged - ${entry}\n`);
  }

  const p = patchInPlace({ entry, pinPath, patchPath });
  if (!p.ok) {
    io.err.write(`stage-calendar-mcp: patch REFUSED - ${p.reason} (the bundle was left untouched)\n`);
    return 1;
  }
  io.out.write(`stage-calendar-mcp: OK ${MCP_PACKAGE}@${MCP_VERSION} ${p.state} sha256=${p.sha} -> ${entry}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => process.exit(code));
}
