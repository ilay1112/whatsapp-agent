// tests/integration/auto-picture-gate.test.ts - [v2-closeout] auto-mode-5, confirmed through the REAL S4 output.
// The defect: S4 writes the info badge `from_image` on EVERY picture whose text was used, and AutoGate's zero-badges rule counted it, so a
// picture-derived create fell back with `badge_info` and D-068 ("picture-derived events MAY be automatic once imagesPassed") could
// never open. v2-fix-src-main-exec exempted `from_image` on a picture item - proven then only on a hand-built item. Here the item, its
// badges, trigger kind and the proposal's picture facts come from a real orchestrator run (S1 -> S4 over the real repos with the V1
// outcome injected at its seam); only the parts of the gate input that have nothing to do with the picture (policy, chat, cage, budget,
// payload slot) come from the all-clear fixture.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOrchestrator, type AutoOutcome } from '../../src/main/agent/orchestrator';
import type { ProviderFeatureGates } from '../../src/main/agent/gates';
import type { ReadImageOutcome } from '../../src/main/agent/readImage';
import type { NormalizedImage } from '../../src/main/media/normalizeImage';
import type { ProviderFactory } from '../../src/main/llm/types';
import { evaluateAutoGate as autoGate, type AutoGateInput } from '../../src/main/exec/autoGate';
import { allClearCreate } from '../../src/main/exec/autoGate.fixtures';
import type { Extraction, ImageRead } from '../../src/shared/schemas';
import type { ChatRef, Item, Message, Proposal } from '../../src/shared/types';
import { StubLlm } from '../fakes/stub-llm';
import { createSeededRandom, createVirtualClock, type VirtualClock } from '../helpers/virtualClock';
import { ANCHOR_MS, createIngestDouble, createTestEnv, seedChat, type TestEnv } from '../golden/testDb';

const JID = '972550000001@s.whatsapp.net';
const READ: ImageRead = {
  readable: true,
  kind: 'flyer',
  readText: 'Jazz night\nThursday 24.9\n20:00',
  language: 'en',
  title: 'Jazz night',
  dateText: 'Thursday 24.9',
  day: 24,
  month: 9,
  year: 0,
  weekday: 4,
  timeText: '20:00',
  hour: 20,
  minute: 0,
  timeAmbiguous: false,
  endHour: 22,
  endMinute: 0,
  location: '',
  confidence: 'high',
  suspicious: false,
};
const S1: Extraction = {
  intent: 'schedule_request',
  needsReply: true,
  title: 'Jazz night',
  dateKind: 'none',
  isoDate: '',
  weekday: 0,
  weekOffset: 0,
  daysFromToday: 0,
  time24h: '',
  timeAmbiguous: false,
  durationMin: 0,
  location: '',
  missing: [],
  suspicious: false,
  refersToExisting: false,
  change: 'no_change',
  changeConfidence: 'high',
  confidence: 'high',
};
const IMAGE: NormalizedImage = {
  jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  width: 10,
  height: 10,
  sha256: 'a'.repeat(64),
  thumbDataUrl: 'data:image/jpeg;base64,AA==',
  sourceMime: 'image/png',
};

let env: TestEnv;
let clock: VirtualClock;
let chatId: ChatRef;
beforeEach(() => {
  env = createTestEnv({ calendarConnected: true });
  clock = createVirtualClock(ANCHOR_MS);
  chatId = seedChat(env.repos, { jid: JID }).id;
});
afterEach(() => env.dispose());

function msg(i: number, over: Partial<Message> & { text: string }): Message {
  return {
    rowid: i,
    waMsgId: `wamid.P${i}`,
    chatJid: JID,
    senderUser: over.fromMe === true ? 'me' : '972550000001',
    ts: ANCHOR_MS - (10 - i) * 60_000,
    fromMe: false,
    mediaType: '',
    deleted: false,
    ...over,
  };
}

