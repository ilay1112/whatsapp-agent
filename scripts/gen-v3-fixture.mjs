#!/usr/bin/env node
// scripts/gen-v3-fixture.mjs - builds src/main/db/__fixtures__/v3.db, a synthetic v0.1.x app database at user_version 3, for the
// v3 -> v4 round-trip (T2 8.2 group 24, ARCHITECTURE-v2 B22 release gate). Owner: V2-W1-01-db.
//
// - The schema comes from the LIVE migrations 1-3 of src/main/db/migrations.ts (imported, never copied), applied in order with the
//   same schema_migrations bookkeeping the runner writes, then PRAGMA user_version = 3.
// - The rows are SYNTHETIC only (T5): JIDs 9725500000NN@s.whatsapp.net / a synthetic @lid, invented titles, no real text, no key.
//   Coverage: every `actions` state x kind of v3 (9 x 2), a retry chain, a retention-purged terminal row, every v3 `event_state`,
//   consents, runs, audit rows, rate events, model files, a queue row with rev, meta and a v1 settings row.
// - The output is DETERMINISTIC (fixed ids and clocks, rollback journal, VACUUM), so the committed file can be regenerated
//   byte-identically with the same Node (bundled SQLite) and compared by sha256 in tests/security/migration-v4.test.ts.
// - Never fetches anything, never touches another database. Usage: node scripts/gen-v3-fixture.mjs [outFile]
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MIGRATIONS } from '../src/main/db/migrations.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const V3_FIXTURE_PATH = path.join(REPO_ROOT, 'src', 'main', 'db', '__fixtures__', 'v3.db');

/** 2026-09-21T08:53:20Z - every timestamp of the fixture is an offset from this instant. */
export const V3_T = 1_790_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const V3_JIDS = {
  a: '972550000001@s.whatsapp.net',
  b: '972550000002@s.whatsapp.net',
  c: '972550000003@s.whatsapp.net',
  lid: '10000000000001@lid',
};

/** The v1 settings row exactly as v0.1.x wrote it (no llm.cli / whatsapp.readTools / voice / images - migration v4 adds them). */
export const V1_SETTINGS = {
  general: { language: 'system', autostart: false, timeZone: 'Asia/Jerusalem', notifications: 'generic' },
  llm: {
    provider: 'local',
    claudeModel: 'claude-opus-5',
    geminiModel: 'gemini-3.8-flash',
    local: { tier: 'auto', acceleration: 'auto', forceCpu: false },
    cloudDailyTokenBudget: 200000,
  },
  whatsapp: { processUnknownSenders: false, backlogHours: 0 },
  calendar: { targetCalendarId: 'primary', conflictCalendarIds: ['primary'], defaultDurationMin: 60 },
  agent: { paused: false, ambiguousHour: 'assume', userGender: 'unspecified' },
  privacy: { retentionDays: 30 },
};

