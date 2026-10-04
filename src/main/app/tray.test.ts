// TESTS 5.3 row `app/tray.ts`: items, order, status line, rebuild on language/pause/health, labels from main i18n in he/en,
// tooltip never contains message text or a contact name.
import { beforeEach, describe, expect, it, vi } from 'vitest';
// The vitest alias maps `electron` to this mock, so production code and this test share one module instance.
import { Menu, resetElectronMock, Tray } from '../../../tests/mocks/electron';
import { buildTrayTemplate, createTray, iconPath, trayIconFor, trayStatusKey, type TFn, type TrayState } from './tray';
import { createMainI18n } from './i18n';
import { createLogger } from '../logger';
import type { AppHealth, BridgeStatus, LlmStatus } from '../../shared/health';
import type { ProviderId } from '../../shared/types';

const NOW = Date.UTC(2026, 8, 21, 9, 0, 0);

function health(
  over: {
    overall?: AppHealth['overall'];
    whatsapp?: BridgeStatus;
    llmState?: LlmStatus;
    provider?: ProviderId;
  } = {},
): AppHealth {
  return {
    overall: over.overall ?? 'ok',
    whatsapp: { state: over.whatsapp ?? 'online', since: NOW },
    llm: {
      state: over.llmState ?? 'ready',
      since: NOW,
      provider: over.provider ?? 'local',
      model: 'tiny',
      quota: null,
    },
    calendar: { state: 'connected', since: NOW, updatesAvailable: true },
    queue: { pending: 0, running: 0 },
    paused: false,
    voice: { state: 'off', since: NOW }, // [V2] C2 3
    auto: { state: 'off', expiresAt: null, pausedReason: null }, // [V2] C2 3
  };
}
function state(over: Partial<TrayState> = {}): TrayState {
  return { health: health(), paused: false, waiting: 0, setupDone: true, ...over };
}

const keyT: TFn = (key, opts) => (opts && 'count' in opts ? `${key}:${String(opts.count)}` : key);

describe('buildTrayTemplate - shape and order (UX 12.1)', () => {
  it('is Open / status / sep / Pause / Settings / sep / Quit', () => {
    expect(buildTrayTemplate(state(), keyT).map((i) => i.id)).toEqual([
      'open',
      'status',
      'sep',
      'pause',
      'settings',
      'sep',
      'quit',
    ]);
  });

  it('the status line is disabled and every action item is enabled', () => {
    const items = buildTrayTemplate(state(), keyT);
    expect(items.find((i) => i.id === 'status')!.enabled).toBe(false);
    for (const id of ['open', 'pause', 'settings', 'quit'] as const) {
      expect(items.find((i) => i.id === id)!.enabled).toBe(true);
    }
  });

  it('Pause becomes Resume when paused', () => {
    expect(buildTrayTemplate(state(), keyT).find((i) => i.id === 'pause')!.label).toBe('tray.pause');
    expect(buildTrayTemplate(state({ paused: true }), keyT).find((i) => i.id === 'pause')!.label).toBe('tray.resume');
  });

  it('has no approvals, no item list and no message text', () => {
    const labels = buildTrayTemplate(state({ waiting: 7 }), keyT)
      .map((i) => i.label ?? '')
      .join('|');
    expect(labels).not.toMatch(/approve|send|reply now|draft/i);
    expect(labels).not.toContain('7');
  });
});

