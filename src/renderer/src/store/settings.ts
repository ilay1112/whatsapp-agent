// src/renderer/src/store/settings.ts - settingsPublic + optimistic set (UX 14.3; owner W1-14).
// Settings are not side effects, so the local value is updated optimistically and rolled back when main rejects the patch.
import { create } from 'zustand';
import type { Settings, SettingsPatch } from '@shared/settings';
import { applySettingsPatch } from '@shared/settings';
import { VOICE_TIERS, type CalendarInfo, type VoiceState, type VoiceTier } from '@shared/types';
import type { ErrorCode } from '@shared/errors';
import { api } from '../api';

/**
 * [V2] ux-i18n-v2-4 (restart): the voice intent is kept in the renderer's own web storage so an app restart in the middle
 * of the model download does not forget it. The stored value is a tier id and a timestamp - nothing personal, no secret.
 * An intent older than VOICE_INTENT_MAX_AGE_MS is dropped: a download abandoned a week ago must not switch voice notes
 * on by surprise. Every storage access is guarded; storage that throws leaves the intent in window memory only.
 */
export const VOICE_INTENT_KEY = 'wca.voiceIntent';
export const VOICE_INTENT_MAX_AGE_MS = 7 * 86_400_000;

function readStoredVoiceIntent(): VoiceTier | null {
  try {
    const raw = window.localStorage.getItem(VOICE_INTENT_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { tier?: unknown; at?: unknown };
    const tier = VOICE_TIERS.find((v) => v === parsed.tier) ?? null;
    const at = typeof parsed.at === 'number' ? parsed.at : NaN;
    const age = Date.now() - at;
    if (tier === null || !(age >= 0 && age <= VOICE_INTENT_MAX_AGE_MS)) {
      window.localStorage.removeItem(VOICE_INTENT_KEY);
      return null;
    }
    return tier;
  } catch {
    return null;
  }
}

function storeVoiceIntent(tier: VoiceTier | null): void {
  try {
    if (tier === null) window.localStorage.removeItem(VOICE_INTENT_KEY);
    else window.localStorage.setItem(VOICE_INTENT_KEY, JSON.stringify({ tier, at: Date.now() }));
  } catch {
    // window memory still holds it for this run
  }
}

export interface SettingsStore {
  settings: Settings | null;
  saveError: ErrorCode | null;
  /** Epoch ms of the last accepted save; App announces "Saved." in the polite live region when it changes. */
  savedAt: number;
  /**
   * `settings.calendar.targetCalendarId` is an OPAQUE Google id ('primary' by default). The only place a human-readable
   * name exists is `google:listCalendars`, so the list is cached here: the approval sheet has to NAME the calendar it
   * is about to write to (UX 7.2), and it must not fetch once per card to do it. `name` is UNTRUSTED (CONTRACTS).
   */
  calendars: CalendarInfo[];
  /** True once a fetch was STARTED, so the list is requested at most once per window. */
  calendarsLoaded: boolean;
  setCalendars(calendars: CalendarInfo[]): void;
  /** Fetch-once. A failure is silent: the callers all have a usable fallback for an unresolved id. */
  loadCalendars(): Promise<void>;
  hydrate(s: Settings): void;
  set(patch: SettingsPatch): Promise<void>;
  clearSaveError(): void;
  /**
   * [V2] ux-i18n-v2-4: the voice tier the user asked for while its files were not ready yet (Settings > Voice notes
   * Download, the onboarding opt-in). Main refuses voice.enabled=true until the tier and the VAD file are ready (C2 4),
   * so only the tier is stored at first; once both files are ready `settleVoiceIntent` turns voice notes on. It is
   * kept in web storage too, so it survives a restart mid-download (max 7 days; see VOICE_INTENT_KEY).
   */
  voiceIntent: VoiceTier | null;
  setVoiceIntent(tier: VoiceTier | null): void;
  /** Enables the intended tier once `voice` reports it and the VAD ready; a refusal leaves voice off (radio on Off). */
  settleVoiceIntent(voice: VoiceState): Promise<void>;
}

/**
 * The name to show for a target calendar id. Falls back to a translated name for the default 'primary' (the id is a
 * Google API token, never something to print at the user) and, for anything else, to the id itself - which at least
 * identifies the calendar, and which callers isolate with `<bdi>` because it is Latin text in a possibly RTL sentence.
 */
export function calendarNameOf(id: string, calendars: readonly CalendarInfo[], primaryFallback: string): string {
  const match = calendars.find((c) => c.id === id) ?? (id === 'primary' ? calendars.find((c) => c.primary) : undefined);
  if (match) return match.name;
  return id === 'primary' ? primaryFallback : id;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: null,
  saveError: null,
  savedAt: 0,
  calendars: [],
  calendarsLoaded: false,
  voiceIntent: readStoredVoiceIntent(),
  setVoiceIntent: (voiceIntent) => {
    storeVoiceIntent(voiceIntent);
    set({ voiceIntent });
  },
  settleVoiceIntent: async (voice) => {
    const tier = get().voiceIntent;
    if (tier === null) return;
    const ready = voice.resolvedTier === tier && voice.model?.id === tier && voice.model.status === 'ready';
    if (!ready || voice.vad.status !== 'ready') return;
    storeVoiceIntent(null);
    set({ voiceIntent: null }); // once: a second caller (App and the open Settings page) must not enable twice
    await get().set({ voice: { enabled: true, tier } });
  },
  hydrate: (settings) => set({ settings, saveError: null }),
  clearSaveError: () => set({ saveError: null }),
  setCalendars: (calendars) => set({ calendars, calendarsLoaded: true }),
  loadCalendars: async () => {
    if (get().calendarsLoaded) return;
    set({ calendarsLoaded: true });
    const r = await api.listCalendars();
    if (r.ok) set({ calendars: r.value.calendars });
  },
  set: async (patch) => {
    const before = get().settings;
    // Optimistic: the local value is re-derived with the same pure merge main uses, so the form does not flicker.
    if (before) {
      try {
        set({ settings: applySettingsPatch(before, patch), saveError: null });
      } catch {
        // a patch that cannot produce valid settings is left to main to reject
      }
    }
    const r = await api.setSettings(patch);
    if (r.ok) set({ settings: r.value, saveError: null, savedAt: Date.now() });
    else set({ settings: before, saveError: r.error.code });
  },
}));
