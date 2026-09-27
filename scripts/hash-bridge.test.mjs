// scripts/hash-bridge.test.mjs - `hash-bridge.mjs` against a dummy fixture (TESTS 5.3 row `scripts/*.mjs`). Never the real exe.
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBridge, hashFile, parseSums, writePlaceholder } from './hash-bridge.mjs';

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wca-hash-bridge-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

describe('hash-bridge.mjs', () => {
  it('source never starts a process', () => {
    const src = readFileSync(fileURLToPath(new URL('./hash-bridge.mjs', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/child_process|\bspawn|\bexec[A-Za-z]*\s*\(/);
  });
  it('hashFile streams the same digest as crypto over the whole buffer', async () => {
    const d = tmp();
    const body = Buffer.alloc(200_000, 7);
    const p = join(d, 'dummy.bin');
    writeFileSync(p, body);
    expect(await hashFile(p)).toBe(sha(body));
  });
  it('parseSums accepts coreutils lines (binary marker optional, any case)', () => {
    const hex = 'AB'.repeat(32);
    expect(parseSums(`${hex}  whatsapp-bridge.exe\r\n${'cd'.repeat(32)} *other.bin\n\n`)).toEqual({
      'whatsapp-bridge.exe': hex.toLowerCase(),
      'other.bin': 'cd'.repeat(32),
    });
  });
  it('checkBridge: ok when size + sha match and SHA256SUMS agrees', async () => {
    const d = tmp();
    const body = Buffer.from('dummy bridge - fixture only');
    const exePath = join(d, 'whatsapp-bridge.exe');
    const sumsPath = join(d, 'SHA256SUMS');
    writeFileSync(exePath, body);
    writeFileSync(sumsPath, `${sha(body).toUpperCase()}  whatsapp-bridge.exe\n`);
    expect(
      await checkBridge({ exePath, sumsPath, expectedSize: body.length, expectedSha256: sha(body).toUpperCase() }),
    ).toEqual({
      ok: true,
      sha256: sha(body),
      bytes: body.length,
    });
  });
  it('checkBridge: missing / size / sha / SHA256SUMS disagreement are distinct failures', async () => {
    const d = tmp();
    const body = Buffer.from('dummy bridge - fixture only');
    const exePath = join(d, 'whatsapp-bridge.exe');
    const sumsPath = join(d, 'SHA256SUMS');
    expect(await checkBridge({ exePath, sumsPath, expectedSize: 1, expectedSha256: 'a'.repeat(64) })).toEqual({
      ok: false,
      reason: 'missing',
    });
    writeFileSync(exePath, body);
    expect(
      (await checkBridge({ exePath, sumsPath, expectedSize: body.length + 5, expectedSha256: sha(body) })).ok,
    ).toBe(false);
    expect(await checkBridge({ exePath, sumsPath, expectedSize: body.length, expectedSha256: 'a'.repeat(64) })).toEqual(
      {
        ok: false,
        reason: 'sha256 mismatch',
      },
    );
    writeFileSync(sumsPath, `${'b'.repeat(64)}  whatsapp-bridge.exe\n`);
    expect(await checkBridge({ exePath, sumsPath, expectedSize: body.length, expectedSha256: sha(body) })).toEqual({
      ok: false,
      reason: 'SHA256SUMS disagrees with the exe',
    });
  });
  it('writePlaceholder writes a zero-byte file that can never pass the pin', async () => {
    const d = tmp();
    const exePath = join(d, 'bridge', 'whatsapp-bridge.exe');
    writePlaceholder(exePath);
    expect(existsSync(exePath)).toBe(true);
    expect(statSync(exePath).size).toBe(0);
    expect((await checkBridge({ exePath, expectedSize: 43_540_541, expectedSha256: 'a'.repeat(64) })).ok).toBe(false);
  });
});
