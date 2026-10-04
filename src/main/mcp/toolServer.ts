// src/main/mcp/toolServer.ts   ADD (B16) - a second TRANSPORT over the one ToolGate; never a second gate, never a capability of its own.
// Imports allowed: agent/toolGate + agent/toolDefs (types; values arrive by injection), @modelcontextprotocol/sdk/server/*, node:http, node:crypto.
// NEVER: bridge/sendClient, bridge/readClient, mcp/writeClient, mcp/adminClient, mcp/host, exec/**, llm/**, electron (ESLint + import-graph test).
// Owner V2-W1-05-wa-toolserver.
//
// Design notes (see ops/agent-notes/V2-W1-05-wa-toolserver.md):
// - OUR guard runs before anything of the SDK sees the request (T2 3.4 matrix: 404 + socket.destroy(), never 401/403; authenticated
//   GET/DELETE => 405 with an empty body, F17). The SDK's allowedHosts / enableDnsRebindingProtection are set as a second layer only.
// - Per HTTP request a NEW McpServer({name:'wca'}) + a NEW stateless StreamableHTTPServerTransport (F22).
// - tools/list and tools/call are answered by our own request handlers on that McpServer, NOT by McpServer.registerTool(): the SDK's
//   registered-tool path (a) answers an unknown name itself ("Tool x not found") and (b) rejects bad arguments itself - in both cases
//   WITHOUT reaching ToolGate.invoke(), so the strike, the tool_blocked audit and the blocked_bad_args verdict would be lost (T2 group 19:
//   "every tools/call -> exactly one gate.invoke"). tools/list serves the run's specs with the gate's own LCD schemas (byte-identical to
//   what every in-process provider sees, I4') and readOnlyHint:true.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RunCtx, ToolGate } from '../agent/toolGate';
import type { ToolSpec } from '../agent/toolDefs';
import { LIMITS } from '../../shared/types';
import { FREE_PORT_MAX_ATTEMPTS, NEVER_PORTS } from '../proc/freePort';

/** The MCP server name the CLI sees ('mcp__wca__<tool>'); one constant for Claude's --allowedTools 'mcp__wca__*'. */
export const TOOL_SERVER_NAME = 'wca';
export const TOOL_SERVER_PATH = '/mcp';
export interface ToolServerDeps {
  gate: ToolGate;
  ctx: RunCtx; // the run's own RunCtx: budgets, strikes, handles, nonce, audit are shared with the in-process path
  specs: readonly ToolSpec[]; // = gate.exposedSpecs() captured at run start ; registered verbatim (all readOnlyHint:true)
  randomBytes: (n: number) => Uint8Array; // S-RANDOM ; token = base64url(32 bytes)
  freePort: () => Promise<number>; // proc/freePort.ts ; NEVER_PORTS incl. 8080 ; FREE_PORT_MAX_ATTEMPTS then throws
  appVersion: string;
}
/** One listener per Claude S3 run (<= LIMITS.cliWallClockDraftMs), closed in the SAME finally as the job kill. */
export interface ToolServerHandle {
  readonly url: string; // 'http://127.0.0.1:<port>/mcp'
  /** Only for the child env WCA_MCP_TOKEN (expanded by the CLI from the inline --mcp-config header). Never on argv, disk, log or audit - not even hashed. */
  readonly token: string;
  readonly port: number;
  stats(): { accepted: number; rejected: number; toolCalls: number };
  close(): Promise<void>; // idempotent ; also destroys open sockets
}
export type ToolServerRejectReason = 'method' | 'path' | 'host' | 'origin' | 'auth' | 'body_too_large' | 'timeout';
// [F22] 'per request' is binding: SDK 1.30.0 webStandardStreamableHttp.js l.175 throws on a reused stateless transport. A tool-server test sends
// initialize + tools/list + tools/call (>= 3 JSON-RPC requests) in one run. 'Accepted' GET/DELETE (405) are counted in stats().accepted, never gate calls.

/** [W1-05 ADD] The typed start failure: no usable loopback port after FREE_PORT_MAX_ATTEMPTS (EADDRINUSE every time, only NEVER_PORTS
 *  offered, or freePort() itself failing). The Claude CLI provider maps it to not_ready (CLI_UNSTABLE); Local is unaffected (I7'). */
export class ToolServerPortError extends Error {
  readonly code = 'EADDRINUSE';
  constructor(readonly attempts: number) {
    super(`tool server: no usable loopback port after ${attempts} attempts`);
    this.name = 'ToolServerPortError';
  }
}

