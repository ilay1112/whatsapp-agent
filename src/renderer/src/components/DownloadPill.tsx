// src/renderer/src/components/DownloadPill.tsx - model download pill + popover (UX 5.3, 14.2; owner W1-14).
// Renders nothing when `progress` is null. Progress is NOT put in a live region (only "download finished" is announced by
// App); updates arrive at 4 Hz but the DOM text changes at most once per second.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ErrorCode } from '@shared/errors';
import { ERROR_ACTION } from '@shared/errors';
import type { ModelTier } from '@shared/types';

export interface DownloadPillProgress {
  tier: ModelTier;
  status: 'downloading' | 'paused' | 'verifying' | 'failed';
  bytesDone: number;
  bytesTotal: number;
  bytesPerSec?: number;
  etaSec?: number;
  errorCode?: ErrorCode;
}

export interface DownloadPillProps {
  progress: DownloadPillProgress | null;
  onPause(): void;
  onResume(): void;
  onCancel(): void;
  onRetry(): void;
}

/** Re-renders with `value` at most once per `ms`; the first value is shown at once. */
export function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const lastRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const now = Date.now();
    const wait = Math.max(0, lastRef.current + ms - now);
    if (wait === 0) {
      lastRef.current = now;
      setShown(value);
      return;
    }
    timerRef.current = setTimeout(() => {
      lastRef.current = Date.now();
      setShown(value);
    }, wait);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [value, ms]);
  return shown;
}

export function formatBytes(bytes: number, locale: string): string {
  const gb = bytes / 1_000_000_000;
  const mb = bytes / 1_000_000;
  return gb >= 1
    ? `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(gb)} GB`
    : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(mb)} MB`;
}

export function DownloadPill({ progress, onPause, onResume, onCancel, onRetry }: DownloadPillProps) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const percentRaw =
    progress && progress.bytesTotal > 0
      ? Math.min(100, Math.floor((progress.bytesDone / progress.bytesTotal) * 100))
      : 0;
  const percent = useThrottled(percentRaw, 1000);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointer = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  if (!progress) return null;

  const locale = i18n.language === 'he' ? 'he-IL' : 'en-IL';
  const minutes = progress.etaSec != null && progress.etaSec > 0 ? Math.max(1, Math.round(progress.etaSec / 60)) : null;
  const label =
    progress.status === 'failed'
      ? t('download.failed')
      : progress.status === 'verifying'
        ? t('download.verifying')
        : progress.status === 'paused'
          ? t('download.paused', { percent })
          : t('download.downloading', { percent });
  const valueText =
    minutes != null && progress.status === 'downloading'
      ? t('download.valueText', { percent, minutes })
      : t('download.valueTextShort', { percent });

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        data-testid="download-pill"
        data-status={progress.status}
        data-percent={percent}
        aria-expanded={open}
        aria-label={t('download.showDetails')}
        onClick={() => setOpen((v) => !v)}
        className={`pill relative overflow-hidden ${progress.status === 'failed' ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-text'}`}
      >
        <span className="tnum">{label}</span>
        {minutes != null && progress.status === 'downloading' ? (
          <span className="tnum text-text-muted">{t('download.etaShort', { minutes })}</span>
        ) : null}
        {/* 2 px track along the block-end edge; it fills from the inline-start side, so right-to-left in Hebrew. */}
        <span
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={valueText}
          data-testid="download-progress"
          className="absolute start-0 bottom-0 block h-0.5 bg-accent"
          style={{ inlineSize: `${percent}%` }}
        />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label={t('download.title')}
          data-testid="download-panel"
          className="absolute end-0 z-20 mt-1 w-80 max-w-full rounded-md border border-line bg-surface p-3 shadow-pop"
        >
          <p className="m-0 text-md font-semibold">{t(`download.tier.${progress.tier}`)}</p>
          <p className="m-0 text-sm text-text-muted tnum">
            {t('download.bytes', {
              done: formatBytes(progress.bytesDone, locale),
              total: formatBytes(progress.bytesTotal, locale),
            })}
          </p>
          {progress.bytesPerSec ? (
            <p className="m-0 text-sm text-text-muted tnum">
              {t('download.speed', { speed: formatBytes(progress.bytesPerSec, locale) })}
            </p>
          ) : null}
          {minutes != null ? (
            <p className="m-0 text-sm text-text-muted tnum">{t('download.eta', { minutes })}</p>
          ) : null}

          {progress.status === 'failed' ? (
            <>
              {progress.errorCode ? (
                <p className="m-0 mt-2 text-sm" data-testid="download-error">
                  {t(`errors.${progress.errorCode}.title`)}
                </p>
              ) : null}
              <button type="button" className="btn btn-primary mt-2" data-testid="download-retry" onClick={onRetry}>
                {progress.errorCode && ERROR_ACTION[progress.errorCode] !== 'none'
                  ? t(`errors.${progress.errorCode}.action`)
                  : t('app.tryAgain')}
              </button>
            </>
          ) : (
            <div className="mt-2 flex gap-2">
              {progress.status === 'paused' ? (
                <button type="button" className="btn btn-outline" data-testid="download-resume" onClick={onResume}>
                  {t('download.resume')}
                </button>
              ) : (
                <button type="button" className="btn btn-outline" data-testid="download-pause" onClick={onPause}>
                  {t('download.pause')}
                </button>
              )}
              <button type="button" className="btn btn-quiet" data-testid="download-cancel" onClick={onCancel}>
                {t('download.cancel')}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
