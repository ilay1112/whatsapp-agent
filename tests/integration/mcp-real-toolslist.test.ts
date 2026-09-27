// tests/integration/mcp-real-toolslist.test.ts - contract check against the REAL @cocal/google-calendar-mcp (owner W1-05).
// TESTS 3.2: spawn the staged server from build-resources/calendar-mcp through process.execPath with a DUMMY
// gcp-oauth.keys.json and a temp token path, perform ONLY `initialize` + `tools/list`, and assert
//   (a) the six enabled names, (b) readOnlyHint:true on the three READ tools, (c) every required field of our
//   app-authored schemas exists in the server's inputSchema, (d) the fake's tools/list is deep-equal to the real one
//   for names + required fields + annotations (keeps the fake honest).
// It NEVER issues tools/call, never signs in and never reaches the network (the dummy client is never exchanged).
// A missing build-resources/calendar-mcp/node_modules FAILS the test - a skipped contract test is a silent hole.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeCalendar } from '../fakes/fake-mcp-calendar';
import { MCP_TOOLS, ENABLED_TOOLS_ENV } from '../../src/main/mcp/readClient';
import { READ_ONLY_HINT_TOOLS, REQUIRED_INPUT_FIELDS, buildMcpSpawnSpec, verifyToolset } from '../../src/main/mcp/host';

// The project path contains a space: never URL.pathname (build-plan rule 1).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mcpRoot = path.join(repoRoot, 'build-resources', 'calendar-mcp');
const entry = path.join(mcpRoot, 'node_modules', '@cocal', 'google-calendar-mcp', 'build', 'index.js');

/** [R2] TESTS section 11: the server dereferences redirect_uris[0] before the MCP handshake. Synthetic sentinel values only. */
const DUMMY_CREDENTIALS =
  '{"installed":{"client_id":"TESTONLY.apps.googleusercontent.com","client_secret":"TESTONLY","redirect_uris":["http://localhost"]}}';
/** The OAuth callback ports the real server would bind IF it started a sign-in flow (calendar-mcp.md "OAuth flow"). */
const OAUTH_PORTS = [3500, 3501, 3502, 3503, 3504, 3505];

interface ToolShape {
  name: string;
  required: string[];
  annotations: Record<string, boolean>;
}

