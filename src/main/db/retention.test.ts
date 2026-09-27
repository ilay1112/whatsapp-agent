// TESTS 5.3 row `db/*`: retention nulls item_messages.text, the proposal text columns AND actions.canonical_json /
// approved_final_json (terminal rows only - a pending row older than the window is untouched) but keeps every hash;
// `data:purgeNow` deletes `backups\*` and leaves exactly one fresh backup.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupNow } from './backup';
import { CLOSED_ITEM_MAX_AGE_MS, LOG_MAX_AGE_MS, runRetention } from './retention';
import {
  cleanup,
  fileRepos,
  JID_A,
  JID_B,
  memRepos,
  seedChat,
  seedOpenItem,
  seedPendingAction,
  seedProposal,
  seedRetryChain,
  T0,
  tempDir,
} from './__fixtures__/testDb';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import type { Settings } from '../../shared/settings';
import type { Repos } from './index';

afterEach(cleanup);

const DAY = 24 * 3600_000;
const settingsWith =
  (retentionDays: number): (() => Settings) =>
  () => ({
    ...DEFAULT_SETTINGS,
    privacy: { ...DEFAULT_SETTINGS.privacy, retentionDays },
  });

/** An old item with a message snapshot, a proposal and a done action, plus a young pending action that must survive. */
function seedHistory(repos: Repos): { oldItemId: number; oldActionId: string; youngActionId: string } {
  const old = seedPendingAction(repos, T0 - 60 * DAY);
  repos.items.snapshotMessages(old.item.id, [
    {
      itemId: old.item.id,
      waMsgId: 'a',
      fromMe: false,
      ts: T0 - 60 * DAY,
      text: 'text to forget',
      textSha256: 'a'.repeat(64),
    },
  ]);
  repos.actions.markApprovedExecuting(old.action.id, '{"final":1}', T0 - 60 * DAY);
  repos.actions.markDone(old.action.id, { kind: 'send_reply', waMsgId: 'wa' }, T0 - 60 * DAY);

  const youngChat = seedChat(repos, JID_B, T0);
  const youngItem = seedOpenItem(repos, youngChat.id, T0, 'm-young');
  const youngProposal = seedProposal(repos, youngItem.id, T0);
  const young = repos.actions.insertPending({
    itemId: youngItem.id,
    proposalId: youngProposal.id,
    chatId: youngChat.id,
    payload: {
      v: 1,
      kind: 'send_reply',
      itemId: youngItem.id,
      chatRef: youngChat.id,
      proposalVersion: youngProposal.version,
      text: 'keep me',
    },
    now: T0,
  });
  return { oldItemId: old.item.id, oldActionId: old.action.id, youngActionId: young.id };
}

