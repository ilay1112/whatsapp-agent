// TESTS 5.3 `ipc/*`: app/bootstrap/consent/clipboard/external channels. The external:open rows are the [R2] ones -
// only enum targets, and `calendarEvent` opens a URL BUILT IN MAIN, never the stored htmlLink.
import { describe, expect, it } from 'vitest';
import links from '../../../../resources/links.json';
import { EXTERNAL_TARGETS, type ExternalTarget } from '../../../shared/ipc';
import { CONSENT_VERSIONS, LIMITS } from '../../../shared/types';
import { fixtureItem, makeFixture, NOW_0 } from '../register.fixtures';
import { calendarDayUrl, CALENDAR_DAY_URL_PREFIX, createAppHandlers } from './app';

const CTX = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };

describe('app:getBootstrap', () => {
  it('paints the first frame from one call', async () => {
    const f = makeFixture();
    f.state.meta.set('tray_hint_seen', '1');
    const res = await createAppHandlers(f.deps)['app:getBootstrap'](undefined, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.lang).toBe('en');
    expect(res.value.dir).toBe('ltr');
    expect(res.value.onboardingStep).toBe('welcome');
    expect(res.value.version).toBe('1.0.0-test');
    expect(res.value.trayHintSeen).toBe(true);
    expect(res.value.settingsPublic.general.timeZone).toBe('Asia/Jerusalem');
    expect(res.value.health.overall).toBeDefined();
    // Settings carries no secret: the key status lives on llm:getConfig only.
    expect(JSON.stringify(res.value.settingsPublic)).not.toMatch(/api_key|sk-ant/i);
  });

  it("language 'system' follows the OS list and flips dir to rtl for Hebrew (including the legacy 'iw' tag)", async () => {
    for (const [preferred, lang, dir] of [
      [['he-IL', 'en-US'], 'he', 'rtl'],
      [['iw'], 'he', 'rtl'],
      [['fr-FR'], 'en', 'ltr'],
    ] as const) {
      const f = makeFixture();
      f.deps.electron.preferredLanguages = () => [...preferred];
      const res = await createAppHandlers(f.deps)['app:getBootstrap'](undefined, CTX);
      expect(res.ok && res.value.lang, preferred.join()).toBe(lang);
      expect(res.ok && res.value.dir, preferred.join()).toBe(dir);
    }
  });

  it('an explicit language setting wins over the OS list', async () => {
    const f = makeFixture();
    f.state.settings.general.language = 'he';
    f.deps.electron.preferredLanguages = () => ['en-US'];
    const res = await createAppHandlers(f.deps)['app:getBootstrap'](undefined, CTX);
    expect(res.ok && res.value.lang).toBe('he');
  });

  it('trayHintSeen is false until app:ackTrayHint writes the meta row', async () => {
    const f = makeFixture();
    const h = createAppHandlers(f.deps);
    expect((await h['app:getBootstrap'](undefined, CTX)).ok && f.state.meta.get('tray_hint_seen')).toBeUndefined();
    expect(await h['app:ackTrayHint'](undefined, CTX)).toEqual({ ok: true, value: null });
    expect(f.state.meta.get('tray_hint_seen')).toBe('1');
    const res = await h['app:getBootstrap'](undefined, CTX);
    expect(res.ok && res.value.trayHintSeen).toBe(true);
  });
});

describe('health:get / agent:setPaused', () => {
  it('returns the hub snapshot', async () => {
    const f = makeFixture();
    const res = await createAppHandlers(f.deps)['health:get'](undefined, CTX);
    expect(res.ok && res.value.paused).toBe(false);
  });

  it('pausing writes the setting, pauses the queue and shows up in health', async () => {
    const paused: boolean[] = [];
    const f = makeFixture();
    f.deps.queue.setPaused = (b) => {
      paused.push(b);
    };
    const res = await createAppHandlers(f.deps)['agent:setPaused']({ paused: true }, CTX);
    expect(res.ok && res.value.paused).toBe(true);
    expect(f.state.settings.agent.paused).toBe(true);
    expect(paused).toEqual([true]);
    expect(f.deps.healthHub.get().paused).toBe(true);
  });
});

