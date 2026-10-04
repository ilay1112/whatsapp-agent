// src/main/app/tray.ts - tray menu template (pure) + Tray wiring (build-plan section 3; owner W1-12; v2 owner V2-W1-04). May import
// `electron`. [V2] UX2 2.4: while an automatic-mode policy is live, one line "Automatic mode: on/trial/paused" (id autoPause) - a click
// pauses (on) / stops (trial) without a window or dialog, or opens Settings (paused: resume needs a focused click, B7).
import { Menu, nativeImage, Tray } from 'electron';
import { win32 as path } from 'node:path';
import type { AppHealth } from '../../shared/health';
import type { Logger } from '../deps';

/** Serialisable template (no Electron types) so tests and globalThis.__wcaTest can snapshot it. */
export interface TrayMenuItem {
  id: 'open' | 'status' | 'pause' | 'settings' | 'quit' | 'sep' | 'autoPause'; // [V2] + autoPause (B11, present only while a policy is live)
  label?: string;
  enabled?: boolean;
  type?: 'normal' | 'separator';
}
export interface TrayState {
  health: AppHealth;
  paused: boolean;
  waiting: number; // open items count (tooltip " - N waiting")
  setupDone: boolean;
  /** [V2 ADD] v2-build-plan 3 seam (V2-W1-04): live automatic-mode policy (null / absent = none). [W0 refinement] optional so v1 callers compile. */
  auto?: {
    state: import('../../shared/types').AutoPolicyState;
    pausedReason: import('../../shared/types').AutoPausedReason | null;
  } | null;
}
export type TrayIcon = 'tray' | 'tray-attention' | 'tray-paused' | 'tray-error';
export type TFn = (key: string, opts?: Record<string, unknown>) => string;

/** UX 12.1 status line, in precedence order. Never counts of people, never names, never message text. */
export function trayStatusKey(state: TrayState): string {
  if (!state.setupDone) return 'tray.status.setup';
  if (state.paused) return 'tray.status.paused';
  if (state.health.whatsapp.state !== 'online') return 'tray.status.wa_offline';
  if (state.health.overall === 'attention') return 'tray.status.attention';
  if (state.health.llm.provider === 'claude') return 'tray.status.active_claude';
  if (state.health.llm.provider === 'gemini') return 'tray.status.active_gemini';
  if (state.health.llm.provider === 'claude_cli') return 'tray.status.active_claude_cli'; // [V2] UX2 2.4
  if (state.health.llm.provider === 'antigravity_cli') return 'tray.status.active_antigravity_cli';
  return 'tray.status.active_local';
}

/** Pure: UX 12.1 (Open / status line disabled / Pause|Resume / Settings / Quit). Never counts of people, never names. */
/** [V2] The tray action of the automatic-mode line for a policy state (UX2 2.4). */
export function autoTrayAction(state: 'shadow' | 'on' | 'paused'): 'pause' | 'disable' | 'open' {
  return state === 'on' ? 'pause' : state === 'shadow' ? 'disable' : 'open';
}
const AUTO_TRAY_KEY = { on: 'tray.auto.on', shadow: 'tray.auto.shadow', paused: 'tray.auto.paused' } as const;

export function buildTrayTemplate(state: TrayState, t: TFn): TrayMenuItem[] {
  const live = state.auto?.state;
  const autoLine: TrayMenuItem[] =
    live === 'on' || live === 'shadow' || live === 'paused'
      ? [{ id: 'autoPause', label: t(AUTO_TRAY_KEY[live]), type: 'normal', enabled: true }]
      : [];
  return [
    { id: 'open', label: t('tray.open'), type: 'normal', enabled: true },
    { id: 'status', label: t(trayStatusKey(state)), type: 'normal', enabled: false },
    ...autoLine,
    { id: 'sep', type: 'separator' },
    { id: 'pause', label: t(state.paused ? 'tray.resume' : 'tray.pause'), type: 'normal', enabled: true },
    { id: 'settings', label: t('tray.settings'), type: 'normal', enabled: true },
    { id: 'sep', type: 'separator' },
    { id: 'quit', label: t('tray.quit'), type: 'normal', enabled: true },
  ];
}

