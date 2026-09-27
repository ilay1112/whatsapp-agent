// Scratch proofs for ops/agent-notes/review-correctness-pipeline.md.
// Every `expect` here asserts the CURRENT (buggy) behaviour and is annotated with what the code SHOULD do.
// Nothing in src/ is touched.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeDb } from '../../../src/main/bridge/bridgeDb';
import { createIngest } from '../../../src/main/bridge/ingest';
import { createRepos, openDb } from '../../../src/main/db/index';
import { createTriageQueue } from '../../../src/main/agent/queue';
import { validateAndPersist } from '../../../src/main/agent/validate';
import { resolveExtraction } from '../../../src/main/agent/resolve';
import { localToEpochMs } from '../../../src/shared/when';
import { eventSanity } from '../../../src/main/exec/actionExecutor';
import { createFakeBridgeDb } from '../../../tests/fakes/fake-bridge-db';
import { createVirtualClock } from '../../../tests/helpers/virtualClock';
import type { Logger } from '../../../src/main/deps';
import type { Stage0Fn } from '../../../src/main/agent/stage0';
import type { ChatRef } from '../../../src/main/../shared/types';

const NOW = Date.UTC(2026, 8, 21, 9, 0, 0);
const LID = '55500001@lid';
const PHONE = '972550000001@s.whatsapp.net';

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

describe('correctness-pipeline-1: contextFor() loses every message of a LID-migrated chat', () => {
  it('returns an empty context window although the bridge holds the messages under the @lid jid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wca-scratch-lid-'));
    const path = join(dir, 'store', 'messages.db');
    const fake = createFakeBridgeDb({ path, now: new Date(NOW) });
    const bridgeDb = createBridgeDb(path);
    const db = openDb(':memory:');
    const repos = createRepos(db);
    const clock = createVirtualClock(NOW);
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

    // The bridge failed to resolve this contact, so its rows stay keyed by the @lid jid,
    // but whatsmeow_lid_map knows the phone number (exactly the "unresolved residue" case of shared/types.ts).
    fake.addChat(LID, 'Contact');
    fake.addLidMapping(LID, PHONE);
    fake.addMessage({ id: 'm1', chatJid: LID, sender: '55500001', content: 'hi, can we meet?', fromMe: false });

    const classify: Stage0Fn = () => ({ kind: 'queued' });
    const ingest = createIngest({
      bridgeDb,
      repos,
      classify,
      settings: () => repos.settings.get(),
      clock,
      log: silentLog,
      onTsFormatError: () => undefined,
      notifyChanged: () => undefined,
      bridgeOnlineOnce: () => true,
      syncing: () => false,
    });

    await ingest.scanNow();

    // ingest re-keyed the app chat to the phone jid ...
    const chat = repos.chats.byJid(PHONE);
    expect(chat).not.toBeNull();
    const item = repos.items.openForChat(chat!.id);
    expect(item).not.toBeNull(); // an item WAS created, so a triage run will follow

    // ... but the context window the run feeds to the model is EMPTY, because lastMessages() is asked for the phone jid.
    const ctx = ingest.contextFor(chat!.id as ChatRef, 12);
    expect(ctx).toHaveLength(0); // BUG: should be the one inbound message
    // proof that the message is really there, under the other jid:
    expect(bridgeDb.lastMessages(LID, 12)).toHaveLength(1);
  });
});

