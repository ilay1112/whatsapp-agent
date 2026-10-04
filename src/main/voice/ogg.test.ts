// src/main/voice/ogg.test.ts - owner V2-W1-07-media-voice. T2 5 row `voice/ogg.ts`: every ogg-fixtures.ts builder; valid => packets,
// hostile => the precise VOICE_* code, no exception escapes, bounded memory; duration from the LAST granule before any decoding.
import { describe, expect, it } from 'vitest';
import { LIMITS } from '../../shared/types';
import { MAX_PACKET_BYTES, MAX_PACKETS, OPUS_GRANULE_RATE, oggPageCrc, opusPacketSamples, parseOggOpus } from './ogg';
import {
  absurdPreSkip,
  badCrc,
  hugeGranule,
  id3Prefixed,
  missingOpusTags,
  oggCrc32,
  oggPage,
  oggSilence,
  oggSilencePages,
  opusHead,
  opusTags,
  riffWav,
  segmentTableOverflow,
  truncatedPage,
  twoStreams,
  wrongSerial,
  zeroLength,
} from '../../../tests/fakes/ogg-fixtures';

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
const SERIAL = 0x5ca1ab1e;
const page = (
  headerType: number,
  granule: bigint,
  sequence: number,
  packets: Uint8Array[],
  serial = SERIAL,
): Uint8Array => oggPage({ headerType, granule, serial, sequence, packets });
const SILENCE = Uint8Array.of(0xf8, 0xff, 0xfe);

describe('parseOggOpus - valid notes', () => {
  it.each([1, 3, 7.5, 60])('a %s s DTX-silence note => ok with the granule duration and every packet', (seconds) => {
    const r = parseOggOpus(oggSilence(seconds));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.channels).toBe(1);
    expect(r.info.seconds).toBeCloseTo(seconds, 5);
    expect(r.info.packets).toBe(Math.round(seconds * 50));
    expect(r.packets).toHaveLength(r.info.packets);
    expect(Array.from(r.packets[0] as Uint8Array)).toEqual([0xf8, 0xff, 0xfe]);
    expect(r.info.inputSampleRate).toBe(16_000); // the fixture header default (informational only, RFC 7845 5.1)
  });

  it('exactly 15 min is accepted, 15 min + 20 ms is VOICE_TOO_LONG', () => {
    expect(parseOggOpus(oggSilence(LIMITS.voiceMaxSeconds)).ok).toBe(true);
    expect(parseOggOpus(oggSilence(LIMITS.voiceMaxSeconds + 0.02))).toEqual({ ok: false, code: 'VOICE_TOO_LONG' });
  });

  it('a packet continued across two pages (255 lacing) is reassembled', () => {
    const big = new Uint8Array(600).fill(0xab);
    big[0] = 0xf8; // CELT 20 ms, code 0
    const bytes = concat([
      page(0x02, 0n, 0, [opusHead()]),
      page(0, 0n, 1, [opusTags()]),
      // oggPage laces a 600-byte packet as 255,255,90 on one page; split it by hand across two pages instead
      splitPacketPages(big),
    ]);
    const r = parseOggOpus(bytes);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.packets).toHaveLength(1);
      expect(r.packets[0]?.length).toBe(600);
    }
  });

  it('pages that finish no packet (granule -1) are accepted', () => {
    const bytes = concat([
      page(0x02, 0n, 0, [opusHead()]),
      page(0, 0n, 1, [opusTags()]),
      page(0, 312n + 960n, 2, [SILENCE]),
      page(0x04, 312n + 1920n, 3, [SILENCE]),
    ]);
    expect(parseOggOpus(bytes).ok).toBe(true);
  });
});

