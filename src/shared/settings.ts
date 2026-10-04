// src/shared/settings.ts
import { z } from 'zod';
import { PROVIDER_IDS, VOICE_TIERS } from './types'; // [V2 ADD]

// ---------- [V2 ADD] sub-schemas (B23) ----------
/** B13: regex string, presets are ordering hints only ("as available on your plan"). Brackets allow suffixed aliases such as `sonnet[1m]`. */
export const ClaudeCliModelSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._[\]-]+$/);
/** B14 / C13: one agy model setting; the dropdown is filled from `agy models` at settings time, never hard-coded. */
export const AgyModelSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/);
/** '' = auto-resolve (locator). Otherwise an absolute Windows path ending in \claude.exe - set ONLY by the main-owned cli:pickExe native
 *  dialog, never through settings:set (a path never crosses IPC - see Architecture concerns #5). Never a .cmd, never quoted. */
export const ClaudeExePathSchema = z
  .string()
  .max(260)
  .regex(/^(|[A-Za-z]:\\[^"<>|?*\r\n%^&()!@]{0,240}\\claude\.exe)$/i) // [F7] also rejects % ^ & ( ) ! @ ...
  .refine((p) => !/(^|\\)\.\.(\\|$)/.test(p), 'no .. segments'); // [F7] ... and `..` segments (defence in depth: the exe is spawned directly, never via cmd.exe)
export const LlmCliSettingsSchema = z.strictObject({
  claudeModel: ClaudeCliModelSchema,
  agyModel: AgyModelSchema,
  maxRunsPerHour: z.number().int().min(1).max(60),
  allowOverage: z.boolean(), // false => isUsingOverage:true pauses the provider with CLOUD_OVERAGE (B13) ; written ONLY by cli:setOverage (F11)
  claudeExePath: ClaudeExePathSchema,
});
export const WhatsappReadToolsSchema = z.strictObject({
  enabled: z.boolean(),
  scope: z.enum(['trigger_chat', 'all_chats']), // all_chats + a cloud provider => that provider's consent at version 2 (B17, B21) ; written ONLY by wa:setReadScope (F11)
  windowDays: z.number().int().min(1).max(90),
});
export const VoiceSettingsSchema = z.strictObject({
  enabled: z.boolean(), // false until a voice model is ready
  tier: z.enum(['auto', ...VOICE_TIERS]),
  maxMinutes: z.literal(15),
  threads: z.union([z.literal('auto'), z.number().int().min(1).max(16)]),
});
export const ImagesSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  cloud: z.boolean(), // effective only while the active cloud provider's consent is at the version whose text names pictures (B19, B21)
});

export const SettingsSchema = z.strictObject({
  general: z.strictObject({
    language: z.enum(['system', 'en', 'he']),
    autostart: z.boolean(),
    timeZone: z.string().min(1).max(64), // IANA. [R2] READ-ONLY for the user: main sets it
    notifications: z.enum(['off', 'generic']), // never message text ; [V2] automatic-write toasts are shown even when 'off' (B11: a control)
  }),
  llm: z.strictObject({
    provider: z.enum(PROVIDER_IDS), // [V2 CHANGE] 5 ids ; still NOT settable through settings:set (llm:setProvider only)
    claudeModel: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._-]+$/), // API-key Claude (unchanged)
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
    cli: LlmCliSettingsSchema, // [V2 ADD]
  }),
  whatsapp: z.strictObject({
    processUnknownSenders: z.boolean(),
    backlogHours: z.number().int().min(0).max(72),
    readTools: WhatsappReadToolsSchema, // [V2 ADD]
  }),
  calendar: z.strictObject({
    targetCalendarId: z.string().min(1).max(256),
    conflictCalendarIds: z.array(z.string().min(1).max(256)).min(1).max(10),
    defaultDurationMin: z.number().int().min(5).max(720),
  }),
  agent: z.strictObject({
    paused: z.boolean(),
    ambiguousHour: z.enum(['assume', 'ask']),
    userGender: z.enum(['m', 'f', 'unspecified']),
  }),
  privacy: z.strictObject({ retentionDays: z.number().int().min(7).max(90) }),
  voice: VoiceSettingsSchema, // [V2 ADD]
  images: ImagesSettingsSchema, // [V2 ADD]
  // [V2] deliberately NO `auto` group: automatic mode is a policy row (B7, I10)
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
    cli: {
      claudeModel: 'sonnet',
      agyModel: 'gemini-3.8-flash-high',
      maxRunsPerHour: 20,
      allowOverage: false,
      claudeExePath: '',
    }, // [V2 ADD]
  },
  whatsapp: {
    processUnknownSenders: false,
    backlogHours: 0,
    readTools: { enabled: true, scope: 'trigger_chat', windowDays: 30 },
  },
  calendar: { targetCalendarId: 'primary', conflictCalendarIds: ['primary'], defaultDurationMin: 60 },
  agent: { paused: false, ambiguousHour: 'assume', userGender: 'unspecified' },
  privacy: { retentionDays: 30 },
  voice: { enabled: false, tier: 'auto', maxMinutes: 15, threads: 'auto' }, // [V2 ADD]
  images: { enabled: true, cloud: true }, // [V2 ADD]
};
/** [V2 ADD] Ordering hints only (C12): intersected with llm:listModels {provider:'claude_cli'}; "as available on your plan". */
export const CLAUDE_CLI_MODEL_PRESETS = ['sonnet', 'haiku', 'opus'] as const;
/** [V2 ADD] The v4 migration adds exactly these values to an existing v1 settings row with json_insert (keys absent only). A unit test asserts
 *  they equal DEFAULT_SETTINGS' new groups, and that applySettingsPatch(parse(v1 row + these)) round-trips. */
