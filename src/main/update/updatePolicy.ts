// src/main/update/updatePolicy.ts - v5 review fix pass: the two rules the folder-swap must never get wrong, kept in ONE place and
// embedded verbatim (as data) into updater.cjs so main and the updater enforce the same lists.
//
// 1. What an install folder may contain. The swap RENAMES the whole folder of the running exe and later DELETES the previous
//    one, so it may only ever touch a folder that is exactly a packaged Electron build. The allow-list below is derived from
//    the real `dist/win-unpacked` top level (electron-builder 26 / Electron 44, 2026-10-20):
//      LICENSE.electron.txt  LICENSES.chromium.html  WhatsApp Calendar Agent.exe  chrome_100_percent.pak  chrome_200_percent.pak
//      d3dcompiler_47.dll  dxcompiler.dll  dxil.dll  ffmpeg.dll  icudtl.dat  locales/  resources/  resources.pak
//      snapshot_blob.bin  v8_context_snapshot.bin  vk_swiftshader.dll  vk_swiftshader_icd.json  vulkan-1.dll
//    plus what other Electron builds carry at the same level (`version`, `swiftshader/`, libEGL / libGLESv2 = *.dll).
//    Anything else at the top level (a photo, a Documents folder, a shortcut) means "this is not our folder": canInstall stays
//    false and the updater refuses before any rename. The exe and resources/app.asar must both be present.
//    The folder itself may never be a drive root, the user profile, Desktop, Downloads or Documents (by path).
// 2. The environment of the updater (and of the app it relaunches): an allow-list of Windows basics, PATH cut to System32.
//    Nothing of the app's own environment (WCA_*, ELECTRON_*, API keys, tokens) is passed on.
import { realFsp as fsp } from './fsReal';
import path from 'node:path';

/** Top-level folders of a packaged build (compared case-insensitively). */
export const PACKAGED_ROOT_DIRS: readonly string[] = ['locales', 'resources', 'swiftshader'];
/** Top-level files of a packaged build besides the exe (case-insensitive). The last one is canInstall's own write probe. */
export const PACKAGED_ROOT_FILES: readonly RegExp[] = [
  /^LICENSE[^\\/]*$/i,
  /^version$/i,
  /^chrome_[^\\/]+$/i,
  /^[^\\/]+\.(?:dll|pak|bin|dat|json)$/i,
  /^\.wca-write-probe-[0-9a-f]{12}$/i,
];
/** Files that must exist inside a packaged build (besides the exe). */
export const PACKAGED_REQUIRED_FILES: readonly string[] = ['resources/app.asar'];
/** Profile sub-folders that are never an install folder (also under OneDrive's known-folder redirection). */
export const PROTECTED_PROFILE_SUBDIRS: readonly string[] = [
  'Desktop',
  'Downloads',
  'Documents',
  'OneDrive',
  'OneDrive/Desktop',
  'OneDrive/Documents',
];

export type EntryKind = 'file' | 'dir' | 'other';

export function isPackagedRootEntry(name: string, kind: EntryKind, exeName: string): boolean {
  if (kind === 'dir') return PACKAGED_ROOT_DIRS.some((d) => d.toLowerCase() === name.toLowerCase());
  if (kind !== 'file') return false; // a symlink / junction / device is never part of a build
  if (name.toLowerCase() === exeName.toLowerCase()) return true;
  return PACKAGED_ROOT_FILES.some((re) => re.test(name));
}

export type InstallDirRefusal =
  'not_absolute' | 'drive_root' | 'protected_path' | 'unreadable' | 'foreign_entry' | 'exe_missing' | 'asar_missing';
export type InstallDirVerdict = { ok: true } | { ok: false; reason: InstallDirRefusal };

const norm = (p: string): string =>
  path
    .resolve(p)
    .replace(/[\\/]+$/, '')
    .toLowerCase();

