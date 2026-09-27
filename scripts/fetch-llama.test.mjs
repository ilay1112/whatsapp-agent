// scripts/fetch-llama.test.mjs - TESTS 5.3 row `scripts/*.mjs` for the llama.cpp staging script (owner W1-07).
// `fetch` and the filesystem are injected, so nothing is downloaded, nothing is written to the repo and - above all -
// no binary is ever executed.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LLAMA_MIT_PATH,
  MANIFEST_NAME,
  PIN_PATH,
  applyCrtPins,
  crtDigests,
  crtPlan,
  fetchText,
  fetchVerified,
  isAllowedFile,
  main,
  pinCrt,
  readZipEntries,
  stageCrt,
} from './fetch-llama.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REAL_PIN = JSON.parse(readFileSync(path.join(ROOT, PIN_PATH), 'utf8'));

// ---------------------------------------------------------------------------------------------------------------------
// a tiny STORED zip builder (no dependency, no fixture binary on disk)
// ---------------------------------------------------------------------------------------------------------------------
function buildZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 14); // crc32 is not checked by the reader
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const body = Buffer.concat(locals);
  const dir = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, dir, eocd]);
}

function memoryFs(seed = {}) {
  const files = new Map(Object.entries(seed));
  const dirs = new Set();
  return {
    files,
    dirs,
    readFile: async (p, enc) => {
      const key = path.normalize(p);
      if (!files.has(key)) throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' });
      const value = files.get(key);
      return enc === undefined ? Buffer.from(value) : Buffer.from(value).toString(enc);
    },
    writeFile: async (p, data) => {
      files.set(path.normalize(p), Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
    },
    mkdir: async (p) => {
      dirs.add(path.normalize(p));
    },
  };
}

const okResponse = (body) => ({ ok: true, status: 200, arrayBuffer: async () => body, text: async () => String(body) });

/** A minimal pinned release whose sha256 is computed from the zip we just built. */
function pinFor(zip, over = {}) {
  return {
    llama: {
      tag: 'b10964',
      asset: 'llama-b10964-bin-win-vulkan-x64.zip',
      url: 'https://github.com/ggml-org/llama.cpp/releases/download/b10964/llama-b10964-bin-win-vulkan-x64.zip',
      size: zip.length,
      sha256: createHash('sha256').update(zip).digest('hex'),
      licenseUrl: 'https://raw.githubusercontent.com/ggml-org/llama.cpp/b10964/LICENSE',
      targetDir: 'vendor/llama/win-x64-vulkan',
      ...over.llama,
    },
    files: { exact: ['llama-server.exe', 'ggml.dll'], prefix: ['ggml-cpu-'], ...over.files },
    vcRedistCrt: {
      sourceEnvVar: 'VC_REDIST_CRT_DIR',
      files: { 'msvcp140.dll': null, 'vcruntime140.dll': null, 'vcruntime140_1.dll': null },
      ...over.vcRedistCrt,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// the allow-list (ARCH section 9: explicit, never a *.dll glob)
// ---------------------------------------------------------------------------------------------------------------------
describe('isAllowedFile', () => {
  const allow = { exact: REAL_PIN.files.exact, prefix: REAL_PIN.files.prefix };

  it.each(['llama-server.exe', 'ggml.dll', 'ggml-vulkan.dll', 'libomp.dll', 'LICENSE-LLVM-OpenMP'])(
    'accepts the pinned file %s',
    (name) => {
      expect(isAllowedFile(name, allow)).toBe(true);
    },
  );

  it('accepts the CPUID-dispatched ggml-cpu-* set through the prefix rule', () => {
    expect(isAllowedFile('ggml-cpu-haswell.dll', allow)).toBe(true);
    expect(isAllowedFile('build/bin/ggml-cpu-icelake.dll', allow)).toBe(true);
  });

  it.each([
    'llama-cli.exe',
    'llama-bench.exe',
    'rpc-server.exe',
    'test-backend-ops.exe',
    'vulkan-1.dll',
    'ggml-cpu-evil.exe',
    'ggml-cpu-evil.bat',
    'setup.ps1',
  ])('refuses %s (nothing outside the explicit list is unpacked)', (name) => {
    expect(isAllowedFile(name, allow)).toBe(false);
  });

  it('strips any directory prefix before matching, so `../` cannot smuggle a name in', () => {
    expect(isAllowedFile('../../evil/llama-server.exe', allow)).toBe(true); // the base name is what gets written
    expect(isAllowedFile('llama-server.exe/../evil.dll', allow)).toBe(false);
  });
});

describe('vendor/llama.pin.json', () => {
  it('pins a tag, a sha256 and an explicit file list - never a glob', () => {
    expect(REAL_PIN.llama.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(REAL_PIN.llama.url).toMatch(/^https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases\/download\//);
    expect(REAL_PIN.llama.url).toContain(REAL_PIN.llama.tag);
    expect(REAL_PIN.files.exact).toContain('llama-server.exe');
    expect(JSON.stringify([REAL_PIN.files.exact, REAL_PIN.files.prefix])).not.toContain('*');
  });

  it('names exactly the three MSVC CRT files the app pre-flights', () => {
    expect(Object.keys(REAL_PIN.vcRedistCrt.files)).toEqual(['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']);
    expect(REAL_PIN.vcRedistCrt.sourceEnvVar).toBe('VC_REDIST_CRT_DIR');
  });

  it('carries the REAL b10964 size + sha256 of ARCHITECTURE section 9, not a placeholder', () => {
    // wave1-audit reported these as placeholders. They are not: ARCH section 9 is the pin of record, and this test
    // fails the build if either document ever drifts from the other.
    const archLine = readFileSync(path.join(ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8')
      .split(/\r?\n/)
      .find((l) => l.includes(REAL_PIN.llama.asset) && l.includes('sha256'));
    expect(archLine, 'ARCHITECTURE.md section 9 must name the pinned asset').toBeDefined();
    expect(archLine).toContain(REAL_PIN.llama.url);
    expect(archLine).toContain(REAL_PIN.llama.sha256);
    expect(archLine).toContain(REAL_PIN.llama.size.toLocaleString('en-US')); // ARCH writes it as 31,674,542
  });

  it('either pins every CRT file with a 64-hex sha256 or leaves it null (UNPINNED => staging refuses)', () => {
    for (const [name, value] of Object.entries(REAL_PIN.vcRedistCrt.files)) {
      if (name.startsWith('_')) continue;
      expect(value === null || /^[0-9a-f]{64}$/.test(value), `${name} must be null or a 64-hex sha256`).toBe(true);
    }
  });

  it('never lists an executable that is not llama-server.exe', () => {
    const exes = REAL_PIN.files.exact.filter((n) => n.toLowerCase().endsWith('.exe'));
    expect(exes).toEqual(['llama-server.exe']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// download verification
// ---------------------------------------------------------------------------------------------------------------------
describe('fetchVerified', () => {
  const zip = buildZip({ 'llama-server.exe': 'MZ-fake' });
  const sha256 = createHash('sha256').update(zip).digest('hex');
  const url = 'https://github.com/ggml-org/llama.cpp/releases/download/b10964/a.zip';

  it('returns the bytes when size and sha256 match', async () => {
    const bytes = await fetchVerified({ fetch: async () => okResponse(zip), url, sha256, size: zip.length });
    expect(bytes.equals(zip)).toBe(true);
  });

  it('refuses a plain-http URL before making any request', async () => {
    let called = 0;
    await expect(
      fetchVerified({
        fetch: async () => {
          called += 1;
          return okResponse(zip);
        },
        url: 'http://github.com/x.zip',
        sha256,
      }),
    ).rejects.toThrow(/only https/);
    expect(called).toBe(0);
  });

  it('refuses a sha256 mismatch', async () => {
    await expect(fetchVerified({ fetch: async () => okResponse(zip), url, sha256: '0'.repeat(64) })).rejects.toThrow(
      /sha256 mismatch/,
    );
  });

  it.each([null, undefined, '', 'placeholder', 'ABC'.repeat(21) + 'D'])(
    'refuses to download at all when the pin is %s (UNPINNED)',
    async (bad) => {
      let called = false;
      await expect(
        fetchVerified({
          fetch: async () => {
            called = true;
            return okResponse(zip);
          },
          url,
          sha256: bad,
        }),
      ).rejects.toThrow(/UNPINNED .*refusing to download/);
      expect(called, 'the network must not be touched for an unpinned asset').toBe(false);
    },
  );

  it('refuses a size mismatch before hashing', async () => {
    await expect(
      fetchVerified({ fetch: async () => okResponse(zip), url, sha256, size: zip.length + 1 }),
    ).rejects.toThrow(/size mismatch/);
  });

  it('refuses a non-200 response', async () => {
    await expect(fetchVerified({ fetch: async () => ({ ok: false, status: 404 }), url, sha256 })).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it('fetchText refuses a non-200 response', async () => {
    await expect(fetchText({ fetch: async () => ({ ok: false, status: 500 }), url })).rejects.toThrow(/HTTP 500/);
  });
});

describe('readZipEntries', () => {
  it('reads names and stored contents', () => {
    const zip = buildZip({ 'a/llama-server.exe': 'one', 'a/ggml.dll': 'two' });
    const entries = readZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(['a/llama-server.exe', 'a/ggml.dll']);
    expect(entries[0].read().toString()).toBe('one');
  });

  it('rejects a buffer that is not a zip', () => {
    expect(() => readZipEntries(Buffer.alloc(64))).toThrow(/not a zip archive/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the CRT staging plan
// ---------------------------------------------------------------------------------------------------------------------
describe('crtPlan / stageCrt', () => {
  const pin = pinFor(buildZip({ 'llama-server.exe': 'x' }));

  it('warns and continues when VC_REDIST_CRT_DIR is unset (it never searches the disk)', async () => {
    const plan = crtPlan({ env: {}, pin });
    expect(plan).toMatchObject({ dir: null, warning: 'VC_REDIST_CRT_DIR_UNSET' });
    const lines = [];
    const fs = memoryFs();
    const staged = await stageCrt({ plan, pin, fs, targetDir: 'C:\\t', log: (m) => lines.push(m) });
    expect(staged).toEqual([]);
    expect(lines.join('')).toContain('VC_REDIST_CRT_DIR is not set');
    expect(fs.files.size).toBe(0);
  });

  /** The same pin with the three CRT slots filled in, as `--pin-crt` leaves them on a staging machine. */
  const sha = (s) => createHash('sha256').update(Buffer.from(s)).digest('hex');
  const pinnedCrt = pinFor(buildZip({ 'llama-server.exe': 'x' }), {
    vcRedistCrt: {
      sourceEnvVar: 'VC_REDIST_CRT_DIR',
      files: { 'msvcp140.dll': sha('a'), 'vcruntime140.dll': sha('b'), 'vcruntime140_1.dll': sha('c') },
    },
  });

  it('copies exactly the three named files from the given directory', async () => {
    const dir = 'C:\\vc\\Microsoft.VC143.CRT';
    const fs = memoryFs({
      [path.normalize(path.join(dir, 'msvcp140.dll'))]: 'a',
      [path.normalize(path.join(dir, 'vcruntime140.dll'))]: 'b',
      [path.normalize(path.join(dir, 'vcruntime140_1.dll'))]: 'c',
      [path.normalize(path.join(dir, 'concrt140.dll'))]: 'never copied',
    });
    const staged = await stageCrt({
      plan: crtPlan({ env: { VC_REDIST_CRT_DIR: dir }, pin: pinnedCrt }),
      pin: pinnedCrt,
      fs,
      targetDir: 'C:\\t',
      log: () => undefined,
    });
    expect(staged).toEqual(['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']);
    expect([...fs.files.keys()].filter((k) => k.startsWith(path.normalize('C:\\t')))).toHaveLength(3);
    expect(fs.files.has(path.normalize('C:\\t\\concrt140.dll'))).toBe(false);
  });

  it('REFUSES to stage an UNPINNED file instead of warning and continuing', async () => {
    // Regression: warning-and-continuing is how an unverified DLL reaches a signed installer (wave1-audit, W2-04).
    const dir = 'C:\\vc';
    const fs = memoryFs({
      [path.normalize(path.join(dir, 'msvcp140.dll'))]: 'a',
      [path.normalize(path.join(dir, 'vcruntime140.dll'))]: 'b',
      [path.normalize(path.join(dir, 'vcruntime140_1.dll'))]: 'c',
    });
    await expect(
      stageCrt({
        plan: crtPlan({ env: { VC_REDIST_CRT_DIR: dir }, pin }),
        pin,
        fs,
        targetDir: 'C:\\t',
        log: () => undefined,
      }),
    ).rejects.toThrow(/msvcp140\.dll is UNPINNED .*refusing to stage an unverified binary/s);
    expect([...fs.files.keys()].filter((k) => k.startsWith(path.normalize('C:\\t')))).toHaveLength(0);
  });

  it('names --pin-crt in the refusal so the operator knows how to fix it', async () => {
    const dir = 'C:\\vc';
    const fs = memoryFs({ [path.normalize(path.join(dir, 'msvcp140.dll'))]: 'a' });
    await expect(
      stageCrt({
        plan: crtPlan({ env: { VC_REDIST_CRT_DIR: dir }, pin }),
        pin,
        fs,
        targetDir: 'C:\\t',
        log: () => undefined,
      }),
    ).rejects.toThrow(/--pin-crt/);
  });

  it('REFUSES a malformed (non 64-hex) pin', async () => {
    const dir = 'C:\\vc';
    const pinned = pinFor(buildZip({ 'llama-server.exe': 'x' }), {
      vcRedistCrt: {
        sourceEnvVar: 'VC_REDIST_CRT_DIR',
        files: { 'msvcp140.dll': 'not-a-hash', 'vcruntime140.dll': null, 'vcruntime140_1.dll': null },
      },
    });
    const fs = memoryFs({ [path.normalize(path.join(dir, 'msvcp140.dll'))]: 'a' });
    await expect(
      stageCrt({
        plan: crtPlan({ env: { VC_REDIST_CRT_DIR: dir }, pin: pinned }),
        pin: pinned,
        fs,
        targetDir: 'C:\\t',
        log: () => undefined,
      }),
    ).rejects.toThrow(/malformed sha256 pin/);
  });

  it('stages a file whose pin matches', async () => {
    const dir = 'C:\\vc';
    const digest = createHash('sha256').update(Buffer.from('a')).digest('hex');
    const pinned = pinFor(buildZip({ 'llama-server.exe': 'x' }), {
      vcRedistCrt: { sourceEnvVar: 'VC_REDIST_CRT_DIR', files: { 'msvcp140.dll': digest } },
    });
    const fs = memoryFs({ [path.normalize(path.join(dir, 'msvcp140.dll'))]: 'a' });
    const staged = await stageCrt({
      plan: crtPlan({ env: { VC_REDIST_CRT_DIR: dir }, pin: pinned }),
      pin: pinned,
      fs,
      targetDir: 'C:\\t',
      log: () => undefined,
    });
    expect(staged).toEqual(['msvcp140.dll']);
  });

  it('crtDigests hashes the three files without copying or executing anything', async () => {
    const dir = 'C:\\vc';
    const fs = memoryFs({
      [path.normalize(path.join(dir, 'msvcp140.dll'))]: 'a',
      [path.normalize(path.join(dir, 'vcruntime140.dll'))]: 'b',
      [path.normalize(path.join(dir, 'vcruntime140_1.dll'))]: 'c',
    });
    const digests = await crtDigests({ plan: crtPlan({ env: { VC_REDIST_CRT_DIR: dir }, pin }), fs });
    expect(digests).toEqual({ 'msvcp140.dll': sha('a'), 'vcruntime140.dll': sha('b'), 'vcruntime140_1.dll': sha('c') });
    expect([...fs.files.keys()].filter((k) => k.startsWith(path.normalize('C:\\t')))).toHaveLength(0);
  });

  it('crtDigests refuses without VC_REDIST_CRT_DIR (it never searches the disk)', async () => {
    await expect(crtDigests({ plan: crtPlan({ env: {}, pin }), fs: memoryFs() })).rejects.toThrow(/VC_REDIST_CRT_DIR/);
  });

  it('REFUSES a file whose sha256 does not match its pin', async () => {
    const dir = 'C:\\vc';
    const pinned = pinFor(buildZip({ 'llama-server.exe': 'x' }), {
      vcRedistCrt: {
        sourceEnvVar: 'VC_REDIST_CRT_DIR',
        files: { 'msvcp140.dll': '0'.repeat(64), 'vcruntime140.dll': null, 'vcruntime140_1.dll': null },
      },
    });
    const fs = memoryFs({ [path.normalize(path.join(dir, 'msvcp140.dll'))]: 'a' });
    await expect(
      stageCrt({
        plan: crtPlan({ env: { VC_REDIST_CRT_DIR: dir }, pin: pinned }),
        pin: pinned,
        fs,
        targetDir: 'C:\\t',
        log: () => undefined,
      }),
    ).rejects.toThrow(/sha256 does not match the pin/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------------------------------------------------
describe('main', () => {
  const root = 'C:\\repo';
  const zip = buildZip({
    'llama-server.exe': 'MZ-server',
    'ggml.dll': 'ggml',
    'ggml-cpu-haswell.dll': 'cpu',
    'llama-cli.exe': 'NEVER',
    'rpc-server.exe': 'NEVER',
    'vulkan-1.dll': 'NEVER',
  });
  const pin = pinFor(zip);

  const run = async (over = {}) => {
    const fs = memoryFs({ [path.normalize(path.join(root, PIN_PATH))]: JSON.stringify(pin) });
    const lines = [];
    const result = await main({
      root,
      fs,
      env: {},
      log: (m) => lines.push(m),
      fetch: async (url) => (url === pin.llama.licenseUrl ? okResponse('MIT License text') : okResponse(zip)),
      ...over,
    });
    return { fs, lines, result };
  };

  it('unpacks ONLY the allow-listed files and never the extra executables in the asset', async () => {
    const { result } = await run();
    expect(result.files).toEqual(['ggml-cpu-haswell.dll', 'ggml.dll', 'llama-server.exe']);
    expect(result.files).not.toContain('llama-cli.exe');
    expect(result.files).not.toContain('rpc-server.exe');
    expect(result.files).not.toContain('vulkan-1.dll');
  });

  // `[repair-packaging-blocker]` This script used to write `resources/licenses/THIRD_PARTY_NOTICES.txt`, which is
  // generated by `scripts/smoke-packaged.notices.mjs` from eight sources. The release notices then depended on which
  // of the two scripts ran last. The two files are now disjoint, and that disjointness is the assertion.
  it('writes the verbatim llama.cpp MIT text into its OWN file, llama.cpp-MIT.txt', async () => {
    const { fs } = await run();
    const mit = fs.files.get(path.normalize(path.join(root, ...LLAMA_MIT_PATH.split('/')))).toString('utf8');
    expect(mit).toBe('MIT License text\n');
  });

  it('never touches THIRD_PARTY_NOTICES.txt - that file belongs to the notices generator', async () => {
    const { fs } = await run();
    const written = [...fs.files.keys()].map((k) => k.replace(/\\/g, '/'));
    expect(written.some((k) => k.endsWith('THIRD_PARTY_NOTICES.txt'))).toBe(false);
    expect(written.some((k) => k.endsWith('llama.cpp-MIT.txt'))).toBe(true);
  });

  it('writes a MANIFEST.txt listing everything it staged', async () => {
    const { fs, result } = await run();
    const manifest = fs.files
      .get(path.normalize(path.join(root, ...pin.llama.targetDir.split('/'), MANIFEST_NAME)))
      .toString('utf8');
    expect(manifest.trim().split('\n')).toEqual(result.files);
  });

  it('fails when the pinned asset does not contain llama-server.exe', async () => {
    const withoutServer = buildZip({ 'ggml.dll': 'ggml' });
    const badPin = pinFor(withoutServer);
    const fs = memoryFs({ [path.normalize(path.join(root, PIN_PATH))]: JSON.stringify(badPin) });
    await expect(
      main({ root, fs, env: {}, log: () => undefined, fetch: async () => okResponse(withoutServer) }),
    ).rejects.toThrow(/llama-server\.exe is not in the pinned asset/);
  });

  it('fails before unpacking when the download does not match the pin', async () => {
    const fs = memoryFs({ [path.normalize(path.join(root, PIN_PATH))]: JSON.stringify(pin) });
    const tampered = buildZip({ 'llama-server.exe': 'TAMPERED' });
    await expect(
      main({ root, fs, env: {}, log: () => undefined, fetch: async () => okResponse(tampered) }),
    ).rejects.toThrow(/size mismatch|sha256 mismatch/);
    expect([...fs.files.keys()]).toEqual([path.normalize(path.join(root, PIN_PATH))]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// static source rules
// ---------------------------------------------------------------------------------------------------------------------
describe('fetch-llama.mjs source (static)', () => {
  const src = readFileSync(fileURLToPath(new URL('./fetch-llama.mjs', import.meta.url)), 'utf8');

  it('never spawns, execs or otherwise runs the binaries it stages', () => {
    expect(src).not.toMatch(/\bspawn\w*\s*\(/);
    expect(src).not.toMatch(/\bexec\w*\s*\(/);
    expect(src).not.toMatch(/child_process/);
  });

  it('never globs for DLLs and never lists a directory', () => {
    // the comment header may quote the rule; the CODE must contain neither a glob nor a directory listing
    const code = src
      .replace(/\/\*[^]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/\*\.dll/);
    expect(code).not.toMatch(/readdir/);
    expect(code).not.toMatch(/\bglob\b/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// --pin-crt: the ONLY way the CRT nulls are ever filled
// ---------------------------------------------------------------------------------------------------------------------
describe('pinCrt / applyCrtPins', () => {
  const sha = (s) => createHash('sha256').update(Buffer.from(s)).digest('hex');

  it('rewrites only the three values and leaves comments + formatting untouched', () => {
    const source = readFileSync(path.join(ROOT, PIN_PATH), 'utf8');
    const digests = { 'msvcp140.dll': sha('a'), 'vcruntime140.dll': sha('b'), 'vcruntime140_1.dll': sha('c') };
    const out = applyCrtPins(source, digests);
    expect(JSON.parse(out).vcRedistCrt.files).toEqual(digests);
    // every other field survives byte-for-byte
    const before = JSON.parse(source);
    const after = JSON.parse(out);
    expect(after.llama).toEqual(before.llama);
    expect(after.files).toEqual(before.files);
    expect(out).toContain(before.vcRedistCrt._comment);
    // the diff is exactly three lines
    const changed = out.split('\n').filter((l, i) => l !== source.split('\n')[i]);
    expect(changed).toHaveLength(3);
  });

  it('is idempotent - re-pinning an already pinned file replaces the old hash', () => {
    const once = applyCrtPins(readFileSync(path.join(ROOT, PIN_PATH), 'utf8'), { 'msvcp140.dll': sha('a') });
    const twice = applyCrtPins(once, { 'msvcp140.dll': sha('z') });
    expect(JSON.parse(twice).vcRedistCrt.files['msvcp140.dll']).toBe(sha('z'));
  });

  it('refuses a name that has no slot in the pin file', () => {
    expect(() => applyCrtPins('{}', { 'concrt140.dll': sha('a') })).toThrow(/no slot/);
  });

  it('pinCrt writes the hashes of the folder the staging machine actually owns', async () => {
    const root = 'C:\\repo';
    const dir = 'C:\\vc\\Microsoft.VC143.CRT';
    const fs = memoryFs({
      [path.normalize(path.join(root, PIN_PATH))]: readFileSync(path.join(ROOT, PIN_PATH), 'utf8'),
      [path.normalize(path.join(dir, 'msvcp140.dll'))]: 'a',
      [path.normalize(path.join(dir, 'vcruntime140.dll'))]: 'b',
      [path.normalize(path.join(dir, 'vcruntime140_1.dll'))]: 'c',
    });
    const lines = [];
    const digests = await pinCrt({ root, fs, env: { VC_REDIST_CRT_DIR: dir }, log: (m) => lines.push(m) });
    expect(digests['msvcp140.dll']).toBe(sha('a'));
    const written = (await fs.readFile(path.join(root, PIN_PATH), 'utf8')).toString();
    expect(JSON.parse(written).vcRedistCrt.files).toEqual(digests);
    expect(lines.join('\n')).toContain('commit this change deliberately');
  });

  it('after pinCrt, stageCrt accepts the very bytes that were pinned', async () => {
    const root = 'C:\\repo';
    const dir = 'C:\\vc';
    const fs = memoryFs({
      [path.normalize(path.join(root, PIN_PATH))]: readFileSync(path.join(ROOT, PIN_PATH), 'utf8'),
      [path.normalize(path.join(dir, 'msvcp140.dll'))]: 'a',
      [path.normalize(path.join(dir, 'vcruntime140.dll'))]: 'b',
      [path.normalize(path.join(dir, 'vcruntime140_1.dll'))]: 'c',
    });
    await pinCrt({ root, fs, env: { VC_REDIST_CRT_DIR: dir }, log: () => undefined });
    const pin = JSON.parse((await fs.readFile(path.join(root, PIN_PATH), 'utf8')).toString());
    const staged = await stageCrt({
      plan: crtPlan({ env: { VC_REDIST_CRT_DIR: dir }, pin }),
      pin,
      fs,
      targetDir: 'C:\\t',
      log: () => undefined,
    });
    expect(staged).toEqual(['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']);
  });

  it('pinCrt still never runs a binary', async () => {
    const root = 'C:\\repo';
    const dir = 'C:\\vc';
    const fs = memoryFs({
      [path.normalize(path.join(root, PIN_PATH))]: readFileSync(path.join(ROOT, PIN_PATH), 'utf8'),
      [path.normalize(path.join(dir, 'msvcp140.dll'))]: 'a',
      [path.normalize(path.join(dir, 'vcruntime140.dll'))]: 'b',
      [path.normalize(path.join(dir, 'vcruntime140_1.dll'))]: 'c',
    });
    // no fetch is injected at all: pinCrt must be a pure local-filesystem operation
    await expect(pinCrt({ root, fs, env: { VC_REDIST_CRT_DIR: dir }, log: () => undefined })).resolves.toBeTruthy();
  });
});
