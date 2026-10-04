// src/main/db/repos/proposals.ts - Repos['proposals'] implementation over the Db wrapper (owner W1-04). Signatures: CONTRACTS 15.1.
// [V2] provenance columns + read rules (C2 16.1): V2-W1-01-db. v1 extraction_json rows are read with StoredExtractionSchema (rows.ts).
import { EventDeltaSchema, ImageReadSchema } from '../../../shared/schemas';
import type * as T from '../../../shared/types';
import { RepoContractError } from '../errors';
import type { Db, ProposalProvenanceKey, Repos } from '../index';
import { PROPOSAL_COLUMNS, type ProposalRow, toProposal, intOf } from './rows';

export type ProposalsRepo = Repos['proposals'];

/** [V2 W0] Fail-closed defaults for an omitted provenance field (never automatic: no user participation, unproven CLI). */
export function provenanceDefaults(provider: T.ProviderId | 'user'): Pick<T.Proposal, ProposalProvenanceKey> {
  return {
    delta: null,
    imageRead: null,
    blockedCalls: 0,
    providerClass:
      provider === 'claude' || provider === 'gemini'
        ? 'api_key'
        : provider === 'claude_cli' || provider === 'antigravity_cli'
          ? 'cli_unproven'
          : 'local',
    contextFromMeRecent: false,
    crossChatRows: 0,
    triggerAuthor: 'contact',
  };
}

const isCount = (n: number): boolean => Number.isInteger(n) && n >= 0;

function stripUndefined<O extends object>(o: O): O {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as O;
}

export function createProposalsRepo(db: Db): ProposalsRepo {
  const byId = (id: number): import('../../../shared/types').Proposal => {
    const row = db.prepare<ProposalRow>(`SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE id = ?`).get(id)!;
    return toProposal(row);
  };
  return {
    /** version = max + 1 for the item; every older version of the same item is marked superseded in the same transaction. */
    insertNext(input) {
      const p = { ...provenanceDefaults(input.provider), ...stripUndefined(input) };
      // [V2-W1-01] B25 provenance is written ONCE and read by AutoGate without recomputation, so it is validated on the way in as
      // well as on the way out (rows.ts storedDelta / storedImageRead): a malformed delta or picture read never reaches the table.
      if (p.delta !== null) p.delta = EventDeltaSchema.parse(p.delta);
      if (p.imageRead !== null) p.imageRead = ImageReadSchema.parse(p.imageRead);
      if (!isCount(p.blockedCalls) || !isCount(p.crossChatRows))
        throw new RepoContractError('proposal provenance counts must be non-negative integers');
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
                                 freebusy_json, suspicious, created_at, superseded_at,
                                 delta_json, image_json, blocked_calls, provider_class, context_from_me_recent, cross_chat_rows,
                                 trigger_author)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
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
            // [V2] B25 provenance columns (migration v4) - written once, here
            p.delta === null ? null : JSON.stringify(p.delta),
            p.imageRead === null ? null : JSON.stringify(p.imageRead),
            p.blockedCalls,
            p.providerClass,
            intOf(p.contextFromMeRecent),
            p.crossChatRows,
            p.triggerAuthor,
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
