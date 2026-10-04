import { it, expect } from 'vitest';
import { createCliLocator, createCliStatus } from '../../../src/main/llm/cli/locator';

it('agy /usage probe runs in the REAL profile, reached by a plain status.get() (no consent gate)', async () => {
  const specs: any[] = [];
  const env = {
    USERPROFILE: String.raw`C:\Users\someone`,
    APPDATA: String.raw`C:\Users\someone\AppData\Roaming`,
    LOCALAPPDATA: String.raw`C:\Users\someone\AppData\Local`,
    TEMP: String.raw`C:\T`,
    SystemRoot: String.raw`C:\Windows`,
  };
  const jobs: any = {
    run: async (spec: any, fn: any) => {
      specs.push(spec);
      const out = spec.args.includes('--version') ? ['1.2.11'] : ['{}'];
      return fn({ lines: async function* () { yield* out; }, done: Promise.resolve({ exitCode: 0 }) });
    },
  };
  const loc = createCliLocator({
    env,
    statFile: (p: string) => ({ isFile: p.toLowerCase().endsWith('agy.exe') }),
    runWhere: async () => [],
    settingsClaudeExePath: () => '',
    seam: null,
    jobs,
  } as any);
  const status = createCliStatus({ locator: loc, runner: {} as any, clock: { now: () => 0 as any }, cacheMs: 60_000 });
  const s = await status.get('antigravity_cli');
  const usage = specs.find((x) => x.args.includes('/usage'));
  console.log(
    JSON.stringify({
      state: s.state,
      specs: specs.map((x) => ({ args: x.args, cwd: x.cwd, U: x.env.USERPROFILE, H: x.env.HOME, A: x.env.APPDATA, L: x.env.LOCALAPPDATA })),
    }),
  );
  expect(usage).toBeDefined();
  expect(usage.args).toEqual(['-p', '/usage', '--output-format', 'json']);
  expect(usage.env.USERPROFILE).toBe(String.raw`C:\Users\someone`);
  expect(usage.env.HOME).toBe(String.raw`C:\Users\someone`);
  expect(usage.env.APPDATA).toBe(String.raw`C:\Users\someone\AppData\Roaming`);
  expect(usage.cwd).toBe(String.raw`C:\Users\someone\AppData\Local\agy\bin`);
});
