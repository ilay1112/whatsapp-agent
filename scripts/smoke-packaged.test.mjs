// scripts/smoke-packaged.test.mjs - the pure decision logic of the L6 packaging smoke (TESTS 5.3 row `scripts/*.mjs`).
// Nothing here spawns a process, reads dist/ or touches a binary: the checks that need a packaged tree are exercised by
// `npm run test:smoke` itself. What is unit-tested is every rule that decides PASS vs FAIL, because a smoke test that
// silently stops failing is worse than no smoke test at all.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  // [V2-W2-04]
  CRT_DLLS,
  DECODER_PACKAGES,
  EXECUTABLE_EXT_RE,
  FORBIDDEN_V2_PACKAGES,
  MMPROJ_PINS,
  VOICE_PINS,
  WHISPER_EXACT_FILES,
  WHISPER_ZIP_PIN,
  calendarPatchProblems,
  calendarV2ToolProblems,
  decoderProblems,
  forbiddenV2PackageProblems,
  ggmlMixProblems,
  mainBundleEntries,
  modelManifestProblems,
  noticesProblems,
  normalizeManifestSidecar,
  packageNamesIn,
  pe32PlusX64Problems,
  vendorBinaryProblems,
  whisperSetProblems,
} from './smoke-packaged.mjs';
import { NOTICE_ANCHORS_V2 } from './smoke-packaged.notices.mjs';

