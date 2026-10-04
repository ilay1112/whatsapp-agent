// UX 6.3 / 14.3 refresh rule + build-plan W1-15 acceptance item 4 (a dirty card is never replaced on `dashboard:changed`).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemCard } from '@shared/types';
import { useDashboardStore, ARRIVAL_MS, LIST_KEYS } from './dashboard';
import { defaultCard, defaultDetail, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';

const card = (patch: Partial<ItemCard>): ItemCard => ({ ...structuredClone(defaultCard), ...patch });

const dashboard = (needsReply: ItemCard[], counts?: Partial<{ needsReply: number; ignored: number }>) => ({
  needsReply,
  inCalendar: [],
  infoMissing: [],
  counts: {
    needsReply: counts?.needsReply ?? needsReply.length,
    inCalendar: 0,
    infoMissing: 0,
    ignored: counts?.ignored ?? 0,
  },
  analysing: 0,
});

beforeEach(() => {
  useDashboardStore.setState({
    lists: {
      needs_reply: { items: [], count: 0 },
      in_calendar: { items: [], count: 0 },
      info_missing: { items: [], count: 0 },
    },
    analysing: 0,
    ignoredCount: 0,
    hydrated: false,
    loadError: null,
    openItemId: null,
    openItem: null,
    sectionOpen: { needs_reply: true, in_calendar: false, info_missing: true },
    undoDrawerOpen: false,
    toast: null,
    dirtyItemIds: new Set(),
    staleItemIds: new Set(),
  });
});

describe('dashboard store - hydrate', () => {
  it('fills the three lists and their counts from dashboard:get', async () => {
    mockInvoke('dashboard:get', () => ({
      ok: true,
      value: dashboard([card({ itemId: 1 })], { needsReply: 7, ignored: 12 }),
    }));
    await useDashboardStore.getState().refresh();
    const s = useDashboardStore.getState();
    expect(s.hydrated).toBe(true);
    expect(s.lists.needs_reply.items.map((c) => c.itemId)).toEqual([1]);
    expect(s.lists.needs_reply.count).toBe(7);
    expect(s.ignoredCount).toBe(12);
    expect(s.loadError).toBeNull();
  });

  it('records the ErrorCode and keeps the old lists when the round trip fails', async () => {
    mockInvoke('dashboard:get', () => ({ ok: true, value: dashboard([card({ itemId: 1 })]) }));
    await useDashboardStore.getState().refresh();
    mockInvoke('dashboard:get', () => ({ ok: false, error: { code: 'INTERNAL' } }));
    await useDashboardStore.getState().refresh();
    const s = useDashboardStore.getState();
    expect(s.loadError).toBe('INTERNAL');
    expect(s.lists.needs_reply.items.map((c) => c.itemId)).toEqual([1]);
  });
});

describe('dashboard store - the dirty-card rule (UX 6.3)', () => {
  it('keeps a dirty card at its index and does not replace it with server data', async () => {
    mockInvoke('dashboard:get', () => ({ ok: true, value: dashboard([card({ itemId: 1 }), card({ itemId: 2 })]) }));
    await useDashboardStore.getState().refresh();
    useDashboardStore.getState().markDirty(1, true);

    // main pushes a changed VM for item 1 and a brand-new item 3 at the top
    mockInvoke('dashboard:get', () => ({
      ok: true,
      value: dashboard([
        card({ itemId: 3 }),
        card({ itemId: 1, updatedAt: 999, draft: { text: 'SERVER', lang: 'en', proposalVersion: 2 } }),
        card({ itemId: 2 }),
      ]),
    }));
    await useDashboardStore.getState().refresh();

    const items = useDashboardStore.getState().lists.needs_reply.items;
    const kept = items.find((c) => c.itemId === 1)!;
    expect(kept.draft?.text).toBe(defaultCard.draft?.text); // the OLD view model survived
    expect(items.filter((c) => c.itemId === 1)).toHaveLength(1); // and is not duplicated
    expect(items.map((c) => c.itemId)).toContain(3);
  });

  it('flags a kept card as stale when the server copy changed underneath it', async () => {
    mockInvoke('dashboard:get', () => ({ ok: true, value: dashboard([card({ itemId: 1, updatedAt: 100 })]) }));
    await useDashboardStore.getState().refresh();
    useDashboardStore.getState().markDirty(1, true);

    mockInvoke('dashboard:get', () => ({ ok: true, value: dashboard([card({ itemId: 1, updatedAt: 101 })]) }));
    await useDashboardStore.getState().refresh();
    expect(useDashboardStore.getState().staleItemIds.has(1)).toBe(true);
  });

  it('does not flag a kept card as stale when nothing changed', async () => {
    mockInvoke('dashboard:get', () => ({ ok: true, value: dashboard([card({ itemId: 1, updatedAt: 100 })]) }));
    await useDashboardStore.getState().refresh();
    useDashboardStore.getState().markDirty(1, true);
    await useDashboardStore.getState().refresh();
    expect(useDashboardStore.getState().staleItemIds.has(1)).toBe(false);
  });

  it('flags a kept card as stale when it disappeared from the server lists', async () => {
    mockInvoke('dashboard:get', () => ({ ok: true, value: dashboard([card({ itemId: 1 })]) }));
    await useDashboardStore.getState().refresh();
    useDashboardStore.getState().markDirty(1, true);
    mockInvoke('dashboard:get', () => ({ ok: true, value: dashboard([]) }));
    await useDashboardStore.getState().refresh();
    expect(useDashboardStore.getState().staleItemIds.has(1)).toBe(true);
    expect(useDashboardStore.getState().lists.needs_reply.items.map((c) => c.itemId)).toEqual([1]);
  });

  it('markDirty(false) lets the next refresh replace the card again', async () => {
    mockInvoke('dashboard:get', () => ({ ok: true, value: dashboard([card({ itemId: 1 })]) }));
    await useDashboardStore.getState().refresh();
    useDashboardStore.getState().markDirty(1, true);
    useDashboardStore.getState().markDirty(1, false);
    mockInvoke('dashboard:get', () => ({ ok: true, value: dashboard([card({ itemId: 1, updatedAt: 42 })]) }));
    await useDashboardStore.getState().refresh();
    expect(useDashboardStore.getState().lists.needs_reply.items[0]!.updatedAt).toBe(42);
  });
});

describe('dashboard store - open item', () => {
  it('fetches the detail and clears it again on close', async () => {
    await useDashboardStore.getState().openItemById(1);
    expect(invokeMocks['item:get']).toHaveBeenCalledWith({ itemId: 1 });
    expect(useDashboardStore.getState().openItem?.itemId).toBe(defaultDetail.itemId);
    await useDashboardStore.getState().openItemById(null);
    expect(useDashboardStore.getState().openItemId).toBeNull();
    expect(useDashboardStore.getState().openItem).toBeNull();
  });

  it('ignores a detail that lost the race against a second open', async () => {
    let release!: () => void;
    mockInvoke('item:get', async (req) => {
      if ((req as { itemId: number }).itemId === 1) {
        await new Promise<void>((r) => (release = r));
        return { ok: true, value: { ...structuredClone(defaultDetail), itemId: 1 } };
      }
      return { ok: true, value: { ...structuredClone(defaultDetail), itemId: 2 } };
    });
    const slow = useDashboardStore.getState().openItemById(1);
    await useDashboardStore.getState().openItemById(2);
    release();
    await slow;
    expect(useDashboardStore.getState().openItem?.itemId).toBe(2);
  });

  it('reloadOpenItem skips a dirty card', async () => {
    await useDashboardStore.getState().openItemById(1);
    useDashboardStore.getState().markDirty(1, true);
    invokeMocks['item:get'].mockClear();
    await useDashboardStore.getState().reloadOpenItem();
    expect(invokeMocks['item:get']).not.toHaveBeenCalled();
  });

  it('applyItem only replaces the card that is actually open', () => {
    useDashboardStore.setState({ openItemId: 5, openItem: null });
    useDashboardStore.getState().applyItem({ ...structuredClone(defaultDetail), itemId: 9 });
    expect(useDashboardStore.getState().openItem).toBeNull();
    useDashboardStore.getState().applyItem({ ...structuredClone(defaultDetail), itemId: 5 });
    expect(useDashboardStore.getState().openItem?.itemId).toBe(5);
  });
});

describe('dashboard store - sections, drawer, toast', () => {
  it('starts with "In calendar" closed and toggles one section at a time (UX 6.2)', () => {
    expect(useDashboardStore.getState().sectionOpen).toEqual({
      needs_reply: true,
      in_calendar: false,
      info_missing: true,
    });
    useDashboardStore.getState().toggleSection('in_calendar');
    expect(useDashboardStore.getState().sectionOpen.in_calendar).toBe(true);
    expect(useDashboardStore.getState().sectionOpen.needs_reply).toBe(true);
  });

  it('exposes the drawer and toast setters the shell needs', () => {
    useDashboardStore.getState().setUndoDrawerOpen(true);
    expect(useDashboardStore.getState().undoDrawerOpen).toBe(true);
    useDashboardStore.getState().setToast({ key: 'action.dismissed', itemId: 3 });
    expect(useDashboardStore.getState().toast).toEqual({ key: 'action.dismissed', itemId: 3 });
  });

  it('LIST_KEYS is the fixed rendering order of UX 6.1', () => {
    expect(LIST_KEYS).toEqual(['needs_reply', 'in_calendar', 'info_missing']);
  });
});

// [repair ux-i18n-9] UX 2.4's arrival edge needs the ids from the `dashboard:changed` payload to survive until the
// refreshed cards render; the store used to drop them (App read only `itemIds.length` for the polite announcement).
describe('arrived ids (UX 2.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useDashboardStore.setState({ arrivedItemIds: new Set() });
  });
  afterEach(() => vi.useRealTimers());

  it('remembers the ids of the last change and forgets them once the edge has faded', () => {
    useDashboardStore.getState().noteArrived([4, 7]);
    expect([...useDashboardStore.getState().arrivedItemIds].sort()).toEqual([4, 7]);

    vi.advanceTimersByTime(ARRIVAL_MS - 1);
    expect(useDashboardStore.getState().arrivedItemIds.size).toBe(2);
    vi.advanceTimersByTime(2);
    expect(useDashboardStore.getState().arrivedItemIds.size).toBe(0);
  });

  it('a second change extends the set and restarts the one timer', () => {
    useDashboardStore.getState().noteArrived([1]);
    vi.advanceTimersByTime(ARRIVAL_MS - 10);
    useDashboardStore.getState().noteArrived([2]);
    vi.advanceTimersByTime(20);
    // The first id must still be lit: its own edge was not yet due when the second change arrived.
    expect([...useDashboardStore.getState().arrivedItemIds].sort()).toEqual([1, 2]);
    vi.advanceTimersByTime(ARRIVAL_MS);
    expect(useDashboardStore.getState().arrivedItemIds.size).toBe(0);
  });

  it('an empty payload changes nothing and arms no timer', () => {
    useDashboardStore.getState().noteArrived([]);
    expect(useDashboardStore.getState().arrivedItemIds.size).toBe(0);
  });
});
