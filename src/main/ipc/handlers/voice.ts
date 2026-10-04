// src/main/ipc/handlers/voice.ts   ADD (C2 8 voice channels; v2-build-plan 3 createVoiceHandlers) - owner V2-W1-07-media-voice.
// Bodies return Result<T> and never throw on a per-call failure. No channel takes a path, a JID or a message id: voice:retry takes an
// item id only; the transcript row it clears is found in main from that item's trigger.
import type { IpcHandlers } from '../../../shared/ipc';
import { fail, ok, type HandlerDepsV2 } from '../register';

export type VoiceChannels = 'voice:getState' | 'voice:selfTest' | 'voice:retry';

/** voice:selfTest wall clock: the 5 s bundled note under the longest job timeout (LIMITS.voiceJobMaxMs) plus model load margin. */
export const VOICE_SELF_TEST_TIMEOUT_MS = 330_000;

export function createVoiceHandlers(deps: HandlerDepsV2): Pick<IpcHandlers, VoiceChannels> {
  return {
    'voice:getState': () => ok(deps.voice.state()),

    'voice:selfTest': async () => {
      const r = await deps.voice.selfTest(AbortSignal.timeout(VOICE_SELF_TEST_TIMEOUT_MS));
      return ok({ ok: r.ok, secPerAudioSec: r.secPerAudioSec });
    },

    'voice:retry': async (req) => {
      const r = await deps.voice.retry(req.itemId);
      if (!r.ok) return fail(r.code);
      return deps.items.detail(req.itemId);
    },
  };
}
