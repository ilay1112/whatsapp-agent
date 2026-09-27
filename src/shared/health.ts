// src/shared/health.ts
import type { EpochMs, ProviderId } from './types';
import type { ErrorCode } from './errors';

/** Host state machine of ARCHITECTURE 4.3 (+ terminal states). */
export const BRIDGE_STATUSES = [
  'not_started',
  'stopped',
  'starting',
  'needs_pairing',
  'online',
  'reconnecting',
  'backoff',
  'logged_out',
  'outdated',
  'refused',
  'failed',
] as const;
export type BridgeStatus = (typeof BRIDGE_STATUSES)[number];
// not_started = ToS not accepted yet ; refused = spawn invariant / binary blocked ; failed = circuit breaker open

/** /api/pairing/status values of the bridge + host-side additions. */
export const PAIRING_STATUSES = [
  'unavailable',
  'connecting',
  'qr_pending',
  'connected',
  'timeout',
  'error',
  'logged_out',
] as const;
export type PairingStatus = (typeof PAIRING_STATUSES)[number];
export interface PairingState {
  status: PairingStatus; // 'unavailable' = bridge not running / not answering ; 'logged_out' = error + logged-out message
  qrDataUrl?: string; // 'data:image/png;base64,...' fetched by MAIN ; only when status='qr_pending'
  expiresAt?: EpochMs; // bridge expires_at * 1000 ; a hint for the countdown
}

export const MCP_STATUSES = [
  'not_configured',
  'starting',
  'needs_sign_in',
  'signing_in',
  'connected',
  'reconnect_required',
  'port_busy',
  'toolset_mismatch',
  'unavailable',
] as const;
export type McpStatus = (typeof MCP_STATUSES)[number];

export const LLM_STATUSES = [
  'ready',
  'idle',
  'starting',
  'self_testing',
  'downloading',
  'verifying',
  'model_missing',
  'key_missing',
  'key_invalid',
  'consent_missing',
  'quota',
  'degraded',
  'failed',
] as const;
export type LlmStatus = (typeof LLM_STATUSES)[number];
// idle = Local provider configured, llama-server not running (lazy) ; degraded = transient cloud errors, queue backing off

export interface HealthPart<S extends string> {
  state: S;
  code?: ErrorCode;
  since: EpochMs;
}

export interface AppHealth {
  overall: 'ok' | 'working' | 'attention';
  whatsapp: HealthPart<BridgeStatus>;
  llm: HealthPart<LlmStatus> & { provider: ProviderId; model: string }; // model = model id or tier label ; never a path
  calendar: HealthPart<McpStatus>;
  queue: { pending: number; running: number };
  paused: boolean;
}

/** The task's "AgentStatus": derived view for the tray status line and the list header. */
export interface AgentStatus {
  state: 'idle' | 'analysing' | 'paused';
  queue: { pending: number; running: number };
  paused: boolean;
}
export function agentStatusOf(h: AppHealth): AgentStatus {
  return {
    state: h.paused ? 'paused' : h.queue.pending + h.queue.running > 0 ? 'analysing' : 'idle',
    queue: h.queue,
    paused: h.paused,
  };
}

const OK_WA: readonly BridgeStatus[] = ['online'];
const WORKING_WA: readonly BridgeStatus[] = [
  'starting',
  'reconnecting',
  'backoff',
  'needs_pairing',
  'not_started',
  'stopped',
];
const OK_LLM: readonly LlmStatus[] = ['ready', 'idle'];
const WORKING_LLM: readonly LlmStatus[] = ['starting', 'self_testing', 'downloading', 'verifying', 'degraded'];
const OK_CAL: readonly McpStatus[] = ['connected', 'not_configured']; // skipped Google = reply-only mode, not an error
const WORKING_CAL: readonly McpStatus[] = ['starting', 'signing_in', 'needs_sign_in'];

/** Pure; HealthHub calls it after every part change. A part with a `code` always counts as 'attention' unless ERROR_SEVERITY says 'working'. */
export function overallOf(
  h: Pick<AppHealth, 'whatsapp' | 'llm' | 'calendar'>,
  severityOf: (c: ErrorCode) => 'working' | 'attention',
): AppHealth['overall'] {
  const parts: Array<'ok' | 'working' | 'attention'> = [
    h.whatsapp.code
      ? severityOf(h.whatsapp.code)
      : OK_WA.includes(h.whatsapp.state)
        ? 'ok'
        : WORKING_WA.includes(h.whatsapp.state)
          ? 'working'
          : 'attention',
    h.llm.code
      ? severityOf(h.llm.code)
      : OK_LLM.includes(h.llm.state)
        ? 'ok'
        : WORKING_LLM.includes(h.llm.state)
          ? 'working'
          : 'attention',
    h.calendar.code
      ? severityOf(h.calendar.code)
      : OK_CAL.includes(h.calendar.state)
        ? 'ok'
        : WORKING_CAL.includes(h.calendar.state)
          ? 'working'
          : 'attention',
  ];
  return parts.includes('attention') ? 'attention' : parts.includes('working') ? 'working' : 'ok';
}
