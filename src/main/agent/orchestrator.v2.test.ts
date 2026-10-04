// src/main/agent/orchestrator.v2.test.ts - P2 1 / 2 / 3.4 / 9.6 order of a v2 run (owner V2-W1-03-edit-pipeline).
// Real in-memory app.db + real repos + the real ToolGate; the v2 collaborators (V0 voice, V1 picture, S5a tryAuto) are injected doubles
// with exactly the frozen seam shapes, so this file proves the ORCHESTRATION: order, hand-offs, fail-closed defaults, the self trigger.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createOrchestrator,
  draftDeltaOf,
  imageWhenOf,
  isAppSend,
  isUsableTrigger,
  rowText,
  selfTriggerRow,
  triggerKindOfRun,
  triggerRowsOf,
  type AutoOutcome,
  type OrchestratorDepsIn,
} from './orchestrator';
import { buildSystemPrompt } from './prompt';
import { findExistingEvent, type ExistingEventCtx } from './existingEvent';
import type { ReadImageOutcome } from './readImage';
import type { NormalizedImage } from '../media/normalizeImage';
import {
  LlmError,
  type AgenticRunInput,
  type AgenticRunResult,
  type CallOpts,
  type LlmMessage,
  type LlmProvider,
  type ProviderFactory,
} from '../llm/types';
import type { ActionId, ChatRef, CliSandboxProof, EpochMs, Item, Message, ProviderId } from '../../shared/types';
import type { Extraction, ImageRead } from '../../shared/schemas';
import { StubLlm, type StubRule } from '../../../tests/fakes/stub-llm';
import { createSeededRandom, createVirtualClock, type VirtualClock } from '../../../tests/helpers/virtualClock';
import {
  ANCHOR_MS,
  TEST_TZ,
  createIngestDouble,
  createTestEnv,
  seedCalendarEvent,
  seedChat,
  type SeededEvent,
  type TestEnv,
} from '../../../tests/golden/testDb';

const JID = '972550000001@s.whatsapp.net';
const X: Extraction = {
  intent: 'reschedule',
  needsReply: true,
  title: 'meeting',
  dateKind: 'none',
  isoDate: '',
  weekday: 0,
  weekOffset: 0,
  daysFromToday: 0,
  time24h: '17:00',
  timeAmbiguous: false,
  durationMin: 0,
  location: '',
  missing: [],
  suspicious: false,
  refersToExisting: true,
  change: 'reschedule',
  changeConfidence: 'high',
  confidence: 'high',
};
const rules = (x: Partial<Extraction> = {}, draft = 'sure, 5 works'): StubRule[] => [
  { when: { purpose: 'extract' }, respond: { structured: { ...X, ...x } } },
  { when: { purpose: 'draft' }, respond: { text: draft } },
];

function msg(i: number, over: Partial<Message> & { text: string }): Message {
  return {
    rowid: i,
    waMsgId: `wamid.M${i}`,
    chatJid: JID,
    senderUser: over.fromMe === true ? 'me' : '972550000001',
    ts: ANCHOR_MS - (10 - i) * 60_000,
    fromMe: false,
    mediaType: '',
    deleted: false,
    ...over,
  };
}
const READ: ImageRead = {
  readable: true,
  kind: 'flyer',
  readText: 'Jazz night\nThursday 24.9\n20:00',
  language: 'en',
  title: 'Jazz night',
  dateText: 'Thursday 24.9',
  day: 24,
  month: 9,
  year: 0,
  weekday: 4,
  timeText: '20:00',
  hour: 20,
  minute: 0,
  timeAmbiguous: false,
  endHour: 24,
  endMinute: 0,
  location: '',
  confidence: 'high',
  suspicious: false,
};
const IMAGE: NormalizedImage = {
  jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  width: 10,
  height: 10,
  sha256: 'a'.repeat(64),
  thumbDataUrl: 'data:image/jpeg;base64,AA==',
  sourceMime: 'image/png',
};

let env: TestEnv;
let clock: VirtualClock;
let chatId: ChatRef;
let seeded: SeededEvent;
let item: Item;
let events: string[];
let tryAutoIds: ActionId[];

beforeEach(() => {
  env = createTestEnv({ calendarConnected: true });
  clock = createVirtualClock(ANCHOR_MS);
  const chat = seedChat(env.repos, { jid: JID });
  chatId = chat.id;
  seeded = seedCalendarEvent(env.repos, chat, {
    title: 'meeting',
    startLocal: '2026-09-23T15:00',
    endLocal: '2026-09-23T16:00',
  });
  events = [];
  tryAutoIds = [];
});
afterEach(() => env.dispose());

function openItem(trigger: Message): Item {
  item = env.repos.items.createOpen({
    chatId,
    triggerMsgId: trigger.waMsgId,
    triggerTs: trigger.ts!,
    analysis: 'queued',
    holdReason: null,
    now: trigger.ts!,
  });
  return item;
}

