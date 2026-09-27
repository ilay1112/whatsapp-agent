// Locale parity over the MERGED resources (base + pending fragments).
// Sources: CONTRACTS section 18 items 2 and 9, TESTS section 9 row "Key parity", UX 11.4 / 15.1 / 15.2 (owner W1-14).
import { describe, expect, it } from 'vitest';
import {
  FLAT_LOCALES,
  LOCALE_FRAGMENT_FILES,
  flattenKeys,
  mergeLocaleResources,
  unflattenKeys,
} from '../i18n/resources';
import { ERROR_ACTIONS, ERROR_CODES } from '../errors';
import { BRIDGE_STATUSES, LLM_STATUSES, MCP_STATUSES, PAIRING_STATUSES } from '../health';
import {
  ASSUMPTIONS,
  BADGES,
  CLOSED_REASONS,
  CONSENT_KINDS,
  CONSENT_VERSIONS,
  CREDENTIALS_PROBLEMS,
  HOLD_REASONS,
  MISSING_FIELDS,
} from '../types';

const en = FLAT_LOCALES.en;
const he = FLAT_LOCALES.he;

/** Hebrew has a real dual ("שתי שיחות"); English does not. i18n-rtl.md 4.6: Intl.PluralRules('he') = one | two | other. */
const HE_ONLY_SUFFIX = '_two';

/**
 * Keys whose Hebrew value is deliberately byte-equal to the English one: brand names, language endonyms and the
 * intentionally empty "no action" label. Anything else that is equal is an untranslated string (TESTS section 9).
 */
const SAME_ON_PURPOSE: readonly string[] = [
  'label.errorAction.none', // ERROR_ACTION 'none' renders no button at all
  'app.name', // product name; the Hebrew wordmark is app.wordmark
  'tray.tooltip', // same product name in the tray tooltip
  'health.provider.claude',
  'health.provider.gemini',
  'language.he', // endonyms are never translated (i18n-rtl.md 4.3)
  'language.en',
];

/** The ONLY markup allowed in a value: bidi isolation rendered through <Trans> (UX 15.1, build-plan W1-14 brief). */
const ALLOWED_TAG_RE = /^<\/?bdi(?: dir="ltr")?>$/;

