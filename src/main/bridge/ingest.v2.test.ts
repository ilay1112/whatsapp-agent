// src/main/bridge/ingest.v2.test.ts - owner V2-W1-07-media-voice. P2 2 / C2 12 deltas of ingest: inbound audio and image rows reach S0
// although their content is '', items.trigger_kind at creation, mediaFilename for diagnostics, contextFor() attaches Message.voice
// from a 'done' transcript and omits other audio rows, mediaWindowFor() is the raw V0 window (audio without a transcript included).
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeDb, type BridgeDb } from './bridgeDb';
import { createIngest, isWindowRow, mediaWindowFor, toMessage, triggerKindOf } from './ingest';
import { createRepos, openDb, type Repos } from '../db/index';
import { createFakeBridgeDb, type FakeBridgeDb } from '../../../tests/fakes/fake-bridge-db';
import { createVirtualClock } from '../../../tests/helpers/virtualClock';
import type { Logger } from '../deps';
import type { Stage0Input } from '../agent/stage0';
import type { ChatRef, Message } from '../../shared/types';

const NOW = Date.UTC(2026, 8, 21, 9, 0, 0);
const CHAT = '972550000021@s.whatsapp.net';
const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, child: () => silent };
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    try {
      cleanups.pop()?.();
    } catch {
      /* closed */
    }
  }
});

