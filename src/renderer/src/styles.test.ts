// TESTS section 9 row "Physical-CSS ban" + UX section 2: the token sheet is the one place colours and recipes live,
// and it must be written with logical properties only so one stylesheet serves he (rtl) and en (ltr). Owner W1-14.
// vitest stubs every .css import to '' (even with ?raw) and src/renderer/** may not import node built-ins, so the sheet is
// read through the helper in tests/setup-renderer.ts (owned by this package too).
import { describe, expect, it } from 'vitest';
import { readRepoFile } from '../../../tests/setup-renderer';

const css = readRepoFile('src/renderer/src/styles.css');

/** Every declaration property name in the sheet (custom properties included). */
const propertyNames = [...css.matchAll(/(?:^|[;{}\s])(--?[a-z][a-z0-9-]*)\s*:/g)].map((m) => m[1]!);

describe('styles.css - logical properties only', () => {
  it('declares no physical inset / margin / padding / border property', () => {
    const physical = propertyNames.filter((p) => /(^|-)(left|right)$/.test(p));
    expect(physical, 'use the inline-start / inline-end logical forms').toEqual([]);
  });

  it('never sets text-align or float to a physical side', () => {
    expect(css).not.toMatch(/text-align\s*:\s*(left|right)/);
    expect(css).not.toMatch(/float\s*:\s*(left|right)/);
  });

  it('never sets the CSS direction property (direction comes from <html dir>)', () => {
    expect(propertyNames).not.toContain('direction');
  });
});

describe('styles.css - UX section 2 tokens', () => {
  it('defines every semantic colour token of UX 2.1', () => {
    for (const token of [
      '--color-canvas',
      '--color-surface',
      '--color-quote',
      '--color-line',
      '--color-line-strong',
      '--color-text',
      '--color-text-muted',
      '--color-accent',
      '--color-accent-hover',
      '--color-on-accent',
      '--color-accent-soft',
      '--color-ok',
      '--color-ok-soft',
      '--color-warn',
      '--color-warn-soft',
      '--color-danger',
      '--color-danger-soft',
      '--color-on-danger',
      '--color-scrim',
    ]) {
      expect(propertyNames, token).toContain(token);
    }
  });

  it('defines the six type steps, the radius hierarchy, both shadows and the motion tokens', () => {
    for (const token of [
      '--font-ui',
      '--text-xs',
      '--text-sm',
      '--text-base',
      '--text-md',
      '--text-lg',
      '--text-xl',
      '--radius-xs',
      '--radius-sm',
      '--radius-md',
      '--radius-lg',
      '--shadow-pop',
      '--shadow-sheet',
      '--dur-fast',
      '--dur-base',
      '--ease',
      '--breakpoint-cols',
      '--breakpoint-roomy',
    ]) {
      expect(propertyNames, token).toContain(token);
    }
  });

  it('bundles no font and uses Segoe UI as the first family', () => {
    expect(css).toMatch(/--font-ui:\s*"Segoe UI"/);
    expect(css).not.toMatch(/@font-face/);
  });

  it('never uses italics, uppercase or letter-spacing (UX 2.2)', () => {
    expect(propertyNames).not.toContain('font-style');
    expect(propertyNames).not.toContain('letter-spacing');
    expect(css).not.toMatch(/text-transform\s*:\s*uppercase/);
  });

  it('overrides the type scale for Hebrew and the colours for dark mode and forced colours', () => {
    expect(css).toContain(':root:lang(he)');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('exposes --dir for the transforms that do not flip on their own (UX 2.4)', () => {
    expect(css).toMatch(/:root\s*\{[^}]*--dir:\s*1/s);
    expect(css).toContain(':root:dir(rtl)');
  });
});

describe('styles.css - shared class recipes (UX 2.6 names are normative)', () => {
  it.each([
    'btn',
    'btn-primary',
    'btn-outline',
    'btn-quiet',
    'btn-danger',
    'icon-btn',
    'field',
    'chip',
    'pill',
    'focus-ring',
  ])('defines @utility %s', (name) => {
    expect(css).toMatch(new RegExp(`@utility\\s+${name}\\s*\\{`));
  });

  it('defines .msg-text with plaintext bidi so untrusted text keeps its own direction', () => {
    expect(css).toMatch(/\.msg-text\s*\{[^}]*unicode-bidi:\s*plaintext/s);
  });

  it('mirrors only the directional icon helper', () => {
    expect(css).toContain('.icon-dir:dir(rtl)');
  });
});
