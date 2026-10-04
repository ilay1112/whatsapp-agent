// tests/helpers/ledger.execRig.ts - test support for the v2 executor (owner V2-W1-04-exec-auto, owner of ledger.ts; `<ownedFile>.<suffix>.ts`;
// outside src/, so never in coverage and never in the src import graph). ONE rig used by the unit tests and by the security files of groups 14-17 / 22:
// a REAL in-memory app DB (production repos + triggers, so every approval is proven by the database), the fake calendar v2 behind the
// REAL McpReadClient / McpWriteClient (so every call crosses the production builders and the fake's violation nets), a virtual clock,
// and small seeders for app-created events, change (delta) cards and automatic-mode policies. Synthetic data only (T5).
import { MEMORY_DB, createRepos, openDb } from '../../src/main/db/index';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import { DEFAULT_AUTO_SCOPE } from '../../src/shared/schemas';
import { localToEpochMs } from '../../src/shared/when';
import { createMcpReadClient } from '../../src/main/mcp/readClient';
import { createMcpWriteClient } from '../../src/main/mcp/writeClient';
import { createVirtualClock } from './virtualClock';
import { createFakeMcpCalendar } from '../fakes/fake-mcp-calendar';
import { createActionExecutor } from '../../src/main/exec/actionExecutor';
import { assertLedger, attachLedgerSources, ledgerSources } from './ledger';
import type { ActionExecutorHandle, ActionExecutorInput } from '../../src/main/exec/actionExecutor';
import type { Db, Repos } from '../../src/main/db/index';
import type { ApprovalAction, AutoPolicyRecord, Chat, EpochMs, Item, ItemId, Proposal } from '../../src/shared/types';
import type { ApproveReq, IpcContext } from '../../src/shared/ipc';
import type {
  AutoScope,
  CreateEventPayload,
  EventContentWithStatus,
  Extraction,
  UpdateEventPayload,
} from '../../src/shared/schemas';
import type { Settings } from '../../src/shared/settings';
import type { FakeCalendarOptions, FakeCalendarV2Scenario, FakeMcpCalendar } from '../fakes/fake-mcp-calendar';
import type { McpReadClient } from '../../src/main/mcp/readClient';
import type { McpWriteClient } from '../../src/main/mcp/writeClient';
import type { VirtualClock } from './virtualClock';

export const RIG_TZ = 'Asia/Jerusalem';
/** Monday 2026-10-05 10:00 Jerusalem - daytime (outside quiet hours), 20 days before the DST change. */
export const RIG_NOW = localToEpochMs('2026-10-05T10:00:00', RIG_TZ);
export const RIG_SNAPSHOT = 'a'.repeat(64);
export const CTX: IpcContext = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface Slot {
  startLocal: string;
  endLocal: string;
}

/** A proposal extraction a create card would carry when every AutoGate quality check passes. */
export function eligibleExtraction(over: Partial<Extraction> = {}): Extraction {
  return {
    intent: 'schedule_request',
    needsReply: true,
    title: 'Dentist',
    dateKind: 'absolute',
    isoDate: '2026-10-07',
    weekday: 0,
    weekOffset: 0,
    daysFromToday: 0,
    time24h: '15:00',
    timeAmbiguous: false,
    durationMin: 60,
    location: '',
    missing: [],
    suspicious: false,
    refersToExisting: false,
    change: 'no_change',
    changeConfidence: 'low',
    confidence: 'high',
    ...over,
  };
}

export interface RigOptions {
  calendar?: Partial<FakeCalendarOptions>;
  scenarios?: FakeCalendarV2Scenario[];
  /** executor dep overrides (fail-closed defaults are replaced by the working values below unless overridden here) */
  exec?: Partial<ActionExecutorInput>;
  editsPassed?: boolean;
  voicePassed?: boolean;
  imagesPassed?: boolean;
  role?: 'owner' | 'writer' | 'reader' | null;
  /** error / timing injection around the REAL clients (the fake still records every call that reaches it) */
  wrapRead?: (r: McpReadClient) => McpReadClient;
  wrapWrite?: (w: McpWriteClient) => McpWriteClient;
}

