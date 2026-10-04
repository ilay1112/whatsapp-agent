// src/main/voice/decode.ts   ADD (C2 13) - owner V2-W1-07-media-voice.
// D-070: opus-decoder@0.7.12 (MIT, WASM embedded as a string; no native addon, no Worker at import - U-V1 probe). The decoder is reached
// only through the S-OPUS seam (`OpusDecoderFactory`, deps.ts): production uses the real package, two unit tests inject a throwing one.
// Input = the packets voice/ogg.ts already demuxed and bounded (I12: Ogg pages never reach native code; Opus is decoded by WASM).
// Output = a 16 kHz mono PCM16 WAV written by voice/wav.ts - the ONLY thing whisper-cli ever reads.
import { OpusDecoder } from 'opus-decoder';
import type { OpusDecoderFactory, OpusFrameDecoder } from '../deps';
import type { OggOpusInfo } from './ogg';
import { encodeWavPcm16, WAV_SAMPLE_RATE } from './wav';

/** P2 3.2 step 3: decode wall clock 20 s => VOICE_DECODE_FAILED. */
export const DECODE_WALL_CLOCK_MS = 20_000;
/** Packets decoded between two abort / wall-clock checks (and one event-loop yield). */
export const DECODE_BATCH = 500;

/** A structural or decoder failure of one note. `code` is the only thing that leaves this module (no bytes, no text). */
export class VoiceDecodeError extends Error {
  readonly code = 'VOICE_DECODE_FAILED' as const;
  constructor(readonly reason: 'decoder_init' | 'decoder_errors' | 'no_audio' | 'wall_clock' | 'bad_input') {
    super(`voice_decode_failed:${reason}`);
  }
}

/** S-OPUS production value: the real opus-decoder, decoding straight to 16 kHz (libopus resamples internally, 48 -> 16 kHz). */
export const realOpusDecoderFactory: OpusDecoderFactory = (opts) => {
  const d = new OpusDecoder({ channels: opts.channels, preSkip: opts.preSkip, sampleRate: opts.sampleRate });
  const adapter: OpusFrameDecoder = {
    ready: d.ready,
    decodeFrame: (frame) => {
      const r = d.decodeFrame(frame);
      return {
        channelData: r.channelData,
        samplesDecoded: r.samplesDecoded,
        sampleRate: r.sampleRate,
        errors: r.errors,
      };
    },
    free: () => d.free(),
  };
  return adapter;
};

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError');
}

/** Factory form (S-OPUS + an injectable clock for the wall-clock test). */
export function createWavDecoder(
  factory: OpusDecoderFactory,
  now: () => number = () => Date.now(),
): (packets: Uint8Array[], info: OggOpusInfo, signal: AbortSignal) => Promise<Uint8Array> {
  return async (packets, info, signal) => {
    if (signal.aborted) throw abortError(signal);
    if (packets.length === 0 || (info.channels !== 1 && info.channels !== 2)) throw new VoiceDecodeError('bad_input');
    const started = now();
    let decoder: OpusFrameDecoder;
    try {
      decoder = factory({ channels: info.channels, preSkip: info.preSkip, sampleRate: WAV_SAMPLE_RATE });
      await decoder.ready;
    } catch {
      throw new VoiceDecodeError('decoder_init');
    }
    try {
      const chunks: Float32Array[] = [];
      let total = 0;
      let failedFrames = 0;
      for (let i = 0; i < packets.length; i += 1) {
        if (i % DECODE_BATCH === 0 && i > 0) {
          await yieldToLoop();
          if (signal.aborted) throw abortError(signal);
          if (now() - started > DECODE_WALL_CLOCK_MS) throw new VoiceDecodeError('wall_clock');
        }
        let out: ReturnType<OpusFrameDecoder['decodeFrame']>;
        try {
          out = decoder.decodeFrame(packets[i] as Uint8Array);
        } catch {
          failedFrames += 1;
          continue;
        }
        if (out.errors.length > 0) failedFrames += 1;
        if (out.samplesDecoded <= 0) continue;
        const left = out.channelData[0];
        if (left === undefined) continue;
        const right = out.channelData[1];
        const n = Math.min(out.samplesDecoded, left.length);
        const mono = new Float32Array(n);
        if (right === undefined) mono.set(left.subarray(0, n));
        else for (let s = 0; s < n; s += 1) mono[s] = ((left[s] as number) + (right[s] as number)) / 2;
        chunks.push(mono);
        total += n;
      }
      if (signal.aborted) throw abortError(signal);
      if (failedFrames * 2 > packets.length) throw new VoiceDecodeError('decoder_errors');
      if (total === 0) throw new VoiceDecodeError('no_audio');
      const samples = new Float32Array(total);
      let off = 0;
      for (const c of chunks) {
        samples.set(c, off);
        off += c.length;
      }
      return encodeWavPcm16(samples, WAV_SAMPLE_RATE);
    } finally {
      try {
        decoder.free();
      } catch {
        // freeing a broken decoder must never mask the real outcome
      }
    }
  };
}

/** voice/decode.ts - opus-decoder@0.7.12 (MIT, WASM embedded) -> 16 kHz mono Float32 -> PCM16 WAV (30-line app writer). whisper-cli only ever sees this WAV. */
export function decodeToWav16k(packets: Uint8Array[], info: OggOpusInfo, signal: AbortSignal): Promise<Uint8Array> {
  return createWavDecoder(realOpusDecoderFactory)(packets, info, signal);
}