const SOURCE = readFileSync(fileURLToPath(new URL('./smoke-packaged.mjs', import.meta.url)), 'utf8');
const CAL_PIN = JSON.parse(
  readFileSync(fileURLToPath(new URL('../vendor/calendar-mcp.pin.json', import.meta.url)), 'utf8'),
);

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
  it('[V2] asserts exactly the eight ARCH-v2 B3 tool names, the same set vendor/calendar-mcp.pin.json pins', () => {
    expect([...EXPECTED_MCP_TOOLS].sort()).toEqual([
      'create-event',
      'get-current-time',
      'get-event',
      'get-freebusy',
      'list-calendars',
      'list-events',
      'manage-accounts',
      'update-event',
    ]);
    expect([...EXPECTED_MCP_TOOLS].sort()).toEqual(CAL_PIN.enabledTools);
    expect(EXPECTED_MCP_TOOLS).not.toContain('delete-event');
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
    expect(SEAM_STRINGS).toEqual([
      'WCA_E2E',
      'WCA_BRIDGE_CMD',
      'WCA_LLM',
      '__wcaTest',
      'stub-llm',
      'WCA_CLI_CMD',
      'WCA_WHISPER_CMD',
      'WCA_DIALOG_SCRIPT',
      'fake-claude-cli',
      'whisper-cli.mjs',
      'fake-agy',
    ]);
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
  it('accepts the eight names in any order', () => {
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
    const at1 = SOURCE.indexOf('await check1Mcp({ exePath, resourcesDir, tmpDir, state, log, problems })');
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

// =====================================================================================================================
// [V2-W2-04] checks 7-12 (T2 section 11) - the decision logic, one negative case per rule
// =====================================================================================================================

const sha = (s) => createHash('sha256').update(s).digest('hex');
const WHISPER_FILES = [
  'ggml-base.dll',
  'ggml-cpu-haswell.dll',
  'ggml-cpu-x64.dll',
  'ggml.dll',
  'whisper-cli.exe',
  'whisper.dll',
];
const whisperPin = { whisper: { tag: 'b5130', size: 8_573_270, sha256: WHISPER_ZIP_PIN.sha256 } };
const sumsOf = (names) => Object.fromEntries(names.map((n) => [n, sha(n)]));
const whisperGood = (over = {}) =>
  whisperSetProblems({
    manifest: [...WHISPER_FILES],
    sums: sumsOf(WHISPER_FILES),
    pin: whisperPin,
    packaged: [...WHISPER_FILES],
    packagedHashes: sumsOf(WHISPER_FILES),
    ...over,
  });

describe('[V2] check 7 - whisperSetProblems', () => {
  it('passes the exact MANIFEST set with matching hashes and the B18 pin', () => {
    expect(whisperGood()).toEqual([]);
    expect(WHISPER_EXACT_FILES).toEqual(['whisper-cli.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll']);
    expect(WHISPER_ZIP_PIN).toEqual({
      tag: 'b5130',
      size: 8_573_270,
      sha256: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c',
    });
  });
  it('a missing vendor/whisper FAILS (never skips) and names the fix', () => {
    const p = whisperGood({ manifest: null });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('npm run fetch:whisper');
  });
  it('fails on a drifted zip pin', () => {
    expect(whisperGood({ pin: { whisper: { ...whisperPin.whisper, size: 1 } } })[0]).toMatch(
      /drifted from ARCH-v2 B18/,
    );
  });
  it('fails on a file outside the allow-list, in the manifest or only in the package', () => {
    expect(whisperGood({ manifest: [...WHISPER_FILES, 'SDL2.dll'] }).join('\n')).toMatch(
      /outside the B18 allow-list: SDL2\.dll/,
    );
    expect(whisperGood({ packaged: [...WHISPER_FILES, 'whisper-server.exe'] }).join('\n')).toMatch(
      /files outside MANIFEST\.txt: whisper-server\.exe/,
    );
  });
  it('fails when a required file or the whole CPU backend set is absent', () => {
    const noDll = WHISPER_FILES.filter((n) => n !== 'whisper.dll');
    expect(whisperGood({ manifest: noDll, packaged: noDll }).join('\n')).toMatch(
      /lacks the required file\(s\) whisper\.dll/,
    );
    const noCpu = WHISPER_FILES.filter((n) => !n.startsWith('ggml-cpu-'));
    expect(whisperGood({ manifest: noCpu, packaged: noCpu }).join('\n')).toMatch(/no ggml-cpu-\*\.dll/);
  });
  it('accepts the CRT trio, refuses a partial CRT', () => {
    const withCrt = [...WHISPER_FILES, ...CRT_DLLS];
    expect(
      whisperGood({ manifest: withCrt, packaged: withCrt, sums: sumsOf(withCrt), packagedHashes: sumsOf(withCrt) }),
    ).toEqual([]);
    const partial = [...WHISPER_FILES, 'msvcp140.dll'];
    expect(
      whisperGood({
        manifest: partial,
        packaged: partial,
        sums: sumsOf(partial),
        packagedHashes: sumsOf(partial),
      }).join('\n'),
    ).toMatch(/staged partially/);
  });
  it('fails on a missing packaged file, a missing folder and a hash that differs from SHA256SUMS', () => {
    expect(whisperGood({ packaged: WHISPER_FILES.slice(1) }).join('\n')).toMatch(/is missing ggml-base\.dll/);
    expect(whisperGood({ packaged: null }).join('\n')).toMatch(/extraResources entry/);
    expect(
      whisperGood({ packagedHashes: { ...sumsOf(WHISPER_FILES), 'whisper.dll': sha('tampered') } }).join('\n'),
    ).toMatch(/whisper\.dll does not stream to its SHA256SUMS line/);
  });
  it('fails without SHA256SUMS or with an unsummed file', () => {
    expect(whisperGood({ sums: null }).join('\n')).toMatch(/SHA256SUMS is missing/);
    const { 'ggml.dll': _drop, ...partialSums } = sumsOf(WHISPER_FILES);
    expect(whisperGood({ sums: partialSums }).join('\n')).toMatch(/no line for ggml\.dll/);
  });
});

/** A minimal PE header: MZ, e_lfanew = 0x80, PE\0\0, machine, optional-header magic. */
function peHeader({ mz = true, sig = true, machine = 0x8664, magic = 0x20b } = {}) {
  const b = Buffer.alloc(0x200);
  if (mz) b.write('MZ', 0, 'latin1');
  b.writeUInt32LE(0x80, 0x3c);
  if (sig) b.write('PE\0\0', 0x80, 'latin1');
  b.writeUInt16LE(machine, 0x84);
  b.writeUInt16LE(magic, 0x80 + 24);
  return b;
}

describe('[V2] check 7 - pe32PlusX64Problems (header bytes only, never executed)', () => {
  it('accepts a PE32+ x64 image', () => {
    expect(pe32PlusX64Problems(peHeader())).toEqual([]);
  });
  it('rejects no MZ, no PE signature, x86, PE32 and a truncated header', () => {
    expect(pe32PlusX64Problems(peHeader({ mz: false }))[0]).toMatch(/no MZ/);
    expect(pe32PlusX64Problems(peHeader({ sig: false }))[0]).toMatch(/no PE/);
    expect(pe32PlusX64Problems(peHeader({ machine: 0x14c }))[0]).toMatch(/0x14c, expected 0x8664/);
    expect(pe32PlusX64Problems(peHeader({ magic: 0x10b }))[0]).toMatch(/PE32\+/);
    expect(pe32PlusX64Problems(peHeader().subarray(0, 0x60))[0]).toMatch(/outside the header bytes/);
  });
});

describe('[V2] check 7 - ggmlMixProblems (B18: ggml b5130 never mixes with llama b10964)', () => {
  it('passes when same-named ggml files differ', () => {
    expect(
      ggmlMixProblems({
        whisperHashes: { 'ggml.dll': sha('w-ggml'), 'ggml-base.dll': sha('w-base'), 'msvcp140.dll': sha('crt') },
        llamaHashes: { 'ggml.dll': sha('l-ggml'), 'ggml-base.dll': sha('l-base'), 'msvcp140.dll': sha('crt') },
      }),
    ).toEqual([]); // the identical CRT copy is by design and not a ggml file
  });
  it('fails when a whisper ggml DLL is byte-identical to a llama file (any name)', () => {
    const p = ggmlMixProblems({
      whisperHashes: { 'ggml-cpu-haswell.dll': sha('same') },
      llamaHashes: { 'ggml-cpu-haswell.dll': sha('same') },
    });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/never mix/);
  });
});

const pinRows = () => ({
  llm: [
    {
      id: 'tiny',
      kind: 'llm',
      magic: 'GGUF',
      fileName: 'm.gguf',
      url: `https://huggingface.co/o/r/resolve/${'a'.repeat(40)}/m.gguf`,
      size: 1,
      sha256: sha('m'),
    },
  ],
  media: [
    ...Object.entries(MMPROJ_PINS).map(([id, size]) => ({
      id,
      kind: 'mmproj',
      magic: 'GGUF',
      fileName: 'mmproj-F16.gguf',
      url: `https://huggingface.co/o/${id}/resolve/${'b'.repeat(40)}/mmproj-F16.gguf`,
      size,
      sha256: sha(id),
    })),
    ...Object.entries(VOICE_PINS).map(([id, v]) => ({
      id,
      kind: v.kind,
      magic: 'GGML',
      fileName: `${id}.bin`,
      url: `https://huggingface.co/o/${id}/resolve/${'c'.repeat(40)}/${id}.bin`,
      size: v.size,
      sha256: v.sha256 ?? sha(id),
    })),
  ],
});
const sidecarOf = (pin) => ({
  MODEL_MANIFEST: Object.fromEntries(
    pin.llm.map((e) => [e.id, { tier: e.id, label: 'x', ...e, kind: undefined, magic: undefined, id: undefined }]),
  ),
  MEDIA_MODEL_MANIFEST: Object.fromEntries(
    pin.media.map((e) => [e.id, { tier: e.id, label: 'x', ...e, id: undefined }]),
  ),
});

describe('[V2] check 8 - modelManifestProblems', () => {
  it('passes when the packaged sidecar deep-equals the pin and obeys B18 / F19', () => {
    const pin = pinRows();
    expect(modelManifestProblems({ sidecar: sidecarOf(pin), pin })).toEqual([]);
    expect(normalizeManifestSidecar(sidecarOf(pin)).media.map((e) => e.id)).toEqual(
      [...Object.keys(MMPROJ_PINS), ...Object.keys(VOICE_PINS)].sort(),
    );
  });
  it('fails a missing sidecar or a missing pin, naming the fix', () => {
    expect(modelManifestProblems({ sidecar: null, pin: pinRows() })[0]).toMatch(/sidecar/);
    expect(modelManifestProblems({ sidecar: sidecarOf(pinRows()), pin: null })[0]).toMatch(/pin-models\.mjs/);
  });
  it('fails a voice URL that is still resolve/main/ (the copy-into-manifest.ts step) - both as a diff and as a rule', () => {
    const pin = pinRows();
    const shipped = sidecarOf(pin);
    shipped.MEDIA_MODEL_MANIFEST['voice-hebrew'].url =
      'https://huggingface.co/o/voice-hebrew/resolve/main/voice-hebrew.bin';
    const p = modelManifestProblems({ sidecar: shipped, pin }).join('\n');
    expect(p).toMatch(/voice-hebrew\.url .* differs .*copy the commit-pinned URL into manifest\.ts/);
    expect(p).toMatch(/voice-hebrew: URL is not an https:\/\/huggingface\.co/);
  });
  it('fails a non-https or foreign host, an extra mmproj, an executable, a wrong voice size and a wrong VAD sha', () => {
    const pin = pinRows();
    const s = sidecarOf(pin);
    s.MODEL_MANIFEST.tiny.url = `http://example.com/o/r/resolve/${'a'.repeat(40)}/m.gguf`;
    s.MEDIA_MODEL_MANIFEST['voice-lite'].size = 5;
    s.MEDIA_MODEL_MANIFEST['voice-vad'].sha256 = sha('other');
    s.MEDIA_MODEL_MANIFEST['mmproj-extra'] = {
      tier: 'mmproj-extra',
      fileName: 'mmproj-BF16.gguf',
      url: `https://huggingface.co/o/x/resolve/${'d'.repeat(40)}/mmproj-BF16.gguf`,
      size: 1,
      sha256: sha('x'),
      kind: 'mmproj',
      magic: 'GGUF',
    };
    const p = modelManifestProblems({ sidecar: s, pin }).join('\n');
    expect(p).toMatch(/tiny: URL is not/);
    expect(p).toMatch(/voice-lite: expected kind asr/);
    expect(p).toMatch(/voice-vad: sha256 differs from B18/);
    expect(p).toMatch(/mmproj-extra: an mmproj- file outside the three pinned projectors/);
    expect(p).toMatch(/mmproj-extra: unexpected MEDIA_MODEL_MANIFEST entry/);
    expect(EXECUTABLE_EXT_RE.test('x.exe') && EXECUTABLE_EXT_RE.test('x.DLL') && !EXECUTABLE_EXT_RE.test('x.bin')).toBe(
      true,
    );
  });
  it('pins the B18 voice sizes, the VAD sha and the three projector sizes', () => {
    expect(VOICE_PINS['voice-hebrew'].size).toBe(1_624_555_275);
    expect(VOICE_PINS['voice-multilingual'].size).toBe(874_188_075);
    expect(VOICE_PINS['voice-lite'].size).toBe(264_464_607);
    expect(VOICE_PINS['voice-vad']).toEqual({
      size: 885_098,
      kind: 'vad',
      sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
    });
    expect(MMPROJ_PINS).toEqual({ 'mmproj-tiny': 985_654_080, 'mmproj-small': 990_372_672, 'mmproj-mid': 175_115_840 });
  });
});

const updateTool = (over = {}) => ({
  name: 'update-event',
  inputSchema: {
    properties: { status: { enum: ['confirmed', 'tentative', 'cancelled'] }, ifMatch: { type: 'string' } },
  },
  annotations: { destructiveHint: true },
  ...over,
});

describe('[V2] check 9 - calendarV2ToolProblems / calendarPatchProblems', () => {
  it('passes the patched surface', () => {
    expect(calendarV2ToolProblems([updateTool(), { name: 'get-event' }])).toEqual([]);
  });
  it('fails each missing insertion surface separately', () => {
    expect(calendarV2ToolProblems([{ name: 'update-event' }]).join('\n')).toMatch(/get-event is not listed/);
    expect(
      calendarV2ToolProblems([updateTool({ inputSchema: { properties: { ifMatch: {} } } }), { name: 'get-event' }])[0],
    ).toMatch(/lacks "cancelled"/);
    expect(
      calendarV2ToolProblems([
        updateTool({ inputSchema: { properties: { status: { enum: ['cancelled'] } } } }),
        { name: 'get-event' },
      ])[0],
    ).toMatch(/no ifMatch/);
    expect(calendarV2ToolProblems([updateTool({ annotations: {} }), { name: 'get-event' }])[0]).toMatch(
      /destructiveHint/,
    );
    expect(calendarV2ToolProblems([{ name: 'get-event' }])[0]).toMatch(/update-event is not listed/);
  });
  const insertions = Array.from({ length: 7 }, (_, i) => ({
    id: i + 1,
    name: `n${String(i + 1)}`,
    marker: `<M${String(i + 1)}>`,
  }));
  const text = insertions.map((i) => i.marker).join(' ');
  const pin = { bundleSha256Unpatched: sha('u'), bundleSha256Patched: sha('p') };
  it('passes the pinned patched bytes with each marker exactly once', () => {
    expect(calendarPatchProblems({ bundleSha: sha('p'), bundleText: text, pin, insertions })).toEqual([]);
  });
  it('names the unpatched bundle, unknown bytes, a doubled or missing marker, and a short insertion list', () => {
    expect(calendarPatchProblems({ bundleSha: sha('u'), bundleText: text, pin, insertions })[0]).toMatch(/UNPATCHED/);
    expect(calendarPatchProblems({ bundleSha: sha('z'), bundleText: text, pin, insertions })[0]).toMatch(/neither pin/);
    expect(calendarPatchProblems({ bundleSha: sha('p'), bundleText: `${text} <M3>`, pin, insertions })[0]).toMatch(
      /insertion 3 .* occurs 2 times/,
    );
    expect(calendarPatchProblems({ bundleSha: sha('p'), bundleText: '', pin, insertions })).toHaveLength(7);
    expect(
      calendarPatchProblems({ bundleSha: sha('p'), bundleText: text, pin, insertions: insertions.slice(1) })[0],
    ).toMatch(/seven B4 insertions/);
    expect(calendarPatchProblems({ bundleSha: null, bundleText: null, pin, insertions })[0]).toMatch(/missing/);
  });
});

describe('[V2] check 10 - vendor binaries and forbidden packages', () => {
  it('finds every B32 vendor binary name, case-insensitively, at any depth', () => {
    const files = [
      'resources/whisper/whisper-cli.exe',
      'resources/x/CLAUDE.EXE',
      'claude.cmd',
      'resources/a/b/agy.exe',
      'resources/gemini-cli.exe',
      'resources/whisper/whisper-server.exe',
    ];
    const p = vendorBinaryProblems(files);
    expect(p).toHaveLength(5);
    expect(p.join('\n')).not.toMatch(/whisper-cli\.exe/);
  });
  it('finds the ARCH-v2 12 forbidden packages nested anywhere in app.asar, but not look-alikes', () => {
    expect(packageNamesIn('node_modules/a/node_modules/@napi-rs/canvas/index.js')).toEqual(['a', '@napi-rs/canvas']);
    const p = forbiddenV2PackageProblems([
      'node_modules/opus-decoder/index.js',
      'node_modules/x/node_modules/codec-parser/index.js',
      'node_modules/@anthropic-ai/claude-code/cli.js',
      'node_modules/ffmpeg-static/index.js',
      'node_modules/canvas-confetti/index.js',
      'node_modules/@anthropic-ai/sdk/index.js',
    ]);
    expect(p).toEqual([
      'app.asar contains the forbidden package @anthropic-ai/claude-code (ARCH-v2 12)',
      'app.asar contains the forbidden package codec-parser (ARCH-v2 12)',
      'app.asar contains the forbidden package ffmpeg-static (ARCH-v2 12)',
    ]);
    expect(FORBIDDEN_V2_PACKAGES).toEqual(
      expect.arrayContaining(['ogg-opus-decoder', 'codec-parser', 'sharp', 'canvas', '@google/gemini-cli']),
    );
  });
});

describe('[V2] check 11 - decoderProblems', () => {
  const good = {
    'opus-decoder': { version: '0.7.12', license: 'MIT' },
    '@wasm-audio-decoders/common': { version: '9.0.7', license: 'MIT' },
    'simple-yenc': { version: '1.0.4', license: 'MIT' },
    '@eshaz/web-worker': { version: '1.2.2', license: 'Apache-2.0' },
  };
  it('passes the D-070 chain, no wasm, nothing unpacked', () => {
    expect(decoderProblems({ packages: good, wasmFiles: [], hasUnpackedDir: false })).toEqual([]);
    expect(Object.keys(DECODER_PACKAGES)).toEqual(Object.keys(good));
  });
  it('fails a missing package, a version drift, a licence drift, a .wasm file and an unpacked dir', () => {
    const p = decoderProblems({
      packages: {
        ...good,
        'simple-yenc': null,
        'opus-decoder': { version: '0.7.13', license: 'MIT' },
        '@eshaz/web-worker': { version: '1.2.2', license: 'LGPL-3.0' },
      },
      wasmFiles: ['resources/app.asar.unpacked/opus.wasm'],
      hasUnpackedDir: true,
    }).join('\n');
    expect(p).toMatch(/lacks node_modules\/simple-yenc/);
    expect(p).toMatch(/0\.7\.13 .* approved 0\.7\.12/);
    expect(p).toMatch(/licence LGPL-3\.0, expected Apache-2\.0/);
    expect(p).toMatch(/\.wasm file ships/);
    expect(p).toMatch(/app\.asar\.unpacked exists/);
  });
  it('the seam scan reads every main chunk, not only index.js', () => {
    expect(
      mainBundleEntries([
        'out/main/index.js',
        '/out/main/chunk-a.js',
        'out/main/manifest.json',
        'out/preload/index.cjs',
      ]),
    ).toEqual(['out/main/index.js', 'out/main/chunk-a.js']);
  });
});

describe('[V2] check 12 - noticesProblems', () => {
  const mit = 'MIT License\n\nCopyright (c) 2023-2026 The ggml authors\n';
  const all = `${Object.values(NOTICE_ANCHORS_V2).join('\n')}\n${mit}`;
  it('passes when every anchor and the whisper MIT text are present', () => {
    expect(noticesProblems({ text: all, anchors: NOTICE_ANCHORS_V2, whisperMit: mit })).toEqual([]);
  });
  it('fails each missing anchor, a missing MIT text and a missing file', () => {
    for (const [key, anchor] of Object.entries(NOTICE_ANCHORS_V2)) {
      const p = noticesProblems({ text: all.replace(anchor, ''), anchors: NOTICE_ANCHORS_V2, whisperMit: mit });
      expect(p.some((x) => x.includes(key))).toBe(true);
    }
    expect(noticesProblems({ text: all.replace('The ggml authors', ''), anchors: {}, whisperMit: mit })[0]).toMatch(
      /verbatim/,
    );
    expect(noticesProblems({ text: all, anchors: {}, whisperMit: null })[0]).toMatch(/fetch:whisper/);
    expect(noticesProblems({ text: null, anchors: {}, whisperMit: mit })[0]).toMatch(/missing/);
  });
});

describe('[V2] smoke-packaged: checks 7-12 are wired in, read-only, and never execute a whisper file', () => {
  it('main() runs checks 7-12 after check 5 and audits spawns (check 6) last', () => {
    const order = [
      '  await check7Whisper({ resourcesDir, log, problems });',
      '  check8ModelManifest({ resourcesDir, log, problems });',
      '  await check9CalendarV2({ resourcesDir, state, log, problems });',
      '  check10NoVendorBinaries({ unpacked, resourcesDir, state, log, problems });',
      '  check11Decoder({ unpacked, resourcesDir, state, log, problems });',
      '  check12Notices({ resourcesDir, log, problems });',
      'check6NoGui({ log, problems }); // last',
    ].map((s) => SOURCE.indexOf(s));
    expect(order.every((i) => i > SOURCE.indexOf('check5Asar({ resourcesDir, log, problems });'))).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it('never spawns anything under whisper (the PE header is read with readSync only)', () => {
    expect(SOURCE).not.toMatch(/spawn[^\n]*whisper/);
    expect(SOURCE).not.toMatch(/execFile|spawnSync|execSync/);
  });
});
