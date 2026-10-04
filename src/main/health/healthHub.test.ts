// src/main/health/healthHub.test.ts - TESTS 5.3 "HealthHub merge truth table -> overall" (owner W1-01).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHealthHub, severityOf } from './healthHub';
import type { HealthHub } from './healthHub';
import { BRIDGE_STATUSES, LLM_STATUSES, MCP_STATUSES, agentStatusOf, overallOf } from '../../shared/health';
import type { AppHealth, BridgeStatus, LlmStatus, McpStatus } from '../../shared/health';
import { ERROR_CODES, ERROR_SEVERITY } from '../../shared/errors';
import type { ErrorCode } from '../../shared/errors';

// Independently written oracle for the three per-part verdicts (mirrors CONTRACTS section 3 prose, not its code).
const WA_OK: readonly BridgeStatus[] = ['online'];
const WA_WORKING: readonly BridgeStatus[] = [
  'starting',
  'reconnecting',
  'backoff',
  'needs_pairing',
  'not_started',
  'stopped',
];
const LLM_OK: readonly LlmStatus[] = ['ready', 'idle'];
const LLM_WORKING: readonly LlmStatus[] = ['starting', 'self_testing', 'downloading', 'verifying', 'degraded'];
const CAL_OK: readonly McpStatus[] = ['connected', 'not_configured'];
const CAL_WORKING: readonly McpStatus[] = ['starting', 'signing_in', 'needs_sign_in'];

function verdict<S extends string>(
  state: S,
  code: ErrorCode | undefined,
  ok: readonly S[],
  working: readonly S[],
): 'ok' | 'working' | 'attention' {
  if (code !== undefined) return ERROR_SEVERITY[code] ?? 'attention';
  if (ok.includes(state)) return 'ok';
  if (working.includes(state)) return 'working';
  return 'attention';
}
const worst = (parts: Array<'ok' | 'working' | 'attention'>): AppHealth['overall'] =>
  parts.includes('attention') ? 'attention' : parts.includes('working') ? 'working' : 'ok';

let clockNow = 1_000_000;
const now = (): number => clockNow;
let hub: HealthHub;

beforeEach(() => {
  clockNow = 1_000_000;
  hub = createHealthHub({ now });
});

describe('createHealthHub - boot state', () => {
  it('starts as "working": bridge not started, llm starting, Google not configured', () => {
    const h = hub.get();
    expect(h.whatsapp).toEqual({ state: 'not_started', since: 1_000_000 });
    expect(h.llm).toEqual({ state: 'starting', since: 1_000_000, provider: 'local', model: '', quota: null }); // [V2] + quota
    expect(h.calendar).toEqual({ state: 'not_configured', since: 1_000_000, updatesAvailable: false }); // [V2] fail closed
    expect(h.queue).toEqual({ pending: 0, running: 0 });
    expect(h.paused).toBe(false);
    expect(h.overall).toBe('working');
  });

  it('never hands out a `code` key when there is no error code', () => {
    hub.setBridge({ state: 'online' });
    expect(Object.keys(hub.get().whatsapp).sort()).toEqual(['since', 'state']);
  });

  it('hands out copies - mutating the snapshot does not corrupt the hub', () => {
    const first = hub.get();
    first.queue.pending = 99;
    first.paused = true;
    expect(hub.get().queue.pending).toBe(0);
    expect(hub.get().paused).toBe(false);
  });
});

