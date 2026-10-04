// src/renderer/src/components/SetupStrip.tsx - one row per unfinished setup task, under the header (UX 5.4, 14.2;
// owner W1-14, v2: V2-W1-12). Never a modal, never more than two rows, most blocking first. Rows the user may hide stay
// hidden only until the app restarts - the fact stays visible in the status panel.
// [V2] UX2 2.3 rows 4-9: consent v2, automatic mode (paused / trial / expiring / expired) and the voice download.
// Values interpolated into the rows are app facts (numbers, a vendor NAME constant, a translated reason, a formatted
// date) - never message text, a title or a contact name.
import { Trans, useTranslation } from 'react-i18next';
import { HIDEABLE_SETUP_TASKS, SETUP_TASKS, type HideableSetupTask, type SetupTask } from '../store/health';

export type { SetupTask } from '../store/health';

export interface SetupRowDetails {
  consent_v2?: { vendor: string };
  auto_paused?: { reason: string };
  /** AutoState.shadowTally carries one "would have been automatic" total (no add/change split, C2 1.5). */
  auto_trial?: { seen: number; wouldAuto: number; ready: boolean };
  auto_expiring?: { days: number };
  voice_download?: { percent: number };
  auto_expired?: { date: string };
}

export interface SetupStripProps {
  tasks: SetupTask[];
  details?: SetupRowDetails;
  /** `secondary` = the row's second button (UX2 2.3: "Settings" / "Stop" / "Hide" handled by onHide). */
  onAction(task: SetupTask, secondary?: true): void;
  onHide(task: HideableSetupTask): void;
}

/** Most blocking first (UX 5.4 + UX2 2.3 priorities 1-9). */
const ORDER: readonly SetupTask[] = SETUP_TASKS;
const MAX_ROWS = 2;

function InfoIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.2v4" strokeLinecap="round" />
      <circle cx="8" cy="4.9" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

const isHideable = (task: SetupTask): task is HideableSetupTask =>
  (HIDEABLE_SETUP_TASKS as readonly SetupTask[]).includes(task);

export function SetupStrip({ tasks, details = {}, onAction, onHide }: SetupStripProps) {
  const { t } = useTranslation();
  const rows = ORDER.filter((task) => tasks.includes(task)).slice(0, MAX_ROWS);
  if (rows.length === 0) return null;

  /** The row sentence (a <Trans> where the value is a date inside <bdi>). */
  const text = (task: SetupTask) => {
    switch (task) {
      case 'consent_v2':
        return t('setup.consentV2.text', { vendor: details.consent_v2?.vendor ?? '' });
      case 'auto_paused':
        return t('setup.auto.paused', { reason: details.auto_paused?.reason ?? '' });
      case 'auto_trial': {
        const d = details.auto_trial ?? { seen: 0, wouldAuto: 0, ready: false };
        return d.ready
          ? t('setup.auto.trialReadyTotal', { wouldAuto: d.wouldAuto })
          : t('setup.auto.trialEarly', { seen: d.seen });
      }
      case 'auto_expiring':
        return t('setup.auto.expiring', { count: details.auto_expiring?.days ?? 0 });
      case 'voice_download':
        return t('setup.voice.downloading', { percent: details.voice_download?.percent ?? 0 });
      case 'auto_expired':
        return (
          <Trans
            i18nKey="setup.auto.expired"
            values={{ date: details.auto_expired?.date ?? '' }}
            components={{ bdi: <bdi /> }}
          />
        );
      default:
        return t(`setup.${task}.text`);
    }
  };

  /** [primary, secondary] labels; null = no button (UX2 2.3 row 8 has none - the pill has the controls). */
  const actions = (task: SetupTask): [string | null, string | null] => {
    switch (task) {
      case 'consent_v2':
        return [t('setup.consentV2.action'), null];
      case 'auto_paused':
        return [t('auto.resume'), t('app.settings')];
      case 'auto_trial':
        return details.auto_trial?.ready ? [t('auto.endShadow'), t('auto.stop')] : [t('setup.auto.review'), null];
      case 'auto_expiring':
      case 'auto_expired':
        return [t('auto.renew'), null];
      case 'voice_download':
        return [null, null];
      default:
        return [t(`setup.${task}.action`), null];
    }
  };

  return (
    <section aria-label={t('setup.title')} className="bg-accent-soft text-text">
      {rows.map((task) => {
        const [primary, secondary] = actions(task);
        return (
          <div
            key={task}
            data-testid={`setup-strip-${task}`}
            className="flex min-h-9 flex-wrap items-center gap-2 border-b border-line px-4 py-1 last:border-b-0"
          >
            <InfoIcon />
            <span className="grow text-sm">{text(task)}</span>
            {primary ? (
              <button
                type="button"
                className="btn btn-outline"
                data-testid={`setup-action-${task}`}
                onClick={() => onAction(task)}
              >
                {primary}
              </button>
            ) : null}
            {secondary ? (
              <button
                type="button"
                className="btn btn-quiet"
                data-testid={`setup-secondary-${task}`}
                onClick={() => onAction(task, true)}
              >
                {secondary}
              </button>
            ) : null}
            {isHideable(task) ? (
              <button
                type="button"
                className="btn btn-quiet"
                data-testid={`setup-hide-${task}`}
                onClick={() => onHide(task)}
              >
                {t('setup.hide')}
              </button>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
