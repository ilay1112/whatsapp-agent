// tests/e2e/helpers/edit.ts - the event-editing world of the L5 specs (T2 10 `edit-change.spec.ts`, `undo.spec.ts`; owner V2-W2-03).
//
// An "existing event" is never seeded into the fake calendar here: the app creates it itself through a real click ("Add to
// calendar"), so the event carries the app's own identity tags and its first revision, exactly as a user's event would. The
// contact's next message then refers to it ("can we do 5 instead of 3?"), and the scripted model answers with a B20 delta.
import type { ElectronApplication, Page } from '@playwright/test';
import { attachBridge, dialogScript, mcpChild, type AttachedBridge, type McpChild } from './fakes.ts';
import { expect, wca, type E2eContext } from './fixtures.ts';
import { seedGoogleCredentials, seedProfile } from './seedProfile.ts';
import {
  actionsOfItem,
  anchorDate,
  AppClock,
  cardOfChat,
  E2E_NOW_MS,
  extraction,
  FAST_TIMERS_ENV,
  jid,
  query,
} from './v2.ts';

export interface EditWorld {
  e2e: E2eContext;
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  bridge: AttachedBridge;
  mcp: McpChild;
  clock: AppClock;
}

/** Wednesday of the anchor week (the anchor is a Monday). */
export const WED = anchorDate(2);

/** One scripted turn: a message containing `token` gets this extraction and this draft. */
export interface ScriptedTurn {
  token: string;
  extract: Record<string, unknown>;
  draft?: string;
}

/** A create for `<WED> hh:00`, 60 minutes. */
export function createTurn(token: string, hour: number, title = 'Meeting'): ScriptedTurn {
  return {
    token,
    extract: extraction({
      intent: 'schedule_request',
      title,
      dateKind: 'weekday',
      weekday: 3,
      time24h: `${String(hour).padStart(2, '0')}:00`,
      durationMin: 60,
      confidence: 'high',
    }),
    draft: 'Wednesday works for me.',
  };
}

/** A B20 delta on the chat's event: reschedule to `hour`:00 (same day), cancel, or move. */
export function changeTurn(
  token: string,
  change: 'reschedule' | 'cancel',
  hour?: number,
  title = 'Meeting',
): ScriptedTurn {
  return {
    token,
    extract: extraction({
      intent: change === 'cancel' ? 'cancel' : 'reschedule',
      title,
      dateKind: 'none',
      time24h: hour === undefined ? '' : `${String(hour).padStart(2, '0')}:00`,
      timeAmbiguous: false,
      durationMin: 0,
      refersToExisting: true,
      change,
      changeConfidence: 'high',
      confidence: 'high',
    }),
    draft: change === 'cancel' ? 'No problem, cancelled.' : 'Sure, that works.',
  };
}

/**
 * WCA_LLM_SCRIPT rules. The model sees the whole chat window, so the NEWEST turn's token must win: rules are emitted newest first
 * (the later a turn is in `turns`, the earlier its rule).
 */
export function editStubRules(turns: ScriptedTurn[]): unknown[] {
  const reversed = [...turns].reverse();
  return [
    ...reversed.map((t) => ({ when: { purpose: 'extract', contains: t.token }, respond: { structured: t.extract } })),
    {
      when: { purpose: 'extract' },
      respond: {
        structured: extraction({ intent: 'other', needsReply: false, title: '', durationMin: 0, confidence: 'low' }),
      },
    },
    ...reversed.map((t) => ({
      when: { purpose: 'draft', contains: t.token },
      respond: { text: t.draft ?? 'OK.', stopReason: 'end' },
    })),
    { when: { purpose: 'draft' }, respond: { text: 'OK.', stopReason: 'end' } },
  ];
}

