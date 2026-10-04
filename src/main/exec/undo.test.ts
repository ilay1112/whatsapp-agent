// src/main/exec/undo.test.ts - T2 5 row exec/undo.ts: the Undo facade is a thin door onto the executor's single undo path (B10).
// 'user' doors carry the sampled window state (or the "already gated" context), the toast carries none; a throwing executor is
// INTERNAL (audited with enums only), never a pretended success.
import { describe, expect, it, vi } from 'vitest';
import { createUndo } from './undo';
import { createVirtualClock } from '../../../tests/helpers/virtualClock';
import type { ActionExecutorV2 } from './actionExecutor';
import type { ApproveOutcome, IpcContext } from '../../shared/ipc';
import type { ItemId, Result } from '../../shared/types';
import type { Repos } from '../db/index';

const DONE: Result<ApproveOutcome> = { ok: true, value: { outcome: 'done', item: {} as never } };

function make(windowState?: () => IpcContext) {
  const executor = {
    undoChange: vi.fn(async () => DONE),
    undoAuto: vi.fn(async () => DONE),
    restoreOriginal: vi.fn(async () => DONE),
    cancelEvent: vi.fn(async () => DONE),
  } satisfies Pick<ActionExecutorV2, 'undoChange' | 'undoAuto' | 'restoreOriginal' | 'cancelEvent'>;
  const audits: Array<{ kind: string; ref: string | null; detail: unknown }> = [];
  const undo = createUndo({
    repos: {} as Repos,
    executor,
    clock: createVirtualClock(0),
    audit: (kind, ref, detail) => void audits.push({ kind, ref, detail }),
    ...(windowState ? { windowState } : {}),
  });
  return { undo, executor, audits };
}

describe('createUndo', () => {
  it('user doors pass a window context; the toast door passes none', async () => {
    const { undo, executor } = make();
    await undo.undoChange(4 as ItemId, 9, 'user');
    await undo.undoChange(4 as ItemId, 9, 'user_toast');
    await undo.undoAuto('w-1', 'user');
    await undo.undoAuto('w-1', 'user_toast');
    await undo.restoreOriginal(4 as ItemId);
    await undo.cancelEvent(4 as ItemId);
    const gated = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };
    expect(executor.undoChange.mock.calls).toEqual([
      [4, 9, 'user', gated],
      [4, 9, 'user_toast', null],
    ]);
    expect(executor.undoAuto.mock.calls).toEqual([
      ['w-1', 'user', gated],
      ['w-1', 'user_toast', null],
    ]);
    expect(executor.restoreOriginal.mock.calls).toEqual([[4, gated]]);
    expect(executor.cancelEvent.mock.calls).toEqual([[4, gated]]);
  });
  it('with windowState wired, the sampled context (incl. shownByNotificationAt) reaches the executor', async () => {
    const ctx = { windowFocused: true, windowVisible: true, shownByNotificationAt: 123 };
    const { undo, executor } = make(() => ctx);
    await undo.cancelEvent(1 as ItemId);
    expect(executor.cancelEvent).toHaveBeenCalledWith(1, ctx);
  });
  it('the executor result is returned unchanged', async () => {
    const { undo } = make();
    expect(await undo.restoreOriginal(2 as ItemId)).toBe(DONE);
  });
  it('a throwing executor => INTERNAL + a db_recovery audit with enums only', async () => {
    const { undo, executor, audits } = make();
    executor.undoAuto.mockRejectedValueOnce(new Error('boom SECRET'));
    expect(await undo.undoAuto('w-2', 'user')).toEqual({ ok: false, error: { code: 'INTERNAL' } });
    expect(audits).toEqual([{ kind: 'db_recovery', ref: 'w-2', detail: { stage: 'undo', door: 'undoAuto' } }]);
    expect(JSON.stringify(audits)).not.toContain('SECRET');
  });
});
