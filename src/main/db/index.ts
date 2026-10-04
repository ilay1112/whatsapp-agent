// src/main/db/index.ts
// Frozen signatures verbatim from docs/specs/contracts.md 15.1 (owner W1-04). openDb() is the node:sqlite wrapper (WAL, foreign
// keys, busy timeout, quick_check, migrate + a pre-migration backup); createRepos() assembles the repos of db/repos/*.
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { backupNow } from './backup';
import { migrate } from './migrations';
import { createActionsRepo } from './repos/actions';
import { createAuditRepo } from './repos/audit';
import { createChatsRepo } from './repos/chats';
import { createConsentsRepo } from './repos/consents';
import { createItemsRepo } from './repos/items';
import { createMetaRepo } from './repos/meta';
import { createModelsRepo } from './repos/models';
import { createProposalsRepo } from './repos/proposals';
import { createQueueRepo } from './repos/queue';
import { createRateRepo } from './repos/rate';
import { createRetentionRepo } from './repos/retention';
import { createRunsRepo } from './repos/runs';
import { createSecretsRepo } from './repos/secrets';
import { createSettingsRepo } from './repos/settings';
import { createEventRevisionsRepo } from './repos/eventRevisions'; // [V2 ADD] (C2 16.1)
import { createAutoPoliciesRepo } from './repos/autoPolicies';
import { createAutoDecisionsRepo } from './repos/autoDecisions';
import { createAutoWritesRepo } from './repos/autoWrites';
import { createTranscriptsRepo } from './repos/transcripts';
import { createMediaCacheRepo } from './repos/mediaCache';
import type * as T from '../../shared/types';
import type { Settings, SettingsPatch } from '../../shared/settings';
import type { ErrorCode } from '../../shared/errors';
import type { ActionPayload } from '../../shared/schemas';

export { ActionStateError, RepoContractError, RowNotFoundError } from './errors';

/** Thin wrapper over node:sqlite DatabaseSync so a future engine swap touches one file. Synchronous; every statement is an indexed read/write. */
export interface Stmt<Row = unknown> {
  get(...params: SqlValue[]): Row | undefined;
  all(...params: SqlValue[]): Row[];
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number };
}
export type SqlValue = string | number | bigint | null | Uint8Array;
export interface Db {
  readonly path: string; // ':memory:' in tests
  exec(sql: string): void;
  prepare<Row = unknown>(sql: string): Stmt<Row>;
  /** BEGIN IMMEDIATE ... COMMIT ; ROLLBACK + rethrow on error ; nested calls join the outer transaction. */
  transaction<R>(fn: () => R): R;
  userVersion(): number;
  close(): void;
}
export const MEMORY_DB = ':memory:';
/** A statement slower than this is a missing index or a table scan; reported to the registered handler in development only. */
export const SLOW_STATEMENT_MS = 20;
export interface SlowStatement {
  /** Static SQL text (parameters are bound separately, so this never carries message text or a key). */
  sql: string;
  op: 'get' | 'all' | 'run';
  ms: number;
}
export type SlowStatementHandler = (s: SlowStatement) => void;
let slowStatementHandler: SlowStatementHandler | null = null;
/**
 * [W1-04 addition] `console.*` is lint-banned in `src/main` and `openDb(path)` takes no logger, so the dev warning for slow
 * statements is delivered to a handler the composition root registers (S-LOG). No handler = no measuring overhead.
 */
export function setSlowStatementHandler(h: SlowStatementHandler | null): void {
  slowStatementHandler = h;
}
const measuring = (): boolean => slowStatementHandler !== null && process.env.NODE_ENV !== 'production';

// PRAGMA journal_mode=WAL, foreign_keys=ON, busy_timeout=3000 ; quick_check ; migrate()
export function openDb(dbPath: string): Db {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { open: true });
  } catch (e) {
    throw new DbCorruptError(dbPath, e);
  }
  let wrapped: Db;
  try {
    if (dbPath !== MEMORY_DB) db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    db.exec('PRAGMA busy_timeout=3000');
    const check = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
    if (check?.quick_check !== 'ok') throw new DbCorruptError(dbPath);
    wrapped = wrapDb(dbPath, db);
  } catch (e) {
    try {
      db.close();
    } catch {
      /* the handle is already unusable */
    }
    throw e instanceof DbCorruptError ? e : new DbCorruptError(dbPath, e);
  }
  try {
    migrate(wrapped, backupBeforeMigration(wrapped, dbPath), () => Date.now());
  } catch (e) {
    wrapped.close();
    throw e;
  }
  return wrapped;
}

