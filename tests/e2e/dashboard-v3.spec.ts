// tests/e2e/dashboard-v3.spec.ts - [V3] T-904, handover §4 Task 7 (bridge ATTACH + WCA_MCP_CMD + stub LLM). Owner v3-task7.
//
// The four v3 dashboard features on the built app: (1) the X on a compact card dismisses it (item:dismiss, Undo restores),
// (2) the schedule-only filter hides a finished non-schedule card and the choice survives a relaunch, (3) the week calendar
// draws a proposed event in the column of its date and a block opens the sheet, (4) manual time: "Edit time" on a proposed
// card and "Save time" on an information-missing card both end in exactly ONE create-event, and only after the user's click.
// Plus (5) the Hebrew week: Sunday first, mirrored arrows, no horizontal scroll at 420 px.
//
// Every spec has its own profile. Chats are synthetic (`9725500000NN@s.whatsapp.net`), the model is the stub (WCA_LLM_SCRIPT),
// the calendar is the fake MCP child, and every write is read back from the fake's own journal.
import type { ElectronApplication, Page } from '@playwright/test';
import { attachBridge, mcpChild, type AttachedBridge, type McpChild } from './helpers/fakes.ts';
import { expect, test, wca, type E2eContext, type LaunchedApp } from './helpers/fixtures.ts';
import { createTurn, editStubRules, WED, type ScriptedTurn } from './helpers/edit.ts';
import { seedGoogleCredentials, seedProfile } from './helpers/seedProfile.ts';
import {
  actionsOfItem,
  anchorDate,
  AppClock,
  cardIdsIn,
  cardOfChat,
  E2E_NOW_MS,
  extraction,
  FAST_TIMERS_ENV,
  jid,
  lastItemOfChat,
  query,
} from './helpers/v2.ts';

test.setTimeout(240_000);

const MIN_WIDTH = 420;
const MIN_HEIGHT = 560;

interface V3World {
  e2e: E2eContext;
  launched: LaunchedApp;
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  bridge: AttachedBridge;
  mcp: McpChild;
  clock: AppClock;
  env: Record<string, string>;
}

/** Same world as `launchEditWorld` (helpers/edit.ts), but it keeps the launch env so a spec can relaunch on the same profile. */
async function launchV3(
  e2e: E2eContext,
  label: string,
  opts: { turns: ScriptedTurn[]; chats: number[]; language?: 'en' | 'he' },
): Promise<V3World> {
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
    meta: { calendar_roles_json: JSON.stringify({ primary: 'owner' }) },
  });
  seedGoogleCredentials(userDataDir);
  const bridge = await attachBridge(e2e, userDataDir);
  const mcp = mcpChild(e2e, label, undefined, userDataDir);
  const scriptFile = e2e.writeTempFile(`${label}-stub.json`, JSON.stringify({ rules: editStubRules(opts.turns) }));
  const env = {
    ...bridge.env,
    ...mcp.env,
    ...clock.env(),
    WCA_TIMERS: FAST_TIMERS_ENV,
    WCA_LLM: 'stub',
    WCA_LLM_SCRIPT: scriptFile,
    WCA_FOCUS_CHECK: 'visible-only',
  };
  e2e.sentinels.push(bridge.token);
  for (const n of opts.chats) e2e.sentinels.push(jid(n));
  const w = { e2e, userDataDir, bridge, mcp, clock, env } as Omit<V3World, 'launched' | 'app' | 'page'>;
  return start(w);
}

async function start(w: Omit<V3World, 'launched' | 'app' | 'page'>): Promise<V3World> {
  w.clock.markLaunch();
  const launched = await w.e2e.launch({ userDataDir: w.userDataDir, env: w.env });
  const page = launched.page;
  if (page === null) throw new Error('no window');
  await expect
    .poll(async () => (await wca(launched.app).health()).llm.state, { timeout: 20_000 })
    .toMatch(/^(ready|idle)$/);
  await expect
    .poll(async () => (await wca(launched.app).health()).calendar.state, { timeout: 30_000 })
    .toBe('connected');
  return { ...w, launched, app: launched.app, page };
}

async function say(w: V3World, n: number, text: string): Promise<void> {
  w.e2e.sentinels.push(text);
  await w.bridge.deliver(w.app, { chatJid: jid(n), text, ts: w.clock.date(), pushName: `Contact ${String(n)}` });
}

function creates(w: V3World): Array<{ args: Record<string, unknown> }> {
  return w.mcp.calls('create-event');
}

