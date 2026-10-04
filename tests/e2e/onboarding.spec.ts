// tests/e2e/onboarding.spec.ts - TESTS section 10, row `onboarding.spec.ts`. Owner W2-03.
// Bridge mode: CHILD (`WCA_BRIDGE_CMD`) + `WCA_MCP_CMD` + `WCA_LLAMA_CMD` + `WCA_MODEL_MANIFEST` + `WCA_HW`.
//
// Everything the wizard touches is a fake: the "bridge" is tests/fakes/fake-bridge.ts, the "model host" and the
// "llama-server" are tests/fakes/fake-llama-server.ts serving a 256 KiB dummy GGUF over 127.0.0.1, and the calendar
// server is tests/fakes/fake-mcp-calendar.ts. No real binary, no key, no model and no Google account is ever involved -
// and the Google sign-in leg is deliberately NOT clicked (see the last test).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFakeLlamaServer, type FakeLlamaServer } from '../fakes/fake-llama-server.ts';
import { attachBridge, freePort, llamaCmdSeam, mcpChild, newBridgeToken } from './helpers/fakes.ts';
import {
  bridgeCmdSeam,
  control,
  expect,
  hasHook,
  readChildPids,
  test,
  waitForControl,
  type E2eContext,
} from './helpers/fixtures.ts';
import { SEED_CHAT_JID, SEED_CHAT_NAME, seedProfile } from './helpers/seedProfile.ts';

const HW = JSON.stringify({ ramGiB: 32, freeDiskGiB: 400, gpus: [{ name: 'NVIDIA GeForce RTX 4060', vramGiB: 8 }] });
const FAST_TIMERS = JSON.stringify({
  scanMs: 500,
  debounceMs: 100,
  pairingPollMs: 300,
  healthPollMs: 500,
  coachMarkMs: 200,
});

