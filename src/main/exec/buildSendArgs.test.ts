// src/main/exec/buildSendArgs.test.ts - TESTS 5.3 row exec/*: "buildSendArgs output keys exactly {recipient,message}".
import { describe, expect, it } from 'vitest';
import { LIMITS } from '../../shared/types';
import { NotSendableError, SendTextInvalidError, buildSendArgs } from './buildSendArgs';

const JID = '972550000001@s.whatsapp.net';

describe('buildSendArgs', () => {
  it('emits exactly the two wire keys', () => {
    const args = buildSendArgs(JID, 'see you at 17:00');
    expect(Object.keys(args).sort()).toEqual(['message', 'recipient']);
    expect(args).toEqual({ recipient: JID, message: 'see you at 17:00' });
  });

  it('strips invisible characters from the message', () => {
    const args = buildSendArgs(JID, 'ok​‮then');
    expect(args.message).toBe('okthen');
  });

  it('refuses every non-DM recipient', () => {
    for (const jid of [
      '12345@lid',
      'hello@s.whatsapp.net',
      '1234@s.whatsapp.net',
      '',
      `${JID} `,
      '972550000001@g.us',
    ]) {
      expect(() => buildSendArgs(jid, 'x')).toThrow(NotSendableError);
    }
  });

  it('refuses an empty or over-long approved text', () => {
    expect(() => buildSendArgs(JID, '')).toThrow(SendTextInvalidError);
    expect(() => buildSendArgs(JID, '​')).toThrow(SendTextInvalidError);
    expect(() => buildSendArgs(JID, 'x'.repeat(LIMITS.draftChars + 1))).toThrow(SendTextInvalidError);
    expect(buildSendArgs(JID, 'x'.repeat(LIMITS.draftChars)).message).toHaveLength(LIMITS.draftChars);
  });
});
