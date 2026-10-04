// src/main/health/healthHub.ts - AppHealth aggregator (build-plan section 3; owner W1-01; v2 deltas V2-W1-10-main-platform).
import { overallOf } from '../../shared/health';
import type { AppHealth, BridgeStatus, HealthPart, LlmStatus, McpStatus, PairingState } from '../../shared/health';
import type { AutoPausedReason, AutoPolicyState, LlmQuota } from '../../shared/types';
import type { VoiceStatus } from '../../shared/health';
import { ERROR_SEVERITY } from '../../shared/errors';
import type { ErrorCode } from '../../shared/errors';
import type { EpochMs, ProviderId } from '../../shared/types';

export interface HealthPartInput<S extends string> {
  state: S;
  code?: ErrorCode;
}
export interface HealthHub {
  setBridge(s: HealthPartInput<BridgeStatus>): void;
  setPairing(p: PairingState): void;
  setLlm(s: HealthPartInput<LlmStatus> & { provider: ProviderId; model: string }): void;
  setCalendar(s: HealthPartInput<McpStatus>): void;
  setQueue(q: { pending: number; running: number }): void;
  setPaused(b: boolean): void;
  // ---- [V2 ADD] v2-build-plan section 3 seam (C2 3 shapes) - Wave 0 stubs, owner V2-W1-10-main-platform ----
  setVoice(v: HealthPartInput<VoiceStatus>): void;
  setAuto(a: {
    state: AutoPolicyState | 'off';
    expiresAt: EpochMs | null;
    pausedReason: AutoPausedReason | null;
  }): void;
  setLlmQuota(q: LlmQuota | null): void;
  setCalendarUpdates(available: boolean): void;
  get(): AppHealth; // overall = overallOf(parts, severity) after every change ; `since` = time of the last STATE change
  pairing(): PairingState;
  onChange(cb: (h: AppHealth) => void): () => void;
}

/** Every ErrorCode not listed in ERROR_SEVERITY counts as 'attention' (src/shared/errors.ts). */
export function severityOf(code: ErrorCode): 'working' | 'attention' {
  return ERROR_SEVERITY[code] ?? 'attention';
}

/** Boot values, before compose() has learned anything: the app is coming up, Google is simply not configured yet. */
export const INITIAL_BRIDGE_STATUS: BridgeStatus = 'not_started';
export const INITIAL_LLM_STATUS: LlmStatus = 'starting';
export const INITIAL_MCP_STATUS: McpStatus = 'not_configured';

interface MutablePart<S extends string> {
  state: S;
  code: ErrorCode | undefined;
  since: EpochMs;
}

/** Drops the `code` key entirely when there is none, so `get()` never hands out `{ code: undefined }`. */
function freezePart<S extends string>(p: MutablePart<S>): HealthPart<S> {
  return p.code === undefined ? { state: p.state, since: p.since } : { state: p.state, code: p.code, since: p.since };
}

export function createHealthHub(deps: { now: () => EpochMs }): HealthHub {
  const now = (): EpochMs => deps.now();
  const start = now();

  const whatsapp: MutablePart<BridgeStatus> = { state: INITIAL_BRIDGE_STATUS, code: undefined, since: start };
  const llmPart: MutablePart<LlmStatus> = { state: INITIAL_LLM_STATUS, code: undefined, since: start };
  let llmProvider: ProviderId = 'local';
  let llmModel = '';
  const calendar: MutablePart<McpStatus> = { state: INITIAL_MCP_STATUS, code: undefined, since: start };
  let queue: { pending: number; running: number } = { pending: 0, running: 0 };
  let paused = false;
  let pairingState: PairingState = { status: 'unavailable' };

  const listeners = new Set<(h: AppHealth) => void>();
  let lastEmitted = '';

  // [V2] boot values of the four new AppHealth fields (C2 3). updatesAvailable starts FALSE (fail closed: the update surface is
  // available only once the startup guard verified it, B4). None of them feeds overallOf(): the status panel keeps three rows
  // (ARCH-v2 11) and voice / auto / quota / updates are sub-lines only, so they never turn the pill amber on their own.
  const voice: MutablePart<VoiceStatus> = { state: 'off', code: undefined, since: start };
  let auto: AppHealth['auto'] = { state: 'off', expiresAt: null, pausedReason: null };
  let llmQuota: LlmQuota | null = null;
  let calendarUpdatesAvailable = false;

  const snapshot = (): AppHealth => {
    const parts = {
      whatsapp: freezePart(whatsapp),
      llm: {
        ...freezePart(llmPart),
        provider: llmProvider,
        model: llmModel,
        quota: llmQuota === null ? null : { ...llmQuota },
      },
      calendar: { ...freezePart(calendar), updatesAvailable: calendarUpdatesAvailable },
    };
    return {
      overall: overallOf(parts, severityOf),
      whatsapp: parts.whatsapp,
      llm: parts.llm,
      calendar: parts.calendar,
      queue: { ...queue },
      paused,
      voice: freezePart(voice),
      auto: { ...auto },
    };
  };

  /** Emits only when the merged AppHealth actually differs (`since` moves only on a STATE change, so a no-op setter is silent). */
  const publish = (): void => {
    const next = snapshot();
    const key = JSON.stringify(next);
    if (key === lastEmitted) return;
    lastEmitted = key;
    for (const cb of [...listeners]) cb(next);
  };

  /** `since` = time of the last STATE change; a changed ErrorCode alone does not move it. */
  const applyPart = <S extends string>(part: MutablePart<S>, input: HealthPartInput<S>): void => {
    if (part.state !== input.state) {
      part.state = input.state;
      part.since = now();
    }
    part.code = input.code;
  };

  lastEmitted = JSON.stringify(snapshot());

  return {
    setBridge(s) {
      applyPart(whatsapp, s);
      publish();
    },
    setPairing(p) {
      pairingState = p.qrDataUrl === undefined && p.expiresAt === undefined ? { status: p.status } : { ...p };
    },
    setLlm(s) {
      applyPart(llmPart, { state: s.state, code: s.code });
      llmProvider = s.provider;
      llmModel = s.model;
      publish();
    },
    setCalendar(s) {
      applyPart(calendar, s);
      publish();
    },
    setQueue(q) {
      queue = { pending: q.pending, running: q.running };
      publish();
    },
    setPaused(b) {
      paused = b;
      publish();
    },
    // ---- [V2] sub-line setters (C2 3). Each copies its input, so a caller mutating its own object later cannot change get().
    setVoice(v) {
      applyPart(voice, v);
      publish();
    },
    setAuto(a) {
      auto = { state: a.state, expiresAt: a.expiresAt, pausedReason: a.pausedReason };
      publish();
    },
    setLlmQuota(q) {
      llmQuota = q === null ? null : { resetsAt: q.resetsAt, usingOverage: q.usingOverage };
      publish();
    },
    setCalendarUpdates(available) {
      calendarUpdatesAvailable = available;
      publish();
    },
    get: snapshot,
    pairing: () => ({ ...pairingState }),
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
