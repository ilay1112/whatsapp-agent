// T2 5 / C2 8: model:* take a DOWNLOAD_TARGET from the enum (LLM tiers, 'mmproj', voice-*, voice-vad) - never a URL or a path.
// 'mmproj' resolves in main to the projector of the SELECTED LLM tier; one downloader queue serves every file (V2-W1-07).
import { describe, expect, it } from 'vitest';
import { IPC_REQUEST_SCHEMAS } from '../../../shared/ipc';
import {
  DOWNLOAD_TARGETS,
  MODEL_TIERS,
  VOICE_TIERS,
  type DownloadProgress,
  type ModelFileId,
  type ModelPlan,
} from '../../../shared/types';
import { makeFixture } from '../register.fixtures';
import { createModelHandlers } from './model';

const CTX = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };

function plan(mmproj: ModelPlan['mmproj']): ModelPlan {
  return { recommendedTier: 'small', selectedTier: 'small', tiers: [], suggestSmaller: false, mmproj };
}
const progress = (id: ModelFileId): DownloadProgress =>
  ({
    tier: id,
    status: 'downloading',
    bytesDone: 1,
    bytesTotal: 2,
    bytesPerSec: 1,
    etaSec: 1,
    errorCode: null,
  }) as DownloadProgress;

function setup(mmproj: ModelPlan['mmproj'] = { id: 'mmproj-small', sizeBytes: 5, status: 'none', bytesDone: 0 }) {
  const f = makeFixture();
  const calls: Array<[string, string]> = [];
  const mm = f.deps.modelManager as unknown as Record<string, (id?: string) => Promise<unknown>>;
  f.deps.modelManager.plan = async () => plan(mmproj);
  for (const op of ['start', 'pause', 'resume'] as const) {
    mm[op] = async (id?: string) => {
      calls.push([op, id!]);
      return progress(id as ModelFileId);
    };
  }
  for (const op of ['cancel', 'delete'] as const) {
    mm[op] = async (id?: string) => {
      calls.push([op, id!]);
      return plan(mmproj);
    };
  }
  return { f, h: createModelHandlers(f.deps), calls };
}

describe('model:* [V2] targets', () => {
  it('the request enum is exactly DOWNLOAD_TARGETS: no URL, no path, no raw mmproj id', () => {
    const schema = IPC_REQUEST_SCHEMAS['model:startDownload'];
    for (const t of DOWNLOAD_TARGETS) expect(schema.safeParse({ tier: t }).success, t).toBe(true);
    for (const bad of ['mmproj-small', 'https://x.example/model.gguf', 'C:\\models\\x.gguf', 'voice', 'auto']) {
      expect(schema.safeParse({ tier: bad }).success, bad).toBe(false);
    }
  });

  it('voice files and voice-vad go to the downloader by their own id, on every op', async () => {
    const { h, calls } = setup();
    for (const target of [...VOICE_TIERS, 'voice-vad'] as const) {
      await h['model:startDownload']({ tier: target }, CTX);
      await h['model:pause']({ tier: target }, CTX);
      await h['model:resume']({ tier: target }, CTX);
      await h['model:cancel']({ tier: target }, CTX);
      await h['model:delete']({ tier: target }, CTX);
    }
    expect(calls).toEqual(
      [...VOICE_TIERS, 'voice-vad'].flatMap((t) =>
        ['start', 'pause', 'resume', 'cancel', 'delete'].map((op) => [op, t]),
      ),
    );
  });

  it("'mmproj' resolves to the SELECTED tier's projector from the plan", async () => {
    const { h, calls } = setup();
    const res = await h['model:startDownload']({ tier: 'mmproj' }, CTX);
    expect(res.ok && (res.value as DownloadProgress).tier).toBe('mmproj-small');
    await h['model:delete']({ tier: 'mmproj' }, CTX);
    expect(calls).toEqual([
      ['start', 'mmproj-small'],
      ['delete', 'mmproj-small'],
    ]);
  });

  it("'mmproj' with no projector in the plan is BAD_REQUEST and reaches no downloader", async () => {
    const { h, calls } = setup(null);
    expect(await h['model:startDownload']({ tier: 'mmproj' }, CTX)).toEqual({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    });
    expect(calls).toEqual([]);
  });

  it('LLM tiers and the omitted target keep the v1 behaviour', async () => {
    const { f, h, calls } = setup();
    for (const t of MODEL_TIERS) await h['model:startDownload']({ tier: t }, CTX);
    await h['model:startDownload']({}, CTX);
    f.state.settings.llm.local.tier = 'mid';
    await h['model:startDownload']({}, CTX);
    expect(calls).toEqual([
      ['start', 'tiny'],
      ['start', 'small'],
      ['start', 'mid'],
      ['start', 'small'],
      ['start', 'mid'],
    ]);
  });
});
