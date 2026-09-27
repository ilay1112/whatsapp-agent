// src/main/app/autostart.ts - Start with Windows (build-plan section 3; owner W1-12).
import type { ElectronFacade } from '../deps';

/** The Run-key entry is registered with exactly these arguments; getLoginItemSettings must be queried with the same list. */
export const LOGIN_ARGS: readonly string[] = ['--hidden'];

export interface AutostartDeps {
  electron: Pick<ElectronFacade, 'setLoginItem'>;
  enabled: boolean;
  isPackaged: boolean; // never registers an unpackaged dev build
}
/** setLoginItemSettings({ openAtLogin, args: ['--hidden'] }); no-op when unpackaged. */
export function applyAutostart(deps: AutostartDeps): void {
  // An unpackaged run would register node_modules\electron\dist\electron.exe in HKCU\...\Run (electron-stack 5.5).
  if (!deps.isPackaged) return;
  deps.electron.setLoginItem({ openAtLogin: deps.enabled, args: LOGIN_ARGS });
}
