// i18n.ts (ARCH 12.3, i18n-rtl.md 4.2): one renderer instance, <html lang dir> from i18next.dir(), and the two
// plain-string bidi formatters used outside JSX.
import { describe, expect, it } from 'vitest';
import { FSI, LRI, PDI, applyDocumentLanguage, addBidiFormatters, dirOf, getI18n, initI18n } from './i18n';

describe('i18n', () => {
  it('maps he to rtl and en to ltr', () => {
    expect(dirOf('he')).toBe('rtl');
    expect(dirOf('en')).toBe('ltr');
  });

  it('applyDocumentLanguage writes lang and dir on <html>', () => {
    applyDocumentLanguage('he');
    expect(document.documentElement.lang).toBe('he');
    expect(document.documentElement.dir).toBe('rtl');
    applyDocumentLanguage('en');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('initialises one instance with the merged resources and flips <html> on changeLanguage', async () => {
    const inst = await initI18n('en');
    expect(inst).toBe(getI18n());
    expect(inst.t('health.ok')).toBe('All running');
    expect(document.documentElement.dir).toBe('ltr');

    await inst.changeLanguage('he');
    expect(document.documentElement.lang).toBe('he');
    expect(document.documentElement.dir).toBe('rtl');
    expect(inst.t('health.ok')).toBe('הכול פועל');

    // a second call returns the same instance and only switches the language
    const again = await initI18n('en');
    expect(again).toBe(inst);
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('registers the bdi / ltr formatters that isolate values interpolated into plain strings', async () => {
    const inst = await initI18n('en');
    addBidiFormatters(inst);
    expect(inst.services.formatter?.format('x', 'bdi', 'en', {})).toBe(`${FSI}x${PDI}`);
    expect(inst.services.formatter?.format('+972 55-000-0001', 'ltr', 'en', {})).toBe(`${LRI}+972 55-000-0001${PDI}`);
  });
});
