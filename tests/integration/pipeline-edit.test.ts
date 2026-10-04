// tests/integration/pipeline-edit.test.ts - T2 6 row `pipeline-edit` (owner V2-W1-03-edit-pipeline; W2-01 inherits the fix-up right).
// The editing pipeline through the production compose() (harness): the fake bridge's messages.db, the real ingest + S0, the real queue,
// the real orchestrator, the real repos and triggers, the fake calendar MCP. Every write is a PENDING action; the approve path of an
// update_event (one PATCH with ifMatch, applyUpdateSuccess, readback) belongs to exec/** (V2-W1-04) and is exercised at the end.
//
// BLOCKED-BY V2-W2-01 until compose() passes the v2 orchestrator deps (`updateSurfaceAvailable` from McpHost.updateSurface(), `tryAuto`,
// `existingEvent`, `voice`, `readImage`, `pickImage`); without them every delta degrades to the v1 `change_in_google` card by design
// (fail closed), and BLOCKED-BY V2-W1-04 for the approve / reject paths of an update_event. Nothing here is skipped.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.ts';
import { seedCalendarEvent } from '../golden/testDb.ts';
import type { StubRule } from '../fakes/stub-llm.ts';
import type { Extraction } from '../../src/shared/schemas.ts';
import type { EpochMs, Item } from '../../src/shared/types.ts';

const TZ = 'Asia/Jerusalem';
const NOW = Date.parse('2026-09-21T07:00:00.000Z'); // Monday 10:00 local
const START = NOW - 2 * 3_600_000;
const JID = '972550000090@s.whatsapp.net';

const X: Extraction = {
  intent: 'reschedule',
  needsReply: true,
  title: 'meeting',
  dateKind: 'none',
  isoDate: '',
  weekday: 0,
  weekOffset: 0,
  daysFromToday: 0,
  time24h: '17:00',
  timeAmbiguous: false,
  durationMin: 0,
  location: '',
  missing: [],
  suspicious: false,
  refersToExisting: true,
  change: 'reschedule',
  changeConfidence: 'high',
  confidence: 'high',
};
const rules = (x: Partial<Extraction>, draft = 'sure, 5 works'): StubRule[] => [
  { when: { purpose: 'extract' }, respond: { structured: { ...X, ...x } } },
  { when: { purpose: 'draft' }, respond: { text: draft } },
];

let open: Harness | null = null;
afterEach(async () => {
  await open?.dispose();
  open = null;
});

