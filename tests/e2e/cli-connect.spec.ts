// tests/e2e/cli-connect.spec.ts - T2 10 row `cli-connect.spec.ts` (bridge ATTACH + WCA_CLI_CMD + WCA_MCP_CMD). Owner V2-W2-03.
//
// CLI setup detection and the subscription providers with the FAKE vendor CLIs (T8: the real claude.exe / agy.exe are never run -
// the dev PC has a signed-in claude.exe 2.1.258, and the decoy `<fake home>\.local\bin\claude.exe` proves that the e2e build resolves
// the CLI from WCA_CLI_CMD ONLY):
//   (1) not installed -> install command as copyable text, "Open install page" -> `external:open claude_install`; nothing ran;
//   (2) version 2.1.200 -> too old, the update command; (3) not signed in -> "Sign in" records exactly one visible-console argv
//   `[<the located exe>, auth, login, --claudeai]` (F7, never cmd.exe; no console process exists) -> state file flipped -> ready;
//   (4) `loggedIn:'garbage'` -> "Could not tell whether you are signed in";
//   (5) "Use Claude - your subscription" opens the cloud_claude_cli consent; declining keeps Local and records nothing; accepting ->
//   the provider-start smoke run -> active; "Test" -> "Works", the journal shows the smoke stage with `haiku` and `--max-turns 1`;
//   (6) an inbound becomes a card through S1 (`--tools ""`, no MCP) + S3 (one wa_get_chat_messages executed); an attacker run is
//   blocked and badged; zero sends until a click; one approve = exactly one send;
//   (7) usage_limit -> CLOUD_QUOTA with "usage resets HH:MM", items held; overage -> CLOUD_OVERAGE; extra_tool ->
//   CLI_TOOLSET_MISMATCH (Export diagnostics);
//   (8) "Show experimental" -> Gemini - your subscription (experimental): consent with the Terms read date, automatic mode
//   unavailable; in the isolated agy profile (D-063 / F3, this build's default) the workspace-trust step is recorded as not
//   needed: no diff, no dialog, the user's own settings.json untouched with no backup, and the provider is selectable.
// After every spec: no job pid survives the quit, no job pid file, empty cli-runs\ and agy-workspace\runs\, every fake journal clean.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, wca } from './helpers/fixtures.ts';
import { connectState, launchCliWorld, openAiCard, runsOf } from './helpers/cli.ts';
import type { FakeCliRule } from './helpers/fakes.ts';
import { cardOfChat, consentKinds, extraction, jid, openSettings, query } from './helpers/v2.ts';

test.setTimeout(120_000);

const samePath = (a: string, b: string): boolean =>
  a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();

test('(1) {"claude_cli":null}: not installed - the install command, "Open install page" records claude_install, nothing runs', async ({
  e2e,
}) => {
  const w = await launchCliWorld(e2e, 'cli-none', { claude: null, agy: null });
  const { page, app } = w;
  await openAiCard(page, 'claude_cli');
  await expect.poll(() => connectState(page, 'claude_cli'), { timeout: 30_000 }).toBe('not_installed');
  await expect(page.getByTestId('connect-command-claude_cli')).toHaveValue('irm https://claude.ai/install.ps1 | iex');
  await expect(page.getByTestId('connect-copy-claude_cli')).toBeVisible();
  await expect(page.getByTestId('connect-signin-claude_cli')).toHaveCount(0);
  await expect(page.getByTestId('connect-test-claude_cli')).toHaveCount(0);
  await expect(page.getByTestId('ai-use-claude_cli')).toBeDisabled();
  await e2e.screenshot(page, 'connect-not-installed-en');

  await page.getByTestId('connect-open-install-claude_cli').click();
  await expect
    .poll(async () => wca(app).openedExternal(), { timeout: 10_000 })
    .toEqual(['https://code.claude.com/docs/en/setup']);
  // WCA_CLI_CMD-only resolution: the decoy claude.exe in the fake home was not "found", no CLI process ever ran
  expect(existsSync(w.decoy)).toBe(true);
  expect(w.cli.claude, 'no fake CLI exists for this launch').toBeNull();
  expect((await wca(app).jobPids()).cli).toEqual([]);
  expect(query(w.userDataDir, `SELECT value FROM meta WHERE key = 'cli_exe_paths_json'`)).toEqual([]);
  expect(await wca(app).consoles()).toEqual([]);
});

