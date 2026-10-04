import { describe, expect, it } from 'vitest';
import { resolveDeltaOutcome } from '../../../src/main/agent/resolveDelta';
import type { ExistingEventCtx } from '../../../src/main/agent/existingEvent';
import type { Extraction } from '../../../src/shared/schemas';
const TZ = 'Asia/Jerusalem';
const ctx = (iso: string) => ({ nowMs: Date.parse(iso), timeZone: TZ, defaultDurationMin: 60, ambiguousHour: 'assume' as const });
const ex = (s: string, e: string): ExistingEventCtx => ({ editableCount: 1, originItemId: 7, sourceItemId: 7, eventId: 'evt1', title: 'meeting', location: 'office', startLocal: s, endLocal: e, timeZone: TZ, status: 'confirmed', revision: 1 });
const X: Extraction = { intent: 'cancel', needsReply: true, title: 'meeting', dateKind: 'weekday', isoDate: '', weekday: 3, weekOffset: 0, daysFromToday: 0, time24h: '', timeAmbiguous: false, durationMin: 0, location: '', missing: [], suspicious: false, refersToExisting: true, change: 'cancel', changeConfidence: 'high', confidence: 'high' };
describe('verify editing-undo-7', () => {
  it('same weekday today, event next week', () => {
    const o = resolveDeltaOutcome(X, ex('2026-09-30T15:00:00', '2026-09-30T16:00:00'), ctx('2026-09-23T06:00:00.000Z'), 'sorry, I have to cancel Wednesday');
    console.log('A', JSON.stringify(o.path === 'delta' ? { k: o.delta.kind, to: o.delta.to.startLocal } : o));
  });
  it('Monday, event Thursday next week, "cancel Thursday"', () => {
    const o = resolveDeltaOutcome({ ...X, weekday: 4 }, ex('2026-10-01T15:00:00', '2026-10-01T16:00:00'), ctx('2026-09-21T06:00:00.000Z'), 'sorry, I have to cancel Thursday');
    console.log('B', JSON.stringify(o.path === 'delta' ? { k: o.delta.kind, to: o.delta.to.startLocal } : o));
  });
  it('same weekday today, after event hour', () => {
    const o = resolveDeltaOutcome(X, ex('2026-09-30T15:00:00', '2026-09-30T16:00:00'), ctx('2026-09-23T14:00:00.000Z'), 'sorry, I have to cancel Wednesday');
    console.log('C', JSON.stringify(o.path === 'delta' ? { k: o.delta.kind, to: o.delta.to.startLocal } : o));
  });
});
