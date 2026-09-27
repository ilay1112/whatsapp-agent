// src/main/mcp/adminClient.test.ts - the ADMIN facade (wizard / settings only) and its projections (owner W1-05).
// TESTS 5.3 row mcp/*: account_id is pinned to 'personal' inside; untrusted calendar names are sanitised and capped.
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  ACCOUNT_ID,
  CALENDAR_NAME_MAX,
  createMcpAdminClient,
  projectAccounts,
  projectAddAccount,
  projectCalendars,
} from './adminClient';
import type { McpResult, McpToolCaller } from './readClient';

type Call = { tool: string; args: Record<string, unknown> };
const BAD = { ok: false, error: 'bad_response' } as const;

function caller(...replies: Array<McpResult<{ text: string; isError: boolean }>>): {
  call: McpToolCaller<'admin'>;
  calls: Call[];
} {
  const calls: Call[] = [];
  const queue = [...replies];
  return {
    calls,
    call: async (tool, args) => {
      calls.push({ tool, args });
      return queue.shift() ?? { ok: false, error: 'unavailable' };
    },
  };
}
const okText = (text: string): McpResult<{ text: string; isError: boolean }> => ({
  ok: true,
  value: { text, isError: false },
});
const errText = (text: string): McpResult<{ text: string; isError: boolean }> => ({
  ok: true,
  value: { text, isError: true },
});

describe('projectAccounts', () => {
  it('keeps only the pinned personal account', () => {
    const text = JSON.stringify({
      accounts: [
        { account_id: 'work', status: 'active', email: 'work@example.test' },
        { account_id: 'personal', status: 'active', email: 'user@example.test', calendar_count: 3 },
      ],
    });
    expect(projectAccounts(text)).toEqual({
      ok: true,
      value: [{ accountId: 'personal', status: 'active', email: 'user@example.test' }],
    });
  });

  it('accepts the accountId alias, a bare array and a missing e-mail', () => {
    expect(projectAccounts(JSON.stringify([{ accountId: 'personal', status: 'expired' }]))).toEqual({
      ok: true,
      value: [{ accountId: 'personal', status: 'expired', email: null }],
    });
  });

  it('drops an over-long e-mail rather than storing it', () => {
    const email = `${'x'.repeat(400)}@example.test`;
    expect(projectAccounts(JSON.stringify([{ account_id: 'personal', status: 'error', email }]))).toEqual({
      ok: true,
      value: [{ accountId: 'personal', status: 'error', email: null }],
    });
  });

  it('fails closed on garbage, a non-list and an unknown status', () => {
    expect(projectAccounts('<html/>')).toEqual(BAD);
    expect(projectAccounts('')).toEqual(BAD);
    expect(projectAccounts('x'.repeat(256 * 1024 + 1))).toEqual(BAD);
    expect(projectAccounts('7')).toEqual(BAD);
    expect(projectAccounts(JSON.stringify({ nothing: 1 }))).toEqual(BAD);
    expect(projectAccounts(JSON.stringify({ accounts: ['nope'] }))).toEqual(BAD);
    expect(projectAccounts(JSON.stringify({ accounts: [{ account_id: 'personal', status: 'pwned' }] }))).toEqual(BAD);
  });
});