/** shared/schemas canonicalJson for the flat v1 payloads: keys sorted, no whitespace. */
function canonical(obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

export const V3_ACTION_STATES = [
  'pending',
  'approved',
  'executing',
  'done',
  'failed',
  'unknown_outcome',
  'rejected',
  'expired',
  'superseded',
];

/** Builds the fixture at `outFile` (overwritten). Returns the sha256 of the written bytes. */
export function buildV3Fixture(outFile = V3_FIXTURE_PATH) {
  const tmp = `${outFile}.tmp`;
  for (const f of [tmp, `${tmp}-journal`]) fs.rmSync(f, { force: true });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const db = new DatabaseSync(tmp);
  try {
    db.exec('PRAGMA journal_mode=DELETE');
    db.exec('PRAGMA foreign_keys=ON');
    for (const m of MIGRATIONS.filter((x) => x.version <= 3)) {
      db.exec('BEGIN');
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        V3_T - 30 * DAY + m.version * MIN,
      );
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    }
    db.exec('BEGIN');
    seed(db);
    db.exec('COMMIT');
    db.exec('VACUUM');
    // v0.1.x opened its file with PRAGMA journal_mode=WAL (db/index.ts openDb), which is persisted in the header: the fixture is
    // left in WAL mode like a real install, so a failed v4 migration can be compared byte for byte (uncommitted WAL frames never
    // reach the main file).
    db.exec('PRAGMA journal_mode=WAL');
  } finally {
    db.close();
  }
  for (const f of [`${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
  fs.rmSync(outFile, { force: true });
  fs.renameSync(tmp, outFile);
  return createHash('sha256').update(fs.readFileSync(outFile)).digest('hex');
}

function seed(db) {
  const T = V3_T;
  const run = (sql, ...params) => db.prepare(sql).run(...params);

  // ---- meta / settings / secrets / consents ----
  run(`INSERT INTO meta(key, value) VALUES ('onboarding_step', 'done')`);
  run(`INSERT INTO meta(key, value) VALUES ('paired_at', ?)`, String(T - 20 * DAY));
  run(`INSERT INTO meta(key, value) VALUES ('bridge_rowid_watermark', '4242')`);
  run(`INSERT INTO meta(key, value) VALUES ('last_backup_at', ?)`, String(T - DAY));
  run(
    `INSERT INTO settings(key, value_json, updated_at) VALUES ('settings', ?, ?)`,
    JSON.stringify(V1_SETTINGS),
    T - 10 * DAY,
  );
  run(
    `INSERT INTO secrets(name, ciphertext, updated_at) VALUES ('anthropic_api_key', ?, ?)`,
    new Uint8Array([0, 1, 2, 3]),
    T - 9 * DAY,
  );
  run(`INSERT INTO consents(kind, version, accepted_at) VALUES ('whatsapp_tos', 1, ?)`, T - 20 * DAY);
  run(`INSERT INTO consents(kind, version, accepted_at) VALUES ('cloud_claude', 1, ?)`, T - 9 * DAY);
  run(`INSERT INTO consents(kind, version, accepted_at) VALUES ('cloud_gemini', 1, ?)`, T - 8 * DAY);

  // ---- chats: a known contact, an opted-out contact, a third contact and an unresolved @lid chat ----
  const chat = (id, jid, extra) =>
    run(
      `INSERT INTO chats(id, jid, display_name, is_known, force_known, sendable, policy, lang, last_inbound_ts, last_outbound_ts,
                         last_triaged_msg_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      jid,
      extra.name,
      extra.known,
      extra.forceKnown ?? 0,
      extra.sendable,
      extra.policy ?? 'default',
      extra.lang ?? null,
      T - HOUR,
      extra.outbound ?? null,
      extra.triaged ?? null,
      T - 20 * DAY,
      T - HOUR,
    );
  chat(1, V3_JIDS.a, {
    name: 'Synthetic Contact A',
    known: 1,
    sendable: 1,
    lang: 'he',
    outbound: T - 2 * HOUR,
    triaged: 'SYN-A-9',
  });
  chat(2, V3_JIDS.b, { name: 'Synthetic Contact B', known: 1, sendable: 1, policy: 'never', lang: 'en' });
  chat(3, V3_JIDS.c, { name: null, known: 0, forceKnown: 1, sendable: 1 });
  chat(4, V3_JIDS.lid, { name: null, known: 0, sendable: 0 });

  // ---- items: every v3 event_state (none, incomplete, proposed, created, declined), open / closed / held / queued ----
  const item = (id, chatId, p) =>
    run(
      `INSERT INTO items(id, chat_id, state, analysis, hold_reason, error_code, reply_state, event_state, trigger_msg_id, trigger_ts,
                         missing_json, badges_json, current_proposal_id, editing_until, calendar_event_id, calendar_html_link,
                         event_start_ts, closed_reason, closed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      chatId,
      p.state,
      p.analysis ?? 'done',
      p.hold ?? null,
      p.error ?? null,
      p.reply ?? 'none',
      p.event ?? 'none',
      `SYN-${id}`,
      T - (20 - id) * HOUR,
      p.missing ?? '[]',
      p.badges ?? '[]',
      p.proposal ?? null,
      p.editingUntil ?? 0,
      p.eventId ?? null,
      p.htmlLink ?? null,
      p.startTs ?? null,
      p.closed ?? null,
      p.closedAt ?? null,
      T - (20 - id) * HOUR,
      T - (20 - id) * HOUR + MIN,
    );
  item(1, 1, { state: 'ignored', closed: 'not_needed', closedAt: T - 19 * HOUR });
  item(2, 1, { state: 'info_missing', event: 'incomplete', missing: '["time"]', badges: '["time_assumed"]' });
  item(3, 2, { state: 'needs_reply', reply: 'draft', event: 'proposed', editingUntil: T - 16 * HOUR });
  item(4, 3, {
    state: 'in_calendar',
    reply: 'sent',
    event: 'created',
    eventId: 'syn0evt0000000000000000000000001',
    htmlLink: 'https://calendar.invalid/event?eid=synthetic',
    startTs: T + 3 * DAY,
  });
  item(5, 3, { state: 'ignored', reply: 'sent', event: 'declined', closed: 'replied', closedAt: T - 14 * HOUR });
  item(6, 4, { state: 'needs_reply', analysis: 'held', hold: 'unknown_sender' });
  item(7, 3, { state: 'needs_reply', analysis: 'queued' });
  item(8, 2, {
    state: 'ignored',
    analysis: 'failed',
    error: 'LLM_LOCAL_FAILED',
    closed: 'expired',
    closedAt: T - 12 * HOUR,
  });
  // an old in_calendar event without a stored event id (v1 created it before the id column was filled) - not editable in v2
  item(9, 1, { state: 'in_calendar', event: 'created', startTs: T + 5 * DAY });

  // ---- item_messages (synthetic text) ----
  const msg = (itemId, n, fromMe, text) =>
    run(
      `INSERT INTO item_messages(item_id, wa_msg_id, from_me, ts, text, text_sha256) VALUES (?, ?, ?, ?, ?, ?)`,
      itemId,
      `SYN-${itemId}-${n}`,
      fromMe,
      T - (20 - itemId) * HOUR + n * 1000,
      text,
      sha256(text ?? `purged-${itemId}-${n}`),
    );
  msg(2, 1, 0, 'Synthetic: can we meet on Thursday?');
  msg(3, 1, 0, 'Synthetic: are you free tomorrow at five?');
  msg(3, 2, 1, 'Synthetic: let me check.');
  msg(4, 1, 0, 'Synthetic: see you on Sunday at ten.');
  msg(1, 1, 0, null); // a row whose text retention already nulled

  // ---- triage_queue (v3 rev column) ----
  run(
    `INSERT INTO triage_queue(chat_id, due_at, first_enqueued_at, attempts, last_error, rev) VALUES (3, ?, ?, 1, 'LLM_LOCAL_FAILED', 2)`,
    T + 20_000,
    T - MIN,
  );

  // ---- runs (v3 stage / provider lists) ----
  const runRow = (itemId, stage, provider, outcome, extra = {}) =>
    run(
      `INSERT INTO runs(item_id, stage, provider, model, started_at, finished_at, outcome, input_tokens, output_tokens, tool_calls,
                        blocked_tool_calls, error_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      itemId,
      stage,
      provider,
      `${provider}-synthetic-model`,
      T - (20 - itemId) * HOUR + 2000,
      outcome === null ? null : T - (20 - itemId) * HOUR + 9000,
      outcome,
      extra.inTok ?? null,
      extra.outTok ?? null,
      extra.tools ?? 0,
      extra.blocked ?? 0,
      extra.error ?? null,
    );
  runRow(3, 'extract', 'local', 'ok');
  runRow(3, 'draft', 'claude', 'ok', { inTok: 1200, outTok: 80, tools: 2, blocked: 1 });
  runRow(4, 'extract', 'gemini', 'ok', { inTok: 900, outTok: 60 });
  runRow(8, 'extract', 'local', 'failed', { error: 'LLM_LOCAL_FAILED' });
  runRow(7, 'extract', 'local', null); // still running when v0.1.x quit

  // ---- proposals (v3 provider list incl. 'user') ----
  const proposal = (id, itemId, version, provider, p = {}) =>
    run(
      `INSERT INTO proposals(id, item_id, version, provider, model, extraction_json, draft_text, reply_lang, event_json, freebusy_json,
                             suspicious, created_at, superseded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      itemId,
      version,
      provider,
      `${provider}-synthetic-model`,
      p.extraction ?? null,
      p.draft ?? null,
      p.lang ?? null,
      p.event ?? null,
      p.freebusy ?? null,
      p.suspicious ?? 0,
      T - (20 - itemId) * HOUR + version * 10_000,
      p.superseded ?? null,
    );
  // The v1 ExtractionSchema shape (14 keys; the four B20 fields are absent - v2 reads them with StoredExtractionSchema defaults).
  const EXTRACTION_V1 = JSON.stringify({
    intent: 'schedule_request',
    needsReply: true,
    title: 'Synthetic meeting',
    dateKind: 'weekday',
    isoDate: '',
    weekday: 4,
    weekOffset: 0,
    daysFromToday: 0,
    time24h: '17:00',
    timeAmbiguous: false,
    durationMin: 0,
    location: '',
    missing: [],
    suspicious: false,
  });
  proposal(1, 2, 1, 'local', { extraction: EXTRACTION_V1, lang: 'en' });
  proposal(2, 3, 1, 'local', { draft: 'Synthetic draft v1', lang: 'en', superseded: T - 16 * HOUR });
  proposal(3, 3, 2, 'claude', {
    extraction: EXTRACTION_V1,
    draft: 'Synthetic draft v2',
    lang: 'en',
    event: JSON.stringify({
      title: 'Synthetic meeting',
      startLocal: '2026-09-24T17:00:00',
      endLocal: '2026-09-24T18:00:00',
      timeZone: 'Asia/Jerusalem',
      location: '',
      assumptions: [],
      dateHint: '2026-09-24',
    }),
    freebusy: '[]',
    suspicious: 1,
  });
  proposal(4, 4, 1, 'gemini', { draft: 'Synthetic confirmation', lang: 'he' });
  proposal(5, 5, 1, 'user', { draft: 'Synthetic manual reply', lang: 'he' });
  proposal(6, 1, 1, 'local', {}); // a retention-purged proposal (every payload column NULL)
  run(`UPDATE items SET current_proposal_id = 1 WHERE id = 2`);
  run(`UPDATE items SET current_proposal_id = 3 WHERE id = 3`);
  run(`UPDATE items SET current_proposal_id = 4 WHERE id = 4`);
  run(`UPDATE items SET current_proposal_id = 5 WHERE id = 5`);

  // ---- actions: every v3 state x kind, driven through the LIVE v3 triggers (born pending, legal transitions only) ----
  const itemFor = { send_reply: { item: 3, proposal: 3, chat: 2 }, create_event: { item: 4, proposal: 4, chat: 3 } };
  const payloadFor = (kind, n) => {
    const at = itemFor[kind];
    return kind === 'send_reply'
      ? canonical({ v: 1, kind, itemId: at.item, chatRef: at.chat, proposalVersion: n, text: `Synthetic reply ${n}` })
      : canonical({
          v: 1,
          kind,
          itemId: at.item,
          chatRef: at.chat,
          proposalVersion: n,
          title: `Synthetic event ${n}`,
          startLocal: '2026-09-24T17:00:00',
          endLocal: '2026-09-24T18:00:00',
          timeZone: 'Asia/Jerusalem',
          location: n % 2 === 0 ? 'Synthetic room' : '',
        });
  };
  const insertAction = (id, kind, n, created, retryOf = null, attempt = 1) => {
    const at = itemFor[kind];
    const canonicalJson = payloadFor(kind, n);
    run(
      `INSERT INTO actions(id, item_id, proposal_id, chat_id, kind, canonical_json, content_sha256, idempotency_key, attempt, retry_of,
                           state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      id,
      at.item,
      at.proposal,
      at.chat,
      kind,
      canonicalJson,
      sha256(canonicalJson),
      attempt === 1 ? `${at.item}:${kind}:${n}` : `${at.item}:${kind}:${n}:r${attempt}`,
      attempt,
      retryOf,
      created,
      created + DAY,
    );
    return canonicalJson;
  };
  const approve = (id, final, at) =>
    run(`UPDATE actions SET state = 'approved', approved_at = ?, approved_final_json = ? WHERE id = ?`, at, final, id);
  const setState = (id, state, extra = '') => run(`UPDATE actions SET state = '${state}'${extra} WHERE id = ?`, id);

  let n = 0;
  for (const kind of ['send_reply', 'create_event']) {
    for (const state of V3_ACTION_STATES) {
      n += 1;
      const id = `syn-act-${String(n).padStart(2, '0')}-${kind}-${state}`;
      const created = T - 10 * HOUR + n * MIN;
      const canonicalJson = insertAction(id, kind, n, created);
      // the user edited the draft of every even-numbered approval (approved_final_json <> canonical_json)
      const final = n % 2 === 0 ? canonicalJson.replace('Synthetic', 'Edited') : canonicalJson;
      if (['approved', 'executing', 'done', 'failed', 'unknown_outcome'].includes(state))
        approve(id, final, created + 1000);
      if (['executing', 'done', 'failed', 'unknown_outcome'].includes(state)) setState(id, 'executing');
      if (state === 'done') {
        const result =
          kind === 'send_reply'
            ? { kind, waMsgId: `SYN-OUT-${n}` }
            : { kind, eventId: `syn0evt00000000000000000000000${String(n).padStart(2, '0')}`, htmlLink: null };
        run(
          `UPDATE actions SET state = 'done', executed_at = ?, result_json = ? WHERE id = ?`,
          created + 5000,
          JSON.stringify(result),
          id,
        );
      }
      if (state === 'failed')
        run(
          `UPDATE actions SET state = 'failed', executed_at = ?, error_code = ? WHERE id = ?`,
          created + 5000,
          kind === 'send_reply' ? 'SEND_FAILED' : 'CAL_CREATE_FAILED',
          id,
        );
      if (state === 'unknown_outcome')
        run(`UPDATE actions SET state = 'unknown_outcome', executed_at = ? WHERE id = ?`, created + 5000, id);
      if (state === 'rejected' || state === 'expired' || state === 'superseded') setState(id, state);
    }
  }
  // a retry chain: a failed send whose pending clone points back at it (attempt 2)
  n += 1;
  const parent = 'syn-act-retry-parent';
  const parentJson = insertAction(parent, 'send_reply', n, T - 3 * HOUR);
  approve(parent, parentJson, T - 3 * HOUR + 1000);
  setState(parent, 'executing');
  run(
    `UPDATE actions SET state = 'failed', executed_at = ?, error_code = 'SEND_FAILED' WHERE id = ?`,
    T - 3 * HOUR + 2000,
    parent,
  );
  insertAction('syn-act-retry-clone', 'send_reply', n, T - 3 * HOUR + 3000, parent, 2);
  // a retention-purged terminal row (canonical_json and approved_final_json NULL, hashes kept)
  n += 1;
  const purged = 'syn-act-purged-done';
  const purgedJson = insertAction(purged, 'create_event', n, T - 40 * DAY);
  approve(purged, purgedJson, T - 40 * DAY + 1000);
  setState(purged, 'executing');
  run(
    `UPDATE actions SET state = 'done', executed_at = ?, result_json = ? WHERE id = ?`,
    T - 40 * DAY + 2000,
    JSON.stringify({ kind: 'create_event', eventId: 'syn0evt0000000000000000000000099', htmlLink: null }),
    purged,
  );
  run(`UPDATE actions SET canonical_json = NULL WHERE id = ?`, purged);
  run(`UPDATE actions SET approved_final_json = NULL WHERE id = ?`, purged);

  // ---- audit_log (append-only; metadata only) ----
  const audit = (ts, kind, ref, detail) =>
    run(`INSERT INTO audit_log(ts, kind, ref, detail_json) VALUES (?, ?, ?, ?)`, ts, kind, ref, JSON.stringify(detail));
  audit(T - 20 * DAY, 'consent', null, { kind: 'whatsapp_tos', version: 1 });
  audit(T - 20 * DAY + MIN, 'pairing', null, { outcome: 'paired' });
  audit(T - 9 * DAY, 'provider_changed', null, { from: 'local', to: 'claude' });
  audit(T - 10 * HOUR, 'action_created', 'syn-act-01-send_reply-pending', { kind: 'send_reply' });
  audit(T - 9 * HOUR, 'action_approved', 'syn-act-04-send_reply-done', { edited: true });
  audit(T - 9 * HOUR + 1000, 'action_done', 'syn-act-04-send_reply-done', { kind: 'send_reply' });
  audit(T - 8 * HOUR, 'tool_blocked', null, { reason: 'budget' });
  audit(T - DAY, 'purge', null, { mode: 'daily', retentionDays: 30, textRows: 2, actionRows: 1, itemsDeleted: 0 });

  // ---- rate_events / model_files ----
  run(`INSERT INTO rate_events(bucket, key, ts) VALUES ('send_chat', '2', ?)`, T - 9 * HOUR);
  run(`INSERT INTO rate_events(bucket, key, ts) VALUES ('send_global', '*', ?)`, T - 9 * HOUR);
  run(`INSERT INTO rate_events(bucket, key, ts) VALUES ('create_global', '*', ?)`, T - 8 * HOUR);
  run(
    `INSERT INTO model_files(id, path, size, sha256, mtime, status, bytes_done, verified_at, bench_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'small',
    'C:\\synthetic\\models\\small.gguf',
    2_000_000_000,
    'd'.repeat(64),
    T - 19 * DAY,
    'ready',
    2_000_000_000,
    T - 19 * DAY,
    JSON.stringify({ tokPerSec: 21.5, measuredAt: T - 19 * DAY, device: 'cpu' }),
  );
  run(
    `INSERT INTO model_files(id, path, size, sha256, mtime, status, bytes_done, verified_at, bench_json) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    'mid',
    'C:\\synthetic\\models\\mid.gguf.part',
    5_000_000_000,
    'e'.repeat(64),
    T - DAY,
    'paused',
    1_234_567_890,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const out = process.argv[2] ? path.resolve(process.argv[2]) : V3_FIXTURE_PATH;
  const digest = buildV3Fixture(out);
  process.stdout.write(`wrote ${path.relative(REPO_ROOT, out)} sha256=${digest}\n`);
}
