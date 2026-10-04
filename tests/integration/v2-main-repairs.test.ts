// tests/integration/v2-main-repairs.test.ts - v2 phase 3 repair round "v2-main-defects" (ops/agent-notes/V2-W2-03-e2e.md REQUESTS),
// each defect proven RED first through the production compose() via the L3 harness (fakes only: fake bridge, fake calendar, scripted
// LLM, spawned tests/fakes/*.mjs under the system node.exe; the harness fetch refuses every non-loopback URL).
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness, extraction, type Harness } from '../helpers/harness.ts';
import { oggSilence } from '../fakes/ogg-fixtures.ts';
import { LIMITS } from '../../src/shared/types.ts';
import type { ChatRef } from '../../src/shared/types.ts';

const JID = '972550000071@s.whatsapp.net';

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

function knownContact(harness: Harness, jid: string): void {
  harness.repos.chats.upsertFromBridge(jid, 'Contact', true, harness.clock.now() as never);
}

describe('REQUEST 1 - WCA_TIMERS.debounceMs / debounceCapMs reach the triage debounce', () => {
  it('an inbound row is due debounceMs after it was enqueued (not LIMITS.debounceMs)', async () => {
    h = await createHarness({ timers: { debounceMs: 300, debounceCapMs: 900 } });
    await h.bridge.outboundFromPhone({ chatJid: JID, text: 'hey', ts: new Date(h.clock.now() - 3_600_000) });
    await h.bridge.inbound({ chatJid: JID, text: 'coffee Thursday at 5?' });
    let row: { due_at: number; first_enqueued_at: number } | undefined;
    for (let i = 0; i < 200 && row === undefined; i++) {
      h.app.poke();
      await h.advance(10);
      row = h.repos.db
        .prepare<{ due_at: number; first_enqueued_at: number }>('SELECT due_at, first_enqueued_at FROM triage_queue')
        .get();
    }
    expect(row).toBeDefined();
    expect(row!.due_at - row!.first_enqueued_at).toBe(300);
    expect(LIMITS.debounceMs).not.toBe(300);
  });
});

describe('REQUEST 2 - auto:changed follows a completed click-approved create (the track record moved)', () => {
  it('approving a create pushes auto:changed with the CURRENT AutoState', async () => {
    h = await createHarness({
      rules: [
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
      ],
    });
    await h.bridge.outboundFromPhone({ chatJid: JID, text: 'hey', ts: new Date(h.clock.now() - 3_600_000) });
    await h.bridge.inbound({ chatJid: JID, text: 'coffee Thursday at 5?' });
    await h.settle();
    const dash = await h.invoke('dashboard:get', undefined);
    if (!dash.ok) throw new Error('no dashboard');
    const create = dash.value.needsReply[0]!.actions.find((a) => a.kind === 'create_event')!;
    const before = h.pushes.filter((p) => p.event === 'auto:changed').length;
    const res = await h.invoke('action:approve', {
      actionId: create.actionId,
      kind: 'create_event',
      shownHash: create.shownHash,
    });
    expect(res).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const pushes = h.pushes.filter((p) => p.event === 'auto:changed');
    expect(pushes.length).toBeGreaterThan(before);
    const state = pushes.at(-1)!.payload as { trackRecord?: { approvedCreates?: number } };
    const current = await h.invoke('auto:getState', undefined);
    if (current.ok) expect(state).toEqual(current.value);
  });
});

