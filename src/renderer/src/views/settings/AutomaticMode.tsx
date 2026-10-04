// src/renderer/src/views/settings/AutomaticMode.tsx - Settings > Automatic mode (UX2 4.5; B7, B9, B14, I10; owner V2-W1-12).
//
// What this group may and may not do (structural, not a prompt):
//   - it NEVER turns automatic mode on through `settings:set` (there is no `auto` settings key, the patch schema refuses
//     one). The ONLY way on is `auto:requestEnable {scope, trial}` from the two enable buttons' click handlers, and the
//     decision itself is made in MAIN's native Windows dialog (checkbox + button). While it is up the page only says
//     "Waiting for your answer in the Windows dialog...";
//   - neither enable button is accent (nothing is approved by them); both, "Turn on for real", "Resume" and "Renew" are
//     behind the 500 ms focus-steal guard and ignore a double click's second activation (UX2 11.5, 15.1);
//   - Pause and Stop are one click, no dialog, no guard (the fail-safe direction, I10);
//   - scope controls are editable only while no policy is live; while live they are read-only (UX2 C6: no scope IPC);
//   - preconditions come from `AutoState.preconditions` and replace the enable buttons with one sentence each.
import { useEffect, useState, type MouseEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { LIMITS, type AutoState } from '@shared/types';
import { DEFAULT_AUTO_SCOPE, type AutoScope } from '@shared/schemas';
import type { ErrorCode } from '@shared/errors';
import { formatDate, formatResetTime } from '@shared/i18n/format';
import { AUTO_HAPPENS_KEYS, AUTO_NEVER_KEYS } from '@shared/i18n/autoCopy';
import { api } from '../../api';
import { useAutoStore } from '../../store/auto';
import { isActivationBlocked } from '../../store/health';
import { calendarNameOf, useSettingsStore } from '../../store/settings';
import { Toggle, uiLang } from './parts';

export interface AutomaticModeProps {
  state: AutoState;
  /** [V2-W1-12] "See automatic activity" (UX2 4.6). Optional so the Wave-0 prop shape keeps compiling. */
  onOpenActivity?(): void;
}

const MS_DAY = 86_400_000;
/** Renew is offered in the last 7 days of an `on` policy (UX2 4.5). */
const RENEW_WINDOW_DAYS = 7;

export type AutoPrecondition = 'connect' | 'updates' | 'notOwned' | 'trackRecord' | 'rate';

/** The first unmet enable precondition, in the UX2 4.5 priority order (null = the enable buttons are shown). */
export function firstPrecondition(state: AutoState, rateLimited: boolean): AutoPrecondition | null {
  const p = state.preconditions;
  if (!p.calendarConnected) return 'connect';
  if (!p.updatesAvailable) return 'updates';
  if (!p.calendarOwned) return 'notOwned';
  if (p.approvedCreates < p.approvedCreatesNeeded) return 'trackRecord';
  if (rateLimited) return 'rate';
  return null;
}

/** Live = the policy still decides (shadow | on | paused); scope is read-only then. */
export function isLive(state: AutoState): boolean {
  const s = state.policy?.state;
  return s === 'shadow' || s === 'on' || s === 'paused';
}

/** Whole days left (ceil), never negative. */
export function daysLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / MS_DAY));
}

/** Ignore a double click's second activation and anything inside the focus-steal window (UX2 11.5). */
function guarded(e: MouseEvent): boolean {
  return e.detail > 1 || isActivationBlocked();
}

