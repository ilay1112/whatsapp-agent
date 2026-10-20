// src/main/ipc/handlers/actions.ts - handlers for the channels below (build-plan section 3; owner W1-11). Bodies return Result<T>, never throw.
// Safety-critical: this is the ONLY caller of ActionExecutor.approve in production. The trusted-sender frame check and the zod
// `.strict()` parse happen one layer up in ipc/register.ts; what is left here is the window gate (ARCH 6.6 step 1) and the
// ItemDetail that the renderer re-renders the card from.
import type { IpcHandlers } from '../../../shared/ipc';
import type { ItemDetail, ItemId, Result } from '../../../shared/types';
import type { HandlerDeps } from '../register';

export type ActionsChannels = 'action:approve' | 'action:reject';

export function createActionsHandlers(deps: HandlerDeps): Pick<IpcHandlers, ActionsChannels> {
  /** `ItemService.detail` is the single builder of the view model; a failure there must not lose an outcome that already happened. */
  const detailOr = (itemId: ItemId, fallback: ItemDetail): ItemDetail => {
    try {
      const res = deps.items.detail(itemId);
      return res.ok ? res.value : fallback;
    } catch {
      deps.log.warn('action_detail_failed', { itemId });
      return fallback;
    }
  };

  return {
    'action:approve': async (req, ctx) => {
      // No approval from a hidden or unfocused window - the click must have happened on a card the user was looking at.
      if (!ctx.windowVisible || !ctx.windowFocused) {
        deps.audit('ipc_rejected', null, { channel: 'action:approve', reason: 'window_not_focused' }, deps.clock.now());
        return { ok: false, error: { code: 'WINDOW_NOT_FOCUSED' } };
      }
      const res = await deps.executor.approve(req, ctx);
      if (!res.ok) return res;
      // [v4 T6] a manual (calendar-view) action has no item: its outcome already says everything (ManualOutcomeView)
      if (res.value.item === null) return res;
      const action = deps.repos.actions.byId(req.actionId);
      if (action === null) return res;
      return { ok: true, value: { ...res.value, item: detailOr(action.itemId, res.value.item) } };
    },

    'action:reject': async (req): Promise<Result<ItemDetail | null>> => {
      const action = deps.repos.actions.byId(req.actionId);
      // [v4 review fix] a manual (calendar-view) proposal has no item: Cancel on cal-confirm rejects it, the answer is null
      const manual = action === null && deps.repos.actions.manualById(req.actionId) !== null;
      const res = await deps.executor.reject(req.actionId);
      if (!res.ok) return res;
      if (manual) return { ok: true, value: null };
      if (action === null) return { ok: false, error: { code: 'NOT_FOUND' } };
      return deps.items.detail(action.itemId);
    },
  };
}
