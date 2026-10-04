// V2-W1-11: store/dashboard.ts deltas (UX2 2.5, 12 "Stores"): the `queue:changed` payload, the navigation request the
// shell consumes (Automatic activity / Settings sections), the toast's own Undo, and the dirty-card rule extended to
// delta (Change) cards - an edited `to` is never overwritten by a refresh.
import { beforeEach, describe, expect, it } from 'vitest';
import type { ItemCard as ItemVM } from '@shared/types';
import { useDashboardStore } from './dashboard';
import { defaultCard, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';

const delta = (updatedAt: number): ItemVM => ({
  ...structuredClone(defaultCard),
  itemId: 9,
  eventState: 'change_proposed',
  updatedAt,
  change: {
    kind: 'reschedule',
    from: {
      title: 'm',
      startLocal: '2030-01-01T10:00:00',
      endLocal: '2030-01-01T11:00:00',
      timeZone: 'Asia/Jerusalem',
      location: '',
      status: 'confirmed',
    },
    to: {
      title: 'm',
      startLocal: '2030-01-01T12:00:00',
      endLocal: '2030-01-01T13:00:00',
      timeZone: 'Asia/Jerusalem',
      location: '',
      status: 'confirmed',
    },
    confidence: 'high',
    baseRevision: 1,
  },
});

beforeEach(() => {
  useDashboardStore.setState({
    queue: null,
    navRequest: null,
    toast: null,
    dirtyItemIds: new Set(),
    staleItemIds: new Set(),
    lists: {
      needs_reply: { items: [], count: 0 },
      in_calendar: { items: [], count: 0 },
      info_missing: { items: [], count: 0 },
    },
  });
});

describe('dashboard store v2', () => {
  it('keeps the latest queue:changed payload', () => {
    useDashboardStore.getState().setQueue({ pending: 2, running: 1, transcribing: { seconds: 42 } });
    expect(useDashboardStore.getState().queue?.transcribing?.seconds).toBe(42);
    useDashboardStore.getState().setQueue(null);
    expect(useDashboardStore.getState().queue).toBeNull();
  });

  it('a navigation request waits for the shell, which clears it', () => {
    useDashboardStore.getState().requestNavigation({ view: 'settings', section: 'pictures' });
    expect(useDashboardStore.getState().navRequest).toEqual({ view: 'settings', section: 'pictures' });
    useDashboardStore.getState().clearNavRequest();
    expect(useDashboardStore.getState().navRequest).toBeNull();
  });

  it('a toast may carry its own Undo', () => {
    let undone = false;
    useDashboardStore.getState().setToast({ key: 'auto.neverToast', onUndo: () => (undone = true) });
    useDashboardStore.getState().toast?.onUndo?.();
    expect(undone).toBe(true);
  });

  it('a delta card being edited keeps its view model through a refresh and is flagged stale', async () => {
    const edited = delta(1);
    useDashboardStore.setState({
      lists: {
        needs_reply: { items: [edited], count: 1 },
        in_calendar: { items: [], count: 0 },
        info_missing: { items: [], count: 0 },
      },
    });
    useDashboardStore.getState().markDirty(9, true);
    mockInvoke('dashboard:get', () => ({
      ok: true,
      value: {
        needsReply: [delta(2)],
        inCalendar: [],
        infoMissing: [],
        counts: { needsReply: 1, inCalendar: 0, infoMissing: 0, ignored: 0 },
        analysing: 0,
      },
    }));
    await useDashboardStore.getState().refresh();
    const kept = useDashboardStore.getState().lists.needs_reply.items[0]!;
    expect(kept).toBe(edited);
    expect(kept.updatedAt).toBe(1);
    expect(useDashboardStore.getState().staleItemIds.has(9)).toBe(true);
  });
});

describe('dashboard store - open item and refresh edges', () => {
  it('reloadOpenItem: nothing open or a dirty open card => no IPC; otherwise the fresh detail replaces it', async () => {
    useDashboardStore.setState({ openItemId: null, openItem: null });
    await useDashboardStore.getState().reloadOpenItem();
    expect(invokeMocks['item:get']).not.toHaveBeenCalled();
    useDashboardStore.setState({ openItemId: 1, dirtyItemIds: new Set([1]) });
    await useDashboardStore.getState().reloadOpenItem();
    expect(invokeMocks['item:get']).not.toHaveBeenCalled();
    useDashboardStore.setState({ dirtyItemIds: new Set() });
    await useDashboardStore.getState().reloadOpenItem();
    expect(invokeMocks['item:get']).toHaveBeenCalledWith({ itemId: 1 });
    expect(useDashboardStore.getState().openItem?.itemId).toBe(1);
  });

  it('reloadOpenItem / openItemById drop an answer that lost the race to another open', async () => {
    let resolve!: (v: unknown) => void;
    mockInvoke('item:get', () => new Promise((r) => (resolve = r)) as never);
    useDashboardStore.setState({ openItemId: 1, openItem: null });
    const reload = useDashboardStore.getState().reloadOpenItem();
    useDashboardStore.setState({ openItemId: 2 });
    resolve({ ok: true, value: { ...structuredClone(defaultCard), messages: [] } });
    await reload;
    expect(useDashboardStore.getState().openItem).toBeNull();
    const open = useDashboardStore.getState().openItemById(3);
    useDashboardStore.setState({ openItemId: 4 });
    resolve({ ok: true, value: { ...structuredClone(defaultCard), messages: [] } });
    await open;
    expect(useDashboardStore.getState().openItem).toBeNull();
    await useDashboardStore.getState().openItemById(null);
    expect(useDashboardStore.getState().openItemId).toBeNull();
  });

  it('applyItem replaces only the open card', () => {
    useDashboardStore.setState({ openItemId: 5, openItem: null });
    useDashboardStore.getState().applyItem({ ...structuredClone(defaultCard), itemId: 6, messages: [] });
    expect(useDashboardStore.getState().openItem).toBeNull();
    useDashboardStore.getState().applyItem({ ...structuredClone(defaultCard), itemId: 5, messages: [] });
    expect(useDashboardStore.getState().openItem?.itemId).toBe(5);
  });

  it('a failed refresh records the error; a pinned card that vanished from main is flagged stale', async () => {
    mockInvoke('dashboard:get', () => ({ ok: false, error: { code: 'BAD_REQUEST' } }));
    await useDashboardStore.getState().refresh();
    expect(useDashboardStore.getState().loadError).toBe('BAD_REQUEST');
    const edited = delta(1);
    useDashboardStore.setState({
      lists: {
        needs_reply: { items: [edited], count: 1 },
        in_calendar: { items: [], count: 0 },
        info_missing: { items: [], count: 0 },
      },
      dirtyItemIds: new Set([9, 77]),
    });
    mockInvoke('dashboard:get', () => ({
      ok: true,
      value: {
        needsReply: [],
        inCalendar: [],
        infoMissing: [],
        counts: { needsReply: 0, inCalendar: 0, infoMissing: 0, ignored: 0 },
        analysing: 0,
      },
    }));
    await useDashboardStore.getState().refresh();
    expect(useDashboardStore.getState().staleItemIds.has(9)).toBe(true);
    expect(useDashboardStore.getState().lists.needs_reply.items).toHaveLength(1);
    expect(useDashboardStore.getState().loadError).toBeNull();
  });

  it('markStale / toggleSection / setUndoDrawerOpen / noteArrived', () => {
    useDashboardStore.getState().markStale(3, true);
    expect(useDashboardStore.getState().staleItemIds.has(3)).toBe(true);
    useDashboardStore.getState().markStale(3, false);
    expect(useDashboardStore.getState().staleItemIds.has(3)).toBe(false);
    const before = useDashboardStore.getState().sectionOpen.in_calendar;
    useDashboardStore.getState().toggleSection('in_calendar');
    expect(useDashboardStore.getState().sectionOpen.in_calendar).toBe(!before);
    useDashboardStore.getState().setUndoDrawerOpen(true);
    expect(useDashboardStore.getState().undoDrawerOpen).toBe(true);
    useDashboardStore.setState({ arrivedItemIds: new Set() });
    useDashboardStore.getState().noteArrived([]);
    expect(useDashboardStore.getState().arrivedItemIds.size).toBe(0);
    useDashboardStore.getState().noteArrived([1, 2]);
    expect(useDashboardStore.getState().arrivedItemIds.size).toBe(2);
  });
});