/** Two pages: the first carries 255 bytes (lacing 255, granule -1), the second the rest (continued flag). */
function splitPacketPages(packet: Uint8Array): Uint8Array {
  const first = rawPage(0, -1n, 2, [255], packet.subarray(0, 255));
  const restLen = packet.length - 255;
  const lacing: number[] = [];
  let left = restLen;
  while (left >= 255) {
    lacing.push(255);
    left -= 255;
  }
  lacing.push(left);
  const second = rawPage(0x01 | 0x04, BigInt(312 + 960), 3, lacing, packet.subarray(255));
  return concat([first, second]);
}
function rawPage(
  headerType: number,
  granule: bigint,
  sequence: number,
  lacing: number[],
  body: Uint8Array,
  serial = SERIAL,
): Uint8Array {
  const out = new Uint8Array(27 + lacing.length + body.length);
  const dv = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53], 0);
  out[4] = 0;
  out[5] = headerType;
  dv.setBigInt64(6, granule, true);
  dv.setUint32(14, serial, true);
  dv.setUint32(18, sequence, true);
  out[26] = lacing.length;
  out.set(lacing, 27);
  out.set(body, 27 + lacing.length);
  dv.setUint32(22, oggCrc32(out), true);
  return out;
}

describe('parseOggOpus - hostile set (T2 3.6) => precise codes, never a throw', () => {
  const cases: Array<[string, () => Uint8Array, 'VOICE_DECODE_FAILED' | 'VOICE_TOO_LONG']> = [
    ['badCrc', () => badCrc(), 'VOICE_DECODE_FAILED'],
    ['wrongSerial', () => wrongSerial(), 'VOICE_DECODE_FAILED'],
    ['twoStreams', () => twoStreams(), 'VOICE_DECODE_FAILED'],
    ['truncatedPage', () => truncatedPage(), 'VOICE_DECODE_FAILED'],
    ['missingOpusTags', () => missingOpusTags(), 'VOICE_DECODE_FAILED'],
    ['hugeGranule(16)', () => hugeGranule(16), 'VOICE_TOO_LONG'],
    ['hugeGranule(600)', () => hugeGranule(600), 'VOICE_TOO_LONG'],
    ['segmentTableOverflow', () => segmentTableOverflow(), 'VOICE_DECODE_FAILED'],
    ['absurdPreSkip', () => absurdPreSkip(), 'VOICE_DECODE_FAILED'],
    ['zeroLength', () => zeroLength(), 'VOICE_DECODE_FAILED'],
    ['id3Prefixed', () => id3Prefixed(), 'VOICE_DECODE_FAILED'],
    ['riffWav', () => riffWav(), 'VOICE_DECODE_FAILED'],
    ['header pages only', () => oggSilence(0), 'VOICE_DECODE_FAILED'],
  ];
  it.each(cases)('%s => %s', (_name, build, code) => {
    expect(parseOggOpus(build())).toEqual({ ok: false, code });
  });

  it('a note whose granule lies short but whose packets run past 15 min is VOICE_TOO_LONG (TOC sum)', () => {
    const r = parseOggOpus(oggSilence(LIMITS.voiceMaxSeconds + 30, { lastGranule: 48_000n }));
    expect(r).toEqual({ ok: false, code: 'VOICE_TOO_LONG' });
  });

  it('granule going backwards, non-zero header granule, BOS twice, bad version, bad flags, gap in sequence', () => {
    const h = page(0x02, 0n, 0, [opusHead()]);
    const t = page(0, 0n, 1, [opusTags()]);
    expect(parseOggOpus(concat([h, t, page(0, 5000n, 2, [SILENCE]), page(0x04, 1000n, 3, [SILENCE])])).ok).toBe(false);
    expect(parseOggOpus(concat([page(0x02, 7n, 0, [opusHead()]), t, page(0x04, 1272n, 2, [SILENCE])])).ok).toBe(false);
    expect(parseOggOpus(concat([h, page(0x02, 0n, 1, [opusTags()]), page(0x04, 1272n, 2, [SILENCE])])).ok).toBe(false);
    expect(parseOggOpus(concat([h, t, page(0x04, 1272n, 3, [SILENCE])])).ok).toBe(false);
    const badVersion = h.slice();
    badVersion[4] = 1;
    expect(parseOggOpus(concat([badVersion, t, page(0x04, 1272n, 2, [SILENCE])])).ok).toBe(false);
    expect(
      parseOggOpus(concat([rawPage(0x02 | 0x08, 0n, 0, [19], opusHead()), t, page(0x04, 1272n, 2, [SILENCE])])).ok,
    ).toBe(false);
    expect(parseOggOpus(concat([h, t, page(0x04, 1272n, 2, [SILENCE]), page(0, 2232n, 3, [SILENCE])])).ok).toBe(false); // after EOS
    expect(parseOggOpus(concat([h, t, page(0x04, -5n, 2, [SILENCE])])).ok).toBe(false); // negative granule
    expect(parseOggOpus(concat([h, t, page(0x04, 100n, 2, [SILENCE])])).ok).toBe(false); // granule <= preSkip
  });

  it('continued flag without a pending packet, and a pending packet without the continued flag, are refused', () => {
    const h = page(0x02, 0n, 0, [opusHead()]);
    const t = page(0, 0n, 1, [opusTags()]);
    expect(parseOggOpus(concat([h, t, rawPage(0x01 | 0x04, 1272n, 2, [3], SILENCE)])).ok).toBe(false);
    const half = rawPage(0, -1n, 2, [255], new Uint8Array(255).fill(0xf8));
    expect(parseOggOpus(concat([h, t, half, page(0x04, 1272n, 3, [SILENCE])])).ok).toBe(false);
    expect(parseOggOpus(concat([h, t, half])).ok).toBe(false); // file ends inside a packet
  });

  it('malformed OpusHead / OpusTags variants are refused', () => {
    const t = page(0, 0n, 1, [opusTags()]);
    const audio = page(0x04, 1272n, 2, [SILENCE]);
    const withHead = (head: Uint8Array): Uint8Array => concat([rawPage(0x02, 0n, 0, [head.length], head), t, audio]);
    const good = opusHead();
    const v0 = good.slice();
    v0[8] = 0;
    const v16 = good.slice();
    v16[8] = 16;
    const ch0 = good.slice();
    ch0[9] = 0;
    const ch3 = good.slice();
    ch3[9] = 3;
    const fam1 = good.slice();
    fam1[18] = 1;
    const notHead = good.slice();
    notHead[0] = 0x58;
    expect(parseOggOpus(withHead(good)).ok).toBe(true);
    for (const bad of [v0, v16, ch0, ch3, fam1, notHead, good.subarray(0, 18), concat([good, Uint8Array.of(0)])]) {
      expect(parseOggOpus(withHead(bad)).ok).toBe(false);
    }
    // OpusHead not alone on the first page
    expect(parseOggOpus(concat([page(0x02, 0n, 0, [opusHead(), opusTags()]), audio])).ok).toBe(false);
    // OpusTags shares its page with audio
    expect(
      parseOggOpus(concat([page(0x02, 0n, 0, [opusHead()]), page(0x04, 1272n, 1, [opusTags(), SILENCE])])).ok,
    ).toBe(false);

    const tags = opusTags();
    const withTags = (tg: Uint8Array): Uint8Array =>
      concat([page(0x02, 0n, 0, [opusHead()]), rawPage(0, 0n, 1, [tg.length], tg), audio]);
    expect(parseOggOpus(withTags(tags)).ok).toBe(true);
    const lie = (off: number, value: number): Uint8Array => {
      const x = tags.slice();
      new DataView(x.buffer).setUint32(off, value, true);
      return x;
    };
    const vendorLen = new DataView(tags.buffer, tags.byteOffset).getUint32(8, true);
    expect(parseOggOpus(withTags(lie(8, 0xffffffff))).ok).toBe(false); // vendor longer than the packet
    expect(parseOggOpus(withTags(lie(12 + vendorLen, 0x7fffffff))).ok).toBe(false); // absurd comment count
    expect(parseOggOpus(withTags(tags.subarray(0, 12 + vendorLen + 2))).ok).toBe(false); // count field cut
    expect(parseOggOpus(withTags(tags.subarray(0, 12))).ok).toBe(false); // too short
    // one comment whose length lies
    const oneComment = concat([tags.subarray(0, 12 + vendorLen), Uint8Array.of(1, 0, 0, 0, 200, 0, 0, 0, 0x41)]);
    expect(parseOggOpus(withTags(oneComment)).ok).toBe(false);
    const oneCommentCut = concat([tags.subarray(0, 12 + vendorLen), Uint8Array.of(2, 0, 0, 0, 1, 0, 0, 0, 0x41)]);
    expect(parseOggOpus(withTags(oneCommentCut)).ok).toBe(false);
    const oneOk = concat([tags.subarray(0, 12 + vendorLen), Uint8Array.of(1, 0, 0, 0, 1, 0, 0, 0, 0x41, 0, 0)]);
    expect(parseOggOpus(withTags(oneOk)).ok).toBe(true); // trailing padding allowed
    const notTags = tags.slice();
    notTags[0] = 0x58;
    expect(parseOggOpus(withTags(notTags)).ok).toBe(false);
  });

  it('an absurd pre-skip just above MAX_PRE_SKIP fails; an oversized packet fails; a malformed TOC fails', () => {
    expect(parseOggOpus(oggSilence(1, { preSkip: 12_001 })).ok).toBe(false);
    const h = page(0x02, 0n, 0, [opusHead()]);
    const t = page(0, 0n, 1, [opusTags()]);
    const huge = new Uint8Array(MAX_PACKET_BYTES + 255).fill(0xf8);
    const lacing = new Array<number>(Math.floor(huge.length / 255)).fill(255);
    // spread over pages of <= 255 segments, all continued
    const pages: Uint8Array[] = [h, t];
    let seq = 2;
    let off = 0;
    for (let i = 0; i < lacing.length; i += 250) {
      const n = Math.min(250, lacing.length - i);
      pages.push(
        rawPage(i === 0 ? 0 : 0x01, -1n, seq++, new Array<number>(n).fill(255), huge.subarray(off, off + n * 255)),
      );
      off += n * 255;
    }
    expect(parseOggOpus(concat(pages)).ok).toBe(false);
    // code 3 packet with frame count 0 / missing count byte / > 120 ms
    expect(parseOggOpus(concat([h, t, page(0x04, 1272n, 2, [Uint8Array.of(0xfb, 0x00)])])).ok).toBe(false);
    expect(parseOggOpus(concat([h, t, page(0x04, 1272n, 2, [Uint8Array.of(0xfb)])])).ok).toBe(false);
    expect(parseOggOpus(concat([h, t, page(0x04, 1272n, 2, [Uint8Array.of(0xfb, 0x07)])])).ok).toBe(false);
    // an empty audio packet (lacing 0)
    expect(parseOggOpus(concat([h, t, rawPage(0x04, 1272n, 2, [0], new Uint8Array(0))])).ok).toBe(false);
  });

  it('bounded work: a packet-count flood is stopped at MAX_PACKETS', () => {
    // 2.5 ms CELT packets (config 16 => 120 samples): 15 min worth + more, granule never finishing early
    const tiny = Uint8Array.of(16 << 3);
    const perPage = 250;
    const pages: Uint8Array[] = [page(0x02, 0n, 0, [opusHead()]), page(0, 0n, 1, [opusTags()])];
    const total = MAX_PACKETS + perPage;
    let seq = 2;
    for (let done = 0; done < total; done += perPage) {
      pages.push(page(0, 312n + BigInt(done + perPage) * 120n, seq++, new Array<Uint8Array>(perPage).fill(tiny)));
    }
    const r = parseOggOpus(concat(pages));
    expect(r).toEqual({ ok: false, code: 'VOICE_TOO_LONG' });
  });

  it('never throws, even for a sliced ArrayBuffer view', () => {
    const inner = oggSilence(1);
    const buf = new Uint8Array(inner.length + 16);
    buf.set(inner, 8);
    expect(parseOggOpus(buf.subarray(8, 8 + inner.length)).ok).toBe(true);
  });
});

