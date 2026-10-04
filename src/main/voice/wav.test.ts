// src/main/voice/wav.test.ts - owner V2-W1-07-media-voice. T2 5: WAV header bytes golden (the fake whisper checks the same header).
import { describe, expect, it } from 'vitest';
import { encodeWavPcm16, WAV_HEADER_BYTES, WAV_SAMPLE_RATE } from './wav';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('encodeWavPcm16', () => {
  it('golden 44-byte canonical header for 2 samples at 16 kHz mono', () => {
    const wav = encodeWavPcm16(new Float32Array([0, 0]), WAV_SAMPLE_RATE);
    expect(wav.length).toBe(WAV_HEADER_BYTES + 4);
    expect(hex(wav.subarray(0, 44))).toBe(
      '52494646' +
        '28000000' +
        '57415645' +
        '666d7420' +
        '10000000' +
        '0100' +
        '0100' +
        '803e0000' +
        '007d0000' +
        '0200' +
        '1000' +
        '64617461' +
        '04000000',
    );
  });

  it('samples are clamped to [-1, 1], NaN is silence, scaling is asymmetric int16', () => {
    const wav = encodeWavPcm16(new Float32Array([1, -1, 2, -2, Number.NaN, 0.5]), 16_000);
    const dv = new DataView(wav.buffer);
    expect([0, 1, 2, 3, 4, 5].map((i) => dv.getInt16(44 + i * 2, true))).toEqual([
      32767,
      -32768,
      32767,
      -32768,
      0,
      Math.round(0.5 * 32767),
    ]);
  });

  it('an empty signal still has a valid header; a bad sample rate throws', () => {
    const wav = encodeWavPcm16(new Float32Array(0), 16_000);
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(0);
    expect(() => encodeWavPcm16(new Float32Array(1), 0)).toThrow(RangeError);
    expect(() => encodeWavPcm16(new Float32Array(1), 16_000.5)).toThrow(RangeError);
  });
});
