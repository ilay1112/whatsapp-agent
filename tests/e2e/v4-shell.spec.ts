// tests/e2e/v4-shell.spec.ts - T-908 group A (docs/specs/v4-calendar-handover.md 2.2 sticky shell, 2.3 theme; review focus 4).
//
// (1) Sticky shell, en + he, at the 420 px minimum and at a wide size: after every scroller of the view is driven to its end,
//     the header and the dashboard toolbar have not moved (Settings: the header and the section nav), and nothing scrolls
//     horizontally. A tall test-only spacer is appended to the scrolling region first, so the assertion is about a view that
//     REALLY scrolls, not one that happens to fit; it is removed again before React touches the region.
// (2) Theme: with the OS (emulated) LIGHT, choosing Dark in the header paints the dashboard, the calendar and Settings dark -
//     including every sticky background (header, toolbar, column headers, settings nav) - and main mirrors it into
//     nativeTheme.themeSource; with the OS DARK, choosing Light paints light. Screenshots go to test-results/screens/ for the
//     user's review (never pixel-compared).
import type { Page } from '@playwright/test';
import { attachBridge } from './helpers/fakes.ts';
import { expect, test, type E2eContext, type LaunchedApp } from './helpers/fixtures.ts';
import { SEED_CHAT_JID, SEED_CHAT_NAME, seedProfile } from './helpers/seedProfile.ts';
import { backToDashboard, openSettings } from './helpers/v2.ts';

const NARROW = { width: 420, height: 560 } as const;
const WIDE = { width: 1100, height: 760 } as const;
const SPACER_ID = 'v4-shell-spacer';
const NAV = '[data-testid="settings"] nav';

async function launchDone(e2e: E2eContext, name: string): Promise<LaunchedApp> {
  const userDataDir = e2e.newProfileDir(name);
  seedProfile({
    userDataDir,
    onboardingStep: 'done',
    settings: { language: 'en' },
    chats: [{ jid: SEED_CHAT_JID, name: SEED_CHAT_NAME }],
  });
  const bridge = await attachBridge(e2e, userDataDir);
  return e2e.launch({ userDataDir, env: bridge.env });
}

/** Resizes the real BrowserWindow (the renderer's own viewport, not a browser emulation). */
async function setContentSize(launched: LaunchedApp, size: { width: number; height: number }): Promise<void> {
  await launched.app.evaluate(
    async ({ BrowserWindow }, s) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win === undefined) throw new Error('no window to resize');
      win.setContentSize(s.width, s.height);
      await new Promise((r) => setTimeout(r, 250));
    },
    { width: size.width, height: size.height },
  );
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** Appends a tall spacer at the end of `selector` (test-only DOM, removed by `removeSpacer`). */
async function addSpacer(page: Page, selector: string): Promise<void> {
  await page.evaluate(
    ({ selector: sel, id }) => {
      const host = document.querySelector(sel);
      if (host === null) throw new Error(`no ${sel}`);
      const spacer = document.createElement('div');
      spacer.id = id;
      spacer.setAttribute('aria-hidden', 'true');
      spacer.style.blockSize = '2400px';
      spacer.style.flexShrink = '0';
      host.appendChild(spacer);
    },
    { selector, id: SPACER_ID },
  );
}

async function removeSpacer(page: Page): Promise<void> {
  await page.evaluate((id) => document.getElementById(id)?.remove(), SPACER_ID);
}

/** Drives EVERY vertical scroller of the page (and the document) to its end; returns how many really moved. */
async function scrollEverythingToBottom(page: Page): Promise<number> {
  const moved = await page.evaluate(() => {
    let count = 0;
    for (const el of [document.scrollingElement, ...document.querySelectorAll('*')]) {
      if (!(el instanceof Element) || el.scrollHeight <= el.clientHeight + 1) continue;
      const before = el.scrollTop;
      el.scrollTop = el.scrollHeight;
      if (el.scrollTop !== before) count += 1;
    }
    return count;
  });
  await page.waitForTimeout(150); // one frame for sticky layout
  return moved;
}

async function scrollEverythingToTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of [document.scrollingElement, ...document.querySelectorAll('*')]) {
      if (el instanceof Element && el.scrollTop !== 0) el.scrollTop = 0;
    }
  });
}

