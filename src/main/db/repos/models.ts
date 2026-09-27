// src/main/db/repos/models.ts - Repos['models'] implementation over the Db wrapper (owner W1-04). Signatures: CONTRACTS 15.1.
import type { Db, Repos } from '../index';
import { type ModelFileRow, toModelFile } from './rows';

export type ModelsRepo = Repos['models'];
const MODEL_COLUMNS = 'id, path, size, sha256, mtime, status, bytes_done, verified_at, bench_json';

export function createModelsRepo(db: Db): ModelsRepo {
  return {
    get(tier) {
      const row = db.prepare<ModelFileRow>(`SELECT ${MODEL_COLUMNS} FROM model_files WHERE id = ?`).get(tier);
      return row ? toModelFile(row) : null;
    },
    upsert(r) {
      db.prepare(
        `INSERT INTO model_files(id, path, size, sha256, mtime, status, bytes_done, verified_at, bench_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET path = excluded.path, size = excluded.size, sha256 = excluded.sha256, mtime = excluded.mtime,
                                       status = excluded.status, bytes_done = excluded.bytes_done, verified_at = excluded.verified_at,
                                       bench_json = excluded.bench_json`,
      ).run(
        r.id,
        r.path,
        r.size,
        r.sha256,
        r.mtime,
        r.status,
        r.bytesDone,
        r.verifiedAt,
        r.bench === null ? null : JSON.stringify(r.bench),
      );
    },
    delete(tier) {
      db.prepare(`DELETE FROM model_files WHERE id = ?`).run(tier);
    },
  };
}
