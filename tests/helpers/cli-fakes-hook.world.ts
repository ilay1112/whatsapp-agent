// tests/helpers/cli-fakes-hook.world.ts - [V2] owner V2-W1-06-claude-cli (helper named <ownedFile>.<suffix>.ts, build plan 6).
// A "Claude CLI world" for L3/L4 tests WITHOUT compose(): the PRODUCTION JobRunner, CliRunner, argv/env builders, init assertion and
// claude_cli provider, with only the S-JOB spawn seam redirected to tests/fakes/fake-claude-cli.mjs under the SYSTEM node.exe (T8).
// Fake home + userData are mkdtemp dirs (T9); the journal is registered with cli-fakes-hook (ledger rule 11) unless a test opts out.
import cp from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpawnOptions } from 'node:child_process';
import { DEFAULT_SETTINGS } from '../../src/shared/settings.ts';
import type { EpochMs } from '../../src/shared/types.ts';
import { createJobRunner, type JobRunner } from '../../src/main/proc/jobRunner.ts';
import { createCliRunner, type CliRunBudget, type CliRunnerExt } from '../../src/main/llm/cli/runner.ts';
import { createClaudeCliProvider, type ClaudeCliProvider } from '../../src/main/llm/cli/claudeCli.ts';
import type { CliLocator } from '../../src/main/llm/cli/locator.ts';
import { createToolGate, type RunCtx, type ToolGate } from '../../src/main/agent/toolGate.ts';
import { createHandleTable } from '../../src/main/agent/handles.ts';
import { startToolServer, type ToolServerHandle } from '../../src/main/mcp/toolServer.ts';
import { freePort } from '../../src/main/proc/freePort.ts';
import type { McpReadClient } from '../../src/main/mcp/readClient.ts';
import { FakeWaReadClient } from '../fakes/fake-wa-read-client.ts';
import {
  FAKE_CLAUDE_DEFAULT_STATE,
  readFakeClaudeJournal,
  type FakeClaudeJournalEntry,
  type FakeClaudeState,
} from '../fakes/fake-claude-cli.types.ts';
import type { StubRule } from '../fakes/stub-llm.ts';
import { registerFakeJournal } from './cli-fakes-hook.ts';

export const FAKE_CLAUDE_CLI = fileURLToPath(new URL('../fakes/fake-claude-cli.mjs', import.meta.url));

export interface AuditRow {
  kind: string;
  ref: string | null;
  detail: Record<string, string | number | boolean | null>;
}
export interface ClaudeFakeWorld {
  root: string;
  home: string;
  userData: string;
  runDir: string;
  exePath: string;
  journalFile: string;
  jobs: JobRunner;
  runner: CliRunnerExt;
  audits: AuditRow[];
  spawnedArgs: string[][];
  taskkills: Array<{ pid: number; tree: boolean }>;
  setState(s: Partial<FakeClaudeState>): void;
  setScript(rules: StubRule[]): void;
  journal(): FakeClaudeJournalEntry[];
  provider(over?: Partial<Parameters<typeof createClaudeCliProvider>[0]>): ClaudeCliProvider;
  /** A real ToolGate (calendar tools over a scripted read facade) + RunCtx for S3 runs. */
  gate(): { gate: ToolGate; ctx: RunCtx };
  /** Real per-run loopback tool server (W1-05) over the given gate/ctx; every handle is remembered for close checks. */
  startToolServer: Parameters<typeof createClaudeCliProvider>[0]['startToolServer'];
  servers: ToolServerHandle[];
  /** Recursive file listing of userData + home (for token / leak sweeps). */
  allFiles(): string[];
  cleanup(): void;
}

const fakeRead: McpReadClient = {
  getCurrentTime: async () => ({
    ok: true,
    value: { nowIso: '2026-09-21T10:00:00+03:00', timeZone: 'Asia/Jerusalem' },
  }),
  getFreeBusy: async () => ({ ok: true, value: [] }),
  findAppEvent: async () => ({ ok: true, value: null }),
  getEvent: async () => ({ ok: false, error: 'not_found' }) as never,
};