test('(2) version 2.1.200 is too old: the update command is offered, nothing else', async ({ e2e }) => {
  const w = await launchCliWorld(e2e, 'cli-old', { claude: { version: '2.1.200' } });
  const { page } = w;
  await openAiCard(page, 'claude_cli');
  await expect.poll(() => connectState(page, 'claude_cli'), { timeout: 30_000 }).toBe('too_old');
  await expect(page.getByTestId('connect-state-claude_cli')).toContainText('2.1.200');
  await expect(page.getByTestId('connect-command-claude_cli')).toHaveValue('claude update');
  await expect(page.getByTestId('connect-copy-claude_cli')).toBeVisible();
  await expect(page.getByTestId('ai-use-claude_cli')).toBeDisabled();
  // only the version probe ran - never a prompt-carrying run
  const stages = w.cli.claude!.journal().map((e) => String(e.stage));
  expect(stages.every((s) => s === 'version' || s === 'auth_status')).toBe(true);
  expect(stages).toContain('version');
});

test('(3) not signed in: "Sign in" records one visible-console argv (never cmd.exe), the flipped state file reads as ready', async ({
  e2e,
}) => {
  const w = await launchCliWorld(e2e, 'cli-signin', { claude: { loggedIn: false } });
  const { page, app } = w;
  await openAiCard(page, 'claude_cli');
  await expect.poll(() => connectState(page, 'claude_cli'), { timeout: 30_000 }).toBe('not_signed_in');
  await expect(page.getByTestId('connect-state-claude_cli')).toContainText('not signed in');
  await e2e.screenshot(page, 'connect-not-signed-in-en');

  await page.getByTestId('connect-signin-claude_cli').click();
  await expect.poll(async () => (await wca(app).consoles()).length, { timeout: 10_000 }).toBe(1);
  const argv = (await wca(app).consoles())[0]!;
  expect(samePath(argv[0]!, w.cli.claude!.command), 'the console runs the LOCATED exe, never cmd.exe').toBe(true);
  expect(argv.slice(1)).toEqual(['auth', 'login', '--claudeai']);
  expect(argv.some((a) => /(^|\\)cmd(\.exe)?$/i.test(a))).toBe(false);
  // the e2e build only records: no console process exists, and the fake never saw `auth login`
  expect(runsOf(w.cli.claude!.journal(), 'auth_login')).toHaveLength(0);
  await expect(page.getByTestId('connect-claude_cli')).toHaveAttribute('data-state', 'waiting_sign_in');

  // the user signs in in that console -> the state file says so -> the app notices (its cache is the shortened 1 s seam)
  w.cli.claude!.setState({ loggedIn: true });
  await page.waitForTimeout(1_500);
  await page.getByTestId('connect-check-claude_cli').click();
  await expect.poll(() => connectState(page, 'claude_cli'), { timeout: 30_000 }).toBe('ready');
  await expect(page.getByTestId('connect-state-claude_cli')).toContainText('2.1.258');
  await e2e.screenshot(page, 'connect-ready-en');
});

test('(4) a garbage auth answer reads as "Could not tell whether you are signed in"', async ({ e2e }) => {
  const w = await launchCliWorld(e2e, 'cli-garbage', { claude: { loggedIn: 'garbage' } });
  const { page } = w;
  await openAiCard(page, 'claude_cli');
  await expect.poll(() => connectState(page, 'claude_cli'), { timeout: 30_000 }).toBe('unknown');
  await expect(page.getByTestId('connect-state-claude_cli')).toContainText('Could not tell whether you are signed in');
  await expect(page.getByTestId('ai-use-claude_cli')).toBeDisabled();
});

