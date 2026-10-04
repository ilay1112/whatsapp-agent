// src/renderer/src/components/VoiceBubble.tsx - "the contact, as the app heard it" (UX2 1.1, 3.5, 11.6, 14.5; B18, B27;
// owner V2-W1-11-renderer-dashboard).
//
// The transcript is UNTRUSTED. It is rendered as ONE React text node inside the contact bubble surface: no links, no
// markdown, no emoji enlargement, no children prop, no dangerouslySetInnerHTML - a transcript that reads like HTML
// (`<img src=x onerror=...>`) or a markdown link stays literal text. It never reaches a toast, the tray, the window
// title, an aria-live region or a file name. Everything else here (header, duration, language chip, caution) is app text.
// No play button (U-v2-6).
import { useTranslation } from 'react-i18next';
import type { VoiceView } from '@shared/types';
import { useSettingsStore } from '../store/settings';
import { SENTINEL, renderBdiTemplate } from './ItemCard.bdi';
import { formatClockDuration } from '@shared/i18n/format';

export interface VoiceBubbleProps {
  voice: VoiceView;
  clampLines?: number;
  full?: boolean;
}

/** `transcripts.language` -> the chip key ('he' | 'en' | anything else = other language). */
export function voiceLangKey(language: string | null): 'he' | 'en' | 'other' | null {
  if (language === null || language === '') return null;
  if (language === 'he' || language === 'en') return language;
  return 'other';
}

/** B18 / S0: longer notes are never transcribed (settings.voice.maxMinutes, 15 by default). */
export const VOICE_MAX_SECONDS = 15 * 60;

/** Real test id is `voice-bubble-<itemId>` (UX2 13), set by the caller's wrapper. */
export function VoiceBubble({ voice, clampLines, full }: VoiceBubbleProps) {
  const { t } = useTranslation();
  const retentionDays = useSettingsStore((s) => s.settings?.privacy.retentionDays) ?? 30;
  const duration = formatClockDuration(voice.seconds);
  const minutes = Math.floor(Math.round(voice.seconds) / 60);
  const seconds = Math.round(voice.seconds) % 60;
  const langKey = voiceLangKey(voice.language);
  const tooLong = voice.seconds > VOICE_MAX_SECONDS && voice.status !== 'done';
  const hasText = voice.status === 'done' && voice.transcript !== null && voice.transcript !== '';
  const clamp =
    !full && clampLines
      ? {
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical' as const,
          WebkitLineClamp: clampLines,
          overflow: 'hidden',
        }
      : undefined;

  let muted: string | null = null;
  if (tooLong) muted = t('errors.VOICE_TOO_LONG.title');
  else if (voice.status === 'empty') muted = t('voice.noSpeech');
  else if (voice.status === 'failed' || voice.status === 'aborted') muted = t('voice.notTranscribed');

  return (
    <div
      data-testid="voice-bubble"
      data-status={voice.status}
      className="flex max-w-full flex-col gap-1 rounded-md rounded-ss-xs bg-quote px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
        <span className="icon icon-mic" aria-hidden="true" />
        <span className="grow">
          {renderBdiTemplate(t('voice.label', { duration: SENTINEL(0) }), [
            <span
              key="d"
              className="tnum"
              data-testid="voice-duration"
              aria-label={t('voice.durationA11y', { minutes, seconds })}
            >
              {duration}
            </span>,
          ])}
        </span>
        {langKey !== null ? (
          <span className="chip" data-testid="voice-lang">
            {t(`voice.lang.${langKey}`)}
          </span>
        ) : null}
      </div>
      {hasText ? (
        <>
          <div className="media-rule" aria-hidden="true" />
          <p
            className="msg-text m-0 text-base"
            dir="auto"
            lang={langKey === 'he' || langKey === 'en' ? langKey : undefined}
            style={clamp}
            data-testid="voice-transcript"
          >
            {voice.transcript}
          </p>
          <p className="media-caution m-0" data-testid="voice-caution">
            {t('voice.caution')}
          </p>
        </>
      ) : null}
      {voice.status === 'done' && voice.transcript === null ? (
        <p className="m-0 text-sm text-text-muted" data-testid="voice-removed">
          {t('voice.removed', { days: retentionDays })}
        </p>
      ) : null}
      {muted !== null ? (
        <p className="m-0 text-sm text-text-muted" data-testid="voice-muted">
          {muted}
        </p>
      ) : null}
    </div>
  );
}
