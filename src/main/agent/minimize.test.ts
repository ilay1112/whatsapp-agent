// TESTS 5.3 row `agent/minimize.ts`: 12 messages / 6,000 chars, role labels only, no name / number / JID / media
// metadata, relative age labels (I5 - nothing identifying may reach a cloud provider).
import { describe, expect, it } from 'vitest';
import type { Message } from '../../shared/types';
import { LIMITS } from '../../shared/types';
import { minimize, ageLabelFor, sanitizedNonEmpty } from './minimize';

const T0 = 1_790_000_000_000; // fixed epoch; tests never read the wall clock

function msg(over: Partial<Message> & { text: string }): Message {
  return {
    rowid: 1,
    waMsgId: 'WA1',
    chatJid: '972550000001@s.whatsapp.net',
    senderUser: '972550000001',
    ts: T0,
    fromMe: false,
    mediaType: '',
    deleted: false,
    ...over,
  };
}

const series = (n: number, textOf: (i: number) => string = (i) => `m${i}`): Message[] =>
  Array.from({ length: n }, (_, i) =>
    msg({ rowid: i + 1, waMsgId: `WA${i + 1}`, text: textOf(i), ts: T0 - (n - i) * 60_000, fromMe: i % 2 === 1 }),
  );

describe('minimize - window', () => {
  it(`keeps at most LIMITS.contextMessages (${LIMITS.contextMessages}) rows, newest last`, () => {
    const out = minimize(series(20));
    expect(out).toHaveLength(LIMITS.contextMessages);
    expect(out[0]!.text).toBe('m8');
    expect(out.at(-1)!.text).toBe('m19');
  });

  it(`drops from the oldest end until the window fits LIMITS.contextChars (${LIMITS.contextChars})`, () => {
    const out = minimize(series(12, () => 'x'.repeat(900)));
    const total = out.reduce((n, m) => n + m.text.length, 0);
    expect(total).toBeLessThanOrEqual(LIMITS.contextChars);
    expect(out.length).toBeLessThan(12);
    expect(out.length).toBeGreaterThan(0);
  });

  it('never drops the last message, even when it alone exceeds the char budget', () => {
    const out = minimize([msg({ text: 'a'.repeat(LIMITS.messageChars * 2) })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text.endsWith('[truncated]')).toBe(true);
  });

  it('skips deleted, empty and text-free media rows', () => {
    const out = minimize([
      msg({ waMsgId: 'A', text: 'hello' }),
      msg({ waMsgId: 'B', text: 'gone', deleted: true }),
      msg({ waMsgId: 'C', text: '   ' }),
      msg({ waMsgId: 'D', text: '', mediaType: 'image' }),
      msg({ waMsgId: 'E', text: 'caption', mediaType: 'image' }),
    ]);
    expect(out.map((m) => m.text)).toEqual(['hello', 'caption']);
  });

  it('returns nothing for an empty window', () => {
    expect(minimize([])).toEqual([]);
  });
});

describe('minimize - what the model may see', () => {
  it('labels roles `me` / `contact` and never a name, JID, phone number or message id', () => {
    const out = minimize([
      msg({ waMsgId: 'WA-42', text: 'hi from 972550000001, mail me at a@b.co', fromMe: false }),
      msg({ waMsgId: 'WA-43', text: 'sure', fromMe: true }),
    ]);
    expect(out.map((m) => m.role)).toEqual(['contact', 'me']);
    const blob = JSON.stringify(out);
    expect(blob).not.toContain('972550000001');
    expect(blob).not.toContain('@s.whatsapp.net');
    expect(blob).not.toContain('WA-42');
    expect(blob).not.toContain('a@b.co');
    expect(blob).not.toContain('image');
  });

  it('exposes only role / text / ageLabel', () => {
    const [only] = minimize([msg({ text: 'hi' })]);
    expect(Object.keys(only!).sort()).toEqual(['ageLabel', 'role', 'text']);
  });

  it('sanitises every row before it is handed out', () => {
    const out = minimize([msg({ text: 'see https://evil.example/x' })]);
    expect(out[0]!.text).toBe('see [link]');
  });
});

describe('ageLabelFor - relative, never an absolute instant', () => {
  it('formats the documented buckets', () => {
    expect(ageLabelFor(T0, T0)).toBe('now');
    expect(ageLabelFor(T0 - 59_000, T0)).toBe('now');
    expect(ageLabelFor(T0 - 12 * 60_000, T0)).toBe('12 m ago');
    expect(ageLabelFor(T0 - 3 * 3_600_000, T0)).toBe('3 h ago');
    expect(ageLabelFor(T0 - 2 * 86_400_000, T0)).toBe('2 d ago');
    expect(ageLabelFor(null, T0)).toBe('unknown');
  });

  it('anchors the window on its newest message', () => {
    const out = minimize([
      msg({ waMsgId: 'A', text: 'older', ts: T0 - 7_200_000 }),
      msg({ waMsgId: 'B', text: 'newest', ts: T0 }),
    ]);
    expect(out.map((m) => m.ageLabel)).toEqual(['2 h ago', 'now']);
  });

  it('survives a window whose timestamps are all unparseable', () => {
    const out = minimize([msg({ text: 'a', ts: null }), msg({ waMsgId: 'B', text: 'b', ts: null })]);
    expect(out.map((m) => m.ageLabel)).toEqual(['unknown', 'unknown']);
  });
});

describe('sanitizedNonEmpty', () => {
  it('is the selection contextBuilder zips its snapshot against', () => {
    const rows = sanitizedNonEmpty([msg({ waMsgId: 'A', text: 'hi' }), msg({ waMsgId: 'B', text: '', deleted: true })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message.waMsgId).toBe('A');
    expect(rows[0]!.text).toBe('hi');
  });
});
