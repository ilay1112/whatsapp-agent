// src/main/exec/autoPolicy.ts   ADD (v2-build-plan section 3 seam; B7-B11, I10) - owner V2-W1-04-exec-auto. Safety-critical (T2 13).
// The automatic-mode policy lifecycle: enable ONLY through the main-owned native dialog after every precondition (C2 8 order), shadow
// (trial) first unless "Turn on now" was chosen in that same dialog (F34), end of the trial by a focused click with >= 3 decisions,
// pause / resume / disable, expiry with a reminder, and the unattended pause. Never imports agent/**, llm/** (exec boundary); the dialog
// arrives as the AutoDialog seam, the clock / randomness as S-CLOCK / S-RAND. Nothing here ever switches a policy ON by itself.
import { AutoScopeSchema } from '../../shared/schemas';
import { LIMITS } from '../../shared/types';
import type {
  AutoDisabledReason,
  AutoPausedReason,
  AutoPolicyRecord,
  AutoState,
  CalendarAccessRole,
  EpochMs,
  Result,
} from '../../shared/types';
import type { ErrorCode } from '../../shared/errors';
import type { IpcReq } from '../../shared/ipc';
import type { Repos } from '../db/index';
import type { Clock, RandomSource } from '../deps';
import type { AutoDialog } from '../app/autoDialog';

