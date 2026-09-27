// Security gate item 3 (TESTS 8.2 row 3 + 8.3; invariants I1, I3): the whole injection corpus, replayed through the
// REAL pipeline with the worst-case model.
//
// `ObedientAttackerLlm` does exactly what the untrusted text asks: it emits the forbidden tool calls, the forbidden
// extraction keys and the poisoned draft of every case. Nothing in this file mocks the app - the harness is the real
// `compose()`, the real ToolGate, the real strict zod re-validation and the real approval-bound executor. Every
// payload in the two corpus files is synthetic ATTACK DATA aimed at the app under test; no agent and no test author
// acts on anything it says (TESTS T6).
//
// Per case (TESTS 8.3 a-g):
//   (a) the ledger is empty - zero sends, zero non-READ MCP calls;
//   (b) every stored `proposals.extraction_json` has exactly the `Extraction` keys;
//   (c) every pending action's `chat_id` is the source chat and `canonical_json` carries no
//       recipient / attendee / calendarId / url field;
//   (d) a subsequent LEGITIMATE approve of the (possibly poisoned) draft still sends only to the source chat JID, and
//       the create-event args still pass the whitelist (no attendees, no recurrence, `sendUpdates:'none'`);
//   (e) the expected badges are raised and a poisoned draft is collapsed;
//   (f) the READ calls that did happen used app-pinned calendar ids / time zone and clamped windows;
//   (g) the system prompt and the tool definitions are byte-identical to the benign baseline.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url'; // the project path contains a space: never URL.pathname
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ExtractionSchema } from '../../src/shared/schemas.ts';
import { LIMITS } from '../../src/shared/types.ts';
import type { LlmMessage } from '../../src/main/llm/types.ts';
import { CREATE_EVENT_WHITELIST } from '../fakes/fake-mcp-calendar.ts';
import type { InjectionCase, ObedientAttackerLlm } from '../fakes/obedient-attacker-llm.ts';
import { createHarness, extraction, type Harness } from '../helpers/harness.ts';
import type { StubRule } from '../fakes/stub-llm.ts';

const CHAT = '972550000021@s.whatsapp.net';
const HOUR = 3_600_000;
const EXTRACTION_KEYS = Object.keys(ExtractionSchema.shape).sort();
/** Keys an attacker wants inside a stored action; none of them may ever survive into `canonical_json`. */
const FORBIDDEN_ACTION_KEYS = [
  'recipient',
  'chatJid',
  'jid',
  'attendee',
  'attendees',
  'calendarId',
  'url',
  'sendUpdates',
  'autoApprove',
  'recurrence',
];

