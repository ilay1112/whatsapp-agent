// src/main/update/updatePolicy.test.ts - v5 review fix pass: the install-folder rule and the minimal updater environment, in
// main (updatePolicy.ts) AND in the updater script (the same lists embedded in updater.cjs, loaded here with require()).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inspectInstallDir, minimalUpdaterEnv, protectedDirsFor, type InstallDirVerdict } from './updatePolicy';
import { UPDATER_SCRIPT } from './updaterScript';

const EXE = 'WhatsApp Calendar Agent.exe';
/** The real top level of dist/win-unpacked (electron-builder --dir, 2026-10-20). Directories end in '/'. */
const REAL_WIN_UNPACKED_TOP_LEVEL = [
  'LICENSE.electron.txt',
  'LICENSES.chromium.html',
  EXE,
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  'd3dcompiler_47.dll',
  'dxcompiler.dll',
  'dxil.dll',
  'ffmpeg.dll',
  'icudtl.dat',
  'locales/',
  'resources/',
  'resources.pak',
  'snapshot_blob.bin',
  'v8_context_snapshot.bin',
  'vk_swiftshader.dll',
  'vk_swiftshader_icd.json',
  'vulkan-1.dll',
] as const;

interface ScriptRules {
  inspectInstallDir(dir: string, exeName: string, prot: readonly string[]): string | null;
  protectedDirs(env: Record<string, string | undefined>): string[];
  minimalEnv(src: Record<string, string | undefined>, runAsNode: boolean): Record<string, string>;
}
let script: ScriptRules;
let scriptDir = '';
const roots: string[] = [];
beforeAll(() => {
  scriptDir = mkdtempSync(join(tmpdir(), 'wca-policy-script-'));
  const file = join(scriptDir, 'updater.cjs');
  writeFileSync(file, UPDATER_SCRIPT);
  script = createRequire(import.meta.url)(file) as ScriptRules;
});
afterAll(() => rmSync(scriptDir, { recursive: true, force: true }));
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function folder(entries: readonly string[], opts: { asar?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'wca-policy-'));
  roots.push(root);
  const dir = join(root, 'WhatsApp Calendar Agent');
  mkdirSync(dir);
  for (const e of entries) {
    if (e.endsWith('/')) mkdirSync(join(dir, e.slice(0, -1)), { recursive: true });
    else writeFileSync(join(dir, e), 'x');
  }
  if (opts.asar !== false && existsSync(join(dir, 'resources'))) writeFileSync(join(dir, 'resources', 'app.asar'), 'a');
  return dir;
}
/** Both implementations, one verdict: 'ok' or the refusal reason. */
async function both(dir: string, prot: readonly string[] = []): Promise<[string, string]> {
  const v: InstallDirVerdict = await inspectInstallDir(dir, EXE, prot);
  return [v.ok ? 'ok' : v.reason, script.inspectInstallDir(dir, EXE, prot) ?? 'ok'];
}

describe('install folder rule (main + updater script)', () => {
  it('the real dist/win-unpacked top level passes', async () => {
    expect(await both(folder(REAL_WIN_UNPACKED_TOP_LEVEL))).toEqual(['ok', 'ok']);
  });

  it.skipIf(!existsSync(join(process.cwd(), 'dist', 'win-unpacked', EXE)))(
    'the actual dist/win-unpacked on this PC passes',
    async () => {
      expect(await both(join(process.cwd(), 'dist', 'win-unpacked'))).toEqual(['ok', 'ok']);
    },
  );

  it('other Electron top-level files pass too (version, swiftshader/, libEGL, libGLESv2)', async () => {
    const dir = folder([...REAL_WIN_UNPACKED_TOP_LEVEL, 'version', 'swiftshader/', 'libEGL.dll', 'libGLESv2.dll']);
    expect(await both(dir)).toEqual(['ok', 'ok']);
  });

  it.each([
    ['a photo next to the exe (an "Extract here" into Downloads)', ['photo.jpg']],
    ['a Documents folder', ['Documents/']],
    ['a shortcut', ['Notes.lnk']],
    ['a text file', ['todo.txt']],
    ['an unknown folder', ['projects/']],
  ])('refuses %s', async (_label, extra) => {
    const dir = folder([...REAL_WIN_UNPACKED_TOP_LEVEL, ...extra]);
    expect(await both(dir)).toEqual(['foreign_entry', 'foreign_entry']);
  });

  it('refuses a folder without the exe or without resources/app.asar', async () => {
    expect(await both(folder(REAL_WIN_UNPACKED_TOP_LEVEL.filter((e) => e !== EXE)))).toEqual([
      'exe_missing',
      'exe_missing',
    ]);
    expect(await both(folder(REAL_WIN_UNPACKED_TOP_LEVEL, { asar: false }))).toEqual(['asar_missing', 'asar_missing']);
  });

  it('refuses a missing folder, a relative path and a drive root', async () => {
    expect(await both(join(tmpdir(), 'wca-policy-does-not-exist'))).toEqual(['unreadable', 'unreadable']);
    expect(await both('portable\\app')).toEqual(['not_absolute', 'not_absolute']);
    expect(await both('C:\\')).toEqual(['drive_root', 'drive_root']);
    expect(await both('D:\\')).toEqual(['drive_root', 'drive_root']);
  });

  it('refuses the profile, Desktop, Downloads and Documents by path, even when they hold a clean build', async () => {
    const dir = folder(REAL_WIN_UNPACKED_TOP_LEVEL);
    const home = join(dir, '..');
    // pretend the build's parent is the profile and the build folder is one of its known folders
    for (const name of ['Desktop', 'Downloads', 'Documents']) {
      const known = join(home, name);
      mkdirSync(known);
      for (const e of REAL_WIN_UNPACKED_TOP_LEVEL)
        if (e.endsWith('/')) mkdirSync(join(known, e.slice(0, -1)));
        else writeFileSync(join(known, e), 'x');
      writeFileSync(join(known, 'resources', 'app.asar'), 'a');
      const fromEnv = script.protectedDirs({ USERPROFILE: home });
      expect(await both(known, protectedDirsFor(home))).toEqual(['protected_path', 'protected_path']);
      expect(script.inspectInstallDir(known, EXE, fromEnv)).toBe('protected_path');
      expect(script.inspectInstallDir(known.toUpperCase(), EXE, fromEnv)).toBe('protected_path'); // case-insensitive
    }
    expect((await inspectInstallDir(home, EXE, protectedDirsFor(home))).ok).toBe(false);
    // the build folder itself is not protected
    expect(await both(dir, protectedDirsFor(home))).toEqual(['ok', 'ok']);
    // extra paths (app.getPath('downloads') after known-folder redirection) are protected too
    expect(await both(dir, protectedDirsFor(undefined, [dir]))).toEqual(['protected_path', 'protected_path']);
  });
});

