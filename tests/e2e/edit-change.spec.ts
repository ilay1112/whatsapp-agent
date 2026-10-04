// tests/e2e/edit-change.spec.ts - T2 10 row `edit-change.spec.ts` (bridge ATTACH + WCA_MCP_CMD). Owner V2-W2-03.
//
// The Change card on the built app (UX2 3.3, B20, I3'): the event exists because the user added it by a click; the contact then
// asks to move it ("can we do 5 instead of 3?" / "בוא נזיז ל-5"). The card shows the arrow line, **Approve change** and **Keep
// 15:00**; the inline editor edits the NEW slot only (the event as it is now is shown read-only above it); approving sends exactly
// one PATCH with `ifMatch`; the In-calendar list never draws the event twice. Drift in Google ("In Google it is now ...") offers
// **Apply anyway** (applies) and **Keep Google's** (writes nothing); an event that vanished offers **Add as new event**.
// Every write is checked by the ledger (rule 6: one approved update_event per update-event, args = buildUpdateEventArgs(...)).
import { expect, test } from './helpers/fixtures.ts';
import {
  changeTurn,
  createEventByClick,
  createTurn,
  deltaCard,
  launchEditWorld,
  updateCalls,
  WED,
} from './helpers/edit.ts';
import { actionsOfItem, cardIdsIn, jid, query } from './helpers/v2.ts';

test.setTimeout(240_000);

test('en: a Change card proposes the move, the editor edits only the new slot, Approve change sends one PATCH with ifMatch', async ({
  e2e,
}) => {
  const w = await launchEditWorld(e2e, 'edit-en', {
    chats: [20],
    turns: [createTurn('[e1]', 15), changeTurn('[e2]', 'reschedule', 17)],
  });
  const { page, userDataDir } = w;
  const source = await createEventByClick(w, 20, 'Meeting on Wednesday at 15:00? [e1]');

  await w.bridge.deliver(w.app, { chatJid: jid(20), text: 'can we do 5 instead of 3? [e2]', ts: w.clock.date() });
  e2e.sentinels.push('can we do 5 instead of 3? [e2]');
  const delta = await deltaCard(w, 20);
  const line = page.getByTestId(`change-line-${delta}`);
  await expect(line).toHaveAttribute('data-kind', 'reschedule');
  await expect(line).toContainText('15:00');
  await expect(line).toContainText('17:00');
  await expect(page.getByTestId(`approve-change-${delta}`)).toBeVisible();
  await expect(page.getByTestId(`keep-change-${delta}`)).toContainText('15:00');
  // the source card stays in "In calendar", once, with the "Change proposed" chip (UX2 3.3.3; B20 de-duplication)
  await expect(page.getByTestId(`change-pending-chip-${source.itemId}`)).toBeVisible();
  await expect(page.locator(`[data-testid="list-in_calendar"] [data-testid="card-${source.itemId}"]`)).toHaveCount(1);
  expect(updateCalls(w), 'a proposal writes nothing').toHaveLength(0);
  await e2e.screenshot(page, 'change-card-reschedule-en');

  // the inline editor (the sheet) shows the event as it is now read-only, and edits only the new slot
  await page.getByTestId(`card-${delta}`).getByTestId('event-chip').click();
  await expect(page.getByTestId('sheet-now-in-calendar')).toContainText('15:00');
  const start = page.getByTestId('event-start');
  await expect(start).toHaveValue('17:00');
  await page.getByTestId('event-end').fill('18:30');

  // approve (in the sheet, where the edit lives): exactly one PATCH, with ifMatch, to the app's own event, with the edited end
  await page.getByTestId('item-sheet').getByTestId(`approve-change-${delta}`).click();
  await expect.poll(() => updateCalls(w).length, { timeout: 30_000 }).toBe(1);
  const patch = updateCalls(w)[0]!.args;
  expect(patch.eventId).toBe(source.eventId);
  expect(typeof patch.ifMatch).toBe('string');
  expect(String(patch.ifMatch).length).toBeGreaterThan(0);
  expect(String(patch.start)).toContain(`${WED}T17:00`);
  expect(String(patch.end)).toContain(`${WED}T18:30`);
  expect(patch.sendUpdates).toBe('none');
  await expect
    .poll(() => actionsOfItem(userDataDir, delta).find((a) => a.kind === 'update_event')?.state, { timeout: 30_000 })
    .toBe('done');

  if ((await page.getByTestId('sheet-close').count()) > 0) await page.getByTestId('sheet-close').click();
  // the calendar list never shows the event twice
  await expect
    .poll(
      () =>
        query<{ n: number }>(
          userDataDir,
          `SELECT COUNT(*) AS n FROM items WHERE calendar_event_id = ? AND closed_at IS NULL`,
          source.eventId,
        )[0]?.n,
      { timeout: 30_000 },
    )
    .toBe(1);
  // one card per event in "In calendar" (the source closed superseded; the acting item carries the event now)
  await expect.poll(() => cardIdsIn(page, 'in_calendar'), { timeout: 30_000 }).toHaveLength(1);
  await expect(page.getByTestId('event-chip-updated')).toBeVisible({ timeout: 30_000 });
  await e2e.screenshot(page, 'change-card-updated-en');
  expect(w.mcp.calls('delete-event'), 'never delete').toHaveLength(0);
});

