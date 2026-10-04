// tests/helpers/waWorld.ts - [V2] the standard WhatsApp read world every WhatsApp-tool test uses (T2 3.5). Owner V2-W1-05-wa-toolserver.
// Built over the REAL bridge-DB shape (tests/fakes/fake-bridge-db.ts, rollback journal, go-sqlite3 timestamps) and the REAL app.db
// repos (chats, transcripts). Synthetic JIDs 9725500000NN@s.whatsapp.net only (T5). Every string below is DATA for the app under test.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeBridgeDb, type FakeBridgeDb } from '../fakes/fake-bridge-db.ts';
import { createFakeMcpCalendar, type FakeMcpCalendar } from '../fakes/fake-mcp-calendar.ts';
import { createRepos, openDb, MEMORY_DB, type Db, type Repos } from '../../src/main/db/index.ts';
import { createBridgeDb, type BridgeDb } from '../../src/main/bridge/bridgeDb.ts';
import { createWaReadClient, type WaReadClient } from '../../src/main/bridge/waReadClient.ts';
import { createMcpHost, type McpHostWithChildSpec } from '../../src/main/mcp/host.ts';
import { createMcpReadClient } from '../../src/main/mcp/readClient.ts';
import { createToolGate, type RunCtx, type ToolGate } from '../../src/main/agent/toolGate.ts';
import { createHandleTable } from '../../src/main/agent/handles.ts';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/settings.ts';
import type { ChatRef, EpochMs, ItemId, RunId } from '../../src/shared/types.ts';

