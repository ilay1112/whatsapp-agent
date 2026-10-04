// T2 5 row `db/*`: transcripts (B18) - keyed (chat_jid, wa_msg_id), upsert replaces the row (a retry overwrites a failure), enum and
// range checks; retention NULLs the text (db/retention.test.ts).
import { afterEach, describe, expect, it } from 'vitest';
import type * as T from '../../../shared/types';
import { RepoContractError } from '../errors';
import { cleanup, JID_A, JID_B, memRepos, T0 } from '../__fixtures__/testDb';

afterEach(cleanup);

const row = (over: Partial<T.TranscriptRecord> = {}): T.TranscriptRecord => ({
  chatJid: JID_A,
  waMsgId: 'SYN-VOICE-1',
  status: 'done',
  text: 'synthetic transcript',
  language: 'he',
  seconds: 12.5,
  modelLabel: 'voice-hebrew',
  errorCode: null,
  createdAt: T0,
  ...over,
});

describe('repos.transcripts', () => {
  it('get / upsert round-trip; the key is (chat, message)', () => {
    const { repos } = memRepos();
    expect(repos.transcripts.get(JID_A, 'SYN-VOICE-1')).toBeNull();
    repos.transcripts.upsert(row());
    repos.transcripts.upsert(row({ chatJid: JID_B, text: 'other chat' }));
    expect(repos.transcripts.get(JID_A, 'SYN-VOICE-1')).toEqual(row());
    expect(repos.transcripts.get(JID_B, 'SYN-VOICE-1')!.text).toBe('other chat');
  });

  it('upsert replaces the whole row (a failed transcription retried later)', () => {
    const { repos } = memRepos();
    repos.transcripts.upsert(row({ status: 'failed', text: null, language: null, errorCode: 'VOICE_LOCAL_FAILED' }));
    repos.transcripts.upsert(row({ createdAt: T0 + 5 }));
    expect(repos.transcripts.get(JID_A, 'SYN-VOICE-1')).toEqual(row({ createdAt: T0 + 5 }));
  });

  it('refuses an unknown status and negative / non-finite seconds', () => {
    const { repos } = memRepos();
    expect(() => repos.transcripts.upsert(row({ status: 'maybe' as T.TranscriptStatus }))).toThrow(RepoContractError);
    expect(() => repos.transcripts.upsert(row({ seconds: -1 }))).toThrow(RepoContractError);
    expect(() => repos.transcripts.upsert(row({ seconds: Number.POSITIVE_INFINITY }))).toThrow(RepoContractError);
  });
});