/** The folders that are never an install folder: the profile itself, its Desktop / Downloads / Documents, plus `extra`
 *  (main passes app.getPath('home' | 'desktop' | 'downloads' | 'documents'), which follows known-folder redirection). */
export function protectedDirsFor(home: string | undefined, extra: readonly string[] = []): string[] {
  const out: string[] = [];
  if (home !== undefined && home !== '' && path.isAbsolute(home)) {
    out.push(home);
    for (const sub of PROTECTED_PROFILE_SUBDIRS) out.push(path.join(home, ...sub.split('/')));
  }
  for (const e of extra) if (e !== '' && path.isAbsolute(e)) out.push(e);
  return out;
}

/** Path rules only (no file system). */
export function installDirPathRefusal(dir: string, protectedDirs: readonly string[]): InstallDirRefusal | null {
  if (!path.isAbsolute(dir)) return 'not_absolute';
  const resolved = path.resolve(dir);
  const n = norm(resolved);
  if (n === norm(path.parse(resolved).root)) return 'drive_root';
  if (protectedDirs.some((p) => norm(p) === n)) return 'protected_path';
  return null;
}

/** canInstall's folder rule: `dir` holds a packaged build and nothing else. Never throws. */
export async function inspectInstallDir(
  dir: string,
  exeName: string,
  protectedDirs: readonly string[],
): Promise<InstallDirVerdict> {
  const byPath = installDirPathRefusal(dir, protectedDirs);
  if (byPath !== null) return { ok: false, reason: byPath };
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  for (const e of entries) {
    const kind: EntryKind = e.isSymbolicLink() ? 'other' : e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other';
    if (!isPackagedRootEntry(e.name, kind, exeName)) return { ok: false, reason: 'foreign_entry' };
  }
  // "Is a regular file" is read from the PARENT's directory listing, never from stat(): inside Electron (main, and the
  // updater run as Node) the asar patch makes stat('...\app.asar') describe the archive as a folder.
  const listedAsFile = async (parent: string, name: string): Promise<boolean> => {
    try {
      return (await fsp.readdir(parent, { withFileTypes: true })).some((e) => e.name === name && e.isFile());
    } catch {
      return false;
    }
  };
  if (!entries.some((e) => e.name === exeName && e.isFile())) return { ok: false, reason: 'exe_missing' };
  for (const rel of PACKAGED_REQUIRED_FILES) {
    const segs = rel.split('/');
    const name = segs.pop() ?? '';
    if (!(await listedAsFile(path.join(dir, ...segs), name))) return { ok: false, reason: 'asar_missing' };
  }
  return { ok: true };
}

// ---- environment ---------------------------------------------------------------------------------------------------------
/** The only variables the updater and the relaunched app receive (canonical spelling; looked up case-insensitively). PATH is
 *  not copied: it is rebuilt as `<SystemRoot>\System32`. */
export const UPDATER_ENV_KEYS: readonly string[] = [
  'SystemRoot',
  'windir',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ComSpec',
  'PATHEXT',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
];

/** The updater's environment (`runAsNode` adds ELECTRON_RUN_AS_NODE=1) or the relaunched app's (`runAsNode` false). */
export function minimalUpdaterEnv(
  src: Readonly<Record<string, string | undefined>>,
  runAsNode: boolean,
): Record<string, string> {
  const upper = new Map<string, string>();
  for (const [k, v] of Object.entries(src))
    if (typeof v === 'string' && !upper.has(k.toUpperCase())) upper.set(k.toUpperCase(), v);
  const out: Record<string, string> = {};
  for (const k of UPDATER_ENV_KEYS) {
    const v = upper.get(k.toUpperCase());
    if (v !== undefined && v !== '') out[k] = v;
  }
  const root = out.SystemRoot ?? out.windir;
  if (root !== undefined) out.PATH = `${root.replace(/[\\/]+$/, '')}\\System32`;
  if (runAsNode) out.ELECTRON_RUN_AS_NODE = '1';
  return out;
}
