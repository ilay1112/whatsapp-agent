// TESTS 5.3 `ipc/*`: `data:purgeNow` runs the SAME retention job as the daily timer but in 'purgeNow' mode - ARCHITECTURE
// section 10 / db/retention.ts: retentionDays = 0, then `backups\` is wiped and one fresh copy is taken, "so purged text does
// not survive in the daily copies" (confirm:true is schema-enforced). `diagnostics:export` opens the save dialog in main - the
// chosen path never crosses IPC and the bundle is metadata only.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_REQUEST_SCHEMAS } from '../../../shared/ipc';
import { backupNow } from '../../db/backup';
import { cleanup, fileRepos, JID_A, seedChat, seedOpenItem, T0, tempDir } from '../../db/__fixtures__/testDb';
import { makeFixture, NOW_0 } from '../register.fixtures';
import type { HandlerDeps } from '../register';
import { agyTranscriptEntriesOf, createDataHandlers, purgeDirsOf, wipeDirContents } from './data';
import type { AutoPolicyRecord } from '../../../shared/types';

const CTX = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };
const DAY_MS = 24 * 3600_000;

afterEach(cleanup);

/**
 * A real on-disk database + backups directory behind the handler: the purgeNow contract is about files and SQL rows, so a
 * `repos.retention.purge` spy could not see either half of it. `NOW_0` and the db fixtures' `T0` are the same instant.
 */
function purgeFixture(over: Partial<HandlerDeps> = {}): {
  f: ReturnType<typeof makeFixture>;
  db: ReturnType<typeof fileRepos>['db'];
  repos: ReturnType<typeof fileRepos>['repos'];
  backupsDir: string;
  itemId: ReturnType<typeof seedOpenItem>['id'];
  /** The synthetic text seeded into `item_messages` - young enough that a 30-day window would keep it. */
  text: string;
} {
  const dir = tempDir('wca-purge-');
  const backupsDir = path.join(dir, 'backups');
  const { db, repos } = fileRepos(dir);
  const text = 'ZZPURGESENTINELZZ';
  const minuteAgo = (T0 - 60_000) as typeof T0;
  const chat = seedChat(repos, JID_A, minuteAgo);
  const item = seedOpenItem(repos, chat.id, minuteAgo, 'm-young');
  repos.items.snapshotMessages(item.id, [
    { itemId: item.id, waMsgId: 'a', fromMe: false, ts: minuteAgo, text, textSha256: 'a'.repeat(64) },
  ]);
  const f = makeFixture({
    repos,
    paths: {
      userData: dir,
      appDb: path.join(dir, 'app.db'),
      backupsDir,
      // [V2] the four dirs data:purgeNow wipes (C2 16.1)
      mediaCacheDir: path.join(dir, 'media-cache'),
      voiceTmpDir: path.join(dir, 'voice', 'tmp'),
      cliRunsDir: path.join(dir, 'cli-runs'),
      agyWorkspaceDir: path.join(dir, 'agy-workspace'),
    } as HandlerDeps['paths'],
    ...over,
  });
  return { f, db, repos, backupsDir, itemId: item.id, text };
}

describe('the destructive channels are confirmation-gated by the contract', () => {
  it('data:purgeNow accepts only { confirm: true } and no window override', () => {
    const schema = IPC_REQUEST_SCHEMAS['data:purgeNow'];
    expect(schema.safeParse({ confirm: true }).success).toBe(true);
    expect(schema.safeParse({ confirm: false }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ confirm: true, before: 0 }).success).toBe(false);
    expect(schema.safeParse({ confirm: true, retentionDays: 0 }).success).toBe(false);
  });

  it('diagnostics:export takes no request (the save dialog is main-side)', () => {
    expect(IPC_REQUEST_SCHEMAS['diagnostics:export'].safeParse(undefined).success).toBe(true);
    expect(IPC_REQUEST_SCHEMAS['diagnostics:export'].safeParse({ path: 'C:\\Users\\x\\diag.zip' }).success).toBe(false);
  });
});

