// tests/e2e/cli-signin.spec.ts - [D-080] the guided CLI sign-in session and the Antigravity model fixes, end to end (fake CLIs only).
//
// What the live diagnostic of 2026-10-05 found (ops/DECISIONS.md D-080), replayed against the fakes:
//   (a) Claude Code's OAuth session expired: the auth-status probe still says "signed in", the smoke run prints its init, then
//       `error: "authentication_failed"` + an is_error result. The "Use" error card must say CLI_NOT_SIGNED_IN AND offer "Sign in";
//       Sign in opens `<located exe> auth login --claudeai` in a visible console (S-CONSOLE: recorded, never spawned, never cmd.exe);
//       when that console closes the app re-tests BY ITSELF (no click) and the card reads Ready / "Signed in - ... works".
//   (b) Antigravity 1.2.16 refuses `--effort` next to an effort-suffixed slug: the default `gemini-3.8-flash-high` runs WITHOUT
//       `--effort` and the test passes; an unsuffixed slug keeps `--effort low`. A model the CLI refuses (an error result as the FIRST
//       event, no init) is CLI_MODEL_REJECTED with "Choose another model" (focuses the model control) - never CLI_TOOLSET_MISMATCH
//       ("changed in a way the app does not recognise"), never a pass.
//   (c) the Antigravity sign-in console runs inside the ISOLATED profile: cwd and USERPROFILE / HOME / APPDATA / LOCALAPPDATA under
//       `<userData>\agy-home`, the app-owned settings.json written there, the user's own ~/.gemini untouched.
// The tracked console is the e2e S-CONSOLE recorder with WCA_CONSOLE_DIR (helpers/cli.ts consoleRecorder): the spec "closes" it by
// writing console-<n>.exit. The fake's state file plays the vendor's login (`loggedIn: true`) - no CLI login ever runs.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test, wca } from './helpers/fixtures.ts';
import { connectState, consoleRecorder, launchCliWorld, openAiCard, runsOf, type CliWorld } from './helpers/cli.ts';
import { consentKinds } from './helpers/v2.ts';

test.setTimeout(150_000);

const TOOLSET_MISMATCH_TEXT = 'changed in a way the app does not recognise';
const samePath = (a: string, b: string): boolean =>
  a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();
const isCmd = (a: string): boolean => /(^|\\|\/)cmd(\.exe)?$/i.test(a);

async function readConsentToEnd(page: Page): Promise<void> {
  await page.getByTestId('consent-body').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event('scroll'));
  });
}

/** "Use <provider>" on the Settings card; accepts the consent dialog when it is shown (first use only). */
async function clickUse(w: CliWorld, provider: 'claude_cli' | 'antigravity_cli'): Promise<void> {
  const { page } = w;
  await expect(page.getByTestId(`ai-use-${provider}`)).toBeEnabled({ timeout: 30_000 });
  await page.waitForTimeout(600); // the 500 ms focus-steal guard (UX2 11.5)
  await page.getByTestId(`ai-use-${provider}`).click();
  const kind = provider === 'claude_cli' ? 'cloud_claude_cli' : 'cloud_antigravity_cli';
  if (!consentKinds(w.userDataDir).includes(kind)) {
    await expect(page.getByTestId('consent-dialog')).toHaveAttribute('data-kind', kind);
    await readConsentToEnd(page);
    await page.getByTestId('consent-accept').click();
  }
}

