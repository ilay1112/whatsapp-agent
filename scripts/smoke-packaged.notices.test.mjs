// scripts/smoke-packaged.notices.test.mjs - the THIRD_PARTY_NOTICES generator (TESTS 5.3 row `scripts/*.mjs`).
// Pure input -> text; no fs writes, no network, no binaries.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildNotices,
  licenseHistogram,
  productionPackages,
  stagedCrtFrom,
  CRT_FILES,
  DECODER_CHAIN,
  LIBOPUS_LICENSE_PATH,
  NOTICE_ANCHORS_V2,
  decoderChainFrom,
} from './smoke-packaged.notices.mjs';

const lock = {
  packages: {
    '': { name: 'root' },
    'node_modules/zod': { version: '4.6.5', license: 'MIT' },
    'node_modules/@modelcontextprotocol/sdk': { version: '1.30.0', license: 'MIT' },
    'node_modules/@modelcontextprotocol/sdk/node_modules/ajv': { version: '8.0.0', license: 'MIT' },
    'node_modules/typescript': { version: '6.0.3', license: 'Apache-2.0', dev: true },
    'node_modules/jsdom': { version: '30.1.0', license: 'MIT', devOptional: true },
  },
};

const input = {
  llamaTag: 'b10964',
  llamaUrl: 'https://example.invalid/llama.zip',
  llamaMit: 'MIT License\n\nCopyright (c) 2023-2026 The ggml authors\n',
  bridgeLicense: 'MIT License\n\nOriginal work Copyright (c) 2025 Luke Harries\n',
  bridgeSha256: 'AC23221E8BCF3937A4CA346B3BD80A8DA09DF94CBECD949AF2916C4BC8D22FF5',
  mcpVersion: '2.6.3',
  stagedCrt: [],
  npmPackages: productionPackages(lock),
  models: ['tiny - Gemma 4 E2B-it Q4_K_M'],
};

describe('productionPackages', () => {
  it('keeps production entries (including nested ones) and drops dev / devOptional', () => {
    const names = productionPackages(lock).map((p) => p.name);
    expect(names).toEqual(['@modelcontextprotocol/sdk', 'ajv', 'zod']);
    expect(names).not.toContain('typescript');
    expect(names).not.toContain('jsdom');
  });
  it('keeps the scoped name intact and falls back when no licence is declared', () => {
    const rows = productionPackages({ packages: { 'node_modules/@scope/x': { version: '1.0.0' } } });
    expect(rows).toEqual([{ name: '@scope/x', version: '1.0.0', license: 'see package' }]);
  });
});

describe('licenseHistogram', () => {
  it('counts by licence, most frequent first', () => {
    const hist = licenseHistogram([{ license: 'MIT' }, { license: 'MIT' }, { license: 'ISC' }]);
    expect(hist).toEqual([
      ['MIT', 2],
      ['ISC', 1],
    ]);
  });
});

describe('stagedCrtFrom', () => {
  it('reports only the CRT files the manifest actually lists', () => {
    expect(stagedCrtFrom('llama-server.exe\nmsvcp140.dll\nvcruntime140.dll\n')).toEqual([
      'msvcp140.dll',
      'vcruntime140.dll',
    ]);
    expect(stagedCrtFrom('llama-server.exe\n')).toEqual([]);
    expect(stagedCrtFrom(undefined)).toEqual([]);
  });
  it('knows the three files of ARCH section 9', () => {
    expect(CRT_FILES).toEqual(['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']);
  });
});

describe('buildNotices', () => {
  it('reproduces every licence text it was given, verbatim', () => {
    const text = buildNotices(input);
    expect(text).toContain('Original work Copyright (c) 2025 Luke Harries');
    expect(text).toContain('Copyright (c) 2023-2026 The ggml authors');
    expect(text).toContain(input.bridgeSha256);
  });

  it('points at the shipped LICENSE-LLVM-OpenMP rather than duplicating it', () => {
    const text = buildNotices(input);
    expect(text).toContain('resources\\llama\\LICENSE-LLVM-OpenMP');
  });

  it('says the CRT is NOT shipped when nothing was staged, and names the files when it was', () => {
    expect(buildNotices(input)).toContain('NOT SHIPPED IN THIS BUILD');
    const withCrt = buildNotices({ ...input, stagedCrt: ['msvcp140.dll'] });
    expect(withCrt).not.toContain('NOT SHIPPED IN THIS BUILD');
    expect(withCrt).toContain('msvcp140.dll');
    expect(withCrt).toContain('Distributable Code');
  });

  it('records the Gemma terms and states that no weights are shipped', () => {
    const text = buildNotices(input);
    expect(text).toContain('Apache License 2.0');
    expect(text).toContain('No model weights are contained in this installer');
    expect(text).toContain('tiny - Gemma 4 E2B-it Q4_K_M');
  });

  it('lists every production npm package with version and licence', () => {
    const text = buildNotices(input);
    expect(text).toContain('zod@4.6.5  -  MIT');
    expect(text).toContain('@modelcontextprotocol/sdk@1.30.0  -  MIT');
    expect(text).toContain('(3 packages)');
  });

  it('never leaks a credential-shaped string', () => {
    const text = buildNotices(input);
    expect(text).not.toMatch(/sk-ant-/);
    expect(text).not.toMatch(/AIza/);
  });
});

