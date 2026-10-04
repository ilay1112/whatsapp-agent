// src/renderer/src/components/ImageBubble.tsx - "the contact, as the app read the picture" (UX2 1.1, 3.6, 3.7, 11.6,
// 14.5; B19, B27; owner V2-W1-11-renderer-dashboard).
//
// readText / dateText / timeText / location are UNTRUSTED: one React text node each, `dir="auto"`, no links, no
// markdown, no dangerouslySetInnerHTML. The thumbnail is shown ONLY from an inline `data:image/...;base64,` URL that
// came in the view model (or from `item:getImage`, rendered by the sheet) - never an http(s)/file URL, never a link,
// not draggable, no context menu. `alt` is the one attribute an untrusted value (the contact name) may reach (UX2 15.3).
import { useTranslation } from 'react-i18next';
import type { ImageReadView } from '@shared/types';
import { SENTINEL, renderBdiTemplate } from './ItemCard.bdi';

export interface ImageBubbleProps {
  image: ImageReadView;
  contactName: string;
  mode: 'card' | 'sheet';
}

/** The only picture sources the renderer ever displays: an inline base64 raster image. */
const SAFE_DATA_URL_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]*={0,2}$/;
export function safeImageSrc(url: string | null | undefined): string | null {
  return typeof url === 'string' && SAFE_DATA_URL_RE.test(url) ? url : null;
}

/** An inert picture: no link, no drag, no context menu, not focusable. */
export function InertPicture(props: { src: string; alt: string; className: string; testId: string }) {
  return (
    <img
      src={props.src}
      alt={props.alt}
      className={props.className}
      draggable={false}
      data-testid={props.testId}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}

/** Real test id is `image-bubble-<itemId>` (UX2 13), set by the caller's wrapper. */
export function ImageBubble({ image, contactName, mode }: ImageBubbleProps) {
  const { t } = useTranslation();
  const thumb = mode === 'card' ? safeImageSrc(image.thumbDataUrl) : null;
  const hasText = image.readText !== '';
  const alt = t('image.alt', { name: contactName });
  const clamp =
    mode === 'card'
      ? { display: '-webkit-box', WebkitBoxOrient: 'vertical' as const, WebkitLineClamp: 3, overflow: 'hidden' }
      : undefined;

  const asWritten = (key: 'date' | 'time' | 'place', value: string) => (
    <p className="m-0 text-sm" data-testid={`sheet-as-written-${key}`}>
      {renderBdiTemplate(t(`image.asWritten.${key}`, { v: SENTINEL(0) }), [value !== '' ? value : '-'])}
    </p>
  );

  return (
    <div
      data-testid="image-bubble"
      data-mode={mode}
      data-kind={image.kind}
      className="flex max-w-full flex-col gap-1 rounded-md rounded-ss-xs bg-quote px-3 py-2"
    >
      <div className="flex items-center gap-2 text-sm text-text-muted">
        <span className="icon icon-image" aria-hidden="true" />
        <span>{t('image.label')}</span>
      </div>
      <div className="media-rule" aria-hidden="true" />
      <div className="flex items-start gap-3">
        {thumb !== null ? (
          <InertPicture src={thumb} alt={alt} className="image-thumb shrink-0 rounded-sm" testId="image-thumb" />
        ) : null}
        {hasText ? (
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-text-muted">{t('image.readLabel')}</span>
            <p className="msg-text m-0 text-base" dir="auto" style={clamp} data-testid="image-readtext">
              {image.readText}
            </p>
          </div>
        ) : null}
      </div>
      {mode === 'sheet' ? (
        <div className="flex flex-col gap-1" data-testid="image-as-written">
          {asWritten('date', image.dateText)}
          {asWritten('time', image.timeText)}
          {asWritten('place', image.location)}
        </div>
      ) : null}
      <p className="media-caution m-0" data-testid="image-caution">
        {t('image.caution')}
      </p>
    </div>
  );
}
