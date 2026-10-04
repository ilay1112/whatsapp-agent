// src/main/mcp/host.ts   (frozen signatures; the raw SDK Client never leaves this module)
// Frozen signatures pasted verbatim from docs/specs/contracts.md (owner W1-05); bodies implemented by W1-05.
// [R2] `callerFor(cls)` is the ONLY exit from this module. The SDK `Client`, the transport and the child process are
// module-private: no getter, no property, no event hands any of them out.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import { win32 as path } from 'node:path';
import { MCP_ENTRY_REL } from '../paths';
import { MCP_TOOLS, ENABLED_TOOLS_ENV, McpCapabilityError } from './readClient';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpStatus } from '../../shared/health';
import type { ErrorCode } from '../../shared/errors';
import type { McpToolCaller, McpToolClass, McpToolName, McpCallerSource, McpErrorKind } from './readClient';
import type { ChildHandle, ChildSpec } from '../proc/supervisor';
import type { Clock, Logger } from '../deps';
import type { AuditEntry, AuditKind, EpochMs } from '../../shared/types';
import { eventTextHasEtag, isEtagFieldRejection } from './projection';

export interface McpHostDeps {
  execPath: string; // process.execPath (ELECTRON_RUN_AS_NODE=1)
  mcpRoot: string; // <resources>\calendar-mcp | build-resources/calendar-mcp
  credentialsPath: string;
  tokenPath: string; // <userData>\google\...
  onStderrMarker: (marker: string) => void; // redacted marker names only
}
export interface McpHost extends McpCallerSource {
  /** Spawn via StdioClientTransport, initialize, verify tools/list === the six names + readOnlyHint on READ tools, else 'toolset_mismatch'. */
  start(): Promise<McpStatus>;
  stop(): Promise<void>;
  status(): McpStatus;
  onStatus(cb: (s: McpStatus) => void): () => void;
  pid(): number | null; // for the Supervisor PID file
  /** [R2] The ONLY way out of this module. Returns a wrapper that (1) asserts MCP_TOOLS[tool] === cls at run time - a mismatch throws
   *  McpCapabilityError and audits 'tool_blocked' {nameSha8,nameLen,verdict:'blocked_not_exposed',runId:0} - and (2) fails with 'unavailable'
   *  unless status is connected | needs_sign_in | signing_in. There is NO un-narrowed `caller` property. */
  callerFor<C extends McpToolClass>(cls: C): McpToolCaller<C>;
  /** [V2 ADD] (C2 11 McpHostV2) B4 update surface of the last verified tools/list. */
  updateSurface(): { available: true } | { available: false; problem: UpdateSurfaceProblem };
  /** list-calendars accessRole per calendar, refreshed by adminClient.listCalendars() and persisted to meta.calendar_roles_json (B7). */
}

// ---------------------------------------------------------------------------------------------------------------------
// implementation (W1-05)
// ---------------------------------------------------------------------------------------------------------------------

/** MCP client identity sent in `initialize`. No user data, no version of anything the user installed. */
export const MCP_CLIENT_NAME = 'whatsapp-calendar-agent';
/** Per-call budget; the calendar is never allowed to hang a pipeline run or an approval click. */
export const MCP_CALL_TIMEOUT_MS = 20_000;
/** `initialize` + `tools/list` budget. */
export const MCP_STARTUP_TIMEOUT_MS = 30_000;
/** Supervisor policy for `calendar-mcp` (CONTRACTS 13). */
export const MCP_BACKOFF_MS = [2_000, 10_000, 60_000] as const;
export const MCP_BREAKER = { maxExits: 3, windowMs: 600_000 } as const;
export const MCP_STABLE_AFTER_MS = 60_000;

/** [V2 CHANGE] start() now verifies tools/list === the EIGHT names of MCP_TOOLS (else 'toolset_mismatch' - whole surface, v1 rule), readOnlyHint:true on
 *  these four, destructiveHint:true on update-event. */
