// src/renderer/src/components/QuotedBubble.tsx - inert message text (UX 6.5 item 2, 7.1, 14.2; owner W1-15).
// No children prop, ever: the ONLY way text enters this component is the `text` string, which React renders as a text
// node. No links, no markdown, no emoji enlargement, no media - a non-text trigger shows an app-authored placeholder.
import { useTranslation } from 'react-i18next';

export type MediaKind = 'photo' | 'voice' | 'sticker' | 'location' | 'other';
export interface QuotedBubbleProps {
  text: string | null;
  from: 'contact' | 'me';
  lang?: 'he' | 'en' | null;
  clampLines?: number;
  isTrigger?: boolean;
  mediaKind?: MediaKind;
  timeLabel?: string;
}

export function QuotedBubble(props: QuotedBubbleProps) {
  const { t } = useTranslation();
  const mine = props.from === 'me';
  const hasText = props.text !== null && props.text !== '';
  // Retention nulls the text; an empty string with a media kind is a photo/voice/sticker/location trigger.
  const placeholder = props.mediaKind
    ? t(`card.media.${props.mediaKind}`)
    : props.text === null
      ? t('card.messageRemoved')
      : null;

  const tone = mine ? 'bg-accent-soft' : 'bg-quote';
  const clamp = props.clampLines
    ? {
        display: '-webkit-box',
        WebkitBoxOrient: 'vertical' as const,
        WebkitLineClamp: props.clampLines,
        overflow: 'hidden',
      }
    : undefined;

  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        data-testid="quoted-bubble"
        data-from={props.from}
        data-trigger={props.isTrigger ? 'true' : undefined}
        className={`max-w-full rounded-md rounded-ss-xs px-3 py-2 ${tone} ${props.isTrigger ? 'border-s-2 border-accent' : ''}`}
      >
        {mine ? <span className="sr-only">{t('card.you')} </span> : null}
        {hasText ? (
          <p className="msg-text m-0 text-base" dir="auto" lang={props.lang ?? undefined} style={clamp}>
            {props.text}
          </p>
        ) : null}
        {placeholder !== null ? (
          <p className="m-0 text-base text-text-muted" data-testid="quoted-placeholder">
            {placeholder}
          </p>
        ) : null}
        {props.timeLabel ? (
          <span className="tnum block text-xs text-text-muted" data-testid="quoted-time">
            {props.timeLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
}
