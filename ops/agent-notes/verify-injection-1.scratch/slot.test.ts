// Scratch verification for review finding injection-1. Read-only: imports the real S2 resolve + S3 contextBuilder.
import { describe, expect, it } from 'vitest';
import { resolveExtraction } from '../../../src/main/agent/resolve';
import { buildContext } from '../../../src/main/agent/contextBuilder';
import { buildDayTable } from '../../../src/shared/when';
import type { Extraction } from '../../../src/shared/schemas';
import type { BusyBlock, Message } from '../../../src/shared/types';

const TZ = 'Asia/Jerusalem';
// 2026-09-21T09:00 local (Monday).
const NOW_MS = Date.UTC(2026, 8, 21, 6, 0, 0);
const NONCE = 'a1b2c3d4e5f60789';

function msg(text: string): Message {
  return {
    rowid: 1,
    waMsgId: 'WA1',
    chatJid: '972550000001@s.whatsapp.net',
    senderUser: '972550000001',
    ts: NOW_MS,
    fromMe: false,
    mediaType: '',
    deleted: false,
    text,
  } as Message;
}

const COMPLETE: Extraction = {
  intent: 'schedule_request',
  needsReply: true,
  title: 'coffee',
  dateKind: 'weekday',
  isoDate: '',
  weekday: 4, // Thursday
  weekOffset: 0,
  daysFromToday: 0,
  time24h: '17:00',
  timeAmbiguous: true,
  durationMin: 0,
  location: '',
  missing: ['duration', 'location'],
  suspicious: false,
};
const NO_TIME: Extraction = { ...COMPLETE, time24h: '', timeAmbiguous: false, missing: ['time', 'duration'] };

function draftMessage(busy: BusyBlock[] | null): string {
  return buildContext({
    messages: [msg('נקבע ליום חמישי?')],
    nonce: NONCE,
    dayTable: buildDayTable(NOW_MS, TZ),
    nowIso: '2026-09-21T09:00:00+03:00',
    timeZone: TZ,
    replyLang: 'he',
    busy,
    stage: 'draft',
  }).userMessage;
}

describe('injection-1: does the S3 DRAFT user message carry the app-computed slot / missing[]?', () => {
  it('complete slot: the resolved start/end/title never appear in the draft context', () => {
    const slot = resolveExtraction(COMPLETE, {
      nowMs: NOW_MS,
      timeZone: TZ,
      defaultDurationMin: 60,
      ambiguousHour: 'assume',
    });
    expect(slot.state).toBe('complete');
    const start = slot.event!.startLocal;
    const end = slot.event!.endLocal;
    // eslint-disable-next-line no-console
    console.log('RESOLVED', JSON.stringify({ state: slot.state, start, end, missing: slot.missing }));
    const busy: BusyBlock[] = [{ startLocal: '2026-09-24T16:00:00', endLocal: '2026-09-24T17:30:00' }];
    const um = draftMessage(busy);
    // eslint-disable-next-line no-console
    console.log('--- DRAFT USER MESSAGE ---\n' + um + '\n--- END ---');
    expect(um).not.toContain(start);
    expect(um).not.toContain(end);
    expect(um.toLowerCase()).not.toContain('proposed slot');
    expect(um.toLowerCase()).not.toContain('missing');
  });

  it('incomplete slot (missing time): missing[] is absent and no free/busy is even prefetched', () => {
    const slot = resolveExtraction(NO_TIME, {
      nowMs: NOW_MS,
      timeZone: TZ,
      defaultDurationMin: 60,
      ambiguousHour: 'assume',
    });
    // eslint-disable-next-line no-console
    console.log('RESOLVED-INCOMPLETE', JSON.stringify({ state: slot.state, missing: slot.missing }));
    expect(slot.state).toBe('incomplete'); // orchestrator prefetches busy only when state === 'complete'
    const um = draftMessage(null);
    expect(um.toLowerCase()).not.toContain('missing');
    expect(um).toContain('free/busy (app-computed, trusted): not available');
  });
});
