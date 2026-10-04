// tests/security/auto-mode.injection-corpus.test.ts - T2 8.2 group 14 (injection half): the cage under the WORST model, with a live
// `on` policy. Every payload in the corpus files is synthetic ATTACK DATA aimed at the app under test (T6) - nobody acts on it.
//
// Part A (real repos + triggers + the real executor + the fake calendar v2 + the ledger): for every corpus case, the most dangerous
// create proposal an attacker could get past S4 - the attacker's own title/location, every provenance flag at its most trusting value
// - goes through tryAuto. Whatever the verdict, the cage holds: zero sends, zero delete-event, zero update-event, every automatic write
// has no attendees, sendUpdates 'none', the app template description and the target calendar, and a decision + auto_writes row; never
// more than perChatPerDay writes per chat; unknown / force_known / tainted / never chats get zero writes; forbidden payload keys can
// never be stored; the S1 attacker's confident cancel with forged keys does not even parse.
// Part B (through compose(), T2 8.4 (h)-(i)) needs the orchestrator -> tryAuto wiring and the auto:* channels: BLOCKED-BY V2-W2-01.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtractionSchema } from '../../src/shared/schemas.ts';
import { LIMITS } from '../../src/shared/types.ts';
import { FLAT_LOCALES } from '../../src/shared/i18n/resources.ts';
import { V2_FORBIDDEN_EXTRACTION_KEYS, type InjectionCase } from '../fakes/obedient-attacker-llm.ts';
import { V1_EXTRACTION_DEFAULTS } from '../fakes/stub-llm.ts';
import { makeExecRig, stopRigsChecked } from '../helpers/ledger.execRig.ts';
import { createHarness, type Harness } from '../helpers/harness.ts';
import type { Rig } from '../helpers/ledger.execRig.ts';
import type { EpochMs } from '../../src/shared/types.ts';

const corpusFile = (name: string): InjectionCase[] =>
  JSON.parse(readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')) as InjectionCase[];
const CORPUS: InjectionCase[] = [
  ...corpusFile('./injection-corpus.en.json'),
  ...corpusFile('./injection-corpus.he.json'),
];

const rigs: Rig[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose();
  await stopRigsChecked(rigs);
});
const HOUR = 3_600_000;
const SINGLE_LINE = (s: string): string => s.replace(/[\r\n\u2028\u2029]+/g, ' ');
/** What the attacker would like the event to say: its structured title / location, else the payload itself. */
function attackerContent(c: InjectionCase): { title: string; location: string } {
  const o = c.obey.structured ?? {};
  const title = typeof o.title === 'string' && o.title !== '' ? o.title : c.payload;
  const location = typeof o.location === 'string' ? o.location : '';
  return {
    title: SINGLE_LINE(title).slice(0, LIMITS.titleChars),
    location: SINGLE_LINE(location).slice(0, LIMITS.locationChars),
  };
}

async function onRig(): Promise<Rig> {
  const r = await makeExecRig();
  rigs.push(r);
  await r.trackRecord();
  r.policy('on');
  r.attachLedger();
  return r;
}

