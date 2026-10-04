// tests/golden/golden.v2.test.ts - scripted golden v2 (T2 7.2 parts 1-4, P2 15; owner V2-W1-03-edit-pipeline).
// Everything here is SCRIPTED: no model, no real binary, no network. The rows are synthetic DATA (T5); the injection rows are attack
// payloads for the app under test, never instructions to anyone.
//
//  1. Pipeline plumbing - every edits.jsonl row through the REAL orchestrator (S0 re-check -> S1 -> S2 resolveDelta -> S3 -> S4 -> S5a
//     hand-off) over the REAL repos (in-memory app.db with the v4 triggers) and the REAL ToolGate, with the row's existing event seeded
//     as an app-created in_calendar item. The compose()/harness route of the same rows is `tests/integration/pipeline-edit.test.ts`.
//  2. Cross-provider parity - (a) the same rows with the provider identity of `local`, `claude_cli` and `antigravity_cli`: identical
//     system-prompt bytes, identical data blocks modulo the nonce, identical outcomes, provider_class per B25 (stub transport);
//     (b) the same rows through the harness on the SPAWNED CLI fakes (`StubLlm.toCliScript`) - BLOCKED-BY V2-W2-01 (harness providers)
//     and V2-W1-06 / V2-W1-09 (fake CLI bodies) until they land.
//  3. Auto pass - the rows with a live `on` policy reached through the IPC path (auto:requestEnable + the scripted dialog), asserting
//     `expect.auto` - BLOCKED-BY V2-W1-04 (executor.tryAuto / AutoGate) and V2-W2-01 (compose wiring + dialog script).
//  4. Loader / schema checks over edits, voice and images.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GOLDEN_FILES,
  checkEditsCorpus,
  goldenFileExists,
  goldenWindow,
  lintGoldenCase,
  loadToolCases,
  loadGoldenCases,
  stubExtractionOf,
  type GoldenCase,
  type GoldenFile,
} from '../helpers/goldenLoader.ts';
import { StubLlm } from '../fakes/stub-llm.ts';
import { createSeededRandom, createVirtualClock } from '../helpers/virtualClock.ts';
import { createIngestDouble, createTestEnv, seedCalendarEvent, seedChat, type TestEnv } from './testDb.ts';
import { createOrchestrator, type AutoOutcome } from '../../src/main/agent/orchestrator.ts';
import { buildSystemPrompt } from '../../src/main/agent/prompt.ts';
import type { LlmProvider, ProviderFactory } from '../../src/main/llm/types.ts';
import type { ActionId, EpochMs, Item, Message, ProviderId } from '../../src/shared/types.ts';
import { createHarness, type Harness } from '../helpers/harness.ts';
import { dialog as mockDialog } from '../mocks/electron.ts';
import { DEFAULT_AUTO_SCOPE } from '../../src/shared/schemas.ts';
import { AUTO_REASONS, type AutoReason } from '../../src/shared/types.ts';
import { FEATURE_GATES } from '../../src/main/agent/gates.ts';

const EDITS = loadGoldenCases('edits');

// =====================================================================================================================
// the orchestrator-level runner (parts 1 and 2a)
// =====================================================================================================================

interface RowRun {
  env: TestEnv;
  item: Item;
  llm: StubLlm;
  tryAuto: ActionId[];
  /** the order of the S5a hand-offs relative to the last dashboard notification */
  notifiedAfterAuto: boolean;
  seededEventIds: string[];
}

/** Bridge-shaped rows of the case window (reactions are never part of a window: ingest drops them, P2 2). */
function windowMessages(c: GoldenCase): { rows: Message[]; triggerIndex: number } {
  const w = goldenWindow(c).filter((r) => r.kind !== 'reaction');
  const rows: Message[] = w.map((r, i) => ({
    rowid: i + 1,
    waMsgId: `wamid.G${i + 1}`,
    chatJid: c.chatJid,
    senderUser: r.fromMe ? 'me' : c.chatJid.slice(0, c.chatJid.indexOf('@')),
    text: r.text,
    ts: r.ts,
    fromMe: r.fromMe,
    mediaType: '',
    deleted: false,
  }));
  // the item a real ingest would have opened: the newest contact row (a self row with a silent contact: the user's own row, F28)
  let triggerIndex = rows.map((m) => !m.fromMe).lastIndexOf(true);
  if (triggerIndex < 0 || c.triggerAuthor === 'self') {
    const firstContact = rows.findIndex((m) => !m.fromMe);
    triggerIndex = firstContact >= 0 ? firstContact : rows.length - 1;
  }
  return { rows, triggerIndex };
}

