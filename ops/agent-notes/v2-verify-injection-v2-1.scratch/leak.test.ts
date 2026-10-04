import { describe, it, expect } from 'vitest';
import { crossChatLeak } from '../../../src/main/agent/validate';
import { LIMITS } from '../../../src/shared/types';
describe('verify injection-v2-1', () => {
  it('short other-chat row quoted verbatim is NOT flagged (current behaviour)', () => {
    expect(crossChatLeak('Sure! gate code 4242# - see you there', ['gate code 4242#'], LIMITS.crossChatLeakWindow)).toBe(false);
  });
  it('21-char excerpt of a long row is NOT flagged', () => {
    expect(crossChatLeak('ok! the door code is 4242', ['my address is 12 Fake St and the door code is 4242, come by after 8'], LIMITS.crossChatLeakWindow)).toBe(false);
  });
  it('Cyrillic homoglyph copy is NOT flagged', () => {
    expect(crossChatLeak('my аddress is 12 Fаke St аnd the dооr cоde is 4242', ['my address is 12 Fake St and the door code is 4242'], LIMITS.crossChatLeakWindow)).toBe(false);
  });
  it('24-char verbatim IS flagged', () => {
    expect(crossChatLeak('x my address is 12 Fake St and the door', ['my address is 12 Fake St and the door code is 4242'], LIMITS.crossChatLeakWindow)).toBe(true);
  });
});
