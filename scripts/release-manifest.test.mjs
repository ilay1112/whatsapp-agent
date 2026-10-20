// scripts/release-manifest.test.mjs - `release-manifest.mjs` (v5 W1, docs/specs/v5-updates-handover.md 2.1) against temp
// files only: size + streamed sha256 of a temp zip, the release.json schema, argument validation, overwrite refusal.
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIN_VERSION,
  NOTES_MAX,
  SCHEMA,
  assetName,
  buildManifest,
  hashFile,
  main,
  parseArgs,
  writeManifest,
} from './release-manifest.mjs';

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wca-release-manifest-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const COMMIT = 'a'.repeat(40);
const NOW = () => new Date('2026-10-20T12:00:00.000Z');

/** A temp "zip": the local-file-header magic + a body bigger than one stream chunk (64 KiB), so hashing must stream. */
function tempZip(version = '0.1.7', bytes = 300_000) {
  const d = tmp();
  const body = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 1) body[i] = (i * 31 + 7) & 0xff;
  body.write('PK\u0003\u0004', 0, 'latin1');
  const p = join(d, assetName(version));
  writeFileSync(p, body);
  return { dir: d, path: p, body };
}

const quiet = () => {
  const out = [];
  const err = [];
  return { out, err, io: { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) }, now: NOW } };
};