function build(
  window: Message[],
  llm: LlmProvider,
  over: Partial<OrchestratorDepsIn> = {},
): ReturnType<typeof createOrchestrator> {
  const providers: ProviderFactory = {
    get: () => Promise.resolve(llm),
    usable: () => ({ ok: true }),
    invalidate: () => Promise.resolve(),
  };
  return createOrchestrator({
    repos: env.repos,
    providers,
    gate: env.gate,
    ingest: createIngestDouble(window),
    settings: () => env.settings,
    clock,
    random: createSeededRandom(),
    log: env.log,
    notifyChanged: () => void events.push('notify'),
    updateSurfaceAvailable: () => true,
    tryAuto: (id): Promise<AutoOutcome> => {
      tryAutoIds.push(id);
      events.push('tryAuto');
      return Promise.resolve({ verdict: 'none', reason: 'no_policy' });
    },
    ...over,
  });
}
const stub = (r: StubRule[] = rules(), id: ProviderId = 'local'): StubLlm => new StubLlm({ rules: r, id, clock });
const run = (o: ReturnType<typeof createOrchestrator>, signal = new AbortController().signal): Promise<void> =>
  o.runChat(chatId, signal);
const pending = (): string[] =>
  env.repos.actions
    .forItem(item.id)
    .filter((a) => a.state === 'pending')
    .map((a) => a.kind)
    .sort();
const stages = (): string[] =>
  env.db
    .prepare<{ stage: string }>('SELECT stage FROM runs WHERE item_id = ? ORDER BY id')
    .all(item.id)
    .map((r) => r.stage);
const userText = (m: LlmMessage[]): string =>
  m
    .filter((x) => x.role === 'user')
    .map((x) =>
      typeof x.content === 'string' ? x.content : x.content.map((p) => (p.type === 'text' ? p.text : '')).join(''),
    )
    .join('\n');

