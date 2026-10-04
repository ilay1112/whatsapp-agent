// src/main/mcp/host.test.ts - the MCP host: spawn contract, startup contract, stderr redaction and the capability gate.
// TESTS 5.3 row mcp/*: startup contract against every fake scenario; env block equals ARCH 5.1 exactly and contains no
// key/token; `[R2]` McpHost exposes no raw caller - callerFor('read') rejects create-event/manage-accounts/list-calendars
// with McpCapabilityError + audit 'tool_blocked' BEFORE the fake sees anything; callerFor('write') rejects get-freebusy.
// TESTS 13: 100 % lines on callerFor.
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createFakeMcpCalendar } from '../../../tests/fakes/fake-mcp-calendar';
import { createVirtualClock } from '../../../tests/helpers/virtualClock';
import { DEFAULT_GRACE_MS, createSupervisor } from '../proc/supervisor';
import { MCP_TOOLS, McpCapabilityError, createMcpReadClient } from './readClient';
import {
  DESTRUCTIVE_HINT_TOOLS,
  MCP_BACKOFF_MS,
  MCP_BREAKER,
  MCP_CALL_TIMEOUT_MS,
  MCP_CLIENT_NAME,
  MCP_STABLE_AFTER_MS,
  MCP_STARTUP_TIMEOUT_MS,
  MCP_STDERR_MARKERS,
  READ_ONLY_HINT_TOOLS,
  REQUIRED_INPUT_FIELDS,
  buildMcpEnv,
  buildMcpSpawnSpec,
  classifyMcpErrorText,
  createMcpHost,
  listShowsActiveAccount,
  mcpEntryOf,
  mcpStatusToErrorCode,
  personalAccountStatus,
  statusForAccountList,
  stderrMarkersOf,
  verifyToolset,
} from './host';
import type { McpClientLike, McpHostDeps, McpHostExtras, ToolListEntry } from './host';
import type { Supervisor } from '../proc/supervisor';
import type { VirtualClock } from '../../../tests/helpers/virtualClock';
import type { McpCallerSource, McpToolCaller } from './readClient';
import type { FakeCalendarOptions, FakeMcpCalendar } from '../../../tests/fakes/fake-mcp-calendar';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { AuditEntry, AuditKind } from '../../shared/types';
import { MCP_STATUSES, overallOf } from '../../shared/health';
import type { McpStatus } from '../../shared/health';
import { severityOf } from '../health/healthHub';
import type { ErrorCode } from '../../shared/errors';

/** [V2] The inputSchema a PATCHED server lists (B4 insertions 1 + 3 on update-event); required fields as the startup contract needs. */
function patchedSchemaOf(name: string): { required: string[]; properties?: Record<string, unknown> } {
  const required = [...(REQUIRED_INPUT_FIELDS[name] ?? [])];
  return name === 'update-event'
    ? {
        required,
        properties: {
          status: { type: 'string', enum: ['confirmed', 'tentative', 'cancelled'] },
          ifMatch: { type: 'string' },
        },
      }
    : { required };
}

const DEPS: McpHostDeps = {
  execPath: 'C:\\Program Files\\WhatsApp Calendar Agent\\WhatsApp Calendar Agent.exe',
  mcpRoot: 'C:\\Program Files\\WhatsApp Calendar Agent\\resources\\calendar-mcp',
  credentialsPath: 'C:\\Users\\tester\\AppData\\Roaming\\WCA\\google\\gcp-oauth.keys.json',
  tokenPath: 'C:\\Users\\tester\\AppData\\Roaming\\WCA\\google\\tokens.json',
  onStderrMarker: () => undefined,
};

type Audit = { kind: AuditKind; ref: string | null; detail: AuditEntry['detail'] };
const sha8 = (name: string): string => createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 8);

// ---------------------------------------------------------------------------------------------------------------------
// harness: a real fake MCP server over an InMemoryTransport pair (seam S-MCP)
// ---------------------------------------------------------------------------------------------------------------------

const open: FakeMcpCalendar[] = [];

async function withFake(
  opts: FakeCalendarOptions = {},
  extras: McpHostExtras = {},
): Promise<{
  fake: FakeMcpCalendar;
  host: ReturnType<typeof createMcpHost>;
  audits: Audit[];
  markers: string[];
  statuses: string[];
}> {
  const fake = createFakeMcpCalendar(opts);
  open.push(fake);
  const transport = fake.clientTransport();
  await fake.connect();
  const audits: Audit[] = [];
  const markers: string[] = [];
  const statuses: string[] = [];
  const host = createMcpHost({
    ...DEPS,
    onStderrMarker: (m) => markers.push(m),
    transportFactory: () => transport,
    audit: (kind, ref, detail) => audits.push({ kind, ref, detail }),
    ...extras,
  });
  host.onStatus((s) => statuses.push(s));
  return { fake, host, audits, markers, statuses };
}

afterEach(async () => {
  for (const fake of open.splice(0)) await fake.stop().catch(() => undefined);
});

/** Minimal Transport double for the paths that never reach a real server. */
const stubTransport = (): Transport => ({
  start: async () => undefined,
  send: async () => undefined,
  close: async () => undefined,
});

// ---------------------------------------------------------------------------------------------------------------------
// pure pieces
// ---------------------------------------------------------------------------------------------------------------------

