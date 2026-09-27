// Scratch verification of review finding `correctness-pipeline-6` (skeptic pass). Read-only w.r.t. the product code:
// it drives the REAL orchestrator + real repos + real in-memory db, and only wraps the stub provider so the "user clicks
// Dismiss" happens exactly while S3 is awaiting the model. Nothing here sends anything (approval-first: pending only).
import { afterEach, describe, expect, it } from 'vitest';
import { createOrchestrator } from '../../../src/main/agent/orchestrator.ts';
import type { LlmProvider, ProviderFactory } from '../../../src/main/llm/types.ts';
import type { Chat, EpochMs, Item } from '../../../src/shared/types.ts';
import type { Extraction } from '../../../src/shared/schemas.ts';
import { StubLlm, type StubRule } from '../../../tests/fakes/stub-llm.ts';
import { createSeededRandom, createVirtualClock } from '../../../tests/helpers/virtualClock.ts';
import {
  ANCHOR_MS,
  createIngestDouble,
  createTestEnv,
  messagesFrom,
  seedChat,
  seedOpenItem,
  type TestEnv,
} from '../../../tests/golden/testDb.ts';

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

const RULES: StubRule[] = [
  { when: { purpose: 'extract' }, respond: { structured: { ...EXTRACTION } as unknown as Record<string, unknown> } },
  { when: { purpose: 'draft' }, respond: { text: 'Tomorrow at 17:00 works for me' } },
];

let env: TestEnv;
afterEach(() => env.dispose());

describe('correctness-pipeline-6 end-to-end through the real orchestrator', () => {
  it('a Dismiss that lands while S3 is in flight is undone by S4 (stale item snapshot)', async () => {
    env = createTestEnv({ calendarConnected: true });
    const clock = createVirtualClock(ANCHOR_MS);
    const chat: Chat = seedChat(env.repos);
    const item: Item = seedOpenItem(env.repos, chat);

    const stub = new StubLlm({ rules: RULES, id: 'local', model: 'stub-model', clock });
    let dismissedAt: EpochMs | null = null;
    // The user clicks Dismiss while the draft call is awaiting: byte-for-byte what ItemService.dismiss() does.
    const provider: LlmProvider = {
      id: stub.id,
      model: stub.model,
      structured: (m, s, o) => stub.structured(m, s, o),
      chat: async (m, t, o) => {
        if (dismissedAt === null) {
          dismissedAt = clock.now();
          env.repos.db.transaction(() => {
            env.repos.actions.supersedePending(item.id, dismissedAt!);
            env.repos.items.update(item.id, { closedReason: 'dismissed' }, dismissedAt!);
          });
        }
        return stub.chat(m, t, o);
      },
      validate: (sig) => stub.validate(sig),
      dispose: () => stub.dispose(),
    };
    const providers: ProviderFactory = {
      get: () => Promise.resolve(provider),
      usable: () => ({ ok: true }),
      invalidate: () => Promise.resolve(),
    };

    const orchestrator = createOrchestrator({
      repos: env.repos,
      providers,
      gate: env.gate,
      ingest: createIngestDouble(
        messagesFrom(chat.jid, [{ fromMe: false, text: 'coffee tomorrow at 17:00?', ts: (ANCHOR_MS - 60_000) as EpochMs }]),
      ),
      settings: () => env.settings,
      clock,
      random: createSeededRandom(),
      log: env.log,
      notifyChanged: () => {},
    });

    // Mid-run state, for the record: the card really is dismissed before S4 runs.
    await orchestrator.runChat(chat.id, new AbortController().signal);
    expect(dismissedAt).not.toBeNull();

    const fresh = env.repos.items.byId(item.id)!;
    const pending = env.repos.actions.forItem(item.id).filter((a) => a.state === 'pending');
    // eslint-disable-next-line no-console
    console.log('AFTER RUN:', {
      state: fresh.state,
      closedReason: fresh.closedReason,
      closedAt: fresh.closedAt,
      replyState: fresh.replyState,
      eventState: fresh.eventState,
      pendingKinds: pending.map((a) => a.kind),
    });

    // What the finding predicts:
    expect(fresh.closedReason).toBeNull();
    expect(fresh.closedAt).toBeNull();
    expect(fresh.state).toBe('needs_reply');
    expect(pending.map((a) => a.kind)).toContain('send_reply');
  });

  it('an event created by exec mid-run is read back at its pre-run value (eventState regression)', async () => {
    env = createTestEnv({ calendarConnected: true });
    const clock = createVirtualClock(ANCHOR_MS);
    const chat: Chat = seedChat(env.repos);
    const item: Item = seedOpenItem(env.repos, chat);

    const stub = new StubLlm({ rules: RULES, id: 'local', model: 'stub-model', clock });
    let applied = false;
    const provider: LlmProvider = {
      id: stub.id,
      model: stub.model,
      structured: (m, s, o) => stub.structured(m, s, o),
      chat: async (m, t, o) => {
        if (!applied) {
          applied = true;
          // Exactly what exec/outcome.ts applyCreateSuccess writes after a CONFIRMED calendar write.
          env.repos.items.update(
            item.id,
            {
              eventState: 'created',
              errorCode: null,
              calendarEventId: 'evt-1',
              calendarHtmlLink: 'https://example.invalid/e',
              eventStartTs: (ANCHOR_MS + 86_400_000) as EpochMs,
            },
            clock.now(),
          );
        }
        return stub.chat(m, t, o);
      },
      validate: (sig) => stub.validate(sig),
      dispose: () => stub.dispose(),
    };
    const providers: ProviderFactory = {
      get: () => Promise.resolve(provider),
      usable: () => ({ ok: true }),
      invalidate: () => Promise.resolve(),
    };

    const orchestrator = createOrchestrator({
      repos: env.repos,
      providers,
      gate: env.gate,
      ingest: createIngestDouble(
        messagesFrom(chat.jid, [{ fromMe: false, text: 'coffee tomorrow at 17:00?', ts: (ANCHOR_MS - 60_000) as EpochMs }]),
      ),
      settings: () => env.settings,
      clock,
      random: createSeededRandom(),
      log: env.log,
      notifyChanged: () => {},
    });

    await orchestrator.runChat(chat.id, new AbortController().signal);
    const fresh = env.repos.items.byId(item.id)!;
    const pending = env.repos.actions.forItem(item.id).filter((a) => a.state === 'pending');
    // eslint-disable-next-line no-console
    console.log('AFTER RUN 2:', {
      state: fresh.state,
      eventState: fresh.eventState,
      calendarEventId: fresh.calendarEventId,
      pendingKinds: pending.map((a) => a.kind),
    });
    expect(fresh.eventState).toBe('proposed');
    expect(pending.map((a) => a.kind)).toContain('create_event');
  });
});
