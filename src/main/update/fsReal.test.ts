// src/main/update/fsReal.test.ts - v5 review fix pass: in the main process every file system call of src/main/update goes
// through fsReal (Electron's unpatched `original-fs`), because every update folder holds an app.asar.
import { readFileSync, readdirSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { realFs, realFsp, selectFs } from './fsReal';

const here = fileURLToPath(new URL('.', import.meta.url));

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...productionFiles(full));
    else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(e.name) && !/\.(test|fixtures)\.[cm]?[jt]s$/.test(e.name))
      out.push(full);
  }
  return out;
}

describe('fsReal is the only fs of src/main/update (main process)', () => {
  it('no production file under src/main/update imports or requires node:fs / fs except fsReal.ts', () => {
    const FS_IMPORT =
      /from\s+['"](?:node:)?fs(?:\/promises)?['"]|require\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)|import\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/;
    // updaterScript.ts: its require('node:fs') is INSIDE the updater.cjs string, a separate process run as Node that must
    // need nothing but built-ins (the script documents which calls are safe under the asar patch). Only that line is exempt.
    const EXEMPT_LINE = "const fs = require('node:fs');";
    const hits: string[] = [];
    const files = productionFiles(here);
    expect(files.map((f) => relative(here, f)).sort()).toEqual(
      expect.arrayContaining(['fsReal.ts', 'updateService.ts', 'updatePolicy.ts', 'updaterScript.ts', 'zip.ts']),
    );
    for (const f of files) {
      if (relative(here, f) === 'fsReal.ts') continue;
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!FS_IMPORT.test(line)) return;
          if (relative(here, f) === 'updaterScript.ts' && line.trim() === EXEMPT_LINE) return;
          hits.push(`${relative(here, f)}:${String(i + 1)}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('the grep itself catches every import form', () => {
    const FS_IMPORT =
      /from\s+['"](?:node:)?fs(?:\/promises)?['"]|require\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)|import\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/;
    for (const bad of [
      "import fsp from 'node:fs/promises';",
      "import * as fs from 'node:fs';",
      "import { rmSync } from 'fs';",
      "const fs = require('fs');",
      "const fsp = await import('node:fs/promises');",
    ])
      expect(FS_IMPORT.test(bad), bad).toBe(true);
    expect(FS_IMPORT.test("import { realFsp } from './fsReal';")).toBe(false);
  });

  it('selectFs: original-fs inside Electron, node:fs elsewhere; plain Node (this test) gets node:fs', () => {
    const asked: string[] = [];
    const load = (id: string): unknown => {
      asked.push(id);
      return { id };
    };
    expect(selectFs(true, load)).toEqual({ id: 'original-fs' });
    expect(selectFs(false, load)).toEqual({ id: 'node:fs' });
    expect(asked).toEqual(['original-fs', 'node:fs']);
    expect(process.versions.electron).toBeUndefined();
    expect(realFs.rmSync).toBe(nodeFs.rmSync);
    expect(realFsp).toBe(nodeFs.promises);
  });
});
