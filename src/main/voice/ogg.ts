// src/main/voice/ogg.ts   ADD (C2 13) - owner V2-W1-07-media-voice. Pure; no I/O, no decoder.
// App-authored RFC 3533 (Ogg) / RFC 7845 (Ogg Opus) demuxer. The bytes are attacker-supplied (a contact's voice note), so every
// length is checked against the buffer before it is read, every page CRC is verified, exactly one logical stream is accepted and
// OpusHead + OpusTags are required (I12). Nothing here throws for malformed input: every structural problem is VOICE_DECODE_FAILED,
// a declared or actual duration above LIMITS.voiceMaxSeconds is VOICE_TOO_LONG - decided BEFORE any decoder exists (B18).
import { LIMITS } from '../../shared/types';

/** voice/ogg.ts - app-authored RFC 3533/7845 demuxer (bounds + CRC checked, single logical stream, OpusHead/OpusTags required).
 *  Duration comes from the LAST granule position BEFORE any decoding: > LIMITS.voiceMaxSeconds => VOICE_TOO_LONG, zero decode work. */
export interface OggOpusInfo {
  channels: number;
  preSkip: number;
  inputSampleRate: number;
  seconds: number;
  packets: number;
}

export type OggParseResult =
  | { ok: true; info: OggOpusInfo; packets: Uint8Array[] }
  | { ok: false; code: 'VOICE_DECODE_FAILED' | 'VOICE_TOO_LONG' };

/** Opus granule positions always count 48 kHz samples (RFC 7845 section 4). */
export const OPUS_GRANULE_RATE = 48_000;
/** RFC 7845 recommends 3840 (80 ms); libopus writes 312. Anything above 250 ms is not a voice note an encoder produced. */
export const MAX_PRE_SKIP = 12_000;
/** A single Opus packet is at most 120 ms of 1275-byte frames plus framing (RFC 6716 3.2.5); 64 KiB is a generous ceiling. */
export const MAX_PACKET_BYTES = 64 * 1024;
/** 15 min at the shortest legal frame (2.5 ms) - the packet-count ceiling that keeps memory bounded (T2 5). */
export const MAX_PACKETS = (LIMITS.voiceMaxSeconds * 1000) / 2.5;

const HEADER_BYTES = 27;
const FLAG_CONTINUED = 0x01;
const FLAG_BOS = 0x02;
const FLAG_EOS = 0x04;
const NO_GRANULE = -1n; // 0xFFFFFFFFFFFFFFFF as int64: "no packet finishes on this page"

// CRC-32 of RFC 3533: polynomial 0x04C11DB7, initial 0, no reflection, no final XOR, computed with the CRC field zeroed.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let b = 0; b < 8; b += 1) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

/** CRC of one page (`bytes` = the whole page); the four CRC bytes (offset 22..25) are treated as zero. */
export function oggPageCrc(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let i = start; i < end; i += 1) {
    const rel = i - start;
    const b = rel >= 22 && rel < 26 ? 0 : (bytes[i] as number);
    crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ b) & 0xff] as number)) >>> 0;
  }
  return crc >>> 0;
}

/** Duration of one Opus packet in 48 kHz samples from its TOC byte (RFC 6716 section 3.1); null = malformed packet. */
export function opusPacketSamples(packet: Uint8Array): number | null {
  if (packet.length < 1) return null;
  const toc = packet[0] as number;
  const config = toc >> 3;
  let frame: number; // samples at 48 kHz
  if (config < 12)
    frame = [480, 960, 1920, 2880][config % 4] as number; // SILK 10/20/40/60 ms
  else if (config < 16)
    frame = [480, 960][config % 2] as number; // Hybrid 10/20 ms
  else frame = [120, 240, 480, 960][config % 4] as number; // CELT 2.5/5/10/20 ms
  const code = toc & 0x03;
  let frames: number;
  if (code === 0) frames = 1;
  else if (code === 1 || code === 2) frames = 2;
  else {
    if (packet.length < 2) return null;
    frames = (packet[1] as number) & 0x3f;
    if (frames < 1) return null;
  }
  const total = frame * frames;
  return total > 5760 ? null : total; // > 120 ms is illegal (RFC 6716 3.2.5)
}

