// scripts/fetch-whisper.test.mjs - owner V2-W1-07-media-voice. fetch-whisper.mjs with an INJECTED fetch and an in-memory fs: no network,
// nothing executed (T8). Pin of record = ARCH-v2 B18; Release/ stripped; only the allow-list staged; own MIT file, never the notices.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MANIFEST_PATH,
  main,
  PIN_PATH,
  stripReleasePrefix,
  SUMS_PATH,
  sumsText,
  WHISPER_MIT_PATH,
} from './fetch-whisper.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REAL_PIN = JSON.parse(readFileSync(path.join(ROOT, PIN_PATH), 'utf8'));

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
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
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
  return {
    files,
    readFile: async (p, enc) => {
      const key = path.normalize(p);
      if (!files.has(key)) throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' });
      const v = files.get(key);
      return enc === undefined ? Buffer.from(v) : Buffer.from(v).toString(enc);
    },
    writeFile: async (p, data) =>
      void files.set(path.normalize(p), Buffer.isBuffer(data) ? data : Buffer.from(String(data))),
    mkdir: async () => undefined,
  };
}
const okResponse = (body) => ({ ok: true, status: 200, arrayBuffer: async () => body, text: async () => String(body) });
const pinFor = (zip) => ({
  ...REAL_PIN,
  whisper: { ...REAL_PIN.whisper, size: zip.length, sha256: createHash('sha256').update(zip).digest('hex') },
});

describe('vendor/whisper.pin.json (ARCH-v2 B18 pin of record)', () => {
  it('tag b5130, 8,573,270 B, the B18 sha256, https GitHub release URL, own target folder', () => {
    expect(REAL_PIN.whisper.tag).toBe('b5130');
    expect(REAL_PIN.whisper.size).toBe(8_573_270);
    expect(REAL_PIN.whisper.sha256).toBe('f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c');
    expect(REAL_PIN.whisper.url).toBe(
      'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip',
    );
    expect(REAL_PIN.whisper.licenseUrl).toContain('/b5130/LICENSE');
    expect(REAL_PIN.whisper.targetDir).toBe('vendor/whisper/win-x64-cpu');
    expect(REAL_PIN.files.exact).toEqual(['whisper-cli.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll']);
    expect(REAL_PIN.files.prefix).toEqual(['ggml-cpu-']);
    expect(Object.values(REAL_PIN.vcRedistCrt.files)).toEqual([null, null, null]);
  });
});

describe('stripReleasePrefix', () => {
  it('strips exactly Release/ and refuses other folders', () => {
    expect(stripReleasePrefix('Release/whisper-cli.exe')).toBe('whisper-cli.exe');
    expect(stripReleasePrefix('whisper.dll')).toBe('whisper.dll');
    expect(stripReleasePrefix('Release\\ggml.dll')).toBe('ggml.dll');
    expect(stripReleasePrefix('Release/sub/ggml.dll')).toBeNull();
    expect(stripReleasePrefix('Debug/ggml.dll')).toBeNull();
    expect(stripReleasePrefix('Release/')).toBeNull();
    expect(stripReleasePrefix('..')).toBeNull();
  });
});

