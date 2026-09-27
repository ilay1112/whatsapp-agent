// Security gate item 2 (ARCHITECTURE 18): import graph boundaries. (Owner W0 -> W2-02.)
// Part A: every lint rule of eslint.config.js fires on tests/eslint-fixtures/** (so the boundaries are enforced mechanically).
// Part B: an independent source scan of the REAL src tree (does not depend on ESLint's config plumbing).
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../../eslint.config.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURES = join(ROOT, 'tests', 'eslint-fixtures');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(ROOT, p).split(sep).join('/');
function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*(?:import|export)\s[^'"\n]*?from\s+['"]([^'"]+)['"]/gm)) out.push(m[1]!);
  for (const m of src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]!);
  for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
  return out;
}
function valueImportsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*import\s+(?!type\s)[^'"\n]*?from\s+['"]([^'"]+)['"]/gm)) out.push(m[1]!);
  // value-position dynamic imports only (`await import(...)`, `= import(...)`); `: import('x').T` in a type position is type-only
  for (const m of src.matchAll(/(?:await\s+|[=(,]\s*|^\s*)import\(\s*['"]([^'"]+)['"]\s*\)/gm)) out.push(m[1]!);
  return out;
}

describe('A. lint rules fire on the fixtures', () => {
  it('every EXPECT header is satisfied and good.tsx is clean', async () => {
    const eslint = new ESLint({
      cwd: FIXTURES,
      overrideConfigFile: true,
      overrideConfig: config as never,
      ignore: false,
    });
    const results = await eslint.lintFiles(['src/**/*.{ts,tsx}']);
    const byFile = new Map<string, Record<string, number>>();
    for (const r of results) {
      const counts: Record<string, number> = {};
      for (const m of r.messages) counts[m.ruleId ?? 'parse'] = (counts[m.ruleId ?? 'parse'] ?? 0) + 1;
      byFile.set(relative(FIXTURES, r.filePath).split(sep).join('/'), counts);
    }
    const expectations: Array<[string, Record<string, number>]> = [
      ['src/main/agent/bad-imports.ts', { 'no-restricted-imports': 5 }],
      ['src/main/exec/bad-imports.ts', { 'no-restricted-imports': 2 }],
      ['src/main/db/bad-electron.ts', { 'no-restricted-imports': 1 }],
      ['src/main/db/bad-console.ts', { 'no-console': 1 }],
      ['src/main/db/bad-dynamic-import.ts', { 'no-restricted-syntax': 2 }],
      ['src/shared/bad-imports.ts', { 'no-restricted-imports': 3 }],
      ['src/renderer/src/bad-html.tsx', { 'no-restricted-syntax': 4 }],
      ['src/renderer/src/bad-tailwind.tsx', { 'no-restricted-syntax': 3 }],
      ['src/renderer/src/bad-imports.ts', { 'no-restricted-imports': 2 }],
      ['src/renderer/src/good.tsx', {}],
    ];
    expect([...byFile.keys()].sort()).toEqual(expectations.map(([f]) => f).sort());
    for (const [file, expected] of expectations) {
      const got = byFile.get(file) ?? {};
      for (const [rule, n] of Object.entries(expected)) expect(got[rule], `${file} ${rule}`).toBe(n);
      const unexpected = Object.keys(got).filter((r) => !(r in expected) && r !== '@typescript-eslint/no-unused-vars');
      expect(unexpected, `${file} unexpected rules`).toEqual([]);
    }
  });
});

describe('B. real source tree obeys ARCHITECTURE 18 boundaries', () => {
  const main = walk(join(ROOT, 'src', 'main'));
  const shared = walk(join(ROOT, 'src', 'shared'));
  const renderer = walk(join(ROOT, 'src', 'renderer'));
  const ELECTRON_ALLOWED = new Set([
    'src/main/index.ts',
    'src/main/compose.ts',
    'src/main/ipc/register.ts',
    'src/main/secrets.ts',
    'src/main/testSeams.ts',
  ]);

  it('agent/** and llm/** never import exec/**, bridge/sendClient, mcp/writeClient, mcp/adminClient, mcp/host', () => {
    for (const f of main.filter((p) => /[\\/]main[\\/](agent|llm)[\\/]/.test(p))) {
      for (const imp of importsOf(f)) {
        expect(imp, `${rel(f)} imports ${imp}`).not.toMatch(
          /(^|\/)exec(\/|$)|bridge\/sendClient|mcp\/writeClient|mcp\/adminClient|mcp\/host/,
        );
      }
    }
  });
  it('exec/** never imports llm/** or agent/**', () => {
    for (const f of main.filter((p) => /[\\/]main[\\/]exec[\\/]/.test(p))) {
      for (const imp of importsOf(f)) expect(imp, `${rel(f)} imports ${imp}`).not.toMatch(/(^|\/)(llm|agent)(\/|$)/);
    }
  });
  it('sendClient / writeClient VALUES are imported only by compose.ts (exec/** may import types)', () => {
    for (const f of main) {
      const r = rel(f);
      if (r === 'src/main/compose.ts' || r.endsWith('bridge/sendClient.ts') || r.endsWith('mcp/writeClient.ts'))
        continue;
      for (const imp of valueImportsOf(f))
        expect(imp, `${r} value-imports ${imp}`).not.toMatch(/bridge\/sendClient|mcp\/writeClient/);
    }
  });
  it('electron is imported only by the five allowed main files + app/**', () => {
    for (const f of main) {
      const r = rel(f);
      if (ELECTRON_ALLOWED.has(r) || r.startsWith('src/main/app/')) continue;
      expect(valueImportsOf(f), r).not.toContain('electron');
    }
  });
  it('src/shared imports only zod and shared files; src/renderer never imports node:* or electron or node:sqlite', () => {
    for (const f of shared) {
      for (const imp of importsOf(f)) expect(imp, `${rel(f)} imports ${imp}`).toMatch(/^(zod|\.\.?\/)/);
    }
    for (const f of renderer) {
      for (const imp of importsOf(f)) expect(imp, `${rel(f)} imports ${imp}`).not.toMatch(/^(node:|electron$)/);
    }
  });
  it('src/main/**: no console.* and no non-literal dynamic import', () => {
    for (const f of main) {
      const src = readFileSync(f, 'utf8')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      expect(src, rel(f)).not.toMatch(/\bconsole\.(log|warn|error|info|debug)\(/);
      expect(src, rel(f)).not.toMatch(/\bimport\(\s*[^'"\s)]/);
    }
  });
});
