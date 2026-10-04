// TESTS 5.3 row `bridge/launcher.ts, stdoutMarkers.ts, pairing.ts`: 1.5 s poll, QR refetched only when expires_at changes,
// `logged_out` ONLY from pairing/status, and the PNG turned into a data: URL by MAIN.
import { describe, expect, it, vi } from 'vitest';
import { createSeededRandom, createVirtualClock } from '../../../tests/helpers/virtualClock.ts';
import type { Logger } from '../deps';
import { BridgeUnreachableError, type BridgePairingStatusWire, type BridgeReadClient } from './readClient';
import { PAIRING_CONNECTED_POLL_MS, PAIRING_POLL_MS, createPairingPoller, toPairingState } from './pairing';
import { FAKE_QR_PNG_BASE64 } from '../../../tests/fakes/fake-bridge.ts';

const NOW = Date.UTC(2026, 8, 21, 9, 0, 0);
const PNG = new Uint8Array(Buffer.from(FAKE_QR_PNG_BASE64, 'base64'));

const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

function nullLogger(): Logger {
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  return log;
}

describe('toPairingState', () => {
  it('passes the bridge phases through unchanged', () => {
    for (const status of ['connecting', 'qr_pending', 'connected', 'timeout'] as const) {
      expect(toPairingState({ status }, null, NOW).status).toBe(status);
    }
  });

  it('error + the logged-out message is the ONLY source of logged_out', () => {
    expect(
      toPairingState({ status: 'error', message: 'Device was logged out -- restart the bridge' }, null, NOW).status,
    ).toBe('logged_out');
    expect(toPairingState({ status: 'error', message: 'dial tcp: connection refused' }, null, NOW).status).toBe(
      'error',
    );
    expect(toPairingState({ status: 'error' }, null, NOW).status).toBe('error');
  });

  it('builds the data: URL only while qr_pending', () => {
    const pending = toPairingState({ status: 'qr_pending', qr_present: true }, PNG, NOW);
    expect(pending.qrDataUrl).toBe(`data:image/png;base64,${FAKE_QR_PNG_BASE64}`);
    expect(toPairingState({ status: 'connected' }, PNG, NOW).qrDataUrl).toBeUndefined();
    expect(toPairingState({ status: 'qr_pending' }, null, NOW).qrDataUrl).toBeUndefined();
    expect(toPairingState({ status: 'qr_pending' }, new Uint8Array(0), NOW).qrDataUrl).toBeUndefined();
  });

  it('accepts a plausible expires_at hint and drops an implausible one', () => {
    const soon = Math.floor((NOW + 18_000) / 1000);
    expect(toPairingState({ status: 'qr_pending', expires_at: soon }, PNG, NOW).expiresAt).toBe(soon * 1000);
    expect(toPairingState({ status: 'qr_pending', expires_at: 0 }, PNG, NOW).expiresAt).toBeUndefined();
    expect(
      toPairingState({ status: 'qr_pending', expires_at: Math.floor(NOW / 1000) + 86_400 }, PNG, NOW).expiresAt,
    ).toBeUndefined();
    expect(toPairingState({ status: 'qr_pending', expires_at: Number.NaN }, PNG, NOW).expiresAt).toBeUndefined();
  });
});

interface Script {
  read: BridgeReadClient;
  statusCalls: number;
  qrCalls: number;
  set(next: BridgePairingStatusWire): void;
  fail(err: Error | null): void;
}
function scriptedRead(initial: BridgePairingStatusWire): Script {
  let wire = initial;
  let failure: Error | null = null;
  const script: Script = {
    statusCalls: 0,
    qrCalls: 0,
    set: (next) => {
      wire = next;
    },
    fail: (err) => {
      failure = err;
    },
    read: {
      getMedia: () => Promise.reject(new Error('not used')), // [V2] C2 12
      health: () => Promise.reject(new Error('not used')),
      pairingStatus: async () => {
        script.statusCalls += 1;
        if (failure !== null) throw failure;
        return wire;
      },
      pairingQrPng: async () => {
        script.qrCalls += 1;
        return PNG;
      },
    },
  };
  return script;
}

