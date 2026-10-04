// tests/integration/mcp-real-toolslist.test.ts - contract check against the REAL @cocal/google-calendar-mcp (owner W1-05 -> V2-W1-02).
// TESTS 3.2 + [V2] T2 3.7 / 5 row stage-calendar-mcp: the staged 2.6.3 bundle is patched OFFLINE with the `--patch-only` path of
// scripts/stage-calendar-mcp.mjs into a temp copy (F25: no npm, no network; the staged bundle itself is only read), and BOTH variants
// are spawned through process.execPath with a DUMMY gcp-oauth.keys.json and a temp token path. Each performs ONLY `initialize` +
// `tools/list`, and the test asserts
//   (a) the EIGHT enabled names, (b) readOnlyHint:true on the four READ tools and destructiveHint:true on update-event, (c) every
//   required field of our app-authored schemas exists, (d) the startup contract + the B4 update-surface guard of mcp/host.ts accept the
//   PATCHED server and disable only the update surface of the UNPATCHED one, (e) the fake's tools/list is deep-equal to the real one for
//   names + required fields + annotations + the schema insertions 1 and 3 (status enum, ifMatch) + get-event's `fields` enum (etag only
//   when patched - F12), for `patched:true` vs the patched server AND `patched:false` vs the pinned unpatched server.
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
import {
  DESTRUCTIVE_HINT_TOOLS,
  READ_ONLY_HINT_TOOLS,
  REQUIRED_INPUT_FIELDS,
  buildMcpSpawnSpec,
  verifyToolset,
  verifyUpdateSurface,
} from '../../src/main/mcp/host';
import {
  EXPECTED_TOOLS,
  PIN_PATH,
  classifyBundle,
  patchOnly,
  readJson,
  revertPatch,
  sha256Hex,
} from '../../scripts/stage-calendar-mcp.mjs';

// The project path contains a space: never URL.pathname (build-plan rule 1).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mcpRoot = path.join(repoRoot, 'build-resources', 'calendar-mcp');
const packageRoot = path.join(mcpRoot, 'node_modules', '@cocal', 'google-calendar-mcp');
const entry = path.join(packageRoot, 'build', 'index.js');

/** [R2] TESTS section 11: the server dereferences redirect_uris[0] before the MCP handshake. Synthetic sentinel values only. */
const DUMMY_CREDENTIALS =
  '{"installed":{"client_id":"TESTONLY.apps.googleusercontent.com","client_secret":"TESTONLY","redirect_uris":["http://localhost"]}}';
/** The OAuth callback ports the real server would bind IF it started a sign-in flow (calendar-mcp.md "OAuth flow"). */
const OAUTH_PORTS = [3500, 3501, 3502, 3503, 3504, 3505];

type Tool = Record<string, unknown>;
interface ToolShape {
  name: string;
  required: string[];
  annotations: Record<string, boolean>;
}