/** The real BrowserWindow's content size (the renderer's own viewport, not an emulation). */
async function setContentSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(
    async ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win === undefined) throw new Error('no window to resize');
      win.setContentSize(size.width, size.height);
      await new Promise((r) => setTimeout(r, 250));
    },
    { width, height },
  );
}

/** The `cal-day-<yyyy-mm-dd>` keys of the week on screen, in DOM (= reading) order. */
async function shownDays(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="cal-day-"]')].map((el) =>
      (el.getAttribute('data-testid') ?? '').replace(/^cal-day-/, ''),
    ),
  );
}

/** Steps the calendar forward (cal-next) until the column of `day` is on screen; the renderer's week starts at REAL now. */
async function goToWeekOf(page: Page, day: string): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    if ((await page.getByTestId(`cal-day-${day}`).count()) > 0) return;
    const before = await page.getByTestId('cal-range').textContent();
    await page.getByTestId('cal-next').click();
    await expect(page.getByTestId('cal-range')).not.toHaveText(before ?? '');
  }
  await expect(page.getByTestId(`cal-day-${day}`), `the week of ${day} is reachable with cal-next`).toBeVisible();
}

const weekdayOf = (day: string): number => new Date(`${day}T12:00:00Z`).getUTCDay();

// =====================================================================================================================
// Spec 1 - the X dismisses a compact card; nothing is sent or written; Undo brings it back
// =====================================================================================================================
test('v3: the X on a compact card dismisses it (closed_reason=dismissed), writes nothing, and Undo restores it', async ({
  e2e,
}) => {
  const w = await launchV3(e2e, 'v3-dismiss', { chats: [40], turns: [createTurn('[x1]', 15)] });
  const { page, userDataDir } = w;
  await say(w, 40, 'Meeting on Wednesday at 15:00? [x1]');
  const itemId = await cardOfChat(page, userDataDir, jid(40));
  await expect(page.locator(`[data-testid="list-needs_reply"] [data-testid="card-${itemId}"]`)).toBeVisible();

  const x = page.getByTestId(`dismiss-x-${itemId}`);
  await expect(x).toBeVisible();
  await expect(x).toHaveAttribute('aria-label', /\S/);
  await x.click();

  await expect(page.getByTestId(`card-${itemId}`), 'the dismissed card leaves the dashboard').toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.getByTestId('toast')).toBeVisible();
  await expect(page.getByTestId('toast-undo')).toBeVisible();
  await expect
    .poll(
      () =>
        query<{ closed_reason: string | null }>(userDataDir, 'SELECT closed_reason FROM items WHERE id = ?', itemId)[0]
          ?.closed_reason,
      { timeout: 15_000 },
    )
    .toBe('dismissed');

  // the X is not an approval: nothing executed, nothing reached the fakes
  const executed = actionsOfItem(userDataDir, itemId).filter(
    (a) => (a.kind === 'create_event' || a.kind === 'send_reply') && a.state === 'done',
  );
  expect(executed, 'no create_event / send_reply executed').toEqual([]);
  expect(creates(w), 'no create-event on the fake calendar').toHaveLength(0);
  expect(w.bridge.fake.sent, 'no WhatsApp send').toHaveLength(0);

  await page.getByTestId('toast-undo').click();
  await expect(page.getByTestId(`card-${itemId}`), 'Undo brings the card back').toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      () =>
        query<{ closed_reason: string | null }>(userDataDir, 'SELECT closed_reason FROM items WHERE id = ?', itemId)[0]
          ?.closed_reason ?? null,
      { timeout: 15_000 },
    )
    .toBeNull();
  await page.waitForTimeout(1_500);
  expect(creates(w)).toHaveLength(0);
  expect(w.bridge.fake.sent).toHaveLength(0);
});

