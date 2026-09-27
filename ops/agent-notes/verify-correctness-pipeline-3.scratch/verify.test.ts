// Refutation scratch for review finding correctness-pipeline-3 (store-wipe watermark reset).
// Nothing in src/ or tests/ is touched; this file only asserts CURRENT behaviour of the shipped code.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeDb } from '../../../src/main/bridge/bridgeDb';
import { createIngest } from '../../../src/main/bridge/ingest';
import { createRepos, openDb } from '../../../src/main/db/index';
import { createFakeBridgeDb } from '../../../tests/fakes/fake-bridge-db';
import { createVirtualClock } from '../../../tests/helpers/virtualClock';
import type { Logger } from '../../../src/main/deps';

const NOW = Date.UTC(2026, 8, 21, 9, 0, 0);
const PHONE = '972550000001@s.whatsapp.net';
const OTHER = '972550000002@s.whatsapp.net';

const silentLog: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLog,
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    try {
      cleanups.pop()?.();
    } catch {
      /* already closed */
    }
  }
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'wca-verify-cp3-'));
  const path = join(dir, 'store', 'messages.db');
  const fake = createFakeBridgeDb({ path, now: new Date(NOW) });
  const bridgeDb = createBridgeDb(path);
  const db = openDb(':memory:');
  const repos = createRepos(db);
  const clock = createVirtualClock(NOW);
  const seen: Array<{ isLive: boolean; text: string }> = [];
  cleanups.push(() => {
    bridgeDb.close();
    fake.close();
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows */
    }
  });
  const ingest = createIngest({
    bridgeDb,
    repos,
    classify: (i) => {
      seen.push({ isLive: i.isLive, text: i.message.text });
      return i.isLive ? { kind: 'queued' } : { kind: 'context_only' };
    },
    settings: () => repos.settings.get(),
    clock,
    log: silentLog,
    onTsFormatError: () => undefined,
    notifyChanged: () => undefined,
    bridgeOnlineOnce: () => true,
    syncing: () => false,
  });
  return { fake, repos, clock, ingest, seen, bridgeDb };
}

describe('cp3 refutation A: a scan on the freshly recreated (still empty) store resets the watermark', () => {
  it('scans every row of the bigger re-sync once the empty-store scan has fired', async () => {
    const h = harness();
    h.fake.addChat(PHONE, 'Contact');
    for (const id of ['a1', 'a2', 'a3'])
      h.fake.addMessage({ id, chatJid: PHONE, sender: '972550000001', content: `old ${id}`, fromMe: false });
    await h.ingest.scanNow();
    expect(h.repos.meta.get('bridge_rowid_watermark')).toBe('3');

    // external wipe; the bridge recreates store/messages.db at startup (vendor main.go:2426 NewMessageStore()
    // runs BEFORE client.Connect()), so the store exists and is EMPTY while the QR is on screen.
    h.fake.wipe();
    expect(h.fake.maxRowid()).toBe(0);

    // compose.ts pokes ingest on bridge ONLINE (:888), on every doorbell ring (:428), on the
    // history_sync_done marker (:478) and every LIMITS.scanIntervalMs = 30 s (:1245).
    // Any one of those scans observes max(0) < watermark(3) => the reset at ingest.ts:322 fires.
    await h.ingest.scanNow();
    expect(h.repos.meta.get('bridge_rowid_watermark')).toBe('0');

    // only now does the history sync land, with MORE rows than before.
    // OTHER is a second chat whose ONLY row sits at rowid 1 - i.e. below the stale watermark 3.
    // This is the case the finding needs: a chat that would get no card at all if the rows were skipped.
    h.fake.addChat(OTHER, 'Other');
    h.fake.addMessage({ id: 'b1', chatJid: OTHER, sender: '972550000002', content: 'new b1', fromMe: false });
    h.fake.addChat(PHONE, 'Contact');
    for (const id of ['b2', 'b3', 'b4', 'b5'])
      h.fake.addMessage({ id, chatJid: PHONE, sender: '972550000001', content: `new ${id}`, fromMe: false });
    h.seen.length = 0;
    const stats = await h.ingest.scanNow();

    expect(stats.scanned).toBe(5); // all five rows re-read, none skipped
    // ingest classifies only the NEWEST trigger-eligible row of each chat (ingest.ts:277-282),
    // so the observable proof is one card per chat - including the chat whose only row is rowid 1.
    expect(h.seen.map((s) => s.text).sort()).toEqual(['new b1', 'new b5']);
    expect(h.repos.items.openForChat(h.repos.chats.byJid(OTHER)!.id)).not.toBeNull();
  });
});

describe('cp3 refutation B: the rows below a stale watermark are pre-pairing history, which the backlog gate drops anyway', () => {
  it('classifies them context-only even when they ARE scanned, so no card is lost', async () => {
    const h = harness();
    // compose.ts:896-899 recomputes live_from_ts = pairedAt - backlogHours (default 0) on EVERY QR pairing,
    // and an external store wipe always forces a new QR pairing (store\whatsapp.db is gone too).
    const pairedAt = NOW;
    h.repos.meta.set('paired_at', String(pairedAt));
    h.repos.meta.set('live_from_ts', String(pairedAt));

    h.fake.addChat(PHONE, 'Contact');
    for (const id of ['b1', 'b2', 'b3'])
      h.fake.addMessage({
        id,
        chatJid: PHONE,
        sender: '972550000001',
        content: `history ${id}`,
        fromMe: false,
        timestamp: h.fake.formatTs(new Date(pairedAt - 3 * 3_600_000)), // history sync: pre-pairing timestamps
      });

    await h.ingest.scanNow();
    expect(h.seen.map((s) => s.isLive)).not.toContain(true);
    expect(h.repos.items.openForChat(h.repos.chats.byJid(PHONE)!.id)).toBeNull();
    expect(h.repos.queue.size()).toBe(0);
  });
});