export function AutomaticMode({ state, onOpenActivity }: AutomaticModeProps) {
  const { t, i18n } = useTranslation();
  const lang = uiLang(i18n.language);
  const settings = useSettingsStore((s) => s.settings);
  const calendars = useSettingsStore((s) => s.calendars);
  const [draft, setDraft] = useState<AutoScope>(DEFAULT_AUTO_SCOPE);
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const [rateLimited, setRateLimited] = useState(false);
  // ux-i18n-v2-2: main answers BAD_REQUEST for several refusals (C2 8: the 3/h bucket, a provider that cannot run
  // automatic mode, a changed snapshot on Resume / "Turn on for real", an expired policy, a trial with < 3 decisions).
  // The refusal is remembered WITH the policy state it was given for, so it disappears once the state moves on.
  const [refused, setRefused] = useState<{ reason: 'provider' | 'restart'; forState: string } | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    void useSettingsStore.getState().loadCalendars();
  }, []);

  const timeZone = settings?.general.timeZone ?? 'Asia/Jerusalem';
  const calendar = calendarNameOf(
    settings?.calendar.targetCalendarId ?? 'primary',
    calendars,
    t('auto.calendarFallback'),
  );
  const policy = state.policy;
  const live = isLive(state);
  const scope: AutoScope = live && policy ? policy.scope : draft;
  const stateKey = policy?.state ?? 'none';
  const precondition = firstPrecondition(state, rateLimited);
  const tally = state.shadowTally;
  const shadowReady = (tally?.decisions ?? 0) >= LIMITS.autoMinShadowDecisions;

  /** Every state-changing answer is the new AutoState: the store (and so the strip, the tray line) follows at once. */
  const apply = (r: Awaited<ReturnType<typeof api.getAutoState>>): void => {
    if (r.ok) {
      useAutoStore.getState().setState(r.value);
      setError(null);
      setRefused(null);
    } else {
      setError(r.error.code);
    }
  };

  const enable = async (e: MouseEvent, trial: boolean) => {
    if (guarded(e) || waiting) return;
    setError(null);
    setRefused(null);
    setWaiting(true);
    const r = await api.requestAutoEnable({ scope, trial });
    setWaiting(false);
    if (!r.ok && r.error.code === 'BAD_REQUEST') {
      // The enable buttons stay clickable with a provider that cannot run automatic mode (UX2 4.5) and main refuses it
      // with BAD_REQUEST: that is NOT the rate limit. With the provider allowed (and no live policy - the buttons are
      // not shown then) the remaining BAD_REQUEST is the 3/h dialog bucket. Either way the state is re-read from main.
      if (!state.preconditions.providerAllowsAuto) setRefused({ reason: 'provider', forState: stateKey });
      else setRateLimited(true);
      void useAutoStore.getState().hydrate();
      return;
    }
    apply(r);
  };

  /** `restartOnRefusal`: a BAD_REQUEST from Resume / "Turn on for real" means the policy cannot continue as it is. */
  const run = async (call: () => ReturnType<typeof api.getAutoState>, restartOnRefusal = false) => {
    setBusy(true);
    setRefused(null);
    const r = await call();
    setBusy(false);
    if (!r.ok && r.error.code === 'BAD_REQUEST') {
      // Never swallowed (ux-i18n-v2-2): said together with the action that works - Stop, then turn it on again. A
      // BAD_REQUEST from Pause only means the page was behind main; the re-read below corrects it.
      if (restartOnRefusal) setRefused({ reason: 'restart', forState: stateKey });
      setError(null);
      void useAutoStore.getState().hydrate();
      return;
    }
    apply(r);
  };

  // ---- the state card: one line + its actions -----------------------------------------------------------------------
  const stateLine = (() => {
    switch (policy?.state) {
      case 'expired':
        return (
          <Trans
            i18nKey="auto.state.expired"
            values={{ date: formatDate(policy.expiresAt, lang, timeZone) }}
            components={{ bdi: <bdi /> }}
          />
        );
      case 'shadow': {
        const time = formatResetTime(policy.shadowUntil, now, lang, timeZone);
        return shadowReady ? (
          <Trans
            i18nKey="auto.state.shadowReadyTotal"
            values={{ time, wouldAuto: tally?.wouldAuto ?? 0, same: tally?.approvedUnchanged ?? 0 }}
            components={{ bdi: <bdi /> }}
          />
        ) : (
          <Trans
            i18nKey="auto.state.shadowEarly"
            values={{ time, seen: tally?.decisions ?? 0 }}
            components={{ bdi: <bdi /> }}
          />
        );
      }
      case 'on':
        return t('auto.state.on', {
          used: state.usedToday.writes,
          limit: state.usedToday.limit,
          count: daysLeft(policy.expiresAt, now),
        });
      case 'paused':
        return t('auto.state.paused', { reason: t(`auto.pausedReason.${policy.pausedReason ?? 'user'}`) });
      default:
        return t('auto.state.off');
    }
  })();

  const stopButton = (
    <button
      type="button"
      className="btn btn-quiet"
      data-testid="auto-stop"
      disabled={busy}
      onClick={() => void run(() => api.disableAuto())}
    >
      {t('auto.stop')}
    </button>
  );

  const stateActions = (() => {
    switch (policy?.state) {
      case 'expired':
        return precondition === null ? (
          <button
            type="button"
            className="btn btn-outline"
            data-testid="auto-renew"
            disabled={waiting}
            onClick={(e) => void enable(e, false)}
          >
            {t('auto.renew')}
          </button>
        ) : null;
      case 'shadow':
        return (
          <>
            {shadowReady ? (
              <button
                type="button"
                className="btn btn-outline"
                data-testid="auto-end-shadow"
                disabled={busy}
                onClick={(e) => {
                  if (guarded(e)) return;
                  void run(() => api.endAutoShadow(), true);
                }}
              >
                {t('auto.endShadow')}
              </button>
            ) : null}
            {stopButton}
          </>
        );
      case 'on':
        return (
          <>
            <button
              type="button"
              className="btn btn-outline"
              data-testid="auto-pause"
              disabled={busy}
              onClick={() => void run(() => api.pauseAuto())}
            >
              {t('auto.pause')}
            </button>
            {stopButton}
          </>
        );
      case 'paused':
        return (
          <>
            <button
              type="button"
              className="btn btn-outline"
              data-testid="auto-resume"
              disabled={busy}
              onClick={(e) => {
                if (guarded(e)) return;
                void run(() => api.resumeAuto(), true);
              }}
            >
              {t('auto.resume')}
            </button>
            {stopButton}
          </>
        );
      default:
        return null;
    }
  })();

  // ---- scope controls ------------------------------------------------------------------------------------------------
  const setScope = (patch: Partial<AutoScope>) => setDraft((d) => ({ ...d, ...patch }));

  const preconditionLine = (() => {
    switch (precondition) {
      case 'connect':
        return t('auto.pre.connect');
      case 'updates':
        return t('errors.CAL_UPDATE_UNAVAILABLE.title');
      case 'notOwned':
        return <Trans i18nKey="auto.pre.notOwned" values={{ calendar }} components={{ bdi: <bdi /> }} />;
      case 'trackRecord':
        return t('auto.pre.trackRecord', { count: state.preconditions.approvedCreates });
      case 'rate':
        return t('auto.pre.rate');
      default:
        return null;
    }
  })();

  const expiringSoon = policy?.state === 'on' && daysLeft(policy.expiresAt, now) <= RENEW_WINDOW_DAYS;

  return (
    <section
      id="settings-group-auto"
      data-testid="settings-group-auto"
      aria-labelledby="settings-h-auto"
      className="flex flex-col gap-3 border-t border-line pt-4"
    >
      <h2 id="settings-h-auto" className="m-0 text-md font-semibold">
        {t('settings.group.auto')}
      </h2>

      <div
        className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface p-3"
        data-testid="auto-state-card"
        data-state={stateKey}
      >
        <span className="icon icon-auto text-accent" aria-hidden="true" />
        <span className="grow basis-60" role="status">
          {stateLine}
        </span>
        {stateActions}
      </div>
      {policy && expiringSoon ? (
        <p className="m-0 text-sm text-text-muted" data-testid="auto-expiring">
          {t('setup.auto.expiring', { count: daysLeft(policy.expiresAt, now) })}
        </p>
      ) : null}

      <p className="m-0">
        <Trans i18nKey="auto.intro" values={{ calendar }} components={{ bdi: <bdi /> }} />
      </p>

      <div className="flex flex-wrap gap-4">
        <div className="flex min-w-60 grow basis-60 flex-col gap-1">
          <h3 id="auto-happens-title" className="m-0 text-base font-semibold">
            {t('auto.happensTitle')}
          </h3>
          <ul aria-labelledby="auto-happens-title" data-testid="auto-happens" className="m-0 flex flex-col gap-1 ps-5">
            {AUTO_HAPPENS_KEYS.map((key) => (
              <li key={key}>{t(key, { days: scope.validityDays })}</li>
            ))}
          </ul>
        </div>
        <div className="flex min-w-60 grow basis-60 flex-col gap-1">
          <h3 id="auto-never-title" className="m-0 text-base font-semibold">
            {t('auto.neverTitle')}
          </h3>
          <ul aria-labelledby="auto-never-title" data-testid="auto-never" className="m-0 flex flex-col gap-1 ps-5">
            {AUTO_NEVER_KEYS.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="flex flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b border-line py-2">
          <span id="auto-scope-edits-label" className="grow basis-60">
            {t('auto.scope.edits')}
          </span>
          <Toggle
            checked={scope.edits}
            onChange={(next) => setScope({ edits: next })}
            labelledBy="auto-scope-edits-label"
            testId="auto-scope-edits"
            disabled={live}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 border-b border-line py-2">
          <span className="flex grow basis-60 flex-col">
            <span id="auto-scope-cancels-label">{t('auto.scope.cancels')}</span>
            <span id="auto-scope-cancels-desc" className="text-sm text-text-muted">
              {t('auto.scope.cancelsDesc')}
            </span>
          </span>
          <Toggle
            checked={scope.cancels}
            onChange={(next) => setScope({ cancels: next })}
            labelledBy="auto-scope-cancels-label"
            describedBy="auto-scope-cancels-desc"
            testId="auto-scope-cancels"
            disabled={live}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 border-b border-line py-2">
          <span id="auto-scope-quiet-label" className="grow basis-60">
            {t('auto.scope.quiet')}
          </span>
          <Toggle
            checked={scope.quietHours !== null}
            onChange={(next) => setScope({ quietHours: next ? DEFAULT_AUTO_SCOPE.quietHours : null })}
            labelledBy="auto-scope-quiet-label"
            testId="auto-scope-quiet"
            disabled={live}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 py-2">
          <label htmlFor="auto-scope-validity-select" className="grow basis-60">
            {t('auto.scope.validity')}
          </label>
          <select
            id="auto-scope-validity-select"
            className="field w-40"
            data-testid="auto-scope-validity"
            value={String(scope.validityDays)}
            disabled={live}
            onChange={(e) => setScope({ validityDays: e.target.value === '90' ? 90 : 30 })}
          >
            {([30, 90] as const).map((days) => (
              <option key={days} value={days}>
                {t('auto.scope.validityDays', { count: days })}
              </option>
            ))}
          </select>
        </div>
        {live ? (
          <p className="m-0 text-sm text-text-muted" data-testid="auto-scope-locked">
            {t('auto.scope.lockedWhileLive')}
          </p>
        ) : null}
      </div>

      {!state.preconditions.providerAllowsAuto ? (
        <p className="m-0 note-amber text-sm" data-testid="auto-provider-warning">
          {t('auto.pre.providerWarning')}
        </p>
      ) : null}

      {/* ux-i18n-v2-3: an expired policy whose Renew is hidden by a precondition still says why. Its Renew lives in the
          state card, so the enable pair below is only for a page without an ended policy. */}
      {!live ? (
        precondition !== null ? (
          <p
            className="m-0 flex flex-wrap items-center gap-2"
            data-testid="auto-precondition"
            data-reason={precondition}
          >
            <span className="icon icon-alert text-warn" aria-hidden="true" />
            <span className="grow">{preconditionLine}</span>
            {precondition === 'connect' ? (
              <button
                type="button"
                className="btn btn-outline"
                data-testid="auto-precondition-connect"
                onClick={() => document.getElementById('settings-group-calendar')?.scrollIntoView?.({ block: 'start' })}
              >
                {t('settings.calendar.reconnect')}
              </button>
            ) : null}
          </p>
        ) : policy?.state === 'expired' ? null : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              className="btn btn-outline"
              data-testid="auto-enable-now"
              disabled={waiting}
              onClick={(e) => void enable(e, false)}
            >
              {t('auto.enableNow')}
            </button>
            <button
              type="button"
              className="btn btn-outline"
              data-testid="auto-enable-trial"
              disabled={waiting}
              onClick={(e) => void enable(e, true)}
            >
              {t('auto.enableTrial')}
            </button>
          </div>
        )
      ) : null}

      {waiting ? (
        <p className="m-0 text-sm" role="status" data-testid="auto-waiting-dialog">
          {t('auto.waitingDialog')}
        </p>
      ) : null}
      {refused !== null && refused.forState === stateKey ? (
        <div
          role="alert"
          className="rounded-sm bg-warn-soft p-2"
          data-testid="auto-refused"
          data-reason={refused.reason}
        >
          <p className="m-0">{t(`auto.refused.${refused.reason}`)}</p>
        </div>
      ) : null}
      {error && error !== 'BAD_REQUEST' ? (
        <div role="alert" className="rounded-sm bg-warn-soft p-2" data-testid="auto-error" data-code={error}>
          <p className="m-0 font-semibold">{t(`errors.${error}.title`)}</p>
          <p className="m-0 text-sm">{t(`errors.${error}.body`)}</p>
        </div>
      ) : null}

      {onOpenActivity ? (
        <button
          type="button"
          className="btn btn-quiet self-start"
          data-testid="auto-open-activity"
          onClick={onOpenActivity}
        >
          {t('auto.openActivity')}
        </button>
      ) : null}
    </section>
  );
}