export interface Rig {
  db: Db;
  repos: Repos;
  clock: VirtualClock;
  cal: FakeMcpCalendar;
  read: McpReadClient;
  write: McpWriteClient;
  exec: ActionExecutorHandle;
  settings: Settings;
  notices: Array<{ kind: 'write' | 'undo' | 'policy'; autoWriteId?: string }>;
  changed: number[][];
  flags: { updateSurface: boolean; calendarConnected: boolean; snapshot: string; editsPassed: boolean };
  chat(n?: number, over?: { isKnown?: boolean }): Chat;
  /** Open item + proposal + pending create_event (the ordinary create card). */
  seedCreate(p: {
    chatN?: number;
    slot: Slot;
    title?: string;
    location?: string;
    extraction?: Partial<Extraction>;
    proposal?: Partial<Proposal>;
  }): {
    item: Item;
    action: ApprovalAction;
    payload: CreateEventPayload;
  };
  /** Clicks Approve on an action exactly like the renderer (shownHash = the row's content sha). */
  click(actionId: string, extra?: Partial<ApproveReq>, ctx?: IpcContext): ReturnType<ActionExecutorHandle['approve']>;
  /** seedCreate + click => an app-created event held by an in_calendar item. */
  createByClick(p: { chatN?: number; slot: Slot; title?: string; location?: string }): Promise<Item>;
  /** A change card on a NEW open item of the same chat whose linked source holds the event. */
  seedDelta(p: {
    source: Item;
    change: 'reschedule' | 'move' | 'cancel';
    to?: Partial<EventContentWithStatus>;
    extraction?: Partial<Extraction>;
    proposal?: Partial<Proposal>;
  }): { item: Item; action: ApprovalAction; payload: UpdateEventPayload };
  /** n click-approved creates in other chats (the B7 track record). */
  trackRecord(n?: number): Promise<void>;
  /** Inserts a live policy row (shadow / on; paused via on + pause). */
  policy(
    state: 'shadow' | 'on' | 'paused',
    scope?: Partial<AutoScope>,
    over?: Partial<AutoPolicyRecord>,
  ): AutoPolicyRecord;
  /** The event's current copy in the fake calendar. */
  stored(eventId: string): FakeMcpCalendar['storedEvents'][number] | undefined;
  updateCalls(): Array<Record<string, unknown>>;
  /** Attaches this rig's fake calendar + app DB to the T2 8.1 ledger (rules 2, 6-9 run in the security project's afterEach). */
  attachLedger(): void;
  /**
   * An in_calendar item holding an event that was SEEDED into the fake (not created through the executor) - for the foreign-event
   * variants. The event has the app tags of `tags` (default: this item as its own origin) and the given oddities; the item has
   * event_revision 1, is its own origin, and (withBaseline) a rev-1 revision row carrying the fake's etag / updated.
   */
  seedHeldEvent(p: {
    chatN?: number;
    eventId: string;
    tags?: Record<string, string> | null;
    creatorSelf?: boolean;
    organizerSelf?: boolean;
    attendees?: boolean;
    recurrence?: boolean;
    recurringEventId?: boolean;
    status?: 'confirmed' | 'cancelled';
    withBaseline?: boolean;
  }): Item;
  stop(): Promise<void>;
}

let jidCounter = 10;
let policyCounter = 0;

