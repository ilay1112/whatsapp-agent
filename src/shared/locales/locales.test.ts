// Locale parity over the MERGED resources (base + pending fragments).
// Sources: CONTRACTS section 18 items 2 and 9, TESTS section 9 row "Key parity", UX 11.4 / 15.1 / 15.2 (owner W1-14).
import { describe, expect, it } from 'vitest';
import i18next from 'i18next';
import {
  FLAT_LOCALES,
  LOCALE_FRAGMENT_FILES,
  RESOURCES,
  flattenKeys,
  mergeLocaleResources,
  unflattenKeys,
} from '../i18n/resources';
import { ERROR_ACTIONS, ERROR_CODES } from '../errors';
import { BRIDGE_STATUSES, LLM_STATUSES, MCP_STATUSES, PAIRING_STATUSES, VOICE_STATUSES } from '../health';
import {
  ANTIGRAVITY_TERMS_READ_ON,
  ASSUMPTIONS,
  AUTO_PAUSED_REASONS,
  AUTO_REASONS,
  BADGES,
  CHANGE_KINDS,
  CLI_STATES,
  CLOSED_REASONS,
  CONSENT_KINDS,
  CONSENT_VERSIONS,
  CREDENTIALS_PROBLEMS,
  HOLD_REASONS,
  IMAGE_KINDS,
  MISSING_FIELDS,
  VOICE_TIERS,
} from '../types';
import { AUTO_HAPPENS_KEYS, AUTO_NEVER_KEYS, autoDialogDetail } from '../i18n/autoCopy';

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
  // [V2] UX2 14.6: PowerShell commands are constants, never translated; UX2 14.5 "+{{count}}" is a bare number
  'cli.command.claudeInstall',
  'cli.command.claudeUpdate',
  'cli.command.agyInstall',
  'download.more',
  // [V2] V2-W1-12: vendor and product names stay Latin in both languages (UX2 14 style note 3); "{{name}} {{percent}} %"
  // is two interpolations and a unit sign
  'cli.name.claude_cli',
  'cli.name.antigravity_cli',
  'cli.vendor.claude_cli',
  'cli.vendor.antigravity_cli',
  'download.downloadingShort',
];

/** The ONLY markup allowed in a value: bidi isolation rendered through <Trans> (UX 15.1, build-plan W1-14 brief).
 *  [V2] + the self-closing <arrow/> of the Change line (UX2 14.1 change.line.*; rendered by <Trans components={{arrow}}>). */