// =====================================================================================================================
describe('a delta run (B20, P2 7 / 9)', () => {
  const window = (): Message[] => [
    msg(1, { text: 'hey', fromMe: true }),
    msg(2, { text: 'can we do 5 instead of 3?' }),
  ];

  it('proposes update_event + send_reply, hands the calendar action to tryAuto BEFORE dashboard:changed, and never leaks ids', async () => {
    const w = window();
    openItem(w[1]!);
    const llm = stub();
    await run(build(w, llm));
    expect(pending()).toEqual(['send_reply', 'update_event']);
    const upd = env.repos.actions.forItem(item.id).find((a) => a.kind === 'update_event')!;
    expect(tryAutoIds).toEqual([upd.id]);
    expect(events.lastIndexOf('tryAuto')).toBeLessThan(events.lastIndexOf('notify'));
    const fresh = env.repos.items.byId(item.id)!;
    expect(fresh.linkedItemId).toBe(seeded.item.id);
    expect(fresh.eventState).toBe('change_proposed');
    // S1: the v2 prompt bytes + the existing event INSIDE the block; S3: the delta view
    const [s1, s3] = llm.calls;
    const facts = {
      nowIso: new Date(ANCHOR_MS - 8 * 60_000).toISOString(),
      tz: TEST_TZ,
      userGender: 'unspecified' as const,
    };
    expect((s1!.messages[0] as { content: unknown }).content).toBe(
      buildSystemPrompt({
        stage: 'extract',
        ...facts,
        replyLang: 'en',
        nonce: userText(s1!.messages).match(/<<DATA-([0-9a-f]+)>>/)![1]!,
      }),
    );
    expect(userText(s1!.messages)).toContain('existing event: yes (see app_context)');
    expect(userText(s1!.messages)).toContain('"existing_event":{"title":"meeting","date":"2026-09-23"');
    expect(userText(s3!.messages)).toContain('"delta":{"change":"reschedule"');
    const sent = JSON.stringify(llm.calls.map((c) => c.messages));
    expect(sent).not.toContain(seeded.eventId);
    expect(sent).not.toContain(JID);
    expect(stages()).toEqual(['extract', 'draft']);
    const p = env.repos.proposals.current(item.id)!;
    expect(p.contextFromMeRecent).toBe(true);
    expect(p.providerClass).toBe('local');
  });

  it('fail closed without the update surface dep: the delta degrades to the change_in_google info card', async () => {
    const w = window();
    openItem(w[1]!);
    await run(build(w, stub(), { updateSurfaceAvailable: undefined }));
    expect(pending()).toEqual(['send_reply']);
    expect(env.repos.items.byId(item.id)!.badges).toContain('change_in_google');
    expect(tryAutoIds).toEqual([]);
  });

  it('a v1-shaped caller (no v2 deps at all) keeps working: the real findExistingEvent, no tryAuto', async () => {
    const w = window();
    openItem(w[1]!);
    await run(build(w, stub(), { tryAuto: undefined, updateSurfaceAvailable: undefined }));
    expect(env.repos.items.byId(item.id)!.linkedItemId).toBe(seeded.item.id);
    expect(tryAutoIds).toEqual([]);
  });

  it('a throwing tryAuto never costs the manual card', async () => {
    const w = window();
    openItem(w[1]!);
    await run(build(w, stub(), { tryAuto: () => Promise.reject(new Error('boom')) }));
    expect(pending()).toEqual(['send_reply', 'update_event']);
    expect(env.log.lines.some((l) => l.event === 'triage_auto_error')).toBe(true);
  });

  it("a reschedule prefetches free/busy for the NEW slot minus the event's own block (P2 7.3)", async () => {
    const w = window();
    openItem(w[1]!);
    env.read.setBusy([
      { startLocal: '2026-09-23T15:00:00', endLocal: '2026-09-23T16:00:00' }, // the event itself
      { startLocal: '2026-09-23T17:30:00', endLocal: '2026-09-23T18:30:00' }, // a real clash
    ]);
    await run(build(w, stub()));
    expect(env.read.freeBusyCalls).toHaveLength(1);
    expect(env.repos.items.byId(item.id)!.badges).toContain('conflict');
    const stored = env.repos.proposals.current(item.id)!.freeBusy!;
    expect(stored.some((b) => b.startLocal === '2026-09-23T15:00:00')).toBe(false);
  });

  it('a new_event on a chat with an event runs the v1 path (second event) and prefetches for its slot', async () => {
    const w = window();
    openItem(w[1]!);
    await run(
      build(
        w,
        stub(
          rules({
            intent: 'schedule_request',
            change: 'new_event',
            refersToExisting: false,
            dateKind: 'relative_days',
            daysFromToday: 1,
          }),
        ),
      ),
    );
    expect(pending()).toEqual(['create_event', 'send_reply']);
    expect(env.read.freeBusyCalls).toHaveLength(1);
  });

  it('a manipulation abort in S3 taints the chat and records the blocked calls (B28)', async () => {
    const w = window();
    openItem(w[1]!);
    const r: StubRule[] = [
      { when: { purpose: 'extract' }, respond: { structured: { ...X } } },
      {
        when: { purpose: 'draft' },
        respond: {
          toolCalls: [
            { name: 'delete-event', input: {} },
            { name: 'send_message', input: {} },
          ],
        },
      },
    ];
    await run(build(w, stub(r)));
    const p = env.repos.proposals.current(item.id)!;
    expect(p.blockedCalls).toBeGreaterThan(0);
    expect(env.repos.items.byId(item.id)!.badges).toContain('manipulation');
    expect(env.repos.chats.byId(chatId)!.autoTaintedUntil).toBeGreaterThan(ANCHOR_MS);
  });
});

// =====================================================================================================================
describe('the self trigger (F28, P2 2 item 5)', () => {
  it("the user's own newest message on a chat with an event => S1 only, one update_event, trigger_author self", async () => {
    const w = [msg(1, { text: 'great, see you Wednesday' }), msg(2, { text: "let's make it 5 instead", fromMe: true })];
    openItem(w[0]!);
    const llm = stub();
    await run(build(w, llm));
    expect(pending()).toEqual(['update_event']);
    expect(stages()).toEqual(['extract']);
    const p = env.repos.proposals.current(item.id)!;
    expect(p.triggerAuthor).toBe('self');
    expect(p.extraction!.needsReply).toBe(false);
    expect(llm.calls.map((c) => c.purpose)).toEqual(['extract']);
  });

  it('a from_me row that matches an app send is never a self trigger (the v1 path runs, with a draft)', async () => {
    const w = [msg(1, { text: 'can we do 5?' }), msg(2, { text: 'See you then.', fromMe: true })];
    openItem(w[0]!);
    // the app's own approved reply (done send_reply of this item) landed in the bridge as row 2
    const proposal = env.repos.proposals.insertNext({
      itemId: item.id,
      provider: 'local',
      model: 'm',
      extraction: null,
      draftText: null,
      replyLang: null,
      event: null,
      freeBusy: null,
      suspicious: false,
      createdAt: ANCHOR_MS - 5_000,
    });
    const a = env.repos.actions.insertPending({
      itemId: item.id,
      proposalId: proposal.id,
      chatId,
      now: ANCHOR_MS - 5_000,
      payload: {
        v: 1,
        kind: 'send_reply',
        itemId: item.id,
        chatRef: chatId,
        proposalVersion: proposal.version,
        text: 'See you then.',
      },
    });
    env.repos.actions.markApprovedExecuting(a.id, a.canonicalJson, ANCHOR_MS - 4_000, 'user');
    env.repos.actions.markDone(a.id, { kind: 'send_reply', waMsgId: null }, ANCHOR_MS - 3_000);
    await run(build(w, stub()));
    expect(env.repos.proposals.current(item.id)!.triggerAuthor).toBe('contact');
    expect(stages()).toEqual(['extract', 'draft']);
  });

  it("without an editable event the user's own message is no trigger (v1)", async () => {
    const w = [msg(1, { text: 'coffee tomorrow at 5?' }), msg(2, { text: 'sure', fromMe: true })];
    openItem(w[0]!);
    const o = build(w, stub(rules({ intent: 'schedule_request', change: 'no_change', refersToExisting: false })), {
      existingEvent: () => null,
    });
    await run(o);
    expect(env.repos.proposals.current(item.id)!.triggerAuthor).toBe('contact');
  });
});

