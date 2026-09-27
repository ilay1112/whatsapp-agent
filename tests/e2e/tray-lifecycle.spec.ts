// tests/e2e/tray-lifecycle.spec.ts - TESTS section 10, row `tray-lifecycle.spec.ts`. Owner W2-03.
// Bridge mode: CHILD (`WCA_BRIDGE_CMD` -> the system `node` runs tests/fakes/fake-bridge.ts) plus `WCA_MCP_CMD`
// (tests/fakes/fake-mcp-calendar.ts). The real `whatsapp-bridge.exe` and the real calendar server are never spawned.
//
// Covered here: close-to-tray and the one-time coach mark, re-show from the tray, a hidden start, the tray menu and its
// status line following health, Pause, the quit sequence (children dead, pid files gone, exit code 0) and the reaper's
// refusal to kill a process a pid file merely points at.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  bridgeCmdSeam,
  control,
  expect,
  isAlive,
  readChildPids,
  test,
  waitUntilGone,
  wca,
  type LaunchedApp,
} from './helpers/fixtures.ts';
import { attachBridge, freePort, mcpChild, newBridgeToken } from './helpers/fakes.ts';
import { SEED_CHAT_JID, SEED_CHAT_NAME, seedGoogleCredentials, seedProfile } from './helpers/seedProfile.ts';

const TRAY_IDS = ['open', 'status', 'sep', 'pause', 'settings', 'sep', 'quit'];
const EN = JSON.parse(readFileSync(new URL('../../src/shared/locales/en.json', import.meta.url), 'utf8')) as {
  tray: { open: string; pause: string; resume: string; settings: string; quit: string; status: Record<string, string> };
};

interface ChildBridge {
  env: Record<string, string>;
  port: number;
  secret: string;
}

/** `WCA_BRIDGE_CMD` + a private control port, so the spec can drive the fake that the APP spawned. */
async function childBridge(scenario?: string): Promise<ChildBridge> {
  const port = await freePort();
  const secret = newBridgeToken();
  return { env: { WCA_BRIDGE_CMD: bridgeCmdSeam(port, secret, scenario) }, port, secret };
}

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

function settingsOf(userDataDir: string): Record<string, unknown> {
  const db = new DatabaseSync(join(userDataDir, 'app.db'), { readOnly: true });
  try {
    const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get('settings') as
      { value_json?: string } | undefined;
    return row?.value_json === undefined ? {} : (JSON.parse(row.value_json) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

async function windowState(launched: LaunchedApp): Promise<{ count: number; visible: boolean; focused: boolean }> {
  return launched.app.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows();
    const win = wins[0];
    return {
      count: wins.length,
      visible: win !== undefined && win.isVisible(),
      focused: win !== undefined && win.isFocused(),
    };
  });
}

test('close hides to the tray within 200 ms, shows the coach mark exactly once, and the tray re-opens it', async ({
  e2e,
}) => {
  const userDataDir = e2e.newProfileDir('tray');
  seedProfile({ userDataDir, onboardingStep: 'done', chats: [{ jid: SEED_CHAT_JID, name: SEED_CHAT_NAME }] });
  const bridge = await attachBridge(e2e, userDataDir);
  const launched = await e2e.launch({ userDataDir, env: bridge.env });
  const page = launched.page;
  expect(page).not.toBeNull();
  if (page === null) return;

  expect(metaOf(userDataDir, 'tray_hint_seen'), 'a fresh profile has not seen the hint').toBeNull();

  // ---- (1) first close: hidden, alive -------------------------------------------------------------------------
  const hiddenWithinMs = await launched.app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win === undefined) throw new Error('no window');
    const startedAt = Date.now();
    win.close();
    for (let i = 0; i < 40; i += 1) {
      if (!win.isDestroyed() && !win.isVisible()) return Date.now() - startedAt;
      await new Promise((r) => setTimeout(r, 10));
    }
    return -1;
  });
  expect(hiddenWithinMs, 'the first close hides the window instead of quitting').toBeGreaterThanOrEqual(0);
  expect(hiddenWithinMs, 'the first close hides within 200 ms').toBeLessThanOrEqual(200);
  expect(launched.closed, 'the app is still running after the close').toBe(false);
  expect(metaOf(userDataDir, 'tray_hint_seen'), 'the first hide records the coach mark').toBe('1');

  // ---- (2) the tray re-shows the window, and the coach mark appears once ---------------------------------------
  await wca(launched.app).trayClick('open');
  await expect.poll(async () => (await windowState(launched)).visible, { timeout: 10_000 }).toBe(true);
  await expect(page.getByTestId('coach-mark')).toBeVisible();
  await page.getByTestId('coach-mark-ack').click();
  await expect(page.getByTestId('coach-mark')).toHaveCount(0);

  // second close -> no second coach mark
  await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect.poll(async () => (await windowState(launched)).visible, { timeout: 10_000 }).toBe(false);
  await wca(launched.app).trayClick('open');
  await expect.poll(async () => (await windowState(launched)).visible, { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('coach-mark'), 'the coach mark is shown exactly once').toHaveCount(0);
});

