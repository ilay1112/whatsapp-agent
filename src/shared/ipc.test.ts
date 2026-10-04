// CONTRACTS section 18 item 5: EXTERNAL_TARGETS == keys of resources/links.json ; plus request-schema sanity for the IPC contract.
import { describe, expect, it } from 'vitest';
import links from '../../resources/links.json';
import {
  ApproveReqSchema,
  EXTERNAL_TARGETS,
  FOCUS_GATED_CHANNELS,
  IPC_CHANNELS,
  IPC_EVENTS,
  IPC_REQUEST_SCHEMAS,
  NEVER_ON_MCP_PREFIXES,
  VIEWS,
} from './ipc';

describe('EXTERNAL_TARGETS <-> resources/links.json', () => {
  it('key sets are identical', () => {
    expect(Object.keys(links).sort()).toEqual([...EXTERNAL_TARGETS].sort());
  });
  it('every link is an absolute https URL (a Microsoft page for vcredist, never an exe served by the app)', () => {
    for (const [k, url] of Object.entries(links)) {
      expect(url, k).toMatch(/^https:\/\/[^\s]+$/);
    }
  });
});

describe('IPC contract shape', () => {
  // [V2] C2 8: + 24 invoke channels (20 + item:restoreOriginal, item:cancelEvent, wa:setReadScope, cli:setOverage) and 4 events
  it('76 invoke channels, 11 push events, 4 views', () => {
    expect(IPC_CHANNELS).toHaveLength(76);
    expect(IPC_EVENTS).toHaveLength(11);
    expect(VIEWS).toHaveLength(4);
    expect(new Set(IPC_CHANNELS).size).toBe(IPC_CHANNELS.length);
  });
  it('every channel has a zod request schema', () => {
    for (const c of IPC_CHANNELS) expect(typeof IPC_REQUEST_SCHEMAS[c].safeParse, c).toBe('function');
  });
  it('action:approve rejects edit/kind mismatch and confirm flags on send_reply', () => {
    const base = { actionId: '11111111-1111-4111-8111-111111111111', kind: 'send_reply', shownHash: 'a'.repeat(64) };
    expect(ApproveReqSchema.safeParse(base).success).toBe(true);
    expect(
      ApproveReqSchema.safeParse({
        ...base,
        edit: { title: 'x', startLocal: '2026-09-24T17:00:00', endLocal: '2026-09-24T18:00:00', location: '' },
      }).success,
    ).toBe(false);
    expect(ApproveReqSchema.safeParse({ ...base, confirmConflict: true }).success).toBe(false);
    expect(ApproveReqSchema.safeParse({ ...base, kind: 'create_event', confirmConflict: true }).success).toBe(true);
    expect(ApproveReqSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(ApproveReqSchema.safeParse({ ...base, shownHash: 'A'.repeat(64) }).success).toBe(false);
  });
  it('consent:accept and external:open are strict', () => {
    expect(IPC_REQUEST_SCHEMAS['consent:accept'].safeParse({ kind: 'cloud_claude', version: 1 }).success).toBe(true);
    expect(IPC_REQUEST_SCHEMAS['consent:accept'].safeParse({ kind: 'cloud_claude', version: 0 }).success).toBe(false);
    expect(IPC_REQUEST_SCHEMAS['external:open'].safeParse({ target: 'vcredist_download' }).success).toBe(true);
    expect(IPC_REQUEST_SCHEMAS['external:open'].safeParse({ target: 'https://evil.example' }).success).toBe(false);
    expect(IPC_REQUEST_SCHEMAS['external:open'].safeParse({ itemId: 3, target: 'calendarEvent' }).success).toBe(true);
    expect(
      IPC_REQUEST_SCHEMAS['secrets:set'].safeParse({ name: 'anthropic_api_key', value: 'sk-ant-TESTONLY-abc123' })
        .success,
    ).toBe(true);
    expect(
      IPC_REQUEST_SCHEMAS['secrets:set'].safeParse({ name: 'anthropic_api_key', value: 'has space' }).success,
    ).toBe(false);
  });
});

// =====================================================================================================================
// [V2] C2 19 items 24 and 25 (V2-W0-scaffold); register.ts applying the gate is V2-W1-10's test
// =====================================================================================================================
/** Every property name a zod v4 request schema accepts (objects, unions, optionals, arrays, refinements). */
function keysOf(schema: unknown, out = new Set<string>()): Set<string> {
  const def = (schema as { def?: Record<string, unknown> } | undefined)?.def;
  if (!def) return out;
  if (def.type === 'object') {
    for (const [k, v] of Object.entries(def.shape as Record<string, unknown>)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  for (const key of ['innerType', 'in', 'out', 'element', 'schema'] as const) if (def[key]) keysOf(def[key], out);
  if (Array.isArray(def.options)) for (const o of def.options) keysOf(o, out);
  return out;
}

describe('C2 19 item 24 - FOCUS_GATED_CHANNELS', () => {
  it('is a subset of IPC_CHANNELS and never contains the fail-safe auto:disable / auto:pause', () => {
    for (const c of FOCUS_GATED_CHANNELS) expect(IPC_CHANNELS).toContain(c);
    expect(FOCUS_GATED_CHANNELS).not.toContain('auto:disable');
    expect(FOCUS_GATED_CHANNELS).not.toContain('auto:pause');
    expect(FOCUS_GATED_CHANNELS).toContain('action:approve');
  });
  it('NEVER_ON_MCP_PREFIXES covers every automatic-mode and approval channel', () => {
    for (const c of IPC_CHANNELS.filter(
      (x) => x.startsWith('auto:') || x.startsWith('action:') || x === 'item:undoChange',
    ))
      expect(
        NEVER_ON_MCP_PREFIXES.some((p) => c.startsWith(p)),
        c,
      ).toBe(true);
  });
});

describe('C2 19 item 25 - no request schema carries an identifier or a path', () => {
  const BANNED = ['jid', 'chatJid', 'path', 'url', 'token', 'eventId', 'targetEventId', 'tool', 'toolName', 'exePath'];
  it('the walker sees nested keys', () => {
    expect(keysOf(IPC_REQUEST_SCHEMAS['auto:requestEnable'])).toContain('horizonDays');
    expect(keysOf(IPC_REQUEST_SCHEMAS['settings:set'])).toContain('windowDays');
  });
  it.each(IPC_CHANNELS.map((c) => [c] as const))('%s', (channel) => {
    const keys = keysOf(IPC_REQUEST_SCHEMAS[channel]);
    for (const b of BANNED) expect(keys.has(b), `${channel}.${b}`).toBe(false);
  });
});
