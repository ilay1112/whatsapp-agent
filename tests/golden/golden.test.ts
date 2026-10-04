// tests/golden/golden.test.ts - scripted-mode evaluation set (TESTS section 7.2 / PIPELINE section 11; owner W1-10).
// Runs every case of tests/golden/{he,en,mixed}.jsonl through the REAL app with a scripted LLM: no model, no network, no
// real bridge, no calendar write client. It proves S0 -> S2 -> S4, state derivation, badges and persistence independently
// of model quality, and that the only thing a run can ever produce is a PENDING action (approval-first).
//
// Route (repair, 2026-09-23): the runner now drives `createHarness()` - the production `compose()` with every fake wired
// in - instead of building `createOrchestrator` by hand over a bare app.db. W1-10's note recorded the hand-built route as
// a deviation forced by the then-stubbed harness; that stub is gone. The data files and the expectations are UNCHANGED.
// What the real route adds around the orchestrator: the fake bridge's messages.db, the real ingest + backlog gate, the
// real triage queue, the real MCP calendar over an in-memory transport, and `dashboard:get` through the real IPC layer.
//
// Two seams the golden corpus does not describe, and how they are set (neither invents an expectation):
//  - `whatsapp.processUnknownSenders` is turned ON. The corpus has no outbound message, so through the real ingest every
//    golden chat is a STRANGER (`isKnown` comes from `bridge.userHasSentIn`), and S0 would hold all 42 cases with
//    `unknown_sender`. The old runner asserted the same thing by inserting the chat with `isKnown: true`. Seeding a
//    from-me message instead would push an extra line into the model's context window, i.e. into the thing under test.
//  - The timeline is delivered as a history-sync burst (no webhook) BEFORE the clock reaches the case's `nowIso`, so the
//    rows are live (not backlog) and the scan that picks them up runs at the case's own "now".
import { afterEach, describe, expect, it } from 'vitest';
import { INTENTS, MISSING_FIELDS, type Item, type ItemCard, type ItemState } from '../../src/shared/types.ts';
import {
  V1_GOLDEN_FILES, // [V2] GOLDEN_FILES gained edits|images|voice (T2 7.1); this runner covers the v1 files
  goldenTimeline,
  loadGoldenCases,
  stubExtractionOf,
  type GoldenCase,
} from '../helpers/goldenLoader.ts';
import { createHarness, type Harness } from '../helpers/harness.ts';

const CASES = loadGoldenCases();