function normalise(tools: ReadonlyArray<Record<string, unknown>>): ToolShape[] {
  return tools
    .map((t) => {
      const schema = (t.inputSchema ?? {}) as { required?: unknown };
      const raw = (t.annotations ?? {}) as Record<string, unknown>;
      const annotations: Record<string, boolean> = {};
      for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        if (typeof raw[key] === 'boolean') annotations[key] = raw[key];
      }
      return {
        name: String(t.name),
        required: (Array.isArray(schema.required) ? schema.required.map(String) : []).slice().sort(),
        annotations,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Is anything listening on 127.0.0.1:<port>? Loopback only, so the network guard (T3) allows it. */
async function isListening(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

describe('the real @cocal/google-calendar-mcp tools/list contract', () => {
  let tmpDir = '';
  let realTools: Array<Record<string, unknown>> = [];
  /** Observations for ops notes (TESTS concern C7: whether the server stays passive is UNVERIFIED). */
  const stderrLines: string[] = [];
  let listeningPorts: number[] = [];

  beforeAll(async () => {
    expect(fs.existsSync(entry), `staged MCP server missing at ${entry} - run npm run stage:mcp`).toBe(true);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-mcp-contract-'));
    const credentialsPath = path.join(tmpDir, 'gcp-oauth.keys.json');
    fs.writeFileSync(credentialsPath, DUMMY_CREDENTIALS, 'utf8');

    // Exactly the spawn contract of ARCH 5.1, with system Node in place of the Electron binary (vitest runs under Node).
    const spec = buildMcpSpawnSpec({
      execPath: process.execPath,
      mcpRoot,
      credentialsPath,
      tokenPath: path.join(tmpDir, 'tokens.json'),
      onStderrMarker: () => undefined,
    });
    expect(spec.env.ENABLED_TOOLS).toBe(ENABLED_TOOLS_ENV);

    const transport = new StdioClientTransport(spec);
    const client = new Client({ name: 'whatsapp-calendar-agent-contract-test', version: '0.0.0' });
    transport.stderr?.on('data', (chunk: Buffer) => stderrLines.push(chunk.toString('utf8')));
    try {
      await client.connect(transport, { timeout: 30_000 });
      realTools = (await client.listTools(undefined, { timeout: 30_000 })).tools as unknown as Array<
        Record<string, unknown>
      >;

      // Passivity probe: with dummy credentials and no tokens, `initialize` must not have started an OAuth callback server.
      listeningPorts = [];
      for (const port of OAUTH_PORTS) if (await isListening(port)) listeningPorts.push(port);
    } finally {
      // The child must be gone before the first afterEach: the T7 leak guard fails a test that leaves one running.
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  }, 60_000);

  afterAll(() => {
    if (tmpDir !== '') fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('(a) exposes exactly the six tools of ENABLED_TOOLS', () => {
    expect(realTools.map((t) => String(t.name)).sort()).toEqual(Object.keys(MCP_TOOLS).slice().sort());
  });

  it('(b) marks the three READ tools readOnlyHint:true', () => {
    for (const name of READ_ONLY_HINT_TOOLS) {
      const tool = realTools.find((t) => t.name === name);
      expect(tool, `tool ${name} missing`).toBeDefined();
      expect((tool?.annotations as { readOnlyHint?: unknown } | undefined)?.readOnlyHint, name).toBe(true);
    }
  });

  it('(c) still requires every field our app-authored schemas rely on', () => {
    for (const [name, fields] of Object.entries(REQUIRED_INPUT_FIELDS)) {
      const tool = realTools.find((t) => t.name === name);
      expect(tool, `tool ${name} missing`).toBeDefined();
      const required = ((tool?.inputSchema as { required?: string[] } | undefined)?.required ?? []).map(String);
      for (const field of fields) expect(required, `${name}.${field}`).toContain(field);
    }
  });

  it('the startup contract of mcp/host.ts accepts the real server unchanged', () => {
    expect(verifyToolset(realTools as never)).toBeNull();
  });

  it('(d) the fake is deep-equal to the real server for names, required fields and annotations', async () => {
    const fake = createFakeCalendar({ enabledTools: Object.keys(MCP_TOOLS) });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await fake.server.connect(serverT);
    const fakeClient = new Client({ name: 'fake-contract-probe', version: '0.0.0' });
    await fakeClient.connect(clientT);
    try {
      const fakeTools = (await fakeClient.listTools()).tools as unknown as Array<Record<string, unknown>>;
      expect(normalise(fakeTools)).toEqual(normalise(realTools));
    } finally {
      await fakeClient.close().catch(() => undefined);
      await fake.server.close().catch(() => undefined);
    }
  });

  it('stays passive during initialize: no OAuth callback port, no sign-in attempt', () => {
    // C7 observation, recorded in ops/agent-notes/W1-05-mcp-calendar.md. A failure here is a FINDING, never something
    // to work around: it would mean the server opens a listener (and a browser) merely by being spawned.
    expect(listeningPorts).toEqual([]);
    const stderr = stderrLines.join('');
    expect(stderr).not.toMatch(/awaiting[_ ]authentication/i);
    expect(stderr).not.toMatch(/oauth2callback/i);
    // Whatever it did write must not contain our dummy secret either.
    expect(stderr).not.toContain('TESTONLY.apps.googleusercontent.com');
  });

  it('issued no tools/call at any point', () => {
    // The contract test only ever performs initialize + tools/list; this is a guard against a future edit adding one.
    const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(source).not.toMatch(/\bcallTool\s*\(/);
  });
});