// [V2-W2-04] sections 9-13 (ARCH-v2 12) and the anchors the packaged smoke (check 12) requires.
describe('[V2] buildV2Sections / NOTICE_ANCHORS_V2', () => {
  const v2 = {
    whisperTag: 'b5130',
    whisperUrl: 'https://example.invalid/whisper.zip',
    whisperMit: 'MIT License\n\nCopyright (c) 2023-2026 The ggml authors\n',
    whisperCrt: [],
    decoder: decoderChainFrom({
      packages: {
        'node_modules/opus-decoder': { version: '0.7.12', license: 'MIT' },
        'node_modules/@wasm-audio-decoders/common': { version: '9.0.7', license: 'MIT' },
        'node_modules/simple-yenc': { version: '1.0.4', license: 'MIT' },
        'node_modules/@eshaz/web-worker': { version: '1.2.2', license: 'Apache-2.0' },
      },
    }),
    libopusLicense: readFileSync(LIBOPUS_LICENSE_PATH, 'utf8'),
    calendarPatch: {
      version: '2.6.3',
      unpatchedSha: 'a'.repeat(64),
      patchedSha: 'b'.repeat(64),
      insertions: [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, name: `insertion_${String(id)}` })),
    },
  };

  it('the full text carries every v2 anchor, the whisper MIT text verbatim and the libopus patent paragraph', () => {
    const text = buildNotices({ ...input, v2 });
    for (const anchor of Object.values(NOTICE_ANCHORS_V2)) expect(text).toContain(anchor);
    expect(text).toContain(v2.whisperMit.trim());
    expect(text).toContain('https://datatracker.ietf.org/ipr/1524/');
    expect(text).toContain('Redistributions in binary form must reproduce the above copyright');
    expect(text.indexOf('9. whisper.cpp')).toBeLessThan(text.indexOf('END OF THIRD PARTY NOTICES'));
  });

  it('lists the decoder chain with versions and licences, and the seven calendar insertions with both shas', () => {
    const text = buildNotices({ ...input, v2 });
    expect(text).toContain('opus-decoder@0.7.12  -  MIT');
    expect(text).toContain('@eshaz/web-worker@1.2.2  -  Apache-2.0');
    expect(text).toContain('(7) insertion_7');
    expect(text).toContain('a'.repeat(64));
    expect(text).toContain('b'.repeat(64));
  });

  it('says whether whisper got its own CRT copy', () => {
    expect(buildNotices({ ...input, v2 })).toContain('NOT shipped beside it in this build');
    expect(buildNotices({ ...input, v2: { ...v2, whisperCrt: ['msvcp140.dll'] } })).toContain('Its own copy');
  });

  it('a v1-only input produces no v2 section (the generator main() always passes v2; smoke check 12 enforces it)', () => {
    expect(buildNotices(input)).not.toContain(NOTICE_ANCHORS_V2.whisperCpp);
  });

  it('decoderChainFrom reports a missing lockfile row instead of skipping it', () => {
    expect(decoderChainFrom({ packages: {} }).map((d) => d.version)).toEqual([
      'MISSING',
      'MISSING',
      'MISSING',
      'MISSING',
    ]);
    expect(DECODER_CHAIN).toEqual(['opus-decoder', '@wasm-audio-decoders/common', 'simple-yenc', '@eshaz/web-worker']);
  });

  it('the committed libopus licence is the BSD-3 text with the patent paragraph', () => {
    const lic = readFileSync(LIBOPUS_LICENSE_PATH, 'utf8');
    expect(lic).toContain('Neither the name of Internet Society, IETF or IETF Trust');
    expect(lic).toContain(NOTICE_ANCHORS_V2.libopusPatent);
  });
});

describe('[v2-repair] libopus licence text is pinned to an upstream copy (verified offline 2026-10-04)', () => {
  // opus-decoder@0.7.12 ships no libopus licence file (README: "Based on libopus"; package.json: MIT; WASM carries no text).
  // The upstream libopus COPYING that Chromium redistributes (third_party/opus) is in the installed Electron's
  // LICENSES.chromium.html, so the committed text is compared with it - no network fetch.
  const normalise = (s) => s.replace(/\r\n/g, '\n').trim();
  const LIBOPUS_SHA256 = '1cff0ac6c1aa5ce584d59a460fbc1a87b4e9f6f61ea894364f4cbe48fe1d9f0e';

  it('the committed text has the sha256 it had when it was verified', async () => {
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256')
      .update(normalise(readFileSync(LIBOPUS_LICENSE_PATH, 'utf8')))
      .digest('hex');
    expect(sha).toBe(LIBOPUS_SHA256);
  });

  it('equals the opus section of the installed Electron LICENSES.chromium.html when that file is present', async () => {
    const { existsSync } = await import('node:fs');
    const chromium = new URL('../node_modules/electron/dist/LICENSES.chromium.html', import.meta.url);
    if (!existsSync(chromium)) return; // electron's dist is a devDependency download; the sha256 test above still holds
    const html = readFileSync(chromium, 'utf8');
    const at = html.indexOf('<span class="title">opus</span>');
    expect(at).toBeGreaterThan(0);
    const start = html.indexOf('<pre>', at) + '<pre>'.length;
    const upstream = html
      .slice(start, html.indexOf('</pre>', start))
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    expect(normalise(readFileSync(LIBOPUS_LICENSE_PATH, 'utf8'))).toBe(normalise(upstream));
  });
});