async function runRow(c: GoldenCase, opts: { provider?: ProviderId; updateSurface?: boolean } = {}): Promise<RowRun> {
  const nowMs = Date.parse(c.nowIso) as EpochMs;
  const env = createTestEnv({ calendarConnected: true });
  const clock = createVirtualClock(nowMs);
  const chat = seedChat(env.repos, { jid: c.chatJid });
  const seededEventIds: string[] = [];
  let n = 0;
  for (const ev of [...(c.olderEvents ?? []), ...(c.existingEvent ? [c.existingEvent] : [])]) {
    n += 1;
    seededEventIds.push(
      seedCalendarEvent(env.repos, chat, {
        ...ev,
        eventId: `evtsrc9${String(n).padStart(3, '0')}`, // deterministic: the parity runs compare whole deltas
        createdAt: (nowMs - 3 * 86_400_000 + n * 60_000) as EpochMs,
      }).eventId,
    );
  }
  const { rows, triggerIndex } = windowMessages(c);
  const trigger = rows[triggerIndex]!;
  const created = env.repos.items.createOpen({
    chatId: chat.id,
    triggerMsgId: trigger.waMsgId,
    triggerTs: trigger.ts!,
    analysis: 'queued',
    holdReason: null,
    now: trigger.ts!,
  });
  const provider = opts.provider ?? 'local';
  const llm = StubLlm.fromGoldenCase(c, { id: provider, clock });
  const providers: ProviderFactory = {
    get: () => Promise.resolve(llm as LlmProvider),
    usable: () => ({ ok: true }),
    invalidate: () => Promise.resolve(),
  };
  const tryAuto: ActionId[] = [];
  let lastAutoAt = -1;
  let lastNotifyAt = -1;
  let tick = 0;
  const orchestrator = createOrchestrator({
    repos: env.repos,
    providers,
    gate: env.gate,
    ingest: createIngestDouble(rows),
    settings: () => env.settings,
    clock,
    random: createSeededRandom(),
    log: env.log,
    notifyChanged: () => {
      lastNotifyAt = ++tick;
    },
    updateSurfaceAvailable: () => opts.updateSurface ?? true,
    tryAuto: (id): Promise<AutoOutcome> => {
      tryAuto.push(id);
      lastAutoAt = ++tick;
      return Promise.resolve({ verdict: 'none', reason: 'no_policy' });
    },
  });
  await orchestrator.runChat(chat.id, new AbortController().signal);
  return {
    env,
    item: env.repos.items.byId(created.id)!,
    llm,
    tryAuto,
    notifiedAfterAuto: lastAutoAt < 0 || lastNotifyAt > lastAutoAt,
    seededEventIds,
  };
}

const minute = (s: string): string => s.slice(0, 16);

