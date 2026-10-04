// tests/e2e/helpers/v2.ts - shared pieces of the six v2 L5 specs (T2 10; owner V2-W2-03).
//
// - a pinned app clock (`WCA_NOW`, TESTS 4.2: based at a fixed instant, advancing in real time) so "Thursday at 14:00" resolves the
//   same on any day and no spec ever runs inside the automatic-mode quiet hours because the suite happened to run at night;
// - the strict v2 extraction builder for scripted models (every field of `ExtractionSchema`, B20 fields included);
// - read-only views of the profile's app.db (the ledger reads the same file; nothing here writes it);
// - small UI steps every v2 spec repeats (open Settings, back to the dashboard, find the card of a chat).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import { expect } from './fixtures.ts';

/**
 * The app clock anchor: a MONDAY at 07:00Z (09:00 or 10:00 in Asia/Jerusalem - well outside the automatic-mode quiet hours), at
 * least a week AFTER the real date. It must lie in the future: the RENDERER validates an event against its own real clock (a card
 * whose start is in the past cannot be approved), and only the main process sees WCA_NOW. Every spec run is therefore "a Monday".
 */
function nextMondayAnchor(realNow: number): number {
  const d = new Date(realNow + 7 * 86_400_000);
  d.setUTCHours(7, 0, 0, 0);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}
export const E2E_NOW_MS = nextMondayAnchor(Date.now());
export const E2E_NOW_ISO = new Date(E2E_NOW_MS).toISOString();
/** YYYY-MM-DD of the anchor + n days (the UTC date equals the Jerusalem date at 07:00Z). */
export function anchorDate(plusDays: number): string {
  return new Date(E2E_NOW_MS + plusDays * 86_400_000).toISOString().slice(0, 10);
}

/** Fast enough for a test, slow enough to stay a real timer: only DELAYS may be shortened (TESTS 4.2, T2 4.1). */
export const FAST_TIMERS = {
  scanMs: 500,
  debounceMs: 100,
  debounceCapMs: 500,
  healthPollMs: 500,
  cliStatusCacheMs: 1_000,
  authStatusMinIntervalMs: 1_000,
  mediaRetryMs: 500,
  jobGraceMs: { cli: 500, voice: 1_000 },
};
export const FAST_TIMERS_ENV = JSON.stringify(FAST_TIMERS);

/**
 * The app's clock as the spec sees it. `index.ts` bases its clock at `WCA_NOW` when its module loads and advances it in real time,
 * so the spec's estimate (based at the moment it asked for the launch) runs a little AHEAD of the app; `now()` subtracts a margin so
 * a timestamp the spec writes into `messages.db` is never in the app's future.
 */
export class AppClock {
  private startedRealMs = Date.now();
  constructor(readonly baseMs: number = E2E_NOW_MS) {}
  /** Call right before `e2e.launch()` of the run whose clock this is. */
  markLaunch(): void {
    this.startedRealMs = Date.now();
  }
  now(): number {
    return this.baseMs + (Date.now() - this.startedRealMs) - 2_000;
  }
  date(offsetMs = 0): Date {
    return new Date(this.now() + offsetMs);
  }
  env(): Record<string, string> {
    return { WCA_NOW: new Date(this.baseMs).toISOString() };
  }
}

/** A complete, schema-valid v2 extraction (strict `ExtractionSchema`): the defaults are a confident, clean create. */
export function extraction(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: 'schedule_request',
    needsReply: true,
    title: 'Meeting',
    dateKind: 'none',
    isoDate: '',
    weekday: 0,
    weekOffset: 0,
    daysFromToday: 0,
    time24h: '',
    timeAmbiguous: false,
    durationMin: 60,
    location: '',
    missing: [],
    suspicious: false,
    refersToExisting: false,
    change: 'no_change',
    changeConfidence: 'low',
    confidence: 'high',
    ...over,
  };
}

/** Synthetic chat JIDs only (TESTS rule T5): 9725500000NN@s.whatsapp.net. */
export function jid(n: number): string {
  return `9725500000${String(n).padStart(2, '0')}@s.whatsapp.net`;
}