describe('trayStatusKey - precedence', () => {
  it.each([
    ['setup not finished wins over everything', state({ setupDone: false, paused: true }), 'tray.status.setup'],
    [
      'paused wins over offline',
      state({ paused: true, health: health({ whatsapp: 'reconnecting' }) }),
      'tray.status.paused',
    ],
    [
      'whatsapp offline wins over attention',
      state({ health: health({ whatsapp: 'backoff', overall: 'attention' }) }),
      'tray.status.wa_offline',
    ],
    [
      'needs_pairing counts as offline',
      state({ health: health({ whatsapp: 'needs_pairing' }) }),
      'tray.status.wa_offline',
    ],
    ['attention elsewhere', state({ health: health({ overall: 'attention' }) }), 'tray.status.attention'],
    ['active local', state(), 'tray.status.active_local'],
    ['active claude', state({ health: health({ provider: 'claude' }) }), 'tray.status.active_claude'],
    ['active gemini', state({ health: health({ provider: 'gemini' }) }), 'tray.status.active_gemini'],
    ['working is still active', state({ health: health({ overall: 'working' }) }), 'tray.status.active_local'],
  ])('%s', (_n, s, expected) => {
    expect(trayStatusKey(s)).toBe(expected);
    expect(buildTrayTemplate(s, keyT).find((i) => i.id === 'status')!.label).toBe(expected);
  });
});

describe('trayIconFor', () => {
  it.each([
    ['idle', state(), 'tray'],
    ['open items', state({ waiting: 3 }), 'tray-attention'],
    ['attention beats waiting', state({ waiting: 3, health: health({ overall: 'attention' }) }), 'tray-error'],
    [
      'paused beats everything',
      state({ paused: true, waiting: 3, health: health({ overall: 'attention' }) }),
      'tray-paused',
    ],
  ])('%s => %s', (_n, s, icon) => {
    expect(trayIconFor(s, keyT).icon).toBe(icon);
  });

  it('the tooltip carries a count but never text or a name', () => {
    expect(trayIconFor(state(), keyT).tooltip).toBe('tray.tooltip');
    expect(trayIconFor(state({ waiting: 3 }), keyT).tooltip).toBe('tray.tooltipWaiting:3');
  });

  it('renders through the real main i18n in both languages', () => {
    const en = createMainI18n('en');
    const he = createMainI18n('he');
    const tEn: TFn = (k, o) => en.t(k, o);
    const tHe: TFn = (k, o) => he.t(k, o);
    expect(trayIconFor(state({ waiting: 3 }), tEn).tooltip).toBe('WhatsApp Calendar Agent - 3 waiting');
    expect(trayIconFor(state(), tEn).tooltip).toBe('WhatsApp Calendar Agent');
    expect(buildTrayTemplate(state(), tEn).find((i) => i.id === 'open')!.label).toBe('Open');
    const hebrew = buildTrayTemplate(state(), tHe).find((i) => i.id === 'open')!.label!;
    expect(hebrew).not.toBe('Open');
    expect(hebrew).toMatch(/[\u0590-\u05ff]/);
    expect(trayIconFor(state({ waiting: 3 }), tHe).tooltip).toContain('3');
  });

  it('a hostile 200-character push name in the health model never reaches the tooltip', () => {
    const hostile = 'A'.repeat(200);
    const s = state({ waiting: 1, health: { ...health(), llm: { ...health().llm, model: hostile } } });
    const en = createMainI18n('en');
    expect(trayIconFor(s, (k, o) => en.t(k, o)).tooltip).not.toContain('AAAA');
    expect(
      buildTrayTemplate(s, (k, o) => en.t(k, o))
        .map((i) => i.label)
        .join('|'),
    ).not.toContain('AAAA');
  });
});