export function createClaudeFakeWorld(
  opts: {
    state?: Partial<FakeClaudeState>;
    script?: StubRule[];
    processEnv?: Record<string, string | undefined>;
    mcpConfigMode?: 'inline_env' | 'run_file';
    budget?: CliRunBudget;
    allowOverage?: () => boolean;
    now?: () => EpochMs;
    registerJournal?: boolean;
    graceMs?: number;
  } = {},
): ClaudeFakeWorld {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-cliw-'));
  const home = path.join(root, 'wca-fake-home');
  const userData = path.join(root, 'userData');
  const runDir = path.join(userData, 'run');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  const exePath = path.join(home, '.local', 'bin', 'claude.exe'); // never a real file: the spawn seam redirects it to the fake
  const journalFile = path.join(root, 'journal.jsonl');
  const stateFile = path.join(root, 'state.json');
  const scriptFile = path.join(root, 'script.json');
  let state: FakeClaudeState = { ...FAKE_CLAUDE_DEFAULT_STATE, ...opts.state };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.writeFileSync(scriptFile, JSON.stringify({ rules: opts.script ?? [] }));
  if (opts.registerJournal !== false) registerFakeJournal('claude', journalFile);

  const spawnedArgs: string[][] = [];
  const taskkills: Array<{ pid: number; tree: boolean }> = [];
  const audits: AuditRow[] = [];
  const jobs = createJobRunner({
    runDir,
    now: opts.now ?? (() => Date.now()),
    log: () => undefined,
    proc: {
      spawn: (command: string, args: readonly string[], options: SpawnOptions) => {
        if (command !== exePath) throw Object.assign(new Error('unexpected exe'), { code: 'ENOENT' });
        spawnedArgs.push([...args]);
        return cp.spawn(
          process.execPath,
          [
            FAKE_CLAUDE_CLI,
            '--fake-journal',
            journalFile,
            '--fake-state',
            stateFile,
            '--fake-script',
            scriptFile,
            '--fake-end',
            ...args,
          ],
          options,
        );
      },
      killPid: async (pid: number, tree: boolean) => {
        taskkills.push({ pid, tree });
        await new Promise<void>((resolve) => {
          const k = cp.spawn('taskkill', ['/PID', String(pid), ...(tree ? ['/T'] : []), '/F'], {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
          });
          k.once('error', () => resolve());
          k.once('close', () => resolve());
        });
      },
      setPriority: () => undefined,
    },
  });
  const processEnv = opts.processEnv ?? {
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    USERPROFILE: home,
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\wca-fake-home',
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  };
  const runner = createCliRunner({
    jobs,
    userDataDir: userData,
    now: opts.now ?? (() => Date.now()),
    audit: (kind, ref, detail) => audits.push({ kind, ref, detail }),
    processEnv,
    ...(opts.budget ? { budget: opts.budget } : {}),
    ...(opts.allowOverage ? { allowOverage: opts.allowOverage } : {}),
    ...(opts.mcpConfigMode ? { mcpConfigMode: opts.mcpConfigMode } : {}),
    ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}),
  });
  const locator: CliLocator = {
    find: async () => ({ provider: 'claude_cli', exePath, version: state.version }),
    version: async () => state.version,
    signedIn: async () => state.loggedIn === true,
  };
  const servers: ToolServerHandle[] = [];
  const startTs: ClaudeFakeWorld['startToolServer'] = async (input) => {
    const h = await startToolServer({
      gate: input.gate,
      ctx: input.ctx,
      specs: input.specs,
      randomBytes: (n) => new Uint8Array(randomBytes(n)),
      freePort: () => freePort(),
      appVersion: '0.0.0-test',
    });
    servers.push(h);
    return h;
  };

  const walk = (dir: string, out: string[]): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else out.push(p);
    }
  };

  return {
    root,
    home,
    userData,
    runDir,
    exePath,
    journalFile,
    jobs,
    runner,
    audits,
    spawnedArgs,
    taskkills,
    servers,
    setState(s) {
      state = { ...state, ...s };
      fs.writeFileSync(stateFile, JSON.stringify(state));
    },
    setScript(rules) {
      fs.writeFileSync(scriptFile, JSON.stringify({ rules }));
    },
    journal() {
      try {
        return readFakeClaudeJournal(fs.readFileSync(journalFile, 'utf8'));
      } catch {
        return [];
      }
    },
    provider(over = {}) {
      return createClaudeCliProvider({
        runner,
        locator,
        model: DEFAULT_SETTINGS.llm.cli.claudeModel,
        exePath,
        observedVersion: state.version,
        startToolServer: startTs,
        ...over,
      });
    },
    gate() {
      const gate = createToolGate({
        read: fakeRead,
        wa: new FakeWaReadClient(),
        settings: () => DEFAULT_SETTINGS,
        calendarConnected: () => true,
        waAvailable: () => false,
        audit: (kind, ref, detail) => audits.push({ kind, ref, detail }),
      });
      const ctx: RunCtx = {
        runId: 11,
        itemId: 22,
        chatId: 1,
        nowMs: Date.parse('2026-09-21T07:00:00.000Z'),
        timeZone: 'Asia/Jerusalem',
        nonce: '0123456789abcdef',
        calls: {},
        totalCalls: 0,
        blockedCalls: 0,
        signal: new AbortController().signal,
        handles: createHandleTable(1),
        waRowsServed: 0,
        crossChatRows: 0,
        otherChatTexts: [],
      };
      return { gate, ctx };
    },
    startToolServer: startTs,
    allFiles() {
      const out: string[] = [];
      walk(userData, out);
      walk(home, out);
      return out;
    },
    cleanup() {
      for (const s of servers) void s.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The S1-shaped messages every test uses (synthetic nonce block, T5). */
export const S1_MESSAGES = [
  { role: 'system' as const, content: 'S1 CONSTANT (test)\nReturn the JSON object only, on one line, no markdown.' },
  {
    role: 'user' as const,
    content:
      '<<DATA-0123456789abcdef>>\n{"messages":[{"from":"contact","text":"coffee tomorrow 17:00?"}]}\n<<END-DATA-0123456789abcdef>>',
  },
];
export const S1_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { intent: { type: 'string', enum: ['meeting', 'none'] }, confidence: { type: 'number' } },
  required: ['intent', 'confidence'],
} as const;
