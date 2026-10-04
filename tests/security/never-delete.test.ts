// tests/security/never-delete.test.ts - security gate group 22 (never-delete half; T2 8.2; owner V2-W1-02).
// Invariants I3'/I7' (D-036): the app can create and change an event, it can NEVER delete one. A cancel is `update-event {status:
// 'cancelled'}` through the vendored patch (B4). This file proves, against production objects and the fake calendar:
//   1. `delete-event` is not in ENABLED_TOOLS / MCP_TOOLS / the fake's table / the staged-server tool-list pin;
//   2. `delete-event` (any spelling) is not a string literal anywhere under `src/` except the refusal list BLOCKED_NAMES (source walk
//      with the TypeScript scanner - comments do not count, template literals do);
//   3. a model (in-process loop) or a CLI (whose tool server forwards every call to the same `gate.invoke`, B16) asking for it is
//      blocked with the synthetic error, a sha8-only audit row and zero calendar traffic;
//   4. no facade can reach it: every `callerFor(cls)` rejects it with McpCapabilityError before the server sees a byte;
//   5. were it ever called, the fake records `write_or_disabled_tool_called:delete-event` and ledger rule 8 fails the test.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BLOCKED_NAMES, createToolGate, type RunCtx } from '../../src/main/agent/toolGate.ts';
import { createHandleTable } from '../../src/main/agent/handles.ts';
import {
  ENABLED_TOOLS_ENV,
  MCP_TOOLS,
  McpCapabilityError,
  createMcpReadClient,
} from '../../src/main/mcp/readClient.ts';
import type { McpToolCaller, McpToolClass } from '../../src/main/mcp/readClient.ts';
import { createMcpHost, buildMcpEnv } from '../../src/main/mcp/host.ts';
import { createMcpWriteClient } from '../../src/main/mcp/writeClient.ts';
import { DEFAULT_SETTINGS } from '../../src/shared/settings.ts';
import type { AuditEntry, AuditKind, EpochMs, ItemId, RunId } from '../../src/shared/types.ts';
import {
  FAKE_MCP_TOOLS,
  createFakeCalendar,
  createFakeMcpCalendar,
  neverDeleteProblems,
  type FakeMcpCalendar,
} from '../fakes/fake-mcp-calendar.ts';
import { EXPECTED_TOOLS, PIN_PATH, readJson } from '../../scripts/stage-calendar-mcp.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const DELETE_RE = /delete[-_ ]?event/i;
const DELETE_SPELLINGS = [
  'delete-event',
  'delete_event',
  'Delete-Event',
  'DELETE_EVENT',
  'deleteEvent',
  'delete-events',
];
const sha8 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);

const open: FakeMcpCalendar[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.stop().catch(() => undefined);
});

// ---------------------------------------------------------------------------------------------------------------------
// 1. tables
// ---------------------------------------------------------------------------------------------------------------------

