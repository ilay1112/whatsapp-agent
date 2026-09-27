// tests/e2e/i18n-rtl.spec.ts - TESTS section 9, row "E2E" (bridge mode: ATTACH). Owner W2-03.
//
// The language toggle in the header flips `<html dir>` WITHOUT a reload, the main process follows (the tray template is
// rebuilt in the new language), the choice survives a restart on the same profile, a Hebrew profile lays out towards the
// inline-start (= the right edge) and neither language scrolls horizontally at the 420 px minimum width. Every view is
// screenshotted in both languages into test-results/screens/ for the user's own Hebrew review (never pixel-compared).
import { attachBridge } from './helpers/fakes.ts';
import { expect, test, wca, type LaunchedApp } from './helpers/fixtures.ts';
import { SEED_CHAT_JID, SEED_CHAT_NAME, seedProfile } from './helpers/seedProfile.ts';

const MIN_WIDTH = 420;
const MIN_HEIGHT = 560;

/** Labels of the tray menu, in order, ignoring separators. */
function labelsOf(template: Array<{ id: string; label?: string }>): string[] {
  return template.filter((i) => i.id !== 'sep' && typeof i.label === 'string').map((i) => i.label as string);
}

test('the header toggle flips dir without a reload and the choice survives a restart', async ({ e2e }) => {
  const userDataDir = e2e.newProfileDir('i18n');
  seedProfile({
    userDataDir,
    onboardingStep: 'done',
    settings: { language: 'en' },
    chats: [{ jid: SEED_CHAT_JID, name: SEED_CHAT_NAME }],
  });
  const bridge = await attachBridge(e2e, userDataDir);

  const first = await e2e.launch({ userDataDir, env: bridge.env });
  const page = first.page;
  expect(page).not.toBeNull();
  if (page === null) return;

  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

  // A value that only survives if the document is NOT reloaded by the language switch.
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__noReloadMarker = 'kept';
  });

  await page.locator('[data-testid="lang-toggle"] [data-lang="he"]').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'he');
  expect(
    await page.evaluate(() => (window as unknown as Record<string, unknown>).__noReloadMarker),
    'switching language must not reload the renderer',
  ).toBe('kept');

  await e2e.quit(first);

  // ---- the setting persisted in app.db, not in renderer memory ------------------------------------------------
  const second = await e2e.launch({ userDataDir, env: bridge.env });
  const page2 = second.page;
  expect(page2).not.toBeNull();
  if (page2 === null) return;
  await expect(page2.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page2.locator('[data-testid="lang-toggle"]')).toHaveAttribute('data-value', 'he');
});

// TESTS 9 row "E2E": "tray template labels flip (`__wcaTest.trayTemplate()`)".
// RED against the current tree, and the defect is real, not a test artefact: `compose()` rebuilds its main-process
// i18next instance and emits `language`, but `src/main/index.ts` (W2-01) rebuilds the tray only on `health` and
// `pairing`, so the menu keeps the labels it was built with until some other event happens to rebuild it.
// See REQUESTS in ops/agent-notes/W2-03-e2e.md - the fix is one line in index.ts.
test('a language change reaches the tray menu in the main process', async ({ e2e }) => {
  const userDataDir = e2e.newProfileDir('i18n-tray');
  seedProfile({ userDataDir, onboardingStep: 'done', settings: { language: 'en' } });
  const bridge = await attachBridge(e2e, userDataDir);
  const launched = await e2e.launch({ userDataDir, env: bridge.env });
  const page = launched.page;
  expect(page).not.toBeNull();
  if (page === null) return;

  const enTray = labelsOf(await wca(launched.app).trayTemplate());
  expect(enTray.length, 'the tray menu has Open / status / Pause / Settings / Quit').toBe(5);

  await page.locator('[data-testid="lang-toggle"] [data-lang="he"]').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  await expect
    .poll(async () => labelsOf(await wca(launched.app).trayTemplate()).join('|'), { timeout: 10_000 })
    .not.toBe(enTray.join('|'));
  const heTray = labelsOf(await wca(launched.app).trayTemplate());
  expect(heTray).toHaveLength(enTray.length);
  for (const label of heTray) expect(label.trim().length, 'no empty tray label in Hebrew').toBeGreaterThan(0);
  expect(
    heTray.some((l) => /[֐-׿]/.test(l)),
    'the tray menu is rendered in Hebrew',
  ).toBe(true);
});

