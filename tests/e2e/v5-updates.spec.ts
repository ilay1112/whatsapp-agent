// tests/e2e/v5-updates.spec.ts - T-909 W3 (docs/specs/v5-updates-handover.md 2.3; review focus 3 + 4).
//
// The app talks to the FAKE GitHub Releases host only (tests/fakes/fake-github-releases.ts through the WCA_UPDATE_BASE_URL seam;
// both seam locks apply). The e2e app is unpackaged (`electron .`, version 0.1.0 from package.json), so `canInstall` is false:
// the updater is never spawned, and the spawn journal (WCA_UPDATE_SPAWN_JOURNAL) must stay empty.
//
// (1) A newer release -> banner -> X (= update:ignore 0.1.9, persisted in main) -> gone -> relaunch -> still gone (Settings
//     offers "Show version 0.1.9 again") -> 0.1.10 is published -> relaunch -> the banner is back.
// (2) Settings > Updates: Check now -> "Download and install" shown but DISABLED with the devOnly line (a dev copy never
//     downloads from the UI) -> update:download invoked directly -> ready (sha256 + unzip verified by main) -> Install disabled,
//     the footer offers "Restart to update", a direct update:install is refused and nothing was spawned.
// Screenshots (never pixel-compared): update-banner-{en,he}.png, settings-updates-{en,he}.png in test-results/screens/.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { startFakeGithubReleases, type FakeGithubReleases } from '../fakes/fake-github-releases.ts';
import { attachBridge } from './helpers/fakes.ts';
import { expect, test, type E2eContext, type LaunchedApp } from './helpers/fixtures.ts';
import { SEED_CHAT_JID, SEED_CHAT_NAME, seedProfile } from './helpers/seedProfile.ts';
import { backToDashboard, openSettings } from './helpers/v2.ts';

const APP_VERSION = '0.1.0'; // package.json; the e2e app runs unpackaged
const FIRST_CHECK = JSON.stringify({ updateFirstCheckMs: 500 });

interface World {
  userDataDir: string;
  env: Record<string, string>;
  gh: FakeGithubReleases;
  journal: string;
}

async function world(e2e: E2eContext, name: string, opts: { firstCheck: boolean }): Promise<World> {
  const userDataDir = e2e.newProfileDir(name);
  seedProfile({
    userDataDir,
    onboardingStep: 'done',
    settings: { language: 'en' },
    chats: [{ jid: SEED_CHAT_JID, name: SEED_CHAT_NAME }],
  });
  const bridge = await attachBridge(e2e, userDataDir);
  const gh = await startFakeGithubReleases({ version: '0.1.9' });
  e2e.onStop(() => gh.stop());
  const journal = join(e2e.root, `${name}-update-spawn.jsonl`);
  const env: Record<string, string> = {
    ...bridge.env,
    WCA_UPDATE_BASE_URL: gh.url,
    WCA_UPDATE_SPAWN_JOURNAL: journal,
  };
  if (opts.firstCheck) env.WCA_TIMERS = FIRST_CHECK;
  return { userDataDir, env, gh, journal };
}

async function switchLanguage(page: Page, lang: 'en' | 'he'): Promise<void> {
  await page.locator(`[data-testid="lang-toggle"] [data-lang="${lang}"]`).click();
  await expect(page.locator('html')).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
}

/** Every request the app made to the fake host: version-only User-Agent, no Authorization header. */
function expectVersionOnlyRequests(gh: FakeGithubReleases): void {
  expect(gh.requests.length).toBeGreaterThan(0);
  for (const r of gh.requests) {
    expect(r.userAgent, r.path).toBe(`WhatsAppCalendarAgent/${APP_VERSION}`);
    expect(r.hasAuthorization, r.path).toBe(false);
  }
}

function expectNothingSpawned(journal: string): void {
  const lines = existsSync(journal) ? readFileSync(journal, 'utf8').trim() : '';
  expect(lines, 'the updater was never spawned').toBe('');
}

/** Waits for one more /releases/latest request than `before` (the automatic first check of a launch). */
async function waitForCheck(gh: FakeGithubReleases, before: number): Promise<void> {
  await expect
    .poll(() => gh.requests.filter((r) => r.path.endsWith('/releases/latest')).length, { timeout: 20_000 })
    .toBeGreaterThan(before);
}
const latestCalls = (gh: FakeGithubReleases) => gh.requests.filter((r) => r.path.endsWith('/releases/latest')).length;

