// src/main/db/repos/transcripts.ts - Repos['transcripts'] (C2 16.1, [V2 ADD]; owner V2-W1-01-db).
// transcripts (B18): one row per voice message, keyed (chat_jid, wa_msg_id). `text` is UNTRUSTED model output (it reaches only the
// nonce data block and the inert VoiceBubble) and is NULLed by retention after privacy.retentionDays.
import { TRANSCRIPT_STATUSES } from '../../../shared/types';
import { RepoContractError } from '../errors';
import type { Db, Repos } from '../index';
import { TRANSCRIPT_COLUMNS, type TranscriptRow, toTranscript } from './rows';

export type TranscriptsRepo = Repos['transcripts'];

export function createTranscriptsRepo(db: Db): TranscriptsRepo {
  return {
    get(chatJid, waMsgId) {
      const row = db
        .prepare<TranscriptRow>(`SELECT ${TRANSCRIPT_COLUMNS} FROM transcripts WHERE chat_jid = ? AND wa_msg_id = ?`)
        .get(chatJid, waMsgId);
      return row ? toTranscript(row) : null;
    },
    /** Insert or replace the whole row (a retry of a failed/aborted transcription overwrites it). */
    upsert(r) {
      if (!(TRANSCRIPT_STATUSES as readonly string[]).includes(r.status))
        throw new RepoContractError('unknown transcript status');
      if (!Number.isFinite(r.seconds) || r.seconds < 0) throw new RepoContractError('transcript seconds must be >= 0');
      db.prepare(
        `INSERT INTO transcripts(chat_jid, wa_msg_id, status, text, language, seconds, model_label, error_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_jid, wa_msg_id) DO UPDATE SET status = excluded.status, text = excluded.text, language = excluded.language,
                                                      seconds = excluded.seconds, model_label = excluded.model_label,
                                                      error_code = excluded.error_code, created_at = excluded.created_at`,
      ).run(r.chatJid, r.waMsgId, r.status, r.text, r.language, r.seconds, r.modelLabel, r.errorCode, r.createdAt);
    },
  };
}
