// Security gate item 2 (ARCHITECTURE 18): import graph boundaries. (Owner W0 -> W2-02.)
// Part A: every lint rule of eslint.config.js fires on tests/eslint-fixtures/** (so the boundaries are enforced mechanically).
// Part B: an independent source scan of the REAL src tree (does not depend on ESLint's config plumbing).
// [V2] (Owner V2-W2-02) Part B v2 (tool server / WhatsApp read path), Part C (AutoGate purity, T2 group 15) and Part D (llm/cli,
// getMedia, LlmImagePart, "only compose constructs") over a TypeScript-AST import graph with transitive value closure.
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
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
      // [V2] build-plan rule 13 boundaries (V2-W0-scaffold)
      ['src/main/exec/autoGate.ts', { 'no-restricted-imports': 6 }],
      ['src/main/mcp/toolServer.ts', { 'no-restricted-imports': 8 }],
      ['src/main/llm/cli/bad-imports.ts', { 'no-restricted-imports': 4 }],
      ['src/main/media/bad-imports.ts', { 'no-restricted-imports': 5 }],
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

// ---------------------------------------------------------------------------------------------------------------------
// [V2] T2 8.2 group 2 part B (v2 boundaries), group 15 part C (AutoGate purity), part D (CLI / media / constructors).
// "reaches" = the transitive closure of RUNTIME (value) imports through src/**; "imports" = every direct import incl. types.
// Independent of ESLint: a resolver of its own over the real source tree (multi-line imports and value re-exports included).
// ---------------------------------------------------------------------------------------------------------------------

const MAIN_DIR = join(ROOT, 'src', 'main');

const parsed = new Map<string, ts.SourceFile>();
function sourceOf(file: string): ts.SourceFile {
  let sf = parsed.get(file);
  if (sf === undefined) {
    sf = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    parsed.set(file, sf);
  }
  return sf;
}

/** The file's code with every comment removed (TypeScript printer - no regex guesses about strings or regex literals). */
const codeCache = new Map<string, string>();
function codeOf(repoRelFile: string): string {
  let code = codeCache.get(repoRelFile);
  if (code === undefined) {
    code = ts.createPrinter({ removeComments: true }).printFile(sourceOf(join(ROOT, repoRelFile)));
    codeCache.set(repoRelFile, code);
  }
  return code;
}

/** Every import / re-export / dynamic import / `import('x').T` specifier of a file (TypeScript AST), with a flag for type-only
 *  edges: `import type`, `export type`, a clause whose every named binding is `type X`, and `import('x')` in a type position. */
function importStatements(file: string): Array<{ spec: string; typeOnly: boolean }> {
  const out: Array<{ spec: string; typeOnly: boolean }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      let typeOnly = false;
      if (clause !== undefined) {
        if (clause.isTypeOnly) typeOnly = true;
        else if (
          clause.name === undefined &&
          clause.namedBindings !== undefined &&
          ts.isNamedImports(clause.namedBindings)
        ) {
          const els = clause.namedBindings.elements;
          typeOnly = els.length > 0 && els.every((e) => e.isTypeOnly);
        }
      }
      out.push({ spec: node.moduleSpecifier.text, typeOnly });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const els =
        node.exportClause !== undefined && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : null;
      const typeOnly = node.isTypeOnly || (els !== null && els.length > 0 && els.every((e) => e.isTypeOnly));
      out.push({ spec: node.moduleSpecifier.text, typeOnly });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      out.push({ spec: node.arguments[0].text, typeOnly: false });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      out.push({ spec: node.argument.literal.text, typeOnly: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceOf(file));
  return out;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** A relative specifier -> the repo-relative source file; a bare specifier stays as written ('electron', 'node:fs'). */
function resolveSpec(fromFile: string, spec: string): string {
  if (!spec.startsWith('.')) return spec;
  const base = join(fromFile, '..', spec);
  const stripped = base.replace(/\.(js|mjs)$/, '');
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), `${stripped}.ts`, `${stripped}.tsx`]) {
    if (isFile(c)) return rel(c);
  }
  throw new Error(`${rel(fromFile)}: unresolvable import ${spec}`);
}

function directImports(file: string): string[] {
  return importStatements(join(ROOT, file)).map((s) => resolveSpec(join(ROOT, file), s.spec));
}

/** Transitive closure of runtime (value) imports starting at a repo-relative file; bare specifiers are leaves. */
function reaches(file: string): Set<string> {
  const seen = new Set<string>();
  const queue = [file];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const s of importStatements(join(ROOT, cur))) {
      if (s.typeOnly) continue;
      const target = resolveSpec(join(ROOT, cur), s.spec);
      if (seen.has(target)) continue;
      seen.add(target);
      if (target.startsWith('src/') && /\.tsx?$/.test(target)) queue.push(target);
    }
  }
  return seen;
}

function violations(file: string, forbidden: RegExp): string[] {
  const hits = new Set<string>();
  for (const d of directImports(file)) if (forbidden.test(d)) hits.add(`imports ${d}`);
  for (const r of reaches(file)) if (forbidden.test(r)) hits.add(`reaches ${r}`);
  return [...hits].sort();
}

const mainFiles = (): string[] => walk(MAIN_DIR).map(rel);

