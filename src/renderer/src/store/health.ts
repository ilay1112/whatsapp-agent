// src/renderer/src/store/health.ts - AppHealth, model download progress, setup-strip dismissals and the global focus
// guard (UX 5.2-5.4, 14.3; build-plan W1-14 brief; owner W1-14, v2: V2-W1-12).
// [V2] + the downloader QUEUE by file id (UX2 2.1: llm / voice / mmproj, one pill, "+N"), the `queue:changed` push
// (UX2 2.5 header line "Transcribing a voice note (0:42)..." - read by the dashboard) and the v2 setup rows (UX2 2.3).
import { create } from 'zustand';
import { LIMITS } from '@shared/types';
import type { AppHealth } from '@shared/health';
import type { DownloadProgress, ModelFileId } from '@shared/types';
import type { IpcEventMap } from '@shared/ipc';

/** UX 5.4 rows 1-3 + UX2 2.3 rows 4-9 (ids = the `setup-strip-<id>` test ids of UX2 13). */
export const SETUP_TASKS = [
  'whatsapp',
  'ai',
  'calendar',
  'consent_v2',
  'auto_paused',
  'auto_trial',
  'auto_expiring',
  'voice_download',
  'auto_expired',
] as const;
export type SetupTask = (typeof SETUP_TASKS)[number];
/** Rows the user may hide for this session (v1: calendar; UX2 2.3: rows 5-9). The fact stays in the status panel. */
export const HIDEABLE_SETUP_TASKS = [
  'calendar',
  'auto_paused',
  'auto_trial',
  'auto_expiring',
  'voice_download',
  'auto_expired',
] as const satisfies readonly SetupTask[];
export type HideableSetupTask = (typeof HIDEABLE_SETUP_TASKS)[number];

/** States in which a file still belongs to the downloader queue shown by the DownloadPill. */
const QUEUED_STATUSES: readonly DownloadProgress['status'][] = ['downloading', 'paused', 'verifying', 'failed'];

export interface HealthStore {
  health: AppHealth | null;
  /** The most recent `model:progress` event (any file). */
  progress: DownloadProgress | null;
  /** [V2] Every file currently in the downloader queue, by id, in arrival order (main fixes the order; never re-sorted). */
  downloads: Partial<Record<ModelFileId, DownloadProgress>>;
  /** [V2] `queue:changed` (C2 8): pending / running and the whisper job's audio length. */
  queue: IpcEventMap['queue:changed'] | null;
  /** Setup rows the user dismissed with "Hide". Renderer memory only - the fact stays visible in the status panel. */
  hiddenSetupTasks: SetupTask[];
  setHealth(h: AppHealth): void;
  setProgress(p: DownloadProgress | null): void;
  setQueue(q: IpcEventMap['queue:changed'] | null): void;
  hideSetupTask(task: HideableSetupTask): void;
}

export const useHealthStore = create<HealthStore>((set, get) => ({
  health: null,
  progress: null,
  downloads: {},
  queue: null,
  hiddenSetupTasks: [],
  setHealth: (health) => set({ health }),
  setProgress: (progress) => {
    if (!progress) {
      set({ progress: null });
      return;
    }
    const { [progress.tier]: _previous, ...rest } = get().downloads;
    const downloads = QUEUED_STATUSES.includes(progress.status)
      ? { ...get().downloads, [progress.tier]: progress }
      : rest;
    set({ progress, downloads });
  },
  setQueue: (queue) => set({ queue }),
  hideSetupTask: (task) =>
    set({
      hiddenSetupTasks: get().hiddenSetupTasks.includes(task)
        ? get().hiddenSetupTasks
        : [...get().hiddenSetupTasks, task],
    }),
}));

// ---------------------------------------------------------------------------------------------------------------------
// [R2] focus guard - the renderer half of the approve focus-steal protection (ARCH 13, UX 6.8, LIMITS.focusGuardRendererMs).
//
// Every approval button (W1-15) MUST ignore click / Enter / Space while `isActivationBlocked()` is true, i.e. for 500 ms
// after the window gained focus or became visible. Main enforces its own 300 ms guard for notification-opened windows
// (LIMITS.focusGuardMainMs) - the two are independent on purpose. It lives in this store rather than in App.tsx so that
// components can import it without a cycle through App.
// ---------------------------------------------------------------------------------------------------------------------
export interface FocusGuardStore {
  /** Epoch ms until which activation of an approval control must be ignored. */
  activationBlockedUntil: number;
  noteActivation(at: number): void;
}

export const useFocusGuardStore = create<FocusGuardStore>((set) => ({
  activationBlockedUntil: 0,
  noteActivation: (at) => set({ activationBlockedUntil: at + LIMITS.focusGuardRendererMs }),
}));

/** Read at CLICK time (not at render time): a stale render must never unblock an approval. */
export function isActivationBlocked(now: number = Date.now()): boolean {
  return now < useFocusGuardStore.getState().activationBlockedUntil;
}

/** Attaches the window listeners; returns the disposer. Called once by App.tsx. */
export function installFocusGuard(target: Window = window): () => void {
  const onFocus = (): void => useFocusGuardStore.getState().noteActivation(Date.now());
  const onVisibility = (): void => {
    if (!target.document.hidden) useFocusGuardStore.getState().noteActivation(Date.now());
  };
  target.addEventListener('focus', onFocus);
  target.document.addEventListener('visibilitychange', onVisibility);
  return () => {
    target.removeEventListener('focus', onFocus);
    target.document.removeEventListener('visibilitychange', onVisibility);
  };
}