describe('helpers', () => {
  it('oggPageCrc matches the fixture CRC and ignores the stored CRC bytes', () => {
    const p = oggSilencePages(1)[2] as Uint8Array;
    const stored = new DataView(p.buffer, p.byteOffset).getUint32(22, true);
    expect(oggPageCrc(p, 0, p.length)).toBe(stored);
  });

  it('opusPacketSamples maps the TOC (SILK / hybrid / CELT, codes 0-3)', () => {
    expect(opusPacketSamples(new Uint8Array(0))).toBeNull();
    expect(opusPacketSamples(Uint8Array.of(0 << 3))).toBe(480); // SILK 10 ms
    expect(opusPacketSamples(Uint8Array.of((3 << 3) | 1))).toBe(2880 * 2); // SILK 60 ms x 2
    expect(opusPacketSamples(Uint8Array.of((13 << 3) | 2))).toBe(1920); // hybrid 20 ms x 2
    expect(opusPacketSamples(Uint8Array.of(12 << 3))).toBe(480); // hybrid 10 ms
    expect(opusPacketSamples(Uint8Array.of(31 << 3))).toBe(960); // CELT 20 ms
    expect(opusPacketSamples(Uint8Array.of((16 << 3) | 3, 48))).toBe(5760); // CELT 2.5 ms x 48 = 120 ms
    expect(opusPacketSamples(Uint8Array.of((16 << 3) | 3, 49))).toBeNull(); // > 120 ms
    expect(OPUS_GRANULE_RATE).toBe(48_000);
  });
});

