// src/renderer/src/store/dashboard.ts - dashboard lists, open item, drawer, toast (UX 14.3; owner W1-15).
//
// Refresh rule (UX 6.3 / 14.3): on `dashboard:changed` the store refetches `dashboard:get` and REPLACES every list,
// except the cards in `dirtyItemIds` (an input has focus or the user changed the text). Those keep their old view model
// at their old index and are flagged in `staleItemIds`, which makes the card show "This card changed - review again"
// with a "Refresh card" button once the user leaves the inputs.
//
// [V2] (owner V2-W1-11) The dirty-card rule covers delta (Change) cards too - an edited `to` is never overwritten by a
// refresh (UX2 12). `queue:changed` feeds the "Transcribing a voice note (0:42)..." line (UX2 2.5). `navRequest` is how
// a dashboard control asks the shell (App.tsx, V2-W1-12) to open another view: the AutoStrip "Show all in Automatic
// activity" link and the "Turn on in Settings" / "Choose an AI" actions of the voice / picture raw cards.
import { create } from 'zustand';
import type { ItemCard, ItemDetail, ItemId } from '@shared/types';
import type { ErrorCode } from '@shared/errors';
import { api } from '../api';

export type ListKey = 'needs_reply' | 'in_calendar' | 'info_missing';
export const LIST_KEYS: readonly ListKey[] = ['needs_reply', 'in_calendar', 'info_missing'];

/**
 * How long an id stays in `arrivedItemIds` (UX 2.4: the 3 px inline-start edge fades over 1.6 s). The class is dropped
 * afterwards rather than left on the card: `card-arrival` animates `forwards`, so a permanent class would leave a
 * transparent 3 px border behind and push that one card out of line with its column.
 */
export const ARRIVAL_MS = 1_700;

/** [V2] The `queue:changed` payload (C2 8): numbers only, never a chat name or text. */
export interface QueueState {
  pending: number;
  running: number;
  transcribing: { seconds: number } | null;
}
/**
 * [V2] A view a control asks the shell to open. `section` is a Settings group id (e.g. 'ai'); `view: 'dashboard'` with an
 * `itemId` is the Automatic activity page's "Show" (back to the dashboard with that item open).
 */
export type NavRequest =
  | { view: 'activity' | 'settings'; section?: 'ai' | 'voice' | 'pictures' | 'auto' }
  | { view: 'dashboard'; itemId: ItemId };

export interface DashboardStore {
  lists: Record<ListKey, { items: ItemCard[]; count: number }>;
  analysing: number;
  ignoredCount: number;
  /** True once a `dashboard:get` round trip was started; the first paint shows skeletons until then (UX 11.1). */
  hydrated: boolean;
  loadError: ErrorCode | null;
  openItemId: ItemId | null;
  openItem: ItemDetail | null;
  sectionOpen: Record<ListKey, boolean>;
  undoDrawerOpen: boolean;
  /** `onUndo` [V2]: the toast's Undo runs it instead of `item:restore` (e.g. "Never automatic" -> inherit again). */
  toast: { key: string; itemId?: ItemId; onUndo?: () => void } | null;
  /** [V2] Last `queue:changed` payload; null until the first one arrives. */
  queue: QueueState | null;
  setQueue(q: QueueState | null): void;
  /** [V2] Pending navigation request for the shell; the shell clears it once handled. */
  navRequest: NavRequest | null;
  requestNavigation(req: NavRequest): void;
  clearNavRequest(): void;
  dirtyItemIds: Set<ItemId>;
  staleItemIds: Set<ItemId>;
  /** UX 2.4: ids that arrived or changed while the window was visible; the cards wear the fading edge while listed. */
  arrivedItemIds: Set<ItemId>;
  /** Records the `dashboard:changed` payload and clears it again once the edge has finished fading. */
  noteArrived(itemIds: readonly ItemId[]): void;
  refresh(): Promise<void>;
  openItemById(itemId: ItemId | null): Promise<void>;
  /** Re-fetches the open card unless it is dirty (the user is editing it). */
  reloadOpenItem(): Promise<void>;
  /** Replaces the open card with a detail main just returned (approve / dismiss / restore answers). */
  applyItem(item: ItemDetail): void;
  markDirty(itemId: ItemId, dirty: boolean): void;
  markStale(itemId: ItemId, stale: boolean): void;
  toggleSection(list: ListKey): void;
  setUndoDrawerOpen(open: boolean): void;
  setToast(t: DashboardStore['toast']): void;
}

const emptyLists = (): DashboardStore['lists'] => ({
  needs_reply: { items: [], count: 0 },
  in_calendar: { items: [], count: 0 },
  info_missing: { items: [], count: 0 },
});

/**
 * Keeps the dirty cards of `old` at their old index and fills the rest of the column with `fresh`.
 * `pinned` holds every dirty item id of EVERY list, so a card that moved to another list is not shown twice.
 */