function metaOf(userDataDir: string, key: string): string | null {
  const file = join(userDataDir, 'app.db');
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

function countOf(userDataDir: string, table: string): number {
  const file = join(userDataDir, 'app.db');
  if (!existsSync(file)) return 0;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function consentKinds(userDataDir: string): string[] {
  const db = new DatabaseSync(join(userDataDir, 'app.db'), { readOnly: true });
  try {
    return (db.prepare('SELECT kind FROM consents').all() as unknown as Array<{ kind: string }>).map((r) => r.kind);
  } finally {
    db.close();
  }
}

/** The fake GGUF host + the fake llama-server, as the two seams the wizard needs. */
async function localModelSeams(ctx: E2eContext): Promise<{ env: Record<string, string>; llama: FakeLlamaServer }> {
  const llama = await startFakeLlamaServer({ apiKey: 'unused-in-host-mode' });
  ctx.onStop(() => llama.stop());
  const entry = (tier: 'tiny' | 'small' | 'mid') => ({
    tier,
    label: `fake-${tier}`,
    fileName: `fake-${tier}.gguf`,
    url: llama.modelUrl(),
    size: llama.modelSize,
    sha256: llama.modelSha256,
  });
  const manifestFile = ctx.writeTempFile(
    'model-manifest.json',
    JSON.stringify({ tiny: entry('tiny'), small: entry('small'), mid: entry('mid') }),
  );
  return { env: { WCA_MODEL_MANIFEST: manifestFile, WCA_HW: HW, ...llamaCmdSeam() }, llama };
}

test('Welcome runs nothing before the disclosure is accepted, then the local model starts downloading', async ({
  e2e,
}) => {
  const userDataDir = e2e.newProfileDir('onboarding');
  seedProfile({ userDataDir, onboardingStep: 'welcome', tosAccepted: false, pairedAt: null });

  const controlPort = await freePort();
  const controlSecret = newBridgeToken();
  const mcp = mcpChild(e2e, 'onboarding');
  const local = await localModelSeams(e2e);

  const launched = await e2e.launch({
    userDataDir,
    env: {
      WCA_BRIDGE_CMD: bridgeCmdSeam(controlPort, controlSecret, 'needs_pairing'),
      ...mcp.env,
      ...local.env,
      WCA_TIMERS: FAST_TIMERS,
    },
  });
  const page = launched.page;
  expect(page).not.toBeNull();
  if (page === null) return;

  // ---- Welcome: nothing may run before the disclosure is accepted ---------------------------------------------
  await expect(page.getByTestId('onboarding-welcome')).toBeVisible();
  expect(readChildPids(userDataDir), 'no child process exists before the ToS is accepted').toEqual({});
  expect(existsSync(join(userDataDir, 'run', 'bridge.pid.json'))).toBe(false);
  const controlReachable = await control(controlPort, controlSecret, 'setConnected', { up: true }).then(
    () => true,
    () => false,
  );
  expect(controlReachable, 'the fake bridge was never started, so its control port is dead').toBe(false);

  // the language toggle of the Welcome step works before anything else does
  await page.getByTestId('welcome-language-he').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByTestId('welcome-language-en').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

  await expect(page.getByTestId('welcome-start')).toBeDisabled();
  await page.getByTestId('welcome-accept').click();
  await page.getByTestId('welcome-start').click();

  // ---- Choose AI: the recommended local tier downloads from the fake host --------------------------------------
  await expect(page.getByTestId('onboarding-choose-ai')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('choose-ai-local').click();
  await expect(page.getByTestId('ai-local-body')).toBeVisible();
  await page.getByTestId('ai-download').click();
  // UX 8.1: the wizard moves on at once and the download keeps running in the background.
  await expect(page.getByTestId('download-pill')).toBeVisible({ timeout: 20_000 });

  await expect(page.getByTestId('onboarding-link-whatsapp')).toBeVisible({ timeout: 20_000 });
});

/**
 * TESTS 10, the pairing leg. On a fresh profile the bridge is started by the `consent:accept` wrapper in `compose()`
 * (a recorded `whatsapp_tos` consent -> `startBridge()`, ops/agent-notes/repair-compose-defects.md 1.1), which is
 * exactly what the first half below proves end to end.
 *
 * The "new code" click is a REAL restart of the bridge child: `pairing:newCode` -> `bridgeControl.restartForNewCode()`
 * = stop + `launcher.restartForNewCode()` + start (`src/main/compose.ts`). In child mode the fake's control server
 * lives inside that child, so it dies with the old process and comes back on the same port with the new one - the spec
 * waits for the NEW pid and for its control server before driving it (see `waitForControl` in helpers/fixtures.ts).
 */
test('accepting the disclosure starts the bridge, and the QR can be scanned, expired and re-issued', async ({
  e2e,
}) => {
  const userDataDir = e2e.newProfileDir('onboarding-pair');
  seedProfile({ userDataDir, onboardingStep: 'welcome', tosAccepted: false, pairedAt: null });
  const controlPort = await freePort();
  const controlSecret = newBridgeToken();
  const local = await localModelSeams(e2e);
  const launched = await e2e.launch({
    userDataDir,
    env: {
      WCA_BRIDGE_CMD: bridgeCmdSeam(controlPort, controlSecret, 'needs_pairing'),
      ...local.env,
      WCA_TIMERS: FAST_TIMERS,
    },
  });
  const page = launched.page;
  expect(page).not.toBeNull();
  if (page === null) return;

  await page.getByTestId('welcome-accept').click();
  await page.getByTestId('welcome-start').click();
  await expect(page.getByTestId('onboarding-choose-ai')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('choose-ai-local').click();
  await page.getByTestId('ai-download').click();
  await expect(page.getByTestId('onboarding-link-whatsapp')).toBeVisible({ timeout: 20_000 });

  // ---- Link WhatsApp: the bridge must be running now, and the QR is a data: image -----------------------------
  await expect.poll(() => Object.keys(readChildPids(userDataDir)), { timeout: 30_000 }).toContain('bridge');
  const qr = page.getByTestId('qr-image');
  await expect(qr).toBeVisible({ timeout: 30_000 });
  const src = (await qr.getAttribute('src')) ?? '';
  expect(src.startsWith('data:image/'), 'the QR is inlined, never loaded over http').toBe(true);
  await expect(page.getByTestId('qr-countdown')).toBeVisible();
  await e2e.screenshot(page, 'onboarding-qr');

  // an expired code offers a new one
  await control(controlPort, controlSecret, 'setPairing', { phase: 'timeout' });
  await expect(page.getByTestId('qr-new-code')).toBeVisible({ timeout: 30_000 });
  const pidBeforeNewCode = readChildPids(userDataDir).bridge;
  expect(pidBeforeNewCode, 'the bridge child is tracked before the restart').toBeGreaterThan(0);
  await page.getByTestId('qr-new-code').click();
  // The product restarts the bridge child (kill + respawn with a fresh port, token and doorbell secret). The Supervisor
  // removes the pid file on exit and writes a new one on spawn, so a DIFFERENT bridge pid is the proof the old child is
  // gone and the new one is up; only then can its control server (inside the child) be waited for and driven.
  await expect.poll(() => readChildPids(userDataDir).bridge ?? null, { timeout: 30_000 }).not.toEqual(pidBeforeNewCode);
  await expect.poll(() => readChildPids(userDataDir).bridge ?? null, { timeout: 30_000 }).not.toBeNull();
  await waitForControl(controlPort, controlSecret, 30_000);
  await control(controlPort, controlSecret, 'setPairing', { phase: 'qr_pending' });
  await expect(page.getByTestId('qr-image')).toBeVisible({ timeout: 30_000 });

  // pairing succeeds: paired_at is recorded and older messages are ignored from here on
  await control(controlPort, controlSecret, 'setPairing', { phase: 'connected' });
  await expect(page.getByTestId('qr-connected')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => metaOf(userDataDir, 'paired_at'), { timeout: 20_000 }).not.toBeNull();
  await page.getByTestId('pairing-continue').click();
  await expect(page.getByTestId('onboarding-google')).toBeVisible({ timeout: 20_000 });
});

for (const lang of ['en', 'he'] as const) {
  test(`the Google step offers "Later" and the Ready checklist hands over to a reply-only dashboard (${lang})`, async ({
    e2e,
  }) => {
    // Entered at the Google step so the pairing defect above cannot mask this leg; the profile is otherwise identical
    // to the one the previous two tests build by clicking. Run in both languages: TESTS 9 asks for a screenshot of
    // every view in both languages, and the wizard has no language toggle after the Welcome step.
    const userDataDir = e2e.newProfileDir(`onboarding-google-later-${lang}`);
    seedProfile({ userDataDir, onboardingStep: 'google', tosAccepted: true, settings: { language: lang } });
    const bridge = await attachBridge(e2e, userDataDir);
    const local = await localModelSeams(e2e);
    const launched = await e2e.launch({
      userDataDir,
      env: { ...bridge.env, ...local.env, WCA_TIMERS: FAST_TIMERS },
    });
    const page = launched.page;
    expect(page).not.toBeNull();
    if (page === null) return;

    await expect(page.locator('html')).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
    await expect(page.getByTestId('onboarding-google')).toBeVisible({ timeout: 20_000 });
    await e2e.screenshot(page, `onboarding-google-${lang}`);
    await page.getByTestId('google-later').click();

    await expect(page.getByTestId('onboarding-ready')).toBeVisible({ timeout: 20_000 });
    await e2e.screenshot(page, `onboarding-ready-${lang}`);
    await page.getByTestId('ready-open').click();
    await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByTestId('setup-strip-calendar'),
      'a reply-only setup keeps offering the calendar',
    ).toBeVisible();
    expect(metaOf(userDataDir, 'onboarding_step')).toBe('done');
  });
}

test('a history sync after pairing produces zero cards', async ({ e2e }) => {
  // ATTACH mode: the assertion - older messages are ignored - is about `live_from_ts`, not about the transport, and the
  // in-process fake takes the 300 rows as real `Date`s with no JSON round trip. (The child-mode control server exposes a
  // `historySync` verb too, since ops/agent-notes/repair-test-fakes.md; it is simply not needed here.)
  const userDataDir = e2e.newProfileDir('history');
  const pairedAt = Date.now();
  seedProfile({
    userDataDir,
    onboardingStep: 'done',
    pairedAt: pairedAt as never,
    chats: [{ jid: SEED_CHAT_JID, name: SEED_CHAT_NAME }],
  });
  const bridge = await attachBridge(e2e, userDataDir);

  // The history lands in `messages.db` before the app opens it: whatsmeow writes the backlog as soon as the phone is
  // linked, and writing it while the app holds the file open only produces SQLITE_BUSY noise, not a better assertion.
  await bridge.fake.historySync(
    Array.from({ length: 300 }, (_, i) => ({
      chatJid: SEED_CHAT_JID,
      text: `history ${i}`,
      ts: new Date(pairedAt - (i + 1) * 60_000),
      fromMe: i % 2 === 0,
    })),
  );

  const launched = await e2e.launch({ userDataDir, env: { ...bridge.env, WCA_TIMERS: FAST_TIMERS } });
  expect(launched.page).not.toBeNull();
  if (launched.page === null) return;
  await launched.page.waitForTimeout(4_000);
  expect(countOf(userDataDir, 'items'), 'a history sync never produces a card').toBe(0);
  expect(bridge.fake.sent, 'and it certainly never sends anything').toHaveLength(0);
});

test('the wizard resumes at the step it was killed on', async ({ e2e }) => {
  const userDataDir = e2e.newProfileDir('onboarding-resume');
  seedProfile({ userDataDir, onboardingStep: 'welcome', tosAccepted: false, pairedAt: null });
  const local = await localModelSeams(e2e);
  const mcp = mcpChild(e2e, 'resume');
  const controlPort = await freePort();
  const controlSecret = newBridgeToken();
  const env = {
    WCA_BRIDGE_CMD: bridgeCmdSeam(controlPort, controlSecret, 'needs_pairing'),
    ...mcp.env,
    ...local.env,
    WCA_TIMERS: FAST_TIMERS,
  };

  const first = await e2e.launch({ userDataDir, env });
  expect(first.page).not.toBeNull();
  if (first.page === null) return;
  await first.page.getByTestId('welcome-accept').click();
  await first.page.getByTestId('welcome-start').click();
  await expect(first.page.getByTestId('onboarding-choose-ai')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => metaOf(userDataDir, 'onboarding_step'), { timeout: 20_000 }).toBe('choose_ai');

  await e2e.quit(first);

  const second = await e2e.launch({ userDataDir, env });
  expect(second.page).not.toBeNull();
  if (second.page === null) return;
  await expect(second.page.getByTestId('onboarding-choose-ai'), 'the wizard resumed where it stopped').toBeVisible({
    timeout: 20_000,
  });
});

test('choosing a cloud provider blocks on the consent dialog, and declining writes no consent row', async ({ e2e }) => {
  const userDataDir = e2e.newProfileDir('onboarding-consent');
  seedProfile({ userDataDir, onboardingStep: 'choose_ai', tosAccepted: true, pairedAt: null });
  const local = await localModelSeams(e2e);
  const bridge = await attachBridge(e2e, userDataDir);
  const launched = await e2e.launch({ userDataDir, env: { ...bridge.env, ...local.env, WCA_TIMERS: FAST_TIMERS } });
  const page = launched.page;
  expect(page).not.toBeNull();
  if (page === null) return;

  await expect(page.getByTestId('onboarding-choose-ai')).toBeVisible({ timeout: 20_000 });
  await e2e.screenshot(page, 'onboarding-choose-ai-en');
  // [V2] UX2 4.1 / 6: the API-key cards (Claude / Gemini with a key) sit behind the "Advanced: use an API key" disclosure; the
  // visible cards are Local and "Claude - your subscription". The disclosure starts closed, so the user opens it first.
  await expect(page.getByTestId('ai-advanced')).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('ai-advanced').click();
  await page.getByTestId('choose-ai-claude').click();
  await expect(page.getByTestId('consent-dialog'), 'a cloud provider always asks first').toBeVisible({
    timeout: 20_000,
  });
  await e2e.screenshot(page, 'onboarding-consent');
  await page.getByTestId('consent-cancel').click();

  await expect(page.getByTestId('consent-dialog')).toHaveCount(0);
  expect(consentKinds(userDataDir), 'declining records nothing').not.toContain('cloud_claude');
  // No key field can even be reached, so no cloud request can have happened.
  await expect(page.getByTestId('ai-key-input')).toHaveCount(0);
});

test('the Choose AI step renders right-to-left in Hebrew', async ({ e2e }) => {
  const userDataDir = e2e.newProfileDir('onboarding-choose-ai-he');
  seedProfile({
    userDataDir,
    onboardingStep: 'choose_ai',
    tosAccepted: true,
    pairedAt: null,
    settings: { language: 'he' },
  });
  const local = await localModelSeams(e2e);
  const bridge = await attachBridge(e2e, userDataDir);
  const launched = await e2e.launch({ userDataDir, env: { ...bridge.env, ...local.env, WCA_TIMERS: FAST_TIMERS } });
  const page = launched.page;
  expect(page).not.toBeNull();
  if (page === null) return;

  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('onboarding-choose-ai')).toBeVisible({ timeout: 20_000 });
  await e2e.screenshot(page, 'onboarding-choose-ai-he');
});

/**
 * TESTS 10, the Google "Start" leg. `shell.openExternal` is replaced by a recorder in e2e mode
 * (`src/main/index.ts`, ops/agent-notes/repair-compose-defects.md 1.5) and the recorder is read through
 * `__wcaTest.openedExternal`. The test asserts that guard is in place before anything could be clicked: a test must
 * never open a real browser at Google, so the hook's absence is a hard stop, not a skipped step. Clicking "Sign in" and
 * asserting on the recorded URL is a possible extension of this leg, not part of it today.
 */
test('the Google sign-in leg records the opened URL instead of opening a browser', async ({ e2e }) => {
  const userDataDir = e2e.newProfileDir('onboarding-google');
  seedProfile({
    userDataDir,
    onboardingStep: 'google',
    tosAccepted: true,
    chats: [{ jid: SEED_CHAT_JID, name: SEED_CHAT_NAME }],
  });
  const bridge = await attachBridge(e2e, userDataDir);
  const mcp = mcpChild(e2e, 'google');
  const launched = await e2e.launch({ userDataDir, env: { ...bridge.env, ...mcp.env, WCA_TIMERS: FAST_TIMERS } });
  expect(launched.page).not.toBeNull();

  expect(
    await hasHook(launched.app, 'openedExternal'),
    '__wcaTest.openedExternal is not installed, so an e2e run cannot prove that the OAuth URL was recorded instead ' +
      'of opened. Nothing is clicked until it is: a test must never open a real browser at Google.',
  ).toBe(true);
});