async function boxOf(page: Page, testIdOrSelector: string): Promise<{ y: number; height: number }> {
  const locator = /[[\s.#>]/.test(testIdOrSelector)
    ? page.locator(testIdOrSelector).first()
    : page.getByTestId(testIdOrSelector);
  const box = await locator.boundingBox();
  expect(box, `${testIdOrSelector} is laid out`).not.toBeNull();
  // Block axis only: "stays put" means the same vertical position and height. The inline size legitimately shrinks by the
  // scrollbar width when the region under it starts to overflow (and in RTL the scrollbar sits on the inline-start side).
  return { y: Math.round(box!.y), height: Math.round(box!.height) };
}

/** Relative luminance (0 = black, 1 = white) of an element's computed background colour; null when transparent. */
async function backgroundLuminance(page: Page, selector: string): Promise<number | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`no ${sel}`);
    const m = getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/);
    if (m === null) return null;
    const [r, g, b, a] = m[1]!
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (a === 0) return null;
    const lin = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
  }, selector);
}

/** Luminance of the first OPAQUE background at or above `selector` (what the user actually sees behind it). */
async function effectiveLuminance(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    let el: Element | null = document.querySelector(sel);
    if (el === null) throw new Error(`no ${sel}`);
    for (; el !== null; el = el.parentElement) {
      const m = getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/);
      if (m === null) continue;
      const [r, g, b, a] = m[1]!
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      if (a === 0) continue;
      const lin = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
    }
    return 1; // nothing opaque: the browser's default (white) canvas shows through
  }, selector);
}

async function expectDark(page: Page, selectors: string[]): Promise<void> {
  for (const sel of selectors) {
    const l = await backgroundLuminance(page, sel);
    expect(l, `${sel} has an opaque background`).not.toBeNull();
    expect(l!, `${sel} is painted dark (no light leak)`).toBeLessThan(0.1);
  }
}

async function switchLanguage(page: Page, lang: 'en' | 'he'): Promise<void> {
  await page.locator(`[data-testid="lang-toggle"] [data-lang="${lang}"]`).click();
  await expect(page.locator('html')).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
}

// ---------------------------------------------------------------------------------------------------------------------
// (1) sticky shell
// ---------------------------------------------------------------------------------------------------------------------

test('v4 shell: header and dashboard toolbar stay put while the dashboard scrolls (en + he, 420 px and wide)', async ({
  e2e,
}) => {
  test.setTimeout(180_000);
  const launched = await launchDone(e2e, 'v4-shell');
  const page = launched.page;
  expect(page).not.toBeNull();
  if (page === null) return;
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.getByTestId('app-scroll')).toBeVisible();

  for (const lang of ['en', 'he'] as const) {
    await switchLanguage(page, lang);
    for (const size of [NARROW, WIDE]) {
      await setContentSize(launched, size);
      const tag = `${lang}-${size.width}`;
      await scrollEverythingToTop(page);
      const header = await boxOf(page, 'header[role="banner"]');
      const toolbar = await boxOf(page, 'dash-toolbar');
      if (size === NARROW) await e2e.screenshot(page, `shell-${lang}-top`);

      await addSpacer(page, '[data-testid="dashboard"]');
      const moved = await scrollEverythingToBottom(page);
      expect(moved, `[${tag}] something really scrolled`).toBeGreaterThan(0);
      expect(await boxOf(page, 'header[role="banner"]'), `[${tag}] the header did not move`).toEqual(header);
      expect(await boxOf(page, 'dash-toolbar'), `[${tag}] the dashboard toolbar did not move`).toEqual(toolbar);
      expect(await horizontalOverflow(page), `[${tag}] no horizontal scroll`).toBeLessThanOrEqual(0);
      if (size === NARROW) await e2e.screenshot(page, `shell-${lang}-bottom`);
      await removeSpacer(page);
      await scrollEverythingToTop(page);
    }
  }
});

test('v4 shell: the Settings section nav and the header stay put while the page scrolls (en + he, wide)', async ({
  e2e,
}) => {
  test.setTimeout(120_000);
  const launched = await launchDone(e2e, 'v4-shell-settings');
  const page = launched.page;
  expect(page).not.toBeNull();
  if (page === null) return;
  await setContentSize(launched, WIDE);

  for (const lang of ['en', 'he'] as const) {
    await switchLanguage(page, lang);
    await openSettings(page);
    await scrollEverythingToTop(page);
    const nav = page.getByTestId('settings').getByRole('navigation');
    await expect(nav).toBeVisible();
    const header = await boxOf(page, 'header[role="banner"]');
    const navBox = await boxOf(page, NAV);

    const moved = await scrollEverythingToBottom(page);
    expect(moved, `[${lang}] the settings page really scrolled`).toBeGreaterThan(0);
    expect(
      await page.getByTestId('app-scroll').evaluate((el) => el.scrollTop),
      `[${lang}] the app scroller is the one that moved`,
    ).toBeGreaterThan(0);
    expect(await boxOf(page, 'header[role="banner"]'), `[${lang}] the header did not move`).toEqual(header);
    expect(await boxOf(page, NAV), `[${lang}] the section nav did not move`).toEqual(navBox);
    expect(await horizontalOverflow(page), `[${lang}] no horizontal scroll`).toBeLessThanOrEqual(0);
    await scrollEverythingToTop(page);
    await backToDashboard(page);
  }

  // At 420 px the nav is hidden; the page still scrolls under a fixed header without horizontal scroll.
  await setContentSize(launched, NARROW);
  await openSettings(page);
  const header = await boxOf(page, 'header[role="banner"]');
  await scrollEverythingToBottom(page);
  expect(await boxOf(page, 'header[role="banner"]'), 'the header did not move at 420 px').toEqual(header);
  expect(await horizontalOverflow(page), 'no horizontal scroll in Settings at 420 px').toBeLessThanOrEqual(0);
});

