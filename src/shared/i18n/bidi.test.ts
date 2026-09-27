// TESTS section 9 row "Bidi/format helpers": detectLanguage / detectDir on the fixture strings of i18n-rtl.md 6.6.
// The fixture strings are synthetic sample content (T5), never real message text.
import { describe, expect, it } from 'vitest';
import { FSI, LRI, PDI, detectDir, detectLanguage, isolate, ltr } from './bidi';

const HEBREW_SENTENCE = 'נתראה מחר בבוקר';
const MIXED_HEBREW_FIRST = 'אפשר Zoom ביום שני?';
const MIXED_LATIN_FIRST = 'OK נתראה ב-17:30 ב-Aroma';

describe('isolate / ltr', () => {
  it('wraps in FSI...PDI and LRI...PDI using the real control characters', () => {
    expect(FSI.codePointAt(0)).toBe(0x2068);
    expect(LRI.codePointAt(0)).toBe(0x2066);
    expect(PDI.codePointAt(0)).toBe(0x2069);
    expect(isolate('Dana')).toBe(`${FSI}Dana${PDI}`);
    expect(ltr('+972 54-123-4567')).toBe(`${LRI}+972 54-123-4567${PDI}`);
  });
  it('wraps an empty value too, so callers never branch', () => {
    expect(isolate('')).toBe(`${FSI}${PDI}`);
    expect(ltr('')).toBe(`${LRI}${PDI}`);
  });
  it('nests without losing the outer isolate', () => {
    expect(isolate(ltr('v1.2.3'))).toBe(`${FSI}${LRI}v1.2.3${PDI}${PDI}`);
  });
});

describe('detectDir', () => {
  it.each([
    [HEBREW_SENTENCE, 'rtl'],
    ['Let us meet at five', 'ltr'],
    [MIXED_HEBREW_FIRST, 'rtl'], // more Hebrew letters than Latin
    [MIXED_LATIN_FIRST, 'rtl'], // first-strong would say ltr; the majority rule says rtl
    ['', 'ltr'], // no strong characters at all
    ['17:30 - 18:00', 'ltr'],
    ['😀 🎉', 'ltr'],
  ])('%j => %s', (text, expected) => {
    expect(detectDir(text)).toBe(expected);
  });
  it('ignores Latin characters that only appear inside a URL', () => {
    expect(detectDir('תסתכל https://example.com/a/very/long/latin/path?x=1')).toBe('rtl');
    expect(detectDir('https://example.com/a/very/long/latin/path?x=1')).toBe('ltr');
  });
  it('a tie with Hebrew present is rtl', () => {
    expect(detectDir('ab גד')).toBe('rtl');
  });
});

describe('detectLanguage', () => {
  it('counts Hebrew vs Latin over the window, newest first', () => {
    expect(detectLanguage([HEBREW_SENTENCE], 'en')).toBe('he');
    expect(detectLanguage(['see you tomorrow'], 'he')).toBe('en');
  });
  it('weighs the newest message most', () => {
    // newest is English, four older ones are Hebrew but each carries a smaller weight
    expect(detectLanguage(['okay', 'כן', 'כן', 'כן', 'כן'], 'he')).toBe('en');
    expect(detectLanguage(['ok', 'בסדר גמור נתראה', 'כן'], 'en')).toBe('he');
  });
  it('falls back when the window has no letters at all', () => {
    expect(detectLanguage(['😀', '123', '!!!'], 'he')).toBe('he');
    expect(detectLanguage(['😀', '123', '!!!'], 'en')).toBe('en');
    expect(detectLanguage([], 'he')).toBe('he');
  });
  it('a URL never decides the language', () => {
    expect(detectLanguage(['תראה https://some-english-domain.example/with/latin/path'], 'en')).toBe('he');
  });
  it('looks at no more than the last five messages', () => {
    const texts = ['ok', 'ok', 'ok', 'ok', 'ok', 'שלום שלום שלום שלום שלום שלום שלום שלום'];
    expect(detectLanguage(texts, 'he')).toBe('en'); // the Hebrew entry is outside the window
    expect(detectLanguage(texts.slice(4), 'he')).toBe('he');
  });
  it('a tie goes to Hebrew (the disjoint-script rule of i18n-rtl.md 10.1)', () => {
    expect(detectLanguage(['ab גד'], 'en')).toBe('he');
  });
  it('transliterated Hebrew in Latin letters is classified en - documented v1 gap', () => {
    expect(detectLanguage(['ma kore, nipagesh machar?'], 'he')).toBe('en');
  });
});