test('he: "בוא נזיז ל-5" renders the Hebrew Change card right-to-left, and Keep 15:00 writes nothing', async ({
  e2e,
}) => {
  const w = await launchEditWorld(e2e, 'edit-he', {
    chats: [21],
    language: 'he',
    turns: [createTurn('[h1]', 15, 'פגישה'), changeTurn('[h2]', 'reschedule', 17, 'פגישה')],
  });
  const { page } = w;
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await createEventByClick(w, 21, 'פגישה ביום רביעי ב-15:00? [h1]');
  await w.bridge.deliver(w.app, { chatJid: jid(21), text: 'בוא נזיז ל-5 [h2]', ts: w.clock.date() });
  e2e.sentinels.push('בוא נזיז ל-5 [h2]');
  const delta = await deltaCard(w, 21);
  const line = page.getByTestId(`change-line-${delta}`);
  await expect(line).toContainText('שינוי');
  await expect(line).toContainText('15:00');
  await expect(line).toContainText('17:00');
  expect(await line.evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');
  await e2e.screenshot(page, 'change-card-reschedule-he');

  await page.getByTestId(`keep-change-${delta}`).click();
  await expect
    .poll(() => actionsOfItem(w.userDataDir, delta).find((a) => a.kind === 'update_event')?.state, { timeout: 30_000 })
    .toBe('rejected');
  await page.waitForTimeout(2_000);
  expect(updateCalls(w), 'Keep 15:00 writes nothing').toHaveLength(0);
});

test('drift: Apply anyway applies the change, Keep Google\'s writes nothing; a vanished event offers "Add as new event"', async ({
  e2e,
}) => {
  // `drift`: the FIRST get-event of each event sees it moved +1 h in Google (etag bumped) - i.e. the approval's pre-flight read.
  const w = await launchEditWorld(e2e, 'edit-drift', {
    chats: [22, 23],
    v2Scenarios: ['drift'],
    turns: [
      createTurn('[d1]', 15),
      changeTurn('[d2]', 'reschedule', 17),
      createTurn('[k1]', 11),
      changeTurn('[k2]', 'reschedule', 12),
    ],
  });
  const { page, userDataDir } = w;

  // ---- Apply anyway ----
  const a = await createEventByClick(w, 22, 'Meeting on Wednesday at 15:00? [d1]');
  await w.bridge.deliver(w.app, { chatJid: jid(22), text: 'can we do 5 instead of 3? [d2]', ts: w.clock.date() });
  const deltaA = await deltaCard(w, 22);
  await page.getByTestId(`approve-change-${deltaA}`).click();
  await expect(
    page.getByTestId(`drift-row-${deltaA}`),
    'In Google it is now ... - apply the change anyway?',
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId(`drift-row-${deltaA}`)).toContainText('16:00');
  expect(updateCalls(w), 'nothing is written before the user decides').toHaveLength(0);
  await e2e.screenshot(page, 'change-card-drift-en');
  await page.waitForTimeout(600); // "Apply anyway" sits behind the 500 ms focus-steal guard (UX2 3.3.4)
  await page.getByTestId(`apply-anyway-${deltaA}`).click();
  await expect.poll(() => updateCalls(w).length, { timeout: 30_000 }).toBe(1);
  expect(updateCalls(w)[0]!.args.eventId).toBe(a.eventId);

  // ---- Keep Google's ----
  await createEventByClick(w, 23, 'Meeting on Wednesday at 11:00? [k1]');
  await w.bridge.deliver(w.app, { chatJid: jid(23), text: 'can we do 12 instead? [k2]', ts: w.clock.date() });
  const deltaB = await deltaCard(w, 23);
  await page.getByTestId(`approve-change-${deltaB}`).click();
  await expect(page.getByTestId(`drift-row-${deltaB}`)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(`keep-google-${deltaB}`).click();
  await expect
    .poll(() => actionsOfItem(userDataDir, deltaB).find((x) => x.kind === 'update_event')?.state, { timeout: 30_000 })
    .toBe('rejected');
  await page.waitForTimeout(2_000);
  expect(updateCalls(w), "Keep Google's writes nothing").toHaveLength(1);
});

test('event_missing: the change of an event that is gone from Google offers "Add as new event", one click = one create', async ({
  e2e,
}) => {
  const w = await launchEditWorld(e2e, 'edit-gone', {
    chats: [24],
    v2Scenarios: ['event_missing'],
    turns: [createTurn('[g1]', 15), changeTurn('[g2]', 'reschedule', 17)],
  });
  const { page } = w;
  await createEventByClick(w, 24, 'Meeting on Wednesday at 15:00? [g1]');
  const creates = w.mcp.calls('create-event').length;
  await w.bridge.deliver(w.app, { chatJid: jid(24), text: 'can we do 5 instead of 3? [g2]', ts: w.clock.date() });
  const delta = await deltaCard(w, 24);
  await page.getByTestId(`approve-change-${delta}`).click();
  await expect(page.getByTestId(`add-new-event-${delta}`)).toBeVisible({ timeout: 30_000 });
  expect(updateCalls(w), 'no PATCH reaches a vanished event').toHaveLength(0);
  await page.waitForTimeout(600);
  await page.getByTestId(`add-new-event-${delta}`).click();
  await expect.poll(() => w.mcp.calls('create-event').length, { timeout: 30_000 }).toBe(creates + 1);
  expect(String(w.mcp.calls('create-event').at(-1)!.args.start)).toContain(`${WED}T17:00`);
});
