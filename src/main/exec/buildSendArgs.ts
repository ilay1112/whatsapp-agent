// src/main/exec/buildSendArgs.ts
// Frozen signature pasted verbatim from docs/specs/contracts.md (owner W1-11). Safety-critical: invariant I3 / ARCH A12.
// The recipient is ALWAYS re-derived by the executor from `actions.chat_id`; this builder is the last gate before the wire and
// emits EXACTLY the two keys `recipient` and `message` - never media_path, quoted_* or anything else the bridge would accept.
import { LIMITS, DM_PHONE_JID_RE } from '../../shared/types';
import { stripInvisible } from '../../shared/schemas';
import type { BridgeSendRequest } from '../bridge/sendClient';

/** Thrown when the pinned chat JID is not a sendable DM (an `@lid` chat is copy-only in v1). Mapped to SEND_NOT_SENDABLE. */
export class NotSendableError extends Error {
  constructor() {
    super('not_sendable');
    this.name = 'NotSendableError';
  }
}
/** Thrown when the approved text is empty or over LIMITS.draftChars after stripping. Mapped to BAD_REQUEST. */
export class SendTextInvalidError extends Error {
  constructor() {
    super('send_text_invalid');
    this.name = 'SendTextInvalidError';
  }
}

export function buildSendArgs(chatJid: string, finalText: string): BridgeSendRequest {
  if (!DM_PHONE_JID_RE.test(chatJid)) throw new NotSendableError();
  const message = stripInvisible(finalText);
  if (message.length === 0 || message.length > LIMITS.draftChars) throw new SendTextInvalidError();
  return { recipient: chatJid, message };
}
