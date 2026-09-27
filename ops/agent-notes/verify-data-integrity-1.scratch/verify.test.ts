// SCRATCH - independent verification of review finding data-integrity-1. No product file touched.
import { describe, it, expect, afterEach } from 'vitest';
import { createRepos, openDb, type Db, type Repos } from '../../../src/main/db/index';
import { runRetention } from '../../../src/main/db/retention';
import type { Settings } from '../../../src/shared/settings';
import type { ActionPayload } from '../../../src/shared/schemas';

const T0 = 1_760_000_000_000;
const opened: Db[] = [];
afterEach(() => { for (const d of opened.splice(0)) try { d.close(); } catch { /* */ } });
function mem(): Repos { const db = openDb(':memory:'); opened.push(db); return createRepos(db); }

function seed(repos: Repos, withRetry: boolean, jid: string) {
  const now = T0;
  const chat = repos.chats.upsertFromBridge(jid, null, true, now);
  const item = repos.items.createOpen({ chatId: chat.id, triggerMsgId: 'm1', triggerTs: now, analysis: 'queued', holdReason: null, now });
  repos.messages.appendMany(item.id, [{ waMsgId: 'm1', fromMe: false, ts: now, text: 'hello there' }]);
  const proposal = repos.proposals.insertNext({
    itemId: item.id, provider: 'local', model: 'm', extraction: null, draftText: 'draft',
    replyLang: 'en', event: null, freeBusy: null, suspicious: false, createdAt: now,
  });
  const payload: ActionPayload = { v: 1, kind: 'send_reply', itemId: item.id, chatRef: chat.id, proposalVersion: proposal.version, text: 'ok' };
  const a1 = repos.actions.insertPending({ itemId: item.id, proposalId: proposal.id, chatId: chat.id, payload, now });
  if (withRetry) {
    expect(repos.actions.markApprovedExecuting(a1.id, JSON.stringify(payload), now)).toBe('ok');
    repos.actions.markFailed(a1.id, 'SEND_FAILED', now);
    const a2 = repos.actions.insertPending({ itemId: item.id, proposalId: proposal.id, chatId: chat.id, payload, now, retryOf: a1.id });
    expect(a2.retryOf ?? (a2 as unknown as { retry_of?: string }).retry_of).toBe(a1.id);
  }
  repos.items.update(item.id, { closedReason: 'dismissed', closedAt: now }, now);
  return item;
}

describe('data-integrity-1 verification', () => {
  it('purge() with a retry chain', () => {
    const repos = mem();
    seed(repos, true, '972550000001@s.whatsapp.net');
    let err: unknown = null;
    try { repos.retention.purge({ before: T0 + 1, closedBefore: T0 + 1 }); } catch (e) { err = e; }
    console.log('WITH RETRY ->', err ? `THREW: ${(err as Error).message}` : 'OK');
    const left = repos.db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM item_messages WHERE text IS NOT NULL`).get()!.n;
    console.log('  item_messages rows still holding text after purge:', left);
  });

  it('control without retry chain', () => {
    const repos = mem();
    seed(repos, false, '972550000002@s.whatsapp.net');
    let err: unknown = null;
    let res: unknown = null;
    try { res = repos.retention.purge({ before: T0 + 1, closedBefore: T0 + 1 }); } catch (e) { err = e; }
    console.log('NO RETRY ->', err ? `THREW: ${(err as Error).message}` : `OK ${JSON.stringify(res)}`);
  });

  it('runRetention daily job with a retry chain', () => {
    const repos = mem();
    seed(repos, true, '972550000003@s.whatsapp.net');
    const settings = () => ({ privacy: { retentionDays: 30 } }) as unknown as Settings;
    let err: unknown = null;
    try { runRetention({ repos, settings, now: () => T0 + 200 * 24 * 3600_000 }); } catch (e) { err = e; }
    console.log('runRetention ->', err ? `THREW: ${(err as Error).message}` : 'OK');
    const runs = repos.db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM runs`).get()!.n;
    console.log('  (180d prune reached? runs rows left:', runs, ')');
  });
});