// ---------------------------------------------------------------------------------------------------------------------
// read-only app.db views
// ---------------------------------------------------------------------------------------------------------------------

export function query<T>(userDataDir: string, sql: string, ...params: Array<string | number | null>): T[] {
  const file = join(userDataDir, 'app.db');
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as unknown as T[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function itemsOfChat(
  userDataDir: string,
  chatJid: string,
): Array<{ id: number; state: string; analysis: string; event_state: string; trigger_kind: string }> {
  return query(
    userDataDir,
    `SELECT i.id AS id, i.state AS state, i.analysis AS analysis, i.event_state AS event_state, i.trigger_kind AS trigger_kind
       FROM items i JOIN chats c ON c.id = i.chat_id WHERE c.jid = ? ORDER BY i.id`,
    chatJid,
  );
}

export function lastItemOfChat(userDataDir: string, chatJid: string): number | null {
  const rows = itemsOfChat(userDataDir, chatJid);
  return rows.length === 0 ? null : rows[rows.length - 1]!.id;
}

export function actionsOfItem(
  userDataDir: string,
  itemId: number,
): Array<{ id: string; kind: string; state: string; approved_by: string | null }> {
  return query(
    userDataDir,
    `SELECT id, kind, state, approved_by FROM actions WHERE item_id = ? ORDER BY created_at`,
    itemId,
  );
}

export function autoDecisions(
  userDataDir: string,
): Array<{ id: string; action_id: string; verdict: string; reason: string }> {
  return query(userDataDir, `SELECT id, action_id, verdict, reason FROM auto_decisions ORDER BY decided_at`);
}

export function autoPolicies(userDataDir: string): Array<{ id: string; state: string; paused_reason: string | null }> {
  return query(userDataDir, `SELECT id, state, paused_reason FROM auto_policies ORDER BY enabled_at`);
}

export function consentKinds(userDataDir: string): string[] {
  return query<{ kind: string }>(userDataDir, `SELECT kind FROM consents`).map((r) => r.kind);
}

// ---------------------------------------------------------------------------------------------------------------------
// UI steps
// ---------------------------------------------------------------------------------------------------------------------

/** Opens Settings through the header gear (the only in-window door) and waits for the page. */
export async function openSettings(page: Page): Promise<void> {
  if ((await page.getByTestId('app').getAttribute('data-view')) !== 'settings') {
    await page.getByTestId('settings-toggle').click();
  }
  await expect(page.getByTestId('settings')).toBeVisible({ timeout: 10_000 });
}

export async function backToDashboard(page: Page): Promise<void> {
  if ((await page.getByTestId('app').getAttribute('data-view')) === 'settings') {
    await page.getByTestId('settings-toggle').click();
  }
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 10_000 });
}

/** Waits until the chat's newest item exists and its card is on screen; returns the item id. */
export async function cardOfChat(
  page: Page,
  userDataDir: string,
  chatJid: string,
  timeoutMs = 60_000,
): Promise<number> {
  let itemId: number | null = null;
  await expect
    .poll(
      async () => {
        itemId = lastItemOfChat(userDataDir, chatJid);
        if (itemId === null) return false;
        return (await page.getByTestId(`card-${itemId}`).count()) > 0;
      },
      { timeout: timeoutMs, message: `a card for ${chatJid.slice(0, 6)}... appears` },
    )
    .toBe(true);
  return itemId!;
}

/** The item ids of the cards rendered in one dashboard list (`card-<n>` roots only, not their `card-name` / `card-time` parts). */
export async function cardIdsIn(page: Page, list: 'needs_reply' | 'info_missing' | 'in_calendar'): Promise<number[]> {
  return page.evaluate((l) => {
    const root = document.querySelector(`[data-testid="list-${l}"]`);
    if (root === null) return [];
    return [...root.querySelectorAll('[data-testid]')]
      .map((el) => /^card-(\d+)$/.exec(el.getAttribute('data-testid') ?? ''))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]));
  }, list);
}
