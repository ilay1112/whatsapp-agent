// T2 14 `npm run bench:wa` (U-D1 / research U4): the four WhatsApp-tool SELECTs on a 10^6-row messages.db. Owner V2-W1-05-wa-toolserver.
// Collected ONLY when the command line names tests/bench/ (vitest.config.ts BENCH_ON_COMMAND_LINE) - never part of `npm test`.
// The budgets are deliberately generous ceilings (a tool call must stay far below the 120 s S3 wall clock and the 2 s busy_timeout
// scale); the measured values are printed so they can be recorded in the notes / ACCEPTANCE.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeBridgeDb, type FakeBridgeDb } from '../fakes/fake-bridge-db.ts';
import { createBridgeDb, type BridgeDb } from '../../src/main/bridge/bridgeDb.ts';
import { createWaReadClient } from '../../src/main/bridge/waReadClient.ts';
import { createRepos, openDb, MEMORY_DB, type Db } from '../../src/main/db/index.ts';
import { DEFAULT_SETTINGS } from '../../src/shared/settings.ts';

const NOW = Date.UTC(2026, 8, 21, 9, 0, 0);
const DAY = 24 * 3_600_000;
const TOTAL_ROWS = 1_000_000;
const SMALL_CHATS = 100;
const SMALL_ROWS = 1_000;
const BIG_ROWS = TOTAL_ROWS - SMALL_CHATS * SMALL_ROWS;
const BIG = '972550000010@s.whatsapp.net';
const jidOf = (i: number): string => `97255000${String(1000 + i).padStart(4, '0')}@s.whatsapp.net`;

const results: Record<string, number> = {};
function time<T>(label: string, fn: () => T): T {
  const t0 = performance.now();
  const out = fn();
  results[label] = Math.round(performance.now() - t0);
  return out;
}

// ONE test: the T7 leak guard closes every DatabaseSync handle after each test, and seeding 10^6 rows twice would double the run.
describe('U-D1: the four SELECT-only reads on 10^6 rows', () => {
  it('stay inside their ceilings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wca-bench-wa-'));
    const fake: FakeBridgeDb = createFakeBridgeDb({
      path: join(dir, 'messages.db'),
      now: new Date(NOW),
      tsFormat: 'go-sqlite3',
    });
    let bridge: BridgeDb | null = null;
    let db: Db | null = null;
    try {
      // one multi-year contact (900k rows over 2 years) + 100 ordinary contacts (1k rows each over the last 60 days)
      time('seed', () => {
        fake.seedBulk({
          chatJid: BIG,
          rows: BIG_ROWS,
          startTs: NOW - 730 * DAY,
          stepMs: Math.floor((730 * DAY) / BIG_ROWS),
          fromMeEvery: 4,
        });
        for (let i = 0; i < SMALL_CHATS; i += 1) {
          fake.seedBulk({
            chatJid: jidOf(i),
            rows: SMALL_ROWS,
            startTs: NOW - 60 * DAY,
            stepMs: Math.floor((60 * DAY) / SMALL_ROWS),
            idPrefix: `S${i}_`,
          });
        }
      });
      expect(fake.maxRowid()).toBe(TOTAL_ROWS);
      bridge = createBridgeDb(fake.path);
      const b = bridge;
      db = openDb(MEMORY_DB);

      // recentDmChats: GROUP BY chat_jid, 1 call/run
      expect(time('recentDmChats(30)', () => b.recentDmChats(30))).toHaveLength(30);
      // messagesBefore: index + rowid on the 900k-row chat
      expect(time('messagesBefore(big,null,60)', () => b.messagesBefore(BIG, null, 60))).toHaveLength(60);
      time('messagesBefore(big,mid,60)', () => b.messagesBefore(BIG, 450_000, 60));
      // messageByRowid: point lookup
      expect(time('messageByRowid', () => b.messageByRowid(777_777))).not.toBeNull();
      // searchContent: a miss scans every row once
      expect(time('searchContent(all,miss)', () => b.searchContent('zzqq-no-such-text', null, 0, 40))).toEqual([]);
      expect(time('searchContent(big,miss)', () => b.searchContent('zzqq-no-such-text', BIG, 0, 40))).toEqual([]);
      expect(time('searchContent(all,hit)', () => b.searchContent('bulk row 99', null, 0, 40)).length).toBeGreaterThan(
        0,
      );
      // the facade end to end (window filter in TypeScript)
      const repos = createRepos(db);
      const chat = repos.chats.upsertFromBridge(BIG, null, true, NOW);
      const wa = createWaReadClient({
        bridgeDb: b,
        chats: repos.chats,
        transcripts: repos.transcripts,
        settings: () => DEFAULT_SETTINGS,
      });
      const q = { nowMs: NOW, windowMs: 30 * DAY };
      expect(time('facade.chatMessages(21)', () => wa.chatMessages(chat.id, null, 21, q))).toHaveLength(21);
      time('facade.search(miss)', () => wa.search('zzqq-no-such-text', chat.id, 5, q, 'trigger_chat'));

      process.stdout.write(`\n[bench:wa] ${TOTAL_ROWS} rows, ms: ${JSON.stringify(results)}\n`);
      expect(results['recentDmChats(30)']).toBeLessThan(5_000);
      expect(results['messagesBefore(big,null,60)']).toBeLessThan(1_000);
      expect(results.messageByRowid).toBeLessThan(100);
      expect(results['searchContent(all,miss)']).toBeLessThan(10_000);
      expect(results['searchContent(big,miss)']).toBeLessThan(5_000);
      expect(results['facade.chatMessages(21)']).toBeLessThan(1_000);
    } finally {
      bridge?.close();
      fake.close();
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
