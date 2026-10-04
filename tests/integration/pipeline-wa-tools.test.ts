// T2 6 row `pipeline-wa-tools.test.ts` (production compose() via the harness; owner V2-W1-05-wa-toolserver in Wave 1, V2-W2-01 in Wave 2).
// The WA-readonly 8.4 delta scenario: day 1 "Wednesday 3pm?" - the user already answered - day 3 "can we do 5pm instead?"; the scripted
// model calls wa_search_messages, then wa_get_message_context on the handle it was shown, then drafts. The WhatsApp world is the standard
// one of tests/helpers/waWorld.ts (harness option `waWorld: true`, wired by V2-W2-01). Every message text below is test DATA.
import { afterEach, describe, expect, it } from 'vitest';
import { dialog } from 'electron';
import { createHarness, extraction, type Harness } from '../helpers/harness.ts';
import type { StubRule } from '../fakes/stub-llm.ts';
import { WA_WORLD_JIDS } from '../helpers/waWorld.ts';
import { CONSENT_VERSIONS } from '../../src/shared/types.ts';

const TRIGGER = WA_WORLD_JIDS.trigger;
const DATA_BLOCK = /^<<DATA-([0-9a-f]{16})>>\n[\s\S]*\n<<END-DATA-\1>>$/;

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

/** S1 finds a schedule change; S3 reads the chat through two WhatsApp tools, then drafts. */
function deltaRules(opts: { searchChat?: string } = {}): StubRule[] {
  return [
    {
      when: { purpose: 'extract' },
      respond: {
        structured: extraction({
          intent: 'schedule_request',
          needsReply: true,
          title: 'meeting',
          dateKind: 'weekday',
          weekday: 3,
          time24h: '17:00',
          durationMin: 60,
        }),
      },
    },
    {
      when: { purpose: 'draft', turn: 0 },
      respond: {
        toolCalls: [
          {
            name: 'wa_search_messages',
            input: { query: 'Wednesday', ...(opts.searchChat ? { chat: opts.searchChat } : {}) },
          },
        ],
      },
    },
    {
      when: { purpose: 'draft', turn: 1 },
      respond: { toolCalls: [{ name: 'wa_get_message_context', input: { message: 'm_1' } }] },
    },
    {
      when: { purpose: 'draft', turn: 2 },
      respond: { text: 'Sure, 5pm on Wednesday works for me.', stopReason: 'end' },
    },
  ];
}

async function runDelta(harness: Harness): Promise<void> {
  await harness.bridge.inbound({ chatJid: TRIGGER, text: 'can we do 5pm instead?' });
  await harness.settle();
}

