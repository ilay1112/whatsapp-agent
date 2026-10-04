// src/renderer/src/views/AutoActivity.tsx - the Automatic activity page (UX2 4.6; B11 door 4; owner V2-W1-12).
//
// Reached from Settings > Automatic mode ("See automatic activity"). Per-day groups of `auto:listWrites {sinceTs}`, newest
// first, 30 days per page with "Show older". Rules:
//   - event titles are UNTRUSTED (they come from proposals at render time, B11): they are rendered only inside a row's
//     `<bdi dir="auto">` slot - never in a heading, never in an attribute, never in a live region;
//   - Undo is the shared `UndoControl` (door 'activity'): one `auto:undo` per click, focus-steal guarded, never from an
//     effect;
//   - Pause is one click (fail-safe direction); nothing on this page can turn automatic mode on;
//   - "Export (JSON)" = `auto:export` (main opens the save dialog and writes metadata only - no titles, names or text).
// `auto:listWrites` carries writes only: shadow / fallback decisions have no read channel (see the notes file), so every
// row here is `data-kind="write"`.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AutoWriteView, UndoView } from '@shared/types';
import { localToEpochMs } from '@shared/when';
import { formatDate, formatTime, formatTimeRange, formatWeekdayTime, makeFormatters } from '@shared/i18n/format';
import { api } from '../api';
import { useAutoStore } from '../store/auto';
import { useDashboardStore } from '../store/dashboard';
import { useSettingsStore } from '../store/settings';
import { UndoControl } from '../components/UndoControl';

export interface AutoActivityProps {
  onBack(): void;
}

const MS_DAY = 86_400_000;
/** One page = 30 days (UX2 4.6). */
export const ACTIVITY_PAGE_DAYS = 30;

/** 'YYYY-MM-DD' of an instant in the given zone (the day-group key and test id). */
export function dayKeyOf(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ms))
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Newest first, grouped by local day. */
export function groupByDay(rows: readonly AutoWriteView[], timeZone: string): { day: string; rows: AutoWriteView[] }[] {
  const sorted = [...rows].sort((a, b) => b.writtenAt - a.writtenAt);
  const groups: { day: string; rows: AutoWriteView[] }[] = [];
  for (const row of sorted) {
    const day = dayKeyOf(row.writtenAt, timeZone);
    const last = groups.at(-1);
    if (last && last.day === day) last.rows.push(row);
    else groups.push({ day, rows: [row] });
  }
  return groups;
}

/** The UndoView of one write row (the activity door). */
export function undoViewOf(row: AutoWriteView): UndoView {
  return { revisionId: row.revisionId ?? 0, until: row.undoUntil, state: row.undoState, automatic: true };
}

function epochOf(local: string, timeZone: string): number | null {
  if (local === '' || timeZone === '') return null;
  try {
    return localToEpochMs(local, timeZone);
  } catch {
    return null;
  }
}

