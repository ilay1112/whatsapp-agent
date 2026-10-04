// src/main/mcp/adminClient.ts   (GoogleAuthService / wizard / settings ONLY; never agent/**, llm/**)
// Frozen signatures pasted verbatim from docs/specs/contracts.md (owner W1-05); bodies implemented by W1-05.
import { sanitiseTitle } from './projection';
import { CALENDAR_ACCESS_ROLES, type CalendarAccessRole, type CalendarInfo } from '../../shared/types';
import type { McpResult, McpToolCaller } from './readClient';

export interface AccountInfo {
  accountId: 'personal';
  status: 'active' | 'expired' | 'error';
  email: string | null;
}
export type ManageAccountsResult =
  | { action: 'list'; accounts: AccountInfo[] }
  | { action: 'add'; authUrl: string; expiresInMinutes: number } // caller opens authUrl only if host === accounts.google.com
  | { action: 'remove' };
export interface McpAdminClient {
  manageAccounts(action: 'list' | 'add' | 'remove'): Promise<McpResult<ManageAccountsResult>>; // account_id is pinned to 'personal' inside
  listCalendars(): Promise<McpResult<CalendarInfo[]>>;
}

// ---------------------------------------------------------------------------------------------------------------------
// implementation (W1-05)
// ---------------------------------------------------------------------------------------------------------------------

/** v1 uses exactly one account; the id is pinned here and never comes from settings, the renderer or a model. */
export const ACCOUNT_ID = 'personal';
/** CalendarInfo.name is UNTRUSTED (other people can share a calendar with a hostile name). */
export const CALENDAR_NAME_MAX = 60;
const TIME_ZONE_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;
const WRITABLE_ROLES = new Set<CalendarAccessRole>(['owner', 'writer']);
const BAD = { ok: false, error: 'bad_response' } as const;
/** Google calendarList roles the app knows; 'unknown' is the fail-closed bucket, never a value the server can send us into. */
const KNOWN_ROLES: readonly CalendarAccessRole[] = CALENDAR_ACCESS_ROLES.filter((r) => r !== 'unknown');

/** [V2] C2 11: the server's per-calendar `accessRole` -> CalendarAccessRole; anything else or absent => 'unknown' (NOT owned, B7). */
export function accessRoleOf(raw: unknown): CalendarAccessRole {
  return typeof raw === 'string' && (KNOWN_ROLES as readonly string[]).includes(raw)
    ? (raw as CalendarAccessRole)
    : 'unknown';
}

/** [V2] B7: `{[calendarId]: accessRole}` of one list-calendars answer - the value persisted to meta.calendar_roles_json. */
export function calendarRolesOf(calendars: readonly CalendarInfo[]): Record<string, CalendarAccessRole> {
  const roles: Record<string, CalendarAccessRole> = Object.create(null) as Record<string, CalendarAccessRole>;
  for (const c of calendars) roles[c.id] = c.accessRole;
  return { ...roles };
}

/**
 * [V2] B7: meta.calendar_roles_json -> roles. Absent, unparsable or odd values never grant anything: a calendar that is missing or
 * whose role is not one of CALENDAR_ACCESS_ROLES reads as absent (= not owned). compose.ts wires this into AutoPolicyService.calendarRoles.
 */
export function parseCalendarRolesJson(text: string | null): Readonly<Record<string, CalendarAccessRole>> {
  if (typeof text !== 'string' || text.length === 0 || text.length > 64 * 1024) return {};
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isObject(root)) return {};
  const out: Record<string, CalendarAccessRole> = {};
  for (const [id, role] of Object.entries(root)) {
    if (id.length === 0 || id.length > 256 || id === '__proto__') continue;
    const r = accessRoleOf(role);
    if (r !== 'unknown') out[id] = r;
  }
  return out;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (o: Json, k: string): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null);

function parse(text: string): Json | unknown[] | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 256 * 1024) return null;
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) || isObject(v) ? (v as Json | unknown[]) : null;
  } catch {
    return null;
  }
}
function listOf(root: Json | unknown[], key: string): unknown[] | null {
  if (Array.isArray(root)) return root;
  return Array.isArray(root[key]) ? (root[key] as unknown[]) : null;
}