function assertRow(c: GoldenCase, r: RowRun): void {
  const { env, item, llm } = r;
  const e = c.expect;
  expect(llm.unmatched, 'a stub rule did not match').toBe(0);
  expect(item.errorCode).toBeNull();
  // ---- state ----
  if (e.state !== undefined) expect(item.state).toBe(e.state);
  if (e.stateIn !== undefined) expect(e.stateIn).toContain(item.state);
  expect(item.eventState).toBe(e.eventState);
  if (e.missing !== undefined) expect(item.missing).toEqual(e.missing);
  // ---- actions: approval-first - every control is still PENDING and nobody approved anything ----
  const actions = env.repos.actions.forItem(item.id);
  const kinds = actions
    .filter((a) => a.state === 'pending')
    .map((a) => a.kind)
    .sort();
  expect(actions.every((a) => a.state === 'pending' && a.approvedBy === null)).toBe(true);
  if (e.actions !== undefined) expect(kinds).toEqual([...e.actions].sort());
  for (const k of e.actionsInclude ?? []) expect(kinds).toContain(k);
  for (const k of e.actionsNot ?? []) expect(kinds).not.toContain(k);
  // ---- badges ----
  for (const b of e.badges ?? []) expect(item.badges).toContain(b);
  if (e.badgesAnyOf !== undefined) expect(e.badgesAnyOf.some((b) => item.badges.includes(b as never))).toBe(true);
  if (e.badgesIfUpdate !== undefined && kinds.includes('update_event'))
    for (const b of e.badgesIfUpdate) expect(item.badges).toContain(b);
  // ---- the proposal ----
  const proposal = env.repos.proposals.current(item.id)!;
  expect(proposal.extraction).not.toBeNull();
  for (const [k, v] of Object.entries(e.extraction ?? {}))
    expect((proposal.extraction as unknown as Record<string, unknown>)[k], k).toEqual(
      k === 'needsReply' && c.triggerAuthor === 'self' ? false : v,
    );
  if (e.change !== undefined) {
    expect(proposal.extraction!.change).toBe(e.change.kind);
    const d = proposal.delta;
    if (e.change.toStartLocal !== undefined) expect(minute(d!.to.startLocal)).toBe(e.change.toStartLocal);
    if (e.change.toEndLocal !== undefined) expect(minute(d!.to.endLocal)).toBe(e.change.toEndLocal);
    if (e.change.toStatus !== undefined) expect(d!.to.status).toBe(e.change.toStatus);
    if (e.change.toLocation !== undefined) expect(d!.to.location).toBe(e.change.toLocation);
    if (e.change.confidenceIn !== undefined) expect(e.change.confidenceIn).toContain(d!.confidence);
    if (e.change.kind === 'no_change' || e.change.kind === 'new_event') expect(d).toBeNull();
  }
  if (e.changeKindIn !== undefined) expect(e.changeKindIn).toContain(proposal.extraction!.change);
  if (e.startLocal !== undefined) expect(proposal.event?.startLocal).toBe(e.startLocal);
  if (e.endLocal !== undefined) expect(proposal.event?.endLocal).toBe(e.endLocal);
  if (e.suspicious === true) expect(proposal.suspicious).toBe(true);
  expect(proposal.triggerAuthor).toBe(c.triggerAuthor ?? 'contact');
  // ---- LLM stages (exact) ----
  const stages = env.db
    .prepare<{ stage: string }>('SELECT stage FROM runs WHERE item_id = ? ORDER BY id')
    .all(item.id)
    .map((x) => x.stage);
  if (e.llmStages !== undefined) expect(stages).toEqual(e.llmStages);
  else expect(stages).toEqual(e.needsReply && c.triggerAuthor !== 'self' ? ['extract', 'draft'] : ['extract']);
  // ---- taint ----
  const chat = env.repos.chats.byJid(c.chatJid)!;
  if (e.chatTainted === true) expect(chat.autoTaintedUntil ?? 0).toBeGreaterThan(Date.parse(c.nowIso));
  // ---- S5a: exactly the pending calendar actions went to tryAuto, BEFORE dashboard:changed (P2 9.6) ----
  const calendarIds = actions
    .filter((a) => a.kind !== 'send_reply')
    .map((a) => a.id)
    .sort();
  expect([...r.tryAuto].sort()).toEqual(calendarIds);
  expect(r.notifiedAfterAuto).toBe(true);
  // ---- I3' / B27: no event id, item id or JID ever reaches a model ----
  const sent = JSON.stringify(llm.calls.map((call) => call.messages));
  for (const id of r.seededEventIds) expect(sent).not.toContain(id);
  expect(sent).not.toContain(c.chatJid);
}

// =====================================================================================================================
// part 1 - pipeline plumbing
// =====================================================================================================================
describe('golden v2 part 1 - edits.jsonl through the real pipeline (local, stub transport)', () => {
  let open: RowRun | null = null;
  afterEach(() => {
    open?.env.dispose();
    open = null;
  });

  it.each(EDITS.map((c) => [c.id, c] as const))('%s', async (_id, c) => {
    open = await runRow(c);
    assertRow(c, open);
  });

  it('without a proven update surface every delta degrades to the info card (B4): no update_event is ever proposed', async () => {
    for (const c of EDITS.filter(
      (x) => x.expect.change?.kind === 'reschedule' && x.expect.actions?.includes('update_event'),
    )) {
      const r = await runRow(c, { updateSurface: false });
      const kinds = r.env.repos.actions.forItem(r.item.id).map((a) => a.kind);
      expect(kinds, c.id).not.toContain('update_event');
      expect(r.item.badges, c.id).toContain('change_in_google');
      r.env.dispose();
    }
  });
});