export const READ_ONLY_HINT_TOOLS: readonly McpToolName[] = [
  'get-current-time',
  'get-freebusy',
  'list-events',
  'get-event',
];
export const DESTRUCTIVE_HINT_TOOLS: readonly McpToolName[] = ['update-event'];
/** B4 narrow fail-closed guard, evaluated on the same tools/list: update-event.inputSchema.properties.status.enum must contain 'cancelled' AND
 *  properties.ifMatch must exist. Failure disables the UPDATE surface only (callerFor('write') refuses 'update-event' with 'unavailable' and the
 *  audit 'toolset_mismatch' {reason:'status_missing'|'ifmatch_missing'}); creates keep working; AppHealth.calendar.updatesAvailable = false;
 *  ErrorCode CAL_UPDATE_UNAVAILABLE. No soft-cancel branch exists. */
export type UpdateSurfaceProblem = 'status_missing' | 'ifmatch_missing';
export type UpdateSurface = { available: true } | { available: false; problem: UpdateSurfaceProblem };

/** B4 guard over one tools/list (pure). `status` is checked first: without it a cancel is impossible whatever else is there. */
export function verifyUpdateSurface(
  tools: ReadonlyArray<{ name: string; inputSchema: unknown; annotations?: unknown }>,
): { available: true } | { available: false; problem: UpdateSurfaceProblem } {
  const tool = Array.isArray(tools)
    ? tools.find((t) => t !== null && typeof t === 'object' && t.name === 'update-event')
    : undefined;
  const schema = tool?.inputSchema;
  const props =
    schema !== null && typeof schema === 'object' ? (schema as { properties?: unknown }).properties : undefined;
  const properties = props !== null && typeof props === 'object' ? (props as Record<string, unknown>) : {};
  const status = properties.status;
  const statusEnum = status !== null && typeof status === 'object' ? (status as { enum?: unknown }).enum : undefined;
  if (!Array.isArray(statusEnum) || !statusEnum.includes('cancelled'))
    return { available: false, problem: 'status_missing' };
  const ifMatch = properties.ifMatch;
  if (ifMatch === null || typeof ifMatch !== 'object') return { available: false, problem: 'ifmatch_missing' };
  return { available: true };
}
/** Required fields of our app-authored schemas that must exist in the server's own `inputSchema.required`. */
export const REQUIRED_INPUT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'get-freebusy': ['calendars', 'timeMin', 'timeMax'],
  'list-events': ['calendarId'],
  'create-event': ['calendarId', 'summary', 'start', 'end'],
  'manage-accounts': ['action'],
  'get-event': ['calendarId', 'eventId'], // [V2] research v2-event-editing 1.7
  'update-event': ['calendarId', 'eventId'], // [V2]
};
/** Statuses in which a tool call may leave the app at all. */
const CALLABLE: readonly McpStatus[] = ['connected', 'needs_sign_in', 'signing_in'];

/** Error text -> the two mapped transport-level kinds (build-plan W1-05: invalid_grant => CAL_RECONNECT, EADDRINUSE => CAL_PORT_BUSY). */
export const AUTH_ERROR_RE =
  /invalid_grant|tokens are no longer valid|no longer valid\. please restart|unauthorized_client|invalid_client/i;
export const PORT_BUSY_ERROR_RE = /EADDRINUSE|address already in use|ports? 3500-3505/i;
const TIMEOUT_ERROR_RE = /timed? ?out|ETIMEDOUT|AbortError|aborted/i;

/** Classifies an error TEXT (never stored, never logged) into a transport-level kind. `null` = pass the result through. */
export function classifyMcpErrorText(text: string): 'auth' | 'port_busy' | null {
  if (typeof text !== 'string') return null;
  if (AUTH_ERROR_RE.test(text)) return 'auth';
  if (PORT_BUSY_ERROR_RE.test(text)) return 'port_busy';
  return null;
}

/**
 * stderr redactor. The child writes OAuth URLs (`code=`), tokens and the client secret to stderr, so not one byte of it is
 * ever logged: a line is reduced to MARKER NAMES from this table, and a line that matches nothing produces nothing.
 */
export const MCP_STDERR_MARKERS: ReadonlyArray<{ marker: string; re: RegExp }> = [
  { marker: 'auth_invalid_grant', re: AUTH_ERROR_RE },
  { marker: 'port_busy', re: PORT_BUSY_ERROR_RE },
  { marker: 'no_accounts', re: /no authenticated accounts/i },
  { marker: 'awaiting_authentication', re: /awaiting[_ ]authentication|authorize this app|oauth2callback/i },
  { marker: 'token_saved', re: /tokens? saved|authentication successful/i },
  { marker: 'server_started', re: /server (is )?(running|started|ready)|listening on stdio/i },
  { marker: 'error', re: /\berror\b|\bexception\b|unhandled/i },
];

