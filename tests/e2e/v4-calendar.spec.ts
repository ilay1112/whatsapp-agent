// tests/e2e/v4-calendar.spec.ts - [v4 T7] T-908 handover §2.4 / §2.5 (I1', I8, I9') on the built app.
//
// The calendar view shows every calendar of the account (the fake child seeded with v4CalendarSeed: Personal owner, Work writer,
// Holidays reader) and manages events through the approval path - each write is ONE pending manual action (calendar:propose*)
// approved by the confirm click (action:approve), read back from the fake's own journal:
//   - foreign events of 2+ calendars in their hues; the picker hides one;
//   - an attendee event: actions disabled with the reason, and a bypassing calendar:proposeEdit is refused by main;
//   - create on the second calendar -> exactly one create-event with that calendarId;
//   - move a foreign event -> exactly one update-event with If-Match;
//   - delete -> exactly one delete-event; the toast's Undo -> exactly one create-event from the snapshot;
//   - cal-refresh re-reads (invalidate);
//   - screenshots calendar-foreign-{en,he}, calendar-popover-en, calendar-confirm-delete-en.
// The side-effect ledger (rule 13) proves every manual call against a click-approved manual action + its snapshot row.
import { createHash } from 'node:crypto';
import type { ElectronApplication, Page } from '@playwright/test';
import { attachBridge, mcpChild, type AttachedBridge, type McpChild } from './helpers/fakes.ts';
import { expect, test, type E2eContext, type LaunchedApp, wca } from './helpers/fixtures.ts';
import { seedGoogleCredentials, seedProfile } from './helpers/seedProfile.ts';
import { AppClock, E2E_NOW_MS, FAST_TIMERS_ENV, anchorDate } from './helpers/v2.ts';
import { V4_CALENDARS, V4_EVENT_IDS, v4CalendarSeed } from '../fakes/fake-mcp-calendar.ts';

test.setTimeout(240_000);

const TZ = 'Asia/Jerusalem';
const WED = anchorDate(2);
const ROLES = { primary: 'owner', [V4_CALENDARS.work]: 'writer', [V4_CALENDARS.holidays]: 'reader' };

/** The renderer's opaque key of an event (= ItemCard.calendar.eventKey); block test id = its first 8 hex. */
const eventKey = (eventId: string): string =>
  createHash('sha256').update(`wca-event|${eventId}`, 'utf8').digest('hex').slice(0, 16);
const blockId = (eventId: string): string => `cal-block-f-${eventKey(eventId).slice(0, 8)}`;
/** The renderer's hash8 (FNV-1a 32) - picker / failed-calendar test ids. */
const hash8 = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};

interface World {
  e2e: E2eContext;
  launched: LaunchedApp;
  app: ElectronApplication;
  page: Page;
  bridge: AttachedBridge;
  mcp: McpChild;
}

async function launch(e2e: E2eContext, label: string, language: 'en' | 'he'): Promise<World> {
  const userDataDir = e2e.newProfileDir(label);
  const clock = new AppClock();
  seedProfile({
    userDataDir,
    onboardingStep: 'done',
    now: (E2E_NOW_MS - 2 * 3_600_000) as never,
    settings: { provider: 'local', targetCalendarId: 'primary', timeZone: TZ, language },
    chats: [],
    meta: { calendar_roles_json: JSON.stringify(ROLES) },
  });
  seedGoogleCredentials(userDataDir);
  const bridge = await attachBridge(e2e, userDataDir);
  const seed = v4CalendarSeed(WED, TZ);
  const mcp = mcpChild(e2e, label, { calendars: seed.calendars, events: seed.events }, userDataDir);
  const env = {
    ...bridge.env,
    ...mcp.env,
    ...clock.env(),
    WCA_TIMERS: FAST_TIMERS_ENV,
    WCA_FOCUS_CHECK: 'visible-only',
  };
  e2e.sentinels.push(bridge.token);
  clock.markLaunch();
  const launched = await e2e.launch({ userDataDir, env });
  const page = launched.page;
  if (page === null) throw new Error('no window');
  await expect
    .poll(async () => (await wca(launched.app).health()).calendar.state, { timeout: 30_000 })
    .toBe('connected');
  return { e2e, launched, app: launched.app, page, bridge, mcp };
}

