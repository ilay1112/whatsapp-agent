// tests/e2e/undo.spec.ts - T2 10 row `undo.spec.ts` (bridge ATTACH + WCA_MCP_CMD + WCA_DIALOG_SCRIPT). Owner V2-W2-03.
//
// I8 "undo restores", end to end on the built app:
//   - an AUTOMATIC create, reached only through the shared UI helper `enableAutoViaUi()` (three click approvals, "Start a 24-hour
//     trial", the scripted native dialog, three shadow decisions, "End trial" - nothing seeded), is undone from the AutoStrip:
//     "Undoing..." -> "Undone", exactly one `update-event {status:'cancelled', sendUpdates:'none'}`;
//   - a MANUAL reschedule ("Updated · rev 1") is undone from its card: exactly one PATCH back to the pre-write slot, the card shows
//     the old time again; the same undo invoked from a HIDDEN window is refused and writes nothing;
//   - the cancel variant ("Cancel event" / "Keep it"): the undo of a cancel that Google refuses to restore offers "Add it back",
//     and one click there creates exactly one new event;
//   - drift before undo (T2 10 row, B10 pre-check of an AUTOMATIC write): the user edits the automatically created event in
//     Google (the child-mode fake calendar's control channel, `userEditsInGoogle`) and then clicks Undo => `blocked_changed`
//     ("You changed this event in Google after it was added ..."), zero update-event calls, no undo action, Google's copy keeps
//     the user's edit.
import { expect, test } from './helpers/fixtures.ts';
import { createCalls, enableAutoViaUi, launchAutoWorld, sendScheduling } from './helpers/auto.ts';
import {
  changeTurn,
  createEventByClick,
  createTurn,
  deltaCard,
  launchEditWorld,
  updateCalls,
  WED,
} from './helpers/edit.ts';
import { actionsOfItem, jid, query } from './helpers/v2.ts';

