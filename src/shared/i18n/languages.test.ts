// TESTS section 9 row "Language resolution": `system` + ['he-IL'], ['iw'], ['en-US','he'], [], unsupported => 'en'.
import { describe, expect, it } from 'vitest';
import { SUPPORTED, dirFor, isUiLang, localeFor, resolveLanguage } from './languages';

describe('resolveLanguage', () => {
  it('an explicit setting always wins, whatever Windows reports', () => {
    expect(resolveLanguage('he', ['en-US'])).toBe('he');
    expect(resolveLanguage('en', ['he-IL'])).toBe('en');
    expect(resolveLanguage('he', [])).toBe('he');
  });
  it.each([
    [['he-IL'], 'he'],
    [['iw'], 'he'], // legacy ISO 639-1 tag for Hebrew
    [['IW-IL'], 'he'], // case-insensitive
    [['he'], 'he'],
    [['en-US', 'he'], 'en'], // first supported entry wins
    [['he-IL', 'en-US'], 'he'],
    [['fr-FR', 'he-IL'], 'he'], // unsupported entries are skipped, not fatal
    [['ru-RU'], 'en'],
    [[], 'en'],
    [[''], 'en'],
  ])('system + %j => %s', (preferred, expected) => {
    expect(resolveLanguage('system', preferred as string[])).toBe(expected);
  });
});

describe('localeFor / dirFor', () => {
  it('maps the two UI languages to Israeli locales', () => {
    expect(localeFor('he')).toBe('he-IL');
    expect(localeFor('en')).toBe('en-IL');
  });
  it('Hebrew is rtl, English is ltr', () => {
    expect(dirFor('he')).toBe('rtl');
    expect(dirFor('en')).toBe('ltr');
  });
});

describe('SUPPORTED / isUiLang', () => {
  it('holds exactly the two shipped languages', () => {
    expect([...SUPPORTED]).toEqual(['en', 'he']);
  });
  it('narrows unknown input', () => {
    expect(isUiLang('he')).toBe(true);
    expect(isUiLang('en')).toBe(true);
    expect(isUiLang('iw')).toBe(false);
    expect(isUiLang(undefined)).toBe(false);
    expect(isUiLang(7)).toBe(false);
  });
});
