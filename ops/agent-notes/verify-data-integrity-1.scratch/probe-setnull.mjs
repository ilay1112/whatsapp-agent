// Independent probe: does an FK ON DELETE SET NULL fire a BEFORE UPDATE OF trigger in node:sqlite?
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/main/db/migrations.ts', 'utf8');
const sql = src.split('sql: String.raw`')[1].split('`,\n  },')[0];

function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(sql);
  const T = 1_760_000_000_000;
  db.prepare(`INSERT INTO chats(id,jid,is_known,force_known,sendable,policy,created_at,updated_at) VALUES (1,'x@s.whatsapp.net',1,0,1,'default',?,?)`).run(T,T);
  db.prepare(`INSERT INTO items(id,chat_id,state,analysis,trigger_msg_id,trigger_ts,created_at,updated_at,closed_reason,closed_at)
    VALUES (1,1,'ignored','done','m1',?,?,?,'dismissed',?)`).run(T,T,T,T);
  db.prepare(`INSERT INTO proposals(id,item_id,version,provider,model,created_at) VALUES (1,1,1,'local','m',?)`).run(T);
  return { db, T };
}

console.log('sqlite recursive_triggers pragma:', (() => { const {db}=fresh(); return JSON.stringify(db.prepare('PRAGMA recursive_triggers').get()); })());

// generic minimal control: does SET NULL fire a BEFORE UPDATE OF trigger at all?
{
  const d = new DatabaseSync(':memory:');
  d.exec('PRAGMA foreign_keys=ON');
  d.exec(`CREATE TABLE p(id INTEGER PRIMARY KEY);
          CREATE TABLE c(id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES p(id) ON DELETE SET NULL);
          CREATE TRIGGER t BEFORE UPDATE OF p_id ON c BEGIN SELECT RAISE(ABORT,'fired'); END;
          INSERT INTO p VALUES(1); INSERT INTO c VALUES(10,1);`);
  try { d.prepare('DELETE FROM p WHERE id=1').run(); console.log('control: SET NULL did NOT fire trigger; c.p_id =', JSON.stringify(d.prepare('SELECT p_id FROM c').get())); }
  catch (e) { console.log('control: trigger FIRED ->', e.message); }
}

const sha = 'a'.repeat(64);
function seedPair({ nullParentCanonical = false } = {}) {
  const { db, T } = fresh();
  const ins = db.prepare(`INSERT INTO actions(id,item_id,proposal_id,chat_id,kind,canonical_json,content_sha256,idempotency_key,attempt,retry_of,state,created_at,expires_at)
    VALUES (?,1,1,1,'send_reply','{"k":1}',?,?,?,?,'pending',?,?)`);
  ins.run('A', sha, 'k-A', 1, null, T, T + 86400000);
  ins.run('B', sha, 'k-B', 2, 'A', T, T + 86400000);
  db.prepare(`UPDATE actions SET state='rejected' WHERE id='A'`).run();
  db.prepare(`UPDATE actions SET state='rejected' WHERE id='B'`).run();
  if (nullParentCanonical) {
    db.prepare(`UPDATE actions SET canonical_json=NULL WHERE canonical_json IS NOT NULL`).run();
  }
  return { db, T };
}

for (const nulled of [false, true]) {
  console.log(`\n=== canonical purged first: ${nulled} ===`);
  {
    const { db } = seedPair({ nullParentCanonical: nulled });
    try { db.prepare(`DELETE FROM actions WHERE id='A'`).run(); console.log(' direct delete of A: OK, B.retry_of =', JSON.stringify(db.prepare(`SELECT retry_of FROM actions WHERE id='B'`).get())); }
    catch (e) { console.log(' direct delete of A: THREW ->', e.message); }
  }
  {
    const { db, T } = seedPair({ nullParentCanonical: nulled });
    try {
      const n = db.prepare(`DELETE FROM items WHERE closed_at IS NOT NULL AND closed_at < ?`).run(T + 1).changes;
      console.log(' item cascade: OK, items deleted =', n, 'actions left =', JSON.stringify(db.prepare(`SELECT COUNT(*) n FROM actions`).get()));
    } catch (e) { console.log(' item cascade: THREW ->', e.message); }
  }
}