test('(a) Claude, expired session: the error card offers Sign in -> auth login --claudeai in a visible console -> closing it re-tests by itself -> Ready', async ({
  e2e,
}) => {
  const rec = consoleRecorder(e2e, 'signin-claude');
  const w = await launchCliWorld(e2e, 'signin-claude', {
    claude: { modeByStage: { smoke: 'oauth_expired' } },
    env: rec.env,
  });
  const { page, app } = w;
  await openAiCard(page, 'claude_cli');
  // the probe only reads `loggedIn` - the stale "signed in" of the live diagnostic
  await expect.poll(() => connectState(page, 'claude_cli'), { timeout: 30_000 }).toBe('ready');

  // "Use" -> consent -> the provider-start smoke: init, then authentication_failed => CLI_NOT_SIGNED_IN with its action
  await clickUse(w, 'claude_cli');
  const card = page.getByTestId('ai-use-error-claude_cli');
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText('is not signed in');
  await expect(card).not.toContainText(TOOLSET_MISMATCH_TEXT);
  const action = page.getByTestId('ai-use-error-action-claude_cli');
  await expect(action).toHaveText('Sign in');
  await expect(action).toBeEnabled();
  // the Connect card no longer claims "signed in" after that result
  await expect(page.getByTestId('connect-claude_cli')).toHaveAttribute('data-state', 'not_signed_in');
  await expect(page.getByTestId('connect-state-claude_cli')).toContainText('not signed in');
  expect((await wca(app).health()).llm.provider, 'a failed Use changes nothing').toBe('local');
  const failed = runsOf(w.cli.claude!.journal(), 'smoke');
  expect(failed).toHaveLength(1);
  expect(failed[0]!.mode).toBe('oauth_expired');
  await e2e.screenshot(page, 'signin-claude-expired-en');

  // Sign in: exactly one console, the located exe + `auth login --claudeai`, never cmd.exe; nothing was spawned
  await action.click();
  await expect.poll(() => rec.calls().length, { timeout: 10_000 }).toBe(1);
  const c = rec.calls()[0]!;
  expect(samePath(c.argv[0]!, w.cli.claude!.command), 'the console runs the LOCATED exe').toBe(true);
  expect(c.argv.slice(1)).toEqual(['auth', 'login', '--claudeai']);
  expect(c.argv.some(isCmd), 'never cmd.exe').toBe(false);
  expect((await wca(app).consoles()).map((a) => a.slice(1))).toEqual([['auth', 'login', '--claudeai']]);
  // the console gets the SAME profile the runs use (the fake home here), the system PATH, no vendor override
  expect(c.env).not.toBeNull();
  const env = c.env!;
  expect(env.USERPROFILE).toBe(e2e.fakeHome);
  expect(env.APPDATA).toBe(join(e2e.fakeHome, 'AppData', 'Roaming'));
  expect(env.DISABLE_AUTOUPDATER).toBe('1');
  expect(env.PATH!.split(';')[0]!.toLowerCase()).toMatch(/\\system32$/);
  expect(Object.keys(env).filter((k) => /^(ANTHROPIC_|CLAUDE_)|PROXY|NODE_OPTIONS|^CI$|^WCA_/i.test(k))).toEqual([]);
  expect(runsOf(w.cli.claude!.journal(), 'auth_login'), 'the e2e build never runs the login').toHaveLength(0);

  // while the window is open: the session state, no second console offered
  await expect(page.getByTestId('connect-claude_cli')).toHaveAttribute('data-state', 'sign_in_open', {
    timeout: 10_000,
  });
  await expect(page.getByTestId('connect-state-claude_cli')).toContainText('A sign-in window opened');
  await expect(action).toBeDisabled();
  await page.waitForTimeout(1_500);
  expect(runsOf(w.cli.claude!.journal(), 'smoke'), 'no test while the console is open').toHaveLength(1);
  await e2e.screenshot(page, 'signin-claude-open-en');

  // the user signs in in that window and closes it: the app re-probes and re-tests ONCE, with no click
  w.cli.claude!.setState({ loggedIn: true, modeByStage: {} });
  rec.exit(1);
  await expect.poll(() => runsOf(w.cli.claude!.journal(), 'smoke').length, { timeout: 60_000 }).toBe(2);
  await expect(page.getByTestId('connect-claude_cli')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  await expect(page.getByTestId('connect-session-ok-claude_cli')).toContainText('works');
  await expect(page.getByTestId('connect-state-claude_cli')).toContainText('signed in.');
  await expect(page.getByTestId('ai-use-error-claude_cli'), 'the stale not-signed-in card is gone').toHaveCount(0);
  const retest = runsOf(w.cli.claude!.journal(), 'smoke')[1]!;
  expect(retest.mode).toBe('ok');
  expect(rec.calls(), 'still exactly one console').toHaveLength(1);
  await e2e.screenshot(page, 'signin-claude-ready-en');

  // and the provider can now be used: the fresh passed test lets "Use" switch without another prompt
  await clickUse(w, 'claude_cli');
  await expect(page.getByTestId('ai-card-claude_cli')).toHaveAttribute('data-active', '1', { timeout: 60_000 });
  await expect.poll(async () => (await wca(app).health()).llm.provider, { timeout: 30_000 }).toBe('claude_cli');
});

test('(b) Antigravity: an effort-suffixed model runs without --effort and passes; a refused model is CLI_MODEL_REJECTED -> Choose another model', async ({
  e2e,
}) => {
  const w = await launchCliWorld(e2e, 'agy-model', {
    claude: null,
    agy: {
      models: ['gemini-3.8-flash-high', 'gemini-3.8-flash', 'gemini-3.8-pro-high'],
      rejectedModels: ['gemini-3.8-pro-high'],
    },
  });
  const { page, app } = w;
  await openAiCard(page, 'antigravity_cli');
  await expect.poll(() => connectState(page, 'antigravity_cli'), { timeout: 30_000 }).toBe('ready');
  const select = page.getByTestId('connect-model-antigravity_cli');
  await expect(select).toHaveValue('gemini-3.8-flash-high');

  // 1. the default slug carries its effort: no --effort on argv, the test passes (the 1.2.16 refusal is gone)
  await page.getByTestId('connect-test-antigravity_cli').click();
  await expect(page.getByTestId('connect-test-result-antigravity_cli')).toHaveAttribute('data-ok', '1', {
    timeout: 60_000,
  });
  const first = runsOf(w.cli.agy!.journal(), 'smoke');
  expect(first).toHaveLength(1);
  const argv1 = first[0]!.argv as string[];
  expect(argv1[argv1.indexOf('--model') + 1]).toBe('gemini-3.8-flash-high');
  expect(argv1, 'no --effort next to an effort-suffixed slug').not.toContain('--effort');
  expect(first[0]!.violations).toEqual([]);

  // 2. an unsuffixed slug keeps `--effort low`
  await select.selectOption('gemini-3.8-flash');
  await expect(select).toHaveValue('gemini-3.8-flash');
  await page.getByTestId('connect-test-antigravity_cli').click();
  await expect.poll(() => runsOf(w.cli.agy!.journal(), 'smoke').length, { timeout: 60_000 }).toBe(2);
  await expect(page.getByTestId('connect-test-result-antigravity_cli')).toHaveAttribute('data-ok', '1', {
    timeout: 60_000,
  });
  const argv2 = runsOf(w.cli.agy!.journal(), 'smoke')[1]!.argv as string[];
  expect(argv2[argv2.indexOf('--model') + 1]).toBe('gemini-3.8-flash');
  expect(argv2[argv2.indexOf('--effort') + 1]).toBe('low');

  // 3. a model the CLI refuses: "Run a test" names the refusal, never the toolset text
  await select.selectOption('gemini-3.8-pro-high');
  await expect(select).toHaveValue('gemini-3.8-pro-high');
  await page.getByTestId('connect-test-antigravity_cli').click();
  await expect.poll(() => runsOf(w.cli.agy!.journal(), 'smoke').length, { timeout: 60_000 }).toBe(3);
  const result = page.getByTestId('connect-test-result-antigravity_cli');
  await expect(result).toHaveAttribute('data-ok', '0', { timeout: 60_000 });
  await expect(result).toContainText('did not accept the chosen model');
  await expect(result).not.toContainText(TOOLSET_MISMATCH_TEXT);
  const refused = runsOf(w.cli.agy!.journal(), 'smoke')[2]!;
  expect(refused.argv as string[]).not.toContain('--effort');
  expect(refused.turnStarted, 'no turn: the refusal came before any init').not.toBe(true);

  // 4. "Use" with the refused model: the error card is CLI_MODEL_REJECTED with "Choose another model", which focuses the select
  await clickUse(w, 'antigravity_cli');
  const card = page.getByTestId('ai-use-error-antigravity_cli');
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText('did not accept the chosen model');
  await expect(card).not.toContainText(TOOLSET_MISMATCH_TEXT);
  const action = page.getByTestId('ai-use-error-action-antigravity_cli');
  await expect(action).toHaveText('Choose another model');
  expect((await wca(app).health()).llm.provider, 'a refused model changes nothing').toBe('local');
  expect((await wca(app).health()).llm.code ?? null).not.toBe('CLI_TOOLSET_MISMATCH');
  await e2e.screenshot(page, 'agy-model-rejected-en');
  await action.click();
  await expect(select).toBeFocused();
  await expect(page.getByText(TOOLSET_MISMATCH_TEXT)).toHaveCount(0);

  // 5. another model -> Use passes (no --effort again) and the provider is active
  await select.selectOption('gemini-3.8-flash-high');
  await expect(select).toHaveValue('gemini-3.8-flash-high');
  await clickUse(w, 'antigravity_cli');
  await expect(page.getByTestId('ai-card-antigravity_cli')).toHaveAttribute('data-active', '1', { timeout: 60_000 });
  await expect.poll(async () => (await wca(app).health()).llm.provider, { timeout: 30_000 }).toBe('antigravity_cli');
  // the refused Use left no passed test, so this Use ran its own provider-start smoke with the new model
  await expect.poll(() => runsOf(w.cli.agy!.journal(), 'smoke').length, { timeout: 30_000 }).toBe(5);
  const last = runsOf(w.cli.agy!.journal(), 'smoke').at(-1)!.argv as string[];
  expect(last[last.indexOf('--model') + 1]).toBe('gemini-3.8-flash-high');
  expect(last).not.toContain('--effort');
});

test('(c) Antigravity sign-in: the console runs in the isolated agy-home profile; closing it re-tests by itself -> Ready', async ({
  e2e,
}) => {
  // the user's OWN Antigravity settings in the fake home: the sign-in must never touch (or point at) them
  const ownDir = join(e2e.fakeHome, '.gemini', 'antigravity-cli');
  const ownFile = join(ownDir, 'settings.json');
  const own = JSON.stringify({ theme: 'dark', trustedWorkspaces: [] }, null, 2);
  const rec = consoleRecorder(e2e, 'signin-agy');
  const w = await launchCliWorld(e2e, 'signin-agy', {
    claude: null,
    agy: { loggedIn: false },
    env: rec.env,
    beforeLaunch: () => {
      mkdirSync(ownDir, { recursive: true });
      writeFileSync(ownFile, own, 'utf8');
    },
  });
  const { page, app, userDataDir } = w;
  await openAiCard(page, 'antigravity_cli');
  await expect.poll(() => connectState(page, 'antigravity_cli'), { timeout: 30_000 }).toBe('not_signed_in');
  await page.getByTestId('connect-signin-antigravity_cli').click();
  await expect.poll(() => rec.calls().length, { timeout: 10_000 }).toBe(1);

  const c = rec.calls()[0]!;
  const agyHome = join(userDataDir, 'agy-home');
  expect(samePath(c.argv[0]!, w.cli.agy!.command), 'the console runs the LOCATED exe').toBe(true);
  expect(c.argv.slice(1), 'agy is started bare: its own interactive sign-in').toEqual([]);
  expect(c.argv.some(isCmd)).toBe(false);
  expect(samePath(c.cwd ?? '', agyHome), 'cwd = <userData>\\agy-home, never %USERPROFILE%').toBe(true);
  expect(c.env).not.toBeNull();
  const env = c.env!;
  expect(samePath(env.USERPROFILE ?? '', agyHome)).toBe(true);
  expect(samePath(env.HOME ?? '', agyHome)).toBe(true);
  expect(samePath(env.APPDATA ?? '', join(agyHome, 'AppData', 'Roaming'))).toBe(true);
  expect(samePath(env.LOCALAPPDATA ?? '', join(agyHome, 'AppData', 'Local'))).toBe(true);
  expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true');
  expect(env.PATH!.split(';')[0]!.toLowerCase()).toMatch(/\\system32$/);
  const leaks = Object.entries(env).filter(([, v]) => v.toLowerCase().includes(e2e.fakeHome.toLowerCase()));
  expect(leaks, "no variable points at the user's real profile").toEqual([]);
  expect(
    Object.keys(env).filter((k) => /^(GEMINI_|GOOGLE_|ANTHROPIC_|CLAUDE_)|PROXY|NODE_OPTIONS|^WCA_/i.test(k)),
  ).toEqual([]);
  // the app-owned isolated settings.json is in place (the same bytes every run writes); the user's own file is untouched
  const isolated = join(agyHome, '.gemini', 'antigravity-cli', 'settings.json');
  expect(existsSync(isolated)).toBe(true);
  expect(JSON.parse(readFileSync(isolated, 'utf8'))).toEqual({
    trustedWorkspaces: [join(userDataDir, 'agy-workspace')],
  });
  expect(readFileSync(ownFile, 'utf8')).toBe(own);
  expect(readdirSync(ownDir)).toEqual(['settings.json']);

  await expect(page.getByTestId('connect-antigravity_cli')).toHaveAttribute('data-state', 'sign_in_open', {
    timeout: 10_000,
  });
  await e2e.screenshot(page, 'signin-agy-open-en');

  // signed in there, window closed: re-probe + one automatic test -> Ready
  w.cli.agy!.setState({ loggedIn: true });
  rec.exit(1);
  await expect.poll(() => runsOf(w.cli.agy!.journal(), 'smoke').length, { timeout: 60_000 }).toBe(1);
  await expect(page.getByTestId('connect-antigravity_cli')).toHaveAttribute('data-state', 'ready', {
    timeout: 60_000,
  });
  await expect(page.getByTestId('connect-session-ok-antigravity_cli')).toContainText('works');
  const smoke = runsOf(w.cli.agy!.journal(), 'smoke')[0]!;
  expect(smoke.mode).toBe('ok');
  expect(samePath((smoke.home as { userProfile: string }).userProfile, agyHome), 'the run reads the same profile').toBe(
    true,
  );
  expect(rec.calls()).toHaveLength(1);
  expect((await wca(app).consoles()).length).toBe(1);
  expect(readFileSync(ownFile, 'utf8')).toBe(own);
});