export interface WaWorldOptions {
  nowMs: number;
  /** days of history in the trigger chat (default 45; the 30/90-day window filter is tested against it) */
  historyDays?: number;
  /** add the audio row + transcripts row carrying SENTINEL_TRANSCRIPT (default true) */
  withVoice?: boolean;
}
export interface WaWorldChat {
  jid: string;
  chatId: ChatRef | null; // null = unknown to app.db (stranger)
}
export interface WaWorld {
  trigger: WaWorldChat; // known; 60 rows over 45 days; SENTINEL_WA_ROW_<n>; a from_me row 3 h before the trigger
  other: WaWorldChat; // known; SENTINEL_OTHER_CHAT address row + a raw JID / phone row
  group: string; // ...@g.us
  status: string; // status@broadcast
  newsletter: string; // ...@newsletter
  stranger: WaWorldChat; // unknown sender
  never: WaWorldChat; // policy 'never'
  lidTwin: { lid: string; phoneJid: string }; // merged through whatsmeow_lid_map
  sentinels: { waRows: string[]; otherChat: string; transcript: string };
  // ---- [W1-05 ADD] what the I5' regex sweep looks for (none of it may appear in any tool result) ----
  fixture: {
    names: string[]; // chats.name / display names
    msgIds: string[]; // every messages.id seeded
    filenames: string[]; // every messages.filename seeded
    jids: string[]; // every JID seeded (incl. the @lid twin)
    /** the app chat of the @lid twin (keyed by its phone JID) */
    lidChatId: ChatRef;
    /** rowids by role, for context / paging tests */
    rowids: { triggerMessage: number; fromMeRecent: number; audio: number; otherAddress: number; otherJid: number };
  };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const WA_WORLD_JIDS = {
  trigger: '972550000011@s.whatsapp.net',
  other: '972550000012@s.whatsapp.net',
  stranger: '972550000013@s.whatsapp.net',
  never: '972550000014@s.whatsapp.net',
  lidPhone: '972550000015@s.whatsapp.net',
  lid: '972550000055@lid',
  group: '972550000016-1700000000@g.us',
  status: 'status@broadcast',
  newsletter: '972550000017@newsletter',
} as const;

export const WA_WORLD_NAMES = {
  trigger: 'Dana Fixturename',
  other: 'Omer Fixturename',
  stranger: 'Stranger Fixturename',
  never: 'Never Fixturename',
  lidPhone: 'Lidtwin Fixturename',
} as const;

export function seedWaWorld(db: FakeBridgeDb, repos: Repos, opts: WaWorldOptions): WaWorld {
  const now = opts.nowMs;
  const historyDays = opts.historyDays ?? 45;
  const withVoice = opts.withVoice ?? true;
  const J = WA_WORLD_JIDS;
  const ts = (ms: number): string | number => db.formatTs(new Date(ms));
  const msgIds: string[] = [];
  const filenames: string[] = [];
  const add = (
    chatJid: string,
    id: string,
    content: string,
    atMs: number,
    fromMe = false,
    extra: { mediaType?: string; filename?: string; timestamp?: string | number } = {},
  ): number => {
    msgIds.push(id);
    if (extra.filename !== undefined) filenames.push(extra.filename);
    return db.addMessage({
      id,
      chatJid,
      sender: fromMe ? '972550000001' : (chatJid.split('@')[0] ?? '').replace(/-.*$/, ''),
      content,
      timestamp: extra.timestamp ?? ts(atMs),
      fromMe,
      mediaType: extra.mediaType ?? '',
      filename: extra.filename,
    });
  };

  // ---- app.db chats (the facade's scope / policy / known-sender filter reads these) ----
  const known = (jid: string, name: string): ChatRef => repos.chats.upsertFromBridge(jid, name, true, now).id;
  const triggerId = known(J.trigger, WA_WORLD_NAMES.trigger);
  const otherId = known(J.other, WA_WORLD_NAMES.other);
  const strangerId = repos.chats.upsertFromBridge(J.stranger, WA_WORLD_NAMES.stranger, false, now).id; // unknown sender
  const neverId = known(J.never, WA_WORLD_NAMES.never);
  repos.chats.setPolicy(neverId, 'never');
  const lidChatId = known(J.lidPhone, WA_WORLD_NAMES.lidPhone);
  for (const [jid, name] of [
    [J.trigger, WA_WORLD_NAMES.trigger],
    [J.other, WA_WORLD_NAMES.other],
    [J.stranger, WA_WORLD_NAMES.stranger],
    [J.never, WA_WORLD_NAMES.never],
    [J.lidPhone, WA_WORLD_NAMES.lidPhone],
  ] as const) {
    db.addChat(jid, name);
  }

  // ---- trigger chat: 60 rows spread over historyDays (some outside the 30-day window), mixed from_me ----
  const waRows: string[] = [];
  const oldest = now - historyDays * DAY;
  const span = now - 4 * HOUR - oldest;
  for (let i = 0; i < 60; i += 1) {
    const sentinel = `SENTINEL_WA_ROW_${i}`;
    waRows.push(sentinel);
    add(
      J.trigger,
      `WAWT${String(i).padStart(3, '0')}`,
      `${sentinel} note number ${i} about the plan`,
      oldest + Math.round((span * i) / 59),
      i % 3 === 0,
    );
  }
  const fromMeRecent = add(J.trigger, 'WAWTME01', 'I can do Wednesday afternoon', now - 3 * HOUR, true); // user participation
  // media / hidden rows of the trigger chat (filtered per B17)
  const audio = add(J.trigger, 'WAWTAUD1', '', now - 2 * HOUR, false, {
    mediaType: 'audio',
    filename: 'AUD-20260921-WA0001.opus',
  });
  add(J.trigger, 'WAWTIMG1', '', now - 110 * MIN, false, { mediaType: 'image', filename: 'IMG-20260921-WA0002.jpg' });
  add(J.trigger, 'WAWTSTK1', '', now - 100 * MIN, false, {
    mediaType: 'sticker',
    filename: 'STK-20260921-WA0003.webp',
  });
  add(J.trigger, 'WAWTDOC1', '', now - 95 * MIN, false, { mediaType: 'document', filename: 'secret-plan-fixture.pdf' });
  add(J.trigger, 'WAWTRCT1', '\u{1F44D}', now - 90 * MIN, false, { mediaType: 'reaction', filename: 'WAWTME01' });
  msgIds.push('WAWTDEL1');
  db.seedDeleted({
    id: 'WAWTDEL1',
    chatJid: J.trigger,
    sender: '972550000011',
    content: 'SENTINEL_DELETED_ROW this was deleted',
    timestamp: ts(now - 80 * MIN),
    fromMe: false,
  });
  add(J.trigger, 'WAWTGBG1', 'SENTINEL_GARBAGE_TS unparseable timestamp row', now - 70 * MIN, false, {
    timestamp: 'not-a-timestamp',
  });
  const triggerMessage = add(J.trigger, 'WAWTTRG1', 'can we move it to 5pm instead?', now - 5 * MIN);

  if (withVoice) {
    repos.transcripts.upsert({
      chatJid: J.trigger,
      waMsgId: 'WAWTAUD1',
      status: 'done',
      text: 'SENTINEL_TRANSCRIPT let us meet on Thursday',
      language: 'en',
      seconds: 4,
      modelLabel: 'fake-whisper',
      errorCode: null,
      createdAt: now - 2 * HOUR,
    });
  }

  // ---- other known chat ----
  const otherAddress = add(
    J.other,
    'WAWOADR1',
    'my address is 12 Fake St, card ends 4242 SENTINEL_OTHER_CHAT',
    now - 2 * DAY,
  );
  const otherJid = add(J.other, 'WAWOJID1', '972550000099@s.whatsapp.net call me at +972-55-000-0099', now - DAY);

  // ---- never listed / never searchable ----
  add(J.group, 'WAWGRP01', 'SENTINEL_GROUP_ROW group plan at 5pm', now - 6 * HOUR);
  add(J.status, 'WAWSTS01', 'SENTINEL_STATUS_ROW status update 5pm', now - 6 * HOUR);
  add(J.newsletter, 'WAWNWS01', 'SENTINEL_NEWSLETTER_ROW newsletter 5pm', now - 6 * HOUR);
  add(J.stranger, 'WAWSTR01', 'SENTINEL_STRANGER_ROW hello 5pm', now - 5 * HOUR);
  add(J.never, 'WAWNEV01', 'SENTINEL_NEVER_ROW private 5pm', now - 5 * HOUR);

  // ---- @lid twin: rows keyed by the @lid JID, the app chat by the phone JID, merged through whatsmeow_lid_map ----
  db.addLidMapping(J.lid, J.lidPhone);
  add(J.lid, 'WAWLID01', 'SENTINEL_LID_ROW written under the lid form', now - 7 * HOUR);
  add(J.lidPhone, 'WAWLID02', 'SENTINEL_LID_PHONE_ROW written under the phone form', now - 6 * HOUR);

  return {
    trigger: { jid: J.trigger, chatId: triggerId },
    other: { jid: J.other, chatId: otherId },
    group: J.group,
    status: J.status,
    newsletter: J.newsletter,
    stranger: { jid: J.stranger, chatId: strangerId },
    never: { jid: J.never, chatId: neverId },
    lidTwin: { lid: J.lid, phoneJid: J.lidPhone },
    sentinels: { waRows, otherChat: 'SENTINEL_OTHER_CHAT', transcript: 'SENTINEL_TRANSCRIPT' },
    fixture: {
      names: Object.values(WA_WORLD_NAMES),
      msgIds,
      filenames,
      jids: Object.values(J),
      lidChatId,
      rowids: { triggerMessage, fromMeRecent, audio, otherAddress, otherJid },
    },
  };
}

// =====================================================================================================================================
// [W1-05 ADD] createWaToolRig: the PRODUCTION read path for security / integration tests that must not use doubles (T2 3.5):
// real ToolGate -> real McpReadClient -> real McpHost caller -> fake MCP calendar (in-memory transport), and real WaReadClient ->
// real BridgeDb (read-only) -> a real messages.db seeded with the world above; audit rows land in a real app.db.
// =====================================================================================================================================

export interface WaToolRigOptions {
  nowMs?: number;
  scope?: 'trigger_chat' | 'all_chats';
  windowDays?: number;
  withVoice?: boolean;
  calendarConnected?: boolean;
  waAvailable?: boolean;
}
export interface WaToolRig {
  gate: ToolGate;
  /** every WaReadClient call the gate made (a counting wrapper around the REAL facade, never a double) */
  waCalls: string[];
  wa: WaReadClient;
  world: WaWorld;
  repos: Repos;
  db: Db;
  bridge: BridgeDb;
  fake: FakeBridgeDb;
  calendar: FakeMcpCalendar;
  host: McpHostWithChildSpec;
  logs: string[];
  settings: Settings;
  nowMs: number;
  /** a fresh RunCtx of the trigger chat (a new handle table per run) */
  ctx(over?: Partial<RunCtx>): RunCtx;
  /** calendar calls that are not READ tools (the host's own manage-accounts sign-in probe excluded) */
  nonReadCalendarCalls(): Array<{ tool: string }>;
  /** audit rows of kind tool_blocked */
  blockedAudit(): Array<Record<string, unknown>>;
  dispose(): Promise<void>;
}
export const WA_RIG_NONCE = 'a1b2c3d4e5f60789';

export async function createWaToolRig(opts: WaToolRigOptions = {}): Promise<WaToolRig> {
  const nowMs = opts.nowMs ?? Date.UTC(2026, 8, 21, 9, 0, 0);
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    general: { ...DEFAULT_SETTINGS.general, timeZone: 'Asia/Jerusalem' },
    calendar: { ...DEFAULT_SETTINGS.calendar, targetCalendarId: 'primary', conflictCalendarIds: ['primary'] },
    whatsapp: {
      ...DEFAULT_SETTINGS.whatsapp,
      readTools: { enabled: true, scope: opts.scope ?? 'trigger_chat', windowDays: opts.windowDays ?? 30 },
    },
  };
  const calendar = createFakeMcpCalendar({
    now: () => nowMs,
    timeZone: 'Asia/Jerusalem',
    accounts: 'personal_ok',
    pinned: { calendarIds: ['primary'], timeZone: 'Asia/Jerusalem' },
  });
  const transport = calendar.clientTransport();
  await calendar.connect();
  const db = openDb(MEMORY_DB);
  const repos = createRepos(db);
  const logs: string[] = [];
  const record =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      logs.push(`${level} ${msg} ${fields === undefined ? '' : JSON.stringify(fields)}`);
    };
  const host = createMcpHost({
    execPath: process.execPath,
    mcpRoot: 'C:/nonexistent/calendar-mcp',
    credentialsPath: 'C:/nonexistent/credentials.json',
    tokenPath: 'C:/nonexistent/tokens.json',
    onStderrMarker: () => undefined,
    transportFactory: () => transport,
    clock: { now: () => nowMs },
    audit: (kind, ref, detail, at) => repos.audit.append(kind, ref, detail, at),
    log: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    } as unknown as Parameters<typeof createMcpHost>[0]['log'],
  });
  await host.start();

  const dir = mkdtempSync(join(tmpdir(), 'wca-watoolrig-'));
  const fake = createFakeBridgeDb({ path: join(dir, 'messages.db'), now: new Date(nowMs) });
  const world = seedWaWorld(fake, repos, { nowMs, withVoice: opts.withVoice ?? true });
  const bridge = createBridgeDb(fake.path);
  const real = createWaReadClient({
    bridgeDb: bridge,
    chats: repos.chats,
    transcripts: repos.transcripts,
    settings: () => settings,
  });
  const waCalls: string[] = [];
  const wa: WaReadClient = {
    recentChats: (...a) => (waCalls.push('recentChats'), real.recentChats(...a)),
    chatMessages: (...a) => (waCalls.push('chatMessages'), real.chatMessages(...a)),
    search: (...a) => (waCalls.push('search'), real.search(...a)),
    context: (...a) => (waCalls.push('context'), real.context(...a)),
  };
  const gate = createToolGate({
    read: createMcpReadClient(host.callerFor('read')),
    wa,
    settings: () => settings,
    calendarConnected: () => opts.calendarConnected ?? true,
    waAvailable: () => opts.waAvailable ?? true,
    audit: (kind, ref, detail) => repos.audit.append(kind, ref, detail, nowMs as EpochMs),
  });
  let runs = 0;
  return {
    gate,
    waCalls,
    wa,
    world,
    repos,
    db,
    bridge,
    fake,
    calendar,
    host,
    logs,
    settings,
    nowMs,
    ctx: (over = {}) => {
      runs += 1;
      return {
        runId: runs as RunId,
        itemId: (900 + runs) as ItemId,
        chatId: world.trigger.chatId!,
        nowMs: nowMs as EpochMs,
        timeZone: 'Asia/Jerusalem',
        nonce: WA_RIG_NONCE,
        calls: {},
        totalCalls: 0,
        blockedCalls: 0,
        signal: new AbortController().signal,
        handles: createHandleTable(world.trigger.chatId!),
        waRowsServed: 0,
        crossChatRows: 0,
        otherChatTexts: [],
        ...over,
      };
    },
    nonReadCalendarCalls: () =>
      calendar.calls.filter(
        (c) =>
          c.tool !== 'get-current-time' &&
          c.tool !== 'get-freebusy' &&
          !(c.tool === 'manage-accounts' && (c.args as { action?: unknown }).action === 'list'),
      ),
    blockedAudit: () =>
      (
        db.prepare(`SELECT detail_json FROM audit_log WHERE kind = 'tool_blocked' ORDER BY rowid`).all() as Array<{
          detail_json: string;
        }>
      ).map((r) => JSON.parse(r.detail_json) as Record<string, unknown>),
    async dispose() {
      await host.stop();
      await calendar.stop();
      bridge.close();
      fake.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
