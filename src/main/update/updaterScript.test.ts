// src/main/update/updaterScript.test.ts - v5 W2: the folder-swap updater run FOR REAL with Node against temp folders.
// The "exe" in both folders is a copy of node.exe: a relaunch with `--updated-from` / `--update-failed` makes it print
// "bad option" and exit at once, so nothing of the app is ever started. Locks are made the way Windows really makes them:
// a process whose current directory is inside a folder keeps that folder from being renamed (EBUSY).
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { UPDATER_EXIT, UPDATER_SCRIPT, updaterArgs } from './updaterScript';

const EXE = 'Fake App.exe';
let cacheDir = '';
let cachedExe = '';
const roots: string[] = [];
const children: ChildProcess[] = [];

beforeAll(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'wca-updater-cache-'));
  cachedExe = join(cacheDir, EXE);
  copyFileSync(process.execPath, cachedExe);
});
afterAll(async () => {
  await removeWhenFree(cacheDir);
});
afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      c.kill();
      await once(c, 'exit');
    }
  }
  for (const r of roots.splice(0)) await removeWhenFree(r);
});

/** A relaunched fake exe (node printing "bad option") may still be exiting, or be scanned by the antivirus, for a moment. */
async function removeWhenFree(dir: string): Promise<void> {
  for (let i = 0; ; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i >= 100) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

function placeExe(dir: string): void {
  try {
    linkSync(cachedExe, join(dir, EXE));
  } catch {
    copyFileSync(cachedExe, join(dir, EXE));
  }
}

interface Layout {
  root: string;
  installDir: string;
  stagedDir: string;
  logFile: string;
  script: string;
}
function layout(): Layout {
  const root = mkdtempSync(join(tmpdir(), 'wca-updater-'));
  roots.push(root);
  const installDir = join(root, 'portable', 'WhatsApp Calendar Agent');
  const stagedDir = join(root, 'userData', 'updates', '0.1.8', 'win-unpacked');
  mkdirSync(join(installDir, 'resources'), { recursive: true });
  mkdirSync(join(stagedDir, 'resources'), { recursive: true });
  placeExe(installDir);
  placeExe(stagedDir);
  writeFileSync(join(installDir, 'resources', 'version.txt'), 'old');
  writeFileSync(join(stagedDir, 'resources', 'version.txt'), 'new');
  writeFileSync(join(installDir, 'resources', 'app.asar'), 'asar old');
  writeFileSync(join(stagedDir, 'resources', 'app.asar'), 'asar new');
  writeFileSync(join(installDir, 'icudtl.dat'), 'icu');
  writeFileSync(join(stagedDir, 'icudtl.dat'), 'icu');
  const script = join(root, 'userData', 'updates', '0.1.8', 'updater.cjs');
  writeFileSync(script, UPDATER_SCRIPT);
  return { root, installDir, stagedDir, logFile: join(root, 'userData', 'logs', 'updater.log'), script };
}

/** A process that is "the old app": it exits by itself after `ms`. */
function oldApp(ms: number): ChildProcess {
  const c = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${String(ms)})`], { stdio: 'ignore' });
  children.push(c);
  return c;
}
/** Holds `dir` locked (current directory) for `ms`. */
function locker(dir: string, ms: number): ChildProcess {
  const c = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${String(ms)})`], { cwd: dir, stdio: 'ignore' });
  children.push(c);
  return c;
}

/** A packaged-looking previous build at `dir` (passes the folder rule). */
function oldBuild(dir: string): void {
  mkdirSync(join(dir, 'resources'), { recursive: true });
  placeExe(dir);
  writeFileSync(join(dir, 'resources', 'app.asar'), 'asar older');
}

async function runUpdater(
  l: Layout,
  pid: number,
  extra: string[] = ['3000', '20'],
  override: string[] | null = null,
  envOver: Record<string, string> = {},
) {
  const args =
    override ??
    updaterArgs({
      pid,
      installDir: l.installDir,
      stagedDir: l.stagedDir,
      exeName: EXE,
      logFile: l.logFile,
      from: '0.1.7',
      to: '0.1.8',
    });
  const child = spawn(process.execPath, [l.script, ...args, ...extra], {
    stdio: 'ignore',
    env: { ...process.env, ...envOver, ELECTRON_RUN_AS_NODE: '1' },
  });
  const [code] = (await once(child, 'exit')) as [number | null];
  const log = existsSync(l.logFile) ? readFileSync(l.logFile, 'utf8') : '';
  return { code, log };
}
const versionIn = (dir: string): string | null => {
  try {
    return readFileSync(join(dir, 'resources', 'version.txt'), 'utf8');
  } catch {
    return null;
  }
};