// =====================================================================================================================
describe('V0 TRANSCRIBE hand-off (P2 3)', () => {
  const audio = (i: number, fromMe = false): Message => msg(i, { text: '', mediaType: 'audio', fromMe });
  const transcript = (m: Message, status: 'done' | 'empty' | 'failed', text: string | null): void =>
    env.repos.transcripts.upsert({
      chatJid: JID,
      waMsgId: m.waMsgId,
      status,
      text,
      language: 'en',
      seconds: 4,
      modelLabel: 'voice-hebrew',
      errorCode: status === 'failed' ? 'VOICE_DECODE_FAILED' : null,
      createdAt: ANCHOR_MS,
    });

  beforeEach(() => {
    env.settings.voice.enabled = true;
  });

  it('runs V0 before S1, shows the transcribing line, and the transcript reaches S1 as a voice_transcript row', async () => {
    const w = [msg(1, { text: 'hey', fromMe: true }), audio(2)];
    openItem(w[1]!);
    const seen: Array<number | null> = [];
    const llm = stub();
    await run(
      build(w, llm, {
        onTranscribing: (s) => void seen.push(s),
        voice: {
          transcribeChat: () => {
            events.push('V0');
            transcript(w[1]!, 'done', 'can we move it to 5 instead');
            return Promise.resolve({ written: [], deferred: false });
          },
        },
      }),
    );
    expect(seen).toEqual([0, null]);
    expect(events[events.indexOf('V0') - 1]).toBe('notify'); // the 'running' notification comes first, then V0, then S1
    expect(userText(llm.calls[0]!.messages)).toContain(
      '"source":"voice_transcript","language":"en","text":"can we move it to 5 instead"',
    );
    expect(env.repos.items.byId(item.id)!.triggerKind).toBe('voice');
  });

  it('an empty voice note is never a trigger: closed not_needed without an LLM run (B18)', async () => {
    const w = [audio(1)];
    openItem(w[0]!);
    const llm = stub();
    await run(
      build(w, llm, {
        voice: {
          transcribeChat: () => (transcript(w[0]!, 'empty', ''), Promise.resolve({ written: [], deferred: false })),
        },
      }),
    );
    const fresh = env.repos.items.byId(item.id)!;
    expect(fresh.closedReason).toBe('not_needed');
    expect(fresh.state).toBe('ignored');
    expect(llm.calls).toHaveLength(0);
    expect(stages()).toEqual([]);
  });

  it('a failed transcript as the only trigger => a raw card with its VOICE_* code', async () => {
    const w = [audio(1)];
    openItem(w[0]!);
    await run(
      build(w, stub(), {
        voice: {
          transcribeChat: () => (transcript(w[0]!, 'failed', null), Promise.resolve({ written: [], deferred: false })),
        },
      }),
    );
    const fresh = env.repos.items.byId(item.id)!;
    expect(fresh.analysis).toBe('failed');
    expect(fresh.errorCode).toBe('VOICE_DECODE_FAILED');
  });

  it('F33 deferral: a note left for a later run re-queues the chat (nothing usable yet => no S1 now)', async () => {
    const w = [audio(1)];
    openItem(w[0]!);
    const llm = stub();
    await run(build(w, llm, { voice: { transcribeChat: () => Promise.resolve({ written: [], deferred: true }) } }));
    expect(env.repos.items.byId(item.id)!.analysis).toBe('queued');
    expect(env.repos.queue.size()).toBe(1);
    expect(llm.calls).toHaveLength(0);
  });

  it('F33 deferral with a usable text trigger: S1-S4 run now and the chat is queued again for the rest', async () => {
    const w = [audio(1), msg(2, { text: 'can we do 5 instead of 3?' })];
    openItem(w[0]!);
    await run(build(w, stub(), { voice: { transcribeChat: () => Promise.resolve({ written: [], deferred: true }) } }));
    expect(pending()).toEqual(['send_reply', 'update_event']);
    expect(env.repos.items.byId(item.id)!.analysis).toBe('queued');
    expect(env.repos.queue.size()).toBe(1);
  });

  it('Pause during V0 puts the item back to queued', async () => {
    const w = [audio(1)];
    openItem(w[0]!);
    const ac = new AbortController();
    await run(
      build(w, stub(), {
        voice: { transcribeChat: () => (ac.abort(), Promise.resolve({ written: [], deferred: false })) },
      }),
      ac.signal,
    );
    expect(env.repos.items.byId(item.id)!.analysis).toBe('queued');
  });

  it('voice off / nothing pending => V0 is not called', async () => {
    const w = [msg(1, { text: 'can we do 5 instead of 3?' })];
    openItem(w[0]!);
    let called = 0;
    await run(
      build(w, stub(), {
        voice: { transcribeChat: () => (called++, Promise.resolve({ written: [], deferred: false })) },
      }),
    );
    expect(called).toBe(0);
  });
});

