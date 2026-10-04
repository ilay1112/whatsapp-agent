// TESTS 5.3 row `db/*` + ARCHITECTURE 4.6 step 4: chat upsert from the bridge (is_known is monotonic, sendable = phone JID) and
// the [R2] @lid -> phone-JID merge.
import { afterEach, describe, expect, it } from 'vitest';
import { RowNotFoundError } from '../index';
import {
  cleanup,
  JID_A,
  JID_B,
  LID_JID,
  memRepos,
  seedChat,
  seedOpenItem,
  seedPendingAction,
  seedProposal,
  T0,
} from '../__fixtures__/testDb';

afterEach(cleanup);

describe('chats repo - upsert / touch / policy', () => {
  it('inserts with sendable derived from the JID shape and never unsets is_known', () => {
    const { repos } = memRepos();
    const phone = repos.chats.upsertFromBridge(JID_A, 'Name', true, T0);
    expect(phone).toMatchObject({
      jid: JID_A,
      displayName: 'Name',
      isKnown: true,
      forceKnown: false,
      sendable: true,
      policy: 'default',
    });
    const lid = repos.chats.upsertFromBridge(LID_JID, null, false, T0);
    expect(lid).toMatchObject({ sendable: false, isKnown: false, displayName: null });
    // a later scan that does not see an own message must not make the chat unknown again, and a null name keeps the old one
    const again = repos.chats.upsertFromBridge(JID_A, null, false, T0 + 1);
    expect(again).toMatchObject({ isKnown: true, displayName: 'Name', updatedAt: T0 + 1 });
    expect(repos.chats.byJid(JID_A)!.id).toBe(phone.id);
    expect(repos.chats.byJid('nope@s.whatsapp.net')).toBeNull();
    expect(repos.chats.byId(phone.id + 999)).toBeNull();
  });

  it('touch() writes only the supplied fields and never moves updated_at backwards', () => {
    const { repos } = memRepos();
    const chat = repos.chats.upsertFromBridge(JID_A, null, false, T0);
    repos.chats.touch(chat.id, {});
    expect(repos.chats.byId(chat.id)!.updatedAt).toBe(T0);
    repos.chats.touch(chat.id, { lastInboundTs: T0 + 10, lang: 'he', lastTriagedMsgId: 'm7' });
    expect(repos.chats.byId(chat.id)).toMatchObject({
      lastInboundTs: T0 + 10,
      lang: 'he',
      lastTriagedMsgId: 'm7',
      updatedAt: T0 + 10,
    });
    repos.chats.touch(chat.id, { lastOutboundTs: T0 - 5 });
    expect(repos.chats.byId(chat.id)).toMatchObject({ lastOutboundTs: T0 - 5, updatedAt: T0 + 10 });
  });

  it('setPolicy / setForceKnown / withPolicies', () => {
    const { repos } = memRepos();
    const a = repos.chats.upsertFromBridge(JID_A, null, false, T0);
    const b = repos.chats.upsertFromBridge(JID_B, null, false, T0);
    expect(repos.chats.withPolicies()).toEqual([]);
    expect(repos.chats.setPolicy(a.id, 'never').policy).toBe('never');
    expect(repos.chats.setForceKnown(b.id).forceKnown).toBe(true);
    expect(repos.chats.withPolicies().map((c) => c.id)).toEqual([a.id, b.id]);
    expect(() => repos.chats.setPolicy(a.id + 999, 'never')).toThrow(RowNotFoundError);
    expect(() => repos.chats.setForceKnown(a.id + 999)).toThrow(RowNotFoundError);
  });
});