// ---------------------------------------------------------------------------------------------------------------------
// (5)-(8): a provider that is ready, chosen through the consent dialog
// ---------------------------------------------------------------------------------------------------------------------

/** The consent text must be read to the end before Accept is enabled (ConsentDialog): scroll its body like a reader would. */
async function readConsentToEnd(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('consent-body').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event('scroll'));
  });
}

/**
 * "Run a test" (the fixed smoke prompt - no chat data) -> "Use Claude - your subscription" -> consent (accepted) -> active. Main
 * refuses a CLI provider without a passed test in the last 24 h (C2 8 llm:setProvider: ready -> consent -> fresh test, B12).
 */
async function useClaudeViaUi(w: Awaited<ReturnType<typeof launchCliWorld>>): Promise<void> {
  const { page } = w;
  await openAiCard(page, 'claude_cli');
  await expect.poll(() => connectState(page, 'claude_cli'), { timeout: 30_000 }).toBe('ready');
  await page.getByTestId('connect-test-claude_cli').click();
  await expect(page.getByTestId('connect-test-result-claude_cli')).toHaveAttribute('data-ok', '1', { timeout: 60_000 });
  await page.waitForTimeout(600); // "Use" sits behind the 500 ms focus-steal guard (UX2 11.5)
  await page.getByTestId('ai-use-claude_cli').click();
  await expect(page.getByTestId('consent-dialog')).toHaveAttribute('data-kind', 'cloud_claude_cli');
  await readConsentToEnd(page);
  await page.getByTestId('consent-accept').click();
  await expect(page.getByTestId('ai-card-claude_cli')).toHaveAttribute('data-active', '1', { timeout: 60_000 });
  await expect.poll(async () => (await wca(w.app).health()).llm.provider, { timeout: 30_000 }).toBe('claude_cli');
}

const CLAUDE_SCRIPT: FakeCliRule[] = [
  {
    when: { stage: 'extract', contains: '[c2]' },
    respond: {
      structured: extraction({ title: 'Coffee', dateKind: 'weekday', weekday: 4, time24h: '17:00', durationMin: 30 }),
    },
  },
  {
    when: { stage: 'extract', contains: '[c1]' },
    respond: {
      structured: extraction({ title: 'Coffee', dateKind: 'weekday', weekday: 4, time24h: '17:00', durationMin: 30 }),
    },
  },
  {
    when: { stage: 'draft', contains: '[c1]', turn: 0 },
    respond: { toolCalls: [{ name: 'wa_get_chat_messages', input: { chat: 'chat_1' } }] },
  },
  { when: { stage: 'draft' }, respond: { text: 'Thursday at 17:00 works for me.' } },
];