/** Marker names for one stderr line. Raw text never leaves this function. */
export function stderrMarkersOf(line: string): string[] {
  if (typeof line !== 'string' || line.length === 0) return [];
  const capped = line.slice(0, 4_096);
  return MCP_STDERR_MARKERS.filter((m) => m.re.test(capped)).map((m) => m.marker);
}

/** Absolute path of the staged server entry point (`<mcpRoot>\node_modules\@cocal\google-calendar-mcp\build\index.js`). */
export function mcpEntryOf(mcpRoot: string): string {
  return path.join(mcpRoot, MCP_ENTRY_REL);
}

/**
 * The env block of ARCHITECTURE 5.1, exactly. `getDefaultEnvironment()` contributes only the SDK's safe inherit list
 * (PATH, SystemRoot, APPDATA, ...). No API key, no bridge token, no doorbell secret and no user path beyond the two
 * Google file paths may ever appear here - `mcp-env.test.ts` asserts the key set literally.
 */
export function buildMcpEnv(deps: Pick<McpHostDeps, 'credentialsPath' | 'tokenPath'>): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    GOOGLE_OAUTH_CREDENTIALS: deps.credentialsPath,
    GOOGLE_CALENDAR_MCP_TOKEN_PATH: deps.tokenPath,
    GOOGLE_ACCOUNT_MODE: 'personal',
    ENABLED_TOOLS: ENABLED_TOOLS_ENV,
  };
}

export interface McpSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stderr: 'pipe';
}

/** ARCHITECTURE 5.1 spawn contract. `override` is the e2e seam `WCA_MCP_CMD` (TESTS 4.2): it replaces command+args ONLY. */
export function buildMcpSpawnSpec(
  deps: McpHostDeps,
  override?: { command: string; args: readonly string[] } | null,
): McpSpawnSpec {
  return {
    command: override ? override.command : deps.execPath,
    args: override ? [...override.args] : [mcpEntryOf(deps.mcpRoot), 'start', '--transport', 'stdio'],
    cwd: deps.mcpRoot,
    env: buildMcpEnv(deps),
    stderr: 'pipe',
  };
}

/** Shape of `tools/list` we verify against; only the fields the startup contract reads. */
export interface ToolListEntry {
  name: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined;
  inputSchema?: { required?: string[] | undefined; properties?: Record<string, unknown> | undefined } | undefined;
}

/** Startup contract of ARCHITECTURE 5.1 + [V2] B3. `null` = the toolset is exactly what we enabled; a string = the reason it is not. */
export function verifyToolset(tools: readonly ToolListEntry[]): string | null {
  const expected = Object.keys(MCP_TOOLS).sort();
  const got = [...new Set(tools.map((t) => t.name))].sort();
  if (got.length !== expected.length || got.some((n, i) => n !== expected[i])) return 'names';
  for (const tool of tools) {
    if (READ_ONLY_HINT_TOOLS.includes(tool.name as McpToolName) && tool.annotations?.readOnlyHint !== true)
      return 'readonly_hint';
    // [V2] B3: update-event must announce itself as destructive (an extra closed gate on the server we spawn).
    if (DESTRUCTIVE_HINT_TOOLS.includes(tool.name as McpToolName) && tool.annotations?.destructiveHint !== true)
      return 'destructive_hint';
    const required = REQUIRED_INPUT_FIELDS[tool.name];
    if (required === undefined) continue;
    const declared = tool.inputSchema?.required ?? [];
    if (required.some((field) => !declared.includes(field))) return 'schema';
  }
  return null;
}

/** Minimal slice of the SDK `Client` this module uses (so a test can hand in a double without loading a transport). */
export interface McpClientLike {
  connect(transport: Transport, options?: { timeout?: number }): Promise<void>;
  close(): Promise<void>;
  /** Protocol.onclose - the child exited or the pipe broke; the Supervisor restarts it. */
  onclose?: (() => void) | undefined;
  listTools(params?: undefined, options?: { timeout?: number }): Promise<{ tools: ToolListEntry[] }>;
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<{ content?: unknown; isError?: unknown }>;
}

