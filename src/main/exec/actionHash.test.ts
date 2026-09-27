// src/main/exec/actionHash.test.ts - TESTS 5.3 row exec/*: "actionHash canonical JSON is key-order independent and Unicode-stable".
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../shared/schemas';
import { sha256Hex, verifyShownHash } from './actionHash';

describe('sha256Hex', () => {
  it('is the known-answer sha256 of the UTF-8 bytes', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes the UTF-8 encoding, not UTF-16 (Hebrew + emoji stay stable)', () => {
    // The same string reached through two different JS literals must hash identically.
    expect(sha256Hex('קפה')).toBe(sha256Hex('קפה'));
    expect(sha256Hex('a\u{1F600}')).toHaveLength(64);
  });
});

describe('verifyShownHash', () => {
  const payload = { v: 1, kind: 'send_reply', itemId: 1, chatRef: 2, proposalVersion: 1, text: 'hi' };

  it('accepts the hash of the canonical JSON and is key-order independent', () => {
    const a = canonicalJson(payload);
    const b = canonicalJson({ text: 'hi', proposalVersion: 1, chatRef: 2, itemId: 1, kind: 'send_reply', v: 1 });
    expect(a).toBe(b);
    expect(verifyShownHash(a, sha256Hex(b))).toBe(true);
  });

  it('rejects a wrong, differently-cased, short or non-hex hash', () => {
    const json = canonicalJson(payload);
    const good = sha256Hex(json);
    expect(verifyShownHash(json, sha256Hex('other'))).toBe(false);
    expect(verifyShownHash(json, good.toUpperCase())).toBe(false);
    expect(verifyShownHash(json, good.slice(0, 63))).toBe(false);
    expect(verifyShownHash(json, `${good.slice(0, 63)}z`)).toBe(false);
  });

  it('refuses an action whose canonical JSON was nulled by retention', () => {
    expect(verifyShownHash('', sha256Hex(''))).toBe(false);
  });
});
