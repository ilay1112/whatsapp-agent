// Scratch reproductions for ops/agent-notes/v2-review-data-integrity-v4.md (NOT part of npm test; never under tests/).
// Every `it` asserts the CORRECT behaviour, so each one FAILS on the current code and names the finding it proves.
// Synthetic data only (T5): JIDs 9725500000NN@s.whatsapp.net / a synthetic @lid, synthetic event ids, no message text.
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMediaCache, type MediaCacheFs } from '../../../src/main/media/mediaCache';
import type { NormalizedImage } from '../../../src/main/media/normalizeImage';
import { runRetention } from '../../../src/main/db/retention';
import {
  cleanup,
  JID_B,
  LID_JID,
  memRepos,
  seedChat,
  seedOpenItem,
} from '../../../src/main/db/__fixtures__/testDb';
import { reconcileUnknown } from '../../../src/main/exec/reconcile';
import { CTX, makeExecRig } from '../../../tests/helpers/ledger.execRig';
import type { Rig, RigOptions } from '../../../tests/helpers/ledger.execRig';
import type { McpWriteClient } from '../../../src/main/mcp/writeClient';
import type { ApprovalAction, ChatRef, EpochMs, Item, ItemId, Sha256Hex } from '../../../src/shared/types';
import type { Settings } from '../../../src/shared/settings';

const DAY = 24 * 3600_000;
const MIN = 60_000;
const sha = (t: string | Uint8Array): Sha256Hex => createHash('sha256').update(t).digest('hex') as Sha256Hex;
const realFs: MediaCacheFs = {
  writeFileSync: (p, d) => nodeFs.writeFileSync(p, d),
  readFileSync: (p) => nodeFs.readFileSync(p),
  rmSync: (p, o) => nodeFs.rmSync(p, o),
  mkdirSync: (p, o) => {
    nodeFs.mkdirSync(p, o);
  },
};
const picture = (): NormalizedImage => {
  const jpeg = new Uint8Array(64).fill(0x42);
  return {
    jpeg,
    width: 10,
    height: 20,
    sha256: sha(jpeg),
    thumbDataUrl: `data:image/jpeg;base64,${Buffer.from(Uint8Array.of(0xff, 0xd8, 7, 0xff, 0xd9)).toString('base64')}`,
    sourceMime: 'image/png',
  };
};

const rigs: Rig[] = [];
const roots: string[] = [];
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.stop();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  cleanup();
});
async function rig(opts: RigOptions = {}): Promise<Rig> {
  const r = await makeExecRig(opts);
  rigs.push(r);
  return r;
}
const actionOf = (r: Rig, id: string): ApprovalAction => r.repos.actions.byId(id as never)!;
const itemOf = (r: Rig, id: number): Item => r.repos.items.byId(id as never)!;

// ---------------------------------------------------------------------------------------------------------------------
describe('data-integrity-v4-1: retention names media files by the IMAGE hash, the cache writes them under hash(chatRef|waMsgId)', () => {
  it('the daily retention job removes the picture files of the media_cache rows it deleted', () => {
    const root = mkdtempSync(join(tmpdir(), 'wca-di4-'));
    roots.push(root);
    const dir = join(root, 'media-cache');
    const { repos } = memRepos();
    const chat = seedChat(repos);
    const cache = createMediaCache({ dir, repos, fs: realFs, hash: (t) => sha(t) });
    cache.put(chat.id, 'IMGMSG0001', picture());
    expect(readdirSync(dir)).toHaveLength(2); // <h>.jpg + <h>.thumb.jpg

    const now = (Date.now() + 31 * DAY) as EpochMs;
    const run = runRetention({
      repos,
      settings: () => ({ privacy: { retentionDays: 30 } }) as unknown as Settings,
      now: () => now,
    });
    // compose.ts RETENTION timer, verbatim logic
    for (const name of run.mediaFiles) {
      if (basename(name) !== name || name.includes('..')) continue;
      nodeFs.rmSync(join(dir, name), { force: true });
    }
    expect(repos.mediaCache.get(chat.id, 'IMGMSG0001')).toBeNull(); // the row IS gone ...
    expect(readdirSync(dir)).toEqual([]); // ... FAILS: both files stay on disk forever (no row names them any more)
  });
});

