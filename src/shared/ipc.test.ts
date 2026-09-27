// CONTRACTS section 18 item 5: EXTERNAL_TARGETS == keys of resources/links.json ; plus request-schema sanity for the IPC contract.
import { describe, expect, it } from 'vitest';
import links from '../../resources/links.json';
import { ApproveReqSchema, EXTERNAL_TARGETS, IPC_CHANNELS, IPC_EVENTS, IPC_REQUEST_SCHEMAS, VIEWS } from './ipc';

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
  it('52 invoke channels, 7 push events, 4 views', () => {
    expect(IPC_CHANNELS).toHaveLength(52);
    expect(IPC_EVENTS).toHaveLength(7);
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
