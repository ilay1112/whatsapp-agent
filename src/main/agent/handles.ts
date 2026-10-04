// src/main/agent/handles.ts   ADD (pure; I5') - run-scoped opaque handles; never a JID, a name, a number or a WhatsApp message id
// Owner V2-W1-05-wa-toolserver. One table per run (agent/draft.ts builds it with the RunCtx): a cloud provider can never correlate
// chats or messages across runs, and a model can never forge a handle it was not shown in THIS run (no reverse lookup).
import type { ChatRef } from '../../shared/types';

export const CHAT_HANDLE_RE = /^chat_[1-9][0-9]{0,3}$/;
export const MSG_HANDLE_RE = /^m_[1-9][0-9]{0,4}$/;
export interface HandleTable {
  chatHandle(chatId: ChatRef): string; // 'chat_1', 'chat_2', ... first-seen order within the run ; the trigger chat is ALWAYS 'chat_1'
  chatIdOf(handle: string): ChatRef | null; // CHAT_HANDLE_RE then table lookup ; null = never shown in this run
  msgHandle(rowid: number): string; // 'm_1', 'm_2', ... first-seen order ; never the bridge rowid or messages.id itself
  rowidOf(handle: string): number | null; // MSG_HANDLE_RE then table lookup
  readonly triggerChatId: ChatRef;
}

/** Pure, in-memory, per run. Handles are allocated in first-seen order; the trigger chat is pre-seeded as `chat_1`. */
export function createHandleTable(triggerChatId: ChatRef): HandleTable {
  const chatToHandle = new Map<ChatRef, string>([[triggerChatId, 'chat_1']]);
  const handleToChat = new Map<string, ChatRef>([['chat_1', triggerChatId]]);
  const rowidToHandle = new Map<number, string>();
  const handleToRowid = new Map<string, number>();

  return {
    triggerChatId,
    chatHandle(chatId: ChatRef): string {
      const known = chatToHandle.get(chatId);
      if (known !== undefined) return known;
      const handle = `chat_${chatToHandle.size + 1}`;
      chatToHandle.set(chatId, handle);
      handleToChat.set(handle, chatId);
      return handle;
    },
    chatIdOf(handle: string): ChatRef | null {
      if (typeof handle !== 'string' || !CHAT_HANDLE_RE.test(handle)) return null;
      return handleToChat.get(handle) ?? null;
    },
    msgHandle(rowid: number): string {
      const known = rowidToHandle.get(rowid);
      if (known !== undefined) return known;
      const handle = `m_${rowidToHandle.size + 1}`;
      rowidToHandle.set(rowid, handle);
      handleToRowid.set(handle, rowid);
      return handle;
    },
    rowidOf(handle: string): number | null {
      if (typeof handle !== 'string' || !MSG_HANDLE_RE.test(handle)) return null;
      return handleToRowid.get(handle) ?? null;
    },
  };
}