test('an automatic create is undone from the AutoStrip: Undoing... -> Undone, one update-event status:cancelled', async ({
  e2e,
}) => {
  test.setTimeout(360_000);
  const w = await launchAutoWorld(e2e, 'undo-auto', [{ match: 'auto_enable', response: 1, checkboxChecked: true }]);
  const { page, userDataDir } = w;
  await enableAutoViaUi(w);

  const before = createCalls(w);
  await sendScheduling(w, [7]);
  await expect.poll(() => createCalls(w), { timeout: 60_000 }).toBe(before + 1);
  const eventId = String(w.mcp.calls('create-event').at(-1)!.args.eventId);
  const writes = await (async () => {
    let rows: Array<{ id: string; item_id: number }> = [];
    await expect
      .poll(() => (rows = query(userDataDir, `SELECT id, item_id FROM auto_writes ORDER BY written_at`)).length, {
        timeout: 30_000,
      })
      .toBe(1);
    return rows;
  })();
  const autoWriteId = writes[0]!.id;
  await expect(page.getByTestId(`autostrip-row-${autoWriteId}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`autostrip-state-${autoWriteId}`)).toHaveAttribute('data-state', 'available');
  expect(w.mcp.calls('update-event'), 'an automatic create writes no PATCH').toHaveLength(0);

  await page.waitForTimeout(600); // the 500 ms focus-steal guard of every approval-class button (UX2 15.1)
  await page.getByTestId(`autostrip-undo-${autoWriteId}`).click();
  // UX2 3.1: the strip is open by default only while a row can still be undone; once the only row is undone it collapses, and
  // the "Undone" chip is one "Show" away (the strip stays for 24 h so a just-undone write is still visible).
  await expect
    .poll(
      () =>
        query<{ undo_state: string }>(userDataDir, 'SELECT undo_state FROM auto_writes WHERE id = ?', autoWriteId)[0]
          ?.undo_state,
      { timeout: 30_000 },
    )
    .toBe('undone');
  await expect(page.getByTestId('autostrip')).toHaveAttribute('data-open', 'false', { timeout: 30_000 });
  await page.getByTestId('autostrip-toggle').click();
  await expect(page.getByTestId(`autostrip-state-${autoWriteId}`)).toHaveAttribute('data-state', 'undone', {
    timeout: 30_000,
  });
  await e2e.screenshot(page, 'autostrip-undone-en');
  await expect.poll(() => w.mcp.calls('update-event').length, { timeout: 30_000 }).toBe(1);
  const undo = w.mcp.calls('update-event')[0]!.args;
  expect(undo.eventId).toBe(eventId);
  expect(undo.status).toBe('cancelled');
  expect(undo.sendUpdates).toBe('none');
  const undoAction = query<{ approved_by: string | null }>(
    userDataDir,
    `SELECT a.approved_by AS approved_by FROM auto_writes w JOIN actions a ON a.id = w.undo_action_id WHERE w.id = ?`,
    autoWriteId,
  )[0];
  expect(undoAction?.approved_by, 'the undo is a click approval').toBe('user');
  // a second click on the (gone) button cannot write again
  await page.waitForTimeout(2_000);
  expect(w.mcp.calls('update-event')).toHaveLength(1);
  expect(w.mcp.calls('delete-event'), 'never delete').toHaveLength(0);
});

test('a Google-side edit before Undo => blocked_changed, nothing written', async ({ e2e }) => {
  test.setTimeout(360_000);
  const w = await launchAutoWorld(e2e, 'undo-drift', [{ match: 'auto_enable', response: 1, checkboxChecked: true }], {
    calendarControl: true,
  });
  const { page, userDataDir } = w;
  await enableAutoViaUi(w);

  const before = createCalls(w);
  await sendScheduling(w, [8]);
  await expect.poll(() => createCalls(w), { timeout: 60_000 }).toBe(before + 1);
  const eventId = String(w.mcp.calls('create-event').at(-1)!.args.eventId);
  let writes: Array<{ id: string; item_id: number }> = [];
  await expect
    .poll(() => (writes = query(userDataDir, `SELECT id, item_id FROM auto_writes ORDER BY written_at`)).length, {
      timeout: 30_000,
    })
    .toBe(1);
  const autoWriteId = writes[0]!.id;
  const itemId = writes[0]!.item_id;
  await expect(page.getByTestId(`autostrip-state-${autoWriteId}`)).toHaveAttribute('data-state', 'available', {
    timeout: 30_000,
  });
  // the readback recorded the app's own write: that is the baseline the undo pre-check compares Google's copy against (F1)
  await expect
    .poll(
      () =>
        query<{ n: number }>(
          userDataDir,
          'SELECT COUNT(*) AS n FROM event_revisions WHERE calendar_event_id = ? AND (post_etag IS NOT NULL OR post_updated IS NOT NULL)',
          eventId,
        )[0]?.n,
      { timeout: 30_000 },
    )
    .toBe(1);
  expect(w.mcp.calls('update-event'), 'an automatic create writes no PATCH').toHaveLength(0);

  // ---- the user edits the event in Google (not through the app): etag / updated / sequence move ----------------------------
  const edited = (await w.mcp.controlVerb('userEditsInGoogle', {
    eventId,
    patch: { summary: 'Dentist - moved by me' },
  })) as { etag: string; summary: string; status: string };
  expect(edited.summary).toBe('Dentist - moved by me');

  // ---- Undo from the AutoStrip: the pre-check sees Google's copy changed => blocked_changed, zero calls --------------------
  await page.waitForTimeout(600); // the 500 ms focus-steal guard of every approval-class button (UX2 15.1)
  await page.getByTestId(`autostrip-undo-${autoWriteId}`).click();
  await expect
    .poll(
      () =>
        query<{ undo_state: string }>(userDataDir, 'SELECT undo_state FROM auto_writes WHERE id = ?', autoWriteId)[0]
          ?.undo_state,
      { timeout: 30_000 },
    )
    .toBe('blocked_changed');
  // the strip may collapse once nothing in it can be undone (UX2 3.1); the row is one "Show" away
  if ((await page.getByTestId('autostrip').getAttribute('data-open')) === 'false')
    await page.getByTestId('autostrip-toggle').click();
  await expect(page.getByTestId(`autostrip-state-${autoWriteId}`)).toHaveAttribute('data-state', 'blocked_changed', {
    timeout: 30_000,
  });
  await expect(page.getByTestId(`autostrip-state-${autoWriteId}`)).toContainText(
    'You changed this in Google after it was added',
  );
  // the card's Undo door explains the same verdict in full (UX2 6.4 copy)
  await expect(page.getByTestId(`undo-state-${itemId}`)).toHaveAttribute('data-state', 'blocked_changed', {
    timeout: 30_000,
  });
  await expect(page.getByTestId(`undo-state-${itemId}`)).toContainText(
    'You changed this event in Google after it was added - undo would overwrite your change.',
  );
  await expect(page.getByTestId(`undo-${itemId}`), 'no Undo button is offered any more').toHaveCount(0);
  await e2e.screenshot(page, 'undo-blocked-changed-en');

  // ---- nothing written: no PATCH, no delete, no undo action, Google's copy keeps the user's edit ---------------------------
  await page.waitForTimeout(2_000);
  expect(w.mcp.calls('update-event'), 'a blocked undo writes nothing').toHaveLength(0);
  expect(w.mcp.calls('delete-event'), 'never delete').toHaveLength(0);
  expect(createCalls(w), 'no re-create either').toBe(before + 1);
  expect(
    query<{ undo_action_id: string | null }>(
      userDataDir,
      'SELECT undo_action_id FROM auto_writes WHERE id = ?',
      autoWriteId,
    )[0]?.undo_action_id ?? null,
    'no undo action was recorded',
  ).toBeNull();
  expect(
    actionsOfItem(userDataDir, itemId).filter((a) => a.kind === 'update_event'),
    'no update_event action was minted',
  ).toHaveLength(0);
  const google = (await w.mcp.controlVerb('state')) as {
    storedEvents: Array<{ eventId: string; etag: string; summary: string; status: string }>;
  };
  const copy = google.storedEvents.find((e) => e.eventId === eventId);
  expect(copy?.summary, "Google's copy keeps the user's edit").toBe('Dentist - moved by me');
  expect(copy?.status).toBe('confirmed');
  expect(copy?.etag, 'the app never wrote the event after the user edit').toBe(edited.etag);
});

test('a manual reschedule is undone from its card back to the pre-write slot; a hidden window cannot undo', async ({
  e2e,
}) => {
  test.setTimeout(240_000);
  const w = await launchEditWorld(e2e, 'undo-manual', {
    chats: [30],
    turns: [createTurn('[u1]', 15), changeTurn('[u2]', 'reschedule', 17)],
  });
  const { page, userDataDir } = w;
  const source = await createEventByClick(w, 30, 'Meeting on Wednesday at 15:00? [u1]');
  await w.bridge.deliver(w.app, { chatJid: jid(30), text: 'can we do 5 instead of 3? [u2]', ts: w.clock.date() });
  e2e.sentinels.push('can we do 5 instead of 3? [u2]');
  const delta = await deltaCard(w, 30);
  await page.getByTestId(`approve-change-${delta}`).click();
  await expect.poll(() => updateCalls(w).length, { timeout: 30_000 }).toBe(1);
  expect(String(updateCalls(w)[0]!.args.start)).toContain(`${WED}T17:00`);

  // the acting card: "Updated · rev 2" (C2: revision 1 is the create, the change is revision 2 = items.event_revision) + Undo
  // with its deadline. (T2 10 writes "rev 1" for this step; C2 numbers revisions from the create and wins.)
  await expect(page.getByTestId(`undo-${delta}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`card-${delta}`).getByTestId('event-chip-updated')).toBeVisible();
  await expect(page.getByTestId(`card-${delta}`).getByTestId('event-chip-rev')).toContainText('rev 2');
  await expect(page.getByTestId(`undo-until-${delta}`)).toBeVisible();
  await e2e.screenshot(page, 'undo-card-updated-en');

  // a hidden window can never undo (same gate as approve, ARCH 7)
  const revisionId = query<{ id: number }>(
    userDataDir,
    `SELECT id FROM event_revisions WHERE calendar_event_id = ? ORDER BY revision DESC LIMIT 1`,
    source.eventId,
  )[0]?.id;
  expect(revisionId).toBeDefined();
  await w.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
  const hidden = await page.evaluate(
    async (p) => {
      const api = (window as unknown as { api?: { invoke?: (c: string, x: unknown) => Promise<unknown> } }).api;
      if (api?.invoke === undefined) return 'no-api';
      try {
        const r = (await api.invoke('item:undoChange', p)) as { ok?: boolean; error?: { code?: string } };
        return r.ok === true ? 'undone' : `refused:${r.error?.code ?? 'unknown'}`;
      } catch (err) {
        return `threw:${(err as Error).message}`;
      }
    },
    { itemId: delta, revisionId },
  );
  expect(hidden, 'an undo from a hidden window must never succeed').not.toBe('undone');
  await page.waitForTimeout(1_000);
  expect(updateCalls(w), 'the hidden-window undo wrote nothing').toHaveLength(1);
  await w.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.show();
    win?.focus();
  });

  // Undo on the card: exactly one PATCH back to the pre-write slot; the card shows the old time again
  await page.waitForTimeout(700); // the focus-steal guard after the window became visible again
  await page.getByTestId(`undo-${delta}`).click();
  await expect.poll(() => updateCalls(w).length, { timeout: 30_000 }).toBe(2);
  const back = updateCalls(w)[1]!.args;
  expect(back.eventId).toBe(source.eventId);
  expect(String(back.start)).toContain(`${WED}T15:00`);
  expect(String(back.end)).toContain(`${WED}T16:00`);
  // UX2 3.4: "the reverted state becomes the card's state". Checked SOFTLY (a defect is reported, the rest still runs): the
  // card's EventChip comes from the proposal, which the undo leaves at the undone slot (see the notes file, REQUESTS).
  await expect
    .soft(
      page.getByTestId(`card-${delta}`).getByTestId('event-chip-range'),
      'the card shows the restored 15:00 slot after Undo',
    )
    .toContainText('15:00', { timeout: 30_000 });
  await expect
    .poll(
      () =>
        query<{ n: number }>(
          userDataDir,
          'SELECT COUNT(*) AS n FROM event_revisions WHERE kind = ? AND reverted_by IS NULL',
          'undo',
        )[0]?.n,
      { timeout: 30_000 },
    )
    .toBe(1);
  expect(w.mcp.calls('delete-event'), 'never delete').toHaveLength(0);
});

