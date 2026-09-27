// src/main/db/migrations.ts
// Complete file verbatim from docs/specs/contracts.md 15.2 (frozen; W0). migrate() implemented by W0 per the runner contract below.
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: String.raw`
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);

CREATE TABLE meta      (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE settings  (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE secrets   (name TEXT PRIMARY KEY CHECK(name IN ('anthropic_api_key','gemini_api_key')),
                        ciphertext BLOB NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE consents  (kind TEXT NOT NULL CHECK(kind IN ('whatsapp_tos','cloud_claude','cloud_gemini')),
                        version INTEGER NOT NULL, accepted_at INTEGER NOT NULL, PRIMARY KEY(kind, version));

CREATE TABLE chats     (id INTEGER PRIMARY KEY, jid TEXT NOT NULL UNIQUE, display_name TEXT,
                        is_known INTEGER NOT NULL DEFAULT 0, force_known INTEGER NOT NULL DEFAULT 0,
                        sendable INTEGER NOT NULL DEFAULT 0,
                        policy TEXT NOT NULL DEFAULT 'default' CHECK(policy IN ('default','never')),
                        lang TEXT CHECK(lang IN ('he','en')), last_inbound_ts INTEGER, last_outbound_ts INTEGER,
                        last_triaged_msg_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX ix_chats_policy ON chats(policy) WHERE policy <> 'default' OR force_known = 1;

CREATE TABLE items     (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id),
                        state TEXT NOT NULL CHECK(state IN ('needs_reply','info_missing','in_calendar','ignored')),
                        analysis TEXT NOT NULL DEFAULT 'queued' CHECK(analysis IN ('queued','running','done','failed','held')),
                        hold_reason TEXT CHECK(hold_reason IS NULL OR hold_reason IN ('unknown_sender','paused','waiting_llm','budget')),
                        error_code TEXT,
                        reply_state TEXT NOT NULL DEFAULT 'none' CHECK(reply_state IN ('none','draft','sent','answered_elsewhere','skipped')),
                        event_state TEXT NOT NULL DEFAULT 'none' CHECK(event_state IN ('none','incomplete','proposed','created','declined')),
                        trigger_msg_id TEXT NOT NULL, trigger_ts INTEGER NOT NULL,
                        missing_json TEXT NOT NULL DEFAULT '[]', badges_json TEXT NOT NULL DEFAULT '[]',
                        current_proposal_id INTEGER, editing_until INTEGER NOT NULL DEFAULT 0,
                        calendar_event_id TEXT, calendar_html_link TEXT, event_start_ts INTEGER,
                        closed_reason TEXT CHECK(closed_reason IS NULL OR closed_reason IN
                          ('not_needed','replied','answered_elsewhere','dismissed','superseded','expired','past')),
                        closed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX ux_items_open ON items(chat_id) WHERE state IN ('needs_reply','info_missing');
CREATE INDEX ix_items_list ON items(state, updated_at DESC);
CREATE INDEX ix_items_analysis ON items(analysis, created_at);
CREATE INDEX ix_items_chat ON items(chat_id, updated_at DESC);

CREATE TABLE item_messages (item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                        wa_msg_id TEXT NOT NULL, from_me INTEGER NOT NULL, ts INTEGER NOT NULL,
                        text TEXT, text_sha256 TEXT NOT NULL,
                        PRIMARY KEY(item_id, wa_msg_id));

CREATE TABLE triage_queue (chat_id INTEGER PRIMARY KEY REFERENCES chats(id), due_at INTEGER NOT NULL,
                        first_enqueued_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT);
CREATE INDEX ix_queue_due ON triage_queue(due_at);

CREATE TABLE runs      (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                        stage TEXT NOT NULL CHECK(stage IN ('extract','draft')),
                        provider TEXT NOT NULL CHECK(provider IN ('local','claude','gemini')), model TEXT NOT NULL,
                        started_at INTEGER NOT NULL, finished_at INTEGER,
                        outcome TEXT CHECK(outcome IS NULL OR outcome IN ('ok','failed','aborted')), input_tokens INTEGER, output_tokens INTEGER,
                        tool_calls INTEGER NOT NULL DEFAULT 0, blocked_tool_calls INTEGER NOT NULL DEFAULT 0, error_code TEXT);
CREATE INDEX ix_runs_item ON runs(item_id);
CREATE INDEX ix_runs_started ON runs(provider, started_at);

CREATE TABLE proposals (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, version INTEGER NOT NULL,
                        provider TEXT NOT NULL CHECK(provider IN ('local','claude','gemini','user')), model TEXT NOT NULL,
                        extraction_json TEXT,
                        draft_text TEXT, reply_lang TEXT CHECK(reply_lang IS NULL OR reply_lang IN ('he','en')), event_json TEXT,
                        freebusy_json TEXT, suspicious INTEGER NOT NULL DEFAULT 0,
                        created_at INTEGER NOT NULL, superseded_at INTEGER, UNIQUE(item_id, version));

CREATE TABLE actions   (id TEXT PRIMARY KEY,
                        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                        proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
                        chat_id INTEGER NOT NULL REFERENCES chats(id),
                        kind TEXT NOT NULL CHECK(kind IN ('send_reply','create_event')),
                        canonical_json TEXT, content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
                        idempotency_key TEXT NOT NULL UNIQUE,
                        attempt INTEGER NOT NULL DEFAULT 1, retry_of TEXT REFERENCES actions(id) ON DELETE SET NULL,
                        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN
                          ('pending','approved','executing','done','failed','unknown_outcome','rejected','expired','superseded')),
                        approved_at INTEGER, approved_final_json TEXT, executed_at INTEGER, result_json TEXT, error_code TEXT,
                        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX ix_actions_item ON actions(item_id, state);
CREATE INDEX ix_actions_state ON actions(state, expires_at);

CREATE TRIGGER trg_actions_state BEFORE UPDATE OF state ON actions WHEN NEW.state <> OLD.state BEGIN
  SELECT CASE
    WHEN OLD.state IN ('done','failed','rejected','expired','superseded') THEN RAISE(ABORT,'terminal state')
    WHEN NEW.state='pending'   THEN RAISE(ABORT,'cannot return to pending')
    WHEN NEW.state='approved'  AND (OLD.state<>'pending' OR NEW.approved_at IS NULL OR NEW.approved_final_json IS NULL) THEN RAISE(ABORT,'bad approve')
    WHEN NEW.state='executing' AND (OLD.state<>'approved' OR NEW.approved_final_json IS NULL) THEN RAISE(ABORT,'execute without approval')
    WHEN NEW.state='done'      AND OLD.state NOT IN ('executing','unknown_outcome') THEN RAISE(ABORT,'bad done')
    WHEN NEW.state IN ('failed','unknown_outcome') AND OLD.state<>'executing' THEN RAISE(ABORT,'bad outcome')
    WHEN NEW.state='rejected'  AND OLD.state<>'pending' THEN RAISE(ABORT,'bad reject')
    WHEN NEW.state IN ('expired','superseded') AND OLD.state NOT IN ('pending','unknown_outcome') THEN RAISE(ABORT,'bad close')
  END; END;
CREATE TRIGGER trg_actions_insert BEFORE INSERT ON actions WHEN NEW.state <> 'pending' OR NEW.canonical_json IS NULL BEGIN
  SELECT RAISE(ABORT,'actions must be born pending with content'); END;
CREATE TRIGGER trg_actions_frozen BEFORE UPDATE OF canonical_json, content_sha256, chat_id, kind, item_id, proposal_id, idempotency_key, attempt, retry_of ON actions
  WHEN NOT (NEW.canonical_json IS NULL AND OLD.canonical_json IS NOT NULL
            AND OLD.state IN ('done','failed','rejected','expired','superseded','unknown_outcome')
            AND NEW.content_sha256 = OLD.content_sha256 AND NEW.chat_id = OLD.chat_id AND NEW.kind = OLD.kind AND NEW.item_id = OLD.item_id
            AND NEW.proposal_id = OLD.proposal_id AND NEW.idempotency_key = OLD.idempotency_key AND NEW.attempt = OLD.attempt AND NEW.retry_of IS OLD.retry_of)
  BEGIN SELECT RAISE(ABORT,'approved content is immutable'); END;
CREATE TRIGGER trg_actions_final_frozen BEFORE UPDATE OF approved_final_json ON actions
  WHEN OLD.state IN ('executing','done','failed','unknown_outcome')
   AND NOT (NEW.approved_final_json IS NULL AND OLD.state <> 'executing')
  BEGIN SELECT RAISE(ABORT,'final payload is immutable'); END;

CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT, detail_json TEXT NOT NULL);
CREATE INDEX ix_audit_ts ON audit_log(ts);
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'append-only'); END;

CREATE TABLE rate_events (bucket TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX ix_rate ON rate_events(bucket, key, ts);

CREATE TABLE model_files (id TEXT PRIMARY KEY CHECK(id IN ('tiny','small','mid')), path TEXT NOT NULL, size INTEGER NOT NULL,
                        sha256 TEXT NOT NULL, mtime INTEGER NOT NULL,
                        status TEXT NOT NULL CHECK(status IN ('none','downloading','paused','verifying','ready','failed')),
                        bytes_done INTEGER NOT NULL DEFAULT 0, verified_at INTEGER, bench_json TEXT);
`,
  },
  {
    version: 2,
    name: 'actions_frozen_allows_retry_unlink',
    // [repair data-integrity-1 / -2] `retry_of TEXT REFERENCES actions(id) ON DELETE SET NULL` (v1) is implemented by SQLite as an
    // implicit `UPDATE actions SET retry_of = NULL`, and with PRAGMA foreign_keys=ON that UPDATE fires `trg_actions_frozen`, whose
    // v1 guard demands `NEW.retry_of IS OLD.retry_of`. So deleting ANY action that a retry clone points at aborted with
    // 'approved content is immutable':
    //   - retention.purge's `DELETE FROM items` rolled its whole transaction back, so nothing was ever purged again and
    //     `data:purgeNow` answered INTERNAL (one failed send in the app's lifetime was enough);
    //   - chats.mergeLidInto's `DELETE FROM actions WHERE chat_id = ?` aborted inside ingest's scan transaction, which also
    //     carries `bridge_rowid_watermark`, so the batch rolled back and ingest re-read and re-failed the same rows forever.
    // The trigger is I3's second line of defence and is NOT dropped. Instead the guard now names the two legitimate shapes, and
    // only those: the retention purge of a terminal row's payload, and the FK's own NULLing of a dangling retry back-pointer.
    // Everything that pins an approval to its recipient and its bytes - chat_id, item_id, proposal_id, kind, content_sha256,
    // idempotency_key, attempt - is still frozen in both shapes, and a retry_of change to any NON-NULL value still aborts. The
    // second shape also insists on `OLD.retry_of IS NOT NULL`, so it stays a NULLing of a REAL back-pointer and cannot be used as
    // a no-op that smuggles a second canonical_json pass past the first shape's `OLD.canonical_json IS NOT NULL`.
    sql: String.raw`
DROP TRIGGER trg_actions_frozen;
CREATE TRIGGER trg_actions_frozen BEFORE UPDATE OF canonical_json, content_sha256, chat_id, kind, item_id, proposal_id, idempotency_key, attempt, retry_of ON actions
  WHEN NOT (
       (NEW.canonical_json IS NULL AND OLD.canonical_json IS NOT NULL
        AND OLD.state IN ('done','failed','rejected','expired','superseded','unknown_outcome')
        AND NEW.retry_of IS OLD.retry_of
        AND NEW.content_sha256 = OLD.content_sha256 AND NEW.chat_id = OLD.chat_id AND NEW.kind = OLD.kind AND NEW.item_id = OLD.item_id
        AND NEW.proposal_id = OLD.proposal_id AND NEW.idempotency_key = OLD.idempotency_key AND NEW.attempt = OLD.attempt)
    OR (NEW.retry_of IS NULL AND OLD.retry_of IS NOT NULL AND NEW.canonical_json IS OLD.canonical_json
        AND NEW.content_sha256 = OLD.content_sha256 AND NEW.chat_id = OLD.chat_id AND NEW.kind = OLD.kind AND NEW.item_id = OLD.item_id
        AND NEW.proposal_id = OLD.proposal_id AND NEW.idempotency_key = OLD.idempotency_key AND NEW.attempt = OLD.attempt)
  )
  BEGIN SELECT RAISE(ABORT,'approved content is immutable'); END;
`,
  },
  {
    version: 3,
    name: 'triage_queue_rev',
    // [repair correctness-pipeline-2] `triage_queue` is keyed on chat_id and `nextDue()` only SELECTs, so the row a worker
    // is running stays in the table for the whole run. `enqueue()` on an existing row is a bare `UPDATE ... SET due_at`,
    // which means a message arriving WHILE the run is in flight (bridge/ingest.ts handleInbound) or a user's
    // "Analyse again" (agent/items.ts retriage) re-arms the very row `runOne` then deleted unconditionally. The newer
    // trigger was analysed by nobody: nothing re-arms a `queued` item that has no queue row, and the bridge
    // `bridge_rowid_watermark` is already past the message, so only a THIRD inbound message recovered the chat.
    // `due_at` cannot identify the row: once the 60 s debounce cap is in force, `min(now + 20 s, first + 60 s)`
    // re-computes the SAME due_at the worker dequeued - exactly the chatty conversation the cap exists for - and
    // `first_enqueued_at` deliberately does not move on a re-arm. So the row carries a monotonic `rev` that `enqueue`
    // bumps and `remove` compares: the delete became a compare-and-set and a row re-armed mid-run survives it.
    sql: String.raw`
ALTER TABLE triage_queue ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
`,
  },
] as const;

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** Runner contract (implemented below by lane 4):
 *  v = PRAGMA user_version ; v > SCHEMA_VERSION => throw (downgrade) => DB_RECOVERY.
 *  for each m with m.version > v, ascending: backupBefore() once ; BEGIN IMMEDIATE ; exec(m.sql) ;
 *  INSERT INTO schema_migrations(version,name,applied_at) ; PRAGMA user_version = m.version ; COMMIT.
 *  Any error => ROLLBACK, restore newest backup, surface DB_RECOVERY. */
export function migrate(
  db: import('./index').Db,
  backupBefore: () => void,
  now: () => number,
): { from: number; to: number } {
  const from = db.userVersion();
  if (from > SCHEMA_VERSION) throw new MigrationError('downgrade', from, SCHEMA_VERSION);
  let backedUp = false;
  let to = from;
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    if (!backedUp) {
      backupBefore();
      backedUp = true;
    }
    try {
      db.transaction(() => {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          now(),
        );
        db.exec(`PRAGMA user_version = ${m.version}`);
      });
    } catch (e) {
      throw new MigrationError('failed', from, m.version, e);
    }
    to = m.version;
  }
  return { from, to };
}

/** Surfaced by the caller as DB_RECOVERY (restore newest backup). */
export class MigrationError extends Error {
  readonly reason: 'downgrade' | 'failed';
  readonly from: number;
  readonly target: number;
  constructor(reason: 'downgrade' | 'failed', from: number, target: number, cause?: unknown) {
    super(`migration ${reason}: user_version ${from} -> ${target}`, cause === undefined ? undefined : { cause });
    this.name = 'MigrationError';
    this.reason = reason;
    this.from = from;
    this.target = target;
  }
}