describe('chats repo - [R2] mergeLidInto', () => {
  it('re-keys the @lid row when no phone-JID row exists yet', () => {
    const { repos } = memRepos();
    const lid = repos.chats.upsertFromBridge(LID_JID, 'Who', true, T0);
    const merged = repos.chats.mergeLidInto(lid.id, JID_A, T0 + 1);
    expect(merged).toMatchObject({ id: lid.id, jid: JID_A, sendable: true, isKnown: true, updatedAt: T0 + 1 });
    expect(repos.chats.byJid(LID_JID)).toBeNull();
  });

  it('moves the items into the surviving phone-JID row, ORs is_known and deletes the @lid row', () => {
    const { repos } = memRepos();
    const phone = repos.chats.upsertFromBridge(JID_A, 'Phone', false, T0);
    const lid = repos.chats.upsertFromBridge(LID_JID, 'Lid', true, T0);
    repos.chats.setForceKnown(lid.id);
    const lidItem = seedOpenItem(repos, lid.id, T0, 'm-lid');
    repos.items.update(lidItem.id, { analysis: 'done', eventState: 'created' }, T0);
    repos.queue.enqueue(lid.id, T0);
    const survivor = repos.chats.mergeLidInto(lid.id, JID_A, T0 + 5);
    expect(survivor).toMatchObject({ id: phone.id, jid: JID_A, isKnown: true, forceKnown: true, displayName: 'Phone' });
    expect(repos.chats.byId(lid.id)).toBeNull();
    expect(repos.items.byId(lidItem.id)!.chatId).toBe(phone.id);
    expect(repos.queue.size()).toBe(0);
  });

  it('keeps the newer open item and supersedes the other (ux_items_open allows one)', () => {
    const { repos } = memRepos();
    const phone = repos.chats.upsertFromBridge(JID_A, null, true, T0);
    const lid = repos.chats.upsertFromBridge(LID_JID, null, true, T0);
    const older = seedOpenItem(repos, phone.id, T0, 'm-old');
    const newer = seedOpenItem(repos, lid.id, T0 + 100, 'm-new');
    repos.chats.mergeLidInto(lid.id, JID_A, T0 + 200);
    expect(repos.items.byId(older.id)).toMatchObject({ state: 'ignored', closedReason: 'superseded' });
    expect(repos.items.byId(newer.id)).toMatchObject({ state: 'needs_reply', chatId: phone.id });
    expect(repos.items.openForChat(phone.id)!.id).toBe(newer.id);
  });

  it('supersedes the older @lid item when the phone-JID chat carries the newer one', () => {
    const { repos } = memRepos();
    const phone = repos.chats.upsertFromBridge(JID_A, null, true, T0);
    const lid = repos.chats.upsertFromBridge(LID_JID, null, true, T0);
    const newer = seedOpenItem(repos, phone.id, T0 + 100, 'm-new');
    const older = seedOpenItem(repos, lid.id, T0, 'm-old');
    repos.chats.mergeLidInto(lid.id, JID_A, T0 + 200);
    expect(repos.items.byId(older.id)).toMatchObject({
      state: 'ignored',
      closedReason: 'superseded',
      chatId: phone.id,
    });
    expect(repos.items.openForChat(phone.id)!.id).toBe(newer.id);
  });

  it("drops the @lid chat's own action rows (safety I3: chat_id is frozen, an approval never changes recipient)", () => {
    const { repos } = memRepos();
    // seedPendingAction uses JID_A; build the @lid side by hand so both chats exist
    const { action } = seedPendingAction(repos);
    const lid = repos.chats.upsertFromBridge(LID_JID, null, true, T0);
    const lidItem = seedOpenItem(repos, lid.id, T0, 'm-lid');
    const lidProposal = seedProposal(repos, lidItem.id, T0);
    const lidAction = repos.actions.insertPending({
      itemId: lidItem.id,
      proposalId: lidProposal.id,
      chatId: lid.id,
      payload: {
        v: 1,
        kind: 'send_reply',
        itemId: lidItem.id,
        chatRef: lid.id,
        proposalVersion: lidProposal.version,
        text: 'x',
      },
      now: T0,
    });
    repos.chats.mergeLidInto(lid.id, JID_A, T0 + 1);
    expect(repos.actions.byId(lidAction.id)).toBeNull();
    expect(repos.actions.byId(action.id)!.state).toBe('pending');
    expect(repos.items.byId(lidItem.id)!.chatId).toBe(seedChat(repos, JID_A).id);
  });

  // [W1-04] The @lid chat's action rows cannot follow their item (trg_actions_frozen) and cannot stay behind (chat_id FK), so the merge
  // destroys them. A row past approval is a side effect in flight: the merge waits for it instead of dropping the idempotency key.
  const seedLidCreateEvent = (repos: ReturnType<typeof memRepos>['repos']) => {
    const lid = repos.chats.upsertFromBridge(LID_JID, null, true, T0);
    const item = seedOpenItem(repos, lid.id, T0, 'm-lid');
    const proposal = seedProposal(repos, item.id, T0);
    const action = repos.actions.insertPending({
      itemId: item.id,
      proposalId: proposal.id,
      chatId: lid.id,
      payload: {
        v: 1,
        kind: 'create_event',
        itemId: item.id,
        chatRef: lid.id,
        proposalVersion: proposal.version,
        title: 'T',
        startLocal: '2026-03-01T10:00:00',
        endLocal: '2026-03-01T11:00:00',
        timeZone: 'Asia/Jerusalem',
        location: '',
      },
      now: T0,
    });
    return { lid, item, action };
  };

  it('defers the merge while an action of the @lid chat is executing (never drops an in-flight approval)', () => {
    const { repos } = memRepos();
    const phone = repos.chats.upsertFromBridge(JID_A, 'Phone', false, T0);
    const { lid, item, action } = seedLidCreateEvent(repos);
    expect(repos.actions.markApprovedExecuting(action.id, '{"v":1}', T0 + 1, 'user')).toBe('ok');

    const returned = repos.chats.mergeLidInto(lid.id, JID_A, T0 + 2);
    expect(returned).toMatchObject({ id: lid.id, jid: LID_JID });
    expect(repos.chats.byId(lid.id)).not.toBeNull();
    expect(repos.actions.byId(action.id)!.state).toBe('executing');
    expect(repos.items.byId(item.id)!.chatId).toBe(lid.id);

    // once the executor settles the row the next ONLINE transition merges normally
    repos.actions.markDone(action.id, { kind: 'create_event', eventId: 'e1', htmlLink: null }, T0 + 3);
    expect(repos.chats.mergeLidInto(lid.id, JID_A, T0 + 4).id).toBe(phone.id);
    expect(repos.chats.byId(lid.id)).toBeNull();
    expect(repos.actions.byId(action.id)).toBeNull();
    expect(repos.items.byId(item.id)!.chatId).toBe(phone.id);
  });

  it('still merges when the @lid chat only holds settled action rows (audit_log keeps the evidence)', () => {
    const { repos } = memRepos();
    const phone = repos.chats.upsertFromBridge(JID_A, null, false, T0);
    const { lid, item, action } = seedLidCreateEvent(repos);
    repos.actions.markRejected(action.id);
    expect(repos.actions.byId(action.id)!.state).toBe('rejected');
    expect(repos.chats.mergeLidInto(lid.id, JID_A, T0 + 1).id).toBe(phone.id);
    expect(repos.actions.byId(action.id)).toBeNull();
    expect(repos.items.byId(item.id)!.chatId).toBe(phone.id);
  });

  it('refuses an unknown chat and tolerates a no-op merge onto its own JID', () => {
    const { repos } = memRepos();
    const lid = repos.chats.upsertFromBridge(LID_JID, null, false, T0);
    expect(() => repos.chats.mergeLidInto(lid.id + 999, JID_A, T0)).toThrow(RowNotFoundError);
    expect(repos.chats.mergeLidInto(lid.id, LID_JID, T0 + 1).jid).toBe(LID_JID);
  });

  /**
   * Regression, data-integrity-2: a failed `create_event` on the @lid chat leaves a `failed` parent + a `pending` clone whose
   * `retry_of` points at it. `DELETE FROM actions WHERE chat_id = ?` scans in rowid order, so the parent goes first and the FK's
   * implicit `SET NULL` on the clone used to trip `trg_actions_frozen`. Inside ingest that abort rolled the WHOLE scan batch back,
   * watermark included, so the same bridge rows were re-read and re-failed forever: ingest stalled silently for every chat.
   */
  it('merges a @lid chat whose actions form a retry chain (the FK SET NULL must not trip the frozen trigger)', () => {
    const { repos } = memRepos();
    const phone = repos.chats.upsertFromBridge(JID_A, null, true, T0);
    const { lid, item, action } = seedLidCreateEvent(repos);
    expect(repos.actions.markApprovedExecuting(action.id, '{"v":1}', T0 + 1, 'user')).toBe('ok');
    repos.actions.markFailed(action.id, 'CAL_UNAVAILABLE', T0 + 2);
    const clone = repos.actions.insertPending({
      itemId: item.id,
      proposalId: repos.proposals.current(item.id)!.id,
      chatId: lid.id,
      payload: {
        v: 1,
        kind: 'create_event',
        itemId: item.id,
        chatRef: lid.id,
        proposalVersion: repos.proposals.current(item.id)!.version,
        title: 'T',
        startLocal: '2026-03-01T10:00:00',
        endLocal: '2026-03-01T11:00:00',
        timeZone: 'Asia/Jerusalem',
        location: '',
      },
      now: T0 + 3,
      retryOf: action.id,
    });
    // `failed` + `pending` walks past the approved/executing deferral guard, so the destructive branch really is reached
    expect(repos.chats.mergeLidInto(lid.id, JID_A, T0 + 4).id).toBe(phone.id);
    expect(repos.chats.byId(lid.id)).toBeNull();
    expect(repos.actions.byId(action.id)).toBeNull();
    expect(repos.actions.byId(clone.id)).toBeNull();
    expect(repos.items.byId(item.id)!.chatId).toBe(phone.id);
  });

  /**
   * Regression, data-integrity-3: the @lid chat's items are re-parented but its triage_queue row was simply deleted, so an item
   * that was still `analysis='queued'` when the bridge came ONLINE was never analysed - counted in counts().analysing, listed
   * nowhere (isListed('queued') is false), until expireOld() closed it days later.
   */
  it("carries the @lid chat's queued triage work over to the surviving chat", () => {
    const { repos } = memRepos();
    const phone = repos.chats.upsertFromBridge(JID_A, null, true, T0);
    const lid = repos.chats.upsertFromBridge(LID_JID, null, true, T0);
    const lidItem = seedOpenItem(repos, lid.id, T0, 'm-lid');
    repos.queue.enqueue(lid.id, T0); // due = T0 + debounceMs, still un-run
    repos.chats.mergeLidInto(lid.id, JID_A, T0 + 5);
    expect(repos.items.byId(lidItem.id)).toMatchObject({ chatId: phone.id, analysis: 'queued' });
    expect(repos.queue.size()).toBe(1);
    expect(repos.queue.nextDue(T0 + 999_999)).toMatchObject({ chatId: phone.id, firstEnqueuedAt: T0 });
  });

  it('keeps the earliest due time when both chats have a queue row', () => {
    const { repos } = memRepos();
    const phone = repos.chats.upsertFromBridge(JID_A, null, true, T0);
    const lid = repos.chats.upsertFromBridge(LID_JID, null, true, T0);
    seedOpenItem(repos, lid.id, T0 + 100, 'm-lid');
    repos.queue.enqueue(phone.id, T0 + 50_000);
    repos.queue.enqueue(lid.id, T0);
    repos.queue.defer(lid.id, T0 + 1_000, 'CLOUD_UNAVAILABLE'); // one real failure already on the @lid row
    repos.chats.mergeLidInto(lid.id, JID_A, T0 + 5);
    expect(repos.queue.size()).toBe(1);
    expect(repos.queue.nextDue(T0 + 999_999)).toMatchObject({
      chatId: phone.id,
      dueAt: T0 + 1_000,
      firstEnqueuedAt: T0,
      attempts: 1,
    });
  });

  it('still drops the queue row when nothing analysable moves across', () => {
    const { repos } = memRepos();
    repos.chats.upsertFromBridge(JID_A, null, true, T0);
    const lid = repos.chats.upsertFromBridge(LID_JID, null, true, T0);
    const lidItem = seedOpenItem(repos, lid.id, T0, 'm-lid');
    repos.items.update(lidItem.id, { analysis: 'done', eventState: 'created' }, T0);
    repos.queue.enqueue(lid.id, T0);
    repos.chats.mergeLidInto(lid.id, JID_A, T0 + 5);
    expect(repos.queue.size()).toBe(0);
  });
});