export async function launchEditWorld(
  e2e: E2eContext,
  label: string,
  opts: {
    turns: ScriptedTurn[];
    chats: number[];
    language?: 'en' | 'he';
    v2Scenarios?: string[];
    dialog?: Parameters<typeof dialogScript>[0];
  },
): Promise<EditWorld> {
  const userDataDir = e2e.newProfileDir(label);
  const clock = new AppClock();
  seedProfile({
    userDataDir,
    onboardingStep: 'done',
    now: (E2E_NOW_MS - 2 * 3_600_000) as never,
    settings: {
      provider: 'local',
      targetCalendarId: 'primary',
      timeZone: 'Asia/Jerusalem',
      language: opts.language ?? 'en',
    },
    chats: opts.chats.map((n) => ({ jid: jid(n), name: `Contact ${String(n)}` })),
    // The profile signed in through the Google wizard once, whose list-calendars recorded the roles (B7, googleAuth.persistRoles).
    meta: { calendar_roles_json: JSON.stringify({ primary: 'owner' }) },
  });
  seedGoogleCredentials(userDataDir);
  const bridge = await attachBridge(e2e, userDataDir);
  const mcp = mcpChild(
    e2e,
    label,
    opts.v2Scenarios === undefined ? undefined : { v2Scenarios: opts.v2Scenarios },
    userDataDir,
  );
  const scriptFile = e2e.writeTempFile(`${label}-stub.json`, JSON.stringify({ rules: editStubRules(opts.turns) }));
  clock.markLaunch();
  const launched = await e2e.launch({
    userDataDir,
    env: {
      ...bridge.env,
      ...mcp.env,
      ...clock.env(),
      ...(opts.dialog === undefined ? {} : dialogScript(opts.dialog)),
      WCA_TIMERS: FAST_TIMERS_ENV,
      WCA_LLM: 'stub',
      WCA_LLM_SCRIPT: scriptFile,
      WCA_FOCUS_CHECK: 'visible-only',
    },
  });
  const page = launched.page;
  if (page === null) throw new Error('no window');
  e2e.sentinels.push(bridge.token);
  for (const n of opts.chats) e2e.sentinels.push(jid(n));
  await expect
    .poll(async () => (await wca(launched.app).health()).llm.state, { timeout: 20_000 })
    .toMatch(/^(ready|idle)$/);
  await expect
    .poll(async () => (await wca(launched.app).health()).calendar.state, { timeout: 30_000 })
    .toBe('connected');
  return { e2e, app: launched.app, page, userDataDir, bridge, mcp, clock };
}

export async function say(w: EditWorld, n: number, text: string): Promise<void> {
  w.e2e.sentinels.push(text);
  await w.bridge.deliver(w.app, { chatJid: jid(n), text, ts: w.clock.date(), pushName: `Contact ${String(n)}` });
}

/**
 * The existing event: the contact asks, the user clicks "Add to calendar" and "Send" (so the item is fully handled and the next
 * message of the chat is a new item that refers to the event). Returns the source item id and the calendar event id.
 */
export async function createEventByClick(
  w: EditWorld,
  n: number,
  text: string,
): Promise<{ itemId: number; eventId: string }> {
  await say(w, n, text);
  const itemId = await cardOfChat(w.page, w.userDataDir, jid(n));
  const before = w.mcp.calls('create-event').length;
  await expect(w.page.getByTestId(`approve-event-${itemId}`)).toBeVisible({ timeout: 30_000 });
  await w.page.getByTestId(`approve-event-${itemId}`).click();
  await expect.poll(() => w.mcp.calls('create-event').length, { timeout: 30_000 }).toBe(before + 1);
  await expect
    .poll(() => actionsOfItem(w.userDataDir, itemId).find((a) => a.kind === 'create_event')?.state, { timeout: 30_000 })
    .toBe('done');
  const sends = w.bridge.fake.sent.length;
  const send = w.page.getByTestId(`approve-send-${itemId}`);
  if ((await send.count()) > 0 && (await send.isEnabled())) {
    await send.click();
    await expect.poll(() => w.bridge.fake.sent.length, { timeout: 30_000 }).toBe(sends + 1);
  }
  const eventId = query<{ calendar_event_id: string | null }>(
    w.userDataDir,
    'SELECT calendar_event_id FROM items WHERE id = ?',
    itemId,
  )[0]?.calendar_event_id;
  if (typeof eventId !== 'string') throw new Error('the created item carries no calendar event id');
  return { itemId, eventId };
}

/** The newest item of the chat that is a delta (linked to a source item). */
export function deltaItemOf(w: EditWorld, n: number): number | null {
  const rows = query<{ id: number }>(
    w.userDataDir,
    `SELECT i.id AS id FROM items i JOIN chats c ON c.id = i.chat_id
      WHERE c.jid = ? AND i.linked_item_id IS NOT NULL ORDER BY i.id DESC LIMIT 1`,
    jid(n),
  );
  return rows[0]?.id ?? null;
}

export async function deltaCard(w: EditWorld, n: number, timeoutMs = 60_000): Promise<number> {
  let id: number | null = null;
  await expect
    .poll(
      async () => {
        id = deltaItemOf(w, n);
        return id === null ? false : (await w.page.getByTestId(`change-line-${id}`).count()) > 0;
      },
      { timeout: timeoutMs, message: 'the Change card appears' },
    )
    .toBe(true);
  return id!;
}

export function updateCalls(w: EditWorld): Array<{ at: number; tool: string; args: Record<string, unknown> }> {
  return w.mcp.calls('update-event');
}
