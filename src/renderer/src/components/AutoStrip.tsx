// src/renderer/src/components/AutoStrip.tsx - "Done automatically - last 7 days" (UX2 3.1, 11.1, 13; B11 door 2;
// owner V2-W1-11-renderer-dashboard).
//
// NOT a fourth list (C9): no counts in the list headers, no cards, no approvals. It leaves the DOM entirely when no row
// qualifies (undo available, or written in the last 24 h). Titles are UNTRUSTED (rendered from the proposal at render
// time by main, B11) and sit in `dir="auto"` text slots; every other word is app text.
// Undo is approval-class: one `auto:undo` per activation, the focus-steal guard read at click time, never from an effect.
// Pause is the fail-safe direction: no dialog, no guard (UX2 11.5).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AutoState, AutoWriteView, ItemId } from '@shared/types';
import { formatRelativeAge, formatTimeRange, makeFormatters } from '@shared/i18n/format';
import { localToEpochMs } from '@shared/when';
import { stripRows, useAutoStore } from '../store/auto';
import { useDashboardStore } from '../store/dashboard';
import { SENTINEL, renderBdiTemplate } from './ItemCard.bdi';
import { formatWhen, startMsOf } from './ChangeLine.format';
import { UndoIcon, activationRefused, refuseBlockedKey } from './UndoControl';

export interface AutoStripProps {
  rows: AutoWriteView[];
  policyState: AutoState['policy'];
  onUndo(autoWriteId: string): void;
  onShow(itemId: ItemId): void;
  onPause(): void;
}

/** UX2 3.1: at most five rows; "Show all in Automatic activity" below when more exist. */
export const STRIP_MAX_ROWS = 5;

/** The verb phrase by `auto_writes.kind` (UX2 3.1): added / moved from {{when}} / place changed / cancelled. */
function verbOf(row: AutoWriteView, lang: 'he' | 'en', t: (k: string, o?: Record<string, unknown>) => string) {
  if (row.kind === 'create') return t('auto.verb.added');
  if (row.kind === 'cancel') return t('auto.verb.cancelled');
  const before = row.before;
  if (before && before.startLocal === row.event.startLocal && before.endLocal === row.event.endLocal)
    return t('auto.verb.placeChanged');
  if (!before) return t('auto.verb.placeChanged');
  return renderBdiTemplate(t('auto.verb.movedFrom', { when: SENTINEL(0) }), [
    formatWhen(startMsOf(before), lang, before.timeZone),
  ]);
}

function MiniDateTab({ row, lang }: { row: AutoWriteView; lang: 'he' | 'en' }) {
  const e = row.event;
  const parts = makeFormatters(lang, e.timeZone).dayShort.formatToParts(
    new Date(localToEpochMs(e.startLocal, e.timeZone)),
  );
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return (
    <span
      className="flex w-10 shrink-0 flex-col items-center overflow-hidden rounded-xs border border-line-strong"
      aria-hidden="true"
    >
      <span
        className={`w-full text-center text-xs font-semibold ${e.status === 'cancelled' ? 'bg-line-strong' : 'bg-ok'} text-surface`}
      >
        {part('weekday')}
      </span>
      <span className="tnum text-sm font-semibold">{part('day')}</span>
    </span>
  );
}

