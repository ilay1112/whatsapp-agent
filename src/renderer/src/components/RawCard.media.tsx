// src/renderer/src/components/RawCard.media.tsx - the ONE media action of a voice / picture card (UX2 3.5, 3.6, 9, 10;
// owner V2-W1-11-renderer-dashboard). Split out of RawCard.tsx so ItemCard (a picture whose text analysis still ran) can
// use it without an import cycle. None of these actions writes anywhere: they download a model, re-queue a transcript or
// an analysis, or ask the shell to open Settings.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ItemCard as ItemVM, ModelPlan, Result, VoiceState } from '@shared/types';
import type { ErrorCode } from '@shared/errors';
import { formatModelSize } from '@shared/i18n/format';
import { api } from '../api';
import { useDashboardStore } from '../store/dashboard';
import { useSettingsStore } from '../store/settings';

/** UX2 3.6: why a picture was not read, and therefore which ONE action the card offers. */
export type ImageUnreadCause = 'no_local_reader' | 'disabled' | 'provider_cannot' | 'media_unavailable' | 'read_failed';

export function imageUnreadCause(
  errorCode: ErrorCode | null,
  imagesEnabled: boolean,
  mmproj: ModelPlan['mmproj'],
): ImageUnreadCause {
  if (errorCode === 'MEDIA_UNAVAILABLE') return 'media_unavailable';
  if (errorCode === 'LLM_BAD_OUTPUT') return 'read_failed';
  if (!imagesEnabled) return 'disabled';
  if (mmproj !== null && mmproj.status !== 'ready') return 'no_local_reader';
  return 'provider_cannot';
}

/** The voice ErrorCodes whose one card action re-runs the transcript (UX2 3.5 table, section 10 deck). */
const VOICE_RETRY_CODES: readonly ErrorCode[] = [
  'VOICE_AUDIO_MISSING',
  'VOICE_TIMEOUT',
  'VOICE_DECODE_FAILED',
  'VOICE_LOCAL_FAILED',
];

/** Reads a main-side fact once per mounted card that needs it (never on a timer, never for cards that do not). */
function useOnce<T>(active: boolean, load: () => Promise<Result<T>>): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    void load().then((r) => {
      if (alive && r.ok) setValue(r.value);
    });
    return () => {
      alive = false;
    };
  }, [active, load]);
  return value;
}
const loadVoiceState = (): Promise<Result<VoiceState>> => api.getVoiceState();
const loadModelPlan = (): Promise<Result<ModelPlan>> => api.getModelPlan();

/**
 * The single media action of a voice / picture card (UX2 3.5, 3.6). Renders nothing for a text trigger, for a read
 * picture and for a voice note that needs no action (`VOICE_TOO_LONG`, done, empty).
 */
export function MediaActions({ item }: { item: ItemVM }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'he' ? 'he' : 'en';
  const requestNavigation = useDashboardStore((s) => s.requestNavigation);
  const voiceEnabled = useSettingsStore((s) => s.settings?.voice.enabled) ?? false;
  const imagesEnabled = useSettingsStore((s) => s.settings?.images.enabled) ?? true;
  const code = item.errorCode;
  const isVoice = item.triggerKind === 'voice';
  const voiceMissing = isVoice && code === 'VOICE_MODEL_MISSING';
  const imageUnread = item.triggerKind === 'image' && item.badges.includes('image_unread');
  const voiceState = useOnce(voiceMissing && voiceEnabled, loadVoiceState);
  const plan = useOnce(imageUnread, loadModelPlan);
  const [busy, setBusy] = useState(false);

  const run = (fn: () => Promise<unknown>): void => {
    if (busy) return;
    setBusy(true);
    void fn()
      .catch(() => undefined)
      .finally(() => {
        setBusy(false);
        void useDashboardStore.getState().refresh();
      });
  };

  if (isVoice) {
    if (voiceMissing) {
      if (!voiceEnabled)
        return (
          <button
            type="button"
            className="btn btn-outline"
            data-testid={`voice-download-${item.itemId}`}
            data-cause="disabled"
            onClick={() => requestNavigation({ view: 'settings', section: 'voice' })}
          >
            {t('image.action.turnOn')}
          </button>
        );
      const model = voiceState?.model ?? null;
      const tier = voiceState?.resolvedTier ?? null;
      const loading = model !== null && (model.status === 'downloading' || model.status === 'verifying');
      return (
        <button
          type="button"
          className="btn btn-outline"
          data-testid={`voice-download-${item.itemId}`}
          data-cause="model_missing"
          disabled={busy || tier === null || loading}
          onClick={() => {
            if (tier !== null) run(() => api.startDownload(tier));
          }}
        >
          {t('errors.VOICE_MODEL_MISSING.action', { size: model ? formatModelSize(model.sizeBytes, lang) : '-' })}
        </button>
      );
    }
    if (code !== null && VOICE_RETRY_CODES.includes(code))
      return (
        <button
          type="button"
          className="btn btn-outline"
          data-testid={`voice-retry-${item.itemId}`}
          disabled={busy}
          onClick={() => run(() => api.retryVoice(item.itemId))}
        >
          {t(`errors.${code}.action`)}
        </button>
      );
    if (code === 'VOICE_TOO_LONG_FOR_DEVICE')
      return (
        <button
          type="button"
          className="btn btn-outline"
          data-testid={`voice-lite-${item.itemId}`}
          onClick={() => requestNavigation({ view: 'settings', section: 'voice' })}
        >
          {t('errors.VOICE_TOO_LONG_FOR_DEVICE.action')}
        </button>
      );
    return null;
  }

  if (!imageUnread) return null;
  const mmproj = plan?.mmproj ?? null;
  const cause = imageUnreadCause(code, imagesEnabled, mmproj);
  let label: string;
  let onClick: () => void;
  let disabled = busy;
  switch (cause) {
    case 'no_local_reader':
      label = t('image.action.download', { size: mmproj ? formatModelSize(mmproj.sizeBytes, lang) : '-' });
      disabled = busy || mmproj === null || mmproj.status === 'downloading' || mmproj.status === 'verifying';
      onClick = () => run(() => api.startDownload('mmproj'));
      break;
    case 'disabled':
      label = t('image.action.turnOn');
      onClick = () => requestNavigation({ view: 'settings', section: 'pictures' });
      break;
    case 'provider_cannot':
      label = t('image.action.chooseAi');
      onClick = () => requestNavigation({ view: 'settings', section: 'ai' });
      break;
    case 'media_unavailable':
      label = t('errors.MEDIA_UNAVAILABLE.action');
      onClick = () => run(() => api.retriage(item.itemId));
      break;
    default:
      label = t('errors.LLM_BAD_OUTPUT.action');
      onClick = () => run(() => api.retriage(item.itemId));
  }
  return (
    <span className="flex flex-wrap items-center gap-2" data-testid={`image-unread-${item.itemId}`}>
      <span className="text-sm text-text-muted" data-testid={`image-unread-cause-${item.itemId}`}>
        {t(`image.unread.${cause}`)}
      </span>
      <button
        type="button"
        className="btn btn-outline"
        data-testid={`image-unread-action-${item.itemId}`}
        data-cause={cause}
        disabled={disabled}
        onClick={onClick}
      >
        {label}
      </button>
    </span>
  );
}
