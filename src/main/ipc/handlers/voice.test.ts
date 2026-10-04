// src/main/ipc/handlers/voice.test.ts - owner V2-W1-07-media-voice. C2 8 voice channels: getState passes the service state through,
// selfTest returns only {ok, secPerAudioSec}, retry maps the service refusal to its ErrorCode and otherwise answers the item detail.
import { describe, expect, it, vi } from 'vitest';
import type { ItemDetail, ItemId, VoiceState } from '../../../shared/types';
import type { HandlerDepsV2 } from '../register';
import { createVoiceHandlers, VOICE_SELF_TEST_TIMEOUT_MS } from './voice';

const STATE: VoiceState = {
  enabled: true,
  tier: 'auto',
  resolvedTier: 'voice-hebrew',
  model: { id: 'voice-hebrew', sizeBytes: 1, status: 'ready', bytesDone: 1 },
  vad: { status: 'ready' },
  secPerAudioSec: 0.4,
  suggestLite: false,
};

function deps(over: Partial<HandlerDepsV2['voice']> = {}) {
  const voice = {
    state: vi.fn(() => STATE),
    selfTest: vi.fn(async () => ({ ok: true, secPerAudioSec: 0.4, extra: 'never leaves main' })),
    retry: vi.fn(async () => ({ ok: true as const })),
    ...over,
  };
  const detail = vi.fn(() => ({ ok: true as const, value: { item: { id: 7 } } as unknown as ItemDetail }));
  return { d: { voice, items: { detail } } as unknown as HandlerDepsV2, voice, detail };
}
const ctx = {} as never;

describe('createVoiceHandlers', () => {
  it('voice:getState returns the service state', async () => {
    const { d } = deps();
    await expect(Promise.resolve(createVoiceHandlers(d)['voice:getState']({} as never, ctx))).resolves.toEqual({
      ok: true,
      value: STATE,
    });
  });

  it('voice:selfTest passes a bounded signal and returns exactly {ok, secPerAudioSec}', async () => {
    const { d, voice } = deps();
    await expect(createVoiceHandlers(d)['voice:selfTest']({} as never, ctx)).resolves.toEqual({
      ok: true,
      value: { ok: true, secPerAudioSec: 0.4 },
    });
    expect((voice.selfTest as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(VOICE_SELF_TEST_TIMEOUT_MS).toBeGreaterThan(300_000);
  });

  it('voice:retry: a refusal maps to its code; success answers the item detail', async () => {
    const refused = deps({ retry: vi.fn(async () => ({ ok: false as const, code: 'BAD_REQUEST' as const })) });
    await expect(createVoiceHandlers(refused.d)['voice:retry']({ itemId: 7 as ItemId }, ctx)).resolves.toEqual({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    });
    expect(refused.detail).not.toHaveBeenCalled();
    const { d, voice, detail } = deps();
    await expect(createVoiceHandlers(d)['voice:retry']({ itemId: 7 as ItemId }, ctx)).resolves.toMatchObject({
      ok: true,
    });
    expect(voice.retry).toHaveBeenCalledWith(7);
    expect(detail).toHaveBeenCalledWith(7);
  });
});