// =====================================================================================================================
describe('V1 READ-IMAGE hand-off (P2 4)', () => {
  const picture = (i: number, caption = 'join us?'): Message => msg(i, { text: caption, mediaType: 'image' });
  const read = (outcome: ReadImageOutcome) => (): Promise<ReadImageOutcome> => {
    events.push('V1');
    return Promise.resolve(outcome);
  };

  it('a read picture: imageText on its own row inside the block, from_image + image_unclear (gate false), trigger_kind image', async () => {
    const w = [msg(1, { text: 'hey', fromMe: true }), picture(2)];
    openItem(w[1]!);
    const llm = stub(
      rules({
        intent: 'schedule_request',
        change: 'no_change',
        refersToExisting: false,
        dateKind: 'none',
        time24h: '',
      }),
    );
    await run(
      build(w, llm, {
        existingEvent: () => null,
        pickImage: () => Promise.resolve(IMAGE),
        readImage: read({ ok: true, read: READ, route: 'local', runId: 1 }),
      }),
    );
    const s1 = userText(llm.calls[0]!.messages);
    expect(s1).toContain('"imageText":"Jazz night');
    expect(s1).toContain('"imageKind":"flyer"');
    const fresh = env.repos.items.byId(item.id)!;
    expect(fresh.badges).toEqual(expect.arrayContaining(['from_image', 'image_unclear']));
    expect(fresh.triggerKind).toBe('image');
    const p = env.repos.proposals.current(item.id)!;
    expect(p.imageRead).toEqual(READ);
    // the image branch (P2 7.4) set the date from the digits: Thursday 24.9 20:00
    expect(p.event?.startLocal).toBe('2026-09-24T20:00:00');
  });

  it('a failed read never blocks S1: image_unread, the text path still runs', async () => {
    const w = [picture(1, 'see attached')];
    openItem(w[0]!);
    const llm = stub(rules({ intent: 'question', change: 'no_change', refersToExisting: false, time24h: '' }));
    await run(
      build(w, llm, {
        existingEvent: () => null,
        pickImage: () => Promise.resolve(IMAGE),
        readImage: read({ ok: false, badge: 'image_unread', reason: 'bad_output' }),
      }),
    );
    expect(llm.calls[0]!.purpose).toBe('extract');
    expect(env.repos.items.byId(item.id)!.badges).toContain('image_unread');
    expect(env.repos.items.byId(item.id)!.triggerKind).toBe('image');
  });

  it('a suspicious read is a red badge (and taints)', async () => {
    const w = [picture(1, '')];
    openItem(w[0]!);
    await run(
      build(w, stub(rules({ intent: 'other', change: 'no_change', refersToExisting: false, time24h: '' })), {
        existingEvent: () => null,
        pickImage: () => Promise.resolve(IMAGE),
        readImage: read({ ok: true, read: { ...READ, suspicious: true }, route: 'provider', runId: 1 }),
      }),
    );
    expect(env.repos.items.byId(item.id)!.badges).toContain('manipulation');
    expect(env.repos.chats.byId(chatId)!.autoTaintedUntil).toBeGreaterThan(ANCHOR_MS);
  });

  it('an already-read picture is reused from the media cache + the current proposal (no second V1, P2 4.1)', async () => {
    const w = [picture(1)];
    openItem(w[0]!);
    const llm = stub(rules({ intent: 'schedule_request', change: 'no_change', refersToExisting: false, time24h: '' }));
    const deps = {
      existingEvent: () => null,
      pickImage: () => Promise.resolve(IMAGE),
      readImage: read({ ok: true, read: READ, route: 'local', runId: 1 }),
    };
    await run(build(w, llm, deps));
    env.repos.mediaCache.upsert({
      itemId: item.id,
      chatId,
      waMsgId: w[0]!.waMsgId,
      sha256: 'b'.repeat(64),
      width: 1,
      height: 1,
      bytes: 1,
      createdAt: ANCHOR_MS,
    });
    env.repos.items.update(item.id, { analysis: 'queued' }, ANCHOR_MS);
    events = [];
    await run(build(w, llm, { ...deps, pickImage: () => Promise.resolve(null) }));
    expect(events).not.toContain('V1');
    expect(env.repos.proposals.current(item.id)!.imageRead).toEqual(READ);
    expect(env.repos.proposals.current(item.id)!.version).toBe(2);
  });

  it('no picture reader available (pickImage => null, nothing cached) => image_unread', async () => {
    const w = [picture(1)];
    openItem(w[0]!);
    await run(
      build(w, stub(rules({ intent: 'other', change: 'no_change', refersToExisting: false, time24h: '' })), {
        existingEvent: () => null,
        pickImage: () => Promise.resolve(null),
      }),
    );
    expect(env.repos.items.byId(item.id)!.badges).toContain('image_unread');
  });

  it('pictures off => no pick, no read: the caption is context only', async () => {
    env.settings.images.enabled = false;
    const w = [picture(1, 'coffee at 5 tomorrow?')];
    openItem(w[0]!);
    let picked = 0;
    await run(
      build(w, stub(rules({ intent: 'schedule_request', change: 'no_change', refersToExisting: false })), {
        existingEvent: () => null,
        pickImage: () => (picked++, Promise.resolve(IMAGE)),
      }),
    );
    expect(picked).toBe(0);
    expect(env.repos.items.byId(item.id)!.badges).not.toContain('image_unread');
  });

  it('Pause during V1 puts the item back to queued', async () => {
    const w = [picture(1)];
    openItem(w[0]!);
    const ac = new AbortController();
    await run(
      build(w, stub(), {
        existingEvent: () => null,
        pickImage: () => (ac.abort(), Promise.resolve(IMAGE)),
        readImage: read({ ok: false, badge: 'image_unread', reason: 'timeout' }),
      }),
      ac.signal,
    );
    expect(env.repos.items.byId(item.id)!.analysis).toBe('queued');
  });
});

