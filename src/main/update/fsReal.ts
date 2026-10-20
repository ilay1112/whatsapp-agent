// src/main/update/fsReal.ts - the ONLY file system module of src/main/update in the main process (v5 review fix pass).
// Inside Electron, `node:fs` is patched for asar archives: stat('...\resources\app.asar') describes the archive as a folder
// (or throws "Invalid package"), open(app.asar, 'wx') tries to open it as an archive, and a recursive walk descends into it.
// Every update folder (the staged build, `.old-*`, failed-download leftovers) contains an app.asar, so main must use
// Electron's unpatched `original-fs`. Plain Node (vitest) has no such module and no patch: it gets `node:fs`.
// A test (fsReal.test.ts) fails on any other `node:fs` import under src/main/update. The updater script is the exception
// (see updaterScript.ts): it runs as a separate process and only uses calls verified to be safe under the patch.
import { createRequire } from 'node:module';
import type * as NodeFs from 'node:fs';

type FsModule = typeof NodeFs;

/** Picks the unpatched fs inside Electron, node:fs elsewhere (exported for its test). */
export function selectFs(isElectron: boolean, load: (id: string) => unknown): FsModule {
  return (isElectron ? load('original-fs') : load('node:fs')) as FsModule;
}

const load = createRequire(import.meta.url);
export const realFs: FsModule = selectFs(process.versions.electron !== undefined, load);
export const realFsp: FsModule['promises'] = realFs.promises;
export type FileHandle = NodeFs.promises.FileHandle;