/** [W1-05 ADD] T7 (a) seam: every listener is reported to this registry (tests pass setup-guards' registerListener; production: none). */
export interface ToolServerListenerRecord {
  name: string;
  readonly listening: boolean;
  close(): unknown;
}
export type ToolServerListenerRegistry = (l: ToolServerListenerRecord) => () => void;
let listenerRegistry: ToolServerListenerRegistry | null = null;
export function setToolServerListenerRegistry(registry: ToolServerListenerRegistry | null): void {
  listenerRegistry = registry;
}

const LOOPBACK = '127.0.0.1';
/** Node's request-timeout sweep runs every `connectionsCheckingInterval` (default 30 s); ours must fire within the 2 s budget. */
const TIMEOUT_SWEEP_MS = 250;
const NODE_TIMEOUT_BACKSTOP_MS = 1_000;
/** An over-cap body is drained (discarded) up to this size before its 404; beyond it the socket is reset. */
const DRAIN_MAX_BYTES = 4 * LIMITS.toolServerBodyBytes;

/** Constant-time bearer check; unequal lengths never throw (a same-length self-compare keeps the timing flat). */
function bearerMatches(header: string | undefined, token: Buffer): boolean {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const offered = Buffer.from(header.slice('Bearer '.length), 'utf8');
  if (offered.length !== token.length) {
    timingSafeEqual(token, token);
    return false;
  }
  return timingSafeEqual(offered, token);
}
/** How often a header name occurs in the RAW header list (Node silently keeps the first of a duplicated Host / Authorization). */
function headerCount(req: IncomingMessage, name: string): number {
  let n = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]!.toLowerCase() === name) n += 1;
  return n;
}

