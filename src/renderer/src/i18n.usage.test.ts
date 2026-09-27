// TESTS section 9 row "No missing / no dead keys" (owner W1-14).
// Static scan of src/**/*.{ts,tsx} for t('...'), t(`prefix.${...}`) and <Trans i18nKey="...">:
//   - every LITERAL key used in code exists in both locale files (merged with the pending fragments);
//   - every key in the locale files is either referenced, covered by a template prefix used in code, enumerated by
//     locales.test.ts, or explicitly listed below as seeded for a package that has not written its screens yet.
// The runtime half of this guard lives in tests/setup-renderer.ts: i18next is initialised with a THROWING
// missingKeyHandler, so any render of a missing key fails its own test.
import { describe, expect, it } from 'vitest';
import { FLAT_LOCALES } from '@shared/i18n/resources';
import { listRepoFiles, readRepoFile } from '../../../tests/setup-renderer';

const en = FLAT_LOCALES.en;
const he = FLAT_LOCALES.he;

/**
 * Key families that are resolved from an enum at run time and are therefore checked by ENUMERATION in
 * src/shared/locales/locales.test.ts instead of by a literal reference (TESTS section 9).
 */
const DYNAMIC_PREFIXES: readonly string[] = [
  'errors.', // every ErrorCode x title|body|action
  'label.', // every enum label of CONTRACTS section 18 item 2
  'health.whatsapp.', // BridgeStatus sentences
  'health.llm.', // LlmStatus sentences
  'health.calendar.', // McpStatus sentences
  'health.provider.', // ProviderId
  'health.attentionPart.', // HealthPart
  'health.part.',
  'download.tier.', // ModelTier
  'setup.', // SetupTask x text|action
  'consent.', // ConsentKind x version
  'tray.status.', // tray status line (W1-12)
];

/**
 * Seeded for a package whose screens are not written yet (build-plan 1.2 assigns these prefixes to other packages; this
 * file seeds the UX tables so they do not have to). Delete an entry once its owner references the key - the last test of
 * this file fails while a redundant entry is still listed, so the list shrinks by itself as Wave 1 lands.
 *
 * `[repair ux-i18n-6]` EMPTY since W1-15/W1-16 shipped. It used to exempt the whole `card.` / `action.` / `event.` /
 * `google.` / `tray.` / `calendar.` families, which made the "no dead keys" test blind to six genuinely dead keys: one
 * unreferenced key under a prefix could never be seen, and the staleness test below only fires when EVERY key of a
 * prefix is covered otherwise. The scanner now reads the key forms those packages actually use (see QUOTED_KEY_RE), so
 * the exemptions are no longer needed. Do not re-add a prefix here to silence a dead key: reference it or delete it.
 */
const SEEDED_FOR_OTHER_PACKAGES: readonly string[] = [];

/** Individual keys seeded for another package (same rule as above, but their prefix is shared with this package). */
const SEEDED_KEYS: readonly string[] = [
  'app.name', // window title + tray tooltip, set by main through the Electron facade (W1-12), never through t()
];

