// tests/fakes/fake-mcp-client.ts - [V2] typed re-export of mcp-client-core.mjs + the raw-socket prober of the tool-server
// 404 matrix (T2 3.4, ARCH2 B16). Owner V2-W1-05-wa-toolserver. The matrix DATA is final (W0).
// rawProbe() speaks HTTP/1.1 over a plain loopback socket so that every header (or its absence), every method, path and body size of
// the matrix can be sent exactly as written - no HTTP client library normalises anything away.
import net from 'node:net';
import * as core from './mcp-client-core.mjs';

export interface McpCoreClient {
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema: unknown; annotations?: unknown }>>;
  call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; content: unknown }>;
  close(): Promise<void>;
  /** [W1-05] errors the SDK client reported through `onerror` (F17: an authenticated GET answered 405 must add none). */
  readonly errors: Error[];
}
export const connect = (core as unknown as { connect(o: { url: string; token: string }): Promise<McpCoreClient> })
  .connect;

export interface RawProbe {
  method?: string; // default 'POST'
  path?: string; // default '/mcp'
  /** null = omit the header; default '127.0.0.1:<port>'. The literal '<port>' is replaced with the listener's port. */
  host?: string | null;
  origin?: string; // any value => must be 404 ('<port>' substituted)
  /** default 'Bearer <token>'. Placeholders: '<wrong-same-length>' (a wrong token of the right length), '<previous-token>'. */
  authorization?: string | null;
  contentType?: string;
  body?: string | Buffer;
  bodyBytes?: number; // synthetic body of that size
  slowBodyMs?: number; // trickles the body (requestTimeout 2 s)
  extraHeaders?: Record<string, string>;
}
export interface RawProbeResult {
  status: number | 'reset' | 'refused';
  headers: Record<string, string>;
  body: string;
  socketDestroyedByServer: boolean;
  ms: number;
}

/** A valid JSON-RPC `initialize` (the default POST body: the matrix row `valid_initialize_list_call` expects 200 for it). */
export const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wca-raw-probe', version: '0.0.0' } },
});
/** Hard stop for one probe (the trickle row needs ~3 s). */
const PROBE_DEADLINE_MS = 10_000;

/** Tokens this module was handed, in order: '<previous-token>' = the latest one that differs from the current token. */
const tokensSeen: string[] = [];

function substitute(value: string, port: number, token: string): string {
  let out = value.replaceAll('<port>', String(port));
  if (out.includes('<wrong-same-length>')) {
    // same length, different bytes (flip every character within the base64url alphabet)
    const wrong = [...token].map((ch) => (ch === 'A' ? 'B' : 'A')).join('');
    out = out.replaceAll('<wrong-same-length>', wrong);
  }
  if (out.includes('<previous-token>')) {
    const previous = [...tokensSeen].reverse().find((t) => t !== token);
    if (previous === undefined) throw new Error('rawProbe: <previous-token> needs a probe of an earlier run first');
    out = out.replaceAll('<previous-token>', previous);
  }
  return out;
}

function parseResponse(raw: Buffer): { status: number | null; headers: Record<string, string>; body: string } {
  const text = raw.toString('latin1');
  const m = /^HTTP\/1\.[01] (\d{3})[^\r\n]*\r\n/.exec(text);
  if (!m) return { status: null, headers: {}, body: '' };
  const headEnd = text.indexOf('\r\n\r\n');
  const headerLines = text.slice(m[0].length, headEnd < 0 ? text.length : headEnd).split('\r\n');
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  let bodyBuf = headEnd < 0 ? Buffer.alloc(0) : raw.subarray(Buffer.byteLength(text.slice(0, headEnd + 4), 'latin1'));
  if ((headers['transfer-encoding'] ?? '').toLowerCase() === 'chunked') {
    const parts: Buffer[] = [];
    let rest = bodyBuf;
    for (;;) {
      const nl = rest.indexOf('\r\n');
      if (nl < 0) break;
      const size = parseInt(rest.subarray(0, nl).toString('latin1'), 16);
      if (!Number.isFinite(size) || size === 0) break;
      parts.push(rest.subarray(nl + 2, nl + 2 + size));
      rest = rest.subarray(nl + 2 + size + 2);
    }
    bodyBuf = Buffer.concat(parts);
  }
  return { status: Number(m[1]), headers, body: bodyBuf.toString('utf8') };
}

