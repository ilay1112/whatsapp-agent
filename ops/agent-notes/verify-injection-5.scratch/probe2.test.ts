// SCRATCH: does buildCreateEventArgs' cleanField really "share the ASCII-only assumption"?
import { describe, expect, it } from 'vitest';
const URL_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*/gi;
const clean = (raw: string): string => raw.replace(URL_RE, ' ').replace(/\s+/g, ' ').trim();
describe('V6 event summary scrub', () => {
  it('bare ASCII domain is ALREADY not stripped there - homoglyph changes nothing', () => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify([clean('meet at evil.com/x'), clean('meet at evil\u3002com/x'), clean('meet at http://evil.com/x'), clean('meet at www.evil.com')]));
    expect(clean('meet at evil.com/x')).toBe('meet at evil.com/x');       // ASCII bare domain survives too
    expect(clean('meet at evil\u3002com/x')).toBe('meet at evil\u3002com/x');
    expect(clean('meet at http://evil.com/x')).toBe('meet at');
  });
});