// =====================================================================================================================
// Spec 2 - schedule-only filter: a finished smalltalk card is hidden by default, "Show all (1 hidden)" reveals it, the
// choice survives a relaunch on the same profile
// =====================================================================================================================
test('v3: the schedule-only filter hides a smalltalk card, "Show all (1 hidden)" reveals it, and the choice persists', async ({
  e2e,
}) => {
  const smalltalk: ScriptedTurn = {
    token: '[s1]',
    extract: extraction({ intent: 'smalltalk', needsReply: true, title: '', durationMin: 0, confidence: 'high' }),
    draft: 'Thanks, you too!',
  };
  const w = await launchV3(e2e, 'v3-filter', { chats: [41, 42], turns: [smalltalk, createTurn('[s2]', 11)] });
  const { page, userDataDir } = w;

  await say(w, 41, 'Have a nice weekend! [s1]');
  await say(w, 42, 'Meeting on Wednesday at 11:00? [s2]');
  const scheduleId = await cardOfChat(page, userDataDir, jid(42));
  await expect.poll(() => lastItemOfChat(userDataDir, jid(41)), { timeout: 60_000 }).not.toBeNull();
  const smallId = lastItemOfChat(userDataDir, jid(41))!;
  await expect
    .poll(
      () => query<{ analysis: string }>(userDataDir, 'SELECT analysis FROM items WHERE id = ?', smallId)[0]?.analysis,
      { timeout: 60_000, message: 'the smalltalk item finished its analysis' },
    )
    .toBe('done');

  const toggle = page.getByTestId('schedule-filter-toggle');
  await expect(toggle).toHaveText('Show all (1 hidden)', { timeout: 15_000 });
  await expect(page.getByTestId(`card-${scheduleId}`)).toBeVisible();
  await expect(page.getByTestId(`card-${smallId}`), 'the smalltalk card is hidden by the filter').toHaveCount(0);

  await toggle.click();
  await expect(page.getByTestId(`card-${smallId}`)).toBeVisible();
  await expect(page.getByTestId(`card-${scheduleId}`)).toBeVisible();
  await expect(toggle).toHaveText('Only schedules');

  // relaunch on the same profile: the filter is still off
  await e2e.quit(w.launched);
  const again = await start(w);
  await expect(again.page.getByTestId(`card-${smallId}`), 'the "show all" choice survived the relaunch').toBeVisible({
    timeout: 30_000,
  });
  await expect(again.page.getByTestId(`card-${scheduleId}`)).toBeVisible();
  await expect(again.page.getByTestId('schedule-filter-toggle')).toHaveText('Only schedules');

  // and back on: the smalltalk card hides again
  await again.page.getByTestId('schedule-filter-toggle').click();
  await expect(again.page.getByTestId(`card-${smallId}`)).toHaveCount(0);
  await expect(again.page.getByTestId('schedule-filter-toggle')).toHaveText('Show all (1 hidden)');
  expect(creates(w)).toHaveLength(0);
  expect(w.bridge.fake.sent).toHaveLength(0);
});

// =====================================================================================================================
// Spec 3 - the week calendar: the proposed event's block sits in the column of its date; a click opens the sheet;
// cal-next + cal-today return to the current week
// =====================================================================================================================
test('v3: the week calendar draws the proposed event in its day column and a block opens the sheet', async ({
  e2e,
}) => {
  const w = await launchV3(e2e, 'v3-calendar', { chats: [43], turns: [createTurn('[c1]', 15)] });
  const { page, userDataDir } = w;
  await say(w, 43, 'Meeting on Wednesday at 15:00? [c1]');
  const itemId = await cardOfChat(page, userDataDir, jid(43));
  await expect(page.getByTestId(`approve-event-${itemId}`)).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('view-calendar').click();
  await expect(page.getByTestId('view-calendar')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('calendar-week')).toBeVisible();
  await expect(page.getByTestId('cal-undated')).toBeVisible();
  await expect(page.getByTestId('cal-note'), 'the one-time scope note').toBeVisible();
  const thisWeek = (await page.getByTestId('cal-range').textContent()) ?? '';
  await expect(page.locator('[data-testid^="cal-day-"][data-today="true"]')).toHaveCount(1);

  // the stub's event is on WED (= anchorDate(2) of the pinned app clock), which lies 1-2 weeks after the real today
  await goToWeekOf(page, WED);
  const block = page.getByTestId(`cal-col-${WED}`).getByTestId(`cal-block-${itemId}`);
  await expect(block, 'the block is in the column of its date').toBeVisible();
  await expect(block).toHaveAttribute('data-state', 'proposed');
  // fix pass: line 1 is the start time, the full range is the (trusted) title attribute, the untrusted chat name is a
  // visually hidden bdi inside the block - never an attribute (ux.md 16.5)
  await expect(block.getByTestId(`cal-block-time-${itemId}`)).toHaveText('15:00');
  await expect(block).toHaveAttribute('title', /15:00-16:00/);
  await expect(block.locator('bdi.sr-only')).toHaveText('Contact 43');
  // fix pass: a wide column shows the short weekday over the day number
  await expect(page.getByTestId(`cal-day-${WED}`).locator('.cal-wd-short')).toBeVisible();
  await expect(page.getByTestId(`cal-day-${WED}`).locator('.cal-wd-narrow')).toBeHidden();
  await expect(page.getByTestId(`cal-day-${WED}`).locator('.cal-daynum')).toBeVisible();
  // and it is not drawn in any other column
  await expect(page.locator(`[data-testid="cal-block-${itemId}"]`)).toHaveCount(1);
  // a dated card is on the grid, not in the side list
  await expect(page.locator(`[data-testid="cal-undated"] [data-testid="card-${itemId}"]`)).toHaveCount(0);
  await block.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await e2e.screenshot(page, 'en-calendar');

  await block.click();
  await expect(page.getByTestId('item-sheet')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId(`sheet-dismiss-${itemId}`)).toBeVisible();
  await page.getByTestId('sheet-close').click();
  await expect(page.getByTestId('item-sheet')).toHaveCount(0);

  await page.getByTestId('cal-next').click();
  await expect(page.getByTestId(`cal-day-${WED}`)).toHaveCount(0);
  await page.getByTestId('cal-today').click();
  await expect(page.getByTestId('cal-range')).toHaveText(thisWeek);
  await expect(page.locator('[data-testid^="cal-day-"][data-today="true"]')).toHaveCount(1);

  // opening and browsing the calendar wrote nothing
  expect(creates(w)).toHaveLength(0);
  expect(w.bridge.fake.sent).toHaveLength(0);

  // back to cards: the view switch round-trips
  await page.getByTestId('view-cards').click();
  await expect(page.getByTestId('calendar-week')).toHaveCount(0);
  await expect(page.getByTestId(`card-${itemId}`)).toBeVisible();
});