describe('repos.retention.purge', () => {
  it('nulls the text columns of old rows, keeps the hashes and never touches a young row', () => {
    const { repos } = memRepos();
    const ids = seedHistory(repos);
    const result = repos.retention.purge({ before: T0 - 30 * DAY, closedBefore: T0 - CLOSED_ITEM_MAX_AGE_MS });
    expect(result).toEqual({ textRows: 2, actionRows: 1, itemsDeleted: 0 });

    const message = repos.items.messages(ids.oldItemId)[0]!;
    expect(message.text).toBeNull();
    expect(message.textSha256).toBe('a'.repeat(64));
    const proposal = repos.proposals.current(ids.oldItemId)!;
    expect(proposal).toMatchObject({ draftText: null, extraction: null, event: null, freeBusy: null });
    const purged = repos.actions.byId(ids.oldActionId)!;
    expect(purged.canonicalJson).toBe(''); // NULL in the DB, '' to the app
    expect(purged.approvedFinalJson).toBeNull();
    expect(purged.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    const young = repos.actions.byId(ids.youngActionId)!;
    expect(young.canonicalJson).not.toBe('');
    expect(young.state).toBe('pending');
  });

  it('is idempotent: a second pass finds nothing left to null (the frozen trigger would abort it)', () => {
    const { repos } = memRepos();
    seedHistory(repos);
    const window = { before: T0 - 30 * DAY, closedBefore: T0 - CLOSED_ITEM_MAX_AGE_MS };
    repos.retention.purge(window);
    expect(repos.retention.purge(window)).toEqual({ textRows: 0, actionRows: 0, itemsDeleted: 0 });
  });

  it('leaves an OLD PENDING action alone - only terminal rows may lose their payload', () => {
    const { repos } = memRepos();
    const { action } = seedPendingAction(repos, T0 - 60 * DAY);
    expect(repos.retention.purge({ before: T0, closedBefore: T0 - CLOSED_ITEM_MAX_AGE_MS }).actionRows).toBe(0);
    expect(repos.actions.byId(action.id)!.canonicalJson).not.toBe('');
  });

  it('deletes closed items after the closed-item window, with everything that hangs off them', () => {
    const { db, repos } = memRepos();
    const { item, action } = seedPendingAction(repos, T0 - 200 * DAY);
    repos.items.snapshotMessages(item.id, [
      { itemId: item.id, waMsgId: 'a', fromMe: false, ts: T0 - 200 * DAY, text: 'x', textSha256: 'a'.repeat(64) },
    ]);
    repos.runs.start({ itemId: item.id, stage: 'extract', provider: 'local', model: 'm', startedAt: T0 - 200 * DAY });
    repos.items.update(item.id, { closedReason: 'replied' }, T0 - 200 * DAY);
    const result = repos.retention.purge({ before: T0 - 30 * DAY, closedBefore: T0 - CLOSED_ITEM_MAX_AGE_MS });
    expect(result.itemsDeleted).toBe(1);
    expect(repos.items.byId(item.id)).toBeNull();
    expect(repos.actions.byId(action.id)).toBeNull();
    expect(db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM item_messages`).get()!.n).toBe(0);
    expect(db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM runs`).get()!.n).toBe(0);
    expect(db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM proposals`).get()!.n).toBe(0);
    // the chat row itself survives (it carries the user's policy choices)
    expect(repos.chats.byJid(JID_A)).not.toBeNull();
  });

  /**
   * Regression, data-integrity-1: `actions.retry_of ... ON DELETE SET NULL` fires `trg_actions_frozen`, so deleting an action
   * that some retry clone points at used to abort the statement with 'approved content is immutable'. One failed send in the
   * app's lifetime was enough to make every later `DELETE FROM items` roll the WHOLE purge transaction back - nothing was ever
   * purged again, and `data:purgeNow` answered INTERNAL.
   */
  it('deletes a closed item that carries a retry chain (the FK SET NULL must not trip the frozen trigger)', () => {
    const { db, repos } = memRepos();
    const { item, parent, clone } = seedRetryChain(repos, T0 - 200 * DAY);
    repos.items.update(item.id, { closedReason: 'dismissed' }, T0 - 200 * DAY);
    const result = repos.retention.purge({ before: T0 - 30 * DAY, closedBefore: T0 - CLOSED_ITEM_MAX_AGE_MS });
    expect(result.itemsDeleted).toBe(1);
    expect(repos.actions.byId(parent.id)).toBeNull();
    expect(repos.actions.byId(clone.id)).toBeNull();
    expect(db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM actions`).get()!.n).toBe(0);
    // the earlier text-nulling of the same transaction survived too (a rollback would have restored it)
    expect(db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM items`).get()!.n).toBe(0);
  });

  it('nulls a terminal retry parent whose clone still points at it, then deletes the pair', () => {
    const { repos } = memRepos();
    const { item, parent, clone } = seedRetryChain(repos, T0 - 200 * DAY);
    // pass 1: the item is still open, so only the payload columns are dropped
    const first = repos.retention.purge({ before: T0 - 30 * DAY, closedBefore: T0 - CLOSED_ITEM_MAX_AGE_MS });
    expect(first.itemsDeleted).toBe(0);
    expect(repos.actions.byId(parent.id)!.canonicalJson).toBe(''); // NULL in the DB, '' to the app
    expect(repos.actions.byId(clone.id)!.state).toBe('pending'); // a live row keeps its payload
    // pass 2: the item closes and ages out - the cascade must still go through
    repos.items.update(item.id, { closedReason: 'dismissed' }, T0 - 200 * DAY);
    expect(
      repos.retention.purge({ before: T0 - 30 * DAY, closedBefore: T0 - CLOSED_ITEM_MAX_AGE_MS }).itemsDeleted,
    ).toBe(1);
    expect(repos.actions.byId(clone.id)).toBeNull();
  });
});

describe('runRetention (daily)', () => {
  it('derives the windows from settings, prunes the metadata tables after 180 days and audits the run', () => {
    const { db, repos } = memRepos();
    const ids = seedHistory(repos);
    const item = repos.items.byId(ids.oldItemId)!;
    const oldRun = repos.runs.start({
      itemId: item.id,
      stage: 'extract',
      provider: 'claude',
      model: 'm',
      startedAt: T0 - 200 * DAY,
    });
    repos.runs.finish(oldRun, { finishedAt: T0 - 200 * DAY, outcome: 'ok', inputTokens: 1, outputTokens: 1 });
    const freshRun = repos.runs.start({
      itemId: item.id,
      stage: 'draft',
      provider: 'claude',
      model: 'm',
      startedAt: T0 - DAY,
    });
    repos.audit.append('consent', null, {}, T0 - LOG_MAX_AGE_MS - 1);
    repos.audit.append('consent', null, {}, T0 - DAY);
    repos.rate.record('send_global', 'global', T0 - LOG_MAX_AGE_MS - 1);
    repos.rate.record('send_global', 'global', T0 - DAY);

    const run = runRetention({ repos, settings: settingsWith(30), now: () => T0 });
    expect(run).toMatchObject({ textRows: 2, actionRows: 1, itemsDeleted: 0, backupPath: null });
    expect(
      db
        .prepare<{ id: number }>(`SELECT id FROM runs`)
        .all()
        .map((r) => r.id),
    ).toEqual([freshRun]);
    expect(repos.rate.countSince('send_global', 'global', 0)).toBe(1);
    const audits = db
      .prepare<{ kind: string; detail_json: string }>(`SELECT kind, detail_json FROM audit_log ORDER BY id`)
      .all();
    expect(audits.map((a) => a.kind)).toEqual(['consent', 'purge']);
    expect(JSON.parse(audits[1]!.detail_json)).toMatchObject({
      mode: 'daily',
      retentionDays: 30,
      textRows: 2,
      actionRows: 1,
    });
  });

  it('a 90-day retention setting keeps text that a 30-day setting would drop', () => {
    const { repos } = memRepos();
    const ids = seedHistory(repos);
    expect(runRetention({ repos, settings: settingsWith(90), now: () => T0 }).textRows).toBe(0);
    expect(repos.items.messages(ids.oldItemId)[0]!.text).not.toBeNull();
  });
});

describe('runRetention (purgeNow)', () => {
  it('purges everything, wipes the backups directory and leaves exactly one fresh backup', () => {
    const dir = tempDir();
    const backupsDir = path.join(dir, 'backups');
    const { db, repos } = fileRepos(dir);
    const ids = seedHistory(repos);
    backupNow(db, { backupsDir, now: () => T0 - 2 * DAY });
    backupNow(db, { backupsDir, now: () => T0 - DAY });
    fs.writeFileSync(path.join(backupsDir, 'stray.db'), 'x');
    expect(fs.readdirSync(backupsDir)).toHaveLength(3);

    const run = runRetention({
      repos,
      settings: settingsWith(30),
      now: () => T0,
      mode: 'purgeNow',
      backups: { dir: backupsDir },
    });

    const files = fs.readdirSync(backupsDir);
    expect(files).toHaveLength(1);
    expect(run.backupPath).toBe(path.join(backupsDir, files[0]!));
    expect(repos.meta.get('last_backup_at')).toBe(String(T0));
    // retentionDays 0 => even the young rows lose their text
    expect(repos.actions.byId(ids.youngActionId)!.state).toBe('pending');
    expect(repos.items.messages(ids.oldItemId)[0]!.text).toBeNull();
    const audit = db.prepare<{ detail_json: string }>(`SELECT detail_json FROM audit_log WHERE kind='purge'`).get()!;
    expect(JSON.parse(audit.detail_json)).toMatchObject({ mode: 'purgeNow', retentionDays: 0 });
  });

  it('runs without a backups directory (in-memory database) and tolerates a missing one', () => {
    const { repos } = memRepos();
    seedHistory(repos);
    expect(runRetention({ repos, settings: settingsWith(30), now: () => T0, mode: 'purgeNow' }).backupPath).toBeNull();

    const dir = tempDir();
    const { repos: fileRepo } = fileRepos(dir);
    const missing = path.join(dir, 'no-such-dir');
    const run = runRetention({
      repos: fileRepo,
      settings: settingsWith(30),
      now: () => T0,
      mode: 'purgeNow',
      backups: { dir: missing, keep: 1 },
    });
    expect(fs.readdirSync(missing)).toHaveLength(1);
    expect(run.backupPath).not.toBeNull();
  });

  it('deletes through the injected fs slice', () => {
    const dir = tempDir();
    const { repos } = fileRepos(dir);
    const backupsDir = path.join(dir, 'backups');
    const removed: string[] = [];
    runRetention({
      repos,
      settings: settingsWith(30),
      now: () => T0,
      mode: 'purgeNow',
      backups: {
        dir: backupsDir,
        fs: {
          readdirSync: () => ['app-20260101.db', 'app-20260102.db'],
          rmSync: (target) => {
            removed.push(target);
          },
        },
      },
    });
    expect(removed).toEqual([path.join(backupsDir, 'app-20260101.db'), path.join(backupsDir, 'app-20260102.db')]);
  });
});