const ALLOWED_TAG_RE = /^(<\/?bdi(?: dir="ltr")?>|<arrow\/>)$/;

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
    // [V2] v2 packages are named V2-W1-NN-<slug> (v2-build-plan 1.2)
    for (const f of LOCALE_FRAGMENT_FILES) expect(f).toMatch(/\/pending\/(V2-)?W[0-9]-[0-9]{2}-[a-z-]+\.json$/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [V2] C2 19 items 12, 13 and 30 (V2-W0-scaffold)
// ---------------------------------------------------------------------------------------------------------------------
describe('v2 locale checklist (C2 19)', () => {
  // item 12: UX2 key families where UX2 defines one (label.badge.*, auto.reason.*, auto.pausedReason.*), label.<group>.* otherwise.
  it.each([
    ['label.badge', BADGES],
    ['auto.reason', AUTO_REASONS],
    ['auto.pausedReason', AUTO_PAUSED_REASONS],
    ['label.cliState', CLI_STATES],
    ['label.voiceStatus', VOICE_STATUSES],
    ['label.imageKind', IMAGE_KINDS],
    ['label.changeKind', CHANGE_KINDS],
  ] as const)('item 12: every value has %s.<value> in both languages', (prefix, values) => {
    for (const v of values) {
      expect(en, `en ${prefix}.${v}`).toHaveProperty(`${prefix}.${v}`);
      expect(he, `he ${prefix}.${v}`).toHaveProperty(`${prefix}.${v}`);
    }
  });

  it('item 13: the five consent kinds have copy at exactly CONSENT_VERSIONS; the Antigravity copy carries the Terms date', () => {
    expect(CONSENT_KINDS).toHaveLength(5);
    for (const kind of CONSENT_KINDS) {
      for (const lng of [en, he]) expect(lng).toHaveProperty(`consent.${kind}.v${CONSENT_VERSIONS[kind]}.accept`);
    }
    const v = CONSENT_VERSIONS.cloud_antigravity_cli;
    for (const lng of [en, he]) {
      const text = Object.entries(lng)
        .filter(([k]) => k.startsWith(`consent.cloud_antigravity_cli.v${v}.`))
        .map(([, t]) => t)
        .join(' ');
      expect(text).toContain(ANTIGRAVITY_TERMS_READ_ON);
    }
  });

  it('item 30: every ErrorAction has a label in both languages', () => {
    for (const a of ERROR_ACTIONS) {
      expect(en).toHaveProperty(`label.errorAction.${a}`);
      expect(he).toHaveProperty(`label.errorAction.${a}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [V2] V2-W1-12 (UX2 4.5.1, 14, 15 items 6 / 7)
// ---------------------------------------------------------------------------------------------------------------------
describe('v2 copy rules (V2-W1-12)', () => {
  it('UX2 4.5.1: the enable dialog bullets ARE the settings bullets (one key list, no dialog-only information)', () => {
    expect(AUTO_HAPPENS_KEYS).toHaveLength(6);
    expect(AUTO_NEVER_KEYS).toHaveLength(6);
    // the settings "What happens" column and the dialog read the same six keys (autoCopy.ts is their only source)
    for (const lng of [en, he]) {
      for (const key of [...AUTO_HAPPENS_KEYS, ...AUTO_NEVER_KEYS]) expect(lng).toHaveProperty(key);
      expect(
        Object.keys(lng)
          .filter((k) => k.startsWith('auto.happens.'))
          .sort(),
      ).toEqual([...AUTO_HAPPENS_KEYS].sort());
      expect(
        Object.keys(lng)
          .filter((k) => k.startsWith('auto.never.'))
          .sort(),
      ).toEqual([...AUTO_NEVER_KEYS].sort());
    }
    const t = (key: string, values?: Record<string, unknown>) =>
      (en[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(values?.[name] ?? ''));
    const detail = autoDialogDetail(t, { validityDays: 30, endsOn: '28 Oct 2026' });
    const lines = detail.split('\n');
    expect(lines.slice(0, 6)).toEqual(AUTO_HAPPENS_KEYS.map((k) => `- ${t(k, { days: 30 })}`));
    expect(lines[6]).toBe('');
    expect(lines[7]).toBe('Ends on 28 Oct 2026.');
    expect(detail).toContain('ends by itself after 30 days');
  });

  it('UX2 15.6: every AUTO_REASONS value renders from auto.reason.* in both files (exhaustive)', () => {
    for (const reason of AUTO_REASONS) {
      expect(en[`auto.reason.${reason}`], reason).toBeTruthy();
      expect(he[`auto.reason.${reason}`], reason).toBeTruthy();
    }
  });

  it('UX2 15.7: "Undo" on a calendar change is "ביטול השינוי" in Hebrew, never the bare "ביטול"', () => {
    expect(he['undo.button']).toBe('ביטול השינוי');
    expect(he['undo.button']).not.toBe(he['action.undo']);
  });

  it('UX2 2.1: every visible downloader file has a plain-words name (never a tier id)', () => {
    for (const id of [...VOICE_TIERS, 'mmproj']) {
      for (const lng of [en, he]) {
        expect(lng[`download.kind.${id}`], `${id}`).toBeTruthy();
        expect(lng[`download.kind.${id}`]).not.toContain(id);
      }
    }
  });

  it('UX2 14 style: counts with a Hebrew dual carry _one / _two / _other where V2-W1-12 adds them', () => {
    for (const base of ['settings.readTools.daysValue', 'auto.scope.validityDays', 'activity.stateOn']) {
      expect(en).toHaveProperty(`${base}_one`);
      expect(en).toHaveProperty(`${base}_other`);
      for (const suffix of ['_one', '_two', '_other']) expect(he).toHaveProperty(`${base}${suffix}`);
    }
  });

  it('ux-i18n-v2-7: the "automatic mode ends in N days" lines are pluralised (1 day, Hebrew dual for 2)', async () => {
    // HealthPill (health.sub.auto.on), SetupStrip row 7 and the AutomaticMode expiring line (setup.auto.expiring) all pass a
    // Math.ceil day count, so the last day of a policy is count = 1 and the day before is count = 2.
    for (const base of ['health.sub.auto.on', 'setup.auto.expiring']) {
      expect(en, `${base} en`).toHaveProperty(`${base}_one`);
      expect(en, `${base} en`).toHaveProperty(`${base}_other`);
      for (const suffix of ['_one', '_two', '_other']) expect(he, `${base} he`).toHaveProperty(`${base}${suffix}`);
    }
    const i18n = i18next.createInstance();
    await i18n.init({
      lng: 'en',
      fallbackLng: false,
      resources: RESOURCES,
      interpolation: { escapeValue: false },
    });
    const tEn = i18n.getFixedT('en');
    const tHe = i18n.getFixedT('he');
    expect(tEn('health.sub.auto.on', { count: 1 })).toBe('Automatic mode: on - ends in 1 day');
    expect(tEn('health.sub.auto.on', { count: 5 })).toBe('Automatic mode: on - ends in 5 days');
    expect(tEn('setup.auto.expiring', { count: 1 })).toBe('Automatic mode ends in 1 day.');
    expect(tEn('setup.auto.expiring', { count: 2 })).toBe('Automatic mode ends in 2 days.');
    for (const key of ['health.sub.auto.on', 'setup.auto.expiring']) {
      expect(tHe(key, { count: 1 }), `${key} he 1`).toContain('בעוד יום אחד');
      expect(tHe(key, { count: 2 }), `${key} he 2`).toContain('בעוד יומיים');
      expect(tHe(key, { count: 5 }), `${key} he 5`).toContain('בעוד 5 ימים');
      for (const n of [1, 2]) expect(tHe(key, { count: n }), `${key} he ${n}`).not.toMatch(/\d ימים/);
    }
  });

  it('the vendor CLI names and vendors exist for every CLI provider, and no copy names the Gemini CLI as a route', () => {
    for (const p of ['claude_cli', 'antigravity_cli']) {
      for (const lng of [en, he]) {
        expect(lng).toHaveProperty(`cli.name.${p}`);
        expect(lng).toHaveProperty(`cli.vendor.${p}`);
        expect(lng).toHaveProperty(`ai.provider.${p}`);
      }
    }
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
