// Scratch proof for process-lifecycle-9. Read-only: uses the REAL createPaths + parsePidFile + reapOrphans.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createPaths } from '../../../src/main/paths';
import { parsePidFile } from '../../../src/main/proc/supervisor';
import { reapOrphans } from '../../../src/main/proc/reaper';
import type { ProcessQuery } from '../../../src/main/deps';

const SEP = '\\';
const APP_ROOT = ['C:', 'dev', 'whatsapp agent'].join(SEP);
const EXEC = [APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'].join(SEP);
const PACKED_RES = ['C:', 'packaged', 'resources'].join(SEP);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl9-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const dev = createPaths({
  userData: path.join(tmp, 'userData'),
  resourcesPath: PACKED_RES,
  appRoot: APP_ROOT,
  isPackaged: false,
});
const packed = createPaths({
  userData: path.join(tmp, 'userData'),
  resourcesPath: PACKED_RES,
  appRoot: APP_ROOT,
  isPackaged: true,
});

describe('process-lifecycle-9', () => {
  it('unpackaged llamaServerExe is outside resourcesDir', () => {
    expect(dev.resourcesDir).toBe([APP_ROOT, 'resources'].join(SEP));
    expect(dev.llamaServerExe).toBe(
      [APP_ROOT, 'vendor', 'llama', 'win-x64-vulkan', 'llama-server.exe'].join(SEP),
    );
    expect(dev.llamaServerExe.startsWith(dev.resourcesDir + SEP)).toBe(false);
  });

  it('parsePidFile REJECTS a well-formed unpackaged llama pid file', () => {
    const body = JSON.stringify({ pid: 4242, exePath: dev.llamaServerExe, startedAt: 1_700_000_000_000 });
    expect(parsePidFile(body, dev.resourcesDir, EXEC)).toBeNull();
  });

  it('...and ACCEPTS the same file in a packaged layout', () => {
    const body = JSON.stringify({ pid: 4242, exePath: packed.llamaServerExe, startedAt: 1_700_000_000_000 });
    expect(parsePidFile(body, packed.resourcesDir, EXEC)).not.toBeNull();
  });

  it('bridge + mcp(execPath) pid files are accepted unpackaged (only llama breaks)', () => {
    const bridge = JSON.stringify({ pid: 11, exePath: dev.bridgeExe, startedAt: 1 });
    expect(parsePidFile(bridge, dev.resourcesDir, EXEC)).not.toBeNull();
    const mcp = JSON.stringify({ pid: 12, exePath: EXEC, startedAt: 1 });
    expect(parsePidFile(mcp, dev.resourcesDir, EXEC)).not.toBeNull();
    // the e2e fake llama runs node.exe -> outside resourcesDir and != the app's execPath
    const fake = JSON.stringify({
      pid: 13,
      exePath: ['C:', 'Program Files', 'nodejs', 'node.exe'].join(SEP),
      startedAt: 1,
    });
    expect(parsePidFile(fake, dev.resourcesDir, EXEC)).toBeNull();
  });

  it('reapOrphans: a LIVE matching orphan is NOT killed unpackaged, IS killed packaged', async () => {
    const started = 1_700_000_000_000;
    const mk = (exe: string): void => {
      fs.mkdirSync(dev.runDir, { recursive: true });
      fs.writeFileSync(
        path.join(dev.runDir, 'llama.pid.json'),
        JSON.stringify({ pid: 4242, exePath: exe, startedAt: started }),
        'utf8',
      );
    };
    const spy = (exe: string): { q: ProcessQuery; killed: number[] } => {
      const killed: number[] = [];
      return {
        killed,
        q: {
          query: () => Promise.resolve({ pid: 4242, executablePath: exe, creationDate: started }),
          kill: (pid: number) => {
            killed.push(pid);
            return Promise.resolve();
          },
        },
      };
    };
    const events: string[] = [];
    mk(dev.llamaServerExe);
    const a = spy(dev.llamaServerExe);
    const devResult = await reapOrphans(dev.runDir, dev.resourcesDir, {
      processQuery: a.q,
      execPath: EXEC,
      log: (e) => events.push(e),
    });
    expect(devResult).toEqual({ killed: [], stalePidFiles: 1 });
    expect(a.killed).toEqual([]);
    expect(events).toContain('reaper_pidfile_rejected');

    mk(packed.llamaServerExe);
    const b = spy(packed.llamaServerExe);
    const packedResult = await reapOrphans(dev.runDir, packed.resourcesDir, {
      processQuery: b.q,
      execPath: EXEC,
    });
    expect(packedResult).toEqual({ killed: ['llama'], stalePidFiles: 0 });
    expect(b.killed).toEqual([4242]);
  });
});
