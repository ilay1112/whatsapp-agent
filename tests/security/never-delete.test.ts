// tests/security/never-delete.test.ts - security gate group 22 (never-delete half; T2 8.2; owner V2-W1-02; [v4 T6] I9').
// v2 (I3'/I7', D-036): the app never deleted an event; a cancel is `update-event {status:'cancelled'}` (B4).
// [v4 T6] I9' (handover §2.5) keeps that for every CHAT action and for the model, and adds ONE exception: a user-authored calendar-view
// action (source 'manual', approved by a click) may delete an event without attendees / recurrence. This file proves:
//   1. `delete-event` is enabled as a WRITE tool (ENABLED_TOOLS / MCP_TOOLS / the fake / the staged pin agree) and is still on the
//      model's refusal list BLOCKED_NAMES;
//   2. the tool-name literal appears in src/ ONLY in the refusal list, the tool tables, the host's guard and the ONE manual write
//      method; the action-kind literal `delete_event` only in the shared contract, the migration and exec/manualEvents.ts;
//   3. a model (in-process loop) or a CLI asking for it is blocked with the synthetic error, a sha8-only audit row and zero traffic;
//   4. read / admin callers reject it with McpCapabilityError; the WRITE caller refuses it unless the call says source 'manual';
//   5. the fake still records `write_or_disabled_tool_called:delete-event` when the tool is not enabled, and ledger rule 8 fails any
//      delete-event that rule 13 did not prove to be a click-approved manual action.
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

describe('1. delete-event is a write tool for manual actions only, and never a model tool', () => {
  it('ENABLED_TOOLS (the env the server gets), MCP_TOOLS, the fake table and the tool-list pin agree: class write', () => {
    expect(ENABLED_TOOLS_ENV.split(',')).toContain('delete-event');
    expect(String(buildMcpEnv({ credentialsPath: 'C:/x', tokenPath: 'C:/y' }).ENABLED_TOOLS).split(',')).toContain(
      'delete-event',
    );
    expect(MCP_TOOLS['delete-event']).toBe('write');
    expect(FAKE_MCP_TOOLS['delete-event']).toBe('write');
    expect(EXPECTED_TOOLS).toContain('delete-event');
    expect((readJson(PIN_PATH) as { enabledTools: string[] }).enabledTools).toContain('delete-event');
    // no OTHER spelling is enabled
    expect(Object.keys(MCP_TOOLS).filter((n) => DELETE_RE.test(n))).toEqual(['delete-event']);
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
 * [v4 T6] The TOOL NAME (`delete-event`) may also appear in the tool tables (readClient MCP_TOOLS / ENABLED_TOOLS_ENV, host's
 * DESTRUCTIVE_HINT_TOOLS / REQUIRED_INPUT_FIELDS), the host's source guard (callerFor, no const) and the ONE write method
 * (writeClient.deleteManualEvent: `const res = await call('delete-event', ...)`). The ACTION KIND (`delete_event`) may appear in the
 * shared contract (types / schemas / ipc), the migration and exec/manualEvents.ts - and nowhere in a chat path.
 */
const ALLOWED = [
  { file: 'src/main/agent/toolGate.ts', owner: 'BLOCKED_NAMES' },
  { file: 'src/main/llm/scripted.fixtures.ts', owner: null },
  { file: 'src/main/mcp/readClient.ts', owner: 'MCP_TOOLS' },
  { file: 'src/main/mcp/readClient.ts', owner: 'ENABLED_TOOLS_ENV' },
  { file: 'src/main/mcp/host.ts', owner: 'DESTRUCTIVE_HINT_TOOLS' },
  { file: 'src/main/mcp/host.ts', owner: 'REQUIRED_INPUT_FIELDS' },
  { file: 'src/main/mcp/host.ts', owner: null, text: 'delete-event' },
  { file: 'src/main/mcp/writeClient.ts', owner: 'res', text: 'delete-event' },
];
const KIND_FILES = new Set([
  'src/shared/types.ts',
  'src/shared/schemas.ts',
  'src/shared/ipc.ts',
  'src/main/db/migrations.ts',
  'src/main/exec/manualEvents.ts',
  'src/renderer/src/components/ManualEventDialog.tsx',
  'src/renderer/src/components/ManualEventActions.tsx',
]);

describe('2. delete-event literals in src/ only where the manual path and the refusal list need them', () => {
  it('source walk (TypeScript scanner: comments ignored, template literals and JSX text included)', () => {
    const offenders: string[] = [];
    let blockedListHits = 0;
    for (const file of sourceFiles(join(REPO, 'src'))) {
      const rel = relative(REPO, file).replace(/\\/g, '/');
      for (const hit of deleteLiterals(file)) {
        // the action kind (snake case, a complete literal) lives in the manual contract only
        if (/delete_event/.test(hit.text) && !/delete-event/i.test(hit.text) && KIND_FILES.has(rel)) continue;
        const allowed = ALLOWED.find(
          (a) =>
            a.file === rel &&
            (a.owner === null ? hit.owner === null || a.text === undefined : a.owner === hit.owner) &&
            (a.text === undefined || a.text === hit.text),
        );
        if (allowed === undefined)
          offenders.push(`${rel}:${hit.line} (${hit.owner ?? 'no const'}) ${hit.text.slice(0, 40)}`);
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

describe('4. only a manual WRITE call reaches delete-event', () => {
  it('callerFor(read|admin) reject it with McpCapabilityError; callerFor(write) refuses it without source manual', async () => {
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
    for (const cls of ['read', 'admin'] as McpToolClass[]) {
      await expect(
        (host.callerFor(cls) as unknown as McpToolCaller)('delete-event' as never, {}),
      ).rejects.toBeInstanceOf(McpCapabilityError);
    }
    const writeCaller = host.callerFor('write') as unknown as McpToolCaller;
    for (const opts of [undefined, {}, { source: 'chat' as const }]) {
      await expect(
        writeCaller('delete-event' as never, { calendarId: 'primary', eventId: 'x' }, undefined, opts),
      ).resolves.toEqual({
        ok: false,
        error: 'invalid_args',
      });
    }
    expect(fake.calls).toHaveLength(before);
    expect(audits.filter((a) => a.kind === 'tool_blocked')).toHaveLength(5);
    // The facades: no generic delete; the write facade's only delete is the manual one, which refuses anything but 'manual'.
    const write = createMcpWriteClient(host.callerFor('write'));
    expect(Object.keys(write)).not.toContain('deleteEvent');
    await expect(
      write.deleteManualEvent({ source: 'chat' as never, calendarId: 'primary', eventId: 'abcdefgh01' }),
    ).resolves.toEqual({ ok: false, error: 'invalid_args' });
    expect(fake.calls).toHaveLength(before);
    expect(Object.keys(createMcpReadClient(host.callerFor('read')))).not.toContain('deleteEvent');
    expect(fake.violations).toEqual([]);
    await host.stop();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. the net behind the nets
// ---------------------------------------------------------------------------------------------------------------------

describe('5. were it ever called outside the manual path, the fake and ledger rule 8 catch it', () => {
  it('a raw MCP client calling delete-event records the violation when the name is not registered', async () => {
    const fake = createFakeCalendar({ enabledTools: Object.keys(FAKE_MCP_TOOLS).filter((n) => n !== 'delete-event') });
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
