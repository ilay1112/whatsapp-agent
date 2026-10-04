// tests/golden/testDb.ts - shared fixture builder for the W1-10 pipeline tests (owner W1-10).
// A REAL in-memory app.db (node:sqlite, migrated) + the real repos, so every assertion about proposals, actions,
// supersession and item state is made against the shipped schema and triggers - no repo doubles anywhere.
// Nothing here can send a message or write to a calendar: the only calendar client is a recording READ double.
import { createRepos, openDb, MEMORY_DB, type Db, type Repos } from '../../src/main/db/index.ts';
import { createToolGate, type ToolGate } from '../../src/main/agent/toolGate.ts';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/settings.ts';
import type { Logger, LogMeta } from '../../src/main/deps.ts';
import type { BusyBlock, Chat, EpochMs, Item, Message } from '../../src/shared/types.ts';
import { localToEpochMs } from '../../src/shared/when.ts';
import type {
  AppEventRef,
  CurrentTimeProjection,
  McpReadClient,
  McpResult,
  PinnedWindow,
} from '../../src/main/mcp/readClient.ts';

export const TEST_TZ = 'Asia/Jerusalem';
/** 2026-09-21T10:00 Asia/Jerusalem - the anchor every PIPELINE section 11 row uses (a Monday). */
export const ANCHOR_MS: EpochMs = Date.parse('2026-09-21T07:00:00.000Z');

export interface LogLine {
  level: 'info' | 'warn' | 'error';
  event: string;
  meta: LogMeta | undefined;
}
export interface CapturingLogger extends Logger {
  lines: LogLine[];
}
export function createCapturingLogger(): CapturingLogger {
  const lines: LogLine[] = [];
  const make = (): CapturingLogger => ({
    lines,
    info: (event, meta) => void lines.push({ level: 'info', event, meta }),
    warn: (event, meta) => void lines.push({ level: 'warn', event, meta }),
    error: (event, meta) => void lines.push({ level: 'error', event, meta }),
    child: () => make(),
  });
  return make();
}

export interface RecordingReadClient extends McpReadClient {
  /** Every window the gate/prefetch handed to the calendar - proves the args are app-built. */
  readonly freeBusyCalls: PinnedWindow[];
  readonly currentTimeCalls: number;
  setBusy(blocks: BusyBlock[]): void;
  /** Makes the next getFreeBusy answer `{ok:false, error}`. */
  failNext(error: 'unavailable' | 'timeout'): void;
}
/** A READ-only calendar double. It has no write method at all, so a bug cannot reach a calendar from these tests. */
export function createRecordingReadClient(initialBusy: BusyBlock[] = []): RecordingReadClient {
  const freeBusyCalls: PinnedWindow[] = [];
  let busy = [...initialBusy];
  let currentTimeCalls = 0;
  let failure: 'unavailable' | 'timeout' | null = null;
  return {
    get freeBusyCalls() {
      return freeBusyCalls;
    },
    get currentTimeCalls() {
      return currentTimeCalls;
    },
    setBusy(blocks) {
      busy = [...blocks];
    },
    failNext(error) {
      failure = error;
    },
    getCurrentTime(): Promise<McpResult<CurrentTimeProjection>> {
      currentTimeCalls += 1;
      return Promise.resolve({ ok: true, value: { nowIso: new Date(ANCHOR_MS).toISOString(), timeZone: TEST_TZ } });
    },
    getFreeBusy(w: PinnedWindow): Promise<McpResult<BusyBlock[]>> {
      freeBusyCalls.push(w);
      if (failure !== null) {
        const error = failure;
        failure = null;
        return Promise.resolve({ ok: false, error });
      }
      // Only blocks that actually intersect the pinned window come back, exactly as a real free/busy query would answer.
      return Promise.resolve({
        ok: true,
        value: busy.filter((b) => b.startLocal < w.timeMaxLocal && b.endLocal > w.timeMinLocal),
      });
    },
    findAppEvent(): Promise<McpResult<AppEventRef | null>> {
      return Promise.resolve({ ok: true, value: null });
    },
    getEvent: () => Promise.resolve({ ok: false as const, error: 'unavailable' as const }), // [V2] C2 11 (unused by v1)
  };
}