/**
 * A migration rewrites the schema in one transaction; the copy taken first is the only way back (ARCHITECTURE section 10).
 * Exported for the colocated test: with a single migration on the books the runner never reaches this on a fresh install.
 */
export function backupBeforeMigration(db: Db, dbPath: string): () => void {
  return () => {
    // Nothing to lose on a brand-new file, and an in-memory database has no directory to back up into.
    if (dbPath === MEMORY_DB) return;
    const tables =
      db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'`).get()?.n ?? 0;
    if (tables === 0) return;
    try {
      backupNow(db, { backupsDir: path.join(path.dirname(dbPath), 'backups'), now: () => Date.now() });
    } catch {
      /* a failed pre-migration copy must not block the upgrade; the migration itself is transactional */
    }
  };
}

/** quick_check failed (or the file is not a database at all) => the caller surfaces DB_RECOVERY (db/backup.ts restores the newest backup). */
export class DbCorruptError extends Error {
  readonly path: string;
  constructor(dbPath: string, cause?: unknown) {
    super('db_corrupt', cause === undefined ? undefined : { cause });
    this.name = 'DbCorruptError';
    this.path = dbPath;
  }
}

function wrapStmt<Row>(s: StatementSync, sql: string): Stmt<Row> {
  const timed = <R>(op: SlowStatement['op'], fn: () => R): R => {
    if (!measuring()) return fn();
    const started = performance.now();
    try {
      return fn();
    } finally {
      const ms = performance.now() - started;
      if (ms > SLOW_STATEMENT_MS) slowStatementHandler?.({ sql, op, ms });
    }
  };
  return {
    get: (...params) => timed('get', () => s.get(...params) as Row | undefined),
    all: (...params) => timed('all', () => s.all(...params) as Row[]),
    run: (...params) =>
      timed('run', () => {
        const r = s.run(...params);
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      }),
  };
}

function wrapDb(dbPath: string, db: DatabaseSync): Db {
  let depth = 0;
  const cache = new Map<string, StatementSync>();
  const prepared = (sql: string): StatementSync => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  return {
    path: dbPath,
    exec: (sql) => db.exec(sql),
    prepare: <Row = unknown>(sql: string) => wrapStmt<Row>(prepared(sql), sql),
    transaction: <R>(fn: () => R): R => {
      if (depth > 0) {
        depth++;
        try {
          return fn();
        } finally {
          depth--;
        }
      }
      db.exec('BEGIN IMMEDIATE');
      depth = 1;
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* already rolled back by SQLite (e.g. a RAISE(ABORT) in a trigger ends the statement, not the transaction; ROLLBACK may still fail) */
        }
        throw e;
      } finally {
        depth = 0;
      }
    },
    userVersion: () => Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version),
    close: () => {
      cache.clear();
      db.close();
    },
  };
}

/** [V2] B25 provenance columns of proposals (migration v4). */
export type ProposalProvenanceKey =
  'delta' | 'imageRead' | 'blockedCalls' | 'providerClass' | 'contextFromMeRecent' | 'crossChatRows' | 'triggerAuthor';

