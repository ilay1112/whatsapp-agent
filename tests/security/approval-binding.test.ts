// tests/security/approval-binding.test.ts - gate item 5 of TESTS 8.2 (invariants I1, A11). Owner: W2-02.
//
// Drives the REAL app through `ipcMain.invokeAs` (the harness registers the production `registerIpc` + handlers), the REAL
// `ActionExecutor`, the REAL `actionHash` and the REAL `actions` triggers. Nothing that is under test is mocked.
// The global ledger hook (tests/helpers/ledger-hook.ts) re-checks after EVERY case that no side effect happened without
// a matching approval row.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createHarness, extraction, type Harness } from '../helpers/harness.ts';
import type { StubRule } from '../fakes/stub-llm.ts';
import { ActionNotExecutingError, createActionExecutor } from '../../src/main/exec/actionExecutor.ts';
import { IPC_REQUEST_SCHEMAS } from '../../src/shared/ipc.ts';
import { LIMITS } from '../../src/shared/types.ts';
import type { ActionId, EpochMs, ItemCard } from '../../src/shared/types.ts';
import type { IpcEventLike } from '../../src/main/ipc/sender.ts';

const CHAT = '972550000001@s.whatsapp.net';
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 2026-09-21 09:00 UTC = Monday 12:00 Asia/Jerusalem; "Thursday at 5" resolves to 2026-09-24T17:00 local. */
const RULES: StubRule[] = [
  {
    when: { purpose: 'extract' },
    respond: {
      structured: extraction({
        intent: 'schedule_request',
        needsReply: true,
        title: 'coffee',
        dateKind: 'weekday',
        weekday: 4,
        time24h: '17:00',
        durationMin: 60,
      }),
    },
  },
  { when: { purpose: 'draft' }, respond: { text: 'Thursday 17:00 works', stopReason: 'end' } },
];

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

/** Produces one card with a pending `send_reply` and a pending `create_event`. */
async function seedCard(over: Parameters<typeof createHarness>[0] = {}): Promise<{ harness: Harness; card: ItemCard }> {
  const harness = await createHarness({ rules: RULES, ...over });
  h = harness;
  await harness.bridge.outboundFromPhone({ chatJid: CHAT, text: 'hey', ts: new Date(harness.clock.now() - 3_600_000) });
  await harness.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?' });
  await harness.settle();
  const dash = await harness.invoke('dashboard:get', undefined);
  if (!dash.ok) throw new Error('dashboard failed');
  const card = dash.value.needsReply[0];
  if (card === undefined) throw new Error('no card was produced');
  return { harness, card };
}

const sendAction = (card: ItemCard): ItemCard['actions'][number] => card.actions.find((a) => a.kind === 'send_reply')!;
const createAction = (card: ItemCard): ItemCard['actions'][number] =>
  card.actions.find((a) => a.kind === 'create_event')!;