/**
 * ADDITIVE, all optional (build-plan rule: bodies are added below the frozen block; every caller written against the frozen
 * `McpHostDeps` still compiles and gets the production defaults). `transportFactory` is the S-MCP seam of TESTS 4.3.
 */
export interface McpHostExtras {
  /** S-MCP. Production: `new StdioClientTransport(spec)`. Tests: the client half of an `InMemoryTransport` pair. */
  transportFactory?: (spec: McpSpawnSpec) => Transport;
  clientFactory?: () => McpClientLike;
  /** e2e seam `WCA_MCP_CMD` (TESTS 4.2): replaces command + args; the env block of ARCH 5.1 is passed unchanged. */
  spawnOverride?: { command: string; args: readonly string[] } | null;
  audit?: (kind: AuditKind, ref: string | null, detail: AuditEntry['detail'], now: EpochMs) => void;
  clock?: Pick<Clock, 'now'>;
  log?: Logger;
  callTimeoutMs?: number;
  startupTimeoutMs?: number;
  appVersion?: string;
  /** [V2] Called whenever updateSurface() changes (startup guard, or a pre-flight get-event without etag - F12). compose.ts feeds
   *  HealthHub.setCalendarUpdates(s.available) from it (AppHealth.calendar.updatesAvailable). */
  onUpdateSurface?: (s: UpdateSurface) => void;
}

/** `McpHost` plus the Supervisor registration (seams 18): `childSpec()` is consumed by compose.ts only. */
export type McpHostWithChildSpec = McpHost & { childSpec(): ChildSpec };

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text') {
      const t = (block as { text?: unknown }).text;
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.join('\n');
}

function sha8(name: string): string {
  return createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 8);
}

/** Never throws on a hostile object; used only to look at `action` of our OWN manage-accounts args. */
function actionOf(args: Record<string, unknown>): string | null {
  const v = args?.action;
  return typeof v === 'string' ? v : null;
}

/**
 * The 'personal' row of a manage-accounts `list` response, parsed defensively; the text itself is never logged.
 * `null` = the server does not know the account at all (never signed in, or the token file was deleted).
 */
export function personalAccountStatus(text: string): 'active' | 'expired' | 'error' | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 256 * 1024) return null;
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  const items = Array.isArray(root)
    ? root
    : typeof root === 'object' && root !== null && Array.isArray((root as { accounts?: unknown }).accounts)
      ? (root as { accounts: unknown[] }).accounts
      : null;
  if (items === null) return null;
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as Record<string, unknown>;
    if ((o.account_id ?? o.accountId) !== 'personal') continue;
    if (o.status === 'active' || o.status === 'expired' || o.status === 'error') return o.status;
    return 'error';
  }
  return null;
}

/** Does a manage-accounts `list` response show the 'personal' account as active? */
export function listShowsActiveAccount(text: string): boolean {
  return personalAccountStatus(text) === 'active';
}

/**
 * Sign-in state for a manage-accounts `list` answer. An account the server knows but cannot use ('expired' / 'error')
 * is `reconnect_required` ("Reconnect Google"), NOT `needs_sign_in` ("Connect Google"): the credentials are fine, the
 * stored refresh token is not (calendar-mcp.md "OAuth flow").
 */
export function statusForAccountList(text: string): McpStatus {
  const status = personalAccountStatus(text);
  if (status === 'active') return 'connected';
  return status === null ? 'needs_sign_in' : 'reconnect_required';
}

/**
 * The `McpStatus` -> `ErrorCode` mapping, the calendar twin of `bridgeStatusToErrorCode` (src/main/bridge/launcher.ts).
 * `McpHost` (CONTRACTS 11) is frozen and carries no `errorCode()`, so the code is derived from the status the host
 * already publishes - the host sets `reconnect_required` / `port_busy` from `classifyMcpErrorText`, `toolset_mismatch`
 * from the startup contract and `unavailable` from a dead transport, so the status alone says which error it was.
 *
 * `compose()` attaches the result to `healthHub.setCalendar`, which is what gives the red row in `HealthPill` its one
 * action (A17: "every red state offers exactly one action") and what lets the `CAL_RECONNECT` toast of
 * `ATTENTION_CODES` fire at all. `null` for every status `overallOf` does NOT class as attention: `connected`,
 * `not_configured` (skipped Google = reply-only mode, not an error), `starting`, `signing_in` and `needs_sign_in`
 * (the wizard shows progress / its own "Connect" button, not an error).
 */