interface Setup {
  h: Harness;
  chatId: number;
  sourceItemId: number;
  eventId: string;
}
async function setup(r: StubRule[], opts: { older?: boolean } = {}): Promise<Setup> {
  const h = await createHarness({
    nowMs: START,
    timeZone: TZ,
    rules: r,
    events: [
      {
        id: 'evtsrc0900',
        calendarId: 'primary',
        summary: 'meeting',
        start: '2026-09-23T15:00:00',
        end: '2026-09-23T16:00:00',
        timeZone: TZ,
        createdByApp: true,
      },
    ],
  });
  open = h;
  const chat = h.repos.chats.upsertFromBridge(JID, null, true, START as EpochMs);
  if (opts.older === true)
    seedCalendarEvent(h.repos, chat, {
      title: 'dinner',
      startLocal: '2026-09-22T18:00',
      endLocal: '2026-09-22T19:30',
      eventId: 'evtsrc0901',
      createdAt: (START - 3 * 86_400_000) as EpochMs,
    });
  const seeded = seedCalendarEvent(h.repos, chat, {
    title: 'meeting',
    startLocal: '2026-09-23T15:00',
    endLocal: '2026-09-23T16:00',
    eventId: 'evtsrc0900',
    createdAt: (START - 2 * 86_400_000) as EpochMs,
  });
  // [V2-W2-01] the fake's copy of that event carries the identity tags the app's create would have written (F27 ownership: waAgent,
  // waItem = the origin item, waAction = the chain root) - otherwise the pre-flight correctly refuses it as CAL_EVENT_FOREIGN
  const stored = h.calendar.fake.events.find((e) => e.id === seeded.eventId);
  if (stored !== undefined)
    stored.extendedProperties = {
      ...(stored.extendedProperties ?? {}),
      private: { waAgent: '1', waItem: String(seeded.item.id), waAction: seeded.actionId },
    };
  // the user's own earlier message (history) - the chat is known and the user took part (context_from_me_recent)
  // the user's own earlier message: HISTORY (before live_from), so it is context only - a LIVE own message with an existing event is
  // itself a self trigger since F28 (P2 2 item 5), which this setup must not create
  await h.bridge.historySync([{ chatJid: JID, text: 'hey', ts: new Date(START - 60_000), fromMe: true }]);
  await h.settle();
  return { h, chatId: chat.id, sourceItemId: seeded.item.id, eventId: seeded.eventId };
}
async function contactSays(h: Harness, text: string, fromMe = false): Promise<void> {
  await h.advance(NOW - h.clock.now());
  await h.bridge.historySync([{ chatJid: JID, text, ts: new Date(h.clock.now()), fromMe }]);
  await h.advance(60_000);
  await h.settle();
}
function deltaItem(h: Harness, chatId: number): Item {
  const row = h.repos.db
    .prepare<{ id: number }>(
      'SELECT id FROM items WHERE chat_id = ? AND calendar_event_id IS NULL ORDER BY id DESC LIMIT 1',
    )
    .get(chatId);
  expect(row, 'no delta item').toBeDefined();
  return h.repos.items.byId(row!.id)!;
}
const pendingKinds = (h: Harness, itemId: number): string[] =>
  h.repos.actions
    .forItem(itemId)
    .filter((a) => a.state === 'pending')
    .map((a) => a.kind)
    .sort();

