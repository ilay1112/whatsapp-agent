// src/main/voice/decode.test.ts - owner V2-W1-07-media-voice. T2 5: decode 48 kHz Opus -> 16 kHz mono through the REAL opus-decoder
// (S-OPUS real in every test but the two that inject a throwing decoder); the decoder is never constructed for a > 15 min note.
import { describe, expect, it, vi } from 'vitest';
import type { OpusDecoderFactory, OpusFrameDecoder } from '../deps';
import {
  createWavDecoder,
  decodeToWav16k,
  DECODE_BATCH,
  DECODE_WALL_CLOCK_MS,
  realOpusDecoderFactory,
  VoiceDecodeError,
} from './decode';
import { parseOggOpus } from './ogg';
import { WAV_HEADER_BYTES } from './wav';
import { hugeGranule, oggSilence } from '../../../tests/fakes/ogg-fixtures';

function parsed(seconds: number): { packets: Uint8Array[]; info: import('./ogg').OggOpusInfo } {
  const r = parseOggOpus(oggSilence(seconds));
  if (!r.ok) throw new Error('fixture');
  return r;
}
const live = (): AbortSignal => new AbortController().signal;

describe('decodeToWav16k (real opus-decoder@0.7.12)', () => {
  it('3 s of DTX silence => a 16 kHz mono PCM16 WAV of ~3 s (minus the pre-skip)', async () => {
    const { packets, info } = parsed(3);
    const wav = await decodeToWav16k(packets, info, live());
    const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
    expect(dv.getUint16(22, true)).toBe(1); // mono
    expect(dv.getUint32(24, true)).toBe(16_000);
    const dataBytes = dv.getUint32(40, true);
    expect(dataBytes).toBe(wav.length - WAV_HEADER_BYTES);
    const seconds = dataBytes / 32_000;
    expect(seconds).toBeGreaterThan(2.9);
    expect(seconds).toBeLessThanOrEqual(3.0);
  });

  it('the fake whisper duration rule (dataBytes / 32000, 0.1 s) maps the fixture back to its nominal length', async () => {
    for (const s of [1, 3, 5]) {
      const { packets, info } = parsed(s);
      const wav = await decodeToWav16k(packets, info, live());
      const dataBytes = new DataView(wav.buffer, wav.byteOffset).getUint32(40, true);
      expect(Math.round((dataBytes / 32_000) * 10) / 10).toBe(s);
    }
  });

  it('stereo input is down-mixed to mono', async () => {
    const calls: number[] = [];
    const stereo: OpusDecoderFactory = (o) => {
      calls.push(o.channels);
      return {
        ready: Promise.resolve(),
        decodeFrame: () => ({
          channelData: [new Float32Array([1, 1]), new Float32Array([0, -1])],
          samplesDecoded: 2,
          sampleRate: 16_000,
          errors: [],
        }),
        free: () => undefined,
      };
    };
    const { packets, info } = parsed(1);
    const wav = await createWavDecoder(stereo)(packets.slice(0, 1), { ...info, channels: 2 }, live());
    const dv = new DataView(wav.buffer, wav.byteOffset);
    expect(calls).toEqual([2]);
    expect(dv.getInt16(44, true)).toBe(Math.round(0.5 * 0x7fff));
    expect(dv.getInt16(46, true)).toBe(0);
  });
});