export function rawProbe(port: number, token: string, p: RawProbe): Promise<RawProbeResult> {
  if (!tokensSeen.includes(token)) tokensSeen.push(token);
  const started = Date.now();
  const method = p.method ?? 'POST';
  const path = p.path ?? '/mcp';
  const host = p.host === undefined ? `127.0.0.1:${port}` : p.host;
  const authorization = p.authorization === undefined ? `Bearer ${token}` : p.authorization;
  let body: Buffer;
  if (p.body !== undefined) body = Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body, 'utf8');
  else if (p.bodyBytes !== undefined) body = Buffer.alloc(p.bodyBytes, 0x78);
  else body = method === 'POST' ? Buffer.from(INITIALIZE_BODY, 'utf8') : Buffer.alloc(0);

  const lines = [`${method} ${path} HTTP/1.1`];
  if (host !== null) lines.push(`Host: ${substitute(host, port, token)}`);
  if (p.origin !== undefined) lines.push(`Origin: ${substitute(p.origin, port, token)}`);
  if (authorization !== null) lines.push(`Authorization: ${substitute(authorization, port, token)}`);
  if (body.length > 0 || method === 'POST') {
    lines.push(`Content-Type: ${p.contentType ?? 'application/json'}`);
    lines.push(`Content-Length: ${body.length}`);
  }
  lines.push('Accept: application/json, text/event-stream');
  for (const [k, v] of Object.entries(p.extraHeaders ?? {})) lines.push(`${k}: ${substitute(v, port, token)}`);
  lines.push('Connection: close', '', '');
  const head = Buffer.from(lines.join('\r\n'), 'latin1');

  return new Promise<RawProbeResult>((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let connected = false;
    let weClosed = false;
    const timers: NodeJS.Timeout[] = [];
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (refused: boolean): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      const parsed = parseResponse(Buffer.concat(chunks));
      resolve({
        status: refused ? 'refused' : (parsed.status ?? 'reset'),
        headers: parsed.headers,
        body: parsed.body,
        socketDestroyedByServer: connected && !weClosed,
        ms: Date.now() - started,
      });
      socket.destroy();
    };
    timers.push(
      setTimeout(() => {
        weClosed = true;
        finish(false);
      }, PROBE_DEADLINE_MS),
    );
    socket.on('connect', () => {
      connected = true;
      socket.write(head);
      if (body.length === 0) return;
      if (p.slowBodyMs === undefined || p.slowBodyMs <= 0) {
        socket.write(body);
        return;
      }
      // trickle: one slice every 100 ms, spread over slowBodyMs
      const slices = Math.max(1, Math.floor(p.slowBodyMs / 100));
      const per = Math.ceil(body.length / slices);
      for (let i = 0; i < slices; i += 1) {
        timers.push(
          setTimeout(
            () => {
              if (!socket.destroyed) socket.write(body.subarray(i * per, (i + 1) * per));
            },
            (i + 1) * 100,
          ),
        );
      }
    });
    socket.on('data', (d: Buffer) => chunks.push(d));
    socket.on('end', () => finish(false));
    socket.on('close', () => finish(false));
    socket.on('error', (e: NodeJS.ErrnoException) => finish(!connected && e.code === 'ECONNREFUSED'));
  });
}

/** ARCH2 B16 / F17 / F22. Every row except the last asserts ZERO ToolGate.invoke calls; every 404 row also
 *  socketDestroyedByServer. Never 401/403 in any row. */
export const TOOL_SERVER_PROBE_MATRIX: ReadonlyArray<{
  id: string;
  probe: RawProbe;
  expect: 404 | 405 | 'reset' | 'refused' | 200;
}> = [
  { id: 'get_authenticated', probe: { method: 'GET' }, expect: 405 },
  { id: 'delete_authenticated', probe: { method: 'DELETE' }, expect: 405 },
  { id: 'get_no_bearer', probe: { method: 'GET', authorization: null }, expect: 404 },
  { id: 'get_wrong_bearer', probe: { method: 'GET', authorization: 'Bearer <wrong-same-length>' }, expect: 404 },
  { id: 'put', probe: { method: 'PUT' }, expect: 404 },
  { id: 'options', probe: { method: 'OPTIONS' }, expect: 404 },
  { id: 'post_root', probe: { path: '/' }, expect: 404 },
  { id: 'post_dot_segments', probe: { path: '/mcp/../mcp' }, expect: 404 },
  { id: 'host_evil', probe: { host: 'evil.example:<port>' }, expect: 404 },
  { id: 'host_localhost', probe: { host: 'localhost:<port>' }, expect: 404 },
  { id: 'host_no_port', probe: { host: '127.0.0.1' }, expect: 404 },
  { id: 'host_absent', probe: { host: null }, expect: 404 },
  { id: 'origin_same_host', probe: { origin: 'http://127.0.0.1:<port>' }, expect: 404 },
  { id: 'origin_null', probe: { origin: 'null' }, expect: 404 },
  { id: 'origin_claude_ai', probe: { origin: 'https://claude.ai' }, expect: 404 },
  { id: 'auth_absent', probe: { authorization: null }, expect: 404 },
  { id: 'auth_empty_bearer', probe: { authorization: 'Bearer ' }, expect: 404 },
  { id: 'auth_wrong_same_length', probe: { authorization: 'Bearer <wrong-same-length>' }, expect: 404 },
  { id: 'auth_wrong_other_length', probe: { authorization: 'Bearer x' }, expect: 404 },
  { id: 'auth_basic', probe: { authorization: 'Basic d2NhOndjYQ==' }, expect: 404 },
  { id: 'auth_previous_run_token', probe: { authorization: 'Bearer <previous-token>' }, expect: 404 },
  { id: 'body_64k_plus_1', probe: { bodyBytes: 64 * 1024 + 1, contentType: 'application/json' }, expect: 404 },
  {
    id: 'body_trickled_3s',
    probe: { slowBodyMs: 3000, contentType: 'application/json', bodyBytes: 256 },
    expect: 'reset',
  },
  { id: 'valid_initialize_list_call', probe: { contentType: 'application/json' }, expect: 200 },
];