const pluralOf = (k: string) => /_(zero|one|two|few|many|other)$/.exec(k)?.[1] ?? null;
const placeholders = (s: string) => [...s.matchAll(/\{\{\s*([a-zA-Z0-9_]+)/g)].map((m) => m[1]).sort();

describe('locale parity', () => {
  it('en and he have the same keys, except the Hebrew dual (_two)', () => {
    const onlyEn = Object.keys(en).filter((k) => !(k in he));
    const onlyHe = Object.keys(he).filter((k) => !(k in en));
    expect(onlyEn, 'keys missing in he.json').toEqual([]);
    for (const k of onlyHe) {
      expect(k, 'he.json may only add the dual form').toMatch(/_two$/);
      const base = k.slice(0, -HE_ONLY_SUFFIX.length);
      expect(en, `${k} has no _one/_other base in en.json`).toHaveProperty(`${base}_other`);
      expect(en).toHaveProperty(`${base}_one`);
    }
  });

  it('English never carries the Hebrew-only dual or the retired _many category', () => {
    for (const k of Object.keys(en)) expect(pluralOf(k), `en ${k}`).not.toBe('two');
    for (const k of [...Object.keys(en), ...Object.keys(he)]) expect(pluralOf(k), k).not.toBe('many');
  });

  it('no value is an empty string except label.errorAction.none', () => {
    for (const [k, v] of Object.entries(en)) if (k !== 'label.errorAction.none') expect(v, `en ${k}`).not.toBe('');
    for (const [k, v] of Object.entries(he)) if (k !== 'label.errorAction.none') expect(v, `he ${k}`).not.toBe('');
  });

  it('no value contains markup other than <bdi> / <bdi dir="ltr">', () => {
    for (const [lng, table] of [
      ['en', en],
      ['he', he],
    ] as const) {
      for (const [k, v] of Object.entries(table)) {
        for (const tag of v.match(/<[^>]*>/g) ?? []) {
          expect(ALLOWED_TAG_RE.test(tag), `${lng} ${k} contains ${tag}`).toBe(true);
        }
      }
    }
  });

  it('every Hebrew value differs from the English one unless listed in SAME_ON_PURPOSE', () => {
    const untranslated = Object.keys(he).filter((k) => k in en && he[k] === en[k] && !SAME_ON_PURPOSE.includes(k));
    expect(untranslated, 'untranslated he values').toEqual([]);
  });

  it('SAME_ON_PURPOSE has no stale entries', () => {
    for (const k of SAME_ON_PURPOSE) {
      expect(en, k).toHaveProperty(k);
      expect(he[k], `${k} is translated now - remove it from SAME_ON_PURPOSE`).toBe(en[k]);
    }
  });

  it('interpolation placeholders match between languages', () => {
    for (const k of Object.keys(en)) {
      const a = placeholders(en[k]!);
      const b = placeholders(he[k]!);
      // plural forms may drop {{count}} in one language ("one chat" / "שיחה אחת")
      const plural = pluralOf(k) !== null;
      const strip = (xs: (string | undefined)[]) => (plural ? xs.filter((x) => x !== 'count') : xs);
      expect(strip(b), k).toEqual(strip(a));
    }
    for (const k of Object.keys(he)) {
      if (k in en) continue; // dual form: compare against _other
      const base = `${k.slice(0, -HE_ONLY_SUFFIX.length)}_other`;
      expect(
        placeholders(he[k]!).filter((x) => x !== 'count'),
        k,
      ).toEqual(placeholders(he[base]!).filter((x) => x !== 'count'));
    }
  });

  it('every ErrorCode has errors.<CODE>.title|body|action in both languages', () => {
    for (const code of ERROR_CODES) {
      for (const part of ['title', 'body', 'action'] as const) {
        expect(en, `en errors.${code}.${part}`).toHaveProperty(`errors.${code}.${part}`);
        expect(he, `he errors.${code}.${part}`).toHaveProperty(`errors.${code}.${part}`);
      }
    }
  });

  it.each([
    ['errorAction', ERROR_ACTIONS],
    ['badge', BADGES],
    ['missingField', MISSING_FIELDS],
    ['holdReason', HOLD_REASONS],
    ['closedReason', CLOSED_REASONS],
    ['bridgeStatus', BRIDGE_STATUSES],
    ['mcpStatus', MCP_STATUSES],
    ['llmStatus', LLM_STATUSES],
    ['pairingStatus', PAIRING_STATUSES],
    ['credentialsProblem', CREDENTIALS_PROBLEMS],
    ['assumption', ASSUMPTIONS],
  ] as const)('every %s value has label.%s.<value> in both languages', (group, values) => {
    for (const v of values) {
      expect(en, `en label.${group}.${v}`).toHaveProperty(`label.${group}.${v}`);
      expect(he, `he label.${group}.${v}`).toHaveProperty(`label.${group}.${v}`);
    }
  });

  it('the status panel has a sentence for every bridge / llm / calendar state (UX 5.2)', () => {
    for (const s of BRIDGE_STATUSES) {
      expect(en, `health.whatsapp.${s}`).toHaveProperty(`health.whatsapp.${s}`);
      expect(he, `health.whatsapp.${s}`).toHaveProperty(`health.whatsapp.${s}`);
    }
    for (const s of LLM_STATUSES) {
      expect(en, `health.llm.${s}`).toHaveProperty(`health.llm.${s}`);
      expect(he, `health.llm.${s}`).toHaveProperty(`health.llm.${s}`);
    }
    for (const s of MCP_STATUSES) {
      expect(en, `health.calendar.${s}`).toHaveProperty(`health.calendar.${s}`);
      expect(he, `health.calendar.${s}`).toHaveProperty(`health.calendar.${s}`);
    }
  });

  it('[R2] CONSENT_VERSIONS[kind] equals the version literal of the consent copy keys in both locales', () => {
    for (const kind of CONSENT_KINDS) {
      const v = CONSENT_VERSIONS[kind];
      for (const part of ['title', 'body', 'accept'] as const) {
        expect(en).toHaveProperty(`consent.${kind}.v${v}.${part}`);
        expect(he).toHaveProperty(`consent.${kind}.v${v}.${part}`);
      }
      const other = Object.keys(en).filter(
        (k) => k.startsWith(`consent.${kind}.v`) && !k.startsWith(`consent.${kind}.v${v}.`),
      );
      expect(other, 'stale consent copy of another version').toEqual([]);
    }
  });

  it('UX 15.2 / 12 core keys exist', () => {
    for (const k of [
      'list.needs_reply',
      'list.in_calendar',
      'list.info_missing',
      'action.approveSend',
      'action.addToCalendar',
      'tray.open',
      'tray.quit',
      'tray.pause',
      'tray.resume',
      'notify.needsReply.title',
      'trayHint.title',
      'trayHint.gotIt',
      'welcome.promise',
      'health.ok',
      'header.pause',
      'footer.undoDismiss',
      'setup.whatsapp.text',
      'download.finished',
    ]) {
      expect(en).toHaveProperty(k);
      expect(he).toHaveProperty(k);
    }
  });

  it('pending fragments (if any) are well-formed and named after their owning package', () => {
    for (const f of LOCALE_FRAGMENT_FILES) expect(f).toMatch(/\/pending\/W[0-9]-[0-9]{2}-[a-z-]+\.json$/);
  });
});

describe('resources helpers', () => {
  it('flatten/unflatten round-trip', () => {
    const tree = { a: { b: 'x', c: { d: 'y' } }, e: 'z' };
    expect(unflattenKeys(flattenKeys(tree))).toEqual(tree);
  });
  it('fragments override base and later fragments win', () => {
    const merged = mergeLocaleResources(
      { en: { a: { b: 'base' } }, he: { a: { b: 'בסיס' } } },
      { 'b.json': { en: { 'a.b': 'two' } }, 'a.json': { en: { 'a.b': 'one', 'n.k': 'new' }, he: { 'n.k': 'חדש' } } },
    );
    expect(flattenKeys(merged.en)).toEqual({ 'a.b': 'two', 'n.k': 'new' });
    expect(flattenKeys(merged.he)).toEqual({ 'a.b': 'בסיס', 'n.k': 'חדש' });
  });
  it('a key colliding with a leaf throws', () => {
    expect(() => unflattenKeys({ a: 'x', 'a.b': 'y' })).toThrow(/collides/);
  });
});
