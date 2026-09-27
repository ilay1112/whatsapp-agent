// src/main/db/repos/settings.ts - Repos['settings'] implementation over the Db wrapper (owner W1-04). Signatures: CONTRACTS 15.1.
// One row, key='settings' (ARCHITECTURE section 10). Validated with zod on EVERY read: a row that no longer parses (a downgrade,
// a hand-edited file, a restored backup from an older build) falls back to DEFAULT_SETTINGS instead of crashing the app, and the
// stored row is left untouched so the deviation stays visible.
import { applySettingsPatch, DEFAULT_SETTINGS, SettingsPatchSchema, SettingsSchema } from '../../../shared/settings';
import type { Settings } from '../../../shared/settings';
import type { Db, Repos } from '../index';

export type SettingsRepo = Repos['settings'];
const ROW_KEY = 'settings';

export function createSettingsRepo(db: Db): SettingsRepo {
  const read = (): Settings => {
    const row = db.prepare<{ value_json: string }>(`SELECT value_json FROM settings WHERE key = ?`).get(ROW_KEY);
    if (!row) return structuredClone(DEFAULT_SETTINGS);
    let raw: unknown;
    try {
      raw = JSON.parse(row.value_json);
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
    const parsed = SettingsSchema.safeParse(raw);
    return parsed.success ? parsed.data : structuredClone(DEFAULT_SETTINGS);
  };
  const write = (s: Settings): Settings => {
    const validated = SettingsSchema.parse(s);
    db.prepare(
      `INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(ROW_KEY, JSON.stringify(validated), Date.now());
    return validated;
  };

  return {
    get: read,
    /** Renderer-facing patch: rejected by zod when it carries an unknown key or a channel-only field (shared/settings.ts). */
    patch(p) {
      return db.transaction(() => write(applySettingsPatch(read(), SettingsPatchSchema.parse(p))));
    },
    /** Main-only mutation (general.timeZone, llm.provider, agent.paused, llm.local.forceCpu) - still re-validated before it is stored. */
    setInternal(mut) {
      return db.transaction(() => {
        const next = structuredClone(read());
        mut(next);
        return write(next);
      });
    },
  };
}
