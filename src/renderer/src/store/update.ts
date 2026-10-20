// src/renderer/src/store/update.ts - [v5] T-909 W3: the in-app update state (spec v5-updates-handover 2.3).
//
// A mirror of main's UpdateState: hydrated by `update:getState`, replaced by every `update:changed` push and by the answer of
// each `update:*` action. Main owns every decision (what is newer, what is ignored, whether this copy can install); the store
// adds exactly one renderer-only fact: `bannerHidden`, the banner X during a download / ready, which hides the banner until
// the next launch and is NOT an ignore (only `update:ignore` persists anything, and only for one version).
// `install()` is called from a click handler only (never an effect, a timer or a push) - main focus-gates it again.
import { create } from 'zustand';
import type { ErrorCode } from '@shared/errors';
import type { UpdateState } from '@shared/types';
import { semverCompare } from '@shared/update';
import { api, events } from '../api';

export type BannerMode = 'available' | 'downloading' | 'ready';

/** What the banner shows (null = no banner). Errors never show one; the session hide applies to download / ready only. */
export function bannerModeOf(state: UpdateState | null, hiddenThisRun: boolean): BannerMode | null {
  if (state === null) return null;
  if (state.status === 'available') {
    return state.latest !== null && state.latest !== state.ignoredVersion ? 'available' : null;
  }
  if (state.status === 'downloading' || state.status === 'ready') return hiddenThisRun ? null : state.status;
  return null;
}

/** Whole percent of the running download, 0..100 (0 while the total is unknown). */
export function downloadPercent(state: UpdateState | null): number {
  const p = state?.progress;
  if (!p || p.bytesTotal <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((p.bytesDone / p.bytesTotal) * 100)));
}

/** A release newer than the running build is known. */
export function hasNewer(state: UpdateState | null): boolean {
  return state !== null && state.latest !== null && semverCompare(state.latest, state.current) > 0;
}

/** Settings > Updates main button: 'download' (Download and install), 'downloading' (busy), 'restart' (Restart to finish). */
export function installLabelOf(state: UpdateState | null): 'download' | 'downloading' | 'restart' | null {
  if (state === null) return null;
  switch (state.status) {
    case 'available':
    case 'error':
      return hasNewer(state) ? 'download' : null;
    case 'downloading':
      return 'downloading';
    case 'ready':
    case 'installing':
      return 'restart';
    default:
      return null;
  }
}

type Busy = 'check' | 'download' | 'install' | 'ignore' | 'unignore';

export interface UpdateStore {
  state: UpdateState | null;
  /** The banner X during downloading / ready: hidden until the app restarts (renderer memory only). */
  bannerHidden: boolean;
  /** The action in flight; a second click while one runs sends nothing. */
  busy: Busy | null;
  /** The last REFUSED action's code (BAD_REQUEST / INTERNAL / FOCUS_GUARD...); cleared by the next accepted one. */
  actionError: ErrorCode | null;
  /** The one-time "Updated to version X" / "could not be installed" toast was shown in this window. */
  installNoticeShown: boolean;
  apply(state: UpdateState): void;
  hydrate(): Promise<void>;
  /** Subscribes to `update:changed`; returns the unsubscribe function. */
  subscribe(): () => void;
  check(): Promise<void>;
  download(): Promise<void>;
  /** Refused locally (no IPC) unless the state is ready && canInstall. */
  install(): Promise<void>;
  ignore(version: string): Promise<void>;
  unignore(): Promise<void>;
  hideBanner(): void;
  markInstallNoticeShown(): void;
}

/** "Newest wins" for hydrate: a push that landed while the read was in flight is at least as new as the read. */
let pushSeq = 0;

export const useUpdateStore = create<UpdateStore>((set, get) => {
  const run = async (busy: Busy, call: () => ReturnType<typeof api.getUpdateState>): Promise<void> => {
    if (get().busy !== null) return;
    set({ busy });
    try {
      const r = await call();
      if (r.ok) set({ state: r.value, actionError: null });
      else set({ actionError: r.error.code });
    } catch {
      set({ actionError: 'INTERNAL' });
    } finally {
      set({ busy: null });
    }
  };

  return {
    state: null,
    bannerHidden: false,
    busy: null,
    actionError: null,
    installNoticeShown: false,
    apply: (state) => set({ state }),

    hydrate: async () => {
      const before = pushSeq;
      try {
        const r = await api.getUpdateState();
        if (r.ok && before === pushSeq) set({ state: r.value });
      } catch {
        // no state = no banner and an empty Settings group; the next push fills it
      }
    },

    subscribe: () =>
      events.onUpdateChanged((state) => {
        pushSeq += 1;
        set({ state });
      }),

    check: () => run('check', api.checkUpdate),
    download: () => run('download', api.downloadUpdate),
    install: async () => {
      const s = get().state;
      if (s === null || s.status !== 'ready' || !s.canInstall) return;
      await run('install', api.installUpdate);
    },
    ignore: (version) => run('ignore', () => api.ignoreUpdate(version)),
    unignore: () => run('unignore', api.unignoreUpdate),
    hideBanner: () => set({ bannerHidden: true }),
    markInstallNoticeShown: () => set({ installNoticeShown: true }),
  };
});