// ---------------------------------------------------------------------------------------------------------------
// 7.2 schema checks over the corpus itself
// ---------------------------------------------------------------------------------------------------------------
describe('golden evaluation set (data contract)', () => {
  it('has at least 40 cases with unique ids and the required language mix', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    expect(CASES.filter((c) => c.lang === 'he').length).toBeGreaterThanOrEqual(15);
    expect(CASES.filter((c) => c.lang === 'en').length).toBeGreaterThanOrEqual(10);
    expect(CASES.filter((c) => c.lang === 'mixed').length).toBeGreaterThanOrEqual(5);
  });

  it('covers every intent and every missing[] value at least once', () => {
    const intents = new Set(CASES.map((c) => stubExtractionOf(c)!.intent));
    for (const intent of INTENTS) expect(intents).toContain(intent);
    const missing = new Set(CASES.flatMap((c) => c.expect.missing ?? []));
    for (const field of MISSING_FIELDS) expect(missing).toContain(field);
  });

  it('keeps at least the six seed injection rows', () => {
    expect(CASES.filter((c) => c.injection === true).length).toBeGreaterThanOrEqual(6);
  });

  it('is synthetic only (T5): every JID is a 9725500000NN test number and no case carries a real-looking key', () => {
    for (const c of CASES) {
      expect(c.chatJid).toMatch(/^9725500000\d{2}@s\.whatsapp\.net$/);
      const dump = JSON.stringify(c);
      expect(dump).not.toMatch(/sk-ant-(?!TESTONLY)/);
      expect(dump).not.toMatch(/AIza(?!TESTONLY)/);
    }
  });

  it('loads a single file on request', () => {
    for (const file of V1_GOLDEN_FILES) expect(loadGoldenCases(file).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 7.2 scripted run, through the real app
// ---------------------------------------------------------------------------------------------------------------
interface RunResult {
  h: Harness;
  item: Item;
  chatLang: string | null;
  /** Every `get-freebusy` the run caused - the S2 prefetch is the only calendar traffic a run may produce. */
  freeBusyCalls: number;
}

/** The one item the run created for this case's chat, whatever state it ended in (`ignored` items are closed). */
function itemOfChat(h: Harness, chatId: number): Item {
  const row = h.repos.db
    .prepare<{ id: number }>('SELECT id FROM items WHERE chat_id = ? ORDER BY id DESC LIMIT 1')
    .get(chatId);
  expect(row, 'the run produced no item for this chat').toBeDefined();
  return h.repos.items.byId(row!.id)!;
}

// The T7 leak guard (tests/setup-guards.ts) runs after EVERY test, so an app may not outlive the test that created it:
// each `it` builds its own.
let open: Harness | null = null;
afterEach(async () => {
  await open?.dispose();
  open = null;
});

async function runCase(c: GoldenCase): Promise<RunResult> {
  const nowMs = Date.parse(c.nowIso);
  const timeline = goldenTimeline(c); // absolute epoch ms, oldest first
  // The app has to be up BEFORE the oldest message, or `live_from_ts` would make the whole timeline backlog.
  const startMs = (timeline[0]?.ts ?? nowMs) - 60_000;

  const h = await createHarness({
    nowMs: startMs,
    timeZone: c.timeZone,
    rules: c.stub.rules,
    busy: (c.calendar?.busy ?? []).map((b) => ({ start: b.startLocal, end: b.endLocal })),
    settings: (s) => {
      s.whatsapp.processUnknownSenders = true; // see the header note
      if (c.settings?.ambiguousHour !== undefined) s.agent.ambiguousHour = c.settings.ambiguousHour;
      if (c.settings?.defaultDurationMin !== undefined) s.calendar.defaultDurationMin = c.settings.defaultDurationMin;
    },
  });
  open = h;

  // The chat window, written to the bridge's messages.db without a webhook - exactly like a real history sync.
  await h.bridge.historySync(
    timeline.map((m) => ({ chatJid: c.chatJid, text: m.text, ts: new Date(m.ts), fromMe: m.fromMe })),
  );
  await h.advance(nowMs - startMs); // ... and only now is it the case's "now"
  await h.settle();

  const chat = h.repos.chats.byJid(c.chatJid);
  expect(chat, 'ingest created no chat row for this case').not.toBeNull();
  const item = itemOfChat(h, chat!.id);
  return {
    h,
    item,
    chatLang: chat!.lang,
    freeBusyCalls: h.calendar.calls.filter((call) => call.tool === 'get-freebusy').length,
  };
}

/** The dashboard bucket a state belongs to (`ignored` is in none of the three lists). */
const BUCKET: Record<ItemState, 'needsReply' | 'inCalendar' | 'infoMissing' | null> = {
  needs_reply: 'needsReply',
  in_calendar: 'inCalendar',
  info_missing: 'infoMissing',
  ignored: null,
};

describe.each(CASES.map((c) => [c.id, c] as const))('golden %s', (_id, c) => {
  it('produces the expected item, proposal, badges and PENDING actions', async () => {
    const { h, item, chatLang, freeBusyCalls } = await runCase(c);

    expect(h.llm.unmatched).toBe(0);
    expect(item.analysis).toBe('done');
    expect(item.errorCode).toBeNull();
    expect(item.state).toBe(c.expect.state);
    expect(item.eventState).toBe(c.expect.eventState);
    expect(item.missing).toEqual(c.expect.missing ?? []);
    expect(item.badges).toEqual(c.expect.badges ?? []);

    const proposal = h.repos.proposals.current(item.id)!;
    expect(proposal.version).toBe(1);
    expect(proposal.extraction).toEqual(stubExtractionOf(c));
    expect(proposal.suspicious).toBe(
      (c.expect.suspicious ?? false) || (c.expect.badges ?? []).includes('manipulation'),
    );

    if (c.expect.startLocal !== undefined) {
      expect(proposal.event).toMatchObject({
        startLocal: c.expect.startLocal,
        endLocal: c.expect.endLocal,
        timeZone: c.timeZone,
      });
    } else if (proposal.event !== null) {
      expect(proposal.event.startLocal).toBe('');
    }

    // Reply language follows the SENDER and is persisted on the chat.
    expect(chatLang).toBe(c.expect.replyLang);
    if (c.expect.needsReply) expect(proposal.replyLang).toBe(c.expect.replyLang);

    // Approval-first: exactly the expected controls exist and every one of them is still PENDING.
    const actions = h.repos.actions.forItem(item.id);
    expect(actions.map((a) => a.kind).sort()).toEqual([...(c.expect.actions ?? [])].sort());
    expect(actions.every((a) => a.state === 'pending')).toBe(true);
    // ... and nothing has left the machine: no send, no calendar write, whatever the message asked for.
    expect(h.bridge.sends).toHaveLength(0);
    expect(h.calendar.calls.filter((call) => call.tool === 'create-event')).toHaveLength(0);
    expect(h.calendar.violations).toEqual([]);

    // The S2 prefetch is the only calendar traffic a run may cause, and it is READ-only.
    expect(freeBusyCalls).toBe(c.expect.eventState === 'proposed' ? 1 : 0);
  });

  it('appears in the dashboard list its state belongs to', async () => {
    const { h, item } = await runCase(c);
    const res = await h.invoke('dashboard:get', undefined);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const dashboard = res.value;

    const bucket = BUCKET[item.state];
    const lists: ItemCard[][] = [dashboard.needsReply, dashboard.inCalendar, dashboard.infoMissing];
    if (bucket === null) {
      expect(lists.flat().map((card) => card.itemId)).not.toContain(item.id);
      expect(dashboard.counts.ignored).toBe(1);
      // An auto-closed item is NOT a dismissed one: it never shows up in the Ignored drawer.
      const ignored = await h.invoke('dashboard:getIgnored', undefined);
      expect(ignored.ok).toBe(true);
      if (ignored.ok) expect(ignored.value.items).toHaveLength(0);
    } else {
      expect(dashboard[bucket].map((card) => card.itemId)).toEqual([item.id]);
      const card = dashboard[bucket][0]!;
      expect(card.card).toBe('full');
      expect(card.badges).toEqual(c.expect.badges ?? []);
      expect(card.actions.map((a) => a.kind).sort()).toEqual([...(c.expect.actions ?? [])].sort());
      if (c.expect.needsReply) expect(card.draft?.lang).toBe(c.expect.replyLang);
      else expect(card.draft).toBeNull();
    }
    expect(dashboard.analysing).toBe(0);
  });
});
