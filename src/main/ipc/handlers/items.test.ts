// TESTS 5.3 `ipc/*`: the items/dashboard/chat channels are pure delegation to ItemService - no view model is built here
// and no JID is read, so the test asserts the exact call shape and that a service failure travels back unchanged.
import { describe, expect, it } from 'vitest';
import type { ItemService } from '../../agent/items';
import type { IpcReq } from '../../../shared/ipc';
import { makeFixture } from '../register.fixtures';
import { createItemsHandlers } from './items';

const CTX = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };
const DETAIL = { itemId: 4 } as unknown as ReturnType<ItemService['detail']> extends { ok: true; value: infer V }
  ? V
  : never;

function spyService(): { service: ItemService; calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const rec =
    <T>(name: string, value: T) =>
    (...args: unknown[]): T => {
      calls.push([name, args]);
      return value;
    };
  const service = {
    dashboard: rec('dashboard', {
      needsReply: [],
      inCalendar: [],
      infoMissing: [],
      counts: { needsReply: 0, inCalendar: 0, infoMissing: 0, ignored: 0 },
      analysing: 0,
    }),
    ignored: rec('ignored', { items: [] }),
    detail: rec('detail', { ok: true, value: DETAIL }),
    dismiss: rec('dismiss', { ok: true, value: DETAIL }),
    restore: rec('restore', { ok: true, value: DETAIL }),
    retriage: rec('retriage', { ok: false, error: { code: 'RATE_LIMIT_RETRIAGE' } }),
    setEditing: rec('setEditing', { ok: true, value: null }),
    completeEvent: rec('completeEvent', { ok: true, value: DETAIL }),
    setChatPolicy: rec('setChatPolicy', {
      ok: true,
      value: { chatRef: 2, displayName: '', phoneDisplay: '', sendable: true, isKnown: true, policy: 'never' },
    }),
    listPolicies: rec('listPolicies', { chats: [] }),
  } as unknown as ItemService;
  return { service, calls };
}

describe('items handlers', () => {
  it('delegates every channel with the request fields and nothing else', async () => {
    const { service, calls } = spyService();
    const h = createItemsHandlers(makeFixture({ items: service }).deps);

    expect(await h['dashboard:get'](undefined, CTX)).toEqual({
      ok: true,
      value: expect.objectContaining({ analysing: 0 }),
    });
    expect(await h['dashboard:getIgnored'](undefined, CTX)).toEqual({ ok: true, value: { items: [] } });
    expect(await h['item:get']({ itemId: 4 }, CTX)).toEqual({ ok: true, value: DETAIL });
    await h['item:dismiss']({ itemId: 5 }, CTX);
    await h['item:restore']({ itemId: 6 }, CTX);
    await h['item:setEditing']({ itemId: 7, editing: true }, CTX);
    const complete = {
      itemId: 8,
      event: { title: 'X', startLocal: '2026-09-24T17:00:00', endLocal: '2026-09-24T18:00:00', location: '' },
    } as IpcReq<'item:completeEvent'>;
    await h['item:completeEvent'](complete, CTX);
    await h['chat:setPolicy']({ chatRef: 2, policy: 'never' }, CTX);
    expect(await h['chat:listPolicies'](undefined, CTX)).toEqual({ ok: true, value: { chats: [] } });

    expect(calls).toEqual([
      ['dashboard', []],
      ['ignored', []],
      ['detail', [4]],
      ['dismiss', [5]],
      ['restore', [6]],
      ['setEditing', [7, true]],
      ['completeEvent', [complete]],
      ['setChatPolicy', [{ chatRef: 2, policy: 'never' }]],
      ['listPolicies', []],
    ]);
  });

  it('passes a service failure straight back to the renderer', async () => {
    const { service } = spyService();
    const h = createItemsHandlers(makeFixture({ items: service }).deps);
    expect(await h['item:retriage']({ itemId: 1 }, CTX)).toEqual({ ok: false, error: { code: 'RATE_LIMIT_RETRIAGE' } });
  });

  it('forwards the forceKnown variant of chat:setPolicy verbatim', async () => {
    const { service, calls } = spyService();
    const h = createItemsHandlers(makeFixture({ items: service }).deps);
    await h['chat:setPolicy']({ chatRef: 9, forceKnown: true }, CTX);
    expect(calls).toEqual([['setChatPolicy', [{ chatRef: 9, forceKnown: true }]]]);
  });
});