export async function makeExecRig(opts: RigOptions = {}): Promise<Rig> {
  const db = openDb(MEMORY_DB);
  const repos = createRepos(db);
  const clock = createVirtualClock(RIG_NOW);
  const settings: Settings = structuredClone(DEFAULT_SETTINGS);
  settings.general.language = 'en';
  settings.calendar.targetCalendarId = 'primary';
  settings.calendar.conflictCalendarIds = ['primary'];
  repos.settings.setInternal((s) => {
    s.calendar.targetCalendarId = 'primary';
    s.calendar.conflictCalendarIds = ['primary'];
  });
  if (opts.role !== null) repos.meta.set('calendar_roles_json', JSON.stringify({ primary: opts.role ?? 'owner' }));
  const cal = createFakeMcpCalendar({
    timeZone: RIG_TZ,
    now: () => clock.now(),
    ...opts.calendar,
    v2Scenarios: opts.scenarios ?? [],
  });
  await cal.connect();
  const realRead = createMcpReadClient(cal.callerFor('read') as never);
  const realWrite = createMcpWriteClient(cal.callerFor('write') as never);
  const read = opts.wrapRead?.(realRead) ?? realRead;
  const write = opts.wrapWrite?.(realWrite) ?? realWrite;
  const notices: Rig['notices'] = [];
  const changed: number[][] = [];
  const flags = {
    updateSurface: true,
    calendarConnected: true,
    snapshot: RIG_SNAPSHOT,
    editsPassed: opts.editsPassed ?? true,
  };
  const exec = createActionExecutor({
    repos,
    send: { sendText: () => Promise.resolve({ ok: true }) },
    write,
    read,
    bridgeOnline: () => true,
    calendarConnected: () => flags.calendarConnected,
    settings: () => settings,
    now: () => clock.now() as EpochMs,
    sleep: (ms) => clock.advance(ms),
    random: () => 0.5,
    notifyChanged: (ids) => void changed.push(ids),
    updateSurfaceAvailable: () => flags.updateSurface,
    snapshotSha: () => flags.snapshot,
    notifyAuto: (e) => void notices.push(e),
    featureGates: () => ({
      editsPassed: flags.editsPassed,
      voicePassed: opts.voicePassed ?? false,
      imagesPassed: opts.imagesPassed ?? false,
    }),
    ...opts.exec,
  });

  const chats = new Map<number, Chat>();
  const chatOf = (n = 1, over: { isKnown?: boolean } = {}): Chat => {
    const existing = chats.get(n);
    if (existing !== undefined) return existing;
    const jid = `9725500000${String(n).padStart(2, '0')}@s.whatsapp.net`;
    const c = repos.chats.upsertFromBridge(jid, `Contact ${n}`, over.isKnown ?? true, clock.now() as EpochMs);
    chats.set(n, c);
    return c;
  };

  const newProposal = (itemId: ItemId, over: Partial<Proposal> = {}): Proposal =>
    repos.proposals.insertNext({
      itemId,
      provider: 'local',
      model: 'test',
      extraction: eligibleExtraction(),
      draftText: 'See you then',
      replyLang: 'en',
      event: null,
      freeBusy: [],
      suspicious: false,
      createdAt: clock.now() as EpochMs,
      providerClass: 'local',
      contextFromMeRecent: true,
      blockedCalls: 0,
      crossChatRows: 0,
      triggerAuthor: 'contact',
      delta: null,
      imageRead: null,
      ...over,
    });

  const seedCreate: Rig['seedCreate'] = (p) => {
    const c = chatOf(p.chatN ?? 1);
    const now = clock.now() as EpochMs;
    const item = repos.items.createOpen({
      chatId: c.id,
      triggerMsgId: `m-${String(jidCounter++)}`,
      triggerTs: now,
      analysis: 'done',
      holdReason: null,
      now,
    });
    const proposal = newProposal(item.id, {
      extraction: eligibleExtraction(p.extraction),
      event: {
        title: p.title ?? 'Dentist',
        startLocal: p.slot.startLocal,
        endLocal: p.slot.endLocal,
        timeZone: RIG_TZ,
        location: p.location ?? '',
        assumptions: [],
        dateHint: '',
      },
      ...p.proposal,
    });
    repos.items.update(item.id, { currentProposalId: proposal.id, eventState: 'proposed', replyState: 'draft' }, now);
    const payload: CreateEventPayload = {
      v: 1,
      kind: 'create_event',
      itemId: item.id,
      chatRef: c.id,
      proposalVersion: proposal.version,
      title: p.title ?? 'Dentist',
      startLocal: p.slot.startLocal,
      endLocal: p.slot.endLocal,
      timeZone: RIG_TZ,
      location: p.location ?? '',
    };
    const action = repos.actions.insertPending({
      itemId: item.id,
      proposalId: proposal.id,
      chatId: c.id,
      payload,
      now,
    });
    return { item: repos.items.byId(item.id)!, action, payload };
  };

  const click: Rig['click'] = (actionId, extra = {}, ctx = CTX) => {
    const a = repos.actions.byId(actionId as never)!;
    return exec.approve({ actionId, kind: a.kind, shownHash: a.contentSha256, ...extra } as ApproveReq, ctx);
  };

  const createByClick: Rig['createByClick'] = async (p) => {
    const { item, action } = seedCreate(p);
    const res = await click(action.id);
    if (!res.ok || res.value.outcome !== 'done')
      throw new Error(`createByClick did not finish: ${JSON.stringify(res)}`);
    return repos.items.byId(item.id)!;
  };

  const seedDelta: Rig['seedDelta'] = (p) => {
    const src = repos.items.byId(p.source.id)!;
    const now = clock.now() as EpochMs;
    const rev = repos.eventRevisions.newestFor(src.calendarEventId!);
    const from: EventContentWithStatus = rev?.next ?? {
      title: 'Dentist',
      startLocal: '2026-10-07T15:00:00',
      endLocal: '2026-10-07T16:00:00',
      timeZone: RIG_TZ,
      location: '',
      status: 'confirmed',
    };
    const to: EventContentWithStatus =
      p.change === 'cancel' ? { ...from, status: 'cancelled', ...p.to } : { ...from, ...p.to };
    const item = repos.items.createOpen({
      chatId: src.chatId,
      triggerMsgId: `m-${String(jidCounter++)}`,
      triggerTs: now,
      analysis: 'done',
      holdReason: null,
      now,
    });
    const proposal = newProposal(item.id, {
      extraction: eligibleExtraction({
        intent: p.change === 'cancel' ? 'cancel' : 'reschedule',
        refersToExisting: true,
        change: p.change,
        changeConfidence: 'high',
        ...p.extraction,
      }),
      delta: {
        kind: p.change,
        targetEventId: src.calendarEventId!,
        sourceItemId: src.id,
        baseRevision: src.eventRevision,
        from,
        to,
        confidence: 'high',
        assumptions: [],
        problems: [],
      },
      ...p.proposal,
    });
    repos.items.update(
      item.id,
      { currentProposalId: proposal.id, eventState: 'change_proposed', replyState: 'draft', linkedItemId: src.id },
      now,
    );
    const payload: UpdateEventPayload = {
      v: 1,
      kind: 'update_event',
      itemId: item.id,
      chatRef: src.chatId,
      proposalVersion: proposal.version,
      targetEventId: src.calendarEventId!,
      targetItemId: src.id,
      baseRevision: src.eventRevision,
      change: p.change,
      from,
      to,
    };
    const action = repos.actions.insertPending({
      itemId: item.id,
      proposalId: proposal.id,
      chatId: src.chatId,
      payload,
      now,
    });
    return { item: repos.items.byId(item.id)!, action, payload };
  };

  const trackRecord: Rig['trackRecord'] = async (n = 3) => {
    for (let i = 0; i < n; i++) {
      await createByClick({
        chatN: 80 + i,
        slot: { startLocal: `2026-10-2${String(i)}T08:00:00`, endLocal: `2026-10-2${String(i)}T08:30:00` },
        title: `Track ${String(i)}`,
      });
    }
  };

  const policy: Rig['policy'] = (state, scope = {}, over = {}) => {
    const now = clock.now() as EpochMs;
    const row = repos.autoPolicies.insert({
      id: `33333333-3333-4333-8333-${String(++policyCounter).padStart(12, '0')}`,
      state: state === 'shadow' ? 'shadow' : 'on',
      enabledAt: now,
      expiresAt: (now + 30 * DAY) as EpochMs,
      shadowUntil: (state === 'shadow' ? now + DAY : now) as EpochMs,
      confirmedBy: 'native_dialog',
      confirm: {
        dialogResponse: 1,
        checkboxChecked: true,
        windowFocused: true,
        trial: state === 'shadow',
        appVersion: '2.0.0',
        electronVersion: '44.4.3',
        approvedCreates: 3,
      },
      scope: { ...DEFAULT_AUTO_SCOPE, ...scope },
      snapshotSha: RIG_SNAPSHOT,
      ...over,
    });
    if (state === 'paused') return repos.autoPolicies.setState(row.id, { state: 'paused', reason: 'user' });
    return row;
  };

  return {
    db,
    repos,
    clock,
    cal,
    read,
    write,
    exec,
    settings,
    notices,
    changed,
    flags,
    chat: chatOf,
    seedCreate,
    click,
    createByClick,
    seedDelta,
    trackRecord,
    policy,
    stored: (eventId) => cal.storedEvents.find((e) => e.eventId === eventId),
    updateCalls: () => cal.calls.filter((c) => c.tool === 'update-event').map((c) => c.args),
    attachLedger: () =>
      attachLedgerSources({
        calendar: { calls: cal.calls, violations: cal.violations, appCreated: cal.appCreated },
        db,
      }),
    seedHeldEvent: (p) => {
      const c = chatOf(p.chatN ?? 1);
      const now = clock.now() as EpochMs;
      const item = repos.items.createOpen({
        chatId: c.id,
        triggerMsgId: `m-${String(jidCounter++)}`,
        triggerTs: now,
        analysis: 'done',
        holdReason: null,
        now,
      });
      const proposal = newProposal(item.id);
      const create: CreateEventPayload = {
        v: 1,
        kind: 'create_event',
        itemId: item.id,
        chatRef: c.id,
        proposalVersion: proposal.version,
        title: 'Dentist',
        startLocal: '2026-10-07T15:00:00',
        endLocal: '2026-10-07T16:00:00',
        timeZone: RIG_TZ,
        location: '',
      };
      const action = repos.actions.insertPending({
        itemId: item.id,
        proposalId: proposal.id,
        chatId: c.id,
        payload: create,
        now,
      });
      const tags = p.tags === null ? {} : (p.tags ?? { waAgent: '1', waItem: String(item.id), waAction: action.id });
      cal.fake.events.push({
        id: p.eventId,
        calendarId: 'primary',
        summary: 'Dentist',
        start: '2026-10-07T15:00:00',
        end: '2026-10-07T16:00:00',
        timeZone: RIG_TZ,
        location: '',
        status: p.status ?? 'confirmed',
        etag: '"seeded-etag-1"',
        updated: '2026-10-04T08:00:00.000Z',
        sequence: 0,
        creatorSelf: p.creatorSelf ?? true,
        organizerSelf: p.organizerSelf ?? true,
        ...(p.attendees ? { attendees: [{ email: 'guest@example.com' }] } : {}),
        ...(p.recurrence ? { recurrence: ['RRULE:FREQ=WEEKLY'] } : {}),
        ...(p.recurringEventId ? { recurringEventId: 'parent0123456789' } : {}),
        extendedProperties: { private: tags },
      });
      repos.items.update(
        item.id,
        {
          currentProposalId: proposal.id,
          eventState: 'created',
          calendarEventId: p.eventId,
          eventStartTs: localToEpochMs('2026-10-07T15:00:00', RIG_TZ),
          eventRevision: 1,
          eventOriginItemId: item.id,
          calendarUpdated: p.withBaseline === false ? null : '2026-10-04T08:00:00.000Z',
        },
        now,
      );
      if (p.withBaseline !== false) {
        // the create action is only a FK anchor for the rev-1 row: it stays pending (no create-event call exists for it)
        repos.eventRevisions.insert({
          calendarEventId: p.eventId,
          itemId: item.id,
          revision: 1,
          kind: 'create',
          prev: null,
          next: {
            title: 'Dentist',
            startLocal: '2026-10-07T15:00:00',
            endLocal: '2026-10-07T16:00:00',
            timeZone: RIG_TZ,
            location: '',
            status: 'confirmed',
          },
          actionId: action.id,
          appliedAt: now,
          postEtag: '"seeded-etag-1"',
          postUpdated: '2026-10-04T08:00:00.000Z',
        });
      }
      repos.actions.markRejected(action.id);
      return repos.items.byId(item.id)!;
    },
    stop: async () => {
      await cal.stop().catch(() => undefined);
      db.close();
    },
  };
}

/** Wall-clock helpers for the rig's zone. */
export const at = (local: string): EpochMs => localToEpochMs(local, RIG_TZ);
export const HOURS = HOUR;
export const DAYS = DAY;

/**
 * afterEach of the security files: runs the T2 8.1 ledger over the attached rig WHILE its DB is still open, detaches it (so the global
 * ledger hook, which runs after the file's own afterEach, has nothing left to read), then stops every rig (the T7 leak guard wants
 * every DatabaseSync closed by the end of the test).
 */
export async function stopRigsChecked(rigs: Rig[]): Promise<void> {
  try {
    const sources = ledgerSources();
    if (sources !== null) assertLedger(sources);
  } finally {
    attachLedgerSources(null);
    while (rigs.length) await rigs.pop()!.stop();
  }
}
