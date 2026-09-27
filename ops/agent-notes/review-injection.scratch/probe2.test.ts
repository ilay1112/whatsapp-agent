// SCRATCH probes 2 - masking bypasses. Not part of npm test.
import { describe, expect, it } from 'vitest';
import { sanitizeForModel } from '../../../src/main/agent/sanitize';
import { scrubDraft } from '../../../src/main/agent/validate';

describe('P4  non-ASCII digits defeat the phone mask (no [number], no personal_details badge)', () => {
  it('ASCII form is masked', () => {
    const r = sanitizeForModel('call me 0521234567');
    expect(r.text).toBe('call me [number]');
    expect(r.personalDetails).toBe(true);
  });
  it('Arabic-Indic form is NOT masked and raises no badge', () => {
    const r = sanitizeForModel('call me \u0660\u0665\u0662\u0661\u0662\u0663\u0664\u0665\u0666\u0667');
    expect(r.text).toContain('\u0660\u0665\u0662');       // digits reach the cloud provider verbatim
    expect(r.personalDetails).toBe(false);                 // and the card shows no personal_details badge
  });
  it('and the draft scrub does not see them either', () => {
    const s = scrubDraft('sure, ring me on \u0660\u0665\u0662\u0661\u0662\u0663\u0664\u0665\u0666\u0667', []);
    expect(s.personalDetails).toBe(false);
    expect(s.text).toContain('\u0660');
  });
});

describe('P5  a U+3002 host separator defeats BOTH link gates', () => {
  it('ASCII dot is masked on the way in and stripped on the way out', () => {
    expect(sanitizeForModel('see evil.com/x').text).toBe('see [link]');
    expect(scrubDraft('see evil.com/x', []).text).toBe('see');
    expect(scrubDraft('see evil.com/x', []).linkRemoved).toBe(true);
  });
  it('U+3002 (ideographic full stop) survives NFKC, the input mask AND the draft scrub', () => {
    const inbound = sanitizeForModel('see evil\u3002com/x');
    expect(inbound.text).toBe('see evil\u3002com/x');
    expect(inbound.linkRemoved).toBe(false);
    const out = scrubDraft('see evil\u3002com/x', []);
    expect(out.text).toBe('see evil\u3002com/x'); // reaches the approved draft verbatim
    expect(out.linkRemoved).toBe(false);          // and raises no link_removed badge
  });
});