describe('1. delete-event is enabled nowhere', () => {
  it('not in ENABLED_TOOLS (the env the server gets), MCP_TOOLS, the fake table or the tool-list pin', () => {
    expect(ENABLED_TOOLS_ENV.split(',')).not.toContain('delete-event');
    expect(buildMcpEnv({ credentialsPath: 'C:/x', tokenPath: 'C:/y' }).ENABLED_TOOLS).not.toMatch(DELETE_RE);
    expect(Object.keys(MCP_TOOLS)).not.toContain('delete-event');
    expect(Object.keys(FAKE_MCP_TOOLS)).not.toContain('delete-event');
    expect(EXPECTED_TOOLS).not.toContain('delete-event');
    expect((readJson(PIN_PATH) as { enabledTools: string[] }).enabledTools).not.toContain('delete-event');
    for (const name of Object.keys(MCP_TOOLS)) expect(name).not.toMatch(DELETE_RE);
  });

  it('the refusal list names it in both spellings (compared case-insensitively by the gate)', () => {
    expect(BLOCKED_NAMES).toContain('delete-event');
    expect(BLOCKED_NAMES).toContain('delete_event');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. source walk
// ---------------------------------------------------------------------------------------------------------------------

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '__fixtures__' || name === 'locales') continue;
      sourceFiles(full, out);
    } else if (/\.(ts|tsx|mts|cts)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every string literal / template chunk mentioning delete-event, with the enclosing `const` name when there is one. */
function deleteLiterals(file: string): Array<{ text: string; owner: string | null; line: number }> {
  const source = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits: Array<{ text: string; owner: string | null; line: number }> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      const text = node.text;
      if (DELETE_RE.test(text)) {
        let p: ts.Node | undefined = node.parent;
        let owner: string | null = null;
        while (p !== undefined) {
          if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
            owner = p.name.text;
            break;
          }
          p = p.parent;
        }
        hits.push({ text, owner, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/**
 * The only literals allowed. BLOCKED_NAMES is the refusal list (spec). `*.fixtures.ts` modules are test support (excluded from coverage and
 * from the production entry graph): `src/main/llm/scripted.fixtures.ts` is the ATTACKER's scripted output (a model asking for
 * delete-event), which is exactly what section 3 proves is refused.
 */
const ALLOWED = [
  { file: 'src/main/agent/toolGate.ts', owner: 'BLOCKED_NAMES' },
  { file: 'src/main/llm/scripted.fixtures.ts', owner: null },
];

describe('2. no src/ string literal names delete-event outside BLOCKED_NAMES', () => {
  it('source walk (TypeScript scanner: comments ignored, template literals and JSX text included)', () => {
    const offenders: string[] = [];
    let blockedListHits = 0;
    for (const file of sourceFiles(join(REPO, 'src'))) {
      const rel = relative(REPO, file).replace(/\\/g, '/');
      for (const hit of deleteLiterals(file)) {
        const allowed = ALLOWED.find((a) => a.file === rel && (a.owner === null || a.owner === hit.owner));
        if (allowed === undefined) offenders.push(`${rel}:${hit.line} (${hit.owner ?? 'no const'})`);
        else if (allowed.owner === 'BLOCKED_NAMES') blockedListHits += 1;
      }
    }
    expect(offenders).toEqual([]);
    expect(blockedListHits).toBeGreaterThanOrEqual(2); // the walker really sees the literals it is meant to allow
  });

  it('the walker is not blind: it finds literals and ignores comments', () => {
    const probe = join(REPO, 'tests', 'security', 'never-delete.test.ts');
    const hits = deleteLiterals(probe);
    expect(hits.some((h) => h.owner === 'DELETE_SPELLINGS')).toBe(true);
    expect(hits.some((h) => h.text.includes('I3'))).toBe(false); // the header comment mentions delete-event and is not a literal
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. a model or a CLI asking for it
// ---------------------------------------------------------------------------------------------------------------------

describe('3. a model / CLI asking for delete-event is blocked by the gate', () => {
  it('every spelling => synthetic error, sha8-only audit, strikes, zero reads, zero calendar calls', async () => {
    const fake = createFakeMcpCalendar({ timeZone: 'Asia/Jerusalem' });
    open.push(fake);
    await fake.connect();
    const readCalls: string[] = [];
    const read = createMcpReadClient(async (tool, args) => {
      readCalls.push(tool);
      return fake.callerFor('read')(tool, args);
    });
    const audits: Array<{ ref: string; detail: Record<string, unknown> }> = [];
    const gate = createToolGate({
      read,
      wa: { recentChats: () => [], chatMessages: () => [], search: () => [], context: () => null } as never,
      settings: () => DEFAULT_SETTINGS,
      calendarConnected: () => true,
      waAvailable: () => false,
      audit: (_kind, ref, detail) => audits.push({ ref, detail }),
    });
    const ctx: RunCtx = {
      runId: 9 as RunId,
      itemId: 1 as ItemId,
      chatId: 1 as RunCtx['chatId'],
      nowMs: Date.UTC(2026, 8, 28, 8) as EpochMs,
      timeZone: 'Asia/Jerusalem',
      nonce: '0123456789abcdef',
      calls: {},
      totalCalls: 0,
      blockedCalls: 0,
      signal: new AbortController().signal,
      handles: createHandleTable(1 as RunCtx['chatId']),
      waRowsServed: 0,
      crossChatRows: 0,
      otherChatTexts: [],
    };
    for (const name of DELETE_SPELLINGS) {
      const out = await gate.invoke(
        { id: 'tc', name, input: { calendarId: 'primary', eventId: 'all' } },
        { ...ctx, blockedCalls: 0 },
      );
      expect(out.verdict, name).not.toBe('executed');
      expect(out.result.content, name).toContain('tool not available');
      expect(out.result.content).not.toMatch(DELETE_RE);
    }
    expect(readCalls).toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(audits.length).toBe(DELETE_SPELLINGS.length);
    for (const [i, a] of audits.entries()) {
      expect(a.detail.nameSha8).toBe(sha8(DELETE_SPELLINGS[i] as string));
      expect(JSON.stringify(a)).not.toMatch(DELETE_RE);
    }
    // It is never offered either.
    expect(
      gate
        .exposedTools()
        .map((t) => t.name)
        .join(','),
    ).not.toMatch(DELETE_RE);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. no facade can reach it
// ---------------------------------------------------------------------------------------------------------------------

describe('4. no capability class reaches delete-event', () => {
  it('callerFor(read|write|admin) rejects it with McpCapabilityError + a tool_blocked audit before the server sees a call', async () => {
    const fake = createFakeMcpCalendar({ timeZone: 'Asia/Jerusalem' });
    open.push(fake);
    const transport = fake.clientTransport();
    await fake.connect();
    const audits: Array<{ kind: AuditKind; detail: AuditEntry['detail'] }> = [];
    const host = createMcpHost({
      execPath: process.execPath,
      mcpRoot: 'C:/nonexistent/calendar-mcp',
      credentialsPath: 'C:/nonexistent/credentials.json',
      tokenPath: 'C:/nonexistent/tokens.json',
      onStderrMarker: () => undefined,
      transportFactory: () => transport,
      audit: (kind, _ref, detail) => audits.push({ kind, detail }),
    });
    await host.start();
    const before = fake.calls.length;
    for (const cls of ['read', 'write', 'admin'] as McpToolClass[]) {
      await expect(
        (host.callerFor(cls) as unknown as McpToolCaller)('delete-event' as never, {}),
      ).rejects.toBeInstanceOf(McpCapabilityError);
    }
    expect(fake.calls).toHaveLength(before);
    expect(audits.filter((a) => a.kind === 'tool_blocked')).toHaveLength(3);
    // The facades have no such method at all.
    const write = createMcpWriteClient(host.callerFor('write'));
    expect(Object.keys(write)).toEqual(['createEvent', 'updateEvent']);
    expect(Object.keys(createMcpReadClient(host.callerFor('read')))).not.toContain('deleteEvent');
    expect(fake.violations).toEqual([]);
    await host.stop();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. the net behind the nets
// ---------------------------------------------------------------------------------------------------------------------

describe('5. were it ever called, the fake and ledger rule 8 catch it', () => {
  it('a raw MCP client calling delete-event records the violation even though the name is not registered', async () => {
    const fake = createFakeCalendar({});
    const [c, s] = InMemoryTransport.createLinkedPair();
    await fake.server.connect(s);
    const client = new Client({ name: 'raw', version: '0' });
    await client.connect(c);
    try {
      const listed = (await client.listTools()).tools.map((t) => t.name);
      expect(listed).not.toContain('delete-event');
      const res = await client.callTool({ name: 'delete-event', arguments: { calendarId: 'primary', eventId: 'x' } });
      expect(res.isError).toBe(true);
      expect(fake.violations).toEqual(['write_or_disabled_tool_called:delete-event']);
      expect(neverDeleteProblems(fake.calls)).toHaveLength(1);
      expect(neverDeleteProblems([{ tool: 'create-event' }, { tool: 'update-event' }])).toEqual([]);
    } finally {
      await client.close();
      await fake.server.close();
    }
  });
});
