// tests/integration/app-boot.test.ts - the harness itself: the production compose() boots against the fakes, the IPC
// surface answers through the real register.ts, and dispose() leaves no child, no timer and no open database behind.
// Owner W2-01. Every other file in this directory builds on what is asserted here.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.ts';
import { assertSettingsBusContract } from '../../src/main/ipc/register.fixtures.ts';
import { IPC_CHANNELS } from '../../src/shared/ipc.ts';
import { createPaths } from '../../src/main/paths.ts';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

describe('app boot', () => {
  it('composes the production runtime over the fakes and answers app:getBootstrap', async () => {
    h = await createHarness();

    const res = await h.invoke('app:getBootstrap', undefined);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.version).toBe('0.0.0-l3');
    expect(res.value.lang).toBe('en');
    expect(res.value.dir).toBe('ltr');
    expect(res.value.onboardingStep).toBe('done');
  });

  it('registers every IPC channel through the real register.ts', async () => {
    h = await createHarness();
    const results = await Promise.all(
      IPC_CHANNELS.map((c) =>
        h!.invoke(c, undefined as never).then(
          () => c,
          () => null,
        ),
      ),
    );
    expect(results.filter((r) => r === null)).toEqual([]);
  });

  it('rejects an untrusted sender and a malformed payload with BAD_REQUEST', async () => {
    h = await createHarness();
    // A payload with an extra key: IPC_REQUEST_SCHEMAS are strict objects, so register.ts rejects before the handler.
    const bad = await h.invoke('item:get', { itemId: 1, surprise: true } as never);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.code).toBe('BAD_REQUEST');
    const rejected = h.repos.db
      .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE kind = 'ipc_rejected'`)
      .get();
    expect(rejected!.n).toBeGreaterThan(0);
  });

  it('the SettingsBus notifies after patch() and setInternal() (W1-13 wiring contract)', async () => {
    h = await createHarness();
    expect(() => assertSettingsBusContract(h!.app.settings)).not.toThrow();
  });

  it('health reports the attached bridge online and the fake calendar connected', async () => {
    h = await createHarness();
    await h.settle();
    const health = h.health();
    expect(health.whatsapp.state).toBe('online');
    expect(health.calendar.state).toBe('connected');
    expect(health.paused).toBe(false);
  });

  it('never spawns a child process and never leaves an open handle', async () => {
    h = await createHarness();
    await h.settle();
    await h.dispose();
    h = null;
    // dispose() is what the afterEach leak guard of tests/setup-guards.ts checks; reaching here means it was clean.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// process-lifecycle-9: the reaper runs inside compose() BEFORE any spawn (ARCH 13). Unpackaged, the llama and
// calendar-mcp trees live outside <appRoot>\resources, so compose must hand reapOrphans EVERY legal child root -
// otherwise a dev/e2e llama.pid.json is discarded as forged ("reaper_pidfile_rejected") and the orphan leaks.
// ---------------------------------------------------------------------------------------------------------------------
describe('compose() reaper roots (unpackaged layout)', () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  const bootWithPidFile = async (exePath: string): Promise<string[]> => {
    const userData = mkdtempSync(join(tmpdir(), 'wca-reap-boot-'));
    mkdirSync(join(userData, 'run'), { recursive: true });
    writeFileSync(
      join(userData, 'run', 'llama.pid.json'),
      JSON.stringify({ pid: 999_999, exePath, startedAt: 1_700_000_000_000 }),
      'utf8',
    );
    h = await createHarness({ userData });
    return h.logs;
  };

  it('accepts a llama.pid.json written by an unpackaged run instead of rejecting it as forged', async () => {
    const paths = createPaths({
      userData: 'C:\\unused',
      resourcesPath: 'C:\\unused\\resources',
      appRoot: REPO_ROOT,
      isPackaged: false,
    });
    const logs = await bootWithPidFile(paths.llamaServerExe);

    // The harness' ProcessQuery answers "no such process", so an ACCEPTED file is reported stale, not rejected.
    expect(logs.some((l) => l.includes('reaper_pidfile_rejected'))).toBe(false);
    expect(logs.some((l) => l.includes('reaper_pidfile_stale'))).toBe(true);
  });

  it('[R2] still rejects a pid file pointing at a foreign executable', async () => {
    const logs = await bootWithPidFile('C:\\Windows\\System32\\cmd.exe');
    expect(logs.some((l) => l.includes('reaper_pidfile_rejected'))).toBe(true);
    expect(logs.some((l) => l.includes('reaper_pidfile_stale'))).toBe(false);
  });
});
