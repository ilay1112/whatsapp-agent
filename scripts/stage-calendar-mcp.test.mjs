// scripts/stage-calendar-mcp.test.mjs - TESTS 5.3 row `scripts/*.mjs`: "stage-calendar-mcp.mjs argv contains
// --omit=dev --ignore-scripts". The runner is injected, so no npm process is ever started here.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MCP_DIR, MCP_ENTRY, MCP_PACKAGE, MCP_VERSION, isStaged, main, stageArgs } from './stage-calendar-mcp.mjs';

const sink = () => {
  const lines = [];
  return { write: (s) => lines.push(s), text: () => lines.join('') };
};
const io = () => {
  const out = sink();
  const err = sink();
  return { out, err };
};

describe('stageArgs', () => {
  it('uses `ci` from the committed lockfile, never `install`', () => {
    expect(stageArgs()[0]).toBe('ci');
    expect(stageArgs()).not.toContain('install');
  });
  it('contains --omit=dev and --ignore-scripts', () => {
    expect(stageArgs()).toContain('--omit=dev');
    expect(stageArgs()).toContain('--ignore-scripts');
  });
});

describe('stage-calendar-mcp.mjs source (static)', () => {
  const src = readFileSync(fileURLToPath(new URL('./stage-calendar-mcp.mjs', import.meta.url)), 'utf8');
  it('never spawns a shell', () => {
    expect(src).toMatch(/shell:\s*false/);
    expect(src).not.toMatch(/shell:\s*true/);
  });
  it('its only child process is the npm CLI - the staged MCP server is never started here', () => {
    const spawns = [...src.matchAll(/spawn[A-Za-z]*\(([^;]*?)\)/gs)].map((m) => m[1]);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatch(/process\.execPath,\s*\[cliPath/);
    expect(spawns[0]).not.toMatch(/MCP_ENTRY/);
  });
});

describe('build-resources/calendar-mcp package', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../build-resources/calendar-mcp/package.json', import.meta.url), 'utf8'),
  );
  it('is private-ish and pins exactly one dependency', () => {
    expect(pkg.private).toBe(true);
    expect(Object.keys(pkg.dependencies)).toEqual([MCP_PACKAGE]);
    expect(pkg.dependencies[MCP_PACKAGE]).toBe(MCP_VERSION); // exact pin, no ^ / ~
  });
  it('has a committed lockfile resolving the pinned version', () => {
    const lockPath = new URL('../build-resources/calendar-mcp/package-lock.json', import.meta.url);
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(lock.packages[`node_modules/${MCP_PACKAGE}`].version).toBe(MCP_VERSION);
  });
  it('MCP_ENTRY points inside MCP_DIR at the stdio build entry', () => {
    expect(MCP_ENTRY.startsWith(MCP_DIR)).toBe(true);
    expect(MCP_ENTRY.replace(/\\/g, '/')).toMatch(/node_modules\/@cocal\/google-calendar-mcp\/build\/index\.js$/);
  });
});

describe('main() with an injected runner', () => {
  it('reports "already staged" and does not run npm when the entry exists', async () => {
    if (!isStaged()) return; // staging has not been run in this tree yet; covered by the --force case below
    let calls = 0;
    const { out, err } = io();
    const code = await main([], { out, err }, () => {
      calls += 1;
      return { status: 0 };
    });
    expect(code).toBe(0);
    expect(calls).toBe(0);
    expect(out.text()).toMatch(/already staged/);
  });

  it('--force runs npm with the ci argv in build-resources/calendar-mcp', async () => {
    const seen = [];
    const { out, err } = io();
    const code = await main(['--force'], { out, err }, (cli, args, cwd) => {
      seen.push({ cli, args, cwd });
      return { status: 0 };
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].cwd).toBe(MCP_DIR);
    expect(seen[0].args).toEqual(stageArgs());
    expect(seen[0].cli).toMatch(/npm-cli\.js$/);
    // exit code depends on whether the (no-op) fake install left the entry in place
    expect(code).toBe(isStaged() ? 0 : 1);
    if (!isStaged()) expect(err.text()).toMatch(/still missing/);
  });

  it('--force surfaces a non-zero npm exit as failure', async () => {
    const { out, err } = io();
    const code = await main(['--force'], { out, err }, () => ({ status: 7 }));
    expect(code).toBe(1);
    expect(err.text()).toMatch(/npm exited 7/);
  });

  it('--check never installs', async () => {
    let calls = 0;
    const { out, err } = io();
    const code = await main(['--check'], { out, err }, () => {
      calls += 1;
      return { status: 0 };
    });
    expect(calls).toBe(0);
    expect(code).toBe(existsSync(MCP_ENTRY) ? 0 : 1);
  });
});
