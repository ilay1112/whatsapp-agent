// SCRATCH - refutation attempt for review finding data-integrity-7. NOT part of the product suite; no product file is touched.
// Run: npx vitest run --config ops/agent-notes/verify-data-integrity-7.scratch/vitest.scratch.config.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOrchestrator } from '../../../src/main/agent/orchestrator';
import { StubLlm } from '../../../tests/fakes/stub-llm';
import { createSeededRandom, createVirtualClock, type VirtualClock } from '../../../tests/helpers/virtualClock';
import { ANCHOR_MS, createIngestDouble, createTestEnv, messagesFrom, seedChat, type TestEnv } from '../../../tests/golden/testDb';
import { LIMITS, type EpochMs, type Chat } from '../../../src/shared/types';
import type { LlmProvider, ProviderFactory } from '../../../src/main/llm/types';

const DAY = 24 * 3600_000;

describe('data-integrity-7 | can retention blank the text of an OPEN older_message card?', () => {
  let env: TestEnv;
  let clock: VirtualClock;
  let chat: Chat;
  beforeEach(() => {
    env = createTestEnv({ calendarConnected: true });
    clock = createVirtualClock(ANCHOR_MS);
    chat = seedChat(env.repos);
  });
  afterEach(() => env.dispose());

  /** The card ingest.ts actually creates for a row older than LIMITS.ingestMaxAgeMs: analysis 'held', badge older_message, NO run. */
  const seedOlderCard = (): { itemId: number; oldTs: EpochMs } => {
    const oldTs = (ANCHOR_MS - 8 * DAY) as EpochMs;
    const item = env.repos.items.createOpen({
      chatId: chat.id,
      triggerMsgId: 'wamid.OLD',
      triggerTs: oldTs,
      analysis: 'held',
      holdReason: null,
      now: ANCHOR_MS,
    });
    env.repos.items.update(item.id, { badges: ['older_message'] }, ANCHOR_MS);
    return { itemId: item.id, oldTs };
  };

  it('A. the older card has NO item_messages row at all, so retention has nothing to null', () => {
    const { itemId } = seedOlderCard();
    expect(env.repos.items.byId(itemId)!.state).toBe('needs_reply');
    expect(env.repos.items.messages(itemId)).toEqual([]); // trigger text is null from birth, before any purge
    const res = env.repos.retention.purge({ before: (ANCHOR_MS - 7 * DAY) as EpochMs, closedBefore: (ANCHOR_MS - 90 * DAY) as EpochMs });
    expect(res.textRows).toBe(0);
    expect(env.repos.items.messages(itemId)).toEqual([]);
  });

  it('B. the orchestrator refuses to run a held item, so snapshotMessages (its only production caller) never fires', async () => {
    const { itemId } = seedOlderCard();
    let providerCalls = 0;
    const llm = new StubLlm({ rules: [], id: 'local', model: 'stub-model', clock });
    const providers: ProviderFactory = {
      get: () => {
        providerCalls += 1;
        return Promise.resolve(llm as LlmProvider);
      },
      usable: () => ({ ok: true }),
      invalidate: () => Promise.resolve(),
    };
    const o = createOrchestrator({
      repos: env.repos,
      providers,
      gate: env.gate,
      ingest: createIngestDouble(messagesFrom(chat.jid, [{ fromMe: false, text: 'coffee?', ts: (ANCHOR_MS - 8 * DAY) as EpochMs }])),
      settings: () => env.settings,
      clock,
      random: createSeededRandom(),
      log: env.log,
      notifyChanged: () => {},
      onItemCreated: () => {},
    });
    await o.runChat(chat.id, new AbortController().signal);
    expect(providerCalls).toBe(0);
    expect(env.repos.items.messages(itemId)).toEqual([]);
    expect(env.repos.runs.forItem?.(itemId) ?? []).toEqual([]);
  });

  it('C. the older card has ZERO remaining TTL: expireOld() closes it at once (trigger_ts already past openItemTtlMs)', () => {
    const { itemId } = seedOlderCard();
    expect(LIMITS.openItemTtlMs).toBe(LIMITS.ingestMaxAgeMs); // 7 d == 7 d: 'older' implies 'already expirable'
    expect(env.repos.items.expireOld(ANCHOR_MS as EpochMs)).toBe(1);
    const closed = env.repos.items.byId(itemId)!;
    expect(closed.closedReason).toBe('expired');
    expect(closed.state).not.toBe('needs_reply');
  });

  it('D. with the DEFAULT retentionDays (30) no open card can ever reach the purge cutoff', () => {
    expect(env.settings.privacy.retentionDays).toBe(30);
    expect(LIMITS.openItemTtlMs).toBeLessThan(env.settings.privacy.retentionDays * DAY);
  });
});
