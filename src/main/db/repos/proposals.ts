// src/main/db/repos/proposals.ts - Repos['proposals'] implementation over the Db wrapper (owner W1-04). Signatures: CONTRACTS 15.1.
import type { Db, Repos } from '../index';
import { PROPOSAL_COLUMNS, type ProposalRow, toProposal, intOf } from './rows';

export type ProposalsRepo = Repos['proposals'];

export function createProposalsRepo(db: Db): ProposalsRepo {
  const byId = (id: number): import('../../../shared/types').Proposal => {
    const row = db.prepare<ProposalRow>(`SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE id = ?`).get(id)!;
    return toProposal(row);
  };
  return {
    /** version = max + 1 for the item; every older version of the same item is marked superseded in the same transaction. */
    insertNext(p) {
      return db.transaction(() => {
        const max = db
          .prepare<{ v: number | null }>(`SELECT MAX(version) AS v FROM proposals WHERE item_id = ?`)
          .get(p.itemId)!.v;
        const version = (max ?? 0) + 1;
        db.prepare(`UPDATE proposals SET superseded_at = ? WHERE item_id = ? AND superseded_at IS NULL`).run(
          p.createdAt,
          p.itemId,
        );
        const info = db
          .prepare(
            `INSERT INTO proposals(item_id, version, provider, model, extraction_json, draft_text, reply_lang, event_json,
                                 freebusy_json, suspicious, created_at, superseded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            p.itemId,
            version,
            p.provider,
            p.model,
            p.extraction === null ? null : JSON.stringify(p.extraction),
            p.draftText,
            p.replyLang,
            p.event === null ? null : JSON.stringify(p.event),
            p.freeBusy === null ? null : JSON.stringify(p.freeBusy),
            intOf(p.suspicious),
            p.createdAt,
          );
        return byId(info.lastInsertRowid);
      });
    },
    current(itemId) {
      const row = db
        .prepare<ProposalRow>(
          `SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE item_id = ? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1`,
        )
        .get(itemId);
      return row ? toProposal(row) : null;
    },
  };
}