// =====================================================================================================================
describe('CLI provenance (B25, P2 9.4)', () => {
  const PROOF: CliSandboxProof = { initOk: true, toolsCount: 0, mcpServers: 0, apiKeySource: 'oauth', mismatch: null };
  /** A CLI-shaped provider: S1 via structured() reporting its init proof, S3 via runAgentic(). */
  function cliProvider(opts: {
    s1Proof: CliSandboxProof | null;
    agentic: Partial<AgenticRunResult>;
    draftProof?: CliSandboxProof;
  }): LlmProvider {
    return {
      id: 'claude_cli',
      model: 'sonnet',
      loop: 'agentic',
      capabilities: { images: true },
      structured<T>(_m: LlmMessage[], _s: unknown, o: CallOpts): Promise<T> {
        if (opts.s1Proof !== null) o.onSandbox?.(opts.s1Proof);
        return Promise.resolve({ ...X } as T);
      },
      chat: () => Promise.reject(new LlmError('unsupported')),
      runAgentic(_i: AgenticRunInput, o: CallOpts): Promise<AgenticRunResult> {
        if (opts.draftProof) o.onSandbox?.(opts.draftProof);
        return Promise.resolve({
          text: 'sure',
          toolCalls: 0,
          blockedCalls: 0,
          sandboxOk: true,
          stopReason: 'end',
          ...opts.agentic,
        });
      },
      validate: () => Promise.resolve({ ok: true as const, model: 'sonnet' }),
      dispose: () => Promise.resolve(),
    } as LlmProvider;
  }
  const w = (): Message[] => [msg(1, { text: 'hey', fromMe: true }), msg(2, { text: 'can we do 5 instead of 3?' })];

  it('S1 proof recorded on its runs row; an ok agentic S3 is a proven run => cli_proven', async () => {
    const window = w();
    openItem(window[1]!);
    await run(build(window, cliProvider({ s1Proof: PROOF, agentic: {} })));
    expect(env.repos.proposals.current(item.id)!.providerClass).toBe('cli_proven');
    const rows = env.db
      .prepare<{ stage: string; sandbox_ok: number | null }>(
        'SELECT stage, sandbox_ok FROM runs WHERE item_id = ? ORDER BY id',
      )
      .all(item.id);
    expect(rows).toEqual([
      { stage: 'extract', sandbox_ok: 1 },
      { stage: 'draft', sandbox_ok: null },
    ]);
  });

  it('a failed S1 proof => cli_unproven', async () => {
    const window = w();
    openItem(window[1]!);
    await run(
      build(window, cliProvider({ s1Proof: { ...PROOF, initOk: false, mismatch: 'extra_tool' }, agentic: {} })),
    );
    expect(env.repos.proposals.current(item.id)!.providerClass).toBe('cli_unproven');
  });

  it('no S1 proof at all => cli_unproven', async () => {
    const window = w();
    openItem(window[1]!);
    await run(build(window, cliProvider({ s1Proof: null, agentic: {} })));
    expect(env.repos.proposals.current(item.id)!.providerClass).toBe('cli_unproven');
  });
});

