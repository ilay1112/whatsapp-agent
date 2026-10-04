// src/main/voice/wav.ts   ADD - owner V2-W1-07-media-voice.
// C2 13 names "-> PCM16 WAV (30-line app writer)" without a signature; the W0 seam (docs/specs/v2-wave0-seams.md) freezes it.
// whisper-cli only ever reads a file this writer produced (I12): a canonical 44-byte RIFF/WAVE header, PCM 16-bit LE, mono.

/** 16 kHz mono PCM16 little-endian RIFF/WAVE (44-byte canonical header). Samples are clamped to [-1, 1] then scaled to int16. */
export const WAV_SAMPLE_RATE = 16_000;
export const WAV_HEADER_BYTES = 44;

export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError('sampleRate');
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const dv = new DataView(out.buffer);
  const tag = (off: number, s: string): void => {
    for (let i = 0; i < 4; i += 1) out[off + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  dv.setUint32(16, 16, true); // fmt chunk size (PCM)
  dv.setUint16(20, 1, true); // audio format 1 = PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // byte rate = rate * channels * 2
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits per sample
  tag(36, 'data');
  dv.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    const raw = samples[i] as number;
    const x = Number.isNaN(raw) ? 0 : Math.max(-1, Math.min(1, raw));
    dv.setInt16(WAV_HEADER_BYTES + i * 2, x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff), true);
  }
  return out;
}