describe('clipboard:writeText', () => {
  it('writes through the facade and caps the length a second time', async () => {
    const f = makeFixture();
    const h = createAppHandlers(f.deps);
    await h['clipboard:writeText']({ text: 'copy me' }, CTX);
    await h['clipboard:writeText']({ text: 'x'.repeat(LIMITS.clipboardChars + 500) }, CTX);
    expect(f.rec.clipboard[0]).toBe('copy me');
    expect(f.rec.clipboard[1]).toHaveLength(LIMITS.clipboardChars);
  });
});

// Hot-spot protocol (build-plan 1.2): `resources/links.json` is owned by W1-13 and its keys must EQUAL EXTERNAL_TARGETS.
// An extra key would be a destination no enum can name (dead weight); a missing one makes a UI link silently do nothing.
describe('resources/links.json parity', () => {
  const table = links as Record<string, string>;

  it('holds exactly the EXTERNAL_TARGETS keys, no more and no fewer', () => {
    expect(Object.keys(table).sort()).toEqual([...EXTERNAL_TARGETS].sort());
  });

  it('every entry is an absolute https URL with no credentials and no renderer-supplied part', () => {
    for (const [key, url] of Object.entries(table)) {
      const parsed = new URL(url);
      expect(parsed.protocol, key).toBe('https:');
      expect(parsed.username + parsed.password, key).toBe('');
      expect(url.startsWith('https://'), key).toBe(true);
    }
  });

  it('[R2] vcredist_download points at the Microsoft redirector, not at a mirror', () => {
    expect(table['vcredist_download']).toBe('https://aka.ms/vs/17/release/vc_redist.x64.exe');
  });
});

describe('external:open - enum targets', () => {
  it('opens exactly the https URL resources/links.json holds, for every EXTERNAL_TARGET', async () => {
    const f = makeFixture({ links: links as Record<string, string> });
    const h = createAppHandlers(f.deps);
    for (const target of EXTERNAL_TARGETS) {
      expect(await h['external:open']({ target }, CTX), target).toEqual({ ok: true, value: null });
    }
    expect(f.rec.opened).toEqual(EXTERNAL_TARGETS.map((t) => (links as Record<string, string>)[t]));
    expect(f.rec.opened.every((u) => u.startsWith('https://'))).toBe(true);
  });

  it('a missing or non-https entry opens nothing', async () => {
    const f = makeFixture({
      links: {
        project_readme: 'http://insecure.example/',
        antivirus_help: 'javascript:alert(1)',
        bridge_update_help: 'file:///C:/x',
      },
    });
    const h = createAppHandlers(f.deps);
    for (const target of [
      'project_readme',
      'antivirus_help',
      'bridge_update_help',
      'bitlocker_help',
    ] as ExternalTarget[]) {
      expect(await h['external:open']({ target }, CTX), target).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
    }
    expect(f.rec.opened).toEqual([]);
  });
});