export interface AutoPolicyService {
  getState(): AutoState;
  /** auto:requestEnable after the IPC gates (focus, focus-steal guard): preconditions in C2 8 order, rate bucket auto_dialog 3/h, then the
   *  native dialog (response === 1 && checkboxChecked), insert the policy row (shadow if trial else on), audit, auto:changed. */
  requestEnable(req: IpcReq<'auto:requestEnable'>, win: unknown): Promise<Result<AutoState>>;
  /** auto:endShadow - needs shadowTally.decisions >= LIMITS.autoMinShadowDecisions. */
  endShadow(): Result<AutoState>;
  pause(reason: AutoPausedReason): Result<AutoState>;
  /** auto:resume - re-checks the enable preconditions except the dialog (a snapshot change needs a fresh requestEnable). */
  resume(win: unknown): Promise<Result<AutoState>>;
  disable(reason: AutoDisabledReason): Result<AutoState>;
  /** expiry, unattended (LIMITS.autoUnattendedMs), expiry reminders - called by the composition root's timer. */
  tick(now: EpochMs): void;
}
export interface AutoPolicyServiceDeps {
  repos: Repos;
  clock: Clock;
  random: RandomSource;
  dialog: AutoDialog;
  rate: {
    record(bucket: 'auto_dialog', key: string, now: EpochMs): void;
    countSince(bucket: 'auto_dialog', key: string, since: EpochMs): number;
  };
  calendarRoles: () => Readonly<Record<string, CalendarAccessRole>>;
  updateSurfaceAvailable: () => boolean;
  snapshotSha: () => string;
  audit: (
    kind: import('../../shared/types').AuditKind,
    ref: string | null,
    detail: Record<string, string | number | boolean | null>,
  ) => void;
  notify: (state: AutoState) => void;
  // ---- [V2-W1-04 additions] OPTIONAL so the frozen seam stays assignable; every default fails CLOSED ----
  /** Google Calendar connected (health). Absent => false: enable / resume are refused with CAL_UNAVAILABLE. */
  calendarConnected?: () => boolean;
  /** The target calendar's display name for the dialog message (external text; the dialog isolates + truncates it). Absent => ''. */
  calendarName?: () => string;
  /** app / Electron versions recorded in confirm_json. */
  versions?: () => { app: string; electron: string };
  /** Epoch of the last window focus (unattended pause after LIMITS.autoUnattendedMs). Absent => the policy's enable time. */
  lastFocusAt?: () => EpochMs | null;
  /** App-initiated pause (never a user click) and the 3-days-before expiry reminder: the composition root shows the toasts. */
  onAppPause?: (reason: AutoPausedReason) => void;
  onExpiring?: () => void;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function err<T>(code: ErrorCode): Result<T> {
  return { ok: false, error: { code } };
}

/** RFC 4122 v4 uuid from S-RAND bytes (auto_policies.id). */
function uuidV4(bytes: Uint8Array): string {
  const b = Array.from(bytes.slice(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = b.map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** YYYY-MM-DD of an epoch in a zone (the dialog's "Ends on {{date}}." - numbers only, no locale text). */
function isoDateIn(ms: EpochMs, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(ms);
    return parts;
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export function createAutoPolicyService(deps: AutoPolicyServiceDeps): AutoPolicyService {
  const { repos } = deps;
  const calendarConnected = deps.calendarConnected ?? ((): boolean => false);
  const remindedExpiry = new Set<string>();

  const settings = (): ReturnType<Repos['settings']['get']> => repos.settings.get();
  const roleOfTarget = (): CalendarAccessRole =>
    deps.calendarRoles()[settings().calendar.targetCalendarId] ?? 'unknown';
  const providerAllowsAuto = (): boolean => settings().llm.provider !== 'antigravity_cli';

  const getState = (): AutoState => {
    const now = deps.clock.now();
    const live = repos.autoPolicies.live();
    const shown = live ?? repos.autoPolicies.newest();
    const s = settings();
    return {
      policy:
        shown === null
          ? null
          : {
              id: shown.id,
              state: shown.state,
              enabledAt: shown.enabledAt,
              expiresAt: shown.expiresAt,
              shadowUntil: shown.shadowUntil,
              pausedReason: shown.pausedReason,
              scope: shown.scope,
            },
      preconditions: {
        calendarConnected: calendarConnected(),
        calendarOwned: roleOfTarget() === 'owner',
        approvedCreates: repos.actions.countUserApprovedCreates(),
        approvedCreatesNeeded: LIMITS.autoTrackRecordCreates,
        providerAllowsAuto: s.llm.provider !== 'antigravity_cli',
        updatesAvailable: deps.updateSurfaceAvailable(),
      },
      shadowTally: live === null ? null : repos.autoDecisions.shadowTally(live.id),
      usedToday: {
        writes: repos.rate.countSince('auto_global', 'global', (now - DAY_MS) as EpochMs),
        limit: (live ?? shown)?.scope.globalPerDay ?? 0,
      },
      undoableCount: repos.autoWrites
        .since((now - LIMITS.autoStripDays * DAY_MS) as EpochMs)
        .filter((w) => w.undoState === 'available' && w.undoUntil > now && w.revisionId !== null).length,
    };
  };

  const changed = (): AutoState => {
    const state = getState();
    deps.notify(state);
    return state;
  };

  /** The enable preconditions of C2 8, in order, minus the rate bucket and the dialog. `forResume` skips "no live policy". */
  const precondition = (forResume: boolean): ErrorCode | null => {
    if (!calendarConnected()) return 'CAL_UNAVAILABLE';
    if (!deps.updateSurfaceAvailable()) return 'CAL_UPDATE_UNAVAILABLE';
    if (roleOfTarget() !== 'owner') return 'AUTO_CALENDAR_NOT_OWNED';
    if (!forResume && repos.autoPolicies.live() !== null) return 'BAD_REQUEST';
    if (!providerAllowsAuto()) return 'BAD_REQUEST';
    if (repos.actions.countUserApprovedCreates() < LIMITS.autoTrackRecordCreates) return 'AUTO_NO_TRACK_RECORD';
    // snapshot_sha needs a known account (googleAccountEmailSha8 '' => the composition root answers a non-hash): not owned.
    if (!SHA256_HEX.test(deps.snapshotSha())) return 'AUTO_CALENDAR_NOT_OWNED';
    return null;
  };

  const pauseRow = (live: AutoPolicyRecord, reason: AutoPausedReason): void => {
    repos.autoPolicies.setState(live.id, { state: 'paused', reason });
    deps.audit('auto_policy_paused', live.id, { reason });
  };

  return {
    getState,

    async requestEnable(req, win) {
      const now = deps.clock.now();
      if (deps.rate.countSince('auto_dialog', 'global', (now - HOUR_MS) as EpochMs) >= LIMITS.autoDialogPerHour) {
        deps.audit('ipc_rejected', null, { channel: 'auto:requestEnable', reason: 'rate_limited' });
        return err('BAD_REQUEST');
      }
      deps.rate.record('auto_dialog', 'global', now);
      const refused = precondition(false);
      if (refused !== null) return err(refused);
      const scope = AutoScopeSchema.safeParse(req.scope);
      if (!scope.success) return err('BAD_REQUEST');
      const s = settings();
      const expiresAt = (now + scope.data.validityDays * DAY_MS) as EpochMs;
      const confirmed = await deps.dialog.confirmEnable(win, {
        calendarName: deps.calendarName?.() ?? '',
        trial: req.trial,
        validityDays: scope.data.validityDays,
        endsOn: isoDateIn(expiresAt, s.general.timeZone),
        scope: scope.data, // [auto-mode-7] the dialog shows exactly what becomes the grant
      });
      if (!confirmed) {
        deps.audit('ipc_rejected', null, { channel: 'auto:requestEnable', reason: 'not_confirmed' });
        return err('AUTO_NOT_CONFIRMED');
      }
      // The world may have moved while the dialog was open: every precondition again (fail closed), never a second dialog.
      const after = precondition(false);
      if (after !== null) return err(after);
      const at = deps.clock.now();
      const versions = deps.versions?.() ?? { app: '0.0.0', electron: '0' };
      const row = repos.autoPolicies.insert({
        id: uuidV4(deps.random.bytes(16)),
        state: req.trial ? 'shadow' : 'on',
        enabledAt: at,
        expiresAt: (at + scope.data.validityDays * DAY_MS) as EpochMs,
        shadowUntil: (req.trial ? at + LIMITS.autoShadowMs : at) as EpochMs,
        confirmedBy: 'native_dialog',
        confirm: {
          dialogResponse: 1,
          checkboxChecked: true,
          windowFocused: true,
          trial: req.trial,
          appVersion: versions.app.slice(0, 32),
          electronVersion: versions.electron.slice(0, 32),
          approvedCreates: repos.actions.countUserApprovedCreates(),
        },
        scope: scope.data,
        snapshotSha: deps.snapshotSha(),
      });
      deps.audit('auto_policy_enabled', row.id, { trial: req.trial, validityDays: scope.data.validityDays });
      return { ok: true, value: changed() };
    },

    endShadow() {
      const live = repos.autoPolicies.live();
      if (live === null || live.state !== 'shadow') return err('BAD_REQUEST');
      if (repos.autoDecisions.shadowTally(live.id).decisions < LIMITS.autoMinShadowDecisions) return err('BAD_REQUEST');
      if (deps.snapshotSha() !== live.snapshotSha || !deps.updateSurfaceAvailable()) return err('BAD_REQUEST');
      repos.autoPolicies.setState(live.id, { state: 'on' });
      deps.audit('auto_policy_shadow_ended', live.id, {});
      return { ok: true, value: changed() };
    },

    pause(reason) {
      const live = repos.autoPolicies.live();
      if (live === null) return err('BAD_REQUEST');
      if (live.state === 'paused') return { ok: true, value: getState() };
      pauseRow(live, reason);
      const state = changed();
      if (reason !== 'user') deps.onAppPause?.(reason);
      return { ok: true, value: state };
    },

    async resume(_win) {
      const live = repos.autoPolicies.live();
      if (live === null || live.state !== 'paused') return err('BAD_REQUEST');
      const now = deps.clock.now();
      if (live.expiresAt <= now) {
        repos.autoPolicies.setState(live.id, { state: 'expired' });
        deps.audit('auto_policy_expired', live.id, {});
        changed();
        return err('BAD_REQUEST');
      }
      const refused = precondition(true);
      if (refused !== null) return err(refused);
      // A snapshot change (calendar, account, provider, app version) needs a fresh requestEnable with its dialog.
      if (deps.snapshotSha() !== live.snapshotSha) return err('BAD_REQUEST');
      // [v2-closeout auto-mode-8] Resume returns to the state the user last CONFIRMED: a paused trial resumes as `shadow` (whatever its
      // tally - "Turn on for real" stays its own explicit click, auto:endShadow), an `on` policy resumes as `on`. The repo moves the
      // row to its recorded paused_from and the v5 trigger refuses paused(trial) -> on, so no code path can promote it silently.
      const resumed = repos.autoPolicies.setState(live.id, { state: 'resume' });
      deps.audit('auto_policy_resumed', live.id, { to: resumed.state });
      return { ok: true, value: changed() };
    },

    disable(reason) {
      const live = repos.autoPolicies.live();
      if (live === null) return { ok: true, value: getState() }; // nothing live: the fail-safe direction is already true
      repos.autoPolicies.setState(live.id, { state: 'disabled', reason, at: deps.clock.now() });
      deps.audit('auto_policy_disabled', live.id, { reason });
      return { ok: true, value: changed() };
    },

    tick(now) {
      const live = repos.autoPolicies.live();
      if (live === null) return;
      if (live.expiresAt <= now) {
        repos.autoPolicies.setState(live.id, { state: 'expired' });
        deps.audit('auto_policy_expired', live.id, {});
        changed();
        return;
      }
      if (live.expiresAt - now <= LIMITS.autoExpiryReminderMs && !remindedExpiry.has(live.id)) {
        remindedExpiry.add(live.id);
        deps.onExpiring?.();
      }
      if (live.state === 'paused') return;
      const lastFocus = Math.max(deps.lastFocusAt?.() ?? live.enabledAt, live.enabledAt);
      let reason: AutoPausedReason | null = null;
      if (now - lastFocus >= LIMITS.autoUnattendedMs) reason = 'unattended';
      else if (deps.calendarConnected !== undefined && !deps.calendarConnected()) reason = 'calendar_disconnected';
      if (reason === null) return;
      pauseRow(live, reason);
      changed();
      deps.onAppPause?.(reason);
    },
  };
}