describe('correctness-pipeline-2: a re-enqueue during an in-flight run is deleted by queue.remove()', () => {
  it('drops the triage_queue row that ingest wrote while runChat was still running', async () => {
    const db = openDb(':memory:');
    const repos = createRepos(db);
    const clock = createVirtualClock(NOW);
    cleanups.push(() => db.close());

    const chat = repos.chats.upsertFromBridge(PHONE, 'Contact', true, NOW);
    repos.items.createOpen({
      chatId: chat.id,
      triggerMsgId: 'mA',
      triggerTs: NOW,
      analysis: 'queued',
      holdReason: null,
      now: NOW,
    });
    repos.queue.enqueue(chat.id, NOW); // message A

    let released: (() => void) | null = null;
    const gate = new Promise<void>((r) => (released = r));
    let starts = 0;

    const queue = createTriageQueue({
      repos,
      runChat: async () => {
        starts += 1;
        await gate; // the run is in flight
      },
      clock,
      log: silentLog,
    });
    queue.start();

    // the debounce elapses and the worker picks the chat up
    await clock.advance(LIMITSdebounce());
    await clock.advance(1_000);
    expect(starts).toBe(1); // the run really did start
    expect(queue.stats().running).toBe(1);
    expect(repos.queue.size()).toBe(1); // the row is still there while the run is in flight

    // message B lands mid-run: ingest re-queues the same chat (bridge/ingest.ts handleInbound)
    repos.queue.enqueue(chat.id, clock.now());
    expect(repos.queue.size()).toBe(1); // same chat => same row, due_at moved forward

    released!();
    await clock.advance(10); // let runOne finish

    // BUG: runOne removes the row unconditionally, so message B never gets its own triage run.
    expect(repos.queue.size()).toBe(0); // should be 1
    await queue.stop();
  });
});

function LIMITSdebounce(): number {
  return 20_000;
}

// ---------------------------------------------------------------------------------------------------------------
// shared harness for the ingest-level proofs below
// ---------------------------------------------------------------------------------------------------------------
function ingestHarness(opts: { online?: boolean; syncing?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wca-scratch-'));
  const path = join(dir, 'store', 'messages.db');
  const fake = createFakeBridgeDb({ path, now: new Date(NOW) });
  const bridgeDb = createBridgeDb(path);
  const db = openDb(':memory:');
  const repos = createRepos(db);
  const clock = createVirtualClock(NOW);
  const seen: Array<{ isLive: boolean; isOlderLive: boolean; text: string }> = [];
  let online = opts.online ?? true;
  let syncing = opts.syncing ?? false;
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
      seen.push({ isLive: i.isLive, isOlderLive: i.isOlderLive, text: i.message.text });
      return i.isLive ? { kind: 'queued' } : { kind: 'context_only' };
    },
    settings: () => repos.settings.get(),
    clock,
    log: silentLog,
    onTsFormatError: () => undefined,
    notifyChanged: () => undefined,
    bridgeOnlineOnce: () => online,
    syncing: () => syncing,
  });
  return {
    fake,
    repos,
    clock,
    ingest,
    seen,
    setOnline: (v: boolean) => void (online = v),
    setSyncing: (v: boolean) => void (syncing = v),
  };
}

describe('correctness-pipeline-3: the store-wipe watermark reset only fires when max < watermark', () => {
  it('silently skips every row whose rowid is below the stale watermark after a wipe', async () => {
    const h = ingestHarness();
    // three rows before the wipe
    h.fake.addChat(PHONE, 'Contact');
    for (const id of ['a1', 'a2', 'a3'])
      h.fake.addMessage({ id, chatJid: PHONE, sender: '972550000001', content: `old ${id}`, fromMe: false });
    await h.ingest.scanNow();
    expect(h.repos.meta.get('bridge_rowid_watermark')).toBe('3');

    // the bridge store is wiped externally (re-pair / user deleted the folder) and re-syncs MORE rows than before
    h.fake.wipe();
    h.fake.addChat(PHONE, 'Contact');
    for (const id of ['b1', 'b2', 'b3', 'b4', 'b5'])
      h.fake.addMessage({ id, chatJid: PHONE, sender: '972550000001', content: `new ${id}`, fromMe: false });
    expect(h.fake.maxRowid()).toBe(5); // 5 > the stale watermark 3 => the reset branch never runs

    h.seen.length = 0;
    await h.ingest.scanNow();

    const texts = h.seen.map((s) => s.text);
    // BUG: b1..b3 are never even looked at, although the app has never seen them.
    expect(texts).not.toContain('new b1');
    expect(texts).not.toContain('new b2');
    expect(texts).not.toContain('new b3');
    expect(texts).toContain('new b5');
  });
});