describe('external:open - [R2] calendarEvent is built in main', () => {
  const HTML_LINK_BYPASSES = [
    'https://www-google.com/calendar/x',
    'https://wwwXgoogle.com/',
    'https://www.google.com/url?q=https://evil.example',
    'https://calendar.google.com@evil.example/',
  ];

  it('opens the day URL derived from event_start_ts and never the stored htmlLink', async () => {
    for (const calendarHtmlLink of HTML_LINK_BYPASSES) {
      const f = makeFixture();
      f.state.items.set(1, fixtureItem({ calendarHtmlLink, eventStartTs: Date.UTC(2026, 8, 24, 9, 0, 0) }));
      const res = await createAppHandlers(f.deps)['external:open']({ itemId: 1, target: 'calendarEvent' }, CTX);
      expect(res).toEqual({ ok: true, value: null });
      expect(f.rec.opened).toEqual([`${CALENDAR_DAY_URL_PREFIX}/2026/09/24`]);
      expect(f.rec.opened[0]).not.toContain('evil.example');
      expect(f.rec.opened[0]).not.toBe(calendarHtmlLink);
    }
  });

  it('uses the app time zone, not UTC, to pick the day', async () => {
    const lateEvening = Date.UTC(2026, 8, 24, 21, 30, 0); // 00:30 the next day in Jerusalem
    for (const [timeZone, expected] of [
      ['Asia/Jerusalem', '/2026/09/25'],
      ['UTC', '/2026/09/24'],
      ['Pacific/Honolulu', '/2026/09/24'],
    ] as const) {
      const f = makeFixture();
      f.state.settings.general.timeZone = timeZone;
      f.state.items.set(1, fixtureItem({ eventStartTs: lateEvening }));
      await createAppHandlers(f.deps)['external:open']({ itemId: 1, target: 'calendarEvent' }, CTX);
      expect(f.rec.opened[0], timeZone).toBe(`${CALENDAR_DAY_URL_PREFIX}${expected}`);
    }
  });

  it('NOT_FOUND for an unknown item or one without an event start, and INTERNAL for an unusable zone', async () => {
    const f = makeFixture();
    const h = createAppHandlers(f.deps);
    expect(await h['external:open']({ itemId: 99, target: 'calendarEvent' }, CTX)).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });

    f.state.items.set(2, fixtureItem({ id: 2, eventStartTs: null }));
    expect(await h['external:open']({ itemId: 2, target: 'calendarEvent' }, CTX)).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });

    f.state.items.set(3, fixtureItem({ id: 3 }));
    f.state.settings.general.timeZone = 'Not/AZone';
    expect(await h['external:open']({ itemId: 3, target: 'calendarEvent' }, CTX)).toEqual({
      ok: false,
      error: { code: 'INTERNAL' },
    });
    expect(f.rec.opened).toEqual([]);
  });

  it('calendarDayUrl is pure and zero-pads', () => {
    expect(calendarDayUrl(Date.UTC(2026, 0, 3, 12, 0, 0), 'UTC')).toBe(`${CALENDAR_DAY_URL_PREFIX}/2026/01/03`);
    expect(calendarDayUrl(NOW_0, 'Mars/Olympus')).toBeNull();
  });
});

describe('onboarding:*', () => {
  it('reads and advances the step', async () => {
    const f = makeFixture();
    const h = createAppHandlers(f.deps);
    expect((await h['onboarding:getState'](undefined, CTX)).ok).toBe(true);
    const res = await h['onboarding:setStep']({ step: 'link_whatsapp' }, CTX);
    expect(res.ok && res.value.step).toBe('link_whatsapp');
    const again = await h['onboarding:getState'](undefined, CTX);
    expect(again.ok && again.value.step).toBe('link_whatsapp');
  });
});

describe('consent:get / consent:accept', () => {
  it('reports the current version and no acceptance before the user accepts', async () => {
    const f = makeFixture();
    const res = await createAppHandlers(f.deps)['consent:get']({ kind: 'whatsapp_tos' }, CTX);
    expect(res).toEqual({
      ok: true,
      value: {
        kind: 'whatsapp_tos',
        currentVersion: CONSENT_VERSIONS.whatsapp_tos,
        acceptedVersion: null,
        acceptedAt: null,
      },
    });
  });

  it('accepting the current version records it and audits `consent`', async () => {
    const f = makeFixture();
    const res = await createAppHandlers(f.deps)['consent:accept'](
      { kind: 'cloud_claude', version: CONSENT_VERSIONS.cloud_claude },
      CTX,
    );
    expect(res.ok && res.value.acceptedVersion).toBe(CONSENT_VERSIONS.cloud_claude);
    expect(res.ok && res.value.acceptedAt).toBe(NOW_0);
    expect(f.rec.audits).toEqual([{ kind: 'consent', ref: 'cloud_claude', detail: { version: 1 }, now: NOW_0 }]);
  });

  it('[R2] rejects any version other than the current one with BAD_REQUEST + audit ipc_rejected', async () => {
    for (const version of [999, CONSENT_VERSIONS.cloud_gemini + 1, 1000000]) {
      const f = makeFixture();
      const res = await createAppHandlers(f.deps)['consent:accept']({ kind: 'cloud_gemini', version }, CTX);
      expect(res.ok, String(version)).toBe(false);
      expect(res).toEqual({ ok: false, error: { code: 'BAD_REQUEST', params: { kind: 'cloud_gemini', version: 1 } } });
      expect(f.state.consents.size).toBe(0);
      expect(f.rec.audits).toEqual([
        {
          kind: 'ipc_rejected',
          ref: 'consent:accept',
          detail: { kind: 'cloud_gemini', sent: version, current: 1 },
          now: NOW_0,
        },
      ]);
    }
  });
});
