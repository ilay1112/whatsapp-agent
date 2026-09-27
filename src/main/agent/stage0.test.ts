// src/main/agent/stage0.test.ts - the ordered gate of ARCHITECTURE 6.1 (TESTS 5.3 row `agent/stage0.ts`; owner W1-10).
// Safety-critical file: 100 % lines / 95 % branches. One test per rule, one per precedence pair, plus the visibility rule
// and the `[R2]` cloud release window. Real in-memory app.db + real repos - no repo doubles.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStage0, isNeverTriggerRow, releaseHeldItems, type Stage0Deps, type Stage0Input } from './stage0';
import { isListed } from '../../shared/state';
import { LIMITS, type Chat, type EpochMs, type Item, type Message, type ProviderId } from '../../shared/types';
import type { ErrorCode } from '../../shared/errors';
import { ANCHOR_MS, createTestEnv, seedChat, seedOpenItem, type TestEnv } from '../../../tests/golden/testDb';

const HOUR_MS = 3_600_000;

function message(over: Partial<Message> = {}): Message {
  return {
    rowid: 1,
    waMsgId: 'wamid.T1',
    chatJid: '972550000001@s.whatsapp.net',
    senderUser: '972550000001',
    text: 'hello',
    ts: ANCHOR_MS,
    fromMe: false,
    mediaType: '',
    deleted: false,
    ...over,
  };
}

describe('isNeverTriggerRow', () => {
  it('drops group, status and newsletter JIDs', () => {
    expect(isNeverTriggerRow(message({ chatJid: '120363000000000000@g.us' }))).toBe(true);
    expect(isNeverTriggerRow(message({ chatJid: 'status@broadcast' }))).toBe(true);
  });
  it('drops own messages, reactions, deleted rows and whitespace-only text', () => {
    expect(isNeverTriggerRow(message({ fromMe: true }))).toBe(true);
    expect(isNeverTriggerRow(message({ mediaType: 'reaction' }))).toBe(true);
    expect(isNeverTriggerRow(message({ deleted: true }))).toBe(true);
    expect(isNeverTriggerRow(message({ text: '   \t ' }))).toBe(true);
  });
  it('keeps an inbound DM with text, including an @lid DM', () => {
    expect(isNeverTriggerRow(message())).toBe(false);
    expect(isNeverTriggerRow(message({ chatJid: '112233445566778@lid' }))).toBe(false);
  });
});

