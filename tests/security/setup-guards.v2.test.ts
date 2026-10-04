// [V2] Self-tests of the T8 / T9 guards and the T7 additions of tests/setup-guards.ts (V2-W0-scaffold; owner W2-02).
// Every forbidden call below is refused by the guard BEFORE the real syscall happens: nothing is spawned, and the user's
// real vendor-CLI state is never read, listed, stat'ed or written. The prefixes come from the real env at install time.
import cp from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ForbiddenVendorSpawnError,
  ForbiddenVendorStateError,
  VENDOR_BINARY_RE,
  VENDOR_STATE_PREFIXES,
  assertAllowedSpawn,
  registerListener,
  registerUserDataDir,
  v2LeakProblems,
  vendorStateRuleOf,
} from '../setup-guards.ts';

describe('T8 - vendor binaries are never spawned', () => {
  it.each([
    ['claude.exe', []],
    ['C:\\Users\\u\\.local\\bin\\claude.exe', ['--version']],
    ['claude', ['-p']],
    ['claude.cmd', []],
    ['agy', ['models']],
    ['whisper-cli.exe', ['-m', 'x']],
    ['C:\\x\\resources\\llama\\llama-server.exe', []],
    ['where.exe', ['claude']],
    ['where', ['node']],
  ] as Array<[string, string[]]>)('%s', (command, args) => {
    expect(() => cp.spawn(command, args)).toThrow(ForbiddenVendorSpawnError);
  });

  it('checks every argv element and command-string token (cmd /c claude ...)', () => {
    expect(() => cp.spawn('cmd.exe', ['/c', 'claude', '-p'])).toThrow(ForbiddenVendorSpawnError);
    expect(() => cp.spawn(process.execPath, ['-e', '1', 'C:\\x\\agy.exe'])).toThrow(ForbiddenVendorSpawnError);
    expect(() => cp.exec('cmd /c where node')).toThrow(ForbiddenVendorSpawnError);
    expect(() => cp.execFileSync('C:\\Windows\\System32\\where.exe', ['node'])).toThrow(ForbiddenVendorSpawnError);
    expect(() => cp.spawnSync('whisper-cli', [])).toThrow(ForbiddenVendorSpawnError);
  });

  it('refuses a visible console: cmd /k in any casing', () => {
    expect(() => cp.spawn('cmd.exe', ['/k', 'echo'])).toThrow(/cmd \/k/);
    expect(() => cp.spawn('C:\\Windows\\System32\\CMD.EXE', ['/K'])).toThrow(ForbiddenVendorSpawnError);
    expect(() => cp.exec('cmd /k echo')).toThrow(ForbiddenVendorSpawnError);
  });

  it('lets the fakes through (node.exe + tests\\fakes\\*.mjs) - the regex is a basename match, not a substring', () => {
    expect(() =>
      assertAllowedSpawn(process.execPath, ['C:\\repo\\tests\\fakes\\fake-claude-cli.mjs', '--fake-end', '-p']),
    ).not.toThrow();
    expect(() => assertAllowedSpawn(process.execPath, ['C:\\repo\\tests\\fakes\\whisper-cli.mjs'])).not.toThrow();
    expect(() => assertAllowedSpawn('cmd.exe', ['/c', 'echo', 'k'])).not.toThrow();
    for (const ok of ['claude.json', 'claudex.exe', 'myclaude', 'where-else', 'agy.mjs'])
      expect(VENDOR_BINARY_RE.test(ok), ok).toBe(false);
  });
});

