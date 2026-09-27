// src/main/agent/orchestrator.test.ts - S1..S4 for one chat (TESTS 5.3 row `agent/orchestrator.ts`; owner W1-10).
// Real in-memory app.db + real repos + the real ToolGate over a recording READ double, so the assertions about runs rows,
// proposals, pending actions and the `[R2]` S2 free/busy prefetch are made against the shipped schema.
// Approval-first: every assertion about a "result" is an assertion about a PENDING action - nothing is ever executed here.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DRAFT_MAX_OUTPUT_TOKENS_CLOUD,
  DRAFT_MAX_OUTPUT_TOKENS_LOCAL,
  EXTRACT_MAX_OUTPUT_TOKENS,
  createOrchestrator,
  type Orchestrator,
} from './orchestrator';
import { TriageRetryError } from './queue';
import { ConsentRequiredError, type LlmProvider, type ProviderFactory } from '../llm/types';
import { LIMITS, type BusyBlock, type Chat, type EpochMs, type Item } from '../../shared/types';
import type { Extraction } from '../../shared/schemas';
import { StubLlm, type StubRule } from '../../../tests/fakes/stub-llm';
import { createSeededRandom, createVirtualClock, type VirtualClock } from '../../../tests/helpers/virtualClock';
import {
  ANCHOR_MS,
  TEST_TZ,
  createIngestDouble,
  createTestEnv,
  messagesFrom,
  seedChat,
  seedOpenItem,
  type TestEnv,
} from '../../../tests/golden/testDb';

const EXTRACTION: Extraction = {
  intent: 'schedule_request',
  needsReply: true,
  title: 'coffee',
  dateKind: 'relative_days',
  isoDate: '',
  weekday: 0,
  weekOffset: 0,
  daysFromToday: 1,
  time24h: '17:00',
  timeAmbiguous: false,
  durationMin: 60,
  location: '',
  missing: [],
  suspicious: false,
};
const extraction = (over: Partial<Extraction> = {}): Record<string, unknown> => ({ ...EXTRACTION, ...over });

/** tomorrow 17:00 in TEST_TZ for the anchor - the slot every default case resolves to. */
const SLOT_START = '2026-09-22T17:00:00';
const SLOT_END = '2026-09-22T18:00:00';

const DEFAULT_RULES: StubRule[] = [
  { when: { purpose: 'extract' }, respond: { structured: extraction() } },
  { when: { purpose: 'draft' }, respond: { text: 'Tomorrow at 17:00 works for me' } },
];