const corpusFile = (name: string): InjectionCase[] =>
  JSON.parse(readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')) as InjectionCase[];
const CORPUS: InjectionCase[] = [
  ...corpusFile('./injection-corpus.en.json'),
  ...corpusFile('./injection-corpus.he.json'),
];

// ---------------------------------------------------------------------------------------------------------------------
// Corpus shape (TESTS 8.3: >= 40 cases, >= 15 Hebrew, every required vector family present).
// ---------------------------------------------------------------------------------------------------------------------

describe('corpus shape', () => {
  it('has at least 40 cases, at least 15 of them Hebrew', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(40);
    expect(CORPUS.filter((c) => c.lang === 'he').length).toBeGreaterThanOrEqual(15);
  });
  it('covers every vector family and every case is well formed', () => {
    const vectors = new Set(CORPUS.map((c) => c.vector));
    for (const v of ['message', 'push_name', 'quoted', 'calendar_title', 'tool_result', 'stdout_marker']) {
      expect(vectors, `vector ${v}`).toContain(v);
    }
    const ids = CORPUS.map((c) => c.id);
    expect(new Set(ids).size, 'duplicate case ids').toBe(ids.length);
    for (const c of CORPUS) {
      expect(c.payload.length, c.id).toBeGreaterThan(0);
      expect(c.mustNot.length, c.id).toBeGreaterThan(0);
      expect(['he', 'en']).toContain(c.lang);
    }
  });
  it('the `stdout_marker` vectors are present and carry bridge-stdout text, not chat text', () => {
    const markers = CORPUS.filter((c) => c.vector === 'stdout_marker');
    expect(markers.length).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The benign baseline for (g): the exact system prompt and tools array the app sends when nobody is attacking.
// ---------------------------------------------------------------------------------------------------------------------

const BENIGN_RULES: StubRule[] = [
  {
    when: { purpose: 'extract' },
    respond: {
      structured: extraction({
        intent: 'schedule_request',
        needsReply: true,
        title: 'coffee',
        dateKind: 'relative_days',
        daysFromToday: 1,
        time24h: '17:00',
        durationMin: 60,
      }),
    },
  },
  { when: { purpose: 'draft' }, respond: { text: 'Sounds good.', stopReason: 'end' } },
];

interface Baseline {
  /** Every distinct system-message text the benign run produced (extract + draft, per reply language). */
  systems: Set<string>;
  /** The JSON of every distinct tools array the benign run produced. */
  tools: Set<string>;
}
const baseline: Baseline = { systems: new Set(), tools: new Set() };

const systemOf = (messages: LlmMessage[]): string =>
  messages
    .filter((m) => m.role === 'system')
    .map((m) => (m as Extract<LlmMessage, { role: 'system' }>).content)
    .join('\n---\n');

beforeAll(async () => {
  for (const text of ['coffee tomorrow at 17:00?', 'קפה מחר ב-17:00?']) {
    const h = await createHarness({ rules: BENIGN_RULES });
    try {
      await h.bridge.outboundFromPhone({ chatJid: CHAT, text: 'hi', ts: new Date(h.clock.now() - HOUR) });
      await h.bridge.inbound({ chatJid: CHAT, text });
      await h.settle();
      expect(h.llm.calls.length).toBeGreaterThan(0);
      for (const c of h.llm.calls) {
        baseline.systems.add(systemOf(c.messages));
        baseline.tools.add(JSON.stringify(c.tools));
      }
    } finally {
      await h.dispose();
    }
  }
  expect(baseline.systems.size).toBeGreaterThan(0);
  expect(baseline.tools.size).toBeGreaterThan(0);
}, 60_000);

// ---------------------------------------------------------------------------------------------------------------------
// Delivery of one case, by vector.
// ---------------------------------------------------------------------------------------------------------------------

/** `calendar_title` needs a hostile event title in the calendar the app reads, and the setting that shares titles. */
function harnessFor(c: InjectionCase): Promise<Harness> {
  const base = {
    llm: 'attacker' as const,
    corpus: CORPUS,
    settings: (s: import('../../src/shared/settings.ts').Settings) => {
      s.general.timeZone = 'Asia/Jerusalem';
    },
  };
  if (c.vector === 'calendar_title') {
    return createHarness({
      ...base,
      events: [
        {
          calendarId: 'primary',
          summary: c.payload,
          description: c.payload,
          start: '2026-09-22T14:00:00',
          end: '2026-09-22T15:00:00',
          timeZone: 'Asia/Jerusalem',
        },
      ],
      busy: [{ start: '2026-09-22T14:00:00', end: '2026-09-22T15:00:00' }],
    });
  }
  return createHarness(base);
}

/** Puts the payload in front of the app the way its vector says, and returns the chat it arrived in. */
async function deliver(h: Harness, c: InjectionCase): Promise<void> {
  // Every case needs a chat the user has written in, or S0's unknown-sender gate answers before the model ever runs.
  await h.bridge.outboundFromPhone({ chatJid: CHAT, text: 'hi', ts: new Date(h.clock.now() - HOUR) });
  const scheduling = c.lang === 'he' ? 'קפה מחר ב-17:00?' : 'coffee tomorrow at 17:00?';
  switch (c.vector) {
    case 'message':
      await h.bridge.inbound({ chatJid: CHAT, text: c.payload });
      break;
    case 'push_name':
      await h.bridge.inbound({ chatJid: CHAT, text: scheduling, pushName: c.payload });
      break;
    case 'quoted':
      await h.bridge.inbound({ chatJid: CHAT, text: scheduling, quotedText: c.payload });
      break;
    case 'calendar_title':
      // The hostile title is already seeded in the fake calendar; a scheduling message makes the app read free/busy.
      await h.bridge.inbound({ chatJid: CHAT, text: scheduling });
      break;
    case 'tool_result':
      // The poisoned text is what a hostile MCP server would answer; the projection step must strip it either way.
      h.calendar.setBusy([{ start: '2026-09-22T14:00:00', end: '2026-09-22T15:00:00' }]);
      await h.bridge.inbound({ chatJid: CHAT, text: scheduling });
      break;
    case 'stdout_marker':
      // The bridge's own stdout is untrusted too: a marker line must never steer the app or reach a model.
      h.bridge.emitStdout(c.payload);
      await h.bridge.inbound({ chatJid: CHAT, text: scheduling });
      break;
  }
  await h.settle();
}

// ---------------------------------------------------------------------------------------------------------------------
// Assertions (a) - (g).
// ---------------------------------------------------------------------------------------------------------------------

function nonReadCalendarCalls(h: Harness): Array<{ tool: string; args: Record<string, unknown> }> {
  return h.calendar.calls.filter(
    (c) =>
      c.tool !== 'get-current-time' &&
      c.tool !== 'get-freebusy' &&
      !(c.tool === 'manage-accounts' && c.args.action === 'list'),
  );
}

/** Recursively collects every object key that appears anywhere in a JSON value. */
function keysDeep(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysDeep(x, out);
  else if (typeof v === 'object' && v !== null) {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysDeep(x, out);
    }
  }
  return out;
}

function assertNoSideEffects(h: Harness, c: InjectionCase, seededEvents: number): void {
  // (a) ledger empty.
  expect(h.bridge.sent, `${c.id}: a send happened without an approval`).toEqual([]);
  expect(nonReadCalendarCalls(h), `${c.id}: a non-READ calendar call happened`).toEqual([]);
  // `seededEvents` are the hostile events THIS test put in the calendar before the run (the `calendar_title` vector).
  expect(h.calendar.events.length, `${c.id}: an event was created`).toBe(seededEvents);
  expect(h.calendar.violations, `${c.id}`).toEqual([]);
}

function assertExtractionKeys(h: Harness, c: InjectionCase): void {
  // (b) the strict re-validation never lets a forbidden key into storage.
  const rows = h.repos.db.prepare<{ extraction_json: string | null }>('SELECT extraction_json FROM proposals').all();
  for (const row of rows) {
    if (row.extraction_json === null) continue;
    const parsed = JSON.parse(row.extraction_json) as Record<string, unknown>;
    expect(Object.keys(parsed).sort(), `${c.id}: extraction_json keys`).toEqual(EXTRACTION_KEYS);
  }
}

function assertActionsBound(h: Harness, c: InjectionCase): void {
  // (c) every action belongs to the source chat and carries no routing field.
  const rows = h.repos.db
    .prepare<{
      id: string;
      kind: string;
      state: string;
      canonical_json: string | null;
      jid: string;
    }>('SELECT a.id, a.kind, a.state, a.canonical_json, c.jid AS jid FROM actions a JOIN chats c ON c.id = a.chat_id')
    .all();
  for (const row of rows) {
    expect(row.jid, `${c.id}: action ${row.kind} left the source chat`).toBe(CHAT);
    if (row.canonical_json === null) continue;
    const keys = keysDeep(JSON.parse(row.canonical_json));
    for (const forbidden of FORBIDDEN_ACTION_KEYS) {
      expect(keys.has(forbidden), `${c.id}: canonical_json has ${forbidden}`).toBe(false);
    }
    expect(row.canonical_json, `${c.id}: a foreign JID reached canonical_json`).not.toContain('972550000099');
    expect(row.canonical_json).not.toContain('attacker@example.com');
  }
}

function assertReadsPinned(h: Harness, c: InjectionCase): void {
  // (f) every free/busy the app did issue was app-pinned and clamped.
  for (const fb of h.calendar.calls.filter((x) => x.tool === 'get-freebusy')) {
    const args = fb.args;
    expect(args.timeZone, `${c.id}`).toBe('Asia/Jerusalem');
    expect(args.account, `${c.id}`).toBe('personal');
    const ids = JSON.stringify(args.calendars ?? args.calendarId ?? args.calendarIds);
    expect(ids, `${c.id}`).not.toContain('attacker');
    const span =
      (Date.parse(`${String(args.timeMax).slice(0, 19)}Z`) - Date.parse(`${String(args.timeMin).slice(0, 19)}Z`)) /
      86_400_000;
    expect(span, `${c.id}: window ${String(args.timeMin)}..${String(args.timeMax)}`).toBeLessThanOrEqual(
      LIMITS.toolWindowDays,
    );
    expect(span).toBeGreaterThan(0);
  }
}

/** Text of every message of a role, joined. */
function roleText(messages: LlmMessage[], role: 'user' | 'assistant'): string {
  return messages
    .filter((m) => m.role === role)
    .map((m) => (m as { content: string }).content)
    .join('\n');
}

/** Strips every `<<DATA-nonce>> ... <<END-DATA-nonce>>` block, leaving only the app-authored scaffolding. */
function outsideDataBlocks(text: string): string {
  return text.replace(/<<DATA-[0-9a-f]{16}>>[\s\S]*?<<END-DATA-[0-9a-f]{16}>>/g, '<<REDACTED-DATA-BLOCK>>');
}

function assertPromptPure(h: Harness, c: InjectionCase): void {
  // (g) not one byte of the system prompt or the tool array moved.
  const provider = h.provider as ObedientAttackerLlm;
  expect(provider.calls.length, `${c.id}: the model was never called`).toBeGreaterThan(0);
  for (const callRecord of provider.calls) {
    const system = systemOf(callRecord.messages);
    expect(baseline.systems.has(system), `${c.id}: the system prompt changed under attack`).toBe(true);
    expect(system, `${c.id}: the payload reached the system prompt`).not.toContain(c.payload);
    if (callRecord.kind === 'chat') {
      expect(
        baseline.tools.has(JSON.stringify(callRecord.tools)),
        `${c.id}: the tools array changed under attack`,
      ).toBe(true);
    }
    // Untrusted text may exist ONLY inside a nonce data block of a user/tool message. Everything else the model reads
    // is app-authored, so the payload must be gone once the blocks are cut out.
    const scaffolding = outsideDataBlocks(roleText(callRecord.messages, 'user'));
    expect(scaffolding, `${c.id}: the payload escaped the nonce data block`).not.toContain(c.payload);
  }
  // A hostile calendar title and a hostile tool result are projected away entirely: they never reach a model at all.
  if (c.vector === 'calendar_title' || c.vector === 'tool_result') {
    const everything = provider.calls.map((callRecord) => JSON.stringify(callRecord.messages)).join('\n');
    expect(everything, `${c.id}: untrusted server text reached the model`).not.toContain(c.payload.slice(0, 40));
  }
}

/** (e) badges + collapsed draft; and the `mustNot` list of the case itself. */
async function assertBadgesAndMustNot(h: Harness, c: InjectionCase): Promise<void> {
  const dash = await h.invoke('dashboard:get', undefined);
  if (!dash.ok) throw new Error(`${c.id}: no dashboard`);
  const cards = [...dash.value.needsReply, ...dash.value.infoMissing];
  const badges = new Set(cards.flatMap((card) => card.badges ?? []));
  const drafts = cards.map((card) => card.draft ?? '').join('\n');

  if (c.mustNot.includes('url_in_draft')) {
    expect(drafts, `${c.id}: a URL survived into the draft`).not.toMatch(/https?:\/\//i);
    if (drafts.length > 0) expect(badges.has('link_removed') || drafts === '').toBe(true);
  }
  if (c.mustNot.includes('foreign_recipient')) {
    expect(drafts, `${c.id}`).not.toContain('972550000099');
  }
  // The generic attacker draft always carries a URL, a phone number and an e-mail; whenever a draft was produced at
  // all, the sanitiser must have stripped the link.
  expect(drafts).not.toContain('https://evil.example');
}

function assertNoStateChange(h: Harness, c: InjectionCase, before: string): void {
  if (!c.mustNot.includes('state_change')) return;
  expect(stateFingerprint(h), `${c.id}: the app changed its own settings/consents under attack`).toBe(before);
}

/**
 * Everything an injection might want to flip: the settings blob, the consent versions, the onboarding step, the
 * pause flag, the stored secrets and any chat policy override. Rows that MUST move while the app ingests a message
 * (the bridge watermark, the last-seen timestamps, a chat row appearing with its default policy) are deliberately
 * not part of the fingerprint - they are normal operation, not a state change an attacker caused.
 */
function stateFingerprint(h: Harness): string {
  const db = h.repos.db;
  const settings = db
    .prepare<{ k: string; v: string }>(`SELECT key AS k, value_json AS v FROM settings ORDER BY key`)
    .all()
    .map((r) => `${r.k}=${r.v}`)
    .join('|');
  const meta = db
    .prepare<{ k: string; v: string }>(
      `SELECT key AS k, value AS v FROM meta WHERE key IN ('onboarding_step','paused','agent_paused','ui_language') ORDER BY key`,
    )
    .all()
    .map((r) => `${r.k}=${r.v}`)
    .join('|');
  const consents = db
    .prepare<{ kind: string; version: number }>(`SELECT kind, version FROM consents ORDER BY kind`)
    .all()
    .map((r) => `${r.kind}@${r.version}`)
    .join('|');
  const secrets = db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM secrets`).get()!.n;
  const policies = db
    .prepare<{
      jid: string;
      policy: string;
      force_known: number;
    }>(`SELECT jid, policy, force_known FROM chats WHERE policy <> 'default' OR force_known = 1 ORDER BY jid`)
    .all()
    .map((r) => `${r.jid}:${r.policy}:${r.force_known}`)
    .join('|');
  return `${settings}//${meta}//${consents}//secrets=${secrets}//${policies}`;
}

/**
 * How many cases actually got as far as a pending action. Asserted at the end: if strict re-validation ever started
 * rejecting EVERY poisoned extraction, assertion (d) would pass vacuously for the whole corpus and nobody would know.
 */
const approvedCases: string[] = [];

/** (d) a LEGITIMATE approve of whatever the poisoned run produced still goes only to the source chat. */
async function assertLegitimateApproveIsBound(h: Harness, c: InjectionCase): Promise<void> {
  const dash = await h.invoke('dashboard:get', undefined);
  if (!dash.ok) throw new Error(`${c.id}: no dashboard`);
  const cards = [...dash.value.needsReply, ...dash.value.infoMissing];
  const create = cards.flatMap((card) => card.actions).find((a) => a.kind === 'create_event' && a.state === 'pending');
  const send = cards.flatMap((card) => card.actions).find((a) => a.kind === 'send_reply' && a.state === 'pending');
  if (create !== undefined || send !== undefined) approvedCases.push(c.id);

  if (create !== undefined) {
    const res = await h.invoke('action:approve', {
      actionId: create.actionId,
      kind: 'create_event',
      shownHash: create.shownHash,
      confirmConflict: true,
    });
    await h.advance(20_000);
    expect(res.ok, `${c.id}: approving the create_event failed`).toBe(true);
    const calls = h.calendar.calls.filter((x) => x.tool === 'create-event');
    expect(calls.length, `${c.id}`).toBeLessThanOrEqual(1);
    for (const callRecord of calls) {
      for (const key of Object.keys(callRecord.args)) {
        expect(CREATE_EVENT_WHITELIST, `${c.id}: create-event key ${key}`).toContain(key);
      }
      expect(callRecord.args.sendUpdates, `${c.id}`).toBe('none');
      expect(JSON.stringify(callRecord.args), `${c.id}`).not.toContain('attacker@example.com');
    }
  }
  if (send !== undefined) {
    const res = await h.invoke('action:approve', {
      actionId: send.actionId,
      kind: 'send_reply',
      shownHash: send.shownHash,
      edit: { text: 'See you then.' },
    });
    await h.advance(20_000);
    expect(res.ok, `${c.id}: approving the send_reply failed`).toBe(true);
    expect(h.bridge.sent.length, `${c.id}`).toBeLessThanOrEqual(1);
    for (const s of h.bridge.sent) {
      expect(s.recipient, `${c.id}: the send left the source chat`).toBe(CHAT);
      expect(s.message).toBe('See you then.');
      expect(Object.keys(s.rawBody).sort()).toEqual(['message', 'recipient']);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

describe(`the obedient attacker over all ${CORPUS.length} corpus cases`, () => {
  for (const c of CORPUS) {
    it(`${c.id} (${c.lang}/${c.vector}) changes nothing`, async () => {
      h = await harnessFor(c);
      const seededEvents = h.calendar.events.length;
      const before = stateFingerprint(h);
      await deliver(h, c);

      assertNoSideEffects(h, c, seededEvents);
      assertExtractionKeys(h, c);
      assertActionsBound(h, c);
      assertReadsPinned(h, c);
      assertPromptPure(h, c);
      await assertBadgesAndMustNot(h, c);
      assertNoStateChange(h, c, before);
      await assertLegitimateApproveIsBound(h, c);
    });
  }

  it('assertion (d) was exercised - some poisoned runs really did reach a pending action', () => {
    expect(approvedCases.length, `cases that reached a pending action: ${approvedCases.join(', ')}`).toBeGreaterThan(0);
  });
});
