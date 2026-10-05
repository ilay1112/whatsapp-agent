// T2 5 `ipc/handlers/settings`: wa:setReadScope (F11, B17) and the v2 settings:set checks (C2 4). The strict-parse rejections of
// auto / llm.provider / llm.cli.claudeExePath / llm.cli.allowOverage / whatsapp.readTools.scope are register.ts's (register.test.ts).
import { describe, expect, it, vi } from 'vitest';
import { CONSENT_VERSIONS, LIMITS, type ProviderId, type VoiceState } from '../../../shared/types';
import { makeFixture, NOW_0 } from '../register.fixtures';
import type { SettingsHandlersV2 } from '../register';
import { createSettingsHandlers, vendorOf } from './settings';

const CTX = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };
const WIN = { id: 'focused-window' };

const READY: VoiceState = {
  enabled: false,
  tier: 'auto',
  resolvedTier: 'voice-hebrew',
  model: { id: 'voice-hebrew', sizeBytes: 1, status: 'ready', bytesDone: 1 },
  vad: { status: 'ready' },
  secPerAudioSec: null,
  suggestLite: false,
};

function setup(opts: { confirm?: boolean; provider?: ProviderId; voice?: VoiceState; wired?: boolean } = {}) {
  const f = makeFixture();
  if (opts.provider !== undefined) f.state.settings.llm.provider = opts.provider;
  const confirmSetting = vi.fn(async () => opts.confirm ?? true);
  const v2: SettingsHandlersV2 = {
    voice: { state: () => opts.voice ?? READY },
    autoDialog: { confirmSetting },
    dialogParent: () => WIN,
  };
  return { f, h: createSettingsHandlers(f.deps, opts.wired === false ? undefined : v2), confirmSetting };
}

describe('wa:setReadScope', () => {
  it('trigger_chat -> all_chats with Local: native confirmation (no vendor), then written + audited', async () => {
    const { f, h, confirmSetting } = setup();
    expect(await h['wa:setReadScope']({ scope: 'all_chats' }, CTX)).toEqual({
      ok: true,
      value: { scope: 'all_chats' },
    });
    expect(confirmSetting).toHaveBeenCalledWith(WIN, 'read_all_chats', null);
    expect(f.state.settings.whatsapp.readTools.scope).toBe('all_chats');
    expect(f.rec.audits).toEqual([
      {
        kind: 'settings_changed',
        ref: null,
        detail: { key: 'whatsapp.readTools.scope', value: 'all_chats' },
        now: NOW_0,
      },
    ]);
    expect(f.rec.settingsNotified).toHaveLength(0); // no subscriber in this fixture; the bus itself notifies (contract test)
  });

  it('a cancelled confirmation changes nothing and is not an error', async () => {
    const { f, h } = setup({ confirm: false });
    expect(await h['wa:setReadScope']({ scope: 'all_chats' }, CTX)).toEqual({
      ok: true,
      value: { scope: 'trigger_chat' },
    });
    expect(f.state.settings.whatsapp.readTools.scope).toBe('trigger_chat');
    expect(f.rec.audits).toEqual([]);
  });

  it('with a cloud provider, widening needs its consent at the CURRENT version first (no dialog without it)', async () => {
    for (const provider of ['claude', 'gemini', 'claude_cli', 'antigravity_cli'] as const) {
      const { f, h, confirmSetting } = setup({ provider });
      expect(await h['wa:setReadScope']({ scope: 'all_chats' }, CTX), provider).toEqual({
        ok: false,
        error: { code: 'CONSENT_REQUIRED' },
      });
      expect(confirmSetting).not.toHaveBeenCalled();
      expect(f.state.settings.whatsapp.readTools.scope).toBe('trigger_chat');
      expect(f.rec.audits).toEqual([
        { kind: 'ipc_rejected', ref: 'wa:setReadScope', detail: { reason: 'consent_required' }, now: NOW_0 },
      ]);
    }
    // an OLD cloud_claude acceptance (v1 text, no other-chat rows) is not enough
    const old = setup({ provider: 'claude' });
    old.f.state.consents.set('cloud_claude', 1);
    expect(await old.h['wa:setReadScope']({ scope: 'all_chats' }, CTX)).toEqual({
      ok: false,
      error: { code: 'CONSENT_REQUIRED' },
    });
    const current = setup({ provider: 'claude' });
    current.f.state.consents.set('cloud_claude', CONSENT_VERSIONS.cloud_claude);
    expect(await current.h['wa:setReadScope']({ scope: 'all_chats' }, CTX)).toEqual({
      ok: true,
      value: { scope: 'all_chats' },
    });
    expect(current.confirmSetting).toHaveBeenCalledWith(WIN, 'read_all_chats', 'Anthropic');
  });

  it('narrowing to trigger_chat needs no dialog and no consent; the same scope again is a silent no-op', async () => {
    const { f, h, confirmSetting } = setup({ provider: 'gemini' });
    f.state.settings.whatsapp.readTools.scope = 'all_chats';
    expect(await h['wa:setReadScope']({ scope: 'trigger_chat' }, CTX)).toEqual({
      ok: true,
      value: { scope: 'trigger_chat' },
    });
    expect(confirmSetting).not.toHaveBeenCalled();
    expect(f.rec.audits).toHaveLength(1);
    expect(await h['wa:setReadScope']({ scope: 'trigger_chat' }, CTX)).toEqual({
      ok: true,
      value: { scope: 'trigger_chat' },
    });
    expect(f.rec.audits).toHaveLength(1);
  });

  it('widening without the dialog collaborator fails closed (INTERNAL) and writes nothing', async () => {
    const { f, h } = setup({ wired: false });
    expect(await h['wa:setReadScope']({ scope: 'all_chats' }, CTX)).toEqual({ ok: false, error: { code: 'INTERNAL' } });
    expect(f.state.settings.whatsapp.readTools.scope).toBe('trigger_chat');
  });

  it('vendorOf names the vendor for every provider id', () => {
    expect(vendorOf('local')).toBeNull();
    expect(vendorOf('claude')).toBe('Anthropic');
    expect(vendorOf('claude_cli')).toBe('Anthropic');
    expect(vendorOf('gemini')).toBe('Google');
    expect(vendorOf('antigravity_cli')).toBe('Google');
  });
});