/** manage-accounts `list` text -> the 'personal' account only (any other id the server knows is ignored, not surfaced). */
export function projectAccounts(text: string): McpResult<AccountInfo[]> {
  const root = parse(text);
  if (root === null) return BAD;
  const items = listOf(root, 'accounts');
  if (items === null) return BAD;
  const out: AccountInfo[] = [];
  for (const raw of items) {
    if (!isObject(raw)) return BAD;
    const id = str(raw, 'account_id') ?? str(raw, 'accountId');
    if (id !== ACCOUNT_ID) continue;
    const status = str(raw, 'status');
    if (status !== 'active' && status !== 'expired' && status !== 'error') return BAD;
    const email = str(raw, 'email');
    out.push({ accountId: ACCOUNT_ID, status, email: email !== null && email.length <= 320 ? email : null });
  }
  return { ok: true, value: out };
}

/** manage-accounts `add` text -> the auth URL. The URL's HOST is checked by GoogleAuthService before anything opens it. */
export function projectAddAccount(text: string): McpResult<{ authUrl: string; expiresInMinutes: number }> {
  const root = parse(text);
  if (root === null || Array.isArray(root)) return BAD;
  const authUrl = str(root, 'auth_url') ?? str(root, 'authUrl');
  if (authUrl === null || authUrl.length === 0 || authUrl.length > 2048) return BAD;
  const raw = root.expires_in_minutes ?? root.expiresInMinutes;
  const expiresInMinutes =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && raw <= 60 ? Math.trunc(raw) : 5;
  return { ok: true, value: { authUrl, expiresInMinutes } };
}

/** list-calendars text -> CalendarInfo[]; names are sanitised and capped, everything else is dropped. */
export function projectCalendars(text: string): McpResult<CalendarInfo[]> {
  const root = parse(text);
  if (root === null) return BAD;
  const items = listOf(root, 'calendars') ?? listOf(root, 'items');
  if (items === null || items.length > 200) return BAD;
  const out: CalendarInfo[] = [];
  for (const raw of items) {
    if (!isObject(raw)) return BAD;
    const id = str(raw, 'id');
    if (id === null || id.length === 0 || id.length > 256) return BAD;
    const zone = str(raw, 'timeZone');
    const accessRole = accessRoleOf(raw.accessRole);
    out.push({
      id,
      name: sanitiseTitle(str(raw, 'summary') ?? str(raw, 'name') ?? '').slice(0, CALENDAR_NAME_MAX),
      primary: raw.primary === true || id === 'primary',
      timeZone: zone !== null && TIME_ZONE_RE.test(zone) ? zone : '',
      // [V2] C2 11: `writable` keeps its v1 meaning (owner or writer) but a MISSING role no longer collapses to writable.
      writable: WRITABLE_ROLES.has(accessRole),
      accessRole,
    });
  }
  return { ok: true, value: out };
}

/** ADMIN facade. Used by the setup wizard and the settings screen only; never by agent/**, llm/** or exec/**. */
export function createMcpAdminClient(call: McpToolCaller<'admin'>): McpAdminClient {
  return {
    async manageAccounts(action) {
      if (action !== 'list' && action !== 'add' && action !== 'remove') return { ok: false, error: 'invalid_args' };
      const res = await call('manage-accounts', { action, account_id: ACCOUNT_ID });
      if (!res.ok) return res;
      if (res.value.isError) return { ok: false, error: 'bad_response' };
      if (action === 'remove') return { ok: true, value: { action: 'remove' } };
      if (action === 'add') {
        const added = projectAddAccount(res.value.text);
        return added.ok ? { ok: true, value: { action: 'add', ...added.value } } : added;
      }
      const accounts = projectAccounts(res.value.text);
      return accounts.ok ? { ok: true, value: { action: 'list', accounts: accounts.value } } : accounts;
    },

    async listCalendars() {
      const res = await call('list-calendars', { account: ACCOUNT_ID });
      if (!res.ok) return res;
      if (res.value.isError) return { ok: false, error: 'bad_response' };
      return projectCalendars(res.value.text);
    },
  };
}