describe('T9 - the real vendor-CLI state is untouchable', () => {
  it('the prefixes are resolved from the real env (this machine has a profile)', () => {
    expect(process.env.USERPROFILE, 'USERPROFILE must be set for the T9 guard (Windows dev PC)').toBeTruthy();
    expect(VENDOR_STATE_PREFIXES.map((p) => p.label)).toEqual(
      expect.arrayContaining(['%USERPROFILE%\\.claude*', '%USERPROFILE%\\.gemini\\', '%USERPROFILE%\\.local\\bin\\']),
    );
  });

  it('reads, lists, stats and writes are refused before the syscall', async () => {
    const home = process.env.USERPROFILE!;
    const claudeJson = path.join(home, '.claude.json');
    const claudeDir = path.join(home, '.claude');
    expect(() => fs.readFileSync(claudeJson)).toThrow(ForbiddenVendorStateError);
    expect(() => fs.existsSync(claudeJson)).toThrow(ForbiddenVendorStateError);
    expect(() => fs.readdirSync(claudeDir)).toThrow(ForbiddenVendorStateError);
    expect(() => fs.statSync(path.join(home, '.gemini', 'settings.json'))).toThrow(ForbiddenVendorStateError);
    expect(() => fs.writeFileSync(path.join(home, '.local', 'bin', 'x.txt'), 'x')).toThrow(ForbiddenVendorStateError);
    expect(() => fs.mkdirSync(path.join(claudeDir, 'x'))).toThrow(ForbiddenVendorStateError);
    // the promise API is guarded by the same synchronous check (thrown before any I/O is queued)
    await expect(Promise.resolve().then(() => fsp.readFile(claudeJson))).rejects.toThrow(ForbiddenVendorStateError);
    // the error names the rule, never the resolved profile path
    try {
      fs.readFileSync(claudeJson);
    } catch (e) {
      expect((e as Error).message).not.toContain(home);
    }
  });

  it('matches by rule, case-insensitively, and leaves neighbours alone', () => {
    const home = process.env.USERPROFILE!;
    expect(vendorStateRuleOf(`${home.toUpperCase()}\\.CLAUDE\\settings.json`)).toBe('%USERPROFILE%\\.claude*');
    expect(vendorStateRuleOf(`${home}/.claude-something/x`)).toBe('%USERPROFILE%\\.claude*');
    expect(vendorStateRuleOf(`${home}\\.geminix\\a`)).toBeNull();
    expect(vendorStateRuleOf(`${home}\\.local\\share\\x`)).toBeNull();
    expect(vendorStateRuleOf(path.join(os.tmpdir(), 'wca-fake-home', '.claude.json'))).toBeNull();
    expect(vendorStateRuleOf('.claude.json')).toBeNull();
  });
});

describe('T7 additions - leaks of v2 resources', () => {
  it('an open listener is reported (and closed); a closed one is not', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const unregister = registerListener({
      name: 'self-test',
      get listening() {
        return server.listening;
      },
      close: () => server.close(),
    });
    expect(v2LeakProblems()).toEqual(['listener "self-test" was still open']);
    unregister();
    await new Promise((r) => setTimeout(r, 0));
    expect(server.listening).toBe(false);
    expect(v2LeakProblems()).toEqual([]);
  });

  it('job pid files, cli-runs, agy runs and voice wavs left in a registered userData are reported', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-guard-'));
    const unregister = registerUserDataDir(dir);
    try {
      expect(v2LeakProblems()).toEqual([]);
      fs.mkdirSync(path.join(dir, 'run'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'run', 'job-cli-1.pid.json'), '{}');
      fs.writeFileSync(path.join(dir, 'run', 'bridge.pid.json'), '{}'); // not a job pid file
      fs.mkdirSync(path.join(dir, 'cli-runs', 'r1'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'agy-workspace', 'runs', 'r2'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'voice', 'tmp'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'voice', 'tmp', 'j1.wav'), '');
      expect(v2LeakProblems()).toEqual([
        '1 job pid file(s) left in <userData>\\run',
        '<userData>\\cli-runs is not empty',
        '<userData>\\agy-workspace\\runs is not empty',
        '1 .wav file(s) left in <userData>\\voice\\tmp',
      ]);
    } finally {
      unregister();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(v2LeakProblems()).toEqual([]);
  });
});
