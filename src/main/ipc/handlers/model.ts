// src/main/ipc/handlers/model.ts - handlers for the channels below (build-plan section 3; owner W1-13). Bodies return Result<T>, never throw.
// Every request carries a TIER FROM AN ENUM, never a URL or a path: the download source is the compile-time manifest (W1-07).
import type { ModelTier } from '../../../shared/types';
import type { IpcHandlers } from '../../../shared/ipc';
import { ok, type HandlerDeps } from '../register';

export type ModelChannels =
  | 'model:getPlan'
  | 'model:startDownload'
  | 'model:pause'
  | 'model:resume'
  | 'model:cancel'
  | 'model:delete'
  | 'model:selfTest';

export function createModelHandlers(deps: HandlerDeps): Pick<IpcHandlers, ModelChannels> {
  /** An omitted tier means "the tier in use": the setting when it names one, otherwise the tier the plan picked for this machine. */
  const resolveTier = async (tier?: ModelTier): Promise<ModelTier> => {
    if (tier !== undefined) return tier;
    const setting = deps.settings.get().llm.local.tier;
    return setting === 'auto' ? (await deps.modelManager.plan()).selectedTier : setting;
  };

  return {
    'model:getPlan': async () => ok(await deps.modelManager.plan()),
    'model:startDownload': async (req) => ok(await deps.modelManager.start(await resolveTier(req.tier))),
    'model:pause': async (req) => ok(await deps.modelManager.pause(await resolveTier(req.tier))),
    'model:resume': async (req) => ok(await deps.modelManager.resume(await resolveTier(req.tier))),
    'model:cancel': async (req) => ok(await deps.modelManager.cancel(await resolveTier(req.tier))),
    'model:delete': async (req) => ok(await deps.modelManager.delete(await resolveTier(req.tier))),
    'model:selfTest': async () => ok(await deps.llm.selfTest()),
  };
}