// =====================================================================================================================
describe('pure helpers', () => {
  const EXISTING: ExistingEventCtx = {
    editableCount: 1,
    originItemId: 1,
    sourceItemId: 1,
    eventId: 'evtsrc0001',
    title: 't',
    location: 'l',
    startLocal: '2026-09-23T15:00:00',
    endLocal: '2026-09-23T16:00:00',
    timeZone: TEST_TZ,
    status: 'confirmed',
    revision: 1,
  };

  it('rowText / isUsableTrigger', () => {
    expect(rowText(msg(1, { text: 'x' }))).toBe('x');
    expect(
      rowText(msg(1, { text: '', mediaType: 'audio', voice: { transcript: 'hi', language: 'en', seconds: 1 } })),
    ).toBe('hi');
    expect(rowText(msg(1, { text: '', mediaType: 'audio' }))).toBe('');
    expect(isUsableTrigger(msg(1, { text: 'x', deleted: true }), false)).toBe(false);
    expect(isUsableTrigger(msg(1, { text: '', mediaType: 'image' }), true)).toBe(true);
    expect(isUsableTrigger(msg(1, { text: '', mediaType: 'image' }), false)).toBe(false);
    expect(isUsableTrigger(msg(1, { text: 'caption', mediaType: 'image' }), false)).toBe(true);
    expect(isUsableTrigger(msg(1, { text: '   ' }), false)).toBe(false);
  });

  it('triggerRowsOf: from the trigger row on; else by time; else the newest inbound', () => {
    const w = [msg(1, { text: 'a' }), msg(2, { text: 'b', fromMe: true }), msg(3, { text: 'c' })];
    expect(triggerRowsOf(w, 'wamid.M1', 0 as EpochMs).map((m) => m.text)).toEqual(['a', 'c']);
    expect(triggerRowsOf(w, 'gone', w[2]!.ts!).map((m) => m.text)).toEqual(['c']);
    expect(triggerRowsOf(w, 'gone', (ANCHOR_MS + 1e6) as EpochMs).map((m) => m.text)).toEqual(['c']);
    expect(triggerRowsOf([], 'x', 0 as EpochMs)).toEqual([]);
  });

  it('selfTriggerRow: only a from_me text / done-transcript newest row, with an event, that is not an app send', () => {
    const repos = { actions: { forItem: () => [] } } as unknown as Parameters<typeof selfTriggerRow>[0];
    const me = msg(2, { text: "let's make it 5", fromMe: true });
    expect(selfTriggerRow(repos, [msg(1, { text: 'x' }), me], EXISTING, 9)).toBe(me);
    expect(selfTriggerRow(repos, [msg(1, { text: 'x' }), me], null, 9)).toBeNull();
    expect(selfTriggerRow(repos, [me, msg(3, { text: 'x' })], EXISTING, 9)).toBeNull();
    expect(selfTriggerRow(repos, [], EXISTING, 9)).toBeNull();
    expect(selfTriggerRow(repos, [msg(2, { text: 'x', fromMe: true, deleted: true })], EXISTING, 9)).toBeNull();
    expect(selfTriggerRow(repos, [msg(2, { text: 'x', fromMe: true, mediaType: 'image' })], EXISTING, 9)).toBeNull();
    expect(selfTriggerRow(repos, [msg(2, { text: '', fromMe: true, mediaType: 'audio' })], EXISTING, 9)).toBeNull();
    const voice = msg(2, {
      text: '',
      fromMe: true,
      mediaType: 'audio',
      voice: { transcript: 'make it 5', language: 'en', seconds: 2 },
    });
    expect(selfTriggerRow(repos, [voice], EXISTING, 9)).toBe(voice);
  });

  it('isAppSend: by recorded message id or by approved text; only for sent-ish states and send_reply', () => {
    const row = msg(5, { text: 'See you', fromMe: true });
    const a = (over: Record<string, unknown>) => ({
      kind: 'send_reply',
      state: 'done',
      result: null,
      approvedFinalJson: null,
      canonicalJson: '',
      ...over,
    });
    const repos = (list: Array<Record<string, unknown>>) =>
      ({ actions: { forItem: () => list } }) as unknown as Parameters<typeof isAppSend>[0];
    expect(isAppSend(repos([a({ result: { kind: 'send_reply', waMsgId: 'wamid.M5' } })]), [1], row)).toBe(true);
    expect(
      isAppSend(repos([a({ approvedFinalJson: JSON.stringify({ kind: 'send_reply', text: 'See you' }) })]), [1], row),
    ).toBe(true);
    expect(
      isAppSend(repos([a({ canonicalJson: JSON.stringify({ kind: 'send_reply', text: 'See you' }) })]), [1], row),
    ).toBe(true);
    expect(
      isAppSend(
        repos([a({ state: 'pending', canonicalJson: JSON.stringify({ kind: 'send_reply', text: 'See you' }) })]),
        [1],
        row,
      ),
    ).toBe(false);
    expect(isAppSend(repos([a({ kind: 'create_event' })]), [1], row)).toBe(false);
    expect(isAppSend(repos([a({ approvedFinalJson: '{bad json' })]), [1], row)).toBe(false);
    expect(isAppSend(repos([a({ approvedFinalJson: JSON.stringify({ kind: 'create_event' }) })]), [1], row)).toBe(
      false,
    );
    expect(isAppSend(repos([a({ result: { kind: 'send_reply', waMsgId: null } })]), [1], row)).toBe(false);
  });

  it('triggerKindOfRun is conservative: voice > image > text', () => {
    expect(triggerKindOfRun({ voiceInWindow: true, imageInWindow: true, imageTriggerUnread: false })).toBe('voice');
    expect(triggerKindOfRun({ voiceInWindow: false, imageInWindow: true, imageTriggerUnread: false })).toBe('image');
    expect(triggerKindOfRun({ voiceInWindow: false, imageInWindow: false, imageTriggerUnread: true })).toBe('image');
    expect(triggerKindOfRun({ voiceInWindow: false, imageInWindow: false, imageTriggerUnread: false })).toBe('text');
  });

  it('draftDeltaOf maps every S2 outcome to the S3 view', () => {
    const to = { ...EXISTING, status: 'confirmed' as const };
    const delta = {
      kind: 'reschedule' as const,
      targetEventId: 'evtsrc0001',
      sourceItemId: 1,
      baseRevision: 1,
      from: {
        title: 't',
        startLocal: EXISTING.startLocal,
        endLocal: EXISTING.endLocal,
        timeZone: TEST_TZ,
        location: 'l',
        status: 'confirmed' as const,
      },
      to: {
        title: 't',
        startLocal: '2026-09-23T17:00:00',
        endLocal: '2026-09-23T18:00:00',
        timeZone: TEST_TZ,
        location: 'l',
        status: 'confirmed' as const,
      },
      confidence: 'high' as const,
      assumptions: [],
      problems: [],
    };
    expect(draftDeltaOf(null, EXISTING)).toBeNull();
    expect(draftDeltaOf({ path: 'v1' }, null)).toBeNull();
    expect(draftDeltaOf({ path: 'v1' }, EXISTING)).toBeNull();
    expect(draftDeltaOf({ path: 'delta', delta }, EXISTING)).toMatchObject({
      change: 'reschedule',
      to: delta.to,
      confidence: 'high',
    });
    expect(draftDeltaOf({ path: 'incomplete', missing: ['date'] }, EXISTING)).toMatchObject({
      change: 'reschedule',
      to: null,
      missing: ['date'],
    });
    expect(draftDeltaOf({ path: 'unclear', why: 'sanity' }, EXISTING)).toMatchObject({ change: 'unclear', to: null });
    expect(draftDeltaOf({ path: 'no_change' }, EXISTING)).toMatchObject({ change: 'no_change', to: null });
    expect(draftDeltaOf({ path: 'suppressed' }, EXISTING)).toMatchObject({ change: 'no_change', to: null });
    expect(to.status).toBe('confirmed');
  });

  it('imageWhenOf: the picture digits for R6 (date / time / neither)', () => {
    expect(imageWhenOf(null, '2026-09-21')).toBeNull();
    expect(imageWhenOf({ ...READ, readable: false }, '2026-09-21')).toBeNull();
    expect(imageWhenOf(READ, '2026-09-21')).toEqual({ date: '2026-09-24', time24h: '20:00', timeAmbiguous: false });
    expect(imageWhenOf({ ...READ, day: 0, month: 0 }, '2026-09-21')).toEqual({
      date: null,
      time24h: '20:00',
      timeAmbiguous: false,
    });
    expect(imageWhenOf({ ...READ, hour: 24 }, '2026-09-21')).toEqual({
      date: '2026-09-24',
      time24h: '',
      timeAmbiguous: false,
    });
    expect(imageWhenOf({ ...READ, day: 0, hour: 24 }, '2026-09-21')).toBeNull();
    expect(imageWhenOf({ ...READ, day: 31, month: 2, year: 2026, hour: 24 }, '2026-09-21')).toBeNull();
  });

  it('findExistingEvent is the default existing-event source', () => {
    expect(findExistingEvent(env.repos, chatId, ANCHOR_MS)?.eventId).toBe(seeded.eventId);
  });
});