test('a --hidden start paints no window but builds the tray', async ({ e2e }) => {
  const userDataDir = e2e.newProfileDir('tray-hidden');
  seedProfile({ userDataDir, onboardingStep: 'done' });
  const bridge = await attachBridge(e2e, userDataDir);
  const launched = await e2e.launch({ userDataDir, env: bridge.env, argv: ['--hidden'], expectWindow: false });

  await expect.poll(async () => (await windowState(launched)).count, { timeout: 30_000 }).toBe(1);
  expect((await windowState(launched)).visible, 'a --hidden start shows nothing').toBe(false);
  const template = await wca(launched.app).trayTemplate();
  expect(
    template.map((i) => i.id),
    'the tray exists even with no window on screen',
  ).toEqual(TRAY_IDS);
});

// TESTS 10 scenario (3). `src/main/index.ts` takes `app.requestSingleInstanceLock()` unconditionally (e2e mode too: the
// lock is per-userData and every launch has its own temp profile), quits at once when it loses it, and the holder's
// `second-instance` handler shows + focuses its window. The second instance therefore exits within milliseconds -
// before Playwright could finish attaching to it - so it is started as a RAW child process with the fixture's own
// executable, argv and env (`E2eContext.spawnRaw`) and asserted on its exit code, not through `electron.launch`.
test('a second launch on the same profile exits and re-shows the first window', async ({ e2e }) => {
  const userDataDir = e2e.newProfileDir('single-instance');
  seedProfile({ userDataDir, onboardingStep: 'done' });
  const bridge = await attachBridge(e2e, userDataDir);
  const first = await e2e.launch({ userDataDir, env: bridge.env });
  expect(first.page).not.toBeNull();

  // Hide the first window so the second instance has something to do.
  await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
  await expect.poll(async () => (await windowState(first)).visible, { timeout: 10_000 }).toBe(false);

  const childPidsBefore = readChildPids(userDataDir);
  const second = e2e.spawnRaw({ userDataDir, env: bridge.env });
  expect(second.pid, 'the second instance was spawned').toBeGreaterThan(0);
  // the second instance must quit by itself, cleanly, without ever becoming a second full instance
  await expect.poll(() => second.exitCode ?? second.signal, { timeout: 20_000 }).not.toBeNull();
  expect(second.signal, `the second instance was not killed (stderr: ${second.stderr.slice(0, 500)})`).toBeNull();
  expect(second.exitCode, `the second instance exits 0 (stderr: ${second.stderr.slice(0, 500)})`).toBe(0);
  expect(readChildPids(userDataDir), 'the second instance started no child of its own').toEqual(childPidsBefore);

  // ...and the holder of the lock reacted: the hidden window is back and focused.
  await expect.poll(async () => (await windowState(first)).visible, { timeout: 10_000 }).toBe(true);
  expect((await windowState(first)).focused, 'the surviving window is focused').toBe(true);
  expect((await windowState(first)).count, 'still exactly one window').toBe(1);
  expect(first.closed, 'the first instance is still running').toBe(false);
});