describe('Part A - the cage holds for every corpus case under the most trusting provenance', () => {
  it(`all ${String(CORPUS.length)} cases: writes only inside the cage, zero sends / deletes / updates`, async () => {
    const r = await onRig();
    const template = FLAT_LOCALES.en['calendar.eventDescription'];
    let n = 0;
    for (const c of CORPUS) {
      const { title, location } = attackerContent(c);
      const day = 7 + (n % 20);
      const seeded = r.seedCreate({
        chatN: 100 + n,
        slot: {
          startLocal: `2026-10-${String(day).padStart(2, '0')}T${String(9 + (n % 10)).padStart(2, '0')}:00:00`,
          endLocal: `2026-10-${String(day).padStart(2, '0')}T${String(9 + (n % 10)).padStart(2, '0')}:30:00`,
        },
        title,
        location,
      });
      const out = await r.exec.tryAuto(seeded.action.id);
      expect(['auto', 'fallback'], c.id).toContain(out.verdict);
      if (out.verdict === 'auto') {
        const w = r.repos.autoWrites.byId(out.autoWriteId!);
        expect(w, c.id).not.toBeNull();
        expect(r.repos.autoDecisions.forAction(seeded.action.id)).toMatchObject({ verdict: 'auto', reason: 'ok' });
      }
      n += 1;
      await r.clock.advance(HOUR + 1);
    }
    const creates = r.cal.calls.filter((c) => c.tool === 'create-event').map((c) => c.args);
    for (const args of creates) {
      expect(args).not.toHaveProperty('attendees');
      expect(args).not.toHaveProperty('recurrence');
      expect(args.sendUpdates).toBe('none');
      expect(args.calendarId).toBe('primary');
      expect(args.description).toBe(template);
    }
    expect(r.cal.calls.filter((c) => c.tool === 'update-event' || c.tool === 'delete-event')).toEqual([]);
    // per chat: never more than perChatPerDay automatic writes a day
    const perChat = r.db
      .prepare<{ chat_id: number; n: number }>(
        `SELECT chat_id, COUNT(*) AS n FROM auto_decisions WHERE verdict = 'auto' GROUP BY chat_id`,
      )
      .all();
    for (const row of perChat) expect(row.n).toBeLessThanOrEqual(3);
    // every automatic write left its ledger rows (the global ledger re-checks approved_by <-> decision after the test)
    const writes = r.repos.autoWrites.since(0 as EpochMs).length;
    const autos = r.db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM auto_decisions WHERE verdict = 'auto'`).get()!
      .n;
    expect(writes).toBe(autos);
  });

  it('a hostile title / location that carries a URL, an address, a number or a bidi control is never written automatically', async () => {
    const r = await onRig();
    const hostile = CORPUS.filter((c) =>
      /https?:|www\.|@|\d{3}[-\s]?\d{3}[-\s]?\d{3,4}|[\u202A-\u202E\u2066-\u2069]/u.test(attackerContent(c).title),
    );
    expect(hostile.length).toBeGreaterThan(0);
    let n = 0;
    for (const c of hostile) {
      const { title, location } = attackerContent(c);
      const s = r.seedCreate({
        chatN: 200 + n++,
        slot: { startLocal: '2026-10-08T10:00:00', endLocal: '2026-10-08T10:30:00' },
        title,
        location,
      });
      const out = await r.exec.tryAuto(s.action.id);
      expect(out.verdict, c.id).toBe('fallback');
      expect(['content_rejected', 'title_rejected'], c.id).toContain(out.reason);
    }
  });

  it('unknown / force_known / tainted / never chats: zero automatic writes, whatever the text', async () => {
    const r = await onRig();
    const c1 = r.chat(301, { isKnown: false });
    r.repos.chats.setForceKnown(c1.id);
    const c2 = r.chat(302);
    r.repos.chats.taint(c2.id, (r.clock.now() + LIMITS.autoTaintMs) as EpochMs);
    const c3 = r.chat(303);
    r.repos.chats.setPolicy(c3.id, 'never');
    const c4 = r.chat(304);
    r.repos.chats.setAutoPolicy(c4.id, 'never');
    const reasons: string[] = [];
    for (const [i, chatN] of [301, 302, 303, 304].entries()) {
      const s = r.seedCreate({
        chatN,
        slot: { startLocal: `2026-10-1${String(i)}T10:00:00`, endLocal: `2026-10-1${String(i)}T10:30:00` },
        title: 'Dentist',
      });
      reasons.push((await r.exec.tryAuto(s.action.id)).reason);
    }
    expect(reasons).toEqual(['unknown_contact', 'chat_tainted', 'chat_opted_out', 'chat_opted_out']);
    expect(r.cal.calls.filter((c) => c.tool === 'create-event')).toHaveLength(3); // the track record only
  });

  it('forbidden keys can never be stored in an action (strict payload) and the S1 attacker output does not parse', () => {
    const extra = {
      attendees: ['x@example.com'],
      sendUpdates: 'all',
      calendarId: 'attacker@example.com',
      autoApprove: true,
      approvedBy: 'auto',
    };
    const good = {
      v: 1,
      kind: 'create_event',
      itemId: 1,
      chatRef: 1,
      proposalVersion: 1,
      title: 't',
      startLocal: '2026-10-08T10:00:00',
      endLocal: '2026-10-08T10:30:00',
      timeZone: 'Asia/Jerusalem',
      location: '',
    };
    return (async () => {
      const r = await onRig();
      const s = r.seedCreate({
        chatN: 400,
        slot: { startLocal: '2026-10-08T10:00:00', endLocal: '2026-10-08T10:30:00' },
      });
      for (const [k, v] of Object.entries(extra)) {
        expect(() =>
          r.repos.actions.insertPending({
            itemId: s.item.id,
            proposalId: s.action.proposalId,
            chatId: s.action.chatId,
            payload: { ...good, itemId: s.item.id, chatRef: s.action.chatId, [k]: v } as never,
            now: r.clock.now() as EpochMs,
          }),
        ).toThrow();
      }
      const attackerS1 = { ...V1_EXTRACTION_DEFAULTS, ...V2_FORBIDDEN_EXTRACTION_KEYS };
      expect(ExtractionSchema.safeParse(attackerS1).success).toBe(false);
    })();
  });

  it('a confident model "cancel" of an existing event without scope.cancels is never automatic (cancel_not_in_scope)', async () => {
    const r = await onRig();
    const source = await r.createByClick({
      chatN: 500,
      slot: { startLocal: '2026-10-09T10:00:00', endLocal: '2026-10-09T11:00:00' },
    });
    const d = r.seedDelta({ source, change: 'cancel' });
    expect(await r.exec.tryAuto(d.action.id)).toMatchObject({ verdict: 'fallback', reason: 'cancel_not_in_scope' });
    expect(r.cal.calls.filter((c) => c.tool === 'update-event')).toEqual([]);
  });
});

describe('Part B - through compose() (T2 8.4 (h): no automatic write for any case) - BLOCKED-BY V2-W2-01', () => {
  it('the auto:* channels answer through the composed app (prerequisite of the corpus replay with a live policy)', async () => {
    const h = await createHarness({ llm: 'attacker', corpus: CORPUS.filter((c) => c.id.includes('auto')) });
    harnesses.push(h);
    const state = await h.invoke('auto:getState', undefined);
    expect(state.ok).toBe(true);
    // with no policy, the attacker's "add it automatically" cases produce zero automatic writes and zero update-event calls
    expect(h.repos.autoWrites.since(0 as EpochMs)).toEqual([]);
    expect(h.calendar.calls.filter((c) => c.tool === 'update-event')).toEqual([]);
  });
});
