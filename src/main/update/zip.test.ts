// src/main/update/zip.test.ts - v5 W2: the minimal ZIP extractor against a real PowerShell Compress-Archive zip and against
// hand-built malicious archives (traversal, absolute paths, symlinks, bombs, CRC, methods, limits).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ZIP_LIMITS, ZipError, crc32, extractZip, safeEntrySegments } from './zip';
import { buildZip, type ForgedEntry } from './zip.fixtures';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wca-zip-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function extractBuilt(entries: ForgedEntry[], limits = DEFAULT_ZIP_LIMITS) {
  const d = tmp();
  const zip = join(d, 'x.zip');
  writeFileSync(zip, buildZip(entries));
  const dest = join(d, 'out');
  return { result: extractZip(zip, dest, limits), dest, root: d };
}
async function expectRefused(entries: ForgedEntry[], reason: string, limits = DEFAULT_ZIP_LIMITS) {
  const { result, dest, root } = await extractBuilt(entries, limits);
  const err = await result.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ZipError);
  expect((err as ZipError).reason).toBe(reason);
  expect(existsSync(dest), 'a refused archive leaves no destination behind').toBe(false);
  expect(readdirSync(root)).toEqual(['x.zip']); // nothing written next to the destination either
}

// ---------------------------------------------------------------------------------------------------------------------
describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe('safeEntrySegments', () => {
  it.each([
    ['a.txt', ['a.txt']],
    ['dir/sub/b.bin', ['dir', 'sub', 'b.bin']],
    ['dir\\sub\\b.bin', ['dir', 'sub', 'b.bin']], // Windows PowerShell 5.1 Compress-Archive writes backslashes
    ['locales/he.pak', ['locales', 'he.pak']],
    ['WhatsApp Calendar Agent.exe', ['WhatsApp Calendar Agent.exe']],
  ])('accepts %j', (name, segs) => {
    expect(safeEntrySegments(name)).toEqual(segs);
  });
  it.each([
    '../evil.txt',
    '..\\evil.txt',
    'a/../../evil.txt',
    'a/./b',
    '/abs.txt',
    '\\abs.txt',
    '\\\\server\\share\\x',
    'C:/Windows/x.dll',
    'C:evil.txt',
    'a/b:stream',
    'a//b',
    '.. /x',
    'x/..',
    'a/ends-with-dot.',
    'CON',
    'dir/nul.txt',
    'COM1.log',
    'a/b\u0000c',
    'a/b\u0001c',
    'a/b?c',
    'a/b*c',
    'a/b|c',
    'a/b"c',
    'a/<b>',
    '',
  ])('refuses %j', (name) => {
    expect(safeEntrySegments(name)).toBeNull();
  });
});

