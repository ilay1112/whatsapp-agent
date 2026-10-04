// TESTS 5.3 row `db/*` for the small repos: meta, secrets (CHECK), consents (`isCurrent` is exact-version), proposals,
// triage queue (debounce + ErrorCode-only last_error), runs (cloud budget), audit (append-only), rate buckets, model files.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepoContractError } from '../index';
import { cleanup, JID_A, memRepos, seedChat, seedOpenItem, seedProposal, T0 } from '../__fixtures__/testDb';
import { CONSENT_VERSIONS, LIMITS } from '../../../shared/types';
import type * as T from '../../../shared/types';

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('meta repo', () => {
  it('reads null, writes and overwrites, and refuses an unknown key', () => {
    const { repos } = memRepos();
    expect(repos.meta.get('paired_at')).toBeNull();
    repos.meta.set('paired_at', String(T0));
    repos.meta.set('paired_at', String(T0 + 1));
    expect(repos.meta.get('paired_at')).toBe(String(T0 + 1));
    expect(() => repos.meta.get('nope' as T.MetaKey)).toThrow(RepoContractError);
    expect(() => repos.meta.set('nope' as T.MetaKey, 'x')).toThrow(RepoContractError);
  });
});

describe('secrets repo', () => {
  it('stores ciphertext per name, deletes it and enforces the name CHECK', () => {
    const { db, repos } = memRepos();
    const cipher = new Uint8Array([1, 2, 3, 255]);
    repos.secrets.put('anthropic_api_key', cipher);
    expect(Array.from(repos.secrets.get('anthropic_api_key')!)).toEqual([1, 2, 3, 255]);
    expect(repos.secrets.get('gemini_api_key')).toBeNull();
    repos.secrets.put('anthropic_api_key', new Uint8Array([9]));
    expect(Array.from(repos.secrets.get('anthropic_api_key')!)).toEqual([9]);
    repos.secrets.delete('anthropic_api_key');
    expect(repos.secrets.get('anthropic_api_key')).toBeNull();
    expect(() => repos.secrets.put('other' as T.SecretName, cipher)).toThrow(RepoContractError);
    expect(() =>
      db.prepare(`INSERT INTO secrets(name, ciphertext, updated_at) VALUES ('openai_api_key', ?, ?)`).run(cipher, T0),
    ).toThrow(/CHECK/);
  });
});

describe('consents repo', () => {
  it('isCurrent is the EXACT current version, latest() is the highest accepted one', () => {
    const { repos } = memRepos();
    expect(repos.consents.isCurrent('cloud_claude')).toBe(false);
    expect(repos.consents.latest('cloud_claude')).toBeNull();
    repos.consents.accept('cloud_claude', 999, T0);
    expect(repos.consents.latest('cloud_claude')).toEqual({ kind: 'cloud_claude', version: 999, acceptedAt: T0 });
    expect(repos.consents.isCurrent('cloud_claude')).toBe(false); // a future/foreign version does not count
    repos.consents.accept('cloud_claude', CONSENT_VERSIONS.cloud_claude, T0 + 1);
    expect(repos.consents.isCurrent('cloud_claude')).toBe(true);
    repos.consents.accept('cloud_claude', CONSENT_VERSIONS.cloud_claude, T0 + 2); // re-accept updates the timestamp in place
    expect(repos.consents.latest('cloud_claude')!.version).toBe(999);
    expect(repos.consents.isCurrent('whatsapp_tos')).toBe(false);
    expect(() => repos.consents.accept('nope' as T.ConsentKind, 1, T0)).toThrow(RepoContractError);
    expect(() => repos.consents.isCurrent('nope' as T.ConsentKind)).toThrow(RepoContractError);
    expect(() => repos.consents.latest('nope' as T.ConsentKind)).toThrow(RepoContractError);
  });
});

describe('proposals repo', () => {
  it('insertNext bumps the version and supersedes every older one', () => {
    const { repos } = memRepos();
    const item = seedOpenItem(repos, seedChat(repos).id);
    const v1 = seedProposal(repos, item.id, T0);
    expect(v1.version).toBe(1);
    expect(repos.proposals.current(item.id)!.id).toBe(v1.id);
    const v2 = repos.proposals.insertNext({
      itemId: item.id,
      provider: 'user',
      model: '',
      extraction: null,
      draftText: null,
      replyLang: null,
      event: {
        title: 'T',
        startLocal: '2026-09-22T10:00:00',
        endLocal: '2026-09-22T11:00:00',
        timeZone: 'Asia/Jerusalem',
        location: '',
        assumptions: [],
        dateHint: '',
      },
      freeBusy: [{ startLocal: '2026-09-22T09:00:00', endLocal: '2026-09-22T09:30:00' }],
      suspicious: true,
      createdAt: T0 + 1,
    });
    expect(v2.version).toBe(2);
    expect(v2.suspicious).toBe(true);
    expect(v2.event!.title).toBe('T');
    expect(v2.freeBusy).toHaveLength(1);
    expect(repos.proposals.current(item.id)!.id).toBe(v2.id);
    expect(repos.proposals.current(item.id + 999)).toBeNull();
  });
});