// =====================================================================================================================
// part 2a - cross-provider parity on the stub transport (prompt bytes, data blocks, outcomes, provider_class)
// =====================================================================================================================
describe('golden v2 part 2a - parity across provider identities (identical prompt bytes and outcomes)', () => {
  const PARITY: ProviderId[] = ['local', 'claude_cli', 'antigravity_cli'];
  const WANT_CLASS: Record<string, string> = {
    local: 'local',
    claude_cli: 'cli_unproven',
    antigravity_cli: 'cli_unproven',
  };

  it.each(EDITS.map((c) => [c.id, c] as const))('%s', async (_id, c) => {
    const outcomes: Array<{ state: string; eventState: string; kinds: string[]; badges: string[]; delta: unknown }> =
      [];
    const systems: string[][] = [];
    const blocks: string[][] = [];
    for (const p of PARITY) {
      const r = await runRow(c, { provider: p });
      try {
        const proposal = r.env.repos.proposals.current(r.item.id)!;
        outcomes.push({
          state: r.item.state,
          eventState: r.item.eventState,
          kinds: r.env.repos.actions
            .forItem(r.item.id)
            .map((a) => a.kind)
            .sort(),
          badges: [...r.item.badges],
          delta: proposal.delta === null ? null : { ...proposal.delta },
        });
        // B25 (stub transport has no CLI init proof): claude_cli => cli_unproven; antigravity_cli is ALWAYS cli_unproven in v2.0
        expect(proposal.providerClass).toBe(WANT_CLASS[p]);
        systems.push(r.llm.calls.map((call) => String(call.messages.find((m) => m.role === 'system')?.content)));
        blocks.push(
          r.llm.calls.map((call) =>
            JSON.stringify(call.messages.filter((m) => m.role === 'user')).replace(/[0-9a-f]{16}/g, 'NONCE'),
          ),
        );
      } finally {
        r.env.dispose();
      }
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[2]).toEqual(outcomes[0]);
    // I4' / B15 / B29: the system prompts are byte-identical for every provider (and equal to the one builder's output)
    expect(systems[1]).toEqual(systems[0]);
    expect(systems[2]).toEqual(systems[0]);
    expect(blocks[1]).toEqual(blocks[0]);
    expect(blocks[2]).toEqual(blocks[0]);
    const s1 = systems[0]![0]!;
    expect(
      s1.startsWith(
        buildSystemPrompt({
          stage: 'extract',
          nowIso: '2026-09-21T07:00:00.000Z',
          tz: 'UTC',
          replyLang: 'en',
          userGender: 'unspecified',
          nonce: '0123456789abcdef',
        }).split('\n\nCONTEXT')[0]!,
      ),
    ).toBe(true);
  });
});

// =====================================================================================================================
// part 2b / part 3 - through compose() (harness) - BLOCKED until V2-W2-01 wires the v2 orchestrator deps, the CLI fakes and the
// auto path (see ops/agent-notes/V2-W1-03-edit-pipeline.md BLOCKED-BY). Written against the frozen harness v2 surface.
// =====================================================================================================================
async function harnessRow(c: GoldenCase, provider: ProviderId): Promise<{ h: Harness; item: Item }> {
  const nowMs = Date.parse(c.nowIso);
  const window = goldenWindow(c).filter((r) => r.kind !== 'reaction');
  const startMs = (window[0]?.ts ?? nowMs) - 60_000;
  const cli =
    provider === 'claude_cli'
      ? { cli: { claude: { script: c.stub.rules } } }
      : provider === 'antigravity_cli'
        ? { cli: { agy: { script: c.stub.rules } } }
        : {};
  const h = await createHarness({ nowMs: startMs, timeZone: c.timeZone, rules: c.stub.rules, provider, ...cli });
  const chat = h.repos.chats.upsertFromBridge(c.chatJid, null, true, startMs as EpochMs);
  for (const ev of [...(c.olderEvents ?? []), ...(c.existingEvent ? [c.existingEvent] : [])])
    seedCalendarEvent(h.repos, chat, { ...ev, createdAt: (startMs - 86_400_000) as EpochMs });
  await h.bridge.historySync(
    window.map((m) => ({ chatJid: c.chatJid, text: m.text, ts: new Date(m.ts), fromMe: m.fromMe })),
  );
  await h.advance(nowMs - startMs);
  await h.settle();
  const row = h.repos.db
    .prepare<{ id: number }>(
      'SELECT id FROM items WHERE chat_id = ? AND calendar_event_id IS NULL ORDER BY id DESC LIMIT 1',
    )
    .get(chat.id);
  return { h, item: h.repos.items.byId(row!.id)! };
}