/** Calendar view, the week of WED, the one-time note out of the way. */
async function openWeek(page: Page): Promise<void> {
  await page.getByTestId('view-calendar').click();
  await expect(page.getByTestId('calendar-week')).toBeVisible();
  if ((await page.getByTestId('cal-note-dismiss').count()) > 0) await page.getByTestId('cal-note-dismiss').click();
  for (let i = 0; i < 6; i += 1) {
    if ((await page.getByTestId(`cal-day-${WED}`).count()) > 0) break;
    const before = await page.getByTestId('cal-range').textContent();
    await page.getByTestId('cal-next').click();
    await expect(page.getByTestId('cal-range')).not.toHaveText(before ?? '');
  }
  await expect(page.getByTestId(`cal-day-${WED}`)).toBeVisible();
  await expect(page.getByTestId(blockId(V4_EVENT_IDS.plain))).toBeVisible({ timeout: 20_000 });
}

const writes = (w: World): Array<{ tool: string; args: Record<string, unknown> }> =>
  w.mcp.calls().filter((c) => ['create-event', 'update-event', 'delete-event'].includes(c.tool));

test("v4: every calendar in its hue; picker; manual create / move / delete / undo through the confirm click; I9' refused", async ({
  e2e,
}) => {
  const w = await launch(e2e, 'v4-calendar-en', 'en');
  const { page } = w;
  await openWeek(page);

  // ---- every calendar, its own hue ----
  const plain = page.getByTestId(blockId(V4_EVENT_IDS.plain));
  const attendee = page.getByTestId(blockId(V4_EVENT_IDS.attendees));
  await expect(attendee).toBeVisible();
  await expect(page.getByTestId(blockId(V4_EVENT_IDS.allDay))).toBeVisible();
  // each calendar its own hue (the three seed calendars hash to one hue; the view spreads them - assignCalendarHues)
  const hues = await Promise.all(
    [plain, attendee, page.getByTestId(blockId(V4_EVENT_IDS.allDay))].map((b) => b.getAttribute('data-cal-hue')),
  );
  expect(new Set(hues).size, `hues ${hues.join(',')}`).toBe(3);
  // the popover / legend swatch of a calendar uses the same hue as its blocks
  expect(hues[0]).toBe(String(Number.parseInt(hash8('primary'), 16) % 8));
  await expect(page.getByTestId('cal-legend')).toBeVisible();
  await e2e.screenshot(page, 'calendar-foreign-en');

  // ---- the picker hides one calendar ----
  await page.getByTestId('cal-picker').locator('summary').click();
  await page.getByTestId(`cal-picker-${hash8(V4_CALENDARS.work)}`).click();
  await expect(attendee).toHaveCount(0);
  await expect(plain).toBeVisible();
  await page.getByTestId(`cal-picker-${hash8(V4_CALENDARS.work)}`).click();
  await expect(attendee).toBeVisible();
  await page.getByTestId('cal-picker').locator('summary').click(); // close the disclosure

  // ---- I9': the attendee event cannot be managed; a bypassing proposal is refused by main ----
  await attendee.click();
  const pop = page.getByTestId('cal-event-popover');
  await expect(pop.getByTestId('cal-reason-attendees')).toBeVisible();
  for (const id of ['cal-action-edit', 'cal-action-move', 'cal-action-delete'])
    await expect(pop.getByTestId(id)).toBeDisabled();
  await e2e.screenshot(page, 'calendar-popover-en');
  const bypass = await page.evaluate(
    (req) =>
      (window as unknown as { api: { invoke(c: string, r: unknown): Promise<unknown> } }).api.invoke(
        'calendar:proposeEdit',
        req,
      ),
    { calendarId: V4_CALENDARS.work, eventKey: eventKey(V4_EVENT_IDS.attendees), patch: { title: 'Hijacked' } },
  );
  expect(bypass).toEqual({ ok: false, error: { code: 'CAL_EVENT_FOREIGN_PROTECTED' } });
  await pop.getByTestId('cal-popover-close').click();
  expect(writes(w), 'nothing written so far').toEqual([]);

  // ---- create on the SECOND calendar: one create-event with that calendarId, only after the confirm click ----
  await page.getByTestId('cal-new-event').click();
  await page.getByTestId('cal-dialog-calendar').selectOption(V4_CALENDARS.work);
  await page.getByTestId('cal-dialog-title').fill('Gym');
  await page.getByTestId('cal-dialog-date').fill(WED);
  await page.getByTestId('cal-dialog-start').fill('18:00');
  await page.getByTestId('cal-dialog-end').fill('19:00');
  await page.getByTestId('cal-dialog-submit').click();
  await expect(page.getByTestId('cal-confirm')).toBeVisible();
  await expect(page.getByTestId('cal-confirm-question')).toContainText('Work');
  expect(writes(w), 'propose wrote nothing').toEqual([]);
  await page.getByTestId('cal-confirm-ok').click();
  await expect(page.getByTestId('toast')).toContainText('Event added');
  await expect.poll(() => w.mcp.calls('create-event').length).toBe(1);
  expect(w.mcp.calls('create-event')[0]!.args).toMatchObject({
    calendarId: V4_CALENDARS.work,
    summary: 'Gym',
    extendedProperties: { private: { waAgent: '1', waManual: '1' } },
  });

  // ---- move the foreign (untagged) event: one update-event with If-Match, content only ----
  await plain.click();
  await page.getByTestId('cal-event-popover').getByTestId('cal-action-move').click();
  await page.getByTestId('cal-dialog-start').fill('12:00');
  await page.getByTestId('cal-dialog-end').fill('13:00');
  await page.getByTestId('cal-dialog-submit').click();
  await expect(page.getByTestId('cal-confirm')).toHaveAttribute('data-op', 'edit');
  await page.getByTestId('cal-confirm-ok').click();
  await expect(page.getByTestId('toast')).toContainText('Event changed');
  await expect.poll(() => w.mcp.calls('update-event').length).toBe(1);
  const update = w.mcp.calls('update-event')[0]!.args;
  expect(update).toMatchObject({ calendarId: 'primary', eventId: V4_EVENT_IDS.plain, start: `${WED}T12:00:00` });
  expect(typeof update.ifMatch).toBe('string');
  expect(update).not.toHaveProperty('extendedProperties');
  expect(update).not.toHaveProperty('status');

  // ---- delete: one delete-event; Undo recreates it from the snapshot (one create-event) ----
  await expect(plain).toBeVisible();
  await plain.click();
  await page.getByTestId('cal-event-popover').getByTestId('cal-action-delete').click();
  await expect(page.getByTestId('cal-confirm')).toHaveAttribute('data-op', 'delete');
  await e2e.screenshot(page, 'calendar-confirm-delete-en');
  await page.getByTestId('cal-confirm-ok').click();
  await expect(page.getByTestId('toast')).toContainText('Event deleted');
  await expect.poll(() => w.mcp.calls('delete-event').length).toBe(1);
  expect(w.mcp.calls('delete-event')[0]!.args).toEqual({
    calendarId: 'primary',
    eventId: V4_EVENT_IDS.plain,
    account: 'personal',
    sendUpdates: 'none',
  });
  await expect(plain).toHaveCount(0);
  await page.getByTestId('toast-undo').click();
  await expect.poll(() => w.mcp.calls('create-event').length).toBe(2);
  const recreated = w.mcp.calls('create-event')[1]!.args;
  expect(recreated).toMatchObject({
    calendarId: 'primary',
    summary: 'Dentist',
    start: `${WED}T12:00:00`,
    end: `${WED}T13:00:00`,
    location: 'Clinic',
    extendedProperties: { private: { waAgent: '1', waManual: '1' } },
  });
  expect(recreated.eventId).not.toBe(V4_EVENT_IDS.plain);
  await expect(page.getByTestId('toast')).toContainText('Change undone');
  expect(w.mcp.calls('delete-event')).toHaveLength(1);

  // ---- Refresh events re-reads ----
  const lists = w.mcp.calls('list-events').length;
  await page.getByTestId('cal-refresh').click();
  await expect.poll(() => w.mcp.calls('list-events').length).toBeGreaterThan(lists);
  expect(writes(w).map((c) => c.tool)).toEqual(['create-event', 'update-event', 'delete-event', 'create-event']);
});

test('v4: the calendar view in Hebrew (RTL) shows every calendar', async ({ e2e }) => {
  const w = await launch(e2e, 'v4-calendar-he', 'he');
  await openWeek(w.page);
  await expect(w.page.getByTestId(blockId(V4_EVENT_IDS.attendees))).toBeVisible();
  await expect(w.page.locator('html')).toHaveAttribute('dir', 'rtl');
  await e2e.screenshot(w.page, 'calendar-foreign-he');
  expect(writes(w)).toEqual([]);
});
