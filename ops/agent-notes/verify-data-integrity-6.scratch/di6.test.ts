// SCRATCH - verification of review finding data-integrity-6. NOT part of the product suite; no product file is touched.
// Run: npx vitest run --config ops/agent-notes/verify-data-integrity-6.scratch/vitest.scratch.config.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateAndPersist, type ValidateInput } from '../../../src/main/agent/validate';
import { resolveExtraction } from '../../../src/main/agent/resolve';
import { applySendSuccess } from '../../../src/main/exec/outcome';
import type { Extraction } from '../../../src/shared/schemas';
import type { Chat, Item } from '../../../src/shared/types';
import { ANCHOR_MS, TEST_TZ, createTestEnv, seedChat, seedOpenItem, type TestEnv } from '../../../tests/golden/testDb';

const EXTRACTION: Extraction = {
  intent: 'schedule_request',
  needsReply: true,
  title: 'coffee',
  dateKind: 'relative_days',
  isoDate: '',
  weekday: 0,
  weekOffset: 0,
  daysFromToday: 1,
  time24h: '17:00',
  timeAmbiguous: false,
  durationMin: 60,
  location: '',
  missing: [],
  suspicious: false,
};

describe('data-integrity-6 | torn success: markDone lands, applySendSuccess does not', () => {
  let env: TestEnv;
  let chat: Chat;
  let item: Item;

  const inputFor = (over: Partial<ValidateInput> = {}): ValidateInput => ({
    item,
    chat: { id: chat.id, sendable: chat.sendable, lang: chat.lang },
    extraction: EXTRACTION,
    slot: resolveExtraction(EXTRACTION, {
      nowMs: ANCHOR_MS,
      timeZone: TEST_TZ,
      defaultDurationMin: 60,
      ambiguousHour: 'assume',
    }),
    draftText: 'Thursday at 17:00 works for me',
    replyLang: 'en',
    busy: null,
    provider: 'local',
    model: 'test-model',
    contextBadges: [],
    manipulation: false,
    now: ANCHOR_MS,
    ...over,
  });

  beforeEach(() => {
    env = createTestEnv();
    chat = seedChat(env.repos);
    item = seedOpenItem(env.repos, chat);
  });
  afterEach(() => env.dispose());

  /** First triage -> pending send_reply; approve it; run the side effect's FIRST write only. */
  function tornSend(): void {
    const out = validateAndPersist(env.repos, inputFor());
    expect(out.actionsCreated).toEqual(['send_reply']);
    const a = env.repos.actions.forItem(item.id).find((x) => x.kind === 'send_reply')!;
    expect(env.repos.actions.markApprovedExecuting(a.id, a.canonicalJson!, ANCHOR_MS)).toBe('ok');
    // actionExecutor.ts:273 - committed on its own, no surrounding transaction
    env.repos.actions.markDone(a.id, { kind: 'send_reply', waMsgId: null }, ANCHOR_MS);
    // actionExecutor.ts:274 applySendSuccess + :275 the action_done audit never run (process killed / throw)
  }

  it('leaves NOTHING for either recovery pass and the item still reads reply_state=draft', () => {
    tornSend();
    expect(env.repos.actions.executing()).toHaveLength(0); // recoverOnStartup() scans this set
    const unknown = env.repos.db
      .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM actions WHERE state = 'unknown_outcome'`)
      .get()!.n;
    expect(unknown).toBe(0); // reconcileUnknown() / offerRetryForUnknown() scan this set
    const done = env.repos.db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM actions WHERE state = 'done'`).get()!.n;
    expect(done).toBe(1);
    const fresh = env.repos.items.byId(item.id)!;
    expect(fresh.replyState).toBe('draft');
    expect(fresh.closedReason).toBeNull();
    // no audit row records the completed send either
    const audit = env.repos.db
      .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE kind = 'action_done'`)
      .get()!.n;
    expect(audit).toBe(0);
  });

  it('the next triage drafts again and offers a SECOND approvable send_reply', () => {
    tornSend();
    const again = validateAndPersist(env.repos, inputFor({ item: env.repos.items.byId(item.id)! }));
    expect(again.actionsCreated).toEqual(['send_reply']); // <- a fresh pending action the user can approve
    const pending = env.repos.actions.forItem(item.id).filter((a) => a.state === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.kind).toBe('send_reply');
  });

  it('CONTROL: when applySendSuccess does land, the next triage offers nothing', () => {
    const out = validateAndPersist(env.repos, inputFor());
    expect(out.actionsCreated).toEqual(['send_reply']);
    const a = env.repos.actions.forItem(item.id).find((x) => x.kind === 'send_reply')!;
    expect(env.repos.actions.markApprovedExecuting(a.id, a.canonicalJson!, ANCHOR_MS)).toBe('ok');
    env.repos.actions.markDone(a.id, { kind: 'send_reply', waMsgId: null }, ANCHOR_MS);
    applySendSuccess(
      env.repos,
      env.repos.actions.byId(a.id)!,
      { v: 1, kind: 'send_reply', itemId: item.id, chatRef: chat.id, proposalVersion: 1, text: 'ok' },
      ANCHOR_MS,
    );
    const fresh = env.repos.items.byId(item.id)!;
    expect(fresh.replyState).toBe('sent');
    const again = validateAndPersist(env.repos, inputFor({ item: fresh }));
    expect(again.actionsCreated).toEqual([]); // sticky 'sent' blocks the re-draft
  });
});