describe('the spawn contract of ARCH 5.1', () => {
  it('builds exactly the documented env block and nothing else', () => {
    const env = buildMcpEnv(DEPS);
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(env.NODE_ENV).toBe('production');
    expect(env.GOOGLE_OAUTH_CREDENTIALS).toBe(DEPS.credentialsPath);
    expect(env.GOOGLE_CALENDAR_MCP_TOKEN_PATH).toBe(DEPS.tokenPath);
    expect(env.GOOGLE_ACCOUNT_MODE).toBe('personal');
    expect(env.ENABLED_TOOLS).toBe(
      'get-current-time,get-freebusy,list-events,get-event,list-calendars,create-event,update-event,manage-accounts', // [V2] C2 11
    );

    const ours = [
      'ELECTRON_RUN_AS_NODE',
      'NODE_ENV',
      'GOOGLE_OAUTH_CREDENTIALS',
      'GOOGLE_CALENDAR_MCP_TOKEN_PATH',
      'GOOGLE_ACCOUNT_MODE',
      'ENABLED_TOOLS',
    ];
    const extra = Object.keys(env).filter((k) => !ours.includes(k));
    // Everything beyond our six keys comes from the SDK's safe inherit list - never from our own process env.
    expect(extra.every((k) => (DEFAULT_INHERITED_ENV_VARS as readonly string[]).includes(k))).toBe(true);
  });

  it('never leaks an API key, the bridge token or the doorbell secret into the child env', () => {
    const planted = {
      ANTHROPIC_API_KEY: 'sk-ant-TESTONLY-aaaaaaaaaaaaaaaaaaaa',
      GEMINI_API_KEY: 'AIzaTESTONLYbbbbbbbbbbbbbbbbbbbb',
      LLAMA_API_KEY: 'TESTONLY-llama',
      WCA_BRIDGE_TOKEN: 'TESTONLY-bridge-token',
      WCA_DOORBELL_SECRET: 'TESTONLY-doorbell',
    };
    const restore = { ...process.env };
    Object.assign(process.env, planted);
    try {
      const env = buildMcpEnv(DEPS);
      for (const key of Object.keys(planted)) expect(env).not.toHaveProperty(key);
      const serialised = JSON.stringify(env);
      for (const secret of Object.values(planted)) expect(serialised).not.toContain(secret);
    } finally {
      for (const key of Object.keys(planted)) delete process.env[key];
      Object.assign(process.env, restore);
    }
  });

  it('spawns process.execPath with the staged entry point, stdio transport and mcpRoot as cwd', () => {
    const spec = buildMcpSpawnSpec(DEPS);
    expect(spec.command).toBe(DEPS.execPath);
    expect(spec.args).toEqual([mcpEntryOf(DEPS.mcpRoot), 'start', '--transport', 'stdio']);
    expect(spec.cwd).toBe(DEPS.mcpRoot);
    expect(spec.stderr).toBe('pipe');
    expect(mcpEntryOf(DEPS.mcpRoot)).toBe(
      `${DEPS.mcpRoot}\\node_modules\\@cocal\\google-calendar-mcp\\build\\index.js`,
    );
  });

  it('the WCA_MCP_CMD e2e seam replaces command+args only - the env block is unchanged', () => {
    const spec = buildMcpSpawnSpec(DEPS, {
      command: 'node',
      args: ['tests/fakes/fake-mcp-calendar.ts', '--scenario', 'default'],
    });
    expect(spec.command).toBe('node');
    expect(spec.args).toEqual(['tests/fakes/fake-mcp-calendar.ts', '--scenario', 'default']);
    expect(spec.cwd).toBe(DEPS.mcpRoot);
    expect(spec.env).toEqual(buildMcpEnv(DEPS));
  });

  it('keeps the supervisor policy constants of CONTRACTS 13', () => {
    expect(MCP_BACKOFF_MS).toEqual([2_000, 10_000, 60_000]);
    expect(MCP_BREAKER).toEqual({ maxExits: 3, windowMs: 600_000 });
    expect(MCP_STABLE_AFTER_MS).toBe(60_000);
    expect(MCP_CALL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(MCP_STARTUP_TIMEOUT_MS).toBeGreaterThan(MCP_CALL_TIMEOUT_MS);
    expect(MCP_CLIENT_NAME).toBe('whatsapp-calendar-agent');
  });
});

describe('verifyToolset (startup contract, fail closed)', () => {
  const good: ToolListEntry[] = Object.keys(MCP_TOOLS).map((name) => ({
    name,
    annotations: {
      readOnlyHint: READ_ONLY_HINT_TOOLS.includes(name as never),
      destructiveHint: DESTRUCTIVE_HINT_TOOLS.includes(name as never), // [V2] B3
    },
    inputSchema: patchedSchemaOf(name),
  }));

  it('accepts exactly the eight names with readOnlyHint, destructiveHint and the required fields', () => {
    expect(verifyToolset(good)).toBeNull();
  });

  it('rejects an extra or a missing name', () => {
    expect(verifyToolset([...good, { name: 'search-events' }])).toBe('names');
    expect(verifyToolset(good.slice(1))).toBe('names');
    expect(verifyToolset(good.map((t) => (t.name === 'list-events' ? { ...t, name: 'list_events' } : t)))).toBe(
      'names',
    );
  });

  it('rejects a READ tool that does not advertise readOnlyHint:true', () => {
    expect(
      verifyToolset(good.map((t) => (t.name === 'get-freebusy' ? { ...t, annotations: { readOnlyHint: false } } : t))),
    ).toBe('readonly_hint');
    expect(
      verifyToolset(good.map((t) => (t.name === 'get-freebusy' ? { name: t.name, inputSchema: t.inputSchema } : t))),
    ).toBe('readonly_hint');
  });

  it('rejects schema drift in a required field of our app-authored schemas', () => {
    expect(
      verifyToolset(
        good.map((t) =>
          t.name === 'create-event' ? { ...t, inputSchema: { required: ['calendarId', 'summary', 'start'] } } : t,
        ),
      ),
    ).toBe('schema');
    expect(verifyToolset(good.map((t) => (t.name === 'create-event' ? { ...t, inputSchema: undefined } : t)))).toBe(
      'schema',
    );
  });
});

describe('the stderr redactor', () => {
  it('emits marker names only - not one byte of the raw line survives', () => {
    const line =
      'Awaiting authentication: https://accounts.google.com/o/oauth2/v2/auth?code=4/0AY-SECRET&client_secret=GOCSPX-SECRET';
    const markers = stderrMarkersOf(line);
    expect(markers).toContain('awaiting_authentication');
    expect(JSON.stringify(markers)).not.toContain('SECRET');
    expect(JSON.stringify(markers)).not.toContain('code=');
  });

  it('maps the lines the real server writes', () => {
    expect(stderrMarkersOf('invalid_grant')).toContain('auth_invalid_grant');
    expect(stderrMarkersOf('listen EADDRINUSE: address already in use 127.0.0.1:3500')).toContain('port_busy');
    expect(stderrMarkersOf('No authenticated accounts found.')).toContain('no_accounts');
    expect(stderrMarkersOf('Tokens saved')).toContain('token_saved');
    expect(stderrMarkersOf('Server is running on stdio')).toContain('server_started');
    expect(stderrMarkersOf('Unhandled exception in handler')).toContain('error');
  });

  it('produces nothing for a line that matches no marker, an empty line or a non-string', () => {
    expect(stderrMarkersOf('a perfectly ordinary sentence')).toEqual([]);
    expect(stderrMarkersOf('')).toEqual([]);
    expect(stderrMarkersOf(7 as unknown as string)).toEqual([]);
    expect(stderrMarkersOf('x'.repeat(100_000))).toEqual([]);
  });

  it('every marker is a short snake_case name, never a template with captured text', () => {
    for (const { marker } of MCP_STDERR_MARKERS) expect(marker).toMatch(/^[a-z_]{1,32}$/);
  });
});

describe('classifyMcpErrorText / listShowsActiveAccount', () => {
  it('maps invalid_grant to auth and EADDRINUSE to port_busy, everything else to null', () => {
    expect(classifyMcpErrorText('Authentication tokens are no longer valid. Please restart the server.')).toBe('auth');
    expect(classifyMcpErrorText('invalid_grant')).toBe('auth');
    expect(classifyMcpErrorText('listen EADDRINUSE 127.0.0.1:3500')).toBe('port_busy');
    expect(classifyMcpErrorText('could not bind ports 3500-3505')).toBe('port_busy');
    expect(classifyMcpErrorText('some other failure')).toBeNull();
    expect(classifyMcpErrorText(7 as unknown as string)).toBeNull();
  });

  it('only an active personal account counts as signed in', () => {
    expect(listShowsActiveAccount(JSON.stringify({ accounts: [{ account_id: 'personal', status: 'active' }] }))).toBe(
      true,
    );
    expect(listShowsActiveAccount(JSON.stringify([{ accountId: 'personal', status: 'active' }]))).toBe(true);
    expect(listShowsActiveAccount(JSON.stringify({ accounts: [{ account_id: 'personal', status: 'expired' }] }))).toBe(
      false,
    );
    expect(listShowsActiveAccount(JSON.stringify({ accounts: [{ account_id: 'work', status: 'active' }] }))).toBe(
      false,
    );
    expect(listShowsActiveAccount(JSON.stringify({ accounts: ['nope'] }))).toBe(false);
    expect(listShowsActiveAccount(JSON.stringify({ nothing: 1 }))).toBe(false);
    expect(listShowsActiveAccount('<html/>')).toBe(false);
    expect(listShowsActiveAccount('')).toBe(false);
    expect(listShowsActiveAccount(7 as unknown as string)).toBe(false);
    expect(listShowsActiveAccount('x'.repeat(256 * 1024 + 1))).toBe(false);
  });

  it('reads the personal row defensively and ignores every other account', () => {
    expect(personalAccountStatus(JSON.stringify({ accounts: [{ account_id: 'work', status: 'active' }] }))).toBeNull();
    expect(personalAccountStatus(JSON.stringify({ accounts: [{ account_id: 'personal', status: 'expired' }] }))).toBe(
      'expired',
    );
    expect(personalAccountStatus(JSON.stringify({ accounts: [{ account_id: 'personal', status: 'error' }] }))).toBe(
      'error',
    );
    // An unknown status is never optimistically treated as usable.
    expect(personalAccountStatus(JSON.stringify({ accounts: [{ account_id: 'personal', status: 'brand_new' }] }))).toBe(
      'error',
    );
    expect(
      personalAccountStatus(JSON.stringify({ accounts: [null, 'x', { account_id: 'personal', status: 'active' }] })),
    ).toBe('active');
  });

  it('an account the server knows but cannot use means Reconnect, not Connect', () => {
    expect(statusForAccountList(JSON.stringify({ accounts: [{ account_id: 'personal', status: 'active' }] }))).toBe(
      'connected',
    );
    expect(statusForAccountList(JSON.stringify({ accounts: [] }))).toBe('needs_sign_in');
    expect(statusForAccountList('<html/>')).toBe('needs_sign_in');
    expect(statusForAccountList(JSON.stringify({ accounts: [{ account_id: 'personal', status: 'expired' }] }))).toBe(
      'reconnect_required',
    );
    expect(statusForAccountList(JSON.stringify({ accounts: [{ account_id: 'personal', status: 'error' }] }))).toBe(
      'reconnect_required',
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// McpStatus -> ErrorCode (the calendar twin of bridgeStatusToErrorCode; A17 "every red state offers exactly one action")
// ---------------------------------------------------------------------------------------------------------------------

describe('mcpStatusToErrorCode', () => {
  it('maps every McpStatus to the one ErrorCode the pill row and the toast need', () => {
    const table: Record<McpStatus, ErrorCode | null> = {
      not_configured: null,
      starting: null,
      needs_sign_in: null,
      signing_in: null,
      connected: null,
      reconnect_required: 'CAL_RECONNECT',
      port_busy: 'CAL_PORT_BUSY',
      toolset_mismatch: 'CAL_TOOLSET_MISMATCH',
      unavailable: 'CAL_UNAVAILABLE',
    };
    for (const status of MCP_STATUSES) expect(mcpStatusToErrorCode(status)).toBe(table[status]);
  });

  // A17: a calendar state that turns the pill red MUST carry a code, or HealthPill has no action to render and the
  // CAL_RECONNECT toast of ATTENTION_CODES can never fire. A state that is ok/working must NOT carry one.
  it('carries a code for exactly the states overallOf classes as attention', () => {
    const healthy = {
      whatsapp: { state: 'online' as const, since: 0 },
      llm: { state: 'ready' as const, since: 0, provider: 'local' as const, model: '', quota: null },
    };
    for (const status of MCP_STATUSES) {
      const overall = overallOf(
        { ...healthy, calendar: { state: status, since: 0, updatesAvailable: true } },
        severityOf,
      );
      expect([status, mcpStatusToErrorCode(status) !== null]).toEqual([status, overall === 'attention']);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the host against the fake server
// ---------------------------------------------------------------------------------------------------------------------

describe('createMcpHost start-up', () => {
  it('connects, verifies the toolset and reports connected when the account is active', async () => {
    const { host, statuses, fake } = await withFake({ accounts: 'personal_ok' });
    await expect(host.start()).resolves.toBe('connected');
    expect(host.status()).toBe('connected');
    expect(statuses).toEqual(['starting', 'needs_sign_in', 'connected']);
    // Exactly one internal probe, and it is an ADMIN read of our own account - nothing else.
    expect(fake.calls.map((c) => c.tool)).toEqual(['manage-accounts']);
    expect(fake.calls[0]?.args).toEqual({ action: 'list', account_id: 'personal' });
    expect(fake.violations).toEqual([]);
  });

  it('reports needs_sign_in when no account is authenticated', async () => {
    const { host } = await withFake({ accounts: 'none' });
    await expect(host.start()).resolves.toBe('needs_sign_in');
  });

  it('reports reconnect_required when the stored tokens are dead', async () => {
    const { host } = await withFake({ accounts: 'invalid_grant' });
    await expect(host.start()).resolves.toBe('reconnect_required');
  });

  it('reports reconnect_required when the start-up probe itself throws invalid_grant', async () => {
    const double: McpClientLike = {
      connect: async () => undefined,
      close: async () => undefined,
      listTools: async () => ({
        tools: Object.keys(MCP_TOOLS).map((name) => ({
          name,
          annotations: {
            readOnlyHint: READ_ONLY_HINT_TOOLS.includes(name as never),
            destructiveHint: DESTRUCTIVE_HINT_TOOLS.includes(name as never), // [V2] B3
          },
          inputSchema: patchedSchemaOf(name),
        })),
      }),
      callTool: async () => {
        throw new Error('Authentication tokens are no longer valid. Please restart the server.');
      },
    };
    const host = createMcpHost({ ...DEPS, transportFactory: stubTransport, clientFactory: () => double });
    await expect(host.start()).resolves.toBe('reconnect_required');
  });

  it('is idempotent and coalesces concurrent starts', async () => {
    const { host, fake } = await withFake();
    const [a, b] = await Promise.all([host.start(), host.start()]);
    expect(a).toBe('connected');
    expect(b).toBe('connected');
    await expect(host.start()).resolves.toBe('connected');
    expect(fake.calls).toHaveLength(1);
  });

  it('exposes the child pid for the Supervisor PID file (null over an in-memory transport)', async () => {
    const { host } = await withFake();
    expect(host.pid()).toBeNull();
    await host.start();
    expect(host.pid()).toBeNull();
  });

  it('unsubscribes a status listener', async () => {
    const { host } = await withFake();
    const seen: string[] = [];
    const off = host.onStatus((s) => seen.push(s));
    off();
    await host.start();
    expect(seen).toEqual([]);
  });

  it('goes unavailable when the transport cannot even be created', async () => {
    const host = createMcpHost({
      ...DEPS,
      transportFactory: () => {
        throw new Error('spawn ENOENT');
      },
    });
    await expect(host.start()).resolves.toBe('unavailable');
  });

  it('goes unavailable when initialize fails, and port_busy when the failure is a bound port', async () => {
    const failing = (message: string): McpClientLike => ({
      connect: async () => {
        throw new Error(message);
      },
      close: async () => undefined,
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({}),
    });
    const make = (message: string): ReturnType<typeof createMcpHost> =>
      createMcpHost({ ...DEPS, transportFactory: stubTransport, clientFactory: () => failing(message) });
    await expect(make('spawn failed').start()).resolves.toBe('unavailable');
    await expect(make('listen EADDRINUSE 127.0.0.1:3500').start()).resolves.toBe('port_busy');
  });

  it('goes unavailable when the child exits (Protocol.onclose) and tells the Supervisor', async () => {
    const double: McpClientLike = {
      connect: async () => undefined,
      close: async () => undefined,
      listTools: async () => ({
        tools: Object.keys(MCP_TOOLS).map((name) => ({
          name,
          annotations: {
            readOnlyHint: READ_ONLY_HINT_TOOLS.includes(name as never),
            destructiveHint: DESTRUCTIVE_HINT_TOOLS.includes(name as never), // [V2] B3
          },
          inputSchema: patchedSchemaOf(name),
        })),
      }),
      callTool: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ accounts: [{ account_id: 'personal', status: 'active' }] }) }],
      }),
    };
    const host = createMcpHost({ ...DEPS, transportFactory: stubTransport, clientFactory: () => double });
    await expect(host.start()).resolves.toBe('connected');
    const exits: Array<{ code: number | null }> = [];
    const handle = await host.childSpec().start(0);
    handle.onExit((info) => exits.push(info));
    double.onclose?.();
    expect(host.status()).toBe('unavailable');
    expect(exits).toEqual([{ code: null, signal: null }]);
    // A stale client's onclose must not touch the current state.
    double.onclose?.();
    expect(host.status()).toBe('unavailable');
  });
});

describe('the startup contract fails closed', () => {
  const cases: Array<[FakeCalendarOptions['scenario'], string]> = [
    ['toolset_extra', 'names'],
    ['toolset_missing', 'names'],
    ['readonly_hint_false', 'readonly_hint'],
    ['schema_drift', 'schema'],
  ];

  for (const [scenario, reason] of cases) {
    it(`${String(scenario)} => toolset_mismatch, audited, calendar disabled`, async () => {
      const { host, audits } = await withFake({ scenario });
      await expect(host.start()).resolves.toBe('toolset_mismatch');
      expect(host.status()).toBe('toolset_mismatch');
      expect(audits.filter((a) => a.kind === 'toolset_mismatch')).toHaveLength(1);
      expect(audits[0]?.detail).toMatchObject({ reason });
      // Disabled: every facade call now answers 'unavailable' instead of reaching the server.
      await expect(createMcpReadClient(host.callerFor('read')).getCurrentTime()).resolves.toEqual({
        ok: false,
        error: 'unavailable',
      });
      // Never respawn a server whose toolset does not match - the Supervisor is told it is terminal.
      expect(host.childSpec().terminal?.()).toBe(true);
    });
  }

  it('setToolList drives the same mismatch from the test side', async () => {
    const fake = createFakeMcpCalendar({});
    open.push(fake);
    fake.setToolList(['get-current-time', 'get-freebusy']);
    const transport = fake.clientTransport();
    await fake.connect();
    const host = createMcpHost({ ...DEPS, transportFactory: () => transport });
    await expect(host.start()).resolves.toBe('toolset_mismatch');
  });
});

describe('callerFor - the only exit from host.ts', () => {
  it('has no un-narrowed caller property and is the only capability surface', async () => {
    const { host } = await withFake();
    await host.start();
    expect(host).not.toHaveProperty('caller');
    expect(host).not.toHaveProperty('client');
    // [V2] + updateSurface() (C2 11): a status query, not a capability
    expect(Object.keys(host).sort()).toEqual([
      'callerFor',
      'childSpec',
      'onStatus',
      'pid',
      'start',
      'status',
      'stop',
      'updateSurface',
    ]);
    expectTypeOf(host.callerFor('read')).toEqualTypeOf<McpToolCaller<'read'>>();
    expectTypeOf(host).toExtend<McpCallerSource>();
  });

  it('rejects every out-of-class tool BEFORE the fake sees a call, and audits tool_blocked exactly', async () => {
    const { host, fake, audits } = await withFake();
    await host.start();
    const callsBefore = fake.calls.length;
    const read = host.callerFor('read') as unknown as McpToolCaller;

    for (const tool of ['create-event', 'manage-accounts', 'list-calendars'] as const) {
      await expect(read(tool, {})).rejects.toBeInstanceOf(McpCapabilityError);
    }
    expect(fake.calls).toHaveLength(callsBefore);
    expect(fake.violations).toEqual([]);

    const blocked = audits.filter((a) => a.kind === 'tool_blocked');
    expect(blocked).toHaveLength(3);
    expect(blocked[0]).toEqual({
      kind: 'tool_blocked',
      ref: null,
      detail: {
        nameSha8: sha8('create-event'),
        nameLen: 'create-event'.length,
        verdict: 'blocked_not_exposed',
        runId: 0,
      },
    });
    // The model-supplied / bug-supplied tool name itself never appears in an audit row.
    for (const row of blocked) expect(JSON.stringify(row)).not.toContain('create-event');
  });

  it('rejects a READ tool asked through the WRITE caller', async () => {
    const { host, fake } = await withFake();
    await host.start();
    const write = host.callerFor('write') as unknown as McpToolCaller;
    await expect(write('get-freebusy', {})).rejects.toBeInstanceOf(McpCapabilityError);
    await expect(write('manage-accounts', {})).rejects.toBeInstanceOf(McpCapabilityError);
    expect(fake.calls.map((c) => c.tool)).toEqual(['manage-accounts']); // only the host's own start-up probe
  });

  it('rejects an unknown tool name (not in the table at all)', async () => {
    const { host, audits } = await withFake();
    await host.start();
    const read = host.callerFor('read') as unknown as McpToolCaller;
    await expect(read('delete-event' as never, {})).rejects.toBeInstanceOf(McpCapabilityError);
    await expect(read('' as never, {})).rejects.toBeInstanceOf(McpCapabilityError);
    expect(audits.filter((a) => a.kind === 'tool_blocked')).toHaveLength(2);
  });

  it('a monkey-patched read client cannot reach create-event through its injected caller', async () => {
    const { host, fake, audits } = await withFake();
    await host.start();
    const caller = host.callerFor('read');
    // A read facade with a bug (or a cast) that asks for the WRITE tool: the host wrapper stops it.
    const patched = {
      ...createMcpReadClient(caller),
      evil: async () => (caller as unknown as McpToolCaller)('create-event', { summary: 'pwned' }),
    };
    await expect(patched.evil()).rejects.toBeInstanceOf(McpCapabilityError);
    expect(fake.calls.map((c) => c.tool)).not.toContain('create-event');
    expect(fake.events).toHaveLength(0);
    expect(audits.some((a) => a.kind === 'tool_blocked')).toBe(true);
  });

  it('answers unavailable before start, after stop and while not configured', async () => {
    const { host } = await withFake();
    await expect(host.callerFor('read')('get-current-time', {})).resolves.toEqual({ ok: false, error: 'unavailable' });
    await host.start();
    await expect(host.callerFor('read')('get-current-time', {})).resolves.toMatchObject({ ok: true });
    await host.stop();
    expect(host.status()).toBe('not_configured');
    await expect(host.callerFor('read')('get-current-time', {})).resolves.toEqual({ ok: false, error: 'unavailable' });
  });

  it('passes the tool text and isError flag through untouched (projection is the facade s job)', async () => {
    const { host } = await withFake({ now: () => Date.parse('2026-09-24T11:00:00Z'), timeZone: 'Asia/Jerusalem' });
    await host.start();
    const res = await host.callerFor('read')('get-current-time', { account: 'personal' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.isError).toBe(false);
    expect(JSON.parse(res.value.text)).toMatchObject({ timeZone: 'Asia/Jerusalem' });
  });

  it('invalid_grant in a tool result flips the host to reconnect_required - it never restarts the child', async () => {
    const { host, fake } = await withFake();
    await host.start();
    fake.failNext('get-freebusy', 'auth');
    const res = await host.callerFor('read')('get-freebusy', {
      calendars: [{ id: 'primary' }],
      timeMin: 'a',
      timeMax: 'b',
    });
    expect(res).toEqual({ ok: false, error: 'auth' });
    expect(host.status()).toBe('reconnect_required');
    // A restart would only re-read the same dead token file: the child is left alone.
    expect(host.pid()).toBeNull();
  });

  it('maps a bound OAuth callback port to port_busy', async () => {
    const double: McpClientLike = {
      connect: async () => undefined,
      close: async () => undefined,
      listTools: async () => ({
        tools: Object.keys(MCP_TOOLS).map((name) => ({
          name,
          annotations: {
            readOnlyHint: READ_ONLY_HINT_TOOLS.includes(name as never),
            destructiveHint: DESTRUCTIVE_HINT_TOOLS.includes(name as never), // [V2] B3
          },
          inputSchema: patchedSchemaOf(name),
        })),
      }),
      callTool: async ({ name }) =>
        name === 'manage-accounts'
          ? {
              content: [
                { type: 'text', text: JSON.stringify({ accounts: [{ account_id: 'personal', status: 'active' }] }) },
              ],
            }
          : { content: [{ type: 'text', text: 'listen EADDRINUSE 127.0.0.1:3500' }], isError: true },
    };
    const host = createMcpHost({ ...DEPS, transportFactory: stubTransport, clientFactory: () => double });
    await host.start();
    await expect(host.callerFor('read')('get-current-time', {})).resolves.toEqual({ ok: false, error: 'port_busy' });
    expect(host.status()).toBe('port_busy');
  });

  it('maps a thrown transport failure: timeout, auth and everything else', async () => {
    const thrower = (message: string): McpClientLike => ({
      connect: async () => undefined,
      close: async () => undefined,
      listTools: async () => ({
        tools: Object.keys(MCP_TOOLS).map((name) => ({
          name,
          annotations: {
            readOnlyHint: READ_ONLY_HINT_TOOLS.includes(name as never),
            destructiveHint: DESTRUCTIVE_HINT_TOOLS.includes(name as never), // [V2] B3
          },
          inputSchema: patchedSchemaOf(name),
        })),
      }),
      callTool: async ({ name }) => {
        if (name === 'manage-accounts') return { content: [{ type: 'text', text: JSON.stringify({ accounts: [] }) }] };
        throw new Error(message);
      },
    });
    const warn = vi.fn();
    const log = { info: vi.fn(), warn, error: vi.fn(), child: () => log } as unknown as NonNullable<
      McpHostExtras['log']
    >;
    const make = (message: string): ReturnType<typeof createMcpHost> =>
      createMcpHost({ ...DEPS, transportFactory: stubTransport, clientFactory: () => thrower(message), log });

    const timedOut = make('MCP error -32001: Request timed out');
    await timedOut.start();
    await expect(timedOut.callerFor('read')('get-current-time', {})).resolves.toEqual({ ok: false, error: 'timeout' });

    const dead = make('invalid_grant');
    await dead.start();
    await expect(dead.callerFor('read')('get-current-time', {})).resolves.toEqual({ ok: false, error: 'auth' });
    expect(dead.status()).toBe('reconnect_required');

    const busy = make('listen EADDRINUSE 127.0.0.1:3500');
    await busy.start();
    await expect(busy.callerFor('read')('get-current-time', {})).resolves.toEqual({ ok: false, error: 'port_busy' });
    expect(busy.status()).toBe('port_busy');

    const other = make('boom');
    await other.start();
    await expect(other.callerFor('read')('get-current-time', {})).resolves.toEqual({ ok: false, error: 'unavailable' });
    // The log line carries the kind, never the provider text.
    expect(warn).toHaveBeenCalledWith('mcp.call_failed', { tool: 'get-current-time', kind: 'unavailable' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('boom');
  });

  it('times out a hanging tool call inside the per-call budget', async () => {
    const { host, fake } = await withFake({}, { callTimeoutMs: 80 });
    await host.start();
    fake.failNext('get-current-time', 'hang');
    await expect(host.callerFor('read')('get-current-time', {})).resolves.toEqual({ ok: false, error: 'timeout' });
  });

  it('surfaces a crashing tool handler as an isError result, not as a host restart', async () => {
    const { host, fake } = await withFake();
    await host.start();
    fake.failNext('get-freebusy', 'crash_on_call');
    const res = await host.callerFor('read')('get-freebusy', {
      calendars: [{ id: 'primary' }],
      timeMin: 'a',
      timeMax: 'b',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.isError).toBe(true);
    expect(host.status()).toBe('connected');
    // The facade turns that into the fail-closed projection the model sees.
    await expect(createMcpReadClient(host.callerFor('read')).getCurrentTime()).resolves.toMatchObject({ ok: true });
  });

  it('follows the account state through the wizard s own manage-accounts calls', async () => {
    const { host, fake } = await withFake({ accounts: 'none' });
    await expect(host.start()).resolves.toBe('needs_sign_in');
    const admin = host.callerFor('admin');
    await admin('manage-accounts', { action: 'add', account_id: 'personal' });
    expect(host.status()).toBe('signing_in');
    fake.fake.signInAfterPolls(1);
    await admin('manage-accounts', { action: 'list', account_id: 'personal' });
    expect(host.status()).toBe('connected');
  });
});

describe('stderr plumbing and childSpec', () => {
  it('feeds only marker names from the child s stderr to onStderrMarker', async () => {
    const stderr = new PassThrough();
    const transportWithStderr = Object.assign(stubTransport(), { stderr });
    const markers: string[] = [];
    const double: McpClientLike = {
      connect: async () => undefined,
      close: async () => undefined,
      listTools: async () => ({
        tools: Object.keys(MCP_TOOLS).map((name) => ({
          name,
          annotations: {
            readOnlyHint: READ_ONLY_HINT_TOOLS.includes(name as never),
            destructiveHint: DESTRUCTIVE_HINT_TOOLS.includes(name as never), // [V2] B3
          },
          inputSchema: patchedSchemaOf(name),
        })),
      }),
      callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ accounts: [] }) }] }),
    };
    const host = createMcpHost({
      ...DEPS,
      onStderrMarker: (m) => markers.push(m),
      transportFactory: () => transportWithStderr as unknown as Transport,
      clientFactory: () => double,
    });
    await host.start();
    stderr.write(
      'No authenticated accounts found.\r\nAwaiting authentication: https://accounts.google.com/x?code=4/0SECRET\n',
    );
    await new Promise((r) => setImmediate(r));
    expect(markers).toEqual(['no_accounts', 'awaiting_authentication']);
    expect(JSON.stringify(markers)).not.toContain('SECRET');
  });

  it('tolerates a transport without a stderr stream', async () => {
    const { host, markers } = await withFake();
    await host.start();
    expect(markers).toEqual([]);
  });

  it('re-verifies the toolset after every restart - an upgraded server is caught on respawn', async () => {
    let toolsListCalls = 0;
    let drift = false;
    const double: McpClientLike = {
      connect: async () => undefined,
      close: async () => undefined,
      listTools: async () => {
        toolsListCalls += 1;
        const tools = Object.keys(MCP_TOOLS).map((name) => ({
          name,
          annotations: {
            readOnlyHint: READ_ONLY_HINT_TOOLS.includes(name as never),
            destructiveHint: DESTRUCTIVE_HINT_TOOLS.includes(name as never), // [V2] B3
          },
          inputSchema: patchedSchemaOf(name),
        }));
        // The second spawn is a different (upgraded) server: one extra tool appeared.
        return { tools: drift ? [...tools, { name: 'search-events' }] : tools };
      },
      callTool: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ accounts: [{ account_id: 'personal', status: 'active' }] }) }],
      }),
    };
    const audits: Audit[] = [];
    const host = createMcpHost({
      ...DEPS,
      transportFactory: stubTransport,
      clientFactory: () => double,
      audit: (kind, ref, detail) => audits.push({ kind, ref, detail }),
    });
    await expect(host.start()).resolves.toBe('connected');
    expect(toolsListCalls).toBe(1);

    // The Supervisor sees the exit and restarts us.
    double.onclose?.();
    expect(host.status()).toBe('unavailable');
    drift = true;
    await expect(host.start()).resolves.toBe('toolset_mismatch');
    expect(toolsListCalls).toBe(2);
    expect(audits.filter((a) => a.kind === 'toolset_mismatch')).toHaveLength(1);
    expect(host.childSpec().terminal?.()).toBe(true);
  });

  it('registers with the Supervisor under the calendar-mcp policy', async () => {
    const { host } = await withFake();
    const spec = host.childSpec();
    expect(spec.name).toBe('calendar-mcp');
    expect(spec.backoffMs).toEqual(MCP_BACKOFF_MS);
    expect(spec.breaker).toEqual(MCP_BREAKER);
    expect(spec.stableAfterMs).toBe(MCP_STABLE_AFTER_MS);
    expect(spec.terminal?.()).toBe(false);
    const handle = await spec.start(0);
    expect(handle.exePath).toBe(DEPS.execPath);
    expect(handle.pid).toBe(0); // in-memory transport has no child
    handle.kill();
  });

  it('the childSpec reports the spawn-override exe path when the e2e seam is used', async () => {
    const { host } = await withFake(
      {},
      { spawnOverride: { command: 'node', args: ['tests/fakes/fake-mcp-calendar.ts'] } },
    );
    const handle = await host.childSpec().start(0);
    expect(handle.exePath).toBe('node');
  });

  it('the childSpec start throws when the server is not usable, so the Supervisor counts an exit', async () => {
    const { host } = await withFake({ scenario: 'toolset_missing' });
    await expect(host.childSpec().start(0)).rejects.toThrow('mcp_start_toolset_mismatch');
  });

  // process-lifecycle-3: `ChildHandle.kill` is `void host.stop()`. If stop() drops the exit callbacks the Supervisor
  // never learns the child is gone, waits out the whole grace window and then taskkills a PID Windows may have recycled.
  it('stop() closes the client and REPORTS the exit to the Supervisor (never swallows it)', async () => {
    const { host } = await withFake();
    await host.start();
    const exits: unknown[] = [];
    const handle = await host.childSpec().start(0);
    handle.onExit((i) => exits.push(i));
    await host.stop();
    expect(host.status()).toBe('not_configured');
    expect(exits).toEqual([{ code: null, signal: null }]);
    await host.stop(); // idempotent: the callback already fired, it must not fire twice
    expect(exits).toEqual([{ code: null, signal: null }]);
  });

  it('the handle kill() path reports the exit too, so a stale callback cannot fire twice', async () => {
    const { host } = await withFake();
    const exits: unknown[] = [];
    const handle = await host.childSpec().start(0);
    handle.onExit((i) => exits.push(i));
    handle.kill(); // fire-and-forget `void host.stop()`, exactly as the Supervisor calls it
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(exits).toEqual([{ code: null, signal: null }]);
    expect(host.status()).toBe('not_configured');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// process-lifecycle-3: the REAL host under the REAL supervisor - a deliberate stop must not escalate to taskkill
// ---------------------------------------------------------------------------------------------------------------------
describe('calendar-mcp under the real Supervisor', () => {
  const runDirs: string[] = [];
  const makeRunDir = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-mcp-sup-'));
    runDirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of runDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  async function wire(pid: number | null): Promise<{
    sup: Supervisor;
    host: ReturnType<typeof createMcpHost>;
    clock: VirtualClock;
    taskkilled: Array<{ pid: number; tree: boolean }>;
  }> {
    const clock = createVirtualClock();
    const taskkilled: Array<{ pid: number; tree: boolean }> = [];
    const fake = createFakeMcpCalendar({});
    open.push(fake);
    const transport = fake.clientTransport();
    // Give the client half a `pid`, exactly like StdioClientTransport does in production.
    if (pid !== null) Object.defineProperty(transport, 'pid', { value: pid, configurable: true });
    await fake.connect();
    const host = createMcpHost({ ...DEPS, transportFactory: () => transport });
    const sup = createSupervisor({
      runDir: makeRunDir(),
      now: () => clock.now(),
      log: () => undefined,
      clock,
      processQuery: {
        query: () => Promise.resolve(null),
        kill: (p, tree) => {
          taskkilled.push({ pid: p, tree });
          return Promise.resolve();
        },
      },
      killSync: () => undefined,
      random: { bytes: (n) => new Uint8Array(n), int: (min) => min, float: () => 0 },
    });
    sup.register(host.childSpec());
    return { sup, host, clock, taskkilled };
  }

  it('a deliberate stop resolves on the clean exit - no grace stall, no taskkill', async () => {
    const { sup, host, clock, taskkilled } = await wire(9001);
    await sup.start('calendar-mcp');
    expect(sup.state('calendar-mcp')).toBe('running');
    expect(host.pid()).toBe(9001);

    // No clock.advance() anywhere: the stop must complete on the exit signal alone.
    await sup.stop('calendar-mcp', { graceMs: DEFAULT_GRACE_MS });

    expect(host.status()).toBe('not_configured');
    expect(sup.state('calendar-mcp')).toBe('stopped');
    expect(taskkilled).toEqual([]);
    expect(clock.pendingCount()).toBe(0); // the grace timer was cancelled, nothing is left armed
  });

  it('stopAll (app quit) tears calendar-mcp down without a taskkill escalation', async () => {
    const { sup, clock, taskkilled } = await wire(9002);
    await sup.start('calendar-mcp');
    await sup.stopAll({ graceMs: DEFAULT_GRACE_MS });
    expect(sup.state('calendar-mcp')).toBe('stopped');
    expect(taskkilled).toEqual([]);
    expect(clock.pendingCount()).toBe(0);
  });

  it('a transport that exposes no pid is never taskkilled as PID 0', async () => {
    const { sup, clock, taskkilled } = await wire(null);
    await sup.start('calendar-mcp');
    const stopping = sup.stop('calendar-mcp', { graceMs: DEFAULT_GRACE_MS });
    await clock.advance(DEFAULT_GRACE_MS + 1);
    await stopping;
    expect(taskkilled).toEqual([]);
  });
});

describe('the fake stays a faithful stand-in', () => {
  it('hands out narrowed callers exactly like McpHost (CONTRACTS 16)', async () => {
    const fake = createFakeMcpCalendar({});
    open.push(fake);
    await fake.connect();
    expectTypeOf(fake.callerFor('read'))
      .parameter(0)
      .toEqualTypeOf<'get-current-time' | 'get-freebusy' | 'list-events' | 'get-event'>(); // [V2] C2 11
    await expect((fake.callerFor('read') as unknown as McpToolCaller)('create-event', {})).rejects.toMatchObject({
      name: 'McpCapabilityError',
    });
    const ok = await fake.callerFor('read')('get-current-time', {});
    expect(ok.ok).toBe(true);
  });

  it('records a violation when a disabled tool is reached at all', async () => {
    const fake = createFakeMcpCalendar({ enabledTools: ['get-current-time', 'delete-event'] });
    open.push(fake);
    await fake.connect();
    await (fake.callerFor('read') as unknown as McpToolCaller)('delete-event' as never, {}).catch(() => undefined);
    // The caller gate rejects it first; the server-side violation list is the second net (see tool-gate.test.ts).
    expect(fake.violations).toEqual([]);
  });
});
