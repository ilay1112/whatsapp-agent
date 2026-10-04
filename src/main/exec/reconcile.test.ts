// src/main/exec/reconcile.test.ts - TESTS 5.3 row `exec/*`: the READ-ONLY resolution of `unknown_outcome` actions.
// The single invariant under test: reconcile never performs a side effect. It only looks for evidence that one already
// happened - an outbound row in the bridge's own messages.db, or a calendar event stamped with our chain-root action id -
// and a failure to find it leaves the action in `unknown_outcome` so the card keeps offering the retry clone.
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY_DB, createRepos, openDb } from '../db/index';
import { LIMITS } from '../../shared/types';
import { createVirtualClock } from '../../../tests/helpers/virtualClock';
import { reconcileUnknown } from './reconcile';
import type { ReconcileDeps } from './reconcile';
import type { Db, Repos } from '../db/index';
import type { BridgeMessageRow } from '../bridge/bridgeDb';
import type { ApprovalAction, EpochMs, ItemId } from '../../shared/types';
import type { ActionPayload, CreateEventPayload, SendReplyPayload } from '../../shared/schemas';

const NOW_0 = Date.UTC(2026, 8, 21, 9, 0, 0);
const JID = '972550000002@s.whatsapp.net'; // TESTS T5: synthetic JID
const TEXT = 'On my way.';
const START = '2026-09-24T17:00:00';
const END = '2026-09-24T18:00:00';

const open: Db[] = [];
afterEach(() => {
  while (open.length) open.pop()?.close();
});

function rig() {
  const db = openDb(MEMORY_DB);
  open.push(db);
  const repos = createRepos(db);
  const clock = createVirtualClock(NOW_0);
  const chat = repos.chats.upsertFromBridge(JID, 'Contact', true, NOW_0 as EpochMs);
  const item = repos.items.createOpen({
    chatId: chat.id,
    triggerMsgId: 'm1',
    triggerTs: NOW_0 as EpochMs,
    analysis: 'done',
    holdReason: null,
    now: NOW_0 as EpochMs,
  });
  const proposal = repos.proposals.insertNext({
    itemId: item.id,
    provider: 'user',
    model: 'test',
    extraction: null,
    draftText: TEXT,
    replyLang: 'en',
    event: null,
    freeBusy: null,
    suspicious: false,
    createdAt: NOW_0 as EpochMs,
  });
  return { db, repos, clock, chatId: chat.id, itemId: item.id as ItemId, proposalId: proposal.id };
}
type Rig = ReturnType<typeof rig>;

const reply = (r: Rig, text = TEXT): SendReplyPayload => ({
  v: 1,
  kind: 'send_reply',
  itemId: r.itemId,
  chatRef: r.chatId,
  proposalVersion: 1,
  text,
});
const event = (r: Rig): CreateEventPayload => ({
  v: 1,
  kind: 'create_event',
  itemId: r.itemId,
  chatRef: r.chatId,
  proposalVersion: 1,
  title: 'Coffee',
  startLocal: START,
  endLocal: END,
  timeZone: 'Asia/Jerusalem',
  location: '',
});

/** pending -> approved -> executing -> unknown_outcome, exactly as the executor leaves a timed-out action. */
function seedUnknown(r: Rig, payload: ActionPayload, finalJson?: string): ApprovalAction {
  const a = r.repos.actions.insertPending({
    itemId: r.itemId,
    proposalId: r.proposalId,
    chatId: r.chatId,
    payload,
    now: NOW_0 as EpochMs,
  });
  r.repos.actions.markApprovedExecuting(a.id, finalJson ?? a.canonicalJson, NOW_0 as EpochMs, 'user');
  r.repos.actions.markUnknownOutcome(a.id, NOW_0 as EpochMs);
  return r.repos.actions.byId(a.id)!;
}

const outboundRow = (over: Partial<BridgeMessageRow> = {}): BridgeMessageRow => ({
  rowid: 1,
  id: 'wa-msg-1',
  chat_jid: JID,
  sender: '972550000002',
  content: TEXT,
  timestamp: new Date(NOW_0 + 1_000).toISOString(),
  is_from_me: 1,
  media_type: null,
  deleted_at: null,
  ...over,
});

function fakeBridgeDb(rows: BridgeMessageRow[], opts: { opens?: boolean } = {}) {
  const calls = { open: 0, outboundAfter: 0, close: 0 };
  return {
    calls,
    db: {
      open: () => {
        calls.open += 1;
        return opts.opens !== false;
      },
      outboundAfter: () => {
        calls.outboundAfter += 1;
        return rows;
      },
      close: () => {
        calls.close += 1;
      },
    } satisfies ReconcileDeps['bridgeDb'],
  };
}

