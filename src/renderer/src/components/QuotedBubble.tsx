// src/renderer/src/components/QuotedBubble.tsx - inert message text (UX 6.5 item 2, 7.1, 14.2; owner W1-15).
// No children prop, ever: the ONLY way text enters this component is the `text` string, which React renders as a text
// node. No links, no markdown, no emoji enlargement, no media - a non-text trigger shows an app-authored placeholder.
//
// [V2] (owner V2-W1-11) Delegates by `triggerKind` (UX2 3.5 / 3.6 / 12): a voice trigger renders VoiceBubble, an image
// trigger that was read renders ImageBubble. Both stay inert text; this component still never takes children.
import { useTranslation } from 'react-i18next';
import type { ImageReadView, TriggerKind, VoiceView } from '@shared/types';
import { ImageBubble } from './ImageBubble';
import { VoiceBubble } from './VoiceBubble';

export type MediaKind = 'photo' | 'voice' | 'sticker' | 'location' | 'other';
export interface QuotedBubbleProps {
  text: string | null;
  from: 'contact' | 'me';
  lang?: 'he' | 'en' | null;
  clampLines?: number;
  isTrigger?: boolean;
  mediaKind?: MediaKind;
  timeLabel?: string;
  /** [V2] The trigger's kind; voice / image delegate to their bubble when the matching view model is present. */
  triggerKind?: TriggerKind;
  voice?: VoiceView | null;
  image?: ImageReadView | null;
  /** [V2] Plain text for the picture's `alt` ("Picture sent by ..."). */
  contactName?: string;
  /** [V2] Suffix of the `voice-bubble-<itemId>` / `image-bubble-<itemId>` wrapper test ids (UX2 13). */
  itemId?: number;
  /** [V2] Sheet: the full transcript, no clamp (UX2 3.5). */
  full?: boolean;
}

export function QuotedBubble(props: QuotedBubbleProps) {
  const { t } = useTranslation();
  if (props.triggerKind === 'voice' && props.voice) {
    return (
      <div className="flex justify-start" data-testid={`voice-bubble-${props.itemId ?? 0}`}>
        <VoiceBubble voice={props.voice} clampLines={props.clampLines} full={props.full} />
      </div>
    );
  }
  if (props.triggerKind === 'image' && props.image) {
    return (
      <div className="flex justify-start" data-testid={`image-bubble-${props.itemId ?? 0}`}>
        <ImageBubble image={props.image} contactName={props.contactName ?? ''} mode="card" />
      </div>
    );
  }
  const mine = props.from === 'me';
  const hasText = props.text !== null && props.text !== '';
  // Retention nulls the text; an empty string with a media kind is a photo/voice/sticker/location trigger.
  const mediaKind =
    props.mediaKind ??
    (props.triggerKind === 'voice' ? 'voice' : props.triggerKind === 'image' && !hasText ? 'photo' : undefined);
  const placeholder = mediaKind ? t(`card.media.${mediaKind}`) : props.text === null ? t('card.messageRemoved') : null;

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