/** Pure: icon + tooltip for a state. */
export function trayIconFor(state: TrayState, t: TFn): { icon: TrayIcon; tooltip: string } {
  const icon: TrayIcon = state.paused
    ? 'tray-paused'
    : state.health.overall === 'attention'
      ? 'tray-error'
      : state.waiting > 0
        ? 'tray-attention'
        : 'tray';
  // A count is allowed in the tooltip; text, drafts and names are not (ARCHITECTURE 13).
  const tooltip = state.waiting > 0 ? t('tray.tooltipWaiting', { count: state.waiting }) : t('tray.tooltip');
  return { icon, tooltip };
}

export interface TrayDeps {
  iconsDir: string;
  t: () => TFn; // current main i18n instance
  state: () => TrayState;
  onOpen: () => void;
  onTogglePause: () => void;
  onSettings: () => void;
  onQuit: () => void;
  log: Logger;
  /** [V2-W1-04 addition, optional] the automatic-mode line: 'pause' => auto:pause {reason:'user'}, 'disable' => auto:disable {reason:'user'}
   *  (both from main, no window, no dialog), 'open' => show the window at Settings > Automatic mode. Absent => the line is not clickable. */
  onAuto?: (action: 'pause' | 'disable' | 'open') => void;
}
export interface TrayController {
  tray: Tray;
  rebuild(): void; // on language, pause and health change
  template(): TrayMenuItem[];
  click(id: 'open' | 'pause' | 'settings' | 'quit' | 'autoPause'): void; // for globalThis.__wcaTest only ([V2] + autoPause)
  destroy(): void;
}

export function iconPath(iconsDir: string, icon: TrayIcon): string {
  return path.join(iconsDir, `${icon}.ico`);
}

export function createTray(deps: TrayDeps): TrayController {
  const log = deps.log.child('tray');
  // No GUID while the exe is unsigned (electron-stack 5.1); the instance is kept alive by the closure below.
  const tray = new Tray(nativeImage.createFromPath(iconPath(deps.iconsDir, 'tray')));
  let template: TrayMenuItem[] = [];
  let icon: TrayIcon | null = null;

  const actions: Record<'open' | 'pause' | 'settings' | 'quit' | 'autoPause', () => void> = {
    open: () => deps.onOpen(),
    pause: () => deps.onTogglePause(),
    settings: () => deps.onSettings(),
    quit: () => deps.onQuit(),
    autoPause: () => {
      const live = deps.state().auto?.state;
      if (live === 'on' || live === 'shadow' || live === 'paused') deps.onAuto?.(autoTrayAction(live));
    },
  };

  const rebuild = (): void => {
    const state = deps.state();
    const t = deps.t();
    template = buildTrayTemplate(state, t);
    const look = trayIconFor(state, t);
    if (look.icon !== icon) {
      icon = look.icon;
      tray.setImage(nativeImage.createFromPath(iconPath(deps.iconsDir, look.icon)));
    }
    tray.setToolTip(look.tooltip);
    tray.setContextMenu(
      Menu.buildFromTemplate(
        template.map((item) =>
          item.type === 'separator'
            ? { type: 'separator' }
            : {
                id: item.id,
                label: item.label,
                enabled: item.enabled,
                ...(item.id === 'open' ||
                item.id === 'pause' ||
                item.id === 'settings' ||
                item.id === 'quit' ||
                item.id === 'autoPause'
                  ? { click: actions[item.id] }
                  : {}),
              },
        ),
      ),
    );
    log.info('rebuilt', {
      icon: look.icon,
      paused: state.paused,
      waiting: state.waiting,
      auto: state.auto?.state ?? null,
    });
  };

  tray.on('click', () => deps.onOpen());
  tray.on('double-click', () => deps.onOpen());
  rebuild();

  return {
    tray,
    rebuild,
    template: () => template.map((item) => ({ ...item })),
    click: (id) => actions[id](),
    destroy: () => {
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}