const deps = (r: Rig, over: Partial<ReconcileDeps> = {}): ReconcileDeps => ({
  repos: r.repos,
  bridgeDb: null,
  read: null,
  now: () => r.clock.now() as EpochMs,
  timeZone: () => 'Asia/Jerusalem',
  ...over,
});

describe('reconcileUnknown: send_reply', () => {
  it('marks the action done when the bridge store holds a matching outbound row', async () => {
    const r = rig();
    const a = seedUnknown(r, reply(r));
    const bridge = fakeBridgeDb([outboundRow()]);
    const out = await reconcileUnknown(deps(r, { bridgeDb: bridge.db }));

    expect(out).toEqual({ checked: 1, resolvedDone: 1, stillUnknown: 0 });
    const row = r.repos.actions.byId(a.id)!;
    expect(row.state).toBe('done');
    expect(row.result).toEqual({ kind: 'send_reply', waMsgId: 'wa-msg-1' });
    expect(r.repos.items.byId(r.itemId)?.replyState).toBe('sent');
    expect(
      r.db
        .prepare<{ kind: string }>(`SELECT kind FROM audit_log WHERE ref = ?`)
        .all(a.id)
        .map((x) => x.kind),
    ).toContain('action_reconciled');
  });

  it('keeps unknown_outcome when the text does not match byte for byte', async () => {
    const r = rig();
    const a = seedUnknown(r, reply(r));
    const out = await reconcileUnknown(
      deps(r, { bridgeDb: fakeBridgeDb([outboundRow({ content: 'On my way!' })]).db }),
    );
    expect(out.stillUnknown).toBe(1);
    expect(r.repos.actions.byId(a.id)?.state).toBe('unknown_outcome');
  });

  it('keeps unknown_outcome when the row is outside the reconcile window', async () => {
    const r = rig();
    const a = seedUnknown(r, reply(r));
    const late = new Date(NOW_0 + LIMITS.reconcileSendWindowMs + 1_000).toISOString();
    expect(
      (await reconcileUnknown(deps(r, { bridgeDb: fakeBridgeDb([outboundRow({ timestamp: late })]).db }))).stillUnknown,
    ).toBe(1);
    const early = new Date(NOW_0 - 60_000).toISOString();
    expect(
      (await reconcileUnknown(deps(r, { bridgeDb: fakeBridgeDb([outboundRow({ timestamp: early })]).db })))
        .stillUnknown,
    ).toBe(1);
    expect(r.repos.actions.byId(a.id)?.state).toBe('unknown_outcome');
  });

  it('skips a row whose timestamp cannot be parsed', async () => {
    const r = rig();
    seedUnknown(r, reply(r));
    const out = await reconcileUnknown(
      deps(r, { bridgeDb: fakeBridgeDb([outboundRow({ timestamp: 'not a date' })]).db }),
    );
    expect(out.stillUnknown).toBe(1);
  });

  it('keeps unknown_outcome when the bridge store is absent or cannot be opened', async () => {
    const r = rig();
    seedUnknown(r, reply(r));
    expect((await reconcileUnknown(deps(r))).stillUnknown).toBe(1); // bridgeDb: null
    const closed = fakeBridgeDb([outboundRow()], { opens: false });
    expect((await reconcileUnknown(deps(r, { bridgeDb: closed.db }))).stillUnknown).toBe(1);
    expect(closed.calls.outboundAfter).toBe(0);
  });

  it('keeps unknown_outcome when the approved payload was nulled by retention', async () => {
    const r = rig();
    const a = seedUnknown(r, reply(r));
    r.db.prepare(`UPDATE actions SET approved_final_json = NULL WHERE id = ?`).run(a.id);
    expect((await reconcileUnknown(deps(r, { bridgeDb: fakeBridgeDb([outboundRow()]).db }))).stillUnknown).toBe(1);
  });

  it('keeps unknown_outcome when the approved payload is not valid JSON', async () => {
    const r = rig();
    const a = seedUnknown(r, reply(r), '{not json');
    expect((await reconcileUnknown(deps(r, { bridgeDb: fakeBridgeDb([outboundRow()]).db }))).stillUnknown).toBe(1);
    expect(r.repos.actions.byId(a.id)?.state).toBe('unknown_outcome');
  });

  it('keeps unknown_outcome when the approved payload fails the schema', async () => {
    const r = rig();
    seedUnknown(r, reply(r), JSON.stringify({ v: 1, kind: 'send_reply' }));
    expect((await reconcileUnknown(deps(r, { bridgeDb: fakeBridgeDb([outboundRow()]).db }))).stillUnknown).toBe(1);
  });

  it('keeps unknown_outcome when the chat row is gone', async () => {
    const r = rig();
    const a = seedUnknown(r, reply(r));
    const repos = { ...r.repos, chats: { ...r.repos.chats, byId: () => null } };
    const bridge = fakeBridgeDb([outboundRow()]);
    expect((await reconcileUnknown({ ...deps(r, { bridgeDb: bridge.db }), repos })).stillUnknown).toBe(1);
    expect(bridge.calls.open).toBe(0);
    expect(r.repos.actions.byId(a.id)?.state).toBe('unknown_outcome');
  });

  it('skips an id whose row disappeared between the scan and the read', async () => {
    const r = rig();
    seedUnknown(r, reply(r));
    const repos = { ...r.repos, actions: { ...r.repos.actions, byId: () => null } };
    expect(await reconcileUnknown({ ...deps(r), repos })).toEqual({ checked: 0, resolvedDone: 0, stillUnknown: 0 });
  });

  it('keeps unknown_outcome when the action carries no execution anchor', async () => {
    const r = rig();
    const a = seedUnknown(r, reply(r));
    r.db.prepare(`UPDATE actions SET executed_at = NULL, approved_at = NULL WHERE id = ?`).run(a.id);
    expect((await reconcileUnknown(deps(r, { bridgeDb: fakeBridgeDb([outboundRow()]).db }))).stillUnknown).toBe(1);
  });
});

