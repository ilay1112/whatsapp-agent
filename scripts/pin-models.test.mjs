// scripts/pin-models.test.mjs - TESTS 5.3 row `scripts/*.mjs` for the GGUF pin checker (owner W1-07).
// `fetch` and the filesystem are injected: no Hugging Face request is ever made and no model is ever downloaded.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HF_API,
  MAGIC_BYTES,
  MANIFEST_PATH,
  PIN_OUT_PATH,
  checkEntry,
  checkMediaEntry,
  main,
  parseManifestSource,
  parseMediaManifestSource,
  parseMediaResolveUrl,
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
  const files = new Map();
  const fs = {
    readFile: async () => REAL_MANIFEST_SOURCE,
    writeFile: async (p, data) => void files.set(p, String(data)),
  };
  const COMMIT = 'c'.repeat(40);
  const media = parseMediaManifestSource(REAL_MANIFEST_SOURCE);
  /** A loopback-free scripted Hugging Face API: trees per commit, `revision/main` for the unpinned voice repos, 4-byte magic reads. */
  const hfApi = (over = {}) => {
    const llm = parseManifestSource(REAL_MANIFEST_SOURCE);
    const byTree = new Map(llm.map((e) => [treeUrl(parseResolveUrl(e.url)), [e]]));
    for (const e of media) {
      const p = parseMediaResolveUrl(e.url);
      const key = treeUrl({ repo: p.repo, commit: p.commit ?? COMMIT });
      byTree.set(key, [...(byTree.get(key) ?? []), e]);
    }
    return async (url, init) => {
      if (url.endsWith('/revision/main')) return { ok: true, status: 200, json: async () => ({ sha: COMMIT }) };
      if (init?.headers?.range === 'bytes=0-3') {
        const e = media.find((m) => url.endsWith(`/${m.fileName}`) && url.includes(`/resolve/`));
        const magic = over.badMagic ? [0, 0, 0, 0] : MAGIC_BYTES[e.magic];
        return { ok: true, status: 206, body: new Response(new Uint8Array([...magic, 9, 9])).body };
      }
      const rows = byTree.get(url);
      if (rows === undefined) return { ok: false, status: 404 };
      return treeResponse(rows.map((e) => ({ path: e.fileName, lfs: { size: e.size, oid: e.sha256 } })));
    };
  };

  it('checks every tier of both tables and writes vendor/models.pin.json with commit-pinned URLs only when all pass', async () => {
    files.clear();
    const lines = [];
    const results = await main({ fs, root: 'C:\\repo', log: (m) => lines.push(m), fetch: hfApi() });
    expect(results.map((r) => r.tier)).toEqual(['tiny', 'small', 'mid', ...media.map((e) => e.tier)]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(lines.slice(0, 3)).toEqual(['pin-models: tiny OK', 'pin-models: small OK', 'pin-models: mid OK']);
    const [[file, text]] = [...files.entries()];
    expect(file.replace(/\\/g, '/')).toBe(`C:/repo/${PIN_OUT_PATH}`);
    const pin = JSON.parse(text);
    expect(pin.llm.map((e) => e.id)).toEqual(['tiny', 'small', 'mid']);
    expect(pin.media.map((e) => [e.id, e.kind, e.magic])).toEqual(media.map((e) => [e.tier, e.kind, e.magic]));
    for (const e of [...pin.llm, ...pin.media]) expect(e.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
    expect(pin.media.find((e) => e.id === 'voice-vad').url).toBe(
      `https://huggingface.co/ggml-org/whisper-vad/resolve/${COMMIT}/ggml-silero-v6.2.0.bin`,
    );
    expect(lines.at(-1)).toMatch(
      /copy the commit-pinned URLs of voice-hebrew, voice-multilingual, voice-lite, voice-vad/,
    );
  });

  it('throws (and writes nothing) when any pin drifted, so CI cannot pass on a re-uploaded model', async () => {
    files.clear();
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
    expect(files.size).toBe(0);
    await expect(main({ fs, log: () => undefined, fetch: hfApi({ badMagic: true }) })).rejects.toThrow(/drifted/);
    expect(files.size).toBe(0);
  });
});