describe('data-integrity-v4-2: an @lid merge re-keys media_cache.chat_id, orphaning the files named after the OLD chatRef', () => {
  it('after the merge the item still shows its picture and Dismiss still deletes the files', () => {
    const root = mkdtempSync(join(tmpdir(), 'wca-di4-'));
    roots.push(root);
    const dir = join(root, 'media-cache');
    const { repos } = memRepos();
    const lid = repos.chats.upsertFromBridge(LID_JID, null, true, 1_760_000_000_000 as EpochMs);
    seedChat(repos, JID_B);
    const item = seedOpenItem(repos, lid.id);
    const cache = createMediaCache({ dir, repos, fs: realFs, hash: (t) => sha(t) });
    const rec = cache.put(lid.id, 'IMGMSG0002', picture());
    repos.mediaCache.upsert({ ...rec, itemId: item.id }); // compose.pickImage link
    expect(cache.thumb(item.id)).not.toBeNull();

    repos.chats.mergeLidInto(lid.id as ChatRef, JID_B, 1_760_000_100_000 as EpochMs);
    const thumbAfterMerge = cache.thumb(item.id) !== null; // row now says chat_id = target, file is under hash(lidRef|msg)
    const deleted = cache.deleteForItem(item.id as ItemId);
    // FAILS: { thumbAfterMerge: false, deleted: 1, filesLeft: 2 } - Dismiss removed the row but unlinked the wrong names
    expect({ thumbAfterMerge, deleted, filesLeft: readdirSync(dir).length }).toEqual({ thumbAfterMerge: true, deleted: 1, filesLeft: 0 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Slots far enough ahead that the event is still live after the 90-day closed-item horizon (eventHorizonMonths = 12).
const FAR_A = { startLocal: '2027-03-10T15:00:00', endLocal: '2027-03-10T16:00:00' };
const FAR_B = { startLocal: '2027-03-11T17:00:00', endLocal: '2027-03-11T18:00:00' };

describe('data-integrity-v4-3: retention deletes the event ORIGIN item while another item still holds the live event', () => {
  it('a rescheduled event stays editable by the app after the superseded origin card ages out', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: FAR_A });
    const d = r.seedDelta({ source, change: 'reschedule', to: FAR_B });
    expect(await r.click(d.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(itemOf(r, source.id).closedReason).toBe('superseded');
    const holderBefore = itemOf(r, d.item.id);
    expect(holderBefore.eventOriginItemId).toBe(source.id);

    await r.clock.advance(91 * DAY);
    const now = r.clock.now();
    r.repos.retention.purge({ before: now - 30 * DAY, closedBefore: now - 90 * DAY });

    const holder = itemOf(r, d.item.id);
    expect(holder.state).toBe('in_calendar');
    const origin = holder.eventOriginItemId; // FK ON DELETE SET NULL nulled it
    // The user cancels the still-live event from its card:
    const res = await r.exec.cancelEvent(holder.id, CTX);
    const outcome = res.ok ? res.value.outcome : res.error.code;
    const errorCode = itemOf(r, holder.id).errorCode;
    // FAILS: { origin: null, outcome: 'failed', errorCode: 'CAL_EVENT_FOREIGN', stillLive: true }
    expect({ origin, outcome, errorCode, stillLive: r.stored(holder.calendarEventId!)!.status === 'confirmed' }).toEqual({
      origin: source.id,
      outcome: 'done',
      errorCode: null,
      stillLive: false,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
const WED = { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' };
const THU = { startLocal: '2026-10-08T17:00:00', endLocal: '2026-10-08T18:00:00' };
const FRI = { startLocal: '2026-10-09T10:00:00', endLocal: '2026-10-09T11:00:00' };

/** updateEvent applies the PATCH on the fake but answers `timeout` on the listed call numbers (1-based). */
const timeoutOn =
  (calls: number[]) =>
  (real: McpWriteClient): McpWriteClient => {
    let n = 0;
    return {
      ...real,
      updateEvent: async (args) => {
        const res = await real.updateEvent(args);
        n += 1;
        return calls.includes(n) ? { ok: false, error: 'timeout' } : res;
      },
    };
  };

describe('data-integrity-v4-4: the revision CAS reads the SOURCE item, whose event_revision never moves when another item acts', () => {
  it('"Apply again" on the retry clone of an update that already landed is refused (the event is at revision 2 now)', async () => {
    const r = await rig({ wrapWrite: timeoutOn([1]) });
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    await r.click(d.action.id);
    expect(actionOf(r, d.action.id).state).toBe('unknown_outcome');
    const clone = r.repos.actions.forItem(d.item.id).find((x) => x.retryOf === d.action.id && x.state === 'pending')!;
    await r.exec.recoverOnStartup(); // read-only reconcile: the PATCH landed => done, revision 2 on the acting item
    expect(actionOf(r, d.action.id).state).toBe('done');
    expect(r.repos.eventRevisions.newestFor(source.calendarEventId!)!.revision).toBe(2);
    expect(itemOf(r, source.id).eventRevision).toBe(1); // <- the value approveUpdate / reconcile compare baseRevision with

    const first = await r.click(clone.id);
    expect(first).toEqual({ ok: false, error: { code: 'ACTION_STALE' } }); // FAILS: needs_confirm_drift (CAS passed)
  });

  it('...and if the user confirms the drift, the ledger is not left with an `executing` row and a Google write it cannot record', async () => {
    const r = await rig({ wrapWrite: timeoutOn([1]) });
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    await r.click(d.action.id);
    const clone = r.repos.actions.forItem(d.item.id).find((x) => x.retryOf === d.action.id && x.state === 'pending')!;
    await r.exec.recoverOnStartup();
    await r.click(clone.id); // needs_confirm_drift
    let thrown: unknown = null;
    try {
      await r.click(clone.id, { confirmDrift: true });
    } catch (e) {
      thrown = e;
    }
    const updates = r.cal.calls.filter((c) => c.tool === 'update-event').length;
    // FAILS: the PATCH went out (2 update-event calls), commitUpdateDone computed revision 2 again, ux_event_rev aborted the outcome
    // transaction, the clone is stuck in 'executing' and approve threw (IPC INTERNAL).
    expect({ thrown: thrown === null ? null : String(thrown), clone: actionOf(r, clone.id).state, updates }).toEqual({
      thrown: null,
      clone: 'pending',
      updates: 1,
    });
  });

  it('a reconcile pass is not aborted by one update whose revision collides (later unknown actions still get resolved)', async () => {
    const r = await rig({ wrapWrite: timeoutOn([1]) });
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    await r.click(d.action.id); // unknown_outcome (landed)
    const clone = r.repos.actions.forItem(d.item.id).find((x) => x.retryOf === d.action.id && x.state === 'pending')!;
    await r.click(clone.id); // drift: Google already holds THU
    await r.click(clone.id, { confirmDrift: true }); // clone done => revision 2 recorded on the acting item
    expect(actionOf(r, clone.id).state).toBe('done');
    // the original unknown_outcome row is now reconciled: source.event_revision is still 1, so it is NOT superseded, readback
    // matches (waUpdate = chain root = the original) => commitUpdateDone => revision max(1,1)+1 = 2 => UNIQUE abort.
    let thrown: unknown = null;
    try {
      await reconcileUnknown({
        repos: r.repos,
        bridgeDb: null,
        read: r.read,
        now: () => r.clock.now() as EpochMs,
        timeZone: () => 'Asia/Jerusalem',
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown === null ? null : String(thrown)).toBeNull(); // FAILS: UNIQUE constraint failed: event_revisions...
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('data-integrity-v4-5: Restore original keeps its extra reverts in an in-memory map keyed by the FIRST action id', () => {
  it('a Restore original whose PATCH landed but timed out, reconciled on startup, reverts BOTH automatic writes', async () => {
    // update-event calls: #1 auto edit 1, #2 auto edit 2, #3 the restore PATCH (lands, answers timeout)
    const r = await rig({ wrapWrite: timeoutOn([3]) });
    await r.trackRecord();
    const source = await r.createByClick({ slot: WED });
    r.policy('on');
    const d1 = r.seedDelta({ source, change: 'reschedule', to: THU });
    const o1 = await r.exec.tryAuto(d1.action.id);
    await r.clock.advance(31 * MIN);
    const d2 = r.seedDelta({ source: itemOf(r, d1.item.id), change: 'reschedule', to: FRI });
    const o2 = await r.exec.tryAuto(d2.action.id);
    if (o1.verdict === 'none' || o2.verdict === 'none') throw new Error('unreachable');
    const eventId = source.calendarEventId!;
    const span = r.repos.eventRevisions.unrevertedAutoSpan(eventId);
    expect(span).toHaveLength(2);

    await r.exec.restoreOriginal(d2.item.id, CTX); // unknown_outcome (Google already holds WED again)
    expect(r.stored(eventId)).toMatchObject({ start: WED.startLocal });
    await r.exec.recoverOnStartup(); // reconcile => done, with extraReverts: []

    const states = [o1.autoWriteId!, o2.autoWriteId!].map((id) => r.repos.autoWrites.byId(id)!.undoState);
    const reverted = span.map((s) => r.repos.eventRevisions.byId(s.id)!.revertedBy !== null);
    // FAILS: states ['available','undone'], reverted [false,true] - automatic write #1 still reads 'available' and its revision is the undo candidate again
    expect({ states, reverted, span: r.repos.eventRevisions.unrevertedAutoSpan(eventId).length }).toEqual({
      states: ['undone', 'undone'],
      reverted: [true, true],
      span: 0,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../../../src/main/db/migrations';
import { openDbWithRecovery } from '../../../src/main/db/backup';

describe('data-integrity-v4-6: a v3 settings row that v1 tolerated (not JSON) aborts v4 and the recovery path starts an EMPTY database', () => {
  it('a v0.1.x file whose settings row does not parse still upgrades with its items and actions', () => {
    const root = mkdtempSync(join(tmpdir(), 'wca-di4-'));
    roots.push(root);
    const file = join(root, 'app.db');
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA foreign_keys=ON');
    for (const m of MIGRATIONS.filter((x) => x.version <= 3)) {
      raw.exec(m.sql);
      raw.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, 1);
    }
    raw.exec('PRAGMA user_version = 3');
    // v1 settings repo: "a row that no longer parses ... falls back to DEFAULT_SETTINGS instead of crashing the app" - v1 runs fine on it
    raw.exec(`INSERT INTO settings VALUES ('settings', '{"general":', 1)`);
    raw.exec(`INSERT INTO chats (id, jid, created_at, updated_at) VALUES (1, '972550000001@s.whatsapp.net', 1, 1)`);
    raw.exec(`INSERT INTO items (id, chat_id, state, trigger_msg_id, trigger_ts, created_at, updated_at)
              VALUES (1, 1, 'needs_reply', 'MSG1', 1, 1, 1)`);
    raw.close();

    const { db, recovered } = openDbWithRecovery(file, join(root, 'backups'), () => 1_790_000_000_000 as EpochMs);
    const items = db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM items').get()!.n;
    db.close();
    // FAILS: { recovered: 'fresh', items: 0 } - json_insert raised 'malformed JSON', the pre-migration backup failed the same way,
    // and openDbWithRecovery moved app.db aside and opened an empty database (every approval / undo record gone from the app).
    expect({ recovered, items }).toEqual({ recovered: 'none', items: 1 });
  });
});