describe('projectAddAccount', () => {
  it('returns the auth url and a sane expiry', () => {
    const text = JSON.stringify({
      status: 'awaiting_authentication',
      auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
      expires_in_minutes: 5,
    });
    expect(projectAddAccount(text)).toEqual({
      ok: true,
      value: { authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', expiresInMinutes: 5 },
    });
  });

  it('accepts the camelCase aliases and defaults a missing or absurd expiry to 5 minutes', () => {
    expect(projectAddAccount(JSON.stringify({ authUrl: 'https://accounts.google.com/x' }))).toEqual({
      ok: true,
      value: { authUrl: 'https://accounts.google.com/x', expiresInMinutes: 5 },
    });
    expect(
      projectAddAccount(JSON.stringify({ authUrl: 'https://accounts.google.com/x', expiresInMinutes: 99_999 })),
    ).toMatchObject({
      ok: true,
      value: { expiresInMinutes: 5 },
    });
    expect(
      projectAddAccount(JSON.stringify({ authUrl: 'https://accounts.google.com/x', expiresInMinutes: 0 })),
    ).toMatchObject({
      ok: true,
      value: { expiresInMinutes: 5 },
    });
  });

  it('does NOT judge the host here - that is GoogleAuthService, but the value must still be a plausible url string', () => {
    expect(projectAddAccount(JSON.stringify({ auth_url: 'https://evil.example/x' }))).toMatchObject({ ok: true });
    expect(projectAddAccount(JSON.stringify({ auth_url: '' }))).toEqual(BAD);
    expect(projectAddAccount(JSON.stringify({ auth_url: `https://accounts.google.com/${'x'.repeat(2100)}` }))).toEqual(
      BAD,
    );
    expect(projectAddAccount(JSON.stringify([{ auth_url: 'https://accounts.google.com/x' }]))).toEqual(BAD);
    expect(projectAddAccount('<html/>')).toEqual(BAD);
  });
});

describe('projectCalendars', () => {
  it('sanitises and caps untrusted calendar names and keeps only the five app fields', () => {
    const text = JSON.stringify({
      calendars: [
        {
          id: 'primary',
          summary: `  Personal‮ ${'x'.repeat(200)}`,
          primary: true,
          timeZone: 'Asia/Jerusalem',
          accessRole: 'owner',
          description: 'secret',
        },
        { id: 'shared@example.test', name: 'Shared', timeZone: 'Bad Zone!', accessRole: 'reader' },
      ],
    });
    const res = projectCalendars(text);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value[0]?.name.length).toBeLessThanOrEqual(CALENDAR_NAME_MAX);
    expect(res.value[0]?.name).not.toContain('‮');
    expect(res.value[0]).toMatchObject({ id: 'primary', primary: true, timeZone: 'Asia/Jerusalem', writable: true });
    expect(res.value[1]).toEqual({
      id: 'shared@example.test',
      name: 'Shared',
      primary: false,
      timeZone: '',
      writable: false,
    });
    expect(Object.keys(res.value[0] ?? {}).sort()).toEqual(['id', 'name', 'primary', 'timeZone', 'writable']);
    expect(JSON.stringify(res)).not.toContain('secret');
  });

  it('treats the id "primary" as primary and a missing accessRole as writable', () => {
    const res = projectCalendars(JSON.stringify({ items: [{ id: 'primary', summary: 'P' }] }));
    expect(res).toEqual({
      ok: true,
      value: [{ id: 'primary', name: 'P', primary: true, timeZone: '', writable: true }],
    });
  });

  it('fails closed on garbage, a non-list, an oversized list and a bad id', () => {
    expect(projectCalendars('<html/>')).toEqual(BAD);
    expect(projectCalendars(JSON.stringify({ nothing: 1 }))).toEqual(BAD);
    expect(projectCalendars(JSON.stringify({ calendars: ['nope'] }))).toEqual(BAD);
    expect(projectCalendars(JSON.stringify({ calendars: [{ summary: 'no id' }] }))).toEqual(BAD);
    expect(projectCalendars(JSON.stringify({ calendars: [{ id: 'x'.repeat(300) }] }))).toEqual(BAD);
    expect(
      projectCalendars(JSON.stringify({ calendars: Array.from({ length: 201 }, () => ({ id: 'primary' })) })),
    ).toEqual(BAD);
  });
});