describe('[V2] media entries (MEDIA_MODEL_MANIFEST)', () => {
  const COMMIT = 'd'.repeat(40);
  const vad = () => ({ ...parseMediaManifestSource(REAL_MANIFEST_SOURCE).find((e) => e.tier === 'voice-vad') });
  const proj = () => ({ ...parseMediaManifestSource(REAL_MANIFEST_SOURCE).find((e) => e.tier === 'mmproj-mid') });
  const api =
    (e, over = {}) =>
    async (url, init) => {
      if (url.endsWith('/revision/main'))
        return over.revision ?? { ok: true, status: 200, json: async () => ({ sha: COMMIT }) };
      if (init?.headers?.range === 'bytes=0-3')
        return over.magic ?? { ok: true, status: 206, body: new Response(new Uint8Array(MAGIC_BYTES[e.magic])).body };
      return over.tree ?? treeResponse([{ path: e.fileName, lfs: { size: e.size, oid: e.sha256 } }]);
    };

  it('reads all seven entries; a resolve/main voice URL is resolved to its commit; a pinned projector keeps its commit', async () => {
    expect(parseMediaManifestSource(REAL_MANIFEST_SOURCE)).toHaveLength(7);
    expect(() => parseMediaManifestSource('nothing')).toThrow(/no MEDIA_MODEL_MANIFEST/);
    const v = vad();
    expect(await checkMediaEntry({ fetch: api(v), entry: v })).toEqual({
      tier: 'voice-vad',
      ok: true,
      problems: [],
      pinnedUrl: `https://huggingface.co/ggml-org/whisper-vad/resolve/${COMMIT}/ggml-silero-v6.2.0.bin`,
    });
    const p = proj();
    const r = await checkMediaEntry({ fetch: api(p), entry: p });
    expect(r.ok).toBe(true);
    expect(r.pinnedUrl).toBe(p.url);
  });

  it('the mmproj- refusal is lifted only for the three pinned projector ids; voice files must be .bin with the GGML magic', async () => {
    const other = { ...proj(), tier: 'mmproj-huge' };
    expect((await checkMediaEntry({ fetch: api(other), entry: other })).problems.join(' ')).toMatch(
      /only the three pinned/,
    );
    const bf16 = { ...proj(), fileName: 'mmproj-BF16.gguf', url: proj().url.replace('mmproj-F16', 'mmproj-BF16') };
    expect((await checkMediaEntry({ fetch: api(bf16), entry: bf16 })).ok).toBe(false);
    const ggufVoice = { ...vad(), fileName: 'x.gguf', url: vad().url.replace('ggml-silero-v6.2.0.bin', 'x.gguf') };
    expect((await checkMediaEntry({ fetch: api(ggufVoice), entry: ggufVoice })).problems.join(' ')).toMatch(
      /\.bin ggml files/,
    );
    const mmVoice = {
      ...vad(),
      fileName: 'mmproj-x.bin',
      url: vad().url.replace('ggml-silero-v6.2.0.bin', 'mmproj-x.bin'),
    };
    expect((await checkMediaEntry({ fetch: api(mmVoice), entry: mmVoice })).problems.join(' ')).toMatch(/multimodal/);
    const exe = { ...vad(), fileName: 'setup.exe', url: vad().url.replace('ggml-silero-v6.2.0.bin', 'setup.exe') };
    expect((await checkMediaEntry({ fetch: api(exe), entry: exe })).problems.join(' ')).toMatch(/executable/);
    const mismatch = { ...vad(), fileName: 'other.bin' };
    expect((await checkMediaEntry({ fetch: api(mismatch), entry: mismatch })).problems.join(' ')).toMatch(/url file/);
    const branch = { ...vad(), url: vad().url.replace('/resolve/main/', '/resolve/dev/') };
    expect((await checkMediaEntry({ fetch: api(branch), entry: branch })).problems.join(' ')).toMatch(
      /not a resolve URL/,
    );
  });

  it('drift and API failures are reported, never passed', async () => {
    const v = vad();
    const cases = [
      [{ tree: treeResponse([{ path: v.fileName, lfs: { size: v.size + 1, oid: v.sha256 } }]) }, /size drift/],
      [{ tree: treeResponse([{ path: v.fileName, lfs: { size: v.size, oid: 'e'.repeat(64) } }]) }, /sha256 drift/],
      [{ tree: treeResponse([{ path: v.fileName, size: v.size }]) }, /no lfs\.oid/],
      [{ tree: treeResponse([]) }, /is not in/],
      [{ tree: { ok: false, status: 500 } }, /HTTP 500/],
      [{ revision: { ok: false, status: 401 } }, /HTTP 401 resolving/],
      [{ revision: { ok: true, status: 200, json: async () => ({ sha: 'main' }) } }, /no commit sha/],
      [
        { magic: { ok: true, status: 206, body: new Response(new Uint8Array([0x47, 0x47, 0x55, 0x46])).body } },
        /magic mismatch/,
      ],
      [{ magic: { ok: true, status: 206, body: new Response(new Uint8Array([0x6c])).body } }, /magic mismatch/],
      [{ magic: { ok: false, status: 403, body: null } }, /HTTP 403 reading the magic/],
    ];
    for (const [over, re] of cases) {
      const r = await checkMediaEntry({ fetch: api(v, over), entry: v });
      expect(r.ok).toBe(false);
      expect(r.problems.join(' ')).toMatch(re);
      expect(r.pinnedUrl).toBeNull();
    }
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