function ascii(bytes: Uint8Array, text: string): boolean {
  for (let i = 0; i < text.length; i += 1) if (bytes[i] !== text.charCodeAt(i)) return false;
  return true;
}

interface OpusHead {
  channels: number;
  preSkip: number;
  inputSampleRate: number;
}
/** RFC 7845 5.1. Only mapping family 0 (mono / stereo) - a WhatsApp voice note is mono. */
function parseOpusHead(p: Uint8Array): OpusHead | null {
  if (p.length < 19 || !ascii(p, 'OpusHead')) return null;
  const version = p[8] as number;
  if (version === 0 || version > 15) return null; // major version 0 only (1..15)
  const channels = p[9] as number;
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const preSkip = dv.getUint16(10, true);
  const inputSampleRate = dv.getUint32(12, true);
  const family = p[18] as number;
  if (family !== 0 || channels < 1 || channels > 2 || p.length !== 19) return null;
  if (preSkip > MAX_PRE_SKIP) return null;
  return { channels, preSkip, inputSampleRate };
}

/** RFC 7845 5.2: magic, vendor string and comment list must fit the packet exactly (lengths are attacker-controlled). */
function validOpusTags(p: Uint8Array): boolean {
  if (p.length < 16 || !ascii(p, 'OpusTags')) return false;
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  let off = 8;
  const vendorLen = dv.getUint32(off, true);
  off += 4;
  if (vendorLen > p.length - off) return false;
  off += vendorLen;
  if (off + 4 > p.length) return false;
  const count = dv.getUint32(off, true);
  off += 4;
  if (count > (p.length - off) / 4) return false;
  for (let i = 0; i < count; i += 1) {
    if (off + 4 > p.length) return false;
    const len = dv.getUint32(off, true);
    off += 4;
    if (len > p.length - off) return false;
    off += len;
  }
  return true; // RFC 7845 permits trailing padding after the comment list
}

const FAIL = { ok: false, code: 'VOICE_DECODE_FAILED' } as const;
const TOO_LONG = { ok: false, code: 'VOICE_TOO_LONG' } as const;