export interface AuditCall {
  kind: 'tool_blocked';
  ref: string;
  detail: Record<string, string | number | boolean | null>;
}

export interface TestEnv {
  db: Db;
  repos: Repos;
  log: CapturingLogger;
  read: RecordingReadClient;
  gate: ToolGate;
  audits: AuditCall[];
  settings: Settings;
  /** Mutates the settings object the injected `settings()` closure returns. */
  patchSettings(mut: (s: Settings) => void): void;
  calendarConnected: boolean;
  setCalendarConnected(v: boolean): void;
  dispose(): void;
}

export interface TestEnvOptions {
  busy?: BusyBlock[];
  calendarConnected?: boolean;
  settings?: (s: Settings) => void;
}

export function createTestEnv(opts: TestEnvOptions = {}): TestEnv {
  const db = openDb(MEMORY_DB);
  const repos = createRepos(db);
  const log = createCapturingLogger();
  const read = createRecordingReadClient(opts.busy ?? []);
  const audits: AuditCall[] = [];
  const settings: Settings = structuredClone(DEFAULT_SETTINGS);
  settings.general.timeZone = TEST_TZ;
  opts.settings?.(settings);
  let calendarConnected = opts.calendarConnected ?? true;

  const env: TestEnv = {
    db,
    repos,
    log,
    read,
    audits,
    settings,
    gate: createToolGate({
      read,
      settings: () => settings,
      calendarConnected: () => calendarConnected,
      audit: (kind, ref, detail) => void audits.push({ kind, ref, detail }),
      wa: { recentChats: () => [], chatMessages: () => [], search: () => [], context: () => null }, // [V2] C2 10
      waAvailable: () => false, // [V2]
    }),
    patchSettings(mut) {
      mut(settings);
    },
    get calendarConnected() {
      return calendarConnected;
    },
    setCalendarConnected(v) {
      calendarConnected = v;
    },
    dispose() {
      db.close();
    },
  };
  return env;
}

/** Creates a chat row straight through the repo (the ingest path, minus the bridge). */
export function seedChat(
  repos: Repos,
  opts: { jid?: string; name?: string | null; isKnown?: boolean; now?: EpochMs } = {},
): Chat {
  return repos.chats.upsertFromBridge(
    opts.jid ?? '972550000001@s.whatsapp.net',
    'name' in opts ? opts.name! : 'Test Contact',
    opts.isKnown ?? true,
    opts.now ?? ANCHOR_MS,
  );
}

/** Creates the open, queued item a triage run consumes. */
export function seedOpenItem(
  repos: Repos,
  chat: Chat,
  opts: { triggerTs?: EpochMs; triggerMsgId?: string } = {},
): Item {
  return repos.items.createOpen({
    chatId: chat.id,
    triggerMsgId: opts.triggerMsgId ?? 'wamid.TRIGGER',
    triggerTs: opts.triggerTs ?? ANCHOR_MS,
    analysis: 'queued',
    holdReason: null,
    now: opts.triggerTs ?? ANCHOR_MS,
  });
}

/** Builds the `Message` rows the Ingest double hands to the orchestrator (oldest first). */
export function messagesFrom(chatJid: string, rows: Array<{ fromMe: boolean; text: string; ts: EpochMs }>): Message[] {
  return rows.map((r, i) => ({
    rowid: i + 1,
    waMsgId: `wamid.T${i + 1}`,
    chatJid,
    senderUser: r.fromMe ? 'me' : chatJid.slice(0, chatJid.indexOf('@')),
    text: r.text,
    ts: r.ts,
    fromMe: r.fromMe,
    mediaType: '',
    deleted: false,
  }));
}

