// scripts/import-bridge.test.mjs - TESTS 5.3 row `scripts/*.mjs` (vitest project `main`). Uses a DUMMY fixture written to a temp
// directory; the real exe and the reference bridge tree are never touched (tests/setup-guards.ts would refuse them anyway).
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_EXE_SHA256, BRIDGE_EXE_SIZE, importBridgeFile, sha256sumsLine } from './import-bridge.mjs';

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wca-import-bridge-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

describe('import-bridge.mjs source (static)', () => {
  const src = readFileSync(fileURLToPath(new URL('./import-bridge.mjs', import.meta.url)), 'utf8');
  it('contains no readdir / opendir / glob, no spawn / exec* and does not import child_process', () => {
    expect(src).not.toMatch(/readdir|opendir|glob\(/i);
    expect(src).not.toMatch(/\bspawn|\bexec[A-Za-z]*\s*\(|child_process/);
  });
  it('its only source path literal ends with whatsapp-bridge.exe and never names store', () => {
    const literals = [...src.matchAll(/'C:\\\\[^']*'/g)].map((m) => m[0]);
    expect(literals).toHaveLength(1);
    expect(literals[0]).toMatch(/whatsapp-bridge\.exe'$/);
    expect(src).not.toMatch(/[\\/]store\b/);
  });
  it('pins are the ARCH 4.1 values', () => {
    expect(BRIDGE_EXE_SIZE).toBe(43_540_541);
    expect(BRIDGE_EXE_SHA256).toBe('ac23221e8bcf3937a4ca346b3bd80a8da09df94cbecd949af2916c4bc8d22ff5');
  });
});

describe('importBridgeFile (dummy fixture)', () => {
  it('copies exactly one file when size and sha256 match and leaves no temp file', async () => {
    const d = tmp();
    const body = Buffer.from('dummy bridge fixture - not an executable\n'.repeat(100));
    const src = join(d, 'dummy.bin');
    writeFileSync(src, body);
    const dest = join(d, 'out', 'nested', 'whatsapp-bridge.exe');
    const r = await importBridgeFile({ src, dest, expectedSize: body.length, expectedSha256: sha(body).toUpperCase() });
    expect(r).toEqual({ sha256: sha(body), bytes: body.length });
    expect(readFileSync(dest)).toEqual(body);
    expect(readdirSync(join(d, 'out', 'nested'))).toEqual(['whatsapp-bridge.exe']);
  });
  it('refuses on size mismatch before copying anything', async () => {
    const d = tmp();
    const body = Buffer.from('short');
    const src = join(d, 'dummy.bin');
    writeFileSync(src, body);
    const dest = join(d, 'out', 'whatsapp-bridge.exe');
    await expect(
      importBridgeFile({ src, dest, expectedSize: body.length + 1, expectedSha256: sha(body) }),
    ).rejects.toThrow(/REFUSED - source size/);
    expect(existsSync(join(d, 'out'))).toBe(false);
  });
  it('refuses on sha256 mismatch and deletes the partial copy', async () => {
    const d = tmp();
    const body = Buffer.from('dummy bridge fixture');
    const src = join(d, 'dummy.bin');
    writeFileSync(src, body);
    const dest = join(d, 'out', 'whatsapp-bridge.exe');
    await expect(
      importBridgeFile({ src, dest, expectedSize: body.length, expectedSha256: 'f'.repeat(64) }),
    ).rejects.toThrow(/SHA-256 mismatch/);
    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(join(d, 'out'))).toEqual([]);
  });
  it('reports a missing source without throwing anything else', async () => {
    const d = tmp();
    await expect(
      importBridgeFile({
        src: join(d, 'absent.bin'),
        dest: join(d, 'x.exe'),
        expectedSize: 1,
        expectedSha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/source not found/);
  });
  it('sha256sumsLine is coreutils-shaped and upper-case', () => {
    expect(sha256sumsLine('ab'.repeat(32), 'whatsapp-bridge.exe')).toBe(`${'AB'.repeat(32)}  whatsapp-bridge.exe\n`);
  });
});