export function mcpStatusToErrorCode(status: McpStatus): ErrorCode | null {
  switch (status) {
    case 'reconnect_required':
      return 'CAL_RECONNECT';
    case 'port_busy':
      return 'CAL_PORT_BUSY';
    case 'toolset_mismatch':
      return 'CAL_TOOLSET_MISMATCH';
    case 'unavailable':
      return 'CAL_UNAVAILABLE';
    default:
      return null;
  }
}

export function createMcpHost(deps: McpHostDeps & McpHostExtras): McpHostWithChildSpec {
  const now = (): EpochMs => (deps.clock ? deps.clock.now() : Date.now());
  const log = deps.log;
  const audit = deps.audit;
  const callTimeoutMs = deps.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS;
  const startupTimeoutMs = deps.startupTimeoutMs ?? MCP_STARTUP_TIMEOUT_MS;

  let state: McpStatus = 'not_configured';
  let client: McpClientLike | null = null;
  let transport: Transport | null = null;
  let childPid: number | null = null;
  /** The closest instant to the transport actually spawning the child (StdioClientTransport spawns inside connect()).
   *  Stamped into the pid file via ChildHandle.spawnedAt: ChildSpec.start() resolves only after connect() AND
   *  listTools(), which is far outside proc/reaper.ts's +-2 s CreationDate tolerance. */
  let childSpawnedAt: EpochMs = 0 as EpochMs;
  // Never reassigned: every drain uses `splice(0)` so a callback fires at most once and no registration is dropped.
  const exitCbs: Array<(info: { code: number | null; signal: string | null }) => void> = [];
  const statusCbs = new Set<(s: McpStatus) => void>();
  let starting: Promise<McpStatus> | null = null;
  /** [V2] B4 guard result of the LAST verified tools/list; null = never verified (fail closed: unavailable). */
  let listSurface: UpdateSurface | null = null;
  /** [V2] F12: a get-event of this server came back without an etag (or its `fields` enum refused 'etag'): insertions 6/7 are missing.
   *  Sticky for the lifetime of the host - the bundle cannot gain the insertions while it runs. */
  let etagMissing = false;

  const setStatus = (s: McpStatus): void => {
    if (s === state) return;
    state = s;
    for (const cb of [...statusCbs]) cb(s);
  };

  const currentSurface = (): UpdateSurface => {
    // Before the first verified tools/list nothing can be known about the server: fail closed. The frozen problem type has no
    // "unknown" member, so 'status_missing' stands for "not verified" (ops/agent-notes/V2-W1-02-calendar-mcp.md, REQUESTS).
    if (listSurface === null) return { available: false, problem: 'status_missing' };
    if (!listSurface.available) return listSurface;
    // F12: without an etag the If-Match insertion cannot work - the If-Match half of the surface is missing (frozen type, see notes).
    if (etagMissing) return { available: false, problem: 'ifmatch_missing' };
    return listSurface;
  };
  const surfaceChanged = (before: UpdateSurface): void => {
    const after = currentSurface();
    const same =
      before.available === after.available && (before.available || after.available || before.problem === after.problem);
    if (!same) deps.onUpdateSurface?.(after);
  };
  const markEtagMissing = (): void => {
    if (etagMissing) return;
    const before = currentSurface();
    etagMissing = true;
    audit?.('toolset_mismatch', null, { reason: 'etag_missing', count: 0 }, now());
    log?.error('mcp.update_surface_unavailable', { reason: 'etag_missing' });
    surfaceChanged(before);
  };
  /** [V2] F12 observation on OUR OWN get-event result: the projection needs an etag for every pre-flight. */
  const observeGetEvent = (text: string, isError: boolean): void => {
    if (isError) {
      if (isEtagFieldRejection(text)) markEtagMissing();
      return;
    }
    if (eventTextHasEtag(text) === false) markEtagMissing();
  };

  const teardown = async (next: McpStatus): Promise<void> => {
    const c = client;
    const t = transport;
    client = null;
    transport = null;
    childPid = null;
    setStatus(next);
    if (c !== null) await c.close().catch(() => undefined);
    else if (t !== null) await t.close().catch(() => undefined);
  };

  const attachStderr = (t: Transport): void => {
    const stderr = (t as { stderr?: NodeJS.ReadableStream | null }).stderr;
    if (stderr === undefined || stderr === null || typeof stderr.on !== 'function') return;
    let buffered = '';
    stderr.on('data', (chunk: Buffer | string) => {
      // Only marker NAMES leave this closure - the raw text (OAuth codes, tokens, the client secret) is dropped here.
      buffered = (buffered + String(chunk)).slice(-8_192);
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const line of lines) for (const marker of stderrMarkersOf(line)) deps.onStderrMarker(marker);
    });
  };

  const observeResult = (tool: string, args: Record<string, unknown>, text: string, isError: boolean): void => {
    if (tool !== 'manage-accounts' || isError) return;
    const action = actionOf(args);
    // The wizard's own polling drives the host's auth state: no extra round trip, no timer, deterministic in tests.
    if (action === 'add') setStatus('signing_in');
    else if (action === 'list' && CALLABLE.includes(state)) setStatus(statusForAccountList(text));
  };

  const classifyThrown = (err: unknown): McpErrorKind => {
    const message = err instanceof Error ? err.message : String(err);
    const mapped = classifyMcpErrorText(message);
    if (mapped !== null) return mapped;
    return TIMEOUT_ERROR_RE.test(message) ? 'timeout' : 'unavailable';
  };

  function callerFor<C extends McpToolClass>(cls: C): McpToolCaller<C> {
    return async (tool, args, signal) => {
      // (1) Capability assertion at RUN TIME: a bug (or a cast) in a facade cannot reach another tool class.
      if (MCP_TOOLS[tool as McpToolName] !== cls) {
        audit?.(
          'tool_blocked',
          null,
          { nameSha8: sha8(String(tool)), nameLen: String(tool).length, verdict: 'blocked_not_exposed', runId: 0 },
          now(),
        );
        throw new McpCapabilityError(cls);
      }
      // (2) The calendar answers only while it is actually usable.
      const c = client;
      if (c === null || !CALLABLE.includes(state)) return { ok: false, error: 'unavailable' };
      // (3) [V2] B4: the UPDATE surface only - no update-event leaves the app while the patch is not proven (creates keep working).
      if (tool === 'update-event') {
        const surface = currentSurface();
        if (!surface.available) {
          audit?.('toolset_mismatch', null, { reason: surface.problem, count: 0 }, now());
          return { ok: false, error: 'unavailable' };
        }
      }
      try {
        const res = await c.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: callTimeoutMs });
        const text = textOfContent(res.content);
        const isError = res.isError === true;
        observeResult(tool, args, text, isError);
        if (tool === 'get-event') observeGetEvent(text, isError);
        if (isError) {
          const mapped = classifyMcpErrorText(text);
          if (mapped === 'auth') {
            setStatus('reconnect_required');
            return { ok: false, error: 'auth' };
          }
          if (mapped === 'port_busy') {
            setStatus('port_busy');
            return { ok: false, error: 'port_busy' };
          }
        }
        return { ok: true, value: { text, isError } };
      } catch (err) {
        const kind = classifyThrown(err);
        log?.warn('mcp.call_failed', { tool, kind });
        if (kind === 'auth') setStatus('reconnect_required');
        else if (kind === 'port_busy') setStatus('port_busy');
        return { ok: false, error: kind };
      }
    };
  }

  const startOnce = async (): Promise<McpStatus> => {
    setStatus('starting');
    const spec = buildMcpSpawnSpec(deps, deps.spawnOverride ?? null);
    let t: Transport;
    try {
      t = deps.transportFactory ? deps.transportFactory(spec) : new StdioClientTransport(spec);
    } catch (err) {
      log?.error('mcp.transport_failed', { kind: classifyThrown(err) });
      setStatus('unavailable');
      return state;
    }
    transport = t;
    attachStderr(t);
    const c = deps.clientFactory
      ? deps.clientFactory()
      : (new Client({ name: MCP_CLIENT_NAME, version: deps.appVersion ?? '0.0.0' }) as unknown as McpClientLike);
    try {
      childSpawnedAt = now(); // connect() is what spawns the child process
      await c.connect(t, { timeout: startupTimeoutMs });
      // The SDK Client owns the transport's callbacks after connect(), so the exit signal for the Supervisor is taken here.
      c.onclose = () => {
        if (client !== c) return;
        client = null;
        transport = null;
        childPid = null;
        setStatus('unavailable');
        for (const cb of exitCbs.splice(0)) cb({ code: null, signal: null });
      };
      client = c;
      childPid = (t as { pid?: number | null }).pid ?? null;
      const listed = await c.listTools(undefined, { timeout: startupTimeoutMs });
      const reason = verifyToolset(listed.tools ?? []);
      if (reason !== null) {
        // Fail closed: the calendar stays disabled for the whole session until the app restarts with a matching server.
        audit?.('toolset_mismatch', null, { reason, count: (listed.tools ?? []).length }, now());
        log?.error('mcp.toolset_mismatch', { reason });
        await teardown('toolset_mismatch');
        return state;
      }
      // [V2] B4 narrow guard on the same tools/list: a missing status enum / ifMatch disables the UPDATE surface only.
      const before = currentSurface();
      listSurface = verifyUpdateSurface(
        (listed.tools ?? []).map((t) => ({ name: t.name, inputSchema: t.inputSchema })),
      );
      if (!listSurface.available) {
        audit?.('toolset_mismatch', null, { reason: listSurface.problem, count: (listed.tools ?? []).length }, now());
        log?.error('mcp.update_surface_unavailable', { reason: listSurface.problem });
      }
      surfaceChanged(before);
      setStatus('needs_sign_in');
      // One internal admin call decides sign-in state; the SDK client itself never leaves this closure.
      const probe = await callerFor('admin')('manage-accounts', { action: 'list', account_id: 'personal' });
      if (probe.ok && !probe.value.isError) setStatus(statusForAccountList(probe.value.text));
      else if (!probe.ok && probe.error === 'auth') setStatus('reconnect_required');
      return state;
    } catch (err) {
      const kind = classifyThrown(err);
      log?.error('mcp.start_failed', { kind });
      await teardown(kind === 'port_busy' ? 'port_busy' : 'unavailable');
      return state;
    }
  };

  const host: McpHostWithChildSpec = {
    async start() {
      if (client !== null) return state;
      starting ??= startOnce().finally(() => {
        starting = null;
      });
      return starting;
    },
    async stop() {
      await teardown('not_configured');
      // The Supervisor's ChildHandle.kill() IS `void host.stop()`, and teardown() nulls `client` before awaiting
      // `close()`, so the SDK's own `onclose` short-circuits and never fires the exit. Drain the callbacks HERE:
      // a Supervisor that does not observe the exit waits out the whole grace window and then escalates to
      // `taskkill /PID <pid> /T /F` against a pid Windows may already have recycled. `splice(0)` empties the list,
      // so a callback fires exactly once even when stop() is called again (idempotent).
      for (const cb of exitCbs.splice(0)) cb({ code: null, signal: null });
    },
    status: () => state,
    onStatus(cb) {
      statusCbs.add(cb);
      return () => statusCbs.delete(cb);
    },
    pid: () => childPid,
    callerFor,
    // [V2 ADD] B4: the guard result of the last verified tools/list, narrowed by the F12 etag observation. A status query, not a capability.
    updateSurface: () => currentSurface(),
    childSpec(): ChildSpec {
      return {
        name: 'calendar-mcp',
        async start(): Promise<ChildHandle> {
          const s = await host.start();
          if (s === 'toolset_mismatch' || s === 'unavailable' || s === 'port_busy') throw new Error(`mcp_start_${s}`);
          return {
            pid: childPid ?? 0,
            exePath: deps.spawnOverride ? deps.spawnOverride.command : deps.execPath,
            spawnedAt: childSpawnedAt,
            kill: () => void host.stop(),
            onExit: (cb) => {
              exitCbs.push(cb);
            },
          };
        },
        backoffMs: MCP_BACKOFF_MS,
        breaker: MCP_BREAKER,
        stableAfterMs: MCP_STABLE_AFTER_MS,
        // A toolset mismatch is a wrong/ upgraded server, not a crash: respawning it can only fail the same way.
        terminal: () => state === 'toolset_mismatch',
      };
    },
  };
  return host;
}