describe('createStage0 gate order (ARCHITECTURE 6.1)', () => {
  let env: TestEnv;
  let chat: Chat;
  let paused: boolean;
  let usable: { ok: true } | { ok: false; code: ErrorCode };
  let tokensLeft: number;
  let deps: Stage0Deps;

  const input = (over: Partial<Stage0Input> = {}): Stage0Input => ({
    chat,
    message: message({ chatJid: chat.jid }),
    isLive: true,
    isOlderLive: false,
    hasOpenItem: false,
    nowMs: ANCHOR_MS,
    ...over,
  });

  beforeEach(() => {
    env = createTestEnv();
    chat = seedChat(env.repos, { isKnown: true });
    paused = false;
    usable = { ok: true };
    tokensLeft = 100_000;
    deps = {
      repos: env.repos,
      settings: () => env.settings,
      providerUsable: () => usable,
      paused: () => paused,
      budgets: {
        llmRunsPerChatPerHour: LIMITS.llmRunsPerChatPerHour,
        llmRunsGlobalPerHour: LIMITS.llmRunsGlobalPerHour,
        cloudDailyTokenBudget: () => tokensLeft,
      },
      now: () => ANCHOR_MS,
    };
  });
  afterEach(() => env.dispose());

  it('rule 1: a never-trigger row is dropped', () => {
    expect(createStage0(deps)(input({ message: message({ fromMe: true, chatJid: chat.jid }) }))).toEqual({
      kind: 'drop',
    });
  });

  it('rule 1 beats rule 2: an own backlog row is dropped, not stored as context', () => {
    const verdict = createStage0(deps)(input({ isLive: false, message: message({ fromMe: true, chatJid: chat.jid }) }));
    expect(verdict).toEqual({ kind: 'drop' });
  });

  it('rule 2: a backlog row is context only', () => {
    expect(createStage0(deps)(input({ isLive: false }))).toEqual({ kind: 'context_only' });
  });

  it('rule 2 beats rule 3: a backlog row in a "never" chat is still context only', () => {
    env.repos.chats.setPolicy(chat.id, 'never');
    expect(createStage0(deps)(input({ isLive: false }))).toEqual({ kind: 'context_only' });
  });

  it("rule 3: chat policy 'never' produces no item at all", () => {
    env.repos.chats.setPolicy(chat.id, 'never');
    expect(createStage0(deps)(input())).toEqual({ kind: 'no_item' });
  });

  it('rule 3 re-reads the policy from the DB, not from the caller snapshot', () => {
    env.repos.chats.setPolicy(chat.id, 'never');
    // `chat` is the stale pre-click snapshot; the gate must still see 'never'.
    expect(createStage0(deps)(input({ chat }))).toEqual({ kind: 'no_item' });
  });

  it('rule 3 falls back to the caller snapshot when the chat row is gone', () => {
    const ghost: Chat = { ...chat, id: 99_999 as Chat['id'], policy: 'never' };
    expect(createStage0(deps)(input({ chat: ghost }))).toEqual({ kind: 'no_item' });
  });

  it('rule 4: an unknown sender is held while processUnknownSenders is off', () => {
    const stranger = seedChat(env.repos, { jid: '972550000002@s.whatsapp.net', isKnown: false });
    expect(createStage0(deps)(input({ chat: stranger, message: message({ chatJid: stranger.jid }) }))).toEqual({
      kind: 'held',
      reason: 'unknown_sender',
    });
  });

  it('rule 4: "Analyse this chat" (forceKnown) releases the unknown-sender gate', () => {
    const stranger = seedChat(env.repos, { jid: '972550000002@s.whatsapp.net', isKnown: false });
    env.repos.chats.setForceKnown(stranger.id);
    expect(createStage0(deps)(input({ chat: stranger, message: message({ chatJid: stranger.jid }) }))).toEqual({
      kind: 'queued',
    });
  });

  it('rule 4: the setting alone also releases it', () => {
    const stranger = seedChat(env.repos, { jid: '972550000002@s.whatsapp.net', isKnown: false });
    env.patchSettings((s) => void (s.whatsapp.processUnknownSenders = true));
    expect(createStage0(deps)(input({ chat: stranger, message: message({ chatJid: stranger.jid }) }))).toEqual({
      kind: 'queued',
    });
  });

  it('rule 3 beats rule 4: a "never" unknown chat gets no item rather than a held card', () => {
    const stranger = seedChat(env.repos, { jid: '972550000002@s.whatsapp.net', isKnown: false });
    env.repos.chats.setPolicy(stranger.id, 'never');
    expect(createStage0(deps)(input({ chat: stranger, message: message({ chatJid: stranger.jid }) }))).toEqual({
      kind: 'no_item',
    });
  });

  it('rule 5a: Pause holds the item', () => {
    paused = true;
    expect(createStage0(deps)(input())).toEqual({ kind: 'held', reason: 'paused' });
  });

  it('rule 4 beats rule 5a: an unknown sender is held as unknown_sender even while paused', () => {
    paused = true;
    const stranger = seedChat(env.repos, { jid: '972550000002@s.whatsapp.net', isKnown: false });
    expect(createStage0(deps)(input({ chat: stranger, message: message({ chatJid: stranger.jid }) }))).toEqual({
      kind: 'held',
      reason: 'unknown_sender',
    });
  });

  it('rule 5b: no usable provider holds the item as waiting_llm', () => {
    usable = { ok: false, code: 'LLM_NOT_READY' };
    expect(createStage0(deps)(input())).toEqual({ kind: 'held', reason: 'waiting_llm' });
  });

  it('rule 5a beats rule 5b: Pause wins over a missing provider', () => {
    paused = true;
    usable = { ok: false, code: 'LLM_NOT_READY' };
    expect(createStage0(deps)(input())).toEqual({ kind: 'held', reason: 'paused' });
  });

  it('rule 5b: a cloud provider without a CURRENT consent record is held (defence in depth)', () => {
    env.patchSettings((s) => void (s.llm.provider = 'claude'));
    expect(createStage0(deps)(input())).toEqual({ kind: 'held', reason: 'waiting_llm' });
    env.repos.consents.accept('cloud_claude', 1, ANCHOR_MS);
    expect(createStage0(deps)(input())).toEqual({ kind: 'queued' });
  });

  it('rule 5b: the gemini consent is checked for the gemini provider', () => {
    env.patchSettings((s) => void (s.llm.provider = 'gemini'));
    env.repos.consents.accept('cloud_claude', 1, ANCHOR_MS); // the wrong consent does not help
    expect(createStage0(deps)(input())).toEqual({ kind: 'held', reason: 'waiting_llm' });
    env.repos.consents.accept('cloud_gemini', 1, ANCHOR_MS);
    expect(createStage0(deps)(input())).toEqual({ kind: 'queued' });
  });

  it('rule 5c: the per-chat hourly LLM budget holds the item', () => {
    for (let i = 0; i < LIMITS.llmRunsPerChatPerHour; i++)
      env.repos.rate.record('llm_chat', String(chat.id), ANCHOR_MS - i * 1000);
    expect(createStage0(deps)(input())).toEqual({ kind: 'held', reason: 'budget' });
  });

  it('rule 5c: runs older than an hour do not count', () => {
    for (let i = 0; i < LIMITS.llmRunsPerChatPerHour; i++)
      env.repos.rate.record('llm_chat', String(chat.id), ANCHOR_MS - HOUR_MS - 1000);
    expect(createStage0(deps)(input())).toEqual({ kind: 'queued' });
  });

  it('rule 5c: the global hourly budget holds the item', () => {
    for (let i = 0; i < LIMITS.llmRunsGlobalPerHour; i++)
      env.repos.rate.record('llm_global', 'global', ANCHOR_MS - i * 1000);
    expect(createStage0(deps)(input())).toEqual({ kind: 'held', reason: 'budget' });
  });

  it('rule 5c: an exhausted cloud daily token budget holds the item, and never applies to Local', () => {
    tokensLeft = 0;
    expect(createStage0(deps)(input())).toEqual({ kind: 'queued' }); // provider 'local': no token budget
    env.patchSettings((s) => void (s.llm.provider = 'claude'));
    env.repos.consents.accept('cloud_claude', 1, ANCHOR_MS);
    expect(createStage0(deps)(input())).toEqual({ kind: 'held', reason: 'budget' });
    tokensLeft = 1;
    expect(createStage0(deps)(input())).toEqual({ kind: 'queued' });
  });

  it('rule 6: an edit-locked open item defers the run instead of dropping it', () => {
    const item = seedOpenItem(env.repos, chat);
    const until = (ANCHOR_MS + LIMITS.editLockMs) as EpochMs;
    env.repos.items.update(item.id, { editingUntil: until }, ANCHOR_MS);
    expect(createStage0(deps)(input({ hasOpenItem: true }))).toEqual({ kind: 'deferred', until });
  });

  it('rule 6: an expired edit lock does not defer', () => {
    const item = seedOpenItem(env.repos, chat);
    env.repos.items.update(item.id, { editingUntil: (ANCHOR_MS - 1) as EpochMs }, ANCHOR_MS);
    expect(createStage0(deps)(input({ hasOpenItem: true }))).toEqual({ kind: 'queued' });
  });

  it('rule 6: hasOpenItem with no open row in the DB does not defer', () => {
    expect(createStage0(deps)(input({ hasOpenItem: true }))).toEqual({ kind: 'queued' });
  });

  it('rule 5c beats rule 6: a budget hold wins over the edit lock', () => {
    const item = seedOpenItem(env.repos, chat);
    env.repos.items.update(item.id, { editingUntil: (ANCHOR_MS + LIMITS.editLockMs) as EpochMs }, ANCHOR_MS);
    for (let i = 0; i < LIMITS.llmRunsPerChatPerHour; i++)
      env.repos.rate.record('llm_chat', String(chat.id), ANCHOR_MS);
    expect(createStage0(deps)(input({ hasOpenItem: true }))).toEqual({ kind: 'held', reason: 'budget' });
  });

  it('rule 7: an ordinary inbound DM is queued', () => {
    expect(createStage0(deps)(input())).toEqual({ kind: 'queued' });
  });

  it('falls back to deps.now() when the caller passes a non-finite nowMs', () => {
    for (let i = 0; i < LIMITS.llmRunsPerChatPerHour; i++)
      env.repos.rate.record('llm_chat', String(chat.id), ANCHOR_MS);
    expect(createStage0(deps)(input({ nowMs: Number.NaN as EpochMs }))).toEqual({ kind: 'held', reason: 'budget' });
  });

  it('visibility rule: queued and running items are not listed; held and failed are', () => {
    expect(isListed('queued')).toBe(false);
    expect(isListed('running')).toBe(false);
    expect(isListed('held')).toBe(true);
    expect(isListed('failed')).toBe(true);
    expect(isListed('done')).toBe(true);
  });
});