describe('createOrchestrator', () => {
  let env: TestEnv;
  let clock: VirtualClock;
  let chat: Chat;
  let item: Item;
  let llm: StubLlm;
  let providerCalls: number;
  let providerError: Error | null;
  let notified: number[][];
  let created: number[];

  const build = (
    rules: StubRule[] = DEFAULT_RULES,
    opts: { id?: 'local' | 'claude'; messages?: Array<{ fromMe: boolean; text: string; ts: EpochMs }> } = {},
  ): Orchestrator => {
    llm = new StubLlm({
      rules,
      id: opts.id ?? 'local',
      model: opts.id === 'claude' ? 'claude-opus-5' : 'stub-model',
      clock,
    });
    const providers: ProviderFactory = {
      get: () => {
        providerCalls += 1;
        return providerError === null ? Promise.resolve(llm as LlmProvider) : Promise.reject(providerError);
      },
      usable: () => ({ ok: true }),
      invalidate: () => Promise.resolve(),
    };
    const rows = opts.messages ?? [
      { fromMe: false, text: 'coffee tomorrow at 17:00?', ts: (ANCHOR_MS - 60_000) as EpochMs },
    ];
    return createOrchestrator({
      repos: env.repos,
      providers,
      gate: env.gate,
      ingest: createIngestDouble(messagesFrom(chat.jid, rows)),
      settings: () => env.settings,
      clock,
      random: createSeededRandom(),
      log: env.log,
      notifyChanged: (ids) => void notified.push(ids),
      onItemCreated: (id) => void created.push(id),
    });
  };

  const run = async (o: Orchestrator, signal = new AbortController().signal): Promise<void> =>
    o.runChat(chat.id, signal);

  beforeEach(() => {
    env = createTestEnv({ calendarConnected: true });
    clock = createVirtualClock(ANCHOR_MS);
    chat = seedChat(env.repos);
    item = seedOpenItem(env.repos, chat);
    providerCalls = 0;
    providerError = null;
    notified = [];
    created = [];
  });
  afterEach(() => env.dispose());

  it('runs the happy path: extract -> resolve -> draft -> validate, with both runs rows and both pending actions', async () => {
    await run(build());
    const fresh = env.repos.items.byId(item.id)!;
    expect(fresh.analysis).toBe('done');
    expect(fresh.state).toBe('needs_reply');
    const proposal = env.repos.proposals.current(item.id)!;
    expect(proposal.version).toBe(1);
    expect(proposal.draftText).toBe('Tomorrow at 17:00 works for me');
    expect(proposal.event).toMatchObject({ startLocal: SLOT_START, endLocal: SLOT_END, timeZone: TEST_TZ });
    expect(
      env.repos.actions
        .forItem(item.id)
        .map((a) => a.kind)
        .sort(),
    ).toEqual(['create_event', 'send_reply']);
    expect(env.repos.actions.forItem(item.id).every((a) => a.state === 'pending')).toBe(true);
    expect(created).toEqual([item.id]);
  });

  it('records the per-run rate buckets and marks the item running before the first model call', async () => {
    await run(build());
    expect(env.repos.rate.countSince('llm_chat', String(chat.id), 0)).toBe(1);
    expect(env.repos.rate.countSince('llm_global', 'global', 0)).toBe(1);
    // The FIRST notification is the running transition, so the card spins while the model works.
    expect(notified[0]).toEqual([item.id]);
  });

  it('writes runs rows with metadata only - token counts, never text', async () => {
    await run(build());
    const rows = env.db
      .prepare<{
        stage: string;
        outcome: string;
        input_tokens: number;
        output_tokens: number;
        error_code: string | null;
      }>('SELECT stage, outcome, input_tokens, output_tokens, error_code FROM runs ORDER BY id')
      .all();
    expect(rows.map((r) => r.stage)).toEqual(['extract', 'draft']);
    expect(rows.every((r) => r.outcome === 'ok')).toBe(true);
    expect(rows.every((r) => r.input_tokens > 0)).toBe(true);
    expect(rows.every((r) => r.error_code === null)).toBe(true);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('coffee');
    expect(dump).not.toContain('17:00');
  });

  it('uses the S1/S3 output budgets and switches the draft budget by provider', async () => {
    await run(build());
    expect(llm.calls[0]!.opts.maxOutputTokens).toBe(EXTRACT_MAX_OUTPUT_TOKENS);
    expect(llm.calls[1]!.opts.maxOutputTokens).toBe(DRAFT_MAX_OUTPUT_TOKENS_LOCAL);

    env.repos.items.update(item.id, { analysis: 'queued' }, clock.now());
    env.patchSettings((s) => void (s.llm.provider = 'claude'));
    await run(build(DEFAULT_RULES, { id: 'claude' }));
    expect(llm.calls[1]!.opts.maxOutputTokens).toBe(DRAFT_MAX_OUTPUT_TOKENS_CLOUD);
  });

  it('snapshots what the model saw and never lets a JID into the context', async () => {
    await run(build());
    const snapshot = env.repos.items.messages(item.id);
    expect(snapshot.length).toBeGreaterThan(0);
    const sent = JSON.stringify(llm.calls.map((c) => c.messages));
    expect(sent).not.toContain(chat.jid);
    expect(sent).not.toContain('972550000001');
    expect(sent).not.toContain('Test Contact');
  });

  it('[R2] prefetches free/busy in S2 for a complete slot even when needsReply is false, and stores the blocks', async () => {
    const busy: BusyBlock[] = [{ startLocal: SLOT_START, endLocal: SLOT_END }];
    env.read.setBusy(busy);
    await run(
      build([
        {
          when: { purpose: 'extract' },
          respond: { structured: extraction({ needsReply: false, intent: 'confirmation' }) },
        },
      ]),
    );
    expect(env.read.freeBusyCalls).toHaveLength(1);
    const proposal = env.repos.proposals.current(item.id)!;
    expect(proposal.freeBusy).toEqual(busy);
    expect(env.repos.items.byId(item.id)!.badges).toContain('conflict');
    // No S3 run at all: only the extract turn happened.
    expect(llm.calls).toHaveLength(1);
    expect(env.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE stage='draft'").get()!.n).toBe(0);
  });

  it('skips the prefetch when the calendar is not connected, and proposes no create_event', async () => {
    env.setCalendarConnected(false);
    await run(build());
    expect(env.read.freeBusyCalls).toHaveLength(0);
    expect(env.repos.proposals.current(item.id)!.freeBusy).toBeNull();
    expect(env.repos.actions.forItem(item.id).map((a) => a.kind)).toEqual(['send_reply']);
  });

  it('skips the prefetch for an incomplete slot', async () => {
    await run(
      build([
        { when: { purpose: 'extract' }, respond: { structured: extraction({ time24h: '', missing: ['time'] }) } },
        { when: { purpose: 'draft' }, respond: { text: 'What time suits you?' } },
      ]),
    );
    expect(env.read.freeBusyCalls).toHaveLength(0);
    expect(env.repos.items.byId(item.id)!.state).toBe('info_missing');
  });

  it('runs the whole pipeline on ONE provider and never falls back', async () => {
    await run(build());
    expect(providerCalls).toBe(1);
    const providers = env.db.prepare<{ provider: string }>('SELECT DISTINCT provider FROM runs').all();
    expect(providers).toEqual([{ provider: 'local' }]);
  });

  it('holds the item as waiting_llm when no provider can be built', async () => {
    providerError = new Error('no model');
    await run(build());
    const fresh = env.repos.items.byId(item.id)!;
    expect(fresh.analysis).toBe('held');
    expect(fresh.holdReason).toBe('waiting_llm');
    expect(fresh.errorCode).toBe('LLM_NOT_READY');
  });

  it('maps a missing consent to CONSENT_REQUIRED', async () => {
    providerError = new ConsentRequiredError('cloud_claude');
    await run(build());
    expect(env.repos.items.byId(item.id)!.errorCode).toBe('CONSENT_REQUIRED');
  });

  it('fails the item (no retry) for a terminal provider error and records the ErrorCode only', async () => {
    await run(build([{ when: { purpose: 'extract' }, respond: { error: 'auth' } }]));
    const fresh = env.repos.items.byId(item.id)!;
    expect(fresh.analysis).toBe('failed');
    expect(fresh.errorCode).toBe('LLM_LOCAL_FAILED');
    const row = env.db.prepare<{ error_code: string | null }>('SELECT error_code FROM runs').get()!;
    expect(row.error_code).toBe('LLM_LOCAL_FAILED');
  });

  it('fails the item with LLM_BAD_OUTPUT after the repair retry', async () => {
    await run(build([{ when: { purpose: 'extract' }, respond: { structured: { garbage: true } } }]));
    expect(env.repos.items.byId(item.id)!.errorCode).toBe('LLM_BAD_OUTPUT');
    expect(llm.calls).toHaveLength(2); // one repair turn, then stop
  });

  it('asks the queue for a retry on a RETRYABLE provider error and leaves the item queued', async () => {
    const o = build([{ when: { purpose: 'extract' }, respond: { error: 'overloaded' } }], { id: 'claude' });
    await expect(run(o)).rejects.toBeInstanceOf(TriageRetryError);
    const fresh = env.repos.items.byId(item.id)!;
    expect(fresh.analysis).toBe('queued');
    expect(fresh.errorCode).toBe('CLOUD_UNAVAILABLE');
  });

  it('puts the item back to queued and swallows the run when Pause aborts it', async () => {
    const ac = new AbortController();
    const o = build([{ when: { purpose: 'extract' }, respond: { hang: true } }]);
    const promise = run(o, ac.signal);
    await Promise.resolve();
    ac.abort();
    await expect(promise).resolves.toBeUndefined();
    const fresh = env.repos.items.byId(item.id)!;
    expect(fresh.analysis).toBe('queued');
    expect(env.repos.actions.forItem(item.id)).toHaveLength(0);
  });

  it('aborts the S3 draft on the injected wall clock without leaving the item failed', async () => {
    const o = build([
      { when: { purpose: 'extract' }, respond: { structured: extraction() } },
      { when: { purpose: 'draft' }, respond: { hang: true } },
    ]);
    const promise = run(o);
    // Let S1 + S2 settle so the S3 wall-clock timer is actually armed on the virtual clock before time moves.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await clock.advance(LIMITS.draftWallClockLocalMs);
    await promise;
    expect(env.repos.items.byId(item.id)!.analysis).toBe('queued'); // aborted -> retried later, nothing lost
  });

  it('turns a manipulation abort into a badged card with no draft', async () => {
    const o = build([
      { when: { purpose: 'extract' }, respond: { structured: extraction() } },
      {
        when: { purpose: 'draft' },
        respond: {
          toolCalls: [
            { name: 'create-event', input: { calendarId: 'attacker@example.com' } },
            { name: 'delete-event', input: {} },
          ],
        },
      },
    ]);
    await run(o);
    const fresh = env.repos.items.byId(item.id)!;
    expect(fresh.analysis).toBe('done');
    expect(fresh.badges).toContain('manipulation');
    expect(env.repos.proposals.current(item.id)!.draftText).toBeNull();
    // Not one write action was created, and the blocked-call audit never carries the model-supplied name.
    expect(env.repos.actions.forItem(item.id).map((a) => a.kind)).toEqual(['create_event']);
    expect(env.audits.length).toBeGreaterThan(0);
    for (const a of env.audits) {
      expect(Object.keys(a.detail).sort()).toEqual(['nameLen', 'nameSha8', 'runId', 'verdict']);
      expect(JSON.stringify(a.detail)).not.toContain('create-event');
    }
    expect(env.log.lines.some((l) => l.event === 'triage_manipulation')).toBe(true);
  });

  it('fails the item with LLM_BAD_OUTPUT when the draft loop produces nothing usable', async () => {
    await run(
      build([
        { when: { purpose: 'extract' }, respond: { structured: extraction() } },
        { when: { purpose: 'draft' }, respond: { text: '   ' } },
      ]),
    );
    expect(env.repos.items.byId(item.id)!.analysis).toBe('failed');
    expect(env.repos.items.byId(item.id)!.errorCode).toBe('LLM_BAD_OUTPUT');
  });

  it('retries on a retryable S3 error too', async () => {
    const o = build(
      [
        { when: { purpose: 'extract' }, respond: { structured: extraction() } },
        { when: { purpose: 'draft' }, respond: { error: 'network' } },
      ],
      { id: 'claude' },
    );
    await expect(run(o)).rejects.toBeInstanceOf(TriageRetryError);
  });

  it('detects and persists the reply language, then reuses it on the next run', async () => {
    const hebrew = [{ fromMe: false, text: 'בא לך קפה מחר ב-17:00?', ts: (ANCHOR_MS - 60_000) as EpochMs }];
    await run(
      build(
        [
          { when: { purpose: 'extract' }, respond: { structured: extraction() } },
          { when: { purpose: 'draft' }, respond: { text: 'מעולה, נתראה מחר ב-17:00' } },
        ],
        { messages: hebrew },
      ),
    );
    expect(env.repos.chats.byId(chat.id)!.lang).toBe('he');
    expect(env.repos.proposals.current(item.id)!.replyLang).toBe('he');
    expect(env.repos.items.byId(item.id)!.badges).not.toContain('lang_mismatch');
  });

  it('badges a language switch once the chat already has a language', async () => {
    env.repos.chats.touch(chat.id, { lang: 'he' });
    await run(build());
    expect(env.repos.items.byId(item.id)!.badges).toContain('lang_mismatch');
  });

  it('is a no-op for an unknown chat, a chat with no open item and an item that is not queued', async () => {
    const o = build();
    await o.runChat(99_999, new AbortController().signal);
    expect(llm.calls).toHaveLength(0);

    const empty = seedChat(env.repos, { jid: '972550000009@s.whatsapp.net' });
    await o.runChat(empty.id, new AbortController().signal);
    expect(llm.calls).toHaveLength(0);

    env.repos.items.update(item.id, { analysis: 'held', holdReason: 'paused' }, clock.now());
    await run(o);
    expect(llm.calls).toHaveLength(0);
  });

  it('refuses to run while the card is edit-locked (second line of defence after the queue)', async () => {
    env.repos.items.update(item.id, { editingUntil: (ANCHOR_MS + LIMITS.editLockMs) as EpochMs }, clock.now());
    await run(build());
    expect(llm.calls).toHaveLength(0);
    expect(env.repos.items.byId(item.id)!.analysis).toBe('queued');
  });

  it('notifies only for a FIRST proposal on an open item', async () => {
    await run(build());
    expect(created).toEqual([item.id]);
    created.length = 0;
    env.repos.items.update(item.id, { analysis: 'queued' }, clock.now());
    await run(build());
    expect(env.repos.proposals.current(item.id)!.version).toBe(2);
    expect(created).toEqual([]);
  });

  it('does not notify when the first proposal closed the item', async () => {
    await run(
      build([
        {
          when: { purpose: 'extract' },
          respond: { structured: extraction({ intent: 'smalltalk', needsReply: false }) },
        },
      ]),
    );
    expect(env.repos.items.byId(item.id)!.state).toBe('ignored');
    expect(created).toEqual([]);
  });

  it('anchors the day table and "now" on the trigger timestamp, never on the wall clock', async () => {
    const triggerTs = (ANCHOR_MS - 3 * 3_600_000) as EpochMs;
    env.repos.items.update(item.id, { closedReason: 'dismissed' }, clock.now());
    const anchored = seedOpenItem(env.repos, chat, { triggerTs, triggerMsgId: 'wamid.ANCHOR' });
    await clock.advance(7_200_000); // the wall clock moves; the anchor must not
    await run(build());
    const sent = llm.calls[0]!.messages.map((m) => ('content' in m ? m.content : '')).join('\n');
    expect(sent).toContain(new Date(triggerTs).toISOString());
    expect(env.repos.items.byId(anchored.id)!.analysis).toBe('done');
  });
});
