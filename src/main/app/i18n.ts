// src/main/app/i18n.ts - main-process i18next instance for tray, toasts and native dialogs (build-plan section 3; owner W1-12).
import { createInstance, type i18n } from 'i18next';
import { RESOURCES } from '../../shared/i18n/resources';
import type { Lang } from '../../shared/types';

/** First-strong isolate / pop directional isolate: the plain-string equivalent of dir="auto" (i18n-rtl.md 6.1). */
export const FSI = String.fromCharCode(0x2068);
export const PDI = String.fromCharCode(0x2069);

/** `{{value, bdi}}` wraps an interpolation in FSI ... PDI so a Hebrew name inside an English sentence cannot reorder it. */
export function bdi(value: unknown): string {
  return `${FSI}${String(value)}${PDI}`;
}

/** True in a packaged / production main process, where a missing key must degrade instead of crashing the tray. */
function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** createInstance() with RESOURCES of src/shared/i18n/resources.ts, the `bdi` formatter (FSI...PDI) and a throwing missingKeyHandler in dev. */
export function createMainI18n(lang: Lang): i18n {
  const instance = createInstance();
  void instance.init({
    lng: lang,
    fallbackLng: 'en',
    supportedLngs: ['en', 'he'],
    resources: RESOURCES,
    ns: ['translation'],
    defaultNS: 'translation',
    returnNull: false,
    saveMissing: true,
    missingKeyHandler: (_lngs, _ns, key) => {
      if (!isProduction()) throw new Error(`missing locale key in main: ${key}`);
    },
    interpolation: {
      escapeValue: false, // main renders into native chrome (tray, toasts), never into HTML
    },
  });
  // i18next >= 21 resolves `{{value, bdi}}` through the formatter service, not through interpolation.format.
  instance.services.formatter?.add('bdi', (value) => bdi(value));
  return instance;
}
