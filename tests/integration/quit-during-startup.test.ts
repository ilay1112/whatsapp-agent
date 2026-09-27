// tests/integration/quit-during-startup.test.ts - process-lifecycle-7: a quit that lands WHILE compose.start() is still
// in flight. index.ts builds the tray (with its Quit item) before it awaits `rt.start()`, and start() can sit inside
// startBridge() / supervisor.start('calendar-mcp') for tens of seconds, so `before-quit -> runtime.shutdown()` is live
// for the whole startup. Everything here runs against the PRODUCTION compose() through the L3 harness; nothing spawns.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.ts';

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

/** Awaits `p` while keeping the VIRTUAL clock moving (the quit sequence drains the queue through injected timers). */
async function pump<T>(harness: Harness, p: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = p.then(
    (v) => {
      settled = true;
      return v;
    },
    (err: unknown) => {
      settled = true;
      throw err;
    },
  );
  for (let i = 0; i < 400 && !settled; i++) await harness.advance(250);
  return tracked;
}

/** Every supervisor/child line the run produced for a given child, in order (`name="calendar-mcp"` in the meta). */
const childLines = (harness: Harness, name: string): string[] =>
  harness.logs.filter((l) => l.includes(`name="${name}"`));

describe('a quit that lands during start()', () => {
  it('starts no supervised child once shutdown() has begun', async () => {
    h = await createHarness({ autoStart: false });

    // The tray Quit arrives while start() is suspended at its first await: shutdown() sets its `quitting` flag
    // synchronously, so the flag is already true by the time start() resumes.
    const startP = h.app.start();
    const startErr = startP.then(
      () => null,
      (err: unknown) => err,
    );
    const shutdownP = h.app.shutdown();
    await pump(h, shutdownP);
    await pump(h, startErr);

    // supervisor.setState logs `proc_state name="calendar-mcp" state="starting"` BEFORE spec.start runs, so this
    // catches the spawn whether the MCP handshake then succeeds or fails.
    expect(childLines(h, 'calendar-mcp')).toEqual([]);
    expect(h.health().calendar.state).not.toBe('connected');
    await expect(startErr).resolves.toBeNull();

    // ...and no periodic timer was armed either: the janitor / retention / backup ticks would run against the database
    // the quit sequence has already closed.
    await h.advance(20 * 60_000);
    expect(h.logs.filter((l) => l.includes('backup_failed') || l.includes('timer_failed'))).toEqual([]);
  });

  it('start() called after shutdown() is a no-op', async () => {
    h = await createHarness({ autoStart: false });
    await pump(h, h.app.shutdown());

    // shutdown() closed the database; a start() that still ran its recovery statements would throw on it.
    await expect(pump(h, h.app.start())).resolves.toBeUndefined();
    expect(childLines(h, 'calendar-mcp')).toEqual([]);
  });
});
