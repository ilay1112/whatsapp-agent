// src/shared/i18n/languages.ts
// Signatures from docs/research/i18n-rtl.md 4.1 (owner W1-08). Pure, no I/O, no Intl.
import type { Lang } from '../types';

export const SUPPORTED = ['en', 'he'] as const;
export type UiLang = (typeof SUPPORTED)[number];
export type LangSetting = 'system' | UiLang;

/** preferred = app.getPreferredSystemLanguages() in main. 'iw' (legacy Hebrew tag) counts as 'he'. Falls back to 'en'. */
export function resolveLanguage(setting: LangSetting, preferred: string[]): UiLang {
  if (setting !== 'system') return setting;
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0];
    if (base === 'he' || base === 'iw') return 'he'; // 'iw' = legacy ISO 639-1 code for Hebrew, still emitted by Windows
    if (base === 'en') return 'en';
  }
  return 'en';
}

/** Locale used for Intl formatting. en-IL = English words + Israeli conventions (24h, d/m, Sunday). */
export function localeFor(lng: UiLang): 'he-IL' | 'en-IL' {
  return lng === 'he' ? 'he-IL' : 'en-IL';
}

/** Direction of a UI language. */
export function dirFor(lng: Lang): 'ltr' | 'rtl' {
  return lng === 'he' ? 'rtl' : 'ltr';
}

/** Type guard used when a persisted / OS-supplied value has to be narrowed to a supported UI language. */
export function isUiLang(value: unknown): value is UiLang {
  return value === 'en' || value === 'he';
}