describe('createTray', () => {
  beforeEach(() => resetElectronMock());

  const setup = (initial: TrayState = state()) => {
    let current = initial;
    let lang: 'en' | 'he' = 'en';
    const en = createMainI18n('en');
    const he = createMainI18n('he');
    const calls = { open: 0, pause: 0, settings: 0, quit: 0 };
    const controller = createTray({
      iconsDir: 'C:\\res\\icons',
      t: () => (k, o) => (lang === 'en' ? en.t(k, o) : he.t(k, o)),
      state: () => current,
      onOpen: () => void calls.open++,
      onTogglePause: () => void calls.pause++,
      onSettings: () => void calls.settings++,
      onQuit: () => void calls.quit++,
      log: createLogger({ logsDir: 'C:\\tmp' }),
    });
    return {
      controller,
      calls,
      setState: (s: TrayState) => {
        current = s;
      },
      setLang: (l: 'en' | 'he') => {
        lang = l;
      },
    };
  };

  it('creates exactly one Tray with the neutral icon and no GUID', () => {
    setup();
    expect(Tray.instances).toHaveLength(1);
    expect(Tray.instances[0]!.icon).toEqual({
      path: iconPath('C:\\res\\icons', 'tray'),
      isEmpty: expect.any(Function),
    });
  });

  it('builds the menu once on creation and once per rebuild', () => {
    const h = setup();
    expect(Menu.built).toHaveLength(1);
    h.controller.rebuild();
    expect(Menu.built).toHaveLength(2);
  });

  it('left click and double click open the window', () => {
    const h = setup();
    Tray.instances[0]!.emit('click');
    Tray.instances[0]!.emit('double-click');
    expect(h.calls.open).toBe(2);
  });

  it('menu clicks reach the injected callbacks', () => {
    const h = setup();
    const built = Menu.built[0]!;
    built.find((i) => i.id === 'open')!.click!();
    built.find((i) => i.id === 'pause')!.click!();
    built.find((i) => i.id === 'settings')!.click!();
    built.find((i) => i.id === 'quit')!.click!();
    expect(h.calls).toEqual({ open: 1, pause: 1, settings: 1, quit: 1 });
  });

  it('the disabled status item carries no click handler', () => {
    setup();
    expect(Menu.built[0]!.find((i) => i.id === 'status')!.click).toBeUndefined();
    expect(Menu.built[0]!.filter((i) => i.type === 'separator')).toHaveLength(2);
  });

  it('click(id) - the __wcaTest hook - runs the same actions', () => {
    const h = setup();
    h.controller.click('pause');
    h.controller.click('quit');
    expect(h.calls).toMatchObject({ pause: 1, quit: 1 });
  });

  it('rebuilds on a pause change, swapping the icon and the label', () => {
    const h = setup();
    h.setState(state({ paused: true }));
    h.controller.rebuild();
    expect(Tray.instances[0]!.icon).toEqual({
      path: iconPath('C:\\res\\icons', 'tray-paused'),
      isEmpty: expect.any(Function),
    });
    expect(h.controller.template().find((i) => i.id === 'pause')!.label).toBe('Resume processing');
  });

  it('rebuilds on a health change (tooltip + icon)', () => {
    const h = setup();
    h.setState(state({ waiting: 2 }));
    h.controller.rebuild();
    expect(Tray.instances[0]!.tooltip).toBe('WhatsApp Calendar Agent - 2 waiting');
    expect(Tray.instances[0]!.icon).toEqual({
      path: iconPath('C:\\res\\icons', 'tray-attention'),
      isEmpty: expect.any(Function),
    });
  });

  it('rebuilds on a language change', () => {
    const h = setup();
    expect(h.controller.template().find((i) => i.id === 'quit')!.label).toBe('Quit');
    h.setLang('he');
    h.controller.rebuild();
    expect(h.controller.template().find((i) => i.id === 'quit')!.label).toMatch(/[\u0590-\u05ff]/);
  });

  it('does not reload the image when the icon did not change', () => {
    const h = setup();
    const spy = vi.spyOn(Tray.instances[0]!, 'setImage');
    h.controller.rebuild();
    expect(spy).not.toHaveBeenCalled();
  });

  it('template() returns a copy - a caller cannot mutate the tray state', () => {
    const h = setup();
    const t1 = h.controller.template();
    t1[0]!.label = 'hacked';
    expect(h.controller.template()[0]!.label).toBe('Open');
  });

  it('destroy() is idempotent', () => {
    const h = setup();
    h.controller.destroy();
    h.controller.destroy();
    expect(Tray.instances[0]!.isDestroyed()).toBe(true);
  });
});
