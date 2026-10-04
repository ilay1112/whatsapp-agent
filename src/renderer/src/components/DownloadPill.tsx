// src/renderer/src/components/DownloadPill.tsx - model download pill + popover (UX 5.3, 14.2; owner W1-14, v2: V2-W1-12).
// Renders nothing when `progress` is null. Progress is NOT put in a live region (only completions are announced by App);
// updates arrive at 4 Hz but the DOM text changes at most once per second.
// [V2] UX2 2.1: ONE downloader queue of three visible kinds - `llm` (tiny/small/mid), `voice` (voice-hebrew /
// voice-multilingual / voice-lite; `voice-vad` rides silently with the first voice tier and is never shown) and `mmproj`
// (picture reading). The pill shows the ACTIVE file plus a muted "+N"; the popover lists every file in main's order
// (the renderer never re-orders) with Pause / Resume / Cancel per row. Names are words, never tier ids.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ErrorCode } from '@shared/errors';
import { ERROR_ACTION } from '@shared/errors';
import { MMPROJ_IDS, MODEL_TIERS, VOICE_TIERS, type DownloadTarget, type ModelFileId } from '@shared/types';

export interface DownloadPillProgress {
  tier: ModelFileId;
  status: 'downloading' | 'paused' | 'verifying' | 'failed';
  bytesDone: number;
  bytesTotal: number;
  bytesPerSec?: number;
  etaSec?: number;
  errorCode?: ErrorCode;
}

export interface DownloadPillProps {
  progress: DownloadPillProgress | null;
  /** [V2] Every file of the queue in main's order (the active one included). Omitted = just `progress`. */
  queue?: DownloadPillProgress[];
  onPause(target?: DownloadTarget): void;
  onResume(target?: DownloadTarget): void;
  onCancel(target?: DownloadTarget): void;
  onRetry(target?: DownloadTarget): void;
}

export type DownloadKind = 'llm' | 'voice' | 'mmproj';

/** Which of the three visible kinds a file is; `voice-vad` => null (never shown separately, UX2 2.1). */
export function downloadKindOf(id: ModelFileId): DownloadKind | null {
  if ((MODEL_TIERS as readonly string[]).includes(id)) return 'llm';
  if ((VOICE_TIERS as readonly string[]).includes(id)) return 'voice';
  if ((MMPROJ_IDS as readonly string[]).includes(id)) return 'mmproj';
  return null;
}

/** The `model:*` IPC target of a file (C2 8: a projector is addressed as 'mmproj' = the selected tier's projector). */
export function downloadTargetOf(id: ModelFileId): DownloadTarget {
  return (MMPROJ_IDS as readonly string[]).includes(id) ? 'mmproj' : (id as DownloadTarget);
}

