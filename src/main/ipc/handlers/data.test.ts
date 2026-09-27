// TESTS 5.3 `ipc/*`: `data:purgeNow` runs the SAME retention job as the daily timer but in 'purgeNow' mode - ARCHITECTURE
// section 10 / db/retention.ts: retentionDays = 0, then `backups\` is wiped and one fresh copy is taken, "so purged text does
// not survive in the daily copies" (confirm:true is schema-enforced). `diagnostics:export` opens the save dialog in main - the
// chosen path never crosses IPC and the bundle is metadata only.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IPC_REQUEST_SCHEMAS } from '../../../shared/ipc';
import { backupNow } from '../../db/backup';
import { cleanup, fileRepos, JID_A, seedChat, seedOpenItem, T0, tempDir } from '../../db/__fixtures__/testDb';
import { makeFixture, NOW_0 } from '../register.fixtures';
import type { HandlerDeps } from '../register';
import { createDataHandlers } from './data';

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
    paths: { userData: dir, appDb: path.join(dir, 'app.db'), backupsDir } as HandlerDeps['paths'],
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
      paths: { userData: dir, backupsDir: path.join(dir, 'backups') } as HandlerDeps['paths'],
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