export function AutoActivity({ onBack }: AutoActivityProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'he' ? 'he' : 'en';
  const settings = useSettingsStore((s) => s.settings);
  const autoState = useAutoStore((s) => s.state);
  const timeZone = settings?.general.timeZone ?? 'Asia/Jerusalem';

  const [now] = useState(() => Date.now());
  const [pages, setPages] = useState(1);
  const [rows, setRows] = useState<AutoWriteView[] | null>(null);
  const [exported, setExported] = useState<boolean | null>(null);

  const load = useCallback(async (pageCount: number) => {
    const r = await api.listAutoWrites(Date.now() - pageCount * ACTIVITY_PAGE_DAYS * MS_DAY);
    setRows(r.ok ? r.value.writes : []);
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => load(pages));
  }, [load, pages]);

  // The store's `auto:changed` subscription (App) refreshes the state; re-read the rows when it changes.
  useEffect(() => {
    if (!autoState) return;
    void Promise.resolve().then(() => load(pages));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `pages` changes are handled by the effect above
  }, [autoState, load]);

  const groups = useMemo(() => groupByDay(rows ?? [], timeZone), [rows, timeZone]);
  const todayKey = dayKeyOf(now, timeZone);
  const yesterdayKey = dayKeyOf(now - MS_DAY, timeZone);

  const dayTitle = (day: string, sample: number) =>
    day === todayKey
      ? t('activity.today')
      : day === yesterdayKey
        ? t('activity.yesterday')
        : formatDate(sample, lang, timeZone);

  const verbOf = (row: AutoWriteView): string => {
    if (row.kind === 'create') return t('auto.verb.added');
    if (row.kind === 'cancel') return t('auto.verb.cancelled');
    const before = row.before ? epochOf(row.before.startLocal, row.before.timeZone) : null;
    return before !== null
      ? t('auto.verb.movedFromPlain', { when: formatWeekdayTime(before, lang, row.before?.timeZone ?? timeZone) })
      : t('auto.verb.placeChanged');
  };

  const policy = autoState?.policy ?? null;
  const exportJson = async () => {
    const r = await api.exportAuto();
    setExported(r.ok ? r.value.saved : false);
  };

  return (
    <main data-testid="auto-activity" className="flex min-h-full flex-col gap-3 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-quiet" data-testid="auto-activity-back" onClick={onBack}>
          <span className="icon-dir inline-block" aria-hidden="true">
            ‹
          </span>
          {t('activity.back')}
        </button>
        <h1 className="m-0 grow text-xl">{t('activity.title')}</h1>
        <button
          type="button"
          className="btn btn-outline"
          data-testid="activity-export"
          onClick={() => void exportJson()}
        >
          {t('activity.export')}
        </button>
      </div>
      <p className="m-0 text-sm text-text-muted">{t('activity.exportNote')}</p>
      {exported ? (
        <p role="status" className="m-0 chip chip-ok self-start" data-testid="activity-exported">
          {t('activity.exported')}
        </p>
      ) : null}

      {policy && (policy.state === 'on' || policy.state === 'shadow' || policy.state === 'paused') ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="activity-state" data-state={policy.state}>
          <span className="grow">
            {policy.state === 'on'
              ? t('activity.stateOn', {
                  used: autoState?.usedToday.writes ?? 0,
                  limit: autoState?.usedToday.limit ?? 0,
                  count: Math.max(0, Math.ceil((policy.expiresAt - now) / MS_DAY)),
                })
              : t(`auto.stateWord.${policy.state}`)}
          </span>
          {policy.state === 'on' ? (
            <button
              type="button"
              className="btn btn-outline"
              data-testid="activity-pause"
              onClick={() => void useAutoStore.getState().pause()}
            >
              {t('auto.pause')}
            </button>
          ) : null}
        </div>
      ) : null}

      {rows !== null && groups.length === 0 ? (
        <p className="m-0 text-text-muted" data-testid="activity-empty">
          {t('activity.empty')}
        </p>
      ) : null}

      {groups.map((group) => (
        <section
          key={group.day}
          data-testid={`activity-day-${group.day}`}
          aria-labelledby={`activity-h-${group.day}`}
          className="flex flex-col gap-2"
        >
          <h2 id={`activity-h-${group.day}`} className="m-0 text-md font-semibold">
            {dayTitle(group.day, group.rows[0]!.writtenAt)}
          </h2>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {group.rows.map((row) => {
              const start = epochOf(row.event.startLocal, row.event.timeZone);
              const end = epochOf(row.event.endLocal, row.event.timeZone);
              const zone = row.event.timeZone || timeZone;
              return (
                <li
                  key={row.autoWriteId}
                  data-testid={`activity-row-${row.autoWriteId}`}
                  data-kind="write"
                  data-write-kind={row.kind}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface p-2"
                >
                  <span className="flex min-w-0 grow basis-60 flex-col">
                    <bdi
                      dir="auto"
                      className={`msg-text font-semibold${row.kind === 'cancel' ? ' event-cancelled' : ''}`}
                    >
                      {row.event.title}
                    </bdi>
                    <span className="text-sm text-text-muted">
                      {start !== null ? (
                        <bdi className="tnum">
                          {end !== null
                            ? `${makeFormatters(lang, zone).dayShort.format(new Date(start))} ${formatTimeRange(start, end, lang, zone)}`
                            : formatWeekdayTime(start, lang, zone)}
                        </bdi>
                      ) : null}
                      {' · '}
                      {verbOf(row)}
                      {' · '}
                      <bdi className="tnum">{formatTime(row.writtenAt, lang, timeZone)}</bdi>
                    </span>
                  </span>
                  <span className="chip chip-info">
                    <span className="icon icon-auto" aria-hidden="true" />
                    {t('label.badge.automatic')}
                  </span>
                  <UndoControl
                    undo={undoViewOf(row)}
                    itemId={row.itemId}
                    door="activity"
                    onUndo={() => api.undoAuto(row.autoWriteId)}
                  />
                  {/* ux-i18n-v2-10 (UX2 4.6 "[Undo] [Show]"): back to the dashboard with the item behind the write open. */}
                  <button
                    type="button"
                    className="btn btn-quiet"
                    data-testid={`activity-show-${row.autoWriteId}`}
                    onClick={() =>
                      useDashboardStore.getState().requestNavigation({ view: 'dashboard', itemId: row.itemId })
                    }
                  >
                    {t('card.show')}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {rows !== null && rows.length > 0 ? (
        <button
          type="button"
          className="btn btn-quiet self-start"
          data-testid="activity-older"
          onClick={() => setPages((p) => p + 1)}
        >
          {t('activity.older')}
        </button>
      ) : null}
      <p className="m-0 text-sm text-text-muted">{t('activity.retention')}</p>
    </main>
  );
}