describe('reconcileUnknown: create_event', () => {
  const found = { eventId: 'ev-1', htmlLink: 'https://calendar.example/ev-1', startLocal: START };

  it('marks the action done when findAppEvent finds our chain-root event', async () => {
    const r = rig();
    const a = seedUnknown(r, event(r));
    const seen: string[] = [];
    const out = await reconcileUnknown(
      deps(r, {
        read: {
          findAppEvent: (chainRootId) => {
            seen.push(chainRootId);
            return Promise.resolve({ ok: true, value: found });
          },
        },
      }),
    );

    expect(out).toEqual({ checked: 1, resolvedDone: 1, stillUnknown: 0 });
    expect(seen).toEqual([a.id]); // the CHAIN ROOT, never the clone
    const row = r.repos.actions.byId(a.id)!;
    expect(row.state).toBe('done');
    expect(row.result).toEqual({ kind: 'create_event', eventId: 'ev-1', htmlLink: found.htmlLink });
    const item = r.repos.items.byId(r.itemId)!;
    expect(item.eventState).toBe('created');
    expect(item.calendarEventId).toBe('ev-1');
  });

  it('asks findAppEvent with the CHAIN ROOT id for a retry clone', async () => {
    const r = rig();
    const root = seedUnknown(r, event(r));
    const clone = r.repos.actions.insertPending({
      itemId: r.itemId,
      proposalId: r.proposalId,
      chatId: r.chatId,
      payload: event(r),
      now: NOW_0 as EpochMs,
      retryOf: root.id,
    });
    r.repos.actions.markApprovedExecuting(clone.id, clone.canonicalJson, NOW_0 as EpochMs, 'user');
    r.repos.actions.markUnknownOutcome(clone.id, NOW_0 as EpochMs);

    const seen: string[] = [];
    await reconcileUnknown(
      deps(r, {
        read: {
          findAppEvent: (id) => {
            seen.push(id);
            return Promise.resolve({ ok: true, value: null });
          },
        },
      }),
    );
    expect(new Set(seen)).toEqual(new Set([root.id]));
  });

  it('[R2] keeps unknown_outcome when the lookup finds nothing, fails or throws', async () => {
    const r = rig();
    const a = seedUnknown(r, event(r));
    const nothing = await reconcileUnknown(
      deps(r, { read: { findAppEvent: () => Promise.resolve({ ok: true, value: null }) } }),
    );
    expect(nothing).toEqual({ checked: 1, resolvedDone: 0, stillUnknown: 1 });
    const failed = await reconcileUnknown(
      deps(r, { read: { findAppEvent: () => Promise.resolve({ ok: false, error: 'unavailable' }) } }),
    );
    expect(failed.stillUnknown).toBe(1);
    const threw = await reconcileUnknown(
      deps(r, { read: { findAppEvent: () => Promise.reject(new Error('transport')) } }),
    );
    expect(threw.stillUnknown).toBe(1);
    expect(r.repos.actions.byId(a.id)?.state).toBe('unknown_outcome');
  });

  it('keeps unknown_outcome when the calendar is not connected at all', async () => {
    const r = rig();
    seedUnknown(r, event(r));
    expect((await reconcileUnknown(deps(r))).stillUnknown).toBe(1); // read: null
  });

  it('looks the event up in the zone the user approved, with a day of margin on both sides', async () => {
    const r = rig();
    seedUnknown(r, event(r));
    let window: { timeZone: string; timeMinLocal: string; timeMaxLocal: string } | null = null;
    await reconcileUnknown(
      deps(r, {
        read: {
          findAppEvent: (_id, w) => {
            window = { timeZone: w.timeZone, timeMinLocal: w.timeMinLocal, timeMaxLocal: w.timeMaxLocal };
            return Promise.resolve({ ok: true, value: null });
          },
        },
        timeZone: () => 'Europe/Berlin', // never used: the payload pins its own zone
      }),
    );
    expect(window).toEqual({
      timeZone: 'Asia/Jerusalem',
      timeMinLocal: '2026-09-23T17:00:00',
      timeMaxLocal: '2026-09-25T18:00:00',
    });
  });

  it('pins the lookup window to the target calendar only', async () => {
    const r = rig();
    seedUnknown(r, event(r));
    let ids: readonly string[] = [];
    await reconcileUnknown(
      deps(r, {
        read: {
          findAppEvent: (_id, w) => {
            ids = w.calendarIds;
            return Promise.resolve({ ok: true, value: null });
          },
        },
      }),
    );
    expect(ids).toEqual([r.repos.settings.get().calendar.targetCalendarId]);
  });
});