export const SETTINGS_V2_ADDED = {
  'llm.cli': DEFAULT_SETTINGS.llm.cli,
  'whatsapp.readTools': DEFAULT_SETTINGS.whatsapp.readTools,
  voice: DEFAULT_SETTINGS.voice,
  images: DEFAULT_SETTINGS.images,
} as const;
/** [R2] UI ORDERING HINTS ONLY - never rendered as-is. The renderer intersects them with the live `llm:listModels` result and hides absent ids
 *  (ARCHITECTURE section 8: "never a hard-coded list"). `claude-haiku-4-5` dropped (expected to retire after 2026-10-15). */
export const CLAUDE_MODEL_PRESETS = ['claude-opus-5', 'claude-sonnet-5'] as const;
export const GEMINI_MODEL_PRESETS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite'] as const;

/** settings:set request: any subset of any group. NOT settable through settings:set (dedicated channels enforce preconditions):
 *  llm.provider (llm:setProvider), agent.paused (agent:setPaused), llm.local.forceCpu (main only), general.timeZone (main only) [R2],
 *  [V2] llm.cli.claudeExePath (cli:pickExe only), llm.cli.allowOverage (cli:setOverage only, F11), whatsapp.readTools.scope (wa:setReadScope only,
 *  F11) and ANY `auto` key (auto:* only). The handler rejects them with BAD_REQUEST + audit ipc_rejected. */
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
        // [V2 ADD] claudeExePath (cli:pickExe) and allowOverage (cli:setOverage, F11) are deliberately absent
        cli: LlmCliSettingsSchema.omit({ claudeExePath: true, allowOverage: true }).partial(),
      })
      .partial(),
    // [V2 CHANGE] explicit shape so readTools patches partially (the v1 `.partial()` of the group would demand a full readTools object)
    whatsapp: z
      .strictObject({
        processUnknownSenders: SettingsSchema.shape.whatsapp.shape.processUnknownSenders,
        backlogHours: SettingsSchema.shape.whatsapp.shape.backlogHours,
        readTools: WhatsappReadToolsSchema.omit({ scope: true }).partial(), // [F11] scope via wa:setReadScope only
      })
      .partial(),
    calendar: SettingsSchema.shape.calendar.partial(),
    agent: z
      .strictObject({ ambiguousHour: z.enum(['assume', 'ask']), userGender: z.enum(['m', 'f', 'unspecified']) })
      .partial(),
    privacy: SettingsSchema.shape.privacy.partial(),
    voice: VoiceSettingsSchema.partial(), // [V2 ADD] voice.enabled=true is refused by the handler (BAD_REQUEST) until a voice model is ready
    images: ImagesSettingsSchema.partial(), // [V2 ADD]
    // [V2] still NO `auto` key: z.strictObject rejects it => BAD_REQUEST + audit ipc_rejected (B7)
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
