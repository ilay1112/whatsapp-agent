// tests/fakes/fake-agy.world.ts - [V2] owner V2-W1-09-antigravity (helper named <ownedFile>.<suffix>.ts after fake-agy.mjs, build plan 6).
// An "Antigravity CLI world" for L3/L4 tests WITHOUT compose(): the PRODUCTION JobRunner, CliRunner, agy argv/env/agent-file builders,
// init assertion and antigravity_cli provider, with only the S-JOB spawn seam redirected to tests/fakes/fake-agy.mjs under the SYSTEM
// node.exe (T8). The fake user home and userData are mkdtemp dirs (T9); the journal is registered with cli-fakes-hook (ledger rule 11)
// unless a test opts out (tests that PROVOKE a violation read the journal themselves).
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpawnOptions } from 'node:child_process';
import type { EpochMs } from '../../src/shared/types.ts';
import { createJobRunner, type JobRunner } from '../../src/main/proc/jobRunner.ts';
import { createCliRunner, type CliRunBudget, type CliRunnerExt } from '../../src/main/llm/cli/runner.ts';
import { createAgyProvider, type AgyProvider } from '../../src/main/llm/cli/antigravityCli.ts';
import type { CliLocator } from '../../src/main/llm/cli/locator.ts';
import {
  FAKE_AGY_DEFAULT_STATE,
  readFakeAgyJournal,
  type FakeAgyJournalEntry,
  type FakeAgyState,
} from './fake-agy.types.ts';
import type { StubRule } from './stub-llm.ts';
import { registerFakeJournal } from '../helpers/cli-fakes-hook.ts';

export const FAKE_AGY = fileURLToPath(new URL('./fake-agy.mjs', import.meta.url));

export interface AgyAuditRow {
  kind: string;
  ref: string | null;
  detail: Record<string, string | number | boolean | null>;
}
export interface AgyFakeWorld {
  root: string;
  /** the fake USER home (%USERPROFILE% of the app process) - never the isolated agy profile. */
  home: string;
  userData: string;
  runDir: string;
  exePath: string;
  journalFile: string;
  stateFile: string;
  scriptFile: string;
  jobs: JobRunner;
  runner: CliRunnerExt;
  audits: AgyAuditRow[];
  spawnedArgs: string[][];
  spawnedEnvs: Array<Record<string, string>>;
  taskkills: Array<{ pid: number; tree: boolean }>;
  processEnv: Record<string, string | undefined>;
  locator: CliLocator;
  setState(s: Partial<FakeAgyState>): void;
  setScript(rules: StubRule[]): void;
  journal(): FakeAgyJournalEntry[];
  provider(over?: Partial<Parameters<typeof createAgyProvider>[0]>): AgyProvider;
  /** Writes <home>\.gemini\config\mcp_config.json with an ENABLED `whatsapp` server (mode global_mcp_present, F3). */
  plantGlobalMcpConfig(): string;
  /** Recursive file listing of userData + home. */
  allFiles(): string[];
  cleanup(): void;
}

export function createAgyFakeWorld(
  opts: {
    state?: Partial<FakeAgyState>;
    script?: StubRule[];
    processEnv?: Record<string, string | undefined>;
    budget?: CliRunBudget;
    now?: () => EpochMs;
    registerJournal?: boolean;
    graceMs?: number;
  } = {},
): AgyFakeWorld {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-agyw-'));
  const home = path.join(root, 'wca-fake-home');
  const userData = path.join(root, 'userData');
  const runDir = path.join(userData, 'run');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  // never a real file: the spawn seam redirects it to the fake (a path under the FAKE home's LOCALAPPDATA, never the real one - T9)
  const exePath = path.join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe');
  const journalFile = path.join(root, 'journal.jsonl');
  const stateFile = path.join(root, 'state.json');
  const scriptFile = path.join(root, 'script.json');
  let state: FakeAgyState = { ...FAKE_AGY_DEFAULT_STATE, ...opts.state };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.writeFileSync(scriptFile, JSON.stringify({ rules: opts.script ?? [] }));
  if (opts.registerJournal !== false) registerFakeJournal('agy', journalFile);

  const spawnedArgs: string[][] = [];
  const spawnedEnvs: Array<Record<string, string>> = [];
  const taskkills: Array<{ pid: number; tree: boolean }> = [];
  const audits: AgyAuditRow[] = [];
  const jobs = createJobRunner({
    runDir,
    now: opts.now ?? (() => Date.now()),
    log: () => undefined,
    proc: {
      spawn: (command: string, args: readonly string[], options: SpawnOptions) => {
        if (command !== exePath) throw Object.assign(new Error('unexpected exe'), { code: 'ENOENT' });
        spawnedArgs.push([...args]);
        spawnedEnvs.push({ ...(options.env as Record<string, string>) });
        return cp.spawn(
          process.execPath,
          [
            FAKE_AGY,
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
    ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}),
  });
  const locator: CliLocator = {
    find: async () => ({ provider: 'antigravity_cli', exePath, version: state.version }),
    version: async () => state.version,
    signedIn: async () => state.loggedIn,
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
    stateFile,
    scriptFile,
    jobs,
    runner,
    audits,
    spawnedArgs,
    spawnedEnvs,
    taskkills,
    processEnv,
    locator,
    setState(s) {
      state = { ...state, ...s };
      fs.writeFileSync(stateFile, JSON.stringify(state));
    },
    setScript(rules) {
      fs.writeFileSync(scriptFile, JSON.stringify({ rules }));
    },
    journal() {
      try {
        return readFakeAgyJournal(fs.readFileSync(journalFile, 'utf8'));
      } catch {
        return [];
      }
    },
    provider(over = {}) {
      return createAgyProvider({
        runner,
        locator,
        model: 'gemini-3.8-flash-high',
        exePath,
        userDataDir: userData,
        observedVersion: state.version,
        ...over,
      });
    },
    plantGlobalMcpConfig() {
      const dir = path.join(home, '.gemini', 'config');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'mcp_config.json');
      // synthetic: the shape of the reference `whatsapp` server the research found registered globally (no real path, no data)
      fs.writeFileSync(
        file,
        JSON.stringify(
          { mcpServers: { whatsapp: { command: 'uv', args: ['run', 'main.py'], disabled: false } } },
          null,
          2,
        ),
      );
      return file;
    },
    allFiles() {
      const out: string[] = [];
      walk(userData, out);
      walk(home, out);
      return out;
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The S1-shaped messages every agy test uses (synthetic nonce block, T5). */
export const AGY_S1_SYSTEM = 'S1 CONSTANT (agy test)\nReturn the JSON object only, on one line, no markdown.';
export const AGY_S1_USER =
  '<<DATA-0123456789abcdef>>\n{"messages":[{"from":"contact","text":"coffee tomorrow 17:00?"}]}\n<<END-DATA-0123456789abcdef>>';
export const AGY_S1_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { intent: { type: 'string', enum: ['meeting', 'none'] }, confidence: { type: 'number' } },
  required: ['intent', 'confidence'],
} as const;
