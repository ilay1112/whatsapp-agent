// Probe: does ON DELETE SET NULL on actions.retry_of fire trg_actions_frozen?
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/main/db/migrations.ts', 'utf8');
const sql = src.split('sql: String.raw`')[1].split('`,\n  },')[0];

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
db.exec(sql);

const T = 1_760_000_000_000;
db.prepare(`INSERT INTO chats(id,jid,is_known,force_known,sendable,policy,created_at,updated_at) VALUES (1,'x@s.whatsapp.net',1,0,1,'default',?,?)`).run(T,T);
db.prepare(`INSERT INTO items(id,chat_id,state,analysis,trigger_msg_id,trigger_ts,created_at,updated_at,closed_reason,closed_at)
  VALUES (1,1,'ignored','done','m1',?,?,?,'dismissed',?)`).run(T,T,T,T);
db.prepare(`INSERT INTO proposals(id,item_id,version,provider,model,created_at) VALUES (1,1,1,'local','m',?)`).run(T);

const ins = db.prepare(`INSERT INTO actions(id,item_id,proposal_id,chat_id,kind,canonical_json,content_sha256,idempotency_key,attempt,retry_of,state,created_at,expires_at)
  VALUES (?,1,1,1,'send_reply','{"k":1}',?,?,?,?,'pending',?,?)`);
const sha = 'a'.repeat(64);
ins.run('A', sha, '1:send_reply:1', 1, null, T, T + 86400000);
ins.run('B', sha, '1:send_reply:1:r2', 2, 'A', T, T + 86400000);

// take both to a terminal state
db.prepare(`UPDATE actions SET state='rejected' WHERE id='A'`).run();
db.prepare(`UPDATE actions SET state='rejected' WHERE id='B'`).run();

console.log('--- case 1: delete parent action A directly (SET NULL on B.retry_of)');
try {
  db.prepare(`DELETE FROM actions WHERE id='A'`).run();
  console.log('   OK, B.retry_of =', db.prepare(`SELECT retry_of FROM actions WHERE id='B'`).get());
} catch (e) {
  console.log('   THREW:', e.message);
}

console.log('--- case 2: delete the closed item (cascade to both actions)');
try {
  const n = db.prepare(`DELETE FROM items WHERE closed_at IS NOT NULL AND closed_at < ?`).run(T + 1).changes;
  console.log('   OK, items deleted =', n, ' actions left =', db.prepare(`SELECT COUNT(*) n FROM actions`).get());
} catch (e) {
  console.log('   THREW:', e.message);
}
