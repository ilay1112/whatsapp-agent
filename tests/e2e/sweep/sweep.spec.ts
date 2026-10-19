// tests/e2e/sweep/sweep.spec.ts - the UI sweep: every view, menu and button of the built app, clicked once, recorded.
//
// QA deliverable (ops/agent-notes/ui-sweep.md). Every test has its own temp profile; every external system is a fake (bridge ATTACH or
// CHILD, calendar MCP child, stub LLM, fake CLIs, fake model host). The sweep NEVER clicks an approval-class control (send / add to
// calendar / approve / undo a write / accept a consent) - the one "Add to calendar" click below is SETUP of the in-calendar card on
// the fake calendar, exactly as dashboard-v3 / edit-change do it, and it is not part of the recorded sweep. Native dialogs are stubbed
// to "cancelled" in main (harness.ts `instrument`), the clipboard is stubbed, shell.openExternal is the e2e recorder.
//
// A control that does nothing is a FINDING, recorded in test-results/sweep/results-<test>.json; the spec does not fail on it.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { startFakeLlamaServer } from '../../fakes/fake-llama-server.ts';
import { attachBridge, cliFakes, freePort, llamaCmdSeam, mcpChild, newBridgeToken } from '../helpers/fakes.ts';
import {
  bridgeCmdSeam,
  control,
  expect,
  test,
  waitForControl,
  wca,
  type E2eContext,
  type LaunchedApp,
} from '../helpers/fixtures.ts';
import { consoleRecorder } from '../helpers/cli.ts';
import { createTurn, editStubRules, type ScriptedTurn } from '../helpers/edit.ts';
import { seedGoogleCredentials, seedProfile, TESTONLY_GOOGLE_CREDENTIALS } from '../helpers/seedProfile.ts';
import {
  actionsOfItem,
  AppClock,
  E2E_NOW_MS,
  extraction,
  FAST_TIMERS_ENV,
  jid,
  lastItemOfChat,
  query,
} from '../helpers/v2.ts';
import {
  backgroundChannels,
  cancelOverlays,
  instrument,
  sweepState,
  SWEEP_DIR,
  writeRows,
  type ControlInfo,
  type InstrumentStatus,
  type SweepCtx,
  type SweepState,
} from './harness.ts';

type Lang = 'en' | 'he';

// ---------------------------------------------------------------------------------------------------------------------
// worlds
// ---------------------------------------------------------------------------------------------------------------------

interface World {
  e2e: E2eContext;
  launched: LaunchedApp;
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  clock: AppClock;
  say(n: number, text: string): Promise<void>;
  calls(tool: string): number;
  consoleErrors: string[];
  status: InstrumentStatus;
}

