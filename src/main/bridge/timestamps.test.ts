// TESTS 5.3 row `bridge/timestamps.ts`. Pure table test; no I/O.
import { describe, expect, it } from 'vitest';
import { parseBridgeTs } from './timestamps';
import { formatGoSqlite3 } from '../../../tests/fakes/fake-bridge-db';

const T = Date.UTC(2026, 8, 21, 17, 15, 3); // 2026-09-21 20:15:03 +03:00

describe('parseBridgeTs - go-sqlite3 text form', () => {
  it.each([
    ['2026-09-21 20:15:03+03:00', T],
    ['2026-09-21 20:15:03.5+03:00', T + 500],
    ['2026-09-21 20:15:03.12+03:00', T + 120],
    ['2026-09-21 20:15:03.123+03:00', T + 123],
    ['2026-09-21 20:15:03.1234+03:00', T + 123],
    ['2026-09-21 20:15:03.123456789+03:00', T + 123], // nanoseconds, truncated to ms
    ['2026-09-21 20:15:03.999999999+03:00', T + 999], // truncated, never rounded up to the next second
    ['2026-09-21 10:15:03.123-07:00', T + 123],
    ['2026-09-21 17:15:03Z', T],
    ['2026-09-21 20:15:03+0300', T], // offset without the colon
  ])('parses %s', (raw, expected) => {
    expect(parseBridgeTs(raw)).toBe(expected);
  });

  it('reads a text form without a zone suffix as UTC', () => {
    expect(parseBridgeTs('2026-09-21 17:15:03')).toBe(T);
  });

  it('round-trips what the fake bridge DB writes, in both hemispheres', () => {
    const d = new Date(T + 123);
    expect(parseBridgeTs(formatGoSqlite3(d, 180))).toBe(T + 123);
    expect(parseBridgeTs(formatGoSqlite3(d, -420))).toBe(T + 123);
    expect(parseBridgeTs(formatGoSqlite3(d, 0))).toBe(T + 123);
  });
});

describe('parseBridgeTs - RFC 3339 and epoch forms', () => {
  it.each([
    ['2026-09-21T20:15:03+03:00', T],
    ['2026-09-21T17:15:03Z', T],
    ['2026-09-21T17:15:03.123Z', T + 123],
  ])('parses the T form %s', (raw, expected) => {
    expect(parseBridgeTs(raw)).toBe(expected);
  });

  it('parses integer epoch seconds and milliseconds', () => {
    expect(parseBridgeTs(Math.floor(T / 1000))).toBe(Math.floor(T / 1000) * 1000);
    expect(parseBridgeTs(T)).toBe(T);
  });

  it('parses an integer epoch stored as TEXT', () => {
    expect(parseBridgeTs(String(Math.floor(T / 1000)))).toBe(Math.floor(T / 1000) * 1000);
    expect(parseBridgeTs(String(T))).toBe(T);
  });

  it('truncates a fractional epoch value', () => {
    expect(parseBridgeTs(T / 1000 + 0.75)).toBe(T + 750);
  });
});

describe('parseBridgeTs - unparseable values yield null', () => {
  it.each([
    [null],
    [''],
    ['   '],
    ['not-a-timestamp'],
    ['2026-13-01 10:00:00Z'], // month 13
    ['2026-02-31 10:00:00Z'], // calendar roll-over
    ['2026-09-21 25:00:00Z'], // hour 25
    ['2026-09-21 10:61:00Z'], // minute 61
    ['2026-09-21 20:15:03+99:00'], // impossible offset
    ['2026-09-21'], // date only
    ['20:15:03'], // time only
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [-1],
    [Date.UTC(2200, 0, 1)], // out of the accepted window
  ])('rejects %p', (raw) => {
    expect(parseBridgeTs(raw as string | number | null)).toBeNull();
  });

  it('rejects a value that is not a string or number', () => {
    expect(parseBridgeTs({ nope: true } as unknown as string)).toBeNull();
  });
});
