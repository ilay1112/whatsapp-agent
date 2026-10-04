// V2-W1-11: static guards over the dashboard lane's own files (UX2 15.2, 15.3, 15.11; T2 5 "Renderer"; build plan 1.2):
//   - no calendar-write or automatic-mode control is bound to `settings:set`, and nothing here enables automatic mode;
//   - no dangerouslySetInnerHTML; the bubbles render no link and no href;
//   - logical properties only: no physical Tailwind utility in the TSX, no left/right property in dashboard.css.
import { describe, expect, it } from 'vitest';
import { readRepoFile } from '../../../../tests/setup-renderer';

const OWNED = [
  'src/renderer/src/store/dashboard.ts',
  'src/renderer/src/store/auto.ts',
  'src/renderer/src/views/Dashboard.tsx',
  'src/renderer/src/components/ItemList.tsx',
  'src/renderer/src/components/ItemCard.tsx',
  'src/renderer/src/components/ItemCard.bdi.tsx',
  'src/renderer/src/components/RawCard.tsx',
  'src/renderer/src/components/RawCard.media.tsx',
  'src/renderer/src/components/DraftBox.tsx',
  'src/renderer/src/components/EventEditor.tsx',
  'src/renderer/src/components/Badges.tsx',
  'src/renderer/src/components/QuotedBubble.tsx',
  'src/renderer/src/components/UndoDismissDrawer.tsx',
  'src/renderer/src/components/AutoStrip.tsx',
  'src/renderer/src/components/ChangeLine.tsx',
  'src/renderer/src/components/ChangeLine.format.ts',
  'src/renderer/src/components/UndoControl.tsx',
  'src/renderer/src/components/VoiceBubble.tsx',
  'src/renderer/src/components/ImageBubble.tsx',
];
/** Source with line comments stripped (the headers explain the rules by naming the very things they forbid). */
const code = (rel: string): string =>
  readRepoFile(rel)
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

describe('dashboard lane - static guards', () => {
  it.each(OWNED)('%s never calls settings:set and never enables automatic mode', (rel) => {
    const src = code(rel);
    expect(src).not.toMatch(/setSettings\s*\(|'settings:set'/);
    expect(src).not.toMatch(
      /requestAutoEnable|resumeAuto|endAutoShadow|'auto:requestEnable'|'auto:resume'|'auto:endShadow'/,
    );
  });

  it.each(OWNED)('%s has no dangerouslySetInnerHTML', (rel) => {
    expect(code(rel)).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it.each(OWNED.filter((f) => f.endsWith('.tsx')))('%s uses no physical Tailwind utility', (rel) => {
    const classes = [...code(rel).matchAll(/className=\{?[`'"]([^`'"]*)[`'"]/g)].map((m) => m[1]!).join(' ');
    expect(classes).not.toMatch(
      /(^|\s)(-?m[lr]|p[lr]|left|right|border-[lr]|rounded-[lr]|rounded-(tl|tr|bl|br)|text-left|text-right|float-left|float-right)(-|\s|$)/,
    );
  });

  it.each([
    'src/renderer/src/components/VoiceBubble.tsx',
    'src/renderer/src/components/ImageBubble.tsx',
    'src/renderer/src/components/QuotedBubble.tsx',
  ])('%s renders no link', (rel) => {
    const src = code(rel);
    expect(src).not.toMatch(/<a[\s>]/);
    expect(src).not.toMatch(/\bhref=/);
    expect(src).not.toMatch(/children/);
  });

  it('dashboard.css uses logical properties only', () => {
    const css = readRepoFile('src/renderer/src/views/dashboard.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const props = [...css.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]!);
    expect(
      props.filter((p) => /(^|-)(left|right)$/.test(p) || /^(margin|padding|border)-(left|right)/.test(p)),
    ).toEqual([]);
    expect(css).not.toMatch(/text-align\s*:\s*(left|right)|float\s*:\s*(left|right)/);
  });
});
