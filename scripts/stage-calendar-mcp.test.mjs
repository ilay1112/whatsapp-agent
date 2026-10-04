// scripts/stage-calendar-mcp.test.mjs - TESTS 5.3 row `scripts/*.mjs` ("argv contains --omit=dev --ignore-scripts") + [V2] T2 5 row
// `stage-calendar-mcp.mjs (patch step)`: with injected pins and FIXTURE bundles, the pinned unpatched sha => the seven insertions applied;
// --patch-only works offline on a temp copy (no npm - the injected runner is never called; the global T3 guard refuses any network);
// post-patch sha recorded in the pin; any other bytes => refuse (non-zero exit, file untouched); already patched => refuse; each
// insertion found exactly once by anchor; argv still --omit=dev --ignore-scripts.
// SAFETY: every main() call that could write runs against a temp fixture tree (`paths`), never against build-resources/: the real staged
// bundle is only ever READ here, and afterAll proves it is byte-identical (the full in-place patch is V2-W2-04's, build plan rule 7/F25).
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED_TOOLS,
  MCP_DIR,
  MCP_ENTRY,
  MCP_PACKAGE,
  MCP_VERSION,
  PATCH_ID,
  PATCH_INSERTIONS,
  PATCH_PATH,
  PIN_PATH,
  PRECONDITION_ERROR_TEXT,
  applyPatch,
  checkStaged,
  classifyBundle,
  countOccurrences,
  isStaged,
  main,
  patchBytes,
  patchDocument,
  patchInPlace,
  patchOnly,
  pinDocument,
  readJson,
  revertPatch,
  sha256Hex,
  stageArgs,
  toolListSha256,
} from './stage-calendar-mcp.mjs';
import { ENABLED_TOOLS_ENV } from '../src/main/mcp/readClient';
import { PRECONDITION_RE } from '../src/main/mcp/projection';

const sink = () => {
  const lines = [];
  return { write: (s) => lines.push(s), text: () => lines.join('') };
};
const io = () => ({ out: sink(), err: sink() });
const noNpm = () => {
  throw new Error('npm must not run in this test');
};

/** A synthetic "bundle": every anchor exactly once, separated by filler (no real third-party code is needed to test the patcher). */
const FIXTURE_BUNDLE = [
  '// fixture bundle',
  ...PATCH_INSERTIONS.map((i) => `// before ${i.id}\n${i.anchor}// after ${i.id}\n`),
].join('\n');
const fixtureUnpatchedSha = sha256Hex(Buffer.from(FIXTURE_BUNDLE, 'utf8'));
const fixturePatched = applyPatch(FIXTURE_BUNDLE);
const fixturePatchedSha = fixturePatched.ok ? sha256Hex(Buffer.from(fixturePatched.text, 'utf8')) : '';

const realStagedShaAtStart = existsSync(MCP_ENTRY) ? sha256Hex(readFileSync(MCP_ENTRY)) : null;
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(() => {
  if (realStagedShaAtStart !== null) expect(sha256Hex(readFileSync(MCP_ENTRY))).toBe(realStagedShaAtStart);
});