function concatParts(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function parseOggOpus(bytes: Uint8Array): OggParseResult {
  try {
    return parse(bytes);
  } catch {
    // Defence in depth: the parser is written not to throw; if it ever does, the note is undecodable, never a crash.
    return FAIL;
  }
}

function parse(bytes: Uint8Array): OggParseResult {
  if (bytes.length < HEADER_BYTES) return FAIL;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const maxSamples = BigInt(LIMITS.voiceMaxSeconds * OPUS_GRANULE_RATE);

  let off = 0;
  let serial: number | null = null;
  let expectedSeq = 0;
  let sawEos = false;
  let head: OpusHead | null = null;
  let tagsDone = false;
  let pending: Uint8Array[] = []; // parts of a packet continued across pages
  let pendingBytes = 0;
  let lastGranule: bigint | null = null;
  let audioSamples = 0; // sum of the packets' TOC durations (48 kHz)
  const packets: Uint8Array[] = [];
  let headerPacketIndex = 0; // 0 = expecting OpusHead, 1 = OpusTags, 2 = audio

  while (off < bytes.length) {
    if (sawEos) return FAIL; // RFC 3533: nothing of this stream after EOS; a second chained stream is refused too
    if (off + HEADER_BYTES > bytes.length) return FAIL;
    if (bytes[off] !== 0x4f || bytes[off + 1] !== 0x67 || bytes[off + 2] !== 0x67 || bytes[off + 3] !== 0x53)
      return FAIL;
    if (bytes[off + 4] !== 0) return FAIL; // stream_structure_version
    const flags = bytes[off + 5] as number;
    if ((flags & ~0x07) !== 0) return FAIL;
    const granule = dv.getBigInt64(off + 6, true);
    const pageSerial = dv.getUint32(off + 14, true);
    const seq = dv.getUint32(off + 18, true);
    const storedCrc = dv.getUint32(off + 22, true);
    const nseg = bytes[off + 26] as number;
    const segStart = off + HEADER_BYTES;
    if (segStart + nseg > bytes.length) return FAIL;
    let bodyLen = 0;
    for (let i = 0; i < nseg; i += 1) bodyLen += bytes[segStart + i] as number;
    const bodyStart = segStart + nseg;
    const end = bodyStart + bodyLen;
    if (end > bytes.length) return FAIL;
    if (oggPageCrc(bytes, off, end) !== storedCrc) return FAIL;

    // single logical stream, BOS exactly once (first page), consecutive sequence numbers
    if (serial === null) {
      if ((flags & FLAG_BOS) === 0) return FAIL;
      serial = pageSerial;
    } else if (pageSerial !== serial || (flags & FLAG_BOS) !== 0) return FAIL;
    if (seq !== expectedSeq) return FAIL;
    expectedSeq += 1;
    if ((flags & FLAG_CONTINUED) !== 0) {
      if (pending.length === 0) return FAIL;
    } else if (pending.length > 0) return FAIL;

    // walk the lacing values
    let pos = bodyStart;
    let completedOnPage = 0;
    for (let i = 0; i < nseg; i += 1) {
      const lace = bytes[segStart + i] as number;
      if (lace > 0) {
        pending.push(bytes.subarray(pos, pos + lace));
        pendingBytes += lace;
        pos += lace;
        if (pendingBytes > MAX_PACKET_BYTES) return FAIL;
      }
      if (lace === 255) continue; // the packet continues in the next segment
      // packet complete
      const packet = concatParts(pending);
      pending = [];
      pendingBytes = 0;
      completedOnPage += 1;
      if (headerPacketIndex === 0) {
        head = parseOpusHead(packet);
        if (head === null) return FAIL;
        headerPacketIndex = 1;
        // RFC 7845 3: the ID header is alone on the first page, which completes it
        if (i !== nseg - 1 || granule !== 0n) return FAIL;
      } else if (headerPacketIndex === 1) {
        if (!validOpusTags(packet)) return FAIL;
        tagsDone = true;
        headerPacketIndex = 2;
        // RFC 7845 3: the first audio packet starts on a fresh page
        if (i !== nseg - 1) return FAIL;
      } else {
        const samples = opusPacketSamples(packet);
        if (samples === null) return FAIL;
        audioSamples += samples;
        packets.push(packet);
        if (packets.length > MAX_PACKETS) return TOO_LONG;
        if (BigInt(audioSamples) > maxSamples + BigInt(MAX_PRE_SKIP)) return TOO_LONG;
      }
    }
    if (headerPacketIndex < 2 && granule !== 0n && granule !== NO_GRANULE) return FAIL; // header pages carry granule 0
    if (headerPacketIndex === 2 && tagsDone && completedOnPage > 0 && granule !== NO_GRANULE) {
      if (granule < 0n) return FAIL;
      if (lastGranule !== null && granule < lastGranule) return FAIL; // granules never go backwards
      if (packets.length > 0) lastGranule = granule;
      // early exit: a granule that already declares more than 15 min ends the walk (no need to read the rest of 64 MiB)
      if (head !== null && granule - BigInt(head.preSkip) > maxSamples) return TOO_LONG;
    }
    if ((flags & FLAG_EOS) !== 0) sawEos = true;
    off = end;
  }

  if (head === null || !tagsDone) return FAIL;
  if (pending.length > 0) return FAIL; // the file ends inside a packet
  if (packets.length === 0 || lastGranule === null) return FAIL;
  const played = lastGranule - BigInt(head.preSkip);
  if (played <= 0n) return FAIL;
  // Duration from the last granule, decided before any decoder exists (B18). The TOC sum guards against a granule that lies short.
  const samples = played > BigInt(audioSamples) ? played : BigInt(audioSamples);
  if (samples > maxSamples) return TOO_LONG;
  return {
    ok: true,
    info: {
      channels: head.channels,
      preSkip: head.preSkip,
      inputSampleRate: head.inputSampleRate,
      seconds: Number(played) / OPUS_GRANULE_RATE,
      packets: packets.length,
    },
    packets,
  };
}