export async function startToolServer(deps: ToolServerDeps): Promise<ToolServerHandle> {
  const tokenBytes = Buffer.from(deps.randomBytes(32));
  const token = tokenBytes.toString('base64url');
  const tokenBuf = Buffer.from(token, 'utf8');
  const counters = { accepted: 0, rejected: 0, toolCalls: 0 };
  const sockets = new Set<Socket>();

  // tools/list = this run's specs (captured at run start) with the gate's own LCD schemas - captured ONCE, identical for every request.
  const lcd = new Map(deps.gate.exposedTools().map((t) => [t.name, t.inputSchema] as const));
  const listed: Tool[] = deps.specs
    .filter((s) => lcd.has(s.name))
    .map((s) => ({
      name: s.name,
      description: s.description,
      inputSchema: JSON.parse(JSON.stringify(lcd.get(s.name))) as Tool['inputSchema'],
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }));

  let port = 0;
  const reject = (req: IncomingMessage, res: ServerResponse): void => {
    counters.rejected += 1;
    const socket = req.socket;
    res.writeHead(404, { Connection: 'close', 'Content-Length': '0' });
    res.end(() => socket.destroy());
  };

  /** null = passes the guard as a POST; '405' = an authenticated GET/DELETE; else the reject reason. */
  const guard = (req: IncomingMessage): ToolServerRejectReason | '405' | null => {
    if (req.url !== TOOL_SERVER_PATH) return 'path';
    if (headerCount(req, 'host') !== 1 || req.headers.host !== `${LOOPBACK}:${port}`) return 'host';
    if (req.headers.origin !== undefined || headerCount(req, 'origin') > 0) return 'origin';
    if (headerCount(req, 'authorization') !== 1 || !bearerMatches(req.headers.authorization, tokenBuf)) return 'auth';
    if (req.method === 'POST') return null;
    if (req.method === 'GET' || req.method === 'DELETE') return '405';
    return 'method';
  };

  /** The body, capped. 'gone' = the socket went away mid-body (our timeout or the peer). */
  const readBody = (req: IncomingMessage): Promise<Buffer | 'too_large' | 'gone'> =>
    new Promise((resolve) => {
      let done = false;
      const finish = (v: Buffer | 'too_large' | 'gone'): void => {
        if (done) return;
        done = true;
        resolve(v);
      };
      /** A body far beyond the cap is not drained: reset at once (the 404 would cost us reading it). */
      const flood = (): void => {
        counters.rejected += 1;
        finish('gone');
        req.socket.destroy();
      };
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > DRAIN_MAX_BYTES) {
        flood();
        return;
      }
      // An oversize body up to DRAIN_MAX_BYTES is read and DISCARDED, then answered 404: resetting a socket with unread input
      // makes the peer's TCP stack drop the 404 it already received (RST), and the matrix expects a 404, not a reset.
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > DRAIN_MAX_BYTES) flood();
        else if (size <= LIMITS.toolServerBodyBytes) chunks.push(chunk);
      });
      req.on('end', () => finish(size > LIMITS.toolServerBodyBytes ? 'too_large' : Buffer.concat(chunks)));
      req.on('error', () => finish('gone'));
      req.on('close', () => finish('gone'));
    });

  const serveMcp = async (req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> => {
    const server = new McpServer({ name: TOOL_SERVER_NAME, version: deps.appVersion }, { capabilities: { tools: {} } });
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listed }));
    server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      counters.toolCalls += 1;
      const input = (request.params.arguments ?? {}) as Record<string, unknown>;
      const out = await deps.gate.invoke({ id: randomUUID(), name: String(request.params.name), input }, deps.ctx);
      return { content: [{ type: 'text' as const, text: out.result.content }], isError: out.result.isError === true };
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true, // @deprecated second layer only; OUR guard above is the control
      allowedHosts: [`${LOOPBACK}:${port}`],
    });
    try {
      await server.connect(transport);
      res.setHeader('Connection', 'close');
      await transport.handleRequest(req, res, body);
    } finally {
      await Promise.allSettled([transport.close()]); // teardown failures never reach the peer or the gate
      await Promise.allSettled([server.close()]);
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const verdict = guard(req);
    if (verdict === '405') {
      counters.accepted += 1;
      res.writeHead(405, { Allow: 'POST', Connection: 'close', 'Content-Length': '0' });
      res.end();
      return;
    }
    if (verdict !== null) {
      reject(req, res);
      return;
    }
    const timer = setTimeout(() => {
      counters.rejected += 1; // 'timeout': the body did not arrive within LIMITS.toolServerRequestTimeoutMs => reset
      req.socket.destroy();
    }, LIMITS.toolServerRequestTimeoutMs);
    let raw: Buffer | 'too_large' | 'gone';
    try {
      raw = await readBody(req);
    } finally {
      clearTimeout(timer);
    }
    if (raw === 'gone') return;
    if (raw === 'too_large') {
      reject(req, res);
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      reject(req, res);
      return;
    }
    counters.accepted += 1;
    await serveMcp(req, res, body);
  };

  // Our own body timer (LIMITS.toolServerRequestTimeoutMs) always fires first; Node's requestTimeout is only the backstop.
  const http = createServer({
    requestTimeout: LIMITS.toolServerRequestTimeoutMs + NODE_TIMEOUT_BACKSTOP_MS,
    headersTimeout: LIMITS.toolServerRequestTimeoutMs,
    connectionsCheckingInterval: TIMEOUT_SWEEP_MS,
    requireHostHeader: false, // a missing Host is OUR 404 (+ destroy), never Node's 400 page
  });
  http.maxRequestsPerSocket = 1;
  http.keepAliveTimeout = 1;
  http.on('request', (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch(() => req.socket.destroy());
  });
  // malformed requests / header timeouts: reset, never a 400 / 408 page (no probing signal)
  http.on('clientError', (_err: Error, socket: Socket) => {
    counters.rejected += 1;
    socket.destroy();
  });
  http.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const listenOn = (candidate: number): Promise<boolean> =>
    new Promise((resolve) => {
      // EADDRINUSE (a racing process took the port) or any other bind failure: try the next candidate port
      const onError = (): void => {
        http.off('listening', onListening);
        resolve(false);
      };
      const onListening = (): void => {
        http.off('error', onError);
        resolve(true);
      };
      http.once('error', onError);
      http.once('listening', onListening);
      http.listen({ port: candidate, host: LOOPBACK, exclusive: true });
    });

  let attempts = 0;
  for (; attempts < FREE_PORT_MAX_ATTEMPTS && port === 0; attempts += 1) {
    let candidate: number;
    try {
      candidate = await deps.freePort();
    } catch {
      throw new ToolServerPortError(attempts + 1);
    }
    if (!Number.isInteger(candidate) || candidate <= 0 || candidate > 65_535 || NEVER_PORTS.includes(candidate))
      continue;
    if (await listenOn(candidate)) port = candidate;
  }
  if (port === 0) throw new ToolServerPortError(attempts);

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      http.close(() => resolve());
      for (const s of sockets) s.destroy();
      http.closeAllConnections();
    }).finally(() => unregister());
    return closing;
  };
  const unregister =
    listenerRegistry?.({
      name: `tool-server:${port}`,
      get listening() {
        return http.listening;
      },
      close,
    }) ?? ((): boolean => true);

  return {
    url: `http://${LOOPBACK}:${port}${TOOL_SERVER_PATH}`,
    token,
    port,
    stats: () => ({ ...counters }),
    close,
  };
}
