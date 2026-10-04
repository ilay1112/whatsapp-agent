// src/renderer/src/components/Badges.tsx - badge chips (UX 6.6; owner W1-15). Text from locale keys only.
// The LLM returns enum codes, never badge text, so nothing untrusted can reach a chip.
// [V2] (owner V2-W1-11) UX2 1.2 / 3.3 / 3.6 / 14.2 + F31 / F28: the v2 codes get their scope, tone and glyph here;
// `image_unclear` is actionable like `time_assumed` (opens the sheet with the Date field focused); the muted
// self-trigger line "You changed this in the chat" (F28) is app text rendered with the card-scope chips.
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
  /** [V2, F28] The run was triggered by the user's own message: one muted line "You changed this in the chat". */
  selfTriggered?: boolean;
  /**
   * REQUEST 8: scopes whose own row is NOT drawn on this card (no draft box, no EventChip). Their codes are shown in this
   * row instead, so no badge - above all a red one such as `manipulation` - is ever hidden by a missing host row.
   */
  adoptScopes?: readonly BadgesProps['scope'][];
}

/** The scope a code is drawn in (UX 6.5). */
export function scopeOf(code: Badge): BadgesProps['scope'] {
  return SCOPE_OF[code];
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
  // [V2] Card scope for the codes that must be visible even when no EventChip is drawn (a change_unclear card has no
  // delta; a picture whose text analysis failed has no event). automatic / auto_shadow live with the event: ItemCard
  // draws them from `item.auto` (with the write kind), so the raw codes only show when no `auto` view came along.
  change_unclear: 'card',
  change_target_unclear: 'card',
  from_image: 'card',
  image_unclear: 'card',
  image_unread: 'card',
  automatic: 'event',
  auto_shadow: 'event',
};

/** Only `time_assumed` is interactive: it opens the sheet with the time field focused (UX 6.6). */
const ACTIONABLE: readonly Badge[] = ['time_assumed', 'image_unclear'];

const TONE: Record<'info' | 'amber' | 'red', string> = {
  info: 'bg-quote text-text-muted',
  amber: 'bg-warn-soft text-warn',
  red: 'bg-danger-soft text-danger',
};
/** [V2] UX2 1.2: the new info facts use the accent family; the trial chip is the dashed outline. */
const TONE_OVERRIDE: Partial<Record<Badge, string>> = {
  from_image: 'chip-info',
  image_unread: 'chip-info',
  automatic: 'chip-info',
  auto_shadow: 'chip-shadow',
};
/** [V2] Codes with a long sentence (UX2 14.2 `badge.<code>.long`), shown as the chip's tooltip. */
const LONG: readonly Badge[] = [
  'change_unclear',
  'change_target_unclear',
  'from_image',
  'image_unclear',
  'image_unread',
  'auto_shadow',
];
export function toneOf(code: Badge): string {
  return TONE_OVERRIDE[code] ?? TONE[BADGE_SEVERITY[code]];
}

const ICON_PATH: Record<Badge, string> = {
  time_assumed: 'M8 4v4l2.5 1.5',
  conflict: 'M8 3.2 14 13H2Z M8 7v2.6 M8 11.2v.6',
  personal_details: 'M8 2.5 13 4.3v3.4c0 3-2.1 5-5 5.8-2.9-.8-5-2.8-5-5.8V4.3Z',
  lang_mismatch: 'M8 5.2v.6 M8 7.4V11',
  link_removed:
    'M6.2 9.8 4.8 11.2a2.4 2.4 0 0 1-3.4-3.4L2.8 6.4 M9.8 6.2l1.4-1.4a2.4 2.4 0 0 1 3.4 3.4l-1.4 1.4 M2.5 2.5l11 11',
  manipulation: 'M5.6 2.5h4.8L13.5 5.6v4.8L10.4 13.5H5.6L2.5 10.4V5.6Z M8 5.4v3.2 M8 10.6v.6',
  change_in_google: 'M3.2 4.4h9.6v8.4H3.2Z M3.2 7h9.6 M5.6 2.6v1.8 M10.4 2.6v1.8',
  // [V2] UX2 1.3 glyphs drawn in the v1 12 px stroke style: a question mark for the two "unclear change" codes, the
  // picture frame (image), the frame with a mark / a slash for "hard to read" / "not read", the calendar + arcs (auto).
  change_unclear: 'M6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.5 M8 11.4v.4',
  change_target_unclear: 'M6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.5 M8 11.4v.4',
  from_image: 'M2.2 3.2h11.6v9.6H2.2Z M5.5 6.4v.2 M2.4 11.6l3.6-3.4 2.4 2.2 1.8-1.6 3.4 3',
  image_unclear: 'M2.2 3.2h11.6v9.6H2.2Z M8 5.6v3 M8 10.4v.4',
  image_unread: 'M2.2 3.2h11.6v9.6H2.2Z M2.5 2.5l11 11',
  automatic: 'M2.2 3.2h11.6v10.4H2.2Z M2.2 6.2h11.6 M6 11.6a2 2 0 0 1 4 0 M4.4 11.6a3.6 3.6 0 0 1 7.2 0',
  auto_shadow: 'M2.2 3.2h11.6v10.4H2.2Z M2.2 6.2h11.6 M6 11.6a2 2 0 0 1 4 0 M4.4 11.6a3.6 3.6 0 0 1 7.2 0',
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
  const adopted = props.adoptScopes ?? [];
  const codes = props.codes.filter((c) => SCOPE_OF[c] === props.scope || adopted.includes(SCOPE_OF[c]));
  const showHold = props.scope === 'card' && props.holdReason !== undefined;
  const showError = props.scope === 'card' && props.errorCode !== undefined;
  const showSelf = props.scope === 'card' && props.selfTriggered === true;
  if (codes.length === 0 && !showHold && !showError && !showSelf) return null;

  return (
    <ul data-testid="badges" data-scope={props.scope} className="m-0 flex list-none flex-wrap gap-1 p-0">
      {codes.map((code) => {
        const tone = toneOf(code);
        const label = t(`label.badge.${code}`);
        const long = LONG.includes(code) ? t(`badge.${code}.long`) : undefined;
        return (
          <li key={code}>
            {ACTIONABLE.includes(code) && props.onBadgeAction ? (
              <button
                type="button"
                className={`chip focus-ring cursor-pointer ${tone}`}
                data-testid={`badge-${code}`}
                title={long}
                onClick={() => props.onBadgeAction?.(code)}
              >
                <BadgeIcon code={code} />
                {label}
              </button>
            ) : (
              <span className={`chip ${tone}`} data-testid={`badge-${code}`} title={long}>
                <BadgeIcon code={code} />
                {label}
              </span>
            )}
          </li>
        );
      })}
      {showSelf ? (
        <li className="basis-full">
          <span className="text-xs text-text-muted" data-testid="badge-self-trigger">
            {t('change.byYou')}
          </span>
        </li>
      ) : null}
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
