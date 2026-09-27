// tests/e2e/helpers/fakes.ts - starting the fakes an E2E launch is allowed to see (owner W2-03).
//
// Three modes, all of them fakes (TESTS 4.2): ATTACH (an in-process `fake-bridge` already listening, the app only points
// its REST clients at it), CHILD (`WCA_BRIDGE_CMD`: the system `node` runs the same fake as a real child process) and the
// MCP child (`WCA_MCP_CMD`: `fake-mcp-calendar.ts` over stdio, journalled to a file).
// Nothing here can reach WhatsApp, Google or a model: no real exe, no network target other than 127.0.0.1.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { startFakeBridge, type FakeBridge, type FakeBridgeOptions } from '../../fakes/fake-bridge.ts';
import { wca, type E2eContext } from './fixtures.ts';
import { FAKE_LLAMA_TS, FAKE_MCP_TS } from './paths.ts';

/** A free loopback port for the child-mode fake's `__control` server (never 8080, which the bridge invariants forbid). */
export function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      srv.close(() => (port > 0 && port !== 8080 ? resolve(port) : reject(new Error('no usable port'))));
    });
  });
}

/** 64 lowercase hex - exactly what `readSeams` accepts as `WCA_FAKE_BRIDGE_TOKEN`. */
export function newBridgeToken(): string {
  return randomBytes(32).toString('hex');
}

export interface AttachedBridge {
  fake: FakeBridge;
  /** `WCA_FAKE_BRIDGE_URL` + `WCA_FAKE_BRIDGE_TOKEN`, ready to spread into `launch({ env })`. */
  env: Record<string, string>;
  token: string;
  /**
   * An inbound message the way the REAL bridge delivers one: the row lands in `messages.db` AND the app's doorbell is
   * rung (bridge-contract: one webhook POST per inbound, `X-Bridge-Token` = the bridge's token), which is what makes
   * ingest scan now. `fake.inbound()` alone only writes the row - the fake is started before the app exists, so it has
   * no webhook URL, and in attach mode nothing else rings ingest between the boot-time pokes and the 30 s fallback
   * timer (`LIMITS.scanIntervalMs`, which `WCA_TIMERS.scanMs` does NOT shorten - that one is the triage queue's). A spec
   * that writes the row without ringing is betting on the 250 ms debounce window of the last boot poke.
   */
  deliver(app: ElectronApplication, msg: Parameters<FakeBridge['inbound']>[0]): Promise<{ id: string; rowid: number }>;
}

/**
 * ATTACH mode. The fake writes `messages.db` into `<userData>\bridge\store\`, exactly where the app's read-only
 * `bridgeDb` looks for it. Its `sent` journal and `violations` are folded into the spec's ledger on dispose.
 */
export async function attachBridge(
  ctx: E2eContext,
  userDataDir: string,
  opts: Partial<Omit<FakeBridgeOptions, 'token' | 'storeDir'>> = {},
): Promise<AttachedBridge> {
  const token = newBridgeToken();
  const storeDir = join(userDataDir, 'bridge', 'store');
  mkdirSync(storeDir, { recursive: true });
  const fake = await startFakeBridge({ ...opts, token, storeDir });
  ctx.onStop(async () => {
    for (const s of fake.sent) ctx.sends.push({ at: s.at, recipient: s.recipient, message: s.message });
    ctx.violations.push(...fake.violations);
    await fake.stop();
  });
  return {
    fake,
    token,
    env: { WCA_FAKE_BRIDGE_URL: fake.url, WCA_FAKE_BRIDGE_TOKEN: token },
    deliver: async (app, msg) => {
      const row = await fake.inbound(msg);
      // `__wcaTest.doorbellUrl` is the live `http://127.0.0.1:<port>/hook/<secret>` compose minted for this launch.
      const url = await wca(app).doorbellUrl();
      if (url === '') throw new Error('E2E: the app published no doorbell URL, so the inbound cannot be delivered');
      const status = await fake.ringDoorbell(url, {
        sender: msg.chatJid.split('@')[0] ?? '',
        content: msg.text,
        chatJID: msg.chatJid,
        isFromMe: false,
      });
      if (status !== 200) throw new Error(`E2E: the doorbell answered HTTP ${status} to a well-formed ring`);
      return row;
    },
  };
}

export interface McpChild {
  journalFile: string;
  seedFile: string | null;
  /** `WCA_MCP_CMD`, ready to spread into `launch({ env })`. */
  env: Record<string, string>;
  /** Every journalled line so far (`env`, `argv`, `call`). */
  entries(): Array<{ at: number; kind: string; detail: unknown }>;
  /** Only the `create-event` tool calls, in order. */
  createEvents(): Array<{ at: number; args: Record<string, unknown> }>;
  calls(tool?: string): Array<{ at: number; tool: string; args: Record<string, unknown> }>;
}

interface JournalCall {
  at: number;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * `WCA_MCP_CMD`: the calendar MCP server the app spawns is `fake-mcp-calendar.ts` under the system `node`, never the
 * staged real server and never a Google account. Its `create-event` calls feed the ledger.
 */
export function mcpChild(
  ctx: E2eContext,
  label: string,
  seed?: { events?: unknown[]; calendars?: unknown[]; accounts?: string; scenario?: string },
): McpChild {
  const journalFile = ctx.writeTempFile(`${label}-mcp-journal.jsonl`, '');
  const seedFile = seed === undefined ? null : ctx.writeTempFile(`${label}-mcp-seed.json`, JSON.stringify(seed));

  const entries = (): Array<{ at: number; kind: string; detail: unknown }> => {
    if (!existsSync(journalFile)) return [];
    const out: Array<{ at: number; kind: string; detail: unknown }> = [];
    for (const line of readFileSync(journalFile, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as { at: number; kind: string; detail: unknown });
      } catch {
        /* a half-written line is not an assertion */
      }
    }
    return out;
  };
  const calls = (tool?: string): JournalCall[] =>
    entries()
      .filter((e) => e.kind === 'call')
      .map((e) => e.detail as JournalCall)
      .filter((c) => c !== null && typeof c === 'object' && (tool === undefined || c.tool === tool));

  ctx.onStop(() => {
    for (const c of calls('create-event')) ctx.createEvents.push({ at: c.at, args: c.args });
  });

  return {
    journalFile,
    seedFile,
    env: {
      WCA_MCP_CMD: JSON.stringify({
        command: process.execPath,
        args: [
          FAKE_MCP_TS,
          '--journal',
          journalFile,
          ...(seedFile === null ? [] : ['--seed', seedFile]),
          ...(seed?.scenario === undefined ? [] : ['--scenario', String(seed.scenario)]),
        ],
      }),
    },
    entries,
    createEvents: () => calls('create-event').map((c) => ({ at: c.at, args: c.args })),
    calls,
  };
}

/** `WCA_LLAMA_CMD`: the "local model server" is `fake-llama-server.ts`; `llama-server.exe` is never spawned in a test. */
export function llamaCmdSeam(extraArgs: string[] = []): Record<string, string> {
  return {
    WCA_LLAMA_CMD: JSON.stringify({ command: process.execPath, args: [FAKE_LLAMA_TS, ...extraArgs] }),
  };
}