test('v5 updates: banner -> X ignores 0.1.9 across a relaunch -> 0.1.10 brings it back', async ({ e2e }) => {
  test.setTimeout(240_000);
  const w = await world(e2e, 'v5-banner', { firstCheck: true });

  // ---- launch 1: the automatic first check finds 0.1.9 ----
  let launched: LaunchedApp = await e2e.launch({ userDataDir: w.userDataDir, env: w.env });
  let page = launched.page!;
  const banner = page.getByTestId('update-banner');
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await expect(banner).toHaveAttribute('data-state', 'available');
  await expect(banner).toContainText('Version 0.1.9 is ready');
  // the banner sits in the shell's fixed block, not inside the one scroller
  expect(await page.locator('[data-testid="app-scroll"] [data-testid="update-banner"]').count()).toBe(0);
  await expect(page.getByTestId('app-version')).toContainText(APP_VERSION);
  await e2e.screenshot(page, 'update-banner-en');
  await switchLanguage(page, 'he');
  await expect(banner).toContainText('גרסה 0.1.9 מוכנה');
  await e2e.screenshot(page, 'update-banner-he');
  await switchLanguage(page, 'en');

  // X = ignore THIS version (persisted in main)
  await page.getByTestId('update-banner-ignore').click();
  await expect(banner).toBeHidden();
  await e2e.quit(launched);

  // ---- launch 2: same release, still ignored ----
  let before = latestCalls(w.gh);
  launched = await e2e.launch({ userDataDir: w.userDataDir, env: w.env });
  page = launched.page!;
  await waitForCheck(w.gh, before);
  await openSettings(page);
  const unignore = page.getByTestId('settings-update-unignore');
  await expect(unignore).toBeVisible({ timeout: 10_000 });
  await expect(unignore).toContainText('Show version 0.1.9 again');
  await expect(page.getByTestId('settings-update-latest')).toContainText('0.1.9');
  await backToDashboard(page);
  await expect(page.getByTestId('update-banner')).toHaveCount(0);
  await e2e.quit(launched);

  // ---- launch 3: a newer release than the ignored one -> the banner is back ----
  w.gh.publish('0.1.10');
  before = latestCalls(w.gh);
  launched = await e2e.launch({ userDataDir: w.userDataDir, env: w.env });
  page = launched.page!;
  await waitForCheck(w.gh, before);
  await expect(page.getByTestId('update-banner')).toContainText('Version 0.1.10 is ready', { timeout: 20_000 });

  // "Show version 0.1.9 again" clears the ignore (Settings)
  await openSettings(page);
  await page.getByTestId('settings-update-unignore').click();
  await expect(page.getByTestId('settings-update-unignore')).toHaveCount(0);
  await e2e.quit(launched);

  expectVersionOnlyRequests(w.gh);
  expectNothingSpawned(w.journal);
});

test('v5 updates: Settings Check now -> Download -> ready; Install stays disabled in a dev copy, nothing spawned', async ({
  e2e,
}) => {
  test.setTimeout(240_000);
  // No first-check seam: the 30 s automatic check must not race the manual one (Check now is the first real check).
  const w = await world(e2e, 'v5-settings', { firstCheck: false });
  const launched = await e2e.launch({ userDataDir: w.userDataDir, env: w.env });
  const page = launched.page!;

  await openSettings(page);
  const group = page.getByTestId('settings-group-updates');
  await group.scrollIntoViewIfNeeded();
  await expect(page.getByTestId('settings-update-current')).toContainText(APP_VERSION);
  await expect(page.getByTestId('settings-update-devonly')).toBeVisible();
  await expect(page.getByTestId('settings-update-privacy')).toContainText('github.com');

  await page.getByTestId('settings-update-check').click();
  const install = page.getByTestId('settings-update-install');
  await expect(install).toHaveText('Download and install', { timeout: 20_000 });
  await expect(page.getByTestId('settings-update-latest')).toContainText('0.1.9');

  // A dev copy can never install, so it does not offer the download either (review fix pass): the button is disabled and
  // the banner says why. The download path itself is still proven through the channel the button would use.
  await expect(install).toBeDisabled();
  await expect(page.getByTestId('update-banner-install')).toBeDisabled();
  await expect(page.getByTestId('update-banner-devonly')).toContainText('Updates install only from a packaged copy.');
  const started = await page.evaluate(() =>
    (window as unknown as { api: { invoke(c: string): Promise<{ ok: boolean }> } }).api.invoke('update:download'),
  );
  expect(started.ok).toBe(true);
  // main downloads the zip, checks size + sha256 against release.json, extracts it and finds the exe -> ready
  await expect(install).toHaveText('Restart to finish', { timeout: 60_000 });
  await expect(install).toBeDisabled();
  await expect(page.getByTestId('settings-update-devonly')).toContainText('Updates install only from a packaged copy.');
  await expect(page.getByTestId('app-version-update')).toBeVisible();
  await group.scrollIntoViewIfNeeded();
  await e2e.screenshot(page, 'settings-updates-en');
  await switchLanguage(page, 'he');
  await expect(install).toHaveText('הפעלה מחדש לסיום');
  await group.scrollIntoViewIfNeeded();
  await e2e.screenshot(page, 'settings-updates-he');
  await switchLanguage(page, 'en');

  // the banner shows the ready row with Restart disabled too
  const banner = page.getByTestId('update-banner');
  await expect(banner).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('update-banner-restart')).toBeDisabled();

  // Even a direct invoke (bypassing the disabled button) is refused by main: no updater, no quit.
  const answer = await page.evaluate(() =>
    (window as unknown as { api: { invoke(c: string): Promise<{ ok: boolean }> } }).api.invoke('update:install'),
  );
  expect(answer.ok).toBe(false);
  expect(launched.closed).toBe(false);

  // The footer link opens Settings > Updates
  await backToDashboard(page);
  await page.getByTestId('app-version-update').click();
  await expect(page.getByTestId('settings')).toHaveAttribute('data-group', 'updates');

  // the zip came through the fake "CDN" (one redirect hop), never with credentials
  expect(w.gh.requests.some((r) => r.path.includes('/cdn/'))).toBe(true);
  await e2e.quit(launched);
  expectVersionOnlyRequests(w.gh);
  expectNothingSpawned(w.journal);
});