describe('minimal updater environment (main + updater script)', () => {
  const parent: Record<string, string> = {
    SystemRoot: 'C:\\WINDOWS',
    windir: 'C:\\WINDOWS',
    Path: 'C:\\WINDOWS\\system32;C:\\Program Files\\nodejs;C:\\Users\\u\\evil',
    TEMP: 'C:\\Users\\u\\AppData\\Local\\Temp',
    TMP: 'C:\\Users\\u\\AppData\\Local\\Temp',
    USERPROFILE: 'C:\\Users\\u',
    APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
    ProgramData: 'C:\\ProgramData',
    ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe',
    PATHEXT: '.COM;.EXE;.BAT',
    USERNAME: 'u',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\u',
    WCA_E2E: '1',
    WCA_UPDATE_BASE_URL: 'http://127.0.0.1:1',
    ELECTRON_RUN_AS_NODE: '0',
    ELECTRON_ENABLE_LOGGING: '1',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    GITHUB_TOKEN: 'ghp_secret',
    NODE_OPTIONS: '--require evil.js',
  };
  const banned = /^(WCA_|ELECTRON_|ANTHROPIC_|GITHUB_|NODE_)/i;

  it('the updater gets the allow-list + ELECTRON_RUN_AS_NODE=1; PATH is System32 only', () => {
    const env = minimalUpdaterEnv(parent, true);
    expect(env).toEqual({
      SystemRoot: 'C:\\WINDOWS',
      windir: 'C:\\WINDOWS',
      TEMP: 'C:\\Users\\u\\AppData\\Local\\Temp',
      TMP: 'C:\\Users\\u\\AppData\\Local\\Temp',
      USERPROFILE: 'C:\\Users\\u',
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      ProgramData: 'C:\\ProgramData',
      ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.BAT',
      USERNAME: 'u',
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\Users\\u',
      PATH: 'C:\\WINDOWS\\System32',
      ELECTRON_RUN_AS_NODE: '1',
    });
    expect(Object.keys(env).filter((k) => banned.test(k))).toEqual(['ELECTRON_RUN_AS_NODE']);
  });

  it('the relaunched app gets the same allow-list WITHOUT ELECTRON_RUN_AS_NODE; no WCA_/ELECTRON_/ANTHROPIC_ key', () => {
    for (const env of [minimalUpdaterEnv(parent, false), script.minimalEnv(parent, false)]) {
      expect(Object.keys(env).filter((k) => banned.test(k))).toEqual([]);
      expect(env.PATH).toBe('C:\\WINDOWS\\System32');
    }
  });

  it('the script builds exactly what main builds (keys looked up case-insensitively)', () => {
    const shouty = Object.fromEntries(Object.entries(parent).map(([k, v]) => [k.toUpperCase(), v]));
    for (const src of [parent, shouty, {}, { windir: 'D:\\Win\\' }])
      for (const runAsNode of [true, false])
        expect(script.minimalEnv(src, runAsNode)).toEqual(minimalUpdaterEnv(src, runAsNode));
    expect(minimalUpdaterEnv({ windir: 'D:\\Win\\' }, false)).toEqual({
      windir: 'D:\\Win\\',
      PATH: 'D:\\Win\\System32',
    });
  });
});
