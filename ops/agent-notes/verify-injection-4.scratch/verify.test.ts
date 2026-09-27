// SCRATCH verification of review finding injection-4. Not part of npm test. No project file is modified.
import { describe, expect, it } from 'vitest';
import { sanitizeForModel } from '../../../src/main/agent/sanitize';
import { scrubDraft } from '../../../src/main/agent/validate';
import { buildContext } from '../../../src/main/agent/contextBuilder';
import type { Message } from '../../../src/shared/types';

const AI = '\u0660\u0665\u0662\u0661\u0662\u0663\u0664\u0665\u0666\u0667'; // Arabic-Indic 0521234567
const HE = '\u05EA\u05EA\u05E7\u05E9\u05E8 \u05D0\u05DC\u05D9\u05D9 ';     // "call me"

describe('control: ASCII digits ARE masked', () => {
  it('masks and badges', () => {
    const r = sanitizeForModel(HE + '0521234567');
    expect(r.text).toBe(HE + '[number]');
    expect(r.personalDetails).toBe(true);
  });
});

describe('claim: non-ASCII decimal digits bypass both masks', () => {
  it('sanitizeForModel leaves Arabic-Indic digits verbatim, no badge', () => {
    const r = sanitizeForModel(HE + AI);
    expect(r.text).toBe(HE + AI);
    expect(r.personalDetails).toBe(false);
  });
  it('extended Arabic-Indic (Persian) too', () => {
    const fa = '\u06F0\u06F5\u06F2\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7';
    const r = sanitizeForModel('call ' + fa);
    expect(r.text).toBe('call ' + fa);
    expect(r.personalDetails).toBe(false);
  });
  it('but fullwidth digits ARE folded by NFKC and masked', () => {
    const fw = '\uFF10\uFF15\uFF12\uFF11\uFF12\uFF13\uFF14\uFF15\uFF16\uFF17';
    const r = sanitizeForModel('call ' + fw);
    expect(r.text).toBe('call [number]');
    expect(r.personalDetails).toBe(true);
  });
  it('scrubDraft on the way out also misses them', () => {
    const s = scrubDraft('sure, ring me on ' + AI, []);
    expect(s.personalDetails).toBe(false);
    expect(s.text).toContain(AI);
  });
});

describe('end to end: the digits land in the cloud user message', () => {
  const msg = (text: string): Message => ({
    waMsgId: 'm1', chatJid: '972500000000@s.whatsapp.net', fromMe: false, ts: 1_700_000_000_000,
    text, deleted: false, mediaType: null,
  } as unknown as Message);
  it('buildContext embeds them and raises no personal_details badge', () => {
    const built = buildContext({
      messages: [msg(HE + AI)],
      nonce: 'abcdef0123456789',
      dayTable: [],
      nowIso: '2026-09-23T09:00:00+03:00',
      timeZone: 'Asia/Jerusalem',
      replyLang: 'he',
      stage: 'extract',
    });
    expect(built.userMessage).toContain(AI);
    expect(built.badges).toEqual([]);
  });
  it('ASCII control: badge is raised and the number is gone', () => {
    const built = buildContext({
      messages: [msg(HE + '0521234567')],
      nonce: 'abcdef0123456789',
      dayTable: [],
      nowIso: '2026-09-23T09:00:00+03:00',
      timeZone: 'Asia/Jerusalem',
      replyLang: 'he',
      stage: 'extract',
    });
    expect(built.userMessage).not.toContain('0521234567');
    expect(built.badges).toEqual(['personal_details']);
  });
});