/** One real orchestrator run over a picture whose V1 read is `READ`; S4 judges the picture with `imagesPassed`. */
async function runPicture(imagesPassed: boolean): Promise<{ item: Item; proposal: Proposal }> {
  const window = [msg(1, { text: 'see you there?', fromMe: true }), msg(2, { text: 'join us?', mediaType: 'image' })];
  const opened = env.repos.items.createOpen({
    chatId,
    triggerMsgId: window[1]!.waMsgId,
    triggerTs: window[1]!.ts!,
    analysis: 'queued',
    holdReason: null,
    now: window[1]!.ts!,
  });
  const llm = new StubLlm({
    id: 'local',
    clock,
    rules: [
      { when: { purpose: 'extract' }, respond: { structured: S1 } },
      { when: { purpose: 'draft' }, respond: { text: 'sounds good' } },
    ],
  });
  const providers: ProviderFactory = {
    get: () => Promise.resolve(llm),
    usable: () => ({ ok: true }),
    invalidate: () => Promise.resolve(),
  };
  const gates = (): ProviderFeatureGates => ({ editsPassed: false, imagesPassed, voicePassed: false });
  const orchestrator = createOrchestrator({
    repos: env.repos,
    providers,
    gate: env.gate,
    ingest: createIngestDouble(window),
    settings: () => env.settings,
    clock,
    random: createSeededRandom(),
    log: env.log,
    notifyChanged: () => undefined,
    updateSurfaceAvailable: () => true,
    tryAuto: (): Promise<AutoOutcome> => Promise.resolve({ verdict: 'none', reason: 'no_policy' }),
    existingEvent: () => null,
    featureGates: gates,
    pickImage: () => Promise.resolve(IMAGE),
    readImage: (): Promise<ReadImageOutcome> => Promise.resolve({ ok: true, read: READ, route: 'local', runId: 1 }),
  });
  await orchestrator.runChat(chatId, new AbortController().signal);
  return { item: env.repos.items.byId(opened.id)!, proposal: env.repos.proposals.current(opened.id)! };
}

/** The all-clear create input with every PICTURE fact replaced by what the real run persisted. */
function gateInputOf(real: { item: Item; proposal: Proposal }, imagesPassed: boolean): AutoGateInput {
  const base = allClearCreate();
  return {
    ...base,
    item: { ...base.item, badges: real.item.badges, triggerKind: real.item.triggerKind, missing: real.item.missing },
    proposal: {
      ...base.proposal,
      imageRead: real.proposal.imageRead,
      suspicious: real.proposal.suspicious,
      blockedCalls: real.proposal.blockedCalls,
      crossChatRows: real.proposal.crossChatRows,
      extraction: real.proposal.extraction,
      event:
        base.proposal.event === null
          ? null
          : { ...base.proposal.event, assumptions: real.proposal.event?.assumptions ?? [] },
    },
    mediaGates: { voicePassed: false, imagesPassed },
  };
}

describe('[v2-closeout] auto-mode-5 through the real S4 output', () => {
  it('images gate passed: S4 writes only the info badge from_image, and AutoGate lets the picture through (no badge_info)', async () => {
    const real = await runPicture(true);
    expect(real.item.triggerKind).toBe('image');
    expect(real.item.badges).toEqual(['from_image']);
    expect(real.proposal.imageRead).toEqual(READ);
    const out = autoGate(gateInputOf(real, true));
    expect(out).toMatchObject({ verdict: 'auto', reason: 'ok' });
  });

  it('the same picture with the images gate closed in AutoGate falls back with media_derived (never badge_info)', async () => {
    const real = await runPicture(true);
    const out = autoGate(gateInputOf(real, false));
    expect(out).toMatchObject({ verdict: 'fallback', reason: 'media_derived' });
  });

  it('this build (FEATURE_GATES all false): S4 adds the amber image_unclear, so a picture is never automatic', async () => {
    const real = await runPicture(false);
    expect(real.item.badges).toEqual(expect.arrayContaining(['from_image', 'image_unclear']));
    const out = autoGate(gateInputOf(real, false));
    expect(out.verdict).toBe('fallback');
    expect(out.reason).toBe('badge_amber');
    expect(String(out.checks.fails)).toContain('media_derived');
    expect(String(out.checks.fails)).not.toContain('badge_info');
  });
});
