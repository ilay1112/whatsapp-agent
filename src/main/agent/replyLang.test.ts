// TESTS 5.3 row `agent/replyLang.ts`: Hebrew-vs-Latin counting over the last 5 inbound; mixed; emoji/digits only => fallback
// (which the caller has already resolved through own-outgoing -> stored chat.lang -> UI language).
import { describe, expect, it } from 'vitest';
import { detectReplyLang } from './replyLang';

describe('detectReplyLang', () => {
  it('follows the sender, not the UI language', () => {
    expect(detectReplyLang(['מעולה, נתראה שם'], 'en')).toBe('he');
    expect(detectReplyLang(['great, see you there'], 'he')).toBe('en');
  });

  it('weighs the newest inbound message most', () => {
    expect(detectReplyLang(['sure', 'כן', 'כן', 'כן'], 'he')).toBe('en');
    expect(detectReplyLang(['בטח נתראה', 'yes', 'yes'], 'en')).toBe('he');
  });

  it('classifies a mixed message by the majority of strong characters', () => {
    expect(detectReplyLang(['אפשר Zoom ביום שני?'], 'en')).toBe('he');
    expect(detectReplyLang(['Meeting on יום שני?'], 'he')).toBe('en');
  });

  it('returns the fallback when the window carries no letters', () => {
    expect(detectReplyLang(['😀', '17:30', '???'], 'he')).toBe('he');
    expect(detectReplyLang(['😀', '17:30', '???'], 'en')).toBe('en');
    expect(detectReplyLang([], 'he')).toBe('he');
  });

  it('looks at no more than the last five inbound messages', () => {
    const older = 'שלום שלום שלום שלום שלום שלום שלום שלום שלום';
    expect(detectReplyLang(['ok', 'ok', 'ok', 'ok', 'ok', older], 'he')).toBe('en');
    expect(detectReplyLang(['ok', 'ok', 'ok', 'ok', older], 'he')).toBe('he');
  });

  it('a Latin URL inside a Hebrew message does not flip the language', () => {
    expect(detectReplyLang(['תראה פה https://maps.example.com/some/long/latin/path'], 'he')).toBe('he');
  });
});
