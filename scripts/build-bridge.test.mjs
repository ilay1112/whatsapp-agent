// scripts/build-bridge.test.mjs - `build-bridge.mjs` with an injected spawnSync / fs (TESTS 5.3 row `scripts/*.mjs`).
// Never runs `go`, never writes into resources/, never touches (let alone starts) a real exe.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildBridge, buildEnv, goBuildArgs } from './build-bridge.mjs';

const DIGEST = 'ab12'.repeat(16);
const OUT_EXE = 'C:\\fixture repo\\resources\\bridge\\whatsapp-bridge.exe';
const OUT_SUMS = 'C:\\fixture repo\\resources\\bridge\\SHA256SUMS';
const SRC_DIR = 'C:\\fixture repo\\vendor\\whatsapp-bridge-src';

function harness({ goMissing = false, buildStatus = 0 } = {}) {
  const calls = [];
  const writes = [];
  const out = [];
  const err = [];
  const spawnSync = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'go' && goMissing) return { error: Object.assign(new Error('spawn go ENOENT'), { code: 'ENOENT' }) };
    if (args[0] === 'version') return { status: 0, stdout: 'go version go1.27 windows/amd64\n' };
    if (args[0] === '--version') return { status: 0, stdout: 'gcc 15\n' };
    return { status: buildStatus };
  };
  const opts = {
    spawnSync,
    writeFile: (p, text) => writes.push({ p, text }),
    sizeOf: () => 12_345,
    hash: async () => DIGEST,
    env: { PATH: 'x' },
    srcDir: SRC_DIR,
    outExe: OUT_EXE,
    outSums: OUT_SUMS,
    pinnedSha256: DIGEST,
    io: { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) } },
  };
  return { opts, calls, writes, out, err };
}

describe('build-bridge.mjs', () => {
  it('go missing -> exit 1, names both winget packages, nothing built or written', async () => {
    const h = harness({ goMissing: true });
    expect(await buildBridge(h.opts)).toBe(1);
    expect(h.writes).toEqual([]);
    expect(h.calls.map((c) => c.args[0])).toEqual(['version']);
    expect(h.err.join('')).toMatch(/GoLang\.Go/);
    expect(h.err.join('')).toMatch(/BrechtSanders\.WinLibs\.POSIX\.UCRT/);
  });

  it('build ok -> SHA256SUMS written with the upper-case digest, size + sha printed', async () => {
    const h = harness();
    expect(await buildBridge(h.opts)).toBe(0);
    expect(h.writes).toEqual([{ p: OUT_SUMS, text: `${DIGEST.toUpperCase()}  whatsapp-bridge.exe\n` }]);
    expect(h.out.join('')).toContain(`OK 12345 bytes sha256 ${DIGEST.toUpperCase()}`);
  });

  it('go build argv is exact, shell:false, cwd = vendored source, CGO_ENABLED=1 + CC', async () => {
    const h = harness();
    await buildBridge(h.opts);
    const build = h.calls.find((c) => c.args[0] === 'build');
    expect(build.cmd).toBe('go');
    expect(build.args).toEqual(['build', '-trimpath', '-buildvcs=false', '-o', OUT_EXE, '.']);
    expect(build.args).toEqual(goBuildArgs(OUT_EXE));
    expect(build.opts.shell).toBe(false);
    expect(build.opts.cwd).toBe(SRC_DIR);
    expect(build.opts.env.CGO_ENABLED).toBe('1');
    expect(build.opts.env.CC).toBe('gcc');
    for (const c of h.calls) expect(c.opts.shell).toBe(false);
  });

  it('a failed build writes nothing', async () => {
    const h = harness({ buildStatus: 2 });
    expect(await buildBridge(h.opts)).toBe(1);
    expect(h.writes).toEqual([]);
  });

  it('never starts the built exe: every process is go or the C compiler', async () => {
    const h = harness();
    await buildBridge(h.opts);
    expect(h.calls.map((c) => c.cmd)).toEqual(['go', 'gcc', 'go']);
    const src = readFileSync(fileURLToPath(new URL('./build-bridge.mjs', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/\bexec[A-Za-z]*\s*\(|\bspawn\s*\(|execFile|shell:\s*true/);
  });

  it('CC comes from the environment when set', () => {
    expect(buildEnv({ CC: 'x86_64-w64-mingw32-gcc' }).CC).toBe('x86_64-w64-mingw32-gcc');
    expect(buildEnv({}).CGO_ENABLED).toBe('1');
  });
});