function Spinner() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="wca-spin shrink-0">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function AutoStrip({ rows, policyState, onUndo, onShow, onPause }: AutoStripProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'he' ? 'he' : 'en';
  const undoing = useAutoStore((s) => s.undoing);
  const failed = useAutoStore((s) => s.failed);
  const fetchedAt = useAutoStore((s) => s.fetchedAt);
  const requestNavigation = useDashboardStore((s) => s.requestNavigation);
  const [mountedAt] = useState(() => Date.now());
  const now = Math.max(fetchedAt, mountedAt);
  // Renderer memory only (UX2 3.1): null = follow the default (open while any row can still be undone).
  const [userOpen, setUserOpen] = useState<boolean | null>(null);

  const shown = stripRows(rows, now);
  if (shown.length === 0) return null; // the strip leaves the DOM entirely when idle

  // A failed undo still offers "Try again", so it keeps the strip open like an available one.
  const anyUndoable = shown.some((r) => r.undoState === 'available' || r.undoState === 'failed');
  const open = userOpen ?? anyUndoable;
  const visible = shown.slice(0, STRIP_MAX_ROWS);

  return (
    <section
      aria-labelledby="autostrip-title"
      data-testid="autostrip"
      data-open={open ? 'true' : 'false'}
      data-state={policyState?.state ?? 'none'}
      className="autostrip rounded-md border border-line bg-surface"
    >
      <div className="flex min-h-9 flex-wrap items-center gap-2 px-3 py-1">
        <span className="icon icon-auto text-accent" aria-hidden="true" />
        <h2 id="autostrip-title" className="m-0 grow text-sm font-semibold">
          {t('auto.strip.title', { count: shown.length })}
        </h2>
        {policyState?.state === 'on' ? (
          <button type="button" className="btn btn-quiet" data-testid="autostrip-pause" onClick={onPause}>
            {t('auto.pause')}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-quiet"
          data-testid="autostrip-toggle"
          aria-expanded={open}
          aria-controls="autostrip-rows"
          onClick={() => setUserOpen(!open)}
        >
          {open ? t('auto.strip.hide') : t('auto.strip.show')}
        </button>
      </div>

      {open ? (
        <div id="autostrip-rows" className="border-t border-line px-3 py-2">
          <div role="list" className="flex flex-col gap-2">
            {visible.map((row) => {
              const inFlight = undoing.has(row.autoWriteId);
              const clickFailed = failed.has(row.autoWriteId);
              const state = inFlight
                ? 'undoing'
                : clickFailed && row.undoState === 'available'
                  ? 'failed'
                  : row.undoState;
              const e = row.event;
              const range = formatTimeRange(
                localToEpochMs(e.startLocal, e.timeZone),
                localToEpochMs(e.endLocal, e.timeZone),
                lang,
                e.timeZone,
              );
              const show = (
                <button
                  type="button"
                  className="btn btn-quiet"
                  data-testid={`autostrip-show-${row.autoWriteId}`}
                  disabled={inFlight}
                  onClick={() => onShow(row.itemId)}
                >
                  {t('card.show')}
                </button>
              );
              const undo = (label: string) => (
                <button
                  type="button"
                  className="btn btn-outline min-h-8 min-w-8"
                  data-testid={`autostrip-undo-${row.autoWriteId}`}
                  onClick={(ev) => {
                    if (activationRefused(ev)) return;
                    onUndo(row.autoWriteId);
                  }}
                  onKeyDown={refuseBlockedKey}
                >
                  <UndoIcon />
                  {label}
                </button>
              );
              let side: React.ReactNode;
              switch (state) {
                case 'undoing':
                  side = (
                    <>
                      <span className="flex items-center gap-1 text-sm text-text-muted" role="status">
                        <Spinner />
                        {t('undo.undoing')}
                      </span>
                      <button type="button" className="btn btn-outline" disabled>
                        <UndoIcon />
                        {t('undo.button')}
                      </button>
                    </>
                  );
                  break;
                case 'available':
                  side = undo(t('undo.button'));
                  break;
                case 'undone':
                  side = <span className="chip chip-ok">{t('undo.undone')}</span>;
                  break;
                case 'expired':
                  side = <span className="text-xs text-text-muted">{t('undo.expired')}</span>;
                  break;
                case 'blocked_changed':
                  side = <span className="note-amber text-sm">{t('undo.blockedChangedShort')}</span>;
                  break;
                case 'blocked_started':
                  side = <span className="note-amber text-sm">{t('undo.blockedStartedShort')}</span>;
                  break;
                default:
                  side = (
                    <>
                      <span className="text-sm text-danger">{t('undo.failed')}</span>
                      {undo(t('app.tryAgain'))}
                    </>
                  );
              }
              return (
                <div
                  role="listitem"
                  key={row.autoWriteId}
                  data-testid={`autostrip-row-${row.autoWriteId}`}
                  className="autostrip-row flex flex-wrap items-center gap-2"
                >
                  <MiniDateTab row={row} lang={lang} />
                  <span className="flex min-w-0 grow flex-col">
                    <span
                      className={`msg-text truncate font-semibold${e.status === 'cancelled' ? ' event-cancelled' : ''}`}
                      dir="auto"
                      data-testid={`autostrip-title-${row.autoWriteId}`}
                    >
                      {e.title}
                    </span>
                    <bdi className="tnum text-xs text-text-muted">{range}</bdi>
                  </span>
                  <span className="text-sm text-text-muted" data-testid={`autostrip-verb-${row.autoWriteId}`}>
                    {verbOf(row, lang, t)} · {formatRelativeAge(row.writtenAt, now, lang)}
                  </span>
                  <span
                    className="autostrip-actions flex flex-wrap items-center gap-2"
                    data-testid={`autostrip-state-${row.autoWriteId}`}
                    data-state={state}
                  >
                    {side}
                    {show}
                  </span>
                </div>
              );
            })}
          </div>
          {shown.length > STRIP_MAX_ROWS ? (
            <button
              type="button"
              className="btn btn-quiet mt-1"
              data-testid="autostrip-more"
              onClick={() => requestNavigation({ view: 'activity' })}
            >
              {t('auto.strip.more')}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