describe('settings:set [V2] checks', () => {
  it('voice.enabled=true needs the resolved voice tier AND voice-vad ready (VOICE_MODEL_MISSING otherwise)', async () => {
    const notReady: VoiceState[] = [
      { ...READY, resolvedTier: null },
      { ...READY, model: null },
      { ...READY, model: { ...READY.model!, status: 'downloading' } },
      { ...READY, vad: { status: 'none' } },
    ];
    for (const voice of notReady) {
      const { f, h } = setup({ voice });
      expect(await h['settings:set']({ voice: { enabled: true } }, CTX)).toEqual({
        ok: false,
        error: { code: 'VOICE_MODEL_MISSING' },
      });
      expect(f.state.settings.voice.enabled).toBe(false);
    }
    const ok = setup();
    const res = await ok.h['settings:set']({ voice: { enabled: true } }, CTX);
    expect(res.ok && res.value.voice.enabled).toBe(true);
    // unwired voice service: fail closed
    const unwired = setup({ wired: false });
    expect(await unwired.h['settings:set']({ voice: { enabled: true } }, CTX)).toEqual({
      ok: false,
      error: { code: 'VOICE_MODEL_MISSING' },
    });
  });

  it('turning voice OFF, or re-sending enabled while already on, needs no model check', async () => {
    const { f, h } = setup({ voice: { ...READY, vad: { status: 'none' } } });
    f.state.settings.voice.enabled = true;
    expect((await h['settings:set']({ voice: { enabled: true } }, CTX)).ok).toBe(true);
    const off = await h['settings:set']({ voice: { enabled: false } }, CTX);
    expect(off.ok && off.value.voice.enabled).toBe(false);
  });

  it('llm.cli.maxRunsPerHour is re-clamped to LIMITS.cliRunsPerHourMax; other cli members pass through', async () => {
    const { f, h } = setup();
    const patch = vi.spyOn(f.deps.settings, 'patch');
    await h['settings:set']({ llm: { cli: { maxRunsPerHour: 10, claudeModel: 'haiku' } } }, CTX);
    expect(patch).toHaveBeenLastCalledWith({ llm: { cli: { maxRunsPerHour: 10, claudeModel: 'haiku' } } });
    // a value above the ceiling (only reachable if the schema bound ever drifted) is clamped, not written as sent
    await h['settings:set']({ llm: { cli: { maxRunsPerHour: LIMITS.cliRunsPerHourMax + 40 } } } as never, CTX);
    expect(patch).toHaveBeenLastCalledWith({ llm: { cli: { maxRunsPerHour: LIMITS.cliRunsPerHourMax } } });
    expect(f.state.settings.llm.cli.maxRunsPerHour).toBe(LIMITS.cliRunsPerHourMax);
  });

  // ux-i18n-v2-5: readTools.enabled is a settings:set member, the scope is not. Re-enabling reading while the STORED scope is
  // all_chats must never bring all-chats reading back without wa:setReadScope's native confirmation (F11 / B17).
  it('re-enabling read tools over a stored all_chats scope narrows it to trigger_chat first (no silent re-widening)', async () => {
    const { f, h, confirmSetting } = setup({ provider: 'claude' });
    f.state.settings.whatsapp.readTools = { enabled: false, scope: 'all_chats', windowDays: 30 };
    // every write must already carry the narrowed scope: no moment where enabled=true meets all_chats
    const written: { enabled: boolean; scope: string }[] = [];
    const record = (s: { whatsapp: { readTools: { enabled: boolean; scope: string } } }) =>
      written.push({ enabled: s.whatsapp.readTools.enabled, scope: s.whatsapp.readTools.scope });
    const { patch, setInternal } = f.deps.settings;
    f.deps.settings.patch = (p) => {
      const out = patch(p);
      record(out);
      return out;
    };
    f.deps.settings.setInternal = (mut) => {
      const out = setInternal(mut);
      record(out);
      return out;
    };
    const res = await h['settings:set']({ whatsapp: { readTools: { enabled: true } } }, CTX);
    expect(res.ok && res.value.whatsapp.readTools).toEqual({ enabled: true, scope: 'trigger_chat', windowDays: 30 });
    expect(f.state.settings.whatsapp.readTools).toEqual({ enabled: true, scope: 'trigger_chat', windowDays: 30 });
    expect(written).toEqual([
      { enabled: false, scope: 'trigger_chat' },
      { enabled: true, scope: 'trigger_chat' },
    ]);
    expect(confirmSetting).not.toHaveBeenCalled();
    expect(f.rec.audits).toEqual([
      {
        kind: 'settings_changed',
        ref: null,
        detail: { key: 'whatsapp.readTools.scope', value: 'trigger_chat' },
        now: NOW_0,
      },
      { kind: 'settings_changed', ref: null, detail: { groups: 'whatsapp' }, now: NOW_0 },
    ]);
  });

  it('the guard is narrow: an already-enabled all_chats, a trigger_chat scope, or turning Off keep the stored scope', async () => {
    // already on with a confirmed all_chats: re-sending enabled=true (or another readTools member) changes no scope
    const on = setup();
    on.f.state.settings.whatsapp.readTools = { enabled: true, scope: 'all_chats', windowDays: 30 };
    const r1 = await on.h['settings:set']({ whatsapp: { readTools: { enabled: true, windowDays: 7 } } }, CTX);
    expect(r1.ok && r1.value.whatsapp.readTools).toEqual({ enabled: true, scope: 'all_chats', windowDays: 7 });
    expect(on.f.rec.audits).toEqual([
      { kind: 'settings_changed', ref: null, detail: { groups: 'whatsapp' }, now: NOW_0 },
    ]);
    // off with trigger_chat: enabling is plain
    const plain = setup();
    plain.f.state.settings.whatsapp.readTools = { enabled: false, scope: 'trigger_chat', windowDays: 30 };
    const r2 = await plain.h['settings:set']({ whatsapp: { readTools: { enabled: true } } }, CTX);
    expect(r2.ok && r2.value.whatsapp.readTools.scope).toBe('trigger_chat');
    expect(plain.f.rec.audits).toHaveLength(1);
    // off with all_chats and a patch that does not enable: the scope stays (nothing reads while Off)
    const off = setup();
    off.f.state.settings.whatsapp.readTools = { enabled: false, scope: 'all_chats', windowDays: 30 };
    const r3 = await off.h['settings:set']({ whatsapp: { readTools: { windowDays: 10 } } }, CTX);
    expect(r3.ok && r3.value.whatsapp.readTools).toEqual({ enabled: false, scope: 'all_chats', windowDays: 10 });
    const r4 = await off.h['settings:set']({ whatsapp: { readTools: { enabled: false } } }, CTX);
    expect(r4.ok && r4.value.whatsapp.readTools.scope).toBe('all_chats');
  });

  it('a guarded re-enable that is refused writes nothing - not even the narrowing', async () => {
    // refused by an earlier check (voice models not ready)
    const early = setup({ voice: { ...READY, vad: { status: 'none' } } });
    early.f.state.settings.whatsapp.readTools = { enabled: false, scope: 'all_chats', windowDays: 30 };
    expect(
      await early.h['settings:set']({ voice: { enabled: true }, whatsapp: { readTools: { enabled: true } } }, CTX),
    ).toEqual({ ok: false, error: { code: 'VOICE_MODEL_MISSING' } });
    expect(early.f.state.settings.whatsapp.readTools).toEqual({ enabled: false, scope: 'all_chats', windowDays: 30 });
    // refused by the merged-object check (only reachable past register.ts's strict parse if the schema bound drifted)
    const merged = setup();
    merged.f.state.settings.whatsapp.readTools = { enabled: false, scope: 'all_chats', windowDays: 30 };
    expect(
      await merged.h['settings:set']({ whatsapp: { readTools: { enabled: true, windowDays: 0 } } } as never, CTX),
    ).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(merged.f.state.settings.whatsapp.readTools).toEqual({ enabled: false, scope: 'all_chats', windowDays: 30 });
    expect(merged.f.rec.audits).toEqual([]);
  });

  it('images and readTools toggles are accepted; the audit names the groups, never a value', async () => {
    const { f, h } = setup();
    const res = await h['settings:set']({ images: { cloud: false }, whatsapp: { readTools: { windowDays: 14 } } }, CTX);
    expect(res.ok && res.value.images.cloud).toBe(false);
    expect(res.ok && res.value.whatsapp.readTools).toEqual({ enabled: true, scope: 'trigger_chat', windowDays: 14 });
    expect(f.rec.audits).toEqual([
      { kind: 'settings_changed', ref: null, detail: { groups: 'images,whatsapp' }, now: NOW_0 },
    ]);
  });
});