test('(5)+(6) consent: declining keeps Local and records nothing; accepting + Test; an inbound is drafted through S1 + S3 on the fake CLI', async ({
  e2e,
}) => {
  const w = await launchCliWorld(e2e, 'cli-use', { claude: { script: CLAUDE_SCRIPT } });
  const { page, app, userDataDir } = w;
  await openAiCard(page, 'claude_cli');
  await expect.poll(() => connectState(page, 'claude_cli'), { timeout: 30_000 }).toBe('ready');

  // declining: nothing recorded, Local stays the active provider
  await page.waitForTimeout(600);
  await page.getByTestId('ai-use-claude_cli').click();
  await expect(page.getByTestId('consent-dialog')).toHaveAttribute('data-kind', 'cloud_claude_cli');
  await e2e.screenshot(page, 'consent-claude-cli-en');
  await page.getByTestId('consent-cancel').click();
  await expect(page.getByTestId('consent-dialog')).toHaveCount(0);
  expect(consentKinds(userDataDir)).not.toContain('cloud_claude_cli');
  expect((await wca(app).health()).llm.provider).toBe('local');
  expect(runsOf(w.cli.claude!.journal(), 'extract', 'draft'), 'no chat-carrying run before consent').toHaveLength(0);

  // "Run a test" -> "Works"; then Use -> consent accepted -> the provider is active
  await useClaudeViaUi(w);
  await expect(page.getByTestId('connect-test-result-claude_cli')).toContainText('Works');
  expect(consentKinds(userDataDir)).toContain('cloud_claude_cli');
  const smokes = runsOf(w.cli.claude!.journal(), 'smoke');
  expect(smokes.length).toBeGreaterThanOrEqual(1);
  for (const run of smokes) {
    const argv = run.argv as string[];
    expect(argv[argv.indexOf('--model') + 1]).toBe('haiku');
    expect(argv[argv.indexOf('--max-turns') + 1]).toBe('1');
  }
  await e2e.screenshot(page, 'connect-ready-tested-en');

  // (6) an inbound: S1 tool-less, S3 with exactly the app's own MCP server and one wa_get_chat_messages
  await page.getByTestId('settings-toggle').click();
  const text = 'coffee Thursday at 5? [c1]';
  e2e.sentinels.push(text);
  await w.bridge.deliver(app, { chatJid: jid(60), text, ts: w.clock.date(), pushName: 'Contact 60' });
  const itemId = await cardOfChat(page, userDataDir, jid(60), 90_000);
  await expect(page.getByTestId(`draft-${itemId}`)).toHaveValue('Thursday at 17:00 works for me.', { timeout: 60_000 });
  const extract = runsOf(w.cli.claude!.journal(), 'extract');
  expect(extract.length).toBeGreaterThanOrEqual(1);
  for (const run of extract) {
    const argv = run.argv as string[];
    expect(argv[argv.indexOf('--tools') + 1], 'S1 runs with --tools ""').toBe('');
    expect(argv).not.toContain('--mcp-config');
  }
  const draft = runsOf(w.cli.claude!.journal(), 'draft');
  expect(draft.length).toBeGreaterThanOrEqual(1);
  const calls = draft.flatMap((r) => (r.toolCalls as Array<{ name: string; isError: boolean }>) ?? []);
  expect(calls.filter((c) => c.name === 'wa_get_chat_messages' && !c.isError)).toHaveLength(1);
  expect(w.bridge.fake.sent, 'zero sends before a click').toHaveLength(0);

  // the same CLI turned attacker on S3 in a second chat: every probe blocked, the card badged, nothing sent
  w.cli.claude!.setState({ modeByStage: { draft: 'attacker' } });
  const attack = 'coffee Thursday at 5 again? [c2]';
  e2e.sentinels.push(attack);
  await w.bridge.deliver(app, { chatJid: jid(61), text: attack, ts: w.clock.date(), pushName: 'Contact 61' });
  const bad = await cardOfChat(page, userDataDir, jid(61), 90_000);
  // B28: the run is aborted and the chat badged `manipulation` (hard check on the stored item), and the badge must be VISIBLE on the
  // card. Soft (reported, the rest still runs): an aborted S3 leaves no draft, and the draft-scoped badge row is not rendered then.
  await expect
    .poll(
      () =>
        query<{ badges_json: string }>(userDataDir, 'SELECT badges_json FROM items WHERE id = ?', bad)[0]
          ?.badges_json ?? '',
      {
        timeout: 60_000,
      },
    )
    .toContain('manipulation');
  await expect
    .soft(
      page.getByTestId(`card-${bad}`).getByTestId('badge-manipulation'),
      'the manipulation badge is visible on the card',
    )
    .toBeVisible({ timeout: 10_000 });
  await e2e.screenshot(page, 'cli-attacker-manipulation-en');
  const attackerRuns = runsOf(w.cli.claude!.journal(), 'draft').filter((r) => r.mode === 'attacker');
  expect(attackerRuns.length).toBeGreaterThanOrEqual(1);
  for (const r of attackerRuns)
    for (const c of (r.toolCalls as Array<{ name: string; allowedByServer: boolean }>) ?? [])
      expect(c.allowedByServer, `the tool server refused ${c.name}`).toBe(false);
  expect(w.bridge.fake.sent).toHaveLength(0);

  // one approve = exactly one send (the clean card)
  await page.getByTestId(`approve-send-${itemId}`).click();
  await expect.poll(() => w.bridge.fake.sent.length, { timeout: 30_000 }).toBe(1);
  expect(w.bridge.fake.sent[0]!.recipient).toBe(jid(60));
  await page.waitForTimeout(2_000);
  expect(w.bridge.fake.sent).toHaveLength(1);
});