describe('extractZip - well-formed archives', () => {
  it('extracts stored + deflated entries, nested dirs, an empty file and an explicit directory entry', async () => {
    const big = Buffer.alloc(200_000);
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 7) & 0xff;
    const { result, dest } = await extractBuilt([
      { name: 'top.txt', data: Buffer.from('hello'), method: 0 },
      { name: 'dir/', data: Buffer.alloc(0), method: 0 },
      { name: 'dir/sub/big.bin', data: big },
      { name: 'dir\\empty.txt', data: Buffer.alloc(0) },
      { name: 'שלום.txt', data: Buffer.from('utf8 name') },
    ]);
    expect(await result).toEqual({ files: 4, dirs: 1, bytes: 5 + big.length + 9 });
    expect(readFileSync(join(dest, 'top.txt'), 'utf8')).toBe('hello');
    expect(readFileSync(join(dest, 'dir', 'sub', 'big.bin')).equals(big)).toBe(true);
    expect(readFileSync(join(dest, 'dir', 'empty.txt')).length).toBe(0);
    expect(readFileSync(join(dest, 'שלום.txt'), 'utf8')).toBe('utf8 name');
  });

  it('refuses to extract into an existing destination', async () => {
    const d = tmp();
    const zip = join(d, 'x.zip');
    writeFileSync(zip, buildZip([{ name: 'a', data: Buffer.from('a') }]));
    mkdirSync(join(d, 'out'));
    await expect(extractZip(zip, join(d, 'out'))).rejects.toMatchObject({ reason: 'dest_exists' });
  });

  const powershellAvailable = ((): boolean => {
    if (process.platform !== 'win32') return false;
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 30_000,
    });
    return r.status === 0;
  })();
  it.skipIf(!powershellAvailable)(
    powershellAvailable
      ? 'round-trips a zip written by PowerShell Compress-Archive (the CI packaging step)'
      : 'round-trips a zip written by PowerShell Compress-Archive - SKIPPED: powershell is not available on this machine',
    async () => {
      const d = tmp();
      const src = join(d, 'src');
      mkdirSync(join(src, 'resources', 'llama'), { recursive: true });
      mkdirSync(join(src, 'locales'), { recursive: true });
      const bin = Buffer.alloc(300_000);
      for (let i = 0; i < bin.length; i += 1) bin[i] = (i * 13 + (i >> 8)) & 0xff;
      writeFileSync(join(src, 'WhatsApp Calendar Agent.exe'), bin);
      writeFileSync(join(src, 'resources', 'llama', 'llama.dll'), Buffer.from('MZ fake dll'));
      writeFileSync(join(src, 'locales', 'he.pak'), Buffer.from('he'));
      writeFileSync(join(src, 'empty.txt'), Buffer.alloc(0));
      const zip = join(d, 'pkg.zip');
      const ps = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Compress-Archive -Path '${join(src, '*')}' -DestinationPath '${zip}' -Force`,
        ],
        { stdio: 'pipe', windowsHide: true, timeout: 60_000 },
      );
      expect(ps.status, String(ps.stderr)).toBe(0);
      const dest = join(d, 'out');
      const res = await extractZip(zip, dest);
      expect(res.files).toBe(4);
      expect(readFileSync(join(dest, 'WhatsApp Calendar Agent.exe')).equals(bin)).toBe(true);
      expect(readFileSync(join(dest, 'resources', 'llama', 'llama.dll'), 'utf8')).toBe('MZ fake dll');
      expect(readFileSync(join(dest, 'locales', 'he.pak'), 'utf8')).toBe('he');
      expect(readFileSync(join(dest, 'empty.txt')).length).toBe(0);
    },
    60_000,
  );

  it.skipIf(!powershellAvailable)(
    powershellAvailable
      ? 'round-trips a zip written by .NET ZipArchive exactly as .github/workflows/release.yml writes it'
      : 'round-trips a .NET ZipArchive zip - SKIPPED: powershell is not available on this machine',
    async () => {
      const d = tmp();
      const src = join(d, 'win-unpacked');
      mkdirSync(join(src, 'resources', 'calendar-mcp', 'node_modules', 'x'), { recursive: true });
      const rnd = Buffer.alloc(2_000_000);
      let x = 0x2545f491;
      for (let i = 0; i < rnd.length; i += 1) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        rnd[i] = x & 0xff;
      }
      writeFileSync(join(src, 'WhatsApp Calendar Agent.exe'), rnd);
      writeFileSync(join(src, 'resources', 'calendar-mcp', 'node_modules', 'x', 'index.js'), 'module.exports = 1;');
      writeFileSync(join(src, 'LICENSE.electron.txt'), 'MIT '.repeat(5000));
      writeFileSync(join(src, 'empty.txt'), Buffer.alloc(0));
      const zip = join(d, 'release.zip');
      // the release workflow's own zip step (ordinal names, '/' separators, Optimal compression)
      const script = [
        `$src = '${src}'`,
        `$out = '${zip}'`,
        'Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem',
        '$map = @{}',
        "foreach ($f in Get-ChildItem -LiteralPath $src -Recurse -File -Force) { $map[$f.FullName.Substring($src.Length + 1).Replace('\\', '/')] = $f.FullName }",
        '$names = [string[]]@($map.Keys)',
        '[Array]::Sort($names, [StringComparer]::Ordinal)',
        '$stream = [System.IO.File]::Open($out, [System.IO.FileMode]::CreateNew)',
        '$archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)',
        'try { foreach ($n in $names) { [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $map[$n], $n, [System.IO.Compression.CompressionLevel]::Optimal) } } finally { $archive.Dispose(); $stream.Dispose() }',
      ].join('; ');
      const ps = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: 'pipe',
        windowsHide: true,
        timeout: 60_000,
      });
      expect(ps.status, String(ps.stderr)).toBe(0);
      const dest = join(d, 'out');
      expect(await extractZip(zip, dest)).toMatchObject({ files: 4 });
      expect(readFileSync(join(dest, 'WhatsApp Calendar Agent.exe')).equals(rnd)).toBe(true);
      expect(readFileSync(join(dest, 'resources', 'calendar-mcp', 'node_modules', 'x', 'index.js'), 'utf8')).toBe(
        'module.exports = 1;',
      );
      expect(readFileSync(join(dest, 'LICENSE.electron.txt'), 'utf8')).toBe('MIT '.repeat(5000));
    },
    60_000,
  );
});

describe('extractZip - refusals (nothing is written)', () => {
  const ok = { name: 'fine.txt', data: Buffer.from('fine') };
  it.each([
    ['parent traversal', '../evil.txt'],
    ['backslash traversal', '..\\..\\evil.dll'],
    ['nested traversal', 'a/../../evil.txt'],
    ['absolute path', '/Windows/evil.dll'],
    ['drive path', 'C:\\Windows\\evil.dll'],
    ['UNC path', '\\\\host\\share\\evil'],
    ['alternate data stream', 'fine.txt:hidden'],
    ['device name', 'dir/CON'],
  ])('%s', async (_label, name) => {
    await expectRefused([ok, { name, data: Buffer.from('x') }], 'unsafe_path');
  });

  it('a Unix symlink entry', async () => {
    await expectRefused(
      [ok, { name: 'link', data: Buffer.from('/etc/passwd'), madeBy: (3 << 8) | 20, extAttr: (0o120777 << 16) >>> 0 }],
      'symlink',
    );
  });
  it('a Windows reparse-point entry', async () => {
    await expectRefused([ok, { name: 'junction', data: Buffer.from('x'), extAttr: 0x400 }], 'symlink');
  });
  it('a CRC mismatch', async () => {
    await expectRefused([ok, { name: 'b.txt', data: Buffer.from('payload'), crc: 0x12345678 }], 'crc_mismatch');
  });
  it('a deflate bomb (declared size smaller than the real output)', async () => {
    await expectRefused([{ name: 'bomb.bin', data: Buffer.alloc(5_000_000), size: 1000 }], 'size_mismatch');
  });
  it('a declared size larger than the real output', async () => {
    await expectRefused([{ name: 'short.bin', data: Buffer.from('abc'), size: 10 }], 'size_mismatch');
  });
  it('a stored entry whose sizes disagree', async () => {
    await expectRefused([{ name: 's.bin', data: Buffer.from('abc'), method: 0, size: 2 }], 'size_mismatch');
  });
  it('an unsupported compression method', async () => {
    await expectRefused([{ name: 'b.bz2', data: Buffer.from('x'), method: 12 }], 'unsupported_method');
  });
  it('an encrypted entry', async () => {
    await expectRefused([{ name: 'e.txt', data: Buffer.from('x'), flags: 0x0801 }], 'encrypted');
  });
  it('a duplicate name (case-insensitive, as on NTFS)', async () => {
    await expectRefused(
      [
        { name: 'App.exe', data: Buffer.from('1') },
        { name: 'app.EXE', data: Buffer.from('2') },
      ],
      'duplicate_entry',
    );
  });
  it('a local header naming a different file than the central directory', async () => {
    await expectRefused([{ name: 'good.txt', localName: '../bad.txt', data: Buffer.from('x') }], 'header_mismatch');
  });
  it('a directory entry that carries data', async () => {
    await expectRefused([{ name: 'dir/', data: Buffer.from('x'), method: 0 }], 'bad_directory_entry');
  });
  it('more entries than the limit', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `f${String(i)}.txt`, data: Buffer.from('x') }));
    await expectRefused(many, 'too_many_entries', { ...DEFAULT_ZIP_LIMITS, maxEntries: 5 });
  });
  it('more total bytes than the limit', async () => {
    await expectRefused(
      [
        { name: 'a.bin', data: Buffer.alloc(600) },
        { name: 'b.bin', data: Buffer.alloc(600) },
      ],
      'too_large',
      { ...DEFAULT_ZIP_LIMITS, maxTotalBytes: 1000 },
    );
  });
  it('one entry bigger than the per-entry limit', async () => {
    await expectRefused([{ name: 'a.bin', data: Buffer.alloc(600) }], 'too_large', {
      ...DEFAULT_ZIP_LIMITS,
      maxEntryBytes: 500,
    });
  });
  it('a file that is not a zip', async () => {
    const d = tmp();
    const zip = join(d, 'x.zip');
    writeFileSync(zip, Buffer.from('<html>captive portal</html>'));
    await expect(extractZip(zip, join(d, 'out'))).rejects.toMatchObject({ reason: 'not_a_zip' });
    expect(existsSync(join(d, 'out'))).toBe(false);
  });
  it('a truncated zip (central directory past the end)', async () => {
    const d = tmp();
    const full = buildZip([ok, { name: 'b.txt', data: Buffer.alloc(1000, 1) }]);
    const eocd = full.subarray(full.length - 22);
    const cut = Buffer.concat([full.subarray(0, 40), eocd]);
    const zip = join(d, 'x.zip');
    writeFileSync(zip, cut);
    await expect(extractZip(zip, join(d, 'out'))).rejects.toBeInstanceOf(ZipError);
    expect(existsSync(join(d, 'out'))).toBe(false);
  });
  it('an empty archive', async () => {
    await expectRefused([], 'empty');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('extractZip - large entries are streamed (review fix pass)', () => {
  const STREAM_ALL = { ...DEFAULT_ZIP_LIMITS, streamAboveBytes: 0 };
  const noise = (n: number): Buffer => {
    const b = Buffer.alloc(n);
    let x = 0x2545f491;
    for (let i = 0; i < n; i += 1) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      b[i] = x & 0xff;
    }
    return b;
  };

  it('a real 9 MiB deflated entry (above the 8 MiB default) and a stored one are written byte-exact', async () => {
    const big = noise(9 * 1024 * 1024);
    const { result, dest } = await extractBuilt([
      { name: 'app/WhatsApp Calendar Agent.exe', data: big },
      { name: 'app/resources/app.asar', data: big, method: 0 },
      { name: 'app/small.txt', data: Buffer.from('small') },
    ]);
    expect(await result).toEqual({ files: 3, dirs: 0, bytes: big.length * 2 + 5 });
    expect(readFileSync(join(dest, 'app', 'WhatsApp Calendar Agent.exe')).equals(big)).toBe(true);
    expect(readFileSync(join(dest, 'app', 'resources', 'app.asar')).equals(big)).toBe(true);
    expect(readFileSync(join(dest, 'app', 'small.txt'), 'utf8')).toBe('small');
  });

  it('streamed: a CRC mismatch is refused and nothing is left behind', async () => {
    await expectRefused([{ name: 'x.bin', data: noise(4096), crc: 1 }], 'crc_mismatch', STREAM_ALL);
  });
  it('streamed: a deflate bomb (more output than declared) is refused while streaming', async () => {
    await expectRefused([{ name: 'bomb.bin', data: Buffer.alloc(5_000_000), size: 1000 }], 'size_mismatch', STREAM_ALL);
  });
  it('streamed: less output than declared is refused', async () => {
    await expectRefused([{ name: 'short.bin', data: Buffer.from('abc'), size: 10 }], 'size_mismatch', STREAM_ALL);
  });
  it('streamed: corrupt deflate data is refused', async () => {
    const zip = buildZip([{ name: 'c.bin', data: noise(4096) }]);
    zip.fill(0xff, 30 + 'c.bin'.length, 30 + 'c.bin'.length + 64); // trash the start of the deflate stream
    const d = tmp();
    writeFileSync(join(d, 'x.zip'), zip);
    const err = await extractZip(join(d, 'x.zip'), join(d, 'out'), STREAM_ALL).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ZipError);
    expect(['corrupt', 'size_mismatch', 'crc_mismatch']).toContain((err as ZipError).reason);
    expect(existsSync(join(d, 'out'))).toBe(false);
  });
});