describe('merge truth table -> overall', () => {
  it('agrees with the oracle over every (bridge x llm x calendar) state triple', () => {
    let checked = 0;
    for (const wa of BRIDGE_STATUSES) {
      for (const llm of LLM_STATUSES) {
        for (const cal of MCP_STATUSES) {
          const local = createHealthHub({ now });
          local.setBridge({ state: wa });
          local.setLlm({ state: llm, provider: 'claude', model: 'm' });
          local.setCalendar({ state: cal });
          const expected = worst([
            verdict(wa, undefined, WA_OK, WA_WORKING),
            verdict(llm, undefined, LLM_OK, LLM_WORKING),
            verdict(cal, undefined, CAL_OK, CAL_WORKING),
          ]);
          expect(local.get().overall, `${wa}/${llm}/${cal}`).toBe(expected);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(BRIDGE_STATUSES.length * LLM_STATUSES.length * MCP_STATUSES.length);
  });

  it('a code overrides the state verdict, with ERROR_SEVERITY deciding working vs attention', () => {
    for (const code of ERROR_CODES) {
      const local = createHealthHub({ now });
      local.setBridge({ state: 'online', code }); // 'online' alone would be 'ok'
      local.setLlm({ state: 'ready', provider: 'local', model: 'm' });
      local.setCalendar({ state: 'connected' });
      expect(local.get().overall, code).toBe(severityOf(code));
    }
  });

  it('every ErrorCode not listed in ERROR_SEVERITY counts as attention', () => {
    expect(severityOf('CLOUD_UNAVAILABLE')).toBe('working');
    expect(severityOf('LLM_NOT_READY')).toBe('working');
    expect(severityOf('CAL_PORT_BUSY')).toBe('attention');
    expect(severityOf('BRIDGE_CRASH_LOOP')).toBe('attention');
  });

  it('a skipped Google account (not_configured) is reply-only mode, not an error', () => {
    hub.setBridge({ state: 'online' });
    hub.setLlm({ state: 'ready', provider: 'local', model: 'm' });
    hub.setCalendar({ state: 'not_configured' });
    expect(hub.get().overall).toBe('ok');
  });

  it('queue and paused never change `overall`', () => {
    hub.setBridge({ state: 'online' });
    hub.setLlm({ state: 'ready', provider: 'local', model: 'm' });
    hub.setCalendar({ state: 'connected' });
    hub.setQueue({ pending: 7, running: 1 });
    hub.setPaused(true);
    const h = hub.get();
    expect(h.overall).toBe('ok');
    expect(h.queue).toEqual({ pending: 7, running: 1 });
    expect(h.paused).toBe(true);
  });

  it('uses the shared overallOf() so the renderer and the tray cannot drift', () => {
    hub.setBridge({ state: 'backoff' });
    hub.setLlm({ state: 'ready', provider: 'local', model: 'm' });
    hub.setCalendar({ state: 'connected' });
    const h = hub.get();
    expect(h.overall).toBe(overallOf(h, severityOf));
  });

  it('feeds agentStatusOf for the tray status line', () => {
    hub.setQueue({ pending: 2, running: 1 });
    expect(agentStatusOf(hub.get()).state).toBe('analysing');
    hub.setPaused(true);
    expect(agentStatusOf(hub.get()).state).toBe('paused');
    hub.setPaused(false);
    hub.setQueue({ pending: 0, running: 0 });
    expect(agentStatusOf(hub.get()).state).toBe('idle');
  });
});

describe('`since` = time of the last STATE change', () => {
  it('moves only when the state itself changes', () => {
    hub.setBridge({ state: 'online' });
    expect(hub.get().whatsapp.since).toBe(1_000_000);

    clockNow = 1_005_000;
    hub.setBridge({ state: 'online' }); // same state, no code
    expect(hub.get().whatsapp.since).toBe(1_000_000);

    hub.setBridge({ state: 'online', code: 'WA_OFFLINE' }); // code changed, state did not
    expect(hub.get().whatsapp.since).toBe(1_000_000);
    expect(hub.get().whatsapp.code).toBe('WA_OFFLINE');

    clockNow = 1_009_000;
    hub.setBridge({ state: 'reconnecting' });
    expect(hub.get().whatsapp.since).toBe(1_009_000);
    expect(hub.get().whatsapp.code).toBeUndefined();
  });

  it('tracks llm and calendar independently, and provider/model changes do not move `since`', () => {
    clockNow = 2_000;
    hub.setLlm({ state: 'ready', provider: 'local', model: 'qwen' });
    clockNow = 3_000;
    hub.setLlm({ state: 'ready', provider: 'claude', model: 'claude-haiku-4-5' });
    clockNow = 4_000;
    hub.setCalendar({ state: 'connected' });
    const h = hub.get();
    expect(h.llm.since).toBe(2_000);
    expect(h.llm.provider).toBe('claude');
    expect(h.llm.model).toBe('claude-haiku-4-5');
    expect(h.calendar.since).toBe(4_000);
  });
});

describe('change events', () => {
  it('fires onChange once per real change and stays silent on a no-op setter', () => {
    const seen: AppHealth[] = [];
    hub.onChange((h) => seen.push(h));

    hub.setBridge({ state: 'online' });
    hub.setBridge({ state: 'online' }); // identical -> silent
    hub.setQueue({ pending: 0, running: 0 }); // identical -> silent
    hub.setPaused(false); // identical -> silent
    hub.setQueue({ pending: 1, running: 0 });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.whatsapp.state).toBe('online');
    expect(seen[1]?.queue).toEqual({ pending: 1, running: 0 });
  });

  it('fires when only the ErrorCode changes', () => {
    const cb = vi.fn();
    hub.onChange(cb);
    hub.setBridge({ state: 'online' });
    cb.mockClear();
    hub.setBridge({ state: 'online', code: 'WA_OFFLINE' });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes', () => {
    const cb = vi.fn();
    const off = hub.onChange(cb);
    hub.setPaused(true);
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    hub.setPaused(false);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a listener added during a notification is not called for that same event', () => {
    const late = vi.fn();
    hub.onChange(() => hub.onChange(late));
    hub.setPaused(true);
    expect(late).not.toHaveBeenCalled();
    hub.setPaused(false);
    expect(late).toHaveBeenCalledTimes(1);
  });
});

describe('pairing', () => {
  it('stores the pairing state separately from AppHealth and hands out copies', () => {
    expect(hub.pairing()).toEqual({ status: 'unavailable' });
    hub.setPairing({ status: 'qr_pending', qrDataUrl: 'data:image/png;base64,AAAA', expiresAt: 1_060_000 });
    expect(hub.pairing()).toEqual({
      status: 'qr_pending',
      qrDataUrl: 'data:image/png;base64,AAAA',
      expiresAt: 1_060_000,
    });
    const copy = hub.pairing();
    copy.status = 'connected';
    expect(hub.pairing().status).toBe('qr_pending');
  });

  it('drops the optional keys when the new state carries none (no stale QR)', () => {
    hub.setPairing({ status: 'qr_pending', qrDataUrl: 'data:image/png;base64,AAAA', expiresAt: 1_060_000 });
    hub.setPairing({ status: 'connected' });
    expect(hub.pairing()).toEqual({ status: 'connected' });
  });

  it('does not emit an AppHealth change (pairing is pushed on its own channel)', () => {
    const cb = vi.fn();
    hub.onChange(cb);
    hub.setPairing({ status: 'connecting' });
    expect(cb).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [V2] C2 3: voice / auto / llm.quota / calendar.updatesAvailable are sub-lines only - overallOf() is unchanged (ARCH-v2 11).
// ---------------------------------------------------------------------------------------------------------------------
describe('[V2] sub-line setters', () => {
  const allOk = (): void => {
    hub.setBridge({ state: 'online' });
    hub.setLlm({ state: 'ready', provider: 'local', model: 'tiny' });
    hub.setCalendar({ state: 'connected' });
  };

  it('boot values fail closed: voice off, auto off, no quota, updates unavailable', () => {
    const h = hub.get();
    expect(h.voice).toEqual({ state: 'off', since: 1_000_000 });
    expect(h.auto).toEqual({ state: 'off', expiresAt: null, pausedReason: null });
    expect(h.llm.quota).toBeNull();
    expect(h.calendar.updatesAvailable).toBe(false);
  });

  it('setVoice moves `since` only on a state change, carries a code, and never changes overall', () => {
    allOk();
    expect(hub.get().overall).toBe('ok');
    clockNow = 2_000_000;
    hub.setVoice({ state: 'failed', code: 'VOICE_LOCAL_FAILED' });
    expect(hub.get().voice).toEqual({ state: 'failed', code: 'VOICE_LOCAL_FAILED', since: 2_000_000 });
    expect(hub.get().overall).toBe('ok');
    clockNow = 3_000_000;
    hub.setVoice({ state: 'failed' });
    expect(hub.get().voice).toEqual({ state: 'failed', since: 2_000_000 });
    for (const state of ['off', 'downloading', 'ready', 'transcribing', 'failed'] as const) {
      hub.setVoice({ state });
      expect(hub.get().overall).toBe('ok');
    }
  });

  it('setAuto reports the policy line and never changes overall', () => {
    allOk();
    hub.setAuto({ state: 'paused', expiresAt: 9_000_000, pausedReason: 'circuit_breaker_rate' });
    expect(hub.get().auto).toEqual({ state: 'paused', expiresAt: 9_000_000, pausedReason: 'circuit_breaker_rate' });
    expect(hub.get().overall).toBe('ok');
    hub.setAuto({ state: 'on', expiresAt: 9_000_000, pausedReason: null });
    expect(hub.get().auto.state).toBe('on');
  });

  it('setLlmQuota sets and clears llm.quota; overall is unaffected', () => {
    allOk();
    hub.setLlmQuota({ resetsAt: 5_000_000, usingOverage: false });
    expect(hub.get().llm.quota).toEqual({ resetsAt: 5_000_000, usingOverage: false });
    expect(hub.get().overall).toBe('ok');
    hub.setLlmQuota(null);
    expect(hub.get().llm.quota).toBeNull();
  });

  it('setCalendarUpdates toggles calendar.updatesAvailable without a code on the calendar part', () => {
    allOk();
    hub.setCalendarUpdates(true);
    expect(hub.get().calendar).toEqual({ state: 'connected', since: 1_000_000, updatesAvailable: true });
    hub.setCalendarUpdates(false);
    expect(hub.get().calendar.updatesAvailable).toBe(false);
    expect(hub.get().calendar.code).toBeUndefined();
    expect(hub.get().overall).toBe('ok');
  });

  it('each setter emits once on a real change and stays silent on a repeat', () => {
    const cb = vi.fn();
    hub.onChange(cb);
    hub.setVoice({ state: 'ready' });
    hub.setVoice({ state: 'ready' });
    hub.setAuto({ state: 'shadow', expiresAt: 1, pausedReason: null });
    hub.setAuto({ state: 'shadow', expiresAt: 1, pausedReason: null });
    hub.setLlmQuota({ resetsAt: null, usingOverage: true });
    hub.setLlmQuota({ resetsAt: null, usingOverage: true });
    hub.setCalendarUpdates(true);
    hub.setCalendarUpdates(true);
    expect(cb).toHaveBeenCalledTimes(4);
  });

  it('inputs are copied: mutating the caller object or the returned snapshot changes nothing', () => {
    const quota = { resetsAt: 1, usingOverage: false as boolean | null };
    const auto = { state: 'on' as const, expiresAt: 1 as number | null, pausedReason: null };
    hub.setLlmQuota(quota);
    hub.setAuto(auto);
    quota.usingOverage = true;
    auto.expiresAt = 99;
    const h = hub.get();
    expect(h.llm.quota?.usingOverage).toBe(false);
    expect(h.auto.expiresAt).toBe(1);
    h.llm.quota!.resetsAt = 42;
    h.auto.state = 'off';
    expect(hub.get().llm.quota?.resetsAt).toBe(1);
    expect(hub.get().auto.state).toBe('on');
  });
});