describe('data:purgeNow', () => {
  it('ignores settings.privacy.retentionDays: even text inside the window is NULLed (retentionDays = 0)', async () => {
    const { f, repos, itemId, text } = purgeFixture();
    f.state.settings.privacy.retentionDays = 30; // the default; the message below is minutes old, not 30 days

    const res = await createDataHandlers(f.deps)['data:purgeNow']({ confirm: true }, CTX);

    expect(res).toEqual({ ok: true, value: { itemsPurged: 0 } });
    const message = repos.items.messages(itemId)[0]!;
    expect(message.text, `"Delete now" left the text in app.db (${text} still readable)`).toBeNull();
    expect(message.textSha256).toBe('a'.repeat(64)); // the hash is metadata and stays
  });

  it('wipes `backups\\` and leaves exactly one fresh copy, so no daily copy keeps the purged text', async () => {
    const { f, db, repos, backupsDir, text } = purgeFixture();
    backupNow(db, { backupsDir, now: () => NOW_0 - DAY_MS }); // yesterday's daily copy, holding that text
    fs.writeFileSync(path.join(backupsDir, 'stray.db'), text);
    expect(fs.readdirSync(backupsDir)).toHaveLength(2);

    await createDataHandlers(f.deps)['data:purgeNow']({ confirm: true }, CTX);

    const files = fs.readdirSync(backupsDir);
    expect(files, 'the old backups survived the purge').toHaveLength(1);
    const fresh = fs.readFileSync(path.join(backupsDir, files[0]!), 'latin1');
    expect(fresh, 'the fresh backup was taken before the purge').not.toContain(text);
    expect(repos.meta.get('last_backup_at')).toBe(String(NOW_0));
  });

  it('prunes runs/audit_log/rate_events older than 180 days, which the bare repo call never did', async () => {
    const { f, db, repos, itemId } = purgeFixture();
    const LOG_MAX_AGE_MS = 180 * DAY_MS;
    const oldRun = repos.runs.start({
      itemId,
      stage: 'extract',
      provider: 'local',
      model: 'm',
      startedAt: NOW_0 - LOG_MAX_AGE_MS - 1,
    });
    repos.runs.finish(oldRun, {
      finishedAt: NOW_0 - LOG_MAX_AGE_MS - 1,
      outcome: 'ok',
      inputTokens: 1,
      outputTokens: 1,
    });
    repos.rate.record('send_global', 'global', NOW_0 - LOG_MAX_AGE_MS - 1);
    repos.rate.record('send_global', 'global', NOW_0 - DAY_MS);

    await createDataHandlers(f.deps)['data:purgeNow']({ confirm: true }, CTX);

    expect(db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM runs`).get()!.n).toBe(0);
    expect(repos.rate.countSince('send_global', 'global', 0)).toBe(1);
  });

  it('writes ONE purge audit row - the job owns it - carrying the mode and row COUNTS, never a body or a name', async () => {
    const { f, db } = purgeFixture();

    await createDataHandlers(f.deps)['data:purgeNow']({ confirm: true }, CTX);

    expect(f.rec.audits, 'the handler must not append a second, poorer purge row').toEqual([]);
    const rows = db.prepare<{ detail_json: string }>(`SELECT detail_json FROM audit_log WHERE kind='purge'`).all();
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0]!.detail_json) as Record<string, unknown>;
    expect(detail).toEqual({ mode: 'purgeNow', retentionDays: 0, textRows: 1, actionRows: 0, itemsDeleted: 0 });
    for (const [key, value] of Object.entries(detail)) {
      if (key !== 'mode') expect(typeof value).toBe('number');
    }
  });

  it('a purge that found nothing to delete still answers ok', async () => {
    const dir = tempDir('wca-purge-empty-');
    const { repos } = fileRepos(dir);
    const f = makeFixture({
      repos,
      paths: {
        userData: dir,
        backupsDir: path.join(dir, 'backups'),
        mediaCacheDir: path.join(dir, 'media-cache'),
        voiceTmpDir: path.join(dir, 'voice', 'tmp'),
        cliRunsDir: path.join(dir, 'cli-runs'),
        agyWorkspaceDir: path.join(dir, 'agy-workspace'),
      } as HandlerDeps['paths'],
    });
    expect(await createDataHandlers(f.deps)['data:purgeNow']({ confirm: true }, CTX)).toEqual({
      ok: true,
      value: { itemsPurged: 0 },
    });
  });
});

describe('diagnostics:export', () => {
  it('reports whether the injected exporter saved, and returns no path either way', async () => {
    for (const saved of [true, false]) {
      const f = makeFixture();
      f.deps.exportDiagnostics = async () => saved;
      const res = await createDataHandlers(f.deps)['diagnostics:export'](undefined, CTX);
      expect(res).toEqual({ ok: true, value: { saved } });
      expect(Object.keys((res as { value: object }).value)).toEqual(['saved']);
    }
  });

  it('the handler itself opens no dialog and reads no repo - the exporter owns both', async () => {
    let calls = 0;
    const f = makeFixture();
    f.deps.exportDiagnostics = async () => {
      calls += 1;
      return true;
    };
    await createDataHandlers(f.deps)['diagnostics:export'](undefined, CTX);
    expect(calls).toBe(1);
    expect(f.rec.saveDialogs).toEqual([]);
    expect(f.rec.audits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [V2] C2 16.1 / T2 5: purgeNow also wipes media-cache/, voice/tmp/, cli-runs/, agy-workspace/runs/ and disables a live policy.
// ---------------------------------------------------------------------------------------------------------------------
describe('[V2] data:purgeNow - job / media dirs and the automatic policy', () => {
  const plant = (dir: string, name: string, body = 'SENTINEL_TRANSCRIPT'): void => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  };

  it('wipes the CONTENTS of the four dirs (nested run dirs included) and keeps everything else', async () => {
    const { f } = purgeFixture();
    const p = f.deps.paths;
    plant(p.mediaCacheDir, 'abc.jpg');
    plant(p.mediaCacheDir, 'abc.thumb.jpg');
    plant(p.voiceTmpDir, 'job.wav');
    plant(path.join(p.cliRunsDir, 'run-1'), 'prompt.txt');
    plant(path.join(p.agyWorkspaceDir, 'runs', 'run-2', '.agents'), 'wca-extract.md');
    plant(path.join(p.agyWorkspaceDir, 'keep'), 'trusted.json', '{}'); // outside runs: not ours to wipe
    plant(path.join(p.userData, 'models'), 'tiny.gguf', 'GGUF');

    await createDataHandlers(f.deps)['data:purgeNow']({ confirm: true }, CTX);

    for (const dir of purgeDirsOf(p)) expect(fs.readdirSync(dir), dir).toEqual([]);
    expect(fs.existsSync(path.join(p.agyWorkspaceDir, 'keep', 'trusted.json'))).toBe(true);
    expect(fs.existsSync(path.join(p.userData, 'models', 'tiny.gguf'))).toBe(true);
  });

  it('purgeDirsOf names exactly the four C2 16.1 dirs', () => {
    const { f } = purgeFixture();
    const p = f.deps.paths;
    expect(purgeDirsOf(p)).toEqual([
      p.mediaCacheDir,
      p.voiceTmpDir,
      p.cliRunsDir,
      path.win32.join(p.agyWorkspaceDir, 'runs'),
    ]);
  });

  it('wipeDirContents: a missing dir is empty; one busy entry is skipped and counted, the rest still go', () => {
    expect(
      wipeDirContents('C:/no/such/dir', {
        readdirSync: () => {
          throw new Error('ENOENT');
        },
        rmSync: () => {},
      }),
    ).toEqual({
      removed: 0,
      failed: 0,
    });
    const removed: string[] = [];
    const res = wipeDirContents('C:/x', {
      readdirSync: () => ['a', 'busy', 'b'],
      rmSync: (p) => {
        if (p.endsWith('busy')) throw new Error('EBUSY');
        removed.push(p);
      },
    });
    expect(res).toEqual({ removed: 2, failed: 1 });
    expect(removed).toEqual(['C:\\x\\a', 'C:\\x\\b']);
  });

  it('a kept entry is logged by COUNT only, never by name', async () => {
    const { f } = purgeFixture();
    const handlers = createDataHandlers(f.deps, undefined, {
      readdirSync: (d) => (d === f.deps.paths.voiceTmpDir ? ['SENTINEL_NAME.wav'] : []),
      rmSync: () => {
        throw new Error('EBUSY SENTINEL_NAME.wav');
      },
    });
    await handlers['data:purgeNow']({ confirm: true }, CTX);
    expect(f.rec.logs).toContainEqual({ level: 'warn', event: 'purge_dir_entries_kept', meta: { count: 1 } });
    expect(JSON.stringify(f.rec.logs)).not.toContain('SENTINEL_NAME');
  });

  it('disables a live policy through the policy service with reason purge', async () => {
    const { f, repos } = purgeFixture();
    const live = { id: '44444444-4444-4444-8444-444444444444', state: 'on' } as AutoPolicyRecord;
    const liveSpy = vi.spyOn(repos.autoPolicies, 'live').mockReturnValue(live);
    const setState = vi.spyOn(repos.autoPolicies, 'setState');
    const disable = vi.fn(() => ({ ok: true as const, value: {} as never }));
    await createDataHandlers(f.deps, { autoPolicy: { disable } })['data:purgeNow']({ confirm: true }, CTX);
    expect(disable).toHaveBeenCalledWith('purge');
    expect(setState).not.toHaveBeenCalled();
    liveSpy.mockRestore();
  });

  it('falls back to a direct disabled write + audit when the service is not wired, refuses or throws; no live policy => nothing', async () => {
    const live = { id: '44444444-4444-4444-8444-444444444444', state: 'on' } as AutoPolicyRecord;
    const variants: Array<Parameters<typeof createDataHandlers>[1]> = [
      undefined,
      { autoPolicy: { disable: () => ({ ok: false as const, error: { code: 'INTERNAL' as const } }) } },
      {
        autoPolicy: {
          disable: () => {
            throw new Error('boom');
          },
        },
      },
    ];
    for (const v2 of variants) {
      const { f, repos } = purgeFixture();
      vi.spyOn(repos.autoPolicies, 'live').mockReturnValue(live);
      const setState = vi.spyOn(repos.autoPolicies, 'setState').mockReturnValue(live);
      await createDataHandlers(f.deps, v2)['data:purgeNow']({ confirm: true }, CTX);
      expect(setState).toHaveBeenCalledWith(live.id, { state: 'disabled', reason: 'purge', at: NOW_0 });
      expect(f.rec.audits).toContainEqual({
        kind: 'auto_policy_disabled',
        ref: live.id,
        detail: { reason: 'purge' },
        now: NOW_0,
      });
      vi.restoreAllMocks();
    }
    const { f, repos } = purgeFixture();
    const setState = vi.spyOn(repos.autoPolicies, 'setState');
    const disable = vi.fn();
    await createDataHandlers(f.deps, { autoPolicy: { disable } })['data:purgeNow']({ confirm: true }, CTX);
    expect(disable).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });
});

// [v2-closeout cli-sandbox-5] In the isolated agy profile (F3) HOME / USERPROFILE = <userData>/agy-home, and agy writes every headless
// conversation - the nonce block with the WhatsApp text and the prefetched chat context - under .gemini/antigravity-cli/{brain,
// conversations, history.jsonl} (and its logs). "Delete all data now" left all of it on disk. The purge now removes exactly those
// entries; the app-written settings.json (the trusted workspace) and anything else of the profile stay.
describe('[v2-closeout] data:purgeNow - the Antigravity isolated profile (cli-sandbox-5)', () => {
  const plant = (dir: string, name: string, body = 'SENTINEL_AGY_TRANSCRIPT'): void => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  };
  it('removes brain/, conversations/, history.jsonl and the agy logs; keeps settings.json and the rest of agy-home', async () => {
    const { f } = purgeFixture();
    const agy = path.join(f.deps.paths.userData, 'agy-home', '.gemini', 'antigravity-cli');
    plant(path.join(agy, 'brain', 'conv-1', 'step'), 'transcript.jsonl');
    plant(path.join(agy, 'conversations'), 'conv-1.json');
    plant(agy, 'history.jsonl');
    plant(path.join(agy, 'log'), 'agy.log');
    plant(agy, 'cli.log');
    plant(agy, 'settings.json', '{"trustedWorkspaces":[]}');
    plant(path.join(f.deps.paths.userData, 'agy-home', 'AppData', 'Roaming'), 'keep.txt', 'k');

    await createDataHandlers(f.deps)['data:purgeNow']({ confirm: true }, CTX);

    expect(fs.readdirSync(agy)).toEqual(['settings.json']);
    expect(fs.readFileSync(path.join(agy, 'settings.json'), 'utf8')).toBe('{"trustedWorkspaces":[]}');
    expect(fs.existsSync(path.join(f.deps.paths.userData, 'agy-home', 'AppData', 'Roaming', 'keep.txt'))).toBe(true);
  });
  it('no agy profile at all is fine (nothing attempted); a busy transcript is kept and logged by count only', async () => {
    const { f } = purgeFixture();
    expect(await createDataHandlers(f.deps)['data:purgeNow']({ confirm: true }, CTX)).toMatchObject({ ok: true });
    const agy = path.win32.join(f.deps.paths.userData, 'agy-home', '.gemini', 'antigravity-cli');
    const handlers = createDataHandlers(f.deps, undefined, {
      readdirSync: (d) =>
        path.win32.normalize(d) === path.win32.normalize(agy) ? ['brain', 'settings.json', 'history.jsonl'] : [],
      rmSync: (p) => {
        if (p.endsWith('brain')) throw new Error('EBUSY SENTINEL_AGY');
      },
    });
    await handlers['data:purgeNow']({ confirm: true }, CTX);
    expect(f.rec.logs).toContainEqual({ level: 'warn', event: 'purge_dir_entries_kept', meta: { count: 1 } });
    expect(JSON.stringify(f.rec.logs)).not.toContain('SENTINEL_AGY');
  });
  it('agyTranscriptEntriesOf names exactly the agy transcript / log entries under the isolated profile', () => {
    const { f } = purgeFixture();
    const base = path.win32.join(f.deps.paths.userData, 'agy-home', '.gemini', 'antigravity-cli');
    expect(agyTranscriptEntriesOf(f.deps.paths)).toEqual(
      ['brain', 'conversations', 'history.jsonl', 'log', 'cli.log'].map((n) => path.win32.join(base, n)),
    );
  });
});
