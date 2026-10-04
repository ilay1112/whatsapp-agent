// src/main/db/migrations.ts
// Complete file verbatim from docs/specs/contracts.md 15.2 (frozen; W0). migrate() implemented by W0 per the runner contract below.
export interface Migration {
  version: number;
  name: string;
  sql: string;
  /** [V2 ADD] the runner sets PRAGMA foreign_keys=OFF BEFORE BEGIN and back ON in finally, and runs PRAGMA foreign_key_check before COMMIT. */
  foreignKeysOff?: true;
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
  {
    version: 4,
    name: 'v2_editing_auto_cli_media',
    foreignKeysOff: true,
    // ARCHITECTURE-v2 B22 + concerns #1-#5 of docs/specs/v2-contracts.md. One migration, one backup, all-or-nothing.
    sql: String.raw`
-- ===== v4 'v2_editing_auto_cli_media' (runs with foreignKeysOff: PRAGMA foreign_keys=OFF is set by the runner BEFORE BEGIN) =====

-- ---------- 1. new tables referenced by the v2 action triggers (created first) ----------
CREATE TABLE auto_policies (id TEXT PRIMARY KEY,
                        state TEXT NOT NULL CHECK(state IN ('shadow','on','paused','disabled','expired')),
                        enabled_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, shadow_until INTEGER NOT NULL,
                        confirmed_by TEXT NOT NULL CHECK(confirmed_by IN ('native_dialog')),
                        confirm_json TEXT NOT NULL, scope_json TEXT NOT NULL,
                        snapshot_sha TEXT NOT NULL CHECK(length(snapshot_sha) = 64),
                        paused_reason TEXT CHECK(paused_reason IS NULL OR paused_reason IN
                          ('user','circuit_breaker_rate','circuit_breaker_undo','circuit_breaker_unknown','unattended','calendar_disconnected','snapshot_changed')),
                        disabled_at INTEGER, disabled_reason TEXT CHECK(disabled_reason IS NULL OR disabled_reason IN ('user','purge')),
                        CHECK(expires_at > enabled_at AND expires_at - enabled_at <= 7776000000),
                        CHECK(shadow_until >= enabled_at AND shadow_until <= expires_at));
CREATE UNIQUE INDEX ux_auto_policies_live ON auto_policies((1)) WHERE state IN ('shadow','on','paused');
CREATE TRIGGER trg_auto_policies_insert BEFORE INSERT ON auto_policies WHEN NEW.state NOT IN ('shadow','on') BEGIN
  SELECT RAISE(ABORT,'policy must be born shadow or on'); END;
CREATE TRIGGER trg_auto_policies_state BEFORE UPDATE OF state ON auto_policies WHEN NEW.state <> OLD.state BEGIN
  SELECT CASE
    WHEN OLD.state IN ('disabled','expired') THEN RAISE(ABORT,'policy closed')
    WHEN NEW.state = 'shadow'   THEN RAISE(ABORT,'cannot return to shadow')
    WHEN NEW.state = 'paused'   AND NEW.paused_reason IS NULL THEN RAISE(ABORT,'pause needs a reason')
    WHEN NEW.state = 'disabled' AND (NEW.disabled_at IS NULL OR NEW.disabled_reason IS NULL) THEN RAISE(ABORT,'disable needs time and reason')
  END; END;
CREATE TRIGGER trg_auto_policies_frozen BEFORE UPDATE OF id, enabled_at, expires_at, shadow_until, confirmed_by, confirm_json, scope_json, snapshot_sha ON auto_policies
  BEGIN SELECT RAISE(ABORT,'policy grant is immutable'); END;

-- ---------- 2. items (rebuild: event_state CHECK; + linked_item_id, event_revision, calendar_updated, trigger_kind) ----------
CREATE TABLE items_new (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id),
                        state TEXT NOT NULL CHECK(state IN ('needs_reply','info_missing','in_calendar','ignored')),
                        analysis TEXT NOT NULL DEFAULT 'queued' CHECK(analysis IN ('queued','running','done','failed','held')),
                        hold_reason TEXT CHECK(hold_reason IS NULL OR hold_reason IN ('unknown_sender','paused','waiting_llm','budget')),
                        error_code TEXT,
                        reply_state TEXT NOT NULL DEFAULT 'none' CHECK(reply_state IN ('none','draft','sent','answered_elsewhere','skipped')),
                        event_state TEXT NOT NULL DEFAULT 'none' CHECK(event_state IN
                          ('none','incomplete','proposed','change_proposed','created','updated','cancelled','declined')),
                        trigger_msg_id TEXT NOT NULL, trigger_ts INTEGER NOT NULL,
                        missing_json TEXT NOT NULL DEFAULT '[]', badges_json TEXT NOT NULL DEFAULT '[]',
                        current_proposal_id INTEGER, editing_until INTEGER NOT NULL DEFAULT 0,
                        calendar_event_id TEXT, calendar_html_link TEXT, event_start_ts INTEGER,
                        closed_reason TEXT CHECK(closed_reason IS NULL OR closed_reason IN
                          ('not_needed','replied','answered_elsewhere','dismissed','superseded','expired','past')),
                        closed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                        linked_item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
                        event_revision INTEGER NOT NULL DEFAULT 0 CHECK(event_revision >= 0),
                        calendar_updated TEXT,
                        trigger_kind TEXT NOT NULL DEFAULT 'text' CHECK(trigger_kind IN ('text','voice','image')),
                        event_origin_item_id INTEGER REFERENCES items(id) ON DELETE SET NULL);   -- [F27] = waItem of the event ; copied forward
INSERT INTO items_new (id, chat_id, state, analysis, hold_reason, error_code, reply_state, event_state, trigger_msg_id, trigger_ts,
                       missing_json, badges_json, current_proposal_id, editing_until, calendar_event_id, calendar_html_link, event_start_ts,
                       closed_reason, closed_at, created_at, updated_at, linked_item_id, event_revision, calendar_updated, trigger_kind,
                       event_origin_item_id)
  SELECT id, chat_id, state, analysis, hold_reason, error_code, reply_state, event_state, trigger_msg_id, trigger_ts,
         missing_json, badges_json, current_proposal_id, editing_until, calendar_event_id, calendar_html_link, event_start_ts,
         closed_reason, closed_at, created_at, updated_at, NULL,
         CASE WHEN event_state = 'created' AND calendar_event_id IS NOT NULL THEN 1 ELSE 0 END, NULL, 'text',
         CASE WHEN event_state = 'created' AND calendar_event_id IS NOT NULL THEN id ELSE NULL END   -- v1: the creating item holds its own event
  FROM items;
DROP TABLE items;
ALTER TABLE items_new RENAME TO items;
CREATE UNIQUE INDEX ux_items_open ON items(chat_id) WHERE state IN ('needs_reply','info_missing');
CREATE INDEX ix_items_list ON items(state, updated_at DESC);
CREATE INDEX ix_items_analysis ON items(analysis, created_at);
CREATE INDEX ix_items_chat ON items(chat_id, updated_at DESC);
CREATE INDEX ix_items_linked ON items(linked_item_id) WHERE linked_item_id IS NOT NULL;

-- ---------- 3. proposals (rebuild: provider CHECK; + provenance, delta, image) ----------
CREATE TABLE proposals_new (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, version INTEGER NOT NULL,
                        provider TEXT NOT NULL CHECK(provider IN ('local','claude_cli','antigravity_cli','claude','gemini','user')), model TEXT NOT NULL,
                        extraction_json TEXT,
                        draft_text TEXT, reply_lang TEXT CHECK(reply_lang IS NULL OR reply_lang IN ('he','en')), event_json TEXT,
                        freebusy_json TEXT, suspicious INTEGER NOT NULL DEFAULT 0,
                        created_at INTEGER NOT NULL, superseded_at INTEGER,
                        delta_json TEXT, image_json TEXT,
                        blocked_calls INTEGER NOT NULL DEFAULT 0 CHECK(blocked_calls >= 0),
                        provider_class TEXT NOT NULL DEFAULT 'local' CHECK(provider_class IN ('local','api_key','cli_proven','cli_unproven')),
                        context_from_me_recent INTEGER NOT NULL DEFAULT 0 CHECK(context_from_me_recent IN (0,1)),
                        cross_chat_rows INTEGER NOT NULL DEFAULT 0 CHECK(cross_chat_rows >= 0),
                        trigger_author TEXT NOT NULL DEFAULT 'contact' CHECK(trigger_author IN ('contact','self')),   -- [F28]
                        UNIQUE(item_id, version));
INSERT INTO proposals_new (id, item_id, version, provider, model, extraction_json, draft_text, reply_lang, event_json, freebusy_json, suspicious,
                           created_at, superseded_at, delta_json, image_json, blocked_calls, provider_class, context_from_me_recent, cross_chat_rows,
                           trigger_author)
  SELECT id, item_id, version, provider, model, extraction_json, draft_text, reply_lang, event_json, freebusy_json, suspicious,
         created_at, superseded_at, NULL, NULL, 0, CASE WHEN provider IN ('claude','gemini') THEN 'api_key' ELSE 'local' END, 0, 0, 'contact'
  FROM proposals;
DROP TABLE proposals;
ALTER TABLE proposals_new RENAME TO proposals;

-- ---------- 4. runs (rebuild: stage + provider CHECK; + sandbox proof, wa rows) ----------
CREATE TABLE runs_new  (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                        stage TEXT NOT NULL CHECK(stage IN ('extract','draft','read_image')),
                        provider TEXT NOT NULL CHECK(provider IN ('local','claude_cli','antigravity_cli','claude','gemini')), model TEXT NOT NULL,
                        started_at INTEGER NOT NULL, finished_at INTEGER,
                        outcome TEXT CHECK(outcome IS NULL OR outcome IN ('ok','failed','aborted')), input_tokens INTEGER, output_tokens INTEGER,
                        tool_calls INTEGER NOT NULL DEFAULT 0, blocked_tool_calls INTEGER NOT NULL DEFAULT 0, error_code TEXT,
                        sandbox_ok INTEGER CHECK(sandbox_ok IS NULL OR sandbox_ok IN (0,1)), sandbox_json TEXT,
                        wa_rows_served INTEGER NOT NULL DEFAULT 0 CHECK(wa_rows_served >= 0));
INSERT INTO runs_new (id, item_id, stage, provider, model, started_at, finished_at, outcome, input_tokens, output_tokens, tool_calls, blocked_tool_calls,
                      error_code, sandbox_ok, sandbox_json, wa_rows_served)
  SELECT id, item_id, stage, provider, model, started_at, finished_at, outcome, input_tokens, output_tokens, tool_calls, blocked_tool_calls,
         error_code, NULL, NULL, 0
  FROM runs;
DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;
CREATE INDEX ix_runs_item ON runs(item_id);
CREATE INDEX ix_runs_started ON runs(provider, started_at);

-- ---------- 5. actions (rebuild: kind CHECK; + approved_by; v2 triggers) ----------
CREATE TABLE actions_new (id TEXT PRIMARY KEY,
                        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                        proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
                        chat_id INTEGER NOT NULL REFERENCES chats(id),
                        kind TEXT NOT NULL CHECK(kind IN ('send_reply','create_event','update_event')),
                        canonical_json TEXT, content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
                        idempotency_key TEXT NOT NULL UNIQUE,
                        attempt INTEGER NOT NULL DEFAULT 1, retry_of TEXT REFERENCES actions(id) ON DELETE SET NULL,
                        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN
                          ('pending','approved','executing','done','failed','unknown_outcome','rejected','expired','superseded')),
                        approved_at INTEGER, approved_final_json TEXT, executed_at INTEGER, result_json TEXT, error_code TEXT,
                        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
                        approved_by TEXT);
INSERT INTO actions_new (id, item_id, proposal_id, chat_id, kind, canonical_json, content_sha256, idempotency_key, attempt, retry_of, state,
                         approved_at, approved_final_json, executed_at, result_json, error_code, created_at, expires_at, approved_by)
  SELECT id, item_id, proposal_id, chat_id, kind, canonical_json, content_sha256, idempotency_key, attempt, retry_of, state,
         approved_at, approved_final_json, executed_at, result_json, error_code, created_at, expires_at,
         CASE WHEN approved_at IS NOT NULL THEN 'user' ELSE NULL END
  FROM actions;
DROP TABLE actions;
ALTER TABLE actions_new RENAME TO actions;
CREATE INDEX ix_actions_item ON actions(item_id, state);
CREATE INDEX ix_actions_state ON actions(state, expires_at);

-- ---------- 6. the remaining new tables ----------
CREATE TABLE event_revisions (id INTEGER PRIMARY KEY, calendar_event_id TEXT NOT NULL,
                        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                        revision INTEGER NOT NULL CHECK(revision >= 1),
                        kind TEXT NOT NULL CHECK(kind IN ('create','reschedule','move','cancel','undo')),
                        prev_json TEXT, next_json TEXT,
                        action_id TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
                        applied_at INTEGER NOT NULL,
                        reverted_by INTEGER REFERENCES event_revisions(id) ON DELETE SET NULL,
                        post_etag TEXT, post_updated TEXT,   -- [F1/F5] readback of THIS app write (undo writes included) = drift baseline
                        CHECK((kind = 'create') = (revision = 1)));
CREATE UNIQUE INDEX ux_event_rev ON event_revisions(calendar_event_id, revision);
CREATE INDEX ix_event_rev_item ON event_revisions(item_id);
CREATE INDEX ix_event_rev_action ON event_revisions(action_id);
CREATE INDEX ix_event_rev_reverted ON event_revisions(reverted_by) WHERE reverted_by IS NOT NULL;
CREATE TRIGGER trg_event_rev_frozen BEFORE UPDATE OF id, calendar_event_id, item_id, revision, kind, action_id, applied_at ON event_revisions
  BEGIN SELECT RAISE(ABORT,'append-only'); END;

CREATE TABLE auto_decisions (id TEXT PRIMARY KEY, policy_id TEXT NOT NULL REFERENCES auto_policies(id),
                        action_id TEXT NOT NULL UNIQUE REFERENCES actions(id) ON DELETE CASCADE,
                        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                        chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                        kind TEXT NOT NULL CHECK(kind IN ('create','update','cancel')),
                        verdict TEXT NOT NULL CHECK(verdict IN ('auto','shadow','fallback')),
                        reason TEXT NOT NULL CHECK(reason IN ('ok',
                          'no_policy','policy_shadow','policy_paused','policy_expired','snapshot_changed','calendar_disconnected','calendar_not_owned','no_track_record','undo_unavailable',
                          'unknown_contact','chat_opted_out','chat_tainted','no_user_participation','no_user_echo',
                          'badge_red','badge_amber','badge_info','blocked_tool_call','suspicious','assumed_hour','missing_fields','low_confidence',
                          'intent_not_eligible','title_rejected','content_rejected','media_derived','cross_chat_rows','multiple_events',
                          'provider_unsafe',
                          'beyond_horizon','too_long','too_soon','quiet_hours','conflict','duplicate','auto_budget',
                          'edits_not_in_scope','cancel_not_in_scope','cancel_too_soon','not_app_event','wrong_item','not_own_copy','event_has_attendees',
                          'event_cancelled','modified_in_google','move_too_far','edit_budget','unknown_prev_state')),
                        checks_json TEXT NOT NULL, decided_at INTEGER NOT NULL,
                        CHECK((verdict IN ('auto','shadow')) = (reason = 'ok')));
CREATE INDEX ix_auto_decisions_chat ON auto_decisions(chat_id, decided_at);
CREATE INDEX ix_auto_decisions_policy ON auto_decisions(policy_id, verdict);
CREATE INDEX ix_auto_decisions_item ON auto_decisions(item_id);
CREATE TRIGGER trg_auto_decisions_immutable BEFORE UPDATE ON auto_decisions BEGIN SELECT RAISE(ABORT,'append-only'); END;

CREATE TABLE auto_writes (id TEXT PRIMARY KEY,
                        decision_id TEXT NOT NULL UNIQUE REFERENCES auto_decisions(id) ON DELETE CASCADE,
                        action_id TEXT NOT NULL UNIQUE REFERENCES actions(id) ON DELETE CASCADE,
                        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                        event_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('create','update','cancel')),
                        pre_json TEXT,
                        revision_id INTEGER REFERENCES event_revisions(id) ON DELETE SET NULL,
                        post_etag TEXT, post_updated TEXT, post_sequence INTEGER,
                        undo_state TEXT NOT NULL DEFAULT 'available' CHECK(undo_state IN
                          ('available','undone','expired','blocked_changed','blocked_started','failed')),
                        undo_until INTEGER NOT NULL,
                        undo_action_id TEXT REFERENCES actions(id) ON DELETE SET NULL,
                        written_at INTEGER NOT NULL,
                        CHECK((kind = 'create') = (pre_json IS NULL)),
                        CHECK(undo_until > written_at AND undo_until - written_at <= 259200000));
CREATE INDEX ix_auto_writes_undo ON auto_writes(undo_state, undo_until);
CREATE INDEX ix_auto_writes_item ON auto_writes(item_id);
CREATE INDEX ix_auto_writes_revision ON auto_writes(revision_id) WHERE revision_id IS NOT NULL;
CREATE INDEX ix_auto_writes_undo_action ON auto_writes(undo_action_id) WHERE undo_action_id IS NOT NULL;
CREATE TRIGGER trg_auto_writes_insert BEFORE INSERT ON auto_writes
  WHEN NOT EXISTS (SELECT 1 FROM auto_decisions d WHERE d.id = NEW.decision_id AND d.action_id = NEW.action_id AND d.verdict = 'auto')
  BEGIN SELECT RAISE(ABORT,'auto write without auto decision'); END;
CREATE TRIGGER trg_auto_writes_frozen BEFORE UPDATE OF id, decision_id, action_id, item_id, event_id, kind, pre_json, undo_until, written_at ON auto_writes
  BEGIN SELECT RAISE(ABORT,'append-only'); END;

CREATE TABLE transcripts (chat_jid TEXT NOT NULL, wa_msg_id TEXT NOT NULL,
                        status TEXT NOT NULL CHECK(status IN ('done','empty','failed','aborted')),
                        text TEXT, language TEXT, seconds REAL NOT NULL CHECK(seconds >= 0),
                        model_label TEXT NOT NULL, error_code TEXT, created_at INTEGER NOT NULL,
                        PRIMARY KEY(chat_jid, wa_msg_id)) WITHOUT ROWID;

CREATE TABLE media_cache (item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
                        chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                        wa_msg_id TEXT NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
                        width INTEGER NOT NULL, height INTEGER NOT NULL, bytes INTEGER NOT NULL,
                        created_at INTEGER NOT NULL, PRIMARY KEY(chat_id, wa_msg_id));
CREATE INDEX ix_media_cache_item ON media_cache(item_id) WHERE item_id IS NOT NULL;

-- ---------- 7. actions triggers, v2 text (created after auto_decisions exists) ----------
CREATE TRIGGER trg_actions_state BEFORE UPDATE OF state ON actions WHEN NEW.state <> OLD.state BEGIN
  SELECT CASE
    WHEN OLD.state IN ('done','failed','rejected','expired','superseded') THEN RAISE(ABORT,'terminal state')
    WHEN NEW.state='pending'   THEN RAISE(ABORT,'cannot return to pending')
    WHEN NEW.state='approved'  AND (OLD.state<>'pending' OR NEW.approved_at IS NULL OR NEW.approved_final_json IS NULL) THEN RAISE(ABORT,'bad approve')
    WHEN NEW.state='approved'  AND NEW.approved_by IS NULL THEN RAISE(ABORT,'bad approve')
    WHEN NEW.state='approved'  AND NEW.kind='send_reply' AND NEW.approved_by <> 'user' THEN RAISE(ABORT,'send needs a click')
    WHEN NEW.state='approved'  AND NEW.approved_by = 'user_toast'
         AND (NEW.kind <> 'update_event' OR json_extract(NEW.canonical_json,'$.change') IS NOT 'undo'
              OR json_extract(NEW.canonical_json,'$.revertOf') IS NULL) THEN RAISE(ABORT,'toast approves undo only')   -- [F4 (1)]
    WHEN NEW.state='approved'  AND NEW.approved_by NOT IN ('user','user_toast')
         AND NOT EXISTS (SELECT 1 FROM auto_decisions d JOIN auto_policies p ON p.id = d.policy_id
                         WHERE d.id = NEW.approved_by AND d.action_id = NEW.id AND d.verdict = 'auto' AND p.state = 'on'
                           AND p.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)            -- [F4 (3)] lazy expiry is not enough
                           AND NEW.approved_final_json = NEW.canonical_json                          -- [F4 (2)] tryAuto never edits
                           AND json_extract(NEW.canonical_json,'$.change') IS NOT 'undo'             -- undo is always a click / the toast
                           AND ((NEW.kind = 'create_event' AND d.kind = 'create')
                                OR (NEW.kind = 'update_event' AND d.kind IN ('update','cancel')))) -- [F4] decision kind matches the action
         THEN RAISE(ABORT,'auto approve without live policy decision')
    WHEN NEW.state='executing' AND (OLD.state<>'approved' OR NEW.approved_final_json IS NULL) THEN RAISE(ABORT,'execute without approval')
    WHEN NEW.state='done'      AND OLD.state NOT IN ('executing','unknown_outcome') THEN RAISE(ABORT,'bad done')
    WHEN NEW.state IN ('failed','unknown_outcome') AND OLD.state<>'executing' THEN RAISE(ABORT,'bad outcome')
    WHEN NEW.state='rejected'  AND OLD.state<>'pending' THEN RAISE(ABORT,'bad reject')
    WHEN NEW.state IN ('expired','superseded') AND OLD.state NOT IN ('pending','unknown_outcome') THEN RAISE(ABORT,'bad close')
  END; END;
CREATE TRIGGER trg_actions_insert BEFORE INSERT ON actions
  WHEN NEW.state <> 'pending' OR NEW.canonical_json IS NULL OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.approved_final_json IS NOT NULL BEGIN
  SELECT RAISE(ABORT,'actions must be born pending with content'); END;
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
CREATE TRIGGER trg_actions_final_frozen BEFORE UPDATE OF approved_final_json ON actions
  WHEN OLD.state IN ('executing','done','failed','unknown_outcome')
   AND NOT (NEW.approved_final_json IS NULL AND OLD.state <> 'executing')
  BEGIN SELECT RAISE(ABORT,'final payload is immutable'); END;
CREATE TRIGGER trg_actions_approver_frozen BEFORE UPDATE OF approved_by ON actions
  WHEN NEW.approved_by IS NOT OLD.approved_by
   AND NOT (OLD.approved_by IS NULL AND OLD.state = 'pending' AND NEW.state = 'approved')
  BEGIN SELECT RAISE(ABORT,'approver is immutable'); END;

-- ---------- 8. consents (rebuild: kind CHECK; + terms_read_on) ----------
CREATE TABLE consents_new (kind TEXT NOT NULL CHECK(kind IN ('whatsapp_tos','cloud_claude','cloud_gemini','cloud_claude_cli','cloud_antigravity_cli')),
                        version INTEGER NOT NULL, accepted_at INTEGER NOT NULL,
                        terms_read_on TEXT CHECK(terms_read_on IS NULL OR terms_read_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
                        PRIMARY KEY(kind, version));
INSERT INTO consents_new (kind, version, accepted_at, terms_read_on) SELECT kind, version, accepted_at, NULL FROM consents;
DROP TABLE consents;
ALTER TABLE consents_new RENAME TO consents;

-- ---------- 9. model_files (rebuild: id CHECK widens; + kind) ----------
CREATE TABLE model_files_new (id TEXT PRIMARY KEY CHECK(id IN ('tiny','small','mid','mmproj-tiny','mmproj-small','mmproj-mid',
                                                               'voice-hebrew','voice-multilingual','voice-lite','voice-vad')),
                        kind TEXT NOT NULL DEFAULT 'llm' CHECK(kind IN ('llm','mmproj','asr','vad')),
                        path TEXT NOT NULL, size INTEGER NOT NULL,
                        sha256 TEXT NOT NULL, mtime INTEGER NOT NULL,
                        status TEXT NOT NULL CHECK(status IN ('none','downloading','paused','verifying','ready','failed')),
                        bytes_done INTEGER NOT NULL DEFAULT 0, verified_at INTEGER, bench_json TEXT,
                        CHECK(kind = CASE WHEN id IN ('tiny','small','mid') THEN 'llm' WHEN id LIKE 'mmproj-%' THEN 'mmproj'
                                          WHEN id = 'voice-vad' THEN 'vad' ELSE 'asr' END));
INSERT INTO model_files_new (id, kind, path, size, sha256, mtime, status, bytes_done, verified_at, bench_json)
  SELECT id, 'llm', path, size, sha256, mtime, status, bytes_done, verified_at, bench_json FROM model_files;
DROP TABLE model_files;
ALTER TABLE model_files_new RENAME TO model_files;

-- ---------- 10. chats (ADD COLUMN) ----------
ALTER TABLE chats ADD COLUMN auto_policy TEXT NOT NULL DEFAULT 'inherit' CHECK(auto_policy IN ('inherit','never'));
ALTER TABLE chats ADD COLUMN auto_tainted_until INTEGER;

-- ---------- 11. settings value (strict schema: the new groups must exist before SettingsSchema.parse runs) ----------
UPDATE settings SET value_json = json_insert(value_json,
    '$.llm.cli',            json('{"claudeModel":"sonnet","agyModel":"gemini-3.8-flash-high","maxRunsPerHour":20,"allowOverage":false,"claudeExePath":""}'),
    '$.whatsapp.readTools', json('{"enabled":true,"scope":"trigger_chat","windowDays":30}'),
    '$.voice',              json('{"enabled":false,"tier":"auto","maxMinutes":15,"threads":"auto"}'),
    '$.images',             json('{"enabled":true,"cloud":true}'))
  WHERE key = 'settings'
    -- [v2-fix-src-main-db, data-integrity-v4-6] a row that is not a JSON object is left as it is: the v1 settings repo already reads
    -- such a row as DEFAULT_SETTINGS, and json_insert would raise a malformed-JSON error on it and abort the whole migration. CASE keeps
    -- json_type() from ever seeing invalid text (SQLite does not promise AND short-circuits).
    AND CASE WHEN json_valid(value_json) THEN json_type(value_json) = 'object' ELSE 0 END;
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
    // [V2] PRAGMA foreign_keys is a no-op inside a transaction (SQLite docs), so it MUST be switched here, outside db.transaction().
    if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys=OFF');
    try {
      db.transaction(() => {
        db.exec(m.sql);
        if (m.foreignKeysOff && db.prepare('PRAGMA foreign_key_check').all().length > 0)
          throw new MigrationError('fk_violation', from, m.version);
        db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          now(),
        );
        db.exec(`PRAGMA user_version = ${m.version}`);
      });
    } catch (e) {
      throw e instanceof MigrationError ? e : new MigrationError('failed', from, m.version, e);
    } finally {
      if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys=ON');
    }
    to = m.version;
  }
  return { from, to };
}

/** Surfaced by the caller as DB_RECOVERY (restore newest backup). [V2 CHANGE] + 'fk_violation'. */
export class MigrationError extends Error {
  readonly reason: 'downgrade' | 'failed' | 'fk_violation';
  readonly from: number;
  readonly target: number;
  constructor(reason: 'downgrade' | 'failed' | 'fk_violation', from: number, target: number, cause?: unknown) {
    super(`migration ${reason}: user_version ${from} -> ${target}`, cause === undefined ? undefined : { cause });
    this.name = 'MigrationError';
    this.reason = reason;
    this.from = from;
    this.target = target;
  }
}