describe('pipeline - WhatsApp read tools in S3 (B17)', () => {
  it('the delta scenario: 2 executed tool calls, 0 blocked, every tool result nonce-wrapped, wa_rows_served persisted', async () => {
    h = await createHarness({ waWorld: true, rules: deltaRules() });
    await runDelta(h);

    const toolMessages = h.llm.calls.flatMap((c) => c.messages.filter((m) => m.role === 'tool'));
    const results = toolMessages.flatMap(
      (m) => (m as { results: Array<{ name: string; content: string; isError?: boolean }> }).results,
    );
    const byName = new Map(results.map((r) => [r.name, r]));
    expect([...byName.keys()].sort()).toEqual(['wa_get_message_context', 'wa_search_messages']);
    for (const r of byName.values()) {
      expect(r.isError).not.toBe(true);
      expect(r.content).toMatch(DATA_BLOCK);
      expect(r.content).not.toMatch(/@s\.whatsapp\.net|\d{9,}/);
    }
    expect(byName.get('wa_search_messages')!.content).toContain('Wednesday');

    const run = h.repos.db
      .prepare<{ tool_calls: number; blocked_tool_calls: number; wa_rows_served: number }>(
        `SELECT tool_calls, blocked_tool_calls, wa_rows_served FROM runs WHERE stage = 'draft' ORDER BY id DESC LIMIT 1`,
      )
      .get()!;
    expect(run.tool_calls).toBe(2);
    expect(run.blocked_tool_calls).toBe(0);
    expect(run.wa_rows_served).toBeGreaterThan(0);
    const blocked = h.repos.db
      .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE kind = 'tool_blocked'`)
      .get()!;
    expect(blocked.n).toBe(0);
    const proposal = h.repos.db
      .prepare<{ cross_chat_rows: number }>('SELECT cross_chat_rows FROM proposals ORDER BY rowid DESC LIMIT 1')
      .get()!;
    expect(proposal.cross_chat_rows).toBe(0); // trigger_chat scope (the default)
  });

  it('cross_chat_rows > 0 only under all_chats (the S4 guard input is populated, the draft does not quote the other chat)', async () => {
    h = await createHarness({
      waWorld: true,
      rules: [
        ...deltaRules().slice(0, 1),
        {
          when: { purpose: 'draft', turn: 0 },
          respond: { toolCalls: [{ name: 'wa_search_messages', input: { query: 'address' } }] },
        },
        { when: { purpose: 'draft', turn: 1 }, respond: { text: 'See you Wednesday at 5.', stopReason: 'end' } },
      ],
      settings: (s) => {
        s.whatsapp.readTools.scope = 'all_chats';
      },
    });
    await runDelta(h);
    const proposal = h.repos.db
      .prepare<{ cross_chat_rows: number }>('SELECT cross_chat_rows FROM proposals ORDER BY rowid DESC LIMIT 1')
      .get()!;
    expect(proposal.cross_chat_rows).toBeGreaterThan(0);
  });

  it('a search pinned by trigger_chat never reaches another chat, whatever the model asks', async () => {
    h = await createHarness({ waWorld: true, rules: deltaRules({ searchChat: 'chat_2' }) });
    await runDelta(h);
    const results = h.llm.calls
      .flatMap((c) => c.messages.filter((m) => m.role === 'tool'))
      .flatMap((m) => (m as { results: Array<{ content: string }> }).results);
    expect(results.map((r) => r.content).join('\n')).not.toContain('SENTINEL_OTHER_CHAT');
    const proposal = h.repos.db
      .prepare<{ cross_chat_rows: number }>('SELECT cross_chat_rows FROM proposals ORDER BY rowid DESC LIMIT 1')
      .get()!;
    expect(proposal.cross_chat_rows).toBe(0);
  });
});

describe('wa:setReadScope - all_chats with a cloud provider needs the consent v2 (B17, F11)', () => {
  it('refused on a v1 consent record; accepted (after the native confirmation) once the current version is recorded', async () => {
    h = await createHarness({ waWorld: true, provider: 'claude' });
    h.repos.db.prepare(`DELETE FROM consents WHERE kind = 'cloud_claude'`).run();
    h.repos.consents.accept('cloud_claude', 1, h.clock.now());
    const refused = await h.invoke('wa:setReadScope', { scope: 'all_chats' });
    expect(refused).toMatchObject({ ok: false, error: { code: 'CONSENT_REQUIRED' } });
    expect(h.app.settings.get().whatsapp.readTools.scope).toBe('trigger_chat');

    h.repos.consents.accept('cloud_claude', CONSENT_VERSIONS.cloud_claude, h.clock.now());
    (dialog as unknown as { __script(e: Array<{ response: number; checkboxChecked: boolean }>): void }).__script([
      { response: 1, checkboxChecked: true },
    ]);
    const accepted = await h.invoke('wa:setReadScope', { scope: 'all_chats' });
    expect(accepted).toMatchObject({ ok: true, value: { scope: 'all_chats' } });
    const back = await h.invoke('wa:setReadScope', { scope: 'trigger_chat' }); // narrowing: one click, no dialog
    expect(back).toMatchObject({ ok: true, value: { scope: 'trigger_chat' } });
  });
});