// ---------------------------------------------------------------------------------------------------------------------
// (2) theme (review focus 4)
// ---------------------------------------------------------------------------------------------------------------------

test('v4 theme: Dark over a light OS paints dashboard, calendar and Settings dark; Light over a dark OS paints light', async ({
  e2e,
}) => {
  test.setTimeout(180_000);
  const launched = await launchDone(e2e, 'v4-theme');
  const page = launched.page;
  expect(page).not.toBeNull();
  if (page === null) return;
  await setContentSize(launched, WIDE);
  await expect(page.getByTestId('theme-toggle')).toBeVisible();
  await expect(page.getByTestId('theme-toggle')).toHaveAttribute('data-value', 'system');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);

  // ---- OS light, theme Dark ------------------------------------------------------------------------------------------
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByTestId('theme-dark').click();
  await expect(page.getByTestId('theme-toggle')).toHaveAttribute('data-value', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect
    .poll(() => launched.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), { timeout: 10_000 })
    .toBe('dark');

  // dashboard (wide cards, then the narrow stacked layout whose column headers are sticky)
  await expectDark(page, ['body', '[data-testid="app"]', 'header[role="banner"]', '[data-testid="dash-toolbar"]']);
  await e2e.screenshot(page, 'theme-dark-dashboard');
  await setContentSize(launched, NARROW);
  await expect(page.getByTestId('dashboard')).toHaveAttribute('data-layout', 'narrow');
  await expectDark(page, ['[data-testid="dash-toolbar"]', '[data-testid="dashboard"] .dash-column > h2']);
  await setContentSize(launched, WIDE);

  // calendar
  await page.getByTestId('view-calendar').click();
  await expect(page.getByTestId('calendar-week')).toBeVisible();
  await expectDark(page, ['[data-testid="dash-toolbar"]']);
  expect(await effectiveLuminance(page, '[data-testid="cal-grid"]'), 'the week grid is dark').toBeLessThan(0.1);
  expect(await effectiveLuminance(page, '[data-testid="calendar-week"]'), 'the calendar view is dark').toBeLessThan(
    0.1,
  );
  await e2e.screenshot(page, 'theme-dark-calendar');
  await page.getByTestId('view-cards').click();

  // settings (the radio row reflects the header choice)
  await openSettings(page);
  await expect(page.getByTestId('settings-theme-dark')).toBeChecked();
  await expectDark(page, ['body', 'header[role="banner"]', '[data-testid="app"]']);
  const navBg = await backgroundLuminance(page, '[data-testid="settings"] nav');
  expect(navBg === null || navBg < 0.1, 'the sticky settings nav has no light background').toBe(true);
  await e2e.screenshot(page, 'theme-dark-settings');

  // ---- the choice survives a restart, and main applies it before the first frame -------------------------------------
  // (OS dark, theme Light) - chosen in Settings this time
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByTestId('settings-theme-light').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect
    .poll(() => launched.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), { timeout: 10_000 })
    .toBe('light');
  await backToDashboard(page);
  const bodyLight = await backgroundLuminance(page, 'body');
  expect(bodyLight!, 'Light wins over a dark OS').toBeGreaterThan(0.7);
  const toolbarLight = await backgroundLuminance(page, '[data-testid="dash-toolbar"]');
  expect(toolbarLight!, 'the sticky toolbar is light too').toBeGreaterThan(0.7);
  await e2e.screenshot(page, 'theme-light-dashboard');

  // back to System: the attribute goes, the (emulated dark) OS decides again
  await page.getByTestId('theme-system').click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  await expect
    .poll(() => launched.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), { timeout: 10_000 })
    .toBe('system');
  await expectDark(page, ['body']);
});