/**
 * (7) The CLI's account limits and a broken init proof must reach the user as their ErrorCodes (UX2 7.1: the card's own error row,
 * driven by `AppHealth.llm.code`; the header pill). The SAFETY half is hard-checked (no further run, no send, the item not
 * processed); the UI half is checked softly with its own message so every gap is reported in one run - see the notes file.
 */
async function expectLlmCode(w: Awaited<ReturnType<typeof launchCliWorld>>, code: string): Promise<void> {
  await expect
    .soft(async () => expect((await wca(w.app).health()).llm.code).toBe(code), `AppHealth.llm.code is ${code}`)
    .toPass({ timeout: 45_000 });
  await openAiCard(w.page, 'claude_cli');
  await expect
    .soft(w.page.getByTestId('connect-error-claude_cli'), `the Connect card shows the ${code} row`)
    .toHaveAttribute('data-code', code, { timeout: 5_000 });
}

test('(7a) usage_limit: CLOUD_QUOTA with "continues by itself at HH:MM", new chats are held', async ({ e2e }) => {
  const w = await launchCliWorld(e2e, 'cli-quota', { claude: { script: CLAUDE_SCRIPT } });
  const { page, app, userDataDir } = w;
  await useClaudeViaUi(w);
  const resetsAtSec = Math.floor((w.clock.now() + 2 * 3_600_000) / 1000);
  w.cli.claude!.setState({
    mode: 'usage_limit',
    rateLimit: { status: 'rejected', resetsAt: resetsAtSec, isUsingOverage: false },
  });
  await page.getByTestId('settings-toggle').click();
  await w.bridge.deliver(app, { chatJid: jid(60), text: 'coffee Thursday at 5? [c1]', ts: w.clock.date() });
  // hard: the chat is not analysed by the exhausted account (held, never a draft), nothing sent
  await expect
    .poll(() => query<{ analysis: string }>(userDataDir, 'SELECT analysis FROM items')[0]?.analysis, {
      timeout: 90_000,
    })
    .toBe('held');
  expect
    .soft(
      query<{ hold_reason: string | null }>(userDataDir, 'SELECT hold_reason FROM items')[0]?.hold_reason,
      'held until resetsAt (budget)',
    )
    .toBe('budget');
  expect(runsOf(w.cli.claude!.journal(), 'extract', 'draft').filter((r) => r.mode !== 'usage_limit')).toHaveLength(0);
  await expectLlmCode(w, 'CLOUD_QUOTA');
  await expect
    .soft(page.getByTestId('connect-error-claude_cli'), 'the row says when usage resets (HH:MM)')
    .toContainText(/\d{1,2}:\d{2}/, { timeout: 2_000 });
  await e2e.screenshot(page, 'connect-quota-en');
  expect(w.bridge.fake.sent).toHaveLength(0);
});

