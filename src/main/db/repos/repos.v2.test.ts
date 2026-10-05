// T2 5 row `db/*` - the v2 members of the v1 repos (C2 16.1): consents.termsReadOn, models by ModelFileId + kind, runs.finishCli /
// sandboxOfVersion, proposals provenance + fail-closed reads, actions.countUserApprovedCreates / rejectedDeltaTo, chats.setAutoPolicy /
// taint / mergeLidInto (v2 ON DELETE), items editable-event queries.
import { afterEach, describe, expect, it } from 'vitest';
import type { EventDelta, ImageRead } from '../../../shared/schemas';
import { ANTIGRAVITY_TERMS_READ_ON, CONSENT_VERSIONS, LIMITS } from '../../../shared/types';
import type * as T from '../../../shared/types';
import { RepoContractError, RowNotFoundError } from '../errors';
import {
  cleanup,
  content,
  EVT_A,
  EVT_B,
  JID_A,
  JID_B,
  LID_JID,
  memRepos,
  seedChat,
  seedCreatedEvent,
  seedDecision,
  seedOpenItem,
  seedPendingCreate,
  seedPendingUpdate,
  seedPolicy,
  seedProposal,
  T0,
} from '../__fixtures__/testDb';

afterEach(cleanup);

const HOUR = 3600_000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------------------------------------------------
describe('repos.consents - termsReadOn (B14)', () => {
  it('records the Antigravity terms date and returns it; other kinds keep the v1 record shape', () => {
    const { repos } = memRepos();
    repos.consents.accept(
      'cloud_antigravity_cli',
      CONSENT_VERSIONS.cloud_antigravity_cli,
      T0,
      ANTIGRAVITY_TERMS_READ_ON,
    );
    expect(repos.consents.latest('cloud_antigravity_cli')).toEqual({
      kind: 'cloud_antigravity_cli',
      version: 1,
      acceptedAt: T0,
      termsReadOn: ANTIGRAVITY_TERMS_READ_ON,
    });
    expect(repos.consents.isCurrent('cloud_antigravity_cli')).toBe(true);
    repos.consents.accept('cloud_claude_cli', 1, T0);
    expect(repos.consents.latest('cloud_claude_cli')).toEqual({ kind: 'cloud_claude_cli', version: 1, acceptedAt: T0 });
  });

  it('requires the date for Antigravity and refuses it for every other kind', () => {
    const { repos } = memRepos();
    expect(() => repos.consents.accept('cloud_antigravity_cli', 1, T0)).toThrow(RepoContractError);
    expect(() => repos.consents.accept('cloud_antigravity_cli', 1, T0, '28/09/2026')).toThrow(RepoContractError);
    expect(() => repos.consents.accept('cloud_claude', 2, T0, ANTIGRAVITY_TERMS_READ_ON)).toThrow(RepoContractError);
    expect(repos.consents.latest('cloud_antigravity_cli')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('repos.models - keyed by ModelFileId with kind', () => {
  it.each([
    ['small', 'llm'],
    ['mmproj-small', 'mmproj'],
    ['voice-hebrew', 'asr'],
    ['voice-vad', 'vad'],
  ] as const)('%s round-trips as kind %s', (id, kind) => {
    const { repos } = memRepos();
    const r: T.ModelFileRecord = {
      id,
      kind,
      path: `C:\\synthetic\\${id}.bin`,
      size: 10,
      sha256: 'a'.repeat(64),
      mtime: T0,
      status: 'ready',
      bytesDone: 10,
      verifiedAt: T0,
      bench: kind === 'asr' ? { tokPerSec: 0, measuredAt: T0, device: 'cpu', secPerAudioSec: 0.4 } : null,
    };
    repos.models.upsert(r);
    expect(repos.models.get(id)).toEqual(r);
    repos.models.delete(id);
    expect(repos.models.get(id)).toBeNull();
  });

  it('the DDL refuses a kind that does not match the id, and an unknown id', () => {
    const { repos } = memRepos();
    const base = {
      path: 'p',
      size: 1,
      sha256: 'a'.repeat(64),
      mtime: T0,
      status: 'none',
      bytesDone: 0,
      verifiedAt: null,
      bench: null,
    } as const;
    expect(() => repos.models.upsert({ ...base, id: 'small', kind: 'asr' })).toThrow(/CHECK/);
    expect(() => repos.models.upsert({ ...base, id: 'huge' as T.ModelFileId, kind: 'llm' })).toThrow(/CHECK/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('repos.runs - CLI sandbox proof (I11, B25/B26)', () => {
  const PROOF: T.CliSandboxProof = {
    initOk: true,
    toolsCount: 0,
    mcpServers: 1,
    apiKeySource: 'oauth',
    mismatch: null,
  };
  const sandbox = (
    repos: ReturnType<typeof memRepos>['repos'],
    id: number,
  ): { ok: number | null; json: string | null } =>
    repos.db
      .prepare<{ ok: number | null; json: string | null }>(
        `SELECT sandbox_ok AS ok, sandbox_json AS json FROM runs WHERE id = ?`,
      )
      .get(id)!;

  it('finishCli stores the proof rebuilt from its closed key list (no extra key survives)', () => {
    const { repos } = memRepos();
    const item = seedOpenItem(repos, seedChat(repos).id);
    const run = repos.runs.start({
      itemId: item.id,
      stage: 'draft',
      provider: 'claude_cli',
      model: 'sonnet',
      startedAt: T0,
    });
    repos.runs.finishCli(run, {
      sandboxOk: true,
      sandboxProof: { ...PROOF, toolName: 'Bash', stdout: 'secret' } as T.CliSandboxProof,
    });
    expect(sandbox(repos, run)).toEqual({ ok: 1, json: JSON.stringify(PROOF) });
  });

  it('[agy-provider-fix] an antigravity_cli proof keeps policy deny_all + runtimeWatch; other values are refused', () => {
    const { repos } = memRepos();
    const item = seedOpenItem(repos, seedChat(repos).id);
    const run = repos.runs.start({
      itemId: item.id,
      stage: 'extract',
      provider: 'antigravity_cli',
      model: 'gemini-3.8-flash-high',
      startedAt: T0,
    });
    const AGY: T.CliSandboxProof = {
      initOk: true,
      toolsCount: 60,
      mcpServers: 0,
      apiKeySource: 'unknown',
      mismatch: null,
      policy: 'deny_all',
      runtimeWatch: true,
    };
    repos.runs.finishCli(run, { sandboxOk: true, sandboxProof: AGY });
    expect(sandbox(repos, run)).toEqual({ ok: 1, json: JSON.stringify(AGY) });
    for (const bad of [
      { ...AGY, policy: 'allow_all' },
      { ...AGY, policy: null },
      { ...AGY, runtimeWatch: 'yes' },
    ])
      expect(() => repos.runs.finishCli(run, { sandboxOk: false, sandboxProof: bad as T.CliSandboxProof })).toThrow(
        RepoContractError,
      );
  });

  it('fails closed: a proof that contradicts sandboxOk is stored as 0; a malformed proof is refused', () => {
    const { repos } = memRepos();
    const item = seedOpenItem(repos, seedChat(repos).id);
    const run = repos.runs.start({
      itemId: item.id,
      stage: 'extract',
      provider: 'claude_cli',
      model: 'sonnet',
      startedAt: T0,
    });
    repos.runs.finishCli(run, { sandboxOk: true, sandboxProof: { ...PROOF, initOk: false } });
    expect(sandbox(repos, run).ok).toBe(0);
    repos.runs.finishCli(run, { sandboxOk: true, sandboxProof: { ...PROOF, mismatch: 'extra_tool' } });
    expect(sandbox(repos, run).ok).toBe(0);
    for (const bad of [
      { ...PROOF, apiKeySource: 'apikey' },
      { ...PROOF, mismatch: 'weird' },
      { ...PROOF, toolsCount: -1 },
      { ...PROOF, mcpServers: 1.5 },
      { ...PROOF, initOk: 'yes' },
      null,
    ])
      expect(() => repos.runs.finishCli(run, { sandboxOk: false, sandboxProof: bad as T.CliSandboxProof })).toThrow(
        RepoContractError,
      );
    expect(() => repos.runs.finishCli(run, { sandboxOk: 1 as unknown as boolean, sandboxProof: PROOF })).toThrow(
      RepoContractError,
    );
    expect(() => repos.runs.finishCli(424_242, { sandboxOk: true, sandboxProof: PROOF })).toThrow(RowNotFoundError);
  });

  it('sandboxOfVersion lists the S1 + S3 proofs of the runs since the previous version (null = none recorded)', () => {
    const { repos } = memRepos();
    const item = seedOpenItem(repos, seedChat(repos).id);
    const start = (stage: 'extract' | 'draft' | 'read_image', at: number): number =>
      repos.runs.start({ itemId: item.id, stage, provider: 'claude_cli', model: 'sonnet', startedAt: at });
    const old = start('extract', T0);
    repos.runs.finishCli(old, { sandboxOk: false, sandboxProof: { ...PROOF, initOk: false } });
    const s1 = start('extract', T0 + 100);
    repos.runs.finishCli(s1, { sandboxOk: true, sandboxProof: PROOF });
    start('read_image', T0 + 150); // V1 is not part of the S1+S3 proof
    const s3 = start('draft', T0 + 200);
    expect(repos.runs.sandboxOfVersion(item.id, T0 + 100)).toEqual([true, null]);
    repos.runs.finishCli(s3, { sandboxOk: true, sandboxProof: PROOF });
    expect(repos.runs.sandboxOfVersion(item.id, T0 + 100)).toEqual([true, true]);
    expect(repos.runs.sandboxOfVersion(item.id, T0)).toEqual([false, true, true]);
    expect(repos.runs.sandboxOfVersion(item.id, T0 + 1000)).toEqual([]);
  });

  it('finish() records wa_rows_served and leaves the sandbox columns alone', () => {
    const { repos } = memRepos();
    const item = seedOpenItem(repos, seedChat(repos).id);
    const run = repos.runs.start({ itemId: item.id, stage: 'draft', provider: 'local', model: 'm', startedAt: T0 });
    repos.runs.finish(run, { waRowsServed: 7, outcome: 'ok', finishedAt: T0 + 5 });
    expect(repos.db.prepare<{ n: number }>(`SELECT wa_rows_served AS n FROM runs WHERE id = ?`).get(run)!.n).toBe(7);
    expect(sandbox(repos, run)).toEqual({ ok: null, json: null });
    expect(() => repos.runs.finish(run, { waRowsServed: -1 })).toThrow(/CHECK/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
const DELTA: EventDelta = {
  kind: 'reschedule',
  targetEventId: EVT_A,
  sourceItemId: 1,
  baseRevision: 1,
  from: content(),
  to: content({ startLocal: '2026-10-01T15:00:00', endLocal: '2026-10-01T16:00:00' }),
  confidence: 'high',
  assumptions: [],
  problems: [],
};
const IMAGE: ImageRead = {
  readable: true,
  kind: 'invitation',
  readText: 'synthetic invitation text',
  language: 'en',
  title: 'Synthetic party',
  dateText: 'Oct 3',
  day: 3,
  month: 10,
  year: 0,
  weekday: 7,
  timeText: '8pm',
  hour: 20,
  minute: 0,
  timeAmbiguous: false,
  endHour: 24,
  endMinute: 0,
  location: '',
  confidence: 'medium',
  suspicious: false,
};

describe('repos.proposals - B25 provenance', () => {
  const base = (itemId: number, provider: T.ProviderId | 'user' = 'local') => ({
    itemId,
    provider,
    model: 'm',
    extraction: null,
    draftText: null,
    replyLang: null,
    event: null,
    freeBusy: null,
    suspicious: false,
    createdAt: T0,
  });

  it('writes the seven provenance fields once and reads them back', () => {
    const { repos } = memRepos();
    const item = seedOpenItem(repos, seedChat(repos).id);
    const p = repos.proposals.insertNext({
      ...base(item.id, 'claude_cli'),
      delta: DELTA,
      imageRead: IMAGE,
      blockedCalls: 2,
      providerClass: 'cli_proven',
      contextFromMeRecent: true,
      crossChatRows: 3,
      triggerAuthor: 'self',
    });
    expect(repos.proposals.current(item.id)).toEqual(p);
    // a v2 extraction (all 18 keys) is written and read back unchanged
    const extraction = {
      intent: 'reschedule' as const,
      needsReply: true,
      title: 'Synthetic',
      dateKind: 'none' as const,
      isoDate: '',
      weekday: 0,
      weekOffset: 0,
      daysFromToday: 0,
      time24h: '15:00',
      timeAmbiguous: false,
      durationMin: 0,
      location: '',
      missing: [],
      suspicious: false,
      refersToExisting: true,
      change: 'reschedule' as const,
      changeConfidence: 'high' as const,
      confidence: 'high' as const,
    };
    expect(repos.proposals.insertNext({ ...base(item.id), extraction }).extraction).toEqual(extraction);
    expect(p).toMatchObject({
      delta: DELTA,
      imageRead: IMAGE,
      blockedCalls: 2,
      providerClass: 'cli_proven',
      contextFromMeRecent: true,
      crossChatRows: 3,
      triggerAuthor: 'self',
    });
  });

  it.each([
    ['local', 'local'],
    ['user', 'local'],
    ['claude', 'api_key'],
    ['gemini', 'api_key'],
    ['claude_cli', 'cli_unproven'],
    ['antigravity_cli', 'cli_unproven'],
  ] as const)('an omitted provenance defaults fail-closed (%s => %s)', (provider, cls) => {
    const { repos } = memRepos();
    const item = seedOpenItem(repos, seedChat(repos).id);
    expect(repos.proposals.insertNext(base(item.id, provider))).toMatchObject({
      delta: null,
      imageRead: null,
      blockedCalls: 0,
      providerClass: cls,
      contextFromMeRecent: false,
      crossChatRows: 0,
      triggerAuthor: 'contact',
    });
  });

  it('refuses a malformed delta / picture read / count on the way in', () => {
    const { repos } = memRepos();
    const item = seedOpenItem(repos, seedChat(repos).id);
    expect(() =>
      repos.proposals.insertNext({ ...base(item.id), delta: { ...DELTA, targetEventId: 'BAD ID' } }),
    ).toThrow();
    expect(() => repos.proposals.insertNext({ ...base(item.id), imageRead: { ...IMAGE, hour: 99 } })).toThrow();
    expect(() => repos.proposals.insertNext({ ...base(item.id), blockedCalls: -1 })).toThrow(RepoContractError);
    expect(() => repos.proposals.insertNext({ ...base(item.id), crossChatRows: 0.5 })).toThrow(RepoContractError);
    expect(repos.proposals.current(item.id)).toBeNull();
  });

  it('reads fail closed: a v1 extraction gets the StoredExtractionSchema defaults; a bad stored row reads as null', () => {
    const { db, repos } = memRepos();
    const item = seedOpenItem(repos, seedChat(repos).id);
    const p = seedProposal(repos, item.id);
    const v1 = {
      intent: 'schedule_request',
      needsReply: true,
      title: 'Synthetic',
      dateKind: 'none',
      isoDate: '',
      weekday: 0,
      weekOffset: 0,
      daysFromToday: 0,
      time24h: '',
      timeAmbiguous: false,
      durationMin: 0,
      location: '',
      missing: [],
      suspicious: false,
    };
    db.prepare(`UPDATE proposals SET extraction_json = ? WHERE id = ?`).run(JSON.stringify(v1), p.id);
    expect(repos.proposals.current(item.id)!.extraction).toEqual({
      ...v1,
      refersToExisting: false,
      change: 'no_change',
      changeConfidence: 'low',
      confidence: 'low',
    });
    db.prepare(
      `UPDATE proposals SET extraction_json = '{"intent":"attack"}', delta_json = '{"kind":"reschedule"}', image_json = 'not json' WHERE id = ?`,
    ).run(p.id);
    expect(repos.proposals.current(item.id)).toMatchObject({ extraction: null, delta: null, imageRead: null });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('repos.actions - markApprovedExecuting (approver in the FIRST CAS statement)', () => {
  it('a miss on the SECOND compare-and-set is stale and rolls the approval back', () => {
    const { db, repos } = memRepos();
    const { action } = seedPendingCreate(repos);
    // a (test-only) trigger that makes the row disappear between the two statements
    db.exec(`CREATE TEMP TRIGGER t_vanish AFTER UPDATE OF approved_by ON actions WHEN NEW.state = 'approved'
             BEGIN DELETE FROM actions WHERE id = NEW.id; END`);
    expect(repos.actions.markApprovedExecuting(action.id, action.canonicalJson, T0, 'user')).toBe('stale');
    db.exec('DROP TRIGGER t_vanish');
    expect(repos.actions.byId(action.id)).toMatchObject({ state: 'pending', approvedBy: null, approvedAt: null });
  });

  it('a programming error (an unbindable approver) is rethrown, not disguised as stale', () => {
    const { repos } = memRepos();
    const { action } = seedPendingCreate(repos);
    expect(() =>
      repos.actions.markApprovedExecuting(action.id, action.canonicalJson, T0, {} as unknown as T.ApprovedBy),
    ).toThrow();
    expect(repos.actions.byId(action.id)!.state).toBe('pending');
  });

  it('a missing row is stale', () => {
    const { repos } = memRepos();
    expect(repos.actions.markApprovedExecuting('nope', '{}', T0, 'user')).toBe('stale');
  });
});

describe('repos.actions - v2 reads', () => {
  it('countUserApprovedCreates counts DONE create_event rows approved by a click only', () => {
    const { repos } = memRepos();
    expect(repos.actions.countUserApprovedCreates()).toBe(0);
    seedCreatedEvent(repos); // done, 'user'
    seedCreatedEvent(repos, { jid: JID_B, eventId: EVT_B }); // done, 'user'
    // approved by a click but not done
    const pending = seedPendingCreate(repos, T0, '972550000031@s.whatsapp.net').action;
    repos.actions.markApprovedExecuting(pending.id, pending.canonicalJson, T0, 'user');
    // done by an automatic decision
    const policy = seedPolicy(repos);
    const auto = seedPendingCreate(repos, T0, '972550000032@s.whatsapp.net').action;
    const d = seedDecision(repos, { policyId: policy.id, action: auto });
    repos.actions.markApprovedExecuting(auto.id, auto.canonicalJson, T0, d.id);
    repos.actions.markDone(auto.id, { kind: 'create_event', eventId: 'evtauto0001', htmlLink: null }, T0);
    // a done send_reply
    const send = seedPendingCreate(repos, T0, '972550000033@s.whatsapp.net');
    const reply = repos.actions.insertPending({
      itemId: send.item.id,
      proposalId: send.proposal.id,
      chatId: send.chat.id,
      payload: {
        v: 1,
        kind: 'send_reply',
        itemId: send.item.id,
        chatRef: send.chat.id,
        proposalVersion: 1,
        text: 'ok',
      },
      now: T0,
    });
    repos.actions.markApprovedExecuting(reply.id, reply.canonicalJson, T0, 'user');
    repos.actions.markDone(reply.id, { kind: 'send_reply', waMsgId: null }, T0);
    expect(repos.actions.countUserApprovedCreates()).toBe(2);
  });

  it('rejectedDeltaTo returns the `to` of REJECTED update_event rows of this event and base revision only (F32)', () => {
    const { db, repos } = memRepos();
    const created = seedCreatedEvent(repos);
    const to15 = content({ startLocal: '2026-10-01T15:00:00', endLocal: '2026-10-01T16:00:00' });
    const to17 = content({ startLocal: '2026-10-01T17:00:00', endLocal: '2026-10-01T18:00:00' });
    const r1 = seedPendingUpdate(repos, created, { to: to15, now: T0 + 1 }).action;
    repos.actions.markRejected(r1.id);
    const r2 = seedPendingUpdate(repos, created, { to: to17, now: T0 + 2 }).action;
    repos.actions.markRejected(r2.id);
    seedPendingUpdate(repos, created, { to: content({ location: 'Room 2' }), change: 'move', now: T0 + 3 }); // pending: not rejected
    const other = seedPendingUpdate(repos, created, { baseRevision: 2, now: T0 + 4 }).action; // another base revision
    repos.actions.markRejected(other.id);
    const purged = seedPendingUpdate(repos, created, { now: T0 + 5 }).action;
    repos.actions.markRejected(purged.id);
    db.prepare(`UPDATE actions SET canonical_json = NULL WHERE id = ?`).run(purged.id); // retention
    // hand-damaged rows (a restored / edited file): not JSON at all, and JSON that is not an update payload - both are ignored
    const raw = (id: string, canonical: string): void => {
      db.prepare(
        `INSERT INTO actions(id, item_id, proposal_id, chat_id, kind, canonical_json, content_sha256, idempotency_key, state, created_at, expires_at)
         VALUES (?, ?, ?, ?, 'update_event', ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        id,
        created.item.id,
        created.proposal.id,
        created.chat.id,
        canonical,
        'f'.repeat(64),
        `k-${id}`,
        T0 + 6,
        T0 + DAY,
      );
      repos.actions.markRejected(id);
    };
    raw('bad-json', '{not json');
    raw('bad-shape', JSON.stringify({ targetEventId: EVT_A, baseRevision: 1, to: 'x' }));
    expect(repos.actions.rejectedDeltaTo(EVT_A, 1)).toEqual([to15, to17]);
    expect(repos.actions.rejectedDeltaTo(EVT_A, 2)).toHaveLength(1);
    expect(repos.actions.rejectedDeltaTo(EVT_B, 1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('repos.chats - automatic-mode fields (B28)', () => {
  it('setAutoPolicy toggles never / inherit and refuses anything else', () => {
    const { repos } = memRepos();
    const chat = seedChat(repos);
    expect(chat.autoPolicy).toBe('inherit');
    expect(repos.chats.withPolicies()).toEqual([]);
    expect(repos.chats.setAutoPolicy(chat.id, 'never').autoPolicy).toBe('never');
    // chat:listPolicies lists the automatic-mode opt-outs too (C2 8)
    expect(repos.chats.withPolicies().map((c) => c.id)).toEqual([chat.id]);
    expect(repos.chats.setAutoPolicy(chat.id, 'inherit').autoPolicy).toBe('inherit');
    expect(repos.chats.withPolicies()).toEqual([]);
    expect(() => repos.chats.setAutoPolicy(chat.id, 'allow' as T.ChatAutoPolicy)).toThrow(RepoContractError);
    expect(() => repos.chats.setAutoPolicy(9999, 'never')).toThrow(RowNotFoundError);
  });

  it('taint keeps the LATER of old and new, and audits auto_taint {chatRef, untilTs} each time', () => {
    const { db, repos } = memRepos();
    const chat = seedChat(repos);
    const until = T0 + LIMITS.autoTaintMs;
    repos.chats.taint(chat.id, until);
    expect(repos.chats.byId(chat.id)!.autoTaintedUntil).toBe(until);
    repos.chats.taint(chat.id, until - DAY); // shorter: never shortens
    expect(repos.chats.byId(chat.id)!.autoTaintedUntil).toBe(until);
    repos.chats.taint(chat.id, until + DAY);
    expect(repos.chats.byId(chat.id)!.autoTaintedUntil).toBe(until + DAY);
    const audits = db
      .prepare<{ ts: number; kind: string; ref: string; detail_json: string }>(
        `SELECT ts, kind, ref, detail_json FROM audit_log ORDER BY id`,
      )
      .all();
    expect(audits.map((a) => a.kind)).toEqual(['auto_taint', 'auto_taint', 'auto_taint']);
    expect(audits[0]).toEqual({
      ts: T0,
      kind: 'auto_taint',
      ref: String(chat.id),
      detail_json: JSON.stringify({ chatRef: chat.id, untilTs: until }),
    });
    expect(JSON.parse(audits[1]!.detail_json)).toEqual({ chatRef: chat.id, untilTs: until });
    expect(() => repos.chats.taint(9999, until)).toThrow(RowNotFoundError);
    expect(() => repos.chats.taint(chat.id, Number.NaN)).toThrow(RepoContractError);
    expect(db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log`).get()!.n).toBe(3); // the failed calls wrote nothing
  });

  it('mergeLidInto carries the opt-out and the taint fail-closed and moves the cached pictures', () => {
    const { repos } = memRepos();
    const phone = seedChat(repos, JID_A);
    const lid = repos.chats.upsertFromBridge(LID_JID, null, false, T0);
    repos.chats.setAutoPolicy(lid.id, 'never');
    repos.chats.taint(lid.id, T0 + 5 * DAY);
    const lidItem = seedOpenItem(repos, lid.id, T0, 'm-lid');
    repos.mediaCache.upsert({
      itemId: lidItem.id,
      chatId: lid.id,
      waMsgId: 'IMG',
      sha256: 'b'.repeat(64),
      width: 1,
      height: 1,
      bytes: 1,
      createdAt: T0,
    });
    const merged = repos.chats.mergeLidInto(lid.id, JID_A, T0 + 1);
    expect(merged.id).toBe(phone.id);
    expect(merged).toMatchObject({ autoPolicy: 'never', autoTaintedUntil: T0 + 5 * DAY });
    expect(repos.mediaCache.get(phone.id, 'IMG')).toMatchObject({ itemId: lidItem.id, chatId: phone.id });
    expect(repos.chats.byId(lid.id)).toBeNull();
  });

  it('mergeLidInto keeps the surviving chat taint when it is later, and inherit stays inherit', () => {
    const { repos } = memRepos();
    const phone = seedChat(repos, JID_A);
    repos.chats.taint(phone.id, T0 + 9 * DAY);
    const lid = repos.chats.upsertFromBridge(LID_JID, null, false, T0);
    repos.chats.taint(lid.id, T0 + DAY);
    expect(repos.chats.mergeLidInto(lid.id, JID_A, T0 + 1)).toMatchObject({
      autoPolicy: 'inherit',
      autoTaintedUntil: T0 + 9 * DAY,
    });
  });

  it('mergeLidInto is DEFERRED while an automatic write of the @lid chat can still be undone (I8), then proceeds', () => {
    const { repos } = memRepos();
    seedChat(repos, JID_A);
    const lid = repos.chats.upsertFromBridge(LID_JID, null, true, T0);
    const policy = seedPolicy(repos);
    const item = seedOpenItem(repos, lid.id, T0, 'm-lid');
    const proposal = seedProposal(repos, item.id);
    const action = repos.actions.insertPending({
      itemId: item.id,
      proposalId: proposal.id,
      chatId: lid.id,
      payload: {
        v: 1,
        kind: 'create_event',
        itemId: item.id,
        chatRef: lid.id,
        proposalVersion: proposal.version,
        title: 't',
        startLocal: '2026-10-01T10:00:00',
        endLocal: '2026-10-01T11:00:00',
        timeZone: 'Asia/Jerusalem',
        location: '',
      },
      now: T0,
    });
    const d = seedDecision(repos, { policyId: policy.id, action });
    expect(repos.actions.markApprovedExecuting(action.id, action.canonicalJson, T0, d.id)).toBe('ok');
    repos.actions.markDone(action.id, { kind: 'create_event', eventId: EVT_A, htmlLink: null }, T0);
    repos.autoWrites.insert({
      id: 'w-lid',
      decisionId: d.id,
      actionId: action.id,
      itemId: item.id,
      eventId: EVT_A,
      kind: 'create',
      pre: null,
      undoUntil: T0 + 72 * HOUR,
      writtenAt: T0,
    });
    // inside the undo window: deferred (the @lid row is returned unchanged, nothing moved or deleted)
    expect(repos.chats.mergeLidInto(lid.id, JID_A, T0 + HOUR).id).toBe(lid.id);
    expect(repos.autoWrites.byId('w-lid')).not.toBeNull();
    // after the window: the merge proceeds; the @lid chat's action rows (and with them decisions and the ledger) are deleted
    const merged = repos.chats.mergeLidInto(lid.id, JID_A, T0 + 73 * HOUR);
    expect(merged.jid).toBe(JID_A);
    expect(repos.autoWrites.byId('w-lid')).toBeNull();
    expect(repos.autoDecisions.forAction(action.id)).toBeNull();
    expect(repos.items.byId(item.id)!.chatId).toBe(merged.id);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('repos.items - editable events (findExistingEvent, F31)', () => {
  it('newestEditableEvent: newest in_calendar item with an event id, created|updated, starting at/after sinceTs', () => {
    const { repos } = memRepos();
    const first = seedCreatedEvent(repos, { now: T0, startTs: T0 + DAY });
    const chatId = first.chat.id;
    expect(repos.items.newestEditableEvent(chatId, T0)!.id).toBe(first.item.id);
    expect(repos.items.newestEditableEvent(chatId, T0 + DAY + 1)).toBeNull(); // started before sinceTs
    // a newer event in the same chat wins
    const second = seedCreatedEvent(repos, { now: T0 + HOUR, eventId: EVT_B, startTs: T0 + 2 * DAY });
    expect(second.chat.id).toBe(chatId);
    expect(repos.items.newestEditableEvent(chatId, T0)!.id).toBe(second.item.id);
    expect(repos.items.countEditableEvents(chatId, T0)).toBe(2);
    // an 'updated' acting item holding the SAME event counts once
    const acting = seedOpenItem(repos, chatId, T0 + 2 * HOUR, 'm-act');
    repos.items.update(
      acting.id,
      {
        analysis: 'done',
        eventState: 'updated',
        calendarEventId: EVT_B,
        eventStartTs: T0 + 2 * DAY,
        linkedItemId: second.item.id,
        eventRevision: 2,
      },
      T0 + 2 * HOUR,
    );
    expect(repos.items.countEditableEvents(chatId, T0)).toBe(2);
    expect(repos.items.newestEditableEvent(chatId, T0)!.id).toBe(acting.id);
    // cancelled / other chats / closed ones are never editable
    repos.items.update(acting.id, { eventState: 'cancelled' }, T0 + 3 * HOUR);
    repos.items.update(second.item.id, { closedReason: 'past' }, T0 + 3 * HOUR);
    expect(repos.items.newestEditableEvent(chatId, T0)!.id).toBe(first.item.id);
    expect(repos.items.countEditableEvents(chatId, T0)).toBe(1);
    const otherChat = seedChat(repos, JID_B);
    expect(repos.items.newestEditableEvent(otherChat.id, T0)).toBeNull();
    expect(repos.items.countEditableEvents(otherChat.id, T0)).toBe(0);
  });

  it('byCalendarEventId returns every item holding the event, oldest first', () => {
    const { repos } = memRepos();
    const src = seedCreatedEvent(repos);
    const acting = seedOpenItem(repos, src.chat.id, T0 + HOUR, 'm-act');
    repos.items.update(
      acting.id,
      { analysis: 'done', eventState: 'updated', calendarEventId: EVT_A, linkedItemId: src.item.id },
      T0 + HOUR,
    );
    expect(repos.items.byCalendarEventId(EVT_A).map((i) => i.id)).toEqual([src.item.id, acting.id]);
    expect(repos.items.byCalendarEventId(EVT_B)).toEqual([]);
  });
});
