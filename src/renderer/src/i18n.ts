// src/renderer/src/i18n.ts - renderer i18next instance (docs/research/i18n-rtl.md 4.2, ARCH 12.3; owner W1-14).
// The renderer NEVER decides the language on its own: main resolves settings.general.language, passes the result through
// webPreferences.additionalArguments (read by api.ts as `initialLanguage()`) and pushes `ui:languageChanged` after every
// change. This module only mirrors that decision into i18next and into <html lang dir>.
import i18next, { type i18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { RESOURCES } from '@shared/i18n/resources';
import type { Dir, Lang } from '@shared/types';

/** Bidi isolates for values interpolated into PLAIN strings (aria-label, title). JSX uses <bdi> through <Trans> instead. */
export const FSI = '⁨';
export const PDI = '⁩';
export const LRI = '⁦';

export function dirOf(lang: Lang): Dir {
  return lang === 'he' ? 'rtl' : 'ltr';
}

/** Applies <html lang dir>. Called on init, on ui:languageChanged and by i18next's own languageChanged event. */
export function applyDocumentLanguage(lang: Lang, dir: Dir = dirOf(lang)): void {
  document.documentElement.lang = lang;
  document.documentElement.dir = dir;
}

/** Registers the two plain-string formatters used by `{{name, bdi}}` / `{{phone, ltr}}` (i18next v26 formatter API). */
export function addBidiFormatters(inst: i18n): void {
  inst.services.formatter?.add('bdi', (value: unknown) => `${FSI}${String(value)}${PDI}`);
  inst.services.formatter?.add('ltr', (value: unknown) => `${LRI}${String(value)}${PDI}`);
}

let instance: i18n | null = null;

export async function initI18n(initial: Lang): Promise<i18n> {
  if (instance) {
    if (instance.language !== initial) await instance.changeLanguage(initial);
    return instance;
  }
  const inst = i18next.createInstance();
  inst.on('languageChanged', (lng: string) => {
    const lang = lng === 'he' ? 'he' : 'en';
    applyDocumentLanguage(lang, inst.dir(lng) === 'rtl' ? 'rtl' : 'ltr');
  });
  await inst.use(initReactI18next).init({
    lng: initial,
    fallbackLng: 'en',
    supportedLngs: ['en', 'he'],
    resources: RESOURCES,
    interpolation: { escapeValue: false }, // React escapes; untrusted values are additionally wrapped in <bdi> through Trans
    returnNull: false,
    saveMissing: false,
  });
  addBidiFormatters(inst);
  instance = inst;
  applyDocumentLanguage(initial);
  return inst;
}

export function getI18n(): i18n {
  if (!instance) throw new Error('i18n not initialised');
  return instance;
}