test('cancel variant: Cancel event / Keep it; undoing a cancel that Google refuses offers "Add it back" = one new event', async ({
  e2e,
}) => {
  test.setTimeout(240_000);
  const w = await launchEditWorld(e2e, 'undo-cancel', {
    chats: [31],
    v2Scenarios: ['restore_refused'],
    turns: [createTurn('[c1]', 15), changeTurn('[c2]', 'cancel')],
  });
  const { page, userDataDir } = w;
  const source = await createEventByClick(w, 31, 'Meeting on Wednesday at 15:00? [c1]');
  await w.bridge.deliver(w.app, { chatJid: jid(31), text: "sorry, let's cancel Wednesday [c2]", ts: w.clock.date() });
  e2e.sentinels.push("sorry, let's cancel Wednesday [c2]");
  const delta = await deltaCard(w, 31);
  await expect(page.getByTestId(`change-line-${delta}`)).toHaveAttribute('data-kind', 'cancel');
  await expect(page.getByTestId(`cancel-event-${delta}`)).toBeVisible();
  await expect(page.getByTestId(`keep-event-${delta}`)).toBeVisible();
  await e2e.screenshot(page, 'change-card-cancel-en');

  await page.getByTestId(`cancel-event-${delta}`).click();
  await expect.poll(() => updateCalls(w).length, { timeout: 30_000 }).toBe(1);
  expect(updateCalls(w)[0]!.args.status).toBe('cancelled');
  expect(updateCalls(w)[0]!.args.eventId).toBe(source.eventId);
  await expect(page.getByTestId(`undo-${delta}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`card-${delta}`).getByTestId('event-chip-cancelled')).toBeVisible();

  // undo of the cancel: Google leaves the event cancelled (restore_refused) -> "Add it back"
  const creates = w.mcp.calls('create-event').length;
  await page.waitForTimeout(600);
  await page.getByTestId(`undo-${delta}`).click();
  await expect.poll(() => updateCalls(w).length, { timeout: 30_000 }).toBe(2);
  expect(updateCalls(w)[1]!.args.status).toBe('confirmed');
  // UX 6 "Refresh": the card had a pending reply draft on screen, so main's new state arrives as "This card changed - review
  // again" + Refresh card (the documented dirty-card rule); the user refreshes it.
  const stale = page.getByTestId(`stale-${delta}`);
  await expect(stale.or(page.getByTestId(`restore-refused-${delta}`)).first()).toBeVisible({ timeout: 30_000 });
  if ((await stale.count()) > 0) await page.getByTestId(`refresh-${delta}`).click();
  await expect(page.getByTestId(`restore-refused-${delta}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`add-back-${delta}`)).toBeVisible();
  expect(w.mcp.calls('create-event'), '"Add it back" waits for a click').toHaveLength(creates);
  await e2e.screenshot(page, 'undo-restore-refused-en');
  await page.waitForTimeout(600);
  await page.getByTestId(`add-back-${delta}`).click();
  await expect.poll(() => w.mcp.calls('create-event').length, { timeout: 30_000 }).toBe(creates + 1);
  const added = w.mcp.calls('create-event').at(-1)!.args;
  expect(String(added.start)).toContain(`${WED}T15:00`);
  const addBack = actionsOfItem(userDataDir, delta).filter((a) => a.kind === 'create_event');
  expect(
    addBack.some((a) => a.approved_by === 'user' && a.state === 'done'),
    'the add-back is a click approval',
  ).toBe(true);
  await page.waitForTimeout(2_000);
  expect(w.mcp.calls('create-event'), 'exactly one new event').toHaveLength(creates + 1);
  expect(w.mcp.calls('delete-event'), 'never delete').toHaveLength(0);
});