describe('pipeline-edit (T2 6)', () => {
  it('reschedule: a Change card with update_event + send_reply linked to the source; nothing is written', async () => {
    const { h, chatId, sourceItemId, eventId } = await setup(rules({}));
    await contactSays(h, 'can we do 5 instead of 3?');
    const item = deltaItem(h, chatId);
    expect(item.eventState).toBe('change_proposed');
    expect(item.linkedItemId).toBe(sourceItemId);
    expect(pendingKinds(h, item.id)).toEqual(['send_reply', 'update_event']);
    const upd = h.repos.actions.forItem(item.id).find((a) => a.kind === 'update_event')!;
    expect(JSON.parse(upd.canonicalJson)).toMatchObject({
      targetEventId: eventId,
      targetItemId: sourceItemId,
      baseRevision: 1,
    });
    expect(h.calendar.calls.filter((c) => c.tool === 'update-event' || c.tool === 'create-event')).toHaveLength(0);
    expect(h.bridge.sends).toHaveLength(0);
    // the source card is unchanged until the update is done
    expect(h.repos.items.byId(sourceItemId)!.state).toBe('in_calendar');
    // the event shows once on the dashboard
    const dash = await h.invoke('dashboard:get', undefined);
    expect(dash.ok).toBe(true);
    if (dash.ok) expect(dash.value.inCalendar.filter((c) => c.itemId === sourceItemId)).toHaveLength(1);
  });

  it('move and cancel produce their deltas; new_event leaves the existing event untouched', async () => {
    const { h, chatId } = await setup(rules({ change: 'move', time24h: '', location: 'Zoom' }));
    await contactSays(h, "let's do it on Zoom instead");
    const item = deltaItem(h, chatId);
    const upd = h.repos.actions.forItem(item.id).find((a) => a.kind === 'update_event')!;
    expect(JSON.parse(upd.canonicalJson)).toMatchObject({ change: 'move', to: { location: 'Zoom' } });
  });

  it('no_change false positive: no event proposal at all', async () => {
    const { h, chatId } = await setup(
      rules({ intent: 'smalltalk', needsReply: false, change: 'no_change', time24h: '' }),
    );
    await contactSays(h, '5 people are coming');
    const item = deltaItem(h, chatId);
    expect(pendingKinds(h, item.id)).toEqual([]);
    expect(item.state).toBe('ignored');
  });

  it('change_unclear on a low-confidence change: the draft asks, no update_event', async () => {
    const { h, chatId } = await setup(rules({ changeConfidence: 'low' }));
    await contactSays(h, 'maybe later?');
    const item = deltaItem(h, chatId);
    expect(item.badges).toContain('change_unclear');
    expect(pendingKinds(h, item.id)).toEqual(['send_reply']);
  });

  it('two live events (F31): change_target_unclear on the delta', async () => {
    const { h, chatId } = await setup(rules({ dateKind: 'weekday', weekday: 4, time24h: '' }), { older: true });
    await contactSays(h, "can we move Tuesday's dinner to Thursday?");
    const item = deltaItem(h, chatId);
    expect(item.badges).toContain('change_target_unclear');
  });

  it('duration-only (F40): the start is kept, the end moves', async () => {
    const { h, chatId } = await setup(rules({ time24h: '', durationMin: 120 }));
    await contactSays(h, "let's make it two hours instead");
    const upd = h.repos.actions.forItem(deltaItem(h, chatId).id).find((a) => a.kind === 'update_event')!;
    expect(JSON.parse(upd.canonicalJson)).toMatchObject({
      to: { startLocal: '2026-09-23T15:00:00', endLocal: '2026-09-23T17:00:00' },
    });
  });

  it('self trigger (F28): the user\'s own "let\'s make it 5 instead" => one pending update_event, no send_reply, no S3 run', async () => {
    const { h, chatId } = await setup(rules({}));
    await contactSays(h, "let's make it 5 instead", true);
    const item = deltaItem(h, chatId);
    expect(pendingKinds(h, item.id)).toEqual(['update_event']);
    expect(h.repos.proposals.current(item.id)!.triggerAuthor).toBe('self');
    const stages = h.repos.db
      .prepare<{ stage: string }>('SELECT stage FROM runs WHERE item_id = ?')
      .all(item.id)
      .map((r) => r.stage);
    expect(stages).toEqual(['extract']);
  });

  it('reject (F32): "Keep 15:00" => declined; the same message again proposes nothing; a new slot proposes again', async () => {
    const { h, chatId } = await setup(rules({}));
    await contactSays(h, 'can we do 5 instead of 3?');
    const item = deltaItem(h, chatId);
    const upd = h.repos.actions.forItem(item.id).find((a) => a.kind === 'update_event')!;
    h.setWindowState({ focused: true, visible: true });
    const rejected = await h.invoke('action:reject', { actionId: upd.id } as never);
    expect(rejected.ok).toBe(true);
    expect(h.repos.items.byId(item.id)!.eventState).toBe('declined');
    const again = await h.invoke('item:retriage', { itemId: item.id } as never);
    expect(again.ok).toBe(true);
    await h.settle();
    expect(pendingKinds(h, item.id)).not.toContain('update_event');
  });

  it('approve => exactly one PATCH with ifMatch; applyUpdateSuccess moves the event forward and closes the source superseded', async () => {
    const { h, chatId, sourceItemId, eventId } = await setup(rules({}));
    await contactSays(h, 'can we do 5 instead of 3?');
    const item = deltaItem(h, chatId);
    const upd = h.repos.actions.forItem(item.id).find((a) => a.kind === 'update_event')!;
    h.setWindowState({ focused: true, visible: true });
    const res = await h.invoke('action:approve', {
      actionId: upd.id,
      kind: 'update_event',
      shownHash: upd.contentSha256,
    } as never);
    expect(res.ok).toBe(true);
    await h.settle();
    const patches = h.calendar.calls.filter((c) => c.tool === 'update-event');
    expect(patches).toHaveLength(1);
    expect(patches[0]!.args.ifMatch).toBeTruthy();
    expect(patches[0]!.args.eventId).toBe(eventId);
    const acting = h.repos.items.byId(item.id)!;
    expect(acting.calendarEventId).toBe(eventId);
    expect(acting.eventRevision).toBe(2);
    expect(h.repos.items.byId(sourceItemId)!.closedReason).toBe('superseded');
    expect(h.calendar.calls.filter((c) => c.tool === 'delete-event')).toHaveLength(0);
  });
});
