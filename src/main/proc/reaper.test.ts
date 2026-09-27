// src/main/proc/reaper.test.ts - TESTS 5.3 row `proc/reaper.ts` incl. the [R2] hostile pid-file cases (owner W1-01).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { ProcessInfo, ProcessQuery, SpawnFn } from '../deps';
import { childExeRoots, createPaths } from '../paths';
import {
  CREATION_TOLERANCE_MS,
  PS_QUERY_ARGS,
  createWindowsProcessQuery,
  parseCreationDate,
  parseProcessJson,
  reapOrphans,
} from './reaper';
import type { ChildName } from './supervisor';

let tmpDir: string;
let runDir: string;
let resourcesDir: string;
let ownExe: string;

const START = 1_700_000_000_000;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-reap-'));
  runDir = path.join(tmpDir, 'run');
  resourcesDir = path.join(tmpDir, 'resources');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(resourcesDir, 'bridge'), { recursive: true });
  ownExe = path.join(resourcesDir, 'bridge', 'whatsapp-bridge.exe');
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writePidFile(name: string, body: unknown): string {
  const p = path.join(runDir, `${name}.pid.json`);
  fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  return p;
}

interface QuerySpy extends ProcessQuery {
  queries: number[];
  kills: Array<{ pid: number; tree: boolean }>;
}
function querySpy(answer: (pid: number) => ProcessInfo | null): QuerySpy {
  const spy: QuerySpy = {
    queries: [],
    kills: [],
    query: (pid) => {
      spy.queries.push(pid);
      return Promise.resolve(answer(pid));
    },
    kill: (pid, tree) => {
      spy.kills.push({ pid, tree });
      return Promise.resolve();
    },
  };
  return spy;
}

describe('reapOrphans - happy path', () => {
  it('kills only when pid + executable path + creation time all match', async () => {
    writePidFile('bridge', { pid: 4242, exePath: ownExe, startedAt: START });
    const spy = querySpy(() => ({ pid: 4242, executablePath: ownExe, creationDate: START + 500 }));

    const result = await reapOrphans(runDir, resourcesDir, { processQuery: spy });

    expect(result).toEqual({ killed: ['bridge'], stalePidFiles: 0 });
    expect(spy.kills).toEqual([{ pid: 4242, tree: true }]);
    expect(fs.existsSync(path.join(runDir, 'bridge.pid.json'))).toBe(false);
  });

  it('accepts a differently-cased executable path from Win32_Process', async () => {
    writePidFile('llama', { pid: 77, exePath: ownExe, startedAt: START });
    const spy = querySpy(() => ({ pid: 77, executablePath: ownExe.toUpperCase(), creationDate: START }));
    await expect(reapOrphans(runDir, resourcesDir, { processQuery: spy })).resolves.toEqual({
      killed: ['llama'],
      stalePidFiles: 0,
    });
  });

  it('accepts a child started as process.execPath (the calendar MCP server)', async () => {
    const execPath = path.join(tmpDir, 'app', 'WhatsApp Calendar Agent.exe');
    writePidFile('calendar-mcp', { pid: 88, exePath: execPath, startedAt: START });
    const spy = querySpy(() => ({ pid: 88, executablePath: execPath, creationDate: START - CREATION_TOLERANCE_MS }));
    await expect(reapOrphans(runDir, resourcesDir, { processQuery: spy, execPath })).resolves.toEqual({
      killed: ['calendar-mcp'],
      stalePidFiles: 0,
    });
  });

  it('reaps several children in one pass', async () => {
    writePidFile('bridge', { pid: 1, exePath: ownExe, startedAt: START });
    writePidFile('llama', { pid: 2, exePath: ownExe, startedAt: START });
    const spy = querySpy((pid) => ({ pid, executablePath: ownExe, creationDate: START }));
    const result = await reapOrphans(runDir, resourcesDir, { processQuery: spy });
    expect(result.killed.sort()).toEqual(['bridge', 'llama']);
    expect(result.stalePidFiles).toBe(0);
  });

  it('returns an empty result when the run dir does not exist yet', async () => {
    const spy = querySpy(() => null);
    await expect(reapOrphans(path.join(tmpDir, 'never-created'), resourcesDir, { processQuery: spy })).resolves.toEqual(
      {
        killed: [],
        stalePidFiles: 0,
      },
    );
    expect(spy.queries).toEqual([]);
  });

  it('ignores files that are not *.pid.json', async () => {
    fs.writeFileSync(path.join(runDir, 'notes.txt'), 'hello', 'utf8');
    const spy = querySpy(() => null);
    await expect(reapOrphans(runDir, resourcesDir, { processQuery: spy })).resolves.toEqual({
      killed: [],
      stalePidFiles: 0,
    });
    expect(fs.existsSync(path.join(runDir, 'notes.txt'))).toBe(true);
  });
});

