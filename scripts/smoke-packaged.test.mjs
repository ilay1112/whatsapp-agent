// scripts/smoke-packaged.test.mjs - the pure decision logic of the L6 packaging smoke (TESTS 5.3 row `scripts/*.mjs`).
// Nothing here spawns a process, reads dist/ or touches a binary: the checks that need a packaged tree are exercised by
// `npm run test:smoke` itself. What is unit-tested is every rule that decides PASS vs FAIL, because a smoke test that
// silently stops failing is worse than no smoke test at all.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FuseState, FuseV1Options } from '@electron/fuses';
import {
  CALENDAR_NODE_MODULES_MATCHER,
  EXPECTED_FUSES,
  EXPECTED_MCP_TOOLS,
  EXIT_SMOKE_INCOMPLETE,
  FORBIDDEN_PACKAGES,
  OAUTH_FIXTURE,
  SEAM_STRINGS,
  TRANSITIVE_ALLOWED,
  asarProblems,
  calendarServerProblems,
  classifyMcpFailure,
  declaredDependencyProblems,
  fuseProblems,
  manifestNames,
  rootDeclaredPackage,
  toolListProblems,
} from './smoke-packaged.mjs';

const SOURCE = readFileSync(fileURLToPath(new URL('./smoke-packaged.mjs', import.meta.url)), 'utf8');

/** A minimal archive listing that passes check 5, so each negative case differs from it by exactly one entry. */
const cleanEntries = [
  'package.json',
  'out/main/index.js',
  'out/preload/index.cjs',
  'out/renderer/index.html',
  'out/renderer/assets/index-abc.js',
  'out/renderer/assets/index-abc.css',
  'node_modules/zod/package.json',
  'node_modules/@modelcontextprotocol/sdk/package.json',
  'node_modules/ajv/package.json', // npm hoists @modelcontextprotocol/sdk's own ajv to the archive root
];
const cleanPackageJson = JSON.stringify({ name: 'whatsapp-calendar-agent', dependencies: { zod: '4.6.5' } });
const clean = (over = {}) =>
  asarProblems({
    entries: cleanEntries,
    mainBundleText: 'const a=1;',
    packageJsonText: cleanPackageJson,
    hasUnpackedDir: false,
    ...over,
  });

