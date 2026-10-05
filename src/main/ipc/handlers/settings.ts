// src/main/ipc/handlers/settings.ts - handlers for the channels below (build-plan section 3; owner W1-13; v2 V2-W1-10-main-platform).
// Bodies return Result<T>, never throw.
import type { IpcHandlers, IpcReq } from '../../../shared/ipc';
import { applySettingsPatch } from '../../../shared/settings';
import { CONSENT_KIND_FOR, LIMITS, type ProviderId } from '../../../shared/types';
import { fail, ok, type HandlerDeps, type SettingsHandlersV2 } from '../register';

export type SettingsChannels = 'settings:get' | 'settings:set' | 'wa:setReadScope'; // [V2] + wa:setReadScope (F11)

/** Always accepted without a round trip to Google: the user's own default calendar. */
export const DEFAULT_CALENDAR_ID = 'primary';

/** Every calendar id the patch would write, minus the always-allowed default. */
export function calendarIdsIn(patch: IpcReq<'settings:set'>): string[] {
  const ids = new Set<string>();
  if (patch.calendar?.targetCalendarId !== undefined) ids.add(patch.calendar.targetCalendarId);
  for (const id of patch.calendar?.conflictCalendarIds ?? []) ids.add(id);
  ids.delete(DEFAULT_CALENDAR_ID);
  return [...ids];
}

/** [V2] The vendor the native "read all chats" confirmation names (app text; null = the AI on this computer). */
export function vendorOf(provider: ProviderId): string | null {
  switch (provider) {
    case 'claude':
    case 'claude_cli':
      return 'Anthropic';
    case 'gemini':
    case 'antigravity_cli':
      return 'Google';
    default:
      return null;
  }
}

export function createSettingsHandlers(
  deps: HandlerDeps,
  v2?: SettingsHandlersV2,
): Pick<IpcHandlers, SettingsChannels> {
  /** [V2] C2 4: voice.enabled=true needs the resolved voice tier AND voice-vad `ready`; without the voice service: fail closed. */
  const voiceModelsReady = (): boolean => {
    if (v2 === undefined) return false;
    const state = v2.voice.state();
    return state.resolvedTier !== null && state.model?.status === 'ready' && state.vad.status === 'ready';
  };

  return {
    'settings:get': () => ok(deps.settings.get()),

    /**
     * [V2] F11 / B17: the ONLY writer of whatsapp.readTools.scope (settings:set has no such key). Focus-gated in both directions by
     * register.ts. Narrowing to 'trigger_chat' is one click; widening to 'all_chats' needs (1) the active cloud provider's consent at
     * its current version (the v2 text names rows from other chats) and (2) the main-owned native confirmation. A cancelled
     * confirmation leaves the scope unchanged and is not an error.
     */
    'wa:setReadScope': async (req) => {
      const current = deps.settings.get();
      const from = current.whatsapp.readTools.scope;
      if (req.scope === from) return ok({ scope: from });

      if (req.scope === 'all_chats') {
        const provider = current.llm.provider;
        if (provider !== 'local' && !deps.repos.consents.isCurrent(CONSENT_KIND_FOR[provider])) {
          deps.audit('ipc_rejected', 'wa:setReadScope', { reason: 'consent_required' }, deps.clock.now());
          return fail('CONSENT_REQUIRED');
        }
        if (v2 === undefined) {
          deps.log.error('ipc_v2_unwired', { channel: 'wa:setReadScope' });
          return fail('INTERNAL');
        }
        const confirmed = await v2.autoDialog.confirmSetting(v2.dialogParent(), 'read_all_chats', vendorOf(provider));
        if (!confirmed) return ok({ scope: from });
      }

      const next = deps.settings.setInternal((s) => {
        s.whatsapp.readTools.scope = req.scope;
      });
      deps.audit(
        'settings_changed',
        null,
        { key: 'whatsapp.readTools.scope', value: next.whatsapp.readTools.scope },
        deps.clock.now(),
      );
      return ok({ scope: next.whatsapp.readTools.scope });
    },

    /**
     * `SettingsPatchSchema` is the whole allow-list: `llm.provider` (llm:setProvider), `agent.paused` (agent:setPaused),
     * `llm.local.forceCpu` and `[R2]` `general.timeZone` (main only), and [V2] `llm.cli.claudeExePath` (cli:pickExe),
     * `llm.cli.allowOverage` (cli:setOverage), `whatsapp.readTools.scope` (wa:setReadScope) and any `auto` key (auto:*) are not
     * members, so a strict parse in register.ts has already rejected them with BAD_REQUEST + audit ipc_rejected. What is left
     * here: a calendar id must be one Google actually listed for this account; [V2] voice.enabled=true needs the voice models
     * ready (VOICE_MODEL_MISSING); llm.cli.maxRunsPerHour is re-clamped to LIMITS.cliRunsPerHourMax. The language / tray /
     * autostart side effects run through SettingsBus.onChange, which compose.ts subscribes - the handler owns no side effect.
     */
    'settings:set': async (req) => {
      const ids = calendarIdsIn(req);
      if (ids.length > 0) {
        const listed = await deps.googleAuth.listCalendars();
        if (!listed.ok) return fail('CAL_RECONNECT');
        const known = new Set(listed.value.map((c) => c.id));
        if (ids.some((id) => !known.has(id))) return fail('BAD_REQUEST');
      }

      if (req.voice?.enabled === true && !deps.settings.get().voice.enabled && !voiceModelsReady()) {
        return fail('VOICE_MODEL_MISSING');
      }

      let patch = req;
      if (req.llm?.cli?.maxRunsPerHour !== undefined) {
        const clamped = Math.min(req.llm.cli.maxRunsPerHour, LIMITS.cliRunsPerHourMax);
        patch = { ...req, llm: { ...req.llm, cli: { ...req.llm.cli, maxRunsPerHour: clamped } } };
      }

      // ux-i18n-v2-5: the scope is not a settings:set member, but readTools.enabled is. Turning reading back ON while the
      // STORED scope is all_chats would re-widen to every chat without wa:setReadScope's consent check and native
      // confirmation (F11 / B17). Narrow the scope to trigger_chat (the safe, one-click direction) BEFORE enabling, so no
      // write ever pairs enabled=true with an unconfirmed all_chats; widening again goes through wa:setReadScope.
      const current = deps.settings.get();
      const stored = current.whatsapp.readTools;
      if (req.whatsapp?.readTools?.enabled === true && !stored.enabled && stored.scope === 'all_chats') {
        const narrowedView = {
          ...current,
          whatsapp: { ...current.whatsapp, readTools: { ...stored, scope: 'trigger_chat' as const } },
        };
        try {
          applySettingsPatch(narrowedView, patch); // a patch the merged check rejects must write nothing, narrowing included
        } catch {
          return fail('BAD_REQUEST');
        }
        const narrowed = deps.settings.setInternal((s) => {
          s.whatsapp.readTools.scope = 'trigger_chat';
        });
        deps.audit(
          'settings_changed',
          null,
          { key: 'whatsapp.readTools.scope', value: narrowed.whatsapp.readTools.scope },
          deps.clock.now(),
        );
      }

      let next;
      try {
        next = deps.settings.patch(patch);
      } catch {
        // applySettingsPatch re-validates the MERGED object; a patch that is individually valid can still be rejected there.
        return fail('BAD_REQUEST');
      }
      deps.audit('settings_changed', null, { groups: Object.keys(req).sort().join(',') }, deps.clock.now());
      return ok(next);
    },
  };
}
