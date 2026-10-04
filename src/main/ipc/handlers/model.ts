// src/main/ipc/handlers/model.ts - handlers for the channels below (build-plan section 3; owner W1-13; v2 V2-W1-10-main-platform).
// Bodies return Result<T>, never throw. Every request carries a TARGET FROM AN ENUM, never a URL or a path: the download source is
// the compile-time manifest (MODEL_MANIFEST / MEDIA_MODEL_MANIFEST, V2-W1-07).
import {
  MODEL_TIERS,
  type DownloadProgress,
  type DownloadTarget,
  type ModelFileId,
  type ModelPlan,
  type ModelTier,
} from '../../../shared/types';
import type { IpcHandlers } from '../../../shared/ipc';
import { fail, ok, type HandlerDeps } from '../register';

export type ModelChannels =
  | 'model:getPlan'
  | 'model:startDownload'
  | 'model:pause'
  | 'model:resume'
  | 'model:cancel'
  | 'model:delete'
  | 'model:selfTest';

/**
 * [V2] C2 8: ONE downloader queue for the LLM tiers, the projector ('mmproj' = the projector of the selected LLM tier) and the voice
 * files. V2-W1-07 widens `ModelManager`'s parameter from ModelTier to ModelFileId (the manifest/downloader deltas are its); this is
 * the view of that queue the handler uses, so the handler compiles against both the v1 and the widened signature.
 */
interface FileDownloadQueue {
  start(id: ModelFileId): Promise<DownloadProgress>;
  pause(id: ModelFileId): Promise<DownloadProgress>;
  resume(id: ModelFileId): Promise<DownloadProgress>;
  cancel(id: ModelFileId): Promise<ModelPlan>;
  delete(id: ModelFileId): Promise<ModelPlan>;
}

const isLlmTier = (t: string): t is ModelTier => (MODEL_TIERS as readonly string[]).includes(t);

export function createModelHandlers(deps: HandlerDeps): Pick<IpcHandlers, ModelChannels> {
  const queue = deps.modelManager as unknown as FileDownloadQueue;

  /** An omitted target means "the LLM tier in use": the setting when it names one, otherwise the tier the plan picked for this machine. */
  const selectedTier = async (): Promise<ModelTier> => {
    const setting = deps.settings.get().llm.local.tier;
    return setting === 'auto' ? (await deps.modelManager.plan()).selectedTier : setting;
  };
  /** [V2] target -> file id: LLM tiers and voice files are their own id; 'mmproj' resolves to the SELECTED tier's projector. */
  const resolve = async (target?: DownloadTarget): Promise<ModelFileId | null> => {
    if (target === undefined) return selectedTier();
    if (target !== 'mmproj') return target;
    const plan = await deps.modelManager.plan();
    return plan.mmproj?.id ?? null; // no projector for this tier (or none planned): nothing to download
  };
  const run = async <T>(target: DownloadTarget | undefined, op: (id: ModelFileId) => Promise<T>) => {
    const id = await resolve(target);
    if (id === null) return fail<T>('BAD_REQUEST');
    // v1 tiers go through the v1-typed members unchanged; the other files through the widened queue view.
    return ok(await op(id));
  };

  return {
    'model:getPlan': async () => ok(await deps.modelManager.plan()),
    'model:startDownload': (req) =>
      run(req.tier, (id) => (isLlmTier(id) ? deps.modelManager.start(id) : queue.start(id))),
    'model:pause': (req) => run(req.tier, (id) => (isLlmTier(id) ? deps.modelManager.pause(id) : queue.pause(id))),
    'model:resume': (req) => run(req.tier, (id) => (isLlmTier(id) ? deps.modelManager.resume(id) : queue.resume(id))),
    'model:cancel': (req) => run(req.tier, (id) => (isLlmTier(id) ? deps.modelManager.cancel(id) : queue.cancel(id))),
    'model:delete': (req) => run(req.tier, (id) => (isLlmTier(id) ? deps.modelManager.delete(id) : queue.delete(id))),
    'model:selfTest': async () => ok(await deps.llm.selfTest()),
  };
}
