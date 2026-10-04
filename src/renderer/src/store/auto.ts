// src/renderer/src/store/auto.ts - automatic-mode state + AutoStrip rows (UX2 3.1, 12 "Stores"; B11; owner V2-W1-11).
//
// Hydrated by `auto:getState` + `auto:listWrites {sinceTs: now - 7 d}`, refreshed on `auto:changed` (which carries the
// new AutoState; the rows are re-fetched because the event carries no rows). The store never changes automatic mode:
// it can only read, pause (fail-safe, no dialog) and undo one write through the single undo path (`auto:undo`).
// `undo()` is called from the AutoStrip's click handler only - never from an effect, a timer or a push event.
import { create } from 'zustand';
import type { AutoState, AutoWriteView } from '@shared/types';
import { api, events } from '../api';

/** AutoStrip window (B11: "last 7 days"). */
export const STRIP_WINDOW_MS = 7 * 86_400_000;
/** A row written in the last 24 h stays visible even when not undoable any more (so "Undone" can be seen, UX2 3.1). */
export const STRIP_RECENT_MS = 86_400_000;

/** Live = a policy row whose state still decides (UX2 3.2: shadow | on | paused). */
export function policyLive(state: AutoState | null): boolean {
  const s = state?.policy?.state;
  return s === 'shadow' || s === 'on' || s === 'paused';
}

/** The rows the AutoStrip shows: undo still available, or written in the last 24 h (UX2 3.1). Newest first. */
export function stripRows(rows: readonly AutoWriteView[], nowMs: number): AutoWriteView[] {
  return rows
    .filter((r) => r.undoState === 'available' || nowMs - r.writtenAt < STRIP_RECENT_MS)
    .sort((a, b) => b.writtenAt - a.writtenAt);
}

export interface AutoStore {
  state: AutoState | null;
  rows: AutoWriteView[];
  /** When the rows were last read (relative times and the 24 h rule are measured from it; 0 = never). */
  fetchedAt: number;
  /** autoWriteIds with an `auto:undo` in flight ("Undoing..."). */
  undoing: ReadonlySet<string>;
  /** autoWriteIds whose last undo click failed in this window (the row offers "Try again"). */
  failed: ReadonlySet<string>;
  setState(state: AutoState | null): void;
  setRows(rows: AutoWriteView[]): void;
  /** auto:getState + auto:listWrites. Rejects nothing: a failed read keeps the previous values (fail closed: no strip). */
  hydrate(): Promise<void>;
  /** Re-reads the strip rows only. */
  refreshRows(): Promise<void>;
  /** One AutoStrip Undo click -> exactly one `auto:undo`; a second click while in flight sends nothing. */
  undo(autoWriteId: string): Promise<boolean>;
  /** `auto:pause` (fail-safe direction: no dialog, no focus gate). */
  pause(): Promise<void>;
  /** Subscribes to `auto:changed`; returns the unsubscribe function. */
  subscribe(): () => void;
}

export const useAutoStore = create<AutoStore>((set, get) => ({
  state: null,
  rows: [],
  fetchedAt: 0,
  undoing: new Set(),
  failed: new Set(),
  setState: (state) => set({ state }),
  setRows: (rows) => set({ rows }),

  hydrate: async () => {
    const [s] = await Promise.all([api.getAutoState(), get().refreshRows()]);
    if (s.ok) set({ state: s.value });
  },

  refreshRows: async () => {
    const r = await api.listAutoWrites(Date.now() - STRIP_WINDOW_MS);
    if (r.ok) set({ rows: r.value.writes, fetchedAt: Date.now() });
  },

  undo: async (autoWriteId) => {
    if (get().undoing.has(autoWriteId)) return false;
    const undoing = new Set(get().undoing);
    undoing.add(autoWriteId);
    const failed = new Set(get().failed);
    failed.delete(autoWriteId);
    set({ undoing, failed });
    let ok: boolean;
    try {
      const r = await api.undoAuto(autoWriteId);
      ok = r.ok && r.value.outcome === 'done';
    } catch {
      ok = false;
    }
    const nextUndoing = new Set(get().undoing);
    nextUndoing.delete(autoWriteId);
    const nextFailed = new Set(get().failed);
    if (!ok) nextFailed.add(autoWriteId);
    set({ undoing: nextUndoing, failed: nextFailed });
    await get().refreshRows();
    return ok;
  },

  pause: async () => {
    const r = await api.pauseAuto();
    if (r.ok) set({ state: r.value });
  },

  subscribe: () =>
    events.onAutoChanged((state) => {
      set({ state });
      void get().refreshRows();
    }),
}));
