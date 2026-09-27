// TESTS 5.3 row `app/i18n.ts`: own instance, both languages, the bdi formatter, a throwing missingKeyHandler in dev.
import { afterEach, describe, expect, it } from 'vitest';
import { bdi, createMainI18n, FSI, PDI } from './i18n';

const original = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = original;
});

describe('createMainI18n', () => {
  it('resolves tray and notification keys in English', () => {
    const i18n = createMainI18n('en');
    expect(i18n.t('tray.open')).toBe('Open');
    expect(i18n.t('tray.quit')).toBe('Quit');
    expect(i18n.t('notify.firstHide.title')).toBe('Still running next to the clock');
  });

  it('resolves the same keys in Hebrew and reports rtl', () => {
    const i18n = createMainI18n('he');
    expect(i18n.t('tray.open')).not.toBe('Open');
    expect(i18n.t('tray.open').length).toBeGreaterThan(0);
    expect(i18n.dir()).toBe('rtl');
    expect(createMainI18n('en').dir()).toBe('ltr');
  });

  it('is usable synchronously right after creation (bundled resources)', () => {
    expect(createMainI18n('en').t('app.name')).toBe('WhatsApp Calendar Agent');
  });

  it('two instances are independent - changing one language does not move the other', async () => {
    const a = createMainI18n('en');
    const b = createMainI18n('he');
    await a.changeLanguage('he');
    expect(b.language).toBe('he');
    await b.changeLanguage('en');
    expect(a.language).toBe('he');
  });

  it('counts pluralise (tray tooltip)', () => {
    const i18n = createMainI18n('en');
    expect(i18n.t('tray.tooltipWaiting', { count: 3 })).toBe('WhatsApp Calendar Agent - 3 waiting');
  });

  it('the bdi format wraps an interpolation in FSI ... PDI', () => {
    expect(bdi('שלום')).toBe(`${FSI}שלום${PDI}`);
    const i18n = createMainI18n('en');
    i18n.addResource('en', 'translation', 'test.bdi', 'x {{v, bdi}} y');
    expect(i18n.t('test.bdi', { v: 'שלום' })).toBe(`x ${FSI}שלום${PDI} y`);
  });

  it('a non-bdi format is passed through as text', () => {
    const i18n = createMainI18n('en');
    i18n.addResource('en', 'translation', 'test.plain', 'x {{v, upper}} y');
    expect(i18n.t('test.plain', { v: 'ab' })).toBe('x ab y');
  });

  it('a missing key throws in dev and falls back in production', () => {
    process.env.NODE_ENV = 'development';
    expect(() => createMainI18n('en').t('does.not.exist')).toThrow(/missing locale key/);
    process.env.NODE_ENV = 'production';
    expect(createMainI18n('en').t('does.not.exist')).toBe('does.not.exist');
  });

  it('a Hebrew key missing from he falls back to English rather than to the raw key', () => {
    process.env.NODE_ENV = 'production';
    const i18n = createMainI18n('he');
    i18n.addResource('en', 'translation', 'test.onlyEn', 'only english');
    expect(i18n.t('test.onlyEn')).toBe('only english');
  });
});