const SMALLTALK = (token: string): ScriptedTurn => ({
  token,
  extract: extraction({ intent: 'smalltalk', needsReply: true, title: '', durationMin: 0, confidence: 'high' }),
  draft: 'Thanks, you too!',
});
const MISSING: ScriptedTurn = {
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
const TURNS: ScriptedTurn[] = [
  createTurn('[s1]', 15),
  MISSING,
  createTurn('[c1]', 11),
  SMALLTALK('[t1]'),
  SMALLTALK('[d1]'),
];
const CHATS = [40, 41, 42, 43, 44];

async function launchWorld(e2e: E2eContext, label: string, lang: Lang, opts: { cli?: boolean } = {}): Promise<World> {
  const userDataDir = e2e.newProfileDir(label);
  const clock = new AppClock();
  seedProfile({
    userDataDir,
    onboardingStep: 'done',
    now: (E2E_NOW_MS - 2 * 3_600_000) as never,
    trayHintSeen: true,
    settings: { provider: 'local', targetCalendarId: 'primary', timeZone: 'Asia/Jerusalem', language: lang },
    chats: CHATS.map((n) => ({ jid: jid(n), name: `Contact ${String(n)}` })),
    meta: { calendar_roles_json: JSON.stringify({ primary: 'owner' }) },
  });
  seedGoogleCredentials(userDataDir);
  const bridge = await attachBridge(e2e, userDataDir);
  const mcp = mcpChild(e2e, label, undefined, userDataDir);
  const script = e2e.writeTempFile(`${label}-stub.json`, JSON.stringify({ rules: editStubRules(TURNS) }));
  const cli = opts.cli === true ? cliFakes(e2e, { claude: { loggedIn: false }, agy: null, label, userDataDir }) : null;
  const rec = opts.cli === true ? consoleRecorder(e2e, label) : null;
  clock.markLaunch();
  const launched = await e2e.launch({
    userDataDir,
    allowConsoleErrors: [''], // the sweep records console errors itself (a finding, not a spec failure)
    env: {
      ...bridge.env,
      ...mcp.env,
      ...clock.env(),
      ...(cli?.env ?? {}),
      ...(rec?.env ?? {}),
      WCA_TIMERS: FAST_TIMERS_ENV,
      WCA_LLM: 'stub',
      WCA_LLM_SCRIPT: script,
      WCA_FOCUS_CHECK: 'visible-only',
      WCA_DIALOG_SCRIPT: '[]', // every main-owned automatic-mode dialog answers Cancel
    },
  });
  const page = launched.page;
  if (page === null) throw new Error('no window');
  const consoleErrors: string[] = [];
  page.setDefaultTimeout(10_000);
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  const status = await instrument(launched.app);
  await expect
    .poll(async () => (await wca(launched.app).health()).llm.state, { timeout: 30_000 })
    .toMatch(/^(ready|idle)$/);
  await expect
    .poll(async () => (await wca(launched.app).health()).calendar.state, { timeout: 30_000 })
    .toBe('connected');
  return {
    e2e,
    launched,
    app: launched.app,
    page,
    userDataDir,
    clock,
    consoleErrors,
    status,
    say: async (n, text) => {
      await bridge.deliver(launched.app, { chatJid: jid(n), text, ts: clock.date(), pushName: `Contact ${String(n)}` });
    },
    calls: (tool) => mcp.calls(tool).length,
  };
}

interface Cards {
  sched: number;
  missing: number;
  inCal: number;
  small: number;
  dismissed: number;
}

const analysisOf = (dir: string, id: number): string | undefined =>
  query<{ analysis: string }>(dir, 'SELECT analysis FROM items WHERE id = ?', id)[0]?.analysis;

async function itemOf(w: World, n: number): Promise<number> {
  await expect.poll(() => lastItemOfChat(w.userDataDir, jid(n)), { timeout: 60_000 }).not.toBeNull();
  const id = lastItemOfChat(w.userDataDir, jid(n))!;
  await expect.poll(() => analysisOf(w.userDataDir, id), { timeout: 60_000 }).toBe('done');
  return id;
}

/** The four dashboard cards + one dismissed card (for the Undo-dismiss drawer). */
async function seedCards(w: World): Promise<Cards> {
  await w.say(40, 'Meeting on Wednesday at 15:00? [s1]');
  await w.say(41, 'We should meet sometime soon [m1]');
  await w.say(42, 'Meeting on Wednesday at 11:00? [c1]');
  await w.say(43, 'Have a nice weekend! [t1]');
  await w.say(44, 'Thanks for yesterday! [d1]');
  const cards: Cards = {
    sched: await itemOf(w, 40),
    missing: await itemOf(w, 41),
    inCal: await itemOf(w, 42),
    small: await itemOf(w, 43),
    dismissed: await itemOf(w, 44),
  };
  // SETUP (not part of the sweep): the in-calendar card is made the way a user makes one - one "Add to calendar" click on the FAKE
  // calendar (the reply is NOT sent). Same move as dashboard-v3 spec 4 / helpers/edit.ts createEventByClick.
  const approve = w.page.getByTestId(`approve-event-${cards.inCal}`);
  await expect(approve).toBeVisible({ timeout: 30_000 });
  await w.page.waitForTimeout(700);
  await approve.click();
  await expect.poll(() => w.calls('create-event'), { timeout: 30_000 }).toBe(1);
  await expect
    .poll(() => actionsOfItem(w.userDataDir, cards.inCal).find((a) => a.kind === 'create_event')?.state, {
      timeout: 30_000,
    })
    .toBe('done');
  // SETUP: one dismissed card, so the footer offers "Undo dismiss".
  await invoke(w.page, 'item:dismiss', { itemId: cards.dismissed });
  await expect(w.page.getByTestId('undo-dismiss')).toBeVisible({ timeout: 15_000 });
  return cards;
}

async function invoke(page: Page, channel: string, req?: unknown): Promise<unknown> {
  return page.evaluate(
    ({ channel, req }) =>
      (window as unknown as { api: { invoke(c: string, r?: unknown): Promise<unknown> } }).api.invoke(channel, req),
    { channel, req },
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// state normalisers
// ---------------------------------------------------------------------------------------------------------------------

const visible = async (page: Page, sel: string): Promise<boolean> =>
  (await page.locator(sel).filter({ visible: true }).count()) > 0;

async function ensureLang(page: Page, lang: Lang): Promise<void> {
  const cur = await page.evaluate(() => document.documentElement.lang);
  if (cur === lang) return;
  await invoke(page, 'settings:set', { general: { language: lang } });
  await expect(page.locator('html')).toHaveAttribute('lang', lang, { timeout: 10_000 });
}

async function viewOf(page: Page): Promise<string | null> {
  return page.getByTestId('app').getAttribute('data-view', { timeout: 10_000 });
}

/** Leaves onboarding (a health action / setup strip can send the dashboard there) by marking it done and reloading. */
async function leaveOnboarding(page: Page): Promise<void> {
  if ((await viewOf(page)) !== 'onboarding') return;
  await invoke(page, 'onboarding:setStep', { step: 'done' });
  await page.reload();
  await page.waitForSelector('[data-testid="app"]', { timeout: 30_000 });
  await expect.poll(() => viewOf(page), { timeout: 15_000 }).toBe('dashboard');
}

async function closeTransient(page: Page): Promise<void> {
  await cancelOverlays(page);
  for (const trig of await page.locator('[aria-haspopup="menu"][aria-expanded="true"]').all()) {
    await trig.click({ timeout: 2_000 }).catch(() => undefined);
  }
  if (await visible(page, '[data-testid="health-panel"]')) await page.getByTestId('health-pill').click();
  if (await visible(page, '[data-testid="download-panel"]')) await page.keyboard.press('Escape');
}

interface DashOpts {
  lang: Lang;
  scheduleOnly: boolean;
  view: 'cards' | 'calendar';
  smallId: number;
}

async function ensureDashboard(page: Page, o: DashOpts): Promise<void> {
  await leaveOnboarding(page);
  await closeTransient(page);
  if ((await viewOf(page)) === 'settings') await page.getByTestId('settings-toggle').click();
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 });
  await ensureLang(page, o.lang);
  if (await visible(page, '[data-testid="discard-confirm"]')) await page.getByTestId('discard-confirm-yes').click();
  if (await visible(page, '[data-testid="item-sheet"]')) {
    await page.getByTestId('sheet-close').click();
    if (await visible(page, '[data-testid="discard-confirm"]')) await page.getByTestId('discard-confirm-yes').click();
    await expect(page.getByTestId('item-sheet')).toHaveCount(0, { timeout: 5_000 });
  }
  if (await visible(page, '[data-testid="undo-dismiss-drawer"]')) await page.getByTestId('undo-dismiss-close').click();
  const pause = page.getByTestId('pause-toggle');
  if ((await pause.getAttribute('aria-pressed')) === 'true') await invoke(page, 'agent:setPaused', { paused: false });
  // collapse inline editors a click opened
  for (const ed of await page.locator('[data-testid^="edit-event-"][aria-expanded="true"]').all())
    await ed.click({ timeout: 2_000 }).catch(() => undefined);
  const calOn = (await page.getByTestId('view-calendar').getAttribute('aria-pressed')) === 'true';
  if (o.view === 'cards' && calOn) await page.getByTestId('view-cards').click();
  if (o.view === 'calendar' && !calOn) await page.getByTestId('view-calendar').click();
  if (o.view === 'cards') {
    const smallShown = (await page.getByTestId(`card-${o.smallId}`).count()) > 0;
    const toggle = page.getByTestId('schedule-filter-toggle');
    if (o.scheduleOnly === smallShown && (await toggle.count()) > 0) {
      await toggle.click();
      await expect
        .poll(async () => (await page.getByTestId(`card-${o.smallId}`).count()) > 0, { timeout: 5_000 })
        .toBe(!o.scheduleOnly);
    }
  }
}

async function ensureSettings(page: Page, lang: Lang, sub: 'page' | 'activity' = 'page'): Promise<void> {
  await leaveOnboarding(page);
  await closeTransient(page);
  for (const c of await page.locator('[data-testid$="-confirm-cancel"]').filter({ visible: true }).all())
    await c.click({ timeout: 2_000 }).catch(() => undefined);
  await ensureLang(page, lang);
  if ((await viewOf(page)) !== 'settings') {
    await page.getByTestId('settings-toggle').click();
    await expect(page.getByTestId('settings')).toBeVisible({ timeout: 10_000 });
  }
  const onActivity = await visible(page, '[data-testid="auto-activity"]');
  if (sub === 'page' && onActivity) await page.getByTestId('auto-activity-back').click();
  if (sub === 'activity') {
    if (!onActivity) {
      await page.getByTestId('auto-open-activity').click();
      await expect(page.getByTestId('auto-activity')).toBeVisible({ timeout: 10_000 });
    }
    return;
  }
  await expect(page.getByTestId('settings-group-general')).toBeVisible({ timeout: 10_000 });
  // "every group expanded": open every collapsed disclosure and <details> of the page
  for (let i = 0; i < 8; i += 1) {
    const closed = page
      .locator('[data-testid="settings"] button[aria-expanded="false"]:not([aria-haspopup])')
      .filter({ visible: true });
    if ((await closed.count()) === 0) break;
    await closed
      .first()
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await page.waitForTimeout(150);
  }
  await page.evaluate(() =>
    document
      .querySelectorAll('[data-testid="settings"] details:not([open])')
      .forEach((d) => d.setAttribute('open', '')),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// per-control "put it back" hooks (state the sweep changed through a legitimate, non-approval control)
// ---------------------------------------------------------------------------------------------------------------------

function restoreHook(w: World, dismissedId: number | null): SweepCtx['after'] {
  return async (c: ControlInfo, page: Page) => {
    const id = c.testId ?? '';
    let m = /^(?:dismiss-x|dismiss|sheet-dismiss)-(\d+)$/.exec(id);
    if (m) {
      const itemId = Number(m[1]);
      if (itemId !== dismissedId) await invoke(page, 'item:restore', { itemId });
      await page.waitForTimeout(400);
      return;
    }
    m = /^never-(\d+)$/.exec(id);
    if (m) {
      const chatRef = query<{ chat_id: number }>(
        w.userDataDir,
        'SELECT chat_id FROM items WHERE id = ?',
        Number(m[1]),
      )[0]?.chat_id;
      if (chatRef !== undefined) await invoke(page, 'chat:setPolicy', { chatRef, policy: 'default' });
      await page.waitForTimeout(400);
      return;
    }
    m = /^restore-(\d+)$/.exec(id);
    if (m) {
      await invoke(page, 'item:dismiss', { itemId: Number(m[1]) });
      await page.waitForTimeout(400);
      return;
    }
    m = /^retriage-(\d+)$/.exec(id);
    if (m) {
      const itemId = Number(m[1]);
      await expect
        .poll(() => analysisOf(w.userDataDir, itemId), { timeout: 60_000 })
        .toBe('done')
        .catch(() => undefined);
      await page.waitForTimeout(500);
      return;
    }
    if (/^show-send-/.test(id)) {
      // "Show" reveals the unsent reply in renderer memory only; a reload is the only way back to the seeded card
      await page.reload();
      await page.waitForSelector('[data-testid="app"]', { timeout: 30_000 });
    }
    if (id === 'pause-toggle') await invoke(page, 'agent:setPaused', { paused: false });
  };
}

function newCtx(w: World, test: string, lang: Lang): SweepCtx {
  return { app: w.app, page: w.page, lang, test, rows: [], consoleErrors: w.consoleErrors };
}

/**
 * Controls that change the seeded cards for good (a dismiss supersedes the card's pending actions; a restore does not bring them
 * back - see the findings) run in a SECOND pass, after every state has been swept with the cards intact.
 */
const DEFERRED = /^(dismiss-x-\d+|dismiss-\d+|sheet-dismiss-\d+|never-\d+|retriage-\d+|restore-\d+)$/;

async function run(ctx: SweepCtx, states: SweepState[], w: World): Promise<void> {
  for (const pass of [1, 2] as const) {
    for (const s of states) {
      await s.ensure().catch(() => undefined);
      const bg = await backgroundChannels(w.app, pass === 1 ? 2_500 : 1_500);
      await sweepState(ctx, s, bg, w.status, (c) => DEFERRED.test(c.testId ?? '') === (pass === 2));
    }
  }
  writeRows(ctx);
}

const DASH_EXCLUDE =
  '[data-testid="item-sheet"], [data-testid="undo-dismiss-drawer"], [data-testid="health-panel"], [role="menu"], [data-testid="calendar-week"], [data-testid="sheet-scrim"]';

function dashboardStates(w: World, cards: Cards, lang: Lang, full: boolean): SweepState[] {
  const page = w.page;
  const dash = (scheduleOnly: boolean, view: 'cards' | 'calendar' = 'cards'): Promise<void> =>
    ensureDashboard(page, { lang, scheduleOnly, view, smallId: cards.small });
  const states: SweepState[] = [
    {
      name: 'dashboard',
      scope: '[data-testid="app"]',
      exclude: DASH_EXCLUDE,
      ensure: () => dash(false),
    },
  ];
  if (!full) return states;
  const ids: Array<[string, number]> = [
    ['sched', cards.sched],
    ['missing', cards.missing],
    ['incal', cards.inCal],
    ['small', cards.small],
  ];
  for (const [tag, id] of ids) {
    states.push({
      name: `menu-${tag}`,
      scope: `[data-testid="overflow-menu-${id}"]`,
      ensure: async () => {
        if (await visible(page, `[data-testid="overflow-menu-${id}"]`)) return;
        await dash(false);
        await page.getByTestId(`overflow-${id}`).click();
        await expect(page.getByTestId(`overflow-menu-${id}`)).toBeVisible({ timeout: 5_000 });
      },
    });
  }
  for (const [tag, id] of ids) {
    states.push({
      name: `sheet-${tag}`,
      scope: '[data-testid="item-sheet"]',
      ensure: async () => {
        if (await visible(page, `[data-testid="item-sheet"] [data-testid="sheet-card-${id}"]`)) {
          await cancelOverlays(page);
          for (const trig of await page.locator('[aria-haspopup="menu"][aria-expanded="true"]').all())
            await trig.click({ timeout: 2_000 }).catch(() => undefined);
          for (const ed of await page.locator('[data-testid^="edit-event-"][aria-expanded="true"]').all())
            await ed.click({ timeout: 2_000 }).catch(() => undefined);
          return;
        }
        await dash(false);
        await page.getByTestId(`overflow-${id}`).click();
        await page.getByTestId(`overflow-menu-${id}`).getByRole('menuitem').first().click();
        await expect(page.getByTestId(`sheet-card-${id}`)).toBeVisible({ timeout: 10_000 });
      },
    });
  }
  states.push(
    {
      name: 'calendar',
      scope: '[data-testid="dash-toolbar"], [data-testid="calendar-week"]',
      ensure: () => dash(false, 'calendar'),
    },
    {
      // the week that holds the proposed / created events (the pinned app clock puts them 1-2 weeks after the real today)
      name: 'calendar-event-week',
      scope: '[data-testid="calendar-week"]',
      ensure: async () => {
        await dash(false, 'calendar');
        if (await visible(page, '[data-testid^="cal-block-"]')) return;
        await page.getByTestId('cal-today').click();
        for (let i = 0; i < 4 && (await page.locator('[data-testid^="cal-block-"]').count()) === 0; i += 1) {
          const before = await page.getByTestId('cal-range').textContent();
          await page.getByTestId('cal-next').click();
          await expect(page.getByTestId('cal-range')).not.toHaveText(before ?? '');
        }
        await expect(page.locator('[data-testid^="cal-block-"]').first()).toBeVisible({ timeout: 5_000 });
      },
    },
    {
      name: 'health',
      scope: '[data-testid="health-panel"]',
      ensure: async () => {
        if (await visible(page, '[data-testid="health-panel"]')) return;
        await dash(false);
        await page.getByTestId('health-pill').click();
        await expect(page.getByTestId('health-panel')).toBeVisible({ timeout: 5_000 });
      },
    },
    {
      name: 'undo-drawer',
      scope: '[data-testid="undo-dismiss-drawer"]',
      ensure: async () => {
        if (await visible(page, '[data-testid="undo-dismiss-drawer"]')) return;
        await dash(false);
        await page.getByTestId('undo-dismiss').click();
        await expect(page.getByTestId('undo-dismiss-drawer')).toBeVisible({ timeout: 5_000 });
      },
    },
  );
  return states;
}

function settingsStates(w: World, lang: Lang, withActivity: boolean): SweepState[] {
  const states: SweepState[] = [
    { name: 'settings', scope: '[data-testid="settings"]', ensure: () => ensureSettings(w.page, lang) },
  ];
  if (withActivity)
    states.push({
      name: 'activity',
      scope: '[data-testid="auto-activity"]',
      ensure: () => ensureSettings(w.page, lang, 'activity'),
    });
  return states;
}

// =====================================================================================================================
// (b) (e) (f) (g) (h) - dashboard, cards' menus + sheets, calendar toolbar, health panel, undo drawer (English)
// =====================================================================================================================
test('sweep: dashboard, card menus, approval sheets, calendar, health panel, undo drawer (en)', async ({ e2e }) => {
  test.setTimeout(45 * 60_000);
  const w = await launchWorld(e2e, 'sweep-dash-en', 'en');
  const cards = await seedCards(w);
  const ctx = newCtx(w, 'dashboard-en', 'en');
  ctx.after = restoreHook(w, cards.dismissed);
  // PROBE (before the sweep): which approval buttons does each seeded card offer?
  const approvalsOf = async (id: number): Promise<string[]> =>
    w.page.evaluate(
      (i) =>
        [...document.querySelectorAll(`[data-testid="card-${i}"] [data-testid]`)]
          .map((e) => e.getAttribute('data-testid') ?? '')
          .filter((t) => /^(approve-|edit-event-|save-event-|fill-form-)/.test(t)),
      id,
    );
  await ensureDashboard(w.page, { lang: 'en', scheduleOnly: false, view: 'cards', smallId: cards.small });
  const probe: Record<string, unknown> = {};
  for (const [k, id] of Object.entries(cards)) probe[`before:${k}`] = await approvalsOf(id);
  await run(ctx, dashboardStates(w, cards, 'en', true), w);
  // PROBE (after): every card went through Dismiss -> Restore in pass 2 - does it come back approvable?
  await ensureDashboard(w.page, { lang: 'en', scheduleOnly: false, view: 'cards', smallId: cards.small }).catch(
    () => undefined,
  );
  for (const [k, id] of Object.entries(cards)) probe[`after:${k}`] = await approvalsOf(id);
  probe.items = query(
    w.userDataDir,
    'SELECT id, state, closed_reason, event_state, analysis, hold_reason FROM items ORDER BY id',
  );
  probe.pendingActions = query(
    w.userDataDir,
    `SELECT item_id, kind, state FROM actions WHERE state NOT IN ('superseded') ORDER BY item_id`,
  );
  probe.updateEventCalls = w.calls('update-event');
  probe.createEventCalls = w.calls('create-event');
  writeFileSync(join(SWEEP_DIR, 'probe-dashboard-en.json'), JSON.stringify(probe, null, 1), 'utf8');
  expect(w.calls('create-event'), 'the sweep itself wrote nothing to the calendar (1 = the setup click)').toBe(1);
  expect(w.calls('update-event'), 'the sweep never undid / changed the event').toBe(0);
  expect(ctx.rows.length).toBeGreaterThan(0);
});

test('sweep: dashboard (he)', async ({ e2e }) => {
  test.setTimeout(30 * 60_000);
  const w = await launchWorld(e2e, 'sweep-dash-he', 'he');
  const cards = await seedCards(w);
  const ctx = newCtx(w, 'dashboard-he', 'he');
  ctx.after = restoreHook(w, cards.dismissed);
  await run(ctx, dashboardStates(w, cards, 'he', false), w);
  expect(w.calls('create-event')).toBe(1);
});

// =====================================================================================================================
// (c) (d) - Settings with every group expanded, the Automatic activity page
// =====================================================================================================================
for (const lang of ['en', 'he'] as const) {
  test(`sweep: settings${lang === 'en' ? ' + automatic activity' : ''} (${lang})`, async ({ e2e }) => {
    test.setTimeout(45 * 60_000);
    const w = await launchWorld(e2e, `sweep-settings-${lang}`, lang, { cli: true });
    const ctx = newCtx(w, `settings-${lang}`, lang);
    ctx.after = restoreHook(w, null);
    await run(ctx, settingsStates(w, lang, lang === 'en'), w);
    expect(w.calls('create-event')).toBe(0);
  });
}

// =====================================================================================================================
// (a) - the onboarding wizard from a fresh profile (child bridge needing a QR, fake model host, fake calendar)
// =====================================================================================================================
const HW = JSON.stringify({ ramGiB: 32, freeDiskGiB: 400, gpus: [{ name: 'NVIDIA GeForce RTX 4060', vramGiB: 8 }] });

const STEP_ROOT: Record<string, string> = {
  welcome: 'onboarding-welcome',
  choose_ai: 'onboarding-choose-ai',
  link_whatsapp: 'onboarding-link-whatsapp',
  google: 'onboarding-google',
  ready: 'onboarding-ready',
};
/** A testid only the given Google sub-step renders. */
const GOOGLE_SUB: Record<number, string> = {
  0: '[data-testid="google-start"]',
  1: '[data-testid="google-open-gcp_new_project"]',
  2: '[data-testid="google-open-gcp_oauth_consent"]',
  3: '[data-testid="google-open-gcp_create_credentials"]',
  4: '[data-testid="google-drop-zone"]',
  5: '[data-testid="google-signin"], [data-testid="google-continue"]',
};

test('sweep: onboarding wizard from a fresh profile (en)', async ({ e2e }) => {
  test.setTimeout(30 * 60_000);
  const userDataDir = e2e.newProfileDir('sweep-onboarding');
  seedProfile({ userDataDir, onboardingStep: 'welcome', tosAccepted: false, pairedAt: null });
  const controlPort = await freePort();
  const controlSecret = newBridgeToken();
  // no Google account yet: sub-step 5 offers "Sign in with Google" (the fake never completes it - no real OAuth exists here)
  const mcp = mcpChild(e2e, 'sweep-onboarding', { accounts: 'none' }, userDataDir);
  const llama = await startFakeLlamaServer({ apiKey: 'unused-in-host-mode' });
  e2e.onStop(() => llama.stop());
  const entry = (tier: 'tiny' | 'small' | 'mid') => ({
    tier,
    label: `fake-${tier}`,
    fileName: `fake-${tier}.gguf`,
    url: llama.modelUrl(),
    size: llama.modelSize,
    sha256: llama.modelSha256,
  });
  const manifest = e2e.writeTempFile(
    'sweep-model-manifest.json',
    JSON.stringify({ tiny: entry('tiny'), small: entry('small'), mid: entry('mid') }),
  );
  const cli = cliFakes(e2e, { claude: null, agy: null, label: 'sweep-onboarding', userDataDir });
  const launched = await e2e.launch({
    userDataDir,
    allowConsoleErrors: [''],
    env: {
      WCA_BRIDGE_CMD: bridgeCmdSeam(controlPort, controlSecret, 'needs_pairing'),
      ...mcp.env,
      ...cli.env,
      WCA_MODEL_MANIFEST: manifest,
      WCA_HW: HW,
      ...llamaCmdSeam(),
      WCA_TIMERS: JSON.stringify({
        scanMs: 500,
        debounceMs: 100,
        pairingPollMs: 300,
        healthPollMs: 500,
        coachMarkMs: 200,
      }),
      WCA_DIALOG_SCRIPT: '[]',
    },
  });
  const page = launched.page!;
  const consoleErrors: string[] = [];
  page.setDefaultTimeout(10_000);
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  const status = await instrument(launched.app);
  const w = { app: launched.app, page, status, consoleErrors } as unknown as World;
  const ctx: SweepCtx = { app: launched.app, page, lang: 'en', test: 'onboarding-en', rows: [], consoleErrors };
  let tosAccepted = false;

  const currentStep = async (): Promise<string | null> => {
    for (const [step, tid] of Object.entries(STEP_ROOT)) if (await visible(page, `[data-testid="${tid}"]`)) return step;
    return null;
  };
  const ensureStep = async (step: string): Promise<void> => {
    await cancelOverlays(page);
    if ((await page.evaluate(() => document.documentElement.lang)) !== 'en')
      await invoke(page, 'settings:set', { general: { language: 'en' } });
    if ((await currentStep()) === step) return;
    await invoke(page, 'onboarding:setStep', { step });
    await page.reload();
    await page.waitForSelector('[data-testid="app"]', { timeout: 30_000 });
    await expect(page.getByTestId(STEP_ROOT[step]!)).toBeVisible({ timeout: 20_000 });
  };
  const ensureGoogle = async (sub: number): Promise<void> => {
    await cancelOverlays(page);
    if ((await currentStep()) === 'google' && (await visible(page, GOOGLE_SUB[sub]!))) return;
    if ((await currentStep()) === 'google') {
      // back to sub-step 0 the honest way: a reload re-mounts the wizard at its intro
      await page.reload();
      await page.waitForSelector('[data-testid="app"]', { timeout: 30_000 });
    } else await ensureStep('google');
    await expect(page.getByTestId('google-start')).toBeVisible({ timeout: 20_000 });
    if (sub === 0) return;
    await page.getByTestId('google-start').click();
    for (let i = 1; i < sub; i += 1) {
      if (i === 4) {
        // sub-step 4 -> 5 needs an accepted client file: the TESTONLY fixture, imported the way the drop zone would send it
        await invoke(page, 'google:importCredentials', { jsonText: JSON.stringify(TESTONLY_GOOGLE_CREDENTIALS) });
        await expect(page.getByTestId('google-next')).toBeEnabled({ timeout: 15_000 });
      }
      await page.getByTestId('google-next').click();
    }
    await expect(page.locator(GOOGLE_SUB[sub]!).first()).toBeVisible({ timeout: 10_000 });
  };

  const scope = '[data-testid="onboarding"]';
  const states: SweepState[] = [
    { name: 'onb-welcome', scope: `${scope}, header`, ensure: () => ensureStep('welcome') },
    {
      name: 'onb-choose-ai',
      scope,
      ensure: async () => {
        if (!tosAccepted) {
          // SETUP: the user accepts the WhatsApp disclosure once (it is what starts the bridge child)
          await ensureStep('welcome');
          await page.getByTestId('welcome-accept').check();
          await page.getByTestId('welcome-start').click();
          await expect(page.getByTestId('onboarding-choose-ai')).toBeVisible({ timeout: 20_000 });
          tosAccepted = true;
        }
        await ensureStep('choose_ai');
      },
    },
    { name: 'onb-link-whatsapp', scope, ensure: () => ensureStep('link_whatsapp') },
    {
      // the QR expired (fake bridge control: setPairing timeout) - "New code" is offered
      name: 'onb-link-expired',
      scope,
      ensure: async () => {
        await ensureStep('link_whatsapp');
        if (await visible(page, '[data-testid="qr-new-code"]')) return;
        await waitForControl(controlPort, controlSecret, 30_000);
        await control(controlPort, controlSecret, 'setPairing', { phase: 'timeout' });
        await expect(page.getByTestId('qr-new-code').first()).toBeVisible({ timeout: 30_000 });
      },
    },
    {
      // pairing succeeded (setPairing connected) - "Continue" is offered
      name: 'onb-link-connected',
      scope,
      ensure: async () => {
        await ensureStep('link_whatsapp');
        if (await visible(page, '[data-testid="qr-connected"]')) return;
        await waitForControl(controlPort, controlSecret, 30_000);
        await control(controlPort, controlSecret, 'setPairing', { phase: 'connected' });
        await expect(page.getByTestId('qr-connected')).toBeVisible({ timeout: 30_000 });
      },
    },
    ...[0, 1, 2, 3, 4, 5].map((n) => ({ name: `onb-google-${n}`, scope, ensure: () => ensureGoogle(n) })),
    { name: 'onb-ready', scope, ensure: () => ensureStep('ready') },
  ];
  await run(ctx, states, w);
  expect(ctx.rows.length).toBeGreaterThan(0);
});
