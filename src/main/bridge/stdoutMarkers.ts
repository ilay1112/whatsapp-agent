// src/main/bridge/stdoutMarkers.ts
// Frozen signatures pasted verbatim from docs/specs/contracts.md (owner W1-02); bodies implemented by W1-02.
/** [R2] Bridge stdout is UNTRUSTED: the bridge echoes every live message verbatim (`[ts] <- sender: content`, content may contain newlines), so a
 *  contact can put any marker string on stdout. Therefore:
 *  - A marker is matched ONLY at the start of a LINE (after ANSI strip \x1b\[[0-9;]*m and CRLF split) and only when that line does NOT start with
 *    the message-echo prefix MESSAGE_ECHO_RE. The whatsmeow-framed lines ('HH:MM:SS.fff [Client INFO|WARN|ERROR] ...') are matched after their prefix.
 *  - NO marker causes a state transition with a side effect. Markers are HINTS: `rest_starting` (readiness poll may begin), `qr_phase`
 *    (poll pairing/status now), `history_sync_done` (ingest.poke() + end of the "syncing" window, see ingest), `token_banner`/`invalid_port`/
 *    `token_too_short` (audit 'spawn_refused' + stop: these can only be printed BEFORE the REST server exists, before any message can be echoed,
 *    so they are accepted only while the launcher is in SPAWNING with no health answer yet).
 *  - `logged_out` comes ONLY from GET /api/pairing/status (LOGGED_OUT_MESSAGE_RE). `client_outdated`, `rest_error`, `unstable`, `stream_replaced`
 *    only ANNOTATE: when the health probe/breaker later decides (503 persisting -> respawn -> breaker open), the most recent annotation within
 *    the last 60 s selects the ErrorCode shown (BRIDGE_OUTDATED when `client_outdated`, else BRIDGE_CRASH_LOOP). They never stop, kill or respawn by themselves.
 *  ONLY the marker name is ever logged; raw stdout is never persisted or displayed. */
export const MESSAGE_ECHO_RE = /^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\] /; // main.go: fmt.Printf("[%s] %s %s: %s\n", timestamp, direction, sender, content)
export const CLIENT_LOG_PREFIX_RE = /^\d\d:\d\d:\d\d\.\d{3} \[Client (INFO|WARN|ERROR|DEBUG)\] /;
export const BRIDGE_MARKERS = {
  rest_starting: 'Starting REST API server on 127.0.0.1:',
  rest_error: 'REST API server error:',
  qr_phase: 'Scan this QR code with your WhatsApp app:',
  connected_1: 'Successfully connected and authenticated!',
  connected_2: 'Connected to WhatsApp!',
  connected_3: 'Successfully connected to WhatsApp servers',
  qr_timeout_1: 'QR code timed out',
  qr_timeout_2: 'Timeout waiting for QR code scan',
  logged_out: 'Device logged out',
  disconnected: 'Disconnected from WhatsApp servers',
  reconnecting: 'Attempting to reconnect',
  reconnected: 'Reconnected successfully',
  reconnect_failed: 'Reconnection failed',
  stream_replaced: 'Stream replaced by another session',
  client_outdated: 'Client outdated',
  unstable: 'Failed to establish stable connection',
  history_sync_done: 'History sync complete.',
  token_banner: 'WHATSAPP BRIDGE AUTH TOKEN', // must NEVER appear (we inject the token) => audit if seen
  invalid_port: 'Invalid WHATSAPP_BRIDGE_PORT',
  token_too_short: 'WHATSAPP_BRIDGE_TOKEN is too short',
} as const;
export type BridgeMarker = keyof typeof BRIDGE_MARKERS;
/** [R2] Hint-only markers (may trigger a poll/poke/annotation). Everything else in BRIDGE_MARKERS is logged by name and otherwise ignored. */
export const HINT_MARKERS = [
  'rest_starting',
  'qr_phase',
  'history_sync_done',
  'token_banner',
  'invalid_port',
  'token_too_short',
] as const;
export const ANNOTATION_MARKERS = ['client_outdated', 'rest_error', 'unstable', 'stream_replaced'] as const;

// ---------------------------------------------------------------------------------------------------------------------
// implementation (W1-02)
// ---------------------------------------------------------------------------------------------------------------------

/** Every marker name, in table order. */
export const MARKER_NAMES = Object.keys(BRIDGE_MARKERS) as readonly BridgeMarker[];

/** SGR colour codes only - whatsmeow's waLog wraps its level tag in \x1b[..m. */
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

/** Leading decoration the bridge prints before some of its own lines: whitespace and the tick/warning/cross glyphs (with an
 *  optional VS-16). Stripping it is still line-anchored - the message-echo guard has already run when this is applied. */
const DECORATION_RE = /^(?:\s|\u2713|\u2714|\u2705|\u26A0\uFE0F?|\u26D4|\u274C|\u2718|\u2757)*/u;

/** Line-anchored matcher over a stdout CHUNK (may hold partial lines: the caller keeps the tail). A line matching MESSAGE_ECHO_RE yields nothing. */
export function matchMarkers(chunkUtf8: string): BridgeMarker[] {
  const found: BridgeMarker[] = [];
  const stripped = chunkUtf8.replace(ANSI_SGR_RE, '');
  for (const rawLine of stripped.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') continue;
    // A line the bridge produced by echoing an incoming message is never a marker source, whatever it contains.
    if (MESSAGE_ECHO_RE.test(line)) continue;
    const afterLogPrefix = line.replace(CLIENT_LOG_PREFIX_RE, '');
    const candidate = afterLogPrefix.replace(DECORATION_RE, '');
    if (MESSAGE_ECHO_RE.test(candidate)) continue;
    for (const name of MARKER_NAMES) {
      if (candidate.startsWith(BRIDGE_MARKERS[name])) found.push(name);
    }
  }
  return found;
}

/** True when the marker may trigger a poll / poke / audit in the launcher (never a kill or a respawn). */
export function isHintMarker(m: BridgeMarker): boolean {
  return (HINT_MARKERS as readonly string[]).includes(m);
}
/** True when the marker only ANNOTATES: it selects the ErrorCode if the breaker later opens. */
export function isAnnotationMarker(m: BridgeMarker): boolean {
  return (ANNOTATION_MARKERS as readonly string[]).includes(m);
}