describe('correctness-pipeline-4: the 120 s "syncing" window swallows the weekend backlog', () => {
  it('classifies a 48 h old unseen message as context-only instead of an older_message card', async () => {
    const h = ingestHarness({ online: true, syncing: true }); // every app start arms syncingUntil (compose.ts)
    h.fake.addChat(PHONE, 'Contact');
    h.fake.addMessage({
      id: 'weekend',
      chatJid: PHONE,
      sender: '972550000001',
      content: 'can we meet on Monday?',
      fromMe: false,
      timestamp: h.fake.formatTs(new Date(NOW - 48 * 3_600_000)),
    });

    await h.ingest.scanNow();

    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]!.isLive).toBe(false); // BUG: dropped as backlog ...
    expect(h.repos.chats.byJid(PHONE)).not.toBeNull();
    expect(h.repos.items.openForChat(h.repos.chats.byJid(PHONE)!.id)).toBeNull(); // ... so no card at all

    // and the row is now behind the watermark, so the later, non-syncing scans can never reconsider it
    expect(h.repos.meta.get('bridge_rowid_watermark')).toBe('1');
  });

  it('would have produced a full triage card had the same row been scanned outside the sync window', async () => {
    const h = ingestHarness({ online: true, syncing: false });
    h.fake.addChat(PHONE, 'Contact');
    h.fake.addMessage({
      id: 'weekend',
      chatJid: PHONE,
      sender: '972550000001',
      content: 'can we meet on Monday?',
      fromMe: false,
      timestamp: h.fake.formatTs(new Date(NOW - 48 * 3_600_000)),
    });
    await h.ingest.scanNow();
    // 48 h < LIMITS.ingestMaxAgeMs (7 d), so outside the sync window this row is a FULL live trigger.
    expect(h.seen[0]!.isLive).toBe(true);
    expect(h.seen[0]!.isOlderLive).toBe(false);
    const item = h.repos.items.openForChat(h.repos.chats.byJid(PHONE)!.id);
    expect(item).not.toBeNull();
    expect(item!.analysis).toBe('queued');
  });
});

describe('correctness-pipeline-5: "answered elsewhere" leaves the drafted reply approvable', () => {
  it('keeps the pending send_reply when an event proposal is still open', async () => {
    const h = ingestHarness();
    h.fake.addChat(PHONE, 'Contact');
    // the user has written in this chat before, so it is "known"
    h.fake.addMessage({ id: 'own0', chatJid: PHONE, sender: '', content: 'hello', fromMe: true });
    h.fake.addMessage({ id: 'in1', chatJid: PHONE, sender: '972550000001', content: 'meet tuesday 17:00?', fromMe: false });
    await h.ingest.scanNow();

    const chat = h.repos.chats.byJid(PHONE)!;
    const item = h.repos.items.openForChat(chat.id)!;

    // finish the run the way validate.ts would: a draft AND a still-open event proposal
    const proposal = h.repos.proposals.insertNext({
      itemId: item.id,
      provider: 'local',
      model: 'm',
      extraction: null,
      draftText: 'Sure, Tuesday 17:00 works.',
      replyLang: 'en',
      event: null,
      freeBusy: null,
      suspicious: false,
      createdAt: NOW,
    });
    h.repos.items.update(
      item.id,
      { analysis: 'done', replyState: 'draft', eventState: 'proposed', currentProposalId: proposal.id },
      NOW,
    );
    const action = h.repos.actions.insertPending({
      itemId: item.id,
      proposalId: proposal.id,
      chatId: chat.id,
      payload: {
        v: 1,
        kind: 'send_reply',
        itemId: item.id,
        chatRef: chat.id,
        proposalVersion: proposal.version,
        text: 'Sure, Tuesday 17:00 works.',
      },
      now: NOW,
    });

    // the user answers from their phone instead
    h.clock.advance(1_000);
    h.fake.setNow(new Date(NOW + 1_000));
    h.fake.addMessage({ id: 'own1', chatJid: PHONE, sender: '', content: 'yes, see you then', fromMe: true });
    await h.ingest.scanNow();

    expect(h.repos.items.byId(item.id)!.replyState).toBe('answered_elsewhere');
    // BUG: the draft the user never needs is still PENDING and still rendered with a Send control,
    // because ingest.handleOutbound only supersedes when no event is pending.
    expect(h.repos.actions.byId(action.id)!.state).toBe('pending');
  });
});