/** The `Pick<Ingest,'contextFor'>` the orchestrator takes: a fixed window, recorded so tests can assert I5 (one chat). */
export function createIngestDouble(messages: Message[]): {
  contextFor: (chatId: number, n: number) => Message[];
  chats: number[];
} {
  const chats: number[] = [];
  return {
    chats,
    contextFor: (chatId, n) => {
      chats.push(chatId);
      return messages.slice(-Math.max(1, Math.trunc(n)));
    },
  };
}

// ======================= [V2-W1-03] the existing-event fixture (P2 15.2 harness: "seeds an in_calendar item with a done create_event") =======================

export interface SeededEvent {
  item: Item;
  eventId: string;
  actionId: string;
}
let seededEvents = 0;
/**
 * An app-created event of `chat`: an `in_calendar` item whose `create_event` action went `pending -> approved('user') -> executing -> done`
 * through the REAL repos (so the v4 triggers check every step), with `calendar_event_id`, `event_start_ts`, `event_revision = 1` and
 * `event_origin_item_id` = itself. The event id is in Google's base32hex alphabet (GOOGLE_EVENT_ID_RE) - P2 15.2's `exist<n>` is not
 * (`x` is outside a-v), so the fixture uses `evtsrc<n>`.
 */
export function seedCalendarEvent(
  repos: Repos,
  chat: Chat,
  ev: { title: string; startLocal: string; endLocal: string; location?: string; eventId?: string; createdAt?: EpochMs },
): SeededEvent {
  seededEvents += 1;
  const at = ev.createdAt ?? ((ANCHOR_MS - 2 * 86_400_000 + seededEvents * 1_000) as EpochMs);
  const eventId = ev.eventId ?? `evtsrc${String(seededEvents).padStart(4, '0')}`;
  const startLocal = ev.startLocal.length === 16 ? `${ev.startLocal}:00` : ev.startLocal;
  const endLocal = ev.endLocal.length === 16 ? `${ev.endLocal}:00` : ev.endLocal;
  const created = repos.items.createOpen({
    chatId: chat.id,
    triggerMsgId: `wamid.SRC${seededEvents}`,
    triggerTs: at,
    analysis: 'running',
    holdReason: null,
    now: at,
  });
  const event = {
    title: ev.title,
    startLocal,
    endLocal,
    timeZone: TEST_TZ,
    location: ev.location ?? '',
    assumptions: [],
    dateHint: '',
  };
  const proposal = repos.proposals.insertNext({
    itemId: created.id,
    provider: 'local',
    model: 'seed',
    extraction: null,
    draftText: null,
    replyLang: null,
    event,
    freeBusy: null,
    suspicious: false,
    createdAt: at,
  });
  const action = repos.actions.insertPending({
    itemId: created.id,
    proposalId: proposal.id,
    chatId: chat.id,
    payload: {
      v: 1,
      kind: 'create_event',
      itemId: created.id,
      chatRef: chat.id,
      proposalVersion: proposal.version,
      title: ev.title,
      startLocal,
      endLocal,
      timeZone: TEST_TZ,
      location: ev.location ?? '',
    },
    now: at,
  });
  if (repos.actions.markApprovedExecuting(action.id, action.canonicalJson, at, 'user') !== 'ok')
    throw new Error('seedCalendarEvent: approve refused');
  repos.actions.markDone(action.id, { kind: 'create_event', eventId, htmlLink: null }, at);
  const item = repos.items.update(
    created.id,
    {
      analysis: 'done',
      eventState: 'created',
      calendarEventId: eventId,
      eventStartTs: localToEpochMs(startLocal, TEST_TZ),
      eventRevision: 1,
      eventOriginItemId: created.id,
      currentProposalId: proposal.id,
    },
    at,
  );
  return { item, eventId, actionId: action.id };
}
