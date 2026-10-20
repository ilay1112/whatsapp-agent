// C2 19 item 14 (V2-W0-scaffold): SETTINGS_V2_ADDED == the json_insert values of migration v4; a v1 settings row completed by those
// values parses with the v2 SettingsSchema; SettingsPatchSchema refuses every channel-only key (F11).
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../main/db/migrations';
import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  SETTINGS_V2_ADDED,
  SettingsPatchSchema,
  SettingsSchema,
  THEMES,
  type Settings,
} from './settings';

/** The v1 settings row as v1 wrote it (synthetic; DEFAULT_SETTINGS of v0.1.0). */
const V1_ROW = {
  general: { language: 'system', autostart: false, timeZone: 'Asia/Jerusalem', notifications: 'generic' },
  llm: {
    provider: 'local',
    claudeModel: 'claude-opus-5',
    geminiModel: 'gemini-3.8-flash',
    local: { tier: 'auto', acceleration: 'auto', forceCpu: false },
    cloudDailyTokenBudget: 200_000,
  },
  whatsapp: { processUnknownSenders: false, backlogHours: 0 },
  calendar: { targetCalendarId: 'primary', conflictCalendarIds: ['primary'], defaultDurationMin: 60 },
  agent: { paused: false, ambiguousHour: 'assume', userGender: 'unspecified' },
  privacy: { retentionDays: 30 },
};

/** The four `'$.path', json('...')` pairs of the v4 settings data step. */
function jsonInsertValues(): Record<string, unknown> {
  const v4 = MIGRATIONS.find((m) => m.version === 4)!.sql;
  const step = v4.slice(v4.indexOf('UPDATE settings SET value_json = json_insert('));
  const out: Record<string, unknown> = {};
  for (const m of step.matchAll(/'\$\.([a-zA-Z.]+)',\s*json\('([^']*)'\)/g)) out[m[1]!] = JSON.parse(m[2]!);
  return out;
}

describe('SETTINGS_V2_ADDED (C2 19 item 14)', () => {
  it('equals the json_insert values of migration v4, key by key', () => {
    expect(jsonInsertValues()).toEqual(SETTINGS_V2_ADDED);
  });

  it('equals the new groups of DEFAULT_SETTINGS', () => {
    expect(SETTINGS_V2_ADDED).toEqual({
      'llm.cli': DEFAULT_SETTINGS.llm.cli,
      'whatsapp.readTools': DEFAULT_SETTINGS.whatsapp.readTools,
      voice: DEFAULT_SETTINGS.voice,
      images: DEFAULT_SETTINGS.images,
    });
  });

  it('a v1 row completed by the migration values parses, and a patch round-trips through applySettingsPatch', () => {
    const upgraded = structuredClone(V1_ROW) as unknown as Record<string, Record<string, unknown>>;
    for (const [path, value] of Object.entries(SETTINGS_V2_ADDED)) {
      const [group, key] = path.split('.');
      if (key === undefined) upgraded[group!] = structuredClone(value) as Record<string, unknown>;
      else upgraded[group!]![key] = structuredClone(value);
    }
    const parsed: Settings = SettingsSchema.parse(upgraded);
    expect(parsed).toEqual(DEFAULT_SETTINGS);
    const patched = applySettingsPatch(parsed, {
      llm: { cli: { maxRunsPerHour: 5 } },
      whatsapp: { readTools: { windowDays: 7 } },
    });
    expect(patched.llm.cli).toEqual({ ...DEFAULT_SETTINGS.llm.cli, maxRunsPerHour: 5 });
    expect(patched.whatsapp.readTools).toEqual({ ...DEFAULT_SETTINGS.whatsapp.readTools, windowDays: 7 });
  });

  it('the v1 row alone does NOT parse (the data step is required, C2 concerns #11)', () => {
    expect(SettingsSchema.safeParse(V1_ROW).success).toBe(false);
  });

  it.each([
    ['auto', { auto: { on: true } }],
    ['llm.provider', { llm: { provider: 'claude' } }],
    ['llm.cli.claudeExePath', { llm: { cli: { claudeExePath: 'C:\\x\\claude.exe' } } }],
    ['llm.cli.allowOverage', { llm: { cli: { allowOverage: true } } }],
    ['whatsapp.readTools.scope', { whatsapp: { readTools: { scope: 'all_chats' } } }],
  ])('SettingsPatchSchema rejects %s', (_name, patch) => {
    expect(SettingsPatchSchema.safeParse(patch).success).toBe(false);
  });

  it('ClaudeExePathSchema (F7) accepts only \\claude.exe paths without shell metacharacters or .. segments', () => {
    const exe = SettingsSchema.shape.llm.shape.cli.shape.claudeExePath;
    expect(exe.safeParse('').success).toBe(true);
    expect(exe.safeParse('C:\\Users\\u\\.local\\bin\\claude.exe').success).toBe(true);
    expect(exe.safeParse('C:\\Users\\u\\.local\\bin\\claude.cmd').success).toBe(false);
    expect(exe.safeParse('C:\\a&b\\claude.exe').success).toBe(false);
    expect(exe.safeParse('C:\\a\\..\\claude.exe').success).toBe(false);
    expect(exe.safeParse('"C:\\a\\claude.exe"').success).toBe(false);
  });
});

// [V4] T-908 T1 (spec v4-calendar-handover 2.3): general.theme - 'system' by default, patchable through settings:set with exactly
// the three values, and a row stored BEFORE the key existed still parses (the repo falls back to DEFAULT_SETTINGS on a parse
// failure, which would silently drop every other choice the user made).
describe('[v4] general.theme', () => {
  it("defaults to 'system'", () => {
    expect(DEFAULT_SETTINGS.general.theme).toBe('system');
    expect(THEMES).toEqual(['system', 'light', 'dark']);
  });

  it.each(THEMES)('the patch schema accepts %s and applySettingsPatch stores it', (theme) => {
    expect(SettingsPatchSchema.safeParse({ general: { theme } }).success).toBe(true);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { general: { theme } }).general.theme).toBe(theme);
  });

  it.each(['auto', 'Dark', '', null, 1])('the patch schema rejects %j', (theme) => {
    expect(SettingsPatchSchema.safeParse({ general: { theme } }).success).toBe(false);
  });

  it("a stored row without the key parses as 'system' and keeps the user's other values", () => {
    const stored = structuredClone(DEFAULT_SETTINGS) as Record<string, Record<string, unknown>>;
    delete stored.general!.theme;
    stored.general!.language = 'he';
    const parsed = SettingsSchema.safeParse(stored);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.general.theme).toBe('system');
    expect(parsed.data?.general.language).toBe('he');
  });

  it('a stored row with an unknown theme does not parse', () => {
    const stored = structuredClone(DEFAULT_SETTINGS) as Record<string, Record<string, unknown>>;
    stored.general!.theme = 'sepia';
    expect(SettingsSchema.safeParse(stored).success).toBe(false);
  });
});