describe('defence in depth', () => {
  it('an input that makes the walker throw is VOICE_DECODE_FAILED, never an exception', () => {
    expect(parseOggOpus(null as unknown as Uint8Array)).toEqual({ ok: false, code: 'VOICE_DECODE_FAILED' });
  });
});

describe('structural edge cases', () => {
  const h = page(0x02, 0n, 0, [opusHead()]);
  const t = page(0, 0n, 1, [opusTags()]);
  it('a first page without BOS, a lone OpusHead page, a first page with no segment => VOICE_DECODE_FAILED', () => {
    expect(parseOggOpus(concat([page(0, 0n, 0, [opusHead()]), t, page(0x04, 1272n, 2, [SILENCE])])).ok).toBe(false);
    expect(parseOggOpus(h).ok).toBe(false);
    expect(parseOggOpus(rawPage(0x02, 0n, 0, [], new Uint8Array(0))).ok).toBe(false);
  });
  it('trailing bytes shorter than a page header after a non-EOS page => VOICE_DECODE_FAILED', () => {
    expect(parseOggOpus(concat([h, t, page(0, 1272n, 2, [SILENCE]), new Uint8Array(10)])).ok).toBe(false);
  });
  it('OpusTags whose vendor string consumes the packet exactly (no count field) => VOICE_DECODE_FAILED', () => {
    const tg = new Uint8Array(16);
    tg.set(
      Array.from('OpusTags', (c) => c.charCodeAt(0)),
      0,
    );
    new DataView(tg.buffer).setUint32(8, 4, true);
    const bytes = concat([h, rawPage(0, 0n, 1, [tg.length], tg), page(0x04, 1272n, 2, [SILENCE])]);
    expect(parseOggOpus(bytes).ok).toBe(false);
  });
  it('OpusTags continued over two pages: granule -1 on the first is fine, a granule there is refused', () => {
    const tags = opusTags();
    const cut = 8;
    // first page: a 255-lacing would be needed to continue; use a padded tags packet of 300 bytes instead
    const big = new Uint8Array(300);
    big.set(tags, 0);
    const first = (g: bigint): Uint8Array => rawPage(0, g, 1, [255], big.subarray(0, 255));
    const second = rawPage(0x01, 0n, 2, [big.length - 255], big.subarray(255));
    const audio = page(0x04, 1272n, 3, [SILENCE]);
    expect(parseOggOpus(concat([h, first(-1n), second, audio])).ok).toBe(true);
    expect(parseOggOpus(concat([h, first(5n), second, audio])).ok).toBe(false);
    expect(cut).toBe(8);
  });
  it('a granule shorter than the packets: the packet duration decides the ceiling, the granule the reported seconds', () => {
    const r = parseOggOpus(oggSilence(2, { lastGranule: 312n + 48_000n }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.info.seconds).toBeCloseTo(1, 5);
    // every page lies short (granules stay monotonic), the packets add up to 15 min + 200 ms => the TOC sum decides
    const pages: Uint8Array[] = [h, t];
    const total = (LIMITS.voiceMaxSeconds + 0.2) * 50;
    let seq = 2;
    for (let done = 0; done < total; done += 50)
      pages.push(page(0, 312n + BigInt(seq), seq++, new Array<Uint8Array>(50).fill(SILENCE)));
    expect(parseOggOpus(concat(pages))).toEqual({ ok: false, code: 'VOICE_TOO_LONG' });
  });
});