describe('queue repo', () => {
  it('debounces to min(now + 20 s, first_enqueued_at + 60 s)', () => {
    const { repos } = memRepos();
    const chat = seedChat(repos);
    repos.queue.enqueue(chat.id, T0);
    expect(repos.queue.nextDue(T0 + LIMITS.debounceMs - 1)).toBeNull();
    expect(repos.queue.nextDue(T0 + LIMITS.debounceMs)).toMatchObject({
      chatId: chat.id,
      dueAt: T0 + LIMITS.debounceMs,
      firstEnqueuedAt: T0,
      attempts: 0,
    });
    repos.queue.enqueue(chat.id, T0 + 10_000);
    expect(repos.queue.nextDue(T0 + LIMITS.debounceCapMs)!.dueAt).toBe(T0 + 30_000);
    repos.queue.enqueue(chat.id, T0 + 55_000); // now + 20 s would exceed the cap
    expect(repos.queue.nextDue(T0 + LIMITS.debounceCapMs)!.dueAt).toBe(T0 + LIMITS.debounceCapMs);
    expect(repos.queue.size()).toBe(1);
  });

  it('defer stores an ErrorCode only, and remove empties the queue', () => {
    const { repos } = memRepos();
    const chat = seedChat(repos);
    repos.queue.enqueue(chat.id, T0);
    repos.queue.defer(chat.id, T0 + 60_000, 'CLOUD_QUOTA');
    expect(repos.queue.nextDue(T0 + 60_000)).toMatchObject({ attempts: 1, lastError: 'CLOUD_QUOTA' });
    repos.queue.defer(chat.id, T0 + 70_000, 'Error: rate limited by provider, retry in 3s');
    expect(repos.queue.nextDue(T0 + 70_000)).toMatchObject({ attempts: 2, lastError: null });
    repos.queue.defer(chat.id, T0 + 80_000);
    expect(repos.queue.nextDue(T0 + 80_000)!.lastError).toBeNull();
    repos.queue.remove(chat.id);
    expect(repos.queue.size()).toBe(0);
    expect(repos.queue.nextDue(T0 + 999_999)).toBeNull();
  });

  /**
   * `attempts` is the retry-backoff tier (agent/queue.ts backoffFor over RETRY_BACKOFF_MS = 1 min / 5 min / 30 min).
   * Two of the four defer() call sites are NOT failures - the worker's edit-lock deferral and ingest's Stage-0 'deferred'
   * verdict - and they pass no ErrorCode. Counting them inflates the backoff: a brand-new row that ingest enqueues and
   * immediately defers already starts at attempts=1, and two edit-lock deferrals put the next GENUINE provider failure
   * straight into the 30-minute tier, where the item sits at analysis='queued' (counted, never listed).
   */
  it('a deferral that carries no error moves due_at without advancing the retry-backoff tier', () => {
    const { repos } = memRepos();
    const chat = seedChat(repos);
    repos.queue.enqueue(chat.id, T0);
    // ingest.ts Stage-0 'deferred': enqueue then defer on a brand-new row
    repos.queue.defer(chat.id, T0 + 10_000);
    expect(repos.queue.nextDue(T0 + 10_000)).toMatchObject({ attempts: 0, dueAt: T0 + 10_000, lastError: null });
    // agent/queue.ts pump(): the edit lock defers while the user types in the card
    repos.queue.defer(chat.id, T0 + 20_000);
    repos.queue.defer(chat.id, T0 + 30_000);
    expect(repos.queue.nextDue(T0 + 30_000)!.attempts).toBe(0);
    // the first real failure is still the FIRST attempt, i.e. the 1-minute tier
    repos.queue.defer(chat.id, T0 + 90_000, 'CLOUD_UNAVAILABLE');
    expect(repos.queue.nextDue(T0 + 90_000)).toMatchObject({ attempts: 1, lastError: 'CLOUD_UNAVAILABLE' });
    // and a non-failure deferral after a failure leaves the tier where it was
    repos.queue.defer(chat.id, T0 + 100_000);
    expect(repos.queue.nextDue(T0 + 100_000)!.attempts).toBe(1);
  });

  it('nextDue picks the earliest due chat', () => {
    const { repos } = memRepos();
    const a = seedChat(repos, JID_A);
    const b = seedChat(repos, '972550000002@s.whatsapp.net');
    repos.queue.enqueue(b.id, T0 + 5_000);
    repos.queue.enqueue(a.id, T0);
    expect(repos.queue.nextDue(T0 + 999_999)!.chatId).toBe(a.id);
  });
});