describe('reapOrphans - the three negative cases', () => {
  it('(1) the pid is gone: no kill, the file is discarded', async () => {
    writePidFile('bridge', { pid: 4242, exePath: ownExe, startedAt: START });
    const spy = querySpy(() => null);
    const result = await reapOrphans(runDir, resourcesDir, { processQuery: spy });
    expect(result).toEqual({ killed: [], stalePidFiles: 1 });
    expect(spy.queries).toEqual([4242]);
    expect(spy.kills).toEqual([]);
    expect(fs.existsSync(path.join(runDir, 'bridge.pid.json'))).toBe(false);
  });

  it('(2) the pid was recycled by a foreign executable: no kill', async () => {
    writePidFile('bridge', { pid: 4242, exePath: ownExe, startedAt: START });
    const spy = querySpy(() => ({
      pid: 4242,
      executablePath: 'C:\\Windows\\System32\\notepad.exe',
      creationDate: START,
    }));
    const result = await reapOrphans(runDir, resourcesDir, { processQuery: spy });
    expect(result).toEqual({ killed: [], stalePidFiles: 1 });
    expect(spy.kills).toEqual([]);
  });

  it('(3) the creation time does not match within +-2 s: no kill', async () => {
    writePidFile('bridge', { pid: 4242, exePath: ownExe, startedAt: START });
    const tooLate = querySpy(() => ({
      pid: 4242,
      executablePath: ownExe,
      creationDate: START + CREATION_TOLERANCE_MS + 1,
    }));
    expect(await reapOrphans(runDir, resourcesDir, { processQuery: tooLate })).toEqual({
      killed: [],
      stalePidFiles: 1,
    });
    expect(tooLate.kills).toEqual([]);

    writePidFile('bridge', { pid: 4242, exePath: ownExe, startedAt: START });
    const unknown = querySpy(() => ({ pid: 4242, executablePath: ownExe, creationDate: null }));
    expect(await reapOrphans(runDir, resourcesDir, { processQuery: unknown })).toEqual({
      killed: [],
      stalePidFiles: 1,
    });
    expect(unknown.kills).toEqual([]);

    writePidFile('bridge', { pid: 4242, exePath: ownExe, startedAt: START });
    const noPath = querySpy(() => ({ pid: 4242, executablePath: null, creationDate: START }));
    expect(await reapOrphans(runDir, resourcesDir, { processQuery: noPath })).toEqual({ killed: [], stalePidFiles: 1 });
    expect(noPath.kills).toEqual([]);
  });
});

