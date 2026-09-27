// src/main/ipc/handlers/actions.test.ts - TESTS 5.3 rows `ipc/*` and `exec/*`, safety-critical (100 % line / 95 % branch).
// This handler is the ONLY production caller of ActionExecutor.approve. What it owns is the window gate of ARCH 6.6 step 1
// (a click must have happened on a card the user was looking at) and the ItemDetail the renderer re-renders the card from -
// everything else is delegated, unchanged, to the executor.
import { describe, expect, it } from 'vitest';
import { makeFixture } from '../register.fixtures';
import { createActionsHandlers } from './actions';
import type { ActionExecutor } from '../../exec/actionExecutor';
import type { ItemService } from '../../agent/items';
import type { Repos } from '../../db/index';
import type { ApproveOutcome, ApproveReq, IpcContext } from '../../../shared/ipc';
import type { ActionId, ApprovalAction, ItemDetail, Result } from '../../../shared/types';

const ACTION_ID = '11111111-2222-4333-8444-555555555555' as ActionId;
const ITEM_ID = 42;
const CTX: IpcContext = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };
const APPROVE: ApproveReq = { actionId: ACTION_ID, kind: 'send_reply', shownHash: 'a'.repeat(64) };

const detail = (tag: string): ItemDetail => ({ itemId: ITEM_ID, tag }) as unknown as ItemDetail;
const EXECUTOR_DETAIL = detail('from-executor');
const SERVICE_DETAIL = detail('from-item-service');

interface Doubles {
  approve?: (req: ApproveReq, ctx: IpcContext) => Promise<Result<ApproveOutcome>>;
  reject?: (id: ActionId) => Promise<Result<null>>;
  serviceDetail?: (itemId: number) => Result<ItemDetail>;
  action?: ApprovalAction | null;
}

function harness(d: Doubles = {}) {
  const calls: Array<[string, unknown]> = [];
  const executor = {
    approve: async (req: ApproveReq, ctx: IpcContext) => {
      calls.push(['approve', req]);
      return d.approve
        ? d.approve(req, ctx)
        : ({ ok: true, value: { outcome: 'done', item: EXECUTOR_DETAIL } } satisfies Result<ApproveOutcome>);
    },
    reject: async (id: ActionId) => {
      calls.push(['reject', id]);
      return d.reject ? d.reject(id) : ({ ok: true, value: null } satisfies Result<null>);
    },
  } as unknown as ActionExecutor;

  const items = {
    detail: (itemId: number) => {
      calls.push(['detail', itemId]);
      return d.serviceDetail ? d.serviceDetail(itemId) : ({ ok: true, value: SERVICE_DETAIL } as Result<ItemDetail>);
    },
  } as unknown as ItemService;

  const repos = {
    actions: {
      byId: () => (d.action === undefined ? ({ id: ACTION_ID, itemId: ITEM_ID } as ApprovalAction) : d.action),
    },
  } as unknown as Repos;

  const fixture = makeFixture({ executor, items, repos });
  return { h: createActionsHandlers(fixture.deps), calls, rec: fixture.rec };
}

describe('action:approve window gate', () => {
  it.each([
    ['hidden', { ...CTX, windowVisible: false }],
    ['unfocused', { ...CTX, windowFocused: false }],
    ['hidden and unfocused', { windowFocused: false, windowVisible: false, shownByNotificationAt: null }],
  ])('refuses an approve from a %s window without calling the executor', async (_name, ctx) => {
    const { h, calls, rec } = harness();
    expect(await h['action:approve'](APPROVE, ctx)).toEqual({ ok: false, error: { code: 'WINDOW_NOT_FOCUSED' } });
    expect(calls).toEqual([]);
    expect(rec.audits).toEqual([
      {
        kind: 'ipc_rejected',
        ref: null,
        detail: { channel: 'action:approve', reason: 'window_not_focused' },
        now: expect.any(Number),
      },
    ]);
  });

  it('passes the request AND the context through to the executor when the window is usable', async () => {
    const seen: IpcContext[] = [];
    const { h, calls } = harness({
      approve: async (_req, ctx) => {
        seen.push(ctx);
        return { ok: true, value: { outcome: 'done', item: EXECUTOR_DETAIL } };
      },
    });
    const ctx: IpcContext = { ...CTX, shownByNotificationAt: 1_760_000_000_000 };
    await h['action:approve'](APPROVE, ctx);
    expect(calls[0]).toEqual(['approve', APPROVE]);
    expect(seen).toEqual([ctx]); // the focus-steal guard runs inside the executor, on this ctx
  });
});