describe('createPairingPoller', () => {
  it('polls every 1.5 s while pairing and only emits on change', async () => {
    const clock = createVirtualClock(NOW);
    const script = scriptedRead({
      status: 'qr_pending',
      qr_present: true,
      expires_at: Math.floor((NOW + 18_000) / 1000),
    });
    const seen: string[] = [];
    const poller = createPairingPoller({
      read: script.read,
      clock,
      log: nullLogger(),
      onState: (p) => seen.push(p.status),
    });
    expect(PAIRING_POLL_MS).toBe(1_500);
    poller.start();
    await flush();
    expect(poller.current().status).toBe('qr_pending');
    expect(script.statusCalls).toBe(1);
    expect(script.qrCalls).toBe(1);

    await clock.advance(PAIRING_POLL_MS);
    await flush();
    expect(script.statusCalls).toBe(2);
    expect(script.qrCalls).toBe(1); // expires_at unchanged => the PNG is NOT refetched
    expect(seen).toEqual(['qr_pending']); // no state change => no second emit

    script.set({ status: 'qr_pending', qr_present: true, expires_at: Math.floor((NOW + 38_000) / 1000) });
    await clock.advance(PAIRING_POLL_MS);
    await flush();
    expect(script.qrCalls).toBe(2); // expires_at changed => refetch
    poller.stop();
    expect(clock.pendingCount()).toBe(0);
  });

  it('slows down once connected', async () => {
    const clock = createVirtualClock(NOW);
    const script = scriptedRead({ status: 'connected' });
    const poller = createPairingPoller({ read: script.read, clock, log: nullLogger(), onState: () => undefined });
    poller.start();
    await flush();
    expect(script.statusCalls).toBe(1);
    await clock.advance(PAIRING_POLL_MS);
    await flush();
    expect(script.statusCalls).toBe(1);
    await clock.advance(PAIRING_CONNECTED_POLL_MS - PAIRING_POLL_MS);
    await flush();
    expect(script.statusCalls).toBe(2);
    poller.stop();
  });

  it('an unreachable bridge becomes `unavailable` and polling continues', async () => {
    const clock = createVirtualClock(NOW);
    const script = scriptedRead({ status: 'qr_pending', qr_present: true });
    const log = nullLogger();
    const seen: string[] = [];
    const poller = createPairingPoller({
      read: script.read,
      clock,
      log,
      onState: (p) => seen.push(p.status),
      pollMs: 500,
    });
    poller.start();
    await flush();
    script.fail(new BridgeUnreachableError('down'));
    await clock.advance(500);
    await flush();
    expect(poller.current()).toEqual({ status: 'unavailable' });
    expect(log.warn).toHaveBeenCalledWith('pairing_poll_failed', { reason: 'unreachable' });
    script.fail(null);
    await clock.advance(500);
    await flush();
    expect(poller.current().status).toBe('qr_pending');
    expect(seen).toEqual(['qr_pending', 'unavailable', 'qr_pending']);
    poller.stop();
  });

  it('logs a non-Error rejection without leaking it', async () => {
    const clock = createVirtualClock(NOW);
    const script = scriptedRead({ status: 'connected' });
    const log = nullLogger();
    const poller = createPairingPoller({ read: script.read, clock, log, onState: () => undefined });
    script.fail({ toString: () => 'sneaky' } as unknown as Error);
    poller.start();
    await flush();
    expect(log.warn).toHaveBeenCalledWith('pairing_poll_failed', { reason: 'other' });
    poller.stop();
  });

  it('pollNow() is serialised with the timer poll and start() is idempotent', async () => {
    const clock = createVirtualClock(NOW);
    const script = scriptedRead({ status: 'connecting' });
    const poller = createPairingPoller({ read: script.read, clock, log: nullLogger(), onState: () => undefined });
    poller.start();
    poller.start();
    const a = poller.pollNow();
    const b = poller.pollNow();
    await Promise.all([a, b]);
    expect(script.statusCalls).toBe(1);
    poller.stop();
    poller.stop();
    expect(clock.pendingCount()).toBe(0);
    // the seeded RandomSource is unrelated here, but keeps the helper import honest for jitter-bearing tests
    expect(createSeededRandom(7).bytes(2)).toHaveLength(2);
  });
});
