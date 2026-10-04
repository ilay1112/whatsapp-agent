// src/main/agent/stage0.repairs.test.ts - v2-repair-v2-main-defects REQUEST 7 (S0 part, B13 / P2 9): a provider whose subscription
// window is exhausted (usable() = CLOUD_QUOTA) holds a live chat as budget with the code CLOUD_QUOTA; releaseQuotaHeldItems() releases
// exactly those holds (never a v1 budget hold, never a waiting_llm hold). Real in-memory app.db + real repos.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStage0, releaseQuotaHeldItems, type Stage0Deps } from './stage0';
import { LIMITS, type Chat, type EpochMs, type Message } from '../../shared/types';
import type { ErrorCode } from '../../shared/errors';
import { ANCHOR_MS, createTestEnv, seedChat, seedOpenItem, type TestEnv } from '../../../tests/golden/testDb';

function message(jid: string): Message {
  return {
    rowid: 1,
    waMsgId: 'wamid.Q1',
    chatJid: jid,
    senderUser: '972550000001',
    text: 'coffee Thursday at 5?',
    ts: ANCHOR_MS,
    fromMe: false,
    mediaType: '',
    deleted: false,
  };
}

describe('S0 under an exhausted subscription window', () => {
  let env: TestEnv;
  let chat: Chat;
  let usable: { ok: true } | { ok: false; code: ErrorCode };
  let deps: Stage0Deps;
  beforeEach(() => {
    env = createTestEnv();
    chat = seedChat(env.repos, { isKnown: true });
    usable = { ok: true };
    deps = {
      repos: env.repos,
      settings: () => env.settings,
      providerUsable: () => usable,
      paused: () => false,
      budgets: {
        llmRunsPerChatPerHour: LIMITS.llmRunsPerChatPerHour,
        llmRunsGlobalPerHour: LIMITS.llmRunsGlobalPerHour,
        cloudDailyTokenBudget: () => 100_000,
      },
      now: () => ANCHOR_MS,
    };
  });
  afterEach(() => env.dispose());

  const verdict = () =>
    createStage0(deps)({
      chat,
      message: message(chat.jid),
      isLive: true,
      isOlderLive: false,
      hasOpenItem: false,
      nowMs: ANCHOR_MS,
    });

  it('CLOUD_QUOTA => held budget with the code; any other unusable code => held waiting_llm (unchanged)', () => {
    usable = { ok: false, code: 'CLOUD_QUOTA' };
    expect(verdict()).toEqual({ kind: 'held', reason: 'budget', code: 'CLOUD_QUOTA' });
    for (const code of ['CLOUD_OVERAGE', 'CLI_TOOLSET_MISMATCH', 'LLM_NOT_READY', 'CLI_UNSTABLE'] as ErrorCode[]) {
      usable = { ok: false, code };
      expect(verdict()).toEqual({ kind: 'held', reason: 'waiting_llm' });
    }
    usable = { ok: true };
    expect(verdict()).toEqual({ kind: 'queued' });
  });

  it('a paused agent still wins over the quota hold (gate order)', () => {
    usable = { ok: false, code: 'CLOUD_QUOTA' };
    expect(
      createStage0({ ...deps, paused: () => true })({
        chat,
        message: message(chat.jid),
        isLive: true,
        isOlderLive: false,
        hasOpenItem: false,
        nowMs: ANCHOR_MS,
      }),
    ).toEqual({ kind: 'held', reason: 'paused' });
  });
});

describe('releaseQuotaHeldItems', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = createTestEnv();
  });
  afterEach(() => env.dispose());

  it('releases only held/budget items carrying CLOUD_QUOTA, oldest first, one queue row per chat', () => {
    const a = seedChat(env.repos, { jid: '972550000001@s.whatsapp.net' });
    const b = seedChat(env.repos, { jid: '972550000002@s.whatsapp.net' });
    const c = seedChat(env.repos, { jid: '972550000003@s.whatsapp.net' });
    const quotaA = seedOpenItem(env.repos, a, { triggerTs: (ANCHOR_MS - 60_000) as EpochMs });
    const v1Budget = seedOpenItem(env.repos, b, { triggerTs: (ANCHOR_MS - 50_000) as EpochMs });
    const waiting = seedOpenItem(env.repos, c, { triggerTs: (ANCHOR_MS - 40_000) as EpochMs });
    env.repos.items.update(quotaA.id, { analysis: 'held', holdReason: 'budget', errorCode: 'CLOUD_QUOTA' }, ANCHOR_MS);
    env.repos.items.update(v1Budget.id, { analysis: 'held', holdReason: 'budget', errorCode: null }, ANCHOR_MS);
    env.repos.items.update(
      waiting.id,
      { analysis: 'held', holdReason: 'waiting_llm', errorCode: 'CLOUD_QUOTA' },
      ANCHOR_MS,
    );

    expect(releaseQuotaHeldItems(env.repos, ANCHOR_MS)).toEqual([quotaA.id]);
    expect(env.repos.items.byId(quotaA.id)).toMatchObject({ analysis: 'queued', holdReason: null, errorCode: null });
    expect(env.repos.items.byId(v1Budget.id)).toMatchObject({ analysis: 'held', holdReason: 'budget' });
    expect(env.repos.items.byId(waiting.id)).toMatchObject({ analysis: 'held', holdReason: 'waiting_llm' });
    expect(env.repos.queue.size()).toBe(1);
    expect(releaseQuotaHeldItems(env.repos, ANCHOR_MS)).toEqual([]);
  });
});
