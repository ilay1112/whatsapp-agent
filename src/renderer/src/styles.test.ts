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

// [V2] UX2 section 1 (owner V2-W1-12): no new colour tokens; the new states map onto the v1 families, the closed icon
// list grows by five, and the three voice codes (solid / dashed / DOTTED) survive forced colours.
describe('styles.css - v2 recipes (UX2 1.1-1.4)', () => {
  it.each([
    'chip-info',
    'chip-ok',
    'chip-amber',
    'chip-red',
    'chip-shadow',
    'chip-experimental',
    'media-rule',
    'media-caution',
    'change-arrow',
    'event-cancelled',
    'note-amber',
    'disclosure-warn',
    'command-field',
    'icon',
    'icon-mic',
    'icon-image',
    'icon-undo',
    'icon-auto',
    'icon-terminal',
    'icon-alert',
  ])('defines @utility %s', (name) => {
    expect(css).toMatch(new RegExp(`@utility\\s+${name}\\s*\\{`));
  });

  it('adds no colour token beyond the v1 set (UX2 1.2)', () => {
    const tokens = new Set(propertyNames.filter((p) => p.startsWith('--color-')));
    expect(tokens.size).toBe(19);
  });

  it('draws the media rule DOTTED and the shadow chip DASHED, also under forced colours', () => {
    expect(css).toMatch(/@utility media-rule\s*\{[^}]*1px dotted var\(--color-line-strong\)/s);
    expect(css).toMatch(/@utility chip-shadow\s*\{[^}]*1px dashed var\(--color-accent\)/s);
    const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
    expect(forced).toMatch(/\.chip-shadow\s*\{[^}]*border-style:\s*dashed/s);
    expect(forced).toMatch(/\.media-rule\s*\{[^}]*dotted/s);
    expect(css).toMatch(/@utility event-cancelled\s*\{[^}]*line-through/s);
  });

  it('mirrors the undo icon in RTL and no other v2 icon', () => {
    expect(css).toMatch(/@utility icon-undo\s*\{[^}]*&:dir\(rtl\)\s*\{\s*transform:\s*scaleX\(-1\)/s);
    for (const name of ['icon-mic', 'icon-image', 'icon-auto', 'icon-terminal']) {
      const block = css.slice(css.indexOf(`@utility ${name}`)).split('\n}')[0]!;
      expect(block, name).not.toContain(':dir(rtl)');
    }
  });

  it('icons are inline SVG data URIs painted with currentColor - no network, no vendor logo', () => {
    expect(css).toMatch(/@utility icon\s*\{[^}]*background-color:\s*currentColor/s);
    const urls = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]!);
    expect(urls.length).toBeGreaterThanOrEqual(6);
    for (const u of urls) expect(u.startsWith('data:image/svg+xml,')).toBe(true);
  });
});
