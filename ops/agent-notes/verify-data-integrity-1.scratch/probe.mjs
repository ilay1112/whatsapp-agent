// Independent probe for review finding data-integrity-1.
// Question: does SQLite's `ON DELETE SET NULL` on actions.retry_of fire trg_actions_frozen?
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../../src/main/db/migrations.ts', import.meta.url), 'utf8');
const m = src.match(/String\.raw`([\s\S]*?)`,\n\s*},\n\] as const;/);
if (!m) throw new Error('could not extract migration SQL');
const SCHEMA = m[1];

function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA);
  db.exec(`INSERT INTO chats(id,jid,created_at,updated_at) VALUES (1,'x@s.whatsapp.net',0,0)`);
  db.exec(`INSERT INTO items(id,chat_id,state,trigger_msg_id,trigger_ts,created_at,updated_at,closed_at,closed_reason)
           VALUES (1,1,'ignored','m1',0,0,0,100,'dismissed')`);
  db.exec(`INSERT INTO proposals(id,item_id,version,provider,model,created_at) VALUES (1,1,1,'local','m',0)`);
  const ins = (id, attempt, retryOf, state) =>
    db
      .prepare(
        `INSERT INTO actions(id,item_id,proposal_id,chat_id,kind,canonical_json,content_sha256,idempotency_key,attempt,retry_of,state,created_at,expires_at)
         VALUES (?,1,1,1,'send_reply','{}',?,?,?,?,'pending',0,999999)`,
      )
      .run(id, 'a'.repeat(64), 'key-' + id, attempt, retryOf);
  ins('a1', 1, null);
  ins('a2', 2, 'a1'); // the retry clone
  return db;
}

function report(label, fn) {
  try {
    const r = fn();
    console.log(`PASS  ${label}` + (r === undefined ? '' : ` -> ${JSON.stringify(r)}`));
  } catch (e) {
    console.log(`ABORT ${label} -> ${e.code ?? ''} ${e.message}`);
  }
}

// 1. direct delete of the retry parent
{
  const db = fresh();
  report('direct DELETE FROM actions WHERE id=a1', () => {
    db.prepare(`DELETE FROM actions WHERE id='a1'`).run();
    return db.prepare(`SELECT id, retry_of FROM actions`).all();
  });
  db.close();
}

// 2. cascade from items (the retention.purge path)
{
  const db = fresh();
  report('DELETE FROM items WHERE closed_at < 200 (cascade)', () => {
    const c = db.prepare(`DELETE FROM items WHERE closed_at IS NOT NULL AND closed_at < 200`).run().changes;
    return { itemsDeleted: c, actionsLeft: db.prepare(`SELECT COUNT(*) n FROM actions`).get() };
  });
  db.close();
}

// 3. control: no retry chain
{
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA);
  db.exec(`INSERT INTO chats(id,jid,created_at,updated_at) VALUES (1,'x@s.whatsapp.net',0,0)`);
  db.exec(`INSERT INTO items(id,chat_id,state,trigger_msg_id,trigger_ts,created_at,updated_at,closed_at,closed_reason)
           VALUES (1,1,'ignored','m1',0,0,0,100,'dismissed')`);
  db.exec(`INSERT INTO proposals(id,item_id,version,provider,model,created_at) VALUES (1,1,1,'local','m',0)`);
  db.prepare(
    `INSERT INTO actions(id,item_id,proposal_id,chat_id,kind,canonical_json,content_sha256,idempotency_key,attempt,retry_of,state,created_at,expires_at)
     VALUES ('a1',1,1,1,'send_reply','{}',?, 'k1',1,NULL,'pending',0,999999)`,
  ).run('a'.repeat(64));
  report('control: cascade with no retry_of', () => {
    const c = db.prepare(`DELETE FROM items WHERE closed_at IS NOT NULL AND closed_at < 200`).run().changes;
    return { itemsDeleted: c };
  });
  db.close();
}

// 4. does insertion ORDER matter (clone inserted before parent in rowid terms)?
{
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA);
  db.exec(`INSERT INTO chats(id,jid,created_at,updated_at) VALUES (1,'x@s.whatsapp.net',0,0)`);
  db.exec(`INSERT INTO items(id,chat_id,state,trigger_msg_id,trigger_ts,created_at,updated_at,closed_at,closed_reason)
           VALUES (1,1,'ignored','m1',0,0,0,100,'dismissed')`);
  db.exec(`INSERT INTO proposals(id,item_id,version,provider,model,created_at) VALUES (1,1,1,'local','m',0)`);
  const ins = (id, attempt, retryOf) =>
    db
      .prepare(
        `INSERT INTO actions(id,item_id,proposal_id,chat_id,kind,canonical_json,content_sha256,idempotency_key,attempt,retry_of,state,created_at,expires_at)
         VALUES (?,1,1,1,'send_reply','{}',?,?,?,?,'pending',0,999999)`,
      )
      .run(id, 'a'.repeat(64), 'key-' + id, attempt, retryOf);
  ins('a1', 1, null);
  ins('a2', 2, 'a1');
  // make a2 terminal + purged so the frozen trigger's escape hatch could apply
  db.exec(`UPDATE actions SET state='superseded' WHERE id='a2'`);
  db.exec(`UPDATE actions SET canonical_json=NULL WHERE id='a2'`);
  report('cascade with terminal+purged clone', () => {
    const c = db.prepare(`DELETE FROM items WHERE closed_at IS NOT NULL AND closed_at < 200`).run().changes;
    return { itemsDeleted: c };
  });
  db.close();
}

// 5. sanity: is retry_of really SET NULL and not CASCADE? check the trigger fires at all on a plain UPDATE
{
  const db = fresh();
  report('plain UPDATE actions SET retry_of=NULL WHERE id=a2', () => {
    db.prepare(`UPDATE actions SET retry_of=NULL WHERE id='a2'`).run();
    return 'no abort';
  });
  db.close();
}