describe('REQUESTS 4 + 5 - voice notes through compose()', () => {
  it('whisper exit 3 (VOICE_MODEL_MISSING) leaves the raw "Voice message" card with its code, never closes it not_needed', async () => {
    h = await createHarness({
      settings: (s) => {
        s.voice.enabled = true;
      },
      whisper: { mode: 'exit3' },
      media: [{ chatJid: JID, msgId: 'HX3', bytes: oggSilence(3) }],
    });
    knownContact(h, JID);
    h.bridgeDb.seedMediaRow({ chatJid: JID, id: 'HX3', mediaType: 'audio' });
    await h.settle();
    expect(h.repos.transcripts.get(JID, 'HX3')).toMatchObject({ status: 'failed', errorCode: 'VOICE_MODEL_MISSING' });
    const chat = h.repos.chats.byJid(JID) as { id: ChatRef };
    const item = h.repos.db
      .prepare<{ analysis: string; error_code: string | null; closed_reason: string | null; trigger_kind: string }>(
        'SELECT analysis, error_code, closed_reason, trigger_kind FROM items WHERE chat_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(chat.id);
    expect(item).toMatchObject({
      analysis: 'failed',
      error_code: 'VOICE_MODEL_MISSING',
      closed_reason: null,
      trigger_kind: 'voice',
    });
    const dash = await h.invoke('dashboard:get', undefined);
    if (!dash.ok) throw new Error('no dashboard');
    const cards = [...dash.value.needsReply, ...dash.value.inCalendar, ...dash.value.infoMissing];
    expect(cards.some((c) => c.errorCode === 'VOICE_MODEL_MISSING' && c.triggerKind === 'voice')).toBe(true);
  });

  it('the header line gets the note seconds: queue:changed transcribing {seconds: 3}, then null', async () => {
    h = await createHarness({
      settings: (s) => {
        s.voice.enabled = true;
      },
      whisper: { mode: 'ok', transcripts: { '3.0': { language: 'en', text: 'coffee Thursday at 5?' } } },
      media: [{ chatJid: JID, msgId: 'HV5', bytes: oggSilence(3) }],
    });
    knownContact(h, JID);
    h.bridgeDb.seedMediaRow({ chatJid: JID, id: 'HV5', mediaType: 'audio' });
    await h.settle();
    expect(h.repos.transcripts.get(JID, 'HV5')).toMatchObject({ status: 'done' });
    const transcribing = h.pushes
      .filter((p) => p.event === 'queue:changed')
      .map((p) => (p.payload as { transcribing: { seconds: number } | null }).transcribing);
    expect(transcribing).toContainEqual({ seconds: 3 });
    expect(transcribing.at(-1)).toBeNull();
    expect(h.health().voice?.state).not.toBe('transcribing');
  });
});

describe('REQUEST 11 - media downloads in a test build only ever reach the fake model host', () => {
  it('without a WCA_MODEL_MANIFEST entry a media download never leaves loopback', async () => {
    h = await createHarness({});
    const res = await h.invoke('model:startDownload', { tier: 'voice-hebrew' });
    expect(res.ok).toBe(true);
    for (let i = 0; i < 20; i++) await h.advance(1_000);
    expect(h.blockedFetches).toEqual([]);
  });

  it('a WCA_MODEL_MANIFEST media entry is what the download fetches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wca-seam-manifest-'));
    const manifest = join(dir, 'seam-manifest.json');
    writeFileSync(
      manifest,
      JSON.stringify({
        'voice-hebrew': {
          tier: 'voice-hebrew',
          url: 'http://127.0.0.1:9/fake-model-host/voice-hebrew.bin',
          size: 1024,
          sha256: '0'.repeat(64),
          kind: 'asr',
          magic: 'GGML',
        },
      }),
    );
    try {
      h = await createHarness({ modelManifest: manifest });
      const res = await h.invoke('model:startDownload', { tier: 'voice-hebrew' });
      expect(res.ok).toBe(true);
      for (let i = 0; i < 20; i++) await h.advance(1_000);
      expect(h.blockedFetches).toEqual([]);
      expect(h.fetched.some((u) => u.startsWith('http://127.0.0.1:9/fake-model-host/voice-hebrew.bin'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The vendor-CLI scenarios (fake-claude-cli.mjs / fake-agy.mjs spawned under the system node.exe through the S-JOB seam)
// ---------------------------------------------------------------------------------------------------------------------
const CLI_CHAT = '972550000072@s.whatsapp.net';

async function inboundFromKnown(harness: Harness, jid: string, text: string): Promise<void> {
  await harness.bridge.outboundFromPhone({ chatJid: jid, text: 'hey', ts: new Date(harness.clock.now() - 3_600_000) });
  await harness.bridge.inbound({ chatJid: jid, text });
  await harness.settle();
}
function newestItem(
  harness: Harness,
): { analysis: string; hold_reason: string | null; error_code: string | null } | undefined {
  return harness.repos.db
    .prepare<{ analysis: string; hold_reason: string | null; error_code: string | null }>(
      'SELECT analysis, hold_reason, error_code FROM items ORDER BY id DESC LIMIT 1',
    )
    .get();
}
function dataRuns(harness: Harness): string[] {
  return (harness.cliJournal() as Array<{ stage: string }>)
    .map((e) => e.stage)
    .filter((s) => s === 'extract' || s === 'draft');
}

describe('REQUEST 7 - CLI account / sandbox states reach AppHealth.llm (code, state, model)', () => {
  it('a ready claude_cli reports its OWN model id, never a Gemini one', async () => {
    h = await createHarness({ provider: 'claude_cli', cli: { claude: {} } });
    const s = h.repos.settings.get();
    expect(h.health().llm.provider).toBe('claude_cli');
    expect(h.health().llm.model).toBe(s.llm.cli.claudeModel);
  });

  it('usage_limit: CLOUD_QUOTA (state quota), the chat is held budget until resetsAt, then analysed by itself', async () => {
    const resetsAtMs = Date.UTC(2026, 8, 21, 11, 0, 0); // 2 h after the harness clock
    h = await createHarness({
      provider: 'claude_cli',
      cli: {
        claude: {
          mode: 'usage_limit',
          rateLimit: { status: 'rejected', resetsAt: resetsAtMs / 1000, isUsingOverage: false },
        },
      },
    });
    await inboundFromKnown(h, CLI_CHAT, 'coffee Thursday at 5?');
    expect(h.health().llm).toMatchObject({ state: 'quota', code: 'CLOUD_QUOTA', provider: 'claude_cli' });
    expect(h.health().llm.quota?.resetsAt).toBe(resetsAtMs);
    expect(newestItem(h)).toMatchObject({ analysis: 'held', hold_reason: 'budget', error_code: 'CLOUD_QUOTA' });
    expect(dataRuns(h)).toEqual([]); // never analysed by the exhausted account
    expect(h.bridge.sends).toHaveLength(0);

    // the account is usable again after resetsAt: the held chat is released and analysed without a click
    writeFileSync(
      join(h.userData, 'wca-fakes', 'claude-state.json'),
      JSON.stringify({ version: '2.1.258', loggedIn: true, mode: 'ok' }),
    );
    await h.advance(resetsAtMs - h.clock.now() + 1_000);
    for (let i = 0; i < 4; i++) await h.advance(LIMITS.scanIntervalMs);
    await h.settle();
    expect(h.health().llm.code).toBeUndefined();
    expect(newestItem(h)?.analysis).not.toBe('held');
    expect(dataRuns(h)).toContain('extract');
    expect(h.bridge.sends).toHaveLength(0);
  }, 60_000);

  it('usage_limit on S1 (after a passed smoke): the chat is held budget/CLOUD_QUOTA, not failed; no S3', async () => {
    const resetsAtMs = Date.UTC(2026, 8, 21, 11, 0, 0);
    h = await createHarness({
      provider: 'claude_cli',
      cli: {
        claude: {
          modeByStage: { extract: 'usage_limit' },
          rateLimit: { status: 'rejected', resetsAt: resetsAtMs / 1000, isUsingOverage: false },
        },
      },
    });
    await inboundFromKnown(h, CLI_CHAT, 'coffee Thursday at 5?');
    expect(dataRuns(h)).toEqual(['extract']);
    expect(newestItem(h)).toMatchObject({ analysis: 'held', hold_reason: 'budget', error_code: 'CLOUD_QUOTA' });
    expect(h.health().llm).toMatchObject({ state: 'quota', code: 'CLOUD_QUOTA' });
    expect(h.bridge.sends).toHaveLength(0);
  }, 60_000);

  it('overage: CLOUD_OVERAGE (state failed) and no data run starts while paused', async () => {
    h = await createHarness({
      provider: 'claude_cli',
      cli: {
        claude: {
          mode: 'overage',
          rateLimit: { status: 'allowed', resetsAt: 1_900_000_000, isUsingOverage: true },
        },
      },
    });
    await inboundFromKnown(h, CLI_CHAT, 'coffee Thursday at 5?');
    expect(h.health().llm).toMatchObject({ state: 'failed', code: 'CLOUD_OVERAGE', provider: 'claude_cli' });
    expect(dataRuns(h)).toEqual([]);
    expect(newestItem(h)?.analysis).toBe('held');
    expect(h.bridge.sends).toHaveLength(0);
  }, 60_000);

  it('extra_tool on S1: the init proof fails -> item CLI_TOOLSET_MISMATCH, no S3, AppHealth.llm.code CLI_TOOLSET_MISMATCH', async () => {
    h = await createHarness({
      provider: 'claude_cli',
      cli: { claude: { modeByStage: { extract: 'extra_tool', draft: 'extra_tool' } } },
    });
    await inboundFromKnown(h, CLI_CHAT, 'coffee Thursday at 5?');
    expect(newestItem(h)).toMatchObject({ analysis: 'failed', error_code: 'CLI_TOOLSET_MISMATCH' });
    expect(dataRuns(h)).toEqual(['extract']); // no S3 after a failed S1 init proof
    expect(h.health().llm).toMatchObject({ state: 'failed', code: 'CLI_TOOLSET_MISMATCH', provider: 'claude_cli' });
    expect(h.bridge.sends).toHaveLength(0);
  }, 60_000);

  it('a smoke whose init proof fails holds the provider with CLI_TOOLSET_MISMATCH in AppHealth', async () => {
    h = await createHarness({ provider: 'claude_cli', cli: { claude: { modeByStage: { smoke: 'extra_tool' } } } });
    await inboundFromKnown(h, CLI_CHAT, 'coffee Thursday at 5?');
    expect(dataRuns(h)).toEqual([]);
    expect(h.health().llm).toMatchObject({ state: 'failed', code: 'CLI_TOOLSET_MISMATCH' });
  }, 60_000);
});

describe('REQUEST 9 - isolated Antigravity profile: workspace trust is recorded as not needed', () => {
  it('CliStatus.workspaceTrusted is true in the default isolated mode (no user file is touched)', async () => {
    h = await createHarness({ cli: { agy: {} } });
    const st = await h.invoke('cli:getStatus', { provider: 'antigravity_cli' });
    expect(st).toMatchObject({ ok: true, value: { provider: 'antigravity_cli', workspaceTrusted: true } });
    const claude = await h.invoke('cli:getStatus', { provider: 'claude_cli' });
    if (claude.ok) expect(claude.value.workspaceTrusted).toBeNull();
    expect(h.dialogs.filter((d) => d.kind === 'agy_workspace')).toHaveLength(0);
  });
});

describe('REQUEST 13 - "Use" before any "Run a test" runs the provider-start smoke instead of claiming CLI_UNSTABLE', () => {
  it('consent accepted, never tested: llm:setProvider runs the smoke and selects claude_cli', async () => {
    h = await createHarness({ cli: { claude: {} } });
    const consent = await h.invoke('consent:accept', { kind: 'cloud_claude_cli', version: 1 });
    expect(consent.ok).toBe(true);
    const res = await h.invoke('llm:setProvider', { provider: 'claude_cli' });
    expect(res.ok).toBe(true);
    expect(h.repos.settings.get().llm.provider).toBe('claude_cli');
    const smokes = (h.cliJournal() as Array<{ stage: string }>).filter((e) => e.stage === 'smoke');
    expect(smokes.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('never tested and the smoke fails: the honest code of THAT failure, the previous provider stays', async () => {
    h = await createHarness({ cli: { claude: { modeByStage: { smoke: 'auth_failed' } } } });
    await h.invoke('consent:accept', { kind: 'cloud_claude_cli', version: 1 });
    const res = await h.invoke('llm:setProvider', { provider: 'claude_cli' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).not.toBe('CLI_UNSTABLE');
    expect(h.repos.settings.get().llm.provider).toBe('local');
  }, 60_000);
});