describe('failure modes', () => {
  it('a > 15 min note never reaches the decoder: ogg.ts refuses first (S-OPUS spy never called)', () => {
    const factory = vi.fn(realOpusDecoderFactory);
    const r = parseOggOpus(hugeGranule(16));
    expect(r).toEqual({ ok: false, code: 'VOICE_TOO_LONG' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('a throwing decoder factory => VOICE_DECODE_FAILED (decoder_init)', async () => {
    const { packets, info } = parsed(1);
    const boom: OpusDecoderFactory = () => {
      throw new Error('wasm');
    };
    await expect(createWavDecoder(boom)(packets, info, live())).rejects.toMatchObject({
      code: 'VOICE_DECODE_FAILED',
      reason: 'decoder_init',
    });
    const rejecting: OpusDecoderFactory = () =>
      ({ ready: Promise.reject(new Error('x')), decodeFrame: vi.fn(), free: vi.fn() }) as unknown as OpusFrameDecoder;
    await expect(createWavDecoder(rejecting)(packets, info, live())).rejects.toBeInstanceOf(VoiceDecodeError);
  });

  it('a decoder that throws on every frame => VOICE_DECODE_FAILED (decoder_errors), freed once', async () => {
    const { packets, info } = parsed(1);
    const free = vi.fn(() => {
      throw new Error('double free');
    });
    const bad: OpusDecoderFactory = () => ({
      ready: Promise.resolve(),
      decodeFrame: () => {
        throw new Error('frame');
      },
      free,
    });
    await expect(createWavDecoder(bad)(packets, info, live())).rejects.toMatchObject({ reason: 'decoder_errors' });
    expect(free).toHaveBeenCalledTimes(1);
  });

  it('errors[] on most frames => decoder_errors; no samples at all => no_audio; odd channel data is tolerated', async () => {
    const { packets, info } = parsed(1);
    const withErrors: OpusDecoderFactory = () => ({
      ready: Promise.resolve(),
      decodeFrame: () => ({
        channelData: [new Float32Array(320)],
        samplesDecoded: 320,
        sampleRate: 16_000,
        errors: [{}],
      }),
      free: () => undefined,
    });
    await expect(createWavDecoder(withErrors)(packets, info, live())).rejects.toMatchObject({
      reason: 'decoder_errors',
    });
    let k = 0;
    const empty: OpusDecoderFactory = () => ({
      ready: Promise.resolve(),
      decodeFrame: () => {
        k += 1;
        return k % 2 === 0
          ? { channelData: [], samplesDecoded: 5, sampleRate: 16_000, errors: [] }
          : { channelData: [new Float32Array(0)], samplesDecoded: 0, sampleRate: 16_000, errors: [] };
      },
      free: () => undefined,
    });
    await expect(createWavDecoder(empty)(packets, info, live())).rejects.toMatchObject({ reason: 'no_audio' });
  });

  it('bad input (no packets / 3 channels) => bad_input', async () => {
    const { packets, info } = parsed(1);
    await expect(decodeToWav16k([], info, live())).rejects.toMatchObject({ reason: 'bad_input' });
    await expect(decodeToWav16k(packets, { ...info, channels: 3 }, live())).rejects.toMatchObject({
      reason: 'bad_input',
    });
  });

  it('abort before start, during the batches and at the end rejects with the abort reason', async () => {
    const { packets, info } = parsed(30); // 1500 packets => 3 batch checks
    const pre = new AbortController();
    pre.abort(new Error('paused'));
    await expect(decodeToWav16k(packets, info, pre.signal)).rejects.toThrow('paused');
    const mid = new AbortController();
    let frames = 0;
    const counting: OpusDecoderFactory = (o) => {
      const real = realOpusDecoderFactory(o);
      return {
        ready: real.ready,
        decodeFrame: (f) => {
          frames += 1;
          if (frames === DECODE_BATCH + 1) mid.abort();
          return real.decodeFrame(f);
        },
        free: real.free,
      };
    };
    await expect(createWavDecoder(counting)(packets, info, mid.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(frames).toBeLessThan(packets.length);
    const end = new AbortController();
    const last: OpusDecoderFactory = () => ({
      ready: Promise.resolve(),
      decodeFrame: () => {
        end.abort(new Error('quit'));
        return { channelData: [new Float32Array(1)], samplesDecoded: 1, sampleRate: 16_000, errors: [] };
      },
      free: () => undefined,
    });
    await expect(createWavDecoder(last)(packets.slice(0, 3), info, end.signal)).rejects.toThrow('quit');
  });

  it('the 20 s decode wall clock => VOICE_DECODE_FAILED (wall_clock)', async () => {
    const { packets, info } = parsed(30);
    let t = 0;
    const clock = (): number => {
      t += DECODE_WALL_CLOCK_MS; // each check sees 20 s more
      return t;
    };
    await expect(createWavDecoder(realOpusDecoderFactory, clock)(packets, info, live())).rejects.toMatchObject({
      reason: 'wall_clock',
    });
  });
});