function harness(): {
  repos: Repos;
  fake: FakeBridgeDb;
  bridgeDb: BridgeDb;
  seen: Stage0Input[];
  ingest: ReturnType<typeof createIngest>;
} {
  const dir = mkdtempSync(join(tmpdir(), 'wca-ingest2-'));
  const path = join(dir, 'store', 'messages.db');
  const fake = createFakeBridgeDb({ path, now: new Date(NOW) });
  const bridgeDb = createBridgeDb(path);
  const db = openDb(':memory:');
  const repos = createRepos(db);
  const seen: Stage0Input[] = [];
  const ingest = createIngest({
    bridgeDb,
    repos,
    classify: (i) => {
      seen.push(i);
      return { kind: 'queued' };
    },
    settings: () => repos.settings.get(),
    clock: createVirtualClock(NOW),
    log: silent,
    onTsFormatError: () => undefined,
    notifyChanged: () => undefined,
    bridgeOnlineOnce: () => true,
    syncing: () => false,
  });
  cleanups.push(() => {
    bridgeDb.close();
    fake.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  repos.chats.upsertFromBridge(CHAT, 'Noa', true, NOW);
  return { repos, fake, bridgeDb, seen, ingest };
}
const ts = (fake: FakeBridgeDb, at: number): string | number => fake.formatTs(new Date(at));

describe('ingest v2 - media rows', () => {
  it('an inbound voice note reaches S0 as Message{text:"", mediaType:"audio"} and the item gets trigger_kind voice', async () => {
    const h = harness();
    h.fake.seedMediaRow({
      chatJid: CHAT,
      id: 'V1',
      mediaType: 'audio',
      filename: 'voice-note.ogg',
      ts: ts(h.fake, NOW - 60_000),
    });
    await h.ingest.scanNow();
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]?.message).toMatchObject({
      text: '',
      mediaType: 'audio',
      waMsgId: 'V1',
      mediaFilename: 'voice-note.ogg',
    });
    const chat = h.repos.chats.byJid(CHAT);
    expect(h.repos.items.openForChat(chat!.id)).toMatchObject({ triggerMsgId: 'V1', triggerKind: 'voice' });
  });

  it('a caption-less picture reaches S0 (trigger_kind image); a text row stays text; own text-less media never triggers', async () => {
    const h = harness();
    h.fake.seedMediaRow({ chatJid: CHAT, id: 'I1', mediaType: 'image', ts: ts(h.fake, NOW - 60_000) });
    await h.ingest.scanNow();
    const chat = h.repos.chats.byJid(CHAT)!;
    expect(h.repos.items.openForChat(chat.id)?.triggerKind).toBe('image');
    const h2 = harness();
    h2.fake.seedMediaRow({ chatJid: CHAT, id: 'ME1', mediaType: 'audio', fromMe: true, ts: ts(h2.fake, NOW - 60_000) });
    h2.fake.seedMediaRow({ chatJid: CHAT, id: 'ST1', mediaType: 'sticker', ts: ts(h2.fake, NOW - 50_000) });
    h2.fake.seedMediaRow({ chatJid: CHAT, id: 'VD1', mediaType: 'video', ts: ts(h2.fake, NOW - 40_000) });
    await h2.ingest.scanNow();
    expect(h2.seen).toEqual([]);
    const h3 = harness();
    h3.fake.addMessage({
      id: 'T1',
      chatJid: CHAT,
      sender: '972550000021',
      content: 'hi',
      fromMe: false,
      timestamp: ts(h3.fake, NOW - 60_000),
    });
    await h3.ingest.scanNow();
    expect(h3.repos.items.openForChat(h3.repos.chats.byJid(CHAT)!.id)?.triggerKind).toBe('text');
  });

  it('contextFor attaches Message.voice from a done transcript, omits other audio rows, keeps pictures', async () => {
    const h = harness();
    h.fake.addMessage({
      id: 'T1',
      chatJid: CHAT,
      sender: '972550000021',
      content: 'hello',
      fromMe: false,
      timestamp: ts(h.fake, NOW - 90_000),
    });
    for (const id of ['VD', 'VF', 'VE', 'VN'])
      h.fake.seedMediaRow({ chatJid: CHAT, id, mediaType: 'audio', ts: ts(h.fake, NOW - 80_000) });
    h.fake.seedMediaRow({ chatJid: CHAT, id: 'IMG', mediaType: 'image', ts: ts(h.fake, NOW - 70_000) });
    const base = {
      chatJid: CHAT,
      language: 'he',
      seconds: 3,
      modelLabel: 'voice-hebrew',
      errorCode: null,
      createdAt: NOW,
    };
    h.repos.transcripts.upsert({ ...base, waMsgId: 'VD', status: 'done', text: 'SENTINEL_TRANSCRIPT tomorrow' });
    h.repos.transcripts.upsert({ ...base, waMsgId: 'VF', status: 'failed', text: null, errorCode: 'VOICE_TIMEOUT' });
    h.repos.transcripts.upsert({ ...base, waMsgId: 'VE', status: 'empty', text: '' });
    const chat = h.repos.chats.byJid(CHAT)!;
    const win = h.ingest.contextFor(chat.id, 12);
    expect(win.map((m) => m.waMsgId)).toEqual(['T1', 'VD', 'IMG']);
    expect(win[1]?.voice).toEqual({ transcript: 'SENTINEL_TRANSCRIPT tomorrow', language: 'he', seconds: 3 });
    expect(win[1]?.text).toBe(''); // the transcript never becomes the row's text
    const raw = mediaWindowFor({ bridgeDb: h.bridgeDb, repos: h.repos }, chat.id, 12);
    expect(raw.map((m) => m.waMsgId)).toEqual(['T1', 'VD', 'VF', 'VE', 'VN', 'IMG']);
    expect(mediaWindowFor({ bridgeDb: h.bridgeDb, repos: h.repos }, 999 as ChatRef, 12)).toEqual([]);
  });

  it('mediaWindowFor with a missing store is empty; helpers classify rows', () => {
    const repos = { chats: { byId: () => ({ jid: CHAT }) } } as unknown as Pick<Repos, 'chats'>;
    const closed = { open: () => false } as unknown as BridgeDb;
    expect(mediaWindowFor({ bridgeDb: closed, repos }, 1 as ChatRef, 5)).toEqual([]);
    const m = (over: Partial<Message>): Message => ({
      rowid: 1,
      waMsgId: 'x',
      chatJid: CHAT,
      senderUser: '1',
      text: '',
      ts: 1,
      fromMe: false,
      mediaType: '',
      deleted: false,
      ...over,
    });
    expect(isWindowRow(m({ mediaType: 'audio' }))).toBe(true);
    expect(isWindowRow(m({ mediaType: 'video' }))).toBe(false);
    expect(isWindowRow(m({ mediaType: 'reaction', text: 'x' }))).toBe(false);
    expect(isWindowRow(m({ mediaType: 'image', deleted: true }))).toBe(false);
    expect([
      triggerKindOf(m({ mediaType: 'audio' })),
      triggerKindOf(m({ mediaType: 'image' })),
      triggerKindOf(m({ mediaType: 'video' })),
    ]).toEqual(['voice', 'image', 'text']);
    const row = {
      rowid: 1,
      id: 'a',
      chat_jid: CHAT,
      sender: '1',
      content: null,
      timestamp: null,
      is_from_me: 0,
      media_type: null,
      deleted_at: null,
    } as never;
    expect(toMessage(row).mediaFilename).toBeNull();
  });
});