/** The plain-words name of a file (UX2 2.1). */
export function downloadNameKey(id: ModelFileId): string {
  const kind = downloadKindOf(id);
  if (kind === 'llm') return `download.tier.${id}`;
  if (kind === 'mmproj') return 'download.kind.mmproj';
  return `download.kind.${id}`;
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

const percentOf = (p: DownloadPillProgress): number =>
  p.bytesTotal > 0 ? Math.min(100, Math.floor((p.bytesDone / p.bytesTotal) * 100)) : 0;
const minutesOf = (p: DownloadPillProgress): number | null =>
  p.etaSec != null && p.etaSec > 0 ? Math.max(1, Math.round(p.etaSec / 60)) : null;

export function DownloadPill({ progress, queue, onPause, onResume, onCancel, onRetry }: DownloadPillProps) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Visible files only (voice-vad never shows); the active one = the first that is moving, else the first.
  const files = (queue ?? (progress ? [progress] : [])).filter((p) => downloadKindOf(p.tier) !== null);
  const active =
    files.find((p) => p.status === 'downloading' || p.status === 'verifying') ??
    files[0] ??
    (progress && downloadKindOf(progress.tier) !== null ? progress : null);
  const more = active ? files.filter((p) => p.tier !== active.tier).length : 0;
  const percent = useThrottled(active ? percentOf(active) : 0, 1000);

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

  if (!active) return null;

  const locale = i18n.language === 'he' ? 'he-IL' : 'en-IL';
  const minutes = minutesOf(active);
  const kind = downloadKindOf(active.tier);
  const name = t(downloadNameKey(active.tier));
  const label =
    active.status === 'failed'
      ? t('download.failed')
      : active.status === 'verifying'
        ? t('download.verifying')
        : active.status === 'paused'
          ? t('download.paused', { percent })
          : kind === 'llm'
            ? t('download.downloading', { percent })
            : `${name} ${t('download.downloadingShort', { percent })}`;
  const valueText = `${name}, ${
    minutes != null && active.status === 'downloading'
      ? t('download.valueText', { percent, minutes })
      : t('download.valueTextShort', { percent })
  }`;
  const rows = files.length > 0 ? files : [active];

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        data-testid="download-pill"
        data-status={active.status}
        data-kind={kind ?? ''}
        data-percent={percent}
        aria-expanded={open}
        aria-label={t('download.showDetails')}
        onClick={() => setOpen((v) => !v)}
        className={`pill relative overflow-hidden ${active.status === 'failed' ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-text'}`}
      >
        <span className="tnum">{label}</span>
        {minutes != null && active.status === 'downloading' ? (
          <span className="tnum text-text-muted">{t('download.etaShort', { minutes })}</span>
        ) : null}
        {more > 0 ? (
          <span className="tnum text-text-muted" data-testid="download-more">
            {t('download.more', { count: more })}
          </span>
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
          className="absolute end-0 z-20 mt-1 flex w-80 max-w-full flex-col gap-3 rounded-md border border-line bg-surface p-3 shadow-pop"
        >
          {rows.map((p) => {
            const rowKind = downloadKindOf(p.tier) ?? 'llm';
            const target = downloadTargetOf(p.tier);
            const rowMinutes = minutesOf(p);
            const rowPercent = p.tier === active.tier ? percent : percentOf(p);
            const isActive = p.tier === active.tier;
            return (
              <div key={p.tier} data-testid={`download-row-${rowKind}-${p.tier}`} data-status={p.status}>
                <p className="m-0 text-md font-semibold">{t(downloadNameKey(p.tier))}</p>
                <p className="m-0 text-sm text-text-muted tnum">
                  {t('download.bytes', {
                    done: formatBytes(p.bytesDone, locale),
                    total: formatBytes(p.bytesTotal, locale),
                  })}
                </p>
                <p className="m-0 text-sm text-text-muted tnum">
                  {p.status === 'verifying'
                    ? t('download.verifying')
                    : p.status === 'paused'
                      ? t('download.paused', { percent: rowPercent })
                      : p.status === 'failed'
                        ? t('download.failed')
                        : t('download.downloading', { percent: rowPercent })}
                </p>
                {isActive && p.bytesPerSec ? (
                  <p className="m-0 text-sm text-text-muted tnum">
                    {t('download.speed', { speed: formatBytes(p.bytesPerSec, locale) })}
                  </p>
                ) : null}
                {isActive && rowMinutes != null ? (
                  <p className="m-0 text-sm text-text-muted tnum">{t('download.eta', { minutes: rowMinutes })}</p>
                ) : null}

                {p.status === 'failed' ? (
                  <>
                    {p.errorCode ? (
                      <p className="m-0 mt-2 text-sm" data-testid="download-error">
                        {t(`errors.${p.errorCode}.title`)}
                      </p>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-primary mt-2"
                      data-testid={isActive ? 'download-retry' : `download-retry-${p.tier}`}
                      onClick={() => onRetry(target)}
                    >
                      {p.errorCode && ERROR_ACTION[p.errorCode] !== 'none'
                        ? t(`errors.${p.errorCode}.action`)
                        : t('app.tryAgain')}
                    </button>
                  </>
                ) : (
                  <div className="mt-2 flex gap-2">
                    {p.status === 'paused' ? (
                      <button
                        type="button"
                        className="btn btn-outline"
                        data-testid={isActive ? 'download-resume' : `download-resume-${p.tier}`}
                        onClick={() => onResume(target)}
                      >
                        {t('download.resume')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-outline"
                        data-testid={isActive ? 'download-pause' : `download-pause-${p.tier}`}
                        onClick={() => onPause(target)}
                      >
                        {t('download.pause')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-quiet"
                      data-testid={isActive ? 'download-cancel' : `download-cancel-${p.tier}`}
                      onClick={() => onCancel(target)}
                    >
                      {t('download.cancel')}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
