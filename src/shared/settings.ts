// src/shared/settings.ts
import { z } from 'zod';

export const SettingsSchema = z.strictObject({
  general: z.strictObject({
    language: z.enum(['system', 'en', 'he']),
    autostart: z.boolean(),
    timeZone: z.string().min(1).max(64), // IANA. [R2] READ-ONLY for the user: main sets it from Intl.DateTimeFormat().resolvedOptions().timeZone
    // at start and on every 'resume'/ONLINE; validated with Intl.supportedValuesOf('timeZone'). No picker in v1.
    notifications: z.enum(['off', 'generic']), // never message text ; [R2] 'with_name' cut (push names are attacker-chosen)
  }),
  llm: z.strictObject({
    provider: z.enum(['local', 'claude', 'gemini']),
    claudeModel: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._-]+$/),
    geminiModel: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._-]+$/)
      .refine((s) => !s.endsWith('-latest'), 'no -latest aliases'),
    local: z.strictObject({
      tier: z.enum(['auto', 'tiny', 'small', 'mid']),
      acceleration: z.enum(['auto', 'off']),
      forceCpu: z.boolean(),
    }),
    cloudDailyTokenBudget: z.number().int().min(10_000).max(5_000_000),
  }),
  whatsapp: z.strictObject({ processUnknownSenders: z.boolean(), backlogHours: z.number().int().min(0).max(72) }),
  calendar: z.strictObject({
    targetCalendarId: z.string().min(1).max(256),
    conflictCalendarIds: z.array(z.string().min(1).max(256)).min(1).max(10),
    defaultDurationMin: z.number().int().min(5).max(720), // [R2] shareTitlesWithAi removed with the list_events tool
  }),
  agent: z.strictObject({
    paused: z.boolean(),
    ambiguousHour: z.enum(['assume', 'ask']),
    userGender: z.enum(['m', 'f', 'unspecified']),
  }),
  privacy: z.strictObject({ retentionDays: z.number().int().min(7).max(90) }),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
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
/** [R2] UI ORDERING HINTS ONLY - never rendered as-is. The renderer intersects them with the live `llm:listModels` result and hides absent ids
 *  (ARCHITECTURE section 8: "never a hard-coded list"). `claude-haiku-4-5` dropped (expected to retire after 2026-10-15). */
export const CLAUDE_MODEL_PRESETS = ['claude-opus-5', 'claude-sonnet-5'] as const;
export const GEMINI_MODEL_PRESETS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite'] as const;

/** settings:set request: any subset of any group. NOT settable through settings:set (dedicated channels enforce preconditions):
 *  llm.provider (llm:setProvider), agent.paused (agent:setPaused), llm.local.forceCpu (main only), general.timeZone (main only) [R2]. The handler rejects them with BAD_REQUEST. */
export const SettingsPatchSchema = z
  .strictObject({
    general: z
      .strictObject({
        language: z.enum(['system', 'en', 'he']),
        autostart: z.boolean(),
        notifications: z.enum(['off', 'generic']),
      })
      .partial(),
    llm: z
      .strictObject({
        claudeModel: SettingsSchema.shape.llm.shape.claudeModel,
        geminiModel: SettingsSchema.shape.llm.shape.geminiModel,
        local: z
          .strictObject({ tier: z.enum(['auto', 'tiny', 'small', 'mid']), acceleration: z.enum(['auto', 'off']) })
          .partial(),
        cloudDailyTokenBudget: SettingsSchema.shape.llm.shape.cloudDailyTokenBudget,
      })
      .partial(),
    whatsapp: SettingsSchema.shape.whatsapp.partial(),
    calendar: SettingsSchema.shape.calendar.partial(),
    agent: z
      .strictObject({ ambiguousHour: z.enum(['assume', 'ask']), userGender: z.enum(['m', 'f', 'unspecified']) })
      .partial(),
    privacy: SettingsSchema.shape.privacy.partial(),
  })
  .partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
// Extra main-side checks in the settings handler: calendar ids must be in the last list-calendars result (or 'primary');
// timeZone must be a supported IANA zone. Stored as ONE row: settings(key='settings', value_json).

/** Pure deep-merge used by db/repos/settings.ts ; result is re-validated with SettingsSchema. */
export function applySettingsPatch(current: Settings, patch: SettingsPatch): Settings {
  const out = structuredClone(current) as Record<string, Record<string, unknown>>;
  for (const [group, values] of Object.entries(patch)) {
    if (!values) continue;
    for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[group]![k] =
        typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...(out[group]![k] as object), ...v } : v;
    }
  }
  return SettingsSchema.parse(out);
}
