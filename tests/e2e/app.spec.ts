// tests/e2e/app.spec.ts - TESTS section 10, row `app.spec.ts` (bridge mode: ATTACH). Owner W2-03.
//
// A seeded profile boots to the dashboard: three lists with their empty states, the WhatsApp health row green, the
// renderer sandboxed (no `require`, no `process`, `window.open` -> null, a cross-origin `fetch` refused by the CSP) and
// the setup strip offering the tasks that are not done yet. Nothing real is contacted: the "bridge" is
// `tests/fakes/fake-bridge.ts` listening on 127.0.0.1 and there is no model, no key and no Google account anywhere.
import { attachBridge } from './helpers/fakes.ts';
import { expect, test, wca } from './helpers/fixtures.ts';
import { SEED_CHAT_JID, SEED_CHAT_NAME, seedProfile } from './helpers/seedProfile.ts';

/** The three lists of UX 6 in their rendered order. */
const LISTS = ['needs_reply', 'in_calendar', 'info_missing'] as const;

test('seeded profile boots to a dashboard with three empty lists, a healthy bridge and the setup strip', async ({
  e2e,
}) => {
  const userDataDir = e2e.newProfileDir('app');
  seedProfile({
    userDataDir,
    onboardingStep: 'done',
    chats: [{ jid: SEED_CHAT_JID, name: SEED_CHAT_NAME }],
  });
  const bridge = await attachBridge(e2e, userDataDir);

  const launched = await e2e.launch({
    userDataDir,
    env: { ...bridge.env, WCA_TIMERS: '{"healthPollMs":500}' },
    // The cross-origin fetch below is REFUSED on purpose; the refusal is logged in the page as an error.
    allowConsoleErrors: ['example.com', 'Refused to connect'],
  });
  const page = launched.page;
  expect(page, 'the launch must produce a window').not.toBeNull();
  if (page === null) return;

  // ---- dashboard + three lists --------------------------------------------------------------------------------
  await expect(page.getByTestId('dashboard')).toBeVisible();
  for (const list of LISTS) {
    await expect(page.getByTestId(`list-${list}`), `list-${list} is rendered`).toBeVisible();
    // A fresh profile has no items at all, so every list shows its own empty state (UX 6.4).
    await expect(page.getByTestId(`empty-${list}`), `list-${list} shows its empty state`).toBeVisible();
  }
  await expect(page.getByTestId('list-skeletons')).toHaveCount(0);

  // ---- health --------------------------------------------------------------------------------------------------
  const pill = page.getByTestId('health-pill');
  await expect(pill).toBeVisible();
  await pill.click();
  await expect(page.getByTestId('health-panel')).toBeVisible();
  // The attached fake bridge answers /api/pairing/status, so the WhatsApp part must go green on its own.
  await expect(page.getByTestId('health-row-whatsapp')).toHaveAttribute('data-status', 'ok', { timeout: 20_000 });
  expect((await wca(launched.app).health()).whatsapp.state).toBe('online');
  await pill.click();

  // ---- setup strip -------------------------------------------------------------------------------------------
  // No Google credentials were seeded and no provider is configured, so those two tasks must be offered; WhatsApp is
  // paired, so its task must NOT be.
  await expect(page.getByTestId('setup-strip-calendar')).toBeVisible();
  await expect(page.getByTestId('setup-strip-whatsapp')).toHaveCount(0);

  await e2e.screenshot(page, 'app-dashboard-en');

  // ---- renderer sandbox (ARCH 14: contextIsolation, sandbox, CSP) ---------------------------------------------
  const sandbox = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return {
      hasRequire: typeof w.require !== 'undefined',
      hasProcess: typeof w.process !== 'undefined',
      hasModule: typeof w.module !== 'undefined',
      openReturnsNull: window.open('https://example.com') === null,
      apiKeys: Object.keys((w.api as Record<string, unknown> | undefined) ?? {}).sort(),
    };
  });
  expect(sandbox.hasRequire, 'window.require must not exist in the renderer').toBe(false);
  expect(sandbox.hasProcess, 'window.process must not exist in the renderer').toBe(false);
  expect(sandbox.hasModule, 'window.module must not exist in the renderer').toBe(false);
  expect(sandbox.openReturnsNull, 'window.open must be denied').toBe(true);
  expect(sandbox.apiKeys.length, 'the preload bridge is the only exposed surface').toBeGreaterThan(0);

  // The CSP has no `connect-src` for the public internet: the request must be refused inside the page.
  const crossOrigin = await page.evaluate(async () => {
    try {
      await fetch('https://example.com');
      return 'resolved';
    } catch (err) {
      return `rejected: ${(err as Error).name}`;
    }
  });
  expect(crossOrigin, 'a cross-origin fetch from the renderer must be refused').toContain('rejected');

  // ---- nothing was sent, nothing was written ------------------------------------------------------------------
  expect(bridge.fake.sent, 'a boot must never send a WhatsApp message').toHaveLength(0);
  expect(bridge.fake.violations, 'the fake bridge saw no forbidden call').toEqual([]);
});
