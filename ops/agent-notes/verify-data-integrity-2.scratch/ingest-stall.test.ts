// SCRATCH - end-to-end proof for review finding data-integrity-2 consequence (a): the ingest watermark stall.
// No product file is touched. Run:
//   npx vitest run --config ops/agent-notes/verify-data-integrity-2.scratch/vitest.scratch.config.ts
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
import type { ActionPayload } from '../../../src/shared/schemas';

const NOW = Date.UTC(2026, 8, 21, 9, 0, 0);
const PHONE = '972550000001@s.whatsapp.net';
const LID = '55500001@lid';

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
  const dir = mkdtempSync(join(tmpdir(), 'wca-di2-'));
  const path = join(dir, 'store', 'messages.db');
  const fake = createFakeBridgeDb({ path, now: new Date(NOW) });
  const bridgeDb = createBridgeDb(path);
  const db = openDb(':memory:');
  const repos = createRepos(db);
  const clock = createVirtualClock(NOW);
  const ingest = createIngest({
    bridgeDb,
    repos,
    classify: () => ({ kind: 'queued' }) as const,
    settings: () => repos.settings.get(),
    clock,
    log: silentLog,
    onTsFormatError: () => undefined,
    notifyChanged: () => undefined,
    bridgeOnlineOnce: () => true,
    syncing: () => false,
  });
  cleanups.push(() => {
    bridgeDb.close();
    fake.close();
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort on Windows */
    }
  });
  return { repos, fake, ingest, db };
}

const ts = (fake: ReturnType<typeof createFakeBridgeDb>, at: number) => fake.formatTs(new Date(at));

/** The executor's failed-then-cloned retry pair, on whatever chat the item belongs to. */
function seedFailedPlusRetryClone(repos: ReturnType<typeof createRepos>, itemId: number, chatId: number) {
  const item = repos.items.byId(itemId as never)!;
  const proposal = repos.proposals.insertNext({
    itemId: item.id,
    provider: 'local',
    model: 'm',
    extraction: null,
    draftText: null,
    replyLang: null,
    event: null,
    freeBusy: null,
    suspicious: false,
    createdAt: NOW,
  });
  const payload: ActionPayload = {
    v: 1,
    kind: 'create_event',
    itemId: item.id,
    chatRef: chatId as never,
    proposalVersion: proposal.version,
    title: 'x',
    startLocal: '2026-01-02T10:00:00',
    endLocal: '2026-01-02T11:00:00',
    timeZone: 'UTC',
    location: '',
  };
  const a1 = repos.actions.insertPending({
    itemId: item.id,
    proposalId: proposal.id,
    chatId: chatId as never,
    payload,
    now: NOW as never,
  });
  repos.actions.markApprovedExecuting(a1.id, JSON.stringify(payload), NOW as never);
  repos.actions.markFailed(a1.id, 'CAL_UNAVAILABLE', NOW as never); // executor markFailure()
  const a2 = repos.actions.insertPending({
    itemId: item.id,
    proposalId: proposal.id,
    chatId: chatId as never,
    payload,
    now: NOW as never,
    retryOf: a1.id,
  }); // executor cloneForRetry()
  return { a1, a2 };
}

describe('data-integrity-2 (a): ingest watermark stall', () => {
  it('a later scan of the @lid chat keeps the watermark where it was', async () => {
    const h = harness();
    h.fake.addMessage({
      id: 'in1',
      chatJid: LID,
      sender: '55500001',
      content: 'hello',
      fromMe: false,
      timestamp: ts(h.fake, NOW),
    });
    // the SAME contact also has a phone-JID chat row (the branch mergeLidInto's DELETE lives in)
    h.fake.addMessage({
      id: 'p1',
      chatJid: PHONE,
      sender: '972550000001',
      content: 'hi there',
      fromMe: false,
      timestamp: ts(h.fake, NOW),
    });
    await h.ingest.scanNow();
    expect(h.repos.chats.byJid(PHONE)).not.toBeNull();
    const lid = h.repos.chats.byJid(LID)!;
    expect(lid).not.toBeNull();
    const item = h.repos.items.openForChat(lid.id)!;
    expect(item).not.toBeNull();
    seedFailedPlusRetryClone(h.repos, item.id as never, lid.id as never);

    const watermarkBefore = h.repos.meta.get('bridge_rowid_watermark');

    // the mapping appears, and a NEW message arrives on the same @lid chat
    h.fake.addLidMapping(LID, PHONE);
    h.fake.addMessage({
      id: 'in2',
      chatJid: LID,
      sender: '55500001',
      content: 'second',
      fromMe: false,
      timestamp: ts(h.fake, NOW + 60_000),
    });

    let thrown: unknown = null;
    try {
      await h.ingest.scanNow();
    } catch (e) {
      thrown = e;
    }
    // eslint-disable-next-line no-console
    console.log('D scanNow threw =', thrown === null ? 'NOTHING' : String(thrown));
    // eslint-disable-next-line no-console
    console.log('D watermark before =', watermarkBefore, 'after =', h.repos.meta.get('bridge_rowid_watermark'));
    expect(thrown).toBe(null);
    expect(h.repos.meta.get('bridge_rowid_watermark')).not.toBe(watermarkBefore);
  });

  it('(b) resolveLidChats() throws SYNCHRONOUSLY, so `.catch()` is never attached', () => {
    const h = harness();
    h.fake.addMessage({
      id: 'in1',
      chatJid: LID,
      sender: '55500001',
      content: 'hello',
      fromMe: false,
      timestamp: ts(h.fake, NOW),
    });
    h.fake.addMessage({
      id: 'p1',
      chatJid: PHONE,
      sender: '972550000001',
      content: 'hi there',
      fromMe: false,
      timestamp: ts(h.fake, NOW),
    });
    // scanNow is async; drive it synchronously enough for the chat row to exist
    return h.ingest.scanNow().then(() => {
      const lid = h.repos.chats.byJid(LID)!;
      const item = h.repos.items.openForChat(lid.id)!;
      seedFailedPlusRetryClone(h.repos, item.id as never, lid.id as never);
      h.fake.addLidMapping(LID, PHONE);

      let sync: unknown = null;
      try {
        // exactly the compose.ts:887 shape
        void h.ingest.resolveLidChats().catch(() => undefined);
      } catch (e) {
        sync = e;
      }
      // eslint-disable-next-line no-console
      console.log('E sync throw past .catch() =', sync === null ? 'NOTHING' : String(sync));
      expect(sync).toBe(null);
    });
  });
});