describe('releaseHeldItems ([R2] cloud release window)', () => {
  let env: TestEnv;
  let chatA: Chat;
  let chatB: Chat;
  let fresh: Item;
  let stale: Item;

  const held = (item: Item): void => {
    env.repos.items.update(
      item.id,
      { analysis: 'held', holdReason: 'waiting_llm', errorCode: 'LLM_NOT_READY' },
      ANCHOR_MS,
    );
  };
  const release = (provider: ProviderId): number[] => releaseHeldItems(env.repos, { provider, now: ANCHOR_MS });

  beforeEach(() => {
    env = createTestEnv();
    chatA = seedChat(env.repos, { jid: '972550000001@s.whatsapp.net' });
    chatB = seedChat(env.repos, { jid: '972550000002@s.whatsapp.net' });
    stale = seedOpenItem(env.repos, chatA, { triggerTs: (ANCHOR_MS - LIMITS.heldReleaseWindowMs - 60_000) as EpochMs });
    fresh = seedOpenItem(env.repos, chatB, { triggerTs: (ANCHOR_MS - 60_000) as EpochMs });
    held(stale);
    held(fresh);
  });
  afterEach(() => env.dispose());

  it('releases EVERY held item to the Local provider and enqueues each chat once', () => {
    const released = release('local');
    expect(new Set(released)).toEqual(new Set([stale.id, fresh.id]));
    for (const id of released) {
      const row = env.repos.items.byId(id)!;
      expect(row.analysis).toBe('queued');
      expect(row.holdReason).toBeNull();
      expect(row.errorCode).toBeNull();
    }
    expect(env.repos.queue.size()).toBe(2);
  });

  it('releases only items inside LIMITS.heldReleaseWindowMs to a CLOUD provider', () => {
    const released = release('claude');
    expect(released).toEqual([fresh.id]);
    expect(env.repos.items.byId(stale.id)!.analysis).toBe('held');
    expect(env.repos.items.byId(stale.id)!.holdReason).toBe('waiting_llm');
    expect(env.repos.queue.size()).toBe(1);
  });

  it('gemini uses the same window as claude', () => {
    expect(release('gemini')).toEqual([fresh.id]);
  });

  it('is a no-op when nothing is held', () => {
    release('local');
    env.repos.queue.remove(chatA.id);
    env.repos.queue.remove(chatB.id);
    expect(release('local')).toEqual([]);
    expect(env.repos.queue.size()).toBe(0);
  });

  it('enqueues a chat only once even when it holds several items', () => {
    // Two held items in the same chat can only exist once the first one closed, so close it first.
    env.repos.items.update(fresh.id, { closedReason: 'dismissed' }, ANCHOR_MS);
    const second = seedOpenItem(env.repos, chatB, {
      triggerTs: (ANCHOR_MS - 30_000) as EpochMs,
      triggerMsgId: 'wamid.T2',
    });
    held(second);
    const released = release('local');
    expect(released.length).toBe(3);
    expect(env.repos.queue.size()).toBe(2); // chatA + chatB, not 3 rows
  });
});
