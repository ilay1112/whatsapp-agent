// src/main/ipc/handlers/settings.ts - handlers for the channels below (build-plan section 3; owner W1-13). Bodies return Result<T>, never throw.
import type { IpcHandlers, IpcReq } from '../../../shared/ipc';
import { fail, ok, type HandlerDeps } from '../register';

export type SettingsChannels = 'settings:get' | 'settings:set';

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

export function createSettingsHandlers(deps: HandlerDeps): Pick<IpcHandlers, SettingsChannels> {
  return {
    'settings:get': () => ok(deps.settings.get()),

    /**
     * `SettingsPatchSchema` is the whole allow-list: `llm.provider` (llm:setProvider), `agent.paused` (agent:setPaused),
     * `llm.local.forceCpu` and `[R2]` `general.timeZone` (main only) are not members, so a strict parse in register.ts has
     * already rejected them. What is left to check here is the one field whose value set lives outside the schema: a
     * calendar id must be one Google actually listed for this account, or the write would point the executor at a
     * calendar the user never chose. The language / tray / autostart side effects run through SettingsBus.onChange,
     * which compose.ts subscribes - the handler itself owns no side effect.
     */
    'settings:set': async (req) => {
      const ids = calendarIdsIn(req);
      if (ids.length > 0) {
        const listed = await deps.googleAuth.listCalendars();
        if (!listed.ok) return fail('CAL_RECONNECT');
        const known = new Set(listed.value.map((c) => c.id));
        if (ids.some((id) => !known.has(id))) return fail('BAD_REQUEST');
      }

      let next;
      try {
        next = deps.settings.patch(req);
      } catch {
        // applySettingsPatch re-validates the MERGED object; a patch that is individually valid can still be rejected there.
        return fail('BAD_REQUEST');
      }
      deps.audit('settings_changed', null, { groups: Object.keys(req).sort().join(',') }, deps.clock.now());
      return ok(next);
    },
  };
}
