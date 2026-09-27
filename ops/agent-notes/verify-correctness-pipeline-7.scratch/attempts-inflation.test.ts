// Scratch proof for review finding correctness-pipeline-7: do NON-FAILURE deferrals inflate the retry backoff?
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCAN_MS, RETRY_BACKOFF_MS, TriageRetryError, createTriageQueue } from '../../../src/main/agent/queue';
import { LIMITS, type ChatRef, type EpochMs } from '../../../src/shared/types';
import { createVirtualClock } from '../../../tests/helpers/virtualClock';
import { ANCHOR_MS, createTestEnv, seedChat, seedOpenItem } from '../../../tests/golden/testDb';

describe('correctness-pipeline-7', () => {
  it('edit-lock deferrals bump attempts, so the FIRST real provider failure waits 30 min instead of 1 min', async () => {
    const env = createTestEnv();
    const clock = createVirtualClock(ANCHOR_MS);
    const chat = seedChat(env.repos);
    const item = seedOpenItem(env.repos, chat);
    let fail = false;
    const runs: ChatRef[] = [];
    const queue = createTriageQueue({
      repos: env.repos,
      runChat: (chatId) => {
        runs.push(chatId);
        return fail ? Promise.reject(new TriageRetryError('CLOUD_UNAVAILABLE')) : Promise.resolve();
      },
      clock,
      log: env.log,
    });
    const tick = async (rounds = 2): Promise<void> => {
      for (let i = 0; i < rounds; i++) await clock.advance(DEFAULT_SCAN_MS);
    };

    // (1) INGEST Stage-0 'deferred' path (bridge/ingest.ts:255-257): a message lands while the card is edit-locked.
    env.repos.items.update(item.id, { editingUntil: (clock.now() + LIMITS.editLockMs) as EpochMs }, clock.now());
    env.repos.queue.enqueue(chat.id, clock.now()); // brand-new row, attempts = 0
    env.repos.queue.defer(chat.id, (clock.now() + LIMITS.editLockMs) as EpochMs); // <- no lastError
    expect(env.repos.queue.nextDue(Number.MAX_SAFE_INTEGER)!.attempts).toBe(1);

    queue.start();

    // (2) + (3) the user re-opens the editor twice: each time the worker's edit-lock branch (agent/queue.ts:113) defers.
    for (let i = 0; i < 2; i++) {
      const due = env.repos.queue.nextDue(Number.MAX_SAFE_INTEGER)!.dueAt;
      // the user is still typing when the deferral expires: the lock is extended before the row becomes due
      env.repos.items.update(item.id, { editingUntil: (due + LIMITS.editLockMs) as EpochMs }, clock.now());
      await clock.advanceTo((due + 1) as EpochMs);
      await tick();
    }
    expect(runs).toHaveLength(0); // nothing has RUN yet - no failure has happened at all
    const beforeFailure = env.repos.queue.nextDue(Number.MAX_SAFE_INTEGER)!;
    expect(beforeFailure.attempts).toBe(3);
    expect(beforeFailure.lastError).toBeNull(); // proof: three "attempts" with no error ever recorded

    // (4) lock released; the first genuine run happens and hits a retryable provider error.
    env.repos.items.update(item.id, { editingUntil: 0 as EpochMs }, clock.now());
    fail = true;
    await clock.advanceTo((beforeFailure.dueAt + 1) as EpochMs);
    const failedAt = clock.now();
    await tick(3);
    expect(runs).toHaveLength(1);
    const row = env.repos.queue.nextDue(Number.MAX_SAFE_INTEGER)!;
    expect(row.lastError).toBe('CLOUD_UNAVAILABLE');
    expect(row.dueAt - failedAt).toBeGreaterThan(RETRY_BACKOFF_MS[1]!); // 30-min tier on the FIRST failure (spec: 1 min)
    expect(row.attempts).toBe(4);
    expect(env.repos.items.byId(item.id)!.analysis).toBe('queued'); // isListed('queued') === false

    await queue.stop();
    env.dispose();
  });
});
