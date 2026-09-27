// src/main/db/repos/rate.ts - Repos['rate'] implementation over the Db wrapper (owner W1-04). Signatures: CONTRACTS 15.1.
// key = String(chatId) for the *_chat buckets, 'global' otherwise (shared/types.ts RATE_BUCKETS).
import { RATE_BUCKETS } from '../../../shared/types';
import { RepoContractError } from '../errors';
import type { Db, Repos } from '../index';

export type RateRepo = Repos['rate'];

export function createRateRepo(db: Db): RateRepo {
  const assertBucket = (bucket: string): void => {
    if (!(RATE_BUCKETS as readonly string[]).includes(bucket)) throw new RepoContractError('unknown rate bucket');
  };
  return {
    record(bucket, key, now) {
      assertBucket(bucket);
      db.prepare(`INSERT INTO rate_events(bucket, key, ts) VALUES (?, ?, ?)`).run(bucket, key, now);
    },
    countSince(bucket, key, since) {
      assertBucket(bucket);
      return db
        .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND key = ? AND ts >= ?`)
        .get(bucket, key, since)!.n;
    },
    lastTs(bucket, key) {
      assertBucket(bucket);
      return db
        .prepare<{ ts: number | null }>(`SELECT MAX(ts) AS ts FROM rate_events WHERE bucket = ? AND key = ?`)
        .get(bucket, key)!.ts;
    },
  };
}
