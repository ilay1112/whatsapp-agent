// Verification of review finding correctness-pipeline-5 (skeptic pass).
// Drives the WHOLE chain on ONE real in-memory app DB: ingest (real bridgeDb over a fake store)
// -> ItemService view model (what the renderer receives) -> ActionExecutor.approve (the real approval gate)
// with a RECORDING send client. Nothing in src/ is touched; no network, no bridge exe, no real WhatsApp.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeDb } from '../../../src/main/bridge/bridgeDb';
import { createIngest } from '../../../src/main/bridge/ingest';
import { createRepos, openDb } from '../../../src/main/db/index';
import { createItemService } from '../../../src/main/agent/items';
import { createActionExecutor } from '../../../src/main/exec/actionExecutor';
import { sha256Hex } from '../../../src/main/exec/actionHash';
import { DEFAULT_SETTINGS } from '../../../src/shared/settings';
import { createFakeBridgeDb } from '../../../tests/fakes/fake-bridge-db';
import { createVirtualClock } from '../../../tests/helpers/virtualClock';
import type { Logger } from '../../../src/main/deps';
import type { EpochMs, ItemId } from '../../../src/shared/types';
import type { BridgeSendRequest } from '../../../src/main/bridge/sendClient';
import type { IpcContext } from '../../../src/shared/ipc';

const NOW = Date.UTC(2026, 8, 21, 9, 0, 0);
const PHONE = '972550000001@s.whatsapp.net'; // synthetic JID, never a real number
const CTX: IpcContext = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };

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

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'wca-cp5-'));
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
  const ingest = createIngest({
    bridgeDb,
    repos,
    classify: (i) => (i.isLive ? { kind: 'queued' } : { kind: 'context_only' }),
    settings: () => repos.settings.get(),
    clock,
    log: silentLog,
    onTsFormatError: () => undefined,
    notifyChanged: () => undefined,
    bridgeOnlineOnce: () => true,
    syncing: () => false,
  });
  const items = createItemService({
    repos,
    settings: () => repos.settings.get(),
    clock,
    log: silentLog,
    bridgeOnline: () => true,
    bridgeOutdated: () => false,
    calendarConnected: () => true,
    notifyChanged: () => undefined,
    enqueueRetriage: () => undefined,
  });
  const sends: BridgeSendRequest[] = [];
  const creates: unknown[] = [];
  const exec = createActionExecutor({
    repos,
    send: {
      async sendText(req) {
        sends.push(req);
        return { ok: true };
      },
    },
    write: {
      async createEvent(args) {
        creates.push(args);
        return { ok: true, value: { eventId: args.eventId, htmlLink: null } };
      },
    },
    read: {
      getCurrentTime: () => Promise.reject(new Error('never')),
      getFreeBusy: () => Promise.resolve({ ok: true, value: [] }),
      findAppEvent: () => Promise.resolve({ ok: true, value: null }),
    },
    bridgeOnline: () => true,
    calendarConnected: () => true,
    settings: () => structuredClone(DEFAULT_SETTINGS),
    now: () => clock.now() as EpochMs,
    sleep: async (ms) => {
      await clock.advance(ms);
    },
    random: () => 0.5,
    notifyChanged: () => undefined,
  });
  return { fake, repos, clock, ingest, items, exec, sends, creates };
}

describe('correctness-pipeline-5 end-to-end', () => {
  it('a phone answer leaves the drafted reply approvable and the app delivers a DUPLICATE reply', async () => {
    const h = rig();
    h.fake.addChat(PHONE, 'Contact');
    // the user has written in this chat before, so it is "known" and sendable
    h.fake.addMessage({ id: 'own0', chatJid: PHONE, sender: '', content: 'hello', fromMe: true });
    h.fake.addMessage({
      id: 'in1',
      chatJid: PHONE,
      sender: '972550000001',
      content: 'can we meet tuesday 17:00?',
      fromMe: false,
    });
    await h.ingest.scanNow();

    const chat = h.repos.chats.byJid(PHONE)!;
    expect(chat.sendable).toBe(true);
    const item = h.repos.items.openForChat(chat.id)!;

    // ---- finish the run exactly the way agent/validate.ts does when it has BOTH a draft and a complete slot ----
    const proposal = h.repos.proposals.insertNext({
      itemId: item.id,
      provider: 'local',
      model: 'm',
      extraction: null,
      draftText: 'Sure, Tuesday 17:00 works.',
      replyLang: 'en',
      event: {
        title: 'Coffee',
        startLocal: '2026-09-22T17:00:00',
        endLocal: '2026-09-22T18:00:00',
        timeZone: 'Asia/Jerusalem',
        location: '',
      },
      freeBusy: null,
      suspicious: false,
      createdAt: NOW as EpochMs,
    });
    h.repos.items.update(
      item.id,
      { analysis: 'done', replyState: 'draft', eventState: 'proposed', currentProposalId: proposal.id },
      NOW as EpochMs,
    );
    const sendAction = h.repos.actions.insertPending({
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
      now: NOW as EpochMs,
    });
    h.repos.actions.insertPending({
      itemId: item.id,
      proposalId: proposal.id,
      chatId: chat.id,
      payload: {
        v: 1,
        kind: 'create_event',
        itemId: item.id,
        chatRef: chat.id,
        proposalVersion: proposal.version,
        title: 'Coffee',
        startLocal: '2026-09-22T17:00:00',
        endLocal: '2026-09-22T18:00:00',
        timeZone: 'Asia/Jerusalem',
        location: '',
      },
      now: NOW as EpochMs,
    });

    // ---- the user answers from their PHONE instead (different text, so it is not our own send) ----
    await h.clock.advance(1_000);
    h.fake.setNow(new Date(NOW + 1_000));
    h.fake.addMessage({ id: 'own1', chatJid: PHONE, sender: '', content: 'yes, see you then', fromMe: true });
    await h.ingest.scanNow();

    const after = h.repos.items.byId(item.id)!;
    expect(after.replyState).toBe('answered_elsewhere');
    expect(after.closedReason).toBeNull(); // kept open because the event approval is still pending
    expect(after.state).toBe('needs_reply');

    // (1) ARCHITECTURE 4.6 step 5 says "pending send_reply superseded" — it is NOT.
    expect(h.repos.actions.byId(sendAction.id)!.state).toBe('pending');

    // (2) the card the renderer receives still carries a live, pending send_reply with no disabledReason,
    //     which is exactly what renderer pendingAction()/ItemCard turn into a Send button.
    const detail = h.items.detail(item.id as ItemId);
    expect(detail.ok).toBe(true);
    const views = detail.ok ? detail.value.actions : [];
    const sendView = views.find((v) => v.kind === 'send_reply')!;
    expect(sendView).toBeDefined();
    expect(sendView.state).toBe('pending');
    expect(sendView.disabledReason).toBeNull();
    expect(detail.ok && detail.value.draft?.text).toBe('Sure, Tuesday 17:00 works.');
    // and nothing in the view model tells the user they already answered:
    expect(detail.ok && detail.value.closedReason).toBeNull();

    // (3) the real approval gate accepts the click and the DUPLICATE reply goes out.
    const row = h.repos.actions.byId(sendAction.id)!;
    const res = await h.exec.approve(
      { actionId: row.id, kind: 'send_reply', shownHash: sha256Hex(row.canonicalJson) },
      CTX,
    );
    expect(res.ok).toBe(true);
    expect(res.ok && res.value.outcome).toBe('done');
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.message).toBe('Sure, Tuesday 17:00 works.');
    expect(h.sends[0]!.recipient).toBe(PHONE);
  });
});