test('(7b) overage: CLOUD_OVERAGE pauses the provider and no further run starts', async ({ e2e }) => {
  const w = await launchCliWorld(e2e, 'cli-overage', { claude: { script: CLAUDE_SCRIPT } });
  const { page, app } = w;
  await useClaudeViaUi(w);
  w.cli.claude!.setState({
    mode: 'overage',
    rateLimit: { status: 'allowed', resetsAt: 1_900_000_000, isUsingOverage: true },
  });
  await page.getByTestId('settings-toggle').click();
  await w.bridge.deliver(app, { chatJid: jid(60), text: 'coffee Thursday at 5? [c1]', ts: w.clock.date() });
  await expect
    .poll(
      () => runsOf(w.cli.claude!.journal(), 'smoke', 'extract', 'draft').filter((r) => r.mode === 'overage').length,
      {
        timeout: 90_000,
      },
    )
    .toBeGreaterThan(0);
  await page.waitForTimeout(5_000);
  const runs = runsOf(w.cli.claude!.journal(), 'extract', 'draft').length;
  await w.bridge.deliver(app, { chatJid: jid(61), text: 'coffee Thursday at 5 again? [c2]', ts: w.clock.date() });
  await page.waitForTimeout(25_000); // longer than the 20 s debounce of the second chat
  expect(runsOf(w.cli.claude!.journal(), 'extract', 'draft').length, 'no further run while paused by overage').toBe(
    runs,
  );
  await expectLlmCode(w, 'CLOUD_OVERAGE');
  expect(w.bridge.fake.sent).toHaveLength(0);
});

test('(7c) extra_tool: the init proof fails -> CLI_TOOLSET_MISMATCH with "Export diagnostics", nothing consumed a turn', async ({
  e2e,
}) => {
  const w = await launchCliWorld(e2e, 'cli-mismatch', { claude: { script: CLAUDE_SCRIPT } });
  const { page, app, userDataDir } = w;
  await useClaudeViaUi(w);
  w.cli.claude!.setState({ modeByStage: { extract: 'extra_tool', draft: 'extra_tool' } });
  await page.getByTestId('settings-toggle').click();
  await w.bridge.deliver(app, { chatJid: jid(60), text: 'coffee Thursday at 5? [c1]', ts: w.clock.date() });
  await expect
    .poll(() => query<{ error_code: string | null }>(userDataDir, 'SELECT error_code FROM items')[0]?.error_code, {
      timeout: 90_000,
    })
    .toBe('CLI_TOOLSET_MISMATCH');
  const bad = runsOf(w.cli.claude!.journal(), 'extract', 'draft').filter((r) => r.mode === 'extra_tool');
  expect(bad.length).toBeGreaterThanOrEqual(1);
  for (const r of bad) expect(r.turnStarted, 'killed before any turn was consumed (I11)').not.toBe(true);
  expect(runsOf(w.cli.claude!.journal(), 'draft'), 'no S3 after a failed S1 init proof').toHaveLength(0);
  await expectLlmCode(w, 'CLI_TOOLSET_MISMATCH');
  await expect
    .soft(page.getByTestId('connect-error-claude_cli'), 'the row offers Export diagnostics and names the local AI')
    .toContainText('Export diagnostics', { timeout: 2_000 });
  await e2e.screenshot(page, 'connect-toolset-mismatch-en');
  expect(w.bridge.fake.sent).toHaveLength(0);
});

