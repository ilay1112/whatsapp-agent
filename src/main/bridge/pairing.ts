// src/main/bridge/pairing.ts - pairing poller: /api/pairing/status + qr.png -> PairingState (owner W1-02). S-FETCH via BridgeReadClient, S-CLOCK.
import type { Clock, ClockTimer, Logger } from '../deps';
import type { PairingState, PairingStatus } from '../../shared/health';
import {
  BridgeAuthError,
  BridgeUnreachableError,
  LOGGED_OUT_MESSAGE_RE,
  type BridgePairingStatusWire,
  type BridgeReadClient,
} from './readClient';

export interface PairingPollerDeps {
  read: BridgeReadClient;
  clock: Clock;
  log: Logger;
  pollMs?: number; // default PAIRING_POLL_MS (1_500) while qr_pending / connecting - ARCHITECTURE 4.3
  /** `status:'error'` + LOGGED_OUT_MESSAGE_RE => 'logged_out' (the ONLY source of that state). */
  onState: (p: PairingState) => void;
}
export interface PairingPoller {
  start(): void;
  stop(): void;
  pollNow(): Promise<PairingState>;
  current(): PairingState;
}

// ---------------------------------------------------------------------------------------------------------------------
// implementation (W1-02)
// ---------------------------------------------------------------------------------------------------------------------

/** ARCHITECTURE 4.3 "poll 1.5 s" (bridge-contract.md section 5 recommends 1-2 s). */
export const PAIRING_POLL_MS = 1_500;
/** Once connected, /api/health (launcher, 20 s) is the live-connectivity authority; this poll only has to notice LoggedOut. */
export const PAIRING_CONNECTED_POLL_MS = 15_000;
/** `expires_at` is an UNTRUSTED hint (last rotation + 20 s). Values far outside this window are dropped rather than shown. */
const EXPIRY_PAST_SLACK_MS = 60_000;
const EXPIRY_FUTURE_CAP_MS = 5 * 60_000;

/** Pure mapping of one wire answer (+ optional PNG bytes) to PairingState; qrDataUrl only when status === 'qr_pending'. */
export function toPairingState(
  wire: import('./readClient').BridgePairingStatusWire,
  qrPng: Uint8Array | null,
  nowMs: number,
): PairingState {
  const status: PairingStatus =
    wire.status === 'error' && LOGGED_OUT_MESSAGE_RE.test(wire.message ?? '') ? 'logged_out' : wire.status;
  const state: PairingState = { status };
  if (status === 'qr_pending' && qrPng !== null && qrPng.byteLength > 0) {
    state.qrDataUrl = `data:image/png;base64,${Buffer.from(qrPng).toString('base64')}`;
  }
  if (typeof wire.expires_at === 'number' && Number.isFinite(wire.expires_at)) {
    const expiresAt = Math.round(wire.expires_at * 1000);
    if (expiresAt >= nowMs - EXPIRY_PAST_SLACK_MS && expiresAt <= nowMs + EXPIRY_FUTURE_CAP_MS)
      state.expiresAt = expiresAt;
  }
  return state;
}

function sameState(a: PairingState, b: PairingState): boolean {
  return a.status === b.status && a.qrDataUrl === b.qrDataUrl && a.expiresAt === b.expiresAt;
}

export function createPairingPoller(deps: PairingPollerDeps): PairingPoller {
  const pollMs = deps.pollMs ?? PAIRING_POLL_MS;
  let state: PairingState = { status: 'unavailable' };
  let timer: ClockTimer | null = null;
  let running = false;
  let inFlight: Promise<PairingState> | null = null;
  /** The QR PNG is refetched only when `expires_at` changes (bridge-contract.md section 5). */
  let lastExpires: number | undefined;
  let lastQr: Uint8Array | null = null;

  const emit = (next: PairingState): void => {
    const changed = !sameState(state, next);
    state = next;
    if (changed) deps.onState(next);
  };

  const doPoll = async (): Promise<PairingState> => {
    try {
      const wire: BridgePairingStatusWire = await deps.read.pairingStatus();
      let png: Uint8Array | null = null;
      if (wire.status === 'qr_pending') {
        if (lastQr === null || wire.expires_at !== lastExpires) {
          png = await deps.read.pairingQrPng();
          lastQr = png;
          lastExpires = wire.expires_at;
        } else {
          png = lastQr;
        }
      } else {
        lastQr = null;
        lastExpires = undefined;
      }
      emit(toPairingState(wire, png, deps.clock.now()));
    } catch (err) {
      // Metadata only: the bridge's `message` field is untrusted and never logged.
      const reason =
        err instanceof BridgeAuthError ? 'auth' : err instanceof BridgeUnreachableError ? 'unreachable' : 'other';
      deps.log.warn('pairing_poll_failed', { reason });
      lastQr = null;
      lastExpires = undefined;
      emit({ status: 'unavailable' });
    }
    return state;
  };

  const pollOnce = (): Promise<PairingState> => {
    if (inFlight !== null) return inFlight;
    const p = doPoll().finally(() => {
      inFlight = null;
    });
    inFlight = p;
    return p;
  };

  const schedule = (): void => {
    if (!running) return;
    const slow = state.status === 'connected' || state.status === 'logged_out';
    timer = deps.clock.setTimeout(
      () => {
        void tick();
      },
      slow ? PAIRING_CONNECTED_POLL_MS : pollMs,
    );
  };

  const tick = async (): Promise<void> => {
    await pollOnce();
    schedule();
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      void tick();
    },
    stop(): void {
      running = false;
      if (timer !== null) {
        deps.clock.clearTimeout(timer);
        timer = null;
      }
    },
    pollNow: (): Promise<PairingState> => pollOnce(),
    current: (): PairingState => state,
  };
}