describe('reconcileUnknown: scope', () => {
  it('does nothing when there is no unknown_outcome action', async () => {
    const r = rig();
    expect(await reconcileUnknown(deps(r))).toEqual({ checked: 0, resolvedDone: 0, stillUnknown: 0 });
  });

  it('never touches a pending, executing or done action', async () => {
    const r = rig();
    const pending = r.repos.actions.insertPending({
      itemId: r.itemId,
      proposalId: r.proposalId,
      chatId: r.chatId,
      payload: reply(r),
      now: NOW_0 as EpochMs,
    });
    const bridge = fakeBridgeDb([outboundRow()]);
    expect(await reconcileUnknown(deps(r, { bridgeDb: bridge.db }))).toEqual({
      checked: 0,
      resolvedDone: 0,
      stillUnknown: 0,
    });
    expect(bridge.calls.open).toBe(0);
    expect(r.repos.actions.byId(pending.id)?.state).toBe('pending');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// torn resolution (data-integrity-6): markDone + the item consequence + the `action_reconciled` audit are ONE transaction
// ---------------------------------------------------------------------------------------------------------------------

describe('reconcileUnknown: atomicity', () => {
  /** `items.update` is the one statement of the resolution that lives outside `actions`; everything else is real. */
  const brokenItemUpdate = (r: Rig): Repos =>
    ({
      ...r.repos,
      items: {
        ...r.repos.items,
        update: () => {
          throw new Error('items.update exploded');
        },
      },
    }) as Repos;

  const auditKinds = (r: Rig, ref: string): string[] =>
    r.db
      .prepare<{ kind: string }>(`SELECT kind FROM audit_log WHERE ref = ? ORDER BY id`)
      .all(ref)
      .map((x) => x.kind);

  it('send_reply: a failed item consequence leaves the action unknown_outcome, never a half-done row', async () => {
    const r = rig();
    const a = seedUnknown(r, reply(r));
    await expect(
      reconcileUnknown(deps(r, { bridgeDb: fakeBridgeDb([outboundRow()]).db, repos: brokenItemUpdate(r) })),
    ).rejects.toThrow('items.update exploded');

    // 'done' + reply_state 'draft' is exactly the torn state no later pass ever revisits.
    expect(r.repos.actions.byId(a.id)?.state).toBe('unknown_outcome');
    expect(r.repos.items.byId(r.itemId)?.replyState).not.toBe('sent');
    expect(auditKinds(r, a.id)).not.toContain('action_reconciled');
  });

  it('create_event: a failed item consequence leaves the action unknown_outcome too', async () => {
    const r = rig();
    const a = seedUnknown(r, event(r));
    await expect(
      reconcileUnknown(
        deps(r, {
          read: {
            findAppEvent: () =>
              Promise.resolve({ ok: true, value: { eventId: 'ev-1', htmlLink: null, startLocal: START } }),
          },
          repos: brokenItemUpdate(r),
        }),
      ),
    ).rejects.toThrow('items.update exploded');

    expect(r.repos.actions.byId(a.id)?.state).toBe('unknown_outcome');
    expect(r.repos.items.byId(r.itemId)?.eventState).not.toBe('created');
    expect(auditKinds(r, a.id)).not.toContain('action_reconciled');
  });
});
