// TESTS 5.3 `ipc/*`: the model channels take a TIER FROM AN ENUM, never a URL or a path. The download source is the
// compile-time manifest inside ModelManager (W1-07); nothing the renderer sends can point the downloader anywhere.
import { describe, expect, it } from 'vitest';
import { IPC_REQUEST_SCHEMAS } from '../../../shared/ipc';
import {
  MODEL_TIERS,
  type DownloadProgress,
  type ModelPlan,
  type ModelTier,
  type TierInfo,
} from '../../../shared/types';
import { makeFixture } from '../register.fixtures';
import { createModelHandlers } from './model';

const CTX = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };

function tierInfo(t: ModelTier): TierInfo {
  return {
    tier: t,
    modelLabel: `fixture-${t}`,
    sizeBytes: 1,
    status: 'none',
    bytesDone: 0,
    fitsDisk: true,
    tokPerSec: null,
  };
}
const PLAN: ModelPlan = {
  recommendedTier: 'small',
  selectedTier: 'small',
  tiers: MODEL_TIERS.map(tierInfo),
  suggestSmaller: false,
};
function progress(t: ModelTier): DownloadProgress {
  return { tier: t, status: 'downloading', bytesDone: 1, bytesTotal: 2, bytesPerSec: 1, etaSec: 1, errorCode: null };
}

/** A ModelManager that records which tier each call received. */
function recordingManager(): { calls: Array<[string, ModelTier]>; apply: (f: ReturnType<typeof makeFixture>) => void } {
  const calls: Array<[string, ModelTier]> = [];
  return {
    calls,
    apply(f) {
      f.deps.modelManager.plan = async () => PLAN;
      for (const op of ['start', 'pause', 'resume'] as const) {
        f.deps.modelManager[op] = async (t: ModelTier) => {
          calls.push([op, t]);
          return progress(t);
        };
      }
      for (const op of ['cancel', 'delete'] as const) {
        f.deps.modelManager[op] = async (t: ModelTier) => {
          calls.push([op, t]);
          return PLAN;
        };
      }
    },
  };
}

describe('model channels carry an enum tier, never a location', () => {
  it('the request schema accepts only MODEL_TIERS (a URL or a path is rejected before the handler)', () => {
    for (const channel of [
      'model:startDownload',
      'model:pause',
      'model:resume',
      'model:cancel',
      'model:delete',
    ] as const) {
      const schema = IPC_REQUEST_SCHEMAS[channel];
      for (const t of MODEL_TIERS) expect(schema.safeParse({ tier: t }).success, `${channel} ${t}`).toBe(true);
      expect(schema.safeParse({}).success, channel).toBe(true); // omitted = the tier in use
      expect(schema.safeParse({ tier: 'https://evil.example/model.gguf' }).success, channel).toBe(false);
      expect(schema.safeParse({ tier: 'tiny', url: 'https://evil.example/x' }).success, channel).toBe(false);
      expect(schema.safeParse({ url: 'https://evil.example/x' }).success, channel).toBe(false);
    }
  });
});

describe('model:getPlan / model:selfTest', () => {
  it('getPlan delegates to the manager', async () => {
    const f = makeFixture();
    f.deps.modelManager.plan = async () => PLAN;
    expect(await createModelHandlers(f.deps)['model:getPlan'](undefined, CTX)).toEqual({ ok: true, value: PLAN });
  });

  it('selfTest delegates to the injected llm helper', async () => {
    const f = makeFixture();
    f.deps.llm.selfTest = async () => ({ ok: true, tokPerSec: 12.5, usedCpuFallback: false });
    expect(await createModelHandlers(f.deps)['model:selfTest'](undefined, CTX)).toEqual({
      ok: true,
      value: { ok: true, tokPerSec: 12.5, usedCpuFallback: false },
    });
  });
});

describe('tier resolution', () => {
  it('an explicit tier is passed through unchanged on every operation', async () => {
    const f = makeFixture();
    const m = recordingManager();
    m.apply(f);
    const h = createModelHandlers(f.deps);
    expect(await h['model:startDownload']({ tier: 'tiny' }, CTX)).toEqual({ ok: true, value: progress('tiny') });
    expect(await h['model:pause']({ tier: 'small' }, CTX)).toEqual({ ok: true, value: progress('small') });
    expect(await h['model:resume']({ tier: 'mid' }, CTX)).toEqual({ ok: true, value: progress('mid') });
    expect(await h['model:cancel']({ tier: 'tiny' }, CTX)).toEqual({ ok: true, value: PLAN });
    expect(await h['model:delete']({ tier: 'mid' }, CTX)).toEqual({ ok: true, value: PLAN });
    expect(m.calls).toEqual([
      ['start', 'tiny'],
      ['pause', 'small'],
      ['resume', 'mid'],
      ['cancel', 'tiny'],
      ['delete', 'mid'],
    ]);
  });

  it('an omitted tier with a pinned setting uses the SETTING, without asking for a plan', async () => {
    const f = makeFixture();
    const m = recordingManager();
    m.apply(f);
    f.state.settings.llm.local.tier = 'mid';
    f.deps.modelManager.plan = async () => {
      throw new Error('plan() must not be needed when the tier is pinned');
    };
    await createModelHandlers(f.deps)['model:startDownload']({}, CTX);
    expect(m.calls).toEqual([['start', 'mid']]);
  });

  it("an omitted tier with tier:'auto' falls back to the plan's selectedTier", async () => {
    const f = makeFixture();
    const m = recordingManager();
    m.apply(f);
    expect(f.state.settings.llm.local.tier).toBe('auto');
    await createModelHandlers(f.deps)['model:delete']({}, CTX);
    expect(m.calls).toEqual([['delete', 'small']]); // PLAN.selectedTier
  });
});