describe('createMcpAdminClient', () => {
  it('exposes only the two admin methods and is typed for an ADMIN caller', () => {
    const client = createMcpAdminClient(caller().call);
    expect(Object.keys(client).sort()).toEqual(['listCalendars', 'manageAccounts']);
    expect(client).not.toHaveProperty('createEvent');
    expectTypeOf(createMcpAdminClient).parameter(0).toEqualTypeOf<McpToolCaller<'admin'>>();
    // @ts-expect-error a READ-narrowed caller may not construct the admin facade
    expectTypeOf(createMcpAdminClient).toBeCallableWith({} as McpToolCaller<'read'>);
  });

  it('pins account_id to personal on every manage-accounts action', async () => {
    const { call, calls } = caller(
      okText(JSON.stringify({ accounts: [] })),
      okText(JSON.stringify({ auth_url: 'https://accounts.google.com/x' })),
      okText(JSON.stringify({ removed: true })),
    );
    const client = createMcpAdminClient(call);
    await client.manageAccounts('list');
    await client.manageAccounts('add');
    await client.manageAccounts('remove');
    expect(calls.map((c) => c.args)).toEqual([
      { action: 'list', account_id: ACCOUNT_ID },
      { action: 'add', account_id: ACCOUNT_ID },
      { action: 'remove', account_id: ACCOUNT_ID },
    ]);
    expect(new Set(calls.map((c) => c.tool))).toEqual(new Set(['manage-accounts']));
  });

  it('returns the discriminated results', async () => {
    const list = createMcpAdminClient(
      caller(
        okText(JSON.stringify({ accounts: [{ account_id: 'personal', status: 'active', email: 'u@example.test' }] })),
      ).call,
    );
    await expect(list.manageAccounts('list')).resolves.toEqual({
      ok: true,
      value: { action: 'list', accounts: [{ accountId: 'personal', status: 'active', email: 'u@example.test' }] },
    });

    const add = createMcpAdminClient(
      caller(okText(JSON.stringify({ auth_url: 'https://accounts.google.com/x', expires_in_minutes: 5 }))).call,
    );
    await expect(add.manageAccounts('add')).resolves.toEqual({
      ok: true,
      value: { action: 'add', authUrl: 'https://accounts.google.com/x', expiresInMinutes: 5 },
    });

    const remove = createMcpAdminClient(caller(okText('{}')).call);
    await expect(remove.manageAccounts('remove')).resolves.toEqual({ ok: true, value: { action: 'remove' } });
  });

  it('refuses an action outside the three without calling the tool', async () => {
    const call = vi.fn<McpToolCaller<'admin'>>(async () => okText('{}'));
    await expect(createMcpAdminClient(call).manageAccounts('wipe' as 'list')).resolves.toEqual({
      ok: false,
      error: 'invalid_args',
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('maps an isError result, a bad projection and a transport failure for manage-accounts', async () => {
    await expect(
      createMcpAdminClient(caller(errText('No authenticated accounts found.')).call).manageAccounts('list'),
    ).resolves.toEqual(BAD);
    await expect(createMcpAdminClient(caller(okText('<html/>')).call).manageAccounts('list')).resolves.toEqual(BAD);
    await expect(createMcpAdminClient(caller(okText('<html/>')).call).manageAccounts('add')).resolves.toEqual(BAD);
    const down: McpToolCaller<'admin'> = async () => ({ ok: false, error: 'auth' });
    await expect(createMcpAdminClient(down).manageAccounts('list')).resolves.toEqual({ ok: false, error: 'auth' });
  });

  it('listCalendars pins the account and projects the list', async () => {
    const { call, calls } = caller(
      okText(JSON.stringify({ calendars: [{ id: 'primary', summary: 'P', primary: true }] })),
    );
    await expect(createMcpAdminClient(call).listCalendars()).resolves.toEqual({
      ok: true,
      value: [{ id: 'primary', name: 'P', primary: true, timeZone: '', writable: true }],
    });
    expect(calls[0]).toEqual({ tool: 'list-calendars', args: { account: ACCOUNT_ID } });
  });

  it('listCalendars maps an isError result and a transport failure', async () => {
    await expect(createMcpAdminClient(caller(errText('boom')).call).listCalendars()).resolves.toEqual(BAD);
    const down: McpToolCaller<'admin'> = async () => ({ ok: false, error: 'port_busy' });
    await expect(createMcpAdminClient(down).listCalendars()).resolves.toEqual({ ok: false, error: 'port_busy' });
  });
});