describe('reapOrphans - [R2] hostile pid files cause NO spawn and NO kill', () => {
  const HOSTILE: Array<[string, unknown]> = [
    ['pid is a WQL injection string', { pid: '1 OR 1=1', exePath: '', startedAt: START }],
    ['pid is fractional', { pid: 1.5, exePath: '', startedAt: START }],
    ['pid is 2**31', { pid: 2 ** 31, exePath: '', startedAt: START }],
    ['startedAt is a string', { pid: 1, exePath: '', startedAt: 'x' }],
    ['the file is not JSON', 'PowerShell -Command Remove-Item C:\\'],
    ['the file is empty', ''],
  ];

  it.each(HOSTILE)('%s', async (_label, body) => {
    writePidFile('bridge', typeof body === 'string' ? body : { ...(body as object), exePath: ownExe });
    const spy = querySpy(() => ({ pid: 1, executablePath: ownExe, creationDate: START }));
    const spawn = vi.fn<SpawnFn>();

    const result = await reapOrphans(runDir, resourcesDir, { processQuery: spy, spawn });

    expect(result).toEqual({ killed: [], stalePidFiles: 1 });
    expect(spy.queries).toEqual([]);
    expect(spy.kills).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(runDir, 'bridge.pid.json'))).toBe(false);
  });

  it('a foreign exePath is never queried or killed', async () => {
    writePidFile('bridge', { pid: 4242, exePath: 'C:\\Windows\\System32\\cmd.exe', startedAt: START });
    const spy = querySpy(() => ({ pid: 4242, executablePath: 'C:\\Windows\\System32\\cmd.exe', creationDate: START }));
    const result = await reapOrphans(runDir, resourcesDir, { processQuery: spy });
    expect(result).toEqual({ killed: [], stalePidFiles: 1 });
    expect(spy.queries).toEqual([]);
    expect(spy.kills).toEqual([]);
  });

  it('a pid file named after something that is not one of our children is never queried', async () => {
    writePidFile('powershell.exe', { pid: 4242, exePath: ownExe, startedAt: START });
    const spy = querySpy(() => ({ pid: 4242, executablePath: ownExe, creationDate: START }));
    const result = await reapOrphans(runDir, resourcesDir, { processQuery: spy });
    expect(result).toEqual({ killed: [], stalePidFiles: 1 });
    expect(spy.queries).toEqual([]);
  });

  it('an unreadable pid file (a directory) is discarded without a query', async () => {
    fs.mkdirSync(path.join(runDir, 'bridge.pid.json'));
    const spy = querySpy(() => ({ pid: 1, executablePath: ownExe, creationDate: START }));
    const result = await reapOrphans(runDir, resourcesDir, { processQuery: spy });
    expect(result).toEqual({ killed: [], stalePidFiles: 1 });
    expect(spy.queries).toEqual([]);
  });

  it('a discard that fails is logged, not thrown', async () => {
    const events: string[] = [];
    fs.mkdirSync(path.join(runDir, 'bridge.pid.json'));
    fs.writeFileSync(path.join(runDir, 'bridge.pid.json', 'held.txt'), 'x', 'utf8'); // rmSync without recursive fails
    const spy = querySpy(() => null);
    const result = await reapOrphans(runDir, resourcesDir, { processQuery: spy, log: (e) => events.push(e) });
    expect(result.stalePidFiles).toBe(1);
    expect(events).toContain('reaper_pidfile_remove_failed');
  });

  it('counts every discarded file and still reaps the good one in the same pass', async () => {
    writePidFile('bridge', { pid: 4242, exePath: ownExe, startedAt: START });
    writePidFile('llama', { pid: '1 OR 1=1', exePath: ownExe, startedAt: START });
    writePidFile('calendar-mcp', 'not json');
    const spy = querySpy(() => ({ pid: 4242, executablePath: ownExe, creationDate: START }));
    const result = await reapOrphans(runDir, resourcesDir, { processQuery: spy });
    expect(result).toEqual({ killed: ['bridge'], stalePidFiles: 2 });
    expect(spy.queries).toEqual([4242]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the injected default ProcessQuery: argv shape (no shell string, no WQL literal, never /IM)
// ---------------------------------------------------------------------------------------------------------------------
interface SpawnRecord {
  command: string;
  args: string[];
  options: SpawnOptions;
}
function recordingSpawn(stdoutFor: (command: string) => string): { fn: SpawnFn; calls: SpawnRecord[] } {
  const calls: SpawnRecord[] = [];
  const fn: SpawnFn = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    const stdout = new Readable({ read() {} });
    const child = new EventEmitter() as EventEmitter & { stdout: Readable };
    child.stdout = stdout;
    queueMicrotask(() => {
      if (options.stdio === 'ignore') {
        child.emit('close', 0);
        return;
      }
      stdout.on('end', () => child.emit('close', 0));
      const out = stdoutFor(command);
      if (out.length > 0) stdout.push(out);
      stdout.push(null);
    });
    return child as unknown as ChildProcess;
  };
  return { fn, calls };
}

describe('createWindowsProcessQuery', () => {
  it('passes the pid as its own argv element after `--`, never inside the -Command string', async () => {
    const { fn, calls } = recordingSpawn(() =>
      JSON.stringify({ ProcessId: 4242, ExecutablePath: ownExe, CreationDate: '/Date(1700000000000)/' }),
    );
    const query = createWindowsProcessQuery({ spawn: fn });

    const info = await query.query(4242);

    expect(info).toEqual({ pid: 4242, executablePath: ownExe, creationDate: 1_700_000_000_000 });
    expect(calls).toHaveLength(1);
    const call = calls[0] as SpawnRecord;
    expect(call.command).toBe('powershell.exe');
    expect(call.options.shell).toBe(false);
    expect(call.args).toEqual([...PS_QUERY_ARGS, '--', '4242']);
    expect(call.args[call.args.length - 1]).toBe('4242');
    expect(call.args[call.args.length - 2]).toBe('--');
    expect(call.args[2]).toBe('-Command');
    const command = call.args[3] as string;
    expect(command).not.toContain('4242'); // the pid is never interpolated
    expect(command).toContain('[int]$args[0]');
  });

  it('kills by PID with /T /F and never by image name', async () => {
    const { fn, calls } = recordingSpawn(() => '');
    const query = createWindowsProcessQuery({ spawn: fn });

    await query.kill(4242, true);

    const call = calls[0] as SpawnRecord;
    expect(call.command).toBe('taskkill');
    expect(call.args).toEqual(['/PID', '4242', '/T', '/F']);
    expect(call.options.shell).toBe(false);
    expect([call.command, ...call.args].join(' ')).not.toContain('/IM');
  });

  it('refuses to query a pid that is not a positive safe integer - without spawning', async () => {
    const { fn, calls } = recordingSpawn(() => '');
    const query = createWindowsProcessQuery({ spawn: fn });
    await expect(query.query(0)).resolves.toBeNull();
    await expect(query.query(-1)).resolves.toBeNull();
    await expect(query.query(1.5)).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it('resolves null when powershell cannot be started or answers garbage', async () => {
    const garbage = createWindowsProcessQuery({ spawn: recordingSpawn(() => 'not json').fn });
    await expect(garbage.query(1)).resolves.toBeNull();

    const failing: SpawnFn = () => {
      const child = new EventEmitter() as EventEmitter & { stdout: Readable };
      child.stdout = new Readable({ read() {} });
      queueMicrotask(() => child.emit('error', new Error('ENOENT')));
      return child as unknown as ChildProcess;
    };
    await expect(createWindowsProcessQuery({ spawn: failing }).query(1)).resolves.toBeNull();
  });

  it('is the default used by reapOrphans when no ProcessQuery is injected', async () => {
    writePidFile('bridge', { pid: 4242, exePath: ownExe, startedAt: START });
    const { fn, calls } = recordingSpawn(() =>
      JSON.stringify({ ProcessId: 4242, ExecutablePath: ownExe, CreationDate: START }),
    );

    const result = await reapOrphans(runDir, resourcesDir, { spawn: fn });

    expect(result).toEqual({ killed: ['bridge'], stalePidFiles: 0 });
    expect(calls.map((c) => c.command)).toEqual(['powershell.exe', 'taskkill']);
    expect(calls.every((c) => c.options.shell === false)).toBe(true);
  });
});

describe('the reaper is database-free', () => {
  // TESTS 5.3 asks that the reaper "works with the DB locked": it is DB-free by construction, so there is nothing to lock.
  it('imports no database module and reads nothing but <runDir>\\*.pid.json', () => {
    const source = fs.readFileSync(fileURLToPath(new URL('./reaper.ts', import.meta.url)), 'utf8');
    expect(source).not.toContain('node:sqlite');
    expect(source).not.toContain("from '../db");
    expect(source).not.toContain('app.db');
  });

  it('runs before any child was ever spawned and while a stale run dir holds only junk', async () => {
    fs.writeFileSync(path.join(runDir, 'bridge.pid.json.tmp'), '{"pid":1}', 'utf8'); // an interrupted atomic write
    const spy = querySpy(() => null);
    await expect(reapOrphans(runDir, resourcesDir, { processQuery: spy })).resolves.toEqual({
      killed: [],
      stalePidFiles: 0,
    });
    expect(spy.queries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// process-lifecycle-9: unpackaged, the llama exe lives in <appRoot>\vendor\llama\win-x64-vulkan, NOT under
// <appRoot>\resources. A single-root reaper discarded every dev/e2e llama.pid.json as forged and leaked the orphan.
// ---------------------------------------------------------------------------------------------------------------------
describe('reapOrphans - several legal child roots (dev/unpackaged layout)', () => {
  const devPaths = createPaths({
    userData: 'C:\\Users\\dev\\AppData\\Roaming\\WhatsApp Calendar Agent',
    resourcesPath: 'C:\\unused\\resources',
    appRoot: 'C:\\dev\\whatsapp agent',
    isPackaged: false,
  });

  it('kills a LIVE llama orphan whose exe is the unpackaged vendor llama-server.exe', async () => {
    writePidFile('llama', { pid: 4242, exePath: devPaths.llamaServerExe, startedAt: START });
    const spy = querySpy(() => ({ pid: 4242, executablePath: devPaths.llamaServerExe, creationDate: START }));
    const events: string[] = [];

    const result = await reapOrphans(runDir, childExeRoots(devPaths), {
      processQuery: spy,
      execPath: 'C:\\app\\WhatsApp Calendar Agent.exe',
      log: (e) => events.push(e),
    });

    expect(result).toEqual({ killed: ['llama'], stalePidFiles: 0 });
    expect(spy.kills).toEqual([{ pid: 4242, tree: true }]);
    expect(events).not.toContain('reaper_pidfile_rejected');
  });

  it('kills a child started from the unpackaged calendar-mcp tree', async () => {
    const mcpExe = path.join(devPaths.mcpRoot, 'node.exe');
    writePidFile('calendar-mcp', { pid: 51, exePath: mcpExe, startedAt: START });
    const spy = querySpy(() => ({ pid: 51, executablePath: mcpExe, creationDate: START }));
    await expect(reapOrphans(runDir, childExeRoots(devPaths), { processQuery: spy })).resolves.toEqual({
      killed: ['calendar-mcp'],
      stalePidFiles: 0,
    });
  });

  it('accepts an extra exact exe path (the e2e WCA_LLAMA_CMD seam command)', async () => {
    const seamCmd = path.join(tmpDir, 'nodejs', 'node.exe'); // outside every root
    writePidFile('llama', { pid: 7, exePath: seamCmd, startedAt: START });
    const spy = querySpy(() => ({ pid: 7, executablePath: seamCmd, creationDate: START }));
    await expect(
      reapOrphans(runDir, childExeRoots(devPaths), {
        processQuery: spy,
        execPath: ['C:\\app\\WhatsApp Calendar Agent.exe', seamCmd],
      }),
    ).resolves.toEqual({ killed: ['llama'], stalePidFiles: 0 });
  });

  it('[R2] still rejects an exe that is inside NONE of the roots: no query, no kill', async () => {
    writePidFile('llama', { pid: 9, exePath: 'C:\\Windows\\System32\\cmd.exe', startedAt: START });
    const spy = querySpy(() => ({ pid: 9, executablePath: 'C:\\Windows\\System32\\cmd.exe', creationDate: START }));
    const events: string[] = [];
    const result = await reapOrphans(runDir, childExeRoots(devPaths), {
      processQuery: spy,
      execPath: 'C:\\app\\WhatsApp Calendar Agent.exe',
      log: (e) => events.push(e),
    });
    expect(result).toEqual({ killed: [], stalePidFiles: 1 });
    expect(spy.queries).toEqual([]);
    expect(spy.kills).toEqual([]);
    expect(events).toContain('reaper_pidfile_rejected');
  });

  it('childExeRoots covers the three staged resource trees in both layouts', () => {
    expect(childExeRoots(devPaths)).toEqual([devPaths.resourcesDir, devPaths.llamaDir, devPaths.mcpRoot]);
    const packed = createPaths({
      userData: 'C:\\Users\\dev\\AppData\\Roaming\\WhatsApp Calendar Agent',
      resourcesPath: 'C:\\Program Files\\WhatsApp Calendar Agent\\resources',
      appRoot: 'C:\\Program Files\\WhatsApp Calendar Agent\\resources\\app.asar',
      isPackaged: true,
    });
    // Packaged: llamaDir and mcpRoot are already inside resourcesDir, so the extra roots are harmless duplicates.
    expect(childExeRoots(packed)).toEqual([packed.resourcesDir, packed.llamaDir, packed.mcpRoot]);
  });
});

describe('parseProcessJson / parseCreationDate', () => {
  it('reads the Windows PowerShell and the PowerShell 7 date forms', () => {
    expect(parseCreationDate('/Date(1700000000000)/')).toBe(1_700_000_000_000);
    expect(parseCreationDate('2026-09-21T20:15:03.000Z')).toBe(Date.parse('2026-09-21T20:15:03.000Z'));
    expect(parseCreationDate(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(parseCreationDate('nonsense')).toBeNull();
    expect(parseCreationDate(null)).toBeNull();
    expect(parseCreationDate(Number.NaN)).toBeNull();
    expect(parseCreationDate('/Date(not-a-number)/')).toBeNull();
  });

  it('rejects a row for a different pid', () => {
    expect(
      parseProcessJson(4242, JSON.stringify({ ProcessId: 9, ExecutablePath: 'C:\\a.exe', CreationDate: 1 })),
    ).toBeNull();
  });

  it('takes the first row when ConvertTo-Json returned an array', () => {
    const json = JSON.stringify([{ ProcessId: 5, ExecutablePath: 'C:\\a.exe', CreationDate: 1 }]);
    expect(parseProcessJson(5, json)).toEqual({ pid: 5, executablePath: 'C:\\a.exe', creationDate: 1 });
  });

  it('reports a missing executable path as null rather than throwing', () => {
    expect(parseProcessJson(5, JSON.stringify({ ProcessId: 5, ExecutablePath: '', CreationDate: 1 }))).toEqual({
      pid: 5,
      executablePath: null,
      creationDate: 1,
    });
    expect(parseProcessJson(5, '')).toBeNull();
    expect(parseProcessJson(5, 'null')).toBeNull();
    expect(parseProcessJson(5, '[]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// frozen-signature conformance
// [FIX ROUND] W2-01-compose-integration asked to RATIFY OR REVERT the additive optional third parameter. Ratified; pinned.
// ---------------------------------------------------------------------------------------------------------------------
describe('frozen-signature conformance', () => {
  /** CONTRACTS section 13 pasted verbatim. Compile-time assertion: the third parameter must stay optional. */
  type FrozenReapOrphans = (
    runDir: string,
    ownResourcesDir: string,
  ) => Promise<{ killed: ChildName[]; stalePidFiles: number }>;

  it('reapOrphans still satisfies the verbatim CONTRACTS section 13 declaration', () => {
    const frozen: FrozenReapOrphans = reapOrphans;
    expect(frozen).toBe(reapOrphans);
  });

  it('a two-argument call runs on the production defaults and spawns nothing for a rejected pid file', async () => {
    writePidFile('bridge', { pid: '1 OR 1=1', exePath: ownExe, startedAt: START });
    const spawnSpy = vi.spyOn(cp, 'spawn');
    try {
      await expect(reapOrphans(runDir, resourcesDir)).resolves.toEqual({ killed: [], stalePidFiles: 1 });
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
    }
  });
});
