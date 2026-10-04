// tests/e2e/auto-mode.spec.ts - T2 10 row `auto-mode.spec.ts` (bridge ATTACH + WCA_MCP_CMD + WCA_DIALOG_SCRIPT). Owner V2-W2-03.
//
// Automatic mode end to end on the built app, reached ONLY through the UI (no seed, no env switch, no hook can create a policy):
//   Off (default): an eligible inbound is an ordinary card and nothing is written; the enable buttons are replaced by the
//     "needs three events you approved" precondition; `settings:set {auto:{...}}` from the page is refused.
//   Track record: three real click approvals of create cards.
//   Enable: "Start a 24-hour trial" -> the main-owned native dialog (options recorded by `__wcaTest.dialogs()`); an unchecked
//     answer changes nothing (AUTO_NOT_CONFIRMED), the checked one starts the trial.
//   Shadow: three eligible proposals -> `auto_shadow` chips, normal buttons, zero writes; "End trial" -> on.
//   On: the next eligible inbound is written with zero clicks (exactly one create-event, sendUpdates:'none'), lands in "In
//     calendar" with the `automatic` chip and an AutoStrip row; one toast with app text only and the actions Undo / Show. An
//     ineligible item stays an ordinary card with its "Not automatic: ..." line (here: no user participation in the chat - a voice
//     item would need the voice gate, and an unknown sender is never analysed at all).
//   Pause / off: the tray item `autoPause` (present only while a policy is live) pauses it; the next inbound is a card again, zero
//     writes, and a manual approval still works; Resume needs a click in the window; "Turn off" removes the tray item.
import { expect, test, wca } from './helpers/fixtures.ts';
import {
  approveCreateByClick,
  autoState,
  createCalls,
  enableAutoViaUi,
  launchAutoWorld,
  schedulingText,
  sendScheduling,
  slotOf,
} from './helpers/auto.ts';
import {
  actionsOfItem,
  autoDecisions,
  autoPolicies,
  backToDashboard,
  cardOfChat,
  jid,
  openSettings,
} from './helpers/v2.ts';