export interface Repos {
  db: Db;
  meta: { get(k: T.MetaKey): string | null; set(k: T.MetaKey, v: string): void };
  settings: { get(): Settings; patch(p: SettingsPatch): Settings; setInternal(mut: (s: Settings) => void): Settings };
  secrets: {
    put(name: T.SecretName, ciphertext: Uint8Array): void;
    get(name: T.SecretName): Uint8Array | null;
    delete(name: T.SecretName): void;
  };
  consents: {
    /** [V2 CHANGE] accept(kind, version, now, termsReadOn?) - termsReadOn only for cloud_antigravity_cli (= ANTIGRAVITY_TERMS_READ_ON). */
    accept(kind: T.ConsentKind, version: number, now: T.EpochMs, termsReadOn?: T.IsoDate): void;
    latest(kind: T.ConsentKind): T.ConsentRecord | null;
    /** [R2] EXISTS(SELECT 1 FROM consents WHERE kind=? AND version = CONSENT_VERSIONS[kind]) - the EXACT current version, never max()>=. */
    isCurrent(kind: T.ConsentKind): boolean;
  };
  chats: {
    upsertFromBridge(jid: string, name: string | null, isKnown: boolean, now: T.EpochMs): T.Chat;
    /** [R2] LID resolution: re-key the @lid chat row to the phone JID (or, when a phone-JID row already exists, move the @lid row's items/actions to it
     *  and delete the @lid row) in ONE transaction; is_known = OR of both; returns the surviving chat. */
    mergeLidInto(lidChatId: T.ChatRef, phoneJid: string, now: T.EpochMs): T.Chat;
    byId(id: T.ChatRef): T.Chat | null;
    byJid(jid: string): T.Chat | null;
    touch(
      id: T.ChatRef,
      p: { lastInboundTs?: T.EpochMs; lastOutboundTs?: T.EpochMs; lang?: T.Lang; lastTriagedMsgId?: string },
    ): void;
    setPolicy(id: T.ChatRef, policy: T.ChatPolicy): T.Chat;
    setForceKnown(id: T.ChatRef): T.Chat;
    withPolicies(): T.Chat[];
    setAutoPolicy(id: T.ChatRef, p: T.ChatAutoPolicy): T.Chat; // [V2 ADD] chat:setPolicy {autoPolicy}
    taint(id: T.ChatRef, until: T.EpochMs): void; // [V2 ADD] S4: max(auto_tainted_until, until) ; audit auto_taint
  };
  items: {
    openForChat(chatId: T.ChatRef): T.Item | null;
    createOpen(p: {
      chatId: T.ChatRef;
      triggerMsgId: string;
      triggerTs: T.EpochMs;
      analysis: T.Analysis;
      holdReason: T.HoldReason | null;
      now: T.EpochMs;
    }): T.Item;
    /** The ONLY mutator: applies the patch, recomputes state = deriveState(), bumps updated_at. */
    update(
      id: T.ItemId,
      patch: Partial<Omit<T.Item, 'id' | 'chatId' | 'state' | 'createdAt' | 'updatedAt'>>,
      now: T.EpochMs,
    ): T.Item;
    byId(id: T.ItemId): T.Item | null;
    list(state: T.ItemState, limit: number): T.Item[]; // analysis IN (done, held, failed), updated_at DESC
    counts(): { needsReply: number; inCalendar: number; infoMissing: number; ignored: number; analysing: number };
    heldWith(reason: T.HoldReason, opts?: { triggerTsSince?: T.EpochMs }): T.Item[]; // oldest first ; [R2] cloud release passes triggerTsSince = now - LIMITS.heldReleaseWindowMs
    recoverRunning(now: T.EpochMs): number; // startup: running -> queued
    expireOld(now: T.EpochMs): number; // open > 7 d => expired ; in_calendar start + 1 d => past
    snapshotMessages(itemId: T.ItemId, rows: T.ItemMessage[]): void;
    messages(itemId: T.ItemId): T.ItemMessage[];
    /** [V2 ADD] findExistingEvent's query: newest in_calendar item of the chat with calendar_event_id, event_state IN ('created','updated'),
     *  event_start_ts >= sinceTs. */
    newestEditableEvent(chatId: T.ChatRef, sinceTs: T.EpochMs): T.Item | null;
    /** [V2 ADD, F31] COUNT of the same filter (distinct calendar_event_id). */
    countEditableEvents(chatId: T.ChatRef, sinceTs: T.EpochMs): number;
    /** [V2 ADD] every item holding this event (source + acting) - for the eventKey / changePending view fields and the "never twice" rule. */
    byCalendarEventId(eventId: string): T.Item[];
  };
  retention: {
    // [R2] used by the daily job and by data:purgeNow
    /** Nulls item_messages.text, proposals.draft_text/extraction_json/event_json/freebusy_json and actions.canonical_json/approved_final_json
     *  (actions in TERMINAL states only - the frozen trigger permits exactly this NULLing, see 15.2; content_sha256 kept) for rows older than
     *  `before`; deletes closed items (cascade) older than `closedBefore`. */
    purge(p: { before: T.EpochMs; closedBefore: T.EpochMs }): {
      textRows: number;
      actionRows: number;
      itemsDeleted: number;
      // [V2, V2-W1-01] C2 16.1 "returned counts may add keys" - optional so a v1-shaped fake stays assignable.
      transcriptRows?: number;
      /** Bare file names under <userData>\media-cache\ of the media_cache rows this purge deleted; the CALLER unlinks them. */
      mediaFiles?: string[];
      revisionRows?: number;
      autoWritesDeleted?: number;
      autoDecisionsDeleted?: number;
    };
  };
  proposals: {
    /** [V2] insertNext takes the new provenance fields (Proposal minus id/version/supersededAt already includes them). extraction_json of v1 rows
     *  is read with parseStoredExtraction() (fail-closed defaults). */
    // [V2 W0 refinement] the seven provenance fields are OPTIONAL at the type level so v1 callers keep compiling; an omitted field is
    // written with its FAIL-CLOSED default (PROPOSAL_PROVENANCE_DEFAULTS in repos/proposals.ts). V2-W1-03 (validate.ts) passes all seven.
    insertNext(
      p: Omit<T.Proposal, 'id' | 'version' | 'supersededAt' | ProposalProvenanceKey> &
        Partial<Pick<T.Proposal, ProposalProvenanceKey>>,
    ): T.Proposal; // version = max+1 ; supersedes older
    current(itemId: T.ItemId): T.Proposal | null;
  };
  actions: {
    /** Validates payload, computes canonical_json + content_sha256 + idempotency_key, state='pending', expires_at = now + 24 h. */
    insertPending(p: {
      itemId: T.ItemId;
      proposalId: T.ProposalId;
      chatId: T.ChatRef;
      payload: ActionPayload;
      now: T.EpochMs;
      retryOf?: T.ActionId;
    }): T.ApprovalAction;
    byId(id: T.ActionId): T.ApprovalAction | null;
    forItem(itemId: T.ItemId): T.ApprovalAction[];
    supersedePending(itemId: T.ItemId, now: T.EpochMs): number;
    /** [repair] Kind-scoped variant of `supersedePending`: supersedes THIS item's pending actions of ONE kind and leaves the other kinds
     *  pending. Used by ingest.handleOutbound, where ARCHITECTURE 182 / PIPELINE 62 make superseding the pending `send_reply` unconditional
     *  while a pending `create_event` must survive so the card stays open. See ops/agent-notes/fix-src-main-bridge.md. */
    supersedePendingOfKind(itemId: T.ItemId, kind: T.ApprovalAction['kind'], now: T.EpochMs): number;
    /** [R2] Called by ingest in the SAME transaction that creates a new open item for a chat: supersedes every pending send_reply of that chat's
     *  NON-open items (an in_calendar card's unsent draft) so at most one approvable draft exists per chat. */
    supersedePendingRepliesOfChat(chatId: T.ChatRef, exceptItemId: T.ItemId, now: T.EpochMs): number;
    /** [R2] Compare-and-set, ONE transaction: UPDATE ... SET state='approved', approved_at=?, approved_final_json=? WHERE id=? AND state='pending'
     *  then UPDATE ... SET state='executing' WHERE id=? AND state='approved'. Returns 'stale' (no throw, no side effect) when either UPDATE
     *  reports changes !== 1 or a trigger aborts; the caller maps 'stale' to ACTION_STALE and NEVER to failed/clone.
     *  [V2 CHANGE] + approvedBy, set in the FIRST CAS statement (UPDATE ... SET state='approved', approved_at=?, approved_final_json=?, approved_by=?
     *  WHERE id=? AND state='pending'); trg_actions_state verifies it (I1'). 'stale' on changes !== 1 or a trigger ABORT (unchanged). */
    markApprovedExecuting(
      id: T.ActionId,
      approvedFinalJson: string,
      now: T.EpochMs,
      approvedBy: T.ApprovedBy,
    ): 'ok' | 'stale';
    /** [V2 ADD] AutoGate precondition: COUNT(*) WHERE kind='create_event' AND state='done' AND approved_by='user'. */
    countUserApprovedCreates(): number;
    /** [V2 ADD, F32] `to` payloads of REJECTED update_event actions for this event and baseRevision (S4 suppression rule). */
    rejectedDeltaTo(
      targetEventId: string,
      baseRevision: number,
    ): Array<import('../../shared/schemas').EventContentWithStatus>;
    /** [R2] All three: UPDATE ... WHERE id=? AND state='executing'; changes !== 1 => throw ActionStateError (a programming error, audited 'db_recovery'
     *  never silently ignored). markDone is additionally allowed from 'unknown_outcome' (reconcile found). */
    markDone(id: T.ActionId, result: T.ActionResult, now: T.EpochMs): void;
    markFailed(id: T.ActionId, code: ErrorCode, now: T.EpochMs): void;
    markUnknownOutcome(id: T.ActionId, now: T.EpochMs): void;
    markRejected(id: T.ActionId): void; // WHERE state='pending'
    expireOverdue(now: T.EpochMs): number;
    executing(): T.ApprovalAction[]; // startup recovery
    chainRoot(id: T.ActionId): T.ApprovalAction; // [R2] follows retry_of to attempt 1
  };
  queue: {
    enqueue(chatId: T.ChatRef, now: T.EpochMs): void; // due = min(now + 20 s, first_enqueued_at + 60 s)
    nextDue(now: T.EpochMs): T.QueueEntry | null;
    defer(chatId: T.ChatRef, dueAt: T.EpochMs, lastError?: string): void;
    /** `rev` is an OPTIONAL trailing argument so the frozen shape is untouched: with it the delete is a
     *  compare-and-set (a row re-armed mid-run, whose rev moved on, is KEPT); without it the delete is unconditional. */
    remove(chatId: T.ChatRef, rev?: number): void;
    size(): number;
  };
  runs: {
    start(p: Pick<T.RunRecord, 'itemId' | 'stage' | 'provider' | 'model' | 'startedAt'>): T.RunId;
    finish(id: T.RunId, p: Partial<T.RunRecord>): void;
    cloudTokensSince(ts: T.EpochMs): { inputTokens: number; outputTokens: number };
    finishCli(id: T.RunId, p: { sandboxOk: boolean; sandboxProof: T.CliSandboxProof }): void; // [V2 ADD]
    sandboxOfVersion(itemId: T.ItemId, proposalCreatedAfter: T.EpochMs): Array<boolean | null>; // [V2 ADD] S1 + S3 sandbox_ok of this version
  };
  audit: { append(kind: T.AuditKind, ref: string | null, detail: T.AuditEntry['detail'], now: T.EpochMs): void };
  rate: {
    record(bucket: T.RateBucket, key: string, now: T.EpochMs): void;
    countSince(bucket: T.RateBucket, key: string, since: T.EpochMs): number;
    lastTs(bucket: T.RateBucket, key: string): T.EpochMs | null;
  };
  models: {
    // [V2 CHANGE] keyed by ModelFileId (widening)
    get(id: T.ModelFileId): T.ModelFileRecord | null;
    upsert(r: T.ModelFileRecord): void;
    delete(id: T.ModelFileId): void;
  };
  // ---- [V2 ADD] new repos (one file each under db/repos/) - C2 16.1 ----
  eventRevisions: {
    insert(r: Omit<T.EventRevisionRecord, 'id' | 'revertedBy'>): T.EventRevisionRecord; // revision = items.event_revision after the write
    newestFor(calendarEventId: string): T.EventRevisionRecord | null;
    byId(id: number): T.EventRevisionRecord | null;
    /** [V2 ADD, F1] The undo candidate: newest row with kind <> 'undo' AND reverted_by IS NULL such that every newer row of the event is reverted
     *  or an 'undo' row; null when none. */
    undoCandidate(calendarEventId: string): T.EventRevisionRecord | null;
    /** [V2 ADD, F1] Rows of automatic writes (joined to auto_writes) not yet reverted, newer than the newest revision approved by 'user'/'user_toast';
     *  oldest first ("Restore original" restores the first one's prev). */
    unrevertedAutoSpan(calendarEventId: string): T.EventRevisionRecord[];
    markReverted(id: number, byRevisionId: number): void; // UPDATE ... SET reverted_by WHERE reverted_by IS NULL
  };
  autoPolicies: {
    /** The live row (shadow|on|paused), scope re-validated with AutoScopeSchema.parse (a bad row => treated as none + audit db_recovery). */
    live(): T.AutoPolicyRecord | null;
    newest(): T.AutoPolicyRecord | null;
    insert(r: Omit<T.AutoPolicyRecord, 'pausedReason' | 'disabledAt' | 'disabledReason'>): T.AutoPolicyRecord; // born shadow|on (trigger)
    setState(
      id: string,
      s:
        | { state: 'on' }
        | { state: 'paused'; reason: T.AutoPausedReason }
        | { state: 'disabled'; reason: T.AutoDisabledReason; at: T.EpochMs }
        | { state: 'expired' },
    ): T.AutoPolicyRecord;
  };
  autoDecisions: {
    insert(r: T.AutoDecisionRecord): void; // immutable afterwards (trigger)
    forAction(actionId: T.ActionId): T.AutoDecisionRecord | null;
    /** Shadow tally for auto:getState / auto:endShadow: decisions with verdict 'shadow' of the policy joined to their action's end state
     *  (approved unchanged = approved_final_json == canonical_json ; edited ; dismissed = rejected/expired/superseded). */
    shadowTally(policyId: string): {
      decisions: number;
      wouldAuto: number;
      approvedUnchanged: number;
      edited: number;
      dismissed: number;
    };
  };
  autoWrites: {
    insert(
      r: Omit<
        T.AutoWriteRecord,
        'revisionId' | 'postEtag' | 'postUpdated' | 'postSequence' | 'undoState' | 'undoActionId'
      >,
    ): T.AutoWriteRecord;
    recordReadback(
      id: string,
      p: { revisionId: number; postEtag: string | null; postUpdated: string | null; postSequence: number | null },
    ): void;
    setUndo(id: string, p: { undoState: T.AutoUndoState; undoActionId?: T.ActionId }): void;
    byId(id: string): T.AutoWriteRecord | null;
    since(ts: T.EpochMs): T.AutoWriteRecord[];
    countEditsOfEvent(eventId: string): number;
    undosSince(ts: T.EpochMs): number;
  };
  transcripts: {
    get(chatJid: string, waMsgId: string): T.TranscriptRecord | null;
    upsert(r: T.TranscriptRecord): void;
  };
  mediaCache: {
    get(chatId: T.ChatRef, waMsgId: string): T.MediaCacheRecord | null;
    upsert(r: T.MediaCacheRecord): void;
    forItem(itemId: T.ItemId): T.MediaCacheRecord[];
    deleteForItem(itemId: T.ItemId): T.MediaCacheRecord[]; // caller unlinks the files
  };
}
/** [V2] C2 16.1 names the delta interface `ReposV2`; per the C2 convention ("XxxV2 extends Xxx" = add these members to Xxx) the members
 *  live on `Repos` itself. The alias keeps the C2 name importable. */
export type ReposV2 = Repos;
/** Assembles the repos over one open database. Pure wiring: every repo is stateless and prepares its statements lazily. */
export function createRepos(db: Db, opts?: { queueTimers?: import('./repos/queue').QueueTimers }): Repos {
  return {
    db,
    meta: createMetaRepo(db),
    settings: createSettingsRepo(db),
    secrets: createSecretsRepo(db),
    consents: createConsentsRepo(db),
    chats: createChatsRepo(db),
    items: createItemsRepo(db),
    retention: createRetentionRepo(db),
    proposals: createProposalsRepo(db),
    actions: createActionsRepo(db),
    queue: createQueueRepo(db, opts?.queueTimers), // [v2-repair] WCA_TIMERS debounce seam (e2e only)
    runs: createRunsRepo(db),
    audit: createAuditRepo(db),
    rate: createRateRepo(db),
    models: createModelsRepo(db),
    eventRevisions: createEventRevisionsRepo(db),
    autoPolicies: createAutoPoliciesRepo(db),
    autoDecisions: createAutoDecisionsRepo(db),
    autoWrites: createAutoWritesRepo(db),
    transcripts: createTranscriptsRepo(db),
    mediaCache: createMediaCacheRepo(db),
  };
}
