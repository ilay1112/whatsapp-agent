// src/renderer/src/store/settings.ts - settingsPublic + optimistic set (UX 14.3; owner W1-14).
// Settings are not side effects, so the local value is updated optimistically and rolled back when main rejects the patch.
import { create } from 'zustand';
import type { Settings, SettingsPatch } from '@shared/settings';
import { applySettingsPatch } from '@shared/settings';
import type { CalendarInfo, VoiceState, VoiceTier } from '@shared/types';
import type { ErrorCode } from '@shared/errors';
import { api } from '../api';

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
   * so only the tier is stored at first; once both files are ready `settleVoiceIntent` turns voice notes on. Window
   * memory only (a restart before the download finishes forgets it - see ops/agent-notes/v2-fix-src-renderer-src.md).
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
  voiceIntent: null,
  setVoiceIntent: (voiceIntent) => set({ voiceIntent }),
  settleVoiceIntent: async (voice) => {
    const tier = get().voiceIntent;
    if (tier === null) return;
    const ready = voice.resolvedTier === tier && voice.model?.id === tier && voice.model.status === 'ready';
    if (!ready || voice.vad.status !== 'ready') return;
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