test('automatic mode: off by default, reached only through the UI, writes with zero clicks when on, pauses from the tray', async ({
  e2e,
}) => {
  test.setTimeout(360_000);
  const w = await launchAutoWorld(e2e, 'auto', [
    { match: 'auto_enable', response: 1, checkboxChecked: false },
    { match: 'auto_enable', response: 1, checkboxChecked: true },
  ]);
  const { page, app, userDataDir } = w;

  // ---- Off (default) -------------------------------------------------------------------------------------------------
  await sendScheduling(w, [1]);
  const first = await cardOfChat(page, userDataDir, jid(1));
  await expect(page.getByTestId(`approve-event-${first}`), 'an ordinary card with its approval button').toBeVisible({
    timeout: 30_000,
  });
  await page.waitForTimeout(5_000);
  expect(createCalls(w), 'off: zero create-event after 5 s idle').toBe(0);
  expect(autoDecisions(userDataDir), 'off: no decision is even recorded').toEqual([]);
  await expect(page.getByTestId(`auto-chip-${first}`)).toHaveCount(0);
  await expect(page.getByTestId(`auto-reason-${first}`), 'no reason line without a live policy (UX2 15.6)').toHaveCount(
    0,
  );

  await openSettings(page);
  await page.getByTestId('settings-group-auto').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('auto-state-card')).toHaveAttribute('data-state', 'none');
  await expect(page.getByTestId('auto-precondition')).toHaveAttribute('data-reason', 'trackRecord');
  await expect(page.getByTestId('auto-enable-trial'), 'no enable button before three approved events').toHaveCount(0);
  await expect(page.getByTestId('auto-enable-now')).toHaveCount(0);
  await e2e.screenshot(page, 'auto-settings-off-en');

  // the renderer cannot flip automatic mode through settings:set (there is no `auto` settings key)
  const viaSettings = await page.evaluate(async () => {
    const api = (window as unknown as { api?: { invoke?: (c: string, p: unknown) => Promise<unknown> } }).api;
    if (api?.invoke === undefined) return 'no-api';
    const r = (await api.invoke('settings:set', { auto: { enabled: true } })) as {
      ok?: boolean;
      error?: { code?: string };
    };
    return r.ok === true ? 'accepted' : `refused:${r.error?.code ?? 'unknown'}`;
  });
  expect(viaSettings).toBe('refused:BAD_REQUEST');
  expect(autoPolicies(userDataDir), 'no policy row').toEqual([]);
  await backToDashboard(page);

  // ---- Track record (chat 1 is approved by click, then chats 2 and 3), Enable with an unchecked answer first ------------
  await approveCreateByClick(w, 1);
  const { shadowItems } = await enableAutoViaUi(w, {
    trackRecord: [2, 3],
    beforeTrial: async () => {
      // the first dialog answer is "Turn on" WITHOUT the checkbox: nothing changes
      await page.getByTestId('auto-enable-trial').click();
      await expect(page.getByTestId('auto-error')).toHaveAttribute('data-code', 'AUTO_NOT_CONFIRMED', {
        timeout: 20_000,
      });
      expect(await autoState(page)).toBe('none');
      expect(autoPolicies(userDataDir)).toEqual([]);
    },
  });
  // both dialogs were built by main with the exact B7 options: warning, Cancel default + cancel id, the checkbox, parent focused
  const dialogs = await wca(app).dialogs();
  expect(dialogs.length).toBe(2);
  for (const d of dialogs) {
    expect(d.kind).toBe('auto_enable');
    expect(d.type).toBe('warning');
    expect(d.defaultId).toBe(d.cancelId);
    expect(d.buttons.length).toBeGreaterThanOrEqual(2);
    expect(d.checkboxLabel ?? '').not.toBe('');
    expect(d.parentFocused).toBe(true);
  }
  expect(shadowItems).toHaveLength(3);
  const shadow = autoDecisions(userDataDir).filter((d) => d.verdict === 'shadow');
  expect(shadow.length, 'three shadow decisions').toBeGreaterThanOrEqual(3);
  expect(autoPolicies(userDataDir).map((p) => p.state)).toEqual(['on']);

  // ---- On: the next eligible inbound is written with zero clicks ---------------------------------------------------------
  const before = createCalls(w);
  await sendScheduling(w, [7]);
  await expect.poll(() => createCalls(w), { timeout: 60_000 }).toBe(before + 1);
  const created = w.mcp.calls('create-event').at(-1)!;
  expect(created.args.sendUpdates).toBe('none');
  expect(created.args.start).toContain(slotOf(7).startLocal);
  const autoItem = await cardOfChat(page, userDataDir, jid(7));
  await expect(page.locator(`[data-testid="list-in_calendar"] [data-testid="card-${autoItem}"]`)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId(`auto-chip-${autoItem}`)).toHaveAttribute('data-chip', 'automatic');
  expect(actionsOfItem(userDataDir, autoItem).find((a) => a.kind === 'create_event')?.approved_by).not.toBe('user');
  await expect(page.getByTestId('autostrip')).toBeVisible();
  await expect(page.locator('[data-testid^="autostrip-row-"]')).toHaveCount(1);
  await e2e.screenshot(page, 'auto-on-autostrip-en');
  const toasts = await wca(app).notifications();
  const autoToasts = toasts.filter((t) => t.actions.length > 0);
  expect(autoToasts, 'exactly one toast with actions').toHaveLength(1);
  expect(autoToasts[0]!.actions).toEqual(['Undo', 'Show']);
  for (const t of toasts) {
    expect(`${t.title} ${t.body}`, 'toasts carry app text only').not.toContain(schedulingText(7));
    expect(`${t.title} ${t.body}`).not.toContain('Dentist');
  }

  // An item that is not eligible stays an ordinary card and SAYS why ("Not automatic: ..."): here the user never wrote in the
  // chat (AutoGate 'no_user_participation'). The line exists only while a policy is live (UX2 15.6).
  const notAuto = createCalls(w);
  await sendScheduling(w, [9], { participate: false });
  const notAutoItem = await cardOfChat(page, userDataDir, jid(9));
  await expect(page.getByTestId(`auto-reason-${notAutoItem}`)).toHaveAttribute('data-reason', 'no_user_participation', {
    timeout: 30_000,
  });
  await expect(page.getByTestId(`approve-event-${notAutoItem}`)).toBeVisible();
  expect(createCalls(w), 'a fallback writes nothing').toBe(notAuto);
  await e2e.screenshot(page, 'auto-not-automatic-line-en');

  // ---- Pause from the tray, then off ---------------------------------------------------------------------------------
  const trayIds = (await wca(app).trayTemplate()).map((i) => i.id);
  expect(trayIds, 'the tray offers Pause automatic mode while a policy is live').toContain('autoPause');
  await wca(app).trayClick('autoPause');
  await openSettings(page);
  await page.getByTestId('settings-group-auto').scrollIntoViewIfNeeded();
  await expect.poll(() => autoState(page), { timeout: 10_000 }).toBe('paused');
  expect(autoPolicies(userDataDir)[0]?.paused_reason).toBe('user');
  await backToDashboard(page);

  const paused = createCalls(w);
  await sendScheduling(w, [8]);
  const pausedItem = await cardOfChat(page, userDataDir, jid(8));
  await expect(page.getByTestId(`approve-event-${pausedItem}`), 'paused: an ordinary card').toBeVisible({
    timeout: 30_000,
  });
  await page.waitForTimeout(3_000);
  expect(createCalls(w), 'paused: zero writes').toBe(paused);
  await approveCreateByClick(w, 8);
  expect(createCalls(w), 'a manual approval still works while paused').toBe(paused + 1);

  // Resume needs a click in the window; then "Turn off" removes the tray item.
  await openSettings(page);
  await page.getByTestId('settings-group-auto').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600); // the 500 ms focus-steal guard of UX2 11.5 applies to Resume
  await page.getByTestId('auto-resume').click();
  await expect.poll(() => autoState(page), { timeout: 10_000 }).toBe('on');
  await page.getByTestId('auto-stop').click();
  await expect.poll(() => autoState(page), { timeout: 10_000 }).toBe('disabled');
  await expect
    .poll(async () => (await wca(app).trayTemplate()).map((i) => i.id), { timeout: 10_000 })
    .not.toContain('autoPause');
  expect(shadowItems.every((id) => actionsOfItem(userDataDir, id).every((a) => a.state === 'pending'))).toBe(true);
});