describe('runs repo', () => {
  it('records metadata and sums cloud tokens only', () => {
    const { repos } = memRepos();
    const item = seedOpenItem(repos, seedChat(repos).id);
    const local = repos.runs.start({
      itemId: item.id,
      stage: 'extract',
      provider: 'local',
      model: 'gemma',
      startedAt: T0,
    });
    const cloud = repos.runs.start({
      itemId: item.id,
      stage: 'draft',
      provider: 'claude',
      model: 'claude-opus-5',
      startedAt: T0 + 1,
    });
    repos.runs.finish(local, { finishedAt: T0 + 5, outcome: 'ok', inputTokens: 100, outputTokens: 50 });
    repos.runs.finish(cloud, {
      finishedAt: T0 + 6,
      outcome: 'ok',
      inputTokens: 10,
      outputTokens: 5,
      toolCalls: 2,
      blockedToolCalls: 1,
      errorCode: null,
    });
    repos.runs.finish(cloud, {}); // nothing to write
    expect(repos.runs.cloudTokensSince(T0)).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(repos.runs.cloudTokensSince(T0 + 100)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('audit repo', () => {
  it('appends metadata rows and refuses an unknown kind; the table is append-only', () => {
    const { db, repos } = memRepos();
    repos.audit.append('tool_blocked', null, { nameSha8: 'deadbeef', nameLen: 12, verdict: 'blocked', runId: 0 }, T0);
    repos.audit.append('action_approved', 'action-id', { kind: 'send_reply' }, T0 + 1);
    const rows = db
      .prepare<{ kind: string; ref: string | null; detail_json: string }>(
        `SELECT kind, ref, detail_json FROM audit_log ORDER BY id`,
      )
      .all();
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]!.detail_json)).toEqual({
      nameSha8: 'deadbeef',
      nameLen: 12,
      verdict: 'blocked',
      runId: 0,
    });
    expect(rows[1]!.ref).toBe('action-id');
    expect(() => repos.audit.append('nope' as T.AuditKind, null, {}, T0)).toThrow(RepoContractError);
    expect(() => db.exec(`UPDATE audit_log SET kind='wipe'`)).toThrow(/append-only/);
  });
});

describe('rate repo', () => {
  it('counts events per bucket and key within a window', () => {
    const { repos } = memRepos();
    expect(repos.rate.countSince('send_chat', '1', 0)).toBe(0);
    expect(repos.rate.lastTs('send_chat', '1')).toBeNull();
    repos.rate.record('send_chat', '1', T0);
    repos.rate.record('send_chat', '1', T0 + 1_000);
    repos.rate.record('send_chat', '2', T0 + 2_000);
    repos.rate.record('send_global', 'global', T0);
    expect(repos.rate.countSince('send_chat', '1', T0)).toBe(2);
    expect(repos.rate.countSince('send_chat', '1', T0 + 1)).toBe(1);
    expect(repos.rate.lastTs('send_chat', '1')).toBe(T0 + 1_000);
    expect(repos.rate.countSince('send_global', 'global', T0)).toBe(1);
    expect(() => repos.rate.record('nope' as T.RateBucket, 'k', T0)).toThrow(RepoContractError);
    expect(() => repos.rate.countSince('nope' as T.RateBucket, 'k', T0)).toThrow(RepoContractError);
    expect(() => repos.rate.lastTs('nope' as T.RateBucket, 'k')).toThrow(RepoContractError);
  });
});

describe('models repo', () => {
  it('upserts a tier row with its bench json and deletes it', () => {
    const { repos } = memRepos();
    const record: T.ModelFileRecord = {
      id: 'small',
      kind: 'llm', // [V2] ModelFileRecord.kind (C2 1.3)
      path: 'C:\\models\\small.gguf',
      size: 1_024,
      sha256: 'a'.repeat(64),
      mtime: T0,
      status: 'ready',
      bytesDone: 1_024,
      verifiedAt: T0,
      bench: { tokPerSec: 12.5, measuredAt: T0, device: 'cpu' },
    };
    expect(repos.models.get('small')).toBeNull();
    repos.models.upsert(record);
    expect(repos.models.get('small')).toEqual(record);
    repos.models.upsert({ ...record, status: 'failed', bench: null });
    expect(repos.models.get('small')).toMatchObject({ status: 'failed', bench: null });
    repos.models.delete('small');
    expect(repos.models.get('small')).toBeNull();
  });
});