/** A temp copy of the build-resources layout with the fixture bundle and injected pin/patch paths. */
function fixtureTree({
  bundle = FIXTURE_BUNDLE,
  pin = { bundleSha256Unpatched: fixtureUnpatchedSha },
  lock = true,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wca-stage-fixture-'));
  dirs.push(root);
  const mcpDir = join(root, 'calendar-mcp');
  const pkgDir = join(mcpDir, 'node_modules', '@cocal', 'google-calendar-mcp');
  mkdirSync(join(pkgDir, 'build'), { recursive: true });
  if (lock) writeFileSync(join(mcpDir, 'package-lock.json'), '{}', 'utf8');
  writeFileSync(
    join(pkgDir, 'package.json'),
    '{"name":"@cocal/google-calendar-mcp","version":"2.6.3","type":"module"}',
    'utf8',
  );
  const entry = join(pkgDir, 'build', 'index.js');
  if (bundle !== null) writeFileSync(entry, bundle, 'utf8');
  const pinPath = join(root, 'calendar-mcp.pin.json');
  const patchPath = join(root, 'calendar-mcp.patch.json');
  if (pin !== null) writeFileSync(pinPath, JSON.stringify(pin), 'utf8');
  return { root, mcpDir, entry, pinPath, patchPath, paths: { mcpDir, entry, pinPath, patchPath } };
}

describe('stageArgs', () => {
  it('uses `ci` from the committed lockfile, never `install`', () => {
    expect(stageArgs()[0]).toBe('ci');
    expect(stageArgs()).not.toContain('install');
  });
  it('contains --omit=dev and --ignore-scripts', () => {
    expect(stageArgs()).toContain('--omit=dev');
    expect(stageArgs()).toContain('--ignore-scripts');
  });
});

describe('stage-calendar-mcp.mjs source (static)', () => {
  const src = readFileSync(fileURLToPath(new URL('./stage-calendar-mcp.mjs', import.meta.url)), 'utf8');
  it('never spawns a shell', () => {
    expect(src).toMatch(/shell:\s*false/);
    expect(src).not.toMatch(/shell:\s*true/);
  });
  it('its only child process is the npm CLI - the staged MCP server is never started here', () => {
    const spawns = [...src.matchAll(/spawn[A-Za-z]*\(([^;]*?)\)/gs)].map((m) => m[1]);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatch(/process\.execPath,\s*\[cliPath/);
    expect(spawns[0]).not.toMatch(/MCP_ENTRY/);
  });
  it('never fetches anything (no http, no fetch) - the network lives with V2-W2-04', () => {
    expect(src).not.toMatch(/\bfetch\(|node:https?|require\(['"]https?/);
  });
});

describe('build-resources/calendar-mcp package', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../build-resources/calendar-mcp/package.json', import.meta.url), 'utf8'),
  );
  it('is private-ish and pins exactly one dependency', () => {
    expect(pkg.private).toBe(true);
    expect(Object.keys(pkg.dependencies)).toEqual([MCP_PACKAGE]);
    expect(pkg.dependencies[MCP_PACKAGE]).toBe(MCP_VERSION); // exact pin, no ^ / ~
  });
  it('has a committed lockfile resolving the pinned version', () => {
    const lockPath = new URL('../build-resources/calendar-mcp/package-lock.json', import.meta.url);
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(lock.packages[`node_modules/${MCP_PACKAGE}`].version).toBe(MCP_VERSION);
  });
  it('MCP_ENTRY points inside MCP_DIR at the stdio build entry', () => {
    expect(MCP_ENTRY.startsWith(MCP_DIR)).toBe(true);
    expect(MCP_ENTRY.replace(/\\/g, '/')).toMatch(/node_modules\/@cocal\/google-calendar-mcp\/build\/index\.js$/);
  });
});

describe('the committed pins (vendor/calendar-mcp.pin.json + .patch.json)', () => {
  const pin = readJson(PIN_PATH);
  const patch = readJson(PATCH_PATH);
  it('pin both hashes, the patch id, the 8-name tool-list pin and nothing else - generated by --patch-only --write', () => {
    expect(pin).toEqual(pinDocument(pin, pin.bundleSha256Patched));
    expect(pin.bundleSha256Unpatched).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.bundleSha256Patched).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.patch).toBe(PATCH_ID);
    expect(pin.patch).toBe('status+requestBody.status+ifMatch'); // C2 11 literal
    expect(pin.enabledTools).toEqual(ENABLED_TOOLS_ENV.split(',').sort());
    expect(pin.enabledToolsSha256).toBe(toolListSha256(ENABLED_TOOLS_ENV.split(',')));
    expect([...EXPECTED_TOOLS]).toEqual(ENABLED_TOOLS_ENV.split(',').sort());
  });
  it('the patch file records the 412 text (matching the projection regex) and all seven anchors - no drift from the script', () => {
    expect(patch).toEqual(patchDocument());
    expect(patch.insertions).toHaveLength(7);
    expect(patch.preconditionErrorText).toBe(PRECONDITION_ERROR_TEXT);
    expect(PRECONDITION_RE.test(PRECONDITION_ERROR_TEXT)).toBe(true);
    expect(patch.insertions.map((i) => i.name)).toEqual([
      'update_event_status_schema',
      'update_request_body_status',
      'update_event_ifmatch_schema',
      'update_all_instances_if_match_header',
      'handle_google_api_error_412',
      'allowed_event_fields_etag',
      'structured_event_etag',
    ]);
  });
  it('the REAL staged bundle is one of the two pinned byte sequences, and patching / reverting maps one onto the other', () => {
    expect(isStaged(), `staged MCP server missing at ${MCP_ENTRY}`).toBe(true);
    const bytes = readFileSync(MCP_ENTRY); // READ only
    const kind = classifyBundle(bytes, pin);
    expect(['unpatched', 'patched']).toContain(kind);
    if (kind === 'unpatched') {
      const r = patchBytes(bytes, pin);
      expect(r.ok && r.sha).toBe(pin.bundleSha256Patched);
      for (const ins of PATCH_INSERTIONS) {
        expect(countOccurrences(bytes.toString('utf8'), ins.anchor), `anchor ${ins.id}`).toBe(1);
        expect(countOccurrences(bytes.toString('utf8'), ins.marker), `marker ${ins.id}`).toBe(0);
      }
    } else {
      const r = revertPatch(bytes.toString('utf8'));
      expect(r.ok && sha256Hex(Buffer.from(r.text, 'utf8'))).toBe(pin.bundleSha256Unpatched);
    }
  });
});

describe('applyPatch / revertPatch (pure)', () => {
  it('applies the seven insertions once each, at their anchors, and reverts exactly', () => {
    expect(fixturePatched.ok).toBe(true);
    const text = fixturePatched.ok ? fixturePatched.text : '';
    for (const ins of PATCH_INSERTIONS) expect(countOccurrences(text, ins.marker), ins.name).toBe(1);
    expect(text).toContain('requestBody.status = args.status;');
    expect(text).toContain('{ headers: { "If-Match": args.ifMatch } }');
    expect(text).toContain(JSON.stringify(PRECONDITION_ERROR_TEXT));
    expect(text.indexOf('if (status === 412)')).toBeLessThan(text.indexOf('if (status === 400)'));
    expect(revertPatch(text)).toEqual({ ok: true, text: FIXTURE_BUNDLE });
  });
  it('refuses to patch twice and refuses a missing or duplicated anchor - never a partial patch', () => {
    const text = fixturePatched.ok ? fixturePatched.text : '';
    expect(applyPatch(text)).toEqual({ ok: false, reason: 'already_patched' });
    expect(applyPatch(FIXTURE_BUNDLE.replace(PATCH_INSERTIONS[4].anchor, ''))).toEqual({
      ok: false,
      reason: 'anchor:5:0',
    });
    expect(applyPatch(FIXTURE_BUNDLE + PATCH_INSERTIONS[6].anchor)).toEqual({ ok: false, reason: 'anchor:7:2' });
    expect(applyPatch(42)).toEqual({ ok: false, reason: 'not_text' });
    expect(applyPatch('x', [{ id: 9, anchor: 'x', mode: 'sideways', text: 'y', marker: 'zz' }])).toEqual({
      ok: false,
      reason: 'mode:9',
    });
    expect(
      applyPatch('ab', [
        { id: 1, anchor: 'a', mode: 'after', text: 'b', marker: 'q1' },
        { id: 8, anchor: 'b', mode: 'after', text: 'c', marker: 'q2' },
      ]),
    ).toEqual({ ok: false, reason: 'anchor:8:moved' });
    expect(applyPatch('ab', [{ id: 7, anchor: 'a', mode: 'after', text: '', marker: 'q' }])).toEqual({
      ok: false,
      reason: 'marker:7',
    });
  });
  it('revertPatch refuses text that is not exactly patched once', () => {
    expect(revertPatch(FIXTURE_BUNDLE)).toMatchObject({ ok: false });
    expect(revertPatch(null)).toEqual({ ok: false, reason: 'not_text' });
    expect(countOccurrences('aaa', '')).toBe(0);
    expect(countOccurrences(null, 'a')).toBe(0);
  });
});

describe('patchBytes / classifyBundle against injected pins', () => {
  const buf = Buffer.from(FIXTURE_BUNDLE, 'utf8');
  it('only the pinned unpatched bytes are patched; a known patched sha that differs is drift', () => {
    expect(classifyBundle(buf, { bundleSha256Unpatched: fixtureUnpatchedSha })).toBe('unpatched');
    expect(classifyBundle(buf, null)).toBe('unknown');
    expect(patchBytes(buf, null)).toEqual({ ok: false, reason: 'no_unpatched_pin' });
    expect(patchBytes(buf, { bundleSha256Unpatched: 'nothex' })).toEqual({ ok: false, reason: 'no_unpatched_pin' });
    expect(patchBytes(Buffer.from('other bytes'), { bundleSha256Unpatched: fixtureUnpatchedSha })).toEqual({
      ok: false,
      reason: 'unknown_bytes',
    });
    expect(
      patchBytes(buf, { bundleSha256Unpatched: fixtureUnpatchedSha, bundleSha256Patched: '0'.repeat(64) }),
    ).toEqual({ ok: false, reason: 'patched_sha_drift' });
    const patchedBuf = Buffer.from(fixturePatched.ok ? fixturePatched.text : '', 'utf8');
    const pin = { bundleSha256Unpatched: fixtureUnpatchedSha, bundleSha256Patched: fixturePatchedSha };
    expect(classifyBundle(patchedBuf, pin)).toBe('patched');
    expect(patchBytes(patchedBuf, pin)).toEqual({ ok: false, reason: 'already_patched' });
    // Pinned unpatched bytes whose anchors do not fit (a pin/bundle mix-up) are refused by the anchor check.
    const noAnchors = Buffer.from('no anchors here');
    expect(patchBytes(noAnchors, { bundleSha256Unpatched: sha256Hex(noAnchors) })).toEqual({
      ok: false,
      reason: 'anchor:1:0',
    });
  });
});

describe('--patch-only (F25: offline, temp copy, never npm)', () => {
  it('writes the patched copy + package.json into a temp dir and nothing else; the staged fixture is untouched', async () => {
    const t = fixtureTree();
    const out = join(t.root, 'out');
    const pinBefore = readFileSync(t.pinPath, 'utf8');
    const { out: o, err } = io();
    const code = await main(['--patch-only', '--out', out], { out: o, err }, noNpm, t.paths);
    expect(code).toBe(0);
    expect(o.text()).toContain(`sha256=${fixturePatchedSha}`);
    expect(sha256Hex(readFileSync(join(out, 'build', 'index.js')))).toBe(fixturePatchedSha);
    expect(existsSync(join(out, 'package.json'))).toBe(true);
    expect(readFileSync(t.entry, 'utf8')).toBe(FIXTURE_BUNDLE);
    expect(readFileSync(t.pinPath, 'utf8')).toBe(pinBefore);
    expect(existsSync(t.patchPath)).toBe(false);
  });

  it('--write records the post-patch sha in the pin and the 412 text + anchors in the patch file', async () => {
    const t = fixtureTree();
    const code = await main(['--patch-only', '--write', '--out', join(t.root, 'o')], io(), noNpm, t.paths);
    expect(code).toBe(0);
    expect(readJson(t.pinPath)).toEqual(pinDocument({ bundleSha256Unpatched: fixtureUnpatchedSha }, fixturePatchedSha));
    expect(readJson(t.patchPath)).toEqual(patchDocument());
  });

  it('without --out it uses a fresh OS temp dir', () => {
    const t = fixtureTree();
    const r = patchOnly({ entry: t.entry, pinPath: t.pinPath, patchPath: t.patchPath });
    expect(r.ok).toBe(true);
    if (r.ok) {
      dirs.push(r.outDir);
      expect(r.outDir.startsWith(tmpdir())).toBe(true);
    }
  });

  it('refuses unknown bytes, already-patched bytes, a missing bundle and the staged package as output (non-zero exit)', async () => {
    const unknown = fixtureTree({ bundle: 'tampered' });
    const e1 = io();
    expect(await main(['--patch-only', '--out', join(unknown.root, 'o')], e1, noNpm, unknown.paths)).toBe(1);
    expect(e1.err.text()).toMatch(/REFUSED - unknown_bytes/);
    expect(existsSync(join(unknown.root, 'o'))).toBe(false);
    expect(readFileSync(unknown.entry, 'utf8')).toBe('tampered');

    const twice = fixtureTree({
      bundle: fixturePatched.ok ? fixturePatched.text : '',
      pin: { bundleSha256Unpatched: fixtureUnpatchedSha, bundleSha256Patched: fixturePatchedSha },
    });
    const e2 = io();
    expect(await main(['--patch-only', '--out', join(twice.root, 'o')], e2, noNpm, twice.paths)).toBe(1);
    expect(e2.err.text()).toMatch(/already_patched/);

    const missing = fixtureTree({ bundle: null });
    expect(patchOnly({ entry: missing.entry, pinPath: missing.pinPath })).toEqual({ ok: false, reason: 'not_staged' });

    const self = fixtureTree();
    expect(
      patchOnly({
        entry: self.entry,
        pinPath: self.pinPath,
        outDir: join(self.mcpDir, 'node_modules', '@cocal', 'google-calendar-mcp'),
      }),
    ).toEqual({ ok: false, reason: 'out_dir_is_staged_package' });
    expect(readFileSync(self.entry, 'utf8')).toBe(FIXTURE_BUNDLE);
  });
});

describe('full mode (npm ci + patch in place) - fixture trees only', () => {
  it('already staged + pinned unpatched: patches in place, records the patched sha once; a re-run verifies and writes nothing', async () => {
    const t = fixtureTree();
    const r1 = io();
    expect(await main([], r1, noNpm, t.paths)).toBe(0);
    expect(r1.out.text()).toMatch(/already staged[\s\S]*patched_now/);
    expect(sha256Hex(readFileSync(t.entry))).toBe(fixturePatchedSha);
    expect(readJson(t.pinPath).bundleSha256Patched).toBe(fixturePatchedSha);
    expect(readJson(t.patchPath)).toEqual(patchDocument());
    const r2 = io();
    expect(await main([], r2, noNpm, t.paths)).toBe(0);
    expect(r2.out.text()).toMatch(/already_patched/);
    expect(await main(['--check'], io(), noNpm, t.paths)).toBe(0);
  });

  it('a pin that already names the patched sha is kept (not rewritten) when patching', () => {
    const t = fixtureTree({
      pin: { bundleSha256Unpatched: fixtureUnpatchedSha, bundleSha256Patched: fixturePatchedSha, marker: 'keep' },
    });
    expect(patchInPlace({ entry: t.entry, pinPath: t.pinPath, patchPath: t.patchPath })).toMatchObject({
      ok: true,
      state: 'patched_now',
    });
    expect(readJson(t.pinPath).marker).toBe('keep');
    expect(existsSync(t.patchPath)).toBe(false);
  });

  it('refuses any other bytes and leaves the file untouched (non-zero exit)', async () => {
    const t = fixtureTree({ bundle: 'some other version' });
    const r = io();
    expect(await main([], r, noNpm, t.paths)).toBe(1);
    expect(r.err.text()).toMatch(/patch REFUSED - unknown_bytes/);
    expect(readFileSync(t.entry, 'utf8')).toBe('some other version');
    expect(patchInPlace({ entry: join(t.root, 'missing.js'), pinPath: t.pinPath })).toEqual({
      ok: false,
      reason: 'not_staged',
    });
  });

  it('--force runs npm with the ci argv in the package dir, then patches', async () => {
    const t = fixtureTree();
    const seen = [];
    const code = await main(
      ['--force'],
      io(),
      (cli, args, cwd) => {
        seen.push({ cli, args, cwd });
        return { status: 0 };
      },
      t.paths,
    );
    expect(code).toBe(0);
    expect(seen).toEqual([{ cli: expect.stringMatching(/npm-cli\.js$/), args: stageArgs(), cwd: t.mcpDir }]);
    expect(sha256Hex(readFileSync(t.entry))).toBe(fixturePatchedSha);
  });

  it('not staged: npm runs; a non-zero exit, a missing lockfile or a still-missing entry are failures', async () => {
    const t = fixtureTree({ bundle: null });
    const e1 = io();
    expect(await main([], e1, () => ({ status: 7, message: 'boom' }), t.paths)).toBe(1);
    expect(e1.err.text()).toMatch(/npm exited 7 \(boom\)/);
    const e2 = io();
    expect(await main([], e2, () => ({ status: 0 }), t.paths)).toBe(1);
    expect(e2.err.text()).toMatch(/still missing/);
    const noLock = fixtureTree({ bundle: null, lock: false });
    const e3 = io();
    expect(await main([], e3, noNpm, noLock.paths)).toBe(1);
    expect(e3.err.text()).toMatch(/package-lock\.json is missing/);
  });

  it('--check never installs: not staged / unpatched / unknown bytes each fail with their reason', async () => {
    const cases = [
      [fixtureTree({ bundle: null }), /not_staged/],
      [fixtureTree(), /not_patched/],
      [fixtureTree({ bundle: 'x' }), /unknown_bytes/],
    ];
    for (const [t, re] of cases) {
      const r = io();
      expect(await main(['--check'], r, noNpm, t.paths)).toBe(1);
      expect(r.err.text()).toMatch(re);
    }
    expect(checkStaged({ entry: join(tmpdir(), 'wca-no-such-entry.js') })).toEqual({ ok: false, reason: 'not_staged' });
  });
});