describe('main (injected fetch, in-memory fs)', () => {
  const root = 'C:\\repo';
  const zip = buildZip({
    'Release/whisper-cli.exe': 'MZ-cli',
    'Release/whisper.dll': 'w',
    'Release/ggml.dll': 'g',
    'Release/ggml-base.dll': 'gb',
    'Release/ggml-cpu-haswell.dll': 'cpu',
    'Release/whisper-server.exe': 'NEVER',
    'Release/main.exe': 'NEVER',
    'Release/SDL2.dll': 'NEVER',
    'Release/nested/ggml-cpu-x.dll': 'NEVER',
    'Release/': '',
  });
  const run = async (over = {}, z = zip, pin = pinFor(zip)) => {
    const fs = memoryFs({ [path.normalize(path.join(root, PIN_PATH))]: JSON.stringify(pin) });
    const urls = [];
    const lines = [];
    const result = await main({
      root,
      fs,
      env: {},
      log: (m) => lines.push(m),
      fetch: async (url) => {
        urls.push(url);
        return url === pin.whisper.licenseUrl ? okResponse('MIT License whisper.cpp') : okResponse(z);
      },
      ...over,
    });
    return { fs, result, urls, lines };
  };

  it('stages ONLY the allow-list, Release/ stripped, into vendor/whisper/win-x64-cpu; writes MANIFEST.txt and its own MIT file', async () => {
    const { fs, result, urls, lines } = await run();
    expect(result.files).toEqual([
      'ggml-base.dll',
      'ggml-cpu-haswell.dll',
      'ggml.dll',
      'whisper-cli.exe',
      'whisper.dll',
    ]);
    expect(result.targetDir).toBe(path.join(root, 'vendor', 'whisper', 'win-x64-cpu'));
    const manifest = fs.files.get(path.normalize(path.join(root, ...MANIFEST_PATH.split('/')))).toString('utf8');
    expect(manifest.trim().split('\n')).toEqual(result.files);
    expect(fs.files.get(path.normalize(path.join(root, ...WHISPER_MIT_PATH.split('/')))).toString('utf8')).toBe(
      'MIT License whisper.cpp\n',
    );
    const written = [...fs.files.keys()].map((k) => k.replace(/\\/g, '/'));
    expect(written.some((k) => k.endsWith('THIRD_PARTY_NOTICES.txt'))).toBe(false);
    expect(written.some((k) => /whisper-server|main\.exe|SDL2/.test(k))).toBe(false);
    expect(written.some((k) => k.includes('vendor/llama'))).toBe(false);
    expect(urls).toEqual([REAL_PIN.whisper.url, REAL_PIN.whisper.licenseUrl]);
    expect(lines.join('\n')).toContain('VC_REDIST_CRT_DIR is not set');
  });

  it('[V2-W2-04] writes vendor/whisper/SHA256SUMS: one `<sha256> *<name>` line per staged file, sorted (T2 11 check 7)', async () => {
    const { fs, result } = await run();
    const sums = fs.files.get(path.normalize(path.join(root, ...SUMS_PATH.split('/')))).toString('utf8');
    const sha = (s) => createHash('sha256').update(s).digest('hex');
    expect(sums).toBe(
      [
        `${sha('gb')} *ggml-base.dll`,
        `${sha('cpu')} *ggml-cpu-haswell.dll`,
        `${sha('g')} *ggml.dll`,
        `${sha('MZ-cli')} *whisper-cli.exe`,
        `${sha('w')} *whisper.dll`,
        '',
      ].join('\n'),
    );
    expect(Object.keys(result.digests)).toEqual(result.files);
    expect(sumsText({ 'b.dll': 'bb', 'a.dll': 'aa' })).toBe('aa *a.dll\nbb *b.dll\n');
  });

  it('refuses before unpacking when the bytes do not match the pin; refuses an unpinned asset without any request', async () => {
    const tampered = buildZip({ 'Release/whisper-cli.exe': 'TAMPERED' });
    await expect(run({}, tampered)).rejects.toThrow(/size mismatch|sha256 mismatch/);
    const noPin = { ...pinFor(zip), whisper: { ...pinFor(zip).whisper, sha256: null } };
    let calls = 0;
    await expect(run({ fetch: async () => ((calls += 1), okResponse(zip)) }, zip, noPin)).rejects.toThrow(/UNPINNED/);
    expect(calls).toBe(0);
  });

  it('fails when a required file is missing from the asset', async () => {
    const partial = buildZip({ 'Release/whisper-cli.exe': 'x', 'Release/ggml.dll': 'g' });
    await expect(run({}, partial, pinFor(partial))).rejects.toThrow(/whisper\.dll is not in the pinned asset/);
  });

  it('CRT: an UNPINNED CRT file is refused when VC_REDIST_CRT_DIR is set', async () => {
    await expect(
      run({
        env: { VC_REDIST_CRT_DIR: 'C:\\crt' },
        fs: (() => {
          const fs = memoryFs({
            [path.normalize(path.join(root, PIN_PATH))]: JSON.stringify(pinFor(zip)),
            [path.normalize('C:\\crt\\msvcp140.dll')]: 'crt',
          });
          return fs;
        })(),
      }),
    ).rejects.toThrow(/UNPINNED/);
  });

  it('the script never spawns or executes anything (static)', () => {
    const src = readFileSync(path.join(ROOT, 'scripts', 'fetch-whisper.mjs'), 'utf8');
    expect(src).not.toMatch(/child_process|execFile|spawn\(|\.exec\(/);
  });
});