function errorCode(res: { ok: boolean; error?: { code: string } }): string | null {
  return res.ok ? null : (res.error?.code ?? null);
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. the approve request itself
// ---------------------------------------------------------------------------------------------------------------------
describe('A11 - an approve that is not bound to what the user saw is refused', () => {
  it('refuses a forged / unknown actionId', async () => {
    const { harness, card } = await seedCard();
    const send = sendAction(card);
    const res = await harness.invoke('action:approve', {
      actionId: '00000000-0000-4000-8000-000000000000' as ActionId,
      kind: 'send_reply',
      shownHash: send.shownHash,
    });
    expect(errorCode(res)).toBe('ACTION_STALE');
    expect(harness.bridge.sends).toHaveLength(0);
  });

  it('refuses a kind mismatch', async () => {
    const { harness, card } = await seedCard();
    const send = sendAction(card);
    const res = await harness.invoke('action:approve', {
      actionId: send.actionId,
      kind: 'create_event',
      shownHash: send.shownHash,
    });
    expect(errorCode(res)).toBe('ACTION_STALE');
    expect(harness.bridge.sends).toHaveLength(0);
    expect(harness.calendar.calls.filter((c) => c.tool === 'create-event')).toHaveLength(0);
  });

  it('refuses a wrong shownHash (the card on screen was not this payload)', async () => {
    const { harness, card } = await seedCard();
    const send = sendAction(card);
    for (const hash of ['0'.repeat(64), 'f'.repeat(64), send.shownHash.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'))]) {
      const res = await harness.invoke('action:approve', {
        actionId: send.actionId,
        kind: 'send_reply',
        shownHash: hash,
      });
      expect(errorCode(res), hash).toBe('ACTION_STALE');
    }
    expect(harness.bridge.sends).toHaveLength(0);
  });

  it('refuses an extra field - the recipient can never travel with the click', () => {
    const schema = IPC_REQUEST_SCHEMAS['action:approve'];
    const base = {
      actionId: '00000000-0000-4000-8000-000000000000',
      kind: 'send_reply' as const,
      shownHash: 'a'.repeat(64),
    };
    expect(schema.safeParse(base).success).toBe(true);
    for (const extra of [
      { chatJid: CHAT },
      { recipient: '972550000099@s.whatsapp.net' },
      { url: 'https://evil.example' },
      { calendarId: 'attacker@example.com' },
      { attendees: ['attacker@example.com'] },
      { confirmConflict: true }, // create_event only
      { edit: { title: 'x', startLocal: '2026-09-24T17:00:00', endLocal: '2026-09-24T18:00:00', location: '' } },
    ]) {
      expect(schema.safeParse({ ...base, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it('refuses a malformed actionId or shownHash before any handler runs', () => {
    const schema = IPC_REQUEST_SCHEMAS['action:approve'];
    expect(schema.safeParse({ actionId: 'not-a-uuid', kind: 'send_reply', shownHash: 'a'.repeat(64) }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({
        actionId: '00000000-0000-4000-8000-000000000000',
        kind: 'send_reply',
        shownHash: 'A'.repeat(64),
      }).success,
    ).toBe(false);
  });

  it('refuses an expired action (virtual clock + 24 h 1 s)', async () => {
    const { harness, card } = await seedCard();
    const send = sendAction(card);
    await harness.advance(LIMITS.actionTtlMs + 1_000);
    const res = await harness.invoke('action:approve', {
      actionId: send.actionId,
      kind: 'send_reply',
      shownHash: send.shownHash,
    });
    expect(errorCode(res)).toBe('ACTION_EXPIRED');
    expect(harness.bridge.sends).toHaveLength(0);
  });

  it('refuses a superseded action (a newer proposal replaced the card)', async () => {
    const { harness, card } = await seedCard();
    const send = sendAction(card);
    await harness.bridge.inbound({ chatJid: CHAT, text: 'actually make it Friday' });
    await harness.settle();
    const res = await harness.invoke('action:approve', {
      actionId: send.actionId,
      kind: 'send_reply',
      shownHash: send.shownHash,
    });
    expect(res.ok).toBe(false);
    expect(['ACTION_STALE', 'ACTION_EXPIRED']).toContain(errorCode(res));
    expect(harness.bridge.sends).toHaveLength(0);
  });

  it('refuses an already-rejected action', async () => {
    const { harness, card } = await seedCard();
    const send = sendAction(card);
    const rejected = await harness.invoke('action:reject', { actionId: send.actionId });
    expect(rejected.ok).toBe(true);
    const res = await harness.invoke('action:approve', {
      actionId: send.actionId,
      kind: 'send_reply',
      shownHash: send.shownHash,
    });
    expect(errorCode(res)).toBe('ACTION_STALE');
    expect(harness.bridge.sends).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. the window gate + the [R2] focus-steal guard
// ---------------------------------------------------------------------------------------------------------------------
describe('A11 - the click must have happened on a card the user was looking at', () => {
  it('refuses an approve while the window is hidden', async () => {
    const { harness, card } = await seedCard();
    const send = sendAction(card);
    const res = await harness.invoke(
      'action:approve',
      { actionId: send.actionId, kind: 'send_reply', shownHash: send.shownHash },
      { windowVisible: false },
    );
    expect(errorCode(res)).toBe('WINDOW_NOT_FOCUSED');
    expect(harness.bridge.sends).toHaveLength(0);
  });

  it('refuses an approve while the window is not focused', async () => {
    const { harness, card } = await seedCard();
    const send = sendAction(card);
    const res = await harness.invoke(
      'action:approve',
      { actionId: send.actionId, kind: 'send_reply', shownHash: send.shownHash },
      { windowFocused: false },
    );
    expect(errorCode(res)).toBe('WINDOW_NOT_FOCUSED');
    expect(harness.bridge.sends).toHaveLength(0);
  });

  it('[R2] refuses an approve that arrives 100 ms after a notification click showed the window', async () => {
    const { harness, card } = await seedCard();
    const send = sendAction(card);
    const shownAt = (harness.clock.now() - 100) as EpochMs;
    expect(LIMITS.focusGuardMainMs).toBe(300);
    const res = await harness.invoke(
      'action:approve',
      { actionId: send.actionId, kind: 'send_reply', shownHash: send.shownHash },
      { shownByNotificationAt: shownAt },
    );
    expect(errorCode(res)).toBe('WINDOW_NOT_FOCUSED');
    expect(harness.bridge.sends).toHaveLength(0);
  });

  it('[R2] allows the approve once the focus guard window has passed', async () => {
    const { harness, card } = await seedCard();
    const send = sendAction(card);
    const shownAt = (harness.clock.now() - LIMITS.focusGuardMainMs - 1) as EpochMs;
    const res = await harness.invoke(
      'action:approve',
      { actionId: send.actionId, kind: 'send_reply', shownHash: send.shownHash },
      { shownByNotificationAt: shownAt },
    );
    await harness.advance(20_000);
    expect(res.ok).toBe(true);
    expect(harness.bridge.sends).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. the sender frame
// ---------------------------------------------------------------------------------------------------------------------
describe('I1 - only our own top frame at app://bundle may invoke', () => {
  it('rejects every foreign sender', async () => {
    const { harness } = await seedCard();
    const trusted = (url: string, over: Partial<IpcEventLike> = {}): IpcEventLike => ({
      senderFrame: { url, parent: null },
      sender: { id: 1, isDestroyed: () => false },
      ...over,
    });
    expect(harness.app.isTrusted(trusted('app://bundle/index.html'))).toBe(true);

    const hostile: Array<[string, IpcEventLike]> = [
      ['https://evil.example', trusted('https://evil.example/')],
      ['file://', trusted('file:///C:/Windows/System32/x.html')],
      ['data:', trusted('data:text/html,<script>1</script>')],
      ['app://bundle.evil.example', trusted('app://bundle.evil.example/index.html')],
      ['app://bundle@evil.example', trusted('app://bundle@evil.example/index.html')],
      ['http://bundle', trusted('http://bundle/index.html')],
      [
        'sub-frame',
        { senderFrame: { url: 'app://bundle/index.html', parent: {} }, sender: { id: 1, isDestroyed: () => false } },
      ],
      [
        'another webContents',
        { senderFrame: { url: 'app://bundle/index.html', parent: null }, sender: { id: 99, isDestroyed: () => false } },
      ],
      [
        'destroyed sender',
        { senderFrame: { url: 'app://bundle/index.html', parent: null }, sender: { id: 1, isDestroyed: () => true } },
      ],
      ['no frame', { senderFrame: null, sender: { id: 1, isDestroyed: () => false } }],
    ];
    for (const [label, event] of hostile) {
      expect(harness.app.isTrusted(event), label).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. edits
// ---------------------------------------------------------------------------------------------------------------------
describe('A11 - the edit is re-validated at click time', () => {
  it('refuses a draft edit that is too long', async () => {
    const { harness, card } = await seedCard();
    const send = sendAction(card);
    const res = await harness.invoke('action:approve', {
      actionId: send.actionId,
      kind: 'send_reply',
      shownHash: send.shownHash,
      edit: { text: 'x'.repeat(LIMITS.draftChars + 1) },
    });
    expect(res.ok).toBe(false);
    expect(harness.bridge.sends).toHaveLength(0);
  });

  it('refuses an empty edit, and one that is empty only after the invisible characters are stripped', async () => {
    const { harness, card } = await seedCard();
    const send = sendAction(card);
    for (const text of ['', '​​​', '‮﻿']) {
      const res = await harness.invoke('action:approve', {
        actionId: send.actionId,
        kind: 'send_reply',
        shownHash: send.shownHash,
        edit: { text },
      });
      expect(res.ok, JSON.stringify(text)).toBe(false);
    }
    expect(harness.bridge.sends).toHaveLength(0);
  });

  it('strips invisible characters from an accepted edit before it reaches the wire', async () => {
    const { harness, card } = await seedCard();
    const send = sendAction(card);
    // The declared strip set of `stripInvisible`: C0 (except \n), zero-width, bidi controls, BOM, Unicode TAG block.
    const dirty = 'See\u200b you\u200d Thu\u202erday\ufeff\u0001 at\u2066 17:00\udb40\udc41';
    const res = await harness.invoke('action:approve', {
      actionId: send.actionId,
      kind: 'send_reply',
      shownHash: send.shownHash,
      edit: { text: dirty },
    });
    await harness.advance(20_000);
    expect(res.ok).toBe(true);
    expect(harness.bridge.sends).toHaveLength(1);
    const sent = harness.bridge.sends[0]!;
    expect(sent.recipient).toBe(CHAT);
    expect(sent.message).not.toMatch(
      /[\u0000-\u0009\u000B-\u001F\u007F\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]|\uDB40[\uDC00-\uDC7F]/,
    );
    expect(sent.message).toContain('17:00');
    // The row the ledger checks carries exactly what went out.
    const row = harness.repos.actions.byId(send.actionId);
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.approvedFinalJson ?? '{}').text).toBe(sent.message);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. [R2] the double click - exactly one side effect
// ---------------------------------------------------------------------------------------------------------------------
describe('[R2] A11 - two concurrent approvals produce exactly one side effect', () => {
  it('send_reply: the loser gets ACTION_STALE with no failure row, no retry clone, no second send', async () => {
    const { harness, card } = await seedCard();
    const send = sendAction(card);
    const req = { actionId: send.actionId, kind: 'send_reply' as const, shownHash: send.shownHash };
    const [a, b] = await Promise.all([harness.invoke('action:approve', req), harness.invoke('action:approve', req)]);
    await harness.advance(30_000);

    const results = [a, b];
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(errorCode(losers[0]!)).toBe('ACTION_STALE');

    expect(harness.bridge.sends).toHaveLength(1);
    const rows = harness.repos.db
      .prepare(`SELECT id, state, retry_of FROM actions WHERE kind='send_reply'`)
      .all() as Array<{ id: string; state: string; retry_of: string | null }>;
    expect(rows).toHaveLength(1); // no retry clone
    expect(['executing', 'done']).toContain(rows[0]!.state);

    const audit = harness.repos.db
      .prepare(`SELECT kind, ref FROM audit_log WHERE ref = ?`)
      .all(send.actionId) as Array<{ kind: string }>;
    expect(audit.filter((r) => r.kind === 'action_approved')).toHaveLength(1);
    expect(audit.filter((r) => r.kind === 'action_failed')).toHaveLength(0);
  });

  it('create_event: the loser gets ACTION_STALE and the calendar sees exactly one create-event', async () => {
    const { harness, card } = await seedCard();
    const create = createAction(card);
    const req = {
      actionId: create.actionId,
      kind: 'create_event' as const,
      shownHash: create.shownHash,
      confirmConflict: true as const,
    };
    // Both invocations pass the synchronous pending check and then await the fresh free/busy pre-check, so the race is
    // decided by the write-ahead compare-and-set, exactly as it is in production.
    const [a, b] = await Promise.all([harness.invoke('action:approve', req), harness.invoke('action:approve', req)]);
    await harness.advance(30_000);

    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok)!;
    expect(errorCode(loser)).toBe('ACTION_STALE');

    const creates = harness.calendar.calls.filter((c) => c.tool === 'create-event');
    expect(creates).toHaveLength(1);
    expect(harness.calendar.events).toHaveLength(1);

    const rows = harness.repos.db.prepare(`SELECT id, state FROM actions WHERE kind='create_event'`).all() as Array<{
      state: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(['executing', 'done']).toContain(rows[0]!.state);
    const audit = harness.repos.db.prepare(`SELECT kind FROM audit_log WHERE ref = ?`).all(create.actionId) as Array<{
      kind: string;
    }>;
    expect(audit.filter((r) => r.kind === 'action_approved')).toHaveLength(1);
    expect(audit.filter((r) => r.kind === 'action_failed')).toHaveLength(0);
  });

  it('a third click after the winner finished is still refused', async () => {
    const { harness, card } = await seedCard();
    const send = sendAction(card);
    const req = { actionId: send.actionId, kind: 'send_reply' as const, shownHash: send.shownHash };
    const first = await harness.invoke('action:approve', req);
    await harness.advance(30_000);
    expect(first.ok).toBe(true);
    const again = await harness.invoke('action:approve', req);
    expect(errorCode(again)).toBe('ACTION_STALE');
    expect(harness.bridge.sends).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 6. the DB triggers - direct SQL cannot forge an approval
// ---------------------------------------------------------------------------------------------------------------------
describe('[R2] A11 - the actions triggers refuse a forged state transition', () => {
  it('cannot move a pending row straight to executing', async () => {
    const { harness, card } = await seedCard();
    const send = sendAction(card);
    expect(() =>
      harness.repos.db.prepare(`UPDATE actions SET state='executing' WHERE id=?`).run(send.actionId),
    ).toThrow(/execute without approval/);
    expect(harness.repos.actions.byId(send.actionId)?.state).toBe('pending');
    expect(harness.bridge.sends).toHaveLength(0);
  });

  it('cannot move a pending row straight to done', async () => {
    const { harness, card } = await seedCard();
    const send = sendAction(card);
    expect(() => harness.repos.db.prepare(`UPDATE actions SET state='done' WHERE id=?`).run(send.actionId)).toThrow(
      /bad done/,
    );
  });

  it('cannot approve without an approved_at / approved_final_json', async () => {
    const { harness, card } = await seedCard();
    const send = sendAction(card);
    expect(() => harness.repos.db.prepare(`UPDATE actions SET state='approved' WHERE id=?`).run(send.actionId)).toThrow(
      /bad approve/,
    );
  });

  it('[R2] cannot return an executing row to pending, and cannot rewrite its approved payload', async () => {
    const { harness, card } = await seedCard();
    const send = sendAction(card);
    const req = { actionId: send.actionId, kind: 'send_reply' as const, shownHash: send.shownHash };
    const approved = await harness.invoke('action:approve', req);
    expect(approved.ok).toBe(true);
    // The row is `done` by now; force a row back to `executing` through the legal path first is impossible, so both
    // the terminal guard and the pending guard are asserted here.
    expect(() => harness.repos.db.prepare(`UPDATE actions SET state='pending' WHERE id=?`).run(send.actionId)).toThrow(
      /cannot return to pending|terminal state/,
    );
    expect(() =>
      harness.repos.db
        .prepare(`UPDATE actions SET approved_final_json=? WHERE id=?`)
        .run(JSON.stringify({ kind: 'send_reply', text: 'attacker text' }), send.actionId),
    ).toThrow(/final payload is immutable/);
  });

  it('cannot rewrite the canonical payload, the chat or the kind of any action', async () => {
    const { harness, card } = await seedCard();
    const send = sendAction(card);
    for (const [sql, args] of [
      [
        `UPDATE actions SET canonical_json=? WHERE id=?`,
        [JSON.stringify({ kind: 'send_reply', text: 'evil' }), send.actionId],
      ],
      [`UPDATE actions SET chat_id=999999 WHERE id=?`, [send.actionId]],
      [`UPDATE actions SET kind='create_event' WHERE id=?`, [send.actionId]],
      [`UPDATE actions SET content_sha256=? WHERE id=?`, ['f'.repeat(64), send.actionId]],
    ] as Array<[string, Array<string | number>]>) {
      expect(() => harness.repos.db.prepare(sql).run(...args), sql).toThrow(/approved content is immutable/);
    }
  });

  it('cannot insert an action that is already approved', async () => {
    const { harness, card } = await seedCard();
    const send = sendAction(card);
    const row = harness.repos.db.prepare(`SELECT * FROM actions WHERE id=?`).get(send.actionId) as Record<
      string,
      unknown
    >;
    const col = (name: string): string | number => row[name] as string | number;
    expect(() =>
      harness.repos.db
        .prepare(
          `INSERT INTO actions (id, item_id, proposal_id, chat_id, kind, canonical_json, content_sha256, state, idempotency_key, attempt, created_at, expires_at)
           VALUES (?,?,?,?,?,?,?, 'executing', ?, 1, ?, ?)`,
        )
        .run(
          '00000000-0000-4000-8000-0000000000ff',
          col('item_id'),
          col('proposal_id'),
          col('chat_id'),
          'send_reply',
          col('canonical_json'),
          col('content_sha256'),
          'forged-key',
          col('created_at'),
          col('expires_at'),
        ),
    ).toThrow(/actions must be born pending with content/);
  });

  it('the audit log is append-only', async () => {
    const { harness } = await seedCard();
    harness.repos.audit.append('ipc_rejected', null, { channel: 'test' }, harness.clock.now());
    const row = harness.repos.db.prepare(`SELECT id FROM audit_log LIMIT 1`).get() as { id: number } | undefined;
    expect(row).toBeDefined();
    expect(() => harness.repos.db.prepare(`UPDATE audit_log SET kind='nothing' WHERE id=?`).run(row!.id)).toThrow(
      /append-only/,
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 7. ActionExecutor.execute() cannot be used to bypass the approval
// ---------------------------------------------------------------------------------------------------------------------
describe('I1 - execute() refuses an action that never went through the write-ahead', () => {
  it('throws before touching the bridge or the calendar client', async () => {
    const { harness, card } = await seedCard();
    const send = sendAction(card);
    const create = createAction(card);

    const touched: string[] = [];
    const explode =
      (label: string) =>
      (...args: unknown[]): never => {
        touched.push(label);
        void args;
        throw new Error(`${label} must never be reached`);
      };

    // The REAL executor over the REAL database; only the side-effect clients are spies that refuse to be called.
    const executor = createActionExecutor({
      repos: harness.repos,
      send: { send: explode('bridge.send') } as never,
      write: { createEvent: explode('calendar.createEvent') } as never,
      read: { freeBusy: () => Promise.resolve([]), listEvents: () => Promise.resolve([]) } as never,
      bridgeOnline: () => true,
      calendarConnected: () => true,
      settings: () => harness.repos.settings.get(),
      now: () => harness.clock.now(),
      sleep: () => Promise.resolve(),
      random: () => 0.5,
      notifyChanged: () => undefined,
    });

    await expect(executor.execute(send.actionId as ActionId)).rejects.toBeInstanceOf(ActionNotExecutingError);
    await expect(executor.execute(create.actionId as ActionId)).rejects.toBeInstanceOf(ActionNotExecutingError);
    await expect(executor.execute('00000000-0000-4000-8000-000000000000' as ActionId)).rejects.toBeInstanceOf(
      ActionNotExecutingError,
    );
    expect(touched).toEqual([]);
    expect(harness.bridge.sends).toHaveLength(0);
    expect(harness.calendar.calls.filter((c) => c.tool === 'create-event')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 8. a toast click and a tray click can only navigate
// ---------------------------------------------------------------------------------------------------------------------
describe('I1 - notification and tray paths carry no approval capability', () => {
  it('no module under src/main/app/** can reach the executor', () => {
    const offenders: Array<{ file: string; hit: string }> = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
        const code = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
        for (const hit of ['actionExecutor', 'executor.approve', 'ActionExecutor', 'sendClient', 'writeClient']) {
          if (code.includes(hit)) offenders.push({ file: entry, hit });
        }
      }
    };
    walk(join(REPO_ROOT, 'src', 'main', 'app'));
    expect(offenders).toEqual([]);
  });

  it('only `ui:navigate` is ever pushed for a tray / toast interaction', async () => {
    const { harness } = await seedCard();
    const before = harness.bridge.sends.length;
    harness.app.togglePause();
    harness.app.togglePause();
    await harness.advance(1_000);
    // Nothing a tray click can do produces a side effect; the push surface stays the declared event set.
    expect(harness.bridge.sends).toHaveLength(before);
    const events = new Set(harness.pushes.map((p) => p.event));
    for (const e of events) {
      expect(['health', 'dashboard', 'pairing', 'google', 'model', 'language', 'navigate']).toContain(e);
    }
  });
});
