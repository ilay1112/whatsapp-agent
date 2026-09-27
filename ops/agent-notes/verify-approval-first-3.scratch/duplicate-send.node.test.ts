// SCRATCH - verification of review finding approval-first-3 (skeptic pass).
// End-to-end over the REAL app DB, the REAL ingest and the REAL action executor:
//   1. an item carries BOTH a pending send_reply and a pending create_event (what validate.ts inserts),
//   2. the user answers by hand from their phone -> ingest.handleOutbound,
//   3. does the pending send_reply survive, and can it still be approved into an actual bridge send?
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeDb } from '../../../src/main/bridge/bridgeDb';
import { createIngest } from '../../../src/main/bridge/ingest';
import { createActionExecutor } from '../../../src/main/exec/actionExecutor';
import { MEMORY_DB, createRepos, openDb } from '../../../src/main/db/index';
import { DEFAULT_SETTINGS } from '../../../src/shared/settings';
import { createFakeBridgeDb } from '../../../tests/fakes/fake-bridge-db';
import { createVirtualClock } from '../../../tests/helpers/virtualClock';
import type { Logger } from '../../../src/main/deps';
import type { EpochMs, ItemId } from '../../../src/shared/types';
import type { IpcContext } from '../../../src/shared/ipc';
import type { BridgeSendRequest } from '../../../src/main/bridge/sendClient';

const NOW = Date.UTC(2026, 8, 21, 9, 0, 0) as EpochMs;
const CHAT = '972550000001@s.whatsapp.net'; // synthetic JID, never a real number
const CTX: IpcContext = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };
const silentLog: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, child: () => silentLog };

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

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'wca-verify-'));
  const path = join(dir, 'store', 'messages.db');
  const fake = createFakeBridgeDb({ path, now: new Date(NOW) });
  const bridgeDb = createBridgeDb(path);
  const db = openDb(MEMORY_DB);
  const repos = createRepos(db);
  const clock = createVirtualClock(NOW);
  const sends: BridgeSendRequest[] = [];

  const ingest = createIngest({
    bridgeDb,
    repos,
    classify: () => ({ kind: 'queued' }),
    settings: () => repos.settings.get(),
    clock,
    log: silentLog,
    onTsFormatError: () => undefined,
    notifyChanged: () => undefined,
    bridgeOnlineOnce: () => true,
    syncing: () => false,
  });

  const exec = createActionExecutor({
    repos,
    send: {
      sendText: (req) => {
        sends.push(req);
        return Promise.resolve({ ok: true });
      },
    },
    write: { createEvent: () => Promise.resolve({ ok: true, value: { eventId: 'e', htmlLink: null } }) },
    read: {
      getCurrentTime: () => Promise.reject(new Error('unused')),
      getFreeBusy: () => Promise.resolve({ ok: true, value: [] }),
      findAppEvent: () => Promise.resolve({ ok: true, value: null }),
    },
    bridgeOnline: () => true,
    calendarConnected: () => true,
    settings: () => structuredClone(DEFAULT_SETTINGS),
    now: () => clock.now() as EpochMs,
    sleep: (ms) => clock.advance(ms),
    random: () => 0.5,
    notifyChanged: () => undefined,
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
  return { repos, fake, ingest, exec, sends };
}

describe('[scratch] approval-first-3: phone reply on a card that also proposes an event', () => {
  it('leaves the send_reply approvable and a click really sends a second message', async () => {
    const r = rig();
    const chat = r.repos.chats.upsertFromBridge(CHAT, 'Contact', true, NOW);
    expect(chat.sendable).toBe(true);
    const item = r.repos.items.createOpen({
      chatId: chat.id,
      triggerMsgId: 'trigger',
      triggerTs: (NOW - 60_000) as EpochMs,
      analysis: 'done',
      holdReason: null,
      now: NOW,
    });
    const proposal = r.repos.proposals.insertNext({
      itemId: item.id,
      provider: 'user',
      model: 'test',
      extraction: null,
      draftText: 'Sure, Thursday 17:00 works',
      replyLang: 'en',
      event: null,
      freeBusy: null,
      suspicious: false,
      createdAt: NOW,
    });
    // exactly the pair validate.ts:217-244 writes for a drafted reply + a complete slot
    r.repos.items.update(
      item.id,
      { replyState: 'draft', eventState: 'proposed', currentProposalId: proposal.id },
      NOW,
    );
    const send = r.repos.actions.insertPending({
      itemId: item.id,
      proposalId: proposal.id,
      chatId: chat.id,
      payload: {
        v: 1,
        kind: 'send_reply',
        itemId: item.id,
        chatRef: chat.id,
        proposalVersion: proposal.version,
        text: 'Sure, Thursday 17:00 works',
      },
      now: NOW,
    });
    r.repos.actions.insertPending({
      itemId: item.id,
      proposalId: proposal.id,
      chatId: chat.id,
      payload: {
        v: 1,
        kind: 'create_event',
        itemId: item.id,
        chatRef: chat.id,
        proposalVersion: proposal.version,
        title: 'Meeting',
        startLocal: '2026-09-24T17:00:00',
        endLocal: '2026-09-24T18:00:00',
        timeZone: 'UTC',
        location: '',
      },
      now: NOW,
    });

    // step 2: the user answers by hand from their phone (different text -> not our own send)
    r.fake.addMessage({
      id: 'phone',
      chatJid: CHAT,
      sender: 'me',
      content: 'yes thursday is fine, see you',
      fromMe: true,
      timestamp: r.fake.formatTs(new Date(NOW)),
    });
    await r.ingest.scanNow();

    const after = r.repos.items.byId(item.id as ItemId);
    expect(after?.replyState).toBe('answered_elsewhere');
    expect(after?.closedReason).toBeNull();
    expect(after?.state).toBe('needs_reply'); // still listed on the dashboard
    const surviving = r.repos.actions.byId(send.id);
    expect(surviving?.state).toBe('pending'); // <-- NOT superseded

    // step 3: one click on Send
    const res = await r.exec.approve(
      { actionId: send.id, kind: 'send_reply', shownHash: surviving!.contentSha256 },
      CTX,
    );
    expect(res.ok).toBe(true);
    expect(r.sends).toHaveLength(1); // a SECOND, duplicate WhatsApp message went out
    expect(r.repos.actions.byId(send.id)?.state).toBe('done');
  });
});
