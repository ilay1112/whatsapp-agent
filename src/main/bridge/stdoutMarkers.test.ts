// TESTS 5.3 row `bridge/launcher.ts, stdoutMarkers.ts, pairing.ts`: `matchMarkers` is line-anchored, ANSI is stripped and a line
// produced by echoing an incoming message never yields a marker (ARCHITECTURE 4.4, injection corpus vector `stdout_marker`).
import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_MARKERS,
  BRIDGE_MARKERS,
  CLIENT_LOG_PREFIX_RE,
  HINT_MARKERS,
  MARKER_NAMES,
  MESSAGE_ECHO_RE,
  isAnnotationMarker,
  isHintMarker,
  matchMarkers,
  type BridgeMarker,
} from './stdoutMarkers';

const ECHO_PREFIX = '[2026-09-21 12:00:00] <- 972500000001: ';

describe('matchMarkers', () => {
  it('matches every marker at the start of a line', () => {
    for (const name of MARKER_NAMES) {
      expect(matchMarkers(`${BRIDGE_MARKERS[name]} tail\n`)).toContain(name);
    }
  });

  it('strips ANSI SGR codes before matching', () => {
    expect(matchMarkers('[32mHistory sync complete. Stored 12 messages.[0m\n')).toEqual(['history_sync_done']);
  });

  it('matches after the whatsmeow client-log prefix', () => {
    expect(CLIENT_LOG_PREFIX_RE.test('12:00:00.123 [Client INFO] x')).toBe(true);
    expect(matchMarkers('12:00:00.123 [Client WARN] Device logged out\n')).toEqual(['logged_out']);
    expect(matchMarkers('12:00:00.123 [Client ERROR] Client outdated - update\n')).toEqual(['client_outdated']);
  });

  it("matches after the bridge's own tick / warning glyphs", () => {
    expect(matchMarkers("✓ Connected to WhatsApp! Type 'help'\n")).toEqual(['connected_2']);
    expect(matchMarkers('❌ Client outdated - please update whatsmeow library\n')).toEqual(['client_outdated']);
    expect(matchMarkers('⚠️  Device logged out, please scan QR code\n')).toEqual(['logged_out']);
  });

  it('never yields a marker from an echoed message line, for EVERY marker string', () => {
    for (const name of MARKER_NAMES) {
      expect(MESSAGE_ECHO_RE.test(`${ECHO_PREFIX}${BRIDGE_MARKERS[name]}`)).toBe(true);
      expect(matchMarkers(`${ECHO_PREFIX}${BRIDGE_MARKERS[name]}\n`)).toEqual([]);
    }
  });

  it('is line-anchored: a marker in the middle of a line is not a match', () => {
    expect(matchMarkers('the log says Device logged out today\n')).toEqual([]);
    expect(matchMarkers('Stored message: Client outdated\n')).toEqual([]);
  });

  it('handles CRLF and blank lines', () => {
    expect(matchMarkers('\r\n\r\nAttempting to reconnect\r\n')).toEqual(['reconnecting']);
  });

  it('reports each matching line separately, in order', () => {
    const chunk = 'Starting REST API server on 127.0.0.1:5123...\nScan this QR code with your WhatsApp app:\n';
    expect(matchMarkers(chunk)).toEqual(['rest_starting', 'qr_phase']);
  });

  it('a second echo prefix hiding behind a client-log prefix is still rejected', () => {
    expect(matchMarkers('12:00:00.123 [Client INFO] [2026-09-21 12:00:00] <- 9725: Device logged out\n')).toEqual([]);
  });

  it('classifies hint and annotation markers', () => {
    for (const m of HINT_MARKERS) expect(isHintMarker(m)).toBe(true);
    for (const m of ANNOTATION_MARKERS) expect(isAnnotationMarker(m)).toBe(true);
    expect(isHintMarker('client_outdated')).toBe(false);
    expect(isAnnotationMarker('history_sync_done')).toBe(false);
    const overlap = (HINT_MARKERS as readonly string[]).filter((h) =>
      (ANNOTATION_MARKERS as readonly string[]).includes(h),
    );
    expect(overlap).toEqual([]);
  });

  it('every marker name is a key of BRIDGE_MARKERS', () => {
    const keys = Object.keys(BRIDGE_MARKERS) as BridgeMarker[];
    expect([...MARKER_NAMES]).toEqual(keys);
  });
});