/** `t('x')`, `i18n.t('x')` and the shell's `tRef.current('x')` key-builder helper. */
const LITERAL_KEY_RE = /(?:\bt|tRef\.current)\(\s*(['"])([A-Za-z][A-Za-z0-9_.]*)\1/g;
/**
 * A dotted key in ANY quoted position. `t()` is called with plenty of keys this file cannot parse as a call argument:
 * `t(cond ? 'action.sent' : 'action.added')`, `setToast({ key: 'action.dismissed' })`, `{ key: 'event.error.past' }`
 * handed to `t(verdict.key)`, and the tray's `t(paused ? 'tray.resume' : 'tray.pause')`. Matching the STRING instead of
 * the call shape keeps those keys visible to the dead-key test. It is deliberately permissive in one direction only: a
 * key is at worst reported as live when the string appears for another reason, which is the old prefix behaviour but
 * per key instead of per family.
 */
const QUOTED_KEY_RE = /(['"])([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\1/g;
/** `t(`errors.${code}.title`)` -> "errors.", and also `t(`google.step${n}.${key}`)` -> "google." (mid-segment). */
const TEMPLATE_PREFIX_RE = /(?:\bt|tRef\.current)\(\s*`([A-Za-z][A-Za-z0-9_.]*\.)[A-Za-z0-9_]*\$\{/g;
const TRANS_KEY_RE = /i18nKey\s*=\s*(?:"([^"]+)"|\{\s*'([^']+)'\s*\})/g;

const sources = listRepoFiles('src', ['.ts', '.tsx'])
  .filter((f) => !/\.test\.tsx?$/.test(f) && !f.endsWith('env.d.ts'))
  .map((f) => ({ file: f, text: readRepoFile(f) }));

const literalKeys = new Map<string, string>(); // key -> first file that uses it
/** Every dotted string literal in the tree. Only the dead-key direction reads this - never the "key exists" tests. */
const quotedKeys = new Set<string>();
const templatePrefixes = new Set<string>();
for (const { file, text } of sources) {
  for (const m of text.matchAll(LITERAL_KEY_RE)) if (!literalKeys.has(m[2]!)) literalKeys.set(m[2]!, file);
  for (const m of text.matchAll(TRANS_KEY_RE)) {
    const key = m[1] ?? m[2]!;
    if (!literalKeys.has(key)) literalKeys.set(key, file);
  }
  for (const m of text.matchAll(TEMPLATE_PREFIX_RE)) templatePrefixes.add(m[1]!);
  for (const m of text.matchAll(QUOTED_KEY_RE)) quotedKeys.add(m[2]!);
}

/** A literal key may address a plural family ("list.analysing" -> list.analysing_one / _other). */
function resolves(table: Record<string, string>, key: string): boolean {
  return key in table || `${key}_other` in table;
}

describe('i18n key usage', () => {
  it('scans the whole src tree', () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(literalKeys.size).toBeGreaterThan(20);
  });

  it('every literal key used in code exists in en.json', () => {
    const missing = [...literalKeys].filter(([key]) => !resolves(en, key)).map(([key, file]) => `${key} (${file})`);
    expect(missing).toEqual([]);
  });

  it('every literal key used in code exists in he.json', () => {
    const missing = [...literalKeys].filter(([key]) => !resolves(he, key)).map(([key, file]) => `${key} (${file})`);
    expect(missing).toEqual([]);
  });

  it('has no dead keys', () => {
    const referenced = (key: string): boolean => {
      if (literalKeys.has(key) || quotedKeys.has(key)) return true;
      const base = key.replace(/_(zero|one|two|few|many|other)$/, '');
      if (literalKeys.has(base) || quotedKeys.has(base)) return true;
      if (SEEDED_KEYS.includes(base)) return true;
      const prefixes = [...templatePrefixes, ...DYNAMIC_PREFIXES, ...SEEDED_FOR_OTHER_PACKAGES];
      return prefixes.some((p) => key.startsWith(p));
    };
    const dead = Object.keys(en).filter((k) => !referenced(k));
    expect(dead, 'unused locale keys - reference them or list their prefix').toEqual([]);
  });

  it('the seeded allow-lists have no stale entry', () => {
    for (const prefix of SEEDED_FOR_OTHER_PACKAGES) {
      expect(
        Object.keys(en).some((k) => k.startsWith(prefix)),
        prefix,
      ).toBe(true);
    }
    for (const key of SEEDED_KEYS) expect(resolves(en, key), key).toBe(true);
  });

  // Requested by W1-16-renderer-setup and W2-01-compose-integration: the allow-lists are scaffolding for screens that
  // were not written yet, so every entry has to EARN its place. Once its owner references the keys the entry must go,
  // otherwise the "no dead keys" guard above quietly stops guarding that prefix.
  it('no allow-list entry covers only keys that are referenced anyway', () => {
    const coveredOtherwise = (key: string): boolean => {
      if (literalKeys.has(key) || quotedKeys.has(key)) return true;
      const base = key.replace(/_(zero|one|two|few|many|other)$/, '');
      if (literalKeys.has(base) || quotedKeys.has(base)) return true;
      return [...templatePrefixes, ...DYNAMIC_PREFIXES].some((p) => key.startsWith(p));
    };
    const redundantPrefixes = SEEDED_FOR_OTHER_PACKAGES.filter((prefix) =>
      Object.keys(en)
        .filter((k) => k.startsWith(prefix))
        .every(coveredOtherwise),
    );
    expect(redundantPrefixes, 'drop these prefixes from SEEDED_FOR_OTHER_PACKAGES').toEqual([]);
    const redundantKeys = SEEDED_KEYS.filter(coveredOtherwise);
    expect(redundantKeys, 'drop these keys from SEEDED_KEYS').toEqual([]);
  });

  it('components never reach for window.api directly (api.ts is the only file that may)', () => {
    const offenders = sources
      .filter(({ file }) => file.startsWith('src/renderer/') && file !== 'src/renderer/src/api.ts')
      .filter(({ text }) => /\bwindow\s*\.\s*api\b/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
