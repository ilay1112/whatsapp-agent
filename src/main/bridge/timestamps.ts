// src/main/bridge/timestamps.ts
// Frozen signatures from docs/specs/contracts.md section 12 (owner W1-03). Pure; no I/O, no Date parsing of free text.
import type { EpochMs } from '../../shared/types';

/** go-sqlite3 text form `YYYY-MM-DD HH:MM:SS[.f{1,9}][±HH:MM|±HHMM|Z]` and the RFC 3339 `T` form.
 *  mattn/go-sqlite3 writes `time.Time` as '2006-01-02 15:04:05.999999999-07:00' with trailing fraction zeros trimmed,
 *  so 1-9 fractional digits must all be accepted (truncated, never rounded, to ms). */
const TEXT_TS_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:(Z)|([+-])(\d{2}):?(\d{2}))?$/;

/** Integer epoch values below this are read as SECONDS, at or above it as MILLISECONDS (1973-03-03 in ms, year 5138 in s). */
const EPOCH_MS_THRESHOLD = 1e11;

/** Anything outside this window is a parse failure rather than a silently wrong instant (1970-01-01 .. 2100-01-01). */
const MIN_EPOCH_MS = 0;
const MAX_EPOCH_MS = Date.UTC(2100, 0, 1);

function fromEpochNumber(n: number): EpochMs | null {
  if (!Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  const ms = abs < EPOCH_MS_THRESHOLD ? Math.trunc(n * 1000) : Math.trunc(n);
  if (ms < MIN_EPOCH_MS || ms > MAX_EPOCH_MS) return null;
  return ms;
}

/** Accepts the go-sqlite3 text form 'YYYY-MM-DD HH:MM:SS[.f{1,9}][+HH:MM|-HH:MM|Z]' (space separator, 1-9 fractional digits, truncated to ms),
 *  the RFC 3339 'T' form, and integer epoch s / ms (as a number or as an all-digit string).
 *  A text form WITHOUT a zone suffix is read as UTC (the bridge always writes one; this is the defensive fallback).
 *  null = unparseable (=> backlog + BRIDGE_TS_FORMAT streak counter in bridge/ingest.ts). */
export function parseBridgeTs(raw: string | number | null): EpochMs | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return fromEpochNumber(raw);
  if (typeof raw !== 'string') return null;

  const s = raw.trim();
  if (s === '') return null;

  // integer epoch stored as TEXT (a TIMESTAMP column is typeless in SQLite)
  if (/^-?\d{1,14}$/.test(s)) return fromEpochNumber(Number(s));

  const m = TEXT_TS_RE.exec(s);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;

  // truncate (never round) the fraction to milliseconds; '.5' means 500 ms
  const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0;

  let utc = Date.UTC(year, month - 1, day, hour, minute, Math.min(second, 59), ms);
  if (!Number.isFinite(utc)) return null;
  // reject impossible calendar dates that Date.UTC silently rolls over (2026-02-31)
  const back = new Date(utc);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null;

  if (m[9]) {
    const offsetMinutes = Number(m[10]) * 60 + Number(m[11]);
    if (Number(m[10]) > 23 || Number(m[11]) > 59) return null;
    utc += (m[9] === '-' ? offsetMinutes : -offsetMinutes) * 60_000;
  }
  if (utc < MIN_EPOCH_MS || utc > MAX_EPOCH_MS) return null;
  return utc;
}