describe('golden v2 part 2b - parity on the spawned CLI fakes (harness)', () => {
  let open: Harness | null = null;
  afterEach(async () => {
    await open?.dispose();
    open = null;
  });
  const CANONICAL = EDITS.filter((c) => ['en-ev-01', 'he-ev-03', 'mix-ev-01', 'en-fp-02'].includes(c.id));
  for (const provider of ['claude_cli', 'antigravity_cli'] as const) {
    it.each(CANONICAL.map((c) => [c.id, c] as const))(`${provider} %s`, async (_id, c) => {
      const { h, item } = await harnessRow(c, provider);
      open = h;
      expect(item.eventState).toBe(c.expect.eventState);
      const kinds = h.repos.actions
        .forItem(item.id)
        .map((a) => a.kind)
        .sort();
      if (c.expect.actions !== undefined) expect(kinds).toEqual([...c.expect.actions].sort());
      expect(h.repos.proposals.current(item.id)!.providerClass).toBe(
        provider === 'claude_cli' ? 'cli_proven' : 'cli_unproven',
      );
    });
  }
});

describe('golden v2 part 3 - auto pass (live policy through the IPC path)', () => {
  let open: Harness | null = null;
  afterEach(async () => {
    await open?.dispose();
    open = null;
  });
  const AUTO_ROWS = EDITS.filter(
    (c) => c.expect.auto !== undefined && c.expect.auto !== null && c.expect.auto.reason !== undefined,
  );
  it.each(AUTO_ROWS.map((c) => [c.id, c] as const))('%s', async (_id, c) => {
    const { h, item } = await harnessRow(c, 'local');
    open = h;
    // [V2-W2-01] B7 preconditions of auto:requestEnable, reached the way a user reaches them: a track record of three click-approved
    // creates (other chats, long past) and the user's "Turn on" + checkbox in the main-owned native dialog (scripted mock).
    for (let i = 0; i < 3; i += 1) {
      const other = h.repos.chats.upsertFromBridge(
        `9725500000${String(80 + i)}@s.whatsapp.net`,
        null,
        true,
        (Date.parse(c.nowIso) - 30 * 86_400_000) as EpochMs,
      );
      seedCalendarEvent(h.repos, other, {
        title: 'track record',
        startLocal: '2026-08-20T10:00',
        endLocal: '2026-08-20T11:00',
        eventId: `evttrack${String(i)}`,
        createdAt: (Date.parse(c.nowIso) - 30 * 86_400_000) as EpochMs,
      });
    }
    mockDialog.__script([{ response: 1, checkboxChecked: true }]);
    h.setWindowState({ focused: true, visible: true });
    // [V2-W2-01] the frozen AutoScope shape (C2 5; the earlier literal used pre-C2 key names and was refused as BAD_REQUEST)
    const enabled = await h.invoke('auto:requestEnable', {
      scope: { ...DEFAULT_AUTO_SCOPE, creates: true, edits: true, cancels: false },
      trial: false,
    });
    expect(enabled).toMatchObject({ ok: true });
    const retriage = await h.invoke('item:retriage', { itemId: item.id } as never);
    expect(retriage.ok).toBe(true);
    await h.settle();
    const pending = h.repos.actions.forItem(item.id).find((a) => a.kind !== 'send_reply' && a.state === 'pending');
    const decision = pending === undefined ? null : h.repos.autoDecisions.forAction(pending.id);
    const want = gateAdjusted(c.expect.auto!, pending?.kind ?? null, c.expect.badges ?? []);
    expect(decision?.verdict).toBe(want.verdict);
    expect(decision?.reason).toBe(want.reason);
  });
});

/**
 * [V2-W2-01] The row expectations describe the gate logic in isolation; through the real pipeline two FAIL-CLOSED facts come first
 * whenever they rank earlier in C2's AUTO_REASONS order (the gate reports the FIRST failing reason):
 *  - D-068: every golden gate ships `false` (M-GOLDEN-1 records them), so an automatic update_event falls back `low_confidence`
 *    (autoGate: `editsGatePassed`) until FEATURE_GATES.local.editsPassed is recorded true - then the row's own reason applies unchanged;
 *  - B28: S4 taints the chat of a `manipulation` proposal in the same run, so such a row reports `chat_tainted` before `badge_red`.
 */
function gateAdjusted(
  exp: { verdict: string; reason?: string },
  pendingKind: string | null,
  badges: readonly string[],
): { verdict: string; reason: string | undefined } {
  const extra: AutoReason[] = [];
  if (badges.includes('manipulation')) extra.push('chat_tainted');
  if (pendingKind === 'update_event' && !FEATURE_GATES.local.editsPassed) extra.push('low_confidence');
  const idx = (r: string): number => (AUTO_REASONS as readonly string[]).indexOf(r);
  const first = extra
    .filter((r) => exp.reason === undefined || exp.reason === 'ok' || idx(r) < idx(exp.reason))
    .sort((a, b) => idx(a) - idx(b))[0];
  return first === undefined ? { verdict: exp.verdict, reason: exp.reason } : { verdict: 'fallback', reason: first };
}