describe('action:approve result', () => {
  it('returns a gate failure from the executor unchanged and builds no view model', async () => {
    const { h, calls } = harness({ approve: async () => ({ ok: false, error: { code: 'ACTION_STALE' } }) });
    expect(await h['action:approve'](APPROVE, CTX)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    expect(calls.map((c) => c[0])).toEqual(['approve']);
  });

  it("replaces the executor's row-only detail with the ItemService view model", async () => {
    const { h, calls } = harness();
    expect(await h['action:approve'](APPROVE, CTX)).toEqual({
      ok: true,
      value: { outcome: 'done', item: SERVICE_DETAIL },
    });
    expect(calls).toEqual([
      ['approve', APPROVE],
      ['detail', ITEM_ID],
    ]);
  });

  it('keeps every other field of the outcome (needs_confirm_conflict carries its busy blocks)', async () => {
    const busy = [{ startLocal: '2026-09-24T17:30:00', endLocal: '2026-09-24T18:30:00' }];
    const { h } = harness({
      approve: async () => ({ ok: true, value: { outcome: 'needs_confirm_conflict', busy, item: EXECUTOR_DETAIL } }),
    });
    expect(await h['action:approve'](APPROVE, CTX)).toEqual({
      ok: true,
      value: { outcome: 'needs_confirm_conflict', busy, item: SERVICE_DETAIL },
    });
  });

  it('returns the executor outcome untouched when the action row is already gone', async () => {
    const { h, calls } = harness({ action: null });
    expect(await h['action:approve'](APPROVE, CTX)).toEqual({
      ok: true,
      value: { outcome: 'done', item: EXECUTOR_DETAIL },
    });
    expect(calls.map((c) => c[0])).toEqual(['approve']);
  });

  it('never loses an outcome that already happened when the view model fails', async () => {
    const { h } = harness({ serviceDetail: () => ({ ok: false, error: { code: 'NOT_FOUND' } }) });
    expect(await h['action:approve'](APPROVE, CTX)).toEqual({
      ok: true,
      value: { outcome: 'done', item: EXECUTOR_DETAIL },
    });
  });

  it('never loses an outcome that already happened when the view model THROWS, and logs it with metadata only', async () => {
    const { h, rec } = harness({
      serviceDetail: () => {
        throw new Error('boom');
      },
    });
    expect(await h['action:approve'](APPROVE, CTX)).toEqual({
      ok: true,
      value: { outcome: 'done', item: EXECUTOR_DETAIL },
    });
    expect(rec.logs).toEqual([{ level: 'warn', event: 'action_detail_failed', meta: { itemId: ITEM_ID } }]);
  });
});

describe('action:reject', () => {
  it('rejects the action and answers with the refreshed item detail', async () => {
    const { h, calls } = harness();
    expect(await h['action:reject']({ actionId: ACTION_ID }, CTX)).toEqual({ ok: true, value: SERVICE_DETAIL });
    expect(calls).toEqual([
      ['reject', ACTION_ID],
      ['detail', ITEM_ID],
    ]);
  });

  it('returns the executor failure unchanged', async () => {
    const { h, calls } = harness({ reject: async () => ({ ok: false, error: { code: 'ACTION_STALE' } }) });
    expect(await h['action:reject']({ actionId: ACTION_ID }, CTX)).toEqual({
      ok: false,
      error: { code: 'ACTION_STALE' },
    });
    expect(calls.map((c) => c[0])).toEqual(['reject']);
  });

  it('answers NOT_FOUND when the row disappeared between the read and the reject', async () => {
    const { h } = harness({ action: null });
    expect(await h['action:reject']({ actionId: ACTION_ID }, CTX)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('passes an ItemService failure straight through', async () => {
    const { h } = harness({ serviceDetail: () => ({ ok: false, error: { code: 'NOT_FOUND' } }) });
    expect(await h['action:reject']({ actionId: ACTION_ID }, CTX)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('does not apply the window gate to a reject (declining is always safe)', async () => {
    const { h, calls } = harness();
    const hidden: IpcContext = { windowFocused: false, windowVisible: false, shownByNotificationAt: null };
    expect(await h['action:reject']({ actionId: ACTION_ID }, hidden)).toEqual({ ok: true, value: SERVICE_DETAIL });
    expect(calls.map((c) => c[0])).toEqual(['reject', 'detail']);
  });
});