describe("B. [V2] the tool server and the WhatsApp read path reach no write / exec / llm / electron module (I2', I6')", () => {
  const FORBIDDEN =
    /^(src\/main\/bridge\/(sendClient|readClient)\.ts|src\/main\/mcp\/(writeClient|adminClient|host)\.ts|src\/main\/exec\/.*|src\/main\/llm\/.*|electron)$/;
  for (const file of [
    'src/main/mcp/toolServer.ts',
    'src/main/bridge/waReadClient.ts',
    'src/main/agent/waTools.ts',
    'src/main/agent/handles.ts',
  ]) {
    it(`${file} imports / reaches none of sendClient, readClient, writeClient, adminClient, host, exec/**, llm/**, electron`, () => {
      expect(violations(file, FORBIDDEN)).toEqual([]);
    });
  }

  it('the resolver is not vacuous: it follows value imports transitively and skips type-only ones', () => {
    expect(reaches('src/main/compose.ts').has('src/main/exec/actionExecutor.ts')).toBe(true);
    expect(reaches('src/main/mcp/toolServer.ts').has('src/main/proc/freePort.ts')).toBe(true);
    // toolServer.ts imports agent/toolGate for TYPES only: a direct import, never a runtime edge
    expect(directImports('src/main/mcp/toolServer.ts')).toContain('src/main/agent/toolGate.ts');
    expect(reaches('src/main/mcp/toolServer.ts').has('src/main/agent/toolGate.ts')).toBe(false);
    // a known-bad pair is caught
    expect(violations('src/main/compose.ts', /^src\/main\/bridge\/sendClient\.ts$/)).not.toEqual([]);
  });
});

describe('C. [V2] group 15 - exec/autoGate.ts is pure and agent/** never imports it', () => {
  it('exec/autoGate.ts imports / reaches no agent/**, llm/**, ipc/**, electron, node:fs, node:child_process', () => {
    expect(
      violations(
        'src/main/exec/autoGate.ts',
        /^(src\/main\/(agent|llm|ipc)\/.*|electron|node:fs|fs|node:fs\/promises|fs\/promises|node:child_process|child_process)$/,
      ),
    ).toEqual([]);
  });
  it('exec/autoGate.ts reaches only shared/**, exec-local modules and zod (no I/O module, no other package)', () => {
    for (const r of reaches('src/main/exec/autoGate.ts')) {
      expect(r, `autoGate reaches ${r}`).toMatch(/^(src\/(shared\/|main\/exec\/).*|zod)$/);
    }
  });
  it('no agent/** file imports exec/autoGate.ts (directly or transitively)', () => {
    for (const f of mainFiles().filter((p) => p.startsWith('src/main/agent/'))) {
      expect(violations(f, /^src\/main\/exec\/autoGate\.ts$/), f).toEqual([]);
    }
  });
});

describe('D. [V2] CLI, media and constructor boundaries', () => {
  it('llm/cli/** imports / reaches no mcp/host, bridge/**, exec/**', () => {
    const files = mainFiles().filter((p) => p.startsWith('src/main/llm/cli/'));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) {
      expect(violations(f, /^src\/main\/(mcp\/host\.ts|bridge\/.*|exec\/.*)$/), f).toEqual([]);
    }
  });

  it('media/fetch.ts is the only caller of BridgeReadClient.getMedia (the client itself defines it)', () => {
    const callers: string[] = [];
    for (const f of mainFiles()) {
      if (f === 'src/main/bridge/readClient.ts') continue;
      const code = codeOf(f)
        // bridge/invariants.ts carries the same rule as a regex literal - a regex is not a call
        .replace(/\/\\\.getMedia[^/\n]*\//g, '');
      if (/\.getMedia\s*\(|\bgetMedia\s*[:=]\s*[\w.]+\.getMedia\b|['"]getMedia['"]/.test(code)) callers.push(f);
    }
    expect(callers).toEqual(['src/main/media/fetch.ts']);
  });

  it('agent/readImage.ts is the only constructor of an LlmImagePart', () => {
    const builders = new Set<string>();
    for (const f of mainFiles()) {
      const code = codeOf(f);
      // an object literal with the LlmImagePart discriminant: type 'image' next to a mime / base64 key
      if (/type:\s*['"]image['"]\s*,\s*(mime|base64)\s*:/.test(code)) builders.add(f);
      // a function or value typed as producing one outside the type module
      if (
        /\)\s*:\s*LlmImagePart\b|\bas\s+LlmImagePart\b|:\s*LlmImagePart\s*=/.test(code) &&
        f !== 'src/main/llm/types.ts'
      )
        builders.add(f);
    }
    expect([...builders]).toEqual(['src/main/agent/readImage.ts']);
  });

  it('only compose.ts constructs WaReadClient, McpWriteClient, BridgeSendClient, CliRunner, JobRunner and the tool server', () => {
    const CONSTRUCTORS: Array<[string, string]> = [
      ['createWaReadClient', 'src/main/bridge/waReadClient.ts'],
      ['createMcpWriteClient', 'src/main/mcp/writeClient.ts'],
      ['createBridgeSendClient', 'src/main/bridge/sendClient.ts'],
      ['createCliRunner', 'src/main/llm/cli/runner.ts'],
      ['createJobRunner', 'src/main/proc/jobRunner.ts'],
      ['startToolServer', 'src/main/mcp/toolServer.ts'],
    ];
    for (const [name, definer] of CONSTRUCTORS) {
      const callers: string[] = [];
      for (const f of mainFiles()) {
        if (f === definer) continue;
        const code = codeOf(f);
        // a CALL of the module-level factory; `deps.startToolServer(...)` / `startToolServer: (...) =>` is an injected seam
        const calls = [...code.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))].filter(
          (m) => !/[.]\s*$/.test(code.slice(Math.max(0, m.index - 3), m.index)),
        );
        if (calls.length > 0) callers.push(f);
      }
      expect(callers, name).toEqual(['src/main/compose.ts']);
    }
  });
});
