// SCRATCH verification of review finding injection-5. Not part of npm test.
import { describe, expect, it } from 'vitest';
import { sanitizeForModel } from '../../../src/main/agent/sanitize';
import { scrubDraft } from '../../../src/main/agent/validate';
import { stripInvisible } from '../../../src/shared/schemas';

describe('V1 NFKC folding of dot-like separators', () => {
  it('records what NFKC actually does', () => {
    const map = {
      'U+3002': '\u3002'.normalize('NFKC'),
      'U+FF61': '\uFF61'.normalize('NFKC'),
      'U+FF0E': '\uFF0E'.normalize('NFKC'),
      'U+2024': '\u2024'.normalize('NFKC'),
      'U+00B7': '\u00B7'.normalize('NFKC'),
      'U+2027': '\u2027'.normalize('NFKC'),
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(Object.fromEntries(Object.entries(map).map(([k, v]) => [k, [...v].map(c => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase()).join(' ')]))));
    expect(map['U+FF0E']).toBe('.');   // fullwidth full stop DOES fold
    expect(map['U+2024']).toBe('.');   // one dot leader DOES fold
    expect(map['U+3002']).toBe('\u3002'); // ideographic full stop does NOT
    expect(map['U+FF61']).toBe('\u3002'); // halfwidth -> ideographic, still not '.'
  });
});

describe('V2 which variants actually slip the input mask', () => {
  const cases = ['evil.com/x', 'evil\uFF0Ecom/x', 'evil\u2024com/x', 'evil\u3002com/x', 'evil\uFF61com/x'];
  it('reports linkRemoved per variant', () => {
    const rows = cases.map((c) => {
      const r = sanitizeForModel('the deal is at ' + c);
      return { in: JSON.stringify(c), masked: r.text.includes('[link]'), linkRemoved: r.linkRemoved, out: JSON.stringify(r.text) };
    });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(rows, null, 1));
    expect(rows[0]!.linkRemoved).toBe(true);
    expect(rows[1]!.linkRemoved).toBe(true);  // NFKC saves us
    expect(rows[2]!.linkRemoved).toBe(true);  // NFKC saves us
    expect(rows[3]!.linkRemoved).toBe(false); // U+3002 slips
    expect(rows[4]!.linkRemoved).toBe(false); // folds to U+3002, still slips
  });
});

describe('V3 the output scrub (scrubDraft) - NOTE: no NFKC here at all', () => {
  const cases = ['evil.com/x', 'evil\uFF0Ecom/x', 'evil\u2024com/x', 'evil\u3002com/x'];
  it('reports linkRemoved per variant', () => {
    const rows = cases.map((c) => {
      const s = scrubDraft('sure, see ' + c + ' for details', []);
      return { in: JSON.stringify(c), linkRemoved: s.linkRemoved, out: JSON.stringify(s.text) };
    });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(rows, null, 1));
    expect(rows[0]!.linkRemoved).toBe(true);
    expect(rows[3]!.linkRemoved).toBe(false);
  });
});

describe('V4 does anything downstream strip it before the wire?', () => {
  it('stripInvisible leaves U+3002 untouched', () => {
    expect(stripInvisible('evil\u3002com/x')).toBe('evil\u3002com/x');
  });
});

describe('V5 scheme-bearing homoglyph still caught?', () => {
  it('http:// prefix is matched regardless of the separator', () => {
    const r = sanitizeForModel('go to http://evil\u3002com/x now');
    // eslint-disable-next-line no-console
    console.log('scheme case ->', JSON.stringify(r.text), r.linkRemoved);
    expect(r.linkRemoved).toBe(true);
  });
  it('www. prefix is matched regardless of the separator', () => {
    const r = sanitizeForModel('go to www\u3002evil\u3002com now');
    // eslint-disable-next-line no-console
    console.log('www case ->', JSON.stringify(r.text), r.linkRemoved);
    expect(r.linkRemoved).toBe(false); // www. needs the ASCII dot too
  });
});