function mergeColumn(
  old: ItemCard[],
  fresh: ItemCard[],
  dirty: ReadonlySet<ItemId>,
  pinned: ReadonlySet<ItemId>,
): ItemCard[] {
  if (dirty.size === 0) return fresh;
  const result = fresh.filter((c) => !pinned.has(c.itemId));
  old.forEach((c, index) => {
    if (!dirty.has(c.itemId)) return;
    result.splice(Math.min(index, result.length), 0, c);
  });
  return result;
}

let arrivalTimer: ReturnType<typeof setTimeout> | undefined;

export const useDashboardStore = create<DashboardStore>((set, get) => ({
  lists: emptyLists(),
  analysing: 0,
  ignoredCount: 0,
  hydrated: false,
  loadError: null,
  openItemId: null,
  openItem: null,
  sectionOpen: { needs_reply: true, in_calendar: false, info_missing: true },
  undoDrawerOpen: false,
  toast: null,
  queue: null,
  navRequest: null,
  dirtyItemIds: new Set(),
  staleItemIds: new Set(),
  arrivedItemIds: new Set(),

  noteArrived: (itemIds) => {
    if (itemIds.length === 0) return;
    const next = new Set(get().arrivedItemIds);
    for (const id of itemIds) next.add(id);
    set({ arrivedItemIds: next });
    // ONE timer, restarted by the next change: a burst of arrivals fades together rather than leaving each card to
    // schedule its own clear, and nothing here can grow unbounded.
    clearTimeout(arrivalTimer);
    arrivalTimer = setTimeout(() => set({ arrivedItemIds: new Set() }), ARRIVAL_MS);
  },

  refresh: async () => {
    set({ hydrated: true });
    const r = await api.getDashboard();
    if (!r.ok) {
      set({ loadError: r.error.code });
      return;
    }
    const d = r.value;
    const { dirtyItemIds: dirty, lists: current, staleItemIds } = get();
    const fresh: Record<ListKey, ItemCard[]> = {
      needs_reply: d.needsReply,
      in_calendar: d.inCalendar,
      info_missing: d.infoMissing,
    };
    const counts: Record<ListKey, number> = {
      needs_reply: d.counts.needsReply,
      in_calendar: d.counts.inCalendar,
      info_missing: d.counts.infoMissing,
    };

    const pinned = new Set<ItemId>();
    for (const key of LIST_KEYS) for (const c of current[key].items) if (dirty.has(c.itemId)) pinned.add(c.itemId);

    const nextStale = new Set(staleItemIds);
    const everyFresh = [...d.needsReply, ...d.inCalendar, ...d.infoMissing];
    for (const id of pinned) {
      const kept = LIST_KEYS.flatMap((k) => current[k].items).find((c) => c.itemId === id);
      const now = everyFresh.find((c) => c.itemId === id);
      if (!kept) continue;
      if (!now || now.updatedAt !== kept.updatedAt) nextStale.add(id);
    }

    const lists = emptyLists();
    for (const key of LIST_KEYS) {
      lists[key] = { items: mergeColumn(current[key].items, fresh[key], dirty, pinned), count: counts[key] };
    }
    set({ lists, analysing: d.analysing, ignoredCount: d.counts.ignored, loadError: null, staleItemIds: nextStale });
  },

  openItemById: async (itemId) => {
    if (itemId === null) {
      set({ openItemId: null, openItem: null });
      return;
    }
    set({ openItemId: itemId, openItem: null });
    const r = await api.getItem(itemId);
    // A second open may have won the race while this request was in flight.
    if (get().openItemId !== itemId) return;
    set({ openItem: r.ok ? r.value : null });
  },

  reloadOpenItem: async () => {
    const { openItemId, dirtyItemIds } = get();
    if (openItemId === null || dirtyItemIds.has(openItemId)) return;
    const r = await api.getItem(openItemId);
    if (get().openItemId !== openItemId) return;
    if (r.ok) set({ openItem: r.value });
  },

  applyItem: (item) => {
    if (get().openItemId === item.itemId) set({ openItem: item });
  },

  markDirty: (itemId, dirty) => {
    const next = new Set(get().dirtyItemIds);
    if (dirty) next.add(itemId);
    else next.delete(itemId);
    set({ dirtyItemIds: next });
  },

  markStale: (itemId, stale) => {
    const next = new Set(get().staleItemIds);
    if (stale) next.add(itemId);
    else next.delete(itemId);
    set({ staleItemIds: next });
  },

  toggleSection: (list) => set({ sectionOpen: { ...get().sectionOpen, [list]: !get().sectionOpen[list] } }),
  setUndoDrawerOpen: (undoDrawerOpen) => set({ undoDrawerOpen }),
  setToast: (toast) => set({ toast }),
  setQueue: (queue) => set({ queue }),
  requestNavigation: (navRequest) => set({ navRequest }),
  clearNavRequest: () => set({ navRequest: null }),
}));