describe('release-manifest.mjs source', () => {
  it('never starts a process and never touches the network', () => {
    const src = readFileSync(fileURLToPath(new URL('./release-manifest.mjs', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/child_process|\bspawn|\bexec[A-Za-z]*\s*\(|\bfetch\s*\(|node:https?/);
  });
});

describe('hashFile', () => {
  it('returns the byte size and the same sha256 as crypto over the whole buffer', async () => {
    const { path, body } = tempZip();
    expect(await hashFile(path)).toEqual({ size: body.length, sha256: sha(body) });
  });
});

describe('parseArgs', () => {
  it('reads <zip> <version> <commit> --notes --out', () => {
    expect(parseArgs(['x.zip', '0.1.12', COMMIT, '--notes', 'Fix it', '--out', 'release.json'])).toEqual({
      zipPath: 'x.zip',
      version: '0.1.12',
      commit: COMMIT,
      notes: 'Fix it',
      out: 'release.json',
    });
  });

  it('accepts the options before the positionals and defaults notes to an empty string', () => {
    expect(parseArgs(['--out', 'r.json', 'x.zip', '0.1.0', COMMIT])).toMatchObject({ notes: '', out: 'r.json' });
  });

  it.each([['0.2.1'], ['1.1.1'], ['0.1'], ['0.1.x'], ['v0.1.3'], ['0.1.3-beta'], ['0.1.3 '], ['']])(
    'rejects the version %j (must match ^0\\.1\\.\\d+$)',
    (version) => {
      expect(() => parseArgs(['x.zip', version, COMMIT, '--out', 'r.json'])).toThrow(/version/);
    },
  );

  it.each([['abc'], ['A'.repeat(40)], ['a'.repeat(39)], ['g'.repeat(40)]])('rejects the commit %j', (commit) => {
    expect(() => parseArgs(['x.zip', '0.1.3', commit, '--out', 'r.json'])).toThrow(/commit/);
  });

  it('requires --out, the three positionals, and a value after every option', () => {
    expect(() => parseArgs(['x.zip', '0.1.3', COMMIT])).toThrow(/--out/);
    expect(() => parseArgs(['x.zip', '0.1.3', '--out', 'r.json'])).toThrow(/usage/);
    expect(() => parseArgs(['x.zip', '0.1.3', COMMIT, 'extra', '--out', 'r.json'])).toThrow(/usage/);
    expect(() => parseArgs(['x.zip', '0.1.3', COMMIT, '--out'])).toThrow(/--out/);
    expect(() => parseArgs(['x.zip', '0.1.3', COMMIT, '--out', 'r.json', '--notes'])).toThrow(/--notes/);
    expect(() => parseArgs(['x.zip', '0.1.3', COMMIT, '--out', 'r.json', '--bogus', '1'])).toThrow(/--bogus/);
  });
});

describe('buildManifest', () => {
  it('writes exactly the schema-1 fields of the spec, with the streamed size + sha256 of the zip', async () => {
    const { path, body } = tempZip('0.1.7');
    const m = await buildManifest({ zipPath: path, version: '0.1.7', commit: COMMIT, notes: 'Add X', now: NOW });
    expect(m).toEqual({
      schema: 1,
      version: '0.1.7',
      commit: COMMIT,
      publishedAt: '2026-10-20T12:00:00.000Z',
      asset: { name: 'WhatsAppCalendarAgent-win-x64-0.1.7.zip', size: body.length, sha256: sha(body) },
      minVersion: '0.1.0',
      notes: 'Add X',
    });
    expect(SCHEMA).toBe(1);
    expect(MIN_VERSION).toBe('0.1.0');
    expect(Object.keys(m)).toEqual(['schema', 'version', 'commit', 'publishedAt', 'asset', 'minVersion', 'notes']);
  });

  it('refuses a zip whose name does not carry the same version', async () => {
    const { path } = tempZip('0.1.7');
    await expect(
      buildManifest({ zipPath: path, version: '0.1.8', commit: COMMIT, notes: '', now: NOW }),
    ).rejects.toThrow(/WhatsAppCalendarAgent-win-x64-0\.1\.8\.zip/);
  });

  it('refuses a missing file, a directory, an empty file and a non-zip', async () => {
    const d = tmp();
    const name = assetName('0.1.4');
    const args = (p) => ({ zipPath: p, version: '0.1.4', commit: COMMIT, notes: '', now: NOW });
    await expect(buildManifest(args(join(d, name)))).rejects.toThrow(/not found/);
    const nested = join(d, 'sub', name);
    mkdirSync(nested, { recursive: true });
    await expect(buildManifest(args(nested))).rejects.toThrow(/not a file/);
    writeFileSync(join(d, name), Buffer.alloc(0));
    await expect(buildManifest(args(join(d, name)))).rejects.toThrow(/empty/);
    writeFileSync(join(d, name), Buffer.from('MZ not a zip'));
    await expect(buildManifest(args(join(d, name)))).rejects.toThrow(/not a zip/);
  });

  it('collapses control characters and caps the notes length', async () => {
    const { path } = tempZip('0.1.7');
    const m = await buildManifest({
      zipPath: path,
      version: '0.1.7',
      commit: COMMIT,
      notes: `  a\tb\r\nc\u0000d ${'x'.repeat(1000)}`,
      now: NOW,
    });
    expect(m.notes.startsWith('a b c d x')).toBe(true);
    expect(m.notes.length).toBeLessThanOrEqual(NOTES_MAX);
    expect(m.notes).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
});

describe('writeManifest', () => {
  const manifest = (version) => ({ schema: 1, version });

  it('writes pretty JSON with a trailing newline and leaves no temp file behind', async () => {
    const d = tmp();
    const out = join(d, 'release.json');
    await writeManifest({ out, manifest: manifest('0.1.5') });
    expect(readFileSync(out, 'utf8')).toBe('{\n  "schema": 1,\n  "version": "0.1.5"\n}\n');
    expect(existsSync(`${out}.tmp`)).toBe(false);
  });

  it('overwrites a manifest of the SAME version (a re-run of the same CI run)', async () => {
    const d = tmp();
    const out = join(d, 'release.json');
    writeFileSync(out, JSON.stringify({ schema: 1, version: '0.1.5', notes: 'old' }));
    await writeManifest({ out, manifest: { ...manifest('0.1.5'), notes: 'new' } });
    expect(JSON.parse(readFileSync(out, 'utf8')).notes).toBe('new');
  });

  it('refuses to overwrite a manifest of a DIFFERENT version and leaves it untouched', async () => {
    const d = tmp();
    const out = join(d, 'release.json');
    const before = JSON.stringify({ schema: 1, version: '0.1.4' });
    writeFileSync(out, before);
    await expect(writeManifest({ out, manifest: manifest('0.1.5') })).rejects.toThrow(
      /0\.1\.4.*0\.1\.5|different version/,
    );
    expect(readFileSync(out, 'utf8')).toBe(before);
  });

  it('refuses to overwrite a file that is not a manifest', async () => {
    const d = tmp();
    const out = join(d, 'release.json');
    writeFileSync(out, 'not json');
    await expect(writeManifest({ out, manifest: manifest('0.1.5') })).rejects.toThrow(/refusing to overwrite/);
    expect(readFileSync(out, 'utf8')).toBe('not json');
  });
});

describe('main', () => {
  it('end to end: writes release.json for the zip and prints a one-line summary', async () => {
    const { dir, path, body } = tempZip('0.1.9');
    const out = join(dir, 'release.json');
    const q = quiet();
    const code = await main([path, '0.1.9', COMMIT, '--notes', 'Subject line', '--out', out], q.io);
    expect(code).toBe(0);
    const m = JSON.parse(readFileSync(out, 'utf8'));
    expect(m).toMatchObject({
      version: '0.1.9',
      asset: { size: body.length, sha256: sha(body) },
      notes: 'Subject line',
    });
    expect(q.out.join('')).toContain(`0.1.9 ${sha(body)}`);
    expect(q.err).toEqual([]);
  });

  it('exits 1 with a message (and writes nothing) on a bad version', async () => {
    const { dir, path } = tempZip('0.1.9');
    const out = join(dir, 'release.json');
    const q = quiet();
    expect(await main([path, '1.0.0', COMMIT, '--out', out], q.io)).toBe(1);
    expect(q.err.join('')).toMatch(/release-manifest: .*version/);
    expect(existsSync(out)).toBe(false);
  });
});
