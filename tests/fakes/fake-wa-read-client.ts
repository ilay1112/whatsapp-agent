// tests/fakes/fake-wa-read-client.ts - [V2] recording double of WaReadClient (T2 3.5) ONLY for toolGate.test.ts unit
// cases about budgets / pinning where the SQL is irrelevant. NEVER used by a test that claims a safety property (T2 5.2:
// WaReadClient is on the never-mock list - those tests run the REAL facade over tests/fakes/fake-bridge-db.ts via waWorld.ts).
// Owner V2-W1-05-wa-toolserver. Scripted answers are computed from `script.messages` (every message belongs to the chat given by
// `script.chatOfRow`, default: the trigger chat passed to context(), or chat 1 elsewhere); no window / policy logic lives here.
import type { WaChatSummary, WaReadClient, WaReadQuery, WaScope } from '../../src/main/bridge/waReadClient.ts';
import type { ChatRef, Message } from '../../src/shared/types.ts';

export interface FakeWaReadCall {
  method: keyof WaReadClient;
  args: unknown[];
}
export interface FakeWaReadScript {
  recentChats?: WaChatSummary[];
  messages?: Message[];
  /** [W1-05] chat of a scripted row (default: the chat the call names, or the trigger chat for context()). */
  chatOfRow?: (rowid: number) => ChatRef | null;
  /** [W1-05] every method throws this error (an outage below the gate). */
  throws?: Error;
}

/** A plain scripted Message (synthetic, T5). */
export function fakeWaMessage(rowid: number, text: string, over: Partial<Message> = {}): Message {
  return {
    rowid,
    waMsgId: `FAKEMSG${rowid}`,
    chatJid: '972550000001@s.whatsapp.net',
    senderUser: '972550000001',
    text,
    ts: Date.UTC(2026, 8, 20, 9, 0, 0) + rowid * 60_000,
    fromMe: false,
    mediaType: '',
    deleted: false,
    ...over,
  };
}

export class FakeWaReadClient implements WaReadClient {
  readonly calls: FakeWaReadCall[] = [];
  constructor(readonly script: FakeWaReadScript = {}) {}
  private record(method: keyof WaReadClient, args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.script.throws) throw this.script.throws;
  }
  private sorted(): Message[] {
    return [...(this.script.messages ?? [])].sort((a, b) => a.rowid - b.rowid);
  }
  private chatOf(rowid: number, fallback: ChatRef): ChatRef | null {
    return this.script.chatOfRow ? this.script.chatOfRow(rowid) : fallback;
  }
  recentChats(q: WaReadQuery, n: number): WaChatSummary[] {
    this.record('recentChats', [q, n]);
    return (this.script.recentChats ?? []).slice(0, n);
  }
  chatMessages(chatId: ChatRef, beforeRowid: number | null, n: number, q: WaReadQuery): Message[] {
    this.record('chatMessages', [chatId, beforeRowid, n, q]);
    const rows = this.sorted().filter(
      (m) => (beforeRowid === null || m.rowid < beforeRowid) && this.chatOf(m.rowid, chatId) === chatId,
    );
    return rows.slice(Math.max(0, rows.length - n));
  }
  search(needle: string, chatId: ChatRef | null, n: number, q: WaReadQuery, scope: WaScope): Message[] {
    this.record('search', [needle, chatId, n, q, scope]);
    if (chatId === null && scope !== 'all_chats') return [];
    return this.sorted()
      .reverse()
      .filter((m) => m.text.includes(needle) && (chatId === null || this.chatOf(m.rowid, chatId) === chatId))
      .slice(0, n);
  }
  context(
    rowid: number,
    before: number,
    after: number,
    q: WaReadQuery,
    scope: WaScope,
    triggerChatId: ChatRef,
  ): { chatId: ChatRef; target: Message; before: Message[]; after: Message[] } | null {
    this.record('context', [rowid, before, after, q, scope, triggerChatId]);
    const rows = this.sorted();
    const i = rows.findIndex((m) => m.rowid === rowid);
    if (i < 0) return null;
    const chatId = this.chatOf(rowid, triggerChatId);
    if (chatId === null || (scope !== 'all_chats' && chatId !== triggerChatId)) return null;
    const same = (m: Message): boolean => this.chatOf(m.rowid, triggerChatId) === chatId;
    const older = rows.slice(0, i).filter(same);
    return {
      chatId,
      target: rows[i]!,
      before: before === 0 ? [] : older.slice(-before),
      after: rows
        .slice(i + 1)
        .filter(same)
        .slice(0, after),
    };
  }
}