test('a Hebrew dashboard lays out towards the right and neither language scrolls horizontally at 420 px', async ({
  e2e,
}) => {
  const userDataDir = e2e.newProfileDir('rtl');
  seedProfile({
    userDataDir,
    onboardingStep: 'done',
    settings: { language: 'he' },
    chats: [{ jid: SEED_CHAT_JID, name: SEED_CHAT_NAME }],
  });
  const bridge = await attachBridge(e2e, userDataDir);
  const launched = await e2e.launch({ userDataDir, env: bridge.env });
  const page = launched.page;
  expect(page).not.toBeNull();
  if (page === null) return;

  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await setContentSize(launched, MIN_WIDTH, MIN_HEIGHT);

  // Inline-start is the RIGHT edge in RTL: the list heading must sit in the right half of the viewport.
  const box = await page.getByTestId('list-needs_reply').boundingBox();
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  expect(box, 'the first list is laid out').not.toBeNull();
  if (box !== null) {
    expect(box.x + box.width, 'the RTL list reaches the inline-start (right) edge').toBeGreaterThan(width * 0.75);
  }
  expect(await horizontalOverflow(launched), 'no horizontal scrollbar in Hebrew at 420 px').toBe(0);

  await e2e.screenshot(page, 'dashboard-he-420');

  await page.locator('[data-testid="lang-toggle"] [data-lang="en"]').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  expect(await horizontalOverflow(launched), 'no horizontal scrollbar in English at 420 px').toBe(0);
});

test('every view is screenshotted in both languages for the Hebrew review', async ({ e2e }) => {
  // (a) the configured app: dashboard + settings.
  const userDataDir = e2e.newProfileDir('screens');
  seedProfile({
    userDataDir,
    onboardingStep: 'done',
    settings: { language: 'en' },
    chats: [{ jid: SEED_CHAT_JID, name: SEED_CHAT_NAME }],
  });
  const bridge = await attachBridge(e2e, userDataDir);
  const launched = await e2e.launch({ userDataDir, env: bridge.env });
  const page = launched.page;
  expect(page).not.toBeNull();
  if (page === null) return;

  for (const lang of ['en', 'he'] as const) {
    await page.locator(`[data-testid="lang-toggle"] [data-lang="${lang}"]`).click();
    await expect(page.locator('html')).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');

    await expect(page.getByTestId('dashboard')).toBeVisible();
    await e2e.screenshot(page, `dashboard-${lang}`);

    await page.getByTestId('settings-toggle').click();
    await expect(page.getByTestId('settings')).toBeVisible();
    await e2e.screenshot(page, `settings-${lang}`);
    // Health panel over the settings view - the one overlay that exists without any item.
    await page.getByTestId('health-pill').click();
    await expect(page.getByTestId('health-panel')).toBeVisible();
    await e2e.screenshot(page, `health-panel-${lang}`);
    await page.getByTestId('health-pill').click();

    await page.getByTestId('settings-toggle').click();
    await expect(page.getByTestId('dashboard')).toBeVisible();
  }
  await e2e.quit(launched);

  // (b) the fresh app: every onboarding step that is reachable without a model, a key or an account.
  const freshDir = e2e.newProfileDir('screens-onboarding');
  seedProfile({ userDataDir: freshDir, onboardingStep: 'welcome', tosAccepted: false, pairedAt: null });
  const fresh = await e2e.launch({ userDataDir: freshDir });
  const freshPage = fresh.page;
  expect(freshPage).not.toBeNull();
  if (freshPage === null) return;

  await expect(freshPage.getByTestId('onboarding')).toBeVisible();
  for (const lang of ['en', 'he'] as const) {
    await freshPage.locator(`[data-testid="welcome-language-${lang}"]`).click();
    await expect(freshPage.locator('html')).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
    await e2e.screenshot(freshPage, `onboarding-welcome-${lang}`);
  }
});

/** Resizes the real BrowserWindow (the renderer's own viewport, not a browser emulation). */
async function setContentSize(launched: LaunchedApp, width: number, height: number): Promise<void> {
  await launched.app.evaluate(
    async ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win === undefined) throw new Error('no window to resize');
      win.setContentSize(size.width, size.height);
      await new Promise((r) => setTimeout(r, 250));
    },
    { width, height },
  );
}

/** `scrollWidth - clientWidth` of the document: anything > 0 is a horizontal scrollbar. */
async function horizontalOverflow(launched: LaunchedApp): Promise<number> {
  const page = launched.page;
  if (page === null) return 0;
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}
