// tests/e2e/helpers/auto.ts - the automatic-mode world of the L5 specs (T2 10 `auto-mode.spec.ts`, `undo.spec.ts`; owner V2-W2-03).
//
// Automatic mode is reached ONLY through the UI (T2 4.1 "Not seams"): three real click approvals of create cards (the track record),
// "Start a 24-hour trial" in Settings > Automatic mode, the main-owned native dialog answered by WCA_DIALOG_SCRIPT (the real options
// object is still built and recorded), three shadow decisions, then "End trial". No env var, seed or hook can create a policy row.
//
// Every scheduling message asks for its OWN slot (Thursday 09:00 + n hours, 20 min) in its OWN chat: a second request for the same
// slot is a genuine free/busy conflict (AutoGate `badge_amber`), and a second automatic write in one chat within 30 minutes is the
// per-chat budget (`auto_budget`, which also pauses the policy). Each chat gets the user's own "hey" an hour earlier, because an
// automatic write needs recent user participation in the chat (`no_user_participation`).
import type { ElectronApplication, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { attachBridge, dialogScript, mcpChild, type AttachedBridge, type McpChild } from './fakes.ts';
import { expect, wca, type E2eContext } from './fixtures.ts';
import { seedGoogleCredentials, seedProfile } from './seedProfile.ts';
import {
  actionsOfItem,
  anchorDate,
  AppClock,
  backToDashboard,
  cardOfChat,
  E2E_NOW_MS,
  extraction,
  FAST_TIMERS_ENV,
  jid,
  openSettings,
} from './v2.ts';

/** Thursday in the week of the E2E_NOW anchor (a Monday). */
export const SLOT_WEEKDAY = 4;
export const HOUR_MS = 3_600_000;

/** The marker that ties a message to its scripted answer (the stub matches `when.contains` on the message text). */
export function token(n: number): string {
  return `[s${String(n)}]`;
}
export function schedulingText(n: number): string {
  return `Dentist on Thursday? ${token(n)}`;
}
export function slotOf(n: number): { startLocal: string; endLocal: string } {
  const hh = String(8 + n).padStart(2, '0');
  return { startLocal: `${anchorDate(3)}T${hh}:00`, endLocal: `${anchorDate(3)}T${hh}:20` };
}

/** WCA_LLM_SCRIPT rules: chat n -> a confident, clean create for its own slot; anything else -> nothing to schedule. */
export function autoStubRules(chats: number[]): unknown[] {
  return [
    ...chats.map((n) => ({
      when: { purpose: 'extract', contains: token(n) },
      respond: {
        structured: extraction({
          intent: 'schedule_request',
          title: 'Dentist',
          dateKind: 'weekday',
          weekday: SLOT_WEEKDAY,
          time24h: `${String(8 + n).padStart(2, '0')}:00`,
          durationMin: 20,
          confidence: 'high',
        }),
      },
    })),
    {
      when: { purpose: 'extract' },
      respond: {
        structured: extraction({ intent: 'other', needsReply: false, title: '', durationMin: 0, confidence: 'low' }),
      },
    },
    { when: { purpose: 'draft' }, respond: { text: 'See you then', stopReason: 'end' } },
  ];
}

export interface AutoWorld {
  e2e: E2eContext;
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  bridge: AttachedBridge;
  mcp: McpChild;
  clock: AppClock;
}

/** The user's own earlier message (participation), then the contact's scheduling request - delivered for several chats at once. */
export async function sendScheduling(
  w: AutoWorld,
  chats: number[],
  opts: { participate?: boolean } = {},
): Promise<void> {
  for (const n of opts.participate === false ? [] : chats) {
    await w.bridge.deliverOwn(w.app, { chatJid: jid(n), text: 'hey', ts: w.clock.date(-HOUR_MS) });
  }
  for (const n of chats) {
    await w.bridge.deliver(w.app, {
      chatJid: jid(n),
      text: schedulingText(n),
      ts: w.clock.date(),
      pushName: `Contact ${String(n)}`,
    });
  }
}

export function createCalls(w: AutoWorld): number {
  return w.mcp.calls('create-event').length;
}

/** "Add to calendar" on the chat's card, by a real click; waits for exactly one more create-event. */
export async function approveCreateByClick(w: AutoWorld, n: number): Promise<number> {
  const itemId = await cardOfChat(w.page, w.userDataDir, jid(n));
  const before = createCalls(w);
  const button = w.page.getByTestId(`approve-event-${itemId}`);
  await expect(button).toBeVisible({ timeout: 30_000 });
  await button.click();
  await expect.poll(() => createCalls(w), { timeout: 30_000 }).toBe(before + 1);
  await expect
    .poll(() => actionsOfItem(w.userDataDir, itemId).find((a) => a.kind === 'create_event')?.state, { timeout: 30_000 })
    .toBe('done');
  return itemId;
}

/**
 * Settings > Automatic mode shows values derived from AutoState (preconditions, shadow tally). Opening the group must show the
 * CURRENT values. That is checked SOFTLY with its own message - a defect is reported in the run, never hidden - and the page is then
 * re-entered from the dashboard (whose mount re-reads AutoState) so the rest of the flow can still be proven. See the notes file,
 * REQUESTS: the pipeline changes these values without an `auto:changed` push.
 */
export async function expectAutoGroup(
  page: Page,
  testId: string,
  want: 'visible' | 'absent',
  message: string,
): Promise<void> {
  const target = page.getByTestId(testId);
  const check = async (soft: boolean, timeout: number): Promise<void> => {
    const e = soft
      ? expect.soft(target, `${message} (AutoState is current when Settings opens)`)
      : expect(target, message);
    if (want === 'visible') await e.toBeVisible({ timeout });
    else await e.toHaveCount(0, { timeout });
  };
  await check(true, 10_000);
  const ok = want === 'visible' ? (await target.count()) > 0 : (await target.count()) === 0;
  if (!ok) {
    await backToDashboard(page);
    await openSettings(page);
    await page.getByTestId('settings-group-auto').scrollIntoViewIfNeeded();
  }
  await check(false, 20_000);
}

export async function autoState(page: Page): Promise<string | null> {
  return page.getByTestId('auto-state-card').getAttribute('data-state');
}

/**
 * T2 10 `enableAutoViaUi()`: track record (three click approvals in chats 1-3) -> Settings > Automatic mode -> "Start a 24-hour
 * trial" -> the scripted native dialog (the spec's WCA_DIALOG_SCRIPT must hold a `[1, checked]` answer for it) -> three shadow
 * decisions (chats 4-6, normal cards with the `auto_shadow` chip, zero writes) -> "End trial" -> state `on`.
 * Returns the item ids of the three shadow cards. Never seeds anything.
 */
export async function enableAutoViaUi(
  w: AutoWorld,
  opts: { trackRecord?: number[]; shadow?: number[]; beforeTrial?: () => Promise<void> } = {},
): Promise<{ shadowItems: number[] }> {
  const trackRecord = opts.trackRecord ?? [1, 2, 3];
  const shadow = opts.shadow ?? [4, 5, 6];

  // ---- track record: three click approvals --------------------------------------------------------------------------
  await sendScheduling(w, trackRecord);
  for (const n of trackRecord) await approveCreateByClick(w, n);

  // ---- enable the trial through the native dialog ---------------------------------------------------------------------
  await openSettings(w.page);
  const group = w.page.getByTestId('settings-group-auto');
  await group.scrollIntoViewIfNeeded();
  await expectAutoGroup(
    w.page,
    'auto-precondition',
    'absent',
    'the enable buttons are offered right after the third approval',
  );
  if (opts.beforeTrial !== undefined) await opts.beforeTrial();
  await w.page.getByTestId('auto-enable-trial').click();
  await expect.poll(() => autoState(w.page), { timeout: 20_000 }).toBe('shadow');

  // ---- shadow: three decisions, zero writes ----------------------------------------------------------------------------
  await backToDashboard(w.page);
  const writesBefore = createCalls(w);
  await sendScheduling(w, shadow);
  const shadowItems: number[] = [];
  for (const n of shadow) {
    const itemId = await cardOfChat(w.page, w.userDataDir, jid(n));
    await expect(w.page.getByTestId(`auto-chip-${itemId}`), 'a shadow decision is shown as a chip').toHaveAttribute(
      'data-chip',
      'auto_shadow',
      { timeout: 30_000 },
    );
    await expect(
      w.page.getByTestId(`approve-event-${itemId}`),
      'the shadow card keeps its normal buttons',
    ).toBeVisible();
    shadowItems.push(itemId);
  }
  expect(createCalls(w), 'shadow decisions write nothing').toBe(writesBefore);

  // ---- end the trial -------------------------------------------------------------------------------------------------
  await openSettings(w.page);
  await w.page.getByTestId('settings-group-auto').scrollIntoViewIfNeeded();
  await expectAutoGroup(
    w.page,
    'auto-end-shadow',
    'visible',
    '"End trial" is offered right after the third shadow decision',
  );
  await w.page.waitForTimeout(600); // the 500 ms focus-steal guard of UX2 11.5 applies to "End trial"
  await w.page.getByTestId('auto-end-shadow').click();
  await expect.poll(() => autoState(w.page), { timeout: 20_000 }).toBe('on');
  await backToDashboard(w.page);
  return { shadowItems };
}

export const CHATS = Array.from({ length: 12 }, (_x, i) => i + 1);

/** A profile with 12 known chats, a connected (fake) calendar owned by the user, and a scripted local model. Nothing about
 *  automatic mode is seeded. */
export async function launchAutoWorld(
  e2e: E2eContext,
  label: string,
  dialogAnswers: Parameters<typeof dialogScript>[0],
  /** [V2] `calendarControl: true` = the fake calendar child gets its control channel (`w.mcp.control()`, e.g. userEditsInGoogle). */
  opts: { calendarControl?: boolean } = {},
): Promise<AutoWorld> {
  const userDataDir = e2e.newProfileDir(label);
  const clock = new AppClock();
  seedProfile({
    userDataDir,
    onboardingStep: 'done',
    now: (E2E_NOW_MS - 2 * 3_600_000) as never,
    settings: { provider: 'local', targetCalendarId: 'primary', timeZone: 'Asia/Jerusalem', language: 'en' },
    chats: CHATS.map((n) => ({ jid: jid(n), name: `Contact ${String(n)}` })),
    // The profile signed in through the Google wizard once, whose list-calendars recorded the roles (B7, googleAuth.persistRoles).
    // [V2] auto-mode-6: that sign-in also persisted the account the automatic-mode snapshot binds to (8 hex of the fake's
    // synthetic account, exactly as compose's persistGoogleAccount stores it - never the e-mail itself).
    meta: {
      calendar_roles_json: JSON.stringify({ primary: 'owner' }),
      google_account_sha8: createHash('sha256').update('user@example.test').digest('hex').slice(0, 8),
    },
  });
  // A connected calendar (ARCH 6.5: no "Add to calendar" without one); the "calendar" is WCA_MCP_CMD = the fake.
  seedGoogleCredentials(userDataDir);
  const bridge = await attachBridge(e2e, userDataDir);
  const mcp = mcpChild(e2e, label, undefined, userDataDir, { control: opts.calendarControl === true });
  const scriptFile = e2e.writeTempFile(`${label}-stub.json`, JSON.stringify({ rules: autoStubRules(CHATS) }));
  clock.markLaunch();
  const launched = await e2e.launch({
    userDataDir,
    env: {
      ...bridge.env,
      ...mcp.env,
      ...clock.env(),
      ...dialogScript(dialogAnswers),
      WCA_TIMERS: FAST_TIMERS_ENV,
      WCA_LLM: 'stub',
      WCA_LLM_SCRIPT: scriptFile,
      WCA_FOCUS_CHECK: 'visible-only',
    },
  });
  const page = launched.page;
  if (page === null) throw new Error('no window');
  for (const n of CHATS) e2e.sentinels.push(schedulingText(n), jid(n));
  e2e.sentinels.push(bridge.token);
  await expect
    .poll(async () => (await wca(launched.app).health()).llm.state, { timeout: 20_000 })
    .toMatch(/^(ready|idle)$/);
  await expect
    .poll(async () => (await wca(launched.app).health()).calendar.state, { timeout: 30_000 })
    .toBe('connected');
  return { e2e, app: launched.app, page, userDataDir, bridge, mcp, clock };
}
