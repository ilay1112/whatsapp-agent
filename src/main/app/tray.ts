// src/main/app/tray.ts - tray menu template (pure) + Tray wiring (build-plan section 3; owner W1-12). May import `electron`.
import { Menu, nativeImage, Tray } from 'electron';
import { win32 as path } from 'node:path';
import type { AppHealth } from '../../shared/health';
import type { Logger } from '../deps';

/** Serialisable template (no Electron types) so tests and globalThis.__wcaTest can snapshot it. */
export interface TrayMenuItem {
  id: 'open' | 'status' | 'pause' | 'settings' | 'quit' | 'sep';
  label?: string;
  enabled?: boolean;
  type?: 'normal' | 'separator';
}
export interface TrayState {
  health: AppHealth;
  paused: boolean;
  waiting: number; // open items count (tooltip " - N waiting")
  setupDone: boolean;
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
  return 'tray.status.active_local';
}

/** Pure: UX 12.1 (Open / status line disabled / Pause|Resume / Settings / Quit). Never counts of people, never names. */
export function buildTrayTemplate(state: TrayState, t: TFn): TrayMenuItem[] {
  return [
    { id: 'open', label: t('tray.open'), type: 'normal', enabled: true },
    { id: 'status', label: t(trayStatusKey(state)), type: 'normal', enabled: false },
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
}
export interface TrayController {
  tray: Tray;
  rebuild(): void; // on language, pause and health change
  template(): TrayMenuItem[];
  click(id: 'open' | 'pause' | 'settings' | 'quit'): void; // for globalThis.__wcaTest only
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

  const actions: Record<'open' | 'pause' | 'settings' | 'quit', () => void> = {
    open: () => deps.onOpen(),
    pause: () => deps.onTogglePause(),
    settings: () => deps.onSettings(),
    quit: () => deps.onQuit(),
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
                ...(item.id === 'open' || item.id === 'pause' || item.id === 'settings' || item.id === 'quit'
                  ? { click: actions[item.id] }
                  : {}),
              },
        ),
      ),
    );
    log.info('rebuilt', { icon: look.icon, paused: state.paused, waiting: state.waiting });
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
