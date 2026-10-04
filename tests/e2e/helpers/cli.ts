// tests/e2e/helpers/cli.ts - the vendor-CLI world of `cli-connect.spec.ts` (T2 10; owner V2-W2-03).
//
// The CLIs are ALWAYS the fakes (`tests/fakes/fake-claude-cli.mjs`, `fake-agy.mjs`) started by the app's own JobRunner with the system
// node.exe through WCA_CLI_CMD (T8): the dev PC has the user's signed-in claude.exe installed, and nothing here may ever run it. Every
// launch gets the spec's temp "fake home" as USERPROFILE / HOMEDRIVE+HOMEPATH / APPDATA / LOCALAPPDATA (T9), and a DECOY
// `<fake home>\.local\bin\claude.exe` (an empty file - not a program) proves that the e2e build resolves the CLI from WCA_CLI_CMD
// only: a disk probe would find the decoy and report something other than `not_installed`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import type { ConsentKind, ProviderId } from '../../../src/shared/types.ts';
import { attachBridge, cliFakes, dialogScript, mcpChild, type AttachedBridge, type CliFakes } from './fakes.ts';
import { expect, type E2eContext } from './fixtures.ts';
import { seedGoogleCredentials, seedProfile } from './seedProfile.ts';
import { AppClock, E2E_NOW_MS, FAST_TIMERS_ENV, jid, openSettings } from './v2.ts';

export interface CliWorld {
  e2e: E2eContext;
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  bridge: AttachedBridge;
  cli: CliFakes;
  clock: AppClock;
  decoy: string;
}

export function plantDecoyClaudeExe(fakeHome: string): string {
  const dir = join(fakeHome, '.local', 'bin');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'claude.exe');
  writeFileSync(file, ''); // zero bytes: not a program, so even a wrong spawn could not run anything
  return file;
}

export async function launchCliWorld(
  e2e: E2eContext,
  label: string,
  opts: Parameters<typeof cliFakes>[1] & {
    provider?: ProviderId;
    consents?: ConsentKind[];
    dialog?: Parameters<typeof dialogScript>[0];
    chats?: number[];
    beforeLaunch?: () => void;
  },
): Promise<CliWorld> {
  const userDataDir = e2e.newProfileDir(label);
  const clock = new AppClock();
  const chats = opts.chats ?? [60, 61];
  seedProfile({
    userDataDir,
    onboardingStep: 'done',
    now: (E2E_NOW_MS - 2 * 3_600_000) as never,
    settings: {
      provider: opts.provider ?? 'local',
      targetCalendarId: 'primary',
      timeZone: 'Asia/Jerusalem',
      language: 'en',
    },
    chats: chats.map((n) => ({ jid: jid(n), name: `Contact ${String(n)}` })),
    meta: { calendar_roles_json: JSON.stringify({ primary: 'owner' }) },
    ...(opts.consents === undefined ? {} : { consents: opts.consents }),
  });
  seedGoogleCredentials(userDataDir);
  const decoy = plantDecoyClaudeExe(e2e.fakeHome);
  opts.beforeLaunch?.();
  const bridge = await attachBridge(e2e, userDataDir);
  const mcp = mcpChild(e2e, label, undefined, userDataDir);
  const cli = cliFakes(e2e, { ...opts, label, userDataDir });
  clock.markLaunch();
  const launched = await e2e.launch({
    userDataDir,
    env: {
      ...bridge.env,
      ...mcp.env,
      ...cli.env,
      ...clock.env(),
      ...(opts.dialog === undefined ? {} : dialogScript(opts.dialog)),
      WCA_TIMERS: FAST_TIMERS_ENV,
      WCA_FOCUS_CHECK: 'visible-only',
    },
  });
  if (launched.page === null) throw new Error('no window');
  e2e.sentinels.push(bridge.token, ...chats.map(jid));
  return { e2e, app: launched.app, page: launched.page, userDataDir, bridge, cli, clock, decoy };
}

/** Settings > AI engine, the subscription card of `provider` (the embedded onboarding cards, UX2 4.1). */
export async function openAiCard(page: Page, provider: 'claude_cli' | 'antigravity_cli'): Promise<void> {
  await openSettings(page);
  if (provider === 'antigravity_cli' && (await page.getByTestId('ai-card-antigravity_cli').count()) === 0) {
    await page.getByTestId('ai-show-experimental').click();
  }
  await page.getByTestId(`ai-card-${provider}`).scrollIntoViewIfNeeded();
  await expect(page.getByTestId(`connect-${provider}`)).toBeVisible({ timeout: 30_000 });
}

export async function connectState(page: Page, provider: 'claude_cli' | 'antigravity_cli'): Promise<string | null> {
  return page.getByTestId(`connect-${provider}`).getAttribute('data-state');
}

/** Lines of a fake journal whose stage is one of `stages` (the fakes journal stage from argv, never from the prompt text). */
export function runsOf(journal: Array<Record<string, unknown>>, ...stages: string[]): Array<Record<string, unknown>> {
  return journal.filter((e) => stages.includes(String(e.stage)));
}