// =====================================================================================================================
// Spec 4 - manual time: (a) Edit time on a proposed card, (b) Save time on an information-missing card
// =====================================================================================================================
test('v3: Edit time on a proposed card -> Add to calendar writes exactly one create-event at the edited time', async ({
  e2e,
}) => {
  const w = await launchV3(e2e, 'v3-edit-time', { chats: [44], turns: [createTurn('[e1]', 15)] });
  const { page, userDataDir } = w;
  await say(w, 44, 'Meeting on Wednesday at 15:00? [e1]');
  const itemId = await cardOfChat(page, userDataDir, jid(44));
  await expect(page.getByTestId(`approve-event-${itemId}`)).toBeVisible({ timeout: 30_000 });

  await page.getByTestId(`edit-event-${itemId}`).click();
  const editor = page.getByTestId(`inline-editor-${itemId}`);
  await expect(editor).toBeVisible();
  await expect(editor.getByTestId('event-start')).toHaveValue('15:00');
  await editor.getByTestId('event-start').fill('17:00');
  await editor.getByTestId('event-end').fill('18:00');
  await expect(page.getByTestId(`approve-event-${itemId}`)).toBeEnabled();
  expect(creates(w), 'editing writes nothing').toHaveLength(0);

  await page.getByTestId(`approve-event-${itemId}`).click();
  await expect.poll(() => creates(w).length, { timeout: 30_000 }).toBe(1);
  const args = creates(w)[0]!.args;
  expect(String(args.start)).toContain(`${WED}T17:00`);
  expect(String(args.end)).toContain(`${WED}T18:00`);
  await expect
    .poll(() => actionsOfItem(userDataDir, itemId).find((a) => a.kind === 'create_event')?.state, { timeout: 30_000 })
    .toBe('done');
  await page.waitForTimeout(2_000);
  expect(creates(w), 'exactly one create-event').toHaveLength(1);
  expect(w.bridge.fake.sent, 'no send').toHaveLength(0);
});

