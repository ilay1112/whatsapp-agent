// Verification scratch for review finding correctness-pipeline-1 (skeptic pass). Touches nothing in src/.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeDb } from '../../../src/main/bridge/bridgeDb';
import { createIngest } from '../../../src/main/bridge/ingest';
import { createRepos, openDb } from '../../../src/main/db/index';
import { createStage0 } from '../../../src/main/agent/stage0';
import { createFakeBridgeDb } from '../../../tests/fakes/fake-bridge-db';
import { createVirtualClock } from '../../../tests/helpers/virtualClock';
import type { Logger } from '../../../src/main/deps';
import type { ChatRef } from '../../../src/shared/types';

const NOW = Date.UTC(2026, 8, 21, 9, 0, 0);
const LID = '55500001@lid';
const PHONE = '972550000001@s.whatsapp.net';
const silentLog: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, child: () => silentLog };
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) { try { cleanups.pop()?.(); } catch { /* */ } } });

describe('verify correctness-pipeline-1', () => {
  it('real Stage0 queues the item, yet contextFor() sees nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wca-verify-lid-'));
    const path = join(dir, 'store', 'messages.db');
    const fake = createFakeBridgeDb({ path, now: new Date(NOW) });
    const bridgeDb = createBridgeDb(path);
    const db = openDb(':memory:');
    const repos = createRepos(db);
    const clock = createVirtualClock(NOW);
    cleanups.push(() => { bridgeDb.close(); fake.close(); db.close(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

    // unresolved-LID residue: rows keyed by @lid, mapping known to whatsmeow_lid_map
    fake.addChat(LID, 'Contact');
    fake.addLidMapping(LID, PHONE);
    fake.addMessage({ id: 'out1', chatJid: LID, sender: 'me', content: 'sure, when?', fromMe: true });
    fake.addMessage({ id: 'in1', chatJid: LID, sender: '55500001', content: 'can we meet tomorrow at 5?', fromMe: false });

    const classify = createStage0({
      repos,
      settings: () => repos.settings.get(),
      providerUsable: () => ({ ok: true }),
      paused: () => false,
      budgets: { llmRunsPerChatPerHour: 6, llmRunsGlobalPerHour: 60, cloudDailyTokenBudget: () => 1_000_000 },
      now: () => clock.now(),
    });
    const ingest = createIngest({
      bridgeDb, repos, classify,
      settings: () => repos.settings.get(),
      clock, log: silentLog,
      onTsFormatError: () => undefined,
      notifyChanged: () => undefined,
      bridgeOnlineOnce: () => true,
      syncing: () => false,
    });

    await ingest.scanNow();

    const lidChat = repos.chats.byJid(LID);
    const chat = repos.chats.byJid(PHONE);
    console.log('lid chat row:', lidChat === null ? 'gone' : 'present', '| phone chat:', chat?.jid, '| isKnown', chat?.isKnown);
    expect(chat).not.toBeNull();
    const item = repos.items.openForChat(chat!.id);
    console.log('item:', item === null ? 'none' : { analysis: item.analysis, hold: item.holdReason });
    expect(item).not.toBeNull();
    expect(item!.analysis).toBe('queued');        // real Stage0 -> a real LLM run WILL happen
    console.log('queue size:', repos.queue.size());
    expect(repos.queue.size()).toBe(1);

    const ctx = ingest.contextFor(chat!.id as ChatRef, 12);
    console.log('contextFor length:', ctx.length, '| lastMessages(LID):', bridgeDb.lastMessages(LID, 12).length);
    expect(ctx).toHaveLength(0);                   // the run gets an EMPTY window
    expect(bridgeDb.lastMessages(LID, 12)).toHaveLength(2);
    // and reconcile would look under the phone jid too:
    console.log('outboundAfter(PHONE):', bridgeDb.outboundAfter(PHONE, 0, 200).length, '| outboundAfter(LID):', bridgeDb.outboundAfter(LID, 0, 200).length);
  });
});