describe('correctness-pipeline-6: S4 writes a stale item snapshot and resurrects a dismissed card', () => {
  it('clears closed_reason and inserts a fresh approvable send_reply after the user dismissed mid-run', async () => {
    const db = openDb(':memory:');
    const repos = createRepos(db);
    cleanups.push(() => db.close());
    const chat = repos.chats.upsertFromBridge(PHONE, 'Contact', true, NOW);

    // the orchestrator reads `item` BEFORE the provider call and passes that object to validateAndPersist
    const snapshot = repos.items.createOpen({
      chatId: chat.id,
      triggerMsgId: 'mA',
      triggerTs: NOW,
      analysis: 'queued',
      holdReason: null,
      now: NOW,
    });

    // while S1..S3 are awaiting the model, the user hits "Dismiss"
    repos.actions.supersedePending(snapshot.id, NOW + 1);
    repos.items.update(snapshot.id, { closedReason: 'dismissed' }, NOW + 1);
    expect(repos.items.byId(snapshot.id)!.state).toBe('ignored');

    const extraction = {
      intent: 'question' as const,
      needsReply: true,
      title: '',
      dateKind: 'none' as const,
      isoDate: '',
      weekday: 0,
      weekOffset: 0,
      daysFromToday: 0,
      time24h: '',
      timeAmbiguous: false,
      durationMin: 0,
      location: '',
      missing: [],
      suspicious: false,
    };
    const slot = resolveExtraction(extraction, {
      nowMs: NOW,
      timeZone: 'Asia/Jerusalem',
      defaultDurationMin: 60,
      ambiguousHour: 'assume' as const,
    });

    validateAndPersist(
      repos,
      {
        item: snapshot, // STALE: closedReason is still null in this object
        chat: { id: chat.id, sendable: chat.sendable, lang: null },
        extraction,
        slot,
        draftText: 'Sure, what time works for you?',
        replyLang: 'en',
        busy: null,
        provider: 'local',
        model: 'm',
        contextBadges: [],
        manipulation: false,
        now: NOW + 2,
      },
      { calendarConnected: false },
    );

    const after = repos.items.byId(snapshot.id)!;
    // BUG: the dismissed card is back, open, with a brand-new approvable reply.
    expect(after.closedReason).toBeNull();
    expect(after.closedAt).toBeNull();
    expect(after.state).toBe('needs_reply');
    expect(repos.actions.forItem(snapshot.id).filter((a) => a.state === 'pending')).toHaveLength(1);
  });
});

describe('correctness-pipeline-8: a slot inside the Asia/Jerusalem spring-forward gap is un-approvable', () => {
  const TZ = 'Asia/Jerusalem';
  it('collapses every wall time in the 02:00-02:59 gap onto one instant, so eventSanity sees 0 minutes', () => {
    // 2026-03-27 02:00 -> 03:00 local (verified against Intl above)
    const start = localToEpochMs('2026-03-27T02:00:00', TZ);
    const end = localToEpochMs('2026-03-27T02:30:00', TZ);
    expect(start).toBe(end); // both map to the transition instant
    const bad = eventSanity(
      {
        v: 1,
        kind: 'create_event',
        itemId: 1,
        chatRef: 1,
        proposalVersion: 1,
        title: 't',
        startLocal: '2026-03-27T02:00:00',
        endLocal: '2026-03-27T02:30:00',
        timeZone: TZ,
        location: '',
      },
      Date.UTC(2026, 2, 1),
    );
    // BUG: S4 happily proposes this 30-minute slot, but approve() can never execute it.
    expect(bad).toBe('EVENT_INVALID');
  });

  it('under-reports the duration of an event that starts inside the gap', () => {
    const start = localToEpochMs('2026-03-27T02:30:00', TZ); // -> 03:00 local
    const end = localToEpochMs('2026-03-27T03:30:00', TZ);
    expect((end - start) / 60_000).toBe(30); // the user asked for 60
  });
});