describe('smoke-packaged: frozen expectations', () => {
  it('asserts exactly the six ARCH 5.1 tool names', () => {
    expect([...EXPECTED_MCP_TOOLS].sort()).toEqual([
      'create-event',
      'get-current-time',
      'get-freebusy',
      'list-calendars',
      'list-events',
      'manage-accounts',
    ]);
  });

  it('uses the exact ARCH 15.4 [R2] credentials fixture, including redirect_uris[0]', () => {
    // The server dereferences redirect_uris[0] BEFORE the MCP handshake; dropping it turns a healthy run into a
    // TypeError that reads exactly like a flipped runAsNode fuse. That is why the shape is pinned by a test.
    expect(OAUTH_FIXTURE).toEqual({
      installed: {
        client_id: 'TESTONLY.apps.googleusercontent.com',
        client_secret: 'TESTONLY',
        redirect_uris: ['http://localhost'],
      },
    });
    expect(JSON.stringify(OAUTH_FIXTURE)).not.toMatch(/apps\.googleusercontent\.com"[^]*[0-9]{6}/);
  });

  it('pins the seven fuses of ARCH 15.2 with the documented states', () => {
    expect(EXPECTED_FUSES[FuseV1Options.RunAsNode]).toBe(FuseState.ENABLE);
    expect(EXPECTED_FUSES[FuseV1Options.OnlyLoadAppFromAsar]).toBe(FuseState.ENABLE);
    expect(EXPECTED_FUSES[FuseV1Options.EnableCookieEncryption]).toBe(FuseState.ENABLE);
    expect(EXPECTED_FUSES[FuseV1Options.EnableNodeCliInspectArguments]).toBe(FuseState.DISABLE);
    expect(EXPECTED_FUSES[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(FuseState.DISABLE);
    expect(EXPECTED_FUSES[FuseV1Options.GrantFileProtocolExtraPrivileges]).toBe(FuseState.DISABLE);
    expect(EXPECTED_FUSES[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(FuseState.DISABLE);
  });

  it('keeps the seam list of TESTS 4.1 and ajv on the forbidden root-declared list', () => {
    expect(SEAM_STRINGS).toEqual(['WCA_E2E', 'WCA_BRIDGE_CMD', 'WCA_LLM', '__wcaTest', 'stub-llm']);
    expect(FORBIDDEN_PACKAGES).toContain('ajv');
    expect(FORBIDDEN_PACKAGES).toContain('node-llama-cpp');
    expect(FORBIDDEN_PACKAGES).toContain('better-sqlite3');
  });

  it('SMOKE INCOMPLETE is exit code 3, never 0', () => {
    expect(EXIT_SMOKE_INCOMPLETE).toBe(3);
  });
});

describe('smoke-packaged: the no-GUI rule is structural', () => {
  it('the only spawn helper hard-codes ELECTRON_RUN_AS_NODE=1', () => {
    // There must be exactly one `spawn(` call site and it must be inside spawnAsNode, which sets the variable
    // itself rather than taking it as a parameter. A caller can therefore never start the packaged app as a GUI.
    expect(SOURCE.match(/[^a-zA-Z]spawn\((?!s\))/g) ?? []).toHaveLength(1);
    // Exactly one assignment of the variable exists, and it is the literal '1'.
    expect(SOURCE.match(/ELECTRON_RUN_AS_NODE:/g) ?? []).toHaveLength(1);
    expect(SOURCE).toMatch(/ELECTRON_RUN_AS_NODE: '1',/);
  });

  it('never executes the bridge or the llama binaries', () => {
    expect(SOURCE).not.toMatch(/spawn[^\n]*whatsapp-bridge/);
    expect(SOURCE).not.toMatch(/spawn[^\n]*llama-server/);
  });
});

describe('fuseProblems', () => {
  const good = { ...EXPECTED_FUSES, version: '1' };

  it('accepts the exact ARCH 15.2 wire', () => {
    expect(fuseProblems(good)).toEqual([]);
  });

  it('fails when runAsNode has been "hardened" off', () => {
    const problems = fuseProblems({ ...good, [FuseV1Options.RunAsNode]: FuseState.DISABLE });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/runAsNode: expected ENABLE, packaged exe has DISABLE/);
  });

  it('fails when onlyLoadAppFromAsar is off and when a fuse is missing entirely', () => {
    expect(fuseProblems({ ...good, [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.DISABLE })).toHaveLength(1);
    const partial = { ...good };
    delete partial[FuseV1Options.EnableCookieEncryption];
    expect(fuseProblems(partial)).toHaveLength(1);
  });

  it('does not silently pass an empty wire', () => {
    expect(fuseProblems({}).length).toBe(Object.keys(EXPECTED_FUSES).length);
  });
});

describe('toolListProblems', () => {
  it('accepts the six names in any order', () => {
    expect(toolListProblems([...EXPECTED_MCP_TOOLS].reverse())).toEqual([]);
  });
  it('rejects a missing tool', () => {
    expect(toolListProblems(EXPECTED_MCP_TOOLS.slice(1))[0]).toMatch(/missing get-current-time/);
  });
  it('rejects an extra tool (CAL_TOOLSET_MISMATCH is fail-closed)', () => {
    expect(toolListProblems([...EXPECTED_MCP_TOOLS, 'delete-event'])[0]).toMatch(/unexpected delete-event/);
  });
});

describe('classifyMcpFailure', () => {
  it('returns null when JSON-RPC was seen', () => {
    expect(
      classifyMcpFailure({ exited: false, exitCode: null, stderr: '', sawJsonRpc: true, timedOut: false }),
    ).toBeNull();
  });

  it('calls a non-zero exit with "Failed to start server" a fixture problem, not a fuse problem', () => {
    const r = classifyMcpFailure({
      exited: true,
      exitCode: 1,
      stderr: 'Failed to start server: TypeError',
      sawJsonRpc: false,
      timedOut: false,
    });
    expect(r.mode).toBe('fixture');
    expect(r.message).toMatch(/the fuse is fine/);
  });

  it('calls "alive but silent for 20 s" a flipped fuse and names the setting', () => {
    const r = classifyMcpFailure({ exited: false, exitCode: null, stderr: '', sawJsonRpc: false, timedOut: true });
    expect(r.mode).toBe('fuse');
    expect(r.message).toMatch(/runAsNode/);
    expect(r.message).toMatch(/started as an Electron GUI process/);
  });

  it('reports a bare early exit as a fixture problem with a stderr tail', () => {
    const r = classifyMcpFailure({
      exited: true,
      exitCode: 9,
      stderr: 'a\nb\nboom',
      sawJsonRpc: false,
      timedOut: false,
    });
    expect(r.mode).toBe('fixture');
    expect(r.message).toMatch(/boom/);
  });
});

describe('manifestNames', () => {
  it('drops blank lines and the manifest itself', () => {
    expect(manifestNames('llama-server.exe\r\nggml.dll\n\nMANIFEST.txt\n')).toEqual(['llama-server.exe', 'ggml.dll']);
  });
});

describe('calendarServerProblems (check 4a - the packaging blocker)', () => {
  const staged = ['@cocal', '@modelcontextprotocol', 'googleapis', 'open', 'zod'];
  const good = (over = {}) =>
    calendarServerProblems({
      stagedPackages: staged,
      packagedPackages: [...staged],
      entryExists: true,
      packageJsonExists: true,
      lockExists: true,
      ...over,
    });

  it('passes when the whole staged tree reached the package', () => {
    expect(good()).toEqual([]);
  });

  it('fails hard, with its own message, when the packaged node_modules is empty', () => {
    const problems = good({ packagedPackages: [], entryExists: false });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('PACKAGING REGRESSION');
    expect(problems[0]).toContain('NO calendar server');
    // the message must carry the fix, not just the symptom
    expect(problems[0]).toContain(CALENDAR_NODE_MODULES_MATCHER);
    expect(problems[0]).toContain('relative === "node_modules"');
  });

  it('treats a missing packaged node_modules directory exactly like an empty one', () => {
    const problems = good({ packagedPackages: null, entryExists: false });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('PACKAGING REGRESSION');
  });

  it('blames staging, NOT the packaging, when nothing was staged either', () => {
    const problems = calendarServerProblems({
      stagedPackages: null,
      packagedPackages: null,
      entryExists: false,
      packageJsonExists: true,
      lockExists: true,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('never STAGED');
    expect(problems[0]).toContain('npm run stage:mcp');
    expect(problems[0]).not.toContain('PACKAGING REGRESSION');
  });

  it('fails when the entry point is missing although packages were copied', () => {
    const problems = good({ entryExists: false });
    expect(problems.some((p) => p.includes('entry point') && p.includes('build'))).toBe(true);
  });

  it('fails on a PARTIAL copy of the staged tree', () => {
    const problems = good({ packagedPackages: ['@cocal', 'zod'] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('PARTIAL COPY');
    expect(problems[0]).toContain('@modelcontextprotocol');
  });

  it('requires the ARCH 15.3 package.json and package-lock.json beside node_modules', () => {
    expect(good({ packageJsonExists: false })).toEqual([expect.stringContaining('calendar-mcp\\package.json')]);
    expect(good({ lockExists: false })).toEqual([expect.stringContaining('calendar-mcp\\package-lock.json')]);
  });

  it('does not count dot-entries as packages (the caller filters them out)', () => {
    expect(good({ stagedPackages: [...staged], packagedPackages: [...staged] })).toEqual([]);
  });
});

describe('smoke-packaged: check 4a is wired in and cannot be skipped', () => {
  it('runs the calendar-server check before check 1 in main()', () => {
    const at4a = SOURCE.indexOf('check4aCalendarServer({ resourcesDir, log, problems })');
    const at1 = SOURCE.indexOf('await check1Mcp({ exePath, resourcesDir, tmpDir, log, problems })');
    expect(at4a).toBeGreaterThan(-1);
    expect(at1).toBeGreaterThan(at4a);
  });
  it('no longer reports the missing server as an ordinary missing resource in check 4', () => {
    expect(SOURCE).not.toContain("need(MCP_REL_ENTRY, 'run `npm run stage:mcp`')");
  });
});

describe('rootDeclaredPackage', () => {
  it('recognises plain and scoped root entries', () => {
    expect(rootDeclaredPackage('node_modules/zod')).toBe('zod');
    expect(rootDeclaredPackage('/node_modules/@anthropic-ai/sdk')).toBe('@anthropic-ai/sdk');
  });
  it('does not treat a nested dependency as root-declared', () => {
    expect(rootDeclaredPackage('node_modules/@modelcontextprotocol/sdk/node_modules/ajv')).toBeNull();
    expect(rootDeclaredPackage('node_modules/zod/package.json')).toBeNull();
  });
});

describe('asarProblems', () => {
  it('passes a clean production archive', () => {
    expect(clean()).toEqual([]);
  });

  it('tolerates the hoisted transitive ajv but fails when package.json DECLARES it', () => {
    // ARCH 16 [R2]: `ajv` / `ajv-formats` are allowed as transitive dependencies of @modelcontextprotocol/sdk, and npm
    // hoists them to the archive root, so their mere presence proves nothing. The real rule is about the manifest.
    expect(TRANSITIVE_ALLOWED).toEqual(['ajv', 'ajv-formats']);
    expect(clean({ entries: [...cleanEntries, 'node_modules/ajv', 'node_modules/ajv-formats'] })).toEqual([]);
    const declared = clean({ packageJsonText: JSON.stringify({ dependencies: { ajv: '8.0.0' } }) });
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatch(/declares the forbidden package "ajv"/);
  });

  it('still fails on a forbidden package that nothing may legitimately hoist', () => {
    const problems = clean({ entries: [...cleanEntries, 'node_modules/better-sqlite3'] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/ships the forbidden package node_modules\/better-sqlite3/);
  });

  it('rejects @electron-toolkit/* and the i18next-* plugin family by prefix', () => {
    expect(clean({ entries: [...cleanEntries, 'node_modules/@electron-toolkit/utils'] })[0]).toMatch(
      /@electron-toolkit/,
    );
    expect(clean({ entries: [...cleanEntries, 'node_modules/i18next-fs-backend'] })[0]).toMatch(/i18next-fs-backend/);
  });

  it('rejects source maps, tests, native addons and binding.gyp', () => {
    expect(clean({ entries: [...cleanEntries, 'out/main/index.js.map'] })[0]).toMatch(/source map/);
    expect(clean({ entries: [...cleanEntries, 'tests/fakes/fake-bridge.ts'] })[0]).toMatch(/test material/);
    expect(clean({ entries: [...cleanEntries, 'node_modules/x/build/x.node'] })[0]).toMatch(/native addon/);
    expect(clean({ entries: [...cleanEntries, 'node_modules/x/binding.gyp'] })[0]).toMatch(/native build file/);
  });

  it('rejects a stale e2e marker (TESTS 14: the production build must rewrite out/ without it)', () => {
    const problems = clean({ entries: [...cleanEntries, 'out/.e2e-build'] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/e2e marker/);
  });

  it('rejects every seam string of TESTS 4.1 in the main bundle, one by one', () => {
    for (const seam of SEAM_STRINGS) {
      const problems = clean({ mainBundleText: `const x="${seam}";` });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/seam string/);
    }
  });

  it('rejects a packaged manifest that still carries devDependencies', () => {
    const problems = clean({
      packageJsonText: JSON.stringify({ dependencies: {}, devDependencies: { vitest: '4.1.11' } }),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/still carries devDependencies/);
  });

  it('rejects an unreadable manifest rather than passing it', () => {
    expect(declaredDependencyProblems('{not json')).toEqual(['app.asar/package.json is not valid JSON']);
  });

  it('rejects an app.asar.unpacked directory', () => {
    expect(clean({ hasUnpackedDir: true })[0]).toMatch(/app\.asar\.unpacked/);
  });

  it('rejects an archive missing the preload, the main bundle or the renderer assets', () => {
    expect(clean({ entries: cleanEntries.filter((e) => e !== 'out/preload/index.cjs') })[0]).toMatch(/index\.cjs/);
    expect(clean({ entries: cleanEntries.filter((e) => e !== 'out/main/index.js') })[0]).toMatch(
      /out\/main\/index\.js/,
    );
    expect(clean({ entries: cleanEntries.filter((e) => !e.endsWith('.css')) })[0]).toMatch(/stylesheet/);
  });
});
