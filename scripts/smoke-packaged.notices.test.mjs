// scripts/smoke-packaged.notices.test.mjs - the THIRD_PARTY_NOTICES generator (TESTS 5.3 row `scripts/*.mjs`).
// Pure input -> text; no fs writes, no network, no binaries.
import { describe, expect, it } from 'vitest';
import {
  buildNotices,
  licenseHistogram,
  productionPackages,
  stagedCrtFrom,
  CRT_FILES,
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
