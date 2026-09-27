// src/renderer/src/components/SetupStrip.tsx - one row per unfinished setup task, under the header (UX 5.4, 14.2;
// owner W1-14). Never a modal, never more than two rows, most blocking first. Only the calendar row may be hidden, and
// only until the app restarts - the fact stays visible in the status panel.
import { useTranslation } from 'react-i18next';

export type SetupTask = 'whatsapp' | 'ai' | 'calendar';

export interface SetupStripProps {
  tasks: SetupTask[];
  onAction(task: SetupTask): void;
  onHide(task: 'calendar'): void;
}

/** Most blocking first (UX 5.4). */
const ORDER: readonly SetupTask[] = ['whatsapp', 'ai', 'calendar'];
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

export function SetupStrip({ tasks, onAction, onHide }: SetupStripProps) {
  const { t } = useTranslation();
  const rows = ORDER.filter((task) => tasks.includes(task)).slice(0, MAX_ROWS);
  if (rows.length === 0) return null;

  return (
    <section aria-label={t('setup.title')} className="bg-accent-soft text-text">
      {rows.map((task) => (
        <div
          key={task}
          data-testid={`setup-strip-${task}`}
          className="flex min-h-9 items-center gap-2 border-b border-line px-4 py-1 last:border-b-0"
        >
          <InfoIcon />
          <span className="grow text-sm">{t(`setup.${task}.text`)}</span>
          <button
            type="button"
            className="btn btn-outline"
            data-testid={`setup-action-${task}`}
            onClick={() => onAction(task)}
          >
            {t(`setup.${task}.action`)}
          </button>
          {task === 'calendar' ? (
            <button
              type="button"
              className="btn btn-quiet"
              data-testid="setup-hide-calendar"
              onClick={() => onHide('calendar')}
            >
              {t('setup.hide')}
            </button>
          ) : null}
        </div>
      ))}
    </section>
  );
}