test('v3: Save time on an information-missing card proposes the event (provider=user); Add to calendar writes one create-event', async ({
  e2e,
}) => {
  const THU = anchorDate(3);
  const missing: ScriptedTurn = {
    token: '[m1]',
    extract: extraction({
      intent: 'schedule_request',
      title: 'Meeting',
      dateKind: 'none',
      time24h: '',
      durationMin: 60,
      missing: ['date', 'time'],
      confidence: 'high',
    }),
    draft: 'Sure, when suits you?',
  };
  const w = await launchV3(e2e, 'v3-save-time', { chats: [45], turns: [missing] });
  const { page, userDataDir } = w;
  await say(w, 45, 'We should meet sometime soon [m1]');
  const itemId = await cardOfChat(page, userDataDir, jid(45));
  await expect.poll(() => cardIdsIn(page, 'info_missing'), { timeout: 30_000 }).toContain(itemId);

  const form = page.getByTestId(`fill-form-${itemId}`);
  await expect(form).toBeVisible();
  const save = page.getByTestId(`save-event-${itemId}`);
  await expect(save, 'nothing to save before a date and time exist').toBeDisabled();

  const title = form.getByTestId('event-title');
  if ((await title.count()) > 0 && (await title.inputValue()) === '') await title.fill('Meeting');
  await form.getByTestId('event-date').fill(THU);
  await form.getByTestId('event-start').fill('10:00');
  await form.getByTestId('event-end').fill('11:00');
  await expect(save).toBeEnabled();
  await save.click();

  await expect(page.getByTestId('toast')).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      () =>
        query<{ provider: string }>(
          userDataDir,
          'SELECT provider FROM proposals WHERE item_id = ? ORDER BY version DESC LIMIT 1',
          itemId,
        )[0]?.provider,
      { timeout: 15_000 },
    )
    .toBe('user');
  await expect.poll(() => cardIdsIn(page, 'needs_reply'), { timeout: 30_000 }).toContain(itemId);
  await expect(page.getByTestId(`approve-event-${itemId}`)).toBeVisible();
  expect(creates(w), 'Save time writes a proposal, never a calendar event').toHaveLength(0);

  await page.getByTestId(`approve-event-${itemId}`).click();
  await expect.poll(() => creates(w).length, { timeout: 30_000 }).toBe(1);
  const args = creates(w)[0]!.args;
  expect(String(args.start)).toContain(`${THU}T10:00`);
  expect(String(args.end)).toContain(`${THU}T11:00`);
  await page.waitForTimeout(2_000);
  expect(creates(w), 'exactly one create-event').toHaveLength(1);
  expect(w.bridge.fake.sent, 'no send').toHaveLength(0);
});

// =====================================================================================================================
// Spec 5 - Hebrew week (review focus 5): Sunday first, mirrored prev/next arrows, no horizontal scroll at 420 px
// =====================================================================================================================
test('v3: the Hebrew week starts on Sunday, its arrows are mirrored, and nothing scrolls horizontally at 420 px', async ({
  e2e,
}) => {
  const w = await launchV3(e2e, 'v3-he-calendar', {
    chats: [46],
    language: 'he',
    turns: [createTurn('[h1]', 15, 'פגישה')],
  });
  const { page, userDataDir } = w;
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await say(w, 46, 'פגישה ביום רביעי ב-15:00? [h1]');
  const itemId = await cardOfChat(page, userDataDir, jid(46));

  await page.getByTestId('view-calendar').click();
  await expect(page.getByTestId('calendar-week')).toBeVisible();
  const days = await shownDays(page);
  expect(days).toHaveLength(7);
  expect(weekdayOf(days[0]!), `the first column (${days[0]!}) is a Sunday`).toBe(0);

  // the arrows point in reading order: `icon-dir` mirrors the chevron in RTL (scaleX(-1)), no rotate
  for (const id of ['cal-prev', 'cal-next']) {
    const transform = await page
      .getByTestId(id)
      .locator('svg')
      .evaluate((el) => getComputedStyle(el).transform);
    expect(transform, `${id} chevron is mirrored`).toBe('matrix(-1, 0, 0, 1, 0, 0)');
  }

  await goToWeekOf(page, WED);
  expect(weekdayOf((await shownDays(page))[0]!)).toBe(0);
  const block = page.getByTestId(`cal-col-${WED}`).getByTestId(`cal-block-${itemId}`);
  await expect(block).toBeVisible();
  await block.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await e2e.screenshot(page, 'he-calendar');

  await setContentSize(w.app, MIN_WIDTH, MIN_HEIGHT);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'no horizontal scrollbar in the Hebrew calendar at 420 px').toBeLessThanOrEqual(0);
  // fix pass: under 72 px a column shows the narrow weekday; the day number stays
  await expect(page.getByTestId(`cal-day-${WED}`).locator('.cal-wd-narrow')).toBeVisible();
  await expect(page.getByTestId(`cal-day-${WED}`).locator('.cal-wd-short')).toBeHidden();
  await expect(page.getByTestId(`cal-day-${WED}`).locator('.cal-daynum')).toBeVisible();
  await block.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await e2e.screenshot(page, 'he-calendar-420');
});
