// scripts/pin-models.test.mjs - TESTS 5.3 row `scripts/*.mjs` for the GGUF pin checker (owner W1-07).
// `fetch` and the filesystem are injected: no Hugging Face request is ever made and no model is ever downloaded.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HF_API,
  MANIFEST_PATH,
  checkEntry,
  main,
  parseManifestSource,
  parseResolveUrl,
  treeUrl,
} from './pin-models.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REAL_MANIFEST_SOURCE = readFileSync(path.join(ROOT, ...MANIFEST_PATH.split('/')), 'utf8');

const entry = (over = {}) => ({
  tier: 'small',
  label: 'gemma-4-E4B-it-Q4_K_M',
  fileName: 'gemma-4-E4B-it-Q4_K_M.gguf',
  url: `https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/${'b'.repeat(40)}/gemma-4-E4B-it-Q4_K_M.gguf`,
  size: 4_977_171_584,
  sha256: 'a'.repeat(64),
  ...over,
});

const treeResponse = (rows) => ({ ok: true, status: 200, json: async () => rows });

// ---------------------------------------------------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------------------------------------------------
describe('parseManifestSource', () => {
  it('reads all three tiers out of the real manifest.ts', () => {
    const entries = parseManifestSource(REAL_MANIFEST_SOURCE);
    expect(entries.map((e) => e.tier)).toEqual(['tiny', 'small', 'mid']);
    for (const e of entries) {
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(e.size).toBeGreaterThan(0);
      expect(e.url.endsWith(e.fileName)).toBe(true);
    }
  });

  it('understands numeric separators in the pinned sizes', () => {
    const [tiny] = parseManifestSource(REAL_MANIFEST_SOURCE);
    expect(Number.isInteger(tiny.size)).toBe(true);
    expect(String(tiny.size)).not.toContain('_');
  });

  it('fails loudly rather than silently passing when the manifest cannot be read', () => {
    expect(() => parseManifestSource('export const MODEL_MANIFEST = {};')).toThrow(/no MODEL_MANIFEST entries/);
  });
});

