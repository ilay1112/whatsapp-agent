// SCRATCH - refutation attempt for review finding data-integrity-5. Touches no product file.
// Run: npx vitest run --config ops/agent-notes/verify-data-integrity-5.scratch/vitest.scratch.config.ts
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { createItemService, type ItemService } from '../../../src/main/agent/items';
import { validateAndPersist } from '../../../src/main/agent/validate';
import { resolveExtraction, closureFor } from '../../../src/main/agent/resolve';
import type { Extraction } from '../../../src/shared/schemas';
import type { Chat, EpochMs, Item } from '../../../src/shared/types';
import { ANCHOR_MS, TEST_TZ, createTestEnv, seedChat, seedOpenItem, type TestEnv } from '../../../tests/golden/testDb';

/** A 'cancel' message: needsCalendarChangeBadge() is true, so closureFor() returns NULL even though nothing is left to do. */
const CANCEL: Extraction = {
  intent: 'cancel',
  needsReply: false,
  title: 'dentist',
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
};

describe('data-integrity-5 | retriage() of an ignored-with-NULL-closed_reason item', () => {
  let env: TestEnv;
  let chat: Chat;
  let a: Item;
  let service: ItemService;
  const now: EpochMs = ANCHOR_MS;

  beforeEach(() => {
    env = createTestEnv();
    chat = seedChat(env.repos);
    a = seedOpenItem(env.repos, chat);
    service = createItemService({
      repos: env.repos,
      settings: () => env.settings,
      clock: { now: () => now, setTimeout: () => 0, clearTimeout: () => undefined },
      log: env.log,
      bridgeOnline: () => true,
      bridgeOutdated: () => false,
      calendarConnected: () => true,
      notifyChanged: () => undefined,
      enqueueRetriage: () => undefined,
    });
  });
  afterEach(() => env.dispose());

  const triageAsCancel = (target: Item): void => {
    env.repos.items.snapshotMessages(target.id, [
      {
        itemId: target.id,
        waMsgId: target.triggerMsgId,
        fromMe: false,
        ts: target.triggerTs,
        text: 'cancelled, see you',
        textSha256: 'a'.repeat(64),
      },
    ]);
    const slot = resolveExtraction(CANCEL, {
      nowMs: ANCHOR_MS,
      timeZone: TEST_TZ,
      defaultDurationMin: 60,
      ambiguousHour: 'assume',
    });
    expect(slot.state).toBe('none');
    expect(closureFor(CANCEL, slot)).toBeNull(); // <- the shape the finding depends on
    validateAndPersist(
      env.repos,
      {
        item: env.repos.items.byId(target.id)!,
        chat: { id: chat.id, sendable: chat.sendable, lang: chat.lang },
        extraction: CANCEL,
        slot,
        draftText: null,
        replyLang: 'en',
        busy: null,
        provider: 'local',
        model: 'stub-model',
        contextBadges: [],
        manipulation: false,
        now: ANCHOR_MS,
      },
      { calendarConnected: true },
    );
  };

  it('STEP 1: a real triage run leaves item A in state ignored with closed_reason NULL', () => {
    triageAsCancel(a);
    const row = env.repos.items.byId(a.id)!;
    expect(row.state).toBe('ignored');
    expect(row.closedReason).toBeNull();
    expect(row.analysis).toBe('done');
    expect(row.replyState).toBe('none');
    expect(row.eventState).toBe('none');
  });

  it('STEP 2: the chat may then open a second item B (ingest sees no open item)', () => {
    triageAsCancel(a);
    expect(env.repos.items.openForChat(chat.id)).toBeNull();
    const b = seedOpenItem(env.repos, chat, { triggerMsgId: 'wamid.SECOND', triggerTs: ANCHOR_MS + 1000 });
    expect(env.repos.items.openForChat(chat.id)!.id).toBe(b.id);
  });

  it('STEP 3: service.retriage(A) - does it return ACTION_STALE, or throw?', () => {
    triageAsCancel(a);
    seedOpenItem(env.repos, chat, { triggerMsgId: 'wamid.SECOND', triggerTs: ANCHOR_MS + 1000 });
    let thrown: unknown = null;
    let result: unknown = null;
    try {
      result = service.retriage(a.id);
    } catch (e) {
      thrown = e;
    }
    // eslint-disable-next-line no-console
    console.log('RETRIAGE OUTCOME', { thrown: thrown instanceof Error ? thrown.message : thrown, result });
    // REFUTATION FAILED: it throws instead of returning ACTION_STALE (ipc/register.ts turns the throw into INTERNAL).
    expect(result).toBeNull();
    expect((thrown as Error).message).toContain('UNIQUE constraint failed: items.chat_id');
    // and the transaction rolled back: A is untouched, B still owns the open slot.
    expect(env.repos.items.byId(a.id)!.state).toBe('ignored');
    expect(env.repos.queue.size()).toBe(0);
  });

  it('STEP 3b: restore(A) for comparison', () => {
    triageAsCancel(a);
    seedOpenItem(env.repos, chat, { triggerMsgId: 'wamid.SECOND', triggerTs: ANCHOR_MS + 1000 });
    let thrown: unknown = null;
    let result: unknown = null;
    try {
      result = service.restore(a.id);
    } catch (e) {
      thrown = e;
    }
    // eslint-disable-next-line no-console
    console.log('RESTORE OUTCOME', { thrown: thrown instanceof Error ? thrown.message : thrown, ok: (result as { ok: boolean } | null)?.ok });
    expect(thrown).toBeNull();
  });

  it('STEP 4: control - retriage(A) with no second item succeeds', () => {
    triageAsCancel(a);
    const r = service.retriage(a.id);
    expect(r.ok).toBe(true);
    expect(env.repos.items.byId(a.id)!.state).toBe('needs_reply');
  });
});
