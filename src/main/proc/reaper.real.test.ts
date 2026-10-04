// [v2-closeout] The startup orphan reaper against the REAL process table (no injected spawn, no fake ProcessQuery): the production
// `createWindowsProcessQuery()` runs the real powershell.exe query and the real `taskkill /PID <pid> /T /F`.
// Until this round the production query could never succeed (PS_QUERY_ARGS appended `-- <pid>` after `-Command`, which PowerShell folds
// into the script text: `$args[0]` was empty and `ConvertTo-Json -- <pid>` failed), so after a crash no orphan was ever reaped.
// Stand-ins are harmless node.exe children (the system node running this test): an "orphan" named by a pid file, and a BYSTANDER with the
// SAME image name and no pid file - it must survive, because the reaper matches pid + exact exe path + creation time, never an image name.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWindowsProcessQuery, reapOrphans } from './reaper';

const IS_WIN = process.platform === 'win32';
const children: ChildProcess[] = [];
const dirs: string[] = [];

/** Resolves once node has seen the child's 'exit' (the T7 leak guard reads exitCode / signalCode, not the OS table). */
const exited = (c: ChildProcess): Promise<void> =>
  c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : new Promise((r) => c.once('exit', () => r()));

afterEach(async () => {
  const all = children.splice(0);
  for (const c of all) if (c.exitCode === null && c.signalCode === null) c.kill();
  await Promise.all(all.map(exited));
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A harmless node.exe sleeper (same image name as the "orphan"): only the test's own children are ever started or killed. */
function sleeper(): { child: ChildProcess; startedAt: number } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const startedAt = Date.now();
  children.push(child);
  if (child.pid === undefined) throw new Error('sleeper did not start');
  return { child, startedAt };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitDead(pid: number, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

function runDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-reaper-real-'));
  dirs.push(d);
  return d;
}

describe.runIf(IS_WIN)('reaper - the production process query on the real process table', () => {
  it('query(pid) returns the exact exe path and a creation time of a live process (this test runner)', async () => {
    const q = createWindowsProcessQuery();
    const info = await q.query(process.pid);
    expect(info).not.toBeNull();
    expect(info!.pid).toBe(process.pid);
    expect(info!.executablePath?.toLowerCase()).toBe(process.execPath.toLowerCase());
    // the runner started before now and (generously) within the last day
    expect(info!.creationDate).not.toBeNull();
    expect(info!.creationDate!).toBeLessThanOrEqual(Date.now());
    expect(info!.creationDate!).toBeGreaterThan(Date.now() - 24 * 3600_000);
  }, 30_000);

  it('query(pid) of a child agrees with its spawn time within the 2 s tolerance', async () => {
    const { child, startedAt } = sleeper();
    const info = await createWindowsProcessQuery().query(child.pid!);
    expect(info).not.toBeNull();
    expect(info!.executablePath?.toLowerCase()).toBe(process.execPath.toLowerCase());
    expect(Math.abs(info!.creationDate! - startedAt)).toBeLessThanOrEqual(2_000);
  }, 30_000);

  it('a dead pid answers null (no throw)', async () => {
    const { child } = sleeper();
    const pid = child.pid!;
    child.kill();
    expect(await waitDead(pid)).toBe(true);
    expect(await createWindowsProcessQuery().query(pid)).toBeNull();
  }, 30_000);

  it('reaps a crash orphan named by a supervisor pid file and a CLI job pid file; a same-image bystander survives', async () => {
    const dir = runDir();
    const orphan = sleeper(); // stands in for an orphaned llama-server / bridge child
    const cliOrphan = sleeper(); // stands in for an orphaned claude.exe job (its recorded exe path is node.exe here)
    const bystander = sleeper(); // same image name (node.exe), NO pid file: e.g. the user's own copy of the program
    const recycled = sleeper(); // a pid file naming a live pid whose creation time does not match (pid reuse)
    fs.writeFileSync(
      path.join(dir, 'llama.pid.json'),
      JSON.stringify({ pid: orphan.child.pid, exePath: process.execPath, startedAt: orphan.startedAt }),
    );
    fs.writeFileSync(
      path.join(dir, `job-cli-${randomUUID()}.pid.json`),
      JSON.stringify({ pid: cliOrphan.child.pid, exePath: process.execPath, startedAt: cliOrphan.startedAt }),
    );
    fs.writeFileSync(
      path.join(dir, 'bridge.pid.json'),
      JSON.stringify({ pid: recycled.child.pid, exePath: process.execPath, startedAt: recycled.startedAt - 3_600_000 }),
    );
    const events: string[] = [];
    const res = await reapOrphans(dir, [], {
      execPath: process.execPath,
      acceptedCliExePaths: [process.execPath],
      log: (e) => void events.push(e),
    });
    expect(res.killed.sort()).toEqual(['job-cli', 'llama']);
    expect(res.stalePidFiles).toBe(1); // the recycled pid: stale, discarded, NOT killed
    await Promise.all([exited(orphan.child), exited(cliOrphan.child)]); // killed by the reaper (taskkill), never by the test
    expect(await waitDead(orphan.child.pid!)).toBe(true);
    expect(await waitDead(cliOrphan.child.pid!)).toBe(true);
    expect(alive(bystander.child.pid!)).toBe(true);
    expect(alive(recycled.child.pid!)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]); // every pid file consumed
    expect(events.filter((e) => e === 'reaper_kill')).toHaveLength(2);
  }, 60_000);
});