describe('parseResolveUrl', () => {
  it('splits a pinned resolve URL into repo, commit and file', () => {
    expect(parseResolveUrl(entry().url)).toEqual({
      repo: 'unsloth/gemma-4-E4B-it-GGUF',
      commit: 'b'.repeat(40),
      file: 'gemma-4-E4B-it-Q4_K_M.gguf',
    });
  });

  it.each([
    ['a floating `main` ref', 'https://huggingface.co/org/repo/resolve/main/f.gguf'],
    ['a short commit', 'https://huggingface.co/org/repo/resolve/abc123/f.gguf'],
    ['a foreign host', 'https://hf.co.evil.example/org/repo/resolve/' + 'a'.repeat(40) + '/f.gguf'],
    ['plain http', 'http://huggingface.co/org/repo/resolve/' + 'a'.repeat(40) + '/f.gguf'],
    ['a query string', 'https://huggingface.co/org/repo/resolve/' + 'a'.repeat(40) + '/f.gguf?download=1'],
  ])('rejects %s', (_name, url) => {
    expect(() => parseResolveUrl(url)).toThrow(/not a pinned resolve URL/);
  });

  it('builds the tree URL from the pinned commit, never from a branch', () => {
    expect(treeUrl({ repo: 'org/repo', commit: 'c'.repeat(40) })).toBe(`${HF_API}/org/repo/tree/${'c'.repeat(40)}`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// checkEntry
// ---------------------------------------------------------------------------------------------------------------------
describe('checkEntry', () => {
  it('passes when size and lfs.oid match the pin', async () => {
    const e = entry();
    const result = await checkEntry({
      fetch: async (url) => {
        expect(url).toBe(treeUrl(parseResolveUrl(e.url)));
        return treeResponse([{ path: e.fileName, size: 135, lfs: { size: e.size, oid: e.sha256 } }]);
      },
      entry: e,
    });
    expect(result).toEqual({ tier: 'small', ok: true, problems: [] });
  });

  it('reports a sha256 drift (a silently re-uploaded GGUF)', async () => {
    const e = entry();
    const result = await checkEntry({
      fetch: async () => treeResponse([{ path: e.fileName, lfs: { size: e.size, oid: 'f'.repeat(64) } }]),
      entry: e,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/sha256 drift/);
  });

  it('reports a size drift', async () => {
    const e = entry();
    const result = await checkEntry({
      fetch: async () => treeResponse([{ path: e.fileName, lfs: { size: e.size + 1, oid: e.sha256 } }]),
      entry: e,
    });
    expect(result.problems.join(' ')).toMatch(/size drift/);
  });

  it('refuses a file the API cannot prove (no lfs.oid)', async () => {
    const e = entry();
    const result = await checkEntry({
      fetch: async () => treeResponse([{ path: e.fileName, size: e.size }]),
      entry: e,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/no lfs\.oid/);
  });

  it('reports a missing file at the pinned commit', async () => {
    const e = entry();
    const result = await checkEntry({ fetch: async () => treeResponse([{ path: 'other.gguf' }]), entry: e });
    expect(result.problems.join(' ')).toContain('is not in');
  });

  it('reports an API error without pretending the pin is fine', async () => {
    const result = await checkEntry({ fetch: async () => ({ ok: false, status: 429 }), entry: entry() });
    expect(result).toMatchObject({ ok: false });
    expect(result.problems.join(' ')).toContain('HTTP 429');
  });

  it('refuses a multimodal / draft companion and a non-.gguf target', async () => {
    const mm = entry({
      fileName: 'mmproj-F16.gguf',
      url: `https://huggingface.co/o/r/resolve/${'b'.repeat(40)}/mmproj-F16.gguf`,
    });
    const mmResult = await checkEntry({
      fetch: async () => treeResponse([{ path: mm.fileName, lfs: { size: mm.size, oid: mm.sha256 } }]),
      entry: mm,
    });
    expect(mmResult.problems.join(' ')).toMatch(/multimodal\/draft/);

    const exe = entry({
      fileName: 'installer.exe',
      url: `https://huggingface.co/o/r/resolve/${'b'.repeat(40)}/installer.exe`,
    });
    const exeResult = await checkEntry({
      fetch: async () => treeResponse([{ path: exe.fileName, lfs: { size: exe.size, oid: exe.sha256 } }]),
      entry: exe,
    });
    expect(exeResult.problems.join(' ')).toMatch(/only \.gguf files/);
  });

  it('reports a URL whose file name disagrees with the manifest entry', async () => {
    const e = entry({ fileName: 'other.gguf' });
    const result = await checkEntry({
      fetch: async () => treeResponse([{ path: 'other.gguf', lfs: { size: e.size, oid: e.sha256 } }]),
      entry: e,
    });
    expect(result.problems.join(' ')).toMatch(/url file .* != fileName/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------------------------
describe('main', () => {
  const fs = { readFile: async () => REAL_MANIFEST_SOURCE };

  it('checks every tier of the real manifest and passes when nothing drifted', async () => {
    const entries = parseManifestSource(REAL_MANIFEST_SOURCE);
    const byCommit = new Map(entries.map((e) => [treeUrl(parseResolveUrl(e.url)), e]));
    const lines = [];
    const results = await main({
      fs,
      log: (m) => lines.push(m),
      fetch: async (url) => {
        const e = byCommit.get(url);
        expect(e).toBeDefined();
        return treeResponse([{ path: e.fileName, lfs: { size: e.size, oid: e.sha256 } }]);
      },
    });
    expect(results.map((r) => r.tier)).toEqual(['tiny', 'small', 'mid']);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(lines).toEqual(['pin-models: tiny OK', 'pin-models: small OK', 'pin-models: mid OK']);
  });

  it('throws when any pin drifted, so CI cannot pass on a re-uploaded model', async () => {
    const lines = [];
    await expect(
      main({
        fs,
        log: (m) => lines.push(m),
        fetch: async () =>
          treeResponse([{ path: 'gemma-4-E2B-it-Q4_K_M.gguf', lfs: { size: 1, oid: '0'.repeat(64) } }]),
      }),
    ).rejects.toThrow(/at least one pin drifted/);
    expect(lines.join('\n')).toContain('DRIFT');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// static source rules
// ---------------------------------------------------------------------------------------------------------------------
describe('pin-models.mjs source (static)', () => {
  const src = readFileSync(fileURLToPath(new URL('./pin-models.mjs', import.meta.url)), 'utf8');

  it('never downloads a model and never runs a child process', () => {
    expect(src).not.toMatch(/arrayBuffer|createWriteStream|pipeTo/);
    expect(src).not.toMatch(/child_process/);
    expect(src).not.toMatch(/\bspawn\w*\s*\(/);
  });

  it('talks to the Hugging Face API over https only', () => {
    expect(HF_API.startsWith('https://huggingface.co/')).toBe(true);
    expect(src).not.toMatch(/http:\/\//);
  });
});
