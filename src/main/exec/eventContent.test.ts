// src/main/exec/eventContent.test.ts - the pure content helpers shared by AutoGate, the executor and reconcile (owner V2-W1-04).
import { describe, expect, it } from 'vitest';
import {
  busyOverlapping,
  contentOfProjection,
  contentOfSnapshot,
  equalContent,
  normaliseField,
  sameContent,
  snapshotOfProjection,
  viewOf,
} from './eventContent';
import { FROM, projection } from './autoGate.fixtures';

describe('normaliseField (= buildCreateEventArgs.cleanField)', () => {
  it('strips invisible characters and URLs, collapses whitespace, trims and caps', () => {
    expect(normaliseField('  a\u200B  b  https://x.example/y  c ', 80)).toBe('a b c');
    expect(normaliseField('www.example.com meet', 80)).toBe('meet');
    expect(normaliseField('x'.repeat(100), 80)).toHaveLength(80);
  });
});

describe('projection -> content / snapshot', () => {
  it('contentOfProjection maps tentative to confirmed and cancelled to cancelled', () => {
    expect(contentOfProjection(projection()).status).toBe('confirmed');
    expect(contentOfProjection(projection({ status: 'tentative' })).status).toBe('confirmed');
    expect(contentOfProjection(projection({ status: 'cancelled' })).status).toBe('cancelled');
    expect(contentOfProjection(projection({ summary: ' Dentist  x ' }))).toMatchObject({
      title: 'Dentist x',
      location: '',
    });
  });
  it('snapshotOfProjection keeps status, etag, updated and sequence (auto_writes.pre_json)', () => {
    const s = snapshotOfProjection(projection({ status: 'tentative', sequence: 3 }));
    expect(s).toMatchObject({
      status: 'tentative',
      etag: '"etag-1"',
      updated: '2026-10-04T08:00:00.000Z',
      sequence: 3,
    });
    expect(contentOfSnapshot(s).status).toBe('confirmed');
    expect(contentOfSnapshot({ ...s, status: 'cancelled' }).status).toBe('cancelled');
    expect(contentOfSnapshot(s)).toMatchObject({ title: 'Dentist', startLocal: FROM.startLocal });
  });
  it('viewOf copies exactly the six view fields', () => {
    expect(Object.keys(viewOf({ ...FROM })).sort()).toEqual(
      ['endLocal', 'location', 'startLocal', 'status', 'timeZone', 'title'].sort(),
    );
  });
});

describe('sameContent / equalContent', () => {
  it('same content ignores the zone and the cleaning; any content difference is drift', () => {
    expect(sameContent(projection(), FROM)).toBe(true);
    expect(sameContent(projection({ timeZone: 'UTC' }), FROM)).toBe(true);
    expect(sameContent(projection({ summary: 'Dentist https://x.example' }), FROM)).toBe(true);
    expect(sameContent(projection({ status: 'tentative' }), FROM)).toBe(false);
    expect(sameContent(projection({ endLocal: '2026-10-07T16:30:00' }), FROM)).toBe(false);
    expect(sameContent(projection({ summary: 'Other' }), FROM)).toBe(false);
    expect(sameContent(projection({ location: 'Clinic' }), FROM)).toBe(false);
  });
  it('equalContent compares all six fields', () => {
    expect(equalContent(FROM, { ...FROM })).toBe(true);
    for (const k of ['title', 'startLocal', 'endLocal', 'timeZone', 'location'] as const)
      expect(equalContent(FROM, { ...FROM, [k]: `${FROM[k]}x` })).toBe(false);
    expect(equalContent(FROM, { ...FROM, status: 'cancelled' })).toBe(false);
  });
});

describe('busyOverlapping (free/busy minus the event’s own block)', () => {
  const slot = { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' };
  it('without an own block: plain overlap', () => {
    expect(
      busyOverlapping([{ startLocal: '2026-10-07T15:30:00', endLocal: '2026-10-07T17:00:00' }], slot, null),
    ).toHaveLength(1);
    expect(
      busyOverlapping([{ startLocal: '2026-10-07T16:00:00', endLocal: '2026-10-07T17:00:00' }], slot, null),
    ).toHaveLength(0);
  });
  it('the own block is removed; a merged block keeps the parts outside it', () => {
    const own = { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' };
    expect(busyOverlapping([{ ...own }], slot, own)).toEqual([]);
    const merged = [{ startLocal: '2026-10-07T14:00:00', endLocal: '2026-10-07T17:00:00' }];
    expect(
      busyOverlapping(merged, { startLocal: '2026-10-07T14:30:00', endLocal: '2026-10-07T16:30:00' }, own),
    ).toEqual([
      { startLocal: '2026-10-07T14:00:00', endLocal: '2026-10-07T15:00:00' },
      { startLocal: '2026-10-07T16:00:00', endLocal: '2026-10-07T17:00:00' },
    ]);
    // a block entirely before the own block stays untouched
    const before = [{ startLocal: '2026-10-07T13:00:00', endLocal: '2026-10-07T14:00:00' }];
    expect(
      busyOverlapping(before, { startLocal: '2026-10-07T13:30:00', endLocal: '2026-10-07T14:30:00' }, own),
    ).toEqual(before);
  });
});
