// src/main/agent/stage0.v2.test.ts - owner V2-W1-07-media-voice (the stage0.ts v2 deltas, P2 2): a voice note is a live trigger only
// when voice is on and its model + VAD are ready, else held/waiting_llm; a caption-less picture triggers only while images are on,
// else context only; the earlier gates (stranger, pause, provider) still come first; video/document/sticker keep the v1 rule.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStage0, isNeverTriggerRow, type Stage0Deps, type Stage0Input } from './stage0';
import { LIMITS, type Chat, type Message } from '../../shared/types';
import { ANCHOR_MS, createTestEnv, seedChat, type TestEnv } from '../../../tests/golden/testDb';

function message(over: Partial<Message> = {}): Message {
  return {
    rowid: 1,
    waMsgId: 'wamid.V1',
    chatJid: '972550000001@s.whatsapp.net',
    senderUser: '972550000001',
    text: '',
    ts: ANCHOR_MS,
    fromMe: false,
    mediaType: 'audio',
    deleted: false,
    ...over,
  };
}

describe('isNeverTriggerRow v2', () => {
  it('inbound audio / image rows are not "empty"; own ones, video, sticker and document without a caption still are', () => {
    expect(isNeverTriggerRow(message())).toBe(false);
    expect(isNeverTriggerRow(message({ mediaType: 'image' }))).toBe(false);
    expect(isNeverTriggerRow(message({ fromMe: true }))).toBe(true);
    for (const t of ['video', 'sticker', 'document']) expect(isNeverTriggerRow(message({ mediaType: t }))).toBe(true);
    expect(isNeverTriggerRow(message({ mediaType: 'video', text: 'see this Thursday' }))).toBe(false); // v1: a caption triggers
  });
});

describe('createStage0 v2 media gates', () => {
  let env: TestEnv;
  let chat: Chat;
  let voiceReady: boolean;
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
  const setVoice = (enabled: boolean): void => {
    env.settings = { ...env.settings, voice: { ...env.settings.voice, enabled } };
  };
  const setImages = (enabled: boolean): void => {
    env.settings = { ...env.settings, images: { ...env.settings.images, enabled } };
  };

  beforeEach(() => {
    env = createTestEnv();
    chat = seedChat(env.repos, { isKnown: true });
    voiceReady = true;
    deps = {
      repos: env.repos,
      settings: () => env.settings,
      providerUsable: () => ({ ok: true }),
      paused: () => false,
      budgets: {
        llmRunsPerChatPerHour: LIMITS.llmRunsPerChatPerHour,
        llmRunsGlobalPerHour: LIMITS.llmRunsGlobalPerHour,
        cloudDailyTokenBudget: () => 1_000_000,
      },
      now: () => ANCHOR_MS,
      voiceReady: () => voiceReady,
    };
  });
  afterEach(() => env.dispose());

  it('voice on + model ready => queued', () => {
    setVoice(true);
    expect(createStage0(deps)(input())).toEqual({ kind: 'queued' });
  });

  it('voice off, model not ready, or no readiness probe wired => held/waiting_llm ("Voice message" raw card)', () => {
    setVoice(false);
    expect(createStage0(deps)(input())).toEqual({ kind: 'held', reason: 'waiting_llm' });
    setVoice(true);
    voiceReady = false;
    expect(createStage0(deps)(input())).toEqual({ kind: 'held', reason: 'waiting_llm' });
    const { voiceReady: _unused, ...unwired } = deps;
    expect(createStage0(unwired)(input())).toEqual({ kind: 'held', reason: 'waiting_llm' });
  });

  it("a stranger's voice note is held unknown_sender BEFORE any voice check (no whisper job for strangers)", () => {
    setVoice(true);
    const stranger = seedChat(env.repos, { isKnown: false, jid: '972550000009@s.whatsapp.net' });
    expect(createStage0(deps)(input({ chat: stranger, message: message({ chatJid: stranger.jid }) }))).toEqual({
      kind: 'held',
      reason: 'unknown_sender',
    });
  });

  it('a caption-less picture: images on => queued; images off => context only; a captioned one triggers as text either way', () => {
    setImages(true);
    expect(createStage0(deps)(input({ message: message({ chatJid: chat.jid, mediaType: 'image' }) }))).toEqual({
      kind: 'queued',
    });
    setImages(false);
    expect(createStage0(deps)(input({ message: message({ chatJid: chat.jid, mediaType: 'image' }) }))).toEqual({
      kind: 'context_only',
    });
    expect(
      createStage0(deps)(
        input({ message: message({ chatJid: chat.jid, mediaType: 'image', text: 'party Friday 8pm' }) }),
      ),
    ).toEqual({
      kind: 'queued',
    });
  });

  it('a backlog voice note stays context only', () => {
    setVoice(true);
    expect(createStage0(deps)(input({ isLive: false }))).toEqual({ kind: 'context_only' });
  });
});