test('the tray menu follows health and Pause, and the quit sequence kills every child', async ({ e2e }) => {
  const userDataDir = e2e.newProfileDir('tray-child');
  seedProfile({ userDataDir, onboardingStep: 'done', chats: [{ jid: SEED_CHAT_JID, name: SEED_CHAT_NAME }] });
  seedGoogleCredentials(userDataDir); // so the (fake) calendar MCP is a real child too - scenario (7) needs two of them
  const bridge = await childBridge();
  const mcp = mcpChild(e2e, 'tray');

  const launched = await e2e.launch({
    userDataDir,
    env: { ...bridge.env, ...mcp.env, WCA_TIMERS: '{"healthPollMs":500,"pairingPollMs":500}' },
  });
  expect(launched.page).not.toBeNull();

  // ---- (5) the menu is Open / status / Pause / Settings / Quit --------------------------------------------------
  const template = await wca(launched.app).trayTemplate();
  expect(template.map((i) => i.id)).toEqual(TRAY_IDS);
  const labelOf = (id: string): string => template.find((i) => i.id === id)?.label ?? '';
  expect(labelOf('open')).toBe(EN.tray.open);
  expect(labelOf('settings')).toBe(EN.tray.settings);
  expect(labelOf('quit')).toBe(EN.tray.quit);
  expect(labelOf('pause')).toBe(EN.tray.pause);
  expect(template.find((i) => i.id === 'status')?.enabled, 'the status line is not clickable').toBe(false);

  // the app spawned the fake bridge as a real child process
  await expect.poll(() => Object.keys(readChildPids(userDataDir)), { timeout: 30_000 }).toContain('bridge');
  await expect.poll(() => Object.keys(readChildPids(userDataDir)), { timeout: 30_000 }).toContain('calendar-mcp');
  const bridgePid = readChildPids(userDataDir).bridge as number;
  expect(isAlive(bridgePid)).toBe(true);
  // the child MCP server really is the fake, and it was handed no secret
  expect(
    mcp.entries().some((e) => e.kind === 'argv'),
    'the fake calendar server is the one that started',
  ).toBe(true);

  const statusLabel = async (): Promise<string> =>
    (await wca(launched.app).trayTemplate()).find((i) => i.id === 'status')?.label ?? '';
  await expect.poll(statusLabel, { timeout: 30_000 }).toBe(EN.tray.status.active_local);

  // ---- (5b) the status line follows health: the bridge dies -> "WhatsApp offline" ------------------------------
  await control(bridge.port, bridge.secret, 'exit');
  await expect.poll(statusLabel, { timeout: 30_000 }).toBe(EN.tray.status.wa_offline);

  // ---- (5c) Pause flips the label and the stored setting -------------------------------------------------------
  await wca(launched.app).trayClick('pause');
  await expect
    .poll(async () => (await wca(launched.app).trayTemplate()).find((i) => i.id === 'pause')?.label, {
      timeout: 10_000,
    })
    .toBe(EN.tray.resume);
  const agent = settingsOf(userDataDir).agent as { paused?: boolean } | undefined;
  expect(agent?.paused, 'Pause is persisted, not just drawn').toBe(true);
  await wca(launched.app).trayClick('pause');
  await expect
    .poll(async () => (await wca(launched.app).trayTemplate()).find((i) => i.id === 'pause')?.label, {
      timeout: 10_000,
    })
    .toBe(EN.tray.pause);

  // ---- (6) no message text anywhere in the menu ----------------------------------------------------------------
  const menuText = (await wca(launched.app).trayTemplate()).map((i) => i.label ?? '').join(' ');
  expect(menuText).not.toContain(SEED_CHAT_NAME);
  expect(menuText).not.toContain(SEED_CHAT_JID);
  e2e.sentinels.push(SEED_CHAT_NAME, SEED_CHAT_JID);

  // ---- (7) quit: every child PID is gone, no pid file is left, exit code 0 --------------------------------------
  const pidsBeforeQuit = readChildPids(userDataDir);
  await e2e.quit(launched);
  for (const [name, pid] of Object.entries(pidsBeforeQuit)) {
    expect(isAlive(pid), `child ${name} (pid ${pid}) is dead after Quit`).toBe(false);
  }
  const runDir = join(userDataDir, 'run');
  const leftover = existsSync(runDir) ? readdirSync(runDir).filter((f) => f.endsWith('.pid.json')) : [];
  expect(leftover, 'the quit sequence removes every pid file').toEqual([]);
  await expect.poll(() => launched.exitCode, { timeout: 10_000 }).toBe(0);
});

test('a pid file pointing at an unrelated process is discarded, never killed', async ({ e2e }) => {
  // TESTS 10 scenario (8), decoy half. The reaping half of that scenario cannot be driven through the
  // `WCA_BRIDGE_CMD` seam: `parsePidFile` only accepts an `exePath` inside the app's own resources dir or equal to the
  // app's `execPath` (electron.exe), and the seam's child is the system `node.exe`, so an orphaned SEAM child is always
  // discarded as stale rather than reaped. The kill path itself is covered at L2 by W1-01's reaper tests; what this
  // spec can prove end to end is the safety half: a live process a pid file points at is NOT killed, and the file is
  // cleaned up. See ops/agent-notes/W2-03-e2e.md.
  const userDataDir = e2e.newProfileDir('reaper');
  seedProfile({ userDataDir, onboardingStep: 'done' });
  const bridge = await attachBridge(e2e, userDataDir);

  // An unrelated, innocent process: plain `node` idling. It must survive the launch.
  const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const decoyPid = decoy.pid ?? 0;
  expect(decoyPid).toBeGreaterThan(0);
  e2e.onStop(() => {
    try {
      decoy.kill();
    } catch {
      /* already gone */
    }
  });

  const runDir = join(userDataDir, 'run');
  writeFileSync(
    join(runDir, 'bridge.pid.json'),
    JSON.stringify({ pid: decoyPid, exePath: process.execPath, startedAt: Date.now() - 5_000 }),
    'utf8',
  );

  const launched = await e2e.launch({ userDataDir, env: bridge.env });
  expect(launched.page).not.toBeNull();

  // The decoy is a different image in a different directory and its start time does not match: it stays alive.
  await new Promise((r) => setTimeout(r, 1_500));
  expect(isAlive(decoyPid), 'the reaper must never kill a process it cannot prove is ours').toBe(true);

  // ...and the stale record does not survive the boot.
  await expect
    .poll(() => (existsSync(join(runDir, 'bridge.pid.json')) ? 'present' : 'gone'), { timeout: 15_000 })
    .toBe('gone');

  decoy.kill();
  await waitUntilGone(decoyPid, 5_000);
});
