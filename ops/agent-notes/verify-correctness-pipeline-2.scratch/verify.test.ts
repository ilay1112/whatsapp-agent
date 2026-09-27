// Scratch verification of review finding correctness-pipeline-2 (skeptic pass). Throwaway; not part of the suite.
import { describe, expect, it } from 'vitest';
import { createTriageQueue, DEFAULT_SCAN_MS } from '../../../src/main/agent/queue';
import { LIMITS, type ChatRef } from '../../../src/shared/types';
import { createVirtualClock } from '../../../tests/helpers/virtualClock';
import { ANCHOR_MS, createTestEnv, seedChat, seedOpenItem } from '../../../tests/golden/testDb';

describe('correctness-pipeline-2', () => {
  it('a mid-run re-arm (ingest handleInbound / retriage) is deleted by runOne.remove()', async () => {
    const env = createTestEnv();
    const clock = createVirtualClock(ANCHOR_MS);
    const chat = seedChat(env.repos);
    const item = seedOpenItem(env.repos, chat, { triggerMsgId: 'wamid.A' });

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let sawRowDuringRun = -1;

    const queue = createTriageQueue({
      repos: env.repos,
      // stands in for orchestrator.runChat: snapshot -> await provider -> validateAndPersist(analysis='done')
      runChat: async (chatId: ChatRef) => {
        env.repos.items.update(item.id, { analysis: 'running' }, clock.now());
        await gate; // provider call in flight
        sawRowDuringRun = env.repos.queue.size();
        env.repos.items.update(item.id, { analysis: 'done' }, clock.now()); // validate.ts:205
        void chatId;
      },
      clock,
      log: env.log,
    });

    // t0: message A -> item + queue row (due t0+20s)
    env.repos.queue.enqueue(chat.id, clock.now());
    queue.start();
    await clock.advance(LIMITS.debounceMs);
    await clock.advance(DEFAULT_SCAN_MS); // worker dequeues and starts runChat
    expect(env.repos.queue.size()).toBe(1); // nextDue() does NOT delete: the row is still there mid-run

    // t0+25s: message B lands. bridge/ingest.ts handleInbound on an EXISTING open item:
    await clock.advance(5_000);
    const now = clock.now();
    env.repos.items.update(item.id, { analysis: 'queued', triggerMsgId: 'wamid.B', triggerTs: now }, now);
    env.repos.queue.enqueue(chat.id, now); // repos/queue.ts: row exists -> UPDATE due_at only, no new row

    release();
    await clock.advance(DEFAULT_SCAN_MS);
    await clock.advance(DEFAULT_SCAN_MS);

    expect(sawRowDuringRun).toBe(1); // the re-armed row existed when the run ended
    const after = env.repos.items.byId(item.id)!;
    // The verdict:
    expect(env.repos.queue.size()).toBe(0); // <- the re-armed row was deleted
    expect(after.analysis).toBe('done'); // <- nothing will re-arm it
    expect(after.triggerMsgId).toBe('wamid.B'); // <- card points at B, proposal answered A

    await queue.stop();
    env.dispose();
  });
});