// =====================================================================================================================
// part 4 - loader / schema checks
// =====================================================================================================================
describe('golden v2 part 4 - loader and schema checks', () => {
  it('edits.jsonl: 27 rows = 25 non-injection + 2 injection, every change kind, the four B20 fields in every stub', () => {
    expect(checkEditsCorpus(EDITS)).toEqual([]);
  });

  it('edits.jsonl: the ids are exactly the P2 15.3 rows, in order', () => {
    expect(EDITS.map((c) => c.id)).toEqual([
      'he-ev-01',
      'he-ev-02',
      'he-ev-03',
      'he-ev-04',
      'he-ev-05',
      'en-ev-01',
      'en-ev-02',
      'en-ev-03',
      'en-ev-04',
      'en-ev-05',
      'mix-ev-01',
      'he-fp-01',
      'en-fp-01',
      'en-fp-02',
      'en-fp-03',
      'he-fp-02',
      'en-fp-04',
      'he-fp-03',
      'he-self-01',
      'en-self-01',
      'en-dur-01',
      'he-dur-01',
      'en-2ev-01',
      'he-2ev-01',
      'en-fp-05',
      'inj-ev-en-01',
      'inj-ev-he-02',
    ]);
  });

  it('edits.jsonl: anchor 2026-09-21T07:00:00.000Z and the P2 15.3 message texts verbatim', () => {
    for (const c of EDITS) expect(c.nowIso).toBe('2026-09-21T07:00:00.000Z');
    expect(EDITS.find((c) => c.id === 'he-ev-01')!.messages[0]!.text).toBe('בוא נזיז ל-5');
    expect(EDITS.find((c) => c.id === 'en-self-01')!.messages.map((m) => m.kind ?? 'text')).toEqual([
      'text',
      'reaction',
    ]);
  });

  it('every stub extraction of edits.jsonl is schema-valid (strict v2 ExtractionSchema)', async () => {
    const { ExtractionSchema } = await import('../../src/shared/schemas.ts');
    for (const c of EDITS) expect(ExtractionSchema.safeParse(stubExtractionOf(c)).success, c.id).toBe(true);
  });

  it('ids are unique across every golden file present, and every case passes the T5 / T12 lint', () => {
    const files = GOLDEN_FILES.filter((f) => goldenFileExists(f));
    expect(files).toEqual(expect.arrayContaining(['he', 'en', 'mixed', 'edits', 'voice']));
    const all = files.flatMap((f: GoldenFile) => loadGoldenCases(f));
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    for (const c of all) expect(lintGoldenCase(c), c.id).toEqual([]);
  });

  it('voice.jsonl: 12 rows, 4 he / 4 en / 4 mixed (T2 7.1)', () => {
    const voice = loadGoldenCases('voice');
    expect(voice).toHaveLength(12);
    expect(voice.filter((c) => c.lang === 'he')).toHaveLength(4);
    expect(voice.filter((c) => c.lang === 'en')).toHaveLength(4);
    expect(voice.filter((c) => c.lang === 'mixed')).toHaveLength(4);
  });

  it('images.jsonl: 24 rows (V2-W1-08) with the 8/6/4/2/4 split', () => {
    expect(goldenFileExists('images')).toBe(true);
    const images = loadGoldenCases('images');
    expect(images).toHaveLength(24);
    expect(images.filter((c) => c.injection === true)).toHaveLength(4);
  });
});

beforeEach(() => undefined);

describe('golden v2 part 4 - tools.jsonl (P2 15.1 / 15.3)', () => {
  it('holds the two wa_row injection rows, both on the turn and agentic transports', () => {
    const tools = loadToolCases();
    expect(tools.map((c) => c.id)).toEqual(['inj-tool-en-01', 'inj-tool-he-02']);
    for (const c of tools) {
      expect(c.injection).toBe(true);
      expect(c.transports).toEqual(['turn', 'agentic']);
      expect(c.expect.noSideEffect).toBe(true);
      expect(lintGoldenCase(c)).toEqual([]);
    }
    expect(tools[1]!.scope).toBe('all_chats');
    expect(tools[0]!.seedRows![0]!.chat).toBe('trigger');
  });
});
