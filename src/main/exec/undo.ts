// src/main/exec/undo.ts   ADD (v2-build-plan section 3 seam; B10, F1, F32) - owner V2-W1-04-exec-auto. Safety-critical (T2 13).
// The one Undo door for manual and automatic changes; every path ends in the executor's approve() gates (never a side door): the
// candidate / window / baseline pre-checks, the new proposal version, the pending update_event and its approval all live in
// ActionExecutorV2 (one implementation for item:undoChange, auto:undo, the toast, Restore original and Cancel event).
import type { ItemId, Result } from '../../shared/types';
import type { ApproveOutcome, IpcContext } from '../../shared/ipc';
import type { Repos } from '../db/index';
import type { Clock } from '../deps';
import type { ActionExecutorV2 } from './actionExecutor';

/** [W0 refinement] the seam names `UndoOutcome` without a shape: the undo is approved through the normal executor, so it is the executor's
 *  ApproveOutcome (C2 8: 'item:undoChange' / 'auto:undo' / 'item:restoreOriginal' / 'item:cancelEvent' all answer ApproveOutcome). */
export type UndoOutcome = ApproveOutcome;
export interface Undo {
  undoChange(itemId: ItemId, revisionId: number, by: 'user' | 'user_toast'): Promise<Result<UndoOutcome>>;
  undoAuto(autoWriteId: string, by: 'user' | 'user_toast'): Promise<Result<UndoOutcome>>;
  /** [F1] */
  restoreOriginal(itemId: ItemId): Promise<Result<UndoOutcome>>;
  /** [F32] */
  cancelEvent(itemId: ItemId): Promise<Result<UndoOutcome>>;
}

/** What the executor's click-path gates see for a user door: the window state sampled NOW (register.ts already refused an unfocused /
 *  hidden window and the focus-steal guard for FOCUS_GATED_CHANNELS; the executor re-applies the guard with this context). */
const NO_WINDOW_STATE: IpcContext = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };

export function createUndo(deps: {
  repos: Repos;
  executor: Pick<ActionExecutorV2, 'undoChange' | 'undoAuto' | 'restoreOriginal' | 'cancelEvent'>;
  clock: Clock;
  audit: (
    kind: import('../../shared/types').AuditKind,
    ref: string | null,
    detail: Record<string, string | number | boolean | null>,
  ) => void;
  /** [V2-W1-04 addition, optional] the window state of the calling IPC request (`RegisterIpcOptions.windowState`); absent => the
   *  focus-steal guard was already applied by register.ts and the executor sees no notification timestamp. */
  windowState?: () => IpcContext;
}): Undo {
  const ctxFor = (by: 'user' | 'user_toast'): IpcContext | null =>
    by === 'user_toast' ? null : (deps.windowState?.() ?? NO_WINDOW_STATE);
  /** A thrown collaborator must never look like a finished undo: INTERNAL, audited with enums only. */
  const guarded = async (
    door: string,
    ref: string | null,
    run: () => Promise<Result<UndoOutcome>>,
  ): Promise<Result<UndoOutcome>> => {
    try {
      return await run();
    } catch {
      deps.audit('db_recovery', ref, { stage: 'undo', door });
      return { ok: false, error: { code: 'INTERNAL' } };
    }
  };
  return {
    undoChange: (itemId, revisionId, by) =>
      guarded('undoChange', String(itemId), () => deps.executor.undoChange(itemId, revisionId, by, ctxFor(by))),
    undoAuto: (autoWriteId, by) =>
      guarded('undoAuto', autoWriteId, () => deps.executor.undoAuto(autoWriteId, by, ctxFor(by))),
    restoreOriginal: (itemId) =>
      guarded('restoreOriginal', String(itemId), () => deps.executor.restoreOriginal(itemId, ctxFor('user')!)),
    cancelEvent: (itemId) =>
      guarded('cancelEvent', String(itemId), () => deps.executor.cancelEvent(itemId, ctxFor('user')!)),
  };
}