describe('updater.cjs (run with Node against temp folders)', () => {
  it('swaps the folders after the old app exits, relaunches the new exe and keeps exactly one previous build', async () => {
    const l = layout();
    oldBuild(`${l.installDir}.old-0.1.5`); // an older leftover build: removed
    oldBuild(`${l.installDir}.old-0.1.6`); // ditto
    const old = oldApp(400);
    const { code, log } = await runUpdater(l, old.pid!);
    expect(code).toBe(UPDATER_EXIT.ok);
    expect(versionIn(l.installDir)).toBe('new');
    expect(versionIn(`${l.installDir}.old-0.1.7`)).toBe('old');
    expect(existsSync(l.stagedDir)).toBe(false);
    expect(readdirSync(join(l.root, 'portable')).sort()).toEqual(
      ['WhatsApp Calendar Agent', 'WhatsApp Calendar Agent.old-0.1.7'].sort(),
    );
    expect(log).toMatch(/old_exited/);
    expect(log).toMatch(/swapped/);
    expect(log).toMatch(/relaunch mode=new ok=true/);
    expect(log).toMatch(/cleanup removed=2 kept=0/);
    expect(log).toMatch(/updater_exit code=0/);
    // the log carries events and numbers only - never a path
    expect(log).not.toContain(l.root);
    expect(log).not.toMatch(/[A-Za-z]:\\/);
  });

  it('when the old process never exits: touches nothing, starts nothing, exits non-zero (logged)', async () => {
    const l = layout();
    const { code, log } = await runUpdater(l, process.pid, ['300', '20']); // the test runner never exits during the test
    expect(code).toBe(UPDATER_EXIT.oldStillRunning);
    expect(versionIn(l.installDir)).toBe('old');
    expect(versionIn(l.stagedDir)).toBe('new');
    expect(existsSync(`${l.installDir}.old-0.1.7`)).toBe(false);
    expect(log).toMatch(/old_still_running waitedMs=300/);
    expect(log).not.toMatch(/relaunch/);
  });

  it('a locked install folder: nothing changes and the OLD build is relaunched with --update-failed', async () => {
    const l = layout();
    locker(l.installDir, 8_000);
    await new Promise((r) => setTimeout(r, 50));
    const { code, log } = await runUpdater(l, oldApp(50).pid!);
    expect(code).toBe(UPDATER_EXIT.installLocked);
    expect(versionIn(l.installDir)).toBe('old');
    expect(versionIn(l.stagedDir)).toBe('new');
    expect(log).toMatch(/rename_retry what=install attempt=10 code=EBUSY/);
    expect(log).toMatch(/relaunch mode=old ok=true/);
    expect(log).not.toMatch(/mode=new/);
  });

  it('a staged folder that cannot be moved in: the install is rolled back and the OLD build relaunched', async () => {
    const l = layout();
    locker(l.stagedDir, 8_000);
    await new Promise((r) => setTimeout(r, 50));
    const { code, log } = await runUpdater(l, oldApp(50).pid!);
    expect(code).toBe(UPDATER_EXIT.swapFailed);
    expect(versionIn(l.installDir)).toBe('old');
    expect(versionIn(l.stagedDir)).toBe('new');
    expect(existsSync(`${l.installDir}.old-0.1.7`)).toBe(false);
    expect(log).toMatch(/swap_failed/);
    expect(log).toMatch(/rolled_back/);
    expect(log).toMatch(/relaunch mode=old ok=true/);
  });

  it('a staged folder without the exe: nothing moves, the old build is relaunched, exit badArgs', async () => {
    const l = layout();
    rmSync(join(l.stagedDir, EXE));
    const { code, log } = await runUpdater(l, oldApp(50).pid!);
    expect(code).toBe(UPDATER_EXIT.badArgs);
    expect(versionIn(l.installDir)).toBe('old');
    expect(log).toMatch(/folder_or_exe_missing/);
    expect(log).toMatch(/relaunch mode=old ok=true/);
  });

  it.each([
    ['a relative install dir', (l: Layout) => ['1', 'portable', l.stagedDir, EXE, l.logFile, '0.1.7', '0.1.8']],
    ['a drive root as install dir', (l: Layout) => ['1', 'C:\\', l.stagedDir, EXE, l.logFile, '0.1.7', '0.1.8']],
    [
      'staged inside install',
      (l: Layout) => ['1', l.installDir, join(l.installDir, 'x'), EXE, l.logFile, '0.1.7', '0.1.8'],
    ],
    [
      'an exe name with a path',
      (l: Layout) => ['1', l.installDir, l.stagedDir, '..\\x.exe', l.logFile, '0.1.7', '0.1.8'],
    ],
    ['a non-exe', (l: Layout) => ['1', l.installDir, l.stagedDir, 'x.cmd', l.logFile, '0.1.7', '0.1.8']],
    ['a bad version', (l: Layout) => ['1', l.installDir, l.stagedDir, EXE, l.logFile, 'v0.1.7', '0.1.8']],
    ['a bad pid', (l: Layout) => ['abc', l.installDir, l.stagedDir, EXE, l.logFile, '0.1.7', '0.1.8']],
  ])('refuses %s without touching anything', async (_label, args) => {
    const l = layout();
    const { code } = await runUpdater(l, 0, [], args(l));
    expect(code).toBe(UPDATER_EXIT.badArgs);
    expect(versionIn(l.installDir)).toBe('old');
    expect(versionIn(l.stagedDir)).toBe('new');
  });

  it('never deletes an .old-* sibling that is not a packaged build (it is kept, the swap still completes)', async () => {
    const l = layout();
    const foreign = `${l.installDir}.old-0.1.5`;
    mkdirSync(join(foreign, 'Documents'), { recursive: true });
    writeFileSync(join(foreign, 'photo.jpg'), 'jpg');
    const sameName = `${l.installDir}.old-0.1.7`; // the name this swap wants, held by something that is not a build
    mkdirSync(sameName);
    writeFileSync(join(sameName, 'notes.txt'), 'mine');
    const { code, log } = await runUpdater(l, oldApp(50).pid!);
    expect(code).toBe(UPDATER_EXIT.ok);
    expect(versionIn(l.installDir)).toBe('new');
    expect(readFileSync(join(foreign, 'photo.jpg'), 'utf8')).toBe('jpg');
    expect(existsSync(join(foreign, 'Documents'))).toBe(true);
    expect(readFileSync(join(sameName, 'notes.txt'), 'utf8')).toBe('mine');
    const olds = readdirSync(join(l.root, 'portable')).filter((n) => n.includes('.old-0.1.7-'));
    expect(olds).toHaveLength(1); // the previous build went to a unique name instead
    expect(versionIn(join(l.root, 'portable', olds[0]!))).toBe('old');
    expect(log).toMatch(/old_build_kept reason=foreign_entry/);
    expect(log).toMatch(/cleanup removed=0 kept=2/);
  });

  it.each([
    ['a photo next to the exe', (l: Layout) => writeFileSync(join(l.installDir, 'photo.jpg'), 'jpg')],
    ['a Documents folder', (l: Layout) => mkdirSync(join(l.installDir, 'Documents'))],
    ['no resources/app.asar', (l: Layout) => rmSync(join(l.installDir, 'resources', 'app.asar'))],
    ['a staged build with a foreign entry', (l: Layout) => writeFileSync(join(l.stagedDir, 'readme.txt'), 'x')],
  ])(
    'an install folder that is not exactly a packaged build (%s): nothing moves, the old build relaunched',
    async (_l, mutate) => {
      const l = layout();
      mutate(l);
      const { code, log } = await runUpdater(l, oldApp(50).pid!);
      expect(code).toBe(UPDATER_EXIT.notAnInstallDir);
      expect(versionIn(l.installDir)).toBe('old');
      expect(versionIn(l.stagedDir)).toBe('new');
      expect(readdirSync(join(l.root, 'portable'))).toEqual(['WhatsApp Calendar Agent']);
      expect(log).toMatch(/not_an_install_dir which=(install|staged) reason=[a-z_]+/);
      expect(log).toMatch(/relaunch mode=old ok=true/);
      expect(log).not.toMatch(/mode=new/);
    },
  );

  it('a clean build sitting directly in Downloads (by path) is refused', async () => {
    const l = layout();
    const home = join(l.root, 'portable');
    const downloads = join(home, 'Downloads');
    oldBuild(downloads);
    const { code, log } = await runUpdater(
      l,
      oldApp(50).pid!,
      ['3000', '20'],
      ['1', downloads, l.stagedDir, EXE, l.logFile, '0.1.7', '0.1.8'],
      { USERPROFILE: home },
    );
    // (a clean build: only the path rule refuses it)
    expect(code).toBe(UPDATER_EXIT.notAnInstallDir);
    expect(log).toMatch(/reason=protected_path/);
    expect(versionIn(l.stagedDir)).toBe('new');
  });

  it('the relaunch gets the minimal environment, and the script needs only node built-ins', () => {
    expect(UPDATER_SCRIPT).toContain('env: minimalEnv(process.env, false)');
    expect(UPDATER_SCRIPT).not.toContain('Object.assign({}, process.env)');
    const requires = [...UPDATER_SCRIPT.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort();
    expect(requires).toEqual(['node:child_process', 'node:fs', 'node:path']);
    expect(UPDATER_SCRIPT).not.toMatch(/\beval\b|new Function|https?:\/\/|fetch\(/);
  });
});
