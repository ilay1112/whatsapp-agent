// src/main/bridge/sendClient.ts   (imported ONLY by compose.ts and, type-only, by exec/**)
// Frozen signatures pasted verbatim from docs/specs/contracts.md (owner W1-02); bodies implemented by W1-02.
import type { FetchFn } from '../deps';
/** POST /api/send body. The wire format ALSO accepts media_path, quoted_message_id, quoted_sender_jid, quoted_content -
 *  they are NEVER sent by this app; this type has exactly two keys and the client serialises exactly these two keys. */
export interface BridgeSendRequest {
  recipient: string;
  message: string;
} // recipient: full phone JID matching DM_PHONE_JID_RE
/** 200 {"success":true,"message":"Message sent to <recipient>"} ; 500/403 {"success":false,"message":"..."} ; 400/405 text/plain.
 *  The response NEVER contains the sent message id (matched later from messages.db by ingest/reconcile). */
export interface BridgeSendWire {
  success: boolean;
  message: string;
}
export type BridgeSendResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'not_connected' | 'rejected' | 'bad_request' | 'unreachable' | 'auth' | 'timeout';
      httpStatus: number | null;
    };
// 'not_connected' = 500 + /Not connected to WhatsApp/ ; 'timeout' (60 s) => the executor records unknown_outcome, NOT failed.
export interface BridgeSendClient {
  sendText(req: BridgeSendRequest, signal?: AbortSignal): Promise<BridgeSendResult>;
}

// ---------------------------------------------------------------------------------------------------------------------
// implementation (W1-02)
// ---------------------------------------------------------------------------------------------------------------------

/** ARCHITECTURE 14 / CONTRACTS section 12: a send that has not answered in 60 s is an UNKNOWN outcome, never a failure. */
export const BRIDGE_SEND_TIMEOUT_MS = 60_000;
/** main.go: `return false, "Not connected to WhatsApp"` -> 500 JSON. */
const NOT_CONNECTED_RE = /Not connected to WhatsApp/i;

function parseWire(text: string): BridgeSendWire | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const candidate = parsed as { success?: unknown; message?: unknown };
  if (typeof candidate.success !== 'boolean') return null;
  return { success: candidate.success, message: typeof candidate.message === 'string' ? candidate.message : '' };
}

/** [W1-02 refinement, justified by TESTS 4.3 seam S-FETCH ("bridge/sendClient.ts ... fetch" is injected).
 *  Purely additive: `createBridgeSendClient(ep)` keeps its frozen meaning and uses the global fetch. */
export function createBridgeSendClient(
  ep: () => { port: number; token: string } | null,
  fetchFn: FetchFn = globalThis.fetch,
): BridgeSendClient {
  return {
    async sendText(req: BridgeSendRequest, signal?: AbortSignal): Promise<BridgeSendResult> {
      const endpoint = ep();
      if (endpoint === null) return { ok: false, reason: 'unreachable', httpStatus: null };

      // A16: exactly two keys reach the wire - never media_path / quoted_* / anything the caller smuggled onto `req`.
      const body = JSON.stringify({ recipient: req.recipient, message: req.message });
      const timeout = AbortSignal.timeout(BRIDGE_SEND_TIMEOUT_MS);
      const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

      let res: Response;
      try {
        res = await fetchFn(`http://127.0.0.1:${endpoint.port}/api/send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
          body,
          redirect: 'error',
          signal: composed,
        });
      } catch {
        // An abort (our 60 s cap or the executor's own signal) is an UNKNOWN outcome, not a failed send.
        if (composed.aborted) return { ok: false, reason: 'timeout', httpStatus: null };
        return { ok: false, reason: 'unreachable', httpStatus: null };
      }

      const status = res.status;
      let text: string;
      try {
        text = await res.text();
      } catch {
        text = '';
      }
      const wire = parseWire(text);

      if (status === 200) {
        if (wire !== null && wire.success) return { ok: true };
        return { ok: false, reason: 'rejected', httpStatus: 200 };
      }
      if (status === 401) return { ok: false, reason: 'auth', httpStatus: 401 };
      // 403 is either the host allow-list (text/plain 'Forbidden: host not allowed' => a foreign listener) or a
      // bridge-side refusal carrying the JSON envelope (group admin / media_path).
      if (status === 403) return { ok: false, reason: wire === null ? 'auth' : 'rejected', httpStatus: 403 };
      if (status === 400 || status === 405) return { ok: false, reason: 'bad_request', httpStatus: status };
      if (status === 500 && wire !== null && NOT_CONNECTED_RE.test(wire.message)) {
        return { ok: false, reason: 'not_connected', httpStatus: 500 };
      }
      return { ok: false, reason: 'rejected', httpStatus: status };
    },
  };
}