function normalise(tools: ReadonlyArray<Tool>): ToolShape[] {
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

const propsOf = (tools: ReadonlyArray<Tool>, name: string): Record<string, Record<string, unknown>> => {
  const tool = tools.find((t) => t.name === name);
  const schema = (tool?.inputSchema ?? {}) as { properties?: Record<string, Record<string, unknown>> };
  return schema.properties ?? {};
};
/** The B4 schema insertions 1 + 3 as the JSON schema shows them (description excluded - wording is not a contract). */
function insertions(tools: ReadonlyArray<Tool>): { status: unknown; ifMatch: unknown } {
  const props = propsOf(tools, 'update-event');
  const pick = (p: Record<string, unknown> | undefined): unknown =>
    p === undefined ? null : { type: p.type ?? null, enum: Array.isArray(p.enum) ? [...p.enum].sort() : null };
  return { status: pick(props.status), ifMatch: pick(props.ifMatch) };
}
/** get-event `fields` item enum (= ALLOWED_EVENT_FIELDS of the bundle, + 'etag' after insertion 6). */
function fieldsEnum(tools: ReadonlyArray<Tool>): string[] {
  const fields = propsOf(tools, 'get-event').fields as { items?: { enum?: unknown } } | undefined;
  const values = fields?.items?.enum;
  return Array.isArray(values) ? values.map(String).sort() : [];
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

async function fakeTools(patched: boolean): Promise<Tool[]> {
  const fake = createFakeCalendar({ enabledTools: Object.keys(MCP_TOOLS), patched });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await fake.server.connect(serverT);
  const fakeClient = new Client({ name: 'fake-contract-probe', version: '0.0.0' });
  await fakeClient.connect(clientT);
  try {
    return (await fakeClient.listTools()).tools as unknown as Tool[];
  } finally {
    await fakeClient.close().catch(() => undefined);
    await fake.server.close().catch(() => undefined);
  }
}

describe('the real @cocal/google-calendar-mcp tools/list contract (patched + unpatched)', () => {
  let tmpDir = '';
  /** Inside the staged node_modules (git-ignored; dot-folders are not packages) so the copy resolves the bundle's own dependencies. */
  let copyRoot = '';
  let patchedTools: Tool[] = [];
  let unpatchedTools: Tool[] = [];
  let patchedSha = '';
  let unpatchedSha = '';
  let stagedShaBefore = '';
  /** Observations for ops notes (TESTS concern C7: whether the server stays passive is UNVERIFIED). */
  const stderrLines: string[] = [];
  let listeningPorts: number[] = [];

  async function list(serverEntry: string, credentialsPath: string): Promise<Tool[]> {
    // Exactly the spawn contract of ARCH 5.1 (env block), with system Node in place of the Electron binary and the entry of the copy.
    const spec = buildMcpSpawnSpec(
      {
        execPath: process.execPath,
        mcpRoot,
        credentialsPath,
        tokenPath: path.join(tmpDir, 'tokens.json'),
        onStderrMarker: () => undefined,
      },
      { command: process.execPath, args: [serverEntry, 'start', '--transport', 'stdio'] },
    );
    expect(spec.env.ENABLED_TOOLS).toBe(ENABLED_TOOLS_ENV);
    const transport = new StdioClientTransport(spec);
    const client = new Client({ name: 'whatsapp-calendar-agent-contract-test', version: '0.0.0' });
    transport.stderr?.on('data', (chunk: Buffer) => stderrLines.push(chunk.toString('utf8')));
    try {
      await client.connect(transport, { timeout: 30_000 });
      const tools = (await client.listTools(undefined, { timeout: 30_000 })).tools as unknown as Tool[];
      // Passivity probe: with dummy credentials and no tokens, `initialize` must not have started an OAuth callback server.
      for (const port of OAUTH_PORTS) if (await isListening(port)) listeningPorts.push(port);
      return tools;
    } finally {
      // The child must be gone before the first afterEach: the T7 leak guard fails a test that leaves one running.
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  }

  beforeAll(async () => {
    expect(fs.existsSync(entry), `staged MCP server missing at ${entry} - run npm run stage:mcp`).toBe(true);
    const pin = readJson(PIN_PATH) as { bundleSha256Unpatched: string; bundleSha256Patched: string } | null;
    expect(pin, 'vendor/calendar-mcp.pin.json').not.toBeNull();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-mcp-contract-'));
    copyRoot = fs.mkdtempSync(path.join(mcpRoot, 'node_modules', '.wca-patch-check-'));
    const credentialsPath = path.join(tmpDir, 'gcp-oauth.keys.json');
    fs.writeFileSync(credentialsPath, DUMMY_CREDENTIALS, 'utf8');

    const staged = fs.readFileSync(entry);
    stagedShaBefore = sha256Hex(staged);
    const kind = classifyBundle(staged, pin);
    const patchedDir = path.join(copyRoot, 'patched');
    const unpatchedDir = path.join(copyRoot, 'unpatched');
    fs.mkdirSync(path.join(unpatchedDir, 'build'), { recursive: true });
    fs.copyFileSync(path.join(packageRoot, 'package.json'), path.join(unpatchedDir, 'package.json'));
    if (kind === 'unpatched') {
      // The F25 path itself: --patch-only on a temp copy of the staged, still unpatched bundle.
      const r = patchOnly({ entry, outDir: patchedDir });
      expect(r).toMatchObject({ ok: true });
      fs.writeFileSync(path.join(unpatchedDir, 'build', 'index.js'), staged);
    } else {
      // V2-W2-04 already patched the staged bundle in place: it IS the patched server; the unpatched one is its exact inverse.
      expect(kind, 'the staged bundle is neither the pinned unpatched nor the pinned patched 2.6.3 bundle').toBe(
        'patched',
      );
      fs.mkdirSync(path.join(patchedDir, 'build'), { recursive: true });
      fs.copyFileSync(path.join(packageRoot, 'package.json'), path.join(patchedDir, 'package.json'));
      fs.writeFileSync(path.join(patchedDir, 'build', 'index.js'), staged);
      const reverted = revertPatch(staged.toString('utf8'));
      expect(reverted).toMatchObject({ ok: true });
      if (reverted.ok) fs.writeFileSync(path.join(unpatchedDir, 'build', 'index.js'), reverted.text, 'utf8');
    }
    patchedSha = sha256Hex(fs.readFileSync(path.join(patchedDir, 'build', 'index.js')));
    unpatchedSha = sha256Hex(fs.readFileSync(path.join(unpatchedDir, 'build', 'index.js')));
    expect(patchedSha).toBe(pin?.bundleSha256Patched);
    expect(unpatchedSha).toBe(pin?.bundleSha256Unpatched);

    listeningPorts = [];
    patchedTools = await list(path.join(patchedDir, 'build', 'index.js'), credentialsPath);
    unpatchedTools = await list(path.join(unpatchedDir, 'build', 'index.js'), credentialsPath);
  }, 90_000);

  afterAll(() => {
    if (tmpDir !== '') fs.rmSync(tmpDir, { recursive: true, force: true });
    if (copyRoot !== '') fs.rmSync(copyRoot, { recursive: true, force: true });
  });

  it('patched a temp copy only: the staged bundle is byte-identical afterwards and both copies match their pins', () => {
    expect(sha256Hex(fs.readFileSync(entry))).toBe(stagedShaBefore);
    expect(patchedSha).not.toBe(unpatchedSha);
  });

  it('(a) exposes exactly the eight tools of ENABLED_TOOLS (both variants) = the tool-list pin', () => {
    const expected = Object.keys(MCP_TOOLS).slice().sort();
    expect(expected).toEqual([...EXPECTED_TOOLS].sort());
    expect(patchedTools.map((t) => String(t.name)).sort()).toEqual(expected);
    expect(unpatchedTools.map((t) => String(t.name)).sort()).toEqual(expected);
  });

  it('(b) marks the four READ tools readOnlyHint:true and update-event destructiveHint:true', () => {
    for (const name of READ_ONLY_HINT_TOOLS) {
      const tool = patchedTools.find((t) => t.name === name);
      expect(tool, `tool ${name} missing`).toBeDefined();
      expect((tool?.annotations as { readOnlyHint?: unknown } | undefined)?.readOnlyHint, name).toBe(true);
    }
    for (const name of DESTRUCTIVE_HINT_TOOLS) {
      const tool = patchedTools.find((t) => t.name === name);
      expect((tool?.annotations as { destructiveHint?: unknown } | undefined)?.destructiveHint, name).toBe(true);
    }
  });

  it('(c) still requires every field our app-authored schemas rely on', () => {
    for (const [name, fields] of Object.entries(REQUIRED_INPUT_FIELDS)) {
      const tool = patchedTools.find((t) => t.name === name);
      expect(tool, `tool ${name} missing`).toBeDefined();
      const required = ((tool?.inputSchema as { required?: string[] } | undefined)?.required ?? []).map(String);
      for (const field of fields) expect(required, `${name}.${field}`).toContain(field);
    }
  });

  it('(d) the startup contract accepts both; the B4 guard opens the update surface for the PATCHED server only', () => {
    expect(verifyToolset(patchedTools as never)).toBeNull();
    expect(verifyToolset(unpatchedTools as never)).toBeNull();
    expect(verifyUpdateSurface(patchedTools as never)).toEqual({ available: true });
    expect(verifyUpdateSurface(unpatchedTools as never)).toEqual({ available: false, problem: 'status_missing' });
  });

  it('(d) the patched server shows insertions 1, 3 and 6 in tools/list; the unpatched one none of them', () => {
    expect(insertions(patchedTools)).toEqual({
      status: { type: 'string', enum: ['cancelled', 'confirmed', 'tentative'] },
      ifMatch: { type: 'string', enum: null },
    });
    expect(insertions(unpatchedTools)).toEqual({ status: null, ifMatch: null });
    expect(fieldsEnum(patchedTools)).toContain('etag');
    expect(fieldsEnum(unpatchedTools)).not.toContain('etag');
    expect(fieldsEnum(patchedTools)).toEqual([...fieldsEnum(unpatchedTools), 'etag'].sort());
  });

  it('(e) the default (patched) fake is deep-equal to the patched server: names, required, annotations, insertions, fields', async () => {
    const tools = await fakeTools(true);
    expect(normalise(tools)).toEqual(normalise(patchedTools));
    expect(insertions(tools)).toEqual(insertions(patchedTools));
    expect(fieldsEnum(tools)).toEqual(fieldsEnum(patchedTools));
  });

  it('(e) the patched:false fake is deep-equal to the pinned UNPATCHED server (F12)', async () => {
    const tools = await fakeTools(false);
    expect(normalise(tools)).toEqual(normalise(unpatchedTools));
    expect(insertions(tools)).toEqual(insertions(unpatchedTools));
    expect(fieldsEnum(tools)).toEqual(fieldsEnum(unpatchedTools));
  });

  it('stays passive during initialize: no OAuth callback port, no sign-in attempt', () => {
    // C7 observation, recorded in ops/agent-notes. A failure here is a FINDING, never something to work around: it would mean the
    // server opens a listener (and a browser) merely by being spawned.
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
