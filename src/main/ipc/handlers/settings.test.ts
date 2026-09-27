// TESTS 5.3 `ipc/*`: settings:set accepts ONLY SettingsPatchSchema (the strict parse lives in register.ts) and additionally
// refuses a calendar id Google never listed. The language / tray / autostart side effects run through SettingsBus.onChange.
import { describe, expect, it } from 'vitest';
import { SettingsPatchSchema } from '../../../shared/settings';
import type { CalendarInfo } from '../../../shared/types';
import { makeFixture, NOW_0 } from '../register.fixtures';
import { calendarIdsIn, createSettingsHandlers } from './settings';

const CTX = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };

const CALENDARS: CalendarInfo[] = [
  { id: 'primary', name: 'Personal', primary: true, timeZone: 'Asia/Jerusalem', writable: true },
  { id: 'work@group.calendar.google.com', name: 'Work', primary: false, timeZone: 'Asia/Jerusalem', writable: true },
];

function fixtureWithCalendars(
  listed: { ok: true; value: CalendarInfo[] } | { ok: false; error: { code: 'CAL_UNAVAILABLE' } },
): ReturnType<typeof makeFixture> {
  const f = makeFixture();
  f.deps.googleAuth.listCalendars = async () => listed;
  return f;
}

describe('settings:get', () => {
  it('returns the current settings', async () => {
    const f = makeFixture();
    const res = await createSettingsHandlers(f.deps)['settings:get'](undefined, CTX);
    expect(res.ok && res.value.privacy.retentionDays).toBe(30);
  });
});

describe('settings:set', () => {
  it('applies an allow-listed patch and audits the changed groups only (no values)', async () => {
    const f = makeFixture();
    const res = await createSettingsHandlers(f.deps)['settings:set'](
      { general: { language: 'he' }, privacy: { retentionDays: 7 } },
      CTX,
    );
    expect(res.ok && res.value.general.language).toBe('he');
    expect(res.ok && res.value.privacy.retentionDays).toBe(7);
    expect(f.state.settings.general.language).toBe('he');
    expect(f.rec.audits).toEqual([
      { kind: 'settings_changed', ref: null, detail: { groups: 'general,privacy' }, now: NOW_0 },
    ]);
  });

  it('[R2] the fields main owns are not members of the patch schema at all', () => {
    // register.ts strict-parses with this schema, so these never reach the handler.
    expect(SettingsPatchSchema.safeParse({ general: { timeZone: 'Europe/Paris' } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ llm: { provider: 'claude' } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ agent: { paused: true } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ llm: { local: { forceCpu: true } } }).success).toBe(false);
  });

  it("'primary' needs no round trip to Google", async () => {
    const f = fixtureWithCalendars({ ok: false, error: { code: 'CAL_UNAVAILABLE' } });
    const res = await createSettingsHandlers(f.deps)['settings:set'](
      { calendar: { targetCalendarId: 'primary', conflictCalendarIds: ['primary'] } },
      CTX,
    );
    expect(res.ok).toBe(true);
  });

  it('accepts a calendar id Google listed', async () => {
    const f = fixtureWithCalendars({ ok: true, value: CALENDARS });
    const res = await createSettingsHandlers(f.deps)['settings:set'](
      {
        calendar: {
          targetCalendarId: 'work@group.calendar.google.com',
          conflictCalendarIds: ['primary', 'work@group.calendar.google.com'],
        },
      },
      CTX,
    );
    expect(res.ok).toBe(true);
    expect(f.state.settings.calendar.targetCalendarId).toBe('work@group.calendar.google.com');
  });

  it('refuses an id Google never listed, and writes nothing', async () => {
    const f = fixtureWithCalendars({ ok: true, value: CALENDARS });
    const res = await createSettingsHandlers(f.deps)['settings:set'](
      { calendar: { targetCalendarId: 'attacker@evil.example' } },
      CTX,
    );
    expect(res).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(f.state.settings.calendar.targetCalendarId).toBe('primary');
    expect(f.rec.audits).toEqual([]);
  });

  it('refuses a non-default id when the calendar list cannot be fetched', async () => {
    const f = fixtureWithCalendars({ ok: false, error: { code: 'CAL_UNAVAILABLE' } });
    const res = await createSettingsHandlers(f.deps)['settings:set'](
      { calendar: { conflictCalendarIds: ['work@group.calendar.google.com'] } },
      CTX,
    );
    expect(res).toEqual({ ok: false, error: { code: 'CAL_RECONNECT' } });
  });

  it('a patch the MERGED schema rejects is BAD_REQUEST, not a crash', async () => {
    const f = makeFixture();
    f.deps.settings.patch = () => {
      throw new Error('SettingsSchema.parse failed');
    };
    const res = await createSettingsHandlers(f.deps)['settings:set']({ privacy: { retentionDays: 7 } }, CTX);
    expect(res).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
  });

  it('the handler itself performs NO side effect - language, tray and autostart hang off SettingsBus.onChange', async () => {
    const f = makeFixture();
    let subscribed = 0;
    f.deps.settings.onChange = () => {
      subscribed += 1;
      return () => {};
    };
    const res = await createSettingsHandlers(f.deps)['settings:set'](
      { general: { language: 'he', autostart: true } },
      CTX,
    );
    expect(res.ok).toBe(true);
    // The write happened...
    expect(f.state.settings.general).toMatchObject({ language: 'he', autostart: true });
    // ...but nothing was pushed at the OS from here: compose.ts owns the subscription, so the handler stays logic-free.
    expect(f.rec.notifications).toEqual([]);
    expect(f.rec.opened).toEqual([]);
    expect(subscribed).toBe(0);
  });

  it('an empty patch is a no-op that still returns the settings', async () => {
    const f = makeFixture();
    const res = await createSettingsHandlers(f.deps)['settings:set']({}, CTX);
    expect(res.ok && res.value).toEqual(f.state.settings);
    expect(f.rec.audits[0]?.detail).toEqual({ groups: '' });
  });
});

describe('calendarIdsIn', () => {
  it('collects both fields, de-duplicates and drops the always-allowed default', () => {
    expect(calendarIdsIn({})).toEqual([]);
    expect(calendarIdsIn({ calendar: { targetCalendarId: 'primary' } })).toEqual([]);
    expect(calendarIdsIn({ calendar: { targetCalendarId: 'a', conflictCalendarIds: ['a', 'primary', 'b'] } })).toEqual([
      'a',
      'b',
    ]);
  });
});
