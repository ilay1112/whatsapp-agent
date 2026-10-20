// src/renderer/src/store/calendarView.ts - [V4] T-908 group C (handover §2.4): the calendar view's data hooks.
//
// - `useVisibleCalendars(calendars)`: which calendars the week shows. Remembered per renderer in localStorage
//   `wca.calendar.visible` (a JSON array of calendar ids); absent / unreadable = every calendar (default all). Ids that are no
//   longer in the account are ignored. A renderer preference, never a setting.
// - `useCalendarView(anchorMs)`: the account's calendars (`google:listCalendars`, reloaded on `google:changed`) and the
//   visible week's events of the visible calendars (`calendar:listEvents`, cached in MAIN for <= 5 min). `refresh()` empties
//   main's cache (`calendar:invalidate`) and reads again. A late answer for an older week / selection is dropped.
//   [v4 review fix] `dashboard:changed` (pushed after Refresh, after every executed action and every undo door - main has
//   already emptied its calendar cache by then) re-reads the visible week quietly: no loading state, the old answer stays up
//   until the new one lands. Calendar hues are assigned when the calendar list arrives, never during render.
//
// Component-local state on purpose (no global store): nothing here outlives the calendar view, and decision 1 keeps other
// calendars' events in memory only.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CalendarInfo, EpochMs, ForeignEventView } from '@shared/types';
import type { ErrorCode } from '@shared/errors';
import { api, on } from '../api';
import { assignCalendarHues } from './calendarEntries';

export const VISIBLE_CALENDARS_KEY = 'wca.calendar.visible';
/** IPC cap of calendar:listEvents (1..10 ids); the picker's first ten checked calendars are read. */
export const MAX_VISIBLE_READ = 10;

/** The remembered selection, or null (= default all) when absent, unreadable or not an array of strings. */
export function readVisibleCalendars(): string[] | null {
  try {
    const raw = window.localStorage.getItem(VISIBLE_CALENDARS_KEY);
    if (raw === null) return null;
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
  } catch {
    return null;
  }
}

export function writeVisibleCalendars(ids: readonly string[]): void {
  try {
    window.localStorage.setItem(VISIBLE_CALENDARS_KEY, JSON.stringify([...ids]));
  } catch {
    // window memory still holds it for this run
  }
}

/** Visible ids among `calendars`: the stored selection filtered to calendars that still exist, or all of them. */
export function effectiveVisible(calendars: readonly CalendarInfo[], stored: readonly string[] | null): Set<string> {
  const ids = calendars.map((c) => c.id);
  if (stored === null) return new Set(ids);
  const keep = new Set(stored);
  return new Set(ids.filter((id) => keep.has(id)));
}

export function useVisibleCalendars(calendars: readonly CalendarInfo[]): {
  visible: ReadonlySet<string>;
  setVisible(next: ReadonlySet<string>): void;
} {
  const [stored, setStored] = useState<string[] | null>(() => readVisibleCalendars());
  const visible = useMemo(() => effectiveVisible(calendars, stored), [calendars, stored]);
  const setVisible = useCallback((next: ReadonlySet<string>): void => {
    const ids = [...next];
    writeVisibleCalendars(ids);
    setStored(ids);
  }, []);
  return { visible, setVisible };
}

export interface CalendarViewData {
  /** [] until loaded, and while Google is not connected (the picker and legend are then hidden). */
  calendars: CalendarInfo[];
  visible: ReadonlySet<string>;
  setVisible(next: ReadonlySet<string>): void;
  events: ForeignEventView[];
  /** Calendar ids that could not be read for this week (each named once by the view). */
  failed: string[];
  loading: boolean;
  /** Nothing could be read (CAL_UNAVAILABLE / CAL_RECONNECT ...); the health pill carries the action. */
  error: ErrorCode | null;
  /** calendar:invalidate, then read the week again. */
  refresh(): void;
}

/** One calendar:listEvents answer and the request it belongs to. */
interface WeekRead {
  reqKey: string;
  nonce: number;
  events: ForeignEventView[];
  failed: string[];
  error: ErrorCode | null;
}

export function useCalendarView(anchorMs: EpochMs): CalendarViewData {
  const [calendars, setCalendars] = useState<CalendarInfo[]>([]);
  const { visible, setVisible } = useVisibleCalendars(calendars);
  const [read, setRead] = useState<WeekRead | null>(null);
  const [nonce, setNonce] = useState(0);
  /** [v4 review fix] a quiet re-read (dashboard:changed): same week and selection, no loading state */
  const [tick, setTick] = useState(0);

  useEffect(() => on('dashboard:changed', () => setTick((n) => n + 1)), []);

  useEffect(() => {
    let live = true;
    let huesKey: string | null = null;
    const load = (): void => {
      void api.listCalendars().then(
        (r) => {
          if (!live) return;
          const next = r.ok ? r.value.calendars : [];
          // [v4 T7] distinct hues for the account's calendars, set before the blocks / swatches that read calendarHueOf
          // render; only when the calendar id set changed
          const key = next.map((c) => c.id).join('\n');
          if (key !== huesKey) {
            huesKey = key;
            assignCalendarHues(next.map((c) => c.id));
          }
          setCalendars(next);
        },
        () => undefined,
      );
    };
    load();
    const off = on('google:changed', load);
    return () => {
      live = false;
      off();
    };
  }, []);

  const ids = useMemo(
    () =>
      calendars
        .filter((c) => visible.has(c.id))
        .map((c) => c.id)
        .slice(0, MAX_VISIBLE_READ),
    [calendars, visible],
  );
  const idsKey = ids.join('\n');
  const reqKey = `${anchorMs}|${idsKey}`;

  useEffect(() => {
    if (idsKey === '') return;
    // `live` drops a late answer for an older week / selection / refresh (the cleanup runs before the next read).
    let live = true;
    const key = `${anchorMs}|${idsKey}`;
    void api.listCalendarEvents({ anchorMs: Math.max(0, Math.floor(anchorMs)), calendarIds: idsKey.split('\n') }).then(
      (r) => {
        if (!live) return;
        setRead(
          r.ok
            ? { reqKey: key, nonce, events: r.value.events, failed: r.value.failed, error: null }
            : { reqKey: key, nonce, events: [], failed: [], error: r.error.code },
        );
      },
      () => {
        if (live) setRead({ reqKey: key, nonce, events: [], failed: [], error: 'CAL_UNAVAILABLE' });
      },
    );
    return () => {
      live = false;
    };
  }, [anchorMs, idsKey, nonce, tick]);

  const refresh = useCallback((): void => {
    void api.invalidateCalendarEvents().finally(() => setNonce((n) => n + 1));
  }, []);

  // Only an answer for THIS week + selection is shown; during a refresh the previous answer of the same week stays up.
  const current = idsKey !== '' && read !== null && read.reqKey === reqKey ? read : null;
  return {
    calendars,
    visible,
    setVisible,
    events: current?.events ?? [],
    failed: current?.failed ?? [],
    loading: idsKey !== '' && (current === null || current.nonce !== nonce),
    error: current?.error ?? null,
    refresh,
  };
}