test('(8) experimental Gemini: hidden until "Show experimental", Terms read date, the user\'s own agy settings untouched, selectable', async ({
  e2e,
}) => {
  // The user's OWN Antigravity settings (in the fake home): the app runs agy in an isolated profile (F3, `<userData>\agy-home`),
  // so this file must never be read-modified-written without the workspace-trust dialog - and here nothing confirms one.
  const settingsDir = join(e2e.fakeHome, '.gemini', 'antigravity-cli');
  const settingsFile = join(settingsDir, 'settings.json');
  const original = JSON.stringify({ theme: 'dark', telemetry: false, trustedWorkspaces: [] }, null, 2);
  const w = await launchCliWorld(e2e, 'cli-agy', {
    claude: null,
    agy: {},
    dialog: [{ match: 'agy_workspace', response: 1, checkboxChecked: false }],
    beforeLaunch: () => {
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(settingsFile, original, 'utf8');
    },
  });
  const { page } = w;
  await openSettings(page);
  await expect(page.getByTestId('ai-card-antigravity_cli'), 'experimental cards start hidden').toHaveCount(0);
  await openAiCard(page, 'antigravity_cli');
  await expect(page.getByTestId('ai-card-antigravity_cli')).toContainText('Experimental');
  // the disclosure names the date the Terms were read (UX2 7.4), as an app constant
  await expect(page.getByTestId('agy-disclosure')).toContainText('Terms read on');
  await expect(page.getByTestId('agy-capabilities')).toContainText(
    'Automatic mode does nothing while this AI is selected',
  );
  await expect.poll(() => connectState(page, 'antigravity_cli'), { timeout: 30_000 }).toBe('ready');
  await e2e.screenshot(page, 'connect-agy-en');

  // The workspace-trust step of T2 10 (8) (one-line diff + native dialog + backup) exists only in the GLOBAL-profile fallback.
  // This build runs agy in the isolated `<userData>\agy-home` profile (D-063 / F3: isolated by default), which already trusts
  // the app's own workspace; the v2 repair of REQUEST 9 (compose.ts: `cliStatus.recordWorkspaceTrusted(true)` when
  // AGY_PROFILE_MODE === 'isolated') records the step as "not needed". The isolated-mode outcome is therefore: no workspace
  // block, no diff, no Allow button, no workspace dialog, the user's file untouched, and the provider selectable (below).
  await expect(page.getByTestId('agy-workspace'), 'isolated mode (D-063, F3): no workspace-trust step').toHaveCount(0);
  await expect(page.getByTestId('agy-workspace-diff'), 'isolated mode: no settings.json diff is shown').toHaveCount(0);
  await expect(page.getByTestId('agy-workspace-allow'), 'isolated mode: nothing to allow').toHaveCount(0);

  // hard: the user's own settings file is untouched and no backup was written
  expect(readFileSync(settingsFile, 'utf8')).toBe(original);
  expect(readdirSync(settingsDir)).toEqual(['settings.json']);
  expect((await wca(w.app).dialogs()).filter((d) => d.kind === 'agy_workspace')).toHaveLength(0);

  // the provider must be selectable once ready ("Use Gemini - your subscription"): the consent shows the Terms read date
  await expect(page.getByTestId('ai-use-antigravity_cli'), 'Gemini - your subscription can be chosen').toBeEnabled({
    timeout: 10_000,
  });
  await page.waitForTimeout(600);
  await page.getByTestId('ai-use-antigravity_cli').click();
  await expect(page.getByTestId('consent-dialog')).toHaveAttribute('data-kind', 'cloud_antigravity_cli');
  await expect(page.getByTestId('consent-terms-date')).toBeVisible();
  await e2e.screenshot(page, 'consent-agy-en');
  await page.getByTestId('consent-cancel').click();
  expect(consentKinds(w.userDataDir)).not.toContain('cloud_antigravity_cli');
});

test('(9) quitting while a CLI job runs: the job pid is dead within 10 s, no job pid file, empty cli-runs dir', async ({
  e2e,
}) => {
  // T2 10.0 after-spec check, provoked on purpose: the fake CLI hangs after its init line (smoke stage 'hang'), the "Test" run is in
  // flight, and the user quits. E2eContext.quit() asserts every job pid seen is gone within 10 s, no run\job-*.pid.json is left
  // and cli-runs\ is empty.
  const w = await launchCliWorld(e2e, 'cli-quit', { claude: { modeByStage: { smoke: 'hang' } } });
  const { page, app } = w;
  await openAiCard(page, 'claude_cli');
  await expect.poll(() => connectState(page, 'claude_cli'), { timeout: 30_000 }).toBe('ready');
  await page.getByTestId('connect-test-claude_cli').click();
  const launched = e2e.launches[e2e.launches.length - 1]!;
  await expect.poll(async () => (await e2e.noteJobPids(launched)).cli.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(() => runsOf(w.cli.claude!.journal(), 'smoke').length, { timeout: 30_000 }).toBe(1);
  await e2e.noteJobPids(launched);
  void app;
  await e2e.quit(launched);
});
