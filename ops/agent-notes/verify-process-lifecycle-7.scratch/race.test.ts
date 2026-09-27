// Scratch proof for review finding process-lifecycle-7. Real production modules:
//   createSupervisor (src/main/proc/supervisor.ts) and runQuitSequence (src/main/app/window.ts).
// Only the ChildSpec.start bodies are fakes - NO process is ever spawned.
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSupervisor, type ChildHandle } from '../../../src/main/proc/supervisor';
import { runQuitSequence } from '../../../src/main/app/window';
import type { Logger } from '../../../src/main/deps';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const noopLog: Logger = { info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog };

describe('process-lifecycle-7: quit during compose.start()', () => {
  it('spawns calendar-mcp after stopAll passed it, and neither stopAll nor killAllSync reaches it', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'pl7-'));
    const killedSync: number[] = [];
    const gracefulKills: string[] = [];

    // The real supervisor, with taskkill replaced by a recorder (no real kill, no real spawn).
    const sup = createSupervisor({
      runDir,
      now: () => Date.now(),
      log: () => {},
      killSync: (pid) => killedSync.push(pid),
      processQuery: { query: () => Promise.resolve(null), kill: () => Promise.resolve() },
    });

    // bridge: its start takes 150 ms (production: up to MAX_LAUNCH_ATTEMPTS x READINESS_BUDGET_MS = 30 s).
    sup.register({
      name: 'bridge',
      start: async (): Promise<ChildHandle> => {
        await sleep(150);
        return {
          pid: 1001,
          exePath: 'C:\fake\whatsapp-bridge.exe',
          kill: () => gracefulKills.push('bridge'),
          onExit: () => {},
        };
      },
      backoffMs: [1000],
      breaker: { maxExits: 5, windowMs: 600_000 },
      stableAfterMs: 60_000,
    });

    // calendar-mcp: the OS child exists as soon as start() is entered; the handle only appears when
    // the handshake resolves (production: MCP_STARTUP_TIMEOUT_MS = 30 s for connect + 30 s for listTools).
    let mcpOsChildAlive = false;
    sup.register({
      name: 'calendar-mcp',
      start: async (): Promise<ChildHandle> => {
        mcpOsChildAlive = true; // <- StdioClientTransport has spawned the server process here
        await sleep(3_000); // still inside the handshake
        return {
          pid: 2002,
          exePath: 'C:\fake\calendar-mcp.exe',
          kill: () => {
            gracefulKills.push('calendar-mcp');
            mcpOsChildAlive = false;
          },
          onExit: () => {},
        };
      },
      backoffMs: [2000],
      breaker: { maxExits: 3, windowMs: 600_000 },
      stableAfterMs: 60_000,
    });

    // --- compose.start(), verbatim shape of compose.ts:1193-1233 (no `quitting` guard anywhere) ---
    let startFinished = false;
    const start = (async () => {
      await sup.start('bridge'); // compose: `await startBridge()`
      await sup.start('calendar-mcp'); // compose: `if (credentialsExist()) await supervisor.start('calendar-mcp')`
      startFinished = true;
    })();

    // --- the tray Quit lands 20 ms into start(): index.ts before-quit -> runtime.shutdown() ---
    await sleep(20);
    let exited = false;
    await runQuitSequence({
      setQuitting: () => undefined,
      stopQueue: async () => {},
      drainExecutor: async () => {},
      stopChildren: async (opts) => {
        await sup.stopAll(opts); // compose.ts:1284
      },
      writeLastOnline: () => {},
      closeDb: () => {},
      destroyTray: () => undefined,
      exit: () => {
        exited = true;
      },
      log: noopLog,
      timeoutMs: 600, // production: QUIT_DRAIN_MS + QUIT_CHILD_GRACE_MS + 5_000 = 13_000
    });

    // index.ts before-quit `finally`: tray.destroy(); killAllSync(); app.exit(0) - all synchronous.
    sup.killAllSync();

    expect(exited).toBe(true);
    // 1. The MCP child WAS spawned, even though the whole quit sequence already ran.
    expect(mcpOsChildAlive).toBe(true);
    // 2. compose.start() has not even returned - app.exit(0) would fire now.
    expect(startFinished).toBe(false);
    // 3. killAllSync could not kill it: e.handle is still null while spec.start is pending.
    expect(killedSync).not.toContain(2002);
    expect(gracefulKills).not.toContain('calendar-mcp');
    // 4. No pid file was ever written => the reaper cannot collect it on the next boot.
    expect(existsSync(join(runDir, 'calendar-mcp.pid.json'))).toBe(false);
    // The bridge, by contrast, WAS reached (stop() awaits e.pending) - so the hole is specific.
    expect(gracefulKills).toContain('bridge');
  }, 20_000);
});
