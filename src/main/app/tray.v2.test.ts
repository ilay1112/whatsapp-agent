// src/main/app/tray.v2.test.ts - T2 5 row app/tray.ts v2 (UX2 2.4, B11): the automatic-mode line exists ONLY while a policy is live
// (shadow | on | paused), its label is app copy, a click pauses (on) / stops (trial) without a dialog or opens Settings (paused), and
// the CLI providers get their own status line. Never a title, a name or a reason text.
import { beforeEach, describe, expect, it } from 'vitest';
import { Menu, resetElectronMock } from '../../../tests/mocks/electron';
import { autoTrayAction, buildTrayTemplate, createTray, trayStatusKey, type TFn, type TrayState } from './tray';
import { createMainI18n } from './i18n';
import { createLogger } from '../logger';
import type { AppHealth } from '../../shared/health';
import type { AutoPolicyState, ProviderId } from '../../shared/types';

const NOW = Date.UTC(2026, 9, 5, 7, 0, 0);
function health(provider: ProviderId = 'local'): AppHealth {
  return {
    overall: 'ok',
    whatsapp: { state: 'online', since: NOW },
    llm: { state: 'ready', since: NOW, provider, model: 'm', quota: null },
    calendar: { state: 'connected', since: NOW, updatesAvailable: true },
    queue: { pending: 0, running: 0 },
    paused: false,
    voice: { state: 'off', since: NOW },
    auto: { state: 'off', expiresAt: null, pausedReason: null },
  };
}
const state = (auto: AutoPolicyState | null, provider: ProviderId = 'local'): TrayState => ({
  health: health(provider),
  paused: false,
  waiting: 0,
  setupDone: true,
  auto: auto === null ? null : { state: auto, pausedReason: auto === 'paused' ? 'user' : null },
});
const en = createMainI18n('en');
const he = createMainI18n('he');
const tEn: TFn = (k, o) => en.t(k, o);
const tHe: TFn = (k, o) => he.t(k, o);

describe('buildTrayTemplate - the automatic-mode line', () => {
  it('absent without a policy and for ended ones (disabled / expired)', () => {
    for (const s of [null, 'disabled', 'expired'] as const) {
      expect(buildTrayTemplate(state(s), tEn).map((i) => i.id)).not.toContain('autoPause');
    }
    const noField: TrayState = { health: health(), paused: false, waiting: 0, setupDone: true };
    expect(buildTrayTemplate(noField, tEn).map((i) => i.id)).not.toContain('autoPause');
  });
  it('present right under the status line for shadow / on / paused, with the UX2 2.4 copy in both locales', () => {
    const expected: Record<'on' | 'shadow' | 'paused', [string, string]> = {
      on: ['Automatic mode: on - click to pause', 'מצב אוטומטי: פועל - לחיצה להשהיה'],
      shadow: ['Automatic mode: trial - click to stop', 'מצב אוטומטי: ניסיון - לחיצה לעצירה'],
      paused: ['Automatic mode: paused - open to resume', 'מצב אוטומטי: מושהה - פתיחה להמשך'],
    };
    for (const s of ['on', 'shadow', 'paused'] as const) {
      const tpl = buildTrayTemplate(state(s), tEn);
      expect(tpl.map((i) => i.id).slice(0, 4)).toEqual(['open', 'status', 'autoPause', 'sep']);
      expect(tpl[2]).toEqual({ id: 'autoPause', label: expected[s][0], type: 'normal', enabled: true });
      expect(buildTrayTemplate(state(s), tHe)[2]!.label).toBe(expected[s][1]);
    }
  });
  it('the click action per state: on => pause, shadow => disable, paused => open', () => {
    expect(autoTrayAction('on')).toBe('pause');
    expect(autoTrayAction('shadow')).toBe('disable');
    expect(autoTrayAction('paused')).toBe('open');
  });
});

describe('trayStatusKey - the CLI providers (UX2 2.4)', () => {
  it('claude_cli / antigravity_cli have their own status line', () => {
    expect(trayStatusKey(state(null, 'claude_cli'))).toBe('tray.status.active_claude_cli');
    expect(trayStatusKey(state(null, 'antigravity_cli'))).toBe('tray.status.active_antigravity_cli');
    expect(tEn(trayStatusKey(state(null, 'claude_cli')))).toBe('Active - Claude (your subscription)');
  });
});

describe('createTray - the autoPause item', () => {
  beforeEach(() => resetElectronMock());
  const setup = (initial: TrayState, withHandler = true) => {
    let current = initial;
    const autoCalls: string[] = [];
    const controller = createTray({
      iconsDir: 'C:\\res\\icons',
      t: () => tEn,
      state: () => current,
      onOpen: () => undefined,
      onTogglePause: () => undefined,
      onSettings: () => undefined,
      onQuit: () => undefined,
      log: createLogger({ logsDir: 'C:\\tmp' }),
      ...(withHandler ? { onAuto: (a: 'pause' | 'disable' | 'open') => void autoCalls.push(a) } : {}),
    });
    return { controller, autoCalls, set: (s: TrayState) => (current = s) };
  };
  it('a click pauses an on policy from main (no window, no dialog); trial => disable; paused => open', () => {
    const h = setup(state('on'));
    Menu.built.at(-1)!.find((i) => i.id === 'autoPause')!.click!();
    h.set(state('shadow'));
    h.controller.rebuild();
    h.controller.click('autoPause');
    h.set(state('paused'));
    h.controller.click('autoPause');
    expect(h.autoCalls).toEqual(['pause', 'disable', 'open']);
  });
  it('a click after the policy ended does nothing; without a handler the line does nothing', () => {
    const h = setup(state('on'));
    h.set(state(null));
    h.controller.click('autoPause');
    expect(h.autoCalls).toEqual([]);
    const h2 = setup(state('on'), false);
    expect(() => h2.controller.click('autoPause')).not.toThrow();
  });
  it('the template snapshot for __wcaTest carries the line', () => {
    const h = setup(state('paused'));
    expect(h.controller.template().map((i) => i.id)).toContain('autoPause');
  });
});
