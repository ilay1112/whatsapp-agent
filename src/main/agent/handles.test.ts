// T2 5 row `agent/handles.ts` (I5'): run-scoped opaque handles. Owner V2-W1-05-wa-toolserver.
import { describe, expect, it } from 'vitest';
import { CHAT_HANDLE_RE, MSG_HANDLE_RE, createHandleTable } from './handles';

describe('createHandleTable', () => {
  it('the trigger chat is ALWAYS chat_1, before and after any other chat was seen', () => {
    const t = createHandleTable(42);
    expect(t.triggerChatId).toBe(42);
    expect(t.chatIdOf('chat_1')).toBe(42);
    expect(t.chatHandle(7)).toBe('chat_2');
    expect(t.chatHandle(42)).toBe('chat_1');
    expect(t.chatHandle(9)).toBe('chat_3');
    expect(t.chatHandle(7)).toBe('chat_2'); // stable within the run
    expect([t.chatIdOf('chat_2'), t.chatIdOf('chat_3')]).toEqual([7, 9]);
  });

  it('message handles are allocated in first-seen order and never equal the rowid', () => {
    const t = createHandleTable(1);
    expect(t.msgHandle(9_001)).toBe('m_1');
    expect(t.msgHandle(17)).toBe('m_2');
    expect(t.msgHandle(9_001)).toBe('m_1');
    expect(t.rowidOf('m_1')).toBe(9_001);
    expect(t.rowidOf('m_2')).toBe(17);
  });

  it('no reverse lookup: a syntactically valid handle that was never shown in this run resolves to null', () => {
    const t = createHandleTable(1);
    t.msgHandle(5);
    expect(t.rowidOf('m_2')).toBeNull();
    expect(t.rowidOf('m_5')).toBeNull(); // the rowid itself is not a handle
    expect(t.chatIdOf('chat_2')).toBeNull();
    expect(t.chatIdOf('chat_77')).toBeNull();
  });

  it.each([
    'chat_01',
    'chat_1 ',
    ' chat_1',
    'chat_1\n',
    'chat_99999',
    'chat_0',
    'CHAT_1',
    'chat_-1',
    'chat_1.0',
    'chat_１',
    '',
  ])('rejects the chat handle %j (strict regex before lookup)', (h) => {
    const t = createHandleTable(1);
    for (let i = 2; i < 30; i += 1) t.chatHandle(i);
    expect(t.chatIdOf(h)).toBeNull();
  });
  it.each(['m_01', 'm_1 ', 'm_123456', 'm_0', 'M_1', 'm1', 'm_1\n', ''])('rejects the message handle %j', (h) => {
    const t = createHandleTable(1);
    for (let i = 0; i < 30; i += 1) t.msgHandle(1000 + i);
    expect(t.rowidOf(h)).toBeNull();
  });
  it('non-string input never throws', () => {
    const t = createHandleTable(1);
    expect(t.chatIdOf(1 as unknown as string)).toBeNull();
    expect(t.rowidOf(null as unknown as string)).toBeNull();
  });

  it('a new table per run: run 2 never resolves run 1 handles', () => {
    const run1 = createHandleTable(1);
    const h = run1.msgHandle(123);
    run1.chatHandle(8);
    const run2 = createHandleTable(1);
    expect(run2.rowidOf(h)).toBeNull();
    expect(run2.chatIdOf('chat_2')).toBeNull();
    expect(run2.msgHandle(456)).toBe('m_1');
  });

  it('the regexes are anchored and bounded', () => {
    expect(CHAT_HANDLE_RE.test('chat_9999')).toBe(true);
    expect(CHAT_HANDLE_RE.test('chat_10000')).toBe(false);
    expect(MSG_HANDLE_RE.test('m_99999')).toBe(true);
    expect(MSG_HANDLE_RE.test('m_100000')).toBe(false);
  });
});
