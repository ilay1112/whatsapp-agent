// src/shared/i18n/resources.ts - merged i18next resources (build-plan 1.2; owner W0 -> W1-14 -> W2-01).
// Base files: src/shared/locales/{en,he}.json (nested objects). Fragments: src/shared/locales/pending/<package-id>.json with the shape
// { "en": { "dotted.key": "text" }, "he": { "dotted.key": "text" } } - flat dotted keys, merged here so main, renderer and vitest see
// them at once. W2-01 folds the fragments into the base files and deletes pending/.
import en from '../locales/en.json';
import he from '../locales/he.json';
import type { Lang } from '../types';

export type LocaleTree = { [key: string]: string | LocaleTree };
export type FlatLocale = Record<string, string>;
export interface LocaleFragment {
  en?: FlatLocale;
  he?: FlatLocale;
}

/** Nested tree -> flat dotted keys (plural suffixes stay on the leaf: "list.analysing_one"). */
export function flattenKeys(tree: LocaleTree, prefix = ''): FlatLocale {
  const out: FlatLocale = {};
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else Object.assign(out, flattenKeys(v, key));
  }
  return out;
}

/** Flat dotted keys -> nested tree. A key that collides with an existing leaf throws (fragment bug). */
export function unflattenKeys(flat: FlatLocale): LocaleTree {
  const root: LocaleTree = {};
  for (const [key, text] of Object.entries(flat)) {
    const parts = key.split('.');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      const next = node[part];
      if (next === undefined) {
        const created: LocaleTree = {};
        node[part] = created;
        node = created;
      } else if (typeof next === 'string') {
        throw new Error(`locale key "${key}" collides with leaf "${parts.slice(0, i + 1).join('.')}"`);
      } else {
        node = next;
      }
    }
    const leaf = parts[parts.length - 1]!;
    if (typeof node[leaf] === 'object') throw new Error(`locale key "${key}" collides with a branch`);
    node[leaf] = text;
  }
  return root;
}

/** Pure merge: base trees + fragments (later fragments win over earlier ones; fragments win over base). */
export function mergeLocaleResources(
  base: Record<Lang, LocaleTree>,
  fragments: Record<string, LocaleFragment>,
): Record<Lang, LocaleTree> {
  const flat: Record<Lang, FlatLocale> = { en: flattenKeys(base.en), he: flattenKeys(base.he) };
  for (const name of Object.keys(fragments).sort()) {
    const frag = fragments[name]!;
    if (frag.en) Object.assign(flat.en, frag.en);
    if (frag.he) Object.assign(flat.he, frag.he);
  }
  return { en: unflattenKeys(flat.en), he: unflattenKeys(flat.he) };
}

const pendingModules = import.meta.glob('../locales/pending/*.json', { eager: true, import: 'default' }) as Record<
  string,
  LocaleFragment
>;

export const LOCALE_FRAGMENT_FILES: readonly string[] = Object.keys(pendingModules).sort();

/** The merged trees, one per language. */
export const LOCALES: Record<Lang, LocaleTree> = mergeLocaleResources(
  { en: en as LocaleTree, he: he as LocaleTree },
  pendingModules,
);

/** i18next `resources` option (namespace 'translation'). */
export const RESOURCES = {
  en: { translation: LOCALES.en },
  he: { translation: LOCALES.he },
} as const;

/** Flat views used by the parity / usage tests. */
export const FLAT_LOCALES: Record<Lang, FlatLocale> = { en: flattenKeys(LOCALES.en), he: flattenKeys(LOCALES.he) };
