// src/renderer/src/components/Badges.tsx - badge chips (UX 6.6; owner W1-15). Text from locale keys only.
// The LLM returns enum codes, never badge text, so nothing untrusted can reach a chip.
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { BADGE_SEVERITY, type Badge, type HoldReason } from '@shared/types';
import type { ErrorCode } from '@shared/errors';

export interface BadgesProps {
  codes: Badge[];
  holdReason?: HoldReason;
  errorCode?: ErrorCode;
  scope: 'event' | 'draft' | 'card';
  onBadgeAction?(code: Badge): void;
}

/** Which chip belongs under the date tab, which under the draft box and which on the card itself (UX 6.5). */
const SCOPE_OF: Record<Badge, BadgesProps['scope']> = {
  time_assumed: 'event',
  conflict: 'event',
  change_in_google: 'event',
  link_removed: 'draft',
  personal_details: 'draft',
  manipulation: 'draft',
  lang_mismatch: 'draft',
  older_message: 'card',
};

/** Only `time_assumed` is interactive: it opens the sheet with the time field focused (UX 6.6). */
const ACTIONABLE: readonly Badge[] = ['time_assumed'];

const TONE: Record<'info' | 'amber' | 'red', string> = {
  info: 'bg-quote text-text-muted',
  amber: 'bg-warn-soft text-warn',
  red: 'bg-danger-soft text-danger',
};

const ICON_PATH: Record<Badge, string> = {
  time_assumed: 'M8 4v4l2.5 1.5',
  conflict: 'M8 3.2 14 13H2Z M8 7v2.6 M8 11.2v.6',
  personal_details: 'M8 2.5 13 4.3v3.4c0 3-2.1 5-5 5.8-2.9-.8-5-2.8-5-5.8V4.3Z',
  lang_mismatch: 'M8 5.2v.6 M8 7.4V11',
  link_removed:
    'M6.2 9.8 4.8 11.2a2.4 2.4 0 0 1-3.4-3.4L2.8 6.4 M9.8 6.2l1.4-1.4a2.4 2.4 0 0 1 3.4 3.4l-1.4 1.4 M2.5 2.5l11 11',
  manipulation: 'M5.6 2.5h4.8L13.5 5.6v4.8L10.4 13.5H5.6L2.5 10.4V5.6Z M8 5.4v3.2 M8 10.6v.6',
  change_in_google: 'M3.2 4.4h9.6v8.4H3.2Z M3.2 7h9.6 M5.6 2.6v1.8 M10.4 2.6v1.8',
  older_message: 'M8 3.4A4.6 4.6 0 1 1 3.4 8 M8 5.4V8l2 1.2 M3.4 8 1.8 6.4 M3.4 8 5 6.4',
};

function BadgeIcon({ code }: { code: Badge }): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      {ICON_PATH[code].split(' M').map((segment, index) => (
        <path key={index} d={index === 0 ? segment : `M${segment}`} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

export function Badges(props: BadgesProps) {
  const { t } = useTranslation();
  const codes = props.codes.filter((c) => SCOPE_OF[c] === props.scope);
  const showHold = props.scope === 'card' && props.holdReason !== undefined;
  const showError = props.scope === 'card' && props.errorCode !== undefined;
  if (codes.length === 0 && !showHold && !showError) return null;

  return (
    <ul data-testid="badges" data-scope={props.scope} className="m-0 flex list-none flex-wrap gap-1 p-0">
      {codes.map((code) => {
        const tone = TONE[BADGE_SEVERITY[code]];
        const label = t(`label.badge.${code}`);
        return (
          <li key={code}>
            {ACTIONABLE.includes(code) && props.onBadgeAction ? (
              <button
                type="button"
                className={`chip focus-ring cursor-pointer ${tone}`}
                data-testid={`badge-${code}`}
                onClick={() => props.onBadgeAction?.(code)}
              >
                <BadgeIcon code={code} />
                {label}
              </button>
            ) : (
              <span className={`chip ${tone}`} data-testid={`badge-${code}`}>
                <BadgeIcon code={code} />
                {label}
              </span>
            )}
          </li>
        );
      })}
      {showHold ? (
        <li>
          <span className="chip" data-testid={`hold-${props.holdReason}`}>
            {t(`label.holdReason.${props.holdReason}`)}
          </span>
        </li>
      ) : null}
      {showError ? (
        <li>
          <span className={`chip ${TONE.red}`} data-testid={`error-${props.errorCode}`}>
            {t(`errors.${props.errorCode}.title`)}
          </span>
        </li>
      ) : null}
    </ul>
  );
}
