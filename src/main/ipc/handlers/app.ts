// src/main/ipc/handlers/app.ts - handlers for the channels below (build-plan section 3; owner W1-13; v2 V2-W1-10-main-platform).
// Bodies return Result<T>, never throw. [V2] external:open serves the five new EXTERNAL_TARGETS from resources/links.json like the
// v1 ones (hard-coded https table only); consent:* covers the two new kinds and the bumped versions with the unchanged exact-version rule.
import { dirFor, resolveLanguage } from '../../../shared/i18n/languages';
import { ANTIGRAVITY_TERMS_READ_ON, CONSENT_VERSIONS, LIMITS } from '../../../shared/types';
import type { Bootstrap, ConsentKind, ConsentState, EpochMs, ItemId, Result } from '../../../shared/types';
import type { ExternalTarget, IpcHandlers } from '../../../shared/ipc';
import { fail, ok, type HandlerDeps } from '../register';

export type AppChannels =
  | 'app:getBootstrap'
  | 'app:ackTrayHint'
  | 'health:get'
  | 'agent:setPaused'
  | 'clipboard:writeText'
  | 'external:open'
  | 'onboarding:getState'
  | 'onboarding:setStep'
  | 'consent:get'
  | 'consent:accept';

/** meta key value written by app:ackTrayHint; anything else counts as "not seen". */
export const TRAY_HINT_SEEN = '1';
/** [R2] The ONLY calendar URL the app ever opens. Built in main from items.event_start_ts - never the MCP-supplied htmlLink. */
export const CALENDAR_DAY_URL_PREFIX = 'https://calendar.google.com/calendar/r/day';

/**
 * [R2] `external:open {itemId, target:'calendarEvent'}` builds this from `items.event_start_ts` in the app time zone.
 * 'en-CA' because its numeric parts are already YYYY / MM / DD; only the three digit groups are interpolated, so no
 * attacker-influenced text can reach the URL. Returns null when the zone is unusable or the parts are not digits.
 */
export function calendarDayUrl(startTs: EpochMs, timeZone: string): string | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(startTs));
  } catch {
    return null;
  }
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(day)) return null;
  return `${CALENDAR_DAY_URL_PREFIX}/${year}/${month}/${day}`;
}

export function createAppHandlers(deps: HandlerDeps): Pick<IpcHandlers, AppChannels> {
  const consentState = (kind: ConsentKind): ConsentState => {
    const latest = deps.repos.consents.latest(kind);
    return {
      kind,
      currentVersion: CONSENT_VERSIONS[kind],
      acceptedVersion: latest?.version ?? null,
      acceptedAt: latest?.acceptedAt ?? null,
    };
  };

  /** Resolves the enum target through resources/links.json; a missing or non-https entry opens nothing. */
  const linkFor = (target: ExternalTarget): string | null => {
    const url = deps.links[target];
    return typeof url === 'string' && url.startsWith('https://') ? url : null;
  };

  const openCalendarDay = async (itemId: ItemId): Promise<Result<null>> => {
    const item = deps.repos.items.byId(itemId);
    if (item === null || item.eventStartTs === null) return fail('NOT_FOUND');
    const url = calendarDayUrl(item.eventStartTs, deps.settings.get().general.timeZone);
    if (url === null) return fail('INTERNAL');
    await deps.electron.openExternal(url);
    return ok(null);
  };

  return {
    'app:getBootstrap': () => {
      const settings = deps.settings.get();
      const lang = resolveLanguage(settings.general.language, deps.electron.preferredLanguages());
      const bootstrap: Bootstrap = {
        lang,
        dir: dirFor(lang),
        onboardingStep: deps.onboarding.getState().step,
        health: deps.healthHub.get(),
        settingsPublic: settings,
        version: deps.version,
        trayHintSeen: deps.repos.meta.get('tray_hint_seen') === TRAY_HINT_SEEN,
      };
      return ok(bootstrap);
    },

    'app:ackTrayHint': () => {
      deps.repos.meta.set('tray_hint_seen', TRAY_HINT_SEEN);
      return ok(null);
    },

    'health:get': () => ok(deps.healthHub.get()),

    'agent:setPaused': (req) => {
      deps.settings.setInternal((s) => {
        s.agent.paused = req.paused;
      });
      deps.queue.setPaused(req.paused);
      deps.healthHub.setPaused(req.paused);
      return ok(deps.healthHub.get());
    },

    // The schema already caps at LIMITS.clipboardChars; the slice is the second lock (a future schema edit cannot widen this).
    'clipboard:writeText': (req) => {
      deps.electron.clipboardWrite(req.text.slice(0, LIMITS.clipboardChars));
      return ok(null);
    },

    'external:open': async (req) => {
      if ('itemId' in req) return openCalendarDay(req.itemId);
      const url = linkFor(req.target);
      if (url === null) return fail('NOT_FOUND');
      await deps.electron.openExternal(url);
      return ok(null);
    },

    'onboarding:getState': () => ok(deps.onboarding.getState()),
    'onboarding:setStep': (req) => ok(deps.onboarding.setStep(req.step)),

    'consent:get': (req) => ok(consentState(req.kind)),

    // [R2] Exactly the current version, so a renderer cannot pre-accept a future (unread) consent text.
    'consent:accept': (req) => {
      const current = CONSENT_VERSIONS[req.kind];
      const now = deps.clock.now();
      if (req.version !== current) {
        deps.audit('ipc_rejected', 'consent:accept', { kind: req.kind, sent: req.version, current }, now);
        deps.log.warn('consent_version_mismatch', { kind: req.kind, sent: req.version, current });
        return fail('BAD_REQUEST', { kind: req.kind, version: current });
      }
      // [V2] B14: the Antigravity consent text quotes Terms read on a fixed date; that date is stored in the consent record.
      if (req.kind === 'cloud_antigravity_cli')
        deps.repos.consents.accept(req.kind, current, now, ANTIGRAVITY_TERMS_READ_ON);
      else deps.repos.consents.accept(req.kind, current, now);
      deps.audit('consent', req.kind, { version: current }, now);
      return ok(consentState(req.kind));
    },
  };
}
